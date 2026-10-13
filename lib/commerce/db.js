'use strict';
/**
 * commerce persistence layer — SQLite migration framework + connection/backup helpers (T1.1).
 *
 * Driver: built-in `node:sqlite` (DatabaseSync / StatementSync).
 * Why: no new dependency is approved for installation (T0.2 list approved nothing to install;
 * `better-sqlite3` install is NOT approved), and this runtime provides the module without a flag.
 * Risk note (honest, no version-based production claims): `node:sqlite` is a relatively new
 * Node API. On the current runtime (Node v24.18.0) it loaded without `--experimental-*` flags and
 * emitted no ExperimentalWarning in this environment, but this project does NOT declare it
 * production-stable from that observation alone; T1.1 evidence is limited to local engineering
 * fixtures. Re-evaluate on every Node upgrade and record the actual version with any result.
 *
 * Conventions (T0.3):
 * - private DB files live under [P]\runtime\db\ — never inside [W], never reachable from public/.
 * - every migration runs in its own BEGIN IMMEDIATE transaction together with its
 *   `schema_migrations` ledger row; failure rolls back both (no half table, no half ledger row).
 * - WAL for writer connections; never rename an open db; backups use the driver-supported
 *   consistent API (VACUUM INTO snapshot that includes WAL content) — never a busy file copy.
 * - Development task state (PROGRESS.json) is unrelated to the business `runs` TABLE state.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CORE_TABLES = [
  'product_passports',
  'skus',
  'evidence',
  'observations',
  'company_leads',
  'creative_briefs',
  'assets',
  'runs',
  'memory_rules',
  'feedback'
];

/** Open a database with the project pragmas. */
function openDb(dbPath, options = {}) {
  const { createDir = true, readOnly = false } = options;
  const resolved = path.resolve(dbPath);
  if (!readOnly && createDir) fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved, { readOnly });
  db.exec('PRAGMA foreign_keys = ON');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}

function ensureMigrationLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

/**
 * Migration fingerprint (checksum format v3): binds version, name and the canonical executed SQL
 * fields (`sql` for up, `downSql` for down) — the ONLY SQL the coordinator ever executes.
 * Function-based migrations are never executed (see requireCanonicalMigration), so SQL cannot hide
 * in a closure the fingerprint fails to cover (revision-02 correction: the v2 formula hashed
 * `down.toString()`, which did not capture closed-over SQL — e.g. a changed `DOWN_SQL` constant
 * kept the same function text and the same checksum while different SQL executed).
 * Compatibility: ledgers written with v1 (up SQL only) or v2 (weak down binding) will NOT match;
 * mismatches are rejected explicitly and ledgers are never auto-rewritten. Rebuild the isolated
 * fixture or add a forward corrective migration.
 */
function migrationChecksum(migration) {
  const source = `${migration.version}|${migration.name}|${migration.sql || ''}|${migration.downSql || ''}`;
  return crypto.createHash('sha256').update(source).digest('hex');
}

/** Only canonical SQL fields are executed; arbitrary up()/down() functions are refused outright. */
function requireCanonicalMigration(migration) {
  if (!migration || typeof migration.sql !== 'string' || migration.sql.length === 0 || typeof migration.downSql !== 'string' || migration.downSql.length === 0) {
    throw new Error(`migration ${migration && migration.version} must expose canonical sql and downSql strings; function-based migrations are not executed`);
  }
  if (typeof migration.up === 'function' || typeof migration.down === 'function') {
    throw new Error(`migration ${migration.version} must not rely on up()/down() functions; expose canonical sql/downSql fields only`);
  }
}

function listApplied(db) {
  ensureMigrationLedger(db);
  return db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').all();
}

/**
 * Apply pending migrations in order. Idempotent: already-applied versions are skipped, but a
 * checksum drift (edited historical migration) is an error.
 * Returns array of applied versions this call.
 */
function migrateUp(db, migrations) {
  ensureMigrationLedger(db);
  const applied = new Map(listApplied(db).map((row) => [row.version, row]));
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const ran = [];
  for (const migration of ordered) {
    const prior = applied.get(migration.version);
    const checksum = migrationChecksum(migration);
    if (prior) {
      if (prior.checksum !== checksum) {
        throw new Error(`migration ${migration.version} checksum mismatch: recorded ${prior.checksum}, current ${checksum}`);
      }
      continue;
    }
    requireCanonicalMigration(migration);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, checksum, new Date().toISOString());
      db.exec('COMMIT');
      ran.push(migration.version);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw new Error(`migration ${migration.version} (${migration.name}) failed and was rolled back: ${error.message}`);
    }
  }
  return ran;
}

/** Revert applied migrations down to (exclusive) `to`, default 0. Each down + ledger delete is one transaction. */
function migrateDown(db, migrations, options = {}) {
  const to = options.to ?? 0;
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const applied = listApplied(db).sort((a, b) => b.version - a.version);
  const pendingDown = applied.filter((row) => row.version > to);
  // F2 (revision-02): verify the stored fingerprint of EVERY migration to be reverted BEFORE
  // touching anything; the fingerprint binds the canonical executed sql/downSql fields, and only
  // those bound fields are executed below — a changed definition must refuse the rollback instead
  // of dropping tables/ledger, and no unbound function may ever run.
  for (const row of pendingDown) {
    const migration = byVersion.get(row.version);
    if (!migration || typeof migration.downSql !== 'string') {
      throw new Error(`no canonical downSql for applied migration ${row.version}; refusing to mutate history`);
    }
    requireCanonicalMigration(migration);
    const current = migrationChecksum(migration);
    if (row.checksum !== current) {
      throw new Error(`migration ${row.version} fingerprint mismatch: recorded ${row.checksum}, current ${current} (canonical sql/downSql changed after apply; refusing down, no schema/ledger was modified)`);
    }
  }
  const reverted = [];
  for (const row of pendingDown) {
    const migration = byVersion.get(row.version);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.downSql);
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(row.version);
      db.exec('COMMIT');
      reverted.push(row.version);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw new Error(`down of migration ${row.version} failed and was rolled back: ${error.message}`);
    }
  }
  return reverted;
}

/** Consistent snapshot via SQLite VACUUM INTO (includes committed WAL content). Refuses to overwrite. */
function backupTo(db, destPath) {
  const resolved = path.resolve(destPath);
  if (fs.existsSync(resolved)) throw new Error(`backup destination exists; refusing to overwrite: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  db.exec(`VACUUM INTO '${resolved.replace(/'/g, "''")}'`);
  return resolved;
}

/** Re-open a database file read-only and check integrity + expected tables + existing FK violations. Never throws. */
function verifyDatabaseFile(dbPath, options = {}) {
  const expectedTables = options.expectedTables || [];
  let db;
  try {
    db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') return { ok: false, integrity, fkViolations: null, missing: expectedTables };
    const fkRows = db.prepare('PRAGMA foreign_key_check').all();
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const missing = expectedTables.filter((t) => !names.has(t));
    const ok = missing.length === 0 && fkRows.length === 0;
    return { ok, integrity, fkViolations: fkRows.length, fkSample: fkRows.slice(0, 5), missing };
  } catch (error) {
    return { ok: false, integrity: null, fkViolations: null, missing: expectedTables, error: error.message };
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

module.exports = {
  CORE_TABLES,
  openDb,
  ensureMigrationLedger,
  migrationChecksum,
  listApplied,
  migrateUp,
  migrateDown,
  backupTo,
  verifyDatabaseFile
};
