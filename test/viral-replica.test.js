'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAnalysisBrief, metricCount, rankCandidates } = require('../lib/viral-replica');
const { createVideoPlan } = require('../lib/video-workbench');
const { templateShots } = require('../public/video-tools');

test('normalizes Chinese and abbreviated play counts', () => {
  assert.equal(metricCount('1.2万'), 12000);
  assert.equal(metricCount('3.4M plays'), 3400000);
  assert.equal(metricCount('8,100'), 8100);
});

test('ranks only user-supplied platform candidates and rejects unsafe links', () => {
  const result = rankCandidates([
    { platform: 'douyin', url: 'https://www.douyin.com/video/1', plays: '1.2万', title: 'A' },
    { platform: 'douyin', url: 'https://www.douyin.com/video/2', plays: '2万', title: 'B' },
    { platform: 'douyin', url: 'https://example.com/video/3', plays: '9万', title: 'unsafe' }
  ]);
  assert.equal(result.candidates[0].title, 'B');
  assert.equal(result.candidates[0].plays, 20000);
  assert.equal(result.completeSearch, false);
  assert.equal(result.errors.length, 1);
});

test('analysis brief separates transferable structure from rights-sensitive media', () => {
  const candidate = { platform: 'douyin', url: 'https://www.douyin.com/video/1', plays: '2万', title: 'B' };
  const brief = buildAnalysisBrief({ candidate, transcript: '口播逐字稿', observations: { rhythm: '快速切点', camera: '近景' }, productFacts: '真实头盔事实' });
  assert.equal(brief.status, 'draft_requires_review');
  assert.equal(brief.reference.plays, 20000);
  assert.ok(brief.transfer.keep.includes('镜头长度与切点密度'));
  assert.ok(brief.transfer.rebuild.includes('商品画面'));
  assert.equal(brief.rights.publish, false);
});

test('video plan carries reference metadata without granting download or render permissions', () => {
  const payload = {
    route: 'remix', product: '骑行头盔', category: '头盔', market: '中国抖音', duration: 15, aspectRatio: '9:16',
    facts: '自有商品事实', prohibited: '不得虚构认证', rightsConfirmed: true, avatarConsent: false,
    referenceSource: { platform: 'douyin', url: 'https://www.douyin.com/video/1', plays: 20000, selectionBasis: 'highest_play_count_within_user_supplied_candidates' },
    referenceTranscript: '口播逐字稿', referenceNotes: { rhythm: '快', copy: '钩子', flow: '问题到展示', atmosphere: '自然光' },
    assets: [{ name: 'helmet.png', type: 'image/png', size: 100, role: 'product' }, { name: 'reference.mp4', type: 'video/mp4', size: 100, role: 'reference' }],
    shots: templateShots(15, 'asset-1', 'remix')
  };
  const plan = createVideoPlan(payload);
  assert.equal(plan.reference.source.url, 'https://www.douyin.com/video/1');
  assert.equal(plan.reference.transcript, '口播逐字稿');
  assert.equal(plan.output.status, 'not_generated');
  assert.equal(plan.permissions.externalUpload, false);
});
