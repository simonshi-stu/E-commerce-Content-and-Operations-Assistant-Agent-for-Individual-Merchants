'use strict';

const { uiMessage } = require('./messages');
const { normalizeCurrency } = require('./fx');
const { calculateAirFreightSensitivity } = require('./shipping');

const SUPPORTED_CURRENCIES = Object.freeze(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'MXN', 'BRL']);

function number(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function convert(amount, from, to, rates) {
  if (from === to) return amount;
  const fromRate = rates[from];
  const toRate = rates[to];
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) return null;
  return (amount / fromRate) * toRate;
}

function buildPricing(payload, locale) {
  const payoutCurrency = normalizeCurrency(payload.payoutCurrency) || 'USD';
  const rates = payload.rates && typeof payload.rates === 'object' ? payload.rates : {};
  if (!Number.isFinite(rates[payoutCurrency])) {
    return { error: uiMessage(locale, 'intel.pricing.ratesMissing', { codes: payoutCurrency }) };
  }

  const productCost = payload.productCost && typeof payload.productCost === 'object' ? payload.productCost : {};
  const productCostAmount = positive(productCost.amount);
  if (productCostAmount <= 0 && positive(payload.price && payload.price.amount) <= 0) {
    return { error: uiMessage(locale, 'intel.pricing.required') };
  }

  const missing = new Set();
  const convertField = (amount, currency) => {
    const from = normalizeCurrency(currency) || payoutCurrency;
    if (!Number.isFinite(rates[from])) {
      missing.add(from);
      return null;
    }
    return convert(amount, from, payoutCurrency, rates);
  };

  const productCostConverted = convertField(productCostAmount, productCost.currency || payoutCurrency);
  const shipping = payload.shipping && typeof payload.shipping === 'object' ? payload.shipping : {};
  const shippingAmountConverted = convertField(positive(shipping.amount), shipping.currency || payoutCurrency);
  const fulfillment = payload.fulfillmentFee && typeof payload.fulfillmentFee === 'object' ? payload.fulfillmentFee : {};
  const fulfillmentConverted = convertField(positive(fulfillment.amount), fulfillment.currency || payoutCurrency);
  const adCost = payload.adCost && typeof payload.adCost === 'object' ? payload.adCost : {};
  const adAmountConverted = adCost.mode === 'percent' ? 0 : convertField(positive(adCost.amount), adCost.currency || payoutCurrency);

  if (missing.size > 0) return { error: uiMessage(locale, 'intel.pricing.ratesMissing', { codes: [...missing].join(', ') }) };
  if (productCostConverted === null || shippingAmountConverted === null || fulfillmentConverted === null || adAmountConverted === null) {
    return { error: uiMessage(locale, 'intel.pricing.ratesMissing', { codes: payoutCurrency }) };
  }

  const weightKg = positive(payload.weightKg);
  const dimensions = payload.dimensions && typeof payload.dimensions === 'object' ? payload.dimensions : {};
  const length = positive(dimensions.length);
  const width = positive(dimensions.width);
  const height = positive(dimensions.height);
  const divisor = Math.max(1, number(payload.volumetricDivisor, 5000));
  const volumetricWeight = (length * width * height) / divisor;
  const chargeableWeightKg = round(Math.max(weightKg, volumetricWeight), 3);

  const shippingMode = shipping.mode === 'per_kg' ? 'per_kg' : 'per_unit';
  const shippingPerUnit = shippingMode === 'per_kg' ? shippingAmountConverted * Math.max(chargeableWeightKg, 0.001) : shippingAmountConverted;

  const referralFeeRate = Math.min(90, positive(payload.referralFeeRate, 15));
  const adMode = adCost.mode === 'percent' ? 'percent' : 'per_unit';
  const adPercent = adMode === 'percent' ? Math.min(90, positive(adCost.amount)) : 0;
  const adPerUnit = adMode === 'per_unit' ? adAmountConverted : 0;
  const targetMarginRate = Math.min(90, positive(payload.targetMarginRate, 30));

  const fixedCost = productCostConverted + shippingPerUnit + fulfillmentConverted + adPerUnit;
  const variableRate = referralFeeRate + adPercent;
  const marginFactor = 1 - variableRate / 100;
  const suggestedFactor = 1 - (variableRate + targetMarginRate) / 100;
  const hasCosts = fixedCost > 0;

  const breakEvenPrice = hasCosts && marginFactor > 0.05 ? round(fixedCost / marginFactor) : 0;
  const suggestedPrice = hasCosts && suggestedFactor > 0.05 ? round(fixedCost / suggestedFactor) : 0;

  const price = payload.price && typeof payload.price === 'object' ? payload.price : {};
  const listPrice = convertField(positive(price.amount), price.currency || payoutCurrency);
  let atPlannedPrice = null;
  if (listPrice !== null && listPrice > 0) {
    const referralFee = listPrice * referralFeeRate / 100;
    const adCostAtPrice = adMode === 'percent' ? listPrice * adPercent / 100 : adPerUnit;
    const totalCost = productCostConverted + shippingPerUnit + fulfillmentConverted + adCostAtPrice + referralFee;
    const profit = listPrice - totalCost;
    atPlannedPrice = {
      price: round(listPrice),
      referralFee: round(referralFee),
      adCost: round(adCostAtPrice),
      totalCost: round(totalCost),
      profit: round(profit),
      marginRate: round((profit / listPrice) * 100)
    };
  }

  return {
    result: {
      payoutCurrency,
      marketplace: typeof payload.marketplace === 'string' ? payload.marketplace.slice(0, 40) : 'generic',
      chargeableWeightKg,
      volumetricWeight: round(volumetricWeight, 3),
      shippingMode,
      perUnit: {
        productCost: round(productCostConverted),
        shippingCost: round(shippingPerUnit),
        fulfillmentFee: round(fulfillmentConverted),
        adCost: round(adPerUnit)
      },
      rates: {
        referralFeeRate,
        adMode,
        adPercent,
        targetMarginRate
      },
      fixedCost: round(fixedCost),
      hasCosts,
      breakEvenPrice,
      suggestedPrice,
      atPlannedPrice,
      feasible: suggestedPrice > 0
    }
  };
}

