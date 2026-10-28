'use strict';
/**
 * T3.1 pluggable transports + bounded rate/backoff policy (revision-01).
 *
 * Every transport declares a capability: `fixture` (synthetic stub, never live), `manual`
 * (human evidence import, no network) or `live` (network path; default CLOSED — a fixture
 * grant never authorizes it). The permit's structured `execution` grants are checked by the
 * connector before any transport call.
 *
 * Rate policy: one limiter per connector (source/version execution domain) so the window
 * survives separate observe calls. The injected clock is the single time authority (a wait
 * that does not advance the clock fails closed). A Retry-After is a LOWER bound: delays above
 * the local cap defer with an explicit nextAllowedAt instead of retrying early. A timeout with
 * an unknown outcome is never resent.
 */
const { connectorError, evaluatePermit } = require('./source-register.js');
const { assertRequestTarget } = require('./url-policy.js');

const MODES = Object.freeze(['manual_evidence', 'permission_gated_api', 'permission_gated_browser']);
const CAPABILITIES = Object.freeze(['fixture', 'manual', 'live']);
const RETRYABLE_STATUSES = Object.freeze([429, 503]);

/** Synthetic fixture transport: capability `fixture`; every response is explicitly synthetic. */
function createSyntheticTransport({ routes, label = 'synthetic-fixture' }) {
  if (!Array.isArray(routes) || routes.length === 0) throw connectorError('transport_invalid', 'routes must be a non-empty array');
  const calls = [];
  async function fetch(request) {
    calls.push({ method: request.method, url: request.url, at: request.at ?? null });
    const route = routes.find((entry) => entry.match(request));
    if (!route) return { status: 404, headers: {}, body: '', synthetic: true, fixtureLabel: label };
    return {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      body: route.body ?? '',
      synthetic: true,
      fixtureLabel: label
    };
  }
  return Object.freeze({ mode: 'synthetic', capability: 'fixture', network: false, synthetic: true, live: false, label, calls, fetch });
}

/** Manual evidence import: capability `manual`; no network; keeps the bundle's observedAt lineage. */
function createManualEvidenceTransport({ bundles }) {
  if (!Array.isArray(bundles) || bundles.length === 0) throw connectorError('transport_invalid', 'bundles must be a non-empty array');
  const calls = [];
  async function fetch(request) {
    calls.push({ method: 'MANUAL', url: request.url, at: request.at ?? null });
    const bundle = bundles.find((entry) => entry.match(request));
    if (!bundle) {
      return { decision: 'response', mode: 'manual_evidence', response: { status: 404, headers: {}, body: '', synthetic: true, fixtureLabel: 'manual-bundle-missing' } };
    }
    return {
      decision: 'response',
      mode: 'manual_evidence',
      response: {
        status: 200,
        headers: {},
        body: bundle.body,
        synthetic: bundle.synthetic === true,
        fixtureLabel: bundle.label ?? 'manual-bundle',
        observedAt: bundle.observedAt ?? null,
        sourceUrl: bundle.sourceUrl ?? request.url
      }
    };
  }
  return Object.freeze({ mode: 'manual_evidence', capability: 'manual', network: false, calls, fetch });
}

/**
 * Permission-gated API transport. Capability defaults to `live` (network path, default closed);
 * an injected implementation that is a synthetic fixture must say `capability: 'fixture'`
 * explicitly. This PUBLIC entry enforces the structured execution grant itself (the connector
 * wrapper can be bypassed; this gate cannot), then the canonical URL target and the permit,
 * before the injected implementation runs — a denial never touches it.
 */
