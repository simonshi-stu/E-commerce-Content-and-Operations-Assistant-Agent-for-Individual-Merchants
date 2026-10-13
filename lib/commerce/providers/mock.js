'use strict';
/**
 * Mock providers (T2.5 rev-01/rev-02): real, executing mock adapters (not descriptors or empty
 * TODOs) covering the frozen capability categories. Synchronous mocks validate input and produce
 * deterministic schema-validated output; asynchronous mocks submit a job that RETAINS a deep copy
 * of the validated input (external mutation cannot change the result), expose a BOUNDED, traceable
 * status query (explicit clock) and are TERMINAL-MONOTONIC: once succeeded, later queries — even
 * with an earlier clock — return the stored terminal state. rev-02: the terminal output is a
 * job-owned IMMUTABLE snapshot and every query returns a FRESH defensive copy, so a caller
 * mutating a previously returned output can never rewrite settled job evidence. Mock providers
 * never make real calls; storage decodes strict base64 exactly.
 */
const crypto = require('node:crypto');
const { ValidationError } = require('../evidence.js');
const { validateSchema, validateValue, decodeStrictBase64, deepFreeze } = require('./schema.js');

function fail(message) {
  throw new ValidationError(message);
}
/** Fresh detached JSON copy (defensive copies for returned job outputs). */
function copyJson(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

const IMAGE_INPUT_SCHEMA = {
  type: 'object',
  required: ['mediaType', 'bytesBase64'],
  properties: {
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg'] },
    bytesBase64: { type: 'string', minLength: 4, maxLength: 2000000 }
  },
  additionalProperties: false
};

const MOCK_SPECS = deepFreeze([
  { id: 'mock.text', capability: 'text.generate', async: false, tool: 'text.generate', input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 4000 } }, additionalProperties: false }, output: { type: 'object', required: ['text', 'model'], properties: { text: { type: 'string' }, model: { type: 'string' } }, additionalProperties: false } },
  { id: 'mock.vision', capability: 'vision.understand', async: false, tool: 'vision.understand', input: { type: 'object', required: ['prompt', 'image'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 2000 }, image: IMAGE_INPUT_SCHEMA }, additionalProperties: false }, output: { type: 'object', required: ['summary', 'labels'], properties: { summary: { type: 'string' }, labels: { type: 'array', items: { type: 'string' }, maxItems: 16 } }, additionalProperties: false } },
  { id: 'mock.search', capability: 'search.query', async: false, tool: 'search.query', input: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, additionalProperties: false }, output: { type: 'object', required: ['results'], properties: { results: { type: 'array', items: { type: 'object', required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string' } }, additionalProperties: false }, maxItems: 10 } }, additionalProperties: false } },
  { id: 'mock.ocr', capability: 'ocr.extract', async: false, tool: 'ocr.extract', input: { type: 'object', required: ['image'], properties: { image: IMAGE_INPUT_SCHEMA }, additionalProperties: false }, output: { type: 'object', required: ['text', 'lines'], properties: { text: { type: 'string' }, lines: { type: 'array', items: { type: 'string' }, maxItems: 200 } }, additionalProperties: false } },
  { id: 'mock.image', capability: 'image.render', async: true, settleAfterMs: 1000, tool: 'image.render', input: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 1000 } }, additionalProperties: false }, output: { type: 'object', required: ['assetId', 'width', 'height'], properties: { assetId: { type: 'string' }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  { id: 'mock.video', capability: 'video.render', async: true, settleAfterMs: 1000, tool: 'video.render', input: { type: 'object', required: ['prompt', 'durationSeconds'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 1000 }, durationSeconds: { type: 'integer', minimum: 1, maximum: 60 } }, additionalProperties: false }, output: { type: 'object', required: ['assetId', 'durationSeconds'], properties: { assetId: { type: 'string' }, durationSeconds: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  { id: 'mock.tts', capability: 'tts.speak', async: true, settleAfterMs: 1000, tool: 'tts.speak', input: { type: 'object', required: ['text', 'voice'], properties: { text: { type: 'string', minLength: 1, maxLength: 2000 }, voice: { type: 'string', enum: ['alloy', 'verse'] } }, additionalProperties: false }, output: { type: 'object', required: ['audioId', 'format'], properties: { audioId: { type: 'string' }, format: { type: 'string', enum: ['mp3', 'wav'] } }, additionalProperties: false } },
  { id: 'mock.storage', capability: 'storage.put', async: true, settleAfterMs: 0, tool: 'storage.put', input: { type: 'object', required: ['key', 'contentBase64'], properties: { key: { type: 'string', minLength: 1, maxLength: 200 }, contentBase64: { type: 'string', minLength: 4, maxLength: 2000000 } }, additionalProperties: false }, output: { type: 'object', required: ['uri', 'bytes'], properties: { uri: { type: 'string' }, bytes: { type: 'integer', minimum: 0 } }, additionalProperties: false } }
]);

function mockDescriptor(spec) {
  const descriptor = {
    id: spec.id,
    version: '1.0.0',
    capability: spec.capability,
    capabilityStatus: 'mock',
    tools: [{ name: spec.tool, inputSchema: spec.input, outputSchema: spec.output }],
    idempotencyLevel: 'unsupported',
    timeoutMs: 30000,
    statusQuerySupported: spec.async === true,
    cancelSupported: false,
    refundSupported: false,
    enabledByDefault: false,
    limits: spec.async ? { settleAfterMs: spec.settleAfterMs } : {},
    costPolicy: { kind: 'mock_no_charge', currency: 'USD', note: 'mock provider; no real charge, no real call' }
  };
  validateSchema(descriptor.tools[0].inputSchema, `${descriptor.id}.inputSchema`);
  validateSchema(descriptor.tools[0].outputSchema, `${descriptor.id}.outputSchema`);
  return deepFreeze(descriptor);
}

function deterministicOutput(spec, input) {
  if (spec.capability === 'text.generate') return { text: `mock-text:${input.prompt}`, model: spec.id };
  if (spec.capability === 'vision.understand') return { summary: `mock-vision:${input.prompt}`, labels: ['fixture-label'] };
  if (spec.capability === 'search.query') return { results: [{ title: `fixture result for ${input.query}`, url: 'https://example.invalid/fixture' }] };
  if (spec.capability === 'ocr.extract') return { text: 'fixture ocr text', lines: ['fixture ocr text'] };
  if (spec.capability === 'image.render') return { assetId: 'mock_asset_image_1', width: 512, height: 512 };
  if (spec.capability === 'video.render') return { assetId: 'mock_asset_video_1', durationSeconds: input.durationSeconds };
  if (spec.capability === 'tts.speak') return { audioId: 'mock_asset_audio_1', format: 'mp3' };
  if (spec.capability === 'storage.put') {
    const bytes = decodeStrictBase64(input.contentBase64, 'input.contentBase64');
    return { uri: `mock://storage/${input.key}`, bytes: bytes.length };
  }
  fail(`no deterministic output for capability ${spec.capability}`);
}

/** Create one executing mock provider (sync or bounded-async) for a category. */
function createMockProvider(category) {
  const spec = MOCK_SPECS.find((entry) => entry.id === `mock.${category}`);
  if (!spec) fail(`unknown mock category ${category}`);
  const descriptor = mockDescriptor(spec);
  let callCount = 0;
  const jobs = new Map();
  return {
    descriptor,
    calls: () => callCount,
    invoke({ tool, input, operationId, attemptToken, now } = {}) {
      if (tool !== spec.tool) fail(`mock ${spec.id} does not provide tool ${tool}`);
      validateValue(spec.input, input, 'input');
      if (spec.capability === 'storage.put') decodeStrictBase64(input.contentBase64, 'input.contentBase64');
      callCount += 1;
      const identity = {
        operationId: operationId ?? `mock_op_${crypto.randomUUID()}`,
        attemptToken: attemptToken ?? `mock_att_${crypto.randomUUID()}`
      };
      const remoteId = `mock_remote_${crypto.randomUUID()}`;
      if (!spec.async) {
        const output = deterministicOutput(spec, input);
        validateValue(spec.output, output, 'output');
        return { status: 'succeeded', output, remoteId, ...identity, calls: callCount };
      }
      // retain a deep copy of the VALIDATED input so external mutation cannot change the result
      const inputSnapshot = JSON.parse(JSON.stringify(input));
      const createdAt = now === undefined || now === null ? new Date().toISOString() : String(now);
      jobs.set(remoteId, { remoteId, ...identity, status: 'pending', createdAt, settleAfterMs: spec.settleAfterMs, inputSnapshot, output: null });
      return { status: 'pending', remoteId, ...identity, calls: callCount };
    },
    queryStatus(remoteId, { now } = {}) {
      const job = jobs.get(remoteId);
      if (!job) return { status: 'not_found', remoteId };
      // terminal-monotonic: a succeeded job stays succeeded (time reversal cannot revive it) and
      // every read returns a FRESH defensive copy of the job-owned immutable snapshot
      if (job.status === 'succeeded') {
        return { status: 'succeeded', remoteId, operationId: job.operationId, attemptToken: job.attemptToken, output: copyJson(job.output) };
      }
      const nowMs = now === undefined || now === null ? Date.now() : Date.parse(now);
      if (!Number.isFinite(nowMs)) fail('now must be a strict ISO instant for queryStatus');
      const createdMs = Date.parse(job.createdAt);
      if (nowMs - createdMs < job.settleAfterMs) {
        return { status: 'pending', remoteId, operationId: job.operationId, attemptToken: job.attemptToken };
      }
      const output = deterministicOutput(spec, job.inputSnapshot);
      validateValue(spec.output, output, 'output');
      job.status = 'succeeded';
      job.output = deepFreeze(copyJson(output)); // job-owned immutable snapshot
      return { status: 'succeeded', remoteId, operationId: job.operationId, attemptToken: job.attemptToken, output: copyJson(job.output) };
    },
    jobCount: () => jobs.size
  };
}

/** The full mock catalog (all frozen capability categories). */
function createMockCatalog() {
  return MOCK_SPECS.map((spec) => createMockProvider(spec.id.slice('mock.'.length)));
}

module.exports = {
  MOCK_SPECS,
  createMockProvider,
  createMockCatalog
};
