'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const ExcelJS = require('exceljs');

const { importHelmetTrialEvidence, resolvePrivatePath } = require('../lib/helmet-trial-import');
const { buildHelmetMarketWorkbook, configurationPriceSamples, sourceEvidenceFile } = require('../lib/helmet-market-workbook');
const { buildManifest } = require('../lib/workbook-preview');

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'helmet-private-build-test-'));
}

function makeSource(root) {
  const sourceRoot = path.join(root, 'private-source');
  const jobDir = path.join(root, 'private-task');
  fs.mkdirSync(path.join(sourceRoot, 'screens'), { recursive: true });
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'supplier.png'), onePixelPng);
  fs.writeFileSync(path.join(sourceRoot, 'screens', 'pdp-a.png'), onePixelPng);
  fs.writeFileSync(path.join(sourceRoot, 'screens', 'pdp-b.png'), onePixelPng);
  const parent = {
    sampleId: 'fixture-private-parent',
    status: 'private working evidence; not independently approved',
    uploadedProducts: [{
      productId: 'MODEL-1', printedModel: 'MODEL-1', sourceScreenshot: 'supplier.png', sourcePath: 'supplier.png',
      productDescriptionFromScreenshot: 'Adult cycling helmet; supplier screenshot text only.',
      costOptions: [{ configuration: 'standard helmet, no light', candidateAmount: 10, currency: 'CNY', unit: 'per helmet' }],
      packagingEvidence: { primaryCarton: { unitsPerCarton: 10, dimensionsCm: [40, 30, 20], grossWeightKg: 5, netWeightKg: 4, status: 'screenshot carton candidate' } }
    }],
    competitorObservations: [{
      asin: 'AAAAAAAAAA',
      reviewPageObservation: { observedAtLocal: '2026-09-29T19:00:00+08:00' },
      reviewSamples: [{
        reviewId: 'REVIEW123', reviewUrl: 'https://www.amazon.com/gp/customer-reviews/REVIEW123?ASIN=AAAAAAAAAA',
        stars: 5, title: 'Actual review', reviewer: 'Reviewer', reviewDate: '2026-09-20',
        englishOriginal: 'Actual source review.', chineseTranslation: '實際來源評論。', sourceStatus: 'Visible card; pending independent review.'
      }]
    }],
    freightScenario: {}
  };
  const pdp = (asin, price, file, brand) => ({
    asin,
    brand,
    title: `${brand} selected helmet variant`,
    url: `https://www.amazon.com/dp/${asin}?th=1`,
    pdpObservedAtLocal: '2026-09-29T23:45:00+08:00',
    selectedVariant: { color: 'Black', size: 'Large', configuration: 'no light' },
    price: { amount: price, currency: 'USD', displayedText: `$${price.toFixed(2)}`, couponStatus: 'No coupon label visible' },
    rating: { value: 4.5, count: 20 },
    salesSignals: { monthlyBoughtLabel: null, bsrText: null, bsrStatus: 'Not visible' },
    screenshot: { path: `screens/${file}` }
  });
  const supplement = {
    supplementId: 'fixture-supplement', status: 'private and not approved', marketplace: 'Amazon.com US public frontend',
    liveSweep: { newDistinctAsins: 1, previouslyRecordedAsinsRechecked: 1, combinedDistinctAsins: 2 },
    pdpRechecks: [pdp('AAAAAAAAAA', 20, 'pdp-a.png', 'Existing brand')],
    newPdpObservations: [pdp('BBBBBBBBBB', 30, 'pdp-b.png', 'New brand')],
    configurationCoverage: [
      { targets: ['MODEL-1'], configuration: 'adult standard cycling helmet, no light', sharedComparatorAsins: ['AAAAAAAAAA'], coverage: 'One similar PDP for the same selected configuration.' },
      { targets: ['MODEL-1'], configuration: 'adult standard cycling helmet, no light', sharedComparatorAsins: ['BBBBBBBBBB'], coverage: 'One adjacent feature reference; not an exact match.' }
    ],
    reviewSupplements: [],
    limitations: []
  };
  return { sourceRoot, jobDir, parent, supplement };
}

function importFixture(root, edit) {
  const source = makeSource(root);
  if (edit) edit(source);
  const imported = importHelmetTrialEvidence({
    ...source,
    sourceFiles: {
      parent: { fileName: 'private-parent-fixture.json', sha256: crypto.createHash('sha256').update('parent').digest('hex') },
      supplement: { fileName: 'private-supplement-fixture.json', sha256: crypto.createHash('sha256').update('supplement').digest('hex') }
    },
    jobId: 'report-private-fixture',
    reportBuildDate: '2026-09-30'
  });
  return { ...source, ...imported };
}

