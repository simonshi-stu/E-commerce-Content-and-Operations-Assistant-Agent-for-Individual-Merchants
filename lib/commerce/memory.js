'use strict';
/**
 * Long-term memory rules: scoped, versioned, correctable (T1.6).
 *
 * Semantics (recorded in HANDOFF):
 * - Scopes: product | category | brand | market | run (matching the approved memory_rules
 *   schema). scope_key identifies the concrete product/category/brand/market/run inside a project.
 * - Statuses: candidate | active | rejected | superseded. Candidates are NEVER injected; only
 *   'active' rules are returned by getActiveRules. Values are never edited in place: confirmation
 *   and correction always create a NEW active version and mark the previous row(s) superseded_by
 *   the new one (correction chain, walkable via getRuleChain). Rejection is an in-place status
 *   change on a candidate and creates no value version. At most one active rule per
 *   (project, scope, scope_key, rule_key) is kept: confirming a candidate also supersedes any
 *   previously active row for that key.
 * - Injection is explicit SQL: buildInjectionQuery constructs a parameterized query from the
 *   provided context keys (one OR branch per scope using `scope_key = ?`); getActiveRules runs it
 *   and then re-verifies in code that every returned row is active and matches the requested
 *   context. There is no vector search and no default export: an empty context injects nothing.
 * - Isolation: every query is project-scoped. Brand rules inject only for the exact brand key — a
 *   missing/null brandKey injects NO brand rules (null is not a wildcard). White-label
 *   products/categories separate by scope_key (brand=null never merges different products or
 *   appearances). Run-scoped rules never leak to another run while shared product/category/market
 *   rules are reusable across runs.
 * - Values are JSON-compatible (validated with the approved assertJsonCompatible contract) and
 *   stored as JSON text; source records provenance text. Model confidence is not user
 *   confirmation: creating a candidate never activates anything.
 * - Effective time: effectiveAt must be a real-calendar ISO instant with an explicit timezone
 *   (YYYY-MM-DDThh:mm:ss[.sss]Z or ±hh:mm) and is stored verbatim. Invalid calendar values,
 *   missing timezones and arbitrary strings are rejected before any write — an explicit invalid
 *   value is never silently replaced with "now". Confirmation/correction without an explicit time
 *   keeps the source row's declared effective time; only a source without any time falls back to
 *   the activation instant. Future-dated rules may be recorded active but are NOT injected before
 *   their effective time: the SQL condition normalizes both sides with
 *   strftime('%Y-%m-%dT%H:%M:%fZ', …) so millisecond precision and timezone offsets compare as
 *   actual instants (never string order across offsets), and the code re-checks epochs, excluding
 *   not-yet-due rows without blocking due peers (unparseable stored times fail closed). There is
 *   no fallback that keeps a superseded rule effective while waiting — a future correction
 *   supersedes the old active immediately and the new rule injects from its effective time onward.
 *
 * DEV NOTE: development task state (PROGRESS.json) is unrelated to business `runs` state.
 */
const crypto = require('node:crypto');
const { ValidationError, NotFoundError, ConflictError } = require('./evidence.js');
const { assertJsonCompatible } = require('./privacy.js');

const SCOPES = Object.freeze(['product', 'category', 'brand', 'market', 'run']);
const STATUSES = Object.freeze(['candidate', 'active', 'rejected', 'superseded']);
const CONTEXT_KEYS = Object.freeze({ product: 'productKey', category: 'categoryKey', brand: 'brandKey', market: 'marketKey', run: 'runId' });
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

