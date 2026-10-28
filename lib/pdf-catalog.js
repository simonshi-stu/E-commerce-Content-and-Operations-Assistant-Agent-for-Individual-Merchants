'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const ALLOWED_PDF_TYPES = new Set(['application/pdf', 'application/x-pdf', '']);
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_CHARS = 2 * 1024 * 1024;

function safePdfName(value) {
  return String(value || 'catalog.pdf').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'catalog.pdf';
}

function validatePdfFile(filePath, mimeType = '', declaredSize = 0) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  if (declaredSize && declaredSize !== size) throw Object.assign(new Error('Uploaded PDF size does not match the request.'), { code: 'invalid_pdf' });
  if (size < PDF_MAGIC.length || size > MAX_PDF_BYTES) throw Object.assign(new Error('PDF size is outside the allowed range.'), { code: size > MAX_PDF_BYTES ? 'upload_too_large' : 'invalid_pdf' });
  if (!ALLOWED_PDF_TYPES.has(String(mimeType).toLowerCase())) throw Object.assign(new Error('Only PDF uploads are supported.'), { code: 'unsupported_media_type' });
  const header = Buffer.alloc(PDF_MAGIC.length);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (!header.equals(PDF_MAGIC)) throw Object.assign(new Error('The uploaded file is not a PDF.'), { code: 'pdf_magic_mismatch' });
  return { size, fileName: safePdfName(path.basename(filePath)) };
}

function inflate(buffer) {
  if (!buffer.length) return null;
  try { return zlib.inflateSync(buffer); } catch { /* not zlib */ }
  try { return zlib.inflateRawSync(buffer); } catch { /* not deflate */ }
  return null;
}

function toUtf16Be(buffer, start = 0) {
  let result = '';
  for (let index = start; index + 1 < buffer.length; index += 2) result += String.fromCharCode((buffer[index] << 8) | buffer[index + 1]);
  return result;
}

function toUtf16Le(buffer, start = 0) {
  let result = '';
  for (let index = start; index + 1 < buffer.length; index += 2) result += String.fromCharCode((buffer[index + 1] << 8) | buffer[index]);
  return result;
}

function literalBytes(raw) {
  const bytes = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== '\\') { bytes.push(char.charCodeAt(0) & 0xff); continue; }
    const next = raw[index + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      let octal = next;
      index += 1;
      for (let extra = 0; extra < 2 && /[0-7]/.test(raw[index + 1] || ''); extra += 1) { octal += raw[index + 1]; index += 1; }
      bytes.push(parseInt(octal, 8) & 0xff);
    } else {
      const escaped = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      bytes.push(escaped[next] ?? (next.charCodeAt(0) & 0xff));
      index += 1;
    }
  }
  return Buffer.from(bytes);
}

function hexBytes(text) {
  const hex = String(text).replace(/[^0-9A-Fa-f]/g, '');
  const padded = hex.length % 2 ? `${hex}0` : hex;
  return Buffer.from(padded, 'hex');
}

function hexToUnicode(text) {
  const bytes = hexBytes(text);
  if (!bytes.length) return '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return toUtf16Be(bytes, 2);
  if (bytes.length === 2) return String.fromCharCode((bytes[0] << 8) | bytes[1]);
  return toUtf16Be(bytes);
}

function decodeBytes(buffer, cmap) {
  if (!buffer.length) return '';
  if (cmap && cmap.size) {
    let mapped = '';
    for (let index = 0; index + 1 < buffer.length; index += 2) {
      const code = (buffer[index] << 8) | buffer[index + 1];
      if (cmap.has(code)) mapped += cmap.get(code);
    }
    if (mapped.length >= Math.max(1, Math.floor(buffer.length / 6))) return mapped;
    let single = '';
    for (const byte of buffer) if (cmap.has(byte)) single += cmap.get(byte);
    if (single.length >= Math.max(1, Math.floor(buffer.length / 4))) return single;
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return toUtf16Be(buffer, 2);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return toUtf16Le(buffer, 2);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    if (buffer[index] === 0) evenZeros += 1;
    if (buffer[index + 1] === 0) oddZeros += 1;
  }
  const pairs = Math.max(1, Math.floor(buffer.length / 2));
  if (evenZeros / pairs > 0.35 && evenZeros > oddZeros) return toUtf16Be(buffer);
  if (oddZeros / pairs > 0.35 && oddZeros > evenZeros) return toUtf16Le(buffer);
  return buffer.toString('latin1');
}

