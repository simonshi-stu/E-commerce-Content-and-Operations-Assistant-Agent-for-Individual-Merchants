'use strict';
/**
 * T4.1 CreativeBrief / ShotList / dependency graph tests.
 *
 * Representative chain: two independent synthetic configurations (unbranded robot-dog fixture and
 * a branded goggles fixture) with user-confirmed observations (the real T1.3 evidence chain) and
 * REAL fixture image bytes (hashes computed from the files) → brief/shot list/graph → the real
 * registered handler through the original orchestrator → actual artifact hash + JSON readback +
 * SQLite close/reopen + immutable version snapshots.
 *
 * Risk groups: claim refusals (estimate/rejected/expired/superseded/foreign scope/forbidden/
 * mismatched or unbound copy) with a legal positive; shot/asset rules (missing back angle, wrong
 * SKU, expired asset, MAIN overlay, logo default-off); graph integrity (edges, cycles, orphans,
 * local impact set) and version conflict / history preservation / scope-path guard.
 * All fixtures are synthetic; nothing here contacts a provider, generates media or touches a real
 * product/material file.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const W = path.resolve(__dirname, '..', '..', '..');
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
const assetsModule = require(path.join(W, 'lib', 'commerce', 'assets.js'));
const evidence = require(path.join(W, 'lib', 'commerce', 'evidence.js'));
const passports = require(path.join(W, 'lib', 'commerce', 'passports.js'));
const packs = require(path.join(W, 'lib', 'commerce', 'packs.js'));
const orch = require(path.join(W, 'lib', 'commerce', 'orchestrator.js'));
const { createToolRegistry } = require(path.join(W, 'lib', 'commerce', 'tools-registry.js'));
const creative = require(path.join(W, 'lib', 'commerce', 'creative', 'brief.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T4.1 tests write only to the private runtime tmp';
const RUN_DIR = TMP_ROOT ? fs.mkdtempSync(path.join(TMP_ROOT, 't41-run-')) : null;
const NOW = '2026-10-18T08:00:00.000Z';
const AT = '2026-10-18T07:00:00Z';
const PROJECT = 'proj-t41-a';
const MARKET = 'US';
const DOG_BRAND = '';
const GOGGLE_BRAND = 'SYNTH-GOGGLES';

const CLAIM_TEXTS = Object.freeze({
  'feature.ai_dialog': 'Open AI voice conversation is available',
  'battery.play_time': 'Up to 120 minutes of play time',
  'range.estimated': 'Up to 10 kilometres of range',
  'feature.offline': 'Works fully offline',
  'feature.waterproof': 'IPX8 waterproof',
  'feature.rejected': 'This claim was rejected',
  'feature.pending': 'This claim is still pending',
  'feature.expired': 'This claim has expired',
  'feature.nosource': 'This claim has no source',
  'feature.nolicense': 'This claim has no license',
  'lens.protection': 'UV400 lens protection',
  'frame.material': 'TR90 frame construction'
});

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function openEnv(name) {
  const dir = fs.mkdtempSync(path.join(RUN_DIR, `${name}-`));
  const dbPath = path.join(dir, 'creative.db');
  const db = openDb(dbPath);
  migrateUp(db, migrations);
  return { dir, db, dbPath, workerDir: path.join(dir, 'workdir'), metaRoot: path.join(dir, 'meta'), assetDir: path.join(dir, 'assets') };
}

// ---------- real fixture PNG bytes ----------

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(assetsModule.crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function pngBytes(rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, rgb[0], rgb[1], rgb[2]]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- fixtures ----------

function createConfig(env, { title, family, category, brandKey, skuCode, attributes }) {
  const passport = passports.createPassport(env.db, PROJECT, {
    ...(brandKey === undefined ? {} : { brandKey }),
    productFamilyKey: family,
    category,
    title
  });
  const confirmed = passports.confirmPassport(env.db, PROJECT, passport.id);
  const sku = passports.createSku(env.db, PROJECT, confirmed.id, { skuCode, attributes });
  return { passport: confirmed, sku };
}

function syntheticEvidence(env, seed) {
  return evidence.recordDeclaredEvidence(env.db, PROJECT, {
    sha256: sha256Hex(`synthetic T4.1 fixture ${seed}`),
    sourceType: 'page',
    importBasis: 'synthetic T4.1 fixture (never live)',
    url: 'https://synthetic.example/facts',
    observedAt: AT,
    licenseNote: 'synthetic-only'
  });
}

function addFact(env, { subjectType = 'passport', subjectId, key, value, unit, originType, approvalStatus = 'user_confirmed', evidenceId, observedAt = AT, ttlSeconds }) {
  const input = { subjectType, subjectId, key, value, originType, approvalStatus: 'unreviewed', observedAt };
  if (unit !== undefined) input.unit = unit;
  if (evidenceId !== undefined) input.evidenceId = evidenceId;
  if (ttlSeconds !== undefined) input.ttlSeconds = ttlSeconds;
  const row = evidence.createObservation(env.db, PROJECT, input);
  if (approvalStatus !== 'unreviewed') evidence.setObservationApproval(env.db, PROJECT, row.id, approvalStatus, { now: AT });
  return evidence.getObservation(env.db, PROJECT, row.id);
}

function makeAsset(env, { assetId, file, family, passportId, skuId, angle, rgb, expiresAt, supersededBy, version = 1, designKey = 'design-A' }) {
  fs.mkdirSync(env.assetDir, { recursive: true });
  const abs = path.join(env.assetDir, `${file}.png`);
  fs.writeFileSync(abs, pngBytes(rgb));
  const bytes = fs.readFileSync(abs);
  const parsed = assetsModule.parseImage(bytes);
  assert.equal(parsed.image, true, 'fixture asset is a real decodable PNG');
  assert.equal(parsed.width, 1);
  assert.equal(parsed.height, 1);
  return {
    assetId,
    version,
    sha256: sha256Hex(bytes),
    format: 'png',
    width: parsed.width,
    height: parsed.height,
    familyKey: family,
    passportId,
    skuId,
    designKey,
    angle,
    role: angle === 'front' ? 'main' : 'detail',
    observedAt: AT,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(supersededBy === undefined ? {} : { supersededBy })
  };
}

function assetResolverFor(list) {
  return ({ passportId, skuId, familyKey }) => list.filter((asset) => asset.passportId === passportId && asset.skuId === skuId && asset.familyKey === familyKey);
}

/**
 * One-configuration fixture for the revision-01 defect groups: a single numeric play-time fact
 * (the Sol probe shape), configurable wording authorization, license, design and external-use
 * decision. All data is synthetic and local to the private test tmp.
 */
function setupSingleValue(env, {
  value = 120,
  license = 'synthetic-only',
  skuDesign = 'design-A',
  assetDesign = 'design-A',
  claimTexts = { 'battery.play_time': 'Up to 120 minutes of play time' },
  claimAuthorizations = {},
  externalDecision = 'allow',
  withAsset = true
} = {}) {
  const config = createConfig(env, {
    title: `SYNTHETIC VALUE ${value}`,
    family: `synth-value-${value}-${skuDesign ?? 'none'}`,
    category: 'synthetic-toy',
    skuCode: `SYN-VAL-${value}`,
    attributes: { ...(skuDesign === null ? {} : { designKey: skuDesign }), color: 'synthetic-blue' }
  });
  const source = syntheticEvidence(env, `value-${value}-${license}`);
  const obs = addFact(env, {
    subjectType: 'sku',
    subjectId: config.sku.id,
    key: 'battery.play_time',
    value,
    unit: 'minutes',
    originType: 'pdp_measured',
    evidenceId: source.id
  });
  const assets = withAsset
    ? [makeAsset(env, {
      assetId: `asset-value-${value}`,
      file: `value-${value}`,
      family: config.passport.product_family_key,
      passportId: config.passport.id,
      skuId: config.sku.id,
      angle: 'front',
      rgb: [11, 22, 33],
      designKey: assetDesign
    })]
    : [];
  const externalUse = externalDecision === 'none'
    ? undefined
    : externalDecision === 'deny'
      ? { sources: [{ sourceRef: source.id, allowed: false, basis: 'synthetic fixture explicit deny', scope: { projectId: PROJECT, brand: DOG_BRAND, market: MARKET } }] }
      : { sources: [{ sourceRef: source.id, allowed: true, basis: 'synthetic fixture external-use license', scope: { projectId: PROJECT, brand: DOG_BRAND, market: MARKET } }] };
  const inputFor = (text) => ({
    scope: { projectId: PROJECT, brand: DOG_BRAND, market: MARKET },
    product: { passportId: config.passport.id, skuId: config.sku.id },
    target: {
      channel: 'amazon',
      marketplace: MARKET,
      locale: 'en-US',
      imageRole: 'SUBIMAGE',
      imageIndex: 1,
      sizes: [{ width: 2000, height: 2000 }]
    },
    copy: [{ id: 'headline', kind: 'headline', text, claims: [{ text }] }],
    shots: [{ id: 'front', angle: 'front', assetId: assets.length > 0 ? assets[0].assetId : 'missing-asset', copyIds: ['headline'] }],
    expectedVersion: 0
  });
  return {
    config,
    source,
    obs,
    factResolver: creative.createObservationFactResolver({ db: env.db, claimTexts, claimAuthorizations }),
    assets,
    assetResolver: assetResolverFor(assets),
    externalUse,
    inputFor
  };
}

