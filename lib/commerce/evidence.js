'use strict';
/**
 * Evidence / Observation fact model (T1.3).
 *
 * Semantics (recorded in HANDOFF as the label contract):
 * - Evidence: sourceType (manual_upload / page / api / user_statement), url, observedAt,
 *   capturedAt, sha256, private fileRef, licenseNote, importBasis. `hash_verified = 1` means the
 *   sha256 was computed from REAL BYTES read by this module; `recordDeclaredEvidence` stores
 *   metadata-only entries with `hash_verified = 0` and an explicit importBasis — a declared hash is
 *   never presented as byte-verified. Dedup is per project on sha256; explicit metadata is
 *   validated BEFORE the dedup early return.
 * - Observation keeps TWO independent dimensions: originType (pdp_measured / seller_statement /
 *   user_statement / model_inference / estimate) and approvalStatus (unreviewed / user_confirmed /
 *   rejected). Changing approval NEVER changes origin: a user-confirmed estimate stays `estimate`;
 *   a user-confirmed statement stays `user_statement`.
 * - Values: value must be a finite number or a non-empty string (numbers are stored via their
 *   deterministic string form — never coerced from NaN/Infinity/null). unit is stored verbatim;
 *   no currency or quantity conversion happens here.
 * - Quantitative vs qualitative (generic rule, no product-specific key list): a QUANTITATIVE value
 *   is a finite number or plain-decimal numeric text (^[+-]?(\d+(\.\d+)?|\.\d+)$); it REQUIRES a
 *   non-empty unit — missing/null/blank unit is a ValidationError before any row is written. Any
 *   other non-empty text is QUALITATIVE and may omit the unit. Units are never inferred, guessed
 *   or converted. supersedeObservation builds the replacement through the same validation; a
 *   replacement that does not provide a unit (undefined) inherits the superseded fact's unit (same
 *   subject and key), while an explicit null unit is preserved as-is and reaches the same
 *   validation (a quantitative replacement with unit: null is rejected); so a quantitative
 *   replacement can never slip through with a missing unit.
 * - Time: observedAt must be a STRICT ISO-8601 date-time with explicit timezone
 *   (YYYY-MM-DDThh:mm:ss[.sss]Z or ±hh:mm) and a real calendar date — impossible dates such as
 *   2026-02-30, date-only strings, missing timezones and non-ISO text are ValidationError; input is
 *   stored verbatim and never silently reinterpreted. The same validation applies to Evidence
 *   observedAt metadata (validated before the hash-dedup early return), asOf and approval `now`.
 *   observed time ≠ current time. ttlSeconds is an integer in (0, 315360000] (max 10 years);
 *   expiresAt = observedAt + ttlSeconds. Freshness is evaluated against an INJECTED clock
 *   (`asOf`/`now` options) so tests are deterministic; an observation without TTL has no expiry
 *   (never reported as expired).
 * - Correction: supersedeObservation creates a NEW observation and points the old row's
 *   superseded_by at it. Replacement must target the SAME (subject_type, subject_id, key) — a
 *   different subject with the same key can never be used as a replacement. Old rows are never
 *   deleted or time-rewritten; the chain stays readable.
 * - Everything is project-scoped; ids from another project are treated as not found.
 *
 * DEV NOTE: development task state (PROGRESS.json) is unrelated to business `runs` state.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

const SOURCE_TYPES = ['manual_upload', 'page', 'api', 'user_statement'];
const ORIGIN_TYPES = ['pdp_measured', 'seller_statement', 'user_statement', 'model_inference', 'estimate'];
const APPROVAL_STATUSES = ['unreviewed', 'user_confirmed', 'rejected'];
const MAX_TTL_SECONDS = 315360000; // 10 years, explicit boundary

class NotFoundError extends Error { constructor(message) { super(message); this.code = 'not_found'; } }
class ValidationError extends Error { constructor(message) { super(message); this.code = 'validation'; } }
class ConflictError extends Error { constructor(message) { super(message); this.code = 'conflict'; } }

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const SHA256_RE = /^[a-f0-9]{64}$/i;
/** Plain-decimal numeric text only; nothing else is interpreted as a quantity. */
const NUMERIC_TEXT_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
/** Strict ISO-8601 date-time, explicit timezone required. */
const STRICT_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalString(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, name);
}
/** Units are either absent (undefined/null) or a non-empty string; '' is an explicit rejection. */
function optionalUnit(value) {
  if (value === undefined || value === null) return null;
  return requireString(value, 'unit');
}
function requireEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new ValidationError(`${name} must be one of ${allowed.join(', ')}`);
  return value;
}
/** Last day of a 1-12 month; real-calendar check for the strict ISO parser. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
/** Strict ISO-8601 date-time with explicit timezone; returns epoch ms or null (never lenient). */
function parseStrictIso(text) {
  const match = STRICT_ISO_RE.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const ms = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  const tz = match[8];
  let offsetMinutes = 0;
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const offsetHours = Number(tz.slice(1, 3));
    const offsetMins = Number(tz.slice(4, 6));
    if (offsetHours > 14 || offsetMins > 59 || (offsetHours === 14 && offsetMins > 0)) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
  return Number.isFinite(epoch) ? epoch : null;
}
/**
 * Validates and returns { text, epoch }; only strict, timezone-explicit, real-calendar ISO
 * date-times pass. Applied to observedAt / captured metadata, asOf and approval `now`.
 */
