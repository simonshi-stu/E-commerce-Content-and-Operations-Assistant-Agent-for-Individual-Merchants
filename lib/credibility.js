'use strict';

const CREDIBILITY_VERSION = 1;

const SOURCE_TYPES = Object.freeze({
  official_store: 0.95,
  merchant_record: 0.9,
  platform_search: 0.85,
  third_party_tool: 0.7,
  screenshot_note: 0.6,
  unknown: 0.35
});

const SOURCE_TYPE_LIST = Object.freeze(Object.keys(SOURCE_TYPES));

function normalizeSourceType(value) {
  return Object.prototype.hasOwnProperty.call(SOURCE_TYPES, value) ? value : 'unknown';
}

function daysSince(dateString, now = Date.now()) {
  if (typeof dateString !== 'string' || !dateString.trim()) return null;
  const time = Date.parse(dateString);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now - time) / 86400000));
}

function freshnessFactor(ageDays) {
  if (ageDays === null) return 0.45;
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.9;
  if (ageDays <= 90) return 0.7;
  if (ageDays <= 180) return 0.5;
  return 0.3;
}

function completenessFactor(entry) {
  let score = 0;
  if (Number.isFinite(entry.price) && entry.price > 0) score += 0.4;
  if (typeof entry.sourceNote === 'string' && entry.sourceNote.trim()) score += 0.35;
  if (daysSince(entry.observedAt) !== null) score += 0.25;
  return Math.min(1, score);
}

function levelOf(score) {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

function entryCredibility(entry, now = Date.now()) {
  const sourceType = normalizeSourceType(entry.sourceType);
  const ageDays = daysSince(entry.observedAt, now);
  let score = Math.round(100 * (
    0.45 * SOURCE_TYPES[sourceType] +
    0.35 * freshnessFactor(ageDays) +
    0.2 * completenessFactor(entry)
  ));
  if (sourceType === 'unknown' || ageDays === null || ageDays > 180) score = Math.min(score, 60);
  const reasons = [];
  if (sourceType === 'unknown') reasons.push('unknown_source');
  if (ageDays === null) reasons.push('missing_date');
  else if (ageDays > 180) reasons.push('stale_180d');
  else if (ageDays > 90) reasons.push('stale_90d');
  return {
    version: CREDIBILITY_VERSION,
    score,
    level: levelOf(score),
    sourceType,
    observedAt: typeof entry.observedAt === 'string' ? entry.observedAt : '',
    ageDays,
    reasons
  };
}

function coefficientOfVariation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function agreementFactor(cv) {
  if (cv === null) return 0.9;
  if (cv <= 0.1) return 1;
  if (cv <= 0.25) return 0.92;
  if (cv <= 0.5) return 0.8;
  return 0.65;
}

function aggregateCredibility(entries, now = Date.now()) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === 'object');
  if (list.length === 0) {
    return {
      version: CREDIBILITY_VERSION,
      score: 0,
      level: 'low',
      sampleCount: 0,
      averageEntryScore: 0,
      agreement: null,
      reasons: ['no_data']
    };
  }
  const scores = list.map((entry) => (entry.credibility && Number.isFinite(entry.credibility.score)
    ? entry.credibility.score
    : entryCredibility(entry, now).score));
  const averageEntryScore = Math.round(scores.reduce((total, value) => total + value, 0) / scores.length);
  const prices = list.map((entry) => entry.price).filter((price) => Number.isFinite(price) && price > 0);
  const cv = coefficientOfVariation(prices);
  const score = Math.min(100, Math.round(averageEntryScore * agreementFactor(cv)));

  const reasons = [];
  if (list.length === 1) reasons.push('single_source');
  if (list.length < 3) reasons.push('small_sample');
  if (cv !== null && cv > 0.5) reasons.push('low_agreement');
  if (list.some((entry) => normalizeSourceType(entry.sourceType) === 'unknown')) reasons.push('unknown_source');
  if (list.some((entry) => daysSince(entry.observedAt, now) === null)) reasons.push('missing_date');
  if (list.some((entry) => (daysSince(entry.observedAt, now) || 0) > 180)) reasons.push('stale_180d');
  if (reasons.length === 0) reasons.push('high_credibility');

  return {
    version: CREDIBILITY_VERSION,
    score,
    level: levelOf(score),
    sampleCount: list.length,
    averageEntryScore,
    agreement: cv === null ? null : Math.round(cv * 100) / 100,
    reasons: [...new Set(reasons)]
  };
}

