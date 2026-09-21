'use strict';

const path = require('node:path');
const { loadConfig } = require('./env');
const { uiMessage } = require('./messages');
const { buildMessages } = require('./prompt');
const { extractJson, normalizeDrafts } = require('./normalize');
const { buildReview } = require('./review');

async function generateContent(input, options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const fetchImpl = options.fetchImpl || fetch;
  const config = loadConfig(root);
  const locale = input.locale === 'en' ? 'en' : 'zh';
  if (!config.hasApiKey) {
    return { status: 503, error: { code: 'provider_not_configured', message: uiMessage(locale, 'provider.notConfigured') } };
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
        return { status: response.status, error: { code: 'provider_error', message: uiMessage(locale, 'provider.rejected') } };
      }
      if (response.status === 400 && input.images.length > 0) {
        return { status: 400, error: { code: 'vision_unsupported', message: uiMessage(locale, 'provider.visionUnsupported') } };
      }
      if (response.status === 400) {
        return { status: 400, error: { code: 'provider_rejected', message: uiMessage(locale, 'provider.badRequest') } };
      }
      return { status: 502, error: { code: 'provider_error', message: uiMessage(locale, 'provider.error') } };
    }

    const payload = await response.json().catch(() => null);
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : '';
    let drafts;
    try {
      drafts = normalizeDrafts(extractJson(content), input.platforms);
    } catch {
      return { status: 502, error: { code: 'invalid_model_output', message: uiMessage(locale, 'provider.invalidOutput') } };
    }

    return {
      status: 200,
      body: {
        data: { drafts, review: buildReview(input, drafts) },
        meta: { provider: config.provider, model, vision: usesVision, usedImages: input.images.length, locale }
      }
    };
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? uiMessage(locale, 'provider.timeout')
      : uiMessage(locale, 'provider.unreachable');
    return { status: 502, error: { code: 'provider_unavailable', message } };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateContent };
