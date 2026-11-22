import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {projectPanel} from '../apex-panel.mjs';
import {apexPanel} from '../public/apex-panel.js';

test('external Workbench opens only when it serves the selected project',async t=>{
  const checkout=await realpath(await mkdtemp(path.join(os.tmpdir(),'workbench-external-')));
  t.after(()=>rm(checkout,{recursive:true,force:true}));
  const panelPath='/__workbench/p/0123456789abcdef0123/';
  let connectedProject=checkout;
  const external=createServer((req,res)=>{
    if(req.url==='/__workbench/') return res.writeHead(302,{Location:panelPath}).end();
    if(req.url===panelPath) return res.end('Workbench');
    if(req.url===panelPath+'api/state') return res.end(JSON.stringify({project:{path:connectedProject}}));
    res.writeHead(404).end();
  });
  t.after(()=>new Promise(resolve=>external.close(resolve)));
  await new Promise(resolve=>external.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+external.address().port;
  const panel=projectPanel(checkout,origin+'/__workbench/');
  assert.equal((await panel.prepare()).installed,false);
  assert.deepEqual(await panel.open(),{src:origin+panelPath,project:checkout,managed:false});
  await assert.rejects(access(path.join(checkout,'.harness')));
  connectedProject=path.dirname(checkout);
  await assert.rejects(panel.open(),/serves a different project/);
});

test('one Workbench open uses the selected project and sends chat context only to its ready iframe',async t=>{
  const origin='http://127.0.0.1:4310';
  const events={},calls=[],messages=[];
  const nodes=new Map();
  function element(id){
    if(!nodes.has(id)) nodes.set(id,{
      hidden:true,open:false,src:'',
      setAttribute(){},replaceChildren(){},append(){},
      showModal(){this.open=true;},close(){this.open=false;}
    });
    return nodes.get(id);
  }
  globalThis.location=new URL(origin);
  globalThis.document={getElementById:element,createElement:()=>({})};
  globalThis.window={addEventListener:(type,listener)=>{events[type]=listener;}};
  t.mock.method(globalThis,'setTimeout',()=>0);
  t.after(()=>{delete globalThis.document;delete globalThis.window;delete globalThis.location;});
  const frame=element('apex-panel-frame');
  frame.contentWindow={postMessage:(data,target)=>messages.push({data,target})};
  let failOpen=false;
  const panel=apexPanel({getState:()=>({}),openBranch:async()=>true,
    api:async(path,data)=>{
      calls.push({path,data});
      if(path==='/api/workbench') return {project:'/trusted/project',installed:false};
      if(path==='/api/workbench-prepare') return {result:{installed:true,managed:true}};
      if(path==='/api/workbench-open'){
        if(failOpen) throw Error('Workbench could not identify its project.');
        return {result:{src:'/__workbench/',managed:true}};
      }
      if(path==='/api/workbench-cleanup-preview') return {entries:[],bytes:0};
      throw Error('Unexpected API request: '+path);
    }});
  await panel.prepare();
  const context={kind:'branch-review',commit:'a'.repeat(40),ref:'refs/heads/design',scenarioId:'example'};
  await panel.openChat(context);
  assert.deepEqual(calls.map(row=>row.path),['/api/workbench-prepare','/api/workbench','/api/workbench-open']);
  assert.equal(element('apex-checkout').textContent,'Project checkout · /trusted/project');
  assert.equal(frame.src,origin+'/__workbench/');
  assert.equal(frame.hidden,false);
  assert.deepEqual(messages,[]);
  await events.message({source:frame.contentWindow,origin:'http://127.0.0.1:4320',data:{type:'workbench-chat-ready'}});
  assert.deepEqual(messages,[]);
  await events.message({source:frame.contentWindow,origin,data:{type:'workbench-chat-ready'}});
  assert.deepEqual(messages,[{data:{type:'workbench-chat-context',context},target:origin}]);
  await element('apex-cleanup-preview').onclick();
  assert.deepEqual(calls.at(-1),{path:'/api/workbench-cleanup-preview',data:undefined});
  assert.equal(element('apex-cleanup-status').textContent,'No managed files to clean.');
  failOpen=true;
  await panel.open();
  assert.equal(frame.hidden,true);
  assert.equal(frame.src,'about:blank');
  assert.equal(element('retry-apex-panel').hidden,false);
  failOpen=false;
  await element('retry-apex-panel').onclick();
  assert.equal(frame.hidden,false);
  assert.equal(frame.src,origin+'/__workbench/');
});
