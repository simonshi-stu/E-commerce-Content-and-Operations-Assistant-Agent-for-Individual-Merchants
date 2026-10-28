'use strict';
/**
 * T3.4 channel lead exports — tiered CSV/XLSX with source/time/license/verification columns.
 *
 * Reuses the approved T1.5 privacy contract (`applyProfile` / known-leaf tiering) without
 * modifying the privacy core: `internal-full` keeps external+internal+private (+ scrubbed free
 * text) and always drops secrets; `external-redacted` keeps only explicitly classified external
 * fields. Unclassified leaves (including nested objects/arrays) are never copied in any profile
 * (fail-closed). Raw private contacts stay intact in the private area; the external profile only
 * ever sees the redacted whitelist copy.
 *
 * Paths are factory-trusted: files land under `<exportRoot>/<runId>/<profile>/` with fixed names
 * (worker.resolveScoped + realpath guard). Writes are atomic; an existing directory with different
 * content is refused (never blind-overwritten); identical content is verified and reused by hash.
 *
 * The registered handler records contact provenance / sales events (via companies.js) and writes
 * the export artifacts + an English outreach DRAFT. It never sends anything and never marks a
 * lead contacted from a draft.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const evidence = require('./evidence.js');
const worker = require('./worker.js');
const { canonicalJson } = require('./packs.js');
const { applyProfile, validatePolicy, findCanaryHits, PROFILES } = require('./privacy.js');
const companies = require('./companies.js');

const CHANNEL_EXPORT_SCHEMA_VERSION = 1;
const CHANNEL_TOOL_NAME = 'commerce.channels.export';
const CHANNEL_TOOL_VERSION = '1.0.0';
const CHANNEL_SHEET_NAME = 'channel-leads';
const CHANNEL_EXPORT_FORMATS = Object.freeze(['csv', 'xlsx']);
const CHANNEL_EXPORT_MANIFEST = 'channel-leads.export.json';

class ChannelExportError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ChannelExportError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
function channelError(code, message, detail) { return new ChannelExportError(code, message, detail); }
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

/** Fixed, validated export policy: every emitted leaf is classified; secret fields never leave. */
const CHANNEL_EXPORT_POLICY = validatePolicy({
  schemaVersion: 1,
  schemaId: 'channel-lead-export-v1',
  fields: {
    'rows.leadId': 'external',
    'rows.companyName': 'external',
    'rows.domain': 'external',
    'rows.address': 'internal',
    'rows.contactId': 'external',
    'rows.contactType': 'external',
    'rows.contactValue': 'internal',
    'rows.contactSourceUrl': 'external',
    'rows.contactSourceKind': 'external',
    'rows.contactObservedAt': 'external',
    'rows.contactTimeKnown': 'external',
    'rows.contactContentSha256': 'external',
    'rows.contactEvidenceRef': 'internal',
    'rows.contactLicense': 'external',
    'rows.verificationLevel': 'external',
    'rows.verificationReason': 'external',
    'rows.salesStage': 'external',
    'rows.salesVersion': 'external',
    'rows.salesReason': 'external',
    'rows.salesTerminal': 'external',
    'rows.internalNote': 'free_text',
    'rows.internalRef': 'private',
    'rows.internalSecret': 'secret'
  }
});

/** Fixed column order for CSV/XLSX (keys the row builder emits). */
const CHANNEL_EXPORT_COLUMNS = Object.freeze([
  'leadId', 'companyName', 'domain', 'address',
  'contactId', 'contactType', 'contactValue', 'contactSourceUrl', 'contactSourceKind',
  'contactObservedAt', 'contactTimeKnown', 'contactContentSha256', 'contactEvidenceRef', 'contactLicense',
  'verificationLevel', 'verificationReason',
  'salesStage', 'salesVersion', 'salesReason', 'salesTerminal',
  'internalNote', 'internalRef', 'internalSecret'
]);

