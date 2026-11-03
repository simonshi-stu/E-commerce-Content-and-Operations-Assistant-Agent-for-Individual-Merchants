'use strict';

// Read-only consumer for the shared commerce.video-runtime-result.v1 contract.
// The browser supplies references only; this adapter maps server-owned ids to controlled files.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./commerce/packs.js');

const SCHEMA_VERSION = 'commerce.video-runtime-result.v1';
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const STATES = Object.freeze(['not_started', 'blocked', 'submitting', 'submission_unknown', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']);
const MEDIA_STATUSES = Object.freeze(['absent', 'downloaded', 'verified']);
const QA_STATUSES = Object.freeze(['not_run', 'failed', 'needs_review', 'passed']);
const EXPORT_STATUSES = Object.freeze(['not_ready', 'ready']);
const MODES = Object.freeze(['simulated', 'real']);
const SAFE_CODE_RE = /^[A-Z0-9][A-Z0-9_.-]{0,79}$/;
const MAX_CODES = 32;
const CONSUMPTION_INDEX_SCHEMA_VERSION = 'commerce.video-runtime-consumption-index.v1';
const CONSUMPTION_INDEX_DIRECTORY = '.runtime-consumption';
const CONSUMPTION_INDEX_FILE = 'index.json';
const CONSUMPTION_INDEX_TEMP_FILE = 'index.json.tmp';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value) || value === '.' || value === '..') fail('runtime_result_invalid', `${name} must be a safe non-empty identifier`);
  return value;
}

function safeArtifactReference(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('runtime_result_invalid', `${name} must be a safe artifact reference`);
  }
  return value;
}

function safeHash(value, name) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail('runtime_result_invalid', `${name} must be a lowercase SHA-256`);
  return value;
}

function safeCode(value, name) {
  if (typeof value !== 'string' || !SAFE_CODE_RE.test(value)) fail('runtime_result_invalid', `${name} contains an unsafe error code`);
  return value;
}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail('runtime_result_invalid', `${name} must be an integer >= ${min}`);
  return value;
}

