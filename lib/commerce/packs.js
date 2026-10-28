'use strict';
/**
 * Versioned Category / Market / Brand packs (T1.4).
 *
 * A pack is a plain JSON document (schemaVersion 1) carrying generic configuration data:
 * - category: attribute definitions (name/type/unit/allowedValues + per-attribute overridableBy),
 *   lexicon (term -> variants), creative hints, fixed facts (value + provenance labels reused from
 *   evidence.js: originType/approvalStatus), annotations, and an `overridable` map saying which
 *   sections market/brand overlays may touch.
 * - market: marketplace identity (channel/country/locale/currency), output rules (main-image
 *   fidelity, distinct image usages, conditional A+ gating) and optional overrides.
 * - brand: brand/output identity (mode, brand name, independent logo layer, no auto-change of the
 *   marketplace listing identity) and optional overrides.
 *
 * Explicit rules (nothing is silently dropped, defaulted or converted):
 * - Unknown top-level keys, unknown attribute names, unknown override sections and unsupported
 *   schema versions are rejected with ValidationError.
 * - Type/unit conflicts are rejected: `unit` is only allowed on number attributes; `allowedValues`
 *   is only valid for string/enum attributes; overlays may extend `allowedValues` only and can
 *   never change an attribute's name/type/unit.
 * - Facts: a number fact requires a non-empty unit (explicit; never inferred or converted);
 *   string/boolean facts may omit the unit, and string values are never interpreted as quantities
 *   (identifier-like aliases stay unit-free). A supplied `observedAt` must be a real-calendar ISO
 *   date (YYYY-MM-DD, kept at date precision) or a timezone-explicit timestamp; impossible dates
 *   and ambiguous/non-ISO strings are rejected. Missing/null sourceRef or observedAt means
 *   unknown/unrecorded — no default is filled in.
 * - Brand packs: `logoEnabled` must be a real boolean in both modes (unbranded stays false);
 *   `autoChangeGenericListing` must stay false.
 * - Merge precedence: category < market < brand. An override must target a section listed in the
 *   category's `overridable` map; attribute patches additionally require the attribute's own
 *   `overridableBy`. `facts` (provenance-carrying fixed values) can never be overridden, so
 *   market/brand packs cannot silently rewrite a fact's source, value or labels; SKU identity
 *   metadata (attribute name/type/unit) cannot be overridden either.
 * - The composed document is re-validated after merging and records `composedFrom` refs
 *   (packId/kind/version/sha256 of canonical JSON) so artifacts can cite exact pack versions.
 * - Lexicon maps are read through own properties only, so valid JSON keys such as toString or
 *   valueOf compose safely; reserved keys (__proto__ / constructor / prototype) are explicitly
 *   rejected anywhere in a pack document; validation never mutates its input and never pollutes
 *   prototypes.
 *
 * Only generic schema and synthetic examples live here; real private pack values live in the
 * private runtime/packs area and are never embedded in repository code or tests.
 */
const crypto = require('node:crypto');
const { ORIGIN_TYPES, APPROVAL_STATUSES, ValidationError } = require('./evidence.js');

const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);
const PACK_KINDS = Object.freeze(['category', 'market', 'brand']);
const ATTRIBUTE_TYPES = Object.freeze(['string', 'number', 'boolean', 'enum']);
const OVERRIDABLE_SECTIONS = Object.freeze(['lexicon', 'creativeHints', 'attributes']);
const PROTECTED_SECTIONS = Object.freeze(['facts']);
const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

const COMMON_KEYS = ['schemaVersion', 'packId', 'kind', 'version', 'title', 'annotations'];
const KIND_KEYS = Object.freeze({
  category: [...COMMON_KEYS, 'overridable', 'attributes', 'lexicon', 'creativeHints', 'facts'],
  market: [...COMMON_KEYS, 'market', 'outputRules', 'overrides'],
  brand: [...COMMON_KEYS, 'brand', 'overrides']
});
const COMPOSED_KEYS = ['schemaVersion', 'kind', 'composedFrom', 'attributes', 'lexicon', 'creativeHints', 'facts', 'market', 'outputRules', 'brand', 'annotations'];

