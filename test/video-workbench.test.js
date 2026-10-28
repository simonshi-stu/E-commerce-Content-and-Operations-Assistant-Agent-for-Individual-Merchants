'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capabilities, createVideoPlan } = require('../lib/video-workbench');
const { frameDifference, normalizeCuts, templateShots } = require('../public/video-tools');

function input(route = 'replace') {
  return {
    route, product: '随行杯', category: '杯具', market: '美国', duration: 15, aspectRatio: '9:16',
    facts: '用户提供：不锈钢杯体，具体规格待审核。', prohibited: '不得虚构保温时长',
    rightsConfirmed: true, avatarConsent: false,
    assets: [
      { name: '商品.png', type: 'image/png', size: 1200, role: 'product' },
      { name: 'reference.mp4', type: 'video/mp4', size: 12000, role: 'reference' }
    ],
    referenceNotes: { rhythm: '人工记录：开场切入快，展示段放缓', copy: '', flow: '问题 → 展示', atmosphere: '自然光' },
    shots: templateShots(15, 'asset-1', route)
  };
}
test('two routes produce metadata handoffs, never media or execution permissions', () => {
  for (const route of ['replace', 'remix']) {
    const payload = input(route); const original = structuredClone(payload);
    const plan = createVideoPlan(payload, { now: () => '2026-10-27T00:00:00.000Z' });
    assert.deepEqual(payload, original);
    assert.equal(plan.route, route);
    assert.equal(plan.output.status, 'not_generated');
    assert.equal(plan.output.svmlCompiled, false);
    assert.equal(plan.reference.status, 'user_notes_not_model_analysis');
    assert.equal(plan.productFacts.status, 'user_draft_requires_review');
    assert.equal(plan.rights.independentlyVerified, false);
    assert.deepEqual(plan.permissions, { paidGeneration: false, externalUpload: false, publish: false, contactCustomers: false });
    assert.match(plan.agentBrief, /不保证|无法保真/);
    assert.match(plan.agentBrief, /\.svrun/);
    assert.match(plan.agentBrief, /不是可执行脚本/);
    assert.ok(plan.shots.every((shot) => shot.reviewStatus === 'draft_unverified'));
  }
  assert.equal(capabilities().mode, 'handoff_only');
  assert.equal(capabilities().renderConnected, false);
});
test('missing rights, product, reference and avatar permissions fail closed', () => {
  let p = input(); p.rightsConfirmed = false; assert.throws(() => createVideoPlan(p), /权利/);
  p = input(); p.assets[0].role = 'material'; assert.throws(() => createVideoPlan(p), /商品图/);
  p = input(); p.assets.pop(); assert.throws(() => createVideoPlan(p), /参考视频/);
  p = input(); p.referenceNotes = {}; assert.throws(() => createVideoPlan(p), /拆解维度/);
  p = input(); p.assets.push({ name: 'person.png', type: 'image/png', size: 200, role: 'avatar' });
  assert.throws(() => createVideoPlan(p), /已授权/);
  p.avatarConsent = true; assert.equal(createVideoPlan(p).rights.avatarAttested, true);
});
test('bad metadata, traversal, remote URLs and duplicate filenames are refused', () => {
  for (const name of ['../x.png', 'C:\\x.png', 'https://host/x.png', 'CON.png', 'x\n.png']) {
    const p = input(); p.assets[0].name = name; assert.throws(() => createVideoPlan(p), /文件名/);
  }
  let p = input(); p.assets[1].name = p.assets[0].name; assert.throws(() => createVideoPlan(p), /重复/);
  p = input(); p.assets[0].size = 251 * 1024 * 1024; assert.throws(() => createVideoPlan(p), /250MB/);
  p = input(); p.assets[0].type = 'text/html'; assert.throws(() => createVideoPlan(p), /支持/);
  p = input(); p.assets[1].type = 'image/png'; assert.throws(() => createVideoPlan(p), /参考素材须/);
  p = input(); p.product = 'x'.repeat(201); assert.throws(() => createVideoPlan(p), /过长/);
});
test('timelines reject gaps, overlaps, missing end coverage and reference footage as output', () => {
  for (const start of [-1, .5, '', NaN, Infinity]) {
    const p = input(); p.shots[0].start = start; assert.throws(() => createVideoPlan(p), /连续排列/);
  }
  let p = input(); p.shots[1].start += .2; assert.throws(() => createVideoPlan(p), /连续排列/);
  p = input(); p.shots[1].start -= .2; assert.throws(() => createVideoPlan(p), /连续排列/);
  p = input(); p.shots.at(-1).end -= 1; assert.throws(() => createVideoPlan(p), /覆盖/);
  p = input(); p.shots[0].assetId = 'asset-2'; assert.throws(() => createVideoPlan(p), /参考视频只作分析/);
  p = input(); p.shots[0].assetId = 'unknown'; assert.throws(() => createVideoPlan(p), /绑定/);
  p = input(); p.shots[0].action = ''; assert.throws(() => createVideoPlan(p), /必填/);
});
test('client-supplied privileges do not authorize external actions', () => {
  const p = input(); p.permissions = { paidGeneration: true, externalUpload: true, publish: true };
  const plan = createVideoPlan(p);
  assert.equal(plan.permissions.paidGeneration, false); assert.equal(plan.permissions.publish, false);
});
test('reference cut candidates stay unverified and survive the handoff', () => {
  const p = input(); p.referenceMeasurements = { duration: 8, cutCandidates: [2.5, 1, 2.5] };
  const plan = createVideoPlan(p);
  assert.deepEqual(plan.reference.localMeasurements.cutCandidates, [1, 2.5]);
  assert.equal(plan.reference.localMeasurements.status, 'candidates_require_review');
  assert.match(plan.agentBrief, /2.5/);
  p.referenceMeasurements.cutCandidates = [9]; assert.throws(() => createVideoPlan(p), /切点/);
});
test('visual cut helpers label candidates without promising semantic or beat analysis', () => {
  assert.equal(frameDifference(new Uint8Array([0, 0, 0, 255]), new Uint8Array([255, 255, 255, 255])), 1);
  assert.equal(frameDifference(new Uint8Array([4, 4, 4, 0]), new Uint8Array([4, 4, 4, 255])), 0);
  assert.throws(() => frameDifference([], []), /Invalid/);
  assert.deepEqual(normalizeCuts([3.01, 1, 1, -4, NaN, 10], 10), [1, 3]);
  assert.deepEqual(normalizeCuts([.01, 9.99], 10), []);
  const shots = templateShots(15, 'local-asset-id', 'remix');
  assert.equal(shots[0].start, 0); assert.equal(shots.at(-1).end, 15);
  assert.ok(shots.every((s) => s.assetId === 'local-asset-id' && s.copy === ''));
});