function setupDog(env) {
  const dog = createConfig(env, {
    title: 'SYNTHETIC ROBOT DOG',
    family: 'synth-robot-dog',
    category: 'synthetic-toy',
    skuCode: 'SYN-DOG-01',
    attributes: { designKey: 'design-A', color: 'graphite', size: 'standard' }
  });
  const source = syntheticEvidence(env, 'dog');
  const passportId = dog.passport.id;
  const ai = addFact(env, { subjectId: passportId, key: 'feature.ai_dialog', value: CLAIM_TEXTS['feature.ai_dialog'], originType: 'user_statement', evidenceId: source.id });
  const play = addFact(env, { subjectId: passportId, key: 'battery.play_time', value: 120, unit: 'minutes', originType: 'pdp_measured', evidenceId: source.id });
  const estimate = addFact(env, { subjectId: passportId, key: 'range.estimated', value: 10, unit: 'kilometres', originType: 'estimate', evidenceId: source.id });
  const pending = addFact(env, { subjectId: passportId, key: 'feature.pending', value: CLAIM_TEXTS['feature.pending'], originType: 'user_statement', approvalStatus: 'unreviewed', evidenceId: source.id });
  const rejected = addFact(env, { subjectId: passportId, key: 'feature.rejected', value: CLAIM_TEXTS['feature.rejected'], originType: 'seller_statement', approvalStatus: 'rejected', evidenceId: source.id });
  const expired = addFact(env, { subjectId: passportId, key: 'feature.expired', value: CLAIM_TEXTS['feature.expired'], originType: 'seller_statement', evidenceId: source.id, observedAt: '2020-01-01T00:00:00Z', ttlSeconds: 60 });
  const noSource = addFact(env, { subjectId: passportId, key: 'feature.nosource', value: CLAIM_TEXTS['feature.nosource'], originType: 'seller_statement' });
  const noLicenseEvidence = evidence.recordDeclaredEvidence(env.db, PROJECT, {
    sha256: sha256Hex('synthetic T4.1 no-license evidence'),
    sourceType: 'page',
    importBasis: 'synthetic T4.1 fixture (never live)',
    url: 'https://synthetic.example/no-license',
    observedAt: AT
  });
  const noLicense = addFact(env, { subjectId: passportId, key: 'feature.nolicense', value: CLAIM_TEXTS['feature.nolicense'], originType: 'seller_statement', evidenceId: noLicenseEvidence.id });
  const waterproof = addFact(env, { subjectId: passportId, key: 'feature.waterproof', value: CLAIM_TEXTS['feature.waterproof'], originType: 'seller_statement', evidenceId: source.id });
  const assets = [
    makeAsset(env, { assetId: 'asset-dog-front', file: 'dog-front', family: dog.passport.product_family_key, passportId, skuId: dog.sku.id, angle: 'front', rgb: [10, 20, 30] }),
    makeAsset(env, { assetId: 'asset-dog-side', file: 'dog-side', family: dog.passport.product_family_key, passportId, skuId: dog.sku.id, angle: 'side', rgb: [40, 50, 60] })
  ];
  return {
    config: dog,
    identity: { passportId, skuId: dog.sku.id },
    facts: { ai, play, estimate, pending, rejected, expired, noSource, noLicense, waterproof },
    factResolver: creative.createObservationFactResolver({ db: env.db, claimTexts: CLAIM_TEXTS }),
    assets,
    assetResolver: assetResolverFor(assets),
    externalUse: {
      sources: [{ sourceRef: source.id, allowed: true, basis: 'synthetic fixture external-use license', scope: { projectId: PROJECT, brand: DOG_BRAND, market: MARKET } }]
    }
  };
}

function setupGoggles(env) {
  const goggles = createConfig(env, {
    title: 'SYNTHETIC SAFETY GOGGLES',
    family: 'synth-safety-goggles',
    category: 'synthetic-eyewear',
    brandKey: GOGGLE_BRAND,
    skuCode: 'SYN-GOG-01',
    attributes: { designKey: 'design-A', lens: 'clear', frame: 'black' }
  });
  const source = syntheticEvidence(env, 'goggles');
  const passportId = goggles.passport.id;
  const lens = addFact(env, { subjectId: passportId, key: 'lens.protection', value: CLAIM_TEXTS['lens.protection'], originType: 'seller_statement', evidenceId: source.id });
  const frame = addFact(env, { subjectId: passportId, key: 'frame.material', value: CLAIM_TEXTS['frame.material'], originType: 'seller_statement', evidenceId: source.id });
  const assets = [
    makeAsset(env, { assetId: 'asset-gog-front', file: 'gog-front', family: goggles.passport.product_family_key, passportId, skuId: goggles.sku.id, angle: 'front', rgb: [70, 80, 90] })
  ];
  return {
    config: goggles,
    facts: { lens, frame },
    factResolver: creative.createObservationFactResolver({ db: env.db, claimTexts: CLAIM_TEXTS }),
    assets,
    assetResolver: assetResolverFor(assets),
    externalUse: {
      sources: [{ sourceRef: source.id, allowed: true, basis: 'synthetic fixture external-use license', scope: { projectId: PROJECT, brand: GOGGLE_BRAND, market: MARKET } }]
    }
  };
}

// ---------- inputs ----------

function dogCopy() {
  const ai = CLAIM_TEXTS['feature.ai_dialog'];
  const play = CLAIM_TEXTS['battery.play_time'];
  return [
    { id: 'headline', kind: 'headline', text: ai, claims: [{ text: ai }] },
    { id: 'bullet-play', kind: 'bullet', text: play, claims: [{ text: play }] },
    { id: 'body', kind: 'body', text: `${ai} ${play}`, claims: [{ text: ai }, { text: play }] },
    { id: 'sub', kind: 'subtitle', text: ai, claims: [{ text: ai }] },
    { id: 'vo', kind: 'voiceover', text: play, claims: [{ text: play }] }
  ];
}

function dogInput(dog, { expectedVersion = 0, copy, shots, logo, forbiddenClaims, rules } = {}) {
  return {
    scope: { projectId: PROJECT, brand: DOG_BRAND, market: MARKET },
    product: { passportId: dog.config.passport.id, skuId: dog.config.sku.id },
    target: {
      channel: 'amazon',
      marketplace: MARKET,
      locale: 'en-US',
      imageRole: 'SUBIMAGE',
      imageIndex: 2,
      sizes: [{ width: 2000, height: 2000 }]
    },
    copy: copy ?? dogCopy(),
    shots: shots ?? [
      { id: 'front', angle: 'front', assetId: 'asset-dog-front', copyIds: ['headline'] },
      { id: 'side', angle: 'side', assetId: 'asset-dog-side', copyIds: ['bullet-play'] }
    ],
    ...(forbiddenClaims === undefined ? {} : { forbiddenClaims }),
    ...(logo === undefined ? {} : { logo }),
    ...(rules === undefined ? {} : {}),
    style: { tone: 'synthetic', instructions: 'synthetic fixture layout constraint' },
    expectedVersion
  };
}

