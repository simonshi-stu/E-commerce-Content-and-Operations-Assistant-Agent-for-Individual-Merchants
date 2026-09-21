'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PORT = 5178;
const PLACEHOLDER_KEY = 'replace_with_your_own_key';

function readEnvFile(root, fileName) {
  const envPath = path.join(root, fileName);
  if (!fs.existsSync(envPath)) return Object.freeze({});
  const values = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return Object.freeze(values);
}

function resolveConfigValue(sources, primaryName, legacyName, fallback = '') {
  for (const source of sources) {
    if (source[primaryName] !== undefined) return source[primaryName];
    if (legacyName && source[legacyName] !== undefined) return source[legacyName];
  }
  return fallback;
}

function parsePort(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

function parseTimeout(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 300_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

function loadConfig(root) {
  const sources = [
    Object.freeze({ ...process.env }),
    readEnvFile(root, '.env.deepseek.local'),
    readEnvFile(root, '.env')
  ];
  const apiKey = resolveConfigValue(sources, 'DEEPSEEK_API_KEY', 'AI_API_KEY');
  return {
    provider: resolveConfigValue(sources, 'DEEPSEEK_PROVIDER', 'AI_PROVIDER', 'deepseek'),
    apiKey,
    hasApiKey: Boolean(apiKey) && apiKey !== PLACEHOLDER_KEY,
    model: resolveConfigValue(sources, 'DEEPSEEK_MODEL', 'AI_MODEL', 'deepseek-flash'),
    visionModel: resolveConfigValue(sources, 'DEEPSEEK_VISION_MODEL', 'AI_VISION_MODEL', ''),
    baseUrl: resolveConfigValue(sources, 'DEEPSEEK_BASE_URL', 'AI_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    timeoutMs: parseTimeout(resolveConfigValue(sources, 'DEEPSEEK_TIMEOUT_MS', 'AI_TIMEOUT_MS', '')),
    port: parsePort(resolveConfigValue(sources, 'DEEPSEEK_PORT', 'PORT', String(DEFAULT_PORT)))
  };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  PLACEHOLDER_KEY,
  loadConfig,
  parsePort,
  parseTimeout,
  readEnvFile,
  resolveConfigValue
};
