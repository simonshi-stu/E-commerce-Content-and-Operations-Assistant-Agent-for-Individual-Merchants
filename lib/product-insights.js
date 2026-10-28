'use strict';

// Deterministic product-detail extraction and comparison. This module does not
// infer demand, profitability, or a recommendation from public-page fields.

const GENERIC_FEATURES = [
  { id: 'adjustable_fit', label: '可调节/贴合', terms: ['adjustable', 'fit dial', 'dial fit', 'adjustment', '可调', '调节'] },
  { id: 'ventilation', label: '通风/散热', terms: ['ventilated', 'ventilation', 'airflow', 'vent', '通风', '散热'] },
  { id: 'lightweight', label: '轻量', terms: ['lightweight', 'ultralight', '轻量', '超轻'] },
  { id: 'water_resistance', label: '防水/防泼水', terms: ['waterproof', 'water resistant', 'water-resistant', '防水', '防泼水'] },
  { id: 'reflective', label: '反光/可见性', terms: ['reflective', 'visibility', 'high visibility', '反光', '可见性'] },
  { id: 'removable_liner', label: '可拆洗内衬', terms: ['removable liner', 'washable liner', 'removable padding', '可拆', '可洗', '内衬'] },
  { id: 'certification', label: '认证/标准', terms: ['cpsc', 'ce', 'en1078', 'astm', 'certified', 'certification', '认证', '标准'] }
];

const HELMET_FEATURES = [
  { id: 'headlight', label: '头灯/尾灯', terms: ['headlight', 'rear light', 'front light', 'tail light', 'led light', 'led rear', 'lighted', '头灯', '尾灯', '灯'] },
  { id: 'goggles_visor', label: '护目镜/面罩', terms: ['goggles', 'visor', 'shield', 'face shield', '护目镜', '风镜', '面罩'] },
  { id: 'mips', label: 'MIPS/旋转冲击保护', terms: ['mips', 'rotational impact', '旋转冲击'] },
  { id: 'battery', label: '电池/充电', terms: ['battery', 'rechargeable', 'usb', 'charging', '电池', '充电', 'usb'] },
  { id: 'accessories', label: '附送配件', terms: ['included', 'comes with', 'accessories', 'free', 'included goggles', '配件', '附送', '赠送'] }
];

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseWeight(value) {
  const raw = clean(value, 120);
  if (!raw) return { raw: '', grams: null, unit: '', status: 'not_found' };
  const match = raw.match(/(\d+(?:[.,]\d+)?)\s*(ounces?|oz|pounds?|lbs?|lb|kilograms?|kgs?|kg|grams?|g)\b/i);
  if (!match) return { raw, grams: null, unit: '', status: 'unparsed' };
  const amount = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return { raw, grams: null, unit: '', status: 'unparsed' };
  const unit = match[2].toLowerCase();
  const factor = /ounce|oz/.test(unit) ? 28.349523125
    : /pound|lb/.test(unit) ? 453.59237
      : /kilogram|kg/.test(unit) ? 1000 : 1;
  return { raw, grams: round(amount * factor, 1), unit, status: 'parsed' };
}

