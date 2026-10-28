'use strict';
/**
 * CreativeBrief / ShotList + versioned dependency graph (T4.1).
 *
 * Scope of this module (all local, no provider calls, costPolicy mock_no_charge):
 * - CreativeBrief: binds project/brand/market + a CONFIRMED product passport/SKU (real stored
 *   configuration), the Amazon US / en-US target (MAIN or a numbered sub-image), output sizes and
 *   the actual asset versions. The logo layer is OFF by default and may only be enabled by a
 *   factory-injected, exact-scope logo license.
 * - Claims: external copy may only be built from facts obtained through the factory/runner trusted
 *   resolver. A payload never authorizes a fact: there is no input `facts`/`allowedClaims`/
 *   `verified` field, and unknown input fields are rejected. A fact must be `user_confirmed`, have
 *   a source reference, be current (not superseded/expired), belong to the exact project/brand/
 *   market/passport/SKU, and must NOT be an estimate or a model inference — a user-confirmed
 *   estimate stays an estimate and is never usable in external copy. Every character of every
 *   external text element must be backed by its declared claim texts; the claim text must equal the
 *   fact's approved claim wording, so an unrelated fact cannot be linked to a claim just to pass.
 * - ShotList: only angles that really have a matching, current asset of the same SKU may be
 *   planned. A requested angle without such an asset yields waiting_input (no invented back view);
 *   wrong-SKU, expired and superseded assets are refused. MAIN image rules are separated from
 *   sub-image style: MAIN cannot carry overlay copy unless the trusted rules allow it.
 * - Dependency graph: typed nodes (fact / copy / subtitle / voiceover / layer / output) and typed
 *   directed edges; no dangling references, no type mismatches, no orphans, no cycles. Every
 *   non-fact node is reachable from a fact; every output is a planned artifact only
 *   (`media.status = not_generated`) — this module never generates media.
 * - Versioning: each successful plan is a new immutable version under the trusted metaRoot plus a
 *   new row in the existing `creative_briefs` table (no schema changes). `expectedVersion` is
 *   optimistic concurrency: a stale expected version or an existing version file is refused
 *   before any business effect, and old version files are never overwritten.
 *
 * The orchestration contract is the original T2.7 registry/orchestrator: a real tool + handler is
 * registered with `registerCreativeHandler(registry, createCreativeRegistration({ domain }))`.
 * The handler takes project/brand/market/runId from the trusted execution context (a payload can
 * only match it, never widen it), and the trusted factory config supplies the resolver roots,
 * database handle, fact resolver, asset resolver and rule versions.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ORIGIN_TYPES, APPROVAL_STATUSES } = require('../evidence.js');
const packs = require('../packs.js');
const passports = require('../passports.js');

const CREATIVE_TOOL_NAME = 'creative-brief-plan.v1';
const CREATIVE_TOOL_VERSION = '1.0.0';
const CREATIVE_ROLE = 'creative';
const CREATIVE_SCHEMA_VERSION = 1;
const CREATIVE_RULE_VERSION = 'creative-rules-1.0.0';
const CREATIVE_TEMPLATE_VERSION = 'creative-brief-template-1.0.0';
const CREATIVE_SNAPSHOT_KIND = 'creative-brief-snapshot';
const CREATIVE_GRAPH_KIND = 'creative-dependency-graph';

const NODE_TYPES = Object.freeze(['fact', 'copy', 'subtitle', 'voiceover', 'layer', 'output']);
const COPY_KINDS = Object.freeze(['headline', 'body', 'bullet', 'subtitle', 'voiceover']);
const ANGLES = Object.freeze(['front', 'side', 'back', 'top', 'detail', 'lifestyle']);
const IMAGE_ROLES = Object.freeze(['MAIN', 'SUBIMAGE']);
const CLAIMABLE_ORIGINS = Object.freeze(['pdp_measured', 'seller_statement', 'user_statement']);
const NON_CLAIMABLE_ORIGINS = Object.freeze(['model_inference', 'estimate']);

/** Edge direction matrix: dependency type -> dependent types. */
const EDGE_NODE_TYPES = Object.freeze({
  fact: Object.freeze(['copy', 'subtitle', 'voiceover']),
  copy: Object.freeze(['layer', 'output']),
  subtitle: Object.freeze(['output']),
  voiceover: Object.freeze(['output']),
  layer: Object.freeze(['layer', 'output']),
  output: Object.freeze([])
});

const DEFAULT_RULES = Object.freeze({
  channels: Object.freeze(['amazon']),
  locales: Object.freeze(['en-US']),
  imageRoles: IMAGE_ROLES,
  maxShots: 8,
  maxCopyElements: 40,
  maxClaimsPerElement: 4,
  mainImage: Object.freeze({ allowOverlayText: false, allowFloatingLogo: false }),
  prohibitedClaims: Object.freeze([])
});

class CreativeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CreativeError';
    this.code = code;
  }
}

function creativeError(code, message) {
  return new CreativeError(code, message);
}