function requireIsoDate(value, name) {
  const text = requireString(value, name);
  const epoch = parseStrictIso(text);
  if (epoch === null) {
    throw new ValidationError(`${name} must be a strict ISO-8601 date-time with explicit timezone (YYYY-MM-DDThh:mm:ss[.sss]Z or ±hh:mm) and a real calendar date`);
  }
  return { text, epoch };
}
/** Explicit observedAt metadata or a generated fallback; validated even when dedup returns early. */
function resolveObservedAt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return requireIsoDate(value, 'observedAt').text;
}
function requireTtlSeconds(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TTL_SECONDS) {
    throw new ValidationError(`ttlSeconds must be an integer in (0, ${MAX_TTL_SECONDS}]`);
  }
  return value;
}
function requireValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('value must be a finite number or a non-empty string');
    return String(value);
  }
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw new ValidationError('value must be a finite number or a non-empty string');
}
/** Quantitative = finite number or plain-decimal numeric text; everything else is qualitative. */
function isQuantitative(value) {
  if (typeof value === 'number') return true;
  if (typeof value === 'string') return NUMERIC_TEXT_RE.test(value.trim());
  return false;
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

// ---------- Evidence ----------

function findEvidenceByHash(db, projectId, sha256) {
  return db.prepare('SELECT * FROM evidence WHERE project_id = ? AND sha256 = ?').get(projectId, sha256) ?? null;
}

function insertEvidence(db, row) {
  db.prepare(`INSERT INTO evidence (id, project_id, source_type, url, observed_at, sha256, file_ref, license_note, created_at, captured_at, import_basis, hash_verified)
    VALUES (@id, @project_id, @source_type, @url, @observed_at, @sha256, @file_ref, @license_note, @created_at, @captured_at, @import_basis, @hash_verified)`)
    .run(row);
}

/**
 * Import evidence from a real file: the sha256 is computed from the actual bytes (hash_verified=1).
 * The file itself must already live in the private runtime area; only its path is recorded.
 */
function importEvidenceFromFile(db, projectId, input = {}) {
  const project = requireString(projectId, 'projectId');
  const filePath = requireString(input.filePath, 'filePath');
  const sourceType = requireEnum(input.sourceType ?? 'manual_upload', SOURCE_TYPES, 'sourceType');
  const url = optionalString(input.url, 'url');
  const licenseNote = optionalString(input.licenseNote, 'licenseNote');
  const importBasis = requireString(input.importBasis ?? 'manual_import', 'importBasis');
  const capturedAt = nowIso();
  const observedAt = resolveObservedAt(input.observedAt, capturedAt); // strict, before dedup early return
  const bytes = fs.readFileSync(filePath); // throws if unreadable; caller keeps it private
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return withTransaction(db, () => {
    const existing = findEvidenceByHash(db, project, sha256);
    if (existing) return { ...existing, deduplicated: true };
    const row = {
      id: newId('ev'),
      project_id: project,
      source_type: sourceType,
      url,
      observed_at: observedAt,
      sha256,
      file_ref: filePath,
      license_note: licenseNote,
      created_at: capturedAt,
      captured_at: capturedAt,
      import_basis: importBasis,
      hash_verified: 1
    };
    insertEvidence(db, row);
    return { ...db.prepare('SELECT * FROM evidence WHERE id = ?').get(row.id), deduplicated: false };
  });
}

/**
 * Record evidence that is only KNOWN by metadata (no bytes read here): the sha256 is stored as a
 * declaration with hash_verified=0 and an explicit importBasis; it is never presented as verified.
 */
function recordDeclaredEvidence(db, projectId, input = {}) {
  const project = requireString(projectId, 'projectId');
  const sha256 = requireString(input.sha256, 'sha256').toLowerCase();
  if (!SHA256_RE.test(sha256)) throw new ValidationError('sha256 must be a 64-character hex digest');
  const sourceType = requireEnum(input.sourceType ?? 'user_statement', SOURCE_TYPES, 'sourceType');
  const importBasis = requireString(input.importBasis, 'importBasis');
  const url = optionalString(input.url, 'url');
  const fileRef = optionalString(input.fileRef, 'fileRef');
  const licenseNote = optionalString(input.licenseNote, 'licenseNote');
  const capturedAt = nowIso();
  const observedAt = resolveObservedAt(input.observedAt, capturedAt); // strict, before dedup early return
  return withTransaction(db, () => {
    const existing = findEvidenceByHash(db, project, sha256);
    if (existing) return { ...existing, deduplicated: true };
    const row = {
      id: newId('ev'),
      project_id: project,
      source_type: sourceType,
      url,
      observed_at: observedAt,
      sha256,
      file_ref: fileRef,
      license_note: licenseNote,
      created_at: capturedAt,
      captured_at: capturedAt,
      import_basis: importBasis,
      hash_verified: 0
    };
    insertEvidence(db, row);
    return { ...db.prepare('SELECT * FROM evidence WHERE id = ?').get(row.id), deduplicated: false };
  });
}

function getEvidence(db, projectId, evidenceId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(evidenceId, 'evidenceId');
  return db.prepare('SELECT * FROM evidence WHERE project_id = ? AND id = ?').get(project, id) ?? null;
}

function listEvidence(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const clauses = ['project_id = ?'];
  const params = [project];
  if (options.sourceType) { clauses.push('source_type = ?'); params.push(requireEnum(options.sourceType, SOURCE_TYPES, 'sourceType')); }
  return db.prepare(`SELECT * FROM evidence WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`).all(...params);
}

// ---------- Observation ----------

function computeExpiresAt(observedEpoch, ttlSeconds) {
  if (ttlSeconds === null) return null;
  return new Date(observedEpoch + ttlSeconds * 1000).toISOString();
}

function observationFreshness(row, asOf) {
  const at = requireIsoDate(asOf ?? nowIso(), 'asOf').epoch;
  if (!row || !row.expires_at) return { expired: false, expiresAt: row ? row.expires_at : null };
  const expiry = parseStrictIso(row.expires_at); // generated by toISOString(), strict by construction
  return { expired: expiry !== null && expiry <= at, expiresAt: row.expires_at };
}

function buildObservationRow(db, project, input = {}) {
  const subjectType = requireString(input.subjectType, 'subjectType');
  const subjectId = requireString(input.subjectId, 'subjectId');
  const key = requireString(input.key, 'key');
  const originType = requireEnum(input.originType, ORIGIN_TYPES, 'originType');
  const approvalStatus = requireEnum(input.approvalStatus ?? 'unreviewed', APPROVAL_STATUSES, 'approvalStatus');
  const valueText = requireValue(input.value);
  const unit = optionalUnit(input.unit);
  if (unit === null && isQuantitative(input.value)) {
    throw new ValidationError('unit is required for quantitative values (finite number or plain-decimal numeric text); provide a non-empty unit or record the value as qualitative text');
  }
  const observed = requireIsoDate(input.observedAt, 'observedAt');
  const ttlSeconds = requireTtlSeconds(input.ttlSeconds);
  let evidenceId = null;
  if (input.evidenceId !== undefined && input.evidenceId !== null && input.evidenceId !== '') {
    evidenceId = requireString(input.evidenceId, 'evidenceId');
    if (!getEvidence(db, project, evidenceId)) throw new NotFoundError('evidence not found in this project');
  }
  const createdAt = nowIso();
  return {
    id: newId('ob'),
    project_id: project,
    evidence_id: evidenceId,
    origin_type: originType,
    approval_status: approvalStatus,
    key,
    value_text: valueText,
    unit,
    observed_at: observed.text,
    ttl: ttlSeconds === null ? null : `${ttlSeconds}s`,
    ttl_seconds: ttlSeconds,
    expires_at: computeExpiresAt(observed.epoch, ttlSeconds),
    superseded_by: null,
    subject_type: subjectType,
    subject_id: subjectId,
    approval_changed_at: approvalStatus === 'unreviewed' ? null : createdAt,
    created_at: createdAt
  };
}

const INSERT_OBSERVATION_SQL = `INSERT INTO observations (id, project_id, evidence_id, origin_type, approval_status, key, value_text, unit, observed_at, ttl, ttl_seconds, expires_at, superseded_by, subject_type, subject_id, approval_changed_at, created_at)
  VALUES (@id, @project_id, @evidence_id, @origin_type, @approval_status, @key, @value_text, @unit, @observed_at, @ttl, @ttl_seconds, @expires_at, @superseded_by, @subject_type, @subject_id, @approval_changed_at, @created_at)`;

function createObservation(db, projectId, input = {}) {
  const project = requireString(projectId, 'projectId');
  const row = buildObservationRow(db, project, input);
  return withTransaction(db, () => {
    db.prepare(INSERT_OBSERVATION_SQL).run(row);
    return db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id);
  });
}

