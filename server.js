'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const busboy = require('busboy');

const { loadConfig } = require('./lib/env');
const { assessCandidates, parseCandidateText } = require('./lib/candidates');
const { parsePriceCsv } = require('./lib/csv');
const { createFxService } = require('./lib/fx');
const { compareCompetitors, priceStats, scoreProduct } = require('./lib/intel');
const { analyzeMarket, parseMarketRows } = require('./lib/market');
const { buildPricing } = require('./lib/pricing');
const { normalizeLocale, uiMessage } = require('./lib/messages');
const { MAX_BODY_BYTES, validateInput } = require('./lib/validate');
const { generateContent, interpretIntel } = require('./lib/provider');
const { catalogQueries, createAmazonResearchService, researchPublicAmazon } = require('./lib/amazon-research');
const { buildFeatureDefinitions, summarizeCategory } = require('./lib/product-insights');
const { createReportWorkflowService, resolveReportDownload } = require('./lib/report-workflow');
const { createReportJobs } = require('./lib/report-jobs');
const { createTasksHttp } = require('./lib/commerce/http.js');
const { MAX_PDF_BYTES } = require('./lib/pdf-catalog');
const { capabilities: videoCapabilities, createVideoPlan } = require('./lib/video-workbench');
const { buildAnalysisBrief, rankCandidates } = require('./lib/viral-replica');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const REPORT_SESSION_SECRET_PATH = path.join(ROOT, 'tmp', 'report-session-secret');
function loadReportSessionSecret() {
  fs.mkdirSync(path.dirname(REPORT_SESSION_SECRET_PATH), { recursive: true });
  try {
    const current = fs.readFileSync(REPORT_SESSION_SECRET_PATH);
    if (current.length >= 32) return current;
  } catch { /* create a new server-owned key below */ }
  const next = crypto.randomBytes(32);
  try { fs.writeFileSync(REPORT_SESSION_SECRET_PATH, next, { flag: 'wx', mode: 0o600 }); }
  catch { return fs.readFileSync(REPORT_SESSION_SECRET_PATH); }
  return next;
}
const REPORT_SESSION_SECRET = loadReportSessionSecret();
const fxService = createFxService();
const amazonResearch = createAmazonResearchService({ root: ROOT });
const reportWorkflow = createReportWorkflowService({ root: ROOT });
const reportJobs = createReportJobs({ root: ROOT });

// Task-center adapter (T2.6): loaded lazily from a trusted local operator config file
// (COMMERCE_TASKS_CONFIG -> { dbPath, storageRoot, access, allowedOrigins?, assets? }).
// Without that config every /tasks-api/ route fails closed; the static page carries no data.
let tasksApp = null;
let tasksAppLoaded = false;
function tasksHttpApp() {
  if (tasksAppLoaded) return tasksApp;
  tasksAppLoaded = true;
  const configPath = process.env.COMMERCE_TASKS_CONFIG;
  if (!configPath) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { openDb, migrateUp } = require('./lib/commerce/db.js');
    const migrations = [
      require('./lib/commerce/migrations/0001_core.js'),
      require('./lib/commerce/migrations/0002_passport_sku.js'),
      require('./lib/commerce/migrations/0003_evidence_observation.js'),
      require('./lib/commerce/migrations/0004_run_store.js'),
      require('./lib/commerce/migrations/0005_run_store_lease_token.js'),
      require('./lib/commerce/migrations/0006_idempotency.js'),
      require('./lib/commerce/migrations/0007_idempotency_contract.js'),
      require('./lib/commerce/migrations/0008_idempotency_attempt_remote.js'),
      require('./lib/commerce/migrations/0009_budget.js'),
      require('./lib/commerce/migrations/0010_budget_request_identity.js'),
      require('./lib/commerce/migrations/0011_imports.js')
    ];
    const db = openDb(config.dbPath);
    migrateUp(db, migrations);
    tasksApp = createTasksHttp({
      db,
      storageRoot: config.storageRoot,
      access: config.access,
      allowedOrigins: config.allowedOrigins,
      assets: config.assets
    });
    return tasksApp;
  } catch (error) {
    console.error(`[tasks] local task-center config unavailable: ${error.message}`);
    return null;
  }
}

