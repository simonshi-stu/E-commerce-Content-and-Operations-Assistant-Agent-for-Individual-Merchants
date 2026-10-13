'use strict';
/**
 * Budget pre-authorization and cost recording (T2.4, revision-01). Local synthetic fixtures only —
 * this module NEVER makes a real provider call, charge or budget authorization; a pre-authorization
 * is a database engineering permission, not a user budget approval. See the frozen interface at
 * [P]\runtime\runs\BUDGET-INTERFACE.md and the revision notes at BUDGET-INTERFACE-REV01.md.
 *
 * Frozen semantics (revision-01):
 * - Domain: a pool is keyed by (project, brand, currency); `brand = null` is explicit, never a
 *   wildcard. Currency is an opaque code — NO exchange-rate conversion anywhere.
 * - Money: integer MICROS with CHECKED arithmetic. Every input AND every computed aggregate
 *   (committed/remaining/need/pending sums/pool updates) must remain an exact safe integer; an
 *   unsupported numeric range fails closed BEFORE any write (transaction zero writes) with an
 *   explicit diagnostic — never silently rounded, never truncating a real receipt. Ordinary
 *   overruns inside the supported range are recorded exactly and block subsequent reserves.
 *   `quantity` must be a safe positive integer.
 * - Reserve request identity (F1): `eventId` + canonical payload (finite-bound presence/value,
 *   domain/currency/category/priceBasis/confidence/quantity, INITIAL remote reference). Every
 *   reserve outcome (granted/duplicate/blocked/no_pool) is persisted on the event; a same-event
 *   same-payload replay returns the TRUTHFUL ORIGINAL decision with zero writes, and a same event
 *   NEVER upgrades to a grant after the environment changes (a changed environment needs a new
 *   request/eventId). A different payload under the same eventId is a ConflictError. An existing
 *   reservation is matched against the immutable `request_json`/`request_hash` — a missing bound
 *   is not a wildcard, and later mutable remote bindings (callbacks) never change the original
 *   request identity. Legacy rows (NULL outcome/request_hash) are never backfilled; they fail
 *   closed.
 * - Remote references (F2): one exact opaque binding predicate (`bindReservationRemote`) is shared
 *   by recordPending/settle/release/lateCharge: unknown (null) may bind once, the same exact value
 *   stays, a different same-attempt value is a ConflictError with zero writes (reservation, pool
 *   and events unchanged). Values are preserved exactly (no trim/regex/note parsing); the literal
 *   'none' is a valid value, not unknown. A distinct retry attempt keeps its own reference and
 *   older reservations keep theirs.
 * - Accounting: committed = spent + reserved + overrun; pending costs use the ONE cumulative
 *   (monotonic) contract; settlement releases only the unused difference; no auto-release on
 *   checkpoint/cancel/timeout (refunds are not guaranteed); explicit evidence
 *   (`not_submitted`/`refund_confirmed`) releases a hold; late real charges are recorded, never
 *   hidden. No cross-database transactions with the idempotency module (separate DBs); the
 *   conservative default is: execute only when BOTH gates grant.
 */
const crypto = require('node:crypto');
const { ValidationError, ConflictError, NotFoundError } = require('./evidence.js');
const { assertJsonCompatible } = require('./privacy.js');
const { canonicalJson } = require('./packs.js');

