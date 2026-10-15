import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {ReviewStore,validateManifest} from '../reviews.mjs';
import {itemStatus,reviewCounts,nextItem,canApprove,fixRequest,matchesItem,deliveryStep} from '../public/review-model.js';

const manifest=validateManifest({version:2,title:'Twenty-item review',summary:'Test each behavior.',scenarios:Array.from({length:20},(_,i)=>({id:`item-${i+1}`,title:`Behavior ${i+1}`,path:'/qa?view=coverage',description:'A changed behavior',instructions:'Try the interaction.',expected:'It works.',steps:['First requirement','Second requirement']}))});
const snapshot={repository:'test',comparison:{branch:{ref:'refs/heads/feature',sha:'b',subject:'Feature'}},original:{sha:'a'},changed:{sha:'b'}};
async function setup(){await mkdir('.local',{recursive:true});const directory=await mkdtemp('.local/guided-test-');const store=await new ReviewStore(directory).load();return{store,directory,record:await store.open(snapshot,manifest,'recipe')};}

test('twenty-item guided review resumes, counts outcomes, and approves only fully accounted-for work',async()=>{
  const {store,directory,record:r}=await setup();
  assert.equal(itemStatus(r,manifest.scenarios[0]),'not-started');
  await store.cursor(r.id,'item-1');assert.equal(itemStatus(r,manifest.scenarios[0]),'in-progress');
  await store.check(r.id,'item-1',0,true);assert.equal(itemStatus(r,manifest.scenarios[0]),'in-progress');
  await store.check(r.id,'item-1',1,true);assert.equal(itemStatus(r,manifest.scenarios[0]),'passed');
  await store.item(r.id,'item-2',{outcome:'blocked',notes:'Saved notes',reason:'Screen cannot load'});
  assert.equal(itemStatus(r,manifest.scenarios[1]),'blocked');assert.equal(canApprove(r),false);
  await assert.rejects(store.item(r.id,'item-3',{outcome:'not-applicable',notes:'',reason:''}),/Describe why/);
  await store.cursor(r.id,'item-2');
  const restored=(await new ReviewStore(directory).load()).get(r.id);
  assert.equal(restored.cursor.itemId,'item-2');assert.equal(restored.items['item-2'].notes,'Saved notes');
  await store.item(r.id,'item-2',{outcome:'',notes:'Retested successfully',reason:''});
  for(const item of manifest.scenarios.slice(1))for(let i=0;i<item.steps.length;i++)await store.check(r.id,item.id,i,true);
  assert.equal(reviewCounts(r).passed,20);assert.equal(nextItem(r,'item-1'),null);
  await store.cursor(r.id,'item-20','results');await store.approve(r.id,'QA tester');assert.ok(r.approval);
  await store.check(r.id,'item-20',0,false);assert.equal(r.approval,null);assert.equal(canApprove(r),false);
});

test('failed items, reasoned exclusions, fix handoffs and changed revisions retain correct evidence',async()=>{
  const {store,record:r}=await setup();
  await store.item(r.id,'item-1',{outcome:'needs-fixes',notes:'Observed while comparing',reason:'Button does nothing'});
  await store.issue(r.id,{scenario:'item-2',side:'original',expected:'Visible result',actual:'Missing result',location:'/qa?view=coverage'});
  await store.item(r.id,'item-3',{outcome:'not-applicable',notes:'',reason:'This branch does not change this workflow'});
  const handoff=fixRequest(r);
  assert.match(handoff,/Button does nothing/);assert.match(handoff,/Missing result/);assert.match(handoff,/Original commit: a/);assert.doesNotMatch(handoff,/## Item 3:/);
  assert.equal(itemStatus(r,manifest.scenarios[1]),'needs-fixes');assert.equal(reviewCounts(r).complete,1);
  const next=await store.open({...snapshot,changed:{sha:'c'},comparison:{branch:{...snapshot.comparison.branch,sha:'c'}}},manifest,'recipe');
  assert.equal(next.previousId,r.id);assert.equal(next.approval,null);assert.deepEqual(next.checks,{});assert.equal(next.issues[0].status,'needs-retest');
  assert.equal(next.issues[0].commit,'a');
});

test('manifest validation preserves structured guidance and validates both preview destinations',()=>{
  assert.equal(manifest.scenarios[0].instructions,'Try the interaction.');
  assert.equal(manifest.scenarios.length,20);
  assert.throws(()=>validateManifest({...manifest,scenarios:[{...manifest.scenarios[0],originalPath:'https://outside.example'}]}),/inside/);
  assert.throws(()=>validateManifest({...manifest,scenarios:[{...manifest.scenarios[0],focus:{selector:'anything'}}]}),/row identifier/);
});

test('queue filters retain item identities and distinguish unfinished work from failures',async()=>{
  const {store,record:r}=await setup(),first=manifest.scenarios[0],second=manifest.scenarios[1];
  await store.item(r.id,first.id,{outcome:'blocked',notes:'',reason:'Cannot reach screen'});
  assert.equal(matchesItem(r,first,'BEHAVIOR 1','attention'),true);
  assert.equal(matchesItem(r,second,'','attention'),false);
  assert.equal(matchesItem(r,second,'item-2','remaining'),true);
  await store.check(r.id,second.id,0,true);await store.check(r.id,second.id,1,true);
  assert.equal(matchesItem(r,second,'','remaining'),false);assert.equal(matchesItem(r,second,'','complete'),true);
});

test('results recommend only the next valid delivery action',async()=>{
  const {record:r}=await setup();assert.equal(deliveryStep(r).action,'resume-review');
  for(const item of r.manifest.scenarios)item.steps.forEach((_,i)=>r.checks[`${item.id}:${i}`]=true);
  assert.equal(deliveryStep(r).action,'candidate');r.integration={sha:r.identity.changed};
  assert.equal(deliveryStep(r).action,'reviewer');r.approval={commit:r.identity.changed};assert.equal(deliveryStep(r).action,'ship');
  r.delivery={stage:'push-unconfirmed'};assert.match(deliveryStep(r).label,/Reconcile/);
  r.delivery.stage='pushed';assert.equal(deliveryStep(r).action,'release-settings');assert.equal(deliveryStep(r,true).action,'publish');
  r.delivery.stage='deployment-needs-inspection';assert.equal(deliveryStep(r).action,'release-note');
  r.delivery.stage='published';assert.equal(deliveryStep(r).action,'release-note');r.delivery.stage='verified';assert.equal(deliveryStep(r).action,null);
});
