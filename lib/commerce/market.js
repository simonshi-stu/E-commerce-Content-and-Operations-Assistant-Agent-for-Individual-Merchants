'use strict';
/**
 * T3.2 research → matching → explainable recommendation + deterministic per-configuration cost.
 *
 * The domain module works on approved public structures: T3.1 connector observations (real
 * adapter output), passport/pack-style product facts and the approved pricing/shipping public
 * functions. It never rewrites those modules, never invents missing facts, never converts
 * ratings/monthly-purchase labels into sales, and never fabricates reviews. Matching is exact
 * on configuration identity (family aliases do not prove the same configuration), price bands
 * only accept observed selected-variant PDP current prices with complete lineage, and the cost
 * scenario separates facts from explicit assumptions while reusing the old engines unchanged.
 * Exports are new, atomic files under a factory-trusted output root (never a payload path).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./packs.js');
const pricing = require('../pricing.js');
const shipping = require('../shipping.js');
const worker = require('./worker.js');

const MARKET_SCHEMA_VERSION = 1;
const MARKET_RULES_VERSION = '1.0.0';
const MATCH_CATEGORIES = Object.freeze(['exact', 'adjacent', 'mismatch', 'candidate', 'search_candidate']);
const REVIEW_CAPS = Object.freeze({ high: 3, low: 3 });
const SCORE_FACTORS = Object.freeze([
  Object.freeze({ id: 'config_confidence', weight: 30 }),
  Object.freeze({ id: 'evidence_completeness', weight: 25 }),
  Object.freeze({ id: 'price_position', weight: 25 }),
  Object.freeze({ id: 'review_coverage', weight: 10 }),
  Object.freeze({ id: 'cost_headroom', weight: 10 })
]);
const DEFAULT_RULES = Object.freeze({
  rulesVersion: MARKET_RULES_VERSION,
  targetCompetitors: 5,
  minCompetitors: 3,
  maxObservationAgeMs: 7 * 24 * 60 * 60 * 1000,
  reviewCaps: REVIEW_CAPS
});
const PRECISION = Object.freeze({
  money: 'USD/CNY amounts rounded to 2 decimals (old pricing round/roundMoney)',
  weightKg: 'weights rounded to 3 decimals; chargeable weight ceiled to 0.5kg below 20kg, else 1kg (old shipping ceilToStep)',
  rates: 'fee/rate percentages are 0-100 numbers, not fractions',
  fx: 'cross-currency requires an explicit dated rate object; no live FX lookup'
});
const MICRO_LEDGER_NOTE = '预算收费 microledger 不用于商业务盈利计算；本成本情景不代表真实利润。';
const RATING_INVALID = 'rating must be an integer 1-5';
/** Review identity includes the competitor ASIN: the same reviewId on another PDP is not the same review. */
const REVIEW_IDENTITY = (review) => `${String(review.asin || '')}|${String(review.reviewId || `${review.title || ''}|${review.date || ''}`)}`;

