'use strict';

(function exposeTrialImporter(root, factory) {
  const importer = factory();
  if (typeof module === 'object' && module.exports) module.exports = importer;
  if (root) root.ReportTrialImport = importer;
}(typeof window === 'undefined' ? null : window, function createTrialImporter() {
  function slug(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function reviewSample(sample, observedAt) {
    return {
      rating: Number(sample.stars), title: String(sample.title || ''), text: String(sample.englishOriginal || ''),
      reviewId: String(sample.reviewId || ''), reviewUrl: String(sample.reviewUrl || ''), date: String(sample.reviewDate || ''),
      observedAt: String(observedAt || ''), chineseTranslation: String(sample.chineseTranslation || ''),
      reviewer: String(sample.reviewer || ''), selectedReviewVariant: String(sample.selectedReviewVariant || ''),
      sourceStatus: String(sample.sourceStatus || ''), note: String(sample.note || '')
    };
  }

  function matchesTarget(target, model, configuration, optionCount) {
    const label = String(target || '').trim();
    if (label === model) return optionCount === 1;
    const prefix = `${model}:`;
    if (!label.startsWith(prefix)) return false;
    const targetConfiguration = label.slice(prefix.length).trimStart().toLowerCase();
    return targetConfiguration.startsWith(String(configuration || '').toLowerCase());
  }

  function importMerchantTrialDraft(draft) {
    if (!draft || typeof draft !== 'object' || draft.status !== 'draft_for_build_session; not independently approved'
      || !Array.isArray(draft.uploadedProducts) || !Array.isArray(draft.competitorObservations)) {
      throw new Error('这不是受支持的 2026-09-29 头盔 MVP 草稿 JSON。');
    }
    const products = [];
    const warnings = [];
    draft.uploadedProducts.forEach((sourceProduct, productIndex) => {
      const model = String(sourceProduct.printedModel || sourceProduct.productId || '').trim();
      const costOptions = Array.isArray(sourceProduct.costOptions) ? sourceProduct.costOptions : [];
      const carton = sourceProduct.packagingEvidence?.primaryCarton || {};
      if (!model || !costOptions.length) {
        warnings.push(`跳过缺型号或无成本候选的来源行 ${productIndex + 1}`);
        return;
      }
      costOptions.forEach((option, optionIndex) => {
        const configuration = String(option.configuration || `configuration ${optionIndex + 1}`).trim();
        const amount = Number(option.candidateAmount);
        const currency = String(option.currency || '').toUpperCase();
        const candidateId = `trial-${slug(model)}-${optionIndex + 1}`;
        const sourceScreenshot = String(sourceProduct.sourceScreenshot || '');
        const sourcePath = String(sourceProduct.sourcePath || sourceScreenshot);
        const matchedCompetitors = [];
        for (const observation of draft.competitorObservations) {
          const targets = Array.isArray(observation.matchedTargets) ? observation.matchedTargets : [];
          if (!targets.some((target) => matchesTarget(target, model, configuration, costOptions.length))) continue;
          const similarityStatus = String(observation.similarity?.status || 'unreviewed');
          const reviews = Array.isArray(observation.reviewSamples) ? observation.reviewSamples : [];
          const reviewPageObservedAt = String(observation.reviewPageObservation?.observedAtLocal || '');
          const imageReference = String(observation.imageEvidence?.screenshot || '');
          const price = Number(observation.displayedPrice?.amount);
          matchedCompetitors.push({
            competitorId: `${candidateId}-${String(observation.asin || 'asin').toLowerCase()}`,
            asin: String(observation.asin || '').toUpperCase(), url: String(observation.url || ''),
            title: String(observation.title || ''), brand: String(observation.brand || ''),
            price: Number.isFinite(price) ? price : '', currency: String(observation.displayedPrice?.currency || 'USD').toUpperCase(),
            selectedVariant: JSON.stringify(observation.selectedVariant || {}),
            variantLabel: Object.values(observation.selectedVariant || {}).filter(Boolean).join(' / '),
            observedAt: String(observation.observedAtLocal || ''),
            coupon: observation.displayedPrice?.couponVisible ? String(observation.displayedPrice?.couponAmount ?? 'visible; amount not transcribed') : '',
            similarity: similarityStatus === 'similar' ? 'similar' : similarityStatus === 'unreviewed' ? 'unreviewed' : 'adjacent',
            similarityReason: String(observation.similarity?.reason || ''), matchConfirmed: false,
            sourceType: 'user_trial_draft', pageStatus: 'draft_imported', priceStatus: 'draft_unverified',
            sourceNote: [
              '来源：MVP_头盔竞品与定价试采_2026-09-29.json；草稿，待独立 MAX 审核。',
              `PDP 截图引用：${imageReference || '未提供路径'}`,
              `促销口径：${observation.displayedPrice?.otherVisiblePromotion || observation.displayedPrice?.visibleDiscount || '无额外促销说明'}`,
              `评分与评论数：${observation.rating ?? '未记录'} / ${observation.ratingCount ?? '未记录'}（不推断销量）`
            ].join(' '),
            screenshotReference: imageReference,
            reviewsVisible: reviews.map((sample) => reviewSample(sample, reviewPageObservedAt)),
            reviewDataStatus: reviews.length ? 'trial_draft_partial_pending_review' : 'not_fetched',
            reviewGap: String(observation.reviewGap || ''),
            reviewCounts: observation.reviewCounts || {},
            importedSimilarityStatus: similarityStatus
          });
        }

        const dimensions = Array.isArray(carton.dimensionsCm) ? carton.dimensionsCm : [];
        const cartonRecord = dimensions.length === 3 && Number(carton.unitsPerCarton) > 0 && Number(carton.grossWeightKg) > 0
          ? [{ cartonCount: 1, unitsPerCarton: Number(carton.unitsPerCarton), lengthCm: Number(dimensions[0]), widthCm: Number(dimensions[1]), heightCm: Number(dimensions[2]), grossKg: Number(carton.grossWeightKg) }]
          : [];
        const batteryType = /button[- ]cell/i.test(configuration) ? 'button_cell'
          : /rechargeable|charging light/i.test(configuration) ? 'rechargeable'
            : /light|led/i.test(configuration) ? 'unknown' : 'none';
        const h0022Example = draft.freightScenario?.h0022IllustrativeScenarioOnly?.selectedReferenceRate;
        const isH0022Reference = model === 'H0-022' && Number(h0022Example?.amount) > 0;
        products.push({
          candidateId, displayName: `${model} · ${configuration}`, model, modelConfirmed: false, confidence: 0.5,
          categoryId: 'cycling-helmet', sourcePageNumbers: [], missingFields: ['manual model/cost confirmation', 'supplier price terms', 'dated FX', 'freight tariff'],
          productDescriptionFromScreenshot: String(sourceProduct.productDescriptionFromScreenshot || ''),
          sourceScreenshot, sourcePath, sourceFileModifiedLocal: String(sourceProduct.sourceFileModifiedLocal || ''),
          packagingEvidenceStatus: String(sourceProduct.packagingEvidence?.status || ''),
          trialImport: {
            sampleId: String(draft.sampleId || ''), importedStatus: String(draft.status), createdAtLocal: String(draft.createdAtLocal || ''),
            independentReviewStatus: 'pending; not approved for purchase or profit decisions'
          },
          fields: { purchaseCostCandidate: {
            amount: Number.isFinite(amount) ? amount : null, currency, unit: String(option.unit || ''), variant: configuration,
            sourceType: 'user_screenshot_candidate', userConfirmed: false,
            evidenceText: String(option.manualConfirmation || option.sourceWording || 'Imported from a draft cost trial; supplier terms remain unconfirmed.'),
            sourceLocation: `${sourceScreenshot}${optionIndex ? ` / cost option ${optionIndex + 1}` : ''}`
          } },
          cost: {
            amount: Number.isFinite(amount) ? amount : '', currency, unit: String(option.unit || ''), incoterm: '', variant: configuration,
            fxToUSD: '', fxDate: '', confirmed: false, sourceType: 'user_screenshot_candidate',
            sourceLocation: `${sourcePath}${optionIndex ? ` / cost option ${optionIndex + 1}` : ''}`
          },
          costEvidenceFile: null,
          shipping: {
            volumetricDivisor: 5000, divisorConfirmed: false, confirmed: false, cartons: cartonRecord,
            rateOptions: isH0022Reference ? [{
              perKg: Number(h0022Example.amount), currency: 'CNY', channel: '', postalZone: '', tier: '',
              routeEligible: false, batteryCompatible: false, candidateOnly: true,
              sourceLocation: ''
            }] : [],
            illustrativeRatePerKg: isH0022Reference ? Number(h0022Example.amount) : null,
            illustrativeRateSource: isH0022Reference ? String(h0022Example.status || 'PRD section 7 illustrative rate; not the highest eligible route') : '',
            rate: {
              perKg: '', currency: 'CNY', channel: '', postalZone: '', tier: '', fxToUSD: '', fxDate: '',
              magneticInspectionPerShipment: 480, magneticFeeApplicable: 'unknown', otherPerShipment: '',
              batteryCompatible: false, confirmed: false,
              sourceLocation: String(draft.freightScenario?.source || '货代完整费率表未提供；不得套用示例运价')
            }
          },
          batteryType, batteryTypeConfirmed: false, fees: {}, competitors: matchedCompetitors
        });
      });
    });
    if (!products.length) throw new Error('草稿 JSON 中没有可导入的型号和成本候选。');
    return {
      sampleId: String(draft.sampleId || ''), sourceStatus: String(draft.status), products,
      warnings, competitorCount: products.reduce((sum, item) => sum + item.competitors.length, 0),
      reviewCount: products.reduce((sum, item) => sum + item.competitors.reduce((count, competitor) => count + competitor.reviewsVisible.length, 0), 0)
    };
  }

  return { importMerchantTrialDraft };
}));
