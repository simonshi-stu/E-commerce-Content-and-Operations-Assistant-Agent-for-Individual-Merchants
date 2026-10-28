'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { validateImageBuffer } = require('./helmet-trial-import');

const NAVY = '17324D';
const TEAL = '0F766E';
const PALE_BLUE = 'EAF1F7';
const PALE_AMBER = 'FFF4D6';
const MUTED = '5B6573';
const SOFT_RED = 'FCE8E6';

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function safeAmazonUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['amazon.com', 'www.amazon.com', 'smile.amazon.com'].includes(url.hostname.toLowerCase())
      && ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function linkValue(label, url) {
  const hyperlink = safeAmazonUrl(url);
  return hyperlink ? { text: String(label), hyperlink, tooltip: hyperlink } : String(label || '');
}

function title(sheet, lastColumn, value, note = '') {
  sheet.mergeCells(1, 1, 1, lastColumn);
  sheet.getCell(1, 1).value = value;
  sheet.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  sheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  sheet.getRow(1).height = 30;
  if (note) {
    sheet.mergeCells(2, 1, 2, lastColumn);
    sheet.getCell(2, 1).value = note;
    sheet.getCell(2, 1).font = { color: { argb: MUTED }, italic: true, size: 10 };
    sheet.getCell(2, 1).alignment = { wrapText: true, vertical: 'middle' };
    sheet.getRow(2).height = 38;
  }
}

