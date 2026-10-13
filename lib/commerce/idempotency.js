'use strict';
/**
 * Idempotency, cache keys and uncertain-result reconciliation (T2.3 revision-01). Local synthetic
 * fixtures only — no provider calls, no fees, no HTTP, no real business data. See the frozen
 * interface table at [P]\runtime\runs\IDEMPOTENCY-INTERFACE-REV01.md.
 *
 * Frozen semantics (revision-01):
 * - Cache key: canonical, typed material over taskId/inputHash/tool/toolVersion/model/
 *   promptVersion/templateVersion/policy/project/brand/market/locale/shipTo/ttlMs. Missing
 *   dimensions are explicit ValidationErrors; `project`/`brand` accept an explicit null that is a
 *   distinct value, never a wildcard.
 * - Observation freshness is fail-closed (F3): every entry declares `factKind` — `fact` REQUIRES
 *   `observedAt` (an observation instant is never synthesized from the write clock) and persists
 *   its observation window (`observationTtlMs`, default ttlMs, never longer than ttlMs);
 *   `generated` entries explicitly carry no fact observation and are never a current price fact.
 *   Lookup freshness for facts uses the PERSISTED observation window — a caller may only tighten
 *   it with `maxObservationAgeMs`, never omit or relax it into fresh; missing/legacy observations
 *   and future observations are non-fresh; endpoint comparisons are real millisecond instants.
 * - Charged operation id: a STABLE logical operation id, separate from the cache key and from
 *   attempt numbers. Every execute permission is a single-use, transactionally reserved attempt
 *   generation (F1): `claimOperation` mints a fresh `attemptToken` for a new operation or an
 *   atomic retry reservation (`retry_reserved`, attempts < maxAttempts), and a second caller /
 *   second connection / reopened process is never told to execute again. `markSubmitted`,
 *   `markTimeout` and `reconcileOperation` require the CURRENT attemptToken: a missing token is a
 *   ValidationError, a stale generation a ConflictError with zero writes — a late response from an
 *   older attempt can never change a newer attempt's state. The reservation is persisted before
 *   the effect; a lost caller leaves an uncertain `claimed` row that an explicit trusted recovery
 *   (`adoptWorkerReference`) turns into `pending_reconcile` for querying — never a re-grant. The
 *   grant itself CONSUMES one bounded attempt (attempts+1, generation+1, an attempt row with
 *   outcome 'started' persisted at reservation time; markSubmitted does not double count), so the
 *   reserve->effect-crash->recover->not_submitted loop can never exceed maxAttempts. Recovery of
 *   an existing token-bound operation must present the CURRENT attemptToken (missing/stale =>
 *   zero writes); new imports and legacy NULL-token rows use explicit separate policies. Each
 *   attempt's remote reference is traceable via its attempt row note (a stable operation id does
 *   not mean the remote request id repeats).
 * - Capability grading stays explicit (supported/unsupported/unknown); nothing auto-resends a
 *   charged call on timeout — timeout/network-unknown becomes `pending_reconcile` with the remote
 *   id retained and a structured pending-cost placeholder.
 * - Reconciliation (F2): cancellation intent is separated from remote results — a cancelled
 *   operation can never execute again, but late queries may still confirm charged/effective/
 *   not-submitted outcomes (recorded on the row and in `reconcile_events`). `not_submitted`
 *   requires explicit evidence; `unknown` stays pending/manual; `effective` is terminal for
 *   pending rows and recorded as a late result for cancelled rows. Every query/evidence/decision/
 *   attempt identity is persisted in the SAME transaction as the state change; the JSON reconcile
 *   log is export/observation only, never the safety record. Adopting an existing claimed/
 *   submitted reference persists `pending_reconcile` + the remote binding; conflicting remote
 *   references fail closed; terminal rows never fake pending. A confirmed effective outcome is
 *   MONOTONIC: late negative/unknown queries are recorded audit-only (`no_downgrade`) and never
 *   overwrite the confirmed result/reference. Retry-eligible `confirmed_not_submitted` rows CAN
 *   be cancelled (permanently suppressing execution/retry); cancelling merges `cancelIntent` into
 *   any existing structured pending-cost placeholder.
 * - Legacy rows (0006-era, NULL token/fact_kind) are never backfilled: writes on them fail
 *   closed, their cache entries are non-fresh, and only the explicit adopt recovery path can mint
 *   a recovery identity.
 * - Limits: local engineering fixture — not authentication, not a provider exactly-once proof,
 *   not a budget engine (caps belong to T2.4). Someone with filesystem access to the local DB is
 *   out of scope.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ValidationError, ConflictError, NotFoundError } = require('./evidence.js');
const { assertJsonCompatible } = require('./privacy.js');
const { canonicalJson } = require('./packs.js');

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const CAPABILITIES = Object.freeze(['supported', 'unsupported', 'unknown']);
const OPERATION_STATES = Object.freeze(['claimed', 'submitted', 'pending_reconcile', 'confirmed_effective', 'confirmed_not_submitted', 'cancelled']);
const RECONCILE_QUERIES = Object.freeze(['effective', 'not_submitted', 'unknown']);
const TIMEOUT_KINDS = Object.freeze(['timeout', 'network_unknown']);
const FACT_KINDS = Object.freeze(['fact', 'generated']);

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
/** Opaque remote reference: exact value preserved (no trim/regex/delimiter damage), empty rejected. */
function optionalOpaqueRemoteId(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(`${name} must be a string`);
  if (value.trim() === '') fail(`${name} must not be empty`);
  return value;
}
function requirePositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
/** Strict ISO instant with explicit timezone; returns epoch ms or null (never lenient). */
function parseInstant(text) {
  const match = INSTANT_RE.exec(String(text));
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
function requireInstant(value, name) {
  const epoch = parseInstant(value);
  if (epoch === null) fail(`${name} must be a strict ISO instant with an explicit timezone and a real calendar date`);
  return { text: new Date(epoch).toISOString(), epoch };
}
function optionsNow(value) {
  if (value === undefined || value === null || value === '') {
    const epoch = Date.now();
    return { text: new Date(epoch).toISOString(), epoch };
  }
  return requireInstant(value, 'now');
}
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function mintAttemptToken() {
  return `attempt_${crypto.randomUUID()}`;
}
function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch { /* no active transaction */ }
    throw error;
  }
}

