'use strict';
/**
 * S1 OpenAI-compatible adapter (T2.5 rev-01/rev-02): the T0.4-selected route — OpenAI-compatible
 * `gpt-4o-mini` text + EXACTLY one image at fixed `detail: low`.
 *
 * Modes (default CLOSED):
 * - `mode:'fixture'` — an explicit LOCAL SYNTHETIC route with an injected transport. It needs no
 *   real credentials/user-charge approval and is NOT a network-authorization switch; tests never
 *   fetch a real endpoint.
 * - `mode:'live'` — the future real route. Before any transport call it requires: explicit
 *   `enabled`, a credential-config boolean (probe only; values are never read here), purpose /
 *   source / user-budget authorizations, AND per-invocation engineering permits (`budget` and
 *   `idempotency`) that are granted and BOUND to this operationId/attemptToken — a factory boolean
 *   can never authorize arbitrary later operations. It never claims production authentication.
 * - anything else — blocked `provider_disabled` with zero transport calls.
 *
 * Contracts: non-mock executable calls require a non-empty operationId/attemptToken (user text can
 * never change mode/permission/context); at most one transport call per invoke (no automatic
 * retry); thrown timeout/network outcomes retain the supplied opaque remote reference; invalid
 * transport outcomes are safely classified as pending_reconcile; input limits use a documented
 * CONSERVATIVE envelope (UTF-8 bytes + serialization overhead — an upper bound on BPE tokens, NOT
 * a tokenizer count); base64 is strictly validated; usage beyond the declared bounds is reported
 * truthfully as a reconciliation diagnostic (never truncated, never a within-cap success). rev-02
 * authority: the parser hook and the enforced limits are independent immutable snapshots taken at
 * factory time — mutating the caller's schema object, the exported shared constants, or the public
 * descriptor can never loosen validation; the caller's objects are never frozen. rev-02 diagnostics:
 * invalid usage observations are sanitized to safe scalar facts only (numbers/type markers/null);
 * arbitrary objects, credential-shaped payloads or raw bodies never enter any result or summary.
 * Chat completions declare NO idempotency/status/cancel/refund guarantees — unsupported, never
 * fabricated.
 */
const crypto = require('node:crypto');
const { ValidationError } = require('../evidence.js');
const { validateSchema, validateValue, decodeStrictBase64, deepFreeze } = require('./schema.js');
const { estimateScenarioCost } = require('./cost.js');

function fail(message) {
  throw new ValidationError(message);
}
function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
  return value.trim();
}

/** Immutable internal limits: enforcement never reads the public (mutable-surface) descriptor. */
const S1_LIMITS = deepFreeze({
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  maxImages: 1,
  imageDetail: 'low',
  baseImageUnitsLow: 2833,
  maxPromptUnits: 400,
  maxInputUnits: 3300,
  maxOutputUnits: 300,
  serializationOverheadUnits: 64,
  timeoutMs: 30000
});

/** Frozen T0.4 cost observations (pricing.md 2026-10-08T06:16:15Z; image tokens 2026-10-08T06:15:42Z). */
const S1_COST_POLICY = deepFreeze({
  kind: 'priced',
  currency: 'USD',
  inputMicrosPerMillion: 150000,
  outputMicrosPerMillion: 600000,
  priceVersion: 't0.4-pricing-2026-10-08T06:16:15Z',
  observedAt: '2026-10-08T06:16:15.000Z',
  tokenBounds: { maxInputTokens: S1_LIMITS.maxInputUnits, maxOutputTokens: S1_LIMITS.maxOutputUnits },
  attempts: 2,
  scenarioCapMicros: 50000,
  source: 'T0.4 route-observations-revision02 / pricing.md; image token ceiling runtime/tmp/T0.4/sol-review-02/image-billing-observation.json'
});

const VISION_INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['prompt', 'image'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 2000 },
    image: {
      type: 'object',
      required: ['mediaType', 'bytesBase64'],
      properties: {
        mediaType: { type: 'string', enum: ['image/png', 'image/jpeg'] },
        bytesBase64: { type: 'string', minLength: 4, maxLength: 4000000 }
      },
      additionalProperties: false
    },
    detail: { type: 'string', enum: ['low'] }
  },
  additionalProperties: false
});
const TEXT_INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['prompt'],
  properties: { prompt: { type: 'string', minLength: 1, maxLength: 2000 } },
  additionalProperties: false
});
validateSchema(VISION_INPUT_SCHEMA, 'S1.vision.understand.inputSchema');
validateSchema(TEXT_INPUT_SCHEMA, 'S1.text.understand.inputSchema');

