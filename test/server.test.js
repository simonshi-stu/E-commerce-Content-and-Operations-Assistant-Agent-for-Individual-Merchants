'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, describe, it } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = 'server.js';
const MANAGED_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_VISION_MODEL',
  'DEEPSEEK_TIMEOUT_MS', 'DEEPSEEK_PORT',
  'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_VISION_MODEL', 'AI_TIMEOUT_MS',
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

      app = startApp(sandbox, {});
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

      const script = await request(`${baseUrl}/intel.js`);
      assert.equal(script.status, 200);
      assert.match(script.text, /api\/intel\/score/);
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
        competitors: [{ platform: 'Tmall', title: 'A', price: 100, sellingPoints: ['gift box'] }]
      });
      assert.equal(compare.status, 200);
      assert.equal(compare.json.data.stats.count, 1);
      assert.ok(compare.json.data.gaps.some((gap) => gap.keyword === 'gift box'));

      const prices = await postJson(baseUrl, '/api/intel/prices', {
        points: [{ label: 'mine', price: 90, type: 'own' }, { label: 'a', price: 120 }],
        unitCost: 30,
        platformFeeRate: 10,
        targetMarginRate: 25
      });
      assert.equal(prices.status, 200);
      assert.equal(prices.json.data.stats.count, 2);
      assert.equal(prices.json.data.costs.feasible, true);
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
});