function getObservation(db, projectId, observationId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(observationId, 'observationId');
  return db.prepare('SELECT * FROM observations WHERE project_id = ? AND id = ?').get(project, id) ?? null;
}

function listObservations(db, projectId, options = {}) {
  const project = requireString(projectId, 'projectId');
  const clauses = ['project_id = ?'];
  const params = [project];
  if (!options.includeSuperseded) clauses.push('superseded_by IS NULL');
  if (options.subjectType) { clauses.push('subject_type = ?'); params.push(requireString(options.subjectType, 'subjectType')); }
  if (options.subjectId) { clauses.push('subject_id = ?'); params.push(requireString(options.subjectId, 'subjectId')); }
  if (options.key) { clauses.push('key = ?'); params.push(requireString(options.key, 'key')); }
  const rows = db.prepare(`SELECT * FROM observations WHERE ${clauses.join(' AND ')} ORDER BY observed_at, created_at, id`).all(...params);
  if (!options.asOf) return rows;
  requireIsoDate(options.asOf, 'asOf'); // strict validation before mapping
  return rows.map((row) => ({ ...row, expired: observationFreshness(row, options.asOf).expired }));
}

/** Approval changes never touch originType; transitions are one-way from unreviewed. */
function setObservationApproval(db, projectId, observationId, status, options = {}) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(observationId, 'observationId');
  const target = requireEnum(status, APPROVAL_STATUSES, 'approvalStatus');
  const current = getObservation(db, project, id);
  if (!current) throw new NotFoundError('observation not found in this project');
  if (current.superseded_by) throw new ConflictError('superseded observation is historical and cannot be re-approved');
  if (current.approval_status === target) return current;
  if (current.approval_status !== 'unreviewed') throw new ConflictError(`approval cannot change from ${current.approval_status} to ${target}`);
  const at = requireIsoDate(options.now ?? nowIso(), 'now').text;
  db.prepare('UPDATE observations SET approval_status = ?, approval_changed_at = ? WHERE project_id = ? AND id = ?').run(target, at, project, id);
  return db.prepare('SELECT * FROM observations WHERE project_id = ? AND id = ?').get(project, id);
}

