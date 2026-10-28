'use strict';
/**
 * Shop-materials asset index: read-only scanning, real format handling, content-hash dedup with
 * independent source paths, data-driven product-family association and strictly scoped retrieval.
 *
 * Capability contract (no external dependencies, no installs):
 * - detectFormat/parseImage recognize real bytes (magic + structured headers) for png/jpeg/gif/
 *   webp/bmp; dimensions and alpha come from those parsed structures, not from file extensions.
 * - decodePng performs a REAL pixel decode for non-interlaced 8-bit PNG (gray/RGB/gray-alpha/RGBA
 *   and 8-bit palette) using node:zlib: chunk CRCs are verified, scanlines are unfiltered and
 *   expanded to RGBA, and tRNS transparency is honored for palette, 8-bit gray and 8-bit RGB.
 *   parseImage itself always reports `decode: 'header'` (structural parse only); a pixel decode is
 *   only claimed by decodePng/pixelSignature success, and scanDirectory persists
 *   `image.pixelDecode` plus `image.decodeStatus`/`decodeReason` per file
 *   (pixel_decoded / pixel_unsupported / header_only / header_defect) so unsupported or failed
 *   decodes are never presented as successes. Decode failures are caught per file: a defective
 *   file (missing IDAT, corrupt compressed data, bad scanlines) is marked `image_defect` with the
 *   reason while the scan continues and valid peers stay indexed; capability-limited variants
 *   (e.g. interlaced) stay indexed with pixel_unsupported.
 * - JPEG/GIF/WebP/BMP are header-parsed only (dimensions/alpha flags); they are NOT pixel-decoded.
 *   PDF/MP4 are metadata-level only (version + page-object markers; ftyp/mvhd duration/tracks) and
 *   never claim a full content read or playback.
 * - Dedup: one content object per sha256, every source path kept independently; re-indexing the
 *   same bytes is idempotent. Different hashes are NOT evidence of different designs.
 * - Association is data-driven: the caller injects a private mapping (folder -> family/source-set,
 *   path hints for roles/usages/languages, candidate SKU tokens). Nothing product-specific lives in
 *   this module. Unknown stays unknown/candidate; compliance documents never bind unit compliance.
 * - Version hashes: buildIndex exposes rawIndexHash (canonical hash of the raw scan projection);
 *   associate recomputes stableHash over the public stable projection that includes the associated
 *   file fields and the association summary, so changing family/role/usage/SKU/sourceSet changes
 *   the associated version hash. Association never mutates the raw index.
 * - Retrieval requires an explicit familyKey and never falls back across product families.
 *
 * DEV NOTE: development task state (PROGRESS.json) is unrelated to business `runs` state.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { ValidationError } = require('./evidence.js');
const { canonicalJson } = require('./packs.js');

const IMAGE_FORMATS = Object.freeze(['png', 'jpeg', 'gif', 'webp', 'bmp']);
const FORMAT_DEFAULT_ROLES = Object.freeze({ mp4: 'video', pdf: 'reference' });

function fail(message) {
  throw new ValidationError(message);
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
  return value.trim();
}
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// ---------- crc32 (PNG chunk validation; also used by synthetic fixtures) ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- format detection ----------
function detectFormat(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 6) {
    const head = buffer.slice(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  if (buffer.length >= 5 && buffer.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.length >= 12 && buffer.slice(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  return 'unknown';
}

// ---------- image parsing ----------
function readPngChunks(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('bad PNG signature');
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.slice(offset + 4, offset + 8).toString('latin1');
    if (offset + 12 + length > buffer.length) throw new Error(`truncated PNG chunk ${type}`);
    const data = buffer.slice(offset + 8, offset + 8 + length);
    const expected = buffer.readUInt32BE(offset + 8 + length);
    const actual = crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]));
    if (expected !== actual) throw new Error(`PNG chunk ${type} CRC mismatch`);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}
function parsePngHeader(buffer) {
  const chunks = readPngChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) throw new Error('missing PNG IHDR');
  const colorType = ihdr.data[9];
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType,
    interlace: ihdr.data[12],
    alpha: colorType === 4 || colorType === 6 || chunks.some((chunk) => chunk.type === 'tRNS')
  };
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function unfilterRow(filter, row, out, prev, bpp) {
  if (filter < 0 || filter > 4) throw new Error(`unsupported PNG filter ${filter}`);
  for (let i = 0; i < row.length; i++) {
    const x = row[i];
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let value = x;
    if (filter === 1) value = x + a;
    else if (filter === 2) value = x + b;
    else if (filter === 3) value = x + Math.floor((a + b) / 2);
    else if (filter === 4) value = x + paeth(a, b, c);
    out[i] = value & 0xff;
  }
}
/** Real pixel decode for non-interlaced 8-bit PNG; returns RGBA bytes or an unsupported/defect reason. */
function decodePng(buffer) {
  let chunks;
  try {
    chunks = readPngChunks(buffer);
  } catch (error) {
    return { supported: false, defect: true, reason: error.message };
  }
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) return { supported: false, defect: true, reason: 'missing PNG IHDR' };
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (!channels) return { supported: false, defect: false, reason: `unsupported PNG color type ${colorType}` };
  if (interlace !== 0) return { supported: false, defect: false, reason: 'interlaced PNG is not supported' };
  if (bitDepth !== 8) return { supported: false, defect: false, reason: `unsupported PNG bit depth ${bitDepth}` };
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (idat.length === 0) return { supported: false, defect: true, reason: 'missing PNG IDAT' };
  let raw;
  try {
    raw = zlib.inflateSync(idat);
  } catch (error) {
    return { supported: false, defect: true, reason: `PNG inflate failed: ${error.message}` };
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return { supported: false, defect: true, reason: 'truncated PNG scanlines' };
  const pixels = Buffer.alloc(stride * height);
  try {
    let src = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[src++];
      const row = raw.slice(src, src + stride);
      src += stride;
      const out = pixels.slice(y * stride, (y + 1) * stride);
      unfilterRow(filter, row, out, y === 0 ? null : pixels.slice((y - 1) * stride, y * stride), channels);
    }
  } catch (error) {
    return { supported: false, defect: true, reason: `PNG scanline decode failed: ${error.message}` };
  }
  const plte = colorType === 3 ? chunks.find((chunk) => chunk.type === 'PLTE')?.data : null;
  const trns = chunks.find((chunk) => chunk.type === 'tRNS')?.data ?? null;
  if (colorType === 3 && !plte) return { supported: false, defect: true, reason: 'palette PNG without PLTE' };
  const grayKey = colorType === 0 && trns && trns.length >= 2 ? trns[1] : null;
  const rgbKey = colorType === 2 && trns && trns.length >= 6 ? [trns[1], trns[3], trns[5]] : null;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (colorType === 0) {
      const g = pixels[i];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = grayKey !== null && g === grayKey ? 0 : 255;
    } else if (colorType === 2) {
      const r = pixels[i * 3];
      const g = pixels[i * 3 + 1];
      const b = pixels[i * 3 + 2];
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
      rgba[o + 3] = rgbKey !== null && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2] ? 0 : 255;
    } else if (colorType === 4) {
      const g = pixels[i * 2];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = pixels[i * 2 + 1];
    } else if (colorType === 6) {
      pixels.copy(rgba, o, i * 4, i * 4 + 4);
    } else {
      const index = pixels[i];
      rgba[o] = plte[index * 3]; rgba[o + 1] = plte[index * 3 + 1]; rgba[o + 2] = plte[index * 3 + 2];
      rgba[o + 3] = trns && index < trns.length ? trns[index] : 255;
    }
  }
  return { supported: true, width, height, channels, rgba };
}
function pixelSignature(buffer) {
  const decoded = decodePng(buffer);
  if (!decoded.supported) return { supported: false, defect: decoded.defect, reason: decoded.reason };
  return { supported: true, width: decoded.width, height: decoded.height, bytes: decoded.rgba.length, rgbaSha256: sha256(decoded.rgba) };
}
function parseJpegHeader(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
    if (marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        components: buffer[offset + 9],
        progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce,
        alpha: false
      };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG SOF marker not found');
}
function parseGifHeader(buffer) {
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), alpha: null };
}
function parseWebpHeader(buffer) {
  const type = buffer.slice(12, 16).toString('latin1');
  if (type === 'VP8X') {
    const flags = buffer[20];
    return {
      width: 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16),
      height: 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16),
      alpha: (flags & 0x10) !== 0
    };
  }
  if (type === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, alpha: true };
  }
  if (type === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, alpha: false };
  }
  throw new Error(`unsupported WebP chunk ${type}`);
}
function parseBmpHeader(buffer) {
  const width = buffer.readInt32LE(18);
  const height = buffer.readInt32LE(22);
  return { width: Math.abs(width), height: Math.abs(height), alpha: buffer[28] === 32 };
}
/** Structured header parse; never claims pixel decode for jpeg/gif/webp/bmp. */
function parseImage(buffer) {
  const format = detectFormat(buffer);
  if (!IMAGE_FORMATS.includes(format)) return { format, image: false, supported: false, reason: 'not a recognized image format' };
  try {
    if (format === 'png') return { format, image: true, supported: true, decode: 'header', ...parsePngHeader(buffer) };
    if (format === 'jpeg') return { format, image: true, supported: true, decode: 'header', ...parseJpegHeader(buffer) };
    if (format === 'gif') return { format, image: true, supported: true, decode: 'header', ...parseGifHeader(buffer) };
    if (format === 'webp') return { format, image: true, supported: true, decode: 'header', ...parseWebpHeader(buffer) };
    return { format, image: true, supported: true, decode: 'header', ...parseBmpHeader(buffer) };
  } catch (error) {
    return { format, image: true, supported: false, reason: error.message };
  }
}