// ---------- generic validation helpers ----------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(code, message) {
  throw new CreativeError(code, message);
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail('validation', `${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, name);
}

function requireInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('validation', `${name} must be an integer in [${min}, ${max}]`);
  return value;
}

function assertKnownKeys(object, keys, name) {
  if (!isPlainObject(object)) fail('validation', `${name} must be a plain object`);
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) fail('payload_field_not_allowed', `${name}.${key} is not an allowed field (a payload can never add facts, assets, paths or authority)`);
  }
}

function requireStringArray(value, name, { nonEmpty = false, max = 100 } = {}) {
  if (!Array.isArray(value)) fail('validation', `${name} must be an array`);
  if (nonEmpty && value.length === 0) fail('validation', `${name} must not be empty`);
  if (value.length > max) fail('validation', `${name} must not contain more than ${max} entries`);
  return value.map((entry, index) => requireNonEmptyString(entry, `${name}[${index}]`));
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256File(file) {
  return sha256Hex(fs.readFileSync(file));
}

function canonical(value) {
  return packs.canonicalJson(value);
}

function hashValue(value) {
  return sha256Hex(canonical(value));
}

function normalizeSpace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function isSafeScopeText(value, name) {
  if (typeof value !== 'string') fail('invalid_scope', `${name} must be a string`);
  if (/[\u0000-\u001f\u007f/\\]/.test(value)) fail('invalid_scope', `${name} must not contain path separators or control characters`);
  return value;
}

function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(value) || value === '.' || value === '..') {
    fail('invalid_scope', `${name} must be a safe identifier ([A-Za-z0-9._-], 1-120 chars; no path traversal)`);
  }
  return value;
}

function parseInstant(value, name) {
  const text = requireNonEmptyString(value, name);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) fail('validation', `${name} must be a valid ISO instant`);
  return parsed;
}

function padVersion(version) {
  return String(version).padStart(6, '0');
}

function versionFileName(version) {
  return `v${padVersion(version)}.json`;
}

// ---------- trusted rule / grant configuration (factory-injected) ----------

function normalizeRules(raw) {
  if (raw === undefined || raw === null) return {
    channels: [...DEFAULT_RULES.channels],
    locales: [...DEFAULT_RULES.locales],
    imageRoles: [...DEFAULT_RULES.imageRoles],
    maxShots: DEFAULT_RULES.maxShots,
    maxCopyElements: DEFAULT_RULES.maxCopyElements,
    maxClaimsPerElement: DEFAULT_RULES.maxClaimsPerElement,
    mainImage: { ...DEFAULT_RULES.mainImage },
    prohibitedClaims: []
  };
  assertKnownKeys(raw, ['channels', 'locales', 'imageRoles', 'maxShots', 'maxCopyElements', 'maxClaimsPerElement', 'mainImage', 'prohibitedClaims'], 'domain.rules');
  const channels = raw.channels === undefined ? [...DEFAULT_RULES.channels] : requireStringArray(raw.channels, 'domain.rules.channels', { nonEmpty: true, max: 8 });
  const locales = raw.locales === undefined ? [...DEFAULT_RULES.locales] : requireStringArray(raw.locales, 'domain.rules.locales', { nonEmpty: true, max: 8 });
  const imageRoles = raw.imageRoles === undefined ? [...DEFAULT_RULES.imageRoles] : requireStringArray(raw.imageRoles, 'domain.rules.imageRoles', { nonEmpty: true, max: 2 });
  for (const role of imageRoles) if (!IMAGE_ROLES.includes(role)) fail('validation', `domain.rules.imageRoles contains an unknown role ${role}`);
  const mainImage = raw.mainImage === undefined ? { ...DEFAULT_RULES.mainImage } : raw.mainImage;
  assertKnownKeys(mainImage, ['allowOverlayText', 'allowFloatingLogo'], 'domain.rules.mainImage');
  for (const key of ['allowOverlayText', 'allowFloatingLogo']) {
    if (typeof mainImage[key] !== 'boolean') fail('validation', `domain.rules.mainImage.${key} must be a boolean`);
  }
  const prohibitedClaims = raw.prohibitedClaims === undefined ? [] : requireStringArray(raw.prohibitedClaims, 'domain.rules.prohibitedClaims', { max: 50 });
  return {
    channels,
    locales,
    imageRoles,
    maxShots: raw.maxShots === undefined ? DEFAULT_RULES.maxShots : requireInteger(raw.maxShots, 'domain.rules.maxShots', { min: 1, max: 16 }),
    maxCopyElements: raw.maxCopyElements === undefined ? DEFAULT_RULES.maxCopyElements : requireInteger(raw.maxCopyElements, 'domain.rules.maxCopyElements', { min: 1, max: 100 }),
    maxClaimsPerElement: raw.maxClaimsPerElement === undefined ? DEFAULT_RULES.maxClaimsPerElement : requireInteger(raw.maxClaimsPerElement, 'domain.rules.maxClaimsPerElement', { min: 1, max: 8 }),
    mainImage: { allowOverlayText: mainImage.allowOverlayText, allowFloatingLogo: mainImage.allowFloatingLogo },
    prohibitedClaims
  };
}

function normalizeLogoGrant(raw) {
  if (raw === undefined || raw === null) return null;
  assertKnownKeys(raw, ['projectId', 'brand', 'licenseRef', 'enabled'], 'domain.logoGrant');
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== 'boolean') fail('validation', 'domain.logoGrant.enabled must be a boolean');
  if (!enabled) return null;
  return {
    projectId: requireNonEmptyString(raw.projectId, 'domain.logoGrant.projectId'),
    brand: raw.brand === null || raw.brand === undefined ? '' : isSafeScopeText(raw.brand, 'domain.logoGrant.brand'),
    licenseRef: requireNonEmptyString(raw.licenseRef, 'domain.logoGrant.licenseRef')
  };
}

function logoGrantMatches(grant, projectId, brand) {
  return grant !== null && grant.projectId === projectId && grant.brand === brand;
}

// ---------- trusted fact resolver (factory-side) ----------

const FACT_KEYS = Object.freeze(['id', 'version', 'field', 'claimText', 'wordingState', 'value', 'unit', 'originType', 'approvalStatus', 'sourceRef', 'sourceUrl', 'licenseNote', 'observedAt', 'expiresAt', 'supersededBy', 'contentSha256', 'scope', 'note']);

function normalizeFact(raw, expected) {
  assertKnownKeys(raw, FACT_KEYS, 'fact');
  const id = requireNonEmptyString(raw.id, 'fact.id');
  const version = raw.version === undefined ? 1 : requireInteger(raw.version, `fact(${id}).version`, { min: 1 });
  const field = requireNonEmptyString(raw.field, `fact(${id}).field`);
  const claimText = raw.claimText === undefined || raw.claimText === null ? null : requireNonEmptyString(raw.claimText, `fact(${id}).claimText`);
  const wordingState = raw.wordingState === undefined || raw.wordingState === null ? null : requireNonEmptyString(raw.wordingState, `fact(${id}).wordingState`);
  const type = typeof raw.value;
  if (!(type === 'string' || type === 'boolean' || (type === 'number' && Number.isFinite(raw.value)))) {
    fail('validation', `fact(${id}).value must be a string, finite number or boolean`);
  }
  if (type === 'string' && raw.value.trim() === '') fail('validation', `fact(${id}).value must not be an empty string`);
  const unit = raw.unit === undefined || raw.unit === null ? null : requireNonEmptyString(raw.unit, `fact(${id}).unit`);
  if (type === 'number' && unit === null) fail('validation', `fact(${id}).unit is required for a numeric value`);
  if (!ORIGIN_TYPES.includes(raw.originType)) fail('validation', `fact(${id}).originType must be one of ${ORIGIN_TYPES.join(', ')}`);
  if (!APPROVAL_STATUSES.includes(raw.approvalStatus)) fail('validation', `fact(${id}).approvalStatus must be one of ${APPROVAL_STATUSES.join(', ')}`);
  const sourceRef = raw.sourceRef === undefined || raw.sourceRef === null ? null : requireNonEmptyString(raw.sourceRef, `fact(${id}).sourceRef`);
  const sourceUrl = raw.sourceUrl === undefined || raw.sourceUrl === null ? null : requireNonEmptyString(raw.sourceUrl, `fact(${id}).sourceUrl`);
  const licenseNote = raw.licenseNote === undefined || raw.licenseNote === null ? null : requireNonEmptyString(raw.licenseNote, `fact(${id}).licenseNote`);
  const observedAt = raw.observedAt === undefined || raw.observedAt === null ? null : requireNonEmptyString(raw.observedAt, `fact(${id}).observedAt`);
  if (observedAt !== null) parseInstant(observedAt, `fact(${id}).observedAt`);
  const expiresAt = raw.expiresAt === undefined || raw.expiresAt === null ? null : requireNonEmptyString(raw.expiresAt, `fact(${id}).expiresAt`);
  if (expiresAt !== null) parseInstant(expiresAt, `fact(${id}).expiresAt`);
  const supersededBy = raw.supersededBy === undefined || raw.supersededBy === null ? null : requireNonEmptyString(raw.supersededBy, `fact(${id}).supersededBy`);
  const scope = raw.scope;
  assertKnownKeys(scope, ['projectId', 'brand', 'market', 'passportId', 'skuId'], `fact(${id}).scope`);
  const scopeBrand = scope.brand === null || scope.brand === undefined ? '' : scope.brand;
  const scopeMatches = scope.projectId === expected.projectId
    && scopeBrand === expected.brand
    && scope.market === expected.market
    && scope.passportId === expected.passportId
    && scope.skuId === expected.skuId;
  if (!scopeMatches) {
    fail('fact_scope_mismatch', `fact ${id} does not belong to the exact project/brand/market/passport/SKU scope of this brief`);
  }
  // The content hash binds the FACT CONTENT (value/unit/version/source/license) but never the
  // wording: the wording is authorized by a per-fact grant (see createObservationFactResolver).
  const core = { id, version, field, value: raw.value, unit, originType: raw.originType, approvalStatus: raw.approvalStatus, sourceRef, sourceUrl, licenseNote, observedAt, expiresAt, supersededBy };
  const contentSha256 = raw.contentSha256 === undefined || raw.contentSha256 === null
    ? hashValue(core)
    : requireNonEmptyString(raw.contentSha256, `fact(${id}).contentSha256`);
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) fail('validation', `fact(${id}).contentSha256 must be 64 lowercase hex characters`);
  return {
    id,
    version,
    field,
    claimText,
    wordingState,
    value: raw.value,
    unit,
    originType: raw.originType,
    approvalStatus: raw.approvalStatus,
    sourceRef,
    sourceUrl,
    licenseNote,
    observedAt,
    expiresAt,
    supersededBy,
    contentSha256,
    scope: { projectId: expected.projectId, brand: expected.brand, market: expected.market, passportId: expected.passportId, skuId: expected.skuId }
  };
}

// ---------- wording authorization (F1) ----------
// A field-key wording map may only be used as a bounded legacy compatibility guard: the wording
// must embed the CURRENT value and unit. It is never treated as semantic verification. The safe
// contract is a per-fact grant (fact id + optional contentSha256/value/unit) with an explicit
// fixed wording or a closed deterministic template using {value}/{unit}.
const CLAIM_AUTHORIZATION_KEYS = Object.freeze(['claimText', 'template', 'value', 'unit', 'contentSha256']);

function legacyWordingSafe(value, unit, text) {
  const valueText = String(value).trim();
  const wording = normalizeSpace(text);
  if (wording === '') return false;
  const numeric = /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(valueText);
  if (numeric) {
    if (unit === null || String(unit).trim() === '') return false;
    const numbers = wording.match(/[+-]?\d+(?:\.\d+)?/g) ?? [];
    if (numbers.length === 0) return false;
    if (!numbers.every((token) => Number(token) === Number(valueText))) return false;
    if (!wording.toLowerCase().includes(String(unit).toLowerCase())) return false;
    return true;
  }
  return wording.toLowerCase().includes(normalizeSpace(valueText).toLowerCase());
}

function renderClaimTemplate(template, value, unit) {
  const tokens = template.match(/\{[^}]*\}/g) ?? [];
  for (const token of tokens) {
    if (token !== '{value}' && token !== '{unit}') fail('validation', `claim authorization template contains an unsupported placeholder ${token}`);
  }
  if (tokens.includes('{unit}') && (unit === null || String(unit).trim() === '')) {
    return { ok: false, text: null };
  }
  const text = normalizeSpace(template.replace(/\{value\}/g, String(value)).replace(/\{unit\}/g, unit === null ? '' : String(unit)));
  if (text === '') return { ok: false, text: null };
  return { ok: true, text };
}

function normalizeClaimAuthorizations(raw) {
  if (raw === undefined || raw === null) return new Map();
  if (!isPlainObject(raw)) fail('validation', 'claimAuthorizations must be a plain object keyed by fact id');
  const map = new Map();
  for (const [factId, entry] of Object.entries(raw)) {
    requireNonEmptyString(factId, 'claimAuthorizations fact id');
    assertKnownKeys(entry, CLAIM_AUTHORIZATION_KEYS, `claimAuthorizations.${factId}`);
    const hasText = entry.claimText !== undefined;
    const hasTemplate = entry.template !== undefined;
    if (hasText === hasTemplate) fail('validation', `claimAuthorizations.${factId} needs exactly one of claimText/template`);
    if (hasText) requireNonEmptyString(entry.claimText, `claimAuthorizations.${factId}.claimText`);
    if (hasTemplate) {
      requireNonEmptyString(entry.template, `claimAuthorizations.${factId}.template`);
      for (const token of entry.template.match(/\{[^}]*\}/g) ?? []) {
        if (token !== '{value}' && token !== '{unit}') fail('validation', `claimAuthorizations.${factId}.template contains an unsupported placeholder ${token}`);
      }
    }
    const normalized = {
      ...(hasText ? { claimText: entry.claimText } : {}),
      ...(hasTemplate ? { template: entry.template } : {}),
      ...(entry.value === undefined ? {} : { value: entry.value }),
      ...(entry.unit === undefined ? {} : { unit: entry.unit }),
      ...(entry.contentSha256 === undefined ? {} : { contentSha256: requireNonEmptyString(entry.contentSha256, `claimAuthorizations.${factId}.contentSha256`) })
    };
    if (normalized.contentSha256 !== undefined && !/^[a-f0-9]{64}$/.test(normalized.contentSha256)) {
      fail('validation', `claimAuthorizations.${factId}.contentSha256 must be 64 lowercase hex characters`);
    }
    map.set(factId, normalized);
  }
  return map;
}

// ---------- external-use permission (F2) ----------
// Verification (approvalStatus) and external-use permission are independent. A confirmed fact is
// only usable in external advertising when the factory/runner explicitly grants it per source or
// fact at the exact scope. Missing/unknown = not granted (waiting_input); explicit false = denied.
// The licenseNote is preserved verbatim for audit but is never parsed as permission.
function normalizeExternalUse(raw) {
  if (raw === undefined || raw === null) return { defaultPolicy: 'deny', sources: [], facts: [] };
  assertKnownKeys(raw, ['defaultPolicy', 'sources', 'facts'], 'domain.externalUse');
  if (raw.defaultPolicy !== undefined && raw.defaultPolicy !== 'deny') {
    fail('validation', "domain.externalUse.defaultPolicy must be 'deny' (external use is fail-closed)");
  }
  const normalizeEntry = (entry, kind, index) => {
    const idKey = kind === 'sources' ? 'sourceRef' : 'factId';
    assertKnownKeys(entry, [idKey, 'allowed', 'basis', 'scope'], `domain.externalUse.${kind}[${index}]`);
    const id = requireNonEmptyString(entry[idKey], `domain.externalUse.${kind}[${index}].${idKey}`);
    if (typeof entry.allowed !== 'boolean') fail('validation', `domain.externalUse.${kind}[${index}].allowed must be a boolean`);
    const basis = requireNonEmptyString(entry.basis, `domain.externalUse.${kind}[${index}].basis`);
    let scope = null;
    if (entry.scope !== undefined) {
      assertKnownKeys(entry.scope, ['projectId', 'brand', 'market'], `domain.externalUse.${kind}[${index}].scope`);
      scope = {
        projectId: requireNonEmptyString(entry.scope.projectId, `domain.externalUse.${kind}[${index}].scope.projectId`),
        ...(entry.scope.brand === undefined ? {} : { brand: entry.scope.brand === null ? '' : isSafeScopeText(entry.scope.brand, 'externalUse.brand') }),
        ...(entry.scope.market === undefined ? {} : { market: requireNonEmptyString(entry.scope.market, `domain.externalUse.${kind}[${index}].scope.market`) })
      };
    }
    return { id, allowed: entry.allowed, basis, scope };
  };
  const sources = raw.sources === undefined ? [] : raw.sources;
  const facts = raw.facts === undefined ? [] : raw.facts;
  if (!Array.isArray(sources) || !Array.isArray(facts)) fail('validation', 'domain.externalUse.sources/facts must be arrays');
  if (sources.length > 500 || facts.length > 500) fail('validation', 'domain.externalUse lists are too large');
  const normalizedSources = sources.map((entry, index) => normalizeEntry(entry, 'sources', index));
  const normalizedFacts = facts.map((entry, index) => normalizeEntry(entry, 'facts', index));
  const sourceIds = new Set();
  for (const entry of normalizedSources) {
    if (sourceIds.has(entry.id)) fail('validation', `domain.externalUse.sources has a duplicate sourceRef ${entry.id}`);
    sourceIds.add(entry.id);
  }
  const factIds = new Set();
  for (const entry of normalizedFacts) {
    if (factIds.has(entry.id)) fail('validation', `domain.externalUse.facts has a duplicate factId ${entry.id}`);
    factIds.add(entry.id);
  }
  return { defaultPolicy: 'deny', sources: normalizedSources, facts: normalizedFacts };
}

function externalScopeMatches(scope, factScope) {
  if (scope === null) return true;
  if (scope.projectId !== factScope.projectId) return false;
  if (scope.brand !== undefined && scope.brand !== factScope.brand) return false;
  if (scope.market !== undefined && scope.market !== factScope.market) return false;
  return true;
}

function externalUseDecision(externalUse, fact, scope) {
  for (const entry of externalUse.facts) {
    if (entry.id === fact.id && externalScopeMatches(entry.scope, scope)) {
      return { granted: true, allowed: entry.allowed, basis: entry.basis, source: 'fact' };
    }
  }
  for (const entry of externalUse.sources) {
    if (entry.id === fact.sourceRef && externalScopeMatches(entry.scope, scope)) {
      return { granted: true, allowed: entry.allowed, basis: entry.basis, source: 'source' };
    }
  }
  return { granted: false, allowed: false, basis: null, source: null };
}

function factClaimability(fact, nowMs, externalUse) {
  if (fact.approvalStatus === 'rejected') return { claimable: false, reason: 'fact_rejected' };
  if (fact.approvalStatus !== 'user_confirmed') return { claimable: false, reason: 'fact_not_approved' };
  if (NON_CLAIMABLE_ORIGINS.includes(fact.originType)) return { claimable: false, reason: 'fact_origin_not_claimable' };
  if (fact.sourceRef === null) return { claimable: false, reason: 'fact_source_missing' };
  if (fact.licenseNote === null) return { claimable: false, reason: 'fact_license_missing' };
  if (fact.supersededBy !== null) return { claimable: false, reason: 'fact_superseded' };
  if (fact.expiresAt !== null && Date.parse(fact.expiresAt) <= nowMs) return { claimable: false, reason: 'fact_expired' };
  if (fact.claimText === null) return { claimable: false, reason: 'claim_text_missing' };
  const external = externalUse === undefined ? { granted: false, allowed: false } : externalUse;
  if (external.granted !== true) return { claimable: false, reason: 'external_use_not_granted' };
  if (external.allowed !== true) return { claimable: false, reason: 'external_use_denied' };
  return { claimable: true, reason: null };
}

function collectFacts({ factResolver, projectId, brand, market, passportId, skuId, nowMs, externalUse }) {
  const raw = factResolver({ projectId, brand, market, passportId, skuId });
  if (!Array.isArray(raw)) fail('validation', 'domain.factResolver must return an array of facts');
  const expected = { projectId, brand, market, passportId, skuId };
  const use = externalUse ?? { defaultPolicy: 'deny', sources: [], facts: [] };
  const facts = [];
  const ids = new Set();
  for (const entry of raw) {
    const fact = normalizeFact(entry, expected);
    if (ids.has(fact.id)) fail('duplicate_fact', `the trusted resolver returned duplicate fact id ${fact.id}`);
    ids.add(fact.id);
    const decision = externalUseDecision(use, fact, expected);
    const external = {
      granted: decision.granted,
      allowed: decision.allowed,
      ...(decision.basis === null ? {} : { basis: decision.basis }),
      ...(decision.source === null ? {} : { source: decision.source })
    };
    facts.push({ ...fact, externalUse: external, ...factClaimability(fact, nowMs, external) });
  }
  return facts;
}

/**
 * Trusted convenience resolver over the approved observation chain (T1.3 module reads only).
 *
 * Wording is authorized per fact id (F1):
 * - `claimAuthorizations`: `{ [observationId]: { claimText, value?, unit?, contentSha256? } }`
 *   (an explicit fixed wording) or `{ [observationId]: { template:'Up to {value} {unit} …',
 *   value?, unit?, contentSha256? } }` (a closed deterministic template). The optional value/unit/
 *   contentSha256 must match the current observation; a mismatch yields NO wording (never the old
 *   wording). The fact id changes on an observation revision, so old wording is never inherited.
 * - `claimTexts`: LEGACY field-key map kept only as a bounded compatibility guard. The mapped text
 *   is used only when it embeds the current value and unit (numeric facts: every numeric token must
 *   equal the current value and the unit must appear; text facts: the current value must appear).
 *   It is never semantic verification and never authorizes a different number/negation.
 *
 * External-use permission is a SEPARATE trusted contract (`externalUse` on the registration /
 * builder); a confirmed fact is not automatically licensed for external advertising.
 */
function createObservationFactResolver({ db, claimTexts = {}, claimAuthorizations = {} } = {}) {
  if (!db || typeof db.prepare !== 'function') fail('validation', 'createObservationFactResolver needs a trusted db handle');
  if (!isPlainObject(claimTexts)) fail('validation', 'claimTexts must be a plain object');
  for (const [key, value] of Object.entries(claimTexts)) {
    requireNonEmptyString(key, 'claimTexts key');
    requireNonEmptyString(value, `claimTexts.${key}`);
  }
  const authorizations = normalizeClaimAuthorizations(claimAuthorizations);
  // eslint-disable-next-line global-require
  const evidenceModule = require('../evidence.js');
  return ({ projectId, brand, market, passportId, skuId }) => {
    const facts = [];
    for (const [subjectType, subjectId] of [['passport', passportId], ['sku', skuId]]) {
      const rows = evidenceModule.listObservations(db, projectId, { subjectType, subjectId });
      for (const row of rows) {
        const sourceRef = row.evidence_id === null || row.evidence_id === undefined ? null : row.evidence_id;
        const evidenceRow = sourceRef === null ? null : evidenceModule.getEvidence(db, projectId, sourceRef);
        const core = {
          id: row.id,
          version: 1,
          field: row.key,
          value: row.value_text,
          unit: row.unit === null || row.unit === undefined ? null : row.unit,
          originType: row.origin_type,
          approvalStatus: row.approval_status,
          sourceRef,
          licenseNote: evidenceRow === null || evidenceRow.license_note === null || evidenceRow.license_note === undefined ? null : evidenceRow.license_note,
          observedAt: row.observed_at,
          expiresAt: row.expires_at === null || row.expires_at === undefined ? null : row.expires_at,
          supersededBy: row.superseded_by === null || row.superseded_by === undefined ? null : row.superseded_by
        };
        const contentSha256 = hashValue(core);
        const authorization = authorizations.get(row.id);
        let claimText = null;
        let wordingState = 'unbound';
        if (authorization !== undefined) {
          const valueOk = authorization.value === undefined || String(authorization.value) === String(core.value);
          const unitOk = authorization.unit === undefined
            || (authorization.unit === null ? core.unit === null : core.unit === authorization.unit);
          const hashOk = authorization.contentSha256 === undefined || authorization.contentSha256 === contentSha256;
          if (!valueOk || !unitOk || !hashOk) {
            claimText = null;
            wordingState = 'authorization_mismatch';
          } else if (authorization.template !== undefined) {
            const rendered = renderClaimTemplate(authorization.template, core.value, core.unit);
            claimText = rendered.ok ? rendered.text : null;
            wordingState = rendered.ok ? 'template' : 'template_mismatch';
          } else {
            claimText = authorization.claimText;
            wordingState = 'fact_authorization';
          }
        } else if (claimTexts[row.key] !== undefined) {
          const candidate = claimTexts[row.key];
          if (legacyWordingSafe(core.value, core.unit, candidate)) {
            claimText = candidate;
            wordingState = 'legacy_field_map';
          } else {
            claimText = null;
            wordingState = 'legacy_value_mismatch';
          }
        }
        facts.push({
          ...core,
          claimText,
          wordingState,
          contentSha256,
          scope: { projectId, brand, market, passportId, skuId }
        });
      }
    }
    return facts;
  };
}

// ---------- trusted asset resolver (factory-side) ----------

const ASSET_KEYS = Object.freeze(['assetId', 'version', 'sha256', 'format', 'width', 'height', 'familyKey', 'passportId', 'skuId', 'designKey', 'angle', 'role', 'observedAt', 'expiresAt', 'supersededBy', 'note']);

function normalizeAsset(raw, expected) {
  assertKnownKeys(raw, ASSET_KEYS, 'asset');
  const assetId = requireNonEmptyString(raw.assetId, 'asset.assetId');
  const version = raw.version === undefined ? 1 : requireInteger(raw.version, `asset(${assetId}).version`, { min: 1 });
  const sha256 = requireNonEmptyString(raw.sha256, `asset(${assetId}).sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail('validation', `asset(${assetId}).sha256 must be 64 lowercase hex characters`);
  const format = requireNonEmptyString(raw.format, `asset(${assetId}).format`);
  const width = requireInteger(raw.width, `asset(${assetId}).width`, { min: 1 });
  const height = requireInteger(raw.height, `asset(${assetId}).height`, { min: 1 });
  const familyKey = requireNonEmptyString(raw.familyKey, `asset(${assetId}).familyKey`);
  const passportId = requireNonEmptyString(raw.passportId, `asset(${assetId}).passportId`);
  const skuId = requireNonEmptyString(raw.skuId, `asset(${assetId}).skuId`);
  const designKey = requireNonEmptyString(raw.designKey, `asset(${assetId}).designKey`);
  if (!ANGLES.includes(raw.angle)) fail('validation', `asset(${assetId}).angle must be one of ${ANGLES.join(', ')}`);
  const role = raw.role === undefined || raw.role === null ? null : requireNonEmptyString(raw.role, `asset(${assetId}).role`);
  const observedAt = raw.observedAt === undefined || raw.observedAt === null ? null : requireNonEmptyString(raw.observedAt, `asset(${assetId}).observedAt`);
  if (observedAt !== null) parseInstant(observedAt, `asset(${assetId}).observedAt`);
  const expiresAt = raw.expiresAt === undefined || raw.expiresAt === null ? null : requireNonEmptyString(raw.expiresAt, `asset(${assetId}).expiresAt`);
  if (expiresAt !== null) parseInstant(expiresAt, `asset(${assetId}).expiresAt`);
  const supersededBy = raw.supersededBy === undefined || raw.supersededBy === null ? null : requireNonEmptyString(raw.supersededBy, `asset(${assetId}).supersededBy`);
  if (passportId !== expected.passportId || skuId !== expected.skuId || familyKey !== expected.familyKey) {
    fail('asset_scope_mismatch', `asset ${assetId} does not belong to the exact passport/SKU/product family of this brief`);
  }
  if (designKey !== expected.designKey) {
    fail('asset_design_mismatch', `asset ${assetId} is design ${designKey}, not the current design ${expected.designKey}; a similar SKU ID never proves the same design`);
  }
  return { assetId, version, sha256, format, width, height, familyKey, passportId, skuId, designKey, angle: raw.angle, role, observedAt, expiresAt, supersededBy };
}