function header(sheet, rowNumber, labels) {
  const row = sheet.getRow(rowNumber);
  labels.forEach((label, index) => {
    const cell = row.getCell(index + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  row.height = 40;
}

function formatBody(sheet, startRow, endRow, startColumn, endColumn) {
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber % 2 === 0) {
      for (let column = startColumn; column <= endColumn; column += 1) {
        sheet.getCell(rowNumber, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F5F8FB' } };
      }
    }
  }
}

function sourceEvidenceFile(job, evidencePath) {
  if (!evidencePath) return null;
  const relative = String(evidencePath).replace(/\\/g, '/');
  if (!/^evidence\/[a-zA-Z0-9_-]+\.(?:png|jpg)$/i.test(relative)) {
    throw Object.assign(new Error(`Invalid image evidence path: ${relative}`), { code: 'invalid_image_path' });
  }
  const evidenceRoot = path.resolve(job.jobDir, 'evidence');
  const filePath = path.resolve(job.jobDir, relative);
  if (!filePath.startsWith(evidenceRoot + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw Object.assign(new Error(`Image evidence file is missing or outside the task evidence directory: ${relative}`), { code: 'invalid_image_path' });
  }
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  validateImageBuffer(buffer, extension === 'jpg' ? '.jpg' : '.png');
  return {
    buffer,
    fileName: path.basename(filePath),
    relativePath: relative,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    extension: extension === 'jpg' ? 'jpeg' : extension
  };
}

function imageDimensions(buffer, extension) {
  if (extension === 'png' && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (extension === 'jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return { width: 1200, height: 800 };
}

function fitImage(buffer, extension, maxWidth, maxHeight) {
  const size = imageDimensions(buffer, extension);
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height, 1);
  return { width: Math.max(1, size.width * scale), height: Math.max(1, size.height * scale) };
}

function embedEvidence(workbook, sheet, job, imageEvidence, imageIdByHash, evidencePath, row, column, altText, maxWidth = 320, maxHeight = 150) {
  const evidence = sourceEvidenceFile(job, evidencePath);
  if (!evidence) return null;
  let imageId = imageIdByHash.get(evidence.sha256);
  if (imageId === undefined) {
    imageId = workbook.addImage({ buffer: evidence.buffer, extension: evidence.extension });
    imageIdByHash.set(evidence.sha256, imageId);
  }
  const size = fitImage(evidence.buffer, evidence.extension, maxWidth, maxHeight);
  sheet.addImage(imageId, { tl: { col: column - 1, row: row - 1 }, ext: size });
  imageEvidence.push({
    sheetName: sheet.name,
    row,
    column,
    fileName: evidence.fileName,
    path: evidence.relativePath,
    sha256: evidence.sha256,
    altText
  });
  return evidence;
}

function productCandidates(job) {
  return Array.isArray(job.analysis?.productCandidates) ? job.analysis.productCandidates : [];
}

function modelRows(products) {
  const result = new Map();
  for (const product of products) {
    if (!result.has(product.model)) result.set(product.model, []);
    result.get(product.model).push(product);
  }
  return result;
}

function configProfile(product) {
  const selectedConfiguration = String(product.cost?.variant || product.displayName || '').toLowerCase();
  const productFacts = String(product.productDescriptionFromScreenshot || '').toLowerCase();
  const combined = `${selectedConfiguration} ${productFacts}`;
  const noRechargeable = /no rechargeable/.test(selectedConfiguration);
  const rechargeable = !noRechargeable && /rechargeable|charging light/.test(selectedConfiguration);
  const buttonCell = /button[ -]cell|coin[ -]cell/.test(selectedConfiguration);
  const led = /\bled\b/.test(selectedConfiguration) && !rechargeable && !buttonCell;
  const noLight = !rechargeable && !buttonCell && !led && /no (?:rechargeable )?light|non[- ]light/.test(selectedConfiguration);
  return {
    noLight,
    rechargeable,
    buttonCell,
    led,
    magneticGoggles: /magnetic|goggle/.test(combined),
    urban: /urban|commuter/.test(combined),
    ordinaryColor: /ordinary color/.test(selectedConfiguration),
    colorChanging: /color[- ]changing|photochromic/.test(selectedConfiguration),
    road: /road|cycling|standard helmet/.test(combined)
  };
}

function configurationMatchesCoverage(product, coverage) {
  if (!(coverage.targets || []).includes(product.model)) return false;
  const target = String(coverage.configuration || '').toLowerCase();
  const profile = configProfile(product);
  if (/ordinary[- ]color/.test(target)) return profile.ordinaryColor;
  if (/color[- ]changing|photochromic/.test(target)) return profile.colorChanging;
  if (/rechargeable/.test(target)) return profile.rechargeable && profile.magneticGoggles;
  if (/button[- ]cell\s*\+\s*magnetic|button[- ]cell light \(44/.test(target)) return profile.buttonCell && profile.magneticGoggles;
  if (/button[- ]cell rear light/.test(target)) return profile.buttonCell;
  if (/button[- ]cell\/led[- ]light option/.test(target)) return profile.buttonCell || profile.led;
  if (/magnetic goggles \+ rear led\/light where battery subtype/.test(target)) {
    return profile.magneticGoggles && profile.led;
  }
  if (/magnetic goggles\/visor, no light/.test(target)) return profile.noLight && profile.magneticGoggles;
  if (/led\/light where battery subtype/.test(target)) return profile.led && profile.magneticGoggles;
  if (/urban\/commuter/.test(target)) return profile.urban;
  if (/road helmet, no light/.test(target)) return profile.noLight && !profile.magneticGoggles;
  if (/adult standard (?:cycling )?helmet, no light/.test(target)) return profile.noLight && !profile.magneticGoggles && !profile.urban;
  return false;
}

function coverageRelationship(coverage) {
  const detail = String(coverage.coverage || '').toLowerCase();
  if (/adjacent|analogue|analog|feature-comparable|not a strict|no strict|only one adjacent|power-source differences/.test(detail)) return '邻近/功能参照';
  if (/similar|close/.test(detail)) return '相似配置观察（非同型号；外形/细节仍有差异）';
  return '邻近/功能参照';
}

function mappedConfigurationObservations(product, pdps, coverageGroups) {
  const associations = [];
  const profile = configProfile(product);
  if (coverageGroups.length) {
    for (const coverage of coverageGroups) {
      if (!configurationMatchesCoverage(product, coverage)) continue;
      for (const asin of coverage.sharedComparatorAsins || []) {
        const pdp = pdps.find((item) => item.asin === String(asin).toUpperCase());
        if (!pdp) continue;
        const decision = coverage.asinDecisions?.[String(asin).toUpperCase()] || {};
        const colorChangingAgainstOrdinary = profile.colorChanging && /ordinary[- ]color/.test(String(coverage.configuration || '').toLowerCase());
        associations.push({
          product,
          pdp,
          relation: colorChangingAgainstOrdinary ? '邻近/普通色参照（不验证变色配置）' : decision.relation || coverageRelationship(coverage),
          coverageConfiguration: String(coverage.configuration || ''),
          reason: colorChangingAgainstOrdinary
            ? '该 PDP 仅覆盖普通色基础款；来源明确没有确认 photochromic/color-changing 对照，不计入变色配置价格样本。'
            : String(decision.reason || coverage.coverage || ''),
          strictConfigurationKey: `${product.model}|${product.cost?.variant || product.displayName || ''}`
        });
      }
    }
    return associations;
  }
  for (const item of product.competitors || []) {
    const pdp = pdps.find((record) => record.asin === String(item.asin || '').toUpperCase());
    if (!pdp) continue;
    associations.push({
      product,
      pdp,
      relation: item.similarity === 'similar' && item.matchConfirmed === true
        ? '相似配置观察（非同型号；待独立复核）' : '邻近/功能参照',
      coverageConfiguration: String(product.cost?.variant || product.displayName || ''),
      reason: String(item.similarityReason || '当前任务未保存配置级匹配依据。'),
      strictConfigurationKey: `${product.model}|${product.cost?.variant || product.displayName || ''}`
    });
  }
  return associations;
}

function configurationPriceSamples(product, pdps, coverageGroups) {
  return mappedConfigurationObservations(product, pdps, coverageGroups)
    .filter((item) => item.relation.startsWith('相似配置') && Number(item.pdp.price?.amount) > 0 && Boolean(item.pdp.screenshotPath));
}

function collectLegacyPdpRecords(products) {
  const byAsin = new Map();
  for (const product of products) {
    for (const item of product.competitors || []) {
      const asin = String(item.asin || '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, {
        asin,
        brand: String(item.brand || ''),
        title: String(item.title || ''),
        url: safeAmazonUrl(item.url),
        observationKind: '网站任务已保存观察',
        observedAtLocal: String(item.observedAt || ''),
        selectedVariant: item.selectedVariant || item.variantLabel || '',
        price: { amount: Number(item.price) || null, currency: item.currency || 'USD', displayedText: Number(item.price) > 0 ? `US$${Number(item.price).toFixed(2)}` : '' },
        rating: { value: null, count: null },
        monthlyBoughtLabel: '',
        bsrText: '',
        bsrStatus: '来源未记录',
        screenshotPath: item.screenshotPath || '',
        screenshotSourcePath: item.screenshotReference || '',
        screenshotFileName: '',
        screenshotSha256: item.screenshotSha256 || '',
        screenshotStatus: item.screenshotPath ? 'website_task_copy' : 'screenshot_not_recorded',
        matchedTargets: [],
        matchLevel: String(item.similarity || 'unreviewed'),
        matchReason: String(item.similarityReason || ''),
        reviewStatus: String(item.reviewDataStatus || '')
      });
    }
  }
  return [...byAsin.values()];
}

function collectReviews(job, pdps) {
  if (Array.isArray(job.helmetEvidence?.reviews)) return job.helmetEvidence.reviews;
  const output = [];
  const seen = new Set();
  for (const product of productCandidates(job)) {
    for (const competitor of product.competitors || []) {
      for (const review of competitor.reviewsVisible || []) {
        const key = review.reviewId || `${competitor.asin}|${review.title}|${review.date}`;
        const englishOriginal = String(review.text || '').trim();
        const chineseTranslation = String(review.chineseTranslation || '').trim();
        if (seen.has(key) || !englishOriginal || !chineseTranslation) continue;
        seen.add(key);
        output.push({
          asin: String(competitor.asin || '').toUpperCase(), reviewId: String(review.reviewId || ''),
          reviewUrl: safeAmazonUrl(review.reviewUrl), rating: Number(review.rating), title: String(review.title || ''),
          reviewer: String(review.reviewer || ''), date: String(review.date || ''), observedAtLocal: String(review.observedAt || ''),
          selectedVariant: String(review.selectedReviewVariant || ''), englishOriginal, chineseTranslation,
          textKind: '已保存原文及译文', sourceStatus: String(review.sourceStatus || '评论来源待核'), note: String(review.note || ''),
          sourceDocument: '网站私有任务保存样本'
        });
      }
    }
  }
  return output;
}

function allAssociations(products, pdps, coverageGroups) {
  return products.flatMap((product) => mappedConfigurationObservations(product, pdps, coverageGroups));
}

function pdpRatingSignal(pdp) {
  const rating = pdp.rating?.value ? `${pdp.rating.value}★/${pdp.rating.count ?? '人数未记录'}` : '评分/人数未记录';
  const monthly = pdp.monthlyBoughtLabel ? `月购原文“${pdp.monthlyBoughtLabel}”` : '月购标签未记录（不是 0）';
  const promotion = pdp.price?.otherPromotion ? `；促销原文：${pdp.price.otherPromotion}` : '';
  return `${pdp.brand || '品牌未记录'} ${pdp.asin}｜${pdp.title || 'PDP 标题未记录'}｜${pdp.price?.displayedText || '价格未记录'}｜${rating}｜${monthly}${promotion}`;
}

function pdpSelectedVariant(pdp) {
  return typeof pdp.selectedVariant === 'string' ? pdp.selectedVariant : JSON.stringify(pdp.selectedVariant || {});
}

function reviewQuoteSnippets(review, mode = 'all') {
  const original = String(review.englishOriginal || '').replace(/\s+/g, ' ').trim();
  const sentences = (original.match(/[^.!?]+(?:[.!?]+|$)/g) || [original]).map((item) => item.trim()).filter(Boolean);
  const concernPattern = /\btight\b|difficult|not the brightest|isn['’]t the brightest|isn['’]t rechargeable|is not rechargeable|annoy|dead the next|replacement batter|harder to|didn't find|do not like|don't like|dont like|took it off|no protrusion|no way to|too dark|not bright|ran out very quickly|difficult to replace|not useful|wasn't useful|wasn['’]t useful/i;
  const positivePattern = /comfortable|fit|lightweight|ventilat|magnetic|goggle|visor|adjust|visible|quality|value|great|love|recommend|air flow|airflow/i;
  const positive = sentences.find((sentence) => positivePattern.test(sentence) && !concernPattern.test(sentence));
  const concerns = sentences.filter((sentence) => concernPattern.test(sentence)).slice(0, 2);
  const selected = mode === 'positive' ? [positive].filter(Boolean)
    : mode === 'concern' ? concerns
      : [...new Set([positive, ...concerns].filter(Boolean))];
  const fallback = selected.length ? selected : mode === 'all' ? sentences.slice(0, 1) : [];
  return fallback.map((sentence) => sentence.length > 210 ? `${sentence.slice(0, 207).trimEnd()}…` : sentence);
}

function summarizeReviewEvidence(related, reviews, { adjacent = false, mode = 'all' } = {}) {
  const eligibleAsins = new Set(related.map((item) => item.pdp.asin));
  const rows = reviews.filter((review) => eligibleAsins.has(review.asin));
  if (!rows.length) return adjacent
    ? '所列邻近 PDP 无已保存的双语评论样本；不推断口碑。'
    : '没有直接相似配置 PDP 的已保存评论；不得据此宣称好评或差评。';
  const counts = new Map();
  for (const row of rows) counts.set(Number(row.rating), (counts.get(Number(row.rating)) || 0) + 1);
  const countText = [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([stars, count]) => `${stars}★×${count}`).join('、');
  const lowStars = rows.filter((row) => Number(row.rating) >= 1 && Number(row.rating) <= 3).length;
  const lines = rows.map((review) => {
    const quote = reviewQuoteSnippets(review, mode).map((item) => `“${item}”`).join('；')
      || (mode === 'concern' ? '该条样本未提取到明确问题原句；不代表没有缺点' : '未提取到主题原句，请查评论原文表');
    const variant = review.selectedVariant ? `；评论变体：${review.selectedVariant}` : '';
    const id = review.reviewId ? `；评论ID ${review.reviewId}` : '';
    const note = review.note ? `；来源备注：${review.note}` : '';
    return `${review.asin} ${Number(review.rating)}★《${review.title || '无标题'}》${variant}${id}：${quote}${note}`;
  });
  const boundary = lowStars
    ? `样本内含 ${lowStars} 条 1–3★评论；仅为已保存评论样本。`
    : '本次可见/保存样本未见 1–3★；仅代表本次样本，不能推断整体低星不存在。';
  return `实际双语样本 ${rows.length} 条（${countText}）。${boundary}\n${lines.join('\n')}`;
}

function verificationAction(product, similar) {
  const profile = configProfile(product);
  const configuration = String(product.cost?.variant || product.displayName || '');
  const actions = [];
  if (profile.colorChanging) actions.push('索取该变色配置的材料/工艺说明并做标准化光照、温度、耐久与批次重复测试；之后与普通色盲测，现无同配置竞品或评论证据。');
  if (profile.buttonCell) actions.push('核验电池化学体系/型号、是否随货、装卸难度及运输文件；按统一亮度测试续航和误关灯风险；未取得同纽扣电池 PDP。');
  if (profile.rechargeable) actions.push('核验电芯/容量/运输资料，实测充电时间、续航、不同光照可见性、防水和长期循环；竞品评论只作测试项目提示。');
  if (profile.magneticGoggles) actions.push('对照所选风镜/护目镜配置做吸附力、颠簸保持、鼻托视线、脸型/头围适配、色片明暗和拆装循环测试。');
  if (/\bled\b|light/i.test(configuration) && !profile.noLight && !profile.buttonCell && !profile.rechargeable) actions.push('先确认此 LED 候选的具体电池/供电子型，再验证亮度、续航、防水、开关和运输分类；当前灯型邻近 PDP 不作同配置价样本。');
  if (/no light|standard helmet/i.test(configuration)) actions.push('对照所列同配置 PDP 做同头围、同尺码、含帽垫/调节器称重、头型/前额覆盖、稳定性和热舒适测试；供应截图重量/通风孔数不是实测优势。');
  if (/urban|commuter/i.test(product.productDescriptionFromScreenshot || '')) actions.push('用夜间距离/角度测试反光覆盖和帽檐固定，并访谈目标通勤者；相邻城市头盔不能证明此款用户需求。');
  if (!actions.length) actions.push('先做本配置的实物、耐久与目标用户对照测试，再与所列 PDP 同口径比较；现有证据尚未证明相对优势。');
  const evidenceBoundary = similar.length
    ? `当前仅有 ${similar.length} 条明确标为相似的所选变体 PDP；评分人数与月购 UI 标签均不是销量或市场份额，供货款优势仍尚未证明。`
    : '当前没有可用于此候选配置的相似 PDP 价格样本；邻近款、其他电池子型及供货价差均不能证明优势。';
  return `结论：尚未证明该供货配置有相对优势。${evidenceBoundary}\n截图事实衍生的可检验假设（非结论）：${productHypotheses(product)}\n验证动作：${[...new Set(actions)].join(' ')}`;
}

function productHypotheses(product) {
  const selected = String(product.cost?.variant || product.displayName || '').toLowerCase();
  const facts = String(product.productDescriptionFromScreenshot || '');
  const factTerms = facts.toLowerCase();
  const combined = `${selected} ${factTerms}`;
  const noRechargeable = /no rechargeable/.test(selected);
  const selectedRechargeable = !noRechargeable && /rechargeable/.test(selected);
  const hypotheses = [];
  if (/magnetic|goggle/.test(combined)) {
    hypotheses.push('可检验假设：磁吸风镜/护目镜组合可能提供挡风沙用途；需针对本供货配置实测磁吸保持、视野/鼻托干扰、头围贴合与振动脱落。本款优势尚未证明；其他 PDP 评论不能替代本款配置实测。');
  }
  if (selectedRechargeable) {
    hypotheses.push('仅针对本可充电灯配置：可充电可能减少更换电池操作；需实测续航、充电接口/保护、日间可见性、防水和承运要求。竞品评论提及亮度与模式操作，不能当成本款性能证据；本款优势尚未证明。');
  }
  if (/button[- ]cell|coin[- ]cell/.test(selected)) {
    hypotheses.push('仅针对本纽扣电池灯配置：截图候选需先核实电池型号及是否随货，再实测续航、更换难度、开关误触与承运接受性；现有可比 PDP 未确认同电池类型，本款优势尚未证明。');
  }
  if (/color[- ]changing|photochromic/.test(selected)) {
    hypotheses.push('仅针对变色表面配置：普通色竞品和评论不能证明变色效果或溢价。先做规定光照/温度/时间下的变色、耐久、批次一致性测试，再做目标用户盲测；本款优势尚未证明。');
  }
  if (/ordinary color/.test(selected)) {
    hypotheses.push('普通色仅为供货变体事实，不构成差异化优势。需以目标用户盲测验证配色偏好；现有 PDP 价格/评分不证明供货款更受欢迎。');
  }
  if (/urban|commuter|reflective/.test(selected) || (/urban|commuter|reflective/.test(factTerms) && !/no light/.test(selected))) {
    hypotheses.push('针对截图所示城市通勤/反光配置：可检验夜间可见性、反光覆盖和帽檐固定是否满足目标场景；需实测并验证用户需求，不能据文字断言优势。');
  }
  if (/\bled\b|light/.test(selected) && !/no light|no rechargeable light/.test(selected)
    && !selectedRechargeable && !/button[- ]cell|coin[- ]cell/.test(selected)) {
    hypotheses.push('仅针对本 LED/灯配置：供电/电池类型尚未确认；先核实具体子型，再测亮度、续航、防水、开关和运输分类，不据“有灯”推断优势。');
  }
  if (/no light/.test(selected) || /standard helmet/.test(selected)) {
    const weight = facts.match(/(?:approx\.?\s*)?(\d+(?:\.\d+)?)\s*g\b/i)?.[1];
    const vents = facts.match(/(\d+)\s*vents?/i)?.[1];
    const fit = facts.match(/(?:adult fit shown as|size range shown around)\s*([^.;]+)/i)?.[1];
    const evidence = [weight ? `截图声称约 ${weight} g` : '', vents ? `${vents} 个通风孔` : '', fit ? `成人适配标示 ${fit.trim()}` : ''].filter(Boolean).join('、');
    hypotheses.push(evidence
      ? `无灯/基础配置目前无法证明相对优势。供应截图可核验的候选指标：${evidence}。可检验假设：按同尺码、含帽垫/调节件称重，并进行头围适配、稳定性与热舒适对照；通风孔数量不等于散热效果。`
      : '目前无法证明该无灯/基础配置有相对优势；需先确定实物配置，再进行同尺码称重、适配与佩戴体验对照。');
  }
  if (!hypotheses.length) {
    hypotheses.push('目前无法证明此候选配置相对竞品的优势；现有截图只支持待核的供应方描述，需先做配置对应的实物验证和目标用户测试。');
  }
  return hypotheses.join('\n');
}

function addBrief(workbook, job, products, pdps, reviews, associations, imageEvidence) {
  const evidence = job.helmetEvidence || {};
  const sheet = workbook.addWorksheet('00_一页简报');
  sheet.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }];
  const buildDate = String(evidence.reportBuildDate || new Date().toISOString().slice(0, 10));
  const observationDate = String(evidence.evidenceObservationDate || '来源日期未统一记录');
  title(sheet, 6, 'Amazon 美国站头盔市场准入审阅稿 · V2', `工作簿构建日期：${buildDate}｜证据观察日期：${observationDate}（不表示构建日实时采集）｜状态：待独立审核；不得据此放行采购、法规或上架。`);
  const models = new Set(products.map((product) => product.model).filter(Boolean));
  const uniqueSupplierImages = new Set(products.map((product) => product.cost?.evidenceSha256).filter(Boolean)).size;
  const validSimilarByProduct = products.map((product) => configurationPriceSamples(product, pdps, evidence.configurationCoverage || []));
  const configsWithSimilar = validSimilarByProduct.filter((rows) => rows.length > 0).length;
  const noSimilarProducts = products.filter((product, index) => !validSimilarByProduct[index].length);
  const noSimilarWithAdjacent = noSimilarProducts.filter((product) => associations.some((item) =>
    item.product.candidateId === product.candidateId && item.relation.startsWith('邻近'))).length;
  const noSimilarWithoutAdjacent = noSimilarProducts.length - noSimilarWithAdjacent;
  const lowStarCount = reviews.filter((review) => Number(review.rating) >= 1 && Number(review.rating) <= 3).length;
  const highStarCount = reviews.filter((review) => Number(review.rating) >= 4 && Number(review.rating) <= 5).length;
  const reviewAsinCount = new Set(reviews.map((review) => review.asin)).size;
  const recheckedCount = pdps.filter((item) => item.observationKind === '复查既有 ASIN').length;
  const newCount = pdps.filter((item) => item.observationKind === '新增 ASIN').length;
  const pdpImages = new Set(pdps.filter((item) => item.screenshotSha256).map((item) => item.screenshotSha256)).size;
  const allPlacementCount = imageEvidence.length;
  const entries = [
    ['审阅稿版本与边界', `V2 · 构建 ${buildDate} · ${evidence.independentReviewStatus || '待独立审核'}`, '只汇入 2026-09-29 私有试采和增补；不沿用 R3.4 价格、评分、评论或结论。'],
    ['供应范围', `${models.size} 个型号；${products.length} 个型号/配置候选`, '供货价为截图候选 CNY/顶；正式报价、条款、有效期与配置对应关系待供应商核验。'],
    ['供货图证据', `${uniqueSupplierImages} 张唯一供应图；${products.length} 个配置图卡位置`, '每个配置卡单独挂接其型号供应截图；多配置共用同一原图，不伪称不同截图。'],
    ['PDP 覆盖', `${pdps.length} 个唯一 ASIN：${newCount} 个新增、${recheckedCount} 个复查`, '复查记录覆盖父样本同 ASIN；同一 ASIN 在多配置映射中只算一个唯一 PDP。'],
    ['PDP 截图', `${pdps.filter((item) => item.screenshotPath).length}/${pdps.length} 张可用；${pdpImages} 个唯一截图文件`, '价格和所选变体逐条保留；缺图时标记，不以页面主图 CDN 地址替代截图。'],
    ['配置相似关系', `${configsWithSimilar}/${products.length} 个配置有相似观察；${noSimilarProducts.length} 个无相似观察，其中 ${noSimilarWithAdjacent} 个有邻近参照、${noSimilarWithoutAdjacent} 个无邻近参照`, '只逐条列示同配置组的相似观察；邻近参照单独分栏，不混入配置样本、不求均值/价带。无相似/无邻近配置不会被填充竞品。'],
    ['评论样本', `${reviews.length} 条有原文及译文的实际样本；来自 ${reviewAsinCount} 个 ASIN`, `实际高星样本 ${highStarCount} 条；实际 1–3 星样本 ${lowStarCount} 条。数量按保存样本动态计算，不以缺失评论补造。`],
    ['成交/需求信号', `${pdps.filter((item) => item.monthlyBoughtLabel).length}/${pdps.length} 条 PDP 有已记录月购原文`, '仅原样呈现 Amazon 可见标签；不换算实际销量、月销量或市场份额。评分人数也不等于购买人数。'],
    ['成本与利润', 'FX、FBA/佣金、广告、退货、税费与完整货代报价未齐', '不生成保本价、推荐售价、净利润、净利率或销售价格带。费用空白代表未知，不代表零。'],
    ['准入与法规', `${products.length}/${products.length} 个配置均为“待补证”`, '供应商认证文字不视为已审证书；不推定 Amazon 类目/法规审查已完成；不推断可采购或可上架。'],
    ['构建审核门', `任务 ${job.jobId} · revision ${job.revision || 1} · build ${job.buildVersion || 2} · 不可交付`, '独立审核尚未完成；本地文件仅供审阅，不更改网站下载门或审核记录。']
  ];
  header(sheet, 3, ['审阅项', '动态结果', '边界 / 使用限制', '', '', '']);
  entries.forEach((values, index) => {
    const rowNumber = index + 4;
    sheet.mergeCells(rowNumber, 3, rowNumber, 6);
    sheet.getCell(rowNumber, 1).value = values[0];
    sheet.getCell(rowNumber, 2).value = values[1];
    sheet.getCell(rowNumber, 3).value = values[2];
    sheet.getRow(rowNumber).height = 42;
    sheet.getCell(rowNumber, 1).font = { bold: true, color: { argb: NAVY } };
    sheet.getCell(rowNumber, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    for (let column = 1; column <= 6; column += 1) sheet.getCell(rowNumber, column).alignment = { vertical: 'middle', wrapText: true };
    if (index === 9 || index === 10) sheet.getCell(rowNumber, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_AMBER } };
  });
  sheet.columns = [{ width: 22 }, { width: 43 }, { width: 34 }, { width: 24 }, { width: 24 }, { width: 24 }];
  sheet.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 1, orientation: 'landscape' };
}

