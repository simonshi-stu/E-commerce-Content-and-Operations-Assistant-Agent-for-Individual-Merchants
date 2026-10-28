'use strict';
/**
 * T3.4 channel exports tests.
 *
 * Representative chain: synthetic T3.3 company + locally cited contact (source_cited) → trusted
 * occurred fixture records drive the sales stages (record only, no outreach) → registered handler
 * through the original orchestrator → two-profile CSV/XLSX + English draft artifact → actual
 * artifact/export hashes → CSV/XLSX reopen → SQLite close/reopen. Risk groups: verification/won
 * trust; exact-scope isolation + preflight atomicity; profile authority + external metadata
 * projection. revision-01 adds the six boundary contracts (trusted records, scope binding,
 * preflight, grants, projection). All fixtures synthetic.
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
const companies = require(path.join(W, 'lib', 'commerce', 'companies.js'));
const channelExports = require(path.join(W, 'lib', 'commerce', 'exports.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-test-'));
const skip = false;
const RUN_DIR = fs.mkdtempSync(path.join(TMP_ROOT, 't34-run-'));
const NOW = '2026-10-15T10:00:00.000Z';
const AT = '2026-10-15T08:00:00Z';
const PROJECT = 'proj-t34-a';
const BRAND = 'SYNTHETIC-BRAND';
const MARKET = 'US';
const EMAIL = 'synthetic-private-contact@alpha.example.test';
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function openEnv(name) {
  const dir = fs.mkdtempSync(path.join(RUN_DIR, `${name}-`));
  const db = openDb(path.join(dir, 'channels.db'));
  migrateUp(db, migrations);
  return { dir, db, workerDir: path.join(dir, 'workdir'), metaRoot: path.join(dir, 'meta'), exportRoot: path.join(dir, 'exports') };
}

function makeLead(env, { name = 'SYNTHETIC ALPHA', domain = 'alpha.example.test' } = {}) {
  const entity = {
    entityKey: `host:${domain}`, name, nameVariants: [name], domains: [domain], candidateDomains: [], canonicalDomainConfirmed: true,
    addresses: ['1 Synthetic Lane'], legalIds: [], crossReferences: [], officialSites: [], contactCitations: [], provenance: [], records: [], claims: [], manual: false
  };
  return companies.upsertCompanyLead(env.db, PROJECT, entity, { clock: () => NOW }).lead;
}

function persistEvidence(env, { url, content, observedAt = AT }) {
  return evidence.recordDeclaredEvidence(env.db, PROJECT, {
    sha256: sha256Hex(content), sourceType: 'page', importBasis: 'synthetic T3.4 fixture (never live)', url, observedAt, licenseNote: 'synthetic-only'
  });
}

/** A trusted fixture record (factory-injected resolver content — the only authorization source). */
function trustedEvent(lead, kind, n, evidenceRef, over = {}) {
  return { recordId: `te-${kind}-${n}`, kind, projectId: PROJECT, leadId: lead.id, brand: BRAND, market: MARKET, reference: `ref-${kind}-${n}`, at: AT, evidenceRef, ...over };
}
function trustedDeal(lead, over = {}) {
  return { recordId: 'td-order-1', kind: 'order', dealId: 'ORD-2026-0001', projectId: PROJECT, leadId: lead.id, brand: BRAND, market: MARKET, domain: 'alpha.example.test', status: 'active', recordedAt: AT, contentSha256: null, evidenceRef: null, ...over };
}
function trustedVerification(lead, over = {}) {
  return { recordId: 'tv-receipt-1', projectId: PROJECT, leadId: lead.id, brand: BRAND, market: MARKET, contactType: 'email', contactValue: EMAIL, method: 'synthetic_receipt', subjectDomain: 'alpha.example.test', reference: 'synthetic-verification-001', verifiedAt: AT, status: 'valid', ...over };
}

function contactFor(row, over = {}) {
  return { contactType: 'email', value: EMAIL, sourceUrl: row.url, observedAt: AT, sourceKind: 'official', contentSha256: row.sha256, evidenceRef: row.id, ...over };
}

function inputFor(lead, { brand = BRAND, contacts = [], verifications = [], events = [], draft, profiles = ['internal-full', 'external-redacted'], license = 'synthetic fixture license (never live)' } = {}) {
  const input = { scope: { projectId: PROJECT, brand, market: MARKET }, lead: { leadId: lead.id }, contacts, verifications, events, license, exportProfiles: profiles };
  if (draft !== undefined) input.draft = draft;
  return input;
}

