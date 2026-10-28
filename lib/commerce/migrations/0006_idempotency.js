'use strict';
/**
 * Migration 0006 — idempotency / cache / reconciliation tables (T2.3).
 * Adds only what 0001–0005 lack, in an ISOLATED database domain (no FK into business runs):
 * - `cache_entries`: canonical cache keys with domain ownership (project/brand) and explicit
 *   observed_at vs written_at + expires_at (millisecond instant semantics).
 * - `idempotent_operations`: stable logical operation ids with a persisted state machine
 *   (claimed/submitted/pending_reconcile/confirmed_effective/confirmed_not_submitted/cancelled),
 *   capability grading, retained remote_id and bounded attempts.
 * - `operation_attempts`: per-attempt ledger (attempt numbers never change the operation id).
 * Canonical `sql`/`downSql` fields only (T1.1 revision-02 contract); 0001–0005 are never touched.
 * Scope note: local synthetic fixtures only — no provider calls, fees or real business data.
 */
const SQL = `
CREATE TABLE cache_entries (
  cache_key TEXT PRIMARY KEY,
  project_id TEXT,
  brand TEXT,
  key_json TEXT NOT NULL,
  value_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  written_at TEXT NOT NULL,
  ttl_ms INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_cache_entries_domain ON cache_entries (project_id, brand, expires_at);
CREATE TABLE idempotent_operations (
  operation_id TEXT PRIMARY KEY,
  scope_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  project_id TEXT,
  brand TEXT,
  capability TEXT NOT NULL CHECK (capability IN ('supported', 'unsupported', 'unknown')),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'submitted', 'pending_reconcile', 'confirmed_effective', 'confirmed_not_submitted', 'cancelled')),
  remote_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  pending_cost_json TEXT,
  result_json TEXT,
  cancel_reason TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_idempotent_operations_state ON idempotent_operations (state, updated_at);
CREATE TABLE operation_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'timeout', 'network_unknown')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  note TEXT,
  UNIQUE (operation_id, attempt_no),
  FOREIGN KEY (operation_id) REFERENCES idempotent_operations (operation_id)
);
`;

const DOWN_SQL = `
DROP TABLE operation_attempts;
DROP INDEX IF EXISTS ix_idempotent_operations_state;
DROP TABLE idempotent_operations;
DROP INDEX IF EXISTS ix_cache_entries_domain;
DROP TABLE cache_entries;
`;

module.exports = {
  version: 6,
  name: 'idempotency',
  sql: SQL,
  downSql: DOWN_SQL
};
