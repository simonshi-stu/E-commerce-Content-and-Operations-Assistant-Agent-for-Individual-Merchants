'use strict';
/**
 * Private / internal / external field tiering and export profiles (T1.5).
 *
 * Contract (documented limits included):
 * - Tiers: 'external' (safe to leave the private area), 'internal' (channel/internal workflows
 *   only, e.g. full contact details), 'private' (costs, margins, supplier terms, raw source
 *   paths), 'secret' (credentials/tokens/passwords: NEVER included in any export or log,
 *   regardless of profile), 'free_text' (unclassified free text: never exported externally or
 *   logged; kept only by internal-full after the best-effort scrubber runs).
 * - Profiles: 'internal-full' keeps external+internal+private (+ scrubbed free text) and always
 *   drops secrets; 'external-redacted' keeps only explicitly classified 'external' fields.
 *   Profiles are data filters only: they grant no public-upload, listing or sharing permission.
 * - Policy reads are own-key only: classifications are looked up with hasOwnProperty, so inherited
 *   Object.prototype names (toString, valueOf, hasOwnProperty, …) are never treated as
 *   classifications. An empty/foreign policy emits nothing for undeclared keys; an explicit own
 *   classification such as `toString: 'external'` remains legal. No blacklist of key names and no
 *   prototype mutation.
 * - Paths: policy paths are dot-separated and only authorize the actual nested structure
 *   (contacts.email covers each contact's email; arrays are traversed per element). Input data
 *   whose own keys are empty ('') or contain a '.' is ambiguous with nested paths (an empty key
 *   would collapse to the parent/root path) and is rejected with ValidationError before any output
 *   is produced (the raw input is never modified). Nested and array paths keep working.
 * - Containers are upper bounds, not whitelists: a container classification bounds its subtree's
 *   confidentiality, but every exported/logged LEAF must be explicitly classified. Unclassified
 *   leaves are never copied in any profile (fail-closed) — an 'external' container does not
 *   authorize undocumented descendants. A secret/private/internal parent can never be downgraded
 *   by a child's 'external' classification; secret subtrees never appear in any profile or log.
 *   This is a whitelist, not a blacklist, and it does not claim that arbitrary unclassified
 *   structures contain no sensitive data.
 * - Raw evidence stays untouched: applyProfile/redactForLog return NEW copies and never mutate the
 *   input. Raw private sources may keep full contacts in the authorized private area; only
 *   exports, diagnostic logs and evidence summaries are filtered before serialization.
 * - Logs/evidence summaries (redactForLog): external fields are kept (scrubbed), internal fields
 *   are replaced with '[redacted]', and private/free_text/secret/unknown fields are dropped.
 * - Scrubber: best-effort pattern removal of common credential shapes (sk-…, AIza…, PEM private
 *   key headers, "password/token/secret/api-key = value") plus caller-provided synthetic canaries.
 *   It is not a general natural-language DLP engine and must not be used to mask classification
 *   mistakes; classification correctness is enforced before the scrubber runs.
 * - JSON safety: inputs must be JSON-compatible (plain objects/arrays, strings, finite numbers,
 *   booleans, null). undefined/functions/symbols/bigint/non-finite numbers/class instances and
 *   circular references are rejected explicitly (never silently dropped). Reserved keys
 *   (__proto__ / constructor / prototype) are rejected with ValidationError; other own keys,
 *   including names such as toString, are preserved safely through own-property access (no
 *   prototype reads, no pollution).
 *
 * DEV NOTE: development task state (PROGRESS.json) is unrelated to business `runs` state.
 */
const { ValidationError } = require('./evidence.js');