// ---------- pdf / mp4 metadata (metadata-level only) ----------
function parsePdfMetadata(buffer) {
  const head = buffer.slice(0, 1024).toString('latin1');
  const match = /^%PDF-(\d+\.\d+)/.exec(head);
  if (!match) throw new Error('missing %PDF header');
  const text = buffer.toString('latin1');
  const pageMarkerCount = (text.match(/\/Type\s*\/Page(?![sA-Za-z])/g) || []).length;
  return { pdfVersion: match[1], pageMarkerCount, note: 'metadata-level: header + page-object markers; content not read' };
}
function parseMp4Metadata(buffer) {
  let majorBrand = null;
  let timescale = null;
  let duration = null;
  let trackCount = 0;
  const walk = (start, end, depth) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.slice(offset + 4, offset + 8).toString('latin1');
      let header = 8;
      if (size === 1 && offset + 16 <= end) { size = Number(buffer.readBigUInt64BE(offset + 8)); header = 16; }
      if (size < header || offset + size > end) break;
      if (type === 'ftyp') majorBrand = buffer.slice(offset + 8, offset + 12).toString('latin1');
      if (type === 'trak') trackCount++;
      if (type === 'mvhd') {
        const version = buffer[offset + header];
        if (version === 0) {
          timescale = buffer.readUInt32BE(offset + header + 12);
          duration = buffer.readUInt32BE(offset + header + 16);
        } else if (version === 1) {
          timescale = buffer.readUInt32BE(offset + header + 20);
          duration = Number(buffer.readBigUInt64BE(offset + header + 24));
        }
      }
      if ((type === 'moov' || type === 'trak' || type === 'mdia') && depth < 4) walk(offset + header, offset + size, depth + 1);
      offset += size;
    }
  };
  walk(0, buffer.length, 0);
  if (!majorBrand) throw new Error('missing MP4 ftyp box');
  return {
    majorBrand,
    timescale,
    durationSeconds: timescale && duration !== null ? Number((duration / timescale).toFixed(3)) : null,
    trackCount,
    note: 'metadata-level: ftyp/mvhd box parse; no playback or full content read'
  };
}

