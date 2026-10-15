import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {PlanStore,retestAdvice,branchUpdate,branchRelationships} from '../plans.mjs';
import {ReviewStore,validateManifest} from '../reviews.mjs';
import {nextItem} from '../public/review-model.js';
import {pixelDifference} from '../public/evidence-tools.js';
import {ReviewJobs,scrub,configuredChecks} from '../jobs.mjs';
import {publishedAction,publishedComplete} from '../published-review.mjs';
import {reviewToolsBridge} from '../review-tools-bridge.mjs';

const sha='b'.repeat(40),base='a'.repeat(40);
const manifest=validateManifest({version:2,summary:'Change',scenarios:[{id:'one',title:'One',path:'/qa',steps:['Verify row'],files:['apps/api/qa.rb']},{id:'two',title:'Two',path:'/qa',steps:['Verify control'],viewport:'phone'},{id:'three',title:'Three',path:'/qa',steps:['Verify status']}]});
const snapshot={repository:'repo',comparison:{branch:{ref:'refs/heads/feature',sha,subject:'Change'}},original:{sha:base},changed:{sha}};
async function fixture(){const directory=await mkdtemp(path.join(os.tmpdir(),'branch-review-tools-')),store=await new ReviewStore(directory).load(),record=await store.open(snapshot,manifest,'recipe');return{directory,store,record};}

