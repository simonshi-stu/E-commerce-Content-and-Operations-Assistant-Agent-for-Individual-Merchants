'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, it } = require('node:test');
const ExcelJS = require('exceljs');

const { assertRevision, assertTransition, normalizeBrief, normalizeTaskType } = require('../lib/report-schema');
const { analyzePdf, safePdfName, validatePdfFile } = require('../lib/pdf-catalog');
const { createReportJobs } = require('../lib/report-jobs');
const { calculateProductPricing } = require('../lib/pricing');
const { importMerchantTrialDraft } = require('../public/report-trial-import');
const costFixture = require('./fixtures/report-cost-catalog.json');
const merchantCostFixture = require('./fixtures/merchant-screenshot-cost-candidates.json');

function samplePdf(text = 'Enough helmet catalog text ABC-123 with CPSC report and ultralight road shell', contentsRef = true) {
  const body = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R${contentsRef ? ' /Contents 4 0 R' : ''} >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 12 Tf 72 720 Td (${text}) Tj ET
endstream endobj
5 0 obj << /Type /Page /Parent 2 0 R >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
  return Buffer.from(body, 'latin1');
}

function structuredPdf({ text = 'Ultralight road helmet ABC-123 with CPSC test report and washable liner', compressed = false, cid = false } = {}) {
  const content = cid ? '<00010002> Tj' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const stream = compressed ? zlib.deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const cmap = 'begincmap\n2 beginbfchar\n<0001> <5934>\n<0002> <76D4>\nendbfchar\nendcmap';
  const cmapStream = zlib.deflateSync(Buffer.from(cmap, 'latin1'));
  const parts = [];
  parts.push(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n', 'latin1'));
  parts.push(Buffer.from(`3 0 obj << /Type /Page /Parent 2 0 R${cid ? ' /Resources << /Font << /F1 5 0 R >> >>' : ''} /Contents 4 0 R >> endobj\n`, 'latin1'));
  parts.push(Buffer.from(`4 0 obj << /Length ${stream.length}${compressed ? ' /Filter /FlateDecode' : ''} >> stream\n`, 'latin1'), stream, Buffer.from('\nendstream endobj\n', 'latin1'));
  if (cid) {
    parts.push(Buffer.from('5 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >> endobj\n', 'latin1'));
    parts.push(Buffer.from(`6 0 obj << /Length ${cmapStream.length} /Filter /FlateDecode >> stream\n`, 'latin1'), cmapStream, Buffer.from('\nendstream endobj\n', 'latin1'));
  }
  parts.push(Buffer.from('trailer << /Root 1 0 R >>\n%%EOF', 'latin1'));
  return Buffer.concat(parts);
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'report-jobs-test-'));
}

