'use strict';
/**
 * T1.7 import domain (revision-01): raw supplier-material intake with REAL byte parsing,
 * field-level candidates carrying honest provenance (raw hash + page/line or sheet/row/column +
 * verified snippet + parser/method), explicit user confirmation into the approved T1.3
 * Evidence/Observation model and versioned corrections. Fixture/engineering only — no real
 * outbound calls, no fees, no credential values; OCR is default-closed and only runs through an
 * injected fixture transport.
 *
 * Frozen contract (rev-01):
 * - Idempotency domain = (project, supplier, parserVersion, rawHash): replay of an IMPORT returns
 *   the original document and never grows records. Document existence only ever marks a COMPLETED
 *   atomic publish — an interrupted scan import persists nothing and can be retried.
 * - Currency/config identity: contradictory explicit currency cues ($ vs CNY) stay conflicting
 *   (never silently chosen); configuration text binds quote subjects (SOL-03|red vs SOL-03|blue)
 *   across line/table/manual/scan paths; repeated mapped columns are never discarded.
 * - Confirmation/correction are single transactions (evidence internals are reused read-only via a
 *   pass-through tx shim): invalid inputs are validated BEFORE any write, mid-operation database
 *   failures roll the whole item back, and invalid actions leave every table/old status unchanged.
 * - Every accepted correction publishes a FRESH version identity (predecessor is part of the
 *   identity), recomputes unresolved blockers from the new fields (never erases them, never
 *   blind-carries resolved ones, real conflicts are not dodged by editing the number), and keeps
 *   the original raw hash/snippet/observation untouched. Confirmed corrections must be complete.
 * - Scan imports persist explicit per-image coverage {imagesFound, imagesProcessed, maxPages,
 *   truncated}; `maxPages` bounds IMAGES PER CALL; a larger follow-up call resumes the unprocessed
 *   images; a bounded call never claims a complete dedup. Pending/invalid/unknown pages keep the
 *   structured operation/attempt identity and the EXACT opaque remote reference (no trim/hash/
 *   guess, no blind auto-resubmit).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const evidence = require('./evidence.js');
const { requireInstant } = require('./providers/cost.js');
const extractPdf = require('./imports/extract-pdf.js');
const extractTable = require('./imports/extract-table.js');
const extractScan = require('./imports/extract-scan.js');
const fields = require('./imports/fields.js');

const { ValidationError, NotFoundError, ConflictError } = evidence;

const MANUAL_PARSER_VERSION = 'imports/manual-entry@v1';
const FIELD_KEYS = ['model', 'purchase_cost', 'quantity', 'currency', 'unit', 'incoterm', 'variant_text'];
const CONFIRM_BLOCKERS = new Set([
  'conflict', 'missing_unit', 'missing_currency', 'currency_ambiguous_yuan_yen', 'missing_incoterm',
  'unrecognized_currency', 'unrecognized_incoterm', 'currency_conflict', 'unit_conflict', 'incoterm_conflict',
  'unparsed_amount', 'variant_unknown'
]);
const STRICT_DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const SUPPORTED_FORMATS = [
  { format: 'pdf_text', how: 'lib/pdf-catalog analyzePdf read-only cross-check + page-tree-walked content streams', status: 'supported' },
  { format: 'scan_pdf', how: 'PDF image XObjects (DCTDecode -> real JPEG bytes; FlateDecode 8bpc DeviceGray/RGB -> real PNG); OCR only via injected fixture transport', status: 'supported_fixture_only' },
  { format: 'image/png', how: 'standalone PNG bytes', status: 'supported' },
  { format: 'image/jpeg', how: 'standalone JPEG bytes', status: 'supported' },
  { format: 'csv', how: 'RFC-style local parser + generic header vocabulary', status: 'supported' },
  { format: 'xlsx', how: 'approved ExcelJS 4.4.0 (already installed)', status: 'supported' }
];
const UNSUPPORTED = [
  { item: 'Docling / PaddleOCR install', status: 'not_approved_to_install (T0.2 candidates)' },
  { item: 'real OCR / paid vision calls', status: 'blocked_by_policy (fixture only; default closed)' },
  { item: 'JPXDecode / JBIG2Decode / CCITTFaxDecode images', status: 'unsupported (explicit per-image status)' },
  { item: 'PDF page rasterization', status: 'unsupported (no renderer; embedded images only)' },
  { item: 'encrypted PDFs, DOC/DOCX/PPTX', status: 'unsupported' }
];

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
  return value.trim();
}
function requireReadableFile(filePath) {
  const resolved = requireString(filePath, 'filePath');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new ValidationError(`filePath is not a readable file: ${resolved}`);
  return resolved;
}

/**
 * Pass-through transaction shim: the approved evidence module's internal BEGIN/COMMIT/ROLLBACK
 * calls are suppressed so its functions run INSIDE the caller's transaction (implementation is
 * never modified). Rollback of the outer transaction undoes every nested write.
 */
function txShim(db) {
  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => {
      const head = String(sql).trim().slice(0, 12).toUpperCase();
      if (head.startsWith('BEGIN') || head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) return;
      db.exec(sql);
    }
  };
}
function withOperationTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

const INSERT_DOCUMENT_SQL = `INSERT INTO import_documents (document_id, project_id, supplier_key, parser_version, raw_sha256, file_ref, byte_size, format, localization, evidence_id, status, created_at)
  VALUES (@document_id, @project_id, @supplier_key, @parser_version, @raw_sha256, @file_ref, @byte_size, @format, @localization, @evidence_id, @status, @created_at)`;

const INSERT_CANDIDATE_SQL = `INSERT OR IGNORE INTO import_candidates (candidate_id, project_id, document_id, supplier_key, parser_version, candidate_key, field_key, raw_value, numeric_value, currency, unit, incoterm, status, reasons, subject_key, origin_hint, snippet, page_number, physical_index, sheet, row_number, column_ref, method, observation_id, supersedes_candidate_id, line_index, image_object, image_sha256, region_json, created_at, updated_at)
  VALUES (@candidate_id, @project_id, @document_id, @supplier_key, @parser_version, @candidate_key, @field_key, @raw_value, @numeric_value, @currency, @unit, @incoterm, @status, @reasons, @subject_key, @origin_hint, @snippet, @page_number, @physical_index, @sheet, @row_number, @column_ref, @method, @observation_id, @supersedes_candidate_id, @line_index, @image_object, @image_sha256, @region_json, @created_at, @updated_at)`;