describe('private helmet trial import and workbook', () => {
  it('imports counts dynamically, embeds supplier/PDP images, and excludes adjacent prices from configuration samples', async () => {
    const root = fixtureRoot();
    try {
      const { job, validationReport } = importFixture(root);
      assert.equal(validationReport.parentModelCount, 1);
      assert.equal(validationReport.configurationCount, 1);
      assert.equal(validationReport.recheckedPdpCount, 1);
      assert.equal(validationReport.newPdpCount, 1);
      assert.equal(validationReport.distinctPdpCount, 2);
      assert.equal(validationReport.pdpScreenshotsAvailableCount, 2);
      assert.equal(validationReport.reviewCount, 1);
      assert.equal(job.helmetEvidence.evidenceObservationDate, '2026-09-29');
      assert.equal(job.helmetEvidence.reportBuildDate, '2026-09-30');

      const product = job.analysis.productCandidates[0];
      const eligible = configurationPriceSamples(product, job.helmetEvidence.pdps, job.helmetEvidence.configurationCoverage);
      assert.deepEqual(eligible.map((item) => item.pdp.asin), ['AAAAAAAAAA']);
      assert.equal(eligible.some((item) => item.pdp.asin === 'BBBBBBBBBB'), false);

      const outDir = path.join(root, 'build');
      const artifact = await buildHelmetMarketWorkbook(job, outDir, { buildManifest });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(artifact.filePath);
      assert.equal(workbook.worksheets.length, 10);
      assert.equal(workbook.getWorksheet('02_研究设置'), undefined);
      assert.equal(workbook.getWorksheet('03_市场分组'), undefined);
      assert.equal(workbook.getWorksheet('02_供应配置图卡').getImages().length, 1);
      assert.equal(workbook.getWorksheet('04_PDP证据').getImages().length, 2);
      assert.match(String(workbook.getWorksheet('03_配置准入判断').getCell('D4').value), /AAAAAAAAAA/);
      assert.doesNotMatch(String(workbook.getWorksheet('03_配置准入判断').getCell('D4').value), /BBBBBBBBBB/);
      assert.match(String(workbook.getWorksheet('03_配置准入判断').getCell('E4').value), /BBBBBBBBBB/);
      assert.equal(workbook.getWorksheet('04_PDP证据').getCell('K4').value, '');
      assert.equal(workbook.getWorksheet('04_PDP证据').getCell('J5').value, 20);
      assert.equal(workbook.getWorksheet('05_评论原文与译文').rowCount, 4, 'no synthetic empty/low-star review rows');
      assert.equal(workbook.getWorksheet('05_评论原文与译文').getCell('G4').value, 'Actual source review.');
      assert.equal(workbook.getWorksheet('05_评论原文与译文').getCell('H4').value, '實際來源評論。');
      const analysis = workbook.getWorksheet('01_逐款优劣分析');
      assert.equal(analysis.rowCount, 4, 'analysis is at candidate configuration level');
      assert.match(String(analysis.getCell('D4').value), /4\.5★\/20/);
      assert.match(String(analysis.getCell('D4').value), /月购标签未记录/);
      assert.match(String(analysis.getCell('I4').value), /尚未证明/);
      assert.doesNotMatch(String(analysis.getCell('I4').value), /灯具配置可能|lamp feature/);
      const costSheet = workbook.getWorksheet('06_成本与费用');
      assert.equal(costSheet.getCell('C4').value, 10);
      for (const column of ['G', 'H', 'I', 'J', 'K', 'L']) assert.equal(costSheet.getCell(`${column}4`).value, '');
      assert.equal(costSheet.getCell('G4').value?.formula, undefined);
      assert.match(String(costSheet.getCell('N4').value), /不计算/);
      assert.equal(artifact.manifest.sheets.find((sheet) => sheet.name === '04_PDP证据').imageEvidence.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an unavailable PDP screenshot explicitly missing instead of inventing an image', () => {
    const root = fixtureRoot();
    try {
      const { job, validationReport } = importFixture(root, ({ supplement }) => {
        supplement.newPdpObservations[0].screenshot.path = 'screens/not-captured.jpg';
      });
      assert.equal(validationReport.pdpScreenshotsAvailableCount, 1);
      assert.equal(validationReport.pdpScreenshotsMissingCount, 1);
      assert.equal(job.helmetEvidence.pdps[1].screenshotPath, '');
      assert.equal(job.helmetEvidence.pdps[1].screenshotStatus, 'screenshot_file_missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('honours a per-ASIN adjacent decision even when its coverage group is broadly labelled similar', () => {
    const root = fixtureRoot();
    try {
      const { job } = importFixture(root, ({ supplement }) => {
        supplement.configurationCoverage[0].asinDecisions = {
          AAAAAAAAAA: { relation: '邻近/附件不匹配', reason: 'Selected PDP has a removable visor absent from the supplier screenshot.' }
        };
      });
      const product = job.analysis.productCandidates[0];
      const eligible = configurationPriceSamples(product, job.helmetEvidence.pdps, job.helmetEvidence.configurationCoverage);
      assert.deepEqual(eligible, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or invalid image paths and refuses mismatched price text', () => {
    const root = fixtureRoot();
    try {
      const source = makeSource(root);
      assert.throws(() => resolvePrivatePath(source.sourceRoot, '../outside.jpg'), (error) => error.code === 'invalid_image_path');
      const { job } = importFixture(root);
      assert.throws(() => sourceEvidenceFile(job, 'evidence/../../outside.jpg'), (error) => error.code === 'invalid_image_path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const otherRoot = fixtureRoot();
    try {
      assert.throws(() => importFixture(otherRoot, ({ supplement }) => {
        supplement.newPdpObservations[0].price.displayedText = '$31.00';
      }), (error) => error.code === 'pdp_price_mismatch');
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
