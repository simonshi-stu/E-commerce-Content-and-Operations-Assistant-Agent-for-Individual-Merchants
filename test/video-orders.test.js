'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {studio}=require('../lib/video-orders');
const root=path.resolve(__dirname,'..'), endpoint='https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
function store(t){const parent=path.join(root,'tmp');fs.mkdirSync(parent,{recursive:true});return fs.mkdtempSync(path.join(parent,'orders-test-'));}
async function instance(t,dir,transport){
  const api=studio({root,dir,key:'fixture-key',mock:true,transport}),srv=http.createServer(api);
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const stop=async()=>{if(srv.listening){srv.closeAllConnections();await new Promise(r=>srv.close(r));}};
  t.after(stop);
  const base=`http://127.0.0.1:${srv.address().port}/studio/`, h=await fetch(base+'home');
  const cookie=h.headers.get('set-cookie').split(';')[0],home=await h.json();
  const post=(action,data,over={})=>fetch(base+action,{method:'POST',headers:{cookie,origin:new URL(base).origin,'content-type':'application/json','x-studio-csrf':home.csrf,...over},body:JSON.stringify(data)});
  const quote=async(text='fixture')=>(await post('quote',{prompt:text,duration:5})).json();
  const confirm=q=>post('confirm',{quote:q.id,consent:true});
  return {base,home,post,quote,confirm,stop};
}
test('paid order confirmation is session bound and atomically deduplicated across instances',async t=>{
  let calls=0;
  async function fake(url,o){
    calls++;assert.equal(url,endpoint);assert.equal(o.method,'POST');assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,'Bearer fixture-key');
    assert.deepEqual(JSON.parse(o.body),{model:'doubao-seedance-2-0-260128',content:[{type:'text',text:'fixture'}],duration:5,ratio:'9:16',resolution:'480p',generate_audio:false});
    return Response.json({id:'fixture-task'});
  }
  const dir=store(t),a=await instance(t,dir,fake),b=await instance(t,dir,fake);
  assert.deepEqual(a.home.orders,[]);
  const cancelled=await a.quote();await a.post('cancel',{});assert.equal((await a.confirm(cancelled)).status,409);
  const q=await a.quote(),other=await b.quote();assert.equal(q.estimate,232);
  assert.equal((await b.confirm(q)).status,409);
  assert.equal((await a.post('confirm',{quote:q.id,consent:true},{origin:'https://example.invalid'})).status,403);
  const responses=await Promise.all([a.confirm(q),a.confirm(q),b.confirm(other)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409,409]);assert.equal(calls,1);
  await a.stop();await b.stop();
  const c=await instance(t,dir,fake);assert.equal(c.home.orders[0].task,'fixture-task');
  assert.equal((await c.confirm(await c.quote())).status,409);assert.equal(calls,1);
});
test('lost or unreadable create response persists as unknown without retry',async t=>{
  for(const mode of ['timeout','malformed']){
    let count=0;const dir=store(t);const fake=async()=>{count++;if(mode==='timeout')throw new DOMException('test','TimeoutError');return new Response('{');};
    const a=await instance(t,dir,fake);const res=await(await a.confirm(await a.quote())).json();
    assert.equal(res.orders[0].state,'submission_unknown');await a.stop();
    const b=await instance(t,dir,fake);assert.equal(b.home.orders[0].task,null);
    assert.equal((await b.confirm(await b.quote('different'))).status,409);assert.equal(count,1);
  }
});
test('result retrieval binds task, omits credentials and rejects unsafe output',async t=>{
  let raw='https://unapproved.invalid/output',type='text/plain',bytes='not a movie',mediaCalls=0;
  const dir=store(t),a=await instance(t,dir,async(url,opts)=>{
    if(url===endpoint)return Response.json({id:'bound'});
    if(url===endpoint+'/bound')return Response.json({id:'bound',status:'succeeded',usage:{completion_tokens:123},content:{video_url:raw}});
    mediaCalls++;assert.equal(opts.redirect,'error');assert.equal(opts.headers,undefined);assert.equal(opts.credentials,'omit');
    return new Response(bytes,{headers:{'content-type':type}});
  });
  const {orders}=await(await a.confirm(await a.quote())).json(),body={id:orders[0].id};
  assert.equal((await a.post('save',body)).status,422);assert.equal(mediaCalls,0);
  raw='https://fixture.volces.com/result';assert.equal((await a.post('save',body)).status,422);
  type='video/mp4';assert.equal((await a.post('save',body)).status,422);
  bytes=Buffer.from('000000186674797069736f6d','hex');
  const saved=await(await a.post('save',body)).json();assert.equal(saved.orders[0].media,true);assert.equal(saved.orders[0].tokens,123);
  assert.deepEqual(fs.readFileSync(path.join(dir,body.id+'.mp4')),bytes);
});