function normalizeTerms(value) {
  return (Array.isArray(value) ? value : String(value || '').split(/[,，;；\n]+/))
    .map((item) => clean(item, 80).toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

function buildFeatureDefinitions({ category = '', featureHints = [] } = {}) {
  const categoryText = clean(category, 160).toLowerCase();
  const source = /helmet|头盔|bicycle|cycling|骑行|bike/.test(categoryText)
    ? [...HELMET_FEATURES, ...GENERIC_FEATURES]
    : [...GENERIC_FEATURES];
  const definitions = new Map(source.map((item) => [item.id, { ...item, terms: [...item.terms] }]));
  for (const hint of Array.isArray(featureHints) ? featureHints : []) {
    if (hint && typeof hint === 'object' && !Array.isArray(hint)) {
      const label = clean(hint.label || hint.id, 80);
      const id = clean(hint.id || label, 60).toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || `custom_${definitions.size + 1}`;
      const terms = normalizeTerms(hint.terms || label);
      if (label && terms.length) definitions.set(id, { id, label, terms });
    } else {
      const label = clean(hint, 80);
      const terms = normalizeTerms(label);
      if (label && terms.length) {
        const id = `custom_${definitions.size + 1}`;
        definitions.set(id, { id, label, terms });
      }
    }
  }
  return [...definitions.values()].slice(0, 30);
}

function matchFeatures(record, definitions) {
  const evidenceText = [record.title, ...(record.featureBullets || []), record.customerSummary, ...(record.questionSnippets || [])]
    .map((item) => clean(item, 500)).filter(Boolean);
  const searchable = evidenceText.join(' ').toLowerCase();
  return definitions.map((definition) => {
    const matchedTerms = definition.terms.filter((term) => searchable.includes(term));
    const evidence = evidenceText.filter((item) => definition.terms.some((term) => item.toLowerCase().includes(term))).slice(0, 3);
    return { id: definition.id, label: definition.label, present: matchedTerms.length > 0, matchedTerms, evidence };
  });
}

function normalizeDistribution(value) {
  const source = value && typeof value === 'object' ? (value.percentages || value.stars || value) : {};
  const result = {};
  for (let star = 1; star <= 5; star += 1) {
    const raw = source[star] ?? source[String(star)] ?? source[`${star}Star`];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) result[star] = parsed;
  }
  return result;
}

function reviewSummary(record) {
  const histogram = normalizeDistribution(record.ratingDistribution);
  const histogramValues = Object.values(histogram);
  if (histogramValues.length >= 3 && histogramValues.some((value) => value > 0)) {
    return {
      negativeRatePct: round([1, 2, 3].reduce((sum, star) => sum + (histogram[star] || 0), 0), 2),
      basis: 'amazon_rating_histogram', sampleCount: Number(record.reviews) || null, distribution: histogram
    };
  }
  const visible = Array.isArray(record.reviewsVisible) ? record.reviewsVisible.filter((item) => Number(item.rating) > 0) : [];
  if (visible.length) {
    return {
      negativeRatePct: round(visible.filter((item) => Number(item.rating) <= 3).length / visible.length * 100, 2),
      basis: 'visible_review_sample', sampleCount: visible.length, distribution: null
    };
  }
  return { negativeRatePct: null, basis: 'unavailable', sampleCount: 0, distribution: null };
}

function productInsight(record, options = {}) {
  const reviews = Array.isArray(record.reviewsVisible) ? record.reviewsVisible : [];
  const positive = (record.positiveReviewSnippets || []).filter(Boolean).slice(0, 3);
  const negative = (record.criticalReviewSnippets || []).filter(Boolean).slice(0, 3);
  const review = reviewSummary(record);
  return {
    asin: clean(record.asin, 20), title: clean(record.title, 260), brand: clean(record.brand, 120),
    url: clean(record.url || record.productUrl, 2_000), image: clean(record.image || record.imageUrl, 2_000),
    price: Number(record.price) > 0 ? round(Number(record.price)) : null, currency: clean(record.currency, 3) || 'USD',
    rating: Number(record.rating) > 0 ? round(Number(record.rating), 2) : null,
    reviewCount: Number(record.reviews) > 0 ? Math.round(Number(record.reviews)) : null,
    reviewCountBasis: Number(record.reviews) > 0 ? 'amazon_aggregate_rating_count' : 'not_found',
    negativeReviewRate: review,
    weight: parseWeight(record.itemWeight), itemWeight: clean(record.itemWeight, 120),
    dimensions: clean(record.productDimensions, 160), sizes: Array.isArray(record.sizes) ? record.sizes.slice(0, 20) : [],
    performance: {
      pageClaims: (record.featureBullets || []).filter(Boolean).slice(0, 8),
      customerSummary: clean(record.customerSummary, 1_000),
      customerAspects: Array.isArray(record.customerAspects) ? record.customerAspects.slice(0, 12) : []
    },
    positives: positive,
    negatives: negative,
    reviewThemes: Array.isArray(record.reviewIssueTags) ? record.reviewIssueTags.slice(0, 12) : [],
    features: matchFeatures(record, options.featureDefinitions || []),
    provenance: { sourceType: clean(record.sourceType, 80), pageStatus: clean(record.pageStatus, 40), observedAt: clean(record.observedAt, 50) }
  };
}

function summarizeCategory(records = [], options = {}) {
  const all = Array.isArray(records) ? records : [];
  const parsed = all.filter((record) => record && (record.pageStatus === 'parsed' || record.sourceType === 'amazon_public_product'));
  const featureDefinitions = options.featureDefinitions || buildFeatureDefinitions(options);
  const products = parsed.map((record) => productInsight(record, { featureDefinitions }));
  const prices = products.map((item) => item.price).filter((value) => Number.isFinite(value) && value > 0);
  const weights = products.map((item) => item.weight.grams).filter((value) => Number.isFinite(value) && value > 0);
  const ratings = products.map((item) => item.rating).filter((value) => Number.isFinite(value) && value > 0);
  const reviewCounts = products.map((item) => item.reviewCount).filter((value) => Number.isFinite(value) && value > 0);
  const officialRates = products.filter((item) => item.negativeReviewRate.basis === 'amazon_rating_histogram');
  const sampledRates = products.filter((item) => item.negativeReviewRate.basis === 'visible_review_sample');
  const weightedRate = (items, countKey) => {
    const denominator = items.reduce((sum, item) => sum + (Number(item[countKey]) || Number(item.negativeReviewRate.sampleCount) || 0), 0);
    return denominator ? round(items.reduce((sum, item) => sum + item.negativeReviewRate.negativeRatePct * (Number(item[countKey]) || Number(item.negativeReviewRate.sampleCount) || 0), 0) / denominator, 2) : null;
  };
  const featureSummary = featureDefinitions.map((definition) => {
    const count = products.filter((product) => product.features.find((feature) => feature.id === definition.id)?.present).length;
    return { id: definition.id, label: definition.label, count, sharePct: products.length ? round(count / products.length * 100, 2) : 0 };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const themeMap = new Map();
  for (const product of products) for (const theme of product.reviewThemes) {
    if (!theme || !theme.tag) continue;
    themeMap.set(theme.tag, (themeMap.get(theme.tag) || 0) + Number(theme.count || 0));
  }
  const negativeThemes = [...themeMap.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })).slice(0, 12);
  return {
    category: clean(options.category, 160), userNeed: clean(options.userNeed || options.need, 500), marketplace: clean(options.marketplace, 120),
    products, searchCandidates: all.filter((record) => !parsed.includes(record)).slice(0, 30).map((record) => ({
      asin: clean(record.asin, 20), title: clean(record.title, 260), price: Number(record.price) > 0 ? round(Number(record.price)) : null,
      rating: Number(record.rating) > 0 ? round(Number(record.rating), 2) : null, reviews: Number(record.reviews) > 0 ? Math.round(Number(record.reviews)) : null,
      url: clean(record.url, 2_000), image: clean(record.image, 2_000), keyword: clean(record.keyword, 160), position: Number(record.position) || null
    })),
    metrics: {
      productPages: products.length, totalRecords: all.length,
      price: prices.length ? { count: prices.length, min: round(Math.min(...prices)), max: round(Math.max(...prices)), median: round(median(prices)), average: round(prices.reduce((sum, value) => sum + value, 0) / prices.length) } : { count: 0 },
      rating: ratings.length ? { count: ratings.length, average: round(ratings.reduce((sum, value) => sum + value, 0) / ratings.length, 2) } : { count: 0 },
      reviews: reviewCounts.length ? { count: reviewCounts.length, median: Math.round(median(reviewCounts)), total: reviewCounts.reduce((sum, value) => sum + value, 0), max: Math.max(...reviewCounts) } : { count: 0 },
      weight: weights.length ? { count: weights.length, minGrams: round(Math.min(...weights), 1), maxGrams: round(Math.max(...weights), 1), medianGrams: round(median(weights), 1) } : { count: 0 },
      negativeReviewRate: officialRates.length ? { ratePct: weightedRate(officialRates, 'reviewCount'), basis: 'amazon_rating_histogram', products: officialRates.length }
        : sampledRates.length ? { ratePct: weightedRate(sampledRates, 'reviewCount'), basis: 'visible_review_sample', products: sampledRates.length }
          : { ratePct: null, basis: 'unavailable', products: 0 }
    },
    features: featureSummary,
    negativeThemes,
    coverage: {
      price: products.filter((item) => item.price !== null).length,
      weight: weights.length, reviews: reviewCounts.length,
      positiveSamples: products.filter((item) => item.positives.length).length,
      negativeSamples: products.filter((item) => item.negatives.length).length,
      negativeRate: officialRates.length || sampledRates.length
    },
    caveats: [
      '价格、规格、评论和功能只代表抓取时公开可见页面；变体、促销和页面内容会变化。',
      '差评率优先使用页面公开星级分布；没有分布时仅显示抓取到的可见评论样本比例，不代表全部评论。',
      '未包含采购成本、平台费用、广告、退货和利润，因此不输出赚钱或不赚钱结论。'
    ],
    provenance: { dataBasis: 'amazon_public_frontend', observedAt: options.observedAt || null, queries: Array.isArray(options.queries) ? options.queries.slice(0, 20) : [] }
  };
}

module.exports = { GENERIC_FEATURES, HELMET_FEATURES, buildFeatureDefinitions, parseWeight, productInsight, reviewSummary, summarizeCategory };
