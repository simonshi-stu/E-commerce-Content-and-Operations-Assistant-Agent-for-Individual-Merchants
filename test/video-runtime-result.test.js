'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { canonicalJson } = require('../lib/commerce/packs');
const creative = require('../lib/commerce/creative/brief');
const { openDb } = require('../lib/commerce/db');
const {
  SCHEMA_VERSION,
  createReadOnlyVideoRuntimeResultAdapter,
  normalizeRuntimeResult
} = require('../lib/video-runtime-result');

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function baseResult(binding, overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'simulated',
    operationId: 'operation-a',
    requestDigest: 'd'.repeat(64),
    binding,
    revision: 1,
    state: 'succeeded',
    media: { status: 'absent', artifactId: null, sha256: null, bytes: null },
    qa: { status: 'not_run', codes: [] },
    export: { status: 'not_ready', artifactId: null },
    budget: { currency: 'CNY', capMinor: 1000, reservedMinor: 0, settledMinor: 0, usageKnown: true },
    errors: [],
    ...overrides
  };
}

function prepareFixture(dir) {
  const resultRoot = path.join(dir, 'results');
  const mediaRoot = path.join(dir, 'media');
  const exportRoot = path.join(dir, 'exports');
  fs.mkdirSync(resultRoot, { recursive: true });
  fs.mkdirSync(mediaRoot, { recursive: true });
  fs.mkdirSync(exportRoot, { recursive: true });
  const binding = { projectId: 'project-a', briefId: 'brief-a', briefVersion: 1, snapshotSha256: 'a'.repeat(64) };
  const snapshotResolver = () => ({ document: { identity: { projectId: 'project-a' }, briefId: 'brief-a', briefVersion: 1 }, sha256: binding.snapshotSha256 });
  const adapter = createReadOnlyVideoRuntimeResultAdapter({ resultRoot, mediaRoot, exportRoot, projectId: 'project-a', snapshotResolver });
  return { resultRoot, mediaRoot, exportRoot, binding, adapter };
}

