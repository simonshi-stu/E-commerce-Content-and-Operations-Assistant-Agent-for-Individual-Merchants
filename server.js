'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 4_000;
const ALLOWED_PLATFORMS = new Set(['Xiaohongshu', 'Douyin', 'Tmall', 'Pinduoduo']);
const PARENT_ENV = Object.freeze({ ...process.env });
const LOCAL_DEEPSEEK_ENV = readEnvFile('.env.deepseek.local');
const GENERIC_ENV = readEnvFile('.env');

function readEnvFile(fileName) {
  const envPath = path.join(ROOT, fileName);
  if (!fs.existsSync(envPath)) return Object.freeze({});
  const values = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return Object.freeze(values);
}

function resolveConfigValue(deepseekName, legacyName, fallback = '') {
  for (const source of [PARENT_ENV, LOCAL_DEEPSEEK_ENV, GENERIC_ENV]) {
    if (source[deepseekName] !== undefined) return source[deepseekName];
    if (legacyName && source[legacyName] !== undefined) return source[legacyName];
  }
  return fallback;
}

function parsePort(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 5178;
}

function config() {
  return {
    provider: resolveConfigValue('DEEPSEEK_PROVIDER', 'AI_PROVIDER', 'deepseek'),
    apiKey: resolveConfigValue('DEEPSEEK_API_KEY', 'AI_API_KEY'),
    model: resolveConfigValue('DEEPSEEK_MODEL', 'AI_MODEL', 'deepseek-flash'),
    baseUrl: resolveConfigValue('DEEPSEEK_BASE_URL', 'AI_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    timeoutMs: Number.parseInt(resolveConfigValue('DEEPSEEK_TIMEOUT_MS', 'AI_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)), 10) || DEFAULT_TIMEOUT_MS,
    port: parsePort(resolveConfigValue('DEEPSEEK_PORT', 'PORT', '5178'))
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(value));
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

function validateInput(value) {
  const productName = typeof value.productName === 'string' ? value.productName.trim() : '';
  const productDescription = typeof value.productDescription === 'string' ? value.productDescription.trim() : '';
  const tone = typeof value.tone === 'string' ? value.tone.trim() : 'clear and helpful';
  const platforms = Array.isArray(value.platforms) ? [...new Set(value.platforms.filter((item) => typeof item === 'string' && ALLOWED_PLATFORMS.has(item)))] : [];
  if (!productName || !productDescription || platforms.length === 0) {
    return { error: 'Provide a product name, description, and at least one supported platform.' };
  }
  if (productName.length > 200 || productDescription.length > MAX_TEXT_LENGTH || tone.length > 120) {
    return { error: 'One or more text fields exceed the allowed length.' };
  }
  return { productName, productDescription, tone, platforms };
}

function buildMessages(input) {
  return [
    {
      role: 'system',
      content: 'You create cautious, editable e-commerce content drafts. Use only the product facts supplied by the user. Do not invent certifications, prices, availability, performance claims, competitor facts, or policy compliance. Return JSON only with this shape: {"drafts":[{"platform":"string","title":"string","body":"string","reviewNotes":["string"]}]}. Give one draft per requested platform and include a review note for any missing fact.'
    },
    {
      role: 'user',
      content: JSON.stringify(input)
    }
  ];
}

function parseModelJson(content) {
  const text = typeof content === 'string' ? content.trim() : '';
  const unwrapped = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(unwrapped);
  if (!parsed || !Array.isArray(parsed.drafts)) throw new Error('Invalid model shape.');
  return {
    drafts: parsed.drafts.slice(0, 4).map((draft) => ({
      platform: typeof draft.platform === 'string' ? draft.platform.slice(0, 80) : 'Unknown platform',
      title: typeof draft.title === 'string' ? draft.title.slice(0, 240) : '',
      body: typeof draft.body === 'string' ? draft.body.slice(0, 6000) : '',
      reviewNotes: Array.isArray(draft.reviewNotes) ? draft.reviewNotes.filter((note) => typeof note === 'string').slice(0, 10).map((note) => note.slice(0, 400)) : []
    }))
  };
}

async function generate(input) {
  const current = config();
  if (!current.apiKey || current.apiKey === 'replace_with_your_own_key') {
    return { status: 503, error: { code: 'provider_not_configured', message: 'Set DEEPSEEK_API_KEY or AI_API_KEY before generating a draft.' } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), current.timeoutMs);
  try {
    const response = await fetch(`${current.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.apiKey}` },
      body: JSON.stringify({ model: current.model, messages: buildMessages(input), response_format: { type: 'json_object' }, temperature: 0.4 }),
      signal: controller.signal
    });
    if (!response.ok) {
      const status = [401, 402, 429].includes(response.status) ? response.status : 502;
      return { status, error: { code: 'provider_error', message: 'The model provider could not complete this request.' } };
    }
    const payload = await response.json().catch(() => null);
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    let data;
    try {
      data = parseModelJson(content);
    } catch {
      return { status: 502, error: { code: 'invalid_model_output', message: 'The model provider returned an unexpected format. Try again or use a different model.' } };
    }
    return { status: 200, body: { data, meta: { provider: current.provider, model: current.model } } };
  } catch (error) {
    const message = error && error.name === 'AbortError' ? 'The model provider timed out.' : 'The model provider could not be reached.';
    return { status: 502, error: { code: 'provider_unavailable', message } };
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const current = config();
    return sendJson(res, 200, { ok: true, configured: Boolean(current.apiKey && current.apiKey !== 'replace_with_your_own_key'), provider: current.provider, model: current.model });
  }
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    try {
      const input = validateInput(await readJson(req));
      if (input.error) return sendError(res, 400, 'validation', input.error);
      const result = await generate(input);
      return result.error ? sendError(res, result.status, result.error.code, result.error.message) : sendJson(res, result.status, result.body);
    } catch (error) {
      if (error.code === 'too_large') return sendError(res, 413, 'too_large', 'Request body is too large.');
      return sendError(res, 400, error.code || 'invalid_json', 'Request body must be valid JSON.');
    }
  }
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
});

server.listen(config().port, '127.0.0.1', () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : config().port;
  console.log(`Local demo listening on http://127.0.0.1:${boundPort}`);
});