function createPermissionGatedApiTransport({ source, fetchImpl, capability = 'live', now = () => new Date().toISOString() }) {
  if (typeof fetchImpl !== 'function') throw connectorError('transport_invalid', 'fetchImpl must be a function');
  if (!['fixture', 'live'].includes(capability)) throw connectorError('transport_invalid', 'API transport capability must be fixture or live');
  const calls = [];
  async function fetch(request) {
    if (source.permit.execution[capability] !== true) {
      return {
        decision: 'blocked',
        code: capability === 'live' ? 'live_execution_not_authorized' : `execution_not_authorized_${capability}`,
        transportCalls: 0
      };
    }
    try {
      assertRequestTarget(request, source);
    } catch (error) {
      return { decision: 'blocked', code: error.code, transportCalls: 0 };
    }
    const decision = evaluatePermit(source, request, { at: now() });
    if (!decision.allowed) return { decision: 'blocked', code: decision.code, transportCalls: 0 };
    calls.push({ method: request.method, url: request.url, at: now() });
    const response = await fetchImpl(request);
    return { decision: 'response', mode: 'permission_gated_api', capability, response };
  }
  return Object.freeze({ mode: 'permission_gated_api', capability, network: capability === 'live', calls, fetch });
}

/** Permission-gated browser transport: capability `live`; live stays off unless enabled AND granted. */
function createPermissionGatedBrowserTransport({ source, renderImpl, liveEnabled = false, now = () => new Date().toISOString() }) {
  if (typeof renderImpl !== 'function') throw connectorError('transport_invalid', 'renderImpl must be a function');
  const calls = [];
  async function fetch(request) {
    if (liveEnabled !== true) return { decision: 'needs_permission', code: 'browser_live_not_authorized', transportCalls: 0 };
    if (source.permit.execution.live !== true) return { decision: 'blocked', code: 'live_execution_not_authorized', transportCalls: 0 };
    try {
      assertRequestTarget(request, source);
    } catch (error) {
      return { decision: 'blocked', code: error.code, transportCalls: 0 };
    }
    const decision = evaluatePermit(source, request, { at: now() });
    if (!decision.allowed) return { decision: 'blocked', code: decision.code, transportCalls: 0 };
    calls.push({ method: 'BROWSER', url: request.url, at: now() });
    const response = await renderImpl(request);
    return { decision: 'response', mode: 'permission_gated_browser', capability: 'live', response };
  }
  return Object.freeze({ mode: 'permission_gated_browser', capability: 'live', network: true, liveEnabled, calls, fetch });
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value, nowMs) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  return null;
}

/**
 * One limiter per connector (source/version execution domain): the window AND the source
 * cooldown survive separate observe calls. The injected clock is the single time authority;
 * the injected sleep must advance it, otherwise the wait fails closed (`clock_not_advancing`).
 * Without a usable sleep implementation a required wait fails closed (`rate_wait_unavailable`).
 * An over-cap Retry-After sets a persistent high-water cooldown that later observes/attempts
 * can never shorten.
 */
