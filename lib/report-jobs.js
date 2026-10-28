'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { analyzePdf, validatePdfFile } = require('./pdf-catalog');
const { assertRevision, assertTransition, normalizeBrief, normalizeTaskType, text } = require('./report-schema');
const { buildWorkbookArtifacts } = require('./workbook-preview');
const { newAuditRecord } = require('./report-audit');
const { researchPublicAmazon } = require('./amazon-research');
const { calculateProductPricing } = require('./pricing');

function now() { return new Date().toISOString(); }

function publicJob(job) {
  return {
    jobId: job.jobId, taskType: job.taskType, status: job.status, revision: job.revision,
    buildVersion: job.buildVersion, workbookId: job.workbookId, progress: job.progress,
    analysis: job.analysis, researchBrief: job.researchBrief, corrections: job.corrections,
    researchData: job.researchData || null, pricingResults: job.pricingResults || [],
    artifacts: job.artifacts, producer: job.producer, audit: job.audit || newAuditRecord(job.producer),
    auditHistory: job.auditHistory || [], error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt
  };
}

const TRANSIENT_STATES = new Set(['uploaded', 'extracting', 'researching', 'scoring', 'building']);

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

function screenshotBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw Object.assign(new Error('Comparable evidence must be a PNG, JPEG, or WebP screenshot.'), { code: 'invalid_screenshot' });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw Object.assign(new Error('Screenshot evidence is empty.'), { code: 'invalid_screenshot' });
  if (buffer.length > MAX_SCREENSHOT_BYTES) throw Object.assign(new Error('Screenshot evidence exceeds 5 MB.'), { code: 'upload_too_large' });
  const valid = match[1] === 'png' ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'jpeg' ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9
      : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw Object.assign(new Error('Screenshot file signature does not match its image type.'), { code: 'invalid_screenshot' });
  return { buffer, extension: match[1] === 'jpeg' ? 'jpg' : match[1] };
}

