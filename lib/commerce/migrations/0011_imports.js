'use strict';
/**
 * Migration 0011 (T1.7, revision-01) — import identity / lineage / candidate-confirmation tables.
 * Isolated additive domain on top of 0001/0003 (evidence/observations only referenced, never
 * altered); 0001–0010 are never touched. rev-01 changes (0011 was never approved/applied outside
 * isolated fixtures, so no ledger back-fill is involved): documents keep an explicit coverage JSON
 * for bounded scan processing; scan pages are keyed per IMAGE (image_index) so multiple images on
 * one page never collapse, and carry structured remote/operation/attempt references for unknown or
 * pending outcomes. Canonical `sql`/`downSql` fields only.
 */
const SQL = `
CREATE TABLE import_documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  supplier_key TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  file_ref TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  format TEXT NOT NULL,
  localization TEXT NOT NULL,
  coverage_json TEXT,
  evidence_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, document_id),
  UNIQUE (project_id, supplier_key, parser_version, raw_sha256),
  FOREIGN KEY (project_id, evidence_id) REFERENCES evidence (project_id, id)
);
CREATE INDEX ix_import_documents_hash ON import_documents (project_id, raw_sha256);

CREATE TABLE import_candidates (
  candidate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  supplier_key TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  candidate_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  raw_value TEXT,
  numeric_value REAL,
  currency TEXT,
  unit TEXT,
  incoterm TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'superseded')),
  reasons TEXT,
  subject_key TEXT NOT NULL,
  origin_hint TEXT NOT NULL,
  snippet TEXT NOT NULL,
  page_number INTEGER,
  physical_index INTEGER,
  sheet TEXT,
  row_number INTEGER,
  column_ref TEXT,
  method TEXT NOT NULL,
  observation_id TEXT,
  supersedes_candidate_id TEXT,
  line_index INTEGER,
  image_object TEXT,
  image_sha256 TEXT,
  region_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, candidate_id),
  UNIQUE (project_id, document_id, candidate_key),
  FOREIGN KEY (project_id, document_id) REFERENCES import_documents (project_id, document_id),
  FOREIGN KEY (project_id, observation_id) REFERENCES observations (project_id, id),
  FOREIGN KEY (project_id, supersedes_candidate_id) REFERENCES import_candidates (project_id, candidate_id)
);
CREATE INDEX ix_import_candidates_document ON import_candidates (project_id, document_id, field_key);
CREATE INDEX ix_import_candidates_subject ON import_candidates (project_id, supplier_key, subject_key);

CREATE TABLE import_scan_pages (
  page_result_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  image_index INTEGER NOT NULL,
  page_number INTEGER,
  physical_index INTEGER,
  image_object TEXT,
  image_sha256 TEXT,
  remote_id TEXT,
  operation_id TEXT,
  attempt_token TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, page_result_id),
  UNIQUE (project_id, document_id, image_index),
  FOREIGN KEY (project_id, document_id) REFERENCES import_documents (project_id, document_id)
);
CREATE INDEX ix_import_scan_pages_document ON import_scan_pages (project_id, document_id);

CREATE TABLE import_corrections (
  correction_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  old_candidate_id TEXT NOT NULL,
  new_candidate_id TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, correction_id),
  UNIQUE (project_id, old_candidate_id, new_candidate_id),
  FOREIGN KEY (project_id, document_id) REFERENCES import_documents (project_id, document_id),
  FOREIGN KEY (project_id, old_candidate_id) REFERENCES import_candidates (project_id, candidate_id),
  FOREIGN KEY (project_id, new_candidate_id) REFERENCES import_candidates (project_id, candidate_id)
);
CREATE INDEX ix_import_corrections_document ON import_corrections (project_id, document_id);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS ix_import_corrections_document;
DROP TABLE import_corrections;
DROP INDEX IF EXISTS ix_import_scan_pages_document;
DROP TABLE import_scan_pages;
DROP INDEX IF EXISTS ix_import_candidates_subject;
DROP INDEX IF EXISTS ix_import_candidates_document;
DROP TABLE import_candidates;
DROP INDEX IF EXISTS ix_import_documents_hash;
DROP TABLE import_documents;
`;

module.exports = {
  version: 11,
  name: 'imports',
  sql: SQL,
  downSql: DOWN_SQL
};
