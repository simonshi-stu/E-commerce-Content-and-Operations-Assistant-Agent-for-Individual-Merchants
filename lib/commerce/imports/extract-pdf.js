'use strict';
/**
 * Text-PDF import adapter (T1.7 clause A). Reads REAL bytes and extracts page text with honest
 * localization:
 * - page order follows the actual PAGE TREE (Catalog -> Pages -> Kids) when it can be walked
 *   (tree order is the spec's page order — this adapter therefore uses tree order and reports
 *   when the physical object order differs from it); when the tree cannot be resolved, extraction
 *   follows physical object order and page numbers are NOT claimed (pageNumber null, physicalIndex
 *   kept) — a page is never faked as page 1.
 * - The approved `lib/pdf-catalog.js` is called READ-ONLY as an independent cross-check
 *   (`analyzePdf`); it is never modified. Its 4000-char per-page cap is recorded, and this
 *   adapter applies its own larger cap with an explicit `truncatedAtCap` flag instead of silently
 *   pretending completeness.
 * - scanned / insufficient-text documents are classified as `scanned` and produce no text
 *   candidates (the scan path in extract-scan.js must be used explicitly).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const pdfCatalog = require('../../pdf-catalog.js');
const pdfUtil = require('./pdf-util.js');

const PARSER_VERSION = 'imports/pdf-text@v1';
const MAX_PAGE_TEXT_CHARS = 20000; // this adapter's explicit cap (silent truncation is never claimed)
const EXISTING_PARSER_CAP = 4000; // pdf-catalog per-page cap (recorded, not exceeded silently by us)
const SCANNED_TEXT_THRESHOLD = 40;

function pageContentRefs(chunk) {
  const refs = [];
  const single = chunk.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
  if (single) refs.push(Number(single[1]));
  const array = chunk.match(/\/Contents\s*\[([\s\S]*?)\]/);
  if (array) [...array[1].matchAll(/(\d+)\s+\d+\s+R/g)].forEach((item) => refs.push(Number(item[1])));
  return refs;
}

/** Extract one page's text lines from its own content streams (real bytes). */
function pageTextFromObject(raw, buffer, range, byNum) {
  const refs = pageContentRefs(range.chunk);
  const lines = [];
  for (const ref of refs) {
    const contentRange = byNum.get(ref);
    if (!contentRange) continue;
    const slice = pdfUtil.streamSlice(raw, contentRange);
    if (!slice) continue;
    const payload = buffer.subarray(slice.dataStart, slice.dataEnd);
    const decoded = /\/FlateDecode\b/.test(contentRange.chunk) ? pdfUtil.inflate(payload) : payload;
    if (!decoded) continue;
    for (const line of pdfUtil.textLinesFromContent(decoded.toString('latin1'))) lines.push(line);
  }
  return lines;
}

function extractTextPdf(filePath) {
  const bytes = fs.readFileSync(filePath);
  const rawSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const raw = bytes.toString('latin1');
  const ranges = pdfUtil.objectRanges(raw);
  const byNum = new Map(ranges.map((range) => [range.num, range]));
  const localization = pdfUtil.verifyPageLocalization(raw, ranges);

  const treeOrder = Array.isArray(localization.pageObjectNums) && localization.pageObjectNums.length > 0;
  const orderedRanges = treeOrder
    ? localization.pageObjectNums.map((num) => byNum.get(num)).filter(Boolean)
    : ranges.filter((range) => /\/Type\s*\/Page\b(?!s)/.test(range.chunk));

  const pages = orderedRanges.map((range, index) => {
    const lines = pageTextFromObject(raw, bytes, range, byNum);
    let text = lines.join('\n');
    const truncatedAtCap = text.length >= MAX_PAGE_TEXT_CHARS;
    if (truncatedAtCap) text = text.slice(0, MAX_PAGE_TEXT_CHARS);
    return {
      pageNumber: treeOrder ? index + 1 : null, // page numbers only from a walked page tree
      physicalIndex: index,
      objectNumber: range.num,
      lines,
      text,
      truncatedAtCap
    };
  });

  const normalized = pages.map((page) => page.text).join('').replace(/\s/g, '');
  const textMode = normalized.length < SCANNED_TEXT_THRESHOLD ? 'scanned' : 'text';

  // READ-ONLY cross-check against the approved existing parser (never a substitute for real bytes).
  const analysis = pdfCatalog.analyzePdf(filePath);
  const crossCheck = {
    parser: 'pdf-catalog.analyzePdf',
    parserPageCount: analysis.pageCount,
    parserTextMode: analysis.textMode,
    agreed: analysis.pageCount === pages.length && (analysis.textMode === 'scanned') === (textMode === 'scanned'),
    notes: []
  };
  if (analysis.pageCount !== pages.length) crossCheck.notes.push(`page count differs: pdf-catalog=${analysis.pageCount}, adapter=${pages.length}`);
  if (localization.status === 'page_tree_order_differs') crossCheck.notes.push('existing parser reads pages in physical object order; this adapter follows the page tree (spec page order)');
  if (textMode === 'scanned') crossCheck.notes.push('no extractable text runs; scan path (extract-scan.js) is required for images');

  const warnings = [];
  if (!treeOrder) warnings.push(`page tree not resolved (${localization.status}); page numbers withheld (physicalIndex only)`);
  if (localization.status === 'page_tree_order_differs') warnings.push('physical object order differs from page tree; adapter page numbers follow the page tree');
  if (pages.some((page) => page.truncatedAtCap)) warnings.push(`page text reached the ${MAX_PAGE_TEXT_CHARS}-char adapter cap (truncatedAtCap=true)`);

  return {
    rawSha256,
    byteSize: bytes.length,
    format: 'pdf_text',
    parserVersion: PARSER_VERSION,
    pageCount: pages.length,
    textMode,
    pages,
    localization,
    crossCheck,
    caps: { adapterCap: MAX_PAGE_TEXT_CHARS, existingParserCap: EXISTING_PARSER_CAP },
    warnings
  };
}

module.exports = {
  PARSER_VERSION,
  MAX_PAGE_TEXT_CHARS,
  extractTextPdf
};
