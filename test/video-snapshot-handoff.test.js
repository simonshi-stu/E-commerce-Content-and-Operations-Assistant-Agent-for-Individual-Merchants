'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createVideoPlan } = require('../lib/video-workbench');
const { createReadOnlySnapshotResolver, mediaEvidence } = require('../lib/video-snapshot');
const assetsModule = require('../lib/commerce/assets');
const { canonicalJson } = require('../lib/commerce/packs');
const creative = require('../lib/commerce/creative/brief');
const { openDb } = require('../lib/commerce/db');
const { templateShots } = require('../public/video-tools');

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function snapshotFixture(overrides = {}) {
  const identity = {
    projectId: 'project-a', brand: 'brand-a', market: 'US', passportId: 'passport-a', skuId: 'sku-a',
    channel: 'amazon', marketplace: 'US', locale: 'en-US', imageRole: 'SUBIMAGE', imageIndex: 1
  };
  const product = { passportId: 'passport-a', skuId: 'sku-a', productFamilyKey: 'family-a', designKey: 'design-a', title: 'Trusted tumbler', category: 'Tumblers' };
  const facts = [{ factId: 'fact-a', version: 2, contentSha256: 'a'.repeat(64) }];
  const assets = [{ assetId: 'creative-asset-a', version: 3, sha256: 'b'.repeat(64), designKey: 'design-a' }];
  const document = {
    schemaVersion: creative.CREATIVE_SCHEMA_VERSION,
    kind: creative.CREATIVE_SNAPSHOT_KIND,
    identity,
    identityKey: creative.identityKey(identity),
    briefId: 'cb_aaaaaaaaaaaa_v1',
    briefVersion: 1,
    product,
    facts,
    assets,
    versions: { factVersions: facts, assetVersions: assets },
    brief: {
      identity,
      product,
      allowedClaims: [{ text: 'Trusted snapshot claim' }],
      factVersions: facts,
      assetVersions: assets,
      media: { status: 'not_generated' }
    },
    media: { status: 'not_generated' }
  };
  return {
    document: structuredClone({ ...document, ...overrides.document }),
    sha256: 'c'.repeat(64),
    file: 'v000001.json',
    currentVersion: overrides.currentVersion === undefined ? 1 : overrides.currentVersion,
    media: overrides.media || { status: 'unverified', verified: false, reason: 'trusted_asset_index_not_configured', assets: [] }
  };
}

function videoInput() {
  return {
    route: 'remix', product: 'Trusted tumbler', category: 'Tumblers', market: 'US', duration: 5, aspectRatio: '9:16',
    facts: 'CLIENT MUST NOT BECOME AUTHORITY', prohibited: 'Do not invent specifications', rightsConfirmed: true, avatarConsent: false,
    assets: [{ name: 'product.png', type: 'image/png', size: 100, role: 'product' }, { name: 'reference.mp4', type: 'video/mp4', size: 200, role: 'reference' }],
    referenceNotes: { rhythm: 'manual note' },
    shots: templateShots(5, 'asset-1', 'remix')
  };
}

test('trusted persisted snapshot binds scope, versions and hashes without trusting browser facts', () => {
  const fixture = snapshotFixture();
  const input = videoInput();
  input.snapshotRef = { briefId: fixture.document.briefId, version: 1, projectId: 'project-a', passportId: 'passport-a', skuId: 'sku-a', familyKey: 'family-a', designKey: 'design-a' };
  const plan = createVideoPlan(input, { snapshotResolver: () => fixture });
  assert.equal(plan.productFacts.status, 'trusted_snapshot_bound');
  assert.equal(plan.productFacts.clientDraftIgnored, true);
  assert.doesNotMatch(plan.productFacts.text, /CLIENT MUST NOT/);
  assert.equal(plan.handoff.status, 'trusted_snapshot_bound');
  assert.equal(plan.creativeSnapshot.scope.projectId, 'project-a');
  assert.equal(plan.creativeSnapshot.scope.skuId, 'sku-a');
  assert.equal(plan.creativeSnapshot.assets[0].version, 3);
  assert.equal(plan.creativeSnapshot.assets[0].contentSha256, 'b'.repeat(64));
  assert.equal(plan.creativeSnapshot.media.verified, false);
  assert.equal(plan.output.status, 'not_generated');
  assert.deepEqual(plan.permissions, { paidGeneration: false, externalUpload: false, publish: false, contactCustomers: false });
});

