'use strict';
/**
 * Table import adapter (T1.7 clause A; rev-01): CSV with a small RFC-style parser, XLSX through the
 * approved ExcelJS dependency (4.4.0, already installed — nothing new is installed). Cells are
 * mapped through a GENERIC header vocabulary only; each mapped cell keeps its own sheet/row/column
 * provenance and its exact raw text. rev-01: EVERY mapped cell is emitted (a repeated price column
 * is never discarded and both quotes stay visible/conflict-marked), and configuration identity
 * binds quote subjects (price/quantity carry the exact configuration text, e.g. `SOL-03|red`).
 * Unmapped headers and headerless files are never guessed into fields.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const ExcelJS = require('exceljs');
const fields = require('./fields.js');

const CSV_PARSER_VERSION = 'imports/csv@v1';
const XLSX_PARSER_VERSION = 'imports/xlsx@v1';

const HEADER_FIELDS = [
  { fieldKey: 'model', tokens: ['型号', '款号', '产品型号', '货号', 'model', 'item'] },
  { fieldKey: 'purchase_cost', tokens: ['出厂价', '采购价', '成本价', '进货价', '批发价', '价格', '单价', 'price'] },
  { fieldKey: 'currency', tokens: ['币种', '货币', 'currency'] },
  { fieldKey: 'unit', tokens: ['单位', '计价单位', 'unit'] },
  { fieldKey: 'incoterm', tokens: ['条款', '贸易条款', '价格条款', 'incoterm', 'trade term', 'trade_term'] },
  { fieldKey: 'quantity', tokens: ['数量', '起订量', '订购量', 'moq', 'quantity', 'qty'] },
  { fieldKey: 'variant_text', tokens: ['灯型', '配置', '颜色', '规格', 'variant', 'color'] }
];

function columnLetter(index) {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** Small RFC-style CSV parser (quotes with escaped double quotes; CRLF/LF; commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; } else inQuotes = false;
      } else cell += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell); cell = '';
    } else if (char === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** ExcelJS cell value -> display text (rich text joined; formula results; dates never attributed). */
function cellValueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('');
    if (value.result !== undefined) return cellValueText(value.result);
    if (typeof value.text === 'string') return value.text;
    if (value.error) return String(value.error);
  }
  return String(value);
}

/** Generic header mapping: normalized substring match against the vocabulary; no guess on misses. */
function mapHeaderCell(text) {
  const normalized = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  for (const spec of HEADER_FIELDS) {
    for (const token of spec.tokens) {
      if (normalized.includes(token)) return spec.fieldKey;
    }
  }
  return null;
}

function buildHeaderMap(cells) {
  const map = new Map();
  for (const cell of cells) {
    const fieldKey = mapHeaderCell(cell.text);
    if (fieldKey && !map.has(cell.columnRef)) map.set(cell.columnRef, { fieldKey, headerText: String(cell.text ?? '').trim() });
  }
  return map;
}

function resolveCurrencyCell(text) {
  const trimmed = String(text ?? '').trim();
  const direct = fields.resolveCurrency((trimmed.match(/[¥￥$€]/) || [])[0] ?? null, trimmed);
  if (direct.reason === 'missing_currency') return { currency: null, reason: 'unrecognized_currency' };
  return direct;
}

/**
 * Candidates for one data row under a mapped header: one candidate PER mapped cell (independent
 * field reads). Model/config identity binds quote subjects; repeated columns stay visible.
 */