function gogglesCopy() {
  const lens = CLAIM_TEXTS['lens.protection'];
  const frame = CLAIM_TEXTS['frame.material'];
  return [
    { id: 'headline', kind: 'headline', text: lens, claims: [{ text: lens }] },
    { id: 'bullet-frame', kind: 'bullet', text: frame, claims: [{ text: frame }] }
  ];
}

function gogglesInput(goggles, { expectedVersion = 0, copy, shots } = {}) {
  return {
    scope: { projectId: PROJECT, brand: GOGGLE_BRAND, market: MARKET },
    product: { passportId: goggles.config.passport.id, skuId: goggles.config.sku.id },
    target: {
      channel: 'amazon',
      marketplace: MARKET,
      locale: 'en-US',
      imageRole: 'MAIN',
      sizes: [{ width: 2000, height: 2000 }]
    },
    copy: copy ?? gogglesCopy(),
    shots: shots ?? [{ id: 'front', angle: 'front', assetId: 'asset-gog-front', copyIds: [] }],
    expectedVersion
  };
}

function build(env, { input, brand = DOG_BRAND, facts, assets, rules, logoGrant, externalUse, design }) {
  return creative.buildCreativeBrief({
    db: env.db,
    projectId: PROJECT,
    brand,
    market: MARKET,
    input,
    factResolver: facts,
    assetResolver: assets,
    rules,
    logoGrant,
    externalUse,
    design,
    clock: () => NOW
  });
}

async function runOnce(env, { input, brand = DOG_BRAND, facts, assets, rules, logoGrant, externalUse, design }) {
  const registration = creative.createCreativeRegistration({
    domain: { db: env.db, metaRoot: env.metaRoot, clock: () => NOW, factResolver: facts, assetResolver: assets, rules, logoGrant, externalUse, design }
  });
  const registry = createToolRegistry({ roles: orch.ROLES });
  creative.registerCreativeHandler(registry, registration);
  const report = await orch.runOrchestratorOnce(env.db, {
    projectId: PROJECT,
    brand,
    market: MARKET,
    owner: 'synthetic-t4.1',
    ttlSeconds: 120,
    now: NOW,
    clock: () => NOW,
    registry,
    workerDir: env.workerDir,
    inputVersion: 'synthetic-creative-v1',
    plan: {
      schemaVersion: 1,
      taskType: 'creative-brief-plan.v1',
      steps: [{
        id: 'creative',
        role: 'creative',
        tool: creative.CREATIVE_TOOL_NAME,
        input,
        quality: { requireFields: ['brief', 'shotList', 'graph', 'versions'] }
      }]
    }
  });
  const meta = report.run.checkpoint && report.run.checkpoint.orchestrator
    ? report.run.checkpoint.orchestrator.artifacts.creative
    : undefined;
  const artifact = meta ? JSON.parse(fs.readFileSync(path.join(env.workerDir, ...meta.ref.split('/')), 'utf8')) : null;
  return { report, meta, artifact };
}

// ---------- 1. representative chain (two configurations) ----------

