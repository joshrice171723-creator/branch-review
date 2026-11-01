import http from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';

const root=await realpath(process.argv[2]);
const port=Number(process.argv[3]);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('A valid preview port is required.');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.woff':'font/woff','.woff2':'font/woff2'};
http.createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname.split('/').some(part=>part.startsWith('.')) || pathname.includes('\\') || pathname.includes('\0'))throw Error('Invalid path');
    let file=await realpath(path.resolve(root,'.'+pathname));
    if(file!==root && !file.startsWith(root+path.sep))throw Error('Outside project');
    if((await stat(file)).isDirectory())file=await realpath(path.join(file,'index.html'));
    if(!file.startsWith(root+path.sep) || path.relative(root,file).split(path.sep).some(part=>part.startsWith('.')))throw Error('Outside project');
    const data=await readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1');