function assertKnownKeys(value, keys, name) {
  if (!isPlainObject(value)) fail('runtime_result_invalid', `${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('runtime_result_invalid', `${name}.${key} is not allowed`);
}

function normalizeBinding(value) {
  assertKnownKeys(value, ['projectId', 'briefId', 'briefVersion', 'snapshotSha256'], 'binding');
  return {
    projectId: safeId(value.projectId, 'binding.projectId'),
    briefId: safeId(value.briefId, 'binding.briefId'),
    briefVersion: integer(value.briefVersion, 'binding.briefVersion', 1),
    snapshotSha256: safeHash(value.snapshotSha256, 'binding.snapshotSha256')
  };
}

function normalizeMedia(value) {
  assertKnownKeys(value, ['status', 'artifactId', 'sha256', 'bytes'], 'media');
  if (!MEDIA_STATUSES.includes(value.status)) fail('runtime_result_invalid', 'media.status is not supported');
  const artifactId = value.artifactId === null ? null : safeArtifactReference(value.artifactId, 'media.artifactId');
  const sha256 = value.sha256 === null ? null : safeHash(value.sha256, 'media.sha256');
  const bytes = value.bytes === null ? null : integer(value.bytes, 'media.bytes');
  return { status: value.status, artifactId, sha256, bytes };
}

function normalizeQa(value) {
  assertKnownKeys(value, ['status', 'codes'], 'qa');
  if (!QA_STATUSES.includes(value.status) || !Array.isArray(value.codes) || value.codes.length > MAX_CODES) fail('runtime_result_invalid', 'qa is invalid');
  return { status: value.status, codes: value.codes.map((code, index) => safeCode(code, `qa.codes[${index}]`)) };
}

function normalizeExport(value) {
  assertKnownKeys(value, ['status', 'artifactId'], 'export');
  if (!EXPORT_STATUSES.includes(value.status)) fail('runtime_result_invalid', 'export.status is not supported');
  const artifactId = value.artifactId === null ? null : safeArtifactReference(value.artifactId, 'export.artifactId');
  return { status: value.status, artifactId };
}

function normalizeBudget(value) {
  assertKnownKeys(value, ['currency', 'capMinor', 'reservedMinor', 'settledMinor', 'usageKnown'], 'budget');
  if (value.currency !== 'CNY' || value.capMinor !== 1000) fail('runtime_result_invalid', 'budget must use the approved CNY 10.00 cap');
  const reservedMinor = integer(value.reservedMinor, 'budget.reservedMinor');
  const settledMinor = integer(value.settledMinor, 'budget.settledMinor');
  if (reservedMinor + settledMinor > value.capMinor) fail('runtime_budget_exceeded', 'runtime budget exceeds the approved cap');
  if (typeof value.usageKnown !== 'boolean') fail('runtime_result_invalid', 'budget.usageKnown must be boolean');
  return { currency: 'CNY', capMinor: 1000, reservedMinor, settledMinor, usageKnown: value.usageKnown };
}

function normalizeRuntimeResult(value) {
  assertKnownKeys(value, ['schemaVersion', 'mode', 'operationId', 'requestDigest', 'binding', 'revision', 'state', 'media', 'qa', 'export', 'budget', 'errors'], 'runtime result');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('runtime_schema_unsupported', 'runtime result schemaVersion is not supported');
  if (!MODES.includes(value.mode)) fail('runtime_result_invalid', 'runtime result mode is not supported');
  const errors = Array.isArray(value.errors) && value.errors.length <= MAX_CODES
    ? value.errors.map((code, index) => safeCode(code, `errors[${index}]`))
    : fail('runtime_result_invalid', 'errors must be an array of safe codes');
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: value.mode,
    operationId: safeId(value.operationId, 'operationId'),
    requestDigest: safeHash(value.requestDigest, 'requestDigest'),
    binding: normalizeBinding(value.binding),
    revision: integer(value.revision, 'revision', 1),
    state: STATES.includes(value.state) ? value.state : fail('runtime_result_invalid', 'runtime result state is not supported'),
    media: normalizeMedia(value.media),
    qa: normalizeQa(value.qa),
    export: normalizeExport(value.export),
    budget: normalizeBudget(value.budget),
    errors
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function emptyConsumptionIndex() {
  return { schemaVersion: CONSUMPTION_INDEX_SCHEMA_VERSION, entries: [], artifactScopes: [] };
}

function persistenceError(code, message) {
  fail(code, message);
}

function optionalLstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    persistenceError('runtime_persistence_unavailable', 'the runtime consumption index cannot be inspected');
  }
}

function normalizeConsumptionIndex(value) {
  try {
    assertKnownKeys(value, ['schemaVersion', 'entries', 'artifactScopes'], 'runtime consumption index');
    if (value.schemaVersion !== CONSUMPTION_INDEX_SCHEMA_VERSION || !Array.isArray(value.entries) || !Array.isArray(value.artifactScopes)) {
      persistenceError('runtime_persistence_corrupt', 'the runtime consumption index is not supported');
    }
    const entries = [];
    const seenOperations = new Set();
    for (const entry of value.entries) {
      assertKnownKeys(entry, ['operationId', 'digest', 'result'], 'runtime consumption entry');
      const operationId = safeId(entry.operationId, 'runtime consumption entry.operationId');
      const digest = safeHash(entry.digest, 'runtime consumption entry.digest');
      const result = normalizeRuntimeResult(entry.result);
      if (result.operationId !== operationId || sha256(Buffer.from(canonicalJson(result))) !== digest || seenOperations.has(operationId)) {
        persistenceError('runtime_persistence_corrupt', 'the runtime consumption index contains an inconsistent operation entry');
      }
      seenOperations.add(operationId);
      entries.push({ operationId, digest, result });
    }
    const artifactScopes = [];
    const seenArtifacts = new Map();
    for (const claim of value.artifactScopes) {
      assertKnownKeys(claim, ['kind', 'artifactId', 'operationId', 'binding'], 'runtime artifact scope');
      if (claim.kind !== 'media' && claim.kind !== 'export') persistenceError('runtime_persistence_corrupt', 'the runtime consumption index has an invalid artifact scope');
      const artifactId = safeArtifactReference(claim.artifactId, 'runtime artifact scope.artifactId');
      const operationId = safeId(claim.operationId, 'runtime artifact scope.operationId');
      const binding = normalizeBinding(claim.binding);
      const key = `${claim.kind}:${artifactId}`;
      const scope = canonicalJson({ operationId, binding });
      const previous = seenArtifacts.get(key);
      if (previous && previous !== scope) persistenceError('runtime_persistence_corrupt', 'the runtime consumption index contains an artifact scope conflict');
      if (!previous) {
        seenArtifacts.set(key, scope);
        artifactScopes.push({ kind: claim.kind, artifactId, operationId, binding });
      }
    }
    return { schemaVersion: CONSUMPTION_INDEX_SCHEMA_VERSION, entries, artifactScopes };
  } catch (error) {
    if (error && /^runtime_persistence_/.test(error.code || '')) throw error;
    persistenceError('runtime_persistence_corrupt', 'the runtime consumption index is invalid');
  }
}

function readConsumptionIndex(resultRoot) {
  const directory = path.join(resultRoot, CONSUMPTION_INDEX_DIRECTORY);
  const indexFile = path.join(directory, CONSUMPTION_INDEX_FILE);
  const tempFile = path.join(directory, CONSUMPTION_INDEX_TEMP_FILE);
  const directoryStat = optionalLstat(directory);
  if (!directoryStat) return emptyConsumptionIndex();
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) persistenceError('runtime_persistence_corrupt', 'the runtime consumption index directory is unsafe');
  const tempStat = optionalLstat(tempFile);
  if (tempStat) persistenceError('runtime_persistence_incomplete', 'the runtime consumption index has an unfinished atomic replacement');
  const indexStat = optionalLstat(indexFile);
  if (!indexStat) persistenceError('runtime_persistence_incomplete', 'the runtime consumption index is missing');
  if (indexStat.isSymbolicLink() || !indexStat.isFile()) persistenceError('runtime_persistence_corrupt', 'the runtime consumption index file is unsafe');
  let bytes;
  try { bytes = fs.readFileSync(indexFile); }
  catch { persistenceError('runtime_persistence_unavailable', 'the runtime consumption index cannot be read'); }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { persistenceError('runtime_persistence_corrupt', 'the runtime consumption index is not valid JSON'); }
  return normalizeConsumptionIndex(parsed);
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!error || !['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
  }
}

function writeConsumptionIndex(resultRoot, index) {
  const directory = path.join(resultRoot, CONSUMPTION_INDEX_DIRECTORY);
  const indexFile = path.join(directory, CONSUMPTION_INDEX_FILE);
  const tempFile = path.join(directory, CONSUMPTION_INDEX_TEMP_FILE);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) persistenceError('runtime_persistence_corrupt', 'the runtime consumption index directory is unsafe');
    if (optionalLstat(tempFile)) persistenceError('runtime_persistence_incomplete', 'the runtime consumption index has an unfinished atomic replacement');
    const indexStat = optionalLstat(indexFile);
    if (indexStat && (indexStat.isSymbolicLink() || !indexStat.isFile())) persistenceError('runtime_persistence_corrupt', 'the runtime consumption index file is unsafe');
    const fd = fs.openSync(tempFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, indexFile);
    syncDirectory(directory);
  } catch (error) {
    if (error && /^runtime_persistence_/.test(error.code || '')) throw error;
    persistenceError('runtime_persistence_unavailable', 'the runtime consumption index could not be atomically replaced');
  }
}

function blockedResult(result, code) {
  const qaStatus = result.qa.status === 'passed' ? 'needs_review' : result.qa.status;
  return {
    ...result,
    state: 'blocked',
    media: { status: 'absent', artifactId: null, sha256: null, bytes: null },
    qa: { status: qaStatus, codes: [...new Set([...result.qa.codes, code])].slice(0, MAX_CODES) },
    export: { status: 'not_ready', artifactId: null },
    errors: [...new Set([...result.errors, code])].slice(0, MAX_CODES)
  };
}

function recoveredBlockedResult(index, request, binding, code) {
  const entry = index.entries.find((item) => item.operationId === request.operationId);
  if (!entry) return null;
  if (!sameBinding(entry.result.binding, binding)) fail('runtime_binding_mismatch', 'the persisted runtime result does not match the current snapshot');
  if (request.requestDigest !== undefined && entry.result.requestDigest !== request.requestDigest) fail('runtime_request_mismatch', 'the persisted runtime request digest does not match');
  return blockedResult(entry.result, code);
}

function indexWithConsumedResult(index, consumed, digest, artifactScopes) {
  return {
    schemaVersion: CONSUMPTION_INDEX_SCHEMA_VERSION,
    entries: [...index.entries.filter((entry) => entry.operationId !== consumed.operationId), { operationId: consumed.operationId, digest, result: consumed }]
      .sort((left, right) => left.operationId.localeCompare(right.operationId)),
    artifactScopes: [...artifactScopes.values()].map(({ kind, artifactId, operationId, binding }) => ({ kind, artifactId, operationId, binding }))
      .sort((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
  };
}

function rootDirectory(root, name) {
  if (typeof root !== 'string' || root.trim() === '') fail('runtime_configuration_invalid', `${name} must be an explicit directory`);
  const resolved = path.resolve(root);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail('runtime_unavailable', `${name} is not available`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('runtime_artifact_path_unsafe', `${name} must be a real directory`);
  let current = path.parse(resolved).root;
  const relative = path.relative(current, resolved);
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    let component;
    try { component = fs.lstatSync(current); } catch { fail('runtime_unavailable', `${name} is not available`); }
    if (component.isSymbolicLink()) fail('runtime_artifact_path_unsafe', `${name} cannot contain symlink components`);
  }
  return resolved;
}

function readContainedFile(root, name, { json = false } = {}) {
  const resolvedRoot = rootDirectory(root, 'runtime root');
  if (typeof name !== 'string' || name === '' || name !== path.basename(name) || name === '.' || name === '..') {
    fail('runtime_artifact_path_unsafe', 'runtime artifact id is not a safe file name');
  }
  const file = path.join(resolvedRoot, name);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('runtime_artifact_unavailable', 'runtime artifact cannot be inspected');
  }
  if (stat.isSymbolicLink()) fail('runtime_artifact_path_unsafe', 'runtime artifacts cannot be symlinks');
  if (!stat.isFile()) fail('runtime_artifact_unavailable', 'runtime artifact is not a file');
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
    realFile = fs.realpathSync(file);
  } catch {
    fail('runtime_artifact_unavailable', 'runtime artifact cannot be resolved');
  }
  const relative = path.relative(realRoot, realFile);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('runtime_artifact_path_unsafe', 'runtime artifact escapes its configured root');
  let bytes;
  try { bytes = fs.readFileSync(realFile); } catch { fail('runtime_artifact_unavailable', 'runtime artifact cannot be read'); }
  if (!json) return { file: realFile, bytes };
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('runtime_result_invalid', 'runtime result is not valid JSON'); }
  return { file: realFile, bytes, value: parsed };
}

function normalizeRequest(value) {
  assertKnownKeys(value, ['projectId', 'briefId', 'version', 'operationId', 'requestDigest'], 'runtime request');
  const request = {
    briefId: safeId(value.briefId, 'briefId'),
    version: integer(value.version, 'version', 1),
    operationId: safeId(value.operationId, 'operationId')
  };
  if (value.projectId !== undefined) request.projectId = safeId(value.projectId, 'projectId');
  if (value.requestDigest !== undefined) request.requestDigest = safeHash(value.requestDigest, 'requestDigest');
  return request;
}

function sameBinding(left, right) {
  return left.projectId === right.projectId
    && left.briefId === right.briefId
    && left.briefVersion === right.briefVersion
    && left.snapshotSha256 === right.snapshotSha256;
}

function consumeMedia(result, mediaRoot, scopeMatches = true) {
  if (result.media.status === 'absent') {
    const declared = result.media.artifactId !== null || result.media.sha256 !== null || result.media.bytes !== null;
    return {
      media: { status: 'absent', artifactId: null, sha256: null, bytes: null },
      evidence: null,
      errors: declared ? ['MEDIA_DECLARATION_IGNORED'] : []
    };
  }
  if (result.media.artifactId === null) {
    return { media: { status: 'absent', artifactId: null, sha256: null, bytes: null }, evidence: null, errors: ['MEDIA_ARTIFACT_MISSING'] };
  }
  if (!scopeMatches) {
    return { media: { status: 'absent', artifactId: null, sha256: null, bytes: null }, evidence: null, errors: ['MEDIA_ARTIFACT_SCOPE_MISMATCH'] };
  }
  let file;
  try {
    file = readContainedFile(mediaRoot, result.media.artifactId);
  } catch (error) {
    return {
      media: { status: 'absent', artifactId: null, sha256: null, bytes: null },
      evidence: null,
      errors: [error && error.code === 'runtime_artifact_path_unsafe' ? 'MEDIA_ARTIFACT_PATH_UNSAFE' : 'MEDIA_ARTIFACT_UNAVAILABLE']
    };
  }
  if (!file) {
    return { media: { status: 'absent', artifactId: null, sha256: null, bytes: null }, evidence: null, errors: ['MEDIA_ARTIFACT_UNAVAILABLE'] };
  }
  const actualSha256 = sha256(file.bytes);
  const declaredMatches = result.media.sha256 !== null && result.media.sha256 === actualSha256
    && (result.media.bytes === null || result.media.bytes === file.bytes.length);
  if (!declaredMatches) {
    return {
      media: { status: 'absent', artifactId: null, sha256: null, bytes: null },
      evidence: null,
      errors: ['MEDIA_HASH_MISMATCH']
    };
  }
  return {
    media: { status: 'verified', artifactId: result.media.artifactId, sha256: actualSha256, bytes: file.bytes.length },
    evidence: { artifactId: result.media.artifactId, sha256: actualSha256, bytes: file.bytes.length, content: file.bytes },
    errors: []
  };
}

function consumeExport(result, exportRoot, mediaEvidence, scopeMatches = true) {
  if (result.export.status === 'not_ready') {
    return {
      export: { status: 'not_ready', artifactId: null },
      errors: result.export.artifactId === null ? [] : ['EXPORT_DECLARATION_IGNORED']
    };
  }
  if (result.export.artifactId === null) return { export: { status: 'not_ready', artifactId: null }, errors: ['EXPORT_ARTIFACT_MISSING'] };
  if (result.state !== 'succeeded') return { export: { status: 'not_ready', artifactId: null }, errors: ['EXPORT_STATE_NOT_SUCCEEDED'] };
  if (result.qa.status !== 'passed') return { export: { status: 'not_ready', artifactId: null }, errors: ['EXPORT_QA_NOT_PASSED'] };
  if (!scopeMatches) return { export: { status: 'not_ready', artifactId: null }, errors: ['EXPORT_ARTIFACT_SCOPE_MISMATCH'] };
  if (!mediaEvidence || !Buffer.isBuffer(mediaEvidence.content)) {
    return { export: { status: 'not_ready', artifactId: null }, errors: ['EXPORT_MEDIA_UNVERIFIED'] };
  }
  let file;
  try {
    file = readContainedFile(exportRoot, result.export.artifactId);
  } catch (error) {
    return {
      export: { status: 'not_ready', artifactId: null },
      errors: [error && error.code === 'runtime_artifact_path_unsafe' ? 'EXPORT_ARTIFACT_PATH_UNSAFE' : 'EXPORT_ARTIFACT_UNAVAILABLE']
    };
  }
  if (!file) return { export: { status: 'not_ready', artifactId: null }, errors: ['EXPORT_ARTIFACT_UNAVAILABLE'] };
  const actualSha256 = sha256(file.bytes);
  const sameBytes = file.bytes.length === mediaEvidence.bytes
    && actualSha256 === mediaEvidence.sha256
    && Buffer.compare(file.bytes, mediaEvidence.content) === 0;
  if (!sameBytes) return { export: { status: 'not_ready', artifactId: null }, errors: ['EXPORT_MEDIA_MISMATCH'] };
  // The export is ready only after the controlled export file is proven to be an exact copy of the verified media bytes.
  return { export: { status: 'ready', artifactId: result.export.artifactId }, errors: [] };
}

function createReadOnlyVideoRuntimeResultAdapter(options = {}) {
  if (!isPlainObject(options)) fail('runtime_configuration_invalid', 'runtime adapter options must be an object');
  if (typeof options.snapshotResolver !== 'function') fail('runtime_configuration_invalid', 'runtime adapter needs a snapshot resolver');
  const resultRoot = rootDirectory(options.resultRoot, 'runtime result root');
  const mediaRoot = rootDirectory(options.mediaRoot || path.join(resultRoot, 'media'), 'runtime media root');
  const exportRoot = rootDirectory(options.exportRoot || path.join(resultRoot, 'export'), 'runtime export root');
  const allowedProjects = options.projectId !== undefined
    ? [safeId(options.projectId, 'projectId')]
    : Array.isArray(options.allowedProjects) && options.allowedProjects.length
      ? [...new Set(options.allowedProjects.map((project) => safeId(project, 'allowedProjects[]')))]
      : fail('runtime_configuration_invalid', 'a runtime project allowlist is required');
  let revisions = new Map();
  let artifactScopes = new Map();

  function claimArtifactScope(kind, artifactId, operationId, binding) {
    if (artifactId === null) return true;
    const key = `${kind}:${artifactId}`;
    const scope = canonicalJson({ operationId, binding });
    const previous = artifactScopes.get(key);
    if (previous && previous.scope !== scope) return false;
    if (!previous) artifactScopes.set(key, { kind, artifactId, operationId, binding, scope });
    return true;
  }

  function read(rawRequest) {
    const request = normalizeRequest(rawRequest);
    const persisted = readConsumptionIndex(resultRoot);
    revisions = new Map(persisted.entries.map((entry) => [entry.operationId, {
      revision: entry.result.revision,
      digest: entry.digest,
      result: entry.result
    }]));
    artifactScopes = new Map(persisted.artifactScopes.map((claim) => [
      `${claim.kind}:${claim.artifactId}`,
      { ...claim, scope: canonicalJson({ operationId: claim.operationId, binding: claim.binding }) }
    ]));
    const resolved = options.snapshotResolver({ briefId: request.briefId, version: request.version });
    if (!resolved || !isPlainObject(resolved.document) || !isPlainObject(resolved.document.identity)) fail('runtime_snapshot_unavailable', 'the current snapshot binding is unavailable');
    if (resolved.document.briefId !== request.briefId || resolved.document.briefVersion !== request.version) fail('runtime_binding_mismatch', 'the trusted snapshot reference does not match the requested version');
    const identity = resolved.document.identity;
    const projectId = safeId(identity.projectId, 'snapshot.identity.projectId');
    if (!allowedProjects.includes(projectId)) fail('runtime_project_forbidden', 'the snapshot project is not authorized for runtime consumption');
    if (request.projectId !== undefined && request.projectId !== projectId) fail('runtime_scope_mismatch', 'the requested project does not match the current snapshot');
    const expectedBinding = {
      projectId,
      briefId: request.briefId,
      briefVersion: request.version,
      snapshotSha256: safeHash(resolved.sha256, 'snapshot.sha256')
    };
    let stored;
    let normalized;
    try {
      stored = readContainedFile(resultRoot, `${request.operationId}.json`, { json: true });
    } catch (error) {
      const recovered = ['runtime_result_invalid', 'runtime_artifact_unavailable', 'runtime_artifact_path_unsafe'].includes(error && error.code)
        ? recoveredBlockedResult(persisted, request, expectedBinding, 'RUNTIME_RESULT_SOURCE_INVALID')
        : null;
      if (recovered) return recovered;
      throw error;
    }
    if (!stored) {
      const recovered = recoveredBlockedResult(persisted, request, expectedBinding, 'RUNTIME_RESULT_SOURCE_UNAVAILABLE');
      if (recovered) return recovered;
      fail('runtime_result_not_found', 'the configured runtime result was not found');
    }
    try {
      normalized = normalizeRuntimeResult(stored.value);
    } catch (error) {
      const recovered = ['runtime_result_invalid', 'runtime_schema_unsupported'].includes(error && error.code)
        ? recoveredBlockedResult(persisted, request, expectedBinding, 'RUNTIME_RESULT_SOURCE_INVALID')
        : null;
      if (recovered) return recovered;
      throw error;
    }
    if (normalized.operationId !== request.operationId) fail('runtime_operation_mismatch', 'runtime result operationId does not match the request');
    if (!sameBinding(normalized.binding, expectedBinding)) fail('runtime_binding_mismatch', 'runtime result binding does not match the current snapshot');
    if (request.requestDigest !== undefined && normalized.requestDigest !== request.requestDigest) fail('runtime_request_mismatch', 'runtime result requestDigest does not match the request');

    const mediaArtifactId = normalized.media.status === 'absent' ? null : normalized.media.artifactId;
    const exportArtifactId = normalized.export.status === 'ready' ? normalized.export.artifactId : null;
    const mediaScopeMatches = claimArtifactScope('media', mediaArtifactId, normalized.operationId, normalized.binding);
    const exportScopeMatches = claimArtifactScope('export', exportArtifactId, normalized.operationId, normalized.binding);
    const media = consumeMedia(normalized, mediaRoot, mediaScopeMatches);
    const exported = consumeExport(normalized, exportRoot, media.evidence, exportScopeMatches);
    let consumed = {
      ...normalized,
      media: media.media,
      export: exported.export,
      errors: [...new Set([...media.errors, ...exported.errors, ...normalized.errors])].slice(0, MAX_CODES)
    };
    const evidenceBlocked = consumed.errors.some((code) => code.startsWith('MEDIA_') || code.startsWith('EXPORT_'));
    if (evidenceBlocked) consumed = blockedResult(consumed, 'RUNTIME_EVIDENCE_BLOCKED');
    const digest = sha256(Buffer.from(canonicalJson(consumed)));
    const previous = revisions.get(request.operationId);
    if (previous && consumed.revision < previous.revision) fail('runtime_revision_stale', 'an older runtime revision was rejected');
    if (previous && consumed.revision === previous.revision && digest !== previous.digest) {
      fail('runtime_revision_conflict', 'the same runtime revision changed its result');
    }
    const nextIndex = indexWithConsumedResult(persisted, consumed, digest, artifactScopes);
    writeConsumptionIndex(resultRoot, nextIndex);
    revisions.set(request.operationId, { revision: consumed.revision, digest, result: consumed });
    return consumed;
  }

  return { read };
}

module.exports = {
  SCHEMA_VERSION,
  STATES,
  CONSUMPTION_INDEX_SCHEMA_VERSION,
  createReadOnlyVideoRuntimeResultAdapter,
  normalizeRuntimeResult
};
