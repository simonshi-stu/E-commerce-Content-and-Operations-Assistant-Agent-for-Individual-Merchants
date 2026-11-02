'use strict';

// Trusted, read-only bridge from the persisted creative kernel to the video handoff.
// Request payloads never provide a filesystem path, a hash authority, or a permission grant.
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./commerce/db.js');
const creative = require('./commerce/creative/brief.js');
const assets = require('./commerce/assets.js');
const { canonicalJson } = require('./commerce/packs.js');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail('snapshot_configuration_invalid', `${name} must be a non-empty string`);
  return value.trim();
}

function safeProject(value, name = 'projectId') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(value) || value === '.' || value === '..') {
    fail('snapshot_configuration_invalid', `${name} must be a safe project identifier`);
  }
  return value;
}

function normalizeAllowedProjects(options) {
  if (options.projectId !== undefined && options.projectId !== null) return [safeProject(options.projectId)];
  if (!Array.isArray(options.allowedProjects) || options.allowedProjects.length === 0) {
    fail('snapshot_configuration_invalid', 'a trusted project allowlist is required for video snapshot handoff');
  }
  return [...new Set(options.allowedProjects.map((project) => safeProject(project, 'allowedProjects[]')))];
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts;
}

function resolveIndexedFile(root, relPath) {
  const parts = safeRelativePath(relPath);
  if (!parts) return null;
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return null; }
    if (stat.isSymbolicLink()) fail('snapshot_asset_index_invalid', 'the trusted asset index points through a symlink');
    if (!stat.isDirectory() && current !== path.join(resolvedRoot, ...parts)) return null;
  }
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
    realFile = fs.realpathSync(current);
  } catch { return null; }
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) return null;
  let finalStat;
  try { finalStat = fs.statSync(realFile); } catch { return null; }
  if (!finalStat.isFile()) return null;
  return { file: realFile, bytes: fs.readFileSync(realFile), size: finalStat.size };
}

function configuredRoot(assetConfig, index, projectId) {
  if (!isPlainObject(assetConfig) || !isPlainObject(assetConfig.roots)) return null;
  const entry = assetConfig.roots[index.sourceRootId];
  if (typeof entry === 'string' && entry.trim() !== '') return path.resolve(entry);
  if (isPlainObject(entry) && typeof entry.path === 'string' && entry.path.trim() !== '') {
    if (Array.isArray(entry.projects) && !entry.projects.includes(projectId)) return null;
    return path.resolve(entry.path);
  }
  return null;
}

function loadAssetIndex(assetConfig) {
  if (!isPlainObject(assetConfig) || typeof assetConfig.indexFilePath !== 'string' || assetConfig.indexFilePath.trim() === '') return null;
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.resolve(assetConfig.indexFilePath), 'utf8'));
  } catch {
    fail('snapshot_asset_index_unavailable', 'the configured trusted asset index cannot be read');
  }
  if (!isPlainObject(index) || index.kind !== 'shop-materials-index' || !Array.isArray(index.files) || typeof index.sourceRootId !== 'string') {
    fail('snapshot_asset_index_invalid', 'the configured trusted asset index is not a valid shop-materials index');
  }
  if (!/^[a-f0-9]{64}$/.test(index.stableHash) || assets.sha256(Buffer.from(canonicalJson(assets.stableProjection(index)))) !== index.stableHash) {
    fail('snapshot_asset_index_invalid', 'the configured trusted asset index hash is invalid');
  }
  return index;
}

function mediaEvidence(document, assetConfig, projectId) {
  const snapshotAssets = Array.isArray(document.assets) ? document.assets : [];
  const index = loadAssetIndex(assetConfig);
  if (!index) return { status: 'unverified', verified: false, reason: 'trusted_asset_index_not_configured', assets: [] };
  const root = configuredRoot(assetConfig, index, projectId);
  if (!root) return { status: 'unverified', verified: false, reason: 'trusted_asset_root_not_authorized', assets: [] };
  const product = document.product;
  const verified = [];
  const missing = [];
  for (const asset of snapshotAssets) {
    const candidates = index.files.filter((record) => record && record.ignored !== true && record.assetId === asset.assetId);
    const scoped = candidates.filter((record) => record.familyKey === product.productFamilyKey
      && record.passportId === document.identity.passportId
      && record.skuId === document.identity.skuId
      && record.designKey === asset.designKey
      && record.sha256 === asset.sha256
      && /^[a-f0-9]{64}$/.test(record.sha256)
      && (record.projectId === undefined || record.projectId === projectId));
    if (scoped.length !== 1) {
      missing.push({ assetId: asset.assetId, reason: scoped.length > 1 ? 'ambiguous_index_binding' : 'asset_binding_not_found' });
      continue;
    }
    const record = scoped[0];
    const resolved = resolveIndexedFile(root, record.relPath);
    if (!resolved || (Number.isSafeInteger(record.size) && record.size !== resolved.size)) {
      missing.push({ assetId: asset.assetId, reason: 'indexed_file_unavailable' });
      continue;
    }
    const actualSha256 = assets.sha256(resolved.bytes);
    if (actualSha256 !== record.sha256 || actualSha256 !== asset.sha256) {
      missing.push({ assetId: asset.assetId, reason: 'indexed_file_hash_mismatch' });
      continue;
    }
    verified.push({ assetId: asset.assetId, version: asset.version, sha256: actualSha256, verified: true, source: 'trusted_asset_index_byte_read', sourceRootId: index.sourceRootId });
  }
  return {
    status: verified.length === snapshotAssets.length && snapshotAssets.length > 0 ? 'verified' : (verified.length ? 'partial' : 'unverified'),
    verified: verified.length === snapshotAssets.length && snapshotAssets.length > 0,
    ...(missing.length ? { reason: 'one_or_more_assets_lack_exact_byte_evidence', missing } : {}),
    assets: verified
  };
}

function createReadOnlySnapshotResolver(options = {}) {
  if (!isPlainObject(options)) fail('snapshot_configuration_invalid', 'snapshot resolver options must be an object');
  const metaRoot = path.resolve(nonEmpty(options.metaRoot, 'metaRoot'));
  const allowedProjects = normalizeAllowedProjects(options);
  let db = options.db;
  let ownedDb = false;
  if (!db) {
    const dbPath = nonEmpty(options.dbPath, 'dbPath');
    try {
      db = openDb(dbPath, { readOnly: true, createDir: false });
      ownedDb = true;
    } catch {
      fail('snapshot_configuration_invalid', 'the trusted creative database cannot be opened read-only');
    }
  }
  if (!db || typeof db.prepare !== 'function') fail('snapshot_configuration_invalid', 'a trusted creative database is required');
  const assetConfig = options.assets === undefined ? null : options.assets;
  const resolver = (reference) => {
    let snapshot;
    try {
      snapshot = creative.readBriefSnapshotByReference({
        metaRoot,
        db,
        briefId: reference.briefId,
        version: reference.version,
        allowedProjects
      });
    } catch (error) {
      if (error && error.code) throw error;
      fail('snapshot_unavailable', 'the trusted creative snapshot could not be read');
    }
    if (!snapshot) fail('snapshot_not_found', 'the requested persisted creative snapshot was not found');
    return {
      ...snapshot,
      media: mediaEvidence(snapshot.document, assetConfig, snapshot.document.identity.projectId)
    };
  };
  Object.defineProperty(resolver, 'close', { value: () => { if (ownedDb) db.close(); }, enumerable: false });
  return resolver;
}

module.exports = { createReadOnlySnapshotResolver, mediaEvidence };
