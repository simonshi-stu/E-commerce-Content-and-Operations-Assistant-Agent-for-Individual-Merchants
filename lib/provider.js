'use strict';

const { loadConfig } = require('./env');
const { buildMessages } = require('./prompt');
const { extractJson, normalizeDrafts } = require('./normalize');
const { buildReview } = require('./review');

async function generateContent(input, options = {}) {
  const root = options.root || require('node:path').resolve(__dirname, '..');
  const fetchImpl = options.fetchImpl || fetch;
  const config = loadConfig(root);
  if (!config.hasApiKey) {
    return {
      status: 503,
      error: {
        code: 'provider_not_configured',
        message: '请先配置 DEEPSEEK_API_KEY（或 AI_API_KEY）再生成草稿。'
      }
    };
  }

  const usesVision = input.images.length > 0 && Boolean(config.visionModel);
  const model = usesVision ? config.visionModel : config.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model,
        messages: buildMessages(input),
        response_format: { type: 'json_object' },
        temperature: 0.4
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      if ([401, 402, 429].includes(response.status)) {
        return {
          status: response.status,
          error: {
            code: 'provider_error',
            message: '模型服务拒绝了该请求，请检查密钥、额度或频率限制。'
          }
        };
      }
      if (response.status === 400 && input.images.length > 0) {
        return {
          status: 400,
          error: {
            code: 'vision_unsupported',
            message: '当前模型可能不支持图片输入。请配置支持视觉的 DEEPSEEK_VISION_MODEL 后重试，或移除图片。'
          }
        };
      }
      if (response.status === 400) {
        return {
          status: 400,
          error: {
            code: 'provider_rejected',
            message: '模型服务拒绝了该请求，请检查模型名称与请求参数。'
          }
        };
      }
      return {
        status: 502,
        error: { code: 'provider_error', message: '模型服务无法完成该请求。' }
      };
    }

    const payload = await response.json().catch(() => null);
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : '';
    let drafts;
    try {
      drafts = normalizeDrafts(extractJson(content), input.platforms);
    } catch {
      return {
        status: 502,
        error: {
          code: 'invalid_model_output',
          message: '模型返回格式不符合要求，请重试或更换模型。'
        }
      };
    }

    return {
      status: 200,
      body: {
        data: { drafts, review: buildReview(input, drafts) },
        meta: { provider: config.provider, model, vision: usesVision, usedImages: input.images.length }
      }
    };
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? '模型服务请求超时，请重试或调大 DEEPSEEK_TIMEOUT_MS。'
      : '无法连接模型服务，请检查网络与 DEEPSEEK_BASE_URL。';
    return { status: 502, error: { code: 'provider_unavailable', message } };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateContent };
