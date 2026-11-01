import net from 'node:net';
import path from 'node:path';
import {readFile} from 'node:fs/promises';

export async function freePort(port=0) {
  const server=net.createServer();
  return new Promise((resolve,reject)=>{
    server.once('error',error=>error.code==='EADDRINUSE'?resolve(null):reject(error));
    server.listen(port,'127.0.0.1',()=>{const assigned=server.address().port;server.close(error=>error?reject(error):resolve(assigned));});
  });
}

// A listener without this checkout's ownership record must never be stopped.
export async function recoverPreviewPorts(cwd,slot,{probe=freePort,read=readFile}={}) {
  let collision=false;
  for(const role of ['api','web']) {
    if(await probe(slot[role])!==null)continue;
    const record=JSON.parse(await read(path.join(cwd,'tmp/dev/pids',role+'.pid'),'utf8').catch(error=>{if(error.code==='ENOENT')return 'null';throw error;}));
    if(!record || !Number.isSafeInteger(record.pid) || record.pid<=0 || record.role!==role || typeof record.root!=='string' || path.resolve(record.root)!==path.resolve(cwd))collision=true;
  }
  if(!collision)return false;
  const assigned=new Set();
  for(const role of ['api','web','postgres']) {
    let port;
    do {port=await probe(0);} while(port===null || assigned.has(port));
    assigned.add(port);slot[role]=port;
  }
  return true;
}