function addModelAnalysis(workbook, job, products, pdps, reviews, associations) {
  const sheet = workbook.addWorksheet('01_逐款优劣分析');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 1, showGridLines: false }];
  title(sheet, 9, '逐型号 / 候选配置竞品优劣与证据对照', '强项/问题仅按所列 PDP、已保存真实评论样本描述；月购为页面原文。评分与评论人数不是销量。相似/邻近分栏；优势结论默认“尚未证明”，不以低供货价、星级或样本缺失代替验证。评论主题为可追溯原文摘句，完整双语文本见 05；ASIN PDP 链接见 04、评论 ID 链接见 05。');
  header(sheet, 3, [
    '型号', '供货候选配置 / 成本候选（CNY/顶）', '供应截图事实（供货方陈述）',
    '对应相似配置 PDP 信号（价格/评分人数/月购原文）', '相似 PDP 评论主题：正面原句摘录（保留原星级）',
    '相似 PDP 评论主题：实际问题摘句', '邻近 PDP（明确排除出同配置样本）',
    '邻近 PDP 评论 / 适用界限', '供货款优势判断与具体验证动作'
  ]);
  const evidenceProducts = job.helmetEvidence?.products || [];
  for (const product of products) {
    const model = product.model;
    const source = evidenceProducts.find((item) => item.model === model) || {};
    const sourceName = source.screenshotName || product.sourceScreenshot || '型号供应截图未登记';
    const facts = [product.productDescriptionFromScreenshot || source.descriptionFromScreenshot || '无供应截图文字转录；需对照原图。',
      `来源截图：${sourceName}${product.cost?.evidenceSha256 ? `；SHA-256 ${product.cost.evidenceSha256}` : ''}`,
      source.packaging?.status ? `箱规截图候选：${source.packaging.status}` : '箱规/认证及其适用配置待核。',
      /CPSC|CE|ASTM|EN1078/i.test(product.productDescriptionFromScreenshot || '') ? '证书、适用标准、持证主体及与本配置一致性均未独立核验。' : '供应方文字未被当作认证或性能审核结论。'
    ].join('\n');
    const related = associations.filter((item) => item.product.candidateId === product.candidateId);
    const similar = related.filter((item) => item.relation.startsWith('相似配置') && Number(item.pdp.price?.amount) > 0 && item.pdp.screenshotPath);
    const adjacent = related.filter((item) => item.relation.startsWith('邻近'));
    const similarReviews = summarizeReviewEvidence(similar, reviews, { mode: 'positive' });
    const similarConcerns = summarizeReviewEvidence(similar, reviews, { mode: 'concern' });
    const adjacentReviews = summarizeReviewEvidence(adjacent, reviews, { adjacent: true, mode: 'all' });
    const similarSignal = similar.map((item) => `${pdpRatingSignal(item.pdp)}；所选变体：${pdpSelectedVariant(item.pdp)}`).join('\n')
      || '无：当前没有同时满足逐配置相似判定、PDP 截图和有效价格的记录。';
    const adjacentSignal = adjacent.map((item) => `${pdpRatingSignal(item.pdp)}；所选变体：${pdpSelectedVariant(item.pdp)}；仅作邻近参照，原因：${item.reason}`).join('\n')
      || '无已映射邻近 PDP；不补造竞品。';
    const advantage = verificationAction(product, similar);
    const row = sheet.addRow([
      model,
      `${product.cost?.variant || product.displayName}；截图候选 CNY ${product.cost?.amount ?? '未读出'} / ${product.cost?.unit || '顶'}；正式报价未确认`,
      facts,
      similarSignal,
      similarReviews,
      similarConcerns,
      adjacentSignal,
      adjacentReviews,
      advantage
    ]);
    const wrappedLines = [
      [similarSignal, 74], [similarReviews, 86], [similarConcerns, 86],
      [adjacentSignal, 84], [adjacentReviews, 84], [advantage, 90]
    ].reduce((maximum, [value, approximateChars]) => Math.max(maximum, Math.ceil(String(value).length / approximateChars)), 0);
    row.height = Math.max(220, Math.min(390, 26 + wrappedLines * 14));
    row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_AMBER } };
    row.getCell(9).font = { color: { argb: '7A4E00' } };
  }
  sheet.columns = [14, 46, 70, 76, 88, 88, 86, 86, 92].map((width) => ({ width }));
  formatBody(sheet, 4, sheet.rowCount, 1, 9);
}

