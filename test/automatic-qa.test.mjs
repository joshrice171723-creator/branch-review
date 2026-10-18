import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {changedStyles,automaticBrowserChecks} from '../automatic-qa.mjs';
import {beginBrowserQa,browserQaResult} from '../browser-qa.mjs';
import {reviewProgress} from '../public/progress-model.js';
import {ReviewStore} from '../reviews.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=';
const fixture=()=>({id:'review',identity:{base:'old',changed:'new'},manifest:{scenarios:[{id:'button',title:'Button',path:'/demo',files:['header.css'],steps:['Looks correct']},{id:'other',path:'/other',steps:['Works']}]},cursor:{itemId:'button'},events:[],issues:[],checks:{},items:{}});
test('CSS checks infer exact simple changes, including scoped selectors, without conditional or ambiguous rules',()=>{
 const before='.page:has(.demo) .button {border-radius:12px} @media (width>600px){.wide{color:red}} .button:hover{color:red} .duplicate{color:red}.duplicate{color:blue}';
 const after=before.replace('12px','16px').replaceAll('red','pink');
 assert.deepEqual(changedStyles(before,after),[{selector:'.page:has(.demo) .button',property:'border-radius',value:'16px'}]);
 assert.deepEqual(changedStyles('.a{color:red}', '.a{color:var(--pink)}'),[]);
});
test('automatic actions use pinned revisions and only infer assertions on the requested screen',async()=>{
 const record=fixture(),calls=[];
 const git=async(...args)=>{calls.push(args);return args[0]==='diff'?'header.css\0':args[1].startsWith('old:')?'.button{color:red}':'.button{color:blue}';};
 const actions=await automaticBrowserChecks(git,record);
 assert.deepEqual(actions.map(a=>a.action),['visit','style','visit']);assert.equal(actions[1].itemId,'button');assert.equal(actions[1].optional,true);
 assert.deepEqual(calls[0].slice(3,5),['old','new']);
});
test('automatic runs deduplicate, retain unverified evidence, and never approve',async()=>{
 const local=await mkdtemp(path.join(os.tmpdir(),'review-auto-')),store=await new ReviewStore(local).load(),record=fixture();store.records.push(record);
 const actions=[{itemId:'button',action:'style',selector:'.missing',property:'color',value:'blue',optional:true}];
 const run=await beginBrowserQa(store,record,actions,true),bound={runId:run.id,commit:'new'};
 assert.equal((await beginBrowserQa(store,record,actions,true)).reused,true);
 await browserQaResult(store,local,record,{...bound,index:0,passed:false,skipped:true,message:'Missing selector',screenshot:png});
 await assert.rejects(browserQaResult(store,local,record,{...bound,finish:'passed'}));
 await browserQaResult(store,local,record,{...bound,finish:'needs-review'});
 assert.equal(record.issues.length,0);assert.equal(record.approval,undefined);
 const loaded=await new ReviewStore(local).load();assert.equal((await beginBrowserQa(loaded,loaded.get('review'),actions,true)).id,run.id);
});
test('failed automatic assertion becomes a fix finding with evidence',async()=>{
 const local=await mkdtemp(path.join(os.tmpdir(),'review-auto-fail-')),store=await new ReviewStore(local).load(),record=fixture();store.records.push(record);
 const run=await beginBrowserQa(store,record,[{itemId:'button',action:'style',selector:'.button',property:'color',value:'blue',optional:true}],true);
 await browserQaResult(store,local,record,{runId:run.id,commit:'new',index:0,passed:false,message:'Actual red',screenshot:png});
 assert.equal(record.issues[0].scenario,'button');assert.equal(record.issues[0].commit,'new');assert.ok(record.issues[0].screenshot);assert.match(record.issues[0].expected,/blue/);
});
test('progress isolates branches, distinguishes page checks, stale QA and human judgment',()=>{
 const record=fixture(),state={record,status:'ready'};
 assert.equal(reviewProgress(state,[{reviewId:'other',status:'running'}]).label,'Ready for review');
 record.browserQa=[{commit:'new',status:'running',startedAt:'2026-10-17T00:00:00Z',actions:[{itemId:'button',action:'visit'}],results:[]}];
 assert.equal(reviewProgress(state,[],Date.parse('2026-10-17T00:00:46Z')).label,'Waiting for QA');
 record.browserQa[0].status='passed';record.browserQa[0].results=[{index:0,passed:true}];
 const progress=reviewProgress(state);assert.equal(progress.pages,1);assert.equal(progress.assertions,0);assert.equal(progress.pending,2);
 assert.equal(reviewProgress(state,[{reviewId:'review',status:'failed'}]).label,'Needs attention');
 assert.equal(reviewProgress(state,[{reviewId:'review',status:'interrupted'}]).label,'Needs attention');
 assert.equal(reviewProgress(state,[{reviewId:'review',status:'cancelled'}]).label,'Needs attention');
 const completed={reviewId:'review',kind:'fix',status:'succeeded',resultCommit:'next'};
 assert.equal(reviewProgress(state,[completed]).awaitingReview,true);
 assert.equal(reviewProgress({...state,busy:true},[completed]).label,'Preparing preview');
});
test('automatic action limit keeps every page instead of truncating later review items',async()=>{
 const record=fixture();record.manifest.scenarios=Array.from({length:100},(_,i)=>({...record.manifest.scenarios[0],id:i?'item-'+i:'button'}));
 const actions=await automaticBrowserChecks(async(...args)=>args[0]==='diff'?'header.css\0':args[1].startsWith('old:')?'.button{color:red}':'.button{color:blue}',record);
 assert.equal(actions.length,100);assert.ok(actions.every(action=>action.action==='visit'));assert.equal(actions.at(-1).itemId,'item-99');
});
