'use strict';

const UI = {
  zh: {
    'validation.object': '请求内容必须是 JSON 对象。',
    'validation.required': '请填写商品名称、商品描述，并至少选择一个平台。',
    'validation.length': '一个或多个文本字段超出长度限制。',
    'validation.images.format': '图片字段格式不正确。',
    'validation.images.count': '最多支持 {max} 张图片。',
    'validation.images.type': '只支持 PNG、JPEG、WebP 图片。',
    'validation.images.base64': '图片数据不是有效的 Base64。',
    'validation.images.small': '图片数据过小或已损坏。',
    'validation.images.large': '单张图片不能超过 {max} MB。',
    'validation.images.mismatch': '图片内容与声明的格式不一致。',
    'provider.notConfigured': '请先配置 DEEPSEEK_API_KEY（或 AI_API_KEY）再生成草稿。',
    'provider.rejected': '模型服务拒绝了该请求，请检查密钥、额度或频率限制。',
    'provider.visionUnsupported': '当前模型可能不支持图片输入。请配置支持视觉的 DEEPSEEK_VISION_MODEL 后重试，或移除图片。',
    'provider.badRequest': '模型服务拒绝了该请求，请检查模型名称与请求参数。',
    'provider.error': '模型服务无法完成该请求。',
    'provider.invalidOutput': '模型返回格式不符合要求，请重试或更换模型。',
    'provider.timeout': '模型服务请求超时，请重试或调大 DEEPSEEK_TIMEOUT_MS。',
    'provider.unreachable': '无法连接模型服务，请检查网络与 DEEPSEEK_BASE_URL。',
    'intel.score.required': '请填写候选品名称与售价。',
    'intel.compare.required': '请填写你的售价，并至少添加一个带价格的竞品。',
    'intel.prices.required': '请至少添加一条有效的价格记录。'
  },
  en: {
    'validation.object': 'The request body must be a JSON object.',
    'validation.required': 'Provide a product name, a description, and at least one platform.',
    'validation.length': 'One or more text fields exceed the allowed length.',
    'validation.images.format': 'The image field format is invalid.',
    'validation.images.count': 'Up to {max} images are supported.',
    'validation.images.type': 'Only PNG, JPEG, and WebP images are supported.',
    'validation.images.base64': 'The image data is not valid Base64.',
    'validation.images.small': 'The image data is too small or corrupted.',
    'validation.images.large': 'Each image must be at most {max} MB.',
    'validation.images.mismatch': 'The image content does not match the declared type.',
    'provider.notConfigured': 'Set DEEPSEEK_API_KEY or AI_API_KEY before generating a draft.',
    'provider.rejected': 'The model provider rejected this request. Check the key, quota, or rate limit.',
    'provider.visionUnsupported': 'The configured model appears not to accept images. Set DEEPSEEK_VISION_MODEL to a vision-capable model or remove the images.',
    'provider.badRequest': 'The model provider rejected this request. Check the model name and options.',
    'provider.error': 'The model provider could not complete this request.',
    'provider.invalidOutput': 'The model provider returned an unexpected format. Try again or use a different model.',
    'provider.timeout': 'The model provider timed out. Try again or raise DEEPSEEK_TIMEOUT_MS.',
    'provider.unreachable': 'The model provider could not be reached. Check the network and DEEPSEEK_BASE_URL.',
    'intel.score.required': 'Provide a candidate name and a selling price.',
    'intel.compare.required': 'Provide your price and at least one competitor with a price.',
    'intel.prices.required': 'Add at least one valid price point.'
  }
};