function addSupplierCards(workbook, job, products, imageEvidence, imageIdByHash) {
  const sheet = workbook.addWorksheet('02_供应配置图卡');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 1, showGridLines: false }];
  title(sheet, 8, '逐型号 / 配置供应截图图卡', '16 个配置各有独立图卡位置；同型号配置共享同一张原始供应截图，不重复伪造图片。截图价格仍为候选而非正式报价。');
  header(sheet, 3, ['型号', '供货候选配置（与 PDP 选中变体分开）', '截图候选成本', '供应截图可见描述', '供应原始截图', '任务内证据文件', 'SHA-256', '核验状态']);
  products.forEach((product, index) => {
    const rowNumber = index + 4;
    const sourceName = product.sourceScreenshot || path.basename(product.cost?.sourceLocation || '') || '未记录';
    const row = sheet.addRow([
      product.model || '', product.cost?.variant || product.displayName || '',
      product.cost?.amount ?? '', product.productDescriptionFromScreenshot || '未提供可转录描述；需对照原截图。',
      '', sourceName, product.cost?.evidenceSha256 || '',
      product.cost?.evidencePath ? '供货截图路径/文件签名及金额配置已核；仍待独立审核' : '未附截图；补证'
    ]);
    row.height = 125;
    row.getCell(3).numFmt = '"CNY "0.00';
    const image = embedEvidence(workbook, sheet, job, imageEvidence, imageIdByHash, product.cost?.evidencePath,
      rowNumber, 5, `${product.model} ${product.cost?.variant || ''} supplier cost screenshot`, 260, 115);
    if (!image) {
      if (job.helmetEvidence?.kind === 'private_helmet_market_access_v2') {
        throw Object.assign(new Error(`Supplier screenshot missing for configuration ${product.candidateId}.`), { code: 'required_supplier_image_missing' });
      }
      sheet.getCell(rowNumber, 5).value = '本任务未保存可用供应截图';
    }
  });
  sheet.columns = [15, 47, 18, 58, 42, 44, 68, 45].map((width) => ({ width }));
  formatBody(sheet, 4, sheet.rowCount, 1, 8);
}