function buildCMaps(text) {
  const cmap = new Map();
  const source = String(text || '');
  [...source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)].forEach((block) => {
    [...block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)].forEach((pair) => {
      const code = parseInt(pair[1], 16);
      const value = hexToUnicode(pair[2]);
      if (Number.isInteger(code) && value) cmap.set(code, value);
    });
  });
  [...source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)].forEach((block) => {
    [...block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)].forEach((entry) => {
      const start = parseInt(entry[1], 16);
      const end = parseInt(entry[2], 16);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 65535) return;
      if (entry[3]) {
        const base = parseInt(entry[3], 16);
        for (let code = start; code <= end; code += 1) cmap.set(code, String.fromCharCode(base + (code - start)));
      } else if (entry[4]) {
        [...entry[4].matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((item, index) => {
          const value = hexToUnicode(item[1]);
          if (value) cmap.set(start + index, value);
        });
      }
    });
  });
  return cmap;
}

function decodeToken(token, cmap) {
  if (token.startsWith('(')) return decodeBytes(literalBytes(token.slice(1, -1)), cmap);
  if (token.startsWith('<')) return decodeBytes(hexBytes(token.slice(1, -1)), cmap);
  if (token.startsWith('[')) {
    let result = '';
    [...token.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g)].forEach((part) => { result += decodeToken(part[0], cmap); });
    return result;
  }
  return '';
}

function textFromContent(content, cmap) {
  const parts = [];
  const pattern = /(\[(?:\\.|[^\\[\]])*\]|\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)\s*(?:Tj|TJ|'|")|(\bTd\b|\bTD\b|\bT\*\b|\bET\b)/g;
  let match;
  while ((match = pattern.exec(content))) {
    if (match[1]) parts.push(decodeToken(match[1], cmap));
    else if (match[2]) parts.push('\n');
  }
  return parts.join('').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function objectRanges(raw) {
  const matches = [...raw.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)];
  return matches.map((match, index) => ({ num: Number(match[1]), start: match.index, end: index + 1 < matches.length ? matches[index + 1].index : raw.length }));
}

function streamSlice(raw, buffer, start, end) {
  const streamIndex = raw.indexOf('stream', start);
  if (streamIndex === -1 || streamIndex > end) return null;
  let dataStart = streamIndex + 'stream'.length;
  if (raw[dataStart] === '\r') dataStart += 1;
  if (raw[dataStart] === '\n') dataStart += 1;
  const endIndex = raw.indexOf('endstream', dataStart);
  if (endIndex === -1 || endIndex > end) return null;
  let dataEnd = endIndex;
  if (raw[dataEnd - 1] === '\n') dataEnd -= 1;
  if (raw[dataEnd - 1] === '\r') dataEnd -= 1;
  if (dataEnd <= dataStart) return null;
  return { dataStart, dataEnd, length: dataEnd - dataStart };
}

function streamContent(raw, buffer, range) {
  const slice = streamSlice(raw, buffer, range.start, range.end);
  if (!slice || slice.length > MAX_STREAM_BYTES) return '';
  const bytes = buffer.subarray(slice.dataStart, slice.dataEnd);
  const decoded = inflate(bytes);
  return (decoded || bytes).toString('latin1');
}

function pageContents(raw, buffer, ranges) {
  const objects = new Map(ranges.map((range) => [range.num, range]));
  const pageMatches = [...raw.matchAll(/\/Type\s*\/Page(?![a-zA-Z])/g)];
  const pages = [];
  pageMatches.forEach((match) => {
    const range = ranges.find((candidate) => match.index >= candidate.start && match.index < candidate.end);
    if (!range) return;
    const chunk = raw.slice(range.start, range.end);
    const refs = [];
    const single = chunk.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (single) refs.push(Number(single[1]));
    const array = chunk.match(/\/Contents\s*\[([\s\S]*?)\]/);
    if (array) [...array[1].matchAll(/(\d+)\s+\d+\s+R/g)].forEach((item) => refs.push(Number(item[1])));
    let content = '';
    refs.forEach((num) => {
      const objectRange = objects.get(num);
      if (objectRange) content += `${streamContent(raw, buffer, objectRange)}\n`;
    });
    pages.push(content);
  });
  return pages;
}

function allStreamContents(raw, buffer, ranges) {
  const contents = [];
  let total = 0;
  for (const range of ranges) {
    if (contents.length >= 200 || total > MAX_CONTENT_CHARS * 4) break;
    const content = streamContent(raw, buffer, range);
    if (!content) continue;
    contents.push(content);
    total += content.length;
  }
  return contents;
}

function literalFallback(raw) {
  const literals = [...raw.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)].map((match) => decodeBytes(literalBytes(match[1])));
  return literals.filter((item) => /[\p{L}\d]/u.test(item)).join(' ').replace(/\s+/g, ' ').trim();
}

