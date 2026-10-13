'use strict';
/**
 * T3.1 Amazon US selected-variant PDP adapter (S6 route; designed only until I-003 lands).
 *
 * Real request construction and real response parsing code, verified against synthetic fixture
 * HTML through the contract tests — not an interface shell. The parser records only what the
 * page shows: the selected-variant price with its raw currency, raw rating facts, availability
 * and the original observation time (or null when unknown). Search pages yield candidates only;
 * ratings/monthly labels are never converted to sales or share; a missing review block never
 * blocks a price; conflicting prices are never reduced to the lowest one.
 */
const { connectorError } = require('./source-register.js');

const AMAZON_US = Object.freeze({ sourceId: 'amazon-us-pdp', host: 'www.amazon.com', market: 'US', locale: 'en-US' });
const ASIN_RE = /^[A-Z0-9]{10}$/;
const CURRENCY_BY_SYMBOL = Object.freeze({ 'US$': 'USD', C$: 'CAD', $: 'USD', '¥': 'JPY', '￥': 'JPY', '€': 'EUR', '£': 'GBP', '₹': 'INR' });

function buildSelectedVariantRequest({ asin, variantLabel, market = 'US', locale = 'en-US' }) {
  const asinText = String(asin ?? '');
  if (!ASIN_RE.test(asinText)) throw connectorError('request_invalid', 'asin must be 10 uppercase alphanumerics');
  if (typeof variantLabel !== 'string' || variantLabel.trim() === '') throw connectorError('request_invalid', 'variantLabel is required for a selected-variant observation');
  if (market !== 'US' || locale !== 'en-US') throw connectorError('request_invalid', 'this adapter is registered for Amazon US / en-US only');
  const path = `/dp/${asinText}`;
  return Object.freeze({
    method: 'GET',
    host: AMAZON_US.host,
    path,
    url: `https://${AMAZON_US.host}${path}?th=1&psc=1`,
    use: 'price_observation',
    meta: Object.freeze({ asin: asinText, variantLabel, market, locale, selectedVariantUrl: true })
  });
}

function buildSearchRequest({ query, market = 'US', locale = 'en-US' }) {
  if (typeof query !== 'string' || query.trim() === '') throw connectorError('request_invalid', 'query is required');
  if (market !== 'US' || locale !== 'en-US') throw connectorError('request_invalid', 'this adapter is registered for Amazon US / en-US only');
  const path = '/s';
  return Object.freeze({
    method: 'GET',
    host: AMAZON_US.host,
    path,
    url: `https://${AMAZON_US.host}${path}?k=${encodeURIComponent(query)}`,
    use: 'search_candidates',
    meta: Object.freeze({ query, market, locale })
  });
}

function matchOne(text, re) {
  const match = text.match(re);
  return match ? match[1] : null;
}
function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parse one price text into raw amount + raw currency; never guesses a currency. */
function parseMoney(text) {
  const cleaned = String(text ?? '').trim();
  const match = cleaned.match(/(US\$|C\$|[$¥￥€£₹])\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!match) return { amountText: cleaned, amountMicros: null, currency: 'unknown', rawCurrencySymbol: null };
  const amount = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return { amountText: cleaned, amountMicros: null, currency: 'unknown', rawCurrencySymbol: match[1] };
  return { amountText: cleaned, amountMicros: Math.round(amount * 1e6), currency: CURRENCY_BY_SYMBOL[match[1]] ?? 'unknown', rawCurrencySymbol: match[1] };
}

