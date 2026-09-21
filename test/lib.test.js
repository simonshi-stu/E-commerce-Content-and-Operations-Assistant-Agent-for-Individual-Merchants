'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, it } = require('node:test');

const { MAX_IMAGE_BYTES, detectImageMime, validateInput } = require('../lib/validate');
const { extractJson, normalizeDrafts } = require('../lib/normalize');
const { buildReview, buildMissingInfo, complianceReminders, factCheck, scanRiskyClaims } = require('../lib/review');
const { buildIntelMessages, buildMessages, CREDIBILITY_PROMPT_BLOCK, SYSTEM_PROMPTS } = require('../lib/prompt');
const { parsePort, parseTimeout, resolveConfigValue } = require('../lib/env');
const { normalizeLocale, reviewMessages, uiMessage } = require('../lib/messages');
const { compareCompetitors, priceStats, scoreProduct } = require('../lib/intel');
const { aggregateCredibility, assessmentConfidence, entryCredibility } = require('../lib/credibility');
const { buildTimeline } = require('../lib/timeline');
const { parsePriceCsv } = require('../lib/csv');
const { createFxService, parseRates } = require('../lib/fx');
const { buildPricing } = require('../lib/pricing');
const { assessCandidates, parseCandidateText } = require('../lib/candidates');
const { analyzeMarket, parseBought, parseMarketRows } = require('../lib/market');
const { normalizeIntelReview } = require('../lib/normalize');

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BASE_INPUT = {
  productName: '保温杯',
  productDescription: '316 不锈钢保温杯，日常通勤使用。',
  platforms: ['Xiaohongshu']
};

function normalizedBase(overrides = {}) {
  const result = validateInput({ ...BASE_INPUT, ...overrides });
  assert.equal(result.error, undefined);
  return result.value;
}

describe('validateInput', () => {
  it('applies defaults and trims text fields', () => {
    const value = normalizedBase({ productName: '  保温杯  ', tone: '  ' });
    assert.equal(value.productName, '保温杯');
    assert.equal(value.tone, 'clear and helpful');
    assert.deepEqual(value.sellingPoints, []);
    assert.deepEqual(value.specifications, []);
    assert.deepEqual(value.images, []);
  });

  it('deduplicates platforms and drops unsupported ones', () => {
    const value = normalizedBase({ platforms: ['Douyin', 'Douyin', 'Taobao', 'Xiaohongshu'] });
    assert.deepEqual(value.platforms, ['Douyin', 'Xiaohongshu']);
  });

  it('rejects missing required fields', () => {
    assert.ok(validateInput({ productName: '只有名称' }).error);
    assert.ok(validateInput({ ...BASE_INPUT, platforms: [] }).error);
    assert.ok(validateInput({ ...BASE_INPUT, productDescription: '' }).error);
  });

  it('caps extended list fields and accepts object specifications', () => {
    const value = normalizedBase({
      sellingPoints: Array.from({ length: 12 }, (unused, index) => `卖点 ${index}`),
      specifications: { 容量: '500ml', 材质: '316 不锈钢' }
    });
    assert.equal(value.sellingPoints.length, 8);
    assert.deepEqual(value.specifications, [
      { name: '容量', value: '500ml' },
      { name: '材质', value: '316 不锈钢' }
    ]);
  });

  it('accepts a valid PNG image and strips a data URL prefix', () => {
    const value = normalizedBase({
      images: [{ name: 'cup.png', mimeType: 'image/png', dataBase64: `data:image/png;base64,${TINY_PNG_BASE64}` }]
    });
    assert.equal(value.images.length, 1);
    assert.equal(value.images[0].mimeType, 'image/png');
    assert.equal(value.images[0].dataBase64, TINY_PNG_BASE64);
  });

  it('rejects mismatched, unsupported, and oversized images', () => {
    assert.ok(validateInput({
      ...BASE_INPUT,
      images: [{ mimeType: 'image/jpeg', dataBase64: TINY_PNG_BASE64 }]
    }).error);
    assert.ok(validateInput({
      ...BASE_INPUT,
      images: [{ mimeType: 'image/gif', dataBase64: TINY_PNG_BASE64 }]
    }).error);
    assert.ok(validateInput({
      ...BASE_INPUT,
      images: [{ mimeType: 'image/png', dataBase64: 'not base64 !!' }]
    }).error);
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 8).toString('base64');
    assert.ok(validateInput({
      ...BASE_INPUT,
      images: [{ mimeType: 'image/png', dataBase64: oversized }]
    }).error);
  });

  it('rejects more than four images', () => {
    const image = { mimeType: 'image/png', dataBase64: TINY_PNG_BASE64 };
    assert.ok(validateInput({ ...BASE_INPUT, images: [image, image, image, image, image] }).error);
  });
});

describe('detectImageMime', () => {
  it('detects PNG magic bytes and rejects unknown content', () => {
    assert.equal(detectImageMime(Buffer.from(TINY_PNG_BASE64, 'base64')), 'image/png');
    assert.equal(detectImageMime(Buffer.from('not an image at all')), null);
  });
});