const CATEGORIES = Object.freeze(['llm', 'search', 'ocr', 'image', 'video', 'tts', 'retry', 'storage']);
const CONFIDENCES = Object.freeze(['confident', 'placeholder', 'unknown']);
const RELEASE_EVIDENCE = Object.freeze(['not_submitted', 'refund_confirmed']);

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
function requireSafePositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive safe integer`);
  return value;
}
function assertSafeMoney(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${name} must be a safe non-negative integer in micros (no NaN/Infinity/negative/floats/unsafe integers)`);
  }
  return value;
}
function requireSafeMoney(value, name) {
  if (value === undefined || value === null) fail(`${name} is required`);
  return assertSafeMoney(value, name);
}
/** Checked addition: exact safe-integer totals only; unsupported ranges fail closed. */
function checkedAdd(a, b, name) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) {
    fail(`${name}: unsupported numeric range (inputs must be safe non-negative integers in micros)`);
  }
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    fail(`${name}: computed total exceeds the supported exact safe-integer range (${a} + ${b}); refusing with zero writes (no truncation/rounding)`);
  }
  return sum;
}
/** Checked subtraction: the result may be a negative exact signed safe integer (e.g. remaining). */
function checkedSub(a, b, name) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) fail(`${name}: unsupported numeric range`);
  const diff = a - b;
  if (!Number.isSafeInteger(diff)) {
    fail(`${name}: computed difference exceeds the supported exact safe-integer range (${a} - ${b}); refusing with zero writes`);
  }
  return diff;
}
function normalizeBrand(value) {
  if (value === undefined) fail('brand must be provided (a non-empty string or an explicit null; null is never a wildcard)');
  if (value === null) return null;
  return requireNonEmptyString(value, 'brand');
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function parseInstant(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(text));
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
  const epoch = parseInstant(value);
  if (epoch === null) fail('now must be a strict ISO instant with an explicit timezone and a real calendar date');
  return { text: new Date(epoch).toISOString(), epoch };
}
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

// ---------- pools ----------