function estimatePageCount(buffer) {
  const raw = buffer.toString('latin1');
  const pages = (raw.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  const countMatch = raw.match(/\/Count\s+(\d+)/);
  const count = pages || (countMatch ? Number(countMatch[1]) : 1);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PDF_PAGES) {
    throw Object.assign(new Error('PDF page count is outside the allowed range.'), { code: 'too_many_pages' });
  }
  return count;
}

function extractPdfPages(filePath) {
  const buffer = fs.readFileSync(filePath);
  const raw = buffer.toString('latin1');
  const pageCount = estimatePageCount(buffer);
  const ranges = objectRanges(raw);
  const contents = allStreamContents(raw, buffer, ranges);
  const cmap = buildCMaps([raw, ...contents].join('\n'));
  let pages = pageContents(raw, buffer, ranges).map((content) => textFromContent(content, cmap));
  if (!pages.some((page) => page.trim().length >= 2)) {
    pages = contents.map((content) => textFromContent(content, cmap)).filter(Boolean);
  }
  let text = pages.join('\n');
  if (text.replace(/\s/g, '').length === 0) {
    const fallback = literalFallback(raw);
    if (fallback) {
      text = fallback;
      pages = [fallback];
    }
  }
  const pageTexts = Array.from({ length: pageCount }, (_, index) => (pages[index] || '').slice(0, 4000));
  return { buffer, pageCount, pageTexts, text };
}

function hypothesesFor(text) {
  const value = text.toLowerCase();
  const known = value.includes('helmet') || value.includes('头盔')
    ? { label: '头盔 / 防护装备', confidence: 0.72, rulePackId: 'helmet-v1' }
    : value.includes('underwear') || value.includes('内衣') || value.includes('文胸')
      ? { label: '服饰 / 内衣', confidence: 0.66, rulePackId: 'apparel-generic-v1' }
      : { label: '待确认品类', confidence: 0.24, rulePackId: 'unknown-v1' };
  return [{ id: 'category-1', ...known, children: [], evidenceIds: text ? ['pdf-page-1'] : [], requiresManualConfirmation: true, isUserConfirmed: false }];
}