const INSERT_SCAN_PAGE_SQL = `INSERT OR IGNORE INTO import_scan_pages (page_result_id, project_id, document_id, image_index, page_number, physical_index, image_object, image_sha256, remote_id, operation_id, attempt_token, status, reason, created_at)
  VALUES (@page_result_id, @project_id, @document_id, @image_index, @page_number, @physical_index, @image_object, @image_sha256, @remote_id, @operation_id, @attempt_token, @status, @reason, @created_at)`;

/** Byte-magic format detection (never by extension guessing alone). */
function detectFormat(filePath) {
  const resolved = requireReadableFile(filePath);
  const fd = fs.openSync(resolved, 'r');
  const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) return 'xlsx';
  const image = extractScan.detectImageFormat(head);
  if (image) return `image_${image}`;
  const sample = fs.readFileSync(resolved).subarray(0, 65536);
  let textLike = true;
  for (const byte of sample) if (byte === 0) { textLike = false; break; }
  if (textLike && (sample.includes(0x2c) || sample.includes(0x3b) || sample.includes(0x09))) return 'csv';
  return 'unknown';
}

function parseCoverage(documentRow) {
  if (!documentRow || !documentRow.coverage_json) return null;
  try { return JSON.parse(documentRow.coverage_json); } catch { return null; }
}
function decorateDocument(documentRow) {
  if (!documentRow) return documentRow;
  return { ...documentRow, coverage: parseCoverage(documentRow) };
}

function getDocumentByHash(db, projectId, { supplierKey, parserVersion, rawSha256 }) {
  const project = requireString(projectId, 'projectId');
  return db.prepare('SELECT * FROM import_documents WHERE project_id = ? AND supplier_key = ? AND parser_version = ? AND raw_sha256 = ?')
    .get(project, requireString(supplierKey, 'supplierKey'), requireString(parserVersion, 'parserVersion'), requireString(rawSha256, 'rawSha256')) ?? null;
}

function getDocument(db, projectId, documentId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(documentId, 'documentId');
  return db.prepare('SELECT * FROM import_documents WHERE project_id = ? AND document_id = ?').get(project, id) ?? null;
}

function listDocuments(db, projectId) {
  const project = requireString(projectId, 'projectId');
  return db.prepare('SELECT * FROM import_documents WHERE project_id = ? ORDER BY created_at, document_id').all(project);
}

function getCandidate(db, projectId, candidateId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(candidateId, 'candidateId');
  return db.prepare('SELECT * FROM import_candidates WHERE project_id = ? AND candidate_id = ?').get(project, id) ?? null;
}

function listCandidates(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const clauses = ['project_id = ?'];
  const params = [project];
  if (options.documentId) { clauses.push('document_id = ?'); params.push(requireString(options.documentId, 'documentId')); }
  if (options.supplierKey) { clauses.push('supplier_key = ?'); params.push(requireString(options.supplierKey, 'supplierKey')); }
  if (options.status) { clauses.push('status = ?'); params.push(requireString(options.status, 'status')); }
  return db.prepare(`SELECT * FROM import_candidates WHERE ${clauses.join(' AND ')} ORDER BY created_at, candidate_id`).all(...params);
}

function listScanPages(db, projectId, documentId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(documentId, 'documentId');
  return db.prepare('SELECT * FROM import_scan_pages WHERE project_id = ? AND document_id = ? ORDER BY image_index, page_result_id').all(project, id);
}

function listCorrections(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  if (options.documentId) {
    return db.prepare('SELECT * FROM import_corrections WHERE project_id = ? AND document_id = ? ORDER BY created_at, correction_id')
      .all(project, requireString(options.documentId, 'documentId'));
  }
  return db.prepare('SELECT * FROM import_corrections WHERE project_id = ? ORDER BY created_at, correction_id').all(project);
}

function ensureDocument(db, params) {
  const existing = getDocumentByHash(db, params.projectId, params);
  if (existing) return { document: existing, deduplicated: true };
  const row = {
    document_id: newId('impdoc'),
    project_id: params.projectId,
    supplier_key: params.supplierKey,
    parser_version: params.parserVersion,
    raw_sha256: params.rawSha256,
    file_ref: params.fileRef,
    byte_size: params.byteSize,
    format: params.format,
    localization: params.localization,
    evidence_id: params.evidenceId ?? null,
    status: 'parsed',
    created_at: nowIso()
  };
  db.prepare(INSERT_DOCUMENT_SQL).run(row);
  return { document: getDocument(db, params.projectId, row.document_id), deduplicated: false };
}

function candidateKeyOf(candidate) {
  return sha256Hex(JSON.stringify([
    candidate.fieldKey, candidate.rawValue ?? null, candidate.numericValue ?? null, candidate.currency ?? null,
    candidate.unit ?? null, candidate.incoterm ?? null, candidate.pageNumber ?? null, candidate.physicalIndex ?? null,
    candidate.sheet ?? null, candidate.rowNumber ?? null, candidate.columnRef ?? null, candidate.lineIndex ?? null,
    candidate.method, candidate.supersedesCandidateId ?? null,
    candidate.subjectKey ?? null,
    candidate.imageObject ?? null, candidate.imageSha256 ?? null
  ]));
}

