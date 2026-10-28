'use strict';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function seriesKey(point) {
  return `${point.platform || '-'}::${point.label || '-'}`;
}

function seriesName(point) {
  return point.label || point.platform || '-';
}

function isUsable(point) {
  const price = typeof point.price === 'number' ? point.price : Number.parseFloat(point.price);
  const observedAt = typeof point.observedAt === 'string' ? point.observedAt.trim() : '';
  return DATE_PATTERN.test(observedAt) && Number.isFinite(price) && price > 0;
}

function buildTimeline(points) {
  const list = Array.isArray(points) ? points.filter((point) => point && typeof point === 'object') : [];
  const dated = [];
  for (const point of list) {
    if (!isUsable(point)) continue;
    dated.push({
      ...point,
      price: typeof point.price === 'number' ? point.price : Number.parseFloat(point.price),
      observedAt: String(point.observedAt).trim()
    });
  }
  const undatedCount = list.length - dated.length;

  const groups = new Map();
  for (const point of dated) {
    const key = seriesKey(point);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }

  const series = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const first = group[0];
    const last = group[group.length - 1];
    const prices = group.map((point) => point.price);
    const changePercent = round(((last.price - first.price) / first.price) * 100);
    series.push({
      key,
      name: seriesName(last),
      platform: last.platform || '',
      type: last.type || 'competitor',
      pointCount: group.length,
      first: { observedAt: first.observedAt, price: first.price },
      last: { observedAt: last.observedAt, price: last.price },
      min: round(Math.min(...prices)),
      max: round(Math.max(...prices)),
      changePercent,
      trend: changePercent > 1 ? 'up' : changePercent < -1 ? 'down' : 'flat',
      points: group.map((point) => ({
        observedAt: point.observedAt,
        price: point.price,
        sourceType: point.sourceType || 'unknown'
      }))
    });
  }
  series.sort((a, b) => a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform));

  const prices = dated.map((point) => point.price);
  const overall = {
    pointCount: dated.length,
    undatedCount,
    firstDate: '',
    lastDate: '',
    trend: 'flat',
    changePercent: 0,
    volatility: 0
  };
  if (dated.length > 0) {
    const dates = dated.map((point) => point.observedAt).sort();
    overall.firstDate = dates[0];
    overall.lastDate = dates[dates.length - 1];
    const mean = prices.reduce((total, value) => total + value, 0) / prices.length;
    const variance = prices.reduce((total, value) => total + (value - mean) ** 2, 0) / prices.length;
    overall.volatility = mean > 0 ? round(Math.sqrt(variance) / mean) : 0;
    if (dated.length >= 2) {
      const ordered = [...dated].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      const middle = Math.ceil(ordered.length / 2);
      const firstHalf = ordered.slice(0, middle).map((point) => point.price);
      const secondHalf = ordered.slice(middle).map((point) => point.price);
      const firstAverage = firstHalf.reduce((total, value) => total + value, 0) / firstHalf.length;
      const secondAverage = secondHalf.reduce((total, value) => total + value, 0) / secondHalf.length;
      overall.changePercent = firstAverage > 0 ? round(((secondAverage - firstAverage) / firstAverage) * 100) : 0;
      overall.trend = overall.changePercent > 1 ? 'up' : overall.changePercent < -1 ? 'down' : 'flat';
    }
  }

  return {
    version: 1,
    series,
    overall,
    bounds: {
      min: prices.length ? round(Math.min(...prices)) : 0,
      max: prices.length ? round(Math.max(...prices)) : 0
    },
    datedCount: dated.length,
    undatedCount
  };
}

module.exports = { buildTimeline };