async function runChannelOnce(env, { input, projectId = PROJECT, brand = BRAND, marketCode = MARKET, grants = { 'internal-full': true }, trustedRecords = null, clock = () => NOW, qualityFields = ['stages', 'exports'] }) {
  const registration = channelExports.createChannelRegistration({
    domain: { db: env.db, metaRoot: env.metaRoot, exportRoot: env.exportRoot, clock, profileGrants: grants, trustedRecords }
  });
  const registry = createToolRegistry({ roles: orch.ROLES });
  channelExports.registerChannelHandler(registry, registration);
  const report = await orch.runOrchestratorOnce(env.db, {
    projectId, brand, market: marketCode, owner: 't34-test', ttlSeconds: 120, now: NOW, clock: () => NOW, registry, workerDir: env.workerDir, inputVersion: 'ui-v1',
    plan: {
      schemaVersion: 1, taskType: 'channel-outreach-export.v1',
      steps: [{ id: 'channel', role: 'channel-development', tool: channelExports.CHANNEL_TOOL_NAME, input, quality: { requireFields: qualityFields } }]
    }
  });
  return { report, registry };
}

function artifactOutput(report, env) {
  const meta = report.run.checkpoint.orchestrator.artifacts.channel;
  return JSON.parse(fs.readFileSync(path.join(env.workerDir, ...meta.ref.split('/')), 'utf8')).output;
}

// ---------- representative chain ----------

test('T3.4 chain: cited contact → trusted fixture events → registered handler → two-profile CSV/XLSX + draft → reopen + SQL', { skip }, async () => {
  const env = openEnv('chain');
  let closed = false;
  try {
    const lead = makeLead(env);
    const pageEvidence = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'SYNTHETIC ordinary contact directory page' });
    const eventEvidence = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'synthetic occurred records' });
    const orderContent = 'synthetic order ORD-2026-0001 (fixture, never a real order)';
    const orderEvidence = persistEvidence(env, { url: 'https://alpha.example.test/orders/ORD-2026-0001', content: orderContent });
    const trustedRecords = {
      events: [
        trustedEvent(lead, 'contact_event', 1, eventEvidence.id),
        trustedEvent(lead, 'reply', 2, eventEvidence.id),
        trustedEvent(lead, 'sample', 3, eventEvidence.id),
        trustedEvent(lead, 'quote', 4, eventEvidence.id)
      ],
      deals: [trustedDeal(lead, { contentSha256: sha256Hex(orderContent), evidenceRef: orderEvidence.id })],
      verifications: []
    };
    const input = inputFor(lead, {
      contacts: [contactFor(pageEvidence)],
      events: [
        { toStage: 'contacted', eventId: 'evt-1', reason: 'synthetic occurred contact (trusted fixture)', occurredContact: { recordId: 'te-contact_event-1' } },
        { toStage: 'replied', eventId: 'evt-2', reason: 'synthetic reply record', replyRecord: { recordId: 'te-reply-2' } },
        { toStage: 'sampled', eventId: 'evt-3', reason: 'synthetic sample record', sampleRecord: { recordId: 'te-sample-3' } },
        { toStage: 'quoted', eventId: 'evt-4', reason: 'synthetic quote record', quoteRecord: { recordId: 'te-quote-4' } },
        { toStage: 'won', eventId: 'evt-5', reason: 'synthetic trusted linked order', dealRef: { recordId: 'td-order-1' } }
      ],
      draft: {
        subject: 'Helmet OEM cooperation', language: 'en',
        body: 'Hello,\nWe are looking for helmet OEM partners and would be glad to share our requirements.\nWould you be open to a short introduction?',
        claims: [], allowedClaims: []
      }
    });
    const { report } = await runChannelOnce(env, { input, trustedRecords });
    assert.equal(report.status, 'succeeded');
    const meta = report.run.checkpoint.orchestrator.artifacts.channel;
    const artifact = JSON.parse(fs.readFileSync(path.join(env.workerDir, ...meta.ref.split('/')), 'utf8'));
    assert.equal(sha256Hex(packs.canonicalJson(artifact.output)), meta.sha);
    const output = artifact.output;
    assert.equal(output.contacts.length, 1);
    assert.equal(output.contacts[0].level, 'source_cited');
    assert.equal(output.stages.stage, 'won');
    assert.equal(output.stages.version, 6);
    assert.equal(output.stages.terminal, true);
    assert.equal(output.stages.eventCount, 5);
    for (const profile of ['internal-full', 'external-redacted']) {
      for (const format of ['csv', 'xlsx']) {
        const entry = output.exports[profile][format];
        assert.ok(entry.path.startsWith(path.join(env.exportRoot, report.run.id, profile)));
        assert.equal(sha256Hex(fs.readFileSync(entry.path)), entry.sha256);
      }
    }
    const internalCsv = channelExports.readBackChannelCsv(output.exports['internal-full'].csv.path);
    assert.equal(internalCsv.rows[0].contactValue, EMAIL);
    assert.equal(internalCsv.rows[0].verificationLevel, 'source_cited');
    assert.equal(internalCsv.rows[0].contactObservedAt, AT);
    assert.equal(internalCsv.rows[0].contactLicense, 'synthetic fixture license (never live)');
    assert.equal(internalCsv.rows[0].salesStage, 'won');
    const externalText = fs.readFileSync(output.exports['external-redacted'].csv.path, 'utf8');
    assert.ok(!externalText.includes(EMAIL), 'the private value never leaves in the external profile');
    const externalCsv = channelExports.readBackChannelCsv(output.exports['external-redacted'].csv.path);
    assert.equal(externalCsv.rows[0].contactValue, '');
    assert.equal(externalCsv.rows[0].verificationLevel, 'source_cited');
    const internalWorkbook = await channelExports.readBackChannelWorkbook(output.exports['internal-full'].xlsx.path);
    assert.deepEqual(internalWorkbook.sheetNames, [channelExports.CHANNEL_SHEET_NAME]);
    assert.deepEqual(internalWorkbook.hiddenSheets, []);
    assert.equal(internalWorkbook.hasFormulas, false);
    assert.equal(internalWorkbook.hasHyperlinks, false);
    assert.equal(internalWorkbook.hasComments, false);
    const header = internalWorkbook.sheets[0].rows[0];
    assert.equal(internalWorkbook.sheets[0].rows[1][header.indexOf('contactValue')], EMAIL);
    const externalWorkbook = await channelExports.readBackChannelWorkbook(output.exports['external-redacted'].xlsx.path);
    assert.ok(!JSON.stringify(externalWorkbook.sheets).includes(EMAIL));
    assert.ok(!JSON.stringify(externalWorkbook.sheets).includes('1 Synthetic Lane'));
    assert.equal(output.draft.status, 'draft');
    assert.equal(output.draft.sent, false);
    assert.equal(sha256Hex(fs.readFileSync(output.draft.path)), output.draft.sha256);
    const draft = JSON.parse(fs.readFileSync(output.draft.path, 'utf8'));
    assert.equal(draft.sent, false);
     // task-card sample outputs (external-redacted is the safe sample)
     const sampleDir = path.join(RUN_DIR, 'samples');
     fs.mkdirSync(sampleDir, { recursive: true });
     const samplePath = path.join(sampleDir, 'channel-sample.xlsx');
     const sampleCsvPath = path.join(sampleDir, 'channel-sample.csv');
    for (const [source, target] of [[output.exports['external-redacted'].xlsx.path, samplePath], [output.exports['external-redacted'].csv.path, sampleCsvPath]]) {
      const tmp = `${target}.tmp-${Date.now()}`;
      fs.copyFileSync(source, tmp);
      fs.renameSync(tmp, target);
    }
    // SQL reopen
    env.db.close();
    closed = true;
    const reopenedDb = openDb(path.join(env.dir, 'channels.db'));
    try {
      assert.equal(reopenedDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      const run = store.getRun(reopenedDb, PROJECT, report.run.id);
      assert.equal(run.status, 'succeeded');
      assert.equal(run.checkpoint.orchestrator.artifacts.channel.sha, meta.sha);
      const leadRow = reopenedDb.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(PROJECT, lead.id);
      assert.equal(leadRow.status, 'discovered', 'the T3.3 administrative stage is never touched by the sales flow');
      const events = companies.listSalesEvents(reopenedDb, PROJECT, lead.id, { brand: BRAND, market: MARKET });
      assert.deepEqual(events.map((entry) => entry.to), ['contacted', 'replied', 'sampled', 'quoted', 'won']);
      assert.deepEqual(events.map((entry) => entry.version), [2, 3, 4, 5, 6]);
      assert.ok(events.every((entry) => entry.brand === BRAND && entry.market === MARKET));
      const contacts = companies.listContacts(reopenedDb, PROJECT, lead.id, { brand: BRAND, market: MARKET });
      assert.equal(contacts.length, 1);
      assert.equal(contacts[0].value, EMAIL);
    } finally {
      reopenedDb.close();
    }
  } finally {
    if (!closed) env.db.close();
  }
});

