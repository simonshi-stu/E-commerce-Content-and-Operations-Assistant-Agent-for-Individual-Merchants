'use strict';

const PLATFORM_HOSTS = {
  douyin: new Set(['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']),
  tiktok: new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'])
};

function text(value, max = 500) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max); }

function metricCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  const raw = text(value, 80).replace(/,/g, '').toLowerCase();
  if (!raw) return 0;
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(亿|万|w|k|m)?/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const suffix = match[2] || '';
  const factor = suffix === '亿' ? 100_000_000 : ['万', 'w'].includes(suffix) ? 10_000 : suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  return Math.round(amount * factor);
}

function safeReferenceUrl(value, platform = '') {
  const raw = text(value, 2_000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    const hosts = PLATFORM_HOSTS[platform] || new Set([...PLATFORM_HOSTS.douyin, ...PLATFORM_HOSTS.tiktok]);
    if (!['http:', 'https:'].includes(url.protocol) || ![...hosts].some((host) => hostname === host || hostname.endsWith(`.${host}`))) return '';
    return url.href;
  } catch { return ''; }
}

function normalizeCandidate(input = {}) {
  const platform = ['douyin', 'tiktok'].includes(String(input.platform || '').toLowerCase()) ? String(input.platform).toLowerCase() : 'douyin';
  const url = safeReferenceUrl(input.url, platform);
  const plays = metricCount(input.plays ?? input.playCount ?? input.views);
  if (!url || !plays) throw Object.assign(new Error('爆款候选需要有效的抖音/TikTok链接和播放量。'), { code: 'invalid_viral_candidate' });
  const duration = Number.parseFloat(String(input.duration || '').replace(/[^\d.]/g, ''));
  return {
    platform, url, title: text(input.title, 240), creator: text(input.creator || input.author, 160),
    plays, likes: metricCount(input.likes), comments: metricCount(input.comments), shares: metricCount(input.shares),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : null,
    observedAt: text(input.observedAt, 60), source: 'user_browser_capture', rightsStatus: input.rightsConfirmed === true ? 'user_attested' : 'unverified'
  };
}

function rankCandidates(inputs = []) {
  const candidates = [];
  const errors = [];
  for (const input of Array.isArray(inputs) ? inputs.slice(0, 50) : []) {
    try { candidates.push(normalizeCandidate(input)); }
    catch (error) { errors.push({ code: error.code || 'invalid_viral_candidate', message: error.message }); }
  }
  const ranked = candidates.sort((a, b) => b.plays - a.plays || b.likes - a.likes || b.comments - a.comments).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  return { candidates: ranked, errors, selectionBasis: 'highest_play_count_within_user_supplied_candidates', completeSearch: false };
}

function buildAnalysisBrief({ candidate = null, transcript = '', observations = {}, productFacts = '', prohibited = '' } = {}) {
  const source = candidate ? normalizeCandidate(candidate) : null;
  return {
    schemaVersion: 1,
    status: 'draft_requires_review',
    reference: source ? { ...source, selectionBasis: 'highest_play_count_within_user_supplied_candidates' } : null,
    transcript: text(transcript, 12_000),
    observations: {
      hook: text(observations.hook, 2_000), camera: text(observations.camera, 2_000), rhythm: text(observations.rhythm, 2_000),
      tone: text(observations.tone, 2_000), copy: text(observations.copy, 4_000), flow: text(observations.flow, 2_000), audio: text(observations.audio, 2_000)
    },
    transfer: {
      keep: ['开场钩子结构', '镜头长度与切点密度', '景别/机位变化', '口播文案的节奏和信息顺序'],
      rebuild: ['商品画面', '人物/声音（仅使用自有或已授权素材）', 'Logo、参数、价格和功能声明', '音乐及平台发布素材'],
      productFacts: text(productFacts, 4_000), prohibited: text(prohibited, 2_000)
    },
    rights: { reference: source?.rightsStatus || 'unverified', mediaUpload: false, publish: false },
    caveats: ['播放量只代表用户输入候选中的排序，不证明全平台最高。', '观察字段和转录必须人工核对；不得把参考视频的事实、人物、音乐或声音复制到新片。']
  };
}

module.exports = { PLATFORM_HOSTS, buildAnalysisBrief, metricCount, normalizeCandidate, rankCandidates, safeReferenceUrl };