function sampleFactor(count) {
  if (count >= 5) return 1;
  if (count >= 3) return 0.95;
  if (count === 2) return 0.9;
  return 0.7;
}

function assessmentConfidence(options = {}) {
  const now = options.now || Date.now();
  const reasons = [];
  let score;
  if (options.aggregate) {
    const aggregate = options.aggregate;
    score = Math.min(100, Math.round(aggregate.score * sampleFactor(aggregate.sampleCount)));
    reasons.push(...aggregate.reasons);
  } else {
    const dataBasis = options.dataBasis === 'verified' || options.dataBasis === 'guess' ? options.dataBasis : 'estimated';
    const basis = dataBasis === 'verified' ? 1 : dataBasis === 'estimated' ? 0.7 : 0.4;
    if (dataBasis === 'estimated') reasons.push('estimated_inputs');
    if (dataBasis === 'guess') reasons.push('unverified_inputs');
    const ageDays = daysSince(options.observedAt, now);
    if (ageDays === null) reasons.push('missing_date');
    else if (ageDays > 90) reasons.push('stale_90d');
    score = Math.round(100 * (0.85 * basis + 0.15 * freshnessFactor(ageDays)));
    if (dataBasis === 'estimated') score = Math.min(score, 74);
    if (dataBasis === 'guess') score = Math.min(score, 45);
  }
  return {
    version: CREDIBILITY_VERSION,
    score,
    level: levelOf(score),
    reasons: [...new Set(reasons)]
  };
}

function credibilityPromptBlock(locale = 'zh') {
  if (locale === 'en') {
    return [
      'Source credibility contract (v1):',
      `- sourceType must be one of: ${SOURCE_TYPE_LIST.join(', ')}.`,
      '- Every external fact (competitor price, spec, sales, review) must carry sourceType, sourceNote, and observedAt (ISO date).',
      '- Treat data as verified only when sourceType is official_store or merchant_record AND observedAt is within 30 days; otherwise call it unverified or dated.',
      '- Never invent a source, URL, or date. If unknown, use sourceType "unknown" and say so.',
      '- For every conclusion include confidence.score (0-100), confidence.level (high >= 75, medium >= 50, low < 50), and confidence.reasons using codes: unknown_source, missing_date, stale_90d, stale_180d, single_source, small_sample, low_agreement, estimated_inputs, unverified_inputs, no_data, high_credibility.'
    ].join('\n');
  }
  return [
    '数据可信度契约（v1）：',
    `- sourceType 只能是：${SOURCE_TYPE_LIST.join('、')}。`,
    '- 每条外部数据（竞品价格、参数、销量、评价）必须携带 sourceType、sourceNote、observedAt（ISO 日期）。',
    '- 只有 sourceType 为 official_store 或 merchant_record 且 observedAt 在 30 天内，才能称为“已验证”；否则必须说明未验证或已过时。',
    '- 禁止编造来源、链接或日期；未知时使用 sourceType "unknown" 并明确说明。',
    '- 每个结论必须包含 confidence.score（0-100）、confidence.level（high>=75、medium>=50、low<50）、confidence.reasons，原因码限：unknown_source、missing_date、stale_90d、stale_180d、single_source、small_sample、low_agreement、estimated_inputs、unverified_inputs、no_data、high_credibility。'
  ].join('\n');
}

module.exports = {
  CREDIBILITY_VERSION,
  SOURCE_TYPE_LIST,
  SOURCE_TYPES,
  aggregateCredibility,
  assessmentConfidence,
  credibilityPromptBlock,
  daysSince,
  entryCredibility,
  freshnessFactor,
  levelOf,
  normalizeSourceType
};