function collectAssets({ assetResolver, projectId, passportId, skuId, familyKey, designKey }) {
  const raw = assetResolver({ projectId, passportId, skuId, familyKey, designKey });
  if (!Array.isArray(raw)) fail('validation', 'domain.assetResolver must return an array of assets');
  const expected = { projectId, passportId, skuId, familyKey, designKey };
  const assets = [];
  const ids = new Set();
  for (const entry of raw) {
    const asset = normalizeAsset(entry, expected);
    if (ids.has(asset.assetId)) fail('duplicate_asset', `the trusted resolver returned duplicate asset id ${asset.assetId}`);
    ids.add(asset.assetId);
    assets.push(asset);
  }
  return assets;
}

// ---------- target resolution (real stored passport/SKU) ----------

function resolveCreativeTarget({ db, projectId, brand, market, product }) {
  if (!db || typeof db.prepare !== 'function') fail('validation', 'a trusted db handle is required');
  const passportId = requireNonEmptyString(product.passportId, 'product.passportId');
  const skuId = requireNonEmptyString(product.skuId, 'product.skuId');
  const passport = passports.getPassport(db, projectId, passportId);
  if (!passport) fail('passport_not_found', 'the requested passport does not exist in this project');
  const passportBrand = passport.brand_key === null || passport.brand_key === undefined ? '' : passport.brand_key;
  if (passportBrand !== brand) fail('passport_scope_mismatch', 'the passport brand does not match the exact execution brand (an empty brand is never a wildcard)');
  if (passport.status !== 'confirmed') {
    return { status: 'waiting_input', reason: 'passport_not_confirmed', gaps: [{ code: 'passport_not_confirmed', passportId }] };
  }
  const sku = passports.getSku(db, projectId, skuId);
  if (!sku) fail('sku_not_found', 'the requested SKU does not exist in this project');
  if (sku.product_passport_id !== passport.id) fail('sku_passport_mismatch', 'the SKU does not belong to the requested passport');
  if (sku.deleted_at || sku.status === 'archived') {
    return { status: 'waiting_input', reason: 'sku_not_active', gaps: [{ code: 'sku_not_active', skuId }] };
  }
  return { status: 'resolved', passport, sku, market };
}