function addAdmissionSheet(workbook, job, products, pdps, associations) {
  const sheet = workbook.addWorksheet('03_配置准入判断');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 2, showGridLines: false }];
  title(sheet, 10, '逐型号 / 候选配置准入判断', '采购截图候选配置是本表行的对象；Amazon PDP 的颜色/尺码/功能所选变体另列在 04_PDP证据，不得把邻近款价格替代为本配置价格。');
  header(sheet, 3, ['型号', '供货候选配置', '截图候选成本 CNY/顶', '相似配置逐条观察（不求均值/价带）', '邻近参考（明确排除）', '配置覆盖状态', '供应证据', 'Amazon 类目/法规', '费用/运输', '准入状态']);
  products.forEach((product) => {
    const related = associations.filter((item) => item.product.candidateId === product.candidateId);
    const similar = configurationPriceSamples(product, pdps, job.helmetEvidence?.configurationCoverage || [])
      .map((item) => `${item.pdp.brand || item.pdp.asin} ${item.pdp.asin} ${item.pdp.price.displayedText || `US$${Number(item.pdp.price.amount).toFixed(2)}`}（相似配置观察；见 04；不代表推荐价）`);
    const adjacent = related.filter((item) => item.relation.startsWith('邻近'))
      .map((item) => `${item.pdp.brand || item.pdp.asin} ${item.pdp.asin} ${item.pdp.price?.displayedText || (Number(item.pdp.price?.amount) > 0 ? `US$${Number(item.pdp.price.amount).toFixed(2)}` : '价格未记录')}（邻近/功能参照；不计入同配置样本）`);
    const hasMappedButNoEligiblePrice = related.length && !similar.length;
    const coverageText = similar.length
      ? `${similar.length} 条相似配置观察；均为逐条记录，非完整同型号/外壳匹配。`
      : hasMappedButNoEligiblePrice ? '只有邻近映射；同配置价格样本为 0。' : '无来源明确映射的 PDP 观察。';
    const row = sheet.addRow([
      product.model || '', product.cost?.variant || product.displayName || '', product.cost?.amount ?? '',
      similar.join('\n') || '空：当前证据不足，未把邻近/其他配置价格并入。',
      adjacent.join('\n') || '空：无独立标注的邻近参照。', coverageText,
      product.cost?.evidencePath ? `供货原图候选；${path.basename(product.cost.evidencePath)}；SHA ${product.cost.evidenceSha256 || ''}` : '未提供供应图',
      '未审核；不推定法规、证书或 Amazon 类目已通过。',
      'FX/平台费/完整运费缺失；不计算销售价格或利润。',
      '待补证（非通过/非否决）'
    ]);
    row.height = Math.max(95, 38 * Math.max(similar.length, adjacent.length, 1));
    row.getCell(3).numFmt = '"CNY "0.00';
    row.getCell(10).font = { bold: true, color: { argb: '9A6700' } };
    row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_AMBER } };
    if (adjacent.length) row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
  });
  sheet.columns = [15, 48, 20, 62, 62, 35, 48, 52, 54, 24].map((width) => ({ width }));
  formatBody(sheet, 4, sheet.rowCount, 1, 10);
}