// ---------- canonical key material ----------

function stringDim(input, name) {
  if (!Object.prototype.hasOwnProperty.call(input, name) || input[name] === undefined) fail(`cache dimension ${name} must be provided as a non-empty string`);
  return { t: 'string', v: requireNonEmptyString(input[name], `cache dimension ${name}`) };
}
function nullableStringDim(input, name) {
  if (!Object.prototype.hasOwnProperty.call(input, name) || input[name] === undefined) fail(`cache dimension ${name} must be provided (a string or an explicit null; null is never a wildcard)`);
  if (input[name] === null) return { t: 'null' };
  return { t: 'string', v: requireNonEmptyString(input[name], `cache dimension ${name}`) };
}
function hashDim(input, name) {
  const text = stringDim(input, name).v;
  if (!SHA256_RE.test(text)) fail(`cache dimension ${name} must be a 64-character hex digest`);
  return { t: 'string', v: text };
}
function ttlDim(input, name) {
  if (!Object.prototype.hasOwnProperty.call(input, name) || input[name] === undefined) fail(`cache dimension ${name} must be provided as a positive integer`);
  return { t: 'integer', v: requirePositiveInt(input[name], `cache dimension ${name}`) };
}
function canonicalKeyMaterial(input) {
  if (!isPlainObject(input)) fail('cache input must be a plain object');
  return {
    taskId: stringDim(input, 'taskId'),
    inputHash: hashDim(input, 'inputHash'),
    tool: stringDim(input, 'tool'),
    toolVersion: stringDim(input, 'toolVersion'),
    model: stringDim(input, 'model'),
    promptVersion: stringDim(input, 'promptVersion'),
    templateVersion: stringDim(input, 'templateVersion'),
    policy: stringDim(input, 'policy'),
    project: nullableStringDim(input, 'project'),
    brand: nullableStringDim(input, 'brand'),
    market: stringDim(input, 'market'),
    locale: stringDim(input, 'locale'),
    shipTo: stringDim(input, 'shipTo'),
    ttlMs: ttlDim(input, 'ttlMs')
  };
}
function cacheKeyFor(input) {
  return sha256Hex(canonicalJson(canonicalKeyMaterial(input)));
}
function canonicalScopeMaterial(scope) {
  if (!isPlainObject(scope)) fail('operation scope must be a plain object');
  return {
    taskId: stringDim(scope, 'taskId'),
    inputHash: hashDim(scope, 'inputHash'),
    tool: stringDim(scope, 'tool'),
    toolVersion: stringDim(scope, 'toolVersion'),
    model: stringDim(scope, 'model'),
    promptVersion: stringDim(scope, 'promptVersion'),
    templateVersion: stringDim(scope, 'templateVersion'),
    policy: stringDim(scope, 'policy'),
    project: nullableStringDim(scope, 'project'),
    brand: nullableStringDim(scope, 'brand'),
    market: stringDim(scope, 'market'),
    locale: stringDim(scope, 'locale'),
    shipTo: stringDim(scope, 'shipTo')
  };
}
function scopeHashFor(scope) {
  return sha256Hex(canonicalJson(canonicalScopeMaterial(scope)));
}

