'use strict';
/**
 * Migration 0003 — Evidence / Observation fact-model support (T1.3).
 * Adds only what 0001 lacks: byte-vs-declared hash flag, capture time and import basis for
 * evidence; explicit subject (type/id), TTL seconds with derived expiry and approval-change time
 * for observations; subject/supersede lookup indexes. Canonical `sql`/`downSql` fields only
 * (T1.1 revision-02); 0001/0002 history is never touched.
 */

const SQL = `
ALTER TABLE evidence ADD COLUMN captured_at TEXT;
ALTER TABLE evidence ADD COLUMN import_basis TEXT;
ALTER TABLE evidence ADD COLUMN hash_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE observations ADD COLUMN subject_type TEXT;
ALTER TABLE observations ADD COLUMN subject_id TEXT;
ALTER TABLE observations ADD COLUMN ttl_seconds INTEGER;
ALTER TABLE observations ADD COLUMN expires_at TEXT;
ALTER TABLE observations ADD COLUMN approval_changed_at TEXT;
CREATE INDEX ix_evidence_project_source ON evidence (project_id, source_type);
CREATE INDEX ix_observations_subject ON observations (project_id, subject_type, subject_id, key);
CREATE INDEX ix_observations_superseded ON observations (project_id, superseded_by);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS ix_observations_superseded;
DROP INDEX IF EXISTS ix_observations_subject;
DROP INDEX IF EXISTS ix_evidence_project_source;
ALTER TABLE observations DROP COLUMN approval_changed_at;
ALTER TABLE observations DROP COLUMN expires_at;
ALTER TABLE observations DROP COLUMN ttl_seconds;
ALTER TABLE observations DROP COLUMN subject_id;
ALTER TABLE observations DROP COLUMN subject_type;
ALTER TABLE evidence DROP COLUMN hash_verified;
ALTER TABLE evidence DROP COLUMN import_basis;
ALTER TABLE evidence DROP COLUMN captured_at;
`;

module.exports = {
  version: 3,
  name: 'evidence_observation',
  sql: SQL,
  downSql: DOWN_SQL
};