/**
 * Supersede an observation with a corrected replacement on the SAME subject+key. The old row keeps
 * its history (superseded_by points at the new row); nothing is deleted or time-rewritten.
 */
function supersedeObservation(db, projectId, oldId, replacement = {}) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(oldId, 'oldId');
  const old = getObservation(db, project, id);
  if (!old) throw new NotFoundError('observation not found in this project');
  if (old.superseded_by) throw new ConflictError('observation is already superseded');
  const sameSubject = replacement.subjectType === undefined || requireString(replacement.subjectType, 'subjectType') === old.subject_type;
  const sameSubjectId = replacement.subjectId === undefined || requireString(replacement.subjectId, 'subjectId') === old.subject_id;
  const sameKey = replacement.key === undefined || requireString(replacement.key, 'key') === old.key;
  if (!sameSubject || !sameSubjectId || !sameKey) {
    throw new ValidationError('replacement must target the same subject and key as the observation being superseded');
  }
  const row = buildObservationRow(db, project, {
    ...replacement,
    subjectType: old.subject_type,
    subjectId: old.subject_id,
    key: old.key,
    evidenceId: replacement.evidenceId ?? old.evidence_id,
    unit: replacement.unit === undefined ? old.unit : replacement.unit
  });
  return withTransaction(db, () => {
    db.prepare(INSERT_OBSERVATION_SQL).run(row);
    const guard = db.prepare('UPDATE observations SET superseded_by = ? WHERE project_id = ? AND id = ? AND superseded_by IS NULL').run(row.id, project, id);
    if (guard.changes !== 1) throw new ConflictError('observation was superseded concurrently');
    return { old: getObservation(db, project, id), replacement: db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id) };
  });
}

