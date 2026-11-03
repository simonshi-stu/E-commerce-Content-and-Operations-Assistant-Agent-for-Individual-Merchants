'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIDEO_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'video.js'), 'utf8');
const DRAFT_KEY = 'sourcing-workbench.video-draft.v1';

class MockClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    const shouldHave = force === undefined ? !this.values.has(name) : Boolean(force);
    if (shouldHave) this.values.add(name); else this.values.delete(name);
    return shouldHave;
  }
  contains(name) { return this.values.has(name); }
}

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new MockClassList();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.files = [];
    this.hidden = false;
    this.disabled = false;
    this.duration = Number.NaN;
    this.currentTime = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.paused = true;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }

  dispatch(type, init = {}) {
    const event = { type, target: this, currentTarget: this, ...init };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }

  click() { return this.dispatch('click'); }

  append(...items) {
    for (const item of items) {
      if (!item) continue;
      this.children.push(item);
      item.parentNode = this;
    }
  }

  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
  pause() { this.paused = true; }
  load() {}
  getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8Array(64 * 36 * 4) }) }; }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
    this.routes = [];
    this.body = new MockElement('body');
    this.documentElement = new MockElement('html');
  }

  register(id, element = new MockElement('input')) {
    element.id = id;
    this.elements.set(id, element);
    return element;
  }

  getElementById(id) { return this.elements.get(id); }
  querySelectorAll(selector) { return selector === '[data-route]' ? this.routes : []; }
  createElement(tagName) { return new MockElement(tagName); }
}

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function response(body, ok = true, status = ok ? 200 : 422) {
  return { ok, status, json: async () => body };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeDocument() {
  const document = new MockDocument();
  const ids = [
    'video-engine-status', 'video-platform', 'video-search-query', 'video-candidates', 'video-rank-candidates',
    'video-candidate-status', 'video-candidate-list', 'video-product', 'video-category', 'video-market',
    'video-products', 'video-avatars', 'video-materials', 'video-product-list', 'video-avatar-list',
    'video-material-list', 'video-reference', 'video-player', 'video-stage-empty', 'video-reference-meta',
    'video-reference-source', 'video-mark-cut', 'video-scan', 'video-cancel-scan', 'video-scan-status',
    'video-cut-list', 'video-note-rhythm', 'video-note-copy', 'video-note-flow', 'video-note-atmosphere',
    'video-transcript', 'video-shots', 'video-template', 'video-add-shot', 'video-snapshot-mode',
    'video-snapshot-fields', 'video-snapshot-brief-id', 'video-snapshot-version', 'video-snapshot-clear',
    'video-snapshot-status', 'video-facts', 'video-prohibited', 'video-duration', 'video-aspect',
    'video-rights', 'video-avatar-consent', 'video-plan', 'video-status', 'video-save', 'video-clear',
    'video-plan-result', 'video-plan-summary', 'video-download-json', 'video-download-brief',
    'video-runtime-availability', 'video-runtime-operation-id', 'video-runtime-request-digest', 'video-runtime-refresh',
    'video-runtime-status', 'video-runtime-result', 'video-runtime-summary', 'video-runtime-artifacts', 'video-runtime-errors',
    'video-review-mode', 'video-review-steps', 'video-export-review', 'video-review-status'
  ];
  for (const id of ids) document.register(id);
  document.getElementById('video-snapshot-mode').value = 'manual';
  document.getElementById('video-duration').value = '15';
  document.getElementById('video-aspect').value = '9:16';
  document.getElementById('video-plan-result').hidden = true;
  document.getElementById('video-runtime-result').hidden = true;
  document.getElementById('video-review-mode').value = 'continuous';
  for (const route of ['replace', 'remix']) {
    const button = new MockElement('button');
    button.dataset.route = route;
    document.routes.push(button);
  }
  return document;
}

function makeHarness({ draft, planResponses = [], rankResponses = [], runtimeResponses = [], runtimeConfigured = false } = {}) {
  const document = makeDocument();
  const storage = new MemoryStorage();
  if (draft) storage.setItem(DRAFT_KEY, JSON.stringify(draft));
  const objectUrls = new Set();
  let objectUrlId = 0;
  const url = {
    createObjectURL(value) { const result = `blob:video-client-${++objectUrlId}`; objectUrls.add(result); return result; },
    revokeObjectURL(value) { objectUrls.delete(value); }
  };
  const fetchCalls = [];
  const fetch = (requestUrl, options) => {
    fetchCalls.push({ requestUrl, options });
    if (requestUrl === '/api/video/capabilities') return Promise.resolve(response({ data: { mode: 'handoff_only', runtimeResult: { configured: runtimeConfigured } } }));
    const queue = requestUrl === '/api/video/plan' ? planResponses : requestUrl.startsWith('/api/video/runtime-result') ? runtimeResponses : rankResponses;
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error(`unexpected fetch: ${requestUrl}`));
    return typeof next === 'function' ? next(options) : next;
  };
  const window = {
    VIDEO_TOOLS: {
      normalizeCuts: (cuts) => cuts.filter((cut) => Number.isFinite(cut)),
      templateShots: (duration, assetId) => [{ start: 0, end: Number(duration), action: 'synthetic action', copy: '', edit: '', assetId: assetId || '' }],
      frameDifference: () => 0
    },
    confirm: () => true,
    addEventListener() {}
  };
  window.fetch = fetch;
  window.localStorage = storage;
  window.URL = url;
  const context = {
    window, document, fetch, localStorage: storage, URL: url,
    URLSearchParams, location: { search: '' },
    crypto: { randomUUID: () => `asset-${++objectUrlId}` },
    Blob: globalThis.Blob,
    setTimeout, clearTimeout, console,
    Number, String, Object, Array, Math, JSON, Promise, Error, RegExp, Date
  };
  vm.runInNewContext(VIDEO_SOURCE, context, { filename: 'public/video.js' });
  return {
    document, storage, window, fetchCalls,
    get(id) { return document.getElementById(id); }
  };
}