class MarketError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
function marketError(code, message, detail) { return new MarketError(code, message, detail); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw marketError('validation', `${label} must be a non-empty string`);
  return value.trim();
}
function finiteNonNegativeOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function finitePositiveOrNull(value) {
  const parsed = finiteNonNegativeOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
function sha256Hex(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function normalizeValue(value) { return String(value).trim().toLowerCase().replace(/\s+/g, ' '); }

// ---------- A. research input normalization & matching ----------

function normalizeConfig(config, label = 'config') {
  if (!isPlainObject(config)) throw marketError('validation', `${label} must be a plain object`);
  const configKey = requireNonEmptyString(config.configKey, `${label}.configKey`);
  const keyAttributes = isPlainObject(config.keyAttributes) ? config.keyAttributes : null;
  if (!keyAttributes || Object.keys(keyAttributes).length === 0) throw marketError('validation', `${label}.keyAttributes must declare the key configuration attributes`);
  const normalizedAttributes = {};
  for (const [key, value] of Object.entries(keyAttributes)) {
    normalizedAttributes[String(key).trim()] = String(value ?? '').trim();
  }
  return {
    configKey,
    label: String(config.label || configKey).trim(),
    keyAttributes: normalizedAttributes
  };
}

/** Validate the T3.1 adapter observation shape (the real contract, not arbitrary labels). */
function normalizeObservation(observation) {
  if (!isPlainObject(observation)) throw marketError('observation_invalid', 'observation must be a plain object');
  if (observation.kind !== 'market_observation' || observation.schemaVersion !== 1) throw marketError('observation_invalid', 'observation.kind/schemaVersion do not match the T3.1 adapter contract');
  const subject = observation.subject;
  const price = observation.price;
  const provenance = observation.provenance;
  if (!isPlainObject(subject) || !isPlainObject(price) || !isPlainObject(provenance)) throw marketError('observation_invalid', 'observation.subject/price/provenance are required');
  if (typeof subject.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(subject.asin)) throw marketError('observation_invalid', 'observation.subject.asin must be 10 uppercase alphanumerics');
  if (typeof subject.variantLabel !== 'string' || subject.variantLabel.trim() === '') throw marketError('observation_invalid', 'observation.subject.variantLabel is required');
  if (typeof provenance.sourceUrl !== 'string' || provenance.sourceUrl.trim() === '') throw marketError('observation_invalid', 'observation.provenance.sourceUrl is required');
  return observation;
}

function normalizeResearchEntry(entry, index) {
  const label = `competitors[${index}]`;
  if (!isPlainObject(entry) || !isPlainObject(entry.observation) || !isPlainObject(entry.research)) throw marketError('validation', `${label} must carry {observation, research}`);
  const observation = normalizeObservation(entry.observation);
  const familyKey = requireNonEmptyString(entry.research.familyKey, `${label}.research.familyKey`);
  const attributes = isPlainObject(entry.research.attributes) ? entry.research.attributes : {};
  const normalizedAttributes = {};
  for (const [key, value] of Object.entries(attributes)) normalizedAttributes[String(key).trim()] = String(value ?? '').trim();
  return { observation, research: { familyKey, attributes: normalizedAttributes } };
}

/**
 * Classify one competitor against the configuration. Exact requires the same (alias-resolved)
 * family AND every key attribute exactly equal AND a confirmed selected variant AND — for every
 * claimed key attribute — the value must be evidenced by a token of the observed selected PDP
 * variant label (research fields are claims, never proof: a Blue-selected page cannot be
 * relabeled Red by `research.attributes`). Adjacent is the same family with known differing key
 * attributes; mismatch is a different family; candidate is missing/unknown/unevidenced key
 * configuration — candidates never count as verified competitors.
 */
function matchCompetitor(config, entry, product, rules = DEFAULT_RULES) {
  const observation = entry.observation;
  const research = entry.research;
  const reasons = [];
  const evidence = { asin: observation.subject.asin, sourceUrl: observation.provenance.sourceUrl, observedAt: observation.provenance.observedAt || null, sourceId: observation.sourceId, mode: observation.mode, selectedVariantLabel: observation.subject.variantLabel };
  if (observation.use === 'search_candidates') {
    return { category: 'search_candidate', reasons: ['搜索观测仅产生候选，不作为 selected-variant 价格证据'], evidence };
  }
  const familyAliases = Array.isArray(product.familyAliases) ? product.familyAliases.map((alias) => normalizeValue(alias)) : [];
  const familyMatches = normalizeValue(research.familyKey) === normalizeValue(product.familyKey)
    || familyAliases.includes(normalizeValue(research.familyKey));
  if (!familyMatches) {
    reasons.push(`商品族不同：竞品族 ${research.familyKey} ≠ 本品族 ${product.familyKey}（别名只证明族，不证明配置）`);
    return { category: 'mismatch', reasons, evidence };
  }
  const variantTokens = String(observation.subject.variantLabel || '').split(/[,，]+/).map((token) => normalizeValue(token)).filter((token) => token !== '');
  const diffs = [];
  const unknown = [];
  const unevidenced = [];
  for (const [key, expected] of Object.entries(config.keyAttributes)) {
    const claimed = research.attributes[key];
    if (claimed === undefined || claimed === null || String(claimed).trim() === '') {
      unknown.push(key);
      continue;
    }
    if (normalizeValue(claimed) !== normalizeValue(expected)) {
      diffs.push(`${key}: 竞品 ${claimed} ≠ 本品 ${expected}`);
      continue;
    }
    // the claimed value must be evidenced by the observed selected PDP variant label
    if (!variantTokens.includes(normalizeValue(claimed))) {
      unevidenced.push(`${key}=${claimed}（所选 PDP 变体标签为 ${observation.subject.variantLabel}，无对应 token）`);
    }
  }
  if (unknown.length > 0) {
    reasons.push(`关键配置未知：${unknown.join('、')}（降 candidate，不计入已核验竞品）`);
    return { category: 'candidate', reasons, evidence };
  }
  if (unevidenced.length > 0) {
    reasons.push(`配置断言未被所选 PDP 变体证据支持：${unevidenced.join('；')}（research 是待证断言，不证明配置）`);
    return { category: 'candidate', reasons, evidence };
  }
  if (observation.subject.selectedVariant !== true) {
    reasons.push('竞品页所选变体未确认（subject.selectedVariant≠true），不能当同配置价');
    return { category: 'candidate', reasons, evidence };
  }
  if (diffs.length > 0) {
    reasons.push(`同族不同配置：${diffs.join('；')}`);
    return { category: 'adjacent', reasons, evidence };
  }
  reasons.push('同族且全部关键属性精确一致且被所选 PDP 变体 token 证据支持，变体选择已确认');
  return { category: 'exact', reasons, evidence };
}

/** Build per-configuration research cards (matching + price band + reviews + scoring). */
function buildResearchCards({ product, configs, competitors, reviews, rules = DEFAULT_RULES, clock = () => new Date().toISOString() }) {
  if (!isPlainObject(product)) throw marketError('validation', 'product must be a plain object');
  requireNonEmptyString(product.familyKey, 'product.familyKey');
  if (!Array.isArray(configs) || configs.length === 0) throw marketError('validation', 'configs must be a non-empty array');
  const normalizedConfigs = configs.map((config, index) => normalizeConfig(config, `configs[${index}]`));
  const entries = (Array.isArray(competitors) ? competitors : []).map((entry, index) => normalizeResearchEntry(entry, index));
  const cards = normalizedConfigs.map((config) => {
    const classified = entries.map((entry) => ({ entry, match: matchCompetitor(config, entry, product, rules) }));
    const exact = classified.filter((item) => item.match.category === 'exact');
    const adjacent = classified.filter((item) => item.match.category === 'adjacent');
    const mismatch = classified.filter((item) => item.match.category === 'mismatch');
    const candidates = classified.filter((item) => item.match.category === 'candidate');
    const searchCandidates = classified.filter((item) => item.match.category === 'search_candidate');
    const selected = exact.slice(0, rules.targetCompetitors);
    const insufficient = selected.length < rules.minCompetitors;
    return {
      config,
      classified,
      selected,
      counts: { exact: selected.length, adjacent: adjacent.length, mismatch: mismatch.length, candidate: candidates.length, searchCandidate: searchCandidates.length },
      insufficient,
      note: insufficient
        ? `真正可比（exact）竞品仅 ${selected.length} 个，少于目标下限 ${rules.minCompetitors}；不足不凑，保留实际数量。`
        : `exact 竞品 ${selected.length} 个（目标 ≤${rules.targetCompetitors}）。`
    };
  });
  return { cards, rules, clock };
}

// ---------- B. review samples (embedded in cards, never fabricated) ----------

function selectReviewSamples(reviews, rules = DEFAULT_RULES) {
  const list = Array.isArray(reviews) ? reviews : [];
  const seen = new Set();
  const high = [];
  const low = [];
  let duplicatesRemoved = 0;
  let skippedInvalid = 0;
  for (const review of list) {
    if (!isPlainObject(review) || !Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5 || typeof review.englishOriginal !== 'string' || review.englishOriginal.trim() === '') {
      skippedInvalid += 1;
      continue;
    }
    const identity = REVIEW_IDENTITY(review);
    if (seen.has(identity)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(identity);
    const translation = typeof review.chineseTranslation === 'string' && review.chineseTranslation.trim() !== '' ? review.chineseTranslation.trim() : null;
    const criticismProvided = review.criticism === true || (Array.isArray(review.tags) && review.tags.includes('criticism'));
    const sample = {
      reviewId: String(review.reviewId || identity),
      asin: String(review.asin || ''),
      rating: review.rating,
      title: String(review.title || ''),
      date: String(review.date || ''),
      url: String(review.url || ''),
      observedAt: String(review.observedAt || ''),
      selectedVariant: String(review.selectedVariant || ''),
      englishOriginal: review.englishOriginal.trim(),
      chineseTranslation: translation,
      translationStatus: translation === null ? 'missing' : 'provided',
      highStarCriticism: review.rating >= 4 && criticismProvided,
      classificationStatus: criticismProvided ? 'provided' : '未提供可核分类',
      sourceStatus: String(review.sourceStatus || '评论来源待核'),
      note: String(review.note || '')
    };
    if (review.rating >= 4) high.push(sample);
    else low.push(sample);
  }
  high.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.reviewId.localeCompare(b.reviewId));
  low.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.reviewId.localeCompare(b.reviewId));
  return {
    high: high.slice(0, rules.reviewCaps.high),
    low: low.slice(0, rules.reviewCaps.low),
    duplicatesRemoved,
    skippedInvalid,
    note: high.length === 0 && low.length === 0 ? '无已保存评论样本；不阻塞价格结论。' : `已保存评论样本：4-5★ ${high.length} 条、1-3★ ${low.length} 条（每卡上限 3+3）。`
  };
}

// ---------- C. deterministic explainable scoring ----------

function scoreResearchCard({ card, priceBand, costScenario, reviewSelection, rules = DEFAULT_RULES }) {
  const factors = [];
  const keyUnknown = Object.keys(card.config.keyAttributes).length === 0;
  let configValue = 0;
  let configReason = '';
  if (keyUnknown) { configReason = '关键配置未声明'; }
  else if (card.counts.exact > 0) { configValue = 100; configReason = `exact 竞品 ${card.counts.exact} 个，配置身份精确核对`; }
  else if (card.insufficient) { configValue = 60; configReason = '关键配置已知，但 exact 竞品不足'; }
  else { configValue = 60; configReason = '关键配置已知，尚无 exact 竞品'; }
  factors.push({ id: 'config_confidence', weight: 30, value: configValue, reason: configReason });

  const exactRows = card.selected;
  const complete = exactRows.filter((item) => item.entry.observation.provenance.observedAtKnown === true && item.entry.observation.price.observed === true).length;
  const evidenceValue = exactRows.length === 0 ? 0 : Math.round((complete / exactRows.length) * 100);
  factors.push({ id: 'evidence_completeness', weight: 25, value: evidenceValue, reason: exactRows.length === 0 ? '无 exact 竞品证据' : `${complete}/${exactRows.length} 个 exact 竞品具备时间+价格证据` });

  let priceValue = 0;
  let priceReason = '无成本或无市场带，无法定位';
  if (costScenario && costScenario.status !== 'invalid_input' && costScenario.breakEvenListPrice !== null && priceBand.sampleCount > 0) {
    const be = costScenario.breakEvenListPrice;
    if (be <= priceBand.min) { priceValue = 100; priceReason = '保本价不高于市场带下沿'; }
    else if (be <= priceBand.median) { priceValue = 80; priceReason = '保本价不高于市场中位'; }
    else if (be <= priceBand.max) { priceValue = 60; priceReason = '保本价位于市场带内（偏上）'; }
    else { priceValue = 20; priceReason = '保本价高于市场带上沿（现有成本下不建议进入）'; }
  } else if (costScenario && costScenario.status !== 'invalid_input' && costScenario.breakEvenListPrice !== null) {
    priceReason = '成本可算但市场带样本不足';
  } else if (priceBand.sampleCount > 0) {
    priceReason = '成本不完整，未硬算定位';
  }
  factors.push({ id: 'price_position', weight: 25, value: priceValue, reason: priceReason });

  const reviewCount = reviewSelection.high.length + reviewSelection.low.length;
  const reviewValue = Math.min(100, reviewCount * 20);
  factors.push({ id: 'review_coverage', weight: 10, value: reviewValue, reason: reviewCount === 0 ? '无已保存评论样本（不阻塞价格）' : `已保存样本 ${reviewCount} 条` });

  let headroomValue = 0;
  let headroomReason = '成本不完整，无利润空间结论';
  if (costScenario && costScenario.unitProfit && costScenario.unitProfit.marginRatePct !== null) {
    const margin = costScenario.unitProfit.marginRatePct;
    if (margin >= 15) { headroomValue = 100; headroomReason = `建议价单件利润率 ${margin}%`; }
    else if (margin >= 0) { headroomValue = 60; headroomReason = `建议价单件利润率 ${margin}%`; }
    else { headroomValue = 20; headroomReason = `建议价单件利润率 ${margin}%（亏损）`; }
  } else if (costScenario && costScenario.overMarketBand) {
    headroomReason = '目标利润价高于市场带上沿';
  }
  factors.push({ id: 'cost_headroom', weight: 10, value: headroomValue, reason: headroomReason });

  const total = Math.round(factors.reduce((sum, factor) => sum + (factor.weight * factor.value) / 100, 0) * 100) / 100;
  return {
    rulesVersion: rules.rulesVersion,
    total,
    factors,
    explanations: factors.map((factor) => `${factor.id}（权重 ${factor.weight}）：${factor.value}/100 — ${factor.reason}`),
    note: '同输入、同规则版本、同 clock 结果确定；这是可解释规则评分，不是客观成功概率，也不代表 LLM 解析字节确定。'
  };
}

// ---------- D. selected-variant price band ----------

function mapObservationToPriceRow(entry, { match, fx, rules = DEFAULT_RULES, clock = () => new Date().toISOString() }) {
  const observation = entry.observation;
  const excluded = (code, reason) => ({ included: false, excluded: { code, reason, asin: observation.subject.asin } });
  if (match.category !== 'exact') return excluded('not_exact', '非 exact 竞品不进现价带');
  if (observation.status !== 'observed' || observation.price.observed !== true || !Number.isSafeInteger(observation.price.amountMicros) || observation.price.amountMicros <= 0) {
    return excluded('price_not_observed', '所选变体现价未观测（candidate/冲突不混入）');
  }
  if (observation.subject.selectedVariant !== true) return excluded('variant_unconfirmed', '变体选择未确认');
  const provenance = observation.provenance;
  if (provenance.observedAtKnown !== true || !provenance.observedAt) return excluded('unknown_observation_time', '缺观察时间 unknown，不作现价证据');
  const observedMs = Date.parse(provenance.observedAt);
  if (!Number.isFinite(observedMs)) return excluded('unknown_observation_time', '观察时间不可解析');
  const nowMs = Date.parse(clock());
  if (Number.isFinite(nowMs) && nowMs - observedMs > rules.maxObservationAgeMs) return excluded('stale_observation', `观察时间超过 ${rules.maxObservationAgeMs}ms 窗口`);
  const url = String(provenance.sourceUrl || '');
  const linkedAsin = url.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
  if (!linkedAsin || linkedAsin !== observation.subject.asin) return excluded('url_asin_mismatch', 'URL 与 ASIN 不一致，不作现价证据');
  let currency = String(observation.price.currency || '').toUpperCase();
  let priceUsd = null;
  if (currency === 'USD') {
    priceUsd = observation.price.amountMicros / 1e6;
  } else {
    const amount = observation.price.amountMicros / 1e6;
    if (!fx || !isPlainObject(fx.rates) || !String(fx.date || '').trim()) return excluded('no_fx', `跨币种 ${currency} 无显式有日期汇率，不混入 USD 现价带`);
    const converted = pricing.convert(amount, currency, 'USD', fx.rates);
    if (converted === null || !Number.isFinite(converted) || converted <= 0) return excluded('no_fx', `汇率表缺少 ${currency}/USD，无法换算`);
    priceUsd = converted;
  }
  const mode = String(observation.mode || '');
  const row = {
    asin: observation.subject.asin,
    url,
    observedAt: provenance.observedAt,
    variantLabel: observation.subject.variantLabel,
    similarity: 'similar',
    matchConfirmed: true,
    price: Math.round(priceUsd * 100) / 100,
    currency: 'USD',
    originalCurrency: currency,
    originalAmountText: observation.price.amountText,
    sourceType: 'amazon_public_product',
    pageStatus: 'parsed',
    priceStatus: 'observed',
    lineage: {
      sourceId: observation.sourceId,
      sourceVersion: observation.sourceVersion,
      mode,
      capability: provenance.capability,
      synthetic: provenance.synthetic === true,
      fixtureLabel: provenance.fixtureLabel || '',
      cacheKey: observation.cacheKey || null,
      scopeHash: observation.scopeHash || null,
      reasons: Array.isArray(observation.reasons) ? observation.reasons.slice() : []
    }
  };
  if (mode === 'manual_evidence') {
    row.sourceType = 'user_screenshot';
    row.screenshotEvidence = provenance.fixtureLabel || 'manual-evidence';
  }
  return { included: true, row, excluded: null };
}

// ---------- E. deterministic per-configuration cost (reuses old engines unchanged) ----------

/** Versioned unit equivalence: piece-like units only; anything else needs an explicit piecesPerUnit. */
const UNIT_EQUIVALENTS = Object.freeze({ pc: 1, pcs: 1, piece: 1, pieces: 1, unit: 1, units: 1, ea: 1 });
function normalizePurchaseUnit(unit, piecesPerUnit) {
  const normalized = String(unit || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(UNIT_EQUIVALENTS, normalized)) {
    return { unit: 'pc', piecesPerUnit: 1, note: `件/只等价单位映射 v1（${normalized} → pc）` };
  }
  const pieces = finitePositiveOrNull(piecesPerUnit);
  if (pieces === null || normalized === '') return null;
  return { unit: normalized, piecesPerUnit: pieces, note: `显式件数转换：1 ${normalized} = ${pieces} 件（精度：6 位小数后取整）` };
}

/**
 * revision-03: limited key contract for lineage declarations. A declared lineage value is compared
 * structurally against the actual input the computation used (never a String(object) compare); the
 * declared fields must be known and equal after normalization, otherwise the scenario fails closed.
 */
const LINEAGE_FIELD_MAPS = Object.freeze({
  'purchase.fx': ['fxToUSD', 'fxDate', 'currency'],
  'fees.fx': ['fxToUSD', 'fxDate', 'currency'],
  'shipping.fx': ['fxToUSD', 'fxDate', 'currency'],
  'fees.currency': ['currency'],
  'shipping.rate': ['channel', 'postalZone', 'tier', 'currency', 'perKg', 'routeEligible', 'batteryCompatible', 'sourceLocation', 'magneticInspectionPerShipment', 'otherPerShipment', 'magneticFeeApplicable', 'confirmed', 'fxToUSD', 'fxDate'],
  'shipping.cartons': ['dimensionUnit', 'cartons', 'volumetricDivisor', 'divisorConfirmed', 'batteryType', 'batteryTypeConfirmed']
});
function canonicalLineageValue(value) {
  if (Array.isArray(value)) return value.map(canonicalLineageValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalLineageValue(value[key]);
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    return trimmed !== '' && Number.isFinite(numeric) ? numeric : trimmed;
  }
  return value;
}
function lineageValuesEqual(a, b) {
  return JSON.stringify(canonicalLineageValue(a)) === JSON.stringify(canonicalLineageValue(b));
}

function buildCostScenario({ configKey, purchase, fees, shipping: shippingInput, fx, assumptions, priceRows, rules = DEFAULT_RULES, clock = () => new Date().toISOString() }) {
  const invalidReasons = [];
  const unknowns = [];
  const facts = [];
  const assumptionList = [];
  requireNonEmptyString(configKey, 'costScenario.configKey');
  const purchaseRaw = isPlainObject(purchase) ? purchase : {};
  const feesRaw = isPlainObject(fees) ? fees : {};
  const shipRaw = isPlainObject(shippingInput) ? shippingInput : {};
  const amount = finitePositiveOrNull(purchaseRaw.amount);
  const currency = String(purchaseRaw.currency || '').trim().toUpperCase();
  if (amount === null) invalidReasons.push('采购单价必须是有限正数（未知/负数不 clamp）');
  if (!pricing.SUPPORTED_CURRENCIES.includes(currency)) invalidReasons.push(`采购币种 ${purchaseRaw.currency || '(缺失)'} 不在支持列表`);
  const unitInfo = normalizePurchaseUnit(purchaseRaw.unit, purchaseRaw.piecesPerUnit);
  if (unitInfo === null) invalidReasons.push(`采购单位 ${purchaseRaw.unit || '(缺失)'} 无显式可追溯件数转换（仅支持件/只等价单位或 piecesPerUnit 显式转换），不得按单件计算`);
  const purchaseVariant = String(purchaseRaw.variant || '').trim();
  if (purchaseVariant === '') invalidReasons.push('采购配置（purchase.variant）缺失，不得默认本配置');
  else if (normalizeValue(purchaseVariant) !== normalizeValue(configKey)) invalidReasons.push(`采购配置 ${purchaseVariant} ≠ 本配置 ${configKey}（严格绑定，不自动补配置）`);
  if (!String(purchaseRaw.incoterm || '').trim()) invalidReasons.push('采购条款（Incoterm）缺失');
  const fxToUsd = finitePositiveOrNull(purchaseRaw.fxToUSD);
  const fxDate = String(purchaseRaw.fxDate || '').trim();
  if (currency !== 'USD' && (fxToUsd === null || fxDate === '')) invalidReasons.push('跨币种采购必须提供显式有日期汇率（fxToUSD+fxDate）');
  // --- revision-02: fine-grained estimate classification ---
  // A field declared in `assumptions[]` (existing key contract) or carrying an estimate marker stays
  // an assumption even when `confirmed === true`; the confirmation status may be listed separately
  // (fees.confirmed) but one valid field is never both a fact and an assumption. Same values merge
  // deterministically (original value/source/currency/unit/date/scope preserved); declarations that
  // contradict the input value/currency/variant/FX are explicitly rejected, never ignored.
  const declaredByKey = new Map();
  for (const item of (Array.isArray(assumptions) ? assumptions : [])) {
    if (!isPlainObject(item) || !String(item.key || '').trim()) { invalidReasons.push('assumptions 条目必须含 key'); continue; }
    declaredByKey.set(String(item.key), item);
  }
  const consumedDeclKeys = new Set();
  const estimateMarker = (object) => isPlainObject(object) && (object.basis === 'estimate' || object.estimated === true);
  const declaredContradiction = (key, declared, checks) => {
    for (const [label, declaredValue, inputValue] of checks) {
      if (declaredValue === undefined || declaredValue === null || declaredValue === '') continue;
      if (inputValue === undefined || inputValue === null || inputValue === '') continue;
      const same = typeof declaredValue === 'number' && typeof inputValue === 'number'
        ? declaredValue === inputValue
        : normalizeValue(String(declaredValue)) === normalizeValue(String(inputValue));
      if (!same) invalidReasons.push(`assumptions[${key}] 的 ${label} ${declaredValue} 与输入 ${inputValue} 矛盾（明确拒绝，不忽略声明）`);
    }
  };
  const purchaseDecl = declaredByKey.get('purchase');
  const purchaseIsEstimate = estimateMarker(purchaseRaw) || Boolean(purchaseDecl);
  const feesIsEstimate = estimateMarker(feesRaw);
  const shipIsEstimate = estimateMarker(shipRaw);
  const rateRaw = isPlainObject(shipRaw.rate) ? shipRaw.rate : {};
  const rateIsEstimate = estimateMarker(rateRaw);
  if (purchaseDecl) {
    declaredContradiction('purchase', purchaseDecl, [
      ['金额', purchaseDecl.value, amount],
      ['币种', purchaseDecl.currency, currency],
      ['配置', purchaseDecl.variant !== undefined ? purchaseDecl.variant : purchaseDecl.configKey, purchaseVariant],
      ['汇率', purchaseDecl.fxToUSD, fxToUsd],
      ['汇率日期', purchaseDecl.fxDate, fxDate]
    ]);
  }
  const feesCurrency = String(feesRaw.currency || 'USD').trim().toUpperCase();
  let feesConversion = null;
  if (!pricing.SUPPORTED_CURRENCIES.includes(feesCurrency)) invalidReasons.push(`费用币种 ${feesRaw.currency} 不在支持列表`);
  else if (feesCurrency !== 'USD') {
    const feesFx = finitePositiveOrNull(feesRaw.fxToUSD);
    const feesFxDate = String(feesRaw.fxDate || '').trim();
    if (feesFx === null || feesFxDate === '') invalidReasons.push(`费用币种 ${feesCurrency} 必须提供显式有日期汇率（fxToUSD+fxDate），不得忽略币种按 USD 计算`);
    else feesConversion = { currency: feesCurrency, fxToUSD: feesFx, fxDate: feesFxDate };
  }
  const divisor = finitePositiveOrNull(shipRaw.volumetricDivisor);
  if (divisor === null) invalidReasons.push('体积重除数缺失或非正');
  if (shipRaw.divisorConfirmed !== true) unknowns.push('体积重除数未确认');
  const cartons = Array.isArray(shipRaw.cartons) ? shipRaw.cartons : [];
  if (cartons.length === 0) invalidReasons.push('外箱计费规格缺失（不得用净重代箱重）');
  for (const [index, carton] of cartons.entries()) {
    const count = finitePositiveOrNull(carton.cartonCount);
    const units = finitePositiveOrNull(carton.unitsPerCarton);
    if (count === null || !Number.isInteger(count) || units === null || !Number.isInteger(units)) invalidReasons.push(`箱 ${index + 1} 箱数/每箱件数必须为正整数`);
    if (finitePositiveOrNull(carton.grossKg) === null) invalidReasons.push(`箱 ${index + 1} 毛重必须为正数`);
    if (finitePositiveOrNull(carton.lengthCm) === null || finitePositiveOrNull(carton.widthCm) === null || finitePositiveOrNull(carton.heightCm) === null) invalidReasons.push(`箱 ${index + 1} 实际长宽高必须为正数`);
  }
  const feeKeys = ['inboundPerUnit', 'packagingPerUnit', 'fulfillmentPerUnit', 'referralRatePct', 'adPerUnit', 'adRatePct', 'returnPerUnit', 'returnRatePct', 'taxPerUnit', 'taxRatePct', 'otherPerUnit', 'discountRatePct', 'couponFixed', 'targetMarginPct'];
  const monetaryFeeKeys = ['inboundPerUnit', 'packagingPerUnit', 'fulfillmentPerUnit', 'adPerUnit', 'returnPerUnit', 'taxPerUnit', 'otherPerUnit', 'couponFixed'];
  const feeValues = {};
  for (const key of feeKeys) {
    const rawValue = finiteNonNegativeOrNull(feesRaw[key]);
    if (rawValue === null) { unknowns.push(`费用字段 ${key} 缺失（不默认 0，除非调用者显式假设）`); continue; }
    const isMonetary = monetaryFeeKeys.includes(key);
    const usdValue = isMonetary && feesConversion ? Math.round(rawValue * feesConversion.fxToUSD * 100) / 100 : rawValue;
    feeValues[key] = usdValue;
    const entryValue = isMonetary && feesConversion ? { amount: rawValue, currency: feesCurrency, usd: usdValue, conversion: feesConversion } : rawValue;
    const decl = declaredByKey.get(key);
    if (decl) {
      consumedDeclKeys.add(key);
      declaredContradiction(key, decl, [['值', decl.value, rawValue], ['币种', decl.currency, feesCurrency]]);
      assumptionList.push({
        key,
        value: decl.value !== undefined && decl.value !== null ? decl.value : entryValue,
        unit: decl.unit || null,
        currency: decl.currency || feesCurrency,
        basis: String(decl.basis || '显式假设声明（confirmed 不升级为实测事实）'),
        source: String(decl.source || feesRaw.source || ''),
        date: String(decl.date || feesRaw.date || ''),
        scope: String(decl.scope || '')
      });
      continue;
    }
    if (feesRaw.confirmed === true && !feesIsEstimate) {
      facts.push({ key, value: entryValue, source: feesRaw.source || 'fees.confirmed', date: String(feesRaw.date || '') });
    } else {
      assumptionList.push({ key, value: entryValue, basis: feesIsEstimate ? '费用为明确情景估算（confirmed 不升级为实测事实）' : '费用假设未确认', source: feesRaw.source || '', date: String(feesRaw.date || '') });
    }
  }
  if (feesRaw.confirmed === true && !feesIsEstimate && Object.keys(feeValues).length === feeKeys.length) {
    facts.push({ key: 'fees.confirmed', value: true, source: feesRaw.source || 'fees.confirmed', date: String(feesRaw.date || '') });
  } else {
    unknowns.push(feesIsEstimate ? '费用为估算（保持 assumption，不升级事实）' : '费用假设未整体确认（facts 不完整）');
  }
  // input lineage for manual recomputation: carton/rate/FX/fee sources are delivered as facts or
  // assumptions according to their confirmation status and estimate declarations (never silently dropped)
  const sinkLineage = (key, entry, factEligible) => {
    const decl = declaredByKey.get(key);
    if (decl) {
      consumedDeclKeys.add(key);
      // revision-03: a declared lineage value must structurally agree with the actual input the
      // computation used — explicit FX value/date/currency (or other known field) differences fail
      // closed; unknown/non-comparable structures fail closed too. Never String(object) compares,
      // never silently deleted or ignored declarations, never "compute 0.14 but deliver 999".
      const declaredValue = decl.value;
      if (declaredValue !== undefined && declaredValue !== null) {
        const allowed = LINEAGE_FIELD_MAPS[key];
        if (allowed && isPlainObject(entry.value) && isPlainObject(declaredValue)) {
          for (const field of Object.keys(declaredValue)) {
            if (!allowed.includes(field)) {
              invalidReasons.push(`assumptions[${key}] 字段 ${field} 不在本项允许的键映射（不可比较，fail-closed）`);
              continue;
            }
            if (!lineageValuesEqual(declaredValue[field], entry.value[field])) {
              invalidReasons.push(`assumptions[${key}] 的 ${field} ${JSON.stringify(canonicalLineageValue(declaredValue[field]))} 与实际输入 ${JSON.stringify(canonicalLineageValue(entry.value[field]))} 矛盾（明确拒绝，不忽略声明）`);
            }
          }
        } else if (allowed && !isPlainObject(entry.value) && !isPlainObject(declaredValue)) {
          if (!lineageValuesEqual(declaredValue, entry.value)) {
            invalidReasons.push(`assumptions[${key}] 的声明值 ${JSON.stringify(canonicalLineageValue(declaredValue))} 与实际输入 ${JSON.stringify(canonicalLineageValue(entry.value))} 矛盾（明确拒绝，不忽略声明）`);
          }
        } else {
          invalidReasons.push(`assumptions[${key}] 的声明值与实际血缘结构不可比较（fail-closed）`);
        }
      }
      if (decl.currency !== undefined && decl.currency !== null && String(decl.currency).trim() !== ''
        && isPlainObject(entry.value) && entry.value.currency !== undefined && entry.value.currency !== null
        && normalizeValue(String(decl.currency)) !== normalizeValue(String(entry.value.currency))) {
        invalidReasons.push(`assumptions[${key}] 的币种 ${decl.currency} 与实际输入 ${entry.value.currency} 矛盾（明确拒绝，不忽略声明）`);
      }
      assumptionList.push({
        key,
        value: declaredValue !== undefined && declaredValue !== null ? declaredValue : entry.value,
        unit: decl.unit || null,
        currency: decl.currency || null,
        basis: String(decl.basis || '显式假设声明（confirmed 不升级为实测事实）'),
        source: String(decl.source || entry.source || ''),
        date: String(decl.date || entry.date || ''),
        scope: String(decl.scope || '')
      });
      return;
    }
    if (factEligible) facts.push(entry);
    else assumptionList.push({ ...entry, basis: String(entry.basis || (shipIsEstimate || rateIsEstimate ? '显式估算（confirmed 不升级为实测事实）' : '未确认（保持假设）')) });
  };
  const shipConfirmed = shipRaw.confirmed === true;
  sinkLineage('shipping.cartons', {
    key: 'shipping.cartons',
    value: {
      dimensionUnit: 'cm',
      cartons: (Array.isArray(shipRaw.cartons) ? shipRaw.cartons : []).map((carton) => ({ cartonCount: carton.cartonCount, unitsPerCarton: carton.unitsPerCarton, grossKg: carton.grossKg, lengthCm: carton.lengthCm, widthCm: carton.widthCm, heightCm: carton.heightCm })),
      volumetricDivisor: shipRaw.volumetricDivisor,
      divisorConfirmed: shipRaw.divisorConfirmed === true,
      batteryType: shipRaw.batteryType || null,
      batteryTypeConfirmed: shipRaw.batteryTypeConfirmed === true
    },
    source: String(shipRaw.source || 'shipping input'),
    date: String(shipRaw.date || '')
  }, shipConfirmed && shipRaw.divisorConfirmed === true && !shipIsEstimate);
  sinkLineage('shipping.rate', {
    key: 'shipping.rate',
    value: {
      channel: rateRaw.channel || null,
      postalZone: rateRaw.postalZone || null,
      tier: rateRaw.tier || null,
      currency: rateRaw.currency || null,
      perKg: rateRaw.perKg ?? null,
      routeEligible: rateRaw.routeEligible === true,
      batteryCompatible: rateRaw.batteryCompatible === true,
      sourceLocation: rateRaw.sourceLocation || null,
      magneticInspectionPerShipment: rateRaw.magneticInspectionPerShipment ?? null,
      otherPerShipment: rateRaw.otherPerShipment ?? null,
      magneticFeeApplicable: rateRaw.magneticFeeApplicable || null,
      confirmed: rateRaw.confirmed === true,
      fxToUSD: rateRaw.fxToUSD ?? null,
      fxDate: rateRaw.fxDate || null
    },
    source: String(rateRaw.source || rateRaw.sourceLocation || 'rate input'),
    date: String(rateRaw.fxDate || '')
  }, shipConfirmed && rateRaw.confirmed === true && !shipIsEstimate && !rateIsEstimate);
  if (currency !== 'USD' && fxToUsd !== null && fxDate !== '') {
    sinkLineage('purchase.fx', { key: 'purchase.fx', value: { fxToUSD: fxToUsd, fxDate, currency }, source: String(purchaseRaw.fxSource || purchaseRaw.source || 'purchase fx'), date: fxDate }, purchaseRaw.confirmed === true && !purchaseIsEstimate);
  }
  if (feesConversion) {
    sinkLineage('fees.fx', { key: 'fees.fx', value: feesConversion, source: String(feesRaw.fxSource || feesRaw.source || 'fees fx'), date: feesConversion.fxDate }, feesRaw.confirmed === true && !feesIsEstimate);
  }
  if (rateRaw.fxToUSD !== undefined && rateRaw.fxToUSD !== null) {
    sinkLineage('shipping.fx', { key: 'shipping.fx', value: { fxToUSD: rateRaw.fxToUSD, fxDate: rateRaw.fxDate || null, currency: rateRaw.currency || null }, source: String(rateRaw.fxSource || rateRaw.sourceLocation || 'rate fx'), date: String(rateRaw.fxDate || '') }, shipConfirmed && rateRaw.confirmed === true && !shipIsEstimate && !rateIsEstimate);
  }
  sinkLineage('fees.currency', { key: 'fees.currency', value: { currency: feesCurrency, conversion: feesConversion }, source: String(feesRaw.source || 'fees input'), date: String(feesRaw.date || '') }, feesRaw.confirmed === true && !feesIsEstimate);
  if (amount !== null && currency && unitInfo !== null && String(purchaseRaw.incoterm || '').trim() && (currency === 'USD' || (fxToUsd !== null && fxDate !== '')) && purchaseVariant !== '') {
    const purchaseValue = {
      amount,
      currency,
      unit: unitInfo.unit,
      originalUnit: String(purchaseRaw.unit || ''),
      piecesPerUnit: unitInfo.piecesPerUnit,
      amountPerPiece: Math.round((amount / unitInfo.piecesPerUnit) * 1000000) / 1000000,
      incoterm: purchaseRaw.incoterm,
      variant: purchaseVariant,
      conversionNote: unitInfo.note
    };
    if (purchaseDecl) {
      consumedDeclKeys.add('purchase');
      assumptionList.push({
        key: 'purchase',
        value: purchaseDecl.value !== undefined && purchaseDecl.value !== null ? purchaseDecl.value : purchaseValue,
        unit: purchaseDecl.unit || null,
        currency: purchaseDecl.currency || currency,
        basis: String(purchaseDecl.basis || '显式假设声明（confirmed 不升级为实测事实）'),
        source: String(purchaseDecl.source || purchaseRaw.source || ''),
        date: String(purchaseDecl.date || purchaseRaw.observedAt || ''),
        scope: String(purchaseDecl.scope || '')
      });
      unknowns.push('采购成本为显式假设声明（保持 assumption）');
    } else if (purchaseRaw.confirmed === true && !purchaseIsEstimate) {
      facts.push({ key: 'purchase', value: purchaseValue, source: String(purchaseRaw.source || 'purchase.confirmed'), date: String(purchaseRaw.observedAt || '') });
    } else {
      assumptionList.push({ key: 'purchase', value: purchaseValue, basis: purchaseIsEstimate ? '用户确认估算，非实测（confirmed 不升级事实）' : '采购成本未确认（用户确认的估算仍是估算）', source: String(purchaseRaw.source || ''), date: String(purchaseRaw.observedAt || '') });
      unknowns.push(purchaseIsEstimate ? '采购成本为估算（保持 assumption）' : '采购成本未确认');
    }
  }
  // declarations that were not consumed by a participating field are still delivered as assumptions
  for (const item of declaredByKey.values()) {
    if (consumedDeclKeys.has(String(item.key))) continue;
    assumptionList.push({ key: String(item.key), value: item.value, unit: item.unit || null, currency: item.currency || null, basis: String(item.basis || '明确情景假设'), source: String(item.source || ''), date: String(item.date || ''), scope: String(item.scope || '') });
  }
  const base = {
    schemaVersion: MARKET_SCHEMA_VERSION,
    kind: 't3.2_cost_scenario',
    configKey,
    rulesVersion: rules.rulesVersion,
    generatedAt: clock(),
    facts,
    assumptions: assumptionList,
    unknowns: [...new Set(unknowns)],
    precision: PRECISION,
    microLedgerNote: MICRO_LEDGER_NOTE
  };
  if (invalidReasons.length > 0) {
    return { ...base, status: 'invalid_input', invalidReasons, market: null, airFreight: null, breakEvenListPrice: null, targetProfitListPrice: null, recommendedListPrice: null, unitProfit: null, overMarketBand: false, decision: '输入存在非法/缺失值：不硬算漂亮数字，请修正后重试。' };
  }
  const product = {
    model: configKey,
    modelConfirmed: true,
    batteryType: ['none', 'button_cell', 'rechargeable'].includes(shipRaw.batteryType) ? shipRaw.batteryType : 'none',
    batteryTypeConfirmed: shipRaw.batteryTypeConfirmed === true,
    cost: {
      confirmed: purchaseRaw.confirmed === true,
      amount: amount / unitInfo.piecesPerUnit,
      currency,
      unit: unitInfo.unit,
      incoterm: purchaseRaw.incoterm,
      variant: purchaseVariant,
      fxToUSD: currency === 'USD' ? 1 : fxToUsd,
      fxDate: currency === 'USD' ? '' : fxDate
    },
    fees: { confirmed: feesRaw.confirmed === true, ...feeValues },
    shipping: {
      ...shipRaw,
      rate: isPlainObject(shipRaw.rate) ? { ...shipRaw.rate } : shipRaw.rate
    }
  };
  const engine = pricing.calculateProductPricing(product, priceRows);
  const airFreight = shipping.calculateAirFreightScenario(product.shipping, { needsBatteryChannel: product.batteryType !== 'none' || product.batteryTypeConfirmed !== true });
  const engineFreight = engine.freightSensitivity && engine.freightSensitivity.conservative ? engine.freightSensitivity.conservative.result : null;
  const overMarketBand = engine.status === 'not_recommended' && (
    (engine.targetProfitListPrice !== null && engine.market && engine.market.max !== null && engine.targetProfitListPrice > engine.market.max)
    || (engine.breakEvenListPrice !== null && engine.market && engine.market.max !== null && engine.breakEvenListPrice > engine.market.max)
  );
  return {
    ...base,
    status: engine.status,
    invalidReasons: [],
    missing: Array.isArray(engine.missing) ? engine.missing : [],
    market: engine.market,
    engine: {
      status: engine.status,
      unitPurchaseCostUSD: engine.unitPurchaseCostUSD,
      fixedCost: engine.fixedCost,
      variableRatePct: engine.variableRatePct,
      freightPerUnitUSD: engineFreight ? engineFreight.freightPerUnitUSD : null,
      conservativeDivisor: engineFreight ? engineFreight.volumetricDivisor : null,
      formulas: engine.formulas || null
    },
    airFreight: {
      status: airFreight.status,
      totalBillableKg: airFreight.totalBillableKg,
      freightPerUnit: airFreight.freightPerUnit,
      freightPerUnitUSD: airFreight.freightPerUnitUSD,
      calculatedShipmentTier: airFreight.calculatedShipmentTier,
      cartons: airFreight.cartons,
      missing: airFreight.missing
    },
    breakEvenListPrice: engine.breakEvenListPrice,
    targetProfitListPrice: engine.targetProfitListPrice,
    recommendedListPrice: engine.recommendedListPrice,
    unitProfit: engine.profitAtRecommendation ? { listPrice: engine.profitAtRecommendation.listPrice, profit: engine.profitAtRecommendation.profit, marginRatePct: engine.profitAtRecommendation.marginRatePct } : null,
    overMarketBand,
    decision: engine.decision,
    formulas: engine.formulas
  };
}

function normalizeDomain(domain, label) {
  if (!isPlainObject(domain)) throw marketError('validation', `${label} must be a plain object`);
  const projectId = requireNonEmptyString(domain.projectId, `${label}.projectId`);
  const brand = domain.brand === null || domain.brand === undefined ? '' : domain.brand;
  if (typeof brand !== 'string') throw marketError('validation', `${label}.brand must be a string (empty = no brand; null is not a wildcard)`);
  const market = requireNonEmptyString(domain.market, `${label}.market`);
  return { projectId, brand, market };
}

/** Every nested observation must belong to the research authority domain (scope AND authority). */
function assertObservationDomain(observation, domain, index) {
  const scope = observation.scope;
  const authority = observation.authority;
  const brandOf = (value) => (value === null || value === undefined ? '' : value);
  if (!isPlainObject(scope) || !isPlainObject(authority)) {
    throw marketError('observation_domain_mismatch', `competitors[${index}] observation lacks scope/authority`, { asin: observation.subject.asin });
  }
  const expected = `${domain.projectId}/${domain.brand}/${domain.market}`;
  const scopeLabel = `${scope.projectId}/${brandOf(scope.brand)}/${scope.market}`;
  const authorityLabel = `${authority.projectId}/${brandOf(authority.brand)}/${authority.market}`;
  if (scope.projectId !== domain.projectId || brandOf(scope.brand) !== domain.brand || scope.market !== domain.market) {
    throw marketError('observation_domain_mismatch', `competitors[${index}] observation.scope ${scopeLabel} ≠ 研究域 ${expected}`, { asin: observation.subject.asin, field: 'scope' });
  }
  if (authority.projectId !== domain.projectId || brandOf(authority.brand) !== domain.brand || authority.market !== domain.market) {
    throw marketError('observation_domain_mismatch', `competitors[${index}] observation.authority ${authorityLabel} ≠ 研究域 ${expected}`, { asin: observation.subject.asin, field: 'authority' });
  }
  if (typeof scope.locale !== 'string' || scope.locale === '' || typeof scope.shipTo !== 'string' || scope.shipTo === '') {
    throw marketError('observation_domain_mismatch', `competitors[${index}] observation.scope lacks locale/shipTo`, { asin: observation.subject.asin, field: 'locale' });
  }
}

// ---------- F. pipeline ----------

function runResearchPipeline({ input, authorityDomain = null, rules = DEFAULT_RULES, clock = () => new Date().toISOString() }) {
  if (!isPlainObject(input)) throw marketError('validation', 'input must be a plain object');
  const product = input.product;
  requireNonEmptyString(product && product.familyKey, 'product.familyKey');
  // the authority domain is the runner context when provided, otherwise the declared research scope;
  // nested observation scope/authority must match it (foreign/missing/contradictory domains fail closed)
  const domain = authorityDomain !== null && authorityDomain !== undefined
    ? normalizeDomain(authorityDomain, 'authorityDomain')
    : normalizeDomain(input.scope, 'input.scope');
  for (const [index, entry] of (Array.isArray(input.competitors) ? input.competitors : []).entries()) {
    if (!isPlainObject(entry) || !isPlainObject(entry.observation)) throw marketError('validation', `competitors[${index}] must carry {observation, research}`);
    assertObservationDomain(normalizeObservation(entry.observation), domain, index);
  }
  const built = buildResearchCards({ product, configs: input.configs, competitors: input.competitors, reviews: input.reviews, rules, clock });
  const fx = isPlainObject(input.fx) ? input.fx : null;
  const costByConfig = new Map();
  for (const [index, scenario] of (Array.isArray(input.costScenarios) ? input.costScenarios : []).entries()) {
    if (!isPlainObject(scenario) || !String(scenario.configKey || '').trim()) throw marketError('validation', `costScenarios[${index}].configKey is required`);
    costByConfig.set(String(scenario.configKey), scenario);
  }
  const cards = built.cards.map((card) => {
    const priceRows = [];
    const excludedRows = [];
    for (const item of card.selected) {
      const mapped = mapObservationToPriceRow(item.entry, { match: item.match, fx, rules, clock });
      if (mapped.included) priceRows.push(mapped.row);
      else excludedRows.push(mapped.excluded);
    }
    const prices = priceRows.map((row) => row.price).sort((a, b) => a - b);
    const priceBand = prices.length === 0
      ? { sampleCount: 0, min: null, median: null, max: null, currency: 'USD' }
      : {
        sampleCount: prices.length,
        min: Math.round(prices[0] * 100) / 100,
        median: Math.round((prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) * 100) / 100,
        max: Math.round(prices[prices.length - 1] * 100) / 100,
        currency: 'USD'
      };
    const costInput = costByConfig.get(card.config.configKey) || null;
    const costScenario = costInput
      ? buildCostScenario({ configKey: card.config.configKey, purchase: costInput.purchase, fees: costInput.fees, shipping: costInput.shipping, fx: costInput.fx, assumptions: costInput.assumptions, priceRows, rules, clock })
      : null;
    const perCompetitorReviews = card.selected.map((item) => {
      const asin = item.entry.observation.subject.asin;
      const selection = selectReviewSamples(
        (Array.isArray(input.reviews) ? input.reviews : []).filter((review) => isPlainObject(review) && String(review.asin || '') === asin),
        rules
      );
      return { asin, high: selection.high, low: selection.low, duplicatesRemoved: selection.duplicatesRemoved, skippedInvalid: selection.skippedInvalid };
    });
    const cardReviews = {
      perCompetitor: perCompetitorReviews,
      high: perCompetitorReviews.flatMap((entry) => entry.high),
      low: perCompetitorReviews.flatMap((entry) => entry.low),
      duplicatesRemoved: perCompetitorReviews.reduce((sum, entry) => sum + entry.duplicatesRemoved, 0),
      skippedInvalid: perCompetitorReviews.reduce((sum, entry) => sum + entry.skippedInvalid, 0),
      note: perCompetitorReviews.every((entry) => entry.high.length === 0 && entry.low.length === 0)
        ? '无已保存评论样本；不阻塞价格结论。'
        : `逐竞品已保存评论样本（每竞品上限 3+3）：${perCompetitorReviews.map((entry) => `${entry.asin} ${entry.high.length}+${entry.low.length}`).join('；')}`
    };
    const score = scoreResearchCard({ card, priceBand, costScenario, reviewSelection: cardReviews, rules });
    return {
      configKey: card.config.configKey,
      label: card.config.label,
      keyAttributes: { ...card.config.keyAttributes },
      match: { ...card.counts, insufficient: card.insufficient, note: card.note },
      competitors: {
        exact: card.selected.map((item) => ({
          asin: item.entry.observation.subject.asin,
          category: item.match.category,
          reasons: item.match.reasons,
          price: (priceRows.find((row) => row.asin === item.entry.observation.subject.asin) || {}).price ?? null,
          currency: 'USD',
          amountText: item.entry.observation.price.amountText,
          variantLabel: item.entry.observation.subject.variantLabel,
          url: item.entry.observation.provenance.sourceUrl,
          observedAt: item.entry.observation.provenance.observedAt || null,
          lineage: (priceRows.find((row) => row.asin === item.entry.observation.subject.asin) || {}).lineage || null
        })),
        adjacent: card.classified.filter((item) => item.match.category === 'adjacent').map((item) => ({ asin: item.entry.observation.subject.asin, category: 'adjacent', reasons: item.match.reasons })),
        mismatch: card.classified.filter((item) => item.match.category === 'mismatch').map((item) => ({ asin: item.entry.observation.subject.asin, category: 'mismatch', reasons: item.match.reasons })),
        candidates: card.classified.filter((item) => item.match.category === 'candidate').map((item) => ({ asin: item.entry.observation.subject.asin, category: 'candidate', reasons: item.match.reasons })),
        searchCandidates: card.classified.filter((item) => item.match.category === 'search_candidate').map((item) => ({ asin: item.entry.observation.subject.asin, category: 'search_candidate', reasons: item.match.reasons }))
      },
      priceBand,
      priceRows,
      priceExcluded: excludedRows,
      reviews: cardReviews,
      score,
      cost: costScenario,
      evidenceComplete: card.selected.length > 0 && card.selected.every((item) => item.entry.observation.provenance.observedAtKnown === true && item.entry.observation.price.observed === true)
    };
  });
  const scenarios = cards.filter((card) => card.cost !== null).map((card) => card.cost);
  return {
    schemaVersion: MARKET_SCHEMA_VERSION,
    kind: 't3.2_research',
    rulesVersion: rules.rulesVersion,
    generatedAt: clock(),
    product: { familyKey: product.familyKey, familyAliases: Array.isArray(product.familyAliases) ? product.familyAliases.slice() : [], keyAttributes: Array.isArray(product.keyAttributes) ? product.keyAttributes.slice() : [], label: String(product.label || product.familyKey) },
    cards,
    costScenarios: scenarios,
    notes: [
      '搜索观测只产生候选，不作为 selected-variant 价格证据。',
      '评分是可解释规则评分（同输入同规则同 clock 确定），不是成功概率，也不代表 LLM 解析字节确定。',
      MICRO_LEDGER_NOTE
    ]
  };
}

// ---------- G. exports (new atomic files under a trusted output root) ----------

function sanitizeCellValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (isPlainObject(value) || Array.isArray(value)) return sanitizeCellValue(canonicalJson(value));
  const cleaned = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 2000);
  return /^[=+\-@]/.test(cleaned.trim()) ? `'${cleaned}` : cleaned;
}

