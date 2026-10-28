'use strict';

function addFreightSheets(workbook, productPricing) {
  const freight = workbook.addWorksheet('11_空运计费');
  const cartonsSheet = workbook.addWorksheet('12_外箱明细');
  const rateOptionsSheet = workbook.addWorksheet('13_费率候选');
  const freightSensitivitySheet = workbook.addWorksheet('14_运费敏感性');

  freight.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  freight.addRow(['型号', 'SKU/配置', '整票计费重 kg', '整票数量（顶）', '选定渠道/路线', '美国邮区', '选定重量档', '计算重量档', '适用运价 CNY/kg', '运价币种', '兑 USD 汇率', '磁检费情景 CNY/票', '其他票级费 CNY/票', '带电渠道核验', '货代费率确认', '整票空运费用 CNY（非全包）', 'CNY/顶', '空运 USD/顶（情景或确认）', '状态', '选定运价来源定位']);
  cartonsSheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  cartonsSheet.addRow(['型号', 'SKU/配置', '箱数', '每箱装顶数', '长 cm', '宽 cm', '高 cm', '单箱毛重 kg', '保守除数', '体积重 kg（保守）', '毛/体积较大值 kg（保守）', '单箱进位计费重 kg（保守）', '此箱型总计费重 kg（保守）', '此箱型总产品数', '公式说明', '体积重 kg @5000', '毛/体积较大值 kg @5000', '单箱进位 kg @5000', '此箱型总计费重 kg @5000', '体积重 kg @6000', '毛/体积较大值 kg @6000', '单箱进位 kg @6000', '此箱型总计费重 kg @6000']);
  const selectedRateKey = (option) => option ? [option.channel, option.postalZone, option.tier, option.perKg, option.sourceLocation].join('|') : '';
  const rateScenarioResult = (result, divisor, magneticFee) => result.freightSensitivity?.scenarios?.find((scenario) => scenario.volumetricDivisor === divisor
    && scenario.magneticInspectionPerShipmentCNY === magneticFee)?.result || null;
  const selectedOption = (productResult, divisor, magneticFee) => selectedRateKey(rateScenarioResult(productResult, divisor, magneticFee)?.selectedRateOption);
  rateOptionsSheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  rateOptionsSheet.addRow(['型号', 'SKU/配置', '渠道/路线', '邮区档', '实际重量档', 'CNY/kg', '路线已确认可承运', '带电渠道已确认', '仅作示例/候选', '5000情景选用', '6000情景选用', '费率来源/截图定位']);
  freightSensitivitySheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  freightSensitivitySheet.addRow(['型号', 'SKU/配置', '体积重除数 cm³/kg', '磁检费情景 CNY/票', '其他票级费 CNY/票', '整票数量（顶）', '计费重 kg', '实际重量档', '选定路线', '邮区档', '匹配费率重量档', '运价 CNY/kg', '整票空运费 CNY（非全包）', 'CNY/顶', 'USD/顶', '场景状态', '费率来源', '说明']);
  productPricing.forEach(({ product, result }, index) => {
    const summaryRow = index + 2;
    const shipping = product.shipping || {};
    const rate = shipping.rate || {};
    const validCartonRows = [];
    let validCartonIndex = 0;
    (shipping.cartons || []).forEach((carton) => {
      const cartonValues = [carton.cartonCount, carton.unitsPerCarton, carton.lengthCm, carton.widthCm, carton.heightCm, carton.grossKg].map(Number);
      const isValidCarton = cartonValues.every((value) => Number.isFinite(value) && value > 0)
        && Number.isInteger(cartonValues[0]) && Number.isInteger(cartonValues[1]);
      const detail = isValidCarton ? result.airFreight?.cartons?.[validCartonIndex++] : null;
      const cartonRowNumber = cartonsSheet.rowCount + 1;
      const row = cartonsSheet.addRow([
        product.model || '', product.cost?.variant || product.displayName || '', carton.cartonCount ?? '', carton.unitsPerCarton ?? '',
        carton.lengthCm ?? '', carton.widthCm ?? '', carton.heightCm ?? '', carton.grossKg ?? '', result.airFreight?.volumetricDivisor ?? 5000,
        detail ? { formula: `E${cartonRowNumber}*F${cartonRowNumber}*G${cartonRowNumber}/I${cartonRowNumber}`, result: detail.volumeWeightKg } : null,
        detail ? { formula: `MAX(H${cartonRowNumber},J${cartonRowNumber})`, result: detail.unroundedChargeableKg } : null,
        detail ? { formula: `IF(K${cartonRowNumber}<20,CEILING(K${cartonRowNumber},0.5),CEILING(K${cartonRowNumber},1))`, result: detail.billableKgPerCarton } : null,
        detail ? { formula: `L${cartonRowNumber}*C${cartonRowNumber}`, result: detail.totalBillableKg } : null,
        detail ? { formula: `C${cartonRowNumber}*D${cartonRowNumber}`, result: detail.totalUnits } : null,
        '每箱先 max(毛重,体积重)；<20kg 按 0.5kg、≥20kg 按 1kg 进位',
        detail ? { formula: `E${cartonRowNumber}*F${cartonRowNumber}*G${cartonRowNumber}/5000`, result: detail.volumeWeightKg } : null,
        detail ? { formula: `MAX(H${cartonRowNumber},P${cartonRowNumber})`, result: detail.unroundedChargeableKg } : null,
        detail ? { formula: `IF(Q${cartonRowNumber}<20,CEILING(Q${cartonRowNumber},0.5),CEILING(Q${cartonRowNumber},1))`, result: detail.billableKgPerCarton } : null,
        detail ? { formula: `R${cartonRowNumber}*C${cartonRowNumber}`, result: rateScenarioResult(result, 5000, 0)?.cartons?.[validCartonIndex - 1]?.totalBillableKg ?? detail.totalBillableKg } : null,
        detail ? { formula: `E${cartonRowNumber}*F${cartonRowNumber}*G${cartonRowNumber}/6000`, result: rateScenarioResult(result, 6000, 0)?.cartons?.[validCartonIndex - 1]?.volumeWeightKg ?? null } : null,
        detail ? { formula: `MAX(H${cartonRowNumber},T${cartonRowNumber})`, result: rateScenarioResult(result, 6000, 0)?.cartons?.[validCartonIndex - 1]?.unroundedChargeableKg ?? null } : null,
        detail ? { formula: `IF(U${cartonRowNumber}<20,CEILING(U${cartonRowNumber},0.5),CEILING(U${cartonRowNumber},1))`, result: rateScenarioResult(result, 6000, 0)?.cartons?.[validCartonIndex - 1]?.billableKgPerCarton ?? null } : null,
        detail ? { formula: `V${cartonRowNumber}*C${cartonRowNumber}`, result: rateScenarioResult(result, 6000, 0)?.cartons?.[validCartonIndex - 1]?.totalBillableKg ?? null } : null
      ]);
      if (detail) validCartonRows.push(row.number);
    });
    const detailsRange5000 = validCartonRows.length ? `'12_外箱明细'!S${validCartonRows[0]}:S${validCartonRows[validCartonRows.length - 1]}` : '';
    const details6000Range = validCartonRows.length ? `'12_外箱明细'!W${validCartonRows[0]}:W${validCartonRows[validCartonRows.length - 1]}` : '';
    const unitsRange = validCartonRows.length ? `'12_外箱明细'!N${validCartonRows[0]}:N${validCartonRows[validCartonRows.length - 1]}` : '';
    const air = result.airFreight || {};
    const detailsRange = air.volumetricDivisor === 6000 ? details6000Range : detailsRange5000;
    const selected = air.selectedRateOption || {};
    const hasRate = Number.isFinite(Number(air.ratePerKg)) && Number(air.ratePerKg) > 0 && air.totalBillableKg !== null;
    for (const divisor of [5000, 6000]) {
      const weightRange = divisor === 5000 ? detailsRange5000 : details6000Range;
      for (const fee of [0, 480]) {
        const scenario = rateScenarioResult(result, divisor, fee);
        const scenarioOption = scenario?.selectedRateOption || null;
        const scenarioRate = scenario?.ratePerKg;
        const scenarioUnits = scenario?.totalUnits;
        const scenarioWeight = scenario?.totalBillableKg;
        const scenarioFee = scenario?.magneticInspectionPerShipment ?? fee;
        const scenarioOtherFee = rate.otherPerShipment;
        const scenarioHasRate = Number.isFinite(Number(scenarioRate)) && Number(scenarioRate) > 0 && scenarioWeight !== null;
        const formulaWeight = weightRange && Number.isFinite(scenarioWeight) && Number.isFinite(scenarioUnits) && scenarioUnits > 0
          ? { formula: `SUM(${weightRange})`, result: scenarioWeight } : null;
        const sensitivityRowNumber = freightSensitivitySheet.rowCount + 1;
        freightSensitivitySheet.addRow([
          product.model || '', product.cost?.variant || product.displayName || '', divisor, scenarioFee ?? '',
          scenarioOtherFee ?? '', scenarioUnits ?? '', formulaWeight,
          scenario?.calculatedShipmentTier || '', scenarioOption?.channel || '', scenarioOption?.postalZone || '',
          scenarioOption?.tier || '', scenarioRate ?? '',
          scenarioHasRate ? { formula: `G${sensitivityRowNumber}*L${sensitivityRowNumber}+D${sensitivityRowNumber}+E${sensitivityRowNumber}`, result: scenario?.carrierCharge } : null,
          scenarioHasRate && scenarioUnits ? { formula: `IFERROR(M${sensitivityRowNumber}/F${sensitivityRowNumber},"")`, result: scenario?.freightPerUnit } : null,
          scenarioHasRate && scenario?.freightPerUnitUSD !== null ? { formula: `N${sensitivityRowNumber}*'11_空运计费'!K${index + 2}`, result: scenario?.freightPerUnitUSD } : null,
          scenario?.status || 'scenario_only', scenarioOption?.sourceLocation || '',
          `${fee ? '含¥480/票压力情景（非必收）' : '不含磁检费情景'}；不代表全包到岸成本`
        ]);
      }
    }
    const illustrative = result.freightSensitivity?.illustrativeExample;
    if (illustrative?.base && illustrative?.withMagneticPressure) {
      for (const [fee, scenario] of [[0, illustrative.base], [480, illustrative.withMagneticPressure]]) {
        const referenceRow = freightSensitivitySheet.rowCount + 1;
        freightSensitivitySheet.addRow([
          product.model || '', product.cost?.variant || product.displayName || '', 5000, fee, 0,
          scenario.totalUnits ?? '', scenario.totalBillableKg ?? '', scenario.calculatedShipmentTier || '',
          'PRD 条件示例；非可用路线', '', '路线/邮区/费档待核', illustrative.ratePerKgCNY,
          scenario.carrierCharge !== null ? { formula: `G${referenceRow}*L${referenceRow}+D${referenceRow}+E${referenceRow}`, result: scenario.carrierCharge } : null,
          scenario.freightPerUnit !== null ? { formula: `IFERROR(M${referenceRow}/F${referenceRow},"")`, result: scenario.freightPerUnit } : null,
          null, '仅示例；不可用于推荐价', illustrative.source,
          fee ? '假设 ¥480/票适用的压力情景；不是必收费，也不是到岸成本。' : '55.7 CNY/kg 条件示例，不代表可承运路线或最高合理运价。'
        ]);
      }
    }
    const productRateOptions = Array.isArray(shipping.rateOptions) ? shipping.rateOptions : [];
    const optionsForWorkbook = productRateOptions.length ? productRateOptions : (rate.perKg ? [rate] : []);
    optionsForWorkbook.forEach((option) => {
      const optionKey = selectedRateKey(option);
      rateOptionsSheet.addRow([
        product.model || '', product.cost?.variant || product.displayName || '', option.channel || '', option.postalZone || '', option.tier || '', option.perKg ?? '',
        option.routeEligible === true ? '是' : '否/未确认', option.batteryCompatible === true ? '是' : '否/未确认',
        option.candidateOnly === true ? '是；不得自动采用' : '否',
        optionKey && optionKey === selectedOption(result, 5000, 0) ? '是' : '否',
        optionKey && optionKey === selectedOption(result, 6000, 0) ? '是' : '否', option.sourceLocation || '来源定位待补'
      ]);
    });
    freight.addRow([
      product.model || '', product.cost?.variant || product.displayName || '',
      detailsRange && air.totalBillableKg !== null ? { formula: `SUM(${detailsRange})`, result: air.totalBillableKg } : null,
      unitsRange && air.totalUnits !== null ? { formula: `SUM(${unitsRange})`, result: air.totalUnits } : null,
      selected.channel || '', selected.postalZone || '', air.selectedRateTier || '',
      { formula: `IF(C${summaryRow}>=101,"101kg_plus",IF(C${summaryRow}>=71,"71_100kg",IF(C${summaryRow}>=23,"23_70kg",IF(C${summaryRow}>0,"below_23kg",""))))`, result: air.calculatedShipmentTier || '' },
      air.ratePerKg ?? '', air.currency || 'CNY', rate.fxToUSD ?? '', air.magneticInspectionPerShipment ?? '', rate.otherPerShipment ?? '',
      selected.channel ? (selected.batteryCompatible ? '已确认接带电' : product.batteryType === 'none' ? '无电配置' : '未确认/未纳入') : product.batteryType === 'none' && product.batteryTypeConfirmed ? '无电配置' : '未确认/未纳入',
      rate.confirmed ? '是' : '否',
      hasRate ? { formula: `C${summaryRow}*I${summaryRow}+L${summaryRow}+M${summaryRow}`, result: air.carrierCharge ?? 0 } : null,
      hasRate ? { formula: `IFERROR(P${summaryRow}/D${summaryRow},"")`, result: air.freightPerUnit ?? '' } : null,
      hasRate && air.freightPerUnitUSD !== null ? { formula: `Q${summaryRow}*K${summaryRow}`, result: air.freightPerUnitUSD } : null,
      air.status || 'scenario_only', selected.sourceLocation || rate.sourceLocation || rate.evidencePath || '适用货代来源待补'
    ]);
  });
  freight.columns = [16, 32, 16, 20, 28, 14, 18, 20, 14, 14, 16, 17, 16, 26, 20, 20, 18, 24, 18, 48].map((width) => ({ width }));
  cartonsSheet.columns = [16, 32, 10, 15, 12, 12, 12, 16, 14, 16, 22, 24, 25, 20, 64, 18, 23, 20, 25, 18, 23, 20, 25].map((width) => ({ width }));
  rateOptionsSheet.columns = [16, 32, 28, 14, 20, 14, 22, 20, 20, 20, 20, 60].map((width) => ({ width }));
  freightSensitivitySheet.columns = [16, 32, 20, 21, 21, 20, 16, 20, 28, 14, 20, 16, 24, 16, 16, 20, 50, 48].map((width) => ({ width }));
  for (let row = 2; row <= freightSensitivitySheet.rowCount; row += 1) {
    for (const column of [4, 5, 12, 13, 14, 15]) freightSensitivitySheet.getCell(row, column).numFmt = '0.00';
    freightSensitivitySheet.getCell(row, 3).numFmt = '0';
  }
  return { freight, cartonsSheet, rateOptionsSheet, freightSensitivitySheet };
}

module.exports = { addFreightSheets };
