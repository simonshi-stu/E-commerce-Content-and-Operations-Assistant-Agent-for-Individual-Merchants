'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { calculateAirFreightScenario, calculateAirFreightSensitivity } = require('../lib/shipping');
const { calculateProductPricing } = require('../lib/pricing');

describe('air freight by outer carton', () => {
  it('uses max(gross, volumetric), carton-level rounding and units/carton for H0-022 scenarios', () => {
    const common = {
      confirmed: true, divisorConfirmed: true, volumetricDivisor: 6000,
      cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }],
      rate: {
        perKg: 55.7, currency: 'CNY', channel: 'carrier quote scenario', postalZone: '0-4', tier: '23_70kg', routeEligible: true,
        fxToUSD: 0.14, fxDate: '2026-09-29 test scenario', magneticInspectionPerShipment: 0, otherPerShipment: 0,
        sourceLocation: 'fixture only / not a carrier quote', batteryCompatible: false, confirmed: true
      }
    };
    const divisor6000 = calculateAirFreightScenario(common);
    assert.equal(divisor6000.cartons[0].volumeWeightKg, 24.472);
    assert.equal(divisor6000.cartons[0].billableKgPerCarton, 25);
    assert.equal(divisor6000.totalBillableKg, 25);
    assert.equal(divisor6000.freightPerUnit, 69.63);
    assert.equal(divisor6000.status, 'confirmed');

    const divisor5000 = calculateAirFreightScenario({ ...common, volumetricDivisor: 5000 });
    assert.equal(divisor5000.cartons[0].billableKgPerCarton, 30);
    assert.equal(divisor5000.freightPerUnit, 83.55);
  });

  it('rounds each package first, then sums, including the 20kg step boundary', () => {
    const result = calculateAirFreightScenario({
      volumetricDivisor: 100_000, divisorConfirmed: true, confirmed: true,
      cartons: [
        { cartonCount: 1, unitsPerCarton: 1, lengthCm: 1, widthCm: 1, heightCm: 1, grossKg: 19.99 },
        { cartonCount: 1, unitsPerCarton: 1, lengthCm: 1, widthCm: 1, heightCm: 1, grossKg: 20 },
        { cartonCount: 1, unitsPerCarton: 1, lengthCm: 1, widthCm: 1, heightCm: 1, grossKg: 20.1 }
      ],
      rate: { perKg: 1, currency: 'CNY', channel: 'test', postalZone: '0-4', tier: 'below_23kg', routeEligible: true, fxToUSD: 1,
        magneticInspectionPerShipment: 0, otherPerShipment: 0, sourceLocation: 'test', confirmed: false }
    });
    assert.deepEqual(result.cartons.map((carton) => carton.billableKgPerCarton), [20, 20, 21]);
    assert.equal(result.totalBillableKg, 61);
    assert.ok(result.missing.includes('carrier/channel/rate-table confirmation'));
    assert.equal(result.status, 'scenario_only');
  });

  it('matches the corrected 60.5 kg multi-piece example without extra shipment rounding', () => {
    const result = calculateAirFreightScenario({
      volumetricDivisor: 6000, divisorConfirmed: true,
      cartons: [
        { cartonCount: 1, unitsPerCarton: 1, lengthCm: 1, widthCm: 1, heightCm: 1, grossKg: 20.1 },
        { cartonCount: 1, unitsPerCarton: 1, lengthCm: 6000 * 23.6, widthCm: 1, heightCm: 1, grossKg: 11 },
        { cartonCount: 1, unitsPerCarton: 1, lengthCm: 6000 * 8.1, widthCm: 1, heightCm: 1, grossKg: 15.1 }
      ], rate: {}
    });
    assert.deepEqual(result.cartons.map((carton) => carton.billableKgPerCarton), [21, 24, 15.5]);
    assert.equal(result.totalBillableKg, 60.5);
    assert.equal(result.status, 'scenario_only');
  });

  it('does not fabricate dimensional weight or a freight charge when the divisor is missing', () => {
    const result = calculateAirFreightScenario({
      cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }],
      rate: { perKg: 55.7, currency: 'CNY', fxToUSD: 0.14 }
    });
    assert.equal(result.cartons.length, 0);
    assert.equal(result.totalBillableKg, null);
    assert.equal(result.freightPerUnit, null);
    assert.ok(result.missing.includes('volume-weight divisor'));
  });

  it('never applies an ordinary route to battery SKUs without carrier confirmation', () => {
    const input = {
      volumetricDivisor: 6000, divisorConfirmed: true, confirmed: true,
      cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }],
      rate: { perKg: 55.7, currency: 'CNY', channel: 'ordinary air', postalZone: '0-4', tier: '23_70kg', routeEligible: true, fxToUSD: 0.14,
        fxDate: '2026-09-29', magneticInspectionPerShipment: 0, otherPerShipment: 0, sourceLocation: 'test', confirmed: true, batteryCompatible: false }
    };
    const result = calculateAirFreightScenario(input, { needsBatteryChannel: true });
    assert.equal(result.status, 'scenario_only');
    assert.ok(result.missing.includes('carrier confirmation for battery-capable channel'));
    assert.match(result.warning, /未套用普通不接电渠道费率/);
  });
});

