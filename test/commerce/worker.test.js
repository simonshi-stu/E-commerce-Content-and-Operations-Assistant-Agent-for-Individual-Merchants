'use strict';
/**
 * T2.2 — Single worker tests. Real SQLite (run-store 0001/0004/0005) + real child processes for
 * the crash rehearsal; synthetic steps only; explicit clocks in-process (no sleeps); process
 * phases wait on child stdout events and only ever kill this task's own children. Temp files only
 * under $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const { openDb, migrateUp } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const { canonicalJson } = require(path.join(W, 'lib', 'commerce', 'packs.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m4 = require(path.join(W, 'lib', 'commerce', 'migrations', '0004_run_store.js'));
const m5 = require(path.join(W, 'lib', 'commerce', 'migrations', '0005_run_store_lease_token.js'));
const store = require(path.join(W, 'lib', 'commerce', 'run-store.js'));
const worker = require(path.join(W, 'lib', 'commerce', 'worker.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T2.2 tests write only to the private runtime tmp';

const T0 = '2026-10-09T00:00:00.000Z';
const T0P31 = '2026-10-09T00:00:31.000Z';
const T1 = '2026-10-09T00:01:00.000Z';
const T2 = '2026-10-09T00:02:00.000Z';

const hashOf = (value) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');

function makeTask(overrides = {}) {
  const inputVersion = overrides.inputVersion ?? 'v1';
  const steps = overrides.steps ?? [
    { id: 's1', kind: 'write-artifact', content: { note: 'one' } },
    { id: 's2', kind: 'remote-submit-sim', remoteId: 'remote_synthetic_a', content: { note: 'two' } },
    { id: 's3', kind: 'write-artifact', content: { note: 'three' } }
  ];
  const inputHash = overrides.inputHash ?? hashOf({ inputVersion, steps });
  return { taskType: overrides.taskType ?? 'synthetic-worker-job', inputVersion, inputHash, steps };
}

function freshEnv(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `worker-${label}-`));
  const dbPath = path.join(dir, 'runs.db');
  const db = openDb(dbPath);
  migrateUp(db, [core, m4, m5]);
  return { dir, dbPath, db, workerDir: path.join(dir, 'worker') };
}

test('resume from checkpoint, step retry, heartbeat renewal and input-change fail-closed', { skip }, () => {
  const { db, workerDir } = freshEnv('resume');
  const task = makeTask({
    steps: [
      { id: 's1', kind: 'write-artifact', content: { note: 'one' } },
      { id: 's2', kind: 'remote-submit-sim', remoteId: 'remote_synthetic_a', content: { note: 'two' }, failTimes: 1 },
      { id: 's3', kind: 'write-artifact', content: { note: 'three' } }
    ]
  });
  const run = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  const summary = worker.runWorkerOnce(db, {
    projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, heartbeatSeconds: 30,
    now: T0, nowForStep: (index) => (index >= 1 ? T0P31 : T0)
  });
  assert.equal(summary.status, 'succeeded');
  const final = store.getRun(db, 'proj-a', run.id);
  assert.equal(final.status, 'succeeded');
  assert.deepEqual(final.checkpoint.completedSteps, ['s1', 's2', 's3']);
  assert.equal(final.checkpoint.inputHash, task.inputHash);
  const events = store.listEvents(db, 'proj-a', run.id);
  const acquired = events.find((event) => event.eventType === 'lease_acquired');
  const renewed = events.find((event) => event.eventType === 'lease_renewed');
  assert.ok(renewed, 'heartbeat renewed the lease');
  assert.equal(renewed.payload.leaseToken, acquired.payload.leaseToken, 'renewal keeps the generation');
  assert.equal(renewed.payload.expiresAt, '2026-10-09T00:01:31.000Z');
  const journal = worker.readJournal(workerDir, run.id);
  assert.ok(journal.entries.some((entry) => entry.event === 'step_attempt_failed' && entry.stepId === 's2' && entry.attempt === 1), 'a transient step failure was retried');
  assert.equal(journal.entries.filter((entry) => entry.event === 'step_done').length, 3);

  // crash window: effect written, checkpoint not committed -> restart reuses the effect
  const run2 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, {
    projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60,
    now: T0, faultInjection: { afterEffectStep: 's1' }
  }), /injected fault after effect/);
  assert.equal(store.getRun(db, 'proj-a', run2.id).status, 'running');
  assert.equal(store.getRun(db, 'proj-a', run2.id).checkpoint, null, 'no checkpoint committed in the crash window');
  const artifactAfterFault = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', run2.id, 'artifacts', 's1.json'), 'utf8'));
  const resumed = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w3', workerDir, task, ttlSeconds: 60, now: T1 });
  assert.equal(resumed.status, 'succeeded');
  const artifactAfterResume = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', run2.id, 'artifacts', 's1.json'), 'utf8'));
  assert.equal(artifactAfterResume.operationId, artifactAfterFault.operationId, 'the local effect was reused, not duplicated');
  assert.ok(worker.readJournal(workerDir, run2.id).entries.some((entry) => entry.event === 'effect' && entry.stepId === 's1' && entry.outcome === 'reused'));

  // input change: a committed checkpoint from input v1 must not be silently reused for v2
  const run3 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, {
    projectId: 'proj-a', workerId: 'w4', workerDir, task, ttlSeconds: 60,
    now: T0, faultInjection: { afterEffectStep: 's2' }
  }), /injected fault/);
  assert.deepEqual(store.getRun(db, 'proj-a', run3.id).checkpoint.completedSteps, ['s1']);
  const taskV2 = makeTask({ inputVersion: 'v2' });
  const changed = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w5', workerDir, task: taskV2, ttlSeconds: 60, now: T1 });
  assert.equal(changed.status, 'failed_input_changed');
  assert.equal(store.getRun(db, 'proj-a', run3.id).status, 'failed');
  const failEvent = store.listEvents(db, 'proj-a', run3.id).find((event) => event.eventType === 'run_failed');
  assert.ok(/input version\/hash/.test(failEvent.payload.reason));
  assert.ok(!worker.readJournal(workerDir, run3.id).entries.some((entry) => entry.event === 'step_done' && entry.stepId === 's3'), 'no step of the changed input ran');
  db.close();
});

test('mid-run cancellation persists the cancel point and keeps remote ids for reconciliation', { skip }, () => {
  const { db, workerDir } = freshEnv('cancel');
  const task = makeTask({
    steps: [
      { id: 's1', kind: 'remote-submit-sim', remoteId: 'remote_synthetic_a', content: { note: 'one' } },
      { id: 's2', kind: 'write-artifact', content: { note: 'two' } },
      { id: 's3', kind: 'write-artifact', content: { note: 'three' } }
    ]
  });

  const runA = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  worker.requestCancel(workerDir, runA.id, { actor: 'tester', reason: 'synthetic pre-claim cancel', now: T0 });
  const pre = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0 });
  assert.equal(pre.status, 'cancelled');
  assert.equal(store.getRun(db, 'proj-a', runA.id).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(workerDir, 'runs', runA.id, 'artifacts', 's1.json')), false, 'no step ran after a pre-claim cancel');
  const preEvent = store.listEvents(db, 'proj-a', runA.id).find((event) => event.eventType === 'run_cancelled');
  assert.ok(/cancelPoint=\[\]/.test(preEvent.payload.reason));

  const runB = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  const mid = worker.runWorkerOnce(db, {
    projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T0,
    cancelAfterStep: 's1'
  });
  assert.equal(mid.status, 'cancelled');
  const runBState = store.getRun(db, 'proj-a', runB.id);
  assert.equal(runBState.status, 'cancelled');
  assert.deepEqual(runBState.checkpoint.completedSteps, ['s1']);
  assert.deepEqual(runBState.checkpoint.cancelPoint, ['s1']);
  assert.equal(fs.existsSync(path.join(workerDir, 'runs', runB.id, 'artifacts', 's2.json')), false, 'steps after the cancel point do not run');
  assert.equal(fs.existsSync(path.join(workerDir, 'runs', runB.id, 'artifacts', 's3.json')), false);
  const cancelEvent = store.listEvents(db, 'proj-a', runB.id).find((event) => event.eventType === 'run_cancelled');
  assert.ok(/cancelPoint=\[s1\]/.test(cancelEvent.payload.reason));
  assert.ok(/remote_synthetic_a/.test(cancelEvent.payload.reason), 'the synthetic remote id is kept for reconciliation');
  assert.ok(/refund not guaranteed/.test(cancelEvent.payload.reason), 'no refund promise is made');
  db.close();
});

test('lease expiry, worker-level reclaim and old-token rejection', { skip }, () => {
  const { db, workerDir } = freshEnv('lease');
  const task = makeTask();
  const run = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, {
    projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60,
    now: T0, faultInjection: { afterEffectStep: 's1' }
  }), /injected fault/);
  const staleToken = store.listEvents(db, 'proj-a', run.id).find((event) => event.eventType === 'lease_acquired').payload.leaseToken;

  const held = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T0 });
  assert.equal(held.status, 'no_claim', 'an active lease is never claimed by another worker');

  // after expiry w2 reclaims with a fresh generation and stops again in a controlled window, so
  // the stale-token write below is checked while the new lease is still ACTIVE
  assert.throws(() => worker.runWorkerOnce(db, {
    projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60,
    now: T1, faultInjection: { afterEffectStep: 's2' }
  }), /injected fault/);
  const newToken = store.listEvents(db, 'proj-a', run.id).find((event) => event.eventType === 'lease_reclaimed').payload.leaseToken;
  assert.notEqual(newToken, staleToken, 'reclaim mints a fresh generation');
  assert.throws(() => store.updateCheckpoint(db, 'proj-a', run.id, { owner: 'w1', expectedToken: staleToken, checkpoint: {}, now: T1 }), /owner mismatch|token mismatch/);

  // a third worker recovers the run to completion after the second lease expires
  const done = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w3', workerDir, task, ttlSeconds: 60, now: T2 });
  assert.equal(done.status, 'succeeded');
  assert.equal(store.getRun(db, 'proj-a', run.id).status, 'succeeded');
  db.close();
});

test('process kill -> restart resumes from checkpoint; injected crash window reuses the local effect', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'worker-proc-'));
  const dbPath = path.join(dir, 'runs.db');
  const workerDir = path.join(dir, 'worker');
  const db = openDb(dbPath);
  migrateUp(db, [core, m4, m5]);
  const task = makeTask();
  const taskFile = path.join(dir, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify(task));
  const runA = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  db.close();

  const cli = path.join(W, 'scripts', 'commerce', 'worker.js');
  const spawnWorker = (args) => cp.spawn(process.execPath, [cli, ...args], { cwd: W, stdio: ['ignore', 'pipe', 'pipe'] });
  const waitFor = (child, label, predicate, timeoutMs) => new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => { clearTimeout(timer); child.stdout.removeListener('data', onData); child.stderr.removeListener('data', onStderr); child.removeListener('close', onClose); child.removeListener('error', onError); };
    const settle = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const timer = setTimeout(() => settle(reject, new Error(`[${label}] timeout waiting for a worker event`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (predicate(event)) { settle(resolve, event); return; }
      }
    };
    const onStderr = (chunk) => { stderr += chunk.toString('utf8'); };
    // 'close' (not 'exit') so buffered stdout is fully delivered before we decide the child is gone
    const onClose = () => settle(reject, new Error(`[${label}] worker exited before the expected event; pid=${child.pid}; exitCode=${child.exitCode}; signal=${child.signalCode}; stdout tail: ${buffer.slice(-400)}; stderr tail: ${stderr.slice(-400)}`));
    const onError = (error) => settle(reject, new Error(`[${label}] spawn error: ${error.message}`));
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
    child.on('close', onClose);
    child.on('error', onError);
  });

  // Phase 1: real SIGKILL after step 1 (only this task's child PID; the controlled pause hook
  // emits its boundary in a `paused` event before blocking, so the kill is deterministic)
  const childA = spawnWorker(['--db', dbPath, '--worker-dir', workerDir, '--task-file', taskFile, '--worker-id', 'wA', '--project', 'proj-a', '--ttl-seconds', '2', '--heartbeat-seconds', '1', '--run-id', runA.id, '--pause-after-step', 's1']);
  const exitA = new Promise((resolve) => childA.once('exit', (code, signal) => resolve({ code, signal })));
  await waitFor(childA, 'childA-paused', (event) => event.event === 'paused' && event.stepId === 's1', 20000);
  assert.ok(childA.pid > 0);
  childA.kill('SIGKILL');
  const exitInfoA = await exitA;
  assert.ok(exitInfoA.signal !== null || (exitInfoA.code !== null && exitInfoA.code !== 0), 'the rehearsal child was terminated, not exited cleanly');
  const dbA = openDb(dbPath);
  assert.equal(store.getRun(dbA, 'proj-a', runA.id).status, 'running');
  assert.deepEqual(store.getRun(dbA, 'proj-a', runA.id).checkpoint.completedSteps, ['s1']);
  const s1Before = fs.readFileSync(path.join(workerDir, 'runs', runA.id, 'artifacts', 's1.json'), 'utf8');
  dbA.close();

  // Phase 2: restart waits for the lease to expire, reclaims, resumes and completes
  const childB = spawnWorker(['--db', dbPath, '--worker-dir', workerDir, '--task-file', taskFile, '--worker-id', 'wB', '--project', 'proj-a', '--ttl-seconds', '30', '--wait-lease-seconds', '30', '--run-id', runA.id]);
  const exitB = new Promise((resolve) => childB.once('exit', (code) => resolve(code)));
  const finishedB = await waitFor(childB, 'childB-result', (event) => event.event === 'result', 40000);
  assert.equal(await exitB, 0);
  assert.equal(finishedB.status, 'succeeded');
  const dbB = openDb(dbPath);
  const resumedState = store.getRun(dbB, 'proj-a', runA.id);
  assert.equal(resumedState.status, 'succeeded');
  assert.deepEqual(resumedState.checkpoint.completedSteps, ['s1', 's2', 's3']);
  assert.equal(resumedState.leaseToken, null);
  assert.equal(fs.readFileSync(path.join(workerDir, 'runs', runA.id, 'artifacts', 's1.json'), 'utf8'), s1Before, 'a completed step artifact is not rewritten');
  dbB.close();

  // Phase 3: injected crash window (effect done, checkpoint not committed) -> restart reuses the effect
  const dbC = openDb(dbPath);
  const runB = store.createRun(dbC, 'proj-a', { taskType: task.taskType, now: T0 });
  dbC.close();
  const childC = spawnWorker(['--db', dbPath, '--worker-dir', workerDir, '--task-file', taskFile, '--worker-id', 'wC', '--project', 'proj-a', '--ttl-seconds', '2', '--run-id', runB.id, '--fault-after-effect-step', 's2']);
  const exitC = new Promise((resolve) => childC.once('exit', (code) => resolve(code)));
  const faultEvent = await waitFor(childC, 'childC-fault', (event) => event.event === 'injected_fault', 20000);
  assert.equal(faultEvent.boundary, 'after-effect-before-checkpoint');
  assert.equal(await exitC, 3);
  const dbD = openDb(dbPath);
  assert.equal(store.getRun(dbD, 'proj-a', runB.id).status, 'running');
  assert.deepEqual(store.getRun(dbD, 'proj-a', runB.id).checkpoint.completedSteps, ['s1']);
  const s2Artifact = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', runB.id, 'artifacts', 's2.json'), 'utf8'));
  dbD.close();
  const childD = spawnWorker(['--db', dbPath, '--worker-dir', workerDir, '--task-file', taskFile, '--worker-id', 'wD', '--project', 'proj-a', '--ttl-seconds', '30', '--wait-lease-seconds', '30', '--run-id', runB.id]);
  const exitD = new Promise((resolve) => childD.once('exit', (code) => resolve(code)));
  const finishedD = await waitFor(childD, 'childD-result', (event) => event.event === 'result', 40000);
  assert.equal(await exitD, 0);
  assert.equal(finishedD.status, 'succeeded');
  const s2After = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', runB.id, 'artifacts', 's2.json'), 'utf8'));
  assert.equal(s2After.operationId, s2Artifact.operationId, 'the crash-window effect was reused with the same operationId');
  assert.ok(worker.readJournal(workerDir, runB.id).entries.some((entry) => entry.event === 'effect' && entry.stepId === 's2' && entry.outcome === 'reused'));
  const finalDb = openDb(dbPath);
  assert.equal(store.getRun(finalDb, 'proj-a', runB.id).status, 'succeeded');
  finalDb.close();
});

// ---------- revision-01 focused groups (F1-F4 + legal readback) ----------

test('F1: path identifiers stay inside the private worker directory', { skip }, () => {
  const { dir, db, workerDir } = freshEnv('f1');
  // bad step ids are rejected by validateTask before any effect
  for (const badId of ['../../escape-step', '..', 'a/b', 'a\\b', 'C:drive', 'x.', 'CON']) {
    assert.throws(() => worker.validateTask(makeTask({ steps: [{ id: badId, kind: 'write-artifact', content: { note: 'x' } }] })), /must not/);
  }
  // an ordinary '..name' is NOT treated as a parent
  const okTask = makeTask({ steps: [{ id: '..name', kind: 'write-artifact', content: { note: 'ok' } }] });
  assert.equal(worker.validateTask(okTask).steps[0].id, '..name');
  // requestCancel rejects traversal ids without writing anything outside the worker dir
  const escapeTarget = path.resolve(workerDir, '..', '..', 'escaped');
  assert.throws(() => worker.requestCancel(workerDir, '../../escaped', { actor: 't', reason: 't' }), /must not/);
  assert.equal(fs.existsSync(path.join(escapeTarget, 'cancel-request.json')), false, 'no file written outside the worker dir');
  // explicit runId is rejected before any claim
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task: okTask, ttlSeconds: 60, now: T0, runId: '../../escape-run' }), /must not/);
  // CLI with a bad step id: rejected, no claim of the legal queued run
  const legalTask = makeTask();
  const run = store.createRun(db, 'proj-a', { taskType: legalTask.taskType, now: T0 });
  const badTaskFile = path.join(dir, 'bad-task.json');
  fs.writeFileSync(badTaskFile, JSON.stringify(makeTask({ steps: [{ id: '../escape', kind: 'write-artifact', content: { note: 'x' } }] })));
  const cli = path.join(W, 'scripts', 'commerce', 'worker.js');
  const result = cp.spawnSync(process.execPath, [cli, '--db', path.join(dir, 'runs.db'), '--worker-dir', workerDir, '--task-file', badTaskFile, '--worker-id', 'wCli', '--project', 'proj-a', '--ttl-seconds', '60', '--run-id', run.id], { cwd: W, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'CLI rejects a bad step id');
  assert.match(result.stderr, /must not/);
  const after = store.getRun(db, 'proj-a', run.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.leaseOwner, null, 'the legal run was not claimed');
  assert.equal(fs.existsSync(path.join(workerDir, '..', '..', 'escape')), false);
  db.close();
});

test('F2: task descriptor binds version and plan before the first effect', { skip }, () => {
  const { db, workerDir } = freshEnv('f2');
  const baseSteps = [
    { id: 'submit', kind: 'remote-submit-sim', remoteId: 'synthetic-remote-one', content: { text: 'original' } },
    { id: 'later', kind: 'write-artifact', content: { note: 'later' } }
  ];
  const taskV1 = makeTask({ steps: baseSteps });

  // crash window: first effect durable, checkpoint null, descriptor persisted
  const run1 = store.createRun(db, 'proj-a', { taskType: taskV1.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task: taskV1, ttlSeconds: 60, now: T0, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  assert.equal(store.getRun(db, 'proj-a', run1.id).checkpoint, null);
  const artifactBefore = fs.readFileSync(path.join(workerDir, 'runs', run1.id, 'artifacts', 'submit.json'), 'utf8');

  // v2 with the SAME caller inputHash must fail closed and never reuse/overwrite the v1 effect
  const taskV2 = makeTask({ inputVersion: 'v2', steps: baseSteps, inputHash: taskV1.inputHash });
  assert.equal(taskV2.inputHash, taskV1.inputHash, 'same external inputHash on purpose');
  const v2 = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w2', workerDir, task: taskV2, ttlSeconds: 60, now: T1 });
  assert.equal(v2.status, 'failed_input_changed');
  assert.equal(store.getRun(db, 'proj-a', run1.id).status, 'failed');
  assert.equal(fs.readFileSync(path.join(workerDir, 'runs', run1.id, 'artifacts', 'submit.json'), 'utf8'), artifactBefore, 'the v1 effect was not overwritten');
  assert.ok(worker.readJournal(workerDir, run1.id).entries.some((entry) => entry.event === 'failed_input_changed'));

  // changed ordered plan with the same inputHash: also fail closed
  const run2 = store.createRun(db, 'proj-a', { taskType: taskV1.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w3', workerDir, task: taskV1, ttlSeconds: 60, now: T0, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  const changedPlan = makeTask({ steps: [baseSteps[0], { id: 'later', kind: 'write-artifact', content: { note: 'changed' } }], inputHash: taskV1.inputHash });
  assert.equal(changedPlan.inputHash, taskV1.inputHash);
  const planResult = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w4', workerDir, task: changedPlan, ttlSeconds: 60, now: T1 });
  assert.equal(planResult.status, 'failed_input_changed');

  // unchanged descriptor resumes and reuses the crash-window effect
  const run3 = store.createRun(db, 'proj-a', { taskType: taskV1.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w5', workerDir, task: taskV1, ttlSeconds: 60, now: T0, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  const resumed = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w6', workerDir, task: taskV1, ttlSeconds: 60, now: T1 });
  assert.equal(resumed.status, 'succeeded');
  assert.ok(worker.readJournal(workerDir, run3.id).entries.some((entry) => entry.event === 'effect' && entry.stepId === 'submit' && entry.outcome === 'reused'));

  // explicit runId with a different taskType is rejected before any claim
  const otherRun = store.createRun(db, 'proj-a', { taskType: 'other-job', now: T0 });
  const mismatch = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w7', workerDir, task: taskV1, ttlSeconds: 60, now: T0, runId: otherRun.id });
  assert.equal(mismatch.status, 'task_type_mismatch');
  const otherAfter = store.getRun(db, 'proj-a', otherRun.id);
  assert.equal(otherAfter.status, 'queued');
  assert.equal(otherAfter.leaseOwner, null, 'the mismatched run was not claimed');
  assert.ok(!store.listEvents(db, 'proj-a', otherRun.id).some((event) => event.eventType === 'run_started'));

  // a tampered artifact identity fails closed without overwrite
  const run4 = store.createRun(db, 'proj-a', { taskType: taskV1.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w8', workerDir, task: taskV1, ttlSeconds: 60, now: T0, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  const tamperedPath = path.join(workerDir, 'runs', run4.id, 'artifacts', 'submit.json');
  const tampered = JSON.parse(fs.readFileSync(tamperedPath, 'utf8'));
  tampered.content = { text: 'tampered' };
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const tamperedResult = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w9', workerDir, task: taskV1, ttlSeconds: 60, now: T1 });
  assert.equal(tamperedResult.status, 'failed_input_changed');
  assert.match(worker.readJournal(workerDir, run4.id).entries.filter((entry) => entry.event === 'failed_input_changed').pop().reason, /identity/);

  // a legacy unbound durable effect without a descriptor is refused, not reused
  const run5 = store.createRun(db, 'proj-a', { taskType: taskV1.taskType, now: T0 });
  const legacyDir = path.join(workerDir, 'runs', run5.id, 'artifacts');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'submit.json'), JSON.stringify({ operationId: worker.operationIdFor(run5.id, 'submit', taskV1.inputHash), stepId: 'submit', kind: 'remote-submit-sim', inputVersion: taskV1.inputVersion, inputHash: taskV1.inputHash, remoteId: 'legacy', content: { text: 'original' } }));
  const legacy = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w10', workerDir, task: taskV1, ttlSeconds: 60, now: T1 });
  assert.equal(legacy.status, 'failed_input_changed');
  assert.equal(store.getRun(db, 'proj-a', run5.id).status, 'failed');
  db.close();
});

test('F3: cancellation reconciles durable effects from the crash window', { skip }, () => {
  const { db, workerDir } = freshEnv('f3');
  const task = makeTask({
    steps: [
      { id: 'submit', kind: 'remote-submit-sim', remoteId: 'synthetic-remote-one', content: { text: 'original' } },
      { id: 'later', kind: 'write-artifact', content: { note: 'later' } }
    ]
  });
  const run = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  // a foreign effect that does not belong to the current task descriptor
  const rogueFile = path.join(workerDir, 'runs', run.id, 'artifacts', 'rogue.json');
  fs.writeFileSync(rogueFile, JSON.stringify({ operationId: 'other:rogue:hash', stepId: 'rogue', kind: 'write-artifact', inputVersion: 'other', inputHash: 'x'.repeat(64), descriptorHash: 'y'.repeat(64), contentSha256: 'z'.repeat(64), remoteId: 'synthetic-remote-rogue', content: {} }));
  worker.requestCancel(workerDir, run.id, { actor: 'tester', reason: 'cancel after crash window', now: T1 });
  const result = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T1 });
  assert.equal(result.status, 'cancelled');
  const state = store.getRun(db, 'proj-a', run.id);
  assert.equal(state.status, 'cancelled');
  const checkpoint = state.checkpoint;
  assert.deepEqual(checkpoint.cancelPoint, []);
  assert.ok(checkpoint.remoteIds.includes('synthetic-remote-one'), 'the durable submitted remoteId is retained');
  const submitEffect = checkpoint.durableEffects.find((effect) => effect.stepId === 'submit');
  assert.equal(submitEffect.committed, false, 'distinguishes committed vs uncommitted effects');
  assert.equal(submitEffect.operationId, worker.operationIdFor(run.id, 'submit', task.inputHash));
  assert.ok(checkpoint.foreignEffects.some((effect) => effect.operationId === 'other:rogue:hash'), 'foreign effect retained for audit, not bound to the task');
  assert.ok(!checkpoint.remoteIds.includes('synthetic-remote-rogue'), 'a foreign effect is not bound to the current task');
  const cancelEvent = store.listEvents(db, 'proj-a', run.id).find((event) => event.eventType === 'run_cancelled');
  assert.ok(/operationIds=\[.*submit/.test(cancelEvent.payload.reason));
  assert.ok(/remoteIds=\[synthetic-remote-one\]/.test(cancelEvent.payload.reason));
  assert.ok(/refund not guaranteed/.test(cancelEvent.payload.reason));
  assert.equal(fs.existsSync(path.join(workerDir, 'runs', run.id, 'artifacts', 'later.json')), false, 'no later step was executed to reconcile');
  const writtenSubmit = worker.readJournal(workerDir, run.id).entries.filter((entry) => entry.event === 'effect' && entry.stepId === 'submit' && entry.outcome === 'written');
  assert.equal(writtenSubmit.length, 1, 'the effect was not re-executed');
  db.close();
});

test('F4: no new effect after lease expiry and conflicts surface as lease_lost', { skip }, () => {
  const { db, workerDir } = freshEnv('f4');
  const task = makeTask({
    steps: [
      { id: 'one', kind: 'write-artifact', content: { note: 'one' } },
      { id: 'two', kind: 'write-artifact', content: { note: 'two' } }
    ]
  });
  // fixed clock: the second step is at lease expiry -> lease_lost, no second effect
  const run = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  const expired = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0, runId: run.id, nowForStep: (index) => (index >= 1 ? T1 : T0) });
  assert.equal(expired.status, 'lease_lost');
  assert.equal(fs.existsSync(path.join(workerDir, 'runs', run.id, 'artifacts', 'two.json')), false, 'no effect was written after expiry');
  assert.deepEqual(store.getRun(db, 'proj-a', run.id).checkpoint.completedSteps, ['one']);
  assert.ok(worker.readJournal(workerDir, run.id).entries.some((entry) => entry.event === 'lease_lost'));

  // a legal recovery after expiry still completes
  const recovered = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T2, runId: run.id });
  assert.equal(recovered.status, 'succeeded');

  // finish conflict (completeRun at expiry) is lease_lost, not a thrown conflict
  const run2 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  const oneStep = makeTask({ steps: [{ id: 'one', kind: 'write-artifact', content: { note: 'one' } }] });
  const finishExpired = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w3', workerDir, task: oneStep, ttlSeconds: 60, now: T0, runId: run2.id, nowForStep: (index) => (index >= 1 ? T1 : T0) });
  assert.equal(finishExpired.status, 'lease_lost');
  assert.equal(store.getRun(db, 'proj-a', run2.id).status, 'running');

  // superseded generation: reclaim mints a new token; the old generation cannot write
  const run3 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w4', workerDir, task, ttlSeconds: 60, now: T0, runId: run3.id, faultInjection: { afterEffectStep: 'one' } }), /injected fault/);
  const staleToken = store.listEvents(db, 'proj-a', run3.id).find((event) => event.eventType === 'lease_acquired').payload.leaseToken;
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w5', workerDir, task, ttlSeconds: 60, now: T1, runId: run3.id, faultInjection: { afterEffectStep: 'two' } }), /injected fault/);
  const newToken = store.listEvents(db, 'proj-a', run3.id).find((event) => event.eventType === 'lease_reclaimed').payload.leaseToken;
  assert.notEqual(newToken, staleToken, 'reclaim mints a fresh generation');
  assert.throws(() => store.updateCheckpoint(db, 'proj-a', run3.id, { owner: 'w4', expectedToken: staleToken, checkpoint: {}, now: T1 }), /owner mismatch|token mismatch/);
  const done = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w6', workerDir, task, ttlSeconds: 60, now: T2, runId: run3.id });
  assert.equal(done.status, 'succeeded');
  db.close();
});

test('legal path identifiers and unchanged descriptor read back consistently', { skip }, () => {
  const { db, workerDir } = freshEnv('readback');
  const task = makeTask();
  // ordinary '..name' identifiers are legal path segments inside the private root
  const legalId = '..legal-name';
  const cancel = worker.requestCancel(workerDir, legalId, { actor: 'tester', reason: 'legal readback', now: T0 });
  assert.equal(cancel.runId, legalId);
  const cancelFile = path.join(workerDir, 'runs', legalId, 'cancel-request.json');
  assert.ok(fs.existsSync(cancelFile), 'the cancel request stays inside the worker dir');
  assert.equal(worker.readCancelRequest(workerDir, legalId).runId, legalId);
  // a normal run reads back descriptor/checkpoint/artifacts consistently
  const run = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  const summary = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0 });
  assert.equal(summary.status, 'succeeded');
  const state = store.getRun(db, 'proj-a', run.id);
  assert.deepEqual(state.checkpoint.completedSteps, ['s1', 's2', 's3']);
  const descriptor = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', run.id, 'task-descriptor.json'), 'utf8'));
  assert.equal(descriptor.descriptorHash, worker.descriptorHashFor(worker.taskDescriptor(task)));
  const artifact = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', run.id, 'artifacts', 's1.json'), 'utf8'));
  assert.equal(artifact.descriptorHash, descriptor.descriptorHash);
  db.close();
});

// ---------- revision-02 focused groups (F2/F4 predicates + legal readback) ----------

test('F2-rev02: artifact predicate binds expected payload and remoteId', { skip }, () => {
  const { db, workerDir } = freshEnv('f2r2');
  const baseSteps = [
    { id: 'submit', kind: 'remote-submit-sim', remoteId: 'synthetic-remote-one', content: { text: 'original' } },
    { id: 'later', kind: 'write-artifact', content: { note: 'later' } }
  ];
  const task = makeTask({ steps: baseSteps });

  // remoteId-only change: must fail closed, keep the file as-is (not overwritten)
  const run1 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0, runId: run1.id, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  const path1 = path.join(workerDir, 'runs', run1.id, 'artifacts', 'submit.json');
  const tamperedRemote = JSON.parse(fs.readFileSync(path1, 'utf8'));
  tamperedRemote.remoteId = 'synthetic-foreign-remote';
  fs.writeFileSync(path1, JSON.stringify(tamperedRemote));
  const before1 = fs.readFileSync(path1, 'utf8');
  const remoteOnly = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T1, runId: run1.id });
  assert.equal(remoteOnly.status, 'failed_input_changed');
  assert.equal(fs.readFileSync(path1, 'utf8'), before1, 'the tampered file was not overwritten');
  assert.match(worker.readJournal(workerDir, run1.id).entries.filter((entry) => entry.event === 'failed_input_changed').pop().reason, /identity/);

  // content + recomputed self-hash: still fails closed (expected digest, not self-hash)
  const run2 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w3', workerDir, task, ttlSeconds: 60, now: T0, runId: run2.id, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  const path2 = path.join(workerDir, 'runs', run2.id, 'artifacts', 'submit.json');
  const tamperedContent = JSON.parse(fs.readFileSync(path2, 'utf8'));
  tamperedContent.content = { text: 'tampered' };
  tamperedContent.contentSha256 = crypto.createHash('sha256').update(canonicalJson({ text: 'tampered' })).digest('hex');
  fs.writeFileSync(path2, JSON.stringify(tamperedContent));
  const before2 = fs.readFileSync(path2, 'utf8');
  const contentOnly = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w4', workerDir, task, ttlSeconds: 60, now: T1, runId: run2.id });
  assert.equal(contentOnly.status, 'failed_input_changed');
  assert.equal(fs.readFileSync(path2, 'utf8'), before2);

  // descriptor self-check: tampered stored fields (label kept) fail closed
  const run3 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w5', workerDir, task, ttlSeconds: 60, now: T0, runId: run3.id, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  const descriptorFile = path.join(workerDir, 'runs', run3.id, 'task-descriptor.json');
  const descriptorTampered = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
  descriptorTampered.steps[0].content = { text: 'tampered-plan' };
  fs.writeFileSync(descriptorFile, JSON.stringify(descriptorTampered));
  const descriptorCheck = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w6', workerDir, task, ttlSeconds: 60, now: T1, runId: run3.id });
  assert.equal(descriptorCheck.status, 'failed_input_changed');

  // cancel scan: a mismatched reference is foreign/audit-only, never a confirmed reconciliation ref
  const run4 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w7', workerDir, task, ttlSeconds: 60, now: T0, runId: run4.id, faultInjection: { afterEffectStep: 'submit' } }), /injected fault/);
  const path4 = path.join(workerDir, 'runs', run4.id, 'artifacts', 'submit.json');
  const foreignRef = JSON.parse(fs.readFileSync(path4, 'utf8'));
  foreignRef.remoteId = 'synthetic-foreign-remote';
  fs.writeFileSync(path4, JSON.stringify(foreignRef));
  worker.requestCancel(workerDir, run4.id, { actor: 'tester', reason: 'foreign reference check', now: T1 });
  const cancelled = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w8', workerDir, task, ttlSeconds: 60, now: T1, runId: run4.id });
  assert.equal(cancelled.status, 'cancelled');
  const checkpoint = store.getRun(db, 'proj-a', run4.id).checkpoint;
  assert.ok(!checkpoint.remoteIds.includes('synthetic-foreign-remote'), 'a mismatched reference is not confirmed for reconciliation');
  assert.deepEqual(checkpoint.durableEffects, []);
  assert.ok(checkpoint.foreignEffects.some((entry) => entry.remoteId === 'synthetic-foreign-remote' && entry.reason === 'identity_or_descriptor_mismatch'), 'the mismatched reference stays audit-only');
  db.close();
});

test('F4-rev02: pre-effect guard re-reads the current DB generation', { skip }, () => {
  const { db, workerDir } = freshEnv('f4r2');
  const task = makeTask({
    steps: [
      { id: 'one', kind: 'write-artifact', content: { note: 'one' } },
      { id: 'two', kind: 'write-artifact', content: { note: 'two' } }
    ]
  });
  const run = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  let eventsAfterTakeover = null;
  let replacementToken = null;
  let takeoverDone = false;
  const onEvent = (event) => {
    if (takeoverDone || event.event !== 'step' || event.stepId !== 'one') return;
    takeoverDone = true;
    // controlled replacement: block -> requeue -> same-owner reacquire -> start (new generation)
    const current = store.getRun(db, 'proj-a', run.id);
    store.blockRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: current.leaseToken, reason: 'controlled replacement', now: T0 });
    store.requeueRun(db, 'proj-a', run.id, { reason: 'controlled replacement', actor: 'tester', now: T0 });
    const reacquired = store.acquireLease(db, 'proj-a', run.id, { owner: 'w1', ttlSeconds: 60, now: T0 });
    replacementToken = reacquired.leaseToken;
    store.startRun(db, 'proj-a', run.id, { owner: 'w1', expectedToken: replacementToken, now: T0 });
    eventsAfterTakeover = JSON.stringify(store.listEvents(db, 'proj-a', run.id));
  };
  const result = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0, runId: run.id, onEvent });
  assert.equal(result.status, 'lease_lost');
  assert.ok(replacementToken, 'the controlled replacement ran');
  assert.equal(fs.existsSync(path.join(workerDir, 'runs', run.id, 'artifacts', 'two.json')), false, 'the old generation wrote no new effect');
  const after = store.getRun(db, 'proj-a', run.id);
  assert.equal(after.status, 'running');
  assert.equal(after.leaseToken, replacementToken, 'the replacement generation is still current');
  assert.deepEqual(after.checkpoint.completedSteps, ['one'], 'the old generation did not change the checkpoint');
  assert.equal(JSON.stringify(store.listEvents(db, 'proj-a', run.id)), eventsAfterTakeover, 'the old generation wrote no run/events after the takeover');

  // the legal new generation can still continue after its lease expires
  const done = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T1, runId: run.id });
  assert.equal(done.status, 'succeeded');

  // known expiry before an effect still stops without writing (cached-expiry case preserved)
  const run2 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  const expired = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w3', workerDir, task, ttlSeconds: 60, now: T0, runId: run2.id, nowForStep: (index) => (index >= 1 ? T1 : T0) });
  assert.equal(expired.status, 'lease_lost');
  assert.equal(fs.existsSync(path.join(workerDir, 'runs', run2.id, 'artifacts', 'two.json')), false);
  db.close();
});

test('rev02 legal readback: unchanged artifacts reuse and descriptor self-check passes', { skip }, () => {
  const { db, workerDir } = freshEnv('r2readback');
  const task = makeTask();
  // normal run: descriptor self-check + artifact identity readback
  const run = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  const summary = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w1', workerDir, task, ttlSeconds: 60, now: T0, runId: run.id });
  assert.equal(summary.status, 'succeeded');
  const state = store.getRun(db, 'proj-a', run.id);
  assert.deepEqual(state.checkpoint.completedSteps, ['s1', 's2', 's3']);
  const descriptor = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', run.id, 'task-descriptor.json'), 'utf8'));
  assert.equal(descriptor.runId, run.id);
  assert.equal(descriptor.descriptorHash, worker.descriptorHashFor(worker.taskDescriptor(task)));
  const artifact = JSON.parse(fs.readFileSync(path.join(workerDir, 'runs', run.id, 'artifacts', 's1.json'), 'utf8'));
  assert.equal(artifact.contentSha256, crypto.createHash('sha256').update(canonicalJson({ note: 'one' })).digest('hex'));
  // crash-window resume with an unchanged descriptor/effect still reuses
  const run2 = store.createRun(db, 'proj-a', { taskType: task.taskType, now: T0 });
  assert.throws(() => worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w2', workerDir, task, ttlSeconds: 60, now: T0, runId: run2.id, faultInjection: { afterEffectStep: 's1' } }), /injected fault/);
  const resumed = worker.runWorkerOnce(db, { projectId: 'proj-a', workerId: 'w3', workerDir, task, ttlSeconds: 60, now: T1, runId: run2.id });
  assert.equal(resumed.status, 'succeeded');
  assert.ok(worker.readJournal(workerDir, run2.id).entries.some((entry) => entry.event === 'effect' && entry.stepId === 's1' && entry.outcome === 'reused'));
  db.close();
});
