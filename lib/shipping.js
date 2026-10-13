'use strict';

function number(value) {
  if (value === '' || value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function ceilToStep(value, step) {
  return Math.ceil((value - 1e-10) / step) * step;
}

function shipmentTier(totalKg) {
  if (totalKg >= 101) return '101kg_plus';
  if (totalKg >= 71) return '71_100kg';
  if (totalKg >= 23) return '23_70kg';
  return 'below_23kg';
}

function magneticFeeState(rate) {
  if (['yes', 'no', 'unknown'].includes(rate.magneticFeeApplicable)) return rate.magneticFeeApplicable;
  return number(rate.magneticInspectionPerShipment) === 0 ? 'no' : 'unknown';
}

function chooseRateOption(input, tier, needsBatteryChannel) {
  if (!Array.isArray(input.rateOptions) || input.rateOptions.length === 0) return { selected: null, hasOptions: false };
  const baseRate = input.rate && typeof input.rate === 'object' ? input.rate : {};
  const requestedZone = String(baseRate.postalZone || '').trim();
  const candidates = input.rateOptions.filter((option) => {
    const currency = String(option.currency || 'CNY').toUpperCase();
    return option.candidateOnly !== true && option.routeEligible === true
      && String(option.tier || '') === tier
      && (!requestedZone || !['0-4', '5-7', '8-9'].includes(requestedZone) || String(option.postalZone || '') === requestedZone)
      && ['0-4', '5-7', '8-9'].includes(String(option.postalZone || ''))
      && Boolean(String(option.channel || '').trim())
      && Boolean(String(option.sourceLocation || '').trim())
      && currency === 'CNY' && number(option.perKg) !== null && number(option.perKg) > 0
      && (!needsBatteryChannel || option.batteryCompatible === true);
  }).sort((a, b) => number(b.perKg) - number(a.perKg));
  return { selected: candidates[0] || null, hasOptions: true };
}

function calculateAirFreightScenario(input = {}, options = {}) {
  const cartons = Array.isArray(input.cartons) ? input.cartons : [];
  const divisor = number(input.volumetricDivisor);
  const rate = input.rate && typeof input.rate === 'object' ? input.rate : {};
  const required = [];
  if (divisor === null || divisor <= 0) required.push('volume-weight divisor');
  if (input.divisorConfirmed !== true) required.push('divisor confirmation');
  if (!cartons.length) required.push('outer-carton packing specification');
  const rows = [];
  let totalBillableKg = 0;
  let totalUnits = 0;
  for (const [index, carton] of cartons.entries()) {
    const count = number(carton.cartonCount);
    const units = number(carton.unitsPerCarton);
    const grossKg = number(carton.grossKg);
    const length = number(carton.lengthCm);
    const width = number(carton.widthCm);
    const height = number(carton.heightCm);
    if (![count, units, grossKg, length, width, height].every((value) => value !== null && value > 0)) {
      required.push(`carton ${index + 1} count, units/carton, gross weight, and dimensions`);
      continue;
    }
    if (!Number.isInteger(count) || !Number.isInteger(units)) {
      required.push(`carton ${index + 1} carton count and units/carton must be whole numbers`);
      continue;
    }
    const volumeWeightKg = divisor !== null && divisor > 0 ? length * width * height / divisor : null;
    const rawChargeableKg = volumeWeightKg === null ? null : Math.max(grossKg, volumeWeightKg);
    if (rawChargeableKg === null) continue;
    const roundingStepKg = rawChargeableKg < 20 ? 0.5 : 1;
    const billedPerCartonKg = ceilToStep(rawChargeableKg, roundingStepKg);
    const totalCartonWeightKg = billedPerCartonKg * count;
    const lineUnits = units * count;
    totalBillableKg += totalCartonWeightKg;
    totalUnits += lineUnits;
    rows.push({
      cartonCount: count, unitsPerCarton: units, grossKg, lengthCm: length, widthCm: width, heightCm: height,
      volumeWeightKg: Math.round(volumeWeightKg * 1000) / 1000,
      unroundedChargeableKg: Math.round(rawChargeableKg * 1000) / 1000,
      roundingStepKg, billableKgPerCarton: billedPerCartonKg, totalBillableKg: totalCartonWeightKg, totalUnits: lineUnits
    });
  }

  const cartonsComplete = cartons.length > 0 && rows.length === cartons.length;
  const tier = cartonsComplete ? shipmentTier(totalBillableKg) : '';
  const needsBatteryChannel = Boolean(options.needsBatteryChannel || input.needsBatteryChannel);
  const rateChoice = chooseRateOption(input, tier, needsBatteryChannel);
  const directRate = cartonsComplete && !rateChoice.hasOptions && rate.routeEligible === true
    && String(rate.tier || '') === tier && ['0-4', '5-7', '8-9'].includes(String(rate.postalZone || ''))
    && Boolean(String(rate.channel || '').trim()) && Boolean(String(rate.sourceLocation || rate.evidencePath || '').trim())
    && String(rate.currency || 'CNY').toUpperCase() === 'CNY' && number(rate.perKg) > 0
    && (!needsBatteryChannel || rate.batteryCompatible === true) ? rate : null;
  const selectedRate = cartonsComplete ? (rateChoice.hasOptions ? rateChoice.selected : directRate) : null;
  const hasRateCandidate = rateChoice.hasOptions || number(rate.perKg) !== null;
  const effectiveRate = selectedRate ? {
      ...rate, ...selectedRate, currency: 'CNY', fxToUSD: rate.fxToUSD, fxDate: rate.fxDate,
      magneticInspectionPerShipment: options.magneticFeeCNY ?? rate.magneticInspectionPerShipment,
      otherPerShipment: rate.otherPerShipment, confirmed: rate.confirmed === true && selectedRate.routeEligible !== false
    } : hasRateCandidate ? {
      ...rate, perKg: null, channel: '', postalZone: '', tier: '', sourceLocation: '', batteryCompatible: false, confirmed: false,
      magneticInspectionPerShipment: options.magneticFeeCNY ?? rate.magneticInspectionPerShipment
    } : { ...rate, magneticInspectionPerShipment: options.magneticFeeCNY ?? rate.magneticInspectionPerShipment };
  const perKg = number(effectiveRate.perKg);
  const currency = String(effectiveRate.currency || '').trim().toUpperCase();
  const exchangeRateToUSD = number(effectiveRate.fxToUSD);
  const channel = String(effectiveRate.channel || '').trim();
  const postalZone = String(effectiveRate.postalZone || '').trim();
  const listedTier = String(effectiveRate.tier || '').trim();
  const magneticFee = number(effectiveRate.magneticInspectionPerShipment);
  const otherShipmentFee = number(effectiveRate.otherPerShipment);
  if (!Number.isInteger(cartons.length) || rows.length !== cartons.length) { /* row-specific required list above */ }
  if (perKg === null || perKg <= 0) required.push('carrier rate per kg');
  if (!/^[A-Z]{3}$/.test(currency)) required.push('carrier rate currency');
  if (!channel) required.push('carrier/channel');
  if (!['0-4', '5-7', '8-9'].includes(postalZone)) required.push('US postal zone');
  if (!['below_23kg', '23_70kg', '71_100kg', '101kg_plus'].includes(listedTier)) required.push('rate-table weight tier');
  else if (listedTier !== tier) required.push(`rate tier mismatch: shipment falls in ${tier}, selected ${listedTier}`);
  if (!String(effectiveRate.sourceLocation || effectiveRate.evidencePath || '').trim()) required.push('rate-table screenshot/source location');
  if (magneticFee === null || magneticFee < 0) required.push('magnetic inspection charge or explicit zero');
  if (otherShipmentFee === null || otherShipmentFee < 0) required.push('other shipment charges or explicit zero');
  if (currency && currency !== 'USD' && (exchangeRateToUSD === null || exchangeRateToUSD <= 0 || !String(effectiveRate.fxDate || '').trim())) {
    required.push('dated exchange rate to USD');
  }
  if ((rateChoice.hasOptions || hasRateCandidate) && !selectedRate) required.push(`no eligible CNY/kg option for actual ${tier} tier and SKU transport class`);
  if (needsBatteryChannel && effectiveRate.batteryCompatible !== true) required.push('carrier confirmation for battery-capable channel');
  if (effectiveRate.confirmed !== true) required.push('carrier/channel/rate-table confirmation');
  if (input.confirmed !== true) required.push('freight scenario confirmation');
  const applicability = options.magneticFeeApplicability || magneticFeeState(rate);
  if (applicability === 'unknown') required.push('magnetic-fee applicability (CNY 0 vs CNY 480 per-ticket scenarios)');

  const usableRate = cartonsComplete && perKg !== null && perKg > 0 && currency && /^[A-Z]{3}$/.test(currency);
  const subtotal = usableRate ? totalBillableKg * perKg + (magneticFee || 0) + (otherShipmentFee || 0) : null;
  const usdRate = currency === 'USD' ? 1 : exchangeRateToUSD;
  const usdTotal = subtotal !== null && usdRate !== null && usdRate > 0 ? subtotal * usdRate : null;
  const sourceCurrencyPerUnit = subtotal !== null && totalUnits > 0 ? subtotal / totalUnits : null;
  const usdPerUnit = usdTotal !== null && totalUnits > 0 ? usdTotal / totalUnits : null;
  const magneticFeePerUnit = magneticFee !== null && totalUnits > 0 ? roundMoney(magneticFee / totalUnits) : null;
  const otherFeePerUnit = otherShipmentFee !== null && totalUnits > 0 ? roundMoney(otherShipmentFee / totalUnits) : null;
  return {
    status: required.length ? 'scenario_only' : 'confirmed',
    currency: currency || 'CNY', channel, postalZone, selectedRateTier: listedTier, calculatedShipmentTier: tier,
    volumetricDivisor: divisor, totalBillableKg: cartonsComplete ? Math.round(totalBillableKg * 100) / 100 : null,
    totalUnits: cartonsComplete ? totalUnits : null,
    cartons: rows, ratePerKg: perKg, carrierCharge: subtotal === null ? null : roundMoney(subtotal),
    freightPerUnit: sourceCurrencyPerUnit === null ? null : roundMoney(sourceCurrencyPerUnit),
    freightPerUnitUSD: usdPerUnit === null ? null : roundMoney(usdPerUnit),
    magneticInspectionPerShipment: magneticFee, magneticInspectionPerUnit: magneticFeePerUnit,
    otherShipmentPerUnit: otherFeePerUnit, selectedRateOption: selectedRate ? {
      channel, postalZone, tier: listedTier, perKg, sourceLocation: effectiveRate.sourceLocation || '', batteryCompatible: effectiveRate.batteryCompatible === true
    } : null,
    exchangeRateToUSD: usdRate || null, fxDate: String(effectiveRate.fxDate || ''), needsBatteryChannel,
    magneticFeeApplicable: applicability,
    missing: [...new Set(required)],
    warning: needsBatteryChannel && effectiveRate.batteryCompatible !== true
      ? '配置含电或电池状态尚未排除；未套用普通不接电渠道费率。'
      : !cartonsComplete ? '外箱计费规格不完整；未推算整票计费重或费用。'
        : hasRateCandidate && !selectedRate ? `未将任何未匹配路线/邮区/重量档的示例运价套入；当前没有适用 ${tier} 档的可承运 CNY/kg 费率行。`
      : '此项仅为空运情景；不代表全包到岸成本，关税、清关、入仓、税费及平台费用须另行确认。'
  };
}

function calculateAirFreightSensitivity(input = {}, options = {}) {
  const baseRate = input.rate && typeof input.rate === 'object' ? input.rate : {};
  const applicability = magneticFeeState(baseRate);
  const conservativeFee = applicability === 'no' ? 0 : 480;
  const confirmedDivisor = number(input.volumetricDivisor);
  const conservativeDivisor = input.divisorConfirmed === true && [5000, 6000].includes(confirmedDivisor) ? confirmedDivisor : 5000;
  const scenarios = [];
  for (const divisor of [5000, 6000]) {
    for (const magneticFeeCNY of [0, 480]) {
      const result = calculateAirFreightScenario({ ...input, volumetricDivisor: divisor }, {
        ...options, magneticFeeCNY, magneticFeeApplicability: applicability
      });
      scenarios.push({
        id: `divisor-${divisor}-magnetic-${magneticFeeCNY}`,
        label: `除数 ${divisor}；${magneticFeeCNY ? '含可能磁检费 ¥480/票（压力情景）' : '不含磁检费'}`,
        volumetricDivisor: divisor, magneticInspectionPerShipmentCNY: magneticFeeCNY,
        conservative: divisor === conservativeDivisor && magneticFeeCNY === conservativeFee,
        result
      });
    }
  }
  const conservative = scenarios.find((scenario) => scenario.volumetricDivisor === conservativeDivisor
    && scenario.magneticInspectionPerShipmentCNY === conservativeFee) || scenarios[1];
  const lowFreight = scenarios
    .filter((scenario) => scenario.result.freightPerUnit !== null)
    .sort((a, b) => a.result.freightPerUnit - b.result.freightPerUnit)[0] || null;
  const highFreight = scenarios
    .filter((scenario) => scenario.result.freightPerUnit !== null)
    .sort((a, b) => b.result.freightPerUnit - a.result.freightPerUnit)[0] || null;
  let illustrativeExample = null;
  const illustrativeRate = number(input.illustrativeRatePerKg);
  if (illustrativeRate !== null && illustrativeRate > 0) {
    const conservativeWeight = scenarios.find((scenario) => scenario.volumetricDivisor === 5000 && scenario.magneticInspectionPerShipmentCNY === 0)?.result;
    const pressureWeight = scenarios.find((scenario) => scenario.volumetricDivisor === 5000 && scenario.magneticInspectionPerShipmentCNY === 480)?.result;
    const referenceScenario = (weightResult, fee) => {
      if (!weightResult || !Number.isFinite(weightResult.totalBillableKg) || !Number.isFinite(weightResult.totalUnits) || weightResult.totalUnits <= 0) return null;
      const charge = weightResult.totalBillableKg * illustrativeRate + fee;
      return {
        status: 'scenario_only', currency: 'CNY', volumetricDivisor: 5000,
        calculatedShipmentTier: weightResult.calculatedShipmentTier,
        totalBillableKg: weightResult.totalBillableKg, totalUnits: weightResult.totalUnits,
        ratePerKg: illustrativeRate, magneticInspectionPerShipment: fee,
        carrierCharge: roundMoney(charge), freightPerUnit: weightResult.totalUnits ? roundMoney(charge / weightResult.totalUnits) : null,
        freightPerUnitUSD: null, selectedRateOption: null,
        missing: ['illustrative 55.7 CNY/kg rate is not matched to a carrier/channel/zone tariff row'],
        warning: '仅为 PRD 条件示例；不是可用于成本/推荐价的适用费率或最高合理费率。'
      };
    };
    illustrativeExample = {
      ratePerKgCNY: illustrativeRate,
      source: String(input.illustrativeRateSource || 'PRD 第 7 节条件示例；不是最高合理费率或已匹配线路'),
      base: referenceScenario(conservativeWeight, 0),
      withMagneticPressure: referenceScenario(pressureWeight, 480)
    };
  }
  return {
    conservative,
    lowFreight,
    highFreight,
    scenarios,
    illustrativeExample,
    note: '除数默认比较 5000/6000，保守成本采用 5000；可能磁检费 ¥480/票分别列含/不含情景，按本情景票内件数分摊，不代表必收。费率仅取实际达到重量档且人工标记可承运的路线中最高 CNY/kg。'
  };
}

module.exports = { calculateAirFreightScenario, calculateAirFreightSensitivity, shipmentTier };
