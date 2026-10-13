'use strict';
/**
 * T3.1 source register & compliance gate.
 *
 * A registration records what a source IS and what its permit currently says. The presence of a
 * field is never permission: every request is evaluated against the permit BEFORE any transport
 * call, and unknown/pending/denied/expired or out-of-scope requests fail closed with zero
 * transport calls. A fixture permit only ever covers the synthetic transport; it never upgrades
 * to a live one.
 */
const { deepFreeze } = require('../providers/schema.js');

const PERMIT_APPROVAL_STATUSES = Object.freeze(['approved', 'pending', 'denied', 'expired', 'unknown']);
const REVIEW_STATUSES = Object.freeze(['reviewed_allowed', 'reviewed_disallowed', 'unknown']);
const SOURCE_USES = Object.freeze(['price_observation', 'variant_selection', 'search_candidates', 'rating_observation']);
const ALLOWED_METHODS = Object.freeze(['GET']);
const EXECUTION_MODES = Object.freeze(['fixture', 'manual', 'live']);
/** Structured execution grants: live is CLOSED by default and only the fixture/manual paths may
 *  execute without a separate live authorization (I-003 / method-scope / budget). */
const DEFAULT_EXECUTION_GRANTS = Object.freeze({ fixture: true, manual: true, live: false });
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class ConnectorError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
function connectorError(code, message, detail) { return new ConnectorError(code, message, detail); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw connectorError('registration_invalid', `${label} must be a non-empty string`);
  return value;
}
function requireIso(value, label) {
  const text = requireString(value, label);
  if (!ISO_RE.test(text) || Number.isNaN(Date.parse(text))) throw connectorError('registration_invalid', `${label} must be an ISO-8601 UTC instant`);
  return text;
}
function requirePositiveInt(value, label, max) {
  if (!Number.isInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    throw connectorError('registration_invalid', `${label} must be a positive integer${max === undefined ? '' : ` <= ${max}`}`);
  }
  return value;
}
function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw connectorError('registration_invalid', `${label}.${key} is not a declared field (fail-closed)`);
  }
}

/** Strict registration validation: the required fields must exist; their values still gate execution. */
function validateSourceRegistration(raw) {
  if (!isPlainObject(raw)) throw connectorError('registration_invalid', 'source registration must be a plain object');
  rejectUnknownFields(raw, ['schemaVersion', 'sourceId', 'version', 'host', 'allowedPaths', 'allowedMethods', 'allowedUses', 'permit', 'note'], 'source');
  if (raw.schemaVersion !== 1) throw connectorError('registration_invalid', 'source.schemaVersion must be 1');
  const sourceId = requireString(raw.sourceId, 'source.sourceId');
  const version = requireString(raw.version, 'source.version');
  const host = requireString(raw.host, 'source.host').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) {
    throw connectorError('registration_invalid', 'source.host must be a bare lowercase host name');
  }
  if (!Array.isArray(raw.allowedPaths) || raw.allowedPaths.length === 0) {
    throw connectorError('registration_invalid', 'source.allowedPaths must be a non-empty array');
  }
  const allowedPaths = raw.allowedPaths.map((entry, index) => {
    const pathValue = requireString(entry, `source.allowedPaths[${index}]`);
    if (!pathValue.startsWith('/')) throw connectorError('registration_invalid', `source.allowedPaths[${index}] must start with /`);
    return pathValue.replace(/\/+$/, '') || '/';
  });
  if (!Array.isArray(raw.allowedMethods) || raw.allowedMethods.length === 0) {
    throw connectorError('registration_invalid', 'source.allowedMethods must be a non-empty array');
  }
  const allowedMethods = raw.allowedMethods.map((entry, index) => {
    const method = requireString(entry, `source.allowedMethods[${index}]`).toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) throw connectorError('registration_invalid', `source.allowedMethods[${index}] must be one of ${ALLOWED_METHODS.join(', ')}`);
    return method;
  });
  if (!Array.isArray(raw.allowedUses) || raw.allowedUses.length === 0) {
    throw connectorError('registration_invalid', 'source.allowedUses must be a non-empty array');
  }
  const allowedUses = raw.allowedUses.map((entry, index) => {
    const use = requireString(entry, `source.allowedUses[${index}]`);
    if (!SOURCE_USES.includes(use)) throw connectorError('registration_invalid', `source.allowedUses[${index}] is not a known use`);
    return use;
  });
  const permitRaw = raw.permit;
  if (!isPlainObject(permitRaw)) throw connectorError('registration_invalid', 'source.permit must be a plain object');
  rejectUnknownFields(permitRaw, ['approvalStatus', 'approvalBasis', 'approvalObservedAt', 'expiresAt', 'robots', 'tos', 'rateLimit', 'execution'], 'source.permit');
  const approvalStatus = requireString(permitRaw.approvalStatus, 'source.permit.approvalStatus');
  if (!PERMIT_APPROVAL_STATUSES.includes(approvalStatus)) throw connectorError('registration_invalid', 'source.permit.approvalStatus is not a known status');
  const approvalBasis = requireString(permitRaw.approvalBasis, 'source.permit.approvalBasis');
  const approvalObservedAt = requireIso(permitRaw.approvalObservedAt, 'source.permit.approvalObservedAt');
  const expiresAt = permitRaw.expiresAt === null || permitRaw.expiresAt === undefined ? null : requireIso(permitRaw.expiresAt, 'source.permit.expiresAt');
  const executionRaw = permitRaw.execution === undefined || permitRaw.execution === null ? {} : permitRaw.execution;
  if (!isPlainObject(executionRaw)) throw connectorError('registration_invalid', 'source.permit.execution must be a plain object');
  rejectUnknownFields(executionRaw, [...EXECUTION_MODES], 'source.permit.execution');
  const execution = {};
  for (const mode of EXECUTION_MODES) {
    const value = executionRaw[mode] === undefined ? DEFAULT_EXECUTION_GRANTS[mode] : executionRaw[mode];
    if (typeof value !== 'boolean') throw connectorError('registration_invalid', `source.permit.execution.${mode} must be a boolean`);
    execution[mode] = value;
  }
  const reviewOf = (entry, label) => {
    if (!isPlainObject(entry)) throw connectorError('registration_invalid', `${label} must be a plain object`);
    rejectUnknownFields(entry, ['status', 'basis', 'observedAt'], label);
    const status = requireString(entry.status, `${label}.status`);
    if (!REVIEW_STATUSES.includes(status)) throw connectorError('registration_invalid', `${label}.status is not a known review status`);
    return { status, basis: requireString(entry.basis, `${label}.basis`), observedAt: requireIso(entry.observedAt, `${label}.observedAt`) };
  };
  const robots = reviewOf(permitRaw.robots, 'source.permit.robots');
  const tos = reviewOf(permitRaw.tos, 'source.permit.tos');
  const rateRaw = permitRaw.rateLimit;
  if (!isPlainObject(rateRaw)) throw connectorError('registration_invalid', 'source.permit.rateLimit must be a plain object');
  rejectUnknownFields(rateRaw, ['requestsPerWindow', 'windowMs', 'maxAttempts', 'backoffBaseMs', 'backoffCapMs'], 'source.permit.rateLimit');
  const rateLimit = {
    requestsPerWindow: requirePositiveInt(rateRaw.requestsPerWindow, 'rateLimit.requestsPerWindow', 60),
    windowMs: requirePositiveInt(rateRaw.windowMs, 'rateLimit.windowMs', 3_600_000),
    maxAttempts: requirePositiveInt(rateRaw.maxAttempts, 'rateLimit.maxAttempts', 5),
    backoffBaseMs: Number.isInteger(rateRaw.backoffBaseMs) && rateRaw.backoffBaseMs >= 0 && rateRaw.backoffBaseMs <= 60_000 ? rateRaw.backoffBaseMs : (() => { throw connectorError('registration_invalid', 'rateLimit.backoffBaseMs must be an integer 0..60000'); })(),
    backoffCapMs: requirePositiveInt(rateRaw.backoffCapMs, 'rateLimit.backoffCapMs', 300_000)
  };
  if (rateLimit.backoffCapMs < rateLimit.backoffBaseMs) throw connectorError('registration_invalid', 'rateLimit.backoffCapMs must be >= backoffBaseMs');
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

