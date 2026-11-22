import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const script=await readFile(new URL('../desktop/welcome.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function screen(git,probe){
  const nodes=new Map(), openings=[];
  function get(id){
    if(!nodes.has(id))nodes.set(id,{value:'codex',events:{},addEventListener(name,listener){this.events[name]=listener;}});
    return nodes.get(id);
  }
  runInNewContext(script,{document:{getElementById:get},window:{welcome:{git,probe,choose:async (...args)=>openings.push(args)}}});
  return {get,openings};
}

test('Git enables repository selection while the coding agent is still checking or signed out',async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const {get,openings}=screen(async()=>true,()=>pending);
  await tick();
  assert.equal(get('choose').disabled,false);
  assert.equal(get('chat-send').disabled,true);
  finish({status:'sign-in'});
  await tick();
  assert.equal(get('choose').disabled,false);
  assert.match(get('agent-status').textContent,/Sign in to Codex to use agent features/);
  await get('choose').events.click();
  assert.deepEqual(openings,[['codex',undefined]]);
});

test('a connected agent does not bypass the Git requirement',async()=>{
  const {get}=screen(async()=>false,async()=>({status:'ready'}));
  await tick();
  assert.equal(get('choose').disabled,true);
  assert.equal(get('chat-send').disabled,true);
  assert.equal(get('git-help').hidden,false);
});