function sheetRow(sheet, values) {
  sheet.addRow(values.map((value) => sanitizeCellValue(value)));
}

async function exportResearchRun({ outputRoot, runId, pipeline, meta = {} }) {
  if (typeof outputRoot !== 'string' || outputRoot.trim() === '') throw marketError('validation', 'outputRoot must be a configured trusted root');
  const safeRunId = worker.assertSafePathId(runId, 'runId');
  const dir = worker.resolveScoped(outputRoot, [safeRunId], 'T3.2 export run');
  fs.mkdirSync(dir, { recursive: true });
  const generatedAt = pipeline.generatedAt;
  const json = {
    schemaVersion: MARKET_SCHEMA_VERSION,
    kind: 't3.2_research_cost_export',
    runId: safeRunId,
    generatedAt,
    rulesVersion: pipeline.rulesVersion,
    product: pipeline.product,
    cards: pipeline.cards,
    costScenarios: pipeline.costScenarios,
    notes: pipeline.notes,
    meta: { ...meta }
  };
  const jsonText = `${JSON.stringify(json, null, 2)}\n`;
  const jsonPath = path.join(dir, 'research-cost.json');
  const xlsxPath = path.join(dir, 'research-cost.xlsx');
  // immutability: check BOTH targets before writing anything; an existing run directory may only be
  // reused for byte-identical content — otherwise the caller must use a new run id
  const existingJson = fs.existsSync(jsonPath);
  const existingXlsx = fs.existsSync(xlsxPath);
  if (existingJson || existingXlsx) {
    if (!(existingJson && existingXlsx)) {
      throw marketError('export_conflict', 'the run directory has a partial previous export; refusing to mix versions', { runId: safeRunId });
    }
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { existing = null; }
    if (!existing || canonicalJson(existing) !== canonicalJson(json)) {
      throw marketError('export_conflict', 'this run directory already holds different research-cost artifacts; use a new run id (existing bytes/hashes are left untouched)', { runId: safeRunId });
    }
    return {
      dir,
      jsonPath,
      xlsxPath,
      jsonSha256: sha256Hex(fs.readFileSync(jsonPath)),
      xlsxSha256: sha256Hex(fs.readFileSync(xlsxPath)),
      generatedAt,
      runId: safeRunId,
      reused: true
    };
  }
  const jsonTmp = `${jsonPath}.tmp-${Date.now()}`;
  fs.writeFileSync(jsonTmp, jsonText, 'utf8');
  JSON.parse(fs.readFileSync(jsonTmp, 'utf8'));
  fs.renameSync(jsonTmp, jsonPath);
  const jsonSha256 = sha256Hex(fs.readFileSync(jsonPath));

  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'T3.2 market module (fixture_passed)';
  const research = workbook.addWorksheet('研究卡');
  for (const card of pipeline.cards) {
    sheetRow(research, [`[卡] ${card.configKey} — ${card.label}`]);
    sheetRow(research, ['身份', canonicalJson(card.keyAttributes)]);
    sheetRow(research, ['评分', card.score.total, card.score.rulesVersion, card.score.note]);
    for (const factor of card.score.factors) sheetRow(research, ['评分因子', factor.id, factor.weight, factor.value, factor.reason]);
    sheetRow(research, ['匹配', `exact ${card.match.exact} / adjacent ${card.match.adjacent} / mismatch ${card.match.mismatch} / candidate ${card.match.candidate}`, card.match.note]);
    for (const item of card.competitors.exact) sheetRow(research, ['竞品(exact)', item.asin, item.price, item.currency, item.amountText, item.variantLabel, item.observedAt, item.url]);
    for (const item of card.competitors.adjacent) sheetRow(research, ['竞品(adjacent)', item.asin, item.reasons.join('；')]);
    for (const item of card.competitors.mismatch) sheetRow(research, ['竞品(mismatch)', item.asin, item.reasons.join('；')]);
    for (const item of card.competitors.candidates) sheetRow(research, ['竞品(candidate)', item.asin, item.reasons.join('；')]);
    sheetRow(research, ['价格带', card.priceBand.sampleCount, card.priceBand.min, card.priceBand.median, card.priceBand.max, card.priceBand.currency]);
    for (const excluded of card.priceExcluded) sheetRow(research, ['价格排除', excluded.asin, excluded.code, excluded.reason]);
    if (card.reviews.high.length === 0 && card.reviews.low.length === 0) {
      sheetRow(research, ['评论', '（无已保存评论样本；不阻塞价格结论）']);
    } else {
      for (const sample of card.reviews.high) sheetRow(research, ['评论(4-5★)', sample.rating, sample.date, sample.title, sample.englishOriginal, sample.chineseTranslation === null ? '译文缺失' : sample.chineseTranslation, sample.highStarCriticism ? '高星批评' : sample.classificationStatus, sample.url, sample.asin, sample.selectedVariant]);
      for (const sample of card.reviews.low) sheetRow(research, ['评论(1-3★)', sample.rating, sample.date, sample.title, sample.englishOriginal, sample.chineseTranslation === null ? '译文缺失' : sample.chineseTranslation, sample.highStarCriticism ? '高星批评' : sample.classificationStatus, sample.url, sample.asin, sample.selectedVariant]);
    }
  }
  const cost = workbook.addWorksheet('逐配置成本');
  for (const scenario of pipeline.costScenarios) {
    sheetRow(cost, [`[配置] ${scenario.configKey} — ${scenario.status}`]);
    sheetRow(cost, ['市场带', scenario.market ? `${scenario.market.min}–${scenario.market.max} USD（样本 ${scenario.market.sampleCount}）` : '无']);
    sheetRow(cost, ['保本价', scenario.breakEvenListPrice, '目标利润价', scenario.targetProfitListPrice, '建议价', scenario.recommendedListPrice]);
    sheetRow(cost, ['单件利润', scenario.unitProfit ? scenario.unitProfit.profit : null, '利润率%', scenario.unitProfit ? scenario.unitProfit.marginRatePct : null, '超价带', scenario.overMarketBand]);
    sheetRow(cost, ['结论', scenario.decision]);
    for (const fact of scenario.facts) sheetRow(cost, ['事实', fact.key, canonicalJson(fact.value), fact.source, fact.date]);
    for (const assumption of scenario.assumptions) sheetRow(cost, ['假设', assumption.key, canonicalJson(assumption.value), assumption.basis, assumption.source, assumption.date, assumption.scope || '']);
    for (const unknown of scenario.unknowns) sheetRow(cost, ['未知/缺失', unknown]);
    sheetRow(cost, ['空运', scenario.airFreight ? `${scenario.airFreight.status} / 计费重 ${scenario.airFreight.totalBillableKg}kg / 单件 ${scenario.airFreight.freightPerUnitUSD} USD` : '无']);
    sheetRow(cost, ['精度', PRECISION.money, PRECISION.weightKg, PRECISION.fx]);
    sheetRow(cost, ['预算口径', MICRO_LEDGER_NOTE]);
  }
  const xlsxTmp = `${xlsxPath}.tmp-${Date.now()}`;
  const buffer = await workbook.xlsx.writeBuffer();
  fs.writeFileSync(xlsxTmp, Buffer.from(buffer));
  fs.renameSync(xlsxTmp, xlsxPath);
  const xlsxSha256 = sha256Hex(fs.readFileSync(xlsxPath));
  return { dir, jsonPath, xlsxPath, jsonSha256, xlsxSha256, generatedAt, runId: safeRunId, reused: false };
}

