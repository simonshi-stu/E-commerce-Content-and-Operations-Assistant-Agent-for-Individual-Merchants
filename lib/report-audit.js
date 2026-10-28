'use strict';

function asinFrom(value) {
  const text = String(value || '');
  return text.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || '';
}

function auditEvidence(records = []) {
  const issues = [];
  const ids = new Map();
  const bsr = new Map();
  records.forEach((item, index) => {
    const row = index + 1;
    if (item.sourceId) {
      if (ids.has(item.sourceId)) issues.push({ code: 'duplicate_source_id', rows: [ids.get(item.sourceId), row], value: item.sourceId });
      else ids.set(item.sourceId, row);
    }
    const linkedAsin = asinFrom(item.url);
    if (item.asin && linkedAsin && item.asin.toUpperCase() !== linkedAsin) issues.push({ code: 'asin_url_mismatch', row, asin: item.asin, linkedAsin });
    if (item.bsr) {
      const key = String(item.bsr).trim();
      if (bsr.has(key) && bsr.get(key).asin !== item.asin) issues.push({ code: 'cross_product_bsr_collision', rows: [bsr.get(key).row, row], value: key });
      else bsr.set(key, { row, asin: item.asin });
    }
    if (item.histogramClaim && !item.histogramObserved) issues.push({ code: 'unobserved_histogram_claim', row });
    if (item.imageAsin && item.asin && item.imageAsin !== item.asin) issues.push({ code: 'image_asin_mismatch', row, asin: item.asin, imageAsin: item.imageAsin });
  });
  return { passed: issues.length === 0, issues };
}

function newAuditRecord(producer = {}, version = {}) {
  return {
    status: '待独立审核',
    producer: producer.name || '制作者',
    producerSessionId: producer.sessionId || '',
    reviewer: '',
    reviewerSessionId: '',
    checkedAt: '',
    revision: version.revision || 0,
    buildVersion: version.buildVersion || 0,
    issues: [],
    gates: { facts: false, links: false, comments: false, conclusions: false },
    releaseAllowed: false
  };
}

module.exports = { asinFrom, auditEvidence, newAuditRecord };
