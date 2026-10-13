'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, before, describe, it } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = 'server.js';
const MANAGED_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_VISION_MODEL',
  'DEEPSEEK_TIMEOUT_MS', 'DEEPSEEK_PORT',
  'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_VISION_MODEL', 'AI_TIMEOUT_MS',
  'FX_BASE_URL', 'FX_FALLBACK_URL', 'FX_TIMEOUT_MS', 'FX_CACHE_TTL_MS',
  'PORT'
];

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of MANAGED_ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

function prepareSandbox() {
  const base = path.join(PROJECT_ROOT, 'tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'test-'));
  fs.copyFileSync(path.join(PROJECT_ROOT, SERVER_ENTRY), path.join(dir, SERVER_ENTRY));
  fs.cpSync(path.join(PROJECT_ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.cpSync(path.join(PROJECT_ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  return dir;
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

function startMockProvider(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.on('error', () => {});
      req.on('error', () => {});
      handler(req, res).catch(() => {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{}');
        } catch { /* response already closed */ }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function startApp(cwd, env) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd,
    env: cleanEnv(env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Server did not start in time.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10000);
    const poll = setInterval(() => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    }, 25);
    child.once('exit', (code) => {
      clearInterval(poll);
      clearTimeout(deadline);
      reject(new Error(`Server exited early (code ${code}).\nstderr: ${stderr}`));
    });
  });

  return {
    ready,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    })
  };
}

async function request(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: response.status, headers: response.headers, text, json };
}

function postJson(baseUrl, pathname, body) {
  return request(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function createSessionClient(baseUrl) {
  let cookie = '';
  async function send(pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    if (cookie) headers.set('Cookie', cookie);
    const result = await request(`${baseUrl}${pathname}`, { ...options, headers });
    const setCookie = result.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    return result;
  }
  function post(pathname, body) {
    return send(pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  }
  return { request: send, post, get cookie() { return cookie; } };
}

const VALID_INPUT = {
  productName: 'Insulated tumbler',
  productDescription: 'A stainless-steel tumbler for daily drinks.',
  platforms: ['Xiaohongshu'],
  tone: 'clear and friendly'
};

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_IMAGE = { name: 'tumbler.png', mimeType: 'image/png', dataBase64: TINY_PNG_BASE64 };

function completion(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

const VALID_DRAFTS = { drafts: [{ platform: 'Xiaohongshu', title: 'Title', body: 'Body', reviewNotes: ['Check facts'] }] };

const STRUCTURED_DRAFTS = {
  drafts: [{
    platform: 'Xiaohongshu',
    title: '通勤保温杯',
    body: '第一段。\n第二段。',
    tags: ['保温杯', '通勤好物'],
    sellingPoints: ['24 小时保温'],
    reviewNotes: ['材质信息来自商家资料'],
    missingInfo: ['未提供包装清单']
  }]
};

const RISKY_DRAFTS = {
  drafts: [{
    platform: 'Xiaohongshu',
    title: '全网最低价保温杯',
    body: '全网最低价，容量 999ml，永久保温。',
    tags: ['保温杯'],
    sellingPoints: ['永不漏水'],
    reviewNotes: []
  }]
};

const PARTIAL_DRAFTS = {
  drafts: [{ platform: 'Xiaohongshu', title: '标题', body: '正文', reviewNotes: [] }]
};

const INTEL_REVIEW = {
  summary: '样本只有一条，建议补充官方来源。',
  confidence: { score: 68, level: 'medium', reasons: ['small_sample', 'unknown_source'] },
  caveats: ['样本只有 1 条'],
  recommendations: ['补充官方店铺页面']
};

describe('E-commerce demo server', () => {
  const sandbox = prepareSandbox();
  let mock;
  let providerMode = 'valid';
  let lastProviderRequest = null;

  function setMode(mode) {
    providerMode = mode;
    lastProviderRequest = null;
  }

  after(async () => {
    if (mock) await mock.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs the demo from a clean checkout with no environment file', async () => {
    const app = startApp(sandbox, { PORT: '0' });
    const baseUrl = await app.ready;
    try {
      const health = await request(`${baseUrl}/api/health`);
      assert.equal(health.status, 200);
      assert.equal(health.json.configured, false);
      assert.equal(health.json.model, 'deepseek-flash');
      assert.equal(health.json.visionConfigured, false);

      const generate = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(generate.status, 503);
      assert.equal(generate.json.error.code, 'provider_not_configured');

      const interpret = await postJson(baseUrl, '/api/intel/interpret', { kind: 'compare', result: { stats: { count: 0 } } });
      assert.equal(interpret.status, 503);
      assert.equal(interpret.json.error.code, 'provider_not_configured');
    } finally {
      await app.stop();
    }
  });

  describe('configured with a mock provider', () => {
    let app;
    let baseUrl;

    it('starts against the mock provider from an environment file', async () => {
      mock = await startMockProvider(async (req, res) => {
        lastProviderRequest = { url: req.url, auth: req.headers.authorization, body: await readRequestBody(req) };
        if (req.url.startsWith('/fx/')) {
          const base = req.url.split('/').pop() || 'USD';
          const rates = base === 'CNY'
            ? { CNY: 1, USD: 0.1429, EUR: 0.1313 }
            : { USD: 1, CNY: 7.1, EUR: 0.92 };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            result: 'success',
            base_code: base,
            rates,
            time_last_update_utc: 'Mon, 21 Sep 2026 00:00:00 +0000'
          }));
        }
        if (providerMode === 'valid') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion(JSON.stringify(VALID_DRAFTS)));
        }
        if (providerMode === 'structured') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion(JSON.stringify(STRUCTURED_DRAFTS)));
        }
        if (providerMode === 'risky') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion(JSON.stringify(RISKY_DRAFTS)));
        }
        if (providerMode === 'partial') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion(JSON.stringify(PARTIAL_DRAFTS)));
        }
        if (providerMode === 'intel-review') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion(JSON.stringify(INTEL_REVIEW)));
        }
        if (providerMode === 'fenced') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion(`\`\`\`json\n${JSON.stringify(VALID_DRAFTS)}\n\`\`\``));
        }
        if (providerMode === 'malformed') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion('this is not json'));
        }
        if (providerMode === 'not-array') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(completion(JSON.stringify({ drafts: { platform: 'Xiaohongshu' } })));
        }
        if (providerMode === 'unauthorized') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'bad key' } }));
        }
        if (providerMode === 'bad-request') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'unsupported content type' } }));
        }
        if (providerMode === 'server-error') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end('{}');
        }
        if (providerMode === 'slow') {
          setTimeout(() => {
            if (res.destroyed || res.writableEnded) return;
            try {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(completion(JSON.stringify(VALID_DRAFTS)));
            } catch { /* response already closed by the client timeout */ }
          }, 2000);
          return undefined;
        }
        return undefined;
      });

      fs.writeFileSync(
        path.join(sandbox, '.env.deepseek.local'),
        `DEEPSEEK_API_KEY=test-key\nDEEPSEEK_BASE_URL=${mock.url}\nDEEPSEEK_MODEL=deepseek-flash\nDEEPSEEK_VISION_MODEL=vision-model\nDEEPSEEK_TIMEOUT_MS=1500\nPORT=0\n`
      );

      app = startApp(sandbox, {
        FX_BASE_URL: `${mock.url}/fx`,
        FX_FALLBACK_URL: `${mock.url}/fx-fallback`
      });
      baseUrl = await app.ready;

      const health = await request(`${baseUrl}/api/health`);
      assert.equal(health.json.configured, true);
      assert.equal(health.json.visionConfigured, true);
    });

    after(async () => {
      if (app) await app.stop();
    });

    it('generates drafts from a well-formed provider response', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 200);
      assert.equal(result.json.data.drafts[0].platform, 'Xiaohongshu');
      assert.equal(result.json.meta.provider, 'deepseek');
      assert.equal(result.json.meta.model, 'deepseek-flash');
      assert.equal(result.json.meta.vision, false);
      assert.equal(result.json.meta.usedImages, 0);
      assert.equal(lastProviderRequest.url, '/chat/completions');
      assert.equal(lastProviderRequest.auth, 'Bearer test-key');
      const sent = JSON.parse(lastProviderRequest.body);
      assert.equal(sent.model, 'deepseek-flash');
      assert.equal(sent.response_format.type, 'json_object');
      assert.equal(sent.messages.length, 2);
      assert.equal(sent.messages[1].role, 'user');
      assert.equal(typeof sent.messages[1].content, 'string');
    });

    it('returns structured tags, selling points, and a server-side review', async () => {
      setMode('structured');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 200);
      const draft = result.json.data.drafts[0];
      assert.deepEqual(draft.tags, ['保温杯', '通勤好物']);
      assert.deepEqual(draft.sellingPoints, ['24 小时保温']);
      const review = result.json.data.review;
      assert.ok(review.missingInfo.includes('未提供包装清单'));
      assert.ok(review.missingInfo.some((item) => item.includes('价格')));
      assert.ok(review.complianceReminders.length >= 6);
      assert.deepEqual(review.coverage, { requested: ['Xiaohongshu'], returned: ['Xiaohongshu'] });
    });

    it('flags risky wording and unsupported numbers in generated drafts', async () => {
      setMode('risky');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 200);
      const warnings = result.json.data.review.riskWarnings;
      assert.ok(warnings.length >= 1);
      assert.ok(warnings.some((warning) => warning.term === '全网最低' && warning.severity === 'high'));
      assert.ok(warnings.some((warning) => warning.term === '永久'));
      assert.ok(result.json.data.review.factChecks.some((check) => check.claim === '999ml'));
    });

    it('warns when the model omits a requested platform', async () => {
      setMode('partial');
      const result = await postJson(baseUrl, '/api/generate', { ...VALID_INPUT, platforms: ['Xiaohongshu', 'Douyin'] });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.drafts.length, 1);
      assert.ok(result.json.data.review.missingInfo.some((item) => item.includes('Douyin')));
      assert.deepEqual(result.json.data.review.coverage.returned, ['Xiaohongshu']);
    });

    it('sends images as multimodal content and switches to the vision model', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', { ...VALID_INPUT, images: [TINY_PNG_IMAGE] });
      assert.equal(result.status, 200);
      assert.equal(result.json.meta.usedImages, 1);
      assert.equal(result.json.meta.vision, true);
      assert.equal(result.json.meta.model, 'vision-model');
      const sent = JSON.parse(lastProviderRequest.body);
      assert.equal(sent.model, 'vision-model');
      assert.ok(Array.isArray(sent.messages[1].content));
      assert.equal(sent.messages[1].content[0].type, 'text');
      assert.equal(sent.messages[1].content[1].type, 'image_url');
      assert.match(sent.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
      assert.equal(result.text.includes(TINY_PNG_BASE64), false);
    });

    it('maps a provider rejection of image input to vision_unsupported', async () => {
      setMode('bad-request');
      const withImages = await postJson(baseUrl, '/api/generate', { ...VALID_INPUT, images: [TINY_PNG_IMAGE] });
      assert.equal(withImages.status, 400);
      assert.equal(withImages.json.error.code, 'vision_unsupported');

      setMode('bad-request');
      const withoutImages = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(withoutImages.status, 400);
      assert.equal(withoutImages.json.error.code, 'provider_rejected');
    });

    it('rejects an image whose content does not match the declared type', async () => {
      const result = await postJson(baseUrl, '/api/generate', {
        ...VALID_INPUT,
        images: [{ name: 'fake.jpg', mimeType: 'image/jpeg', dataBase64: TINY_PNG_BASE64 }]
      });
      assert.equal(result.status, 400);
      assert.equal(result.json.error.code, 'validation');
    });

    it('rejects unsupported image formats', async () => {
      const result = await postJson(baseUrl, '/api/generate', {
        ...VALID_INPUT,
        images: [{ name: 'vector.svg', mimeType: 'image/svg+xml', dataBase64: TINY_PNG_BASE64 }]
      });
      assert.equal(result.status, 400);
      assert.equal(result.json.error.code, 'validation');
    });

    it('accepts providers that wrap JSON in a markdown code fence', async () => {
      setMode('fenced');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 200);
      assert.equal(result.json.data.drafts.length, 1);
    });

    it('reports invalid model output as a provider format error', async () => {
      setMode('malformed');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 502);
      assert.equal(result.json.error.code, 'invalid_model_output');
    });

    it('rejects a provider response whose drafts field is not an array', async () => {
      setMode('not-array');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 502);
      assert.equal(result.json.error.code, 'invalid_model_output');
    });

    it('passes through an authentication failure from the provider', async () => {
      setMode('unauthorized');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 401);
      assert.equal(result.json.error.code, 'provider_error');
    });

    it('maps an unexpected provider status to a bad gateway', async () => {
      setMode('server-error');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 502);
      assert.equal(result.json.error.code, 'provider_error');
    });

    it('times out a slow provider', async () => {
      setMode('slow');
      const result = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(result.status, 502);
      assert.equal(result.json.error.code, 'provider_unavailable');
      assert.match(result.json.error.message, /超时/);
    });

    it('rejects malformed request JSON', async () => {
      const result = await postJson(baseUrl, '/api/generate', '{not json');
      assert.equal(result.status, 400);
      assert.equal(result.json.error.code, 'invalid_json');
    });

    it('rejects a request that is missing required fields', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', { productName: 'Only a name' });
      assert.equal(result.status, 400);
      assert.equal(result.json.error.code, 'validation');
    });

    it('rejects unsupported platforms', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', { ...VALID_INPUT, platforms: ['Taobao'] });
      assert.equal(result.status, 400);
      assert.equal(result.json.error.code, 'validation');
    });

    it('accepts the extended product fields and forwards them to the provider', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', {
        ...VALID_INPUT,
        category: '家居 / 杯具',
        brand: 'Example',
        targetAudience: '通勤人群',
        priceInfo: '69 元',
        promotionInfo: '满 2 件 9 折',
        afterSales: '7 天无理由退换',
        sellingPoints: ['24 小时保温', '316 不锈钢内胆'],
        specifications: [{ name: '容量', value: '500ml' }]
      });
      assert.equal(result.status, 200);
      const sent = JSON.parse(JSON.parse(lastProviderRequest.body).messages[1].content);
      assert.equal(sent.category, '家居 / 杯具');
      assert.deepEqual(sent.sellingPoints, ['24 小时保温', '316 不锈钢内胆']);
      assert.deepEqual(sent.specifications, [{ name: '容量', value: '500ml' }]);
    });

    it('rejects an oversized request body', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', JSON.stringify({ ...VALID_INPUT, productDescription: 'x'.repeat(13 * 1024 * 1024) }));
      assert.equal(result.status, 413);
      assert.equal(result.json.error.code, 'too_large');
    });

    it('stays alive when a client disconnects mid-request', async () => {
      const port = Number(new URL(baseUrl).port);
      await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('POST /api/generate HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{"productName":');
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 30);
        });
        socket.on('error', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      setMode('valid');
      const health = await request(`${baseUrl}/api/health`);
      assert.equal(health.status, 200);
      const generate = await postJson(baseUrl, '/api/generate', VALID_INPUT);
      assert.equal(generate.status, 200);
    });

    it('serves the static demo page', async () => {      const result = await request(`${baseUrl}/`);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-type') || '', /text\/html/);
      assert.match(result.text, /电商内容助手/);
      assert.match(result.text, /name="sellingPoints"/);
      assert.match(result.text, /name="specifications"/);
      assert.match(result.text, /id="theme-switch"/);
      assert.match(result.text, /id="language-switch"/);
      assert.match(result.text, /id="download-pack"/);
      assert.match(result.text, /id="dropzone"/);
      assert.match(result.text, /value="Amazon"/);
    });

    it('serves the frontend script with the draft tooling', async () => {
      const result = await request(`${baseUrl}/app.js`);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-type') || '', /text\/javascript/);
      assert.match(result.text, /sellingPoints/);
    });

    it('serves the localization dictionaries and intel page', async () => {
      const i18n = await request(`${baseUrl}/i18n.js`);
      assert.equal(i18n.status, 200);
      assert.match(i18n.text, /CROSS-BORDER CONTENT STUDIO/);

      const intel = await request(`${baseUrl}/intel.html`);
      assert.equal(intel.status, 200);
      assert.match(intel.text, /intel\.html/);
      assert.match(intel.text, /id="score-form"/);
      assert.match(intel.text, /id="pricing-form"/);
      assert.match(intel.text, /id="fx-status"/);
      assert.match(intel.text, /id="batch-run"/);
      assert.match(intel.text, /id="market-run"/);

      const script = await request(`${baseUrl}/intel.js`);
      assert.equal(script.status, 200);
      assert.match(script.text, /api\/intel\/score/);
    });

    it('serves the report factory page and report status without starting a build', async () => {
      const page = await request(`${baseUrl}/reports.html`);
      assert.equal(page.status, 200);
      assert.match(page.text, /id="report-build"/);
      assert.match(page.text, /id="report-refresh-amazon"/);
      assert.match(page.text, /id="report-download-competitor"/);

      const script = await request(`${baseUrl}/reports.js`);
      assert.equal(script.status, 200);
      assert.match(script.text, /api\/reports\/build/);

      const status = await request(`${baseUrl}/api/reports/status`);
      assert.equal(status.status, 200);
      assert.equal(status.json.data.status, 'idle');
      assert.equal(status.json.data.source.dataBasis, 'Amazon.com 美国站公开前台；不使用 Seller Central、SP-API、广告 API 或卖家后台');
    });

    it('scores a sourcing candidate locally', async () => {
      const result = await postJson(baseUrl, '/api/intel/score', {
        name: 'Tumbler',
        price: 100,
        unitCost: 30,
        shippingCost: 10,
        platformFeeRate: 5,
        adCostPerUnit: 5,
        targetMarginRate: 30,
        demand: 4,
        competition: 3,
        differentiation: 4,
        risk: 2
      });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.metrics.marginRate, 50);
      assert.equal(result.json.data.verdict, 'recommended');
    });

    it('serves local competitor and price analysis without provider access', async () => {
      const compare = await postJson(baseUrl, '/api/intel/compare', {
        productName: 'Tumbler',
        price: 80,
        sellingPoints: ['heat retention'],
        competitors: [{
          platform: 'Tmall',
          title: 'A',
          price: 100,
          sellingPoints: ['gift box'],
          sourceType: 'official_store',
          sourceNote: 'https://example.com/item/1',
          observedAt: new Date().toISOString().slice(0, 10)
        }]
      });
      assert.equal(compare.status, 200);
      assert.equal(compare.json.data.stats.count, 1);
      assert.ok(compare.json.data.gaps.some((gap) => gap.keyword === 'gift box'));
      assert.equal(compare.json.data.ranking.length, 1);
      assert.equal(compare.json.data.ranking[0].credibility.sourceType, 'official_store');
      assert.ok(compare.json.data.dataCredibility.score > 0);
      assert.ok(['high', 'medium', 'low'].includes(compare.json.data.confidence.level));
      assert.ok(compare.json.data.dataCredibility.reasons.includes('single_source'));

      const prices = await postJson(baseUrl, '/api/intel/prices', {
        points: [
          { label: 'mine', price: 90, type: 'own', sourceType: 'merchant_record', sourceNote: 'order log', observedAt: new Date().toISOString().slice(0, 10) },
          { label: 'a', price: 120, sourceType: 'unknown', observedAt: new Date().toISOString().slice(0, 10) }
        ],
        unitCost: 30,
        platformFeeRate: 10,
        targetMarginRate: 25
      });
      assert.equal(prices.status, 200);
      assert.equal(prices.json.data.stats.count, 2);
      assert.equal(prices.json.data.costs.feasible, true);
      assert.equal(prices.json.data.points[0].credibility.sourceType, 'merchant_record');
      assert.equal(prices.json.data.points[1].credibility.sourceType, 'unknown');
      assert.ok(prices.json.data.dataCredibility.reasons.includes('unknown_source'));
      assert.ok(prices.json.data.timeline);
      assert.equal(prices.json.data.timeline.datedCount, 2);
    });

    it('serves the local Amazon public research status without starting a crawl', async () => {
      const result = await request(`${baseUrl}/api/amazon/research/status`);
      assert.equal(result.status, 200);
      assert.ok(['idle', 'completed', 'running', 'failed'].includes(result.json.data.status));
      assert.equal(result.json.data.config.onStart, false);
      assert.equal(typeof result.json.data.config.maxProductPages, 'number');
    });

    it('imports pasted price data with provenance', async () => {
      const result = await postJson(baseUrl, '/api/intel/import', {
        text: 'date,platform,label,price,type,source,note\n2026-09-01,Tmall,A,109,competitor,official_store,page URL\n2026-09-15,Tmall,A,105,competitor,official_store,page URL'
      });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.rows.length, 2);
      assert.equal(result.json.data.rows[1].price, 105);
      assert.equal(result.json.data.rows[0].sourceType, 'official_store');
      assert.equal(result.json.data.skipped, 0);

      const empty = await postJson(baseUrl, '/api/intel/import', { text: '' });
      assert.equal(empty.status, 400);
      assert.equal(empty.json.error.code, 'validation');
    });

    it('reviews intel data with the model using the credibility contract', async () => {
      setMode('intel-review');
      const result = await postJson(baseUrl, '/api/intel/interpret', {
        kind: 'compare',
        locale: 'en',
        result: { stats: { count: 1 }, dataCredibility: { score: 62, level: 'medium', sampleCount: 1 } }
      });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.confidence.score, 68);
      assert.equal(result.json.data.confidence.level, 'medium');
      assert.deepEqual(result.json.data.caveats, ['样本只有 1 条']);
      assert.equal(result.json.meta.model, 'deepseek-flash');
      assert.equal(result.json.meta.locale, 'en');
      const sent = JSON.parse(lastProviderRequest.body);
      assert.match(sent.messages[0].content, /Source credibility contract/);
      assert.equal(sent.messages[0].role, 'system');
      assert.equal(sent.response_format.type, 'json_object');
    });

    it('validates intel review requests', async () => {
      setMode('intel-review');
      const missing = await postJson(baseUrl, '/api/intel/interpret', { result: {} });
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error.code, 'validation');
      const badJson = await postJson(baseUrl, '/api/intel/interpret', '{not json');
      assert.equal(badJson.status, 400);
    });

    it('assesses a pasted candidate list and ranks it', async () => {
      const result = await postJson(baseUrl, '/api/intel/batch', {
        text: 'name,cost,price,shipping,fee,ad,target,demand,competition,differentiation,risk,notes\nHelmet A,55,29.9,12,15,4,30,4,4,3,2,light\nHelmet B,80,39.9,15,15,6,30,3,3,4,2,MIPS'
      });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.summary.total, 2);
      assert.ok(Array.isArray(result.json.data.rows));
      assert.ok(['recommended', 'watch', 'avoid'].includes(result.json.data.rows[0].verdict));
      assert.ok(result.json.data.rows[0].marketFitScore >= 0);
      assert.ok(result.json.data.summary.topMarketFit);

      const empty = await postJson(baseUrl, '/api/intel/batch', { text: '' });
      assert.equal(empty.status, 400);
      assert.equal(empty.json.error.code, 'validation');
    });

    it('analyses pasted public market records', async () => {
      const result = await postJson(baseUrl, '/api/intel/market', {
        dataBasis: 'public_front_end',
        observedAt: '2026-09-21',
        text: 'keyword,position,title,brand,price,rating,reviews,bought,badge,note,asin,image,url,store,source,observedAt\nbike helmet,1,Adult Bike Helmet with MIPS,BrandA,39.99,4.6,12453,10K+ bought in past month,Amazon\'s Choice,commuter,B000123,https://m.media-amazon.com/images/I/helmet.jpg,https://www.amazon.com/dp/B000123,BrandA Store,platform_search,2026-09-21'
      });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.sample, 1);
      assert.ok(['high', 'medium', 'low'].includes(result.json.data.entry.level));
      assert.equal(result.json.data.demand.monthlyUnitsFloor, 10000);
      assert.equal(result.json.data.demand.cumulativeUnitsEstimate, 12453 * 100);
      assert.equal(result.json.data.products[0].asin, 'B000123');
      assert.equal(result.json.data.provenance.dataBasis, 'public_front_end');
      assert.equal(result.json.data.provenance.observedAt, '2026-09-21');

      const empty = await postJson(baseUrl, '/api/intel/market', { text: '' });
      assert.equal(empty.status, 400);
    });

    it('serves exchange rates from the configured provider', async () => {
      const result = await request(`${baseUrl}/api/fx?base=CNY`);
      assert.equal(result.status, 200);
      assert.equal(result.json.data.base, 'CNY');
      assert.ok(result.json.data.rates.USD > 0);
      assert.equal(result.json.data.source, 'open.er-api.com');
    });

    it('computes multi-currency pricing locally', async () => {
      const result = await postJson(baseUrl, '/api/intel/pricing', {
        payoutCurrency: 'USD',
        rates: { USD: 1, CNY: 7 },
        productCost: { amount: 70, currency: 'CNY' },
        shipping: { mode: 'per_unit', amount: 14, currency: 'CNY' },
        referralFeeRate: 15,
        fulfillmentFee: { amount: 4, currency: 'USD' },
        adCost: { mode: 'percent', amount: 10 },
        targetMarginRate: 30
      });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.perUnit.productCost, 10);
      assert.equal(result.json.data.suggestedPrice, 35.56);
    });

    it('generates Amazon drafts using the Amazon guide', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', { ...VALID_INPUT, platforms: ['Amazon'], locale: 'en' });
      assert.equal(result.status, 200);
      assert.equal(result.json.data.drafts[0].platform, 'Amazon');
      const sent = JSON.parse(lastProviderRequest.body);
      assert.match(sent.messages[0].content, /Amazon North America/);
    });

    it('validates intel requests and localizes the errors', async () => {
      const score = await postJson(baseUrl, '/api/intel/score', { name: '', price: 0 });
      assert.equal(score.status, 400);
      assert.equal(score.json.error.code, 'validation');

      const compareEn = await postJson(baseUrl, '/api/intel/compare', { locale: 'en', price: 10, competitors: [] });
      assert.equal(compareEn.status, 400);
      assert.match(compareEn.json.error.message, /competitor/i);

      const prices = await postJson(baseUrl, '/api/intel/prices', { points: [] });
      assert.equal(prices.status, 400);

      const unknown = await postJson(baseUrl, '/api/intel/unknown', {});
      assert.equal(unknown.status, 404);
    });

    it('generates English drafts and review output when locale is en', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', { ...VALID_INPUT, locale: 'en' });
      assert.equal(result.status, 200);
      assert.equal(result.json.meta.locale, 'en');
      const sent = JSON.parse(lastProviderRequest.body);
      assert.match(sent.messages[0].content, /You are an e-commerce content assistant/);
      assert.ok(result.json.data.review.missingInfo.some((item) => /No price/.test(item)));
    });

    it('blocks directory traversal in static paths', async () => {
      const result = await request(`${baseUrl}/%2e%2e/%2e%2e/README.md`);
      assert.equal(result.status, 404);
    });

    it('returns 404 for unknown routes', async () => {
      const result = await request(`${baseUrl}/does-not-exist`);
      assert.equal(result.status, 404);
    });

    it('returns 405 for unsupported methods', async () => {
      const result = await postJson(baseUrl, '/api/health', {});
      assert.equal(result.status, 405);
    });
  });

  describe('static report package workflow API', () => {
    const workflowSandbox = prepareSandbox();
    const secret = Buffer.alloc(32, 0x5a);
    const producerSessionId = 'static-package-producer';
    let workflowApp;
    let workflowBaseUrl;
    let producerCookie;

    function signedCookie(sessionId) {
      const signature = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
      return `report_actor=${encodeURIComponent(`${sessionId}.${signature}`)}`;
    }

    function authedRequest(pathname, cookie, options = {}) {
      const headers = new Headers(options.headers || {});
      if (cookie) headers.set('Cookie', cookie);
      return request(`${workflowBaseUrl}${pathname}`, { ...options, headers });
    }

    function authedPost(pathname, cookie, body) {
      return authedRequest(pathname, cookie, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    }

    before(async () => {
      const tmp = path.join(workflowSandbox, 'tmp');
      const reports = path.join(workflowSandbox, 'reports');
      fs.mkdirSync(tmp, { recursive: true });
      fs.mkdirSync(reports, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'report-session-secret'), secret);
      producerCookie = signedCookie(producerSessionId);
      const competitorName = 'Amazon美国站头盔竞品爆款拆解_test.xlsx';
      const yongbaoName = '永宝产品美国站进入潜力评估_test.xlsx';
      fs.writeFileSync(path.join(reports, competitorName), Buffer.from('PK-competitor-test'));
      fs.writeFileSync(path.join(reports, yongbaoName), Buffer.from('PK-yongbao-test'));
      fs.writeFileSync(path.join(tmp, 'report-workflow-latest.json'), JSON.stringify({
        competitor: { file: { fileName: competitorName, downloadUrl: '/api/reports/download/competitor' } },
        yongbao: { file: { fileName: yongbaoName, downloadUrl: '/api/reports/download/yongbao' } }
      }));
      fs.writeFileSync(path.join(tmp, 'report-workflow-state.json'), JSON.stringify({
        status: 'completed', jobId: 'static-report-test', revision: 4, buildVersion: 2,
        producer: { name: 'Static report producer', sessionId: producerSessionId },
        audit: {
          status: '待独立审核', releaseAllowed: false, revision: 4, buildVersion: 2,
          issues: [], gates: { facts: false, links: false, comments: false, conclusions: false }
        },
        auditHistory: []
      }));
      workflowApp = startApp(workflowSandbox, { PORT: '0' });
      workflowBaseUrl = await workflowApp.ready;
    });

    after(async () => {
      if (workflowApp) await workflowApp.stop();
      fs.rmSync(workflowSandbox, { recursive: true, force: true });
    });

    it('binds static report audit and repair authorization to signed cookies, not request-body identities', async () => {
      const producerSession = await authedRequest('/api/reports/session', producerCookie);
      assert.equal(producerSession.status, 200);
      assert.equal(producerSession.json.data.sessionId, producerSessionId);
      assert.equal(producerSession.headers.get('set-cookie'), null);

      const reviewer = createSessionClient(workflowBaseUrl);
      const reviewerSession = await reviewer.request('/api/reports/session');
      assert.match(reviewerSession.headers.get('set-cookie') || '', /HttpOnly/);
      assert.match(reviewerSession.headers.get('set-cookie') || '', /SameSite=Strict/);
      assert.notEqual(reviewerSession.json.data.sessionId, producerSessionId);

      for (const kind of ['competitor', 'yongbao']) {
        const blocked = await authedRequest(`/api/reports/download/${kind}`, reviewer.cookie);
        assert.equal(blocked.status, 409);
        assert.equal(blocked.json.error.code, 'release_blocked');
      }

      const selfAudit = await authedPost('/api/reports/audit', producerCookie, {
        action: 'return', reviewer: 'Independent reviewer', reviewerSessionId: reviewerSession.json.data.sessionId,
        revision: 4, buildVersion: 2, gates: {}, issues: ['核对来源身份绑定']
      });
      assert.equal(selfAudit.status, 403);
      assert.equal(selfAudit.json.error.code, 'self_audit_forbidden');

      const returned = await reviewer.post('/api/reports/audit', {
        action: 'return', reviewer: 'Independent reviewer', reviewerSessionId: producerSessionId,
        revision: 4, buildVersion: 2, gates: {}, issues: ['核对来源身份绑定']
      });
      assert.equal(returned.status, 200);
      assert.equal(returned.json.data.audit.reviewerSessionId, reviewerSession.json.data.sessionId);
      assert.equal(returned.json.data.audit.status, '退回纠错');
      assert.ok(returned.json.data.audit.checkedAt);

      const reviewerRepair = await reviewer.post('/api/reports/build', {
        actorSessionId: producerSessionId, repairNotes: '伪造制作会话修复'
      });
      assert.equal(reviewerRepair.status, 409);
      assert.equal(reviewerRepair.json.error.code, 'repair_producer_required');

      const missingNotes = await authedPost('/api/reports/build', producerCookie, {});
      assert.equal(missingNotes.status, 409);
      assert.equal(missingNotes.json.error.code, 'repair_notes_required');

      const stillBlocked = await authedRequest('/api/reports/download/competitor', reviewer.cookie);
      assert.equal(stillBlocked.status, 409);
      assert.equal(stillBlocked.json.error.code, 'release_blocked');
    });

    it('serves both static workbooks only when the persisted review record is approved', async () => {
      const approvedSandbox = prepareSandbox();
      const tmp = path.join(approvedSandbox, 'tmp');
      const reports = path.join(approvedSandbox, 'reports');
      fs.mkdirSync(tmp, { recursive: true });
      fs.mkdirSync(reports, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'report-session-secret'), secret);
      const competitorName = 'Amazon美国站头盔竞品爆款拆解_approved.xlsx';
      const yongbaoName = '永宝产品美国站进入潜力评估_approved.xlsx';
      fs.writeFileSync(path.join(reports, competitorName), Buffer.from('PK-approved-competitor'));
      fs.writeFileSync(path.join(reports, yongbaoName), Buffer.from('PK-approved-yongbao'));
      fs.writeFileSync(path.join(tmp, 'report-workflow-state.json'), JSON.stringify({
        status: 'completed', jobId: 'approved-static-report', revision: 5, buildVersion: 3,
        producer: { name: 'Producer', sessionId: producerSessionId },
        audit: {
          status: '独立审核通过', reviewer: 'Independent reviewer', reviewerSessionId: 'reviewer-session',
          checkedAt: '2026-09-24T12:00:00.000Z', revision: 5, buildVersion: 3,
          issues: [], gates: { facts: true, links: true, comments: true, conclusions: true }, releaseAllowed: true
        },
        auditHistory: []
      }));
      const app = startApp(approvedSandbox, { PORT: '0' });
      try {
        const baseUrl = await app.ready;
        for (const [kind, marker] of [['competitor', 'PK-approved-competitor'], ['yongbao', 'PK-approved-yongbao']]) {
          const response = await request(`${baseUrl}/api/reports/download/${kind}`);
          assert.equal(response.status, 200);
          assert.match(response.headers.get('content-type') || '', /spreadsheetml/);
          assert.equal(response.text, marker);
        }
      } finally {
        await app.stop();
        fs.rmSync(approvedSandbox, { recursive: true, force: true });
      }
    });
  });

  describe('report jobs API', () => {
    const jobSandbox = prepareSandbox();
    let jobApp;
    let jobBaseUrl;

    function samplePdfBuffer() {
      const body = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R >> endobj
4 0 obj << /Length 70 >> stream
BT /F1 12 Tf 72 720 Td (Helmet catalog ABC-123 ultralight road shell with CPSC report) Tj ET
endstream endobj
5 0 obj << /Type /Page /Parent 2 0 R >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
      return Buffer.from(body, 'latin1');
    }

    function uploadForm(buffer, type = 'application/pdf', name = 'catalog.pdf') {
      const form = new FormData();
      form.append('taskType', 'pdf_catalog');
      form.append('file', new Blob([buffer], { type }), name);
      return form;
    }

    before(async () => {
      jobApp = startApp(jobSandbox, { PORT: '0' });
      jobBaseUrl = await jobApp.ready;
    });

    after(async () => {
      await jobApp.stop();
      fs.rmSync(jobSandbox, { recursive: true, force: true });
    });

    it('uploads a PDF catalog and blocks research or build before confirmation', async () => {
      const producer = createSessionClient(jobBaseUrl);
      const session = await producer.request('/api/reports/session');
      assert.equal(session.status, 200);
      assert.ok(producer.cookie);
      assert.match(session.headers.get('set-cookie') || '', /HttpOnly/);
      assert.match(session.headers.get('set-cookie') || '', /SameSite=Strict/);
      const reusedSession = await producer.request('/api/reports/session');
      assert.equal(reusedSession.json.data.sessionId, session.json.data.sessionId);
      assert.equal(reusedSession.headers.get('set-cookie'), null);

      const upload = await producer.request('/api/reports/jobs', { method: 'POST', body: uploadForm(samplePdfBuffer()) });
      assert.equal(upload.status, 202);
      assert.equal(upload.json.data.status, 'awaiting_confirmation');
      assert.equal(upload.json.data.revision, 1);
      assert.equal(upload.json.data.analysis.pageCount, 2);
      const jobId = upload.json.data.jobId;
      assert.equal(upload.json.data.producer.sessionId, session.json.data.sessionId);

      const build = await producer.post(`/api/reports/jobs/${jobId}/build`, { revision: 1, actorSessionId: 'spoofed-producer' });
      assert.equal(build.status, 409);
      assert.equal(build.json.error.code, 'confirmation_required');

      const research = await producer.post(`/api/reports/jobs/${jobId}/research`, { revision: 1 });
      assert.equal(research.status, 409);
      assert.equal(research.json.error.code, 'confirmation_required');

      const stale = await producer.post(`/api/reports/jobs/${jobId}/confirm`, { revision: 9, corrections: {} });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.error.code, 'revision_conflict');

      const confirmed = await producer.post(`/api/reports/jobs/${jobId}/confirm`, {
        revision: 1,
        corrections: { category: '骑行头盔', rulePackId: 'helmet-v1', researchBrief: { marketGroups: [{ label: '通勤', keywords: ['commute helmet'] }] } }
      });
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.json.data.status, 'confirmed');
      assert.equal(confirmed.json.data.revision, 2);
    });

    it('binds preview, list, and download to the same job version', async () => {
      const producer = createSessionClient(jobBaseUrl);
      const producerSession = await producer.request('/api/reports/session');
      const upload = await producer.request('/api/reports/jobs', { method: 'POST', body: uploadForm(samplePdfBuffer()) });
      const jobId = upload.json.data.jobId;
      assert.equal(upload.json.data.producer.sessionId, producerSession.json.data.sessionId);
      await producer.post(`/api/reports/jobs/${jobId}/confirm`, { revision: 1, corrections: {} });
      const build = await producer.post(`/api/reports/jobs/${jobId}/build`, { revision: 2 });
      assert.equal(build.status, 200);
      assert.equal(build.json.data.status, 'completed');
      const artifact = build.json.data.artifacts[0];

      const list = await request(`${jobBaseUrl}/api/reports/jobs/${jobId}/workbooks`);
      assert.equal(list.status, 200);
      assert.equal(list.json.data.length, 1);
      assert.equal(list.json.data[0].artifactId, artifact.artifactId);
      assert.equal(list.json.data[0].filePath, undefined);
      assert.equal(list.json.data[0].manifestPath, undefined);

      const preview = await request(`${jobBaseUrl}/api/reports/jobs/${jobId}/workbooks/${artifact.workbookId}/preview`);
      assert.equal(preview.status, 200);
      assert.equal(preview.json.data.manifest.artifactId, artifact.artifactId);
      assert.equal(preview.json.data.revision, 2);
      assert.equal(preview.json.data.buildVersion, 1);

      const withheld = await request(`${jobBaseUrl}${artifact.downloadUrl}`);
      assert.equal(withheld.status, 409);
      assert.equal(withheld.json.error.code, 'release_blocked');

      const selfAudit = await producer.post(`/api/reports/jobs/${jobId}/audit`, {
        action: 'return', reviewer: 'Independent reviewer', reviewerSessionId: 'forged-independent-session',
        revision: 2, buildVersion: 1, gates: {}, issues: ['自审身份伪造不应通过']
      });
      assert.equal(selfAudit.status, 403);
      assert.equal(selfAudit.json.error.code, 'self_audit_forbidden');

      const reviewer = createSessionClient(jobBaseUrl);
      const reviewerSession = await reviewer.request('/api/reports/session');
      assert.notEqual(reviewerSession.json.data.sessionId, producerSession.json.data.sessionId);
      const returned = await reviewer.post(`/api/reports/jobs/${jobId}/audit`, {
        action: 'return', reviewer: 'Independent reviewer', reviewerSessionId: producerSession.json.data.sessionId,
        revision: 2, buildVersion: 1,
        gates: { facts: true }, issues: ['请核对该任务来源事实']
      });
      assert.equal(returned.status, 200);
      assert.equal(returned.json.data.audit.releaseAllowed, false);
      assert.equal(returned.json.data.audit.reviewerSessionId, reviewerSession.json.data.sessionId);
      assert.ok(returned.json.data.audit.checkedAt);

      const spoofedRepair = await reviewer.post(`/api/reports/jobs/${jobId}/confirm`, {
        revision: 2, corrections: { category: 'changed' }, repairNotes: '由非制作者提交',
        actorSessionId: producerSession.json.data.sessionId
      });
      assert.equal(spoofedRepair.status, 409);
      assert.equal(spoofedRepair.json.error.code, 'repair_producer_required');

      const reconfirm = await producer.post(`/api/reports/jobs/${jobId}/confirm`, {
        revision: 2, corrections: { category: 'changed' }, repairNotes: '已核对并修正来源事实。',
        actorSessionId: 'spoofed-nonproducer'
      });
      assert.equal(reconfirm.status, 200);
      assert.equal(reconfirm.json.data.revision, 3);
      const stalePreview = await request(`${jobBaseUrl}/api/reports/jobs/${jobId}/workbooks/${artifact.workbookId}/preview`);
      assert.equal(stalePreview.status, 409);
      assert.equal(stalePreview.json.error.code, 'artifact_version_mismatch');
      const staleDownload = await request(`${jobBaseUrl}${artifact.downloadUrl}`);
      assert.equal(staleDownload.status, 409);
      assert.equal(staleDownload.json.error.code, 'artifact_version_mismatch');

      const secondBuild = await producer.post(`/api/reports/jobs/${jobId}/build`, { revision: 3 });
      assert.equal(secondBuild.status, 200);
      assert.equal(secondBuild.json.data.buildVersion, 2);
      assert.equal(secondBuild.json.data.auditHistory.length, 2);
      const currentArtifact = secondBuild.json.data.artifacts[0];
      const audit = await reviewer.post(`/api/reports/jobs/${jobId}/audit`, {
        action: 'approve', reviewer: 'Independent reviewer Two', reviewerSessionId: producerSession.json.data.sessionId,
        revision: 3, buildVersion: 2,
        gates: { facts: true, links: true, comments: true, conclusions: true }, issues: []
      });
      assert.equal(audit.status, 200);
      assert.equal(audit.json.data.audit.releaseAllowed, true);

      const download = await fetch(`${jobBaseUrl}${currentArtifact.downloadUrl}`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-type'), /spreadsheetml/);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK');

      const approvedEdit = await producer.post(`/api/reports/jobs/${jobId}/confirm`, { revision: 3, corrections: { category: 'changed' } });
      assert.equal(approvedEdit.status, 409);
      assert.equal(approvedEdit.json.error.code, 'review_return_required');
    });

    it('rejects non-PDF uploads, traversal ids, and unknown jobs', async () => {
      const wrongMagic = await request(`${jobBaseUrl}/api/reports/jobs`, { method: 'POST', body: uploadForm(Buffer.from('not a pdf'), 'application/pdf', 'fake.pdf') });
      assert.equal(wrongMagic.status, 415);
      assert.equal(wrongMagic.json.error.code, 'pdf_magic_mismatch');
      assert.ok(wrongMagic.json.jobId);

      const wrongType = await request(`${jobBaseUrl}/api/reports/jobs`, { method: 'POST', body: uploadForm(samplePdfBuffer(), 'text/plain', 'catalog.txt') });
      assert.equal(wrongType.status, 415);
      assert.equal(wrongType.json.error.code, 'unsupported_media_type');

      const unknown = await request(`${jobBaseUrl}/api/reports/jobs/report-missing`);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error.code, 'job_not_found');

      const traversal = await request(`${jobBaseUrl}/api/reports/jobs/report-missing/workbooks/${encodeURIComponent('../../etc')}/preview`);
      assert.equal(traversal.status, 404);
      assert.equal(traversal.json.error.code, 'job_not_found');
    });

    it('creates track analysis jobs over JSON without a PDF', async () => {
      const created = await postJson(jobBaseUrl, '/api/reports/jobs', {
        taskType: 'track_analysis',
        brief: { category: '汽车配件', country: '美国', marketGroups: [{ label: '车载支架', keywords: ['car mount'] }] }
      });
      assert.equal(created.status, 202);
      assert.equal(created.json.data.taskType, 'track_analysis');
      assert.equal(created.json.data.status, 'awaiting_confirmation');
      assert.equal(created.json.data.analysis.categoryHypotheses[0].rulePackId, 'unknown-v1');
    });

    it('serves saved no-PDF image evidence to workbook previews while the download gate stays closed', async () => {
      const created = await postJson(jobBaseUrl, '/api/reports/jobs', {
        taskType: 'track_analysis', brief: { category: 'Cycling helmets', marketplace: 'Amazon.com' }
      });
      const jobId = created.json.data.jobId;
      const screenshotDataUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
      const confirmed = await postJson(jobBaseUrl, `/api/reports/jobs/${jobId}/confirm`, {
        revision: 1,
        corrections: { productCandidates: [{
          candidateId: 'preview-H0-022', model: 'H0-022', displayName: '成人无灯基础款', modelConfirmed: false,
          trialImport: { sampleId: 'helmet-mvp-trial-2026-09-29', importedStatus: 'draft; not approved' },
          sourceScreenshot: 'H0-022.jpg', sourceFileModifiedLocal: '2026-09-23',
          productDescriptionFromScreenshot: 'Adult cycling helmet; supplier screenshot claims certification; not independently verified.',
          cost: { amount: 16, currency: 'CNY', unit: 'CNY/顶', incoterm: '待供应商核实', variant: 'standard helmet, no light', fxToUSD: null, fxDate: '', confirmed: false, sourceLocation: 'H0-022.jpg' },
          costEvidenceDataUrl: screenshotDataUrl,
          shipping: { volumetricDivisor: 5000, divisorConfirmed: false, confirmed: false, cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }], illustrativeRatePerKg: 55.7, illustrativeRateSource: 'Conditional example only', rate: { perKg: '', currency: 'CNY', magneticInspectionPerShipment: 480, magneticFeeApplicable: 'unknown', confirmed: false } },
          batteryType: 'unknown', batteryTypeConfirmed: false, fees: { confirmed: false },
          competitors: [{ asin: 'B0FTS7RHR3', url: 'https://www.amazon.com/dp/B0FTS7RHR3', title: 'ROCKBROS', brand: 'ROCKBROS', variantLabel: 'Large / no light', price: 45.99, currency: 'USD', observedAt: '2026-09-29T20:07:58+08:00', similarity: 'similar', matchConfirmed: true, sourceType: 'user_trial_draft', screenshotDataUrl, screenshotReference: 'pdp.jpg', reviewsVisible: [{ rating: 5, title: 'Comfortable', text: 'Original review.', chineseTranslation: '中文翻译。', reviewId: 'R1234567890', reviewUrl: 'https://www.amazon.com/gp/customer-reviews/R1234567890?ASIN=B0FTS7RHR3' }] }]
        }] }
      });
      assert.equal(confirmed.status, 200);
      const build = await postJson(jobBaseUrl, `/api/reports/jobs/${jobId}/build`, { revision: 2 });
      assert.equal(build.status, 200);
      assert.ok(build.json.data.artifacts[0].filePath.startsWith(path.join(jobSandbox, 'reports')));
      const artifact = build.json.data.artifacts[0];
      const preview = await request(`${jobBaseUrl}/api/reports/jobs/${jobId}/workbooks/${artifact.workbookId}/preview`);
      assert.equal(preview.status, 200);
      const productSheet = preview.json.data.manifest.sheets.find((sheet) => sheet.name === '02_供应配置图卡');
      assert.equal(productSheet.imageEvidence.length, 1);
      const image = await fetch(`${jobBaseUrl}${productSheet.imageEvidence[0].imageUrl}`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal(Buffer.from(await image.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const blockedDownload = await request(`${jobBaseUrl}${artifact.downloadUrl}`);
      assert.equal(blockedDownload.status, 409);
      assert.equal(blockedDownload.json.error.code, 'release_blocked');
    });
  });
});
