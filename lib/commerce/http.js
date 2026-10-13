'use strict';
/**
 * Task-center HTTP adapter (T2.6): a local engineering adapter exposing the approved commerce
 * modules to the internal operator UI. It is NOT a production auth layer and NOT a sandbox.
 *
 * Contract (recorded in HANDOFF):
 * - Identity vs authorization: the ONLY identity source is the trusted local-operator access
 *   config (`options.access.sessions[].token`), presented via the `x-tasks-session` header.
 *   A session's project grants (role operator|viewer) are the ONLY authorization source. No
 *   cookie, query parameter, projectId/actor/scope/client header or visitor session is ever
 *   trusted. Without config, or without a token, or without a grant for the requested project,
 *   private routes fail closed (401/403); the static page itself carries no private data.
 * - Writes are guarded: same-origin (Host or explicit allowedOrigins) + custom session header +
 *   `application/json` + bounded bodies + per-field allowlists. Errors carry a code and a safe
 *   message only (paths/SQL/credentials are never echoed). The UI renders all untrusted text
 *   through textContent (no innerHTML).
 * - Private artifacts are resolved ONLY by server-side artifact id through the private registry
 *   (`tasks-ui/artifacts.json`): session -> record ownership (projectId) -> allowed kind
 *   (orchestrator-artifact under the task workdir; asset under a configured read-only asset
 *   root) -> worker.assertSafePathId/resolveScoped segments + realpath checks -> bounded stream
 *   with a fixed mime map and a sanitized attachment filename. Client paths are never accepted;
 *   hashes are not authorization; the same content in another project keeps its own ownership.
 * - Representative flows reuse the real approved interfaces: imports (table/pdf/scan gating),
 *   run-store/worker/orchestrator (fixture task `fixture-echo.v1` executed by the approved
 *   orchestrator with a server-built plan and registry), budget ledger reads, memory rules and
 *   the read-only shop-materials asset index. No real provider calls, fees or credentials.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ValidationError, ConflictError, NotFoundError } = require('./evidence.js');
const { canonicalJson } = require('./packs.js');
const { assertJsonCompatible } = require('./privacy.js');
const store = require('./run-store.js');
const worker = require('./worker.js');
const idem = require('./idempotency.js');
const budget = require('./budget.js');
const memory = require('./memory.js');
const imports = require('./imports.js');
const assetsLib = require('./assets.js');
const orch = require('./orchestrator.js');
const { createToolRegistry } = require('./tools-registry.js');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_RULE_VALUE_BYTES = 8192;
const SESSION_HEADER = 'x-tasks-session';
const ARTIFACT_ID_RE = /^[a-f0-9]{32}$/;
const UPLOAD_KINDS = Object.freeze({ '.csv': 'table', '.xlsx': 'table', '.pdf': 'pdf', '.png': 'scan', '.jpg': 'scan', '.jpeg': 'scan' });
const ASSET_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf'
});
const FIXTURE_TASKS = Object.freeze(['fixture-echo.v1']);
const FIXTURE_STEP_ID = 'echo';
const CURRENCIES = Object.freeze(['USD', 'CNY', 'EUR']);
/** Operation states that can never be treated as reconciled for a redo. */
const UNRESOLVED_OPERATION_STATES = Object.freeze(['claimed', 'submitted', 'pending_reconcile']);
const DECLARED_FIELDS = Object.freeze({
  runs: ['task', 'input'],
  redo: [],
  cancel: ['reason'],
  upload: ['fileName', 'supplierKey', 'contentBase64', 'observedAt'],
  confirm: ['observedAt'],
  correct: ['correctedValue', 'correctedUnit', 'correctedCurrency', 'correctedIncoterm', 'correctedNumber'],
  memoryCandidate: ['scope', 'scopeKey', 'ruleKey', 'value', 'source'],
  memoryConfirm: ['source'],
  memoryCorrect: ['value', 'source'],
  preference: ['purpose', 'note']
});