// ---------- directory scanning (read-only) ----------
function walkFiles(sourceRoot, onFile) {
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(sourceRoot, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) onFile(absolute, relPath);
    }
  };
  walk(sourceRoot);
}
/** Content fingerprint of the whole directory (every file, ignored ones included). */
function fingerprintDirectory(sourceRoot) {
  const lines = [];
  let fileCount = 0;
  let totalBytes = 0;
  walkFiles(sourceRoot, (absolute, relPath) => {
    const buffer = fs.readFileSync(absolute);
    fileCount++;
    totalBytes += buffer.length;
    lines.push(`${relPath}\t${buffer.length}\t${sha256(buffer)}`);
  });
  lines.sort();
  return { fileCount, totalBytes, fingerprint: sha256(Buffer.from(lines.join('\n'))) };
}
/**
 * Read-only scan: hash/size/real format per file; images parsed (PNG also pixel-decodable on
 * demand), PDF/MP4 metadata-level, unknown formats marked unrecognized. `.WeDrive` entries are
 * recorded but flagged as ignored (design-tool metadata, not business material).
 */
function scanDirectory(sourceRoot, options = {}) {
  const records = [];
  const ignoreFile = options.ignoreFile ?? ((name) => name === '.WeDrive');
  walkFiles(sourceRoot, (absolute, relPath) => {
    const buffer = fs.readFileSync(absolute);
    const record = { relPath, size: buffer.length, sha256: sha256(buffer), format: detectFormat(buffer), status: 'indexed' };
    if (ignoreFile(path.basename(relPath))) {
      record.status = 'ignored';
      record.ignored = true;
      record.ignoreReason = 'design-tool metadata, not business material';
    } else if (IMAGE_FORMATS.includes(record.format)) {
      record.image = parseImage(buffer);
      if (record.image.supported === false) {
        record.status = 'image_defect';
        record.image.decodeStatus = 'header_defect';
        record.image.decodeReason = record.image.reason;
      } else if (record.format === 'png') {
        let pixel;
        try {
          pixel = pixelSignature(buffer);
        } catch (error) {
          pixel = { supported: false, defect: true, reason: `pixel decode threw: ${error.message}` };
        }
        record.image.pixelDecode = pixel;
        record.image.decodeStatus = pixel.supported ? 'pixel_decoded' : 'pixel_unsupported';
        if (!pixel.supported) {
          record.image.decodeReason = pixel.reason;
          if (pixel.defect === true) record.status = 'image_defect';
        }
      } else {
        record.image.decodeStatus = 'header_only';
      }
    } else if (record.format === 'pdf') {
      try { record.pdf = parsePdfMetadata(buffer); } catch (error) { record.status = 'metadata_defect'; record.metadataError = error.message; }
    } else if (record.format === 'mp4') {
      try { record.mp4 = parseMp4Metadata(buffer); } catch (error) { record.status = 'metadata_defect'; record.metadataError = error.message; }
    } else {
      record.status = 'unrecognized_format';
    }
    records.push(record);
  });
  return records;
}