/** Formula-injection guard: a leading = + - @ (even behind whitespace/control chars) becomes text. */
function sanitizeExportCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) return `'${text}`;
  return text;
}

/** Finite set of encodings of a private value that must never survive into an external artifact. */
function buildPrivateVariants(values) {
  const variants = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    variants.add(value);
    try { variants.add(encodeURIComponent(value)); } catch { /* keep raw only */ }
    variants.add(value.replace(/@/g, '%40'));
    variants.add(value.replace(/@/g, '%2540'));
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

function sanitizeExternalText(text, variants) {
  let result = String(text);
  for (const variant of variants) {
    if (variant === '') continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '[redacted]');
  }
  return result;
}

/** Safe external URL composition: scheme://host + path only (query/fragment dropped — a private
 *  value can never ride along in a query string). Non-http(s) values are omitted. */
function safeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * External-profile projection for this item's known private values: every string field is rebuilt
 * (URLs) or redacted (raw + finite encoded variants) BEFORE the tier filter runs, so whitelisted
 * metadata (source URL, license, reasons, future fields) can never carry a private contact value.
 * The internal profile keeps the original values untouched.
 */
function projectExternalRows(rows, privateValues) {
  const variants = buildPrivateVariants(privateValues);
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') { out[key] = value; continue; }
      let projected = value;
      if (/^https?:\/\//i.test(projected)) {
        const safe = safeExternalUrl(projected);
        projected = safe === null ? '[redacted-url]' : safe;
      }
      out[key] = sanitizeExternalText(projected, variants);
    }
    return out;
  });
}

/** Builds one export row per contact (a lead without contacts still exports one summary row). */
function buildChannelExportRows({ lead, contacts, salesState, license }) {
  const base = {
    leadId: lead.id,
    companyName: lead.name,
    domain: lead.domain || '',
    address: lead.address || '',
    salesStage: salesState.stage,
    salesVersion: salesState.version,
    salesReason: salesState.reason,
    salesTerminal: salesState.terminal ? 'terminal' : 'open',
    contactLicense: license || '',
    internalNote: '',
    internalRef: '',
    internalSecret: ''
  };
  const list = Array.isArray(contacts) ? contacts : [];
  if (list.length === 0) {
    return [{
      ...base,
      contactId: '', contactType: '', contactValue: '', contactSourceUrl: '', contactSourceKind: '',
      contactObservedAt: 'unknown', contactTimeKnown: 'unknown', contactContentSha256: '', contactEvidenceRef: '',
      verificationLevel: 'unverified', verificationReason: 'no contact record'
    }];
  }
  return list.map((contact) => ({
    ...base,
    contactId: contact.contactId,
    contactType: contact.contactType,
    contactValue: contact.value,
    contactSourceUrl: contact.sourceUrl || '',
    contactSourceKind: contact.sourceKind || '',
    contactObservedAt: contact.timeKnown ? contact.observedAt : 'unknown',
    contactTimeKnown: contact.timeKnown ? 'known' : 'unknown',
    contactContentSha256: contact.contentSha256 || '',
    contactEvidenceRef: contact.evidenceRef || '',
    verificationLevel: contact.level,
    verificationReason: contact.reason,
    internalNote: contact.note || ''
  }));
}

