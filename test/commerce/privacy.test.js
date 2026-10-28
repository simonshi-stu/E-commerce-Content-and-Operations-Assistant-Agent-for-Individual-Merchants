'use strict';
/**
 * T1.5 — Private/internal/external tiering and export-profile tests.
 * Synthetic fixtures only (fake company/contacts/costs); real data never appears here. Temporary
 * files go to $COMMERCE_TEST_TMP. The policy/scrubber is a whitelist with best-effort pattern
 * removal — not a general natural-language DLP engine.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const privacy = require(path.join(W, 'lib', 'commerce', 'privacy.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.5 tests write only to the private runtime tmp';

function syntheticPolicy() {
  return {
    schemaVersion: 1,
    schemaId: 'synthetic:supplier-lead',
    fields: {
      'company.name': 'external',
      'company.country': 'external',
      'contacts.name': 'internal',
      'contacts.email': 'internal',
      'contacts.phone': 'internal',
      'supplier.unitCost': 'private',
      'supplier.currency': 'private',
      'supplier.terms': 'private',
      'supplier.rawSourcePath': 'private',
      'notes': 'free_text',
      'apiKey': 'secret'
    }
  };
}

function syntheticRaw() {
  return {
    company: { name: 'Synthetic Widgets LLC', country: 'US' },
    contacts: [
      { name: 'Fake Contact One', email: 'fake.one@example.invalid', phone: '+1-000-000-0001' },
      { name: 'Fake Contact Two', email: 'fake.two@example.invalid', phone: '+1-000-000-0002' }
    ],
    supplier: {
      unitCost: 16,
      currency: 'CNY',
      terms: 'synthetic net-30 terms',
      rawSourcePath: 'P:\\runtime\\private\\synthetic\\source.txt'
    },
    notes: 'Synthetic note CANARY-NOTE-001 with secret sk-TESTCANARY12345678',
    apiKey: 'sk-TESTCANARY12345678',
    unknownExtra: { hidden: 'CANARY-UNKNOWN-001' }
  };
}

test('synthetic raw object flows internal-full -> external-redacted -> log filter with read-back canary scan', { skip }, () => {
  const policy = syntheticPolicy();
  const raw = syntheticRaw();
  const canaries = ['CANARY-NOTE-001', 'CANARY-UNKNOWN-001', 'sk-TESTCANARY12345678'];
  const before = JSON.stringify(raw);

  const internal = privacy.applyProfile(raw, policy, 'internal-full', { canaries });
  assert.equal(internal.contacts[1].email, 'fake.two@example.invalid', 'internal-full keeps the channel-needed contacts');
  assert.equal(internal.supplier.unitCost, 16, 'costs are kept verbatim');
  assert.equal(internal.supplier.currency, 'CNY', 'currency/unit is never converted');
  assert.equal(internal.supplier.terms, 'synthetic net-30 terms');
  assert.ok(!internal.notes.includes('CANARY-NOTE-001') && !internal.notes.includes('sk-'), 'free text is scrubbed');
  assert.equal(internal.apiKey, undefined, 'secrets are never exported');
  assert.equal(internal.unknownExtra, undefined, 'unclassified fields are not exported');

  const external = privacy.applyProfile(raw, policy, 'external-redacted', { canaries });
  assert.deepEqual(external, { company: { name: 'Synthetic Widgets LLC', country: 'US' } }, 'external-redacted keeps only explicitly external fields');

  const logCopy = privacy.redactForLog(raw, policy, { canaries });
  assert.deepEqual(logCopy.company, { name: 'Synthetic Widgets LLC', country: 'US' });
  assert.equal(logCopy.contacts[0].name, '[redacted]');
  assert.equal(logCopy.contacts[0].email, '[redacted]');
  assert.equal(logCopy.supplier, undefined);
  assert.equal(logCopy.notes, undefined);
  assert.equal(logCopy.apiKey, undefined);

  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'privacy-'));
  const rawFile = path.join(dir, 'raw.json');
  const internalFile = path.join(dir, 'internal-full.json');
  const externalFile = path.join(dir, 'external-redacted.json');
  const logFile = path.join(dir, 'diagnostic-log.json');
  fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2));
  fs.writeFileSync(internalFile, JSON.stringify(internal, null, 2));
  fs.writeFileSync(externalFile, JSON.stringify(external, null, 2));
  fs.writeFileSync(logFile, JSON.stringify(logCopy, null, 2));

  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(rawFile, 'utf8'))), before, 'the raw private copy keeps full contacts and is readable');

  const externalText = fs.readFileSync(externalFile, 'utf8');
  const logText = fs.readFileSync(logFile, 'utf8');
  for (const [name, text] of [['external-redacted', externalText], ['diagnostic log', logText]]) {
    assert.deepEqual(privacy.findCanaryHits(text, canaries), [], `${name} must contain no canary`);
    assert.ok(!text.includes('@example.invalid'), `${name} must contain no contact email`);
    assert.ok(!text.includes('unitCost') && !text.includes('CNY'), `${name} must contain no cost/currency fields`);
  }
  const internalText = fs.readFileSync(internalFile, 'utf8');
  assert.ok(internalText.includes('fake.two@example.invalid'), 'internal-full export keeps the channel-needed contact');
  assert.deepEqual(privacy.findCanaryHits(internalText, canaries), [], 'internal-full export carries no canary');
  assert.equal(JSON.stringify(raw), before, 'filters never mutate the input');
});

test('unknown profiles, illegal policies and unclassified fields are rejected or fail-closed', { skip }, () => {
  const policy = syntheticPolicy();
  const raw = syntheticRaw();
  assert.throws(() => privacy.applyProfile(raw, policy, 'public'), /unknown export profile/);
  assert.throws(() => privacy.validatePolicy({ ...policy, fields: { 'company.name': 'confidential' } }), /must be one of/);
  assert.throws(() => privacy.validatePolicy({ ...policy, fields: { '__proto__.name': 'external' } }), /reserved key/);
  assert.throws(() => privacy.validatePolicy({ ...policy, extra: true }), /not a known field/);
  assert.equal(privacy.applyProfile(raw, policy, 'internal-full').unknownExtra, undefined, 'unknown fields fail closed in internal-full too');
  assert.equal(privacy.applyProfile(raw, policy, 'external-redacted').unknownExtra, undefined);
  assert.deepEqual(privacy.applyProfile(raw, { ...policy, fields: {} }, 'internal-full'), {}, 'a policy with no fields exports nothing');

  const polluted = JSON.parse('{"company":{"name":"x"},"__proto__":{"polluted":true}}');
  assert.throws(() => privacy.applyProfile(polluted, policy, 'external-redacted'), /reserved key/);
  assert.equal(Object.prototype.polluted, undefined, 'no prototype pollution from a rejected input');
});

test('arrays, non-standard own keys and incompatible values are handled explicitly', { skip }, () => {
  const policy = {
    schemaVersion: 1,
    schemaId: 'synthetic:variants',
    fields: { 'items.sku': 'external', 'items.note': 'internal', toString: 'external' }
  };
  const raw = {
    items: [
      { sku: 'SYN-1', note: 'internal note one' },
      { sku: 'SYN-2', note: 'internal note two' }
    ],
    toString: 'own-key-value'
  };
  const before = JSON.stringify(raw);
  const external = privacy.applyProfile(raw, policy, 'external-redacted');
  assert.deepEqual(external, { items: [{ sku: 'SYN-1' }, { sku: 'SYN-2' }], toString: 'own-key-value' });
  assert.ok(Object.prototype.hasOwnProperty.call(external, 'toString'), 'own key preserved, not an inherited function');
  const internal = privacy.applyProfile(raw, policy, 'internal-full');
  assert.deepEqual(internal.items.map((item) => item.note), ['internal note one', 'internal note two']);
  const logCopy = privacy.redactForLog(raw, policy);
  assert.deepEqual(logCopy.items.map((item) => item.note), ['[redacted]', '[redacted]']);
  assert.equal(JSON.stringify(raw), before, 'no mutation');

  const badValues = [undefined, () => {}, Symbol('x'), 10n, Number.NaN, new Date('2026-10-09'), { nested: () => {} }];
  for (const bad of badValues) {
    assert.throws(
      () => privacy.applyProfile({ company: { name: bad } }, policy, 'internal-full'),
      /JSON-compatible|finite/,
      `value ${String(bad)} must be rejected, not silently dropped`
    );
  }
  const circular = { company: { name: 'x' } };
  circular.company.self = circular;
  assert.throws(() => privacy.applyProfile(circular, policy, 'external-redacted'), /circular/);
});

test('credentials never appear in any profile or log, even embedded in kept strings', { skip }, () => {
  const policy = {
    schemaVersion: 1,
    schemaId: 'synthetic:credentials',
    fields: { name: 'external', note: 'external', password: 'secret', token: 'secret' }
  };
  const raw = {
    name: 'Synthetic Vendor',
    note: 'call with password=Sup3rSecret! before shipping',
    password: 'Sup3rSecret!',
    token: 'sk-TESTCANARY12345678'
  };
  const before = JSON.stringify(raw);
  for (const profile of privacy.PROFILES) {
    const out = privacy.applyProfile(raw, policy, profile);
    assert.equal(out.password, undefined, `${profile} must drop the password field`);
    assert.equal(out.token, undefined, `${profile} must drop the token field`);
    assert.ok(!JSON.stringify(out).includes('Sup3rSecret'), `${profile} must not carry the password value`);
    assert.ok(!JSON.stringify(out).includes('sk-'), `${profile} must not carry the token value`);
    assert.ok(!out.note.includes('Sup3rSecret'), `${profile} scrubs secret-shaped text inside kept fields`);
  }
  const logCopy = privacy.redactForLog(raw, policy);
  assert.equal(logCopy.password, undefined);
  assert.ok(!JSON.stringify(logCopy).includes('Sup3rSecret'));
  assert.ok(!JSON.stringify(logCopy).includes('sk-'));
  assert.deepEqual(privacy.findCanaryHits(JSON.stringify(logCopy), ['Sup3rSecret', 'sk-TESTCANARY12345678']), []);
  assert.equal(JSON.stringify(raw), before, 'input unchanged');
});

test('empty or foreign policies never read inherited keys; explicit own-key classification still works', { skip }, () => {
  const emptyPolicy = { schemaVersion: 1, schemaId: 'synthetic:empty', fields: {} };
  const inherited = { toString: 'CANARY-INHERITED-001', valueOf: 'CANARY-INHERITED-002', hasOwnProperty: 'CANARY-INHERITED-003' };
  const before = JSON.stringify(inherited);
  const external = privacy.applyProfile(inherited, emptyPolicy, 'external-redacted');
  const logCopy = privacy.redactForLog(inherited, emptyPolicy);
  assert.deepEqual(external, {}, 'an empty policy emits nothing for undeclared own keys');
  assert.deepEqual(logCopy, {});
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'privacy-f1-'));
  const externalFile = path.join(dir, 'external.json');
  const logFile = path.join(dir, 'log.json');
  fs.writeFileSync(externalFile, JSON.stringify(external));
  fs.writeFileSync(logFile, JSON.stringify(logCopy));
  const serialized = fs.readFileSync(externalFile, 'utf8') + fs.readFileSync(logFile, 'utf8');
  for (const marker of ['CANARY-INHERITED-001', 'CANARY-INHERITED-002', 'CANARY-INHERITED-003']) {
    assert.ok(!serialized.includes(marker), `${marker} must not reach any serialized output`);
  }
  const declared = privacy.applyProfile({ toString: 'own safe' }, { ...emptyPolicy, fields: { toString: 'external' } }, 'external-redacted');
  assert.equal(declared.toString, 'own safe', 'an explicit own-key classification still works');
  assert.ok(Object.prototype.hasOwnProperty.call(declared, 'toString'));
  assert.equal(typeof ({}).toString, 'function', 'Object.prototype untouched');
  assert.equal(JSON.stringify(inherited), before, 'input unchanged');
});

test('literal dotted keys are rejected as ambiguous; nested and array paths keep working', { skip }, () => {
  const policy = { schemaVersion: 1, schemaId: 'synthetic:dot-path', fields: { 'company.name': 'external', 'contacts.email': 'internal' } };
  const dotted = { 'company.name': 'CANARY-DOTTED-001', company: { name: 'Synthetic Allowed' } };
  const before = JSON.stringify(dotted);
  assert.throws(() => privacy.applyProfile(dotted, policy, 'external-redacted'), /literal key containing a dot/, 'a literal dotted key must be rejected before output');
  assert.throws(() => privacy.redactForLog(dotted, policy), /literal key containing a dot/);
  assert.equal(JSON.stringify(dotted), before, 'raw stays complete on rejection');
  const nested = { company: { name: 'Synthetic Allowed' }, contacts: [{ email: 'fake@example.invalid' }] };
  assert.deepEqual(privacy.applyProfile(nested, policy, 'external-redacted'), { company: { name: 'Synthetic Allowed' } }, 'legitimate nested path works');
  assert.deepEqual(privacy.applyProfile(nested, policy, 'internal-full').contacts, [{ email: 'fake@example.invalid' }], 'array path works');
  const deepDotted = { wrapper: { 'a.b': 'CANARY-DOTTED-002' } };
  assert.throws(() => privacy.applyProfile(deepDotted, policy, 'internal-full'), /literal key containing a dot/, 'nested dotted literal keys are rejected too');
});

test('containers are upper bounds only; unclassified leaves fail closed and stricter parents cannot be downgraded', { skip }, () => {
  const policy = {
    schemaVersion: 1,
    schemaId: 'synthetic:bounds',
    fields: { contacts: 'internal', 'contacts.email': 'external', supplier: 'private', 'supplier.unitCost': 'external', 'company.name': 'external' }
  };
  const raw = {
    company: { name: 'Synthetic Allowed' },
    contacts: [{ email: 'fake@example.invalid', salaryNote: 'CANARY-UNKNOWN-CONTACT-001' }],
    supplier: { unitCost: 16, internalNote: 'CANARY-UNKNOWN-COST-001' }
  };
  const before = JSON.stringify(raw);
  const external = privacy.applyProfile(raw, policy, 'external-redacted');
  assert.deepEqual(external, { company: { name: 'Synthetic Allowed' } }, 'internal/private containers never reach external');
  const internal = privacy.applyProfile(raw, policy, 'internal-full');
  assert.deepEqual(internal.contacts, [{ email: 'fake@example.invalid' }], 'explicitly classified contact kept; unclassified sibling suppressed');
  assert.deepEqual(internal.supplier, { unitCost: 16 }, 'explicitly classified cost kept; unclassified sibling suppressed');
  const logCopy = privacy.redactForLog(raw, policy);
  assert.equal(logCopy.contacts, '[redacted]', 'internal container is redacted in logs');
  assert.equal(logCopy.supplier, undefined, 'private container is dropped from logs');

  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'privacy-f3-'));
  const externalFile = path.join(dir, 'external.json');
  const logFile = path.join(dir, 'log.json');
  const internalFile = path.join(dir, 'internal.json');
  fs.writeFileSync(externalFile, JSON.stringify(external));
  fs.writeFileSync(logFile, JSON.stringify(logCopy));
  fs.writeFileSync(internalFile, JSON.stringify(internal));
  for (const [name, file] of [['external', externalFile], ['log', logFile]]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const marker of ['CANARY-UNKNOWN-CONTACT-001', 'CANARY-UNKNOWN-COST-001', 'salaryNote', 'internalNote', 'unitCost', 'CNY']) {
      assert.ok(!text.includes(marker), `${name} must not contain ${marker}`);
    }
  }
  const internalText = fs.readFileSync(internalFile, 'utf8');
  assert.ok(internalText.includes('fake@example.invalid') && internalText.includes('unitCost'), 'internal-full keeps the explicitly classified contact and cost');
  assert.ok(!internalText.includes('CANARY-UNKNOWN-CONTACT-001') && !internalText.includes('CANARY-UNKNOWN-COST-001'), 'unclassified leaves never serialize');

  const secretPolicy = { schemaVersion: 1, schemaId: 'synthetic:secret-parent', fields: { vault: 'secret', 'vault.label': 'external' } };
  const secretRaw = { vault: { label: 'CANARY-SECRET-CHILD-001' } };
  assert.deepEqual(privacy.applyProfile(secretRaw, secretPolicy, 'external-redacted'), {}, 'a secret parent cannot be downgraded by an external child');
  assert.deepEqual(privacy.applyProfile(secretRaw, secretPolicy, 'internal-full'), {});
  assert.deepEqual(privacy.redactForLog(secretRaw, secretPolicy), {});

  const containerPolicy = { schemaVersion: 1, schemaId: 'synthetic:container', fields: { bundle: 'external', 'bundle.label': 'external' } };
  const containerRaw = { bundle: { label: 'Synthetic Allowed', undocumentedEmail: 'CANARY-CONTAINER-001@example.invalid', cost: 12.5 } };
  assert.deepEqual(privacy.applyProfile(containerRaw, containerPolicy, 'external-redacted'), { bundle: { label: 'Synthetic Allowed' } }, 'an external container does not authorize undocumented leaves');
  assert.deepEqual(privacy.redactForLog(containerRaw, containerPolicy), { bundle: { label: 'Synthetic Allowed' } });
  assert.equal(JSON.stringify(raw), before, 'input unchanged');
});

test('empty own keys are rejected before output in both profiles and logs; legal nested and array paths keep working', { skip }, () => {
  const policy = { schemaVersion: 1, schemaId: 'synthetic:empty-key', fields: { 'company.name': 'external', 'contacts.email': 'internal' } };
  const wrapped = { '': { company: { name: 'CANARY-EMPTY-KEY-001' } } };
  const before = JSON.stringify(wrapped);
  assert.throws(() => privacy.applyProfile(wrapped, policy, 'external-redacted'), /empty literal key/, 'external-redacted rejects the empty-key object before output');
  assert.throws(() => privacy.applyProfile(wrapped, policy, 'internal-full'), /empty literal key/, 'internal-full rejects it too');
  assert.throws(() => privacy.redactForLog(wrapped, policy), /empty literal key/, 'the log filter rejects it too');
  assert.equal(JSON.stringify(wrapped), before, 'raw snapshot stays complete');
  const deepEmpty = { company: { '': { name: 'CANARY-EMPTY-KEY-002' } } };
  assert.throws(() => privacy.applyProfile(deepEmpty, policy, 'external-redacted'), /empty literal key/, 'empty keys are rejected at every level');
  const nested = { company: { name: 'Synthetic Allowed' }, contacts: [{ email: 'fake@example.invalid' }] };
  assert.deepEqual(privacy.applyProfile(nested, policy, 'external-redacted'), { company: { name: 'Synthetic Allowed' } }, 'legal nested path still works');
  const internal = privacy.applyProfile(nested, policy, 'internal-full');
  assert.deepEqual(internal.contacts, [{ email: 'fake@example.invalid' }], 'array contact kept in internal-full');
  assert.equal(privacy.applyProfile(nested, policy, 'external-redacted').contacts, undefined, 'array contact stripped externally');
});
