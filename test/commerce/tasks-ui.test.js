'use strict';
/**
 * T2.6 task-center tests (HTTP level): three representative flows over real synthetic bytes and
 * the real approved modules, plus the three required negative groups (authorization/CSRF/XSS,
 * artifact traversal/symlink, redo scope binding and no blind resend of charged operations).
 * Writes only to the private runtime tmp via $COMMERCE_TEST_TMP; no real outbound calls.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const W = path.resolve(__dirname, '..', '..');
const { openDb, migrateUp } = require(path.join(W, 'lib', 'commerce', 'db.js'));
const migrations = [
  require(path.join(W, 'lib', 'commerce', 'migrations', '0001_core.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0002_passport_sku.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0003_evidence_observation.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0004_run_store.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0005_run_store_lease_token.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0006_idempotency.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0007_idempotency_contract.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0008_idempotency_attempt_remote.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0009_budget.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0010_budget_request_identity.js')),
  require(path.join(W, 'lib', 'commerce', 'migrations', '0011_imports.js'))
];
const budget = require(path.join(W, 'lib', 'commerce', 'budget.js'));
const store = require(path.join(W, 'lib', 'commerce', 'run-store.js'));
const idem = require(path.join(W, 'lib', 'commerce', 'idempotency.js'));
const worker = require(path.join(W, 'lib', 'commerce', 'worker.js'));
const packs = require(path.join(W, 'lib', 'commerce', 'packs.js'));
const pdfUtil = require(path.join(W, 'lib', 'commerce', 'imports', 'pdf-util.js'));
const { createTasksHttp } = require(path.join(W, 'lib', 'commerce', 'http.js'));

const TMP_ROOT = process.env.COMMERCE_TEST_TMP;
const skip = TMP_ROOT ? false : 'COMMERCE_TEST_TMP is not set; T2.6 tests write only to the private runtime tmp';
const RUN_DIR = TMP_ROOT ? fs.mkdtempSync(path.join(TMP_ROOT, 't26-run-')) : null;
const NOW = '2026-10-13T04:00:00.000Z';
const TOKEN_OP = 'tok-operator-0000000000000001';
const TOKEN_VIEW = 'tok-viewer-000000000000000002';
const TOKEN_OTHER = 'tok-operator-0000000000000003';
const P1 = 'proj-t26-p1';
const P2 = 'proj-t26-p2';
const ACCESS = {
  sessions: [
    { token: TOKEN_OP, actor: 'fixture-operator', internal: true, projects: { [P1]: { role: 'operator' } } },
    { token: TOKEN_VIEW, actor: 'fixture-viewer', internal: true, projects: { [P1]: { role: 'viewer' } } },
    { token: TOKEN_OTHER, actor: 'fixture-other', internal: true, projects: { [P2]: { role: 'operator' } } }
  ]
};
const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const utf16beHex = (text) => Buffer.from(text, 'utf16le').swap16().toString('hex');
function textObject(num, body) {
  return { num, buffer: () => Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1') };
}
function serializePdf(objects, physicalOrder) {
  const byNum = new Map(objects.map((object) => [object.num, object]));
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = new Map();
  for (const num of physicalOrder) {
    const buffer = byNum.get(num).buffer();
    offsets.set(num, offset);
    chunks.push(buffer);
    offset += buffer.length;
  }
  const xrefOffset = offset;
  const maxNum = Math.max(...objects.map((object) => object.num));
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxNum; num += 1) xref += `${(offsets.get(num) ?? 0).toString().padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
function buildTextPdf(pagesLines) {
  const pageCount = pagesLines.length;
  const fontNum = 3 + pageCount * 2;
  const objects = [
    textObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    textObject(2, `<< /Type /Pages /Kids [${pagesLines.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`)
  ];
  pagesLines.forEach((lines, index) => {
    const pageNum = 3 + index * 2;
    const contentNum = pageNum + 1;
    objects.push(textObject(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`));
    const content = lines.map((line) => `BT <${utf16beHex(line)}> Tj ET`).join('\n');
    objects.push(textObject(contentNum, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`));
  });
  objects.push(textObject(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  return serializePdf(objects, objects.map((object) => object.num));
}
function buildCsv(rows) {
  return Buffer.from(rows.map((row) => row.map((value) => JSON.stringify(String(value))).join(',')).join('\n'), 'utf8');
}

function openEnv(name) {
  const dir = path.join(RUN_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'tasks.db');
  const db = openDb(dbPath);
  migrateUp(db, migrations);
  const storageRoot = path.join(dir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  return { dir, dbPath, storageRoot, db, reopen: () => { db.close(); return openDb(dbPath); } };
}
function startServer(app) {
  const server = http.createServer((req, res) => {
    app.handle(req, res, new URL(req.url, 'http://127.0.0.1')).catch(() => {
      try { res.writeHead(500); res.end(); } catch { /* closed */ }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
function closeServer(server) {
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
}
async function call(base, method, requestPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers['x-tasks-session'] = options.token;
  let body;
  if (options.body !== undefined) {
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const response = await fetch(`${base}${requestPath}`, { method, headers, body });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json, contentType: response.headers.get('content-type') };
}
async function setupApp(env, assetsConfig) {
  const app = createTasksHttp({
    db: env.db,
    storageRoot: env.storageRoot,
    access: ACCESS,
    allowedOrigins: ['http://127.0.0.1:5178'],
    now: () => NOW,
    assets: assetsConfig
  });
  return startServer(app);
}

