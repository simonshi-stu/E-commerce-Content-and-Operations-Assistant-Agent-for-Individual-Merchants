'use strict';
/**
 * T1.2 — ProductPassport / SKU variant repository tests.
 *
 * Real SQLite path with the private tmp from $COMMERCE_TEST_TMP (never writes inside [W], never
 * os.tmpdir, never real materials). Skipped explicitly when the env var is not set.
 * Synthetic fixtures only; no product-specific data in code (grep-checked separately).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const W = path.join(__dirname, '..', '..');
const { CORE_TABLES, openDb, migrateUp, migrateDown, listApplied } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const core = require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js'));
const m0002 = require(path.join(W, 'lib', 'commerce', 'migrations', '0002_passport_sku.js'));
const repo = require(path.join(W, 'lib', 'commerce', 'passports.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.2 tests write only to the private runtime tmp';

function freshDb(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `passports-${label}-`));
  const dbPath = path.join(dir, 'commerce.db');
  const db = openDb(dbPath);
  migrateUp(db, [core, m0002]);
  return { dbPath, db };
}

test('migration 0002 applies without touching the 0001 ledger row, and down/up round-trips', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'passports-mig-'));
  const db = openDb(path.join(dir, 'commerce.db'));
  assert.deepEqual(migrateUp(db, [core]), [1]);
  const ledgerRow1 = listApplied(db).find((row) => row.version === 1);
  assert.deepEqual(migrateUp(db, [core, m0002]), [2]);
  const ledgerRows = listApplied(db);
  assert.deepEqual(ledgerRows.map((row) => row.version), [1, 2]);
  assert.equal(ledgerRows.find((row) => row.version === 1).checksum, ledgerRow1.checksum, '0001 ledger row must remain unchanged');
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const column of ['title', 'category_pack_key', 'source_summary_json', 'deleted_at']) assert.ok(columns('product_passports').has(column), `missing product_passports.${column}`);
  for (const column of ['variant_key', 'deleted_at']) assert.ok(columns('skus').has(column), `missing skus.${column}`);
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => r.name));
  for (const name of ['product_aliases', 'entity_versions', 'ux_skus_project_passport_variant', 'ux_alias_project_norm']) assert.ok(names.has(name), `missing ${name}`);
  assert.deepEqual(migrateDown(db, [core, m0002], { to: 1 }), [2]);
  const afterDown = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => r.name));
  assert.ok(!afterDown.has('entity_versions') && !afterDown.has('product_aliases'));
  for (const table of CORE_TABLES) assert.ok(afterDown.has(table), `0001 table lost on 0002 down: ${table}`);
  assert.deepEqual(listApplied(db).map((row) => row.version), [1]);
  assert.deepEqual(migrateUp(db, [core, m0002]), [2]);
  assert.deepEqual(migrateUp(db, [core, m0002]), []);
  db.close();
});

test('passport create -> read -> update(new version) -> soft delete keeps history readable', { skip }, () => {
  const { db } = freshDb('lifecycle');
  const created = repo.createPassport(db, 'proj-a', {
    title: 'Compact camera glasses', brandKey: null, productFamilyKey: 'family-1', nickname: 'nick-1',
    category: 'smart-glasses', categoryPackKey: 'smart-glasses/default', sources: [{ sourceType: 'user_statement', note: 'initial dossier' }]
  });
  assert.equal(created.status, 'draft');
  assert.equal(created.version, 1);
  assert.equal(created.brand_key, null);
  assert.deepEqual(JSON.parse(created.source_summary_json), [{ sourceType: 'user_statement', note: 'initial dossier' }]);
  assert.equal(repo.getPassport(db, 'proj-a', created.id).id, created.id);

  const updated = repo.updatePassport(db, 'proj-a', created.id, { title: 'Compact camera glasses v2', brandKey: 'brandX' });
  assert.equal(updated.version, 2);
  assert.equal(updated.title, 'Compact camera glasses v2');
  assert.equal(updated.brand_key, 'brandX');

  const confirmed = repo.confirmPassport(db, 'proj-a', created.id);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.version, 3);
  assert.equal(repo.confirmPassport(db, 'proj-a', created.id).version, 3, 'confirm is idempotent');

  const deleted = repo.softDeletePassport(db, 'proj-a', created.id);
  assert.equal(deleted.status, 'archived');
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.version, 4);
  assert.equal(repo.getPassport(db, 'proj-a', created.id), null, 'default reads exclude deleted');
  assert.equal(repo.getPassport(db, 'proj-a', created.id, { includeDeleted: true }).id, created.id);
  assert.equal(repo.softDeletePassport(db, 'proj-a', created.id).version, 4, 'soft delete is idempotent');
  assert.throws(() => repo.updatePassport(db, 'proj-a', created.id, { title: 'x' }), /archived passport cannot be updated/);

  const versions = repo.getPassportVersions(db, 'proj-a', created.id);
  assert.deepEqual(versions.map((v) => v.version), [1, 2, 3, 4]);
  assert.deepEqual(versions.map((v) => v.change_kind), ['create', 'update', 'update', 'soft_delete']);
  assert.equal(JSON.parse(versions[0].snapshot_json).title, 'Compact camera glasses');
  assert.equal(JSON.parse(versions[3].snapshot_json).status, 'archived', 'soft-deleted row remains readable in history');
  db.close();
});

test('SKU variant uniqueness is canonical: attribute key order never creates a second variant', { skip }, () => {
  const { db } = freshDb('variant');
  const passport = repo.createPassport(db, 'proj-a', { title: 'P', productFamilyKey: 'f-1', category: 'smart-glasses' });
  const first = repo.createSku(db, 'proj-a', passport.id, { skuCode: 'code-1', attributes: { color: 'black', lens: 'clear' } });
  assert.equal(first.variant_key, repo.canonicalVariantKey({ lens: 'clear', color: 'black' }), 'canonical key ignores key order');
  assert.equal(first.attributes_json, '{"color":"black","lens":"clear"}', 'stored attributes are canonicalized');
  assert.throws(
    () => repo.createSku(db, 'proj-a', passport.id, { skuCode: 'code-2', attributes: { lens: 'clear', color: 'black' } }),
    /same canonical variant/
  );
  const other = repo.createSku(db, 'proj-a', passport.id, { skuCode: 'code-3', attributes: { color: 'white', lens: 'clear' } });
  assert.notEqual(other.variant_key, first.variant_key);
  assert.throws(() => repo.createSku(db, 'proj-a', passport.id, { skuCode: 'code-1', attributes: { color: 'blue' } }), /duplicate SKU code/);
  const versions = repo.getSkuVersions(db, 'proj-a', first.id);
  assert.deepEqual(versions.map((v) => v.change_kind), ['create']);
  db.close();
});

test('archived passport blocks SKU updates without touching data or history', { skip }, () => {
  const { db } = freshDb('archived-parent');
  const passport = repo.createPassport(db, 'proj-a', { title: 'P', productFamilyKey: 'f-1', category: 'smart-glasses' });
  const sku = repo.createSku(db, 'proj-a', passport.id, { skuCode: 'code-1', attributes: { color: 'grey', hardware: 'standard' } });
  repo.updateSku(db, 'proj-a', sku.id, { attributes: { color: 'blue', hardware: 'standard' } }); // v2
  repo.softDeletePassport(db, 'proj-a', passport.id);

  const before = repo.getSku(db, 'proj-a', sku.id, { includeDeleted: true });
  const versionsBefore = repo.getSkuVersions(db, 'proj-a', sku.id).length;
  let refused = null;
  try {
    repo.updateSku(db, 'proj-a', sku.id, { attributes: { color: 'red', hardware: 'standard' } });
  } catch (error) { refused = error; }
  assert.ok(refused, 'updating a SKU under an archived passport must be refused');
  assert.match(String(refused.message), /passport is archived/);
  assert.equal(refused.code, 'conflict');
  const after = repo.getSku(db, 'proj-a', sku.id, { includeDeleted: true });
  assert.deepEqual(after, before, 'SKU row must be unchanged');
  assert.equal(after.version, 2);
  assert.equal(repo.getSkuVersions(db, 'proj-a', sku.id).length, versionsBefore, 'no new history rows');
  assert.equal(repo.getSku(db, 'proj-a', sku.id).id, sku.id, 'existing child stays readable by id');

  // a live passport still allows SKU updates
  const live = repo.createPassport(db, 'proj-a', { title: 'L', productFamilyKey: 'f-2', category: 'smart-glasses' });
  const liveSku = repo.createSku(db, 'proj-a', live.id, { skuCode: 'code-2', attributes: { color: 'grey' } });
  assert.equal(repo.updateSku(db, 'proj-a', liveSku.id, { attributes: { color: 'blue' } }).version, 2);
  db.close();
});

test('proto-named attributes are preserved and non-JSON values are rejected explicitly', { skip }, () => {
  const { db } = freshDb('proto-safe');
  const passport = repo.createPassport(db, 'proj-a', { title: 'P', productFamilyKey: 'f-1', category: 'generic-optics' });

  const attrs = JSON.parse('{"color":"white","__proto__":{"configuration":"special"}}');
  const serialized = repo.canonicalAttributesJson(attrs);
  const parsed = JSON.parse(serialized);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), 'own __proto__ key must survive canonicalization');
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, '__proto__').value, { configuration: 'special' });
  assert.equal(parsed.color, 'white');
  assert.notEqual(repo.canonicalVariantKey(attrs), repo.canonicalVariantKey({ color: 'white' }), 'a __proto__ dimension must change the variant key');
  assert.notEqual(repo.canonicalVariantKey(attrs), repo.canonicalVariantKey(JSON.parse('{"color":"white","__proto__":{"configuration":"other"}}')));

  const sku = repo.createSku(db, 'proj-a', passport.id, { skuCode: 'proto-1', attributes: attrs });
  assert.ok(sku.attributes_json.includes('__proto__'), 'stored canonical JSON keeps the dimension');
  assert.throws(() => repo.createSku(db, 'proj-a', passport.id, { skuCode: 'proto-2', attributes: attrs }), /same canonical variant/);

  const circular = { color: 'white' };
  circular.self = circular;
  const rejects = [
    [{ x: Number.NaN }, /not a finite number/],
    [{ x: Number.POSITIVE_INFINITY }, /not a finite number/],
    [{ x: undefined }, /is undefined/],
    [{ x: () => 1 }, /unsupported type function/],
    [{ x: BigInt(10) }, /unsupported type bigint/],
    [{ x: new Date() }, /must be a plain JSON object/],
    [circular, /circular reference/]
  ];
  for (const [bad, pattern] of rejects) {
    assert.throws(() => repo.canonicalVariantKey(bad), pattern);
    assert.throws(() => repo.createSku(db, 'proj-a', passport.id, { skuCode: 'bad', attributes: bad }), pattern);
  }
  assert.equal(repo.listSkus(db, 'proj-a', passport.id).length, 1, 'rejections must not write rows');
  db.close();
});

test('cross-project access is refused and scoped reads isolate projects', { skip }, () => {
  const { db } = freshDb('isolation');
  const a = repo.createPassport(db, 'proj-a', { title: 'A', productFamilyKey: 'f-a', category: 'smart-glasses' });
  assert.equal(repo.getPassport(db, 'proj-b', a.id), null, 'other project cannot read');
  assert.throws(() => repo.updatePassport(db, 'proj-b', a.id, { title: 'hijack' }), /not found in this project/);
  assert.throws(() => repo.softDeletePassport(db, 'proj-b', a.id), /not found in this project/);
  assert.throws(() => repo.createSku(db, 'proj-b', a.id, { skuCode: 'x', attributes: { c: 1 } }), /not found in this project/);
  assert.throws(() => repo.addAlias(db, 'proj-b', a.id, 'alias-x'), /not found in this project/);
  const sku = repo.createSku(db, 'proj-a', a.id, { skuCode: 'code-a', attributes: { c: 1 } });
  assert.equal(repo.getSku(db, 'proj-b', sku.id), null);
  assert.throws(() => repo.updateSku(db, 'proj-b', sku.id, { skuCode: 'y' }), /not found in this project/);
  assert.deepEqual(repo.getEntityVersions(db, 'proj-b', 'passport', a.id), [], 'history is project-scoped');
  assert.deepEqual(repo.listPassports(db, 'proj-b'), []);
  assert.equal(repo.listPassports(db, 'proj-a').length, 1);
  db.close();
});

test('status transitions: draft -> confirmed; archived is read-only; invalid status patch rejected', { skip }, () => {
  const { db } = freshDb('status');
  const passport = repo.createPassport(db, 'proj-a', { title: 'P', productFamilyKey: 'f-1', category: 'smart-glasses' });
  assert.throws(() => repo.updatePassport(db, 'proj-a', passport.id, { status: 'confirmed' }), /status is changed via/);
  repo.confirmPassport(db, 'proj-a', passport.id);
  const archived = repo.softDeletePassport(db, 'proj-a', passport.id);
  assert.equal(archived.status, 'archived');
  assert.throws(() => repo.confirmPassport(db, 'proj-a', passport.id), /archived passport cannot be confirmed/);
  assert.throws(() => repo.createSku(db, 'proj-a', passport.id, { skuCode: 'late', attributes: { c: 1 } }), /archived passport/);
  assert.equal(repo.listPassports(db, 'proj-a', { status: 'draft' }).length, 0);
  assert.equal(repo.listPassports(db, 'proj-a', { includeDeleted: true }).length, 1);
  db.close();
});

test('unbranded passports stay independent entities and a second category models the same way', { skip }, () => {
  const { db } = freshDb('categories');
  const one = repo.createPassport(db, 'proj-a', { title: 'Unbranded one', productFamilyKey: 'family-one', category: 'smart-glasses' });
  const two = repo.createPassport(db, 'proj-a', { title: 'Unbranded two', productFamilyKey: 'family-two', category: 'smart-glasses' });
  assert.equal(one.brand_key, null);
  assert.equal(two.brand_key, null);
  assert.notEqual(one.id, two.id, 'separate unbranded entities are never merged');
  assert.throws(() => repo.createPassport(db, 'proj-a', { title: 'dup', productFamilyKey: 'family-one', category: 'smart-glasses' }), /product family already exists/);

  const dog = repo.createPassport(db, 'proj-a', {
    title: 'Open-dialog robot companion', brandKey: null, productFamilyKey: 'robot-1', category: 'ai-robot-dog',
    sources: [{ sourceType: 'user_statement', note: 'open-ended AI dialogue confirmed by user; language/network NOT inferred' }]
  });
  const dogSku = repo.createSku(db, 'proj-a', dog.id, { skuCode: 'robot-standard', attributes: { color: 'grey', battery: 'standard' } });
  assert.equal(dogSku.product_passport_id, dog.id);
  assert.equal((JSON.parse(dog.source_summary_json)[0].note).includes('NOT inferred'), true);
  db.close();
});

test('aliases: unconfirmed do not resolve, confirmed map within project, duplicates normalized, removal works', { skip }, () => {
  const { db } = freshDb('aliases');
  const passport = repo.createPassport(db, 'proj-a', { title: 'P', productFamilyKey: 'f-1', category: 'smart-glasses' });
  const candidate = repo.addAlias(db, 'proj-a', passport.id, '  Family Alpha  ');
  assert.equal(candidate.alias_normalized, 'family alpha');
  assert.equal(candidate.confirmed, 0);
  assert.equal(repo.resolvePassportByAlias(db, 'proj-a', 'family alpha'), null, 'unconfirmed alias must not resolve');
  assert.equal(repo.resolvePassportByAlias(db, 'proj-a', 'family alpha', { requireConfirmed: false }).id, passport.id, 'candidate visible for review only');
  const confirmed = repo.confirmAlias(db, 'proj-a', candidate.id);
  assert.equal(confirmed.confirmed, 1);
  assert.equal(repo.resolvePassportByAlias(db, 'proj-a', 'FAMILY  alpha').id, passport.id, 'normalization ignores case/extra spaces');
  assert.throws(() => repo.addAlias(db, 'proj-a', passport.id, 'family  ALPHA'), /already mapped/);
  assert.equal(repo.resolvePassportByAlias(db, 'proj-b', 'family alpha'), null, 'alias resolution is project-scoped');
  repo.removeAlias(db, 'proj-a', candidate.id);
  assert.equal(repo.resolvePassportByAlias(db, 'proj-a', 'family alpha'), null);
  const again = repo.addAlias(db, 'proj-a', passport.id, 'family alpha', { confirmed: true });
  assert.equal(repo.resolvePassportByAlias(db, 'proj-a', 'family alpha').id, passport.id, 'alias can be re-added after removal');
  assert.deepEqual(repo.listAliases(db, 'proj-a', passport.id).map((row) => row.id), [again.id]);
  db.close();
});

test('entity history is append-only and project-scoped (no version overwrite)', { skip }, () => {
  const { db } = freshDb('history');
  const passport = repo.createPassport(db, 'proj-a', { title: 'P', productFamilyKey: 'f-1', category: 'smart-glasses' });
  repo.updatePassport(db, 'proj-a', passport.id, { title: 'P2' });
  const versions = repo.getEntityVersions(db, 'proj-a', 'passport', passport.id);
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  assert.throws(
    () => db.prepare(`INSERT INTO entity_versions (id, project_id, entity_type, entity_id, version, status, change_kind, snapshot_json, created_at)
      VALUES ('ev-dup', 'proj-a', 'passport', ?, 1, 'draft', 'create', '{}', '2026-10-08')`).run(passport.id),
    /UNIQUE/i
  );
  db.close();
});
