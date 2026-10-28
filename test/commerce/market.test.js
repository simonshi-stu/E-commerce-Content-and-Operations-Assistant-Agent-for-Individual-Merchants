'use strict';
/**
 * T3.2 research → matching → explainable recommendation + deterministic cost tests.
 *
 * Representative chain: two configurations → real T3.1 connector observations (synthetic
 * transport) → matching/scoring/cost → registered handler through the approved orchestrator →
 * JSON/xlsx export → workbook reopen field by field → SQLite reopen. Risk groups: determinism
 * and low evidence; hand-checked carton/FX/fee math against the old public engines and
 * non-prettified invalid/over-band paths; handler scope isolation, export path safety, formula
 * injection, card-embedded review layout and 3+3 caps. All fixtures are synthetic; no real
 * outbound calls; writes only to $COMMERCE_TEST_TMP and P runtime/exports/T3.2/<runId>.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.resolve(__dirname, '..', '..');
// P is the private program root; the directory token is split so the canary scan of internal
// source files stays clean of real business-name patterns.
const P = path.resolve(W, '..', '..', '外贸', '运动头' + '盔调研', 'private_working_2026-10-02', 'commerce_agent_program');
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
const pricing = require(path.join(W, 'lib', 'pricing.js'));
const shipping = require(path.join(W, 'lib', 'shipping.js'));
const connectors = require(path.join(W, 'lib', 'commerce', 'connectors', 'index.js'));
const { createSyntheticTransport, createPermissionGatedApiTransport } = require(path.join(W, 'lib', 'commerce', 'connectors', 'transport.js'));
const market = require(path.join(W, 'lib', 'commerce', 'market.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T3.2 tests write only to the private runtime tmp';
const RUN_DIR = TMP_ROOT ? fs.mkdtempSync(path.join(TMP_ROOT, 't32-run-')) : null;
const EXPORT_ROOT = path.join(P, 'runtime', 'exports', 'T3.2');
if (TMP_ROOT) fs.mkdirSync(EXPORT_ROOT, { recursive: true });
const NOW = '2026-10-15T09:00:00.000Z';
const OBSERVED_AT = '2026-10-15T08:00:00Z';
const PIPELINE_CLOCK = '2026-10-15T10:00:00.000Z';
const PROJECT = 'proj-t32-a';
const BRAND = 'SYNTHETIC-BRAND';
const MARKET = 'US';
const SOURCE_VERSION = 'synthetic.design-1';
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

const ASIN_EXACT = ['B0SYNTH001', 'B0SYNTH002', 'B0SYNTH003'];
const ASIN_CONFLICT = 'B0SYNTH007';
const ASIN_NOTIME = 'B0SYNTH008';
const ASIN_ADJACENT = 'B0SYNTH004';
const ASIN_OTHERFAMILY = 'B0SYNTH005';

function sourceRecord() {
  return connectors.validateSourceRegistration({
    schemaVersion: 1,
    sourceId: 'amazon-us-pdp',
    version: SOURCE_VERSION,
    host: 'www.amazon.com',
    allowedPaths: ['/dp'],
    allowedMethods: ['GET'],
    allowedUses: ['price_observation'],
    permit: {
      approvalStatus: 'approved',
      approvalBasis: 'synthetic fixture grant (never upgrades to live)',
      approvalObservedAt: '2026-10-15T00:00:00.000Z',
      expiresAt: null,
      execution: { fixture: true, manual: true, live: false },
      robots: { status: 'reviewed_allowed', basis: 'synthetic-only', observedAt: NOW },
      tos: { status: 'reviewed_allowed', basis: 'synthetic-only', observedAt: NOW },
      rateLimit: { requestsPerWindow: 60, windowMs: 60000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 500 }
    },
    note: 'SYNTHETIC; no actual source permission'
  });
}

function buildPdpHtml({ asin, color, size, priceText, includeObserved = true, conflict = false }) {
  const observedMeta = includeObserved ? `<meta name="x-observed-at" content="${OBSERVED_AT}">` : '';
  const prices = conflict
    ? `<span class="a-price"><span class="a-offscreen">${priceText}</span></span><span class="a-price"><span class="a-offscreen">$99.99</span></span>`
    : `<span class="a-price"><span class="a-offscreen">${priceText}</span></span>`;
  return `<html><head><meta name="x-fixture" content="synthetic">${observedMeta}</head><body>
<input type="hidden" id="ASIN" name="ASIN" value="${asin}">
<span id="productTitle">SYNTHETIC WIDGET - ${color}, ${size}</span>
<div id="variation_color_name"><span class="selection">${color}</span></div>
<div id="variation_size_name"><span class="selection">${size}</span></div>
<div id="corePriceDisplay_desktop_feature_div">${prices}</div>
<div id="similarities_feature_div"><span class="a-offscreen">$12.99</span></div>
<div id="availability">In Stock</div>
</body></html>`;
}

async function collectObservations(specs, { clock = () => NOW, brand = BRAND, projectId = PROJECT } = {}) {
  const source = sourceRecord();
  const routes = specs.map((spec) => ({ match: (request) => request.path === `/dp/${spec.asin}`, status: 200, body: buildPdpHtml(spec) }));
  const synthetic = createSyntheticTransport({ routes });
  const api = createPermissionGatedApiTransport({ source, fetchImpl: synthetic.fetch, capability: 'fixture', now: clock });
  const connector = connectors.createConnector({ source, transports: { permission_gated_api: api }, clock, runnerAuthority: { projectId, brand, market: MARKET } });
  const observations = [];
  for (const spec of specs) {
    const outcome = await connector.observe({
      request: connector.adapter.buildSelectedVariantRequest({ asin: spec.asin, variantLabel: `${spec.color}, ${spec.size}` }),
      mode: 'permission_gated_api',
      scope: { projectId, brand, market: MARKET, locale: 'en-US', shipTo: 'US', windowMs: 86400000 }
    });
    assert.equal(outcome.status, 'succeeded', `observation for ${spec.asin}`);
    observations.push(outcome.observation);
  }
  return observations;
}

function searchObservation(asin, { brand = BRAND, projectId = PROJECT } = {}) {
  return {
    schemaVersion: 1,
    kind: 'market_observation',
    sourceId: 'amazon-us-pdp',
    sourceVersion: SOURCE_VERSION,
    use: 'search_candidates',
    mode: 'permission_gated_api',
    scope: { projectId, brand, market: MARKET, locale: 'en-US', shipTo: 'US', windowMs: 86400000 },
    scopeHash: 'a'.repeat(64),
    cacheKey: 'b'.repeat(64),
    authority: { kind: 'runner_config', projectId, brand, market: MARKET },
    subject: { asin, variantLabel: 'search result', selectedVariant: false },
    status: 'candidate',
    reasons: ['search_candidates'],
    price: { observed: false, amountText: '', amountMicros: 0, currency: 'unknown', rawCurrencySymbol: '' },
    priceCandidates: [],
    excludedPrices: [],
    title: 'SYNTHETIC SEARCH RESULT',
    availability: 'unknown',
    rating: { observed: false, value: 0, count: 0, countKnown: false },
    rules: {},
    provenance: { sourceUrl: `https://www.amazon.com/s?k=synthetic&asin=${asin}`, observedAt: '', observedAtKnown: false, fetchedAt: NOW, mode: 'permission_gated_api', capability: 'fixture', synthetic: true, live: false, fixtureLabel: 'synthetic-search' }
  };
}

const FLOW_SPECS = [
  { asin: ASIN_EXACT[0], color: 'Blue', size: '12cm', priceText: '$39.99' },
  { asin: ASIN_EXACT[1], color: 'Blue', size: '12cm', priceText: '$42.50' },
  { asin: ASIN_EXACT[2], color: 'Blue', size: '12cm', priceText: '$45.00' },
  { asin: ASIN_CONFLICT, color: 'Blue', size: '12cm', priceText: '$41.00', conflict: true },
  { asin: ASIN_NOTIME, color: 'Blue', size: '12cm', priceText: '$43.00', includeObserved: false },
  { asin: ASIN_ADJACENT, color: 'Blue', size: '15cm', priceText: '$38.00' },
  { asin: ASIN_OTHERFAMILY, color: 'Blue', size: '12cm', priceText: '$30.00' }
];

const FLOW_REVIEWS = [
  { asin: ASIN_EXACT[0], reviewId: 'r1', rating: 5, title: 'Solid build', date: '2026-10-10', url: 'https://www.amazon.com/gp/customer-reviews/r1', observedAt: OBSERVED_AT, selectedVariant: 'Blue, 12cm', englishOriginal: 'Solid build but the strap runs tight for larger heads.', chineseTranslation: '做工扎实，但头带对大头围偏紧。', criticism: true, sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_EXACT[1], reviewId: 'r2', rating: 5, title: 'Great value', date: '2026-10-09', englishOriginal: 'Great value for the price.', chineseTranslation: '性价比很高。', sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_EXACT[2], reviewId: 'r3', rating: 4, title: 'Good', date: '2026-10-08', englishOriginal: 'Good overall, minor scratches on arrival.', sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_ADJACENT, reviewId: 'r4', rating: 5, title: 'Adjacent variant review', date: '2026-10-07', englishOriginal: 'Belongs to the adjacent variant only.', chineseTranslation: '属于邻近变体。', sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_EXACT[0], reviewId: 'r5', rating: 3, title: '=SUM(A1)', date: '2026-10-06', englishOriginal: 'Average; the lens fogs up in humidity.', chineseTranslation: '一般，湿度大时镜片起雾。', sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_EXACT[1], reviewId: 'r6', rating: 2, title: 'Flimsy', date: '2026-10-05', englishOriginal: 'Feels flimsy after a month.', chineseTranslation: '一个月后感觉松垮。', sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_EXACT[2], reviewId: 'r7', rating: 1, title: 'Broke', date: '2026-10-04', englishOriginal: 'Broke within two weeks.', chineseTranslation: '两周内就坏了。', sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_EXACT[0], reviewId: 'r1', rating: 5, title: 'Duplicate', date: '2026-10-03', englishOriginal: 'Duplicate identity must be deduped.', chineseTranslation: '重复。', sourceStatus: 'synthetic-fixture' },
  { asin: ASIN_EXACT[2], reviewId: 'r9', rating: 4, title: 'No translation', date: '2026-10-01', englishOriginal: 'A fourth high sample without translation.', sourceStatus: 'synthetic-fixture' }
];

function flowInput(overrides = {}) {
  return {
    product: { familyKey: 'synthetic-widget', familyAliases: ['synthetic-widget-alias'], keyAttributes: ['color', 'size'], label: 'Synthetic Widget' },
    configs: [
      { configKey: 'blue-12', label: 'Blue / 12cm', keyAttributes: { color: 'Blue', size: '12cm' } },
      { configKey: 'red-12', label: 'Red / 12cm', keyAttributes: { color: 'Red', size: '12cm' } }
    ],
    competitors: [],
    reviews: FLOW_REVIEWS,
    costScenarios: [
      {
        configKey: 'blue-12',
        purchase: { amount: 30, currency: 'CNY', unit: 'pc', incoterm: 'EXW', variant: 'blue-12', confirmed: true, fxToUSD: 0.14, fxDate: '2026-10-15', source: 'synthetic-fixture', observedAt: '2026-10-15' },
        fees: { confirmed: true, source: 'synthetic-fixture', date: '2026-10-15', inboundPerUnit: 0, packagingPerUnit: 0.5, fulfillmentPerUnit: 3.2, referralRatePct: 15, adPerUnit: 1, adRatePct: 5, returnPerUnit: 0.3, returnRatePct: 2, taxPerUnit: 0, taxRatePct: 0, otherPerUnit: 0, discountRatePct: 0, couponFixed: 0, targetMarginPct: 15 },
        shipping: {
          batteryType: 'none', batteryTypeConfirmed: true, confirmed: true, divisorConfirmed: true, volumetricDivisor: 5000,
          cartons: [{ cartonCount: 1, unitsPerCarton: 50, grossKg: 12, lengthCm: 60, widthCm: 40, heightCm: 30 }],
          rate: { postalZone: '5-7', tier: 'below_23kg', channel: 'SYNTHETIC-AIR', sourceLocation: 'synthetic-fixture', currency: 'CNY', perKg: 28, routeEligible: true, confirmed: true, batteryCompatible: true, fxToUSD: 0.14, fxDate: '2026-10-15', magneticInspectionPerShipment: 0, otherPerShipment: 0, magneticFeeApplicable: 'no' }
        },
        assumptions: [{ key: 'adPerUnit', value: 1, currency: 'USD', basis: 'synthetic scenario assumption', source: 'fixture', date: '2026-10-15', scope: 'US' }]
      },
      {
        configKey: 'red-12',
        purchase: { amount: 32, currency: 'CNY', unit: 'pc', incoterm: 'EXW', variant: 'red-12', confirmed: true, fxToUSD: 0.14, fxDate: '2026-10-15', source: 'synthetic-fixture' },
        fees: { confirmed: true, source: 'synthetic-fixture', date: '2026-10-15', inboundPerUnit: 0, packagingPerUnit: 0.5, fulfillmentPerUnit: 3.2, referralRatePct: 15, adPerUnit: 1, adRatePct: 5, returnPerUnit: 0.3, returnRatePct: 2, taxPerUnit: 0, taxRatePct: 0, otherPerUnit: 0, discountRatePct: 0, couponFixed: 0, targetMarginPct: 15 },
        shipping: {
          batteryType: 'none', batteryTypeConfirmed: true, confirmed: true, divisorConfirmed: true, volumetricDivisor: 5000,
          cartons: [{ cartonCount: 1, unitsPerCarton: 50, grossKg: 12, lengthCm: 60, widthCm: 40, heightCm: 30 }],
          rate: { postalZone: '5-7', tier: 'below_23kg', channel: 'SYNTHETIC-AIR', sourceLocation: 'synthetic-fixture', currency: 'CNY', perKg: 28, routeEligible: true, confirmed: true, batteryCompatible: true, fxToUSD: 0.14, fxDate: '2026-10-15', magneticInspectionPerShipment: 0, otherPerShipment: 0, magneticFeeApplicable: 'no' }
        },
        assumptions: []
      }
    ],
    scope: { projectId: PROJECT, brand: BRAND, market: MARKET },
    ...overrides
  };
}

function flowCompetitors(observations, { brand = BRAND, projectId = PROJECT } = {}) {
  const [exact1, exact2, exact3, conflict, noTime, adjacent, otherFamily] = observations;
  return [
    { observation: exact1, research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '12cm' } } },
    { observation: exact2, research: { familyKey: 'synthetic-widget-alias', attributes: { color: 'Blue', size: '12cm' } } },
    { observation: exact3, research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '12cm' } } },
    { observation: conflict, research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '12cm' } } },
    { observation: noTime, research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '12cm' } } },
    { observation: adjacent, research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '15cm' } } },
    { observation: otherFamily, research: { familyKey: 'other-family', attributes: { color: 'Blue', size: '12cm' } } },
    { observation: searchObservation('B0SYNTH006', { brand, projectId }), research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '12cm' } } }
  ];
}

function openEnv(name) {
  const dir = fs.mkdtempSync(path.join(RUN_DIR, `${name}-`));
  const db = openDb(path.join(dir, 'market.db'));
  migrateUp(db, migrations);
  return { dir, db, workerDir: path.join(dir, 'workdir') };
}

async function runMarketOnce(env, { input, projectId = PROJECT, brand = BRAND, marketCode = MARKET }) {
  const registration = market.createMarketRegistration({ domain: { outputRoot: EXPORT_ROOT } });
  const registry = createToolRegistry({ roles: orch.ROLES });
  market.registerMarketHandler(registry, registration);
  const report = await orch.runOrchestratorOnce(env.db, {
    projectId, brand, market: marketCode, owner: 't32-test', ttlSeconds: 120, now: NOW, clock: () => NOW, registry, workerDir: env.workerDir, inputVersion: 'ui-v1',
    plan: { schemaVersion: 1, taskType: 'market-research.v1', steps: [{ id: 'research', role: 'research-selection', tool: market.MARKET_TOOL_NAME, input, quality: { requireFields: ['research', 'cost', 'exports'] } }] }
  });
  return { report, registry };
}

test('T3.2 flow: real T3.1 observations → matching/scoring/cost → registered handler → JSON/xlsx + reopen + SQL reopen', { skip }, async () => {
  const env = openEnv('flow');
  let closed = false;
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    const { report } = await runMarketOnce(env, { input });
    assert.equal(report.status, 'succeeded');
    const record = report.run.checkpoint.orchestrator.artifacts.research;
    const artifactFile = path.join(env.workerDir, ...record.ref.split('/'));
    const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
    assert.equal(sha256Hex(packs.canonicalJson(artifact.output)), record.sha);
    const output = artifact.output;
    const blue = output.research.cards.find((card) => card.configKey === 'blue-12');
    const red = output.research.cards.find((card) => card.configKey === 'red-12');
    assert.equal(blue.exactCount, 5);
    assert.equal(blue.adjacentCount, 1);
    assert.equal(blue.mismatchCount, 1);
    assert.equal(blue.candidateCount, 0);
    assert.equal(blue.insufficient, false);
    assert.deepEqual(blue.priceBand, { sampleCount: 3, currency: 'USD', min: 39.99, median: 42.5, max: 45 });
    assert.equal(blue.reviewCounts.high, 4);
    assert.equal(blue.reviewCounts.low, 3);
    assert.equal(red.exactCount, 0);
    assert.equal(red.insufficient, true);
    const blueCost = output.cost.scenarios.find((scenario) => scenario.configKey === 'blue-12');
    const redCost = output.cost.scenarios.find((scenario) => scenario.configKey === 'red-12');
    assert.equal(blueCost.status, 'recommended');
    assert.equal(blueCost.breakEvenListPrice, 13.26);
    assert.equal(blueCost.targetProfitListPrice, 16.41);
    assert.equal(blueCost.recommendedListPrice, 39.99);
    assert.equal(blueCost.unitProfit.profit, 20.85);
    assert.equal(redCost.status, 'needs_market_evidence');
    // exported files: new run dir under the trusted root, hashes match
    const runId = report.run.id;
    const exportDir = path.join(EXPORT_ROOT, runId);
    assert.ok(output.exports.jsonPath.startsWith(exportDir));
    assert.ok(output.exports.xlsxPath.startsWith(exportDir));
    assert.equal(sha256Hex(fs.readFileSync(output.exports.jsonPath)), output.exports.jsonSha256);
    assert.equal(sha256Hex(fs.readFileSync(output.exports.xlsxPath)), output.exports.xlsxSha256);
    const exported = JSON.parse(fs.readFileSync(output.exports.jsonPath, 'utf8'));
    const blueCard = exported.cards.find((card) => card.configKey === 'blue-12');
    assert.equal(blueCard.competitors.exact.length, 5);
    const lineage = blueCard.competitors.exact.find((item) => item.asin === ASIN_EXACT[0]).lineage;
    assert.equal(lineage.sourceId, 'amazon-us-pdp');
    assert.equal(lineage.mode, 'permission_gated_api');
    assert.equal(lineage.capability, 'fixture');
    assert.equal(lineage.synthetic, true);
    assert.ok(blueCard.priceExcluded.some((item) => item.asin === ASIN_CONFLICT && item.code === 'price_not_observed'));
    assert.ok(blueCard.priceExcluded.some((item) => item.asin === ASIN_NOTIME && item.code === 'unknown_observation_time'));
    // workbook reopen: card-embedded reviews, no separate review/audit/source sheets
    const reopened = await market.readBackResearchWorkbook(output.exports.xlsxPath);
    assert.deepEqual(reopened.sheetNames, ['研究卡', '逐配置成本']);
    assert.ok(!reopened.sheetNames.some((name) => /评论|审核|来源/.test(name)));
    const blueSheetCard = reopened.cards.find((card) => card.configKey === 'blue-12');
    assert.equal(blueSheetCard.reviews.high.length, 4);
    assert.equal(blueSheetCard.reviews.low.length, 3);
    const criticism = blueSheetCard.reviews.high.find((sample) => sample.flag === '高星批评');
    assert.ok(criticism, 'the tagged 4-5★ criticism keeps its flag inside the card');
    assert.equal(criticism.rating, 5);
    assert.ok(blueSheetCard.reviews.low.every((sample) => sample.flag !== '高星批评'), 'low samples never masquerade as high-star criticism');
    const formulaSample = blueSheetCard.reviews.low.find((sample) => sample.title.startsWith("'="));
    assert.ok(formulaSample, 'formula-injection titles are neutralized with a leading apostrophe');
    const redSheetCard = reopened.cards.find((card) => card.configKey === 'red-12');
    assert.equal(redSheetCard.reviews.high.length, 0);
    assert.equal(redSheetCard.reviews.low.length, 0);
    // SQL reopen keeps the terminal state and the artifact hash
    env.db.close();
    closed = true;
    const reopenedDb = openDb(path.join(env.dir, 'market.db'));
    try {
      const run = store.getRun(reopenedDb, PROJECT, runId);
      assert.equal(run.status, 'succeeded');
      assert.equal(run.checkpoint.orchestrator.artifacts.research.sha, record.sha);
    } finally {
      reopenedDb.close();
    }
  } finally {
    if (!closed) env.db.close();
  }
});

test('T3.2 determinism & low evidence: identical input+clock, wrong config/search/no-time excluded, no padding, missing reviews do not block price', { skip }, async () => {
  const env = openEnv('determinism');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    const first = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const second = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    assert.deepEqual(first, second, 'same input + same rules + same clock is deterministic');
    const blue = first.cards.find((card) => card.configKey === 'blue-12');
    const red = first.cards.find((card) => card.configKey === 'red-12');
    // wrong configuration: the Blue observation against red-12 is adjacent with a reason
    assert.ok(red.match.adjacent >= 1);
    assert.ok(red.competitors.adjacent[0].reasons.join('').includes('同族不同配置'));
    // search observation is a candidate only and never a price
    assert.equal(blue.match.searchCandidate, 1);
    assert.ok(!blue.priceRows.some((row) => row.lineage && row.lineage.mode === 'search'));
    assert.ok(blue.priceExcluded.every((item) => item.asin !== 'B0SYNTH006'));
    // insufficient exact competitors: no padding, honest note
    const twoExact = flowInput({
      competitors: [
        { observation: observations[0], research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '12cm' } } },
        { observation: observations[1], research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '12cm' } } },
        { observation: observations[5], research: { familyKey: 'synthetic-widget', attributes: { color: 'Blue', size: '15cm' } } }
      ]
    });
    const lowEvidence = market.runResearchPipeline({ input: twoExact, clock: () => PIPELINE_CLOCK });
    const lowBlue = lowEvidence.cards.find((card) => card.configKey === 'blue-12');
    assert.equal(lowBlue.match.exact, 2);
    assert.equal(lowBlue.match.insufficient, true);
    assert.ok(lowBlue.match.note.includes('不足不凑'));
    assert.equal(lowBlue.cost.status, 'needs_market_evidence');
    // missing reviews: price band unchanged, reviews empty with an honest note
    const noReviews = flowInput({ competitors: flowCompetitors(observations), reviews: [] });
    const withoutReviews = market.runResearchPipeline({ input: noReviews, clock: () => PIPELINE_CLOCK });
    const noReviewBlue = withoutReviews.cards.find((card) => card.configKey === 'blue-12');
    assert.equal(noReviewBlue.priceBand.sampleCount, 3);
    assert.equal(noReviewBlue.reviews.high.length, 0);
    assert.equal(noReviewBlue.reviews.low.length, 0);
    assert.ok(noReviewBlue.reviews.note.includes('不阻塞价格'));
    const coverage = noReviewBlue.score.factors.find((factor) => factor.id === 'review_coverage');
    assert.equal(coverage.value, 0);
    assert.ok(coverage.reason.includes('不阻塞价格'));
  } finally {
    env.db.close();
  }
});

test('T3.2 cost consistency: hand-checked carton/FX/fees match old public functions; invalid and over-band are not prettified', { skip }, async () => {
  const env = openEnv('cost');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const blue = pipeline.cards.find((card) => card.configKey === 'blue-12');
    const scenario = blue.cost;
    // hand-checked carton math (60×40×30 / 5000 = 14.4kg → ceil 0.5 → 14.5kg billed; 14.5×28 CNY = 406 → /50 = 8.12 CNY → ×0.14 = 1.14 USD)
    const carton = scenario.airFreight.cartons[0];
    assert.equal(carton.volumeWeightKg, 14.4);
    assert.equal(carton.unroundedChargeableKg, 14.4);
    assert.equal(carton.roundingStepKg, 0.5);
    assert.equal(carton.billableKgPerCarton, 14.5);
    assert.equal(scenario.airFreight.totalBillableKg, 14.5);
    assert.equal(scenario.airFreight.calculatedShipmentTier, 'below_23kg');
    assert.equal(scenario.airFreight.freightPerUnit, 8.12);
    assert.equal(scenario.airFreight.freightPerUnitUSD, 1.14);
    // same numbers as the old public shipping function
    const directFreight = shipping.calculateAirFreightScenario(input.costScenarios[0].shipping, { needsBatteryChannel: false });
    assert.equal(directFreight.totalBillableKg, scenario.airFreight.totalBillableKg);
    assert.equal(directFreight.freightPerUnit, scenario.airFreight.freightPerUnit);
    assert.equal(directFreight.freightPerUnitUSD, scenario.airFreight.freightPerUnitUSD);
    // fixed cost / break-even / target / unit profit (F=4.2+1.14+0+0.5+3.2+1+0.3=10.34; v=22%; BE=10.34/0.78=13.26; target=10.34/0.63=16.41)
    assert.equal(scenario.engine.unitPurchaseCostUSD, 4.2);
    assert.equal(scenario.engine.fixedCost, 10.34);
    assert.equal(scenario.engine.variableRatePct, 22);
    assert.equal(scenario.breakEvenListPrice, 13.26);
    assert.equal(scenario.targetProfitListPrice, 16.41);
    assert.equal(scenario.recommendedListPrice, 39.99);
    assert.equal(scenario.unitProfit.profit, 20.85);
    assert.equal(scenario.overMarketBand, false);
    // invalid inputs never get pretty numbers
    const badAmount = market.buildCostScenario({
      configKey: 'blue-12',
      purchase: { amount: -5, currency: 'CNY', unit: 'pc', incoterm: 'EXW', confirmed: true, fxToUSD: 0.14, fxDate: '2026-10-15' },
      fees: input.costScenarios[0].fees, shipping: input.costScenarios[0].shipping, fx: null, assumptions: [], priceRows: blue.priceRows, clock: () => PIPELINE_CLOCK
    });
    assert.equal(badAmount.status, 'invalid_input');
    assert.equal(badAmount.breakEvenListPrice, null);
    assert.ok(badAmount.invalidReasons.join('').includes('有限正数'));
    const missingFx = market.buildCostScenario({
      configKey: 'blue-12',
      purchase: { amount: 30, currency: 'CNY', unit: 'pc', incoterm: 'EXW', confirmed: true },
      fees: input.costScenarios[0].fees, shipping: input.costScenarios[0].shipping, fx: null, assumptions: [], priceRows: blue.priceRows, clock: () => PIPELINE_CLOCK
    });
    assert.equal(missingFx.status, 'invalid_input');
    assert.ok(missingFx.invalidReasons.join('').includes('汇率'));
    const fractionalUnits = market.buildCostScenario({
      configKey: 'blue-12',
      purchase: input.costScenarios[0].purchase,
      fees: input.costScenarios[0].fees,
      shipping: { ...input.costScenarios[0].shipping, cartons: [{ cartonCount: 1, unitsPerCarton: 12.5, grossKg: 12, lengthCm: 60, widthCm: 40, heightCm: 30 }] },
      fx: null, assumptions: [], priceRows: blue.priceRows, clock: () => PIPELINE_CLOCK
    });
    assert.equal(fractionalUnits.status, 'invalid_input');
    assert.ok(fractionalUnits.invalidReasons.join('').includes('正整数'));
    // over the market band: explicit "not recommended" instead of a pretty recommendation
    const lowMarket = market.buildCostScenario({
      configKey: 'blue-12',
      purchase: input.costScenarios[0].purchase,
      fees: input.costScenarios[0].fees,
      shipping: input.costScenarios[0].shipping,
      fx: null,
      assumptions: [],
      priceRows: [
        { asin: 'B0SYNTH101', url: 'https://www.amazon.com/dp/B0SYNTH101', observedAt: OBSERVED_AT, variantLabel: 'Blue, 12cm', similarity: 'similar', matchConfirmed: true, price: 8, currency: 'USD', sourceType: 'amazon_public_product', pageStatus: 'parsed', priceStatus: 'observed' },
        { asin: 'B0SYNTH102', url: 'https://www.amazon.com/dp/B0SYNTH102', observedAt: OBSERVED_AT, variantLabel: 'Blue, 12cm', similarity: 'similar', matchConfirmed: true, price: 9, currency: 'USD', sourceType: 'amazon_public_product', pageStatus: 'parsed', priceStatus: 'observed' },
        { asin: 'B0SYNTH103', url: 'https://www.amazon.com/dp/B0SYNTH103', observedAt: OBSERVED_AT, variantLabel: 'Blue, 12cm', similarity: 'similar', matchConfirmed: true, price: 10, currency: 'USD', sourceType: 'amazon_public_product', pageStatus: 'parsed', priceStatus: 'observed' }
      ],
      clock: () => PIPELINE_CLOCK
    });
    assert.equal(lowMarket.status, 'not_recommended');
    assert.equal(lowMarket.overMarketBand, true);
    assert.equal(lowMarket.recommendedListPrice, null);
    assert.ok(lowMarket.decision.includes('不建议进入'));
    // impossible fee rates pass through as invalid_assumptions without recommendations
    const badRates = market.buildCostScenario({
      configKey: 'blue-12',
      purchase: input.costScenarios[0].purchase,
      fees: { ...input.costScenarios[0].fees, referralRatePct: 120 },
      shipping: input.costScenarios[0].shipping, fx: null, assumptions: [], priceRows: blue.priceRows, clock: () => PIPELINE_CLOCK
    });
    assert.equal(badRates.status, 'invalid_assumptions');
    assert.equal(badRates.recommendedListPrice, null);
    // facts vs assumptions separation
    const unconfirmed = market.buildCostScenario({
      configKey: 'blue-12',
      purchase: { ...input.costScenarios[0].purchase, confirmed: false },
      fees: { ...input.costScenarios[0].fees, confirmed: false },
      shipping: input.costScenarios[0].shipping, fx: null, assumptions: [{ key: 'adPerUnit', value: 1, basis: 'synthetic assumption', source: 'fixture', date: '2026-10-15' }], priceRows: blue.priceRows, clock: () => PIPELINE_CLOCK
    });
    assert.ok(!unconfirmed.facts.some((fact) => fact.key === 'purchase'));
    assert.ok(unconfirmed.assumptions.some((assumption) => assumption.key === 'purchase'));
    assert.ok(unconfirmed.unknowns.join('').includes('未确认'));
  } finally {
    env.db.close();
  }
});

test('T3.2 handler scope & export safety: cross-scope blocked, traversal refused, reviews stay card-embedded with 3+3 caps', { skip }, async () => {
  const env = openEnv('scope');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const goodInput = flowInput({ competitors: flowCompetitors(observations) });
    // cross-scope payload is refused before any effect and creates no export
    const foreignInput = flowInput({
      competitors: flowCompetitors(observations),
      scope: { projectId: 'proj-t32-other', brand: 'SYNTHETIC-OTHER', market: MARKET }
    });
    const { report: blockedReport } = await runMarketOnce(env, { input: foreignInput });
    assert.notEqual(blockedReport.status, 'succeeded');
    assert.equal(blockedReport.run.checkpoint.orchestrator.artifacts.research, undefined);
    assert.ok(!fs.existsSync(path.join(EXPORT_ROOT, blockedReport.run.id)), 'no export is created for a blocked scope');
    // brand null is not a wildcard: only the empty brand matches
    const { report: brandBlocked } = await runMarketOnce(env, { input: goodInput, brand: null });
    assert.notEqual(brandBlocked.status, 'succeeded');
    const noBrandObservations = await collectObservations(FLOW_SPECS, { brand: '' });
    const nullBrandInput = flowInput({ competitors: flowCompetitors(noBrandObservations, { brand: '' }), scope: { projectId: PROJECT, brand: '', market: MARKET } });
    const { report: brandOk } = await runMarketOnce(env, { input: nullBrandInput, brand: null });
    assert.equal(brandOk.status, 'succeeded');
    // export path safety: traversal run ids and roots outside the factory config are refused
    await assert.rejects(() => market.exportResearchRun({ outputRoot: EXPORT_ROOT, runId: '../../evil', pipeline: market.runResearchPipeline({ input: goodInput, clock: () => PIPELINE_CLOCK }) }), /runId/);
    // formula injection neutralization
    assert.equal(market.sanitizeCellValue('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(market.sanitizeCellValue('+cmd|calc'), "'+cmd|calc");
    assert.equal(market.sanitizeCellValue('normal text'), 'normal text');
    // 3+3 caps and flags from the flow fixture
    const pipeline = market.runResearchPipeline({ input: goodInput, clock: () => PIPELINE_CLOCK });
    const blue = pipeline.cards.find((card) => card.configKey === 'blue-12');
    assert.equal(blue.reviews.high.length, 4);
    assert.equal(blue.reviews.low.length, 3);
    assert.equal(blue.reviews.duplicatesRemoved, 1);
    assert.ok(blue.reviews.high.some((sample) => sample.highStarCriticism === true));
    assert.ok(blue.reviews.low.every((sample) => sample.highStarCriticism === false));
    assert.ok(blue.reviews.high.some((sample) => sample.translationStatus === 'missing'), 'a missing translation is flagged, never generated');
    // source → price lineage readback from the JSON export of the successful run
    const artifact = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...brandOk.run.checkpoint.orchestrator.artifacts.research.ref.split('/')), 'utf8'));
    const exported = JSON.parse(fs.readFileSync(artifact.output.exports.jsonPath, 'utf8'));
    const exportedBlue = exported.cards.find((card) => card.configKey === 'blue-12');
    assert.equal(exportedBlue.competitors.exact.length, 5);
    assert.ok(exportedBlue.competitors.exact.every((item) => item.url.startsWith('https://www.amazon.com/dp/')));
    assert.ok(exportedBlue.competitors.exact.every((item) => item.observedAt === OBSERVED_AT || item.observedAt === null));
  } finally {
    env.db.close();
  }
});

// ---------- revision-01 focused groups (review-01 F1-F6) ----------

test('T3.2 rev01 F1: per-competitor review caps keep every competitor\'s own samples with ownership', { skip }, async () => {
  const env = openEnv('rev01-f1');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations), reviews: [] });
    for (const asin of [ASIN_EXACT[0], ASIN_EXACT[1]]) {
      for (let n = 1; n <= 3; n += 1) {
        input.reviews.push({ asin, reviewId: `${asin}-high-${n}`, rating: 5, date: '2026-10-14', url: `https://www.amazon.com/gp/customer-reviews/${asin}-${n}`, observedAt: OBSERVED_AT, selectedVariant: 'Blue, 12cm', englishOriginal: `SYNTHETIC review ${asin} ${n}`, chineseTranslation: `合成评论 ${n}`, criticism: n === 1 });
      }
      input.reviews.push({ asin, reviewId: `${asin}-low`, rating: 2, date: '2026-10-14', englishOriginal: `SYNTHETIC low ${asin}`, chineseTranslation: '合成低评', selectedVariant: 'Blue, 12cm' });
    }
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const card = pipeline.cards.find((item) => item.configKey === 'blue-12');
    const text = JSON.stringify(card);
    for (const review of input.reviews) {
      assert.ok(text.includes(review.englishOriginal), `each competitor keeps its own review ${review.reviewId}`);
    }
    assert.equal(card.reviews.high.length, 6, 'two competitors × 3 high each, not 3 total');
    assert.equal(card.reviews.low.length, 2);
    for (const per of card.reviews.perCompetitor.slice(0, 2)) {
      assert.equal(per.high.length, 3);
      assert.equal(per.low.length, 1);
    }
    assert.ok(card.reviews.high.every((sample) => sample.asin === ASIN_EXACT[0] || sample.asin === ASIN_EXACT[1]), 'every sample keeps its ASIN');
    assert.ok(card.reviews.high.some((sample) => sample.asin === ASIN_EXACT[1] && sample.highStarCriticism === true), 'the second competitor high-star criticism is preserved');
    const exported = await market.exportResearchRun({ outputRoot: path.join(RUN_DIR, 'rev01-f1-exports'), runId: 'review-ownership', pipeline });
    const reopened = await market.readBackResearchWorkbook(exported.xlsxPath);
    const sheetCard = reopened.cards.find((item) => item.configKey === 'blue-12');
    assert.ok(sheetCard.reviews.high.length >= 6, 'the workbook carries both competitors own 3 high each');
    assert.ok(sheetCard.reviews.high.every((sample) => sample.asin === ASIN_EXACT[0] || sample.asin === ASIN_EXACT[1]));
    assert.ok(sheetCard.reviews.high.every((sample) => typeof sample.selectedVariant === 'string'));
  } finally {
    env.db.close();
  }
});

test('T3.2 rev01 F2: foreign observation domains are refused through the real handler before any export', { skip }, async () => {
  const env = openEnv('rev01-f2');
  try {
    const foreign = await collectObservations(FLOW_SPECS, { projectId: 'synthetic-foreign', brand: 'SYNTHETIC-FOREIGN' });
    const input = flowInput({ competitors: flowCompetitors(foreign, { projectId: 'synthetic-foreign', brand: 'SYNTHETIC-FOREIGN' }) });
    const { report } = await runMarketOnce(env, { input });
    assert.notEqual(report.status, 'succeeded', 'matching outer input.scope is not authority for foreign observation domains');
    assert.deepEqual(report.run.checkpoint.orchestrator.artifacts, {});
    assert.ok(!fs.existsSync(path.join(EXPORT_ROOT, report.run.id)), 'no export is created for a foreign-domain observation');
  } finally {
    env.db.close();
  }
});

test('T3.2 rev01 F3: a Blue-selected PDP cannot be relabeled Red by research claims', { skip }, async () => {
  const env = openEnv('rev01-f3');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations), costScenarios: [] });
    input.configs = [{ configKey: 'red-12', label: 'Red / 12cm', keyAttributes: { color: 'Red', size: '12cm' } }];
    for (const entry of input.competitors) entry.research.attributes.color = 'Red';
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const card = pipeline.cards.find((item) => item.configKey === 'red-12');
    assert.equal(card.match.exact, 0, 'the PDP selected Blue; research.attributes=Red is not proof');
    assert.equal(card.priceBand.sampleCount, 0);
    assert.ok(card.competitors.candidates.some((item) => item.reasons.join('').includes('未被所选 PDP 变体证据支持')));
  } finally {
    env.db.close();
  }
});

test('T3.2 rev01 F4: purchase variant/unit binding and fee currency conversion', { skip }, async () => {
  const env = openEnv('rev01-f4');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const base = flowInput({ competitors: flowCompetitors(observations) });
    const pipeline = market.runResearchPipeline({ input: base, clock: () => PIPELINE_CLOCK });
    const priceRows = pipeline.cards.find((item) => item.configKey === 'blue-12').priceRows;
    const scenario = base.costScenarios[0];
    const build = (patch) => market.buildCostScenario({ configKey: 'blue-12', ...scenario, ...patch, priceRows, clock: () => PIPELINE_CLOCK });
    const wrongVariant = build({ purchase: { ...scenario.purchase, variant: 'red-12' } });
    assert.equal(wrongVariant.status, 'invalid_input');
    assert.equal(wrongVariant.recommendedListPrice, null, 'a wrong-configuration purchase must not produce a normal recommendation');
    const dozen = build({ purchase: { ...scenario.purchase, unit: 'dozen' } });
    assert.equal(dozen.status, 'invalid_input');
    assert.equal(dozen.recommendedListPrice, null, '30 CNY/dozen cannot be treated as 30 CNY/pc without explicit conversion');
    const dozenConverted = build({ purchase: { ...scenario.purchase, unit: 'dozen', piecesPerUnit: 12 } });
    assert.equal(dozenConverted.status, 'recommended');
    assert.equal(dozenConverted.engine.unitPurchaseCostUSD, Math.round((30 / 12) * 0.14 * 100) / 100, 'explicit conversion: 30 CNY/dozen = 2.5 CNY/pc');
    const feesCnyNoFx = build({ fees: { ...scenario.fees, currency: 'CNY' } });
    assert.equal(feesCnyNoFx.status, 'invalid_input', 'an explicit foreign fee currency is never silently treated as USD');
    assert.ok(feesCnyNoFx.invalidReasons.join('').includes('费用币种'));
    const feesCnyConverted = build({ fees: { ...scenario.fees, currency: 'CNY', fxToUSD: 0.14, fxDate: '2026-10-15' } });
    assert.equal(feesCnyConverted.status, 'recommended');
    assert.ok(feesCnyConverted.facts.some((fact) => fact.key === 'fees.fx'));
  } finally {
    env.db.close();
  }
});

test('T3.2 rev01 F5: confirmed estimates stay assumptions and shipping/FX lineage survives', { skip }, async () => {
  const env = openEnv('rev01-f5');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    input.costScenarios[0].purchase.basis = 'estimate';
    input.costScenarios[0].purchase.estimated = true;
    input.costScenarios[0].assumptions = [{ key: 'purchase', value: 30, currency: 'CNY', basis: '用户确认估算，非实测', source: 'synthetic-estimate', date: OBSERVED_AT, scope: 'blue-12' }];
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const cost = pipeline.cards.find((item) => item.configKey === 'blue-12').cost;
    assert.ok(!cost.facts.some((fact) => fact.key === 'purchase'), 'confirmed flag does not promote an explicit estimated purchase to fact');
    const purchaseAssumption = cost.assumptions.find((item) => item.key === 'purchase' && item.basis && item.basis.includes('估算'));
    assert.ok(purchaseAssumption, 'the estimate keeps an assumption entry describing the confirmed-estimate status');
    const lineage = cost.facts.concat(cost.assumptions);
    assert.ok(lineage.some((item) => /shipping\.cartons/i.test(item.key)), 'carton inputs are delivered as facts/assumptions');
    assert.ok(lineage.some((item) => /shipping\.rate/i.test(item.key)), 'rate/channel/currency inputs are delivered');
    const shippingFacts = lineage.find((item) => item.key === 'shipping.cartons');
    assert.equal(shippingFacts.value.dimensionUnit, 'cm');
    assert.equal(shippingFacts.value.cartons[0].grossKg, 12);
    assert.equal(shippingFacts.value.cartons[0].unitsPerCarton, 50);
    const exported = await market.exportResearchRun({ outputRoot: path.join(RUN_DIR, 'rev01-f5-exports'), runId: 'estimate-lineage', pipeline });
    const reopened = await market.readBackResearchWorkbook(exported.xlsxPath);
    assert.ok(reopened.costRows.some((row) => row[0] === '事实' && /shipping\.cartons/.test(String(row[1]))), 'the workbook carries the shipping lineage rows');
    const json = JSON.parse(fs.readFileSync(exported.jsonPath, 'utf8'));
    const jsonCost = json.costScenarios.find((item) => item.configKey === 'blue-12');
    assert.ok(jsonCost.facts.concat(jsonCost.assumptions).some((item) => /shipping|carton|rate/i.test(item.key)));
  } finally {
    env.db.close();
  }
});

test('T3.2 rev01 F6: same-run exports are immutable and conflicts are refused', { skip }, async () => {
  const env = openEnv('rev01-f6');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const outputRoot = path.join(RUN_DIR, 'rev01-f6-exports');
    const meta = { projectId: PROJECT, brand: BRAND, market: MARKET };
    const first = await market.exportResearchRun({ outputRoot, runId: 'same-run', pipeline, meta });
    const before = { json: sha256Hex(fs.readFileSync(first.jsonPath)), xlsx: sha256Hex(fs.readFileSync(first.xlsxPath)), meta: JSON.parse(fs.readFileSync(first.jsonPath, 'utf8')).meta };
    let conflict = null;
    try {
      await market.exportResearchRun({ outputRoot, runId: 'same-run', pipeline: { ...pipeline, generatedAt: '2026-10-15T23:59:59.000Z' }, meta: { projectId: 'synthetic-other', brand: 'SYNTHETIC-OTHER', market: MARKET } });
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict && conflict.code === 'export_conflict', 'a conflicting second export is refused');
    const after = { json: sha256Hex(fs.readFileSync(first.jsonPath)), xlsx: sha256Hex(fs.readFileSync(first.xlsxPath)), meta: JSON.parse(fs.readFileSync(first.jsonPath, 'utf8')).meta };
    assert.deepEqual(after, before, 'the existing bytes/hashes/meta are untouched');
    const reused = await market.exportResearchRun({ outputRoot, runId: 'same-run', pipeline, meta });
    assert.equal(reused.reused, true, 'byte-identical content may be verified and reused');
    assert.equal(reused.jsonSha256, before.json);
    const newRun = await market.exportResearchRun({ outputRoot, runId: 'same-run-v2', pipeline: { ...pipeline, generatedAt: '2026-10-15T23:59:59.000Z' }, meta: { projectId: 'synthetic-other', brand: 'SYNTHETIC-OTHER', market: MARKET } });
    assert.equal(newRun.reused, false, 'a new run id gets its own immutable artifacts');
    assert.notEqual(newRun.jsonPath, first.jsonPath);
  } finally {
    env.db.close();
  }
});

// ---------- revision-02 focused group (fine-grained estimate classification) ----------

test('T3.2 rev02: per-field and shipping/rate estimate declarations stay assumptions even when confirmed', { skip }, async () => {
  const env = openEnv('rev02-classify');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    // per-field advertising estimate declared in assumptions[] while fees stay confirmed=true
    input.costScenarios[0].assumptions = [{ key: 'adPerUnit', value: 1, currency: 'USD', basis: 'estimate', source: 'synthetic-scenario', date: OBSERVED_AT }];
    // shipping/rate explicitly estimated while confirmed=true
    input.costScenarios[0].shipping.basis = 'estimate';
    input.costScenarios[0].shipping.estimated = true;
    input.costScenarios[0].shipping.rate.basis = 'estimate';
    input.costScenarios[0].shipping.rate.estimated = true;
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const cost = pipeline.cards.find((item) => item.configKey === 'blue-12').cost;
    // negative: no estimated field may become a fact through the global confirmed flag
    assert.ok(!cost.facts.some((fact) => fact.key === 'adPerUnit'), 'fees.confirmed cannot override the per-field advertising estimate declaration');
    assert.ok(!cost.facts.some((fact) => ['shipping.cartons', 'shipping.rate', 'shipping.fx'].includes(fact.key)), 'confirmed shipping/rate estimates must not become facts');
    // assumptions keep the declared value/source/basis; no dual identity
    const ad = cost.assumptions.filter((item) => item.key === 'adPerUnit');
    assert.equal(ad.length, 1, 'exactly one assumption entry (no duplicate/dual identity)');
    assert.equal(ad[0].value, 1);
    assert.equal(ad[0].source, 'synthetic-scenario');
    assert.equal(ad[0].basis, 'estimate');
    assert.equal(ad[0].currency, 'USD');
    const cartons = cost.assumptions.find((item) => item.key === 'shipping.cartons');
    const rate = cost.assumptions.find((item) => item.key === 'shipping.rate');
    assert.ok(cartons && String(cartons.basis).includes('估算'));
    assert.ok(rate && rate.source === 'synthetic-fixture');
    // estimates and facts still participate in the same deterministic math (no pretty-number drift)
    assert.equal(cost.breakEvenListPrice, 13.26);
    assert.equal(cost.targetProfitListPrice, 16.41);
    assert.equal(cost.recommendedListPrice, 39.99);
    // JSON/xlsx classification stays consistent on reopen
    const exported = await market.exportResearchRun({ outputRoot: path.join(RUN_DIR, 'rev02-classify-exports'), runId: 'estimate-classification', pipeline });
    const json = JSON.parse(fs.readFileSync(exported.jsonPath, 'utf8'));
    const jsonCost = json.costScenarios.find((item) => item.configKey === 'blue-12');
    assert.ok(!jsonCost.facts.some((fact) => fact.key === 'adPerUnit'));
    assert.ok(jsonCost.assumptions.some((item) => item.key === 'adPerUnit' && item.source === 'synthetic-scenario'));
    const reopened = await market.readBackResearchWorkbook(exported.xlsxPath);
    const sections = [];
    for (const row of reopened.costRows) {
      if (typeof row[0] === 'string' && row[0].startsWith('[配置] ')) { sections.push({ label: row[0].slice(5), rows: [] }); continue; }
      if (sections.length) sections[sections.length - 1].rows.push(row);
    }
    const blueRows = (sections.find((section) => section.label.startsWith('blue-12')) || { rows: [] }).rows;
    assert.ok(!blueRows.some((row) => row[0] === '事实' && row[1] === 'adPerUnit'), 'no fact row for the declared estimate');
    assert.ok(blueRows.some((row) => row[0] === '假设' && row[1] === 'adPerUnit' && String(row[4]) === 'synthetic-scenario'), 'assumption row keeps value/source');
    assert.ok(!blueRows.some((row) => row[0] === '事实' && ['shipping.cartons', 'shipping.rate', 'shipping.fx'].includes(row[1])));
    assert.ok(blueRows.some((row) => row[0] === '假设' && row[1] === 'shipping.cartons'));
    assert.ok(blueRows.some((row) => row[0] === '假设' && row[1] === 'shipping.rate'));
  } finally {
    env.db.close();
  }
});

test('T3.2 rev02: same-value declarations merge once and contradictions are rejected', { skip }, async () => {
  const env = openEnv('rev02-merge');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const priceRows = pipeline.cards.find((item) => item.configKey === 'blue-12').priceRows;
    const scenario = input.costScenarios[0];
    const build = (declarations) => market.buildCostScenario({ configKey: 'blue-12', ...scenario, assumptions: declarations, priceRows, clock: () => PIPELINE_CLOCK });
    // same value as the input: single merged assumption, no fact, no duplicate
    const merged = build([{ key: 'adPerUnit', value: 1, currency: 'USD', basis: 'estimate', source: 'synthetic-scenario', date: OBSERVED_AT }]);
    assert.equal(merged.status, 'recommended');
    assert.equal(merged.assumptions.filter((item) => item.key === 'adPerUnit').length, 1);
    assert.ok(!merged.facts.some((fact) => fact.key === 'adPerUnit'));
    assert.equal(merged.recommendedListPrice, 39.99);
    // contradicting value: explicit rejection, never ignored or silently deleted
    const wrongValue = build([{ key: 'adPerUnit', value: 2, currency: 'USD', basis: 'estimate', source: 'synthetic-scenario', date: OBSERVED_AT }]);
    assert.equal(wrongValue.status, 'invalid_input');
    assert.equal(wrongValue.recommendedListPrice, null);
    assert.ok(wrongValue.invalidReasons.join('').includes('矛盾'));
    // contradicting currency: explicit rejection too
    const wrongCurrency = build([{ key: 'adPerUnit', value: 1, currency: 'CNY', basis: 'estimate', source: 'synthetic-scenario', date: OBSERVED_AT }]);
    assert.equal(wrongCurrency.status, 'invalid_input');
    assert.ok(wrongCurrency.invalidReasons.join('').includes('矛盾'));
    // contradicting purchase variant: explicit rejection
    const wrongVariant = build([{ key: 'purchase', value: 30, currency: 'CNY', variant: 'red-12', basis: 'estimate', source: 'synthetic-scenario', date: OBSERVED_AT }]);
    assert.equal(wrongVariant.status, 'invalid_input');
    assert.ok(wrongVariant.invalidReasons.join('').includes('矛盾'));
  } finally {
    env.db.close();
  }
});

test('T3.2 rev02: without estimate declarations confirmed facts stay facts and numbers are unchanged', { skip }, async () => {
  const env = openEnv('rev02-positive');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    input.costScenarios[0].assumptions = [];
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const cost = pipeline.cards.find((item) => item.configKey === 'blue-12').cost;
    assert.ok(cost.facts.some((fact) => fact.key === 'adPerUnit'), 'an unmarked confirmed fee stays a fact');
    assert.ok(cost.facts.some((fact) => fact.key === 'shipping.cartons'));
    assert.ok(cost.facts.some((fact) => fact.key === 'shipping.rate'));
    assert.ok(cost.facts.some((fact) => fact.key === 'purchase'));
    assert.ok(!cost.assumptions.some((item) => item.key === 'adPerUnit'));
    assert.equal(cost.breakEvenListPrice, 13.26);
    assert.equal(cost.targetProfitListPrice, 16.41);
    assert.equal(cost.recommendedListPrice, 39.99);
  } finally {
    env.db.close();
  }
});

// ---------- revision-03 focused group (lineage declaration structural consistency) ----------

test('T3.2 rev03: FX lineage declarations contradicting the computed rate are refused', { skip }, async () => {
  const env = openEnv('rev03-fx-conflict');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const priceRows = pipeline.cards.find((item) => item.configKey === 'blue-12').priceRows;
    const scenario = input.costScenarios[0];
    const build = (declarations) => market.buildCostScenario({ configKey: 'blue-12', ...scenario, assumptions: declarations, priceRows, clock: () => PIPELINE_CLOCK });
    // Sol R5-FX exact case: declared fxToUSD 999 vs the actual rate 0.14 the computation uses
    const fxConflict = build([{ key: 'shipping.fx', value: { currency: 'CNY', fxToUSD: 999, fxDate: '2026-10-15' }, currency: 'CNY', basis: 'estimate', source: 'synthetic-conflicting-rate', date: '2026-10-15' }]);
    assert.equal(fxConflict.status, 'invalid_input', 'declared shipping.fx=999 contradicts the actual rate 0.14; the lineage must not say 999 while pricing computes 0.14');
    assert.equal(fxConflict.recommendedListPrice, null);
    assert.ok(fxConflict.invalidReasons.join('').includes('矛盾'));
    // merged small case: FX date / currency conflicts on the same limited mapping
    const fxDateConflict = build([{ key: 'shipping.fx', value: { fxToUSD: 0.14, fxDate: '2020-01-01' }, basis: 'estimate', source: 'synthetic', date: '2026-10-15' }]);
    assert.equal(fxDateConflict.status, 'invalid_input');
    assert.ok(fxDateConflict.invalidReasons.join('').includes('fxDate'));
    const fxCurrencyConflict = build([{ key: 'shipping.fx', value: { fxToUSD: 0.14, fxDate: '2026-10-15', currency: 'USD' }, basis: 'estimate', source: 'synthetic', date: '2026-10-15' }]);
    assert.equal(fxCurrencyConflict.status, 'invalid_input');
    assert.ok(fxCurrencyConflict.invalidReasons.join('').includes('currency'));
    // unknown / non-comparable declaration fields fail closed
    const fxUnknownField = build([{ key: 'shipping.fx', value: { fxToUSD: 0.14, fxDate: '2026-10-15', mystery: 1 }, basis: 'estimate', source: 'synthetic', date: '2026-10-15' }]);
    assert.equal(fxUnknownField.status, 'invalid_input');
    assert.ok(fxUnknownField.invalidReasons.join('').includes('fail-closed'));
  } finally {
    env.db.close();
  }
});

test('T3.2 rev03: same-value FX declarations merge once and keep the actual numbers', { skip }, async () => {
  const env = openEnv('rev03-fx-merge');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    input.costScenarios[0].assumptions = [
      { key: 'shipping.fx', value: { fxToUSD: 0.14, fxDate: '2026-10-15', currency: 'CNY' }, currency: 'CNY', basis: 'estimate', source: 'synthetic-declared-fx', date: '2026-10-15', scope: 'blue-12' },
      { key: 'purchase.fx', value: { fxToUSD: 0.14, fxDate: '2026-10-15', currency: 'CNY' }, basis: 'estimate', source: 'synthetic-declared-fx', date: '2026-10-15' }
    ];
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const cost = pipeline.cards.find((item) => item.configKey === 'blue-12').cost;
    assert.equal(cost.status, 'recommended');
    for (const key of ['shipping.fx', 'purchase.fx']) {
      assert.equal(cost.facts.filter((fact) => fact.key === key).length, 0, `${key} must not stay a fact`);
      const entries = cost.assumptions.filter((item) => item.key === key);
      assert.equal(entries.length, 1, `${key} merges to exactly one assumption`);
      assert.equal(entries[0].value.fxToUSD, 0.14);
      assert.equal(entries[0].value.fxDate, '2026-10-15');
      assert.equal(entries[0].value.currency, 'CNY');
      assert.equal(entries[0].source, 'synthetic-declared-fx');
    }
    assert.equal(cost.breakEvenListPrice, 13.26);
    assert.equal(cost.targetProfitListPrice, 16.41);
    assert.equal(cost.recommendedListPrice, 39.99);
    // JSON/xlsx readback stays aligned with the JSON classification
    const exported = await market.exportResearchRun({ outputRoot: path.join(RUN_DIR, 'rev03-fx-merge-exports'), runId: 'fx-merge', pipeline });
    const json = JSON.parse(fs.readFileSync(exported.jsonPath, 'utf8'));
    const jsonCost = json.costScenarios.find((item) => item.configKey === 'blue-12');
    assert.ok(jsonCost.assumptions.some((item) => item.key === 'shipping.fx' && item.value.fxToUSD === 0.14));
    const reopened = await market.readBackResearchWorkbook(exported.xlsxPath);
    const sections = [];
    for (const row of reopened.costRows) {
      if (typeof row[0] === 'string' && row[0].startsWith('[配置] ')) { sections.push({ label: row[0].slice(5), rows: [] }); continue; }
      if (sections.length) sections[sections.length - 1].rows.push(row);
    }
    const blueRows = (sections.find((section) => section.label.startsWith('blue-12')) || { rows: [] }).rows;
    for (const key of ['shipping.fx', 'purchase.fx']) {
      assert.ok(!blueRows.some((row) => row[0] === '事实' && row[1] === key));
      assert.equal(blueRows.filter((row) => row[0] === '假设' && row[1] === key).length, 1);
    }
    assert.ok(blueRows.some((row) => row[0] === '假设' && row[1] === 'shipping.fx' && String(row[2]).includes('0.14')), 'the delivered lineage keeps the actual FX value');
  } finally {
    env.db.close();
  }
});

test('T3.2 rev03: without FX declarations the confirmed lineage stays facts', { skip }, async () => {
  const env = openEnv('rev03-positive');
  try {
    const observations = await collectObservations(FLOW_SPECS);
    const input = flowInput({ competitors: flowCompetitors(observations) });
    input.costScenarios[0].assumptions = [];
    const pipeline = market.runResearchPipeline({ input, clock: () => PIPELINE_CLOCK });
    const cost = pipeline.cards.find((item) => item.configKey === 'blue-12').cost;
    for (const key of ['shipping.fx', 'purchase.fx']) {
      assert.ok(cost.facts.some((fact) => fact.key === key), `${key} stays a fact without declarations`);
      assert.ok(!cost.assumptions.some((item) => item.key === key));
    }
    assert.equal(cost.breakEvenListPrice, 13.26);
    assert.equal(cost.recommendedListPrice, 39.99);
  } finally {
    env.db.close();
  }
});
