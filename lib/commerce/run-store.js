'use strict';
/**
 * Business run store: platform run state machine, leases, generations and append-only audit events
 * (T2.1, revision-01).
 *
 * NAMING: `runs` / `run_events` are PLATFORM BUSINESS run state. Development task state lives in
 * PROGRESS.json and must never be mixed with this store; business runs are never operated through
 * development runIds, notifications or controls.
 *
 * State graph (illegal transitions are rejected with ConflictError):
 *   queued        -> leased (acquire) | cancelled
 *   leased        -> running (start) | queued (release) | cancelled      (renew/reclaim while leased)
 *   running       -> waiting_input | blocked | succeeded | failed | cancelled
 *   waiting_input -> running (resume) | blocked | failed | cancelled
 *   blocked       -> queued (requeue) | failed | cancelled
 *   succeeded / failed / cancelled -> terminal: no outgoing transitions, never revived.
 * Legal recovery of a terminal run: createRun({retryOf: <terminal run id>}) creates a NEW run and
 * records the relationship in its run_created event; the old run is never modified.
 *
 * Lease generations (fencing): every acquire/reclaim mints a FRESH `leaseToken` (persisted in
 * `runs.lease_token`, returned on the hydrated run) and invalidates any previous generation.
 * `renewLease` preserves the current generation; `releaseLease`/`blockRun`/terminal states clear
 * it; a later reacquire always mints a new one (never reused). All lease-governed writes
 * (renew/release/start/resume/checkpoint/block/complete/fail/cancel on a leased run) REQUIRE
 * `expectedToken` and validate owner + generation + unexpired lease_expires_at + status inside the
 * transaction, so a stale writer from an old generation can never take effect under a newer lease
 * — even when the same owner string is reused (ABA). Missing tokens fail closed. This is
 * store-level fencing, not authentication or OS isolation, and `now` is a trusted caller/test
 * clock (not proof against client clock forgery).
 *
 * Atomicity: state/lease/checkpoint changes and their audit event are written in ONE transaction;
 * `run_events` is append-only (no update/delete API; the 0004 migration adds ABORT triggers).
 * Checkpoint semantics: `checkpoint_json` is replaced as a whole current value; the
 * `checkpoint_updated` event only records counts and the new sha256, so events do NOT preserve the
 * full previous checkpoint (no checkpoint-history service here).
 * Time: lease_expires_at and audit timestamps are stored as canonical UTC ISO; caller-provided
 * `now` must be a strict ISO instant with an explicit timezone and a real calendar date (same
 * format contract as the memory effectiveAt contract). Tests use an explicit clock; no sleeps and
 * no system-clock changes.
 *
 * Scope: store/state/lease/audit only — no worker, provider, HTTP route, fees or real facts.
 *
 * DEV NOTE: development task state (PROGRESS.json) is unrelated to business `runs` state.
 */
const crypto = require('node:crypto');
const { ValidationError, NotFoundError, ConflictError } = require('./evidence.js');
const { assertJsonCompatible } = require('./privacy.js');

