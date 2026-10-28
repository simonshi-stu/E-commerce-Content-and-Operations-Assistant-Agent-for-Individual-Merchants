'use strict';
/**
 * Cost estimation for provider calls (T2.5): integer micros with checked safe arithmetic only.
 * Prices must come from explicit frozen observations or an explicit scenario config (unit prices
 * in micros per 1,000,000 tokens + priceVersion + observedAt) — an unknown price is NEVER 0/free
 * and the observation time is never synthesized; an unknown price needs a finite scenario cap
 * (recorded as a placeholder) or the estimate is blocked.
 */
const { ValidationError } = require('../evidence.js');

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

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
function requireSafeNonNegativeInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a safe non-negative integer`);
  return value;
}
function requireSafePositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive safe integer`);
  return value;
}
/** Strict real-calendar instant parsing (no Date.parse normalization of e.g. Feb 30). */
function parseStrictInstant(text) {
  const match = INSTANT_RE.exec(String(text));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const ms = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  const tz = match[8];
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  let offsetMinutes = 0;
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const offsetHours = Number(tz.slice(1, 3));
    const offsetMins = Number(tz.slice(4, 6));
    if (offsetHours > 14 || offsetMins > 59 || (offsetHours === 14 && offsetMins > 0)) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
  return Number.isFinite(epoch) ? epoch : null;
}
function requireInstant(text, name) {
  const epoch = parseStrictInstant(text);
  if (epoch === null) fail(`${name} must be a strict ISO instant with an explicit timezone and a real calendar date (no normalization)`);
  return new Date(epoch).toISOString();
}
function checkedMul(a, b, name) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) fail(`${name}: unsupported numeric range`);
  const product = a * b;
  if (!Number.isSafeInteger(product)) fail(`${name}: computed product exceeds the supported exact safe-integer range (${a} x ${b}); refusing (no rounding)`);
  return product;
}
function checkedAdd(a, b, name) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) fail(`${name}: unsupported numeric range`);
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) fail(`${name}: computed total exceeds the supported exact safe-integer range; refusing (no rounding)`);
  return sum;
}
/** ceil(a * b / c) with exact safe-integer intermediates (conservative rounding upward only). */
function checkedMulDivCeil(a, b, c, name) {
  if (!Number.isSafeInteger(c) || c <= 0) fail(`${name}: divisor must be a positive safe integer`);
  const product = checkedMul(a, b, name);
  const quotient = Math.floor(product / c);
  return product % c === 0 ? quotient : quotient + 1;
}

/**
 * Estimate the bounded worst-case cost of a scenario.
 * unitPrices: {inputMicrosPerMillion, outputMicrosPerMillion, priceVersion, observedAt}
 * tokenBounds: {maxInputTokens, maxOutputTokens}; attempts; scenarioCapMicros (finite cap).
 */
function estimateScenarioCost(options = {}) {
  if (!isPlainObject(options)) fail('estimateScenarioCost options must be a plain object');
  const currency = requireNonEmptyString(options.currency, 'currency');
  const attempts = options.attempts === undefined ? 1 : requireSafePositiveInt(options.attempts, 'attempts');
  if (!isPlainObject(options.tokenBounds)) fail('tokenBounds must be a plain object');
  const maxInputTokens = requireSafeNonNegativeInt(options.tokenBounds.maxInputTokens, 'tokenBounds.maxInputTokens');
  const maxOutputTokens = requireSafeNonNegativeInt(options.tokenBounds.maxOutputTokens, 'tokenBounds.maxOutputTokens');
  const cap = options.scenarioCapMicros === undefined || options.scenarioCapMicros === null
    ? null
    : requireSafeNonNegativeInt(options.scenarioCapMicros, 'scenarioCapMicros');
  if (options.unitPrices === undefined || options.unitPrices === null) {
    if (cap === null) {
      return {
        status: 'blocked',
        reason: 'unknown_unit_price',
        currency,
        estimateMicros: null,
        suggest: 'provide explicit frozen unit prices or a finite scenario cap; an unknown price is never 0/free and no observation time is synthesized'
      };
    }
    return {
      status: 'estimated',
      placeholder: true,
      estimateMicros: cap,
      currency,
      priceVersion: null,
      observedAt: null,
      breakdown: null,
      note: 'placeholder scenario cap only; not a real price, no observation time synthesized'
    };
  }
  const unitPrices = options.unitPrices;
  if (!isPlainObject(unitPrices)) fail('unitPrices must be a plain object');
  const inputMicrosPerMillion = requireSafeNonNegativeInt(unitPrices.inputMicrosPerMillion, 'unitPrices.inputMicrosPerMillion');
  const outputMicrosPerMillion = requireSafeNonNegativeInt(unitPrices.outputMicrosPerMillion, 'unitPrices.outputMicrosPerMillion');
  const priceVersion = requireNonEmptyString(unitPrices.priceVersion, 'unitPrices.priceVersion');
  const observedAt = requireInstant(unitPrices.observedAt, 'unitPrices.observedAt');
  const inputCost = checkedMulDivCeil(maxInputTokens, inputMicrosPerMillion, 1000000, 'input cost');
  const outputCost = checkedMulDivCeil(maxOutputTokens, outputMicrosPerMillion, 1000000, 'output cost');
  const perAttempt = checkedAdd(inputCost, outputCost, 'per-attempt cost');
  const total = checkedMul(perAttempt, attempts, 'scenario cost');
  if (cap !== null && total > cap) {
    return {
      status: 'blocked',
      reason: 'exceeds_scenario_cap',
      currency,
      estimateMicros: total,
      capMicros: cap,
      suggest: 'the bounded worst case exceeds the approved scenario cap; reduce bounds or obtain a new approved cap'
    };
  }
  return {
    status: 'estimated',
    placeholder: false,
    estimateMicros: total,
    currency,
    priceVersion,
    observedAt,
    breakdown: { inputMicrosPerAttempt: inputCost, outputMicrosPerAttempt: outputCost, attempts },
    note: 'bounded worst-case estimate from explicit frozen unit prices; not a charge'
  };
}

module.exports = {
  estimateScenarioCost,
  checkedAdd,
  checkedMul,
  checkedMulDivCeil,
  requireInstant
};