function insertCandidate(db, projectId, document, candidate) {
  const candidateKey = candidateKeyOf(candidate);
  const row = {
    candidate_id: newId('impcand'),
    project_id: projectId,
    document_id: document.document_id,
    supplier_key: document.supplier_key,
    parser_version: document.parser_version,
    candidate_key: candidateKey,
    field_key: candidate.fieldKey,
    raw_value: candidate.rawValue ?? null,
    numeric_value: candidate.numericValue ?? null,
    currency: candidate.currency ?? null,
    unit: candidate.unit ?? null,
    incoterm: candidate.incoterm ?? null,
    status: 'candidate',
    reasons: Array.isArray(candidate.reasons) && candidate.reasons.length > 0 ? candidate.reasons.join(';') : null,
    subject_key: candidate.subjectKey ?? `unresolved:${document.document_id}:${candidate.physicalIndex ?? candidate.rowNumber ?? 'x'}`,
    origin_hint: candidate.originHint ?? 'seller_statement',
    snippet: candidate.snippet,
    page_number: candidate.pageNumber ?? null,
    physical_index: candidate.physicalIndex ?? null,
    sheet: candidate.sheet ?? null,
    row_number: candidate.rowNumber ?? null,
    column_ref: candidate.columnRef ?? null,
    method: candidate.method,
    observation_id: null,
    supersedes_candidate_id: candidate.supersedesCandidateId ?? null,
    line_index: candidate.lineIndex ?? null,
    image_object: candidate.imageObject === undefined || candidate.imageObject === null ? null : String(candidate.imageObject),
    image_sha256: candidate.imageSha256 ?? null,
    region_json: candidate.regionJson ?? null,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  const result = db.prepare(INSERT_CANDIDATE_SQL).run(row);
  if (result.changes === 1) return { row: getCandidate(db, projectId, row.candidate_id), inserted: true };
  const existing = db.prepare('SELECT * FROM import_candidates WHERE project_id = ? AND document_id = ? AND candidate_key = ?')
    .get(projectId, document.document_id, candidateKey);
  return { row: existing, inserted: false };
}

/** Never auto-merge: same subject + numeric field with >1 distinct signature gains `conflict`. */
function applyConflictReasons(db, projectId, documentId) {
  const rows = db.prepare("SELECT * FROM import_candidates WHERE project_id = ? AND document_id = ? AND status = 'candidate' AND field_key IN ('purchase_cost', 'quantity')")
    .all(projectId, documentId);
  const conflicted = fields.conflictGroups(rows.map((row) => ({
    candidate_id: row.candidate_id,
    fieldKey: row.field_key,
    subjectKey: row.subject_key,
    numericValue: row.numeric_value,
    unit: row.unit,
    currency: row.currency,
    incoterm: row.incoterm
  })));
  for (const item of conflicted) {
    const current = db.prepare('SELECT reasons FROM import_candidates WHERE project_id = ? AND candidate_id = ?').get(projectId, item.candidate_id);
    const list = current.reasons ? current.reasons.split(';') : [];
    if (!list.includes('conflict')) {
      list.push('conflict');
      db.prepare('UPDATE import_candidates SET reasons = ?, updated_at = ? WHERE project_id = ? AND candidate_id = ?')
        .run(list.join(';'), nowIso(), projectId, item.candidate_id);
    }
  }
  return conflicted.map((item) => item.candidate_id);
}

/** Unresolved conditions recomputed from the CURRENT fields, unioned with stored reasons. */
function candidateBlockers(candidate) {
  const blockers = new Set(candidate.reasons ? candidate.reasons.split(';') : []);
  // independent structural checks — these never rely on the (erasable) stored reasons:
  // an explicitly unknown dimension in the subject stays unknown until the dimension itself is resolved
  if (typeof candidate.subject_key === 'string' && /=\?(?:\||$)/.test(candidate.subject_key)) blockers.add('variant_unknown');
  const numericField = ['purchase_cost', 'quantity'].includes(candidate.field_key);
  if (numericField) {
    const finite = typeof candidate.numeric_value === 'number' && Number.isFinite(candidate.numeric_value);
    if (!finite) blockers.add('unparsed_amount');
    if (!candidate.unit || String(candidate.unit).trim() === '') blockers.add('missing_unit');
    if (candidate.field_key === 'purchase_cost') {
      if (!candidate.currency) blockers.add(/[¥￥]/.test(String(candidate.raw_value ?? '')) ? 'currency_ambiguous_yuan_yen' : 'missing_currency');
      else if (!['USD', 'CNY', 'EUR'].includes(candidate.currency)) blockers.add('unrecognized_currency');
      if (!candidate.incoterm) blockers.add('missing_incoterm');
      else if (!fields.INCOTERMS.includes(candidate.incoterm)) blockers.add('unrecognized_incoterm');
    }
  } else if (candidate.field_key === 'currency') {
    // field-specific semantics: the RAW value is authoritative and must agree with the normalized
    // currency; a recognized normalized code alone can never legalize a raw value
    const rawText = String(candidate.raw_value ?? '');
    const rawResolved = fields.resolveCurrency((rawText.match(/[¥￥$€]/) || [])[0] ?? null, rawText);
    if (rawResolved.currency && candidate.currency && rawResolved.currency !== candidate.currency) blockers.add('currency_conflict');
    if (!rawResolved.currency && rawResolved.reason) blockers.add(rawResolved.reason === 'missing_currency' ? 'unrecognized_currency' : rawResolved.reason);
    if (!candidate.currency || !['USD', 'CNY', 'EUR'].includes(candidate.currency)) blockers.add('unrecognized_currency');
  } else if (candidate.field_key === 'unit') {
    if (!candidate.unit || String(candidate.unit).trim() === '') blockers.add('missing_unit');
  } else if (candidate.field_key === 'incoterm') {
    if (!candidate.incoterm || !fields.INCOTERMS.includes(candidate.incoterm)) blockers.add('unrecognized_incoterm');
  }
  return [...blockers];
}

function summarizeExtraction(extraction) {
  return {
    rawSha256: extraction.rawSha256,
    byteSize: extraction.byteSize,
    format: extraction.format,
    parserVersion: extraction.parserVersion,
    pageCount: extraction.pageCount ?? null,
    textMode: extraction.textMode ?? null,
    localization: extraction.localization ?? extraction.pageTree ?? null,
    // bounded per-page previews of the ACTUAL extracted segments (full text stays in the adapter)
    pages: Array.isArray(extraction.pages) ? extraction.pages.map((page) => ({
      pageNumber: page.pageNumber,
      physicalIndex: page.physicalIndex,
      objectNumber: page.objectNumber,
      charCount: page.text.length,
      truncatedAtCap: page.truncatedAtCap,
      textPreview: page.text.slice(0, 1000)
    })) : null,
    crossCheck: extraction.crossCheck ?? null,
    notes: extraction.notes ?? null,
    warnings: extraction.warnings ?? null
  };
}

function importEvidenceForFile(db, projectId, filePath, observedAt) {
  return evidence.importEvidenceFromFile(db, projectId, {
    filePath,
    sourceType: 'manual_upload',
    importBasis: 'supplier_material',
    observedAt
  });
}

/** Text-PDF import: real bytes -> located candidates -> persisted rows (idempotent per domain). */
function importPdfText(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const filePath = requireReadableFile(options.filePath);
  const supplierKey = requireString(options.supplierKey, 'supplierKey');
  const parserVersion = options.parserVersion ?? extractPdf.PARSER_VERSION;
  const extraction = extractPdf.extractTextPdf(filePath);
  const evidenceRow = importEvidenceForFile(db, project, filePath, options.observedAt);
  const { document, deduplicated } = ensureDocument(db, {
    projectId: project,
    supplierKey,
    parserVersion,
    rawSha256: extraction.rawSha256,
    fileRef: filePath,
    byteSize: extraction.byteSize,
    format: 'pdf_text',
    localization: extraction.localization.status,
    evidenceId: evidenceRow.id
  });
  if (deduplicated) {
    return { status: 'deduplicated', document: decorateDocument(document), candidates: listCandidates(db, project, { documentId: document.document_id }), extraction: summarizeExtraction(extraction), evidence: { id: evidenceRow.id, deduplicated: Boolean(evidenceRow.deduplicated) } };
  }
  if (extraction.textMode === 'scanned') {
    db.prepare('UPDATE import_documents SET status = ? WHERE project_id = ? AND document_id = ?').run('scanned_no_text', project, document.document_id);
    return { status: 'scanned_requires_ocr', document: decorateDocument(getDocument(db, project, document.document_id)), candidates: [], extraction: summarizeExtraction(extraction), evidence: { id: evidenceRow.id, deduplicated: Boolean(evidenceRow.deduplicated) } };
  }
  const inserts = [];
  for (const page of extraction.pages) {
    for (const [lineIndex, line] of page.lines.entries()) {
      for (const candidate of fields.detectLineFields(line)) {
        if (!line.includes(candidate.snippet)) throw new ValidationError('candidate snippet is not supported by the extracted line (refusing an unsupported field)');
        inserts.push(insertCandidate(db, project, document, {
          ...candidate,
          pageNumber: page.pageNumber,
          physicalIndex: page.physicalIndex,
          lineIndex,
          method: `${extractPdf.PARSER_VERSION}#pageObj:${page.objectNumber}`,
          originHint: 'seller_statement'
        }));
      }
    }
  }
  const conflicts = applyConflictReasons(db, project, document.document_id);
  return {
    status: 'imported',
    document: decorateDocument(getDocument(db, project, document.document_id)),
    candidates: listCandidates(db, project, { documentId: document.document_id }),
    extraction: summarizeExtraction(extraction),
    conflicts,
    counts: { candidates: inserts.length, newCandidates: inserts.filter((item) => item.inserted).length }
  };
}

/** Table import (csv/xlsx): real bytes -> mapped cells with sheet/row/column provenance. */
async function importTable(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const filePath = requireReadableFile(options.filePath);
  const supplierKey = requireString(options.supplierKey, 'supplierKey');
  const format = options.format ?? detectFormat(filePath);
  if (format !== 'csv' && format !== 'xlsx') throw new ValidationError(`table import requires csv or xlsx bytes (detected: ${format})`);
  const extraction = await extractTable.extractTableFile(filePath, format);
  const parserVersion = options.parserVersion ?? extraction.parserVersion;
  const evidenceRow = importEvidenceForFile(db, project, filePath, options.observedAt);
  const { document, deduplicated } = ensureDocument(db, {
    projectId: project,
    supplierKey,
    parserVersion,
    rawSha256: extraction.rawSha256,
    fileRef: filePath,
    byteSize: extraction.byteSize,
    format,
    localization: 'sheet_rows',
    evidenceId: evidenceRow.id
  });
  if (deduplicated) {
    return { status: 'deduplicated', document: decorateDocument(document), candidates: listCandidates(db, project, { documentId: document.document_id }), extraction: summarizeExtraction(extraction), evidence: { id: evidenceRow.id, deduplicated: Boolean(evidenceRow.deduplicated) } };
  }
  const inserts = [];
  for (const sheet of extraction.sheets) {
    const headerRow = sheet.rows[0];
    const headerMap = headerRow ? extractTable.buildHeaderMap(headerRow.cells) : new Map();
    if (headerMap.size === 0) {
      // headerless: generic line detector over row text; no column-to-field guessing
      for (const row of sheet.rows) {
        const rowText = row.cells.map((cell) => cell.text).filter((text) => String(text).trim() !== '').join(' ');
        for (const candidate of fields.detectLineFields(rowText)) {
          if (!rowText.includes(candidate.snippet)) throw new ValidationError('candidate snippet is not supported by the row text');
          inserts.push(insertCandidate(db, project, document, { ...candidate, sheet: sheet.name, rowNumber: row.rowNumber, method: `${extraction.parserVersion}#headerless-row`, originHint: 'seller_statement' }));
        }
      }
    } else {
      for (const row of sheet.rows.slice(1)) {
        const rowText = row.cells.map((cell) => cell.text).join(' ');
        for (const candidate of extractTable.rowCandidates(row, headerMap, sheet.name)) {
          if (!rowText.includes(candidate.snippet)) throw new ValidationError('candidate snippet is not supported by the row text');
          inserts.push(insertCandidate(db, project, document, { ...candidate, method: `${extraction.parserVersion}#mapped-header`, originHint: 'seller_statement' }));
        }
      }
    }
  }
  const conflicts = applyConflictReasons(db, project, document.document_id);
  return {
    status: 'imported',
    document: decorateDocument(getDocument(db, project, document.document_id)),
    candidates: listCandidates(db, project, { documentId: document.document_id }),
    extraction: summarizeExtraction(extraction),
    conflicts,
    counts: { candidates: inserts.length, newCandidates: inserts.filter((item) => item.inserted).length }
  };
}

/** OCR phase for a bounded image set (no writes happen here; calls may be in flight). */
async function runScanOcrPhase(images, transport) {
  const results = [];
  for (const image of images) {
    if (image.status !== 'ok') {
      results.push({ image, ocr: { status: 'unsupported', reason: image.reason, lines: [], remoteId: null, operationId: null, attemptToken: null } });
      continue;
    }
    const operationId = `scan:${image.imageSha256 ?? image.index}`;
    const attemptToken = `scan-attempt:${image.index}:1`;
    const ocr = await extractScan.runScanOcr(image, { transport, operationId, attemptToken });
    results.push({ image, ocr });
  }
  return results;
}

/** Atomic write phase: document/evidence/page rows/candidates/coverage commit as one item. */
function publishScanResults(db, params) {
  const { project, supplierKey, parserVersion, read, ocrResults, maxPages, filePath, observedAt, resumed } = params;
  const evidenceRow = evidence.importEvidenceFromFile(txShim(db), project, {
    filePath,
    sourceType: 'manual_upload',
    importBasis: 'supplier_material',
    observedAt
  });
  let document = params.document;
  if (!document) {
    const ensured = ensureDocument(db, {
      projectId: project,
      supplierKey,
      parserVersion,
      rawSha256: read.rawSha256,
      fileRef: filePath,
      byteSize: read.byteSize,
      format: read.kind === 'image' ? `image/${read.format}` : 'scan_pdf',
      localization: read.pageTree ? read.pageTree.status : 'standalone_image',
      evidenceId: evidenceRow.id
    });
    document = ensured.document;
  }
  const inserted = [];
  for (const item of ocrResults) {
    const { image, ocr } = item;
    if (ocr.status === 'ocr_succeeded') {
      for (const line of ocr.lines) {
        for (const candidate of fields.detectLineFields(line.text)) {
          if (!line.text.includes(candidate.snippet)) throw new ValidationError('scan candidate snippet is not supported by the OCR line');
          inserted.push(insertCandidate(db, project, document, {
            ...candidate,
            pageNumber: image.pageNumber,
            physicalIndex: image.physicalIndex,
            lineIndex: line.lineIndex,
            imageObject: image.objectNumber,
            imageSha256: image.imageSha256,
            regionJson: line.bbox ? JSON.stringify(line.bbox) : (line.regionReason ? JSON.stringify({ invalid: line.regionReason }) : null),
            method: `${extractScan.SCAN_PARSER_VERSION}#fixture-transport`,
            originHint: 'seller_statement'
          }));
        }
      }
    }
    db.prepare(INSERT_SCAN_PAGE_SQL).run({
      page_result_id: newId('impscan'),
      project_id: project,
      document_id: document.document_id,
      image_index: image.index,
      page_number: image.pageNumber,
      physical_index: image.physicalIndex,
      image_object: image.objectNumber === null || image.objectNumber === undefined ? null : String(image.objectNumber),
      image_sha256: image.imageSha256 ?? null,
      remote_id: ocr.remoteId ?? null,
      operation_id: ocr.operationId ?? null,
      attempt_token: ocr.attemptToken ?? null,
      status: ocr.status,
      reason: ocr.reason ?? null,
      created_at: nowIso()
    });
  }
  let allRows = listScanPages(db, project, document.document_id);
  if (allRows.length === 0) {
    db.prepare(INSERT_SCAN_PAGE_SQL).run({
      page_result_id: newId('impscan'),
      project_id: project,
      document_id: document.document_id,
      image_index: 0,
      page_number: null,
      physical_index: null,
      image_object: null,
      image_sha256: null,
      remote_id: null,
      operation_id: null,
      attempt_token: null,
      status: 'no_image',
      reason: 'no_image_objects_found',
      created_at: nowIso()
    });
    allRows = listScanPages(db, project, document.document_id);
  }
  const statusCounts = { succeeded: 0, pending: 0, invalid: 0, blocked: 0, unsupported: 0, noImage: 0 };
  for (const row of allRows) {
    if (row.status === 'ocr_succeeded') statusCounts.succeeded += 1;
    else if (row.status === 'ocr_pending') statusCounts.pending += 1;
    else if (row.status === 'ocr_invalid') statusCounts.invalid += 1;
    else if (row.status === 'ocr_blocked') statusCounts.blocked += 1;
    else if (row.status === 'unsupported') statusCounts.unsupported += 1;
    else if (row.status === 'no_image') statusCounts.noImage += 1;
  }
  const imagesProcessed = allRows.filter((row) => row.status !== 'no_image').length;
  const imagesFound = read.imageCount ?? read.images.length;
  const coverage = {
    imagesFound,
    imagesProcessed,
    maxPages,
    truncated: imagesProcessed < imagesFound || (read.omitted ?? 0) > 0,
    statusCounts,
    readerOmitted: read.omitted ?? 0,
    readerTruncated: read.truncated === true
  };
  db.prepare('UPDATE import_documents SET coverage_json = ?, status = ?, localization = ? WHERE project_id = ? AND document_id = ?')
    .run(JSON.stringify(coverage), coverage.truncated ? 'partial' : 'scanned', read.pageTree ? read.pageTree.status : 'standalone_image', project, document.document_id);
  const conflicts = applyConflictReasons(db, project, document.document_id);
  return {
    status: coverage.truncated ? 'partial' : (resumed ? 'resumed' : 'imported'),
    document: decorateDocument(getDocument(db, project, document.document_id)),
    pages: allRows,
    candidates: listCandidates(db, project, { documentId: document.document_id }),
    coverage,
    conflicts,
    counts: { candidates: inserted.length, newCandidates: inserted.filter((item) => item.inserted).length, imagesProcessedThisCall: ocrResults.length }
  };
}

/**
 * Scan import: real images -> fixture-injected S1 protocol. Default closed. `maxPages` bounds the
 * number of IMAGES processed per call; every call persists explicit coverage and a larger
 * follow-up call resumes the unprocessed images (an interrupted call persists NOTHING and can be
 * retried; a bounded call never claims a complete dedup).
 */
async function importScan(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const filePath = requireReadableFile(options.filePath);
  const supplierKey = requireString(options.supplierKey, 'supplierKey');
  const parserVersion = options.parserVersion ?? extractScan.SCAN_PARSER_VERSION;
  const requested = options.maxPages === undefined ? extractScan.DEFAULT_MAX_PAGES : Number(options.maxPages);
  const maxPages = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, extractScan.PAGE_HARD_CAP) : extractScan.DEFAULT_MAX_PAGES;
  const read = extractScan.readScanImages(filePath);
  if (typeof options.fixtureTransport !== 'function') {
    return {
      status: 'blocked',
      reason: 'scan_ocr_unavailable',
      manualEntryAllowed: true,
      rawSha256: read.rawSha256,
      imagesFound: read.images.length,
      notes: ['fixture OCR transport not provided — default closed; no document/rows written; manual entry path available (addManualCandidate)']
    };
  }
  const existing = getDocumentByHash(db, project, { supplierKey, parserVersion, rawSha256: read.rawSha256 });
  if (existing) {
    const processedRows = listScanPages(db, project, existing.document_id);
    const processedIndexes = new Set(processedRows.map((row) => row.image_index));
    const remaining = read.images.filter((image) => !processedIndexes.has(image.index));
    // per-CALL bound: the first maxPages of the REMAINING images (never a permanent index cutoff)
    const toProcess = remaining.slice(0, maxPages);
    if (toProcess.length === 0) {
      const coverage = parseCoverage(existing);
      const complete = Boolean(coverage) && coverage.imagesProcessed >= coverage.imagesFound && coverage.truncated !== true;
      return {
        status: complete ? 'deduplicated' : 'partial',
        document: decorateDocument(existing),
        pages: processedRows,
        candidates: listCandidates(db, project, { documentId: existing.document_id }),
        coverage: coverage ?? null,
        notes: [complete
          ? 'the (project, supplier, parserVersion, rawHash) domain is already complete; nothing reprocessed'
          : 'bounded coverage is incomplete and this call processed no new images (raise maxPages to resume) — not a complete dedup']
      };
    }
    const ocrResults = await runScanOcrPhase(toProcess, options.fixtureTransport);
    return withOperationTransaction(db, () => publishScanResults(db, {
      project, supplierKey, parserVersion, read, document: existing, ocrResults, maxPages, filePath, observedAt: options.observedAt, resumed: true
    }));
  }
  const freshImages = read.images.slice(0, maxPages);
  const ocrResults = await runScanOcrPhase(freshImages, options.fixtureTransport);
  return withOperationTransaction(db, () => publishScanResults(db, {
    project, supplierKey, parserVersion, read, document: null, ocrResults, maxPages, filePath, observedAt: options.observedAt, resumed: false
  }));
}