// ---------- cache entries (F3) ----------

function hydrateCacheRow(row) {
  return {
    cacheKey: row.cache_key,
    projectId: row.project_id,
    brand: row.brand,
    value: JSON.parse(row.value_json),
    factKind: row.fact_kind ?? null,
    observedAt: row.observed_at,
    observationTtlMs: row.observation_ttl_ms ?? null,
    observationExpiresAt: row.observation_expires_at ?? null,
    writtenAt: row.written_at,
    ttlMs: row.ttl_ms,
    expiresAt: row.expires_at
  };
}
function putCache(db, input, options = {}) {
  const material = canonicalKeyMaterial(input);
  const cacheKey = sha256Hex(canonicalJson(material));
  if (!Object.prototype.hasOwnProperty.call(options, 'value')) fail('putCache requires a value');
  assertJsonCompatible(options.value, 'value');
  const factKind = requireNonEmptyString(options.factKind, 'factKind');
  if (!FACT_KINDS.includes(factKind)) fail(`factKind must be one of ${FACT_KINDS.join(', ')} (explicit; observation instants are never synthesized)`);
  const written = optionsNow(options.now);
  let observedAt = null;
  let observationTtlMs = null;
  let observationExpiresAt = null;
  if (factKind === 'fact') {
    if (options.observedAt === undefined || options.observedAt === null) {
      fail('fact entries require observedAt: the observation instant cannot be synthesized from the write clock');
    }
    const observed = requireInstant(options.observedAt, 'observedAt');
    observationTtlMs = options.observationTtlMs === undefined
      ? material.ttlMs.v
      : requirePositiveInt(options.observationTtlMs, 'observationTtlMs');
    if (observationTtlMs > material.ttlMs.v) fail('observationTtlMs must not exceed ttlMs (the observation window cannot outlive the cache entry)');
    observedAt = observed.text;
    observationExpiresAt = new Date(observed.epoch + observationTtlMs).toISOString();
  } else {
    if (options.observedAt !== undefined && options.observedAt !== null) fail('generated entries must not carry a fact observation (observedAt); they are never a current price fact');
    if (options.observationTtlMs !== undefined) fail('generated entries do not carry an observation window');
  }
  const expiresAt = new Date(written.epoch + material.ttlMs.v).toISOString();
  db.prepare(`INSERT INTO cache_entries (cache_key, project_id, brand, key_json, value_json, observed_at, written_at, ttl_ms, expires_at, created_at, updated_at, fact_kind, observation_ttl_ms, observation_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json, observed_at = excluded.observed_at, written_at = excluded.written_at, ttl_ms = excluded.ttl_ms, expires_at = excluded.expires_at, updated_at = excluded.updated_at, fact_kind = excluded.fact_kind, observation_ttl_ms = excluded.observation_ttl_ms, observation_expires_at = excluded.observation_expires_at`)
    .run(cacheKey, material.project.t === 'null' ? null : material.project.v, material.brand.t === 'null' ? null : material.brand.v, JSON.stringify(material), JSON.stringify(options.value), observedAt ?? written.text, written.text, material.ttlMs.v, expiresAt, written.text, written.text, factKind, observationTtlMs, observationExpiresAt);
  return hydrateCacheRow(db.prepare('SELECT * FROM cache_entries WHERE cache_key = ?').get(cacheKey));
}
function lookupCache(db, input, options = {}) {
  const material = canonicalKeyMaterial(input);
  const cacheKey = sha256Hex(canonicalJson(material));
  const row = db.prepare('SELECT * FROM cache_entries WHERE cache_key = ?').get(cacheKey);
  if (!row) return { status: 'miss', cacheKey };
  const now = optionsNow(options.now);
  const entry = hydrateCacheRow(row);
  const expiresEpoch = parseInstant(row.expires_at);
  if (now.epoch >= expiresEpoch) return { status: 'stale', reason: 'ttl_expired', cacheKey, ...entry };
  if (row.fact_kind === null || row.fact_kind === undefined) {
    return { status: 'stale', reason: 'legacy_unknown_observation', cacheKey, ...entry };
  }
  if (row.fact_kind === 'generated') {
    return { status: 'fresh', cacheKey, ...entry };
  }
  const observedEpoch = parseInstant(row.observed_at);
  if (!(now.epoch >= observedEpoch)) {
    return { status: 'stale', reason: 'observation_in_future', cacheKey, ...entry };
  }
  let window = row.observation_ttl_ms;
  if (window === null || window === undefined) {
    return { status: 'stale', reason: 'legacy_unknown_observation', cacheKey, ...entry };
  }
  if (options.maxObservationAgeMs !== undefined) {
    const maxAge = requirePositiveInt(options.maxObservationAgeMs, 'maxObservationAgeMs');
    window = Math.min(window, maxAge); // a caller may only TIGHTEN the persisted policy
  }
  if (now.epoch - observedEpoch >= window) {
    return { status: 'stale', reason: 'observation_expired', cacheKey, ...entry };
  }
  return { status: 'fresh', cacheKey, ...entry };
}

