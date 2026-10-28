'use strict';
/**
 * T1.8 — Shop-materials index tests. Synthetic fixtures only (generic family/token names, fake
 * paths); real private values never appear here. Temporary files only under $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const W = path.join(__dirname, '..', '..');
const assets = require(path.join(W, 'lib', 'commerce', 'assets.js'));
const { canonicalJson } = require(path.join(W, 'lib', 'commerce', 'packs.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.8 tests write only to the private runtime tmp';

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(assets.crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}
function makePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function makeJpeg(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.from([0xff, 0xd9])]);
}
function makePdf(pages) {
  const parts = ['%PDF-1.5\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count ' + pages + ' >> endobj'];
  for (let i = 0; i < pages; i++) parts.push(`${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`);
  return Buffer.from(`${parts.join('\n')}\n%%EOF\n`, 'latin1');
}
function box(type, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length, 0);
  return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
}
function makeMp4() {
  const ftyp = box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2', 'latin1'));
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload[0] = 0;
  mvhdPayload.writeUInt32BE(1000, 12);
  mvhdPayload.writeUInt32BE(5000, 16);
  const mvhd = box('mvhd', mvhdPayload);
  const trak = box('trak', box('mdia', Buffer.alloc(0)));
  const moov = box('moov', Buffer.concat([mvhd, trak, trak]));
  return Buffer.concat([ftyp, moov]);
}
function writeFile(dir, relPath, buffer) {
  const file = path.join(dir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return file;
}

const SYNTHETIC_MAPPING = {
  folders: {
    alpha: { familyKey: 'family-a', sourceSetId: 'family-a:alpha' },
    beta: { familyKey: 'family-b', sourceSetId: 'family-b:beta' }
  },
  pathHints: [
    { token: 'hero', usages: ['main'], role: 'product' },
    { token: 'detail', usages: ['detail'] },
    { token: 'docs', role: 'reference' },
    { token: 'video', role: 'video' }
  ],
  skuTokens: [{ token: 'hero', skuCandidate: 'candidate:hero-variant' }]
};

function makeFixtureTree(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `assets-${label}-`));
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128]); // 2x1 RGBA, second pixel half-alpha
  writeFile(dir, 'alpha/hero/shot.png', makePng(2, 1, rgba));
  writeFile(dir, 'alpha/hero/photo.jpg', makeJpeg(640, 25));
  writeFile(dir, 'alpha/docs/notes.pdf', makePdf(2));
  writeFile(dir, 'alpha/video/clip.mp4', makeMp4());
  writeFile(dir, 'alpha/.WeDrive', Buffer.from('design-tool-metadata'));
  writeFile(dir, 'beta/detail/b.png', makePng(1, 1, Buffer.from([0, 0, 255, 255])));
  writeFile(dir, 'gamma/unknown.bin', Buffer.from('not a known format'));
  return { dir, rgba };
}

test('index -> associate -> retrieve with real format parsing and a real PNG pixel decode', { skip }, () => {
  const { dir, rgba } = makeFixtureTree('path');
  const records = assets.scanDirectory(dir);
  const byPath = new Map(records.map((record) => [record.relPath, record]));

  const png = byPath.get('alpha/hero/shot.png');
  assert.equal(png.format, 'png');
  assert.equal(png.image.width, 2);
  assert.equal(png.image.height, 1);
  assert.equal(png.image.alpha, true);
  const decoded = assets.decodePng(fs.readFileSync(path.join(dir, 'alpha', 'hero', 'shot.png')));
  assert.equal(decoded.supported, true);
  assert.deepEqual([...decoded.rgba], [...rgba], 'decoded RGBA pixels match the source bytes');
  const signature = assets.pixelSignature(fs.readFileSync(path.join(dir, 'alpha', 'hero', 'shot.png')));
  assert.equal(signature.rgbaSha256, assets.sha256(rgba));

  const jpeg = byPath.get('alpha/hero/photo.jpg');
  assert.equal(jpeg.image.width, 640);
  assert.equal(jpeg.image.height, 25);
  assert.equal(jpeg.image.decode, 'header');
  assert.equal(byPath.get('alpha/docs/notes.pdf').pdf.pdfVersion, '1.5');
  assert.equal(byPath.get('alpha/docs/notes.pdf').pdf.pageMarkerCount, 2);
  assert.equal(byPath.get('alpha/video/clip.mp4').mp4.durationSeconds, 5);
  assert.equal(byPath.get('alpha/video/clip.mp4').mp4.trackCount, 2);
  assert.equal(byPath.get('alpha/video/clip.mp4').mp4.majorBrand, 'isom');
  assert.equal(byPath.get('gamma/unknown.bin').status, 'unrecognized_format');

  const index = assets.buildIndex({ sourceRootId: 'synthetic', sourceRoot: dir, records });
  const associated = assets.associate(index, SYNTHETIC_MAPPING);
  const all = assets.retrieve(associated, { familyKey: 'family-a' });
  assert.equal(all.total, 4, 'only the four family-a business files (ignored/unmapped excluded)');
  const main = assets.retrieve(associated, { familyKey: 'family-a', usage: 'main' });
  assert.deepEqual(main.matches.map((record) => record.relPath).sort(), ['alpha/hero/photo.jpg', 'alpha/hero/shot.png']);
  const products = assets.retrieve(associated, { familyKey: 'family-a', role: 'product' });
  assert.equal(products.total, 2);
  const familyB = assets.retrieve(associated, { familyKey: 'family-b' });
  assert.deepEqual(familyB.matches.map((record) => record.relPath), ['beta/detail/b.png'], 'no cross-family fallback');
  assert.equal(associated.association.unmappedFiles, 1, 'gamma stays unmapped');
  const heroRecord = associated.files.find((record) => record.relPath === 'alpha/hero/shot.png');
  assert.deepEqual(heroRecord.skuCandidates, ['candidate:hero-variant']);
  assert.equal(heroRecord.skuStatus, 'candidate');
});

test('content dedup keeps every source path and re-indexing is idempotent', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'assets-dedup-'));
  const bytes = makePng(1, 1, Buffer.from([1, 2, 3, 255]));
  writeFile(dir, 'dedup/a/one.png', bytes);
  writeFile(dir, 'dedup/b/one.png', bytes);
  writeFile(dir, 'dedup/b/two.png', makePng(1, 1, Buffer.from([9, 9, 9, 255])));

  const first = assets.buildIndex({ sourceRootId: 'synthetic', sourceRoot: dir, records: assets.scanDirectory(dir) });
  const shared = first.contentObjects.find((object) => object.sourceCount === 2);
  assert.deepEqual(shared.paths, ['dedup/a/one.png', 'dedup/b/one.png'], 'all source paths retained on the shared content object');
  assert.equal(first.contentObjects.length, 2);

  const second = assets.buildIndex({ sourceRootId: 'synthetic', sourceRoot: dir, records: assets.scanDirectory(dir) });
  assert.equal(second.stableHash, first.stableHash, 're-indexing the same bytes is idempotent');
  assert.equal(second.contentObjects.find((object) => object.sourceCount === 2).paths.length, 2, 'no source lost on re-import');
});

test('same-family dual designs stay independent; unknown stays unknown; compliance never binds', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'assets-designs-'));
  writeFile(dir, 'set1/x.png', makePng(1, 1, Buffer.from([10, 10, 10, 255])));
  writeFile(dir, 'set2/y.png', makePng(1, 1, Buffer.from([20, 20, 20, 255])));
  writeFile(dir, 'compliance/rules.pdf', makePdf(1));
  writeFile(dir, 'other/z.png', makePng(1, 1, Buffer.from([30, 30, 30, 255])));

  const mapping = {
    folders: {
      set1: { familyKey: 'family-a', sourceSetId: 'family-a:set1' },
      set2: { familyKey: 'family-a', sourceSetId: 'family-a:set2' }
    },
    pathHints: [{ token: 'compliance', role: 'compliance_document' }],
    skuTokens: [{ token: 'set1', skuCandidate: 'candidate:variant-one' }]
  };
  const associated = assets.associate(assets.buildIndex({ sourceRootId: 'synthetic', sourceRoot: dir, records: assets.scanDirectory(dir) }), mapping);
  const family = assets.retrieve(associated, { familyKey: 'family-a' });
  assert.equal(family.total, 2, 'both source sets stay under the same family');
  assert.deepEqual(family.matches.map((record) => record.designSetId).sort(), ['family-a:set1', 'family-a:set2']);
  for (const record of family.matches) {
    assert.equal(record.designVersion, 'unknown', 'different hashes never imply a design version');
    assert.equal(record.exportVersion, 'unknown');
  }
  const compliance = associated.files.find((record) => record.relPath === 'compliance/rules.pdf');
  assert.equal(compliance.role, 'compliance_document');
  assert.equal(compliance.complianceBinding, false, 'a document folder never binds unit compliance');
  assert.equal(compliance.familyKey, null);
  const other = associated.files.find((record) => record.relPath === 'other/z.png');
  assert.equal(other.familyKey, null, 'unmapped folders stay unmapped');
  assert.equal(other.role, 'unknown');
  assert.equal(assets.retrieve(associated, { familyKey: 'family-a', role: 'cutout' }).total, 0, 'a role with no records returns nothing (no fallback)');
  assert.ok(family.matches.every((record) => record.role === 'unknown'), 'unhinted image roles stay unknown');
  assert.throws(() => assets.retrieve(associated, {}), /familyKey/);
  assert.throws(() => assets.retrieve(associated, { familyKey: 'family-a', unknownKey: true }), /not a known field/);
});

test('read-only scan keeps the source fingerprint unchanged', { skip }, () => {
  const { dir } = makeFixtureTree('readonly');
  const before = assets.fingerprintDirectory(dir);
  const snapshot = new Map();
  for (const record of assets.scanDirectory(dir)) snapshot.set(record.relPath, record.sha256);
  const after = assets.fingerprintDirectory(dir);
  assert.equal(after.fingerprint, before.fingerprint, 'source content fingerprint unchanged after scanning');
  assert.equal(after.fileCount, before.fileCount);
  assert.equal(after.totalBytes, before.totalBytes);
  const index = assets.buildIndex({ sourceRootId: 'synthetic', sourceRoot: dir, records: assets.scanDirectory(dir) });
  assert.equal(index.ignoredCount, 1, '.WeDrive is counted as ignored');
  assert.ok(!index.contentObjects.some((object) => object.paths.some((p) => p.endsWith('.WeDrive'))), 'ignored files never become content objects');
  assert.equal(index.stableHash, assets.buildIndex({ sourceRootId: 'synthetic', sourceRoot: dir, records: assets.scanDirectory(dir) }).stableHash);
});

test('indexer refuses outputs inside the read-only source and succeeds for disjoint targets', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'assets-f1-'));
  const source = path.join(dir, 'source');
  fs.mkdirSync(path.join(source, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(source, 'alpha', 'one.png'), makePng(1, 1, Buffer.from([1, 2, 3, 255])));
  const input = path.join(dir, 'input.json');
  const mapping = path.join(dir, 'mapping.json');
  fs.writeFileSync(input, JSON.stringify({ inputId: 'synthetic-f1', products: [{ productFamilyKey: 'family-a', nickname: 'Synthetic', sourceFolders: ['alpha'] }], pending: [] }));
  fs.writeFileSync(mapping, JSON.stringify({}));
  const script = path.join(W, 'scripts', 'commerce', 'index-materials.js');
  const run = (imports, evidence, catalog) => {
    try {
      const out = cp.execFileSync(process.execPath, [script, '--input', input, '--mapping', mapping, '--source-root', source, '--imports', imports, '--evidence', evidence, '--catalog', catalog], { cwd: W, encoding: 'utf8', timeout: 30000 });
      return { status: 0, report: JSON.parse(out) };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr || error.message) };
    }
  };
  const before = assets.fingerprintDirectory(source);
  const overlapImports = run(source, path.join(dir, 'evidence'), path.join(dir, 'catalog.md'));
  assert.notEqual(overlapImports.status, 0, 'an imports target inside the source is refused');
  assert.equal(assets.fingerprintDirectory(source).fingerprint, before.fingerprint, 'source untouched on rejection');
  assert.ok(!fs.existsSync(path.join(source, 'manifest.json')), 'no manifest written into the source');
  const overlapEvidence = run(path.join(dir, 'imports'), source, path.join(dir, 'catalog.md'));
  assert.notEqual(overlapEvidence.status, 0, 'an evidence target inside the source is refused too');
  assert.equal(assets.fingerprintDirectory(source).fingerprint, before.fingerprint);
  const legal = run(path.join(dir, 'imports'), path.join(dir, 'evidence'), path.join(dir, 'catalog.md'));
  assert.equal(legal.status, 0, 'disjoint outputs succeed');
  assert.equal(legal.report.sourceStable, true);
  assert.ok(fs.existsSync(path.join(dir, 'imports', 'manifest.json')) && fs.existsSync(path.join(dir, 'catalog.md')), 'canonical outputs published only for disjoint targets');
  assert.equal(assets.fingerprintDirectory(source).fingerprint, before.fingerprint, 'the legal run keeps the source unchanged');
});

test('decode labels stay truthful and RGB/gray tRNS transparency is honored', { skip }, () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = (colorType) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = colorType;
    return header;
  };
  const incomplete = Buffer.concat([signature, pngChunk('IHDR', ihdr(6)), pngChunk('IEND', Buffer.alloc(0))]);
  const parsed = assets.parseImage(incomplete);
  assert.equal(parsed.decode, 'header', 'header parsing never claims a pixel decode');
  const failed = assets.decodePng(incomplete);
  assert.equal(failed.supported, false);
  assert.equal(typeof failed.reason, 'string');

  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'assets-f2-'));
  fs.writeFileSync(path.join(dir, 'incomplete.png'), incomplete);
  const record = assets.scanDirectory(dir).find((item) => item.relPath === 'incomplete.png');
  assert.equal(record.image.decodeStatus, 'pixel_unsupported');
  assert.equal(record.image.decodeReason, failed.reason, 'the unsupported reason is persisted per file');

  const rgbTrns = Buffer.concat([signature, pngChunk('IHDR', ihdr(2)), pngChunk('tRNS', Buffer.from([0, 10, 0, 20, 0, 30])), pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 10, 20, 30]))), pngChunk('IEND', Buffer.alloc(0))]);
  const rgb = assets.decodePng(rgbTrns);
  assert.equal(rgb.supported, true);
  assert.deepEqual([...rgb.rgba], [10, 20, 30, 0], 'the RGB tRNS key becomes transparent');
  const grayTrns = Buffer.concat([signature, pngChunk('IHDR', ihdr(0)), pngChunk('tRNS', Buffer.from([0, 77])), pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 77]))), pngChunk('IEND', Buffer.alloc(0))]);
  const gray = assets.decodePng(grayTrns);
  assert.deepEqual([...gray.rgba], [77, 77, 77, 0], 'the gray tRNS key becomes transparent');

  const rgbaBytes = Buffer.from([5, 6, 7, 8]);
  const rgbaPng = makePng(1, 1, rgbaBytes);
  assert.equal(assets.pixelSignature(rgbaPng).rgbaSha256, assets.sha256(rgbaBytes), 'RGBA happy path unchanged');
  fs.writeFileSync(path.join(dir, 'rgba.png'), rgbaPng);
  const rgbaRecord = assets.scanDirectory(dir).find((item) => item.relPath === 'rgba.png');
  assert.equal(rgbaRecord.image.decodeStatus, 'pixel_decoded');
  assert.equal(rgbaRecord.image.pixelDecode.rgbaSha256, assets.sha256(rgbaBytes));
});

test('associated stableHash covers the associated semantics and raw hash stays separate', { skip }, () => {
  const good = makePng(1, 1, Buffer.from([9, 8, 7, 255]));
  const raw = assets.buildIndex({
    sourceRootId: 'synthetic',
    sourceRoot: 'synthetic-root',
    records: [
      { relPath: 'alpha/one.png', size: good.length, sha256: assets.sha256(good), format: 'png', status: 'indexed' },
      { relPath: 'alpha/two.png', size: good.length, sha256: assets.sha256(good), format: 'png', status: 'indexed' }
    ]
  });
  const mappingA = {
    folders: { alpha: { familyKey: 'family-a', sourceSetId: 'set-a' } },
    pathHints: [{ token: 'alpha', usages: ['main'] }],
    skuTokens: [{ token: 'one', skuCandidate: 'candidate:one' }]
  };
  const one = assets.associate(raw, mappingA);
  const repeat = assets.associate(raw, mappingA);
  const two = assets.associate(raw, { ...mappingA, folders: { alpha: { familyKey: 'family-b', sourceSetId: 'set-b' } } });
  const usageChanged = assets.associate(raw, { ...mappingA, pathHints: [{ token: 'alpha', usages: ['detail'] }] });
  const skuChanged = assets.associate(raw, { ...mappingA, skuTokens: [] });
  const finalHash = (value) => assets.sha256(Buffer.from(canonicalJson(assets.stableProjection(value))));

  assert.equal(one.stableHash, finalHash(one), 'stableHash equals the canonical hash of the public projection');
  assert.equal(repeat.stableHash, one.stableHash, 'same files + same mapping are stable');
  assert.notEqual(two.stableHash, one.stableHash, 'family/sourceSet changes the associated version');
  assert.notEqual(usageChanged.stableHash, one.stableHash, 'usage changes the associated version');
  assert.notEqual(skuChanged.stableHash, one.stableHash, 'SKU token changes the associated version');
  assert.equal(one.rawIndexHash, raw.stableHash, 'the raw index hash is retained separately');
  assert.equal(raw.stableHash, finalHash(raw), 'the raw index hash also matches its projection');
  assert.equal(assets.retrieve(one, { familyKey: 'family-a' }).total, 2);
  assert.equal(assets.retrieve(two, { familyKey: 'family-a' }).total, 0, 'retrieval follows the associated version');
  assert.deepEqual(one.contentObjects.find((object) => object.sourceCount === 2).paths, ['alpha/one.png', 'alpha/two.png'], 'dedup source paths retained');
  assert.ok(raw.files.every((record) => record.familyKey === undefined), 'the raw index is not mutated by association');
});

test('containment guard distinguishes dotdot-prefixed child names from parent traversal', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'assets-f1b-'));
  const source = path.join(dir, 'source');
  const dotdotChild = path.join(source, '..outputs');
  fs.mkdirSync(dotdotChild, { recursive: true });
  fs.writeFileSync(path.join(source, 'good.png'), makePng(1, 1, Buffer.from([1, 2, 3, 255])));
  const cli = require(path.join(W, 'scripts', 'commerce', 'index-materials.js'));

  assert.equal(cli.isInside(dotdotChild, source), true, 'a child literally named ..outputs is inside the source');
  assert.equal(cli.isInside(dir, source), false, 'the parent directory is outside');
  assert.equal(cli.isInside(path.join(dir, '..outputs'), source), false, 'a sibling ..outputs directory is outside');
  assert.throws(() => cli.assertOutputsOutsideSource(source, { imports: source }), /inside the read-only source/);
  assert.throws(() => cli.assertOutputsOutsideSource(source, { imports: dotdotChild }), /inside the read-only source/);
  assert.throws(() => cli.assertOutputsOutsideSource(source, { catalog: path.join(dotdotChild, 'catalog.md') }), /inside the read-only source/);
  cli.assertOutputsOutsideSource(source, { imports: path.join(dir, 'imports'), evidence: path.join(dir, 'evidence'), catalog: path.join(dir, 'catalog.md') });

  const input = path.join(dir, 'input.json');
  const mapping = path.join(dir, 'mapping.json');
  fs.writeFileSync(input, JSON.stringify({ inputId: 'synthetic-f1b', products: [{ productFamilyKey: 'family-a', nickname: 'Synthetic', sourceFolders: ['source'] }], pending: [] }));
  fs.writeFileSync(mapping, JSON.stringify({}));
  const before = assets.fingerprintDirectory(source);
  let refused = false;
  try {
    cp.execFileSync(process.execPath, [path.join(W, 'scripts', 'commerce', 'index-materials.js'), '--input', input, '--mapping', mapping, '--source-root', source, '--imports', dotdotChild, '--evidence', path.join(dir, 'evidence'), '--catalog', path.join(dir, 'catalog.md')], { cwd: W, encoding: 'utf8', timeout: 30000 });
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'the CLI refuses outputs under the dotdot-name child');
  assert.equal(assets.fingerprintDirectory(source).fingerprint, before.fingerprint, 'the source stays untouched on refusal');
  const legal = cp.execFileSync(process.execPath, [path.join(W, 'scripts', 'commerce', 'index-materials.js'), '--input', input, '--mapping', mapping, '--source-root', source, '--imports', path.join(dir, 'imports'), '--evidence', path.join(dir, 'evidence'), '--catalog', path.join(dir, 'catalog.md')], { cwd: W, encoding: 'utf8', timeout: 30000 });
  assert.equal(JSON.parse(legal).ok, true, 'disjoint targets still succeed');
});

test('corrupt compressed PNG is recorded as a defect without aborting the scan', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'assets-f2b-'));
  const good = makePng(1, 1, Buffer.from([10, 20, 30, 40]));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const damaged = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.from([1, 2, 3, 4])),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  const decoded = assets.decodePng(damaged);
  assert.equal(decoded.supported, false);
  assert.equal(decoded.defect, true);
  assert.equal(typeof decoded.reason, 'string');

  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(src, 'alpha', 'damaged.png'), damaged);
  fs.writeFileSync(path.join(src, 'alpha', 'good.png'), good);
  const records = assets.scanDirectory(src);
  assert.equal(records.length, 2, 'the scan continues with the valid peer');
  const bad = records.find((record) => record.relPath === 'alpha/damaged.png');
  assert.equal(bad.status, 'image_defect');
  assert.equal(bad.image.pixelDecode.supported, false);
  assert.equal(typeof bad.image.decodeReason, 'string');
  const goodRecord = records.find((record) => record.relPath === 'alpha/good.png');
  assert.equal(goodRecord.status, 'indexed');
  assert.equal(goodRecord.image.decodeStatus, 'pixel_decoded');
  assert.equal(goodRecord.image.pixelDecode.rgbaSha256, assets.sha256(Buffer.from([10, 20, 30, 40])));

  const input = path.join(dir, 'input.json');
  const mapping = path.join(dir, 'mapping.json');
  fs.writeFileSync(input, JSON.stringify({ inputId: 'synthetic-f2b', products: [{ productFamilyKey: 'family-a', nickname: 'Synthetic', sourceFolders: ['alpha'] }], pending: [] }));
  fs.writeFileSync(mapping, JSON.stringify({}));
  const before = assets.fingerprintDirectory(src);
  const out = cp.execFileSync(process.execPath, [path.join(W, 'scripts', 'commerce', 'index-materials.js'), '--input', input, '--mapping', mapping, '--source-root', src, '--imports', path.join(dir, 'imports'), '--evidence', path.join(dir, 'evidence'), '--catalog', path.join(dir, 'catalog.md')], { cwd: W, encoding: 'utf8', timeout: 30000 });
  assert.equal(JSON.parse(out).ok, true, 'the disjoint CLI readback succeeds');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'imports', 'manifest.json'), 'utf8'));
  const badFile = manifest.files.find((file) => file.relPath === 'alpha/damaged.png');
  assert.equal(badFile.status, 'image_defect');
  assert.equal(typeof badFile.image.decodeReason, 'string');
  assert.equal(assets.retrieve(manifest, { familyKey: 'family-a' }).total, 2, 'the valid peer stays retrievable');
  assert.equal(assets.fingerprintDirectory(src).fingerprint, before.fingerprint, 'the source stays untouched');
});
