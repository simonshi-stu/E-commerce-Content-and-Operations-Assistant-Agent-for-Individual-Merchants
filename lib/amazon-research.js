'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { analyzeMarket, parseBought } = require('./market');

const AMAZON_HOSTS = new Set(['amazon.com', 'www.amazon.com', 'smile.amazon.com']);
const AMAZON_ASSET_SUFFIXES = ['.amazon.com', '.media-amazon.com', '.ssl-images-amazon.com'];
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 5_000_000;
const CATALOG_QUERY_BY_SEGMENT = {
  bike: 'bicycle helmet',
  road: 'road bike helmet',
  commuter: 'commuter bike helmet',
  mtb: 'mountain bike helmet',
  ebike: 'e-bike helmet',
  fullface: 'full face mountain bike helmet',
  kids: 'kids bike helmet',
  skate: 'skate helmet kids',
  snow: 'ski helmet',
  smart: 'smart bike helmet turn signal',
  equestrian: 'horse riding helmet ASTM F1163',
  climbing: 'rock climbing helmet'
};

function cleanText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeUrl(value) {
  return String(value || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u003A/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/');
}

function safeAmazonUrl(value, asset = false) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text, 'https://www.amazon.com');
    const hostname = url.hostname.toLowerCase();
    const allowed = asset
      ? AMAZON_HOSTS.has(hostname) || AMAZON_ASSET_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
      : AMAZON_HOSTS.has(hostname);
    if (!allowed || !['http:', 'https:'].includes(url.protocol)) return '';
    return url.href.slice(0, 2_000);
  } catch {
    return '';
  }
}

function asinFrom(value) {
  const match = String(value || '').match(/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i) || String(value || '').match(/\b([A-Z0-9]{10})\b/i);
  return match ? match[1].toUpperCase() : '';
}

function parseNumber(value) {
  const parsed = Number.parseFloat(String(value || '').replace(/,/g, '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFirstNumber(value) {
  const match = String(value || '').match(/-?[\d,.]+/);
  return match ? parseNumber(match[0]) : 0;
}

function parseJsonLd(html) {
  const products = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1].trim();
    for (const candidate of [raw, cleanText(raw)]) {
      try {
        const parsed = JSON.parse(candidate);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        for (const value of values) {
          if (value && typeof value === 'object') products.push(value);
          if (value && Array.isArray(value['@graph'])) products.push(...value['@graph']);
        }
        break;
      } catch {
        // Amazon often embeds non-JSON scripts next to JSON-LD; skip those.
      }
    }
  }
  return products.find((item) => {
    const type = Array.isArray(item && item['@type']) ? item['@type'] : [item && item['@type']];
    return type.some((entry) => String(entry || '').toLowerCase() === 'product');
  }) || {};
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return cleanText(match[1]);
  }
  return '';
}

