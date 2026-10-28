'use strict';

const { splitCsvLine } = require('./csv');
const { scoreProduct } = require('./intel');
const { uiMessage } = require('./messages');

const HEADER_ALIASES = {
  name: ['name', 'product', 'title', '品名', '产品', '名称', '商品'],
  cost: ['cost', 'unitcost', 'unit_cost', '成本', '单件成本'],
  price: ['price', '售价', '价格', '计划售价'],
  shipping: ['shipping', 'freight', '运费', '头程', '头程运费'],
  fee: ['fee', 'referral', 'platformfee', 'platform_fee', '佣金', '平台佣金'],
  ad: ['ad', 'adcost', 'ad_cost', '广告', '广告费'],
  target: ['target', 'margin', 'targetmargin', 'target_margin', '目标毛利', '目标毛利率'],
  demand: ['demand', '需求', '需求强度'],
  competition: ['competition', '竞争', '竞争强度'],
  differentiation: ['diff', 'differentiation', '差异化', '差异化程度'],
  risk: ['risk', '风险', '风险水平'],
  notes: ['notes', 'note', 'remark', '备注', '描述', '说明']
};

const POSITIONAL_ORDER = ['name', 'cost', 'price', 'shipping', 'fee', 'ad', 'target', 'demand', 'competition', 'differentiation', 'risk', 'notes'];

function numeric(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function levelValue(value, fallback = 3) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(5, Math.max(1, parsed)) : fallback;
}

function parseCandidateText(text, locale) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: uiMessage(locale, 'intel.batch.empty') };

  const normalizeHeader = (cell) => cell.toLowerCase().replace(/[%％\s]/g, '');
  const firstCells = splitCsvLine(lines[0]).map(normalizeHeader);
  const aliasSet = new Set(Object.values(HEADER_ALIASES).flat().map(normalizeHeader));
  const useHeader = firstCells.some((cell) => aliasSet.has(cell));
  const map = {};
  if (useHeader) {
    firstCells.forEach((cell, index) => {
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[field] === undefined && aliases.includes(cell)) map[field] = index;
      }
    });
  }

  const rows = [];
  const start = useHeader ? 1 : 0;
  for (let index = start; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index]);
    const pick = (field) => {
      if (useHeader) return map[field] !== undefined ? (cells[map[field]] || '').trim() : '';
      const position = POSITIONAL_ORDER.indexOf(field);
      return position >= 0 ? (cells[position] || '').trim() : '';
    };
    const row = {
      name: pick('name'),
      cost: Math.max(0, numeric(pick('cost'))),
      price: Math.max(0, numeric(pick('price'))),
      shipping: Math.max(0, numeric(pick('shipping'))),
      fee: pick('fee') === '' ? undefined : Math.max(0, numeric(pick('fee'))),
      ad: Math.max(0, numeric(pick('ad'))),
      target: pick('target') === '' ? undefined : Math.max(0, numeric(pick('target'))),
      demand: levelValue(pick('demand')),
      competition: levelValue(pick('competition')),
      differentiation: levelValue(pick('differentiation')),
      risk: levelValue(pick('risk')),
      notes: pick('notes').slice(0, 200)
    };
    if (!row.name) continue;
    rows.push(row);
    if (rows.length >= 50) break;
  }

  if (rows.length === 0) return { error: uiMessage(locale, 'intel.batch.noRows') };
  return { rows };
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function assessCandidates(rows, options = {}) {
  const locale = options.locale || 'zh';
  const dataBasis = options.dataBasis === 'verified' ? 'verified' : 'estimated';
  const observedAt = typeof options.observedAt === 'string' ? options.observedAt.slice(0, 30) : '';
  const results = [];

  for (const row of rows) {
    if (!(row.price > 0)) {
      results.push({ name: row.name, verdict: 'invalid', notes: row.notes });
      continue;
    }
    const { result, error } = scoreProduct({
      name: row.name,
      price: row.price,
      unitCost: row.cost,
      shippingCost: row.shipping,
      platformFeeRate: row.fee,
      adCostPerUnit: row.ad,
      targetMarginRate: row.target,
      demand: row.demand,
      competition: row.competition,
      differentiation: row.differentiation,
      risk: row.risk,
      dataBasis,
      observedAt
    }, locale);
    if (error) {
      results.push({ name: row.name, verdict: 'invalid', notes: row.notes });
      continue;
    }
    results.push({
      name: result.name,
      verdict: result.verdict,
      totalScore: result.totalScore,
      financialScore: result.scores.margin,
      marketFitScore: Math.round(
        (result.scores.demand + result.scores.competition + result.scores.differentiation + result.scores.risk) / 4
      ),
      northAmericaFit: null,
      marginRate: result.metrics.marginRate,
      grossProfit: result.metrics.grossProfit,
      breakEvenPrice: result.metrics.breakEvenPrice,
      confidence: result.confidence,
      scores: result.scores,
      notes: row.notes
    });
  }

  for (const row of results) {
    if (row.verdict === 'invalid') continue;
    if (row.verdict !== 'avoid' && row.marketFitScore >= 70) row.northAmericaFit = 'high';
    else if (row.verdict !== 'avoid' && row.marketFitScore >= 50) row.northAmericaFit = 'medium';
    else row.northAmericaFit = 'low';
  }

  const rank = { recommended: 0, watch: 1, avoid: 2, invalid: 3 };
  results.sort((a, b) => (
    rank[a.verdict] - rank[b.verdict] ||
    (b.totalScore || 0) - (a.totalScore || 0) ||
    (b.marginRate || -999) - (a.marginRate || -999)
  ));

  const valid = results.filter((row) => row.verdict !== 'invalid');
  const topMarketFit = [...valid]
    .sort((a, b) => b.marketFitScore - a.marketFitScore || b.totalScore - a.totalScore)
    .slice(0, 3)
    .map((row) => ({ name: row.name, marketFitScore: row.marketFitScore, northAmericaFit: row.northAmericaFit }));
  const summary = {
    total: results.length,
    recommended: results.filter((row) => row.verdict === 'recommended').length,
    watch: results.filter((row) => row.verdict === 'watch').length,
    avoid: results.filter((row) => row.verdict === 'avoid').length,
    invalid: results.filter((row) => row.verdict === 'invalid').length,
    averageMarginRate: valid.length ? round(average(valid.map((row) => row.marginRate))) : 0,
    averageScore: valid.length ? round(average(valid.map((row) => row.totalScore))) : 0,
    averageMarketFit: valid.length ? round(average(valid.map((row) => row.marketFitScore))) : 0,
    topMarketFit
  };

  return { result: { rows: results, summary, dataBasis, observedAt } };
}

module.exports = { HEADER_ALIASES, POSITIONAL_ORDER, assessCandidates, parseCandidateText };