/** Reopen the exported workbook and read the card/review/cost blocks back field by field. */
async function readBackResearchWorkbook(xlsxPath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  const rowsOf = (sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      for (let index = 1; index <= row.cellCount; index += 1) {
        const value = row.getCell(index).value;
        values.push(value && typeof value === 'object' && value.text !== undefined ? value.text : value);
      }
      rows.push(values);
    });
    return rows;
  };
  const research = workbook.getWorksheet('研究卡');
  const cost = workbook.getWorksheet('逐配置成本');
  const cards = [];
  let current = null;
  for (const row of rowsOf(research)) {
    if (typeof row[0] === 'string' && row[0].startsWith('[卡] ')) {
      const label = row[0].slice(4);
      const [configKey, ...rest] = label.split(' — ');
      current = { configKey, label: rest.join(' — '), reviews: { high: [], low: [] }, factors: [], competitors: [], priceBand: null };
      cards.push(current);
      continue;
    }
    if (!current) continue;
    if (row[0] === '评论(4-5★)' || row[0] === '评论(1-3★)') {
      const sample = { rating: row[1], date: row[2], title: row[3], englishOriginal: row[4], chineseTranslation: row[5], flag: row[6], url: row[7], asin: row[8], selectedVariant: row[9] };
      if (row[0] === '评论(4-5★)') current.reviews.high.push(sample);
      else current.reviews.low.push(sample);
    } else if (row[0] === '评分因子') {
      current.factors.push({ id: row[1], weight: row[2], value: row[3], reason: row[4] });
    } else if (row[0] === '竞品(exact)') {
      current.competitors.push({ asin: row[1], price: row[2], currency: row[3], amountText: row[4], variantLabel: row[5], observedAt: row[6], url: row[7] });
    } else if (row[0] === '价格带') {
      current.priceBand = { sampleCount: row[1], min: row[2], median: row[3], max: row[4], currency: row[5] };
    }
  }
  const costRows = rowsOf(cost);
  return { sheetNames, cards, costRows };
}

