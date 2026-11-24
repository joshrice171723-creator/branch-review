import test from 'node:test';
import assert from 'node:assert/strict';
import {apexPanel} from '../public/apex-panel.js';
import {workspaceRenderer} from '../workbench/renderer.mjs';

test('the project workspace mounts once and retains conversation during Branch Review', async t => {
  const origin='http://127.0.0.1:4310';
  const calls=[], mounts=[], messages=[], visibility=[];
  let branchRefreshes=0;
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
    refreshBranches:async()=>{branchRefreshes++;},
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
  assert.equal(branchRefreshes,0);
  element('open-project-qa').onclick();
  assert.equal(element('review-workspace').hidden,false);
  assert.equal(branchRefreshes,1);
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

test('blocked review keeps Retry verification available until the same run passes export', async t => {
  const nodes = new Map();
  function node() {
    return {dataset:{}, setAttribute(){}, children:[], append(...items){this.children.push(...items);},
      replaceChildren(...items){this.children = items;}};
  }
  globalThis.document = {createElement:node, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  }};
  globalThis.window = {};
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  const opened = [];
  let retries = 0, exports = 0;
  const runId = 'completed-run';
  const panel = apexPanel({getState:() => ({}), openBranch:async (_, id) => { opened.push(id); return true; },
    reportError:assert.fail, api:async (route, payload) => {
      if (route === '/api/workbench-export') {
        exports++;
        assert.deepEqual(payload, {runId});
        if (retries < 2) throw Object.assign(Error('The preview address changed.'), {code:'REVIEW_VERIFICATION_REQUIRED'});
        return {result:{ref:'refs/heads/change', commit:'abc', title:'Greeting'}};
      }
      if (route === '/api/workspace/design') return {builds:[{id:'build', status:'review', attempts:[{task:runId}]}]};
      assert.equal(route, '/api/workspace/design/retry-verification');
      assert.deepEqual(payload, {build:'build', runId});
      if (++retries === 1) throw Error('Required after check failed: browser');
    }});
  await assert.rejects(panel.inspect(runId), /preview address changed/);
  const status = nodes.get('apex-panel-status');
  const retry = status.children.at(-1);
  assert.equal(retry.textContent, 'Retry verification');
  await retry.onclick();
  assert.match(status.children[0], /Required after check failed: browser/);
  assert.equal(status.children.at(-1), retry);
  assert.equal(retry.disabled, false);
  assert.equal(exports, 1);
  assert.deepEqual(opened, []);
  await retry.onclick();
  assert.equal(exports, 2);
  assert.deepEqual(opened, [runId]);
});
