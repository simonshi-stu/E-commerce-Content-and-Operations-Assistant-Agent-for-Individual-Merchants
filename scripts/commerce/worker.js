#!/usr/bin/env node
'use strict';
/**
 * Worker CLI (T2.2). Processes AT MOST ONE business run per invocation and exits — there is no
 * infinite default and no implicit scan of real business data: every path (db / worker dir / task
 * file / project / worker id / lease ttl) must be passed explicitly. Reuses the approved
 * run-store + worker library; local synthetic steps only (no provider calls, no fees).
 *
 * Usage:
 *   node scripts/commerce/worker.js --db <private db> --worker-dir <private dir> \
 *     --task-file <private task json> --worker-id <id> --project <projectId> --ttl-seconds <n> \
 *     [--heartbeat-seconds <n>] [--wait-lease-seconds <n>] [--run-id <runId>] \
 *     [--max-step-attempts <n>] [--fault-after-effect-step <stepId>] [--pause-after-step <stepId>]
 *
 * Exit codes: 0 processed (succeeded/cancelled/no_claim, plus an informational claim-time
 * lease_held), 2 for failed statuses, lease_lost or task_type_mismatch (never misreported as
 * success), 3 injected fault. Progress is printed as one JSON line per event (synchronous fd writes so a
 * parent can follow without polling sleeps). `--pause-after-step` and
 * `--fault-after-effect-step` are controlled rehearsal hooks: they emit a `paused` /
 * `injected_fault` event with the exact boundary, so a process-kill or crash-window rehearsal can
 * record its trigger and never fake a crash by merely closing an API handle. Run/step path
 * identifiers are validated by the worker library before any write or claim (the CLI shares the
 * same guards through validateTask).
 */
const fs = require('node:fs');
const worker = require('../../lib/commerce/worker.js');
const dbApi = require('../../lib/commerce/db.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[key] = value;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['db', 'worker-dir', 'task-file', 'worker-id', 'project', 'ttl-seconds'];
  for (const key of required) {
    if (typeof args[key] !== 'string' || args[key].trim() === '') throw new Error(`missing --${key}`);
  }
  const writeLine = (event) => fs.writeSync(1, `${JSON.stringify(event)}\n`);
  const pauseAfterStep = typeof args['pause-after-step'] === 'string' ? args['pause-after-step'] : null;
  const emit = (event) => {
    writeLine(event);
    if (pauseAfterStep && event.event === 'step' && event.stepId === pauseAfterStep) {
      writeLine({ event: 'paused', stepId: event.stepId, boundary: 'after-checkpoint-before-next-step', maxPauseMs: 60000 });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    }
  };
  const db = dbApi.openDb(args.db);
  try {
    const task = worker.loadTask(args['task-file']);
    const result = worker.runWorkerOnce(db, {
      projectId: args.project,
      workerId: args['worker-id'],
      workerDir: args['worker-dir'],
      task,
      ttlSeconds: Number(args['ttl-seconds']),
      heartbeatSeconds: args['heartbeat-seconds'] ? Number(args['heartbeat-seconds']) : null,
      waitLeaseSeconds: args['wait-lease-seconds'] ? Number(args['wait-lease-seconds']) : 0,
      runId: typeof args['run-id'] === 'string' ? args['run-id'] : undefined,
      maxStepAttempts: args['max-step-attempts'] ? Number(args['max-step-attempts']) : undefined,
      faultInjection: typeof args['fault-after-effect-step'] === 'string' ? { afterEffectStep: args['fault-after-effect-step'] } : undefined,
      onEvent: emit
    });
    writeLine({ event: 'result', ...result });
    if (!['succeeded', 'cancelled', 'no_claim'].includes(result.status)) process.exitCode = 2;
  } catch (error) {
    if (error instanceof worker.InjectedFaultError) {
      writeLine({ event: 'injected_fault_exit', message: error.message });
      process.exitCode = 3;
    } else if (error.code === 'conflict') {
      writeLine({ event: 'lease_held', message: error.message });
      process.exitCode = 0;
    } else {
      throw error;
    }
  } finally {
    db.close();
  }
}

main();
