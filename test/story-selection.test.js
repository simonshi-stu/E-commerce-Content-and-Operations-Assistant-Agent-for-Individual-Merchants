'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const {select,loadSelection}=require('../lib/story-selection');
const entries=['current.mp4','clip.mp4','old.mp4','photo.jpg'].map(file=>({root:'fixtures',file}));
const inventory={roots:{fixtures:os.tmpdir()},entries};
const id=i=>crypto.createHash('sha256').update(JSON.stringify(['fixtures',entries[i].file])).digest('hex');
test('private selection excludes unlisted files and preserves explicit role order',()=>{
  const s={name:'Example',items:[{role:'full',title:'Current',id:id(0)},{role:'B',title:'Middle',id:id(1)}]};
  const result=select(inventory,{version:1,stories:[s],images:[id(3)]});
  assert.deepEqual(result.entries.map(e=>e.file),['current.mp4','clip.mp4','photo.jpg']);
  assert.deepEqual(result.entries.slice(0,2).map(e=>e.role),['full','B']);
  assert.equal(result.entries[2].story,undefined);
  assert.throws(()=>select(inventory,{version:1,stories:[s],images:[id(2)]}));
  assert.throws(()=>select(inventory,{version:1,stories:[{...s,items:s.items.toReversed()}],images:[]}));
});
test('no fallback to an uncurated catalog when private selection is unavailable',()=>{
  assert.deepEqual(loadSelection(path.resolve(__dirname,'nonexistent-fixture')).entries,[]);
  assert.throws(()=>select(inventory,{}));
});
