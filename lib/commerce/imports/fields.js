'use strict';
/**
 * Generic supplier-material field detector (T1.7 clause A/C). Only generic label vocabularies —
 * no product-specific hardcoding. Rules:
 * - A candidate is only produced when the exact snippet in the source text actually supports it.
 * - Models are compared EXACTLY (no case folding): H0 !== HO.
 * - Currency/unit/incoterm are read independently and stay missing (with a reason) when not
 *   explicitly present; ¥/￥ alone is ambiguous (never assumed CNY); a bare number is never
 *   guessed into USD/pcs/FOB; other fields' numbers (sizes, quantities) are not read as cost.
 * - Line scanning is for text lines (PDF pages / OCR lines); table cells use the same helpers via
 *   extract-table.js.
 */
const INCOTERMS = ['FOB', 'EXW', 'CIF', 'CFR', 'DDP', 'DAP', 'FCA', 'CPT', 'CIP'];
const COST_LABELS = ['出厂价', '采购价', '成本价', '进货价', '批发价', '单价', '价格'];
const QUANTITY_LABELS = ['数量', '起订量', '订购量', 'MOQ'];
const VARIANT_LABELS = ['灯型', '配置', '颜色', '规格'];
const UNIT_TOKENS = ['pcs', 'piece', 'pieces', 'pc', '件', '个', '套', '只', '双', '对', '台', '箱', '盒', '条', '支', '组', '枚'];
const MODEL_STOPWORDS = new Set([...INCOTERMS, 'USD', 'CNY', 'RMB', 'EUR', 'PCS', 'PC', 'MOQ', 'QTY', 'OEM', 'ODM', 'PDF', 'CSV', 'XLSX', 'SKU', 'COLOR', 'SIZE']);