// ---------- risk group 1: trusted verification + won ----------

test('T3.4 group1 verification: payload strings never authorize; trusted receipts bind exactly; won needs a trusted linked order', { skip }, async () => {
  const env = openEnv('verify');
  try {
    const lead = makeLead(env);
    const page = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'SYNTHETIC contact page' });
    // self-reported payload (method/reference strings, no record id) is refused with zero state
    const forged = await runChannelOnce(env, {
      input: inputFor(lead, {
        contacts: [contactFor(page)],
        verifications: [{ contactIndex: 0, method: 'synthetic_receipt', subjectDomain: 'alpha.example.test', reference: 'nonexistent-receipt-self-reported', verifiedAt: AT, status: 'valid' }],
        profiles: ['external-redacted']
      })
    });
    assert.notEqual(forged.report.status, 'succeeded');
    assert.equal(companies.listContactVerifications(env.db, PROJECT, lead.id).length, 0, 'no verification observation is created from payload strings');
    // a trusted receipt resolver entry binds exactly → verified
    const trustedRecords = { verifications: [trustedVerification(lead)], deals: [], events: [] };
    const granted = await runChannelOnce(env, {
      input: inputFor(lead, { contacts: [contactFor(page)], verifications: [{ contactIndex: 0, verificationId: 'tv-receipt-1' }], profiles: ['external-redacted'] }),
      trustedRecords
    });
    assert.equal(granted.report.status, 'succeeded');
    assert.equal(artifactOutput(granted.report, env).contacts[0].level, 'verified');
    assert.equal(artifactOutput(granted.report, env).stages.stage, 'contact_candidate', 'a verified contact still does not contact anyone');
    // scope/subject/contact mismatches never promote (direct binding checks)
    const raw = companies.buildContactRecord({ projectId: PROJECT, brand: BRAND, market: MARKET, leadId: lead.id, contactType: 'email', value: EMAIL, sourceUrl: 'https://alpha.example.test/contact', observedAt: AT, sourceKind: 'official', contentSha256: page.sha256, evidenceRef: page.id });
    const bind = (over) => companies.bindTrustedVerificationRecord({ trusted: { ...trustedVerification(lead), ...over }, contact: raw, projectId: PROJECT, brand: BRAND, market: MARKET, leadId: lead.id });
    assert.equal(bind({}).ok, true);
    assert.equal(bind({ brand: 'OTHER-BRAND' }).code, 'verification_scope_mismatch');
    assert.equal(bind({ leadId: 'cl_other' }).code, 'verification_scope_mismatch');
    assert.equal(bind({ subjectDomain: 'other.example.test' }).code, 'verification_subject_mismatch');
    assert.equal(bind({ contactValue: 'other@alpha.example.test' }).code, 'verification_contact_mismatch');
    assert.equal(bind({ method: 'email_probe' }).code, 'verification_method_not_allowed');
    assert.equal(companies.classifyContactLevel(raw, [{ ...trustedVerification(lead), status: 'revoked', contactId: raw.contactId }]).level, 'source_cited');
    assert.equal(companies.classifyContactLevel(raw, [{ ...trustedVerification(lead), expiresAt: '2026-10-14T00:00:00Z', contactId: raw.contactId }], { asOf: NOW }).level, 'source_cited');
    // contact evidence must reopen: an arbitrary 64-hex hash without a record is refused
    assert.throws(() => companies.assertContactEvidence(env.db, PROJECT, { evidenceRef: null, contentSha256: 'a'.repeat(64) }), (error) => error.code === 'contact_evidence_missing');
    assert.throws(() => companies.assertContactEvidence(env.db, PROJECT, { evidenceRef: page.id, contentSha256: 'b'.repeat(64) }), (error) => error.code === 'contact_evidence_hash_mismatch');
    // won: an ordinary page relabeled as an order (caller kind/status labels, unknown record id) is refused with zero change
    const about = persistEvidence(env, { url: 'https://alpha.example.test/about', content: 'SYNTHETIC ordinary About page: we manufacture widgets; no contract or order' });
    const eventEvidence = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'synthetic occurred records' });
    const stages = ['contacted', 'replied', 'sampled', 'quoted'];
    const stageRecords = [trustedEvent(lead, 'contact_event', 1, eventEvidence.id), trustedEvent(lead, 'reply', 2, eventEvidence.id), trustedEvent(lead, 'sample', 3, eventEvidence.id), trustedEvent(lead, 'quote', 4, eventEvidence.id)];
    for (const [index, stage] of stages.entries()) {
      const state = companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET });
      const key = ['occurredContact', 'replyRecord', 'sampleRecord', 'quoteRecord'][index];
      const out = companies.transitionSalesStage(env.db, PROJECT, {
        leadId: lead.id, brand: BRAND, market: MARKET, expectedVersion: state.version, toStage: stage, eventId: `stage-${index}`, reason: 'synthetic preparatory stage',
        [key]: { recordId: stageRecords[index].recordId }, trustedRecords: { events: stageRecords, deals: [], verifications: [] }, clock: () => NOW
      });
      assert.equal(out.ok, true);
    }
    const before = companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET });
    const fake = companies.transitionSalesStage(env.db, PROJECT, {
      leadId: lead.id, brand: BRAND, market: MARKET, expectedVersion: before.version, toStage: 'won', eventId: 'fake-order', reason: 'caller relabels an ordinary about page',
      dealRef: { dealId: 'ORD-FAKE-0001', kind: 'order', status: 'active', domain: 'alpha.example.test', contentSha256: about.sha256, recordedAt: AT, evidenceRef: about.id },
      trustedRecords: { events: stageRecords, deals: [], verifications: [] }, clock: () => NOW
    });
    const after = companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET });
    assert.equal(fake.ok, false, 'caller kind/status labels never turn an ordinary page into an order record');
    assert.deepEqual(after, before);
    // a trusted linked order record wins; the reply/quote/cancelled/foreign guards stay
    const orderContent = 'synthetic trusted order ORD-2026-0002';
    const orderEvidence = persistEvidence(env, { url: 'https://alpha.example.test/orders/ORD-2026-0002', content: orderContent });
    const foreignEvidence = persistEvidence(env, { url: 'https://other.example.test/orders/X', content: 'synthetic foreign order' });
    const dealBase = trustedDeal(lead, { dealId: 'ORD-2026-0002', contentSha256: sha256Hex(orderContent), evidenceRef: orderEvidence.id });
    let wonAttempts = 0;
    const wonAttempt = (over, recordId = 'td-order-1') => {
      wonAttempts += 1;
      const state = companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET });
      return companies.transitionSalesStage(env.db, PROJECT, {
        leadId: lead.id, brand: BRAND, market: MARKET, expectedVersion: state.version, toStage: 'won', eventId: `won-attempt-${wonAttempts}`, reason: 'synthetic won attempt',
        dealRef: { recordId }, trustedRecords: { events: stageRecords, deals: [{ ...dealBase, ...over }], verifications: [] }, clock: () => NOW
      });
    };
    assert.equal(wonAttempt({ kind: 'reply' }).code, 'deal_kind_not_won');
    assert.equal(wonAttempt({ kind: 'quote' }).code, 'deal_kind_not_won');
    assert.equal(wonAttempt({ status: 'cancelled' }).code, 'deal_status_not_won');
    assert.equal(wonAttempt({ domain: 'other.example.test', contentSha256: sha256Hex('synthetic foreign order'), evidenceRef: foreignEvidence.id }).code, 'deal_domain_mismatch');
    assert.equal(wonAttempt({ contentSha256: 'c'.repeat(64) }).code, 'deal_evidence_mismatch');
    assert.equal(wonAttempt({ dealId: 'bad id!' }).code, 'deal_id_invalid');
    assert.equal(wonAttempt({}, 'unknown-record-id').code, 'deal_record_missing');
    const won = wonAttempt({});
    assert.equal(won.ok, true);
    assert.equal(won.state.stage, 'won');
    assert.equal(won.state.terminal, true);
    const revived = companies.transitionSalesStage(env.db, PROJECT, {
      leadId: lead.id, brand: BRAND, market: MARKET, expectedVersion: won.state.version, toStage: 'contacted', eventId: 'revive', reason: 'revive',
      occurredContact: { recordId: 'te-contact_event-1' }, trustedRecords: { events: stageRecords, deals: [], verifications: [] }, clock: () => NOW
    });
    assert.equal(revived.code, 'invalid_transition');
    // drafts: wording/claims
    assert.throws(() => companies.buildOutreachDraft({ leadName: 'X', subject: 'Hi', body: 'We already contacted you last week.', claims: [], allowedClaims: [] }), (error) => error.code === 'draft_overclaims');
    assert.throws(() => companies.buildOutreachDraft({ leadName: 'X', subject: 'Hi', body: 'Your order confirmed.', claims: [], allowedClaims: [] }), (error) => error.code === 'draft_overclaims');
    assert.throws(() => companies.buildOutreachDraft({ leadName: 'X', subject: 'Hi', body: 'Hello', claims: ['robot dog speaks English'], allowedClaims: ['helmets OEM manufacturing'] }), (error) => error.code === 'draft_claim_not_allowed');
  } finally {
    env.db.close();
  }
});

