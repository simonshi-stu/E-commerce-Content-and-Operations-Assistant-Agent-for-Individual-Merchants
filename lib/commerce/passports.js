'use strict';
/**
 * ProductPassport / SKU variant repository (T1.2).
 *
 * Generic entity layer for ANY category — no fixture-specific model numbers, identifiers, slot
 * counts or other product-specific data live in this file (grep-checked in the T1.2 evidence).
 * Product data is supplied by callers/tests.
 *
 * Semantics:
 * - every read/write is project-scoped (`project_id` in every WHERE clause): an id belonging to
 *   another project is treated as not found and can never be operated cross-project;
 * - append-only history: create / update / soft-delete each append a snapshot to `entity_versions`;
 *   soft delete keeps history readable; current-state reads exclude deleted rows by default;
 * - unbranded is the per-entity state `brand_key = NULL` and never merges separate products;
 * - variant identity is the canonical attribute key-value map: attribute key ORDER never produces
 *   a different variant (`variant_key` is a hash of the deep-sorted map); the canonical map is
 *   PROTOTYPE-SAFE — a legitimate own JSON key such as `__proto__` is preserved, never silently
 *   dropped — and attribute values must be JSON-compatible: null / boolean / finite number /
 *   string, arrays and plain objects thereof. `undefined`, functions, symbols, bigint, non-finite
 *   numbers, circular references and class instances are rejected with a ValidationError BEFORE any
 *   write; values are never coerced to null or silently removed;
 * - archived (soft-deleted) passports are read-only: existing child SKUs can still be READ by id
 *   (and soft-deleted for cleanup, keeping history), but they can no longer be EDITED; history
 *   stays append-only;
 * - user-confirmed alias→product-family mapping is separate from nickname / formal model;
 *   unconfirmed aliases do not resolve; nothing is inferred from file names.
 *
 * DEV NOTE: development task state (PROGRESS.json) is unrelated to business `runs` state.
 */
const crypto = require('node:crypto');

const PASSPORT_STATUSES = ['draft', 'confirmed', 'archived'];
const CHANGE_KINDS = ['create', 'update', 'soft_delete'];

class NotFoundError extends Error {
  constructor(message) { super(message); this.code = 'not_found'; }
}
class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'validation'; }
}
class ConflictError extends Error {
  constructor(message) { super(message); this.code = 'conflict'; }
}

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalString(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, name);
}
function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value;
}
function normalizeAlias(alias) {
  return requireString(alias, 'alias').toLowerCase().replace(/\s+/g, ' ');
}
/**
 * Validate a JSON-compatible attribute value tree. Rejects (ValidationError) anything JSON cannot
 * round-trip faithfully: undefined, functions, symbols, bigint, non-finite numbers, circular
 * references and non-plain objects. Values are never coerced or silently dropped.
 */
function assertJsonCompatible(value, pathLabel, ancestors) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`attribute value at ${pathLabel} is not a finite number`);
    return;
  }
  if (type === 'undefined') throw new ValidationError(`attribute value at ${pathLabel} is undefined; JSON-compatible values are required`);
  if (type !== 'object') throw new ValidationError(`attribute value at ${pathLabel} has unsupported type ${type}`);
  if (ancestors.has(value)) throw new ValidationError(`attribute value at ${pathLabel} contains a circular reference`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonCompatible(item, `${pathLabel}[${index}]`, ancestors));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new ValidationError(`attribute value at ${pathLabel} must be a plain JSON object`);
    for (const key of Object.keys(value)) assertJsonCompatible(value[key], `${pathLabel}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

/** Deep-sort keys into a prototype-safe canonical map (own `__proto__` keys survive). */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/** Canonical variant key: stable for the same attribute map regardless of key order. */
function canonicalVariantKey(attributes) {
  requireObject(attributes, 'attributes');
  assertJsonCompatible(attributes, 'attributes', new Set());
  const canonical = JSON.stringify(sortDeep(attributes));
  return `vk_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

function canonicalAttributesJson(attributes) {
  requireObject(attributes, 'attributes');
  assertJsonCompatible(attributes, 'attributes', new Set());
  return JSON.stringify(sortDeep(attributes));
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction anymore */ }
    throw error;
  }
}

