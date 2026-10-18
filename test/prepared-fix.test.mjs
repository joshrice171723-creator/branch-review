import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
const readySource=source.slice(source.indexOf('async function readyFix('),source.indexOf('async function startCandidate('));
test('prepared fix checks remote main, source, clean checkouts and live identities before reuse',async()=>{
 async function check(overrides={}){
  const cached={ref:'refs/heads/fix',priorId:'prior',selected:{branch:{sha:'new'}},integration:{main:'main'},original:{sha:'old',runtime:'changed'},changed:{sha:'new',runtime:'original'}};
  const context={displayDefaultBranch:null,preparedFix:cached,state:{recordId:'prior'},previewRoot:'/previews',path:{join:(...parts)=>parts.join('/')},defaultBranch:async()=> 'main',fetch:()=>{},webHealthy:()=>{},
   git:async command=>command==='rev-parse'?(overrides.source || 'new'):(overrides.main || 'main')+'\trefs/heads/main',
   run:async(_,args,{cwd})=>args[0]==='status'?(overrides.dirty || ''):cwd.endsWith('/changed')?'old':(overrides.head || 'new'),
   previewHealth:async()=>({sides:{original:{ok:true},changed:{ok:!overrides.unhealthy}}})};
  vm.createContext(context);vm.runInContext(readySource+';globalThis.readyFix=readyFix;',context);
  const result=await context.readyFix(cached.ref,'prior');assert.equal(context.preparedFix,result?cached:null);return result;
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


test('prepared page opens while final checks run, without an editable review; failed checks fall back',async()=>{
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const item={id:'latest',path:'/demo'},other={id:'old',path:'/other'};
 const cached={ref:'fix',priorId:'prior',combined:{plan:{scenarios:[other,item]}},item,original:{sha:'old'},changed:{sha:'new'}};
 const context={displayDefaultBranch:null,preparedFix:cached,project:{},state:{recordId:'prior',status:'ready'},readyFix:()=>gate,progress:()=>{},
  comparison:async()=>{throw Error('normal preparation required');}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function startCandidate('),source.indexOf('async function activate('))+';globalThis.startCandidate=startCandidate;',context);
 const opening=context.startCandidate('fix','prior');
 assert.equal(context.state.status,'preview-ready');assert.equal(context.state.recordId,null);
 assert.equal(context.state.changed.sha,'new');assert.equal(context.state.manifest.scenarios[0].id,'latest');
 release(null);await assert.rejects(opening,/normal preparation required/);
 assert.equal(context.state.status,'preparing');assert.equal(context.preparedFix,null);
});

test('health and checkout checks start while default branch lookup is pending',async()=>{
 let release,healthStarted=false,checkoutStarted=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const cached={ref:'fix',priorId:'prior',selected:{branch:{sha:'new'}},integration:{main:'main'},original:{sha:'old',runtime:'original'},changed:{sha:'new',runtime:'changed'}};
 const context={displayDefaultBranch:null,preparedFix:cached,state:{recordId:'prior'},previewRoot:'/previews',path:{join:(...parts)=>parts.join('/')},defaultBranch:()=>gate,fetch:()=>{},webHealthy:()=>{},
 git:async command=>command==='rev-parse'?'new':'main refs/heads/main',
 run:async(_,args,{cwd})=>{checkoutStarted=true;return args[0]==='status'?'':cwd.endsWith('original')?'old':'new';},
 previewHealth:async()=>{healthStarted=true;return {sides:{original:{ok:true},changed:{ok:true}}};}};
 vm.createContext(context);vm.runInContext(readySource+';globalThis.readyFix=readyFix;',context);
 const checking=context.readyFix('fix','prior');assert.ok(healthStarted);assert.ok(checkoutStarted);
 release('main');assert.equal(await checking,cached);
});


test('a moved fix job cannot activate even when its prepared page is visible',async()=>{
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const item={id:'latest',path:'/demo'};
 const cached={ref:'fix',priorId:'prior',combined:{plan:{scenarios:[item]}},item,original:{sha:'old'},changed:{sha:'new'}};
 const context={preparedFix:cached,project:{},state:{recordId:'prior',status:'ready'},readyFix:async()=>cached,git:()=>gate,progress:()=>{}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function startCandidate('),source.indexOf('async function activate('))+';globalThis.startCandidate=startCandidate;',context);
 const opening=context.startCandidate('fix','prior','expected');
 assert.equal(context.state.status,'preview-ready');assert.equal(context.state.recordId,null);
 release('moved');await assert.rejects(opening,/unchanged, committed fix/);
 assert.equal(context.state.recordId,null);
});