/**
 * Conservative input envelope: UTF-8 bytes + a fixed serialization overhead budget. UTF-8 bytes
 * are an upper bound on BPE tokens (every token covers at least one byte), so exceeding this
 * envelope is a provable reason to refuse — it is NOT a tokenizer count and makes no exact-token
 * claim. The overhead covers JSON message framing/serialization.
 */
function conservativeEnvelopeUnits(text) {
  return Buffer.byteLength(String(text), 'utf8') + S1_LIMITS.serializationOverheadUnits;
}

/**
 * Build the real OpenAI-compatible request body for one S1 call. Exactly one image at detail low
 * for vision; a separate text-only tool exists so a text answer never masquerades as vision.
 */
function buildS1Request({ tool, input } = {}) {
  if (tool === 'vision.understand') {
    validateValue(VISION_INPUT_SCHEMA, input, 'input');
    const prompt = input.prompt;
    const detail = input.detail ?? 'low';
    if (detail !== 'low') fail('S1 fixes detail to "low"; high/auto are not allowed');
    const promptUnits = conservativeEnvelopeUnits(prompt);
    if (promptUnits > S1_LIMITS.maxPromptUnits) {
      fail(`prompt exceeds the S1 limit of ${S1_LIMITS.maxPromptUnits} conservative units (utf8 bytes + serialization overhead; not a tokenizer count)`);
    }
    if (promptUnits + S1_LIMITS.baseImageUnitsLow > S1_LIMITS.maxInputUnits) {
      fail(`estimated input exceeds the S1 limit of ${S1_LIMITS.maxInputUnits} conservative units`);
    }
    const imageBytes = decodeStrictBase64(input.image.bytesBase64, 'input.image.bytesBase64');
    const body = {
      model: S1_LIMITS.model,
      max_tokens: S1_LIMITS.maxOutputUnits,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${input.image.mediaType};base64,${input.image.bytesBase64}`, detail: 'low' } }
        ]
      }]
    };
    const summary = {
      tool,
      model: S1_LIMITS.model,
      messageCount: 1,
      imageCount: 1,
      imageDetail: 'low',
      imageMediaType: input.image.mediaType,
      imageSha256: crypto.createHash('sha256').update(imageBytes).digest('hex'),
      promptChars: prompt.length,
      promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
      serializationOverheadUnits: S1_LIMITS.serializationOverheadUnits,
      promptEnvelopeUnits: promptUnits,
      maxOutputUnits: S1_LIMITS.maxOutputUnits
    };
    return { body, summary };
  }
  if (tool === 'text.understand') {
    validateValue(TEXT_INPUT_SCHEMA, input, 'input');
    const prompt = input.prompt;
    const promptUnits = conservativeEnvelopeUnits(prompt);
    if (promptUnits > S1_LIMITS.maxPromptUnits) {
      fail(`prompt exceeds the S1 limit of ${S1_LIMITS.maxPromptUnits} conservative units (utf8 bytes + serialization overhead; not a tokenizer count)`);
    }
    const body = {
      model: S1_LIMITS.model,
      max_tokens: S1_LIMITS.maxOutputUnits,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    };
    const summary = {
      tool,
      model: S1_LIMITS.model,
      messageCount: 1,
      imageCount: 0,
      imageDetail: null,
      promptChars: prompt.length,
      promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
      serializationOverheadUnits: S1_LIMITS.serializationOverheadUnits,
      promptEnvelopeUnits: promptUnits,
      maxOutputUnits: S1_LIMITS.maxOutputUnits
    };
    return { body, summary };
  }
  fail(`unknown S1 tool ${tool}`);
}

/** Parse a 200 response: assistant content must be directly parseable JSON matching the schema. */
function parseS1Response(responseBody, outputSchema) {
  const content = responseBody?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') fail('response has no assistant content');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    fail('assistant content is not directly parseable JSON (strict; no fence stripping)');
  }
  validateValue(outputSchema, parsed, 'output');
  return {
    output: parsed,
    usage: {
      inputTokens: responseBody?.usage?.prompt_tokens ?? null,
      outputTokens: responseBody?.usage?.completion_tokens ?? null
    },
    remoteId: typeof responseBody?.id === 'string' && responseBody.id !== '' ? responseBody.id : null
  };
}

/**
 * Sanitize raw usage observations (rev-02): only safe scalar facts may surface. Trusted
 * non-negative safe integers and real overrun numbers are retained EXACTLY; other finite numbers
 * stay exact numeric diagnostics; anything else (objects/arrays/strings/booleans/non-finite)
 * keeps only a type marker with a null value — never the payload, a credential value, an error
 * body or a synthesized 0. Missing stays null.
 */
function sanitizeUsage(rawUsage) {
  const sanitize = (value) => {
    if (value === null || value === undefined) return { value: null, kind: 'missing' };
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { value, kind: Number.isSafeInteger(value) && value >= 0 ? 'valid' : 'numeric_invalid' };
    }
    return { value: null, kind: 'type_invalid', type: Array.isArray(value) ? 'array' : typeof value };
  };
  const input = sanitize(rawUsage?.inputTokens);
  const output = sanitize(rawUsage?.outputTokens);
  return {
    usage: { inputTokens: input.value, outputTokens: output.value },
    diagnostics: {
      inputTokens: { kind: input.kind, ...(input.type ? { type: input.type } : {}) },
      outputTokens: { kind: output.kind, ...(output.type ? { type: output.type } : {}) }
    }
  };
}

/** Declared-bounds classification over SANITIZED usage; invalid kinds stay diagnostics, never valid cost facts. */
function classifyUsage(sanitized, limits) {
  const { usage, diagnostics } = sanitized;
  const kinds = [diagnostics.inputTokens.kind, diagnostics.outputTokens.kind];
  if (kinds.includes('numeric_invalid') || kinds.includes('type_invalid')) return { status: 'invalid' };
  if (usage.inputTokens !== null && usage.inputTokens > limits.maxInputUnits) return { status: 'out_of_bounds' };
  if (usage.outputTokens !== null && usage.outputTokens > limits.maxOutputUnits) return { status: 'out_of_bounds' };
  return { status: 'ok' };
}

const OPENAI_COMPATIBLE_BASE_DESCRIPTOR = deepFreeze({
  id: 'openai-compatible',
  version: 's1-2026-10-08',
  capability: 'vision.understand+text.understand',
  capabilityStatus: 'fixture',
  tools: [
    { name: 'vision.understand', inputSchema: VISION_INPUT_SCHEMA, outputSchema: null },
    { name: 'text.understand', inputSchema: TEXT_INPUT_SCHEMA, outputSchema: null }
  ],
  idempotencyLevel: 'unsupported',
  timeoutMs: S1_LIMITS.timeoutMs,
  statusQuerySupported: false,
  cancelSupported: false,
  refundSupported: false,
  enabledByDefault: false,
  limits: {
    maxImages: S1_LIMITS.maxImages,
    imageDetail: S1_LIMITS.imageDetail,
    maxPromptUnits: S1_LIMITS.maxPromptUnits,
    maxInputUnits: S1_LIMITS.maxInputUnits,
    maxOutputUnits: S1_LIMITS.maxOutputUnits,
    attemptsPerInvocation: 1
  },
  costPolicy: S1_COST_POLICY
});

/**
 * Create the S1 adapter with dependency-injected transport. Default closed. The parser hook is an
 * independent frozen snapshot (the caller's schema object is never frozen and never read again);
 * the descriptor advertises that same snapshot and is itself deep-frozen pure data.
 */
function createOpenAiCompatibleProvider(options = {}) {
  const mode = options.mode;
  if (mode !== undefined && mode !== 'fixture' && mode !== 'live') fail('mode must be "fixture" or "live" when provided; anything else stays closed');
  const transport = options.transport;
  if (typeof transport !== 'function') fail('transport must be a function (dependency-injected; fixture in tests)');
  const outputSchema = options.outputSchema;
  if (outputSchema === undefined || outputSchema === null) fail('outputSchema is required: the S1 output hook must be declared and is used by the parser');
  validateSchema(outputSchema, 'outputSchema');
  // independent immutable snapshot: enforcement/parsing never read the caller's mutable object
  const outputHook = deepFreeze(JSON.parse(JSON.stringify(outputSchema)));
  const credentialProbe = options.credentialProbe;
  if (mode === 'live' && typeof credentialProbe !== 'function') fail('credentialProbe (boolean-only) is required for live mode');
  const enabled = options.enabled === true;
  const authorizations = options.authorizations ?? null;
  let calls = 0;
  const descriptor = deepFreeze({
    ...OPENAI_COMPATIBLE_BASE_DESCRIPTOR,
    tools: OPENAI_COMPATIBLE_BASE_DESCRIPTOR.tools.map((tool) => ({ ...tool, outputSchema: outputHook })),
    limits: { ...OPENAI_COMPATIBLE_BASE_DESCRIPTOR.limits }
  });

  async function invoke({ tool, input, operationId, attemptToken, permits, now } = {}) {
    const opId = typeof operationId === 'string' && operationId.trim() !== '' ? operationId : null;
    const attToken = typeof attemptToken === 'string' && attemptToken.trim() !== '' ? attemptToken : null;
    if (!opId || !attToken) {
      return { status: 'blocked', reason: 'missing_execution_identity', operationId: opId, attemptToken: attToken, calls };
    }
    const base = { operationId: opId, attemptToken: attToken };
    if (mode === 'fixture') {
      // explicit local synthetic route: injected transport only; NOT a network authorization switch
    } else if (mode === 'live') {
      if (!enabled) return { status: 'blocked', reason: 'provider_disabled', ...base, calls };
      if (credentialProbe() !== true) return { status: 'blocked', reason: 'missing_credentials', ...base, calls };
      if (!authorizations || authorizations.purpose !== true) return { status: 'blocked', reason: 'missing_purpose_authorization', ...base, calls };
      if (authorizations.source !== true) return { status: 'blocked', reason: 'missing_source_authorization', ...base, calls };
      if (authorizations.userBudget !== true) return { status: 'blocked', reason: 'missing_user_budget_approval', ...base, calls };
      const budgetPermit = permits && permits.budget;
      if (!budgetPermit || budgetPermit.granted !== true) return { status: 'blocked', reason: 'budget_blocked', ...base, calls };
      if (budgetPermit.operationId !== opId || budgetPermit.attemptToken !== attToken) return { status: 'blocked', reason: 'permit_identity_mismatch', ...base, calls };
      const idempotencyPermit = permits && permits.idempotency;
      if (!idempotencyPermit || idempotencyPermit.granted !== true) return { status: 'blocked', reason: 'idempotency_blocked', ...base, calls };
      if (idempotencyPermit.operationId !== opId || idempotencyPermit.attemptToken !== attToken) return { status: 'blocked', reason: 'permit_identity_mismatch', ...base, calls };
    } else {
      return { status: 'blocked', reason: 'provider_disabled', ...base, calls };
    }
    const { body, summary } = buildS1Request({ tool, input });
    let outcome;
    calls += 1;
    try {
      outcome = await transport({
        url: `${S1_LIMITS.baseUrl}/chat/completions`,
        method: 'POST',
        body,
        timeoutMs: descriptor.timeoutMs
      });
    } catch (error) {
      // thrown timeout/network: retain the supplied opaque reference; never leak raw error text
      const suppliedRemote = error && typeof error.remoteId === 'string' && error.remoteId !== '' ? error.remoteId : null;
      outcome = error && error.kind === 'timeout'
        ? { kind: 'timeout', remoteId: suppliedRemote }
        : { kind: 'network_unknown', remoteId: suppliedRemote };
    }
    const pendingFor = (reason, remoteId, extraSummary) => ({
      status: 'pending_reconcile',
      reason,
      remoteId: remoteId ?? null,
      ...base,
      safeRequestSummary: summary,
      safeResponseSummary: extraSummary ?? { kind: reason },
      calls
    });
    if (!outcome || typeof outcome !== 'object' || (outcome.kind !== 'timeout' && outcome.kind !== 'network_unknown' && outcome.kind !== 'response')) {
      return pendingFor('invalid_transport_outcome', outcome && typeof outcome.remoteId === 'string' ? outcome.remoteId : null);
    }
    if (outcome.kind === 'timeout') return pendingFor('timeout', outcome.remoteId ?? null);
    if (outcome.kind === 'network_unknown') return pendingFor('network_unknown', outcome.remoteId ?? null);
    const httpStatus = outcome.httpStatus;
    if (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
      return pendingFor('invalid_transport_outcome', outcome.remoteId ?? null);
    }
    const remoteId = outcome.remoteId ?? (outcome.body && typeof outcome.body.id === 'string' ? outcome.body.id : null);
    if (httpStatus === 200) {
      let parsed;
      try {
        parsed = parseS1Response(outcome.body, outputHook);
      } catch (error) {
        return { status: 'failed_invalid_output', reason: error.message, remoteId, ...base, safeRequestSummary: summary, safeResponseSummary: { httpStatus }, calls };
      }
      const sanitized = sanitizeUsage(parsed.usage);
      const usageCheck = classifyUsage(sanitized, { maxInputUnits: S1_LIMITS.maxInputUnits, maxOutputUnits: S1_LIMITS.maxOutputUnits });
      const resolvedRemote = parsed.remoteId ?? remoteId;
      const declaredBounds = { maxInputUnits: S1_LIMITS.maxInputUnits, maxOutputUnits: S1_LIMITS.maxOutputUnits };
      if (usageCheck.status !== 'ok') {
        const invalid = usageCheck.status === 'invalid';
        // truthful diagnostic: safe numeric facts/reference retained; never truncated to the cap,
        // never a within-cap success, never an arbitrary upstream payload
        return {
          status: 'pending_reconcile',
          reason: invalid ? 'usage_invalid' : 'usage_exceeds_declared_bounds',
          usage: sanitized.usage,
          ...(invalid ? { usageDiagnostics: sanitized.diagnostics } : {}),
          remoteId: resolvedRemote,
          ...base,
          safeRequestSummary: summary,
          safeResponseSummary: invalid
            ? { httpStatus, remoteId: resolvedRemote, usage: sanitized.usage, usageDiagnostics: sanitized.diagnostics, declaredBounds }
            : { httpStatus, remoteId: resolvedRemote, usage: sanitized.usage, declaredBounds },
          calls
        };
      }
      return {
        status: 'succeeded',
        output: parsed.output,
        usage: sanitized.usage,
        remoteId: resolvedRemote,
        ...base,
        safeRequestSummary: summary,
        safeResponseSummary: { httpStatus, remoteId: resolvedRemote, usage: sanitized.usage },
        calls
      };
    }
    if (httpStatus === 202) return pendingFor('accepted_202', remoteId, { httpStatus });
    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return pendingFor('provider_retryable_status', remoteId, { httpStatus });
    return { status: 'failed_provider_error', reason: 'provider_error_status', httpStatus, remoteId, ...base, safeRequestSummary: summary, safeResponseSummary: { httpStatus }, calls };
  }

  return {
    descriptor,
    calls: () => calls,
    invoke
  };
}

/** Frozen S1 bounded worst-case estimate helper (explicit numbers; integer micros). */
function s1ScenarioCost() {
  return estimateScenarioCost({
    currency: S1_COST_POLICY.currency,
    unitPrices: {
      inputMicrosPerMillion: S1_COST_POLICY.inputMicrosPerMillion,
      outputMicrosPerMillion: S1_COST_POLICY.outputMicrosPerMillion,
      priceVersion: S1_COST_POLICY.priceVersion,
      observedAt: S1_COST_POLICY.observedAt
    },
    tokenBounds: S1_COST_POLICY.tokenBounds,
    attempts: S1_COST_POLICY.attempts,
    scenarioCapMicros: S1_COST_POLICY.scenarioCapMicros
  });
}

module.exports = {
  S1_LIMITS,
  S1_COST_POLICY,
  OPENAI_COMPATIBLE_BASE_DESCRIPTOR,
  VISION_INPUT_SCHEMA,
  TEXT_INPUT_SCHEMA,
  conservativeEnvelopeUnits,
  buildS1Request,
  parseS1Response,
  sanitizeUsage,
  classifyUsage,
  createOpenAiCompatibleProvider,
  s1ScenarioCost
};
