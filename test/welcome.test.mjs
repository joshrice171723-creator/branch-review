import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../desktop/welcome.js',import.meta.url),'utf8');
async function screen({agent='ready',git=true}){
  const nodes=new Map(),document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:id==='agent'?'codex':'',hidden:true,disabled:false,addEventListener(){},replaceChildren(){}});return nodes.get(id);}};
  const welcome={probe:async()=>({status:agent,message:'Connection unavailable'}),git:async()=>git};
  vm.runInNewContext(source,{document,window:{welcome},Promise});await new Promise(resolve=>setImmediate(resolve));return Object.fromEntries(nodes);
}
test('first run only shows relevant prerequisite help and enables chat when ready',async()=>{
  const ready=await screen({});assert.equal(ready['chat-send'].disabled,false);assert.equal(ready['agent-help'].hidden,true);assert.equal(ready['git-help'].hidden,true);
  const missingGit=await screen({git:false});assert.equal(missingGit['chat-send'].disabled,true);assert.equal(missingGit['agent-help'].hidden,true);assert.equal(missingGit['git-help'].hidden,false);
  const missingAgent=await screen({agent:'missing'});assert.equal(missingAgent['chat-send'].disabled,true);assert.equal(missingAgent['agent-help'].hidden,false);assert.equal(missingAgent['git-help'].hidden,true);
});