/**
 * Current design lineage (F3). The real SKU attributes may declare `designKey`; a factory/runner
 * design contract may supply the current design when the stored SKU has no design metadata. They
 * must agree when both exist. No design metadata at all = waiting_input (never invent a design).
 */
function resolveCurrentDesign({ design, projectId, passportId, skuId, attributes }) {
  let skuDesign = null;
  if (attributes.designKey !== undefined && attributes.designKey !== null) {
    skuDesign = requireNonEmptyString(attributes.designKey, 'SKU attributes.designKey');
  }
  let configured = null;
  let source = null;
  if (design !== undefined && design !== null) {
    let value;
    if (typeof design === 'function') {
      value = design({ projectId, passportId, skuId });
    } else {
      assertKnownKeys(design, ['projectId', 'passportId', 'skuId', 'designKey'], 'domain.design');
      if (design.projectId !== projectId || design.passportId !== passportId || design.skuId !== skuId) {
        fail('design_scope_mismatch', 'domain.design does not target the exact project/passport/SKU');
      }
      value = design.designKey;
    }
    if (value !== undefined && value !== null) {
      configured = requireNonEmptyString(value, 'domain.design.designKey');
      source = 'factory_design';
    }
  }
  if (skuDesign !== null && configured !== null && skuDesign !== configured) {
    fail('design_conflict', `the SKU declares design ${skuDesign} but the factory design contract says ${configured}`);
  }
  if (configured !== null) return { status: 'resolved', designKey: configured, source };
  if (skuDesign !== null) return { status: 'resolved', designKey: skuDesign, source: 'sku_attributes' };
  return { status: 'waiting_input', reason: 'design_unknown', gaps: [{ code: 'design_unknown', passportId, skuId }] };
}

// ---------- claim policy ----------

function buildForbiddenList(rules, inputForbidden) {
  const entries = [];
  const seen = new Set();
  const push = (text, source) => {
    const normalized = normalizeSpace(text);
    if (normalized === '') return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ text: normalized, source });
  };
  for (const text of rules.prohibitedClaims) push(text, 'trusted_rules');
  if (inputForbidden !== undefined) {
    for (const text of requireStringArray(inputForbidden, 'forbiddenClaims', { max: 20 })) push(text, 'brief');
  }
  return entries;
}

function assertNotForbidden(text, forbidden) {
  const normalized = normalizeSpace(text).toLowerCase();
  for (const entry of forbidden) {
    if (normalized.includes(entry.text.toLowerCase())) {
      fail('forbidden_claim', `the copy contains a forbidden claim (${entry.text}); forbidden claims are never used even when a fact exists`);
    }
  }
}

function claimOutcome(fact) {
  if (fact.claimable) return { status: 'resolved', claim: { text: fact.claimText, factId: fact.id, fact } };
  if (fact.reason === 'fact_not_approved' || fact.reason === 'claim_text_missing' || fact.reason === 'external_use_not_granted') {
    return { status: 'waiting_input', reason: `${fact.reason}:${fact.field}` };
  }
  fail(fact.reason, `fact ${fact.id} is not claimable: ${fact.reason}`);
  return null;
}

function resolveClaimText({ text, factId, facts, factsById, forbidden }) {
  const claimText = requireNonEmptyString(text, 'claim.text');
  assertNotForbidden(claimText, forbidden);
  if (factId !== undefined) {
    const id = requireNonEmptyString(factId, 'claim.factId');
    const fact = factsById.get(id);
    if (!fact) fail('fact_not_found', `the claim references fact ${id}, which the trusted resolver did not return`);
    if (fact.claimText !== claimText) {
      fail('claim_text_mismatch', `the claim text does not equal the approved wording of fact ${id}; an unrelated fact cannot authorize a claim`);
    }
    return claimOutcome(fact);
  }
  const sameText = facts.filter((fact) => fact.claimText === claimText);
  if (sameText.length === 0) return { status: 'waiting_input', reason: `fact_missing:${claimText.slice(0, 120)}` };
  const claimable = sameText.filter((fact) => fact.claimable);
  if (claimable.length === 0) return claimOutcome(sameText[0]);
  if (claimable.length > 1) fail('ambiguous_fact', `more than one claimable fact carries the same approved wording (${claimText})`);
  return claimOutcome(claimable[0]);
}

// ---------- copy ----------

function resolveCopy({ rawCopy, facts, factsById, nowMs, forbidden, maxCopyElements, maxClaimsPerElement }) {
  if (!Array.isArray(rawCopy)) fail('validation', 'copy must be an array');
  if (rawCopy.length === 0) fail('validation', 'copy must not be empty');
  if (rawCopy.length > maxCopyElements) fail('validation', `copy must not contain more than ${maxCopyElements} elements`);
  const elements = [];
  const ids = new Set();
  for (const entry of rawCopy) {
    assertKnownKeys(entry, ['id', 'kind', 'text', 'claims'], 'copy[]');
    const id = requireNonEmptyString(entry.id, 'copy[].id');
    if (ids.has(id)) fail('duplicate_copy_id', `duplicate copy element id ${id}`);
    ids.add(id);
    if (!COPY_KINDS.includes(entry.kind)) fail('validation', `copy(${id}).kind must be one of ${COPY_KINDS.join(', ')}`);
    const text = requireNonEmptyString(entry.text, `copy(${id}).text`);
    if (!Array.isArray(entry.claims) || entry.claims.length === 0) {
      fail('unbound_claim', `copy(${id}) has no claim binding; every external text element must be backed by an approved fact`);
    }
    if (entry.claims.length > maxClaimsPerElement) fail('validation', `copy(${id}) must not contain more than ${maxClaimsPerElement} claims`);
    const claims = [];
    for (const rawClaim of entry.claims) {
      assertKnownKeys(rawClaim, ['text', 'factId'], `copy(${id}).claims[]`);
      const resolved = resolveClaimText({
        text: rawClaim.text,
        factId: rawClaim.factId,
        facts,
        factsById,
        forbidden
      });
      if (resolved.status === 'waiting_input') return resolved;
      claims.push(resolved.claim);
    }
    const boundText = claims.map((claim) => normalizeSpace(claim.text)).join(' ');
    if (normalizeSpace(text) !== boundText) {
      fail('copy_text_not_bound', `copy(${id}) contains text that is not covered by its claims; every sentence must be bound to approved facts (including body text)`);
    }
    elements.push({ id, kind: entry.kind, text: boundText, claims });
  }
  return { status: 'resolved', elements };
}

// ---------- shots ----------

function resolveShots({ rawShots, assets, copyElements, target, rules, logo, nowMs }) {
  if (!Array.isArray(rawShots)) fail('validation', 'shots must be an array');
  if (rawShots.length === 0) fail('validation', 'shots must not be empty');
  if (rawShots.length > rules.maxShots) fail('validation', `shots must not contain more than ${rules.maxShots} shots`);
  const copyById = new Map(copyElements.map((element) => [element.id, element]));
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));
  const availableAngles = [...new Set(assets.map((asset) => asset.angle))].sort();
  const shots = [];
  const ids = new Set();
  for (const entry of rawShots) {
    assertKnownKeys(entry, ['id', 'angle', 'assetId', 'assetVersion', 'copyIds'], 'shots[]');
    const shotId = requireNonEmptyString(entry.id, 'shots[].id');
    if (ids.has(shotId)) fail('duplicate_shot_id', `duplicate shot id ${shotId}`);
    ids.add(shotId);
    if (!ANGLES.includes(entry.angle)) fail('validation', `shot(${shotId}).angle must be one of ${ANGLES.join(', ')}`);
    if (entry.assetId === undefined) {
      return { status: 'waiting_input', reason: `asset_missing:${shotId}`, gaps: [{ code: 'asset_missing', shotId, angle: entry.angle }] };
    }
    const assetId = requireNonEmptyString(entry.assetId, `shot(${shotId}).assetId`);
    const copyIds = entry.copyIds === undefined ? [] : requireStringArray(entry.copyIds, `shot(${shotId}).copyIds`, { max: rules.maxCopyElements });
    for (const copyId of copyIds) {
      if (!copyById.has(copyId)) fail('copy_not_found', `shot(${shotId}) references unknown copy element ${copyId}`);
      if (!['headline', 'body', 'bullet'].includes(copyById.get(copyId).kind)) {
        fail('shot_copy_kind_not_allowed', `shot(${shotId}) may only overlay headline/body/bullet copy; subtitle/voiceover copy is time-based`);
      }
    }
    if (target.imageRole === 'MAIN' && copyIds.length > 0 && rules.mainImage.allowOverlayText !== true) {
      fail('main_image_overlay_not_allowed', 'MAIN image rules separate from sub-image style: overlay copy on MAIN is not allowed by the trusted rules');
    }
    if (target.imageRole === 'MAIN' && logo.enabled && rules.mainImage.allowFloatingLogo !== true) {
      fail('main_image_logo_not_allowed', 'a MAIN image cannot carry a floating logo unless the trusted rules allow it');
    }
    const asset = assetById.get(assetId);
    if (!asset) {
      const angleAvailable = assets.some((candidate) => candidate.angle === entry.angle);
      if (!angleAvailable) {
        return {
          status: 'waiting_input',
          reason: `angle_unavailable:${entry.angle}`,
          gaps: [{ code: 'angle_unavailable', shotId, angle: entry.angle, availableAngles }]
        };
      }
      fail('asset_not_found', `shot(${shotId}) references unknown asset ${assetId}`);
    }
    if (asset.angle !== entry.angle) fail('asset_angle_mismatch', `asset ${assetId} is not a ${entry.angle} view (it is ${asset.angle}); a shot is never invented`);
    if (entry.assetVersion !== undefined && requireInteger(entry.assetVersion, `shot(${shotId}).assetVersion`, { min: 1 }) !== asset.version) {
      fail('asset_version_conflict', `shot(${shotId}) requested asset version ${entry.assetVersion} but the current version is ${asset.version}`);
    }
    if (asset.supersededBy !== null) fail('asset_superseded', `asset ${assetId} is superseded; a stale asset is never used`);
    if (asset.expiresAt !== null && Date.parse(asset.expiresAt) <= nowMs) fail('asset_expired', `asset ${assetId} is expired`);
    const factIds = [];
    for (const copyId of copyIds) {
      for (const claim of copyById.get(copyId).claims) if (!factIds.includes(claim.factId)) factIds.push(claim.factId);
    }
    shots.push({
      shotId,
      angle: asset.angle,
      asset: {
        assetId: asset.assetId,
        version: asset.version,
        sha256: asset.sha256,
        designKey: asset.designKey,
        format: asset.format,
        width: asset.width,
        height: asset.height,
        ...(asset.role === null ? {} : { role: asset.role })
      },
      copyIds: [...copyIds],
      factIds,
      constraints: {
        imageRole: target.imageRole,
        overlayCopy: copyIds.length > 0,
        logoEnabled: logo.enabled,
        mediaStatus: 'not_generated'
      }
    });
  }
  return { status: 'resolved', shots, availableAngles };
}