function rowCandidates(row, headerMap, sheetName) {
  const cellsByField = new Map();
  for (const cell of row.cells) {
    const mapped = headerMap.get(cell.columnRef);
    if (!mapped) continue;
    if (String(cell.text ?? '').trim() === '') continue;
    if (!cellsByField.has(mapped.fieldKey)) cellsByField.set(mapped.fieldKey, []);
    cellsByField.get(mapped.fieldKey).push(cell);
  }
  if (cellsByField.size === 0) return [];
  const location = (cell) => ({ sheet: sheetName, rowNumber: row.rowNumber, columnRef: cell.columnRef });
  const first = (fieldKey) => (cellsByField.get(fieldKey) ?? [])[0] ?? null;
  const modelCell = first('model');
  const model = modelCell ? String(modelCell.text).trim() : null;
  // ALL explicit variant dimensions (configured/color/lamp/spec columns) bind the quote subject;
  // the first variant column can never discard the distinctions of a later one, and an explicitly
  // present column with an EMPTY cell stays an explicit unknown (`label=?`) instead of
  // silently disappearing
  const variantDims = [];
  for (const [columnRef, mapped] of headerMap.entries()) {
    if (mapped.fieldKey !== 'variant_text') continue;
    const cell = row.cells.find((candidateCell) => candidateCell.columnRef === columnRef);
    const text = cell ? String(cell.text ?? '').trim() : '';
    variantDims.push({ label: mapped.headerText || `col:${columnRef}`, text: text === '' ? null : text });
  }
  const variantUnknown = variantDims.some((dim) => dim.text === null);
  const subjectKey = fields.composeQuoteSubject(model, variantDims);
  const results = [];

  for (const cell of cellsByField.get('model') ?? []) {
    const value = String(cell.text).trim();
    results.push({ fieldKey: 'model', rawValue: value, numericValue: null, currency: null, unit: null, incoterm: null, reasons: [], snippet: value, subjectKey: value, ...location(cell) });
  }
  for (const cell of cellsByField.get('currency') ?? []) {
    const raw = String(cell.text).trim();
    const resolved = resolveCurrencyCell(raw);
    results.push({ fieldKey: 'currency', rawValue: raw, numericValue: null, currency: resolved.currency, unit: null, incoterm: null, reasons: resolved.reason ? [resolved.reason] : [], snippet: raw, subjectKey, ...location(cell) });
  }
  for (const cell of cellsByField.get('unit') ?? []) {
    const raw = String(cell.text).trim();
    results.push({ fieldKey: 'unit', rawValue: raw, numericValue: null, currency: null, unit: raw, incoterm: null, reasons: [], snippet: raw, subjectKey, ...location(cell) });
  }
  for (const cell of cellsByField.get('incoterm') ?? []) {
    const raw = String(cell.text).trim();
    const upper = raw.toUpperCase();
    results.push({ fieldKey: 'incoterm', rawValue: raw, numericValue: null, currency: null, unit: null, incoterm: fields.INCOTERMS.includes(upper) ? upper : null, reasons: fields.INCOTERMS.includes(upper) ? [] : ['unrecognized_incoterm'], snippet: raw, subjectKey, ...location(cell) });
  }
  for (const cell of cellsByField.get('quantity') ?? []) {
    const raw = String(cell.text).trim();
    const numberMatch = raw.match(/\d[\d,]*(?:\.\d+)?/);
    const numericValue = numberMatch ? Number.parseFloat(numberMatch[0].replace(/,/g, '')) : null;
    const unitMatch = raw.match(new RegExp(fields.UNIT_TOKENS.join('|'), 'i'));
    const unit = unitMatch ? unitMatch[0] : null;
    const reasons = [];
    if (numericValue === null) reasons.push('unparsed_amount');
    if (!unit) reasons.push('missing_unit');
    if (variantUnknown) reasons.push('variant_unknown');
    results.push({ fieldKey: 'quantity', rawValue: raw, numericValue, currency: null, unit, incoterm: null, reasons, snippet: raw, subjectKey, ...location(cell) });
  }

  const overlayCurrencyCell = first('currency');
  const overlayUnitCell = first('unit');
  const overlayIncotermCell = first('incoterm');
  for (const cell of cellsByField.get('purchase_cost') ?? []) {
    const raw = String(cell.text).trim();
    const parsed = fields.parseAmountText(raw);
    const reasons = [];
    if (!parsed) {
      reasons.push('unparsed_amount');
      if (variantUnknown) reasons.push('variant_unknown');
      if (overlayCurrencyCell) {
        const columnCurrency = resolveCurrencyCell(String(overlayCurrencyCell.text));
        if (!columnCurrency.currency) reasons.push(columnCurrency.reason);
      }
      if (!overlayUnitCell) reasons.push('missing_unit');
      if (!overlayIncotermCell) reasons.push('missing_incoterm');
      results.push({ fieldKey: 'purchase_cost', rawValue: raw, numericValue: null, currency: null, unit: null, incoterm: null, reasons, snippet: raw, subjectKey, ...location(cell) });
      continue;
    }
    const inlineCurrency = fields.resolveCurrency(parsed.symbol, parsed.word);
    let currency = inlineCurrency.currency;
    let currencyConflict = inlineCurrency.reason === 'currency_conflict';
    if (overlayCurrencyCell) {
      const columnCurrency = resolveCurrencyCell(String(overlayCurrencyCell.text));
      if (columnCurrency.reason === 'currency_conflict') currencyConflict = true;
      else if (columnCurrency.currency) {
        if (currency && currency !== columnCurrency.currency) currencyConflict = true;
        else currency = currency || columnCurrency.currency;
      } else if (!currency && !currencyConflict) {
        reasons.push(columnCurrency.reason);
      }
    } else if (!currency && !currencyConflict && inlineCurrency.reason) {
      reasons.push(inlineCurrency.reason);
    }
    if (currencyConflict) { currency = null; reasons.push('currency_conflict'); }
    let unit = parsed.unit;
    if (overlayUnitCell) {
      const columnUnit = String(overlayUnitCell.text).trim();
      if (unit && unit !== columnUnit) reasons.push('unit_conflict');
      else unit = columnUnit;
    }
    if (!unit) reasons.push('missing_unit');
    let incoterm = null;
    if (overlayIncotermCell) {
      const columnIncoterm = String(overlayIncotermCell.text).trim().toUpperCase();
      if (fields.INCOTERMS.includes(columnIncoterm)) incoterm = columnIncoterm;
      else reasons.push('unrecognized_incoterm');
    } else {
      reasons.push('missing_incoterm');
    }
    if (variantUnknown) reasons.push('variant_unknown');
    results.push({ fieldKey: 'purchase_cost', rawValue: parsed.raw, numericValue: parsed.numericValue, currency, unit, incoterm, reasons, snippet: parsed.raw, subjectKey, ...location(cell) });
  }

  for (const cell of cellsByField.get('variant_text') ?? []) {
    const raw = String(cell.text).trim();
    results.push({ fieldKey: 'variant_text', rawValue: raw, numericValue: null, currency: null, unit: null, incoterm: null, reasons: [], snippet: raw, subjectKey, ...location(cell) });
  }
  return results;
}

