'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { MAX_IMAGE_BYTES, detectImageMime, validateInput } = require('../lib/validate');
const { extractJson, normalizeDrafts } = require('../lib/normalize');
const { buildReview, buildMissingInfo, complianceReminders, factCheck, scanRiskyClaims } = require('../lib/review');
const { buildMessages } = require('../lib/prompt');
const { parsePort, parseTimeout, resolveConfigValue } = require('../lib/env');

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
