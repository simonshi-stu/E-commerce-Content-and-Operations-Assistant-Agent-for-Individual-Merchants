'use strict';
/**
 * Scan/image import adapter (T1.7 clause B). Real image bytes only:
 * - PDF: image XObjects are read from their real streams — `/DCTDecode` payloads are the actual
 *   JPEG bytes; `/FlateDecode` (Predictor None, 8 bpc, DeviceGray/DeviceRGB) payloads are inflated
 *   and converted into a real PNG. JPX/JBIG2/CCITT/word predictors/other color spaces are
 *   explicitly unsupported (never silently skipped). Pages follow the verified page tree; page
 *   numbers are withheld (null) when the tree cannot be resolved.
 * - Standalone PNG/JPEG files are read directly.
 * - The OCR step reuses the approved T2.5 S1 vision tool for REAL request construction
 *   (`buildS1Request`: exactly one image at detail low, the same 400/2833/3300/300 limits) with an
 *   injected fixture transport only — default closed. A fixture OCR response is a PROTOCOL
 *   validation, never a recognition-rate or live-vision claim. Invalid/pending pages stay unknown.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildS1Request, createOpenAiCompatibleProvider } = require('../providers/openai-compatible.js');
const pdfUtil = require('./pdf-util.js');

const SCAN_PARSER_VERSION = 'imports/scan-s1@v1';
const DEFAULT_MAX_PAGES = 3; // per-CALL processed-image bound (applied by importScan)
const PAGE_HARD_CAP = 20;
const TOTAL_IMAGE_CAP = 100; // reader hard cap on enumerated images per document
const SCAN_PROMPT = 'Read the visible supplier text lines from this scanned page. Reply with JSON only, per the declared schema.';
const SCAN_OCR_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 500 },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function detectImageFormat(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  return null;
}

/** Read one PDF image XObject into real image bytes (or an explicit unsupported status). */
function describeImageObject(range, raw, buffer) {
  const chunk = range.chunk;
  const width = Number(pdfUtil.findDictToken(chunk, 'Width'));
  const height = Number(pdfUtil.findDictToken(chunk, 'Height'));
  const filterToken = pdfUtil.findDictToken(chunk, 'Filter');
  const filter = filterToken ? filterToken.replace(/^\//, '') : null;
  const colorSpace = (pdfUtil.findDictToken(chunk, 'ColorSpace') || '').replace(/^\//, '');
  const bitsPerComponent = Number(pdfUtil.findDictToken(chunk, 'BitsPerComponent') ?? 8);
  const predictorMatch = chunk.match(/\/Predictor\s+(\d+)/);
  const predictor = predictorMatch ? Number(predictorMatch[1]) : 1;
  const slice = pdfUtil.streamSlice(raw, range);
  if (!slice) return { status: 'unsupported', reason: 'image_stream_missing' };
  const payload = buffer.subarray(slice.dataStart, slice.dataEnd);
  if (filter === 'DCTDecode') {
    const info = pdfUtil.jpegInfo(payload);
    if (!info) return { status: 'unsupported', reason: 'dct_payload_not_jpeg' };
    return { status: 'ok', mediaType: 'image/jpeg', bytes: Buffer.from(payload), imageSha256: sha256(payload), width: info.width, height: info.height, filter };
  }
  if (filter === null || filter === 'FlateDecode') {
    if (predictor !== 1) return { status: 'unsupported', reason: 'predictor_unsupported' };
    if (colorSpace !== 'DeviceGray' && colorSpace !== 'DeviceRGB') return { status: 'unsupported', reason: 'colorspace_unsupported' };
    if (bitsPerComponent !== 8) return { status: 'unsupported', reason: 'bitdepth_unsupported' };
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return { status: 'unsupported', reason: 'dims_unknown' };
    const channels = colorSpace === 'DeviceGray' ? 1 : 3;
    const samples = filter === 'FlateDecode' ? pdfUtil.inflate(payload) : payload;
    if (!samples || samples.length !== width * height * channels) return { status: 'unsupported', reason: 'samples_mismatch' };
    const png = pdfUtil.buildPng(width, height, samples, channels);
    return { status: 'ok', mediaType: 'image/png', bytes: png, imageSha256: sha256(png), width, height, filter: filter ?? 'none', convertedFromSamples: filter === 'FlateDecode' };
  }
  return { status: 'unsupported', reason: `filter_unsupported:${filter}` };
}

/**
 * Read ALL real scan images from a scanned PDF or a standalone image file (reader cap
 * TOTAL_IMAGE_CAP). The per-CALL processing bound (`maxPages`) is applied by imports.importScan —
 * this reader never truncates silently, so coverage/truncation stays computable.
 */
function readScanImages(filePath, options = {}) {
  const bytes = fs.readFileSync(filePath);
  const rawSha256 = sha256(bytes);
  const standalone = detectImageFormat(bytes);
  if (standalone) {
    const info = standalone === 'png' ? pdfUtil.pngInfo(bytes) : pdfUtil.jpegInfo(bytes);
    if (!info) return { rawSha256, byteSize: bytes.length, kind: 'image', format: standalone, pageTree: null, images: [], notes: ['image dimensions not readable'] };
    return {
      rawSha256,
      byteSize: bytes.length,
      kind: 'image',
      format: standalone,
      pageTree: null,
      images: [{
        index: 0,
        pageNumber: null,
        physicalIndex: 0,
        objectNumber: null,
        status: 'ok',
        mediaType: standalone === 'png' ? 'image/png' : 'image/jpeg',
        bytes: Buffer.from(bytes),
        imageSha256: rawSha256,
        width: info.width,
        height: info.height,
        source: 'standalone_image'
      }],
      imageCount: 1,
      enumerated: 1,
      omitted: 0,
      truncated: false
    };
  }
  if (!(bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-')) {
    return { rawSha256, byteSize: bytes.length, kind: 'unknown', format: null, pageTree: null, images: [], notes: ['not a PDF and not a PNG/JPEG image'] };
  }
  const raw = bytes.toString('latin1');
  const ranges = pdfUtil.objectRanges(raw);
  const byNum = new Map(ranges.map((range) => [range.num, range]));
  const localization = pdfUtil.verifyPageLocalization(raw, ranges);
  const treeOrder = Array.isArray(localization.pageObjectNums) && localization.pageObjectNums.length > 0;
  const pageRanges = treeOrder
    ? localization.pageObjectNums.map((num) => byNum.get(num)).filter(Boolean)
    : ranges.filter((range) => /\/Type\s*\/Page\b(?!s)/.test(range.chunk));
  const images = [];
  let omitted = 0;
  pageRanges.forEach((range, pageIndex) => {
    const xobjectArray = range.chunk.match(/\/XObject\s*<<([\s\S]*?)>>/);
    const refs = xobjectArray ? [...xobjectArray[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1])) : [];
    for (const ref of refs) {
      const imageRange = byNum.get(ref);
      if (!imageRange || !/\/Subtype\s*\/Image\b/.test(imageRange.chunk)) continue;
      if (images.length >= TOTAL_IMAGE_CAP) { omitted += 1; continue; }
      const described = describeImageObject(imageRange, raw, bytes);
      images.push({
        index: images.length,
        pageNumber: treeOrder ? pageIndex + 1 : null,
        physicalIndex: pageIndex,
        objectNumber: ref,
        source: 'pdf_xobject',
        ...described
      });
    }
  });
  const found = images.length + omitted;
  return {
    rawSha256,
    byteSize: bytes.length,
    kind: 'scan_pdf',
    format: 'pdf',
    pageTree: localization,
    images,
    imageCount: found,
    enumerated: images.length,
    omitted,
    truncated: omitted > 0,
    notes: [
      `${found} image object(s) found${omitted > 0 ? `; ${omitted} omitted by the reader cap (${TOTAL_IMAGE_CAP}) — this document can never be reported complete` : ''} (per-call processing bound is applied by importScan)`,
      ...(treeOrder ? [] : [`page tree not resolved (${localization.status}); page numbers withheld`])
    ]
  };
}

/** Bounding-box validation against the real image dimensions; invalid regions are dropped, text kept. */
function validateBbox(line, image) {
  const hasAny = ['x', 'y', 'w', 'h'].some((key) => line[key] !== undefined);
  if (!hasAny) return { bbox: null, regionReason: null };
  const complete = ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(line[key]));
  if (!complete || !Number.isFinite(image.width) || !Number.isFinite(image.height)) return { bbox: null, regionReason: 'region_incomplete' };
  if (line.x < 0 || line.y < 0 || line.w <= 0 || line.h <= 0 || line.x + line.w > image.width || line.y + line.h > image.height) {
    return { bbox: null, regionReason: 'region_out_of_bounds' };
  }
  return { bbox: { x: line.x, y: line.y, w: line.w, h: line.h, unit: 'px' }, regionReason: null };
}

/**
 * Run the fixture-injected S1 vision protocol on one real image. Default closed: no transport =>
 * blocked with a manual-entry hint; nothing is called. The structured execution identity
 * (`operationId`/`attemptToken`, per image/attempt — never one global hardcoded attempt) and any
 * supplied opaque `remoteId` are returned EXACTLY (no trim/hash/guess) for every outcome, so an
 * unknown/pending upstream result stays traceable across SQLite reopen.
 */
async function runScanOcr(image, options = {}) {
  const operationId = options.operationId ?? `scan:${image.imageSha256 ?? 'unknown'}`;
  const attemptToken = options.attemptToken ?? `scan-attempt:${image.index ?? 0}:1`;
  if (typeof options.transport !== 'function') {
    return { status: 'blocked', reason: 'scan_ocr_unavailable', manualEntryAllowed: true, requestSummary: null, lines: [], remoteId: null, operationId, attemptToken };
  }
  const { summary } = buildS1Request({
    tool: 'vision.understand',
    input: { prompt: SCAN_PROMPT, image: { mediaType: image.mediaType, bytesBase64: image.bytes.toString('base64') } }
  });
  const adapter = createOpenAiCompatibleProvider({ mode: 'fixture', transport: options.transport, outputSchema: SCAN_OCR_OUTPUT_SCHEMA });
  const result = await adapter.invoke({
    tool: 'vision.understand',
    input: { prompt: SCAN_PROMPT, image: { mediaType: image.mediaType, bytesBase64: image.bytes.toString('base64') } },
    operationId,
    attemptToken
  });
  const refs = { remoteId: result.remoteId ?? null, operationId: result.operationId ?? operationId, attemptToken: result.attemptToken ?? attemptToken };
  if (result.status === 'succeeded') {
    const lines = result.output.lines.map((line, lineIndex) => {
      const region = validateBbox(line, image);
      return { lineIndex, text: line.text, bbox: region.bbox, regionReason: region.regionReason };
    });
    return { status: 'ocr_succeeded', lines, requestSummary: summary, usage: result.usage ?? null, ...refs };
  }
  if (result.status === 'failed_invalid_output') return { status: 'ocr_invalid', reason: result.reason, requestSummary: summary, lines: [], ...refs };
  if (result.status === 'pending_reconcile' || result.status === 'pending') return { status: 'ocr_pending', reason: result.reason ?? 'pending', requestSummary: summary, lines: [], ...refs };
  if (result.status === 'blocked') return { status: 'ocr_blocked', reason: result.reason, requestSummary: summary, lines: [], ...refs };
  return { status: 'ocr_unknown', reason: result.status, requestSummary: summary, lines: [], ...refs };
}

module.exports = {
  SCAN_PARSER_VERSION,
  DEFAULT_MAX_PAGES,
  PAGE_HARD_CAP,
  SCAN_PROMPT,
  SCAN_OCR_OUTPUT_SCHEMA,
  detectImageFormat,
  describeImageObject,
  readScanImages,
  validateBbox,
  runScanOcr
};
