'use strict';
/**
 * T3.3 channel company domain — CompanyLead discovery, normalization, conservative dedupe,
 * adaptation evidence, guarded state machine and registered handler.
 *
 * A company is NOT an ASIN: finding a company is not intent, a domain is not a deliverability
 * proof and a directory hit never auto-qualifies a lead. The named source contract is the
 * fixture-only `synthetic-association-directory.v1` on the reserved host `directory.example.test`
 * (real GET request construction, URL/redirect guards reused from the approved T3.1 url-policy and
 * transport public helpers, real deterministic HTML parsing, injected synthetic transport). API /
 * browser / live stay closed; the fixture grant never upgrades to live.
 *
 * Scope isolation: the company entity lives in the project-scoped `company_leads` table (no brand
 * column is invented), while brand/market adaptation conclusions and source versions are written
 * to a factory-scoped private metadata snapshot whose path and manifest are bound to the EXACT
 * project/brand/market strings (the empty brand is a real value, never a wildcard).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const evidence = require('./evidence.js');
const worker = require('./worker.js');
const { canonicalJson } = require('./packs.js');
const { createPermissionGatedApiTransport, executeWithPolicy, createRateLimiter } = require('./connectors/transport.js');
const { parseUrlBasics, assertResponseSource } = require('./connectors/url-policy.js');
const { pathWithinAllowed } = require('./connectors/source-register.js');
const { deepFreeze } = require('./providers/schema.js');

const COMPANIES_SCHEMA_VERSION = 1;
const COMPANIES_RULES_VERSION = 't3.3-rules-v1';
const COMPANY_TOOL_NAME = 'commerce.companies.discover';
const COMPANY_TOOL_VERSION = '1.0.0';
const COMPANY_ROLE = 'channel-development';
const COMPANY_STATUSES = Object.freeze(['discovered', 'screened', 'qualified', 'contact_candidate']);
/** discovered → screened → qualified → contact_candidate; no skips, no rollbacks. */
const STATUS_TRANSITIONS = Object.freeze({
  discovered: Object.freeze(['screened']),
  screened: Object.freeze(['qualified']),
  qualified: Object.freeze(['contact_candidate']),
  contact_candidate: Object.freeze([])
});
const ADAPTATION_DIMENSIONS = Object.freeze(['category', 'channel', 'region']);
const COMPANY_SOURCE_USES = Object.freeze(['company_discovery']);
const COMPANY_SOURCE_ID = 'synthetic-association-directory.v1';
const COMPANY_SOURCE_HOST = 'directory.example.test';
const SOURCE_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,59}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const DEFAULT_COMPANY_RULES = Object.freeze({
  rulesVersion: COMPANIES_RULES_VERSION,
  limits: Object.freeze({ maxPages: 3, maxCandidates: 12, maxRequests: 24, maxManualRecords: 12 }),
  matching: Object.freeze({ prefixMatchMinLength: 5 })
});

class CompanyError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CompanyError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
function companyError(code, message, detail) { return new CompanyError(code, message, detail); }
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw companyError('validation', `${label} must be a non-empty string`);
  return value.trim();
}
function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw companyError('validation', `${label} must be a string`);
  return value.trim();
}
function requireIso(value, label) {
  const text = requireNonEmptyString(value, label);
  if (!ISO_RE.test(text) || Number.isNaN(Date.parse(text))) throw companyError('validation', `${label} must be an ISO-8601 UTC instant`);
  return text;
}
function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function normalizeValue(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function uniqueSorted(values) { return [...new Set(values)].sort(compareStrings); }

// ---------- A. named fixture-only source contract ----------

/** The default fixture source registration (validated copy). Not a sampled real association site. */
function syntheticDirectorySourceRegistration(overrides = {}) {
  const base = {
    schemaVersion: 1,
    sourceId: COMPANY_SOURCE_ID,
    version: 'synthetic.directory-1',
    host: COMPANY_SOURCE_HOST,
    allowedPaths: ['/directory', '/members'],
    allowedMethods: ['GET'],
    allowedUses: ['company_discovery'],
    permit: {
      approvalStatus: 'approved',
      approvalBasis: 'synthetic fixture grant (never upgrades to live; no real association site permission)',
      approvalObservedAt: '2026-10-15T00:00:00.000Z',
      expiresAt: null,
      execution: { fixture: true, manual: true, live: false },
      robots: { status: 'reviewed_allowed', basis: 'synthetic-only', observedAt: '2026-10-15T00:00:00.000Z' },
      tos: { status: 'reviewed_allowed', basis: 'synthetic-only', observedAt: '2026-10-15T00:00:00.000Z' },
      rateLimit: { requestsPerWindow: 30, windowMs: 60000, maxAttempts: 3, backoffBaseMs: 100, backoffCapMs: 5000 }
    },
    note: 'SYNTHETIC fixture source (directory.example.test reserved domain); NOT a sampled real association site.'
  };
  return { ...base, ...overrides, permit: { ...base.permit, ...(overrides.permit || {}) } };
}

/** Strict companies source contract: unknown fields fail closed; the use enum is company_discovery. */
function validateCompanySourceRegistration(raw) {
  if (!isPlainObject(raw)) throw companyError('registration_invalid', 'company source registration must be a plain object');
  const allowedFields = ['schemaVersion', 'sourceId', 'version', 'host', 'allowedPaths', 'allowedMethods', 'allowedUses', 'permit', 'note'];
  for (const key of Object.keys(raw)) {
    if (!allowedFields.includes(key)) throw companyError('registration_invalid', `source.${key} is not a declared field (fail-closed)`);
  }
  if (raw.schemaVersion !== 1) throw companyError('registration_invalid', 'source.schemaVersion must be 1');
  const sourceId = requireNonEmptyString(raw.sourceId, 'source.sourceId');
  const version = requireNonEmptyString(raw.version, 'source.version');
  if (!SOURCE_VERSION_PATTERN.test(version)) throw companyError('registration_invalid', 'source.version must match the versioned label pattern');
  const host = requireNonEmptyString(raw.host, 'source.host').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) {
    throw companyError('registration_invalid', 'source.host must be a bare lowercase host name');
  }
  if (!Array.isArray(raw.allowedPaths) || raw.allowedPaths.length === 0) throw companyError('registration_invalid', 'source.allowedPaths must be a non-empty array');
  const allowedPaths = raw.allowedPaths.map((entry, index) => {
    const value = requireNonEmptyString(entry, `source.allowedPaths[${index}]`);
    if (!value.startsWith('/')) throw companyError('registration_invalid', `source.allowedPaths[${index}] must start with /`);
    return value.replace(/\/+$/, '') || '/';
  });
  if (!Array.isArray(raw.allowedMethods) || raw.allowedMethods.length === 0) throw companyError('registration_invalid', 'source.allowedMethods must be a non-empty array');
  const allowedMethods = raw.allowedMethods.map((entry, index) => {
    const method = requireNonEmptyString(entry, `source.allowedMethods[${index}]`).toUpperCase();
    if (method !== 'GET') throw companyError('registration_invalid', `source.allowedMethods[${index}] must be GET`);
    return method;
  });
  if (!Array.isArray(raw.allowedUses) || raw.allowedUses.length === 0) throw companyError('registration_invalid', 'source.allowedUses must be a non-empty array');
  const allowedUses = raw.allowedUses.map((entry, index) => {
    const use = requireNonEmptyString(entry, `source.allowedUses[${index}]`);
    if (!COMPANY_SOURCE_USES.includes(use)) throw companyError('registration_invalid', `source.allowedUses[${index}] is not a known company use`);
    return use;
  });
  const permitRaw = raw.permit;
  if (!isPlainObject(permitRaw)) throw companyError('registration_invalid', 'source.permit must be a plain object');
  const permitFields = ['approvalStatus', 'approvalBasis', 'approvalObservedAt', 'expiresAt', 'robots', 'tos', 'rateLimit', 'execution'];
  for (const key of Object.keys(permitRaw)) {
    if (!permitFields.includes(key)) throw companyError('registration_invalid', `source.permit.${key} is not a declared field (fail-closed)`);
  }
  const approvalStatus = requireNonEmptyString(permitRaw.approvalStatus, 'source.permit.approvalStatus');
  if (!['approved', 'pending', 'denied', 'expired', 'unknown'].includes(approvalStatus)) throw companyError('registration_invalid', 'source.permit.approvalStatus is not a known status');
  const approvalBasis = requireNonEmptyString(permitRaw.approvalBasis, 'source.permit.approvalBasis');
  const approvalObservedAt = requireIso(permitRaw.approvalObservedAt, 'source.permit.approvalObservedAt');
  const expiresAt = permitRaw.expiresAt === null || permitRaw.expiresAt === undefined ? null : requireIso(permitRaw.expiresAt, 'source.permit.expiresAt');
  const executionRaw = permitRaw.execution === undefined || permitRaw.execution === null ? {} : permitRaw.execution;
  if (!isPlainObject(executionRaw)) throw companyError('registration_invalid', 'source.permit.execution must be a plain object');
  const execution = {};
  for (const mode of ['fixture', 'manual', 'live']) {
    const value = executionRaw[mode] === undefined ? (mode === 'live' ? false : true) : executionRaw[mode];
    if (typeof value !== 'boolean') throw companyError('registration_invalid', `source.permit.execution.${mode} must be a boolean`);
    execution[mode] = value;
  }
  for (const key of Object.keys(executionRaw)) {
    if (!['fixture', 'manual', 'live'].includes(key)) throw companyError('registration_invalid', `source.permit.execution.${key} is not a declared field (fail-closed)`);
  }
  const reviewOf = (entry, label) => {
    if (!isPlainObject(entry)) throw companyError('registration_invalid', `${label} must be a plain object`);
    for (const key of Object.keys(entry)) {
      if (!['status', 'basis', 'observedAt'].includes(key)) throw companyError('registration_invalid', `${label}.${key} is not a declared field (fail-closed)`);
    }
    const status = requireNonEmptyString(entry.status, `${label}.status`);
    if (!['reviewed_allowed', 'reviewed_disallowed', 'unknown'].includes(status)) throw companyError('registration_invalid', `${label}.status is not a known review status`);
    return { status, basis: requireNonEmptyString(entry.basis, `${label}.basis`), observedAt: requireIso(entry.observedAt, `${label}.observedAt`) };
  };
  const robots = reviewOf(permitRaw.robots, 'source.permit.robots');
  const tos = reviewOf(permitRaw.tos, 'source.permit.tos');
  const rateRaw = permitRaw.rateLimit;
  if (!isPlainObject(rateRaw)) throw companyError('registration_invalid', 'source.permit.rateLimit must be a plain object');
  for (const key of Object.keys(rateRaw)) {
    if (!['requestsPerWindow', 'windowMs', 'maxAttempts', 'backoffBaseMs', 'backoffCapMs'].includes(key)) throw companyError('registration_invalid', `source.permit.rateLimit.${key} is not a declared field (fail-closed)`);
  }
  const requireInt = (value, label, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) throw companyError('registration_invalid', `${label} must be an integer in [${min}, ${max}]`);
    return value;
  };
  const rateLimit = {
    requestsPerWindow: requireInt(rateRaw.requestsPerWindow, 'rateLimit.requestsPerWindow', 1, 60),
    windowMs: requireInt(rateRaw.windowMs, 'rateLimit.windowMs', 1, 3600000),
    maxAttempts: requireInt(rateRaw.maxAttempts, 'rateLimit.maxAttempts', 1, 5),
    backoffBaseMs: requireInt(rateRaw.backoffBaseMs, 'rateLimit.backoffBaseMs', 0, 60000),
    backoffCapMs: requireInt(rateRaw.backoffCapMs, 'rateLimit.backoffCapMs', 1, 300000)
  };
  if (rateLimit.backoffCapMs < rateLimit.backoffBaseMs) throw companyError('registration_invalid', 'rateLimit.backoffCapMs must be >= backoffBaseMs');
  const note = raw.note === undefined || raw.note === null ? null : String(raw.note);
  return deepFreeze({
    schemaVersion: 1,
    sourceId,
    version,
    host,
    allowedPaths,
    allowedMethods,
    allowedUses,
    permit: { approvalStatus, approvalBasis, approvalObservedAt, expiresAt, robots, tos, rateLimit, execution },
    note
  });
}

function sourceVersionLabel(source) { return `${source.sourceId}@${source.version}`; }

// ---------- B. request construction and guards (https only, registered host/path) ----------

/** Company discovery requests are https-only on the registered host/path; reuses the T3.1 URL guards. */
function assertCompanyRequestUrl(rawUrl, source) {
  const basics = parseUrlBasics(rawUrl);
  if (basics.protocol !== 'https:') throw companyError('url_protocol_not_allowed', 'company discovery requests must be https');
  if (basics.host !== source.host) throw companyError('url_host_not_allowed', `host ${basics.host} is not the registered company source host ${source.host}`);
  if (!pathWithinAllowed(basics.path, source.allowedPaths)) throw companyError('url_path_not_allowed', `path ${basics.path} is outside the registered company source scope`);
  return { url: String(basics.url), host: basics.host, path: basics.path, protocol: basics.protocol };
}

function buildDirectoryRequest(source, { page = 1 } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 5) throw companyError('validation', 'directory page must be an integer 1..5');
  const url = `https://${source.host}/directory`;
  assertCompanyRequestUrl(url, source);
  return { method: 'GET', url, host: source.host, path: '/directory', use: 'company_discovery', meta: { page } };
}

