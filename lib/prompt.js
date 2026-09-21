'use strict';

const PLATFORM_GUIDES = Object.freeze({
  Xiaohongshu: '小红书：第一人称种草笔记，真实体验口吻，开头有场景钩子，可少量使用 emoji，正文自然分段。',
  Douyin: '抖音：前 3 秒强钩子，口语化短句，突出使用场景和即时利益点，适合口播或字幕。',
  Tmall: '天猫：正式、信息密度高，结构清晰，突出规格参数、材质、适用人群与售后保障。',
  Pinduoduo: '拼多多：直白务实，突出实惠与实用价值，短句为主，避免华丽辞藻。'
});

const SYSTEM_PROMPT = [
  '你是面向个体商家的中文电商内容助手。你的任务是把商家提供的商品资料改写成可编辑、可复核的文案草稿。',
  '',
  '事实规则：',
  '1. 只能使用商家资料中明确给出的事实，以及商品图片中可以直接观察到的信息。',
  '2. 不要编造认证、检测报告、专利、价格、折扣、库存、销量、排名、用户评价、竞品对比或平台政策。',
  '3. 资料中没有的数字、参数、价格和售后政策不要写进正文，改为记录到 missingInfo 或 reviewNotes。',
  '4. 不使用绝对化用语（最、第一、100%、国家级等）、医疗功效或无法履约的承诺。',
  '',
  '输出要求：只返回 JSON，不要输出解释文字或 Markdown 代码块。结构如下：',
  '{"drafts":[{"platform":"平台","title":"标题","body":"正文","tags":["标签"],"sellingPoints":["卖点"],"reviewNotes":["需人工确认的点"],"missingInfo":["缺失信息"]}]}',
  '',
  '写作要求：',
  '- 为每个请求的平台输出恰好一条草稿，顺序与请求一致，platform 必须使用请求中的英文平台标识。',
  '- title 不超过 34 个汉字；tags 3-8 个且不带 # 号；sellingPoints 3-6 条，每条不超过 30 字。',
  '- body 120-400 字，自然分段，不使用 Markdown 标题语法。',
  `- 平台风格：${Object.entries(PLATFORM_GUIDES).map(([name, guide]) => `${name}：${guide}`).join('；')}。`
].join('\n');

function buildFacts(input) {
  return {
    productName: input.productName,
    productDescription: input.productDescription,
    category: input.category,
    brand: input.brand,
    targetAudience: input.targetAudience,
    priceInfo: input.priceInfo,
    promotionInfo: input.promotionInfo,
    afterSales: input.afterSales,
    sellingPoints: input.sellingPoints,
    specifications: input.specifications,
    tone: input.tone,
    platforms: input.platforms,
    imageNote: input.images.length
      ? `附带 ${input.images.length} 张商品图片，请只依据图片中可观察到的外观、颜色、材质、包装信息进行描述。`
      : '未提供商品图片。'
  };
}

function buildMessages(input) {
  const facts = JSON.stringify(buildFacts(input));
  if (input.images.length === 0) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: facts }
    ];
  }
  const parts = [{ type: 'text', text: facts }];
  for (const image of input.images) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` }
    });
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts }
  ];
}

module.exports = { PLATFORM_GUIDES, SYSTEM_PROMPT, buildFacts, buildMessages };