function extractImages(html, product) {
  const candidates = [];
  const jsonImages = Array.isArray(product.image) ? product.image : [product.image];
  candidates.push(...jsonImages);
  const patterns = [
    /(?:hiRes|large|landingImage|mainUrl)["']?\s*:\s*["'](https?:[^"']+)["']/gi,
    /<img[^>]+(?:id=["']landingImage["'][^>]+|class=["'][^"']*s-image[^"']*["'][^>]*)[^>]+src=["'](https?:[^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) candidates.push(decodeUrl(match[1]));
  }
  return [...new Set(candidates.map((item) => safeAmazonUrl(decodeUrl(item), true)).filter(Boolean))].slice(0, 12);
}

function extractReviewSnippets(html) {
  const snippets = [];
  const patterns = [
    /data-hook=["']review-body["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi,
    /class=["'][^"']*review-text-content[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const text = cleanText(match[1]);
      if (text.length >= 12 && !snippets.includes(text)) snippets.push(text.slice(0, 500));
      if (snippets.length >= 12) return snippets;
    }
  }
  return snippets;
}

function extractReviews(html) {
  const reviews = [];
  const pattern = /<div[^>]+data-hook=["']review["'][^>]*>([\s\S]*?)(?=<div[^>]+data-hook=["']review["']|<div[^>]+id=["']reviews-medley-footer["']|$)/gi;
  for (const match of html.matchAll(pattern)) {
    const block = match[1];
    const rating = parseFirstNumber(firstMatch(block, [
      /data-hook=["']review-star-rating["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i,
      /data-hook=["']cmps-review-star-rating["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i,
      /([\d.]+) out of 5 stars/i
    ]));
    const title = firstMatch(block, [
      /data-hook=["']review-title["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i
    ]);
    const text = firstMatch(block, [
      /data-hook=["']review-body["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i
    ]);
    if (!text || text.length < 12) continue;
    const reviewId = firstMatch(block, [/<div[^>]+id=["'](?:customer_review|customer_review-)([A-Z0-9]+)["']/i, /data-review-id=["']([^"']+)["']/i]);
    const reviewHref = firstMatch(block, [/<a[^>]+href=["']([^"']*(?:customer-reviews|review)\/[^"']+)["']/i]);
    const reviewDate = firstMatch(block, [/data-hook=["']review-date["'][^>]*>([\s\S]*?)<\/span>/i]);
    reviews.push({
      rating: Math.min(5, Math.max(1, rating)), title: title.slice(0, 180), text: text.slice(0, 500),
      reviewId: reviewId.slice(0, 120), reviewUrl: reviewHref ? safeAmazonUrl(new URL(reviewHref, 'https://www.amazon.com').href) : '',
      date: reviewDate.slice(0, 180)
    });
    if (reviews.length >= 20) break;
  }
  return reviews;
}

function extractFeatureBullets(html) {
  const sectionMatch = html.match(/<div[^>]+id=["']feature-bullets["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  const section = sectionMatch && sectionMatch[1];
  if (!section) return [];
  const bullets = [];
  for (const match of section.matchAll(/<span[^>]+class=["'][^"']*a-list-item[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)) {
    const text = cleanText(match[1]);
    if (text.length >= 8 && !bullets.includes(text)) bullets.push(text.slice(0, 500));
    if (bullets.length >= 12) break;
  }
  return bullets;
}

function extractBestSellerRanks(html) {
  const text = cleanText(html);
  const marker = text.search(/Best Sellers Rank/i);
  if (marker < 0) return [];
  const section = text.slice(marker, marker + 1_500);
  const ranks = [];
  for (const match of section.matchAll(/#([\d,]+)\s+in\s+([^#|]{3,100})/gi)) {
    const category = cleanText(match[2]).replace(/\s*\(See Top 100.*$/i, '').replace(/\s+ASIN\s+.*$/i, '').trim();
    const rank = Number.parseInt(match[1].replace(/,/g, ''), 10);
    if (!Number.isInteger(rank) || !category) continue;
    if (!ranks.some((item) => item.rank === rank && item.category === category)) ranks.push({ rank, category });
    if (ranks.length >= 8) break;
  }
  return ranks;
}

function extractCustomerSentiment(html) {
  const customerSummary = firstMatch(html, [
    /(Customers\s+(?:appreciate|like|find|are satisfied with|have mixed opinions)[\s\S]{40,2000}?)(?=<!--|<\/span>)/i
  ]);
  const aspects = [];
  for (const match of html.matchAll(/(Positive|Negative|Mixed)\s+aspect,\s*([^,"]+),\s*([\d,]+)\s+mentions/gi)) {
    const sentiment = match[1].toLowerCase();
    const aspect = cleanText(match[2]);
    const mentions = Number.parseInt(match[3].replace(/,/g, ''), 10);
    if (!aspect || !Number.isInteger(mentions)) continue;
    if (!aspects.some((item) => item.sentiment === sentiment && item.aspect === aspect)) aspects.push({ sentiment, aspect, mentions });
    if (aspects.length >= 20) break;
  }
  return { customerSummary, aspects };
}

function extractProductFact(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return firstMatch(html, [
    new RegExp(`<th[^>]*>\\s*${escaped}\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, 'i'),
    new RegExp(`<span[^>]*>\\s*${escaped}\\s*<\\/span>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`, 'i'),
    new RegExp(`${escaped}\\s*:?\\s*([^<]{2,160})`, 'i')
  ]);
}

function extractQuestionSnippets(html) {
  const snippets = [];
  const patterns = [
    /data-hook=["'][^"']*question[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi,
    /class=["'][^"']*question[^"']*["'][^>]*>([\s\S]*?)<\//gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const text = cleanText(match[1]);
      if ((text.includes('?') || /size|fit|head|strap|light|visor|certif/i.test(text)) && text.length >= 12 && !snippets.includes(text)) {
        snippets.push(text.slice(0, 400));
      }
      if (snippets.length >= 10) return snippets;
    }
  }
  return snippets;
}

function extractSizes(text) {
  const values = [];
  const patterns = [
    /\b(?:XS|S|M|L|XL|XXL)\s*[:\-]?\s*\d{2}\s*(?:-|–|to)\s*\d{2}\s*cm\b/gi,
    /\b\d{2}\s*(?:-|–|to)\s*\d{2}\s*cm\b/gi,
    /\b(?:small|medium|large|x-large|xx-large)[^<,;]{0,35}\b\d{2}\s*(?:-|–|to)\s*\d{2}\s*cm\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      const value = cleanText(match[0]);
      if (!values.includes(value)) values.push(value);
    }
  }
  return values.slice(0, 20);
}

function issueTags(snippets) {
  const definitions = [
    ['size_fit', /too small|too large|small for|large for|tight|loose|fit|size|head circumference|头围/i],
    ['comfort', /comfort|comfortable|padding|pressure|hot|sweat|itch|疼|舒适|闷/i],
    ['strap_adjustment', /strap|buckle|dial|adjust|chin|带子|扣|调节/i],
    ['visor_light_battery', /visor|shield|light|led|battery|charge|usb|风镜|灯|电池/i],
    ['durability_quality', /broke|broken|crack|cheap|loose|damage|quality|坏|裂|质量/i],
    ['shipping_packaging', /shipping|package|packaging|arrived|delivery|包装|运输/i]
  ];
  const counts = new Map();
  for (const snippet of snippets) {
    for (const [tag, pattern] of definitions) {
      if (pattern.test(snippet)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

function parseSearchResults(html, keyword) {
  const results = [];
  const pattern = /<div[^>]*data-component-type=["']s-search-result["'][^>]*data-asin=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<div[^>]*data-component-type=["']s-search-result["']|<\/body>)/gi;
  for (const match of html.matchAll(pattern)) {
    const asin = asinFrom(match[1]);
    if (!asin) continue;
    const block = match[2];
    const title = firstMatch(block, [/<span[^>]+class=["'][^"']*a-size-medium[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, /<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i]);
    const urlPath = firstMatch(block, [/href=["']([^"']*(?:\/dp\/|\/gp\/product\/)[^"']*)["']/i]);
    const image = firstMatch(block, [/<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+src=["']([^"']+)["']/i]);
    const whole = firstMatch(block, [/<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
    const fraction = firstMatch(block, [/<span[^>]+class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
    const rating = firstMatch(block, [/<span[^>]+class=["'][^"']*a-icon-alt[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
    const reviews = firstMatch(block, [/<span[^>]+class=["'][^"']*s-underline-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
    results.push({
      keyword,
      position: results.length + 1,
      asin,
      title,
      price: parseNumber(`${whole}.${fraction || '00'}`),
      rating: parseFirstNumber(rating),
      reviews: Math.round(parseNumber(reviews)),
      image: safeAmazonUrl(decodeUrl(image), true),
      url: safeAmazonUrl(urlPath ? new URL(urlPath, 'https://www.amazon.com').href : `https://www.amazon.com/dp/${asin}`),
      sourceType: 'amazon_public_search',
      observedAt: ''
    });
  }
  return results;
}

function parseProductPage(html, url, options = {}) {
  const product = parseJsonLd(html);
  const asin = asinFrom(url) || firstMatch(html, [/["'](?:asin|ASIN)["']\s*[:=]\s*["']([A-Z0-9]{10})["']/i]);
  const title = cleanText(product.name) || firstMatch(html, [/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i]);
  const brand = cleanText(product.brand && (product.brand.name || product.brand)) || firstMatch(html, [/<a[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i]);
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const aggregate = product.aggregateRating || {};
  const priceWhole = firstMatch(html, [/<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
  const priceFraction = firstMatch(html, [/<span[^>]+class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
  const price = parseNumber(offer && offer.price) || parseNumber(firstMatch(html, [/<span[^>]+id=["']priceblock_(?:ourprice|dealprice)["'][^>]*>([\s\S]*?)<\/span>/i, /<div[^>]+id=["']corePrice_feature_div["'][^>]*>[\s\S]{0,1600}?<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>\$([\d,.]+)/i, /<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>\$([\d,.]+)/i])) || parseNumber(`${priceWhole}.${priceFraction || '00'}`);
  const rating = parseFirstNumber(aggregate.ratingValue) || parseFirstNumber(firstMatch(html, [/<span[^>]+id=["']acrPopover["'][^>]+title=["']([^"']+)["']/i, /([\d.]+) out of 5 stars/i]));
  const reviews = Math.round(parseNumber(aggregate.reviewCount) || parseNumber(firstMatch(html, [/<span[^>]+id=["']acrCustomerReviewText["'][^>]*>([\s\d,.]+)/i, /([\d,.]+) global ratings/i])));
  const visibleText = cleanText(html);
  const boughtText = firstMatch(visibleText, [/([\d,.]+\s*[KkMm]?\+?\s*bought in past month)/i, /(过去一个月[^<]{0,30}购买)/i]);
  const imageUrls = extractImages(html, product);
  const reviewSnippets = extractReviewSnippets(html);
  const reviewsVisible = extractReviews(html);
  const questionSnippets = extractQuestionSnippets(html);
  const featureBullets = extractFeatureBullets(html);
  const bestSellerRanks = extractBestSellerRanks(html);
  const customerSentiment = extractCustomerSentiment(html);
  const textForSizes = `${title} ${cleanText(html.slice(0, 1_000_000))}`;
  const sizes = extractSizes(textForSizes);
  const store = firstMatch(html, [/<a[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?Store[\s\S]*?)<\/a>/i, /Visit the\s+([^<]+?)\s+Store/i]);
  const selectedVariant = [
    firstMatch(html, [/<div[^>]+id=["']variation_color_name["'][^>]*>[\s\S]*?<span[^>]+class=["'][^"']*selection[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, /id=["']inline-twister-expanded-dimension-text-color_name["'][^>]*>([\s\S]*?)<\//i]),
    firstMatch(html, [/<div[^>]+id=["']variation_size_name["'][^>]*>[\s\S]*?<span[^>]+class=["'][^"']*selection[^"']*["'][^>]*>([\s\S]*?)<\/span>/i, /id=["']inline-twister-expanded-dimension-text-size_name["'][^>]*>([\s\S]*?)<\//i]),
    firstMatch(html, [/<div[^>]+id=["']variation_style_name["'][^>]*>[\s\S]*?<span[^>]+class=["'][^"']*selection[^"']*["'][^>]*>([\s\S]*?)<\/span>/i])
  ].filter(Boolean).join(' · ');
  const coupon = firstMatch(html, [/(Save\s+\$[\d,.]+\s+with coupon)/i, /(\$[\d,.]+\s+off\s+with coupon)/i, /(Apply\s+\d+%\s+coupon)/i]);
  const canonical = safeAmazonUrl(url);
  return {
    asin,
    title,
    brand: brand.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').trim(),
    price,
    currency: price > 0 ? 'USD' : '',
    priceStatus: price > 0 ? 'observed' : 'not_found',
    selectedVariant,
    coupon,
    rating: Math.min(5, Math.max(0, rating)),
    reviews: Math.max(0, reviews),
    boughtText,
    monthlyUnitsFloor: parseBought(boughtText),
    store,
    productUrl: canonical,
    imageUrl: imageUrls[0] || '',
    imageUrls,
    sizes,
    productDimensions: extractProductFact(html, 'Product Dimensions'),
    itemWeight: extractProductFact(html, 'Item Weight'),
    featureBullets,
    bestSellerRanks,
    customerSummary: customerSentiment.customerSummary,
    customerAspects: customerSentiment.aspects,
    reviewsVisible,
    positiveReviewSnippets: reviewsVisible.filter((item) => item.rating >= 4).map((item) => item.text),
    criticalReviewSnippets: reviewsVisible.filter((item) => item.rating > 0 && item.rating <= 3).map((item) => item.text),
    reviewSnippets,
    questionSnippets,
    reviewIssueTags: issueTags(reviewSnippets),
    sourceType: 'amazon_public_product',
    observedAt: options.observedAt || new Date().toISOString().slice(0, 10),
    pageStatus: title ? 'parsed' : 'partial',
    sizeDataStatus: sizes.length ? 'observed' : 'not_found',
    reviewDataStatus: reviewSnippets.length ? 'observed' : 'not_found'
  };
}

async function fetchPage(url, options = {}) {
  const safe = safeAmazonUrl(url);
  if (!safe) throw Object.assign(new Error('Only public Amazon.com URLs are allowed.'), { code: 'unsafe_url' });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('Fetch is unavailable in this Node runtime.'), { code: 'fetch_unavailable' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(safe, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.8'
      }
    });
    const finalUrl = safeAmazonUrl(response.url || safe);
    if (!finalUrl) throw Object.assign(new Error('Amazon redirected to a non-Amazon URL.'), { code: 'unsafe_redirect' });
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return { ok: false, status: response.status, url: finalUrl, html: html.slice(0, MAX_HTML_BYTES), error: 'page_truncated' };
    return { ok: response.ok, status: response.status, url: finalUrl, html };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Amazon page request timed out.'), { code: 'timeout' });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function catalogQueries(root) {
  const filePath = path.join(root, 'tmp', 'yongbao-catalog.json');
  if (!fs.existsSync(filePath)) return Object.values(CATALOG_QUERY_BY_SEGMENT);
  const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const segments = [...new Set(catalog.map((item) => item.segment).filter(Boolean))];
  return segments.map((segment) => CATALOG_QUERY_BY_SEGMENT[segment]).filter(Boolean);
}

function flattenRecords(searchResults, productRecords) {
  const byAsin = new Map(searchResults.map((row) => [row.asin, row]));
  for (const product of productRecords) {
    const previous = byAsin.get(product.asin) || {};
    byAsin.set(product.asin, { ...previous, ...product, image: product.imageUrl || previous.image || '' });
  }
  return [...byAsin.values()].filter((row) => row.title || row.asin);
}

async function researchPublicAmazon(options = {}) {
  const observedAt = options.observedAt || new Date().toISOString().slice(0, 10);
  const queries = [...new Set((options.queries || []).map((query) => String(query || '').trim()).filter(Boolean))].slice(0, 20);
  const asins = [...new Set((options.asins || []).map(asinFrom).filter(Boolean))].slice(0, 50);
  const maxProductPages = Math.min(50, Math.max(1, Number.parseInt(options.maxProductPages, 10) || 12));
  const parsedDelayMs = Number.parseInt(options.delayMs, 10);
  const delayMs = Math.min(15_000, Math.max(0, Number.isInteger(parsedDelayMs) ? parsedDelayMs : 1_200));
  const errors = [];
  const searchResults = [];
  const productRecords = [];
  const includeReviewPages = Boolean(options.includeReviewPages);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  let requestCount = 0;

  const wait = async () => {
    if (delayMs > 0 && requestCount > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    requestCount += 1;
  };

  const searchQueries = queries.length ? queries : asins.length ? [] : ['bike helmet'];
  for (const query of searchQueries) {
    try {
      await wait();
      const page = await fetchPage(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, options);
      if (!page.ok) {
        errors.push({ stage: 'search', query, code: 'http_status', status: page.status, message: `Amazon search page returned HTTP ${page.status}.` });
        continue;
      }
      const rows = parseSearchResults(page.html, query).slice(0, Math.min(20, options.maxSearchResults || 12));
      searchResults.push(...rows);
      onProgress({ stage: 'search', query, completed: searchResults.length });
    } catch (error) {
      errors.push({ stage: 'search', query, code: error.code || 'fetch_error', message: error.message });
    }
  }

  const candidateAsins = [...new Set([...asins, ...searchResults.map((row) => row.asin)])].slice(0, maxProductPages);
  for (const asin of candidateAsins) {
    try {
      await wait();
      const page = await fetchPage(`https://www.amazon.com/dp/${asin}`, options);
      if (!page.ok) {
        errors.push({ stage: 'product', asin, code: 'http_status', status: page.status, message: `Amazon product page returned HTTP ${page.status}.` });
        continue;
      }
      const record = parseProductPage(page.html, page.url, { observedAt });
      if (!record.asin) record.asin = asin;
      if (includeReviewPages) {
        const collectedReviews = [];
        for (const filterByStar of ['positive', 'critical']) {
          try {
            await wait();
            const reviewPage = await fetchPage(`https://www.amazon.com/product-reviews/${asin}?reviewerType=all_reviews&filterByStar=${filterByStar}`, options);
            if (!reviewPage.ok) throw Object.assign(new Error(`Amazon review page returned HTTP ${reviewPage.status}.`), { code: 'http_status' });
            const visible = extractReviews(reviewPage.html).map((review) => ({ ...review, filterByStar }));
            collectedReviews.push(...visible);
            onProgress({ stage: 'reviews', asin, filterByStar, completed: visible.length });
          } catch (error) {
            errors.push({ stage: 'reviews', asin, filterByStar, code: error.code || 'fetch_error', message: error.message });
          }
        }
        if (collectedReviews.length) {
          const snippets = collectedReviews.map((review) => review.text);
          record.reviewsVisible = collectedReviews;
          record.reviewSnippets = snippets;
          record.positiveReviewSnippets = collectedReviews.filter((review) => review.filterByStar === 'positive' || review.rating >= 4).map((review) => review.text);
          record.criticalReviewSnippets = collectedReviews.filter((review) => review.filterByStar === 'critical' || (review.rating > 0 && review.rating <= 3)).map((review) => review.text);
          record.reviewIssueTags = issueTags(snippets);
          record.reviewDataStatus = 'observed_public_review_pages';
        }
      }
      productRecords.push(record);
      onProgress({ stage: 'product', asin, completed: productRecords.length, total: candidateAsins.length });
    } catch (error) {
      errors.push({ stage: 'product', asin, code: error.code || 'fetch_error', message: error.message });
    }
  }

  const records = flattenRecords(searchResults, productRecords).map((row) => ({
    keyword: row.keyword || '',
    position: row.position || 0,
    asin: row.asin || '',
    title: row.title || '',
    brand: row.brand || '',
    price: Number(row.price) || 0,
    currency: row.currency || '',
    priceStatus: row.priceStatus || (row.sourceType === 'amazon_public_search' ? 'search_only' : 'not_found'),
    selectedVariant: row.selectedVariant || '',
    coupon: row.coupon || '',
    rating: Number(row.rating) || 0,
    reviews: Number(row.reviews) || 0,
    bought: Number(row.monthlyUnitsFloor || row.bought) || 0,
    boughtText: row.boughtText || '',
    image: row.imageUrl || row.image || '',
    imageUrls: row.imageUrls || (row.image ? [row.image] : []),
    url: row.productUrl || row.url || '',
    store: row.store || '',
    sizes: row.sizes || [],
    productDimensions: row.productDimensions || '',
    itemWeight: row.itemWeight || '',
    featureBullets: row.featureBullets || [],
    bestSellerRanks: row.bestSellerRanks || [],
    customerSummary: row.customerSummary || '',
    customerAspects: row.customerAspects || [],
    reviewsVisible: row.reviewsVisible || [],
    positiveReviewSnippets: row.positiveReviewSnippets || [],
    criticalReviewSnippets: row.criticalReviewSnippets || [],
    reviewSnippets: row.reviewSnippets || [],
    questionSnippets: row.questionSnippets || [],
    reviewIssueTags: row.reviewIssueTags || [],
    sourceType: row.sourceType || 'amazon_public_search',
    observedAt: row.observedAt || observedAt,
    pageStatus: row.pageStatus || 'search_only',
    sizeDataStatus: row.sizeDataStatus || 'not_fetched',
    reviewDataStatus: row.reviewDataStatus || 'not_fetched'
  }));
  const marketRows = records.map((row) => ({ ...row, badge: '', note: '' }));
  const market = analyzeMarket(marketRows, { dataBasis: 'amazon_public_frontend', observedAt });
  const sizeCounts = new Map();
  const issueCounts = new Map();
  const reviewSnippets = [];
  const questionSnippets = [];
  for (const row of records) {
    for (const size of row.sizes) sizeCounts.set(size, (sizeCounts.get(size) || 0) + 1);
    for (const issue of row.reviewIssueTags) issueCounts.set(issue.tag, (issueCounts.get(issue.tag) || 0) + issue.count);
    reviewSnippets.push(...row.reviewSnippets.map((text) => ({ asin: row.asin, title: row.title, text })));
    questionSnippets.push(...row.questionSnippets.map((text) => ({ asin: row.asin, title: row.title, text })));
  }
  return {
    provenance: { dataBasis: 'amazon_public_frontend', observedAt, queries, asins, productPagesRequested: candidateAsins.length, reviewPagesRequested: includeReviewPages ? candidateAsins.length * 2 : 0, requests: requestCount },
    market: market.result,
    records,
    competitors: [...records].sort((a, b) => b.bought - a.bought || b.reviews - a.reviews).slice(0, 12),
    sizeFit: {
      recordsWithSizes: records.filter((row) => row.sizes.length).length,
      observedSizes: [...sizeCounts.entries()].map(([size, count]) => ({ size, count })).sort((a, b) => b.count - a.count),
      caveat: '尺码信号来自公开商品页文字，不能替代头围实测；需按目标市场人群单独做尺码表。'
    },
    reviewAnalysis: {
      recordsWithReviews: records.filter((row) => row.reviewSnippets.length).length,
      issueTags: [...issueCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
      reviewSnippets: reviewSnippets.slice(0, 30),
      questionSnippets: questionSnippets.slice(0, 20),
      caveat: '评论和问答只代表抓取时公开可见样本，不代表全部买家。'
    },
    errors
  };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function splitList(value) {
  return String(value || '').split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function createAmazonResearchService({ root, fetchImpl, now = () => new Date() }) {
  const state = { status: 'idle', progress: null, result: null, error: null, jobId: '', startedAt: '', finishedAt: '' };
  const resultPath = path.join(root, 'tmp', 'amazon-research-latest.json');
  try {
    if (fs.existsSync(resultPath)) state.result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    state.result = null;
  }

  function publicState() {
    return {
      status: state.status,
      progress: state.progress,
      error: state.error,
      jobId: state.jobId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      result: state.result
    };
  }

  function start(options = {}) {
    if (state.status === 'running') return { accepted: false, status: publicState() };
    const jobId = `amazon-${now().getTime()}-${Math.random().toString(16).slice(2, 8)}`;
    const startedAt = now().toISOString();
    state.status = 'running';
    state.progress = { stage: 'starting', completed: 0 };
    state.error = null;
    state.jobId = jobId;
    state.startedAt = startedAt;
    state.finishedAt = '';
    const resolvedOptions = { ...options };
    if (resolvedOptions.scope === 'catalog' && (!resolvedOptions.queries || resolvedOptions.queries.length === 0)) {
      resolvedOptions.queries = catalogQueries(root);
    }
    void researchPublicAmazon({
      ...resolvedOptions,
      fetchImpl,
      onProgress: (progress) => { state.progress = progress; }
    }).then((result) => {
      state.status = 'completed';
      state.progress = { stage: 'completed', completed: result.records.length };
      state.result = { ...result, jobId, startedAt, finishedAt: now().toISOString() };
      state.finishedAt = state.result.finishedAt;
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, JSON.stringify(state.result, null, 2));
    }).catch((error) => {
      state.status = 'failed';
      state.error = { code: error.code || 'research_failed', message: error.message || 'Amazon research failed.' };
      state.finishedAt = now().toISOString();
    });
    return { accepted: true, jobId, status: publicState() };
  }

  function startFromConfig(config = {}) {
    if (!config.onStart) return { accepted: false, reason: 'disabled' };
    return start({
      scope: config.scope || 'catalog',
      queries: config.queries || [],
      asins: config.asins || [],
      maxProductPages: config.maxProductPages,
      delayMs: config.delayMs
    });
  }

  return { start, startFromConfig, publicState, catalogQueries };
}

module.exports = {
  CATALOG_QUERY_BY_SEGMENT,
  catalogQueries,
  createAmazonResearchService,
  extractSizes,
  issueTags,
  parseAmazonProductHtml: parseProductPage,
  parseAmazonSearchHtml: parseSearchResults,
  researchPublicAmazon,
  safeAmazonUrl,
  splitList,
  parseBoolean
};