function csvEscape(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC4180 CSV: UTF-8, comma separation, quote/newline roundtrip; formula guard applied per cell. */
function serializeChannelCsv(rows) {
  const lines = [CHANNEL_EXPORT_COLUMNS.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(CHANNEL_EXPORT_COLUMNS.map((column) => csvEscape(sanitizeExportCell(row[column] === undefined ? '' : row[column]))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Independent CSV readback (RFC4180: quotes, escaped quotes, embedded newlines). */
function parseChannelCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = String(text);
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (inQuotes) {
      if (ch === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ''));
}

function readBackChannelCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseChannelCsv(text);
  const headers = rows.length > 0 ? rows[0] : [];
  return {
    headers,
    rows: rows.slice(1).map((entry) => Object.fromEntries(headers.map((header, index) => [header, entry[index] === undefined ? '' : entry[index]])))
  };
}

async function buildChannelWorkbookBuffer(rows) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'T3.4 channel export (fixture_passed)';
  const sheet = workbook.addWorksheet(CHANNEL_SHEET_NAME, { state: 'visible' });
  sheet.addRow(CHANNEL_EXPORT_COLUMNS);
  for (const row of rows) {
    sheet.addRow(CHANNEL_EXPORT_COLUMNS.map((column) => sanitizeExportCell(row[column] === undefined ? '' : row[column])));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Reopens the workbook and reports every cell plus formula/hyperlink/comment/hidden-sheet state. */
async function readBackChannelWorkbook(filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets = [];
  let hasFormulas = false;
  let hasHyperlinks = false;
  let hasComments = false;
  for (const worksheet of workbook.worksheets) {
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      for (let index = 1; index <= row.cellCount; index += 1) {
        const cell = row.getCell(index);
        const value = cell.value;
        if (value !== null && typeof value === 'object') {
          if (value.formula !== undefined || value.sharedFormula !== undefined) hasFormulas = true;
          if (cell.hyperlink !== undefined && cell.hyperlink !== null) hasHyperlinks = true;
          if (cell.note !== undefined && cell.note !== null) hasComments = true;
        }
        if (cell.hyperlink !== undefined && cell.hyperlink !== null) hasHyperlinks = true;
        if (cell.note !== undefined && cell.note !== null) hasComments = true;
        if (value !== null && typeof value === 'object' && value.text !== undefined && value.hyperlink !== undefined) {
          values.push(value.text);
        } else if (value !== null && typeof value === 'object' && Array.isArray(value.richText)) {
          values.push(value.richText.map((part) => part.text).join(''));
        } else {
          values.push(value === null || value === undefined ? '' : value);
        }
      }
      rows.push(values);
    });
    sheets.push({ name: worksheet.name, state: worksheet.state || 'visible', rows });
  }
  return {
    sheetNames: workbook.worksheets.map((sheet) => sheet.name),
    sheets,
    hiddenSheets: sheets.filter((sheet) => sheet.state !== 'visible').map((sheet) => sheet.name),
    hasFormulas,
    hasHyperlinks,
    hasComments
  };
}

function assertNoCanaryLeak(serialized, canaries, label) {
  const hits = findCanaryHits(serialized, canaries);
  if (hits.length > 0) throw channelError('external_leak', `${label} contains forbidden content`, { hits: hits.length });
}

/**
 * Prepares one export artifact WITHOUT writing anything: validates the fixed profile/format, applies
 * the external projection (known private values) and the tier filter, checks path safety and any
 * existing manifest (conflict → throw; identical rows → reuse), and builds the content in memory.
 */
async function prepareChannelExport({ exportRoot, runId, profile, format, rows, policy = CHANNEL_EXPORT_POLICY, privateValues = null, clock = () => new Date().toISOString() }) {
  if (typeof exportRoot !== 'string' || exportRoot.trim() === '') throw channelError('validation', 'exportRoot (trusted factory config) is required');
  if (!PROFILES.includes(profile)) throw channelError('export_profile_not_allowed', `profile ${String(profile)} is not a fixed known profile`);
  if (!CHANNEL_EXPORT_FORMATS.includes(format)) throw channelError('export_format_not_allowed', `format ${String(format)} is not supported`);
  if (!Array.isArray(rows)) throw channelError('validation', 'rows must be an array');
  const safeRunId = worker.assertSafePathId(runId, 'runId');
  const dir = worker.resolveScoped(exportRoot, [safeRunId, profile], 'channel export');
  const sourceRows = profile === 'external-redacted' && Array.isArray(privateValues) ? projectExternalRows(rows, privateValues) : rows;
  const filtered = applyProfile({ rows: sourceRows }, policy, profile);
  const outRows = Array.isArray(filtered.rows) ? filtered.rows : [];
  const rowsSha256 = sha256Hex(canonicalJson(outRows));
  const filePath = path.join(dir, `channel-leads.${format}`);
  const manifestPath = path.join(dir, CHANNEL_EXPORT_MANIFEST);
  const fileExists = fs.existsSync(filePath);
  const manifestExists = fs.existsSync(manifestPath);
  let existingManifest = null;
  if (manifestExists) {
    try { existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { existingManifest = null; }
    if (!existingManifest || existingManifest.rowsSha256 !== rowsSha256) {
      throw channelError('export_conflict', 'this export directory already holds different artifacts; use a new run id (existing bytes are left untouched)');
    }
  }
  if (fileExists) {
    if (!existingManifest) throw channelError('export_conflict', 'the export directory holds a partial previous export; refusing to mix versions');
    const existingHash = sha256Hex(fs.readFileSync(filePath));
    const recorded = existingManifest.files && existingManifest.files[format] ? existingManifest.files[format].sha256 : null;
    if (recorded !== existingHash) throw channelError('export_conflict', 'the existing artifact hash does not match its manifest (fail-closed)');
    return { dir, filePath, manifestPath, profile, format, rowsSha256, outRows, content: null, existingManifest, reuse: { sha256: existingHash } };
  }
  const content = format === 'csv' ? serializeChannelCsv(outRows) : await buildChannelWorkbookBuffer(outRows);
  return { dir, filePath, manifestPath, profile, format, rowsSha256, outRows, content, existingManifest, reuse: null };
}

/** Publishes a prepared artifact (tmp + atomic rename + manifest). Never overwrites a referenced one. */
function commitPreparedExport(prepared, { clock = () => new Date().toISOString() } = {}) {
  const { dir, filePath, manifestPath, profile, format, rowsSha256, content, reuse } = prepared;
  fs.mkdirSync(dir, { recursive: true });
  if (reuse) return { dir, path: filePath, sha256: reuse.sha256, profile, format, rowsSha256, reused: true };
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
  const sha256 = sha256Hex(fs.readFileSync(filePath));
  // re-read the manifest at commit time so a sibling format written earlier in the same run is kept
  let latestManifest = null;
  if (fs.existsSync(manifestPath)) {
    try { latestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { latestManifest = null; }
  }
  if (latestManifest && latestManifest.rowsSha256 !== rowsSha256) {
    throw channelError('export_conflict', 'the export directory manifest changed concurrently; refusing to mix versions');
  }
  const manifest = {
    schemaVersion: CHANNEL_EXPORT_SCHEMA_VERSION,
    kind: 't3.4_channel_export',
    profile,
    rowsSha256,
    generatedAt: clock(),
    files: { ...(latestManifest && latestManifest.files ? latestManifest.files : {}), [format]: { name: path.basename(filePath), sha256 } }
  };
  const manifestTmp = `${manifestPath}.tmp-${Date.now()}`;
  fs.writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(manifestTmp, 'utf8'));
  fs.renameSync(manifestTmp, manifestPath);
  return { dir, path: filePath, sha256, profile, format, rowsSha256, reused: false };
}

/** Single-shot helper (trusted-operator boundary): prepare + commit. Not a permission check. */
async function writeChannelExport({ exportRoot, runId, profile, format, rows, policy = CHANNEL_EXPORT_POLICY, privateValues = null, clock = () => new Date().toISOString() }) {
  const prepared = await prepareChannelExport({ exportRoot, runId, profile, format, rows, policy, privateValues, clock });
  return commitPreparedExport(prepared, { clock });
}

// ---------- registered handler (T2.7 registry/orchestrator envelope) ----------

const CHANNEL_INPUT_SCHEMA = {
  type: 'object',
  required: ['scope', 'lead', 'contacts', 'exportProfiles'],
  additionalProperties: false,
  properties: {
    scope: {
      type: 'object',
      required: ['projectId', 'brand', 'market'],
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', minLength: 1, maxLength: 120 },
        brand: { type: 'string', maxLength: 120 },
        market: { type: 'string', minLength: 1, maxLength: 40 }
      }
    },
    lead: {
      type: 'object',
      required: ['leadId'],
      additionalProperties: false,
      properties: { leadId: { type: 'string', minLength: 1, maxLength: 120 } }
    },
    contacts: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object',
        required: ['contactType'],
        additionalProperties: false,
        properties: {
          contactType: { type: 'string', minLength: 1, maxLength: 40 },
          value: { type: 'string', maxLength: 300 },
          sourceUrl: { type: 'string', maxLength: 500 },
          observedAt: { type: 'string', maxLength: 40 },
          sourceKind: { type: 'string', maxLength: 40 },
          contentSha256: { type: 'string', maxLength: 64 },
          evidenceRef: { type: 'string', maxLength: 120 },
          note: { type: 'string', maxLength: 500 }
        }
      }
    },
    verifications: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object',
        required: ['contactIndex'],
        additionalProperties: false,
        properties: {
          contactIndex: { type: 'integer', minimum: 0, maximum: 19 },
          verificationId: { type: 'string', maxLength: 120 },
          method: { type: 'string', maxLength: 60 },
          subjectDomain: { type: 'string', maxLength: 200 },
          reference: { type: 'string', maxLength: 200 },
          verifiedAt: { type: 'string', maxLength: 40 },
          status: { type: 'string', maxLength: 20 },
          expiresAt: { type: 'string', maxLength: 40 }
        }
      }
    },
    events: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object',
        required: ['toStage', 'eventId', 'reason'],
        additionalProperties: false,
        properties: {
          toStage: { type: 'string', minLength: 1, maxLength: 40 },
          eventId: { type: 'string', minLength: 1, maxLength: 120 },
          reason: { type: 'string', minLength: 1, maxLength: 300 },
          occurredAt: { type: 'string', maxLength: 40 },
          occurredContact: { type: 'object', properties: {}, additionalProperties: true },
          userConfirmedHistory: { type: 'object', properties: {}, additionalProperties: true },
          replyRecord: { type: 'object', properties: {}, additionalProperties: true },
          sampleRecord: { type: 'object', properties: {}, additionalProperties: true },
          quoteRecord: { type: 'object', properties: {}, additionalProperties: true },
          dealRef: { type: 'object', properties: {}, additionalProperties: true },
          lostReason: { type: 'string', maxLength: 300 }
        }
      }
    },
    draft: {
      type: 'object',
      additionalProperties: false,
      properties: {
        language: { type: 'string', maxLength: 10 },
        subject: { type: 'string', minLength: 1, maxLength: 300 },
        body: { type: 'string', minLength: 1, maxLength: 4000 },
        claims: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 300 } },
        allowedClaims: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 300 } },
        signature: { type: 'string', maxLength: 200 }
      }
    },
    license: { type: 'string', maxLength: 300 },
    exportProfiles: { type: 'array', maxItems: 2, items: { type: 'string', minLength: 1, maxLength: 40 } }
  }
};