function buildMemberRequest(source, slug) {
  const safeSlug = String(slug || '');
  if (!SLUG_RE.test(safeSlug)) throw companyError('member_slug_invalid', `member slug ${JSON.stringify(safeSlug)} is not a bounded slug`);
  const url = `https://${source.host}/members/${safeSlug}`;
  assertCompanyRequestUrl(url, source);
  return { method: 'GET', url, host: source.host, path: `/members/${safeSlug}`, use: 'company_discovery', meta: { slug: safeSlug } };
}

/** Stored (never fetched) external citation links must still be well-formed https URLs. */
function assertExternalCitationUrl(rawUrl) {
  const basics = parseUrlBasics(rawUrl);
  if (basics.protocol !== 'https:') throw companyError('url_protocol_not_allowed', 'stored external citation links must be https');
  return { url: String(basics.url), host: basics.host };
}

// ---------- C. deterministic HTML parsing ----------

function stripTags(text) { return String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractById(html, id) {
  const re = new RegExp(`<([a-z0-9]+)([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)</\\1>`, 'i');
  const match = String(html).match(re);
  return match ? stripTags(match[3]) || null : null;
}
function extractAttrById(html, id, attr) {
  const tagMatch = String(html).match(new RegExp(`<[a-z0-9]+[^>]*\\bid="${id}"[^>]*>`, 'i'));
  if (!tagMatch) return null;
  const attrMatch = tagMatch[0].match(new RegExp(`\\b${attr}="([^"]*)"`, 'i'));
  return attrMatch ? attrMatch[1] : null;
}
function parseObservedAt(html) {
  const tagMatch = String(html).match(/<meta[^>]*\bname="x-observed-at"[^>]*>/i);
  if (!tagMatch) return { known: false, value: null };
  const contentMatch = tagMatch[0].match(/\bcontent="([^"]*)"/i);
  const value = contentMatch ? contentMatch[1] : '';
  if (!ISO_RE.test(value) || Number.isNaN(Date.parse(value))) return { known: false, value: null };
  return { known: true, value };
}

