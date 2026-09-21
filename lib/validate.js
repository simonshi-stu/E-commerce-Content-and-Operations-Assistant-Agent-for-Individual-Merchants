'use strict';

const ALLOWED_PLATFORMS = new Set(['Xiaohongshu', 'Douyin', 'Tmall', 'Pinduoduo']);
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4_000;
const MAX_PRODUCT_NAME_LENGTH = 200;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MIN_IMAGE_BYTES = 32;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function text(value, maxLength) {
  return trimmed(value).slice(0, maxLength);
}

function textList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const entry of value) {
    const item = trimmed(entry);
    if (!item) continue;
    items.push(item.slice(0, maxLength));
    if (items.length >= maxItems) break;
  }
  return items;
}

function normalizeSpecifications(value) {
  let pairs = [];
  if (Array.isArray(value)) {
    pairs = value
      .filter((item) => item && typeof item === 'object')
      .map((item) => [item.name, item.value]);
  } else if (value && typeof value === 'object') {
    pairs = Object.entries(value);
  }
  const specifications = [];
  for (const [rawName, rawValue] of pairs) {
    const name = text(rawName, 40);
    const specValue = text(rawValue, 120);
    if (!name || !specValue) continue;
    specifications.push({ name, value: specValue });
    if (specifications.length >= 20) break;
  }
  return specifications;
}

function decodeBase64Image(dataBase64) {
  const data = dataBase64.replace(/^data:image\/[a-z+.-]+;base64,/i, '');
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return Buffer.from(data, 'base64');
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function normalizeImages(value) {
  if (value === undefined || value === null) return { images: [] };
  if (!Array.isArray(value)) return { error: '图片字段格式不正确。' };
  if (value.length > MAX_IMAGES) return { error: `最多支持 ${MAX_IMAGES} 张图片。` };
  const images = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object') return { error: '图片字段格式不正确。' };
    const declaredType = trimmed(item.mimeType).toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(declaredType)) return { error: '只支持 PNG、JPEG、WebP 图片。' };
    const raw = trimmed(item.dataBase64);
    const buffer = decodeBase64Image(raw);
    if (!buffer) return { error: '图片数据不是有效的 Base64。' };
    if (buffer.length < MIN_IMAGE_BYTES) return { error: '图片数据过小或已损坏。' };
    if (buffer.length > MAX_IMAGE_BYTES) return { error: `单张图片不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB。` };
    if (detectImageMime(buffer) !== declaredType) return { error: '图片内容与声明的格式不一致。' };
    images.push({
      name: text(item.name, 100) || `image-${index + 1}`,
      mimeType: declaredType,
      dataBase64: raw.replace(/^data:image\/[a-z+.-]+;base64,/i, '')
    });
  }
  return { images };
}

function validateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '请求内容必须是 JSON 对象。' };
  }
  const productName = trimmed(value.productName);
  const productDescription = trimmed(value.productDescription);
  const tone = text(value.tone, 121) || 'clear and helpful';
  const platforms = Array.isArray(value.platforms)
    ? [...new Set(value.platforms.filter((item) => typeof item === 'string' && ALLOWED_PLATFORMS.has(item)))]
    : [];
  if (!productName || !productDescription || platforms.length === 0) {
    return { error: '请填写商品名称、商品描述，并至少选择一个平台。' };
  }
  if (productName.length > MAX_PRODUCT_NAME_LENGTH || productDescription.length > MAX_TEXT_LENGTH || tone.length > 120) {
    return { error: '一个或多个文本字段超出长度限制。' };
  }
  const imageResult = normalizeImages(value.images);
  if (imageResult.error) return imageResult;
  return {
    value: {
      productName,
      productDescription,
      platforms,
      tone,
      category: text(value.category, 80),
      brand: text(value.brand, 80),
      targetAudience: text(value.targetAudience, 200),
      priceInfo: text(value.priceInfo, 120),
      promotionInfo: text(value.promotionInfo, 200),
      afterSales: text(value.afterSales, 200),
      sellingPoints: textList(value.sellingPoints, 8, 160),
      specifications: normalizeSpecifications(value.specifications),
      images: imageResult.images
    }
  };
}

module.exports = {
  ALLOWED_PLATFORMS,
  MAX_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TEXT_LENGTH,
  detectImageMime,
  validateInput
};