/**
 * Manual entry path (used when OCR capability is unapproved/unsupported): a user-authored
 * candidate row tagged manual_entry / user_statement. Strict numeric validation, the same
 * explicit confirm call and the same missing-field guards apply.
 */
function addManualCandidate(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const filePath = requireReadableFile(options.filePath);
  const supplierKey = requireString(options.supplierKey, 'supplierKey');
  const fieldKey = requireString(options.fieldKey, 'fieldKey');
  if (!FIELD_KEYS.includes(fieldKey)) throw new ValidationError(`fieldKey must be one of ${FIELD_KEYS.join(', ')}`);
  if (options.rawValue === undefined || options.rawValue === null || String(options.rawValue).trim() === '') throw new ValidationError('rawValue must be non-empty');
  const rawValue = String(options.rawValue).trim();
  const isNumericField = ['purchase_cost', 'quantity'].includes(fieldKey);
  let numericValue = null;
  if (isNumericField) {
    if (!STRICT_DECIMAL_RE.test(rawValue)) throw new ValidationError('rawValue must be a plain decimal number for purchase_cost/quantity (no trailing text)');
    numericValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(numericValue)) throw new ValidationError('rawValue must be a finite number');
  }
  if (options.currency !== undefined && options.currency !== null && !['USD', 'CNY', 'EUR'].includes(options.currency)) throw new ValidationError('currency must be one of USD, CNY, EUR or null');
  if (options.unit !== undefined && options.unit !== null && (typeof options.unit !== 'string' || options.unit.trim() === '')) throw new ValidationError('unit must be a non-empty string, an explicit null, or omitted');
  if (options.incoterm !== undefined && options.incoterm !== null && !fields.INCOTERMS.includes(options.incoterm)) throw new ValidationError(`incoterm must be one of ${fields.INCOTERMS.join(', ')} or null`);
  let currency = options.currency ?? null;
  let unit = options.unit ?? null;
  let incoterm = options.incoterm ?? null;
  const reasons = [];
  if (isNumericField) {
    if (!unit) reasons.push('missing_unit');
    if (fieldKey === 'purchase_cost') {
      if (!currency) reasons.push('missing_currency');
      if (!incoterm) reasons.push('missing_incoterm');
    }
  } else if (fieldKey === 'currency') {
    // field-specific semantics: the currency field's own raw value is validated and normalized
    const resolved = fields.resolveCurrency((rawValue.match(/[¥￥$€]/) || [])[0] ?? null, rawValue);
    currency = resolved.currency ?? null;
    unit = null;
    incoterm = null;
    if (resolved.reason) reasons.push(resolved.reason === 'missing_currency' ? 'unrecognized_currency' : resolved.reason);
  } else if (fieldKey === 'unit') {
    unit = rawValue;
    currency = null;
    incoterm = null;
  } else if (fieldKey === 'incoterm') {
    const normalized = rawValue.toUpperCase();
    incoterm = fields.INCOTERMS.includes(normalized) ? normalized : null;
    currency = null;
    unit = null;
    if (incoterm === null) reasons.push('unrecognized_incoterm');
  }
  const bytes = fs.readFileSync(filePath);
  const evidenceRow = importEvidenceForFile(db, project, filePath, options.observedAt);
  const { document, deduplicated } = ensureDocument(db, {
    projectId: project,
    supplierKey,
    parserVersion: MANUAL_PARSER_VERSION,
    rawSha256: sha256Hex(bytes),
    fileRef: filePath,
    byteSize: bytes.length,
    format: 'manual',
    localization: 'manual',
    evidenceId: evidenceRow.id
  });
  const insertion = insertCandidate(db, project, document, {
    fieldKey,
    rawValue,
    numericValue,
    currency,
    unit,
    incoterm,
    reasons,
    snippet: rawValue,
    subjectKey: options.subjectKey ?? `manual:${fieldKey}`,
    method: 'manual_entry',
    originHint: 'user_statement'
  });
  return { status: deduplicated && !insertion.inserted ? 'deduplicated' : 'imported', document: decorateDocument(document), candidate: insertion.row, notes: options.note ? [String(options.note)] : [] };
}

