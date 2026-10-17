import test from 'node:test';
import assert from 'node:assert/strict';
import {workbench} from '../public/workbench.js';

test('Office opens only after exact published-build verification succeeds',async t=>{
  const elements=new Proxy({}, {get(target,id){return target[id] ||= {hidden:false,disabled:false};}});
  globalThis.document={getElementById:id=>elements[id]};
  const opened=[],calls=[];
  globalThis.window={desktop:{openPublished:async url=>opened.push(url)}};
  t.mock.method(globalThis,'setInterval',()=>0);
  t.after(()=>{delete globalThis.document;delete globalThis.window;});
  const state={status:'ready',busy:false,publishTarget:'https://aimetaclinic.com',record:{id:'review',delivery:{stage:'pushed'},manifest:{scenarios:[]}}};
  let failure=false;
  const tools=workbench({getState:()=>state,getSide:()=> 'changed',workflow:{getContext:()=>({})},poll:async()=>{},error:()=>{},reopen:()=>{},api:async(path,data)=>{calls.push({path,data});if(failure)throw Error('The published revision differs from this review.');}});
  elements['tools-dialog'].open=true;
  tools.render(state);assert.equal(elements['published-office'].hidden,true);
  state.record.delivery.stage='published';tools.render(state);assert.equal(elements['published-office'].hidden,false);
  await elements['published-office'].onclick();
  assert.deepEqual(calls,[{path:'/api/published-review',data:{id:'review',action:'start'}}]);
  assert.deepEqual(opened,['https://aimetaclinic.com/qa?view=office']);
  failure=true;await elements['published-office'].onclick();
  assert.equal(opened.length,1);assert.match(elements['tools-status'].textContent,/revision differs/);
  state.busy=true;tools.render(state);assert.equal(elements['published-office'].disabled,true);
});
