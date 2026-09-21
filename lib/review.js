'use strict';

const RISKY_CLAIM_RULES = [
  {
    pattern: /绝对|100%|百分百|全网最低|史上最低|最低价|最高级|第一品牌|销量第一|全国第一|世界第一|全球第一|国家级|世界级|顶级|顶尖|极致|完美|唯一|独家|王牌|冠军|最好|最佳|最强|最大|最便宜|最有效|永不|永久|终身|零风险|无风险|包过|保证有效/,
    reason: '涉嫌绝对化用语或无法证实的排名与承诺（广告法风险）',
    severity: 'high'
  },
  {
    pattern: /治疗|治愈|疗效|消炎|杀菌|抗菌|抗炎|抗癌|降血压|降血糖|降血脂|壮阳|丰胸|减肥|排毒|药效|包治|根治|无副作用|祖传秘方/,
    reason: '涉嫌医疗或保健功效宣称，普通商品通常不得使用',
    severity: 'high'
  },
  {
    pattern: /秒杀同行|碾压|吊打|完胜|独一无二|最先进/,
    reason: '涉嫌贬低同行或不正当竞争',
    severity: 'high'
  },
  {
    pattern: /纯天然|零添加|无添加|食品级|医用级|婴儿级/,
    reason: '属于需要资质或检测报告的宣称，请核实证明材料',
    severity: 'medium'
  },
  {
    pattern: /立即见效|一次见效|立竿见影|当天见效|三天见效|无效退款|假一赔十|终身免费/,
    reason: '属于强承诺，需确认能够履约并符合平台规则',
    severity: 'medium'
  },
  {
    pattern: /央视推荐|国家推荐|政府指定|官方指定|权威认证|专利技术/,
    reason: '需要可核实的授权、认证或专利信息',
    severity: 'medium'
  }
];

const QUANTITY_PATTERN = /(\d+(?:[.,]\d+)?)\s*(%|折|元|块|小时|分钟|个月|天|年|毫升|千克|厘米|毫米|英寸|mAh|ml|mL|ML|kg|KG|cm|CM|mm|MM|升|克|斤|米|寸|L|g|G|W|V)/g;

const BASE_COMPLIANCE_REMINDERS = [
  '广告法提示：避免“最、第一、100%、国家级”等绝对化用语，系统已自动扫描，仍需人工复核。',
  '功效提示：普通商品不得宣称医疗、治疗或保健功效，特殊类目需先取得相应资质。',
  '价格提示：价格、折扣、原价必须真实可核验，并保留依据。',
  '对比提示：不得使用无法证实的销量、排名，或对竞品进行贬低性对比。',
  '素材提示：商品图片、字体、音乐等素材需拥有版权或授权。',
  '发布前请核对平台最新规则与类目要求，本工具不会自动发布内容。'
];

const PLATFORM_COMPLIANCE_REMINDERS = {
  Xiaohongshu: '小红书：品牌合作或商业推广需按平台要求标注，避免虚假种草与硬广导流。',
  Douyin: '抖音：口播与字幕内容需与商品详情一致，价格承诺必须可履约。',
  Tmall: '天猫：标题与关键词需符合类目规范，参数必须与实物一致。',
  Pinduoduo: '拼多多：低价与补贴表述必须真实，不得虚构原价或虚假促销。'
};

const PLATFORM_MISSING_INFO = {
  Xiaohongshu: '小红书：建议补充使用场景、目标人群和类目信息，提升笔记真实感。',
  Douyin: '抖音：建议补充促销信息和使用场景，便于制作短视频钩子。',
  Tmall: '天猫：建议补充品牌授权、规格参数与售后承诺，避免详情页信息不一致。',
  Pinduoduo: '拼多多：建议补充价格与促销信息，突出实惠卖点。'
};

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

function scanRiskyClaims(drafts) {
  const warnings = [];
  const seen = new Set();
  for (const draft of drafts) {
    const text = draftText(draft);
    for (const rule of RISKY_CLAIM_RULES) {
      const regex = new RegExp(rule.pattern.source, 'g');
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
          reason: rule.reason,
          severity: rule.severity
        });
        if (warnings.length >= 30) return warnings;
      }
    }
  }
  return warnings;
}

function factCheck(drafts, corpus) {
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
      checks.set(claim, {
        claim,
        status: 'needs_review',
        note: '商品资料中未出现该数字，请人工确认后再使用。'
      });
      if (checks.size >= 20) return [...checks.values()];
    }
  }
  return [...checks.values()];
}

function buildMissingInfo(input) {
  const items = [];
  const add = (text) => {
    if (!items.includes(text)) items.push(text);
  };
  if (!input.priceInfo) add('未提供价格或价格区间：正文中不应出现具体价格。');
  if (input.specifications.length === 0) add('未提供规格参数：材质、尺寸、容量等数字需要人工核对。');
  if (input.sellingPoints.length === 0) add('未提供核心卖点：建议补充 3-6 条可验证的卖点。');
  if (!input.afterSales) add('未提供售后服务信息（如退换货、质保）。');
  if (!input.targetAudience) add('未提供目标人群：平台文案的人群定位可能不准确。');
  if (!input.brand) add('未提供品牌信息：标题与详情中的品牌相关描述需人工补充。');
  for (const platform of input.platforms) {
    const note = PLATFORM_MISSING_INFO[platform];
    if (note) add(note);
  }
  return items;
}

function complianceReminders(platforms) {
  const reminders = [...BASE_COMPLIANCE_REMINDERS];
  for (const platform of platforms) {
    const reminder = PLATFORM_COMPLIANCE_REMINDERS[platform];
    if (reminder && !reminders.includes(reminder)) reminders.push(reminder);
  }
  return reminders.slice(0, 10);
}

function buildReview(input, drafts) {
  const corpus = buildCorpus(input);
  const modelMissing = drafts.flatMap((draft) => draft.missingInfo);
  const missingInfo = [...new Set([...modelMissing, ...buildMissingInfo(input)])];
  for (const platform of input.platforms) {
    if (!drafts.some((draft) => draft.platform === platform)) {
      missingInfo.push(`模型未返回「${platform}」平台草稿，请重试或减少平台数量。`);
    }
  }
  return {
    missingInfo: missingInfo.slice(0, 15),
    riskWarnings: scanRiskyClaims(drafts),
    factChecks: factCheck(drafts, corpus),
    complianceReminders: complianceReminders(input.platforms),
    coverage: {
      requested: [...input.platforms],
      returned: drafts.map((draft) => draft.platform)
    }
  };
}

module.exports = {
  BASE_COMPLIANCE_REMINDERS,
  PLATFORM_COMPLIANCE_REMINDERS,
  RISKY_CLAIM_RULES,
  buildCorpus,
  buildMissingInfo,
  buildReview,
  complianceReminders,
  factCheck,
  scanRiskyClaims
};
