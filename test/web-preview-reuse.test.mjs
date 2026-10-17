import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {WebPreviews,hotReloadable} from '../web-project.mjs';

test('hot updates exclude dependency, server and build configuration changes',()=>{
  for(const files of [[],['style.css'],['src/Button.tsx','public/logo.svg']])assert.equal(hotReloadable('vite',files),true);
  for(const files of [['package-lock.json'],['vite.config.ts'],['server.js'],['.env'],['src/Button.tsx','package.json']])assert.equal(hotReloadable('vite',files),false);
  assert.equal(hotReloadable('next',['app/page.tsx']),false);assert.equal(hotReloadable('next',['app/globals.css']),true);
  assert.equal(hotReloadable('custom',['style.css']),false);
});
test('healthy generic preview keeps its process and port while checkout changes; old identity becomes invalid',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'hot-preview-'));
  let body='blue',checkouts=0;
  const server=http.createServer((_,res)=>res.end(body));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port;
  const previews=new WebPreviews({local:directory,progress:()=>{},run:async(file,args)=>{assert.equal(file,'git');assert.equal(args[0],'diff');return 'style.css\0';}});
  const child={pid:null,exitCode:null,signalCode:null};
  previews.running.set('changed',{child,sha:'before',port,preview:{directory,kind:'vite',sha:'before',web:port}});
  const after=await previews.prepare('changed','after',directory,async()=>{checkouts++;body='green';});
  assert.equal(checkouts,1);assert.equal(after.web,port);assert.equal(previews.running.get('changed').child,child);
  assert.equal(await previews.healthy('changed','before'),false);assert.equal(await previews.healthy('changed','after'),true);
  assert.equal(await fetch('http://127.0.0.1:'+port).then(r=>r.text()),'green');
  await previews.prepare('changed','after',directory,async()=>{throw Error('already ready');});
});