/** Exact model identity: original string trimmed at edges, internal case/spacing preserved. */
function modelIdentity(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** First explicit model token on a line (digit-bearing token preferred; letter-only only on labeled lines). */
function extractModelToken(line) {
  const withDigit = line.match(/(?:^|[\s(（])([A-Z][A-Z0-9-]{0,9}\d[A-Z0-9-]{0,9})(?=[\s)）,:：、]|$)/);
  if (withDigit && !MODEL_STOPWORDS.has(withDigit[1])) return withDigit[1];
  const hasLabel = [...COST_LABELS, ...QUANTITY_LABELS].some((label) => line.includes(label));
  if (!hasLabel) return null;
  for (const match of line.matchAll(/(?:^|\s)([A-Z]{2,6})(?=\s|$)/g)) {
    if (!MODEL_STOPWORDS.has(match[1])) return match[1];
  }
  return null;
}

/** Explicit currency cues from one amount: symbol and word cues may CONFLICT (never silently chosen). */
function symbolCurrency(symbol) {
  if (symbol === '$') return 'USD';
  if (symbol === '€') return 'EUR';
  if (symbol === '¥' || symbol === '￥') return 'AMBIGUOUS_YUAN';
  return null;
}
function wordCurrencies(text) {
  const found = new Set();
  let rest = String(text ?? '');
  if (/美元|美金/.test(rest) || /USD/i.test(rest)) {
    found.add('USD');
    rest = rest.replace(/美元|美金/g, '').replace(/USD/gi, '');
  }
  if (/欧元/.test(rest) || /EUR/i.test(rest)) {
    found.add('EUR');
    rest = rest.replace(/欧元/g, '').replace(/EUR/gi, '');
  }
  if (/人民币|RMB|CNY/i.test(rest) || rest.includes('元')) found.add('CNY');
  return found;
}
/** Resolve explicit cues; contradictory explicit cues yield currency_conflict (value stays null). */
function resolveCurrency(symbol, word) {
  const sym = symbolCurrency(symbol);
  const words = wordCurrencies(word);
  const explicit = new Set(words);
  if (sym === 'USD' || sym === 'EUR') explicit.add(sym);
  if (explicit.size > 1) return { currency: null, reason: 'currency_conflict' };
  if (explicit.size === 1) return { currency: [...explicit][0], reason: null };
  if (sym === 'AMBIGUOUS_YUAN') return { currency: null, reason: 'currency_ambiguous_yuan_yen' };
  return { currency: null, reason: 'missing_currency' };
}

/**
 * Quote-subject identity: model plus EVERY explicit dimension as a structured `label=value` part
 * (different dimensions with equal values can never collide; a missing value is `label=?`, an
 * explicit unknown that never merges with a real value).
 */
function composeQuoteSubject(model, dims) {
  const modelText = model ? modelIdentity(model) : '';
  const parts = [];
  for (const dim of Array.isArray(dims) ? dims : []) {
    if (!dim || typeof dim.label !== 'string' || dim.label.trim() === '') continue;
    const value = dim.text === null || dim.text === undefined || String(dim.text).trim() === '' ? '?' : String(dim.text).trim();
    parts.push(`${dim.label.trim()}=${value}`);
  }
  if (modelText && parts.length > 0) return `${modelText}|${parts.join('|')}`;
  if (modelText) return modelText;
  if (parts.length > 0) return `config:${parts.join('|')}`;
  return null;
}

const AMOUNT_RE = /^[\s:：=约]{0,4}([¥￥$€]?\s*\d[\d,]*(?:\.\d+)?)\s*(人民币元|人民币|RMB|CNY|美元|美金|USD|EUR|欧元|元)?\s*(?:\/|每)?\s*(pcs|pieces|piece|pc|件|个|套|只|双|对|台|箱|盒|条|支|组|枚)?/;

/** Shared extraction from an AMOUNT_RE match; returns null for non-positive/NaN amounts. */
function parseAmountMatch(match) {
  if (!match) return null;
  const raw = match[0].trim().replace(/^[:：=约]\s*/, '');
  const digits = match[1].replace(/[¥￥$€,\s]/g, '');
  const numericValue = Number.parseFloat(digits);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return null;
  const symbol = (match[1].match(/[¥￥$€]/) || [])[0] ?? null;
  return { raw, numericValue, symbol, word: match[2] ?? null, unit: match[3] ?? null };
}

/**
 * Parse the amount that immediately follows a label position. A number that is not immediately
 * after the label (e.g. a size elsewhere in the line) is not read. Returns null when nothing
 * fits; unit/currency stay null when not explicit.
 */
function parseAmountAfterLabel(line, labelIndex, labelLength) {
  const rest = line.slice(labelIndex + labelLength);
  return parseAmountMatch(rest.match(AMOUNT_RE));
}

/** Parse an amount out of a standalone text (table cell): label-aware first, then bare amount. */
function parseAmountText(text) {
  const source = String(text ?? '');
  for (const label of COST_LABELS) {
    const at = source.indexOf(label);
    if (at !== -1) {
      const parsed = parseAmountAfterLabel(source, at, label.length);
      if (parsed) return parsed;
    }
  }
  return parseAmountMatch(source.match(AMOUNT_RE));
}

/** Explicit incoterm on a line (uppercase exact words only). */
function findIncoterm(line) {
  for (const term of INCOTERMS) {
    if (new RegExp(`(^|[^A-Z])${term}([^A-Z]|$)`).test(line)) return term;
  }
  return null;
}

/**
 * Configuration/lamp-type/color dimensions on one line: EVERY explicit variant label with its own
 * value (cut at the next label/cost/qty/incoterm boundary, so a later dimension is never dropped;
 * an empty value becomes an explicit unknown dimension, never a silent merge). Returned EXACTLY
 * (trimmed) — dimensions become part of the structured quote subject.
 */
function extractVariantDims(line) {
  const matches = [];
  for (const label of VARIANT_LABELS) {
    let from = 0;
    while (true) {
      const at = line.indexOf(label, from);
      if (at === -1) break;
      matches.push({ label, at, end: at + label.length });
      from = at + label.length;
    }
  }
  matches.sort((a, b) => a.at - b.at);
  const dims = [];
  for (let index = 0; index < matches.length; index += 1) {
    const { label, end } = matches[index];
    const nextLabelAt = index + 1 < matches.length ? matches[index + 1].at : line.length;
    let rest = line.slice(end, nextLabelAt).replace(/^[\s:：]+/, '').trim();
    const boundaries = [...COST_LABELS, ...QUANTITY_LABELS, ...INCOTERMS];
    for (const marker of boundaries) {
      const cut = rest.indexOf(marker);
      if (cut >= 0) rest = rest.slice(0, cut).trim();
    }
    dims.push({ label, text: rest === '' ? null : rest });
  }
  return dims;
}

/**
 * Detect generic candidates on one text line.
 * Every emitted candidate carries its exact supporting
 * snippet (a real substring of the line); reasons record every missing/ambiguous piece.
 */
function detectLineFields(line, options = {}) {
  const text = String(line ?? '');
  if (!text.trim()) return [];
  const results = [];
  const model = extractModelToken(text);
  const variantDims = extractVariantDims(text);
  // configuration identity binds quote fields (cost/quantity): ALL explicit dimensions, no drop
  const subjectKey = composeQuoteSubject(model, variantDims);
  const variantUnknown = variantDims.some((dim) => dim.text === null);
  if (model) {
    results.push({ fieldKey: 'model', rawValue: model, numericValue: null, currency: null, unit: null, incoterm: null, reasons: [], snippet: model, subjectKey: model });
  }

  // purchase cost: label = a generic cost label or a bare incoterm used as the label
  let labelIndex = -1;
  let label = null;
  for (const candidate of COST_LABELS) {
    const at = text.indexOf(candidate);
    if (at !== -1 && (labelIndex === -1 || at < labelIndex)) { labelIndex = at; label = candidate; }
  }
  if (labelIndex === -1) {
    for (const term of INCOTERMS) {
      const at = text.indexOf(term);
      if (at !== -1) { labelIndex = at; label = term; break; }
    }
  }
  if (labelIndex !== -1) {
    const amount = parseAmountAfterLabel(text, labelIndex, label.length);
    if (amount) {
      const currencyRes = resolveCurrency(amount.symbol, amount.word);
      const incoterm = findIncoterm(text);
      const reasons = [];
      if (!amount.unit) reasons.push('missing_unit');
      if (currencyRes.reason) reasons.push(currencyRes.reason);
      if (!incoterm) reasons.push('missing_incoterm');
      if (variantUnknown) reasons.push('variant_unknown');
      results.push({
        fieldKey: 'purchase_cost',
        rawValue: amount.raw,
        numericValue: amount.numericValue,
        currency: currencyRes.currency,
        unit: amount.unit,
        incoterm,
        reasons,
        snippet: amount.raw,
        subjectKey,
        amountLabel: label
      });
    }
  }

  // quantity: independent field, never mixed into cost
  for (const candidate of QUANTITY_LABELS) {
    const at = text.indexOf(candidate);
    if (at === -1) continue;
    const amount = parseAmountAfterLabel(text, at, candidate.length);
    if (amount) {
      const reasons = [];
      if (!amount.unit) reasons.push('missing_unit');
      if (variantUnknown) reasons.push('variant_unknown');
      results.push({
        fieldKey: 'quantity',
        rawValue: amount.raw,
        numericValue: amount.numericValue,
        currency: null,
        unit: amount.unit,
        incoterm: null,
        reasons,
        snippet: amount.raw,
        subjectKey
      });
    }
    break;
  }

  // variant/config dimensions stay their own fields (lamp type / configuration / color never merged)
  for (const dim of variantDims) {
    if (dim.text === null) continue;
    results.push({ fieldKey: 'variant_text', rawValue: dim.text, numericValue: null, currency: null, unit: null, incoterm: null, reasons: [], snippet: dim.text, subjectKey, variantLabel: dim.label });
  }
  return results;
}

/**
 * Mark conflicts inside one document: same subject + numeric field + more than one distinct
 * (value|unit|currency|incoterm) signature never auto-merges; every involved candidate keeps its
 * own row and gains a `conflict` reason.
 */
function conflictGroups(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!['purchase_cost', 'quantity'].includes(candidate.fieldKey)) continue;
    if (candidate.numericValue === null || candidate.numericValue === undefined) continue;
    const key = `${candidate.fieldKey}|${candidate.subjectKey ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const conflicted = [];
  for (const group of groups.values()) {
    const signatures = new Set(group.map((candidate) => `${candidate.numericValue}|${candidate.unit ?? ''}|${candidate.currency ?? ''}|${candidate.incoterm ?? ''}`));
    if (signatures.size > 1) conflicted.push(...group);
  }
  return conflicted;
}

module.exports = {
  INCOTERMS,
  COST_LABELS,
  QUANTITY_LABELS,
  VARIANT_LABELS,
  UNIT_TOKENS,
  MODEL_STOPWORDS,
  modelIdentity,
  extractModelToken,
  resolveCurrency,
  parseAmountAfterLabel,
  parseAmountText,
  findIncoterm,
  extractVariantDims,
  composeQuoteSubject,
  detectLineFields,
  conflictGroups
};
