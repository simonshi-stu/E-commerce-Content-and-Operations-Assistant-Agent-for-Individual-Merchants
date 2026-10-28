'use strict';
/**
 * T2.1 — Business run store tests. Real SQLite with the approved `runs` table plus the 0004
 * `run_events` and 0005 `lease_token` migrations; synthetic fixtures only; explicit clocks (no
 * sleeps, no system-clock changes); temporary files only under $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const dbApi = require(path.join(W, 'lib', 'commerce', 'db.js'));
const { openDb, migrateUp, migrateDown, listApplied, backupTo, verifyDatabaseFile } = dbApi;
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m4 = require(path.join(W, 'lib', 'commerce', 'migrations', '0004_run_store.js'));
const m5 = require(path.join(W, 'lib', 'commerce', 'migrations', '0005_run_store_lease_token.js'));
const store = require(path.join(W, 'lib', 'commerce', 'run-store.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T2.1 tests write only to the private runtime tmp';

const T0 = '2026-10-09T00:00:00.000Z';
const T1 = '2026-10-09T00:01:00.000Z';
const T2 = '2026-10-09T00:02:00.000Z';

function freshDb(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `run-store-${label}-`));
  const dbPath = path.join(dir, 'runs.db');
  const db = openDb(dbPath);
  migrateUp(db, [core, m4, m5]);
  return { dir, dbPath, db };
}

test('queued -> lease -> running -> checkpoint/event -> terminal -> reopen readback', { skip }, () => {
  const { db, dbPath } = freshDb('path');
  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', actor: 'tester', now: T0 });
  assert.equal(run.status, 'queued');
  assert.equal(run.leaseToken, null);

  const leased = store.acquireLease(db, 'proj-a', run.id, { owner: 'worker-1', ttlSeconds: 600, now: T0 });
  assert.equal(leased.status, 'leased');
  assert.equal(leased.leaseOwner, 'worker-1');
  assert.ok(typeof leased.leaseToken === 'string' && leased.leaseToken.startsWith('lease_'));
  assert.equal(leased.leaseExpiresAt, '2026-10-09T00:10:00.000Z');

  const running = store.startRun(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: leased.leaseToken, now: T1 });
  assert.equal(running.status, 'running');

  const checkpointed = store.updateCheckpoint(db, 'proj-a', run.id, {
    owner: 'worker-1',
    expectedToken: leased.leaseToken,
    checkpoint: { completedSteps: ['step-1', 'step-2'], artifactRefs: ['artifact:a'] },
    now: T1
  });
  assert.deepEqual(checkpointed.checkpoint.completedSteps, ['step-1', 'step-2']);

  const done = store.completeRun(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: leased.leaseToken, now: T2 });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.leaseOwner, null);
  assert.equal(done.leaseToken, null);
  assert.equal(done.leaseExpiresAt, null);

  const events = store.listEvents(db, 'proj-a', run.id);
  assert.deepEqual(events.map((event) => event.eventType), ['run_created', 'lease_acquired', 'run_started', 'checkpoint_updated', 'run_succeeded']);

  db.close();
  const reopened = openDb(dbPath);
  const readback = store.getRun(reopened, 'proj-a', run.id);
  assert.equal(readback.status, 'succeeded');
  assert.deepEqual(readback.checkpoint.artifactRefs, ['artifact:a']);
  assert.deepEqual(store.listEvents(reopened, 'proj-a', run.id).map((event) => event.eventType), events.map((event) => event.eventType));
  reopened.close();
});

test('illegal transitions are rejected and terminal runs are never revived', { skip }, () => {
  const { db } = freshDb('transitions');
  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  assert.throws(() => store.startRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: 'synthetic-token', now: T0 }), /illegal run transition queued -> running/);
  assert.throws(() => store.updateCheckpoint(db, 'proj-a', run.id, { owner: 'w1', expectedToken: 'synthetic-token', checkpoint: {}, now: T0 }), /active run/);
  const lease = store.acquireLease(db, 'proj-a', run.id, { owner: 'w1', ttlSeconds: 600, now: T0 });
  assert.throws(() => store.waitForInput(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 }), /illegal run transition leased -> waiting_input/);
  store.startRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 });
  store.waitForInput(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 });
  assert.throws(() => store.completeRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 }), /illegal run transition waiting_input -> succeeded/);
  store.resumeRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 });
  store.completeRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 });

  for (const attempt of [
    () => store.acquireLease(db, 'proj-a', run.id, { owner: 'w2', ttlSeconds: 600, now: T1 }),
    () => store.renewLease(db, 'proj-a', run.id, { owner: 'w1', expectedToken: 'synthetic-token', ttlSeconds: 600, now: T1 }),
    () => store.startRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: 'synthetic-token', now: T1 }),
    () => store.completeRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: 'synthetic-token', now: T1 }),
    () => store.failRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: 'synthetic-token', reason: 'x', now: T1 }),
    () => store.cancelRun(db, 'proj-a', run.id, { now: T1 }),
    () => store.requeueRun(db, 'proj-a', run.id, { now: T1 })
  ]) {
    assert.throws(attempt, /cannot acquire|illegal run transition|no lease to renew|only a blocked run/);
  }
  assert.equal(store.getRun(db, 'proj-a', run.id).status, 'succeeded');
  db.close();
});

test('double owner, stale lease and expired reclaim fencing', { skip }, () => {
  const { db } = freshDb('lease');
  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  const lease1 = store.acquireLease(db, 'proj-a', run.id, { owner: 'worker-1', ttlSeconds: 60, now: T0 });
  assert.throws(() => store.acquireLease(db, 'proj-a', run.id, { owner: 'worker-2', ttlSeconds: 60, now: T0 }), /active lease/);
  assert.throws(() => store.renewLease(db, 'proj-a', run.id, { owner: 'worker-2', expectedToken: lease1.leaseToken, ttlSeconds: 60, now: T0 }), /owner mismatch/);
  const renewed = store.renewLease(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: lease1.leaseToken, ttlSeconds: 120, now: T0 });
  assert.equal(renewed.leaseExpiresAt, '2026-10-09T00:02:00.000Z');
  store.startRun(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: lease1.leaseToken, now: T0 });

  const replacement = store.acquireLease(db, 'proj-a', run.id, { owner: 'worker-2', ttlSeconds: 600, now: T2 });
  assert.equal(replacement.status, 'leased');
  assert.equal(replacement.leaseOwner, 'worker-2');

  assert.throws(() => store.renewLease(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: lease1.leaseToken, ttlSeconds: 60, now: T2 }), /owner mismatch/);
  assert.throws(() => store.updateCheckpoint(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: lease1.leaseToken, checkpoint: {}, now: T2 }), /owner mismatch/);
  assert.throws(() => store.startRun(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: lease1.leaseToken, now: T2 }), /owner mismatch/);
  const started = store.startRun(db, 'proj-a', run.id, { owner: 'worker-2', expectedToken: replacement.leaseToken, now: T2 });
  assert.equal(started.status, 'running');
  assert.throws(() => store.completeRun(db, 'proj-a', run.id, { owner: 'worker-1', expectedToken: lease1.leaseToken, now: T2 }), /owner mismatch/, 'a stale owner cannot complete under the new lease');

  const run2 = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  const lease2 = store.acquireLease(db, 'proj-a', run2.id, { owner: 'worker-1', ttlSeconds: 60, now: T0 });
  assert.throws(() => store.renewLease(db, 'proj-a', run2.id, { owner: 'worker-1', expectedToken: lease2.leaseToken, ttlSeconds: 60, now: T1 }), /expired/);

  assert.ok(store.listEvents(db, 'proj-a', run.id).some((event) => event.eventType === 'lease_reclaimed'));
  db.close();
});

test('failed event write rolls back the state change (atomic transaction)', { skip }, () => {
  const { db } = freshDb('rollback');
  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  const lease = store.acquireLease(db, 'proj-a', run.id, { owner: 'w1', ttlSeconds: 600, now: T0 });
  store.startRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 });
  db.exec("CREATE TRIGGER test_fail_succeeded BEFORE INSERT ON run_events WHEN NEW.event_type = 'run_succeeded' BEGIN SELECT RAISE(ABORT, 'forced event failure'); END;");
  assert.throws(() => store.completeRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T1 }), /forced event failure/);
  const after = store.getRun(db, 'proj-a', run.id);
  assert.equal(after.status, 'running', 'state change rolled back with the failed event');
  assert.equal(after.leaseOwner, 'w1');
  assert.equal(after.leaseToken, lease.leaseToken);
  assert.equal(after.updatedAt, T0, 'updated_at rolled back too');
  assert.ok(!store.listEvents(db, 'proj-a', run.id).some((event) => event.eventType === 'run_succeeded'), 'no half-written event');
  db.exec('DROP TRIGGER test_fail_succeeded');
  assert.equal(store.completeRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T1 }).status, 'succeeded');
  db.close();
});

test('project isolation and the terminal-retry relationship', { skip }, () => {
  const { db } = freshDb('isolation');
  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  assert.equal(store.getRun(db, 'proj-b', run.id), null, 'cross-project reads are refused');
  assert.throws(() => store.acquireLease(db, 'proj-b', run.id, { owner: 'w1', ttlSeconds: 60, now: T0 }), /not found/);
  assert.throws(() => store.listEvents(db, 'proj-b', run.id), /not found/);
  assert.throws(() => store.createRun(db, 'proj-a', { taskType: 'synthetic-job', retryOf: run.id, now: T0 }), /terminal run/);

  const lease = store.acquireLease(db, 'proj-a', run.id, { owner: 'w1', ttlSeconds: 600, now: T0 });
  store.startRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, now: T0 });
  store.failRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: lease.leaseToken, reason: 'synthetic failure', now: T1 });

  const before = store.listEvents(db, 'proj-a', run.id).length;
  const retry = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', retryOf: run.id, actor: 'tester', now: T2 });
  assert.equal(retry.status, 'queued');
  assert.equal(store.getRun(db, 'proj-a', run.id).status, 'failed', 'the terminal run is never modified');
  assert.equal(store.listEvents(db, 'proj-a', run.id).length, before, 'no events appended to the terminal run');
  const created = store.listEvents(db, 'proj-a', retry.id).find((event) => event.eventType === 'run_created');
  assert.equal(created.payload.retryOf, run.id);
  assert.throws(() => store.createRun(db, 'proj-a', { taskType: 'synthetic-job', retryOf: 'run_missing', now: T2 }), /not found/);
  db.close();
});

test('lease time comparisons use real instants and strict formats', { skip }, () => {
  const { db } = freshDb('time');
  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  for (const bad of ['2026-02-30T00:00:00Z', '2026-10-09T00:00:00', 'not-a-date']) {
    assert.throws(() => store.acquireLease(db, 'proj-a', run.id, { owner: 'w1', ttlSeconds: 60, now: bad }), /instant/, `now ${bad} rejected`);
  }
  assert.throws(() => store.acquireLease(db, 'proj-a', run.id, { owner: 'w1', ttlSeconds: 0, now: T0 }), /ttlSeconds/);

  const leased = store.acquireLease(db, 'proj-a', run.id, { owner: 'w1', ttlSeconds: 60, now: '2026-10-09T08:00:00+08:00' });
  assert.equal(leased.leaseExpiresAt, '2026-10-09T00:01:00.000Z', 'offset-equivalent instants are normalized to canonical UTC');
  assert.throws(() => store.renewLease(db, 'proj-a', run.id, { owner: 'w1', expectedToken: leased.leaseToken, ttlSeconds: 60, now: '2026-10-09T00:01:00.000Z' }), /expired/, 'at the expiry instant the lease is already expired');
  const before = store.renewLease(db, 'proj-a', run.id, { owner: 'w1', expectedToken: leased.leaseToken, ttlSeconds: 120, now: '2026-10-09T00:00:59.999Z' });
  assert.equal(before.leaseExpiresAt, '2026-10-09T00:02:59.999Z');
  assert.equal(before.leaseToken, leased.leaseToken, 'renewal preserves the generation');
  db.close();
});

test('0004 migration adds the append-only event log and reverts locally', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'run-store-mig-'));
  const db = openDb(path.join(dir, 'runs.db'));
  migrateUp(db, [core]);
  assert.deepEqual(migrateUp(db, [core, m4]), [4]);
  assert.deepEqual(listApplied(db).map((row) => row.version), [1, 4]);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  assert.ok(tables.has('run_events'));
  const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name));
  assert.ok(triggers.has('run_events_append_only_update') && triggers.has('run_events_append_only_delete'));

  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  assert.throws(() => db.prepare('UPDATE run_events SET actor = ? WHERE run_id = ?').run('x', run.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM run_events WHERE run_id = ?').run(run.id), /append-only/);

  assert.deepEqual(migrateDown(db, [core, m4], { to: 1 }), [4]);
  assert.deepEqual(listApplied(db).map((row) => row.version), [1]);
  assert.ok(!new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)).has('run_events'));
  assert.deepEqual(migrateUp(db, [core, m4]), [4]);
  assert.deepEqual(migrateUp(db, [core, m4]), []);
  db.close();
});

test('lease generation tokens fence stale writers across reclaim, release/reacquire and ABA', { skip }, () => {
  const { db, dbPath } = freshDb('generation');
  const run = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  const lease1 = store.acquireLease(db, 'proj-a', run.id, { owner: 'stable-worker', ttlSeconds: 60, now: T0 });
  store.startRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, now: T0 });

  assert.throws(() => store.updateCheckpoint(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, checkpoint: {}, now: T1 }), /expired/, 'the old generation is expired before reclaim');

  const lease2 = store.acquireLease(db, 'proj-a', run.id, { owner: 'stable-worker', ttlSeconds: 120, now: T1 });
  assert.notEqual(lease2.leaseToken, lease1.leaseToken, 'a reclaim mints a fresh generation');

  // stale generation while the run is leased: lease-governed writes reject the old token
  const beforeStale = JSON.stringify(store.getRun(db, 'proj-a', run.id));
  const eventsStale = JSON.stringify(store.listEvents(db, 'proj-a', run.id));
  for (const attempt of [
    () => store.startRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, now: T1 }),
    () => store.updateCheckpoint(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, checkpoint: {}, now: T1 }),
    () => store.renewLease(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, ttlSeconds: 60, now: T1 }),
    () => store.releaseLease(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, now: T1 }),
    () => store.cancelRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, now: T1 })
  ]) {
    assert.throws(attempt, /token mismatch/, 'the old generation cannot write under the new lease');
  }
  assert.equal(JSON.stringify(store.getRun(db, 'proj-a', run.id)), beforeStale, 'stale writes leave the run unchanged');
  assert.equal(JSON.stringify(store.listEvents(db, 'proj-a', run.id)), eventsStale, 'stale writes append no events');

  store.startRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease2.leaseToken, now: T1 });
  const beforeStaleRunning = JSON.stringify(store.getRun(db, 'proj-a', run.id));
  const eventsStaleRunning = JSON.stringify(store.listEvents(db, 'proj-a', run.id));
  for (const attempt of [
    () => store.completeRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, now: T1 }),
    () => store.failRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, reason: 'x', now: T1 }),
    () => store.cancelRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease1.leaseToken, now: T1 })
  ]) {
    assert.throws(attempt, /token mismatch/, 'the old generation cannot write under the new lease');
  }
  assert.equal(JSON.stringify(store.getRun(db, 'proj-a', run.id)), beforeStaleRunning, 'stale writes leave the running run unchanged');
  assert.equal(JSON.stringify(store.listEvents(db, 'proj-a', run.id)), eventsStaleRunning, 'stale writes append no events');

  const renewed = store.renewLease(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease2.leaseToken, ttlSeconds: 120, now: T1 });
  assert.equal(renewed.leaseToken, lease2.leaseToken, 'renewal preserves the generation');
  assert.throws(() => store.updateCheckpoint(db, 'proj-a', run.id, { owner: 'stable-worker', checkpoint: {}, now: T1 }), /expectedToken/, 'a missing token fails closed');
  assert.throws(() => store.completeRun(db, 'proj-a', run.id, { owner: 'stable-worker', now: T1 }), /expectedToken/);

  // release/reacquire on a separate run: the released generation is invalidated
  const run2 = store.createRun(db, 'proj-a', { taskType: 'synthetic-job', now: T0 });
  const leaseR1 = store.acquireLease(db, 'proj-a', run2.id, { owner: 'stable-worker', ttlSeconds: 120, now: T1 });
  store.releaseLease(db, 'proj-a', run2.id, { owner: 'stable-worker', expectedToken: leaseR1.leaseToken, now: T1 });
  const leaseR2 = store.acquireLease(db, 'proj-a', run2.id, { owner: 'stable-worker', ttlSeconds: 120, now: T1 });
  assert.notEqual(leaseR2.leaseToken, leaseR1.leaseToken, 'release/reacquire mints another fresh generation');
  assert.throws(() => store.startRun(db, 'proj-a', run2.id, { owner: 'stable-worker', expectedToken: leaseR1.leaseToken, now: T1 }), /token mismatch/);

  // A -> B -> A ABA on the main run (still running under lease2, expiring at 00:03)
  const leaseB = store.acquireLease(db, 'proj-a', run.id, { owner: 'worker-b', ttlSeconds: 60, now: '2026-10-09T00:04:00.000Z' });
  assert.notEqual(leaseB.leaseToken, lease2.leaseToken);
  const leaseA2 = store.acquireLease(db, 'proj-a', run.id, { owner: 'stable-worker', ttlSeconds: 600, now: '2026-10-09T00:05:00.000Z' });
  assert.notEqual(leaseA2.leaseToken, lease2.leaseToken);
  assert.notEqual(leaseA2.leaseToken, leaseB.leaseToken, 'A -> B -> A never reuses a generation');
  store.startRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: leaseA2.leaseToken, now: '2026-10-09T00:05:00.000Z' });
  assert.throws(() => store.completeRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: lease2.leaseToken, now: '2026-10-09T00:05:00.000Z' }), /token mismatch/);
  assert.throws(() => store.completeRun(db, 'proj-a', run.id, { owner: 'worker-b', expectedToken: leaseB.leaseToken, now: '2026-10-09T00:05:00.000Z' }), /owner mismatch|token mismatch/);

  store.updateCheckpoint(db, 'proj-a', run.id, {
    owner: 'stable-worker',
    expectedToken: leaseA2.leaseToken,
    checkpoint: { completedSteps: ['s1'], artifactRefs: ['a1'] },
    now: '2026-10-09T00:05:00.000Z'
  });
  db.exec("CREATE TRIGGER t21_fail_succeeded BEFORE INSERT ON run_events WHEN NEW.event_type = 'run_succeeded' BEGIN SELECT RAISE(ABORT, 'forced'); END;");
  const beforeFail = JSON.stringify(store.getRun(db, 'proj-a', run.id));
  assert.throws(() => store.completeRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: leaseA2.leaseToken, now: '2026-10-09T00:05:00.000Z' }), /forced/);
  assert.equal(JSON.stringify(store.getRun(db, 'proj-a', run.id)), beforeFail, 'the failed transition rolls back with its event');
  db.exec('DROP TRIGGER t21_fail_succeeded');
  const done = store.completeRun(db, 'proj-a', run.id, { owner: 'stable-worker', expectedToken: leaseA2.leaseToken, now: '2026-10-09T00:05:00.000Z' });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.leaseToken, null, 'terminal states clear the generation');

  db.close();
  const reopened = openDb(dbPath);
  const readback = store.getRun(reopened, 'proj-a', run.id);
  assert.equal(readback.status, 'succeeded');
  assert.equal(readback.leaseToken, null);
  assert.deepEqual(readback.checkpoint.artifactRefs, ['a1']);
  reopened.close();
});

test('0005 migration adds the lease token column with local backup/restore and up/down', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'run-store-mig5-'));
  const db = openDb(path.join(dir, 'runs.db'));
  migrateUp(db, [core, m4]);
  const backup = path.join(dir, 'before0005.db');
  backupTo(db, backup);
  assert.ok(verifyDatabaseFile(backup, { expectedTables: ['runs', 'run_events'] }).ok);

  assert.deepEqual(migrateUp(db, [core, m4, m5]), [5]);
  assert.deepEqual(listApplied(db).map((row) => row.version), [1, 4, 5]);
  assert.ok(new Set(db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name)).has('lease_token'));
  assert.deepEqual(migrateDown(db, [core, m4, m5], { to: 4 }), [5]);
  assert.ok(!new Set(db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name)).has('lease_token'));
  assert.deepEqual(migrateUp(db, [core, m4, m5]), [5]);
  db.close();

  const restoredPath = path.join(dir, 'restored.db');
  fs.copyFileSync(backup, restoredPath, fs.constants.COPYFILE_EXCL);
  const restored = openDb(restoredPath);
  assert.deepEqual(listApplied(restored).map((row) => row.version), [1, 4]);
  assert.deepEqual(migrateUp(restored, [core, m4, m5]), [5]);
  restored.close();
});