function reportSessionSignature(sessionId) {
  return crypto.createHmac('sha256', REPORT_SESSION_SECRET).update(sessionId).digest('base64url');
}

function reportSessionId(req, res) {
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.slice(0, part.indexOf('=')) === 'report_actor');
  let token = '';
  try { token = cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : ''; }
  catch { /* malformed or tampered cookie: issue a fresh server-signed identity */ }
  const [sessionId, signature] = token.split('.');
  if (sessionId && signature) {
    const expected = Buffer.from(reportSessionSignature(sessionId));
    const actual = Buffer.from(signature);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return sessionId;
  }
  const nextSessionId = crypto.randomUUID();
  const nextToken = `${nextSessionId}.${reportSessionSignature(nextSessionId)}`;
  res.setHeader('Set-Cookie', `report_actor=${encodeURIComponent(nextToken)}; Path=/; SameSite=Strict; HttpOnly; Max-Age=2592000`);
  return nextSessionId;
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
    // The client may have disconnected; never crash the local server for that.
  }
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function safeStaticPath(urlPath) {
  try {
    const requestPath = urlPath === '/' ? '/index.html' : urlPath;
    const decoded = decodeURIComponent(requestPath);
    if (decoded.includes('\0') || !decoded.startsWith('/')) return null;
    const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
    return filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) ? filePath : null;
  } catch {
    return null;
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(req, res, urlPath) {
  const filePath = safeStaticPath(urlPath);
  if (!filePath) return sendError(res, 404, 'not_found', 'Not found.');
  fs.readFile(filePath, (error, data) => {
    if (error) return sendError(res, 404, 'not_found', 'Not found.');
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

function serveReportDownload(res, kind) {
  const report = resolveReportDownload(ROOT, kind);
  if (!report) return sendError(res, 404, 'not_found', 'Report file not found.');
  const stream = fs.createReadStream(report.filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendError(res, 404, 'not_found', 'Report file not found.');
    else res.destroy();
  });
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(report.fileName)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  stream.pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body is too large.'), { code: 'too_large' }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be JSON.'), { code: 'invalid_json' }));
      }
    });
    req.on('error', () => reject(Object.assign(new Error('Unable to read request.'), { code: 'invalid_request' })));
  });
}

function textList(value, maxItems = 12, maxLength = 160) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\r\n,;，；]+/);
  return values.map((item) => String(item || '').trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
}

function sourcingQueries(body, category, userNeed) {
  const explicit = textList(body && (body.queries || body.keywords), 8, 160);
  if (explicit.length) {
    if (explicit.some((query) => !/^[\x00-\x7F]+$/.test(query))) {
      throw Object.assign(new Error('Amazon 公开页检索词请填写英文；中文需求可保留在需求字段。'), { code: 'english_keywords_required' });
    }
    return explicit;
  }
  if (!/^[\x00-\x7F]+$/.test(category)) {
    throw Object.assign(new Error('请补充英文 Amazon 检索词；系统不会把中文品类自动猜成英文关键词。'), { code: 'english_keywords_required' });
  }
  const need = String(userNeed || '').trim();
  const queries = [need && /^[\x00-\x7F]+$/.test(need) ? `${need} ${category}` : category];
  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 8);
}

