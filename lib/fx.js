'use strict';

const DEFAULT_PRIMARY_URL = 'https://open.er-api.com/v6/latest';
const DEFAULT_FALLBACK_URL = 'https://api.frankfurter.app/latest';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeCurrency(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : '';
}

function parseRates(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rates = payload.rates;
  if (!rates || typeof rates !== 'object') return null;
  const base = normalizeCurrency(payload.base_code || payload.base);
  const cleaned = {};
  for (const [code, value] of Object.entries(rates)) {
    const normalized = normalizeCurrency(code);
    const rate = typeof value === 'number' ? value : Number.parseFloat(value);
    if (normalized && Number.isFinite(rate) && rate > 0) cleaned[normalized] = rate;
  }
  if (!base || Object.keys(cleaned).length === 0) return null;
  cleaned[base] = 1;
  return {
    base,
    rates: cleaned,
    updatedAt: payload.time_last_update_utc || payload.date || new Date().toISOString()
  };
}

function createFxService(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const primaryUrl = options.primaryUrl || process.env.FX_BASE_URL || DEFAULT_PRIMARY_URL;
  const fallbackUrl = options.fallbackUrl || process.env.FX_FALLBACK_URL || DEFAULT_FALLBACK_URL;
  const timeoutMs = options.timeoutMs || Number.parseInt(process.env.FX_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs || Number.parseInt(process.env.FX_CACHE_TTL_MS, 10) || DEFAULT_TTL_MS;
  const now = options.now || (() => Date.now());
  const cache = new Map();

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      return await response.json().catch(() => null);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getRates(baseInput = 'USD') {
    const base = normalizeCurrency(baseInput) || 'USD';
    const cached = cache.get(base);
    if (cached && now() - cached.fetchedAt < ttlMs) return { ...cached.data, cached: true };

    let parsed = parseRates(await fetchJson(`${primaryUrl.replace(/\/+$/, '')}/${base}`));
    if (parsed) parsed.source = 'open.er-api.com';
    if (!parsed) {
      parsed = parseRates(await fetchJson(`${fallbackUrl.replace(/\/+$/, '')}?from=${base}`));
      if (parsed) parsed.source = 'frankfurter.app';
    }
    if (!parsed) return null;

    const data = {
      ...parsed,
      fetchedAt: new Date(now()).toISOString(),
      cached: false
    };
    cache.set(base, { data, fetchedAt: now() });
    return data;
  }

  return { getRates };
}

module.exports = {
  DEFAULT_FALLBACK_URL,
  DEFAULT_PRIMARY_URL,
  createFxService,
  normalizeCurrency,
  parseRates
};