const TIERS = Object.freeze(['external', 'internal', 'private', 'secret', 'free_text']);
const PROFILES = Object.freeze(['internal-full', 'external-redacted']);
const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const REDACTED = '[redacted]';
/** Restrictiveness order for upper bounds: external < internal < free_text < private < secret. */
const RESTRICTIVENESS = Object.freeze({ external: 0, internal: 1, free_text: 2, private: 3, secret: 4 });
const SECRET_PATTERNS = Object.freeze([
  /sk-[A-Za-z0-9]{8,}/g,
  /AIza[0-9A-Za-z_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi
]);

function fail(message) {
  throw new ValidationError(message);
}
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
}
function assertKnownKeys(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not a known field`);
  }
}
function mostRestrictive(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b;
}

/** Rejects non-JSON values, reserved keys and circular references; never mutates or coerces. */
function assertJsonCompatible(value, path = 'value') {
  const ancestors = new Set();
  const walk = (node, p) => {
    if (node === null) return;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return;
    if (type === 'number') {
      if (!Number.isFinite(node)) fail(`${p} must be a finite number`);
      return;
    }
    if (type !== 'object') fail(`${p} must be JSON-compatible (received ${type})`);
    if (ancestors.has(node)) fail(`${p} contains a circular reference`);
    if (Array.isArray(node)) {
      ancestors.add(node);
      node.forEach((item, index) => walk(item, `${p}[${index}]`));
      ancestors.delete(node);
      return;
    }
    if (!isPlainObject(node)) fail(`${p} must be JSON-compatible (plain object, array, string, finite number, boolean or null)`);
    ancestors.add(node);
    for (const key of Object.keys(node)) {
      if (RESERVED_KEYS.includes(key)) fail(`${p}.${key} is a reserved key and cannot be used`);
      walk(node[key], `${p}.${key}`);
    }
    ancestors.delete(node);
  };
  walk(value, path);
  return value;
}

/**
 * Input data keys containing '.' are ambiguous with nested policy paths and are rejected before
 * any output is produced (the raw input is never modified). Policy paths themselves stay dotted.
 */
function assertNoDottedKeys(value, path = 'value') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDottedKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (key === '') {
      fail(`${path} contains an empty literal key, which is ambiguous with nested policy paths and cannot be exported`);
    }
    if (key.includes('.')) {
      fail(`${path}.${key} is a literal key containing a dot, which is ambiguous with nested policy paths and cannot be exported`);
    }
    assertNoDottedKeys(value[key], `${path}.${key}`);
  }
}

function requirePath(path, label) {
  requireNonEmptyString(path, label);
  for (const segment of path.split('.')) {
    if (!segment) fail(`${label} contains an empty path segment`);
    if (RESERVED_KEYS.includes(segment)) fail(`${label} uses reserved key ${segment}`);
  }
  return path;
}

function validateCanaries(canaries) {
  if (canaries === undefined) return [];
  if (!Array.isArray(canaries)) fail('canaries must be an array of strings');
  for (const canary of canaries) {
    if (typeof canary !== 'string' || canary === '') fail('canaries entries must be non-empty strings');
  }
  return canaries;
}

function validatePolicy(policy) {
  assertJsonCompatible(policy, 'policy');
  if (!isPlainObject(policy)) fail('policy must be a plain object');
  assertKnownKeys(policy, ['schemaVersion', 'schemaId', 'fields'], 'policy');
  if (policy.schemaVersion !== 1) fail('policy.schemaVersion must be 1');
  requireNonEmptyString(policy.schemaId, 'policy.schemaId');
  if (!isPlainObject(policy.fields)) fail('policy.fields must be a plain object');
  for (const path of Object.keys(policy.fields)) {
    requirePath(path, `policy.fields key ${JSON.stringify(path)}`);
    const tier = policy.fields[path];
    if (!TIERS.includes(tier)) fail(`policy.fields.${path} must be one of ${TIERS.join(', ')}`);
  }
  return policy;
}

function scrubText(text, canaries) {
  let result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, REDACTED);
  for (const canary of canaries) {
    if (result.includes(canary)) result = result.split(canary).join(REDACTED);
  }
  return result;
}
function scrubValue(node, canaries) {
  return typeof node === 'string' ? scrubText(node, canaries) : node;
}

/**
 * Filtered copy for an export profile; returns undefined when nothing at this path is kept.
 * The bound is the most restrictive ancestor/container tier; a declared leaf is additionally
 * limited by that bound, and unclassified leaves are never kept (fail-closed).
 */
function projectNode(node, policy, profile, path, boundTier, canaries) {
  const declared = hasOwn(policy.fields, path) ? policy.fields[path] : undefined;
  const bound = mostRestrictive(boundTier, declared);
  if (bound === 'secret') return undefined;
  if (bound === 'free_text' && profile !== 'internal-full') return undefined;
  if ((bound === 'internal' || bound === 'private') && profile !== 'internal-full') return undefined;
  if (Array.isArray(node)) {
    const items = [];
    let kept = false;
    for (const item of node) {
      const projected = projectNode(item, policy, profile, path, bound, canaries);
      items.push(projected);
      if (projected !== undefined) kept = true;
    }
    return kept ? items : undefined;
  }
  if (isPlainObject(node)) {
    const out = {};
    let kept = false;
    for (const key of Object.keys(node)) {
      const childPath = path ? `${path}.${key}` : key;
      const projected = projectNode(node[key], policy, profile, childPath, bound, canaries);
      if (projected !== undefined) {
        out[key] = projected;
        kept = true;
      }
    }
    return kept ? out : undefined;
  }
  if (declared === undefined) return undefined;
  return scrubValue(node, canaries);
}

/**
 * Filter for diagnostic logs and evidence summaries: external leaves kept (scrubbed), internal
 * bounds replaced with '[redacted]', private/free_text/secret/unknown dropped. Run BEFORE
 * serialization.
 */
function redactNode(node, policy, path, boundTier, canaries) {
  const declared = hasOwn(policy.fields, path) ? policy.fields[path] : undefined;
  const bound = mostRestrictive(boundTier, declared);
  if (bound === 'secret' || bound === 'private' || bound === 'free_text') return undefined;
  if (bound === 'internal') return REDACTED;
  if (Array.isArray(node)) {
    const items = [];
    let kept = false;
    for (const item of node) {
      const redactedItem = redactNode(item, policy, path, bound, canaries);
      items.push(redactedItem);
      if (redactedItem !== undefined) kept = true;
    }
    return kept ? items : undefined;
  }
  if (isPlainObject(node)) {
    const out = {};
    let kept = false;
    for (const key of Object.keys(node)) {
      const childPath = path ? `${path}.${key}` : key;
      const redactedChild = redactNode(node[key], policy, childPath, bound, canaries);
      if (redactedChild !== undefined) {
        out[key] = redactedChild;
        kept = true;
      }
    }
    return kept ? out : undefined;
  }
  if (declared === undefined) return undefined;
  return scrubValue(node, canaries);
}

function applyProfile(value, policy, profile, options = {}) {
  validatePolicy(policy);
  if (!PROFILES.includes(profile)) fail(`unknown export profile ${String(profile)} (supported: ${PROFILES.join(', ')})`);
  assertJsonCompatible(value, 'value');
  assertNoDottedKeys(value, 'value');
  const canaries = validateCanaries(options.canaries);
  const projected = projectNode(value, policy, profile, '', undefined, canaries);
  return projected === undefined ? {} : projected;
}

function redactForLog(value, policy, options = {}) {
  validatePolicy(policy);
  assertJsonCompatible(value, 'value');
  assertNoDottedKeys(value, 'value');
  const canaries = validateCanaries(options.canaries);
  const redacted = redactNode(value, policy, '', undefined, canaries);
  return redacted === undefined ? {} : redacted;
}

/** Scans already-serialized text for the given synthetic canaries; returns the canaries found. */
function findCanaryHits(serializedText, canaries) {
  if (typeof serializedText !== 'string') fail('serializedText must be a string');
  const list = validateCanaries(canaries);
  return list.filter((canary) => serializedText.includes(canary));
}

module.exports = {
  TIERS,
  PROFILES,
  REDACTED,
  validatePolicy,
  applyProfile,
  redactForLog,
  findCanaryHits,
  assertJsonCompatible
};
