'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { calculateProductPricing } = require('./pricing');
const { buildHelmetMarketWorkbook } = require('./helmet-market-workbook');
const { addFreightSheets } = require('./workbook-freight');

function cellPreview(cell) {
  const value = cell.value;
  let displayValue = value;
  if (value && typeof value === 'object' && value.text !== undefined) displayValue = value.text;
  else if (value && typeof value === 'object' && value.formula !== undefined) displayValue = value.result ?? '';
  const hyperlink = value && typeof value === 'object' && typeof value.hyperlink === 'string' ? value.hyperlink : '';
  return {
    row: cell.row,
    column: cell.col,
    address: cell.address,
    value: typeof value === 'object' ? displayValue : value,
    displayValue: displayValue === undefined || displayValue === null ? '' : String(displayValue),
    type: typeof value === 'number' ? 'number' : value instanceof Date ? 'date' : hyperlink ? 'hyperlink' : value ? 'string' : 'blank',
    hyperlink,
    style: {
      bold: Boolean(cell.font?.bold),
      color: cell.font?.color?.argb || '',
      fill: cell.fill?.fgColor?.argb || '',
      numberFormat: cell.numFmt || ''
    },
    mergeRange: ''
  };
}

function buildManifest(workbook, fileName, artifactId, job, imageEvidence = []) {
  const sheets = workbook.worksheets.map((sheet, index) => {
    const cells = [];
    sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => cells.push(cellPreview(cell))));
    const images = imageEvidence.filter((image) => image.sheetName === sheet.name).map((image) => ({
      row: image.row,
      column: image.column,
      fileName: image.fileName,
      sha256: image.sha256,
      altText: image.altText,
      imageUrl: `/api/reports/jobs/${encodeURIComponent(job.jobId)}/evidence/${encodeURIComponent(image.fileName)}`
    }));
    return {
      sheetId: `sheet-${index + 1}`,
      name: sheet.name,
      index,
      rowCount: sheet.actualRowCount,
      columnCount: sheet.actualColumnCount,
      frozenRows: sheet.views?.[0]?.ySplit || 0,
      frozenColumns: sheet.views?.[0]?.xSplit || 0,
      mergedRanges: sheet.model.merges || [],
      imageRefs: sheet.getImages().map((image) => image.imageId),
      imageEvidence: images,
      cells
    };
  });
  return {
    jobId: job.jobId,
    revision: job.revision,
    buildVersion: job.buildVersion,
    workbookId: job.workbookId,
    artifactId,
    fileName,
    sheetCount: sheets.length,
    generatedAt: new Date().toISOString(),
    previewVersion: 1,
    sheets
  };
}

