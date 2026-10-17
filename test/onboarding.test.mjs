import test from 'node:test';
import assert from 'node:assert/strict';
import {onboarding} from '../public/onboarding.js';

test('setup blocks incomplete checks, retries, saves completion and leaves existing projects alone',async t=>{
  const node=()=>({disabled:false,open:false,append(){},setAttribute(){},replaceChildren(...rows){this.rows=rows;},showModal(){this.open=true;},close(){this.open=false;}});
  const elements={},created=[];
  globalThis.document={body:node(),getElementById:id=>elements[id] ||= node(),createElement:()=>{const item=node();created.push(item);return item;}};
  t.after(()=>delete globalThis.document);
  let needed=false,ready=false,saved=0,refreshed=0;
  const view=onboarding({settings(){},refresh:async()=>refreshed++,api:async(path,data)=>{
    if(path==='/api/diagnostics')return [{name:'Remote',ok:ready,message:ready?'Configured':'Add origin'}];
    if(data){saved++;return {ready:true};}
    return {needed,project:{name:'Demo'},repository:'/demo'};
  }});
  await view.initialize();assert.equal(created[0].open,false);
  needed=true;await view.initialize();assert.equal(created[0].open,true);assert.equal(elements['onboarding-done'].disabled,true);
  await elements['onboarding-done'].onclick();assert.equal(saved,0);
  ready=true;await elements['onboarding-retry'].onclick();assert.equal(elements['onboarding-done'].disabled,false);
  await elements['onboarding-done'].onclick();assert.equal(saved,1);assert.equal(refreshed,1);assert.equal(created[0].open,false);
});