const nowIso = () => new Date().toISOString();
const newId = () => `mr_${crypto.randomUUID()}`;

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
/** Real-calendar ISO instant with explicit timezone; returns epoch ms or null (never lenient). */
function instantEpoch(text) {
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
function requireInstant(value, name) {
  const text = requireNonEmptyString(value, name);
  if (instantEpoch(text) === null) {
    fail(`${name} must be a real-calendar ISO instant with explicit timezone (YYYY-MM-DDThh:mm:ss[.sss]Z or ±hh:mm)`);
  }
  return text;
}
function optionalInstant(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return requireInstant(value, name);
}
function requireScope(scope) {
  if (!SCOPES.includes(scope)) fail(`scope must be one of ${SCOPES.join(', ')}`);
  return scope;
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

function hydrate(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    scope: row.scope,
    scopeKey: row.scope_key,
    ruleKey: row.rule_key,
    value: JSON.parse(row.rule_value_text),
    source: row.source,
    status: row.status,
    version: row.version,
    effectiveAt: row.effective_at,
    supersededBy: row.superseded_by,
    createdAt: row.created_at
  };
}

function getRule(db, projectId, ruleId) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(ruleId, 'ruleId');
  const row = db.prepare('SELECT * FROM memory_rules WHERE project_id = ? AND id = ?').get(project, id);
  return row ? hydrate(row) : null;
}

/** Low-confidence discovery: always a candidate, never injected until a user confirms it. */
function createCandidate(db, projectId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const scope = requireScope(input.scope);
  const scopeKey = requireNonEmptyString(input.scopeKey, 'scopeKey');
  const ruleKey = requireNonEmptyString(input.ruleKey, 'ruleKey');
  assertJsonCompatible(input.value, 'value');
  const valueText = JSON.stringify(input.value);
  const source = optionalNonEmptyString(input.source, 'source');
  const effectiveAt = optionalInstant(input.effectiveAt, 'effectiveAt');
  return withTransaction(db, () => {
    const max = db.prepare('SELECT MAX(version) AS maxVersion FROM memory_rules WHERE project_id = ? AND scope = ? AND scope_key = ? AND rule_key = ?')
      .get(project, scope, scopeKey, ruleKey);
    const version = (max?.maxVersion ?? 0) + 1;
    const id = newId();
    db.prepare(`INSERT INTO memory_rules (id, project_id, scope, scope_key, rule_key, rule_value_text, source, status, version, effective_at, superseded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, NULL, ?)`)
      .run(id, project, scope, scopeKey, ruleKey, valueText, source, version, effectiveAt, nowIso());
    return getRule(db, project, id);
  });
}

/**
 * Shared confirmation/correction engine: creates a NEW active version for the same key, marks the
 * source row superseded by it, and supersedes any other previously active row for that key so at
 * most one active rule remains. History values are never rewritten.
 */
function promote(db, project, sourceRow, input, expectedStatus) {
  if (sourceRow.superseded_by) throw new ConflictError('memory rule is already superseded');
  if (sourceRow.status !== expectedStatus) throw new ConflictError(`memory rule must be ${expectedStatus}, got ${sourceRow.status}`);
  const value = input.value === undefined ? JSON.parse(sourceRow.rule_value_text) : input.value;
  assertJsonCompatible(value, 'value');
  const valueText = JSON.stringify(value);
  const source = optionalNonEmptyString(input.source, 'source') ?? sourceRow.source;
  const hasExplicitTime = input.effectiveAt !== undefined && input.effectiveAt !== null && input.effectiveAt !== '';
  const effectiveAt = hasExplicitTime
    ? requireInstant(input.effectiveAt, 'effectiveAt')
    : (sourceRow.effective_at === null ? nowIso() : requireInstant(sourceRow.effective_at, 'source effectiveAt'));
  return withTransaction(db, () => {
    const max = db.prepare('SELECT MAX(version) AS maxVersion FROM memory_rules WHERE project_id = ? AND scope = ? AND scope_key = ? AND rule_key = ?')
      .get(project, sourceRow.scope, sourceRow.scope_key, sourceRow.rule_key);
    const version = (max?.maxVersion ?? 0) + 1;
    const activeId = newId();
    db.prepare(`INSERT INTO memory_rules (id, project_id, scope, scope_key, rule_key, rule_value_text, source, status, version, effective_at, superseded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?)`)
      .run(activeId, project, sourceRow.scope, sourceRow.scope_key, sourceRow.rule_key, valueText, source, version, effectiveAt, nowIso());
    const guard = db.prepare('UPDATE memory_rules SET status = ?, superseded_by = ? WHERE project_id = ? AND id = ? AND superseded_by IS NULL')
      .run('superseded', activeId, project, sourceRow.id);
    if (guard.changes !== 1) throw new ConflictError('memory rule was superseded concurrently');
    const otherActive = db.prepare("SELECT id FROM memory_rules WHERE project_id = ? AND scope = ? AND scope_key = ? AND rule_key = ? AND status = 'active' AND id != ?")
      .get(project, sourceRow.scope, sourceRow.scope_key, sourceRow.rule_key, activeId);
    if (otherActive) {
      db.prepare('UPDATE memory_rules SET status = ?, superseded_by = ? WHERE project_id = ? AND id = ?')
        .run('superseded', activeId, project, otherActive.id);
    }
    return { previous: getRule(db, project, sourceRow.id), active: getRule(db, project, activeId) };
  });
}

