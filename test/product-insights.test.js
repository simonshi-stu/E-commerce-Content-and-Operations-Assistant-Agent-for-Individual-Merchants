'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFeatureDefinitions, parseWeight, productInsight, summarizeCategory } = require('../lib/product-insights');

function record(overrides = {}) {
  return {
    asin: 'B000123456', title: 'Demo commuter helmet with rear LED light and visor', brand: 'Demo', price: 39.99,
    currency: 'USD', rating: 4.6, reviews: 1_245, itemWeight: '10 ounces', productDimensions: '12 x 9 x 7 inches',
    featureBullets: ['Integrated rear LED light and adjustable fit dial.', 'Includes removable visor.'],
    customerSummary: 'Customers appreciate the comfortable fit.',
    reviewsVisible: [{ rating: 5, text: 'Comfortable fit.' }, { rating: 2, text: 'Strap is hard to adjust.' }],
    positiveReviewSnippets: ['Comfortable fit.'], criticalReviewSnippets: ['Strap is hard to adjust.'],
    reviewIssueTags: [{ tag: 'strap_adjustment', count: 1 }], pageStatus: 'parsed', sourceType: 'amazon_public_product', observedAt: '2026-10-28',
    url: 'https://www.amazon.com/dp/B000123456', image: 'https://m.media-amazon.com/images/I/demo.jpg', ...overrides
  };
}

test('parses common public-page weight units without inventing missing values', () => {
  assert.equal(parseWeight('10 ounces').grams, 283.5);
  assert.equal(parseWeight('0.7 lb').grams, 317.5);
  assert.equal(parseWeight('315 g').grams, 315);
  assert.equal(parseWeight('not listed').grams, null);
});

test('extracts helmet features and distinguishes visible review sample rate', () => {
  const insight = productInsight(record(), { featureDefinitions: buildFeatureDefinitions({ category: '骑行头盔' }) });
  assert.equal(insight.weight.grams, 283.5);
  assert.equal(insight.negativeReviewRate.negativeRatePct, 50);
  assert.equal(insight.negativeReviewRate.basis, 'visible_review_sample');
  assert.ok(insight.features.some((feature) => feature.id === 'headlight' && feature.present));
  assert.ok(insight.features.some((feature) => feature.id === 'goggles_visor' && feature.present));
  assert.equal(insight.positives.length, 1);
  assert.equal(insight.negatives.length, 1);
});

test('uses an official rating histogram before visible review samples', () => {
  const insight = productInsight(record({ ratingDistribution: { source: 'amazon_rating_histogram', percentages: { 1: 4, 2: 3, 3: 5, 4: 18, 5: 70 } } }));
  assert.equal(insight.negativeReviewRate.negativeRatePct, 12);
  assert.equal(insight.negativeReviewRate.basis, 'amazon_rating_histogram');
});

test('summarizes category facts and exposes evidence coverage and caveats', () => {
  const result = summarizeCategory([record(), record({ asin: 'B000123457', price: 59.99, itemWeight: '12 ounces', reviews: 20, reviewsVisible: [] })], {
    category: '骑行头盔', userNeed: '夜间通勤', queries: ['commuter bike helmet with light'], observedAt: '2026-10-28'
  });
  assert.equal(result.metrics.productPages, 2);
  assert.equal(result.metrics.price.median, 49.99);
  assert.equal(result.metrics.weight.count, 2);
  assert.ok(result.features.some((feature) => feature.id === 'headlight' && feature.count === 2));
  assert.equal(result.metrics.negativeReviewRate.basis, 'visible_review_sample');
  assert.ok(result.caveats.some((item) => item.includes('利润')));
});
