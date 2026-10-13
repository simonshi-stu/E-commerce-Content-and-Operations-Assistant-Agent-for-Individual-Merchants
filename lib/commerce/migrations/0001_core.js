'use strict';
/**
 * Migration 0001 — core schema v1 (T1.1).
 * Generic entities only (no helmet-specific columns). Cross-project references are enforced with
 * composite foreign keys on (project_id, id) so a row cannot point at another project's row.
 */

const SQL = `
CREATE TABLE product_passports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  brand_key TEXT,
  product_family_key TEXT NOT NULL,
  nickname TEXT,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, product_family_key)
);

CREATE TABLE skus (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  product_passport_id TEXT NOT NULL,
  sku_code TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, product_passport_id, sku_code),
  FOREIGN KEY (project_id, product_passport_id) REFERENCES product_passports (project_id, id)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT,
  observed_at TEXT,
  sha256 TEXT,
  file_ref TEXT,
  license_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id)
);
CREATE UNIQUE INDEX ux_evidence_project_sha256 ON evidence (project_id, sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  evidence_id TEXT,
  origin_type TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'unreviewed',
  key TEXT NOT NULL,
  value_text TEXT,
  unit TEXT,
  observed_at TEXT,
  ttl TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, evidence_id) REFERENCES evidence (project_id, id),
  FOREIGN KEY (project_id, superseded_by) REFERENCES observations (project_id, id)
);

CREATE TABLE company_leads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  address TEXT,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id)
);
CREATE UNIQUE INDEX ux_company_leads_project_domain ON company_leads (project_id, domain) WHERE domain IS NOT NULL;

CREATE TABLE creative_briefs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  product_passport_id TEXT NOT NULL,
  sku_id TEXT,
  channel TEXT NOT NULL,
  locale TEXT NOT NULL,
  size_matrix_json TEXT NOT NULL DEFAULT '[]',
  allowed_claims_json TEXT NOT NULL DEFAULT '[]',
  forbidden_claims_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, product_passport_id) REFERENCES product_passports (project_id, id),
  FOREIGN KEY (project_id, sku_id) REFERENCES skus (project_id, id)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  product_passport_id TEXT,
  role TEXT NOT NULL,
  file_ref TEXT NOT NULL,
  sha256 TEXT,
  mime TEXT,
  width INTEGER,
  height INTEGER,
  language TEXT,
  design_version TEXT,
  export_version TEXT,
  license_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, product_passport_id) REFERENCES product_passports (project_id, id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','running','waiting_input','blocked','succeeded','failed','cancelled')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  checkpoint_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id)
);

CREATE TABLE memory_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('product','category','brand','market','run')),
  scope_key TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_value_text TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','rejected','superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  effective_at TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, scope, scope_key, rule_key, version),
  FOREIGN KEY (project_id, superseded_by) REFERENCES memory_rules (project_id, id)
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  source TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, run_id) REFERENCES runs (project_id, id)
);
`;

const DOWN_SQL = `
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS memory_rules;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS creative_briefs;
DROP TABLE IF EXISTS company_leads;
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS evidence;
DROP TABLE IF EXISTS skus;
DROP TABLE IF EXISTS product_passports;
`;

module.exports = {
  version: 1,
  name: 'core',
  // Canonical executed SQL fields (revision-02): the coordinator executes exactly these strings and
  // fingerprints them; no up()/down() functions are executed, so closed-over SQL cannot bypass the
  // history binding.
  sql: SQL,
  downSql: DOWN_SQL
};