function fail(message) {
  throw new ValidationError(message);
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function assertPlainObject(value, path) {
  if (!isPlainObject(value)) fail(`${path} must be a plain object`);
}
function assertNoReservedKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoReservedKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.includes(key)) fail(`${path}.${key} is a reserved key and cannot be used`);
    assertNoReservedKeys(value[key], `${path}.${key}`);
  }
}
function assertKnownKeys(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not a known field`);
  }
}
function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`);
  return value;
}
function requireBoolean(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
  return value;
}
function requireStringArray(value, path, options = {}) {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if (options.nonEmpty && value.length === 0) fail(`${path} must not be empty`);
  value.forEach((entry, index) => requireNonEmptyString(entry, `${path}[${index}]`));
  return value;
}
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
/** Real calendar check shared by the two accepted observedAt shapes. */
function isRealCalendarDate(year, month, day) {
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
/**
 * observedAt accepts a real-calendar ISO date (YYYY-MM-DD) or a timezone-explicit timestamp
 * (YYYY-MM-DDThh:mm:ss[.sss]Z or ±hh:mm). Stored verbatim: no time or timezone is invented.
 */
function isValidObservedAt(text) {
  let match = DATE_ONLY_RE.exec(text);
  if (match) return isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = TIMESTAMP_RE.exec(text);
  if (!match) return false;
  if (!isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const tz = match[8];
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (tz !== 'Z') {
    const offsetHours = Number(tz.slice(1, 3));
    const offsetMinutes = Number(tz.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes > 0)) return false;
  }
  return true;
}

// ---------- section validators ----------

function validateAttributeDef(def, path) {
  assertPlainObject(def, path);
  assertKnownKeys(def, ['name', 'type', 'unit', 'allowedValues', 'overridableBy'], path);
  const name = requireNonEmptyString(def.name, `${path}.name`);
  if (!ATTRIBUTE_TYPES.includes(def.type)) fail(`${path}.type must be one of ${ATTRIBUTE_TYPES.join(', ')}`);
  const unit = def.unit ?? null;
  if (unit !== null) {
    requireNonEmptyString(unit, `${path}.unit`);
    if (def.type !== 'number') fail(`${path}.unit is only allowed for number attributes`);
  }
  const allowedValues = def.allowedValues ?? null;
  if (allowedValues !== null) {
    if (def.type !== 'string' && def.type !== 'enum') fail(`${path}.allowedValues is only allowed for string/enum attributes`);
    requireStringArray(allowedValues, `${path}.allowedValues`, { nonEmpty: true });
  }
  if (def.type === 'enum' && allowedValues === null) fail(`${path}.allowedValues is required for enum attributes`);
  const overridableBy = def.overridableBy ?? [];
  if (!Array.isArray(overridableBy)) fail(`${path}.overridableBy must be an array`);
  for (const kind of overridableBy) {
    if (kind !== 'market' && kind !== 'brand') fail(`${path}.overridableBy entries must be market or brand`);
  }
  return { name, type: def.type, unit, allowedValues, overridableBy: [...overridableBy] };
}

function validateAttributes(attributes, path) {
  if (!Array.isArray(attributes)) fail(`${path} must be an array`);
  const seen = new Set();
  return attributes.map((def, index) => {
    const attribute = validateAttributeDef(def, `${path}[${index}]`);
    if (seen.has(attribute.name)) fail(`${path} contains duplicate attribute ${attribute.name}`);
    seen.add(attribute.name);
    return attribute;
  });
}

function validateLexicon(lexicon, path) {
  assertPlainObject(lexicon, path);
  for (const term of Object.keys(lexicon)) {
    requireNonEmptyString(term, `${path} term`);
    requireStringArray(lexicon[term], `${path}.${term}`, { nonEmpty: true });
  }
}

function validateCreativeHints(hints, path) {
  requireStringArray(hints, path);
}

function validateAnnotations(annotations, path) {
  requireStringArray(annotations, path);
}

function validateFacts(facts, path) {
  assertPlainObject(facts, path);
  for (const key of Object.keys(facts)) {
    requireNonEmptyString(key, `${path} key`);
    const fact = facts[key];
    const fp = `${path}.${key}`;
    assertPlainObject(fact, fp);
    assertKnownKeys(fact, ['value', 'unit', 'originType', 'approvalStatus', 'sourceRef', 'observedAt', 'note'], fp);
    const type = typeof fact.value;
    if (type === 'number') {
      if (!Number.isFinite(fact.value)) fail(`${fp}.value must be a finite number`);
    } else if (type === 'string') {
      requireNonEmptyString(fact.value, `${fp}.value`);
    } else if (type !== 'boolean') {
      fail(`${fp}.value must be a string, finite number or boolean`);
    }
    const unit = fact.unit ?? null;
    if (unit !== null) requireNonEmptyString(unit, `${fp}.unit`);
    if (type === 'number' && unit === null) fail(`${fp}.unit is required for number facts (explicit unit; never inferred)`);
    if (!ORIGIN_TYPES.includes(fact.originType)) fail(`${fp}.originType must be one of ${ORIGIN_TYPES.join(', ')}`);
    if (!APPROVAL_STATUSES.includes(fact.approvalStatus)) fail(`${fp}.approvalStatus must be one of ${APPROVAL_STATUSES.join(', ')}`);
    if (fact.sourceRef !== null && fact.sourceRef !== undefined) requireNonEmptyString(fact.sourceRef, `${fp}.sourceRef`);
    if (fact.observedAt !== null && fact.observedAt !== undefined) {
      const observedAt = requireNonEmptyString(fact.observedAt, `${fp}.observedAt`);
      if (!isValidObservedAt(observedAt)) {
        fail(`${fp}.observedAt must be a real-calendar ISO date (YYYY-MM-DD) or a timezone-explicit timestamp`);
      }
    }
    if (fact.note !== undefined) requireNonEmptyString(fact.note, `${fp}.note`);
  }
}

function validateOverridable(overridable, path) {
  assertPlainObject(overridable, path);
  assertKnownKeys(overridable, ['market', 'brand'], path);
  for (const kind of Object.keys(overridable)) {
    if (!Array.isArray(overridable[kind])) fail(`${path}.${kind} must be an array`);
    for (const section of overridable[kind]) {
      if (PROTECTED_SECTIONS.includes(section)) fail(`${path}.${kind} cannot include protected section ${section}`);
      if (!OVERRIDABLE_SECTIONS.includes(section)) fail(`${path}.${kind} includes unknown section ${section}`);
    }
  }
}

function validateMarket(market, path) {
  assertPlainObject(market, path);
  assertKnownKeys(market, ['channel', 'country', 'locale', 'currency'], path);
  for (const field of ['channel', 'country', 'locale', 'currency']) requireNonEmptyString(market[field], `${path}.${field}`);
}

function validateOutputRules(rules, path) {
  assertPlainObject(rules, path);
  assertKnownKeys(rules, ['mainImage', 'distinctUsages', 'aPlus'], path);
  assertPlainObject(rules.mainImage, `${path}.mainImage`);
  assertKnownKeys(rules.mainImage, ['backgroundWhite', 'overlayText', 'floatingLogo', 'showOnlyIncludedAccessories'], `${path}.mainImage`);
  for (const field of ['backgroundWhite', 'overlayText', 'floatingLogo', 'showOnlyIncludedAccessories']) {
    requireBoolean(rules.mainImage[field], `${path}.mainImage.${field}`);
  }
  requireStringArray(rules.distinctUsages, `${path}.distinctUsages`, { nonEmpty: true });
  assertPlainObject(rules.aPlus, `${path}.aPlus`);
  assertKnownKeys(rules.aPlus, ['conditional', 'eligibilityConfirmed', 'submissionAllowed'], `${path}.aPlus`);
  for (const field of ['conditional', 'eligibilityConfirmed', 'submissionAllowed']) {
    requireBoolean(rules.aPlus[field], `${path}.aPlus.${field}`);
  }
  if (rules.aPlus.submissionAllowed && !rules.aPlus.eligibilityConfirmed) {
    fail(`${path}.aPlus cannot allow submission while eligibility is unconfirmed`);
  }
}

function validateBrand(brand, path) {
  assertPlainObject(brand, path);
  assertKnownKeys(brand, ['mode', 'brandName', 'logoEnabled', 'logoLayerIndependent', 'autoChangeGenericListing'], path);
  if (brand.mode !== 'unbranded' && brand.mode !== 'branded') fail(`${path}.mode must be unbranded or branded`);
  requireBoolean(brand.logoEnabled, `${path}.logoEnabled`);
  if (brand.mode === 'unbranded') {
    if (brand.brandName !== null) fail(`${path}.brandName must be null for unbranded mode`);
    if (brand.logoEnabled !== false) fail(`${path}.logoEnabled must stay false for unbranded mode`);
  } else {
    requireNonEmptyString(brand.brandName, `${path}.brandName`);
  }
  requireBoolean(brand.logoLayerIndependent, `${path}.logoLayerIndependent`);
  requireBoolean(brand.autoChangeGenericListing, `${path}.autoChangeGenericListing`);
  if (brand.autoChangeGenericListing) {
    fail(`${path}.autoChangeGenericListing must stay false; brand packs never auto-change the marketplace listing identity`);
  }
}

function validateOverrides(overrides, path) {
  assertPlainObject(overrides, path);
  assertKnownKeys(overrides, OVERRIDABLE_SECTIONS, path);
  if (overrides.lexicon !== undefined) validateLexicon(overrides.lexicon, `${path}.lexicon`);
  if (overrides.creativeHints !== undefined) validateCreativeHints(overrides.creativeHints, `${path}.creativeHints`);
  if (overrides.attributes !== undefined) {
    assertPlainObject(overrides.attributes, `${path}.attributes`);
    for (const name of Object.keys(overrides.attributes)) {
      const patch = overrides.attributes[name];
      const pp = `${path}.attributes.${name}`;
      assertPlainObject(patch, pp);
      assertKnownKeys(patch, ['allowedValues'], pp);
      requireStringArray(patch.allowedValues, `${pp}.allowedValues`, { nonEmpty: true });
    }
  }
}

// ---------- pack validation ----------

function validatePack(pack) {
  assertPlainObject(pack, 'pack');
  assertNoReservedKeys(pack, 'pack');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(pack.schemaVersion)) {
    fail(`pack.schemaVersion ${String(pack.schemaVersion)} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`);
  }
  requireNonEmptyString(pack.packId, 'pack.packId');
  if (!PACK_KINDS.includes(pack.kind)) fail(`pack.kind must be one of ${PACK_KINDS.join(', ')}`);
  if (typeof pack.version !== 'string' || !VERSION_RE.test(pack.version)) fail('pack.version must look like MAJOR.MINOR.PATCH');
  requireNonEmptyString(pack.title, 'pack.title');
  assertKnownKeys(pack, KIND_KEYS[pack.kind], 'pack');
  if (pack.annotations !== undefined) validateAnnotations(pack.annotations, 'pack.annotations');
  if (pack.kind === 'category') {
    if (pack.overridable !== undefined) validateOverridable(pack.overridable, 'pack.overridable');
    validateAttributes(pack.attributes, 'pack.attributes');
    validateLexicon(pack.lexicon, 'pack.lexicon');
    validateCreativeHints(pack.creativeHints, 'pack.creativeHints');
    validateFacts(pack.facts, 'pack.facts');
  } else if (pack.kind === 'market') {
    validateMarket(pack.market, 'pack.market');
    if (pack.outputRules !== undefined) validateOutputRules(pack.outputRules, 'pack.outputRules');
    if (pack.overrides !== undefined) validateOverrides(pack.overrides, 'pack.overrides');
  } else {
    validateBrand(pack.brand, 'pack.brand');
    if (pack.overrides !== undefined) validateOverrides(pack.overrides, 'pack.overrides');
  }
  return pack;
}

