'use strict';
/**
 * T1.3 — Evidence / Observation fact-model tests.
 * Real SQLite path with the private tmp from $COMMERCE_TEST_TMP (never writes inside [W], never
 * os.tmpdir, never real materials). Synthetic fixtures only; no product-specific data in code.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const { CORE_TABLES, openDb, migrateUp, migrateDown, listApplied } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m2 = require(path.join(W, 'lib', 'commerce', 'migrations', '0002_passport_sku.js'));
const m3 = require(path.join(W, 'lib', 'commerce', 'migrations', '0003_evidence_observation.js'));
const repo = require(path.join(W, 'lib', 'commerce', 'evidence.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.3 tests write only to the private runtime tmp';

function freshDb(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `evidence-${label}-`));
  const db = openDb(path.join(dir, 'commerce.db'));
  migrateUp(db, [core, m2, m3]);
  return { dir, db };
}

const OBSERVED_AT = '2026-10-08T00:00:00.000Z';

test('migration 0003 adds evidence/observation support without touching 0001/0002 history', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'evidence-mig-'));
  const db = openDb(path.join(dir, 'commerce.db'));
  migrateUp(db, [core, m2]);
  const before = listApplied(db).map((row) => ({ version: row.version, checksum: row.checksum }));
  assert.deepEqual(migrateUp(db, [core, m2, m3]), [3]);
  const after = listApplied(db).map((row) => ({ version: row.version, checksum: row.checksum }));
  assert.deepEqual(after.slice(0, 2), before, '0001/0002 ledger rows must remain unchanged');
  const evidenceColumns = new Set(db.prepare('PRAGMA table_info(evidence)').all().map((c) => c.name));
  for (const column of ['captured_at', 'import_basis', 'hash_verified']) assert.ok(evidenceColumns.has(column), `missing evidence.${column}`);
  const observationColumns = new Set(db.prepare('PRAGMA table_info(observations)').all().map((c) => c.name));
  for (const column of ['subject_type', 'subject_id', 'ttl_seconds', 'expires_at', 'approval_changed_at']) assert.ok(observationColumns.has(column), `missing observations.${column}`);
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => r.name));
  for (const name of ['ix_evidence_project_source', 'ix_observations_subject', 'ix_observations_superseded']) assert.ok(names.has(name), `missing ${name}`);
  assert.deepEqual(migrateDown(db, [core, m2, m3], { to: 2 }), [3]);
  const afterDown = new Set(db.prepare('PRAGMA table_info(evidence)').all().map((c) => c.name));
  assert.ok(!afterDown.has('captured_at'), '0003 evidence columns must be reverted');
  for (const table of CORE_TABLES) assert.ok(new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)).has(table), `0001 table lost on 0003 down: ${table}`);
  assert.deepEqual(listApplied(db).map((row) => row.version), [1, 2]);
  assert.deepEqual(migrateUp(db, [core, m2, m3]), [3]);
  assert.deepEqual(migrateUp(db, [core, m2, m3]), []);
  db.close();
});

test('evidence import hashes real bytes, dedups per project, declared metadata stays unverified', { skip }, () => {
  const { dir, db } = freshDb('import');
  const sourcePath = path.join(dir, 'source.txt');
  const bytes = Buffer.from('synthetic source bytes v1');
  fs.writeFileSync(sourcePath, bytes);
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');

  const imported = repo.importEvidenceFromFile(db, 'proj-a', { filePath: sourcePath, sourceType: 'manual_upload', observedAt: OBSERVED_AT, licenseNote: 'synthetic fixture', importBasis: 'fixture import' });
  assert.equal(imported.sha256, expectedHash, 'hash must be computed from real bytes');
  assert.equal(imported.hash_verified, 1);
  assert.equal(imported.deduplicated, false);
  const again = repo.importEvidenceFromFile(db, 'proj-a', { filePath: sourcePath, importBasis: 'fixture import' });
  assert.equal(again.deduplicated, true);
  assert.equal(repo.listEvidence(db, 'proj-a').length, 1, 'per-project hash dedup');

  assert.throws(() => repo.recordDeclaredEvidence(db, 'proj-a', { sha256: expectedHash, sourceType: 'user_statement' }), /importBasis/);
  assert.throws(() => repo.recordDeclaredEvidence(db, 'proj-a', { sha256: 'not-a-hash', importBasis: 'declared' }), /64-character hex/);
  const declared = repo.recordDeclaredEvidence(db, 'proj-a', { sha256: 'b'.repeat(64), sourceType: 'user_statement', importBasis: 'declared by user, bytes not provided' });
  assert.equal(declared.hash_verified, 0, 'declared hash is never byte-verified');
  assert.throws(() => repo.importEvidenceFromFile(db, 'proj-a', { filePath: sourcePath, sourceType: 'bogus' }), /sourceType/);

  const other = repo.importEvidenceFromFile(db, 'proj-b', { filePath: sourcePath, importBasis: 'fixture import' });
  assert.equal(other.deduplicated, false, 'same hash in another project is a separate row');
  assert.equal(repo.getEvidence(db, 'proj-b', imported.id), null, 'cross-project evidence read is refused');
  db.close();
});

test('approval never changes originType; illegal transitions and statuses are rejected', { skip }, () => {
  const { db } = freshDb('approval');
  const estimate = repo.createObservation(db, 'proj-a', {
    subjectType: 'sku', subjectId: 'variant-1', key: 'landed_cost', value: '12.5', unit: 'USD',
    originType: 'estimate', observedAt: OBSERVED_AT
  });
  assert.equal(estimate.approval_status, 'unreviewed');
  assert.equal(estimate.approval_changed_at, null);
  const confirmed = repo.setObservationApproval(db, 'proj-a', estimate.id, 'user_confirmed');
  assert.equal(confirmed.approval_status, 'user_confirmed');
  assert.equal(confirmed.origin_type, 'estimate', 'user-confirmed estimate stays an estimate');
  assert.ok(confirmed.approval_changed_at, 'approval change time recorded');
  assert.throws(() => repo.setObservationApproval(db, 'proj-a', estimate.id, 'rejected'), /cannot change from user_confirmed/);
  assert.throws(() => repo.setObservationApproval(db, 'proj-a', estimate.id, 'approved'), /approvalStatus/);

  const statement = repo.createObservation(db, 'proj-a', {
    subjectType: 'product_family', subjectId: 'companion-unit', key: 'dialog_mode', value: 'open-ended',
    originType: 'user_statement', approvalStatus: 'user_confirmed', observedAt: OBSERVED_AT
  });
  assert.equal(statement.origin_type, 'user_statement', 'user confirmation does not upgrade a statement to a measurement');
  assert.throws(() => repo.createObservation(db, 'proj-a', { subjectType: 'sku', subjectId: 'x', key: 'k', value: '1', originType: 'pdp_guess', observedAt: OBSERVED_AT }), /originType/);
  db.close();
});

test('value and unit validation never silently converts or drops input', { skip }, () => {
  const { db } = freshDb('values');
  const base = { subjectType: 'sku', subjectId: 'variant-1', key: 'weight', originType: 'seller_statement', observedAt: OBSERVED_AT };
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '', {}, []]) {
    assert.throws(() => repo.createObservation(db, 'proj-a', { ...base, value: bad }), /value must be/, `value ${String(bad)} must be rejected`);
  }
  const numeric = repo.createObservation(db, 'proj-a', { ...base, value: 12.5, unit: 'kg' });
  assert.equal(numeric.value_text, '12.5', 'finite numbers are stored deterministically');
  assert.equal(numeric.unit, 'kg', 'unit is stored verbatim');
  assert.throws(() => repo.createObservation(db, 'proj-a', { ...base, value: '12.5', unit: '' }), /unit must be/);
  const currency = repo.createObservation(db, 'proj-a', { ...base, key: 'price', value: '19.99', unit: 'USD' });
  assert.equal(currency.value_text, '19.99');
  assert.equal(currency.unit, 'USD', 'no currency conversion happens here');
  const noUnit = repo.createObservation(db, 'proj-a', { ...base, key: 'note', value: 'transparent' });
  assert.equal(noUnit.unit, null);
  db.close();
});

test('observed time and TTL are explicit; freshness uses an injected clock', { skip }, () => {
  const { db } = freshDb('ttl');
  const base = { subjectType: 'sku', subjectId: 'variant-1', key: 'price', value: '19.99', unit: 'USD', originType: 'pdp_measured' };
  assert.throws(() => repo.createObservation(db, 'proj-a', { ...base, observedAt: 'not-a-date' }), /observedAt/);
  for (const badTtl of [0, -5, 1.5, '60', repo.MAX_TTL_SECONDS + 1]) {
    assert.throws(() => repo.createObservation(db, 'proj-a', { ...base, observedAt: OBSERVED_AT, ttlSeconds: badTtl }), /ttlSeconds/, `ttl ${String(badTtl)} must be rejected`);
  }
  const withTtl = repo.createObservation(db, 'proj-a', { ...base, observedAt: OBSERVED_AT, ttlSeconds: 3600 });
  assert.equal(withTtl.expires_at, '2026-10-08T01:00:00.000Z', 'expiresAt = observedAt + ttlSeconds');
  assert.equal(repo.observationFreshness(withTtl, '2026-10-08T00:59:59.000Z').expired, false);
  assert.equal(repo.observationFreshness(withTtl, '2026-10-08T01:00:00.000Z').expired, true, 'boundary is inclusive');
  const noTtl = repo.createObservation(db, 'proj-a', { ...base, observedAt: OBSERVED_AT });
  assert.equal(noTtl.expires_at, null);
  assert.equal(repo.observationFreshness(noTtl, '2099-01-01T00:00:00.000Z').expired, false, 'no TTL means no expiry');
  const listed = repo.listObservations(db, 'proj-a', { key: 'price', asOf: '2026-10-08T02:00:00.000Z' });
  assert.equal(listed.find((row) => row.id === withTtl.id).expired, true);
  assert.equal(listed.find((row) => row.id === noTtl.id).expired, false);
  db.close();
});

test('quantitative values require an explicit unit; qualitative text may omit it', { skip }, () => {
  const { db } = freshDb('unit-required');
  const base = { subjectType: 'sku', subjectId: 'fixture-variant', key: 'weight', originType: 'seller_statement', observedAt: OBSERVED_AT };
  for (const value of [12.5, '12.5', '0.5', '+3', '-2.25', '.5']) {
    assert.throws(() => repo.createObservation(db, 'proj-a', { ...base, value }), /unit is required for quantitative/, `value ${String(value)} must require a unit`);
  }
  assert.throws(() => repo.createObservation(db, 'proj-a', { ...base, value: 12.5, unit: '   ' }), /unit must be/);
  assert.equal(repo.listObservations(db, 'proj-a', { key: 'weight' }).length, 0, 'rejected facts never reached storage');
  const kg = repo.createObservation(db, 'proj-a', { ...base, value: 12.5, unit: 'kg' });
  assert.equal(kg.value_text, '12.5');
  assert.equal(kg.unit, 'kg');
  const price = repo.createObservation(db, 'proj-a', { ...base, key: 'price', value: '19.99', unit: 'USD' });
  assert.equal(price.value_text, '19.99');
  assert.equal(price.unit, 'USD', 'units are stored verbatim, never converted');
  const note = repo.createObservation(db, 'proj-a', { ...base, key: 'note', value: 'transparent' });
  assert.equal(note.unit, null, 'qualitative text may omit the unit');
  // supersede uses the same construction validation; a replacement inherits the old unit by default
  const v1 = repo.createObservation(db, 'proj-a', { ...base, key: 'landed_cost', value: '12.5', unit: 'USD' });
  const { replacement } = repo.supersedeObservation(db, 'proj-a', v1.id, { value: '13.1', originType: 'estimate', observedAt: OBSERVED_AT });
  assert.equal(replacement.unit, 'USD', 'same-subject replacement inherits the unit when not provided');
  const qualitative = repo.createObservation(db, 'proj-a', { ...base, key: 'material', value: 'aluminium' });
  assert.throws(() => repo.supersedeObservation(db, 'proj-a', qualitative.id, { value: 12.5, originType: 'estimate', observedAt: OBSERVED_AT }), /unit is required for quantitative/, 'a quantitative replacement of a unitless fact must not slip through');
  assert.equal(repo.getObservation(db, 'proj-a', qualitative.id).superseded_by, null, 'rejected replacement leaves the old row untouched');
  db.close();
});

test('timestamps require strict ISO format with real calendar dates and explicit timezones', { skip }, () => {
  const { db } = freshDb('strict-time');
  const base = { subjectType: 'sku', subjectId: 'fixture-time', key: 'price', value: '19.99', unit: 'USD', originType: 'estimate' };
  for (const bad of ['2026-02-30T00:00:00.000Z', '2026-02-29T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-00-10T00:00:00.000Z', '2026-10-08T24:00:00.000Z', '2026-10-08T00:60:00.000Z', '2026-10-08T00:00:00', '2026-10-08', 'not-a-date', '2026-10-08T00:00:00.000+0800', '0026-10-08T00:00:00.000Z']) {
    assert.throws(() => repo.createObservation(db, 'proj-a', { ...base, observedAt: bad }), (error) => error.code === 'validation' && /ISO-8601/.test(error.message), `observedAt ${bad} must be rejected`);
  }
  const offset = repo.createObservation(db, 'proj-a', { ...base, observedAt: '2026-10-08T08:00:00+08:00', ttlSeconds: 3600 });
  assert.equal(offset.expires_at, '2026-10-08T01:00:00.000Z', 'timezone offset is respected without reinterpretation');
  assert.equal(repo.observationFreshness(offset, '2026-10-08T00:59:59.999Z').expired, false);
  assert.equal(repo.observationFreshness(offset, '2026-10-08T01:00:00.000Z').expired, true, 'valid TTL endpoint stays inclusive');
  assert.throws(() => repo.listObservations(db, 'proj-a', { asOf: '2026-02-30T00:00:00.000Z' }), (error) => error.code === 'validation');
  const obs = repo.createObservation(db, 'proj-a', { ...base, observedAt: OBSERVED_AT });
  assert.throws(() => repo.setObservationApproval(db, 'proj-a', obs.id, 'user_confirmed', { now: '2026-02-30T00:00:00.000Z' }), (error) => error.code === 'validation');
  // evidence explicit metadata is validated before the hash-dedup early return
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'evidence-strict-'));
  const sourcePath = path.join(dir, 'source.txt');
  fs.writeFileSync(sourcePath, 'synthetic strict-time bytes');
  const first = repo.importEvidenceFromFile(db, 'proj-a', { filePath: sourcePath, observedAt: OBSERVED_AT, importBasis: 'fixture import' });
  assert.throws(() => repo.importEvidenceFromFile(db, 'proj-a', { filePath: sourcePath, observedAt: '2026-02-30T00:00:00.000Z', importBasis: 'fixture import' }), (error) => error.code === 'validation', 'dedup early return must not bypass explicit metadata validation');
  assert.throws(() => repo.recordDeclaredEvidence(db, 'proj-a', { sha256: first.sha256, observedAt: '2026-02-30T00:00:00.000Z', importBasis: 'declared' }), (error) => error.code === 'validation');
  assert.equal(repo.listEvidence(db, 'proj-a').length, 1, 'no duplicate evidence row was created');
  db.close();
});

test('supersede inherits the unit only when omitted; an explicit null is rejected and data stays unchanged', { skip }, () => {
  const { db } = freshDb('supersede-unit-null');
  const base = { subjectType: 'sku', subjectId: 'fixture-variant', key: 'landed_cost', originType: 'estimate', observedAt: OBSERVED_AT };
  const v1 = repo.createObservation(db, 'proj-a', { ...base, value: '12.5', unit: 'USD' });
  const snapshot = () => JSON.stringify(repo.listObservations(db, 'proj-a', { includeSuperseded: true }));
  const before = snapshot();
  assert.throws(() => repo.supersedeObservation(db, 'proj-a', v1.id, { value: '13.1', unit: null, originType: 'estimate', observedAt: OBSERVED_AT }), /unit is required for quantitative/, 'an explicit null unit must reach validation, not be replaced by the old unit');
  assert.throws(() => repo.supersedeObservation(db, 'proj-a', v1.id, { value: '13.1', unit: '   ', originType: 'estimate', observedAt: OBSERVED_AT }), /unit must be/, 'an explicit blank unit must be rejected');
  assert.equal(snapshot(), before, 'rejected replacements leave every observation row and the supersede chain untouched');
  assert.equal(repo.getObservation(db, 'proj-a', v1.id).superseded_by, null);
  const { old: superseded, replacement } = repo.supersedeObservation(db, 'proj-a', v1.id, { value: '13.1', originType: 'estimate', observedAt: OBSERVED_AT });
  assert.equal(replacement.unit, 'USD', 'an omitted unit still inherits the superseded fact unit');
  assert.equal(superseded.superseded_by, replacement.id);
  assert.deepEqual(
    repo.getObservationChain(db, 'proj-a', v1.id).map((row) => [row.value_text, row.unit]),
    [['12.5', 'USD'], ['13.1', 'USD']],
    'history stays readable with the inherited unit'
  );
  db.close();
});

test('supersede keeps history, requires the same subject and key, and is transactional', { skip }, () => {
  const { db } = freshDb('supersede');
  const sourcePath = path.join(fs.mkdtempSync(path.join(TMP_ROOT, 'evidence-src-')), 'note.txt');
  fs.writeFileSync(sourcePath, 'synthetic note bytes');
  const evidence = repo.importEvidenceFromFile(db, 'proj-a', { filePath: sourcePath, importBasis: 'fixture import' });

  const v1 = repo.createObservation(db, 'proj-a', {
    subjectType: 'sku', subjectId: 'variant-1', key: 'landed_cost', value: '12.5', unit: 'USD',
    originType: 'estimate', observedAt: OBSERVED_AT, evidenceId: evidence.id
  });
  const { old: superseded, replacement: v2 } = repo.supersedeObservation(db, 'proj-a', v1.id, {
    value: '13.1', originType: 'estimate', observedAt: '2026-10-08T02:00:00.000Z'
  });
  assert.equal(superseded.superseded_by, v2.id, 'old row points at its replacement');
  assert.equal(v2.evidence_id, evidence.id, 'replacement inherits the evidence reference by default');
  assert.equal(repo.getObservation(db, 'proj-a', v1.id).value_text, '12.5', 'old fact is never rewritten');
  assert.deepEqual(repo.listObservations(db, 'proj-a').map((row) => row.id), [v2.id], 'default list hides superseded rows');
  assert.deepEqual(repo.listObservations(db, 'proj-a', { includeSuperseded: true }).map((row) => row.id).sort(), [v1.id, v2.id].sort());
  assert.deepEqual(repo.getObservationChain(db, 'proj-a', v1.id).map((row) => row.id), [v1.id, v2.id], 'chain ordered oldest -> newest');
  assert.deepEqual(repo.getObservationChain(db, 'proj-a', v2.id).map((row) => row.id), [v1.id, v2.id], 'chain readable from either end');

  assert.throws(() => repo.supersedeObservation(db, 'proj-a', v1.id, { value: 'x', observedAt: OBSERVED_AT }), /already superseded/);
  const other = repo.createObservation(db, 'proj-a', { subjectType: 'sku', subjectId: 'variant-2', key: 'landed_cost', value: '9', unit: 'USD', originType: 'estimate', observedAt: OBSERVED_AT });
  assert.throws(() => repo.supersedeObservation(db, 'proj-a', other.id, { subjectId: 'variant-1', value: '9.5', observedAt: OBSERVED_AT }), /same subject and key/);
  assert.throws(() => repo.supersedeObservation(db, 'proj-b', other.id, { value: '9.5', observedAt: OBSERVED_AT }), /not found/);
  assert.throws(() => repo.supersedeObservation(db, 'proj-a', other.id, { value: Number.NaN, originType: 'estimate', observedAt: OBSERVED_AT }), /value must be/);
  assert.equal(repo.getObservation(db, 'proj-a', other.id).superseded_by, null, 'failed replacement leaves the old row untouched');
  db.close();
});

test('evidence references and observations stay project-scoped', { skip }, () => {
  const { db } = freshDb('isolation');
  const sourcePath = path.join(fs.mkdtempSync(path.join(TMP_ROOT, 'evidence-iso-')), 'note.txt');
  fs.writeFileSync(sourcePath, 'synthetic bytes for isolation');
  const evidenceA = repo.importEvidenceFromFile(db, 'proj-a', { filePath: sourcePath, importBasis: 'fixture import' });
  assert.throws(
    () => repo.createObservation(db, 'proj-b', { subjectType: 'sku', subjectId: 'v1', key: 'k', value: '1', unit: 'count', originType: 'estimate', observedAt: OBSERVED_AT, evidenceId: evidenceA.id }),
    /not found in this project/
  );
  assert.throws(
    () => repo.createObservation(db, 'proj-a', { subjectType: 'sku', subjectId: 'v1', key: 'k', value: '1', unit: 'count', originType: 'estimate', observedAt: OBSERVED_AT, evidenceId: 'ev_missing' }),
    /not found in this project/
  );
  const obs = repo.createObservation(db, 'proj-a', { subjectType: 'sku', subjectId: 'v1', key: 'k', value: '1', unit: 'count', originType: 'estimate', observedAt: OBSERVED_AT, evidenceId: evidenceA.id });
  assert.equal(repo.getObservation(db, 'proj-b', obs.id), null);
  assert.deepEqual(repo.listObservations(db, 'proj-b'), []);
  assert.throws(() => repo.setObservationApproval(db, 'proj-b', obs.id, 'user_confirmed'), /not found/);
  assert.throws(() => repo.getObservationChain(db, 'proj-b', obs.id), /not found/);
  db.close();
});

test('generic subjects model another category with the same fields (no product-specific schema)', { skip }, () => {
  const { db } = freshDb('generic');
  const family = repo.createObservation(db, 'proj-a', { subjectType: 'product_family', subjectId: 'family-x', key: 'material', value: 'aluminium', originType: 'seller_statement', observedAt: OBSERVED_AT });
  const variant = repo.createObservation(db, 'proj-a', { subjectType: 'sku', subjectId: 'variant-x', key: 'battery', value: 'standard', originType: 'user_statement', approvalStatus: 'user_confirmed', observedAt: OBSERVED_AT });
  assert.deepEqual(repo.listObservations(db, 'proj-a', { subjectType: 'product_family', subjectId: 'family-x' }).map((row) => row.id), [family.id]);
  assert.deepEqual(repo.listObservations(db, 'proj-a', { subjectType: 'sku', subjectId: 'variant-x' }).map((row) => row.id), [variant.id]);
  db.close();
});
