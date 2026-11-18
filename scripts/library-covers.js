'use strict';
// Offline, operator-run only. The web process never starts media tools.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'), dir=path.join(root,'private','library-covers');
const config=JSON.parse(fs.readFileSync(path.join(root,'private','local-library.json')));
fs.mkdirSync(dir,{recursive:true});
if(path.relative(dir,fs.realpathSync.native(dir)))throw Error('Unsafe cache');
const meta={};
for(const item of config.entries){
  const base=path.resolve(config.roots[item.root]),file=path.resolve(base,item.file);
  if(!file.startsWith(base+path.sep)||!/\.(?:mp4|jpe?g|png)$/i.test(file)||!fs.existsSync(file)||path.relative(file,fs.realpathSync.native(file)))continue;
  const id=crypto.createHash('sha256').update(JSON.stringify([item.root,item.file])).digest('hex');
  const stat=fs.statSync(file), video=/\.mp4$/i.test(file), out=path.join(dir,id+'.jpg'), temp=path.join(dir,crypto.randomUUID()+'.jpg');
  try{
    const duration=video?Number(execFileSync('ffprobe',['-v','error','-protocol_whitelist','file','-show_entries','format=duration','-of','csv=p=0',file],{timeout:15000})):null;
    const seek=video&&duration>0?['-ss',String(duration*(0.16+parseInt(id.slice(0,2),16)/600))]:[];
    execFileSync('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file',...seek,'-i',file,'-an','-vf',`scale=384:512:force_original_aspect_ratio=decrease${video?',thumbnail=24':''}`,'-frames:v','1','-q:v','4',temp],{timeout:30000});
    fs.renameSync(temp,out);meta[id]={duration,bytes:stat.size,updated:stat.mtime.toISOString()};
  }catch{fs.rmSync(temp,{force:true});}
}
const manifest=path.join(dir,crypto.randomUUID()+'.json');fs.writeFileSync(manifest,JSON.stringify(meta));fs.renameSync(manifest,path.join(dir,'index.json'));console.log('Cached covers:',Object.keys(meta).length);
