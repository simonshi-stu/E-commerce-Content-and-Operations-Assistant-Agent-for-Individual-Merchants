'use strict';

const { splitCsvLine } = require('./csv');
const { uiMessage } = require('./messages');

const HEADER_ALIASES = {
  keyword: ['keyword', 'query', 'search', '关键词', '搜索词'],
  position: ['position', 'rank', 'pos', '排名', '位置', '搜索展示位', '展示位'],
  title: ['title', 'product', 'listing', '标题', '产品', '商品'],
  brand: ['brand', '品牌'],
  price: ['price', '价格', '售价'],
  rating: ['rating', 'stars', '评分', '星级'],
  reviews: ['reviews', 'reviewcount', '评论', '评论数'],
  bought: ['bought', 'monthlysales', 'sales', '月销', '购买', '销量'],
  badge: ['badge', 'tag', '标签', '徽章'],
  note: ['note', 'notes', 'remark', '备注'],
  asin: ['asin', 'productid', '商品编号', '商品id'],
  image: ['image', 'imageurl', 'img', '图片', '图片链接'],
  url: ['url', 'producturl', 'link', '商品链接', '链接'],
  store: ['store', 'storefront', 'brandstore', 'shop', '店铺', '品牌店'],
  sourceType: ['source', 'sourcetype', '来源', '来源类型'],
  observedAt: ['observedat', 'observed', 'date', '采集时间', '观察日期']
};

const POSITIONAL_ORDER = [
  'keyword', 'position', 'title', 'brand', 'price', 'rating', 'reviews', 'bought', 'badge', 'note',
  'asin', 'image', 'url', 'store', 'sourceType', 'observedAt'
];

const FEATURE_TERMS = [
  'mips', 'led', 'lightweight', 'commuter', 'road', 'mountain', 'mtb', 'kids', 'youth', 'adult',
  'adjustable', 'ventilated', 'waterproof', 'ipx', 'usb', 'reflective', 'visor', 'detachable',
  'certified', 'cpsc', 'en1078', 'spin', 'wavecel', 'aero',
  '轻量', '通风', '通勤', '山地', '公路', '儿童', '成人', '可调', '防水', '反光', '磁吸', '认证'
];

const GENERIC_TITLE_WORDS = new Set([
  'adult', 'adults', 'kids', 'kid', 'youth', 'toddler', 'men', 'women', 'mens', 'womens', 'unisex',
  'bike', 'bicycle', 'cycling', 'helmet', 'helmets', 'new', 'adjustable', 'lightweight', 'mountain',
  'road', 'mtb', 'sport', 'sports', 'outdoor', 'outdoors', 'the', 'a', 'an', 'for', 'with', 'and',
  'mips', 'cpsc', 'certified', 'smart', 'retro', 'classic', 'urban', 'commuter', 'casual', 'multi',
  'one', 'two', 'set', 'pack', 'child', 'children', 'infant', 'baby', 'boys', 'girls', 'boy', 'girl'
]);

function numeric(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function parseBought(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const english = text.match(/([\d.,]+)\s*([KkMm]?)\s*\+?\s*(?:bought|sold|purchased)/);
  if (english) {
    const base = Number.parseFloat(english[1].replace(/,/g, ''));
    if (Number.isFinite(base)) {
      const suffix = english[2].toLowerCase();
      if (suffix === 'k') return base * 1_000;
      if (suffix === 'm') return base * 1_000_000;
      return base;
    }
  }
  const chinese = text.match(/([\d.,]+)\s*([万千]?)\s*\+?\s*人?购买/);
  if (chinese) {
    const base = Number.parseFloat(chinese[1].replace(/,/g, ''));
    if (Number.isFinite(base)) {
      if (chinese[2] === '万') return base * 10_000;
      if (chinese[2] === '千') return base * 1_000;
      return base;
    }
  }
  return 0;
}

function safeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text, 'https://www.amazon.com');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href.slice(0, 1_000);
  } catch {
    return '';
  }
}

