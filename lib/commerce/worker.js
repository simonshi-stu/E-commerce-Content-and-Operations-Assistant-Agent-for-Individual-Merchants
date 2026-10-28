'use strict';
/**
 * Single-process worker for business runs (T2.2, revision-01): lease claim/heartbeat/reclaim,
 * per-step checkpoints bound to a persisted task descriptor, resume from the last valid
 * checkpoint, idempotent local effects and explicit cancellation with reconciliation of durable
 * effects. Reuses the approved run-store (leaseToken/expectedToken fencing). See
 * [P]\runtime\runs\WORKER-SEMANTICS-REV01.md for the frozen interface table.
 *
 * Frozen semantics (revision-01):
 * - Path identifiers (F1): every run/step id used as a path segment is validated BEFORE any write
 *   or claim (separators, '.', '..', drive/ADS colons, NUL, Windows device names and trailing
 *   dots/spaces are rejected; an ordinary name like "..name" is NOT treated as a parent) and every
 *   scoped path is resolved defensively under the private worker directory (resolve + prefix +
 *   realpath-ancestor check). The CLI shares the same guards through validateTask.
 * - Claim: acquireLease on a queued run, or on a run whose lease expired (explicit reclaim). An
 *   explicit runId whose taskType does not match the task is rejected before any claim/execution
 *   (and released without execution if the mismatch is only observed after acquire). Never claims
 *   because something "looks idle".
 * - Task binding (F2): BEFORE the first effect the worker persists a normalized task descriptor
 *   (taskType/inputVersion/inputHash/ordered steps/kind/content/remoteId/failTimes) with its
 *   fingerprint, and validates it on EVERY resume — including an empty/null checkpoint (crash
 *   window). A changed version or ordered plan with the same caller inputHash fails closed; the
 *   persisted descriptor also validates its own canonical field hash and run binding (never
 *   trusting the descriptorHash label alone). The single artifactMatches predicate compares the
 *   EXPECTED normalized step payload digest and remoteId (not only the artifact's self-hash) plus
 *   the operation/version/descriptor identity, and is shared by checkpoint resume, effect reuse
 *   and the cancel scan; a mismatched durable effect is never silently reused, overwritten or
 *   confirmed as a reconciliation reference, and a legacy checkpoint/effect without a descriptor
 *   is refused. Identity/integrity only — not a signature or MAC.
 * - Step boundary: local effect first, then ONE checkpoint write (descriptorHash/inputVersion/
 *   inputHash/completedSteps/artifactRefs/lastStepId) committed together with its event.
 *   Completed steps are never re-run; an effect that finished before its checkpoint is recovered
 *   by the stable local operationId plus the full identity match.
 * - Cancellation (F3): a persisted cancel request is checked after the claim and between steps.
 *   Before cancelling, the worker reconciles validated durable effects from the effect->checkpoint
 *   window and preserves structured remoteIds/operationIds (committed vs uncommitted) plus any
 *   foreign effects for audit; it never re-executes effects or later steps to "reconcile". A
 *   submitted upstream task is NOT guaranteed to be refunded (reconciliation belongs to T2.3).
 * - Lease fencing (F4): before EVERY new effect/retry the worker re-reads the run from the
 *   approved store and checks the CURRENT owner/token/status plus the strict instant expiry — a
 *   cached expiry alone is not enough, so a superseded generation stops BEFORE a new effect even
 *   while its cached expiry is still in the future. renew/finish/cancel/fail/start conflicts are
 *   all classified as lease_lost (never misreported by the CLI as a successful lease_held).
 * - Limits: local single-process MVP — NOT an OS sandbox and NOT an authentication service; a
 *   synchronously blocking step cannot be interrupted mid-execution, and a concurrent external
 *   actor racing the same local files is out of scope. `now` may be an explicit trusted clock in
 *   tests. Only local synthetic effects run here: no provider calls, no fees, no external side
 *   effects, no real business data.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ValidationError } = require('./evidence.js');
const store = require('./run-store.js');
const { assertJsonCompatible } = require('./privacy.js');
const { canonicalJson } = require('./packs.js');

const STEP_KINDS = Object.freeze(['write-artifact', 'remote-submit-sim']);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class InjectedFaultError extends Error {
  constructor(message) {
    super(message);
    this.code = 'injected_fault';
  }
}
class WorkerInputChangedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'input_changed';
  }
}

function fail(message) {
  throw new ValidationError(message);
}
function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalNonEmptyString(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return requireNonEmptyString(value, name);
}
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function operationIdFor(runId, stepId, inputHash) {
  return `${runId}:${stepId}:${inputHash}`;
}

// ---------- scoped paths (F1) ----------

/** Reject path-dangerous identifiers before any write/claim; an ordinary "..name" stays legal. */
function assertSafePathId(value, name) {
  const text = requireNonEmptyString(value, name);
  if (text === '.' || text === '..') fail(`${name} must not be a current/parent traversal segment`);
  if (/[/\\:\0]/.test(text)) fail(`${name} must not contain path separators, drive/ADS colons or NUL characters`);
  if (WINDOWS_DEVICE_RE.test(text)) fail(`${name} must not be a Windows device name`);
  if (/[. ]$/.test(text)) fail(`${name} must not end with a dot or a space`);
  return text;
}
function realpathDeepestExisting(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function isInsideRoot(candidate, root) {
  if (samePath(candidate, root)) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return process.platform === 'win32' ? candidate.toLowerCase().startsWith(rootWithSep.toLowerCase()) : candidate.startsWith(rootWithSep);
}
/** Resolve path segments under the private worker root, defensively (resolve + prefix + realpath). */
function resolveScoped(root, segments, label) {
  const rootResolved = path.resolve(root);
  const parts = segments.map((segment, index) => assertSafePathId(segment, `${label}[${index}]`));
  const resolved = path.resolve(rootResolved, ...parts);
  if (!isInsideRoot(resolved, rootResolved)) fail(`${label} resolves outside the private worker directory`);
  const rootReal = realpathDeepestExisting(rootResolved);
  const targetReal = realpathDeepestExisting(resolved);
  if (rootReal && targetReal && !isInsideRoot(targetReal, rootReal)) {
    fail(`${label} resolves outside the private worker directory (realpath)`);
  }
  return resolved;
}
function runDir(workerDir, runId) {
  return resolveScoped(workerDir, ['runs', runId], 'run path');
}
function artifactsDir(workerDir, runId) {
  return resolveScoped(workerDir, ['runs', runId, 'artifacts'], 'artifacts path');
}
function artifactPath(workerDir, runId, stepId) {
  const id = assertSafePathId(stepId, 'stepId');
  return resolveScoped(workerDir, ['runs', runId, 'artifacts', `${id}.json`], 'artifact path');
}
function cancelRequestPath(workerDir, runId) {
  return resolveScoped(workerDir, ['runs', runId, 'cancel-request.json'], 'cancel request path');
}
function journalPath(workerDir, runId) {
  return resolveScoped(workerDir, ['runs', runId, 'journal.json'], 'journal path');
}
function descriptorPath(workerDir, runId) {
  return resolveScoped(workerDir, ['runs', runId, 'task-descriptor.json'], 'descriptor path');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
}
function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function appendJournal(workerDir, runId, entry) {
  const file = journalPath(workerDir, runId);
  const journal = readJsonIfExists(file) ?? { schemaVersion: 1, runId, entries: [] };
  journal.entries.push({ at: new Date().toISOString(), ...entry });
  writeJsonAtomic(file, journal);
}
function readJournal(workerDir, runId) {
  return readJsonIfExists(journalPath(workerDir, runId));
}

// ---------- task + descriptor validation (F2) ----------

function validateTask(task) {
  assertJsonCompatible(task, 'task');
  if (task === null || typeof task !== 'object' || Array.isArray(task)) fail('task must be a plain object');
  const taskType = requireNonEmptyString(task.taskType, 'task.taskType');
  const inputVersion = requireNonEmptyString(task.inputVersion, 'task.inputVersion');
  const inputHash = requireNonEmptyString(task.inputHash, 'task.inputHash');
  if (!SHA256_RE.test(inputHash)) fail('task.inputHash must be a 64-character hex digest');
  if (!Array.isArray(task.steps) || task.steps.length === 0) fail('task.steps must be a non-empty array');
  const ids = new Set();
  const steps = task.steps.map((step, index) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) fail(`task.steps[${index}] must be a plain object`);
    const id = assertSafePathId(step.id, `task.steps[${index}].id`);
    if (ids.has(id)) fail(`duplicate step id ${id}`);
    ids.add(id);
    if (!STEP_KINDS.includes(step.kind)) fail(`task.steps[${index}].kind must be one of ${STEP_KINDS.join(', ')}`);
    if (step.content !== undefined) assertJsonCompatible(step.content, `task.steps[${index}].content`);
    const remoteId = optionalNonEmptyString(step.remoteId, `task.steps[${index}].remoteId`);
    const failTimes = step.failTimes === undefined ? 0 : step.failTimes;
    if (!Number.isInteger(failTimes) || failTimes < 0) fail(`task.steps[${index}].failTimes must be a non-negative integer`);
    return { id, kind: step.kind, content: step.content ?? null, remoteId, failTimes };
  });
  return { taskType, inputVersion, inputHash, steps };
}
function loadTask(taskFile) {
  return validateTask(JSON.parse(fs.readFileSync(taskFile, 'utf8')));
}
/** Normalized task identity: binds version, caller hash AND the ordered step plan. */
function taskDescriptor(task) {
  const normalized = validateTask(task);
  return {
    schemaVersion: 1,
    taskType: normalized.taskType,
    inputVersion: normalized.inputVersion,
    inputHash: normalized.inputHash,
    steps: normalized.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      content: step.content ?? null,
      remoteId: step.remoteId ?? null,
      failTimes: step.failTimes
    }))
  };
}
function descriptorHashFor(descriptor) {
  return sha256Hex(canonicalJson(descriptor));
}
/**
 * Validate a persisted descriptor's own canonical field hash and run binding (F2-rev02): never
 * trust the descriptorHash label alone. Identity/integrity only — not a signature or MAC; it
 * cannot stop someone with filesystem access from rewriting every file consistently.
 */
