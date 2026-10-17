import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
const readySource=source.slice(source.indexOf('async function readyFix('),source.indexOf('async function startCandidate('));
test('prepared fix checks remote main, source, clean checkouts and live identities before reuse',async()=>{
 async function check(overrides={}){
  const cached={ref:'refs/heads/fix',priorId:'prior',selected:{branch:{sha:'new'}},integration:{main:'main'},original:{sha:'old',runtime:'changed'},changed:{sha:'new',runtime:'original'}};
  const context={preparedFix:cached,state:{recordId:'prior'},previewRoot:'/previews',path:{join:(...parts)=>parts.join('/')},defaultBranch:async()=> 'main',fetch:()=>{},webHealthy:()=>{},
   git:async command=>command==='rev-parse'?(overrides.source || 'new'):(overrides.main || 'main')+'\trefs/heads/main',
   run:async(_,args,{cwd})=>args[0]==='status'?(overrides.dirty || ''):cwd.endsWith('/changed')?'old':(overrides.head || 'new'),
   previewHealth:async()=>({sides:{original:{ok:true},changed:{ok:!overrides.unhealthy}}})};
  vm.createContext(context);vm.runInContext(readySource+';globalThis.readyFix=readyFix;',context);
  const result=await context.readyFix(cached.ref,'prior');assert.equal(context.preparedFix,null);return result;
 }
 assert.ok(await check());
 for(const bad of [{source:'moved'},{main:'moved'},{dirty:' M button.css'},{head:'moved'},{unhealthy:true}])assert.equal(await check(bad),null);
});
test('preparing a fix uses only the unused runtime and leaves the active preview pair intact',async()=>{
 const prior={id:'prior',identity:{changed:'old'},manifest:{scenarios:[]}};
 const state={status:'ready',recordId:'prior',original:{runtime:'original',sha:'base'},changed:{runtime:'changed',sha:'old'}};
 const snapshot=JSON.stringify(state),prepared=[];
 const context={preparedFix:null,state,slots:{original:{proxy:1},changed:{proxy:2},standby:{}},
  comparison:async()=>({branch:{sha:'new'}}),delivery:{prepare:async()=>({sha:'new',main:'main'})},git:async()=> 'button.css',
  appearanceFixPlan:async()=>({scenarios:[]}),colorFixPlan:async()=>null,candidateComparison:async()=>({files:['button.css']}),mergeFixPlan:(_,plan)=>plan,
  prepare:async(runtime,sha)=>{prepared.push(runtime);return{runtime,sha};},plans:{save:async()=>{}},digest:()=> 'key'};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function warmFix('),source.indexOf('async function readyFix('))+';globalThis.warmFix=warmFix;',context);
 const job={branch:'fix',resultCommit:'new'};await context.warmFix(job,prior);
 assert.deepEqual(prepared,['standby']);assert.equal(JSON.stringify(state),snapshot);assert.equal(job.previewReady,true);assert.equal(context.preparedFix.original.sha,'old');
});
