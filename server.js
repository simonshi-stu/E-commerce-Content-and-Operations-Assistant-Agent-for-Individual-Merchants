'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { loadConfig } = require('./lib/env');
const { MAX_BODY_BYTES, validateInput } = require('./lib/validate');
const { generateContent } = require('./lib/provider');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
});

server.listen(loadConfig(ROOT).port, '127.0.0.1', () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : loadConfig(ROOT).port;
  console.log(`Local demo listening on http://127.0.0.1:${boundPort}`);
});
