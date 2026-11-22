import test from 'node:test';
import assert from 'node:assert/strict';
import {apexPanel} from '../public/apex-panel.js';
import {workspaceRenderer} from '../workbench/renderer.mjs';

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
    loadPanel:async(source)=>({mount:async(node,options)=>{
      mounts.push({node,options,source});
      return {setVisible:value=>visibility.push(value),openConversation:input=>messages.push(input)};
    }}),
    api:async(route)=>{
      calls.push(route);
      if(route==='/api/workbench') return {project:'/trusted/project',installed:true};
      if(route==='/api/workbench-open') return {result:{src:'/workspace/',managed:true}};
      throw Error('Unexpected route '+route);
    }});
  const context={kind:'branch-review',commit:'a'.repeat(40),ref:'refs/heads/design',scenarioId:'example'};
  await Promise.all([panel.open(),panel.openChat(context)]);
  assert.deepEqual(calls,['/api/workbench','/api/workbench-open']);
  assert.equal(mounts[0].node,element('factory-view'));
  assert.equal(mounts[0].source,origin+'/workspace.js');
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

test('the native workspace module binds only Branch Review routes',async()=>{
  const {source}=await workspaceRenderer();
  assert.match(source,/export async function mount/);
  assert.match(source,/api\/workspace/);
  assert.doesNotMatch(source,/__workbench\/|window\.parent\.postMessage/);
});
