'use strict';
/**
 * T2.3 — idempotency / cache / reconciliation tests (revision-01 contract). Real SQLite
 * (0006+0007 isolated migrations), explicit clocks (no sleeps), synthetic fixtures only; the
 * worker linkage group uses the REAL approved worker library + run-store output. Temp files only
 * under $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const { openDb, migrateUp, migrateDown, backupTo, verifyDatabaseFile } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m4 = require(path.join(W, 'lib', 'commerce', 'migrations', '0004_run_store.js'));
const m5 = require(path.join(W, 'lib', 'commerce', 'migrations', '0005_run_store_lease_token.js'));
const m6 = require(path.join(W, 'lib', 'commerce', 'migrations', '0006_idempotency.js'));
const m7 = require(path.join(W, 'lib', 'commerce', 'migrations', '0007_idempotency_contract.js'));
const m8 = require(path.join(W, 'lib', 'commerce', 'migrations', '0008_idempotency_attempt_remote.js'));
const store = require(path.join(W, 'lib', 'commerce', 'run-store.js'));
const worker = require(path.join(W, 'lib', 'commerce', 'worker.js'));
const idem = require(path.join(W, 'lib', 'commerce', 'idempotency.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T2.3 tests write only to the private runtime tmp';

const T0 = '2026-10-09T00:00:00.000Z';
const T1 = '2026-10-09T00:01:00.000Z';
const T2 = '2026-10-09T00:02:00.000Z';

const hashOf = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

function baseInput(overrides = {}) {
  return {
    taskId: 'task-1',
    inputHash: hashOf('input-1'),
    tool: 'tool-x',
    toolVersion: '1.0.0',
    model: 'model-y',
    promptVersion: 'p1',
    templateVersion: 't1',
    policy: 'policy-default',
    project: 'proj-a',
    brand: 'brand-1',
    market: 'US',
    locale: 'en-US',
    shipTo: 'US',
    ttlMs: 60000,
    ...overrides
  };
}
function scopeOf(input) {
  const { ttlMs, ...scope } = input;
  return scope;
}
function freshIdem(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `idem-${label}-`));
  const dbPath = path.join(dir, 'idempotency.db');
  const db = openDb(dbPath);
  migrateUp(db, [m6, m7]);
  return { dir, dbPath, db };
}

test('T2.3 cache keys are canonical, dimension-complete and domain-isolated', { skip }, () => {
  const { dir, dbPath, db } = freshIdem('keys');
  // isolated migration chain: up -> backup -> down -> re-up -> restore verify
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes('cache_entries') && tables.includes('idempotent_operations') && tables.includes('operation_attempts') && tables.includes('reconcile_events'));
  const backupPath = path.join(dir, 'idem-backup.db');
  backupTo(db, backupPath);
  assert.deepEqual(migrateDown(db, [m6, m7]), [7, 6]);
  const afterDown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(!afterDown.includes('cache_entries'), 'down removed the idempotency tables');
  assert.deepEqual(migrateUp(db, [m6, m7]), [6, 7], 're-up after down');
  const restored = verifyDatabaseFile(backupPath, { expectedTables: ['cache_entries', 'idempotent_operations', 'operation_attempts', 'reconcile_events'] });
  assert.equal(restored.ok, true, JSON.stringify(restored));

  // canonical determinism + insertion-order independence
  const base = baseInput();
  const key0 = idem.cacheKeyFor(base);
  assert.equal(idem.cacheKeyFor(baseInput()), key0);
  const shuffled = {};
  Object.keys(base).reverse().forEach((dim) => { shuffled[dim] = base[dim]; });
  assert.equal(idem.cacheKeyFor(shuffled), key0, 'key is independent of field insertion order');

  // every dimension invalidates
  const changes = {
    taskId: 'task-2',
    inputHash: hashOf('input-2'),
    tool: 'tool-z',
    toolVersion: '2.0.0',
    model: 'model-z',
    promptVersion: 'p2',
    templateVersion: 't2',
    policy: 'policy-strict',
    project: 'proj-b',
    brand: 'brand-2',
    market: 'GB',
    locale: 'en-GB',
    shipTo: 'GB',
    ttlMs: 30000
  };
  for (const [dim, value] of Object.entries(changes)) {
    assert.notEqual(idem.cacheKeyFor(baseInput({ [dim]: value })), key0, `${dim} must invalidate the key`);
  }
  assert.notEqual(
    idem.cacheKeyFor(baseInput({ tool: 'x:y', toolVersion: 'z' })),
    idem.cacheKeyFor(baseInput({ tool: 'x', toolVersion: 'y:z' }))
  );

  // explicit null project/brand are distinct values, never wildcards
  const nullBrand = baseInput({ brand: null });
  assert.notEqual(idem.cacheKeyFor(nullBrand), key0);
  idem.putCache(db, nullBrand, { value: { price: 1 }, factKind: 'fact', observedAt: T0, now: T0 });
  assert.equal(idem.lookupCache(db, nullBrand, { now: T0 }).status, 'fresh');
  assert.equal(idem.lookupCache(db, baseInput(), { now: T0 }).status, 'miss', 'brand null is not a wildcard');

  // cross-domain isolation
  idem.putCache(db, baseInput(), { value: { price: 2 }, factKind: 'fact', observedAt: T0, now: T0 });
  assert.equal(idem.lookupCache(db, baseInput({ project: 'proj-b' }), { now: T0 }).status, 'miss');
  assert.equal(idem.lookupCache(db, baseInput(), { now: T0 }).value.price, 2);

  // missing/invalid dimensions fail explicitly
  const noTool = baseInput();
  delete noTool.tool;
  assert.throws(() => idem.cacheKeyFor(noTool), /must be provided/);
  assert.throws(() => idem.cacheKeyFor(baseInput({ inputHash: 'not-hex' })), /inputHash/);
  assert.throws(() => idem.cacheKeyFor(baseInput({ ttlMs: 0 })), /ttlMs/);
  assert.throws(() => idem.cacheKeyFor(baseInput({ project: undefined })), /must be provided/);
  db.close();
});

test('T2.3 TTL endpoints and observation freshness', { skip }, () => {
  const { db } = freshIdem('ttl');
  const input = baseInput({ ttlMs: 1000 });
  const entry = idem.putCache(db, input, { value: { price: 10 }, factKind: 'fact', observedAt: T0, now: T0 });
  assert.equal(entry.observedAt, T0);
  assert.equal(entry.writtenAt, T0);
  assert.equal(entry.expiresAt, '2026-10-09T00:00:01.000Z');

  assert.equal(idem.lookupCache(db, input, { now: '2026-10-09T00:00:00.999Z' }).status, 'fresh', 'before the endpoint');
  const endpoint = idem.lookupCache(db, input, { now: '2026-10-09T00:00:01.000Z' });
  assert.equal(endpoint.status, 'stale');
  assert.equal(endpoint.reason, 'ttl_expired', 'the endpoint itself is expired');

  // observation time is not the cache write time: an expired price observation is never fresh
  const price = baseInput({ taskId: 'price-task', ttlMs: 60000 });
  idem.putCache(db, price, { value: { price: 99 }, factKind: 'fact', observedAt: '2026-10-08T23:59:55.000Z', now: T0 });
  const freshNoWindow = idem.lookupCache(db, price, { now: '2026-10-09T00:00:01.000Z' });
  assert.equal(freshNoWindow.status, 'fresh');
  assert.equal(freshNoWindow.observedAt, '2026-10-08T23:59:55.000Z');
  assert.equal(freshNoWindow.writtenAt, T0);
  const observationWindow = idem.lookupCache(db, price, { now: '2026-10-09T00:00:01.000Z', maxObservationAgeMs: 3000 });
  assert.equal(observationWindow.status, 'stale');
  assert.equal(observationWindow.reason, 'observation_expired', 'a tighter caller window applies');
  const inside = idem.lookupCache(db, price, { now: '2026-10-09T00:00:00.999Z', maxObservationAgeMs: 6000 });
  assert.equal(inside.status, 'fresh', 'strictly inside the caller-tightened window');
  assert.equal(idem.lookupCache(db, price, { now: '2026-10-09T00:00:01.000Z', maxObservationAgeMs: 6000 }).status, 'stale', 'observation window endpoint is expired');
  db.close();
});

test('T2.3 stable operation identity, timeout and transactional claims', { skip }, () => {
  const { dbPath, db } = freshIdem('ops');
  const scope = scopeOf(baseInput());

  const first = idem.claimOperation(db, { operationId: 'op-1', scope, capability: 'unknown', now: T0 });
  assert.equal(first.decision, 'execute');
  assert.equal(first.operation.state, 'claimed');
  assert.equal(first.operation.attempts, 1, 'the execute permission consumes the first bounded attempt');
  const token1 = first.operation.attemptToken;
  assert.ok(token1, 'an execute permission carries an attempt token');
  assert.equal(idem.claimOperation(db, { operationId: 'op-1', scope, capability: 'unknown', now: T0 }).decision, 'in_progress', 'a claimed operation is never re-executed');
  assert.throws(
    () => idem.claimOperation(db, { operationId: 'op-1', scope: scopeOf(baseInput({ inputHash: hashOf('other') })), capability: 'unknown', now: T0 }),
    /different input\/version\/scope/
  );

  const submitted = idem.markSubmitted(db, 'op-1', { attemptToken: token1, remoteId: 'synthetic-remote-1', now: T0 });
  assert.equal(submitted.state, 'submitted');
  assert.equal(submitted.attempts, 1);
  const timedOut = idem.markTimeout(db, 'op-1', { attemptToken: token1, kind: 'timeout', now: T0 });
  assert.equal(timedOut.state, 'pending_reconcile');
  assert.equal(timedOut.remoteId, 'synthetic-remote-1', 'the remote id is retained across the timeout');
  assert.equal(timedOut.attempts, 1, 'a timeout does not auto-retry');
  const again = idem.claimOperation(db, { operationId: 'op-1', scope, capability: 'unknown', now: T0 });
  assert.equal(again.decision, 'pending_reconcile', 'no automatic resend of an uncertain charged call');
  assert.equal(again.operation.attempts, 1, 'claiming adds no attempt');

  // reopen: pending state reads back from the DB and still refuses execute
  db.close();
  const db2 = openDb(dbPath);
  const readBack = idem.getOperation(db2, 'op-1');
  assert.equal(readBack.state, 'pending_reconcile');
  assert.equal(readBack.remoteId, 'synthetic-remote-1');
  assert.equal(readBack.attempts, 1);
  assert.equal(idem.claimOperation(db2, { operationId: 'op-1', scope, capability: 'unknown', now: T0 }).decision, 'pending_reconcile');

  // crash after claim: a second caller still cannot execute
  assert.equal(idem.claimOperation(db2, { operationId: 'op-2', scope: scopeOf(baseInput({ taskId: 'task-2' })), capability: 'supported', now: T0 }).decision, 'execute');
  db2.close();
  const db3 = openDb(dbPath);
  assert.equal(idem.claimOperation(db3, { operationId: 'op-2', scope: scopeOf(baseInput({ taskId: 'task-2' })), capability: 'supported', now: T0 }).decision, 'in_progress');

  // two open connections cannot both be told to execute
  assert.equal(idem.claimOperation(db3, { operationId: 'op-3', scope, capability: 'unknown', now: T0 }).decision, 'execute');
  const db4 = openDb(dbPath);
  assert.equal(idem.claimOperation(db4, { operationId: 'op-3', scope, capability: 'unknown', now: T0 }).decision, 'in_progress');
  db4.close();

  // explicit capability grading
  assert.equal(idem.describeCapability('unknown').exactlyOnce, false);
  assert.equal(idem.describeCapability('unsupported').exactlyOnce, false);
  assert.equal(idem.describeCapability('supported').exactlyOnce, true);
  assert.equal(idem.describeCapability('supported').autoResendOnTimeout, false);
  db3.close();
});

test('T2.3 reconciliation states and worker crash reference linkage', { skip }, () => {
  const { dir, db } = freshIdem('reconcile');
  const scope = scopeOf(baseInput());

  // unknown stays pending/manual; not_submitted requires explicit evidence
  const firstR1 = idem.claimOperation(db, { operationId: 'op-r1', scope, capability: 'unknown', now: T0 });
  const tokenR1 = firstR1.operation.attemptToken;
  idem.markSubmitted(db, 'op-r1', { attemptToken: tokenR1, remoteId: 'remote-r1', now: T0 });
  idem.markTimeout(db, 'op-r1', { attemptToken: tokenR1, kind: 'network_unknown', now: T0 });
  const unknown = idem.reconcileOperation(db, 'op-r1', { attemptToken: tokenR1, query: 'unknown', now: T0 });
  assert.equal(unknown.decision, 'manual');
  assert.equal(idem.getOperation(db, 'op-r1').state, 'pending_reconcile');
  assert.throws(() => idem.reconcileOperation(db, 'op-r1', { attemptToken: tokenR1, query: 'not_submitted', now: T0 }), /explicit evidence/);
  const notSubmitted = idem.reconcileOperation(db, 'op-r1', { attemptToken: tokenR1, query: 'not_submitted', evidence: 'synthetic-provider: request id never accepted', now: T0 });
  assert.equal(notSubmitted.decision, 'retry_allowed');
  assert.equal(notSubmitted.state, 'confirmed_not_submitted');

  // bounded retry with the SAME operation id, each retry a fresh reservation
  const reserved2 = idem.claimOperation(db, { operationId: 'op-r1', scope, capability: 'unknown', now: T0 });
  assert.equal(reserved2.decision, 'retry_reserved');
  const tokenR1b = reserved2.operation.attemptToken;
  assert.notEqual(tokenR1b, tokenR1);
  const retry = idem.markSubmitted(db, 'op-r1', { attemptToken: tokenR1b, now: T0 });
  assert.equal(retry.operationId, 'op-r1');
  assert.equal(retry.attempts, 2);
  idem.markTimeout(db, 'op-r1', { attemptToken: tokenR1b, kind: 'timeout', now: T0 });
  idem.reconcileOperation(db, 'op-r1', { attemptToken: tokenR1b, query: 'not_submitted', evidence: 'synthetic-provider: rejected', now: T0 });
  const reserved3 = idem.claimOperation(db, { operationId: 'op-r1', scope, capability: 'unknown', now: T0 });
  assert.equal(reserved3.decision, 'retry_reserved');
  const tokenR1c = reserved3.operation.attemptToken;
  idem.markSubmitted(db, 'op-r1', { attemptToken: tokenR1c, now: T0 });
  idem.markTimeout(db, 'op-r1', { attemptToken: tokenR1c, kind: 'timeout', now: T0 });
  const exhausted = idem.reconcileOperation(db, 'op-r1', { attemptToken: tokenR1c, query: 'not_submitted', evidence: 'synthetic-provider: rejected', now: T0 });
  assert.equal(exhausted.decision, 'retry_exhausted');
  assert.equal(idem.claimOperation(db, { operationId: 'op-r1', scope, capability: 'unknown', now: T0 }).decision, 'retry_exhausted', 'no reservation beyond the retry budget');

  // effective is terminal: no resend, no downgrade, no cancel
  const firstR2 = idem.claimOperation(db, { operationId: 'op-r2', scope, capability: 'supported', now: T0 });
  const tokenR2 = firstR2.operation.attemptToken;
  idem.markSubmitted(db, 'op-r2', { attemptToken: tokenR2, remoteId: 'remote-r2', now: T0 });
  idem.markTimeout(db, 'op-r2', { attemptToken: tokenR2, kind: 'timeout', now: T0 });
  const effective = idem.reconcileOperation(db, 'op-r2', { attemptToken: tokenR2, query: 'effective', result: { charged: true }, now: T0 });
  assert.equal(effective.decision, 'no_retry');
  assert.equal(idem.claimOperation(db, { operationId: 'op-r2', scope, capability: 'supported', now: T0 }).decision, 'already_effective');
  assert.throws(() => idem.reconcileOperation(db, 'op-r2', { attemptToken: tokenR2, query: 'not_submitted', evidence: 'x', now: T0 }), /cannot reconcile/);
  assert.throws(() => idem.cancelOperation(db, 'op-r2', { reason: 'test', now: T0 }), /cannot cancel/);

  // cancel after submit keeps remoteId/pending cost; refund not guaranteed
  const firstR3 = idem.claimOperation(db, { operationId: 'op-r3', scope, capability: 'unknown', now: T0 });
  idem.markSubmitted(db, 'op-r3', { attemptToken: firstR3.operation.attemptToken, remoteId: 'remote-r3', now: T0 });
  const cancelled = idem.cancelOperation(db, 'op-r3', { reason: 'user cancel', now: T0 });
  assert.equal(cancelled.decision, 'cancelled');
  assert.equal(cancelled.operation.remoteId, 'remote-r3');
  assert.match(cancelled.operation.cancelReason, /refund not guaranteed/);
  assert.equal(idem.claimOperation(db, { operationId: 'op-r3', scope, capability: 'unknown', now: T0 }).decision, 'cancelled');
  db.close();

  // ---- worker crash/cancel reference linkage (REAL worker lib + run-store output) ----
  const wdir = fs.mkdtempSync(path.join(TMP_ROOT, 'idem-worker-'));
  const wdbPath = path.join(wdir, 'runs.db');
  const workerDir = path.join(wdir, 'worker');
  const wdb = openDb(wdbPath);
  migrateUp(wdb, [core, m4, m5]);
  const task = {
    taskType: 'synthetic-worker-job',
    inputVersion: 'v1',
    inputHash: hashOf('worker-input'),
    steps: [
      { id: 'submit', kind: 'remote-submit-sim', remoteId: 'synthetic-remote-t23', content: { text: 'original' } },
      { id: 'later', kind: 'write-artifact', content: { note: 'later' } }
    ]
  };
  const run = store.createRun(wdb, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(wdb, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0, runId: run.id, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  worker.requestCancel(workerDir, run.id, { actor: 'tester', reason: 'crash window', now: T1 });
  const cancelledRun = worker.runWorkerOnce(wdb, { projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T1, runId: run.id });
  assert.equal(cancelledRun.status, 'cancelled');
  const durable = store.getRun(wdb, 'proj-a', run.id).checkpoint.durableEffects.find((effect) => effect.stepId === 'submit');
  assert.ok(durable && durable.remoteId === 'synthetic-remote-t23' && durable.committed === false, 'real worker durable reference read back');
  wdb.close();

  const idb = openDb(path.join(dir, 'idem-link.db'));
  migrateUp(idb, [m6, m7]);
  const workerScope = scopeOf(baseInput({ taskId: 'worker-task', inputHash: task.inputHash }));
  const adopted = idem.adoptWorkerReference(idb, { operationId: durable.operationId, remoteId: durable.remoteId, scope: workerScope, capability: 'unknown', committed: durable.committed, source: 'worker_cancel', now: T1 });
  assert.equal(adopted.decision, 'pending_reconcile');
  assert.equal(adopted.operation.remoteId, 'synthetic-remote-t23');
  assert.equal(adopted.operation.attempts, 1);
  const adoptedToken = adopted.operation.attemptToken;
  assert.equal(idem.claimOperation(idb, { operationId: durable.operationId, scope: workerScope, capability: 'unknown', now: T1 }).decision, 'pending_reconcile', 'a crash reference is uncertain, never auto-retryable');
  assert.equal(idem.reconcileOperation(idb, durable.operationId, { attemptToken: adoptedToken, query: 'unknown', now: T1 }).decision, 'manual');
  const queryNotSubmitted = idem.reconcileOperation(idb, durable.operationId, { attemptToken: adoptedToken, query: 'not_submitted', evidence: 'synthetic-provider: submit never acknowledged', now: T1 });
  assert.equal(queryNotSubmitted.decision, 'retry_allowed');
  const workerReserve = idem.claimOperation(idb, { operationId: durable.operationId, scope: workerScope, capability: 'unknown', now: T1 });
  assert.equal(workerReserve.decision, 'retry_reserved');
  const retried = idem.markSubmitted(idb, durable.operationId, { attemptToken: workerReserve.operation.attemptToken, now: T1 });
  assert.equal(retried.operationId, durable.operationId, 'stable operation id across the retry');

  // a second reference confirmed effective forbids any resend
  const adopted2 = idem.adoptWorkerReference(idb, { operationId: 'op-w2', remoteId: 'synthetic-remote-t23b', scope: workerScope, capability: 'unsupported', committed: true, source: 'worker_cancel', now: T1 });
  assert.equal(adopted2.decision, 'pending_reconcile');
  idem.reconcileOperation(idb, 'op-w2', { attemptToken: adopted2.operation.attemptToken, query: 'effective', now: T1 });
  assert.equal(idem.claimOperation(idb, { operationId: 'op-w2', scope: workerScope, capability: 'unsupported', now: T1 }).decision, 'already_effective');

  // reconcile log round-trip (export/observation only; the DB is the safety record)
  const logFile = path.join(dir, 'reconcile-log.json');
  idem.appendReconcileLog(logFile, { operationId: durable.operationId, query: 'unknown', decision: 'manual', state: 'pending_reconcile', remoteId: durable.remoteId, now: T1 });
  idem.appendReconcileLog(logFile, { operationId: 'op-w2', query: 'effective', decision: 'no_retry', state: 'confirmed_effective', remoteId: 'synthetic-remote-t23b', now: T1 });
  const log = idem.readReconcileLog(logFile);
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].decision, 'manual');
  assert.equal(log.entries[1].state, 'confirmed_effective');
  idb.close();
});

// ---------- revision-01 focused groups ----------

test('T2.3-rev01 F1: retry reservation is single-use and token-bound', { skip }, () => {
  const { dbPath, db } = freshIdem('f1r1');
  const scope = scopeOf(baseInput());
  const first = idem.claimOperation(db, { operationId: 'op-f1', scope, capability: 'unknown', now: T0 });
  const token1 = first.operation.attemptToken;
  assert.ok(token1 && first.operation.generation === 1);
  idem.markSubmitted(db, 'op-f1', { attemptToken: token1, remoteId: 'remote-f1', now: T0 });
  idem.markTimeout(db, 'op-f1', { attemptToken: token1, kind: 'timeout', now: T0 });
  const eligible = idem.reconcileOperation(db, 'op-f1', { attemptToken: token1, query: 'not_submitted', evidence: 'synthetic-provider: never accepted', now: T0 });
  assert.equal(eligible.decision, 'retry_allowed', 'advisory eligibility only');

  // single-use reservation: the first caller reserves, a second connection does not
  const reserved = idem.claimOperation(db, { operationId: 'op-f1', scope, capability: 'unknown', now: T0 });
  assert.equal(reserved.decision, 'retry_reserved');
  const token2 = reserved.operation.attemptToken;
  assert.notEqual(token2, token1);
  assert.equal(reserved.operation.generation, 2);
  assert.equal(reserved.operation.state, 'claimed');
  const db2 = openDb(dbPath);
  assert.equal(idem.claimOperation(db2, { operationId: 'op-f1', scope, capability: 'unknown', now: T0 }).decision, 'in_progress', 'only one caller receives the execute permission');

  // late writes from the old generation are rejected with zero writes
  const before = JSON.stringify(idem.getOperation(db, 'op-f1'));
  assert.throws(() => idem.markTimeout(db2, 'op-f1', { attemptToken: token1, kind: 'timeout', now: T0 }), /token mismatch/);
  assert.throws(() => idem.reconcileOperation(db2, 'op-f1', { attemptToken: token1, query: 'effective', now: T0 }), /token mismatch/);
  assert.throws(() => idem.markSubmitted(db2, 'op-f1', { attemptToken: token1, now: T0 }), /token mismatch/);
  assert.throws(() => idem.markSubmitted(db2, 'op-f1', { now: T0 }), /attemptToken is required/);
  assert.equal(JSON.stringify(idem.getOperation(db, 'op-f1')), before, 'stale writes changed nothing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reconcile_events WHERE operation_id = ?').get('op-f1').n, 1, 'no reconcile event from the rejected late query');

  // the reserved generation can submit with its own token
  const submitted2 = idem.markSubmitted(db2, 'op-f1', { attemptToken: token2, now: T0 });
  assert.equal(submitted2.attempts, 2);
  db2.close();

  // reserve then lose the caller: reopen -> adopt recovery -> pending -> query; never re-granted
  idem.markTimeout(db, 'op-f1', { attemptToken: token2, kind: 'network_unknown', now: T0 });
  idem.reconcileOperation(db, 'op-f1', { attemptToken: token2, query: 'not_submitted', evidence: 'synthetic-provider: rejected', now: T0 });
  const reserved3 = idem.claimOperation(db, { operationId: 'op-f1', scope, capability: 'unknown', now: T0 });
  assert.equal(reserved3.decision, 'retry_reserved');
  const token3 = reserved3.operation.attemptToken;
  db.close();
  const db3 = openDb(dbPath);
  assert.equal(idem.claimOperation(db3, { operationId: 'op-f1', scope, capability: 'unknown', now: T0 }).decision, 'in_progress', 'a reserved-but-lost claim is never re-granted');
  const recovered = idem.adoptWorkerReference(db3, { operationId: 'op-f1', remoteId: 'remote-f1', scope, capability: 'unknown', attemptToken: token3, committed: false, source: 'recovery', now: T1 });
  assert.equal(recovered.decision, 'pending_reconcile');
  assert.equal(recovered.operation.state, 'pending_reconcile');
  assert.equal(recovered.operation.attemptToken, token3, 'the reserved generation identity is kept for recovery');
  assert.equal(idem.reconcileOperation(db3, 'op-f1', { attemptToken: token3, query: 'unknown', now: T1 }).decision, 'manual', 'recovered claim is queryable without re-execution');
  db3.close();
});

test('T2.3-rev01 F2: recovery, cancellation and persisted reconcile evidence', { skip }, () => {
  const { dbPath, db } = freshIdem('f2r1');
  const scope = scopeOf(baseInput());

  // adopt on an existing claimed row persists pending + remote binding (never a fake state)
  const claimed = idem.claimOperation(db, { operationId: 'op-f2a', scope, capability: 'unknown', now: T0 });
  assert.equal(claimed.decision, 'execute');
  const adoptedClaimed = idem.adoptWorkerReference(db, { operationId: 'op-f2a', remoteId: 'remote-f2a', scope, capability: 'unknown', attemptToken: claimed.operation.attemptToken, committed: false, source: 'worker_cancel', now: T1 });
  assert.equal(adoptedClaimed.decision, 'pending_reconcile');
  assert.equal(adoptedClaimed.operation.state, 'pending_reconcile');
  assert.equal(adoptedClaimed.operation.remoteId, 'remote-f2a');
  assert.equal(idem.reconcileOperation(db, 'op-f2a', { attemptToken: adoptedClaimed.operation.attemptToken, query: 'unknown', now: T1 }).decision, 'manual');

  // conflicting remote reference fails closed
  assert.throws(() => idem.adoptWorkerReference(db, { operationId: 'op-f2a', remoteId: 'remote-conflict', scope, capability: 'unknown', now: T1 }), /different remote reference/);

  // adopt on a submitted row also persists pending
  const c2 = idem.claimOperation(db, { operationId: 'op-f2b', scope, capability: 'unknown', now: T0 });
  idem.markSubmitted(db, 'op-f2b', { attemptToken: c2.operation.attemptToken, remoteId: 'remote-f2b', now: T0 });
  const adoptedSubmitted = idem.adoptWorkerReference(db, { operationId: 'op-f2b', remoteId: 'remote-f2b', scope, capability: 'unknown', attemptToken: c2.operation.attemptToken, committed: true, source: 'worker_cancel', now: T1 });
  assert.equal(adoptedSubmitted.decision, 'pending_reconcile');
  assert.equal(adoptedSubmitted.operation.state, 'pending_reconcile');

  // terminal rows never fake pending
  const c3 = idem.claimOperation(db, { operationId: 'op-f2c', scope, capability: 'unknown', now: T0 });
  idem.markSubmitted(db, 'op-f2c', { attemptToken: c3.operation.attemptToken, remoteId: 'remote-f2c', now: T0 });
  idem.markTimeout(db, 'op-f2c', { attemptToken: c3.operation.attemptToken, kind: 'timeout', now: T0 });
  idem.reconcileOperation(db, 'op-f2c', { attemptToken: c3.operation.attemptToken, query: 'effective', result: { charged: true }, now: T0 });
  const adoptTerminal = idem.adoptWorkerReference(db, { operationId: 'op-f2c', remoteId: 'remote-f2c', scope, capability: 'unknown', attemptToken: c3.operation.attemptToken, now: T1 });
  assert.equal(adoptTerminal.decision, 'already_effective');
  assert.equal(adoptTerminal.operation.state, 'confirmed_effective');

  // cancel: execution forbidden forever, but late queries still work with structured pending cost
  const c4 = idem.claimOperation(db, { operationId: 'op-f2d', scope, capability: 'unknown', now: T0 });
  const token4 = c4.operation.attemptToken;
  idem.markSubmitted(db, 'op-f2d', { attemptToken: token4, remoteId: 'remote-f2d', now: T0 });
  const cancelled = idem.cancelOperation(db, 'op-f2d', { reason: 'user cancel', now: T0 });
  assert.equal(cancelled.operation.state, 'cancelled');
  assert.ok(cancelled.operation.pendingCost && cancelled.operation.pendingCost.status === 'pending_reconcile' && cancelled.operation.pendingCost.cancelIntent === true, 'structured pending cost placeholder');
  assert.match(cancelled.operation.cancelReason, /refund not guaranteed/);
  assert.equal(idem.claimOperation(db, { operationId: 'op-f2d', scope, capability: 'unknown', now: T0 }).decision, 'cancelled', 'never executes again');
  const lateUnknown = idem.reconcileOperation(db, 'op-f2d', { attemptToken: token4, query: 'unknown', now: T1 });
  assert.equal(lateUnknown.decision, 'manual');
  assert.equal(lateUnknown.state, 'cancelled');
  const lateEffective = idem.reconcileOperation(db, 'op-f2d', { attemptToken: token4, query: 'effective', result: { charged: true, note: 'late charge' }, now: T1 });
  assert.equal(lateEffective.decision, 'no_retry');
  assert.equal(lateEffective.state, 'cancelled', 'cancel intent preserved');
  assert.equal(lateEffective.operation.reconcileState, 'effective');
  assert.equal(lateEffective.operation.result.charged, true);
  assert.equal(idem.claimOperation(db, { operationId: 'op-f2d', scope, capability: 'unknown', now: T1 }).decision, 'cancelled');

  // evidence/decision/attempt identity persist through a reopen (DB audit, not the JSON log)
  const events = db.prepare('SELECT * FROM reconcile_events WHERE operation_id = ? ORDER BY id').all('op-f2d');
  assert.equal(events.length, 2);
  assert.equal(events[0].query, 'unknown');
  assert.equal(events[1].query, 'effective');
  assert.equal(events[1].attempt_token, token4);
  assert.equal(events[1].state_before, 'cancelled');
  assert.equal(events[1].state_after, 'cancelled');
  db.close();
  const db2 = openDb(dbPath);
  const readBack = idem.getOperation(db2, 'op-f2d');
  assert.equal(readBack.reconcileState, 'effective');
  assert.equal(readBack.result.charged, true);

  // legacy row (0006-era, NULL token): fail-closed writes, explicit adopt recovery only
  db2.prepare(`INSERT INTO idempotent_operations (operation_id, scope_hash, scope_json, project_id, brand, capability, state, attempts, max_attempts, created_at, updated_at)
    VALUES ('op-legacy', ?, ?, 'proj-a', 'brand-1', 'unknown', 'pending_reconcile', 1, 3, ?, ?)`)
    .run(idem.scopeHashFor(scope), JSON.stringify(idem.canonicalScopeMaterial(scope)), T0, T0);
  assert.throws(() => idem.reconcileOperation(db2, 'op-legacy', { attemptToken: 'attempt_x', query: 'unknown', now: T1 }), /no attempt token \(legacy row\)/);
  const recovered = idem.adoptWorkerReference(db2, { operationId: 'op-legacy', remoteId: 'remote-legacy', scope, capability: 'unknown', source: 'legacy_recovery', now: T1 });
  assert.equal(recovered.decision, 'pending_reconcile');
  assert.ok(recovered.operation.attemptToken, 'recovery identity minted (not a verified backfill)');
  assert.equal(idem.reconcileOperation(db2, 'op-legacy', { attemptToken: recovered.operation.attemptToken, query: 'not_submitted', evidence: 'synthetic-provider: legacy never accepted', now: T1 }).decision, 'retry_allowed');
  db2.close();
});

test('T2.3-rev01 F3: observation freshness cannot be refreshed by the write clock', { skip }, () => {
  const { db } = freshIdem('f3r1');
  // re-caching an 8-day-old observation must not be fresh by default
  const oldPrice = baseInput({ taskId: 'price-old' });
  idem.putCache(db, oldPrice, { value: { price: 10 }, factKind: 'fact', observedAt: '2026-10-01T00:00:00.000Z', now: T0 });
  const stale = idem.lookupCache(db, oldPrice, { now: T0 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'observation_expired', 'an old observation is never a fresh price by default');

  // missing observation is rejected, never synthesized from the write clock
  assert.throws(() => idem.putCache(db, baseInput({ taskId: 'price-missing' }), { value: { price: 1 }, factKind: 'fact', now: T0 }), /cannot be synthesized/);

  // future observation is non-fresh even with a large caller window
  const future = baseInput({ taskId: 'price-future' });
  idem.putCache(db, future, { value: { price: 11 }, factKind: 'fact', observedAt: '2026-10-10T00:00:00.000Z', now: T0 });
  const futureLookup = idem.lookupCache(db, future, { now: T0, maxObservationAgeMs: 999999999 });
  assert.equal(futureLookup.status, 'stale');
  assert.equal(futureLookup.reason, 'observation_in_future');

  // the caller can only tighten the persisted window, never relax it
  const windowed = baseInput({ taskId: 'price-window', ttlMs: 60000 });
  idem.putCache(db, windowed, { value: { price: 12 }, factKind: 'fact', observedAt: T0, observationTtlMs: 1000, now: T0 });
  assert.equal(idem.lookupCache(db, windowed, { now: '2026-10-09T00:00:00.999Z' }).status, 'fresh');
  assert.equal(idem.lookupCache(db, windowed, { now: '2026-10-09T00:00:01.000Z' }).status, 'stale', 'observation endpoint expired');
  assert.equal(idem.lookupCache(db, windowed, { now: '2026-10-09T00:00:02.000Z', maxObservationAgeMs: 999999999 }).status, 'stale', 'a relaxed caller window cannot wash an expired observation');
  assert.equal(idem.lookupCache(db, windowed, { now: '2026-10-09T00:00:00.999Z', maxObservationAgeMs: 500 }).status, 'stale', 'a tighter caller window applies');
  assert.throws(() => idem.putCache(db, baseInput({ taskId: 'price-long' }), { value: {}, factKind: 'fact', observedAt: T0, observationTtlMs: 120000, now: T0 }), /must not exceed ttlMs/);

  // generated outputs are an explicit separate mode: no fact observation, never a price claim
  const generated = baseInput({ taskId: 'generated-task' });
  const genEntry = idem.putCache(db, generated, { value: { draft: 'x' }, factKind: 'generated', now: T0 });
  assert.equal(genEntry.factKind, 'generated');
  const genLookup = idem.lookupCache(db, generated, { now: '2026-10-09T00:00:59.000Z' });
  assert.equal(genLookup.status, 'fresh');
  assert.equal(genLookup.factKind, 'generated');
  assert.throws(() => idem.putCache(db, baseInput({ taskId: 'generated-bad' }), { value: {}, factKind: 'generated', observedAt: T0, now: T0 }), /must not carry a fact observation/);

  // valid offset instants normalize to UTC and stay millisecond-consistent
  const offset = baseInput({ taskId: 'price-offset' });
  idem.putCache(db, offset, { value: { price: 13 }, factKind: 'fact', observedAt: '2026-10-09T08:00:00.000+08:00', now: T0 });
  const offsetEntry = idem.lookupCache(db, offset, { now: T0 });
  assert.equal(offsetEntry.status, 'fresh');
  assert.equal(offsetEntry.observedAt, T0, 'offset observation normalized to UTC');

  // legacy rows (NULL fact_kind) are non-fresh and never backfilled
  const legacyInput = baseInput({ taskId: 'legacy-cache' });
  const legacyKey = idem.cacheKeyFor(legacyInput);
  db.prepare(`INSERT INTO cache_entries (cache_key, project_id, brand, key_json, value_json, observed_at, written_at, ttl_ms, expires_at, created_at, updated_at)
    VALUES (?, 'proj-a', 'brand-1', '{}', '{"price":1}', ?, ?, 60000, '2026-10-09T00:01:00.000Z', ?, ?)`).run(legacyKey, T0, T0, T0, T0);
  const legacyLookup = idem.lookupCache(db, legacyInput, { now: T0 });
  assert.equal(legacyLookup.status, 'stale');
  assert.equal(legacyLookup.reason, 'legacy_unknown_observation');
  db.close();
});

test('T2.3-rev01 legal readback and 0007 migration chain', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'idem-r1-readback-'));
  const dbPath = path.join(dir, 'idempotency.db');
  const db = openDb(dbPath);
  // full [1-7] isolated chain: up -> backup -> down to 6 -> re-up -> restore verify
  assert.deepEqual(migrateUp(db, [core, m4, m5, m6, m7]), [1, 4, 5, 6, 7]);
  const backupPath = path.join(dir, 'idem-1to7-backup.db');
  backupTo(db, backupPath);
  assert.deepEqual(migrateDown(db, [core, m4, m5, m6, m7], { to: 6 }), [7]);
  const afterDown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(!afterDown.includes('reconcile_events'), 'down removed the 0007 table');
  assert.deepEqual(migrateUp(db, [m7]), [7], 're-up 0007 after down');
  const restored = verifyDatabaseFile(backupPath, { expectedTables: ['cache_entries', 'idempotent_operations', 'operation_attempts', 'reconcile_events'] });
  assert.equal(restored.ok, true, JSON.stringify(restored));

  // normal legal path still works end to end
  const scope = scopeOf(baseInput());
  const input = baseInput({ taskId: 'legal-task' });
  idem.putCache(db, input, { value: { price: 20 }, factKind: 'fact', observedAt: T0, now: T0 });
  assert.equal(idem.lookupCache(db, input, { now: T0 }).status, 'fresh');
  const claimed = idem.claimOperation(db, { operationId: 'op-legal', scope, capability: 'supported', now: T0 });
  assert.equal(claimed.decision, 'execute');
  const token = claimed.operation.attemptToken;
  idem.markSubmitted(db, 'op-legal', { attemptToken: token, remoteId: 'remote-legal', now: T0 });
  idem.markTimeout(db, 'op-legal', { attemptToken: token, kind: 'timeout', now: T0 });
  const effective = idem.reconcileOperation(db, 'op-legal', { attemptToken: token, query: 'effective', result: { charged: true }, now: T0 });
  assert.equal(effective.decision, 'no_retry');
  assert.equal(idem.claimOperation(db, { operationId: 'op-legal', scope, capability: 'supported', now: T0 }).decision, 'already_effective');
  db.close();
  const db2 = openDb(dbPath);
  const state = idem.getOperation(db2, 'op-legal');
  assert.equal(state.state, 'confirmed_effective');
  assert.equal(state.reconcileState, 'effective');
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM reconcile_events WHERE operation_id = ?').get('op-legal').n, 1);
  db2.close();
});

// ---------- revision-02 focused groups ----------

test('T2.3-rev02 F1: recovery is identity-fenced and reservations consume the bounded budget', { skip }, () => {
  const { dbPath, db } = freshIdem('f1r2');
  const scope = scopeOf(baseInput());

  // recovery fence: stale/missing identity is rejected with zero writes
  const first = idem.claimOperation(db, { operationId: 'op-g1', scope, capability: 'unknown', now: T0 });
  const token1 = first.operation.attemptToken;
  assert.equal(first.operation.attempts, 1, 'the execute permission consumes the first attempt');
  idem.markSubmitted(db, 'op-g1', { attemptToken: token1, remoteId: 'remote-g1', now: T0 });
  idem.markTimeout(db, 'op-g1', { attemptToken: token1, kind: 'timeout', now: T0 });
  idem.reconcileOperation(db, 'op-g1', { attemptToken: token1, query: 'not_submitted', evidence: 'synthetic-provider: never accepted', now: T0 });
  const reserved = idem.claimOperation(db, { operationId: 'op-g1', scope, capability: 'unknown', now: T0 });
  assert.equal(reserved.decision, 'retry_reserved');
  const token2 = reserved.operation.attemptToken;
  assert.equal(reserved.operation.generation, 2);
  const snapshot = JSON.stringify(idem.getOperation(db, 'op-g1'));
  const attemptRowsBefore = JSON.stringify(db.prepare('SELECT * FROM operation_attempts WHERE operation_id = ? ORDER BY attempt_no').all('op-g1'));
  const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM reconcile_events WHERE operation_id = ?').get('op-g1').n;
  assert.throws(() => idem.adoptWorkerReference(db, { operationId: 'op-g1', remoteId: 'remote-g1', scope, capability: 'unknown', attemptToken: token1, now: T1 }), /token mismatch/);
  assert.throws(() => idem.adoptWorkerReference(db, { operationId: 'op-g1', remoteId: 'remote-g1', scope, capability: 'unknown', now: T1 }), /attemptToken is required/);
  assert.equal(JSON.stringify(idem.getOperation(db, 'op-g1')), snapshot, 'stale/missing recovery changed nothing');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM operation_attempts WHERE operation_id = ? ORDER BY attempt_no').all('op-g1')), attemptRowsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reconcile_events WHERE operation_id = ?').get('op-g1').n, eventsBefore);
  const recovered = idem.adoptWorkerReference(db, { operationId: 'op-g1', remoteId: 'remote-g1', scope, capability: 'unknown', attemptToken: token2, committed: false, source: 'recovery', now: T1 });
  assert.equal(recovered.decision, 'pending_reconcile');
  assert.equal(recovered.operation.attemptToken, token2, 'current identity recovery keeps the reserved generation');

  // explicit separate policies: legacy NULL-token recovery and new imports need no token
  db.prepare(`INSERT INTO idempotent_operations (operation_id, scope_hash, scope_json, project_id, brand, capability, state, attempts, max_attempts, created_at, updated_at)
    VALUES ('op-g-legacy', ?, ?, 'proj-a', 'brand-1', 'unknown', 'pending_reconcile', 1, 3, ?, ?)`)
    .run(idem.scopeHashFor(scope), JSON.stringify(idem.canonicalScopeMaterial(scope)), T0, T0);
  const legacyRecovery = idem.adoptWorkerReference(db, { operationId: 'op-g-legacy', remoteId: 'remote-legacy', scope, capability: 'unknown', source: 'legacy_recovery', now: T1 });
  assert.equal(legacyRecovery.decision, 'pending_reconcile');
  assert.ok(legacyRecovery.operation.attemptToken, 'legacy recovery mints a recovery identity');
  const imported = idem.adoptWorkerReference(db, { operationId: 'op-g-import', remoteId: 'remote-import', scope, capability: 'unknown', source: 'worker_cancel', now: T1 });
  assert.equal(imported.decision, 'pending_reconcile');

  // bounded budget with maxAttempts=2: reserve -> effect-crash-before-mark -> recover -> not_submitted
  const budgetScope = scopeOf(baseInput({ taskId: 'budget-task' }));
  const budget = idem.claimOperation(db, { operationId: 'op-g-budget', scope: budgetScope, capability: 'unknown', maxAttempts: 2, now: T0 });
  assert.equal(budget.decision, 'execute');
  assert.equal(budget.operation.attempts, 1);
  const bToken1 = budget.operation.attemptToken;
  const bRecover1 = idem.adoptWorkerReference(db, { operationId: 'op-g-budget', remoteId: 'remote-b1', scope: budgetScope, capability: 'unknown', attemptToken: bToken1, committed: false, source: 'recovery', now: T1 });
  assert.equal(bRecover1.decision, 'pending_reconcile');
  const bFirst = idem.reconcileOperation(db, 'op-g-budget', { attemptToken: bToken1, query: 'not_submitted', evidence: 'synthetic-provider: crash before mark', now: T1 });
  assert.equal(bFirst.decision, 'retry_allowed', 'the first consumed attempt still leaves the second available');
  const bReserve2 = idem.claimOperation(db, { operationId: 'op-g-budget', scope: budgetScope, capability: 'unknown', maxAttempts: 2, now: T1 });
  assert.equal(bReserve2.decision, 'retry_reserved');
  assert.equal(bReserve2.operation.attempts, 2);
  assert.equal(bReserve2.operation.generation, 2);
  const bToken2 = bReserve2.operation.attemptToken;
  idem.adoptWorkerReference(db, { operationId: 'op-g-budget', remoteId: 'remote-b2', scope: budgetScope, capability: 'unknown', attemptToken: bToken2, committed: false, source: 'recovery', now: T2 });
  const bSecond = idem.reconcileOperation(db, 'op-g-budget', { attemptToken: bToken2, query: 'not_submitted', evidence: 'synthetic-provider: crash before mark again', now: T2 });
  assert.equal(bSecond.decision, 'retry_exhausted', 'the bounded budget is consumed at reservation time');
  const bClaim3 = idem.claimOperation(db, { operationId: 'op-g-budget', scope: budgetScope, capability: 'unknown', maxAttempts: 2, now: T2 });
  assert.equal(bClaim3.decision, 'retry_exhausted', 'no third execute permission');
  assert.equal(bClaim3.operation.generation, 2, 'generation stops at the budget');
  db.close();

  // the reserved attempt ledger reads back after reopen
  const db2 = openDb(dbPath);
  const rows = db2.prepare('SELECT attempt_no, outcome, generation, attempt_token, note FROM operation_attempts WHERE operation_id = ? ORDER BY attempt_no').all('op-g-budget');
  assert.equal(rows.length, 2, 'each granted permission persisted its attempt row');
  assert.equal(rows[0].outcome, 'started');
  assert.equal(rows[1].outcome, 'started');
  assert.equal(rows[0].generation, 1);
  assert.equal(rows[1].generation, 2);
  assert.ok(rows[0].attempt_token && rows[1].attempt_token && rows[0].attempt_token !== rows[1].attempt_token);

  // normal submit does not double count and binds the per-attempt remote reference
  const normal = idem.claimOperation(db2, { operationId: 'op-g-normal', scope, capability: 'unknown', now: T0 });
  const nToken = normal.operation.attemptToken;
  const nSubmitted = idem.markSubmitted(db2, 'op-g-normal', { attemptToken: nToken, remoteId: 'remote-normal-1', now: T0 });
  assert.equal(nSubmitted.attempts, 1, 'markSubmitted does not increment the consumed attempt');
  idem.markTimeout(db2, 'op-g-normal', { attemptToken: nToken, kind: 'timeout', now: T0 });
  idem.reconcileOperation(db2, 'op-g-normal', { attemptToken: nToken, query: 'not_submitted', evidence: 'synthetic-provider: rejected', now: T0 });
  const nReserve = idem.claimOperation(db2, { operationId: 'op-g-normal', scope, capability: 'unknown', now: T0 });
  assert.equal(nReserve.decision, 'retry_reserved');
  const nSubmitted2 = idem.markSubmitted(db2, 'op-g-normal', { attemptToken: nReserve.operation.attemptToken, remoteId: 'remote-normal-2', now: T0 });
  assert.equal(nSubmitted2.attempts, 2);
  const nRows = db2.prepare('SELECT attempt_no, note, remote_id FROM operation_attempts WHERE operation_id = ? ORDER BY attempt_no').all('op-g-normal');
  assert.equal(nRows[0].remote_id, 'remote-normal-1', 'the structured per-attempt remote is the authority');
  assert.equal(nRows[1].remote_id, 'remote-normal-2');
  assert.match(nRows[0].note, /submitted generation 1/);
  assert.match(nRows[1].note, /submitted generation 2/);
  db2.close();
});

test('T2.3-rev02 F2: cancellation lifecycle is monotonic and retry-eligible states are cancellable', { skip }, () => {
  const { db } = freshIdem('f2r2');
  const scope = scopeOf(baseInput());

  // cancelled + late effective is monotonic: negative/unknown cannot downgrade
  const c1 = idem.claimOperation(db, { operationId: 'op-m1', scope, capability: 'unknown', now: T0 });
  const token1 = c1.operation.attemptToken;
  idem.markSubmitted(db, 'op-m1', { attemptToken: token1, remoteId: 'remote-m1', now: T0 });
  idem.cancelOperation(db, 'op-m1', { reason: 'user cancel', now: T0 });
  const lateEffective = idem.reconcileOperation(db, 'op-m1', { attemptToken: token1, query: 'effective', result: { charged: true }, now: T1 });
  assert.equal(lateEffective.reconcileState, 'effective');
  const snapshot = JSON.stringify(idem.getOperation(db, 'op-m1'));
  const lateNegative = idem.reconcileOperation(db, 'op-m1', { attemptToken: token1, query: 'not_submitted', evidence: 'synthetic-provider: says no', now: T1 });
  assert.equal(lateNegative.decision, 'no_downgrade');
  assert.equal(lateNegative.reconcileState, 'effective', 'a confirmed effective outcome is not downgraded');
  const lateUnknown = idem.reconcileOperation(db, 'op-m1', { attemptToken: token1, query: 'unknown', now: T1 });
  assert.equal(lateUnknown.decision, 'no_downgrade');
  const after = idem.getOperation(db, 'op-m1');
  assert.equal(after.reconcileState, 'effective');
  assert.equal(after.result.charged, true, 'the confirmed result/reference is retained');
  assert.equal(after.remoteId, 'remote-m1');
  assert.equal(JSON.stringify(after), snapshot, 'the rejected late queries did not mutate the row');
  const events = db.prepare('SELECT query, decision, state_before, state_after FROM reconcile_events WHERE operation_id = ? ORDER BY id').all('op-m1');
  assert.deepEqual(events.map((event) => event.decision), ['no_retry', 'no_downgrade', 'no_downgrade'], 'the rejected queries are audit-only records');

  // retry-eligible confirmed_not_submitted can be cancelled and stays cancelled forever
  const c2 = idem.claimOperation(db, { operationId: 'op-m2', scope, capability: 'unknown', now: T0 });
  const token2 = c2.operation.attemptToken;
  idem.markSubmitted(db, 'op-m2', { attemptToken: token2, remoteId: 'remote-m2', now: T0 });
  idem.markTimeout(db, 'op-m2', { attemptToken: token2, kind: 'timeout', now: T0 });
  const eligible = idem.reconcileOperation(db, 'op-m2', { attemptToken: token2, query: 'not_submitted', evidence: 'synthetic-provider: rejected', now: T0 });
  assert.equal(eligible.decision, 'retry_allowed');
  const attemptsBefore = idem.getOperation(db, 'op-m2').attempts;
  const cancelEligible = idem.cancelOperation(db, 'op-m2', { reason: 'cancel before retry', now: T1 });
  assert.equal(cancelEligible.operation.state, 'cancelled', 'a retry-eligible operation can be cancelled');
  assert.equal(cancelEligible.operation.pendingCost.cancelIntent, true);
  assert.match(cancelEligible.operation.cancelReason, /refund not guaranteed/);
  const afterCancel = idem.claimOperation(db, { operationId: 'op-m2', scope, capability: 'unknown', now: T1 });
  assert.equal(afterCancel.decision, 'cancelled', 'cancellation permanently suppresses the retry reservation');
  assert.equal(idem.getOperation(db, 'op-m2').attempts, attemptsBefore, 'cancelling grants no attempt');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM reconcile_events WHERE operation_id = ?').get('op-m2').n >= 1, 'negative reconciliation evidence retained');

  // pendingCost flag consistency: cancelling a timeout placeholder merges cancelIntent
  const c3 = idem.claimOperation(db, { operationId: 'op-m3', scope, capability: 'unknown', now: T0 });
  const token3 = c3.operation.attemptToken;
  idem.markSubmitted(db, 'op-m3', { attemptToken: token3, remoteId: 'remote-m3', now: T0 });
  const timedOut = idem.markTimeout(db, 'op-m3', { attemptToken: token3, kind: 'timeout', now: T0 });
  assert.equal(timedOut.pendingCost.cancelIntent, undefined, 'the timeout placeholder has no cancel intent yet');
  const cancelPlaceholder = idem.cancelOperation(db, 'op-m3', { reason: 'late cancel', now: T1 });
  assert.equal(cancelPlaceholder.operation.pendingCost.cancelIntent, true, 'the existing placeholder is merged with the cancel intent');
  assert.equal(cancelPlaceholder.operation.pendingCost.status, 'pending_reconcile');
  assert.equal(cancelPlaceholder.operation.pendingCost.remoteId, 'remote-m3');

  // confirmed_effective remains non-cancellable per the frozen contract
  const c4 = idem.claimOperation(db, { operationId: 'op-m4', scope, capability: 'supported', now: T0 });
  const token4 = c4.operation.attemptToken;
  idem.markSubmitted(db, 'op-m4', { attemptToken: token4, remoteId: 'remote-m4', now: T0 });
  idem.markTimeout(db, 'op-m4', { attemptToken: token4, kind: 'timeout', now: T0 });
  idem.reconcileOperation(db, 'op-m4', { attemptToken: token4, query: 'effective', result: { charged: true }, now: T0 });
  assert.throws(() => idem.cancelOperation(db, 'op-m4', { reason: 'x', now: T1 }), /cannot cancel a confirmed effective/);
  db.close();
});

test('T2.3-rev02 legal readback: normal lifecycle and evidence readback', { skip }, () => {
  const { dbPath, db } = freshIdem('r2readback');
  const scope = scopeOf(baseInput());
  const input = baseInput({ taskId: 'rev02-legal' });
  idem.putCache(db, input, { value: { price: 21 }, factKind: 'fact', observedAt: T0, now: T0 });
  assert.equal(idem.lookupCache(db, input, { now: T0 }).status, 'fresh');
  const claimed = idem.claimOperation(db, { operationId: 'op-r2-legal', scope, capability: 'supported', now: T0 });
  assert.equal(claimed.decision, 'execute');
  assert.equal(claimed.operation.attempts, 1);
  const token = claimed.operation.attemptToken;
  const submitted = idem.markSubmitted(db, 'op-r2-legal', { attemptToken: token, remoteId: 'remote-r2-legal', now: T0 });
  assert.equal(submitted.attempts, 1, 'no double counting');
  idem.markTimeout(db, 'op-r2-legal', { attemptToken: token, kind: 'timeout', now: T0 });
  const effective = idem.reconcileOperation(db, 'op-r2-legal', { attemptToken: token, query: 'effective', result: { charged: true }, now: T0 });
  assert.equal(effective.decision, 'no_retry');
  assert.equal(idem.claimOperation(db, { operationId: 'op-r2-legal', scope, capability: 'supported', now: T0 }).decision, 'already_effective');
  db.close();
  const db2 = openDb(dbPath);
  const state = idem.getOperation(db2, 'op-r2-legal');
  assert.equal(state.state, 'confirmed_effective');
  assert.equal(state.reconcileState, 'effective');
  const attempts = db2.prepare('SELECT attempt_no, outcome, generation, note, remote_id FROM operation_attempts WHERE operation_id = ?').all('op-r2-legal');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'timeout');
  assert.equal(attempts[0].remote_id, 'remote-r2-legal');
  assert.match(attempts[0].note, /submitted generation 1/);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM reconcile_events WHERE operation_id = ?').get('op-r2-legal').n, 1);
  db2.close();
});

// ---------- revision-03 focused group ----------

test('T2.3-rev03 F1: structured per-attempt remote identity and legal readback', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'idem-r3-'));
  const dbPath = path.join(dir, 'idempotency.db');
  const db = openDb(dbPath);
  // full [1-8] isolated chain: up -> backup -> down to 7 -> re-up 8 -> restore verify
  assert.deepEqual(migrateUp(db, [core, m4, m5, m6, m7, m8]), [1, 4, 5, 6, 7, 8]);
  const backupPath = path.join(dir, 'idem-1to8-backup.db');
  backupTo(db, backupPath);
  assert.deepEqual(migrateDown(db, [core, m4, m5, m6, m7, m8], { to: 7 }), [8]);
  const attemptColsAfterDown = db.prepare('PRAGMA table_info(operation_attempts)').all().map((column) => column.name);
  assert.ok(!attemptColsAfterDown.includes('remote_id'), 'down removed the 0008 column');
  assert.deepEqual(migrateUp(db, [m8]), [8], 're-up 0008 after down');
  const restored = verifyDatabaseFile(backupPath, { expectedTables: ['cache_entries', 'idempotent_operations', 'operation_attempts', 'reconcile_events'] });
  assert.equal(restored.ok, true, JSON.stringify(restored));

  const scope = scopeOf(baseInput());

  // (a) a diagnostic timeout note can never clear or forge the structured binding
  const cA = idem.claimOperation(db, { operationId: 'op-r3a', scope, capability: 'unknown', now: T0 });
  const tA = cA.operation.attemptToken;
  idem.markSubmitted(db, 'op-r3a', { attemptToken: tA, remoteId: 'synthetic-remote-a', now: T0 });
  idem.markTimeout(db, 'op-r3a', { attemptToken: tA, kind: 'timeout', note: 'diagnostic note mentions remote=synthetic-foreign; generation=99', now: T0 });
  const attemptA = db.prepare('SELECT remote_id, note FROM operation_attempts WHERE operation_id = ? AND attempt_no = 1').get('op-r3a');
  assert.equal(attemptA.remote_id, 'synthetic-remote-a', 'the structured binding survives a diagnostic note');
  assert.match(attemptA.note, /diagnostic note/);
  const snapshotA = JSON.stringify(idem.getOperation(db, 'op-r3a'));
  assert.throws(() => idem.adoptWorkerReference(db, { operationId: 'op-r3a', remoteId: 'synthetic-foreign', scope, capability: 'unknown', attemptToken: tA, now: T1 }), /different remote reference/);
  assert.equal(JSON.stringify(idem.getOperation(db, 'op-r3a')), snapshotA, 'the conflicting adopt changed nothing');
  const sameA = idem.adoptWorkerReference(db, { operationId: 'op-r3a', remoteId: 'synthetic-remote-a', scope, capability: 'unknown', attemptToken: tA, committed: false, source: 'recovery', now: T1 });
  assert.equal(sameA.decision, 'pending_reconcile', 're-adopting the same structured reference is safe');

  // (b) markTimeout(remoteId) shares the binding; opaque ids (semicolons/equals) are exact
  const opaqueRemote = 'opaque;remote=with;semis=and;equals';
  const cB = idem.claimOperation(db, { operationId: 'op-r3b', scope, capability: 'unknown', now: T0 });
  const tB = cB.operation.attemptToken;
  idem.markSubmitted(db, 'op-r3b', { attemptToken: tB, remoteId: opaqueRemote, now: T0 });
  assert.throws(() => idem.markTimeout(db, 'op-r3b', { attemptToken: tB, kind: 'timeout', remoteId: 'different-remote', now: T0 }), /different remote reference/);
  const timedB = idem.markTimeout(db, 'op-r3b', { attemptToken: tB, kind: 'timeout', remoteId: opaqueRemote, now: T0 });
  assert.equal(timedB.remoteId, opaqueRemote, 'the opaque id is preserved exactly');
  assert.equal(timedB.pendingCost.remoteId, opaqueRemote);
  const attemptB = db.prepare('SELECT remote_id FROM operation_attempts WHERE operation_id = ? AND attempt_no = 1').get('op-r3b');
  assert.equal(attemptB.remote_id, opaqueRemote);

  // (c) new imports persist a structured attempt reference; repeated adopt conflicts
  const importRemote = ' import;opaque=1 ';
  const imported = idem.adoptWorkerReference(db, { operationId: 'op-r3c', remoteId: importRemote, scope, capability: 'unknown', source: 'worker_cancel', now: T0 });
  const importAttempt = db.prepare('SELECT remote_id FROM operation_attempts WHERE operation_id = ? AND attempt_no = 1').get('op-r3c');
  assert.equal(importAttempt.remote_id, importRemote, 'new import persists the exact opaque reference structurally');
  const sameImport = idem.adoptWorkerReference(db, { operationId: 'op-r3c', remoteId: importRemote, scope, capability: 'unknown', source: 'worker_cancel', attemptToken: imported.operation.attemptToken, now: T1 });
  assert.equal(sameImport.decision, 'pending_reconcile', 're-adopting the exact same reference is safe');
  assert.throws(() => idem.adoptWorkerReference(db, { operationId: 'op-r3c', remoteId: 'import;opaque=2', scope, capability: 'unknown', source: 'worker_cancel', attemptToken: imported.operation.attemptToken, now: T1 }), /different remote reference/);
  // the literal 'none' is a valid opaque id, not "unknown"
  const cNone = idem.claimOperation(db, { operationId: 'op-r3c2', scope, capability: 'unknown', now: T0 });
  const subNone = idem.markSubmitted(db, 'op-r3c2', { attemptToken: cNone.operation.attemptToken, remoteId: 'none', now: T0 });
  assert.equal(subNone.remoteId, 'none');

  // (d) a new generation may bind its own remote; an unbound retry never falls back to the old one
  const cD = idem.claimOperation(db, { operationId: 'op-r3d', scope, capability: 'unknown', now: T0 });
  const tD1 = cD.operation.attemptToken;
  idem.markSubmitted(db, 'op-r3d', { attemptToken: tD1, remoteId: 'remote-gen1', now: T0 });
  idem.markTimeout(db, 'op-r3d', { attemptToken: tD1, kind: 'timeout', now: T0 });
  idem.reconcileOperation(db, 'op-r3d', { attemptToken: tD1, query: 'not_submitted', evidence: 'synthetic-provider: rejected', now: T0 });
  const reservedD = idem.claimOperation(db, { operationId: 'op-r3d', scope, capability: 'unknown', now: T0 });
  assert.equal(reservedD.decision, 'retry_reserved');
  assert.equal(reservedD.operation.remoteId, null, 'a new generation starts with no submitted remote');
  const tD2 = reservedD.operation.attemptToken;
  const submittedD = idem.markSubmitted(db, 'op-r3d', { attemptToken: tD2, now: T0 });
  assert.equal(submittedD.remoteId, null, 'an unbound retry never falls back to the previous generation remote');
  const rowsD = db.prepare('SELECT attempt_no, remote_id FROM operation_attempts WHERE operation_id = ? ORDER BY attempt_no').all('op-r3d');
  assert.equal(rowsD[0].remote_id, 'remote-gen1', 'the old attempt keeps its structured reference');
  assert.equal(rowsD[1].remote_id, null);
  const timedD = idem.markTimeout(db, 'op-r3d', { attemptToken: tD2, kind: 'timeout', remoteId: 'remote-gen2', now: T1 });
  assert.equal(timedD.remoteId, 'remote-gen2', 'the new generation binds its own remote');
  const rowsD2 = db.prepare('SELECT attempt_no, remote_id FROM operation_attempts WHERE operation_id = ? ORDER BY attempt_no').all('op-r3d');
  assert.equal(rowsD2[0].remote_id, 'remote-gen1', 'old references are not lost');
  assert.equal(rowsD2[1].remote_id, 'remote-gen2');

  // (e) missing/stale token guards are preserved
  assert.throws(() => idem.adoptWorkerReference(db, { operationId: 'op-r3d', remoteId: 'x', scope, capability: 'unknown', now: T1 }), /attemptToken is required/);
  assert.throws(() => idem.adoptWorkerReference(db, { operationId: 'op-r3d', remoteId: 'x', scope, capability: 'unknown', attemptToken: tD1, now: T1 }), /token mismatch/);

  // legal readback: normal lifecycle with an opaque remote survives a reopen
  const cF = idem.claimOperation(db, { operationId: 'op-r3e', scope, capability: 'supported', now: T0 });
  const tF = cF.operation.attemptToken;
  idem.markSubmitted(db, 'op-r3e', { attemptToken: tF, remoteId: 'legal;remote=1', now: T0 });
  idem.markTimeout(db, 'op-r3e', { attemptToken: tF, kind: 'timeout', now: T0 });
  const effective = idem.reconcileOperation(db, 'op-r3e', { attemptToken: tF, query: 'effective', result: { charged: true }, now: T0 });
  assert.equal(effective.decision, 'no_retry');
  db.close();
  const db2 = openDb(dbPath);
  const state = idem.getOperation(db2, 'op-r3e');
  assert.equal(state.state, 'confirmed_effective');
  assert.equal(state.remoteId, 'legal;remote=1');
  const attemptF = db2.prepare('SELECT outcome, remote_id, note FROM operation_attempts WHERE operation_id = ?').get('op-r3e');
  assert.equal(attemptF.outcome, 'timeout');
  assert.equal(attemptF.remote_id, 'legal;remote=1');
  assert.match(attemptF.note, /submitted generation 1/);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM reconcile_events WHERE operation_id = ?').get('op-r3e').n, 1);
  db2.close();
});