it('does not claim net profit with missing FBA/ad/tax inputs and reports only scenario fee headroom', () => {
  const competitors = [1, 2, 3].map((id) => ({
    asin: `B00000000${id}`, url: `https://www.amazon.com/dp/B00000000${id}`, price: 40 + id,
    observedAt: '2026-09-29', variantLabel: 'Black / M', similarity: 'similar', matchConfirmed: true,
    sourceType: 'amazon_public_product', pageStatus: 'parsed', priceStatus: 'observed'
  }));
  const result = calculateProductPricing({
    model: 'H0-022', modelConfirmed: true, batteryType: 'none', batteryTypeConfirmed: true,
    cost: { amount: 16, currency: 'CNY', unit: 'CNY/piece', incoterm: 'EXW', variant: 'base', fxToUSD: 0.14, fxDate: '2026-09-29', confirmed: true },
    shipping: {
      volumetricDivisor: 6000, divisorConfirmed: true, confirmed: false,
      cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }],
      rate: { perKg: 55.7, currency: 'CNY', channel: 'scenario', postalZone: '0-4', tier: '23_70kg', routeEligible: true, fxToUSD: 0.14,
        fxDate: '2026-09-29', magneticInspectionPerShipment: 0, otherPerShipment: 0, sourceLocation: 'fixture scenario', confirmed: false }
    },
    fees: { referralRatePct: 15, discountRatePct: 0, couponFixed: 0, targetMarginPct: 20, inboundPerUnit: 0, packagingPerUnit: 0, confirmed: false }
  }, competitors);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.recommendedListPrice, null);
  assert.equal(result.profitAtRecommendation, null);
  assert.equal(result.airFreight.freightPerUnit, 69.63);
  assert.equal(result.freightSensitivity.scenarios.find((scenario) => scenario.volumetricDivisor === 5000 && scenario.magneticInspectionPerShipmentCNY === 0).result.freightPerUnit, 83.55);
  assert.equal(result.feeHeadroomStatus, 'scenario_only');
  assert.ok(Number.isFinite(result.feeHeadroomAtMarketUpper));
  assert.match(result.decision, /非利润/);
});