describe('normalizeDrafts', () => {
  it('parses plain, fenced, and prefixed JSON payloads', () => {
    const payload = { drafts: [{ platform: 'Xiaohongshu', title: 'A', body: 'B' }] };
    assert.deepEqual(extractJson(JSON.stringify(payload)), payload);
    assert.deepEqual(extractJson(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``), payload);
    assert.deepEqual(extractJson(`前缀说明 ${JSON.stringify(payload)} 后缀`), payload);
    assert.throws(() => extractJson('not json at all'));
    assert.throws(() => extractJson(''));
  });

  it('maps drafts onto requested platforms and fills missing platforms by position', () => {
    const drafts = normalizeDrafts({
      drafts: [
        { platform: 'Unknown', title: 'A', body: 'B' },
        { platform: 'Douyin', title: 'C', body: 'D' }
      ]
    }, ['Xiaohongshu', 'Douyin']);
    assert.equal(drafts[0].platform, 'Xiaohongshu');
    assert.equal(drafts[1].platform, 'Douyin');
  });

  it('deduplicates platforms and caps list fields', () => {
    const drafts = normalizeDrafts({
      drafts: [
        { platform: 'Xiaohongshu', title: 'A', body: 'B', tags: Array.from({ length: 20 }, (unused, index) => `tag-${index}`) },
        { platform: 'Xiaohongshu', title: 'duplicate', body: 'B' }
      ]
    }, ['Xiaohongshu']);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].tags.length, 12);
  });

  it('rejects empty or non-array draft collections', () => {
    assert.throws(() => normalizeDrafts({ drafts: [] }, ['Xiaohongshu']));
    assert.throws(() => normalizeDrafts({ drafts: {} }, ['Xiaohongshu']));
    assert.throws(() => normalizeDrafts(null, ['Xiaohongshu']));
  });
});

describe('review rules', () => {
  const draft = (overrides = {}) => ({
    platform: 'Xiaohongshu',
    title: '标题',
    body: '正文',
    tags: [],
    sellingPoints: [],
    reviewNotes: [],
    missingInfo: [],
    ...overrides
  });

  it('scans risky wording with severity levels', () => {
    const warnings = scanRiskyClaims([draft({ body: '全网最低价，永久保温，治疗失眠。' })]);
    assert.ok(warnings.some((warning) => warning.term === '全网最低' && warning.severity === 'high'));
    assert.ok(warnings.some((warning) => warning.term === '永久'));
    assert.ok(warnings.some((warning) => warning.term === '治疗'));
    assert.deepEqual(scanRiskyClaims([draft()]), []);
  });

  it('flags numbers that do not appear in the supplied facts', () => {
    const input = normalizedBase({ specifications: [{ name: '容量', value: '500ml' }] });
    const checks = factCheck([draft({ body: '容量 500ml，续航 999ml。' })], '容量 500ml');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].claim, '999ml');
    assert.equal(checks[0].status, 'needs_review');
    assert.ok(input.specifications.length === 1);
  });

  it('lists missing product facts and platform-specific hints', () => {
    const items = buildMissingInfo(normalizedBase({ platforms: ['Tmall'] }));
    assert.ok(items.some((item) => item.includes('价格')));
    assert.ok(items.some((item) => item.includes('规格参数')));
    assert.ok(items.some((item) => item.includes('天猫')));
  });

  it('builds compliance reminders per platform with a cap', () => {
    const reminders = complianceReminders(['Xiaohongshu', 'Douyin', 'Tmall', 'Pinduoduo']);
    assert.ok(reminders.some((item) => item.includes('广告法')));
    assert.ok(reminders.some((item) => item.includes('小红书')));
    assert.ok(reminders.some((item) => item.includes('拼多多')));
    assert.ok(reminders.length <= 10);
  });

  it('reports platforms the model failed to return', () => {
    const review = buildReview(normalizedBase({ platforms: ['Xiaohongshu', 'Douyin'] }), [draft()]);
    assert.ok(review.missingInfo.some((item) => item.includes('Douyin')));
    assert.deepEqual(review.coverage, { requested: ['Xiaohongshu', 'Douyin'], returned: ['Xiaohongshu'] });
  });
});

describe('prompt builder', () => {
  it('builds a text-only message when no images are supplied', () => {
    const messages = buildMessages(normalizedBase());
    assert.equal(messages.length, 2);
    assert.equal(typeof messages[1].content, 'string');
    assert.match(messages[1].content, /"platforms"/);
  });

  it('builds multimodal content without leaking base64 into the text part', () => {
    const messages = buildMessages(normalizedBase({
      images: [{ mimeType: 'image/png', dataBase64: TINY_PNG_BASE64 }]
    }));
    assert.ok(Array.isArray(messages[1].content));
    assert.equal(messages[1].content[1].type, 'image_url');
    assert.equal(messages[1].content[1].image_url.url, `data:image/png;base64,${TINY_PNG_BASE64}`);
    assert.equal(messages[1].content[0].text.includes(TINY_PNG_BASE64), false);
  });
});

