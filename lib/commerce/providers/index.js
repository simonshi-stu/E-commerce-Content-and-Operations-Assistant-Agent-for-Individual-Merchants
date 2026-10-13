'use strict';
/**
 * Provider registry and tool-contract validation (T2.5 rev-01/rev-02, mock/fixture first).
 * A descriptor is a CONTRACT (id/version/capability/capabilityStatus/tools/idempotency level/
 * timeout/cost policy/limits) — unknown tools, unknown fields (descriptor, tools, cost policy,
 * context), credential-looking fields, incomplete versions and illegal money units fail closed.
 * The registry GOVERN the contract end to end: successful outputs are validated against the
 * declared outputSchema and credential-shaped business output is rejected; non-success results may
 * never carry an output; result envelopes are fail-closed (plain object, known status, declared
 * fields only). rev-02: validated descriptors are stored in PRIVATE frozen records together with a
 * registration-time bound invoke; get() returns only a frozen read-only view — no live entry,
 * descriptor alias or handler authority is ever exposed, so callers can never replace the contract
 * or the execution method. Execution contexts are controlled: project/brand may be an explicit null
 * (never a wildcard) and untrusted text can never change them. Executable non-mock calls require a
 * non-empty operationId/attemptToken.
 */
const { ValidationError, ConflictError, NotFoundError } = require('../evidence.js');
const { validateSchema, validateValue, assertNoCredentialFields, deepFreeze } = require('./schema.js');
const { createMockCatalog } = require('./mock.js');
const { createOpenAiCompatibleProvider, OPENAI_COMPATIBLE_BASE_DESCRIPTOR } = require('./openai-compatible.js');
const { estimateScenarioCost } = require('./cost.js');

