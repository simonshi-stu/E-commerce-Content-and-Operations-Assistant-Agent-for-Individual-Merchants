'use strict';

const { uiMessage } = require('./messages');
const { normalizeCurrency } = require('./fx');

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

module.exports = { SUPPORTED_CURRENCIES, buildPricing, convert };