/** User confirmation of a candidate: new active version; the candidate is superseded (not edited). */
function confirmRule(db, projectId, ruleId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(ruleId, 'ruleId');
  const row = db.prepare('SELECT * FROM memory_rules WHERE project_id = ? AND id = ?').get(project, id);
  if (!row) throw new NotFoundError('memory rule not found in this project');
  return promote(db, project, row, input, 'candidate');
}

/** User correction of an active rule: new active version + supersede chain. */
function correctRule(db, projectId, ruleId, input = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(ruleId, 'ruleId');
  const row = db.prepare('SELECT * FROM memory_rules WHERE project_id = ? AND id = ?').get(project, id);
  if (!row) throw new NotFoundError('memory rule not found in this project');
  return promote(db, project, row, input, 'active');
}

/** Rejection of a candidate: in-place status change, value untouched, no new version. */
function rejectRule(db, projectId, ruleId) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(ruleId, 'ruleId');
  const row = db.prepare('SELECT * FROM memory_rules WHERE project_id = ? AND id = ?').get(project, id);
  if (!row) throw new NotFoundError('memory rule not found in this project');
  if (row.superseded_by) throw new ConflictError('memory rule is already superseded');
  if (row.status !== 'candidate') throw new ConflictError(`memory rule must be candidate, got ${row.status}`);
  db.prepare("UPDATE memory_rules SET status = 'rejected' WHERE project_id = ? AND id = ?").run(project, id);
  return getRule(db, project, id);
}

function normalizeContext(context = {}) {
  if (!isPlainObject(context)) fail('context must be a plain object');
  const allowed = Object.values(CONTEXT_KEYS);
  for (const key of Object.keys(context)) {
    if (!allowed.includes(key)) fail(`context.${key} is not a known field`);
  }
  const normalized = {};
  for (const scope of SCOPES) {
    const key = CONTEXT_KEYS[scope];
    const raw = context[key];
    if (raw === undefined || raw === null || raw === '') continue;
    normalized[key] = requireNonEmptyString(raw, key);
  }
  return normalized;
}

/** Explicit parameterized SQL for the active-rule injection (one OR branch per provided scope). */
function buildInjectionQuery(context = {}, options = {}) {
  const normalized = normalizeContext(context);
  const asOf = options.asOf === undefined ? nowIso() : requireInstant(options.asOf, 'asOf');
  const clauses = [];
  const scopeParams = [];
  for (const scope of SCOPES) {
    const key = CONTEXT_KEYS[scope];
    if (normalized[key] === undefined) continue;
    clauses.push('(scope = ? AND scope_key = ?)');
    scopeParams.push(scope, normalized[key]);
  }
  const injects = clauses.length > 0;
  return {
    sql: injects
      ? `SELECT * FROM memory_rules WHERE project_id = ? AND status = 'active' AND (effective_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', effective_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', ?)) AND (${clauses.join(' OR ')}) ORDER BY scope, rule_key, version`
      : null,
    params: [new Date(instantEpoch(asOf)).toISOString(), ...scopeParams],
    context: normalized,
    asOf,
    injects
  };
}