/** Ordered chain (oldest -> newest) that the given observation belongs to. */
function getObservationChain(db, projectId, observationId) {
  const project = requireString(projectId, 'projectId');
  const id = requireString(observationId, 'observationId');
  const start = getObservation(db, project, id);
  if (!start) throw new NotFoundError('observation not found in this project');
  const visited = new Set();
  let current = start;
  while (current.superseded_by) {
    if (visited.has(current.id)) throw new ConflictError('supersede chain contains a cycle');
    visited.add(current.id);
    const next = getObservation(db, project, current.superseded_by);
    if (!next) break;
    current = next;
  }
  const chain = [current];
  while (true) {
    const prev = db.prepare('SELECT * FROM observations WHERE project_id = ? AND superseded_by = ?').get(project, chain[0].id);
    if (!prev) break;
    chain.unshift(prev);
  }
  return chain;
}

module.exports = {
  SOURCE_TYPES,
  ORIGIN_TYPES,
  APPROVAL_STATUSES,
  MAX_TTL_SECONDS,
  importEvidenceFromFile,
  recordDeclaredEvidence,
  getEvidence,
  listEvidence,
  createObservation,
  getObservation,
  listObservations,
  setObservationApproval,
  supersedeObservation,
  getObservationChain,
  observationFreshness,
  NotFoundError,
  ValidationError,
  ConflictError
};