test('T2.6 flow①: upload → confirm/correct → reopen (real CSV/PDF bytes, scan blocked)', { skip }, async () => {
  const env = openEnv('flow1');
  const { server, base } = await setupApp(env);
  try {
    const csvBytes = buildCsv([
      ['型号', '配置', '颜色', '价格', '币种', '单位', '条款'],
      ['SOL-U1', 'red', 'blue', '40', 'USD', 'pcs', 'EXW'],
      ['SOL-U2', 'red', 'blue', '12', 'XYZ', 'pcs', 'EXW']
    ]);
    const upload = await call(base, 'POST', `/tasks-api/projects/${P1}/imports`, {
      token: TOKEN_OP,
      body: { fileName: 'supplier.csv', supplierKey: 'fixture-sup', contentBase64: csvBytes.toString('base64') }
    });
    assert.equal(upload.status, 201);
    const documentId = upload.json.data.document.documentId;
    const candidates = upload.json.data.candidates;
    const cost = candidates.find((candidate) => candidate.fieldKey === 'purchase_cost' && candidate.rawValue === '40');
    const badCurrency = candidates.find((candidate) => candidate.fieldKey === 'currency' && candidate.rawValue === 'XYZ');
    assert.ok(cost && badCurrency, 'expected purchase_cost and currency candidates');
    const confirmGood = await call(base, 'POST', `/tasks-api/projects/${P1}/candidates/${cost.candidateId}/confirm`, {
      token: TOKEN_OP,
      body: { observedAt: NOW }
    });
    assert.equal(confirmGood.status, 200);
    const confirmBad = await call(base, 'POST', `/tasks-api/projects/${P1}/candidates/${badCurrency.candidateId}/confirm`, {
      token: TOKEN_OP,
      body: { observedAt: NOW }
    });
    assert.equal(confirmBad.status, 400, 'unknown currency must not be confirmable from the web UI');
    const pdfBytes = buildTextPdf([[
      '型号 配置 颜色 出厂价 币种 单位 条款',
      'SOL-P1 配置 red 颜色 blue 出厂价 12 USD/pcs EXW',
      'SOL-P2 配置 green 颜色 red 出厂价 15 USD/pcs FOB',
      '备注 本页为合成测试数据 无真实供应商信息 仅用于本地工程验证'
    ]]);
    const pdfUpload = await call(base, 'POST', `/tasks-api/projects/${P1}/imports`, {
      token: TOKEN_OP,
      body: { fileName: 'catalog.pdf', supplierKey: 'fixture-sup', contentBase64: pdfBytes.toString('base64') }
    });
    assert.equal(pdfUpload.status, 201);
    assert.equal(pdfUpload.json.data.status, 'imported');
    assert.ok(pdfUpload.json.data.candidates.length >= 1);
    const scanBytes = pdfUtil.buildPng(8, 8, Buffer.alloc(64, 120), 1);
    const scan = await call(base, 'POST', `/tasks-api/projects/${P1}/imports`, {
      token: TOKEN_OP,
      body: { fileName: 'scan.png', supplierKey: 'fixture-sup', contentBase64: scanBytes.toString('base64') }
    });
    assert.equal(scan.status, 409);
    assert.equal(scan.json.data.reason, 'scan_requires_s1_permit');
    closeServer(server);
    env.db = env.reopen();
    const reopenedServer = await setupApp(env);
    try {
      const reopened = await call(reopenedServer.base, 'GET', `/tasks-api/projects/${P1}/imports/${documentId}`, { token: TOKEN_OP });
      assert.equal(reopened.status, 200);
      const readback = reopened.json.data.candidates;
      assert.equal(readback.filter((candidate) => candidate.status === 'confirmed').length, 1);
      assert.ok(readback.some((candidate) => candidate.candidateId === badCurrency.candidateId && candidate.status === 'candidate'));
    } finally {
      closeServer(reopenedServer.server);
    }
  } finally {
    closeServer(server);
  }
});

test('T2.6 flow②: fixture run create → status/artifacts/budget → cancel/redo (original untouched)', { skip }, async () => {
  const env = openEnv('flow2');
  const { server, base } = await setupApp(env);
  try {
    budget.ensureBudgetPool(env.db, { project: P1, brand: null, currency: 'USD', limitMicros: 100000, now: NOW });
    budget.reserveBudget(env.db, {
      project: P1, brand: null, currency: 'USD', operationId: 'ui-op-1', attemptToken: 'ui-att-1',
      category: 'llm', priceBasis: 'fixture', priceConfidence: 'placeholder', quantity: 1,
      eventId: 'ui-evt-1', maxEstimateMicros: 500, now: NOW
    });
    budget.recordPendingCost(env.db, { operationId: 'ui-op-1', attemptToken: 'ui-att-1', cumulativeMicros: 100, eventId: 'ui-evt-2', remoteId: ' UI-REMOTE ', now: NOW });
    const created = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, {
      token: TOKEN_OP,
      body: { task: 'fixture-echo.v1', input: { text: 'hello' } }
    });
    assert.equal(created.status, 201);
    const sourceRunId = created.json.data.runId;
    assert.equal(created.json.data.status, 'succeeded');
    const detail = await call(base, 'GET', `/tasks-api/projects/${P1}/runs/${sourceRunId}`, { token: TOKEN_OP });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.artifacts.length, 1);
    assert.ok(detail.json.data.journal.some((entry) => entry.event === 'step_completed'));
    assert.ok(detail.json.data.events.some((event) => event.eventType === 'run_succeeded'));
    const artifactId = detail.json.data.artifacts[0].artifactId;
    const downloadBefore = await fetch(`${base}/tasks-api/artifacts/${artifactId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } });
    assert.equal(downloadBefore.status, 200);
    const artifactBytesBefore = Buffer.from(await downloadBefore.arrayBuffer());
    const parsed = JSON.parse(artifactBytesBefore.toString('utf8'));
    assert.equal(parsed.stepId, 'echo');
    assert.match(parsed.output.echo, /hello/);
    const budgetView = await call(base, 'GET', `/tasks-api/projects/${P1}/budget`, { token: TOKEN_OP });
    assert.equal(budgetView.json.data.reservedMicros, 500);
    assert.equal(budgetView.json.data.reservations[0].pendingMicros, 100);
    assert.equal(budgetView.json.data.reservations[0].remoteId, ' UI-REMOTE ');
    const redo = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(redo.status, 201);
    const newRunId = redo.json.data.runId;
    assert.notEqual(newRunId, sourceRunId);
    assert.equal(redo.json.data.retryOf, sourceRunId);
    assert.equal(redo.json.data.status, 'succeeded');
    const sourceAfter = await call(base, 'GET', `/tasks-api/projects/${P1}/runs/${sourceRunId}`, { token: TOKEN_OP });
    assert.equal(sourceAfter.json.data.status, 'succeeded', 'the original run is never revived or rewritten');
    const newDetail = await call(base, 'GET', `/tasks-api/projects/${P1}/runs/${newRunId}`, { token: TOKEN_OP });
    assert.equal(newDetail.json.data.checkpoint.bindingHash, detail.json.data.checkpoint.bindingHash, 'the redo keeps the same input/plan binding');
    const downloadAfter = await fetch(`${base}/tasks-api/artifacts/${artifactId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } });
    const artifactBytesAfter = Buffer.from(await downloadAfter.arrayBuffer());
    assert.ok(artifactBytesBefore.equals(artifactBytesAfter), 'original artifacts are never overwritten');
    const queued = store.createRun(env.db, P1, { taskType: 'fixture-echo.v1', actor: 'fixture', now: NOW });
    const cancelled = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${queued.id}/cancel`, { token: TOKEN_OP, body: { reason: 'fixture cancel' } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.data.status, 'cancelled');
    const cancelTerminal = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/cancel`, { token: TOKEN_OP, body: {} });
    assert.equal(cancelTerminal.status, 409);
    const operationId = worker.operationIdFor(sourceRunId, 'echo', sha256Hex(packs.canonicalJson({ text: 'hello' })));
    idem.claimOperation(env.db, {
      operationId,
      capability: 'unsupported',
      scope: {
        taskId: 'orchestrator.dag.v1', inputHash: sha256Hex(packs.canonicalJson({ text: 'hello' })), tool: 'ui.fixture-echo', toolVersion: '1.0.0',
        model: 'fixture-none', promptVersion: 'none', templateVersion: 'none', policy: 't2.7-permits-v1',
        project: P1, brand: null, market: 'fixture', locale: 'en-US', shipTo: 'none'
      },
      now: NOW
    });
    const op = idem.getOperation(env.db, operationId);
    idem.markSubmitted(env.db, operationId, { attemptToken: op.attemptToken, remoteId: ' UI-PENDING ', now: NOW });
    idem.markTimeout(env.db, operationId, { attemptToken: op.attemptToken, kind: 'timeout', remoteId: ' UI-PENDING ', now: NOW });
    const blockedRedo = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(blockedRedo.status, 409);
    assert.equal(blockedRedo.json.error.code, 'unresolved_operation', 'no blind resend of an unresolved charged operation');
  } finally {
    closeServer(server);
  }
});

