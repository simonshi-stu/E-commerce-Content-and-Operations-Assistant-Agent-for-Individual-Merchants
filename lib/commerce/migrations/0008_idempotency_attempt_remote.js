'use strict';
/**
 * Migration 0008 — structured per-attempt remote identity (T2.3 revision-03).
 * Adds `operation_attempts.remote_id`: the authoritative, exact opaque remote reference for each
 * attempt/generation (free-text notes are never parsed for identity). 0001–0007 are never touched;
 * legacy rows keep NULL and are never backfilled.
 * Canonical `sql`/`downSql` fields only.
 */
const SQL = `ALTER TABLE operation_attempts ADD COLUMN remote_id TEXT;`;

const DOWN_SQL = `ALTER TABLE operation_attempts DROP COLUMN remote_id;`;

module.exports = {
  version: 8,
  name: 'idempotency_attempt_remote',
  sql: SQL,
  downSql: DOWN_SQL
};
