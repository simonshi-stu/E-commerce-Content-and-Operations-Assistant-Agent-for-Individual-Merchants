'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const demo = path.join(__dirname, '../demo');
const html = fs.readFileSync(path.join(demo, 'index.html'), 'utf8');
const scripts = ['core.js','ui.js'].map(file => new vm.Script(fs.readFileSync(path.join(demo,file),'utf8'), { filename:file }));
const mime = { 'sample-product.svg':'image/svg+xml', 'sample-motion.mp4':'video/mp4' };

class Element {
  constructor(tag='DIV') {
    this.tagName=tag.toUpperCase(); this.children=[]; this.events={}; this.attributes={}; this.dataset={};
    this.value=''; this.textContent=''; this.checked=false; this.hidden=false; this.disabled=false;
    this.classList={toggle(){},remove(){}};
  }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  setAttribute(key,value){this.attributes[key]=value;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes; if(this.tagName==='SELECT') this.value=nodes[0]?.value||'';}
  add(item){this.append(item);}
  addEventListener(type,listener){(this.events[type] ||= []).push(listener);}
  emit(type,extra={}){for(const listener of this.events[type]||[])listener({currentTarget:this,preventDefault(){},...extra});}
  click(){if(!this.disabled)this.emit('click');}
  pause(){} focus(){} scrollIntoView(){}
}
function host() {
  const stored=new Map(), records=new Map(), requested=[], downloads=[];
  let timestamp=10000, nextUrl=0;
  class TimerDate extends Date { static now(){return timestamp;} }
  const makeIDB=()=>{
    const schedule=(req,run)=>queueMicrotask(()=>{req.result=run();req.onsuccess?.();});
    const db={
      createObjectStore(){},
      transaction(){
        let pending=0, complete=false;
        const tx={objectStore(){return {getAll:()=>task(()=>[...records.values()]),put:a=>task(()=>records.set(a.sku+':'+a.id,a)),clear:()=>task(()=>records.clear())};}};
        const consider=()=>queueMicrotask(()=>{if(!pending&&!complete){complete=true;tx.oncomplete?.();}});
        function task(run){
          const request={}; pending++;
          schedule(request,()=>run());
          queueMicrotask(()=>{pending--;consider();});
          return request;
        }
        consider(); return tx;
      }
    };
    return {open(){const request={result:db};queueMicrotask(()=>{request.onupgradeneeded?.();request.onsuccess?.();});return request;}};
  };
  function boot(){
    const nodes=new Map([...html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)].map(([,tag,id])=>[id,new Element(tag)]));
    const badges=[...html.matchAll(/data-source="([^"]+)"/g)].map(([,field])=>Object.assign(new Element(),{dataset:{source:field}}));
    const timers=[], urls=new Map();
    const context=vm.createContext({
      Date:TimerDate, Blob, Uint8Array, crypto:webcrypto, indexedDB:makeIDB(),
      Option:class {constructor(text,value){this.textContent=text;this.value=value;}},
      document:{
        getElementById(id){assert.ok(nodes.has(id), 'HTML contains #'+id);return nodes.get(id);},
        querySelectorAll(){return badges;},
        createElement(tag){
          const el=new Element(tag);
          if(tag==='a')el.click=()=>downloads.push({name:el.download,blob:urls.get(el.href)});
          return el;
        }
      },
      localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
      URL:{createObjectURL(blob){const id='blob:demo-'+(++nextUrl);urls.set(id,blob);return id;},revokeObjectURL(id){urls.delete(id);}},
      fetch:async input=>{
        const key=input.replace(/^\.\//,'');
        assert.ok(Object.hasOwn(mime,key), 'only bundled fixtures may be fetched');
        requested.push(key);
        const bytes=key==='sample-motion.mp4' ? Buffer.from(fs.readFileSync(path.join(demo,key+'.b64'),'utf8'),'base64') : fs.readFileSync(path.join(demo,key));
        return {ok:true,blob:async()=>new Blob([bytes],{type:mime[key]})};
      },
      setInterval:fn=>timers.push(fn),setTimeout(){}
    });
    for(const script of scripts)script.runInContext(context);
    return {$:id=>nodes.get(id),tick(ms){timestamp+=ms;timers.forEach(fn=>fn());}};
  }
  return {boot,stored,records,requested,downloads};
}
async function waitFor(check){
  for(let tries=0;tries<150;tries++){
    if(check())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('unexpected timeout awaiting the UI event');
}
function localFile(name,contents){
  return Object.assign(new Blob([contents],{type:'image/png'}),{name});
}

test('DOM host: SKU, local asset save and dedupe, editable shortcut, previous-reference validation, mock refresh, receipt export and clear',async()=>{
  const h=host(); let page=h.boot(); let {$}=page;
  $('use-sample').click();
  await waitFor(()=>$('assets').children.filter(x=>x.tagName==='ARTICLE').length===2);
  assert.deepEqual(h.requested.sort(),['sample-motion.mp4','sample-product.svg']);
  $('example-instruction').click();$('draft-shot').click();
  assert.equal($('shot-action').value,'看价签拿梨');
  assert.equal($('shot-duration').value,6);
  assert.match($('shot-character').value,/合成人物/);
  $('shot-duration').value=9;$('shot-aspect').value='1:1';$('preference-scope').value='sku';
  $('save-preferences').click();
  $('instruction').value='打开眼镜盒，跟上一段同一个人。';$('draft-shot').click();
  assert.equal($('shot-duration').value,9);assert.equal($('shot-aspect').value,'1:1');
  $('instruction').value='抬起镜头，6 秒，跟上一段同一个人，不要画面广告字。';$('draft-shot').click();
  assert.equal($('shot-duration').value,6);assert.equal($('shot-avoid').checked,true);
  $('shot-form').emit('submit');
  assert.equal($('job-status').dataset.state,'queued');
  const queued=JSON.parse([...h.stored.values()][0]).job;
  $('shot-form').emit('submit');assert.equal(JSON.parse([...h.stored.values()][0]).job.id,queued.id);
  page=h.boot();({$}=page);
  await waitFor(()=>$('assets').children.filter(x=>x.tagName==='ARTICLE').length===2);
  assert.equal($('job-status').dataset.state,'queued');
  page.tick(2000);assert.equal($('job-status').dataset.state,'running');
  page.tick(3000);assert.equal($('job-status').dataset.state,'succeeded');
  $('download-archive').click();
  const saved=JSON.parse(await h.downloads[0].blob.text());
  assert.equal(saved.simulated,true);assert.equal(saved.chargeMinor,0);
  assert.equal(saved.mediaIncluded,false);assert.equal(saved.video.duration,6);
  assert.doesNotMatch(JSON.stringify(saved),/抬起镜头|合成人物|DEMO-001|\.mp4/);
  $('sku').value='SKU-SYNTH';$('sku').emit('change');
  $('file-picker').files=[localFile('front_sample.png','synthetic-only'),localFile('duplicate.png','synthetic-only')];
  $('file-picker').emit('change');
  await waitFor(()=>$('import-note').textContent.includes('重复 1'));
  assert.equal(h.records.size,1);assert.equal($('assets').children[0].children[2].textContent,'正面（按文件名）');
  $('instruction').value='跟上一段同一个人，抬镜头';$('draft-shot').click();
  assert.equal($('shot-character').value,'');assert.match($('shot-errors').textContent,/没有上一段人物参考/);
  page=h.boot();({$}=page);
  await waitFor(()=>$('assets').children.filter(x=>x.tagName==='ARTICLE').length===1);
  assert.equal($('sku').value,'SKU-SYNTH');
  $('clear-local').click();
  await waitFor(()=>$('archive-note').textContent.includes('已清除'));
  assert.equal(h.records.size,0);assert.equal(h.stored.size,0);
  page=h.boot();({$}=page);await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('job-status').dataset.state,'empty');assert.equal($('assets').children[0].className,'empty');
});