function parseDirectoryIndex(html, { source }) {
  const entries = [];
  const refusals = [];
  const blockRe = /<li\b[^>]*\bclass="member"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  let index = 0;
  while ((match = blockRe.exec(String(html))) !== null) {
    index += 1;
    const block = match[0];
    const memberId = (block.match(/\bdata-member-id="([^"]*)"/i) || [])[1] || null;
    const anchor = block.match(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const href = anchor ? anchor[1] : null;
    const name = anchor ? stripTags(anchor[2]) : '';
    if (href === null) { refusals.push({ code: 'member_link_missing', memberId }); continue; }
    let url;
    try {
      const resolved = new URL(href, `https://${source.host}/`);
      url = assertCompanyRequestUrl(String(resolved), source);
    } catch (error) {
      refusals.push({ code: error.code || 'member_link_invalid', memberId, href, reason: error.message });
      continue;
    }
    const slugMatch = url.path.match(/^\/members\/([a-z0-9-]+)$/);
    if (!slugMatch) { refusals.push({ code: 'member_link_path_invalid', memberId, href }); continue; }
    entries.push({ memberId: memberId || `entry-${index}`, name, slug: slugMatch[1], url: url.url });
  }
  return { entries, refusals };
}

function parseMemberPage(html, { source, url }) {
  const name = extractById(html, 'company-name');
  const officialSiteRaw = extractAttrById(html, 'official-site', 'href');
  let officialSite = null;
  let officialRefusal = null;
  if (officialSiteRaw) {
    try {
      const parsed = new URL(officialSiteRaw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not an http(s) link');
      if (parsed.username !== '' || parsed.password !== '') throw new Error('link carries credentials');
      officialSite = { url: String(parsed), host: parsed.hostname.toLowerCase(), unvisited: true };
    } catch (error) {
      officialRefusal = { code: 'official_site_link_invalid', href: officialSiteRaw };
    }
  }
  const crossReferenceRaw = extractAttrById(html, 'cross-reference', 'data-domain');
  const observed = parseObservedAt(html);
  return {
    url,
    sha256: sha256Hex(String(html)),
    name: name || null,
    officialSite,
    officialRefusal,
    address: extractById(html, 'address'),
    category: extractById(html, 'category'),
    channel: extractById(html, 'channel'),
    region: extractById(html, 'region'),
    contactCitation: extractById(html, 'contact-citation'),
    legalId: extractById(html, 'legal-id'),
    crossReferences: crossReferenceRaw ? [crossReferenceRaw.trim().toLowerCase()] : [],
    observedAt: observed.value,
    timeKnown: observed.known,
    sourceId: source.sourceId,
    sourceVersion: source.version
  };
}

// ---------- D. normalization (limited, original values preserved) ----------

function normalizeCompanyName(raw) {
  const original = String(raw === null || raw === undefined ? '' : raw).trim();
  return { original, normalized: original.toLowerCase().replace(/\s+/g, ' ') };
}

/** URL host normalization: lowercase, trailing dot, limited www equivalence; the full host is the
 *  comparison key (never an eTLD+1 guess). Node's URL applies IDNA (punycode) automatically. */
function normalizeDomainValue(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (text === '') return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { original: text, host: null, normalizedHost: null, invalid: true };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { original: text, host: null, normalizedHost: null, invalid: true };
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);
  if (host === '') return { original: text, host: null, normalizedHost: null, invalid: true };
  return { original: text, host: url.hostname.toLowerCase(), normalizedHost: host, invalid: false };
}

function normalizeAddressValue(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (text === '') return { original: null, normalized: null };
  return { original: text, normalized: text.toLowerCase().replace(/[,\s]+/g, ' ').trim() };
}

// ---------- E. conservative deterministic dedupe ----------

/** Explicit legal-entity/address conflicts are never merged by shared host alone. */
function recordsConflict(left, right) {
  if (left.legalId && right.legalId && normalizeValue(left.legalId) !== normalizeValue(right.legalId)) return true;
  if (left.address && left.address.normalized && right.address && right.address.normalized && left.address.normalized !== right.address.normalized) return true;
  return false;
}

function identityKeyOf(record) {
  return `identity:${record.name.normalized}|${(record.address && record.address.normalized) || ''}|${normalizeValue(record.legalId || '')}`;
}

/**
 * Deterministic conservative dedupe. A shared normalized host is only ONE entity while its records
 * stay identity-consistent: explicit legal-id/address conflicts split the host into independent
 * candidates whose canonical domain stays unconfirmed (the candidate host is kept as provenance,
 * never faked into the unique domain index). Different hosts merge ONLY with an explicit identity
 * proof (official cross-reference to a confirmed host, or equal non-empty legal id + address).
 * Same-name/different-entity pairs stay separate and are reported as suspected duplicates; shared
 * platform page URLs are provenance, never a company domain.
 */
function dedupeCompanyRecords(records) {
  // 1. partition by normalized host, splitting host groups on explicit identity conflicts
  const byHost = new Map();
  const domainless = [];
  for (const record of [...records].sort((a, b) => compareStrings(a.recordId, b.recordId))) {
    const host = record.domain && record.domain.normalizedHost ? record.domain.normalizedHost : null;
    if (host) {
      const list = byHost.get(host) || [];
      list.push(record);
      byHost.set(host, list);
    } else {
      domainless.push(record);
    }
  }
  const componentOf = new Map();
  const componentInfo = new Map();
  const componentMembers = new Map();
  const hasIdentityInfo = (record) => Boolean(record.legalId || (record.address && record.address.normalized));
  for (const [host, group] of byHost.entries()) {
    const parent = group.map((_, index) => index);
    const find = (index) => {
      let current = index;
      while (parent[current] !== current) { parent[current] = parent[parent[current]]; current = parent[current]; }
      return current;
    };
    const membersOf = (root) => group.filter((_, index) => find(index) === root);
    // every union checks the WHOLE component constraint: a known legal/address conflict can never
    // be erased through an intermediate (bridge) record or any other union path
    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) return false;
      const membersA = membersOf(rootA);
      const membersB = membersOf(rootB);
      if (membersA.some((left) => membersB.some((right) => recordsConflict(left, right)))) return false;
      parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
      return true;
    };
    const identityIndexes = group.map((record, index) => [record, index]).filter(([record]) => hasIdentityInfo(record)).map(([, index]) => index);
    const anonymousIndexes = group.map((record, index) => [record, index]).filter(([record]) => !hasIdentityInfo(record)).map(([, index]) => index);
    for (let a = 0; a < identityIndexes.length; a += 1) {
      for (let b = a + 1; b < identityIndexes.length; b += 1) union(identityIndexes[a], identityIndexes[b]);
    }
    const identityRoots = uniqueSorted(identityIndexes.map((index) => String(find(index))));
    if (identityRoots.length === 1 && anonymousIndexes.length > 0) {
      // a single identity component has no contradiction to erase: anonymous records may join
      for (const anonymous of anonymousIndexes) union(anonymous, identityIndexes[0]);
    }
    // with several identity components an unknown bridge stays independent: unknown is NOT the
    // same identity and must not be assigned to either side
    const components = new Map();
    group.forEach((record, index) => {
      const root = find(index);
      const list = components.get(root) || [];
      list.push(record);
      components.set(root, list);
    });
    const singleComponent = components.size === 1;
    for (const root of [...components.keys()].sort((a, b) => a - b)) {
      const componentRecords = components.get(root);
      const key = singleComponent
        ? `host:${host}`
        : identityKeyOf(componentRecords[0]);
      for (const record of componentRecords) componentOf.set(record.recordId, key);
      componentInfo.set(key, { host, confirmed: singleComponent });
      componentMembers.set(key, [...componentRecords].sort((a, b) => compareStrings(a.recordId, b.recordId)));
    }
  }
  for (const record of domainless) {
    componentOf.set(record.recordId, identityKeyOf(record));
    componentMembers.set(identityKeyOf(record), [record]);
  }

  // 2. union components across hosts with explicit identity proofs — the same whole-component
  // conflict constraint applies here: no union path may reunite known conflicting identities
  const keys = uniqueSorted([...componentOf.values()]);
  const parent = new Map(keys.map((key) => [key, key]));
  const find = (key) => {
    let current = key;
    while (parent.get(current) !== current) { parent.set(current, parent.get(parent.get(current))); current = parent.get(current); }
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return false;
    const membersA = componentMembers.get(rootA) || [];
    const membersB = componentMembers.get(rootB) || [];
    if (membersA.some((left) => membersB.some((right) => recordsConflict(left, right)))) return false;
    const [first, second] = compareStrings(rootA, rootB) <= 0 ? [rootA, rootB] : [rootB, rootA];
    parent.set(second, first);
    componentMembers.set(first, [...membersA, ...membersB]);
    componentMembers.delete(second);
    return true;
  };
  const merges = [];
  const confirmedHostToKeys = new Map();
  for (const [key, info] of componentInfo.entries()) {
    if (!info.confirmed) continue;
    const list = confirmedHostToKeys.get(info.host) || [];
    list.push(key);
    confirmedHostToKeys.set(info.host, list);
  }
  for (const record of [...records].sort((a, b) => compareStrings(a.recordId, b.recordId))) {
    for (const ref of uniqueSorted(record.crossReferences || [])) {
      for (const target of uniqueSorted(confirmedHostToKeys.get(ref) || [])) {
        if (target === componentOf.get(record.recordId)) continue;
        if (union(componentOf.get(record.recordId), target)) merges.push({ left: componentOf.get(record.recordId), right: target, proof: 'official_cross_reference', from: record.recordId, domain: ref });
      }
    }
  }
  const legalIndex = new Map();
  for (const record of records) {
    if (record.legalId && record.address && record.address.normalized) {
      const legalKey = `${normalizeValue(record.legalId)}|${record.address.normalized}`;
      const set = legalIndex.get(legalKey) || new Set();
      set.add(componentOf.get(record.recordId));
      legalIndex.set(legalKey, set);
    }
  }
  for (const [legalKey, keySet] of [...legalIndex.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const distinct = uniqueSorted([...keySet]);
    for (let index = 1; index < distinct.length; index += 1) {
      if (union(distinct[0], distinct[index])) merges.push({ left: distinct[0], right: distinct[index], proof: 'legal_identity', key: legalKey });
    }
  }

  // 3. assemble entities
  const groups = new Map();
  for (const record of records) {
    const root = find(componentOf.get(record.recordId));
    const list = groups.get(root) || [];
    list.push(record);
    groups.set(root, list);
  }
  const entities = [...groups.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([entityKey, groupRecords]) => {
      const sorted = [...groupRecords].sort((a, b) => compareStrings(a.recordId, b.recordId));
      const componentKeys = uniqueSorted(sorted.map((record) => componentOf.get(record.recordId)));
      const domains = uniqueSorted(componentKeys.map((key) => componentInfo.get(key)).filter((info) => info && info.confirmed).map((info) => info.host));
      const candidateDomains = uniqueSorted(componentKeys.map((key) => componentInfo.get(key)).filter((info) => info && !info.confirmed).map((info) => info.host));
      const names = uniqueSorted(sorted.map((record) => record.name.original).filter(Boolean));
      const provenance = [];
      const seen = new Set();
      for (const record of sorted) {
        for (const entry of record.provenance || []) {
          const signature = `${entry.url}|${entry.sha256 || ''}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          provenance.push(entry);
        }
      }
      provenance.sort((a, b) => compareStrings(a.url, b.url));
      const claims = [];
      for (const record of sorted) for (const claim of record.claims || []) claims.push(claim);
      return {
        entityKey,
        name: names[0],
        nameVariants: names,
        domains,
        candidateDomains,
        canonicalDomainConfirmed: domains.length > 0 && candidateDomains.length === 0,
        addresses: uniqueSorted(sorted.map((record) => record.address && record.address.original).filter(Boolean)),
        legalIds: uniqueSorted(sorted.map((record) => record.legalId).filter(Boolean)),
        crossReferences: uniqueSorted(sorted.flatMap((record) => record.crossReferences || [])),
        officialSites: uniqueSorted(sorted.map((record) => record.officialSite && record.officialSite.url).filter(Boolean)),
        contactCitations: sorted.map((record) => record.contactCitation).filter(Boolean),
        provenance,
        records: sorted.map((record) => record.recordId),
        claims,
        manual: sorted.every((record) => record.manual === true)
      };
    });
  const byName = new Map();
  for (const entity of entities) {
    const entityNames = uniqueSorted(entity.nameVariants.map((name) => normalizeCompanyName(name).normalized).filter(Boolean));
    for (const name of entityNames) {
      const list = byName.get(name) || [];
      list.push(entity.entityKey);
      byName.set(name, list);
    }
  }
  const suspected = [];
  for (const [name, entityKeys] of [...byName.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const distinct = uniqueSorted(entityKeys);
    for (let index = 0; index < distinct.length; index += 1) {
      for (let other = index + 1; other < distinct.length; other += 1) {
        suspected.push({ left: distinct[index], right: distinct[other], name, reason: 'same_name_no_identity_proof' });
      }
    }
  }
  // near-domain suspicion: same first host label AND same first name token (never merged)
  for (let index = 0; index < entities.length; index += 1) {
    for (let other = index + 1; other < entities.length; other += 1) {
      const left = entities[index];
      const right = entities[other];
      const leftTokens = new Set(left.nameVariants.map((name) => normalizeCompanyName(name).normalized.split(' ')[0]).filter((token) => token.length >= 3));
      const rightTokens = right.nameVariants.map((name) => normalizeCompanyName(name).normalized.split(' ')[0]).filter((token) => token.length >= 3);
      const sharedToken = rightTokens.some((token) => leftTokens.has(token));
      const leftLabels = new Set(left.domains.map((host) => host.split('.')[0]));
      const sharedLabel = right.domains.some((host) => leftLabels.has(host.split('.')[0]));
      if (sharedToken && sharedLabel) {
        suspected.push({ left: left.entityKey, right: right.entityKey, reason: 'near_domain_shared_label_no_identity_proof' });
      }
    }
  }
  suspected.sort((a, b) => compareStrings(`${a.left}|${a.right}|${a.reason}`, `${b.left}|${b.right}|${b.reason}`));
  return { entities, merges: merges.sort((a, b) => compareStrings(`${a.left}|${a.right}|${a.proof}`, `${b.left}|${b.right}|${b.proof}`)), suspected };
}

// ---------- F. adaptation evidence (visible claims only) ----------

/** Limited conservative negation cues: a sentence containing one is never treated as positive
 *  suitability evidence (the original text is kept; the dimension stays candidate/needs_review). */
const NEGATION_CUES = Object.freeze(['do not', "don't", 'does not', "doesn't", 'not a', 'not an', 'no ', 'never', 'without', 'none ', 'not sell', 'not for', 'not available']);
function claimHasNegationCue(text) {
  const claim = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  return NEGATION_CUES.some((cue) => claim.includes(cue));
}

function claimMatchesToken(claimText, token, rules) {
  const claim = String(claimText || '').toLowerCase();
  const needle = String(token || '').trim().toLowerCase();
  if (needle === '' || claim === '') return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(claim)) return true;
  if (needle.length >= rules.matching.prefixMatchMinLength && new RegExp(`(^|[^a-z0-9])${escaped}`).test(claim)) return true;
  return false;
}

function evaluateCompanyAdaptation(entity, profile, rules) {
  const dimensions = [];
  for (const dimension of ADAPTATION_DIMENSIONS) {
    const wanted = Array.isArray(profile[dimension]) ? profile[dimension].map(normalizeValue).filter(Boolean) : [];
    const matchedClaims = [];
    const unknownTimeClaims = [];
    const negatedClaims = [];
    for (const claim of entity.claims.filter((entry) => entry.dimension === dimension)) {
      if (claimHasNegationCue(claim.text)) {
        negatedClaims.push({ dimension, claimText: claim.text, pageUrl: claim.pageUrl, sha256: claim.sha256 });
        continue;
      }
      const tokens = wanted.filter((token) => claimMatchesToken(claim.text, token, rules));
      if (tokens.length === 0) continue;
      const record = { dimension, claimText: claim.text, tokens, pageUrl: claim.pageUrl, sha256: claim.sha256, observedAt: claim.observedAt || null };
      if (claim.timeKnown) matchedClaims.push(record);
      else unknownTimeClaims.push(record);
    }
    dimensions.push({ dimension, required: wanted.length > 0, matched: matchedClaims.length > 0, matchedClaims, unknownTimeClaims, negatedClaims });
  }
  const required = dimensions.filter((entry) => entry.required);
  return {
    dimensions,
    matchedDimensions: dimensions.filter((entry) => entry.matched).map((entry) => entry.dimension),
    missingDimensions: required.filter((entry) => !entry.matched).map((entry) => entry.dimension),
    unknownTimeDimensions: dimensions.filter((entry) => entry.unknownTimeClaims.length > 0).map((entry) => entry.dimension),
    negatedDimensions: dimensions.filter((entry) => entry.negatedClaims.length > 0).map((entry) => entry.dimension),
    qualifies: required.length > 0 && required.every((entry) => entry.matched)
  };
}

// ---------- G. persistence (existing company_leads / evidence / observations contracts) ----------

function companyLeadId(projectId, entityKey) { return `cl_${sha256Hex(`${projectId}|${entityKey}`).slice(0, 20)}`; }

function upsertCompanyLead(db, projectId, entity, { clock }) {
  const id = companyLeadId(projectId, entity.entityKey);
  const name = requireNonEmptyString(entity.name, 'entity.name');
  // the canonical domain is only written when confirmed; a conflicting shared host stays a
  // candidate (kept as provenance) and the column stays NULL instead of faking a unique domain
  const domain = entity.canonicalDomainConfirmed && entity.domains.length > 0 ? entity.domains[0] : null;
  const address = entity.addresses.length > 0 ? entity.addresses[0] : null;
  const sourceType = entity.manual ? 'manual_import' : 'association_directory';
  const now = clock();
  const existing = db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(projectId, id);
  if (!existing) {
    db.prepare('INSERT INTO company_leads (id, project_id, name, domain, address, source_type, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, name, domain, address, sourceType, 'discovered', 1, now, now);
    return { lead: db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(projectId, id), created: true, updated: false };
  }
  const changed = existing.name !== name || (existing.domain || null) !== domain || (existing.address || null) !== address;
  if (!changed) return { lead: existing, created: false, updated: false };
  const result = db.prepare('UPDATE company_leads SET name = ?, domain = ?, address = ?, updated_at = ?, version = version + 1 WHERE project_id = ? AND id = ? AND version = ?')
    .run(name, domain, address, now, projectId, id, existing.version);
  if (result.changes !== 1) throw companyError('write_conflict', `company lead ${id} changed concurrently (fail-closed)`);
  return { lead: db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(projectId, id), created: false, updated: true };
}

function persistPageEvidence(db, projectId, capture, source) {
  const licenseNote = `${sourceVersionLabel(source)}; synthetic-only; observedAtKnown=${capture.timeKnown === true}`;
  return evidence.recordDeclaredEvidence(db, projectId, {
    sha256: capture.sha256,
    sourceType: 'page',
    importBasis: `synthetic-association-directory ${source.version} (fixture; never live)`,
    url: capture.url,
    licenseNote,
    observedAt: capture.timeKnown ? capture.observedAt : undefined
  });
}

function recordAdaptationObservation(db, projectId, input) {
  return evidence.createObservation(db, projectId, {
    subjectType: 'company_lead',
    subjectId: input.leadId,
    key: `adaptation.${input.dimension}`,
    value: input.claimText,
    originType: 'seller_statement',
    approvalStatus: 'unreviewed',
    observedAt: input.observedAt,
    evidenceId: input.evidenceId || undefined
  });
}

function recordContactCitation(db, projectId, input) {
  return evidence.createObservation(db, projectId, {
    subjectType: 'company_lead',
    subjectId: input.leadId,
    key: 'contact.citation',
    value: `source_cited (not verified): ${input.citationText}`,
    originType: 'seller_statement',
    approvalStatus: 'unreviewed',
    observedAt: input.observedAt,
    evidenceId: input.evidenceId || undefined
  });
}

function recordStatusAudit(db, projectId, input) {
  return evidence.createObservation(db, projectId, {
    subjectType: 'company_lead',
    subjectId: input.leadId,
    key: 'status.transition',
    value: JSON.stringify({ from: input.from, to: input.to, reason: input.reason, version: input.version, evidenceRefs: uniqueSorted(input.evidenceRefs), rulesVersion: COMPANIES_RULES_VERSION }),
    originType: 'model_inference',
    approvalStatus: 'unreviewed',
    observedAt: input.at
  });
}

/**
 * Guarded status transition. Illegal skips/rollbacks, stale expectedVersion, missing/invalid
 * evidence, rejected evidence and positive determinations with unknown-time claims are refused
 * with explicit codes; a successful transition bumps the version under a WHERE version guard and
 * writes a reopenable audit observation.
 */
function transitionCompanyLead(db, projectId, input) {
  const leadId = requireNonEmptyString(input.leadId, 'leadId');
  const toStatus = requireNonEmptyString(input.toStatus, 'toStatus');
  const reason = requireNonEmptyString(input.reason, 'reason');
  const clock = typeof input.clock === 'function' ? input.clock : () => new Date().toISOString();
  const lead = db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(projectId, leadId);
  if (!lead) return { ok: false, code: 'lead_not_found' };
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== lead.version) {
    return { ok: false, code: 'version_conflict', detail: { current: lead.version, expected: input.expectedVersion ?? null } };
  }
  if (!COMPANY_STATUSES.includes(toStatus) || !STATUS_TRANSITIONS[lead.status].includes(toStatus)) {
    return { ok: false, code: 'invalid_transition', detail: { from: lead.status, to: toStatus } };
  }
  const unknownTimeClaims = Array.isArray(input.unknownTimeClaims) ? input.unknownTimeClaims : [];
  if (unknownTimeClaims.length > 0) return { ok: false, code: 'needs_review_time_unknown', detail: { dimensions: uniqueSorted(unknownTimeClaims) } };
  // DB-truth validation: caller labels are never trusted — the actual observation key, subject,
  // project, supersede/rejected state, observed time freshness and the linked source evidence are
  // re-read from the database; one observation row can never cover several dimensions and a
  // contact citation can never prove an adaptation dimension.
  const asOf = clock();
  const allowedDimensions = [...ADAPTATION_DIMENSIONS, 'contact_citation'];
  const checked = [];
  const seenObservationIds = new Set();
  for (const entry of Array.isArray(input.dimensions) ? input.dimensions : []) {
    const dimension = entry ? entry.dimension : null;
    if (!allowedDimensions.includes(dimension)) return { ok: false, code: 'evidence_invalid', detail: { dimension: dimension ?? null, reason: 'unknown_dimension' } };
    const observation = entry && entry.observationId ? evidence.getObservation(db, projectId, entry.observationId) : null;
    if (!observation || observation.subject_type !== 'company_lead' || observation.subject_id !== leadId || observation.superseded_by !== null) {
      return { ok: false, code: 'evidence_invalid', detail: { dimension, reason: 'observation_missing_or_foreign' } };
    }
    if (observation.approval_status === 'rejected') return { ok: false, code: 'evidence_invalid', detail: { dimension, approvalStatus: 'rejected' } };
    const expectedKey = dimension === 'contact_citation' ? 'contact.citation' : `adaptation.${dimension}`;
    if (observation.key !== expectedKey) return { ok: false, code: 'evidence_invalid', detail: { dimension, reason: 'observation_key_mismatch', actualKey: observation.key, expectedKey } };
    if (dimension === 'contact_citation' && toStatus !== 'contact_candidate') {
      return { ok: false, code: 'evidence_invalid', detail: { dimension, reason: 'contact_citation_cannot_prove_adaptation' } };
    }
    if (seenObservationIds.has(observation.id)) return { ok: false, code: 'evidence_invalid', detail: { dimension, reason: 'observation_reused_across_dimensions' } };
    seenObservationIds.add(observation.id);
    if (!observation.evidence_id) return { ok: false, code: 'evidence_invalid', detail: { dimension, reason: 'source_evidence_missing' } };
    if (!evidence.getEvidence(db, projectId, observation.evidence_id)) return { ok: false, code: 'evidence_invalid', detail: { dimension, reason: 'source_evidence_not_found' } };
    if (evidence.observationFreshness(observation, asOf).expired) return { ok: false, code: 'evidence_invalid', detail: { dimension, reason: 'observation_expired' } };
    checked.push({ dimension, observationId: observation.id, key: observation.key, evidenceId: observation.evidence_id });
  }
  const adaptationEntries = checked.filter((entry) => entry.dimension !== 'contact_citation');
  if (toStatus === 'screened' && adaptationEntries.length === 0) return { ok: false, code: 'evidence_missing', detail: { toStatus } };
  if (toStatus === 'qualified') {
    const requiredDimensions = uniqueSorted(input.requiredDimensions || []);
    if (requiredDimensions.length === 0 || requiredDimensions.some((dimension) => !ADAPTATION_DIMENSIONS.includes(dimension))) {
      return { ok: false, code: 'evidence_missing', detail: { requiredDimensions, reason: 'required_dimensions_must_cover_trusted_adaptation_dimensions' } };
    }
    const covered = new Set(adaptationEntries.map((entry) => entry.dimension));
    const missing = requiredDimensions.filter((dimension) => !covered.has(dimension));
    if (missing.length > 0) return { ok: false, code: 'evidence_missing', detail: { missing } };
  }
  if (toStatus === 'contact_candidate' && !checked.some((entry) => entry.dimension === 'contact_citation')) {
    return { ok: false, code: 'evidence_missing', detail: { need: 'contact.citation' } };
  }
  const now = clock();
  const result = db.prepare('UPDATE company_leads SET status = ?, version = version + 1, updated_at = ? WHERE project_id = ? AND id = ? AND version = ?')
    .run(toStatus, now, projectId, leadId, lead.version);
  if (result.changes !== 1) return { ok: false, code: 'write_conflict' };
  const updated = db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(projectId, leadId);
  const audit = recordStatusAudit(db, projectId, { leadId, from: lead.status, to: toStatus, reason, version: updated.version, evidenceRefs: checked.map((entry) => entry.observationId), at: now });
  return { ok: true, lead: updated, auditObservationId: audit.id };
}

// ---------- H. brand/market-scoped private metadata snapshot (exact string binding) ----------

function scopeToken(value) { return sha256Hex(String(value)).slice(0, 16); }
function snapshotScopeDir(metaRoot, { projectId, brand, market }) {
  return worker.resolveScoped(metaRoot, ['companies', `p_${scopeToken(projectId)}`, `b_${scopeToken(brand)}`, `m_${scopeToken(market)}`], 'companies snapshot scope');
}
function profileHashOf(profile) { return sha256Hex(canonicalJson(profile)).slice(0, 16); }
function scopeStatePath(metaRoot, { projectId, brand, market }) {
  return path.join(snapshotScopeDir(metaRoot, { projectId, brand, market }), 'scope-state.json');
}

/** Reads the scope-level qualification state only for the EXACT project/brand/market strings. */
function readCompanyScopeState({ metaRoot, projectId, brand, market }) {
  const file = scopeStatePath(metaRoot, { projectId, brand, market });
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.projectId !== projectId || state.brand !== brand || state.market !== market) {
    throw companyError('snapshot_scope_mismatch', 'scope-state manifest does not match the requested exact scope');
  }
  return state;
}

/**
 * brand/market/profile-scoped qualification state. The project-shared legal entity keeps its
 * project-neutral administrative state (company_leads), but a qualification is only ever decided
 * from evidence inside the CURRENT scope/profile: it is persisted here with its own version and
 * audit history, never inherited from another brand/market (the empty brand is a real scope).
 */
function updateCompanyScopeState({ metaRoot, runId, projectId, brand, market, rulesVersion, profile, source, entities, clock }) {
  const file = scopeStatePath(metaRoot, { projectId, brand, market });
  const existing = readCompanyScopeState({ metaRoot, projectId, brand, market });
  const currentProfileHash = profileHashOf(profile);
  const perCompany = { ...(existing ? existing.perCompany : {}) };
  const changes = [];
  const rank = { discovered: 0, screened: 1, qualified: 2 };
  for (const entity of entities) {
    const previous = perCompany[entity.entityKey] || null;
    const matched = entity.adaptation.matchedDimensions;
    const required = entity.adaptation.dimensions.filter((entry) => entry.required).map((entry) => entry.dimension);
    const unknownTime = entity.adaptation.unknownTimeDimensions;
    const negated = entity.adaptation.negatedDimensions;
    const currentEvidenceRefs = uniqueSorted(entity.adaptation.dimensions.flatMap((entry) => entry.matchedClaims.map((claim) => claim.sha256).filter(Boolean))).slice(0, 20);
    const negatedEvidenceRefs = uniqueSorted(entity.adaptation.dimensions.flatMap((entry) => entry.negatedClaims.map((claim) => claim.sha256).filter(Boolean))).slice(0, 20);
    // the CURRENT qualification is always recomputed from THIS run's evidence: a historical
    // qualification is never current support, and current negative/insufficient evidence can
    // never keep claiming a current qualified state
    let current;
    let reason;
    if (required.length === 0) {
      current = 'discovered';
      reason = 'no profile dimensions configured';
    } else if (matched.length > 0 && required.every((dimension) => matched.includes(dimension)) && unknownTime.length === 0) {
      current = 'qualified';
      reason = `all profile dimensions evidenced in scope ${currentProfileHash}`;
    } else if (matched.length > 0) {
      current = 'screened';
      reason = `partial current evidence in scope ${currentProfileHash}`;
    } else if (negated.length > 0) {
      current = 'needs_review';
      reason = `current evidence explicitly negative/ambiguous: ${negated.join(',')}`;
    } else {
      current = 'discovered';
      reason = unknownTime.length > 0 ? `current evidence has unknown-time claims only: ${unknownTime.join(',')}` : 'no current scope evidence';
    }
    const previousStage = previous ? (previous.historicalStage || previous.currentQualification || previous.status || 'discovered') : 'discovered';
    const historicalStage = rank[current] !== undefined && rank[current] > rank[previousStage] ? current : previousStage;
    const changed = !previous
      || (previous.currentQualification || previous.status) !== current
      || JSON.stringify(previous.currentEvidenceRefs || []) !== JSON.stringify(currentEvidenceRefs)
      || previous.profileHash !== currentProfileHash
      || previous.sourceVersion !== source.version
      || previous.rulesVersion !== rulesVersion;
    perCompany[entity.entityKey] = {
      status: current,
      currentQualification: current,
      historicalStage,
      needsReview: negated.length > 0 || unknownTime.length > 0,
      reason,
      profileHash: currentProfileHash,
      rulesVersion,
      sourceId: source.sourceId,
      sourceVersion: source.version,
      runId,
      updatedAt: clock(),
      version: previous ? previous.version + (changed ? 1 : 0) : 1,
      currentEvidenceRefs,
      negatedEvidenceRefs,
      historicalEvidenceRefs: previous ? (previous.historicalEvidenceRefs || previous.currentEvidenceRefs || []) : []
    };
    if (changed) {
      changes.push({
        entityKey: entity.entityKey,
        from: previous ? (previous.currentQualification || previous.status) : null,
        to: current,
        historicalStage,
        needsReview: perCompany[entity.entityKey].needsReview,
        reason,
        runId,
        at: clock()
      });
    }
  }
  const state = {
    schemaVersion: COMPANIES_SCHEMA_VERSION,
    kind: 't3.3_company_scope_state',
    projectId,
    brand,
    market,
    rulesVersion,
    profileHash: currentProfileHash,
    sourceId: source.sourceId,
    sourceVersion: source.version,
    version: (existing ? existing.version : 0) + 1,
    updatedAt: clock(),
    runId,
    perCompany,
    history: [...(existing && Array.isArray(existing.history) ? existing.history : []), ...changes].slice(-20)
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
  return state;
}

async function writeCompanySnapshot({ metaRoot, runId, projectId, brand, market, result, source, rules, clock, scopeState }) {
  const scopeDir = snapshotScopeDir(metaRoot, { projectId, brand, market });
  const dir = worker.resolveScoped(scopeDir, [worker.assertSafePathId(runId, 'runId')], 'companies snapshot run');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: COMPANIES_SCHEMA_VERSION,
    kind: 't3.3_company_snapshot',
    projectId,
    brand,
    market,
    runId,
    rulesVersion: rules.rulesVersion,
    sourceId: source.sourceId,
    sourceVersion: source.version,
    generatedAt: clock(),
    entities: result.entities.map((entity) => ({
      entityKey: entity.entityKey,
      name: entity.name,
      nameVariants: entity.nameVariants,
      domains: entity.domains,
      candidateDomains: entity.candidateDomains,
      canonicalDomainConfirmed: entity.canonicalDomainConfirmed,
      addresses: entity.addresses,
      legalIds: entity.legalIds,
      crossReferences: entity.crossReferences,
      officialSites: entity.officialSites,
      contactCitations: entity.contactCitations,
      provenance: entity.provenance,
      adaptation: entity.adaptation
    })),
    scopeState: scopeState ? { version: scopeState.version, profileHash: scopeState.profileHash, perCompany: scopeState.perCompany } : null,
    dedupe: { merges: result.dedupe.merges, suspected: result.dedupe.suspected },
    refusals: result.refusals,
    requests: result.requests,
    pages: result.pages
  };
  const file = path.join(dir, 'companies.json');
  const tmp = `${file}.tmp-${Date.now()}`;
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(tmp, text, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
  return { dir, path: file, sha256: sha256Hex(fs.readFileSync(file)), manifest };
}

/** Reads a snapshot only for the EXACT project/brand/market strings (empty brand is a value). */
function readCompanySnapshot({ metaRoot, runId, projectId, brand, market }) {
  const dir = worker.resolveScoped(snapshotScopeDir(metaRoot, { projectId, brand, market }), [worker.assertSafePathId(runId, 'runId')], 'companies snapshot run');
  const file = path.join(dir, 'companies.json');
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.projectId !== projectId || manifest.brand !== brand || manifest.market !== market) {
    throw companyError('snapshot_scope_mismatch', 'snapshot manifest scope does not match the requested exact scope');
  }
  return manifest;
}

// ---------- I. discovery pipeline ----------

/**
 * Per-execution-domain limiter registry: the trusted source/version + the transport object keep
 * the rate window AND the Retry-After cooldown high-water across separate discover calls, so a
 * re-entry cannot reset the deadline; a different source/version never shares it. Module-private —
 * the approved transport core is unchanged.
 */
const EXECUTION_LIMITERS = new WeakMap();
function limiterForExecution(transport, source, clock, sleep) {
  const sourceKey = sourceVersionLabel(source);
  const existing = EXECUTION_LIMITERS.get(transport);
  if (existing && existing.sourceKey === sourceKey) return existing.limiter;
  const limiter = createRateLimiter({ rateLimit: source.permit.rateLimit, clock: () => Date.parse(clock()), sleep });
  EXECUTION_LIMITERS.set(transport, { sourceKey, limiter });
  return limiter;
}

function resolveLimits(raw, rules) {
  const caps = rules.limits;
  const limits = {};
  for (const key of ['maxPages', 'maxCandidates', 'maxRequests', 'maxManualRecords']) {
    const value = raw && raw[key] !== undefined ? raw[key] : caps[key];
    if (!Number.isInteger(value) || value < 1 || value > caps[key]) throw companyError('validation', `limits.${key} must be an integer in [1, ${caps[key]}]`);
    limits[key] = value;
  }
  return limits;
}

const PROFILE_KEYS = Object.freeze({ category: 'categories', channel: 'channels', region: 'regions' });

function normalizeProfile(raw) {
  const profile = {};
  for (const dimension of ADAPTATION_DIMENSIONS) {
    const key = PROFILE_KEYS[dimension];
    const list = raw && Array.isArray(raw[key]) ? raw[key] : [];
    profile[dimension] = list.map((entry) => requireNonEmptyString(entry, `profile.${key}[]`));
    if (profile[dimension].length > 10) throw companyError('validation', `profile.${key} exceeds the bounded list`);
  }
  return profile;
}

function normalizeManualRecord(raw, { scope, rules }) {
  if (!isPlainObject(raw)) throw companyError('validation', 'manualRecords[] must be an object');
  const recordScope = raw.scope;
  const brand = !isPlainObject(recordScope) ? null : (recordScope.brand === null || recordScope.brand === undefined ? '' : recordScope.brand);
  if (!isPlainObject(recordScope) || recordScope.projectId !== scope.projectId || brand !== scope.brand || recordScope.market !== scope.market) {
    throw companyError('record_domain_mismatch', 'manual record scope does not match the authority domain (the empty brand is not a wildcard)');
  }
  const name = normalizeCompanyName(raw.name);
  if (name.original === '') throw companyError('validation', 'manual record name is required');
  const domain = raw.domain !== undefined && raw.domain !== null ? normalizeDomainValue(raw.domain) : null;
  const address = normalizeAddressValue(raw.address);
  const provenance = [];
  if (raw.provenance !== undefined && raw.provenance !== null) {
    if (!isPlainObject(raw.provenance)) throw companyError('validation', 'manualRecords[].provenance must be an object');
    const url = assertExternalCitationUrl(requireNonEmptyString(raw.provenance.url, 'manualRecords[].provenance.url')).url;
    const observed = raw.provenance.observedAt !== undefined && raw.provenance.observedAt !== null && raw.provenance.observedAt !== ''
      ? { known: true, value: requireIso(raw.provenance.observedAt, 'manualRecords[].provenance.observedAt') }
      : { known: false, value: null };
    provenance.push({
      url,
      sha256: raw.provenance.contentSha256 ? requireNonEmptyString(String(raw.provenance.contentSha256).toLowerCase(), 'contentSha256') : null,
      observedAt: observed.value,
      timeKnown: observed.known,
      sourceId: 'manual_import',
      sourceVersion: String(raw.provenance.sourceVersion || 'manual-v1')
    });
  }
  const claims = [];
  for (const dimension of ADAPTATION_DIMENSIONS) {
    const text = raw.claims && raw.claims[dimension];
    if (typeof text === 'string' && text.trim() !== '') {
      claims.push({ dimension, text: text.trim(), timeKnown: provenance.length > 0 && provenance[0].timeKnown === true, observedAt: provenance.length > 0 ? provenance[0].observedAt : null, pageUrl: provenance.length > 0 ? provenance[0].url : null, sha256: provenance.length > 0 ? provenance[0].sha256 : null });
    }
  }
  const crossReferences = Array.isArray(raw.crossReferences)
    ? uniqueSorted(raw.crossReferences.map((entry) => normalizeDomainValue(entry)).filter((entry) => entry && entry.normalizedHost).map((entry) => entry.normalizedHost))
    : [];
  const recordId = `manual:${sha256Hex(`${name.normalized}|${domain && domain.normalizedHost ? domain.normalizedHost : ''}|${address.normalized || ''}`).slice(0, 16)}`;
  return { recordId, name, domain, address, officialSite: domain ? { url: domain.original, host: domain.normalizedHost, unvisited: true } : null, legalId: raw.legalId ? String(raw.legalId).trim() : null, crossReferences, claims, provenance, contactCitation: null, manual: true };
}

function recordFromPage({ entry, parsed, capture, directoryCapture, source }) {
  const name = normalizeCompanyName(parsed.name || entry.name);
  const domain = parsed.officialSite ? normalizeDomainValue(parsed.officialSite.url) : null;
  const address = normalizeAddressValue(parsed.address);
  const claims = [];
  for (const [dimension, text] of [['category', parsed.category], ['channel', parsed.channel], ['region', parsed.region]]) {
    if (typeof text === 'string' && text.trim() !== '') {
      claims.push({ dimension, text: text.trim(), timeKnown: capture.timeKnown === true, observedAt: capture.observedAt, pageUrl: capture.url, sha256: capture.sha256 });
    }
  }
  const provenance = [
    { url: capture.url, sha256: capture.sha256, observedAt: capture.observedAt, timeKnown: capture.timeKnown, sourceId: source.sourceId, sourceVersion: source.version, role: 'member_detail' },
    { url: directoryCapture.url, sha256: directoryCapture.sha256, observedAt: directoryCapture.observedAt, timeKnown: directoryCapture.timeKnown, sourceId: source.sourceId, sourceVersion: source.version, role: 'directory_index' }
  ];
  return {
    recordId: `page:${entry.slug}`,
    name,
    domain,
    address,
    officialSite: parsed.officialSite,
    legalId: parsed.legalId,
    crossReferences: parsed.crossReferences,
    claims,
    provenance,
    contactCitation: parsed.contactCitation ? { text: parsed.contactCitation, timeKnown: capture.timeKnown === true, observedAt: capture.observedAt, pageUrl: capture.url, sha256: capture.sha256 } : null,
    manual: false
  };
}

async function discoverCompanies({ source, transport, input, clock = () => new Date().toISOString(), rules = DEFAULT_COMPANY_RULES, sleep }) {
  if (!isPlainObject(input)) throw companyError('validation', 'input must be a plain object');
  const trustedSource = validateCompanySourceRegistration(source);
  const scope = input.scope;
  if (!isPlainObject(scope)) throw companyError('validation', 'scope must be a plain object');
  const projectId = requireNonEmptyString(scope.projectId, 'scope.projectId');
  const brand = scope.brand === null || scope.brand === undefined ? '' : scope.brand;
  if (typeof brand !== 'string') throw companyError('validation', 'scope.brand must be a string (empty is a value, not a wildcard)');
  const market = requireNonEmptyString(scope.market, 'scope.market');
  const limits = resolveLimits(input.limits, rules);
  const profile = normalizeProfile(input.profile);
  const startUrl = requireNonEmptyString(input.directory && input.directory.startUrl, 'directory.startUrl');
  const start = assertCompanyRequestUrl(startUrl, trustedSource);
  if (start.path !== '/directory') throw companyError('directory_start_invalid', 'directory.startUrl must be the registered /directory entry');
  if (!transport || typeof transport.fetch !== 'function') throw companyError('validation', 'a permission-gated transport is required');

  const limiter = limiterForExecution(transport, trustedSource, clock, sleep);
  const requests = { total: 0, decisions: [] };
  const refusals = [];
  const pages = [];
  // Per-attempt budget gate: EVERY real transport attempt (including retries inside
  // executeWithPolicy) consumes the same bounded discovery budget; independent from the rate
  // limiter/cooldown. A committed unknown timeout is never resent (executeWithPolicy returns
  // pending_reconcile after exactly one attempt).
  const budgetedTransport = {
    mode: 'budget_gated',
    fetch: async (request) => {
      if (requests.total >= limits.maxRequests) {
        return { decision: 'blocked', code: 'request_budget_exceeded', transportCalls: transport.calls ? transport.calls.length : 0 };
      }
      requests.total += 1;
      return transport.fetch(request);
    },
    calls: transport.calls || []
  };

  const fetchPage = async (request) => {
    const outcome = await executeWithPolicy({ transport: budgetedTransport, request, limiter });
    requests.decisions.push({ url: request.url, decision: outcome.decision, code: outcome.code || null });
    if (outcome.decision !== 'ok') {
      if (outcome.code === 'request_budget_exceeded') refusals.push({ code: 'request_budget_exceeded', url: request.url });
      return { ok: false, decision: outcome.decision, code: outcome.code || outcome.decision, outcome };
    }
    try {
      assertResponseSource(request, outcome.response, trustedSource);
    } catch (error) {
      refusals.push({ code: error.code, url: request.url });
      return { ok: false, decision: 'response_refused', code: error.code };
    }
    return { ok: true, body: String(outcome.response.body || ''), response: outcome.response };
  };

  const directoryRequest = buildDirectoryRequest(trustedSource, { page: 1 });
  const directoryPage = await fetchPage(directoryRequest);
  if (!directoryPage.ok) {
    const refusalDecision = ['blocked', 'rate_limited', 'pending_reconcile'].includes(directoryPage.decision);
    return { status: refusalDecision ? 'blocked' : 'failed', code: directoryPage.code, requests, refusals, pages: [], entities: [], dedupe: { merges: [], suspected: [] }, profile };
  }
  const directoryObserved = parseObservedAt(directoryPage.body);
  const directoryCapture = { url: directoryRequest.url, sha256: sha256Hex(directoryPage.body), observedAt: directoryObserved.value, timeKnown: directoryObserved.known, pageKind: 'directory' };
  pages.push(directoryCapture);
  const index = parseDirectoryIndex(directoryPage.body, { source: trustedSource });
  refusals.push(...index.refusals);
  const candidates = index.entries.slice(0, limits.maxCandidates);
  if (index.entries.length > limits.maxCandidates) refusals.push({ code: 'candidate_budget_exceeded', dropped: index.entries.length - limits.maxCandidates });

  const records = [];
  for (const entry of candidates) {
    const request = buildMemberRequest(trustedSource, entry.slug);
    const page = await fetchPage(request);
    if (!page.ok) {
      refusals.push({ code: 'member_page_unavailable', url: request.url, detail: page.code });
      continue;
    }
    const parsed = parseMemberPage(page.body, { source: trustedSource, url: request.url });
    if (parsed.officialRefusal) refusals.push({ ...parsed.officialRefusal, url: request.url });
    const capture = { url: request.url, sha256: parsed.sha256, observedAt: parsed.observedAt, timeKnown: parsed.timeKnown, pageKind: 'member' };
    pages.push(capture);
    if (normalizeCompanyName(parsed.name || entry.name).original === '') {
      refusals.push({ code: 'company_name_missing', url: request.url });
      continue;
    }
    records.push(recordFromPage({ entry, parsed, capture, directoryCapture, source: trustedSource }));
  }

  const manualRecords = Array.isArray(input.manualRecords) ? input.manualRecords : [];
  if (manualRecords.length > limits.maxManualRecords) throw companyError('validation', 'manualRecords exceeds the bounded limit');
  for (const raw of manualRecords) records.push(normalizeManualRecord(raw, { scope: { projectId, brand, market }, rules }));

  const dedupe = dedupeCompanyRecords(records);
  const entities = dedupe.entities.map((entity) => ({ ...entity, adaptation: evaluateCompanyAdaptation(entity, profile, rules) }));
  return { status: 'ok', code: null, requests, refusals, pages, entities, dedupe: { merges: dedupe.merges, suspected: dedupe.suspected }, profile };
}

// ---------- J. registered handler (T2.7 registry/orchestrator envelope) ----------

const COMPANY_INPUT_SCHEMA = {
  type: 'object',
  required: ['sourceId', 'scope', 'directory', 'profile'],
  additionalProperties: false,
  properties: {
    sourceId: { type: 'string', minLength: 1, maxLength: 120 },
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
    directory: {
      type: 'object',
      required: ['startUrl'],
      additionalProperties: false,
      properties: { startUrl: { type: 'string', minLength: 1, maxLength: 300 } }
    },
    profile: {
      type: 'object',
      additionalProperties: false,
      properties: {
        categories: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 60 } },
        channels: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 60 } },
        regions: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 60 } }
      }
    },
    manualRecords: { type: 'array', maxItems: 12, items: { type: 'object', properties: {}, additionalProperties: true } },
    limits: { type: 'object', properties: {}, additionalProperties: true }
  }
};

const COMPANY_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['companies', 'dedupe', 'snapshot'],
  additionalProperties: false,
  properties: {
    companies: { type: 'array', maxItems: 50, items: { type: 'object', properties: {}, additionalProperties: true } },
    dedupe: { type: 'object', properties: {}, additionalProperties: true },
    refusals: { type: 'array', maxItems: 100, items: { type: 'object', properties: {}, additionalProperties: true } },
    snapshot: {
      type: 'object',
      required: ['path', 'sha256'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 500 },
        sha256: { type: 'string', minLength: 64, maxLength: 64 },
        scope: { type: 'object', properties: {}, additionalProperties: true },
        runId: { type: 'string', minLength: 1, maxLength: 120 },
        scopeState: { type: 'object', properties: {}, additionalProperties: true }
      }
    },
    versions: { type: 'object', properties: {}, additionalProperties: true },
    requests: { type: 'object', properties: {}, additionalProperties: true }
  }
};

function createCompanyRegistration({ domain }) {
  if (!isPlainObject(domain)) throw companyError('validation', 'domain (trusted factory config) is required');
  const { db, metaRoot, fetchImpl, source, clock } = domain;
  if (!db || typeof db.prepare !== 'function') throw companyError('validation', 'domain.db (trusted SQLite handle) is required');
  requireNonEmptyString(metaRoot, 'domain.metaRoot');
  if (typeof fetchImpl !== 'function') throw companyError('validation', 'domain.fetchImpl is required');
  const trustedSource = validateCompanySourceRegistration(source);
  const now = typeof clock === 'function' ? clock : () => new Date().toISOString();
  const transport = createPermissionGatedApiTransport({ source: trustedSource, fetchImpl, capability: 'fixture', now });
  const rules = DEFAULT_COMPANY_RULES;
  const tool = {
    name: COMPANY_TOOL_NAME,
    version: COMPANY_TOOL_VERSION,
    roles: [COMPANY_ROLE],
    kind: 'local',
    inputSchema: COMPANY_INPUT_SCHEMA,
    outputSchema: COMPANY_OUTPUT_SCHEMA,
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
    if (input.sourceId !== trustedSource.sourceId) return { status: 'blocked', reason: 'source_not_trusted' };
    const runId = typeof ctx.runId === 'string' && ctx.runId !== '' ? ctx.runId : null;
    if (runId === null) return { status: 'blocked', reason: 'run_id_missing' };

    let result;
    try {
      result = await discoverCompanies({ source: trustedSource, transport, input, clock: now });
    } catch (error) {
      if (error instanceof CompanyError) return { status: 'blocked', reason: `invalid_input:${error.code}` };
      throw error;
    }
    if (result.status !== 'ok') return { status: 'blocked', reason: result.code || result.status };

    const evidenceByUrl = new Map();
    for (const page of result.pages) {
      const row = persistPageEvidence(db, project, page, trustedSource);
      evidenceByUrl.set(page.url, row);
    }
    const companies = [];
    for (const entity of result.entities) {
      const { lead, created, updated } = upsertCompanyLead(db, project, entity, { clock: now });
      const dimensionEntries = [];
      const matchedEntries = [];
      for (const dimension of entity.adaptation.dimensions) {
        for (const claim of dimension.matchedClaims) {
          const pageEvidence = evidenceByUrl.get(claim.pageUrl) || null;
          const observation = recordAdaptationObservation(db, project, {
            leadId: lead.id,
            dimension: dimension.dimension,
            claimText: claim.claimText,
            evidenceId: pageEvidence ? pageEvidence.id : null,
            observedAt: claim.observedAt
          });
          dimensionEntries.push({ dimension: dimension.dimension, observationId: observation.id });
          matchedEntries.push({ dimension: dimension.dimension, observationId: observation.id });
        }
      }
      if (entity.contactCitations.length > 0 && entity.contactCitations[0].timeKnown) {
        const citation = entity.contactCitations[0];
        const pageEvidence = evidenceByUrl.get(citation.pageUrl) || null;
        recordContactCitation(db, project, { leadId: lead.id, citationText: citation.text, evidenceId: pageEvidence ? pageEvidence.id : null, observedAt: citation.observedAt });
      }
      const requiredDimensions = entity.adaptation.dimensions.filter((entry) => entry.required).map((entry) => entry.dimension);
      const unknownTimeDimensions = entity.adaptation.unknownTimeDimensions;
      let status = lead.status;
      let version = lead.version;
      if (status === 'discovered' && matchedEntries.length > 0) {
        const screened = transitionCompanyLead(db, project, {
          leadId: lead.id,
          expectedVersion: version,
          toStatus: 'screened',
          reason: `adaptation evidence matched: ${uniqueSorted(matchedEntries.map((entry) => entry.dimension)).join(',')}`,
          dimensions: matchedEntries,
          requiredDimensions,
          unknownTimeClaims: unknownTimeDimensions,
          clock: now
        });
        if (screened.ok) {
          status = screened.lead.status;
          version = screened.lead.version;
          const covered = new Set(matchedEntries.map((entry) => entry.dimension));
          if (requiredDimensions.length > 0 && requiredDimensions.every((dimension) => covered.has(dimension)) && unknownTimeDimensions.length === 0) {
            const qualified = transitionCompanyLead(db, project, {
              leadId: lead.id,
              expectedVersion: version,
              toStatus: 'qualified',
              reason: `all profile dimensions evidenced: ${requiredDimensions.join(',')}`,
              dimensions: matchedEntries,
              requiredDimensions,
              clock: now
            });
            if (qualified.ok) { status = qualified.lead.status; version = qualified.lead.version; }
          }
        }
      }
      companies.push({
        entityKey: entity.entityKey,
        leadId: lead.id,
        name: entity.name,
        domains: entity.domains,
        candidateDomains: entity.candidateDomains,
        administrativeStatus: status,
        administrativeVersion: version,
        created,
        updated,
        adaptation: {
          matchedDimensions: entity.adaptation.matchedDimensions,
          missingDimensions: entity.adaptation.missingDimensions,
          unknownTimeDimensions: entity.adaptation.unknownTimeDimensions,
          negatedDimensions: entity.adaptation.negatedDimensions
        },
        provenanceCount: entity.provenance.length,
        suspectedDuplicates: result.dedupe.suspected.filter((pair) => pair.left === entity.entityKey || pair.right === entity.entityKey).length
      });
    }
    const scopeState = updateCompanyScopeState({
      metaRoot, runId, projectId: project, brand, market,
      rulesVersion: rules.rulesVersion, profile: result.profile, source: trustedSource, entities: result.entities, clock: now
    });
    const scopeCompanies = companies.map((entry) => {
      const scope = scopeState.perCompany[entry.entityKey] || null;
      return {
        ...entry,
        status: scope ? scope.status : 'discovered',
        scopeStatusVersion: scope ? scope.version : 1,
        historicalStage: scope ? scope.historicalStage : 'discovered',
        needsReview: scope ? scope.needsReview === true : false,
        scopeReason: scope ? scope.reason : 'no scope state'
      };
    });
    const snapshot = await writeCompanySnapshot({ metaRoot, runId, projectId: project, brand, market, result, source: trustedSource, rules, clock: now, scopeState });
    return {
      status: 'succeeded',
      output: {
        companies: scopeCompanies,
        dedupe: { entityCount: result.entities.length, merges: result.dedupe.merges, suspected: result.dedupe.suspected },
        refusals: result.refusals,
        snapshot: {
          path: snapshot.path,
          sha256: snapshot.sha256,
          scope: { projectId: project, brand, market },
          runId,
          scopeState: { version: scopeState.version, profileHash: scopeState.profileHash }
        },
        versions: { rulesVersion: rules.rulesVersion, schemaVersion: COMPANIES_SCHEMA_VERSION, sourceId: trustedSource.sourceId, sourceVersion: trustedSource.version, profileHash: scopeState.profileHash },
        requests: result.requests
      }
    };
  }
  return { tool, handler };
}

// ---------- K. T3.4 contact provenance, verification levels and sales events (record only) ----------

const CONTACT_LEVELS = Object.freeze(['unverified', 'source_cited', 'verified']);
const CONTACT_TYPES = Object.freeze(['email', 'phone', 'address', 'contact_form', 'other']);
const CONTACT_SOURCE_KINDS = Object.freeze(['official', 'third_party']);
const CONTACT_VERIFICATION_METHODS = Object.freeze(['synthetic_receipt']);
const CONTACT_VERIFICATION_STATUSES = Object.freeze(['valid', 'revoked']);
const SALES_STAGES = Object.freeze(['contact_candidate', 'contacted', 'replied', 'sampled', 'quoted', 'won', 'lost']);
/** Minimal declared graph: no skips, no rollbacks, won/lost are terminal (never revived). */
const SALES_TRANSITIONS = Object.freeze({
  contact_candidate: Object.freeze(['contacted', 'lost']),
  contacted: Object.freeze(['replied', 'lost']),
  replied: Object.freeze(['sampled', 'lost']),
  sampled: Object.freeze(['quoted', 'lost']),
  quoted: Object.freeze(['won', 'lost']),
  won: Object.freeze([]),
  lost: Object.freeze([])
});
const SALES_TERMINAL_STAGES = Object.freeze(['won', 'lost']);
const DEAL_KINDS = Object.freeze(['contract', 'order', 'deal']);
const DEAL_OPEN_STATUSES = Object.freeze(['active', 'completed']);
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEAL_ID_RE = /^[A-Z0-9][A-Z0-9._-]{5,60}$/;
const SALES_EVENT_KEY = 'sales.event';
const CONTACT_OBSERVATION_PREFIX = 'contact.';
const CONTACT_VERIFICATION_KEY = 'contact.verification';
const OUTREACH_DRAFT_FORBIDDEN = Object.freeze([
  /\b(we|i)\s+(already\s+)?(sent|emailed|contacted|reached\s+out)/i,
  /\byou\s+(replied|responded|confirmed|ordered|purchased)\b/i,
  /\border\s+(confirmed|placed|received)\b/i,
  /\bdeal\s+(closed|won|signed)\b/i,
  /\bintent\s+to\s+(buy|purchase)\b/i,
  /\bguaranteed\s+(sales|orders)\b/i
]);

function sourceDomainOf(url) {
  try { return parseUrlBasics(url).host; } catch { return null; }
}

function contactIdFor({ projectId, brand, market, leadId, contactType, value }) {
  return `ct_${sha256Hex(`${projectId}|${brand}|${market}|${leadId}|${contactType}|${normalizeValue(value || '')}`).slice(0, 20)}`;
}

/**
 * Contact record: lead/project/brand/market, type, raw private value, source URL / observation
 * time known-or-unknown, official/third_party source kind, content hash and evidence reference,
 * review attributes and a record version. The value is never guessed: an unknown email stays
 * empty. The verification LEVEL is never taken from the caller — it is derived at read time by
 * classifyContactLevel from the reopenable verification records.
 */
function buildContactRecord(input) {
  if (!isPlainObject(input)) throw companyError('validation', 'contact must be a plain object');
  const projectId = requireNonEmptyString(input.projectId, 'contact.projectId');
  const leadId = requireNonEmptyString(input.leadId, 'contact.leadId');
  const brand = input.brand === null || input.brand === undefined ? '' : input.brand;
  if (typeof brand !== 'string') throw companyError('validation', 'contact.brand must be a string (empty is a value)');
  const market = requireNonEmptyString(input.market, 'contact.market');
  const contactType = requireNonEmptyString(input.contactType, 'contact.contactType');
  if (!CONTACT_TYPES.includes(contactType)) throw companyError('validation', `contact.contactType must be one of ${CONTACT_TYPES.join(', ')}`);
  const rawValue = input.value === null || input.value === undefined ? '' : String(input.value).trim();
  const valuePresent = rawValue !== '';
  if (contactType === 'email' && valuePresent && !EMAIL_SHAPE_RE.test(rawValue)) {
    throw companyError('contact_email_shape_invalid', 'email value must be syntactically shaped or empty (syntax is not verification)');
  }
  const sourceUrl = input.sourceUrl === undefined || input.sourceUrl === null || String(input.sourceUrl).trim() === '' ? null : String(input.sourceUrl).trim();
  let sourceDomain = null;
  if (sourceUrl !== null) {
    const parsed = parseUrlBasics(sourceUrl);
    if (parsed.protocol !== 'https:') throw companyError('url_protocol_not_allowed', 'contact sourceUrl must be https');
    sourceDomain = parsed.host;
  }
  const observed = input.observedAt === undefined || input.observedAt === null || input.observedAt === '' ? { known: false, value: null } : { known: true, value: requireIso(input.observedAt, 'contact.observedAt') };
  const sourceKind = input.sourceKind === undefined || input.sourceKind === null || input.sourceKind === '' ? null : requireNonEmptyString(input.sourceKind, 'contact.sourceKind');
  if (sourceKind !== null && !CONTACT_SOURCE_KINDS.includes(sourceKind)) throw companyError('validation', `contact.sourceKind must be one of ${CONTACT_SOURCE_KINDS.join(', ')}`);
  const contentSha256 = input.contentSha256 === undefined || input.contentSha256 === null || input.contentSha256 === '' ? null : String(input.contentSha256).toLowerCase();
  if (contentSha256 !== null && !SHA256_RE.test(contentSha256)) throw companyError('validation', 'contact.contentSha256 must be a 64-character hex digest');
  const evidenceRef = input.evidenceRef === undefined || input.evidenceRef === null || input.evidenceRef === '' ? null : String(input.evidenceRef).trim();
  const note = input.note === undefined || input.note === null ? '' : String(input.note);
  return {
    schemaVersion: COMPANIES_SCHEMA_VERSION,
    contactId: contactIdFor({ projectId, brand, market, leadId, contactType, value: rawValue }),
    projectId,
    brand,
    market,
    leadId,
    contactType,
    value: rawValue,
    valuePresent,
    sourceUrl,
    sourceDomain,
    observedAt: observed.value,
    timeKnown: observed.known,
    sourceKind,
    contentSha256,
    evidenceRef,
    note,
    reviewStatus: 'unreviewed',
    version: 1
  };
}

/**
 * Verification levels (derived, never caller-claimed):
 * - verified: a reopenable verification record bound to THIS contact, the same exact brand/market
 *   scope, a permitted method, the same subject domain and a non-expired 'valid' status.
 * - source_cited: a present value with a cited source (URL + kind + content hash) — a citation,
 *   not a deliverability proof.
 * - unverified: everything else (an unknown value is never guessed from the company domain).
 */
function classifyContactLevel(record, verifications, options = {}) {
  const asOf = options.asOf || new Date().toISOString();
  const candidates = (Array.isArray(verifications) ? verifications : [])
    .filter((entry) => entry && entry.contactId === record.contactId
      && entry.brand === record.brand && entry.market === record.market
      && CONTACT_VERIFICATION_METHODS.includes(entry.method)
      && entry.subjectDomain === record.sourceDomain
      && CONTACT_VERIFICATION_STATUSES.includes(entry.status)
      && (entry.expiresAt === undefined || entry.expiresAt === null || String(entry.expiresAt) > asOf))
    .sort((a, b) => compareStrings(`${a.verifiedAt}|${a.recordedAt || ''}|${a.observationId || ''}`, `${b.verifiedAt}|${b.recordedAt || ''}|${b.observationId || ''}`));
  const latest = candidates.length > 0 ? candidates[candidates.length - 1] : null;
  if (latest && latest.status === 'valid') {
    return { level: 'verified', reason: `reopenable ${latest.method} verification (${latest.reference}) for ${latest.subjectDomain}` };
  }
  if (record.valuePresent && record.sourceUrl && record.sourceKind && record.contentSha256) {
    return { level: 'source_cited', reason: `cited ${record.sourceKind} source; syntax/listing is not a deliverability verification` };
  }
  return { level: 'unverified', reason: record.valuePresent ? 'value present but no cited source record' : 'value unknown; never guessed from the company domain' };
}

/** Insertion-ordered lead observations (rowid sequence) — event/verification order never depends
 *  on timestamp ties or random ids. */
function listLeadObservations(db, projectId, leadId) {
  return db.prepare('SELECT rowid AS seq, * FROM observations WHERE project_id = ? AND subject_id = ? AND superseded_by IS NULL ORDER BY seq').all(projectId, leadId);
}

/** Exact scope match for a stored record: brand/market must both be the runner's real values; a
 *  record without scope information never matches a specific scope (no wildcard, no backfill). */
function recordMatchesScope(record, scope) {
  if (scope === null || scope === undefined) return true; // trusted-operator/diagnostic read
  const brand = scope.brand === null || scope.brand === undefined ? '' : scope.brand;
  return record.brand === brand && record.market === scope.market;
}

function listContacts(db, projectId, leadId, scope = null) {
  return listLeadObservations(db, projectId, leadId)
    .filter((row) => row.key.startsWith(CONTACT_OBSERVATION_PREFIX) && row.key !== CONTACT_VERIFICATION_KEY)
    .map((row) => { try { const record = JSON.parse(row.value_text); record.observationId = row.id; return record; } catch { return null; } })
    .filter((record) => record !== null && recordMatchesScope(record, scope));
}

function listContactVerifications(db, projectId, leadId, scope = null) {
  return listLeadObservations(db, projectId, leadId)
    .filter((row) => row.key === CONTACT_VERIFICATION_KEY)
    .map((row) => { try { const record = JSON.parse(row.value_text); record.observationId = row.id; record.recordedAt = row.created_at; return record; } catch { return null; } })
    .filter((record) => record !== null && recordMatchesScope(record, scope));
}

/** Upsert one contact record: identical content is reused; changed content inserts the new version
 *  and supersedes the old row in one guarded UPDATE. If the guard fails the new row is removed
 *  again (compensating delete), so the store never ends in a half state. */
function recordContact(db, projectId, { record, clock }) {
  const existing = listContacts(db, projectId, record.leadId).find((entry) => entry.contactId === record.contactId) || null;
  if (existing) {
    const sameContent = existing.value === record.value
      && existing.sourceUrl === record.sourceUrl
      && existing.sourceKind === record.sourceKind
      && existing.contentSha256 === record.contentSha256
      && existing.observedAt === record.observedAt;
    if (sameContent) return { record: existing, created: false, updated: false, observationId: existing.observationId };
    const nextVersion = existing.version + 1;
    const replacement = evidence.createObservation(db, projectId, {
      subjectType: 'company_lead', subjectId: record.leadId, key: `${CONTACT_OBSERVATION_PREFIX}${record.contactType}`,
      value: JSON.stringify({ ...record, version: nextVersion, recordedAt: clock() }),
      originType: 'seller_statement', approvalStatus: 'unreviewed', observedAt: clock(), evidenceId: record.evidenceRef || undefined
    });
    const superseded = db.prepare('UPDATE observations SET superseded_by = ? WHERE project_id = ? AND id = ? AND superseded_by IS NULL').run(replacement.id, projectId, existing.observationId);
    if (superseded.changes !== 1) {
      try { db.prepare('DELETE FROM observations WHERE project_id = ? AND id = ? AND superseded_by IS NULL').run(projectId, replacement.id); } catch { /* best-effort compensation */ }
      throw companyError('write_conflict', 'contact record changed concurrently (fail-closed)');
    }
    return { record: { ...record, version: nextVersion, observationId: replacement.id }, created: false, updated: true, observationId: replacement.id };
  }
  const row = evidence.createObservation(db, projectId, {
    subjectType: 'company_lead', subjectId: record.leadId, key: `${CONTACT_OBSERVATION_PREFIX}${record.contactType}`,
    value: JSON.stringify({ ...record, recordedAt: clock() }),
    originType: 'seller_statement', approvalStatus: 'unreviewed', observedAt: clock(), evidenceId: record.evidenceRef || undefined
  });
  return { record: { ...record, observationId: row.id }, created: true, updated: false, observationId: row.id };
}

/** Persists a bound verification record (see bindTrustedVerificationRecord — payload strings alone
 *  can never create verification authority). */
function recordContactVerification(db, projectId, { record, clock }) {
  return evidence.createObservation(db, projectId, {
    subjectType: 'company_lead', subjectId: record.leadId, key: CONTACT_VERIFICATION_KEY,
    value: JSON.stringify({ ...record, recordedAt: clock() }),
    originType: 'user_statement', approvalStatus: 'unreviewed', observedAt: clock()
  });
}

// ----- sales events (record only; no action is ever executed here) -----

function salesInitialState(leadId) {
  return { leadId, stage: 'contact_candidate', version: 1, reason: 'initial candidate stage (record only; never contacted by this module)', evidenceRefs: [], eventId: null, occurredAt: null, updatedAt: null, terminal: false };
}

function listSalesEvents(db, projectId, leadId, scope = null) {
  return listLeadObservations(db, projectId, leadId)
    .filter((row) => row.key === SALES_EVENT_KEY)
    .map((row) => { try { const value = JSON.parse(row.value_text); value.observationId = row.id; value.recordedAt = row.created_at; return value; } catch { return null; } })
    .filter((value) => value !== null && recordMatchesScope(value, scope));
}

function readSalesState(db, projectId, leadId, scope = null) {
  const events = listSalesEvents(db, projectId, leadId, scope);
  if (events.length === 0) return salesInitialState(leadId);
  const last = events[events.length - 1];
  return {
    leadId,
    stage: last.to,
    version: last.version,
    reason: last.reason,
    evidenceRefs: Array.isArray(last.evidenceRefs) ? last.evidenceRefs : [],
    eventId: last.eventId || null,
    occurredAt: last.occurredAt || null,
    updatedAt: last.at || null,
    terminal: SALES_TERMINAL_STAGES.includes(last.to)
  };
}

/** Resolves a pre-existing trusted record (factory-injected). Payload fields never authorize. */
function resolveTrustedRecord(trustedRecords, kind, recordId) {
  if (!isPlainObject(trustedRecords)) return null;
  const list = kind === 'deal' ? trustedRecords.deals : kind === 'verification' ? trustedRecords.verifications : trustedRecords.events;
  if (!Array.isArray(list)) return null;
  return list.find((entry) => isPlainObject(entry) && entry.recordId === recordId) || null;
}

/** Contact source evidence must reopen: a claimed content hash needs a real evidence row with the
 *  same hash and the same source host; a hash without a record is never a verified citation. */
function assertContactEvidence(db, projectId, record) {
  if (record.evidenceRef === null && record.contentSha256 === null) return { ok: true };
  if (record.evidenceRef === null) throw companyError('contact_evidence_missing', 'a content hash without a reopenable evidence record is not a citation');
  const row = evidence.getEvidence(db, projectId, record.evidenceRef);
  if (!row) throw companyError('contact_evidence_missing', 'contact.evidenceRef does not resolve to an evidence record in this project');
  if (record.contentSha256 !== null && String(row.sha256 || '').toLowerCase() !== record.contentSha256) {
    throw companyError('contact_evidence_hash_mismatch', 'contact.contentSha256 does not match the referenced evidence content');
  }
  if (record.sourceDomain !== null) {
    const rowDomain = row.url ? normalizeDomainValue(row.url) : null;
    if (!rowDomain || !rowDomain.normalizedHost || rowDomain.normalizedHost !== record.sourceDomain) {
      throw companyError('contact_source_mismatch', 'contact.sourceUrl is not on the referenced evidence host');
    }
  }
  return { ok: true };
}

/** Binds a trusted verification record to a built contact (exact project/lead/brand/market/type/
 *  value/subject domain binding). Without a trusted record the level never upgrades. */
function bindTrustedVerificationRecord({ trusted, contact, projectId, brand, market, leadId }) {
  if (!isPlainObject(trusted)) return { ok: false, code: 'verification_not_authorized' };
  if (trusted.projectId !== projectId || trusted.leadId !== leadId || trusted.brand !== brand || trusted.market !== market) return { ok: false, code: 'verification_scope_mismatch' };
  if (trusted.contactType !== contact.contactType || String(trusted.contactValue) !== String(contact.value)) return { ok: false, code: 'verification_contact_mismatch' };
  if (!CONTACT_VERIFICATION_METHODS.includes(trusted.method)) return { ok: false, code: 'verification_method_not_allowed' };
  if (trusted.subjectDomain !== contact.sourceDomain) return { ok: false, code: 'verification_subject_mismatch' };
  const status = trusted.status === undefined || trusted.status === null || trusted.status === '' ? 'valid' : String(trusted.status);
  if (!CONTACT_VERIFICATION_STATUSES.includes(status)) return { ok: false, code: 'verification_status_invalid' };
  if (typeof trusted.reference !== 'string' || trusted.reference.trim() === '') return { ok: false, code: 'verification_reference_missing' };
  const verifiedAt = requireIso(trusted.verifiedAt, 'trusted.verifiedAt');
  const expiresAt = trusted.expiresAt === undefined || trusted.expiresAt === null || trusted.expiresAt === '' ? null : requireIso(trusted.expiresAt, 'trusted.expiresAt');
  return {
    ok: true,
    record: {
      schemaVersion: COMPANIES_SCHEMA_VERSION,
      verificationId: trusted.recordId,
      projectId, brand, market, leadId,
      contactId: contact.contactId,
      method: trusted.method,
      subjectDomain: trusted.subjectDomain,
      reference: trusted.reference.trim(),
      verifiedAt,
      status,
      expiresAt,
      trustedRecordId: trusted.recordId
    }
  };
}

/**
 * Pure transition planner: validates the stage graph, expectedVersion, duplicate event ids and the
 * stage evidence against PRE-EXISTING trusted records (contact/reply/sample/quote events, history
 * confirmations and contract/order/deal records). Returns the audit row to persist; writes nothing.
 */
function planSalesTransition({ db, projectId, leadId, brand, market, lead, state, event, trustedRecords, clock }) {
  const toStage = requireNonEmptyString(event.toStage, 'toStage');
  const reason = requireNonEmptyString(event.reason, 'reason');
  const eventId = requireNonEmptyString(event.eventId, 'eventId');
  const current = state || readSalesState(db, projectId, leadId, { brand, market });
  if (!SALES_STAGES.includes(toStage) || !SALES_TRANSITIONS[current.stage].includes(toStage)) {
    return { ok: false, code: 'invalid_transition', detail: { from: current.stage, to: toStage } };
  }
  if (listSalesEvents(db, projectId, leadId, { brand, market }).some((entry) => entry.eventId === eventId)) {
    return { ok: false, code: 'duplicate_event', detail: { eventId } };
  }
  const evidenceRefs = [];
  const trustedEvent = (eventInput, expectedKind, code) => {
    if (!isPlainObject(eventInput) || typeof eventInput.recordId !== 'string' || eventInput.recordId.trim() === '') return { ok: false, code };
    const record = resolveTrustedRecord(trustedRecords, 'event', eventInput.recordId.trim());
    if (!record) return { ok: false, code, detail: { note: 'no pre-existing trusted record with this id; payload fields or an arbitrary page never authorize an occurred event' } };
    if (record.kind !== expectedKind) return { ok: false, code };
    if (record.projectId !== projectId || record.leadId !== leadId || record.brand !== brand || record.market !== market) return { ok: false, code: 'trusted_record_scope_mismatch' };
    if (typeof record.reference !== 'string' || record.reference.trim() === '' || typeof record.at !== 'string' || !ISO_RE.test(record.at) || Number.isNaN(Date.parse(record.at))) return { ok: false, code: 'trusted_record_invalid' };
    if (typeof record.evidenceRef !== 'string' || record.evidenceRef.trim() === '' || !evidence.getEvidence(db, projectId, record.evidenceRef.trim())) return { ok: false, code: 'trusted_record_evidence_missing' };
    evidenceRefs.push(record.evidenceRef.trim());
    return { ok: true, record };
  };
  if (toStage === 'contacted') {
    let checked;
    if (isPlainObject(event.occurredContact)) checked = trustedEvent(event.occurredContact, 'contact_event', 'contact_event_missing');
    else if (isPlainObject(event.userConfirmedHistory)) checked = trustedEvent(event.userConfirmedHistory, 'history_confirmation', 'contact_event_missing');
    else checked = { ok: false, code: 'contact_event_missing', detail: { note: 'contacted requires a pre-existing trusted occurred-contact or history-confirmation record; a draft or an arbitrary page never marks contacted' } };
    if (!checked.ok) return checked;
  }
  if (toStage === 'replied') {
    const checked = trustedEvent(event.replyRecord, 'reply', 'reply_record_missing');
    if (!checked.ok) return checked;
  }
  if (toStage === 'sampled') {
    const checked = trustedEvent(event.sampleRecord, 'sample', 'sample_record_missing');
    if (!checked.ok) return checked;
  }
  if (toStage === 'quoted') {
    const checked = trustedEvent(event.quoteRecord, 'quote', 'quote_record_missing');
    if (!checked.ok) return checked;
  }
  if (toStage === 'won') {
    if (!isPlainObject(event.dealRef) || typeof event.dealRef.recordId !== 'string' || event.dealRef.recordId.trim() === '') return { ok: false, code: 'deal_record_missing' };
    const deal = resolveTrustedRecord(trustedRecords, 'deal', event.dealRef.recordId.trim());
    if (!deal) return { ok: false, code: 'deal_record_missing', detail: { note: 'only a pre-existing trusted contract/order/deal record can mark won; caller kind/status/filename labels and ordinary pages never do' } };
    if (deal.projectId !== projectId || deal.leadId !== leadId || deal.brand !== brand || deal.market !== market) return { ok: false, code: 'trusted_record_scope_mismatch' };
    if (!DEAL_KINDS.includes(deal.kind)) return { ok: false, code: 'deal_kind_not_won', detail: { kind: deal.kind === undefined ? null : deal.kind } };
    if (!DEAL_OPEN_STATUSES.includes(deal.status)) return { ok: false, code: 'deal_status_not_won', detail: { status: deal.status === undefined ? null : deal.status } };
    if (typeof deal.dealId !== 'string' || !DEAL_ID_RE.test(deal.dealId)) return { ok: false, code: 'deal_id_invalid' };
    const leadDomain = lead && lead.domain ? normalizeDomainValue(lead.domain) : null;
    const dealDomain = typeof deal.domain === 'string' && deal.domain.trim() !== '' ? normalizeDomainValue(deal.domain) : null;
    if (!leadDomain || !leadDomain.normalizedHost || !dealDomain || !dealDomain.normalizedHost || dealDomain.normalizedHost !== leadDomain.normalizedHost) {
      return { ok: false, code: 'deal_domain_mismatch', detail: { leadDomain: lead ? lead.domain || null : null, dealDomain: deal.domain === undefined ? null : deal.domain } };
    }
    if (typeof deal.contentSha256 !== 'string' || !SHA256_RE.test(deal.contentSha256.toLowerCase())) return { ok: false, code: 'deal_evidence_mismatch' };
    if (typeof deal.recordedAt !== 'string' || !ISO_RE.test(deal.recordedAt) || Number.isNaN(Date.parse(deal.recordedAt))) return { ok: false, code: 'deal_evidence_mismatch' };
    const row = typeof deal.evidenceRef === 'string' && deal.evidenceRef.trim() !== '' ? evidence.getEvidence(db, projectId, deal.evidenceRef.trim()) : null;
    if (!row) return { ok: false, code: 'deal_evidence_mismatch', detail: { note: 'the linked record evidence must exist in this project' } };
    if (String(row.sha256 || '').toLowerCase() !== deal.contentSha256.toLowerCase()) return { ok: false, code: 'deal_evidence_mismatch', detail: { note: 'the linked evidence content hash does not match the trusted record' } };
    const rowDomain = row.url ? normalizeDomainValue(row.url) : null;
    if (!rowDomain || !rowDomain.normalizedHost || rowDomain.normalizedHost !== dealDomain.normalizedHost) return { ok: false, code: 'deal_domain_mismatch', detail: { note: 'the linked evidence is not on the deal domain' } };
    evidenceRefs.push(deal.evidenceRef.trim());
  }
  if (toStage === 'lost' && (typeof event.lostReason !== 'string' || event.lostReason.trim() === '')) {
    return { ok: false, code: 'lost_reason_missing' };
  }
  const nextVersion = current.version + 1;
  const at = clock();
  const occurredAt = typeof event.occurredAt === 'string' && ISO_RE.test(event.occurredAt) && !Number.isNaN(Date.parse(event.occurredAt)) ? event.occurredAt : at;
  const value = {
    eventId,
    from: current.stage,
    to: toStage,
    reason,
    version: nextVersion,
    brand,
    market,
    evidenceRefs: uniqueSorted(evidenceRefs),
    occurredAt,
    at,
    lostReason: toStage === 'lost' ? event.lostReason.trim() : null
  };
  return {
    ok: true,
    value,
    nextState: { leadId, stage: toStage, version: nextVersion, reason, evidenceRefs: value.evidenceRefs, eventId, occurredAt, updatedAt: at, terminal: SALES_TERMINAL_STAGES.includes(toStage) }
  };
}

/**
 * Guarded sales-stage transition (records only). Illegal skips/rollbacks, terminal revival, stale
 * expectedVersion, duplicate event ids and missing trusted stage evidence are refused with explicit
 * codes; the state change is a single atomic audit observation insert (no half state, zero change
 * on refusal). The T3.3 administrative stage and qualification state are never touched.
 */
function transitionSalesStage(db, projectId, input) {
  const leadId = requireNonEmptyString(input.leadId, 'leadId');
  const brand = input.brand === null || input.brand === undefined ? '' : input.brand;
  if (typeof brand !== 'string') throw companyError('validation', 'brand must be a string');
  const market = requireNonEmptyString(input.market, 'market');
  const clock = typeof input.clock === 'function' ? input.clock : () => new Date().toISOString();
  const lead = db.prepare('SELECT * FROM company_leads WHERE project_id = ? AND id = ?').get(projectId, leadId);
  if (!lead) return { ok: false, code: 'lead_not_found' };
  const current = readSalesState(db, projectId, leadId, { brand, market });
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== current.version) {
    return { ok: false, code: 'version_conflict', detail: { current: current.version, expected: input.expectedVersion === undefined ? null : input.expectedVersion } };
  }
  const planned = planSalesTransition({ db, projectId, leadId, brand, market, lead, state: current, event: input, trustedRecords: input.trustedRecords, clock });
  if (!planned.ok) return { ok: false, code: planned.code, detail: planned.detail };
  const row = evidence.createObservation(db, projectId, {
    subjectType: 'company_lead', subjectId: leadId, key: SALES_EVENT_KEY,
    value: JSON.stringify(planned.value), originType: 'model_inference', approvalStatus: 'unreviewed', observedAt: planned.value.at
  });
  return { ok: true, state: planned.nextState, auditObservationId: row.id };
}

// ----- atomic batch commit (business observations in ONE transaction) -----

const INSERT_LEAD_OBSERVATION_SQL = `INSERT INTO observations (id, project_id, evidence_id, origin_type, approval_status, key, value_text, unit, observed_at, ttl, ttl_seconds, expires_at, superseded_by, subject_type, subject_id, approval_changed_at, created_at)
  VALUES (@id, @project_id, @evidence_id, @origin_type, @approval_status, @key, @value_text, @unit, @observed_at, @ttl, @ttl_seconds, @expires_at, @superseded_by, @subject_type, @subject_id, @approval_changed_at, @created_at)`;

function leadObservationRow({ projectId, leadId, key, valueText, evidenceId, observedAt, originType }) {
  return {
    id: `ob_${crypto.randomUUID()}`,
    project_id: projectId,
    evidence_id: evidenceId === undefined || evidenceId === null || evidenceId === '' ? null : evidenceId,
    origin_type: originType,
    approval_status: 'unreviewed',
    key,
    value_text: valueText,
    unit: null,
    observed_at: observedAt,
    ttl: null,
    ttl_seconds: null,
    expires_at: null,
    superseded_by: null,
    subject_type: 'company_lead',
    subject_id: leadId,
    approval_changed_at: null,
    created_at: new Date().toISOString()
  };
}

/**
 * Commits a whole pre-validated batch (contact supersedes + contact/verification/event inserts) in
 * ONE transaction: any deterministic failure rolls back with zero business-state change. The batch
 * must be fully planned beforehand (see the T3.4 handler preflight).
 */
function commitLeadBatch(db, projectId, { supersedes = [], rows = [] }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // insert first: the superseded_by FK references the replacement observation, which must exist
    const statement = db.prepare(INSERT_LEAD_OBSERVATION_SQL);
    const inserted = [];
    for (const row of rows) {
      statement.run(row);
      inserted.push(row.id);
    }
    for (const pair of supersedes) {
      const updated = db.prepare('UPDATE observations SET superseded_by = ? WHERE project_id = ? AND id = ? AND superseded_by IS NULL').run(pair.replacementId, projectId, pair.oldId);
      if (updated.changes !== 1) throw companyError('write_conflict', 'contact record changed concurrently (fail-closed)');
    }
    db.exec('COMMIT');
    return { inserted };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

/**
 * Plans the contact writes for a batch (no writes): identical content reuses the existing row;
 * changed content plans a supersede + a new version row. Returns the rows to insert, the supersede
 * pairs and the prospective records (with their future observation ids).
 */
function planContactWrites(db, projectId, { contacts, leadId = null, brand, market, clock }) {
  const subjectLeadId = leadId || (contacts[0] ? contacts[0].leadId : '');
  const existingContacts = subjectLeadId === '' ? [] : listContacts(db, projectId, subjectLeadId, { brand, market });
  const rows = [];
  const supersedes = [];
  const prospective = [];
  for (const record of contacts) {
    const existing = existingContacts.find((entry) => entry.contactId === record.contactId) || null;
    const sameContent = existing
      && existing.value === record.value
      && existing.sourceUrl === record.sourceUrl
      && existing.sourceKind === record.sourceKind
      && existing.contentSha256 === record.contentSha256
      && existing.observedAt === record.observedAt;
    if (sameContent) {
      prospective.push(existing);
      continue;
    }
    const nextVersion = existing ? existing.version + 1 : 1;
    const stored = { ...record, version: nextVersion, recordedAt: clock() };
    const row = leadObservationRow({
      projectId, leadId: record.leadId, key: `${CONTACT_OBSERVATION_PREFIX}${record.contactType}`,
      valueText: JSON.stringify(stored), evidenceId: record.evidenceRef, observedAt: clock(), originType: 'seller_statement'
    });
    rows.push(row);
    if (existing) supersedes.push({ oldId: existing.observationId, replacementId: row.id });
    prospective.push({ ...stored, observationId: row.id });
  }
  return { rows, supersedes, prospective };
}

function planVerificationWrite({ projectId, leadId, record, clock }) {
  return leadObservationRow({
    projectId, leadId, key: CONTACT_VERIFICATION_KEY,
    valueText: JSON.stringify({ ...record, recordedAt: clock() }), observedAt: clock(), originType: 'user_statement'
  });
}

function planSalesEventWrite({ projectId, leadId, value, clock }) {
  return leadObservationRow({
    projectId, leadId, key: SALES_EVENT_KEY,
    valueText: JSON.stringify(value), observedAt: value.at, originType: 'model_inference'
  });
}

// ----- outreach draft (draft only; this module never sends) -----

/** English draft artifact. Wording that implies a sent message, a reply or a deal is refused, and
 *  every product claim must be an exact member of the allowed verifiable facts. */
function buildOutreachDraft(input) {
  if (!isPlainObject(input)) throw companyError('validation', 'draft must be a plain object');
  const language = input.language === undefined || input.language === null || input.language === '' ? 'en' : String(input.language);
  if (language !== 'en') throw companyError('draft_language_not_allowed', 'this round supports English drafts only');
  const leadName = requireNonEmptyString(input.leadName, 'draft.leadName');
  const subject = requireNonEmptyString(input.subject, 'draft.subject');
  const body = requireNonEmptyString(input.body, 'draft.body');
  const allowedClaims = Array.isArray(input.allowedClaims) ? input.allowedClaims.map((claim) => String(claim)) : [];
  const claims = Array.isArray(input.claims) ? input.claims.map((claim) => String(claim)) : [];
  for (const claim of claims) {
    if (!allowedClaims.includes(claim)) throw companyError('draft_claim_not_allowed', `claim ${JSON.stringify(claim.slice(0, 60))} is not an allowed verifiable fact`);
  }
  const text = `${subject}\n${body}`;
  for (const pattern of OUTREACH_DRAFT_FORBIDDEN) {
    if (pattern.test(text)) throw companyError('draft_overclaims', 'draft wording implies a sent message, a reply or a closed deal that has not happened');
  }
  return {
    schemaVersion: COMPANIES_SCHEMA_VERSION,
    kind: 't3.4_outreach_draft',
    status: 'draft',
    sent: false,
    language: 'en',
    leadName,
    subject,
    body,
    claims,
    signature: input.signature === undefined || input.signature === null ? null : String(input.signature)
  };
}

function writeOutreachDraft({ metaRoot, runId, projectId, brand, market, draft, clock }) {
  const dir = worker.resolveScoped(snapshotScopeDir(metaRoot, { projectId, brand, market }), ['drafts', worker.assertSafePathId(runId, 'runId')], 'outreach draft');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'outreach-draft.json');
  const payload = { ...draft, projectId, brand, market, runId, generatedAt: clock() };
  const tmp = `${file}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
  return { dir, path: file, sha256: sha256Hex(fs.readFileSync(file)) };
}

function registerCompanyHandler(registry, registration) {
  registry.register(registration.tool, registration.handler);
  return registry.get(registration.tool.name);
}

module.exports = {
  COMPANIES_SCHEMA_VERSION,
  COMPANIES_RULES_VERSION,
  COMPANY_TOOL_NAME,
  COMPANY_TOOL_VERSION,
  COMPANY_ROLE,
  COMPANY_STATUSES,
  STATUS_TRANSITIONS,
  ADAPTATION_DIMENSIONS,
  COMPANY_SOURCE_ID,
  DEFAULT_COMPANY_RULES,
  CompanyError,
  companyError,
  syntheticDirectorySourceRegistration,
  validateCompanySourceRegistration,
  sourceVersionLabel,
  assertCompanyRequestUrl,
  buildDirectoryRequest,
  buildMemberRequest,
  assertExternalCitationUrl,
  parseDirectoryIndex,
  parseMemberPage,
  parseObservedAt,
  normalizeCompanyName,
  normalizeDomainValue,
  normalizeAddressValue,
  dedupeCompanyRecords,
  claimMatchesToken,
  claimHasNegationCue,
  evaluateCompanyAdaptation,
  companyLeadId,
  upsertCompanyLead,
  persistPageEvidence,
  recordAdaptationObservation,
  recordContactCitation,
  transitionCompanyLead,
  scopeToken,
  scopeStatePath,
  readCompanyScopeState,
  updateCompanyScopeState,
  writeCompanySnapshot,
  readCompanySnapshot,
  discoverCompanies,
  createCompanyRegistration,
  registerCompanyHandler,
  CONTACT_LEVELS,
  CONTACT_TYPES,
  CONTACT_SOURCE_KINDS,
  CONTACT_VERIFICATION_METHODS,
  SALES_STAGES,
  SALES_TRANSITIONS,
  SALES_TERMINAL_STAGES,
  buildContactRecord,
  classifyContactLevel,
  listContacts,
  listContactVerifications,
  recordContact,
  assertContactEvidence,
  bindTrustedVerificationRecord,
  recordContactVerification,
  salesInitialState,
  listSalesEvents,
  readSalesState,
  resolveTrustedRecord,
  planSalesTransition,
  transitionSalesStage,
  leadObservationRow,
  commitLeadBatch,
  planContactWrites,
  planVerificationWrite,
  planSalesEventWrite,
  buildOutreachDraft,
  writeOutreachDraft
};