function addPdpSheet(workbook, job, pdps, associations, imageEvidence, imageIdByHash) {
  const sheet = workbook.addWorksheet('04_PDP证据');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 1, showGridLines: false }];
  title(sheet, 17, 'Amazon.com 所选变体 PDP 逐条观察', '所有金额只取来源中所选变体 PDP 当前价。相似/邻近关系分开记；不把相似价拼成价带。评分人数、月购标签均不是准确销量。');
  header(sheet, 3, [
    'ASIN（打开 PDP）', '品牌', 'PDP 标题', '所选 PDP 价格原文', '促销 / Coupon 原文', 'Amazon 所选变体（原记录）',
    '逐候选配置映射 / 关系等级', '逐候选配置判定理由', '评分', '评分人数', '页面可见月购原文', 'BSR 原文/状态',
    'PDP 观察时间（来源时区）', '证据级别 / 状态', 'PDP 截图', '截图文件 / SHA-256', '源记录关系/备注'
  ]);
  pdps.forEach((pdp, index) => {
    const rowNumber = index + 4;
    const related = associations.filter((item) => item.pdp.asin === pdp.asin);
    const configText = related.map((item) => `${item.product.model} · ${item.product.cost?.variant || item.product.displayName} [${item.relation}]`).join('\n')
      || '未映射到具体候选配置；不得自动视为相似';
    const relationText = related.map((item) => `${item.product.model} · ${item.product.cost?.variant || item.product.displayName}：${item.reason}`).join('\n')
      || '待核；不作相似结论';
    const variant = typeof pdp.selectedVariant === 'string' ? pdp.selectedVariant : JSON.stringify(pdp.selectedVariant || {});
    const promotion = [pdp.price?.otherPromotion, pdp.price?.couponStatus].filter(Boolean).join('\n') || '来源未记录';
    const screenshotStatus = pdp.screenshotPath
      ? 'PDP 截图路径/签名已核；构建人目视核对价格/变体；待独立审核'
      : '截图缺失；仅有来源文字记录，价格/变体未能图像复核';
    const row = sheet.addRow([
      linkValue(pdp.asin, pdp.url), pdp.brand || '', pdp.title || '',
      pdp.price?.displayedText || (Number(pdp.price?.amount) > 0 ? `US$${Number(pdp.price.amount).toFixed(2)}` : '未观察到价格'),
      promotion, variant, configText, relationText,
      pdp.rating?.value ?? '', pdp.rating?.count ?? '', pdp.monthlyBoughtLabel || '',
      pdp.bsrText || pdp.bsrStatus || '未见 / 未记录', pdp.observedAtLocal || '', screenshotStatus,
      '', pdp.screenshotPath ? `${pdp.screenshotFileName || path.basename(pdp.screenshotPath)}\n${pdp.screenshotSha256 || ''}` : '截图缺失',
      [pdp.observationKind, pdp.matchLevel, pdp.matchReason].filter(Boolean).join('\n') || '源记录未保存关系判断；本表按逐配置证据另行标注'
    ]);
    row.height = 128;
    row.getCell(9).numFmt = '0.0';
    const image = embedEvidence(workbook, sheet, job, imageEvidence, imageIdByHash, pdp.screenshotPath,
      rowNumber, 15, `${pdp.brand || pdp.asin} ${pdp.asin} Amazon PDP selected-variant screenshot`, 235, 116);
    if (!image) sheet.getCell(rowNumber, 15).value = '无可用 PDP 截图';
  });
  sheet.columns = [18, 20, 48, 20, 42, 50, 60, 42, 10, 15, 32, 30, 31, 52, 38, 66, 20].map((width) => ({ width }));
  formatBody(sheet, 4, sheet.rowCount, 1, 17);
}

function addReviewSheet(workbook, reviews) {
  const sheet = workbook.addWorksheet('05_评论原文与译文');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 2, showGridLines: false }];
  title(sheet, 11, '可核来源的双语评论样本（仅实际保存原文及对应译文）', '不生成归纳性代写评论；一至三星样本只有来源确实取得时才出现。相同 review ID 只计一次。');
  header(sheet, 3, ['ASIN', '星级', '英文标题', '评论者', '日期', '所选评论变体', '英语原文/摘录', '中文译文', '原始来源状态及备注', '评论详情链接', '来源文件']);
  reviews.forEach((review) => {
    const row = sheet.addRow([
      review.asin || '', review.rating ?? '', review.title || '', review.reviewer || '', review.date || '',
      review.selectedVariant || '', review.englishOriginal || '', review.chineseTranslation || '',
      [review.textKind, review.sourceStatus, review.note].filter(Boolean).join('\n'),
      linkValue(review.reviewId || '打开原始评论', review.reviewUrl), review.sourceDocument || ''
    ]);
    row.height = Math.max(76, Math.min(310, 38 + Math.max(String(review.englishOriginal || '').length, String(review.chineseTranslation || '').length) / 4));
    row.getCell(2).alignment = { horizontal: 'center', vertical: 'top' };
  });
  sheet.columns = [18, 10, 38, 24, 17, 42, 92, 92, 60, 42, 46].map((width) => ({ width }));
  if (reviews.length) formatBody(sheet, 4, sheet.rowCount, 1, 11);
}

function addCostSheet(workbook, products) {
  const sheet = workbook.addWorksheet('06_成本与费用');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 2, showGridLines: false }];
  title(sheet, 14, '逐配置成本、费用与利润结论门', '成本只保留截图候选；费用空白代表未知、不是零。有效 FX、FBA/佣金、广告、退货、税费、完整物流成本均未确认，因此不生成保本价、推荐售价或净利润。');
  header(sheet, 3, [
    '型号', '供应候选配置', '成本候选金额', '币种', '单位', '正式条款/有效期', 'FX→USD', 'FX 日期/来源',
    'Amazon 佣金 / FBA', '广告 / 退货', '税/关税/其他', '实际全程运费', '费用核验状态', '禁止结论'
  ]);
  products.forEach((product) => {
    const row = sheet.addRow([
      product.model || '', product.cost?.variant || product.displayName || '', product.cost?.amount ?? '',
      product.cost?.currency || '', product.cost?.unit || 'per helmet',
      '未提供正式报价、贸易条款、税费/MOQ/付款条款及有效期', '', '', '', '', '', '',
      '缺实际输入；不得按 0 计算', '保本价 / 推荐售价 / 净利润：不计算'
    ]);
    row.height = 64;
    row.getCell(3).numFmt = '"CNY "0.00';
    row.getCell(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_AMBER } };
    row.getCell(14).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SOFT_RED } };
  });
  const firstNoteRow = sheet.rowCount + 2;
  const notes = [
    '费用字段说明（当前仅列输入门，不代入未确认数值）',
    '固定成本 F：采购成本 USD + 国际运费 USD/顶 + 包装/入仓 + FBA/履约 + 单件广告/退货准备 + 关税/税费 + 其他固定费用。',
    '销售额费率 v：平台佣金率 + 销售额广告率 + 退货准备率 + 适用税率；客户付款 S 还需扣折扣与固定 Coupon。',
    '公式留痕用途：只有供应报价、FX 日期、可承运完整货代报价、平台费率及经营成本均核实后，独立审核人才能另行测算。',
    '本工作簿中不存在按 0 填充的费用、利润率、保本售价、目标售价或净利润结果。'
  ];
  notes.forEach((line, index) => {
    const rowNumber = firstNoteRow + index;
    sheet.mergeCells(rowNumber, 1, rowNumber, 14);
    sheet.getCell(rowNumber, 1).value = line;
    sheet.getCell(rowNumber, 1).alignment = { wrapText: true, vertical: 'middle' };
    sheet.getRow(rowNumber).height = index === 0 ? 30 : 42;
    if (index === 0) {
      sheet.getCell(rowNumber, 1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getCell(rowNumber, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    }
  });
  sheet.columns = [15, 48, 19, 12, 20, 54, 18, 28, 32, 30, 34, 30, 35, 45].map((width) => ({ width }));
  formatBody(sheet, 4, products.length + 3, 1, 14);
}

function addSourceSheet(workbook, job, products, pdps, reviews) {
  const sheet = workbook.addWorksheet('07_来源与核验');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 1, showGridLines: false }];
  title(sheet, 9, '实际来源索引与证据核验状态', '私有 JSON 和截图只保留在本机 ignored tmp 任务副本；本 Excel 嵌入审阅所需图像并保留来源标识/哈希。所有内容仍待独立审核。');
  header(sheet, 3, ['来源类型', '关联型号/配置或 ASIN', '来源标识 / 文件', '观察/源文件时间', '截图或记录校验', '独立审核状态', '可点击原始来源', '本机截图名', 'SHA-256']);
  const rows = [];
  const sourceFiles = job.helmetEvidence?.sourceDocuments || [];
  sourceFiles.forEach((source) => rows.push([
    '私有结构化数据源', '本地研究构建', source.fileName || source.role, '', source.sha256 ? `JSON SHA-256 ${source.sha256}` : '来源文件已读；无记录哈希',
    '待独立审核；不得外传', '', '', source.sha256 || ''
  ]));
  const supplierSeen = new Set();
  for (const product of products) {
    const key = product.cost?.evidenceSha256 || `${product.model}|${product.cost?.evidencePath || ''}`;
    if (supplierSeen.has(key)) continue;
    supplierSeen.add(key);
    rows.push([
      '供应商成本/产品截图', `${product.model} · ${(modelRows(products).get(product.model) || []).map((item) => item.cost?.variant).join('；')}`,
      product.sourceScreenshot || path.basename(product.cost?.evidencePath || ''), product.sourceFileModifiedLocal || '',
      product.cost?.evidencePath ? '原图路径、JPEG/PNG 签名及 SHA-256 已核；截图金额/配置目视对照' : '无任务图片副本',
      '供应方陈述；正式报价及证书待核', '', product.cost?.evidencePath || '', product.cost?.evidenceSha256 || ''
    ]);
  }
  for (const pdp of pdps) {
    rows.push([
      'Amazon PDP 所选变体价格/评分观察', `${pdp.brand || ''} ${pdp.asin}`.trim(), pdp.asin, pdp.observedAtLocal || '',
      pdp.screenshotPath ? '截图路径/图像签名及 SHA-256 已核；价格和所选变体目视对照' : '来源文字保留；截图缺失，未作图像核验',
      '公开页观察；待独立审核', linkValue(`Amazon PDP ${pdp.asin}`, pdp.url), pdp.screenshotSourcePath || pdp.screenshotFileName || '', pdp.screenshotSha256 || ''
    ]);
  }
  for (const review of reviews) {
    rows.push([
      '评论原文及对应译文', review.asin, review.reviewId, review.date || review.observedAtLocal || '',
      `${review.textKind || '原文与译文'}；按源记录逐条保留`, '评论来源/译文待独立审核',
      linkValue(`Amazon review ${review.reviewId}`, review.reviewUrl), '', ''
    ]);
  }
  rows.forEach((values) => sheet.addRow(values));
  sheet.columns = [36, 62, 45, 30, 66, 36, 44, 58, 68].map((width) => ({ width }));
  if (rows.length) formatBody(sheet, 4, sheet.rowCount, 1, 9);
  sheet.eachRow((row, rowNumber) => { if (rowNumber >= 4) row.height = 48; });
}

