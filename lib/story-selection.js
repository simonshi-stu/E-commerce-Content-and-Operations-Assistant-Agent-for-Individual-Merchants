'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');

// The private inventory is an upper bound, not a default selection.
function select(inventory,manifest){
  if(manifest?.version!==1||!Array.isArray(manifest.stories)||!Array.isArray(manifest.images))throw Error('Invalid selection');
  const byId=new Map(inventory.entries.map(e=>[crypto.createHash('sha256').update(JSON.stringify([e.root,e.file])).digest('hex'),e]));
  const entries=[],used=new Set(),names=new Set();
  function take(id,video){
    const e=byId.get(id);
    if(!e||used.has(id)||!(video?/\.mp4$/i:/\.(png|jpe?g)$/i).test(e.file))throw Error('Invalid selected asset');
    used.add(id);return e;
  }
  for(const [index,s] of manifest.stories.entries()){
    if(typeof s.name!=='string'||!s.name.trim()||names.has(s.name)||!Array.isArray(s.items)||!s.items.length)throw Error('Invalid story');
    names.add(s.name);
    const roles=new Set();
    for(const [i,item] of s.items.entries()){
      if(!item.role||roles.has(item.role)||(item.role==='full'&&i!==0)||!item.title)throw Error('Invalid story order');
      roles.add(item.role);
      entries.push({...take(item.id,true),group:s.name,story:s.name,role:item.role,title:item.title,note:s.note,
        kind:item.role==='full'?'核验成片':'无字幕单段',displayOrder:index*100+i});
    }
  }
  for(const id of manifest.images)entries.push({...take(id,false),kind:'商品素材'});
  return {roots:inventory.roots,entries,curated:true};
}
function loadSelection(root){
  try{
    const read=name=>JSON.parse(fs.readFileSync(path.join(root,'private',name),'utf8'));
    return select(read('local-library.json'),read('story-selection.json'));
  }catch{return {roots:{},entries:[],curated:true,selectionUnavailable:true};}
}
module.exports={loadSelection,select};
