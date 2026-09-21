'use strict';

const { reviewMessages } = require('./messages');

const RISKY_CLAIM_RULES = [
  {
    category: 'absolute',
    pattern: /绝对|100%|百分百|全网最低|史上最低|最低价|最高级|第一品牌|销量第一|全国第一|世界第一|全球第一|国家级|世界级|顶级|顶尖|极致|完美|唯一|独家|王牌|冠军|最好|最佳|最强|最大|最便宜|最有效|永不|永久|终身|零风险|无风险|包过|保证有效|\bbest\b|world'?s best|best ever|best[- ]seller|no\.?\s*1|number one|#1|guaranteed|100 percent|zero risk|forever|permanent|lowest price/i
  },
  {
    category: 'medical',
    pattern: /治疗|治愈|疗效|消炎|杀菌|抗菌|抗炎|抗癌|降血压|降血糖|降血脂|壮阳|丰胸|减肥|排毒|药效|包治|根治|无副作用|祖传秘方|\bcures?\b|\btreats?\b|treatment|heals?\b|clinically proven|anti-?cancer|weight loss|detox|pain relief/i
  },
  {
    category: 'denigration',
    pattern: /秒杀同行|碾压|吊打|完胜|独一无二|最先进|beats? (all|every)|crush(es)? competitors|better than (all|every|any)/i
  },
  {
    category: 'qualification',
    pattern: /纯天然|零添加|无添加|食品级|医用级|婴儿级|100% natural|all[- ]natural|food[- ]grade|medical[- ]grade|baby[- ]grade|fda[- ]approved|clinically tested/i
  },
  {
    category: 'promise',
    pattern: /立即见效|一次见效|立竿见影|当天见效|三天见效|无效退款|假一赔十|终身免费|instant results|money[- ]back guarantee|lifetime free|lifetime warranty/i
  },
  {
    category: 'authority',
    pattern: /央视推荐|国家推荐|政府指定|官方指定|权威认证|专利技术|as seen on tv|government[- ]approved|officially certified|patented technology/i
  }
];

const QUANTITY_PATTERN = /(\d+(?:[.,]\d+)?)\s*(%|折|元|块|小时|分钟|个月|天|年|毫升|千克|厘米|毫米|英寸|mAh|ml|mL|ML|kg|KG|cm|CM|mm|MM|升|克|斤|米|寸|L|g|G|W|V)/g;

function localeOf(input) {
  return input && input.locale === 'en' ? 'en' : 'zh';
}

function buildCorpus(input) {
  return [
    input.productName,
    input.productDescription,
    input.category,
    input.brand,
    input.targetAudience,
    input.priceInfo,
    input.promotionInfo,
    input.afterSales,
    ...input.sellingPoints,
    ...input.specifications.map((spec) => `${spec.name} ${spec.value}`)
  ]
    .filter(Boolean)
    .join('\n');
}

function draftText(draft) {
  return [draft.title, draft.body, ...draft.tags, ...draft.sellingPoints].filter(Boolean).join('\n');
}

function excerptOf(text, index, length) {
  const start = Math.max(0, index - 12);
  return text.slice(start, Math.min(text.length, index + length + 18)).replace(/\s+/g, ' ').trim();
}

function scanRiskyClaims(drafts, locale = 'zh') {
  const reasons = reviewMessages(locale).riskReasons;
  const warnings = [];
  const seen = new Set();
  for (const draft of drafts) {
    const text = draftText(draft);
    for (const rule of RISKY_CLAIM_RULES) {
      const regex = new RegExp(rule.pattern.source, 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        const term = match[0];
        const key = `${draft.platform}@${match.index}@${term}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push({
          platform: draft.platform,
          term,
          excerpt: excerptOf(text, match.index, term.length),
          reason: reasons[rule.category],
          severity: ['absolute', 'medical', 'denigration'].includes(rule.category) ? 'high' : 'medium'
        });
        if (warnings.length >= 30) return warnings;
      }
    }
  }
  return warnings;
}

function factCheck(drafts, corpus, locale = 'zh') {
  const note = reviewMessages(locale).factNote;
  const checks = new Map();
  for (const draft of drafts) {
    const text = draftText(draft);
    QUANTITY_PATTERN.lastIndex = 0;
    let match;
    while ((match = QUANTITY_PATTERN.exec(text)) !== null) {
      const rawNumber = match[1];
      const normalized = rawNumber.replace(',', '.');
      if (corpus.includes(rawNumber) || corpus.includes(normalized)) continue;
      const claim = `${rawNumber}${match[2]}`;
      if (checks.has(claim)) continue;
      checks.set(claim, { claim, status: 'needs_review', note });
      if (checks.size >= 20) return [...checks.values()];
    }
  }
  return [...checks.values()];
}

function buildMissingInfo(input) {
  const messages = reviewMessages(localeOf(input)).missing;
  const items = [];
  const add = (text) => {
    if (text && !items.includes(text)) items.push(text);
  };
  if (!input.priceInfo) add(messages.price);
  if (input.specifications.length === 0) add(messages.specifications);
  if (input.sellingPoints.length === 0) add(messages.sellingPoints);
  if (!input.afterSales) add(messages.afterSales);
  if (!input.targetAudience) add(messages.targetAudience);
  if (!input.brand) add(messages.brand);
  const platformNotes = reviewMessages(localeOf(input)).platformMissing;
  for (const platform of input.platforms) {
    add(platformNotes[platform]);
  }
  return items;
}

function complianceReminders(platforms, locale = 'zh') {
  const messages = reviewMessages(locale);
  const reminders = [...messages.compliance];
  for (const platform of platforms) {
    const reminder = messages.platformCompliance[platform];
    if (reminder && !reminders.includes(reminder)) reminders.push(reminder);
  }
  return reminders.slice(0, 10);
}

function buildReview(input, drafts) {
  const locale = localeOf(input);
  const messages = reviewMessages(locale).missing;
  const corpus = buildCorpus(input);
  const modelMissing = drafts.flatMap((draft) => draft.missingInfo);
  const missingInfo = [...new Set([...modelMissing, ...buildMissingInfo(input)])];
  for (const platform of input.platforms) {
    if (!drafts.some((draft) => draft.platform === platform)) {
      missingInfo.push(messages.draft.replace('{platform}', platform));
    }
  }
  return {
    missingInfo: missingInfo.slice(0, 15),
    riskWarnings: scanRiskyClaims(drafts, locale),
    factChecks: factCheck(drafts, corpus, locale),
    complianceReminders: complianceReminders(input.platforms, locale),
    coverage: {
      requested: [...input.platforms],
      returned: drafts.map((draft) => draft.platform)
    }
  };
}

module.exports = {
  RISKY_CLAIM_RULES,
  buildCorpus,
  buildMissingInfo,
  buildReview,
  complianceReminders,
  factCheck,
  scanRiskyClaims
};