function roundChargeable(weight) {
  if (!(weight > 0)) return null;
  return weight < 20 ? Math.ceil(weight * 2) / 2 : Math.ceil(weight);
}

function cartonForProduct(product, evidence) {
  const source = evidence.products?.find((item) => item.model === product.model);
  if (source?.packaging) return source.packaging;
  const carton = product.packagingEvidence?.primaryCarton || {};
  const websiteCarton = product.shipping?.cartons?.[0] || {};
  return {
    unitsPerCarton: Number(carton.unitsPerCarton ?? websiteCarton.unitsPerCarton) || null,
    dimensionsCm: Array.isArray(carton.dimensionsCm) ? carton.dimensionsCm
      : [websiteCarton.lengthCm, websiteCarton.widthCm, websiteCarton.heightCm].every((value) => Number(value) > 0)
        ? [websiteCarton.lengthCm, websiteCarton.widthCm, websiteCarton.heightCm] : [],
    netWeightKg: Number(carton.netWeightKg) || null,
    grossWeightKg: Number(carton.grossWeightKg ?? websiteCarton.grossKg) || null,
    status: product.packagingEvidenceStatus || '截图箱规候选；待核'
  };
}

function addCartonSheet(workbook, products, evidence) {
  const sheet = workbook.addWorksheet('08_包装外箱追溯');
  sheet.views = [{ state: 'frozen', ySplit: 3, xSplit: 2, showGridLines: false }];
  title(sheet, 15, '逐配置装箱候选与计费重量追溯（非实际运费）', '尺寸/重量/每箱数量来自供应截图主箱候选，未确认是否适用所选配置。按每箱 max(毛重,体积重)；<20kg 向上进 0.5kg，≥20kg 向上进 1kg。整票箱数、除数与承运报价待补。');
  header(sheet, 3, ['型号', '供货候选配置', '顶/箱候选', '长 cm', '宽 cm', '高 cm', '毛重 kg/箱', '净重 kg/箱', '体积 cm³', '体积重 kg @5000', '计费重 kg @5000', '体积重 kg @6000', '计费重 kg @6000', '截图/箱规证据状态', '未确认输入']);
  products.forEach((product) => {
    const carton = cartonForProduct(product, evidence);
    const dimensions = Array.isArray(carton.dimensionsCm) ? carton.dimensionsCm.map(Number) : [];
    const usableDimensions = dimensions.length === 3 && dimensions.every((value) => value > 0);
    const gross = Number(carton.grossWeightKg) > 0 ? Number(carton.grossWeightKg) : null;
    const rowNumber = sheet.rowCount + 1;
    const volume = usableDimensions ? dimensions[0] * dimensions[1] * dimensions[2] : null;
    const volume5000 = volume ? volume / 5000 : null;
    const volume6000 = volume ? volume / 6000 : null;
    const charge5000 = gross && volume5000 ? roundChargeable(Math.max(gross, volume5000)) : null;
    const charge6000 = gross && volume6000 ? roundChargeable(Math.max(gross, volume6000)) : null;
    const row = sheet.addRow([
      product.model || '', product.cost?.variant || product.displayName || '', carton.unitsPerCarton ?? '',
      usableDimensions ? dimensions[0] : '', usableDimensions ? dimensions[1] : '', usableDimensions ? dimensions[2] : '',
      gross ?? '', carton.netWeightKg ?? '',
      volume === null ? '' : { formula: `D${rowNumber}*E${rowNumber}*F${rowNumber}`, result: volume },
      volume5000 === null ? '' : { formula: `I${rowNumber}/5000`, result: volume5000 },
      charge5000 === null ? '' : { formula: `IF(MAX(G${rowNumber},J${rowNumber})<20,CEILING(MAX(G${rowNumber},J${rowNumber}),0.5),CEILING(MAX(G${rowNumber},J${rowNumber}),1))`, result: charge5000 },
      volume6000 === null ? '' : { formula: `I${rowNumber}/6000`, result: volume6000 },
      charge6000 === null ? '' : { formula: `IF(MAX(G${rowNumber},L${rowNumber})<20,CEILING(MAX(G${rowNumber},L${rowNumber}),0.5),CEILING(MAX(G${rowNumber},L${rowNumber}),1))`, result: charge6000 },
      carton.status || '截图箱规候选；待供应商复核',
      '实际箱数、配置适用性、体积重除数、目的邮区、路线/重量档、带电承运及其他票级费待核'
    ]);
    row.height = 58;
  });
  sheet.columns = [15, 48, 16, 12, 12, 12, 18, 18, 18, 22, 22, 22, 22, 58, 72].map((width) => ({ width }));
  formatBody(sheet, 4, sheet.rowCount, 1, 15);
}

