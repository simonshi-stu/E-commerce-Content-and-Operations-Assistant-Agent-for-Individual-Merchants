'use strict';

function toText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function toList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const item = entry.trim();
    if (!item) continue;
    items.push(item.slice(0, maxLength));
    if (items.length >= maxItems) break;
  }
  return items;
}

function extractJson(content) {
  const raw = typeof content === 'string' ? content.trim() : '';
  if (!raw) throw new Error('Model output was empty.');
  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate shape.
    }
  }
  throw new Error('Model output was not valid JSON.');
}

function normalizeDraft(raw, platform) {
  return {
    platform,
    title: toText(raw.title, 200),
    body: toText(raw.body, 8_000),
    tags: toList(raw.tags, 12, 40),
    sellingPoints: toList(raw.sellingPoints, 8, 200),
    reviewNotes: toList(raw.reviewNotes, 12, 400),
    missingInfo: toList(raw.missingInfo, 12, 200)
  };
}

function normalizeDrafts(parsed, platforms) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.drafts)) {
    throw new Error('Model output did not contain a drafts array.');
  }
  const drafts = [];
  const seen = new Set();
  for (let index = 0; index < parsed.drafts.length; index += 1) {
    const raw = parsed.drafts[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const declared = toText(raw.platform, 80);
    const platform = platforms.includes(declared) ? declared : platforms[index];
    if (!platform || seen.has(platform)) continue;
    seen.add(platform);
    drafts.push(normalizeDraft(raw, platform));
    if (drafts.length >= 4) break;
  }
  if (drafts.length === 0) throw new Error('Model output did not contain any usable draft.');
  return drafts;
}

function normalizeIntelReview(parsed) {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new Error('Model output did not contain an intel review summary.');
  }
  const rawConfidence = parsed.confidence && typeof parsed.confidence === 'object' ? parsed.confidence : {};
  let score = Number.parseInt(rawConfidence.score, 10);
  if (!Number.isFinite(score)) score = 0;
  score = Math.min(100, Math.max(0, score));
  const level = ['high', 'medium', 'low'].includes(rawConfidence.level)
    ? rawConfidence.level
    : (score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low');
  return {
    summary: toText(parsed.summary, 2_000),
    confidence: { score, level, reasons: toList(rawConfidence.reasons, 10, 80) },
    caveats: toList(parsed.caveats, 10, 300),
    recommendations: toList(parsed.recommendations, 10, 300)
  };
}

module.exports = { extractJson, normalizeDraft, normalizeDrafts, normalizeIntelReview, toList, toText };