test('T4.1 chain: two synthetic configs -> brief/shotlist/graph -> orchestrator -> snapshot + SQL readback', { skip }, async () => {
  const env = openEnv('chain');
  let db = env.db;
  try {
    const dog = setupDog(env);
    const dogRun = await runOnce(env, { input: dogInput(dog), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(dogRun.report.status, 'succeeded');
    assert.ok(dogRun.artifact, 'the real orchestrator wrote the step artifact');
    const dogOut = dogRun.artifact.output;
    assert.equal(dogOut.status, 'planned');
    assert.equal(dogOut.briefVersion, 1);
    assert.equal(dogOut.brief.media.status, 'not_generated', 'plan only: no media is generated');
    assert.equal(dogOut.brief.target.locale, 'en-US');
    assert.equal(dogOut.brief.target.marketplace, 'US');
    assert.equal(dogOut.brief.product.designKey, 'design-A');
    assert.equal(dogOut.brief.product.designSource, 'sku_attributes');
    assert.ok(dogOut.brief.assetVersions.every((asset) => asset.designKey === 'design-A'), 'asset design lineage is preserved');
    assert.equal(dogOut.brief.logo.enabled, false, 'logo layer is off by default');
    assert.equal(dogOut.brief.allowedClaims.length, 2);
    assert.ok(dogOut.brief.facts.filter((fact) => fact.claimable).every((fact) => fact.licenseNote === 'synthetic-only'), 'claimable facts carry the original evidence license');
    const noLicenseSummary = dogOut.brief.facts.find((fact) => fact.field === 'feature.nolicense');
    assert.equal(noLicenseSummary.claimable, false);
    assert.equal(noLicenseSummary.reason, 'fact_license_missing');
    assert.equal(dogOut.brief.imageRules.overlayTextAllowed, true, 'SUBIMAGE style allows overlay copy');
    assert.ok(dogOut.graph.nodes.some((node) => node.id === `fact:${dog.facts.ai.id}`));
    assert.ok(dogOut.graph.edges.some((edge) => edge.from === `fact:${dog.facts.ai.id}` && edge.to === 'copy:headline'));
    assert.equal(sha256Hex(packs.canonicalJson(dogOut)), dogRun.artifact.outputSha256);
    assert.equal(dogRun.meta.sha, dogRun.artifact.outputSha256);
    const identity = dogOut.brief.identity;
    const dogSnap = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    assert.ok(dogSnap);
    assert.equal(dogSnap.document.kind, creative.CREATIVE_SNAPSHOT_KIND);
    assert.equal(dogSnap.document.briefVersion, 1);
    assert.equal(dogSnap.document.graph.edges.length, dogOut.graph.edges.length);
    assert.equal(dogSnap.document.versions.ruleVersion, creative.CREATIVE_RULE_VERSION);
    assert.equal(dogSnap.document.versions.templateVersion, creative.CREATIVE_TEMPLATE_VERSION);
    assert.equal(dogSnap.document.assets.length, 2);
    const dogRow = creative.readCreativeBriefRow(db, PROJECT, dogOut.briefId);
    assert.ok(dogRow);
    assert.equal(dogRow.version, 1);
    assert.equal(dogRow.channel, 'amazon');
    assert.equal(dogRow.locale, 'en-US');
    assert.equal(JSON.parse(dogRow.allowed_claims_json).length, 2);
    assert.deepEqual(JSON.parse(dogRow.size_matrix_json), [{ width: 2000, height: 2000 }]);

    const goggles = setupGoggles(env);
    const gogRun = await runOnce(env, { input: gogglesInput(goggles), brand: GOGGLE_BRAND, facts: goggles.factResolver, assets: goggles.assetResolver, externalUse: goggles.externalUse });
    assert.equal(gogRun.report.status, 'succeeded');
    const gogOut = gogRun.artifact.output;
    assert.equal(gogOut.brief.target.imageRole, 'MAIN');
    assert.equal(gogOut.brief.product.brandKey, GOGGLE_BRAND);
    assert.equal(gogOut.brief.product.designKey, 'design-A');
    assert.equal(gogOut.brief.allowedClaims.length, 2);
    assert.equal(gogOut.brief.imageRules.overlayTextAllowed, false, 'MAIN rules are separated from sub-image style');
    const gogSnap = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity: gogOut.brief.identity, version: 1 });
    assert.ok(gogSnap);
    assert.equal(gogSnap.document.briefVersion, 1);

    // close/reopen: DB rows and immutable snapshots survive
    db.close();
    db = openDb(env.dbPath);
    const dogRow2 = creative.readCreativeBriefRow(db, PROJECT, dogOut.briefId);
    assert.equal(dogRow2.version, 1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM creative_briefs WHERE project_id = ?').get(PROJECT).n;
    assert.equal(count, 2);
    const dogSnap2 = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    assert.equal(dogSnap2.sha256, dogSnap.sha256);
    assert.equal(dogSnap2.document.graph.edges.length, dogSnap.document.graph.edges.length);
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
});

// ---------- 2. claim refusals + legal positive ----------

test('T4.1 claims: estimate/rejected/expired/superseded/foreign/forbidden/mismatch/unbound refused; positive allowed', { skip }, async () => {
  const env = openEnv('claims');
  try {
    const dog = setupDog(env);
    const ai = CLAIM_TEXTS['feature.ai_dialog'];
    const attempt = (copy, overrides = {}) => {
      const input = dogInput(dog, { copy, ...overrides });
      return build(env, { input, facts: overrides.facts ?? dog.factResolver, assets: overrides.assets ?? dog.assetResolver, externalUse: overrides.externalUse ?? dog.externalUse, rules: overrides.rules, logoGrant: overrides.logoGrant });
    };
    const one = (text, factId) => [{ id: 'c1', kind: 'body', text, claims: [{ text, ...(factId === undefined ? {} : { factId }) }] }];

    // a user-confirmed estimate is still an estimate
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['range.estimated'], dog.facts.estimate.id)),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_origin_not_claimable'
    );
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['range.estimated'])),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_origin_not_claimable'
    );
    // rejected fact
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['feature.rejected'])),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_rejected'
    );
    // unreviewed fact -> waiting_input (never invented)
    const pending = attempt(one(CLAIM_TEXTS['feature.pending']));
    assert.equal(pending.status, 'waiting_input');
    assert.match(pending.reason, /^fact_not_approved/);
    // expired fact
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['feature.expired'])),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_expired'
    );
    // missing source chain
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['feature.nosource'])),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_source_missing'
    );
    // missing evidence license
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['feature.nolicense'])),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_license_missing'
    );
    // superseded fact returned by a resolver
    const baseFacts = dog.factResolver({ projectId: PROJECT, brand: DOG_BRAND, market: MARKET, passportId: dog.config.passport.id, skuId: dog.config.sku.id });
    const superseded = {
      ...baseFacts[0],
      id: 'fact-superseded',
      field: 'feature.superseded',
      claimText: 'Superseded claim text',
      supersededBy: 'fact-new'
    };
    const supersededResolver = () => [...baseFacts, superseded];
    assert.throws(
      () => attempt(one('Superseded claim text'), { facts: supersededResolver }),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_superseded'
    );
    // foreign scope fact (a different brand) is refused even if it is otherwise confirmed
    const foreignResolver = () => [{
      id: 'fact-foreign', version: 1, field: 'feature.foreign', claimText: 'Foreign fact claim', value: 'foreign value',
      originType: 'seller_statement', approvalStatus: 'user_confirmed', sourceRef: 'ev-foreign',
      scope: { projectId: PROJECT, brand: GOGGLE_BRAND, market: MARKET, passportId: dog.config.passport.id, skuId: dog.config.sku.id }
    }];
    assert.throws(
      () => attempt(one('Foreign fact claim'), { facts: foreignResolver }),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_scope_mismatch'
    );
    // foreign project fact
    const foreignProjectResolver = () => [{
      ...baseFacts[0], id: 'fact-foreign-project', claimText: 'Foreign project claim',
      scope: { ...baseFacts[0].scope, projectId: 'proj-other' }
    }];
    assert.throws(
      () => attempt(one('Foreign project claim'), { facts: foreignProjectResolver }),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_scope_mismatch'
    );
    // fact bound to a different SKU of the same passport is refused
    const skuMismatchResolver = () => [{
      ...baseFacts[0], id: 'fact-sku-mismatch', claimText: 'SKU mismatch claim',
      scope: { ...baseFacts[0].scope, skuId: 'sku-other' }
    }];
    assert.throws(
      () => attempt(one('SKU mismatch claim'), { facts: skuMismatchResolver }),
      (error) => error instanceof creative.CreativeError && error.code === 'fact_scope_mismatch'
    );
    // a forbidden claim is refused even when a claimable fact exists
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['feature.waterproof']), { rules: { prohibitedClaims: ['IPX8 waterproof'] } }),
      (error) => error instanceof creative.CreativeError && error.code === 'forbidden_claim'
    );
    // an unrelated fact cannot authorize a claim
    assert.throws(
      () => attempt(one(CLAIM_TEXTS['battery.play_time'], dog.facts.ai.id)),
      (error) => error instanceof creative.CreativeError && error.code === 'claim_text_mismatch'
    );
    // body text beyond the bound facts
    assert.throws(
      () => attempt([{ id: 'c1', kind: 'body', text: `${ai} and a bonus claim`, claims: [{ text: ai }] }]),
      (error) => error instanceof creative.CreativeError && error.code === 'copy_text_not_bound'
    );
    // missing fact -> waiting_input (facts are not invented)
    const missing = attempt(one('Speaks English fluently'));
    assert.equal(missing.status, 'waiting_input');
    assert.match(missing.reason, /^fact_missing/);
    // a payload can never add facts or allowlists
    assert.throws(
      () => build(env, { input: { ...dogInput(dog), facts: [] }, facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse }),
      (error) => error instanceof creative.CreativeError && error.code === 'payload_field_not_allowed'
    );
    assert.throws(
      () => build(env, { input: { ...dogInput(dog), allowedClaims: [] }, facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse }),
      (error) => error instanceof creative.CreativeError && error.code === 'payload_field_not_allowed'
    );
    // legal positive
    const ok = attempt(dogCopy());
    assert.equal(ok.status, 'planned');
    assert.equal(ok.plan.brief.allowedClaims.length, 2);
    for (const claim of ok.plan.brief.allowedClaims) assert.match(claim.sourceRef, /^ev_/);
    const estimateSummary = ok.plan.brief.facts.find((fact) => fact.factId === dog.facts.estimate.id);
    assert.equal(estimateSummary.claimable, false);
    assert.equal(estimateSummary.reason, 'fact_origin_not_claimable');
  } finally {
    env.db.close();
  }
});

// ---------- 3. shot / asset / MAIN / logo ----------

