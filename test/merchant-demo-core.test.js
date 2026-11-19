'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../demo/core');
const good = { sku: 'DEMO-01', assetId: 'asset-1', character: '角色甲', action: '戴上眼镜', ...core.DEFAULTS };

test('extracts supported Chinese and English instructions without mutating saved settings', () => {
  assert.deepEqual(core.parseInstruction('SKU DEMO-01，角色：同一位店员，动作：戴上眼镜，8秒，16:9，不要广告词'), {
    sku: 'DEMO-01', character: '同一位店员', action: '戴上眼镜', duration: 8, aspect: '16:9', avoidAdWords: true
  });
  assert.deepEqual(core.parseInstruction('asset: ref1; same character: Clerk A; action: open the box; 6 seconds; 1:1; allow ad copy'), {
    assetId: 'ref1', character: 'Clerk A', action: 'open the box', duration: 6, aspect: '1:1', avoidAdWords: false
  });
  assert.deepEqual(core.parseInstruction('  '), {});
});

test('reports precedence, preserves explicit false and leaves empty values for validation', () => {
  const inherited = { duration: 6, aspect: '16:9', sku: 'TEST', unknownSecret: 'private' };
  const result = core.resolveShot({
    global: inherited, project: { duration: 8 }, sku: { duration: 9, avoidAdWords: true },
    explicit: { duration: 11, avoidAdWords: false, sku: '' }
  });
  assert.deepEqual(result.shot, { duration: 11, aspect: '16:9', avoidAdWords: false, sku: '' });
  assert.deepEqual(result.sources, { duration: 'explicit', aspect: 'global', avoidAdWords: 'explicit', sku: 'explicit' });
  assert.equal(inherited.duration, 6);
  assert.equal(core.validateShot(result.shot).ok, false);
});

test('validates required fields and rejects unsupported duration and proportion before starting', () => {
  assert.equal(core.validateShot(good).ok, true);
  assert.match(core.validateShot({ ...good, duration: 4.5 }).errors.duration, /4–15/);
  assert.ok(core.validateShot({ ...good, aspect: '10:1' }).errors.aspect);
  assert.ok(core.validateShot({ ...good, assetId: '../unrelated' }).errors.assetId);
  assert.throws(() => core.createJob({ ...good, character: '' }), /invalid_shot/);
});

test('resumes a persisted simulated job and archives only allowlisted non-sensitive fields', () => {
  const original = core.createJob({ ...good, character: 'SECRET PERSON', action: 'PRIVATE PROMPT',
    filename: 'private.mp4', credentials: 'secret-token' }, { now: 1000, id: 'demo-job' });
  const job = JSON.parse(JSON.stringify(original));
  assert.equal(core.getJobState(job, 999).status, 'queued');
  assert.equal(core.getJobState(job, 2099).status, 'queued');
  assert.equal(core.getJobState(job, 2100).status, 'running');
  assert.equal(core.getJobState(job, 5800).progress, 100);
  assert.throws(() => core.archiveJob(job, 5799), /archive_not_ready/);
  assert.throws(() => core.archiveJob({ ...job, provider: 'remote' }, 5800), /archive_not_ready/);
  const saved = core.archiveJob(job, 5800);
  assert.equal(saved.chargeMinor, 0);
  assert.equal(saved.mediaIncluded, false);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET|PROMPT|private|secret|DEMO-01|asset-1/);
  assert.deepEqual(saved, core.archiveJob(job, 7800));
});

test('binds same-person language only to a confirmed previous character', () => {
  const parsed = core.parseInstruction('看价签拿梨，6 秒，跟上一段同一个人。不要画面广告字');
  assert.deepEqual(parsed, { action: '看价签拿梨', duration: 6, sameCharacter: true, avoidAdWords: true });
  const layers = { global: good, project: { character: '不是上一段人物' }, explicit: parsed };
  const missing = core.resolveShot(layers);
  assert.equal(missing.shot.character, '');
  assert.equal(missing.sources.character, 'previousMissing');
  assert.match(core.validateShot(missing.shot).errors.character, /参考标记/);
  const resolved = core.resolveShot({ ...layers, previousCharacter: '  上一段已确认人物  ' });
  assert.equal(resolved.shot.character, '上一段已确认人物');
  assert.equal(resolved.sources.character, 'previous');
  assert.equal(core.validateShot(resolved.shot).ok, true);
  const changed = core.resolveShot({ ...layers, previousCharacter: '上一段已确认人物', explicit: { ...parsed, character: '手动调整' } });
  assert.equal(changed.shot.character, '手动调整');
  assert.equal(changed.sources.character, 'explicit');
});