// ---------- risk group 2: exact-scope isolation + preflight atomicity ----------

test('T3.4 group2 scope: brand B never reads brand A contacts/sales; refusals leave zero state and no exports', { skip }, async () => {
  const env = openEnv('scope');
  try {
    const lead = makeLead(env);
    const page = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'SYNTHETIC contact page' });
    const eventEvidence = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'synthetic occurred records' });
    // A stores a contact and reaches won in the A scope
    const record = companies.buildContactRecord({ ...contactFor(page), projectId: PROJECT, brand: BRAND, market: MARKET, leadId: lead.id });
    companies.recordContact(env.db, PROJECT, { record, clock: () => NOW });
    const trustedRecords = { events: [trustedEvent(lead, 'contact_event', 1, eventEvidence.id), trustedEvent(lead, 'reply', 2, eventEvidence.id), trustedEvent(lead, 'sample', 3, eventEvidence.id), trustedEvent(lead, 'quote', 4, eventEvidence.id)], deals: [], verifications: [] };
    const orderContent = 'synthetic order ORD-A';
    const orderEvidence = persistEvidence(env, { url: 'https://alpha.example.test/orders/ORD-A', content: orderContent });
    trustedRecords.deals.push(trustedDeal(lead, { dealId: 'ORD-A-0001', contentSha256: sha256Hex(orderContent), evidenceRef: orderEvidence.id }));
    for (const [index, stage] of ['contacted', 'replied', 'sampled', 'quoted', 'won'].entries()) {
      const state = companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET });
      const keys = ['occurredContact', 'replyRecord', 'sampleRecord', 'quoteRecord', 'dealRef'];
      const out = companies.transitionSalesStage(env.db, PROJECT, {
        leadId: lead.id, brand: BRAND, market: MARKET, expectedVersion: state.version, toStage: stage, eventId: `a-${index}`, reason: 'synthetic A progress',
        [keys[index]]: { recordId: index < 4 ? trustedRecords.events[index].recordId : trustedRecords.deals[0].recordId }, trustedRecords, clock: () => NOW
      });
      assert.equal(out.ok, true);
    }
    assert.equal(companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).stage, 'won');
    // brand B: an empty-contact internal export carries no A value and no A sales state
    const bInput = inputFor(lead, { brand: 'SYNTHETIC-BRAND-B', contacts: [], profiles: ['internal-full'] });
    const bRun = await runChannelOnce(env, { input: bInput, brand: 'SYNTHETIC-BRAND-B' });
    assert.equal(bRun.report.status, 'succeeded');
    const bOutput = artifactOutput(bRun.report, env);
    assert.equal(bOutput.stages.stage, 'contact_candidate', 'A won progress is never inherited by brand B');
    const bCsv = fs.readFileSync(bOutput.exports['internal-full'].csv.path, 'utf8');
    assert.ok(!bCsv.includes(EMAIL), 'brand B never exports brand A private contacts');
    // A stays complete and unchanged
    assert.equal(companies.listContacts(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET })[0].value, EMAIL);
    assert.equal(companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).stage, 'won');
    // preflight atomicity: an invalid draft (and a legal-then-illegal event batch) refuses with zero effects
    const beforeContacts = companies.listContacts(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).length;
    const beforeState = companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET });
    const refused = await runChannelOnce(env, {
      input: inputFor(lead, {
        contacts: [contactFor(page, { value: 'second-private@alpha.example.test' })],
        events: [
          { toStage: 'contacted', eventId: 'partial-1', reason: 'legal then illegal batch', occurredContact: { recordId: 'te-contact_event-1' } },
          { toStage: 'replied', eventId: 'partial-2', reason: 'missing trusted reply record', replyRecord: { recordId: 'unknown-reply' } }
        ],
        draft: { subject: 'We already contacted you', body: 'We already contacted your team.', claims: [], allowedClaims: [] }
      }),
      trustedRecords
    });
    assert.equal(refused.report.status, 'blocked');
    assert.equal(companies.listContacts(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).length, beforeContacts, 'refused batches leave contacts unchanged');
    assert.deepEqual(companies.readSalesState(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }), beforeState, 'refused batches leave the sales state unchanged');
    assert.equal(fs.existsSync(path.join(env.exportRoot, refused.report.run.id)), false, 'a refused run publishes no export directory');
    // a valid draft-only run still never marks contacted
    const draftOnly = await runChannelOnce(env, { input: inputFor(lead, { contacts: [], profiles: ['external-redacted'], draft: { subject: 'Hello', body: 'A short introduction request.', claims: [], allowedClaims: [] } }), trustedRecords });
    assert.equal(draftOnly.report.status, 'succeeded');
    assert.equal(artifactOutput(draftOnly.report, env).stages.stage, 'won', 'the draft never changes the sales stage');
    assert.equal(artifactOutput(draftOnly.report, env).draft.status, 'draft');
  } finally {
    env.db.close();
  }
});