// ---------- charged operations (F1/F2) ----------

function requireCapability(value) {
  const capability = requireNonEmptyString(value, 'capability');
  if (!CAPABILITIES.includes(capability)) fail(`capability must be one of ${CAPABILITIES.join(', ')}`);
  return capability;
}
function selectOperation(db, operationId) {
  return db.prepare('SELECT * FROM idempotent_operations WHERE operation_id = ?').get(operationId);
}
function hydrateOperation(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    scopeHash: row.scope_hash,
    scope: JSON.parse(row.scope_json),
    capability: row.capability,
    state: row.state,
    remoteId: row.remote_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    attemptToken: row.attempt_token ?? null,
    generation: row.generation ?? null,
    pendingCost: row.pending_cost_json ? JSON.parse(row.pending_cost_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    reconcileState: row.reconcile_state ?? null,
    reconcileAt: row.reconcile_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    source: row.source ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function getOperation(db, operationId) {
  return hydrateOperation(selectOperation(db, requireNonEmptyString(operationId, 'operationId')));
}
function pendingCostFor(remoteId, extra = {}) {
  return {
    status: 'pending_reconcile',
    remoteId: remoteId ?? null,
    note: 'cost/result reconciliation pending; cap reservation belongs to T2.4',
    ...extra
  };
}
function requireCurrentToken(row, attemptToken) {
  if (!attemptToken) {
    throw new ValidationError('attemptToken is required: reserve an execute permission via claimOperation before writing');
  }
  if (row.attempt_token === null || row.attempt_token === undefined) {
    throw new ConflictError('operation has no attempt token (legacy row); use adoptWorkerReference recovery before writing');
  }
  if (row.attempt_token !== attemptToken) {
    throw new ConflictError('attempt token mismatch (stale attempt generation); refusing with zero writes');
  }
}
/**
 * Transactional claim / retry reservation: the ONLY path that grants an execute permission.
 * A second caller, a second connection or a reopened process sees the persisted reservation and
 * is never told to execute again.
 */
function claimOperation(db, options = {}) {
  const operationId = requireNonEmptyString(options.operationId, 'operationId');
  const capability = requireCapability(options.capability);
  const scopeMaterial = canonicalScopeMaterial(options.scope);
  const scopeHash = sha256Hex(canonicalJson(scopeMaterial));
  const now = optionsNow(options.now);
  const maxAttempts = options.maxAttempts === undefined ? 3 : requirePositiveInt(options.maxAttempts, 'maxAttempts');
  return withTransaction(db, () => {
    const row = selectOperation(db, operationId);
    if (!row) {
      const token = mintAttemptToken();
      db.prepare(`INSERT INTO idempotent_operations (operation_id, scope_hash, scope_json, project_id, brand, capability, state, attempts, max_attempts, attempt_token, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'claimed', 1, ?, ?, 1, ?, ?)`)
        .run(operationId, scopeHash, JSON.stringify(scopeMaterial), scopeMaterial.project.t === 'null' ? null : scopeMaterial.project.v, scopeMaterial.brand.t === 'null' ? null : scopeMaterial.brand.v, capability, maxAttempts, token, now.text, now.text);
      // the execute permission consumes the first bounded attempt immediately
      db.prepare('INSERT INTO operation_attempts (operation_id, attempt_no, outcome, started_at, note, generation, attempt_token) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(operationId, 1, 'started', now.text, 'reserved generation 1', 1, token);
      return { decision: 'execute', operation: hydrateOperation(selectOperation(db, operationId)) };
    }
    if (row.scope_hash !== scopeHash) {
      throw new ConflictError(`operation ${operationId} is already bound to a different input/version/scope; refusing`);
    }
    if (row.state === 'claimed') {
      return { decision: 'in_progress', operation: hydrateOperation(row) };
    }
    if (row.state === 'submitted' || row.state === 'pending_reconcile') {
      return { decision: 'pending_reconcile', operation: hydrateOperation(row) };
    }
    if (row.state === 'confirmed_effective') {
      return { decision: 'already_effective', operation: hydrateOperation(row) };
    }
    if (row.state === 'confirmed_not_submitted') {
      if (row.attempts < row.max_attempts) {
        const token = mintAttemptToken();
        const generation = (row.generation ?? row.attempts) + 1;
        const attempts = row.attempts + 1;
        db.prepare('UPDATE idempotent_operations SET state = ?, attempt_token = ?, generation = ?, attempts = ?, remote_id = NULL, updated_at = ? WHERE operation_id = ?')
          .run('claimed', token, generation, attempts, now.text, operationId);
        // the retry reservation consumes the next bounded attempt immediately
        db.prepare('INSERT INTO operation_attempts (operation_id, attempt_no, outcome, started_at, note, generation, attempt_token) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(operationId, attempts, 'started', now.text, `reserved generation ${generation}`, generation, token);
        return { decision: 'retry_reserved', operation: hydrateOperation(selectOperation(db, operationId)) };
      }
      return { decision: 'retry_exhausted', operation: hydrateOperation(row) };
    }
    if (row.state === 'cancelled') {
      return { decision: 'cancelled', operation: hydrateOperation(row) };
    }
    throw new Error(`unknown operation state ${row.state}`);
  });
}
function markSubmitted(db, operationId, options = {}) {
  const id = requireNonEmptyString(operationId, 'operationId');
  const now = optionsNow(options.now);
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const attemptToken = optionalNonEmptyString(options.attemptToken, 'attemptToken');
  return withTransaction(db, () => {
    const row = selectOperation(db, id);
    if (!row) throw new NotFoundError('operation not found; claim it first');
    requireCurrentToken(row, attemptToken);
    if (row.state !== 'claimed') throw new ConflictError(`cannot submit from state ${row.state}`);
    // structured per-attempt binding (F1-rev03): the current attempt's remote_id column is the
    // only authority; a new generation never falls back to the previous generation's remote.
    const boundRemote = bindAttemptRemote(db, row, remoteId, { now, attemptToken });
    db.prepare('UPDATE idempotent_operations SET state = ?, remote_id = ?, updated_at = ? WHERE operation_id = ?')
      .run('submitted', boundRemote, now.text, id);
    // the attempt row was persisted at reservation; markSubmitted only records bookkeeping —
    // the bounded attempt allowance is not double counted and notes are never identity authority.
    const note = options.note !== undefined && options.note !== null && options.note !== ''
      ? `${requireNonEmptyString(options.note, 'note')}; submitted generation ${row.generation ?? 'unknown'}`
      : `submitted generation ${row.generation ?? 'unknown'}`;
    db.prepare('UPDATE operation_attempts SET note = ? WHERE operation_id = ? AND attempt_no = ?')
      .run(note, id, row.attempts);
    return hydrateOperation(selectOperation(db, id));
  });
}
function markTimeout(db, operationId, options = {}) {
  const id = requireNonEmptyString(operationId, 'operationId');
  const kind = requireNonEmptyString(options.kind ?? 'timeout', 'kind');
  if (!TIMEOUT_KINDS.includes(kind)) fail(`kind must be one of ${TIMEOUT_KINDS.join(', ')}`);
  const now = optionsNow(options.now);
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const attemptToken = optionalNonEmptyString(options.attemptToken, 'attemptToken');
  return withTransaction(db, () => {
    const row = selectOperation(db, id);
    if (!row) throw new NotFoundError('operation not found');
    requireCurrentToken(row, attemptToken);
    if (row.state !== 'submitted') throw new ConflictError(`cannot mark a timeout from state ${row.state}`);
    // the timeout remote reference goes through the SAME structured per-attempt binding
    const boundRemote = bindAttemptRemote(db, row, remoteId, { now, attemptToken });
    // a fresh placeholder for THIS attempt (never a stale previous-generation reference)
    const pendingCost = JSON.stringify(pendingCostFor(boundRemote));
    db.prepare('UPDATE idempotent_operations SET state = ?, remote_id = ?, pending_cost_json = ?, updated_at = ? WHERE operation_id = ?')
      .run('pending_reconcile', boundRemote, pendingCost, now.text, id);
    // the diagnostic note may be overridden but is never identity authority
    if (options.note !== undefined && options.note !== null && options.note !== '') {
      db.prepare('UPDATE operation_attempts SET outcome = ?, ended_at = ?, note = ? WHERE operation_id = ? AND attempt_no = ?')
        .run(kind, now.text, requireNonEmptyString(options.note, 'note'), id, row.attempts);
    } else {
      db.prepare('UPDATE operation_attempts SET outcome = ?, ended_at = ? WHERE operation_id = ? AND attempt_no = ?')
        .run(kind, now.text, id, row.attempts);
    }
    return hydrateOperation(selectOperation(db, id));
  });
}
/**
 * Synthetic reconciliation. Queries are allowed from pending_reconcile and from cancelled
 * (late charge/effective/not-submitted confirmation) — never a resend. Every query/evidence/
 * decision/attempt identity is persisted in the SAME transaction as the state change.
 */
function reconcileOperation(db, operationId, options = {}) {
  const id = requireNonEmptyString(operationId, 'operationId');
  const query = requireNonEmptyString(options.query, 'query');
  if (!RECONCILE_QUERIES.includes(query)) fail(`query must be one of ${RECONCILE_QUERIES.join(', ')}`);
  const now = optionsNow(options.now);
  const evidence = optionalNonEmptyString(options.evidence, 'evidence');
  const attemptToken = optionalNonEmptyString(options.attemptToken, 'attemptToken');
  return withTransaction(db, () => {
    const row = selectOperation(db, id);
    if (!row) throw new NotFoundError('operation not found');
    requireCurrentToken(row, attemptToken);
    if (row.state !== 'pending_reconcile' && row.state !== 'cancelled') {
      throw new ConflictError(`cannot reconcile from state ${row.state}`);
    }
    const stateBefore = row.state;
    // F2-rev02: a confirmed effective outcome is MONOTONIC — a late negative/unknown query is
    // recorded audit-only (no_downgrade) and never overwrites the confirmed result/reference.
    if (row.reconcile_state === 'effective') {
      const decision = query === 'effective' ? 'no_retry' : 'no_downgrade';
      db.prepare(`INSERT INTO reconcile_events (operation_id, attempt_token, generation, attempt_no, query, evidence, decision, state_before, state_after, remote_id, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, row.attempt_token ?? null, row.generation ?? null, row.attempts, query, evidence, decision, stateBefore, stateBefore, row.remote_id ?? null, row.result_json, now.text);
      return { decision, state: stateBefore, reconcileState: 'effective', operation: hydrateOperation(selectOperation(db, id)) };
    }
    let stateAfter = stateBefore;
    let decision;
    let reconcileState;
    let resultJson = row.result_json;
    if (query === 'unknown') {
      decision = 'manual';
      reconcileState = 'unknown';
    } else if (query === 'effective') {
      if (options.result !== undefined) {
        assertJsonCompatible(options.result, 'result');
        resultJson = JSON.stringify(options.result);
      }
      reconcileState = 'effective';
      if (stateBefore === 'pending_reconcile') stateAfter = 'confirmed_effective';
      decision = 'no_retry';
    } else {
      if (!evidence) {
        throw new ValidationError('refusing to mark not_submitted without explicit evidence; unknown results stay pending/manual (never guess not_charged)');
      }
      reconcileState = 'not_submitted';
      if (stateBefore === 'pending_reconcile') {
        stateAfter = 'confirmed_not_submitted';
        decision = row.attempts < row.max_attempts ? 'retry_allowed' : 'retry_exhausted';
      } else {
        decision = 'no_retry'; // cancelled: the late result is recorded, execution stays forbidden
      }
    }
    db.prepare('UPDATE idempotent_operations SET state = ?, reconcile_state = ?, reconcile_at = ?, result_json = ?, updated_at = ? WHERE operation_id = ?')
      .run(stateAfter, reconcileState, now.text, resultJson, now.text, id);
    db.prepare(`INSERT INTO reconcile_events (operation_id, attempt_token, generation, attempt_no, query, evidence, decision, state_before, state_after, remote_id, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, row.attempt_token ?? null, row.generation ?? null, row.attempts, query, evidence, decision, stateBefore, stateAfter, row.remote_id ?? null, resultJson, now.text);
    return { decision, state: stateAfter, reconcileState, operation: hydrateOperation(selectOperation(db, id)) };
  });
}
/** Cancel: forbids execution forever, but keeps late reconciliation possible; refund never guaranteed. */
function cancelOperation(db, operationId, options = {}) {
  const id = requireNonEmptyString(operationId, 'operationId');
  const now = optionsNow(options.now);
  const reason = optionalNonEmptyString(options.reason, 'reason');
  return withTransaction(db, () => {
    const row = selectOperation(db, id);
    if (!row) throw new NotFoundError('operation not found');
    if (row.state === 'confirmed_effective') {
      throw new ConflictError('cannot cancel a confirmed effective operation');
    }
    if (row.state === 'cancelled') return { decision: 'cancelled', operation: hydrateOperation(row) };
    const cancelReason = `cancel requested: ${reason ?? 'unspecified'}; remoteId=${row.remote_id ?? 'none'} retained; pending cost/result retained; refund not guaranteed`;
    // F2-rev02: merge the cancellation intent into any existing structured pending-cost placeholder
    // (e.g. one created by markTimeout) instead of only flagging newly created placeholders.
    const existingCost = row.pending_cost_json ? JSON.parse(row.pending_cost_json) : pendingCostFor(row.remote_id);
    const pendingCost = JSON.stringify({
      ...existingCost,
      cancelIntent: true,
      reason: existingCost.reason ?? 'cancelled_before_result',
      note: 'late charge/result reconciliation allowed; refund not guaranteed; cap reservation belongs to T2.4'
    });
    db.prepare('UPDATE idempotent_operations SET state = ?, cancel_reason = ?, pending_cost_json = ?, updated_at = ? WHERE operation_id = ?')
      .run('cancelled', cancelReason, pendingCost, now.text, id);
    return { decision: 'cancelled', operation: hydrateOperation(selectOperation(db, id)) };
  });
}
/**
 * Structured per-attempt remote identity (F1-rev03). The attempt row's `remote_id` column is the
 * ONLY authority — free-text notes are never parsed; opaque values are preserved exactly and
 * compared with ===. Same attempt: re-binding the same value is a no-op, a different non-null
 * value is a ConflictError with zero writes (checked before any write); null (unknown) may bind
 * once. A NEW attempt may bind its own remote; previous attempts keep their structured references.
 */
function bindAttemptRemote(db, row, remoteId, options = {}) {
  const attemptRow = db.prepare('SELECT attempt_no, remote_id FROM operation_attempts WHERE operation_id = ? AND attempt_no = ?').get(row.operation_id, row.attempts);
  if (!attemptRow) {
    // legacy/import rows without an attempt ledger entry: create the structured home now
    const startedAt = options.now ? options.now.text : new Date().toISOString();
    db.prepare('INSERT INTO operation_attempts (operation_id, attempt_no, outcome, started_at, note, generation, attempt_token, remote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.operation_id, row.attempts, 'started', startedAt, 'recovery import', row.generation ?? null, row.attempt_token ?? options.attemptToken ?? null, remoteId);
    return remoteId;
  }
  if (remoteId === null) return attemptRow.remote_id ?? null;
  if (attemptRow.remote_id !== null && attemptRow.remote_id !== undefined) {
    if (attemptRow.remote_id !== remoteId) {
      throw new ConflictError(`operation ${row.operation_id} already has a different remote reference for the current attempt; refusing to overwrite (conflicting reference)`);
    }
    return remoteId;
  }
  db.prepare('UPDATE operation_attempts SET remote_id = ? WHERE operation_id = ? AND attempt_no = ?')
    .run(remoteId, row.operation_id, row.attempts);
  return remoteId;
}
/**
 * Trusted recovery/adopt of a real worker crash/cancel reference. Existing claimed/submitted
 * rows are persisted as pending_reconcile with the remote binding; terminal rows never fake
 * pending; conflicting remote references fail closed; legacy NULL-token rows get a recovery
 * identity (never a verified backfill).
 */
function adoptWorkerReference(db, options = {}) {
  const operationId = requireNonEmptyString(options.operationId, 'operationId');
  const capability = requireCapability(options.capability ?? 'unknown');
  const scopeMaterial = canonicalScopeMaterial(options.scope);
  const scopeHash = sha256Hex(canonicalJson(scopeMaterial));
  const now = optionsNow(options.now);
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const source = optionalNonEmptyString(options.source, 'source') ?? 'worker_effect';
  const committed = options.committed === true;
  const attemptToken = optionalNonEmptyString(options.attemptToken, 'attemptToken');
  return withTransaction(db, () => {
    const row = selectOperation(db, operationId);
    if (!row) {
      const token = mintAttemptToken();
      const pendingCost = JSON.stringify({ ...pendingCostFor(remoteId), committed, source });
      db.prepare(`INSERT INTO idempotent_operations (operation_id, scope_hash, scope_json, project_id, brand, capability, state, remote_id, attempts, max_attempts, attempt_token, generation, pending_cost_json, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending_reconcile', ?, 1, 3, ?, 1, ?, ?, ?, ?)`)
        .run(operationId, scopeHash, JSON.stringify(scopeMaterial), scopeMaterial.project.t === 'null' ? null : scopeMaterial.project.v, scopeMaterial.brand.t === 'null' ? null : scopeMaterial.brand.v, capability, remoteId, token, pendingCost, source, now.text, now.text);
      // structured per-attempt home for the imported reference (F1-rev03): repeated adopts are
      // fenced by the attempt row's remote_id, never allowed to replace it silently.
      db.prepare('INSERT INTO operation_attempts (operation_id, attempt_no, outcome, started_at, note, generation, attempt_token, remote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(operationId, 1, 'started', now.text, `imported ${source}`, 1, token, remoteId);
      return { decision: 'pending_reconcile', operation: hydrateOperation(selectOperation(db, operationId)) };
    }
    if (row.scope_hash !== scopeHash) {
      throw new ConflictError(`operation ${operationId} is already bound to a different input/version/scope; refusing`);
    }
    // F1-rev02 recovery identity fence: an existing TOKEN-BOUND operation may only be recovered by
    // a caller presenting the CURRENT attemptToken (missing/stale => operation/attempt/events zero
    // writes). New imports (no row) and legacy NULL-token rows use explicit separate policies.
    if (row.attempt_token !== null && row.attempt_token !== undefined) {
      if (!attemptToken) throw new ValidationError('attemptToken is required: recovery of an existing token-bound operation must present the current attempt identity');
      if (row.attempt_token !== attemptToken) throw new ConflictError('attempt token mismatch (stale attempt generation); recovery refused with zero writes');
    }
    if (row.state === 'claimed' || row.state === 'submitted' || row.state === 'pending_reconcile') {
      const token = row.attempt_token ?? mintAttemptToken();
      const generation = row.generation ?? (row.attempts > 0 ? row.attempts : 1);
      // structured per-attempt binding through the SAME predicate used by submit/timeout
      const boundRemote = bindAttemptRemote(db, row, remoteId, { now, attemptToken: token });
      const pendingCost = row.pending_cost_json ?? JSON.stringify({ ...pendingCostFor(boundRemote), committed, source });
      db.prepare('UPDATE idempotent_operations SET state = ?, remote_id = ?, attempt_token = ?, generation = ?, pending_cost_json = ?, updated_at = ? WHERE operation_id = ?')
        .run('pending_reconcile', boundRemote, token, generation, pendingCost, now.text, operationId);
      return { decision: 'pending_reconcile', operation: hydrateOperation(selectOperation(db, operationId)) };
    }
    if (row.state === 'cancelled') {
      const token = row.attempt_token ?? mintAttemptToken();
      const generation = row.generation ?? (row.attempts > 0 ? row.attempts : 1);
      const boundRemote = bindAttemptRemote(db, row, remoteId, { now, attemptToken: token });
      const pendingCost = row.pending_cost_json ?? JSON.stringify({ ...pendingCostFor(boundRemote), committed, source });
      db.prepare('UPDATE idempotent_operations SET remote_id = ?, attempt_token = ?, generation = ?, pending_cost_json = ?, updated_at = ? WHERE operation_id = ?')
        .run(boundRemote, token, generation, pendingCost, now.text, operationId);
      return { decision: 'cancelled', operation: hydrateOperation(selectOperation(db, operationId)) };
    }
    // terminal rows never fake pending; the remote still binds through the structured predicate
    const boundRemote = bindAttemptRemote(db, row, remoteId, { now, attemptToken: row.attempt_token ?? undefined });
    if (boundRemote !== (row.remote_id ?? null)) {
      db.prepare('UPDATE idempotent_operations SET remote_id = ?, updated_at = ? WHERE operation_id = ?')
        .run(boundRemote, now.text, operationId);
    }
    return {
      decision: row.state === 'confirmed_effective' ? 'already_effective' : 'confirmed_not_submitted',
      operation: hydrateOperation(selectOperation(db, operationId))
    };
  });
}
function describeCapability(level) {
  const capability = requireCapability(level);
  return {
    level: capability,
    exactlyOnce: capability === 'supported',
    autoResendOnTimeout: false,
    note: capability === 'supported'
      ? 'provider-declared supported; the worker still never auto-resends a charged call on timeout'
      : 'no exactly-once claim; timeout/network-unknown stays pending_reconcile for reconciliation'
  };
}

// ---------- reconciliation log (P product; export/observation only) ----------

function appendReconcileLog(logFile, entry = {}) {
  const resolved = path.resolve(requireNonEmptyString(logFile, 'logFile'));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const log = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, 'utf8')) : { schemaVersion: 1, entries: [] };
  const record = {
    at: optionsNow(entry.now).text,
    operationId: requireNonEmptyString(entry.operationId, 'entry.operationId'),
    query: requireNonEmptyString(entry.query, 'entry.query'),
    decision: requireNonEmptyString(entry.decision, 'entry.decision'),
    state: requireNonEmptyString(entry.state, 'entry.state'),
    remoteId: optionalOpaqueRemoteId(entry.remoteId, 'entry.remoteId'),
    note: optionalNonEmptyString(entry.note, 'entry.note')
  };
  log.entries.push(record);
  const tmp = `${resolved}.tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, resolved);
  return record;
}
function readReconcileLog(logFile) {
  const resolved = path.resolve(requireNonEmptyString(logFile, 'logFile'));
  if (!fs.existsSync(resolved)) return { schemaVersion: 1, entries: [] };
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

module.exports = {
  CAPABILITIES,
  OPERATION_STATES,
  RECONCILE_QUERIES,
  TIMEOUT_KINDS,
  FACT_KINDS,
  canonicalKeyMaterial,
  cacheKeyFor,
  canonicalScopeMaterial,
  scopeHashFor,
  putCache,
  lookupCache,
  claimOperation,
  markSubmitted,
  markTimeout,
  reconcileOperation,
  cancelOperation,
  adoptWorkerReference,
  getOperation,
  describeCapability,
  appendReconcileLog,
  readReconcileLog
};