// ---------- H. registered handler (approved registry/orchestrator) ----------

const MARKET_TOOL_NAME = 'commerce.market.research';
const MARKET_TOOL_VERSION = '1.0.0';
const MARKET_ROLE = 'research-selection';

function createMarketRegistration({ domain }) {
  if (!isPlainObject(domain) || typeof domain.outputRoot !== 'string' || domain.outputRoot.trim() === '') {
    throw marketError('validation', 'domain.outputRoot (trusted factory config) is required');
  }
  const outputRoot = path.resolve(domain.outputRoot);
  const tool = {
    name: MARKET_TOOL_NAME,
    version: MARKET_TOOL_VERSION,
    roles: [MARKET_ROLE],
    kind: 'local',
    inputSchema: {
      type: 'object',
      required: ['product', 'configs', 'competitors', 'reviews', 'costScenarios', 'scope'],
      additionalProperties: false,
      properties: {
        product: {
          type: 'object',
          required: ['familyKey', 'keyAttributes', 'label'],
          additionalProperties: false,
          properties: {
            familyKey: { type: 'string', minLength: 1, maxLength: 80 },
            familyAliases: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1 } },
            keyAttributes: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1 } },
            label: { type: 'string', minLength: 1, maxLength: 120 }
          }
        },
        configs: {
          type: 'array', maxItems: 8,
          items: {
            type: 'object',
            required: ['configKey', 'label', 'keyAttributes'],
            additionalProperties: false,
            properties: {
              configKey: { type: 'string', minLength: 1, maxLength: 60 },
              label: { type: 'string', minLength: 1, maxLength: 120 },
              keyAttributes: { type: 'object', properties: {}, additionalProperties: true }
            }
          }
        },
        competitors: {
          type: 'array', maxItems: 40,
          items: {
            type: 'object',
            required: ['observation', 'research'],
            additionalProperties: false,
            properties: {
              observation: { type: 'object', properties: {}, additionalProperties: true },
              research: {
                type: 'object',
                required: ['familyKey', 'attributes'],
                additionalProperties: false,
                properties: {
                  familyKey: { type: 'string', minLength: 1, maxLength: 80 },
                  attributes: { type: 'object', properties: {}, additionalProperties: true }
                }
              }
            }
          }
        },
        reviews: {
          type: 'array', maxItems: 60,
          items: {
            type: 'object',
            required: ['asin', 'rating', 'englishOriginal'],
            additionalProperties: false,
            properties: {
              asin: { type: 'string', pattern: '^[A-Z0-9]{10}$' },
              reviewId: { type: 'string', maxLength: 120 },
              rating: { type: 'integer', minimum: 1, maximum: 5 },
              title: { type: 'string', maxLength: 300 },
              date: { type: 'string', maxLength: 40 },
              url: { type: 'string', maxLength: 500 },
              observedAt: { type: 'string', maxLength: 40 },
              selectedVariant: { type: 'string', maxLength: 120 },
              englishOriginal: { type: 'string', minLength: 1, maxLength: 4000 },
              chineseTranslation: { type: 'string', maxLength: 4000 },
              criticism: { type: 'boolean' },
              tags: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1 } },
              sourceStatus: { type: 'string', maxLength: 120 },
              note: { type: 'string', maxLength: 300 }
            }
          }
        },
        fx: {
          type: 'object',
          required: ['rates', 'date'],
          additionalProperties: false,
          properties: {
            rates: { type: 'object', properties: {}, additionalProperties: true },
            date: { type: 'string', minLength: 1, maxLength: 40 }
          }
        },
        costScenarios: {
          type: 'array', maxItems: 8,
          items: {
            type: 'object',
            required: ['configKey'],
            additionalProperties: false,
            properties: {
              configKey: { type: 'string', minLength: 1, maxLength: 60 },
              purchase: { type: 'object', properties: {}, additionalProperties: true },
              fees: { type: 'object', properties: {}, additionalProperties: true },
              shipping: { type: 'object', properties: {}, additionalProperties: true },
              fx: { type: 'object', properties: {}, additionalProperties: true },
              assumptions: { type: 'array', maxItems: 30, items: { type: 'object', properties: {}, additionalProperties: true } }
            }
          }
        },
        scope: {
          type: 'object',
          required: ['projectId', 'brand', 'market'],
          additionalProperties: false,
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 120 },
            brand: { type: 'string', maxLength: 120 },
            market: { type: 'string', minLength: 1, maxLength: 40 }
          }
        }
      }
    },
    outputSchema: {
      type: 'object',
      required: ['research', 'cost', 'exports'],
      additionalProperties: false,
      properties: {
        research: {
          type: 'object',
          required: ['rulesVersion', 'cards'],
          additionalProperties: false,
          properties: {
            rulesVersion: { type: 'string', minLength: 1 },
            cards: {
              type: 'array', maxItems: 8,
              items: {
                type: 'object',
                required: ['configKey', 'label', 'scoreTotal', 'exactCount', 'adjacentCount', 'mismatchCount', 'candidateCount', 'insufficient', 'priceBand', 'reviewCounts', 'evidenceComplete'],
                additionalProperties: false,
                properties: {
                  configKey: { type: 'string', minLength: 1 },
                  label: { type: 'string', minLength: 1 },
                  scoreTotal: { type: 'number', minimum: 0, maximum: 100 },
                  exactCount: { type: 'integer', minimum: 0 },
                  adjacentCount: { type: 'integer', minimum: 0 },
                  mismatchCount: { type: 'integer', minimum: 0 },
                  candidateCount: { type: 'integer', minimum: 0 },
                  insufficient: { type: 'boolean' },
                  priceBand: {
                    type: 'object',
                    required: ['sampleCount', 'currency'],
                    additionalProperties: false,
                    properties: {
                      sampleCount: { type: 'integer', minimum: 0 },
                      min: { type: 'number' },
                      median: { type: 'number' },
                      max: { type: 'number' },
                      currency: { type: 'string' }
                    }
                  },
                  reviewCounts: {
                    type: 'object',
                    required: ['high', 'low'],
                    additionalProperties: false,
                    properties: { high: { type: 'integer', minimum: 0 }, low: { type: 'integer', minimum: 0 } }
                  },
                  evidenceComplete: { type: 'boolean' }
                }
              }
            }
          }
        },
        cost: {
          type: 'object',
          required: ['scenarios'],
          additionalProperties: false,
          properties: {
            scenarios: {
              type: 'array', maxItems: 8,
              items: {
                type: 'object',
                required: ['configKey', 'status', 'overMarketBand', 'decision', 'missingCount'],
                additionalProperties: false,
                properties: {
                  configKey: { type: 'string', minLength: 1 },
                  status: { type: 'string', minLength: 1 },
                  breakEvenListPrice: { type: 'number' },
                  targetProfitListPrice: { type: 'number' },
                  recommendedListPrice: { type: 'number' },
                  unitProfit: {
                    type: 'object',
                    required: ['listPrice', 'profit'],
                    additionalProperties: false,
                    properties: { listPrice: { type: 'number' }, profit: { type: 'number' }, marginRatePct: { type: 'number' } }
                  },
                  overMarketBand: { type: 'boolean' },
                  decision: { type: 'string', minLength: 1 },
                  missingCount: { type: 'integer', minimum: 0 }
                }
              }
            }
          }
        },
        exports: {
          type: 'object',
          required: ['jsonPath', 'xlsxPath', 'jsonSha256', 'xlsxSha256'],
          additionalProperties: false,
          properties: {
            jsonPath: { type: 'string', minLength: 1 },
            xlsxPath: { type: 'string', minLength: 1 },
            jsonSha256: { type: 'string', minLength: 64, maxLength: 64 },
            xlsxSha256: { type: 'string', minLength: 64, maxLength: 64 }
          }
        }
      }
    },
    costPolicy: { kind: 'mock_no_charge', currency: 'USD' }
  };
  async function handler({ input, context }) {
    const ctx = isPlainObject(context) ? context : {};
    const project = typeof ctx.project === 'string' && ctx.project !== '' ? ctx.project : null;
    const market = typeof ctx.market === 'string' && ctx.market !== '' ? ctx.market : null;
    const brand = ctx.brand === null || ctx.brand === undefined ? '' : ctx.brand;
    if (project === null || market === null || typeof brand !== 'string') {
      return { status: 'blocked', reason: 'authority_missing' };
    }
    if (!isPlainObject(input.scope)) return { status: 'blocked', reason: 'scope_missing' };
    if (input.scope.projectId !== project || input.scope.brand !== brand || input.scope.market !== market) {
      return { status: 'blocked', reason: 'scope_authority_mismatch' };
    }
    const runId = typeof ctx.runId === 'string' && ctx.runId !== '' ? ctx.runId : null;
    if (runId === null) return { status: 'blocked', reason: 'run_id_missing' };
    let pipeline;
    try {
       const contextNow = typeof ctx.now === 'string' && Number.isFinite(Date.parse(ctx.now)) ? ctx.now : null;
       pipeline = runResearchPipeline({
         input,
         authorityDomain: { projectId: project, brand, market },
         ...(contextNow ? { clock: () => contextNow } : {})
       });
    } catch (error) {
      if (error instanceof MarketError) {
        return { status: 'blocked', reason: error.code === 'observation_domain_mismatch' ? 'observation_domain_mismatch' : `invalid_input:${error.code}` };
      }
      throw error;
    }
    const exported = await exportResearchRun({
      outputRoot,
      runId,
      pipeline,
      meta: { projectId: project, brand, market }
    });
    return {
      status: 'succeeded',
      output: {
        research: {
          rulesVersion: pipeline.rulesVersion,
          cards: pipeline.cards.map((card) => {
            const band = { sampleCount: card.priceBand.sampleCount, currency: card.priceBand.currency };
            if (card.priceBand.min !== null) band.min = card.priceBand.min;
            if (card.priceBand.median !== null) band.median = card.priceBand.median;
            if (card.priceBand.max !== null) band.max = card.priceBand.max;
            return {
              configKey: card.configKey,
              label: card.label,
              scoreTotal: card.score.total,
              exactCount: card.match.exact,
              adjacentCount: card.match.adjacent,
              mismatchCount: card.match.mismatch,
              candidateCount: card.match.candidate,
              insufficient: card.match.insufficient,
              priceBand: band,
              reviewCounts: { high: card.reviews.high.length, low: card.reviews.low.length },
              evidenceComplete: card.evidenceComplete
            };
          })
        },
        cost: {
          scenarios: pipeline.costScenarios.map((scenario) => {
            const summary = {
              configKey: scenario.configKey,
              status: scenario.status,
              overMarketBand: scenario.overMarketBand,
              decision: scenario.decision,
              missingCount: Array.isArray(scenario.missing) ? scenario.missing.length : 0
            };
            if (scenario.breakEvenListPrice !== null && scenario.breakEvenListPrice !== undefined) summary.breakEvenListPrice = scenario.breakEvenListPrice;
            if (scenario.targetProfitListPrice !== null && scenario.targetProfitListPrice !== undefined) summary.targetProfitListPrice = scenario.targetProfitListPrice;
            if (scenario.recommendedListPrice !== null && scenario.recommendedListPrice !== undefined) summary.recommendedListPrice = scenario.recommendedListPrice;
            if (scenario.unitProfit) {
              summary.unitProfit = { listPrice: scenario.unitProfit.listPrice, profit: scenario.unitProfit.profit };
              if (scenario.unitProfit.marginRatePct !== null && scenario.unitProfit.marginRatePct !== undefined) summary.unitProfit.marginRatePct = scenario.unitProfit.marginRatePct;
            }
            return summary;
          })
        },
        exports: {
          jsonPath: exported.jsonPath,
          xlsxPath: exported.xlsxPath,
          jsonSha256: exported.jsonSha256,
          xlsxSha256: exported.xlsxSha256
        }
      }
    };
  }
  return { tool, handler };
}

function registerMarketHandler(registry, registration) {
  registry.register(registration.tool, registration.handler);
  return registry.get(registration.tool.name);
}

module.exports = {
  MARKET_SCHEMA_VERSION,
  MARKET_RULES_VERSION,
  MATCH_CATEGORIES,
  REVIEW_CAPS,
  SCORE_FACTORS,
  DEFAULT_RULES,
  PRECISION,
  MICRO_LEDGER_NOTE,
  MARKET_TOOL_NAME,
  MARKET_TOOL_VERSION,
  MARKET_ROLE,
  MarketError,
  marketError,
  normalizeConfig,
  normalizeObservation,
  matchCompetitor,
  buildResearchCards,
  selectReviewSamples,
  scoreResearchCard,
  mapObservationToPriceRow,
  buildCostScenario,
  runResearchPipeline,
  sanitizeCellValue,
  exportResearchRun,
  readBackResearchWorkbook,
  createMarketRegistration,
  registerMarketHandler
};