async function extractTableFile(filePath, format) {
  const bytes = fs.readFileSync(filePath);
  const rawSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (format === 'csv') {
    const rows = parseCsv(bytes.toString('utf8'));
    return {
      rawSha256,
      byteSize: bytes.length,
      format: 'csv',
      parserVersion: CSV_PARSER_VERSION,
      sheets: [{ name: 'csv', rows: rows.map((cells, index) => ({ rowNumber: index + 1, cells: cells.map((text, column) => ({ columnRef: columnLetter(column), text })) })) }]
    };
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheets = [];
    workbook.eachSheet((worksheet) => {
      const rows = [];
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const cells = [];
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          cells.push({ columnRef: columnLetter(colNumber - 1), text: cellValueText(cell.value) });
        });
        rows.push({ rowNumber, cells });
      });
      sheets.push({ name: worksheet.name, rows });
    });
    return { rawSha256, byteSize: bytes.length, format: 'xlsx', parserVersion: XLSX_PARSER_VERSION, sheets };
  }
  throw new Error(`unsupported table format ${format}`);
}

module.exports = {
  CSV_PARSER_VERSION,
  XLSX_PARSER_VERSION,
  HEADER_FIELDS,
  columnLetter,
  parseCsv,
  cellValueText,
  mapHeaderCell,
  buildHeaderMap,
  rowCandidates,
  extractTableFile
};