function descriptorSelfCheck(persisted, runId, dHash) {
  if (!persisted || typeof persisted !== 'object') return false;
  if (persisted.runId !== runId) return false;
  const recomputed = descriptorHashFor({
    schemaVersion: persisted.schemaVersion,
    taskType: persisted.taskType,
    inputVersion: persisted.inputVersion,
    inputHash: persisted.inputHash,
    steps: persisted.steps
  });
  return persisted.descriptorHash === recomputed && recomputed === dHash;
}
/**
 * The single artifact identity predicate (F2-rev02), shared by checkpoint resume, effect reuse
 * and the cancel scan: operation/version/descriptor identity PLUS the EXPECTED normalized step
 * payload digest, canonical payload equality and the expected remoteId — never the artifact's
 * self-hash alone. A mismatch is fail-closed (resume/reuse) or foreign/audit-only (scan).
 */
function artifactMatches(artifact, runId, task, step, descriptorHash) {
  if (!artifact || typeof artifact !== 'object') return false;
  if (artifact.operationId !== operationIdFor(runId, step.id, task.inputHash)) return false;
  if (artifact.stepId !== step.id || artifact.kind !== step.kind) return false;
  if (artifact.inputVersion !== task.inputVersion || artifact.inputHash !== task.inputHash) return false;
  if (artifact.descriptorHash !== descriptorHash) return false;
  const expectedDigest = sha256Hex(canonicalJson(step.content ?? null));
  if (artifact.contentSha256 !== expectedDigest) return false;
  if (canonicalJson(artifact.content ?? null) !== canonicalJson(step.content ?? null)) return false;
  if ((artifact.remoteId ?? null) !== (step.remoteId ?? null)) return false;
  return true;
}

