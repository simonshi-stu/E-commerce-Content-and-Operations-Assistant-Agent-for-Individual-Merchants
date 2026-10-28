'use strict';
/**
 * T3.1 connector framework tests (revision-01): real-layout synthetic PDP fixtures, integrated
 * execution gates (URL target / structured grants / runner authority), persistent rate window
 * and Retry-After lower bound, evidence fidelity and scope/cache binding. All fixtures are
 * synthetic; no real outbound calls; writes only to $COMMERCE_TEST_TMP.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.resolve(__dirname, '..', '..');
const { openDb, migrateUp } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const migrations = [
  require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0002_passport_sku.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0003_evidence_observation.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0004_run_store.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0005_run_store_lease_token.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0006_idempotency.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0007_idempotency_contract.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0008_idempotency_attempt_remote.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0009_budget.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0010_budget_request_identity.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0011_imports.js'))
];
const store = require(path.join(W, 'lib', 'commerce', 'run-store.js'));
const orch = require(path.join(W, 'lib', 'commerce', 'orchestrator.js'));
const { createToolRegistry } = require(path.join(W, 'lib', 'commerce', 'tools-registry.js'));
const packs = require(path.join(W, 'lib', 'commerce', 'packs.js'));
const connectors = require(path.join(W, 'lib', 'commerce', 'connectors', 'index.js'));
const {
  createSyntheticTransport,
  createManualEvidenceTransport,
  createPermissionGatedApiTransport,
  createPermissionGatedBrowserTransport
} = require(path.join(W, 'lib', 'commerce', 'connectors', 'transport.js'));
const { parseAndCheckUrl, assertRedirectAllowed, assertRequestTarget } = require(path.join(W, 'lib', 'commerce', 'connectors', 'url-policy.js'));
const {
  buildSelectedVariantRequest,
  buildSearchRequest,
  parseSearchCandidates
} = require(path.join(W, 'lib', 'commerce', 'connectors', 'amazon-us-pdp.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T3.1 tests write only to the private runtime tmp';
const RUN_DIR = TMP_ROOT ? fs.mkdtempSync(path.join(TMP_ROOT, 't31-run-')) : null;
const NOW = '2026-10-13T14:00:00.000Z';
const OBSERVED_AT = '2026-10-13T10:00:00Z';
const ASIN = 'B0SYNTH001';
const SOURCE_VERSION = '2026-10-13.design-1';
const PROJECT = 'proj-t31-a';
const BRAND = 'SYNTHETIC-BRAND';
const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Real-layout synthetic fixtures: hidden ASIN input + variation selections + primary buybox price
// container; the similarities carousel price must never be mixed into the main price.
const PDP_FIXTURE = `<html><head><meta name="x-fixture" content="synthetic"><meta name="x-observed-at" content="${OBSERVED_AT}"></head><body>
<input type="hidden" id="ASIN" name="ASIN" value="${ASIN}">
<span id="productTitle">SYNTHETIC WIDGET - Blue, 12cm</span>
<div id="variation_color_name"><span class="selection">Blue</span></div>
<div id="variation_size_name"><span class="selection">12cm</span></div>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$39.99</span></span></div>
<div id="similarities_feature_div"><span class="a-offscreen">$12.99</span></div>
<div id="availability"><span>In Stock</span></div>
<span class="a-icon-alt">4.3 out of 5 stars</span>
<span id="acrCustomerReviewText">1,234 ratings</span>
</body></html>`;
const PDP_CONFLICT_FIXTURE = PDP_FIXTURE.replace(
  '<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$39.99</span></span></div>',
  '<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$39.99</span></span><span class="a-price"><span class="a-offscreen">$42.50</span></span></div>'
);
const PDP_WRONG_ASIN_FIXTURE = PDP_FIXTURE
  .replace(`value="${ASIN}"`, 'value="B0SYNTH002"')
  .replace('<span class="selection">Blue</span>', '<span class="selection">Red</span>');
const PDP_NO_VARIATION_FIXTURE = PDP_FIXTURE
  .replace('<div id="variation_color_name"><span class="selection">Blue</span></div>', '')
  .replace('<div id="variation_size_name"><span class="selection">12cm</span></div>', '');
const PDP_UNKNOWN_CURRENCY_FIXTURE = PDP_FIXTURE.replace('$39.99', '₩ 52,000');
const PDP_NO_RATING_FIXTURE = PDP_FIXTURE
  .replace('<span class="a-icon-alt">4.3 out of 5 stars</span>', '')
  .replace('<span id="acrCustomerReviewText">1,234 ratings</span>', '');
const PDP_NO_OBSERVED_FIXTURE = PDP_FIXTURE.replace(`<meta name="x-observed-at" content="${OBSERVED_AT}">`, '');
const SEARCH_FIXTURE = `<!doctype html><html><body>
<div data-component-type="s-search-result" data-asin="B0SYNTH002"><h2>SYNTHETIC WIDGET BLUE</h2></div>
<div data-component-type="s-search-result" data-asin="B0SYNTH003"><h2>SYNTHETIC WIDGET RED</h2></div>
</body></html>`;

function basePermit(overrides = {}) {
  return {
    approvalStatus: 'approved',
    approvalBasis: 'synthetic fixture grant (never upgrades to live)',
    approvalObservedAt: '2026-10-13T00:00:00.000Z',
    expiresAt: null,
    robots: { status: 'reviewed_allowed', basis: 'synthetic fixture review', observedAt: '2026-10-13T00:00:00.000Z' },
    tos: { status: 'reviewed_allowed', basis: 'synthetic fixture review', observedAt: '2026-10-13T00:00:00.000Z' },
    rateLimit: { requestsPerWindow: 5, windowMs: 60000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 },
    ...overrides
  };
}
function baseSource(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: 'amazon-us-pdp',
    version: SOURCE_VERSION,
    host: 'www.amazon.com',
    allowedPaths: ['/dp', '/s'],
    allowedMethods: ['GET'],
    allowedUses: ['price_observation', 'search_candidates'],
    permit: basePermit(),
    note: 'Amazon US selected-variant PDP (designed; live disabled until I-003)',
    ...overrides
  };
}
function scope(overrides = {}) {
  return { projectId: PROJECT, brand: BRAND, market: 'US', locale: 'en-US', shipTo: 'US', windowMs: 86400000, ...overrides };
}
function handlerInput(overrides = {}) {
  return {
    sourceId: 'amazon-us-pdp',
    sourceVersion: SOURCE_VERSION,
    use: 'price_observation',
    asin: ASIN,
    variantLabel: 'Blue, 12cm',
    market: 'US',
    locale: 'en-US',
    shipTo: 'US',
    mode: 'permission_gated_api',
    scope: scope(),
    ...overrides
  };
}
function openEnv(name) {
  const dir = fs.mkdtempSync(path.join(RUN_DIR, `${name}-`));
  const db = openDb(path.join(dir, 'connectors.db'));
  migrateUp(db, migrations);
  return { dir, db, workerDir: path.join(dir, 'workdir') };
}
function makeConnector({ source, routes, bundles, apiCapability = 'fixture', browserLive = false, clock = () => NOW, sleep, runnerAuthority = null }) {
  const synthetic = createSyntheticTransport({ routes });
  const api = createPermissionGatedApiTransport({ source, fetchImpl: synthetic.fetch, capability: apiCapability, now: clock });
  const manual = createManualEvidenceTransport({ bundles: bundles ?? routes.map((route) => ({ match: route.match, body: route.body, synthetic: true, observedAt: OBSERVED_AT, label: 'synthetic-manual' })) });
  const browser = createPermissionGatedBrowserTransport({
    source,
    renderImpl: async () => { throw new Error('browser render must not run in fixture tests'); },
    liveEnabled: browserLive,
    now: clock
  });
  const connector = connectors.createConnector({
    source,
    transports: { manual_evidence: manual, permission_gated_api: api, permission_gated_browser: browser },
    clock,
    sleep,
    runnerAuthority
  });
  return { connector, synthetic, api, manual, browser };
}
const routeFor = (asin, body) => ({ match: (request) => request.path === `/dp/${asin}`, status: 200, body });
const variantRequest = (overrides = {}) => buildSelectedVariantRequest({ asin: ASIN, variantLabel: 'Blue, 12cm', ...overrides });
async function runOnce(env, connector, { projectId = PROJECT, brand = BRAND, input = handlerInput(), market = 'US' } = {}) {
  const registry = createToolRegistry({ roles: orch.ROLES });
  connectors.registerConnectorHandler(registry, connectors.createConnectorRegistration({ connector }));
  const report = await orch.runOrchestratorOnce(env.db, {
    projectId, brand, market, owner: 't31-test', ttlSeconds: 120, now: NOW, clock: () => NOW, registry, workerDir: env.workerDir, inputVersion: 'ui-v1',
    plan: {
      schemaVersion: 1,
      taskType: 'market-observation.v1',
      steps: [{ id: 'observe', role: 'research-selection', tool: connectors.CONNECTOR_TOOL_NAME, input, quality: { requireFields: ['observation'] } }]
    }
  });
  return { report, callStats: registry.callStats() };
}

test('T3.1 flow: real-layout synthetic PDP → fixture-capability API → registered handler → orchestrator artifact + SQL reopen', { skip }, async () => {
  const env = openEnv('flow');
  let closed = false;
  try {
    const source = connectors.validateSourceRegistration(baseSource());
    const { connector, synthetic } = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)], runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const registration = connectors.createConnectorRegistration({ connector });
    assert.deepEqual(registration.tool.roles, ['research-selection']);
    assert.equal(registration.tool.costPolicy.kind, 'mock_no_charge');
    // role allowlist is enforced by the approved plan validation before any effect
    await assert.rejects(
      orch.runOrchestratorOnce(env.db, {
        projectId: PROJECT, brand: BRAND, market: 'US', owner: 't31-test', ttlSeconds: 120, now: NOW, clock: () => NOW,
        registry: (() => { const r = createToolRegistry({ roles: orch.ROLES }); connectors.registerConnectorHandler(r, registration); return r; })(),
        workerDir: env.workerDir, inputVersion: 'ui-v1',
        plan: { schemaVersion: 1, taskType: 'market-observation.v1', steps: [{ id: 'observe', role: 'creative', tool: connectors.CONNECTOR_TOOL_NAME, input: handlerInput(), quality: { requireFields: ['observation'] } }] }
      }),
      /role allowlist|not allowed to use tool/
    );
    const { report, callStats } = await runOnce(env, connector);
    assert.equal(report.status, 'succeeded');
    const record = report.run.checkpoint.orchestrator.artifacts.observe;
    const artifactFile = path.join(env.workerDir, ...record.ref.split('/'));
    const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
    assert.equal(sha256Hex(packs.canonicalJson(artifact.output)), record.sha);
    assert.equal(artifact.outputSha256, record.sha);
    const observation = artifact.output.observation;
    assert.equal(observation.status, 'observed');
    assert.equal(observation.price.observed, true);
    assert.equal(observation.price.amountMicros, 39990000);
    assert.equal(observation.price.currency, 'USD');
    assert.deepEqual(observation.priceCandidates, ['$39.99'], 'the similarities carousel price never enters the primary price');
    assert.equal(observation.subject.selectedVariant, true);
    assert.equal(observation.authority.kind, 'orchestrator_context');
    assert.equal(observation.authority.projectId, PROJECT);
    assert.equal(observation.authority.brand, BRAND);
    assert.equal(observation.provenance.capability, 'fixture');
    assert.equal(observation.provenance.synthetic, true);
    assert.equal(observation.provenance.live, false);
    assert.equal(observation.provenance.observedAt, OBSERVED_AT);
    assert.equal(observation.provenance.fetchedAt, NOW);
    assert.equal(observation.rating.value, 4.3);
    assert.equal(callStats[connectors.CONNECTOR_TOOL_NAME], 1);
    const journal = orch.readJournal(env.workerDir, report.run.id);
    assert.ok(journal.some((entry) => entry.event === 'step_completed' && entry.stepId === 'observe' && entry.outputSha256 === record.sha));
    env.db.close();
    closed = true;
    const reopened = openDb(path.join(env.dir, 'connectors.db'));
    try {
      assert.equal(store.getRun(reopened, PROJECT, report.run.id).status, 'succeeded');
      assert.equal(store.getRun(reopened, PROJECT, report.run.id).checkpoint.orchestrator.artifacts.observe.sha, record.sha);
    } finally {
      reopened.close();
    }
    // the approved registry handler works through the module-internal context channel even
    // without a factory binding (the runner-injected invoke.context is the authority fact)
    const noFactoryFlow = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)] });
    const noFactoryEnv = openEnv('flow-nofactory');
    let nfClosed = false;
    try {
      const { report: nfReport } = await runOnce(noFactoryEnv, noFactoryFlow.connector);
      assert.equal(nfReport.status, 'succeeded');
      const nfRecord = nfReport.run.checkpoint.orchestrator.artifacts.observe;
      const nfArtifactFile = path.join(noFactoryEnv.workerDir, ...nfRecord.ref.split('/'));
      const nfArtifact = JSON.parse(fs.readFileSync(nfArtifactFile, 'utf8'));
      assert.equal(sha256Hex(packs.canonicalJson(nfArtifact.output)), nfRecord.sha);
      assert.equal(nfArtifact.output.observation.authority.kind, 'orchestrator_context');
      assert.equal(nfArtifact.output.observation.authority.projectId, PROJECT);
      noFactoryEnv.db.close();
      nfClosed = true;
      const nfReopened = openDb(path.join(noFactoryEnv.dir, 'connectors.db'));
      try {
        assert.equal(store.getRun(nfReopened, PROJECT, nfReport.run.id).checkpoint.orchestrator.artifacts.observe.sha, nfRecord.sha);
      } finally {
        nfReopened.close();
      }
    } finally {
      if (!nfClosed) noFactoryEnv.db.close();
    }
    // a live-capability transport can never execute through this local handler
    const live = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)], apiCapability: 'live', runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const liveEnv = openEnv('flow-live');
    try {
      const liveRun = await runOnce(liveEnv, live.connector);
      assert.notEqual(liveRun.report.status, 'succeeded');
      assert.equal(live.synthetic.calls.length, 0, 'live capability via the local handler is refused before any call');
    } finally {
      liveEnv.db.close();
    }
    // manual evidence mode stays executable and keeps its own observation lineage
    const manualOutcome = await connector.observe({ request: variantRequest(), mode: 'manual_evidence', scope: scope() });
    assert.equal(manualOutcome.status, 'succeeded');
    assert.equal(manualOutcome.observation.provenance.mode, 'manual_evidence');
    assert.equal(manualOutcome.observation.provenance.capability, 'manual');
    assert.equal(manualOutcome.observation.provenance.observedAt, OBSERVED_AT);
    assert.equal(manualOutcome.observation.price.amountMicros, 39990000);
    assert.equal(synthetic.calls.length >= 1, true);
  } finally {
    if (!closed) env.db.close();
  }
});

test('T3.1 permissions: structured grants, live default closed, contradictions and permit negatives fail closed', { skip }, async () => {
  const env = openEnv('perm');
  try {
    // structured execution grants default to fixture+manual only; live is closed
    const normalized = connectors.validateSourceRegistration(baseSource());
    assert.deepEqual(normalized.permit.execution, { fixture: true, manual: true, live: false });
    const explicit = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ execution: { live: false } }) }));
    assert.equal(explicit.permit.execution.live, false);
    // missing required permit fields are rejected at registration
    const missingTos = baseSource();
    delete missingTos.permit.tos;
    assert.throws(() => connectors.validateSourceRegistration(missingTos), (error) => error.code === 'registration_invalid');
    const missingApproval = baseSource();
    delete missingApproval.permit.approvalStatus;
    assert.throws(() => connectors.validateSourceRegistration(missingApproval), (error) => error.code === 'registration_invalid');
    // permit evaluation codes
    const request = variantRequest();
    const at = NOW;
    const codeOf = (source) => connectors.evaluatePermit(connectors.validateSourceRegistration(source), request, { at }).code;
    assert.equal(codeOf(baseSource({ permit: basePermit({ approvalStatus: 'unknown' }) })), 'permit_unknown');
    assert.equal(codeOf(baseSource({ permit: basePermit({ approvalStatus: 'pending' }) })), 'permit_pending');
    assert.equal(codeOf(baseSource({ permit: basePermit({ approvalStatus: 'denied' }) })), 'permit_denied');
    assert.equal(codeOf(baseSource({ permit: basePermit({ approvalStatus: 'expired' }) })), 'permit_expired');
    assert.equal(codeOf(baseSource({ permit: basePermit({ expiresAt: '2026-10-12T00:00:00.000Z' }) })), 'permit_expired');
    assert.equal(codeOf(baseSource({ permit: basePermit({ robots: { status: 'unknown', basis: 'x', observedAt: NOW } }) })), 'robots_unknown');
    assert.equal(codeOf(baseSource({ permit: basePermit({ tos: { status: 'unknown', basis: 'x', observedAt: NOW } }) })), 'tos_unknown');
    const approved = connectors.validateSourceRegistration(baseSource());
    assert.equal(connectors.evaluatePermit(approved, { ...request, use: 'rating_observation' }, { at }).code, 'use_not_allowed');
    assert.equal(connectors.evaluatePermit(approved, { ...request, method: 'POST' }, { at }).code, 'method_not_allowed');
    assert.equal(connectors.evaluatePermit(approved, { ...request, host: 'www.example.com' }, { at }).code, 'host_not_allowed');
    assert.equal(connectors.evaluatePermit(approved, { ...request, path: '/gp/other' }, { at }).code, 'path_not_allowed');
    // a fixture-only grant never authorizes a live-capability transport
    const live = makeConnector({ source: approved, routes: [routeFor(ASIN, PDP_FIXTURE)], apiCapability: 'live', runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const liveOutcome = await live.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(liveOutcome.status, 'needs_permission');
    assert.equal(liveOutcome.code, 'live_execution_not_authorized');
    assert.equal(liveOutcome.transportCalls, 0);
    assert.equal(live.synthetic.calls.length, 0, 'a fixture grant never reaches a live-capability transport');
    // denied requests never reach the underlying fixture transport
    const pendingSource = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ approvalStatus: 'pending' }) }));
    const pending = makeConnector({ source: pendingSource, routes: [routeFor(ASIN, PDP_FIXTURE)], runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const denied = await pending.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(denied.status, 'blocked');
    assert.equal(denied.code, 'permit_pending');
    assert.equal(pending.synthetic.calls.length, 0);
    // browser live stays off until explicitly permitted
    const ok = makeConnector({ source: approved, routes: [routeFor(ASIN, PDP_FIXTURE)], runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const browserOutcome = await ok.connector.observe({ request, mode: 'permission_gated_browser', scope: scope() });
    assert.equal(browserOutcome.status, 'needs_permission');
    assert.equal(browserOutcome.code, 'live_execution_not_authorized', 'the structured grant gate refuses live-capability transports before the transport switch');
    assert.equal(ok.browser.calls.length, 0);
    // even with an explicit live grant, the browser transport keeps its own live switch closed
    const liveGranted = makeConnector({
      source: connectors.validateSourceRegistration(baseSource({ permit: basePermit({ execution: { live: true } }) })),
      routes: [routeFor(ASIN, PDP_FIXTURE)],
      browserLive: false,
      runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' }
    });
    const browserStillClosed = await liveGranted.connector.observe({ request, mode: 'permission_gated_browser', scope: scope() });
    assert.equal(browserStillClosed.status, 'needs_permission');
    assert.equal(browserStillClosed.code, 'browser_live_not_authorized');
    assert.equal(liveGranted.browser.calls.length, 0);
    // a fixture execution that claims a non-synthetic result is a contradiction and is refused
    const contradictoryApi = createPermissionGatedApiTransport({
      source: approved, capability: 'fixture', now: () => NOW,
      fetchImpl: async () => ({ status: 200, headers: {}, body: PDP_FIXTURE.replace('<meta name="x-fixture" content="synthetic">', ''), synthetic: false })
    });
    const contradictory = connectors.createConnector({
      source: approved,
      transports: { permission_gated_api: contradictoryApi },
      clock: () => NOW,
      runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' }
    });
    const contradictionOutcome = await contradictory.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(contradictionOutcome.status, 'blocked');
    assert.equal(contradictionOutcome.code, 'execution_mode_contradiction');
    assert.notEqual(contradictionOutcome.observation?.provenance?.live, true);
    // R1: the public transport entry enforces the structured grant itself (connector bypass)
    const directLive = createPermissionGatedApiTransport({
      source: approved, capability: 'live', now: () => NOW,
      fetchImpl: async () => ({ status: 200, headers: {}, body: PDP_FIXTURE, synthetic: false })
    });
    const directLiveOut = await directLive.fetch(request);
    assert.notEqual(directLiveOut.decision, 'response', 'the transport entry itself ignores permit.execution.live=false');
    assert.equal(directLiveOut.code, 'live_execution_not_authorized');
    assert.equal(directLive.calls.length, 0);
    const directBrowser = createPermissionGatedBrowserTransport({
      source: approved, liveEnabled: true, now: () => NOW,
      renderImpl: async () => ({ status: 200, headers: {}, body: PDP_FIXTURE, synthetic: false })
    });
    const directBrowserOut = await directBrowser.fetch(request);
    assert.notEqual(directBrowserOut.decision, 'response');
    assert.equal(directBrowserOut.code, 'live_execution_not_authorized');
    assert.equal(directBrowser.calls.length, 0);
    const directFixture = createPermissionGatedApiTransport({
      source: approved, capability: 'fixture', now: () => NOW,
      fetchImpl: async () => ({ status: 200, headers: {}, body: PDP_FIXTURE, synthetic: true })
    });
    const directFixtureOut = await directFixture.fetch(request);
    assert.equal(directFixtureOut.decision, 'response', 'a fixture grant still authorizes the fixture-capability entry');
    assert.equal(directFixture.calls.length, 1);
    // approved source: the fixture path succeeds through the same guard
    const okOutcome = await ok.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(okOutcome.status, 'succeeded');
    assert.equal(ok.connector.source.permit.execution.live, false);
  } finally {
    env.db.close();
  }
});

test('T3.1 url policy: spoofed canonical targets are refused before the transport', { skip }, async () => {
  const env = openEnv('url');
  try {
    const source = connectors.validateSourceRegistration(baseSource());
    const code = (fn) => {
      try { fn(); return 'no_error'; } catch (error) { return error.code; }
    };
    assert.equal(code(() => parseAndCheckUrl('https://user:pass@www.amazon.com/dp/B0SYNTH001', source)), 'url_credentials_not_allowed');
    assert.equal(code(() => parseAndCheckUrl('ftp://www.amazon.com/dp/B0SYNTH001', source)), 'url_protocol_not_allowed');
    assert.equal(code(() => parseAndCheckUrl('javascript:alert(1)', source)), 'url_protocol_not_allowed');
    assert.equal(code(() => parseAndCheckUrl('https://www.amazon.com:8443/dp/B0SYNTH001', source)), 'url_port_not_allowed');
    for (const host of ['localhost', '127.0.0.1', '10.0.0.7', '192.168.1.10', '172.20.5.5', '169.254.1.1', '[::1]', 'printer.local']) {
      assert.equal(code(() => parseAndCheckUrl(`http://${host}/dp/B0SYNTH001`, source)), 'url_host_denied_private', `${host} must be denied as private/local`);
    }
    assert.equal(code(() => parseAndCheckUrl('https://www.example.com/dp/B0SYNTH001', source)), 'url_host_not_allowed');
    assert.equal(code(() => parseAndCheckUrl('https://www.amazon.com/gp/product/B0SYNTH001', source)), 'url_path_not_allowed');
    assert.equal(code(() => assertRedirectAllowed('https://www.amazon.com/dp/B0SYNTH001', 'https://www.example.com/dp/B0SYNTH001', source)), 'redirect_cross_host');
    assert.equal(code(() => assertRedirectAllowed('https://www.amazon.com/dp/B0SYNTH001', 'http://www.amazon.com/dp/B0SYNTH001', source)), 'redirect_protocol_not_allowed');
    assert.equal(code(() => assertRedirectAllowed('https://www.amazon.com/dp/B0SYNTH001', 'https://www.amazon.com/gp/other', source)), 'url_path_not_allowed');
    // canonical target consistency
    const request = variantRequest();
    assert.equal(code(() => assertRequestTarget({ ...request, url: 'http://127.0.0.1/private?fixture-only=true' }, source)), 'url_host_denied_private');
    assert.equal(code(() => assertRequestTarget({ ...request, host: 'www.example.com' }, source)), 'request_target_mismatch');
    assert.equal(code(() => assertRequestTarget({ ...request, path: '/gp/other' }, source)), 'request_target_mismatch');
    assert.equal(code(() => assertRequestTarget({ ...request, meta: { ...request.meta, asin: 'B0SYNTH002' } }, source)), 'request_meta_mismatch');
    assert.equal(code(() => assertRequestTarget({ ...request, url: '' }, source)), 'url_missing');
    assert.equal(assertRequestTarget(request, source).path, '/dp/B0SYNTH001');
    // integrated: a spoofed URL never reaches the underlying fixture stub
    const fixture = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)] });
    const spoof = { ...variantRequest(), url: 'http://127.0.0.1/private?fixture-only=true' };
    const out = await fixture.connector.observe({ request: spoof, mode: 'permission_gated_api', scope: scope() });
    assert.notEqual(out.status, 'succeeded');
    assert.equal(fixture.synthetic.calls.length, 0, 'the spoofed canonical URL is rejected before the transport');
    // response-declared target changes cannot produce a normal observation
    const redirectedApi = createPermissionGatedApiTransport({
      source, capability: 'fixture', now: () => NOW,
      fetchImpl: async () => ({ status: 200, headers: {}, body: PDP_FIXTURE, synthetic: true, finalUrl: 'https://www.example.com/dp/B0SYNTH001' })
    });
    const redirected = connectors.createConnector({ source, transports: { permission_gated_api: redirectedApi }, clock: () => NOW, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const redirectedOut = await redirected.observe({ request: variantRequest(), mode: 'permission_gated_api', scope: scope() });
    assert.equal(redirectedOut.status, 'blocked');
    assert.equal(redirectedOut.code, 'redirect_cross_host');
    const search = buildSearchRequest({ query: 'synthetic widget' });
    assert.equal(search.path, '/s');
    assert.equal(search.use, 'search_candidates');
  } finally {
    env.db.close();
  }
});

test('T3.1 rate/backoff: persistent window, Retry-After lower bound, timeout_unknown never resent', { skip }, async () => {
  const env = openEnv('rate');
  try {
    const request = variantRequest();
    // (a) the window survives separate observe calls: 1 request / 1000ms
    let nowA = Date.parse(NOW);
    const sleepsA = [];
    const sourceA = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ rateLimit: { requestsPerWindow: 1, windowMs: 1000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 } }) }));
    const a = makeConnector({ source: sourceA, routes: [routeFor(ASIN, PDP_FIXTURE)], clock: () => new Date(nowA).toISOString(), sleep: async (ms) => { sleepsA.push(ms); nowA += ms; }, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const first = await a.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    const second = await a.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'succeeded');
    assert.equal(a.api.calls.length, 2);
    assert.ok(Date.parse(a.api.calls[1].at) - Date.parse(a.api.calls[0].at) >= 1000, 'the second call waits out the persistent source window');
    assert.ok(sleepsA.includes(1000));
    // (b) Retry-After above the local cap defers instead of retrying early
    let nowB = Date.parse(NOW);
    const callsB = [];
    const sourceB = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ rateLimit: { requestsPerWindow: 10, windowMs: 1000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 } }) }));
    const apiB = createPermissionGatedApiTransport({
      source: sourceB, capability: 'fixture', now: () => new Date(nowB).toISOString(),
      fetchImpl: async () => { callsB.push(nowB); return { status: 429, headers: { 'retry-after': '5' }, synthetic: true, body: '' }; }
    });
    const connectorB = connectors.createConnector({ source: sourceB, transports: { permission_gated_api: apiB }, clock: () => new Date(nowB).toISOString(), sleep: async (ms) => { nowB += ms; }, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const limited = await connectorB.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(limited.status, 'blocked');
    assert.equal(limited.code, 'retry_after_exceeds_cap');
    assert.equal(callsB.length, 1, 'a 5s Retry-After over a 0.5s cap must not retry early');
    assert.equal(Date.parse(limited.nextAllowedAt), callsB[0] + 5000);
    // (c) within-cap Retry-After is waited exactly, then retried (finite)
    let nowC = Date.parse(NOW);
    const sleepsC = [];
    let callC = 0;
    const sourceC = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ rateLimit: { requestsPerWindow: 10, windowMs: 1000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 5000 } }) }));
    const apiC = createPermissionGatedApiTransport({
      source: sourceC, capability: 'fixture', now: () => new Date(nowC).toISOString(),
      fetchImpl: async () => {
        callC += 1;
        return callC === 1 ? { status: 429, headers: { 'retry-after': '1' }, synthetic: true, body: '' } : { status: 200, headers: {}, body: PDP_FIXTURE, synthetic: true };
      }
    });
    const connectorC = connectors.createConnector({ source: sourceC, transports: { permission_gated_api: apiC }, clock: () => new Date(nowC).toISOString(), sleep: async (ms) => { sleepsC.push(ms); nowC += ms; }, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const retried = await connectorC.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(retried.status, 'succeeded');
    assert.equal(callC, 2);
    assert.ok(sleepsC.includes(1000), 'the within-cap Retry-After is waited exactly');
    // (d) timeout with an unknown outcome is never resent
    let nowD = Date.parse(NOW);
    let callD = 0;
    const sourceD = connectors.validateSourceRegistration(baseSource());
    const apiD = createPermissionGatedApiTransport({
      source: sourceD, capability: 'fixture', now: () => new Date(nowD).toISOString(),
      fetchImpl: async () => { callD += 1; return { status: 0, error: 'timeout_unknown', synthetic: true }; }
    });
    const connectorD = connectors.createConnector({ source: sourceD, transports: { permission_gated_api: apiD }, clock: () => new Date(nowD).toISOString(), sleep: async (ms) => { nowD += ms; }, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const timeout = await connectorD.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(timeout.status, 'pending_reconcile');
    assert.equal(callD, 1);
    // (e) without a usable wait the required wait fails closed instead of pretending
    const sourceE = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ rateLimit: { requestsPerWindow: 1, windowMs: 1000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 } }) }));
    const e = makeConnector({ source: sourceE, routes: [routeFor(ASIN, PDP_FIXTURE)], clock: () => NOW, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    assert.equal((await e.connector.observe({ request, mode: 'permission_gated_api', scope: scope() })).status, 'succeeded');
    const noWait = await e.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(noWait.status, 'blocked');
    assert.equal(noWait.code, 'rate_wait_unavailable');
    assert.equal(e.api.calls.length, 1);
    // (f) a sleep that does not advance the clock fails closed (single time authority)
    let staticNow = Date.parse(NOW);
    const sourceF = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ rateLimit: { requestsPerWindow: 1, windowMs: 1000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 } }) }));
    const f = makeConnector({ source: sourceF, routes: [routeFor(ASIN, PDP_FIXTURE)], clock: () => new Date(staticNow).toISOString(), sleep: async () => {}, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    assert.equal((await f.connector.observe({ request, mode: 'permission_gated_api', scope: scope() })).status, 'succeeded');
    const notAdvancing = await f.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(notAdvancing.status, 'blocked');
    assert.equal(notAdvancing.code, 'clock_not_advancing');
    // (g) an over-cap defer sets a persistent cooldown that later observes cannot forget
    let nowG = Date.parse(NOW);
    const callsG = [];
    const sourceG = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ rateLimit: { requestsPerWindow: 60, windowMs: 60000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 } }) }));
    const apiG = createPermissionGatedApiTransport({
      source: sourceG, capability: 'fixture', now: () => new Date(nowG).toISOString(),
      fetchImpl: async () => {
        callsG.push(nowG);
        return callsG.length === 1 ? { status: 429, headers: { 'retry-after': '5' }, synthetic: true, body: '' } : { status: 200, headers: {}, body: PDP_FIXTURE, synthetic: true };
      }
    });
    const connectorG = connectors.createConnector({ source: sourceG, transports: { permission_gated_api: apiG }, clock: () => new Date(nowG).toISOString(), sleep: async (ms) => { nowG += ms; }, runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const deferred = await connectorG.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(deferred.status, 'blocked');
    assert.equal(deferred.code, 'retry_after_exceeds_cap');
    const deadline = Date.parse(deferred.nextAllowedAt);
    assert.equal(deadline, Date.parse(NOW) + 5000);
    const immediate = await connectorG.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(immediate.status, 'blocked');
    assert.equal(immediate.code, 'source_cooldown');
    assert.equal(Date.parse(immediate.nextAllowedAt), deadline, 'the cooldown deadline never moves earlier');
    assert.equal(callsG.length, 1, 'a new observe cannot forget the deferred deadline');
    nowG = deadline;
    const afterCooldown = await connectorG.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(afterCooldown.status, 'succeeded');
    assert.equal(callsG.length, 2);
  } finally {
    env.db.close();
  }
});

test('T3.1 evidence fidelity: attribution, primary-offer price isolation and raw facts', { skip }, async () => {
  const env = openEnv('fidelity');
  try {
    // this fixture performs several observes at a static instant: give it headroom above the
    // persistent window (the window/backoff behavior itself is covered by the rate group)
    const source = connectors.validateSourceRegistration(baseSource({ permit: basePermit({ rateLimit: { requestsPerWindow: 60, windowMs: 60000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 } }) }));
    const { connector } = makeConnector({
      source,
      runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' },
      routes: [
        routeFor(ASIN, PDP_FIXTURE),
        routeFor('B0CNFLCT01', PDP_CONFLICT_FIXTURE.replace(`value="${ASIN}"`, 'value="B0CNFLCT01"')),
        routeFor('B0NOVARNT1', PDP_NO_VARIATION_FIXTURE.replace(`value="${ASIN}"`, 'value="B0NOVARNT1"')),
        routeFor('B0UNKCUR01', PDP_UNKNOWN_CURRENCY_FIXTURE.replace(`value="${ASIN}"`, 'value="B0UNKCUR01"')),
        routeFor('B0NORATNG1', PDP_NO_RATING_FIXTURE.replace(`value="${ASIN}"`, 'value="B0NORATNG1"')),
        routeFor('B0NOOBSRV1', PDP_NO_OBSERVED_FIXTURE.replace(`value="${ASIN}"`, 'value="B0NOOBSRV1"'))
      ]
    });
    const obs = async (asin, variantLabel = 'Blue, 12cm') => {
      const outcome = await connector.observe({ request: variantRequest({ asin, variantLabel }), mode: 'permission_gated_api', scope: scope() });
      assert.equal(outcome.status, 'succeeded');
      return outcome.observation;
    };
    const base = await obs(ASIN);
    assert.equal(base.status, 'observed');
    assert.deepEqual(base.priceCandidates, ['$39.99']);
    // a page for a different ASIN/variant can never confirm the requested price (F4b)
    const wrongPage = makeConnector({ source, routes: [routeFor(ASIN, PDP_WRONG_ASIN_FIXTURE)], runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const wrongOutcome = await wrongPage.connector.observe({ request: variantRequest(), mode: 'permission_gated_api', scope: scope() });
    assert.equal(wrongOutcome.status, 'succeeded');
    assert.equal(wrongOutcome.observation.status, 'candidate');
    assert.ok(wrongOutcome.observation.reasons.includes('page_asin_mismatch'));
    assert.equal(wrongOutcome.observation.price.observed, false);
    assert.equal(wrongOutcome.observation.subject.selectedVariant, false);
    const mismatch = await obs(ASIN, 'Red, 12cm');
    assert.equal(mismatch.status, 'candidate');
    assert.ok(mismatch.reasons.includes('variant_selection_mismatch'));
    assert.equal(mismatch.price.observed, false);
    // R3a: "Blue Black" is not "Blue" — substring containment never confirms a configuration
    const blueBlack = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE.replace('<span class="selection">Blue</span>', '<span class="selection">Blue Black</span>'))], runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const blueBlackOut = await blueBlack.connector.observe({ request: variantRequest(), mode: 'permission_gated_api', scope: scope() });
    assert.equal(blueBlackOut.status, 'succeeded');
    assert.equal(blueBlackOut.observation.price.observed, false);
    assert.ok(blueBlackOut.observation.reasons.includes('variant_selection_mismatch'));
    // R3b: an explicit struck-through list price never competes with the current offer price
    const strikeFixture = PDP_FIXTURE.replace(
      '<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$39.99</span></span></div>',
      '<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">$39.99</span></span><span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$59.99</span></span></div>'
    );
    const strike = makeConnector({ source, routes: [routeFor(ASIN, strikeFixture)], runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const strikeOut = await strike.connector.observe({ request: variantRequest(), mode: 'permission_gated_api', scope: scope() });
    assert.equal(strikeOut.observation.status, 'observed');
    assert.equal(strikeOut.observation.price.amountMicros, 39990000);
    assert.deepEqual(strikeOut.observation.priceCandidates, ['$39.99']);
    assert.deepEqual(strikeOut.observation.excludedPrices, [{ amountText: '$59.99', kind: 'strike' }]);
    const noVariant = await obs('B0NOVARNT1');
    assert.equal(noVariant.status, 'candidate');
    assert.ok(noVariant.reasons.includes('variant_selection_missing'));
    assert.equal(noVariant.price.observed, false);
    const conflict = await obs('B0CNFLCT01');
    assert.equal(conflict.status, 'candidate');
    assert.ok(conflict.reasons.includes('price_conflict'));
    assert.equal(conflict.price.observed, false, 'a conflicting price is never reduced to the lowest one');
    assert.equal(conflict.priceCandidates.length, 2);
    const unknownCurrency = await obs('B0UNKCUR01');
    assert.equal(unknownCurrency.status, 'candidate');
    assert.ok(unknownCurrency.reasons.includes('currency_unknown'));
    assert.equal(unknownCurrency.price.currency, 'unknown');
    const noRating = await obs('B0NORATNG1');
    assert.equal(noRating.status, 'observed', 'a missing review block does not block the price');
    assert.equal(noRating.rating.observed, false);
    const noObserved = await obs('B0NOOBSRV1');
    assert.equal(noObserved.provenance.observedAtKnown, false);
    assert.equal(noObserved.provenance.observedAt, '');
    assert.equal(noObserved.provenance.fetchedAt, NOW);
    assert.ok(!('sales' in noObserved) && !('share' in noObserved) && !('monthlySales' in noObserved));
    assert.deepEqual(Object.keys(noObserved.rating).sort(), ['count', 'countKnown', 'observed', 'value']);
    assert.equal(noObserved.provenance.synthetic, true);
    assert.equal(noObserved.provenance.live, false);
    assert.throws(() => connectors.assertNoSyntheticPromotion({ provenance: { synthetic: true, live: true } }), (error) => error.code === 'synthetic_promotion_forbidden');
    const search = parseSearchCandidates(SEARCH_FIXTURE);
    assert.equal(search.candidatesOnly, true);
    assert.equal(search.priceFactsExtracted, 0);
    assert.equal(search.candidates.length, 2);
  } finally {
    env.db.close();
  }
});

test('T3.1 scope/cache: runner authority binding, second project isolation and cache dimensions', { skip }, async () => {
  const env = openEnv('scope');
  try {
    const source = connectors.validateSourceRegistration(baseSource());
    const request = variantRequest();
    // trusted runner config authority: scope contradictions block before any call
    const withAuthority = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)], runnerAuthority: { projectId: PROJECT, brand: BRAND, market: 'US' } });
    const ok = await withAuthority.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.observation.authority.kind, 'runner_config');
    const otherProject = await withAuthority.connector.observe({ request, mode: 'permission_gated_api', scope: scope({ projectId: 'proj-t31-b' }) });
    assert.equal(otherProject.status, 'blocked');
    assert.equal(otherProject.code, 'scope_authority_mismatch');
    const otherBrand = await withAuthority.connector.observe({ request, mode: 'permission_gated_api', scope: scope({ brand: 'SYNTHETIC-BRAND-B' }) });
    assert.equal(otherBrand.code, 'scope_authority_mismatch');
    const callsBefore = withAuthority.api.calls.length;
    assert.equal(callsBefore, 1, 'mismatching scopes never reach the transport');
    // brand null is not a wildcard: only the empty brand matches
    const noBrand = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)], runnerAuthority: { projectId: PROJECT, brand: null, market: 'US' } });
    const brandWildcard = await noBrand.connector.observe({ request, mode: 'permission_gated_api', scope: scope({ brand: 'SYNTHETIC-BRAND' }) });
    assert.equal(brandWildcard.code, 'scope_authority_mismatch');
    const brandEmpty = await noBrand.connector.observe({ request, mode: 'permission_gated_api', scope: scope({ brand: '' }) });
    assert.equal(brandEmpty.status, 'succeeded');
    assert.equal(brandEmpty.observation.authority.brand, '');
    // direct observe without a trusted authority fails closed (no fabricated 'direct' authorization)
    const direct = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)] });
    const directOut = await direct.connector.observe({ request, mode: 'permission_gated_api', scope: scope() });
    assert.equal(directOut.status, 'blocked');
    assert.equal(directOut.code, 'authority_missing');
    assert.equal(direct.api.calls.length, 0);
    // a caller-supplied authority may not counterfeit or override the factory binding
    const fakeOverride = await withAuthority.connector.observe({
      request, mode: 'permission_gated_api', scope: scope({ projectId: 'proj-t31-b', brand: 'SYNTHETIC-BRAND-B' }),
      authority: { kind: 'runner_config', projectId: 'proj-t31-b', brand: 'SYNTHETIC-BRAND-B', market: 'US' }
    });
    assert.equal(fakeOverride.status, 'blocked');
    assert.equal(fakeOverride.code, 'authority_override_forbidden');
    const matchingAuthority = await withAuthority.connector.observe({
      request, mode: 'permission_gated_api', scope: scope(),
      authority: { kind: 'orchestrator_context', projectId: PROJECT, brand: BRAND, market: 'US' }
    });
    assert.equal(matchingAuthority.status, 'succeeded');
    // without a factory binding only the orchestrator context channel is accepted
    const noFactory = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)] });
    const fakeConfig = await noFactory.connector.observe({
      request, mode: 'permission_gated_api', scope: scope(),
      authority: { kind: 'runner_config', projectId: PROJECT, brand: BRAND, market: 'US' }
    });
    assert.equal(fakeConfig.status, 'blocked');
    assert.equal(fakeConfig.code, 'authority_untrusted');
    // R2remaining: the orchestrator_context kind string is not a credential either
    const forgedContext = await noFactory.connector.observe({
      request, mode: 'permission_gated_api', scope: scope(),
      authority: { kind: 'orchestrator_context', projectId: PROJECT, brand: BRAND, market: 'US' }
    });
    assert.equal(forgedContext.status, 'blocked');
    assert.equal(forgedContext.code, 'authority_untrusted');
    assert.equal(noFactory.api.calls.length, 0);
    const baseKey = connectors.cacheKeyFor(scope(), source, { asin: ASIN, variantLabel: 'Blue, 12cm' });
    const keyOf = (patchScope, patchSubject = {}) => connectors.cacheKeyFor({ ...scope(), ...patchScope }, source, { asin: ASIN, variantLabel: 'Blue, 12cm', ...patchSubject });
    assert.equal(keyOf({}), baseKey);
    assert.notEqual(keyOf({ projectId: 'proj-x' }), baseKey);
    assert.notEqual(keyOf({ brand: 'OTHER' }), baseKey);
    assert.notEqual(keyOf({ windowMs: 3600000 }), baseKey);
    assert.notEqual(keyOf({}, { variantLabel: 'Red' }), baseKey);
    // the orchestrator context authority decides the domain: foreign payload scope blocks pre-transport
    const cross = makeConnector({ source, routes: [routeFor(ASIN, PDP_FIXTURE)] });
    const crossEnv = openEnv('scope-cross');
    try {
      const { report } = await runOnce(crossEnv, cross.connector, { input: handlerInput({ scope: scope({ projectId: 'proj-t31-other', brand: 'SYNTHETIC-OTHER-BRAND' }) }) });
      assert.notEqual(report.status, 'succeeded');
      assert.equal(cross.synthetic.calls.length, 0, 'the handler binds the immutable context authority, not the payload scope');
      assert.equal(report.run.checkpoint.orchestrator.artifacts.observe, undefined);
    } finally {
      crossEnv.db.close();
    }
    // market/locale/shipTo coherence with the registered source (via the factory-bound connector)
    const market = await withAuthority.connector.observe({ request, mode: 'permission_gated_api', scope: scope({ market: 'CA' }) });
    assert.equal(market.code, 'scope_market_mismatch');
    const locale = await withAuthority.connector.observe({ request, mode: 'permission_gated_api', scope: scope({ locale: 'en-CA' }) });
    assert.equal(locale.code, 'scope_locale_mismatch');
    const shipTo = await withAuthority.connector.observe({ request, mode: 'permission_gated_api', scope: scope({ shipTo: 'CA' }) });
    assert.equal(shipTo.code, 'scope_shipto_mismatch');
  } finally {
    env.db.close();
  }
});
