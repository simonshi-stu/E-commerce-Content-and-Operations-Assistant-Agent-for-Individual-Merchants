'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { auditEvidence, asinFrom, newAuditRecord } = require('../lib/report-audit');

it('finds duplicate IDs, mismatched ASINs, reused cross-product BSRs and unsupported histograms', () => {
  const result = auditEvidence([
    { sourceId: 'D1', asin: 'B000000001', url: 'https://amazon.com/dp/B000000002', bsr: '#1', histogramClaim: true, histogramObserved: false },
    { sourceId: 'D1', asin: 'B000000003', url: 'https://amazon.com/dp/B000000003', bsr: '#1', imageAsin: 'B000000004' }
  ]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.issues.map((x) => x.code), ['asin_url_mismatch', 'unobserved_histogram_claim', 'duplicate_source_id', 'cross_product_bsr_collision', 'image_asin_mismatch']);
});

it('parses ASINs from detail URLs and defaults artifacts to pending independent review', () => {
  assert.equal(asinFrom('https://www.amazon.com/dp/B012345678?color=black'), 'B012345678');
  assert.equal(newAuditRecord().status, '待独立审核');
  assert.equal(newAuditRecord().releaseAllowed, false);
  assert.deepEqual(newAuditRecord().gates, { facts: false, links: false, comments: false, conclusions: false });
});