/** Fail-closed validation of a checkpoint against the task descriptor (hash/version/steps/artifacts). */
function validateCheckpoint(checkpoint, task, workerDir, runId, descriptorHash) {
  if (checkpoint === null) return { ok: true, completedSteps: [], artifactRefs: [], remoteIds: [] };
  if (checkpoint.inputVersion !== task.inputVersion || checkpoint.inputHash !== task.inputHash) {
    throw new WorkerInputChangedError('checkpoint input version/hash does not match the task; refusing to reuse old completion');
  }
  if (checkpoint.descriptorHash !== descriptorHash) {
    throw new WorkerInputChangedError('checkpoint task descriptor does not match the persisted descriptor; refusing to reuse old completion');
  }
  const byId = new Map(task.steps.map((step) => [step.id, step]));
  const completedSteps = Array.isArray(checkpoint.completedSteps) ? checkpoint.completedSteps : [];
  for (const stepId of completedSteps) {
    const step = byId.get(stepId);
    if (!step) throw new WorkerInputChangedError(`checkpoint references unknown step ${stepId}; step set changed`);
    const artifact = readJsonIfExists(artifactPath(workerDir, runId, stepId));
    if (!artifactMatches(artifact, runId, task, step, descriptorHash)) {
      throw new WorkerInputChangedError(`checkpoint references a missing or mismatched artifact for ${stepId}`);
    }
  }
  const artifactRefs = Array.isArray(checkpoint.artifactRefs) ? checkpoint.artifactRefs : [];
  const remoteIds = [];
  for (const stepId of completedSteps) {
    const artifact = readJsonIfExists(artifactPath(workerDir, runId, stepId));
    if (artifact?.remoteId) remoteIds.push(artifact.remoteId);
  }
  return { ok: true, completedSteps: [...completedSteps], artifactRefs: [...artifactRefs], remoteIds };
}

