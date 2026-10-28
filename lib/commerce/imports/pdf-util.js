'use strict';
/**
 * Shared low-level PDF/image byte utilities for the T1.7 import adapters.
 * Independent, compact helpers (the approved `lib/pdf-catalog.js` is used READ-ONLY as a
 * cross-check in extract-pdf.js; it is never modified): physical object ranges, stream slicing,
 * zlib inflate, page-tree walking/verification (Catalog -> Pages -> Kids) so page numbers are only
 * claimed when the tree order actually matches the physical object order, PDF text-token decoding
 * (hex/literal strings with UTF-16 BOM heuristics), JPEG dimension probe and a minimal real PNG
 * builder (for scanned-PDF sample images). No external dependency.
 */
const zlib = require('node:zlib');

/** Ranges of indirect objects "N G obj ... endobj" in physical file order. */
function objectRanges(raw) {
  const matches = [...raw.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)];
  return matches.map((match, index) => ({
    num: Number(match[1]),
    start: match.index,
    end: index + 1 < matches.length ? matches[index + 1].index : raw.length,
    chunk: raw.slice(match.index, index + 1 < matches.length ? matches[index + 1].index : raw.length)
  }));
}

/** Byte range of a stream's payload inside one object chunk (relative to `raw`). */
function streamSlice(raw, range) {
  const streamIndex = raw.indexOf('stream', range.start);
  if (streamIndex === -1 || streamIndex > range.end) return null;
  let dataStart = streamIndex + 'stream'.length;
  if (raw[dataStart] === '\r') dataStart += 1;
  if (raw[dataStart] === '\n') dataStart += 1;
  const endIndex = raw.indexOf('endstream', dataStart);
  if (endIndex === -1 || endIndex > range.end) return null;
  let dataEnd = endIndex;
  if (raw[dataEnd - 1] === '\n') dataEnd -= 1;
  if (raw[dataEnd - 1] === '\r') dataEnd -= 1;
  if (dataEnd <= dataStart) return null;
  return { dataStart, dataEnd, length: dataEnd - dataStart };
}

function inflate(buffer) {
  if (!buffer.length) return null;
  try { return zlib.inflateSync(buffer); } catch { /* not zlib */ }
  try { return zlib.inflateRawSync(buffer); } catch { /* not raw deflate */ }
  return null;
}

/** Numeric ref value of "/Key N G R" inside one chunk (or null). */
function findRef(chunk, key) {
  const match = chunk.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return match ? Number(match[1]) : null;
}

/** Raw token value of "/Key value" inside one chunk (leading slashes preserved for name values). */
function findDictToken(chunk, key) {
  const match = chunk.match(new RegExp(`/${key}\\s+([^\\s<>\\[\\]]+)`));
  return match ? match[1] : null;
}

/**
 * Walk the page tree (Catalog -> Pages -> Kids) and return the ordered page object numbers.
 * Returns { pageObjectNums, reason } — pageObjectNums is null when the tree cannot be resolved.
 */
