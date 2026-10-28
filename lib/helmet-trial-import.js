'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolvePrivatePath(sourceRoot, inputPath, { allowMissing = false } = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) fail('invalid_image_path', 'Evidence image path is empty.');
  const root = path.resolve(sourceRoot);
  const candidate = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
  if (!isInside(root, candidate)) fail('invalid_image_path', 'Evidence image path escapes the private source directory.');
  let resolved = candidate;
  if (fs.existsSync(candidate)) {
    resolved = fs.realpathSync(candidate);
    const realRoot = fs.realpathSync(root);
    if (!isInside(realRoot, resolved)) fail('invalid_image_path', 'Evidence image resolves outside the private source directory.');
  } else if (!allowMissing) {
    fail('evidence_image_missing', `Evidence image does not exist: ${path.basename(candidate)}`);
  }
  return resolved;
}

function imageExtension(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) fail('invalid_image_type', 'Only PNG and JPEG source screenshots are supported.');
  return extension === '.jpeg' ? '.jpg' : extension;
}

function validateImageBuffer(buffer, extension) {
  const valid = extension === '.png'
    ? buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      && buffer.indexOf(Buffer.from([0xff, 0xd9]), 3) >= 0;
  if (!valid) fail('invalid_image_content', 'Screenshot bytes do not match the declared PNG/JPEG type.');
}

function copyPrivateScreenshot({ sourceRoot, sourcePath, jobDir, label, cache, allowMissing = false }) {
  if (!sourcePath) {
    if (allowMissing) return { path: '', fileName: '', sha256: '', sourcePath: '', status: 'screenshot_not_recorded' };
    fail('evidence_image_missing', `${label} has no source screenshot path.`);
  }
  const resolved = resolvePrivatePath(sourceRoot, sourcePath, { allowMissing });
  if (!fs.existsSync(resolved)) {
    return { path: '', fileName: path.basename(resolved), sha256: '', sourcePath: String(sourcePath), status: 'screenshot_file_missing' };
  }
  const extension = imageExtension(resolved);
  const buffer = fs.readFileSync(resolved);
  validateImageBuffer(buffer, extension);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (cache.has(sha256)) return { ...cache.get(sha256), sourcePath: String(sourcePath) };
  const evidenceRoot = path.join(jobDir, 'evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const safeLabel = String(label || 'image').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'image';
  const fileName = `${safeLabel}-${sha256.slice(0, 16)}${extension}`;
  const destination = path.join(evidenceRoot, fileName);
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, buffer, { flag: 'wx' });
  const saved = {
    path: `evidence/${fileName}`,
    fileName,
    sha256,
    sourcePath: String(sourcePath),
    status: 'copied_and_signature_checked'
  };
  cache.set(sha256, saved);
  return saved;
}