const DESCRIPTOR_FIELDS = Object.freeze([
  'id', 'version', 'capability', 'capabilityStatus', 'tools', 'idempotencyLevel', 'timeoutMs',
  'statusQuerySupported', 'cancelSupported', 'refundSupported', 'enabledByDefault', 'limits', 'costPolicy'
]);
const TOOL_FIELDS = Object.freeze(['name', 'inputSchema', 'outputSchema']);
const CONTEXT_FIELDS = Object.freeze(['project', 'brand', 'market', 'locale', 'shipTo']);
const CAPABILITY_STATUSES = Object.freeze(['mock', 'fixture', 'live']);
const IDEMPOTENCY_LEVELS = Object.freeze(['supported', 'unsupported', 'unknown']);
const COST_POLICY_KINDS = Object.freeze(['mock_no_charge', 'priced', 'unknown_price']);
const COST_POLICY_FIELDS = Object.freeze({
  mock_no_charge: ['kind', 'currency', 'estimateMicros', 'note'],
  unknown_price: ['kind', 'currency', 'scenarioCapMicros', 'note'],
  priced: ['kind', 'currency', 'inputMicrosPerMillion', 'outputMicrosPerMillion', 'priceVersion', 'observedAt', 'tokenBounds', 'attempts', 'scenarioCapMicros', 'source', 'note']
});
const RESULT_STATUSES = Object.freeze(['succeeded', 'pending_reconcile', 'pending', 'blocked', 'failed_invalid_output', 'failed_provider_error']);
const RESULT_FIELDS = Object.freeze([
  'status', 'reason', 'output', 'usage', 'usageDiagnostics', 'remoteId', 'operationId', 'attemptToken',
  'safeRequestSummary', 'safeResponseSummary', 'httpStatus', 'calls'
]);

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
function requireSafeNonNegativeInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a safe non-negative integer`);
  return value;
}
function snapshotDescriptor(descriptor) {
  const clone = JSON.parse(JSON.stringify(descriptor));
  validateDescriptor(clone);
  return deepFreeze(clone);
}

function validateCostPolicy(policy, id) {
  if (!isPlainObject(policy)) fail(`${id}.costPolicy must be a plain object`);
  if (!COST_POLICY_KINDS.includes(policy.kind)) fail(`${id}.costPolicy.kind must be one of ${COST_POLICY_KINDS.join(', ')}`);
  for (const key of Object.keys(policy)) {
    if (!COST_POLICY_FIELDS[policy.kind].includes(key)) fail(`${id}.costPolicy.${key} is an unknown field for kind ${policy.kind} (fail-closed)`);
  }
  requireNonEmptyString(policy.currency, `${id}.costPolicy.currency`);
  if (policy.kind === 'mock_no_charge') {
    if (policy.estimateMicros !== undefined && policy.estimateMicros !== 0) fail(`${id}.costPolicy.estimateMicros must be 0 for mock_no_charge`);
    return;
  }
  if (policy.kind === 'unknown_price') {
    if (policy.scenarioCapMicros !== undefined && policy.scenarioCapMicros !== null) {
      requireSafeNonNegativeInt(policy.scenarioCapMicros, `${id}.costPolicy.scenarioCapMicros`);
    }
    return;
  }
  // priced: must be fully estimable with exact safe arithmetic (fail-closed proof)
  if (isPlainObject(policy.tokenBounds)) {
    for (const key of Object.keys(policy.tokenBounds)) {
      if (!['maxInputTokens', 'maxOutputTokens'].includes(key)) fail(`${id}.costPolicy.tokenBounds.${key} is an unknown field (fail-closed)`);
    }
  }
  const estimate = estimateScenarioCost({
    currency: policy.currency,
    unitPrices: {
      inputMicrosPerMillion: policy.inputMicrosPerMillion,
      outputMicrosPerMillion: policy.outputMicrosPerMillion,
      priceVersion: policy.priceVersion,
      observedAt: policy.observedAt
    },
    tokenBounds: policy.tokenBounds,
    attempts: policy.attempts,
    scenarioCapMicros: policy.scenarioCapMicros
  });
  if (estimate.status !== 'estimated' || estimate.placeholder === true) {
    fail(`${id}.costPolicy priced policy is not estimable: ${estimate.reason ?? 'invalid'}`);
  }
}

function validateDescriptor(descriptor) {
  if (!isPlainObject(descriptor)) fail('descriptor must be a plain object');
  for (const key of Object.keys(descriptor)) {
    if (!DESCRIPTOR_FIELDS.includes(key)) fail(`descriptor.${key} is an unknown field (fail-closed)`);
  }
  const id = requireNonEmptyString(descriptor.id, 'descriptor.id');
  assertNoCredentialFields(descriptor, 'descriptor');
  requireNonEmptyString(descriptor.version, `${id}.version`);
  requireNonEmptyString(descriptor.capability, `${id}.capability`);
  if (!CAPABILITY_STATUSES.includes(descriptor.capabilityStatus)) fail(`${id}.capabilityStatus must be one of ${CAPABILITY_STATUSES.join(', ')}`);
  if (!Array.isArray(descriptor.tools) || descriptor.tools.length === 0) fail(`${id}.tools must be a non-empty array`);
  const toolNames = new Set();
  for (const tool of descriptor.tools) {
    if (!isPlainObject(tool)) fail(`${id}.tools entries must be plain objects`);
    for (const key of Object.keys(tool)) {
      if (!TOOL_FIELDS.includes(key)) fail(`${id}.tools[].${key} is an unknown field (fail-closed)`);
    }
    const name = requireNonEmptyString(tool.name, `${id}.tools[].name`);
    if (toolNames.has(name)) fail(`${id}.tools has a duplicate tool ${name}`);
    toolNames.add(name);
    validateSchema(tool.inputSchema, `${id}.${name}.inputSchema`);
    if (tool.outputSchema !== null && tool.outputSchema !== undefined) {
      validateSchema(tool.outputSchema, `${id}.${name}.outputSchema`);
    }
  }
  if (!IDEMPOTENCY_LEVELS.includes(descriptor.idempotencyLevel)) fail(`${id}.idempotencyLevel must be one of ${IDEMPOTENCY_LEVELS.join(', ')}`);
  if (!Number.isSafeInteger(descriptor.timeoutMs) || descriptor.timeoutMs <= 0) fail(`${id}.timeoutMs must be a positive safe integer`);
  for (const flag of ['statusQuerySupported', 'cancelSupported', 'refundSupported', 'enabledByDefault']) {
    if (typeof descriptor[flag] !== 'boolean') fail(`${id}.${flag} must be a boolean`);
  }
  if (!isPlainObject(descriptor.limits)) fail(`${id}.limits must be a plain object`);
  validateCostPolicy(descriptor.costPolicy, id);
  return descriptor;
}

/** Controlled execution context: explicit null project/brand (never a wildcard); unknown fields rejected. */
function validateExecutionContext(context) {
  if (!isPlainObject(context)) fail('context must be a plain object');
  for (const key of Object.keys(context)) {
    if (!CONTEXT_FIELDS.includes(key)) fail(`context.${key} is an unknown field (fail-closed)`);
  }
  const normalized = {};
  for (const key of ['project', 'brand']) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) fail(`context.${key} must be provided (a string or an explicit null; null is never a wildcard)`);
    if (context[key] === null) normalized[key] = null;
    else normalized[key] = requireNonEmptyString(context[key], `context.${key}`);
  }
  for (const key of ['market', 'locale', 'shipTo']) {
    normalized[key] = requireNonEmptyString(context[key], `context.${key}`);
  }
  return normalized;
}

function createRegistry(options = {}) {
  const providers = new Map();
  const register = (descriptor, handler) => {
    if (providers.has(descriptor && descriptor.id)) throw new ConflictError(`provider ${descriptor.id} is already registered`);
    const frozen = snapshotDescriptor(descriptor);
    const hasHandler = handler !== undefined && handler !== null;
    // registration-time bound method: later mutation of the caller's handler object cannot change execution authority
    const invokeFn = hasHandler && typeof handler.invoke === 'function' ? handler.invoke.bind(handler) : null;
    if (hasHandler && invokeFn === null) fail(`provider ${frozen.id} handler must expose invoke()`);
    // PRIVATE record: frozen descriptor snapshot + bound method; never returned as a live alias
    providers.set(frozen.id, Object.freeze({ descriptor: frozen, invoke: invokeFn }));
    return frozen.id;
  };
  const list = () => [...providers.values()].map((entry) => entry.descriptor);
  const lookup = (providerId) => {
    const entry = providers.get(providerId);
    if (!entry) throw new NotFoundError(`unknown provider ${providerId}`);
    return entry;
  };
  /** Public getter: only a frozen read-only view; internal entry/handler authority is never exposed. */
  const get = (providerId) => {
    const entry = lookup(providerId);
    return Object.freeze({ id: entry.descriptor.id, descriptor: entry.descriptor });
  };
  const resolveTool = (toolName) => {
    const matches = [...providers.values()].filter((entry) => entry.descriptor.tools.some((tool) => tool.name === toolName));
    if (matches.length === 0) throw new NotFoundError(`unknown tool ${toolName} (fail-closed; no provider declares it)`);
    if (matches.length > 1) throw new ConflictError(`tool ${toolName} is declared by multiple providers; refusing an ambiguous resolution`);
    return { providerId: matches[0].descriptor.id, tool: toolName };
  };
  const invoke = async ({ providerId, tool, input, operationId, attemptToken, context, now } = {}) => {
    const entry = lookup(providerId);
    const toolDef = entry.descriptor.tools.find((candidate) => candidate.name === tool);
    if (!toolDef) throw new NotFoundError(`provider ${providerId} does not provide tool ${tool}`);
    const normalizedContext = validateExecutionContext(context);
    assertNoCredentialFields(input, 'input');
    validateValue(toolDef.inputSchema, input, 'input');
    if (entry.descriptor.capabilityStatus !== 'mock') {
      requireNonEmptyString(operationId, 'operationId (executable non-mock calls require a controlled execution identity)');
      requireNonEmptyString(attemptToken, 'attemptToken (executable non-mock calls require the current attempt identity)');
    }
    if (!entry.invoke) fail(`provider ${providerId} has no executable handler`);
    const result = await entry.invoke({ tool, input, operationId, attemptToken, context: normalizedContext, now });
    // fail-closed result envelope: plain object, known status, declared fields only
    if (!isPlainObject(result)) fail(`provider ${providerId} returned a non-object result (fail-closed)`);
    if (typeof result.status !== 'string' || !RESULT_STATUSES.includes(result.status)) fail(`provider ${providerId} returned an unknown result status (fail-closed)`);
    for (const key of Object.keys(result)) {
      if (!RESULT_FIELDS.includes(key)) fail(`provider ${providerId} result.${key} is an undeclared result field (fail-closed)`);
    }
    assertNoCredentialFields(result, 'result');
    if (result.status === 'succeeded') {
      if (!Object.prototype.hasOwnProperty.call(result, 'output')) fail(`provider ${providerId} returned succeeded without an output (fail-closed)`);
      if (toolDef.outputSchema !== null && toolDef.outputSchema !== undefined) {
        validateValue(toolDef.outputSchema, result.output, 'output');
      }
    } else if (Object.prototype.hasOwnProperty.call(result, 'output')) {
      fail(`provider ${providerId} returned a non-success result carrying an output (never pretend success)`);
    }
    return { ...result, context: normalizedContext };
  };
  for (const provider of options.providers ?? []) {
    register(provider.descriptor, provider);
  }
  return { register, list, get, resolveTool, invoke };
}

/** Default registry: the mock catalog plus the S1 adapter (only when explicitly configured). */
function createDefaultRegistry(options = {}) {
  const registry = createRegistry();
  for (const mock of createMockCatalog()) {
    registry.register(mock.descriptor, mock);
  }
  if (options.s1) {
    const s1 = createOpenAiCompatibleProvider(options.s1);
    registry.register(s1.descriptor, s1);
  }
  return registry;
}

module.exports = {
  DESCRIPTOR_FIELDS,
  TOOL_FIELDS,
  CONTEXT_FIELDS,
  CAPABILITY_STATUSES,
  IDEMPOTENCY_LEVELS,
  RESULT_STATUSES,
  RESULT_FIELDS,
  deepFreeze,
  snapshotDescriptor,
  validateDescriptor,
  validateExecutionContext,
  validateCostPolicy,
  createRegistry,
  createDefaultRegistry
};
