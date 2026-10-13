'use strict';
/**
 * Consistent backup CLI (T1.1).
 * usage: node scripts/commerce/backup-db.js --db <path> --out <path> [--verify]
 *
 * Uses the driver-supported consistent snapshot (VACUUM INTO via lib/commerce/db.js), which
 * includes committed WAL content; it never copies a busy database file and never renames an open db.
 * Refuses to overwrite an existing destination. Exit code 0 on success, 1 on failure.
 */
const path = require('node:path');
const { openDb, backupTo, verifyDatabaseFile, CORE_TABLES } = require(path.join(__dirname, '..', '..', 'lib', 'commerce', 'db.js'));
const fs = require('node:fs');

function parseArgs(argv) {
  const args = { verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--db') { args.db = argv[++i]; }
    else if (token === '--out') { args.out = argv[++i]; }
    else if (token === '--verify') { args.verify = true; }
    else if (token === '--help' || token === '-h') { args.help = true; }
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.db || !args.out) {
    console.log('usage: node scripts/commerce/backup-db.js --db <path> --out <path> [--verify]');
    return args.help ? 0 : 2;
  }
  const dbPath = path.resolve(args.db);
  if (!fs.existsSync(dbPath)) {
    console.error(`source database does not exist: ${dbPath}`);
    return 1;
  }
  const db = openDb(dbPath);
  try {
    const out = backupTo(db, args.out);
    const result = { db: dbPath, out };
    if (args.verify) result.verify = verifyDatabaseFile(out, { expectedTables: CORE_TABLES });
    console.log(JSON.stringify(result, null, 2));
    if (args.verify && !result.verify.ok) return 1;
    return 0;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`backup failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { main };
