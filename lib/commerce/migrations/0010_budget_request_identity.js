'use strict';
/**
 * Migration 0010 — budget request identity & replay outcomes (T2.4 revision-01).
 * Adds, on top of 0009 (never modified):
 * - `budget_events.outcome` / `reason`: the original decision of every reserve request
 *   (granted/duplicate/blocked/no_pool) so a same-event replay returns the truthful original
 *   outcome instead of a ConflictError or an environment-dependent upgrade.
 * - `budget_reservations.request_json` / `request_hash`: the exact immutable reserve request
 *   (finite-bound presence/value, domain/currency/config, initial remote reference) so duplicate
 *   detection never treats a missing bound as a wildcard and later mutable remote bindings never
 *   change the original request identity.
 * Legacy rows keep NULL and are never backfilled (fail-closed). Canonical `sql`/`downSql` only.
 */
const SQL = `
ALTER TABLE budget_events ADD COLUMN outcome TEXT;
ALTER TABLE budget_events ADD COLUMN reason TEXT;
ALTER TABLE budget_reservations ADD COLUMN request_json TEXT;
ALTER TABLE budget_reservations ADD COLUMN request_hash TEXT;
`;

const DOWN_SQL = `
ALTER TABLE budget_reservations DROP COLUMN request_hash;
ALTER TABLE budget_reservations DROP COLUMN request_json;
ALTER TABLE budget_events DROP COLUMN reason;
ALTER TABLE budget_events DROP COLUMN outcome;
`;

module.exports = {
  version: 10,
  name: 'budget_request_identity',
  sql: SQL,
  downSql: DOWN_SQL
};