const CHANNEL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['contacts', 'stages', 'exports'],
  additionalProperties: false,
  properties: {
    contacts: { type: 'array', maxItems: 20, items: { type: 'object', properties: {}, additionalProperties: true } },
    stages: { type: 'object', properties: {}, additionalProperties: true },
    exports: { type: 'object', properties: {}, additionalProperties: true },
    draft: { type: 'object', properties: {}, additionalProperties: true },
    versions: { type: 'object', properties: {}, additionalProperties: true }
  }
};

function createChannelRegistration({ domain }) {
  if (!isPlainObject(domain)) throw channelError('validation', 'domain (trusted factory config) is required');
  const { db, metaRoot, exportRoot, clock, profileGrants, trustedRecords } = domain;
  if (!db || typeof db.prepare !== 'function') throw channelError('validation', 'domain.db (trusted SQLite handle) is required');
  if (typeof metaRoot !== 'string' || metaRoot.trim() === '') throw channelError('validation', 'domain.metaRoot is required');
  if (typeof exportRoot !== 'string' || exportRoot.trim() === '') throw channelError('validation', 'domain.exportRoot is required');
  // profile authority: factory/runner-injected grants. `internal-full` is NEVER granted by default;
  // a payload can only ever select a subset of what the trusted configuration already allows.
  if (profileGrants !== undefined && profileGrants !== null && typeof profileGrants !== 'function' && !isPlainObject(profileGrants)) {
    throw channelError('validation', 'domain.profileGrants must be a plain object or a resolver function');
  }
  if (isPlainObject(profileGrants)) {
    for (const key of Object.keys(profileGrants)) {
      if (!PROFILES.includes(key)) throw channelError('validation', `profileGrants.${key} is not a known profile`);
      if (typeof profileGrants[key] !== 'boolean') throw channelError('validation', `profileGrants.${key} must be a boolean`);
    }
  }
  // trusted record resolver: pre-existing verification receipts / business records / occurred
  // events. Payload fields are never an authorization source.
  if (trustedRecords !== undefined && trustedRecords !== null && !isPlainObject(trustedRecords)) {
    throw channelError('validation', 'domain.trustedRecords must be a plain object');
  }
  if (isPlainObject(trustedRecords)) {
    for (const key of Object.keys(trustedRecords)) {
      if (!['verifications', 'deals', 'events'].includes(key)) throw channelError('validation', `trustedRecords.${key} is not a known record list`);
      if (!Array.isArray(trustedRecords[key])) throw channelError('validation', `trustedRecords.${key} must be an array`);
      for (const entry of trustedRecords[key]) {
        if (!isPlainObject(entry) || typeof entry.recordId !== 'string' || entry.recordId.trim() === '') {
          throw channelError('validation', `trustedRecords.${key}[] entries need a non-empty recordId`);
        }
      }
    }
  }
  const now = typeof clock === 'function' ? clock : () => new Date().toISOString();
  const grants = profileGrants === undefined || profileGrants === null ? {} : profileGrants;
  const trusted = isPlainObject(trustedRecords) ? trustedRecords : {};
  const tool = {
    name: CHANNEL_TOOL_NAME,
    version: CHANNEL_TOOL_VERSION,
    roles: [companies.COMPANY_ROLE],
    kind: 'local',
    inputSchema: CHANNEL_INPUT_SCHEMA,
    outputSchema: CHANNEL_OUTPUT_SCHEMA,
    costPolicy: { kind: 'mock_no_charge', currency: 'USD' }
  };
  async function handler({ input, context }) {
    const ctx = isPlainObject(context) ? context : {};
    const project = typeof ctx.project === 'string' && ctx.project !== '' ? ctx.project : null;
    const market = typeof ctx.market === 'string' && ctx.market !== '' ? ctx.market : null;
    const brand = ctx.brand === null || ctx.brand === undefined ? '' : ctx.brand;
    if (project === null || market === null || typeof brand !== 'string') return { status: 'blocked', reason: 'authority_missing' };
    if (!isPlainObject(input) || !isPlainObject(input.scope)) return { status: 'blocked', reason: 'scope_missing' };
    if (input.scope.projectId !== project || (input.scope.brand === null || input.scope.brand === undefined ? '' : input.scope.brand) !== brand || input.scope.market !== market) {
      return { status: 'blocked', reason: 'scope_authority_mismatch' };
    }
    const runId = typeof ctx.runId === 'string' && ctx.runId !== '' ? ctx.runId : null;
    if (runId === null) return { status: 'blocked', reason: 'run_id_missing' };
    const leadId = input.lead.leadId;
    const lead = db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(project, leadId);
    if (!lead) return { status: 'blocked', reason: 'lead_not_found' };

    // ---------- preflight: every decidable refusal happens BEFORE any state or file write ----------
    let builtContacts;
    try {
      builtContacts = input.contacts.map((raw) => companies.buildContactRecord({ ...raw, projectId: project, brand, market, leadId }));
      for (const record of builtContacts) companies.assertContactEvidence(db, project, record);
    } catch (error) {
      if (error instanceof companies.CompanyError) return { status: 'blocked', reason: `invalid_input:${error.code}` };
      throw error;
    }
    // verifications: only PRE-EXISTING trusted receipts may bind; payload strings never authorize
    const verificationRows = [];
    for (const raw of Array.isArray(input.verifications) ? input.verifications : []) {
      const target = builtContacts[raw.contactIndex];
      if (!target) return { status: 'blocked', reason: 'invalid_input:verification_contact_index' };
      if (typeof raw.verificationId !== 'string' || raw.verificationId.trim() === '') {
        return { status: 'blocked', reason: 'verification_not_authorized:missing_record_id' };
      }
      const trustedRecord = companies.resolveTrustedRecord(trusted, 'verification', raw.verificationId.trim());
      const bound = companies.bindTrustedVerificationRecord({ trusted: trustedRecord, contact: target, projectId: project, brand, market, leadId });
      if (!bound.ok) return { status: 'blocked', reason: `verification_not_authorized:${bound.code}` };
      verificationRows.push(bound.record);
    }
    // contacts batch plan (reuse / supersede + insert) — no writes yet
    const contactPlan = companies.planContactWrites(db, project, { contacts: builtContacts, leadId, brand, market, clock: now });
    // an export-only request (contacts: []) still delivers the PERSISTED contacts of this exact
    // scope; contacts from other brands/markets are never merged in
    const mergedProspective = [...contactPlan.prospective];
    for (const stored of companies.listContacts(db, project, leadId, { brand, market })) {
      if (!mergedProspective.some((entry) => entry.contactId === stored.contactId)) mergedProspective.push(stored);
    }
    // events: plan the whole batch in order against a simulated state (trusted records only)
    const eventRows = [];
    let state = companies.readSalesState(db, project, leadId, { brand, market });
    for (const event of Array.isArray(input.events) ? input.events : []) {
      const planned = companies.planSalesTransition({ db, projectId: project, leadId, brand, market, lead, state, event, trustedRecords: trusted, clock: now });
      if (!planned.ok) return { status: 'blocked', reason: `event_refused:${planned.code}` };
      eventRows.push(companies.planSalesEventWrite({ projectId: project, leadId, value: planned.value, clock: now }));
      state = planned.nextState;
    }
    // draft (schema + wording) before any effect
    let draft = null;
    if (isPlainObject(input.draft)) {
      try {
        draft = companies.buildOutreachDraft({ ...input.draft, leadName: lead.name });
      } catch (error) {
        if (error instanceof companies.CompanyError) return { status: 'blocked', reason: `invalid_input:${error.code}` };
        throw error;
      }
    }
    // profile authority: the request may only select a subset of the trusted grants.
    // A resolver function is authoritative for EVERY profile (a false result is an explicit deny,
    // never a "default allow"); an object grant denies a non-internal profile only when the key is
    // explicitly false (an unconfigured external profile follows the documented default: allowed).
    // internal-full always requires an explicit true.
    const exportProfiles = Array.isArray(input.exportProfiles) ? input.exportProfiles : [];
    for (const profile of exportProfiles) {
      if (!PROFILES.includes(profile)) return { status: 'blocked', reason: 'export_profile_not_allowed' };
      if (typeof grants === 'function') {
        const granted = grants({ projectId: project, brand, market, profile }) === true;
        if (granted !== true) return { status: 'blocked', reason: 'profile_not_authorized' };
        continue;
      }
      if (profile === 'internal-full') {
        if (grants[profile] !== true) return { status: 'blocked', reason: 'profile_not_authorized' };
        continue;
      }
      if (isPlainObject(grants) && grants[profile] === false) return { status: 'blocked', reason: 'profile_not_authorized' };
    }
    // rows + export preparation (conflicts checked, content built in memory — nothing published yet)
    const scopedVerifications = [...companies.listContactVerifications(db, project, leadId, { brand, market }), ...verificationRows];
    const classifiedContacts = mergedProspective.map((record) => ({ ...record, ...companies.classifyContactLevel(record, scopedVerifications, { asOf: now() }) }));
    const privateValues = mergedProspective.filter((record) => record.valuePresent).map((record) => record.value);
    const rows = buildChannelExportRows({ lead, contacts: classifiedContacts, salesState: state, license: input.license });
    const prepared = [];
    for (const profile of exportProfiles) {
      for (const format of CHANNEL_EXPORT_FORMATS) {
        prepared.push(await prepareChannelExport({ exportRoot, runId, profile, format, rows, privateValues, clock: now }));
      }
    }

    // ---------- commit: business batch atomically, then publish the prepared artifacts ----------
    companies.commitLeadBatch(db, project, {
      supersedes: contactPlan.supersedes,
      rows: [
        ...contactPlan.rows,
        ...verificationRows.map((record) => companies.planVerificationWrite({ projectId: project, leadId, record, clock: now })),
        ...eventRows
      ]
    });
    const exportsOut = {};
    for (const item of prepared) {
      const committed = commitPreparedExport(item, { clock: now });
      exportsOut[item.profile] = exportsOut[item.profile] || {};
      exportsOut[item.profile][item.format] = { path: committed.path, sha256: committed.sha256, reused: committed.reused };
    }
    let draftOut = null;
    if (draft !== null) {
      const written = companies.writeOutreachDraft({ metaRoot, runId, projectId: project, brand, market, draft, clock: now });
      draftOut = { path: written.path, sha256: written.sha256, status: 'draft', sent: false };
    }
    const output = {
      contacts: classifiedContacts.map((contact) => ({
        contactId: contact.contactId,
        contactType: contact.contactType,
        level: contact.level,
        levelReason: contact.reason,
        sourceUrl: contact.sourceUrl,
        sourceKind: contact.sourceKind,
        observedAt: contact.timeKnown ? contact.observedAt : null,
        timeKnown: contact.timeKnown,
        evidenceRef: contact.evidenceRef,
        version: contact.version
      })),
      stages: { stage: state.stage, version: state.version, terminal: state.terminal, eventCount: eventRows.length, reason: state.reason },
      exports: exportsOut,
      versions: { schemaVersion: CHANNEL_EXPORT_SCHEMA_VERSION, exportPolicyId: CHANNEL_EXPORT_POLICY.schemaId, profileIds: exportProfiles.slice() }
    };
    if (draftOut !== null) output.draft = draftOut;
    return { status: 'succeeded', output };
  }
  return { tool, handler };
}

function registerChannelHandler(registry, registration) {
  registry.register(registration.tool, registration.handler);
  return registry.get(registration.tool.name);
}

module.exports = {
  CHANNEL_EXPORT_SCHEMA_VERSION,
  CHANNEL_TOOL_NAME,
  CHANNEL_TOOL_VERSION,
  CHANNEL_SHEET_NAME,
  CHANNEL_EXPORT_FORMATS,
  CHANNEL_EXPORT_POLICY,
  CHANNEL_EXPORT_COLUMNS,
  ChannelExportError,
  channelError,
  sanitizeExportCell,
  buildPrivateVariants,
  sanitizeExternalText,
  safeExternalUrl,
  projectExternalRows,
  buildChannelExportRows,
  serializeChannelCsv,
  parseChannelCsv,
  readBackChannelCsv,
  readBackChannelWorkbook,
  assertNoCanaryLeak,
  prepareChannelExport,
  commitPreparedExport,
  writeChannelExport,
  createChannelRegistration,
  registerChannelHandler
};