// ---------- risk group 3: profile authority + external projection ----------

test('T3.4 group3 exports: internal needs an explicit grant; external projection removes private values from URLs/license; injection/encoding/path guards', { skip }, async () => {
  const env = openEnv('export');
  try {
    const lead = makeLead(env);
    const page = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'SYNTHETIC contact page' });
    // without an internal grant the payload cannot select internal-full; nothing is written
    const ungranted = await runChannelOnce(env, {
      input: inputFor(lead, { contacts: [contactFor(page)], profiles: ['internal-full'] }),
      grants: {}
    });
    assert.notEqual(ungranted.report.status, 'succeeded');
    assert.equal(fs.existsSync(path.join(env.exportRoot, ungranted.report.run.id)), false, 'no export directory without the trusted grant');
    // external profile stays available by default
    const externalOnly = await runChannelOnce(env, { input: inputFor(lead, { contacts: [contactFor(page)], profiles: ['external-redacted'] }), grants: {} });
    assert.equal(externalOnly.report.status, 'succeeded');
    // F6: the private value must not survive through the source URL query or the license text
    const leakyInput = inputFor(lead, {
      contacts: [contactFor(page, { sourceUrl: `https://alpha.example.test/contact?email=${EMAIL}` })],
      profiles: ['internal-full', 'external-redacted'],
      license: `synthetic license contact ${EMAIL}`
    });
    const leaky = await runChannelOnce(env, { input: leakyInput });
    assert.equal(leaky.report.status, 'succeeded');
    const leakyOutput = artifactOutput(leaky.report, env);
    const externalCsvText = fs.readFileSync(leakyOutput.exports['external-redacted'].csv.path, 'utf8');
    const externalWorkbook = await channelExports.readBackChannelWorkbook(leakyOutput.exports['external-redacted'].xlsx.path);
    assert.ok(!externalCsvText.includes(EMAIL), 'external CSV must not carry the private value');
    assert.ok(!externalCsvText.includes(encodeURIComponent(EMAIL)), 'encoded forms are removed too');
    assert.ok(!externalCsvText.includes(EMAIL.replace('@', '%40')));
    assert.ok(!JSON.stringify(externalWorkbook.sheets).includes(EMAIL), 'external workbook cells/hyperlinks/comments are clean');
    const externalRow = channelExports.readBackChannelCsv(leakyOutput.exports['external-redacted'].csv.path).rows[0];
    assert.equal(externalRow.contactSourceUrl, 'https://alpha.example.test/contact', 'the URL keeps only the safe source part');
    assert.ok(!String(externalRow.contactLicense).includes(EMAIL), 'the license text is redacted');
    const internalRow = channelExports.readBackChannelCsv(leakyOutput.exports['internal-full'].csv.path).rows[0];
    assert.equal(internalRow.contactValue, EMAIL, 'internal keeps the full private value');
    assert.equal(internalRow.contactSourceUrl, `https://alpha.example.test/contact?email=${EMAIL}`, 'internal keeps the original URL');
    assert.equal(internalRow.contactLicense, `synthetic license contact ${EMAIL}`, 'internal keeps the original license');
    // projection unit checks: raw + encoded variants are redacted; nested unknowns stay fail-closed
    const projected = channelExports.projectExternalRows([{ contactSourceUrl: `https://a.example.test/x?e=${encodeURIComponent(EMAIL)}`, contactLicense: `mail ${EMAIL.replace('@', '%40')}` }], [EMAIL]);
    assert.ok(!JSON.stringify(projected).includes(EMAIL) && !JSON.stringify(projected).includes('%40'));
    assert.equal(projected[0].contactSourceUrl, 'https://a.example.test/x');
    // formula injection + encoding roundtrip (unchanged guards)
    const injectionRows = [{ leadId: 'cl_x', contactValue: '=HYPERLINK("http://evil.example.test","x")', internalNote: ' +cmd|/c calc' }];
    const injection = await channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: 'run-injection', profile: 'internal-full', format: 'csv', rows: injectionRows, clock: () => NOW });
    const injectionBack = channelExports.readBackChannelCsv(injection.path);
    assert.equal(injectionBack.rows[0].contactValue, `'=HYPERLINK("http://evil.example.test","x")`);
    assert.equal(injectionBack.rows[0].internalNote, "' +cmd|/c calc");
    const injectionXlsx = await channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: 'run-injection', profile: 'internal-full', format: 'xlsx', rows: injectionRows, clock: () => NOW });
    assert.equal((await channelExports.readBackChannelWorkbook(injectionXlsx.path)).hasFormulas, false);
    // path/profile guards + conflict/reuse (unchanged)
    await assert.rejects(() => channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: '../../evil', profile: 'internal-full', format: 'csv', rows: injectionRows, clock: () => NOW }));
    await assert.rejects(() => channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: 'run-injection', profile: 'everything', format: 'csv', rows: injectionRows, clock: () => NOW }), (error) => error.code === 'export_profile_not_allowed');
    await assert.rejects(() => channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: 'run-injection', profile: 'internal-full', format: 'csv', rows: [{ ...injectionRows[0], leadId: 'cl_changed' }], clock: () => NOW }), (error) => error.code === 'export_conflict');
    assert.equal(sha256Hex(fs.readFileSync(injection.path)), injection.sha256, 'a refused write leaves the old artifact untouched');
    const reused = await channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: 'run-injection', profile: 'internal-full', format: 'csv', rows: injectionRows, clock: () => NOW });
    assert.equal(reused.reused, true);
    // canary: secret/unknown nested leaves never leave in any profile (direct rows)
    const canaryRows = [{ leadId: 'cl_c', contactValue: 'CANARY-EMAIL-7f3a@example.test', internalSecret: 'CANARY-SECRET-9b1c', extraUnknown: { nested: ['CANARY-NESTED-2d4e'] } }];
    const internalCanary = await channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: 'run-canary', profile: 'internal-full', format: 'csv', rows: canaryRows, clock: () => NOW });
    const externalCanary = await channelExports.writeChannelExport({ exportRoot: env.exportRoot, runId: 'run-canary', profile: 'external-redacted', format: 'csv', rows: canaryRows, clock: () => NOW });
    const internalCanaryText = fs.readFileSync(internalCanary.path, 'utf8');
    const externalCanaryText = fs.readFileSync(externalCanary.path, 'utf8');
    assert.ok(internalCanaryText.includes('CANARY-EMAIL-7f3a@example.test'));
    assert.ok(!internalCanaryText.includes('CANARY-SECRET-9b1c') && !internalCanaryText.includes('CANARY-NESTED-2d4e'));
    assert.ok(!externalCanaryText.includes('CANARY-EMAIL') && !externalCanaryText.includes('CANARY-SECRET') && !externalCanaryText.includes('CANARY-NESTED'));
    for (const value of Object.values(channelExports.readBackChannelCsv(externalCanary.path).rows[0])) {
      assert.ok(!/^[A-Za-z]:[\\/]/.test(String(value)) && !String(value).includes(env.dir), 'no absolute private path in external cells');
    }
  } finally {
    env.db.close();
  }
});