test('edited plans are pinned to exact commits and new requirements cannot inherit approval',async()=>{
  const {directory,store,record}=await fixture(),plans=new PlanStore(directory);
  for(const item of manifest.scenarios)await store.check(record.id,item.id,0,true);await store.approve(record.id,'Reviewer');
  const edited=structuredClone(manifest);edited.scenarios[0].steps.push('New requirement');await plans.save(sha,edited);
  assert.deepEqual(await plans.get(sha),edited);assert.equal(await plans.get(base),null);
  const next=await store.open(snapshot,await plans.get(sha),'recipe');assert.notEqual(next.id,record.id);assert.deepEqual(next.checks,{});assert.equal(next.approval,null);assert.ok(store.get(record.id).approval);
  await assert.rejects(plans.save('../escape',edited));assert.throws(()=>validateManifest({...manifest,scenarios:[{...manifest.scenarios[0],files:['../escape']}]}));
});
test('fix-only traversal skips unrelated incomplete items; advice keeps unknown impact explicit',async()=>{
  const {record}=await fixture();record.items={one:{outcome:'needs-fixes',reason:'Wrong'},three:{outcome:'blocked',reason:'Unavailable'}};
  assert.equal(nextItem(record,'one','attention'),'three');assert.equal(nextItem(record,'three','attention'),null);assert.equal(nextItem(record,'one'),'two');
  const advice=retestAdvice(record,manifest,['apps/api/qa.rb']);assert.equal(advice[0].priority,'first');assert.match(advice[1].reason,/Impact unknown/);assert.equal(advice[2].priority,'first');assert.equal(advice[0].previousCommit,sha);
});
test('branch updates are compared from the reviewed source and include exact new commit',async()=>{
  const {record}=await fixture(),calls=[];const git=async(...args)=>{calls.push(args);if(args[0]==='rev-parse')return'c'.repeat(40);if(args[0]==='diff')return'apps/api/qa.rb\0';if(args[0]==='log')return'ccccccc Fix';if(args[0]==='ls-tree')return'.branch-review.json';if(args[0]==='show')return JSON.stringify(manifest);throw Error(args.join(' '));};
  const update=await branchUpdate(git,record);assert.equal(update.changed,true);assert.equal(update.latest,'c'.repeat(40));assert.equal(calls.find(call=>call[0]==='diff')[3],record.identity.source);assert.equal(update.recommendations[0].priority,'first');
});
test('branch relationships distinguish included commits from overlapping independent work',async()=>{
  const inventory=[{ref:'feature',sha:'b',merged:false},{ref:'dependency',sha:'a',merged:false},{ref:'other',sha:'c',merged:false}];
  const git=async(...args)=>args[0]==='rev-parse'?'main':args[0]==='merge-base'?(args[1]==='main'?'base':args[2]==='a'?'a':'base'):'shared.js\0';
  const result=await branchRelationships(git,inventory,'feature');assert.equal(result.related[0].relation,'included dependency');assert.equal(result.related[1].relation,'independent history');assert.deepEqual(result.related[1].overlap,['shared.js']);
});
test('visual differences exclude masked pixels and reject mismatched viewports',()=>{
  const a={width:2,height:1,data:new Uint8ClampedArray([0,0,0,255,0,0,0,255])},b={...a,data:new Uint8ClampedArray([255,0,0,255,0,0,0,255])};
  assert.equal(pixelDifference(a,b).percent,50);const masked=pixelDifference(a,b,[{x:0,y:0,width:1,height:1}]);assert.equal(masked.percent,0);assert.equal(masked.total,1);assert.throws(()=>pixelDifference(a,{...b,width:3}));
});
test('structured evidence redaction preserves valid data and removes credentials',()=>{
  const data=scrub({token:'secret',message:'Authorization: Bearer abc',nested:{password:'secret'},list:['api_key=private','safe']});assert.equal(data.token,'[redacted]');assert.equal(data.nested.password,'[redacted]');assert.doesNotMatch(JSON.stringify(data),/private|secret|Bearer abc/);assert.equal(data.list[1],'safe');
});
test('check discovery only returns configured supported script names',async()=>{
  const checks=await configuredChecks(async(_show,spec)=>{if(spec.endsWith('apps/web/package.json'))return JSON.stringify({packageManager:'pnpm@11',scripts:{test:'vitest run',dev:'vite',deploy:'upload'}});throw Error('Missing');},sha);assert.deepEqual(checks.map(check=>check.name),['test']);assert.equal(checks[0].manager,'pnpm');
});
test('job recovery marks interrupted work without claiming completion',async()=>{
  const {directory}=await fixture();await writeFile(path.join(directory,'jobs.json'),JSON.stringify([{id:'job',status:'running',kind:'fix'}]));const jobs=await new ReviewJobs(directory,{}).load();assert.equal(jobs.rows[0].status,'interrupted');assert.match(jobs.rows[0].error,/Inspect its worktree/);assert.equal(JSON.parse(await readFile(path.join(directory,'jobs.json'),'utf8'))[0].status,'interrupted');
});
test('configured checks execute and persist their output; dirty previews cannot start work',async()=>{
  const {directory,record}=await fixture();
  await writeFile(path.join(directory,'package.json'),JSON.stringify({scripts:{test:'node -e "console.log(12345)"'}}));
  let dirty=false;
  const jobs=await new ReviewJobs(directory,{git:async()=>JSON.stringify({scripts:{test:'node -e "console.log(12345)"'}}),run:async(_cmd,args)=>args[0]==='rev-parse'?sha:dirty?' M file.js':'',changedCwd:()=>directory,toolchain:path.dirname(process.execPath)}).load();
  const job=await jobs.start(record,'check',{check:'.:test'});
  const deadline=Date.now()+15000;
  while(!job.finishedAt && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
  await jobs.saving;
  assert.equal(job.status,'succeeded',job.error);assert.match(job.log,/12345/);
  assert.equal(JSON.parse(await readFile(path.join(directory,'jobs.json'),'utf8'))[0].status,'succeeded');
  dirty=true;await assert.rejects(jobs.start(record,'check',{check:'.:test'}),/exact clean/);
});
test('published checks are separate from local passes and refuse a moved deployment',async()=>{
  const {store,record}=await fixture();record.delivery={stage:'published'};for(const item of manifest.scenarios)record.checks[`${item.id}:0`]=true;
  const fetcher=async()=>({ok:true,json:async()=>({revision:sha})});await publishedAction(store,record,{action:'start'},fetcher);assert.equal(publishedComplete(record),false);
  for(const item of manifest.scenarios)await publishedAction(store,record,{action:'check',itemId:item.id,index:0,passed:true},fetcher);assert.equal(publishedComplete(record),true);
  await assert.rejects(publishedAction(store,record,{action:'check',itemId:'one',index:0,passed:false},async()=>({ok:true,json:async()=>({revision:base})})),/differs/);assert.equal(publishedComplete(record),true);
  record.delivery.stage='verified';await publishedAction(store,record,{action:'check',itemId:'one',index:0,passed:false},fetcher);assert.equal(record.delivery.stage,'published');assert.equal(record.checks['one:0'],true);
});
test('recordings stay attached to their version and reject invalid media',async()=>{
  const {store,record,directory}=await fixture(),input={scenario:'one',side:'original',expected:'Visible',actual:'Missing',video:'data:video/webm;base64,'+Buffer.from('1a45dfa300000000','hex').toString('base64')};
  await store.issue(record.id,input);assert.equal(record.issues[0].commit,base);assert.ok(await readFile(path.join(directory,'recordings',record.issues[0].video)));await assert.rejects(store.issue(record.id,{...input,video:'data:text/html;base64,AAAA'}),/WebM/);
});
test('preview replay rejects foreign parents and stops before a mismatched route',async()=>{
  const handlers={},messages=[],parent={postMessage:value=>messages.push(value)},document={querySelectorAll:()=>[],querySelector:()=>null};
  function XHR(){}XHR.prototype.open=()=>{};XHR.prototype.send=()=>{};
  const context={parent,document,location:{pathname:'/qa',search:'',hash:''},window:{fetch:async()=>({ok:true})},XMLHttpRequest:XHR,addEventListener:(event,handler)=>{handlers[event]=handler;},setInterval:()=>{},URL,innerHeight:800};
  vm.runInNewContext(`(${reviewToolsBridge.toString()})('http://review')`,context);messages.length=0;
  await handlers.message({source:{},origin:'http://review',data:{type:'review:tool',id:'x',command:'record',data:true}});assert.equal(messages.length,0);
  await handlers.message({source:parent,origin:'http://review',data:{type:'review:tool',id:'y',command:'replay',data:[{route:'/other'}]}});assert.match(messages[0].error,/screen differs/);
});