function appendVersion(db, projectId, entityType, entityId, version, status, changeKind, snapshot) {
  if (!CHANGE_KINDS.includes(changeKind)) throw new ValidationError(`changeKind must be one of ${CHANGE_KINDS.join(', ')}`);
  db.prepare(`INSERT INTO entity_versions (id, project_id, entity_type, entity_id, version, status, change_kind, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('ev'), projectId, entityType, entityId, version, status, changeKind, JSON.stringify(snapshot), nowIso());
}

// ---------- ProductPassport ----------

function createPassport(db, projectId, input = {}) {
  const project = requireString(projectId, 'projectId');
  const row = {
    id: newId('pp'),
    project_id: project,
    brand_key: optionalString(input.brandKey, 'brandKey'),            // NULL = unbranded, per entity
    product_family_key: requireString(input.productFamilyKey, 'productFamilyKey'),
    nickname: optionalString(input.nickname, 'nickname'),
    category: requireString(input.category, 'category'),
    title: requireString(input.title, 'title'),
    category_pack_key: optionalString(input.categoryPackKey, 'categoryPackKey'),
    source_summary_json: JSON.stringify(input.sources ?? []),
    status: 'draft',
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null
  };
  if (!Array.isArray(input.sources ?? [])) throw new ValidationError('sources must be an array when provided');
  try {
    return withTransaction(db, () => {
      db.prepare(`INSERT INTO product_passports
        (id, project_id, brand_key, product_family_key, nickname, category, title, category_pack_key, source_summary_json, status, version, created_at, updated_at, deleted_at)
        VALUES (@id, @project_id, @brand_key, @product_family_key, @nickname, @category, @title, @category_pack_key, @source_summary_json, @status, @version, @created_at, @updated_at, @deleted_at)`)
        .run(row);
      appendVersion(db, project, 'passport', row.id, row.version, row.status, 'create', row);
      return getPassport(db, project, row.id, { includeDeleted: true });
    });
  } catch (error) {
    if (/UNIQUE/i.test(String(error.message))) throw new ConflictError('a passport with this product family already exists in this project');
    throw error;
  }
}

function getPassport(db, projectId, passportId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(passportId, 'passportId');
  const filter = options.includeDeleted ? '' : ' AND deleted_at IS NULL';
  return db.prepare(`SELECT * FROM product_passports WHERE project_id = ? AND id = ?${filter}`).get(project, id) ?? null;
}

function listPassports(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const clauses = ['project_id = ?'];
  const params = [project];
  if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
  if (options.status) { clauses.push('status = ?'); params.push(options.status); }
  return db.prepare(`SELECT * FROM product_passports WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`).all(...params);
}

const PASSPORT_UPDATE_FIELDS = {
  title: 'title',
  brandKey: 'brand_key',
  nickname: 'nickname',
  category: 'category',
  productFamilyKey: 'product_family_key',
  categoryPackKey: 'category_pack_key'
};

function updatePassport(db, projectId, passportId, patch = {}) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(passportId, 'passportId');
  if ('status' in patch) throw new ValidationError('status is changed via confirmPassport/softDeletePassport');
  const current = getPassport(db, project, id, { includeDeleted: true });
  if (!current) throw new NotFoundError('passport not found in this project');
  if (current.deleted_at || current.status === 'archived') throw new ConflictError('archived passport cannot be updated');
  const changes = {};
  for (const [key, column] of Object.entries(PASSPORT_UPDATE_FIELDS)) {
    if (key in patch) changes[column] = key === 'brandKey' ? optionalString(patch[key], key) : requireString(patch[key], key);
  }
  if ('sources' in patch) {
    if (!Array.isArray(patch.sources)) throw new ValidationError('sources must be an array');
    changes.source_summary_json = JSON.stringify(patch.sources);
  }
  if (Object.keys(changes).length === 0) throw new ValidationError('no updatable fields provided');
  const nextVersion = current.version + 1;
  const updatedAt = nowIso();
  return withTransaction(db, () => {
    const sets = Object.keys(changes).map((column) => `${column} = @${column}`).join(', ');
    db.prepare(`UPDATE product_passports SET ${sets}, version = @version, updated_at = @updated_at WHERE project_id = @project_id AND id = @id`)
      .run({ ...changes, version: nextVersion, updated_at: updatedAt, project_id: project, id });
    const next = getPassport(db, project, id, { includeDeleted: true });
    appendVersion(db, project, 'passport', id, nextVersion, next.status, 'update', next);
    return next;
  });
}

function confirmPassport(db, projectId, passportId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(passportId, 'passportId');
  const current = getPassport(db, project, id, { includeDeleted: true });
  if (!current) throw new NotFoundError('passport not found in this project');
  if (current.deleted_at || current.status === 'archived') throw new ConflictError('archived passport cannot be confirmed');
  if (current.status === 'confirmed') return current;
  const nextVersion = current.version + 1;
  return withTransaction(db, () => {
    db.prepare(`UPDATE product_passports SET status = 'confirmed', version = ?, updated_at = ? WHERE project_id = ? AND id = ?`)
      .run(nextVersion, nowIso(), project, id);
    const next = getPassport(db, project, id, { includeDeleted: true });
    appendVersion(db, project, 'passport', id, nextVersion, next.status, 'update', next);
    return next;
  });
}

function softDeletePassport(db, projectId, passportId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(passportId, 'passportId');
  const current = getPassport(db, project, id, { includeDeleted: true });
  if (!current) throw new NotFoundError('passport not found in this project');
  if (current.deleted_at) return current; // idempotent, no new version
  const nextVersion = current.version + 1;
  const deletedAt = nowIso();
  return withTransaction(db, () => {
    db.prepare(`UPDATE product_passports SET status = 'archived', deleted_at = ?, version = ?, updated_at = ? WHERE project_id = ? AND id = ?`)
      .run(deletedAt, nextVersion, deletedAt, project, id);
    const next = getPassport(db, project, id, { includeDeleted: true });
    appendVersion(db, project, 'passport', id, nextVersion, next.status, 'soft_delete', next);
    return next;
  });
}

function getPassportVersions(db, projectId, passportId) {
  return getEntityVersions(db, projectId, 'passport', passportId);
}

// ---------- SKU / variant ----------

function createSku(db, projectId, passportId, input = {}) {
  const project = requireString(projectId, 'projectId');
  const passport = getPassport(db, project, requireString(passportId, 'passportId'), { includeDeleted: true });
  if (!passport) throw new NotFoundError('passport not found in this project');
  if (passport.deleted_at || passport.status === 'archived') throw new ConflictError('cannot add SKUs to an archived passport');
  const skuCode = requireString(input.skuCode, 'skuCode');
  const attributes = requireObject(input.attributes, 'attributes');
  const variantKey = canonicalVariantKey(attributes);
  const row = {
    id: newId('sku'),
    project_id: project,
    product_passport_id: passport.id,
    sku_code: skuCode,
    attributes_json: canonicalAttributesJson(attributes),
    variant_key: variantKey,
    status: 'draft',
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null
  };
  try {
    return withTransaction(db, () => {
      db.prepare(`INSERT INTO skus (id, project_id, product_passport_id, sku_code, attributes_json, variant_key, status, version, created_at, updated_at, deleted_at)
        VALUES (@id, @project_id, @product_passport_id, @sku_code, @attributes_json, @variant_key, @status, @version, @created_at, @updated_at, @deleted_at)`)
        .run(row);
      appendVersion(db, project, 'sku', row.id, row.version, row.status, 'create', row);
      return getSku(db, project, row.id, { includeDeleted: true });
    });
  } catch (error) {
    const message = String(error.message);
    if (/skus\.variant_key/i.test(message)) throw new ConflictError('a SKU with the same canonical variant already exists for this passport');
    if (/skus\.sku_code/i.test(message)) throw new ConflictError('duplicate SKU code for this passport');
    if (/UNIQUE/i.test(message)) throw new ConflictError('duplicate SKU code or canonical variant for this passport');
    throw error;
  }
}

function getSku(db, projectId, skuId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(skuId, 'skuId');
  const filter = options.includeDeleted ? '' : ' AND deleted_at IS NULL';
  return db.prepare(`SELECT * FROM skus WHERE project_id = ? AND id = ?${filter}`).get(project, id) ?? null;
}

function listSkus(db, projectId, passportId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const clauses = ['project_id = ?', 'product_passport_id = ?'];
  const params = [project, requireString(passportId, 'passportId')];
  if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
  return db.prepare(`SELECT * FROM skus WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`).all(...params);
}

function updateSku(db, projectId, skuId, patch = {}) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(skuId, 'skuId');
  const current = getSku(db, project, id, { includeDeleted: true });
  if (!current) throw new NotFoundError('sku not found in this project');
  if (current.deleted_at) throw new ConflictError('deleted sku cannot be updated');
  const parent = getPassport(db, project, current.product_passport_id, { includeDeleted: true });
  if (!parent || parent.deleted_at || parent.status === 'archived') {
    throw new ConflictError('cannot update a SKU whose passport is archived');
  }
  const changes = {};
  if ('skuCode' in patch) changes.sku_code = requireString(patch.skuCode, 'skuCode');
  if ('attributes' in patch) {
    requireObject(patch.attributes, 'attributes');
    changes.attributes_json = canonicalAttributesJson(patch.attributes);
    changes.variant_key = canonicalVariantKey(patch.attributes);
  }
  if (Object.keys(changes).length === 0) throw new ValidationError('no updatable fields provided');
  const nextVersion = current.version + 1;
  try {
    return withTransaction(db, () => {
      const sets = Object.keys(changes).map((column) => `${column} = @${column}`).join(', ');
      db.prepare(`UPDATE skus SET ${sets}, version = @version, updated_at = @updated_at WHERE project_id = @project_id AND id = @id`)
        .run({ ...changes, version: nextVersion, updated_at: nowIso(), project_id: project, id });
      const next = getSku(db, project, id, { includeDeleted: true });
      appendVersion(db, project, 'sku', id, nextVersion, next.status, 'update', next);
      return next;
    });
  } catch (error) {
    const message = String(error.message);
    if (/skus\.variant_key/i.test(message)) throw new ConflictError('a SKU with the same canonical variant already exists for this passport');
    if (/skus\.sku_code/i.test(message)) throw new ConflictError('duplicate SKU code for this passport');
    if (/UNIQUE/i.test(message)) throw new ConflictError('duplicate SKU code or canonical variant for this passport');
    throw error;
  }
}

function softDeleteSku(db, projectId, skuId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(skuId, 'skuId');
  const current = getSku(db, project, id, { includeDeleted: true });
  if (!current) throw new NotFoundError('sku not found in this project');
  if (current.deleted_at) return current; // idempotent
  const nextVersion = current.version + 1;
  const deletedAt = nowIso();
  return withTransaction(db, () => {
    db.prepare(`UPDATE skus SET deleted_at = ?, version = ?, updated_at = ? WHERE project_id = ? AND id = ?`)
      .run(deletedAt, nextVersion, deletedAt, project, id);
    const next = getSku(db, project, id, { includeDeleted: true });
    appendVersion(db, project, 'sku', id, nextVersion, next.status, 'soft_delete', next);
    return next;
  });
}

function getSkuVersions(db, projectId, skuId) {
  return getEntityVersions(db, projectId, 'sku', skuId);
}

// ---------- aliases (user-confirmed alias → product family) ----------

function addAlias(db, projectId, passportId, alias, options = {}) {
  const project = requireString(projectId, 'projectId');
  const passport = getPassport(db, project, requireString(passportId, 'passportId'));
  if (!passport) throw new NotFoundError('passport not found in this project');
  const normalized = normalizeAlias(alias);
  const row = {
    id: newId('al'),
    project_id: project,
    product_passport_id: passport.id,
    alias: requireString(alias, 'alias'),
    alias_normalized: normalized,
    source: options.source ? requireString(options.source, 'source') : 'user_statement',
    confirmed: options.confirmed === true ? 1 : 0,
    created_at: nowIso(),
    deleted_at: null
  };
  try {
    db.prepare(`INSERT INTO product_aliases (id, project_id, product_passport_id, alias, alias_normalized, source, confirmed, created_at, deleted_at)
      VALUES (@id, @project_id, @product_passport_id, @alias, @alias_normalized, @source, @confirmed, @created_at, @deleted_at)`)
      .run(row);
    return row;
  } catch (error) {
    if (/UNIQUE/i.test(String(error.message))) throw new ConflictError('alias is already mapped in this project');
    throw error;
  }
}

function confirmAlias(db, projectId, aliasId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(aliasId, 'aliasId');
  const row = db.prepare('SELECT * FROM product_aliases WHERE project_id = ? AND id = ? AND deleted_at IS NULL').get(project, id);
  if (!row) throw new NotFoundError('alias not found in this project');
  if (row.confirmed === 1) return row;
  db.prepare('UPDATE product_aliases SET confirmed = 1 WHERE project_id = ? AND id = ?').run(project, id);
  return db.prepare('SELECT * FROM product_aliases WHERE project_id = ? AND id = ?').get(project, id);
}

function removeAlias(db, projectId, aliasId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(aliasId, 'aliasId');
  const row = db.prepare('SELECT * FROM product_aliases WHERE project_id = ? AND id = ?').get(project, id);
  if (!row) throw new NotFoundError('alias not found in this project');
  if (row.deleted_at) return row;
  db.prepare('UPDATE product_aliases SET deleted_at = ? WHERE project_id = ? AND id = ?').run(nowIso(), project, id);
  return db.prepare('SELECT * FROM product_aliases WHERE project_id = ? AND id = ?').get(project, id);
}

function listAliases(db, projectId, passportId) {
  const project = requireString(projectId, 'projectId');
  return db.prepare('SELECT * FROM product_aliases WHERE project_id = ? AND product_passport_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
    .all(project, requireString(passportId, 'passportId'));
}

/**
 * Resolve an alias to its passport. By default only USER-CONFIRMED aliases resolve; unconfirmed
 * candidates can be inspected with { requireConfirmed: false } but are never auto-upgraded.
 */
function resolvePassportByAlias(db, projectId, alias, options = {}) {
  const project = requireString(projectId, 'projectId');
  const requireConfirmed = options.requireConfirmed !== false;
  const normalized = normalizeAlias(alias);
  const clauses = ['a.project_id = ?', 'a.alias_normalized = ?', 'a.deleted_at IS NULL', 'p.deleted_at IS NULL'];
  const params = [project, normalized];
  if (requireConfirmed) clauses.push('a.confirmed = 1');
  return db.prepare(`SELECT p.* FROM product_aliases a JOIN product_passports p ON p.project_id = a.project_id AND p.id = a.product_passport_id
    WHERE ${clauses.join(' AND ')}`).get(...params) ?? null;
}

// ---------- history ----------

function getEntityVersions(db, projectId, entityType, entityId) {
  const project = requireString(projectId, 'projectId');
  if (!['passport', 'sku'].includes(entityType)) throw new ValidationError('entityType must be passport or sku');
  return db.prepare(`SELECT version, status, change_kind, snapshot_json, created_at FROM entity_versions
    WHERE project_id = ? AND entity_type = ? AND entity_id = ? ORDER BY version`).all(project, entityType, requireString(entityId, 'entityId'));
}

module.exports = {
  PASSPORT_STATUSES,
  canonicalVariantKey,
  canonicalAttributesJson,
  createPassport,
  getPassport,
  listPassports,
  updatePassport,
  confirmPassport,
  softDeletePassport,
  getPassportVersions,
  createSku,
  getSku,
  listSkus,
  updateSku,
  softDeleteSku,
  getSkuVersions,
  addAlias,
  confirmAlias,
  removeAlias,
  listAliases,
  resolvePassportByAlias,
  getEntityVersions,
  NotFoundError,
  ValidationError,
  ConflictError
};