describe('env parsing', () => {
  it('parses ports with safe fallbacks', () => {
    assert.equal(parsePort('0'), 0);
    assert.equal(parsePort('5178'), 5178);
    assert.equal(parsePort('abc'), 5178);
    assert.equal(parsePort('70000'), 5178);
    assert.equal(parsePort('-1'), 5178);
  });

  it('parses timeouts within the allowed range', () => {
    assert.equal(parseTimeout('500'), 60000);
    assert.equal(parseTimeout('30000'), 30000);
    assert.equal(parseTimeout('999999999'), 60000);
  });

  it('resolves the first defined value across sources', () => {
    const sources = [{ DEEPSEEK_MODEL: 'primary' }, { DEEPSEEK_MODEL: 'secondary' }, { AI_MODEL: 'legacy' }];
    assert.equal(resolveConfigValue(sources, 'DEEPSEEK_MODEL', 'AI_MODEL'), 'primary');
    assert.equal(resolveConfigValue([{}, { DEEPSEEK_MODEL: 'secondary' }, { AI_MODEL: 'legacy' }], 'DEEPSEEK_MODEL', 'AI_MODEL'), 'secondary');
    assert.equal(resolveConfigValue([{}, {}, { AI_MODEL: 'legacy' }], 'DEEPSEEK_MODEL', 'AI_MODEL'), 'legacy');
    assert.equal(resolveConfigValue([{}], 'DEEPSEEK_MODEL', 'AI_MODEL', 'fallback'), 'fallback');
  });
});

describe('messages and localization', () => {
  it('normalizes locales and falls back to Chinese', () => {
    assert.equal(normalizeLocale('en'), 'en');
    assert.equal(normalizeLocale('zh'), 'zh');
    assert.equal(normalizeLocale('fr'), 'zh');
    assert.equal(normalizeLocale(undefined), 'zh');
  });

  it('formats localized messages with parameters', () => {
    assert.match(uiMessage('en', 'provider.timeout'), /timed out/i);
    assert.match(uiMessage('zh', 'validation.images.count', { max: 4 }), /4/);
    assert.equal(uiMessage('en', 'unknown.key'), 'unknown.key');
  });

  it('provides review dictionaries for both locales', () => {
    assert.ok(reviewMessages('en').compliance.length >= 6);
    assert.ok(reviewMessages('en').missing.price.length > 0);
    assert.ok(reviewMessages('zh').platformCompliance.Pinduoduo.length > 0);
  });

  it('builds an English system prompt for locale en', () => {
    assert.match(SYSTEM_PROMPTS.en, /You are an e-commerce content assistant/);
    const messages = buildMessages({ ...normalizedBase({ locale: 'en' }) });
    assert.match(messages[0].content, /Fact rules/);
  });

  it('localizes review output in English', () => {
    const input = normalizedBase({ locale: 'en' });
    const review = buildReview(input, [{
      platform: 'Xiaohongshu',
      title: 'Best tumbler ever',
      body: 'Body',
      tags: [],
      sellingPoints: [],
      reviewNotes: [],
      missingInfo: []
    }]);
    assert.ok(review.missingInfo.some((item) => /No price/.test(item)));
    assert.ok(review.complianceReminders.some((item) => /Advertising rules/.test(item)));
    assert.ok(review.riskWarnings.some((warning) => warning.term.toLowerCase() === 'best'));
  });
});

describe('intel scoring', () => {
  const base = {
    name: 'Tumbler',
    price: 100,
    unitCost: 30,
    shippingCost: 10,
    platformFeeRate: 5,
    adCostPerUnit: 5,
    targetMarginRate: 30,
    demand: 4,
    competition: 3,
    differentiation: 4,
    risk: 2
  };

  it('computes margin metrics and a weighted score', () => {
    const { result } = scoreProduct(base, 'en');
    assert.equal(result.metrics.platformFee, 5);
    assert.equal(result.metrics.grossProfit, 50);
    assert.equal(result.metrics.marginRate, 50);
    assert.equal(result.metrics.breakEvenPrice, 47.37);
    assert.deepEqual(result.scores, { margin: 100, demand: 75, competition: 50, differentiation: 75, risk: 75 });
    assert.equal(result.totalScore, 80);
    assert.equal(result.verdict, 'recommended');
  });

  it('marks loss-making candidates as avoid', () => {
    const { result } = scoreProduct({ ...base, price: 40 }, 'en');
    assert.ok(result.metrics.grossProfit < 0);
    assert.equal(result.verdict, 'avoid');
  });

  it('requires a name and a positive price', () => {
    assert.ok(scoreProduct({ name: '', price: 10 }, 'en').error);
    assert.ok(scoreProduct({ name: 'x', price: 0 }, 'zh').error);
  });
});