// ---------- cancellation (F1 ids / F3 reconciliation) ----------

function requestCancel(workerDir, runId, input = {}) {
  const id = assertSafePathId(runId, 'runId');
  const actor = optionalNonEmptyString(input.actor, 'actor');
  const reason = optionalNonEmptyString(input.reason, 'reason');
  const requestedAt = optionalNonEmptyString(input.now, 'now') ?? new Date().toISOString();
  writeJsonAtomic(cancelRequestPath(workerDir, id), {
    schemaVersion: 1,
    runId: id,
    actor,
    reason,
    requestedAt,
    note: 'cancel is checked by the worker between steps; a submitted upstream task is not guaranteed to be refunded'
  });
  return readCancelRequest(workerDir, id);
}
function readCancelRequest(workerDir, runId) {
  return readJsonIfExists(cancelRequestPath(workerDir, assertSafePathId(runId, 'runId')));
}

// ---------- local synthetic effects (F2 identity) ----------

function executeStepEffect(workerDir, runId, task, step, descriptorHash, nowText) {
  const file = artifactPath(workerDir, runId, step.id);
  const operationId = operationIdFor(runId, step.id, task.inputHash);
  const existing = readJsonIfExists(file);
  if (existing) {
    if (!artifactMatches(existing, runId, task, step, descriptorHash)) {
      throw new WorkerInputChangedError(`durable effect ${step.id} identity does not match the current task descriptor; refusing to reuse or overwrite it`);
    }
    appendJournal(workerDir, runId, { event: 'effect', stepId: step.id, operationId, outcome: 'reused', remoteId: existing.remoteId ?? null });
    return { artifact: existing, outcome: 'reused' };
  }
  const artifact = {
    schemaVersion: 1,
    operationId,
    stepId: step.id,
    kind: step.kind,
    inputVersion: task.inputVersion,
    inputHash: task.inputHash,
    descriptorHash,
    contentSha256: sha256Hex(canonicalJson(step.content ?? null)),
    remoteId: step.remoteId,
    content: step.content,
    writtenAt: nowText,
    note: 'local synthetic effect; idempotent by operationId + descriptor identity (no external calls)'
  };
  writeJsonAtomic(file, artifact);
  appendJournal(workerDir, runId, { event: 'effect', stepId: step.id, operationId, outcome: 'written', remoteId: step.remoteId });
  return { artifact, outcome: 'written' };
}