function jobErrorStatus(code) {
  if (code === 'job_not_found' || code === 'artifact_not_found' || code === 'sheet_not_found' || code === 'evidence_not_found') return 404;
  if (code === 'independent_reviewer_required' || code === 'self_audit_forbidden' || code === 'producer_session_required') return 403;
  if (code === 'invalid_state' || code === 'confirmation_required' || code === 'revision_conflict' || code === 'artifact_version_mismatch'
    || code === 'review_requires_build' || code === 'review_return_required' || code === 'repair_notes_required'
    || code === 'audit_version_mismatch' || code === 'review_already_approved' || code === 'audit_issue_required'
    || code === 'audit_gates_incomplete' || code === 'audit_returned_requires_rebuild'
    || code === 'repair_producer_required' || code === 'producer_session_missing' || code === 'release_blocked'
    || code === 'product_cost_confirmation_required') return 409;
  if (code === 'upload_too_large' || code === 'too_many_pages' || code === 'too_large') return 413;
  if (code === 'unsupported_media_type' || code === 'pdf_magic_mismatch') return 415;
  if (code === 'pdf_unreadable' || code === 'analysis_incomplete') return 422;
  if (code === 'invalid_request' || code === 'invalid_task_type' || code === 'invalid_revision' || code === 'invalid_confirmation'
    || code === 'invalid_json' || code === 'invalid_pdf' || code === 'invalid_audit_action' || code === 'invalid_screenshot') return 400;
  return 500;
}

function uploadSinglePdf(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = busboy({ headers: req.headers, limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 24, fieldSize: 20000 } });
    } catch {
      reject(Object.assign(new Error('Invalid multipart upload.'), { code: 'invalid_request' }));
      return;
    }
    const fields = {};
    const stagingDir = path.join(ROOT, 'tmp', 'report-jobs', '_staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagingPath = path.join(stagingDir, `upload-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.pdf`);
    let fileSeen = false;
    let fileInfo = null;
    let limited = false;
    let settled = false;
    let sinkDone = null;
    const cleanup = () => { try { fs.rmSync(stagingPath, { force: true }); } catch { /* optional */ } };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    parser.on('field', (name, value) => { fields[name] = String(value).slice(0, 20000); });
    parser.on('file', (name, file, info) => {
      if (fileSeen || name !== 'file') { file.resume(); return; }
      fileSeen = true;
      fileInfo = { fileName: info && info.filename, mimeType: info && info.mimeType };
      const sink = fs.createWriteStream(stagingPath);
      sinkDone = new Promise((resolveSink, rejectSink) => {
        sink.on('finish', resolveSink);
        sink.on('error', rejectSink);
      });
      sinkDone.catch(() => {});
      file.on('limit', () => { limited = true; });
      file.on('error', () => fail(Object.assign(new Error('Upload stream failed.'), { code: 'invalid_request' })));
      file.pipe(sink);
    });
    parser.on('error', () => fail(Object.assign(new Error('Invalid multipart upload.'), { code: 'invalid_request' })));
    parser.on('close', () => {
      if (settled) return;
      if (limited) return fail(Object.assign(new Error('The PDF exceeds the upload size limit.'), { code: 'upload_too_large' }));
      if (!fileSeen) return fail(Object.assign(new Error('A PDF file field named "file" is required.'), { code: 'invalid_request' }));
      Promise.resolve(sinkDone).then(() => {
        if (settled) return;
        settled = true;
        resolve({ fields, stagingPath, info: fileInfo });
      }).catch(() => fail(Object.assign(new Error('Unable to store the uploaded PDF.'), { code: 'invalid_request' })));
    });
    req.on('aborted', () => fail(Object.assign(new Error('Upload was interrupted.'), { code: 'invalid_request' })));
    req.pipe(parser);
  });
}

