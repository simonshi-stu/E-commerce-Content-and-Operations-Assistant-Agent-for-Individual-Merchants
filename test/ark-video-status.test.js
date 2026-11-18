'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {adapter} = require('../lib/ark-video-status');

test('Ark status uses a single authenticated GET and projects only verified fields', async () => {
  const secret='synthetic-only', calls=[];
  const api=adapter(secret,async (url,opts)=>{
    calls.push(opts.method);
    assert.equal(url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/test-123');
    assert.equal(opts.headers.Authorization,`Bearer ${secret}`);
    assert.equal(opts.redirect,'error');assert.equal(opts.body,undefined);
    return Response.json({id:'test-123',status:'succeeded',model:'doubao-seedance-2-0-260128',content:{video_url:secret}});
  });
  const result=await api.status('test-123');
  assert.equal(result.state,'succeeded');assert.equal(result.model,api.info.protocolModels[0]);
  assert.deepEqual(calls,['GET']);assert.doesNotMatch(JSON.stringify([result,api.info]),/synthetic-only|video_url/);
});

test('Ark errors, mismatched tasks and timeout never disclose transport details or retry',async()=>{
  for(const [expected,reply] of [
    ['http_error',()=>new Response('private-error',{status:403})],
    ['invalid_response',()=>Response.json({id:'other',status:'running'})],
    ['request_failed',()=>{throw Error('private-error');}],
    ['timeout',(_,o)=>new Promise((_,reject)=>{const keep=setTimeout(()=>reject(Error()),500);o.signal.addEventListener('abort',()=>{clearTimeout(keep);reject(o.signal.reason);});})]
  ]){
    let n=0;
    const api=adapter('synthetic-only',(...args)=>{n++;assert.equal(args[1].method,'GET');return reply(...args);},10);
    const result=await api.status('test-123');
    assert.equal(result.state,expected);assert.equal(n,1);assert.doesNotMatch(JSON.stringify(result),/private-error|synthetic-only/);
  }
});