describe('competitor comparison', () => {
  const payload = {
    productName: 'Tumbler',
    price: 80,
    sellingPoints: ['24-hour heat retention', 'one-touch lid'],
    competitors: [
      { platform: 'Tmall', title: 'A', price: 100, sellingPoints: ['heat retention;one-touch lid;gift box'] },
      { platform: 'Douyin', title: 'B', price: 120, sellingPoints: ['heat retention;leak proof'] },
      { platform: 'Pinduoduo', title: 'C', price: 90, sellingPoints: ['budget friendly;one-touch lid'] }
    ]
  };

  it('computes price stats, position, and keyword gaps', () => {
    const { result } = compareCompetitors(payload, 'en');
    assert.equal(result.stats.count, 3);
    assert.equal(result.stats.min, 90);
    assert.equal(result.stats.max, 120);
    assert.equal(result.stats.average, 103.33);
    assert.equal(result.stats.median, 100);
    assert.equal(result.position, 'lowest');
    assert.ok(result.gapPercent < 0);
    assert.ok(result.gaps.some((gap) => gap.keyword === 'leak proof'));
    assert.ok(result.differentiators.includes('24-hour heat retention'));
  });

  it('requires a price and at least one priced competitor', () => {
    assert.ok(compareCompetitors({ price: 0, competitors: [{ price: 10 }] }, 'en').error);
    assert.ok(compareCompetitors({ price: 10, competitors: [] }, 'zh').error);
  });
});

describe('price analysis', () => {
  it('computes the price band, break-even, and suggested price', () => {
    const { result } = priceStats({
      points: [
        { label: 'mine', price: 90, type: 'own' },
        { label: 'a', price: 100, type: 'competitor' },
        { label: 'b', price: 120, type: 'competitor' }
      ],
      unitCost: 30,
      shippingCost: 5,
      adCostPerUnit: 5,
      platformFeeRate: 10,
      targetMarginRate: 25
    }, 'en');
    assert.equal(result.stats.count, 3);
    assert.equal(result.stats.average, 103.33);
    assert.equal(result.stats.median, 100);
    assert.equal(result.groups.own.count, 1);
    assert.equal(result.groups.competitor.count, 2);
    assert.equal(result.costs.fixedCost, 40);
    assert.equal(result.costs.breakEvenPrice, 44.44);
    assert.equal(result.costs.suggestedPrice, 61.54);
    assert.equal(result.costs.feasible, true);
    assert.ok(['high', 'medium', 'low'].includes(result.confidence.level));
    assert.ok(result.dataCredibility.score > 0);
  });

  it('marks impossible fee and margin targets as infeasible', () => {
    const { result } = priceStats({
      points: [{ label: 'x', price: 50 }],
      unitCost: 10,
      platformFeeRate: 60,
      targetMarginRate: 50
    }, 'en');
    assert.equal(result.costs.feasible, false);
    assert.equal(result.costs.suggestedPrice, 0);
  });

  it('requires at least one valid price point', () => {
    assert.ok(priceStats({ points: [] }, 'zh').error);
    assert.ok(priceStats({ points: [{ price: 0 }] }, 'en').error);
  });
});

describe('credibility scoring', () => {
  const NOW = Date.parse('2026-09-21T00:00:00.000Z');

  it('scores a fresh official source as high', () => {
    const credibility = entryCredibility({
      price: 100,
      sourceType: 'official_store',
      sourceNote: 'https://example.com/item/1',
      observedAt: '2026-09-20'
    }, NOW);
    assert.equal(credibility.score, 98);
    assert.equal(credibility.level, 'high');
    assert.deepEqual(credibility.reasons, []);
  });

  it('caps unknown or stale sources below high', () => {
    const unknown = entryCredibility({ price: 100 }, NOW);
    assert.equal(unknown.sourceType, 'unknown');
    assert.equal(unknown.score, 40);
    assert.equal(unknown.level, 'low');
    assert.ok(unknown.reasons.includes('unknown_source'));
    assert.ok(unknown.reasons.includes('missing_date'));

    const stale = entryCredibility({
      price: 100,
      sourceType: 'official_store',
      sourceNote: 'saved copy',
      observedAt: '2026-03-05'
    }, NOW);
    assert.equal(stale.score, 60);
    assert.equal(stale.level, 'medium');
    assert.ok(stale.reasons.includes('stale_180d'));
  });

  it('aggregates entries with agreement and sample reasons', () => {
    const aggregate = aggregateCredibility([
      { price: 100, sourceType: 'official_store', sourceNote: 'page', observedAt: '2026-09-20' },
      { price: 200 }
    ], NOW);
    assert.equal(aggregate.sampleCount, 2);
    assert.equal(aggregate.score, 55);
    assert.equal(aggregate.level, 'medium');
    assert.equal(aggregate.agreement, 0.33);
    assert.ok(aggregate.reasons.includes('unknown_source'));
    assert.ok(aggregate.reasons.includes('missing_date'));
    assert.ok(aggregate.reasons.includes('small_sample'));

    const empty = aggregateCredibility([], NOW);
    assert.deepEqual(empty.reasons, ['no_data']);
  });

  it('derives assessment confidence from basis, date, and sample size', () => {
    const verified = assessmentConfidence({ dataBasis: 'verified', observedAt: '2026-09-20', now: NOW });
    assert.equal(verified.score, 100);
    assert.equal(verified.level, 'high');

    const estimated = assessmentConfidence({ dataBasis: 'estimated', now: NOW });
    assert.equal(estimated.level, 'medium');
    assert.ok(estimated.reasons.includes('estimated_inputs'));
    assert.ok(estimated.reasons.includes('missing_date'));

    const guess = assessmentConfidence({ dataBasis: 'guess', now: NOW });
    assert.equal(guess.level, 'low');
    assert.ok(guess.reasons.includes('unverified_inputs'));

    const aggregate = aggregateCredibility([
      { price: 100, sourceType: 'official_store', sourceNote: 'page', observedAt: '2026-09-20' },
      { price: 200 }
    ], NOW);
    const confidence = assessmentConfidence({ aggregate });
    assert.equal(confidence.score, 50);
    assert.equal(confidence.level, 'medium');
  });
});

