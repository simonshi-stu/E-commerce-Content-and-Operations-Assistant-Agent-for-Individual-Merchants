'use strict';
/**
 * T1.7 — raw supplier-material import tests (real bytes only; synthetic fixtures generated under
 * $COMMERCE_TEST_TMP; no real outbound calls / fees / credential values / OCR engines).
 *
 * Groups (single run):
 *  1 representative : Chinese text PDF + CSV + XLSX real bytes -> located candidates -> explicit
 *                     confirm -> versioned correction -> SQLite close/reopen readback
 *  2 identity       : replay idempotency, cross-supplier/project isolation, parserVersion lineage
 *  3 risks          : ¥ ambiguity, missing unit/currency/incoterm, H0 != HO, conflict never auto-fact
 *  4 scan protocol  : scanned PDF (DCT JPEG + Flate-gray->PNG + JPX unsupported) + standalone PNG,
 *                     fixture-injected S1 vision contract, invalid/pending pages, default closed, manual entry
 *  5 migration 0011 : up/down/re-up + with-data backup/restore + fingerprint binding
 *
 * When COMMERCE_T17_IMPORTS_DIR is set the run also writes the task outputs there:
 * import-report.json, samples/localization-samples.json, fixture/imports-fixture.db(+backup).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const ExcelJS = require('exceljs');

const W = path.join(__dirname, '..', '..');
const { openDb, migrateUp, migrateDown, backupTo, verifyDatabaseFile } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m3 = require(path.join(W, 'lib', 'commerce', 'migrations', '0003_evidence_observation.js'));
const m11 = require(path.join(W, 'lib', 'commerce', 'migrations', '0011_imports.js'));
const evidence = require(path.join(W, 'lib', 'commerce', 'evidence.js'));
const imports = require(path.join(W, 'lib', 'commerce', 'imports.js'));
const fields = require(path.join(W, 'lib', 'commerce', 'imports', 'fields.js'));
const pdfUtil = require(path.join(W, 'lib', 'commerce', 'imports', 'pdf-util.js'));
const extractScan = require(path.join(W, 'lib', 'commerce', 'imports', 'extract-scan.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const OUT_DIR = process.env.COMMERCE_T17_IMPORTS_DIR ?? null;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.7 tests write only to the private runtime tmp';

const PROJECT = 'proj-t17-main';
const PROJECT_B = 'proj-t17-other';
const T_OBS = '2026-10-01T00:00:00.000Z';
const T_OBS2 = '2026-10-03T00:00:00.000Z';
const T_APPROVE = '2026-10-02T00:00:00.000Z';
const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// real, structurally valid 1x1 JPEG (SOI/SOF/EOI verified); synthetic test pixel
const JPEG_1X1 = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

// ---------- run environment ----------

const RUN_DIR = TMP_ROOT ? fs.mkdtempSync(path.join(TMP_ROOT, 't17-run-')) : null;
const FIX_DIR = RUN_DIR ? path.join(RUN_DIR, 'fixtures') : null;
const ctx = { db: null, dbPath: null };

if (TMP_ROOT) {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  if (OUT_DIR) {
    fs.mkdirSync(path.join(OUT_DIR, 'fixture'), { recursive: true });
    fs.mkdirSync(path.join(OUT_DIR, 'samples'), { recursive: true });
    ctx.dbPath = path.join(OUT_DIR, 'fixture', 'imports-fixture.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${ctx.dbPath}${suffix}`;
      if (fs.existsSync(target)) fs.rmSync(target);
    }
  } else {
    ctx.dbPath = path.join(RUN_DIR, 'imports-fixture.db');
  }
  ctx.db = openDb(ctx.dbPath);
  migrateUp(ctx.db, [core, m3, m11]);
}
function reopenMain() {
  ctx.db.close();
  ctx.db = openDb(ctx.dbPath);
}

// ---------- fixture generators (real bytes; deterministic where practical) ----------

function utf16beHex(text) {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let index = 0; index + 1 < le.length; index += 2) { be[index] = le[index + 1]; be[index + 1] = le[index]; }
  return `FEFF${be.toString('hex').toUpperCase()}`;
}
/** Serialize {num, buffer()} objects with a real xref table and trailer. */
function serializePdf(objects, physicalOrder) {
  const byNum = new Map(objects.map((object) => [object.num, object]));
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = new Map();
  for (const num of physicalOrder) {
    const buffer = byNum.get(num).buffer();
    offsets.set(num, offset);
    chunks.push(buffer);
    offset += buffer.length;
  }
  const xrefOffset = offset;
  const maxNum = Math.max(...objects.map((object) => object.num));
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxNum; num += 1) {
    xref += `${(offsets.get(num) ?? 0).toString().padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
function textObject(num, body) {
  return { num, buffer: () => Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1') };
}
/** Minimal valid text PDF: each page's lines as UTF-16BE hex text runs (real bytes on disk). */
function buildTextPdf(pagesLines, options = {}) {
  const pageCount = pagesLines.length;
  const fontNum = 3 + pageCount * 2;
  const objects = [
    textObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    textObject(2, `<< /Type /Pages /Kids [${pagesLines.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`)
  ];
  pagesLines.forEach((lines, index) => {
    const pageNum = 3 + index * 2;
    const contentNum = pageNum + 1;
    objects.push(textObject(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`));
    const content = lines.map((line) => `BT <${utf16beHex(line)}> Tj ET`).join('\n');
    objects.push(textObject(contentNum, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`));
  });
  objects.push(textObject(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const physicalOrder = options.physicalOrder ?? objects.map((object) => object.num);
  return serializePdf(objects, physicalOrder);
}
function imageObject(num, dict, rawBytes) {
  return { num, buffer: () => Buffer.concat([Buffer.from(`${num} 0 obj\n${dict}\nstream\n`, 'latin1'), rawBytes, Buffer.from('\nendstream\nendobj\n', 'latin1')]) };
}
/** Minimal scanned-style PDF with embedded REAL images (none/text streams only when requested).
 * Page spec: { image: 'jpeg'|'gray'|'jpx'|'none' } or { images: ['jpeg','gray'] } for multiple
 * images on ONE page (never collapsed). */
function buildScannedPdf(pages) {
  const pageCount = pages.length;
  const objects = [
    textObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    textObject(2, `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`)
  ];
  let nextImageNum = 3 + pageCount * 2;
  pages.forEach((spec, index) => {
    const pageNum = 3 + index * 2;
    const contentNum = pageNum + 1;
    const requested = Array.isArray(spec.images) ? spec.images : (spec.image && spec.image !== 'none' ? [spec.image] : []);
    let resources = '<< >>';
    if (requested.length > 0) {
      const xobjects = requested.map((kind) => {
        const imageNum = nextImageNum;
        nextImageNum += 1;
        if (kind === 'jpeg') {
          objects.push(imageObject(imageNum, `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${JPEG_1X1.length} >>`, JPEG_1X1));
        } else if (kind === 'gray') {
          const width = spec.width ?? 8;
          const height = spec.height ?? 8;
          const samples = Buffer.alloc(width * height);
          for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) samples[y * width + x] = (x * 16 + y * 3) % 256;
          const streamBytes = zlib.deflateSync(samples);
          objects.push(imageObject(imageNum, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${streamBytes.length} >>`, streamBytes));
        } else if (kind === 'jpx') {
          objects.push(imageObject(imageNum, '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode /Length 8 >>', Buffer.from('JPXDATA!', 'latin1')));
        }
        return imageNum;
      });
      resources = `<< /XObject << ${xobjects.map((num, i) => `/Im${i + 1} ${num} 0 R`).join(' ')} >> >>`;
    }
    objects.push(textObject(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${contentNum} 0 R >>`));
    objects.push(textObject(contentNum, '<< /Length 0 >>\nstream\n\nendstream'));
  });
  return serializePdf(objects, objects.map((object) => object.num));
}
function writeFile(name, buffer) {
  const filePath = path.join(FIX_DIR, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
async function writeXlsx(name, header, rows) {
  const filePath = path.join(FIX_DIR, name);
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date('2026-10-01T00:00:00.000Z');
  workbook.modified = new Date('2026-10-01T00:00:00.000Z');
  const sheet = workbook.addWorksheet('报价表');
  sheet.addRow(header);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}
function quoted(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function writeCsv(name, rows) {
  return writeFile(name, Buffer.from(rows.map((row) => row.map(quoted).join(',')).join('\r\n'), 'utf8'));
}

// ---------- 1. representative ----------

test('T1.7 representative: text PDF + Chinese table real bytes -> located candidates -> confirm/correct -> reopen readback', { skip }, async () => {
  const pdfPath = writeFile('catalog-zh.pdf', buildTextPdf([
    ['供应商资料 2026 中文表', 'H0 灯型A 出厂价 40元/套 FOB 深圳', '数量：100件'],
    ['HO 灯型B 出厂价 ¥45 FOB 深圳', '本页价格已确认 仅供参考']
  ]));
  const pdfBytes = fs.readFileSync(pdfPath);
  const supplier = 'sup-pdf';
  const result = imports.importPdfText(ctx.db, PROJECT, { filePath: pdfPath, supplierKey: supplier });
  assert.equal(result.status, 'imported');
  assert.equal(result.extraction.rawSha256, sha256Of(pdfBytes), 'source sha256 must be of the real bytes');
  assert.equal(result.extraction.localization.status, 'page_tree_verified');
  assert.ok(result.extraction.pages[0].textPreview.includes('H0 灯型A 出厂价 40元/套 FOB 深圳'), 'actual extracted segment on page 1');
  assert.ok(result.extraction.pages[1].textPreview.includes('HO 灯型B 出厂价 ¥45 FOB 深圳'), 'actual extracted segment on page 2');
  // no auto-confirmation from document words like "已确认"
  assert.equal(result.candidates.filter((row) => row.status === 'confirmed').length, 0, 'user words inside the material are not an approval');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE project_id = ?').get(PROJECT).n, 0);
  const priceCandidate = result.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'H0|灯型=A' && row.supplier_key === supplier);
  assert.ok(priceCandidate, 'H0 purchase-cost candidate exists');
  assert.equal(priceCandidate.page_number, 1, 'real page localization (page 1)');
  assert.equal(priceCandidate.numeric_value, 40);
  assert.equal(priceCandidate.currency, 'CNY');
  assert.equal(priceCandidate.unit, '套');
  assert.equal(priceCandidate.incoterm, 'FOB');
  assert.equal(priceCandidate.reasons, null, 'fully specified candidate (no unresolved reasons)');
  const ambiguous = result.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'HO|灯型=B');
  assert.equal(ambiguous.page_number, 2, 'real page localization (page 2)');
  assert.equal(ambiguous.currency, null, '¥ symbol is never assumed to be CNY');
  assert.match(ambiguous.reasons, /currency_ambiguous_yuan_yen/);
  const quantity = result.candidates.find((row) => row.field_key === 'quantity');
  assert.equal(quantity.numeric_value, 100);
  assert.equal(quantity.unit, '件');
  // confirm requires an explicit strict observedAt (observed time unknown stays unknown)
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: priceCandidate.candidate_id }), /observedAt is required/);
  const confirmed = imports.confirmCandidate(ctx.db, PROJECT, { candidateId: priceCandidate.candidate_id, observedAt: T_OBS, now: T_APPROVE });
  assert.equal(confirmed.observation.origin_type, 'seller_statement');
  assert.equal(confirmed.observation.approval_status, 'user_confirmed');
  assert.equal(confirmed.observation.unit, '套');
  assert.equal(confirmed.observation.value_text, '40');
  assert.throws(() => evidence.setObservationApproval(ctx.db, PROJECT, confirmed.observation.id, 'rejected', { now: T_APPROVE }), /cannot change/);
  // versioned correction of a confirmed candidate
  assert.throws(() => imports.correctCandidate(ctx.db, PROJECT, { candidateId: priceCandidate.candidate_id, correctedValue: '41.5' }), /observedAt is required/);
  const corrected = imports.correctCandidate(ctx.db, PROJECT, { candidateId: priceCandidate.candidate_id, correctedValue: '41.5', note: 'supplier sent an updated sheet', observedAt: T_OBS2, now: T_OBS2 });
  assert.equal(corrected.old.status, 'superseded');
  assert.equal(corrected.old.snippet, priceCandidate.snippet, 'original supplier snippet never rewritten');
  assert.equal(corrected.candidate.status, 'confirmed');
  assert.equal(corrected.candidate.method, 'user_correction');
  assert.equal(corrected.candidate.supersedes_candidate_id, priceCandidate.candidate_id);
  assert.equal(corrected.correction.old_value, priceCandidate.raw_value);
  assert.equal(corrected.observation.origin_type, 'user_statement');
  assert.equal(corrected.observation.approval_status, 'user_confirmed');
  const oldObservation = evidence.getObservation(ctx.db, PROJECT, confirmed.observation.id);
  assert.ok(oldObservation.superseded_by, 'old observation preserved and linked');
  assert.equal(oldObservation.origin_type, 'seller_statement');
  const chain = evidence.getObservationChain(ctx.db, PROJECT, corrected.observation.id);
  assert.equal(chain.length, 2, 'correction keeps the full supersede chain');
  // Chinese CSV (real bytes) + XLSX (ExcelJS real file)
  const csvPath = writeCsv('supplier-zh.csv', [
    ['型号', '灯型', '出厂价', '币种', '单位', '条款', '数量'],
    ['H0', '灯型A', '40', 'CNY', '套', 'FOB', '100'],
    ['GL-12', '双灯', '12.5', 'USD', 'pcs', 'EXW', '50']
  ]);
  const csvResult = await imports.importTable(ctx.db, PROJECT, { filePath: csvPath, supplierKey: 'sup-csv' });
  assert.equal(csvResult.status, 'imported');
  assert.equal(csvResult.extraction.rawSha256, sha256Of(fs.readFileSync(csvPath)));
  const csvPrice = csvResult.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'GL-12|灯型=双灯');
  assert.equal(csvPrice.numeric_value, 12.5);
  assert.equal(csvPrice.currency, 'USD');
  assert.equal(csvPrice.unit, 'pcs');
  assert.equal(csvPrice.incoterm, 'EXW');
  assert.equal(csvPrice.sheet, 'csv');
  assert.equal(csvPrice.row_number, 3);
  assert.equal(csvPrice.column_ref, 'C');
  assert.equal(csvPrice.reasons, null);
  const xlsxPath = await writeXlsx('supplier-zh.xlsx', ['型号', '灯型', '出厂价', '币种', '单位', '条款', '数量'], [
    ['H0', '灯型A', 40, 'CNY', '套', 'FOB', 100]
  ]);
  const xlsxResult = await imports.importTable(ctx.db, PROJECT, { filePath: xlsxPath, supplierKey: 'sup-xlsx' });
  assert.equal(xlsxResult.status, 'imported');
  const xlsxPrice = xlsxResult.candidates.find((row) => row.field_key === 'purchase_cost');
  assert.equal(xlsxPrice.numeric_value, 40);
  assert.equal(xlsxPrice.sheet, '报价表');
  assert.equal(xlsxPrice.row_number, 2);
  assert.equal(xlsxPrice.column_ref, 'C');
  // F2 rev-01: strict correction validation, atomic writes, fresh version identity
  const revGapPath = writeCsv('rev-gap.csv', [['型号', '配置', '价格', '币种', '单位', '条款'], ['SOL-05', 'red', '40', '', 'pcs', '']]);
  const revGap = await imports.importTable(ctx.db, PROJECT, { filePath: revGapPath, supplierKey: 'sup-f2' });
  const revGapCost = revGap.candidates.find((row) => row.field_key === 'purchase_cost');
  const degradedCorrection = imports.correctCandidate(ctx.db, PROJECT, { candidateId: revGapCost.candidate_id, correctedValue: '41suffix', observedAt: T_OBS, now: T_OBS });
  assert.equal(degradedCorrection.candidate.numeric_value, null, 'trailing garbage never becomes a number');
  assert.match(degradedCorrection.candidate.reasons, /unparsed_amount/);
  assert.match(degradedCorrection.candidate.reasons, /missing_currency/);
  assert.match(degradedCorrection.candidate.reasons, /missing_incoterm/);
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: degradedCorrection.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/, 'a gap candidate can never be forced into a legal observation');
  const snapshotTables = () => Object.fromEntries(['import_documents', 'import_candidates', 'import_corrections', 'observations'].map((table) => [table, ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const revAtomicPath = writeCsv('rev-atomic.csv', [['型号', '价格', '币种', '单位', '条款'], ['SOL-06', '40', 'USD', 'pcs', 'EXW']]);
  const revAtomic = await imports.importTable(ctx.db, PROJECT, { filePath: revAtomicPath, supplierKey: 'sup-f2' });
  const revAtomicCost = revAtomic.candidates.find((row) => row.field_key === 'purchase_cost');
  const beforeInvalidTime = snapshotTables();
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: revAtomicCost.candidate_id, observedAt: T_OBS, now: 'not-a-time' }), /strict ISO instant/);
  assert.deepEqual(snapshotTables(), beforeInvalidTime, 'an invalid approval time leaves every table unchanged');
  ctx.db.exec("CREATE TEMP TRIGGER rev_abort_obs BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT, 'synthetic injected interruption'); END;");
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: revAtomicCost.candidate_id, observedAt: T_OBS, now: T_OBS }), /synthetic injected interruption/);
  ctx.db.exec('DROP TRIGGER rev_abort_obs');
  assert.deepEqual(snapshotTables(), beforeInvalidTime, 'a mid-confirmation DB failure rolls the whole item back');
  imports.confirmCandidate(ctx.db, PROJECT, { candidateId: revAtomicCost.candidate_id, observedAt: T_OBS, now: T_OBS });
  const beforeFailedCorrection = snapshotTables();
  ctx.db.exec("CREATE TEMP TRIGGER rev_abort_cand BEFORE INSERT ON import_candidates BEGIN SELECT RAISE(ABORT, 'synthetic injected interruption'); END;");
  assert.throws(() => imports.correctCandidate(ctx.db, PROJECT, { candidateId: revAtomicCost.candidate_id, correctedValue: '42', observedAt: T_OBS2, now: T_OBS2 }), /synthetic injected interruption/);
  ctx.db.exec('DROP TRIGGER rev_abort_cand');
  assert.deepEqual(snapshotTables(), beforeFailedCorrection, 'a mid-correction DB failure leaves candidate/correction/observation untouched');
  assert.throws(() => imports.correctCandidate(ctx.db, PROJECT, { candidateId: revAtomicCost.candidate_id, correctedValue: '42', observedAt: 'not-a-time', now: T_OBS2 }), /strict ISO instant/);
  assert.deepEqual(snapshotTables(), beforeFailedCorrection, 'an invalid correction time leaves every table unchanged');
  // every accepted correction publishes a fresh version, even when the value returns to an old one
  const revLineagePath = writeCsv('rev-lineage.csv', [['型号', '价格', '币种', '单位', '条款'], ['SOL-08', '40', 'USD', 'pcs', 'EXW']]);
  const revLineage = await imports.importTable(ctx.db, PROJECT, { filePath: revLineagePath, supplierKey: 'sup-f2' });
  const revLineageCost = revLineage.candidates.find((row) => row.field_key === 'purchase_cost');
  const version1 = imports.correctCandidate(ctx.db, PROJECT, { candidateId: revLineageCost.candidate_id, correctedValue: '41', observedAt: T_OBS, now: T_OBS });
  const version2 = imports.correctCandidate(ctx.db, PROJECT, { candidateId: version1.candidate.candidate_id, correctedValue: '42', observedAt: T_OBS, now: T_OBS });
  const version3 = imports.correctCandidate(ctx.db, PROJECT, { candidateId: version2.candidate.candidate_id, correctedValue: '41', observedAt: T_OBS, now: T_OBS });
  assert.notEqual(version3.candidate.candidate_id, version1.candidate.candidate_id, 'returning to an old value is a NEW version, not a revival');
  assert.equal(version3.candidate.supersedes_candidate_id, version2.candidate.candidate_id);
  assert.equal(version1.candidate.supersedes_candidate_id, revLineageCost.candidate_id);
  // physical order != page tree: adapter follows the tree (page numbers stay real)
  const swappedPath = writeFile('catalog-zh-swapped.pdf', buildTextPdf(
    [['供应商附加资料 中文表格 参数明细 列表', '第一页 H0 出厂价 40元/套 FOB 深圳'], ['供应商附加资料 中文表格 参数明细 列表', '第二页 HO 出厂价 ¥45 FOB 深圳']],
    { physicalOrder: [1, 2, 5, 6, 3, 4, 7] }
  ));
  const swapped = imports.importPdfText(ctx.db, PROJECT, { filePath: swappedPath, supplierKey: 'sup-swap' });
  assert.equal(swapped.extraction.localization.status, 'page_tree_order_differs');
  const swappedPageTwo = swapped.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'HO');
  assert.equal(swappedPageTwo.page_number, 2, 'page number follows the page tree, not physical object order');
  // SQLite close/reopen readback (not an in-memory map)
  reopenMain();
  const readback = ctx.db.prepare('SELECT COUNT(*) AS n FROM import_candidates WHERE project_id = ?').get(PROJECT).n;
  assert.ok(readback >= 15, `candidates persisted (${readback})`);
  const readbackCorrections = imports.listCorrections(ctx.db, PROJECT);
  assert.ok(readbackCorrections.some((row) => row.new_value === '41.5'), 'the explicit correction survived the reopen');
  const readbackCandidate = imports.getCandidate(ctx.db, PROJECT, corrected.candidate.candidate_id);
  assert.equal(readbackCandidate.status, 'confirmed');
  assert.equal(imports.getCandidate(ctx.db, PROJECT, priceCandidate.candidate_id).status, 'superseded');
  assert.equal(imports.getCandidate(ctx.db, PROJECT, revAtomicCost.candidate_id).status, 'confirmed', 'failed corrections left the confirmed candidate untouched');
  assert.equal(imports.getCandidate(ctx.db, PROJECT, version1.candidate.candidate_id).status, 'superseded');
  assert.equal(imports.getCandidate(ctx.db, PROJECT, version3.candidate.candidate_id).status, 'candidate');
});

// ---------- 2. identity ----------

test('T1.7 identity: replay idempotency, cross-supplier/project isolation, parserVersion lineage', { skip }, async () => {
  const csvPath = writeCsv('identity.csv', [['型号', '出厂价', '币种', '单位', '条款'], ['H0', '40', 'CNY', '套', 'FOB']]);
  const first = await imports.importTable(ctx.db, PROJECT, { filePath: csvPath, supplierKey: 'sup-id-a' });
  assert.equal(first.status, 'imported');
  const firstCounts = first.counts;
  const replay = await imports.importTable(ctx.db, PROJECT, { filePath: csvPath, supplierKey: 'sup-id-a' });
  assert.equal(replay.status, 'deduplicated', 'same (project, supplier, parserVersion, rawHash) is a replay');
  assert.equal(replay.document.document_id, first.document.document_id);
  assert.equal(replay.candidates.length, first.candidates.length, 'replay never grows records');
  // same bytes, different supplier: isolated candidates, no merge; evidence dedup stays per project
  const otherSupplier = await imports.importTable(ctx.db, PROJECT, { filePath: csvPath, supplierKey: 'sup-id-b' });
  assert.equal(otherSupplier.status, 'imported');
  assert.notEqual(otherSupplier.document.document_id, first.document.document_id);
  const supplierRows = ctx.db.prepare("SELECT supplier_key, COUNT(*) AS n FROM import_candidates WHERE project_id = ? AND document_id IN (?, ?) GROUP BY supplier_key").all(PROJECT, first.document.document_id, otherSupplier.document.document_id);
  assert.equal(supplierRows.length, 2, 'candidates stay per supplier');
  const evidenceRows = ctx.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE project_id = ? AND sha256 = ?').get(PROJECT, first.document.raw_sha256).n;
  assert.equal(evidenceRows, 1, 'evidence byte-hash dedup is content-level, not a candidate merge');
  // cross-project isolation
  const otherProject = await imports.importTable(ctx.db, PROJECT_B, { filePath: csvPath, supplierKey: 'sup-id-a' });
  assert.equal(otherProject.status, 'imported');
  assert.notEqual(otherProject.document.document_id, first.document.document_id);
  assert.equal(imports.listCandidates(ctx.db, PROJECT, { supplierKey: 'sup-id-b' }).length, otherSupplier.candidates.length);
  // parserVersion lineage: a new parser version parses again but never overwrites history
  const v2 = await imports.importTable(ctx.db, PROJECT, { filePath: csvPath, supplierKey: 'sup-id-a', parserVersion: 'imports/csv@v2-fixture' });
  assert.equal(v2.status, 'imported');
  assert.notEqual(v2.document.document_id, first.document.document_id);
  const lineage = ctx.db.prepare('SELECT parser_version, COUNT(*) AS n FROM import_documents WHERE project_id = ? AND supplier_key = ? AND raw_sha256 = ? GROUP BY parser_version').all(PROJECT, 'sup-id-a', first.document.raw_sha256);
  assert.equal(lineage.length, 2, 'old and new parser versions keep their own document lineage');
  assert.equal(imports.getDocument(ctx.db, PROJECT, first.document.document_id).parser_version, first.document.parser_version, 'v1 document untouched');
  const v2Replay = await imports.importTable(ctx.db, PROJECT, { filePath: csvPath, supplierKey: 'sup-id-a', parserVersion: 'imports/csv@v2-fixture' });
  assert.equal(v2Replay.status, 'deduplicated');
  reopenMain();
  assert.equal(imports.getDocument(ctx.db, PROJECT, first.document.document_id).document_id, first.document.document_id, 'readback after reopen');
});

// ---------- 3. risks ----------

test('T1.7 risks: ¥ ambiguity, missing pieces, H0 != HO, conflict never auto-fact', { skip }, async () => {
  assert.equal(fields.modelIdentity('H0') === fields.modelIdentity('HO'), false, 'case-exact model identity');
  // F1 rev-01: contradictory explicit currency cues stay conflicting with the original snippet
  const contradictoryLine = 'SOL-02 出厂价 $40 CNY/pcs FOB';
  const contradictory = fields.detectLineFields(contradictoryLine).find((row) => row.fieldKey === 'purchase_cost');
  assert.equal(contradictory.currency, null, 'contradictory cues are never silently chosen');
  assert.ok(contradictory.reasons.includes('currency_conflict'));
  assert.equal(contradictory.unit, 'pcs');
  assert.equal(contradictory.incoterm, 'FOB');
  assert.ok(contradictoryLine.includes(contradictory.snippet), 'the conflicting snippet is preserved');
  // configuration identity binds quote subjects; different configurations are not a contradiction
  const variantsPath = writeCsv('rev-variants.csv', [['型号', '配置', '价格', '币种', '单位', '条款'], ['SOL-03', 'red', '12', 'USD', 'pcs', 'EXW'], ['SOL-03', 'blue', '15', 'USD', 'pcs', 'EXW']]);
  const variants = await imports.importTable(ctx.db, PROJECT, { filePath: variantsPath, supplierKey: 'sup-f1' });
  const variantCosts = variants.candidates.filter((row) => row.field_key === 'purchase_cost');
  assert.equal(new Set(variantCosts.map((row) => row.subject_key)).size, 2, 'config identity is part of the quote subject');
  assert.ok(variantCosts.every((row) => !String(row.reasons ?? '').includes('conflict')), 'different configurations are not marked conflicting');
  // repeated mapped columns stay visible and conflict-marked (the second quote is never discarded)
  const dupPath = writeCsv('rev-duplicate.csv', [['型号', '价格', '价格', '币种', '单位', '条款'], ['SOL-04', '12', '20', 'USD', 'pcs', 'EXW']]);
  const dup = await imports.importTable(ctx.db, PROJECT, { filePath: dupPath, supplierKey: 'sup-f1' });
  const dupCosts = dup.candidates.filter((row) => row.field_key === 'purchase_cost');
  assert.equal(dupCosts.length, 2, 'both price columns stay visible');
  assert.deepEqual(dupCosts.map((row) => row.column_ref).sort(), ['B', 'C']);
  assert.deepEqual(dupCosts.map((row) => row.numeric_value).sort((a, b) => a - b), [12, 20]);
  for (const row of dupCosts) assert.match(row.reasons, /conflict/);
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: dupCosts[0].candidate_id, observedAt: T_OBS }), /unresolved conditions/, 'conflicting quotes are never auto-confirmed');
  const cleanPath = writeCsv('risk-clean.csv', [
    ['型号', '灯型', '出厂价', '币种', '单位', '条款', '数量'],
    ['H0', '灯型A', '40', 'CNY', '套', 'FOB', '100'],
    ['HO', '灯型B', '¥45', '', '', 'FOB', ''],
    ['GL-12', '双灯', '40', '', '', '', '']
  ]);
  const clean = await imports.importTable(ctx.db, PROJECT, { filePath: cleanPath, supplierKey: 'sup-risk' });
  const hoPrice = clean.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'HO|灯型=灯型B');
  assert.equal(hoPrice.currency, null, '¥ never guessed to CNY');
  assert.match(hoPrice.reasons, /currency_ambiguous_yuan_yen/);
  assert.match(hoPrice.reasons, /missing_unit/);
  const barePrice = clean.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'GL-12|灯型=双灯');
  assert.equal(barePrice.numeric_value, 40);
  assert.equal(barePrice.currency, null, 'bare number never guessed to USD');
  assert.equal(barePrice.unit, null, 'bare number never guessed to pcs');
  assert.equal(barePrice.incoterm, null, 'no incoterm was ever stated');
  assert.match(barePrice.reasons, /missing_currency/);
  assert.match(barePrice.reasons, /missing_unit/);
  assert.match(barePrice.reasons, /missing_incoterm/);
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: hoPrice.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: barePrice.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const modelRows = clean.candidates.filter((row) => row.field_key === 'model');
  assert.deepEqual(modelRows.map((row) => row.raw_value).sort(), ['GL-12', 'H0', 'HO'], 'H0 and HO stay separate (never merged)');
  const h0Price = clean.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'H0|灯型=灯型A');
  assert.equal(h0Price.reasons, null);
  const correctedNoUnit = imports.correctCandidate(ctx.db, PROJECT, { candidateId: hoPrice.candidate_id, correctedValue: '50', observedAt: T_OBS, now: T_OBS });
  assert.match(correctedNoUnit.candidate.reasons, /missing_unit/, 'an unresolved unit is never erased by a correction');
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: correctedNoUnit.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  // conflict fixture: same model, two distinct prices -> both flagged, neither becomes a fact
  const conflictPath = writeCsv('risk-conflict.csv', [
    ['型号', '出厂价', '币种', '单位', '条款'],
    ['H0', '40', 'CNY', '套', 'FOB'],
    ['H0', '60', 'CNY', '套', 'FOB']
  ]);
  const conflict = await imports.importTable(ctx.db, PROJECT, { filePath: conflictPath, supplierKey: 'sup-conflict' });
  const conflictPrices = conflict.candidates.filter((row) => row.field_key === 'purchase_cost');
  assert.equal(conflictPrices.length, 2, 'conflicting values stay as two rows (no auto-merge)');
  for (const row of conflictPrices) assert.match(row.reasons, /conflict/);
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: conflictPrices[0].candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  assert.ok(conflictPrices.every((row) => row.status === 'candidate' && row.observation_id === null), 'conflicted values are never forced into observations');
  reopenMain();
  assert.ok(conflictPrices.every((row) => imports.getCandidate(ctx.db, PROJECT, row.candidate_id).observation_id === null), 'readback: still no observation for conflicted values');
});

// ---------- 4. scan protocol ----------

test('T1.7 scan: fixture-injected S1 vision contract, invalid/pending -> unknown, default closed, manual entry', { skip }, async () => {
  const scansPath = writeFile('scans.pdf', buildScannedPdf([
    { image: 'jpeg' },
    { image: 'gray', width: 8, height: 8 },
    { image: 'jpx' }
  ]));
  const pngPath = writeFile('standalone.png', pdfUtil.buildPng(8, 8, Buffer.alloc(64, 128), 1));
  // default closed: no fixture transport -> blocked, nothing persisted
  const docsBefore = imports.listDocuments(ctx.db, PROJECT).length;
  const blocked = await imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-sup' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'scan_ocr_unavailable');
  assert.equal(blocked.manualEntryAllowed, true);
  assert.equal(imports.listDocuments(ctx.db, PROJECT).length, docsBefore, 'blocked scan writes nothing');
  // manual entry path stays available and is explicitly user-sourced
  const manual = imports.addManualCandidate(ctx.db, PROJECT, {
    filePath: scansPath, supplierKey: 'scan-sup', fieldKey: 'purchase_cost', rawValue: '40', unit: '套', currency: 'CNY', incoterm: 'FOB', subjectKey: 'H0'
  });
  assert.equal(manual.status, 'imported');
  assert.equal(manual.candidate.method, 'manual_entry');
  assert.equal(manual.candidate.origin_hint, 'user_statement');
  const manualConfirmed = imports.confirmCandidate(ctx.db, PROJECT, { candidateId: manual.candidate.candidate_id, observedAt: T_OBS, now: T_APPROVE });
  assert.equal(manualConfirmed.observation.origin_type, 'user_statement');
  // fixture-injected OCR protocol: real image bytes -> real S1 request -> injected fixture response
  const requests = [];
  const okTransport = async (request) => {
    requests.push(request);
    const lines = requests.length === 1
      ? [{ text: 'H0 出厂价 40元/套 FOB 深圳', x: 0, y: 0, w: 1, h: 1 }, { text: '数量：100件' }]
      : [{ text: 'HO 出厂价 ¥45 FOB 深圳' }];
    return { kind: 'response', httpStatus: 200, body: { id: `scan-remote-${requests.length}`, choices: [{ message: { content: JSON.stringify({ lines }) } }], usage: { prompt_tokens: 2500, completion_tokens: 50 } } };
  };
  const scanned = await imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-ok', fixtureTransport: okTransport });
  assert.equal(scanned.status, 'imported');
  assert.equal(requests.length, 2, 'one bounded OCR call per image page (JPX page unsupported, never called)');
  const body = requests[0].body;
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.messages[0].content.filter((part) => part.type === 'image_url').length, 1, 'exactly one image per request');
  assert.equal(body.messages[0].content.find((part) => part.type === 'image_url').image_url.detail, 'low');
  assert.ok(body.messages[0].content.find((part) => part.type === 'image_url').image_url.url.startsWith('data:image/jpeg;base64,'), 'real page image bytes in the request');
  const pageStatuses = scanned.pages.map((page) => page.status);
  assert.deepEqual(pageStatuses, ['ocr_succeeded', 'ocr_succeeded', 'unsupported'], 'bounded per-page statuses (JPX explicitly unsupported)');
  assert.equal(scanned.pages[2].reason, 'filter_unsupported:JPXDecode');
  const jpegSnippet = scanned.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'H0');
  assert.equal(jpegSnippet.page_number, 1);
  assert.equal(jpegSnippet.image_object, '9', 'real image object reference (catalog=1, pages=2, page pairs 3..8, images from 9)');
  assert.ok(jpegSnippet.image_sha256 && jpegSnippet.image_sha256.length === 64);
  assert.equal(jpegSnippet.region_json, JSON.stringify({ x: 0, y: 0, w: 1, h: 1, unit: 'px' }));
  const pngCandidate = scanned.candidates.find((row) => row.field_key === 'purchase_cost' && row.subject_key === 'HO');
  assert.equal(pngCandidate.page_number, 2, 'Flate-gray page converted to a real PNG and processed');
  // invalid output -> unknown (no candidates), pending -> unknown
  const invalid = await imports.importScan(ctx.db, PROJECT, {
    filePath: scansPath, supplierKey: 'scan-bad', maxPages: 1,
    fixtureTransport: async () => ({ kind: 'response', httpStatus: 200, body: { id: 'x', choices: [{ message: { content: JSON.stringify({ lines: [{ x: 1 }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } })
  });
  assert.equal(invalid.pages[0].status, 'ocr_invalid');
  assert.equal(invalid.candidates.length, 0, 'invalid output stays unknown');
  const pending = await imports.importScan(ctx.db, PROJECT, {
    filePath: scansPath, supplierKey: 'scan-pending', maxPages: 1,
    fixtureTransport: async () => ({ kind: 'response', httpStatus: 202, body: {} })
  });
  assert.equal(pending.pages[0].status, 'ocr_pending');
  assert.equal(pending.candidates.length, 0, 'pending stays unknown');
  // standalone PNG path
  const pngImport = await imports.importScan(ctx.db, PROJECT, { filePath: pngPath, supplierKey: 'scan-png', fixtureTransport: okTransport });
  assert.equal(pngImport.status, 'imported');
  assert.equal(pngImport.pages[0].status, 'ocr_succeeded');
  assert.equal(pngImport.pages[0].page_number, null, 'standalone image has no PDF page number');
  // F3 rev-01: interrupted scans persist nothing; a retry actually processes
  const fixedOcrResponse = () => ({ kind: 'response', httpStatus: 200, body: { id: 'scan-fixed-remote', choices: [{ message: { content: JSON.stringify({ lines: [{ text: 'SOL-R1 出厂价 12 USD/pcs EXW' }] }) } }], usage: { prompt_tokens: 2900, completion_tokens: 60 } } });
  const retryDocsBefore = imports.listDocuments(ctx.db, PROJECT).filter((row) => row.supplier_key === 'scan-retry').length;
  ctx.db.exec("CREATE TEMP TRIGGER rev_abort_scan_candidate BEFORE INSERT ON import_candidates BEGIN SELECT RAISE(ABORT, 'synthetic injected interruption'); END;");
  await assert.rejects(() => imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-retry', maxPages: 1, fixtureTransport: async () => fixedOcrResponse() }), /synthetic injected interruption/);
  ctx.db.exec('DROP TRIGGER rev_abort_scan_candidate');
  assert.equal(imports.listDocuments(ctx.db, PROJECT).filter((row) => row.supplier_key === 'scan-retry').length, retryDocsBefore, 'an interrupted scan import persists nothing');
  let retryCalls = 0;
  const retried = await imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-retry', maxPages: 1, fixtureTransport: async () => { retryCalls += 1; return fixedOcrResponse(); } });
  assert.equal(retried.status, 'partial', 'a bounded call is explicitly partial (1 of 3 images)');
  assert.ok(retried.candidates.length > 0, 'the retry actually processes (no poisoned dedup)');
  assert.ok(retryCalls > 0);
  assert.equal(retried.pages.length, 1);
  assert.equal(retried.coverage.truncated, true);
  const resumed = await imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-retry', maxPages: 3, fixtureTransport: async () => { retryCalls += 1; return fixedOcrResponse(); } });
  assert.equal(resumed.status, 'resumed', 'a larger call resumes the unprocessed images');
  assert.equal(resumed.coverage.imagesFound, 3);
  assert.equal(resumed.coverage.imagesProcessed, 3);
  assert.equal(resumed.coverage.truncated, false);
  assert.equal(resumed.pages.length, 3);
  const callsBeforeCompleteReplay = retryCalls;
  const completeReplay = await imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-retry', maxPages: 1, fixtureTransport: async () => { retryCalls += 1; return fixedOcrResponse(); } });
  assert.equal(completeReplay.status, 'deduplicated', 'only complete coverage dedups');
  assert.equal(retryCalls, callsBeforeCompleteReplay, 'a complete replay does not reprogram the transport');
  assert.equal(imports.listScanPages(ctx.db, PROJECT, retried.document.document_id).length, 3);
  // same-page multiple images never collapse into one status row
  const samePagePath = writeFile('rev-same-page.pdf', buildScannedPdf([{ images: ['jpeg', 'gray'], width: 8, height: 8 }]));
  const samePage = await imports.importScan(ctx.db, PROJECT, { filePath: samePagePath, supplierKey: 'scan-samepage', fixtureTransport: async () => fixedOcrResponse() });
  assert.equal(samePage.pages.length, 2, 'two images on one page stay two rows');
  assert.equal(new Set(samePage.pages.map((row) => row.image_index)).size, 2);
  assert.equal(samePage.pages[0].page_number, 1);
  assert.equal(samePage.pages[1].page_number, 1);
  // pending keeps the structured identity and the exact opaque remote across reopen (no blind resubmit)
  const directPending = await extractScan.runScanOcr(extractScan.readScanImages(pngPath).images[0], { transport: async () => ({ kind: 'timeout', remoteId: ' opaque;pending ' }) });
  assert.equal(directPending.status, 'ocr_pending');
  assert.equal(directPending.remoteId, ' opaque;pending ');
  assert.ok(directPending.operationId && /^scan:/.test(directPending.operationId));
  assert.ok(directPending.attemptToken && /^scan-attempt:/.test(directPending.attemptToken));
  const pendingPersist = await imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-pending2', maxPages: 1, fixtureTransport: async () => ({ kind: 'timeout', remoteId: ' opaque;pending ' }) });
  reopenMain();
  const pendingRows = imports.listScanPages(ctx.db, PROJECT, pendingPersist.document.document_id);
  assert.equal(pendingRows[0].status, 'ocr_pending');
  assert.equal(pendingRows[0].remote_id, ' opaque;pending ');
  assert.ok(pendingRows[0].operation_id && pendingRows[0].attempt_token, 'structured operation/attempt persisted');
  const afterPendingResume = await imports.importScan(ctx.db, PROJECT, { filePath: scansPath, supplierKey: 'scan-pending2', maxPages: 3, fixtureTransport: async () => fixedOcrResponse() });
  assert.equal(afterPendingResume.pages.length, 3, 'the remaining images are processed');
  assert.equal(imports.listScanPages(ctx.db, PROJECT, pendingPersist.document.document_id).find((row) => row.image_index === 0).status, 'ocr_pending', 'the pending image stays unknown — no blind resubmit');
  // reopen readback
  reopenMain();
  const readbackPages = imports.listScanPages(ctx.db, PROJECT, scanned.document.document_id);
  assert.equal(readbackPages.length, 3);
  // task report + samples (+ fixture backup) when an output dir is provided
  const report = imports.buildReport(ctx.db, PROJECT, { taskId: 'T1.7', runId: '20261012-T17-implementation-01', idempotency: { replay: 'deduplicated', countsStable: true } });
  assert.ok(report.counts.candidates > 0);
  assert.ok(report.supportedFormats.some((entry) => entry.format === 'pdf_text' && entry.status === 'supported'));
  assert.ok(report.unsupported.some((entry) => /Docling/.test(entry.item)));
  assert.ok(report.samples.length > 0 && report.samples.every((row) => typeof row.snippet === 'string' && row.snippet.length > 0));
  assert.ok(report.documents.some((row) => row.coverage && row.coverage.truncated === false), 'document coverage is readable in the report');
  assert.ok(report.scanPages.some((row) => row.attemptToken), 'per-image attempt identity is readable in the report');
  if (OUT_DIR) {
    fs.writeFileSync(path.join(OUT_DIR, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'samples', 'localization-samples.json'), `${JSON.stringify({
      schemaVersion: 1, taskId: 'T1.7', runId: '20261012-T17-implementation-01', generatedAt: report.generatedAt,
      candidates: report.samples, scanPages: report.scanPages, corrections: report.corrections
    }, null, 2)}\n`, 'utf8');
    const backupPath = path.join(OUT_DIR, 'fixture', 'imports-fixture.backup.db');
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath);
    backupTo(ctx.db, backupPath);
    const verified = verifyDatabaseFile(backupPath, { expectedTables: ['import_documents', 'import_candidates', 'import_scan_pages', 'import_corrections'] });
    assert.equal(verified.ok, true, 'fixture backup verifies');
  }
});

// ---------- 5. migration 0011 ----------

test('T1.7 migration: 0011 up/down/re-up + with-data backup/restore + fingerprint binding', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(RUN_DIR, 't17-migration-'));
  const dbPath = path.join(dir, 'migration-fixture.db');
  let db = openDb(dbPath);
  const ran = migrateUp(db, [core, m3, m11]);
  assert.deepEqual(ran, [1, 3, 11]);
  const csvPath = writeCsv('migration-mini.csv', [['型号', '出厂价', '币种', '单位', '条款'], ['H0', '40', 'CNY', '套', 'FOB']]);
  const imported = await imports.importTable(db, PROJECT, { filePath: csvPath, supplierKey: 'sup-mig' });
  assert.equal(imported.status, 'imported');
  const backupPath = path.join(dir, 'with-data-backup.db');
  backupTo(db, backupPath);
  // down to the pre-0011 schema, then re-up (clean)
  const reverted = migrateDown(db, [core, m3, m11], { to: 3 });
  assert.deepEqual(reverted, [11]);
  const gone = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_candidates'").get();
  assert.equal(gone, undefined, '0011 tables are dropped by downSql');
  const reRan = migrateUp(db, [core, m3, m11]);
  assert.deepEqual(reRan, [11]);
  assert.equal(imports.listCandidates(db, PROJECT).length, 0, 're-up starts empty (data lived in the backup)');
  // with-data restore: the VACUUM INTO backup still carries the rows
  const restored = openDb(backupPath, { readOnly: true });
  const restoredCount = restored.prepare('SELECT COUNT(*) AS n FROM import_candidates').get().n;
  restored.close();
  assert.ok(restoredCount > 0, 'backup restored with data');
  const dataVerified = verifyDatabaseFile(backupPath, { expectedTables: ['import_documents', 'import_candidates'] });
  assert.equal(dataVerified.ok, true);
  // fingerprint binding: a changed canonical sql/downSql refuses apply/down instead of mutating history
  const tampered = { ...m11, sql: `${m11.sql}\n-- tampered` };
  assert.throws(() => migrateUp(db, [core, m3, tampered]), /checksum mismatch/);
  const tamperedDown = { ...m11, downSql: `${m11.downSql}\n-- tampered` };
  const freshDir = fs.mkdtempSync(path.join(RUN_DIR, 't17-migration-fp-'));
  const freshDb = openDb(path.join(freshDir, 'fp.db'));
  migrateUp(freshDb, [core, m3, m11]);
  assert.throws(() => migrateDown(freshDb, [core, m3, tamperedDown], { to: 3 }), /fingerprint mismatch/);
  const stillThere = freshDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_candidates'").get();
  assert.ok(stillThere, 'refused down never dropped anything');
  freshDb.close();
  db.close();
});

// ---------- revision-02 focused groups (review-02 residuals) ----------

test('T1.7-rev02 F1: multi-dimension config identity and manual subject dedup', { skip }, async () => {
  const multiPath = writeCsv('rev2-multi.csv', [
    ['型号', '配置', '颜色', '价格', '币种', '单位', '条款'],
    ['SOL-C1', 'camera', 'red', '12', 'USD', 'pcs', 'EXW'],
    ['SOL-C1', 'camera', 'blue', '15', 'USD', 'pcs', 'EXW']
  ]);
  const multi = await imports.importTable(ctx.db, PROJECT, { filePath: multiPath, supplierKey: 'sup-rev2-f1' });
  const multiCosts = multi.candidates.filter((row) => row.field_key === 'purchase_cost');
  assert.equal(new Set(multiCosts.map((row) => row.subject_key)).size, 2, 'every explicit dimension (配置+颜色) binds the subject');
  assert.deepEqual(multiCosts.map((row) => row.subject_key).sort(), ['SOL-C1|配置=camera|颜色=blue', 'SOL-C1|配置=camera|颜色=red']);
  for (const row of multiCosts) assert.equal(row.reasons, null, 'distinct configurations are not a contradiction');
  const lineCost = fields.detectLineFields('SOL-X 配置 red 颜色 blue 出厂价 12 USD/pcs EXW').find((row) => row.fieldKey === 'purchase_cost');
  assert.ok(lineCost.subjectKey.includes('配置=red') && lineCost.subjectKey.includes('颜色=blue'), 'later line dimensions are never dropped');
  const unknownDim = fields.detectLineFields('SOL-Y 配置 出厂价 12 USD/pcs EXW').find((row) => row.fieldKey === 'purchase_cost');
  assert.ok(unknownDim.subjectKey.includes('配置=?'), 'an explicit label with no value stays an explicit unknown');
  assert.ok(unknownDim.reasons.includes('variant_unknown'));
  // manual identity: an equal amount with a distinct explicit subject never merges
  const reference = path.join(RUN_DIR, 'rev2-reference.bin');
  fs.writeFileSync(reference, 'reference-material');
  const manualA = imports.addManualCandidate(ctx.db, PROJECT, { filePath: reference, supplierKey: 'sup-rev2-manual', fieldKey: 'purchase_cost', rawValue: '40', currency: 'USD', unit: 'pcs', incoterm: 'EXW', subjectKey: 'SOL-M|red' });
  const manualB = imports.addManualCandidate(ctx.db, PROJECT, { filePath: reference, supplierKey: 'sup-rev2-manual', fieldKey: 'purchase_cost', rawValue: '40', currency: 'USD', unit: 'pcs', incoterm: 'EXW', subjectKey: 'SOL-M|blue' });
  assert.notEqual(manualA.candidate.candidate_id, manualB.candidate.candidate_id, 'equal prices never merge independent subjects');
  assert.equal(manualB.candidate.subject_key, 'SOL-M|blue');
  const manualAReplay = imports.addManualCandidate(ctx.db, PROJECT, { filePath: reference, supplierKey: 'sup-rev2-manual', fieldKey: 'purchase_cost', rawValue: '40', currency: 'USD', unit: 'pcs', incoterm: 'EXW', subjectKey: 'SOL-M|red' });
  assert.equal(manualAReplay.candidate.candidate_id, manualA.candidate.candidate_id, 'an exact manual replay stays idempotent');
});

test('T1.7-rev02 F2: field-specific semantics and conflict retention', { skip }, async () => {
  const header7 = ['型号', '配置', '价格', '币种', '单位', '条款'];
  const unitConflictPath = writeCsv('rev2-unit-conflict.csv', [header7, ['SOL-U1', 'red', '12 USD/pcs', 'USD', '套', 'EXW']]);
  const unitConflict = (await imports.importTable(ctx.db, PROJECT, { filePath: unitConflictPath, supplierKey: 'sup-rev2-f2' })).candidates.find((row) => row.field_key === 'purchase_cost');
  assert.equal(unitConflict.unit, 'pcs');
  assert.match(unitConflict.reasons, /unit_conflict/);
  const amountOnly = imports.correctCandidate(ctx.db, PROJECT, { candidateId: unitConflict.candidate_id, correctedValue: '13' });
  assert.equal(amountOnly.candidate.unit, 'pcs');
  assert.match(amountOnly.candidate.reasons, /unit_conflict/, 'an amount-only correction never erases an unresolved unit conflict');
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: amountOnly.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const resolvedUnit = imports.correctCandidate(ctx.db, PROJECT, { candidateId: amountOnly.candidate.candidate_id, correctedValue: '13', correctedUnit: '套' });
  assert.equal(resolvedUnit.candidate.unit, '套');
  assert.equal(resolvedUnit.candidate.reasons, null, 'only the corresponding EXPLICIT correction resolves the field conflict');
  const currencyPath = writeCsv('rev2-unknown-currency.csv', [header7, ['SOL-U2', 'red', '12', 'XYZ', 'pcs', 'EXW']]);
  const unknownCurrency = (await imports.importTable(ctx.db, PROJECT, { filePath: currencyPath, supplierKey: 'sup-rev2-f2' })).candidates.find((row) => row.field_key === 'currency');
  assert.equal(unknownCurrency.currency, null);
  assert.match(unknownCurrency.reasons, /unrecognized_currency/);
  const bananas = imports.correctCandidate(ctx.db, PROJECT, { candidateId: unknownCurrency.candidate_id, correctedValue: 'bananas' });
  assert.equal(bananas.candidate.currency, null);
  assert.match(bananas.candidate.reasons, /unrecognized_currency/, 'an unrecognized currency is never confirmable');
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: bananas.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const realCurrency = imports.correctCandidate(ctx.db, PROJECT, { candidateId: bananas.candidate.candidate_id, correctedValue: 'USD' });
  assert.equal(realCurrency.candidate.currency, 'USD', 'a real currency correction normalizes the field');
  assert.equal(realCurrency.candidate.reasons, null);
  imports.confirmCandidate(ctx.db, PROJECT, { candidateId: realCurrency.candidate.candidate_id, observedAt: T_OBS, now: T_APPROVE });
  const manualBad = imports.addManualCandidate(ctx.db, PROJECT, { filePath: path.join(RUN_DIR, 'rev2-reference.bin'), supplierKey: 'sup-rev2-manual2', fieldKey: 'currency', rawValue: 'bananas' });
  assert.match(manualBad.candidate.reasons, /unrecognized_currency/, 'manual entry shares the field-specific validation');
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: manualBad.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const manualGood = imports.addManualCandidate(ctx.db, PROJECT, { filePath: path.join(RUN_DIR, 'rev2-reference.bin'), supplierKey: 'sup-rev2-manual2', fieldKey: 'currency', rawValue: 'CNY' });
  assert.equal(manualGood.candidate.currency, 'CNY');
  imports.confirmCandidate(ctx.db, PROJECT, { candidateId: manualGood.candidate.candidate_id, observedAt: T_OBS, now: T_APPROVE });
});

test('T1.7-rev02 F3: per-image lineage, remaining-slice bound, reader cap', { skip }, async () => {
  const fixedLine = 'SOL-09 配置 red 出厂价 12 USD/pcs EXW';
  const sameLineOcr = async () => ({ kind: 'response', httpStatus: 200, body: { id: 'rev2-remote', choices: [{ message: { content: JSON.stringify({ lines: [{ text: fixedLine }] }) } }], usage: { prompt_tokens: 2900, completion_tokens: 60 } } });
  const pairPath = writeFile('rev2-pair.pdf', buildScannedPdf([{ images: ['jpeg', 'jpeg'] }]));
  const pair = await imports.importScan(ctx.db, PROJECT, { filePath: pairPath, supplierKey: 'sup-rev2-f3', maxPages: 3, fixtureTransport: sameLineOcr });
  const pairPrices = pair.candidates.filter((row) => row.field_key === 'purchase_cost' && row.page_number === 1);
  assert.equal(pairPrices.length, 2, 'identical OCR lines from two images stay two candidates');
  assert.deepEqual(pairPrices.map((row) => row.image_object).sort(), ['5', '6']);
  assert.equal(new Set(pairPrices.map((row) => row.image_sha256)).size, 1, 'identical bytes still keep per-object references');
  assert.equal(new Set(pairPrices.map((row) => row.subject_key)).size, 1);
  for (const row of pairPrices) assert.equal(row.reasons, null, 'equal fields from separate sources are not a contradiction');
  const twentyOnePath = writeFile('rev2-21.pdf', buildScannedPdf([{ images: Array.from({ length: 21 }, () => 'jpx') }]));
  let calls = 0;
  const countingTransport = async () => { calls += 1; return sameLineOcr(); };
  const firstPass = await imports.importScan(ctx.db, PROJECT, { filePath: twentyOnePath, supplierKey: 'sup-rev2-21', maxPages: 20, fixtureTransport: countingTransport });
  assert.deepEqual([firstPass.coverage.imagesFound, firstPass.coverage.imagesProcessed, firstPass.coverage.truncated], [21, 20, true]);
  const secondPass = await imports.importScan(ctx.db, PROJECT, { filePath: twentyOnePath, supplierKey: 'sup-rev2-21', maxPages: 20, fixtureTransport: countingTransport });
  assert.equal(secondPass.coverage.imagesProcessed, 21, 'the second call processes the REMAINING image (no permanent index cutoff)');
  assert.equal(secondPass.coverage.truncated, false);
  assert.equal(calls, 0, 'unsupported images never call the transport');
  const hundredOnePath = writeFile('rev2-101.pdf', buildScannedPdf([{ images: Array.from({ length: 101 }, () => 'jpx') }]));
  const reader = extractScan.readScanImages(hundredOnePath);
  assert.equal(reader.imageCount, 101, 'the reader counts what it found, not what it enumerated');
  assert.equal(reader.enumerated, 100);
  assert.equal(reader.omitted, 1);
  assert.equal(reader.truncated, true);
  assert.ok(/omitted by the reader cap/.test(reader.notes[0]), 'omitted coverage is explicit, never reported as the full total');
  const cappedImport = await imports.importScan(ctx.db, PROJECT, { filePath: hundredOnePath, supplierKey: 'sup-rev2-101', maxPages: 20, fixtureTransport: countingTransport });
  assert.equal(cappedImport.status, 'partial', 'a reader-capped document can never be a complete import');
  assert.equal(cappedImport.coverage.readerOmitted, 1);
});

// ---------- revision-03 focused groups (review-03 F2 residuals) ----------

test('T1.7-rev03 F2a: explicit unknown dimension never becomes legal', { skip }, async () => {
  const unknownPng = writeFile('rev3-unknown.png', pdfUtil.buildPng(8, 8, Buffer.alloc(64, 121), 1));
  const lineTransport = async () => ({ kind: 'response', httpStatus: 200, body: { id: 'rev3-remote', choices: [{ message: { content: JSON.stringify({ lines: [{ text: 'SOL-N1 配置 颜色 red 出厂价 12 USD/pcs EXW' }] }) } }], usage: { prompt_tokens: 2900, completion_tokens: 60 } } });
  const unknown = await imports.importScan(ctx.db, PROJECT, { filePath: unknownPng, supplierKey: 'sup-rev3-unknown', fixtureTransport: lineTransport });
  const unknownCost = unknown.candidates.find((row) => row.field_key === 'purchase_cost');
  assert.equal(unknownCost.subject_key, 'SOL-N1|配置=?|颜色=red');
  assert.match(unknownCost.reasons, /variant_unknown/);
  const amountOnly = imports.correctCandidate(ctx.db, PROJECT, { candidateId: unknownCost.candidate_id, correctedValue: '13' });
  assert.match(amountOnly.candidate.reasons, /variant_unknown/, 'an amount-only correction never erases an explicit unknown dimension');
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: amountOnly.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const tableUnknownPath = writeCsv('rev3-table-unknown.csv', [['型号', '配置', '颜色', '价格', '币种', '单位', '条款'], ['SOL-T1', '', 'red', '12', 'USD', 'pcs', 'EXW']]);
  const tableUnknown = (await imports.importTable(ctx.db, PROJECT, { filePath: tableUnknownPath, supplierKey: 'sup-rev3-unknown' })).candidates.find((row) => row.field_key === 'purchase_cost');
  assert.equal(tableUnknown.subject_key, 'SOL-T1|配置=?|颜色=red', 'a present variant column with an empty cell stays an explicit unknown');
  assert.match(tableUnknown.reasons, /variant_unknown/);
  const tableAmountOnly = imports.correctCandidate(ctx.db, PROJECT, { candidateId: tableUnknown.candidate_id, correctedValue: '13' });
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: tableAmountOnly.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const filledPath = writeCsv('rev3-filled.csv', [['型号', '配置', '颜色', '价格', '币种', '单位', '条款'], ['SOL-F1', 'camera', 'red', '12', 'USD', 'pcs', 'EXW']]);
  const filledCost = (await imports.importTable(ctx.db, PROJECT, { filePath: filledPath, supplierKey: 'sup-rev3-unknown' })).candidates.find((row) => row.field_key === 'purchase_cost');
  assert.equal(filledCost.reasons, null, 'fully specified dimensions remain legal');
  imports.confirmCandidate(ctx.db, PROJECT, { candidateId: filledCost.candidate_id, observedAt: T_OBS, now: T_APPROVE });
  reopenMain();
  assert.equal(imports.getCandidate(ctx.db, PROJECT, amountOnly.candidate.candidate_id).status, 'candidate', 'the unknown identity stays a candidate across reopen');
  assert.equal(imports.getCandidate(ctx.db, PROJECT, filledCost.candidate_id).status, 'confirmed');
});

test('T1.7-rev03 F2b: currency raw value is authoritative against auxiliary overrides', { skip }, async () => {
  const header7 = ['型号', '配置', '价格', '币种', '单位', '条款'];
  const currencyFile = writeCsv('rev3-currency.csv', [header7, ['SOL-U2', 'red', '12', 'XYZ', 'pcs', 'EXW']]);
  let counter = 0;
  const freshCurrency = async () => {
    counter += 1;
    const result = await imports.importTable(ctx.db, PROJECT, { filePath: currencyFile, supplierKey: `sup-rev3-cur-${counter}` });
    return result.candidates.find((row) => row.field_key === 'currency');
  };
  const bananasUsd = imports.correctCandidate(ctx.db, PROJECT, { candidateId: (await freshCurrency()).candidate_id, correctedValue: 'bananas', correctedCurrency: 'USD' });
  assert.equal(bananasUsd.candidate.currency, null, 'a recognized auxiliary code never legalizes an invalid raw value');
  assert.match(bananasUsd.candidate.reasons, /unrecognized_currency/);
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: bananasUsd.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const usdCny = imports.correctCandidate(ctx.db, PROJECT, { candidateId: (await freshCurrency()).candidate_id, correctedValue: 'USD', correctedCurrency: 'CNY' });
  assert.equal(usdCny.candidate.currency, null);
  assert.match(usdCny.candidate.reasons, /currency_conflict/, 'a differing auxiliary code is a conflict, not an override');
  assert.throws(() => imports.confirmCandidate(ctx.db, PROJECT, { candidateId: usdCny.candidate.candidate_id, observedAt: T_OBS }), /unresolved conditions/);
  const usdPlain = imports.correctCandidate(ctx.db, PROJECT, { candidateId: (await freshCurrency()).candidate_id, correctedValue: 'USD' });
  assert.equal(usdPlain.candidate.currency, 'USD');
  assert.equal(usdPlain.candidate.reasons, null);
  imports.confirmCandidate(ctx.db, PROJECT, { candidateId: usdPlain.candidate.candidate_id, observedAt: T_OBS, now: T_APPROVE });
  const usdAux = imports.correctCandidate(ctx.db, PROJECT, { candidateId: bananasUsd.candidate.candidate_id, correctedValue: 'USD', correctedCurrency: 'USD' });
  assert.equal(usdAux.candidate.currency, 'USD', 'a consistent explicit auxiliary value stays usable');
  imports.confirmCandidate(ctx.db, PROJECT, { candidateId: usdAux.candidate.candidate_id, observedAt: T_OBS, now: T_APPROVE });
  const numFile = writeCsv('rev3-numeric-currency.csv', [header7, ['SOL-U3', 'red', '40', 'USD', 'pcs', 'EXW']]);
  const numCost = (await imports.importTable(ctx.db, PROJECT, { filePath: numFile, supplierKey: 'sup-rev3-num' })).candidates.find((row) => row.field_key === 'purchase_cost');
  const numCorr = imports.correctCandidate(ctx.db, PROJECT, { candidateId: numCost.candidate_id, correctedValue: '41', correctedCurrency: 'CNY' });
  assert.equal(numCorr.candidate.currency, 'CNY', 'numeric costs keep accepting an explicit correctedCurrency');
  assert.equal(numCorr.candidate.reasons, null);
  imports.confirmCandidate(ctx.db, PROJECT, { candidateId: numCorr.candidate.candidate_id, observedAt: T_OBS, now: T_APPROVE });
  reopenMain();
  assert.equal(imports.getCandidate(ctx.db, PROJECT, bananasUsd.candidate.candidate_id).status, 'superseded');
  assert.equal(imports.getCandidate(ctx.db, PROJECT, usdAux.candidate.candidate_id).status, 'confirmed');
});