// ---------- index building ----------
function stableProjection(index) {
  return {
    sourceRootId: index.sourceRootId,
    files: index.files,
    contentObjects: index.contentObjects,
    statusCounts: index.statusCounts,
    formats: index.formats,
    ignoredCount: index.ignoredCount,
    association: index.association ?? null
  };
}
function buildIndex({ sourceRootId, sourceRoot, records, scannedAt = new Date().toISOString() }) {
  const rootId = requireNonEmptyString(sourceRootId, 'sourceRootId');
  const files = [...records].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const contentMap = new Map();
  for (const record of files) {
    if (record.ignored) continue;
    if (!contentMap.has(record.sha256)) contentMap.set(record.sha256, { sha256: record.sha256, size: record.size, format: record.format, paths: [] });
    contentMap.get(record.sha256).paths.push(record.relPath);
  }
  const contentObjects = [...contentMap.values()]
    .map((object) => ({ ...object, paths: [...object.paths].sort(), sourceCount: object.paths.length }))
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
  const statusCounts = {};
  const formats = {};
  for (const record of files) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
    if (!record.ignored) formats[record.format] = (formats[record.format] ?? 0) + 1;
  }
  const index = {
    schemaVersion: 1,
    kind: 'shop-materials-index',
    sourceRootId: rootId,
    sourceRoot,
    scannedAt,
    files,
    contentObjects,
    statusCounts,
    formats,
    ignoredCount: files.filter((record) => record.ignored).length
  };
  index.stableHash = sha256(Buffer.from(canonicalJson(stableProjection(index))));
  index.rawIndexHash = index.stableHash;
  return index;
}

