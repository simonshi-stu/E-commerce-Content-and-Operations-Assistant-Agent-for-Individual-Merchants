'use strict';
/**
 * T3.1 connector assembly (revision-01).
 *
 * The execution entry point enforces, before any transport call: the structured execution
 * grant vs the transport capability (fixture/manual/live; live default closed), the canonical
 * URL target (protocol/credentials/private-local/host/path + meta consistency), the runner
 * authority (orchestrator context or explicit trusted runner config), and the permit for
 * network transports. Response-declared source/final URLs must agree with the request target;
 * a fixture execution that claims a non-synthetic result is a contradiction and is refused.
 * The rate limiter lives on the connector (one source/version execution domain) so its window
 * survives separate observe calls, and Retry-After is never shortened below the source's wait.
 */
const crypto = require('node:crypto');
const { canonicalJson } = require('../packs.js');
const { deepFreeze } = require('../providers/schema.js');
const { connectorError, isPlainObject, validateSourceRegistration, evaluatePermit } = require('./source-register.js');
const { MODES, createRateLimiter, executeWithPolicy } = require('./transport.js');
const { assertRequestTarget, assertResponseSource } = require('./url-policy.js');
const { amazonUsPdpAdapter } = require('./amazon-us-pdp.js');

const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

const CONNECTOR_TOOL_NAME = 'connector.amazon-us-pdp.observe';
const CONNECTOR_TOOL_VERSION = '1.0.0';
const CONNECTOR_ROLE = 'research-selection';
const AUTHORITY_KINDS = Object.freeze(['orchestrator_context', 'runner_config']);
/** Reviewed, exact aliases only (empty until a sourced alias list is approved); never substring-based. */
const VARIANT_ALIASES = Object.freeze({});
const OBSERVATION_RULES = Object.freeze({
  searchIsNotPrice: true,
  ratingsAreNotSales: true,
  monthlyLabelsAreNotShare: true,
  missingReviewsDoNotBlockPrice: true,
  conflictingPricesNotReducedToLowest: true,
  selectedVariantBoundToPrimaryOffer: true
});

function normalizeAuthority(authority) {
  if (!isPlainObject(authority)) throw connectorError('authority_invalid', 'authority must be a plain object');
  const kind = authority.kind;
  if (!AUTHORITY_KINDS.includes(kind)) throw connectorError('authority_invalid', 'authority.kind is not a known kind');
  if (typeof authority.projectId !== 'string' || authority.projectId === '') throw connectorError('authority_invalid', 'authority.projectId must be a non-empty string');
  const brand = authority.brand === null || authority.brand === undefined ? '' : authority.brand;
  if (typeof brand !== 'string') throw connectorError('authority_invalid', 'authority.brand must be a string (empty = no brand; null is not a wildcard)');
  if (typeof authority.market !== 'string' || authority.market === '') throw connectorError('authority_invalid', 'authority.market must be a non-empty string');
  return { kind, projectId: authority.projectId, brand, market: authority.market };
}

function validateScope(scope, adapter) {
  if (!isPlainObject(scope)) throw connectorError('scope_invalid', 'scope must be a plain object bound by the runner authority');
  for (const key of ['projectId', 'brand', 'market', 'locale', 'shipTo', 'windowMs']) {
    if (!(key in scope)) throw connectorError('scope_invalid', `scope.${key} is required (bound by the runner authority)`);
  }
  if (typeof scope.projectId !== 'string' || scope.projectId === '') throw connectorError('scope_invalid', 'scope.projectId must be a non-empty string');
  if (typeof scope.brand !== 'string') throw connectorError('scope_invalid', "scope.brand must be a string ('' means no brand)");
  if (scope.market !== adapter.market) throw connectorError('scope_market_mismatch', `scope.market ${scope.market} does not match the registered source market ${adapter.market}`);
  if (scope.locale !== adapter.locale) throw connectorError('scope_locale_mismatch', `scope.locale ${scope.locale} does not match the registered source locale ${adapter.locale}`);
  if (scope.shipTo !== 'US') throw connectorError('scope_shipto_mismatch', 'scope.shipTo must match the registered source market US');
  if (!Number.isInteger(scope.windowMs) || scope.windowMs <= 0) throw connectorError('scope_invalid', 'scope.windowMs must be a positive integer');
  return { projectId: scope.projectId, brand: scope.brand, market: scope.market, locale: scope.locale, shipTo: scope.shipTo, windowMs: scope.windowMs };
}