// ---------- dependency graph ----------

function buildDependencyGraph({ version, shots, copyElements, factsUsed, logo, videoShotIds }) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const addNode = (node) => {
    if (nodeIds.has(node.id)) fail('duplicate_node', `duplicate graph node ${node.id}`);
    nodeIds.add(node.id);
    nodes.push(node);
  };
  const addEdge = (from, to, kind) => {
    if (from === to) fail('invalid_graph', `self edge ${from}`);
    if (!nodeIds.has(from) || !nodeIds.has(to)) fail('invalid_graph', `dangling edge ${from} -> ${to}`);
    if (edges.some((edge) => edge.from === from && edge.to === to)) fail('duplicate_edge', `duplicate edge ${from} -> ${to}`);
    edges.push({ from, to, kind });
  };

  const factNodeId = (factId) => `fact:${factId}`;
  const elementType = (kind) => (kind === 'subtitle' ? 'subtitle' : kind === 'voiceover' ? 'voiceover' : 'copy');
  const elementNodeId = (element) => `${element.kind === 'subtitle' ? 'subtitle' : element.kind === 'voiceover' ? 'voiceover' : 'copy'}:${element.id}`;

  for (const fact of factsUsed) {
    addNode({ id: factNodeId(fact.id), type: 'fact', ref: fact.id, data: { field: fact.field, version: fact.version, contentSha256: fact.contentSha256, originType: fact.originType } });
  }
  for (const element of copyElements) {
    const type = elementType(element.kind);
    addNode({ id: elementNodeId(element), type, ref: element.id, data: { kind: element.kind, text: element.text, factIds: element.claims.map((claim) => claim.factId) } });
  }
  for (const element of copyElements) {
    for (const claim of element.claims) addEdge(factNodeId(claim.factId), elementNodeId(element), 'claim');
  }

  const shotOutputs = [];
  for (const shot of shots) {
    const productLayer = `layer:${shot.shotId}:product`;
    addNode({ id: productLayer, type: 'layer', ref: `${shot.shotId}:product`, data: { shotId: shot.shotId, role: 'product', assetId: shot.asset.assetId, assetVersion: shot.asset.version, sha256: shot.asset.sha256, designKey: shot.asset.designKey } });
    if (shot.copyIds.length > 0) {
      const textLayer = `layer:${shot.shotId}:text`;
      addNode({ id: textLayer, type: 'layer', ref: `${shot.shotId}:text`, data: { shotId: shot.shotId, role: 'text', copyIds: [...shot.copyIds] } });
      for (const copyId of shot.copyIds) addEdge(elementNodeId(copyElements.find((element) => element.id === copyId)), textLayer, 'render');
      const output = `out:shot:${shot.shotId}`;
      addNode({ id: output, type: 'output', ref: `shot:${shot.shotId}`, data: { kind: 'image', shotId: shot.shotId, mediaStatus: 'not_generated' } });
      addEdge(textLayer, output, 'compose');
      addEdge(productLayer, output, 'compose');
      shotOutputs.push(output);
    } else {
      const output = `out:shot:${shot.shotId}`;
      addNode({ id: output, type: 'output', ref: `shot:${shot.shotId}`, data: { kind: 'image', shotId: shot.shotId, mediaStatus: 'not_generated' } });
      addEdge(productLayer, output, 'compose');
      shotOutputs.push(output);
    }
  }
  if (logo.enabled) {
    addNode({ id: 'layer:logo', type: 'layer', ref: 'logo', data: { role: 'logo', licenseRef: logo.licenseRef } });
    for (const output of shotOutputs) addEdge('layer:logo', output, 'stack');
  }

  const listingCopy = copyElements.filter((element) => ['headline', 'body', 'bullet'].includes(element.kind));
  if (listingCopy.length > 0) {
    addNode({ id: 'out:listing', type: 'output', ref: 'listing', data: { kind: 'listing', mediaStatus: 'not_generated' } });
    for (const element of listingCopy) addEdge(elementNodeId(element), 'out:listing', 'publish');
  }
  const timedCopy = copyElements.filter((element) => ['subtitle', 'voiceover'].includes(element.kind));
  const videoShots = shots.filter((shot) => videoShotIds.includes(shot.shotId));
  if (videoShotIds.length > 0 || timedCopy.length > 0) {
    addNode({
      id: 'out:video',
      type: 'output',
      ref: 'video',
      data: {
        kind: 'video',
        mediaStatus: 'not_generated',
        ...(videoShotIds.length === 0 ? {} : { shotIds: [...videoShotIds] }),
        ...(videoShots.length === 0 ? {} : { sourceSha256: videoShots.map((shot) => shot.asset.sha256) })
      }
    });
    // the planned video uses exactly these shots/assets (sequence preserved) — a shot or asset
    // change invalidates the video; unrelated shots are not mechanically connected.
    for (const shot of videoShots) {
      addEdge(`layer:${shot.shotId}:product`, 'out:video', 'compose');
      if (shot.copyIds.length > 0) addEdge(`layer:${shot.shotId}:text`, 'out:video', 'compose');
    }
    for (const element of timedCopy) addEdge(elementNodeId(element), 'out:video', 'publish');
  }
  const graph = { schemaVersion: CREATIVE_SCHEMA_VERSION, kind: CREATIVE_GRAPH_KIND, version, nodes, edges };
  const validation = validateDependencyGraph(graph);
  if (!validation.ok) fail('invalid_graph', validation.errors[0].message);
  return graph;
}

function validateDependencyGraph(graph) {
  const errors = [];
  const push = (code, message, detail) => errors.push({ code, message, ...(detail === undefined ? {} : { detail }) });
  if (!isPlainObject(graph)) {
    push('invalid_graph', 'graph must be a plain object');
    return { ok: false, errors };
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) push('invalid_graph', 'graph.nodes must be a non-empty array');
  if (!Array.isArray(graph.edges)) push('invalid_graph', 'graph.edges must be an array');
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return { ok: false, errors };
  const byId = new Map();
  for (const node of graph.nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string' || !NODE_TYPES.includes(node.type)) {
      push('invalid_node', 'every node needs an id and a known type');
      continue;
    }
    if (byId.has(node.id)) push('duplicate_node', `duplicate node ${node.id}`);
    byId.set(node.id, node);
  }
  const seenEdges = new Set();
  for (const edge of graph.edges) {
    if (!isPlainObject(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      push('invalid_edge', 'every edge needs from/to');
      continue;
    }
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      push('dangling_edge', `edge ${edge.from} -> ${edge.to} references a missing node`);
      continue;
    }
    if (edge.from === edge.to) push('invalid_edge', `self edge ${edge.from}`);
    if (!EDGE_NODE_TYPES[from.type].includes(to.type)) {
      push('edge_type_mismatch', `edge ${edge.from}(${from.type}) -> ${edge.to}(${to.type}) is not an allowed dependency direction`);
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) push('duplicate_edge', `duplicate edge ${edge.from} -> ${edge.to}`);
    seenEdges.add(key);
  }
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue;
    outgoing.set(edge.from, outgoing.get(edge.from) + 1);
    incoming.set(edge.to, incoming.get(edge.to) + 1);
  }
  for (const node of graph.nodes) {
    if (!isPlainObject(node) || !byId.has(node.id)) continue;
    const isAssetRoot = node.type === 'layer' && isPlainObject(node.data) && (node.data.role === 'product' || node.data.role === 'logo');
    if (node.type === 'fact' || isAssetRoot) {
      if (outgoing.get(node.id) === 0) push('orphan_node', `source node ${node.id} is not used by any dependent`);
    } else if (node.type === 'output') {
      if (incoming.get(node.id) === 0) push('orphan_node', `output node ${node.id} has no dependency`);
    } else {
      if (incoming.get(node.id) === 0) push('orphan_node', `node ${node.id} has no incoming dependency`);
      if (outgoing.get(node.id) === 0) push('orphan_node', `node ${node.id} is not used by any output`);
    }
    if (node.type === 'copy' || node.type === 'subtitle' || node.type === 'voiceover') {
      if (!isPlainObject(node.data) || !Array.isArray(node.data.factIds) || node.data.factIds.length === 0) {
        push('unbound_claim', `text node ${node.id} has no fact binding`);
      }
    }
  }
  // cycle detection (DFS colors) — a dependency graph must be acyclic
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) if (adjacency.has(edge.from)) adjacency.get(edge.from).push(edge.to);
  const color = new Map();
  const visit = (nodeId, stack) => {
    if (errors.length > 0 && errors.some((error) => error.code === 'invalid_graph_cycle')) return;
    color.set(nodeId, 1);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (color.get(next) === 1) {
        push('invalid_graph_cycle', `cycle detected: ${[...stack, next].join(' -> ')}`);
        return;
      }
      if (!color.get(next)) visit(next, [...stack, next]);
    }
    color.set(nodeId, 2);
  };
  for (const node of graph.nodes) if (isPlainObject(node) && byId.has(node.id) && !color.get(node.id)) visit(node.id, [node.id]);
  return { ok: errors.length === 0, errors };
}

function assertDependencyGraph(graph) {
  const result = validateDependencyGraph(graph);
  if (!result.ok) fail('invalid_graph', result.errors[0].message);
  return graph;
}

/** Local impact set: every node that (transitively) depends on the changed nodes. */
function computeImpact(graph, changedNodeIds) {
  assertDependencyGraph(graph);
  const ids = requireStringArray(changedNodeIds, 'changedNodeIds', { nonEmpty: true, max: 200 });
  const known = new Set(graph.nodes.map((node) => node.id));
  for (const id of ids) if (!known.has(id)) fail('unknown_node', `changed node ${id} is not part of the graph`);
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) adjacency.get(edge.from).push(edge.to);
  const seen = new Set(ids);
  const queue = [...ids];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  const impacted = [...seen].filter((id) => !ids.includes(id)).sort();
  return { changed: [...ids].sort(), impacted };
}