function selectPoolRow(db, project, brand, currency) {
  return db.prepare("SELECT * FROM budget_pools WHERE project_id = ? AND currency = ? AND COALESCE(brand, '') = COALESCE(?, '')").get(project, currency, brand);
}
function selectPoolRowById(db, poolId) {
  return db.prepare('SELECT * FROM budget_pools WHERE id = ?').get(poolId);
}
function poolCommittedMicros(row, name = 'committed') {
  return checkedAdd(checkedAdd(row.spent_micros, row.reserved_micros, name), row.overrun_micros, name);
}
function hydratePool(row) {
  if (!row) return null;
  const committed = poolCommittedMicros(row);
  return {
    id: row.id,
    projectId: row.project_id,
    brand: row.brand,
    currency: row.currency,
    limitMicros: row.limit_micros,
    spentMicros: row.spent_micros,
    reservedMicros: row.reserved_micros,
    overrunMicros: row.overrun_micros,
    committedMicros: committed,
    remainingMicros: checkedSub(row.limit_micros, committed, 'remaining'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function activePendingMicros(db, poolId) {
  const rows = db.prepare("SELECT pending_micros FROM budget_reservations WHERE pool_id = ? AND status = 'reserved'").all(poolId);
  let total = 0;
  for (const row of rows) total = checkedAdd(total, row.pending_micros, 'pending total');
  return total;
}
function blockedPayload(db, reason, pool, extras = {}) {
  const committed = pool ? poolCommittedMicros(pool) : 0;
  return {
    decision: 'blocked',
    reason,
    spentMicros: pool ? pool.spent_micros : 0,
    committedMicros: committed,
    pendingMicros: pool ? activePendingMicros(db, pool.id) : 0,
    remainingMicros: pool ? checkedSub(pool.limit_micros, committed, 'remaining') : 0,
    needMicros: extras.needMicros ?? 0,
    suggest: extras.suggest ?? null
  };
}
/** Idempotent pool creation: the limit is set once and never reset by re-initialization. */
function ensureBudgetPool(db, options = {}) {
  const project = requireNonEmptyString(options.project, 'project');
  const brand = normalizeBrand(options.brand);
  const currency = requireNonEmptyString(options.currency, 'currency');
  const limitMicros = requireSafeMoney(options.limitMicros, 'limitMicros');
  if (limitMicros <= 0) fail('limitMicros must be a positive safe integer in micros');
  const now = optionsNow(options.now);
  return withTransaction(db, () => {
    const existing = selectPoolRow(db, project, brand, currency);
    if (existing) {
      if (existing.limit_micros !== limitMicros) {
        throw new ConflictError(`budget pool (${project}, brand=${brand ?? 'null'}, ${currency}) already exists with limit ${existing.limit_micros}; refusing to reset/change it`);
      }
      return { created: false, pool: hydratePool(existing) };
    }
    db.prepare('INSERT INTO budget_pools (project_id, brand, currency, limit_micros, spent_micros, reserved_micros, overrun_micros, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)')
      .run(project, brand, currency, limitMicros, now.text, now.text);
    return { created: true, pool: hydratePool(selectPoolRow(db, project, brand, currency)) };
  });
}
function getBudgetPool(db, options = {}) {
  const project = requireNonEmptyString(options.project, 'project');
  const brand = normalizeBrand(options.brand);
  const currency = requireNonEmptyString(options.currency, 'currency');
  return hydratePool(selectPoolRow(db, project, brand, currency));
}
function listReservations(db, options = {}) {
  const project = requireNonEmptyString(options.project, 'project');
  const brand = normalizeBrand(options.brand);
  const currency = requireNonEmptyString(options.currency, 'currency');
  const rows = db.prepare('SELECT * FROM budget_reservations WHERE project_id = ? AND currency = ? AND COALESCE(brand, \'\') = COALESCE(?, \'\') ORDER BY created_at, reservation_id').all(project, currency, brand);
  return rows.map(hydrateReservation);
}

// ---------- reservations ----------

function hydrateReservation(row) {
  if (!row) return null;
  return {
    reservationId: row.reservation_id,
    poolId: row.pool_id,
    projectId: row.project_id,
    brand: row.brand,
    currency: row.currency,
    operationId: row.operation_id,
    attemptToken: row.attempt_token,
    category: row.category,
    holdMicros: row.hold_micros,
    pendingMicros: row.pending_micros,
    overrunMicros: row.overrun_micros,
    priceBasis: row.price_basis,
    priceConfidence: row.price_confidence,
    quantity: row.quantity,
    status: row.status,
    settledMicros: row.settled_micros ?? null,
    releasedMicros: row.released_micros ?? null,
    remoteId: row.remote_id ?? null,
    lastEventId: row.last_event_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function selectReservation(db, operationId, attemptToken) {
  return db.prepare('SELECT * FROM budget_reservations WHERE operation_id = ? AND attempt_token = ?').get(operationId, attemptToken);
}
function eventPayloadHash(payload) {
  assertJsonCompatible(payload, 'event payload');
  return sha256Hex(canonicalJson(payload));
}
function checkEventIdempotency(db, eventId, eventType, payload) {
  const hash = eventPayloadHash(payload);
  const row = db.prepare('SELECT * FROM budget_events WHERE event_id = ?').get(eventId);
  if (!row) return { status: 'new', hash };
  if (row.event_type !== eventType || row.payload_hash !== hash) {
    throw new ConflictError(`event ${eventId} was already used with a different payload/type; refusing (zero writes)`);
  }
  return { status: 'duplicate', hash };
}
function recordEvent(db, eventId, eventType, payload, context) {
  db.prepare('INSERT INTO budget_events (event_id, event_type, pool_id, reservation_id, payload_hash, payload_json, created_at, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(eventId, eventType, context.poolId ?? null, context.reservationId ?? null, eventPayloadHash(payload), JSON.stringify(payload), context.now.text, context.outcome ?? null, context.reason ?? null);
}
/**
 * The ONE exact opaque remote binding predicate (F2), shared by every cost mutation. The stored
 * value is authoritative: unknown (null) may bind once; the same exact value stays; a different
 * same-attempt value fails closed BEFORE any other write. Opaque values are preserved exactly.
 */
function bindReservationRemote(db, reservation, remoteId) {
  if (remoteId === null) return reservation.remote_id ?? null;
  const stored = reservation.remote_id ?? null;
  if (stored !== null) {
    if (stored !== remoteId) {
      throw new ConflictError(`reservation for (${reservation.operation_id}, attempt ${reservation.attempt_token}) already has a different remote reference for this attempt; refusing (zero writes)`);
    }
    return stored;
  }
  db.prepare('UPDATE budget_reservations SET remote_id = ? WHERE reservation_id = ?').run(remoteId, reservation.reservation_id);
  return remoteId;
}

/**
 * Pre-effect atomic reservation with unified request identity (F1). The ONLY path that returns
 * `granted`; every outcome (granted/duplicate/blocked/no_pool) is persisted on the event so a
 * same-event replay returns the truthful original decision — a blocked/no_pool request never
 * upgrades to a grant after the environment changes.
 */
function reserveBudget(db, options = {}) {
  const project = requireNonEmptyString(options.project, 'project');
  const brand = normalizeBrand(options.brand);
  const currency = requireNonEmptyString(options.currency, 'currency');
  const operationId = requireNonEmptyString(options.operationId, 'operationId');
  const attemptToken = requireNonEmptyString(options.attemptToken, 'attemptToken');
  const category = requireNonEmptyString(options.category, 'category');
  if (!CATEGORIES.includes(category)) fail(`category must be one of ${CATEGORIES.join(', ')}`);
  const priceBasis = requireNonEmptyString(options.priceBasis, 'priceBasis');
  const priceConfidence = requireNonEmptyString(options.priceConfidence, 'priceConfidence');
  if (!CONFIDENCES.includes(priceConfidence)) fail(`priceConfidence must be one of ${CONFIDENCES.join(', ')}`);
  const quantity = requireSafePositiveInt(options.quantity, 'quantity');
  const eventId = requireNonEmptyString(options.eventId, 'eventId');
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const now = optionsNow(options.now);
  const hasEstimate = options.maxEstimateMicros !== undefined && options.maxEstimateMicros !== null;
  const maxEstimateMicros = hasEstimate ? assertSafeMoney(options.maxEstimateMicros, 'maxEstimateMicros') : null;
  const payload = { operationId, attemptToken, category, maxEstimateMicros, priceBasis, priceConfidence, quantity, project, brand, currency, remoteId };
  const payloadHash = eventPayloadHash(payload);
  return withTransaction(db, () => {
    const priorEvent = db.prepare('SELECT * FROM budget_events WHERE event_id = ?').get(eventId);
    if (priorEvent) {
      if (priorEvent.event_type !== 'reserve' || priorEvent.payload_hash !== payloadHash) {
        throw new ConflictError(`event ${eventId} was already used with a different payload/type; refusing (zero writes)`);
      }
      // same request replay: the ORIGINAL decision is returned truthfully; never a new grant
      if (priorEvent.outcome === 'granted' || priorEvent.outcome === 'duplicate') {
        const reservation = selectReservation(db, operationId, attemptToken);
        const pool = selectPoolRow(db, project, brand, currency);
        if (reservation) return { decision: 'duplicate', reservation: hydrateReservation(reservation), budget: hydratePool(pool) };
        return blockedPayload(db, 'duplicate_event_without_reservation', pool, { needMicros: maxEstimateMicros ?? 0, suggest: 'use a NEW eventId for a new request; a duplicate event never grants' });
      }
      if (priorEvent.outcome === 'blocked' || priorEvent.outcome === 'no_pool') {
        const pool = selectPoolRow(db, project, brand, currency);
        return blockedPayload(db, priorEvent.reason ?? 'blocked_request_replay', pool, {
          needMicros: maxEstimateMicros ?? 0,
          suggest: 'the original request was blocked; a changed environment needs a NEW request/eventId (a same event never upgrades to a grant)'
        });
      }
      // legacy event without a recorded outcome: fail closed, never grant
      return blockedPayload(db, 'legacy_unknown_outcome', selectPoolRow(db, project, brand, currency), { needMicros: maxEstimateMicros ?? 0, suggest: 'legacy event without a recorded outcome; use a new request/eventId' });
    }
    // F1-rev02: the existing (operationId, attemptToken) identity check runs BEFORE the target-pool
    // lookup — a changed domain/config must conflict with three-table zero writes and must NOT fall
    // into the no_pool branch just because the target domain has no pool.
    const existing = selectReservation(db, operationId, attemptToken);
    if (existing) {
      if (existing.request_hash !== payloadHash) {
        throw new ConflictError(`reservation for (${operationId}, attempt ${attemptToken}) already exists with a different payload/config (exact immutable request); refusing (zero writes)`);
      }
      const existingPool = selectPoolRow(db, project, brand, currency);
      if (!existingPool) {
        return blockedPayload(db, 'duplicate_event_without_reservation', null, { needMicros: maxEstimateMicros ?? 0, suggest: 'the original reservation pool is missing; refusing (no new grant)' });
      }
      recordEvent(db, eventId, 'reserve', payload, { poolId: existingPool.id, reservationId: existing.reservation_id, outcome: 'duplicate', now });
      return { decision: 'duplicate', reservation: hydrateReservation(existing), budget: hydratePool(existingPool) };
    }
    const pool = selectPoolRow(db, project, brand, currency);
    if (!pool) {
      recordEvent(db, eventId, 'reserve', payload, { poolId: null, reservationId: null, outcome: 'no_pool', reason: 'no_budget_pool', now });
      return blockedPayload(db, 'no_budget_pool', null, { needMicros: maxEstimateMicros ?? 0, suggest: 'create an explicit budget pool first (ensureBudgetPool); this module cannot create real budget' });
    }
    if (!hasEstimate) {
      const reason = priceConfidence === 'confident' ? 'missing_finite_upper_bound' : 'missing_confident_price_and_bound';
      recordEvent(db, eventId, 'reserve', payload, { poolId: pool.id, reservationId: null, outcome: 'blocked', reason, now });
      return blockedPayload(db, reason, pool, { needMicros: 0, suggest: 'provide a finite scenario cap (maxEstimateMicros) before any external call; unknown unit prices never run unlimited' });
    }
    const committed = poolCommittedMicros(pool);
    const available = checkedSub(pool.limit_micros, committed, 'remaining');
    if (maxEstimateMicros > available) {
      recordEvent(db, eventId, 'reserve', payload, { poolId: pool.id, reservationId: null, outcome: 'blocked', reason: 'budget_exceeded', now });
      return blockedPayload(db, 'budget_exceeded', pool, {
        needMicros: checkedSub(maxEstimateMicros, available, 'need'),
        suggest: 'reduce the estimate, release only with explicit evidence, or obtain more budget (a user decision; this module cannot create real budget)'
      });
    }
    const newReserved = checkedAdd(pool.reserved_micros, maxEstimateMicros, 'reserved');
    // prospective aggregate must stay exactly representable BEFORE any write
    checkedAdd(checkedAdd(pool.spent_micros, newReserved, 'committed'), pool.overrun_micros, 'committed');
    const reservationId = `res_${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO budget_reservations (reservation_id, pool_id, project_id, brand, currency, operation_id, attempt_token, category, hold_micros, pending_micros, overrun_micros, price_basis, price_confidence, quantity, status, remote_id, last_event_id, created_at, updated_at, request_json, request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`)
      .run(reservationId, pool.id, project, brand, currency, operationId, attemptToken, category, maxEstimateMicros, priceBasis, priceConfidence, quantity, remoteId, eventId, now.text, now.text, JSON.stringify(payload), payloadHash);
    db.prepare('UPDATE budget_pools SET reserved_micros = ?, updated_at = ? WHERE id = ?')
      .run(newReserved, now.text, pool.id);
    recordEvent(db, eventId, 'reserve', payload, { poolId: pool.id, reservationId, outcome: 'granted', now });
    return {
      decision: 'granted',
      reservation: hydrateReservation(selectReservation(db, operationId, attemptToken)),
      budget: hydratePool(selectPoolRow(db, project, brand, currency))
    };
  });
}

/** Cumulative (monotonic) pending actuals — the ONE pending contract; never a delta contract. */
function recordPendingCost(db, options = {}) {
  const operationId = requireNonEmptyString(options.operationId, 'operationId');
  const attemptToken = requireNonEmptyString(options.attemptToken, 'attemptToken');
  const cumulativeMicros = requireSafeMoney(options.cumulativeMicros, 'cumulativeMicros');
  const eventId = requireNonEmptyString(options.eventId, 'eventId');
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const now = optionsNow(options.now);
  const payload = { operationId, attemptToken, cumulativeMicros, remoteId };
  return withTransaction(db, () => {
    const eventState = checkEventIdempotency(db, eventId, 'record_pending', payload);
    const reservation = selectReservation(db, operationId, attemptToken);
    if (!reservation) throw new NotFoundError('reservation not found for (operationId, attemptToken)');
    if (eventState.status === 'duplicate') {
      return { decision: 'duplicate', reservation: hydrateReservation(reservation), budget: hydratePool(selectPoolRowById(db, reservation.pool_id)) };
    }
    if (reservation.status !== 'reserved') throw new ConflictError(`cannot record pending cost on a ${reservation.status} reservation`);
    if (cumulativeMicros < reservation.pending_micros) {
      throw new ConflictError('pending costs use the cumulative contract and are monotonic; a lower cumulative value was rejected');
    }
    bindReservationRemote(db, reservation, remoteId);
    const newOverrun = cumulativeMicros > reservation.hold_micros ? checkedSub(cumulativeMicros, reservation.hold_micros, 'overrun') : 0;
    const deltaOverrun = checkedSub(newOverrun, reservation.overrun_micros, 'overrun delta');
    const pool = selectPoolRowById(db, reservation.pool_id);
    const newPoolOverrun = deltaOverrun > 0 ? checkedAdd(pool.overrun_micros, deltaOverrun, 'pool overrun') : pool.overrun_micros;
    checkedAdd(checkedAdd(pool.spent_micros, pool.reserved_micros, 'committed'), newPoolOverrun, 'committed');
    db.prepare('UPDATE budget_reservations SET pending_micros = ?, overrun_micros = ?, last_event_id = ?, updated_at = ? WHERE reservation_id = ?')
      .run(cumulativeMicros, newOverrun, eventId, now.text, reservation.reservation_id);
    if (deltaOverrun > 0) {
      db.prepare('UPDATE budget_pools SET overrun_micros = ?, updated_at = ? WHERE id = ?').run(newPoolOverrun, now.text, pool.id);
    }
    recordEvent(db, eventId, 'record_pending', payload, { poolId: pool.id, reservationId: reservation.reservation_id, outcome: 'recorded', now });
    return {
      decision: 'recorded',
      overrunDeltaMicros: deltaOverrun,
      reservation: hydrateReservation(selectReservation(db, operationId, attemptToken)),
      budget: hydratePool(selectPoolRowById(db, reservation.pool_id))
    };
  });
}

/** Final settlement (cumulative final total): closes the hold, releases the unused difference. */
function settleReservation(db, options = {}) {
  const operationId = requireNonEmptyString(options.operationId, 'operationId');
  const attemptToken = requireNonEmptyString(options.attemptToken, 'attemptToken');
  const finalMicros = requireSafeMoney(options.finalMicros, 'finalMicros');
  const eventId = requireNonEmptyString(options.eventId, 'eventId');
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const now = optionsNow(options.now);
  const payload = { operationId, attemptToken, finalMicros, remoteId };
  return withTransaction(db, () => {
    const eventState = checkEventIdempotency(db, eventId, 'settle', payload);
    const reservation = selectReservation(db, operationId, attemptToken);
    if (!reservation) throw new NotFoundError('reservation not found for (operationId, attemptToken)');
    if (eventState.status === 'duplicate') {
      return { decision: 'duplicate', reservation: hydrateReservation(reservation), budget: hydratePool(selectPoolRowById(db, reservation.pool_id)) };
    }
    if (reservation.status !== 'reserved') throw new ConflictError(`cannot settle a ${reservation.status} reservation`);
    if (finalMicros < reservation.pending_micros) {
      throw new ConflictError('finalMicros must be >= the accumulated pending actuals (cumulative contract)');
    }
    bindReservationRemote(db, reservation, remoteId);
    const unusedReleased = reservation.hold_micros >= finalMicros ? checkedSub(reservation.hold_micros, finalMicros, 'unused release') : 0;
    const overrun = finalMicros > reservation.hold_micros ? checkedSub(finalMicros, reservation.hold_micros, 'overrun') : 0;
    const pool = selectPoolRowById(db, reservation.pool_id);
    const newSpent = checkedAdd(pool.spent_micros, finalMicros, 'spent');
    const newReserved = checkedSub(pool.reserved_micros, reservation.hold_micros, 'reserved');
    const newOverrun = checkedSub(pool.overrun_micros, reservation.overrun_micros, 'overrun');
    checkedAdd(checkedAdd(newSpent, newReserved, 'committed'), newOverrun, 'committed');
    db.prepare('UPDATE budget_reservations SET status = ?, settled_micros = ?, released_micros = ?, last_event_id = ?, updated_at = ? WHERE reservation_id = ?')
      .run('settled', finalMicros, unusedReleased, eventId, now.text, reservation.reservation_id);
    db.prepare('UPDATE budget_pools SET reserved_micros = ?, overrun_micros = ?, spent_micros = ?, updated_at = ? WHERE id = ?')
      .run(newReserved, newOverrun, newSpent, now.text, pool.id);
    recordEvent(db, eventId, 'settle', payload, { poolId: pool.id, reservationId: reservation.reservation_id, outcome: 'settled', now });
    return {
      decision: 'settled',
      unusedReleasedMicros: unusedReleased,
      overrunMicros: overrun,
      reservation: hydrateReservation(selectReservation(db, operationId, attemptToken)),
      budget: hydratePool(selectPoolRowById(db, reservation.pool_id))
    };
  });
}

/**
 * Explicit-evidence release of the full remaining hold. No checkpoint/cancel/timeout ever
 * releases automatically; `not_submitted` contradicts recorded pending costs and is rejected
 * when pending > 0, while `refund_confirmed` releases the hold with spent unchanged.
 */
function releaseReservation(db, options = {}) {
  const operationId = requireNonEmptyString(options.operationId, 'operationId');
  const attemptToken = requireNonEmptyString(options.attemptToken, 'attemptToken');
  const evidence = requireNonEmptyString(options.evidence, 'evidence');
  if (!RELEASE_EVIDENCE.includes(evidence)) fail(`evidence must be one of ${RELEASE_EVIDENCE.join(', ')}`);
  const eventId = requireNonEmptyString(options.eventId, 'eventId');
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const now = optionsNow(options.now);
  const payload = { operationId, attemptToken, evidence, remoteId };
  return withTransaction(db, () => {
    const eventState = checkEventIdempotency(db, eventId, 'release', payload);
    const reservation = selectReservation(db, operationId, attemptToken);
    if (!reservation) throw new NotFoundError('reservation not found for (operationId, attemptToken)');
    if (eventState.status === 'duplicate') {
      return { decision: 'duplicate', reservation: hydrateReservation(reservation), budget: hydratePool(selectPoolRowById(db, reservation.pool_id)) };
    }
    if (reservation.status !== 'reserved') throw new ConflictError(`cannot release a ${reservation.status} reservation`);
    if (evidence === 'not_submitted' && reservation.pending_micros > 0) {
      throw new ConflictError("evidence 'not_submitted' contradicts recorded pending costs; use the explicit refund evidence instead");
    }
    bindReservationRemote(db, reservation, remoteId);
    const pool = selectPoolRowById(db, reservation.pool_id);
    const newReserved = checkedSub(pool.reserved_micros, reservation.hold_micros, 'reserved');
    const newOverrun = checkedSub(pool.overrun_micros, reservation.overrun_micros, 'overrun');
    checkedAdd(checkedAdd(pool.spent_micros, newReserved, 'committed'), newOverrun, 'committed');
    db.prepare('UPDATE budget_reservations SET status = ?, released_micros = ?, last_event_id = ?, updated_at = ? WHERE reservation_id = ?')
      .run('released', reservation.hold_micros, eventId, now.text, reservation.reservation_id);
    db.prepare('UPDATE budget_pools SET reserved_micros = ?, overrun_micros = ?, updated_at = ? WHERE id = ?')
      .run(newReserved, newOverrun, now.text, pool.id);
    recordEvent(db, eventId, 'release', payload, { poolId: pool.id, reservationId: reservation.reservation_id, outcome: 'released', now });
    return {
      decision: 'released',
      evidence,
      releasedMicros: reservation.hold_micros,
      reservation: hydrateReservation(selectReservation(db, operationId, attemptToken)),
      budget: hydratePool(selectPoolRowById(db, reservation.pool_id))
    };
  });
}

/**
 * Late real charge arriving after the reservation closed: recorded directly into spent (never
 * hidden/truncated) with the remote/operation/attempt references retained.
 */
function recordLateCharge(db, options = {}) {
  const operationId = requireNonEmptyString(options.operationId, 'operationId');
  const attemptToken = requireNonEmptyString(options.attemptToken, 'attemptToken');
  const chargeMicros = requireSafeMoney(options.chargeMicros, 'chargeMicros');
  const evidence = requireNonEmptyString(options.evidence, 'evidence');
  const eventId = requireNonEmptyString(options.eventId, 'eventId');
  const remoteId = optionalOpaqueRemoteId(options.remoteId, 'remoteId');
  const now = optionsNow(options.now);
  const payload = { operationId, attemptToken, chargeMicros, evidence, remoteId };
  return withTransaction(db, () => {
    const eventState = checkEventIdempotency(db, eventId, 'late_charge', payload);
    const reservation = selectReservation(db, operationId, attemptToken);
    if (!reservation) throw new NotFoundError('reservation not found for (operationId, attemptToken)');
    if (eventState.status === 'duplicate') {
      return { decision: 'duplicate', reservation: hydrateReservation(reservation), budget: hydratePool(selectPoolRowById(db, reservation.pool_id)) };
    }
    if (reservation.status === 'reserved') {
      throw new ConflictError('the reservation is still active; use recordPendingCost (cumulative) instead of a late charge');
    }
    bindReservationRemote(db, reservation, remoteId);
    const pool = selectPoolRowById(db, reservation.pool_id);
    const newSpent = checkedAdd(pool.spent_micros, chargeMicros, 'spent');
    checkedAdd(checkedAdd(newSpent, pool.reserved_micros, 'committed'), pool.overrun_micros, 'committed');
    db.prepare('UPDATE budget_pools SET spent_micros = ?, updated_at = ? WHERE id = ?')
      .run(newSpent, now.text, pool.id);
    db.prepare('UPDATE budget_reservations SET last_event_id = ?, updated_at = ? WHERE reservation_id = ?')
      .run(eventId, now.text, reservation.reservation_id);
    recordEvent(db, eventId, 'late_charge', payload, { poolId: pool.id, reservationId: reservation.reservation_id, outcome: 'late_charge', now });
    return {
      decision: 'recorded',
      lateChargeMicros: chargeMicros,
      overrunMicros: chargeMicros,
      reservation: hydrateReservation(selectReservation(db, operationId, attemptToken)),
      budget: hydratePool(selectPoolRowById(db, reservation.pool_id))
    };
  });
}

module.exports = {
  CATEGORIES,
  CONFIDENCES,
  RELEASE_EVIDENCE,
  assertSafeMoney,
  ensureBudgetPool,
  getBudgetPool,
  listReservations,
  reserveBudget,
  recordPendingCost,
  settleReservation,
  releaseReservation,
  recordLateCharge
};
