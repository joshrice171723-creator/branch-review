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

test('the project workspace mounts once and retains conversation during Branch Review', async t => {
  const origin='http://127.0.0.1:4310';
  const calls=[], mounts=[], messages=[], visibility=[];
  const nodes=new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id,{hidden:true,dataset:{},setAttribute(){},replaceChildren(){},append(){}});
    return nodes.get(id);
  }
  globalThis.location=new URL(origin);
  globalThis.document={getElementById:element};
  globalThis.window={};
  t.after(()=>{delete globalThis.document;delete globalThis.window;delete globalThis.location;});
  const panel=apexPanel({getState:()=>({}),openBranch:async()=>true,flush:async()=>true,
    loadPanel:async()=>({mount:async(node,options)=>{
      mounts.push({node,options});
      return {setVisible:value=>visibility.push(value),openConversation:input=>messages.push(input)};
    }}),
    api:async(route)=>{
      calls.push(route);
      if(route==='/api/workbench') return {project:'/trusted/project',installed:true};
      if(route==='/api/workbench-open') return {result:{src:'/__workbench/',managed:true}};
      throw Error('Unexpected route '+route);
    }});
  const context={kind:'branch-review',commit:'a'.repeat(40),ref:'refs/heads/design',scenarioId:'example'};
  await Promise.all([panel.open(),panel.openChat(context)]);
  assert.deepEqual(calls,['/api/workbench','/api/workbench-open']);
  assert.equal(mounts[0].node,element('factory-view'));
  assert.equal(mounts[0].options.base,origin+'/__workbench/');
  assert.deepEqual(messages,[context]);
  assert.equal(element('review-workspace').hidden,true);
  element('open-project-qa').onclick();
  assert.equal(element('review-workspace').hidden,false);
  await panel.openChat(context);
  await panel.open();
  assert.equal(mounts.length,1);
  assert.deepEqual(visibility,[true,false,true]);
  assert.deepEqual(messages,[context,context]);
});