describe('intel credibility integration', () => {
  it('attaches confidence to product scores', () => {
    const today = new Date().toISOString().slice(0, 10);
    const { result } = scoreProduct({
      name: 'Tumbler',
      price: 100,
      unitCost: 30,
      targetMarginRate: 20,
      dataBasis: 'verified',
      observedAt: today
    }, 'en');
    assert.equal(result.dataBasis, 'verified');
    assert.equal(result.confidence.score, 100);
    assert.equal(result.confidence.level, 'high');
  });

  it('adds per-entry credibility, ranking, and aggregate credibility to comparisons', () => {
    const today = new Date().toISOString().slice(0, 10);
    const { result } = compareCompetitors({
      productName: 'Tumbler',
      price: 80,
      sellingPoints: ['heat retention'],
      competitors: [
        { platform: 'Tmall', title: 'A', price: 100, sellingPoints: ['gift box'], sourceType: 'official_store', sourceNote: 'page', observedAt: today },
        { platform: 'Douyin', title: 'B', price: 140, sellingPoints: ['leak proof'], sourceType: 'unknown' }
      ]
    }, 'en');
    assert.equal(result.ranking.length, 2);
    assert.equal(result.ranking[0].platform, 'Tmall');
    assert.ok(result.ranking[0].credibility.score > result.ranking[1].credibility.score);
    assert.equal(result.dataCredibility.sampleCount, 2);
    assert.ok(result.dataCredibility.reasons.includes('unknown_source'));
    assert.ok(result.confidence.score > 0);
  });

  it('attaches credibility to every price point', () => {
    const { result } = priceStats({
      points: [
        { label: 'mine', price: 90, type: 'own', sourceType: 'merchant_record', sourceNote: 'order log', observedAt: new Date().toISOString().slice(0, 10) },
        { label: 'a', price: 120 }
      ]
    }, 'en');
    assert.equal(result.points[0].credibility.sourceType, 'merchant_record');
    assert.equal(result.points[1].credibility.sourceType, 'unknown');
    assert.ok(result.points[0].credibility.score > result.points[1].credibility.score);
  });
});

describe('intel review normalization and prompt contract', () => {
  it('normalizes a model review and clamps the confidence score', () => {
    const review = normalizeIntelReview({
      summary: 'Data looks thin.',
      confidence: { score: 180, reasons: ['small_sample', 42] },
      caveats: ['Only one source'],
      recommendations: ['Add an official page']
    });
    assert.equal(review.confidence.score, 100);
    assert.equal(review.confidence.level, 'high');
    assert.deepEqual(review.confidence.reasons, ['small_sample']);
    assert.deepEqual(review.caveats, ['Only one source']);
    assert.throws(() => normalizeIntelReview({ confidence: { score: 50 } }));
  });

  it('exposes the credibility contract in prompts for API calls', () => {
    assert.match(CREDIBILITY_PROMPT_BLOCK, /Source credibility contract/);
    assert.match(CREDIBILITY_PROMPT_BLOCK, /official_store/);
    const messages = buildIntelMessages({ locale: 'en', kind: 'compare', result: { stats: { count: 1 } } });
    assert.match(messages[0].content, /Source credibility contract/);
    assert.match(messages[0].content, /confidence\.score/);
    assert.equal(messages[1].role, 'user');

    const zhMessages = buildIntelMessages({ locale: 'zh', kind: 'compare', result: {} });
    assert.match(zhMessages[0].content, /数据可信度契约/);
  });
});

