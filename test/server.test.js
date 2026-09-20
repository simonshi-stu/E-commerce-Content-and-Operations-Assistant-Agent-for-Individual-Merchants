'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, describe, it } = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = 'server.js';
const MANAGED_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_TIMEOUT_MS', 'DEEPSEEK_PORT',
  'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'AI_TIMEOUT_MS',
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

function completion(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

const VALID_DRAFTS = { drafts: [{ platform: 'Xiaohongshu', title: 'Title', body: 'Body', reviewNotes: ['Check facts'] }] };

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
        `DEEPSEEK_API_KEY=test-key\nDEEPSEEK_BASE_URL=${mock.url}\nDEEPSEEK_MODEL=deepseek-flash\nDEEPSEEK_TIMEOUT_MS=1500\nPORT=0\n`
      );

      app = startApp(sandbox, {});
      baseUrl = await app.ready;

      const health = await request(`${baseUrl}/api/health`);
      assert.equal(health.json.configured, true);
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
      assert.equal(lastProviderRequest.url, '/chat/completions');
      assert.equal(lastProviderRequest.auth, 'Bearer test-key');
      const sent = JSON.parse(lastProviderRequest.body);
      assert.equal(sent.model, 'deepseek-flash');
      assert.equal(sent.response_format.type, 'json_object');
      assert.equal(sent.messages.length, 2);
      assert.equal(sent.messages[1].role, 'user');
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
      assert.match(result.json.error.message, /timed out/i);
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

    it('rejects an oversized request body', async () => {
      setMode('valid');
      const result = await postJson(baseUrl, '/api/generate', JSON.stringify({ ...VALID_INPUT, productDescription: 'x'.repeat(70000) }));
      assert.equal(result.status, 413);
      assert.equal(result.json.error.code, 'too_large');
    });

    it('serves the static demo page', async () => {
      const result = await request(`${baseUrl}/`);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-type') || '', /text\/html/);
      assert.match(result.text, /E-commerce Content Demo/);
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