// ---------- revision-02 focused group (resolver authority + persisted contacts) ----------

test('T3.4 rev02 R5: an explicit factory resolver denial applies to every profile; allow is a positive', { skip }, async () => {
  const env = openEnv('rev02-r5');
  try {
    const lead = makeLead(env);
    const page = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'SYNTHETIC contact page' });
    let denyCalls = 0;
    const deny = await runChannelOnce(env, {
      input: inputFor(lead, { contacts: [contactFor(page)], profiles: ['external-redacted'] }),
      grants: () => { denyCalls += 1; return false; }
    });
    assert.equal(denyCalls, 1, 'the resolver is consulted for the requested profile');
    assert.equal(deny.report.status, 'blocked', 'an explicit resolver false is a denial, never a default allow');
    assert.equal(companies.listContacts(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).length, 0, 'denied requests write no contacts');
    assert.equal(companies.listSalesEvents(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).length, 0);
    assert.equal(fs.existsSync(path.join(env.exportRoot, deny.report.run.id)), false, 'denied requests write no export files');
    let allowCalls = 0;
    const allow = await runChannelOnce(env, {
      input: inputFor(lead, { contacts: [contactFor(page)], profiles: ['external-redacted'] }),
      grants: () => { allowCalls += 1; return true; }
    });
    assert.equal(allowCalls, 1);
    assert.equal(allow.report.status, 'succeeded', 'a resolver true is a positive grant');
    assert.ok(fs.existsSync(path.join(env.exportRoot, allow.report.run.id)), 'the allowed run publishes its export directory');
    assert.equal(companies.listContacts(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).length, 1);
  } finally {
    env.db.close();
  }
});