// ---------- identity / versions ----------

function normalizeTarget(rawTarget, rules, market) {
  assertKnownKeys(rawTarget, ['channel', 'marketplace', 'locale', 'imageRole', 'imageIndex', 'sizes'], 'target');
  const channel = requireNonEmptyString(rawTarget.channel, 'target.channel');
  if (!rules.channels.includes(channel)) fail('channel_not_allowed', `channel ${channel} is not allowed by the trusted rules`);
  const marketplace = requireNonEmptyString(rawTarget.marketplace, 'target.marketplace');
  if (marketplace !== market) fail('scope_authority_mismatch', 'target.marketplace must equal the exact execution market');
  const locale = requireNonEmptyString(rawTarget.locale, 'target.locale');
  if (!rules.locales.includes(locale)) fail('locale_not_allowed', `locale ${locale} is not allowed by the trusted rules`);
  if (!IMAGE_ROLES.includes(rawTarget.imageRole)) fail('validation', 'target.imageRole must be MAIN or SUBIMAGE');
  if (!rules.imageRoles.includes(rawTarget.imageRole)) fail('image_role_not_allowed', `image role ${rawTarget.imageRole} is not allowed by the trusted rules`);
  let imageIndex = 0;
  if (rawTarget.imageRole === 'MAIN') {
    if (rawTarget.imageIndex !== undefined && rawTarget.imageIndex !== 0) fail('validation', 'target.imageIndex must be omitted (or 0) for MAIN');
  } else {
    imageIndex = requireInteger(rawTarget.imageIndex, 'target.imageIndex', { min: 1, max: 6 });
  }
  if (!Array.isArray(rawTarget.sizes) || rawTarget.sizes.length === 0 || rawTarget.sizes.length > 6) {
    fail('validation', 'target.sizes must contain 1-6 sizes');
  }
  const sizes = rawTarget.sizes.map((size, index) => {
    assertKnownKeys(size, ['width', 'height'], `target.sizes[${index}]`);
    return {
      width: requireInteger(size.width, `target.sizes[${index}].width`, { min: 1, max: 20000 }),
      height: requireInteger(size.height, `target.sizes[${index}].height`, { min: 1, max: 20000 })
    };
  });
  return { channel, marketplace, locale, imageRole: rawTarget.imageRole, imageIndex, sizes };
}

function identityFor({ projectId, brand, market, passportId, skuId, target }) {
  requireId(projectId, 'projectId');
  isSafeScopeText(brand, 'brand');
  isSafeScopeText(market, 'market');
  requireNonEmptyString(market, 'market');
  return {
    projectId,
    brand,
    market,
    passportId,
    skuId,
    channel: target.channel,
    marketplace: target.marketplace,
    locale: target.locale,
    imageRole: target.imageRole,
    imageIndex: target.imageIndex
  };
}

function identityKey(identity) {
  return hashValue(identity);
}

function safePathKey(value) {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
}

function isWithinRoot(root, candidate) {
  const r = safePathKey(root);
  const c = safePathKey(candidate);
  return c === r || c.startsWith(`${r}${path.sep}`);
}

function isUnsafePathError(error) {
  return error instanceof CreativeError && ['unsafe_path_reparse', 'unsafe_path_escape', 'unsafe_path'].includes(error.code);
}

function assertRealDirectory(realRoot, current, segment) {
  const next = path.join(current, segment);
  let stat = null;
  try {
    stat = fs.lstatSync(next);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat === null) return { exists: false, path: next };
  if (stat.isSymbolicLink()) {
    fail('unsafe_path_reparse', `refusing to follow a reparse point/symlink below the trusted meta root (${segment})`);
  }
  if (!stat.isDirectory()) fail('unsafe_path', `the snapshot path component ${segment} is not a directory`);
  const realNext = fs.realpathSync(next);
  if (!isWithinRoot(realRoot, realNext)) fail('unsafe_path_escape', `the snapshot path component ${segment} resolves outside the trusted meta root`);
  return { exists: true, path: next, realPath: realNext };
}

/**
 * Resolve the snapshot directory with real-ancestor checks on EVERY component. The factory root
 * itself is trusted (its realpath is the boundary); a descendant junction/symlink must never
 * redirect reads, directory creation, version writes, the head, or a DB row outside the root.
 * `create:false` never creates anything and returns null when the chain does not exist.
 */
function resolveSnapshotDir({ metaRoot, identity, create }) {
  requireNonEmptyString(metaRoot, 'metaRoot');
  const root = path.resolve(metaRoot);
  if (!fs.existsSync(root)) {
    if (!create) return null;
    fs.mkdirSync(root, { recursive: true });
  }
  const realRoot = fs.realpathSync(root);
  const safeProject = requireId(identity.projectId, 'projectId');
  const segments = ['creative', safeProject, identityKey(identity).slice(0, 24)];
  let current = realRoot;
  for (const segment of segments) {
    const checked = assertRealDirectory(realRoot, current, segment);
    if (!checked.exists) {
      if (!create) return null;
      fs.mkdirSync(checked.path);
      const realNext = fs.realpathSync(checked.path);
      if (!isWithinRoot(realRoot, realNext)) fail('unsafe_path_escape', 'a newly created snapshot directory resolves outside the trusted meta root');
      current = realNext;
    } else {
      current = checked.realPath;
    }
  }
  return current;
}

function snapshotDir({ metaRoot, identity }) {
  return resolveSnapshotDir({ metaRoot, identity, create: true });
}

function assertRealFile(file, { allowMissing }) {
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return false;
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) fail('unsafe_path_reparse', `refusing to follow a reparse point/symlink at ${path.basename(file)}`);
  if (!stat.isFile()) fail('unsafe_path', `${path.basename(file)} is not a regular file`);
  return true;
}

function assertRealParent(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) fail('unsafe_path_reparse', 'refusing to write through a reparse point/symlink directory');
  if (!stat.isDirectory()) fail('unsafe_path', 'the snapshot parent is not a directory');
}

function readHead(dir) {
  const file = path.join(dir, 'head.json');
  if (!assertRealFile(file, { allowMissing: true })) return null;
  const head = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isPlainObject(head) || !Number.isSafeInteger(head.currentVersion) || head.currentVersion < 1) {
    fail('invalid_snapshot', 'the snapshot head is corrupt');
  }
  return head;
}

