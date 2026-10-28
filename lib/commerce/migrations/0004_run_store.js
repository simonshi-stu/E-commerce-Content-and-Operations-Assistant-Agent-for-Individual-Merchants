'use strict';
/**
 * Migration 0004 — business run event log (T2.1).
 * Adds only what 0001 lacks: an append-only `run_events` table for business `runs` (platform run
 * state, NOT the development PROGRESS task state). Canonical `sql`/`downSql` fields only
 * (T1.1 revision-02 contract); 0001–0003 history is never touched.
 */
const SQL = `
CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, run_id) REFERENCES runs (project_id, id)
);
CREATE INDEX ix_run_events_run ON run_events (project_id, run_id, created_at);
CREATE TRIGGER run_events_append_only_update BEFORE UPDATE ON run_events BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_append_only_delete BEFORE DELETE ON run_events BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
`;

const DOWN_SQL = `
DROP TRIGGER IF EXISTS run_events_append_only_delete;
DROP TRIGGER IF EXISTS run_events_append_only_update;
DROP INDEX IF EXISTS ix_run_events_run;
DROP TABLE run_events;
`;

module.exports = {
  version: 4,
  name: 'run_store',
  sql: SQL,
  downSql: DOWN_SQL
};
