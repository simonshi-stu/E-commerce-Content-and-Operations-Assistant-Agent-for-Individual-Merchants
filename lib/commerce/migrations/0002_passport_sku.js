'use strict';
/**
 * Migration 0002 — ProductPassport / SKU variant repository support (T1.2).
 * Adds ONLY what 0001 lacks: passport title/category-pack/source-summary, soft-delete markers,
 * canonical variant keys with uniqueness, alias mapping, and append-only entity version history.
 * Uses the canonical `sql` / `downSql` fields (T1.1 revision-02) and never touches 0001 history.
 */

const SQL = `
ALTER TABLE product_passports ADD COLUMN title TEXT;
ALTER TABLE product_passports ADD COLUMN category_pack_key TEXT;
ALTER TABLE product_passports ADD COLUMN source_summary_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE product_passports ADD COLUMN deleted_at TEXT;
ALTER TABLE skus ADD COLUMN variant_key TEXT;
ALTER TABLE skus ADD COLUMN deleted_at TEXT;
CREATE INDEX ix_passports_project_status ON product_passports (project_id, status);
CREATE UNIQUE INDEX ux_skus_project_passport_variant ON skus (project_id, product_passport_id, variant_key) WHERE variant_key IS NOT NULL;
CREATE TABLE product_aliases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  product_passport_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user_statement',
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, product_passport_id) REFERENCES product_passports (project_id, id)
);
CREATE UNIQUE INDEX ux_alias_project_norm ON product_aliases (project_id, alias_normalized) WHERE deleted_at IS NULL;
CREATE TABLE entity_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('passport', 'sku')),
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'soft_delete')),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, entity_type, entity_id, version)
);
CREATE INDEX ix_entity_versions_lookup ON entity_versions (project_id, entity_type, entity_id);
`;

const DOWN_SQL = `
DROP INDEX IF EXISTS ix_entity_versions_lookup;
DROP TABLE IF EXISTS entity_versions;
DROP INDEX IF EXISTS ux_alias_project_norm;
DROP TABLE IF EXISTS product_aliases;
DROP INDEX IF EXISTS ux_skus_project_passport_variant;
DROP INDEX IF EXISTS ix_passports_project_status;
ALTER TABLE skus DROP COLUMN deleted_at;
ALTER TABLE skus DROP COLUMN variant_key;
ALTER TABLE product_passports DROP COLUMN deleted_at;
ALTER TABLE product_passports DROP COLUMN source_summary_json;
ALTER TABLE product_passports DROP COLUMN category_pack_key;
ALTER TABLE product_passports DROP COLUMN title;
`;

module.exports = {
  version: 2,
  name: 'passport_sku',
  sql: SQL,
  downSql: DOWN_SQL
};