function collectPageTree(raw, ranges) {
  const byNum = new Map(ranges.map((range) => [range.num, range]));
  const catalogRange = ranges.find((range) => /\/Type\s*\/Catalog\b/.test(range.chunk));
  let rootNum = catalogRange ? findRef(catalogRange.chunk, 'Pages') : null;
  if (rootNum === null) {
    const rootCandidate = ranges.find((range) => /\/Type\s*\/Pages\b/.test(range.chunk) && !/\/Parent\b/.test(range.chunk));
    rootNum = rootCandidate ? rootCandidate.num : null;
  }
  if (rootNum === null || !byNum.has(rootNum)) return { pageObjectNums: null, reason: 'pages_root_not_found' };
  const visited = new Set();
  const pageObjectNums = [];
  const walk = (num, depth) => {
    if (depth > 32 || visited.has(num)) return false;
    visited.add(num);
    const range = byNum.get(num);
    if (!range) return false;
    if (/\/Type\s*\/Pages\b/.test(range.chunk)) {
      const kidsArray = range.chunk.match(/\/Kids\s*\[([\s\S]*?)\]/);
      const kids = kidsArray ? [...kidsArray[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((item) => Number(item[1])) : [];
      if (kids.length === 0) return false;
      for (const kid of kids) if (!walk(kid, depth + 1)) return false;
      return true;
    }
    if (/\/Type\s*\/Page\b(?!s)/.test(range.chunk)) {
      pageObjectNums.push(num);
      return true;
    }
    return false;
  };
  if (!walk(rootNum, 0) || pageObjectNums.length === 0) return { pageObjectNums: null, reason: 'page_tree_walk_failed' };
  return { pageObjectNums, reason: null };
}

/**
 * Verify page localization: tree order must exist AND equal the physical order of /Type /Page
 * objects; otherwise page numbers are not claimed (null) and only physicalIndex remains.
 */
function verifyPageLocalization(raw, ranges) {
  const physicalObjectNums = [...raw.matchAll(/\/Type\s*\/Page\b(?!s)/g)].map((match) => {
    const range = ranges.find((candidate) => match.index >= candidate.start && match.index < candidate.end);
    return range ? range.num : null;
  });
  const tree = collectPageTree(raw, ranges);
  if (!tree.pageObjectNums) {
    return { status: 'page_tree_unresolved', reason: tree.reason, pageObjectNums: null, physicalObjectNums };
  }
  const sameLength = tree.pageObjectNums.length === physicalObjectNums.length;
  const sameOrder = sameLength && tree.pageObjectNums.every((num, index) => num === physicalObjectNums[index]);
  return {
    status: sameOrder ? 'page_tree_verified' : 'page_tree_order_differs',
    reason: sameOrder ? null : 'physical_order_differs_from_page_tree',
    pageObjectNums: tree.pageObjectNums,
    physicalObjectNums
  };
}

// ---------- compact PDF text decoding (hex/literal strings, UTF-16 BOM heuristics) ----------

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
/** BOM + zero-ratio heuristics; latin1 fallback. No CID cmaps (documented unsupported here). */
function decodeBytesSmart(buffer) {
  if (!buffer.length) return '';
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
function decodeToken(token) {
  if (token.startsWith('(')) return decodeBytesSmart(literalBytes(token.slice(1, -1)));
  if (token.startsWith('<')) return decodeBytesSmart(hexBytes(token.slice(1, -1)));
  if (token.startsWith('[')) {
    let result = '';
    [...token.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g)].forEach((part) => { result += decodeToken(part[0]); });
    return result;
  }
  return '';
}
/** Split one content stream into text lines (Td/TD/T-star/ET act as line breaks). */
function textLinesFromContent(content) {
  const parts = [];
  const pattern = /(\[(?:\\.|[^\\[\]])*\]|\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)\s*(?:Tj|TJ|'|")|(\bTd\b|\bTD\b|\bT\*\b|\bET\b)/g;
  let match;
  let current = '';
  while ((match = pattern.exec(content))) {
    if (match[1]) current += decodeToken(match[1]);
    else { parts.push(current); current = ''; }
  }
  if (current) parts.push(current);
  return parts.map((part) => part.replace(/[ \t]+/g, ' ').trim()).filter((part) => part.length > 0);
}

/** JPEG SOF dimensions probe (null when no SOF marker / not a JPEG). */
function jpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let index = 2;
  while (index < bytes.length - 1) {
    if (bytes[index] !== 0xff) { index += 1; continue; }
    const marker = bytes[index + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { index += 2; continue; }
    if (index + 4 > bytes.length) return null;
    const length = bytes.readUInt16BE(index + 2);
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && index + 9 <= bytes.length) {
      return { height: bytes.readUInt16BE(index + 5), width: bytes.readUInt16BE(index + 7) };
    }
    index += 2 + length;
  }
  return null;
}

// ---------- minimal real PNG builder (for scanned-PDF sample images) ----------

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) c = CRC_TABLE[(c ^ buffer[index]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}
/** Build a real 8-bit PNG from raw samples (channels 1 = gray, 3 = RGB). */
function buildPng(width, height, samples, channels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('png dims invalid');
  if (![1, 3].includes(channels)) throw new Error('png channels must be 1 or 3');
  if (samples.length !== width * height * channels) throw new Error('png sample length mismatch');
  const colorType = channels === 1 ? 0 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    samples.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
/** PNG IHDR dimensions probe. */
function pngInfo(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

module.exports = {
  objectRanges,
  streamSlice,
  inflate,
  findRef,
  findDictToken,
  collectPageTree,
  verifyPageLocalization,
  textLinesFromContent,
  jpegInfo,
  buildPng,
  pngInfo
};
