'use strict';
/**
 * T1.6 — Memory rule scope/version/correction tests.
 * Real SQLite with the approved memory_rules schema; synthetic fixtures only (no real listing
 * facts or private values). Temporary files only under $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const { openDb, migrateUp } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const memory = require(path.join(W, 'lib', 'commerce', 'memory.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.6 tests write only to the private runtime tmp';

function freshDb(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `memory-${label}-`));
  const dbPath = path.join(dir, 'commerce.db');
  const db = openDb(dbPath);
  migrateUp(db, [core]);
  return { dir, dbPath, db };
}

function activeRule(db, project, input) {
  const candidate = memory.createCandidate(db, project, input);
  return memory.confirmRule(db, project, candidate.id).active;
}

test('candidate -> user confirmation -> active SQL injection -> correction chain -> reopen readback', { skip }, () => {
  const { db, dbPath } = freshDb('chain');
  const candidate = memory.createCandidate(db, 'proj-a', {
    scope: 'product', scopeKey: 'widget-a', ruleKey: 'color', value: 'blue', source: 'synthetic-discovery'
  });
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.version, 1);
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-a' }), [], 'candidates are never injected');

  const confirmed = memory.confirmRule(db, 'proj-a', candidate.id);
  assert.equal(confirmed.active.status, 'active');
  assert.equal(confirmed.active.value, 'blue');
  assert.equal(confirmed.active.version, 2);
  assert.equal(confirmed.previous.status, 'superseded');
  assert.equal(confirmed.previous.supersededBy, confirmed.active.id);
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-a' }).map((r) => [r.ruleKey, r.value]), [['color', 'blue']]);

  const query = memory.buildInjectionQuery({ productKey: 'widget-a' });
  assert.ok(query.injects && query.sql.includes("status = 'active'") && query.sql.includes('scope_key = ?'), 'injection uses explicit parameterized SQL');
  assert.deepEqual(query.params.slice(1), ['product', 'widget-a']);
  assert.ok(query.params[0].endsWith('Z'), 'the reference instant is normalized for SQL comparison');

  const corrected = memory.correctRule(db, 'proj-a', confirmed.active.id, { value: 'green', source: 'user-correction' });
  assert.equal(corrected.active.value, 'green');
  assert.equal(corrected.active.version, 3);
  assert.equal(corrected.previous.supersededBy, corrected.active.id);
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-a' }).map((r) => r.value), ['green']);

  assert.deepEqual(memory.getRuleChain(db, 'proj-a', candidate.id).map((r) => [r.version, r.status, r.value]), [
    [1, 'superseded', 'blue'],
    [2, 'superseded', 'blue'],
    [3, 'active', 'green']
  ]);

  db.close();
  const reopened = openDb(dbPath);
  const active = memory.getActiveRules(reopened, 'proj-a', { productKey: 'widget-a' });
  assert.equal(active.length, 1);
  assert.equal(active[0].value, 'green');
  assert.equal(active[0].version, 3);
  assert.deepEqual(memory.getRuleChain(reopened, 'proj-a', candidate.id).map((r) => r.version), [1, 2, 3], 'chain survives reopen');
  reopened.close();
});

test('cross-brand and white-label product/category isolation', { skip }, () => {
  const { db } = freshDb('isolation');
  activeRule(db, 'proj-a', { scope: 'brand', scopeKey: 'brand-a', ruleKey: 'tone', value: 'bold', source: 'synthetic' });
  activeRule(db, 'proj-a', { scope: 'brand', scopeKey: 'brand-b', ruleKey: 'tone', value: 'calm', source: 'synthetic' });
  activeRule(db, 'proj-a', { scope: 'product', scopeKey: 'widget-a', ruleKey: 'color', value: 'blue', source: 'synthetic' });
  activeRule(db, 'proj-a', { scope: 'product', scopeKey: 'widget-b', ruleKey: 'color', value: 'red', source: 'synthetic' });
  activeRule(db, 'proj-a', { scope: 'category', scopeKey: 'widgets', ruleKey: 'material', value: 'steel', source: 'synthetic' });
  activeRule(db, 'proj-b', { scope: 'product', scopeKey: 'widget-a', ruleKey: 'color', value: 'black', source: 'synthetic' });

  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { brandKey: 'brand-a' }).map((r) => r.value), ['bold'], 'brand A rules never inject for brand B');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { brandKey: 'brand-b' }).map((r) => r.value), ['calm']);
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { brandKey: null }), [], 'null brand is not a wildcard');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', {}), [], 'empty context injects nothing');

  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-a' }).map((r) => r.value), ['blue'], 'white-label products stay separate');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-b' }).map((r) => r.value), ['red']);
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { categoryKey: 'widgets' }).map((r) => r.value), ['steel']);
  assert.deepEqual(
    memory.getActiveRules(db, 'proj-a', { productKey: 'widget-a', categoryKey: 'widgets' }).map((r) => r.ruleKey),
    ['material', 'color'],
    'category and product rules both inject (ordered by scope)'
  );

  assert.deepEqual(memory.getActiveRules(db, 'proj-b', { productKey: 'widget-a' }).map((r) => r.value), ['black'], 'projects stay isolated');
  db.close();
});

test('candidate/rejected gating and run-scoped reuse without leakage', { skip }, () => {
  const { db } = freshDb('gating');
  const candidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'widget-a', ruleKey: 'size', value: 'M', source: 'synthetic' });
  const rejected = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'widget-a', ruleKey: 'size', value: 'L', source: 'synthetic' });
  memory.rejectRule(db, 'proj-a', rejected.id);
  activeRule(db, 'proj-a', { scope: 'run', scopeKey: 'run-1', ruleKey: 'channel', value: 'sample-run-1', source: 'synthetic' });
  activeRule(db, 'proj-a', { scope: 'run', scopeKey: 'run-2', ruleKey: 'channel', value: 'sample-run-2', source: 'synthetic' });
  activeRule(db, 'proj-a', { scope: 'market', scopeKey: 'amazon-us', ruleKey: 'locale', value: 'en-US', source: 'synthetic' });
  activeRule(db, 'proj-a', { scope: 'product', scopeKey: 'widget-a', ruleKey: 'color', value: 'blue', source: 'synthetic' });

  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-a' }).map((r) => r.ruleKey), ['color'], 'candidate and rejected rules are not injected');
  assert.equal(memory.getRule(db, 'proj-a', candidate.id).status, 'candidate', 'the candidate stays a candidate');

  const run1 = memory.getActiveRules(db, 'proj-a', { runId: 'run-1', productKey: 'widget-a', marketKey: 'amazon-us' });
  assert.deepEqual(run1.map((r) => [r.scope, r.ruleKey]), [['market', 'locale'], ['product', 'color'], ['run', 'channel']], 'shared rules are reused across runs');
  const run2 = memory.getActiveRules(db, 'proj-a', { runId: 'run-2', productKey: 'widget-a', marketKey: 'amazon-us' });
  assert.deepEqual(run2.map((r) => r.value), ['en-US', 'blue', 'sample-run-2'], 'run-1 rules never leak into run-2');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { runId: 'run-1' }).map((r) => r.value), ['sample-run-1']);
  db.close();
});

test('validation and transition negatives', { skip }, () => {
  const { db } = freshDb('negatives');
  assert.throws(() => memory.createCandidate(db, 'proj-a', { scope: 'supplier', scopeKey: 'x', ruleKey: 'k', value: 'v' }), /scope/);
  assert.throws(() => memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: '', ruleKey: 'k', value: 'v' }), /scopeKey/);
  assert.throws(() => memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'x', ruleKey: 'k' }), /JSON-compatible/);
  assert.throws(() => memory.getActiveRules(db, 'proj-a', { unknownKey: 'x' }), /not a known field/);
  assert.equal(memory.buildInjectionQuery({ productKey: '' }).injects, false, 'blank context keys inject nothing');

  const candidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'widget-a', ruleKey: 'color', value: 'blue', source: 'synthetic' });
  assert.equal(memory.getRule(db, 'proj-b', candidate.id), null, 'cross-project reads are refused');
  assert.throws(() => memory.confirmRule(db, 'proj-b', candidate.id), /not found/);
  assert.throws(() => memory.correctRule(db, 'proj-a', candidate.id), /must be active/);

  const rejected = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'widget-a', ruleKey: 'note', value: 'x', source: 'synthetic' });
  memory.rejectRule(db, 'proj-a', rejected.id);
  assert.throws(() => memory.confirmRule(db, 'proj-a', rejected.id), /must be candidate/);
  assert.throws(() => memory.rejectRule(db, 'proj-a', rejected.id), /must be candidate/);

  const active = memory.confirmRule(db, 'proj-a', candidate.id).active;
  assert.throws(() => memory.rejectRule(db, 'proj-a', active.id), /must be candidate/);
  const corrected = memory.correctRule(db, 'proj-a', active.id, { value: 'green' }).active;
  assert.throws(() => memory.correctRule(db, 'proj-a', active.id), /already superseded/);
  assert.throws(() => memory.confirmRule(db, 'proj-a', candidate.id), /already superseded/);
  assert.equal(memory.getRule(db, 'proj-a', corrected.id).status, 'active');
  db.close();
});

test('effective-time contract: real ISO instants, no early injection, omission inherits', { skip }, () => {
  const { db } = freshDb('time');
  for (const bad of ['2026-02-30T12:00:00Z', '2026-02-29T12:00:00Z', '2026-13-01T00:00:00Z', '2026-10-08T00:00:00', '2026-10-08', 'not-a-date', '2026-10-08T25:00:00Z', '2026-10-08T00:00:00+0800']) {
    assert.throws(
      () => memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'time-bad', ruleKey: 'k', value: 'synthetic', effectiveAt: bad }),
      /instant/,
      `effectiveAt ${bad} must be rejected before any write`
    );
  }

  const future = '2099-01-01T00:00:00Z';
  const futureCandidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'time-explicit', ruleKey: 'k', value: 'FUTURE-SYNTHETIC', effectiveAt: future });
  const futureActive = memory.confirmRule(db, 'proj-a', futureCandidate.id, { effectiveAt: future }).active;
  assert.equal(futureActive.effectiveAt, future, 'explicit valid override is stored verbatim');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'time-explicit' }), [], 'future rules are not injected before their time');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'time-explicit' }, { asOf: '2098-12-31T23:59:59Z' }), []);
  assert.equal(memory.getActiveRules(db, 'proj-a', { productKey: 'time-explicit' }, { asOf: '2099-01-01T00:00:00Z' }).length, 1, 'the effective boundary is inclusive');

  const offsetCandidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'time-offset', ruleKey: 'k', value: 'OFFSET-SYNTHETIC', effectiveAt: '2099-01-01T08:00:00+08:00' });
  memory.confirmRule(db, 'proj-a', offsetCandidate.id);
  assert.equal(memory.getActiveRules(db, 'proj-a', { productKey: 'time-offset' }, { asOf: '2099-01-01T00:00:00Z' }).length, 1, 'instants compare equal across offsets, not by string order');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'time-offset' }, { asOf: '2098-12-31T23:59:59Z' }), []);

  const defaultCandidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'time-default', ruleKey: 'k', value: 'DEFAULT-SYNTHETIC', effectiveAt: future });
  const defaultActive = memory.confirmRule(db, 'proj-a', defaultCandidate.id).active;
  assert.equal(defaultActive.effectiveAt, future, 'omitted confirmation time inherits the candidate schedule, never silently now');
  const nullCandidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'time-null', ruleKey: 'k', value: 'NULL-SYNTHETIC', effectiveAt: future });
  assert.equal(memory.confirmRule(db, 'proj-a', nullCandidate.id, { effectiveAt: null }).active.effectiveAt, future, 'null override inherits too');

  const corrected = memory.correctRule(db, 'proj-a', defaultActive.id, { value: 'CORRECTED-SYNTHETIC', effectiveAt: '2099-06-01T00:00:00Z' }).active;
  assert.equal(corrected.effectiveAt, '2099-06-01T00:00:00Z');
  assert.equal(memory.getRule(db, 'proj-a', defaultActive.id).effectiveAt, future, 'history keeps its declared time');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'time-default' }), [], 'the superseded future rule never injects either');

  const noTime = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'time-now', ruleKey: 'k', value: 'NOW-SYNTHETIC' });
  const noTimeActive = memory.confirmRule(db, 'proj-a', noTime.id).active;
  assert.ok(typeof noTimeActive.effectiveAt === 'string' && noTimeActive.effectiveAt.endsWith('Z'), 'a source without a declared time falls back to the activation instant');
  assert.equal(memory.getActiveRules(db, 'proj-a', { productKey: 'time-now' }).length, 1, 'past/undated rules inject immediately');
  db.close();
});

test('affected legal path: past-dated confirm/correct inject, chain and reopen keep times', { skip }, () => {
  const { db, dbPath } = freshDb('time-legal');
  const past = '2026-01-01T00:00:00Z';
  const candidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey: 'widget-time', ruleKey: 'color', value: 'blue', source: 'synthetic', effectiveAt: past });
  const confirmed = memory.confirmRule(db, 'proj-a', candidate.id).active;
  assert.equal(confirmed.effectiveAt, past);
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-time' }).map((r) => r.value), ['blue']);

  const query = memory.buildInjectionQuery({ productKey: 'widget-time' }, { asOf: '2026-06-01T00:00:00Z' });
  assert.ok(query.sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ', effective_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', ?)"), 'SQL gates on the effective instant with millisecond precision');
  assert.deepEqual(query.params.slice(1), ['product', 'widget-time']);

  const corrected = memory.correctRule(db, 'proj-a', confirmed.id, { value: 'green' }).active;
  assert.equal(corrected.effectiveAt, past, 'correction without a time keeps the declared schedule');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'widget-time' }).map((r) => r.value), ['green']);

  db.close();
  const reopened = openDb(dbPath);
  assert.equal(memory.getActiveRules(reopened, 'proj-a', { productKey: 'widget-time' })[0].value, 'green');
  assert.deepEqual(memory.getRuleChain(reopened, 'proj-a', candidate.id).map((r) => [r.version, r.effectiveAt]), [[1, past], [2, past], [3, past]], 'times survive reopen');
  reopened.close();
});

test('millisecond-precision effective comparison keeps due peers while excluding future rows', { skip }, () => {
  const { db } = freshDb('ms');
  const base = '2099-01-01T00:00:00';
  const mk = (scopeKey, ruleKey, effectiveAt) => {
    const candidate = memory.createCandidate(db, 'proj-a', { scope: 'product', scopeKey, ruleKey, value: `SYN-${ruleKey}`, effectiveAt });
    return memory.confirmRule(db, 'proj-a', candidate.id).active;
  };
  const due = mk('ms-key', 'due', `${base}.100Z`);
  const equal = mk('ms-key', 'equal', `${base}.500Z`);
  const future = mk('ms-key', 'future', `${base}.900Z`);
  mk('ms-offset', 'offset', '2099-01-01T08:00:00.250+08:00');

  // regression: at .100 the .900 future row must be excluded by the SQL/epoch gate and must never
  // abort the request or block the due peers that share the same whole second
  const at100 = memory.getActiveRules(db, 'proj-a', { productKey: 'ms-key' }, { asOf: `${base}.100Z` });
  assert.deepEqual(at100.map((r) => r.id), [due.id], 'due peer returned; same-second future row excluded without blocking');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'ms-key' }, { asOf: `${base}.499Z` }).map((r) => r.id), [due.id], 'before .500 only the earlier rule');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'ms-key' }, { asOf: `${base}.500Z` }).map((r) => r.id).sort(), [due.id, equal.id].sort(), 'the equal boundary is inclusive at millisecond precision');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'ms-key' }, { asOf: `${base}.899Z` }).map((r) => r.id).sort(), [due.id, equal.id].sort(), 'one millisecond before the future rule');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'ms-key' }, { asOf: `${base}.900Z` }).map((r) => r.id).sort(), [due.id, equal.id, future.id].sort(), 'the future rule joins exactly at its instant');

  const query = memory.buildInjectionQuery({ productKey: 'ms-key' }, { asOf: `${base}.100Z` });
  const sqlIds = db.prepare(query.sql).all('proj-a', ...query.params).map((row) => row.id);
  assert.deepEqual(sqlIds, [due.id], 'the SQL gate itself keeps millisecond precision (no truncation)');

  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'ms-offset' }, { asOf: '2099-01-01T00:00:00.249Z' }), [], 'offset rule not due 1ms before its instant');
  assert.deepEqual(memory.getActiveRules(db, 'proj-a', { productKey: 'ms-offset' }, { asOf: '2099-01-01T00:00:00.250Z' }).map((r) => r.ruleKey), ['offset'], 'offset-equivalent instant compares equal at millisecond precision');
  db.close();
});