/**
 * Explicit confirmation (trusted action): all inputs (observedAt/now strict instants, candidate
 * field integrity) are validated BEFORE any write; observation + approval + candidate link commit
 * as ONE transaction (evidence internals reused read-only via the pass-through shim). Conflicted /
 * gap candidates are refused, so an illegal numeric fact can never be forced.
 */
function confirmCandidate(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const candidateId = requireString(options.candidateId, 'candidateId');
  const candidate = db.prepare('SELECT * FROM import_candidates WHERE project_id = ? AND candidate_id = ?').get(project, candidateId);
  if (!candidate) throw new NotFoundError('candidate not found in this project');
  if (candidate.status !== 'candidate') throw new ConflictError(`candidate is ${candidate.status} and cannot be confirmed`);
  const blockers = candidateBlockers(candidate);
  if (blockers.length > 0) throw new ValidationError(`candidate has unresolved conditions (${blockers.join(', ')}); it stays a candidate (no forced observation)`);
  if (options.observedAt === undefined || options.observedAt === null || options.observedAt === '') {
    throw new ValidationError('observedAt is required for confirmation; observed time unknown stays unknown');
  }
  const observedAt = requireInstant(options.observedAt, 'observedAt');
  const approvedAt = options.now === undefined || options.now === null ? null : requireInstant(options.now, 'now');
  const document = getDocument(db, project, candidate.document_id);
  const value = candidate.numeric_value !== null && candidate.numeric_value !== undefined ? Number(candidate.numeric_value) : candidate.raw_value;
  return withOperationTransaction(db, () => {
    const observation = evidence.createObservation(txShim(db), project, {
      subjectType: 'import_subject',
      subjectId: `${candidate.supplier_key}|${candidate.subject_key}`,
      key: candidate.field_key,
      originType: candidate.origin_hint,
      value,
      unit: candidate.unit ?? undefined,
      observedAt,
      evidenceId: document && document.evidence_id ? document.evidence_id : undefined
    });
    const confirmed = evidence.setObservationApproval(txShim(db), project, observation.id, 'user_confirmed', approvedAt ? { now: approvedAt } : {});
    db.prepare('UPDATE import_candidates SET status = ?, observation_id = ?, updated_at = ? WHERE project_id = ? AND candidate_id = ?')
      .run('confirmed', observation.id, nowIso(), project, candidateId);
    return { candidate: getCandidate(db, project, candidateId), observation: confirmed, actor: options.actor ?? 'user' };
  });
}