/**
 * Active rules for the given context: candidates/rejected/superseded are never returned, rules
 * whose effective time is still in the future are excluded without aborting due peers (SQL
 * strftime millisecond normalization + a code re-check on actual epochs; unparseable stored times
 * fail closed), an empty context injects nothing (no default export), and every row is re-verified
 * against the context in code.
 */
function getActiveRules(db, projectId, context = {}, options = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const asOf = options.asOf === undefined ? nowIso() : requireInstant(options.asOf, 'asOf');
  const referenceEpoch = instantEpoch(asOf);
  const { sql, params, context: normalized, injects } = buildInjectionQuery(context, { asOf });
  if (!injects) return [];
  const rows = db.prepare(sql).all(project, ...params);
  const active = [];
  for (const row of rows) {
    const rule = hydrate(row);
    const expectedKey = CONTEXT_KEYS[rule.scope];
    if (!expectedKey || normalized[expectedKey] !== rule.scopeKey) {
      throw new ConflictError(`injected rule ${rule.id} does not match the requested context`);
    }
    if (rule.status !== 'active') throw new ConflictError(`injected rule ${rule.id} is not active`);
    if (rule.effectiveAt !== null) {
      const ruleEpoch = instantEpoch(rule.effectiveAt);
      if (ruleEpoch === null) throw new ConflictError(`injected rule ${rule.id} has an invalid effective time`);
      if (ruleEpoch > referenceEpoch) continue; // not yet due: excluded, never blocks due peers
    }
    active.push(rule);
  }
  return active;
}

function listRules(db, projectId, filters = {}) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const clauses = ['project_id = ?'];
  const params = [project];
  if (filters.scope !== undefined) { clauses.push('scope = ?'); params.push(requireScope(filters.scope)); }
  if (filters.scopeKey !== undefined) { clauses.push('scope_key = ?'); params.push(requireNonEmptyString(filters.scopeKey, 'scopeKey')); }
  if (filters.ruleKey !== undefined) { clauses.push('rule_key = ?'); params.push(requireNonEmptyString(filters.ruleKey, 'ruleKey')); }
  if (filters.status !== undefined) {
    if (!STATUSES.includes(filters.status)) fail(`status must be one of ${STATUSES.join(', ')}`);
    clauses.push('status = ?');
    params.push(filters.status);
  }
  return db.prepare(`SELECT * FROM memory_rules WHERE ${clauses.join(' AND ')} ORDER BY scope, scope_key, rule_key, version`).all(...params).map(hydrate);
}

/** Whole correction chain (oldest -> newest) reachable from the given rule via superseded_by. */
function getRuleChain(db, projectId, ruleId) {
  const project = requireNonEmptyString(projectId, 'projectId');
  const id = requireNonEmptyString(ruleId, 'ruleId');
  const start = getRule(db, project, id);
  if (!start) throw new NotFoundError('memory rule not found in this project');
  const collected = new Map();
  const queue = [start.id];
  while (queue.length) {
    const currentId = queue.shift();
    if (collected.has(currentId)) continue;
    const rule = getRule(db, project, currentId);
    if (!rule) continue;
    collected.set(rule.id, rule);
    if (rule.supersededBy) queue.push(rule.supersededBy);
    const predecessors = db.prepare('SELECT id FROM memory_rules WHERE project_id = ? AND superseded_by = ?').all(project, rule.id);
    for (const row of predecessors) queue.push(row.id);
  }
  return [...collected.values()].sort((a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

module.exports = {
  SCOPES,
  STATUSES,
  CONTEXT_KEYS,
  createCandidate,
  confirmRule,
  correctRule,
  rejectRule,
  getRule,
  getActiveRules,
  buildInjectionQuery,
  listRules,
  getRuleChain
};
