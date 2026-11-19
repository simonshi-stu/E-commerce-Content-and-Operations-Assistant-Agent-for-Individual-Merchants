(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DemoCore = api;
})(globalThis, function () {
  'use strict';
  const ASPECTS = Object.freeze(['9:16', '16:9', '1:1', '4:3', '3:4']);
  const DEFAULTS = Object.freeze({ duration: 5, aspect: '9:16', avoidAdWords: true });
  const FIELDS = Object.freeze(['sku', 'assetId', 'character', 'action', 'duration', 'aspect', 'avoidAdWords']);
  const own = (object, key) => object != null && Object.hasOwn(object, key);

  function parseInstruction(text) {
    if (typeof text !== 'string' || !text.trim()) return {};
    const parts = text.trim().split(/[，,。；;\n]+/u).map(x => x.trim()).filter(Boolean);
    const shot = {};
    const action = [];
    for (const part of parts) {
      let rest = part;
      const take = (regexp, field, transform = x => x) => {
        rest = rest.replace(regexp, (_, value) => {
          shot[field] = transform(value);
          return ' ';
        });
      };
      take(/(?:\bSKU|商品编号)\s*[：:=#]?\s*([a-z0-9_-]{1,64})(?![a-z0-9_-])/giu, 'sku');
      take(/(?:\basset|素材(?:编号|\s*ID))\s*[：:=#]?\s*([a-z0-9_-]{1,96})(?![a-z0-9_-])/giu, 'assetId');
      take(/((?:(?:跟|和|与|比)\s*)?(?:上一段|上个镜头|上一镜|前一段)\s*(?:用|是|保持)?\s*(?:同一个人|同一人|同一人物|同一角色)|(?:同一个人|同一人物|同一角色)\s*(?:如|同|跟)?\s*(?:上一段|上个镜头|上一镜)|(?:same (?:person|character) (?:as|from) (?:the )?(?:previous|last) (?:shot|clip)))/giu, 'sameCharacter', () => true);
      take(/(?:同一角色|同一人物|角色|人物|character|same character)\s*[：:=]\s*(.{1,96})$/iu, 'character', x => x.trim());
      take(/(?:^|(?<![\w.:：]))(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:onds?)?)?\b)/giu, 'duration', Number);
      take(/\b(\d{1,2}\s*[:：]\s*\d{1,2})\b/gu, 'aspect', x => x.replaceAll('：', ':').replace(/\s/g, ''));
      take(/(不加广告词|不要画面广告字|不要画面广告词|无画面广告字|不要广告词|去掉广告词|不写广告词|不要宣传词|无广告词|no ad (?:words|copy)|avoid ad (?:words|copy))/giu, 'avoidAdWords', () => true);
      take(/(允许广告词|允许宣传词|allow ad (?:words|copy))/giu, 'avoidAdWords', () => false);
      rest = rest.replace(/^\s*(?:镜头动作|动作|action)\s*[：:=]\s*/iu, '').replace(/^[\s、]+|[\s、]+$/gu, '');
      if (rest) action.push(rest);
    }
    if (action.length) shot.action = action.join('，');
    return shot;
  }

  function resolveShot({ global, project, sku, explicit, previousCharacter } = {}) {
    const shot = {};
    const sources = {};
    for (const [scope, layer] of [['default', DEFAULTS], ['global', global], ['project', project], ['sku', sku], ['explicit', explicit]]) {
      for (const field of FIELDS) {
        if (own(layer, field) && layer[field] !== undefined) {
          shot[field] = typeof layer[field] === 'string' ? layer[field].trim() : layer[field];
          sources[field] = scope;
        }
      }
    }
    if (explicit?.sameCharacter === true && !own(explicit, 'character')) {
      const confirmed = requiredText(previousCharacter, 96);
      shot.character = confirmed ? previousCharacter.trim() : '';
      sources.character = confirmed ? 'previous' : 'previousMissing';
    }
    return { shot, sources };
  }

  const safeId = (x, len) => typeof x === 'string' && x.length <= len && /^[a-z0-9][a-z0-9_-]*$/i.test(x);
  const requiredText = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
  function validateShot(shot) {
    const s = shot || {};
    const errors = {};
    if (!safeId(s.sku, 64)) errors.sku = '请选择或填写有效的 SKU。';
    if (!safeId(s.assetId, 96)) errors.assetId = '请选择此 SKU 下的参考素材。';
    if (!requiredText(s.character, 96)) errors.character = '请填写用于保持同一人物的参考标记（最多 96 字）。';
    if (!requiredText(s.action, 600)) errors.action = '请填写镜头动作（最多 600 字）。';
    if (!Number.isInteger(s.duration) || s.duration < 4 || s.duration > 15) errors.duration = '时长应为 4–15 秒的整数。';
    if (!ASPECTS.includes(s.aspect)) errors.aspect = '请选择支持的画面比例。';
    if (typeof s.avoidAdWords !== 'boolean') errors.avoidAdWords = '请选择是否避免广告词。';
    return { ok: Object.keys(errors).length === 0, errors };
  }

  function createJob(shot, { now = Date.now(), id = 'mock-' + globalThis.crypto.randomUUID() } = {}) {
    const check = validateShot(shot);
    if (!check.ok) throw Object.assign(new Error('invalid_shot'), { errors: check.errors });
    if (!safeId(id, 96) || !Number.isSafeInteger(now) || now < 0) throw new Error('invalid_job_identity');
    return {
      id, provider: 'mock-seedance', createdAt: now,
      shot: Object.fromEntries(FIELDS.map(k => [k, typeof shot[k] === 'string' ? shot[k].trim() : shot[k]]))
    };
  }

  function getJobState(job, now = Date.now()) {
    const elapsed = Math.max(0, now - job.createdAt);
    const status = elapsed >= 4800 ? 'succeeded' : elapsed >= 1100 ? 'running' : 'queued';
    return { ...job, status, progress: status === 'succeeded' ? 100 : status === 'queued' ? 0 : Math.min(99, Math.floor(elapsed / 48)) };
  }

  function archiveJob(job, now = Date.now()) {
    if (!job || job.provider !== 'mock-seedance' || !safeId(job.id, 96) || !Number.isSafeInteger(job.createdAt) ||
        job.createdAt < 0 || !validateShot(job.shot).ok || !Number.isSafeInteger(now) || getJobState(job, now).status !== 'succeeded') {
      throw new Error('archive_not_ready');
    }
    // The archive is a receipt, not a copy of either request or media.
    // Free-form user identifiers and text may contain private information.
    return {
      schemaVersion: 1, provider: 'mock-seedance', simulated: true, status: 'succeeded',
      createdAt: new Date(job.createdAt).toISOString(),
      completedAt: new Date(job.createdAt + 4800).toISOString(),
      video: { duration: job.shot.duration, aspect: job.shot.aspect, avoidAdWords: job.shot.avoidAdWords },
      mediaIncluded: false, liveProviderUsed: false, chargeMinor: 0
    };
  }

  return Object.freeze({ ASPECTS, DEFAULTS, parseInstruction, resolveShot, validateShot, createJob, getJobState, archiveJob });
});