function parseMarketRows(text, locale) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: uiMessage(locale, 'intel.market.empty') };

  const normalizeHeader = (cell) => cell.toLowerCase().replace(/[%％\s]/g, '');
  const firstCells = splitCsvLine(lines[0]).map(normalizeHeader);
  const aliasSet = new Set(Object.values(HEADER_ALIASES).flat().map(normalizeHeader));
  const useHeader = firstCells.some((cell) => aliasSet.has(cell));
  const map = {};
  if (useHeader) {
    firstCells.forEach((cell, index) => {
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[field] === undefined && aliases.map(normalizeHeader).includes(cell)) map[field] = index;
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
    const title = pick('title').slice(0, 200);
    const brand = pick('brand').slice(0, 80);
    if (!title && !brand) continue;
    rows.push({
      keyword: pick('keyword').slice(0, 80),
      position: Math.max(0, Number.parseInt(pick('position'), 10) || 0),
      title,
      brand,
      price: Math.max(0, numeric(pick('price'))),
      rating: Math.min(5, Math.max(0, numeric(pick('rating')))),
      reviews: Math.max(0, Math.round(numeric(pick('reviews')))),
      bought: parseBought(pick('bought')),
      badge: pick('badge').slice(0, 60),
      note: pick('note').slice(0, 200),
      asin: pick('asin').replace(/[^a-z\d-]/gi, '').slice(0, 20),
      image: safeUrl(pick('image')),
      url: safeUrl(pick('url')),
      store: pick('store').slice(0, 100),
      sourceType: pick('sourceType').slice(0, 60),
      observedAt: pick('observedAt').slice(0, 40)
    });
    if (rows.length >= 60) break;
  }

  if (rows.length === 0) return { error: uiMessage(locale, 'intel.market.noRows') };
  return { rows };
}

