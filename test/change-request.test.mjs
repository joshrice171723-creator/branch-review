import test from 'node:test';
import assert from 'node:assert/strict';
import {changeRequest} from '../public/change-request.js';
function harness(t,api=async()=>({result:{id:'job',reviewId:'one',kind:'fix',status:'running'}}),capture=async()=> 'data:image/png;base64,cG5n'){
  const elements=new Proxy({},{get:(target,key)=>target[key] ||= {value:'',hidden:false,showModal(){this.open=true;},close(){this.open=false;}}}),calls=[];
  globalThis.document={getElementById:id=>elements[id]};t.after(()=>delete globalThis.document);
  const state={status:'ready',record:{id:'one',identity:{base:'before',changed:'after'}},agent:{provider:'codex'}};
  const flow={flush:async()=>true,getContext:()=>({location:'/tutorials',heading:'Tutorials'})};
  let closed=false;
  const view=changeRequest({api:async(path,data)=>{calls.push({path,data});return api(path,data);},getState:()=>state,getSide:()=>'changed',workflow:flow,capture,poll:async()=>{},close:()=>{closed=true;}});
  view.render();return {elements,calls,state,flow,view,closed:()=>closed};
}
test('plain request submits once with page context and opens the exact completed fix',async t=>{
  const h=harness(t),e=h.elements;assert.equal(e['make-changes'].disabled,true);
  e['change-request'].value='Make the button red';e['change-request'].oninput();
  await Promise.all([e['make-changes'].onclick(),e['make-changes'].onclick()]);
  assert.equal(h.calls.length,1);assert.match(h.calls[0].data.requestText,/Make the button red/);assert.match(h.calls[0].data.requestText,/\/tutorials/);assert.deepEqual(h.calls[0].data.attachment,{side:'changed',commit:'after',location:'/tutorials',screenshot:'data:image/png;base64,cG5n'});
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

test('first change needs no existing review and opens the returned isolated branch',async t=>{
 const h=harness(t,async()=>({result:{id:'first',kind:'fix',status:'running'}})),e=h.elements;
 delete h.state.record;h.state.status='idle';h.view.render();assert.equal(e['checklist-advanced'].hidden,true);
 h.flow.flush=async()=>{throw Error('no review to save');};e['change-request'].value='Make the home page button green';e['change-request'].oninput();
 assert.equal(e['make-changes'].disabled,false);await e['make-changes'].onclick();
 assert.equal(h.calls[0].path,'/api/new-change');assert.match(h.calls[0].data.requestText,/remote default branch/);
 h.view.render([{id:'first',kind:'fix',status:'succeeded',branch:'first-change',commit:'old',resultCommit:'new'}]);
 await e['review-changes'].onclick();assert.deepEqual(h.calls[1].data,{ref:'refs/heads/first-change',fixJob:'first'});
});

test('navigation during screenshot capture stops submission and preserves the draft',async t=>{
 const h=harness(t),e=h.elements;
 e['change-request'].value='Remove brown shadow';e['change-request'].oninput();
 let count=0;h.flow.getContext=()=>({location:++count>3?'/other':'/tutorials'});
 await e['make-changes'].onclick();assert.equal(h.calls.length,0);assert.equal(e['change-request'].value,'Remove brown shadow');
});
test('selected area stays pinned and is included in the fix request',async t=>{const h=harness(t),e=h.elements;await h.view.open({location:'/tutorials',selector:'#cta',label:'Try sandbox',rect:{x:1,y:2,width:30,height:40}});assert.equal(e['change-composer'].hidden,false);e['change-request'].value='Blue';await e['make-changes'].onclick();assert.match(h.calls[0].data.requestText,/Selected area:.*#cta/);});
test('selected area cannot be sent after navigating elsewhere',async t=>{const h=harness(t),e=h.elements;await h.view.open({location:'/tutorials',selector:'#cta',label:'Try sandbox'});e['change-request'].value='Blue';h.flow.getContext=()=>({location:'/other'});await e['make-changes'].onclick();assert.equal(h.calls.length,0);assert.match(e['change-status'].textContent,/Right-click/);});

test('agent result stays visible for explicit review and failure retains recovery',async t=>{
 const h=harness(t),e=h.elements;
 h.view.render([{id:'job',reviewId:'one',kind:'fix',status:'succeeded',sameBranch:true,applied:true,branch:'demo',commit:'old',resultCommit:'new',result:'Changed the headline.',committedFiles:['Home.tsx']}]);
 assert.equal(e['agent-progress'].hidden,false);
 assert.equal(e['agent-progress-details'].open,false);
 e['agent-progress-details'].open=true;
 h.view.render([{id:'job',reviewId:'one',kind:'fix',status:'succeeded',commit:'old',resultCommit:'new',result:'Changed the headline.',committedFiles:['Home.tsx']}]);
 assert.equal(e['agent-progress-details'].open,true);
 assert.equal(e['agent-progress-review'].hidden,false);
 assert.equal(e['agent-progress-detail'].textContent,'Changed the headline.');
 assert.match(e['agent-progress-files'].textContent,/Home.tsx/);
 assert.equal(h.calls.length,0);
 h.view.render([{id:'job',reviewId:'one',kind:'fix',status:'failed',error:'CLI disconnected'}]);
 assert.equal(e['agent-progress-recovery'].hidden,false);
 assert.equal(e['agent-progress-details'].open,true);
 assert.equal(e['agent-progress-review'].hidden,true);
});


test('right-click popup shows the exact screenshot that is sent and closes after submission',async t=>{
 let captures=0;const screenshot='data:image/png;base64,cG9wdXA=';
 const h=harness(t,undefined,async()=>{captures++;return screenshot;}),e=h.elements;
 await h.view.open({location:'/tutorials',selector:'#cta',label:'Try sandbox'});
 assert.equal(e['change-composer'].open,true);assert.equal(e['change-screenshot'].src,screenshot);assert.equal(e['change-screenshot'].hidden,false);
 e['change-request'].value='Make this blue';await e['make-changes'].onclick();
 assert.equal(captures,1);assert.equal(h.calls[0].data.attachment.screenshot,screenshot);assert.equal(e['change-composer'].open,false);
});

test('request sends the flattened drawing and text rather than the original photo',async t=>{
 const h=harness(t),e=h.elements;await h.view.open({location:'/tutorials',selector:'#cta',label:'Try sandbox'});
 const ctx=new Proxy({measureText:()=>({width:100})},{get:(target,key)=>target[key]||(()=>{})});
 const canvas=e['change-photo-canvas'];canvas.getContext=()=>ctx;canvas.toDataURL=()=> 'data:image/png;base64,ZWRpdGVk';
 e['change-screenshot'].naturalWidth=1200;e['change-screenshot'].naturalHeight=600;e['change-screenshot'].onload();
 e['change-photo-tool'].value='text';e['change-photo-text'].value='Blue here';canvas.onkeydown({key:'Enter',preventDefault(){}});
 e['change-request'].value='Use the marked area';await e['make-changes'].onclick();assert.equal(h.calls[0].data.attachment.screenshot,'data:image/png;base64,ZWRpdGVk');
});