test('T3.4 rev02 R3/F3: export-only requests deliver the persisted scoped contacts; other brands stay empty', { skip }, async () => {
  const env = openEnv('rev02-empty');
  try {
    const lead = makeLead(env);
    const page = persistEvidence(env, { url: 'https://alpha.example.test/contact', content: 'SYNTHETIC contact page' });
    // A stores its contact through a normal run
    const stored = await runChannelOnce(env, { input: inputFor(lead, { contacts: [contactFor(page)], profiles: ['internal-full'] }) });
    assert.equal(stored.report.status, 'succeeded');
    // A exports again WITHOUT re-supplying contacts: the persisted contact must remain complete
    const replay = await runChannelOnce(env, { input: inputFor(lead, { contacts: [], profiles: ['internal-full'] }) });
    assert.equal(replay.report.status, 'succeeded');
    const replayOutput = artifactOutput(replay.report, env);
    const replayCsv = channelExports.readBackChannelCsv(replayOutput.exports['internal-full'].csv.path);
    assert.ok(replayCsv.rows.some((row) => row.contactValue === EMAIL), 'existing scoped contacts are exported without re-upload');
    const replayWorkbook = await channelExports.readBackChannelWorkbook(replayOutput.exports['internal-full'].xlsx.path);
    const header = replayWorkbook.sheets[0].rows[0];
    assert.ok(replayWorkbook.sheets[0].rows.slice(1).some((row) => row[header.indexOf('contactValue')] === EMAIL), 'the workbook carries the persisted contact too');
    assert.equal(companies.listContacts(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET }).length, 1, 'replaying the export never duplicates or deletes the stored contact');
    // brand B with an empty input: no A contact value and an independent stage
    const bRun = await runChannelOnce(env, { input: inputFor(lead, { brand: 'SYNTHETIC-BRAND-B', contacts: [], profiles: ['internal-full'] }), brand: 'SYNTHETIC-BRAND-B' });
    assert.equal(bRun.report.status, 'succeeded');
    const bOutput = artifactOutput(bRun.report, env);
    const bCsv = fs.readFileSync(bOutput.exports['internal-full'].csv.path, 'utf8');
    assert.ok(!bCsv.includes(EMAIL), 'brand B never sees brand A persisted contacts');
    assert.equal(bOutput.stages.stage, 'contact_candidate');
    // a lead that truly has no contacts keeps a legal empty export row
    const emptyLead = makeLead(env, { name: 'SYNTHETIC BETA', domain: 'beta.example.test' });
    const emptyRun = await runChannelOnce(env, { input: inputFor(emptyLead, { contacts: [], profiles: ['external-redacted'] }) });
    assert.equal(emptyRun.report.status, 'succeeded');
    const emptyOutput = artifactOutput(emptyRun.report, env);
    const emptyCsv = channelExports.readBackChannelCsv(emptyOutput.exports['external-redacted'].csv.path);
    assert.equal(emptyCsv.rows[0].contactValue, '', 'a truly empty lead keeps a legal empty contact row');
    assert.equal(emptyCsv.rows[0].verificationLevel, 'unverified');
    // A's stored contact is still intact after all runs
    assert.equal(companies.listContacts(env.db, PROJECT, lead.id, { brand: BRAND, market: MARKET })[0].value, EMAIL);
  } finally {
    env.db.close();
  }
});
