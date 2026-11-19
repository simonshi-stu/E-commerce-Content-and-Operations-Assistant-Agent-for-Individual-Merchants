'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {handler,sampleClip}=require('../scripts/mock-demo-server');
test('demo only serves its UI and original fixtures: no provider endpoints, arbitrary files or writes',async t=>{
  const bytes=sampleClip();assert.equal(bytes.subarray(4,8).toString(),'ftyp');
  const server=http.createServer(handler(bytes));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
  for(const p of ['/','/sample-product.svg','/sample-character.svg','/core.js']){const r=await fetch(base+p);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/connect-src 'self'/);await r.arrayBuffer();}
  const partial=await fetch(base+'/sample-motion.mp4',{headers:{range:'bytes=0-15'}});assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),bytes.subarray(0,16));
  for(const p of ['/studio/','/.env','/library/catalog','/api/seedance','/private/','/sample-motion.mp4/other'])assert.equal((await fetch(base+p)).status,404);
  assert.equal((await fetch(base+'/',{method:'POST',body:'never sent anywhere'})).status,405);
  const wrongHost=await new Promise((resolve,reject)=>http.get(base+'/',{headers:{Host:'foreign.invalid'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject));assert.equal(wrongHost,403);
});