test('T2.6 flow③: memory scope revision + read-only asset index / preference / download', { skip }, async () => {
  const env = openEnv('flow3');
  const assetRoot = path.join(env.dir, 'assets-root');
  fs.mkdirSync(path.join(assetRoot, 'family-a'), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, 'family-b'), { recursive: true });
  const mainPng = pdfUtil.buildPng(8, 8, Buffer.alloc(64, 90), 1);
  fs.writeFileSync(path.join(assetRoot, 'family-a', 'main.png'), mainPng);
  fs.writeFileSync(path.join(assetRoot, 'family-b', 'ref.png'), pdfUtil.buildPng(8, 8, Buffer.alloc(64, 200), 1));
  const indexFile = path.join(env.dir, 'asset-index.json');
  fs.writeFileSync(indexFile, JSON.stringify({
    schemaVersion: 1,
    kind: 'shop-materials-index',
    sourceRootId: 'fixture-root',
    scannedAt: NOW,
    files: [
      { relPath: 'family-a/main.png', sha256: crypto.createHash('sha256').update(mainPng).digest('hex'), size: mainPng.length, format: 'png', familyKey: 'FAM-A', role: 'main', roleStatus: 'confirmed', language: 'en', usageCandidates: ['MAIN'], skuCandidates: ['SKU-CAND-1'], designSetId: 'DESIGN-1', ratio: 1 },
      { relPath: 'family-b/ref.png', sha256: 'b'.repeat(64), size: 64, format: 'png', familyKey: 'FAM-B', role: 'reference', roleStatus: 'candidate', language: 'unknown', usageCandidates: ['reference'], skuCandidates: [], designSetId: null, ratio: 1 }
    ]
  }, null, 2));
  const { server, base } = await setupApp(env, { indexFilePath: indexFile, roots: { 'fixture-root': assetRoot } });
  try {
    const candidate = await call(base, 'POST', `/tasks-api/projects/${P1}/memory/candidates`, {
      token: TOKEN_OP,
      body: { scope: 'product', scopeKey: 'P1', ruleKey: 'note', value: { a: 1 }, source: 'fixture' }
    });
    assert.equal(candidate.status, 201);
    const ruleId = candidate.json.data.rule.id;
    const confirmed = await call(base, 'POST', `/tasks-api/projects/${P1}/memory/${ruleId}/confirm`, { token: TOKEN_OP, body: {} });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.data.rule.status, 'active');
    const activeId = confirmed.json.data.rule.id;
    const corrected = await call(base, 'POST', `/tasks-api/projects/${P1}/memory/${activeId}/correct`, { token: TOKEN_OP, body: { value: { a: 2 } } });
    assert.equal(corrected.status, 200);
    assert.deepEqual(corrected.json.data.rule.value, { a: 2 });
    const chain = await call(base, 'GET', `/tasks-api/projects/${P1}/memory/${ruleId}/chain`, { token: TOKEN_OP });
    assert.equal(chain.status, 200);
    assert.equal(chain.json.data.chain.length, 3, 'candidate + first active + corrected active version');
    assert.deepEqual(chain.json.data.chain[2].value, { a: 2 });
    const brandScoped = await call(base, 'GET', `/tasks-api/projects/${P1}/memory?scope=brand&scopeKey=B2`, { token: TOKEN_OP });
    assert.equal(brandScoped.json.data.rules.length, 0, 'brand=null/other is never a wildcard');
    const assets = await call(base, 'GET', `/tasks-api/projects/${P1}/assets?familyKey=FAM-A`, { token: TOKEN_OP });
    assert.equal(assets.status, 200);
    assert.equal(assets.json.data.total, 1);
    assert.equal(assets.json.data.files[0].relPath, 'family-a/main.png');
    const emptyFamily = await call(base, 'GET', `/tasks-api/projects/${P1}/assets?familyKey=FAM-UNKNOWN`, { token: TOKEN_OP });
    assert.equal(emptyFamily.json.data.total, 0);
    const artifactId = assets.json.data.files[0].artifactId;
    const download = await fetch(`${base}/tasks-api/artifacts/${artifactId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.ok(bytes.equals(mainPng), 'legal asset download returns the exact bytes');
    const preference = await call(base, 'POST', `/tasks-api/projects/${P1}/assets/${artifactId}/preference`, { token: TOKEN_OP, body: { purpose: 'MAIN' } });
    assert.equal(preference.status, 200);
    const prefs = await call(base, 'GET', `/tasks-api/projects/${P1}/assets/preferences`, { token: TOKEN_OP });
    assert.equal(prefs.json.data.preferences[artifactId].purpose, 'MAIN');
  } finally {
    closeServer(server);
  }
});

test('T2.6 negatives①: session/project overreach, CSRF, static non-leak, XSS invariant', { skip }, async () => {
  const env = openEnv('neg1');
  const { server, base } = await setupApp(env);
  try {
    const anonymous = await call(base, 'GET', `/tasks-api/projects/${P1}/runs`);
    assert.equal(anonymous.status, 401);
    const anonymousSession = await call(base, 'GET', '/tasks-api/session');
    assert.equal(anonymousSession.status, 200);
    assert.equal(anonymousSession.json.data.authenticated, false);
    const viewerWrite = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, { token: TOKEN_VIEW, body: { task: 'fixture-echo.v1', input: { text: 'x' } } });
    assert.equal(viewerWrite.status, 403);
    const crossProject = await call(base, 'GET', `/tasks-api/projects/${P1}/runs`, { token: TOKEN_OTHER });
    assert.equal(crossProject.status, 403);
    const queryToken = await call(base, 'GET', `/tasks-api/projects/${P1}/runs?session=${TOKEN_OP}`);
    assert.equal(queryToken.status, 401, 'a query token is never identity');
    const evilOrigin = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, {
      token: TOKEN_OP,
      headers: { origin: 'http://evil.example' },
      body: { task: 'fixture-echo.v1', input: { text: 'x' } }
    });
    assert.equal(evilOrigin.status, 403);
    const wrongType = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, {
      token: TOKEN_OP,
      headers: { 'content-type': 'text/plain' },
      body: 'task=fixture-echo.v1'
    });
    assert.equal(wrongType.status, 415);
    const traversalId = await call(base, 'GET', '/tasks-api/artifacts/..%2F..%2Fserver/download', { token: TOKEN_OP });
    assert.equal(traversalId.status, 400);
    const unknownId = await call(base, 'GET', `/tasks-api/artifacts/${'f'.repeat(32)}/download`, { token: TOKEN_OP });
    assert.equal(unknownId.status, 404);
    const notFoundBody = JSON.stringify(unknownId.json);
    assert.ok(!notFoundBody.includes('\\') && !notFoundBody.includes('/'), 'error bodies never echo filesystem paths');
    assert.equal(unknownId.contentType, 'application/json; charset=utf-8');
    const tasksJs = fs.readFileSync(path.join(W, 'public', 'tasks.js'), 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(tasksJs), 'the UI renders untrusted text without innerHTML assignment');
    assert.ok(!tasksJs.includes('insertAdjacentHTML'));
  } finally {
    closeServer(server);
  }
});

test('T2.6 negatives②: artifact traversal via tampered registry and symlink escape are rejected', { skip }, async () => {
  const env = openEnv('neg2');
  const assetRoot = path.join(env.dir, 'assets-root');
  fs.mkdirSync(assetRoot, { recursive: true });
  const legalPng = pdfUtil.buildPng(8, 8, Buffer.alloc(64, 60), 1);
  fs.writeFileSync(path.join(assetRoot, 'legal.png'), legalPng);
  const outsideDir = path.join(env.dir, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.png'), Buffer.from('outside-secret'));
  fs.symlinkSync(outsideDir, path.join(assetRoot, 'link'), 'junction');
  const indexFile = path.join(env.dir, 'asset-index.json');
  fs.writeFileSync(indexFile, JSON.stringify({
    schemaVersion: 1,
    kind: 'shop-materials-index',
    sourceRootId: 'fixture-root',
    files: [{ relPath: 'legal.png', sha256: 'c'.repeat(64), size: legalPng.length, format: 'png', familyKey: 'FAM-A', role: 'main' }]
  }));
  const { server, base } = await setupApp(env, { indexFilePath: indexFile, roots: { 'fixture-root': assetRoot } });
  try {
    const assets = await call(base, 'GET', `/tasks-api/projects/${P1}/assets?familyKey=FAM-A`, { token: TOKEN_OP });
    const legalId = assets.json.data.files[0].artifactId;
    const legal = await fetch(`${base}/tasks-api/artifacts/${legalId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } });
    assert.equal(legal.status, 200);
    assert.ok(Buffer.from(await legal.arrayBuffer()).equals(legalPng));
    const artifactsFile = path.join(env.storageRoot, 'tasks-ui', 'artifacts.json');
    const registry = JSON.parse(fs.readFileSync(artifactsFile, 'utf8'));
    const tamperedId = 'a'.repeat(32);
    registry.records[tamperedId] = { artifactId: tamperedId, projectId: P1, kind: 'asset', rootId: 'fixture-root', relPath: '../../outside/secret.png', sha256: null, createdAt: NOW };
    const junctionId = 'b'.repeat(32);
    registry.records[junctionId] = { artifactId: junctionId, projectId: P1, kind: 'asset', rootId: 'fixture-root', relPath: 'link/secret.png', sha256: null, createdAt: NOW };
    fs.writeFileSync(artifactsFile, JSON.stringify(registry, null, 2));
    const tampered = await call(base, 'GET', `/tasks-api/artifacts/${tamperedId}/download`, { token: TOKEN_OP });
    assert.equal(tampered.status, 400, 'a tampered relPath never escapes the allowed root');
    const junction = await call(base, 'GET', `/tasks-api/artifacts/${junctionId}/download`, { token: TOKEN_OP });
    assert.ok([400, 403].includes(junction.status), 'a junction/symlink escape is rejected');
    assert.ok(!JSON.stringify(junction.json).includes('outside-secret'));
    const legalAgain = await fetch(`${base}/tasks-api/artifacts/${legalId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } });
    assert.equal(legalAgain.status, 200, 'legal downloads keep working after rejected attempts');
    const crossProject = await call(base, 'GET', `/tasks-api/artifacts/${legalId}/download`, { token: TOKEN_OTHER });
    assert.equal(crossProject.status, 403, 'artifact ownership is per project; the same bytes elsewhere stay owned');
  } finally {
    closeServer(server);
  }
});

test('T2.6 negatives③: redo scope binding and charged-pending guard (no blind resend)', { skip }, async () => {
  const env = openEnv('neg3');
  const { server, base } = await setupApp(env);
  try {
    const created = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, {
      token: TOKEN_OP,
      body: { task: 'fixture-echo.v1', input: { text: 'scope-bound' } }
    });
    assert.equal(created.status, 201);
    const sourceRunId = created.json.data.runId;
    const sourceDetail = await call(base, 'GET', `/tasks-api/projects/${P1}/runs/${sourceRunId}`, { token: TOKEN_OP });
    const redo = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(redo.status, 201);
    const newDetail = await call(base, 'GET', `/tasks-api/projects/${P1}/runs/${redo.json.data.runId}`, { token: TOKEN_OP });
    assert.equal(newDetail.json.data.checkpoint.bindingHash, sourceDetail.json.data.checkpoint.bindingHash, 'same input version -> same binding');
    assert.equal(newDetail.json.data.task.retryOf, sourceRunId);
    const sourceRecord = JSON.parse(fs.readFileSync(path.join(env.storageRoot, 'tasks-ui', 'runs', `${sourceRunId}.json`), 'utf8'));
    assert.equal(sourceRecord.retryOf, null, 'the original run record is never modified by a redo');
    const operationId = worker.operationIdFor(sourceRunId, 'echo', sha256Hex(packs.canonicalJson({ text: 'scope-bound' })));
    idem.claimOperation(env.db, {
      operationId,
      capability: 'unsupported',
      scope: {
        taskId: 'orchestrator.dag.v1', inputHash: sha256Hex(packs.canonicalJson({ text: 'scope-bound' })), tool: 'ui.fixture-echo', toolVersion: '1.0.0',
        model: 'fixture-none', promptVersion: 'none', templateVersion: 'none', policy: 't2.7-permits-v1',
        project: P1, brand: null, market: 'fixture', locale: 'en-US', shipTo: 'none'
      },
      now: NOW
    });
    const pendingRedo = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(pendingRedo.status, 409);
    assert.equal(pendingRedo.json.error.code, 'unresolved_operation');
    const list = await call(base, 'GET', `/tasks-api/projects/${P1}/runs`, { token: TOKEN_OP });
    assert.equal(list.status, 200);
    assert.ok(list.json.data.runs.some((run) => run.runId === sourceRunId && run.status === 'succeeded'));
  } finally {
    closeServer(server);
  }
});

// ---------- revision-01 focused groups (review-01 F1-F5 + UI contract) ----------

test('T2.6 rev01 F1: inherited names can never authorize a project', { skip }, async () => {
  const env = openEnv('rev01-f1');
  const { server, base } = await setupApp(env);
  try {
    budget.ensureBudgetPool(env.db, { project: 'constructor', brand: null, currency: 'USD', limitMicros: 777777, now: NOW });
    budget.reserveBudget(env.db, {
      project: 'constructor', brand: null, currency: 'USD', operationId: 'SYNTHETIC-PRIVATE-OP', attemptToken: 'SYNTHETIC-PRIVATE-ATTEMPT',
      category: 'llm', priceBasis: 'synthetic-private', priceConfidence: 'placeholder', quantity: 1, eventId: 'synthetic-private-event', maxEstimateMicros: 7331, now: NOW
    });
    const inherited = await call(base, 'GET', '/tasks-api/projects/constructor/budget', { token: TOKEN_OP });
    assert.equal(inherited.status, 403, 'Object.prototype.constructor is not a grant');
    budget.ensureBudgetPool(env.db, { project: 'toString', brand: null, currency: 'USD', limitMicros: 1234, now: NOW });
    const inheritedTwo = await call(base, 'GET', '/tasks-api/projects/toString/budget', { token: TOKEN_OP });
    assert.equal(inheritedTwo.status, 403, 'toString is not a grant either');
    budget.ensureBudgetPool(env.db, { project: P1, brand: null, currency: 'USD', limitMicros: 5000, now: NOW });
    const legal = await call(base, 'GET', `/tasks-api/projects/${P1}/budget`, { token: TOKEN_OP });
    assert.equal(legal.status, 200, 'a legitimately authorized project still works');
    assert.equal(legal.json.data.configured, true);
  } finally {
    closeServer(server);
  }
});

test('T2.6 rev01 F2: shared asset bytes keep per-project stable immutable ownership', { skip }, async () => {
  const env = openEnv('rev01-f2');
  const assetRoot = path.join(env.dir, 'assets-root');
  fs.mkdirSync(assetRoot, { recursive: true });
  const png = pdfUtil.buildPng(8, 8, Buffer.alloc(64, 90), 1);
  fs.writeFileSync(path.join(assetRoot, 'main.png'), png);
  const indexFile = path.join(env.dir, 'asset-index.json');
  fs.writeFileSync(indexFile, JSON.stringify({
    schemaVersion: 1,
    kind: 'shop-materials-index',
    sourceRootId: 'synthetic-shared',
    scannedAt: NOW,
    files: [{ relPath: 'main.png', sha256: crypto.createHash('sha256').update(png).digest('hex'), size: png.length, format: 'png', familyKey: 'SYNTHETIC-FAM', role: 'main', roleStatus: 'candidate' }]
  }));
  const { server, base } = await setupApp(env, { indexFilePath: indexFile, roots: { 'synthetic-shared': assetRoot } });
  try {
    const first = await call(base, 'GET', `/tasks-api/projects/${P1}/assets`, { token: TOKEN_OP });
    const firstId = first.json.data.files[0].artifactId;
    const legal = await fetch(`${base}/tasks-api/artifacts/${firstId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } });
    assert.equal(legal.status, 200);
    const firstBytes = Buffer.from(await legal.arrayBuffer());
    const other = await call(base, 'GET', `/tasks-api/projects/${P2}/assets`, { token: TOKEN_OTHER });
    const secondId = other.json.data.files[0].artifactId;
    assert.notEqual(firstId, secondId, 'project identity is part of the asset id');
    const registry = JSON.parse(fs.readFileSync(path.join(env.storageRoot, 'tasks-ui', 'artifacts.json'), 'utf8'));
    assert.equal(registry.records[firstId].projectId, P1, 'the first owner is never overwritten');
    assert.equal(registry.records[secondId].projectId, P2);
    const firstAgain = await fetch(`${base}/tasks-api/artifacts/${firstId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } });
    assert.equal(firstAgain.status, 200, 'the original project keeps its download');
    assert.ok(Buffer.from(await firstAgain.arrayBuffer()).equals(firstBytes));
    const crossToken = await call(base, 'GET', `/tasks-api/artifacts/${firstId}/download`, { token: TOKEN_OTHER });
    assert.equal(crossToken.status, 403);
    const pref = await call(base, 'POST', `/tasks-api/projects/${P1}/assets/${firstId}/preference`, { token: TOKEN_OP, body: { purpose: 'MAIN' } });
    assert.equal(pref.status, 200);
    const p1Prefs = await call(base, 'GET', `/tasks-api/projects/${P1}/assets/preferences`, { token: TOKEN_OP });
    assert.equal(p1Prefs.json.data.preferences[firstId].purpose, 'MAIN');
    const p2Prefs = await call(base, 'GET', `/tasks-api/projects/${P2}/assets/preferences`, { token: TOKEN_OTHER });
    assert.equal(p2Prefs.json.data.preferences[firstId], undefined, 'preferences stay per project');
  } finally {
    closeServer(server);
  }
  const env2 = openEnv('rev01-f2b');
  const scopedRoot = path.join(env2.dir, 'scoped-root');
  fs.mkdirSync(scopedRoot, { recursive: true });
  fs.writeFileSync(path.join(scopedRoot, 'main.png'), png);
  const scopedIndex = path.join(env2.dir, 'asset-index.json');
  fs.writeFileSync(scopedIndex, JSON.stringify({
    schemaVersion: 1,
    kind: 'shop-materials-index',
    sourceRootId: 'scoped-root',
    files: [{ relPath: 'main.png', sha256: 'd'.repeat(64), size: png.length, format: 'png', familyKey: 'SYNTHETIC-FAM', role: 'main' }]
  }));
  const scoped = await setupApp(env2, { indexFilePath: scopedIndex, roots: { 'scoped-root': { path: scopedRoot, projects: [P2] } } });
  try {
    const denied = await call(scoped.base, 'GET', `/tasks-api/projects/${P1}/assets`, { token: TOKEN_OP });
    assert.equal(denied.status, 403, 'a root scoped to another project never leaks its index');
    const allowed = await call(scoped.base, 'GET', `/tasks-api/projects/${P2}/assets`, { token: TOKEN_OTHER });
    assert.equal(allowed.status, 200);
  } finally {
    closeServer(scoped.server);
  }
});

test('T2.6 rev01 F3: a submitted unreconciled operation blocks redo before any new run', { skip }, async () => {
  const env = openEnv('rev01-f3');
  const { server, base } = await setupApp(env);
  try {
    const input = { text: 'SYNTHETIC-SUBMITTED' };
    const created = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, { token: TOKEN_OP, body: { task: 'fixture-echo.v1', input } });
    assert.equal(created.status, 201);
    const sourceRunId = created.json.data.runId;
    const operationId = worker.operationIdFor(sourceRunId, 'echo', sha256Hex(packs.canonicalJson(input)));
    idem.claimOperation(env.db, {
      operationId,
      capability: 'unsupported',
      scope: {
        taskId: 'orchestrator.dag.v1', inputHash: sha256Hex(packs.canonicalJson(input)), tool: 'ui.fixture-echo', toolVersion: '1.0.0',
        model: 'fixture-none', promptVersion: 'none', templateVersion: 'none', policy: 't2.7-permits-v1',
        project: P1, brand: null, market: 'fixture', locale: 'en-US', shipTo: 'none'
      },
      now: NOW
    });
    const op = idem.getOperation(env.db, operationId);
    idem.markSubmitted(env.db, operationId, { attemptToken: op.attemptToken, remoteId: ' SYNTHETIC-UNRECONCILED ', now: NOW });
    const before = store.listRuns(env.db, P1).length;
    const blocked = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(blocked.status, 409, 'submitted has no effective/not_submitted reconciliation; no replacement run may be dispatched');
    assert.equal(blocked.json.error.code, 'unresolved_operation');
    assert.equal(store.listRuns(env.db, P1).length, before, 'no new run is created before reconciliation');
    const after = idem.getOperation(env.db, operationId);
    assert.equal(after.state, 'submitted');
    assert.equal(after.remoteId, ' SYNTHETIC-UNRECONCILED ', 'the exact remote fact is never rewritten');
    const legal = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, { token: TOKEN_OP, body: { task: 'fixture-echo.v1', input: { text: 'SYNTHETIC-REDO-LEGAL' } } });
    const legalRunId = legal.json.data.runId;
    const legalDetail = await call(base, 'GET', `/tasks-api/projects/${P1}/runs/${legalRunId}`, { token: TOKEN_OP });
    const legalArtifactId = legalDetail.json.data.artifacts[0].artifactId;
    const bytesBefore = Buffer.from(await (await fetch(`${base}/tasks-api/artifacts/${legalArtifactId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } })).arrayBuffer());
    const redo = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${legalRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(redo.status, 201, 'a no-charge fixture run without unresolved operations can still be redone');
    assert.equal(redo.json.data.retryOf, legalRunId);
    const bytesAfter = Buffer.from(await (await fetch(`${base}/tasks-api/artifacts/${legalArtifactId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } })).arrayBuffer());
    assert.ok(bytesBefore.equals(bytesAfter), 'the original artifact is never rewritten by a redo');
  } finally {
    closeServer(server);
  }
});

test('T2.6 rev01 F4: unknown request fields fail closed before any effect', { skip }, async () => {
  const env = openEnv('rev01-f4');
  const { server, base } = await setupApp(env);
  try {
    const before = store.listRuns(env.db, P1).length;
    const unknown = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, {
      token: TOKEN_OP,
      body: { task: 'fixture-echo.v1', input: { text: 'SYNTHETIC-UNKNOWN-FIELD', unexpected: 'SYNTHETIC-INNER' }, unexpected: 'SYNTHETIC-OUTER' }
    });
    assert.equal(unknown.status, 400, 'unknown fields are rejected, not silently ignored');
    assert.equal(unknown.json.error.code, 'unknown_field');
    assert.equal(store.listRuns(env.db, P1).length, before, 'no run effect before field validation');
    const memoryUnknown = await call(base, 'POST', `/tasks-api/projects/${P1}/memory/candidates`, {
      token: TOKEN_OP,
      body: { scope: 'product', scopeKey: 'X1', ruleKey: 'k', value: { note: 'data stays allowed' }, unexpected: 1 }
    });
    assert.equal(memoryUnknown.status, 400, 'another write route enforces its allowlist too');
    const jsonp = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, {
      token: TOKEN_OP,
      headers: { 'content-type': 'application/jsonp' },
      body: JSON.stringify({ task: 'fixture-echo.v1', input: { text: 'x' } })
    });
    assert.equal(jsonp.status, 415, 'application/jsonp is not a JSON MIME');
    const legal = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, { token: TOKEN_OP, body: { task: 'fixture-echo.v1', input: { text: 'SYNTHETIC-LEGAL' } } });
    assert.equal(legal.status, 201);
    const charset = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, {
      token: TOKEN_OP,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ task: 'fixture-echo.v1', input: { text: 'SYNTHETIC-CHARSET' } })
    });
    assert.equal(charset.status, 201, 'application/json with charset parameters stays legal');
  } finally {
    closeServer(server);
  }
});

test('T2.6 rev01 UI: candidate context, asset nickname/aliases and preview contract', { skip }, () => {
  const tasksJs = fs.readFileSync(path.join(W, 'public', 'tasks.js'), 'utf8');
  for (const token of ['subjectKey', 'snippet', 'rowNumber', 'columnRef', 'nickname', 'aliases', 'createObjectURL', 'previewArtifact']) {
    assert.ok(tasksJs.includes(token), `tasks.js must display/use ${token}`);
  }
  assert.ok(!/\.innerHTML\s*=/.test(tasksJs));
  const tasksHtml = fs.readFileSync(path.join(W, 'public', 'tasks.html'), 'utf8');
  assert.ok(tasksHtml.includes('预览'));
});

// ---------- revision-02 focused group (G3b original binding + redo reconciliation gate) ----------

const rev02RecordPath = (env, runId) => path.join(env.storageRoot, 'tasks-ui', 'runs', `${runId}.json`);
const rev02PlanPath = (env, runId) => path.join(env.storageRoot, 'tasks-ui', 'workdir', 'orchestrator', runId, 'plan.json');
const rev02ReadRecord = (env, runId) => JSON.parse(fs.readFileSync(rev02RecordPath(env, runId), 'utf8'));
const rev02TamperRecord = (env, runId, patch) => fs.writeFileSync(rev02RecordPath(env, runId), JSON.stringify({ ...rev02ReadRecord(env, runId), ...patch }));
async function rev02CreateRun(base, text) {
  const out = await call(base, 'POST', `/tasks-api/projects/${P1}/runs`, { token: TOKEN_OP, body: { task: 'fixture-echo.v1', input: { text } } });
  assert.equal(out.status, 201);
  return out.json.data.runId;
}
function rev02InjectSubmitted(env, runId, input) {
  const operationId = worker.operationIdFor(runId, 'echo', sha256Hex(packs.canonicalJson(input)));
  idem.claimOperation(env.db, {
    operationId,
    capability: 'unsupported',
    scope: {
      taskId: 'orchestrator.dag.v1', inputHash: sha256Hex(packs.canonicalJson(input)), tool: 'ui.fixture-echo', toolVersion: '1.0.0',
      model: 'fixture-none', promptVersion: 'none', templateVersion: 'none', policy: 't2.7-permits-v1',
      project: P1, brand: null, market: 'fixture', locale: 'en-US', shipTo: 'none'
    },
    now: NOW
  });
  const op = idem.getOperation(env.db, operationId);
  idem.markSubmitted(env.db, operationId, { attemptToken: op.attemptToken, remoteId: ' SYNTHETIC-UNRECONCILED ', now: NOW });
  return { operationId, attemptToken: op.attemptToken };
}

test('T2.6 rev02 G3b: a mutated record input cannot skip the original submitted authority', { skip }, async () => {
  const env = openEnv('rev02-g3b');
  const { server, base } = await setupApp(env);
  try {
    const input = { text: 'SYNTHETIC-BOUND-ORIGINAL' };
    const sourceRunId = await rev02CreateRun(base, input.text);
    const op = rev02InjectSubmitted(env, sourceRunId, input);
    budget.ensureBudgetPool(env.db, { project: P1, brand: null, currency: 'USD', limitMicros: 1000000, now: NOW });
    budget.reserveBudget(env.db, {
      project: P1, brand: null, currency: 'USD', operationId: op.operationId, attemptToken: op.attemptToken,
      category: 'llm', priceBasis: 'synthetic-only', priceConfidence: 'placeholder', quantity: 1,
      eventId: 'SYNTHETIC-HOLD-REV02', maxEstimateMicros: 7331, now: NOW
    });
    // tamper ONLY the mutable record file (DB checkpoint/binding + original operation/hold untouched)
    rev02TamperRecord(env, sourceRunId, { input: { text: 'SYNTHETIC-CHANGED-RECORD' } });
    const before = store.listRuns(env.db, P1).length;
    const sourceBefore = store.getRun(env.db, P1, sourceRunId);
    const poolBefore = budget.getBudgetPool(env.db, { project: P1, brand: null, currency: 'USD' });
    const out = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(out.status, 409, 'mutable record.input changes recomputed operationId; original checkpoint still bound to original input+submitted op, must reject before creating retry');
    assert.equal(out.json.error.code, 'binding_input_mismatch');
    assert.equal(store.listRuns(env.db, P1).length, before, 'no retry run is created before the binding check');
    assert.deepEqual(store.getRun(env.db, P1, sourceRunId), sourceBefore, 'the source run is never modified');
    const after = idem.getOperation(env.db, op.operationId);
    assert.equal(after.state, 'submitted');
    assert.equal(after.remoteId, ' SYNTHETIC-UNRECONCILED ', 'the exact remote fact is never rewritten');
    assert.deepEqual(budget.getBudgetPool(env.db, { project: P1, brand: null, currency: 'USD' }), poolBefore, 'the hold stays unresolved and unchanged');
  } finally {
    closeServer(server);
  }
});

test('T2.6 rev02 G3b: identity, version and bound-plan mismatches fail closed with zero effect', { skip }, async () => {
  const env = openEnv('rev02-neg');
  const { server, base } = await setupApp(env);
  try {
    // (a) record inputVersion no longer matches the original binding
    const runA = await rev02CreateRun(base, 'SYNTHETIC-REV02-A');
    rev02TamperRecord(env, runA, { inputVersion: 'ui-v2' });
    const beforeA = store.listRuns(env.db, P1).length;
    const outA = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${runA}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(outA.status, 409);
    assert.equal(outA.json.error.code, 'binding_version_mismatch');
    assert.equal(store.listRuns(env.db, P1).length, beforeA);
    // (b) record claims a different runId
    const runB = await rev02CreateRun(base, 'SYNTHETIC-REV02-B');
    rev02TamperRecord(env, runB, { runId: 'run_other' });
    const outB = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${runB}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(outB.status, 409);
    assert.equal(outB.json.error.code, 'record_identity_mismatch');
    // (c) record claims another project
    const runC = await rev02CreateRun(base, 'SYNTHETIC-REV02-C');
    rev02TamperRecord(env, runC, { projectId: P2 });
    const outC = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${runC}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(outC.status, 403);
    assert.equal(outC.json.error.code, 'run_record_forbidden');
    // (d) the persisted bound plan no longer reproduces the checkpoint binding
    const runD = await rev02CreateRun(base, 'SYNTHETIC-REV02-D');
    const plan = JSON.parse(fs.readFileSync(rev02PlanPath(env, runD), 'utf8'));
    plan.plan.steps[0].input = { text: 'SYNTHETIC-PLAN-TAMPER' };
    fs.writeFileSync(rev02PlanPath(env, runD), JSON.stringify(plan));
    const beforeD = store.listRuns(env.db, P1).length;
    const outD = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${runD}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(outD.status, 409);
    assert.equal(outD.json.error.code, 'binding_mismatch');
    assert.equal(store.listRuns(env.db, P1).length, beforeD);
    // (e) missing original bound plan evidence is fail-closed, not free
    const runE = await rev02CreateRun(base, 'SYNTHETIC-REV02-E');
    fs.rmSync(rev02PlanPath(env, runE));
    const outE = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${runE}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(outE.status, 409);
    assert.equal(outE.json.error.code, 'binding_unavailable');
  } finally {
    closeServer(server);
  }
});

test('T2.6 rev02 G3b: a genuinely bound no-charge redo still creates a retryOf run', { skip }, async () => {
  const env = openEnv('rev02-legal');
  const { server, base } = await setupApp(env);
  try {
    const sourceRunId = await rev02CreateRun(base, 'SYNTHETIC-REDO-BOUND');
    const detail = await call(base, 'GET', `/tasks-api/projects/${P1}/runs/${sourceRunId}`, { token: TOKEN_OP });
    const artifactId = detail.json.data.artifacts[0].artifactId;
    const bytesBefore = Buffer.from(await (await fetch(`${base}/tasks-api/artifacts/${artifactId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } })).arrayBuffer());
    const sourceBefore = store.getRun(env.db, P1, sourceRunId);
    const redo = await call(base, 'POST', `/tasks-api/projects/${P1}/runs/${sourceRunId}/redo`, { token: TOKEN_OP, body: {} });
    assert.equal(redo.status, 201, 'a clean bound run without unresolved operations can still be redone');
    assert.equal(redo.json.data.retryOf, sourceRunId);
    assert.notEqual(redo.json.data.runId, sourceRunId);
    assert.deepEqual(store.getRun(env.db, P1, sourceRunId), sourceBefore, 'the original run record is never revived or modified');
    const bytesAfter = Buffer.from(await (await fetch(`${base}/tasks-api/artifacts/${artifactId}/download`, { headers: { 'x-tasks-session': TOKEN_OP } })).arrayBuffer());
    assert.ok(bytesBefore.equals(bytesAfter), 'the original artifact bytes are unchanged');
  } finally {
    closeServer(server);
  }
});