async function buildWorkbookArtifacts(job, outputDir, options = {}) {
  const importedCandidates = job.analysis?.productCandidates || [];
  const helmetMarketAccessImport = job.helmetEvidence?.kind === 'private_helmet_market_access_v2'
    || importedCandidates.some((item) => item.trialImport?.kind === 'private_helmet_market_access_v2'
      || item.trialImport?.sampleId === 'helmet-mvp-trial-2026-09-29');
  if (job.taskType === 'track_analysis' && helmetMarketAccessImport) {
    return buildHelmetMarketWorkbook(job, outputDir, {
      manifestDir: options.manifestDir || outputDir,
      buildManifest,
      addFreightSheets
    });
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Report Center';
  workbook.subject = `${job.taskType} report`; 
  const summary = workbook.addWorksheet('00_研究说明');
  summary.mergeCells('A1:F1');
  summary.getCell('A1').value = job.taskType === 'pdf_catalog' ? 'PDF 目录分析报告' : '赛道品类分析报告';
  summary.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFF' } };
  summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '17324D' } };
  summary.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  const rows = [
    ['任务 ID', job.jobId], ['修订版本', job.revision], ['构建版本', job.buildVersion], ['数据边界', 'PDF 内部事实、用户确认事实、公开市场证据和模型推断分层保存'], ['状态', '人工确认后生成；未知品类不套用头盔规则']
  ];
  const trialImport = (job.analysis?.productCandidates || []).find((item) => item.trialImport)?.trialImport;
  if (trialImport) rows.push(['外部试采资料', `${trialImport.sampleId || '用户 JSON'}｜${trialImport.importedStatus}｜${trialImport.independentReviewStatus}`]);
  rows.forEach((row, index) => { summary.getCell(index + 3, 1).value = row[0]; summary.getCell(index + 3, 2).value = row[1]; });
  summary.columns = [{ width: 20 }, { width: 100 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];

  const products = workbook.addWorksheet('01_产品候选');
  products.views = [{ state: 'frozen', ySplit: 2, xSplit: 1, showGridLines: false }];
  products.addRow(['产品候选', '型号', '品类', '置信度', '页码证据', '缺失字段', '状态']);
  const candidates = job.analysis?.productCandidates || [];
  candidates.forEach((item) => products.addRow([item.displayName, item.model, item.categoryId, item.confidence, (item.sourcePageNumbers || []).join('/'), (item.missingFields || []).join('、'), item.status || '待人工确认']));
  products.columns = [{ width: 32 }, { width: 20 }, { width: 20 }, { width: 12 }, { width: 14 }, { width: 36 }, { width: 16 }];

  const brief = job.researchBrief || {};
  const settings = workbook.addWorksheet('02_研究设置');
  settings.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  settings.addRow(['字段', '值', '来源']);
  [
    ['品类', brief.category || '', '用户确认'],
    ['目标国家', brief.country || '', '用户确认'],
    ['目标站点', brief.marketplace || '', '用户确认'],
    ['受众', brief.audience || '', '用户确认'],
    ['价格带', brief.priceBand || '', '用户确认']
  ].forEach((row) => settings.addRow(row));
  (brief.researchQuestions || []).forEach((question, index) => settings.addRow([`研究问题 ${index + 1}`, question, '用户确认']));
  settings.columns = [{ width: 18 }, { width: 100 }, { width: 14 }];

  const groups = workbook.addWorksheet('03_市场分组');
  groups.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  groups.addRow(['分组', '关键词', '来源']);
  (brief.marketGroups || []).forEach((group) => groups.addRow([group.label || '', (group.keywords || []).join(', '), '用户确认']));
  if (!(brief.marketGroups || []).length) groups.addRow(['未设置市场分组', '', '需要人工确认']);
  groups.columns = [{ width: 24 }, { width: 80 }, { width: 14 }];

  const evidence = workbook.addWorksheet('04_证据索引');
  evidence.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  evidence.addRow(['证据 ID', '来源类型', '页码', '内容', '置信度']);
  (job.analysis?.pages || []).forEach((page) => evidence.addRow([`pdf-page-${page.pageNumber}`, 'pdf_internal', page.pageNumber, page.text || '图片页或未提取文本', page.text ? 'medium' : 'low']));
  evidence.columns = [{ width: 18 }, { width: 18 }, { width: 10 }, { width: 100 }, { width: 14 }];

  const boundary = workbook.addWorksheet('05_数据边界');
  boundary.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  boundary.addRow(['数据边界与使用限制']);
  [
    'PDF 内部事实、用户确认事实、公开市场证据和模型推断必须分层保存，不得混为同一事实来源。',
    '本工作簿不是合规、法律或利润结论；认证、成本、图片和产品结论仍需人工核验。',
    '导入的 2026-09-29 头盔试采 JSON 为未独立 MAX 审核草稿；其截图、成本、PDP 和评论在本工作簿中保留草稿/待确认状态。',
    '未确认的 UPS/FedEx 运价不作为净利润输入；未取得完整费率表时，不推断最高路线或实际运费。55.7 CNY/kg 仅为 H0-022 条件示例，不自动进入定价。',
    '空运敏感性并列体积重除数 5000/6000 与不含/假设含 ¥480/票；适用性未知时，¥480 仅为压力情景而非必收费。',
    '未知品类不套用头盔等特定品类标准；缺少规则包时必须人工确认，不编造标准。',
    '不伪造销量、GMV、市场份额或认证结论；公开数据只按观测口径展示。',
    `任务 ${job.jobId}｜修订 ${job.revision}｜构建版本 ${job.buildVersion}`
  ].forEach((line) => boundary.addRow([line]));
  boundary.columns = [{ width: 120 }];

  const productCandidates = job.analysis?.productCandidates || [];
  const byCandidate = new Map((job.pricingResults || []).map((row) => [row.candidateId, row.result]));
  const productPricing = productCandidates.map((product) => ({
    product,
    result: byCandidate.get(product.candidateId) || calculateProductPricing(product, product.competitors || [])
  }));

  const pricing = workbook.addWorksheet('06_逐款定价');
  const competitors = workbook.addWorksheet('07_竞品观察');
  const reviews = workbook.addWorksheet('08_评论原文与翻译');
  const assumptions = workbook.addWorksheet('09_用户产品与费用');
  const sources = workbook.addWorksheet('10_来源与待确认');
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

  pricing.views = [{ state: 'frozen', ySplit: 2, xSplit: 2, showGridLines: false }];
  pricing.addRow(['逐款定价与利润测算（USD；不完整费用只显示情景与剩余费用空间，不宣称净利润）']);
  pricing.mergeCells('A1:AG1');
  pricing.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  pricing.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '17324D' } };
  pricing.addRow([
    '型号', '用户 SKU / 配置', '采购成本USD', '空运USD/顶', '其他入仓USD', '包装USD', 'FBA/履约USD', '单件广告USD',
    '佣金率', '广告率', '退货率', '单件退货USD', '税率', '关税/固定税费USD', '其他固定成本USD', '折扣率', '固定CouponUSD',
    '目标利润率', '固定成本F', '销售额费率v', '相似品最低价', '相似品中位价', '相似品最高价', '保本标价', '目标利润标价',
    '推荐标价', '顾客付款S', '推荐价预估利润', '利润率', '状态', '决策说明', '剩余费用容量（情景非利润）', '空运保守假设与敏感性索引'
  ]);
  productPricing.forEach(({ product, result }, index) => {
    const fees = product.fees || {};
    const cost = product.cost || {};
    const rowNumber = index + 3;
    const assumptionsRow = index + 2;
    const freightRow = index + 2;
    const fx = Number(cost.fxToUSD);
    const purchaseUsd = Number(cost.amount) * fx;
    const complete = result.status !== 'incomplete' && result.status !== 'invalid_assumptions';
    const val = (value, pct = false) => Number.isFinite(Number(value)) ? (pct ? Number(value) / 100 : Number(value)) : null;
    const values = [
      product.model || '', product.cost?.variant || product.displayName || '', Number.isFinite(purchaseUsd) && purchaseUsd > 0
        ? { formula: `'09_用户产品与费用'!C${assumptionsRow}*'09_用户产品与费用'!H${assumptionsRow}`, result: purchaseUsd } : null,
      Number.isFinite(Number(result.airFreight?.freightPerUnitUSD)) ? { formula: `'11_空运计费'!R${freightRow}`, result: Number(result.airFreight.freightPerUnitUSD) } : null,
      val(fees.inboundPerUnit), val(fees.packagingPerUnit), val(fees.fulfillmentPerUnit), val(fees.adPerUnit),
      val(fees.referralRatePct, true), val(fees.adRatePct, true), val(fees.returnRatePct, true), val(fees.returnPerUnit),
      val(fees.taxRatePct, true), val(fees.taxPerUnit), val(fees.otherPerUnit), val(fees.discountRatePct, true),
      val(fees.couponFixed), val(fees.targetMarginPct, true)
    ];
    values.push(complete ? { formula: `SUM(C${rowNumber}:H${rowNumber})+L${rowNumber}+N${rowNumber}+O${rowNumber}`, result: result.fixedCost } : null);
    values.push(complete ? { formula: `SUM(I${rowNumber}:K${rowNumber})+M${rowNumber}`, result: Number(result.variableRatePct) / 100 } : null);
    values.push(result.market?.min);
    values.push(result.market?.median);
    values.push(result.market?.max);
    values.push(complete ? { formula: `(S${rowNumber}/(1-T${rowNumber})+Q${rowNumber})/(1-P${rowNumber})`, result: result.breakEvenListPrice } : null);
    values.push(complete ? { formula: `(S${rowNumber}/(1-T${rowNumber}-R${rowNumber})+Q${rowNumber})/(1-P${rowNumber})`, result: result.targetProfitListPrice } : null);
    values.push(result.recommendedListPrice);
    values.push(result.recommendedListPrice === null || result.recommendedListPrice === undefined ? null
      : { formula: `Z${rowNumber}*(1-P${rowNumber})-Q${rowNumber}`, result: result.profitAtRecommendation?.customerPayment ?? 0 });
    values.push(result.recommendedListPrice === null || result.recommendedListPrice === undefined ? null
      : { formula: `AA${rowNumber}*(1-T${rowNumber})-S${rowNumber}`, result: result.profitAtRecommendation?.profit ?? 0 });
    values.push(result.recommendedListPrice === null || result.recommendedListPrice === undefined ? null
      : { formula: `IFERROR(AB${rowNumber}/AA${rowNumber},0)`, result: result.profitAtRecommendation?.marginRatePct === null || result.profitAtRecommendation?.marginRatePct === undefined ? 0 : result.profitAtRecommendation.marginRatePct / 100 });
    values.push(result.status);
    values.push(result.decision || (result.missing || []).join('; '));
    values.push(result.feeHeadroomAtMarketUpper);
    const conservativeFreight = result.freightSensitivity?.conservative;
    const scenarioSummary = (result.freightSensitivity?.scenarios || []).map((scenario) => {
      const amount = scenario.result.freightPerUnit === null ? 'rate pending' : `CNY ${scenario.result.freightPerUnit.toFixed(2)}/unit`;
      return `${scenario.volumetricDivisor}/${scenario.magneticInspectionPerShipmentCNY ? 'CNY480 fee scenario' : 'CNY0'}=${amount}`;
    }).join('; ');
    values.push(conservativeFreight
      ? `Cost input: divisor ${conservativeFreight.volumetricDivisor}; magnetic fee CNY ${conservativeFreight.magneticInspectionPerShipmentCNY}/shipment${result.airFreight?.magneticFeeApplicable === 'unknown' ? ' (applicability unknown; 480 is pressure-only)' : ''}. See 14_运费敏感性: ${scenarioSummary}. Not landed cost.`
      : 'Air-freight tariff/outer-carton inputs incomplete; see 11–14 freight sheets.');
    pricing.addRow(values);
  });
  pricing.columns = [
    { width: 16 }, { width: 38 }, ...Array.from({ length: 27 }, () => ({ width: 16 })), { width: 22 }, { width: 76 }, { width: 32 }, { width: 92 }
  ];
  pricing.getRow(2).font = { bold: true, color: { argb: '17324D' } };
  pricing.autoFilter = 'A2:AG2';
  for (let rowIndex = 3; rowIndex <= pricing.rowCount; rowIndex += 1) {
    for (const column of [3, 4, 5, 6, 7, 8, 12, 14, 15, 17, 21, 22, 23, 24, 25, 26, 27, 28, 32]) pricing.getCell(rowIndex, column).numFmt = '$0.00';
    for (const column of [9, 10, 11, 13, 16, 18, 20, 29]) pricing.getCell(rowIndex, column).numFmt = '0.00%';
  }

  competitors.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  competitors.addRow(['对应型号', 'ASIN', '商品链接', '标题', '品牌', '所选变体/配置', 'PDP价 USD', 'Coupon/促销', '相似性', '理由', '价格来源', '页面状态', '观察时间', '审核确认', '截图证据', '证据SHA-256', 'PDP/促销来源说明']);
  const discoveredByCandidate = new Map((job.researchData?.byProduct || []).map((item) => [item.candidateId, item]));
  for (const product of productCandidates) {
    for (const item of product.competitors || []) {
      competitors.addRow([
        product.model || '', item.asin || '', item.url || '', item.title || '', item.brand || '', item.variantLabel || '',
        item.priceStatus === 'observed' || item.priceStatus === 'user_evidence' || item.priceStatus === 'draft_unverified' ? item.price : null,
        item.coupon || '', item.similarity || 'unreviewed', item.similarityReason || '', item.observedSource || item.sourceType || '',
        `${item.pageStatus || ''} / ${item.priceStatus || ''}`, item.observedAt || '', item.matchConfirmed ? '是' : '否', item.screenshotPath || item.screenshotReference || '', item.screenshotSha256 || '', item.sourceNote || ''
      ]);
    }
    const discovered = discoveredByCandidate.get(product.candidateId);
    for (const item of discovered?.records || []) {
      const selected = (product.competitors || []).some((chosen) => chosen.asin === item.asin);
      if (selected) continue;
      competitors.addRow([
        product.model || '', item.asin || '', item.url || '', item.title || '', item.brand || '', item.selectedVariant || '',
        item.pageStatus === 'parsed' && item.priceStatus === 'observed' ? item.price : null,
        item.coupon || '', '待人工判断', 'Amazon 搜索用于发现候选；必须人工确认相似性和所选变体。',
        item.sourceType === 'amazon_public_product' ? 'Amazon PDP' : 'Amazon 搜索页（仅发现，不用于定价）',
        item.pageStatus || '', item.observedAt || '', '否', '', '', ''
      ]);
    }
    if (discovered?.errors?.length) discovered.errors.forEach((error) => competitors.addRow([product.model || '', '', '', '', '', '', null, '', '未获取', error.message || error.code, 'Amazon 前台请求', 'unavailable', discovered.observedAt || '', '否', '', '', '']));
  }
  competitors.columns = [16, 14, 44, 44, 22, 28, 15, 22, 16, 58, 38, 26, 24, 14, 40, 68, 88].map((width) => ({ width }));
  competitors.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  competitors.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '17324D' } };

  reviews.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  reviews.addRow(['用户型号', 'ASIN', '来源状态', '星级', '评论者', '所选评论变体', '英文标题', '英文原文', '中文翻译', '评论ID', '评论链接', '评论日期', '观察时间', '原始来源说明', '评论备注', '翻译状态']);
  for (const product of productCandidates) {
    for (const competitor of product.competitors || []) {
      const samples = Array.isArray(competitor.reviewsVisible) ? competitor.reviewsVisible : [];
      const chosen = [...samples.filter((review) => Number(review.rating) >= 4).slice(0, 3), ...samples.filter((review) => Number(review.rating) >= 1 && Number(review.rating) <= 3).slice(0, 3)];
      const highCount = samples.filter((review) => Number(review.rating) >= 4).length;
      const lowCount = samples.filter((review) => Number(review.rating) >= 1 && Number(review.rating) <= 3).length;
      const sourceStatus = competitor.sourceType === 'user_trial_draft' || competitor.reviewDataStatus?.startsWith('trial_draft')
        ? '试采 JSON 草稿导入；待独立复核' : competitor.sourceType === 'amazon_public_product' ? 'Amazon 前台采集' : '用户提供/待核';
      reviews.addRow([product.model || '', competitor.asin || '', `${sourceStatus} · 高星 ${highCount}/3 · 低星 ${lowCount}/3`, '', '', '', '', '', '', '', '', '', competitor.observedAt || '', competitor.reviewDataStatus || 'not_requested', competitor.reviewGap || '', '每类最多 3 条；样本不足不补造']);
      if (!chosen.length) reviews.addRow([product.model || '', competitor.asin || '', competitor.reviewDataStatus || 'not_requested', '', '', '', '', '', '', '', '', '', competitor.observedAt || '', '', competitor.reviewGap || '评论未获取', '未获取；不补造样本']);
      chosen.forEach((review) => reviews.addRow([
        product.model || '', competitor.asin || '', sourceStatus, review.rating, review.reviewer || '', review.selectedReviewVariant || '', review.title || '', review.text || '',
        review.chineseTranslation || '', review.reviewId || '', review.reviewUrl || '', review.date || '', review.observedAt || competitor.observedAt || '',
        review.sourceStatus || '', review.note || '',
        review.chineseTranslation ? '已提供翻译' : '未翻译'
      ]));
    }
  }
  if (reviews.rowCount === 1) reviews.addRow(['', '', '未获取评论样本。M1定价不依赖评论；不会以缺失评论补造原文。']);
  reviews.columns = [16, 14, 40, 10, 24, 38, 36, 100, 100, 28, 56, 24, 34, 54, 76, 24].map((width) => ({ width }));

  assumptions.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  assumptions.addRow(['型号', '用户 SKU / 配置', '采购成本候选', '币种', '单位', '价格条款', '适用变体', '兑 USD 汇率', '汇率日期/来源', '成本确认', '成本来源类型', '来源定位（图/页/行）', '成本截图', '成本图 SHA-256', '其他入仓USD/顶', '包装USD/顶', 'FBA/履约USD', '佣金率', '单件广告USD', '广告率', '单件退货USD', '退货率', '税/关税USD', '销售税率', '其他固定USD', '折扣率', '固定CouponUSD', '目标利润率', '费用确认', '型号确认', '电池类型', '电池核验', '空运确认状态', '货代来源定位']);
  for (const product of productCandidates) {
    const c = product.cost || {};
    const f = product.fees || {};
    const ship = product.shipping || {};
    assumptions.addRow([
      product.model || '', c.variant || product.displayName || '', c.amount ?? '', c.currency || '', c.unit || '', c.incoterm || '', c.variant || '', c.fxToUSD ?? '', c.fxDate || '',
      c.confirmed ? '是' : '否', c.sourceType || '待录入', `${c.sourceLocation || ''}${c.sourcePageNumber ? `；PDF p.${c.sourcePageNumber}` : ''}${c.evidenceText ? `；${c.evidenceText}` : ''}`,
      c.evidencePath || '', c.evidenceSha256 || '',
      f.inboundPerUnit ?? '', f.packagingPerUnit ?? '', f.fulfillmentPerUnit ?? '', f.referralRatePct === null || f.referralRatePct === undefined ? '' : Number(f.referralRatePct) / 100,
      f.adPerUnit ?? '', f.adRatePct === null || f.adRatePct === undefined ? '' : Number(f.adRatePct) / 100,
      f.returnPerUnit ?? '', f.returnRatePct === null || f.returnRatePct === undefined ? '' : Number(f.returnRatePct) / 100,
      f.taxPerUnit ?? '', f.taxRatePct === null || f.taxRatePct === undefined ? '' : Number(f.taxRatePct) / 100,
      f.otherPerUnit ?? '', f.discountRatePct === null || f.discountRatePct === undefined ? '' : Number(f.discountRatePct) / 100,
      f.couponFixed ?? '', f.targetMarginPct === null || f.targetMarginPct === undefined ? '' : Number(f.targetMarginPct) / 100,
      f.confirmed ? '是' : '否', product.modelConfirmed ? '是' : '否', product.batteryType || '待确认', product.batteryTypeConfirmed ? '是' : '否',
      ship.confirmed && ship.rate?.confirmed && ship.divisorConfirmed ? '货代规则已确认' : '仅情景/待核', ship.rate?.sourceLocation || ship.rate?.evidencePath || ''
    ]);
  }
  assumptions.addRow([]);
  assumptions.addRow(['公式与边界']);
  assumptions.addRow(['顾客付款', 'S = 标价 × (1 - 折扣率) - 固定Coupon']);
  assumptions.addRow(['空运计费', '每外箱 max(毛重,体积重)；<20kg 按 0.5kg、≥20kg 按 1kg 进位；整票累加后按箱内顶数分摊。']);
  assumptions.addRow(['固定成本', 'F = 单件采购成本USD + 空运USD/顶 + 其他入仓 + 包装 + FBA/履约 + 单件广告 + 单件退货 + 税/关税 + 其他固定成本']);
  assumptions.addRow(['销售额费率', 'v = Amazon佣金率 + 按销售额计广告率 + 按销售额计退货准备率 + 适用销售额税率']);
  assumptions.addRow(['单件利润', 'profit = S × (1 - v) - F；利润率 = profit / S']);
  assumptions.addRow(['保本标价', '(F / (1 - v) + 固定Coupon) / (1 - 折扣率)']);
  assumptions.addRow(['目标利润标价', '(F / (1 - v - 目标利润率) + 固定Coupon) / (1 - 折扣率)；分母必须 > 0']);
  assumptions.addRow(['不完整费用', '若 FBA/佣金/广告/税费/空运规则缺失，只显示待核情景与市场上沿剩余可容纳费用；不称为净利润。']);
  assumptions.columns = [16, 34, 16, 12, 18, 20, 28, 16, 26, 14, 24, 42, 40, 68, 19, 16, 18, 14, 18, 14, 18, 14, 18, 14, 18, 14, 18, 16, 14, 14, 18, 14, 22, 42].map((width) => ({ width }));
  for (let rowIndex = 2; rowIndex <= assumptions.rowCount; rowIndex += 1) {
    for (const column of [18, 20, 22, 24, 26, 28]) assumptions.getCell(rowIndex, column).numFmt = '0.00%';
  }

  sources.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  sources.addRow(['型号', '数据项', '状态', '来源/时间', '待办事项']);
  for (const product of productCandidates) {
    const result = byCandidate.get(product.candidateId) || calculateProductPricing(product, product.competitors || []);
    const importedCompetitors = (product.competitors || []).filter((item) => item.sourceType === 'user_trial_draft');
    sources.addRow([product.model || '', '型号与采购成本', product.modelConfirmed && product.cost?.confirmed ? '用户确认' : '待人工确认', product.cost?.evidenceText || '用户填写', [product.cost?.unit, product.cost?.incoterm, product.cost?.variant, product.cost?.fxDate].filter(Boolean).join(' / ') || '补齐单位、条款、变体、汇率日期']);
    sources.addRow([product.model || '', 'Amazon研究', discoveredByCandidate.get(product.candidateId)?.status || (importedCompetitors.length ? `试采草稿导入 ${importedCompetitors.length} 条；待独立复核` : '未执行'), discoveredByCandidate.get(product.candidateId)?.query || importedCompetitors.map((item) => item.asin).join(' / '), (discoveredByCandidate.get(product.candidateId)?.errors || []).map((error) => error.message || error.code).join('；')]);
    sources.addRow([product.model || '', '相似竞品与价格带', result.market?.sampleCount ? `已确认 ${result.market.sampleCount} 款` : '缺少已确认相似品 PDP 价格', '', result.missing?.join('；') || '补充/确认 3–5 个可比ASIN；样本不足时注明']);
    sources.addRow([product.model || '', '定价决策', result.status, '', result.decision || (result.missing || []).join('；')]);
  }
  sources.columns = [18, 26, 34, 68, 88].map((width) => ({ width }));

  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `${job.taskType}-${job.jobId}-${job.buildVersion}.xlsx`;
  const filePath = path.join(outputDir, fileName);
  await workbook.xlsx.writeFile(filePath);
  const artifactId = crypto.createHash('sha256').update(`${job.jobId}:${job.buildVersion}:${fileName}`).digest('hex').slice(0, 24);
  const manifest = buildManifest(workbook, fileName, artifactId, job);
  const manifestPath = path.join(outputDir, `${artifactId}.manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { workbookId: job.workbookId, artifactId, fileName, filePath, manifestPath, manifest };
}

module.exports = { buildManifest, buildWorkbookArtifacts };