/** Extract the balanced inner HTML of a div by id (bounded, fixture-scale). */
function extractDivById(text, id) {
  const openRe = new RegExp(`<div[^>]*id="${id}"[^>]*>`, 'i');
  const match = text.match(openRe);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let tag;
  while ((tag = tagRe.exec(text)) !== null) {
    if (tag[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return text.slice(start, tag.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

const PRIMARY_PRICE_CONTAINERS = Object.freeze(['corePriceDisplay_desktop_feature_div', 'corePrice_feature_div', 'apex_desktop']);

/**
 * Parse a selected-variant PDP page into raw page facts, modeled on the real Amazon US layout:
 * hidden `id/name="ASIN"` input, `variation_color_name`/`variation_size_name` `.selection`
 * values, and the primary buybox price container. Related-item carousels (similarities etc.),
 * list prices, monthly-payment labels and other offers are never mixed into the main price.
 * `fetchedAt` is recorded separately and is never used as the observation time.
 */
function parseSelectedVariantPdp(html, options = {}) {
  const text = String(html ?? '');
  const fetchedAt = options.fetchedAt ?? null;
  const pageSynthetic = /<meta\s+name="x-fixture"\s+content="synthetic"/i.test(text);
  const observedAtRaw = matchOne(text, /<meta\s+name="x-observed-at"\s+content="([^"]*)"/i);
  const observedAt = observedAtRaw !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAtRaw) ? observedAtRaw : null;
  const titleRaw = matchOne(text, /<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i);
  const pageAsin = matchOne(text, /<input[^>]*(?:id|name)="ASIN"[^>]*value="([A-Z0-9]{10})"/i)
    ?? matchOne(text, /<input[^>]*value="([A-Z0-9]{10})"[^>]*(?:id|name)="ASIN"/i);
  const selections = [];
  for (const [name, containerId] of [['color', 'variation_color_name'], ['size', 'variation_size_name']]) {
    const block = extractDivById(text, containerId);
    if (block === null) continue;
    const value = matchOne(block, /<span[^>]*class="[^"]*selection[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (value !== null && stripTags(value) !== '') selections.push({ name, value: stripTags(value) });
  }
  let primaryBlock = null;
  for (const containerId of PRIMARY_PRICE_CONTAINERS) {
    primaryBlock = extractDivById(text, containerId);
    if (primaryBlock !== null) break;
  }
  // Classify every price element in the primary container: explicit strike-through/list prices,
  // monthly-payment labels and other-offer labels are NOT competing current-offer prices; their
  // raw text stays available as separate lineage (excludedPrices), never as the current price.
  const priceSpans = [];
  if (primaryBlock !== null) {
    for (const match of primaryBlock.matchAll(/<span[^>]*class="[^"]*a-offscreen[^"]*"[^>]*>([^<]+)<\/span>/gi)) {
      const before = primaryBlock.slice(0, match.index);
      const lastOpen = before.lastIndexOf('<span');
      const tagHtml = lastOpen >= 0 ? before.slice(lastOpen, before.indexOf('>', lastOpen) + 1) : '';
      const context = primaryBlock.slice(Math.max(0, match.index - 200), match.index);
      const kind = /data-a-strike="true"/i.test(tagHtml) || /a-text-price/i.test(tagHtml)
        ? 'strike'
        : /list\s*price|typical\s*price/i.test(context)
          ? 'list'
          : /monthly|per\s+month|\/\s*mo\b/i.test(context)
            ? 'monthly'
            : 'current';
      priceSpans.push({ kind, ...parseMoney(match[1]) });
    }
  }
  const currentPrices = priceSpans.filter((entry) => entry.kind === 'current');
  const known = currentPrices.filter((price) => price.currency !== 'unknown' && price.amountMicros !== null);
  const distinct = new Set(known.map((price) => `${price.currency}:${price.amountMicros}`));
  let price = null;
  let priceStatus = 'missing';
  if (distinct.size > 1) {
    priceStatus = 'conflict';
  } else if (distinct.size === 1) {
    price = known[0];
    priceStatus = 'fact';
  } else if (currentPrices.length > 0) {
    priceStatus = 'currency_unknown';
  }
  const ratingValue = matchOne(text, /([0-9](?:\.[0-9])?)\s*out of 5 stars/i);
  const ratingCount = matchOne(text, /([0-9][0-9,]*)\s*ratings?\b/i);
  const availabilityRaw = matchOne(text, /<div[^>]*id="availability"[^>]*>([\s\S]*?)<\/div>/i);
  const availabilityText = availabilityRaw === null ? '' : stripTags(availabilityRaw).toLowerCase();
  const availability = /in stock/.test(availabilityText) ? 'in_stock' : /out of stock|currently unavailable/.test(availabilityText) ? 'out_of_stock' : 'unknown';
  return {
    pageSynthetic,
    observedAt,
    fetchedAt,
    title: titleRaw === null ? null : stripTags(titleRaw),
    pageAsin,
    selections,
    price,
    priceStatus,
    priceCandidates: currentPrices.map((entry) => entry.amountText),
    excludedPrices: priceSpans
      .filter((entry) => entry.kind !== 'current')
      .map((entry) => ({ amountText: entry.amountText, kind: entry.kind })),
    rating: ratingValue === null ? null : { value: Number(ratingValue), count: ratingCount === null ? null : Number(ratingCount.replace(/,/g, '')) },
    availability
  };
}

/** Search pages only ever produce candidates; no price fact is extracted here. */
function parseSearchCandidates(html) {
  const text = String(html ?? '');
  const candidates = [];
  const blocks = text.split(/(?=<div[^>]*data-component-type="s-search-result")/i);
  for (const block of blocks) {
    const asin = matchOne(block, /data-asin="([A-Z0-9]{10})"/i);
    if (asin === null) continue;
    const titleRaw = matchOne(block, /<h2[^>]*>([\s\S]*?)<\/h2>/i) ?? matchOne(block, /class="[^"]*a-text-normal[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    candidates.push({ asin, title: titleRaw === null ? null : stripTags(titleRaw) });
  }
  return { candidatesOnly: true, candidates, priceFactsExtracted: 0 };
}

const amazonUsPdpAdapter = Object.freeze({
  adapterId: 'amazon-us-pdp',
  host: AMAZON_US.host,
  market: AMAZON_US.market,
  locale: AMAZON_US.locale,
  buildSelectedVariantRequest,
  buildSearchRequest,
  parseSelectedVariantPdp,
  parseSearchCandidates
});

module.exports = {
  AMAZON_US,
  ASIN_RE,
  CURRENCY_BY_SYMBOL,
  parseMoney,
  buildSelectedVariantRequest,
  buildSearchRequest,
  parseSelectedVariantPdp,
  parseSearchCandidates,
  amazonUsPdpAdapter
};