const REVIEW = {
  zh: {
    missing: {
      price: '未提供价格或价格区间：正文中不应出现具体价格。',
      specifications: '未提供规格参数：材质、尺寸、容量等数字需要人工核对。',
      sellingPoints: '未提供核心卖点：建议补充 3-6 条可验证的卖点。',
      afterSales: '未提供售后服务信息（如退换货、质保）。',
      targetAudience: '未提供目标人群：平台文案的人群定位可能不准确。',
      brand: '未提供品牌信息：标题与详情中的品牌相关描述需人工补充。',
      draft: '模型未返回「{platform}」平台草稿，请重试或减少平台数量。'
    },
    platformMissing: {
      Xiaohongshu: '小红书：建议补充使用场景、目标人群和类目信息，提升笔记真实感。',
      Douyin: '抖音：建议补充促销信息和使用场景，便于制作短视频钩子。',
      Tmall: '天猫：建议补充品牌授权、规格参数与售后承诺，避免详情页信息不一致。',
      Pinduoduo: '拼多多：建议补充价格与促销信息，突出实惠卖点。'
    },
    compliance: [
      '广告法提示：避免“最、第一、100%、国家级”等绝对化用语，系统已自动扫描，仍需人工复核。',
      '功效提示：普通商品不得宣称医疗、治疗或保健功效，特殊类目需先取得相应资质。',
      '价格提示：价格、折扣、原价必须真实可核验，并保留依据。',
      '对比提示：不得使用无法证实的销量、排名，或对竞品进行贬低性对比。',
      '素材提示：商品图片、字体、音乐等素材需拥有版权或授权。',
      '发布前请核对平台最新规则与类目要求，本工具不会自动发布内容。'
    ],
    platformCompliance: {
      Xiaohongshu: '小红书：品牌合作或商业推广需按平台要求标注，避免虚假种草与硬广导流。',
      Douyin: '抖音：口播与字幕内容需与商品详情一致，价格承诺必须可履约。',
      Tmall: '天猫：标题与关键词需符合类目规范，参数必须与实物一致。',
      Pinduoduo: '拼多多：低价与补贴表述必须真实，不得虚构原价或虚假促销。'
    },
    riskReasons: {
      absolute: '涉嫌绝对化用语或无法证实的排名与承诺（广告法风险）',
      medical: '涉嫌医疗或保健功效宣称，普通商品通常不得使用',
      denigration: '涉嫌贬低同行或不正当竞争',
      qualification: '属于需要资质或检测报告的宣称，请核实证明材料',
      promise: '属于强承诺，需确认能够履约并符合平台规则',
      authority: '需要可核实的授权、认证或专利信息'
    },
    factNote: '商品资料中未出现该数字，请人工确认后再使用。'
  },
  en: {
    missing: {
      price: 'No price or price range was provided: avoid specific prices in the copy.',
      specifications: 'No specifications were provided: verify dimensions, materials, and capacity manually.',
      sellingPoints: 'No selling points were provided: add 3-6 verifiable points.',
      afterSales: 'No after-sales terms were provided (returns, warranty).',
      targetAudience: 'No target audience was provided: audience positioning may be inaccurate.',
      brand: 'No brand information was provided: brand claims need manual review.',
      draft: 'The model did not return a draft for "{platform}". Retry or request fewer platforms.'
    },
    platformMissing: {
      Xiaohongshu: 'Xiaohongshu: add usage scenarios, audience, and category details for a more authentic note.',
      Douyin: 'Douyin: add promotion details and usage scenarios for a stronger video hook.',
      Tmall: 'Tmall: add brand authorization, specifications, and after-sales terms for a consistent detail page.',
      Pinduoduo: 'Pinduoduo: add price and promotion details to highlight value.'
    },
    compliance: [
      'Advertising rules: avoid absolute wording such as "best", "No.1", "100%", or "national-level"; the scanner is a helper, not a guarantee.',
      'Claims: everyday products must not claim medical, therapeutic, or health benefits without the required qualifications.',
      'Pricing: prices, discounts, and reference prices must be truthful and verifiable.',
      'Comparisons: do not use unverifiable rankings, sales claims, or disparaging comparisons.',
      'Assets: images, fonts, and music need a license or written permission.',
      'Check the latest platform rules before publishing; this tool never publishes automatically.'
    ],
    platformCompliance: {
      Xiaohongshu: 'Xiaohongshu: mark sponsored or commercial content as required and avoid fake reviews or hard-selling links.',
      Douyin: 'Douyin: spoken and on-screen text must match the product details, and price promises must be honored.',
      Tmall: 'Tmall: titles and keywords must follow category rules, and specifications must match the physical product.',
      Pinduoduo: 'Pinduoduo: low-price and subsidy claims must be real; never invent reference prices.'
    },
    riskReasons: {
      absolute: 'Possible absolute wording or unverifiable ranking/promise (advertising risk)',
      medical: 'Possible medical or health claim; everyday products usually may not use it',
      denigration: 'Possible disparagement of competitors or unfair competition',
      qualification: 'Claim requires qualifications or test reports; verify the documents',
      promise: 'Strong promise; confirm it can be honored and fits platform rules',
      authority: 'Requires verifiable authorization, certification, or patent information'
    },
    factNote: 'This number does not appear in the supplied product facts; confirm it manually before use.'
  }
};

function normalizeLocale(value) {
  return value === 'en' ? 'en' : 'zh';
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (params[key] !== undefined ? String(params[key]) : match));
}

function uiMessage(locale, key, params = {}) {
  const dictionary = UI[normalizeLocale(locale)] || UI.zh;
  const template = dictionary[key] !== undefined ? dictionary[key] : UI.zh[key];
  return template === undefined ? key : format(template, params);
}

function reviewMessages(locale) {
  return REVIEW[normalizeLocale(locale)] || REVIEW.zh;
}

module.exports = { normalizeLocale, reviewMessages, uiMessage };