test('snapshot references reject client hashes, stale versions and cross-scope assertions', () => {
  const fixture = snapshotFixture({ currentVersion: 2 });
  const stale = videoInput();
  stale.snapshotRef = { briefId: fixture.document.briefId, version: 1 };
  assert.throws(() => createVideoPlan(stale, { snapshotResolver: () => fixture }), (error) => error.code === 'snapshot_stale');

  const foreign = videoInput();
  foreign.snapshotRef = { briefId: fixture.document.briefId, version: 1, projectId: 'project-b' };
  assert.throws(() => createVideoPlan(foreign, { snapshotResolver: () => snapshotFixture() }), (error) => error.code === 'snapshot_scope_mismatch');

  const hash = videoInput();
  hash.snapshotRef = { briefId: fixture.document.briefId, version: 1, sha256: 'd'.repeat(64) };
  assert.throws(() => createVideoPlan(hash, { snapshotResolver: () => snapshotFixture() }), (error) => error.code === 'snapshot_reference_invalid');
});

test('tampered persisted binding and unavailable resolver fail closed', () => {
  const tampered = snapshotFixture({ document: { assets: [{ ...snapshotFixture().document.assets[0], designKey: 'design-b' }] } });
  const input = videoInput();
  input.snapshotRef = { briefId: tampered.document.briefId, version: 1 };
  assert.throws(() => createVideoPlan(input, { snapshotResolver: () => tampered }), (error) => error.code === 'snapshot_asset_scope_mismatch');
  assert.throws(() => createVideoPlan(input), (error) => error.code === 'snapshot_unavailable');
});

