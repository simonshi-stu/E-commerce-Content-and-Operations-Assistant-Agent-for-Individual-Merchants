'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

function library(config, configured, reveal = revealInExplorer) {
  const token = crypto.randomUUID();
  const records = new Map();
  for (const entry of config.entries) {
    const root = config.roots[entry.root];
    if (typeof root !== 'string' || !path.isAbsolute(root) || !entry.file ||
        entry.file.split(/[\\/]/).some(s => !s || s === '.' || s === '..' || /[:*?"<>|\x00-\x1f]/.test(s))) throw Error('Invalid manifest');
    const id = crypto.createHash('sha256').update(JSON.stringify([entry.root, entry.file])).digest('hex');
    records.set(id, { ...entry, id, root: path.resolve(root), location: path.resolve(root, entry.file) });
  }
  async function inspect(item) {
    let handle;
    try {
      const real = fs.realpathSync.native;
      if (path.relative(item.root, real(item.root)) || path.relative(item.location, real(item.location))) throw Error();
      const ext = path.extname(item.file).toLowerCase();
      const mime = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext];
      if (!mime || !item.location.startsWith(item.root + path.sep)) throw Error();
      handle = await fs.promises.open(item.location, 'r');
      const st = await handle.stat(), current = await fs.promises.stat(real(item.location));
      if (!st.isFile() || st.ino !== current.ino || st.dev !== current.dev || path.relative(item.location, real(item.location))) throw Error();
      const sig = Buffer.alloc(12);
      const {bytesRead} = await handle.read(sig, 0, 12, 0);
      if (bytesRead < 12 || !(mime === 'video/mp4' ? sig.toString('ascii', 4, 8) === 'ftyp' :
        mime === 'image/png' ? sig.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : sig.subarray(0, 3).toString('hex') === 'ffd8ff')) throw Error();
      return {handle, size: st.size, mime, updated: st.mtime.toISOString()};
    } catch { if (handle) await handle.close(); return null; }
  }
  return async (req, res) => {
    const host = `127.0.0.1:${req.socket.localPort}`;
    const end = (code, body = '') => { res.writeHead(code); res.end(body); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    if (req.headers.host !== host || req.socket.remoteAddress !== '127.0.0.1' ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return end(403);
    if (req.url === '/library/catalog' && req.method === 'GET') {
      const rows = [];
      for (const item of records.values()) {
        const file = await inspect(item);
        if (file) await file.handle.close();
        const {id, product, group, task, location, kind} = item;
        rows.push({id, product, group, task, location, kind, available: !!file, updated: file?.updated, bytes: file?.size});
      }
      res.setHeader('Content-Type','application/json; charset=utf-8');
      return end(200, JSON.stringify({rows, token, configured: !!configured}));
    }
    const match = /^\/library\/([a-f0-9]{64})\/(view|download|folder)$/.exec(req.url);
    const row = match && records.get(match[1]);
    if (!row) return end(404);
    const action = match[2];
    if (action === 'folder' ? (req.method !== 'POST' || req.headers.origin !== `http://${host}` || req.headers['x-library-token'] !== token) :
      !['GET','HEAD'].includes(req.method)) return end(403);
    const file = await inspect(row);
    if (!file) return end(404);
    try {
      if (action === 'folder') { await reveal(row.location); return end(204); }
      let start = 0, finish = file.size - 1, code = 200;
      if (req.headers.range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        start = m ? Number(m[1]) : -1; finish = m?.[2] ? Math.min(Number(m[2]), finish) : finish;
        if (start < 0 || start > finish) { res.setHeader('Content-Range',`bytes */${file.size}`); return end(416); }
        res.setHeader('Content-Range',`bytes ${start}-${finish}/${file.size}`); code = 206;
      }
      res.writeHead(code, {'Content-Type':file.mime, 'Content-Length':finish-start+1, 'Accept-Ranges':'bytes',
        'Content-Disposition':`${action === 'view' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(row.file))}`});
      if (req.method === 'HEAD') return res.end();
      await pipeline(file.handle.createReadStream({start, end:finish}), res);
    } finally { await file.handle.close(); }
  };
}
function revealInExplorer(location) {
  if (process.platform !== 'win32') throw Error('Explorer unavailable');
  return new Promise((resolve,reject) => {
    const p = spawn(path.join(process.env.SystemRoot,'explorer.exe'), [path.dirname(location)], {shell:false, stdio:'ignore'});
    p.once('error',reject); p.once('spawn',() => { p.unref(); resolve(); });
  });
}
module.exports = {library};
