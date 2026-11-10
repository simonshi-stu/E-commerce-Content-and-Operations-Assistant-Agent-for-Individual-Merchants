'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateVideoBytes } = require('../lib/video-media-validation');
const { runtimeReadiness } = require('../lib/video-readiness');
const { SCHEMA_VERSION, createReadOnlyVideoRuntimeResultAdapter } = require('../lib/video-runtime-result');
const synthetic = require('../test-support/video-pattern.cjs');

function receipt() {
  return {
    schemaVersion: SCHEMA_VERSION, mode: 'real', operationId: 'decode-regression', requestDigest: 'd'.repeat(64),
    binding: { projectId: 'project', briefId: 'brief', briefVersion: 1, snapshotSha256: 'a'.repeat(64) },
    revision: 1, state: 'succeeded',
    media: { status: 'verified', artifactId: 'input.mp4', sha256: 'b'.repeat(64), bytes: 1 },
    qa: { status: 'passed', codes: [] }, export: { status: 'ready', artifactId: 'output.mp4' },
    budget: { currency: 'CNY', capMinor: 1000, reservedMinor: 0, settledMinor: 0, usageKnown: true }, errors: []
  };
}

test('a genuine locally generated MP4 decodes, without proving provider generation', () => {
  assert.equal(validateVideoBytes(synthetic), null);
});

test('fake bytes, playlists, corrupt MP4 and truncated video fail decoding', () => {
  assert.equal(validateVideoBytes(Buffer.from('synthetic video bytes')), 'MEDIA_CONTAINER_INVALID');
  assert.equal(validateVideoBytes(Buffer.from('#EXTM3U\nhttps://example.com/track')), 'MEDIA_CONTAINER_INVALID');
  assert.equal(validateVideoBytes(Buffer.from('0000ftypthis is not a movie')), 'MEDIA_DECODE_FAILED');
  assert.equal(validateVideoBytes(synthetic.subarray(0, synthetic.length - 200)), 'MEDIA_DECODE_FAILED');
});

test('missing decoder fails closed instead of substituting a hash check', () => {
  const before = process.env.PATH;
  try { process.env.PATH = ''; assert.equal(validateVideoBytes(synthetic), 'MEDIA_DECODER_UNAVAILABLE'); }
  finally { if (before === undefined) delete process.env.PATH; else process.env.PATH = before; }
});

test('real receipt with matching hashes cannot promote arbitrary bytes to deliverable video', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-completion-test-'));
  try {
    for (const name of ['media', 'export']) fs.mkdirSync(path.join(root, name));
    const value = receipt();
    const bytes = Buffer.from('synthetic video bytes');
    value.media.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); value.media.bytes = bytes.length;
    fs.writeFileSync(path.join(root, 'media/input.mp4'), bytes);
    fs.writeFileSync(path.join(root, 'export/output.mp4'), bytes);
    fs.writeFileSync(path.join(root, `${value.operationId}.json`), JSON.stringify(value));
    const adapter = createReadOnlyVideoRuntimeResultAdapter({ resultRoot: root, projectId: 'project',
      snapshotResolver: () => ({ document: { identity: { projectId: 'project' }, briefId: 'brief', briefVersion: 1 }, sha256: value.binding.snapshotSha256 }) });
    const result = adapter.read({ briefId: 'brief', version: 1, operationId: value.operationId });
    assert.equal(result.state, 'blocked');
    assert.equal(result.media.status, 'absent');
    assert.equal(result.export.status, 'not_ready');
    assert.ok(result.errors.includes('MEDIA_CONTAINER_INVALID'));
    assert.equal(runtimeReadiness(result).ready, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('valid decodable bytes pass only artifact consumption, never E2E provider proof', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-completion-positive-'));
  try {
    for (const name of ['media', 'export']) fs.mkdirSync(path.join(root, name));
    const value = receipt();
    value.media.sha256 = crypto.createHash('sha256').update(synthetic).digest('hex'); value.media.bytes = synthetic.length;
    fs.writeFileSync(path.join(root, 'media/input.mp4'), synthetic);
    fs.writeFileSync(path.join(root, 'export/output.mp4'), synthetic);
    fs.writeFileSync(path.join(root, `${value.operationId}.json`), JSON.stringify(value));
    const adapter = createReadOnlyVideoRuntimeResultAdapter({ resultRoot: root, projectId: 'project',
      snapshotResolver: () => ({ document: { identity: { projectId: 'project' }, briefId: 'brief', briefVersion: 1 }, sha256: value.binding.snapshotSha256 }) });
    const result = adapter.read({ briefId: 'brief', version: 1, operationId: value.operationId });
    const readiness = runtimeReadiness(result);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.endToEndVerified, false);
    assert.equal(readiness.evidenceScope, 'controlled_media_and_receipt_only');
    assert.deepEqual(adapter.read({ briefId: 'brief', version: 1, operationId: value.operationId }), result);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [name, mutate, reason] of [
  ['unknown actual cost', (r) => { r.budget.usageKnown = false; }, 'budget_usage_unknown'],
  ['unsettled reservation', (r) => { r.budget.reservedMinor = 100; }, 'budget_reservation_unsettled'],
  ['runtime error', (r) => { r.errors = ['PROVIDER_FAILED']; }, 'runtime_errors_unresolved'],
  ['unresolved QA finding', (r) => { r.qa.codes = ['PRODUCT_MISMATCH']; }, 'qa_findings_unresolved'],
  ['simulated output', (r) => { r.mode = 'simulated'; }, 'simulated_mode_only']
]) test(`readiness rejects ${name}`, () => {
  const value = receipt(); mutate(value); const actual = runtimeReadiness(value);
  assert.equal(actual.ready, false); assert.equal(actual.newPaidWorkAllowed, false); assert.ok(actual.reasons.includes(reason));
});

test('unknown submission remains blocked from new paid work even with a zero reservation', () => {
  const value = receipt(); value.state = 'submission_unknown';
  assert.equal(runtimeReadiness(value).newPaidWorkAllowed, false);
});