test('read-only resolver locates a current persisted snapshot by brief id, never by client path', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-snapshot-resolver-'));
  try {
    const fixture = snapshotFixture();
    const identity = fixture.document.identity;
    const metaRoot = path.join(dir, 'meta');
    const snapshotDir = creative.snapshotDir({ metaRoot, identity });
    const file = path.join(snapshotDir, 'v000001.json');
    fs.writeFileSync(file, `${JSON.stringify(fixture.document, null, 2)}\n`, 'utf8');
    const fileSha256 = sha256(fs.readFileSync(file));
    fs.writeFileSync(path.join(snapshotDir, 'head.json'), JSON.stringify({
      schemaVersion: creative.CREATIVE_SCHEMA_VERSION, kind: 'creative-brief-head', identityKey: fixture.document.identityKey,
      currentVersion: 1, fileName: 'v000001.json', sha256: fileSha256, briefId: fixture.document.briefId
    }), 'utf8');
    const row = { id: fixture.document.briefId, project_id: 'project-a', product_passport_id: 'passport-a', sku_id: 'sku-a', channel: 'amazon', locale: 'en-US', version: 1 };
    const db = { prepare: () => ({ get: () => row }) };
    const resolver = createReadOnlySnapshotResolver({ metaRoot, db, projectId: 'project-a' });
    const result = resolver({ briefId: fixture.document.briefId, version: 1 });
    assert.equal(result.document.briefId, fixture.document.briefId);
    assert.equal(result.sha256, fileSha256);
    assert.equal(result.media.verified, false);
    const badReference = videoInput();
    badReference.snapshotRef = { briefId: fixture.document.briefId, version: 1, path: 'C:\\private\\asset.png' };
    assert.throws(() => createVideoPlan(badReference, { snapshotResolver: resolver }), (error) => error.code === 'snapshot_reference_invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('media hash is verified only after the trusted index rereads matching file bytes', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-snapshot-media-'));
  try {
    const fixture = snapshotFixture();
    const bytes = Buffer.from('trusted synthetic media bytes');
    const mediaSha256 = assetsModule.sha256(bytes);
    fixture.document.assets[0].sha256 = mediaSha256;
    fixture.document.versions.assetVersions[0].sha256 = mediaSha256;
    fixture.document.brief.assetVersions[0].sha256 = mediaSha256;
    const assetRoot = path.join(dir, 'assets');
    fs.mkdirSync(path.join(assetRoot, 'family-a'), { recursive: true });
    fs.writeFileSync(path.join(assetRoot, 'family-a', 'product.png'), bytes);
    const index = {
      schemaVersion: 1, kind: 'shop-materials-index', sourceRootId: 'root-a', sourceRoot: assetRoot, scannedAt: '2026-11-02T00:00:00.000Z',
      files: [{ assetId: 'creative-asset-a', relPath: 'family-a/product.png', size: bytes.length, sha256: mediaSha256, format: 'png', familyKey: 'family-a', passportId: 'passport-a', skuId: 'sku-a', designKey: 'design-a' }]
    };
    index.stableHash = assetsModule.sha256(Buffer.from(canonicalJson(assetsModule.stableProjection(index))));
    const indexFilePath = path.join(dir, 'asset-index.json');
    fs.writeFileSync(indexFilePath, JSON.stringify(index), 'utf8');
    const evidence = mediaEvidence(fixture.document, { indexFilePath, roots: { 'root-a': assetRoot } }, 'project-a');
    assert.equal(evidence.verified, true);
    assert.equal(evidence.assets[0].sha256, mediaSha256);
    const plan = createVideoPlan(Object.assign(videoInput(), { snapshotRef: { briefId: fixture.document.briefId, version: 1 } }), {
      snapshotResolver: () => ({ ...fixture, media: evidence })
    });
    assert.equal(plan.creativeSnapshot.media.verified, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP /api/video/plan uses the configured read-only resolver and keeps execution disabled', { skip: !TMP_ROOT }, async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '..', 'tmp', 'video-snapshot-http-'));
  let child;
  try {
    const fixture = snapshotFixture();
    const metaRoot = path.join(dir, 'meta');
    const snapshotDir = creative.snapshotDir({ metaRoot, identity: fixture.document.identity });
    const snapshotFile = path.join(snapshotDir, 'v000001.json');
    fs.writeFileSync(snapshotFile, `${JSON.stringify(fixture.document, null, 2)}\n`, 'utf8');
    const snapshotSha256 = sha256(fs.readFileSync(snapshotFile));
    fs.writeFileSync(path.join(snapshotDir, 'head.json'), JSON.stringify({
      schemaVersion: creative.CREATIVE_SCHEMA_VERSION, kind: 'creative-brief-head', identityKey: fixture.document.identityKey,
      currentVersion: 1, fileName: 'v000001.json', sha256: snapshotSha256, briefId: fixture.document.briefId
    }), 'utf8');
    const dbPath = path.join(dir, 'creative.db');
    const db = openDb(dbPath);
    db.exec(`CREATE TABLE creative_briefs (id TEXT PRIMARY KEY, project_id TEXT, product_passport_id TEXT, sku_id TEXT, channel TEXT, locale TEXT, version INTEGER)`);
    db.prepare('INSERT INTO creative_briefs VALUES (?, ?, ?, ?, ?, ?, ?)').run(fixture.document.briefId, 'project-a', 'passport-a', 'sku-a', 'amazon', 'en-US', 1);
    db.close();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ videoSnapshot: { dbPath, metaRoot, projectId: 'project-a' } }), 'utf8');
    const sandbox = path.join(dir, 'app');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(sandbox, 'server.js'));
    fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(sandbox, 'lib'), { recursive: true });
    fs.cpSync(path.join(__dirname, '..', 'public'), path.join(sandbox, 'public'), { recursive: true });
    child = spawn(process.execPath, ['server.js'], { cwd: sandbox, env: { ...process.env, PORT: '0', COMMERCE_TASKS_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const base = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`HTTP snapshot server did not start: ${stdout}\n${stderr}`)), 10000);
      const poll = setInterval(() => {
        const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearInterval(poll); clearTimeout(deadline); resolve(`http://127.0.0.1:${match[1]}`); }
      }, 20);
      child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`HTTP snapshot server exited (${code}): ${stderr}`)); });
    });
    const response = await fetch(`${base}/api/video/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      ...videoInput(), facts: 'client draft is ignored', snapshotRef: { briefId: fixture.document.briefId, version: 1 }
    }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.handoff.status, 'trusted_snapshot_bound');
    assert.equal(body.data.output.status, 'not_generated');
    assert.equal(body.data.permissions.paidGeneration, false);
    assert.equal(body.data.permissions.externalUpload, false);
    assert.equal(body.data.permissions.publish, false);
  } finally {
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