function writePdf(root, name = 'catalog.pdf', buffer = samplePdf()) {
  const dir = path.join(root, 'source');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

describe('report schema', () => {
  it('allows the documented transitions and rejects invalid ones', () => {
    assert.doesNotThrow(() => assertTransition('uploaded', 'extracting'));
    assert.doesNotThrow(() => assertTransition('awaiting_confirmation', 'confirmed'));
    assert.doesNotThrow(() => assertTransition('completed', 'confirmed'));
    assert.doesNotThrow(() => assertTransition('failed', 'building'));
    assert.throws(() => assertTransition('uploaded', 'building'), (error) => error.code === 'invalid_state');
    assert.throws(() => assertTransition('completed', 'researching'), (error) => error.code === 'invalid_state');
  });

  it('rejects stale revisions and unsupported task types', () => {
    assert.doesNotThrow(() => assertRevision({ revision: 3 }, 3));
    assert.throws(() => assertRevision({ revision: 3 }, 2), (error) => error.code === 'revision_conflict');
    assert.throws(() => assertRevision({ revision: 3 }, 'x'), (error) => error.code === 'revision_conflict');
    assert.equal(normalizeTaskType('pdf_catalog'), 'pdf_catalog');
    assert.equal(normalizeTaskType('track_analysis'), 'track_analysis');
    assert.throws(() => normalizeTaskType('other'), (error) => error.code === 'invalid_task_type');
  });

  it('normalizes research briefs and caps fields', () => {
    const brief = normalizeBrief({
      category: '  helmet  ',
      country: 'US',
      researchQuestions: ['a', '', 'b', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'],
      marketGroups: [
        { label: 'commute', keywords: ['bike helmet', ''] },
        { id: 'g2', label: 'kids', keywords: ['kids helmet'] }
      ]
    });
    assert.equal(brief.category, 'helmet');
    assert.equal(brief.country, 'US');
    assert.equal(brief.researchQuestions.length, 12);
    assert.equal(brief.marketGroups.length, 2);
    assert.equal(brief.marketGroups[0].id, 'group-1');
    assert.deepEqual(brief.marketGroups[0].keywords, ['bike helmet']);
    assert.equal(brief.marketGroups[1].id, 'g2');
  });
});

describe('pdf catalog parsing', () => {
  it('sanitizes file names without path separators', () => {
    const safe = safePdfName('../../etc/passwd');
    assert.ok(!safe.includes('/'));
    assert.ok(!safe.includes('\\'));
    assert.equal(safePdfName(''), 'catalog.pdf');
  });

  it('validates magic bytes, mime type, and size', () => {
    const root = makeRoot();
    const filePath = writePdf(root);
    const size = fs.statSync(filePath).size;
    assert.equal(validatePdfFile(filePath, 'application/pdf', size).size, size);
    assert.throws(() => validatePdfFile(filePath, 'application/pdf', size + 1), (error) => error.code === 'invalid_pdf');
    assert.throws(() => validatePdfFile(filePath, 'text/plain', size), (error) => error.code === 'unsupported_media_type');
    const junk = path.join(root, 'junk.pdf');
    fs.writeFileSync(junk, 'not a pdf');
    assert.throws(() => validatePdfFile(junk, 'application/pdf'), (error) => error.code === 'pdf_magic_mismatch');
  });

  it('extracts text pages, categories, and candidate products', () => {
    const root = makeRoot();
    const filePath = writePdf(root);
    const analysis = analyzePdf(filePath);
    assert.equal(analysis.pageCount, 2);
    assert.equal(analysis.textMode, 'text');
    assert.equal(analysis.ocrRequired, false);
    assert.equal(analysis.categoryHypotheses[0].rulePackId, 'helmet-v1');
    assert.ok(analysis.categoryHypotheses[0].requiresManualConfirmation);
    assert.ok(analysis.productCandidates.length >= 1);
    assert.ok(analysis.productCandidates[0].missingFields.length > 0);
    assert.equal(analysis.pages.length, 2);
  });

  it('marks image-only PDFs as needing OCR without fabricating text', () => {
    const root = makeRoot();
    const filePath = writePdf(root, 'scan.pdf', samplePdf(''));
    const analysis = analyzePdf(filePath);
    assert.equal(analysis.textMode, 'scanned');
    assert.equal(analysis.ocrRequired, true);
    assert.ok(analysis.warnings.length >= 1);
  });

  it('extracts text from compressed streams and hex CID fonts with ToUnicode maps', () => {
    const root = makeRoot();
    const compressedPath = path.join(root, 'compressed.pdf');
    fs.writeFileSync(compressedPath, structuredPdf({ compressed: true }));
    const compressed = analyzePdf(compressedPath);
    assert.equal(compressed.textMode, 'text');
    assert.match(compressed.pages[0].text, /Ultralight road helmet ABC-123/);

    const cidPath = path.join(root, 'cid.pdf');
    fs.writeFileSync(cidPath, structuredPdf({ cid: true, compressed: true }));
    const cid = analyzePdf(cidPath);
    assert.match(cid.pages[0].text, /头盔/);
    assert.equal(cid.pageCount, 1);
  });

  it('falls back to stream scanning when page contents are missing', () => {
    const root = makeRoot();
    const filePath = writePdf(root, 'no-contents.pdf', samplePdf('Fallback helmet catalog ABC-999 with CPSC report', false));
    const analysis = analyzePdf(filePath);
    assert.equal(analysis.textMode, 'text');
    assert.match(analysis.pages[0].text, /Fallback helmet catalog ABC-999/);
  });

  it('extracts explicit price candidates from the local catalog fixture without confirming or rewriting the SKU', () => {
    const root = makeRoot();
    const sourcePath = path.join(__dirname, '..', costFixture.sourcePdf);
    const filePath = fs.existsSync(sourcePath)
      ? sourcePath
      : writePdf(root, 'cost-fixture-fallback.pdf', samplePdf(costFixture.pages.flat().join('\n')));
    const analysis = analyzePdf(filePath);
    const products = analysis.productCandidates;
    const ho022 = products.find((item) => item.model === 'HO-022');
    assert.ok(ho022, 'HO-022 is kept as printed; O/0 are never automatically substituted');
    assert.equal(ho022.fields.purchaseCostCandidate.amount, 16);
    assert.equal(ho022.fields.purchaseCostCandidate.currency, 'CNY');
    assert.equal(ho022.fields.purchaseCostCandidate.userConfirmed, false);
    assert.match(ho022.fields.purchaseCostCandidate.evidenceText, /出厂价16元|EXW 16 CNY/i);
    assert.equal(ho022.missingFields.includes('price'), false);
    assert.ok(ho022.missingFields.includes('purchaseCost.unit'));
    assert.ok(ho022.missingFields.includes('purchaseCost.incoterm'));
    assert.ok(ho022.missingFields.includes('purchaseCost.confirmation'));
    const amounts = new Map(products.map((item) => [item.model, item.fields.purchaseCostCandidate?.amount]));
    assert.equal(amounts.get('YB-96'), 40);
    assert.equal(amounts.get('HO-86'), 50);
  });

  it('keeps PRD screenshot price candidates separate by exact model and configuration, all unconfirmed', () => {
    assert.equal(merchantCostFixture.fixtureOnly, true);
    assert.equal(merchantCostFixture.manualConfirmationRequired, true);
    assert.deepEqual(merchantCostFixture.uniformSkuModels, ['H0-022', 'H0-196', 'YB-11', 'YB-19']);
    assert.equal(merchantCostFixture.skus.length, 16);
    const h086 = merchantCostFixture.skus.filter((item) => item.model === 'H0-86');
    assert.deepEqual(h086.map((item) => item.amount), [50, 58]);
    const yb16 = merchantCostFixture.skus.filter((item) => item.model === 'YB-16');
    assert.deepEqual(yb16.map((item) => item.amount), [48, 58, 55]);
    assert.match(yb16[1].priceStatement, /加充电灯10元即58元/);
    assert.notEqual(merchantCostFixture.skus[0].model, 'HO-022');
    assert.ok(merchantCostFixture.skus.every((item) => item.sourceLocation && !Object.hasOwn(item, 'confirmed')));
  });

  it('imports trial data as unconfirmed, configuration-specific rows without applying freight assumptions', () => {
    const draft = {
      sampleId: 'helmet-mvp-trial-2026-09-29', status: 'draft_for_build_session; not independently approved', createdAtLocal: '2026-09-29T20:08:00+08:00',
      uploadedProducts: [
        { productId: 'H0-022', printedModel: 'H0-022', sourceScreenshot: 'H0-022.jpg', sourcePath: 'E:\\外贸\\运动头盔调研\\H0-022.jpg',
          costOptions: [{ configuration: 'standard helmet, no light', candidateAmount: 16, currency: 'CNY', unit: 'per helmet' }],
          packagingEvidence: { primaryCarton: { unitsPerCarton: 20, dimensionsCm: [57, 46, 56], grossWeightKg: 7.6 } } },
        { productId: 'H0-86', printedModel: 'H0-86', sourceScreenshot: 'H0-86.png', sourcePath: 'E:\\外贸\\运动头盔调研\\H0-86.png',
          costOptions: [
            { configuration: 'helmet + magnetic visor/goggles, no rechargeable light', candidateAmount: 50, currency: 'CNY', unit: 'per helmet' },
            { configuration: 'helmet + magnetic visor/goggles + rechargeable light', candidateAmount: 58, currency: 'CNY', unit: 'per helmet' }
          ], packagingEvidence: { primaryCarton: { unitsPerCarton: 20, dimensionsCm: [61, 59, 47.5], grossWeightKg: 9.3 } } }
      ],
      competitorObservations: [{
        asin: 'B07W9KN18N', url: 'https://www.amazon.com/dp/B07W9KN18N?th=1', observedAtLocal: '2026-09-29T20:07:54+08:00',
        title: 'VICTGOAL Helmet', brand: 'VICTGOAL', selectedVariant: { size: 'L', light: 'rechargeable' },
        displayedPrice: { amount: 40.99, currency: 'USD', couponVisible: false, otherVisiblePromotion: 'No coupon shown' },
        matchedTargets: ['H0-86: helmet + magnetic visor/goggles + rechargeable light (58 CNY candidate)'],
        similarity: { status: 'similar', reason: 'Configuration match.' },
        imageEvidence: { screenshot: '.openchamber/screenshots/mvp-victgoal-pdp-live.jpg' },
        reviewPageObservation: { observedAtLocal: '2026-09-29T19:59+08:00' },
        reviewSamples: [{ stars: 5, title: 'Comfortable', reviewer: 'Reviewer', reviewId: 'R123', reviewUrl: 'https://www.amazon.com/gp/customer-reviews/R123?ASIN=B07W9KN18N',
          reviewDate: '2026-07-31', selectedReviewVariant: 'Large', englishOriginal: 'Original English.', chineseTranslation: '中文译文。', sourceStatus: 'visible' }],
        reviewCounts: { fourToFiveStarCaptured: 1, oneToThreeStarCaptured: 0 }, reviewGap: 'No low-star samples captured.'
      }],
      freightScenario: {
        source: 'Rate table not located.',
        h0022IllustrativeScenarioOnly: {
          selectedReferenceRate: { amount: 55.7, currency: 'CNY', status: 'A PRD example only; route applicability is unverified.' }
        }
      }
    };
    const imported = importMerchantTrialDraft(draft);
    assert.equal(imported.products.length, 3);
    assert.deepEqual(imported.products.map((product) => [product.model, product.cost.amount]), [['H0-022', 16], ['H0-86', 50], ['H0-86', 58]]);
    assert.notEqual(imported.products[0].model, 'HO-022');
    assert.equal(imported.products[0].shipping.illustrativeRatePerKg, 55.7);
    assert.equal(imported.products[0].shipping.rateOptions[0].candidateOnly, true);
    assert.equal(imported.products[0].shipping.rateOptions[0].routeEligible, false);
    assert.equal(imported.products[0].shipping.rateOptions[0].sourceLocation, '');
    assert.equal(imported.products[1].competitors.length, 0);
    const rechargeable = imported.products[2];
    assert.equal(rechargeable.batteryType, 'rechargeable');
    assert.equal(rechargeable.batteryTypeConfirmed, false);
    assert.equal(rechargeable.modelConfirmed, false);
    assert.equal(rechargeable.cost.confirmed, false);
    assert.equal(rechargeable.costEvidenceFile, null);
    assert.equal(rechargeable.shipping.volumetricDivisor, 5000);
    assert.deepEqual(rechargeable.shipping.rateOptions, []);
    assert.equal(rechargeable.shipping.rate.perKg, '');
    assert.equal(rechargeable.shipping.cartons[0].grossKg, 9.3);
    assert.equal(rechargeable.competitors.length, 1);
    assert.equal(rechargeable.competitors[0].sourceType, 'user_trial_draft');
    assert.equal(rechargeable.competitors[0].priceStatus, 'draft_unverified');
    assert.equal(rechargeable.competitors[0].matchConfirmed, false);
    assert.equal(rechargeable.competitors[0].reviewsVisible[0].text, 'Original English.');
    assert.equal(rechargeable.competitors[0].reviewsVisible[0].chineseTranslation, '中文译文。');
    assert.equal(imported.reviewCount, 1);
  });
});

describe('report job lifecycle', () => {
  function newService() {
    const root = makeRoot();
    return { root, service: createReportJobs({ root }) };
  }

  function createPdfJob(service, root) {
    const job = service.create({ taskType: 'pdf_catalog', brief: {} });
    const filePath = writePdf(root);
    service.attachPdf(job.jobId, { filePath, fileName: 'catalog.pdf', mimeType: 'application/pdf', size: fs.statSync(filePath).size });
    return service.get(job.jobId);
  }

  it('runs upload -> confirmation gate -> build -> preview', async () => {
    const { root, service } = newService();
    const job = createPdfJob(service, root);
    assert.equal(job.status, 'awaiting_confirmation');
    assert.equal(job.revision, 1);

    await assert.rejects(service.build(job.jobId, { revision: job.revision }), (error) => error.code === 'confirmation_required');
    await assert.rejects(service.research(job.jobId, { revision: job.revision }), (error) => error.code === 'confirmation_required');
    assert.throws(() => service.confirm(job.jobId, { revision: 99, corrections: {} }), (error) => error.code === 'revision_conflict');

    const confirmed = service.confirm(job.jobId, {
      revision: 1,
      corrections: { category: '骑行头盔', rulePackId: 'helmet-v1', researchBrief: { country: '美国', marketGroups: [{ label: '通勤', keywords: ['commute helmet'] }] } }
    });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.revision, 2);
    assert.equal(confirmed.analysis.categoryHypotheses[0].label, '骑行头盔');
    assert.equal(confirmed.analysis.categoryHypotheses[0].isUserConfirmed, true);
    assert.equal(confirmed.researchBrief.marketGroups.length, 1);

    await assert.rejects(service.research(job.jobId, { revision: 2 }), (error) => error.code === 'product_cost_confirmation_required');

    const built = await service.build(job.jobId, { revision: 2 });
    assert.equal(built.status, 'completed');
    assert.equal(built.buildVersion, 1);
    assert.equal(built.artifacts.length, 1);
    const artifact = built.artifacts[0];
    assert.ok(fs.existsSync(artifact.filePath));
    assert.ok(artifact.filePath.startsWith(path.join(root, 'tmp', 'report-jobs')));
    assert.ok(artifact.fileName.endsWith('.xlsx'));

    const preview = service.preview(job.jobId, artifact.workbookId, '', 1, 50);
    assert.equal(preview.jobId, job.jobId);
    assert.equal(preview.manifest.artifactId, artifact.artifactId);
    assert.equal(preview.manifest.sheetCount, 15);
    assert.ok(preview.sheet.cells.length > 0);
    assert.ok(preview.manifest.sheets.every((sheet) => !Object.hasOwn(sheet, 'cells')));
  });

  it('runs the catalog fixture through cost confirmation, real research-module wiring, comparable ASIN confirmation, and shared Excel pricing', async () => {
    const root = makeRoot();
    const sourcePath = path.join(__dirname, '..', costFixture.sourcePdf);
    const pdfPath = fs.existsSync(sourcePath)
      ? sourcePath
      : writePdf(root, 'cost-fixture-fallback.pdf', samplePdf(costFixture.pages.flat().join('\n')));
    const observedAt = '2026-09-29';
    const priceBands = { commuter: [16, 18, 20], road: [18, 21, 24] };
    const amazonResearch = async ({ queries }) => {
      const kind = queries[0].includes('road') ? 'road' : 'commuter';
      return {
        records: priceBands[kind].map((price, index) => {
          const asin = `B0000000${String(kind === 'road' ? index + 4 : index + 1).padStart(2, '0')}`;
          return {
            asin, url: `https://www.amazon.com/dp/${asin}`, title: `${kind} cycling helmet ${index + 1}`,
            brand: `Example ${kind}`, price, currency: 'USD', priceStatus: 'observed', selectedVariant: 'Matte Black / M',
            sourceType: 'amazon_public_product', pageStatus: 'parsed', observedAt
          };
        }),
        errors: [], provenance: { dataBasis: 'amazon_public_frontend', observedAt, queries }
      };
    };
    const service = createReportJobs({ root, amazonResearch });
    const job = service.create({ taskType: 'pdf_catalog', brief: { marketplace: 'Amazon.com' } });
    service.attachPdf(job.jobId, { filePath: pdfPath, fileName: 'regression-fixture.pdf', mimeType: 'application/pdf', size: fs.statSync(pdfPath).size });
    const parsed = service.get(job.jobId).analysis.productCandidates;
    assert.deepEqual(parsed.slice(0, 2).map((item) => item.model), ['YB-96', 'HO-022']);
    assert.deepEqual(parsed.slice(0, 2).map((item) => item.fields.purchaseCostCandidate.amount), [40, 16]);

    const feeAssumptions = {
      inboundPerUnit: 1.5, packagingPerUnit: 0.5, fulfillmentPerUnit: 5, referralRatePct: 15,
      adPerUnit: 1, adRatePct: 5, returnPerUnit: 0.5, returnRatePct: 2,
      taxPerUnit: 0, taxRatePct: 0, otherPerUnit: 0.25, discountRatePct: 0, couponFixed: 0, targetMarginPct: 20, confirmed: true
    };
    const shippingAssumptions = {
      volumetricDivisor: 6000, divisorConfirmed: true, confirmed: true,
      cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 50, widthCm: 40, heightCm: 30, grossKg: 8 }],
      rate: { perKg: 7.14, currency: 'CNY', channel: 'fixture scenario only', postalZone: '0-4', tier: 'below_23kg', routeEligible: true, fxToUSD: 0.14,
        fxDate: '2026-09-29 test fixture', magneticInspectionPerShipment: 0, magneticFeeApplicable: 'no', otherPerShipment: 0,
        batteryCompatible: false, confirmed: true, sourceLocation: 'fixture only; not a carrier quote' }
    };
    const confirmedProducts = parsed.slice(0, 2).map((product, index) => ({
      ...product, modelConfirmed: true,
      batteryType: 'none', batteryTypeConfirmed: true,
      researchKeywords: index === 1 ? 'road bike helmet adult lightweight' : 'adult commuter bike helmet visor light',
      cost: {
        amount: product.fields.purchaseCostCandidate.amount, currency: 'CNY', unit: 'CNY / piece',
        incoterm: 'EXW (user confirmed against supplier quote)', variant: product.model,
        fxToUSD: 0.14, fxDate: '2026-09-29, user supplied scenario rate', confirmed: true
      },
      shipping: structuredClone(shippingAssumptions),
      fees: { ...feeAssumptions }
    }));
    const firstConfirm = service.confirm(job.jobId, { revision: 1, corrections: { productCandidates: confirmedProducts } });
    assert.equal(firstConfirm.status, 'confirmed');
    await assert.doesNotReject(service.research(job.jobId, { revision: 2, delayMs: 0 }));
    const researched = service.get(job.jobId);
    assert.equal(researched.researchData.byProduct.length, 2);
    assert.equal(researched.researchData.byProduct[0].records.length, 3);

    const selectedProducts = researched.analysis.productCandidates.map((product) => {
      const evidence = researched.researchData.byProduct.find((entry) => entry.candidateId === product.candidateId);
      return {
        ...product,
        competitors: evidence.records.map((record) => ({
          ...record, similarity: 'similar', similarityReason: 'fixture scenario: same purpose, adult audience, and helmet configuration',
          variantLabel: record.selectedVariant, matchConfirmed: true
        }))
      };
    });
    const finalized = service.confirm(job.jobId, { revision: 2, corrections: { productCandidates: selectedProducts } });
    assert.equal(finalized.revision, 3);
    assert.deepEqual(finalized.pricingResults.map((row) => row.result.market.sampleCount), [3, 3]);
    assert.equal(finalized.pricingResults[0].result.status, 'not_recommended');
    assert.equal(finalized.pricingResults[0].result.recommendedListPrice, null);
    assert.equal(finalized.pricingResults[1].result.status, 'recommended');
    assert.ok(finalized.pricingResults[0].result.targetProfitListPrice > finalized.pricingResults[0].result.market.max);

    const built = await service.build(job.jobId, { revision: 3 });
    const artifact = built.artifacts[0];
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(artifact.filePath);
    const sheet = workbook.getWorksheet('06_逐款定价');
    assert.equal(sheet.getCell('X3').value.result, finalized.pricingResults[0].result.breakEvenListPrice);
    assert.equal(sheet.getCell('Y4').value.result, finalized.pricingResults[1].result.targetProfitListPrice);
    assert.match(sheet.getCell('X3').value.formula, /S3\/\(1-T3\)/);
    assert.match(sheet.getCell('AB4').value.formula, /AA4\*\(1-T4\)-S4/);
    assert.equal(workbook.getWorksheet('12_外箱明细').getCell('L2').value.result, 10);
    assert.equal(workbook.getWorksheet('12_外箱明细').getCell('V2').value.result, 10);
    assert.match(workbook.getWorksheet('12_外箱明细').getCell('J2').value.formula, /E2\*F2\*G2\/I2/);
    assert.equal(workbook.getWorksheet('14_运费敏感性').getCell('G2').value.result, 12);
    assert.equal(workbook.getWorksheet('14_运费敏感性').getCell('G3').value.result, 12);
    assert.equal(workbook.getWorksheet('14_运费敏感性').getCell('G4').value.result, 10);
    assert.equal(workbook.getWorksheet('14_运费敏感性').getCell('G5').value.result, 10);
    assert.equal(workbook.getWorksheet('11_空运计费').getCell('C2').value.result, 10);
    assert.equal(workbook.getWorksheet('11_空运计费').getCell('I2').value, 7.14);
    assert.equal(workbook.getWorksheet('09_用户产品与费用').getCell('M2').value, '');
    assert.match(workbook.getWorksheet('09_用户产品与费用').getCell('L2').value, /PDF p\./);
    const detail = built.artifacts[0].manifest.sheets.find((item) => item.name === '06_逐款定价');
    const targetPreviewCell = detail.cells.find((cell) => cell.address === 'Y4');
    assert.equal(Number(targetPreviewCell.value), finalized.pricingResults[1].result.targetProfitListPrice);
  });

  it('creates a no-PDF manual screenshot job, saves private product evidence, and keeps H0 separate from HO', async () => {
    const root = makeRoot();
    const service = createReportJobs({ root, amazonResearch: async ({ queries }) => ({
      records: [], errors: [{ stage: 'search', query: queries[0], code: 'http_status', status: 503, message: 'Amazon page unavailable.' }]
    }) });
    const job = service.create({ taskType: 'track_analysis', brief: { category: 'Cycling helmets', marketplace: 'Amazon.com' } });
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const manualCandidate = merchantCostFixture.skus.find((item) => item.model === 'H0-022');
    const confirmed = service.confirm(job.jobId, {
      revision: 1,
      corrections: {
        productCandidates: [{
          candidateId: 'screenshot-H0-022', model: manualCandidate.model, displayName: manualCandidate.configuration,
          modelConfirmed: true, researchKeywords: 'adult road bike helmet', batteryType: 'none', batteryTypeConfirmed: true,
          fields: { purchaseCostCandidate: { amount: manualCandidate.amount, currency: 'CNY', sourceType: 'user_screenshot_candidate' } },
          cost: {
            amount: manualCandidate.amount, currency: 'CNY', unit: 'CNY/piece', incoterm: 'EXW (manual candidate)',
            variant: manualCandidate.configuration, fxToUSD: 0.14, fxDate: '2026-09-29 scenario rate',
            sourceLocation: `E:\\外贸\\运动头盔调研\\${manualCandidate.sourceLocation}`, confirmed: true
          },
          costEvidenceDataUrl: `data:image/png;base64,${image}`,
          fees: {}
        }]
      }
    });
    const saved = confirmed.analysis.productCandidates[0].cost;
    assert.equal(confirmed.analysis.productCandidates[0].model, 'H0-022');
    assert.equal(saved.amount, 16);
    assert.equal(saved.sourceType, 'user_screenshot');
    assert.match(saved.evidencePath, /^evidence\//);
    assert.ok(fs.existsSync(path.join(job.jobDir, saved.evidencePath)));
    assert.equal(saved.sourceLocation, `E:\\外贸\\运动头盔调研\\${manualCandidate.sourceLocation}`);
    await service.research(job.jobId, { revision: 2, delayMs: 0 });
    const researched = service.get(job.jobId);
    assert.equal(researched.researchData.byProduct[0].status, 'partial');
    assert.equal(researched.researchData.byProduct[0].records.length, 0);
    assert.equal(researched.researchData.byProduct[0].errors[0].status, 503);
  });

  it('saves a draft trial with screenshot evidence references, bilingual reviews, and no recommended profit', async () => {
    const root = makeRoot();
    const service = createReportJobs({ root });
    const job = service.create({ taskType: 'track_analysis', brief: { category: 'Cycling helmets', marketplace: 'Amazon.com' } });
    const draft = {
      sampleId: 'helmet-mvp-trial-2026-09-29', status: 'draft_for_build_session; not independently approved', createdAtLocal: '2026-09-29T20:08:00+08:00',
      uploadedProducts: [{
        productId: 'H0-022', printedModel: 'H0-022', sourceScreenshot: 'H0-022.jpg', sourcePath: 'E:\\外贸\\运动头盔调研\\H0-022.jpg',
        costOptions: [{ configuration: 'standard helmet, no light', candidateAmount: 16, currency: 'CNY', unit: 'per helmet' }],
        packagingEvidence: { primaryCarton: { unitsPerCarton: 20, dimensionsCm: [57, 46, 56], grossWeightKg: 7.6 } }
      }],
      competitorObservations: [{
        asin: 'B0FTS7RHR3', url: 'https://www.amazon.com/dp/B0FTS7RHR3?th=1', observedAtLocal: '2026-09-29T20:07:58+08:00',
        title: 'ROCKBROS', brand: 'ROCKBROS', selectedVariant: { color: 'Black Matte', size: 'Large' },
        displayedPrice: { amount: 45.99, currency: 'USD', couponVisible: false, otherVisiblePromotion: 'No coupon shown' },
        matchedTargets: ['H0-022'], similarity: { status: 'similar', reason: 'Adult no-light cycling helmet.' },
        imageEvidence: { screenshot: '.openchamber/screenshots/mvp-rockbros-pdp-live.jpg' },
        reviewPageObservation: { observedAtLocal: '2026-09-29T19:57+08:00' },
        reviewSamples: [{ stars: 1, title: 'Tight fit', reviewer: 'Joe F', reviewId: 'R3IZX2ZGJ3NI2I',
          reviewUrl: 'https://www.amazon.com/gp/customer-reviews/R3IZX2ZGJ3NI2I?ASIN=B0FTS7RHR3', reviewDate: '2026-05-20',
          selectedReviewVariant: 'Black Matte, Large', englishOriginal: 'Original review.', chineseTranslation: '原文翻译。', sourceStatus: 'direct review page readable' }],
        reviewCounts: { fourToFiveStarCaptured: 2, oneToThreeStarCaptured: 1 }, reviewGap: ''
      }], freightScenario: {
        source: 'No carrier tariff attached.',
        h0022IllustrativeScenarioOnly: {
          selectedReferenceRate: { amount: 55.7, currency: 'CNY', status: 'PRD example only; no verified eligible route.' }
        }
      }
    };
    const imported = importMerchantTrialDraft(draft);
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const product = imported.products[0];
    product.costEvidenceRef = 'same-image';
    product.competitors[0].screenshotEvidenceRef = 'same-image';
    const confirmed = service.confirm(job.jobId, { revision: 1, corrections: {
      productCandidates: imported.products, evidenceLibrary: { 'same-image': `data:image/png;base64,${image}` }
    } });
    const savedProduct = confirmed.analysis.productCandidates[0];
    assert.equal(savedProduct.model, 'H0-022');
    assert.equal(savedProduct.modelConfirmed, false);
    assert.equal(savedProduct.cost.confirmed, false);
    assert.equal(savedProduct.cost.sourceType, 'user_screenshot');
    assert.equal(savedProduct.cost.evidencePath, savedProduct.competitors[0].screenshotPath);
    assert.equal(savedProduct.shipping.rateOptions[0].perKg, 55.7);
    assert.equal(savedProduct.shipping.rateOptions[0].candidateOnly, true);
    assert.equal(savedProduct.shipping.rateOptions[0].routeEligible, false);
    assert.equal(savedProduct.shipping.rateOptions[0].sourceLocation, '');
    assert.equal(savedProduct.shipping.rate.perKg, null);
    assert.equal(savedProduct.competitors[0].sourceType, 'user_screenshot');
    assert.equal(savedProduct.competitors[0].priceStatus, 'user_evidence');
    assert.equal(savedProduct.competitors[0].matchConfirmed, false);
    assert.equal(savedProduct.competitors[0].observedAt, '2026-09-29T20:07:58+08:00');
    assert.equal(savedProduct.competitors[0].reviewsVisible[0].text, 'Original review.');
    assert.equal(savedProduct.competitors[0].reviewsVisible[0].chineseTranslation, '原文翻译。');
    assert.equal(savedProduct.shipping.rate.perKg, null);
    assert.equal(Object.hasOwn(confirmed.corrections, 'evidenceLibrary'), false);
    assert.equal(JSON.stringify(confirmed.corrections).includes(image), false);
    assert.equal(fs.readdirSync(path.join(job.jobDir, 'evidence')).length, 1, 'same image bytes are stored once');

    const result = confirmed.pricingResults[0].result;
    assert.equal(result.status, 'incomplete');
    assert.equal(result.recommendedListPrice, null);
    assert.equal(result.profitAtRecommendation, null);
    assert.equal(result.airFreight.selectedRateOption, null);
    assert.equal(result.freightSensitivity.illustrativeExample.base.freightPerUnit, 83.55);
    assert.equal(result.freightSensitivity.illustrativeExample.withMagneticPressure.freightPerUnit, 107.55);
    const built = await service.build(job.jobId, { revision: 2 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(built.artifacts[0].filePath);
    assert.equal(workbook.worksheets.length, 10);
    assert.ok(built.artifacts[0].filePath.startsWith(path.join(root, 'reports')));
    assert.ok(built.artifacts[0].manifestPath.startsWith(path.join(job.jobDir, 'outputs')));
    assert.match(workbook.getWorksheet('00_一页简报').getCell('A1').value, /Amazon 美国站头盔市场准入审阅稿/);
    assert.equal(workbook.getWorksheet('03_配置准入判断').getCell('J4').value, '待补证（非通过/非否决）');
    assert.equal(workbook.getWorksheet('04_PDP证据').getCell('D4').value, 'US$45.99');
    assert.equal(workbook.getWorksheet('04_PDP证据').getCell('A4').value.hyperlink, 'https://www.amazon.com/dp/B0FTS7RHR3?th=1');
    assert.equal(workbook.getWorksheet('09_运费条件情景').getCell('E4').value, 55.7);
    assert.equal(workbook.getWorksheet('09_运费条件情景').getCell('H4').value.result, 1671);
    assert.equal(workbook.getWorksheet('05_评论原文与译文').getCell('G4').value, 'Original review.');
    assert.equal(workbook.getWorksheet('05_评论原文与译文').getCell('H4').value, '原文翻译。');
    assert.equal(workbook.getWorksheet('05_评论原文与译文').getCell('J4').value.hyperlink, 'https://www.amazon.com/gp/customer-reviews/R3IZX2ZGJ3NI2I?ASIN=B0FTS7RHR3');
    assert.equal(workbook.getWorksheet('06_成本与费用').getCell('C4').value, 16);
    assert.equal(workbook.getWorksheet('06_成本与费用').getCell('G4').value, '');
    assert.equal(workbook.getWorksheet('06_逐款定价'), undefined);
    assert.equal(workbook.getWorksheet('02_供应配置图卡').getImages().length, 1);
    assert.equal(workbook.getWorksheet('04_PDP证据').getImages().length, 1);
    assert.equal(workbook.getWorksheet('02_研究设置'), undefined);
    assert.equal(workbook.getWorksheet('03_市场分组'), undefined);
    const productPreview = service.preview(job.jobId, built.artifacts[0].workbookId, 'sheet-3', 1, 120);
    assert.equal(productPreview.sheet.imageEvidence.length, 1);
    assert.match(productPreview.sheet.imageEvidence[0].imageUrl, /\/api\/reports\/jobs\/.*\/evidence\//);
    const competitorPreview = service.preview(job.jobId, built.artifacts[0].workbookId, 'sheet-5', 1, 120);
    assert.equal(competitorPreview.sheet.cells.find((cell) => cell.address === 'A4').hyperlink, 'https://www.amazon.com/dp/B0FTS7RHR3?th=1');
    assert.match(workbook.getWorksheet('08_包装外箱追溯').getCell('J4').value.formula, /I4\/5000/);
  });

  it('keeps preview and download bound to the current revision and build version', async () => {
    const { root, service } = newService();
    const job = createPdfJob(service, root);
    service.confirm(job.jobId, { revision: 1, corrections: {} });
    const built = await service.build(job.jobId, { revision: 2 });
    const artifact = built.artifacts[0];

    service.recordAudit(job.jobId, {
      action: 'return', reviewer: 'Reviewer', reviewerSessionId: 'separate-review-session',
      revision: 2, buildVersion: 1, gates: {}, issues: ['请更正品类名称']
    });
    service.confirm(job.jobId, {
      revision: 2, corrections: { category: 'changed' }, repairNotes: '按来源更正品类。',
      actorSessionId: job.producer.sessionId
    });
    assert.equal(service.get(job.jobId).revision, 3);
    assert.throws(
      () => service.preview(job.jobId, artifact.workbookId, '', 1, 50),
      (error) => error.code === 'artifact_version_mismatch'
    );

    assert.throws(
      () => service.preview('missing-job', artifact.workbookId, '', 1, 50),
      (error) => error.code === 'job_not_found'
    );
    assert.throws(
      () => service.preview(job.jobId, '../../etc', '', 1, 50),
      (error) => error.code === 'artifact_not_found'
    );
  });

  it('creates track analysis jobs waiting for confirmation with low confidence rules', () => {
    const { service } = newService();
    const job = service.create({ taskType: 'track_analysis', brief: { category: '内衣' } });
    assert.equal(job.status, 'awaiting_confirmation');
    assert.equal(job.analysis.categoryHypotheses[0].rulePackId, 'unknown-v1');
    assert.equal(job.analysis.categoryHypotheses[0].requiresManualConfirmation, true);
    assert.equal(job.analysis.productCandidates.length, 0);
  });

  it('persists a workbook manifest matching the generated XLSX', async () => {
    const { root, service } = newService();
    const job = createPdfJob(service, root);
    service.confirm(job.jobId, { revision: 1, corrections: {} });
    const built = await service.build(job.jobId, { revision: 2 });
    const artifact = built.artifacts[0];

    const manifest = JSON.parse(fs.readFileSync(artifact.manifestPath, 'utf8'));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(artifact.filePath);
    assert.equal(manifest.sheetCount, workbook.worksheets.length);
    const names = workbook.worksheets.map((sheet) => sheet.name);
    assert.deepEqual(manifest.sheets.map((sheet) => sheet.name), names);
    assert.equal(manifest.jobId, job.jobId);
    assert.equal(manifest.revision, built.revision);
    assert.equal(manifest.buildVersion, built.buildVersion);
    assert.equal(manifest.artifactId, artifact.artifactId);
    assert.ok(manifest.sheets[0].frozenRows >= 1);
  });

  it('requires independent gated review and a producer repair before release', async () => {
    const { root, service } = newService();
    const job = service.create({
      taskType: 'track_analysis', brief: { category: 'helmet' },
      producerName: 'Maker', producerSessionId: 'producer-session'
    });
    service.confirm(job.jobId, { revision: 1, corrections: {} });
    const firstBuild = await service.build(job.jobId, { revision: 2 });
    assert.equal(firstBuild.audit.status, '待独立审核');
    assert.equal(firstBuild.audit.releaseAllowed, false);

    assert.throws(() => service.recordAudit(job.jobId, {
      action: 'approve', reviewer: 'Another name', reviewerSessionId: 'producer-session',
      revision: 2, buildVersion: 1, gates: { facts: true, links: true, comments: true, conclusions: true }, issues: []
    }), (error) => error.code === 'self_audit_forbidden');
    assert.throws(() => service.recordAudit(job.jobId, {
      action: 'approve', reviewer: 'Reviewer', reviewerSessionId: 'review-session',
      revision: 2, buildVersion: 1, gates: { facts: true }, issues: []
    }), (error) => error.code === 'audit_gates_incomplete');

    const returned = service.recordAudit(job.jobId, {
      action: 'return', reviewer: 'Reviewer One', reviewerSessionId: 'review-session',
      revision: 2, buildVersion: 1, gates: { facts: true }, issues: ['请核对 ASIN 与商品页链接']
    });
    assert.equal(returned.audit.status, '退回纠错');
    assert.equal(returned.audit.checkedAt, returned.auditHistory[0].checkedAt);
    assert.equal(returned.audit.releaseAllowed, false);
    assert.throws(() => service.recordAudit(job.jobId, {
      action: 'approve', reviewer: 'Reviewer Two', reviewerSessionId: 'review-session-2',
      revision: 2, buildVersion: 1, gates: { facts: true, links: true, comments: true, conclusions: true }, issues: []
    }), (error) => error.code === 'audit_returned_requires_rebuild');
    assert.throws(() => service.confirm(job.jobId, {
      revision: 2, corrections: {}, repairNotes: '已修正'
    }), (error) => error.code === 'repair_producer_required');
    assert.throws(() => service.confirm(job.jobId, {
      revision: 2, corrections: {}, actorSessionId: 'producer-session'
    }), (error) => error.code === 'repair_notes_required');

    const repaired = service.confirm(job.jobId, {
      revision: 2, corrections: {}, repairNotes: '已逐条重核 ASIN 与链接。', actorSessionId: 'producer-session'
    });
    assert.equal(repaired.status, 'confirmed');
    assert.equal(repaired.auditHistory.length, 2);
    const secondBuild = await service.build(job.jobId, { revision: 3 });
    assert.equal(secondBuild.buildVersion, 2);
    assert.equal(secondBuild.audit.status, '待独立审核');
    assert.equal(secondBuild.auditHistory.length, 2);
    assert.throws(() => service.recordAudit(job.jobId, {
      action: 'approve', reviewer: 'Reviewer Two', reviewerSessionId: 'review-session-2',
      revision: 3, buildVersion: 1, gates: { facts: true, links: true, comments: true, conclusions: true }, issues: []
    }), (error) => error.code === 'audit_version_mismatch');

    const approved = service.recordAudit(job.jobId, {
      action: 'approve', reviewer: 'Reviewer Two', reviewerSessionId: 'review-session-2',
      revision: 3, buildVersion: 2, gates: { facts: true, links: true, comments: true, conclusions: true }, issues: []
    });
    assert.equal(approved.audit.status, '独立审核通过');
    assert.equal(approved.audit.releaseAllowed, true);
    assert.ok(Number.isFinite(Date.parse(approved.audit.checkedAt)));
    assert.equal(approved.auditHistory.length, 3);
    assert.throws(() => service.confirm(job.jobId, { revision: 3, corrections: {} }), (error) => error.code === 'review_return_required');
    assert.ok(fs.existsSync(secondBuild.artifacts[0].filePath));
  });
});
