'use strict';
/**
 * Agent orchestrator (T2.7, revision-02): finite role/tool DAG validation and single-worker
 * execution on the approved building blocks (T2.1 run-store, T2.2 worker guards, T2.3 operation
 * identity, T2.4 budget, T1.6 memory scoping, T1.5 privacy whitelists, T2.5 provider registry as
 * the fixture transport). No new models, no new frameworks, no background daemon.
 *
 * Semantics (recorded in HANDOFF; revision-01 F1-F7 + revision-02 R-F5/R-F6):
 * - Validation, execution-scope authority, frozen snapshots, recovery re-verification and the
 *   charged-call fact policy are as documented for revision-01.
 * - Effect-boundary fencing (R-F5): every lease-protected effect (plan write, T2.3 claim, T2.4
 *   reserve, tool invocation, fact recording, quality checkpoint, artifact write + checkpoint,
 *   completion) re-checks the CURRENT clock/owner/token and the cancel request AT ITS OWN
 *   BOUNDARY, using a single clock reading that is then bound to that effect (store calls receive
 *   the same instant). A failing boundary stops with a clear lease_lost result and creates no
 *   normal artifact/checkpoint/completion record and no further tool call — the database is never
 *   used as after-the-fact fencing and no unhandled exception replaces the stop semantics.
 * - Late facts (R-F6): when a call actually returned an opaque remote result but the run stops
 *   early (cancel or lost lease), the returned facts are NOT dropped. The current attempt uses
 *   the approved T2.3 structured remote binding (markSubmitted) and the approved T2.4 pending/hold
 *   interface (recordPendingCost with cumulative 0 — the hold is never released or settled by
 *   guesswork), and an isolated, versioned, immutable late-fact receipt plus a journal entry
 *   persist the exact opaque remote, status, usage/diagnostics, project/run/step/operation/
 *   attempt/generation and reservation/hold identity for reconciliation. A superseded attempt can
 *   never pollute a newer generation (stale writes fail closed and only the isolated receipt
 *   remains). not_submitted/effective/final cost are never fabricated.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ValidationError, ConflictError, NotFoundError } = require('./evidence.js');
const { canonicalJson } = require('./packs.js');
const { assertJsonCompatible, applyProfile } = require('./privacy.js');
const { validateValue, assertNoCredentialFields, deepFreeze } = require('./providers/schema.js');
const store = require('./run-store.js');
const worker = require('./worker.js');
const idem = require('./idempotency.js');
const budget = require('./budget.js');
const memory = require('./memory.js');

const ORCHESTRATOR_VERSION = 't2.7-orchestrator-v1.2';
const TASK_TYPE = 'orchestrator.dag.v1';
const ROLES = Object.freeze(['product-understanding', 'research-selection', 'channel-development', 'creative', 'media', 'quality']);
const LIMITS = Object.freeze({
  maxSteps: 16,
  maxDependencies: 8,
  maxInputBytes: 65536,
  maxContextEntries: 64,
  maxContextBytes: 32768,
  maxReworkPerStep: 2,
  maxOutputBytes: 262144
});
const PLAN_FIELDS = Object.freeze(['schemaVersion', 'taskType', 'maxReworkPerStep', 'steps']);
const STEP_FIELDS = Object.freeze(['id', 'role', 'tool', 'dependsOn', 'input', 'quality']);
const QUALITY_FIELDS = Object.freeze(['requireFields', 'minOutputBytes', 'requireEvidence']);
const CONTEXT_FIELDS = Object.freeze(['productKey', 'categoryKey', 'brandKey', 'marketKey', 'runId']);
/** Operation states that may accept a current normal/late return; every other state fails closed. */
const ALLOWED_OPERATION_STATES = Object.freeze(['claimed', 'submitted', 'pending_reconcile']);

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
function requireSafeNonNegativeInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a safe non-negative integer`);
  return value;
}
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
function safeId(value, name) {
  return worker.assertSafePathId(value, name);
}

// ---------- plan validation (before any effect) ----------

function normalizeQuality(step, name) {
  if (step.quality === undefined || step.quality === null) return null;
  if (!isPlainObject(step.quality)) fail(`${name}.quality must be a plain object`);
  for (const key of Object.keys(step.quality)) {
    if (!QUALITY_FIELDS.includes(key)) fail(`${name}.quality.${key} is an unknown field (fail-closed)`);
  }
  const quality = {};
  if (step.quality.requireFields !== undefined) {
    if (!Array.isArray(step.quality.requireFields) || step.quality.requireFields.length === 0) fail(`${name}.quality.requireFields must be a non-empty array`);
    quality.requireFields = step.quality.requireFields.map((entry) => {
      const dotted = requireNonEmptyString(entry, `${name}.quality.requireFields[]`);
      for (const segment of dotted.split('.')) if (segment === '') fail(`${name}.quality.requireFields contains an empty path segment`);
      return dotted;
    });
  }
  if (step.quality.minOutputBytes !== undefined) {
    quality.minOutputBytes = requireSafeNonNegativeInt(step.quality.minOutputBytes, `${name}.quality.minOutputBytes`);
  }
  if (step.quality.requireEvidence !== undefined) {
    if (typeof step.quality.requireEvidence !== 'boolean') fail(`${name}.quality.requireEvidence must be a boolean`);
    quality.requireEvidence = step.quality.requireEvidence;
  }
  return deepFreeze(quality);
}

/**
 * Validate a plan against a frozen registry manifest. Returns {planHash, order, steps, maxReworkPerStep, normalized}
 * or throws before any effect. The stored steps/inputs/quality are deep-frozen snapshots.
 */
function validatePlan(plan, snapshot, limits = LIMITS) {
  if (!isPlainObject(plan)) fail('plan must be a plain object');
  for (const key of Object.keys(plan)) {
    if (!PLAN_FIELDS.includes(key)) fail(`plan.${key} is an unknown field (fail-closed)`);
  }
  if (plan.schemaVersion !== 1) fail('plan.schemaVersion must be 1');
  const taskType = requireNonEmptyString(plan.taskType, 'plan.taskType');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail('plan.steps must be a non-empty array');
  if (plan.steps.length > limits.maxSteps) fail(`plan.steps has ${plan.steps.length} steps which exceeds the trusted limit ${limits.maxSteps}`);
  const maxReworkPerStep = plan.maxReworkPerStep === undefined
    ? limits.maxReworkPerStep
    : requireSafeNonNegativeInt(plan.maxReworkPerStep, 'plan.maxReworkPerStep');
  if (maxReworkPerStep > limits.maxReworkPerStep) fail(`plan.maxReworkPerStep exceeds the trusted limit ${limits.maxReworkPerStep} (a plan can only tighten it)`);

  const steps = new Map();
  for (const [index, step] of plan.steps.entries()) {
    const name = `plan.steps[${index}]`;
    if (!isPlainObject(step)) fail(`${name} must be a plain object`);
    for (const key of Object.keys(step)) {
      if (!STEP_FIELDS.includes(key)) fail(`${name}.${key} is an unknown field (fail-closed)`);
    }
    const id = safeId(requireNonEmptyString(step.id, `${name}.id`), `${name}.id`);
    if (steps.has(id)) fail(`duplicate step id ${id} (fail-closed)`);
    const role = requireNonEmptyString(step.role, `${name}.role`);
    if (!ROLES.includes(role)) fail(`unknown role ${role} (fail-closed)`);
    const toolName = requireNonEmptyString(step.tool, `${name}.tool`);
    const toolEntry = snapshot.tools.find((entry) => entry.name === toolName);
    if (!toolEntry) fail(`unknown tool ${toolName} (not in the registry snapshot; fail-closed)`);
    if (!toolEntry.roles.includes(role)) fail(`role ${role} is not allowed to use tool ${toolName} (role allowlist)`);
    const rawDeps = step.dependsOn === undefined || step.dependsOn === null ? [] : step.dependsOn;
    if (!Array.isArray(rawDeps)) fail(`${name}.dependsOn must be an array`);
    if (rawDeps.length > limits.maxDependencies) fail(`${name}.dependsOn exceeds the trusted limit ${limits.maxDependencies}`);
    const dependsOn = [];
    for (const dep of rawDeps) {
      const depId = requireNonEmptyString(dep, `${name}.dependsOn[]`);
      if (depId === id) fail(`step ${id} depends on itself (fail-closed)`);
      if (dependsOn.includes(depId)) fail(`step ${id} lists dependency ${depId} twice (fail-closed)`);
      dependsOn.push(depId);
    }
    const input = step.input === undefined ? deepFreeze({}) : deepFreeze(jsonClone(step.input));
    assertJsonCompatible(input, `${name}.input`);
    assertNoCredentialFields(input, `${name}.input`);
    validateValue(toolEntry.inputSchema, input, `${name}.input`);
    const inputBytes = Buffer.byteLength(canonicalJson(input), 'utf8');
    if (inputBytes > limits.maxInputBytes) fail(`step ${id} input is ${inputBytes} bytes which exceeds the trusted limit ${limits.maxInputBytes}`);
    steps.set(id, deepFreeze({
      id,
      role,
      tool: toolName,
      toolVersion: toolEntry.version,
      contractHash: toolEntry.contractHash,
      dependsOn: Object.freeze([...dependsOn]),
      input,
      quality: normalizeQuality(step, name)
    }));
  }
  for (const step of steps.values()) {
    for (const dep of step.dependsOn) {
      if (!steps.has(dep)) fail(`step ${step.id} depends on unknown step ${dep} (fail-closed)`);
    }
  }
  const indegree = new Map([...steps.keys()].map((id) => [id, steps.get(id).dependsOn.length]));
  const dependents = new Map([...steps.keys()].map((id) => [id, []]));
  for (const step of steps.values()) {
    for (const dep of step.dependsOn) dependents.get(dep).push(step.id);
  }
  const order = [];
  const queue = [...steps.keys()].filter((id) => indegree.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== steps.size) fail('plan.steps contains a dependency cycle (fail-closed)');
  const normalized = deepFreeze({
    schemaVersion: 1,
    taskType,
    maxReworkPerStep,
    steps: order.map((id) => {
      const step = steps.get(id);
      return { id: step.id, role: step.role, tool: step.tool, toolVersion: step.toolVersion, dependsOn: step.dependsOn, input: step.input, quality: step.quality };
    })
  });
  const planHash = sha256Hex(canonicalJson(normalized));
  return { planHash, order, steps, maxReworkPerStep, normalized };
}

// ---------- SQL-scoped, bounded context ----------

function loadContext(db, projectId, context = {}, limits = LIMITS, options = {}) {
  if (!isPlainObject(context)) fail('context must be a plain object');
  for (const key of Object.keys(context)) {
    if (!CONTEXT_FIELDS.includes(key)) fail(`context.${key} is not a known context field (fail-closed)`);
  }
  const normalized = {};
  for (const key of CONTEXT_FIELDS) {
    if (context[key] === undefined || context[key] === null || context[key] === '') continue;
    normalized[key] = requireNonEmptyString(context[key], `context.${key}`);
  }
  const rules = memory.getActiveRules(db, projectId, normalized, options.asOf === undefined ? {} : { asOf: options.asOf });
  if (rules.length > limits.maxContextEntries) {
    fail(`context has ${rules.length} active rules which exceeds the trusted limit ${limits.maxContextEntries} (fail-closed before payload)`);
  }
  const entries = rules.map((rule) => ({ id: rule.id, scope: rule.scope, scopeKey: rule.scopeKey, ruleKey: rule.ruleKey, value: rule.value, version: rule.version }));
  const serialized = canonicalJson({ scope: normalized, entries });
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > limits.maxContextBytes) {
    fail(`context payload is ${bytes} bytes which exceeds the trusted limit ${limits.maxContextBytes} (fail-closed before payload)`);
  }
  return { entries, contextHash: sha256Hex(serialized), context: normalized };
}

// ---------- permits (engineering contract; NOT a real budget authorization) ----------

function validatePermits(permits, snapshot) {
  if (permits === undefined || permits === null) return { tools: {}, budget: null };
  if (!isPlainObject(permits)) fail('permits must be a plain object');
  for (const key of Object.keys(permits)) {
    if (!['tools', 'budget'].includes(key)) fail(`permits.${key} is an unknown field (fail-closed)`);
  }
  const tools = {};
  if (permits.tools !== undefined) {
    if (!isPlainObject(permits.tools)) fail('permits.tools must be a plain object');
    for (const [name, permit] of Object.entries(permits.tools)) {
      if (!snapshot.tools.some((entry) => entry.name === name)) fail(`permits.tools.${name} is not a tool in this registry snapshot (fail-closed)`);
      if (!isPlainObject(permit) || permit.granted !== true) fail(`permits.tools.${name} must be {granted: true} (an explicit engineering permit; not a real authorization)`);
      tools[name] = { granted: true };
    }
  }
  let budgetPermit = null;
  if (permits.budget !== undefined && permits.budget !== null) {
    if (!isPlainObject(permits.budget) || permits.budget.granted !== true) fail('permits.budget must be {granted: true, currency} (an explicit engineering permit; not real user budget approval)');
    budgetPermit = { granted: true, currency: requireNonEmptyString(permits.budget.currency, 'permits.budget.currency') };
  }
  return { tools, budget: budgetPermit };
}

// ---------- identity binding ----------

function computeBinding(material) {
  return {
    orchestratorVersion: ORCHESTRATOR_VERSION,
    planHash: requireNonEmptyString(material.planHash, 'binding.planHash'),
    registryHash: requireNonEmptyString(material.registryHash, 'binding.registryHash'),
    contextHash: requireNonEmptyString(material.contextHash, 'binding.contextHash'),
    inputHash: requireNonEmptyString(material.inputHash, 'binding.inputHash'),
    inputVersion: requireNonEmptyString(material.inputVersion, 'binding.inputVersion'),
    projectId: requireNonEmptyString(material.projectId, 'binding.projectId'),
    brand: material.brand ?? null,
    market: material.market ?? null
  };
}
function bindingsMatch(a, b) {
  if (!a || !b) return false;
  return canonicalJson(a) === canonicalJson(b);
}

// ---------- private file helpers (worker-style atomic writes under the guarded dir) ----------

function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function appendJournalLine(workerDir, runId, entry) {
  const file = resolveArtifact(workerDir, runId, ['journal.jsonl']);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}
function readJournal(workerDir, runId) {
  const file = resolveArtifact(workerDir, runId, ['journal.jsonl']);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}
function resolveArtifact(workerDir, runId, segments) {
  return worker.resolveScoped(workerDir, ['orchestrator', runId, ...segments], 'orchestrator artifact');
}
function artifactPathFor(workerDir, runId, stepId) {
  return resolveArtifact(workerDir, runId, ['steps', `${safeId(stepId, 'stepId')}.json`]);
}
function artifactRefFor(runId, stepId) {
  return `orchestrator/${runId}/steps/${safeId(stepId, 'stepId')}.json`;
}
function lateFactsDirFor(workerDir, runId) {
  return resolveArtifact(workerDir, runId, ['late-facts']);
}

// ---------- execution guards ----------

function checkFence(db, projectId, runId, owner, leaseToken, nowEpoch) {
  const run = store.getRun(db, projectId, runId);
  if (!run) return { ok: false, reason: 'run_missing' };
  if (run.status !== 'running') return { ok: false, reason: `run_${run.status}` };
  if (run.leaseOwner !== owner) return { ok: false, reason: 'lease_owner_changed' };
  if (run.leaseToken !== leaseToken) return { ok: false, reason: 'lease_token_stale' };
  const expires = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : null;
  if (expires === null || Number.isNaN(expires) || expires <= nowEpoch) return { ok: false, reason: 'lease_expired' };
  return { ok: true };
}

function readPath(value, dotted) {
  let node = value;
  for (const segment of dotted.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Structural quality gate: real tool-call evidence + declared fields/size. Never model self-score. */
function checkQuality(step, output, envelope, limits = LIMITS) {
  if (!envelope || envelope.calls < 1) return { pass: false, reason: 'evidence_missing: no recorded tool call' };
  const bytes = Buffer.byteLength(canonicalJson(output), 'utf8');
  if (bytes > limits.maxOutputBytes) return { pass: false, reason: `output_too_large: ${bytes} > ${limits.maxOutputBytes}` };
  const quality = step.quality;
  if (!quality) return { pass: true, reason: null };
  if (quality.requireEvidence === true && envelope.calls < 1) return { pass: false, reason: 'evidence_missing' };
  if (quality.requireFields) {
    for (const dotted of quality.requireFields) {
      const value = readPath(output, dotted);
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        return { pass: false, reason: `quality_field_missing: ${dotted}` };
      }
    }
  }
  if (quality.minOutputBytes !== undefined && bytes < quality.minOutputBytes) {
    return { pass: false, reason: `quality_output_too_small: ${bytes} < ${quality.minOutputBytes}` };
  }
  return { pass: true, reason: null };
}

// ---------- the single-run orchestrator ----------

function operationScopeFor({ projectId, brand, market, step, inputHash }) {
  return {
    taskId: TASK_TYPE,
    inputHash,
    tool: step.tool,
    toolVersion: step.toolVersion,
    model: 'fixture-none',
    promptVersion: 'none',
    templateVersion: 'none',
    policy: 't2.7-permits-v1',
    project: projectId,
    brand: brand ?? null,
    market: market ?? 'fixture',
    locale: 'en-US',
    shipTo: 'none'
  };
}

/**
 * Execute (or resume) one orchestrator run with a single worker invocation.
 * options.clock (a function returning a Date or ISO instant) makes time testable; the default is
 * the real wall clock. Every lease-protected effect reads the clock exactly once at its own
 * boundary, verifies the fence with that instant and then binds the same instant to the effect.
 */
async function runOrchestratorOnce(db, options = {}) {
  if (!isPlainObject(options)) fail('options must be a plain object');
  const projectId = requireNonEmptyString(options.projectId, 'options.projectId');
  const owner = requireNonEmptyString(options.owner, 'options.owner');
  const ttlSeconds = options.ttlSeconds === undefined ? 120 : options.ttlSeconds;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) fail('options.ttlSeconds must be a positive safe integer');
  const workerDir = requireNonEmptyString(options.workerDir, 'options.workerDir');
  const registry = options.registry;
  if (!registry || typeof registry.createSnapshot !== 'function') fail('options.registry must be a tool registry (createToolRegistry)');
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const readNow = () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) fail('options.clock returned an invalid instant');
    return date.toISOString();
  };
  const initialNow = options.now === undefined ? readNow() : requireNonEmptyString(options.now, 'options.now');
  const refreshNow = () => readNow();
  const brand = options.brand ?? null;
  const market = options.market ?? null;
  const inputVersion = options.inputVersion === undefined ? 'v1' : requireNonEmptyString(options.inputVersion, 'options.inputVersion');

  // ---- validation before any effect ----
  const snapshot = registry.createSnapshot();
  const validated = validatePlan(options.plan, snapshot);
  const contextRef = options.context ?? {};
  if (!isPlainObject(contextRef)) fail('options.context must be a plain object');
  for (const [contextKey, optionName, optionValue] of [['brandKey', 'brand', brand], ['marketKey', 'market', market]]) {
    const refValue = contextRef[contextKey];
    if (refValue === undefined || refValue === null || refValue === '') continue;
    const wanted = requireNonEmptyString(refValue, `options.context.${contextKey}`);
    if (optionValue === null || optionValue === undefined) fail(`options.context.${contextKey} requires an explicit options.${optionName} (null is never a wildcard)`);
    if (wanted !== optionValue) fail(`options.context.${contextKey} must equal options.${optionName} (single execution scope authority)`);
  }
  if (contextRef.runId !== undefined && contextRef.runId !== null && contextRef.runId !== '') {
    const wantedRun = requireNonEmptyString(contextRef.runId, 'options.context.runId');
    if (!options.runId) fail('options.context.runId requires options.runId: create the run first, then pass its id (safe order)');
    if (wantedRun !== options.runId) fail('options.context.runId must equal the current run id (fail-closed)');
  }
  const loadedContext = loadContext(db, projectId, contextRef, LIMITS, { asOf: options.asOf });
  const permits = validatePermits(options.permits, snapshot);
  const inputHash = sha256Hex(canonicalJson(validated.normalized.steps.map((step) => ({ id: step.id, input: step.input }))));
  const binding = computeBinding({
    planHash: validated.planHash,
    registryHash: snapshot.hash,
    contextHash: loadedContext.contextHash,
    inputHash,
    inputVersion,
    projectId,
    brand,
    market
  });

  // ---- run lifecycle (task-type isolated from the approved worker) ----
  let run = options.runId ? store.getRun(db, projectId, requireNonEmptyString(options.runId, 'options.runId')) : null;
  if (options.runId && !run) throw new NotFoundError('run not found in this project');
  if (run && run.taskType !== TASK_TYPE) {
    return { status: 'not_runnable', run, reason: `task type isolation: ${run.taskType} is not ${TASK_TYPE} (the approved worker runs are never operated here)` };
  }
  if (!run) {
    run = store.createRun(db, projectId, { taskType: TASK_TYPE, actor: owner, now: initialNow });
  }
  if (store.TERMINAL_STATES.includes(run.status)) {
    return { status: 'not_runnable', run, reason: `run is ${run.status}; terminal runs are never revived (a redo creates a new run with retryOf)` };
  }
  let acquired;
  try {
    acquired = store.acquireLease(db, projectId, run.id, { owner, ttlSeconds, now: initialNow });
  } catch (error) {
    if (error instanceof ConflictError) return { status: 'not_acquired', run: store.getRun(db, projectId, run.id), reason: error.message };
    throw error;
  }
  const leaseToken = acquired.leaseToken;
  run = store.startRun(db, projectId, run.id, { owner, expectedToken: leaseToken, now: refreshNow() });
  const runId = run.id;

  // ---- identity binding (mirror the worker's fail-closed input-change semantics) ----
  const priorCheckpoint = run.checkpoint && isPlainObject(run.checkpoint) ? run.checkpoint : null;
  const existing = priorCheckpoint && isPlainObject(priorCheckpoint.orchestrator) ? priorCheckpoint.orchestrator : null;
  const stepResults = [];
  const stop = (status, reason, stepId) => ({ status, reason: reason ?? null, stepId: stepId ?? null, run: store.getRun(db, projectId, runId), binding, steps: stepResults });
  /** One clock read per boundary; the returned instant is bound to the effect that follows. */
  const fenceAt = () => {
    const at = refreshNow();
    return { at, ...checkFence(db, projectId, runId, owner, leaseToken, Date.parse(at)) };
  };
  const bindingFence = fenceAt();
  if (existing && !bindingsMatch(existing.binding, binding)) {
    if (!bindingFence.ok) return stop('lease_lost', bindingFence.reason, null);
    const failed = store.failRun(db, projectId, runId, {
      owner,
      expectedToken: leaseToken,
      reason: 'plan/registry/context/input identity changed; refusing to reuse an earlier completion (fail-closed)',
      now: bindingFence.at
    });
    return { status: 'failed_input_changed', run: failed, reason: 'binding_mismatch' };
  }
  const checkpoint = {
    completedSteps: priorCheckpoint && Array.isArray(priorCheckpoint.completedSteps) ? [...priorCheckpoint.completedSteps] : [],
    artifactRefs: priorCheckpoint && Array.isArray(priorCheckpoint.artifactRefs) ? [...priorCheckpoint.artifactRefs] : [],
    orchestrator: {
      version: ORCHESTRATOR_VERSION,
      binding,
      bindingHash: sha256Hex(canonicalJson(binding)),
      artifacts: existing ? { ...existing.artifacts } : {},
      reworkCounts: existing ? { ...existing.reworkCounts } : {},
      qualityHistory: existing ? [...existing.qualityHistory] : [],
      startedAt: existing ? existing.startedAt : initialNow,
      updatedAt: initialNow,
      finishedAt: null
    }
  };
  const persistCheckpoint = (extra = {}, at = null) => {
    Object.assign(checkpoint.orchestrator, extra);
    const instant = at ?? refreshNow();
    checkpoint.orchestrator.updatedAt = instant;
    return store.updateCheckpoint(db, projectId, runId, { owner, expectedToken: leaseToken, checkpoint, now: instant });
  };

  /** Versioned, immutable late-fact receipt (isolated audit artifact; never a normal output). */
  const writeLateReceipt = (stepId, attempt, payload) => {
    const base = `${safeId(stepId, 'stepId')}-a${attempt}`;
    let file = resolveArtifact(workerDir, runId, ['late-facts', `${base}.json`]);
    if (fs.existsSync(file)) {
      for (let n = 2; n <= 20; n += 1) {
        const candidate = resolveArtifact(workerDir, runId, ['late-facts', `${base}-v${n}.json`]);
        if (!fs.existsSync(candidate)) { file = candidate; break; }
      }
    }
    writeJsonAtomic(file, payload);
    return `orchestrator/${runId}/late-facts/${path.basename(file)}`;
  };

  /**
   * Unified facts contract (R-F6b/R-F6c/R-F6d/R-F6e): before ANY authoritative write, both sides
   * are read first — the operation (scope hash, current attempt token/generation, structured
   * per-attempt remote, and an explicit STATE ALLOWLIST: only claimed/submitted/pending_reconcile
   * may accept a current return; cancelled/confirmed_* and unknown states fail closed) and the
   * exact reservation hold (status, remote). UNKNOWN may be bound once, the SAME remote is
   * replayable, a DIFFERENT remote fails closed, and the two KNOWN structured remotes are
   * compared DIRECTLY (an unknown/null envelope never hides an existing two-authority mismatch;
   * null is not a wildcard). Conflicting observations are audit-only: the isolated versioned
   * receipt records them and neither authority is written.
   */
  const preflightFacts = (operation, envelope, tool) => {
    const envelopeRemote = envelope.remoteId === undefined ? null : envelope.remoteId;
    const current = idem.getOperation(db, operation.operationId);
    const observations = {
      envelopeRemote,
      operationState: current ? current.state : null,
      operationAttemptToken: current ? current.attemptToken : null,
      operationRemote: current ? (current.remoteId === undefined ? null : current.remoteId) : null,
      holdStatus: null,
      holdRemote: null
    };
    let conflict = null;
    if (!current) {
      conflict = { reason: 'operation_missing' };
    } else if (current.attemptToken !== operation.attemptToken || (operation.scopeHash !== null && current.scopeHash !== operation.scopeHash)) {
      conflict = { reason: 'attempt_superseded' };
    } else if (!ALLOWED_OPERATION_STATES.includes(current.state)) {
      // a terminal/cancelled/unknown operation state can never accept a current return (R-F6e1)
      conflict = { reason: `operation_state_${current.state}` };
    }
    let hold = null;
    if (operation.reservationId) {
      try {
        const reservations = budget.listReservations(db, {
          project: projectId,
          brand,
          currency: tool && tool.costPolicy ? tool.costPolicy.currency : null
        });
        hold = reservations.find((reservation) => reservation.reservationId === operation.reservationId) ?? null;
      } catch (error) {
        hold = null;
      }
      if (!hold) {
        if (!conflict) conflict = { reason: 'hold_missing' };
      } else {
        observations.holdStatus = hold.status;
        observations.holdRemote = hold.remoteId === undefined ? null : hold.remoteId;
        if (hold.status !== 'reserved') {
          if (!conflict) conflict = { reason: `hold_${hold.status}` };
        } else if (hold.remoteId !== null && hold.remoteId !== undefined && envelopeRemote !== null && hold.remoteId !== envelopeRemote) {
          if (!conflict) conflict = { reason: 'hold_remote_conflict', holdRemote: hold.remoteId };
        }
      }
    }
    if (!conflict && current && hold && hold.status === 'reserved') {
      // direct two-authority comparison (R-F6e2): both KNOWN structured remotes must agree; an
      // unknown/null envelope never hides an existing mismatch (null is not a wildcard)
      const operationRemote = current.remoteId === undefined ? null : current.remoteId;
      const holdRemote = hold.remoteId === undefined ? null : hold.remoteId;
      if (operationRemote !== null && holdRemote !== null && operationRemote !== holdRemote) {
        conflict = { reason: 'authority_remote_mismatch', operationRemote, holdRemote };
      }
    }
    if (!conflict && current) {
      const operationRemote = current.remoteId === undefined ? null : current.remoteId;
      if (operationRemote !== null && envelopeRemote !== null && operationRemote !== envelopeRemote) {
        conflict = { reason: 'remote_conflict', operationRemote };
      }
    }
    return { current, hold, observations, conflict, envelopeRemote };
  };

  /** Authoritative writes for a preflight that found no conflict (never called on conflict). */
  const applyFacts = (operation, envelope, at, preflight) => {
    const { current, hold, envelopeRemote } = preflight;
    let submitted = false;
    let timedOut = false;
    let pendingCostBound = false;
    let failed = false;
    if (current && current.state === 'claimed') {
      try {
        idem.markSubmitted(db, operation.operationId, { attemptToken: operation.attemptToken, remoteId: envelopeRemote, note: 'orchestrator: invoke returned; facts retained', now: at });
        submitted = true;
        if (envelope.status === 'pending_reconcile') {
          try {
            idem.markTimeout(db, operation.operationId, { kind: 'timeout', remoteId: envelopeRemote, attemptToken: operation.attemptToken, note: 'pending result retained; no automatic resend', now: at });
            timedOut = true;
          } catch (error) {
            failed = true;
          }
        }
      } catch (error) {
        failed = true;
      }
    } else {
      submitted = true; // the same remote or an already-recorded unknown remote: fact is consistent
      if (current && current.state === 'submitted' && envelope.status === 'pending_reconcile') {
        try {
          idem.markTimeout(db, operation.operationId, { kind: 'timeout', remoteId: envelopeRemote, attemptToken: operation.attemptToken, note: 'pending result retained; no automatic resend', now: at });
          timedOut = true;
        } catch (error) {
          failed = true;
        }
      }
    }
    if (hold && hold.status === 'reserved' && (hold.remoteId === null || hold.remoteId === undefined || envelopeRemote === null || hold.remoteId === envelopeRemote)) {
      try {
        budget.recordPendingCost(db, {
          operationId: operation.operationId,
          attemptToken: operation.attemptToken,
          cumulativeMicros: 0,
          eventId: `evt_${operation.attemptToken}_late_fact`,
          remoteId: envelopeRemote,
          now: refreshNow()
        });
        pendingCostBound = true;
      } catch (error) {
        // keep the hold untouched; the receipt records the facts
      }
    }
    return { submitted, timedOut, pendingCostBound, failed };
  };

  /** Isolated, versioned audit receipt for a returned envelope (late stop or rejected facts). */
  const buildFactsReceipt = (stepId, attempt, operation, envelope, tool, stopReason, preflight, factResult) => {
    const conflict = preflight.conflict;
    return {
      schemaVersion: 1,
      kind: 'late-fact-receipt',
      orchestratorVersion: ORCHESTRATOR_VERSION,
      project: projectId,
      runId,
      stepId,
      attempt,
      stopReason: stopReason ?? null,
      at: refreshNow(),
      call: {
        status: envelope.status,
        remoteId: preflight.envelopeRemote,
        remoteUnknown: preflight.envelopeRemote === null,
        usage: envelope.usage ?? null,
        tool: tool ? tool.name : null,
        toolVersion: tool ? tool.version : null,
        idempotencyLevel: tool ? tool.idempotencyLevel : null,
        diagnostics: tool && tool.idempotencyLevel === 'unsupported'
          ? 'unsupported idempotency: no status-query/resend contract; reconcile externally'
          : null
      },
      operation: { operationId: operation.operationId, attemptToken: operation.attemptToken, generation: operation.generation ?? null, scopeHash: operation.scopeHash ?? null },
      reservation: operation.reservationId
        ? { reservationId: operation.reservationId, holdMicros: operation.holdMicros ?? null, currency: tool ? tool.costPolicy.currency : null, category: tool ? tool.costPolicy.category : null, status: 'reserved' }
        : null,
      observations: preflight.observations,
      facts: {
        markSubmitted: factResult.submitted,
        markTimeout: factResult.timedOut,
        pendingCostBound: factResult.pendingCostBound,
        conflict: conflict
          ? { reason: conflict.reason, operationRemote: conflict.operationRemote ?? preflight.observations.operationRemote, holdRemote: conflict.holdRemote ?? preflight.observations.holdRemote, envelopeRemote: preflight.envelopeRemote }
          : null
      },
      reconciliation: {
        status: 'needs_reconciliation',
        note: conflict
          ? `facts rejected (${conflict.reason}): the observation is audit-only; not_submitted/effective/final cost are NOT asserted; neither authority was rewritten; the hold is retained`
          : 'late fact only: not_submitted/effective/final cost are NOT asserted; the hold is retained; no automatic release'
      }
    };
  };

  const persistFactsReceipt = (receipt, stepId, attempt, operation, eventName) => {
    const receiptRef = writeLateReceipt(stepId, attempt, receipt);
    appendJournalLine(workerDir, runId, {
      at: refreshNow(),
      event: eventName ?? 'late_fact',
      stepId,
      attempt,
      remoteId: receipt.call.remoteId,
      operationId: operation.operationId,
      attemptToken: operation.attemptToken,
      reservationId: operation.reservationId ?? null,
      conflict: receipt.facts.conflict ? receipt.facts.conflict.reason : null,
      receipt: receiptRef,
      status: 'needs_reconciliation'
    });
    return receiptRef;
  };

  /**
   * Late facts (R-F6a/R-F6b/R-F6c): persist what a call actually returned when the run stops
   * early. A valid returned envelope is retained even when remoteId is null (unknown ≠ no call).
   * The unified preflight reads BOTH authorities before any write; on conflict nothing is written
   * and only the isolated receipt remains.
   */
  const recordLateFacts = (stepId, attempt, operation, envelope, tool, stopReason) => {
    if (!operation || !envelope) return null;
    const preflight = preflightFacts(operation, envelope, tool);
    const factResult = preflight.conflict
      ? { submitted: false, timedOut: false, pendingCostBound: false, failed: false }
      : applyFacts(operation, envelope, refreshNow(), preflight);
    const receipt = buildFactsReceipt(stepId, attempt, operation, envelope, tool, stopReason, preflight, factResult);
    return persistFactsReceipt(receipt, stepId, attempt, operation);
  };

  const stopForCancel = (stepId, attempt, operation, envelope, tool) => {
    const request = worker.readCancelRequest(workerDir, runId);
    if (!request) return null;
    const receipt = recordLateFacts(stepId, attempt, operation, envelope, tool, `cancel requested: ${request.reason ?? 'unspecified'}`);
    const fence = fenceAt();
    if (!fence.ok) {
      appendJournalLine(workerDir, runId, {
        at: fence.at,
        event: 'cancel_unavailable_lease_invalid',
        stepId,
        attempt,
        detail: fence.reason,
        remoteId: envelope && envelope.remoteId !== undefined ? envelope.remoteId : null,
        lateReceipt: receipt
      });
      return stop('lease_lost', `cancel requested but the lease is no longer valid: ${fence.reason}`, stepId);
    }
    persistCheckpoint({ cancelPoint: { stepId, attempt, at: fence.at, reason: request.reason ?? null } }, fence.at);
    const cancelled = store.cancelRun(db, projectId, runId, {
      owner,
      expectedToken: leaseToken,
      reason: `cancel requested: ${request.reason ?? 'unspecified'}`,
      now: fence.at
    });
    appendJournalLine(workerDir, runId, {
      at: fence.at,
      event: 'cancelled',
      stepId,
      attempt,
      detail: 'cancel request detected; no further effects',
      operationId: operation ? operation.operationId : null,
      attemptToken: operation ? operation.attemptToken : null,
      remoteId: envelope && envelope.remoteId !== undefined ? envelope.remoteId : null,
      lateReceipt: receipt
    });
    return { status: 'cancelled', run: cancelled, binding, steps: stepResults };
  };

  /**
   * Boundary guard for lease-protected effects: cancel first, then current clock/owner/token.
   * On failure returns {stop} with a clear result (late facts recorded when a call returned);
   * on success returns {at} — the instant the following effect must use.
   */
  const guarded = (stepId, attempt, operation, envelope, tool, stopReason) => {
    const cancel = stopForCancel(stepId, attempt, operation, envelope, tool);
    if (cancel) return { stop: cancel };
    const fence = fenceAt();
    if (!fence.ok) {
      const receipt = recordLateFacts(stepId, attempt, operation, envelope, tool, stopReason ?? fence.reason);
      appendJournalLine(workerDir, runId, {
        at: fence.at,
        event: 'lease_lost',
        stepId,
        attempt,
        detail: fence.reason,
        operationId: operation ? operation.operationId : null,
        attemptToken: operation ? operation.attemptToken : null,
        remoteId: envelope && envelope.remoteId !== undefined ? envelope.remoteId : null,
        lateReceipt: receipt
      });
      return { stop: stop('lease_lost', fence.reason, stepId) };
    }
    return { at: fence.at };
  };

  // ---- plan file + initial checkpoint (its own boundary) ----
  const planBoundary = guarded(null, 0, null, null, null, 'plan_write');
  if (planBoundary.stop) return planBoundary.stop;
  const planFile = resolveArtifact(workerDir, runId, ['plan.json']);
  const existingPlan = readJsonIfExists(planFile);
  if (!existingPlan || !bindingsMatch(existingPlan.binding, binding)) {
    writeJsonAtomic(planFile, {
      schemaVersion: 1,
      orchestratorVersion: ORCHESTRATOR_VERSION,
      binding,
      plan: validated.normalized,
      context: loadedContext.entries,
      contextHash: loadedContext.contextHash,
      registryHash: snapshot.hash,
      tools: snapshot.tools.map((entry) => ({ name: entry.name, version: entry.version, contractHash: entry.contractHash })),
      inputVersion,
      writtenAt: planBoundary.at
    });
  }
  persistCheckpoint({}, planBoundary.at);

  // ---- resume: re-verify completed-step evidence (recomputed hash + full identity) before skipping ----
  const outputs = new Map();
  for (const stepId of checkpoint.completedSteps) {
    const record = checkpoint.orchestrator.artifacts[stepId];
    const step = validated.steps.get(stepId);
    const recoveryFailure = (detail) => {
      const fence = fenceAt();
      if (!fence.ok) return stop('lease_lost', fence.reason, stepId);
      store.failRun(db, projectId, runId, {
        owner,
        expectedToken: leaseToken,
        reason: `completed step ${stepId} verification failed: ${detail} (fail-closed; no downstream calls)`,
        now: fence.at
      });
      return { status: 'failed_evidence_missing', run: store.getRun(db, projectId, runId), reason: `${stepId}: ${detail}` };
    };
    if (!record || !step) return recoveryFailure('missing artifact record or step definition');
    const expectedRef = artifactRefFor(runId, stepId);
    if (record.ref !== expectedRef) return recoveryFailure('artifact ref is not the canonical expected ref');
    const artifact = readJsonIfExists(resolveArtifact(workerDir, runId, expectedRef.split('/').slice(2)));
    if (!artifact) return recoveryFailure('artifact file missing');
    const recomputed = sha256Hex(canonicalJson(artifact.output));
    if (artifact.outputSha256 !== record.sha || recomputed !== record.sha) {
      return recoveryFailure('output hash mismatch (recomputed over the actual bytes, not the declared field)');
    }
    if (artifact.runId !== runId || artifact.stepId !== stepId || artifact.role !== step.role || artifact.tool !== step.tool
      || artifact.toolVersion !== step.toolVersion || artifact.contractHash !== step.contractHash
      || artifact.bindingHash !== checkpoint.orchestrator.bindingHash) {
      return recoveryFailure('artifact identity does not match the bound run/step/role/tool/version/contract/binding');
    }
    if (!artifact.evidence || !(artifact.evidence.calls >= 1)) return recoveryFailure('missing real tool-call evidence');
    const toolView = snapshot.get(step.tool);
    if (toolView.outputSchema !== null && toolView.outputSchema !== undefined) {
      try {
        validateValue(toolView.outputSchema, artifact.output, `completed step ${stepId} output`);
      } catch (error) {
        return recoveryFailure(`output schema validation failed: ${error.message}`);
      }
    }
    outputs.set(stepId, artifact.output);
  }

  appendJournalLine(workerDir, runId, { at: planBoundary.at, event: 'orchestrator_started', bindingHash: checkpoint.orchestrator.bindingHash, planHash: binding.planHash, registryHash: binding.registryHash, contextHash: binding.contextHash, inputVersion });

  // ---- step loop ----
  for (const stepId of validated.order) {
    const step = validated.steps.get(stepId);
    if (checkpoint.completedSteps.includes(stepId)) {
      stepResults.push({ id: stepId, status: 'skipped_completed' });
      continue;
    }
    if ((checkpoint.orchestrator.reworkCounts[stepId] ?? 0) > validated.maxReworkPerStep) {
      const fence = fenceAt();
      if (!fence.ok) return stop('lease_lost', fence.reason, stepId);
      store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `quality_rework_exceeded: ${stepId} (persisted rework count is already over the limit; no further execution)`, now: fence.at });
      return stop('blocked', `quality_rework_exceeded: ${stepId}`, stepId);
    }
    const tool = snapshot.tools.find((entry) => entry.name === step.tool);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      // boundary: attempt start
      let gate = guarded(stepId, attempt, null, null, tool, 'attempt_start');
      if (gate.stop) return gate.stop;
      // ---- pre-effect gates (checked BEFORE any operation identity is consumed) ----
      if (tool.external === true && !(permits.tools[step.tool] && permits.tools[step.tool].granted === true)) {
        store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `permission_missing: ${step.tool} requires an explicit engineering permit (no call was made)`, now: gate.at });
        return stop('blocked', `permission_missing: ${step.tool}`, stepId);
      }
      if (tool.costPolicy.kind === 'unknown_price') {
        store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `unknown_cost: ${step.tool} has no finite price estimate; refusing to run (no call was made)`, now: gate.at });
        return stop('blocked', `unknown_cost: ${step.tool}`, stepId);
      }
      if (tool.costPolicy.kind === 'priced') {
        if (!permits.budget || permits.budget.granted !== true) {
          store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `budget_permission_missing: ${step.tool} (no call was made)`, now: gate.at });
          return stop('blocked', `budget_permission_missing: ${step.tool}`, stepId);
        }
        if (permits.budget.currency !== tool.costPolicy.currency) {
          store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `budget_currency_mismatch: ${step.tool}`, now: gate.at });
          return stop('blocked', `budget_currency_mismatch: ${step.tool}`, stepId);
        }
      }
      // ---- T2.3 operation identity (claim only; NO fabricated reconciliation, NO automatic retry) ----
      let operation = null;
      if (tool.external === true || tool.costPolicy.kind === 'priced') {
        const stepInputHash = sha256Hex(canonicalJson(step.input));
        const operationId = worker.operationIdFor(runId, step.id, stepInputHash);
        const scope = operationScopeFor({ projectId, brand, market, step, inputHash: stepInputHash });
        gate = guarded(stepId, attempt, null, null, tool, 'before_claim');
        if (gate.stop) return gate.stop;
        const claim = idem.claimOperation(db, { operationId, capability: tool.idempotencyLevel, scope, now: gate.at });
        if (claim.decision === 'execute' || claim.decision === 'retry_reserved') {
          operation = { operationId, attemptToken: claim.operation.attemptToken, generation: claim.operation.generation ?? null, scopeHash: claim.operation.scopeHash ?? null, reservationId: null, holdMicros: null };
        } else {
          appendJournalLine(workerDir, runId, { at: gate.at, event: 'operation_blocked', stepId, attempt, detail: claim.decision, operationId, attemptToken: claim.operation.attemptToken ?? null });
          store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `operation_${claim.decision}: ${stepId} (never blind-resubmit an uncertain charged call)`, now: gate.at });
          return stop('blocked', `operation_${claim.decision}: ${stepId}`, stepId);
        }
        if (tool.costPolicy.kind === 'priced') {
          gate = guarded(stepId, attempt, operation, null, tool, 'before_reserve');
          if (gate.stop) return gate.stop;
          const reservation = budget.reserveBudget(db, {
            project: projectId,
            brand,
            currency: tool.costPolicy.currency,
            operationId: operation.operationId,
            attemptToken: operation.attemptToken,
            category: tool.costPolicy.category,
            priceBasis: tool.costPolicy.priceBasis,
            priceConfidence: tool.costPolicy.priceConfidence,
            quantity: 1,
            eventId: `evt_${operation.attemptToken}_reserve`,
            maxEstimateMicros: tool.costPolicy.estimateMicros,
            now: gate.at
          });
          if (reservation.decision !== 'granted') {
            store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `budget_${reservation.decision}${reservation.reason ? `:${reservation.reason}` : ''}: ${stepId}`, now: gate.at });
            return stop('blocked', `budget_${reservation.decision}${reservation.reason ? `:${reservation.reason}` : ''}`, stepId);
          }
          operation.reservationId = reservation.reservation.reservationId;
          operation.holdMicros = reservation.reservation.holdMicros;
        }
      }
      // ---- payload whitelist: provider prompts receive ONLY the T1.5-classified safe copy ----
      let invokeInput = step.input;
      if (tool.external === true) {
        invokeInput = applyProfile(step.input, tool.payloadPolicy, 'external-redacted');
      }
      const upstream = {};
      for (const dep of step.dependsOn) {
        if (outputs.has(dep)) upstream[dep] = outputs.get(dep);
      }
      // boundary: immediately before the tool call (after payload/schema processing)
      gate = guarded(stepId, attempt, operation, null, tool, 'before_invoke');
      if (gate.stop) return gate.stop;
      let envelope;
      try {
        envelope = await snapshot.invoke(step.tool, {
          role: step.role,
          input: invokeInput,
          context: {
            upstream,
            project: projectId,
            brand,
            market,
            runId,
            contextHash: loadedContext.contextHash,
            contextEntries: loadedContext.entries,
            operationId: operation ? operation.operationId : null,
            attemptToken: operation ? operation.attemptToken : null,
            now: gate.at
          }
        });
      } catch (error) {
        appendJournalLine(workerDir, runId, { at: refreshNow(), event: 'step_error', stepId, attempt, detail: error.message, operationId: operation ? operation.operationId : null, attemptToken: operation ? operation.attemptToken : null });
        const fence = fenceAt();
        if (!fence.ok) return stop('lease_lost', fence.reason, stepId);
        store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `step_error: ${stepId}: ${error.message}`, now: fence.at });
        return stop('blocked', `step_error: ${stepId}`, stepId);
      }
      // boundary: post-return (cancel + current clock/owner/token; late facts recorded on early stop)
      gate = guarded(stepId, attempt, operation, envelope, tool, 'post_return');
      if (gate.stop) return gate.stop;
      if (envelope.status === 'pending_reconcile') {
        gate = guarded(stepId, attempt, operation, envelope, tool, 'before_pending_facts');
        if (gate.stop) return gate.stop;
        if (operation) {
          const preflight = preflightFacts(operation, envelope, tool);
          if (preflight.conflict) {
            const receipt = buildFactsReceipt(stepId, attempt, operation, envelope, tool, `submission_fact_conflict: ${preflight.conflict.reason}`, preflight, { submitted: false, timedOut: false, pendingCostBound: false, failed: false });
            persistFactsReceipt(receipt, stepId, attempt, operation, 'facts_audit');
            store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `pending_reconcile: ${stepId} (submission_fact_conflict: ${preflight.conflict.reason}; needs reconciliation; never auto-resend)`, now: gate.at });
            return stop('blocked', `pending_reconcile: ${stepId}`, stepId);
          }
          const fact = applyFacts(operation, envelope, gate.at, preflight);
          if (fact.failed) {
            const receipt = buildFactsReceipt(stepId, attempt, operation, envelope, tool, 'submission_fact_write_failed', preflight, fact);
            persistFactsReceipt(receipt, stepId, attempt, operation, 'facts_audit');
            store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `pending_reconcile: ${stepId} (submission_fact_write_failed; needs reconciliation)`, now: gate.at });
            return stop('blocked', `pending_reconcile: ${stepId}`, stepId);
          }
        }
        store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `pending_reconcile: ${stepId} (uncertain result; reconciliation required; never auto-resend)`, now: gate.at });
        return stop('blocked', `pending_reconcile: ${stepId}`, stepId);
      }
      if (envelope.status === 'waiting_input') {
        gate = guarded(stepId, attempt, operation, envelope, tool, 'before_waiting_input');
        if (gate.stop) return gate.stop;
        const waiting = store.waitForInput(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `${stepId}: ${envelope.reason ?? 'missing_input'}`, now: gate.at });
        appendJournalLine(workerDir, runId, { at: gate.at, event: 'waiting_input', stepId, attempt, detail: envelope.reason ?? 'missing_input' });
        return { status: 'waiting_input', reason: envelope.reason ?? 'missing_input', stepId, run: waiting, binding, steps: stepResults };
      }
      if (envelope.status === 'blocked') {
        gate = guarded(stepId, attempt, operation, envelope, tool, 'before_tool_blocked');
        if (gate.stop) return gate.stop;
        store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `tool_blocked: ${stepId}: ${envelope.reason ?? 'unspecified'}`, now: gate.at });
        return stop('blocked', `tool_blocked: ${stepId}`, stepId);
      }
      if (envelope.status === 'failed') {
        gate = guarded(stepId, attempt, operation, envelope, tool, 'before_tool_failed');
        if (gate.stop) return gate.stop;
        store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `tool_failed: ${stepId}: ${envelope.reason ?? 'unspecified'}`, now: gate.at });
        return stop('blocked', `tool_failed: ${stepId}`, stepId);
      }
      // ---- succeeded: unified preflight of BOTH authorities before any write; rejected facts stop here ----
      if (operation) {
        gate = guarded(stepId, attempt, operation, envelope, tool, 'before_facts');
        if (gate.stop) return gate.stop;
        const preflight = preflightFacts(operation, envelope, tool);
        if (preflight.conflict) {
          const receipt = buildFactsReceipt(stepId, attempt, operation, envelope, tool, `submission_fact_conflict: ${preflight.conflict.reason}`, preflight, { submitted: false, timedOut: false, pendingCostBound: false, failed: false });
          persistFactsReceipt(receipt, stepId, attempt, operation, 'facts_audit');
          store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `submission_fact_conflict: ${stepId} (${preflight.conflict.reason}; rejected facts are audit-only; no artifact/completion/settlement; needs reconciliation)`, now: gate.at });
          return stop('blocked', `submission_fact_conflict: ${stepId}`, stepId);
        }
        const fact = applyFacts(operation, envelope, gate.at, preflight);
        if (fact.failed) {
          const receipt = buildFactsReceipt(stepId, attempt, operation, envelope, tool, 'submission_fact_write_failed', preflight, fact);
          persistFactsReceipt(receipt, stepId, attempt, operation, 'facts_audit');
          store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `submission_fact_write_failed: ${stepId} (no artifact/completion/settlement; needs reconciliation)`, now: gate.at });
          return stop('blocked', `submission_fact_write_failed: ${stepId}`, stepId);
        }
        if (tool.costPolicy.kind === 'priced') {
          if (tool.costPolicy.costSettlement === 'synthetic') {
            budget.settleReservation(db, {
              operationId: operation.operationId,
              attemptToken: operation.attemptToken,
              finalMicros: tool.costPolicy.estimateMicros,
              eventId: `evt_${operation.attemptToken}_settle`,
              now: gate.at
            });
            appendJournalLine(workerDir, runId, { at: gate.at, event: 'cost_settled_synthetic', stepId, attempt, detail: `trusted synthetic settlement ${tool.costPolicy.estimateMicros} micros` });
          } else {
            appendJournalLine(workerDir, runId, {
              at: gate.at,
              event: 'cost_pending_reconciliation',
              stepId,
              attempt,
              detail: 'an estimate is not a verified final cost; the reservation hold is retained for reconciliation',
              operationId: operation.operationId,
              attemptToken: operation.attemptToken
            });
          }
        }
      }
      const quality = checkQuality(step, envelope.output, envelope);
      if (!quality.pass) {
        gate = guarded(stepId, attempt, operation, envelope, tool, 'before_quality_checkpoint');
        if (gate.stop) return gate.stop;
        checkpoint.orchestrator.qualityHistory.push({ stepId, attempt, pass: false, reason: quality.reason, at: gate.at });
        const reworkable = tool.external !== true && tool.costPolicy.kind !== 'priced';
        if (!reworkable) {
          persistCheckpoint({}, gate.at);
          appendJournalLine(workerDir, runId, { at: gate.at, event: 'quality_failed_no_safe_rework', stepId, attempt, detail: quality.reason, operationId: operation ? operation.operationId : null, attemptToken: operation ? operation.attemptToken : null });
          store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `quality_failed_no_safe_rework: ${stepId} (a charged/external call is never auto-retried without a safe reconciliation contract; operation/remote/hold facts retained)`, now: gate.at });
          return stop('blocked', `quality_failed_no_safe_rework: ${stepId}`, stepId);
        }
        checkpoint.orchestrator.reworkCounts[stepId] = (checkpoint.orchestrator.reworkCounts[stepId] ?? 0) + 1;
        persistCheckpoint({}, gate.at);
        appendJournalLine(workerDir, runId, { at: gate.at, event: 'quality_failed', stepId, attempt, detail: quality.reason });
        if (checkpoint.orchestrator.reworkCounts[stepId] > validated.maxReworkPerStep) {
          store.blockRun(db, projectId, runId, { owner, expectedToken: leaseToken, reason: `quality_rework_exceeded: ${stepId} (${checkpoint.orchestrator.reworkCounts[stepId]} > ${validated.maxReworkPerStep}; bounded rework stops here)`, now: gate.at });
          return stop('blocked', `quality_rework_exceeded: ${stepId}`, stepId);
        }
        continue; // bounded rework of THIS step only (local, no-charge tools only)
      }
      // ---- boundary: immediately before the artifact + checkpoint effects (R-F5) ----
      gate = guarded(stepId, attempt, operation, envelope, tool, 'before_artifact');
      if (gate.stop) return gate.stop;
      const outputSha256 = sha256Hex(canonicalJson(envelope.output));
      const artifactRef = artifactRefFor(runId, step.id);
      writeJsonAtomic(resolveArtifact(workerDir, runId, artifactRef.split('/').slice(2)), {
        schemaVersion: 1,
        runId,
        stepId: step.id,
        role: step.role,
        tool: step.tool,
        toolVersion: step.toolVersion,
        contractHash: step.contractHash,
        operationId: operation ? operation.operationId : null,
        attempt,
        bindingHash: checkpoint.orchestrator.bindingHash,
        outputSha256,
        output: envelope.output,
        evidence: { calls: envelope.calls, usage: envelope.usage ?? null, remoteId: envelope.remoteId ?? null },
        at: gate.at
      });
      checkpoint.completedSteps.push(step.id);
      checkpoint.artifactRefs.push(artifactRef);
      checkpoint.orchestrator.artifacts[step.id] = { ref: artifactRef, sha: outputSha256, at: gate.at, attempt, tool: step.tool, toolVersion: step.toolVersion };
      persistCheckpoint({}, gate.at);
      appendJournalLine(workerDir, runId, { at: gate.at, event: 'step_completed', stepId, attempt, tool: step.tool, outputSha256 });
      outputs.set(step.id, envelope.output);
      stepResults.push({ id: step.id, status: 'succeeded', attempt, artifactRef, outputSha256 });
      break;
    }
  }

  // ---- finish: terminal state at its own boundary, never revived afterwards ----
  const lateCancel = stopForCancel(null, 0, null, null, null);
  if (lateCancel) return lateCancel;
  const finishFence = fenceAt();
  if (!finishFence.ok) {
    appendJournalLine(workerDir, runId, { at: finishFence.at, event: 'lease_lost', stepId: null, attempt: 0, detail: finishFence.reason });
    return stop('lease_lost', finishFence.reason, null);
  }
  persistCheckpoint({ finishedAt: finishFence.at }, finishFence.at);
  const completed = store.completeRun(db, projectId, runId, { owner, expectedToken: leaseToken, now: finishFence.at });
  appendJournalLine(workerDir, runId, { at: finishFence.at, event: 'orchestrator_succeeded', steps: checkpoint.completedSteps.length });
  return { status: 'succeeded', run: completed, binding, steps: stepResults, checkpoint };
}

module.exports = {
  ORCHESTRATOR_VERSION,
  TASK_TYPE,
  ROLES,
  LIMITS,
  validatePlan,
  loadContext,
  computeBinding,
  bindingsMatch,
  checkQuality,
  readJournal,
  artifactPathFor,
  artifactRefFor,
  lateFactsDirFor,
  runOrchestratorOnce
};
