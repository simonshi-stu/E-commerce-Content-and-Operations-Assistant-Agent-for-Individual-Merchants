'use strict';
/**
 * Trusted tool registry (T2.7, revision-01): the ONLY path that registers executable orchestrator tools.
 *
 * Semantics (recorded in HANDOFF):
 * - Registration is a TRUSTED in-process API: a tool declares its name/version, the role
 *   allowlist, input/output schemas (the approved provider schema subset), kind (local/provider),
 *   external flag, cost policy and — for external tools — a T1.5 payload whitelist policy plus an
 *   OPTIONAL T1.5 context whitelist policy. The handler must be executable code (function or
 *   {invoke}); a descriptor-only "tool" is rejected.
 * - Every registration stores a PRIVATE frozen deep copy plus a registration-time bound invoke.
 *   createSnapshot() builds a PRIVATE immutable execution table (never exposed) and a deep-frozen
 *   read-only manifest (tools array + entries frozen, each carrying its contractHash). Mutating or
 *   pushing into the returned manifest can neither widen authority nor add executable entries,
 *   and the manifest hash is computed over the frozen manifest itself.
 * - External/provider envelope boundary (revision-01 F1): an external handler receives ONLY
 *   trusted identity/permit metadata (project/brand/market/runId/contextHash/operationId/
 *   attemptToken/now). Dependency outputs (upstream) and memory values (contextEntries) are NOT
 *   exposed unless the tool explicitly registers a T1.5 contextPolicy — and then only fields
 *   classified 'external' survive (external-redacted). Local handlers keep the full private
 *   context (internal evidence values are never destroyed for internal use).
 * - invoke() enforces the role allowlist and validates input/output against the REGISTERED
 *   schemas, passes deep-frozen input/output snapshots (async callers cannot rewrite them),
 *   returns a fail-closed envelope ({status, output?, reason?, remoteId?, usage?}) and counts
 *   real handler invocations (call evidence). Untrusted plan/input content can never register,
 *   replace or re-allow a tool — only this trusted API can. Not an OS sandbox, not production
 *   auth, and not a claim that prompts are injection-proof.
 */
const crypto = require('node:crypto');
const { ValidationError, ConflictError, NotFoundError } = require('./evidence.js');
const { validateSchema, validateValue, assertNoCredentialFields, deepFreeze } = require('./providers/schema.js');
const { validatePolicy, applyProfile } = require('./privacy.js');
const { canonicalJson } = require('./packs.js');
const { CATEGORIES, CONFIDENCES } = require('./budget.js');
const { CAPABILITIES: IDEMPOTENCY_LEVELS } = require('./idempotency.js');