function setSnapshot(harness, briefId = 'brief-v1', version = '1') {
  const mode = harness.get('video-snapshot-mode');
  mode.value = 'snapshot';
  mode.dispatch('change');
  const brief = harness.get('video-snapshot-brief-id');
  brief.value = briefId;
  brief.dispatch('input');
  const versionInput = harness.get('video-snapshot-version');
  versionInput.value = version;
  versionInput.dispatch('input');
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function trustedPlan() {
  return {
    product: '合成商品', duration: 15, aspectRatio: '9:16',
    shots: [], assets: [], blockers: [],
    handoff: { status: 'trusted_snapshot_bound', media: { verified: false } }
  };
}

test('trusted binding is cleared by ordinary input and candidate paths', async () => {
  const harness = makeHarness({
    planResponses: [response({ data: trustedPlan() }), response({ data: trustedPlan() })],
    rankResponses: [response({ data: { candidates: [{ rank: 1, url: 'https://example.test/video/1', title: 'synthetic' }] } })]
  });
  setSnapshot(harness);
  harness.get('video-plan').click();
  await flush();
  assert.match(harness.get('video-snapshot-status').textContent, /trusted_snapshot_bound/);
  assert.equal(harness.get('video-plan-result').hidden, false);

  harness.get('video-product').value = '修改后的商品';
  harness.get('video-product').dispatch('input');
  assert.equal(harness.get('video-snapshot-status').textContent, '当前：待提交受控快照引用 · 服务端将校验版本和作用域。');
  assert.equal(harness.get('video-plan-result').hidden, true);
  assert.doesNotMatch(harness.get('video-snapshot-status').textContent, /trusted_snapshot_bound/);

  setSnapshot(harness);
  harness.get('video-plan').click();
  await flush();
  assert.match(harness.get('video-snapshot-status').textContent, /trusted_snapshot_bound/);
  harness.get('video-candidates').value = '[{"url":"https://example.test/video/1","plays":10}]';
  harness.get('video-rank-candidates').click();
  await flush();
  assert.equal(harness.get('video-snapshot-status').textContent, '当前：待提交受控快照引用 · 服务端将校验版本和作用域。');
  assert.equal(harness.get('video-plan-result').hidden, true);
});

test('a stale snapshot failure cannot overwrite manual or changed-reference state', async (t) => {
  for (const scenario of [
    {
      name: '切回 manual',
      change(harness) {
        harness.get('video-snapshot-mode').value = 'manual';
        harness.get('video-snapshot-mode').dispatch('change');
      },
      expected: '当前：draft_unverified · 未绑定只读快照，使用手工输入。'
    },
    {
      name: '改变快照引用',
      change(harness) {
        harness.get('video-snapshot-brief-id').value = 'brief-v2';
        harness.get('video-snapshot-brief-id').dispatch('input');
      },
      expected: '当前：待提交受控快照引用 · 服务端将校验版本和作用域。'
    }
  ]) {
    await t.test(scenario.name, async () => {
      const pending = deferred();
      const harness = makeHarness({ planResponses: [pending.promise] });
      setSnapshot(harness);
      harness.get('video-plan').click();
      scenario.change(harness);
      assert.equal(harness.get('video-snapshot-status').textContent, scenario.expected);
      pending.resolve(response({ error: { code: 'snapshot_stale', message: '旧请求已过期' } }, false, 409));
      await flush();
      assert.equal(harness.get('video-snapshot-status').textContent, scenario.expected);
      assert.doesNotMatch(harness.get('video-snapshot-status').textContent, /snapshot_stale|快照版本已过期/);
    });
  }
});

test('synchronous payload errors and current HTTP failures remain visible', async () => {
  const invalid = makeHarness();
  invalid.get('video-snapshot-mode').value = 'snapshot';
  invalid.get('video-snapshot-mode').dispatch('change');
  invalid.get('video-plan').click();
  await flush();
  assert.match(invalid.get('video-snapshot-status').textContent, /snapshot_reference_invalid/);
  assert.equal(invalid.get('video-plan-result').hidden, true);

  const failed = makeHarness({
    planResponses: [response({ error: { code: 'snapshot_stale', message: '版本不再有效' } }, false, 409)]
  });
  setSnapshot(failed);
  failed.get('video-plan').click();
  await flush();
  assert.match(failed.get('video-snapshot-status').textContent, /快照版本已过期 \[snapshot_stale\]/);
  assert.match(failed.get('video-status').textContent, /快照版本已过期/);
});

test('clearing the reference preserves draft_unverified and old-draft restoration', () => {
  const draft = {
    schemaVersion: 1,
    route: 'remix',
    snapshotMode: 'snapshot',
    fields: {
      product: '旧草稿商品', duration: '20', aspect: '16:9',
      'snapshot-brief-id': 'brief-old', 'snapshot-version': '3'
    },
    referenceSource: { url: 'https://example.test/old-reference', platform: 'douyin' },
    shots: [{ start: 0, end: 20, action: '旧草稿动作', copy: '', edit: '', assetId: 'discarded' }]
  };
  const harness = makeHarness({ draft });
  assert.equal(harness.get('video-product').value, '旧草稿商品');
  assert.equal(harness.get('video-snapshot-mode').value, 'snapshot');
  assert.equal(harness.get('video-snapshot-brief-id').value, 'brief-old');
  assert.equal(harness.get('video-snapshot-version').value, '3');
  assert.equal(harness.get('video-reference-source').value, 'https://example.test/old-reference');
  assert.equal(harness.get('video-shots').children.length, 1);
  assert.equal(harness.get('video-snapshot-status').textContent, '当前：待提交受控快照引用 · 服务端将校验版本和作用域。');

  harness.get('video-snapshot-clear').click();
  assert.equal(harness.get('video-snapshot-mode').value, 'manual');
  assert.equal(harness.get('video-snapshot-brief-id').value, '');
  assert.equal(harness.get('video-snapshot-version').value, '');
  assert.equal(harness.get('video-snapshot-status').textContent, '当前：draft_unverified · 未绑定只读快照，使用手工输入。');
});

test('local review supports continuous and independent progression and is invalidated by edits', () => {
  const harness = makeHarness();
  assert.equal(harness.get('video-review-steps').children.length, 5);
  const first = harness.get('video-review-steps').children[0].children[2];
  const second = harness.get('video-review-steps').children[1].children[2];
  assert.equal(second.disabled, true);
  first.click();
  assert.equal(harness.get('video-review-steps').children[0].children[2].textContent, '撤销本步确认');
  assert.equal(harness.get('video-review-steps').children[1].children[2].disabled, false);
  harness.get('video-product').value = 'changed';
  harness.get('video-product').dispatch('input');
  assert.equal(harness.get('video-review-steps').children[0].children[2].textContent, '标记本地已审');

  harness.get('video-review-mode').value = 'independent';
  harness.get('video-review-mode').dispatch('change');
  assert.equal(harness.get('video-review-steps').children[3].children[2].disabled, false);
  harness.get('video-review-steps').children[3].children[2].click();
  assert.equal(harness.get('video-review-steps').children[3].children[2].textContent, '撤销本步确认');
});

test('runtime result display is visibly simulated and ignores a stale response after input changes', async (t) => {
  const runtimeResult = {
    schemaVersion: 'commerce.video-runtime-result.v1', mode: 'simulated', operationId: 'operation-a', requestDigest: 'd'.repeat(64),
    binding: { projectId: 'project-a', briefId: 'brief-v1', briefVersion: 1, snapshotSha256: 'a'.repeat(64) }, revision: 1, state: 'succeeded',
    media: { status: 'absent', artifactId: null, sha256: null, bytes: null },
    qa: { status: 'not_run', codes: [] }, export: { status: 'not_ready', artifactId: null },
    budget: { currency: 'CNY', capMinor: 1000, reservedMinor: 0, settledMinor: 0, usageKnown: true }, errors: []
  };
  await t.test('successful simulated result', async () => {
    const harness = makeHarness({ runtimeConfigured: true, runtimeResponses: [response({ data: runtimeResult, consumption: { ready: false, reasons: ['simulated_mode_only'], newPaidWorkAllowed: true } })] });
    setSnapshot(harness);
    harness.get('video-runtime-operation-id').value = 'operation-a';
    harness.get('video-runtime-operation-id').dispatch('input');
    await flush();
    harness.get('video-runtime-refresh').click();
    await flush();
    assert.equal(harness.get('video-runtime-result').hidden, false);
    assert.match(harness.get('video-runtime-summary').textContent, /模拟（仅合成测试/);
    assert.match(harness.get('video-runtime-summary').textContent, /provider：由 state 推导/);
    assert.match(harness.get('video-runtime-status').textContent, /provider 成功不等于/);
  });
  await t.test('blocked recovery keeps the review reason visible and does not authorize paid work', async () => {
    const blocked = { ...runtimeResult, state: 'blocked', errors: ['RUNTIME_RESULT_SOURCE_UNAVAILABLE'] };
    const harness = makeHarness({ runtimeConfigured: true, runtimeResponses: [response({ data: blocked, consumption: { ready: false, reasons: ['state_blocked', 'media_not_verified'], newPaidWorkAllowed: false } })] });
    setSnapshot(harness);
    harness.get('video-runtime-operation-id').value = 'operation-a';
    harness.get('video-runtime-operation-id').dispatch('input');
    await flush();
    harness.get('video-runtime-refresh').click();
    await flush();
    assert.match(harness.get('video-runtime-summary').textContent, /禁止（仍在处理中、需继续审核或预算未知\/已达上限）/);
    assert.match(harness.get('video-runtime-status').textContent, /当前状态已阻塞/);
    assert.match(harness.get('video-runtime-status').textContent, /RUNTIME_RESULT_SOURCE_UNAVAILABLE/);
    assert.match(harness.get('video-runtime-errors').textContent, /RUNTIME_RESULT_SOURCE_UNAVAILABLE/);
  });
  await t.test('changed snapshot cannot be overwritten by old result', async () => {
    const pending = deferred();
    const harness = makeHarness({ runtimeConfigured: true, runtimeResponses: [pending.promise] });
    setSnapshot(harness);
    harness.get('video-runtime-operation-id').value = 'operation-a';
    harness.get('video-runtime-operation-id').dispatch('input');
    await flush();
    harness.get('video-runtime-refresh').click();
    harness.get('video-snapshot-version').value = '2';
    harness.get('video-snapshot-version').dispatch('input');
    pending.resolve(response({ data: runtimeResult, consumption: { ready: false, reasons: ['simulated_mode_only'], newPaidWorkAllowed: true } }));
    await flush();
    assert.equal(harness.get('video-runtime-result').hidden, true);
    assert.match(harness.get('video-runtime-status').textContent, /输入已变化/);
  });
});