describe('price timeline', () => {  it('builds series, trend, and volatility from dated points', () => {
    const timeline = buildTimeline([
      { platform: 'Tmall', label: 'Competitor A', price: 100, observedAt: '2026-09-01', sourceType: 'official_store' },
      { platform: 'Tmall', label: 'Competitor A', price: 110, observedAt: '2026-09-10', sourceType: 'official_store' },
      { platform: 'Tmall', label: 'Competitor A', price: 90, observedAt: '2026-09-20', sourceType: 'official_store' },
      { platform: 'Pinduoduo', label: 'Mine', price: 80, observedAt: '2026-09-01', type: 'own' },
      { platform: 'Pinduoduo', label: 'Mine', price: 80, observedAt: '2026-09-20', type: 'own' },
      { price: 70 }
    ]);
    assert.equal(timeline.datedCount, 5);
    assert.equal(timeline.undatedCount, 1);
    assert.equal(timeline.series.length, 2);
    const competitor = timeline.series.find((series) => series.name === 'Competitor A');
    assert.equal(competitor.pointCount, 3);
    assert.equal(competitor.first.price, 100);
    assert.equal(competitor.last.price, 90);
    assert.equal(competitor.changePercent, -10);
    assert.equal(competitor.trend, 'down');
    const mine = timeline.series.find((series) => series.name === 'Mine');
    assert.equal(mine.trend, 'flat');
    assert.equal(timeline.overall.firstDate, '2026-09-01');
    assert.equal(timeline.overall.lastDate, '2026-09-20');
    assert.equal(timeline.overall.trend, 'down');
    assert.ok(timeline.overall.volatility > 0);
    assert.equal(timeline.bounds.min, 80);
    assert.equal(timeline.bounds.max, 110);
  });

  it('handles single points and empty input', () => {
    const single = buildTimeline([{ label: 'A', price: 50, observedAt: '2026-09-01' }]);
    assert.equal(single.series[0].trend, 'flat');
    assert.equal(single.overall.changePercent, 0);
    assert.equal(buildTimeline([]).datedCount, 0);
    assert.equal(buildTimeline(null).undatedCount, 0);
  });
});

describe('price csv import', () => {
  it('parses a header-based csv with provenance fields', () => {
    const csv = [
      'date,platform,label,price,type,source,note',
      '2026-09-01,Tmall,Competitor A,109,competitor,official_store,page URL',
      '2026-09-15,Tmall,Competitor A,105,competitor,official_store,page URL'
    ].join('\n');
    const outcome = parsePriceCsv(csv, 'en');
    assert.equal(outcome.result.rows.length, 2);
    assert.equal(outcome.result.skipped, 0);
    assert.equal(outcome.result.rows[0].observedAt, '2026-09-01');
    assert.equal(outcome.result.rows[0].sourceType, 'official_store');
    assert.equal(outcome.result.rows[1].price, 105);
    assert.equal(outcome.result.rows[1].type, 'competitor');
  });

  it('supports positional rows, tabs, quotes, and Chinese values', () => {
    const csv = '2026/9/1\t拼多多\t我的价格\t89\t我的价格\t我的实测\t"订单, 记录"\n2026-09-01,Pinduoduo,B,70,competitor,unknown';
    const outcome = parsePriceCsv(csv, 'zh');
    assert.equal(outcome.result.rows.length, 2);
    assert.equal(outcome.result.rows[0].observedAt, '2026-09-01');
    assert.equal(outcome.result.rows[0].type, 'own');
    assert.equal(outcome.result.rows[0].sourceType, 'merchant_record');
    assert.equal(outcome.result.rows[0].sourceNote, '订单, 记录');
    assert.equal(outcome.result.rows[1].sourceType, 'unknown');
  });

  it('reports empty input and counts skipped rows', () => {
    assert.ok(parsePriceCsv('', 'en').error);
    assert.ok(parsePriceCsv('not a price row', 'en').error);
    const partial = parsePriceCsv('date,price\n2026-09-01,abc\n2026-09-02,10', 'en');
    assert.equal(partial.result.rows.length, 1);
    assert.equal(partial.result.skipped, 1);
  });
});

describe('frontend scripts', () => {
  for (const file of ['app.js', 'intel.js', 'i18n.js']) {
    it(`${file} parses without syntax errors`, () => {
      execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'public', file)]);
    });
  }
});

describe('exchange rates', () => {
  it('parses both provider response shapes', () => {
    const primary = parseRates({
      result: 'success',
      base_code: 'USD',
      rates: { CNY: 7.1, EUR: 0.92, BAD: 'x' },
      time_last_update_utc: 'Mon, 21 Sep 2026 00:00:00 +0000'
    });
    assert.equal(primary.base, 'USD');
    assert.equal(primary.rates.CNY, 7.1);
    assert.equal(primary.rates.USD, 1);
    assert.equal(primary.rates.BAD, undefined);
    const fallback = parseRates({ base: 'USD', date: '2026-09-18', rates: { CNY: 6.7 } });
    assert.equal(fallback.updatedAt, '2026-09-18');
    assert.equal(parseRates({}), null);
    assert.equal(parseRates(null), null);
  });

  it('falls back to the secondary provider and caches results', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const fetchImpl = async (url) => {
      if (url.includes('primary')) {
        primaryCalls += 1;
        throw new Error('offline');
      }
      fallbackCalls += 1;
      return { ok: true, json: async () => ({ base: 'USD', date: '2026-09-18', rates: { CNY: 6.7 } }) };
    };
    const service = createFxService({ fetchImpl, primaryUrl: 'https://primary.test', fallbackUrl: 'https://fallback.test', now: () => 1000 });
    const first = await service.getRates('USD');
    assert.equal(first.source, 'frankfurter.app');
    assert.equal(first.cached, false);
    const second = await service.getRates('USD');
    assert.equal(second.cached, true);
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 1);
  });

  it('returns null when both providers fail', async () => {
    const service = createFxService({
      fetchImpl: async () => { throw new Error('offline'); },
      primaryUrl: 'https://p.test',
      fallbackUrl: 'https://f.test'
    });
    assert.equal(await service.getRates('USD'), null);
  });
});