/** Cache/observation window key: every scope dimension + source version + subject is bound in. */
function cacheKeyFor(scope, source, subject) {
  return sha256Hex(canonicalJson({
    projectId: scope.projectId,
    brand: scope.brand,
    market: scope.market,
    locale: scope.locale,
    shipTo: scope.shipTo,
    windowMs: scope.windowMs,
    sourceId: source.sourceId,
    sourceVersion: source.version,
    asin: subject.asin,
    variantLabel: subject.variantLabel
  }));
}

/** A synthetic fixture observation can never be marked live; the guard is enforced, not advisory. */
function assertNoSyntheticPromotion(observation) {
  if (observation && isPlainObject(observation.provenance) && observation.provenance.synthetic === true && observation.provenance.live === true) {
    throw connectorError('synthetic_promotion_forbidden', 'a synthetic fixture observation can never be marked live');
  }
  return observation;
}

/** Pure normalization (case/whitespace only): 12cm ≠ 120, Blue ≠ Blue Black. */
function normalizeVariantValue(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Exact, dimension-bound variant matching: every request token must equal (after normalization or
 * a reviewed exact alias) exactly one page selection value, and every selection value must be
 * matched by exactly one token — substring containment never confirms a configuration, and a
 * single selection can never satisfy multiple tokens.
 */
function variantTokensMatch(variantLabel, selections) {
  const tokens = String(variantLabel).split(/[,，]+/).map((token) => normalizeVariantValue(token)).filter((token) => token !== '');
  if (tokens.length === 0) return false;
  const values = selections.map((selection) => normalizeVariantValue(selection.value));
  if (values.length !== tokens.length) return false; // missing or extra selection info -> unknown configuration
  const used = new Set();
  for (const token of tokens) {
    const needle = VARIANT_ALIASES[token] ?? token;
    let matched = false;
    for (let index = 0; index < values.length; index += 1) {
      if (used.has(index)) continue;
      const candidate = VARIANT_ALIASES[values[index]] ?? values[index];
      if (candidate === needle) {
        used.add(index);
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return used.size === values.length;
}

function buildObservation({ source, scope, authority, subject, page, mode, capability, transportInfo, request, use }) {
  const synthetic = transportInfo.synthetic === true || page.pageSynthetic === true;
  const live = capability === 'live' && synthetic === false;
  const attributionOk = page.pageAsin !== null && page.pageAsin === subject.asin && page.selections.length > 0 && variantTokensMatch(subject.variantLabel, page.selections);
  const reasons = [];
  let status = 'observed';
  let price = null;
  if (page.pageAsin === null) {
    status = 'candidate';
    reasons.push('page_asin_missing');
  } else if (page.pageAsin !== subject.asin) {
    status = 'candidate';
    reasons.push('page_asin_mismatch');
  } else if (page.selections.length === 0) {
    status = 'candidate';
    reasons.push('variant_selection_missing');
  } else if (!variantTokensMatch(subject.variantLabel, page.selections)) {
    status = 'candidate';
    reasons.push('variant_selection_mismatch');
  } else if (page.priceStatus === 'conflict') {
    status = 'candidate';
    reasons.push('price_conflict');
  } else if (page.priceStatus === 'currency_unknown') {
    status = 'candidate';
    reasons.push('currency_unknown');
  } else if (page.priceStatus === 'missing') {
    status = 'unknown';
    reasons.push('price_missing');
  } else {
    price = page.price;
  }
  const observedAtRaw = transportInfo.observedAt !== undefined && transportInfo.observedAt !== null ? transportInfo.observedAt : page.observedAt;
  const observedAt = typeof observedAtRaw === 'string' ? observedAtRaw : '';
  const observation = {
    schemaVersion: 1,
    kind: 'market_observation',
    sourceId: source.sourceId,
    sourceVersion: source.version,
    use,
    mode,
    scope: { projectId: scope.projectId, brand: scope.brand, market: scope.market, locale: scope.locale, shipTo: scope.shipTo, windowMs: scope.windowMs },
    scopeHash: sha256Hex(canonicalJson(scope)),
    cacheKey: cacheKeyFor(scope, source, subject),
    authority: { kind: authority.kind, projectId: authority.projectId, brand: authority.brand, market: authority.market },
    subject: { asin: subject.asin, variantLabel: subject.variantLabel, selectedVariant: attributionOk },
    status,
    reasons,
    price: price === null
      ? { observed: false, amountText: '', amountMicros: 0, currency: 'unknown', rawCurrencySymbol: '' }
      : { observed: true, amountText: price.amountText, amountMicros: price.amountMicros, currency: price.currency, rawCurrencySymbol: price.rawCurrencySymbol ?? '' },
    priceCandidates: page.priceCandidates,
    excludedPrices: page.excludedPrices,
    title: page.title === null ? '' : page.title,
    availability: page.availability,
    rating: page.rating === null
      ? { observed: false, value: 0, count: 0, countKnown: false }
      : { observed: true, value: page.rating.value, count: page.rating.count === null ? 0 : page.rating.count, countKnown: page.rating.count !== null },
    rules: { ...OBSERVATION_RULES },
    provenance: {
      sourceUrl: transportInfo.sourceUrl ?? request.url,
      observedAt,
      observedAtKnown: observedAt !== '',
      fetchedAt: page.fetchedAt ?? '',
      mode,
      capability,
      synthetic,
      live,
      fixtureLabel: transportInfo.fixtureLabel ?? ''
    }
  };
  return deepFreeze(observation);
}

/** Module-internal trusted channel: connector -> (authority, args) => outcome. Only the approved
 *  registry handler (created in this module) may call it, with the runner-injected invoke.context
 *  authority; it is unreachable from public payloads. */
const INTERNAL_OBSERVE = new WeakMap();

function createConnector({ source, adapter = amazonUsPdpAdapter, transports = {}, clock = () => new Date().toISOString(), sleep, runnerAuthority = null } = {}) {
  const registration = validateSourceRegistration(source);
  let authorityConfig = null;
  if (runnerAuthority !== null && runnerAuthority !== undefined) {
    authorityConfig = normalizeAuthority({ ...runnerAuthority, kind: 'runner_config' });
  }
  // one limiter per connector: the same source/version execution domain keeps its window
  const limiter = createRateLimiter({ rateLimit: registration.permit.rateLimit, clock: () => Date.parse(clock()), sleep });
  /** Shared execution path; `authority` here is ALWAYS a trusted, normalized authority (factory
   *  binding or the module-internal handler channel). */
  async function executeObserve({ request, mode, scope, authority }) {
    if (!MODES.includes(mode)) return { status: 'failed', code: 'mode_unknown', transportCalls: 0 };
    const transport = transports[mode];
    if (!transport || typeof transport.fetch !== 'function') return { status: 'needs_permission', code: `mode_unavailable_${mode}`, transportCalls: 0 };
    const capability = transport.capability ?? (transport.network ? 'live' : 'fixture');
    const grants = registration.permit.execution;
    if (grants[capability] !== true) {
      return {
        status: capability === 'live' ? 'needs_permission' : 'blocked',
        code: capability === 'live' ? 'live_execution_not_authorized' : `execution_not_authorized_${capability}`,
        transportCalls: transport.calls.length
      };
    }
    try {
      assertRequestTarget(request, registration);
    } catch (error) {
      return { status: 'blocked', code: error.code, transportCalls: transport.calls.length };
    }
    let normalizedScope;
    try {
      normalizedScope = validateScope(scope, adapter);
    } catch (error) {
      return { status: 'blocked', code: error.code, transportCalls: 0 };
    }
    if (transport.network === true) {
      const decision = evaluatePermit(registration, request, { at: clock() });
      if (!decision.allowed) return { status: 'blocked', code: decision.code, transportCalls: transport.calls.length };
    }
    // ---- authority scope match: `authority` is trusted (factory binding or the module-internal
    // handler channel); the payload scope must agree with it, brand null is never a wildcard.
    if (normalizedScope.projectId !== authority.projectId || normalizedScope.brand !== authority.brand || normalizedScope.market !== authority.market) {
      return { status: 'blocked', code: 'scope_authority_mismatch', transportCalls: 0 };
    }
    const execution = await executeWithPolicy({ transport, request, limiter });
    if (execution.decision !== 'ok') {
      if (execution.decision === 'rate_limited') {
        return {
          status: 'blocked',
          code: execution.code,
          nextAllowedAt: execution.nextAllowedAtMs === null ? null : new Date(execution.nextAllowedAtMs).toISOString(),
          transportCalls: execution.transportCalls,
          attempts: execution.attempts
        };
      }
      const statusByDecision = {
        blocked: 'blocked',
        needs_permission: 'needs_permission',
        pending_reconcile: 'pending_reconcile',
        retry_exhausted: 'blocked',
        failed: 'failed'
      };
      return {
        status: statusByDecision[execution.decision] ?? 'failed',
        code: execution.code,
        transportCalls: execution.transportCalls,
        attempts: execution.attempts
      };
    }
    const response = execution.response;
    try {
      assertResponseSource(request, response, registration);
    } catch (error) {
      return { status: 'blocked', code: error.code, transportCalls: execution.transportCalls };
    }
    if (capability === 'fixture' && response.synthetic !== true) {
      return { status: 'blocked', code: 'execution_mode_contradiction', transportCalls: execution.transportCalls };
    }
    const page = adapter.parseSelectedVariantPdp(response.body, { fetchedAt: clock() });
    const observation = buildObservation({
      source: registration,
      scope: normalizedScope,
      authority,
      subject: { asin: request.meta.asin, variantLabel: request.meta.variantLabel },
      page,
      mode,
      capability,
      transportInfo: {
        synthetic: response.synthetic === true,
        observedAt: response.observedAt ?? null,
        sourceUrl: response.sourceUrl ?? request.url,
        fixtureLabel: response.fixtureLabel ?? ''
      },
      request,
      use: request.use
    });
    assertNoSyntheticPromotion(observation);
    return { status: 'succeeded', observation, transportCalls: execution.transportCalls, attempts: execution.attempts };
  }
  /**
   * Public entry: a caller-supplied authority object is NEVER a credential. With a factory
   * binding it must agree with the immutable factory authority (conflicts are refused before any
   * effect); without one, any plain authority object is refused (`authority_untrusted`) and a
   * missing authority fails closed (`authority_missing`) — no kind string can open a trusted path.
   */
  async function observe({ request, mode = 'manual_evidence', scope, authority = null }) {
    if (authorityConfig) {
      if (authority !== null && authority !== undefined) {
        let caller;
        try {
          caller = normalizeAuthority(authority);
        } catch (error) {
          return { status: 'blocked', code: error.code, transportCalls: 0 };
        }
        if (caller.projectId !== authorityConfig.projectId || caller.brand !== authorityConfig.brand || caller.market !== authorityConfig.market) {
          return { status: 'blocked', code: 'authority_override_forbidden', transportCalls: 0 };
        }
      }
      return executeObserve({ request, mode, scope, authority: authorityConfig });
    }
    if (authority !== null && authority !== undefined) {
      return { status: 'blocked', code: 'authority_untrusted', transportCalls: 0 };
    }
    return { status: 'blocked', code: 'authority_missing', transportCalls: 0 };
  }

  /**
   * Module-internal trusted channel (registered in INTERNAL_OBSERVE, unreachable from public
   * payloads): only the approved registry handler calls it with the runner-injected invoke.context
   * authority. With a factory binding the context must agree with it; without one the context
   * itself is the runner-injected authority fact.
   */
  async function observeTrusted(authority, { request, mode = 'manual_evidence', scope }) {
    let effective;
    try {
      effective = normalizeAuthority(authority);
    } catch (error) {
      return { status: 'blocked', code: error.code, transportCalls: 0 };
    }
    if (effective.kind !== 'orchestrator_context') {
      return { status: 'blocked', code: 'authority_untrusted', transportCalls: 0 };
    }
    if (authorityConfig) {
      if (effective.projectId !== authorityConfig.projectId || effective.brand !== authorityConfig.brand || effective.market !== authorityConfig.market) {
        return { status: 'blocked', code: 'authority_override_forbidden', transportCalls: 0 };
      }
      effective = { kind: 'orchestrator_context', projectId: authorityConfig.projectId, brand: authorityConfig.brand, market: authorityConfig.market };
    }
    return executeObserve({ request, mode, scope, authority: effective });
  }

  const connector = Object.freeze({ source: registration, adapter, transports, limiter, observe });
  INTERNAL_OBSERVE.set(connector, observeTrusted);
  return connector;
}

function createConnectorRegistration({ connector }) {
  if (!connector || typeof connector.observe !== 'function') throw connectorError('registration_invalid', 'connector with observe() is required');
  const tool = {
    name: CONNECTOR_TOOL_NAME,
    version: CONNECTOR_TOOL_VERSION,
    roles: [CONNECTOR_ROLE],
    kind: 'local',
    inputSchema: {
      type: 'object',
      required: ['sourceId', 'sourceVersion', 'use', 'asin', 'variantLabel', 'market', 'locale', 'shipTo', 'mode', 'scope'],
      additionalProperties: false,
      properties: {
        sourceId: { type: 'string', minLength: 1, maxLength: 80 },
        sourceVersion: { type: 'string', minLength: 1, maxLength: 40 },
        use: { type: 'string', enum: ['price_observation'] },
        asin: { type: 'string', pattern: '^[A-Z0-9]{10}$' },
        variantLabel: { type: 'string', minLength: 1, maxLength: 80 },
        market: { type: 'string', enum: ['US'] },
        locale: { type: 'string', enum: ['en-US'] },
        shipTo: { type: 'string', enum: ['US'] },
        mode: { type: 'string', enum: ['manual_evidence', 'permission_gated_api', 'permission_gated_browser'] },
        scope: {
          type: 'object',
          required: ['projectId', 'brand', 'market', 'locale', 'shipTo', 'windowMs'],
          additionalProperties: false,
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 120 },
            brand: { type: 'string', maxLength: 120 },
            market: { type: 'string', enum: ['US'] },
            locale: { type: 'string', enum: ['en-US'] },
            shipTo: { type: 'string', enum: ['US'] },
            windowMs: { type: 'integer', minimum: 1000, maximum: 86400000 }
          }
        }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['observation'],
      additionalProperties: false,
      properties: {
        observation: {
          type: 'object',
          required: ['schemaVersion', 'kind', 'sourceId', 'sourceVersion', 'use', 'mode', 'scope', 'scopeHash', 'cacheKey', 'authority', 'subject', 'status', 'reasons', 'price', 'priceCandidates', 'excludedPrices', 'title', 'availability', 'rating', 'rules', 'provenance'],
          additionalProperties: false,
          properties: {
            schemaVersion: { type: 'integer', const: 1 },
            kind: { type: 'string', enum: ['market_observation'] },
            sourceId: { type: 'string', minLength: 1 },
            sourceVersion: { type: 'string', minLength: 1 },
            use: { type: 'string', enum: ['price_observation'] },
            mode: { type: 'string', enum: ['manual_evidence', 'permission_gated_api', 'permission_gated_browser'] },
            scope: {
              type: 'object',
              required: ['projectId', 'brand', 'market', 'locale', 'shipTo', 'windowMs'],
              additionalProperties: false,
              properties: {
                projectId: { type: 'string', minLength: 1 },
                brand: { type: 'string' },
                market: { type: 'string', enum: ['US'] },
                locale: { type: 'string', enum: ['en-US'] },
                shipTo: { type: 'string', enum: ['US'] },
                windowMs: { type: 'integer', minimum: 1 }
              }
            },
            scopeHash: { type: 'string', minLength: 64, maxLength: 64 },
            cacheKey: { type: 'string', minLength: 64, maxLength: 64 },
            authority: {
              type: 'object',
              required: ['kind', 'projectId', 'brand', 'market'],
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['orchestrator_context', 'runner_config'] },
                projectId: { type: 'string', minLength: 1 },
                brand: { type: 'string' },
                market: { type: 'string', minLength: 1 }
              }
            },
            subject: {
              type: 'object',
              required: ['asin', 'variantLabel', 'selectedVariant'],
              additionalProperties: false,
              properties: {
                asin: { type: 'string', pattern: '^[A-Z0-9]{10}$' },
                variantLabel: { type: 'string', minLength: 1 },
                selectedVariant: { type: 'boolean' }
              }
            },
            status: { type: 'string', enum: ['observed', 'candidate', 'unknown'] },
            reasons: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1 } },
            price: {
              type: 'object',
              required: ['observed', 'amountText', 'amountMicros', 'currency', 'rawCurrencySymbol'],
              additionalProperties: false,
              properties: {
                observed: { type: 'boolean' },
                amountText: { type: 'string' },
                amountMicros: { type: 'integer', minimum: 0 },
                currency: { type: 'string' },
                rawCurrencySymbol: { type: 'string' }
              }
            },
            priceCandidates: { type: 'array', maxItems: 20, items: { type: 'string' } },
            excludedPrices: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['amountText', 'kind'],
                additionalProperties: false,
                properties: {
                  amountText: { type: 'string' },
                  kind: { type: 'string', enum: ['strike', 'list', 'monthly'] }
                }
              }
            },
            title: { type: 'string' },
            availability: { type: 'string', enum: ['in_stock', 'out_of_stock', 'unknown'] },
            rating: {
              type: 'object',
              required: ['observed', 'value', 'count', 'countKnown'],
              additionalProperties: false,
              properties: {
                observed: { type: 'boolean' },
                value: { type: 'number', minimum: 0, maximum: 5 },
                count: { type: 'integer', minimum: 0 },
                countKnown: { type: 'boolean' }
              }
            },
            rules: {
              type: 'object',
              required: ['searchIsNotPrice', 'ratingsAreNotSales', 'monthlyLabelsAreNotShare', 'missingReviewsDoNotBlockPrice', 'conflictingPricesNotReducedToLowest', 'selectedVariantBoundToPrimaryOffer'],
              additionalProperties: false,
              properties: {
                searchIsNotPrice: { type: 'boolean', const: true },
                ratingsAreNotSales: { type: 'boolean', const: true },
                monthlyLabelsAreNotShare: { type: 'boolean', const: true },
                missingReviewsDoNotBlockPrice: { type: 'boolean', const: true },
                conflictingPricesNotReducedToLowest: { type: 'boolean', const: true },
                selectedVariantBoundToPrimaryOffer: { type: 'boolean', const: true }
              }
            },
            provenance: {
              type: 'object',
              required: ['sourceUrl', 'observedAt', 'observedAtKnown', 'fetchedAt', 'mode', 'capability', 'synthetic', 'live', 'fixtureLabel'],
              additionalProperties: false,
              properties: {
                sourceUrl: { type: 'string', minLength: 1 },
                observedAt: { type: 'string' },
                observedAtKnown: { type: 'boolean' },
                fetchedAt: { type: 'string', minLength: 1 },
                mode: { type: 'string', enum: ['manual_evidence', 'permission_gated_api', 'permission_gated_browser'] },
                capability: { type: 'string', enum: ['fixture', 'manual', 'live'] },
                synthetic: { type: 'boolean' },
                live: { type: 'boolean' },
                fixtureLabel: { type: 'string' }
              }
            }
          }
        }
      }
    },
    costPolicy: { kind: 'mock_no_charge', currency: 'USD' }
  };
  async function handler({ input, context }) {
    const source = connector.source;
    if (input.sourceId !== source.sourceId || input.sourceVersion !== source.version) {
      return { status: 'blocked', reason: 'source_identity_mismatch' };
    }
    if (!source.allowedUses.includes(input.use)) {
      return { status: 'blocked', reason: `use_not_allowed:${input.use}` };
    }
    // runner authority: the immutable invoke context decides the project/brand/market domain
    const ctx = isPlainObject(context) ? context : {};
    const project = typeof ctx.project === 'string' && ctx.project !== '' ? ctx.project : null;
    const market = typeof ctx.market === 'string' && ctx.market !== '' ? ctx.market : null;
    const brand = ctx.brand === null || ctx.brand === undefined ? '' : ctx.brand;
    if (project === null || market === null || typeof brand !== 'string') {
      return { status: 'blocked', reason: 'authority_missing' };
    }
    const authority = { kind: 'orchestrator_context', projectId: project, brand, market };
    if (input.scope.projectId !== authority.projectId || input.scope.brand !== authority.brand || input.scope.market !== authority.market) {
      return { status: 'blocked', reason: 'scope_authority_mismatch' };
    }
    if (input.scope.locale !== input.locale || input.scope.shipTo !== input.shipTo || input.scope.market !== input.market) {
      return { status: 'blocked', reason: 'scope_payload_mismatch' };
    }
    // the local mock_no_charge handler must never execute live I/O: live needs the separate
    // external permit/operation/hold gates (T2.7) and is fail-closed in this build
    const modeTransport = connector.transports[input.mode];
    const capability = modeTransport ? (modeTransport.capability ?? (modeTransport.network ? 'live' : 'fixture')) : 'live';
    if (capability === 'live') {
      return { status: 'blocked', reason: 'live_requires_external_gate' };
    }
    let request;
    try {
      request = connector.adapter.buildSelectedVariantRequest({ asin: input.asin, variantLabel: input.variantLabel, market: input.market, locale: input.locale });
    } catch (error) {
      return { status: 'blocked', reason: error.code };
    }
    const internal = INTERNAL_OBSERVE.get(connector);
    if (typeof internal !== 'function') {
      return { status: 'failed', reason: 'connector_internal_channel_missing' };
    }
    const outcome = await internal(authority, { request, mode: input.mode, scope: input.scope });
    if (outcome.status === 'succeeded') return { status: 'succeeded', output: { observation: outcome.observation } };
    if (outcome.status === 'pending_reconcile') return { status: 'pending_reconcile', output: { code: outcome.code, transportCalls: outcome.transportCalls } };
    if (outcome.status === 'needs_permission') return { status: 'blocked', reason: `needs_permission:${outcome.code}` };
    if (outcome.status === 'blocked') return { status: 'blocked', reason: `source_blocked:${outcome.code}` };
    return { status: 'failed', reason: `connector_failed:${outcome.code}` };
  }
  return { tool, handler };
}

function registerConnectorHandler(registry, registration) {
  registry.register(registration.tool, registration.handler);
  return registry.get(registration.tool.name);
}

module.exports = {
  CONNECTOR_TOOL_NAME,
  CONNECTOR_TOOL_VERSION,
  CONNECTOR_ROLE,
  AUTHORITY_KINDS,
  VARIANT_ALIASES,
  OBSERVATION_RULES,
  MODES,
  normalizeAuthority,
  validateScope,
  cacheKeyFor,
  assertNoSyntheticPromotion,
  normalizeVariantValue,
  variantTokensMatch,
  buildObservation,
  createConnector,
  createConnectorRegistration,
  registerConnectorHandler,
  validateSourceRegistration,
  evaluatePermit,
  connectorError
};
