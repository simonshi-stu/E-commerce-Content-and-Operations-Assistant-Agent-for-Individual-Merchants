'use strict';
// Read-only companion entry point; does not initialize any production worker.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const {library} = require('../lib/local-library');
const {localAdapter} = require('../lib/ark-video-status');
const root = path.resolve(__dirname,'..');
const config = JSON.parse(fs.readFileSync(path.join(root,'private','local-library.json'),'utf8'));
const api = library(config, localAdapter(root));
const pages = new Map([['/',['library.html','text/html']],['/library.js',['library.js','text/javascript']],['/library.css',['library.css','text/css']]]);
const server = http.createServer(async (req,res) => {
  try {
    if (!pages.has(req.url)) return await api(req,res);
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || req.method !== 'GET') {res.writeHead(403); return res.end();}
    const [name,mime] = pages.get(req.url);
    res.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`, 'Cache-Control':'no-store','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'","Referrer-Policy":"no-referrer"});
    res.end(fs.readFileSync(path.join(root,'public',name)));
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
server.listen(Number(process.env.LIBRARY_PORT || 0),'127.0.0.1',() => console.log(`http://127.0.0.1:${server.address().port}/`));