it('selects only the highest eligible actual-tier CNY rate and respects battery acceptance', () => {
  const shipping = {
    volumetricDivisor: 5000, divisorConfirmed: true, confirmed: true,
    cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }],
    rate: { currency: 'CNY', fxToUSD: 0.14, fxDate: '2026-09-29', magneticInspectionPerShipment: 0, magneticFeeApplicable: 'no', otherPerShipment: 0, confirmed: true },
    rateOptions: [
      { perKg: 55.7, currency: 'CNY', channel: 'PRD example', postalZone: '0-4', tier: '23_70kg', routeEligible: true, candidateOnly: true, sourceLocation: 'PRD example only' },
      { perKg: 99, currency: 'CNY', channel: 'wrong weight tier', postalZone: '0-4', tier: '71_100kg', routeEligible: true, sourceLocation: 'tariff row A' },
      { perKg: 120, currency: 'CNY', channel: 'unverified route', postalZone: '0-4', tier: '23_70kg', routeEligible: false, sourceLocation: 'tariff row B' },
      { perKg: 70, currency: 'CNY', channel: 'ordinary route 5-7', postalZone: '5-7', tier: '23_70kg', routeEligible: true, batteryCompatible: false, sourceLocation: 'tariff row C' },
      { perKg: 65, currency: 'CNY', channel: 'battery route 8-9', postalZone: '8-9', tier: '23_70kg', routeEligible: true, batteryCompatible: true, sourceLocation: 'tariff row D' }
    ]
  };
  const regular = calculateAirFreightSensitivity(shipping);
  assert.equal(regular.conservative.result.ratePerKg, 70);
  assert.equal(regular.conservative.result.channel, 'ordinary route 5-7');
  assert.equal(regular.conservative.result.freightPerUnit, 105);
  const battery = calculateAirFreightSensitivity(shipping, { needsBatteryChannel: true });
  assert.equal(battery.conservative.result.ratePerKg, 65);
  assert.equal(battery.conservative.result.channel, 'battery route 8-9');
});

it('blocks ordinary routes while the SKU battery classification is still unknown', () => {
  const result = calculateProductPricing({
    model: 'helmet-unknown-battery', modelConfirmed: true, batteryType: 'unknown', batteryTypeConfirmed: false,
    cost: {}, fees: {},
    shipping: {
      volumetricDivisor: 5000, divisorConfirmed: true,
      cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }],
      rate: { perKg: 55.7, currency: 'CNY', channel: 'ordinary non-battery route', postalZone: '0-4', tier: '23_70kg',
        routeEligible: true, batteryCompatible: false, fxToUSD: 0.14, fxDate: '2026-09-29',
        magneticInspectionPerShipment: 0, otherPerShipment: 0, sourceLocation: 'fixture', confirmed: true }
    }
  });
  assert.equal(result.airFreight.selectedRateOption, null);
  assert.equal(result.airFreight.freightPerUnit, null);
  assert.match(result.airFreight.warning, /电池状态尚未排除/);
});

it('keeps 5000/6000 and CNY 0/480 freight sensitivities separate with an unknown fee', () => {
  const input = {
    volumetricDivisor: 6000, divisorConfirmed: false, confirmed: false,
    cartons: [{ cartonCount: 1, unitsPerCarton: 20, lengthCm: 57, widthCm: 46, heightCm: 56, grossKg: 7.6 }],
    rate: { currency: 'CNY', fxToUSD: 0.14, fxDate: '2026-09-29', magneticInspectionPerShipment: 480, magneticFeeApplicable: 'unknown', otherPerShipment: 0 },
    rateOptions: [{ perKg: 55.7, currency: 'CNY', channel: 'eligible test lane', postalZone: '0-4', tier: '23_70kg', routeEligible: true, sourceLocation: 'fixture row' }]
  };
  const result = calculateAirFreightSensitivity(input);
  assert.equal(result.scenarios.length, 4);
  assert.equal(result.conservative.volumetricDivisor, 5000);
  assert.equal(result.conservative.magneticInspectionPerShipmentCNY, 480);
  assert.equal(result.conservative.result.totalBillableKg, 30);
  assert.equal(result.conservative.result.freightPerUnit, 107.55);
  assert.equal(result.scenarios.find((scenario) => scenario.volumetricDivisor === 6000 && scenario.magneticInspectionPerShipmentCNY === 0).result.freightPerUnit, 69.63);
  assert.ok(result.conservative.result.missing.includes('magnetic-fee applicability (CNY 0 vs CNY 480 per-ticket scenarios)'));
  const confirmedDivisor = calculateAirFreightSensitivity({ ...input, divisorConfirmed: true });
  assert.equal(confirmedDivisor.conservative.volumetricDivisor, 6000);
  assert.equal(confirmedDivisor.conservative.result.totalBillableKg, 25);
});
