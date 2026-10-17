import test from 'node:test';
import assert from 'node:assert/strict';
import {changeRequest} from '../public/change-request.js';
function harness(t,api=async()=>({result:{id:'job',reviewId:'one',kind:'fix',status:'running'}})){
  const elements=new Proxy({},{get:(target,key)=>target[key] ||= {value:'',hidden:false}}),calls=[];
  globalThis.document={getElementById:id=>elements[id]};t.after(()=>delete globalThis.document);
  const state={status:'ready',record:{id:'one'},agent:{provider:'codex'}};
  const flow={flush:async()=>true,getContext:()=>({location:'/tutorials',heading:'Tutorials'})};
  let closed=false;
  const view=changeRequest({api:async(path,data)=>{calls.push({path,data});return api(path,data);},getState:()=>state,getSide:()=>'changed',workflow:flow,poll:async()=>{},close:()=>{closed=true;}});
  view.render();return {elements,calls,state,flow,view,closed:()=>closed};
}
test('plain request submits once with page context and opens the exact completed fix',async t=>{
  const h=harness(t),e=h.elements;assert.equal(e['make-changes'].disabled,true);
  e['change-request'].value='Make the button red';e['change-request'].oninput();
  await Promise.all([e['make-changes'].onclick(),e['make-changes'].onclick()]);
  assert.equal(h.calls.length,1);assert.match(h.calls[0].data.requestText,/Make the button red/);assert.match(h.calls[0].data.requestText,/\/tutorials/);
  assert.match(e['change-status'].textContent,/making your changes/);assert.equal(e['review-changes'].hidden,true);
  h.view.render([{id:'job',reviewId:'other',kind:'fix',status:'succeeded',resultCommit:'wrong'}]);assert.equal(e['review-changes'].hidden,true);
  h.view.render([{id:'job',reviewId:'one',kind:'fix',status:'succeeded',branch:'fix',commit:'old',resultCommit:'new'}]);
  assert.equal(e['review-changes'].hidden,false);await e['review-changes'].onclick();
  assert.deepEqual(h.calls[1],{path:'/api/start',data:{ref:'refs/heads/fix',fixJob:'job'}});assert.equal(h.closed(),true);
});
test('failed send preserves request and branch changes never leak drafts or job status',async t=>{
  const h=harness(t,async()=>{throw Error('CLI disconnected');}),e=h.elements;
  e['change-request'].value='Red button';e['change-request'].oninput();await e['make-changes'].onclick();
  assert.equal(e['change-request'].value,'Red button');assert.match(e['change-status'].textContent,/CLI disconnected/);
  h.state.record={id:'two'};h.view.render();assert.equal(e['change-request'].value,'');assert.equal(e['change-status'].textContent,'');
  h.state.record={id:'one'};h.view.render();assert.equal(e['change-request'].value,'Red button');
});
test('failed note save or review switch during flush never starts a job',async t=>{
  const h=harness(t),e=h.elements;e['change-request'].value='Red button';e['change-request'].oninput();
  h.flow.flush=async()=>false;await e['make-changes'].onclick();assert.equal(h.calls.length,0);
  h.flow.flush=async()=>{h.state.record={id:'two'};return true;};await e['make-changes'].onclick();assert.equal(h.calls.length,0);
});