describe('multi-currency pricing', () => {
  const rates = { USD: 1, CNY: 7, EUR: 0.9 };

  it('converts costs and computes break-even and suggested prices', () => {
    const { result } = buildPricing({
      payoutCurrency: 'USD',
      rates,
      productCost: { amount: 70, currency: 'CNY' },
      shipping: { mode: 'per_unit', amount: 14, currency: 'CNY' },
      weightKg: 0.5,
      dimensions: { length: 10, width: 10, height: 20 },
      volumetricDivisor: 5000,
      referralFeeRate: 15,
      fulfillmentFee: { amount: 4, currency: 'USD' },
      adCost: { mode: 'percent', amount: 10 },
      targetMarginRate: 30
    }, 'en');
    assert.equal(result.perUnit.productCost, 10);
    assert.equal(result.perUnit.shippingCost, 2);
    assert.equal(result.volumetricWeight, 0.4);
    assert.equal(result.chargeableWeightKg, 0.5);
    assert.equal(result.fixedCost, 16);
    assert.equal(result.breakEvenPrice, 21.33);
    assert.equal(result.suggestedPrice, 35.56);
    assert.equal(result.feasible, true);
  });

  it('computes profit at the planned price with shipping by weight', () => {
    const { result } = buildPricing({
      payoutCurrency: 'USD',
      rates,
      productCost: { amount: 70, currency: 'CNY' },
      shipping: { mode: 'per_kg', amount: 20, currency: 'CNY' },
      weightKg: 0.8,
      referralFeeRate: 15,
      adCost: { mode: 'per_unit', amount: 3, currency: 'USD' },
      targetMarginRate: 30,
      price: { amount: 30, currency: 'USD' }
    }, 'en');
    assert.equal(result.perUnit.shippingCost, 2.29);
    assert.equal(result.atPlannedPrice.totalCost, 19.79);
    assert.equal(result.atPlannedPrice.profit, 10.21);
    assert.equal(result.atPlannedPrice.marginRate, 34.05);
  });

  it('reports missing rates and required costs', () => {
    assert.ok(buildPricing({ payoutCurrency: 'USD', rates: {}, productCost: { amount: 1, currency: 'CNY' } }, 'en').error);
    assert.ok(buildPricing({ payoutCurrency: 'USD', rates, productCost: { amount: 0 }, price: { amount: 0 } }, 'en').error);
  });
});

describe('candidate batch assessment', () => {
  it('parses header rows with English and Chinese aliases', () => {
    const outcome = parseCandidateText('名称,成本,售价,运费,佣金%,广告,目标毛利%,需求,竞争,差异化,风险,备注\n头盔A,55,29.9,12,15,4,30,4,4,3,2,轻量通风', 'zh');
    assert.equal(outcome.rows.length, 1);
    assert.equal(outcome.rows[0].name, '头盔A');
    assert.equal(outcome.rows[0].cost, 55);
    assert.equal(outcome.rows[0].fee, 15);
    assert.equal(outcome.rows[0].notes, '轻量通风');
  });

  it('parses positional rows and applies default levels', () => {
    const outcome = parseCandidateText('Helmet A,55,29.9', 'en');
    assert.equal(outcome.rows.length, 1);
    assert.equal(outcome.rows[0].name, 'Helmet A');
    assert.equal(outcome.rows[0].demand, 3);
    assert.equal(outcome.rows[0].competition, 3);
    assert.equal(outcome.rows[0].risk, 3);
  });

  it('ranks candidates and counts verdicts', () => {
    const { result } = assessCandidates([
      { name: 'Good', cost: 30, price: 100, shipping: 5, fee: 5, ad: 5, target: 30, demand: 5, competition: 2, differentiation: 4, risk: 2, notes: '' },
      { name: 'Bad', cost: 120, price: 100, shipping: 10, fee: 5, ad: 5, target: 30, demand: 2, competition: 5, differentiation: 1, risk: 5, notes: '' },
      { name: 'NoPrice', cost: 10, price: 0 }
    ], { locale: 'en', dataBasis: 'verified', observedAt: new Date().toISOString().slice(0, 10) });
    assert.equal(result.summary.total, 3);
    assert.equal(result.rows[0].name, 'Good');
    assert.equal(result.rows[0].verdict, 'recommended');
    assert.equal(result.rows[1].name, 'Bad');
    assert.equal(result.rows[1].verdict, 'avoid');
    assert.equal(result.rows[2].verdict, 'invalid');
    assert.equal(result.summary.recommended, 1);
    assert.equal(result.summary.invalid, 1);
    assert.ok(result.summary.averageMarginRate > 0);
    assert.equal(result.rows[0].marketFitScore, 81);
    assert.equal(result.rows[0].northAmericaFit, 'high');
    assert.ok(result.summary.topMarketFit.length > 0);
    assert.equal(result.summary.topMarketFit[0].name, 'Good');
  });

  it('requires input rows', () => {
    assert.ok(parseCandidateText('', 'en').error);
    assert.ok(parseCandidateText('   \n  ', 'zh').error);
  });
});

