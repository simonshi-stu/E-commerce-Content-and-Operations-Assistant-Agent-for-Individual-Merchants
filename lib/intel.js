'use strict';

const { uiMessage } = require('./messages');

function number(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function level(value) {
  return Math.min(5, Math.max(1, Math.round(number(value, 3))));
}

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function priceSummary(values) {
  return {
    count: values.length,
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    average: round(average(values)),
    median: round(median(values))
  };
}

function keywordList(value, maxItems = 12) {
  const items = [];
  if (!Array.isArray(value)) return items;
  for (const entry of value) {
    const item = text(entry, 60).toLowerCase();
    if (!item || items.includes(item)) continue;
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

function keywordsFromSellingPoints(points) {
  const keywords = [];
  for (const point of points) {
    const parts = String(point).split(/[,，、;；/|]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
    for (const part of parts) {
      if (!keywords.includes(part)) keywords.push(part);
    }
  }
  return keywords.slice(0, 40);
}

function scoreProduct(payload, locale) {
  const name = text(payload.name, 120);
  const price = positive(payload.price);
  if (!name || price <= 0) return { error: uiMessage(locale, 'intel.score.required') };

  const unitCost = positive(payload.unitCost);
  const shippingCost = positive(payload.shippingCost);
  const adCostPerUnit = positive(payload.adCostPerUnit);
  const platformFeeRate = Math.min(90, positive(payload.platformFeeRate));
  const targetMarginRate = Math.min(95, positive(payload.targetMarginRate, 20));
  const demand = level(payload.demand);
  const competition = level(payload.competition);
  const differentiation = level(payload.differentiation);
  const risk = level(payload.risk);

  const platformFee = round(price * platformFeeRate / 100);
  const grossProfit = round(price - unitCost - shippingCost - adCostPerUnit - platformFee);
  const marginRate = round((grossProfit / price) * 100);
  const feeFactor = Math.max(0.05, 1 - platformFeeRate / 100);
  const breakEvenPrice = round((unitCost + shippingCost + adCostPerUnit) / feeFactor);

  const scores = {
    margin: grossProfit > 0 ? Math.min(100, Math.round(Math.max(0, marginRate) / 50 * 100)) : 0,
    demand: Math.round(((demand - 1) / 4) * 100),
    competition: Math.round(((5 - competition) / 4) * 100),
    differentiation: Math.round(((differentiation - 1) / 4) * 100),
    risk: Math.round(((5 - risk) / 4) * 100)
  };
  const totalScore = Math.round(
    scores.margin * 0.4 + scores.demand * 0.2 + scores.competition * 0.2 + scores.differentiation * 0.1 + scores.risk * 0.1
  );

  const meetsTarget = grossProfit > 0 && marginRate >= targetMarginRate;
  let verdict = 'avoid';
  if (meetsTarget && totalScore >= 65) verdict = 'recommended';
  else if (grossProfit > 0 && totalScore >= 45) verdict = 'watch';

  return {
    result: {
      name,
      metrics: {
        price: round(price),
        unitCost: round(unitCost),
        shippingCost: round(shippingCost),
        adCostPerUnit: round(adCostPerUnit),
        platformFee,
        grossProfit,
        marginRate,
        targetMarginRate,
        breakEvenPrice
      },
      scores,
      totalScore,
      verdict
    }
  };
}

function compareCompetitors(payload, locale) {
  const productName = text(payload.productName, 120);
  const productPrice = positive(payload.price);
  const productPoints = keywordList(payload.sellingPoints);
  const rawCompetitors = Array.isArray(payload.competitors) ? payload.competitors.slice(0, 10) : [];

  const competitors = [];
  for (const entry of rawCompetitors) {
    if (!entry || typeof entry !== 'object') continue;
    const price = positive(entry.price);
    if (price <= 0) continue;
    competitors.push({
      platform: text(entry.platform, 40),
      title: text(entry.title, 200),
      price: round(price),
      sellingPoints: keywordList(entry.sellingPoints, 10)
    });
  }
  if (productPrice <= 0 || competitors.length === 0) {
    return { error: uiMessage(locale, 'intel.compare.required') };
  }

  const prices = competitors.map((competitor) => competitor.price);
  const stats = priceSummary(prices);
  const gapPercent = round(((productPrice - stats.average) / stats.average) * 100);

  let position = 'average';
  if (productPrice <= stats.min) position = 'lowest';
  else if (productPrice < stats.average * 0.95) position = 'below_average';
  else if (productPrice <= stats.average * 1.05) position = 'average';
  else if (productPrice <= stats.max) position = 'above_average';
  else position = 'highest';

  const competitorCounts = new Map();
  for (const competitor of competitors) {
    for (const point of keywordsFromSellingPoints(competitor.sellingPoints)) {
      competitorCounts.set(point, (competitorCounts.get(point) || 0) + 1);
    }
  }
  const ownKeywords = keywordsFromSellingPoints(productPoints);
  const ownSet = new Set(ownKeywords);
  const gaps = [...competitorCounts.entries()]
    .filter(([keyword]) => !ownSet.has(keyword))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([keyword, count]) => ({ keyword, count }));
  const competitorSet = new Set(competitorCounts.keys());
  const differentiators = ownKeywords.filter((keyword) => !competitorSet.has(keyword)).slice(0, 10);

  return {
    result: {
      productName,
      price: round(productPrice),
      stats,
      gapPercent,
      position,
      gaps,
      differentiators,
      competitors
    }
  };
}

function priceStats(payload, locale) {
  const rawPoints = Array.isArray(payload.points) ? payload.points.slice(0, 30) : [];
  const points = [];
  for (const entry of rawPoints) {
    if (!entry || typeof entry !== 'object') continue;
    const price = positive(entry.price);
    if (price <= 0) continue;
    points.push({
      label: text(entry.label, 80) || `#${points.length + 1}`,
      platform: text(entry.platform, 40),
      type: entry.type === 'own' ? 'own' : 'competitor',
      price: round(price)
    });
  }
  if (points.length === 0) return { error: uiMessage(locale, 'intel.prices.required') };

  const all = points.map((point) => point.price);
  const own = points.filter((point) => point.type === 'own').map((point) => point.price);
  const competitor = points.filter((point) => point.type === 'competitor').map((point) => point.price);

  const unitCost = positive(payload.unitCost);
  const shippingCost = positive(payload.shippingCost);
  const adCostPerUnit = positive(payload.adCostPerUnit);
  const platformFeeRate = Math.min(90, positive(payload.platformFeeRate));
  const targetMarginRate = Math.min(95, positive(payload.targetMarginRate, 20));
  const fixedCost = unitCost + shippingCost + adCostPerUnit;
  const marginFactor = 1 - (platformFeeRate + targetMarginRate) / 100;
  const breakEvenPrice = round(fixedCost / Math.max(0.05, 1 - platformFeeRate / 100));
  const suggestedPrice = marginFactor > 0.05 ? round(fixedCost / marginFactor) : 0;

  return {
    result: {
      points,
      stats: {
        ...priceSummary(all),
        p25: round(percentile(all, 0.25)),
        p75: round(percentile(all, 0.75)),
        standardDeviation: round(standardDeviation(all))
      },
      groups: {
        own: own.length ? priceSummary(own) : { count: 0 },
        competitor: competitor.length ? priceSummary(competitor) : { count: 0 }
      },
      costs: {
        fixedCost: round(fixedCost),
        platformFeeRate,
        targetMarginRate,
        breakEvenPrice,
        suggestedPrice,
        feasible: suggestedPrice > 0
      }
    }
  };
}

module.exports = { compareCompetitors, priceStats, scoreProduct };