async function createReportJob(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const body = await readJson(req);
    const taskType = (body && body.taskType) || 'track_analysis';
    if (taskType !== 'track_analysis') throw Object.assign(new Error('PDF catalog jobs must upload a PDF file.'), { code: 'invalid_task_type' });
    return reportJobs.publicJob(reportJobs.create({
      taskType, brief: (body && body.brief) || {},
      producerName: body && body.producerName, producerSessionId: req.reportActorSessionId
    }));
  }
  if (!contentType.includes('multipart/form-data')) throw Object.assign(new Error('Only JSON or multipart uploads are supported.'), { code: 'unsupported_media_type' });
  const upload = await uploadSinglePdf(req);
  const job = reportJobs.create({
    taskType: 'pdf_catalog', brief: { category: upload.fields.category || '' },
    producerName: upload.fields.producerName, producerSessionId: req.reportActorSessionId
  });
  try {
    const sourceDir = path.join(ROOT, 'tmp', 'report-jobs', job.jobId, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    const targetPath = path.join(sourceDir, 'catalog.pdf');
    fs.renameSync(upload.stagingPath, targetPath);
    reportJobs.attachPdf(job.jobId, {
      filePath: targetPath,
      fileName: upload.info?.fileName || 'catalog.pdf',
      mimeType: upload.info?.mimeType || '',
      size: fs.statSync(targetPath).size
    });
    return reportJobs.publicJob(reportJobs.get(job.jobId));
  } catch (error) {
    try { fs.rmSync(upload.stagingPath, { force: true }); } catch { /* optional */ }
    error.jobId = job.jobId;
    throw error;
  }
}