test('normalizes the v1 result and safely downgrades self-declared artifact states', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-normalize-'));
  try {
    const fixture = prepareFixture(dir);
    fs.writeFileSync(path.join(fixture.resultRoot, 'operation-a.json'), JSON.stringify(baseResult(fixture.binding, {
      media: { status: 'verified', artifactId: null, sha256: null, bytes: null },
      export: { status: 'ready', artifactId: null }
    })));
    const result = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(result.media.status, 'absent');
    assert.equal(result.export.status, 'not_ready');
    assert.deepEqual(result.errors, ['MEDIA_ARTIFACT_MISSING', 'EXPORT_ARTIFACT_MISSING', 'RUNTIME_EVIDENCE_BLOCKED']);
    assert.equal(normalizeRuntimeResult(baseResult(fixture.binding)).schemaVersion, SCHEMA_VERSION);
    assert.throws(() => normalizeRuntimeResult({ ...baseResult(fixture.binding), provider: { status: 'SUCCEEDED' } }), (error) => error.code === 'runtime_result_invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifies controlled media bytes and reads controlled export bytes before exposing readiness', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-artifacts-'));
  try {
    const fixture = prepareFixture(dir);
    const media = Buffer.from('synthetic video bytes');
    const exportBytes = Buffer.from(media);
    fs.writeFileSync(path.join(fixture.mediaRoot, 'video-a.mp4'), media);
    fs.writeFileSync(path.join(fixture.exportRoot, 'package-a.zip'), exportBytes);
    fs.writeFileSync(path.join(fixture.resultRoot, 'operation-a.json'), JSON.stringify(baseResult(fixture.binding, {
      media: { status: 'verified', artifactId: 'video-a.mp4', sha256: sha256(media), bytes: media.length },
      qa: { status: 'passed', codes: [] },
      export: { status: 'ready', artifactId: 'package-a.zip' }
    })));
    const result = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(result.media.status, 'verified');
    assert.equal(result.media.bytes, media.length);
    assert.equal(result.export.status, 'ready');
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps needs_review results non-exportable even when the provider declares an export', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-qa-'));
  try {
    const fixture = prepareFixture(dir);
    const media = Buffer.from('qa review media bytes');
    fs.writeFileSync(path.join(fixture.mediaRoot, 'video-a.mp4'), media);
    fs.writeFileSync(path.join(fixture.exportRoot, 'package-a.zip'), media);
    fs.writeFileSync(path.join(fixture.resultRoot, 'operation-a.json'), JSON.stringify(baseResult(fixture.binding, {
      mode: 'real',
      media: { status: 'verified', artifactId: 'video-a.mp4', sha256: sha256(media), bytes: media.length },
      qa: { status: 'needs_review', codes: ['PRODUCT_REVIEW_REQUIRED'] },
      export: { status: 'ready', artifactId: 'package-a.zip' }
    })));
    const result = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(result.state, 'blocked');
    assert.equal(result.media.status, 'absent');
    assert.equal(result.export.status, 'not_ready');
    assert.ok(result.errors.includes('EXPORT_QA_NOT_PASSED'));
    assert.ok(result.errors.includes('RUNTIME_EVIDENCE_BLOCKED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downgrades tampered, missing, swapped and symlink exports after exact media-byte comparison', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-export-guards-'));
  try {
    const fixture = prepareFixture(dir);
    const media = Buffer.from('verified media bytes');
    const other = Buffer.from('different tampered export bytes');
    fs.writeFileSync(path.join(fixture.mediaRoot, 'video-a.mp4'), media);
    fs.writeFileSync(path.join(fixture.exportRoot, 'tampered.mp4'), other);
    const file = path.join(fixture.resultRoot, 'operation-a.json');
    const ready = (artifactId, revision) => baseResult(fixture.binding, {
      revision,
      media: { status: 'verified', artifactId: 'video-a.mp4', sha256: sha256(media), bytes: media.length },
      qa: { status: 'passed', codes: [] },
      export: { status: 'ready', artifactId }
    });

    fs.writeFileSync(file, JSON.stringify(ready('tampered.mp4', 1)));
    let result = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(result.export.status, 'not_ready');
    assert.deepEqual(result.errors, ['EXPORT_MEDIA_MISMATCH', 'RUNTIME_EVIDENCE_BLOCKED']);

    fs.writeFileSync(file, JSON.stringify(ready('missing.mp4', 2)));
    result = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(result.export.status, 'not_ready');
    assert.deepEqual(result.errors, ['EXPORT_ARTIFACT_UNAVAILABLE', 'RUNTIME_EVIDENCE_BLOCKED']);

    const outside = path.join(dir, 'outside.mp4');
    fs.writeFileSync(outside, media);
    try {
      fs.symlinkSync(outside, path.join(fixture.exportRoot, 'linked.mp4'), 'file');
      fs.writeFileSync(file, JSON.stringify(ready('linked.mp4', 3)));
      result = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
      assert.equal(result.export.status, 'not_ready');
       assert.deepEqual(result.errors, ['EXPORT_ARTIFACT_PATH_UNSAFE', 'RUNTIME_EVIDENCE_BLOCKED']);
    } catch (error) {
      if (error && error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }

    fs.writeFileSync(file, JSON.stringify(ready('../outside.mp4', 4)));
    result = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(result.export.status, 'not_ready');
    assert.deepEqual(result.errors, ['EXPORT_ARTIFACT_PATH_UNSAFE', 'RUNTIME_EVIDENCE_BLOCKED']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enforces the shared uppercase error-code grammar and rejects the wire-only provider extension', () => {
  const binding = { projectId: 'project-a', briefId: 'brief-a', briefVersion: 1, snapshotSha256: 'a'.repeat(64) };
  assert.throws(() => normalizeRuntimeResult(baseResult(binding, { errors: ['unsafe:code'] })), (error) => error.code === 'runtime_result_invalid');
  assert.throws(() => normalizeRuntimeResult(baseResult(binding, { qa: { status: 'needs_review', codes: ['mixedCase'] } })), (error) => error.code === 'runtime_result_invalid');
  assert.throws(() => normalizeRuntimeResult(baseResult(binding, { errors: Array.from({ length: 33 }, () => 'TOO_MANY') })), (error) => error.code === 'runtime_result_invalid');
  assert.throws(() => normalizeRuntimeResult({ ...baseResult(binding), provider: { status: 'SUCCEEDED' } }), (error) => error.code === 'runtime_result_invalid');
});

test('rejects an artifact reused by a different operation or binding scope', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-artifact-scope-'));
  try {
    const fixture = prepareFixture(dir);
    const media = Buffer.from('scope-bound media bytes');
    fs.writeFileSync(path.join(fixture.mediaRoot, 'shared.mp4'), media);
    fs.writeFileSync(path.join(fixture.resultRoot, 'operation-a.json'), JSON.stringify(baseResult(fixture.binding, {
      media: { status: 'verified', artifactId: 'shared.mp4', sha256: sha256(media), bytes: media.length }
    })));
    const first = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(first.media.status, 'verified');

    fs.writeFileSync(path.join(fixture.resultRoot, 'operation-b.json'), JSON.stringify(baseResult(fixture.binding, {
      operationId: 'operation-b',
      media: { status: 'verified', artifactId: 'shared.mp4', sha256: sha256(media), bytes: media.length }
    })));
    const second = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-b' });
    assert.equal(second.media.status, 'absent');
    assert.ok(second.errors.includes('MEDIA_ARTIFACT_SCOPE_MISMATCH'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects stale and conflicting revisions, binding mismatches, traversal and budget overflow', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-guards-'));
  try {
    const fixture = prepareFixture(dir);
    const file = path.join(fixture.resultRoot, 'operation-a.json');
    fs.writeFileSync(file, JSON.stringify(baseResult(fixture.binding, { revision: 2 })));
    fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    fs.writeFileSync(file, JSON.stringify(baseResult(fixture.binding, { revision: 1 })));
    assert.throws(() => fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_revision_stale');

    fs.writeFileSync(file, JSON.stringify(baseResult(fixture.binding, { revision: 2, state: 'failed' })));
    assert.throws(() => fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_revision_conflict');

    const badBinding = { ...fixture.binding, snapshotSha256: 'b'.repeat(64) };
    fs.writeFileSync(file, JSON.stringify(baseResult(badBinding, { revision: 3 })));
    assert.throws(() => fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_binding_mismatch');

    fs.writeFileSync(file, JSON.stringify(baseResult(fixture.binding, { revision: 4, budget: { currency: 'CNY', capMinor: 1000, reservedMinor: 800, settledMinor: 201, usageKnown: true } })));
    assert.throws(() => fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_budget_exceeded');
    assert.throws(() => normalizeRuntimeResult(baseResult(fixture.binding, { operationId: '../outside' })), (error) => error.code === 'runtime_result_invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persists the full runtime binding and rejects stale or conflicting receipts after adapter restart', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-persistence-'));
  try {
    const fixture = prepareFixture(dir);
    const file = path.join(fixture.resultRoot, 'operation-a.json');
    fs.writeFileSync(file, JSON.stringify(baseResult(fixture.binding, { revision: 2, state: 'submission_unknown', budget: { currency: 'CNY', capMinor: 1000, reservedMinor: 500, settledMinor: 0, usageKnown: false } })));
    const first = fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(first.state, 'submission_unknown');
    assert.equal(first.budget.reservedMinor, 500);
    const indexFile = path.join(fixture.resultRoot, '.runtime-consumption', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].result.binding.projectId, 'project-a');
    assert.equal(index.entries[0].result.binding.briefId, 'brief-a');
    assert.equal(index.entries[0].result.binding.briefVersion, 1);
    assert.equal(index.entries[0].result.binding.snapshotSha256, fixture.binding.snapshotSha256);
    assert.equal(index.entries[0].result.operationId, 'operation-a');
    assert.equal(index.entries[0].result.requestDigest, 'd'.repeat(64));
    assert.equal(index.entries[0].result.revision, 2);
    assert.equal(index.entries[0].result.state, 'submission_unknown');

    const restarted = createReadOnlyVideoRuntimeResultAdapter({ resultRoot: fixture.resultRoot, mediaRoot: fixture.mediaRoot, exportRoot: fixture.exportRoot, projectId: 'project-a', snapshotResolver: () => ({ document: { identity: { projectId: 'project-a' }, briefId: 'brief-a', briefVersion: 1 }, sha256: fixture.binding.snapshotSha256 }) });
    const same = restarted.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    assert.equal(same.state, 'submission_unknown');
    assert.equal(same.budget.usageKnown, false);
    assert.throws(() => restarted.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a', requestDigest: 'e'.repeat(64) }), (error) => error.code === 'runtime_request_mismatch');
    assert.throws(() => restarted.read({ projectId: 'project-b', briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_scope_mismatch');

    fs.writeFileSync(file, JSON.stringify(baseResult(fixture.binding, { revision: 1 })));
    assert.throws(() => restarted.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_revision_stale');
    fs.writeFileSync(file, JSON.stringify(baseResult(fixture.binding, { revision: 2, state: 'failed' })));
    assert.throws(() => restarted.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_revision_conflict');
    fs.writeFileSync(file, JSON.stringify(baseResult({ ...fixture.binding, projectId: 'project-b' }, { revision: 3 })));
    assert.throws(() => restarted.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_binding_mismatch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed on an interrupted or corrupt durable index', { skip: !TMP_ROOT }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-index-guards-'));
  try {
    const fixture = prepareFixture(dir);
    fs.writeFileSync(path.join(fixture.resultRoot, 'operation-a.json'), JSON.stringify(baseResult(fixture.binding)));
    fixture.adapter.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' });
    const persistenceDir = path.join(fixture.resultRoot, '.runtime-consumption');
    fs.writeFileSync(path.join(persistenceDir, 'index.json.tmp'), '{"partial":true}', 'utf8');
    const restarted = createReadOnlyVideoRuntimeResultAdapter({ resultRoot: fixture.resultRoot, mediaRoot: fixture.mediaRoot, exportRoot: fixture.exportRoot, projectId: 'project-a', snapshotResolver: () => ({ document: { identity: { projectId: 'project-a' }, briefId: 'brief-a', briefVersion: 1 }, sha256: fixture.binding.snapshotSha256 }) });
    assert.throws(() => restarted.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_persistence_incomplete');
    fs.rmSync(path.join(persistenceDir, 'index.json.tmp'));
    fs.rmSync(path.join(persistenceDir, 'index.json'));
    const missing = createReadOnlyVideoRuntimeResultAdapter({ resultRoot: fixture.resultRoot, mediaRoot: fixture.mediaRoot, exportRoot: fixture.exportRoot, projectId: 'project-a', snapshotResolver: () => ({ document: { identity: { projectId: 'project-a' }, briefId: 'brief-a', briefVersion: 1 }, sha256: fixture.binding.snapshotSha256 }) });
    assert.throws(() => missing.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_persistence_incomplete');
    fs.writeFileSync(path.join(persistenceDir, 'index.json'), '{broken', 'utf8');
    const corrupt = createReadOnlyVideoRuntimeResultAdapter({ resultRoot: fixture.resultRoot, mediaRoot: fixture.mediaRoot, exportRoot: fixture.exportRoot, projectId: 'project-a', snapshotResolver: () => ({ document: { identity: { projectId: 'project-a' }, briefId: 'brief-a', briefVersion: 1 }, sha256: fixture.binding.snapshotSha256 }) });
    assert.throws(() => corrupt.read({ briefId: 'brief-a', version: 1, operationId: 'operation-a' }), (error) => error.code === 'runtime_persistence_corrupt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function snapshotFixture() {
  const identity = { projectId: 'project-a', brand: 'brand-a', market: 'US', passportId: 'passport-a', skuId: 'sku-a', channel: 'amazon', marketplace: 'US', locale: 'en-US', imageRole: 'SUBIMAGE', imageIndex: 1 };
  const product = { passportId: 'passport-a', skuId: 'sku-a', productFamilyKey: 'family-a', designKey: 'design-a', title: 'Runtime tumbler', category: 'Tumblers' };
  const facts = [{ factId: 'fact-a', version: 1, contentSha256: 'a'.repeat(64) }];
  const assets = [];
  const document = {
    schemaVersion: creative.CREATIVE_SCHEMA_VERSION, kind: creative.CREATIVE_SNAPSHOT_KIND, identity, identityKey: creative.identityKey(identity),
    briefId: 'brief-http', briefVersion: 1, product, facts, assets, versions: { factVersions: facts, assetVersions: [] },
    brief: { identity, product, allowedClaims: [{ text: 'Runtime synthetic claim' }], factVersions: facts, assetVersions: [], media: { status: 'not_generated' } },
    media: { status: 'not_generated' }
  };
  return document;
}

async function waitForServer(child, stdout, stderr) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`runtime HTTP server did not start: ${stdout.value}\n${stderr.value}`)), 10000);
    const poll = setInterval(() => {
      const match = stdout.value.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearInterval(poll); clearTimeout(deadline); resolve(`http://127.0.0.1:${match[1]}`); }
    }, 20);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`runtime HTTP server exited (${code}): ${stderr.value}`)); });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill();
  });
}

test('HTTP runtime result consumption exposes only controlled v1 data and readiness metadata', { skip: !TMP_ROOT }, async () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'video-runtime-http-'));
  let child;
  let base;
  try {
    const document = snapshotFixture();
    const metaRoot = path.join(dir, 'meta');
    const snapshotDir = creative.snapshotDir({ metaRoot, identity: document.identity });
    const snapshotFile = path.join(snapshotDir, 'v000001.json');
    fs.writeFileSync(snapshotFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const snapshotHash = sha256(fs.readFileSync(snapshotFile));
    fs.writeFileSync(path.join(snapshotDir, 'head.json'), JSON.stringify({ schemaVersion: creative.CREATIVE_SCHEMA_VERSION, kind: 'creative-brief-head', identityKey: document.identityKey, currentVersion: 1, fileName: 'v000001.json', sha256: snapshotHash, briefId: document.briefId }));
    const dbPath = path.join(dir, 'creative.db');
    const db = openDb(dbPath);
    db.exec('CREATE TABLE creative_briefs (id TEXT PRIMARY KEY, project_id TEXT, product_passport_id TEXT, sku_id TEXT, channel TEXT, locale TEXT, version INTEGER)');
    db.prepare('INSERT INTO creative_briefs VALUES (?, ?, ?, ?, ?, ?, ?)').run(document.briefId, 'project-a', 'passport-a', 'sku-a', 'amazon', 'en-US', 1);
    db.close();
    const resultRoot = path.join(dir, 'results'); const mediaRoot = path.join(dir, 'media'); const exportRoot = path.join(dir, 'exports');
    for (const root of [resultRoot, mediaRoot, exportRoot]) fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(resultRoot, 'op-http.json'), JSON.stringify(baseResult({ projectId: 'project-a', briefId: document.briefId, briefVersion: 1, snapshotSha256: snapshotHash }, { operationId: 'op-http' })));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      videoSnapshot: { dbPath, metaRoot, projectId: 'project-a' },
      videoRuntime: { resultRoot, mediaRoot, exportRoot, projectId: 'project-a' }
    }));
    const sandbox = path.join(dir, 'app'); fs.mkdirSync(sandbox, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(sandbox, 'server.js'));
    fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(sandbox, 'lib'), { recursive: true });
    fs.cpSync(path.join(__dirname, '..', 'public'), path.join(sandbox, 'public'), { recursive: true });
    const startServer = async () => {
      const stdout = { value: '' }; const stderr = { value: '' };
      const processRef = spawn(process.execPath, ['server.js'], { cwd: sandbox, env: { ...process.env, PORT: '0', COMMERCE_TASKS_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      processRef.stdout.on('data', (chunk) => { stdout.value += chunk.toString(); });
      processRef.stderr.on('data', (chunk) => { stderr.value += chunk.toString(); });
      const url = await waitForServer(processRef, stdout, stderr);
      return { processRef, url };
    };
    ({ processRef: child, url: base } = await startServer());
    const capabilities = await fetch(`${base}/api/video/capabilities`).then((response) => response.json());
    assert.equal(capabilities.data.runtimeResult.configured, true);
    const response = await fetch(`${base}/api/video/runtime-result?briefId=${encodeURIComponent(document.briefId)}&version=1&operationId=op-http`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.mode, 'simulated');
    assert.equal(body.data.media.status, 'absent');
    assert.equal(body.consumption.ready, false);
    assert.ok(body.consumption.reasons.includes('simulated_mode_only'));

    const mediaBytes = Buffer.from('http verified media bytes');
    fs.writeFileSync(path.join(mediaRoot, 'http-media.mp4'), mediaBytes);
    fs.writeFileSync(path.join(exportRoot, 'http-export.mp4'), Buffer.from('http tampered export bytes'));
    fs.writeFileSync(path.join(resultRoot, 'op-tampered.json'), JSON.stringify(baseResult({ projectId: 'project-a', briefId: document.briefId, briefVersion: 1, snapshotSha256: snapshotHash }, {
      operationId: 'op-tampered', mode: 'real', state: 'succeeded',
      media: { status: 'verified', artifactId: 'http-media.mp4', sha256: sha256(mediaBytes), bytes: mediaBytes.length },
      qa: { status: 'passed', codes: [] },
      export: { status: 'ready', artifactId: 'http-export.mp4' }
    })));
    const tampered = await fetch(`${base}/api/video/runtime-result?briefId=${encodeURIComponent(document.briefId)}&version=1&operationId=op-tampered`);
    const tamperedBody = await tampered.json();
    assert.equal(tampered.status, 200);
    assert.equal(tamperedBody.data.mode, 'real');
    assert.equal(tamperedBody.data.export.status, 'not_ready');
    assert.ok(tamperedBody.data.errors.includes('EXPORT_MEDIA_MISMATCH'));
    assert.equal(tamperedBody.consumption.ready, false);
    assert.ok(tamperedBody.consumption.reasons.includes('export_not_ready'));
    const rejected = await fetch(`${base}/api/video/runtime-result?briefId=${encodeURIComponent(document.briefId)}&version=1&operationId=op-http&json=%7B%7D`);
    assert.equal(rejected.status, 422);

    await stopServer(child);
    ({ processRef: child, url: base } = await startServer());
    const restarted = await fetch(`${base}/api/video/runtime-result?briefId=${encodeURIComponent(document.briefId)}&version=1&operationId=op-http`);
    const restartedBody = await restarted.json();
    assert.equal(restarted.status, 200);
    assert.equal(restartedBody.data.revision, 1);
    assert.equal(restartedBody.data.state, 'succeeded');
    assert.equal(restartedBody.consumption.ready, false);
    assert.ok(restartedBody.consumption.reasons.includes('simulated_mode_only'));

    fs.rmSync(path.join(resultRoot, 'op-http.json'));
    await stopServer(child);
    ({ processRef: child, url: base } = await startServer());
    const recovered = await fetch(`${base}/api/video/runtime-result?briefId=${encodeURIComponent(document.briefId)}&version=1&operationId=op-http`);
    const recoveredBody = await recovered.json();
    assert.equal(recovered.status, 200);
    assert.equal(recoveredBody.data.state, 'blocked');
    assert.ok(recoveredBody.data.errors.includes('RUNTIME_RESULT_SOURCE_UNAVAILABLE'));
    assert.equal(recoveredBody.data.budget.reservedMinor, 0);
    assert.equal(recoveredBody.data.budget.settledMinor, 0);
    assert.equal(recoveredBody.consumption.ready, false);

    fs.writeFileSync(path.join(resultRoot, 'op-http.json'), '{corrupt', 'utf8');
    const corruptSource = await fetch(`${base}/api/video/runtime-result?briefId=${encodeURIComponent(document.briefId)}&version=1&operationId=op-http`);
    const corruptSourceBody = await corruptSource.json();
    assert.equal(corruptSource.status, 200);
    assert.equal(corruptSourceBody.data.state, 'blocked');
    assert.ok(corruptSourceBody.data.errors.includes('RUNTIME_RESULT_SOURCE_INVALID'));
    assert.equal(corruptSourceBody.consumption.ready, false);

    fs.writeFileSync(path.join(resultRoot, 'op-http.json'), JSON.stringify({ schemaVersion: 'unsupported' }), 'utf8');
    const malformedSource = await fetch(`${base}/api/video/runtime-result?briefId=${encodeURIComponent(document.briefId)}&version=1&operationId=op-http`);
    const malformedSourceBody = await malformedSource.json();
    assert.equal(malformedSource.status, 200);
    assert.equal(malformedSourceBody.data.state, 'blocked');
    assert.ok(malformedSourceBody.data.errors.includes('RUNTIME_RESULT_SOURCE_INVALID'));
    assert.equal(malformedSourceBody.consumption.ready, false);
  } finally {
    await stopServer(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