function amazonUrl(value, asin) {
  try {
    const url = new URL(String(value || ''));
    return ['amazon.com', 'www.amazon.com', 'smile.amazon.com'].includes(url.hostname.toLowerCase())
      && /^\/dp\/[A-Z0-9]{10}(?:\/|$)/i.test(url.pathname)
      && url.pathname.match(/^\/dp\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() === String(asin || '').toUpperCase()
      ? url.href : '';
  } catch { return ''; }
}

function amazonReviewUrl(value, asin) {
  try {
    const url = new URL(String(value || ''));
    const queryAsin = String(url.searchParams.get('ASIN') || '').toUpperCase();
    return ['amazon.com', 'www.amazon.com', 'smile.amazon.com'].includes(url.hostname.toLowerCase())
      && ['http:', 'https:'].includes(url.protocol)
      && /^\/gp\/customer-reviews\/[A-Z0-9]+/i.test(url.pathname)
      && queryAsin === String(asin || '').toUpperCase() ? url.href : '';
  } catch { return ''; }
}

function normalizePdp(record, kind, context) {
  const asin = String(record.asin || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) fail('invalid_asin', `Invalid ASIN in private PDP source: ${asin || '(empty)'}`);
  const url = amazonUrl(record.url, asin);
  if (!url) fail('invalid_pdp_url', `PDP URL does not point to the recorded ASIN ${asin}.`);
  const price = record.price || {};
  const amount = Number(price.amount);
  const displayedText = String(price.displayedText || '').trim();
  const displayedAmount = Number(displayedText.replace(/[^0-9.]/g, ''));
  if (!(amount > 0) || String(price.currency || '').toUpperCase() !== 'USD'
    || !displayedText || Math.round(displayedAmount * 100) !== Math.round(amount * 100)) {
    fail('pdp_price_mismatch', `PDP price text and numeric USD price do not match for ${asin}.`);
  }
  const selectedVariant = record.selectedVariant;
  if (!selectedVariant || typeof selectedVariant !== 'object' || !Object.keys(selectedVariant).length) {
    fail('pdp_variant_missing', `No selected-variant record for ${asin}.`);
  }
  const observedAtLocal = String(record.pdpObservedAtLocal || '');
  if (!observedAtLocal.startsWith('2026-09-29')) fail('pdp_observation_date_invalid', `PDP observation date is not 2026-09-29 for ${asin}.`);
  const rating = record.rating || {};
  const ratingValue = Number(rating.value);
  const ratingCount = Number(rating.count);
  if (!(ratingValue > 0 && ratingValue <= 5) || !(ratingCount >= 0)) fail('pdp_rating_invalid', `Invalid rating/count record for ${asin}.`);
  const screenshot = copyPrivateScreenshot({
    sourceRoot: context.sourceRoot,
    sourcePath: record.screenshot?.path || '',
    jobDir: context.jobDir,
    label: `pdp-${asin}`,
    cache: context.imageCache,
    allowMissing: true
  });
  return {
    asin,
    brand: String(record.brand || ''),
    title: String(record.title || ''),
    url,
    observationKind: kind,
    observedAtLocal,
    selectedVariant,
    price: {
      amount,
      currency: 'USD',
      displayedText,
      listPrice: Number(price.listPrice ?? price.typicalPrice) > 0 ? Number(price.listPrice ?? price.typicalPrice) : null,
      couponStatus: String(price.couponStatus || ''),
      otherPromotion: String(price.otherPromotion || '')
    },
    rating: { value: ratingValue, count: ratingCount },
    monthlyBoughtLabel: String(record.salesSignals?.monthlyBoughtLabel || ''),
    bsrText: String(record.salesSignals?.bsrText || ''),
    bsrStatus: String(record.salesSignals?.bsrStatus || ''),
    mainImageUrl: String(record.mainImageUrl || ''),
    screenshotPath: screenshot.path,
    screenshotSourcePath: String(record.screenshot?.path || ''),
    screenshotFileName: screenshot.fileName,
    screenshotSha256: screenshot.sha256,
    screenshotStatus: screenshot.status,
    matchedTargets: Array.isArray(record.matchedTargets) ? record.matchedTargets.map(String) : [],
    matchLevel: String(record.matchLevel || ''),
    matchReason: String(record.matchReason || ''),
    reviewStatus: String(record.reviewStatus || '')
  };
}

function normalizeReviews(parent, supplement) {
  const rows = [];
  const seen = new Set();
  let omittedIncomplete = 0;
  const append = (asin, sample, observedAtLocal, sourceDocument) => {
    const original = String(sample.englishOriginal || sample.englishOriginalExcerpt || '').trim();
    const translation = String(sample.chineseTranslation || sample.chineseTranslationExcerpt || '').trim();
    if (!original || !translation) {
      omittedIncomplete += 1;
      return;
    }
    const reviewId = String(sample.reviewId || '').trim();
    const reviewUrl = amazonReviewUrl(sample.reviewUrl, asin);
    if (!reviewId || !reviewUrl) fail('invalid_review_source', `Review source is missing a valid Amazon review ID/URL for ${asin}.`);
    const rating = Number(sample.stars ?? sample.rating);
    if (!(rating >= 1 && rating <= 5)) fail('invalid_review_rating', `Review rating is invalid for ${asin}/${reviewId}.`);
    if (seen.has(reviewId)) return;
    seen.add(reviewId);
    rows.push({
      asin,
      reviewId,
      reviewUrl,
      rating,
      title: String(sample.title || ''),
      reviewer: String(sample.reviewer || ''),
      date: String(sample.reviewDate || sample.date || ''),
      observedAtLocal: String(observedAtLocal || ''),
      selectedVariant: String(sample.selectedReviewVariant || ''),
      englishOriginal: original,
      chineseTranslation: translation,
      textKind: sample.englishOriginalExcerpt || sample.chineseTranslationExcerpt ? '原文摘录及对应译文' : '已保存原文及译文',
      sourceStatus: String(sample.sourceStatus || '来源状态待独立复核'),
      note: String(sample.note || ''),
      sourceDocument
    });
  };
  for (const observation of parent.competitorObservations || []) {
    const pageTime = observation.reviewPageObservation?.observedAtLocal || observation.observedAtLocal || '';
    for (const sample of observation.reviewSamples || []) append(observation.asin, sample, pageTime, 'MVP_头盔竞品与定价试采_2026-09-29.json');
  }
  for (const group of supplement.reviewSupplements || []) {
    for (const sample of group.samples || []) append(group.asin, sample, group.reviewPageObservedAtLocal || '', 'MVP_头盔竞品实时复核增补_2026-09-29.json');
  }
  return { rows, omittedIncomplete };
}

function importHelmetTrialEvidence({ parent, supplement, sourceRoot, jobDir, sourceFiles = {}, jobId, reportBuildDate = '2026-09-30' }) {
  if (!parent || !Array.isArray(parent.uploadedProducts) || !Array.isArray(parent.competitorObservations)) {
    fail('invalid_parent_trial', 'The parent 2026-09-29 helmet trial JSON is incomplete.');
  }
  if (!supplement?.liveSweep || !Array.isArray(supplement.pdpRechecks) || !Array.isArray(supplement.newPdpObservations)) {
    fail('invalid_pdp_supplement', 'The 2026-09-29 PDP supplement is incomplete.');
  }
  if (!sourceRoot || !jobDir) fail('private_import_paths_required', 'A private source root and ignored temporary job directory are required.');
  fs.mkdirSync(jobDir, { recursive: true });
  const imageCache = new Map();
  const supplierScreenshots = new Map();
  const sourceProducts = [];
  const products = [];

  for (const sourceProduct of parent.uploadedProducts) {
    const model = String(sourceProduct.printedModel || sourceProduct.productId || '').trim();
    const configurations = Array.isArray(sourceProduct.costOptions) ? sourceProduct.costOptions : [];
    if (!model || !configurations.length) fail('supplier_candidate_missing', 'Each supplier model must include a model name and at least one priced configuration.');
    const screenshot = copyPrivateScreenshot({
      sourceRoot,
      sourcePath: String(sourceProduct.sourcePath || sourceProduct.sourceScreenshot || ''),
      jobDir,
      label: `supplier-${model}`,
      cache: imageCache,
      allowMissing: false
    });
    supplierScreenshots.set(model, screenshot);
    const packaging = sourceProduct.packagingEvidence?.primaryCarton || {};
    const dimensions = Array.isArray(packaging.dimensionsCm) && packaging.dimensionsCm.length === 3
      ? packaging.dimensionsCm.map(Number) : [];
    const imported = {
      model,
      screenshotName: String(sourceProduct.sourceScreenshot || path.basename(sourceProduct.sourcePath || '')),
      screenshotPath: screenshot.path,
      screenshotSha256: screenshot.sha256,
      screenshotStatus: screenshot.status,
      sourceFileModifiedLocal: String(sourceProduct.sourceFileModifiedLocal || ''),
      descriptionFromScreenshot: String(sourceProduct.productDescriptionFromScreenshot || ''),
      packaging: {
        unitsPerCarton: Number(packaging.unitsPerCarton) > 0 ? Number(packaging.unitsPerCarton) : null,
        dimensionsCm: dimensions.length === 3 && dimensions.every((value) => value > 0) ? dimensions : [],
        netWeightKg: Number(packaging.netWeightKg) > 0 ? Number(packaging.netWeightKg) : null,
        grossWeightKg: Number(packaging.grossWeightKg) > 0 ? Number(packaging.grossWeightKg) : null,
        otherScreenshotOptions: Array.isArray(sourceProduct.packagingEvidence?.otherScreenshotOptions)
          ? sourceProduct.packagingEvidence.otherScreenshotOptions.map(String) : [],
        status: String(sourceProduct.packagingEvidence?.status || '截图箱规候选；待供应商核实')
      },
      costOptions: []
    };
    configurations.forEach((option, index) => {
      const amount = Number(option.candidateAmount);
      const currency = String(option.currency || '').toUpperCase();
      if (!(amount > 0) || !/^[A-Z]{3}$/.test(currency)) fail('supplier_cost_candidate_invalid', `Invalid screenshot cost candidate for ${model}.`);
      const configuration = String(option.configuration || `configuration ${index + 1}`).trim();
      const candidateId = `private-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index + 1}`;
      const item = {
        candidateId,
        displayName: `${model} · ${configuration}`,
        model,
        modelConfirmed: false,
        categoryId: 'cycling-helmet',
        confidence: 0.5,
        productDescriptionFromScreenshot: imported.descriptionFromScreenshot,
        sourceScreenshot: imported.screenshotName,
        sourceFileModifiedLocal: imported.sourceFileModifiedLocal,
        packagingEvidence: imported.packaging,
        trialImport: {
          sampleId: String(parent.sampleId || ''),
          kind: 'private_helmet_market_access_v2',
          importedStatus: String(parent.status || 'private working evidence; not independently approved'),
          independentReviewStatus: '待独立审核；未通过，不开放交付'
        },
        cost: {
          amount,
          currency,
          unit: String(option.unit || 'per helmet'),
          variant: configuration,
          incoterm: '',
          fxToUSD: null,
          fxDate: '',
          confirmed: false,
          sourceType: 'user_screenshot_candidate',
          sourceLocation: `${imported.screenshotName} / ${configuration}`,
          evidencePath: screenshot.path,
          evidenceSha256: screenshot.sha256,
          evidenceText: String(option.manualConfirmation || option.sourceWording || '供应截图/候选 JSON 转录；正式报价条款待核。')
        },
        fees: {},
        shipping: {},
        batteryType: /button[- ]cell/i.test(configuration) ? 'button_cell'
          : /rechargeable/i.test(configuration) ? 'rechargeable'
            : /light|led/i.test(configuration) ? 'unknown' : 'none',
        batteryTypeConfirmed: false,
        competitors: []
      };
      products.push(item);
      imported.costOptions.push({ configuration, amount, currency, unit: item.cost.unit, candidateId, screenshotPath: screenshot.path, screenshotSha256: screenshot.sha256 });
    });
    sourceProducts.push(imported);
  }

  const parentAsins = new Set((parent.competitorObservations || []).map((item) => String(item.asin || '').toUpperCase()));
  const recheckIds = supplement.pdpRechecks.map((item) => String(item.asin || '').toUpperCase());
  const newIds = supplement.newPdpObservations.map((item) => String(item.asin || '').toUpperCase());
  if (new Set(recheckIds).size !== recheckIds.length || new Set(newIds).size !== newIds.length) fail('duplicate_supplement_asin', 'The supplement contains duplicate ASIN records.');
  if (recheckIds.some((asin) => !parentAsins.has(asin))) fail('pdp_recheck_not_in_parent', 'Every recheck must match an ASIN already recorded in the parent trial.');
  if (newIds.some((asin) => parentAsins.has(asin) || recheckIds.includes(asin))) fail('pdp_new_asin_not_new', 'A record marked new already exists in the parent or recheck set.');
  const declared = supplement.liveSweep;
  if (Number(declared.previouslyRecordedAsinsRechecked) !== recheckIds.length
    || Number(declared.newDistinctAsins) !== newIds.length) fail('supplement_declared_count_mismatch', 'Supplement counts do not match the actual recheck/new PDP records.');

  const parentPdpByAsin = new Map((parent.competitorObservations || []).map((record) => [String(record.asin || '').toUpperCase(), record]));
  const pdps = [
    ...supplement.pdpRechecks.map((record) => {
      const previous = parentPdpByAsin.get(String(record.asin || '').toUpperCase()) || {};
      return normalizePdp({
        ...previous,
        ...record,
        url: record.url || previous.url,
        title: record.title || previous.title,
        brand: record.brand || previous.brand,
        mainImageUrl: record.mainImageUrl || previous.imageEvidence?.mainImageUrl || '',
        matchedTargets: record.matchedTargets || previous.matchedTargets || [],
        matchReason: record.matchReason || previous.similarity?.reason || ''
      }, '复查既有 ASIN', { sourceRoot, jobDir, imageCache });
    }),
    ...supplement.newPdpObservations.map((record) => normalizePdp(record, '新增 ASIN', { sourceRoot, jobDir, imageCache }))
  ];
  const uniqueAsins = new Set(pdps.map((item) => item.asin));
  if (uniqueAsins.size !== pdps.length || Number(declared.combinedDistinctAsins) !== uniqueAsins.size) {
    fail('supplement_unique_asin_count_mismatch', 'The merged supplement ASIN count does not match its declared distinct count.');
  }
  const pdpAsins = new Set(pdps.map((item) => item.asin));
  for (const coverage of supplement.configurationCoverage || []) {
    for (const asin of coverage.sharedComparatorAsins || []) {
      if (!pdpAsins.has(String(asin).toUpperCase())) fail('coverage_asin_missing', `Configuration coverage references an unimported PDP ASIN: ${asin}.`);
    }
  }

  const reviewResult = normalizeReviews(parent, supplement);
  const sourceDocuments = Object.entries(sourceFiles).map(([role, item]) => ({
    role,
    fileName: String(item.fileName || ''),
    sha256: String(item.sha256 || ''),
    status: String(item.status || 'private source; not independently approved')
  }));
  const id = jobId || `report-private-helmet-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const modelCount = new Set(sourceProducts.map((item) => item.model)).size;
  const configurationCount = products.length;
  const validationReport = {
    importedAt: new Date().toISOString(),
    parentSampleId: String(parent.sampleId || ''),
    supplementId: String(supplement.supplementId || ''),
    parentModelCount: modelCount,
    configurationCount,
    supplierScreenshotUniqueCount: new Set(sourceProducts.map((item) => item.screenshotSha256)).size,
    supplierScreenshotMissingCount: sourceProducts.filter((item) => !item.screenshotPath).length,
    newPdpCount: supplement.newPdpObservations.length,
    recheckedPdpCount: supplement.pdpRechecks.length,
    distinctPdpCount: uniqueAsins.size,
    pdpScreenshotsAvailableCount: pdps.filter((item) => item.screenshotPath).length,
    pdpScreenshotsMissingCount: pdps.filter((item) => !item.screenshotPath).length,
    reviewCount: reviewResult.rows.length,
    reviewAsinCount: new Set(reviewResult.rows.map((item) => item.asin)).size,
    reviewRecordsOmittedForMissingOriginalOrTranslation: reviewResult.omittedIncomplete,
    sourceDocuments
  };
  const helmetEvidence = {
    kind: 'private_helmet_market_access_v2',
    reportBuildDate,
    evidenceObservationDate: '2026-09-29',
    independentReviewStatus: '待独立审核',
    parentSampleId: String(parent.sampleId || ''),
    supplementId: String(supplement.supplementId || ''),
    parentStatus: String(parent.status || ''),
    supplementStatus: String(supplement.status || ''),
    marketplace: String(supplement.marketplace || parent.marketplace || 'Amazon.com US public frontend'),
    timezone: String(supplement.timezone || 'Asia/Shanghai'),
    sweepWindowLocal: String(supplement.liveSweep.pdpReadWindowLocal || ''),
    screenshotWindowLocal: String(supplement.liveSweep.screenshotWindowLocal || ''),
    parentSourceName: String(sourceFiles.parent?.fileName || 'MVP_头盔竞品与定价试采_2026-09-29.json'),
    supplementSourceName: String(sourceFiles.supplement?.fileName || 'MVP_头盔竞品实时复核增补_2026-09-29.json'),
    sourceDocuments,
    products: sourceProducts,
    pdps,
    configurationCoverage: Array.isArray(supplement.configurationCoverage) ? supplement.configurationCoverage : [],
    reviews: reviewResult.rows,
    omittedIncompleteReviewCount: reviewResult.omittedIncomplete,
    limitations: [...(parent.openIssues || []), ...(supplement.limitations || [])],
    freightScenario: parent.freightScenario || {},
    pricingState: parent.pricingState || {},
    validationReport
  };
  const job = {
    jobId: id,
    workbookId: `workbook-${id}`,
    taskType: 'track_analysis',
    status: 'completed',
    revision: 1,
    buildVersion: 2,
    jobDir: path.resolve(jobDir),
    producer: { name: '本地私有证据导入构建', sessionId: `private-build-${crypto.randomUUID()}` },
    audit: { status: '待独立审核', releaseAllowed: false, reviewer: '', checkedAt: '' },
    auditHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    analysis: { productCandidates: products },
    helmetEvidence,
    artifacts: []
  };
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({ ...job, jobDir: '.' }, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(jobDir, 'validation.json'), JSON.stringify(validationReport, null, 2), { flag: 'wx' });
  return { job, validationReport };
}

module.exports = { importHelmetTrialEvidence, resolvePrivatePath, validateImageBuffer };
