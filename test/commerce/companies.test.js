'use strict';
/**
 * T3.3 channel company domain tests.
 *
 * Representative chain: synthetic association directory stub HTML (real request construction and
 * deterministic parsing) → two company detail pages → adaptation evidence → conservative dedupe →
 * guarded status persistence → registered handler through the original orchestrator → actual
 * artifact/output hash → SQLite close/reopen (leads/evidence/observations/versions/checkpoint) →
 * exact-scope snapshot readback. Three risk groups: dedupe positive/negative, state/version/scope
 * isolation, request guards/budgets/unknown timeout. All fixtures synthetic; no real outbound.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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
const packs = require(path.join(W, 'lib', 'commerce', 'packs.js'));
const orch = require(path.join(W, 'lib', 'commerce', 'orchestrator.js'));
const store = require(path.join(W, 'lib', 'commerce', 'run-store.js'));
const { createToolRegistry } = require(path.join(W, 'lib', 'commerce', 'tools-registry.js'));
const evidence = require(path.join(W, 'lib', 'commerce', 'evidence.js'));
const { createSyntheticTransport, createPermissionGatedApiTransport } = require(path.join(W, 'lib', 'commerce', 'connectors', 'transport.js'));
const companies = require(path.join(W, 'lib', 'commerce', 'companies.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-test-'));
const skip = false;
const RUN_DIR = fs.mkdtempSync(path.join(TMP_ROOT, 't33-run-'));
const NOW = '2026-10-15T09:00:00.000Z';
const AT = '2026-10-15T08:00:00Z';
const PROJECT = 'proj-t33-a';
const BRAND = 'SYNTHETIC-BRAND';
const MARKET = 'US';
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function sourceRecord(overrides = {}) {
  return companies.validateCompanySourceRegistration(companies.syntheticDirectorySourceRegistration(overrides));
}

function directoryHtml(entries) {
  const items = entries.map((entry) => `<li class="member" data-member-id="${entry.memberId}"><a href="${entry.href}">${entry.name}</a></li>`).join('\n');
  return `<html><head><meta name="x-fixture" content="synthetic"><meta name="x-observed-at" content="${AT}"></head><body><ul id="members">\n${items}\n</ul></body></html>`;
}

function memberHtml({ name, officialSite, address, category, channel, region, contact, legalId, crossReference, includeObserved = true, observedAt = AT }) {
  return `<html><head><meta name="x-fixture" content="synthetic">${includeObserved ? `<meta name="x-observed-at" content="${observedAt}">` : ''}</head><body>
<h1 id="company-name">${name}</h1>
${officialSite ? `<a id="official-site" href="${officialSite}">official</a>` : ''}
<div id="address">${address || ''}</div>
<div id="category">${category || ''}</div>
<div id="channel">${channel || ''}</div>
<div id="region">${region || ''}</div>
${contact ? `<div id="contact-citation">${contact}</div>` : ''}
${legalId ? `<div id="legal-id">${legalId}</div>` : ''}
${crossReference ? `<div id="cross-reference" data-domain="${crossReference}">${crossReference}</div>` : ''}
</body></html>`;
}

function routeFor(html, extra = {}) {
  return { status: 200, headers: {}, body: html, ...extra };
}

function flowInput(overrides = {}) {
  return {
    sourceId: companies.COMPANY_SOURCE_ID,
    scope: { projectId: PROJECT, brand: BRAND, market: MARKET },
    directory: { startUrl: 'https://directory.example.test/directory' },
    profile: { categories: ['helmet'], channels: ['OEM/ODM'], regions: ['Zhejiang'] },
    ...overrides
  };
}

const CHAIN_ROUTES = [
  { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([
    { memberId: 'acme', href: '/members/acme', name: 'ACME Headwear Co., Ltd.' },
    { memberId: 'beta', href: '/members/beta', name: 'BETA Sports Gear Ltd.' }
  ])) },
  { match: (request) => request.path === '/members/acme', ...routeFor(memberHtml({
    name: 'ACME Headwear Co., Ltd.',
    officialSite: 'https://acme.example.test/',
    address: 'No. 8 Industrial Road, Hangzhou, Zhejiang, China',
    category: 'helmets, headwear OEM manufacturing',
    channel: 'OEM/ODM, export',
    region: 'Zhejiang, CN',
    contact: 'Sales office: +86-000-000-0000 (public page text)',
    legalId: '91330000MA2ACME01',
    crossReference: 'acme-global.example.test'
  })) },
  { match: (request) => request.path === '/members/beta', ...routeFor(memberHtml({
    name: 'BETA Sports Gear Ltd.',
    officialSite: 'https://beta.example.test/',
    address: '12 River Road, Dongguan, Guangdong, China',
    category: 'gloves, sports accessories',
    channel: 'retail distribution',
    region: 'Zhejiang, CN',
    includeObserved: false
  })) }
];

function openEnv(name) {
  const dir = fs.mkdtempSync(path.join(RUN_DIR, `${name}-`));
  const db = openDb(path.join(dir, 'companies.db'));
  migrateUp(db, migrations);
  return { dir, db, workerDir: path.join(dir, 'workdir') };
}

async function runCompanyOnce(env, { input, projectId = PROJECT, brand = BRAND, marketCode = MARKET, source = sourceRecord(), routes = CHAIN_ROUTES, fetchImpl }) {
  const synthetic = createSyntheticTransport({ routes });
  const registration = companies.createCompanyRegistration({
    domain: { db: env.db, metaRoot: path.join(env.dir, 'meta'), fetchImpl: fetchImpl || synthetic.fetch, source, clock: () => NOW }
  });
  const registry = createToolRegistry({ roles: orch.ROLES });
  companies.registerCompanyHandler(registry, registration);
  const report = await orch.runOrchestratorOnce(env.db, {
    projectId, brand, market: marketCode, owner: 't33-test', ttlSeconds: 120, now: NOW, clock: () => NOW, registry, workerDir: env.workerDir, inputVersion: 'ui-v1',
    plan: {
      schemaVersion: 1,
      taskType: 'channel-company-discovery.v1',
      steps: [{ id: 'discovery', role: 'channel-development', tool: companies.COMPANY_TOOL_NAME, input, quality: { requireFields: ['companies', 'dedupe', 'snapshot'] } }]
    }
  });
  return { report, synthetic, registry };
}

// ---------- representative chain ----------

test('T3.3 chain: synthetic directory → parsing → dedupe/adaptation → registered handler → artifact hash → SQL reopen → exact-scope snapshot', { skip }, async () => {
  const env = openEnv('chain');
  let closed = false;
  try {
    const { report, synthetic } = await runCompanyOnce(env, { input: flowInput() });
    assert.equal(report.status, 'succeeded');
    const record = report.run.checkpoint.orchestrator.artifacts.discovery;
    const artifactFile = path.join(env.workerDir, ...record.ref.split('/'));
    const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
    assert.equal(sha256Hex(packs.canonicalJson(artifact.output)), record.sha);
    const output = artifact.output;
    assert.equal(synthetic.calls.length, 3, 'directory + two member pages only');
    const acme = output.companies.find((entry) => entry.name === 'ACME Headwear Co., Ltd.');
    const beta = output.companies.find((entry) => entry.name === 'BETA Sports Gear Ltd.');
    assert.ok(acme && beta);
    assert.equal(acme.status, 'qualified');
    assert.equal(acme.administrativeVersion, 3);
    assert.equal(acme.administrativeStatus, 'qualified');
    assert.equal(acme.scopeStatusVersion, 1);
    assert.deepEqual(acme.adaptation.matchedDimensions, ['category', 'channel', 'region']);
    assert.deepEqual(acme.adaptation.unknownTimeDimensions, []);
    assert.deepEqual(acme.adaptation.negatedDimensions, []);
    assert.equal(acme.provenanceCount, 2, 'member detail + directory index provenance');
    assert.equal(beta.status, 'discovered', 'a directory hit with unknown-time claims never auto-qualifies');
    assert.equal(beta.administrativeVersion, 1);
    assert.deepEqual(beta.adaptation.unknownTimeDimensions, ['region']);
    assert.equal(output.dedupe.entityCount, 2);
    assert.ok(output.snapshot.path.startsWith(path.join(env.dir, 'meta')));
    assert.equal(sha256Hex(fs.readFileSync(output.snapshot.path)), output.snapshot.sha256);
    assert.equal(output.versions.sourceId, companies.COMPANY_SOURCE_ID);
    assert.equal(output.versions.sourceVersion, 'synthetic.directory-1');
    // snapshot exact-scope readback
    const manifest = companies.readCompanySnapshot({ metaRoot: path.join(env.dir, 'meta'), runId: report.run.id, projectId: PROJECT, brand: BRAND, market: MARKET });
    assert.equal(manifest.kind, 't3.3_company_snapshot');
    assert.equal(manifest.entities.length, 2);
    assert.equal(manifest.sourceId, companies.COMPANY_SOURCE_ID);
    // SQL reopen: leads/evidence/observations/versions/checkpoint
    env.db.close();
    closed = true;
    const reopenedDb = openDb(path.join(env.dir, 'companies.db'));
    try {
      const run = store.getRun(reopenedDb, PROJECT, report.run.id);
      assert.equal(run.status, 'succeeded');
      assert.equal(run.checkpoint.orchestrator.artifacts.discovery.sha, record.sha);
      const acmeLead = reopenedDb.prepare('SELECT * FROM company_leads WHERE project_id = ? AND domain = ?').get(PROJECT, 'acme.example.test');
      assert.equal(acmeLead.status, 'qualified');
      assert.equal(acmeLead.version, 3);
      const betaLead = reopenedDb.prepare('SELECT * FROM company_leads WHERE project_id = ? AND domain = ?').get(PROJECT, 'beta.example.test');
      assert.equal(betaLead.status, 'discovered');
      assert.equal(betaLead.version, 1);
      const evidenceRows = evidence.listEvidence(reopenedDb, PROJECT);
      assert.equal(evidenceRows.length, 3, 'directory + two member page captures');
      assert.ok(evidenceRows.every((row) => row.source_type === 'page'));
      const acmeObservations = evidence.listObservations(reopenedDb, PROJECT, { subjectId: acmeLead.id });
      const keys = acmeObservations.map((row) => row.key).sort();
      assert.deepEqual(keys, ['adaptation.category', 'adaptation.channel', 'adaptation.region', 'contact.citation', 'status.transition', 'status.transition']);
      for (const observation of acmeObservations.filter((row) => row.key.startsWith('adaptation.') || row.key === 'contact.citation')) {
        const linked = evidence.getEvidence(reopenedDb, PROJECT, observation.evidence_id);
        assert.ok(linked, 'every adaptation judgment reopens its evidence');
        assert.equal(linked.url.startsWith('https://directory.example.test/'), true);
      }
      const citation = acmeObservations.find((row) => row.key === 'contact.citation');
      assert.ok(citation.value_text.startsWith('source_cited (not verified):'));
      const transitions = acmeObservations.filter((row) => row.key === 'status.transition').map((row) => JSON.parse(row.value_text));
      assert.deepEqual(transitions.map((entry) => entry.to).sort(), ['qualified', 'screened']);
      assert.ok(transitions.every((entry) => entry.evidenceRefs.length > 0));
    } finally {
      reopenedDb.close();
    }
  } finally {
    if (!closed) env.db.close();
  }
});

// ---------- risk group 1: dedupe ----------

test('T3.3 group1 dedupe: multi-source merge, name-only refusal, proof-based cross-domain merge, eTLD+1 non-collapse, determinism', { skip }, async () => {
  const env = openEnv('dedupe');
  try {
    const routes = [
      { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([
        { memberId: 'acme', href: '/members/acme', name: 'ACME Headwear Co., Ltd.' },
        { memberId: 'acme-dup', href: '/members/acme-dup', name: 'ACME Headwear Co., Ltd.' },
        { memberId: 'gamma', href: '/members/gamma', name: 'ACME Headwear Co., Ltd.' },
        { memberId: 'delta', href: '/members/delta', name: 'ACME Headwear Co., Ltd.' },
        { memberId: 'epsilon', href: '/members/epsilon', name: 'ACME Global Trading Ltd.' },
        { memberId: 'theta', href: '/members/theta', name: 'Theta Trading Ltd.' },
        { memberId: 'iota', href: '/members/iota', name: 'Iota Trading Ltd.' }
      ])) },
      { match: (request) => request.path === '/members/acme', ...routeFor(memberHtml({
        name: 'ACME Headwear Co., Ltd.', officialSite: 'https://acme.example.test/', address: 'No. 8 Industrial Road, Hangzhou, Zhejiang, China',
        category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang', legalId: '91330000MA2ACME01'
      })) },
      { match: (request) => request.path === '/members/acme-dup', ...routeFor(memberHtml({
        name: 'ACME Headwear Co., Ltd.', officialSite: 'HTTPS://WWW.ACME.EXAMPLE.TEST/', address: 'No. 8 Industrial Road, Hangzhou, Zhejiang, China',
        category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang', legalId: '91330000MA2ACME01'
      })) },
      { match: (request) => request.path === '/members/gamma', ...routeFor(memberHtml({
        name: 'ACME Headwear Co., Ltd.', officialSite: 'https://acme-shenzhen.example.test/', address: 'No. 99 Coast Road, Shenzhen, Guangdong, China',
        category: 'helmets', channel: 'OEM/ODM', region: 'Guangdong', legalId: '91440300MA2ACME02'
      })) },
      { match: (request) => request.path === '/members/delta', ...routeFor(memberHtml({
        name: 'ACME Headwear Co., Ltd.', officialSite: 'https://acme-global.example.test/', address: 'No. 8 Industrial Road, Hangzhou, Zhejiang, China',
        category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang', crossReference: 'acme.example.test'
      })) },
      { match: (request) => request.path === '/members/epsilon', ...routeFor(memberHtml({
        name: 'ACME Global Trading Ltd.', officialSite: 'https://acme-trading.example.test/', address: 'No. 8 Industrial Road, Hangzhou, Zhejiang, China',
        category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang', legalId: '91330000MA2ACME01'
      })) },
      { match: (request) => request.path === '/members/theta', ...routeFor(memberHtml({
        name: 'Theta Trading Ltd.', officialSite: 'https://theta.example.co.uk/', address: '1 High Street, London, UK',
        category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang'
      })) },
      { match: (request) => request.path === '/members/iota', ...routeFor(memberHtml({
        name: 'Iota Trading Ltd.', officialSite: 'https://iota.example.co.uk/', address: '2 High Street, London, UK',
        category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang'
      })) }
    ];
    const source = sourceRecord();
    const synthetic = createSyntheticTransport({ routes });
    const transport = createPermissionGatedApiTransport({ source, fetchImpl: synthetic.fetch, capability: 'fixture', now: () => NOW });
    const input = flowInput();
    const first = await companies.discoverCompanies({ source, transport, input, clock: () => NOW });
    assert.equal(first.status, 'ok');
    // merged entity keys are the deterministic minimum roots; look entities up by domain instead
    assert.equal(first.entities.length, 4, 'acme merged entity + acme-shenzhen + theta + iota');
    const acme = first.entities.find((entity) => entity.domains.includes('acme.example.test'));
    assert.ok(acme, 'the acme entity exists');
    assert.deepEqual(acme.domains, ['acme-global.example.test', 'acme-trading.example.test', 'acme.example.test']);
    assert.ok(acme.provenance.length >= 5, 'every source keeps its provenance');
    assert.ok(first.dedupe.merges.some((merge) => merge.proof === 'official_cross_reference'));
    assert.ok(first.dedupe.merges.some((merge) => merge.proof === 'legal_identity'));
    // same-name different legal entity: never merged, reported as suspected
    const gamma = first.entities.find((entity) => entity.domains.includes('acme-shenzhen.example.test'));
    assert.ok(gamma, 'the same-name Shenzhen company stays its own entity');
    assert.ok(first.dedupe.suspected.some((pair) => pair.reason === 'same_name_no_identity_proof' && (pair.left + pair.right).includes('acme-shenzhen.example.test')));
    // eTLD+1 is never collapsed: the two example.co.uk hosts stay distinct
    const theta = first.entities.find((entity) => entity.domains.includes('theta.example.co.uk'));
    const iota = first.entities.find((entity) => entity.domains.includes('iota.example.co.uk'));
    assert.ok(theta && iota, 'the two example.co.uk companies stay distinct');
    assert.equal(first.dedupe.suspected.filter((pair) => (pair.left + pair.right).includes('theta')).length, 0);
    // normalization: IDNA/case/www are limited, full host is the key
    assert.equal(companies.normalizeDomainValue('https://BÜCHER.example.test/').normalizedHost, 'xn--bcher-kva.example.test');
    assert.equal(companies.normalizeDomainValue('HTTPS://WWW.ACME.EXAMPLE.TEST').normalizedHost, 'acme.example.test');
    assert.equal(companies.normalizeDomainValue('https://a.example.co.uk').normalizedHost, 'a.example.co.uk');
    // determinism: identical input + clock produce identical entities
    const second = await companies.discoverCompanies({ source, transport: createPermissionGatedApiTransport({ source, fetchImpl: createSyntheticTransport({ routes }).fetch, capability: 'fixture', now: () => NOW }), input, clock: () => NOW });
    assert.deepEqual(second.entities, first.entities);
    assert.deepEqual(second.dedupe, first.dedupe);
  } finally {
    env.db.close();
  }
});

// ---------- risk group 2: state machine, versions, isolation ----------

test('T3.3 group2 state machine: guarded transitions, version conflicts, rejected evidence, unknown-time needs_review', { skip }, async () => {
  const env = openEnv('state');
  try {
    const entity = {
      entityKey: 'host:acme.example.test', name: 'ACME Headwear Co., Ltd.', nameVariants: ['ACME Headwear Co., Ltd.'],
      domains: ['acme.example.test'], addresses: ['No. 8 Industrial Road, Hangzhou, Zhejiang, China'], legalIds: [], crossReferences: [],
      officialSites: [], contactCitations: [], provenance: [], records: [], claims: [], manual: false
    };
    const { lead } = companies.upsertCompanyLead(env.db, PROJECT, entity, { clock: () => NOW });
    const leadId = lead.id;
    // illegal skip: discovered → qualified directly
    let result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 1, toStatus: 'qualified', reason: 'skip', requiredDimensions: ['category'], clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_transition');
    // missing evidence
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 1, toStatus: 'screened', reason: 'no evidence', clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'evidence_missing');
    // unknown-time positive determination is refused as needs_review
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 1, toStatus: 'screened', reason: 'unknown time', unknownTimeClaims: ['region'], clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'needs_review_time_unknown');
    // stale expectedVersion
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 2, toStatus: 'screened', reason: 'stale', clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'version_conflict');
    // real evidence: a page capture plus an adaptation observation
    const pageEvidence = companies.persistPageEvidence(env.db, PROJECT, { url: 'https://directory.example.test/members/acme', sha256: sha256Hex('page-acme'), observedAt: AT, timeKnown: true }, sourceRecord());
    const observation = companies.recordAdaptationObservation(env.db, PROJECT, { leadId, dimension: 'category', claimText: 'helmets', evidenceId: pageEvidence.id, observedAt: AT });
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 1, toStatus: 'screened', reason: 'category evidenced', dimensions: [{ dimension: 'category', observationId: observation.id }], requiredDimensions: ['category'], clock: () => NOW });
    assert.equal(result.ok, true);
    assert.equal(result.lead.version, 2);
    assert.equal(result.lead.status, 'screened');
    // qualified requires ALL required dimensions
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 2, toStatus: 'qualified', reason: 'partial', dimensions: [{ dimension: 'category', observationId: observation.id }], requiredDimensions: ['category', 'channel'], clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'evidence_missing');
    // rejected evidence is refused
    const channelObservation = companies.recordAdaptationObservation(env.db, PROJECT, { leadId, dimension: 'channel', claimText: 'OEM/ODM', evidenceId: pageEvidence.id, observedAt: AT });
    evidence.setObservationApproval(env.db, PROJECT, channelObservation.id, 'rejected');
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 2, toStatus: 'qualified', reason: 'rejected', dimensions: [{ dimension: 'category', observationId: observation.id }, { dimension: 'channel', observationId: channelObservation.id }], requiredDimensions: ['category', 'channel'], clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'evidence_invalid');
    // rollback is refused once qualified
    const accepted = companies.recordAdaptationObservation(env.db, PROJECT, { leadId, dimension: 'channel', claimText: 'OEM/ODM export', evidenceId: pageEvidence.id, observedAt: AT });
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 2, toStatus: 'qualified', reason: 'all dimensions', dimensions: [{ dimension: 'category', observationId: observation.id }, { dimension: 'channel', observationId: accepted.id }], requiredDimensions: ['category', 'channel'], clock: () => NOW });
    assert.equal(result.ok, true);
    assert.equal(result.lead.version, 3);
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 3, toStatus: 'screened', reason: 'rollback', clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_transition');
    // contact_candidate needs the contact citation; then it succeeds with one
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 3, toStatus: 'contact_candidate', reason: 'no citation', dimensions: [{ dimension: 'category', observationId: observation.id }], clock: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'evidence_missing');
    const citation = companies.recordContactCitation(env.db, PROJECT, { leadId, citationText: 'Sales office: +86-000-000-0000', evidenceId: pageEvidence.id, observedAt: AT });
    result = companies.transitionCompanyLead(env.db, PROJECT, { leadId, expectedVersion: 3, toStatus: 'contact_candidate', reason: 'citation on file', dimensions: [{ dimension: 'category', observationId: observation.id }, { dimension: 'contact_citation', observationId: citation.id }], clock: () => NOW });
    assert.equal(result.ok, true);
    assert.equal(result.lead.status, 'contact_candidate');
    const audits = evidence.listObservations(env.db, PROJECT, { subjectId: leadId, key: 'status.transition' });
    assert.equal(audits.length, 3);
  } finally {
    env.db.close();
  }
});

test('T3.3 group2 isolation: foreign manual record, handler scope/source guards, exact brand snapshot scope', { skip }, async () => {
  const env = openEnv('isolation');
  try {
    const source = sourceRecord();
    const routes = [{ match: (request) => request.path === '/directory', ...routeFor(directoryHtml([{ memberId: 'acme', href: '/members/acme', name: 'ACME Headwear Co., Ltd.' }])) }];
    // foreign-scope manual record fails closed in the public pipeline
    const foreign = flowInput({ manualRecords: [{ name: 'Foreign Ltd.', scope: { projectId: PROJECT, brand: 'OTHER-BRAND', market: MARKET } }] });
    const synthetic = createSyntheticTransport({ routes });
    const transport = createPermissionGatedApiTransport({ source, fetchImpl: synthetic.fetch, capability: 'fixture', now: () => NOW });
    await assert.rejects(() => companies.discoverCompanies({ source, transport, input: foreign, clock: () => NOW }), (error) => error.code === 'record_domain_mismatch');
    // handler: scope mismatch and untrusted source are blocked with zero network
    const badScope = flowInput({ scope: { projectId: PROJECT, brand: 'OTHER-BRAND', market: MARKET } });
    const first = await runCompanyOnce(env, { input: badScope, routes });
    assert.notEqual(first.report.status, 'succeeded');
    assert.equal(first.synthetic.calls.length, 0);
    const badSource = flowInput({ sourceId: 'some-other-source.v1' });
    const second = await runCompanyOnce(env, { input: badSource, routes });
    assert.notEqual(second.report.status, 'succeeded');
    assert.equal(second.synthetic.calls.length, 0);
    // snapshot exact-scope isolation: brand A is never read as brand B (empty brand is a value)
    const metaRoot = path.join(env.dir, 'meta');
    const minimalResult = { entities: [], dedupe: { merges: [], suspected: [] }, refusals: [], requests: { total: 0, decisions: [] }, pages: [] };
    const written = await companies.writeCompanySnapshot({ metaRoot, runId: 'run-a', projectId: PROJECT, brand: '', market: MARKET, result: minimalResult, source, rules: companies.DEFAULT_COMPANY_RULES, clock: () => NOW });
    assert.ok(written.path.includes(`b_${companies.scopeToken('')}`));
    assert.ok(companies.readCompanySnapshot({ metaRoot, runId: 'run-a', projectId: PROJECT, brand: '', market: MARKET }));
    assert.equal(companies.readCompanySnapshot({ metaRoot, runId: 'run-a', projectId: PROJECT, brand: 'X', market: MARKET }), null);
    // tampered manifest scope fails closed
    const manifest = JSON.parse(fs.readFileSync(written.path, 'utf8'));
    manifest.brand = 'X';
    fs.writeFileSync(written.path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assert.throws(() => companies.readCompanySnapshot({ metaRoot, runId: 'run-a', projectId: PROJECT, brand: '', market: MARKET }), (error) => error.code === 'snapshot_scope_mismatch');
  } finally {
    env.db.close();
  }
});

// ---------- risk group 3: request guards, budgets, unknown timeout ----------

test('T3.3 group3 request guards: https/private/credentials/path refusals, link refusal, redirect refusal, permit gates, budgets, retry/timeout safety', { skip }, async () => {
  const env = openEnv('guards');
  try {
    const source = sourceRecord();
    // URL guard (reused T3.1 helpers): https only, no credentials/private hosts/ports, registered paths
    assert.throws(() => companies.assertCompanyRequestUrl('http://directory.example.test/directory', source), (error) => error.code === 'url_protocol_not_allowed');
    assert.throws(() => companies.assertCompanyRequestUrl('https://user:pass@directory.example.test/directory', source), (error) => error.code === 'url_credentials_not_allowed');
    assert.throws(() => companies.assertCompanyRequestUrl('https://127.0.0.1/directory', source), (error) => error.code === 'url_host_denied_private');
    assert.throws(() => companies.assertCompanyRequestUrl('https://directory.example.test:8443/directory', source), (error) => error.code === 'url_port_not_allowed');
    assert.throws(() => companies.assertCompanyRequestUrl('https://directory.example.test/other', source), (error) => error.code === 'url_path_not_allowed');
    assert.throws(() => companies.buildMemberRequest(source, '../evil'), (error) => error.code === 'member_slug_invalid');
    // source contract: unknown use / unknown field refused
    assert.throws(() => companies.validateCompanySourceRegistration(companies.syntheticDirectorySourceRegistration({ allowedUses: ['price_observation'] })), (error) => error.code === 'registration_invalid');
    assert.throws(() => companies.validateCompanySourceRegistration({ ...companies.syntheticDirectorySourceRegistration(), mystery: true }), (error) => error.code === 'registration_invalid');
    // malicious directory links are refused and never fetched
    const linkRoutes = [
      { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([
        { memberId: 'js', href: 'javascript:alert(1)', name: 'Evil JS' },
        { memberId: 'ext', href: 'https://evil.example.test/members/ext', name: 'External' },
        { memberId: 'out', href: '/other/out', name: 'Outside path' },
        { memberId: 'acme', href: '/members/acme', name: 'ACME Headwear Co., Ltd.' }
      ])) },
      { match: (request) => request.path === '/members/acme', ...routeFor(memberHtml({ name: 'ACME Headwear Co., Ltd.', officialSite: 'https://acme.example.test/', category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang' })) }
    ];
    const linkSynthetic = createSyntheticTransport({ routes: linkRoutes });
    const linkTransport = createPermissionGatedApiTransport({ source, fetchImpl: linkSynthetic.fetch, capability: 'fixture', now: () => NOW });
    const linkResult = await companies.discoverCompanies({ source, transport: linkTransport, input: flowInput(), clock: () => NOW });
    assert.equal(linkResult.status, 'ok');
    assert.equal(linkSynthetic.calls.length, 2, 'only /directory and the one valid member page are fetched');
    assert.ok(linkResult.refusals.some((refusal) => refusal.code === 'url_protocol_not_allowed' && refusal.memberId === 'js'));
    assert.ok(linkResult.refusals.some((refusal) => refusal.code === 'url_host_not_allowed' && refusal.memberId === 'ext'));
    assert.ok(linkResult.refusals.some((refusal) => refusal.code === 'url_path_not_allowed' && refusal.memberId === 'out'));
    // redirects that change the target are refused (never followed)
    const redirectFetch = async (request) => ({ status: 200, headers: {}, body: memberHtml({ name: 'Redir Ltd.', category: 'helmets' }), finalUrl: 'https://evil.example.test/members/redir' });
    const redirectSynthetic = createSyntheticTransport({ routes: [{ match: (r) => r.path === '/directory', ...routeFor(directoryHtml([{ memberId: 'redir', href: '/members/redir', name: 'Redir Ltd.' }])) }] });
    let redirectCalls = 0;
    const redirectImpl = async (request) => { redirectCalls += 1; return request.path === '/directory' ? redirectSynthetic.fetch(request) : redirectFetch(request); };
    const redirectTransport = createPermissionGatedApiTransport({ source, fetchImpl: redirectImpl, capability: 'fixture', now: () => NOW });
    const redirectResult = await companies.discoverCompanies({ source, transport: redirectTransport, input: flowInput(), clock: () => NOW });
    assert.equal(redirectResult.status, 'ok');
    assert.ok(redirectResult.refusals.some((refusal) => refusal.code === 'redirect_cross_host'));
    assert.equal(redirectResult.entities.length, 0);
    // 3xx is not followed either
    const statusFetch = async (request) => (request.path === '/directory'
      ? directoryHtmlResponse(request)
      : { status: 302, headers: { location: 'https://evil.example.test/x' }, body: '' });
    function directoryHtmlResponse() { return routeFor(directoryHtml([{ memberId: 'redir', href: '/members/redir', name: 'Redir Ltd.' }])); }
    const statusTransport = createPermissionGatedApiTransport({ source, fetchImpl: statusFetch, capability: 'fixture', now: () => NOW });
    const statusResult = await companies.discoverCompanies({ source, transport: statusTransport, input: flowInput(), clock: () => NOW });
    assert.ok(statusResult.refusals.some((refusal) => refusal.code === 'member_page_unavailable' && refusal.detail === 'http_302'));
    // execution grant × capability double gate: fixture disabled → blocked with zero calls
    const noFixture = sourceRecord({ permit: { execution: { fixture: false, manual: true, live: false } } });
    const noFixtureSynthetic = createSyntheticTransport({ routes: linkRoutes });
    const noFixtureTransport = createPermissionGatedApiTransport({ source: noFixture, fetchImpl: noFixtureSynthetic.fetch, capability: 'fixture', now: () => NOW });
    const noFixtureResult = await companies.discoverCompanies({ source: noFixture, transport: noFixtureTransport, input: flowInput(), clock: () => NOW });
    assert.equal(noFixtureResult.status, 'blocked');
    assert.equal(noFixtureResult.code, 'execution_not_authorized_fixture');
    assert.equal(noFixtureSynthetic.calls.length, 0);
    // pending permit → blocked with zero calls
    const pending = sourceRecord({ permit: { approvalStatus: 'pending' } });
    const pendingSynthetic = createSyntheticTransport({ routes: linkRoutes });
    const pendingTransport = createPermissionGatedApiTransport({ source: pending, fetchImpl: pendingSynthetic.fetch, capability: 'fixture', now: () => NOW });
    const pendingResult = await companies.discoverCompanies({ source: pending, transport: pendingTransport, input: flowInput(), clock: () => NOW });
    assert.equal(pendingResult.status, 'blocked');
    assert.equal(pendingResult.code, 'permit_pending');
    assert.equal(pendingSynthetic.calls.length, 0);
    // request budget: only one request allowed
    const budgetSynthetic = createSyntheticTransport({ routes: linkRoutes });
    const budgetTransport = createPermissionGatedApiTransport({ source, fetchImpl: budgetSynthetic.fetch, capability: 'fixture', now: () => NOW });
    const budgetResult = await companies.discoverCompanies({ source, transport: budgetTransport, input: flowInput({ limits: { maxRequests: 1 } }), clock: () => NOW });
    assert.equal(budgetSynthetic.calls.length, 1);
    assert.ok(budgetResult.refusals.some((refusal) => refusal.code === 'request_budget_exceeded'));
    // rate limit: third request is refused before any transport call
    const rateSource = sourceRecord({ permit: { rateLimit: { requestsPerWindow: 2, windowMs: 60000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 5000 } } });
    const rateRoutes = [
      { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([
        { memberId: 'rate-a', href: '/members/rate-a', name: 'Rate A Ltd.' },
        { memberId: 'rate-b', href: '/members/rate-b', name: 'Rate B Ltd.' }
      ])) },
      { match: (request) => request.path === '/members/rate-a', ...routeFor(memberHtml({ name: 'Rate A Ltd.', officialSite: 'https://rate-a.example.test/', category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang' })) },
      { match: (request) => request.path === '/members/rate-b', ...routeFor(memberHtml({ name: 'Rate B Ltd.', officialSite: 'https://rate-b.example.test/', category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang' })) }
    ];
    const rateSynthetic = createSyntheticTransport({ routes: rateRoutes });
    const rateTransport = createPermissionGatedApiTransport({ source: rateSource, fetchImpl: rateSynthetic.fetch, capability: 'fixture', now: () => NOW });
    const rateResult = await companies.discoverCompanies({ source: rateSource, transport: rateTransport, input: flowInput(), clock: () => NOW });
    assert.equal(rateSynthetic.calls.length, 2);
    assert.ok(rateResult.requests.decisions.some((decision) => decision.decision === 'rate_limited'));
    // Retry-After above the cap: lower bound honored, no blind retry
    let retryCalls = 0;
    const retryFetch = async () => { retryCalls += 1; return { status: 429, headers: { 'retry-after': '99999' }, body: '' }; };
    const retryTransport = createPermissionGatedApiTransport({ source, fetchImpl: retryFetch, capability: 'fixture', now: () => NOW });
    const retryResult = await companies.discoverCompanies({ source, transport: retryTransport, input: flowInput(), clock: () => NOW });
    assert.equal(retryCalls, 1);
    assert.equal(retryResult.status, 'blocked');
    assert.equal(retryResult.code, 'retry_after_exceeds_cap');
    // unknown timeout: pending_reconcile, exactly one attempt, never resent
    let timeoutCalls = 0;
    const timeoutFetch = async () => { timeoutCalls += 1; return { status: 0, timedOut: true, headers: {}, body: '' }; };
    const timeoutTransport = createPermissionGatedApiTransport({ source, fetchImpl: timeoutFetch, capability: 'fixture', now: () => NOW });
    const timeoutResult = await companies.discoverCompanies({ source, transport: timeoutTransport, input: flowInput(), clock: () => NOW });
    assert.equal(timeoutCalls, 1);
    assert.equal(timeoutResult.status, 'blocked');
    assert.equal(timeoutResult.code, 'timeout_unknown');
    assert.equal(timeoutResult.requests.decisions[0].decision, 'pending_reconcile');
  } finally {
    env.db.close();
  }
});

// ---------- revision-01 focused group (six boundary defects) ----------

test('T3.3 rev01 F1: shared host with explicit identity conflicts is never hard-merged', { skip }, async () => {
  const record = ({ id, name, domain, address, legal }) => ({
    recordId: id, name: companies.normalizeCompanyName(name), domain: companies.normalizeDomainValue(domain), address: companies.normalizeAddressValue(address),
    legalId: legal, crossReferences: [], claims: [], provenance: [{ url: `https://directory.example.test/members/${id}`, sha256: 'a'.repeat(64), observedAt: AT, sourceId: companies.COMPANY_SOURCE_ID }], manual: false
  });
  // negative: same shared host, explicit legal-id/address conflicts → two independent candidates
  const conflicted = companies.dedupeCompanyRecords([
    record({ id: 'one', name: 'SYNTHETIC NORTH LTD', domain: 'https://shared.example.test/north', address: '1 North Road', legal: 'LEGAL-NORTH' }),
    record({ id: 'two', name: 'SYNTHETIC SOUTH LTD', domain: 'https://shared.example.test/south', address: '2 South Road', legal: 'LEGAL-SOUTH' })
  ]);
  assert.equal(conflicted.entities.length, 2, 'a shared platform/group host is not one legal entity when names/legalIDs/addresses explicitly conflict');
  assert.equal(conflicted.merges.length, 0);
  for (const entity of conflicted.entities) {
    assert.deepEqual(entity.domains, [], 'the conflicting shared host is not a confirmed canonical domain');
    assert.deepEqual(entity.candidateDomains, ['shared.example.test'], 'the candidate host stays as provenance, not faked into the unique domain index');
    assert.equal(entity.canonicalDomainConfirmed, false);
  }
  assert.ok(conflicted.entities.every((entity) => entity.entityKey.startsWith('identity:')));
  // positive: same host with consistent identity keeps multi-source provenance in one entity
  const consistent = companies.dedupeCompanyRecords([
    record({ id: 'p1', name: 'SYNTHETIC SAME LTD', domain: 'https://same.example.test/a', address: '1 Same Road', legal: 'LEGAL-SAME' }),
    record({ id: 'p2', name: 'SYNTHETIC SAME LTD', domain: 'https://www.same.example.test/b', address: '1 Same Road', legal: 'LEGAL-SAME' })
  ]);
  assert.equal(consistent.entities.length, 1);
  assert.deepEqual(consistent.entities[0].domains, ['same.example.test']);
  assert.equal(consistent.entities[0].canonicalDomainConfirmed, true);
  assert.equal(consistent.entities[0].provenance.length, 2);
});

test('T3.3 rev01 F2: transitions read real observation keys/time/source evidence, never caller labels', { skip }, async () => {
  const env = openEnv('rev01-f2');
  try {
    const entity = companies.dedupeCompanyRecords([{
      recordId: 'state', name: companies.normalizeCompanyName('SYNTHETIC STATE'), domain: companies.normalizeDomainValue('https://state.example.test'), address: companies.normalizeAddressValue('1 Road'),
      legalId: 'LEGAL-STATE', crossReferences: [], claims: [], provenance: [{ url: 'https://directory.example.test/members/state', sha256: 'b'.repeat(64), observedAt: AT, sourceId: companies.COMPANY_SOURCE_ID }], manual: false
    }]).entities[0];
    const { lead } = companies.upsertCompanyLead(env.db, PROJECT, entity, { clock: () => NOW });
    // a real contact.citation row (valid time, no source evidence) mislabeled by the caller as three dimensions
    const unrelated = evidence.createObservation(env.db, PROJECT, { subjectType: 'company_lead', subjectId: lead.id, key: 'contact.citation', value: 'SYNTHETIC contact text only', originType: 'seller_statement', approvalStatus: 'unreviewed', observedAt: AT });
    const forgedDimensions = ['category', 'channel', 'region'].map((dimension) => ({ dimension, observationId: unrelated.id }));
    const screened = companies.transitionCompanyLead(env.db, PROJECT, { leadId: lead.id, toStatus: 'screened', expectedVersion: 1, reason: 'synthetic forged dimensions', dimensions: forgedDimensions, requiredDimensions: ['category', 'channel', 'region'], unknownTimeClaims: [], clock: () => NOW });
    assert.equal(screened.ok, false, 'contact.citation with no source evidence cannot be called adaptation.category/channel/region by caller strings');
    assert.equal(screened.code, 'evidence_invalid');
    const persisted = env.db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(PROJECT, lead.id);
    assert.equal(persisted.status, 'discovered', 'a refused transition leaves the lead unchanged');
    assert.equal(persisted.version, 1);
    assert.equal(evidence.listObservations(env.db, PROJECT, { subjectId: lead.id, key: 'status.transition' }).length, 0, 'no audit rows on refusal');
    // positive: real adaptation key + linked source evidence passes
    const pageEvidence = companies.persistPageEvidence(env.db, PROJECT, { url: 'https://directory.example.test/members/state', sha256: sha256Hex('rev01-f2-page'), observedAt: AT, timeKnown: true }, sourceRecord());
    const real = companies.recordAdaptationObservation(env.db, PROJECT, { leadId: lead.id, dimension: 'category', claimText: 'helmets', evidenceId: pageEvidence.id, observedAt: AT });
    const accepted = companies.transitionCompanyLead(env.db, PROJECT, { leadId: lead.id, toStatus: 'screened', expectedVersion: 1, reason: 'real adaptation evidence', dimensions: [{ dimension: 'category', observationId: real.id }], requiredDimensions: ['category'], clock: () => NOW });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.lead.status, 'screened');
  } finally {
    env.db.close();
  }
});

test('T3.3 rev01 F3: brand B never inherits brand A qualification (scope state isolation)', { skip }, async () => {
  const env = openEnv('rev01-f3');
  try {
    const a = await runCompanyOnce(env, { input: flowInput(), routes: CHAIN_ROUTES });
    assert.equal(a.report.status, 'succeeded');
    const aOutput = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...a.report.run.checkpoint.orchestrator.artifacts.discovery.ref.split('/')), 'utf8')).output;
    assert.equal(aOutput.companies.find((entry) => entry.name === 'ACME Headwear Co., Ltd.').status, 'qualified');
    const b = await runCompanyOnce(env, {
      input: flowInput({ scope: { projectId: PROJECT, brand: 'SYNTHETIC-BRAND-B', market: MARKET }, profile: { categories: ['robot dog'], channels: ['wholesale'], regions: ['DE'] } }),
      brand: 'SYNTHETIC-BRAND-B',
      routes: CHAIN_ROUTES
    });
    assert.equal(b.report.status, 'succeeded');
    const bOutput = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...b.report.run.checkpoint.orchestrator.artifacts.discovery.ref.split('/')), 'utf8')).output;
    const bAcme = bOutput.companies.find((entry) => entry.name === 'ACME Headwear Co., Ltd.');
    assert.notEqual(bAcme.status, 'qualified', 'brand B has zero matched dimensions and must not inherit the project-global qualified state');
    assert.equal(bAcme.status, 'discovered');
    assert.equal(bAcme.administrativeStatus, 'qualified', 'the project-neutral administrative state is reported separately');
    assert.equal(bAcme.scopeStatusVersion, 1);
    // scope states are exact-scope files; A is untouched by B
    const stateA = companies.readCompanyScopeState({ metaRoot: path.join(env.dir, 'meta'), projectId: PROJECT, brand: BRAND, market: MARKET });
    const stateB = companies.readCompanyScopeState({ metaRoot: path.join(env.dir, 'meta'), projectId: PROJECT, brand: 'SYNTHETIC-BRAND-B', market: MARKET });
    assert.equal(stateA.perCompany['host:acme.example.test'].status, 'qualified');
    assert.equal(stateB.perCompany['host:acme.example.test'].status, 'discovered');
    assert.equal(stateB.brand, 'SYNTHETIC-BRAND-B');
    // the empty brand is a real scope, never a wildcard
    assert.equal(companies.readCompanyScopeState({ metaRoot: path.join(env.dir, 'meta'), projectId: PROJECT, brand: '', market: MARKET }), null);
    const nullBrand = await runCompanyOnce(env, { input: flowInput({ scope: { projectId: PROJECT, brand: '', market: MARKET } }), brand: null, routes: CHAIN_ROUTES });
    assert.equal(nullBrand.report.status, 'succeeded');
    const nullState = companies.readCompanyScopeState({ metaRoot: path.join(env.dir, 'meta'), projectId: PROJECT, brand: '', market: MARKET });
    assert.equal(nullState.brand, '');
    assert.equal(nullState.perCompany['host:acme.example.test'].status, 'qualified');
    assert.equal(stateA.version, 1, 'scope A state is not overwritten by other scopes');
  } finally {
    env.db.close();
  }
});

test('T3.3 rev01 F4: negated claims never qualify; the original text is preserved', { skip }, async () => {
  const env = openEnv('rev01-f4');
  try {
    const routes = [
      { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([{ memberId: 'neg', href: '/members/neg', name: 'NEGATIVE CLAIMS LTD' }])) },
      { match: (request) => request.path === '/members/neg', ...routeFor(memberHtml({
        name: 'NEGATIVE CLAIMS LTD', officialSite: 'https://neg.example.test/',
        category: 'We do not sell helmets', channel: 'Not a retail distributor', region: 'No service in US'
      })) }
    ];
    const { report } = await runCompanyOnce(env, { input: flowInput(), routes });
    assert.equal(report.status, 'succeeded');
    const output = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...report.run.checkpoint.orchestrator.artifacts.discovery.ref.split('/')), 'utf8')).output;
    const neg = output.companies.find((entry) => entry.name === 'NEGATIVE CLAIMS LTD');
    assert.notEqual(neg.status, 'qualified', 'visible negative claims are not positive suitability evidence solely because tokens match');
    assert.deepEqual(neg.adaptation.negatedDimensions, ['category', 'channel', 'region']);
    assert.deepEqual(neg.adaptation.matchedDimensions, []);
    // the original negation text stays visible in the immutable snapshot
    const manifest = companies.readCompanySnapshot({ metaRoot: path.join(env.dir, 'meta'), runId: report.run.id, projectId: PROJECT, brand: BRAND, market: MARKET });
    const entity = manifest.entities.find((entry) => entry.name === 'NEGATIVE CLAIMS LTD');
    const negatedTexts = entity.adaptation.dimensions.flatMap((dimension) => dimension.negatedClaims.map((claim) => claim.claimText)).sort();
    assert.deepEqual(negatedTexts, ['No service in US', 'Not a retail distributor', 'We do not sell helmets']);
    // a clear positive affirmation in the same shape still qualifies
    const positiveRoutes = [
      { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([{ memberId: 'pos', href: '/members/pos', name: 'POSITIVE CLAIMS LTD' }])) },
      { match: (request) => request.path === '/members/pos', ...routeFor(memberHtml({
        name: 'POSITIVE CLAIMS LTD', officialSite: 'https://pos.example.test/',
        category: 'helmets OEM manufacturing', channel: 'OEM/ODM export', region: 'Zhejiang CN'
      })) }
    ];
    const positive = await runCompanyOnce(env, { input: flowInput(), routes: positiveRoutes });
    assert.equal(positive.report.status, 'succeeded');
    const positiveOutput = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...positive.report.run.checkpoint.orchestrator.artifacts.discovery.ref.split('/')), 'utf8')).output;
    assert.equal(positiveOutput.companies.find((entry) => entry.name === 'POSITIVE CLAIMS LTD').status, 'qualified');
  } finally {
    env.db.close();
  }
});

test('T3.3 rev01 F5: the Retry-After cooldown persists across discovery invocations on the same transport', { skip }, async () => {
  const env = openEnv('rev01-f5');
  try {
    const source = sourceRecord();
    let ms = Date.parse(NOW);
    const clock = () => new Date(ms).toISOString();
    let calls = 0;
    const transport = createPermissionGatedApiTransport({ source, capability: 'fixture', now: clock, fetchImpl: async () => { calls += 1; return { status: 429, synthetic: true, headers: { 'retry-after': '10' }, body: '' }; } });
    const first = await companies.discoverCompanies({ source, transport, input: flowInput(), clock });
    assert.equal(first.status, 'blocked');
    assert.equal(first.code, 'retry_after_exceeds_cap');
    assert.equal(calls, 1);
    const second = await companies.discoverCompanies({ source, transport, input: flowInput(), clock });
    assert.equal(calls, 1, 'the defer deadline cannot be forgotten by a new discover call on the same transport');
    assert.equal(second.code, 'source_cooldown');
    ms += 9000;
    const beforeDeadline = await companies.discoverCompanies({ source, transport, input: flowInput(), clock });
    assert.equal(calls, 1, 'the deadline is never shortened');
    assert.equal(beforeDeadline.code, 'source_cooldown');
    ms += 1000;
    const after = await companies.discoverCompanies({ source, transport, input: flowInput(), clock });
    assert.equal(calls, 2, 'after the deadline expires a new call is legal');
    assert.equal(after.status, 'blocked');
  } finally {
    env.db.close();
  }
});

test('T3.3 rev01 F6: the request budget counts every real attempt; bounded retry stays available', { skip }, async () => {
  const env = openEnv('rev01-f6');
  try {
    const source = sourceRecord();
    let ms = Date.parse(NOW);
    const clock = () => new Date(ms).toISOString();
    let cappedCalls = 0;
    const cappedTransport = createPermissionGatedApiTransport({ source, capability: 'fixture', now: clock, fetchImpl: async () => { cappedCalls += 1; return { status: 503, synthetic: true, headers: {}, body: '' }; } });
    const capped = await companies.discoverCompanies({ source, transport: cappedTransport, input: flowInput({ limits: { maxRequests: 1 } }), clock, sleep: async (delay) => { ms += delay; } });
    assert.equal(cappedCalls, 1, 'maxRequests=1 allows exactly one real attempt even through executeWithPolicy retries');
    assert.equal(capped.requests.total, 1);
    assert.ok(capped.refusals.some((refusal) => refusal.code === 'request_budget_exceeded'));
    // sufficient budget keeps the bounded retry path working
    let retryCalls = 0;
    let ms2 = Date.parse(NOW);
    const retryClock = () => new Date(ms2).toISOString();
    const retryTransport = createPermissionGatedApiTransport({
      source, capability: 'fixture', now: retryClock,
      fetchImpl: async (request) => {
        retryCalls += 1;
        if (retryCalls <= 2) return { status: 503, synthetic: true, headers: {}, body: '' };
        if (request.path === '/directory') return { status: 200, synthetic: true, headers: {}, body: directoryHtml([{ memberId: 'ok', href: '/members/ok', name: 'OK LTD' }]) };
        return { status: 200, synthetic: true, headers: {}, body: memberHtml({ name: 'OK LTD', officialSite: 'https://ok.example.test/', category: 'helmets', channel: 'OEM/ODM', region: 'Zhejiang' }) };
      }
    });
    const ok = await companies.discoverCompanies({ source, transport: retryTransport, input: flowInput({ limits: { maxRequests: 4 } }), clock: retryClock, sleep: async (delay) => { ms2 += delay; } });
    assert.equal(ok.status, 'ok');
    assert.equal(retryCalls, 4, 'two bounded retries + directory + one member page');
    assert.equal(ok.requests.total, 4);
    assert.equal(ok.entities[0].adaptation.matchedDimensions.length, 3);
  } finally {
    env.db.close();
  }
});

// ---------- revision-02 focused group (two combination residuals) ----------

test('T3.3 rev02 R1: an unknown-identity bridge cannot reunite conflicting legal entities', { skip }, async () => {
  const record = ({ id, name, domain, address, legal }) => ({
    recordId: id, name: companies.normalizeCompanyName(name), domain: companies.normalizeDomainValue(domain), address: companies.normalizeAddressValue(address),
    legalId: legal, crossReferences: [], claims: [], provenance: [{ url: `https://directory.example.test/members/${id}`, sha256: 'a'.repeat(64), observedAt: AT, sourceId: companies.COMPANY_SOURCE_ID }], manual: false
  });
  const north = () => record({ id: 'one', name: 'SYNTHETIC NORTH LTD', domain: 'https://shared.example.test/north', address: '1 North Road', legal: 'LEGAL-NORTH' });
  const south = () => record({ id: 'two', name: 'SYNTHETIC SOUTH LTD', domain: 'https://shared.example.test/south', address: '2 South Road', legal: 'LEGAL-SOUTH' });
  const bridge = () => record({ id: 'bridge', name: 'SYNTHETIC SHARED DIRECTORY', domain: 'https://shared.example.test', address: null, legal: null });
  const out = companies.dedupeCompanyRecords([north(), bridge(), south()]);
  assert.equal(out.entities.length, 3, 'the unknown bridge stays independent: unknown is not the same identity');
  assert.ok(!out.entities.some((entity) => entity.legalIds.includes('LEGAL-NORTH') && entity.legalIds.includes('LEGAL-SOUTH')), 'a bridge compatible with each side separately cannot erase the explicit North/South conflict via transitive union');
  const northEntity = out.entities.find((entity) => entity.legalIds.includes('LEGAL-NORTH'));
  const southEntity = out.entities.find((entity) => entity.legalIds.includes('LEGAL-SOUTH'));
  const bridgeEntity = out.entities.find((entity) => entity.legalIds.length === 0);
  assert.ok(northEntity && southEntity && bridgeEntity);
  assert.deepEqual(northEntity.provenance.map((p) => p.url), ['https://directory.example.test/members/one']);
  assert.deepEqual(southEntity.provenance.map((p) => p.url), ['https://directory.example.test/members/two']);
  for (const entity of out.entities) {
    assert.deepEqual(entity.domains, [], 'the conflicting shared host is never a confirmed canonical domain');
    assert.deepEqual(entity.candidateDomains, ['shared.example.test']);
    assert.equal(entity.canonicalDomainConfirmed, false);
  }
  // order independence: the same semantics under a different input order
  const reordered = companies.dedupeCompanyRecords([south(), bridge(), north()]);
  assert.equal(reordered.entities.length, 3);
  assert.deepEqual(reordered.entities.map((entity) => entity.legalIds).sort(), out.entities.map((entity) => entity.legalIds).sort());
  assert.deepEqual(reordered.entities.map((entity) => entity.provenance.map((p) => p.url)).sort(), out.entities.map((entity) => entity.provenance.map((p) => p.url)).sort());
  // a cross-reference from another host cannot reunite the conflicted host through a second path
  const other = { ...record({ id: 'other', name: 'OTHER LTD', domain: 'https://other.example.test', address: '9 Other Road', legal: 'LEGAL-OTHER' }), crossReferences: ['shared.example.test'] };
  const withRef = companies.dedupeCompanyRecords([north(), bridge(), south(), other]);
  assert.ok(!withRef.entities.some((entity) => entity.legalIds.includes('LEGAL-NORTH') && entity.legalIds.includes('LEGAL-SOUTH')));
  assert.ok(withRef.entities.some((entity) => entity.legalIds.includes('LEGAL-OTHER') && entity.domains.includes('other.example.test')));
  // positive: consistent identity multi-source still merges (not over-blocked)
  const consistent = companies.dedupeCompanyRecords([
    record({ id: 'p1', name: 'SYNTHETIC SAME LTD', domain: 'https://same.example.test/a', address: '1 Same Road', legal: 'LEGAL-SAME' }),
    record({ id: 'p2', name: 'SYNTHETIC SAME LTD', domain: 'https://www.same.example.test/b', address: '1 Same Road', legal: 'LEGAL-SAME' })
  ]);
  assert.equal(consistent.entities.length, 1);
  assert.equal(consistent.entities[0].provenance.length, 2);
});

test('T3.3 rev02 R3: same-scope current negative evidence cannot retain current qualified', { skip }, async () => {
  const env = openEnv('rev02-r3');
  let closed = false;
  try {
    const scopeInput = () => flowInput({ profile: { categories: ['helmet'], channels: ['retail'], regions: ['US'] } });
    const positiveRoutes = [
      { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([{ memberId: 'alpha', href: '/members/alpha', name: 'SYNTHETIC ALPHA' }])) },
      { match: (request) => request.path === '/members/alpha', ...routeFor(memberHtml({
        name: 'SYNTHETIC ALPHA', officialSite: 'https://alpha.example.test/', address: '1 Synthetic Lane',
        category: 'helmets', channel: 'retail distribution', region: 'US', legalId: 'SYNTHETIC-LEGAL-A', contact: 'Synthetic sales office'
      })) }
    ];
    const negatedRoutes = [
      { match: (request) => request.path === '/directory', ...routeFor(directoryHtml([{ memberId: 'alpha', href: '/members/alpha', name: 'SYNTHETIC ALPHA' }])) },
      { match: (request) => request.path === '/members/alpha', ...routeFor(memberHtml({
        name: 'SYNTHETIC ALPHA', officialSite: 'https://alpha.example.test/', address: '1 Synthetic Lane',
        category: 'We do not sell helmets', channel: 'Not a retail distributor', region: 'No service in US', legalId: 'SYNTHETIC-LEGAL-A', contact: 'Synthetic sales office'
      })) }
    ];
    const first = await runCompanyOnce(env, { input: scopeInput(), routes: positiveRoutes });
    assert.equal(first.report.status, 'succeeded');
    const firstOutput = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...first.report.run.checkpoint.orchestrator.artifacts.discovery.ref.split('/')), 'utf8')).output;
    assert.equal(firstOutput.companies[0].status, 'qualified');
    const firstSnapshotHash = firstOutput.snapshot.sha256;
    // second run: same DB/project/brand/market/profile, the new detail page is explicitly negative
    const second = await runCompanyOnce(env, { input: scopeInput(), routes: negatedRoutes });
    assert.equal(second.report.status, 'succeeded');
    const secondOutput = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...second.report.run.checkpoint.orchestrator.artifacts.discovery.ref.split('/')), 'utf8')).output;
    const secondCompany = secondOutput.companies[0];
    assert.notEqual(secondCompany.status, 'qualified', 'current negative evidence cannot retain the previous qualified state');
    assert.equal(secondCompany.status, 'needs_review');
    assert.equal(secondCompany.historicalStage, 'qualified', 'the historical qualification is preserved separately');
    assert.equal(secondCompany.needsReview, true);
    assert.ok(String(secondCompany.scopeReason).includes('negative'));
    // the old run artifact/snapshot hash is untouched
    assert.equal(sha256Hex(fs.readFileSync(firstOutput.snapshot.path)), firstSnapshotHash);
    // scope state: version bumped, history audited, current refs are the current negation only
    const state = companies.readCompanyScopeState({ metaRoot: path.join(env.dir, 'meta'), projectId: PROJECT, brand: BRAND, market: MARKET });
    const entry = state.perCompany['host:alpha.example.test'];
    assert.equal(entry.currentQualification, 'needs_review');
    assert.equal(entry.historicalStage, 'qualified');
    assert.equal(entry.version, 2);
    assert.deepEqual(entry.currentEvidenceRefs, [], 'previous refs are never mixed in as current support');
    assert.ok(entry.negatedEvidenceRefs.length > 0, 'the current negation references are auditable');
    assert.equal(state.history.length, 2);
    // a new explicit positive re-evaluates the current qualification
    const third = await runCompanyOnce(env, { input: scopeInput(), routes: positiveRoutes });
    assert.equal(third.report.status, 'succeeded');
    const thirdOutput = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...third.report.run.checkpoint.orchestrator.artifacts.discovery.ref.split('/')), 'utf8')).output;
    assert.equal(thirdOutput.companies[0].status, 'qualified');
    // SQL reopen keeps the first artifact hash and the DB integrity
    env.db.close();
    closed = true;
    const reopenedDb = openDb(path.join(env.dir, 'companies.db'));
    try {
      assert.equal(reopenedDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(store.getRun(reopenedDb, PROJECT, first.report.run.id).checkpoint.orchestrator.artifacts.discovery.sha, first.report.run.checkpoint.orchestrator.artifacts.discovery.sha);
    } finally {
      reopenedDb.close();
    }
  } finally {
    if (!closed) env.db.close();
  }
});