function parsePurchaseCostCandidate(line, pageNumber) {
  const match = String(line || '').match(/(出厂价|采购价|成本价|进货价|单价|FOB|EXW)\s*[:：]?\s*([¥￥$]?\s*\d[\d,]*(?:\.\d+)?)\s*(人民币|RMB|CNY|美元|USD|元|美金)?/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[2].replace(/[¥￥$,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const suffix = String(match[3] || '').toUpperCase();
  const hasDollar = /[$]/.test(match[2]) || /USD|美元|美金/.test(suffix);
  const hasYuan = /¥|￥/.test(match[2]) || /CNY|RMB|人民币|元/.test(suffix);
  const currency = hasDollar && !hasYuan ? 'USD' : hasYuan && !hasDollar ? 'CNY' : '';
  return {
    amount,
    currency,
    currencyStatus: currency ? 'inferred_from_pdf_text' : 'missing',
    unit: '',
    incoterm: '',
    variant: '',
    priceLabel: match[1],
    evidenceText: match[0].trim(),
    sourceType: 'pdf_extraction_candidate',
    sourcePageNumber: pageNumber,
    userConfirmed: false
  };
}

function candidateProducts(pageTexts) {
  const pages = Array.isArray(pageTexts) ? pageTexts : [String(pageTexts || '')];
  const seen = new Set();
  const candidates = [];
  pages.forEach((pageText, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const lines = String(pageText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    lines.forEach((line) => {
      if (candidates.length >= 100) return;
      if (!/[\p{L}\d]/u.test(line)) return;
      const key = line.slice(0, 80).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const id = candidates.length + 1;
      const model = (line.match(/[A-Z]{1,6}[-_ ]?\d{2,}[A-Z\d-]*/i) || [])[0] || `PDF-${id}`;
      const costCandidate = parsePurchaseCostCandidate(line, pageNumber);
      const missingFields = ['brand', 'material', 'dimensions'];
      if (!costCandidate) missingFields.push('price');
      else missingFields.push('purchaseCost.unit', 'purchaseCost.incoterm', 'purchaseCost.variant', 'purchaseCost.confirmation');
      const fieldEvidence = [{ field: 'displayName', evidenceId: `pdf-page-${pageNumber}` }, { field: 'model', evidenceId: `pdf-page-${pageNumber}`, text: model }];
      if (costCandidate) fieldEvidence.push({ field: 'purchaseCostCandidate', evidenceId: `pdf-page-${pageNumber}`, text: costCandidate.evidenceText });
      candidates.push({
        candidateId: `candidate-${id}`,
        displayName: line.slice(0, 180),
        model,
        brand: '',
        categoryId: 'category-1',
        variantGroupId: `variant-${id}`,
        fields: costCandidate ? { purchaseCostCandidate: costCandidate } : {},
        fieldEvidence,
        sourcePageNumbers: [pageNumber],
        confidence: costCandidate ? 0.62 : 0.45,
        missingFields,
        duplicateSuspects: [],
        status: 'candidate'
      });
    });
  });
  return candidates.length ? candidates : [{
    candidateId: 'candidate-1', displayName: '未识别产品', model: 'UNRESOLVED-1', brand: '', categoryId: 'category-1',
    variantGroupId: 'variant-1', fields: {}, fieldEvidence: [], sourcePageNumbers: [], confidence: 0,
    missingFields: ['name', 'category', 'specifications'], duplicateSuspects: [], status: 'candidate'
  }];
}

function analyzePdf(filePath) {
  const { pageCount, pageTexts, text } = extractPdfPages(filePath);
  const scanned = text.replace(/\s/g, '').length < 40;
  return {
    documentId: `document-${Date.now().toString(36)}`,
    pageCount,
    languageCandidates: /[\u4e00-\u9fff]/u.test(text) ? ['zh'] : ['en'],
    textMode: scanned ? 'scanned' : 'text',
    extractionQuality: scanned ? 'low' : text.length > 2000 ? 'high' : 'medium',
    ocrRequired: scanned,
    supplierCandidates: [],
    brandCandidates: [],
    categoryHypotheses: hypothesesFor(text),
    productCandidates: candidateProducts(pageTexts),
    variantGroups: [],
    missingFields: ['supplier', 'brand', 'material', 'dimensions', 'price'],
    warnings: scanned ? ['PDF appears scanned or image-only; OCR is required and was not fabricated.'] : [],
    pages: pageTexts.map((pageText, index) => ({ pageNumber: index + 1, text: pageText, evidenceIds: [`pdf-page-${index + 1}`] }))
  };
}

module.exports = { ALLOWED_PDF_TYPES, MAX_PDF_BYTES, MAX_PDF_PAGES, analyzePdf, candidateProducts, parsePurchaseCostCandidate, safePdfName, validatePdfFile };