function brandOf(row) {
  if (row.brand) return row.brand;
  const words = String(row.title || '').split(/\s+/);
  for (const word of words.slice(0, 2)) {
    const cleaned = word.replace(/[^\p{L}\d'-]/gu, '');
    if (!cleaned) continue;
    if (GENERIC_TITLE_WORDS.has(cleaned.toLowerCase())) continue;
    return cleaned.slice(0, 40);
  }
  return 'unknown';
}

function productEvidence(rows) {
  return [...rows]
    .sort((a, b) => (a.position || Number.MAX_SAFE_INTEGER) - (b.position || Number.MAX_SAFE_INTEGER))
    .slice(0, 12)
    .map((row) => ({
      position: row.position,
      title: row.title,
      brand: brandOf(row),
      price: row.price,
      rating: row.rating,
      reviews: row.reviews,
      bought: row.bought,
      badge: row.badge,
      asin: row.asin,
      image: row.image,
      url: row.url,
      store: row.store,
      sourceType: row.sourceType,
      observedAt: row.observedAt
    }));
}

function analyzeMarket(rows, options = {}) {
  const locale = options.locale || 'zh';
  const sample = rows.length;
  const prices = rows.map((row) => row.price).filter((price) => price > 0);
  const ratings = rows.map((row) => row.rating).filter((rating) => rating > 0);
  const reviews = rows.map((row) => row.reviews).filter((count) => count > 0);
  const boughtValues = rows.map((row) => row.bought).filter((count) => count > 0);

  const p25 = percentile(prices, 0.25);
  const p75 = percentile(prices, 0.75);
  const bands = [
    { id: 'budget', min: prices.length ? round(Math.min(...prices)) : 0, max: round(p25), count: 0 },
    { id: 'mid', min: round(p25), max: round(p75), count: 0 },
    { id: 'premium', min: round(p75), max: prices.length ? round(Math.max(...prices)) : 0, count: 0 }
  ];
  for (const price of prices) {
    if (price <= p25) bands[0].count += 1;
    else if (price <= p75) bands[1].count += 1;
    else bands[2].count += 1;
  }
  if (bands[1].count > 0 && prices.length === bands[0].count + bands[1].count) bands[0].min = prices.length ? round(Math.min(...prices)) : 0;

  const brandMap = new Map();
  let unknownBrands = 0;
  for (const row of rows) {
    const brand = brandOf(row);
    if (brand === 'unknown') {
      unknownBrands += 1;
      continue;
    }
    if (!brandMap.has(brand)) brandMap.set(brand, []);
    brandMap.get(brand).push(row);
  }
  const brands = [...brandMap.entries()].map(([brand, listings]) => ({
    brand,
    listings: listings.length,
    share: round((listings.length / sample) * 100),
    averagePrice: round(average(listings.map((row) => row.price).filter((price) => price > 0))),
    medianReviews: Math.round(median(listings.map((row) => row.reviews).filter((count) => count > 0)))
  })).sort((a, b) => b.listings - a.listings || b.medianReviews - a.medianReviews);
  const topThreeShare = round(brands.slice(0, 3).reduce((total, brand) => total + brand.share, 0));
  const dominantSellers = brands.filter((brand) => brand.listings >= 2 && brand.medianReviews >= 500);

  const featureMap = new Map();
  for (const row of rows) {
    const text = String(row.title || '').toLowerCase();
    for (const term of FEATURE_TERMS) {
      if (text.includes(term)) featureMap.set(term, (featureMap.get(term) || 0) + 1);
    }
  }
  const features = [...featureMap.entries()]
    .map(([term, count]) => ({ term, count, share: round((count / sample) * 100) }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, 15);

  const reviewTop10 = reviews.length
    ? Math.round(median([...rows].sort((a, b) => a.position - b.position).slice(0, 10).map((row) => row.reviews).filter((count) => count > 0)))
    : 0;
  const medianReviews = Math.round(median(reviews));
  const priceSpread = p25 > 0 ? round(p75 / p25) : 0;
  const averageRating = round(average(ratings));

  const components = {
    reviewBarrier: medianReviews <= 100 ? 100 : medianReviews <= 500 ? 80 : medianReviews <= 2_000 ? 60 : medianReviews <= 10_000 ? 40 : 20,
    brandConcentration: topThreeShare <= 30 ? 100 : topThreeShare <= 50 ? 75 : topThreeShare <= 70 ? 50 : 25,
    priceSpread: priceSpread >= 1.6 ? 100 : priceSpread >= 1.3 ? 70 : priceSpread > 0 ? 40 : 50,
    ratingBarrier: averageRating <= 4.2 ? 80 : averageRating <= 4.5 ? 60 : averageRating > 0 ? 40 : 50
  };
  const entryScore = Math.round(
    components.reviewBarrier * 0.4 + components.brandConcentration * 0.25 +
    components.priceSpread * 0.15 + components.ratingBarrier * 0.2
  );
  const level = entryScore >= 70 ? 'high' : entryScore >= 50 ? 'medium' : 'low';

  const reasons = [];
  if (sample < 8) reasons.push('limited_sample');
  if (medianReviews > 2_000) reasons.push('review_wall');
  else if (medianReviews <= 100) reasons.push('low_review_barrier');
  if (topThreeShare > 50) reasons.push('brand_dominance');
  else reasons.push('fragmented_brands');
  if (priceSpread > 0 && priceSpread < 1.3) reasons.push('narrow_price');
  else if (priceSpread >= 1.6) reasons.push('healthy_spread');
  if (averageRating > 4.5) reasons.push('high_ratings');
  if (boughtValues.length === 0) reasons.push('no_demand_signal');
  else reasons.push('demand_confirmed');
  if (dominantSellers.length >= 3) reasons.push('multiple_dominant_sellers');
  if (unknownBrands > sample * 0.3) reasons.push('missing_brand');

  const reviewRate = Number.isFinite(options.reviewRate) && options.reviewRate > 0 && options.reviewRate <= 1
    ? options.reviewRate
    : 0.01;
  const reviewsTotal = reviews.reduce((total, value) => total + value, 0);
  const observedDates = [...new Set(rows.map((row) => row.observedAt).filter(Boolean))];
  const sourceTypes = [...new Set(rows.map((row) => row.sourceType).filter(Boolean))];

  return {
    result: {
      sample,
      products: productEvidence(rows),
      provenance: {
        dataBasis: options.dataBasis || 'manual_public_front_end',
        observedAt: options.observedAt || (observedDates.length === 1 ? observedDates[0] : null),
        sourceTypes
      },
      keywords: [...new Set(rows.map((row) => row.keyword).filter(Boolean))],
      price: {
        count: prices.length,
        min: prices.length ? round(Math.min(...prices)) : 0,
        max: prices.length ? round(Math.max(...prices)) : 0,
        average: round(average(prices)),
        median: round(median(prices)),
        p25: round(p25),
        p75: round(p75),
        spread: priceSpread,
        bands
      },
      ratings: {
        count: ratings.length,
        average: averageRating
      },
      reviews: {
        count: reviews.length,
        median: medianReviews,
        top10Median: reviewTop10,
        max: reviews.length ? Math.max(...reviews) : 0
      },
      demand: {
        listingsWithSignal: boughtValues.length,
        monthlyUnitsFloor: Math.round(boughtValues.reduce((total, value) => total + value, 0)),
        reviewsTotal,
        reviewRate,
        cumulativeUnitsEstimate: Math.round(reviewsTotal * (1 / reviewRate))
      },
      brands: {
        count: brands.length,
        topThreeShare,
        unknownShare: round((unknownBrands / sample) * 100),
        top: brands.slice(0, 8),
        dominantSellers: dominantSellers.slice(0, 5)
      },
      features,
      entry: {
        score: entryScore,
        level,
        components,
        reasons
      }
    }
  };
}

module.exports = { FEATURE_TERMS, HEADER_ALIASES, POSITIONAL_ORDER, analyzeMarket, parseBought, parseMarketRows };