function pathWithinAllowed(requestPath, allowedPaths) {
  const target = String(requestPath || '');
  return allowedPaths.some((prefix) => {
    if (target === prefix) return true;
    const withSlash = prefix === '/' ? '/' : `${prefix}/`;
    return target.startsWith(withSlash);
  });
}

/**
 * Evaluate the permit for one request. Deny codes are stable and every deny carries
 * `transportCalls: 0`: the caller must not touch a transport when allowed is false.
 */
function evaluatePermit(source, request, options = {}) {
  const at = options.at === undefined ? new Date().toISOString() : requireIso(options.at, 'options.at');
  const deny = (code) => ({ allowed: false, code, transportCalls: 0 });
  const permit = source.permit;
  if (permit.approvalStatus !== 'approved') return deny(`permit_${permit.approvalStatus}`);
  if (permit.expiresAt !== null && Date.parse(permit.expiresAt) <= Date.parse(at)) return deny('permit_expired');
  if (permit.robots.status !== 'reviewed_allowed') return deny(`robots_${permit.robots.status}`);
  if (permit.tos.status !== 'reviewed_allowed') return deny(`tos_${permit.tos.status}`);
  if (!isPlainObject(request) || typeof request.host !== 'string' || request.host.toLowerCase() !== source.host) return deny('host_not_allowed');
  if (!source.allowedMethods.includes(String(request.method || '').toUpperCase())) return deny('method_not_allowed');
  if (!source.allowedUses.includes(request.use)) return deny('use_not_allowed');
  if (!pathWithinAllowed(request.path, source.allowedPaths)) return deny('path_not_allowed');
  return { allowed: true, code: 'allowed', transportCalls: 0 };
}

/** Throw-on-deny variant for transports that must never reach their underlying implementation. */
function assertPermitAllows(source, request, options = {}) {
  const decision = evaluatePermit(source, request, options);
  if (!decision.allowed) throw connectorError(decision.code, `source request denied by permit: ${decision.code}`, { transportCalls: 0 });
  return decision;
}

module.exports = {
  PERMIT_APPROVAL_STATUSES,
  REVIEW_STATUSES,
  SOURCE_USES,
  ALLOWED_METHODS,
  EXECUTION_MODES,
  DEFAULT_EXECUTION_GRANTS,
  ConnectorError,
  connectorError,
  isPlainObject,
  validateSourceRegistration,
  evaluatePermit,
  assertPermitAllows,
  pathWithinAllowed
};