test('T4.1 shots: missing back angle waits; wrong SKU/expired refused; MAIN overlay and unlicensed logo refused', { skip }, async () => {
  const env = openEnv('shots');
  try {
    const dog = setupDog(env);
    // no back asset exists -> waiting_input, never an invented back view
    const back = build(env, {
      input: dogInput(dog, { shots: [{ id: 'back', angle: 'back', assetId: 'asset-does-not-exist' }] }),
      facts: dog.factResolver,
      assets: dog.assetResolver, externalUse: dog.externalUse
    });
    assert.equal(back.status, 'waiting_input');
    assert.equal(back.reason, 'angle_unavailable:back');
    // a front asset cannot be relabelled as a back view
    assert.throws(
      () => build(env, {
        input: dogInput(dog, { shots: [{ id: 'back', angle: 'back', assetId: 'asset-dog-front' }] }),
        facts: dog.factResolver,
        assets: dog.assetResolver, externalUse: dog.externalUse
      }),
      (error) => error instanceof creative.CreativeError && error.code === 'asset_angle_mismatch'
    );
    // expired asset
    const expiredAssets = dog.assets.concat([makeAsset(env, {
      assetId: 'asset-dog-expired', file: 'dog-detail-expired', family: dog.config.passport.product_family_key,
      passportId: dog.config.passport.id, skuId: dog.config.sku.id, angle: 'detail', rgb: [1, 2, 3], expiresAt: '2020-01-01T00:00:00Z'
    })]);
    assert.throws(
      () => build(env, {
        input: dogInput(dog, { shots: [{ id: 'detail', angle: 'detail', assetId: 'asset-dog-expired' }] }),
        facts: dog.factResolver,
        assets: assetResolverFor(expiredAssets),
        externalUse: dog.externalUse
      }),
      (error) => error instanceof creative.CreativeError && error.code === 'asset_expired'
    );
    // wrong SKU asset is refused by the resolver contract
    assert.throws(
      () => build(env, {
        input: dogInput(dog),
        facts: dog.factResolver,
        assets: () => [{ ...dog.assets[0], skuId: 'sku-wrong' }],
        externalUse: dog.externalUse
      }),
      (error) => error instanceof creative.CreativeError && error.code === 'asset_scope_mismatch'
    );
    // a requested asset version that is not current is refused
    assert.throws(
      () => build(env, {
        input: dogInput(dog, { shots: [{ id: 'front', angle: 'front', assetId: 'asset-dog-front', assetVersion: 2 }] }),
        facts: dog.factResolver,
        assets: dog.assetResolver, externalUse: dog.externalUse
      }),
      (error) => error instanceof creative.CreativeError && error.code === 'asset_version_conflict'
    );
    // a superseded asset is refused
    const supersededAssets = dog.assets.concat([makeAsset(env, {
      assetId: 'asset-dog-old', file: 'dog-front-old', family: dog.config.passport.product_family_key,
      passportId: dog.config.passport.id, skuId: dog.config.sku.id, angle: 'top', rgb: [9, 9, 9], supersededBy: 'asset-dog-front'
    })]);
    assert.throws(
      () => build(env, {
        input: dogInput(dog, { shots: [{ id: 'top', angle: 'top', assetId: 'asset-dog-old' }] }),
        facts: dog.factResolver,
        assets: assetResolverFor(supersededAssets),
        externalUse: dog.externalUse
      }),
      (error) => error instanceof creative.CreativeError && error.code === 'asset_superseded'
    );
    // MAIN cannot carry overlay copy by default
    const goggles = setupGoggles(env);
    assert.throws(
      () => build(env, {
        input: gogglesInput(goggles, { shots: [{ id: 'front', angle: 'front', assetId: 'asset-gog-front', copyIds: ['headline'] }] }),
        brand: GOGGLE_BRAND,
        facts: goggles.factResolver,
        assets: goggles.assetResolver, externalUse: goggles.externalUse
      }),
      (error) => error instanceof creative.CreativeError && error.code === 'main_image_overlay_not_allowed'
    );
    // an impact-protection claim without a fact is never invented (waiting_input)
    const impact = build(env, {
      input: gogglesInput(goggles, {
        copy: [{ id: 'impact', kind: 'body', text: 'Impact protection', claims: [{ text: 'Impact protection' }] }]
      }),
      brand: GOGGLE_BRAND,
      facts: goggles.factResolver,
      assets: goggles.assetResolver, externalUse: goggles.externalUse
    });
    assert.equal(impact.status, 'waiting_input');
    assert.match(impact.reason, /^fact_missing/);
    // end-to-end waiting_input: the orchestrator writes no artifact and no snapshot
    const waitingRun = await runOnce(env, {
      input: dogInput(dog, { shots: [{ id: 'back', angle: 'back', assetId: 'asset-does-not-exist' }] }),
      facts: dog.factResolver,
      assets: dog.assetResolver, externalUse: dog.externalUse
    });
    assert.equal(waitingRun.report.status, 'waiting_input');
    assert.equal(waitingRun.artifact, null);
    assert.equal(fs.existsSync(path.join(env.metaRoot, 'creative')), false, 'waiting_input never pretends a generated plan/media');
    // logo off by default, refused without a license, allowed with an exact-scope license
    const base = build(env, { input: dogInput(dog), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(base.status, 'planned');
    assert.equal(base.plan.brief.logo.enabled, false);
    assert.ok(!base.plan.graph.nodes.some((node) => node.id === 'layer:logo'));
    assert.throws(
      () => build(env, { input: dogInput(dog, { logo: { enabled: true } }), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse }),
      (error) => error instanceof creative.CreativeError && error.code === 'logo_not_licensed'
    );
    const licensed = build(env, {
      input: dogInput(dog, { logo: { enabled: true } }),
      facts: dog.factResolver,
      assets: dog.assetResolver, externalUse: dog.externalUse,
      logoGrant: { projectId: PROJECT, brand: DOG_BRAND, licenseRef: 'synthetic-logo-license' }
    });
    assert.equal(licensed.status, 'planned');
    assert.equal(licensed.plan.brief.logo.enabled, true);
    assert.equal(licensed.plan.brief.logo.licenseRef, 'synthetic-logo-license');
    assert.ok(licensed.plan.graph.nodes.some((node) => node.id === 'layer:logo'));
    assert.ok(licensed.plan.graph.edges.some((edge) => edge.from === 'layer:logo' && edge.to === 'out:shot:front'));
  } finally {
    env.db.close();
  }
});

// ---------- 4. graph integrity + version history ----------

test('T4.1 graph/version: typed acyclic graph, local impact set, version conflict, immutable history, scope guard', { skip }, async () => {
  const env = openEnv('graph');
  let db = env.db;
  try {
    const dog = setupDog(env);
    const built = build(env, { input: dogInput(dog), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(built.status, 'planned');
    const graph = built.plan.graph;
    assert.equal(creative.validateDependencyGraph(graph).ok, true);
    const aiNode = `fact:${dog.facts.ai.id}`;
    const impact = creative.computeImpact(graph, [aiNode]);
    for (const expected of ['copy:headline', 'copy:body', 'subtitle:sub', 'layer:front:text', 'out:shot:front', 'out:listing', 'out:video']) {
      assert.ok(impact.impacted.includes(expected), `impact set includes ${expected}`);
    }
    for (const untouched of ['copy:bullet-play', 'layer:side:text', 'out:shot:side']) {
      assert.ok(!impact.impacted.includes(untouched), `impact set is local (${untouched} untouched)`);
    }
    // structural refusals
    const node = (id, type, data = {}) => ({ id, type, ref: id, data });
    const cycle = { nodes: [node('layer:a', 'layer'), node('layer:b', 'layer')], edges: [{ from: 'layer:a', to: 'layer:b', kind: 'stack' }, { from: 'layer:b', to: 'layer:a', kind: 'stack' }] };
    assert.ok(creative.validateDependencyGraph(cycle).errors.some((error) => error.code === 'invalid_graph_cycle'));
    const orphan = { nodes: [node('fact:f', 'fact'), node('copy:c', 'copy', { factIds: ['f'] })], edges: [{ from: 'fact:f', to: 'copy:c', kind: 'claim' }] };
    assert.ok(creative.validateDependencyGraph(orphan).errors.some((error) => error.code === 'orphan_node'));
    const dangling = { nodes: [node('fact:f', 'fact')], edges: [{ from: 'fact:f', to: 'copy:missing', kind: 'claim' }] };
    assert.ok(creative.validateDependencyGraph(dangling).errors.some((error) => error.code === 'dangling_edge'));
    const mismatch = { nodes: [node('fact:f', 'fact'), node('out:o', 'output', { kind: 'image' })], edges: [{ from: 'fact:f', to: 'out:o', kind: 'claim' }] };
    assert.ok(creative.validateDependencyGraph(mismatch).errors.some((error) => error.code === 'edge_type_mismatch'));
    const unbound = {
      nodes: [node('fact:f', 'fact'), node('copy:c', 'copy', { factIds: [] }), node('out:o', 'output', { kind: 'image' })],
      edges: [{ from: 'fact:f', to: 'copy:c', kind: 'claim' }, { from: 'copy:c', to: 'out:o', kind: 'publish' }]
    };
    assert.ok(creative.validateDependencyGraph(unbound).errors.some((error) => error.code === 'unbound_claim'));

    // version 1 through the real orchestrator, then a stale expectedVersion is refused
    const first = await runOnce(env, { input: dogInput(dog), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(first.report.status, 'succeeded');
    const identity = first.artifact.output.brief.identity;
    const v1 = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    assert.ok(v1);
    const conflict = await runOnce(env, { input: dogInput(dog, { expectedVersion: 0 }), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(conflict.report.status, 'blocked');
    assert.equal(conflict.artifact, null, 'a refused version writes no artifact');
    const v1AfterConflict = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    assert.equal(v1AfterConflict.sha256, v1.sha256, 'the old version file is never rewritten');
    // version 2 is a new immutable version
    const second = await runOnce(env, { input: dogInput(dog, { expectedVersion: 1 }), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(second.report.status, 'succeeded');
    assert.equal(second.artifact.output.briefVersion, 2);
    const v1Again = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    assert.equal(v1Again.sha256, v1.sha256);
    const v2 = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 2 });
    assert.equal(v2.document.briefVersion, 2);
    const versions = creative.listBriefSnapshots({ metaRoot: env.metaRoot, identity });
    assert.deepEqual(versions.versions.map((entry) => entry.version), [1, 2]);
    assert.equal(versions.currentVersion, 2);
    // exact-scope isolation: another brand has its own chain
    const foreign = creative.listBriefSnapshots({ metaRoot: env.metaRoot, identity: { ...identity, brand: GOGGLE_BRAND } });
    assert.equal(foreign.currentVersion, 0);
    assert.deepEqual(foreign.versions, []);
    // the snapshot root stays inside the real meta root
    const safeDir = creative.snapshotDir({ metaRoot: env.metaRoot, identity });
    assert.ok(safeDir.startsWith(`${fs.realpathSync(env.metaRoot)}${path.sep}`), 'the snapshot directory is confined to the trusted root');
    // a path-traversal scope is refused before any path is built
    assert.throws(
      () => creative.snapshotDir({ metaRoot: env.metaRoot, identity: { ...identity, projectId: '../evil' } }),
      (error) => error instanceof creative.CreativeError && error.code === 'invalid_scope'
    );
    // DB history: two rows, the first unchanged
    db.close();
    db = openDb(env.dbPath);
    const rows = db.prepare('SELECT id, version FROM creative_briefs WHERE project_id = ? ORDER BY version').all(PROJECT);
    assert.deepEqual(rows.map((row) => row.version), [1, 2]);
    assert.equal(rows[0].id, first.artifact.output.briefId);
    assert.equal(rows[1].id, second.artifact.output.briefId);
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
});

// ---------- 5. registration boundary ----------

test('T4.1 registration: real tool contract, closed payload, trusted context authority', { skip }, async () => {
  const env = openEnv('registration');
  try {
    assert.throws(
      () => creative.createCreativeRegistration({ domain: { db: env.db, metaRoot: env.metaRoot, assetResolver: () => [] } }),
      (error) => error instanceof creative.CreativeError && error.code === 'validation'
    );
    const dog = setupDog(env);
    const registration = creative.createCreativeRegistration({
      domain: { db: env.db, metaRoot: env.metaRoot, clock: () => NOW, factResolver: dog.factResolver, assetResolver: dog.assetResolver, externalUse: dog.externalUse }
    });
    assert.equal(registration.tool.name, 'creative-brief-plan.v1');
    assert.equal(registration.tool.kind, 'local');
    assert.deepEqual(registration.tool.roles, ['creative']);
    assert.equal(registration.tool.costPolicy.kind, 'mock_no_charge');
    const registry = createToolRegistry({ roles: orch.ROLES });
    creative.registerCreativeHandler(registry, registration);
    const snapshot = registry.createSnapshot();
    const manifest = snapshot.list().find((tool) => tool.name === creative.CREATIVE_TOOL_NAME);
    assert.ok(manifest);
    assert.match(manifest.contractHash, /^[a-f0-9]{64}$/);
    // a payload can never add a facts/allowedClaims field (schema is closed)
    await assert.rejects(
      snapshot.invoke(creative.CREATIVE_TOOL_NAME, {
        role: 'creative',
        input: { ...dogInput(dog), facts: [] },
        context: { project: PROJECT, brand: DOG_BRAND, market: MARKET, runId: 'run-synthetic' }
      }),
      /not allowed|additional properties|facts/i
    );
    // a payload scope that differs from the trusted context is blocked without any write
    const mismatch = await snapshot.invoke(creative.CREATIVE_TOOL_NAME, {
      role: 'creative',
      input: { ...dogInput(dog), scope: { projectId: PROJECT, brand: GOGGLE_BRAND, market: MARKET } },
      context: { project: PROJECT, brand: DOG_BRAND, market: MARKET, runId: 'run-synthetic' }
    });
    assert.equal(mismatch.status, 'blocked');
    assert.match(mismatch.reason, /scope_authority_mismatch/);
    assert.equal(fs.existsSync(path.join(env.metaRoot, 'creative')), false, 'a refused call writes no snapshot');
    // the trusted context is mandatory
    const noRun = await snapshot.invoke(creative.CREATIVE_TOOL_NAME, {
      role: 'creative',
      input: dogInput(dog),
      context: { project: PROJECT, brand: DOG_BRAND, market: MARKET }
    });
    assert.equal(noRun.status, 'blocked');
    assert.equal(noRun.reason, 'run_id_missing');
    // a real call through the registry persists version 1 and reports the version/snapshot
    const ok = await snapshot.invoke(creative.CREATIVE_TOOL_NAME, {
      role: 'creative',
      input: dogInput(dog),
      context: { project: PROJECT, brand: DOG_BRAND, market: MARKET, runId: 'run-synthetic' }
    });
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.output.briefVersion, 1);
    assert.equal(ok.output.brief.media.status, 'not_generated');
    assert.ok(ok.output.snapshot.sha256.match(/^[a-f0-9]{64}$/));
  } finally {
    env.db.close();
  }
});

// ---------- revision-01 F1: wording authorization ----------

test('T4.1 rev01 F1: approved value/unit binds wording; field-key map cannot promote 5 to 120', { skip }, async () => {
  const TEXT120 = 'Up to 120 minutes of play time';
  const TEXT5 = 'Up to 5 minutes of play time';
  const envs = [];
  const fresh = (name, options) => {
    const env = openEnv(`rev01-f1-${name}`);
    envs.push(env);
    return { env, fx: setupSingleValue(env, options) };
  };
  try {
    // legacy field-key map cannot promote a 5-minute fact to the 120-minute wording
    const legacy = fresh('legacy', { value: 5 });
    const legacyRun = await runOnce(legacy.env, { input: legacy.fx.inputFor(TEXT120), facts: legacy.fx.factResolver, assets: legacy.fx.assetResolver, externalUse: legacy.fx.externalUse });
    assert.equal(legacyRun.report.status, 'waiting_input');
    assert.equal(legacyRun.artifact, null);
    assert.equal(legacy.env.db.prepare('SELECT COUNT(*) AS n FROM creative_briefs').get().n, 0);
    assert.equal(fs.existsSync(path.join(legacy.env.metaRoot, 'creative')), false);

    // per-fact wording grant for the exact 5 value -> real handler succeeds
    const granted = fresh('granted', { value: 5 });
    granted.fx.factResolver = creative.createObservationFactResolver({
      db: granted.env.db,
      claimTexts: { 'battery.play_time': TEXT120 },
      claimAuthorizations: { [granted.fx.obs.id]: { claimText: TEXT5, value: 5, unit: 'minutes' } }
    });
    const grantedRun = await runOnce(granted.env, { input: granted.fx.inputFor(TEXT5), facts: granted.fx.factResolver, assets: granted.fx.assetResolver, externalUse: granted.fx.externalUse });
    assert.equal(grantedRun.report.status, 'succeeded');
    assert.equal(grantedRun.artifact.output.brief.allowedClaims[0].text, TEXT5);
    const grantedSnap = creative.readBriefSnapshot({ metaRoot: granted.env.metaRoot, identity: grantedRun.artifact.output.brief.identity, version: 1 });
    assert.equal(grantedSnap.document.brief.allowedClaims[0].text, TEXT5);
    const grantedRow = creative.readCreativeBriefRow(granted.env.db, PROJECT, grantedRun.artifact.output.briefId);
    assert.ok(JSON.parse(grantedRow.allowed_claims_json).every((claim) => claim.text === TEXT5));

    // closed deterministic template
    const template = fresh('template', { value: 5 });
    template.fx.factResolver = creative.createObservationFactResolver({
      db: template.env.db,
      claimTexts: { 'battery.play_time': TEXT120 },
      claimAuthorizations: { [template.fx.obs.id]: { template: 'Up to {value} {unit} of play time' } }
    });
    const templateBuilt = build(template.env, { input: template.fx.inputFor(TEXT5), facts: template.fx.factResolver, assets: template.fx.assetResolver, externalUse: template.fx.externalUse });
    assert.equal(templateBuilt.status, 'planned');
    assert.equal(templateBuilt.plan.brief.allowedClaims[0].text, TEXT5);

    // a stale authorization (value 120) does not authorize the current 5 fact
    const stale = fresh('stale', { value: 5 });
    stale.fx.factResolver = creative.createObservationFactResolver({
      db: stale.env.db,
      claimTexts: { 'battery.play_time': TEXT120 },
      claimAuthorizations: { [stale.fx.obs.id]: { claimText: TEXT5, value: 120, unit: 'minutes' } }
    });
    const staleBuilt = build(stale.env, { input: stale.fx.inputFor(TEXT5), facts: stale.fx.factResolver, assets: stale.fx.assetResolver, externalUse: stale.fx.externalUse });
    assert.equal(staleBuilt.status, 'waiting_input');

    // a wrong content hash is refused
    const hashMismatch = fresh('hash', { value: 5 });
    hashMismatch.fx.factResolver = creative.createObservationFactResolver({
      db: hashMismatch.env.db,
      claimTexts: { 'battery.play_time': TEXT120 },
      claimAuthorizations: { [hashMismatch.fx.obs.id]: { claimText: TEXT5, contentSha256: '0'.repeat(64) } }
    });
    const hashBuilt = build(hashMismatch.env, { input: hashMismatch.fx.inputFor(TEXT5), facts: hashMismatch.fx.factResolver, assets: hashMismatch.fx.assetResolver, externalUse: hashMismatch.fx.externalUse });
    assert.equal(hashBuilt.status, 'waiting_input');

    // the original approved 120 positive still works (affected chain once)
    const positive = fresh('positive', { value: 120 });
    const positiveBuilt = build(positive.env, { input: positive.fx.inputFor(TEXT120), facts: positive.fx.factResolver, assets: positive.fx.assetResolver, externalUse: positive.fx.externalUse });
    assert.equal(positiveBuilt.status, 'planned');
    assert.equal(positiveBuilt.plan.brief.allowedClaims[0].text, TEXT120);

    // an observation revision gets a NEW fact id and never inherits the old wording
    const revised = fresh('revised', { value: 5 });
    revised.fx.factResolver = creative.createObservationFactResolver({
      db: revised.env.db,
      claimTexts: { 'battery.play_time': TEXT120 },
      claimAuthorizations: { [revised.fx.obs.id]: { claimText: TEXT5, value: 5, unit: 'minutes' } }
    });
    const replacement = evidence.supersedeObservation(revised.env.db, PROJECT, revised.fx.obs.id, {
      value: 7,
      unit: 'minutes',
      originType: 'pdp_measured',
      approvalStatus: 'user_confirmed',
      evidenceId: revised.fx.source.id,
      observedAt: AT
    });
    assert.notEqual(replacement.id, revised.fx.obs.id);
    const revisedBuilt = build(revised.env, { input: revised.fx.inputFor(TEXT5), facts: revised.fx.factResolver, assets: revised.fx.assetResolver, externalUse: revised.fx.externalUse });
    assert.equal(revisedBuilt.status, 'waiting_input');
    const currentFacts = revised.fx.factResolver({ projectId: PROJECT, brand: DOG_BRAND, market: MARKET, passportId: revised.fx.config.passport.id, skuId: revised.fx.config.sku.id });
    assert.ok(!currentFacts.some((fact) => fact.id === revised.fx.obs.id));
  } finally {
    for (const env of envs) {
      try { env.db.close(); } catch { /* already closed */ }
    }
  }
});

// ---------- revision-01 F2: external-use permission ----------

test('T4.1 rev01 F2: license note is audit text, not permission; external use needs an exact factory grant', { skip }, async () => {
  const INTERNAL = 'INTERNAL ONLY. External advertising and publication of this source or its claims is prohibited.';
  const TEXT120 = 'Up to 120 minutes of play time';
  const envs = [];
  const fresh = (name, options) => {
    const env = openEnv(`rev01-f2-${name}`);
    envs.push(env);
    return { env, fx: setupSingleValue(env, options) };
  };
  try {
    // explicit INTERNAL ONLY, no grant: not usable externally, no snapshot/business row
    const internal = fresh('internal', { license: INTERNAL, externalDecision: 'none' });
    const internalRun = await runOnce(internal.env, { input: internal.fx.inputFor(TEXT120), facts: internal.fx.factResolver, assets: internal.fx.assetResolver, externalUse: internal.fx.externalUse });
    assert.equal(internalRun.report.status, 'waiting_input');
    assert.equal(internalRun.artifact, null);
    assert.equal(internal.env.db.prepare('SELECT COUNT(*) AS n FROM creative_briefs').get().n, 0);
    assert.equal(fs.existsSync(path.join(internal.env.metaRoot, 'creative')), false);

    // explicit INTERNAL ONLY + explicit deny -> blocked, no wording
    const denied = fresh('denied', { license: INTERNAL, externalDecision: 'deny' });
    assert.throws(
      () => build(denied.env, { input: denied.fx.inputFor(TEXT120), facts: denied.fx.factResolver, assets: denied.fx.assetResolver, externalUse: denied.fx.externalUse }),
      (error) => error instanceof creative.CreativeError && error.code === 'external_use_denied'
    );

    // a permissive synthetic fixture license + explicit allow -> real handler succeeds
    const allowed = fresh('allowed', { license: 'synthetic-only', externalDecision: 'allow' });
    const allowedRun = await runOnce(allowed.env, { input: allowed.fx.inputFor(TEXT120), facts: allowed.fx.factResolver, assets: allowed.fx.assetResolver, externalUse: allowed.fx.externalUse });
    assert.equal(allowedRun.report.status, 'succeeded');
    const allowedSnap = creative.readBriefSnapshot({ metaRoot: allowed.env.metaRoot, identity: allowedRun.artifact.output.brief.identity, version: 1 });
    const allowedFact = allowedSnap.document.facts.find((fact) => fact.field === 'battery.play_time');
    assert.equal(allowedFact.licenseNote, 'synthetic-only', 'the original license text is preserved');
    assert.equal(allowedFact.externalUse.allowed, true);
    assert.equal(allowedFact.externalUse.basis, 'synthetic fixture external-use license');

    // an explicit deny of a permissive note is also respected
    const denySynthetic = fresh('deny-synthetic', { license: 'synthetic-only', externalDecision: 'deny' });
    assert.throws(
      () => build(denySynthetic.env, { input: denySynthetic.fx.inputFor(TEXT120), facts: denySynthetic.fx.factResolver, assets: denySynthetic.fx.assetResolver, externalUse: denySynthetic.fx.externalUse }),
      (error) => error instanceof creative.CreativeError && error.code === 'external_use_denied'
    );
  } finally {
    for (const env of envs) {
      try { env.db.close(); } catch { /* already closed */ }
    }
  }
});

// ---------- revision-01 F3: design lineage ----------

test('T4.1 rev01 F3: current design must match the SKU/factory contract; mismatch refused, unknown waits', { skip }, async () => {
  const TEXT120 = 'Up to 120 minutes of play time';
  const envs = [];
  const fresh = (name, options) => {
    const env = openEnv(`rev01-f3-${name}`);
    envs.push(env);
    return { env, fx: setupSingleValue(env, { value: 120, ...options }) };
  };
  try {
    // known WRONG design is refused (with external permission so the asset check is reached)
    const wrong = fresh('wrong', { skuDesign: 'design-A', assetDesign: 'design-B', externalDecision: 'allow' });
    assert.throws(
      () => build(wrong.env, { input: wrong.fx.inputFor(TEXT120), facts: wrong.fx.factResolver, assets: wrong.fx.assetResolver, externalUse: wrong.fx.externalUse }),
      (error) => error instanceof creative.CreativeError && error.code === 'asset_design_mismatch'
    );

    // unknown design waits, it is never guessed
    const unknown = fresh('unknown', { skuDesign: null, assetDesign: 'design-A', externalDecision: 'allow' });
    const unknownBuilt = build(unknown.env, { input: unknown.fx.inputFor(TEXT120), facts: unknown.fx.factResolver, assets: unknown.fx.assetResolver, externalUse: unknown.fx.externalUse });
    assert.equal(unknownBuilt.status, 'waiting_input');
    assert.equal(unknownBuilt.reason, 'design_unknown');

    // factory design contract for a SKU without design metadata -> real handler succeeds
    const factory = fresh('factory', { skuDesign: null, assetDesign: 'design-C', externalDecision: 'allow' });
    const designConfig = { projectId: PROJECT, passportId: factory.fx.config.passport.id, skuId: factory.fx.config.sku.id, designKey: 'design-C' };
    const factoryRun = await runOnce(factory.env, { input: factory.fx.inputFor(TEXT120), facts: factory.fx.factResolver, assets: factory.fx.assetResolver, externalUse: factory.fx.externalUse, design: designConfig });
    assert.equal(factoryRun.report.status, 'succeeded');
    const factoryOut = factoryRun.artifact.output;
    assert.equal(factoryOut.brief.product.designKey, 'design-C');
    assert.equal(factoryOut.brief.product.designSource, 'factory_design');
    assert.equal(factoryOut.brief.assetVersions[0].designKey, 'design-C');
    assert.equal(factoryOut.brief.shots[0].asset.designKey, 'design-C');
    const factoryLayer = factoryOut.graph.nodes.find((node) => node.id === 'layer:front:product');
    assert.equal(factoryLayer.data.designKey, 'design-C');

    // SKU design and factory design disagree -> conflict (no silent override)
    const conflict = fresh('conflict', { skuDesign: 'design-A', assetDesign: 'design-A', externalDecision: 'allow' });
    assert.throws(
      () => build(conflict.env, { input: conflict.fx.inputFor(TEXT120), facts: conflict.fx.factResolver, assets: conflict.fx.assetResolver, externalUse: conflict.fx.externalUse, design: { projectId: PROJECT, passportId: conflict.fx.config.passport.id, skuId: conflict.fx.config.sku.id, designKey: 'design-C' } }),
      (error) => error instanceof creative.CreativeError && error.code === 'design_conflict'
    );

    // factory design line + wrong asset design is still refused
    const factoryMismatch = fresh('factory-mismatch', { skuDesign: null, assetDesign: 'design-B', externalDecision: 'allow' });
    assert.throws(
      () => build(factoryMismatch.env, { input: factoryMismatch.fx.inputFor(TEXT120), facts: factoryMismatch.fx.factResolver, assets: factoryMismatch.fx.assetResolver, externalUse: factoryMismatch.fx.externalUse, design: { projectId: PROJECT, passportId: factoryMismatch.fx.config.passport.id, skuId: factoryMismatch.fx.config.sku.id, designKey: 'design-C' } }),
      (error) => error instanceof creative.CreativeError && error.code === 'asset_design_mismatch'
    );
  } finally {
    for (const env of envs) {
      try { env.db.close(); } catch { /* already closed */ }
    }
  }
});

// ---------- revision-01 F4: video depends on its planned shots ----------

test('T4.1 rev01 F4: planned video binds its shots/assets/sequence; unrelated shots do not invalidate it', { skip }, async () => {
  const env = openEnv('rev01-f4');
  let db = env.db;
  try {
    const dog = setupDog(env);
    // default: the planned video uses both planned shots
    const defaultBuilt = build(env, { input: dogInput(dog), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(defaultBuilt.status, 'planned');
    const defaultVideo = defaultBuilt.plan.graph.nodes.find((node) => node.id === 'out:video');
    assert.ok(defaultVideo);
    assert.deepEqual(defaultVideo.data.shotIds, ['front', 'side']);
    assert.ok(defaultBuilt.plan.graph.edges.some((edge) => edge.from === 'layer:front:product' && edge.to === 'out:video'));
    assert.ok(defaultBuilt.plan.graph.edges.some((edge) => edge.from === 'layer:side:product' && edge.to === 'out:video'));
    assert.equal(defaultVideo.data.mediaStatus, 'not_generated');

    // explicit subset: video uses front only, side is unrelated
    const input = { ...dogInput(dog), video: { shotIds: ['front'] } };
    const built = build(env, { input, facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(built.status, 'planned');
    const video = built.plan.graph.nodes.find((node) => node.id === 'out:video');
    assert.deepEqual(video.data.shotIds, ['front']);
    assert.deepEqual(video.data.sourceSha256, [dog.assets[0].sha256]);
    assert.ok(built.plan.graph.edges.some((edge) => edge.from === 'layer:front:product' && edge.to === 'out:video'));
    assert.ok(built.plan.graph.edges.some((edge) => edge.from === 'layer:front:text' && edge.to === 'out:video'));
    assert.ok(!built.plan.graph.edges.some((edge) => edge.from === 'layer:side:product' && edge.to === 'out:video'));
    const frontImpact = creative.computeImpact(built.plan.graph, ['layer:front:product']);
    assert.ok(frontImpact.impacted.includes('out:video'));
    const sideImpact = creative.computeImpact(built.plan.graph, ['layer:side:product']);
    assert.ok(!sideImpact.impacted.includes('out:video'));
    const sideCopyImpact = creative.computeImpact(built.plan.graph, ['copy:bullet-play']);
    assert.ok(!sideCopyImpact.impacted.includes('out:video'));

    // real handler + snapshot readback after a DB close/reopen
    const run = await runOnce(env, { input, facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(run.report.status, 'succeeded');
    const identity = run.artifact.output.brief.identity;
    const snap = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    const snapVideo = snap.document.graph.nodes.find((node) => node.id === 'out:video');
    assert.deepEqual(snapVideo.data.shotIds, ['front']);
    assert.deepEqual(snapVideo.data.sourceSha256, [dog.assets[0].sha256]);
    db.close();
    db = openDb(env.dbPath);
    const row = creative.readCreativeBriefRow(db, PROJECT, run.artifact.output.briefId);
    assert.equal(row.version, 1);
    const snapAgain = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    assert.equal(snapAgain.sha256, snap.sha256);
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
});

// ---------- revision-01 F5: descendant junction must not escape the trusted root ----------

test('T4.1 rev01 F5: a junction below metaRoot never redirects snapshot/head/DB writes', { skip }, async (t) => {
  const env = openEnv('rev01-f5');
  try {
    const dog = setupDog(env);
    const built = build(env, { input: dogInput(dog), facts: dog.factResolver, assets: dog.assetResolver, externalUse: dog.externalUse });
    assert.equal(built.status, 'planned');
    const identity = built.plan.identity;
    fs.mkdirSync(env.metaRoot, { recursive: true });
    const outside = path.join(env.dir, 'outside-meta');
    fs.mkdirSync(outside, { recursive: true });
    const junction = path.join(env.metaRoot, 'creative');
    try {
      fs.symlinkSync(outside, junction, 'junction');
    } catch (error) {
      t.skip(`junction creation is unavailable on this platform: ${error.code}`);
      return;
    }
    assert.throws(
      () => creative.snapshotDir({ metaRoot: env.metaRoot, identity }),
      (error) => error instanceof creative.CreativeError && error.code === 'unsafe_path_reparse'
    );
    assert.throws(
      () => creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 }),
      (error) => error instanceof creative.CreativeError && error.code === 'unsafe_path_reparse'
    );
    assert.throws(
      () => creative.listBriefSnapshots({ metaRoot: env.metaRoot, identity }),
      (error) => error instanceof creative.CreativeError && error.code === 'unsafe_path_reparse'
    );
    const blocked = creative.persistBriefPlan({ metaRoot: env.metaRoot, db: env.db, plan: built.plan, now: NOW });
    assert.deepEqual(blocked, { status: 'blocked', reason: 'unsafe_path_reparse' });
    assert.deepEqual(fs.readdirSync(outside), [], 'zero writes outside the trusted root');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM creative_briefs').get().n, 0, 'zero business rows');
    fs.rmdirSync(junction);
    assert.ok(fs.existsSync(outside), 'removing the junction never removes its target');
    const persisted = creative.persistBriefPlan({ metaRoot: env.metaRoot, db: env.db, plan: built.plan, now: NOW });
    assert.equal(persisted.status, 'persisted');
    assert.equal(persisted.version, 1);
    const snap = creative.readBriefSnapshot({ metaRoot: env.metaRoot, identity, version: 1 });
    assert.ok(snap);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM creative_briefs').get().n, 1);
    assert.deepEqual(fs.readdirSync(outside), [], 'the normal path still writes nothing outside');
  } finally {
    env.db.close();
  }
});