function addFreightSensitivitySheet(workbook, products, evidence) {
  const sheet = workbook.addWorksheet('09_运费条件情景');
  sheet.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }];
  title(sheet, 15, '货代运费条件情景（非报价、非到岸成本、非利润）', '只复算来源中 H0-022 的 55.7 CNY/kg 条件示例及 480 CNY/票适用性未知压力情景；不宣称最高可用运价。金额不含完整货代、入仓、清关、税费或 Amazon 费用。');
  header(sheet, 3, [
    '型号/配置', '体积重除数', '磁检费情景 CNY/票', '顶/箱候选', '条件运价 CNY/kg', '原始体积重 kg',
    '计费重 kg/箱（条件）', '条件运费 CNY/票', '条件运费 CNY/顶', '磁检情景 CNY/顶',
    '截图采购候选 CNY/顶', '采购候选+本条件运费', '加磁检压力情景', '可用状态', '公式/来源边界'
  ]);
  const sourceExample = evidence.freightScenario?.h0022IllustrativeScenarioOnly || {};
  const h0022 = products.find((product) => product.model === 'H0-022' && /no light/i.test(product.cost?.variant || ''));
  const fallbackRateOption = h0022?.shipping?.rateOptions?.find((item) => item.candidateOnly === true) || {};
  const rate = Number(sourceExample.selectedReferenceRate?.amount || h0022?.shipping?.illustrativeRatePerKg || fallbackRateOption.perKg);
  const rateCurrency = String(sourceExample.selectedReferenceRate?.currency || fallbackRateOption.currency || 'CNY').toUpperCase();
  const inspection = Number(sourceExample.magneticInspectionPressureScenario?.inspectionFeeCnyPerShipment
    ?? h0022?.shipping?.rate?.magneticInspectionPerShipment);
  const carton = h0022 ? cartonForProduct(h0022, evidence) : {};
  const dimensions = Array.isArray(carton.dimensionsCm) ? carton.dimensionsCm.map(Number) : [];
  const units = Number(carton.unitsPerCarton);
  const gross = Number(carton.grossWeightKg);
  if (!(rate > 0) || rateCurrency !== 'CNY' || !(inspection >= 0) || !h0022
    || dimensions.length !== 3 || !dimensions.every((value) => value > 0) || !(units > 0) || !(gross > 0)) {
    const noteRow = sheet.addRow(['无可复算条件示例；完整货代费率、配置箱规或金额来源待补。']);
    sheet.mergeCells(noteRow.number, 1, noteRow.number, 15);
    noteRow.height = 34;
  } else {
    const matchedOptions = (sourceExample.divisorScenarios || []).map((item) => Number(item.divisorCm3PerKg)).filter((item) => item > 0);
    const divisors = [...new Set(matchedOptions.length ? matchedOptions : [5000, 6000])].sort((a, b) => a - b);
    for (const divisor of divisors) {
      const volumeWeight = dimensions.reduce((total, value) => total * value, 1) / divisor;
      const chargeable = roundChargeable(Math.max(gross, volumeWeight));
      for (const fee of [0, inspection]) {
        const rowNumber = sheet.rowCount + 1;
        const freightTicket = chargeable * rate;
        const perUnitFreight = freightTicket / units;
        const perUnitInspection = fee / units;
        const purchase = Number(h0022.cost?.amount);
        const row = sheet.addRow([
          `${h0022.model} · ${h0022.cost?.variant}`, divisor, fee, units, rate,
          { formula: `='08_包装外箱追溯'!D4*'08_包装外箱追溯'!E4*'08_包装外箱追溯'!F4/B${rowNumber}`, result: volumeWeight },
          { formula: `IF(MAX('08_包装外箱追溯'!G4,F${rowNumber})<20,CEILING(MAX('08_包装外箱追溯'!G4,F${rowNumber}),0.5),CEILING(MAX('08_包装外箱追溯'!G4,F${rowNumber}),1))`, result: chargeable },
          { formula: `G${rowNumber}*E${rowNumber}`, result: freightTicket },
          { formula: `H${rowNumber}/D${rowNumber}`, result: perUnitFreight },
          { formula: `C${rowNumber}/D${rowNumber}`, result: perUnitInspection },
          purchase,
          { formula: `I${rowNumber}+K${rowNumber}`, result: perUnitFreight + purchase },
          { formula: `I${rowNumber}+J${rowNumber}+K${rowNumber}`, result: perUnitFreight + perUnitInspection + purchase },
          '来源条件情景；非真实可用路线/运价',
          `${sourceExample.selectedReferenceRate?.status || h0022?.shipping?.illustrativeRateSource || 'CNY/kg 条件行；不是最高或必用费率'}；${fee ? 'CNY/票磁检为假设压力项，适用性未知。' : '未加磁检费情景。'} 箱数按一箱情景展示，不是正式报价/到岸成本。`
        ]);
        row.height = 72;
      }
    }
  }
  sheet.columns = [48, 17, 23, 15, 19, 21, 23, 22, 22, 24, 22, 26, 26, 42, 76].map((width) => ({ width }));
  if (sheet.rowCount >= 4) formatBody(sheet, 4, sheet.rowCount, 1, 15);
}

function validateJobForWorkbook(job, products, pdps) {
  if (!products.length) throw Object.assign(new Error('The private helmet build has no configuration candidates.'), { code: 'empty_helmet_candidates' });
  const ids = new Set(products.map((product) => product.candidateId));
  if (ids.size !== products.length) throw Object.assign(new Error('Duplicate candidate IDs prevent configuration-level evidence binding.'), { code: 'duplicate_candidate_id' });
  const asins = new Set(pdps.map((pdp) => pdp.asin));
  if (asins.size !== pdps.length) throw Object.assign(new Error('Duplicate ASIN rows must be merged before workbook generation.'), { code: 'duplicate_pdp_asin' });
  if (job.helmetEvidence?.kind === 'private_helmet_market_access_v2') {
    for (const product of products) {
      if (!product.cost?.evidencePath) throw Object.assign(new Error(`Missing supplier screenshot for ${product.candidateId}.`), { code: 'required_supplier_image_missing' });
    }
  }
}

async function buildHelmetMarketWorkbook(job, outputDir, { manifestDir = outputDir, buildManifest } = {}) {
  if (typeof buildManifest !== 'function') throw new TypeError('A workbook manifest builder is required.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Local Report Center';
  workbook.subject = 'Amazon US helmet market-entry review; pending independent review';
  workbook.title = 'Amazon US Helmet Market Entry Review · V2';
  workbook.company = 'Report Center';
  workbook.calcMode = 'auto';
  const products = productCandidates(job);
  const evidence = job.helmetEvidence || {};
  const pdps = Array.isArray(evidence.pdps) ? evidence.pdps : collectLegacyPdpRecords(products);
  const reviews = collectReviews(job, pdps);
  const coverageGroups = Array.isArray(evidence.configurationCoverage) ? evidence.configurationCoverage : [];
  const associations = allAssociations(products, pdps, coverageGroups);
  validateJobForWorkbook(job, products, pdps);
  const imageEvidence = [];
  const imageIdByHash = new Map();

  addBrief(workbook, job, products, pdps, reviews, associations, imageEvidence);
  addModelAnalysis(workbook, job, products, pdps, reviews, associations);
  addSupplierCards(workbook, job, products, imageEvidence, imageIdByHash);
  addAdmissionSheet(workbook, job, products, pdps, associations);
  addPdpSheet(workbook, job, pdps, associations, imageEvidence, imageIdByHash);
  addReviewSheet(workbook, reviews);
  addCostSheet(workbook, products);
  addSourceSheet(workbook, job, products, pdps, reviews);
  addCartonSheet(workbook, products, evidence);
  addFreightSensitivitySheet(workbook, products, evidence);

  workbook.worksheets.forEach((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
      if (!cell.alignment) cell.alignment = { vertical: 'top', wrapText: true };
    }));
    if (sheet.rowCount >= 4 && sheet.columnCount > 1) sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: sheet.columnCount } };
  });

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  const fileName = `Amazon_US_头盔市场准入_V2_${job.jobId}_build${job.buildVersion || 2}.xlsx`;
  const filePath = path.join(outputDir, fileName);
  if (fs.existsSync(filePath)) throw Object.assign(new Error(`Refusing to overwrite an existing private build output: ${fileName}`), { code: 'artifact_collision' });
  const buffer = await workbook.xlsx.writeBuffer();
  fs.writeFileSync(filePath, Buffer.from(buffer), { flag: 'wx' });
  const artifactId = crypto.createHash('sha256').update(`${job.jobId}:${job.revision}:${job.buildVersion}:${fileName}`).digest('hex').slice(0, 24);
  const manifest = buildManifest(workbook, fileName, artifactId, job, imageEvidence);
  const manifestPath = path.join(manifestDir, `${artifactId}.manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return { workbookId: job.workbookId, artifactId, fileName, filePath, manifestPath, manifest, imageEvidence };
}

module.exports = {
  buildHelmetMarketWorkbook,
  configurationPriceSamples,
  configurationMatchesCoverage,
  sourceEvidenceFile
};