function writeHead(dir, head) {
  assertRealParent(dir);
  const file = path.join(dir, 'head.json');
  if (assertRealFile(file, { allowMissing: true }) === true) {
    // an existing regular head is replaced atomically; a reparse point was already rejected
  }
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(head, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  try {
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function writeExclusive(file, document) {
  assertRealParent(path.dirname(file));
  assertRealFile(file, { allowMissing: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  try {
    fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error && error.code === 'EEXIST') fail('version_conflict', 'the snapshot version already exists; history is never overwritten');
    throw error;
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  return sha256File(file);
}

function readBriefSnapshot({ metaRoot, identity, version }) {
  const dir = resolveSnapshotDir({ metaRoot, identity, create: false });
  if (dir === null) return null;
  const file = path.join(dir, versionFileName(requireInteger(version, 'version', { min: 1 })));
  if (!assertRealFile(file, { allowMissing: true })) return null;
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (document.kind !== CREATIVE_SNAPSHOT_KIND || document.schemaVersion !== CREATIVE_SCHEMA_VERSION) {
    fail('invalid_snapshot', 'the snapshot kind/schema is not this module contract');
  }
  const expectedKey = identityKey(identity);
  if (document.identityKey !== expectedKey) fail('invalid_snapshot', 'the snapshot identity does not match the requested scope');
  return { file: path.basename(file), sha256: sha256File(file), document };
}

function listBriefSnapshots({ metaRoot, identity }) {
  const dir = resolveSnapshotDir({ metaRoot, identity, create: false });
  if (dir === null) return { currentVersion: 0, versions: [] };
  const head = readHead(dir);
  const versions = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^v\d{6}\.json$/.test(name)) continue;
    const version = Number(name.slice(1, 7));
    const file = path.join(dir, name);
    if (!assertRealFile(file, { allowMissing: false })) continue;
    versions.push({ version, fileName: name, sha256: sha256File(file) });
  }
  return { currentVersion: head === null ? 0 : head.currentVersion, versions };
}

/**
 * Persist a validated plan as a NEW immutable version. All conflicts are checked before any
 * effect; the version file is exclusive-created, then the DB row is inserted, then the head is
 * updated. Old version files are never rewritten.
 */
function persistBriefPlan({ metaRoot, db, plan, now }) {
  if (!db || typeof db.prepare !== 'function') fail('validation', 'a trusted db handle is required');
  const identity = plan.identity;
  const key = identityKey(identity);
  let dir;
  let head;
  try {
    dir = resolveSnapshotDir({ metaRoot, identity, create: false });
    head = dir === null ? null : readHead(dir);
  } catch (error) {
    if (isUnsafePathError(error)) return { status: 'blocked', reason: error.code };
    throw error;
  }
  const currentVersion = head === null ? 0 : head.currentVersion;
  if (currentVersion !== plan.expectedVersion) {
    return { status: 'blocked', reason: 'version_conflict', currentVersion, expectedVersion: plan.expectedVersion };
  }
  const version = currentVersion + 1;
  const fileName = versionFileName(version);
  if (dir === null) {
    try {
      dir = resolveSnapshotDir({ metaRoot, identity, create: true });
    } catch (error) {
      if (isUnsafePathError(error)) return { status: 'blocked', reason: error.code };
      throw error;
    }
  }
  try {
    const realRoot = fs.realpathSync(path.resolve(metaRoot));
    const realDir = fs.realpathSync(dir);
    if (!isWithinRoot(realRoot, realDir)) return { status: 'blocked', reason: 'unsafe_path_escape' };
    assertRealParent(dir);
  } catch (error) {
    if (isUnsafePathError(error)) return { status: 'blocked', reason: error.code };
    throw error;
  }
  const file = path.join(dir, fileName);
  try {
    if (assertRealFile(file, { allowMissing: true }) === true) {
      return { status: 'blocked', reason: 'version_conflict', currentVersion: version - 1, expectedVersion: plan.expectedVersion };
    }
  } catch (error) {
    if (isUnsafePathError(error)) return { status: 'blocked', reason: error.code };
    throw error;
  }
  const briefId = `cb_${key.slice(0, 12)}_v${version}`;
  const existing = db.prepare('SELECT id FROM creative_briefs WHERE project_id = ? AND id = ?').get(identity.projectId, briefId);
  if (existing) return { status: 'blocked', reason: 'version_conflict', currentVersion: version - 1, expectedVersion: plan.expectedVersion };
  const createdAt = requireNonEmptyString(now, 'now');
  const snapshot = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    kind: CREATIVE_SNAPSHOT_KIND,
    ruleVersion: CREATIVE_RULE_VERSION,
    templateVersion: CREATIVE_TEMPLATE_VERSION,
    identity,
    identityKey: key,
    briefVersion: version,
    briefId,
    createdAt,
    inputSha256: plan.inputSha256,
    expectedVersion: plan.expectedVersion,
    product: plan.product,
    target: plan.target,
    facts: plan.facts,
    assets: plan.assets,
    copy: plan.copy,
    shotList: plan.shotList,
    graph: plan.graph,
    brief: plan.brief,
    versions: plan.versions,
    media: { status: 'not_generated' }
  };
  const sha256 = writeExclusive(file, snapshot);
  const sizeMatrix = JSON.stringify(plan.target.sizes);
  const allowedClaims = JSON.stringify(plan.brief.allowedClaims);
  const forbiddenClaims = JSON.stringify(plan.brief.forbiddenClaims);
  try {
    db.prepare(`INSERT INTO creative_briefs
      (id, project_id, product_passport_id, sku_id, channel, locale, size_matrix_json, allowed_claims_json, forbidden_claims_json, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(briefId, identity.projectId, identity.passportId, identity.skuId, plan.target.channel, plan.target.locale, sizeMatrix, allowedClaims, forbiddenClaims, 'planned', version, createdAt, createdAt);
  } catch (error) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    throw error;
  }
  writeHead(dir, {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    kind: 'creative-brief-head',
    identityKey: key,
    currentVersion: version,
    fileName,
    sha256,
    briefId,
    updatedAt: createdAt
  });
  return { status: 'persisted', version, fileName, sha256, briefId };
}

function readCreativeBriefRow(db, projectId, briefId) {
  if (!db || typeof db.prepare !== 'function') fail('validation', 'a trusted db handle is required');
  return db.prepare('SELECT * FROM creative_briefs WHERE project_id = ? AND id = ?').get(requireNonEmptyString(projectId, 'projectId'), requireNonEmptyString(briefId, 'briefId')) ?? null;
}

// ---------- plan builder ----------

function buildCreativeBrief({ db, projectId, brand, market, input, factResolver, assetResolver, rules, logoGrant, clock, externalUse, design }) {
  if (!isPlainObject(input)) fail('validation', 'input must be a plain object');
  assertKnownKeys(input, ['scope', 'product', 'target', 'copy', 'shots', 'video', 'forbiddenClaims', 'style', 'logo', 'expectedVersion'], 'input');
  assertKnownKeys(input.scope, ['projectId', 'brand', 'market'], 'input.scope');
  if (input.scope.projectId !== projectId) fail('scope_authority_mismatch', 'input.scope.projectId must equal the exact execution project');
  const inputBrand = input.scope.brand === null || input.scope.brand === undefined ? '' : input.scope.brand;
  if (inputBrand !== brand) fail('scope_authority_mismatch', 'input.scope.brand must equal the exact execution brand (an empty brand matches only an empty brand)');
  if (input.scope.market !== market) fail('scope_authority_mismatch', 'input.scope.market must equal the exact execution market');
  if (typeof brand !== 'string') fail('scope_authority_mismatch', 'the execution brand must be a string');
  isSafeScopeText(brand, 'brand');
  isSafeScopeText(market, 'market');
  if (typeof factResolver !== 'function') fail('validation', 'a trusted fact resolver is required (a payload can never supply facts)');
  if (typeof assetResolver !== 'function') fail('validation', 'a trusted asset resolver is required (a payload can never supply assets)');
  const trustedRules = normalizeRules(rules);
  const grant = normalizeLogoGrant(logoGrant);
  const trustedExternalUse = normalizeExternalUse(externalUse);
  const now = typeof clock === 'function' ? clock : () => new Date().toISOString();
  const nowText = requireNonEmptyString(now(), 'clock()');
  const nowMs = parseInstant(nowText, 'clock()');
  const expectedVersion = requireInteger(input.expectedVersion, 'input.expectedVersion', { min: 0, max: 1000000 });

  const target = normalizeTarget(input.target, trustedRules, market);
  const resolved = resolveCreativeTarget({ db, projectId, brand, market, product: input.product });
  if (resolved.status !== 'resolved') return resolved;
  const { passport, sku } = resolved;
  const passportBrand = passport.brand_key === null || passport.brand_key === undefined ? '' : passport.brand_key;
  if (passportBrand !== brand) fail('passport_scope_mismatch', 'the passport brand does not match the exact execution brand');
  const attributes = JSON.parse(sku.attributes_json);
  const designResult = resolveCurrentDesign({ design, projectId, passportId: passport.id, skuId: sku.id, attributes });
  if (designResult.status !== 'resolved') return designResult;
  const designKey = designResult.designKey;

  const identity = identityFor({ projectId, brand, market, passportId: passport.id, skuId: sku.id, target });
  const logoInput = input.logo === undefined ? { enabled: false } : input.logo;
  assertKnownKeys(logoInput, ['enabled'], 'input.logo');
  if (typeof logoInput.enabled !== 'boolean') fail('validation', 'input.logo.enabled must be a boolean');
  const licensed = logoGrantMatches(grant, projectId, brand);
  if (logoInput.enabled && !licensed) {
    fail('logo_not_licensed', 'a logo layer is off by default and can only be enabled by an exact-scope factory logo license');
  }
  const logo = logoInput.enabled ? { enabled: true, licenseRef: grant.licenseRef } : { enabled: false };

  const facts = collectFacts({ factResolver, projectId, brand, market, passportId: passport.id, skuId: sku.id, nowMs, externalUse: trustedExternalUse });
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const forbidden = buildForbiddenList(trustedRules, input.forbiddenClaims);
  const copyResult = resolveCopy({
    rawCopy: input.copy,
    facts,
    factsById,
    nowMs,
    forbidden,
    maxCopyElements: trustedRules.maxCopyElements,
    maxClaimsPerElement: trustedRules.maxClaimsPerElement
  });
  if (copyResult.status !== 'resolved') return { status: 'waiting_input', reason: copyResult.reason, gaps: [{ code: copyResult.reason.split(':')[0], detail: copyResult.reason }] };
  const copyElements = copyResult.elements;
  const assets = collectAssets({ assetResolver, projectId, passportId: passport.id, skuId: sku.id, familyKey: passport.product_family_key, designKey });
  const shotResult = resolveShots({ rawShots: input.shots, assets, copyElements, target, rules: trustedRules, logo, nowMs });
  if (shotResult.status !== 'resolved') return shotResult;
  const shots = shotResult.shots;
  const timedCopy = copyElements.filter((element) => ['subtitle', 'voiceover'].includes(element.kind));
  let videoShotIds = [];
  if (input.video !== undefined) {
    assertKnownKeys(input.video, ['shotIds'], 'input.video');
    const requested = requireStringArray(input.video.shotIds, 'input.video.shotIds', { nonEmpty: true, max: trustedRules.maxShots });
    for (const shotId of requested) {
      if (!shots.some((shot) => shot.shotId === shotId)) fail('video_shot_not_found', `input.video.shotIds references unknown shot ${shotId}`);
      if (videoShotIds.includes(shotId)) fail('duplicate_video_shot', `input.video.shotIds repeats ${shotId}`);
      videoShotIds.push(shotId);
    }
  } else if (timedCopy.length > 0) {
    // the planned video uses the planned shot sequence unless an explicit subset is supplied
    videoShotIds = shots.map((shot) => shot.shotId);
  }

  const factsUsedIds = new Set();
  for (const element of copyElements) for (const claim of element.claims) factsUsedIds.add(claim.factId);
  const factsUsed = facts.filter((fact) => factsUsedIds.has(fact.id));
  const graph = buildDependencyGraph({ version: expectedVersion + 1, shots, copyElements, factsUsed, logo, videoShotIds });

  const claims = [];
  const factVersions = [];
  for (const fact of factsUsed) {
    factVersions.push({
      factId: fact.id,
      version: fact.version,
      field: fact.field,
      contentSha256: fact.contentSha256,
      originType: fact.originType,
      sourceRef: fact.sourceRef,
      licenseNote: fact.licenseNote,
      wordingState: fact.wordingState,
      externalUse: fact.externalUse
    });
  }
  for (const element of copyElements) {
    for (const claim of element.claims) {
      if (claims.some((entry) => entry.text === claim.text && entry.factId === claim.factId)) continue;
      claims.push({
        text: claim.text,
        factId: claim.factId,
        factVersion: claim.fact.version,
        sourceRef: claim.fact.sourceRef,
        contentSha256: claim.fact.contentSha256
      });
    }
  }
  const assetVersions = shots.map((shot) => ({
    assetId: shot.asset.assetId,
    version: shot.asset.version,
    sha256: shot.asset.sha256,
    designKey: shot.asset.designKey,
    angle: shot.angle,
    format: shot.asset.format,
    width: shot.asset.width,
    height: shot.asset.height
  }));
  const style = input.style === undefined ? null : (() => {
    assertKnownKeys(input.style, ['tone', 'instructions'], 'input.style');
    return {
      ...(input.style.tone === undefined ? {} : { tone: requireNonEmptyString(input.style.tone, 'input.style.tone') }),
      ...(input.style.instructions === undefined ? {} : { instructions: requireNonEmptyString(input.style.instructions, 'input.style.instructions') })
    };
  })();

  const product = {
    passportId: passport.id,
    skuId: sku.id,
    skuCode: sku.sku_code,
    productFamilyKey: passport.product_family_key,
    category: passport.category,
    title: passport.title,
    ...(passport.brand_key === null || passport.brand_key === undefined ? {} : { brandKey: passport.brand_key }),
    status: passport.status,
    version: passport.version,
    designKey,
    designSource: designResult.source,
    attributes,
    ...(passport.category_pack_key === null || passport.category_pack_key === undefined ? {} : { categoryPackKey: passport.category_pack_key })
  };
  const factSummary = facts.map((fact) => ({
    factId: fact.id,
    version: fact.version,
    field: fact.field,
    claimText: fact.claimText,
    value: fact.value,
    ...(fact.unit === null ? {} : { unit: fact.unit }),
    ...(fact.wordingState === null ? {} : { wordingState: fact.wordingState }),
    originType: fact.originType,
    approvalStatus: fact.approvalStatus,
    sourceRef: fact.sourceRef,
    ...(fact.sourceUrl === null ? {} : { sourceUrl: fact.sourceUrl }),
    ...(fact.licenseNote === null ? {} : { licenseNote: fact.licenseNote }),
    ...(fact.observedAt === null ? {} : { observedAt: fact.observedAt }),
    ...(fact.expiresAt === null ? {} : { expiresAt: fact.expiresAt }),
    contentSha256: fact.contentSha256,
    externalUse: fact.externalUse,
    claimable: fact.claimable,
    ...(fact.reason === null ? {} : { reason: fact.reason })
  }));
  const allowedClaims = claims.map((claim, index) => ({ claimId: `claim-${index + 1}`, ...claim }));
  const brief = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    ruleVersion: CREATIVE_RULE_VERSION,
    templateVersion: CREATIVE_TEMPLATE_VERSION,
    identity,
    product,
    target,
    facts: factSummary,
    allowedClaims,
    forbiddenClaims: forbidden,
    copy: copyElements.map((element) => ({
      id: element.id,
      kind: element.kind,
      text: element.text,
      claims: element.claims.map((claim) => ({
        text: claim.text,
        factId: claim.factId,
        factVersion: claim.fact.version,
        sourceRef: claim.fact.sourceRef,
        contentSha256: claim.fact.contentSha256
      }))
    })),
    shots,
    ...(videoShotIds.length === 0 && timedCopy.length === 0 ? {} : {
      video: {
        shotIds: [...videoShotIds],
        sourceSha256: shots.filter((shot) => videoShotIds.includes(shot.shotId)).map((shot) => shot.asset.sha256)
      }
    }),
    assetVersions,
    factVersions,
    imageRules: {
      role: target.imageRole,
      overlayTextAllowed: target.imageRole === 'MAIN' ? trustedRules.mainImage.allowOverlayText : true,
      floatingLogoAllowed: target.imageRole === 'MAIN' ? trustedRules.mainImage.allowFloatingLogo : true
    },
    ...(style === null ? {} : { style }),
    logo,
    media: { status: 'not_generated' }
  };
  const shotList = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    status: 'planned',
    angles: [...ANGLES],
    availableAngles: shotResult.availableAngles,
    shots
  };
  const inputSha256 = hashValue({
    scope: { projectId, brand, market },
    product: input.product,
    target: input.target,
    copy: input.copy,
    shots: input.shots,
    video: input.video ?? null,
    forbiddenClaims: input.forbiddenClaims ?? [],
    style: input.style ?? null,
    logo: logoInput,
    expectedVersion
  });
  const versions = {
    schemaVersion: CREATIVE_SCHEMA_VERSION,
    ruleVersion: CREATIVE_RULE_VERSION,
    templateVersion: CREATIVE_TEMPLATE_VERSION,
    briefVersion: expectedVersion + 1,
    factVersions,
    assetVersions
  };
  return {
    status: 'planned',
    plan: {
      identity,
      expectedVersion,
      product,
      target,
      facts: factSummary,
      assets: assetVersions,
      copy: brief.copy,
      shotList,
      graph,
      brief,
      versions,
      inputSha256
    }
  };
}

// ---------- orchestration registration ----------

const CREATIVE_INPUT_SCHEMA = {
  type: 'object',
  required: ['scope', 'product', 'target', 'copy', 'shots', 'expectedVersion'],
  additionalProperties: false,
  properties: {
    scope: {
      type: 'object',
      required: ['projectId', 'brand', 'market'],
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', minLength: 1, maxLength: 120 },
        brand: { type: 'string', maxLength: 120 },
        market: { type: 'string', minLength: 1, maxLength: 40 }
      }
    },
    product: {
      type: 'object',
      required: ['passportId', 'skuId'],
      additionalProperties: false,
      properties: {
        passportId: { type: 'string', minLength: 1, maxLength: 120 },
        skuId: { type: 'string', minLength: 1, maxLength: 120 }
      }
    },
    target: {
      type: 'object',
      required: ['channel', 'marketplace', 'locale', 'imageRole', 'sizes'],
      additionalProperties: false,
      properties: {
        channel: { type: 'string', minLength: 1, maxLength: 40 },
        marketplace: { type: 'string', minLength: 1, maxLength: 40 },
        locale: { type: 'string', minLength: 1, maxLength: 20 },
        imageRole: { type: 'string', enum: ['MAIN', 'SUBIMAGE'] },
        imageIndex: { type: 'integer', minimum: 0, maximum: 6 },
        sizes: {
          type: 'array', maxItems: 6,
          items: {
            type: 'object',
            required: ['width', 'height'],
            additionalProperties: false,
            properties: {
              width: { type: 'integer', minimum: 1, maximum: 20000 },
              height: { type: 'integer', minimum: 1, maximum: 20000 }
            }
          }
        }
      }
    },
    copy: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object',
        required: ['id', 'kind', 'text', 'claims'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 80 },
          kind: { type: 'string', enum: ['headline', 'body', 'bullet', 'subtitle', 'voiceover'] },
          text: { type: 'string', minLength: 1, maxLength: 2000 },
          claims: {
            type: 'array', maxItems: 4,
            items: {
              type: 'object',
              required: ['text'],
              additionalProperties: false,
              properties: {
                text: { type: 'string', minLength: 1, maxLength: 500 },
                factId: { type: 'string', minLength: 1, maxLength: 120 }
              }
            }
          }
        }
      }
    },
    shots: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object',
        required: ['id', 'angle', 'assetId'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 80 },
          angle: { type: 'string', enum: ['front', 'side', 'back', 'top', 'detail', 'lifestyle'] },
          assetId: { type: 'string', minLength: 1, maxLength: 120 },
          assetVersion: { type: 'integer', minimum: 1, maximum: 1000000 },
          copyIds: { type: 'array', maxItems: 40, items: { type: 'string', minLength: 1, maxLength: 80 } }
        }
      }
    },
    video: {
      type: 'object',
      additionalProperties: false,
      properties: {
        shotIds: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 80 } }
      }
    },
    forbiddenClaims: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
    style: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tone: { type: 'string', minLength: 1, maxLength: 300 },
        instructions: { type: 'string', minLength: 1, maxLength: 600 }
      }
    },
    logo: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' } }
    },
    expectedVersion: { type: 'integer', minimum: 0, maximum: 1000000 }
  }
};

const CREATIVE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['status', 'briefVersion', 'briefId', 'snapshot', 'brief', 'shotList', 'graph', 'versions'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['planned'] },
    briefVersion: { type: 'integer', minimum: 1 },
    briefId: { type: 'string', minLength: 1, maxLength: 120 },
    inputSha256: { type: 'string', minLength: 64, maxLength: 64 },
    snapshot: {
      type: 'object',
      required: ['version', 'fileName', 'sha256'],
      additionalProperties: false,
      properties: {
        version: { type: 'integer', minimum: 1 },
        fileName: { type: 'string', minLength: 1, maxLength: 40 },
        sha256: { type: 'string', minLength: 64, maxLength: 64 }
      }
    },
    brief: { type: 'object', properties: {}, additionalProperties: true },
    shotList: { type: 'object', properties: {}, additionalProperties: true },
    graph: { type: 'object', properties: {}, additionalProperties: true },
    versions: { type: 'object', properties: {}, additionalProperties: true }
  }
};

function createCreativeRegistration({ domain } = {}) {
  if (!isPlainObject(domain)) fail('validation', 'domain (trusted factory config) is required');
  const { db, metaRoot, factResolver, assetResolver, rules, logoGrant, clock, externalUse, design } = domain;
  if (!db || typeof db.prepare !== 'function') fail('validation', 'domain.db (trusted SQLite handle) is required');
  if (typeof metaRoot !== 'string' || metaRoot.trim() === '') fail('validation', 'domain.metaRoot is required');
  if (typeof factResolver !== 'function') fail('validation', 'domain.factResolver (factory/runner trusted facts) is required');
  if (typeof assetResolver !== 'function') fail('validation', 'domain.assetResolver (factory/runner trusted assets) is required');
  const trustedRules = normalizeRules(rules);
  const trustedLogoGrant = normalizeLogoGrant(logoGrant);
  // fail-fast validation of the trusted config; the raw config is passed to the builder so the
  // external-use contract is normalized exactly once per build.
  normalizeExternalUse(externalUse);
  if (design !== undefined && design !== null && typeof design !== 'function' && !isPlainObject(design)) {
    fail('validation', 'domain.design must be a plain object or a resolver function');
  }
  const now = typeof clock === 'function' ? clock : () => new Date().toISOString();
  const tool = {
    name: CREATIVE_TOOL_NAME,
    version: CREATIVE_TOOL_VERSION,
    roles: [CREATIVE_ROLE],
    kind: 'local',
    inputSchema: CREATIVE_INPUT_SCHEMA,
    outputSchema: CREATIVE_OUTPUT_SCHEMA,
    costPolicy: { kind: 'mock_no_charge', currency: 'USD' }
  };
  async function handler({ input, context }) {
    const ctx = isPlainObject(context) ? context : {};
    const project = typeof ctx.project === 'string' && ctx.project !== '' ? ctx.project : null;
    const market = typeof ctx.market === 'string' && ctx.market !== '' ? ctx.market : null;
    const brand = ctx.brand === null || ctx.brand === undefined ? '' : ctx.brand;
    if (project === null || market === null || typeof brand !== 'string') return { status: 'blocked', reason: 'authority_missing' };
    if (!isPlainObject(input) || !isPlainObject(input.scope)) return { status: 'blocked', reason: 'scope_missing' };
    if (input.scope.projectId !== project || (input.scope.brand === null || input.scope.brand === undefined ? '' : input.scope.brand) !== brand || input.scope.market !== market) {
      return { status: 'blocked', reason: 'scope_authority_mismatch' };
    }
    const runId = typeof ctx.runId === 'string' && ctx.runId !== '' ? ctx.runId : null;
    if (runId === null) return { status: 'blocked', reason: 'run_id_missing' };
    let built;
    try {
      built = buildCreativeBrief({
        db,
        projectId: project,
        brand,
        market,
        input,
        factResolver,
        assetResolver,
        rules: trustedRules,
        logoGrant: trustedLogoGrant,
        clock: now,
        externalUse,
        design
      });
    } catch (error) {
      if (error instanceof CreativeError) return { status: 'blocked', reason: `${error.code}: ${error.message}` };
      throw error;
    }
    if (built.status === 'waiting_input') return { status: 'waiting_input', reason: built.reason };
    let persisted;
    try {
      persisted = persistBriefPlan({ metaRoot, db, plan: built.plan, now: now() });
    } catch (error) {
      if (error instanceof CreativeError) return { status: 'blocked', reason: `${error.code}: ${error.message}` };
      throw error;
    }
    if (persisted.status !== 'persisted') return { status: 'blocked', reason: persisted.reason };
    const output = {
      status: 'planned',
      briefVersion: persisted.version,
      briefId: persisted.briefId,
      inputSha256: built.plan.inputSha256,
      snapshot: { version: persisted.version, fileName: persisted.fileName, sha256: persisted.sha256 },
      brief: { ...built.plan.brief, briefVersion: persisted.version },
      shotList: built.plan.shotList,
      graph: built.plan.graph,
      versions: built.plan.versions
    };
    return { status: 'succeeded', output };
  }
  return { tool, handler };
}

function registerCreativeHandler(registry, registration) {
  if (!registry || typeof registry.register !== 'function') fail('validation', 'a tool registry is required');
  registry.register(registration.tool, registration.handler);
  return registry.get(registration.tool.name);
}

module.exports = {
  CREATIVE_TOOL_NAME,
  CREATIVE_TOOL_VERSION,
  CREATIVE_ROLE,
  CREATIVE_SCHEMA_VERSION,
  CREATIVE_RULE_VERSION,
  CREATIVE_TEMPLATE_VERSION,
  CREATIVE_SNAPSHOT_KIND,
  CREATIVE_GRAPH_KIND,
  NODE_TYPES,
  COPY_KINDS,
  ANGLES,
  IMAGE_ROLES,
  CLAIMABLE_ORIGINS,
  NON_CLAIMABLE_ORIGINS,
  EDGE_NODE_TYPES,
  DEFAULT_RULES,
  CREATIVE_INPUT_SCHEMA,
  CREATIVE_OUTPUT_SCHEMA,
  CreativeError,
  createObservationFactResolver,
  normalizeRules,
  normalizeExternalUse,
  normalizeClaimAuthorizations,
  resolveCurrentDesign,
  buildCreativeBrief,
  validateDependencyGraph,
  assertDependencyGraph,
  computeImpact,
  buildDependencyGraph,
  identityFor,
  identityKey,
  snapshotDir,
  persistBriefPlan,
  readBriefSnapshot,
  listBriefSnapshots,
  readCreativeBriefRow,
  createCreativeRegistration,
  registerCreativeHandler
};