const TOOL_FIELDS = Object.freeze([
  'name', 'version', 'roles', 'kind', 'external', 'inputSchema', 'outputSchema',
  'costPolicy', 'payloadPolicy', 'contextPolicy', 'idempotencyLevel', 'note'
]);
const TOOL_KINDS = Object.freeze(['local', 'provider']);
const COST_KINDS = Object.freeze(['mock_no_charge', 'priced', 'unknown_price']);
const COST_SETTLEMENTS = Object.freeze(['synthetic', 'unknown']);
const COST_FIELDS = Object.freeze({
  mock_no_charge: ['kind', 'currency', 'estimateMicros', 'note'],
  priced: ['kind', 'currency', 'estimateMicros', 'category', 'priceBasis', 'priceConfidence', 'costSettlement', 'note'],
  unknown_price: ['kind', 'currency', 'note']
});
const ENVELOPE_STATUSES = Object.freeze(['succeeded', 'waiting_input', 'blocked', 'pending_reconcile', 'failed']);
const ENVELOPE_FIELDS = Object.freeze(['status', 'output', 'reason', 'remoteId', 'usage']);
/** Trusted identity/permit metadata that an external handler may always receive (never content). */
const EXTERNAL_IDENTITY_FIELDS = Object.freeze(['project', 'brand', 'market', 'runId', 'contextHash', 'operationId', 'attemptToken', 'now']);

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
function requirePositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive safe integer`);
  return value;
}
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Fail-closed cost policy: unknown kinds/fields rejected; priced tools need a finite estimate. */
function validateCostPolicy(policy, name) {
  if (!isPlainObject(policy)) fail(`${name}.costPolicy must be a plain object`);
  if (!COST_KINDS.includes(policy.kind)) fail(`${name}.costPolicy.kind must be one of ${COST_KINDS.join(', ')}`);
  for (const key of Object.keys(policy)) {
    if (!COST_FIELDS[policy.kind].includes(key)) fail(`${name}.costPolicy.${key} is an unknown field for kind ${policy.kind} (fail-closed)`);
  }
  const currency = requireNonEmptyString(policy.currency, `${name}.costPolicy.currency`);
  if (policy.kind === 'mock_no_charge') {
    if (policy.estimateMicros !== undefined && policy.estimateMicros !== 0) fail(`${name}.costPolicy.estimateMicros must be 0 for mock_no_charge`);
  }
  let costSettlement = null;
  if (policy.kind === 'priced') {
    requirePositiveInt(policy.estimateMicros, `${name}.costPolicy.estimateMicros (a finite scenario cap is required before any call)`);
    if (!CATEGORIES.includes(policy.category)) fail(`${name}.costPolicy.category must be one of ${CATEGORIES.join(', ')}`);
    requireNonEmptyString(policy.priceBasis, `${name}.costPolicy.priceBasis`);
    const confidence = policy.priceConfidence ?? 'placeholder';
    if (!CONFIDENCES.includes(confidence)) fail(`${name}.costPolicy.priceConfidence must be one of ${CONFIDENCES.join(', ')}`);
    costSettlement = policy.costSettlement ?? 'unknown';
    if (!COST_SETTLEMENTS.includes(costSettlement)) {
      fail(`${name}.costPolicy.costSettlement must be one of ${COST_SETTLEMENTS.join(', ')} (an estimate is not a verified final cost; only trusted synthetic settlement may close a hold automatically)`);
    }
  }
  return {
    kind: policy.kind,
    currency,
    estimateMicros: policy.estimateMicros ?? 0,
    category: policy.category ?? null,
    priceBasis: policy.priceBasis ?? null,
    priceConfidence: policy.kind === 'priced' ? (policy.priceConfidence ?? 'placeholder') : null,
    costSettlement,
    note: policy.note ?? null
  };
}

function createToolRegistry(options = {}) {
  const knownRoles = options.roles === undefined ? null : options.roles.map((role) => requireNonEmptyString(role, 'options.roles[]'));
  const tools = new Map();
  const stats = new Map();

  function register(tool, handler) {
    if (!isPlainObject(tool)) fail('tool must be a plain object');
    for (const key of Object.keys(tool)) {
      if (!TOOL_FIELDS.includes(key)) fail(`tool.${key} is an unknown field (fail-closed)`);
    }
    const name = requireNonEmptyString(tool.name, 'tool.name');
    if (tools.has(name)) throw new ConflictError(`tool ${name} is already registered; re-registration is refused (fail-closed)`);
    const version = requireNonEmptyString(tool.version, 'tool.version');
    if (!Array.isArray(tool.roles) || tool.roles.length === 0) fail(`tool ${name}.roles must be a non-empty array (the role allowlist)`);
    const roles = [...new Set(tool.roles.map((role) => requireNonEmptyString(role, `${name}.roles[]`)))];
    if (knownRoles && roles.some((role) => !knownRoles.includes(role))) fail(`tool ${name}.roles contains a role outside the registry role set`);
    const kind = requireNonEmptyString(tool.kind, `${name}.kind`);
    if (!TOOL_KINDS.includes(kind)) fail(`${name}.kind must be one of ${TOOL_KINDS.join(', ')}`);
    if (tool.external !== undefined && typeof tool.external !== 'boolean') fail(`${name}.external must be a boolean`);
    const external = tool.external === true;
    if (kind === 'provider' && !external) fail(`${name}: provider tools must declare external: true`);
    validateSchema(tool.inputSchema, `${name}.inputSchema`);
    if (tool.outputSchema !== undefined && tool.outputSchema !== null) validateSchema(tool.outputSchema, `${name}.outputSchema`);
    assertNoCredentialFields(tool, `tool ${name}`);
    const costPolicy = validateCostPolicy(tool.costPolicy, name);
    let payloadPolicy = null;
    if (tool.payloadPolicy !== undefined && tool.payloadPolicy !== null) {
      if (!external) fail(`${name}.payloadPolicy is only meaningful for external tools (fail-closed)`);
      validatePolicy(tool.payloadPolicy);
      payloadPolicy = deepFreeze(jsonClone(tool.payloadPolicy));
    } else if (external) {
      fail(`${name}: external tools must declare a payloadPolicy (T1.5 whitelist; fail-closed)`);
    }
    let contextPolicy = null;
    if (tool.contextPolicy !== undefined && tool.contextPolicy !== null) {
      if (!external) fail(`${name}.contextPolicy is only meaningful for external tools (fail-closed)`);
      validatePolicy(tool.contextPolicy);
      contextPolicy = deepFreeze(jsonClone(tool.contextPolicy));
    }
    const idempotencyLevel = tool.idempotencyLevel ?? 'unsupported';
    if (!IDEMPOTENCY_LEVELS.includes(idempotencyLevel)) fail(`${name}.idempotencyLevel must be one of ${IDEMPOTENCY_LEVELS.join(', ')}`);
    if (handler === undefined || handler === null) fail(`tool ${name} requires an executable handler (descriptors alone are not tools)`);
    // registration-time bound method: later mutation of the caller's handler object cannot change execution authority
    const invokeFn = typeof handler === 'function' ? handler : (typeof handler.invoke === 'function' ? handler.invoke.bind(handler) : null);
    if (invokeFn === null) fail(`tool ${name} handler must be a function or expose invoke()`);
    const snapshot = deepFreeze({
      name,
      version,
      roles,
      kind,
      external,
      inputSchema: jsonClone(tool.inputSchema),
      outputSchema: tool.outputSchema === undefined || tool.outputSchema === null ? null : jsonClone(tool.outputSchema),
      costPolicy,
      payloadPolicy,
      contextPolicy,
      idempotencyLevel,
      note: tool.note ?? null
    });
    const contractHash = sha256Hex(canonicalJson(snapshot));
    // PRIVATE record: frozen snapshot + bound invoke; never returned as a live alias
    tools.set(name, Object.freeze({ snapshot, invoke: invokeFn, contractHash }));
    return Object.freeze({ name, version, contractHash });
  }

  function entryOf(name) {
    const id = requireNonEmptyString(name, 'name');
    const entry = tools.get(id);
    if (!entry) throw new NotFoundError(`unknown tool ${id} (fail-closed; no trusted registration)`);
    return entry;
  }

  function get(name) {
    return entryOf(name).snapshot;
  }

  function list() {
    return [...tools.keys()].sort().map((name) => get(name));
  }

  async function invokeTool(entry, args = {}) {
    const tool = entry.snapshot;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) fail('invoke arguments must be an object');
    const role = requireNonEmptyString(args.role, 'invoke role (the allowlist check requires the calling role)');
    if (!tool.roles.includes(role)) throw new ConflictError(`role ${role} is not allowed to use tool ${tool.name} (role allowlist)`);
    assertNoCredentialFields(args.input, 'tool input');
    validateValue(tool.inputSchema, args.input, 'tool input');
    if (args.context !== undefined && args.context !== null && !isPlainObject(args.context)) fail('tool context must be a plain object');
    // deep-frozen input snapshot: an async caller cannot rewrite the validated input afterwards
    const handlerInput = args.input === undefined ? undefined : deepFreeze(jsonClone(args.input));
    // external/provider envelope boundary (revision-01 F1): identity/permit metadata only, plus
    // explicitly registered context whitelists; dependency outputs and memory values are never
    // exposed to an external handler unless the trusted registration says so
    const rawContext = args.context ?? {};
    let handlerContext;
    if (tool.external === true) {
      const identity = {};
      for (const key of EXTERNAL_IDENTITY_FIELDS) {
        if (hasOwn(rawContext, key)) identity[key] = rawContext[key];
      }
      let extras = {};
      if (tool.contextPolicy) {
        extras = applyProfile(
          { upstream: rawContext.upstream ?? {}, contextEntries: rawContext.contextEntries ?? [] },
          tool.contextPolicy,
          'external-redacted'
        );
      }
      handlerContext = deepFreeze({ ...identity, ...extras });
    } else {
      // local handlers keep the full private context (internal evidence values are never destroyed)
      handlerContext = deepFreeze(jsonClone(rawContext));
    }
    stats.set(tool.name, (stats.get(tool.name) ?? 0) + 1);
    const result = await entry.invoke({ input: handlerInput, context: handlerContext, role });
    if (!isPlainObject(result)) fail(`tool ${tool.name} handler returned a non-object result (fail-closed)`);
    if (!ENVELOPE_STATUSES.includes(result.status)) fail(`tool ${tool.name} returned an unknown status (fail-closed)`);
    for (const key of Object.keys(result)) {
      if (!ENVELOPE_FIELDS.includes(key)) fail(`tool ${tool.name} result.${key} is an undeclared result field (fail-closed)`);
    }
    if (result.reason !== undefined && result.reason !== null && (typeof result.reason !== 'string' || result.reason.trim() === '')) {
      fail(`tool ${tool.name} returned an empty reason (fail-closed)`);
    }
    assertNoCredentialFields(result, `tool ${tool.name} result`);
    let output;
    if (result.status === 'succeeded') {
      if (!hasOwn(result, 'output')) fail(`tool ${tool.name} returned succeeded without an output (fail-closed)`);
      if (tool.outputSchema !== null) validateValue(tool.outputSchema, result.output, 'tool output');
      // deep-frozen output snapshot: later mutation cannot rewrite what a run recorded/passed on
      output = deepFreeze(jsonClone(result.output));
    } else if (hasOwn(result, 'output')) {
      fail(`tool ${tool.name} returned a non-success result carrying an output (never pretend success)`);
    }
    return Object.freeze({
      status: result.status,
      output,
      reason: result.reason ?? null,
      remoteId: result.remoteId ?? null,
      usage: result.usage ?? null,
      calls: 1,
      tool: tool.name,
      version: tool.version,
      contractHash: entry.contractHash
    });
  }

  /**
   * Freeze the current registry state: a PRIVATE immutable execution table plus a deep-frozen
   * read-only manifest. Mutating/pushing into the manifest can neither widen authority nor add
   * executable entries; the manifest hash is computed over the frozen manifest itself.
   */
  function createSnapshot() {
    const execution = new Map();
    for (const name of [...tools.keys()].sort()) {
      const entry = entryOf(name);
      execution.set(name, Object.freeze({ name, version: entry.snapshot.version, contractHash: entry.contractHash, snapshot: entry.snapshot, invoke: entry.invoke }));
    }
    const manifest = deepFreeze([...execution.values()].map((entry) => ({ ...entry.snapshot, contractHash: entry.contractHash })));
    const manifestByName = new Map(manifest.map((tool) => [tool.name, tool]));
    const hash = sha256Hex(canonicalJson(manifest.map((tool) => ({ name: tool.name, version: tool.version, contractHash: tool.contractHash }))));
    const find = (name) => {
      const id = requireNonEmptyString(name, 'name');
      const hit = execution.get(id);
      if (!hit) throw new NotFoundError(`unknown tool ${id} (not in this registry snapshot; fail-closed)`);
      return hit;
    };
    const snapshot = {
      version: 'tool-snapshot-v1',
      hash,
      tools: manifest,
      get: (name) => {
        const id = requireNonEmptyString(name, 'name');
        const view = manifestByName.get(id);
        if (!view) throw new NotFoundError(`unknown tool ${id} (not in this registry snapshot; fail-closed)`);
        return view;
      },
      list: () => manifest,
      invoke: async (name, args) => invokeTool(find(name), args)
    };
    return Object.freeze(snapshot);
  }

  function callStats() {
    return Object.fromEntries([...stats.entries()]);
  }

  return { register, get, list, createSnapshot, callStats };
}

module.exports = {
  TOOL_FIELDS,
  TOOL_KINDS,
  COST_KINDS,
  COST_SETTLEMENTS,
  ENVELOPE_STATUSES,
  EXTERNAL_IDENTITY_FIELDS,
  createToolRegistry
};
