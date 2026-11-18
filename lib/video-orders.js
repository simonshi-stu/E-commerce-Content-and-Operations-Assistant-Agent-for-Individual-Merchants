'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const {localKey} = require('./ark-video-status');

const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
const model = 'doubao-seedance-2-0-260128';
const states = new Set(['queued','running','succeeded','failed','cancelled','expired']);
const uuid = () => crypto.randomUUID();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function fail(code,message) { throw Object.assign(new Error(message),{publicError:true,code}); }
async function input(req) {
  if (req.headers['content-type'] !== 'application/json') fail(415,'json_required');
  let bytes=0; const chunks=[];
  for await (const c of req) { if ((bytes+=c.length)>12288) fail(413,'too_large'); chunks.push(c); }
  try { const o=JSON.parse(Buffer.concat(chunks).toString()); if(o && Object.getPrototypeOf(o)===Object.prototype)return o; }catch{}
  fail(400,'invalid_json');
}
function keys(o,expected){if(Object.keys(o).sort().join('|')!==expected.split(' ').sort().join('|')) fail(400,'invalid_fields');}
function exact(p){if(path.relative(p,fs.realpathSync.native(p)))fail(403,'unsafe_storage');return p;}
function mediaHost(raw){
  const u=new URL(raw);
  if(u.protocol!=='https:' || u.port || u.username || u.password || !u.hostname.endsWith('.volces.com'))fail(422,'unsupported_media_source');
  return u.href;
}
function studio({root,dir,key,transport=fetch,mock=false,history=null}) {
  if(!dir)dir=path.join(root,'private','video-orders');
  fs.mkdirSync(dir,{recursive:true});exact(dir);
  const dbFile=path.join(dir,'orders.sqlite');
  for(const ext of ['','-wal','-shm','-journal'])if(fs.existsSync(dbFile+ext))exact(dbFile+ext);
  const db=new DatabaseSync(dbFile);
  db.exec(`PRAGMA busy_timeout=4000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,digest TEXT UNIQUE NOT NULL,body TEXT NOT NULL,
    estimate INTEGER NOT NULL,state TEXT NOT NULL,task TEXT UNIQUE,tokens INTEGER,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS consents(id TEXT PRIMARY KEY,quote TEXT NOT NULL,session_digest TEXT NOT NULL,confirmed INTEGER NOT NULL);`);
  const sessions=new Map();
  const total=()=>db.prepare('SELECT coalesce(sum(estimate),0) AS n FROM orders').get().n;
  const listing=()=>db.prepare('SELECT id,estimate,state,task,tokens,created FROM orders ORDER BY created DESC').all().map(o=>({...o,media:fs.existsSync(path.join(dir,o.id+'.mp4'))}));
  const auth=()=>({Authorization:`Bearer ${key}`,Accept:'application/json'});
  const lookup=async o=>{
    const r=await transport(`${endpoint}/${o.task}`,{headers:auth(),method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!r.ok)fail(502,'status_unavailable');
    const j=await r.json();if(j.id!==o.task || !states.has(j.status))fail(502,'invalid_status');
    const n=j.usage?.completion_tokens;
    db.prepare('UPDATE orders SET state=?,tokens=coalesce(?,tokens) WHERE id=?').run(j.status,Number.isSafeInteger(n)&&n>=0?n:null,o.id);
    return j;
  };
  return async function api(req,res){
    const json=(code,o)=>{res.writeHead(code,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(o));};
    try{
      const host=`127.0.0.1:${req.socket.localPort}`,origin=`http://${host}`;
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');
      res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
      if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')fail(403,'local_only');
      const route=req.url;
      if(req.method==='GET' && ['/studio/','/studio/app.js','/studio/style.css'].includes(route)){
        const [name,mime]=route==='/studio/'?['video-orders.html','text/html']:route.endsWith('.css')?['library.css','text/css']:['video-orders.js','text/javascript'];
        res.writeHead(200,{'Content-Type':mime+';charset=utf-8'});
        return res.end(fs.readFileSync(path.join(root,'public',name)));
      }
      const cookie=`studio_${req.socket.localPort}`,now=Date.now();
      for(const [id,s] of sessions)if(s.until<now)sessions.delete(id);
      const sid=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1);
      let s=sessions.get(sid);
      if(req.method==='GET'&&route==='/studio/home'){
        if(!s){const id=uuid();s={csrf:uuid(),until:now+1800000};sessions.set(id,s);res.setHeader('Set-Cookie',`${cookie}=${id}; Path=/studio/; HttpOnly; SameSite=Strict; Max-Age=1800`);}
        return json(200,{mock,configured:!!key,csrf:s.csrf,model,total:total(),orders:listing(),history});
      }
      if(!s)fail(403,'session_expired');
      const media=/^\/studio\/media\/([0-9a-f-]{36})$/.exec(route);
      if(req.method==='GET'&&media){
        const file=path.join(dir,media[1]+'.mp4');
        if(!db.prepare('SELECT 1 FROM orders WHERE id=?').get(media[1])||!fs.existsSync(file))fail(404,'not_saved');
        exact(file);res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':fs.statSync(file).size});return await pipeline(fs.createReadStream(file),res);
      }
      if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-studio-csrf']!==s.csrf)fail(403,'confirmation_session_required');
      const o=await input(req);
      if(route==='/studio/cancel'){keys(o,'');s.quote=null;return json(200,{cancelled:true});}
      if(route==='/studio/quote'){
        s.quote=null;keys(o,'prompt duration');
        if(typeof o.prompt!=='string'||!o.prompt.trim()||o.prompt.length>1500||/[\x00-\x08\x0b-\x1f]|(?:^|\s)--[a-z]/i.test(o.prompt)||!Number.isInteger(o.duration)||o.duration<4||o.duration>15)fail(400,'invalid_spec');
        const body={model,content:[{type:'text',text:o.prompt.trim()}],duration:o.duration,ratio:'9:16',resolution:'480p',generate_audio:false};
        const tokens=496*864*24*o.duration/1024,estimate=Math.ceil(tokens*46/10000);
        s.quote={id:uuid(),until:now+120000,body,tokens,estimate,prior:total(),rateCnyPerMillion:46,priceBasis:'ark-2026-11-02-no-video-input'};
        return json(200,s.quote);
      }
      if(route==='/studio/confirm'){
        keys(o,'quote consent');const q=s.quote;
        if(!key || !q || o.quote!==q.id || o.consent!==true || q.until<Date.now())fail(409,'invalid_or_expired_confirmation');
        s.quote=null;const body=JSON.stringify(q.body),id=q.id;
        db.exec('BEGIN IMMEDIATE');
        try{
          if(db.prepare('SELECT 1 FROM orders WHERE digest=?').get(sha(body)))fail(409,'duplicate_request');
          if(total()!==q.prior)fail(409,'total_changed_requote');
          if(db.prepare("SELECT 1 FROM orders WHERE state='submission_unknown'").get())fail(409,'resolve_unknown_before_new_order');
          db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,NULL,NULL,?)').run(id,sha(body),body,q.estimate,'submission_unknown',Date.now());
          db.prepare('INSERT INTO consents VALUES(?,?,?,?)').run(id,JSON.stringify(q),sha(sid),Date.now());
          db.exec('COMMIT');
        }catch(e){db.exec('ROLLBACK');throw e;}
        // A lost response, crash or ambiguous rejection leaves the committed unknown row untouched.
        try{
          const r=await transport(endpoint,{method:'POST',headers:{...auth(),'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(15000)});
          if(r.ok){const j=await r.json();if(typeof j.id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(j.id))
            db.prepare("UPDATE orders SET task=?,state='submitted' WHERE id=?").run(j.id,id);}
        }catch{}
        return json(200,{orders:listing()});
      }
      if(route==='/studio/status'||route==='/studio/save'){
        keys(o,'id');if(typeof o.id!=='string')fail(400,'invalid_order');
        const order=db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
        if(!key||!order?.task)fail(404,'no_bound_task');
        const j=await lookup(order);
        if(route==='/studio/save'){
          if(j.status!=='succeeded'||typeof j.content?.video_url!=='string')fail(409,'not_ready');
          const file=path.join(exact(dir),order.id+'.mp4');
          if(!fs.existsSync(file)){
            const r=await transport(mediaHost(j.content.video_url),{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60000)});
            const max=128*1024*1024;
            if(!r.ok||!/^video\/mp4(?:;|$)/i.test(r.headers.get('content-type')||'')||Number(r.headers.get('content-length'))>max){await r.body?.cancel();fail(422,'invalid_media');}
            const tmp=path.join(dir,uuid()+'.part'); let size=0;
            try{
              await pipeline(r.body,new Transform({transform(c,_,cb){size+=c.length;cb(size>max?Error('size'):null,c);}}),fs.createWriteStream(tmp,{flags:'wx'}));
              const h=await fs.promises.open(tmp,'r');const sig=Buffer.alloc(12);
              try{await h.read(sig,0,12,0);}finally{await h.close();}
              if(size<12||sig.toString('ascii',4,8)!=='ftyp')fail(422,'invalid_media');
              try{fs.linkSync(tmp,file);}catch(e){if(e.code!=='EEXIST')throw e;}
            }finally{fs.rmSync(tmp,{force:true});}
          }
        }
        return json(200,{orders:listing()});
      }
      fail(404,'not_found');
    }catch(e){if(!res.headersSent)json(e.publicError?e.code:502,{error:e.publicError?e.message:'operation_unavailable'});else res.destroy();}
  };
}
function liveStudio(root){
  let history=null;
  try{
    const h=JSON.parse(fs.readFileSync(path.join(root,'private','historical-video-usage.json'),'utf8'));
    if(h.model===model && h.resolution==='720p' && h.ratio==='9:16' && Number.isSafeInteger(h.seconds)&&h.seconds>0&&Number.isSafeInteger(h.tokens)&&h.tokens>0)
      history={resolution:h.resolution,seconds:h.seconds,tokens:h.tokens};
  }catch{}
  return studio({root,key:localKey(root),history});
}
module.exports={studio,liveStudio};