const RUN_STATES = Object.freeze(['queued', 'leased', 'running', 'waiting_input', 'blocked', 'succeeded', 'failed', 'cancelled']);
const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled']);
const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['leased', 'cancelled']),
  leased: Object.freeze(['running', 'queued', 'cancelled']),
  running: Object.freeze(['waiting_input', 'blocked', 'succeeded', 'failed', 'cancelled']),
  waiting_input: Object.freeze(['running', 'blocked', 'failed', 'cancelled']),
  blocked: Object.freeze(['queued', 'failed', 'cancelled']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([])
});
const EVENT_TYPES = Object.freeze([
  'run_created', 'lease_acquired', 'lease_reclaimed', 'lease_renewed', 'lease_released',
  'run_started', 'run_waiting_input', 'run_resumed', 'run_blocked', 'run_requeued',
  'checkpoint_updated', 'run_succeeded', 'run_failed', 'run_cancelled'
]);
const MAX_TTL_SECONDS = 315360000; // 10 years, explicit boundary
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function fail(message) {
  throw new ValidationError(message);
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalNonEmptyString(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return requireNonEmptyString(value, name);
}
/** Strict ISO instant with explicit timezone; returns epoch ms or null (never lenient). */
function parseInstant(text) {
  const match = INSTANT_RE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const ms = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  const tz = match[8];
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  let offsetMinutes = 0;
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const offsetHours = Number(tz.slice(1, 3));
    const offsetMins = Number(tz.slice(4, 6));
    if (offsetHours > 14 || offsetMins > 59 || (offsetHours === 14 && offsetMins > 0)) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
  return Number.isFinite(epoch) ? epoch : null;
}
function optionsNow(value) {
  if (value === undefined || value === null || value === '') {
    const epoch = Date.now();
    return { text: new Date(epoch).toISOString(), epoch };
  }
  const text = requireNonEmptyString(value, 'now');
  const epoch = parseInstant(text);
  if (epoch === null) fail('now must be a strict ISO instant with explicit timezone and a real calendar date');
  return { text: new Date(epoch).toISOString(), epoch };
}
function requireTtl(value) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TTL_SECONDS) {
    fail(`ttlSeconds must be an integer in (0, ${MAX_TTL_SECONDS}]`);
  }
  return value;
}
function requireExpectedToken(input) {
  return requireNonEmptyString(input.expectedToken, 'expectedToken');
}
function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction anymore */ }
    throw error;
  }
}
function assertTransition(from, to) {
  if (!TRANSITIONS[from].includes(to)) throw new ConflictError(`illegal run transition ${from} -> ${to}`);
}
function requireLease(run, owner, expectedToken, nowEpoch) {
  if (run.lease_owner !== owner) throw new ConflictError('lease owner mismatch (stale or different owner)');
  if (run.lease_token === null || run.lease_token !== expectedToken) throw new ConflictError('lease token mismatch (stale lease generation)');
  const expires = run.lease_expires_at ? parseInstant(run.lease_expires_at) : null;
  if (expires === null || expires <= nowEpoch) throw new ConflictError('lease is expired or missing; acquire/reclaim it explicitly');
}
function hydrateRun(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    taskType: row.task_type,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function requireRunRow(db, project, runId) {
  const row = db.prepare('SELECT * FROM runs WHERE project_id = ? AND id = ?').get(project, runId);
  if (!row) throw new NotFoundError('business run not found in this project');
  return row;
}
function appendEvent(db, project, runId, eventType, actor, payload, createdAt) {
  if (!EVENT_TYPES.includes(eventType)) fail(`unknown event type ${eventType}`);
  assertJsonCompatible(payload, 'payload');
  db.prepare(`INSERT INTO run_events (id, project_id, run_id, event_type, actor, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`evt_${crypto.randomUUID()}`, project, runId, eventType, actor ?? null, JSON.stringify(payload), createdAt);
}
function validateCheckpoint(value) {
  assertJsonCompatible(value, 'checkpoint');
  if (!isPlainObject(value)) fail('checkpoint must be a plain JSON object');
  for (const key of ['completedSteps', 'artifactRefs']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) fail(`checkpoint.${key} must be an array`);
    value[key].forEach((entry, index) => requireNonEmptyString(entry, `checkpoint.${key}[${index}]`));
  }
  return value;
}

// ---------- run lifecycle ----------

function createRun(db, projectId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const taskType = requireNonEmptyString(input.taskType, 'taskType');
  const actor = optionalNonEmptyString(input.actor, 'actor');
  const retryOf = optionalNonEmptyString(input.retryOf, 'retryOf');
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    if (retryOf) {
      const parent = db.prepare('SELECT status FROM runs WHERE project_id = ? AND id = ?').get(project, retryOf);
      if (!parent) throw new NotFoundError('retryOf run not found in this project');
      if (!TERMINAL_STATES.includes(parent.status)) {
        fail('retryOf must reference a terminal run; terminal runs are never revived');
      }
    }
    const id = `run_${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO runs (id, project_id, task_type, status, lease_owner, lease_token, lease_expires_at, checkpoint_json, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, ?)`)
      .run(id, project, taskType, now.text, now.text);
    appendEvent(db, project, id, 'run_created', actor, { taskType, retryOf }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function getRun(db, projectId, runId) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const row = db.prepare('SELECT * FROM runs WHERE project_id = ? AND id = ?').get(project, id);
  return row ? hydrateRun(row) : null;
}

function listRuns(db, projectId, filters = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const clauses = ['project_id = ?'];
  const params = [project];
  if (filters.status !== undefined) {
    if (!RUN_STATES.includes(filters.status)) fail(`status must be one of ${RUN_STATES.join(', ')}`);
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.taskType !== undefined) {
    clauses.push('task_type = ?');
    params.push(requireNonEmptyString(filters.taskType, 'taskType'));
  }
  return db.prepare(`SELECT * FROM runs WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`).all(...params).map(hydrateRun);
}

function acquireLease(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const ttlSeconds = requireTtl(input.ttlSeconds);
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    const expiresEpoch = run.lease_expires_at ? parseInstant(run.lease_expires_at) : null;
    const leaseActive = expiresEpoch !== null && expiresEpoch > now.epoch;
    const reclaimable = ['leased', 'running', 'waiting_input'].includes(run.status) && !leaseActive;
    if (run.status !== 'queued' && !reclaimable) {
      throw new ConflictError(`cannot acquire a lease while run is ${run.status}${leaseActive ? ' with an active lease' : ''}`);
    }
    const leaseToken = `lease_${crypto.randomUUID()}`;
    const expiresAt = new Date(now.epoch + ttlSeconds * 1000).toISOString();
    db.prepare('UPDATE runs SET status = ?, lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE project_id = ? AND id = ?')
      .run('leased', owner, leaseToken, expiresAt, now.text, project, id);
    appendEvent(db, project, id, run.status === 'queued' ? 'lease_acquired' : 'lease_reclaimed', owner, {
      previousOwner: run.lease_owner,
      previousExpiresAt: run.lease_expires_at,
      expiresAt,
      ttlSeconds,
      leaseToken
    }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function renewLease(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const ttlSeconds = requireTtl(input.ttlSeconds);
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    if (!['leased', 'running', 'waiting_input'].includes(run.status)) throw new ConflictError(`run is ${run.status}; no lease to renew`);
    requireLease(run, owner, expectedToken, now.epoch);
    const expiresAt = new Date(now.epoch + ttlSeconds * 1000).toISOString();
    db.prepare('UPDATE runs SET lease_expires_at = ?, updated_at = ? WHERE project_id = ? AND id = ?')
      .run(expiresAt, now.text, project, id);
    appendEvent(db, project, id, 'lease_renewed', owner, { expiresAt, ttlSeconds, leaseToken: expectedToken }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function releaseLease(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    if (run.status !== 'leased') throw new ConflictError(`only a leased run can be released (current: ${run.status})`);
    requireLease(run, owner, expectedToken, now.epoch);
    db.prepare('UPDATE runs SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE project_id = ? AND id = ?')
      .run('queued', now.text, project, id);
    appendEvent(db, project, id, 'lease_released', owner, { leaseToken: expectedToken }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function startRun(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    assertTransition(run.status, 'running');
    requireLease(run, owner, expectedToken, now.epoch);
    db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?').run('running', now.text, project, id);
    appendEvent(db, project, id, 'run_started', owner, {}, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function waitForInput(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const reason = optionalNonEmptyString(input.reason, 'reason');
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    assertTransition(run.status, 'waiting_input');
    requireLease(run, owner, expectedToken, now.epoch);
    db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?').run('waiting_input', now.text, project, id);
    appendEvent(db, project, id, 'run_waiting_input', owner, { reason }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function resumeRun(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    assertTransition(run.status, 'running');
    requireLease(run, owner, expectedToken, now.epoch);
    db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?').run('running', now.text, project, id);
    appendEvent(db, project, id, 'run_resumed', owner, {}, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function blockRun(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const reason = requireNonEmptyString(input.reason, 'reason');
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    assertTransition(run.status, 'blocked');
    requireLease(run, owner, expectedToken, now.epoch);
    db.prepare('UPDATE runs SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE project_id = ? AND id = ?')
      .run('blocked', now.text, project, id);
    appendEvent(db, project, id, 'run_blocked', owner, { reason, previousOwner: run.lease_owner, previousExpiresAt: run.lease_expires_at, leaseToken: expectedToken }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function requeueRun(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const reason = optionalNonEmptyString(input.reason, 'reason');
  const actor = optionalNonEmptyString(input.actor, 'actor');
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    if (run.status !== 'blocked') throw new ConflictError(`only a blocked run can be requeued (current: ${run.status})`);
    assertTransition(run.status, 'queued');
    db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?').run('queued', now.text, project, id);
    appendEvent(db, project, id, 'run_requeued', actor, { reason }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function updateCheckpoint(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const checkpoint = validateCheckpoint(input.checkpoint);
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    if (!['leased', 'running', 'waiting_input'].includes(run.status)) {
      throw new ConflictError(`checkpoint requires an active run (current: ${run.status})`);
    }
    requireLease(run, owner, expectedToken, now.epoch);
    const text = JSON.stringify(checkpoint);
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    db.prepare('UPDATE runs SET checkpoint_json = ?, updated_at = ? WHERE project_id = ? AND id = ?')
      .run(text, now.text, project, id);
    appendEvent(db, project, id, 'checkpoint_updated', owner, {
      stepCount: Array.isArray(checkpoint.completedSteps) ? checkpoint.completedSteps.length : 0,
      artifactCount: Array.isArray(checkpoint.artifactRefs) ? checkpoint.artifactRefs.length : 0,
      sha256: sha
    }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function completeRun(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const owner = requireNonEmptyString(input.owner, 'owner');
  const expectedToken = requireExpectedToken(input);
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    assertTransition(run.status, 'succeeded');
    requireLease(run, owner, expectedToken, now.epoch);
    db.prepare('UPDATE runs SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE project_id = ? AND id = ?')
      .run('succeeded', now.text, project, id);
    appendEvent(db, project, id, 'run_succeeded', owner, {}, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function failRun(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const reason = requireNonEmptyString(input.reason, 'reason');
  const owner = optionalNonEmptyString(input.owner, 'owner');
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    assertTransition(run.status, 'failed');
    if (run.status !== 'blocked') {
      requireLease(run, requireNonEmptyString(owner, 'owner'), requireExpectedToken(input), now.epoch);
    }
    db.prepare('UPDATE runs SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE project_id = ? AND id = ?')
      .run('failed', now.text, project, id);
    appendEvent(db, project, id, 'run_failed', owner, { reason }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function cancelRun(db, projectId, runId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  const reason = optionalNonEmptyString(input.reason, 'reason');
  const owner = optionalNonEmptyString(input.owner, 'owner');
  const now = optionsNow(input.now);
  return withTransaction(db, () => {
    const run = requireRunRow(db, project, id);
    assertTransition(run.status, 'cancelled');
    if (['leased', 'running', 'waiting_input'].includes(run.status)) {
      requireLease(run, requireNonEmptyString(owner, 'owner'), requireExpectedToken(input), now.epoch);
    }
    db.prepare('UPDATE runs SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE project_id = ? AND id = ?')
      .run('cancelled', now.text, project, id);
    appendEvent(db, project, id, 'run_cancelled', owner, { reason }, now.text);
    return hydrateRun(requireRunRow(db, project, id));
  });
}

function listEvents(db, projectId, runId) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(runId, 'runId');
  requireRunRow(db, project, id);
  return db.prepare('SELECT * FROM run_events WHERE project_id = ? AND run_id = ? ORDER BY created_at, rowid').all(project, id)
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      eventType: row.event_type,
      actor: row.actor,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      createdAt: row.created_at
    }));
}

module.exports = {
  RUN_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  EVENT_TYPES,
  MAX_TTL_SECONDS,
  createRun,
  getRun,
  listRuns,
  acquireLease,
  renewLease,
  releaseLease,
  startRun,
  waitForInput,
  resumeRun,
  blockRun,
  requeueRun,
  updateCheckpoint,
  completeRun,
  failRun,
  cancelRun,
  listEvents
};