async function handleReportJobs(req, res, url) {
  const prefix = '/api/reports/jobs';
  const rest = url.pathname.slice(prefix.length).replace(/^\/+/, '');
  const segments = rest ? rest.split('/').map((part) => decodeURIComponent(part)) : [];
  try {
    if (segments.length === 0 && req.method === 'POST') {
      return sendJson(res, 202, { data: await createReportJob(req) });
    }
    if (segments.length === 1 && req.method === 'GET') {
      return sendJson(res, 200, { data: reportJobs.publicJob(reportJobs.get(segments[0])) });
    }
    if (segments.length === 3 && segments[1] === 'evidence' && req.method === 'GET') {
      const evidence = reportJobs.evidence(segments[0], segments[2]);
      const stream = fs.createReadStream(evidence.filePath);
      stream.on('error', () => {
        if (!res.headersSent) sendError(res, 404, 'evidence_not_found', 'Evidence image not found.');
        else res.destroy();
      });
      res.writeHead(200, {
        'Content-Type': evidence.contentType,
        'Content-Length': evidence.size,
        'Content-Disposition': `inline; filename="${path.basename(evidence.filePath)}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      stream.pipe(res);
      return true;
    }
    if (segments.length === 2 && req.method === 'POST') {
      const body = await readJson(req);
      if (segments[1] === 'audit') {
        return sendJson(res, 200, { data: reportJobs.publicJob(reportJobs.recordAudit(segments[0], { ...(body || {}), reviewerSessionId: req.reportActorSessionId })) });
      }
      if (segments[1] === 'confirm') {
        return sendJson(res, 200, { data: reportJobs.publicJob(reportJobs.confirm(segments[0], {
          revision: body && body.revision, corrections: (body && body.corrections) || {}, repairNotes: body && body.repairNotes,
          actorSessionId: req.reportActorSessionId
        })) });
      }
      if (segments[1] === 'research') {
        return sendJson(res, 200, { data: reportJobs.publicJob(await reportJobs.research(segments[0], {
          revision: body && body.revision, researchBrief: (body && body.researchBrief) || {}, delayMs: body && body.delayMs
        })) });
      }
      if (segments[1] === 'build') {
        return sendJson(res, 200, { data: reportJobs.publicJob(await reportJobs.build(segments[0], { revision: body && body.revision })) });
      }
    }
    if (segments.length === 2 && segments[1] === 'workbooks' && req.method === 'GET') {
      const job = reportJobs.get(segments[0]);
      return sendJson(res, 200, { data: job.artifacts.map(({ filePath, manifestPath, manifest, ...meta }) => meta) });
    }
    if (segments.length === 4 && segments[1] === 'workbooks' && req.method === 'GET') {
      const { job, item } = reportJobs.artifact(segments[0], segments[2]);
      if (item.revision !== job.revision || item.buildVersion !== job.buildVersion) {
        throw Object.assign(new Error('The artifact version does not match the current task.'), { code: 'artifact_version_mismatch' });
      }
      if (segments[3] === 'preview') {
        const result = reportJobs.preview(segments[0], segments[2], url.searchParams.get('sheetId') || '', url.searchParams.get('page'), url.searchParams.get('pageSize'));
        return sendJson(res, 200, { data: result });
      }
      if (segments[3] === 'download') {
        if (!job.audit?.releaseAllowed) throw Object.assign(new Error('This workbook is not deliverable until independent review passes.'), { code: 'release_blocked' });
        const stream = fs.createReadStream(item.filePath);
        stream.on('error', () => {
          if (!res.headersSent) sendError(res, 404, 'artifact_not_found', 'Report artifact is not available.');
          else res.destroy();
        });
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        stream.pipe(res);
        return true;
      }
    }
    return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
  } catch (error) {
    const status = jobErrorStatus(error.code || '');
    const payload = { error: { code: error.code || 'report_job_failed', message: error.message || 'Report job failed.' } };
    if (error.jobId) payload.jobId = error.jobId;
    return sendJson(res, status, payload);
  }
}

const server = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  handleRequest(req, res).catch(() => {
    try {
      sendError(res, 500, 'internal_error', 'Internal error.');
    } catch {
      // Response already finished.
    }
  });
});

server.on('clientError', (error, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {
    // Socket already closed.
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/reports.html' || url.pathname.startsWith('/api/reports/')) {
    req.reportActorSessionId = reportSessionId(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/reports/session') {
    return sendJson(res, 200, { data: { sessionId: req.reportActorSessionId } });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const current = loadConfig(ROOT);
    return sendJson(res, 200, {
      ok: true,
      configured: current.hasApiKey,
      provider: current.provider,
      model: current.model,
      visionConfigured: Boolean(current.visionModel)
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/video/capabilities') {
    return sendJson(res, 200, { data: videoCapabilities() });
  }
  if (req.method === 'POST' && url.pathname === '/api/video/rank-candidates') {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, { data: rankCandidates(body && body.candidates) });
    } catch (error) {
      return sendError(res, error.code === 'too_large' ? 413 : 400, error.code || 'invalid_viral_candidate', error.message || '爆款候选无效。');
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/video/analysis-brief') {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, { data: buildAnalysisBrief(body || {}) });
    } catch (error) {
      return sendError(res, error.code === 'too_large' ? 413 : 400, error.code || 'invalid_viral_brief', error.message || '爆款拆解简报无效。');
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/video/plan') {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, { data: createVideoPlan(body) });
    } catch (error) {
      return sendError(res, error.code === 'too_large' ? 413 : 400, error.code || 'invalid_video_plan', error.message || '视频简报无效。');
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/fx') {
    const locale = normalizeLocale(url.searchParams.get('locale'));
    const rates = await fxService.getRates(url.searchParams.get('base') || 'USD');
    if (!rates) return sendError(res, 502, 'fx_unavailable', uiMessage(locale, 'fx.unavailable'));
    return sendJson(res, 200, { data: rates });
  }
  if (req.method === 'GET' && url.pathname === '/api/amazon/research/status') {
    const config = loadConfig(ROOT).amazonResearch;
    return sendJson(res, 200, {
      data: {
        ...amazonResearch.publicState(),
        config: {
          onStart: config.onStart,
          scope: config.scope,
          queryCount: config.queries.length,
          asinCount: config.asins.length,
          maxProductPages: config.maxProductPages,
          delayMs: config.delayMs
        }
      }
    });
  }
  if (url.pathname === '/api/reports/jobs' || url.pathname.startsWith('/api/reports/jobs/')) {
    return handleReportJobs(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/reports/status') {
    return sendJson(res, 200, { data: reportWorkflow.publicState() });
  }
  if (req.method === 'POST' && url.pathname === '/api/reports/audit') {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, { data: reportWorkflow.recordAudit({ ...(body || {}), reviewerSessionId: req.reportActorSessionId }) });
    } catch (error) {
      return sendError(res, jobErrorStatus(error.code || ''), error.code || 'report_audit_failed', error.message || 'Report audit failed.');
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/reports/download/')) {
    const kind = decodeURIComponent(url.pathname.slice('/api/reports/download/'.length));
    if (!reportWorkflow.publicState().audit?.releaseAllowed) return sendError(res, 409, 'release_blocked', 'Reports cannot be delivered before independent review passes.');
    return serveReportDownload(res, kind);
  }
  if (req.method === 'POST' && url.pathname === '/api/reports/build') {
    try {
      const body = await readJson(req);
      const outcome = reportWorkflow.start({
        refreshAmazon: body && body.refreshAmazon,
        refreshSummary: body && body.refreshSummary,
        delayMs: body && body.delayMs,
        observedAt: body && body.observedAt,
        producerName: '本会话制作者', producerSessionId: req.reportActorSessionId,
        actorSessionId: req.reportActorSessionId, repairNotes: body && body.repairNotes
      });
      if (!outcome.accepted) return sendError(res, 409, 'report_running', 'Report generation is already running.');
      return sendJson(res, 202, { data: outcome });
    } catch (error) {
      return sendError(res, jobErrorStatus(error.code || ''), error.code || 'report_build_failed', error.message || 'Report request must be valid JSON.');
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/amazon/research/run') {
    try {
      const body = await readJson(req);
      const scope = body && body.scope === 'catalog' ? 'catalog' : 'custom';
      const queries = Array.isArray(body && body.queries) ? body.queries : [];
      const asins = Array.isArray(body && body.asins) ? body.asins : [];
      const options = {
        scope,
        queries: queries.length ? queries : scope === 'catalog' ? catalogQueries(ROOT) : [],
        asins,
        maxProductPages: body && body.maxProductPages,
        delayMs: body && body.delayMs,
        observedAt: body && body.observedAt
      };
      const outcome = amazonResearch.start(options);
      if (!outcome.accepted) return sendError(res, 409, 'research_running', 'Amazon research is already running.');
      return sendJson(res, 202, { data: outcome });
    } catch (error) {
      if (error.code === 'too_large') return sendError(res, 413, 'too_large', 'Request body is too large.');
      return sendError(res, 400, error.code || 'invalid_json', 'Research request must be valid JSON.');
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/sourcing/insights') {
    try {
      const body = await readJson(req);
      const category = String(body && body.category || '').trim().slice(0, 160);
      const userNeed = String(body && (body.userNeed || body.need) || '').trim().slice(0, 500);
      if (!category) return sendError(res, 400, 'validation', '请先填写产品大类。');
      const queries = sourcingQueries(body || {}, category, userNeed);
      const maxProductPages = Math.min(20, Math.max(1, Number.parseInt(body && body.maxProductPages, 10) || 8));
      const includeReviewPages = body && body.includeReviewPages === true;
      const result = await researchPublicAmazon({
        queries,
        maxSearchResults: Math.min(20, Math.max(1, Number.parseInt(body && body.maxSearchResults, 10) || 10)),
        maxProductPages,
        includeReviewPages,
        delayMs: Math.min(15_000, Math.max(0, Number.parseInt(body && body.delayMs, 10) || 600)),
        observedAt: String(body && body.observedAt || '').trim().slice(0, 40) || new Date().toISOString().slice(0, 10)
      });
      const featureDefinitions = buildFeatureDefinitions({ category, featureHints: textList(body && body.featureHints, 20, 100) });
      const summary = summarizeCategory(result.records, {
        category, userNeed, marketplace: 'Amazon.com', queries, observedAt: result.provenance.observedAt, featureDefinitions
      });
      return sendJson(res, 200, { data: { ...summary, errors: result.errors, provenance: result.provenance } });
    } catch (error) {
      if (error.code === 'too_large') return sendError(res, 413, 'too_large', 'Request body is too large.');
      return sendError(res, 400, error.code || 'sourcing_research_failed', error.message || '选品研究失败。');
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/intel/')) {
    try {
      const body = await readJson(req);
      const locale = normalizeLocale(body && body.locale);
      let outcome;
      if (url.pathname === '/api/intel/score') outcome = scoreProduct(body || {}, locale);
      else if (url.pathname === '/api/intel/compare') outcome = compareCompetitors(body || {}, locale);
      else if (url.pathname === '/api/intel/prices') outcome = priceStats(body || {}, locale);
      else if (url.pathname === '/api/intel/import') outcome = parsePriceCsv(body && body.text, locale);
      else if (url.pathname === '/api/intel/pricing') outcome = buildPricing(body || {}, locale);
      else if (url.pathname === '/api/intel/batch') {
        const parsed = parseCandidateText(body && body.text, locale);
        if (parsed.error) return sendError(res, 400, 'validation', parsed.error);
        const assessed = assessCandidates(parsed.rows, {
          locale,
          dataBasis: body && body.dataBasis,
          observedAt: body && body.observedAt
        });
        return sendJson(res, 200, { data: assessed.result });
      }
      else if (url.pathname === '/api/intel/market') {
        const parsed = parseMarketRows(body && body.text, locale);
        if (parsed.error) return sendError(res, 400, 'validation', parsed.error);
        return sendJson(res, 200, {
          data: analyzeMarket(parsed.rows, {
            locale,
            dataBasis: body && body.dataBasis,
            observedAt: body && body.observedAt
          }).result
        });
      }
      else if (url.pathname === '/api/intel/interpret') {
        if (!body || typeof body.kind !== 'string' || !body.result || typeof body.result !== 'object') {
          return sendError(res, 400, 'validation', uiMessage(locale, 'intel.interpret.required'));
        }
        const interpreted = await interpretIntel(body, { root: ROOT });
        return interpreted.error
          ? sendError(res, interpreted.status, interpreted.error.code, interpreted.error.message)
          : sendJson(res, interpreted.status, interpreted.body);
      } else return sendError(res, 404, 'not_found', 'Not found.');
      if (outcome.error) return sendError(res, 400, 'validation', outcome.error);
      return sendJson(res, 200, { data: outcome.result });
    } catch (error) {
      if (error.code === 'too_large') return sendError(res, 413, 'too_large', 'Request body is too large.');
      return sendError(res, 400, error.code || 'invalid_json', 'Request body must be valid JSON.');
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    try {
      const input = validateInput(await readJson(req));
      if (input.error) return sendError(res, 400, 'validation', input.error);
      const result = await generateContent(input.value, { root: ROOT });
      return result.error ? sendError(res, result.status, result.error.code, result.error.message) : sendJson(res, result.status, result.body);
    } catch (error) {
      if (error.code === 'too_large') return sendError(res, 413, 'too_large', 'Request body is too large.');
      return sendError(res, 400, error.code || 'invalid_json', 'Request body must be valid JSON.');
    }
  }
  if (url.pathname.startsWith('/tasks-api/')) {
    const app = tasksHttpApp();
    if (!app) return sendError(res, 503, 'tasks_not_configured', 'The task center is not configured on this local server.');
    return app.handle(req, res, url);
  }
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
}

server.listen(loadConfig(ROOT).port, '127.0.0.1', () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : loadConfig(ROOT).port;
  console.log(`Local demo listening on http://127.0.0.1:${boundPort}`);
  const startup = amazonResearch.startFromConfig(loadConfig(ROOT).amazonResearch);
  if (startup.accepted) console.log(`Amazon public research started: ${startup.jobId}`);
});
