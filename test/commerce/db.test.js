'use strict';
/**
 * T1.1 — SQLite migration framework + core schema tests.
 *
 * Writes ONLY under $COMMERCE_TEST_TMP (the private runtime tmp passed by the executor).
 * Never writes inside [W], never to os.tmpdir, never to real materials. If the env var is not
 * set, all tests are skipped with an explicit reason (so an unrelated full-suite run is not broken).
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { CORE_TABLES, openDb, migrateUp, migrateDown, listApplied, backupTo, verifyDatabaseFile, migrationChecksum } = require(path.join(__dirname, '..', '..', 'lib', 'commerce', 'db.js'));
const core = require(path.join(__dirname, '..', '..', 'lib', 'commerce', 'migrations', '0001_core.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T1.1 tests write only to the private runtime tmp';

function makeDir(label) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `db-test-${label}-`));
  return dir;
}

function freshDb(label) {
  const dbPath = path.join(makeDir(label), 'commerce.db');
  return { dbPath, db: openDb(dbPath) };
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

const nowIso = '2026-10-08T00:00:00.000Z';

function insertPassport(db, id, project = 'proj-a', family = `fam-${id}`) {
  db.prepare(`INSERT INTO product_passports (id, project_id, product_family_key, nickname, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, project, family, `nick-${id}`, 'smart-glasses', nowIso, nowIso);
}

function insertSku(db, id, passportId, project = 'proj-a', code = `sku-${id}`) {
  db.prepare(`INSERT INTO skus (id, project_id, product_passport_id, sku_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, project, passportId, code, nowIso, nowIso);
}

test('up creates ledger + ten core tables with WAL/foreign_keys pragmas', { skip }, () => {
  const { db } = freshDb('up');
  const ran = migrateUp(db, [core]);
  assert.deepEqual(ran, [1]);
  const names = tableNames(db);
  for (const table of [...CORE_TABLES, 'schema_migrations']) assert.ok(names.has(table), `missing table ${table}`);
  const ledger = listApplied(db);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].version, 1);
  assert.equal(ledger[0].name, 'core');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
});

test('repeated up is idempotent (no-op second run)', { skip }, () => {
  const { db } = freshDb('idem');
  assert.deepEqual(migrateUp(db, [core]), [1]);
  assert.deepEqual(migrateUp(db, [core]), []);
  assert.equal(listApplied(db).length, 1);
  db.close();
});

test('checksum drift on an applied migration is rejected', { skip }, () => {
  const { db } = freshDb('checksum');
  migrateUp(db, [core]);
  const tampered = { ...core, sql: `${core.sql}\n-- tampered` };
  assert.throws(() => migrateUp(db, [tampered]), /checksum mismatch/);
  db.close();
});

test('foreign keys: unknown parent and cross-project parent are both rejected', { skip }, () => {
  const { db } = freshDb('fk');
  migrateUp(db, [core]);
  insertPassport(db, 'p1', 'proj-a');
  assert.throws(() => insertSku(db, 's1', 'missing', 'proj-a'), /FOREIGN KEY/i);
  // cross-project reference: sku in proj-b pointing at proj-a's passport must fail
  assert.throws(() => insertSku(db, 's2', 'p1', 'proj-b'), /FOREIGN KEY/i);
  insertSku(db, 's3', 'p1', 'proj-a');
  // deleting a parent that still has children is refused (RESTRICT/NO ACTION)
  assert.throws(() => db.prepare('DELETE FROM product_passports WHERE id = ?').run('p1'), /FOREIGN KEY/i);
  db.close();
});

test('orphan FK rows are detected by verifyDatabaseFile (foreign_key_check)', { skip }, () => {
  const { dbPath, db } = freshDb('orphan');
  migrateUp(db, [core]);
  insertPassport(db, 'p1');
  // orphan insert requires enforcement OFF on this connection only
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(`INSERT INTO skus (id, project_id, product_passport_id, sku_code, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('s-orphan', 'proj-a', 'missing-parent', 'code-x', nowIso, nowIso);
  db.close();
  const clean = verifyDatabaseFile(dbPath, { expectedTables: CORE_TABLES });
  assert.equal(clean.ok, false, `orphan DB must not verify ok: ${JSON.stringify(clean)}`);
  assert.ok(clean.fkViolations >= 1, JSON.stringify(clean));
});

test('unique constraints: per-project dedup, cross-project isolation positive', { skip }, () => {
  const { db } = freshDb('unique');
  migrateUp(db, [core]);
  insertPassport(db, 'p1', 'proj-a', 'fam-1');
  insertPassport(db, 'p2', 'proj-b', 'fam-1'); // same family key in another project is allowed
  insertSku(db, 's1', 'p1', 'proj-a', 'code-1');
  assert.throws(() => insertSku(db, 's1b', 'p1', 'proj-a', 'code-1'), /UNIQUE/i);
  db.prepare(`INSERT INTO evidence (id, project_id, source_type, sha256, created_at) VALUES (?, ?, ?, ?, ?)`).run('e1', 'proj-a', 'page', 'a'.repeat(64), nowIso);
  assert.throws(
    () => db.prepare(`INSERT INTO evidence (id, project_id, source_type, sha256, created_at) VALUES (?, ?, ?, ?, ?)`).run('e2', 'proj-a', 'page', 'a'.repeat(64), nowIso),
    /UNIQUE/i
  );
  db.prepare(`INSERT INTO company_leads (id, project_id, name, domain, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('c1', 'proj-a', 'A', 'a.example', 'web', nowIso, nowIso);
  assert.throws(
    () => db.prepare(`INSERT INTO company_leads (id, project_id, name, domain, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('c2', 'proj-a', 'B', 'a.example', 'web', nowIso, nowIso),
    /UNIQUE/i
  );
  db.close();
});

test('check constraints: run status and memory-rule scope enums are enforced', { skip }, () => {
  const { db } = freshDb('check');
  migrateUp(db, [core]);
  assert.throws(
    () => db.prepare(`INSERT INTO runs (id, project_id, task_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run('r1', 'proj-a', 'research', 'not-a-status', nowIso, nowIso),
    /CHECK/i
  );
  db.prepare(`INSERT INTO runs (id, project_id, task_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run('r2', 'proj-a', 'research', 'queued', nowIso, nowIso);
  assert.throws(
    () => db.prepare(`INSERT INTO memory_rules (id, project_id, scope, scope_key, rule_key, rule_value_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('m1', 'proj-a', 'bad-scope', 'k', 'rk', 'v', nowIso),
    /CHECK/i
  );
  db.close();
});

test('a failing migration rolls back completely (no partial table, no ledger row)', { skip }, () => {
  const { db } = freshDb('rollback');
  const bad = {
    version: 99,
    name: 'bad',
    sql: 'CREATE TABLE partial_99 (x);\nTHIS IS NOT SQL;',
    downSql: 'DROP TABLE IF EXISTS partial_99;'
  };
  assert.throws(() => migrateUp(db, [core, bad]), /rolled back/);
  const names = tableNames(db);
  assert.ok(!names.has('partial_99'), 'partial table must not survive');
  assert.ok(names.has('product_passports'), 'core migration must remain applied');
  assert.equal(listApplied(db).some((row) => row.version === 99), false, 'no ledger row for failed migration');
  assert.deepEqual(migrateUp(db, [core]), []); // still idempotent afterwards
  db.close();
});

test('down removes schema; up re-applies (round-trip)', { skip }, () => {
  const { db } = freshDb('down');
  migrateUp(db, [core]);
  const reverted = migrateDown(db, [core]);
  assert.deepEqual(reverted, [1]);
  const names = tableNames(db);
  for (const table of CORE_TABLES) assert.ok(!names.has(table), `table still present after down: ${table}`);
  assert.equal(listApplied(db).length, 0);
  assert.deepEqual(migrateUp(db, [core]), [1]);
  insertPassport(db, 'p-again');
  db.close();
});

test('fingerprint binds canonical executed SQL fields (changed up or down SQL differs)', { skip }, () => {
  assert.notEqual(migrationChecksum({ ...core, sql: `${core.sql}\n-- changed-up` }), migrationChecksum(core));
  assert.notEqual(migrationChecksum({ ...core, downSql: `${core.downSql}\n-- changed-down` }), migrationChecksum(core));
});

test('function-based migrations without canonical sql fields are refused', { skip }, () => {
  const { db } = freshDb('canonical-guard');
  const fnOnly = { version: 5, name: 'fn-only', up() {}, down() {} };
  assert.throws(() => migrateUp(db, [fnOnly]), /canonical sql/);
  const withFn = { version: 6, name: 'with-fn', sql: 'CREATE TABLE x6 (y)', downSql: 'DROP TABLE IF EXISTS x6', up() {} };
  assert.throws(() => migrateUp(db, [withFn]), /must not rely on up\(\)\/down\(\)/);
  assert.equal(listApplied(db).length, 0);
  db.close();
});

test('down refuses when the migration fingerprint changed (no drop, ledger intact)', { skip }, () => {
  const { db } = freshDb('down-refuse');
  migrateUp(db, [core]);
  // Change ONLY the canonical down SQL (the single source the coordinator executes for down).
  const tampered = { ...core, downSql: `${core.downSql}\nDROP TABLE product_passports;` };
  assert.notEqual(migrationChecksum(tampered), migrationChecksum(core));
  assert.throws(() => migrateDown(db, [tampered]), /fingerprint mismatch/);
  const names = tableNames(db);
  for (const table of CORE_TABLES) assert.ok(names.has(table), `table dropped despite refusal: ${table}`);
  assert.equal(listApplied(db).length, 1, 'ledger must remain intact after refusal');
  assert.deepEqual(migrateDown(db, [core]), [1]); // the correct definition still reverts
  db.close();
});

test('a failing down rolls back transactionally (table + ledger preserved)', { skip }, () => {
  const { db } = freshDb('down-fail');
  const temp = {
    version: 2,
    name: 'temp',
    sql: 'CREATE TABLE temp_v2 (x)',
    downSql: 'DROP TABLE temp_v2;\nTHIS IS NOT SQL;'
  };
  migrateUp(db, [core, temp]);
  assert.throws(() => migrateDown(db, [core, temp]), /rolled back/);
  assert.ok(tableNames(db).has('temp_v2'), 'down must roll back the drop');
  assert.deepEqual(listApplied(db).map((row) => row.version), [1, 2]);
  db.close();
});

test('consistent backup -> restore round-trip, and overwrite refusal', { skip }, () => {
  const { dbPath, db } = freshDb('restore');
  migrateUp(db, [core]);
  insertPassport(db, 'p1');
  insertSku(db, 's1', 'p1');
  db.prepare(`INSERT INTO observations (id, project_id, origin_type, approval_status, key, value_text, unit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('o1', 'proj-a', 'user_statement', 'user_confirmed', 'lens_color', '透明镜片', null, nowIso);

  const backupPath = path.join(path.dirname(dbPath), 'backups', 'commerce-backup.db');
  const out = backupTo(db, backupPath);
  assert.ok(fs.existsSync(out));
  const verified = verifyDatabaseFile(out, { expectedTables: CORE_TABLES });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.throws(() => backupTo(db, out), /refusing to overwrite/);

  const restored = openDb(out, { readOnly: true });
  const row = restored.prepare('SELECT value_text FROM observations WHERE id = ?').get('o1');
  assert.equal(row.value_text, '透明镜片');
  assert.throws(
    () => restored.prepare(`INSERT INTO runs (id, project_id, task_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('r9', 'proj-a', 'x', nowIso, nowIso),
    /readonly|read-only/i
  );
  restored.close();
  db.close();
});

test('backup CLI --verify rejects a database with orphan references', { skip }, () => {
  const dir = makeDir('cli-orphan');
  const dbPath = path.join(dir, 'orphan.db');
  const db = openDb(dbPath);
  migrateUp(db, [core]);
  insertPassport(db, 'p1');
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(`INSERT INTO skus (id, project_id, product_passport_id, sku_code, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('s-orphan', 'proj-a', 'missing-parent', 'code-x', nowIso, nowIso);
  db.close();
  const outPath = path.join(dir, 'orphan-backup.db');
  const cli = path.join(__dirname, '..', '..', 'scripts', 'commerce', 'backup-db.js');
  const res = cp.spawnSync(process.execPath, [cli, '--db', dbPath, '--out', outPath, '--verify'], { encoding: 'utf8' });
  assert.equal(res.status, 1, `CLI must fail for orphan DB\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.verify.ok, false);
  assert.ok(parsed.verify.fkViolations >= 1, JSON.stringify(parsed.verify));
});

test('corrupted or non-database backup files are detected', { skip }, () => {
  const { dbPath, db } = freshDb('corrupt');
  migrateUp(db, [core]);
  const good = backupTo(db, path.join(path.dirname(dbPath), 'good.db'));
  db.close();

  const truncatedPath = path.join(path.dirname(dbPath), 'truncated.db');
  const bytes = fs.readFileSync(good);
  fs.writeFileSync(truncatedPath, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const truncated = verifyDatabaseFile(truncatedPath, { expectedTables: CORE_TABLES });
  assert.equal(truncated.ok, false, `truncated file must fail verification: ${JSON.stringify(truncated)}`);

  const textPath = path.join(path.dirname(dbPath), 'not-a-db.db');
  fs.writeFileSync(textPath, 'this is not a sqlite database at all');
  const text = verifyDatabaseFile(textPath, { expectedTables: CORE_TABLES });
  assert.equal(text.ok, false, `non-db file must fail verification: ${JSON.stringify(text)}`);
});
