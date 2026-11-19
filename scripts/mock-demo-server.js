'use strict';
// Independent allowlisted static server. Never import the main application, read credentials or proxy requests.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const base = path.resolve(__dirname, '../demo');
const routes = new Map([['/', ['index.html','text/html; charset=utf-8']], ['/index.html',['index.html','text/html; charset=utf-8']],
  ['/core.js',['core.js','text/javascript; charset=utf-8']], ['/ui.js',['ui.js','text/javascript; charset=utf-8']], ['/style.css',['style.css','text/css; charset=utf-8']],
  ['/sample-product.svg',['sample-product.svg','image/svg+xml']], ['/sample-character.svg',['sample-character.svg','image/svg+xml']]]);
// Draw an original animated, abstract product turntable. No source files or camera footage.
function makeSampleVideo() {
  const w=192,h=256,fps=12,n=24, frames=Buffer.alloc(w*h*3*n);
  for(let f=0;f<n;f++) {const shift=10*Math.sin(f*2*Math.PI/n), tilt=3*Math.cos(f*2*Math.PI/n);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const py=y-141+(x-96)*0.10, px=x-96-shift;
      const bx=Math.abs(px)-32, lens=(bx/29)**2+((py-tilt*px/60)/20)**2;
      const stem=px>57&&px<77&&Math.abs(py+(px-57)*.74)<2.8;
      const bridge=Math.abs(px)<8&&Math.abs(py+7-0.07*px*px)<2.9;
      let rgb=y<191?[244-y*.025,228-y*.035,223-y*.03]:[225,218,206];
      if(y>191 && ((x-96-shift)/77)**2+((y-199)/7)**2<1)rgb=[198,187,178];
      if(lens<.88)rgb=[231,228,216];
      if((lens<1.19&&lens>=.87)||stem||bridge)rgb=[178,104,118];
      if(lens>.95&&lens<1.15&&py<-5)rgb=[228,158,165];
      if(lens<.78&&py<-6&&Math.abs(bx+4+py*.65)<2)rgb=[254,249,240];
      const off=((f*h+y)*w+x)*3;for(let c=0;c<3;c++)frames[off+c]=rgb[c];
    }
  }
  const enc=spawnSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',w+'x'+h,
    '-r',String(fps),'-i','pipe:0','-an','-frames:v',String(n),'-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags',
    'frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1'],{input:frames,maxBuffer:4*1024*1024,timeout:20000});
  if(enc.status!==0||!enc.stdout?.length)throw Error('The demo needs ffmpeg with libx264 on PATH to render its original synthetic clip. No download or provider call was made.');
  return enc.stdout;
}
function sampleClip() { return Buffer.from(fs.readFileSync(path.join(base,'sample-motion.mp4.b64'),'ascii'),'base64'); }
function handler(clip) {
  return (req,res)=>{
    const port=req.socket.localPort;
    if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)) {res.writeHead(403);return res.end();}
    const headers={'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...headers,Allow:'GET, HEAD'});return res.end();}
    const route=req.url.split('?')[0];
    const send=(status,bytes,more)=>{res.writeHead(status,{...headers,...more,'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);};
    if(route==='/sample-motion.mp4'){
      const h={'Content-Type':'video/mp4','Accept-Ranges':'bytes'};
      if(!req.headers.range)return send(200,clip,h);
      const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      const start=m?Number(m[1]):-1,end=m&&m[2]?Math.min(Number(m[2]),clip.length-1):clip.length-1;
      if(start<0||start>end){res.writeHead(416,{...headers,'Content-Range':'bytes */'+clip.length});return res.end();}
      return send(206,clip.subarray(start,end+1),{...h,'Content-Range':'bytes '+start+'-'+end+'/'+clip.length});
    }
    const item=routes.get(route);
    if(!item){res.writeHead(404,headers);return res.end();}
    try{return send(200,fs.readFileSync(path.join(base,item[0])),{'Content-Type':item[1]});}catch{res.writeHead(500,headers);res.end();}
  };
}
function run(){const portArg=process.argv[2]??'4178';if(!/^\d{1,5}$/.test(portArg)||Number(portArg)>65535)throw Error('Invalid port');
 const server=http.createServer(handler(sampleClip()));server.on('error',e=>{console.error('Cannot start demo:',e.code);process.exitCode=1;});
 server.listen(Number(portArg),'127.0.0.1',()=>console.log('Mock merchant workbench: http://127.0.0.1:'+server.address().port+'/ (no provider, no billing)'));}
if(require.main===module)run();
module.exports={handler,makeSampleVideo,sampleClip};