function finiteNonNegative(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function verifiedCompetitorPrices(competitors = []) {
  const seenAsins = new Set();
  return (Array.isArray(competitors) ? competitors : []).filter((item) => {
    if (!item || item.similarity !== 'similar' || item.matchConfirmed !== true) return false;
    const price = finiteNonNegative(item.price);
    const asin = String(item.asin || '').toUpperCase();
    const url = String(item.url || '');
    const linkedAsin = url.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
    let amazonUrl = false;
    try {
      const parsed = new URL(url);
      amazonUrl = ['amazon.com', 'www.amazon.com', 'smile.amazon.com'].includes(parsed.hostname.toLowerCase())
        && ['http:', 'https:'].includes(parsed.protocol);
    } catch { /* invalid observation link */ }
    const hasDate = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(String(item.observedAt || ''));
    const hasVariant = Boolean(String(item.variantLabel || '').trim());
    const sourceVerified = item.sourceType === 'amazon_public_product'
      ? item.pageStatus === 'parsed' && item.priceStatus === 'observed'
      : item.sourceType === 'user_screenshot' && Boolean(item.screenshotPath || item.screenshotEvidence);
    const verified = amazonUrl && Number.isFinite(price) && price > 0 && /^[A-Z0-9]{10}$/.test(asin)
      && linkedAsin === asin && hasDate && hasVariant && sourceVerified;
    if (!verified || seenAsins.has(asin)) return false;
    seenAsins.add(asin);
    return true;
  });
}

function calculateProductPricing(product = {}, competitors = []) {
  const model = String(product.model || '').trim();
  const cost = product.cost && typeof product.cost === 'object' ? product.cost : {};
  const fees = product.fees && typeof product.fees === 'object' ? product.fees : {};
  const freightSensitivity = calculateAirFreightSensitivity(product.shipping || {}, {
    needsBatteryChannel: product.batteryType !== 'none' || product.batteryTypeConfirmed !== true
  });
  const airFreight = freightSensitivity.conservative.result;
  const missing = [];
  if (!model || product.modelConfirmed !== true) missing.push('model confirmation');
  if (!['none', 'button_cell', 'rechargeable'].includes(product.batteryType) || product.batteryTypeConfirmed !== true) missing.push('battery/light transport classification confirmation');
  if (cost.confirmed !== true) missing.push('purchase cost confirmation');
  if (finiteNonNegative(cost.amount) === null || Number(cost.amount) <= 0) missing.push('purchase cost amount');
  if (!/^[A-Z]{3}$/.test(String(cost.currency || '').toUpperCase())) missing.push('purchase cost currency');
  if (!String(cost.unit || '').trim()) missing.push('purchase cost unit');
  if (!String(cost.incoterm || '').trim()) missing.push('purchase cost terms');
  if (!String(cost.variant || '').trim()) missing.push('cost variant/configuration');
  const fxToUsd = finiteNonNegative(cost.fxToUSD);
  if (fxToUsd === null || fxToUsd <= 0) missing.push('exchange rate to USD');
  if (String(cost.currency || '').toUpperCase() !== 'USD' && !String(cost.fxDate || '').trim()) missing.push('exchange-rate date');

  const requiredFees = [
    ['inboundPerUnit', 'other inbound costs excluding calculated air freight'], ['packagingPerUnit', 'packaging'],
    ['fulfillmentPerUnit', 'FBA / fulfillment fee'], ['referralRatePct', 'Amazon referral fee rate'],
    ['adPerUnit', 'per-unit advertising'], ['adRatePct', 'sales-based advertising rate'],
    ['returnPerUnit', 'per-unit returns reserve'], ['returnRatePct', 'sales-based returns reserve'],
    ['taxPerUnit', 'duties / taxes per unit'], ['taxRatePct', 'sales-based tax rate (or explicit zero)'],
    ['otherPerUnit', 'other fixed cost'], ['discountRatePct', 'discount rate'],
    ['couponFixed', 'fixed Coupon'], ['targetMarginPct', 'target profit margin']
  ];
  const feeValues = {};
  for (const [key, label] of requiredFees) {
    const value = finiteNonNegative(fees[key]);
    if (value === null) missing.push(label);
    else feeValues[key] = value;
  }
  if (fees.confirmed !== true) missing.push('fee assumptions confirmation');
  if (airFreight.status !== 'confirmed') missing.push('confirmed air-freight carton, route, zone, rate, and carrier assumptions');

  const priceRows = verifiedCompetitorPrices(competitors);
  const prices = priceRows.map((item) => Number(item.price)).sort((a, b) => a - b);
  const priceStats = prices.length ? {
    sampleCount: prices.length,
    min: round(prices[0]),
    median: round(prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2),
    max: round(prices[prices.length - 1]),
    currency: 'USD'
  } : { sampleCount: 0, min: null, median: null, max: null, currency: 'USD' };

  const unitPurchaseCostUSD = finiteNonNegative(cost.amount) !== null && fxToUsd > 0 ? Number(cost.amount) * fxToUsd : null;
  const freightPerUnitUSD = airFreight.freightPerUnitUSD;
  const partialFees = Object.fromEntries(requiredFees.map(([key]) => [key, finiteNonNegative(fees[key])]));
  const knownVariableRate = ['referralRatePct', 'adRatePct', 'returnRatePct', 'taxRatePct']
    .map((key) => finiteNonNegative(fees[key])).filter((value) => value !== null).reduce((sum, value) => sum + value, 0) / 100;
  const knownFixedCost = [
    unitPurchaseCostUSD, freightPerUnitUSD, partialFees.inboundPerUnit, partialFees.packagingPerUnit,
    partialFees.fulfillmentPerUnit, partialFees.adPerUnit, partialFees.returnPerUnit,
    partialFees.taxPerUnit, partialFees.otherPerUnit
  ].filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
  const partialDiscount = partialFees.discountRatePct === null ? 0 : partialFees.discountRatePct / 100;
  const partialCoupon = partialFees.couponFixed === null ? 0 : partialFees.couponFixed;
  const partialTarget = partialFees.targetMarginPct === null ? 0 : partialFees.targetMarginPct / 100;
  const feeHeadroomAtMarketUpper = unitPurchaseCostUSD !== null && freightPerUnitUSD !== null && priceStats.max !== null
    && partialDiscount < 1 && (1 - knownVariableRate - partialTarget) > 0
    ? round((priceStats.max * (1 - partialDiscount) - partialCoupon) * (1 - knownVariableRate - partialTarget) - knownFixedCost)
    : null;
  const formulas = {
    customerPayment: 'S = listPrice × (1 - discountRate) - fixedCoupon',
    fixedCost: 'F = unitPurchaseCostUSD + airFreightPerUnitUSD + otherInbound + packaging + fulfillment + fixedAd + fixedReturns + duties/taxes + otherFixed',
    variableRate: 'v = referralRate + salesBasedAdRate + salesBasedReturnRate + applicableSalesBasedTaxRate',
    profit: 'profit = S × (1 - v) - F',
    breakEvenListPrice: '(F / (1 - v) + fixedCoupon) / (1 - discountRate)',
    targetProfitListPrice: '(F / (1 - v - targetMargin) + fixedCoupon) / (1 - discountRate)'
  };
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length) return {
    status: 'incomplete', currency: 'USD', missing: uniqueMissing, market: priceStats, airFreight, freightSensitivity,
    unitPurchaseCostUSD: unitPurchaseCostUSD === null ? null : round(unitPurchaseCostUSD),
    feeHeadroomAtMarketUpper,
    feeHeadroomStatus: feeHeadroomAtMarketUpper === null ? 'not_calculable' : 'scenario_only',
    fixedCost: null, breakEvenListPrice: null, targetProfitListPrice: null, recommendedListPrice: null, profitAtRecommendation: null,
    formulas,
    decision: feeHeadroomAtMarketUpper === null
      ? `暂无法确认净盈利；缺少或待核：${uniqueMissing.join('、')}。`
      : `暂无法确认净盈利；按当前未完整确认的运输/费用情景，在可比市场上沿扣除已录入费用后，剩余可容纳未录入费用约 US$${feeHeadroomAtMarketUpper.toFixed(2)}/件（情景值，非利润）。缺项：${uniqueMissing.join('、')}。`
  };

  const pctFields = ['referralRatePct', 'adRatePct', 'returnRatePct', 'taxRatePct', 'discountRatePct', 'targetMarginPct'];
  const badPct = pctFields.filter((key) => feeValues[key] > 100);
  if (badPct.length || feeValues.discountRatePct >= 100) return {
    status: 'invalid_assumptions', currency: 'USD', missing: [], market: priceStats,
    decision: '暂无法确认盈利：费率必须在 0–100% 范围内，且折扣率必须小于 100%。',
    breakEvenListPrice: null, targetProfitListPrice: null, recommendedListPrice: null, profitAtRecommendation: null
  };

  const variableRate = (feeValues.referralRatePct + feeValues.adRatePct + feeValues.returnRatePct + feeValues.taxRatePct) / 100;
  const targetMargin = feeValues.targetMarginPct / 100;
  const discountRate = feeValues.discountRatePct / 100;
  const breakEvenDenominator = 1 - variableRate;
  const targetDenominator = 1 - variableRate - targetMargin;
  if (breakEvenDenominator <= 0 || targetDenominator <= 0) return {
    status: 'invalid_assumptions', currency: 'USD', missing: [], market: priceStats,
    decision: '暂无法确认盈利：佣金、广告、退货准备、适用税率与目标利润率之和必须小于 100%。',
    breakEvenListPrice: null, targetProfitListPrice: null, recommendedListPrice: null, profitAtRecommendation: null
  };

  const fixedCost = unitPurchaseCostUSD + freightPerUnitUSD + feeValues.inboundPerUnit + feeValues.packagingPerUnit
    + feeValues.fulfillmentPerUnit + feeValues.adPerUnit + feeValues.returnPerUnit + feeValues.taxPerUnit + feeValues.otherPerUnit;
  const fixedCoupon = feeValues.couponFixed;
  const breakEvenListPrice = round((fixedCost / breakEvenDenominator + fixedCoupon) / (1 - discountRate));
  const targetProfitListPrice = round((fixedCost / targetDenominator + fixedCoupon) / (1 - discountRate));
  const calculateAt = (listPrice) => {
    const customerPayment = listPrice * (1 - discountRate) - fixedCoupon;
    const profit = customerPayment * (1 - variableRate) - fixedCost;
    return {
      listPrice: round(listPrice), customerPayment: round(customerPayment), fixedCost: round(fixedCost),
      profit: round(profit), marginRatePct: customerPayment > 0 ? round(profit / customerPayment * 100) : null
    };
  };

  if (priceRows.length < 3) return {
    status: 'needs_market_evidence', currency: 'USD', missing: [`at least 3 verified comparable PDP price observations (currently ${priceRows.length})`], market: priceStats, airFreight, freightSensitivity,
    unitPurchaseCostUSD: round(unitPurchaseCostUSD), fixedCost: round(fixedCost), variableRatePct: round(variableRate * 100),
    breakEvenListPrice, targetProfitListPrice, recommendedListPrice: null, profitAtRecommendation: null,
    formulas: {
      customerPayment: 'S = listPrice × (1 - discountRate) - fixedCoupon',
      ...formulas,
    },
    decision: `费用已确认，可复算保本价和目标利润价；目前只有 ${priceRows.length} 个已确认相似竞品 PDP 价格，需补至至少 3 个后才给市场售价建议。`
  };

  const upper = priceStats.max;
  const premiumRationale = String(product.premiumRationale || '').trim();
  let recommendedListPrice = null;
  let status = 'not_recommended';
  let decision;
  if (targetProfitListPrice > upper) {
    if (premiumRationale) {
      recommendedListPrice = targetProfitListPrice;
      status = 'conditional_premium';
      decision = `目标利润价高于相似竞品上沿；仅在人工复核此溢价依据后评估：${premiumRationale}`;
    } else {
      decision = '当前成本下不建议进入：目标利润价高于已确认相似竞品价格带上沿，请降成本或调整定位。';
    }
  } else if (breakEvenListPrice > upper) {
    decision = '当前成本下不建议进入：相似竞品价格带上沿仍低于保本标价，请降成本或换定位。';
  } else {
    recommendedListPrice = round(Math.max(targetProfitListPrice, priceStats.min));
    status = 'recommended';
    decision = '目标利润价落在可比市场上沿以内；建议在该价位进行小批量市场验证，价格带只计入已确认相似竞品。';
  }

  return {
    status, currency: 'USD', missing: [], market: priceStats, airFreight, freightSensitivity,
    unitPurchaseCostUSD: round(unitPurchaseCostUSD), fixedCost: round(fixedCost), variableRatePct: round(variableRate * 100),
    breakEvenListPrice, targetProfitListPrice, recommendedListPrice,
    profitAtRecommendation: recommendedListPrice === null ? null : calculateAt(recommendedListPrice),
    formulas: {
      customerPayment: 'S = listPrice × (1 - discountRate) - fixedCoupon',
      ...formulas
    },
    decision
  };
}

module.exports = { SUPPORTED_CURRENCIES, buildPricing, calculateProductPricing, convert, verifiedCompetitorPrices };