function validateComposed(composed) {
  assertPlainObject(composed, 'composed');
  assertNoReservedKeys(composed, 'composed');
  assertKnownKeys(composed, COMPOSED_KEYS, 'composed');
  if (composed.schemaVersion !== 1) fail('composed.schemaVersion must be 1');
  if (composed.kind !== 'composed') fail('composed.kind must be composed');
  if (!Array.isArray(composed.composedFrom) || composed.composedFrom.length === 0) fail('composed.composedFrom must be a non-empty array');
  composed.composedFrom.forEach((ref, index) => {
    const rp = `composed.composedFrom[${index}]`;
    assertPlainObject(ref, rp);
    assertKnownKeys(ref, ['packId', 'kind', 'version', 'sha256'], rp);
    requireNonEmptyString(ref.packId, `${rp}.packId`);
    if (!PACK_KINDS.includes(ref.kind)) fail(`${rp}.kind must be one of ${PACK_KINDS.join(', ')}`);
    if (typeof ref.version !== 'string' || !VERSION_RE.test(ref.version)) fail(`${rp}.version must look like MAJOR.MINOR.PATCH`);
    if (typeof ref.sha256 !== 'string' || !SHA256_RE.test(ref.sha256)) fail(`${rp}.sha256 must be a sha256 hex digest`);
  });
  validateAttributes(composed.attributes, 'composed.attributes');
  validateLexicon(composed.lexicon, 'composed.lexicon');
  validateCreativeHints(composed.creativeHints, 'composed.creativeHints');
  validateFacts(composed.facts, 'composed.facts');
  if (composed.market !== null) validateMarket(composed.market, 'composed.market');
  if (composed.outputRules !== null) validateOutputRules(composed.outputRules, 'composed.outputRules');
  if (composed.brand !== null) validateBrand(composed.brand, 'composed.brand');
  if (composed.annotations !== undefined) validateAnnotations(composed.annotations, 'composed.annotations');
  return composed;
}