// ---------- association (data-driven; private mapping injected by the caller) ----------
function associate(index, mapping = {}) {
  const folders = mapping.folders ?? {};
  const pathHints = mapping.pathHints ?? [];
  const skuTokens = mapping.skuTokens ?? [];
  const files = index.files.map((record) => {
    if (record.ignored) {
      return { ...record, familyKey: null, role: 'ignored', roleStatus: 'not_applicable', roleBasis: 'ignored', language: 'unknown', usageCandidates: [], skuCandidates: [], designSetId: null, ratio: null, complianceBinding: false };
    }
    const segments = record.relPath.split('/');
    const top = segments[0];
    const folder = folders[top];
    const familyKey = folder?.familyKey ?? null;
    let role = null;
    let roleBasis = null;
    let language = null;
    let usages = [];
    const skuCandidates = [];
    for (const hint of pathHints) {
      if (!record.relPath.includes(hint.token)) continue;
      if (hint.role) { role = hint.role; roleBasis = `path-token:${hint.token}`; }
      if (hint.usages) usages = [...new Set([...usages, ...hint.usages])];
      if (hint.language) language = hint.language;
    }
    for (const token of skuTokens) if (record.relPath.includes(token.token)) skuCandidates.push(token.skuCandidate);
    if (!role) {
      role = FORMAT_DEFAULT_ROLES[record.format] ?? 'unknown';
      roleBasis = FORMAT_DEFAULT_ROLES[record.format] ? `format-default:${record.format}` : 'unknown';
    }
    const ratio = record.image?.width && record.image?.height ? Number((record.image.width / record.image.height).toFixed(4)) : null;
    return {
      ...record,
      familyKey,
      role,
      roleStatus: 'candidate',
      roleBasis,
      language: language ?? 'unknown',
      usageCandidates: usages,
      skuCandidates: [...new Set(skuCandidates)],
      skuStatus: skuCandidates.length ? 'candidate' : 'unknown',
      designSetId: folder?.sourceSetId ?? `${familyKey ?? 'unmapped'}:${top}`,
      designVersion: 'unknown',
      exportVersion: 'unknown',
      ratio,
      complianceBinding: false
    };
  });
  const associated = {
    ...index,
    files,
    association: {
      mappedFiles: files.filter((record) => record.familyKey).length,
      unmappedFiles: files.filter((record) => !record.ignored && !record.familyKey).length,
      ignoredFiles: files.filter((record) => record.ignored).length
    },
    rawIndexHash: index.rawIndexHash ?? index.stableHash
  };
  associated.stableHash = sha256(Buffer.from(canonicalJson(stableProjection(associated))));
  return associated;
}

// ---------- retrieval (explicit scope; no cross-family fallback) ----------
const RETRIEVAL_KEYS = Object.freeze(['familyKey', 'role', 'usage', 'language', 'skuCandidate']);
function retrieve(index, query = {}) {
  if (!isPlainObject(query)) fail('query must be a plain object');
  for (const key of Object.keys(query)) {
    if (!RETRIEVAL_KEYS.includes(key)) fail(`query.${key} is not a known field`);
  }
  const familyKey = requireNonEmptyString(query.familyKey, 'familyKey');
  const matches = index.files.filter((record) => !record.ignored
    && record.familyKey === familyKey
    && (query.role === undefined || record.role === query.role)
    && (query.usage === undefined || record.usageCandidates.includes(query.usage))
    && (query.language === undefined || record.language === query.language)
    && (query.skuCandidate === undefined || record.skuCandidates.includes(query.skuCandidate)));
  return {
    familyKey,
    matches,
    total: matches.length,
    excludedOtherFamilies: index.files.filter((record) => !record.ignored && record.familyKey !== familyKey).length,
    noCrossFamilyFallback: true
  };
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
  return file;
}

module.exports = {
  IMAGE_FORMATS,
  detectFormat,
  crc32,
  parseImage,
  parsePngHeader,
  decodePng,
  pixelSignature,
  parseJpegHeader,
  parsePdfMetadata,
  parseMp4Metadata,
  sha256,
  fingerprintDirectory,
  scanDirectory,
  buildIndex,
  stableProjection,
  associate,
  retrieve,
  writeJsonAtomic
};
