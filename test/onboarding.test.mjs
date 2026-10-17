import test from 'node:test';
import assert from 'node:assert/strict';
import {onboarding} from '../public/onboarding.js';

test('setup blocks incomplete checks, retries, saves completion and leaves existing projects alone',async t=>{
  const node=()=>({disabled:false,open:false,parentElement:{insertBefore(){}},insertBefore(){},append(){},setAttribute(){},replaceChildren(...rows){this.rows=rows;},showModal(){this.open=true;},close(){this.open=false;}});
  const elements={},created=[];
  globalThis.document={body:node(),getElementById:id=>elements[id] ||= node(),createElement:()=>{const item=node();created.push(item);return item;}};
  t.after(()=>delete globalThis.document);
  let needed=false,ready=false,saved=0,refreshed=0,provider='codex',fetched=0,rejectProvider=false;
  const view=onboarding({settings(){},refresh:async()=>refreshed++,api:async(path,data)=>{
    if(path==='/api/diagnostics')return [{name:'Remote',ok:ready,message:ready?'Configured':'Add origin'}];
    if(path==='/api/agent-settings'){if(rejectProvider)throw Error('Agent busy');provider=data.provider;ready=provider==='codex';return {};}
    if(path==='/api/fetch'){fetched++;ready=true;return {};}
    if(path==='/api/state')return {busy:false};
    if(data){saved++;return {ready:true};}
    return {needed,agent:{provider},project:{name:'Demo'},repository:'/demo'};
  }});
  await view.initialize();assert.equal(created[0].open,false);
  needed=true;await view.initialize();assert.equal(created[0].open,true);assert.equal(elements['onboarding-done'].disabled,true);
  await elements['onboarding-done'].onclick();assert.equal(saved,0);
  await created.find(item=>item.id==='onboarding-fetch').onclick();assert.equal(fetched,1);assert.equal(elements['onboarding-done'].disabled,false);
  const agent=created.find(item=>item.id==='onboarding-agent');agent.value='claude';await agent.onchange();
  assert.equal(provider,'claude');assert.equal(elements['onboarding-done'].disabled,true);
  rejectProvider=true;agent.value='codex';await agent.onchange();assert.equal(agent.value,'claude');assert.equal(elements['onboarding-status'].textContent,'Agent busy');
  rejectProvider=false;agent.value='codex';await agent.onchange();assert.equal(elements['onboarding-done'].disabled,false);
  await elements['onboarding-done'].onclick();assert.equal(saved,1);assert.equal(refreshed,1);assert.equal(created[0].open,false);
});