// ---------- composition ----------

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable artifact-citable reference: packId/kind/version + sha256 of canonical JSON. */
function packRef(pack) {
  validatePack(pack);
  return {
    packId: pack.packId,
    kind: pack.kind,
    version: pack.version,
    sha256: crypto.createHash('sha256').update(canonicalJson(pack)).digest('hex')
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyOverrides(merged, category, overlay) {
  if (overlay.overrides === undefined) return;
  const allowed = (category.overridable && category.overridable[overlay.kind]) || [];
  for (const section of Object.keys(overlay.overrides)) {
    if (PROTECTED_SECTIONS.includes(section)) fail(`overlay ${overlay.packId} cannot override protected section ${section}`);
    if (!allowed.includes(section)) fail(`overlay ${overlay.packId} may not override section ${section}`);
    if (section === 'lexicon') {
      for (const term of Object.keys(overlay.overrides.lexicon)) {
        const union = hasOwn(merged.lexicon, term) ? [...merged.lexicon[term]] : [];
        for (const variant of overlay.overrides.lexicon[term]) {
          if (!union.includes(variant)) union.push(variant);
        }
        merged.lexicon[term] = union;
      }
    } else if (section === 'creativeHints') {
      for (const hint of overlay.overrides.creativeHints) {
        if (!merged.creativeHints.includes(hint)) merged.creativeHints.push(hint);
      }
    } else if (section === 'attributes') {
      for (const name of Object.keys(overlay.overrides.attributes)) {
        const def = merged.attributes.find((attribute) => attribute.name === name);
        if (!def) fail(`overlay ${overlay.packId} targets unknown attribute ${name}`);
        if (!def.overridableBy.includes(overlay.kind)) fail(`attribute ${name} is not overridable by ${overlay.kind}`);
        if (def.type !== 'string' && def.type !== 'enum') {
          fail(`attribute ${name} of type ${def.type} cannot take allowedValues (type/unit conflicts are not overridable)`);
        }
        const union = def.allowedValues ? [...def.allowedValues] : [];
        for (const value of overlay.overrides.attributes[name].allowedValues) {
          if (!union.includes(value)) union.push(value);
        }
        def.allowedValues = union;
      }
    }
  }
}

/**
 * Compose a category pack with at most one market and one brand overlay.
 * Precedence: category < market < brand. Returns a re-validated composed document that records
 * exact pack references in `composedFrom`.
 */
function composePacks(category, overlays = []) {
  validatePack(category);
  if (category.kind !== 'category') fail('composePacks requires a category pack as the base');
  const merged = {
    attributes: cloneJson(validateAttributes(category.attributes, 'pack.attributes')),
    lexicon: cloneJson(category.lexicon),
    creativeHints: cloneJson(category.creativeHints),
    facts: cloneJson(category.facts),
    annotations: cloneJson(category.annotations ?? [])
  };
  const ordered = [];
  const seenKinds = new Set();
  for (const overlay of overlays) {
    validatePack(overlay);
    if (overlay.kind === 'category') fail('overlays must be market or brand packs');
    if (seenKinds.has(overlay.kind)) fail(`only one ${overlay.kind} overlay is allowed`);
    seenKinds.add(overlay.kind);
    ordered.push(overlay);
  }
  ordered.sort((a, b) => (a.kind === 'market' ? -1 : 1) - (b.kind === 'market' ? -1 : 1));
  for (const overlay of ordered) {
    applyOverrides(merged, category, overlay);
    if (overlay.annotations) merged.annotations.push(...overlay.annotations);
  }
  const market = ordered.find((overlay) => overlay.kind === 'market') ?? null;
  const brand = ordered.find((overlay) => overlay.kind === 'brand') ?? null;
  const composed = {
    schemaVersion: 1,
    kind: 'composed',
    composedFrom: [category, ...ordered].map(packRef),
    attributes: merged.attributes,
    lexicon: merged.lexicon,
    creativeHints: merged.creativeHints,
    facts: merged.facts,
    market: market ? cloneJson(market.market) : null,
    outputRules: market && market.outputRules !== undefined ? cloneJson(market.outputRules) : null,
    brand: brand ? cloneJson(brand.brand) : null,
    annotations: merged.annotations
  };
  return validateComposed(composed);
}

module.exports = {
  SUPPORTED_SCHEMA_VERSIONS,
  PACK_KINDS,
  ATTRIBUTE_TYPES,
  validatePack,
  validateComposed,
  composePacks,
  packRef,
  canonicalJson
};