function createRateLimiter({ rateLimit, clock = () => Date.now(), sleep }) {
  const history = [];
  const sleeps = [];
  let cooldownUntilMs = null;
  const now = () => clock();
  async function wait(ms) {
    if (!(ms > 0)) return;
    if (typeof sleep !== 'function') {
      throw connectorError('rate_wait_unavailable', `a wait of ${ms}ms is required but no sleep implementation is available`, { waitMs: ms, nextAllowedAtMs: now() + ms });
    }
    sleeps.push(ms);
    const before = now();
    await sleep(ms);
    const after = now();
    if (after - before < ms) {
      throw connectorError('clock_not_advancing', 'the injected clock did not advance after sleep; a single advancing clock is required', { waitMs: ms, nextAllowedAtMs: before + ms });
    }
  }
  async function beforeRequest() {
    const at = now();
    if (cooldownUntilMs !== null && at < cooldownUntilMs) {
      throw connectorError('source_cooldown', `the source cooldown is active until ${new Date(cooldownUntilMs).toISOString()}`, { nextAllowedAtMs: cooldownUntilMs });
    }
    for (;;) {
      const current = now();
      const recent = history.filter((t) => t > current - rateLimit.windowMs);
      if (recent.length < rateLimit.requestsPerWindow) break;
      const oldest = Math.min(...recent);
      await wait(Math.max(1, oldest + rateLimit.windowMs - current));
    }
    history.push(now());
  }
  /**
   * Retry-After is a lower bound that must never be shortened: within the local cap it is waited
   * exactly; above the cap the call is deferred with a persistent cooldown (high-water — a later
   * observe or attempt can never pull the deadline earlier).
   */
  function retryDecision(attempt, response) {
    const retryAfterMs = parseRetryAfter(response && response.headers ? response.headers['retry-after'] : undefined, now());
    if (retryAfterMs !== null) {
      if (retryAfterMs > rateLimit.backoffCapMs) {
        const deadline = now() + retryAfterMs;
        cooldownUntilMs = cooldownUntilMs === null ? deadline : Math.max(cooldownUntilMs, deadline);
        return { kind: 'limited', retryAfterMs, nextAllowedAtMs: cooldownUntilMs };
      }
      return { kind: 'retry', delayMs: retryAfterMs };
    }
    const backoff = Math.min(rateLimit.backoffCapMs, rateLimit.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
    return { kind: 'retry', delayMs: backoff };
  }
  return Object.freeze({ rateLimit, history, sleeps, beforeRequest, retryDecision, wait, now, cooldown: () => cooldownUntilMs });
}

function isTimeoutUnknown(response) {
  return Boolean(response) && (response.status === 0 || response.timedOut === true || response.error === 'timeout_unknown');
}

/**
 * Bounded attempt loop. Window/retry waits that cannot be honored return `rate_limited` with a
 * nextAllowedAt; a timeout with an unknown outcome returns pending_reconcile and is NEVER resent.
 */
async function executeWithPolicy({ transport, request, limiter }) {
  const attempts = [];
  const maxAttempts = limiter.rateLimit.maxAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await limiter.beforeRequest();
    } catch (error) {
      return { decision: 'rate_limited', code: error.code, nextAllowedAtMs: error.detail ? error.detail.nextAllowedAtMs : null, response: null, attempts, transportCalls: transport.calls.length };
    }
    const result = await transport.fetch(request);
    if (!result || result.decision !== 'response') {
      return {
        decision: result ? result.decision : 'failed',
        code: result ? result.code : 'transport_result_invalid',
        response: null,
        attempts,
        transportCalls: transport.calls.length
      };
    }
    const response = result.response;
    if (isTimeoutUnknown(response)) {
      attempts.push({ attempt, status: 'timeout_unknown' });
      return { decision: 'pending_reconcile', code: 'timeout_unknown', response, attempts, transportCalls: transport.calls.length };
    }
    if (RETRYABLE_STATUSES.includes(response.status)) {
      attempts.push({ attempt, status: response.status });
      if (attempt >= maxAttempts) return { decision: 'retry_exhausted', code: 'attempts_exhausted', response, attempts, transportCalls: transport.calls.length };
      const retry = limiter.retryDecision(attempt, response);
      if (retry.kind === 'limited') {
        return {
          decision: 'rate_limited',
          code: 'retry_after_exceeds_cap',
          retryAfterMs: retry.retryAfterMs,
          nextAllowedAtMs: retry.nextAllowedAtMs,
          response,
          attempts,
          transportCalls: transport.calls.length
        };
      }
      try {
        await limiter.wait(retry.delayMs);
      } catch (error) {
        return { decision: 'rate_limited', code: error.code, nextAllowedAtMs: error.detail ? error.detail.nextAllowedAtMs : null, response, attempts, transportCalls: transport.calls.length };
      }
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      attempts.push({ attempt, status: response.status });
      return { decision: 'ok', response, attempts, transportCalls: transport.calls.length };
    }
    attempts.push({ attempt, status: response.status });
    return { decision: 'failed', code: `http_${response.status}`, response, attempts, transportCalls: transport.calls.length };
  }
  return { decision: 'retry_exhausted', code: 'attempts_exhausted', response: null, attempts, transportCalls: transport.calls.length };
}

module.exports = {
  MODES,
  CAPABILITIES,
  RETRYABLE_STATUSES,
  createSyntheticTransport,
  createManualEvidenceTransport,
  createPermissionGatedApiTransport,
  createPermissionGatedBrowserTransport,
  parseRetryAfter,
  createRateLimiter,
  isTimeoutUnknown,
  executeWithPolicy
};
