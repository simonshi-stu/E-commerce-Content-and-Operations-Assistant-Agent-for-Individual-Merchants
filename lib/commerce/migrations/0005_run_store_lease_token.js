'use strict';
/**
 * Migration 0005 — lease generation token for business runs (T2.1 revision-01).
 * Adds `runs.lease_token`: a fresh opaque generation minted on every acquire/reclaim so that
 * lease-governed writes can fence on the exact lease generation (owner identity alone cannot).
 * Canonical `sql`/`downSql` fields only; 0001–0004 are never touched.
 */
const SQL = `ALTER TABLE runs ADD COLUMN lease_token TEXT;`;

const DOWN_SQL = `ALTER TABLE runs DROP COLUMN lease_token;`;

module.exports = {
  version: 5,
  name: 'run_store_lease_token',
  sql: SQL,
  downSql: DOWN_SQL
};