/**
 * Versioned correction. Every accepted correction publishes a FRESH version identity (the
 * predecessor is part of the identity, so returning to an old value is a new version, never a
 * revival); the new version's unresolved set is recomputed from the NEW fields (resolved pieces
 * are not blind-carried, unresolved pieces are never erased, a real conflict is not dodged by
 * editing the value). The original row keeps its raw hash/snippet/observation; for a confirmed
 * candidate the old observation is superseded by a new user_statement version. Everything commits
 * as one transaction; invalid inputs (including a confirmed correction that would be incomplete)
 * are rejected BEFORE any write.
 */
function correctCandidate(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const candidateId = requireString(options.candidateId, 'candidateId');
  const old = db.prepare('SELECT * FROM import_candidates WHERE project_id = ? AND candidate_id = ?').get(project, candidateId);
  if (!old) throw new NotFoundError('candidate not found in this project');
  if (old.status === 'superseded') throw new ConflictError('candidate is already superseded');
  if (options.correctedValue === undefined || options.correctedValue === null || String(options.correctedValue).trim() === '') throw new ValidationError('correctedValue must be non-empty');
  const correctedValue = String(options.correctedValue).trim();
  if (options.correctedUnit !== undefined && options.correctedUnit !== null && (typeof options.correctedUnit !== 'string' || options.correctedUnit.trim() === '')) {
    throw new ValidationError('correctedUnit must be a non-empty string, an explicit null, or omitted (blank is not accepted)');
  }
  if (options.correctedCurrency !== undefined && options.correctedCurrency !== null && !['USD', 'CNY', 'EUR'].includes(options.correctedCurrency)) {
    throw new ValidationError('correctedCurrency must be one of USD, CNY, EUR or an explicit null');
  }
  if (options.correctedIncoterm !== undefined && options.correctedIncoterm !== null && !fields.INCOTERMS.includes(options.correctedIncoterm)) {
    throw new ValidationError(`correctedIncoterm must be one of ${fields.INCOTERMS.join(', ')} or an explicit null`);
  }
  const isNumericField = ['purchase_cost', 'quantity'].includes(old.field_key);
  let numericValue = null;
  let valueRejected = false;
  if (isNumericField) {
    if (STRICT_DECIMAL_RE.test(correctedValue)) {
      numericValue = Number.parseFloat(correctedValue);
      if (!Number.isFinite(numericValue)) valueRejected = true;
    } else {
      valueRejected = true;
    }
  }
  let unit = options.correctedUnit !== undefined ? options.correctedUnit : (old.unit ?? null);
  let currency = options.correctedCurrency !== undefined ? options.correctedCurrency : (old.currency ?? null);
  let incoterm = options.correctedIncoterm !== undefined ? options.correctedIncoterm : (old.incoterm ?? null);
  const oldReasonList = old.reasons ? old.reasons.split(';') : [];
  // recompute the new version's unresolved set from the NEW fields (never blind-clear / blind-carry)
  const reasons = [];
  if (isNumericField) {
    if (valueRejected) reasons.push('unparsed_amount');
    if (!unit) reasons.push('missing_unit');
    if (old.field_key === 'purchase_cost') {
      if (!currency) reasons.push(/[¥￥$€]/.test(correctedValue) ? 'currency_ambiguous_yuan_yen' : 'missing_currency');
      if (!incoterm) reasons.push('missing_incoterm');
    }
  } else if (old.field_key === 'currency') {
    // the RAW corrected value is authoritative: correctedCurrency may only CONFIRM an already
    // explicit raw currency — it can never legalize an invalid raw value or override a differing one
    const rawResolved = fields.resolveCurrency((correctedValue.match(/[¥￥$€]/) || [])[0] ?? null, correctedValue);
    const auxProvided = options.correctedCurrency !== undefined && options.correctedCurrency !== null;
    unit = null;
    incoterm = null;
    if (auxProvided) {
      if (rawResolved.currency && rawResolved.currency !== options.correctedCurrency) {
        currency = null;
        reasons.push('currency_conflict');
      } else if (rawResolved.currency && rawResolved.currency === options.correctedCurrency) {
        currency = rawResolved.currency;
      } else {
        currency = null;
        reasons.push(rawResolved.reason === null || rawResolved.reason === 'missing_currency' ? 'unrecognized_currency' : rawResolved.reason);
      }
    } else {
      currency = rawResolved.currency ?? null;
      if (rawResolved.reason) reasons.push(rawResolved.reason === 'missing_currency' ? 'unrecognized_currency' : rawResolved.reason);
    }
  } else if (old.field_key === 'unit') {
    unit = correctedValue;
    currency = null;
    incoterm = null;
  } else if (old.field_key === 'incoterm') {
    const normalized = correctedValue.toUpperCase();
    incoterm = fields.INCOTERMS.includes(normalized) ? normalized : null;
    currency = null;
    unit = null;
    if (incoterm === null) reasons.push('unrecognized_incoterm');
  }
  // unresolved FIELD-level conflicts only disappear with the corresponding EXPLICIT correction
  const carryRules = [
    ['unit_conflict', options.correctedUnit !== undefined || old.field_key === 'unit'],
    ['currency_conflict', options.correctedCurrency !== undefined || old.field_key === 'currency'],
    ['incoterm_conflict', options.correctedIncoterm !== undefined || old.field_key === 'incoterm'],
    ['conflict', false]
  ];
  for (const [code, resolvedField] of carryRules) {
    if (!resolvedField && oldReasonList.includes(code)) reasons.push(code);
  }
  // an explicit unknown dimension in the subject is re-derived structurally: an amount-only
  // correction can never erase it, and the identity stays unknown until the dimension is resolved
  if (typeof old.subject_key === 'string' && /=\?(?:\||$)/.test(old.subject_key) && !reasons.includes('variant_unknown')) {
    reasons.push('variant_unknown');
  }
  if (old.status === 'confirmed') {
    if (options.observedAt === undefined || options.observedAt === null || options.observedAt === '') {
      throw new ValidationError('observedAt is required to supersede a confirmed observation; observed time unknown stays unknown');
    }
    if (valueRejected || reasons.length > 0) {
      throw new ValidationError(`correction of a confirmed fact must be complete (unresolved: ${valueRejected ? 'unparsed_amount' : reasons.join(', ')})`);
    }
  }
  const observedAt = options.observedAt === undefined || options.observedAt === null || options.observedAt === '' ? null : requireInstant(options.observedAt, 'observedAt');
  const approvedAt = options.now === undefined || options.now === null ? null : requireInstant(options.now, 'now');
  const document = getDocument(db, project, old.document_id);
  const observationValue = numericValue !== null && !valueRejected ? numericValue : correctedValue;
  return withOperationTransaction(db, () => {
    const insertion = insertCandidate(db, project, document, {
      fieldKey: old.field_key,
      rawValue: correctedValue,
      numericValue: valueRejected ? null : numericValue,
      currency,
      unit,
      incoterm,
      reasons,
      snippet: correctedValue,
      subjectKey: old.subject_key,
      method: 'user_correction',
      originHint: 'user_statement',
      pageNumber: old.page_number,
      physicalIndex: old.physical_index,
      lineIndex: old.line_index,
      sheet: old.sheet,
      rowNumber: old.row_number,
      columnRef: old.column_ref,
      imageObject: old.image_object,
      imageSha256: old.image_sha256,
      regionJson: old.region_json,
      supersedesCandidateId: old.candidate_id
    });
    db.prepare('UPDATE import_candidates SET status = ?, updated_at = ? WHERE project_id = ? AND candidate_id = ?')
      .run('superseded', nowIso(), project, old.candidate_id);
    const correctionRow = {
      correction_id: newId('impcorr'),
      project_id: project,
      document_id: old.document_id,
      old_candidate_id: old.candidate_id,
      new_candidate_id: insertion.row.candidate_id,
      old_value: old.raw_value,
      new_value: correctedValue,
      note: options.note ?? null,
      source: 'user_statement',
      created_at: nowIso()
    };
    db.prepare(`INSERT OR IGNORE INTO import_corrections (correction_id, project_id, document_id, old_candidate_id, new_candidate_id, old_value, new_value, note, source, created_at)
      VALUES (@correction_id, @project_id, @document_id, @old_candidate_id, @new_candidate_id, @old_value, @new_value, @note, @source, @created_at)`).run(correctionRow);
    let observation = null;
    if (old.status === 'confirmed' && old.observation_id) {
      const replacement = evidence.supersedeObservation(txShim(db), project, old.observation_id, {
        value: observationValue,
        unit: unit ?? undefined,
        originType: 'user_statement',
        observedAt,
        evidenceId: document && document.evidence_id ? document.evidence_id : undefined
      });
      observation = evidence.setObservationApproval(txShim(db), project, replacement.replacement.id, 'user_confirmed', approvedAt ? { now: approvedAt } : {});
      db.prepare('UPDATE import_candidates SET status = ?, observation_id = ?, updated_at = ? WHERE project_id = ? AND candidate_id = ?')
        .run('confirmed', replacement.replacement.id, nowIso(), project, insertion.row.candidate_id);
    }
    return { old: getCandidate(db, project, old.candidate_id), candidate: getCandidate(db, project, insertion.row.candidate_id), correction: correctionRow, observation };
  });
}