describe('market recon', () => {
  it('parses bought signals in English and Chinese', () => {
    assert.equal(parseBought('10K+ bought in past month'), 10000);
    assert.equal(parseBought('2M+ bought in past month'), 2000000);
    assert.equal(parseBought('500+ bought in past month'), 500);
    assert.equal(parseBought('过去一个月 1万+ 人购买'), 10000);
    assert.equal(parseBought('过去一个月有 1000+ 人购买'), 1000);
    assert.equal(parseBought(''), 0);
  });

  it('parses rows with a header and keeps provenance fields', () => {
    const outcome = parseMarketRows('keyword,position,title,brand,price,rating,reviews,bought,badge,note\nbike helmet,1,Adult Bike Helmet with MIPS,BrandA,39.99,4.6,12453,10K+ bought in past month,Amazon\'s Choice,commuter', 'en');
    assert.equal(outcome.rows.length, 1);
    assert.equal(outcome.rows[0].brand, 'BrandA');
    assert.equal(outcome.rows[0].price, 39.99);
    assert.equal(outcome.rows[0].bought, 10000);
    assert.equal(outcome.rows[0].reviews, 12453);
  });

  it('analyses brands, price bands, demand, features, and entry', () => {
    const rows = [];
    for (let index = 0; index < 6; index += 1) {
      rows.push({ keyword: 'bike helmet', position: index + 1, title: `MIPS commuter helmet ${index}`, brand: 'BigBrand', price: 40 + index, rating: 4.6, reviews: 5000, bought: 3000, badge: '', note: '' });
    }
    for (let index = 0; index < 4; index += 1) {
      rows.push({ keyword: 'bike helmet', position: index + 7, title: `Lightweight road helmet ${index}`, brand: `Small${index}`, price: 20 + index * 2, rating: 4.4, reviews: 80, bought: 200, badge: '', note: '' });
    }
    const { result } = analyzeMarket(rows, { locale: 'en' });
    assert.equal(result.sample, 10);
    assert.equal(result.brands.count, 5);
    assert.equal(result.brands.top[0].brand, 'BigBrand');
    assert.equal(result.brands.topThreeShare, 80);
    assert.ok(result.brands.dominantSellers.length >= 1);
    assert.equal(result.reviews.median, 5000);
    assert.equal(result.demand.monthlyUnitsFloor, 18800);
    assert.equal(result.demand.reviewRate, 0.01);
    assert.equal(result.demand.cumulativeUnitsEstimate, (6 * 5000 + 4 * 80) * 100);
    assert.equal(result.brands.unknownShare, 0);
    assert.ok(result.features.some((item) => item.term === 'mips'));
    assert.equal(result.price.bands.length, 3);
    assert.ok(['high', 'medium', 'low'].includes(result.entry.level));
    assert.ok(result.entry.reasons.includes('brand_dominance'));
    assert.ok(result.entry.reasons.includes('demand_confirmed'));
    assert.ok(result.entry.reasons.includes('review_wall'));
    assert.ok(result.entry.reasons.includes('healthy_spread'));
  });

  it('excludes unknown brands from concentration and ranking', () => {
    const rows = [
      { title: 'Adult Bike Helmet One', brand: '', price: 30, rating: 4.5, reviews: 100, bought: 50, position: 1, keyword: 'k' },
      { title: 'Unisex Cycling Helmet Two', brand: '', price: 35, rating: 4.5, reviews: 200, bought: 60, position: 2, keyword: 'k' },
      { title: 'Acme Aero Helmet', brand: 'Acme', price: 40, rating: 4.4, reviews: 300, bought: 70, position: 3, keyword: 'k' }
    ];
    const { result } = analyzeMarket(rows, { locale: 'en' });
    assert.equal(result.brands.count, 1);
    assert.equal(result.brands.top[0].brand, 'Acme');
    assert.equal(result.brands.topThreeShare, 33.33);
    assert.equal(result.brands.unknownShare, 66.67);
    assert.ok(result.entry.reasons.includes('missing_brand'));
  });

  it('requires rows', () => {
    assert.ok(parseMarketRows('', 'en').error);
    assert.ok(parseMarketRows('   ', 'zh').error);
  });
});

describe('amazon platform support', () => {  it('accepts Amazon as a platform', () => {
    const value = normalizedBase({ platforms: ['Amazon', 'Tmall'] });
    assert.deepEqual(value.platforms, ['Amazon', 'Tmall']);
  });

  it('includes Amazon guidance and review notes', () => {
    assert.match(SYSTEM_PROMPTS.en, /Amazon North America/);
    assert.match(SYSTEM_PROMPTS.zh, /亚马逊/);
    const review = buildReview(normalizedBase({ locale: 'en', platforms: ['Amazon'] }), [{
      platform: 'Amazon',
      title: 'T',
      body: 'B',
      tags: [],
      sellingPoints: [],
      reviewNotes: [],
      missingInfo: []
    }]);
    assert.ok(review.missingInfo.some((item) => /Amazon/.test(item)));
    assert.ok(review.complianceReminders.some((item) => /Amazon/.test(item)));
  });
});
