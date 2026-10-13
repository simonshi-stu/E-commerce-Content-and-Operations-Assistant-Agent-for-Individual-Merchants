'use strict';
/**
 * T2.4 — budget pre-authorization / cost recording tests. Real SQLite (0009 isolated migration),
 * explicit clocks, synthetic fixtures only — NO real calls, charges or budget authorization.
 * The linkage group uses the REAL approved idempotency module on a separate DB (no cross-DB
 * atomicity is claimed). Temp files only under $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const { openDb, migrateUp, migrateDown, backupTo, verifyDatabaseFile } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m2 = require(path.join(W, 'lib', 'commerce', 'migrations', '0002_passport_sku.js'));
const m3 = require(path.join(W, 'lib', 'commerce', 'migrations', '0003_evidence_observation.js'));
const m4 = require(path.join(W, 'lib', 'commerce', 'migrations', '0004_run_store.js'));
const m5 = require(path.join(W, 'lib', 'commerce', 'migrations', '0005_run_store_lease_token.js'));
const m6 = require(path.join(W, 'lib', 'commerce', 'migrations', '0006_idempotency.js'));
const m7 = require(path.join(W, 'lib', 'commerce', 'migrations', '0007_idempotency_contract.js'));
const m8 = require(path.join(W, 'lib', 'commerce', 'migrations', '0008_idempotency_attempt_remote.js'));
const m9 = require(path.join(W, 'lib', 'commerce', 'migrations', '0009_budget.js'));
const m10 = require(path.join(W, 'lib', 'commerce', 'migrations', '0010_budget_request_identity.js'));
const idem = require(path.join(W, 'lib', 'commerce', 'idempotency.js'));
const budget = require(path.join(W, 'lib', 'commerce', 'budget.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T2.4 tests write only to the private runtime tmp';

const T0 = '2026-10-09T00:00:00.000Z';
const T1 = '2026-10-09T00:01:00.000Z';
const T2 = '2026-10-09T00:02:00.000Z';
const hashOf = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

function freshBudget(label, migrations = [m9, m10]) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `budget-${label}-`));
  const dbPath = path.join(dir, 'budget.db');
  const db = openDb(dbPath);
  migrateUp(db, migrations);
  return { dir, dbPath, db };
}

test('T2.4 budget pools, exact money and domain/currency isolation', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'budget-a-'));
  const dbPath = path.join(dir, 'budget.db');
  const db = openDb(dbPath);
  // full [1-9] isolated chain: up -> backup -> down to 8 -> re-up 9 -> restore verify
  assert.deepEqual(migrateUp(db, [core, m2, m3, m4, m5, m6, m7, m8, m9]), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const backupPath = path.join(dir, 'budget-1to9-backup.db');
  backupTo(db, backupPath);
  assert.deepEqual(migrateDown(db, [core, m2, m3, m4, m5, m6, m7, m8, m9], { to: 8 }), [9]);
  const afterDown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(!afterDown.includes('budget_pools'), 'down removed the 0009 tables');
  assert.deepEqual(migrateUp(db, [m9]), [9], 're-up 0009 after down');
  const restored = verifyDatabaseFile(backupPath, { expectedTables: ['budget_pools', 'budget_reservations', 'budget_events'] });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  // apply 0010 for the operations below (the [1-9] chain assertions above are preserved)
  assert.deepEqual(migrateUp(db, [m10]), [10]);

  // money validation: safe integer micros only
  for (const bad of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, '10']) {
    assert.throws(() => budget.assertSafeMoney(bad, 'amount'), /safe non-negative integer/);
  }
  assert.equal(budget.assertSafeMoney(0, 'amount'), 0);
  assert.equal(budget.assertSafeMoney(1000000, 'amount'), 1000000);

  // pool idempotency: the limit is set once and never reset by re-initialization
  const created = budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 1000000, now: T0 });
  assert.equal(created.created, true);
  const again = budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 1000000, now: T0 });
  assert.equal(again.created, false);
  assert.equal(again.pool.limitMicros, 1000000);
  assert.throws(() => budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 2000000, now: T0 }), /refusing to reset/);

  // domain isolation: brand null is explicit, never a wildcard; project isolation
  assert.equal(budget.ensureBudgetPool(db, { project: 'proj-a', brand: null, currency: 'USD', limitMicros: 500000, now: T0 }).created, true);
  assert.equal(budget.getBudgetPool(db, { project: 'proj-a', brand: null, currency: 'USD' }).limitMicros, 500000);
  assert.equal(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' }).limitMicros, 1000000, 'brand null is not a wildcard');
  assert.equal(budget.getBudgetPool(db, { project: 'proj-b', brand: 'brand-1', currency: 'USD' }), null, 'project isolation');

  // currency isolation: no FX; a missing currency pool is blocked
  assert.equal(budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'EUR', limitMicros: 700000, now: T0 }).created, true);
  const base = { project: 'proj-a', brand: 'brand-1', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };
  const usdReserve = budget.reserveBudget(db, { ...base, currency: 'USD', operationId: 'op-usd', attemptToken: 'att-1', maxEstimateMicros: 1000, eventId: 'ev-usd-1', now: T0 });
  assert.equal(usdReserve.decision, 'granted');
  assert.equal(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' }).reservedMicros, 1000);
  assert.equal(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'EUR' }).reservedMicros, 0, 'currencies are isolated; no conversion');
  const noPool = budget.reserveBudget(db, { ...base, currency: 'GBP', operationId: 'op-gbp', attemptToken: 'att-1', maxEstimateMicros: 500, eventId: 'ev-gbp-1', now: T0 });
  assert.equal(noPool.decision, 'blocked');
  assert.equal(noPool.reason, 'no_budget_pool');
  db.close();
});

test('T2.4 atomic reservation, ceiling and concurrency', { skip }, () => {
  const { dbPath, db } = freshBudget('b');
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 100, now: T0 });
  const base = { project: 'proj-a', brand: 'brand-1', currency: 'USD', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };
  const granted = budget.reserveBudget(db, { ...base, operationId: 'op-1', attemptToken: 'att-1', maxEstimateMicros: 60, eventId: 'ev-1', now: T0 });
  assert.equal(granted.decision, 'granted');
  assert.equal(granted.budget.reservedMicros, 60);
  assert.equal(granted.budget.remainingMicros, 40);

  // duplicate: same operation+attempt+config is a read-back, never a new grant
  const dup = budget.reserveBudget(db, { ...base, operationId: 'op-1', attemptToken: 'att-1', maxEstimateMicros: 60, eventId: 'ev-1b', now: T0 });
  assert.equal(dup.decision, 'duplicate');
  assert.equal(dup.budget.reservedMicros, 60, 'duplicate does not double-hold');
  assert.throws(() => budget.reserveBudget(db, { ...base, operationId: 'op-1', attemptToken: 'att-1', maxEstimateMicros: 70, eventId: 'ev-1c', now: T0 }), /different payload\/config/);
  assert.throws(() => budget.reserveBudget(db, { ...base, category: 'search', operationId: 'op-1', attemptToken: 'att-1', maxEstimateMicros: 60, eventId: 'ev-1d', now: T0 }), /different payload\/config/);

  // ceiling: committed 60 + 60 > 100 -> blocked with the full accounting
  const blocked = budget.reserveBudget(db, { ...base, operationId: 'op-2', attemptToken: 'att-1', maxEstimateMicros: 60, eventId: 'ev-2', now: T0 });
  assert.equal(blocked.decision, 'blocked');
  assert.equal(blocked.reason, 'budget_exceeded');
  assert.equal(blocked.spentMicros, 0);
  assert.equal(blocked.committedMicros, 60);
  assert.equal(blocked.pendingMicros, 0);
  assert.equal(blocked.remainingMicros, 40);
  assert.equal(blocked.needMicros, 20);
  assert.ok(blocked.suggest);

  // a new attempt needs a NEW reserve (never free reuse of a previous generation's hold)
  const retry = budget.reserveBudget(db, { ...base, operationId: 'op-1', attemptToken: 'att-2', maxEstimateMicros: 30, eventId: 'ev-3', now: T0 });
  assert.equal(retry.decision, 'granted');
  assert.equal(retry.budget.reservedMicros, 90);

  // missing confident price without a finite bound -> blocked, no execute
  const noBound = budget.reserveBudget(db, { ...base, operationId: 'op-3', attemptToken: 'att-1', priceConfidence: 'unknown', eventId: 'ev-4', now: T0 });
  assert.equal(noBound.decision, 'blocked');
  assert.equal(noBound.reason, 'missing_confident_price_and_bound');
  // placeholder with a finite scenario cap may be granted (never presented as a real price)
  const placeholder = budget.reserveBudget(db, { ...base, operationId: 'op-4', attemptToken: 'att-1', maxEstimateMicros: 5, priceConfidence: 'placeholder', eventId: 'ev-5', now: T0 });
  assert.equal(placeholder.decision, 'granted');
  assert.equal(placeholder.reservation.priceConfidence, 'placeholder');

  // two open connections cannot both read the same remaining balance and grant
  const db2 = openDb(dbPath);
  const connA = budget.reserveBudget(db2, { ...base, operationId: 'op-5', attemptToken: 'att-1', maxEstimateMicros: 4, eventId: 'ev-6', now: T0 });
  assert.equal(connA.decision, 'granted');
  const connB = budget.reserveBudget(db, { ...base, operationId: 'op-6', attemptToken: 'att-1', maxEstimateMicros: 4, eventId: 'ev-7', now: T0 });
  assert.equal(connB.decision, 'blocked', 'two connections cannot both grant the same remaining balance');
  assert.equal(connB.remainingMicros, 1);
  db2.close();
  db.close();
});

test('T2.4 pending accumulation, settlement and event idempotency', { skip }, () => {
  const { dbPath, db } = freshBudget('c');
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 1000, now: T0 });
  const base = { project: 'proj-a', brand: 'brand-1', currency: 'USD', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };
  const r1 = budget.reserveBudget(db, { ...base, operationId: 'op-1', attemptToken: 'att-1', maxEstimateMicros: 100, eventId: 'ev-r1', now: T0 });
  assert.equal(r1.decision, 'granted');

  // cumulative pending: 30 -> 80; same event replay is a no-op; lower cumulative rejected
  const p1 = budget.recordPendingCost(db, { operationId: 'op-1', attemptToken: 'att-1', cumulativeMicros: 30, eventId: 'ev-p1', now: T0 });
  assert.equal(p1.decision, 'recorded');
  assert.equal(p1.reservation.pendingMicros, 30);
  const p1dup = budget.recordPendingCost(db, { operationId: 'op-1', attemptToken: 'att-1', cumulativeMicros: 30, eventId: 'ev-p1', now: T0 });
  assert.equal(p1dup.decision, 'duplicate', 'the same event is a no-op');
  assert.equal(p1dup.reservation.pendingMicros, 30, 'duplicate does not double count');
  assert.throws(() => budget.recordPendingCost(db, { operationId: 'op-1', attemptToken: 'att-1', cumulativeMicros: 40, eventId: 'ev-p1', now: T0 }), /different payload/);
  const p2 = budget.recordPendingCost(db, { operationId: 'op-1', attemptToken: 'att-1', cumulativeMicros: 80, eventId: 'ev-p2', now: T0 });
  assert.equal(p2.reservation.pendingMicros, 80);
  assert.throws(() => budget.recordPendingCost(db, { operationId: 'op-1', attemptToken: 'att-1', cumulativeMicros: 50, eventId: 'ev-p3', now: T0 }), /monotonic/);

  // settle with a final above the hold: overrun recorded, never truncated
  const s1 = budget.settleReservation(db, { operationId: 'op-1', attemptToken: 'att-1', finalMicros: 120, eventId: 'ev-s1', now: T0 });
  assert.equal(s1.decision, 'settled');
  assert.equal(s1.overrunMicros, 20);
  assert.equal(s1.unusedReleasedMicros, 0);
  assert.equal(s1.budget.spentMicros, 120);
  assert.equal(s1.budget.reservedMicros, 0);
  assert.equal(s1.budget.overrunMicros, 0);
  assert.equal(s1.budget.remainingMicros, 880);
  const s1dup = budget.settleReservation(db, { operationId: 'op-1', attemptToken: 'att-1', finalMicros: 120, eventId: 'ev-s1', now: T0 });
  assert.equal(s1dup.decision, 'duplicate');
  assert.equal(s1dup.budget.spentMicros, 120, 'duplicate settlement does not double count');

  // settle below pending rejected; release requires explicit evidence and pending consistency
  const r2 = budget.reserveBudget(db, { ...base, operationId: 'op-2', attemptToken: 'att-1', maxEstimateMicros: 200, eventId: 'ev-r2', now: T0 });
  assert.equal(r2.decision, 'granted');
  budget.recordPendingCost(db, { operationId: 'op-2', attemptToken: 'att-1', cumulativeMicros: 150, eventId: 'ev-p4', now: T0 });
  assert.throws(() => budget.settleReservation(db, { operationId: 'op-2', attemptToken: 'att-1', finalMicros: 100, eventId: 'ev-s2', now: T0 }), />= the accumulated pending/);
  assert.throws(() => budget.releaseReservation(db, { operationId: 'op-2', attemptToken: 'att-1', evidence: 'not_submitted', eventId: 'ev-rel-x', now: T0 }), /contradicts recorded pending/);
  const rel = budget.releaseReservation(db, { operationId: 'op-2', attemptToken: 'att-1', evidence: 'refund_confirmed', eventId: 'ev-rel1', now: T0 });
  assert.equal(rel.decision, 'released');
  assert.equal(rel.releasedMicros, 200);
  assert.equal(rel.budget.reservedMicros, 0);
  assert.equal(rel.budget.spentMicros, 120, 'release does not change spent');
  assert.throws(() => budget.releaseReservation(db, { operationId: 'op-2', attemptToken: 'att-1', evidence: 'refund_confirmed', eventId: 'ev-rel2', now: T0 }), /cannot release a released/);

  // not_submitted release for an operation with no pending costs
  budget.reserveBudget(db, { ...base, operationId: 'op-3', attemptToken: 'att-1', maxEstimateMicros: 50, eventId: 'ev-r3', now: T0 });
  const rel3 = budget.releaseReservation(db, { operationId: 'op-3', attemptToken: 'att-1', evidence: 'not_submitted', eventId: 'ev-rel3', now: T0 });
  assert.equal(rel3.decision, 'released');
  assert.equal(rel3.releasedMicros, 50);

  // final settlement below the hold releases only the unused difference
  budget.reserveBudget(db, { ...base, operationId: 'op-4', attemptToken: 'att-1', maxEstimateMicros: 100, eventId: 'ev-r4', now: T0 });
  const s4 = budget.settleReservation(db, { operationId: 'op-4', attemptToken: 'att-1', finalMicros: 40, eventId: 'ev-s4', now: T0 });
  assert.equal(s4.unusedReleasedMicros, 60);
  assert.equal(s4.budget.spentMicros, 160);
  assert.equal(s4.budget.reservedMicros, 0);

  // a late charge after settlement is recorded, never hidden
  const late = budget.recordLateCharge(db, { operationId: 'op-4', attemptToken: 'att-1', chargeMicros: 15, evidence: 'synthetic-provider: post-settle charge', eventId: 'ev-late1', now: T0 });
  assert.equal(late.decision, 'recorded');
  assert.equal(late.budget.spentMicros, 175);

  // reopen readback
  db.close();
  const db2 = openDb(dbPath);
  const pool = budget.getBudgetPool(db2, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(pool.spentMicros, 175);
  assert.equal(pool.reservedMicros, 0);
  const reservations = budget.listReservations(db2, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(reservations.length, 4);
  assert.equal(reservations.find((entry) => entry.operationId === 'op-4').settledMicros, 40);
  db2.close();
});

test('T2.4 T2.3 linkage, non-release and reopen readback', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'budget-d-'));
  const budgetDbPath = path.join(dir, 'budget.db');
  const idemDbPath = path.join(dir, 'idempotency.db');
  const bdb = openDb(budgetDbPath);
  migrateUp(bdb, [m9, m10]);
  const idb = openDb(idemDbPath);
  migrateUp(idb, [m6, m7, m8]);
  budget.ensureBudgetPool(bdb, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 1000, now: T0 });
  const scope = {
    taskId: 'link-task', inputHash: hashOf('link-input'), tool: 'tool-x', toolVersion: '1.0.0', model: 'model-y',
    promptVersion: 'p1', templateVersion: 't1', policy: 'policy-default', project: 'proj-a', brand: 'brand-1',
    market: 'US', locale: 'en-US', shipTo: 'US'
  };

  // both gates must grant before an effect is allowed (conservative default across separate DBs)
  const claimed = idem.claimOperation(idb, { operationId: 'op-link', scope, capability: 'unknown', now: T0 });
  const attemptToken = claimed.operation.attemptToken;
  const reserved = budget.reserveBudget(bdb, { project: 'proj-a', brand: 'brand-1', currency: 'USD', operationId: 'op-link', attemptToken, category: 'llm', maxEstimateMicros: 100, priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1, eventId: 'ev-link-1', now: T0 });
  assert.equal(claimed.decision === 'execute' && reserved.decision === 'granted', true, 'effect allowed only when BOTH gates grant');
  const claimedAgain = idem.claimOperation(idb, { operationId: 'op-link', scope, capability: 'unknown', now: T0 });
  const reservedAgain = budget.reserveBudget(bdb, { project: 'proj-a', brand: 'brand-1', currency: 'USD', operationId: 'op-link', attemptToken, category: 'llm', maxEstimateMicros: 100, priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1, eventId: 'ev-link-1b', now: T0 });
  assert.equal(claimedAgain.decision, 'in_progress', 'recovery does not re-execute');
  assert.equal(reservedAgain.decision, 'duplicate', 'recovery does not re-charge');

  // submit -> timeout: the budget hold + pending stay; idempotency goes pending_reconcile
  idem.markSubmitted(idb, 'op-link', { attemptToken, remoteId: 'synthetic-remote-link', now: T0 });
  idem.markTimeout(idb, 'op-link', { attemptToken, kind: 'timeout', now: T0 });
  const pendingCost = budget.recordPendingCost(bdb, { operationId: 'op-link', attemptToken, cumulativeMicros: 40, remoteId: 'synthetic-remote-link', eventId: 'ev-link-2', now: T0 });
  assert.equal(pendingCost.reservation.pendingMicros, 40);
  assert.equal(idem.reconcileOperation(idb, 'op-link', { attemptToken, query: 'unknown', now: T1 }).decision, 'manual');
  const poolDuring = budget.getBudgetPool(bdb, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(poolDuring.reservedMicros, 100, 'timeout/unknown never releases the hold');
  assert.equal(poolDuring.spentMicros, 0);

  // a retry needs a NEW attempt with its own reserve; the old hold is not reused
  const retryReserved = budget.reserveBudget(bdb, { project: 'proj-a', brand: 'brand-1', currency: 'USD', operationId: 'op-link', attemptToken: `${attemptToken}:retry`, category: 'llm', maxEstimateMicros: 80, priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1, eventId: 'ev-link-3', now: T1 });
  assert.equal(retryReserved.decision, 'granted');
  assert.equal(retryReserved.budget.reservedMicros, 180, 'the previous generation hold is not free for the retry');
  // explicit evidence releases the OLD hold only (pending>0 -> refund evidence)
  const releasedOld = budget.releaseReservation(bdb, { operationId: 'op-link', attemptToken, evidence: 'refund_confirmed', remoteId: 'synthetic-remote-link', eventId: 'ev-link-4', now: T1 });
  assert.equal(releasedOld.decision, 'released');
  assert.equal(releasedOld.budget.reservedMicros, 80);
  assert.equal(releasedOld.budget.spentMicros, 0, 'release keeps spent unchanged');
  const settledRetry = budget.settleReservation(bdb, { operationId: 'op-link', attemptToken: `${attemptToken}:retry`, finalMicros: 70, eventId: 'ev-link-5', now: T2 });
  assert.equal(settledRetry.budget.spentMicros, 70);
  assert.equal(settledRetry.budget.reservedMicros, 0);

  // reopen readback across both separate DBs
  bdb.close();
  idb.close();
  const bdb2 = openDb(budgetDbPath);
  const idb2 = openDb(idemDbPath);
  const poolFinal = budget.getBudgetPool(bdb2, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(poolFinal.spentMicros, 70);
  assert.equal(poolFinal.reservedMicros, 0);
  const idemFinal = idem.getOperation(idb2, 'op-link');
  assert.equal(idemFinal.state, 'pending_reconcile');
  assert.equal(idemFinal.remoteId, 'synthetic-remote-link');
  bdb2.close();
  idb2.close();
});

// ---------- revision-01 focused groups ----------

test('T2.4-rev01 F1: reserve request identity replays the original outcome', { skip }, () => {
  const { db } = freshBudget('f1r1');
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 100, now: T0 });
  const base = { project: 'proj-a', brand: 'brand-1', currency: 'USD', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };

  // blocked replay returns the original blocked decision (no-op, zero writes)
  const blockedReq = { ...base, operationId: 'op-b', attemptToken: 'att-1', maxEstimateMicros: 150, eventId: 'ev-b' };
  const b1 = budget.reserveBudget(db, { ...blockedReq, now: T0 });
  assert.equal(b1.decision, 'blocked');
  assert.equal(b1.reason, 'budget_exceeded');
  const snapshot = { pool: JSON.stringify(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })), events: db.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n };
  const b2 = budget.reserveBudget(db, { ...blockedReq, now: T1 });
  assert.equal(b2.decision, 'blocked', 'a blocked request replays as blocked, not ConflictError');
  assert.equal(b2.reason, 'budget_exceeded');
  assert.equal(JSON.stringify(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })), snapshot.pool, 'replay writes nothing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n, snapshot.events);
  assert.throws(() => budget.reserveBudget(db, { ...blockedReq, maxEstimateMicros: 151, now: T1 }), /different payload/);

  // no_pool replay stays blocked even after the pool is created (same event never upgrades)
  const noPoolReq = { ...base, currency: 'GBP', operationId: 'op-np', attemptToken: 'att-1', maxEstimateMicros: 10, eventId: 'ev-np' };
  assert.equal(budget.reserveBudget(db, { ...noPoolReq, now: T0 }).reason, 'no_budget_pool');
  assert.equal(budget.reserveBudget(db, { ...noPoolReq, now: T0 }).reason, 'no_budget_pool', 'no_pool replay is stable');
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'GBP', limitMicros: 1000, now: T1 });
  const n3 = budget.reserveBudget(db, { ...noPoolReq, now: T1 });
  assert.equal(n3.decision, 'blocked', 'a same event never upgrades to a grant after the environment changed');
  assert.equal(n3.reason, 'no_budget_pool');
  const n4 = budget.reserveBudget(db, { ...noPoolReq, eventId: 'ev-np-2', now: T1 });
  assert.equal(n4.decision, 'granted', 'a NEW request/event grants normally');

  // exact immutable config: no null-bound wildcard; the initial remote is part of the request
  const grantReq = { ...base, operationId: 'op-g', attemptToken: 'att-1', maxEstimateMicros: 60, eventId: 'ev-g' };
  assert.equal(budget.reserveBudget(db, { ...grantReq, now: T0 }).decision, 'granted');
  assert.equal(budget.reserveBudget(db, { ...grantReq, now: T0 }).decision, 'duplicate', 'same request replay is a read-back');
  assert.equal(budget.reserveBudget(db, { ...grantReq, eventId: 'ev-g-2', now: T0 }).decision, 'duplicate', 'same config with a new event is still a non-grant duplicate');
  const before = { pool: JSON.stringify(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })), events: db.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n };
  assert.throws(() => budget.reserveBudget(db, { ...grantReq, maxEstimateMicros: undefined, eventId: 'ev-g-3', now: T0 }), /different payload\/config/);
  assert.throws(() => budget.reserveBudget(db, { ...grantReq, maxEstimateMicros: 61, eventId: 'ev-g-4', now: T0 }), /different payload\/config/);
  assert.throws(() => budget.reserveBudget(db, { ...grantReq, remoteId: 'r-other', eventId: 'ev-g-5', now: T0 }), /different payload\/config/);
  assert.throws(() => budget.reserveBudget(db, { ...grantReq, category: 'search', eventId: 'ev-g-6', now: T0 }), /different payload\/config/);
  assert.equal(JSON.stringify(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })), before.pool, 'conflicting configs write nothing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n, before.events);

  // a callback first-bind is later MUTABLE state, not part of the immutable request
  budget.recordPendingCost(db, { operationId: 'op-g', attemptToken: 'att-1', cumulativeMicros: 10, remoteId: 'r-callback', eventId: 'ev-g-pending', now: T0 });
  assert.equal(budget.reserveBudget(db, { ...grantReq, now: T1 }).decision, 'duplicate', 'the original request still replays as duplicate after a later remote binding');
  // a new attempt reserves its own
  assert.equal(budget.reserveBudget(db, { ...grantReq, attemptToken: 'att-2', maxEstimateMicros: 30, eventId: 'ev-g-retry', now: T1 }).decision, 'granted');
  db.close();
});

test('T2.4-rev01 F2: exact opaque per-attempt remote binding across cost mutations', { skip }, () => {
  const { db } = freshBudget('f2r1');
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 10000, now: T0 });
  const base = { project: 'proj-a', brand: 'brand-1', currency: 'USD', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };
  const snapshot = () => ({
    pool: JSON.stringify(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })),
    reservation: JSON.stringify(budget.listReservations(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })),
    events: db.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n
  });

  // opaque exact binding: same keeps, different conflicts with zero writes (pending)
  const opaqueA = ' spaced;opaque=A=1 ';
  budget.reserveBudget(db, { ...base, operationId: 'op-p', attemptToken: 'att-1', maxEstimateMicros: 100, remoteId: opaqueA, eventId: 'ev-p-r', now: T0 });
  budget.recordPendingCost(db, { operationId: 'op-p', attemptToken: 'att-1', cumulativeMicros: 10, remoteId: opaqueA, eventId: 'ev-p-1', now: T0 });
  const beforeConflict = snapshot();
  assert.throws(() => budget.recordPendingCost(db, { operationId: 'op-p', attemptToken: 'att-1', cumulativeMicros: 20, remoteId: 'different-remote', eventId: 'ev-p-2', now: T0 }), /different remote reference/);
  assert.equal(JSON.stringify(snapshot()), JSON.stringify(beforeConflict), 'a conflicting pending writes nothing');

  // settle: different remote conflicts; same remote settles
  assert.throws(() => budget.settleReservation(db, { operationId: 'op-p', attemptToken: 'att-1', finalMicros: 15, remoteId: 'different-remote', eventId: 'ev-p-3', now: T0 }), /different remote reference/);
  assert.equal(budget.settleReservation(db, { operationId: 'op-p', attemptToken: 'att-1', finalMicros: 15, remoteId: opaqueA, eventId: 'ev-p-4', now: T0 }).decision, 'settled');

  // late charge: different remote conflicts; same remote records
  assert.throws(() => budget.recordLateCharge(db, { operationId: 'op-p', attemptToken: 'att-1', chargeMicros: 5, evidence: 'synthetic: late', remoteId: 'different-remote', eventId: 'ev-p-5', now: T0 }), /different remote reference/);
  assert.equal(budget.recordLateCharge(db, { operationId: 'op-p', attemptToken: 'att-1', chargeMicros: 5, evidence: 'synthetic: late', remoteId: opaqueA, eventId: 'ev-p-6', now: T0 }).decision, 'recorded');

  // release: unknown first bind, then exact-only
  budget.reserveBudget(db, { ...base, operationId: 'op-q', attemptToken: 'att-1', maxEstimateMicros: 50, eventId: 'ev-q-r', now: T0 });
  assert.equal(budget.releaseReservation(db, { operationId: 'op-q', attemptToken: 'att-1', evidence: 'not_submitted', remoteId: 'r-first', eventId: 'ev-q-1', now: T0 }).decision, 'released');

  // unknown (null) first bind on a fresh reservation, then a different id conflicts
  budget.reserveBudget(db, { ...base, operationId: 'op-u', attemptToken: 'att-1', maxEstimateMicros: 50, eventId: 'ev-u-r', now: T0 });
  const boundFirst = budget.recordPendingCost(db, { operationId: 'op-u', attemptToken: 'att-1', cumulativeMicros: 5, remoteId: 'r-unknown-first', eventId: 'ev-u-1', now: T0 });
  assert.equal(boundFirst.reservation.remoteId, 'r-unknown-first', 'unknown may bind once');
  assert.throws(() => budget.recordPendingCost(db, { operationId: 'op-u', attemptToken: 'att-1', cumulativeMicros: 6, remoteId: 'r-other', eventId: 'ev-u-2', now: T0 }), /different remote reference/);
  const beforeReleaseConflict = snapshot();
  assert.throws(() => budget.releaseReservation(db, { operationId: 'op-u', attemptToken: 'att-1', evidence: 'refund_confirmed', remoteId: 'r-other', eventId: 'ev-u-3', now: T0 }), /different remote reference/);
  assert.equal(JSON.stringify(snapshot()), JSON.stringify(beforeReleaseConflict), 'a conflicting release writes nothing');

  // a distinct attempt keeps its own remote; the old reference is preserved
  assert.equal(budget.reserveBudget(db, { ...base, operationId: 'op-u', attemptToken: 'att-2', maxEstimateMicros: 20, remoteId: 'r-second-attempt', eventId: 'ev-u-r2', now: T0 }).decision, 'granted');
  const rows = budget.listReservations(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(rows.find((row) => row.operationId === 'op-u' && row.attemptToken === 'att-1').remoteId, 'r-unknown-first');
  assert.equal(rows.find((row) => row.operationId === 'op-u' && row.attemptToken === 'att-2').remoteId, 'r-second-attempt');
  db.close();
});

test('T2.4-rev01 F3: money aggregates stay exact safe integers', { skip }, () => {
  const { db } = freshBudget('f3r1');
  const MAX = Number.MAX_SAFE_INTEGER;
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: MAX, now: T0 });
  const base = { project: 'proj-a', brand: 'brand-1', currency: 'USD', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };
  budget.reserveBudget(db, { ...base, operationId: 'op-1', attemptToken: 'att-1', maxEstimateMicros: 1, eventId: 'ev-1', now: T0 });
  budget.reserveBudget(db, { ...base, operationId: 'op-2', attemptToken: 'att-1', maxEstimateMicros: 1, eventId: 'ev-2', now: T0 });
  const pool0 = budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(pool0.reservedMicros, 2);

  // a pending of MAX_SAFE would push committed to MAX_SAFE+1 -> fail-closed with zero writes
  const snapshot = {
    pool: JSON.stringify(pool0),
    reservation: JSON.stringify(budget.listReservations(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })),
    events: db.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n
  };
  assert.throws(() => budget.recordPendingCost(db, { operationId: 'op-1', attemptToken: 'att-1', cumulativeMicros: MAX, eventId: 'ev-3', now: T0 }), /exceeds the supported exact safe-integer range/);
  assert.equal(JSON.stringify(budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })), snapshot.pool, 'unsupported aggregate fails with zero writes');
  assert.equal(JSON.stringify(budget.listReservations(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' })), snapshot.reservation);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_events').get().n, snapshot.events);

  // a within-range near-boundary pending is recorded exactly
  const near = budget.recordPendingCost(db, { operationId: 'op-1', attemptToken: 'att-1', cumulativeMicros: MAX - 2, eventId: 'ev-4', now: T0 });
  assert.equal(near.reservation.pendingMicros, MAX - 2);
  assert.equal(near.reservation.overrunMicros, MAX - 3);
  assert.equal(near.budget.committedMicros, MAX - 1, 'exact safe aggregate readback');
  assert.equal(near.budget.remainingMicros, 1);

  // ordinary overrun still settles exactly and the next reserve is blocked
  const settled = budget.settleReservation(db, { operationId: 'op-1', attemptToken: 'att-1', finalMicros: MAX - 2, eventId: 'ev-5', now: T0 });
  assert.equal(settled.decision, 'settled');
  assert.equal(settled.overrunMicros, MAX - 3, 'ordinary overrun recorded exactly');
  assert.equal(settled.budget.spentMicros, MAX - 2);
  const blockedNext = budget.reserveBudget(db, { ...base, operationId: 'op-3', attemptToken: 'att-1', maxEstimateMicros: 5, eventId: 'ev-6', now: T0 });
  assert.equal(blockedNext.decision, 'blocked');
  assert.equal(blockedNext.reason, 'budget_exceeded');
  assert.equal(blockedNext.needMicros, 4, 'need computed exactly');

  // quantity must be a safe positive integer
  assert.throws(() => budget.reserveBudget(db, { ...base, operationId: 'op-4', attemptToken: 'att-1', maxEstimateMicros: 1, quantity: MAX + 2, eventId: 'ev-7', now: T0 }), /safe integer/);
  db.close();

  // signed negative remaining stays an exact safe integer
  const small = freshBudget('f3r1-small');
  budget.ensureBudgetPool(small.db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 10, now: T0 });
  budget.reserveBudget(small.db, { ...base, operationId: 'op-s', attemptToken: 'att-1', maxEstimateMicros: 10, eventId: 'ev-s1', now: T0 });
  const over = budget.settleReservation(small.db, { operationId: 'op-s', attemptToken: 'att-1', finalMicros: 15, eventId: 'ev-s2', now: T0 });
  assert.equal(over.budget.remainingMicros, -5, 'negative remaining is an exact signed safe integer');
  assert.equal(over.overrunMicros, 5);
  small.db.close();
});

test('T2.4-rev01 legal readback: fixed flows and [1-10] migration chain', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'budget-r1-'));
  const dbPath = path.join(dir, 'budget.db');
  const db = openDb(dbPath);
  // full [1-10] isolated chain: up -> backup -> down to 9 -> re-up 10 -> restore verify
  assert.deepEqual(migrateUp(db, [core, m2, m3, m4, m5, m6, m7, m8, m9, m10]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const backupPath = path.join(dir, 'budget-1to10-backup.db');
  backupTo(db, backupPath);
  assert.deepEqual(migrateDown(db, [core, m2, m3, m4, m5, m6, m7, m8, m9, m10], { to: 9 }), [10]);
  const eventColsAfterDown = db.prepare('PRAGMA table_info(budget_events)').all().map((column) => column.name);
  assert.ok(!eventColsAfterDown.includes('outcome'), 'down removed the 0010 columns');
  assert.deepEqual(migrateUp(db, [m10]), [10], 're-up 0010 after down');
  const restored = verifyDatabaseFile(backupPath, { expectedTables: ['budget_pools', 'budget_reservations', 'budget_events'] });
  assert.equal(restored.ok, true, JSON.stringify(restored));

  // normal flow still works end to end (grant -> pending -> settle -> readback)
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 1000, now: T0 });
  const base = { project: 'proj-a', brand: 'brand-1', currency: 'USD', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };
  const granted = budget.reserveBudget(db, { ...base, operationId: 'op-r', attemptToken: 'att-1', maxEstimateMicros: 100, remoteId: 'r-readback', eventId: 'ev-r1', now: T0 });
  assert.equal(granted.decision, 'granted');
  budget.recordPendingCost(db, { operationId: 'op-r', attemptToken: 'att-1', cumulativeMicros: 40, remoteId: 'r-readback', eventId: 'ev-r2', now: T0 });
  const settled = budget.settleReservation(db, { operationId: 'op-r', attemptToken: 'att-1', finalMicros: 60, remoteId: 'r-readback', eventId: 'ev-r3', now: T0 });
  assert.equal(settled.budget.spentMicros, 60);
  assert.equal(settled.budget.remainingMicros, 940);
  db.close();
  const db2 = openDb(dbPath);
  const pool = budget.getBudgetPool(db2, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(pool.spentMicros, 60);
  const rows = budget.listReservations(db2, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(rows[0].remoteId, 'r-readback');
  assert.equal(rows[0].settledMicros, 60);
  db2.close();
});

// ---------- revision-02 focused group ----------

test('T2.4-rev02 F1: reserve identity is checked before the target pool', { skip }, () => {
  const { db } = freshBudget('f1r2');
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD', limitMicros: 1000, now: T0 });
  const base = { project: 'proj-a', brand: 'brand-1', currency: 'USD', category: 'llm', priceBasis: 'unit-price-v1', priceConfidence: 'confident', quantity: 1 };

  // existing reservation: changing the domain to a pool-less one must CONFLICT with zero writes
  const original = { ...base, operationId: 'op-d', attemptToken: 'att-1', maxEstimateMicros: 100, eventId: 'ev-d1' };
  assert.equal(budget.reserveBudget(db, { ...original, now: T0 }).decision, 'granted');
  const snapshot = () => ({
    pools: JSON.stringify(db.prepare('SELECT * FROM budget_pools ORDER BY id').all()),
    reservations: JSON.stringify(db.prepare('SELECT * FROM budget_reservations ORDER BY reservation_id').all()),
    events: JSON.stringify(db.prepare('SELECT * FROM budget_events ORDER BY event_id').all())
  });
  const before = snapshot();
  assert.throws(() => budget.reserveBudget(db, { ...original, project: 'proj-other', eventId: 'ev-d2', now: T1 }), /different payload\/config/);
  assert.throws(() => budget.reserveBudget(db, { ...original, brand: 'brand-other', eventId: 'ev-d3', now: T1 }), /different payload\/config/);
  assert.throws(() => budget.reserveBudget(db, { ...original, currency: 'EUR', eventId: 'ev-d4', now: T1 }), /different payload\/config/);
  assert.equal(JSON.stringify(snapshot()), JSON.stringify(before), 'domain conflicts are three-table zero writes (no no_pool event)');

  // the same event replay of the ORIGINAL request still returns the original decision
  assert.equal(budget.reserveBudget(db, { ...original, now: T1 }).decision, 'duplicate');

  // a genuinely new operation in a pool-less domain keeps the persistent no_pool decision
  const genuine = { ...base, currency: 'GBP', operationId: 'op-genuine', attemptToken: 'att-1', maxEstimateMicros: 10, eventId: 'ev-g1' };
  const g1 = budget.reserveBudget(db, { ...genuine, now: T0 });
  assert.equal(g1.decision, 'blocked');
  assert.equal(g1.reason, 'no_budget_pool');
  assert.equal(budget.reserveBudget(db, { ...genuine, now: T1 }).reason, 'no_budget_pool', 'no_pool replay is stable');
  budget.ensureBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'GBP', limitMicros: 500, now: T1 });
  assert.equal(budget.reserveBudget(db, { ...genuine, now: T1 }).reason, 'no_budget_pool', 'the same event never upgrades after the pool appears');
  assert.equal(budget.reserveBudget(db, { ...genuine, eventId: 'ev-g2', now: T1 }).decision, 'granted', 'a NEW request/event grants normally');

  // callback first-bind keeps the original request duplicate
  budget.recordPendingCost(db, { operationId: 'op-d', attemptToken: 'att-1', cumulativeMicros: 10, remoteId: 'r-callback', eventId: 'ev-d5', now: T0 });
  assert.equal(budget.reserveBudget(db, { ...original, now: T1 }).decision, 'duplicate', 'the immutable request still replays as duplicate after a later remote binding');

  // legal readback (merged)
  const pool = budget.getBudgetPool(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(pool.reservedMicros, 100);
  const rows = budget.listReservations(db, { project: 'proj-a', brand: 'brand-1', currency: 'USD' });
  assert.equal(rows.find((row) => row.operationId === 'op-d').remoteId, 'r-callback');
  assert.equal(rows.find((row) => row.operationId === 'op-d').pendingMicros, 10);
  db.close();
});
