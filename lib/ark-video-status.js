'use strict';
const fs = require('node:fs'), path = require('node:path');
const origin = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/';
const models = ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628'];
const states = new Set(['queued','running','succeeded','failed','cancelled','expired']);

function localKey(root) {
  try {
    const line = fs.readFileSync(path.resolve(root,'../hypit-runtime/.env.local'),'utf8')
      .match(/^[ \t]*(?:export[ \t]+)?ARK_API_KEY[ \t]*=[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#'"]+))[ \t]*(?:#.*)?\r?$/m);
    return line && (line[1] || line[2] || line[3]);
  } catch { return null; }
}

function adapter(key, transport = fetch, timeout = 5000) {
  const info = {configured: !!key, configAt: new Date().toISOString(), protocolModels: models, paidGeneration: false};
  return {info, async status(task) {
    const result = (state,source,model=null) => ({state,source,model,checkedAt:new Date().toISOString()});
    if (!key || !/^[a-zA-Z0-9_-]{1,160}$/.test(task)) return result('unavailable','local');
    try {
      const r = await transport(origin + task, {method:'GET', redirect:'error', signal:AbortSignal.timeout(timeout),
        headers:{Authorization:`Bearer ${key}`,Accept:'application/json'}});
      if (!r.ok) return result('http_error','status_request');
      const data = await r.json();
      if (data.id !== task || !states.has(data.status)) return result('invalid_response','status_request');
      return result(data.status,'ark_response',models.includes(data.model) ? data.model : null);
    } catch (e) { return result(e?.name === 'TimeoutError' ? 'timeout' : 'request_failed','status_request'); }
  }};
}
module.exports = {adapter, localAdapter:root=>adapter(localKey(root))};