function saveEvidenceImage(job, dataUrl, prefix, existingPath = '') {
  if (dataUrl) {
    const image = screenshotBuffer(dataUrl);
    const sha256 = crypto.createHash('sha256').update(image.buffer).digest('hex');
    job.evidenceByHash ||= new Map();
    if (job.evidenceByHash.has(sha256)) return { ...job.evidenceByHash.get(sha256) };
    const evidenceDir = path.join(job.jobDir, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const fileName = `${prefix}-${crypto.randomUUID()}.${image.extension}`;
    const absolutePath = path.join(evidenceDir, fileName);
    fs.writeFileSync(absolutePath, image.buffer, { flag: 'wx' });
    const saved = {
      path: path.relative(job.jobDir, absolutePath).replace(/\\/g, '/'),
      sha256
    };
    job.evidenceByHash.set(sha256, saved);
    return saved;
  }
  if (!/^evidence\/[a-zA-Z0-9_-]+\.(?:png|jpg|webp)$/.test(String(existingPath || ''))) return { path: '', sha256: '' };
  const absolutePath = path.resolve(job.jobDir, existingPath);
  const evidenceRoot = path.resolve(job.jobDir, 'evidence') + path.sep;
  if (!absolutePath.startsWith(evidenceRoot) || !fs.existsSync(absolutePath)) return { path: '', sha256: '' };
  return { path: existingPath, sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex') };
}

function cleanCompetitor(item = {}, job, candidateId, model, index, evidenceLibrary = {}) {
  let url = text(item.url, 1_000);
  let asin = text(item.asin, 10).toUpperCase();
  const screenshotDataUrl = item.screenshotDataUrl || evidenceLibrary[item.screenshotEvidenceRef] || '';
  const savedScreenshot = saveEvidenceImage(job, screenshotDataUrl, candidateId, item.screenshotPath);
  const screenshotPath = savedScreenshot.path;
  const screenshotSha256 = savedScreenshot.sha256;
  const similarity = ['similar', 'adjacent', 'not_comparable'].includes(item.similarity) ? item.similarity : 'unreviewed';
  const expectedQuery = String(job.analysis?.productCandidates?.find((product) => product.candidateId === candidateId)?.researchKeywords
    || job.researchBrief.marketGroups.flatMap((group) => group.keywords)[0] || '').trim();
  const productResearch = (job.researchData?.byProduct || []).find((result) => result.candidateId === candidateId
    && result.researchedModel === model && result.query === expectedQuery);
  const observation = productResearch?.records
    ?.find((record) => record.asin === asin && record.sourceType === 'amazon_public_product' && record.pageStatus === 'parsed' && record.priceStatus === 'observed');
  const sourceType = observation
    ? 'amazon_public_product' : screenshotPath ? 'user_screenshot' : 'user_entered';
  if (observation) {
    url = observation.url;
    asin = observation.asin;
  }
  let safeUrl = false;
  try {
    const parsedUrl = new URL(url);
    safeUrl = ['amazon.com', 'www.amazon.com', 'smile.amazon.com'].includes(parsedUrl.hostname.toLowerCase()) && ['http:', 'https:'].includes(parsedUrl.protocol);
  } catch { /* invalid or incomplete evidence link */ }
  return {
    competitorId: text(item.competitorId, 80) || `${candidateId}-competitor-${index + 1}`,
    asin, url: safeUrl ? url : '', title: text(observation?.title || item.title, 240), brand: text(observation?.brand || item.brand, 120),
    selectedVariant: text(observation?.selectedVariant || item.selectedVariant, 240), variantLabel: text(item.variantLabel || item.selectedVariant || observation?.selectedVariant, 240),
    price: observation ? Number(observation.price) : item.price === '' || item.price === null || item.price === undefined ? null : Number(item.price),
    currency: observation?.currency || text(item.currency, 3).toUpperCase() || 'USD',
    coupon: text(observation?.coupon || item.coupon, 160), observedAt: text(observation?.observedAt || item.observedAt, 40),
    similarity, similarityReason: text(item.similarityReason, 1_000), matchConfirmed: item.matchConfirmed === true,
    sourceType, pageStatus: sourceType === 'amazon_public_product' ? 'parsed' : (screenshotPath ? 'user_provided' : text(item.pageStatus, 40)),
    priceStatus: observation ? 'observed' : item.price === '' || item.price === null || item.price === undefined ? 'not_provided'
      : screenshotPath && safeUrl ? 'user_evidence' : 'unverified',
    screenshotPath, screenshotSha256,
    screenshotReference: text(item.screenshotReference, 500),
    sourceNote: text(item.sourceNote, 1_000),
    observedSource: sourceType === 'amazon_public_product' ? 'Amazon public product detail page'
      : screenshotPath && safeUrl ? 'User-provided screenshot' : 'Unverified user entry',
    reviewsVisible: Array.isArray(item.reviewsVisible) ? item.reviewsVisible.slice(0, 12).map((review) => ({
      rating: Number(review.rating), title: text(review.title, 180), text: text(review.text, 2_000),
      reviewId: text(review.reviewId, 120), reviewUrl: text(review.reviewUrl, 1_000), date: text(review.date, 180),
      observedAt: text(review.observedAt, 100), chineseTranslation: text(review.chineseTranslation, 2_000),
      reviewer: text(review.reviewer, 180), selectedReviewVariant: text(review.selectedReviewVariant, 240),
      sourceStatus: text(review.sourceStatus, 500), note: text(review.note, 1_000)
    })) : [],
    reviewDataStatus: text(item.reviewDataStatus, 80) || 'not_fetched',
    reviewGap: text(item.reviewGap, 1_000), reviewCounts: item.reviewCounts && typeof item.reviewCounts === 'object' ? item.reviewCounts : {},
    importedSimilarityStatus: text(item.importedSimilarityStatus, 80)
  };
}

function confirmedProducts(candidates = [], job, evidenceLibrary = {}) {
  return (Array.isArray(candidates) ? candidates : []).slice(0, 100).map((item, index) => {
    const candidateId = text(item.candidateId, 80).replace(/[^a-zA-Z0-9_-]/g, '') || `candidate-${index + 1}`;
    const { costEvidenceDataUrl, costEvidenceRef, costEvidenceFile, ...candidateInput } = item;
    const cost = item.cost && typeof item.cost === 'object' ? item.cost : {};
    const fees = item.fees && typeof item.fees === 'object' ? item.fees : {};
    const shippingInput = item.shipping && typeof item.shipping === 'object' ? item.shipping : {};
    const rateInput = shippingInput.rate && typeof shippingInput.rate === 'object' ? shippingInput.rate : {};
    const competitors = (Array.isArray(item.competitors) ? item.competitors : []).slice(0, 20)
      .map((competitor, competitorIndex) => cleanCompetitor(competitor, job, candidateId, text(item.model, 80), competitorIndex, evidenceLibrary));
    const savedCostEvidence = saveEvidenceImage(job, costEvidenceDataUrl || evidenceLibrary[costEvidenceRef], `${candidateId}-cost`, cost.evidencePath);
    const savedRateEvidence = saveEvidenceImage(job, rateInput.evidenceDataUrl || evidenceLibrary[rateInput.evidenceRef], `${candidateId}-freight`, rateInput.evidencePath);
    const nullableNumber = (value) => value === '' || value === undefined || value === null ? null : Number(value);
    return {
      ...candidateInput,
      candidateId,
      displayName: text(item.displayName, 240),
      model: text(item.model, 80),
      modelConfirmed: item.modelConfirmed === true,
      researchKeywords: text(item.researchKeywords, 300),
      premiumRationale: text(item.premiumRationale, 1_000),
      cost: {
        amount: cost.amount === '' || cost.amount === undefined ? null : Number(cost.amount),
        currency: text(cost.currency, 3).toUpperCase(), unit: text(cost.unit, 100),
        incoterm: text(cost.incoterm, 100), variant: text(cost.variant, 180),
        fxToUSD: cost.fxToUSD === '' || cost.fxToUSD === undefined ? null : Number(cost.fxToUSD),
        fxDate: text(cost.fxDate, 100), confirmed: cost.confirmed === true,
        sourcePageNumber: Number(item.fields?.purchaseCostCandidate?.sourcePageNumber || item.sourcePageNumbers?.[0] || 0),
        evidenceText: text(item.fields?.purchaseCostCandidate?.evidenceText, 240),
        sourceLocation: text(cost.sourceLocation, 240),
        evidencePath: savedCostEvidence.path,
        evidenceSha256: savedCostEvidence.sha256,
        sourceType: savedCostEvidence.path ? 'user_screenshot'
          : item.fields?.purchaseCostCandidate?.sourceType === 'user_screenshot_candidate' ? 'user_screenshot_candidate'
            : item.fields?.purchaseCostCandidate ? 'pdf_extraction_candidate' : 'user_entered'
      },
      shipping: {
        volumetricDivisor: nullableNumber(shippingInput.volumetricDivisor),
        divisorConfirmed: shippingInput.divisorConfirmed === true,
        confirmed: shippingInput.confirmed === true,
        cartons: (Array.isArray(shippingInput.cartons) ? shippingInput.cartons : []).slice(0, 30).map((carton) => ({
          cartonCount: nullableNumber(carton.cartonCount), unitsPerCarton: nullableNumber(carton.unitsPerCarton),
          lengthCm: nullableNumber(carton.lengthCm), widthCm: nullableNumber(carton.widthCm), heightCm: nullableNumber(carton.heightCm), grossKg: nullableNumber(carton.grossKg)
        })),
        rateOptions: (Array.isArray(shippingInput.rateOptions) ? shippingInput.rateOptions : []).slice(0, 30).map((option) => ({
          perKg: nullableNumber(option.perKg), currency: text(option.currency, 3).toUpperCase() || 'CNY',
          channel: text(option.channel, 160), postalZone: text(option.postalZone, 20), tier: text(option.tier, 30),
          routeEligible: option.routeEligible === true, batteryCompatible: option.batteryCompatible === true,
          candidateOnly: option.candidateOnly === true && option.routeEligible !== true,
          sourceLocation: text(option.sourceLocation, 240)
        })),
        rate: {
          perKg: nullableNumber(rateInput.perKg), currency: text(rateInput.currency, 3).toUpperCase() || 'CNY',
          channel: text(rateInput.channel, 160), postalZone: text(rateInput.postalZone, 20), tier: text(rateInput.tier, 30),
          fxToUSD: nullableNumber(rateInput.fxToUSD), fxDate: text(rateInput.fxDate, 100),
          magneticInspectionPerShipment: nullableNumber(rateInput.magneticInspectionPerShipment), otherPerShipment: nullableNumber(rateInput.otherPerShipment),
          magneticFeeApplicable: ['yes', 'no', 'unknown'].includes(rateInput.magneticFeeApplicable) ? rateInput.magneticFeeApplicable : 'unknown',
          routeEligible: rateInput.routeEligible === true, batteryCompatible: rateInput.batteryCompatible === true, confirmed: rateInput.confirmed === true,
          sourceLocation: text(rateInput.sourceLocation, 240), evidencePath: savedRateEvidence.path, evidenceSha256: savedRateEvidence.sha256
        }
      },
      batteryType: ['none', 'button_cell', 'rechargeable'].includes(item.batteryType) ? item.batteryType : 'unknown',
      batteryTypeConfirmed: item.batteryTypeConfirmed === true,
      fees: {
        ...fees,
        inboundPerUnit: fees.inboundPerUnit === '' || fees.inboundPerUnit === undefined ? null : Number(fees.inboundPerUnit),
        packagingPerUnit: fees.packagingPerUnit === '' || fees.packagingPerUnit === undefined ? null : Number(fees.packagingPerUnit),
        fulfillmentPerUnit: fees.fulfillmentPerUnit === '' || fees.fulfillmentPerUnit === undefined ? null : Number(fees.fulfillmentPerUnit),
        referralRatePct: fees.referralRatePct === '' || fees.referralRatePct === undefined ? null : Number(fees.referralRatePct),
        adPerUnit: fees.adPerUnit === '' || fees.adPerUnit === undefined ? null : Number(fees.adPerUnit),
        adRatePct: fees.adRatePct === '' || fees.adRatePct === undefined ? null : Number(fees.adRatePct),
        returnPerUnit: fees.returnPerUnit === '' || fees.returnPerUnit === undefined ? null : Number(fees.returnPerUnit),
        returnRatePct: fees.returnRatePct === '' || fees.returnRatePct === undefined ? null : Number(fees.returnRatePct),
        taxPerUnit: fees.taxPerUnit === '' || fees.taxPerUnit === undefined ? null : Number(fees.taxPerUnit),
        taxRatePct: fees.taxRatePct === '' || fees.taxRatePct === undefined ? null : Number(fees.taxRatePct),
        otherPerUnit: fees.otherPerUnit === '' || fees.otherPerUnit === undefined ? null : Number(fees.otherPerUnit),
        discountRatePct: fees.discountRatePct === '' || fees.discountRatePct === undefined ? null : Number(fees.discountRatePct),
        couponFixed: fees.couponFixed === '' || fees.couponFixed === undefined ? null : Number(fees.couponFixed),
        targetMarginPct: fees.targetMarginPct === '' || fees.targetMarginPct === undefined ? null : Number(fees.targetMarginPct),
        confirmed: fees.confirmed === true
      },
      competitors
    };
  });
}

function costConfirmationErrors(candidates = []) {
  return candidates.filter((item) => !item.model || item.modelConfirmed !== true
    || !item.cost || item.cost.confirmed !== true || !(Number(item.cost.amount) > 0)
    || !/^[A-Z]{3}$/.test(item.cost.currency || '') || !item.cost.unit || !item.cost.incoterm
    || !item.cost.variant || !(Number(item.cost.fxToUSD) > 0)
    || (item.cost.currency !== 'USD' && !item.cost.fxDate)
    || !(item.cost.evidencePath || (item.sourcePageNumbers?.length && item.fields?.purchaseCostCandidate?.sourceType !== 'user_screenshot_candidate')));
}

function createReportJobs({ root, amazonResearch = researchPublicAmazon }) {
  const jobsRoot = path.join(root, 'tmp', 'report-jobs');
  fs.mkdirSync(jobsRoot, { recursive: true });
  const jobs = new Map();

  function persist(job) {
    try {
      fs.writeFileSync(path.join(job.jobDir, 'job.json'), JSON.stringify({ ...publicJob(job), pdfPath: job.pdfPath || '' }, null, 2));
    } catch { /* optional */ }
  }

  function loadPersisted() {
    let entries = [];
    try { entries = fs.readdirSync(jobsRoot, { withFileTypes: true }); } catch { return; }
    entries.forEach((entry) => {
      if (!entry.isDirectory() || entry.name === '_staging') return;
      const jobDir = path.join(jobsRoot, entry.name);
      let snapshot = null;
      try { snapshot = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8')); } catch { return; }
      if (!snapshot || !snapshot.jobId) return;
      const job = {
        ...snapshot,
        producer: snapshot.producer || { name: '制作者', sessionId: '' },
        audit: snapshot.audit || newAuditRecord(snapshot.producer),
        auditHistory: Array.isArray(snapshot.auditHistory) ? snapshot.auditHistory : [],
        jobDir
      };
      if (TRANSIENT_STATES.has(job.status)) {
        job.status = 'failed';
        job.error = { code: 'interrupted', message: '任务在服务重启时中断，请重新上传或重新生成。' };
      }
      jobs.set(job.jobId, job);
      persist(job);
    });
  }

  function get(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw Object.assign(new Error('Report job not found.'), { code: 'job_not_found' });
    return job;
  }

  function transition(job, status, message) {
    if (job.status !== status) assertTransition(job.status, status);
    job.status = status;
    job.progress = { ...job.progress, stage: status, message, updatedAt: now() };
    job.updatedAt = now();
  }

  function create({ taskType, brief = {}, producerName = '本会话制作者', producerSessionId = '' }) {
    const type = normalizeTaskType(taskType);
    const jobId = `report-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
    const jobDir = path.join(jobsRoot, jobId);
    fs.mkdirSync(path.join(jobDir, 'outputs'), { recursive: true });
    const producer = {
      name: text(producerName, 120) || '本会话制作者',
      sessionId: text(producerSessionId, 160) || crypto.randomUUID()
    };
    const job = {
      jobId, taskType: type, jobDir, status: type === 'track_analysis' ? 'awaiting_confirmation' : 'uploaded',
      revision: 1, buildVersion: 0, workbookId: `workbook-${jobId}`, progress: { stage: type === 'track_analysis' ? 'awaiting_confirmation' : 'uploaded', completed: 0, total: 5 },
    analysis: type === 'track_analysis' ? trackAnalysis(brief) : null, researchBrief: normalizeBrief(brief), corrections: null, artifacts: [],
    researchData: null, pricingResults: [],
      producer, audit: newAuditRecord(producer), auditHistory: [], error: null, createdAt: now(), updatedAt: now()
    };
    jobs.set(jobId, job);
    persist(job);
    return job;
  }

  function trackAnalysis(brief) {
    const category = text(brief.category, 160) || '待确认赛道';
    return {
      categoryHypotheses: [{ id: 'category-1', label: category, children: [], confidence: 0.5, confidenceReasons: ['user supplied category requires confirmation'], rulePackId: 'unknown-v1', requiresManualConfirmation: true, isUserConfirmed: false }],
      productCandidates: [], variantGroups: [], missingFields: ['market groups', 'keywords'], warnings: ['Research groups and keywords must be confirmed before research.']
    };
  }

  function attachPdf(jobId, metadata) {
    const job = get(jobId);
    try {
      transition(job, 'extracting', '正在校验并拆解 PDF 目录');
      validatePdfFile(metadata.filePath, metadata.mimeType, metadata.size);
      job.analysis = analyzePdf(metadata.filePath);
      job.analysis.originalFileName = metadata.fileName;
      job.analysis.byteSize = metadata.size;
      job.analysis.filePath = path.relative(root, metadata.filePath).replace(/\\/g, '/');
      job.pdfPath = metadata.filePath;
      transition(job, 'awaiting_confirmation', job.analysis.ocrRequired ? 'PDF 为扫描或图片型文档，需要人工确认字段' : '目录初步拆解完成，等待人工确认');
      persist(job);
      return job;
    } catch (error) {
      job.error = { code: error.code || 'extraction_failed', message: error.message };
      if (job.status !== 'failed') transition(job, 'failed', error.message);
      persist(job);
      throw error;
    }
  }

  function confirm(jobId, payload) {
    const job = get(jobId);
    assertRevision(job, payload.revision);
    if (!['awaiting_confirmation', 'confirmed', 'completed'].includes(job.status)) throw Object.assign(new Error('The report job is not waiting for confirmation.'), { code: 'confirmation_required' });
    const returnedForRepair = job.status === 'completed' && job.audit?.status === '退回纠错';
    if (job.status === 'completed' && !returnedForRepair) throw Object.assign(new Error('Only a returned report can be edited after build.'), { code: 'review_return_required' });
    const repairNotes = text(payload.repairNotes, 4000);
    if (returnedForRepair && !repairNotes) throw Object.assign(new Error('Describe the repair before resubmitting this report.'), { code: 'repair_notes_required' });
    if (returnedForRepair && text(payload.actorSessionId, 160) !== job.producer?.sessionId) {
      throw Object.assign(new Error('Only the producing session can resubmit a returned report.'), { code: 'repair_producer_required' });
    }
    job.corrections = payload.corrections || {};
    const evidenceLibrary = job.corrections.evidenceLibrary && typeof job.corrections.evidenceLibrary === 'object'
      ? job.corrections.evidenceLibrary : {};
    if (job.corrections && typeof job.corrections === 'object') delete job.corrections.evidenceLibrary;
    if (returnedForRepair) {
      job.auditHistory.push({
        type: 'repair', status: '已提交修复', producer: job.producer.name, producerSessionId: job.producer.sessionId,
        submittedAt: now(), priorRevision: job.revision, priorBuildVersion: job.buildVersion,
        issuesAddressed: [...(job.audit.issues || [])], notes: repairNotes
      });
      job.audit = { ...job.audit, status: '修复中', releaseAllowed: false };
    }
    job.revision += 1;
    if (job.analysis?.categoryHypotheses) {
      job.analysis.categoryHypotheses = job.analysis.categoryHypotheses.map((item, index) => ({
        ...item,
        label: index === 0 && payload.corrections?.category ? payload.corrections.category : item.label,
        rulePackId: index === 0 && payload.corrections?.rulePackId ? payload.corrections.rulePackId : item.rulePackId,
        isUserConfirmed: true
      }));
    }
    if (Array.isArray(job.corrections.productCandidates) && job.analysis) {
      job.analysis.productCandidates = confirmedProducts(job.corrections.productCandidates, job, evidenceLibrary);
      job.corrections.productCandidates = job.analysis.productCandidates;
      job.pricingResults = job.analysis.productCandidates.map((product) => ({
        candidateId: product.candidateId, model: product.model,
        result: calculateProductPricing(product, product.competitors)
      }));
    }
    job.researchBrief = normalizeBrief({ ...job.researchBrief, ...(job.corrections.researchBrief || {}) });
    transition(job, 'confirmed', '人工确认已保存，可开始研究或生成');
    persist(job);
    return job;
  }

  async function research(jobId, payload = {}) {
    const job = get(jobId);
    assertRevision(job, payload.revision);
    if (job.status !== 'confirmed') throw Object.assign(new Error('Confirm the catalog or research groups before research.'), { code: 'confirmation_required' });
    if (job.taskType === 'pdf_catalog' || (job.analysis?.productCandidates || []).length) {
      const errors = costConfirmationErrors(job.analysis?.productCandidates || []);
      if (errors.length) throw Object.assign(new Error(`请先人工确认所有产品的型号、采购成本、币种、单位、条款、适用变体及汇率日期（${errors.length} 款未完成）。`), { code: 'product_cost_confirmation_required' });
    }
    transition(job, 'researching', '正在准备已确认的研究拆分');
    job.researchBrief = normalizeBrief({ ...job.researchBrief, ...(payload.researchBrief || {}) });
    const observedAt = new Date().toISOString();
    const byProduct = [];
    const candidates = job.analysis?.productCandidates || [];
    for (const product of candidates) {
      const query = String(product.researchKeywords || job.researchBrief.marketGroups.flatMap((group) => group.keywords)[0] || '').trim();
      if (!query || !/^[\x00-\x7F]+$/.test(query)) {
        byProduct.push({ candidateId: product.candidateId, researchedModel: product.model, query, status: 'needs_english_keywords', records: [], errors: [{ code: 'english_keywords_required', message: '请为该型号补充英文 Amazon 检索词；未执行推测性搜索。' }] });
        continue;
      }
      try {
        const result = await amazonResearch({
          queries: [query], maxSearchResults: 8, maxProductPages: 6,
          delayMs: payload.delayMs ?? 600, observedAt: observedAt.slice(0, 10), includeReviewPages: false,
          fetchImpl: payload.fetchImpl
        });
        byProduct.push({
          candidateId: product.candidateId, researchedModel: product.model, query, status: result.records.some((record) => record.pageStatus === 'parsed') ? 'observed' : 'partial',
          records: result.records.map((record) => ({
            asin: record.asin, url: record.url, title: record.title, brand: record.brand,
            price: record.price || null, currency: 'USD', rating: record.rating || null, reviews: record.reviews || null,
            image: record.image || '', selectedVariant: record.selectedVariant || '', pageStatus: record.pageStatus,
            priceStatus: record.priceStatus || (record.pageStatus === 'parsed' && record.price > 0 ? 'observed' : 'not_observed'),
            sourceType: record.sourceType, observedAt: record.observedAt || observedAt,
            sizes: record.sizes || [], featureBullets: record.featureBullets || [],
            reviewsVisible: record.reviewsVisible || [], reviewDataStatus: record.reviewDataStatus || 'not_fetched'
          })),
          errors: result.errors || [], provenance: result.provenance
        });
      } catch (error) {
        byProduct.push({ candidateId: product.candidateId, researchedModel: product.model, query, status: 'unavailable', records: [], errors: [{ code: error.code || 'research_failed', message: error.message }] });
      }
    }
    job.researchData = { source: 'amazon_public_frontend', marketplace: 'Amazon.com', observedAt, byProduct };
    transition(job, 'scoring', '正在整理 Amazon 搜索发现与可读 PDP 观察；搜索价不作为定价证据');
    job.analysis = { ...job.analysis, rulePackId: job.analysis?.categoryHypotheses?.[0]?.rulePackId || 'unknown-v1', scoreConfidence: job.analysis?.categoryHypotheses?.[0]?.rulePackId === 'unknown-v1' ? 'low' : 'medium' };
    job.pricingResults = candidates.map((product) => ({ candidateId: product.candidateId, model: product.model, result: calculateProductPricing(product, product.competitors) }));
    transition(job, 'confirmed', 'Amazon 英文搜索完成或记录了不可访问状态；请人工确认可比 ASIN、所选变体和 PDP 价格');
    persist(job);
    return job;
  }

  async function build(jobId, payload = {}) {
    const job = get(jobId);
    assertRevision(job, payload.revision);
    if (job.status !== 'confirmed') throw Object.assign(new Error('Confirm the report inputs or returned corrections before building.'), { code: 'confirmation_required' });
    job.buildVersion += 1;
    transition(job, 'building', '正在生成当前版本 Excel 与预览 manifest');
    try {
      job.pricingResults = (job.analysis?.productCandidates || []).map((product) => ({
        candidateId: product.candidateId, model: product.model,
        result: calculateProductPricing(product, product.competitors)
      }));
      const outputDir = path.join(job.jobDir, 'outputs');
      const artifact = await buildWorkbookArtifacts(job, outputDir, { manifestDir: path.join(job.jobDir, 'outputs') });
      job.artifacts = [{
        ...artifact,
        revision: job.revision,
        buildVersion: job.buildVersion,
        downloadUrl: `/api/reports/jobs/${job.jobId}/workbooks/${job.workbookId}/download`,
        previewUrl: `/api/reports/jobs/${job.jobId}/workbooks/${job.workbookId}/preview`
      }];
      job.audit = newAuditRecord(job.producer, { revision: job.revision, buildVersion: job.buildVersion });
      transition(job, 'completed', '当前版本 Excel 和预览 manifest 已完成');
      persist(job);
      return job;
    } catch (error) {
      job.error = { code: error.code || 'build_failed', message: error.message };
      transition(job, 'failed', error.message);
      persist(job);
      throw error;
    }
  }

  function artifact(jobId, workbookId) {
    const job = get(jobId);
    const item = job.artifacts.find((candidate) => candidate.workbookId === workbookId);
    if (!item || !fs.existsSync(item.filePath) || !fs.existsSync(item.manifestPath)) throw Object.assign(new Error('Report artifact is not available.'), { code: 'artifact_not_found' });
    return { job, item };
  }

  function preview(jobId, workbookId, sheetId, page = 1, pageSize = 120) {
    const { job, item } = artifact(jobId, workbookId);
    const manifest = JSON.parse(fs.readFileSync(item.manifestPath, 'utf8'));
    if (manifest.jobId !== job.jobId || manifest.revision !== job.revision || manifest.buildVersion !== job.buildVersion || manifest.workbookId !== workbookId) throw Object.assign(new Error('Preview version does not match the current task.'), { code: 'artifact_version_mismatch' });
    const sheet = sheetId ? manifest.sheets.find((candidate) => candidate.sheetId === sheetId) : manifest.sheets[0];
    if (!sheet) throw Object.assign(new Error('Preview sheet not found.'), { code: 'sheet_not_found' });
    const start = Math.max(0, (Number(page) - 1) * Math.min(300, Number(pageSize) || 120));
    const size = Math.min(300, Math.max(1, Number(pageSize) || 120));
    return { jobId, revision: job.revision, buildVersion: job.buildVersion, workbookId, manifest: { ...manifest, sheets: manifest.sheets.map(({ cells, ...meta }) => meta) }, sheet: { ...sheet, cells: sheet.cells.slice(start, start + size), page: Number(page) || 1, pageSize: size, hasMore: start + size < sheet.cells.length } };
  }

  function evidence(jobId, fileName) {
    const job = get(jobId);
    const safeName = String(fileName || '');
    if (!/^[a-zA-Z0-9_-]+\.(?:png|jpg|webp)$/i.test(safeName)) {
      throw Object.assign(new Error('Evidence image not found.'), { code: 'evidence_not_found' });
    }
    const evidenceRoot = path.resolve(job.jobDir, 'evidence');
    const filePath = path.resolve(evidenceRoot, safeName);
    if (!filePath.startsWith(evidenceRoot + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw Object.assign(new Error('Evidence image not found.'), { code: 'evidence_not_found' });
    }
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === '.png' ? 'image/png' : extension === '.jpg' ? 'image/jpeg' : 'image/webp';
    return { job, filePath, contentType, size: fs.statSync(filePath).size };
  }

  function publicState() {
    const latest = [...jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return latest ? publicJob(latest) : null;
  }

  function recordAudit(jobId, payload = {}) {
    const job = get(jobId);
    if (job.status !== 'completed') throw Object.assign(new Error('Build the report before independent review.'), { code: 'review_requires_build' });
    const action = text(payload.action, 30);
    if (!['approve', 'return'].includes(action)) throw Object.assign(new Error('Audit action must be approve or return.'), { code: 'invalid_audit_action' });
    if (job.audit?.status === '退回纠错') throw Object.assign(new Error('A returned report must be repaired and rebuilt before it can be reviewed again.'), { code: 'audit_returned_requires_rebuild' });
    const reviewer = text(payload.reviewer, 120);
    const reviewerSessionId = text(payload.reviewerSessionId, 160);
    if (!reviewer || !reviewerSessionId) throw Object.assign(new Error('Reviewer name and independent session are required.'), { code: 'independent_reviewer_required' });
    if (!job.producer?.sessionId) throw Object.assign(new Error('This legacy task has no recorded producer session; create a new task before independent review.'), { code: 'producer_session_missing' });
    if (reviewerSessionId === job.producer?.sessionId || reviewer.toLocaleLowerCase() === String(job.producer?.name || '').toLocaleLowerCase()) {
      throw Object.assign(new Error('The producer cannot audit their own report.'), { code: 'self_audit_forbidden' });
    }
    if (Number(payload.revision) !== job.revision || Number(payload.buildVersion) !== job.buildVersion) {
      throw Object.assign(new Error('Audit must target the current report revision and build.'), { code: 'audit_version_mismatch' });
    }
    if (job.audit?.releaseAllowed) throw Object.assign(new Error('This report version has already passed independent review.'), { code: 'review_already_approved' });
    const issues = Array.isArray(payload.issues)
      ? payload.issues.map((issue) => text(issue, 1000)).filter(Boolean).slice(0, 100)
      : [];
    const gates = {
      facts: payload.gates?.facts === true,
      links: payload.gates?.links === true,
      comments: payload.gates?.comments === true,
      conclusions: payload.gates?.conclusions === true
    };
    if (action === 'return' && !issues.length) throw Object.assign(new Error('Add at least one actionable issue before returning the report.'), { code: 'audit_issue_required' });
    if (action === 'approve' && (!Object.values(gates).every(Boolean) || issues.length)) {
      throw Object.assign(new Error('Approval requires all audit gates checked and no unresolved issues.'), { code: 'audit_gates_incomplete' });
    }
    const checkedAt = now();
    job.audit = {
      ...(job.audit || newAuditRecord(job.producer)),
      status: action === 'approve' ? '独立审核通过' : '退回纠错',
      reviewer, reviewerSessionId, checkedAt, issues, gates,
      revision: job.revision, buildVersion: job.buildVersion,
      releaseAllowed: action === 'approve'
    };
    job.auditHistory.push({ type: 'audit', action, ...job.audit });
    job.updatedAt = now();
    persist(job);
    return job;
  }

  loadPersisted();
  return { artifact, create, attachPdf, build, confirm, evidence, get, preview, publicJob, publicState, research, recordAudit };
}

module.exports = { createReportJobs };
