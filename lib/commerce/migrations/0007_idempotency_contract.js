'use strict';
/**
 * Migration 0007 — idempotency contract hardening (T2.3 revision-01).
 * Adds, on top of 0006 (never modified):
 * - attempt generation identity: `idempotent_operations.attempt_token` / `generation`, and the
 *   same identity columns on `operation_attempts` — every execute permission is minted before the
 *   effect and late writes from an older generation are rejected.
 * - reconciliation audit: `reconcile_events` (query/evidence/decision/attempt identity/state
 *   before-after/remote/result in the same transaction as the state change) plus the latest
 *   `reconcile_state`/`reconcile_at` on the operation (late queries on cancelled rows included).
 * - fail-closed observation freshness: `cache_entries.fact_kind` (fact|generated),
 *   `observation_ttl_ms`, `observation_expires_at` — legacy rows stay NULL and are never fresh.
 * Canonical `sql`/`downSql` fields only; 0001–0006 are never touched and legacy [6] ledgers can
 * migrate up; legacy rows are not backfilled.
 */
const SQL = `
ALTER TABLE idempotent_operations ADD COLUMN attempt_token TEXT;
ALTER TABLE idempotent_operations ADD COLUMN generation INTEGER;
ALTER TABLE idempotent_operations ADD COLUMN reconcile_state TEXT;
ALTER TABLE idempotent_operations ADD COLUMN reconcile_at TEXT;
ALTER TABLE operation_attempts ADD COLUMN generation INTEGER;
ALTER TABLE operation_attempts ADD COLUMN attempt_token TEXT;
ALTER TABLE cache_entries ADD COLUMN fact_kind TEXT;
ALTER TABLE cache_entries ADD COLUMN observation_ttl_ms INTEGER;
ALTER TABLE cache_entries ADD COLUMN observation_expires_at TEXT;
CREATE TABLE reconcile_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  attempt_token TEXT,
  generation INTEGER,
  attempt_no INTEGER,
  query TEXT NOT NULL,
  evidence TEXT,
  decision TEXT NOT NULL,
  state_before TEXT NOT NULL,
  state_after TEXT NOT NULL,
  remote_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES idempotent_operations (operation_id)
);
CREATE INDEX ix_reconcile_events_operation ON reconcile_events (operation_id, created_at);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS ix_reconcile_events_operation;
DROP TABLE reconcile_events;
ALTER TABLE cache_entries DROP COLUMN observation_expires_at;
ALTER TABLE cache_entries DROP COLUMN observation_ttl_ms;
ALTER TABLE cache_entries DROP COLUMN fact_kind;
ALTER TABLE operation_attempts DROP COLUMN attempt_token;
ALTER TABLE operation_attempts DROP COLUMN generation;
ALTER TABLE idempotent_operations DROP COLUMN reconcile_at;
ALTER TABLE idempotent_operations DROP COLUMN reconcile_state;
ALTER TABLE idempotent_operations DROP COLUMN generation;
ALTER TABLE idempotent_operations DROP COLUMN attempt_token;
`;

module.exports = {
  version: 7,
  name: 'idempotency_contract',
  sql: SQL,
  downSql: DOWN_SQL
};