/** Split durable effects into descriptor-valid bound ones and foreign ones (audit only). */
function scanDurableEffects(workerDir, runId, task, descriptorHash) {
  const dir = artifactsDir(workerDir, runId);
  const bound = [];
  const foreign = [];
  if (!fs.existsSync(dir)) return { bound, foreign };
  const byId = new Map(task.steps.map((step) => [step.id, step]));
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let artifact = null;
    try {
      artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      foreign.push({ file: name, reason: 'unreadable' });
      continue;
    }
    const step = byId.get(artifact?.stepId);
    if (step && artifactMatches(artifact, runId, task, step, descriptorHash)) {
      bound.push({ stepId: step.id, operationId: artifact.operationId, remoteId: artifact.remoteId ?? null, kind: artifact.kind });
    } else {
      foreign.push({
        file: name,
        stepId: artifact?.stepId ?? null,
        operationId: artifact?.operationId ?? null,
        remoteId: artifact?.remoteId ?? null,
        reason: 'identity_or_descriptor_mismatch'
      });
    }
  }
  return { bound, foreign };
}

// ---------- worker run ----------

function claimRun(db, options) {
  const { projectId, task, workerId, ttlSeconds } = options;
  if (options.runId) {
    const deadline = Date.now() + (options.waitLeaseSeconds ?? 0) * 1000;
    for (;;) {
      try {
        return store.acquireLease(db, projectId, options.runId, { owner: workerId, ttlSeconds, now: options.now });
      } catch (error) {
        if (error.code !== 'conflict' || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  }
  const candidates = store.listRuns(db, projectId, { taskType: task.taskType })
    .filter((run) => ['queued', 'leased', 'running', 'waiting_input'].includes(run.status))
    .sort((a, b) => (a.status === 'queued' ? -1 : 1) - (b.status === 'queued' ? -1 : 1) || a.createdAt.localeCompare(b.createdAt));
  for (const run of candidates) {
    try {
      return store.acquireLease(db, projectId, run.id, { owner: workerId, ttlSeconds, now: options.now });
    } catch (error) {
      if (error.code === 'conflict') continue;
      throw error;
    }
  }
  return null;
}

/**
 * Process at most one run once. Returns a summary; throws InjectedFaultError for controlled fault
 * injection (after the effect, before the checkpoint — the crash window).
 */
function runWorkerOnce(db, options = {}) {
  const projectId = requireNonEmptyString(options.projectId, 'projectId');
  const workerId = requireNonEmptyString(options.workerId, 'workerId');
  const workerDir = requireNonEmptyString(options.workerDir, 'workerDir');
  const task = validateTask(options.task);
  const descriptor = taskDescriptor(task);
  const dHash = descriptorHashFor(descriptor);
  const ttlSeconds = options.ttlSeconds ?? 300;
  const heartbeatSeconds = options.heartbeatSeconds ?? null;
  const maxStepAttempts = options.maxStepAttempts ?? 2;
  const emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const claimNow = options.now;

  // Explicit runId: reject path-dangerous ids and taskType mismatches BEFORE any claim/execution.
  if (options.runId) {
    assertSafePathId(options.runId, 'runId');
    const pre = store.getRun(db, projectId, options.runId);
    if (pre.taskType !== task.taskType) {
      const reason = `explicit runId taskType mismatch: run=${pre.taskType} task=${task.taskType}; refusing before claim`;
      appendJournal(workerDir, options.runId, { event: 'task_type_mismatch', workerId, reason });
      emit({ event: 'task_type_mismatch', runId: options.runId, reason });
      return { status: 'task_type_mismatch', runId: options.runId, reason };
    }
  }

  const lease = claimRun(db, { projectId, task, workerId, ttlSeconds, now: claimNow, runId: options.runId, waitLeaseSeconds: options.waitLeaseSeconds });
  if (!lease) return { status: 'no_claim', runId: null };
  const runId = lease.id;
  const token = lease.leaseToken;
  let leaseExpiresAt = lease.leaseExpiresAt;
  emit({ event: 'claimed', runId, workerId, leaseToken: token, leaseExpiresAt });
  appendJournal(workerDir, runId, { event: 'claimed', workerId, leaseToken: token });

  if (lease.taskType !== task.taskType) {
    const reason = `claimed run taskType mismatch: run=${lease.taskType} task=${task.taskType}; lease released without execution`;
    store.releaseLease(db, projectId, runId, { owner: workerId, expectedToken: token, now: claimNow });
    appendJournal(workerDir, runId, { event: 'task_type_mismatch', workerId, reason });
    emit({ event: 'task_type_mismatch', runId, reason });
    return { status: 'task_type_mismatch', runId, reason };
  }

  const nowTextFor = (index) => (typeof options.nowForStep === 'function' ? options.nowForStep(index) : (claimNow ?? new Date().toISOString()));
  let lastRenewEpoch = Date.parse(nowTextFor(0));
  let completedSteps = [];
  let artifactRefs = [];
  let remoteIds = [];

  const finish = (status, extra = {}) => {
    emit({ event: 'finished', runId, status, ...extra });
    return { status, runId, completedSteps: [...completedSteps], artifactRefs: [...artifactRefs], remoteIds: [...remoteIds], ...extra };
  };
  const leaseLost = (reason, stepId = null) => {
    appendJournal(workerDir, runId, { event: 'lease_lost', workerId, stepId, reason });
    emit({ event: 'lease_lost', runId, stepId, reason });
    return finish('lease_lost', { reason });
  };
  const conflictToLeaseLost = (error, stepId = null) => {
    if (error && error.code === 'conflict') return leaseLost(error.message, stepId);
    return null;
  };
  const guarded = (fn, stepId = null) => {
    try {
      fn();
      return null;
    } catch (error) {
      const lost = conflictToLeaseLost(error, stepId);
      if (lost) return lost;
      throw error;
    }
  };
  const failInputChanged = (reason) => {
    const lost = guarded(() => store.failRun(db, projectId, runId, { owner: workerId, expectedToken: token, reason, now: nowTextFor(0) }));
    if (lost) return lost;
    appendJournal(workerDir, runId, { event: 'failed_input_changed', workerId, reason });
    emit({ event: 'failed_input_changed', runId, reason });
    return finish('failed_input_changed', { reason });
  };
  const cancelNow = (index, cancelRequest) => {
    const nowText = nowTextFor(index);
    const scan = scanDurableEffects(workerDir, runId, task, dHash);
    const durableEffects = scan.bound.map((effect) => ({ ...effect, committed: completedSteps.includes(effect.stepId) }));
    const boundRemoteIds = durableEffects.map((effect) => effect.remoteId).filter(Boolean);
    const allRemoteIds = [...new Set([...remoteIds, ...boundRemoteIds])];
    const operationIds = durableEffects.map((effect) => effect.operationId);
    const cancelPoint = [...completedSteps];
    const reason = `cancel requested (actor=${cancelRequest.actor ?? 'unknown'}, reason=${cancelRequest.reason ?? 'unspecified'}); cancelPoint=[${cancelPoint.join(',')}]; operationIds=[${operationIds.join(',')}]; remoteIds=[${allRemoteIds.join(',')}]; upstream refund not guaranteed`;
    try {
      store.updateCheckpoint(db, projectId, runId, {
        owner: workerId,
        expectedToken: token,
        checkpoint: {
          descriptorHash: dHash,
          inputVersion: task.inputVersion,
          inputHash: task.inputHash,
          completedSteps,
          artifactRefs,
          lastStepId: completedSteps[completedSteps.length - 1] ?? null,
          cancelPoint,
          remoteIds: allRemoteIds,
          durableEffects,
          foreignEffects: scan.foreign,
          updatedAt: nowText
        },
        now: nowText
      });
      store.cancelRun(db, projectId, runId, { owner: workerId, expectedToken: token, reason, now: nowText });
    } catch (error) {
      const lost = conflictToLeaseLost(error);
      if (lost) return lost;
      throw error;
    }
    appendJournal(workerDir, runId, { event: 'cancelled', workerId, cancelPoint, remoteIds: allRemoteIds, durableEffects, foreignEffects: scan.foreign, reason });
    emit({ event: 'cancelled', runId, cancelPoint, remoteIds: allRemoteIds });
    return finish('cancelled', { cancelPoint, cancelReason: reason, durableEffects, remoteIds: allRemoteIds });
  };

  // Start the run (leased -> running) BEFORE the fail-closed resume decision: a rejected
  // checkpoint/descriptor is recorded as run_failed under the current lease, and the approved
  // run-store state graph has no leased -> failed transition. A start conflict means the
  // generation was lost between acquire and start: classified as lease_lost, never success.
  const startLost = guarded(() => store.startRun(db, projectId, runId, { owner: workerId, expectedToken: token, now: nowTextFor(0) }));
  if (startLost) return startLost;

  // ---- F2: task descriptor binding before any effect ----
  const persistedDescriptor = readJsonIfExists(descriptorPath(workerDir, runId));
  if (persistedDescriptor && !descriptorSelfCheck(persistedDescriptor, runId, dHash)) {
    return failInputChanged('task descriptor mismatch: input version/hash or ordered plan does not match the persisted descriptor canonical hash/run binding; refusing to reuse old completion');
  }
  if (!persistedDescriptor) {
    if (lease.checkpoint !== null) {
      return failInputChanged('checkpoint exists without a task descriptor; refusing unverified legacy resume');
    }
    const strayArtifacts = fs.existsSync(artifactsDir(workerDir, runId))
      ? fs.readdirSync(artifactsDir(workerDir, runId)).filter((name) => name.endsWith('.json'))
      : [];
    if (strayArtifacts.length > 0) {
      return failInputChanged('durable effects exist without a task descriptor; refusing unverified reuse');
    }
    writeJsonAtomic(descriptorPath(workerDir, runId), {
      schemaVersion: 1,
      runId,
      descriptorHash: dHash,
      taskType: descriptor.taskType,
      inputVersion: descriptor.inputVersion,
      inputHash: descriptor.inputHash,
      steps: descriptor.steps,
      writtenAt: nowTextFor(0)
    });
    appendJournal(workerDir, runId, { event: 'descriptor_written', workerId, descriptorHash: dHash });
  }

  // ---- resume validation (fail closed on input/step/artifact mismatch) ----
  let checkpointState;
  try {
    checkpointState = validateCheckpoint(lease.checkpoint, task, workerDir, runId, dHash);
  } catch (error) {
    if (error instanceof WorkerInputChangedError) return failInputChanged(error.message);
    throw error;
  }
  completedSteps = checkpointState.completedSteps;
  artifactRefs = checkpointState.artifactRefs;
  remoteIds = checkpointState.remoteIds;

  const preCancel = readCancelRequest(workerDir, runId);
  if (preCancel) return cancelNow(0, preCancel);

  const heartbeatDue = (index) => {
    if (!heartbeatSeconds) return false;
    return Date.parse(nowTextFor(index)) - lastRenewEpoch >= heartbeatSeconds * 1000;
  };

  for (let index = 0; index < task.steps.length; index++) {
    const step = task.steps[index];
    if (completedSteps.includes(step.id)) continue;
    const cancelRequest = readCancelRequest(workerDir, runId);
    if (cancelRequest) return cancelNow(index, cancelRequest);
    if (heartbeatDue(index)) {
      try {
        const renewed = store.renewLease(db, projectId, runId, { owner: workerId, expectedToken: token, ttlSeconds, now: nowTextFor(index) });
        leaseExpiresAt = renewed.leaseExpiresAt;
        lastRenewEpoch = Date.parse(nowTextFor(index));
        emit({ event: 'heartbeat', runId, leaseExpiresAt: renewed.leaseExpiresAt, leaseToken: renewed.leaseToken });
      } catch (error) {
        const lost = conflictToLeaseLost(error, step.id);
        if (lost) return lost;
        throw error;
      }
    }
    let lastError = null;
    let done = false;
    for (let attempt = 1; attempt <= maxStepAttempts && !done; attempt++) {
      // F4-rev02: re-read the CURRENT generation from the approved store before every
      // effect/retry. A cached expiry is not enough — a superseded token must stop BEFORE a new
      // effect even while its cached expiry is still in the future.
      const stepNowEpoch = Date.parse(nowTextFor(index));
      const currentRun = store.getRun(db, projectId, runId);
      const currentExpiryEpoch = currentRun.leaseExpiresAt ? Date.parse(currentRun.leaseExpiresAt) : NaN;
      if (
        currentRun.status !== 'running' ||
        currentRun.leaseOwner !== workerId ||
        currentRun.leaseToken !== token ||
        !(stepNowEpoch < currentExpiryEpoch)
      ) {
        return leaseLost(`lease generation check failed before effect ${step.id} (current owner/token/status/strict expiry do not match the held lease); no new effect written`, step.id);
      }
      try {
        if (step.failTimes && attempt <= step.failTimes) throw new Error(`synthetic transient failure of ${step.id} (attempt ${attempt})`);
        const result = executeStepEffect(workerDir, runId, task, step, dHash, nowTextFor(index));
        if (options.faultInjection?.afterEffectStep === step.id) {
          appendJournal(workerDir, runId, { event: 'injected_fault', workerId, stepId: step.id, boundary: 'after-effect-before-checkpoint' });
          emit({ event: 'injected_fault', runId, stepId: step.id, boundary: 'after-effect-before-checkpoint' });
          throw new InjectedFaultError(`injected fault after effect of ${step.id} (before checkpoint)`);
        }
        completedSteps.push(step.id);
        artifactRefs.push(result.artifact.operationId);
        if (result.artifact.remoteId) remoteIds.push(result.artifact.remoteId);
        try {
          store.updateCheckpoint(db, projectId, runId, {
            owner: workerId,
            expectedToken: token,
            checkpoint: {
              descriptorHash: dHash,
              inputVersion: task.inputVersion,
              inputHash: task.inputHash,
              completedSteps,
              artifactRefs,
              lastStepId: step.id,
              updatedAt: nowTextFor(index)
            },
            now: nowTextFor(index)
          });
        } catch (error) {
          const lost = conflictToLeaseLost(error, step.id);
          if (lost) return lost;
          throw error;
        }
        appendJournal(workerDir, runId, { event: 'step_done', workerId, stepId: step.id, outcome: result.outcome, operationId: result.artifact.operationId, attempt });
        emit({ event: 'step', runId, stepId: step.id, outcome: result.outcome, attempt });
        if (options.cancelAfterStep === step.id) {
          requestCancel(workerDir, runId, { actor: 'cancelAfterStep-hook', reason: 'synthetic external cancel request', now: nowTextFor(index) });
        }
        done = true;
      } catch (error) {
        if (error instanceof InjectedFaultError) throw error;
        if (error instanceof WorkerInputChangedError) return failInputChanged(error.message);
        if (error.code === 'conflict') return leaseLost(error.message, step.id);
        lastError = error;
        appendJournal(workerDir, runId, { event: 'step_attempt_failed', workerId, stepId: step.id, attempt, reason: error.message });
      }
    }
    if (!done) {
      const reason = `step ${step.id} failed after ${maxStepAttempts} attempts: ${lastError?.message ?? 'unknown'}`;
      const lost = guarded(() => store.failRun(db, projectId, runId, { owner: workerId, expectedToken: token, reason, now: nowTextFor(index) }));
      if (lost) return lost;
      appendJournal(workerDir, runId, { event: 'failed_step', workerId, stepId: step.id, reason });
      emit({ event: 'failed_step', runId, stepId: step.id, reason });
      return finish('failed_step', { reason });
    }
  }

  const finalCancel = readCancelRequest(workerDir, runId);
  if (finalCancel) return cancelNow(task.steps.length, finalCancel);
  try {
    store.completeRun(db, projectId, runId, { owner: workerId, expectedToken: token, now: nowTextFor(task.steps.length) });
  } catch (error) {
    const lost = conflictToLeaseLost(error);
    if (lost) return lost;
    throw error;
  }
  appendJournal(workerDir, runId, { event: 'succeeded', workerId, completedSteps, artifactRefs });
  emit({ event: 'succeeded', runId, completedSteps });
  return finish('succeeded');
}

module.exports = {
  STEP_KINDS,
  InjectedFaultError,
  WorkerInputChangedError,
  loadTask,
  validateTask,
  taskDescriptor,
  descriptorHashFor,
  validateCheckpoint,
  requestCancel,
  readCancelRequest,
  readJournal,
  operationIdFor,
  assertSafePathId,
  resolveScoped,
  scanDurableEffects,
  runWorkerOnce
};