function fail(message) {
  throw new ValidationError(message);
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
  return value.trim();
}
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function httpError(status, code, message) {
  return Object.assign(new Error(message), { httpStatus: status, code });
}
/** Write-body field allowlist: plain object, declared keys only (fail-closed before any effect). */
function rejectUnknownFields(body, allowed, label = 'body') {
  if (!isPlainObject(body)) throw httpError(400, 'invalid_body', `${label} must be a JSON object.`);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw httpError(400, 'unknown_field', `${label}.${key} is not a declared field.`);
  }
  return body;
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function safeDownloadName(relPath) {
  const base = path.basename(String(relPath));
  const cleaned = base.replace(/[^\w.-]/g, '_').slice(0, 120);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'artifact' : cleaned;
}
function sendJson(res, status, value) {
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(value));
  } catch {
    // client may have disconnected; never crash the local server for that
  }
}
function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}
/** Error messages never echo filesystem paths, SQL or credential-shaped values. */
function safeErrorMessage(error) {
  const message = typeof error.message === 'string' ? error.message : '';
  if (message === '' || /[A-Za-z]:\\|\\\\|\//.test(message)) return 'Request could not be completed.';
  return message;
}

function mapDocument(row) {
  if (!row) return null;
  return {
    documentId: row.document_id,
    supplierKey: row.supplier_key,
    parserVersion: row.parser_version ?? null,
    rawSha256: row.raw_sha256 ?? null,
    fileRef: row.file_ref ?? null,
    byteSize: row.byte_size ?? null,
    format: row.format ?? null,
    localization: row.localization ?? null,
    status: row.status ?? null,
    createdAt: row.created_at ?? null
  };
}
function mapCandidate(row) {
  if (!row) return null;
  return {
    candidateId: row.candidate_id,
    documentId: row.document_id,
    fieldKey: row.field_key,
    rawValue: row.raw_value ?? null,
    numericValue: row.numeric_value ?? null,
    currency: row.currency ?? null,
    unit: row.unit ?? null,
    incoterm: row.incoterm ?? null,
    reasons: row.reasons ?? null,
    status: row.status,
    subjectKey: row.subject_key ?? null,
    snippet: row.snippet ?? null,
    sheet: row.sheet ?? null,
    rowNumber: row.row_number ?? null,
    columnRef: row.column_ref ?? null,
    method: row.method ?? null,
    createdAt: row.created_at ?? null,
    supersededBy: row.superseded_by ?? null
  };
}
function mapScanPage(row) {
  return {
    imageIndex: row.image_index ?? null,
    status: row.status ?? null,
    reason: row.reason ?? null,
    pageResultId: row.page_result_id ?? null
  };
}
function mapRule(rule) {
  if (!rule) return null;
  return {
    id: rule.id,
    scope: rule.scope,
    scopeKey: rule.scopeKey,
    ruleKey: rule.ruleKey,
    value: rule.value,
    source: rule.source ?? null,
    status: rule.status,
    version: rule.version,
    supersededBy: rule.supersededBy ?? null,
    createdAt: rule.createdAt ?? null
  };
}
function mapReservation(reservation) {
  return {
    reservationId: reservation.reservationId,
    status: reservation.status,
    category: reservation.category,
    currency: reservation.currency,
    holdMicros: reservation.holdMicros,
    pendingMicros: reservation.pendingMicros,
    settledMicros: reservation.settledMicros ?? null,
    releasedMicros: reservation.releasedMicros ?? null,
    overrunMicros: reservation.overrunMicros ?? null,
    priceConfidence: reservation.priceConfidence,
    remoteId: reservation.remoteId ?? null,
    operationId: reservation.operationId
  };
}

function createTasksHttp(options = {}) {
  if (!isPlainObject(options)) fail('options must be a plain object');
  const db = options.db;
  if (!db || typeof db.prepare !== 'function') fail('options.db must be a SQLite handle (openDb)');
  const storageRoot = path.resolve(requireNonEmptyString(options.storageRoot, 'options.storageRoot'));
  const tasksDir = path.join(storageRoot, 'tasks-ui');
  const workdir = path.join(tasksDir, 'workdir');
  const uploadsDir = path.join(tasksDir, 'uploads');
  const recordsDir = path.join(tasksDir, 'runs');
  const artifactsFile = path.join(tasksDir, 'artifacts.json');
  const preferencesFile = path.join(tasksDir, 'asset-preferences.json');
  for (const dir of [tasksDir, workdir, uploadsDir, recordsDir]) fs.mkdirSync(dir, { recursive: true });

  // ---- trusted access config: identity + project authorization (local operator only) ----
  const sessionsByToken = new Map();
  if (options.access !== undefined && options.access !== null) {
    if (!isPlainObject(options.access) || !Array.isArray(options.access.sessions)) fail('options.access must be { sessions: [...] }');
    for (const entry of options.access.sessions) {
      if (!isPlainObject(entry)) fail('access.sessions entries must be plain objects');
      const token = requireNonEmptyString(entry.token, 'access.sessions[].token');
      if (token.length < 16) fail('access session tokens must be at least 16 characters');
      const actor = requireNonEmptyString(entry.actor, 'access.sessions[].actor');
      const grants = Object.create(null);
      const projects = entry.projects ?? {};
      if (!isPlainObject(projects)) fail('access.sessions[].projects must be a plain object');
      for (const [projectId, grant] of Object.entries(projects)) {
        requireNonEmptyString(projectId, 'access project id');
        if (!isPlainObject(grant) || !['operator', 'viewer'].includes(grant.role)) fail(`access role for ${projectId} must be operator|viewer`);
        grants[projectId] = Object.freeze({ role: grant.role });
      }
      sessionsByToken.set(token, Object.freeze({ actor, internal: entry.internal === true, projects: Object.freeze(grants) }));
    }
  }
  const allowedOrigins = Array.isArray(options.allowedOrigins) ? options.allowedOrigins.map((origin) => String(origin)) : [];
  const clock = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const assetConfig = isPlainObject(options.assets) ? options.assets : null;

  // ---- session / authorization / write guards (fail-closed) ----
  function sessionOf(req) {
    const raw = req.headers[SESSION_HEADER];
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return null;
    return sessionsByToken.get(raw) ?? null;
  }
  function requireSession(req) {
    const session = sessionOf(req);
    if (!session) throw httpError(401, 'authentication_required', 'A trusted local operator session is required.');
    return session;
  }
  function requireProject(session, projectId, mode) {
    // authorization is an OWN property of a null-prototype grant dict: inherited names
    // (constructor, toString, __proto__, ...) are never grants (F1)
    const grant = hasOwn(session.projects, projectId) ? session.projects[projectId] : undefined;
    if (!grant) throw httpError(403, 'project_forbidden', 'This session is not authorized for the requested project.');
    if (mode === 'write' && grant.role !== 'operator') throw httpError(403, 'write_forbidden', 'Viewer sessions cannot perform writes.');
    return grant;
  }
  function requireWriteGuards(req) {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      const host = String(req.headers.host || '');
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { originHost = ''; }
      if (!originHost || (originHost !== host && !allowedOrigins.includes(origin))) {
        throw httpError(403, 'origin_forbidden', 'Cross-origin writes are not allowed.');
      }
    }
    // a real JSON MIME only: application/json with optional parameters (application/jsonp fails)
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (mime !== 'application/json') throw httpError(415, 'unsupported_media_type', 'Writes must use application/json.');
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let total = 0;
      let stopped = false;
      const chunks = [];
      req.on('data', (chunk) => {
        if (stopped) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          stopped = true;
          reject(httpError(413, 'too_large', 'Request body is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (stopped) return;
        try {
          resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(httpError(400, 'invalid_json', 'Request body must be JSON.'));
        }
      });
      req.on('error', () => reject(httpError(400, 'invalid_request', 'Unable to read request.')));
    });
  }

  // ---- private artifact registry (server-side ids only; never client paths) ----
  function readArtifactRegistry() {
    const parsed = readJsonIfExists(artifactsFile);
    return parsed && isPlainObject(parsed.records) ? parsed : { schemaVersion: 1, records: {} };
  }
  function upsertArtifactRecord(record) {
    const registry = readArtifactRegistry();
    const existing = hasOwn(registry.records, record.artifactId) ? registry.records[record.artifactId] : undefined;
    if (existing && existing.projectId !== record.projectId) {
      throw httpError(409, 'artifact_ownership_conflict', 'Artifact ownership is immutable.');
    }
    registry.records[record.artifactId] = record;
    writeJsonAtomic(artifactsFile, registry);
    return record;
  }
  function artifactIdFor(kind, identity) {
    return sha256Hex(`${kind}|${identity}`).slice(0, 32);
  }
  function registerRunArtifacts(projectId, runId) {
    const run = store.getRun(db, projectId, runId);
    const artifacts = run && run.checkpoint && run.checkpoint.orchestrator ? run.checkpoint.orchestrator.artifacts ?? {} : {};
    const refs = [];
    for (const [stepId, meta] of Object.entries(artifacts)) {
      const artifactId = artifactIdFor('orchestrator-artifact', `${projectId}|${runId}|${stepId}|${meta.sha}`);
      upsertArtifactRecord({
        artifactId,
        projectId,
        kind: 'orchestrator-artifact',
        runId,
        stepId,
        relPath: meta.ref,
        sha256: meta.sha,
        createdAt: clock()
      });
      refs.push({ artifactId, stepId, sha256: meta.sha, relPath: meta.ref });
    }
    return refs;
  }
  function assetRootFor(rootId, projectId) {
    const roots = assetConfig && isPlainObject(assetConfig.roots) ? assetConfig.roots : {};
    if (!hasOwn(roots, rootId)) throw httpError(404, 'asset_root_unknown', 'Asset root is not configured.');
    const entry = roots[rootId];
    if (typeof entry === 'string' && entry !== '') return path.resolve(entry); // trusted explicit shared root
    if (isPlainObject(entry) && typeof entry.path === 'string' && entry.path !== '') {
      const allowedProjects = Array.isArray(entry.projects) ? entry.projects : [];
      if (!allowedProjects.includes(projectId)) throw httpError(403, 'asset_root_forbidden', 'This asset root is not authorized for the requested project.');
      return path.resolve(entry.path);
    }
    throw httpError(404, 'asset_root_unknown', 'Asset root is not configured.');
  }
  function resolveArtifactFile(record) {
    if (record.kind === 'orchestrator-artifact') {
      const file = worker.resolveScoped(workdir, String(record.relPath).split('/'), 'artifact');
      return { root: workdir, file, mime: 'application/json' };
    }
    if (record.kind === 'asset') {
      const root = assetRootFor(record.rootId, record.projectId);
      const file = worker.resolveScoped(root, String(record.relPath).split('/'), 'asset');
      const mime = ASSET_MIME[path.extname(file).toLowerCase()];
      if (!mime) throw httpError(403, 'asset_type_not_allowed', 'This asset type cannot be served.');
      return { root, file, mime };
    }
    throw httpError(404, 'artifact_kind_unknown', 'Artifact kind is not allowed.');
  }
  async function handleArtifactDownload(res, session, artifactId) {
    if (!ARTIFACT_ID_RE.test(String(artifactId))) throw httpError(400, 'artifact_id_invalid', 'Artifact id is not valid.');
    const record = readArtifactRegistry().records[artifactId];
    if (!record) throw httpError(404, 'artifact_unknown', 'Artifact not found.');
    requireProject(session, record.projectId, 'view');
    const { root, file, mime } = resolveArtifactFile(record);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw httpError(404, 'artifact_missing', 'Artifact is not available.');
    }
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) throw httpError(403, 'artifact_not_servable', 'Artifact is not servable.');
    const realFile = fs.realpathSync(file);
    const realRoot = fs.realpathSync(root);
    if (!(realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`))) {
      throw httpError(403, 'artifact_outside_root', 'Artifact is not servable.');
    }
    const body = fs.readFileSync(realFile);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadName(record.relPath))}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  }

  // ---- representative flow 1: imports (real bytes through the approved parsers) ----
  async function handleUpload(session, projectId, body) {
    const fileName = requireNonEmptyString(body.fileName, 'fileName');
    if (path.basename(fileName) !== fileName || fileName.length > 160) throw httpError(400, 'validation', 'fileName must be a plain file name.');
    const ext = path.extname(fileName).toLowerCase();
    const kind = UPLOAD_KINDS[ext];
    if (!kind) throw httpError(415, 'unsupported_type', 'Only csv/xlsx/pdf/png/jpg uploads are supported.');
    const supplierKey = requireNonEmptyString(body.supplierKey === undefined ? 'ui-upload' : body.supplierKey, 'supplierKey');
    if (supplierKey.length > 64) throw httpError(400, 'validation', 'supplierKey is too long.');
    const encoded = body.contentBase64;
    const maxEncoded = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4;
    if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > maxEncoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw httpError(400, 'validation', 'contentBase64 must be strict base64.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) throw httpError(413, 'too_large', 'Uploaded content is too large.');
    // the client never supplies a path: the server writes its own private upload file
    const storedName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(uploadsDir, storedName);
    fs.writeFileSync(filePath, bytes);
    if (kind === 'scan') {
      return {
        status: 'blocked',
        reason: 'scan_requires_s1_permit',
        note: 'No OCR permit is configured on this local server; no provider call was performed.',
        storedFileName: storedName
      };
    }
    const observedAt = typeof body.observedAt === 'string' && body.observedAt !== '' ? body.observedAt : undefined;
    const result = kind === 'table'
      ? await imports.importTable(db, projectId, { filePath, supplierKey, observedAt })
      : await imports.importPdfText(db, projectId, { filePath, supplierKey, observedAt });
    return {
      status: result.status,
      document: mapDocument(result.document),
      candidates: (result.candidates ?? []).map(mapCandidate),
      extraction: result.extraction ?? null,
      conflicts: result.conflicts ?? null,
      counts: result.counts ?? null
    };
  }

  // ---- representative flow 2: fixture task runs via the approved orchestrator ----
  function fixtureEchoPlan(input) {
    return {
      schemaVersion: 1,
      taskType: 'fixture-echo.v1',
      steps: [{
        id: FIXTURE_STEP_ID,
        role: 'quality',
        tool: 'ui.fixture-echo',
        input: { text: input.text },
        quality: { requireFields: ['echo'] }
      }]
    };
  }
  function fixtureRegistry() {
    const registry = createToolRegistry({ roles: orch.ROLES });
    registry.register({
      name: 'ui.fixture-echo', version: '1.0.0', roles: ['quality'], kind: 'local',
      inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 200 } }, additionalProperties: false },
      outputSchema: { type: 'object', required: ['echo'], properties: { echo: { type: 'string' } }, additionalProperties: false },
      costPolicy: { kind: 'mock_no_charge', currency: 'USD' }
    }, async ({ input }) => ({ status: 'succeeded', output: { echo: `echo:${input.text}` } }));
    return registry;
  }
  function validateFixtureInput(raw) {
    if (!isPlainObject(raw) || typeof raw.text !== 'string' || raw.text.trim() === '' || raw.text.length > 200) {
      throw httpError(400, 'validation', 'input.text must be a string of 1-200 characters.');
    }
    for (const key of Object.keys(raw)) {
      if (key !== 'text') throw httpError(400, 'unknown_field', `input.${key} is not a declared field.`);
    }
    return { text: raw.text };
  }
  function fixtureOperationIdFor(runId, input) {
    return worker.operationIdFor(runId, FIXTURE_STEP_ID, sha256Hex(canonicalJson({ text: input.text })));
  }
  function runRecordPath(runId) {
    return path.join(recordsDir, `${worker.assertSafePathId(runId, 'runId')}.json`);
  }
  function writeRunRecord(record) {
    writeJsonAtomic(runRecordPath(record.runId), record);
  }
  function readRunRecord(runId) {
    return readJsonIfExists(runRecordPath(runId));
  }
  async function executeFixtureRun(projectId, task, input, retryOf, existingRunId) {
    const plan = fixtureEchoPlan(input);
    const registry = fixtureRegistry();
    const result = await orch.runOrchestratorOnce(db, {
      projectId,
      runId: existingRunId ?? undefined,
      owner: 'tasks-ui',
      ttlSeconds: 120,
      now: clock(),
      clock,
      plan,
      registry,
      workerDir: workdir,
      inputVersion: 'ui-v1'
    });
    const runId = result.run.id;
    const artifacts = registerRunArtifacts(projectId, runId);
    const record = {
      schemaVersion: 1,
      runId,
      projectId,
      task,
      input,
      inputVersion: 'ui-v1',
      retryOf: retryOf ?? null,
      status: result.status,
      reason: result.reason ?? null,
      artifacts,
      createdAt: clock()
    };
    writeRunRecord(record);
    return { runId, status: result.status, reason: result.reason ?? null, retryOf: retryOf ?? null, artifacts };
  }
  async function createRun(session, projectId, body) {
    rejectUnknownFields(body, DECLARED_FIELDS.runs);
    const task = requireNonEmptyString(body.task, 'task');
    if (!FIXTURE_TASKS.includes(task)) throw httpError(400, 'task_not_allowed', 'Only the allowlisted fixture task is available in this build.');
    const input = validateFixtureInput(body.input);
    return executeFixtureRun(projectId, task, input, null);
  }
  function listRuns(projectId) {
    return store.listRuns(db, projectId, {}).map((run) => {
      const record = readRunRecord(run.id);
      return {
        runId: run.id,
        status: run.status,
        taskType: run.taskType,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedSteps: run.checkpoint && Array.isArray(run.checkpoint.completedSteps) ? run.checkpoint.completedSteps.length : 0,
        retryOf: record ? record.retryOf ?? null : null
      };
    });
  }
  function runDetail(projectId, runId) {
    const run = store.getRun(db, projectId, runId);
    if (!run) throw httpError(404, 'run_not_found', 'Run not found.');
    const record = readRunRecord(runId);
    const checkpoint = run.checkpoint ?? null;
    const journal = orch.readJournal(workdir, runId).slice(-100);
    const events = store.listEvents(db, projectId, runId).map((event) => ({
      eventType: event.eventType,
      actor: event.actor ?? null,
      payload: event.payload ?? null,
      createdAt: event.createdAt
    }));
    const reservations = budget.listReservations(db, { project: projectId, brand: null, currency: 'USD' })
      .filter((reservation) => typeof reservation.operationId === 'string' && reservation.operationId.startsWith(`${runId}:`));
    return {
      runId,
      projectId,
      taskType: run.taskType,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      checkpoint: {
        completedSteps: checkpoint && Array.isArray(checkpoint.completedSteps) ? checkpoint.completedSteps : [],
        finishedAt: checkpoint && checkpoint.orchestrator ? checkpoint.orchestrator.finishedAt ?? null : null,
        bindingHash: checkpoint && checkpoint.orchestrator ? checkpoint.orchestrator.bindingHash ?? null : null
      },
      task: record ? { name: record.task, inputVersion: record.inputVersion, retryOf: record.retryOf ?? null } : null,
      artifacts: record ? record.artifacts : [],
      journal,
      events,
      reservations: reservations.map(mapReservation)
    };
  }
  function cancelRun(session, projectId, runId, body) {
    const run = store.getRun(db, projectId, runId);
    if (!run) throw httpError(404, 'run_not_found', 'Run not found.');
    if (store.TERMINAL_STATES.includes(run.status)) throw httpError(409, 'already_terminal', 'This run is already terminal and is never revived.');
    const reason = body && typeof body.reason === 'string' && body.reason !== '' ? body.reason.slice(0, 200) : 'cancel requested from the task center';
    if (run.status === 'queued' || run.status === 'blocked') {
      const cancelled = store.cancelRun(db, projectId, runId, { reason, actor: session.actor, now: clock() });
      return { runId, status: cancelled.status, note: 'Cancellation never guarantees a refund of an already submitted upstream task.' };
    }
    worker.requestCancel(workdir, runId, { actor: session.actor, reason, now: clock() });
    return { runId, status: 'cancel_requested', note: 'The cancel request is honored between steps; a submitted upstream task is not guaranteed to be refunded.' };
  }
  async function redoRun(session, projectId, runId) {
    const sourceRun = store.getRun(db, projectId, runId);
    if (!sourceRun) throw httpError(404, 'run_not_found', 'Run not found.');
    if (!store.TERMINAL_STATES.includes(sourceRun.status)) throw httpError(409, 'not_terminal', 'Only a terminal run can be redone; the original run is never revived.');
    if (sourceRun.taskType !== orch.TASK_TYPE) throw httpError(409, 'task_type_isolation', 'Only fixture orchestrator runs can be redone from the task center.');
    let record = null;
    try { record = readRunRecord(runId); } catch { throw httpError(409, 'run_record_corrupt', 'The stored run record is corrupt; refusing a redo (fail-closed).'); }
    if (!record) throw httpError(404, 'run_record_missing', 'No task input record exists for this run.');
    if (record.runId !== runId) throw httpError(409, 'record_identity_mismatch', 'The stored record does not belong to this run.');
    if (record.projectId !== projectId) throw httpError(403, 'run_record_forbidden', 'The run record does not belong to this project.');
    if (!FIXTURE_TASKS.includes(record.task)) throw httpError(400, 'task_not_allowed', 'The recorded task is not allowlisted.');
    const input = validateFixtureInput(record.input);

    // ---- original-binding authority (G3b): the record is mutable evidence, so before ANY effect the
    // redo re-proves it against the ORIGINAL canonical checkpoint binding + the persisted bound plan.
    // A mutated record.input must never derive a different operation identity that skips the
    // original submitted/held authority (fail-closed 409, zero effect).
    const checkpoint = isPlainObject(sourceRun.checkpoint) ? sourceRun.checkpoint : null;
    const orchestratorState = checkpoint && isPlainObject(checkpoint.orchestrator) ? checkpoint.orchestrator : null;
    const binding = orchestratorState && isPlainObject(orchestratorState.binding) ? orchestratorState.binding : null;
    if (!binding || typeof orchestratorState.bindingHash !== 'string' || orchestratorState.bindingHash === '') {
      throw httpError(409, 'binding_unavailable', 'The original run has no canonical identity binding; refusing a redo (fail-closed).');
    }
    if (sha256Hex(canonicalJson(binding)) !== orchestratorState.bindingHash) {
      throw httpError(409, 'binding_corrupt', 'The original run binding does not match its recorded binding hash; refusing a redo (fail-closed).');
    }
    if (binding.projectId !== projectId) throw httpError(409, 'binding_identity_mismatch', 'The original binding belongs to another project; refusing a redo.');
    if (binding.inputVersion !== record.inputVersion) throw httpError(409, 'binding_version_mismatch', 'The stored record input version does not match the original binding; refusing a redo.');
    let planFile = null;
    try {
      planFile = readJsonIfExists(worker.resolveScoped(workdir, ['orchestrator', runId, 'plan.json'], 'orchestrator plan'));
    } catch { planFile = null; }
    if (!planFile || !isPlainObject(planFile.plan) || !isPlainObject(planFile.binding) || !Array.isArray(planFile.plan.steps)) {
      throw httpError(409, 'binding_unavailable', 'The original bound plan evidence is missing or corrupt; refusing a redo (fail-closed).');
    }
    if (!orch.bindingsMatch(planFile.binding, binding)) {
      throw httpError(409, 'binding_corrupt', 'The original plan binding does not match the run checkpoint binding; refusing a redo (fail-closed).');
    }
    const boundPlanHash = sha256Hex(canonicalJson(planFile.plan));
    const boundInputHash = sha256Hex(canonicalJson(planFile.plan.steps.map((step) => ({ id: step.id, input: step.input }))));
    if (boundPlanHash !== binding.planHash || boundInputHash !== binding.inputHash) {
      throw httpError(409, 'binding_mismatch', 'The original bound plan does not reproduce the recorded identity binding; refusing a redo (fail-closed).');
    }
    const boundStep = planFile.plan.steps.find((step) => step.id === FIXTURE_STEP_ID);
    if (!boundStep || canonicalJson(boundStep.input) !== canonicalJson(input)) {
      throw httpError(409, 'binding_input_mismatch', 'The stored record input no longer matches the original bound step input; refusing a redo (fail-closed).');
    }

    // ---- reconciliation gate references the ORIGINAL authority identity (both the fixture step id
    // convention and the orchestrator binding-input id), never an id re-derived from the record.
    // Holds are scanned across every attempt of this run: a resolved current attempt must not hide
    // another unresolved hold, and an unreferenced hold is never treated as free.
    const candidateOperationIds = [
      fixtureOperationIdFor(runId, { text: boundStep.input.text }),
      worker.operationIdFor(runId, FIXTURE_STEP_ID, binding.inputHash)
    ];
    const operations = [];
    for (const candidateId of candidateOperationIds) {
      const operation = idem.getOperation(db, candidateId);
      if (operation) operations.push(operation);
    }
    let unresolved = null;
    for (const operation of operations) {
      if (!idem.OPERATION_STATES.includes(operation.state)) { unresolved = 'operation_state_unrecognized'; break; }
      if (UNRESOLVED_OPERATION_STATES.includes(operation.state)) { unresolved = `operation_${operation.state}`; break; }
    }
    const isOpenHold = (reservation) => reservation && (
      reservation.status === 'reserved' ||
      (reservation.status !== 'settled' && reservation.status !== 'released' && Number.isFinite(reservation.pendingMicros) && reservation.pendingMicros > 0)
    );
    const openHolds = budget.listReservations(db, { project: projectId, brand: null, currency: 'USD' })
      .filter((reservation) => typeof reservation.operationId === 'string' && reservation.operationId.startsWith(`${runId}:`) && isOpenHold(reservation));
    if (!unresolved && openHolds.length > 0) {
      const cancelled = operations.some((operation) => operation.state === 'cancelled');
      unresolved = cancelled ? 'cancelled_unsettled_hold' : (operations.length > 0 ? 'unsettled_hold' : 'orphan_unresolved_hold');
    }
    if (unresolved) {
      throw httpError(409, 'unresolved_operation', `The source run has an unresolved charged state (${unresolved}); reconcile before a redo (no blind resend).`);
    }
    const retry = store.createRun(db, projectId, { taskType: orch.TASK_TYPE, actor: session.actor, retryOf: runId, now: clock() });
    const result = await executeFixtureRun(projectId, record.task, input, runId, retry.id);
    return { ...result, runId: retry.id, status: result.status };
  }

  // ---- representative flow 3: memory rules + read-only asset index ----
  function loadAssetIndex() {
    if (!assetConfig || typeof assetConfig.indexFilePath !== 'string' || assetConfig.indexFilePath === '') return null;
    const parsed = readJsonIfExists(path.resolve(assetConfig.indexFilePath));
    if (!parsed || !Array.isArray(parsed.files)) throw httpError(503, 'asset_index_unavailable', 'The configured asset index is unavailable.');
    return parsed;
  }
  function handleAssetsList(projectId, url) {
    const index = loadAssetIndex();
    if (!index) return { configured: false, files: [], note: 'No asset index is configured on this local server.' };
    assetRootFor(index.sourceRootId, projectId); // trusted root authorization before any listing (F2)
    const familyKey = url.searchParams.get('familyKey');
    const role = url.searchParams.get('role');
    const language = url.searchParams.get('language');
    let files;
    if (familyKey) {
      const retrieved = assetsLib.retrieve(index, { familyKey, role: role ?? undefined, language: language ?? undefined });
      files = retrieved.matches;
    } else {
      files = index.files.filter((file) => !file.ignored);
      if (role) files = files.filter((file) => file.role === role);
      if (language) files = files.filter((file) => file.language === language);
    }
    const listed = [];
    for (const file of files.slice(0, 200)) {
      // project identity is part of the asset id: the same shared bytes keep DISTINCT, stable,
      // immutable per-project ownership (hash dedup is never authorization) (F2)
      const artifactId = artifactIdFor('asset', `${projectId}|${index.sourceRootId}|${file.relPath}|${file.sha256 ?? 'nohash'}`);
      upsertArtifactRecord({
        artifactId,
        projectId,
        kind: 'asset',
        rootId: index.sourceRootId,
        relPath: file.relPath,
        sha256: file.sha256 ?? null,
        createdAt: clock()
      });
      listed.push({
        artifactId,
        relPath: file.relPath,
        sha256: file.sha256 ?? null,
        size: file.size ?? null,
        format: file.format ?? null,
        familyKey: file.familyKey ?? null,
        role: file.role ?? null,
        roleStatus: file.roleStatus ?? null,
        language: file.language ?? null,
        usageCandidates: Array.isArray(file.usageCandidates) ? file.usageCandidates : [],
        skuCandidates: Array.isArray(file.skuCandidates) ? file.skuCandidates : [],
        designSetId: file.designSetId ?? null,
        ratio: file.ratio ?? null,
        nickname: file.nickname ?? null,
        aliases: Array.isArray(file.aliases) ? file.aliases : []
      });
    }
    return {
      configured: true,
      sourceRootId: index.sourceRootId,
      scannedAt: index.scannedAt ?? null,
      total: files.length,
      files: listed,
      noCrossFamilyFallback: true,
      note: 'Content hashes are dedup evidence, not design identity; SKU/versions stay candidate until confirmed.'
    };
  }
  function readPreferences() {
    const parsed = readJsonIfExists(preferencesFile);
    if (!parsed || !isPlainObject(parsed.projects)) return { schemaVersion: 1, projects: Object.create(null) };
    return parsed;
  }
  function handleAssetPreference(session, projectId, artifactId, body) {
    rejectUnknownFields(body, DECLARED_FIELDS.preference);
    const record = readArtifactRegistry().records[artifactId];
    if (!record || record.kind !== 'asset') throw httpError(404, 'artifact_unknown', 'Artifact not found.');
    if (record.projectId !== projectId) throw httpError(403, 'artifact_forbidden', 'Artifact is not owned by this project.');
    const purpose = body.purpose;
    if (!['MAIN', 'reference'].includes(purpose)) throw httpError(400, 'validation', 'purpose must be MAIN or reference.');
    const note = body.note === undefined || body.note === null ? null : String(body.note).slice(0, 200);
    const preferences = readPreferences();
    if (!hasOwn(preferences.projects, projectId)) preferences.projects[projectId] = {};
    preferences.projects[projectId][artifactId] = {
      purpose,
      note,
      sha256: record.sha256 ?? null,
      relPath: record.relPath,
      actor: session.actor,
      updatedAt: clock()
    };
    writeJsonAtomic(preferencesFile, preferences);
    return preferences.projects[projectId][artifactId];
  }

  // ---- read models ----
  function budgetSummary(projectId, currencyParam) {
    const currency = currencyParam === null || currencyParam === undefined || currencyParam === '' ? 'USD' : String(currencyParam);
    if (!CURRENCIES.includes(currency)) throw httpError(400, 'validation', `currency must be one of ${CURRENCIES.join(', ')}`);
    const pool = budget.getBudgetPool(db, { project: projectId, brand: null, currency });
    const reservations = budget.listReservations(db, { project: projectId, brand: null, currency });
    return {
      configured: Boolean(pool),
      currency,
      spentMicros: pool ? pool.spentMicros : 0,
      reservedMicros: pool ? pool.reservedMicros : 0,
      overrunMicros: pool ? pool.overrunMicros : 0,
      reservations: reservations.map(mapReservation),
      note: 'Reservations and estimates are engineering records, not verified final costs.'
    };
  }
  function projectSummary(projectId) {
    const runs = store.listRuns(db, projectId, {});
    const byStatus = {};
    for (const run of runs) byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    return {
      projectId,
      runs: { total: runs.length, byStatus },
      documents: imports.listDocuments(db, projectId).length,
      memoryRules: memory.listRules(db, projectId).length,
      budget: budgetSummary(projectId, 'USD')
    };
  }

  async function routeProject(req, res, url, session, projectId, rest) {
    const head = rest[0];
    if (req.method === 'GET' && rest.length === 1 && head === 'summary') return sendJson(res, 200, { data: projectSummary(projectId) });
    if (req.method === 'GET' && rest.length === 1 && head === 'budget') return sendJson(res, 200, { data: budgetSummary(projectId, url.searchParams.get('currency')) });
    if (req.method === 'GET' && rest.length === 1 && head === 'runs') return sendJson(res, 200, { data: { runs: listRuns(projectId) } });
    if (req.method === 'POST' && rest.length === 1 && head === 'runs') {
      const body = await readBody(req);
      return sendJson(res, 201, { data: await createRun(session, projectId, body) });
    }
    if (head === 'runs' && rest.length >= 2) {
      const runId = rest[1];
      worker.assertSafePathId(runId, 'runId');
      if (req.method === 'GET' && rest.length === 2) return sendJson(res, 200, { data: runDetail(projectId, runId) });
      if (req.method === 'POST' && rest.length === 3 && rest[2] === 'cancel') {
        const body = await readBody(req);
        rejectUnknownFields(body, DECLARED_FIELDS.cancel);
        return sendJson(res, 200, { data: cancelRun(session, projectId, runId, body) });
      }
      if (req.method === 'POST' && rest.length === 3 && rest[2] === 'redo') {
        const body = await readBody(req);
        rejectUnknownFields(body, DECLARED_FIELDS.redo);
        return sendJson(res, 201, { data: await redoRun(session, projectId, runId) });
      }
    }
    if (req.method === 'GET' && rest.length === 1 && head === 'imports') {
      return sendJson(res, 200, { data: { documents: imports.listDocuments(db, projectId).map(mapDocument) } });
    }
    if (req.method === 'POST' && rest.length === 1 && head === 'imports') {
      const body = await readBody(req);
      rejectUnknownFields(body, DECLARED_FIELDS.upload);
      const result = await handleUpload(session, projectId, body);
      return sendJson(res, result.status === 'blocked' ? 409 : 201, { data: result });
    }
    if (head === 'imports' && rest.length === 2 && req.method === 'GET') {
      const documentId = rest[1];
      const document = imports.getDocument(db, projectId, documentId);
      if (!document) throw httpError(404, 'document_not_found', 'Document not found.');
      return sendJson(res, 200, {
        data: {
          document: mapDocument(document),
          candidates: imports.listCandidates(db, projectId, { documentId }).map(mapCandidate),
          scanPages: imports.listScanPages(db, projectId, documentId).map(mapScanPage)
        }
      });
    }
    if (head === 'candidates' && rest.length === 3 && req.method === 'POST') {
      const candidateId = rest[1];
      const action = rest[2];
      const body = await readBody(req);
      if (action === 'confirm') {
        rejectUnknownFields(body, DECLARED_FIELDS.confirm);
        const outcome = imports.confirmCandidate(db, projectId, { candidateId, observedAt: body.observedAt, now: clock() });
        return sendJson(res, 200, {
          data: {
            candidate: mapCandidate(imports.getCandidate(db, projectId, candidateId)),
            observation: outcome && outcome.observation
              ? { id: outcome.observation.id, value: outcome.observation.value ?? null, observedAt: outcome.observation.observedAt ?? null }
              : null
          }
        });
      }
      if (action === 'correct') {
        rejectUnknownFields(body, DECLARED_FIELDS.correct);
        const outcome = imports.correctCandidate(db, projectId, {
          candidateId,
          correctedValue: body.correctedValue,
          correctedUnit: body.correctedUnit,
          correctedCurrency: body.correctedCurrency,
          correctedIncoterm: body.correctedIncoterm,
          correctedNumber: body.correctedNumber,
          now: clock()
        });
        const candidate = outcome && outcome.candidate ? outcome.candidate : imports.getCandidate(db, projectId, candidateId);
        return sendJson(res, 200, { data: { candidate: mapCandidate(candidate) } });
      }
      throw httpError(404, 'not_found', 'Not found.');
    }
    if (head === 'memory' && rest.length === 1 && req.method === 'GET') {
      const filters = {};
      if (url.searchParams.get('scope')) filters.scope = url.searchParams.get('scope');
      if (url.searchParams.get('scopeKey')) filters.scopeKey = url.searchParams.get('scopeKey');
      if (url.searchParams.get('status')) filters.status = url.searchParams.get('status');
      return sendJson(res, 200, { data: { rules: memory.listRules(db, projectId, filters).map(mapRule) } });
    }
    if (head === 'memory' && rest.length === 2 && rest[1] === 'candidates' && req.method === 'POST') {
      const body = await readBody(req);
      rejectUnknownFields(body, DECLARED_FIELDS.memoryCandidate);
      assertJsonCompatible(body.value, 'value');
      if (Buffer.byteLength(canonicalJson(body.value), 'utf8') > MAX_RULE_VALUE_BYTES) throw httpError(413, 'too_large', 'Rule value is too large.');
      const rule = memory.createCandidate(db, projectId, {
        scope: body.scope,
        scopeKey: body.scopeKey,
        ruleKey: body.ruleKey,
        value: body.value,
        source: body.source
      });
      return sendJson(res, 201, { data: { rule: mapRule(rule) } });
    }
    if (head === 'memory' && rest.length === 3 && req.method === 'POST') {
      const ruleId = rest[1];
      const action = rest[2];
      const body = await readBody(req);
      if (action === 'confirm') {
        rejectUnknownFields(body, DECLARED_FIELDS.memoryConfirm);
        return sendJson(res, 200, { data: { rule: mapRule((memory.confirmRule(db, projectId, ruleId, { source: body.source }) ?? {}).active) } });
      }
      if (action === 'correct') {
        rejectUnknownFields(body, DECLARED_FIELDS.memoryCorrect);
        if (body.value !== undefined) assertJsonCompatible(body.value, 'value');
        return sendJson(res, 200, { data: { rule: mapRule((memory.correctRule(db, projectId, ruleId, { value: body.value, source: body.source }) ?? {}).active) } });
      }
      throw httpError(404, 'not_found', 'Not found.');
    }
    if (head === 'memory' && rest.length === 3 && rest[2] === 'chain' && req.method === 'GET') {
      return sendJson(res, 200, { data: { chain: memory.getRuleChain(db, projectId, rest[1]).map(mapRule) } });
    }
    if (head === 'assets' && rest.length === 2 && rest[1] === 'preferences' && req.method === 'GET') {
      const preferences = readPreferences();
      return sendJson(res, 200, { data: { preferences: hasOwn(preferences.projects, projectId) ? preferences.projects[projectId] : {} } });
    }
    if (head === 'assets' && rest.length === 1 && req.method === 'GET') {
      return sendJson(res, 200, { data: handleAssetsList(projectId, url) });
    }
    if (head === 'assets' && rest.length === 3 && rest[2] === 'preference' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, { data: { preference: handleAssetPreference(session, projectId, rest[1], body) } });
    }
    throw httpError(404, 'not_found', 'Not found.');
  }

  function respondError(res, error) {
    if (error && Number.isInteger(error.httpStatus)) return sendError(res, error.httpStatus, error.code ?? 'request_failed', safeErrorMessage(error));
    if (error instanceof ValidationError) return sendError(res, 400, 'validation', safeErrorMessage(error));
    if (error instanceof ConflictError) return sendError(res, 409, 'conflict', safeErrorMessage(error));
    if (error instanceof NotFoundError) return sendError(res, 404, 'not_found', safeErrorMessage(error));
    return sendError(res, 500, 'internal_error', 'Internal error.');
  }

  async function handle(req, res, url) {
    try {
      const pathname = url.pathname;
      if (pathname === '/tasks-api/session' && req.method === 'GET') {
        const session = sessionOf(req);
        return sendJson(res, 200, {
          data: {
            authenticated: Boolean(session),
            actor: session ? session.actor : null,
            projects: session ? Object.entries(session.projects).map(([projectId, grant]) => ({ projectId, role: grant.role })) : []
          }
        });
      }
      if (!pathname.startsWith('/tasks-api/')) return sendError(res, 404, 'not_found', 'Not found.');
      const segments = pathname.slice('/tasks-api/'.length).split('/').filter(Boolean);
      if (segments[0] === 'artifacts' && segments.length === 3 && segments[2] === 'download' && req.method === 'GET') {
        const session = requireSession(req);
        return await handleArtifactDownload(res, session, segments[1]);
      }
      if (segments[0] === 'projects' && segments.length >= 2) {
        const projectId = requireNonEmptyString(segments[1], 'projectId');
        const rest = segments.slice(2);
        const isWrite = req.method !== 'GET';
        const session = requireSession(req);
        if (isWrite) requireWriteGuards(req);
        requireProject(session, projectId, isWrite ? 'write' : 'view');
        return await routeProject(req, res, url, session, projectId, rest);
      }
      return sendError(res, 404, 'not_found', 'Not found.');
    } catch (error) {
      return respondError(res, error);
    }
  }

  return { handle };
}

module.exports = { createTasksHttp };