/** Aggregate report for the task output ([P]\runtime\imports\import-report.json). */
function buildReport(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const documents = listDocuments(db, project);
  const candidates = listCandidates(db, project);
  const report = {
    schemaVersion: 1,
    taskId: options.taskId ?? 'T1.7',
    runId: options.runId ?? null,
    generatedAt: nowIso(),
    projectId: project,
    fixtureOnly: true,
    realOutboundCalls: 0,
    supportedFormats: SUPPORTED_FORMATS,
    unsupported: UNSUPPORTED,
    documents: documents.map((document) => ({
      documentId: document.document_id,
      supplierKey: document.supplier_key,
      parserVersion: document.parser_version,
      rawSha256: document.raw_sha256,
      format: document.format,
      localization: document.localization,
      status: document.status,
      byteSize: document.byte_size,
      evidenceId: document.evidence_id,
      coverage: parseCoverage(document)
    })),
    counts: {
      documents: documents.length,
      candidates: candidates.length,
      confirmed: candidates.filter((row) => row.status === 'confirmed').length,
      superseded: candidates.filter((row) => row.status === 'superseded').length,
      byField: candidates.reduce((acc, row) => { acc[row.field_key] = (acc[row.field_key] ?? 0) + 1; return acc; }, {})
    },
    samples: candidates.slice(0, 60).map((row) => ({
      candidateId: row.candidate_id,
      documentId: row.document_id,
      supplierKey: row.supplier_key,
      fieldKey: row.field_key,
      rawValue: row.raw_value,
      numericValue: row.numeric_value,
      currency: row.currency,
      unit: row.unit,
      incoterm: row.incoterm,
      status: row.status,
      reasons: row.reasons,
      pageNumber: row.page_number,
      physicalIndex: row.physical_index,
      lineIndex: row.line_index,
      sheet: row.sheet,
      rowNumber: row.row_number,
      columnRef: row.column_ref,
      snippet: row.snippet,
      method: row.method,
      observationId: row.observation_id,
      imageObject: row.image_object,
      imageSha256: row.image_sha256,
      regionJson: row.region_json,
      supersedesCandidateId: row.supersedes_candidate_id
    })),
    scanPages: db.prepare('SELECT * FROM import_scan_pages WHERE project_id = ? ORDER BY created_at, page_result_id').all(project).map((row) => ({
      documentId: row.document_id,
      imageIndex: row.image_index,
      physicalIndex: row.physical_index,
      pageNumber: row.page_number,
      imageObject: row.image_object,
      imageSha256: row.image_sha256,
      remoteId: row.remote_id,
      operationId: row.operation_id,
      attemptToken: row.attempt_token,
      status: row.status,
      reason: row.reason
    })),
    corrections: listCorrections(db, project).map((row) => ({
      correctionId: row.correction_id,
      documentId: row.document_id,
      oldCandidateId: row.old_candidate_id,
      newCandidateId: row.new_candidate_id,
      oldValue: row.old_value,
      newValue: row.new_value,
      note: row.note,
      source: row.source
    })),
    idempotency: options.idempotency ?? null,
    notes: [
      'fixture-only: no real outbound calls, no fees, no credential values, no OCR engine installed',
      'scan OCR responses are injected fixture protocols (not recognition-rate or live-vision claims)',
      'captured metadata is never presented as a supplier quote time; missing observed time stays unknown',
      'maxPages bounds IMAGES PER CALL; coverage.truncated marks bounded/partial imports that a larger call can resume'
    ]
  };
  return report;
}

module.exports = {
  MANUAL_PARSER_VERSION,
  FIELD_KEYS,
  CONFIRM_BLOCKERS,
  SUPPORTED_FORMATS,
  UNSUPPORTED,
  detectFormat,
  getDocument,
  getDocumentByHash,
  listDocuments,
  getCandidate,
  listCandidates,
  listScanPages,
  listCorrections,
  importPdfText,
  importTable,
  importScan,
  addManualCandidate,
  confirmCandidate,
  correctCandidate,
  buildReport
};
