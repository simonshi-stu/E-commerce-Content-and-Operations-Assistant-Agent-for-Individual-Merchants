'use strict';
/**
 * Migration 0009 — budget pre-authorization / cost ledger tables (T2.4).
 * Isolated database domain (no FK into runs/idempotency): budget pools per (project, brand,
 * currency) with a non-resettable limit, per-(operation, attempt) reservations with structured
 * holds/pending/overrun, and an event ledger for idempotent mutations. Canonical `sql`/`downSql`
 * fields only; 0001–0008 are never touched; local synthetic fixtures only (no real calls/fees).
 */
const SQL = `
CREATE TABLE budget_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  brand TEXT,
  currency TEXT NOT NULL,
  limit_micros INTEGER NOT NULL,
  spent_micros INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  overrun_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_budget_pools_domain ON budget_pools (project_id, COALESCE(brand, ''), currency);
CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  pool_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  brand TEXT,
  currency TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  attempt_token TEXT NOT NULL,
  category TEXT NOT NULL,
  hold_micros INTEGER NOT NULL,
  pending_micros INTEGER NOT NULL DEFAULT 0,
  overrun_micros INTEGER NOT NULL DEFAULT 0,
  price_basis TEXT NOT NULL,
  price_confidence TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  settled_micros INTEGER,
  released_micros INTEGER,
  remote_id TEXT,
  last_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (operation_id, attempt_token),
  FOREIGN KEY (pool_id) REFERENCES budget_pools (id)
);
CREATE INDEX ix_budget_reservations_pool ON budget_reservations (pool_id, status);
CREATE TABLE budget_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  pool_id INTEGER,
  reservation_id TEXT,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_budget_events_reservation ON budget_events (reservation_id, created_at);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS ix_budget_events_reservation;
DROP TABLE budget_events;
DROP INDEX IF EXISTS ix_budget_reservations_pool;
DROP TABLE budget_reservations;
DROP INDEX IF EXISTS ux_budget_pools_domain;
DROP TABLE budget_pools;
`;

module.exports = {
  version: 9,
  name: 'budget',
  sql: SQL,
  downSql: DOWN_SQL
};
