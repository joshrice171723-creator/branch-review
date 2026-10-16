import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rename,rmdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {ReviewStore,defaultManifest,validateManifest,scenarioPath,manifestForFiles,scenarioRecipe} from '../reviews.mjs';
import {isReviewDestination,previewDestination} from '../public/preview-routes.js';
await mkdir('.local',{recursive:true});
const snapshot = {repository:'test',comparison:{branch:{ref:'refs/heads/feature',sha:'b',subject:'Intake'}},original:{sha:'a'},changed:{sha:'b'}};
test('review approval persists and changes invalidate it; new revisions carry unresolved findings',async()=>{
  const directory=await mkdtemp('.local/reviews-test-'), store=await new ReviewStore(directory).load();
  const r=await store.open(snapshot,defaultManifest,'recipe');
  await assert.rejects(store.approve(r.id,'Joshua'),/every scenario/);
  for(let i=0;i<4;i++) await store.check(r.id,'intake',i,true);
  await store.approve(r.id,'Joshua');
  assert.equal((await new ReviewStore(directory).load()).get(r.id).approval.commit,'b');
  await store.issue(r.id,{scenario:'intake',expected:'Save',actual:'Does not save'});
  assert.equal(r.approval,null);
  await assert.rejects(store.approve(r.id,'Joshua'),/every open finding/);
  const next=await store.open({...snapshot,changed:{sha:'c'},comparison:{branch:{...snapshot.comparison.branch,sha:'c'}}},defaultManifest,'recipe');
  assert.equal(next.issues[0].status,'needs-retest');assert.deepEqual(next.checks,{});
  await assert.rejects(store.resolve(next.id,next.issues[0].id,''),/retest result/);
  await store.resolve(next.id,next.issues[0].id,'Saved answer persists after reopening.');
  assert.equal(next.issues[0].resolvedCommit,'c');
  assert.equal(r.issues[0].status,'open');
  await assert.rejects(store.issue(next.id,{scenario:'intake',expected:'a',actual:'b',screenshot:'data:image/png;base64,YQ=='}),/invalid/);
  next.delivery={stage:'deploying'};await store.persist();
  assert.equal((await new ReviewStore(directory).load()).get(next.id).delivery.stage,'deployment-needs-inspection');
});
test('scenario destinations and identifiers are constrained',()=>{
  const files=['apps/api/app/services/qa/office_qa.rb'];
  assert.equal(scenarioRecipe(files),'qa-scenario.rb');
  assert.equal(scenarioRecipe(['apps/web/src/features/qa/QaOfficeQa.tsx']),'qa-scenario.rb');
  assert.equal(validateManifest(manifestForFiles(files)).scenarios[0].path,'/qa?view=coverage');
  assert.equal(scenarioRecipe([]),'scenario.rb');
  assert.equal(scenarioPath({path:'/clinic/patients/:patientId/encounters/:encounterId#intake'},{path:'/clinic/patients/3/encounters/1'}),'/clinic/patients/3/encounters/1#intake');
  for(const destination of ['https://evil.test','//evil.test','/clinic/../admin','/clinic/%2e%2e/admin','/clinic\\evil']) assert.throws(()=>validateManifest({version:1,scenarios:[{id:'test',title:'Test',path:destination,steps:['Test']}]}),/inside/);
  assert.throws(()=>validateManifest({...defaultManifest,scenarios:[defaultManifest.scenarios[0],defaultManifest.scenarios[0]]}),/unique/);
});

test('public review routes support Original and Changed while rejecting traversal and outside URLs',()=>{
  const item={id:'homepage',title:'Homepage sandbox button',path:'/demo?source=review#start',originalPath:'/',steps:['Compare the sandbox button.']};
  const manifest=validateManifest({version:2,scenarios:[item]});
  assert.equal(manifest.scenarios[0].originalPath,'/');
  const state={original:{scenario:{path:'/clinic/patients/3/encounters/1'}},changed:{scenario:{public:true,path:'/qa'}}};
  assert.equal(previewDestination(item,'original',state),'/');
  assert.equal(previewDestination(item,'changed',state),'/demo?source=review#start');
  assert.equal(scenarioPath({path:'/meta-clinic'},undefined),'/meta-clinic');
  for(const route of ['/','/?source=review#sandbox','/meta-clinic','/meta-clinic/resources','/meta-clinic/platform/memberships?tab=overview#start','/demo','/qa?view=office','/clinic/patients/3'])assert.equal(isReviewDestination(route),true,route);
  for(const route of ['https://evil.test','//evil.test','/meta-clinic-other','/meta-clinic/../admin','/meta-clinic/%2e%2e/admin','/meta-clinic/%5cadmin','/demo/other','/admin','/clinic/../','/clinic/%2e%2e/demo','/clinic/.%2e/qa','/clinic/%5cadmin','/qa/../','/demo\\evil','/clinic\t/other']){
    assert.equal(isReviewDestination(route),false,route);
    assert.throws(()=>validateManifest({version:2,scenarios:[{...item,originalPath:route}]}),/inside/);
  }
});

test('a failed disk write cannot leave a checked result or approval in memory',async()=>{
  const directory=await mkdtemp('.local/save-failure-test-'),store=await new ReviewStore(directory).load();
  const record=await store.open(snapshot,defaultManifest,'recipe');
  const destination=path.join(directory,'reviews.json'),backup=destination+'.backup';
  await rename(destination,backup);await mkdir(destination);
  await assert.rejects(store.check(record.id,'intake',0,true),/last saved results are unchanged/);
  assert.equal(store.get(record.id).checks['intake:0'],undefined);assert.equal(store.get(record.id).approval,null);
  assert.deepEqual(JSON.parse(await readFile(backup,'utf8'))[0].checks,{});
  await rmdir(destination);await rename(backup,destination);
  await store.check(record.id,'intake',0,true);assert.equal((await new ReviewStore(directory).load()).get(record.id).checks['intake:0'],true);
});

test('published findings preserve historical approval and carry forward separately',async()=>{
  const directory=await mkdtemp('.local/published-findings-'),store=await new ReviewStore(directory).load();
  const r=await store.open(snapshot,defaultManifest,'recipe');
  for(let i=0;i<4;i++)await store.check(r.id,'intake',i,true);
  await store.approve(r.id,'Reviewer');r.delivery={stage:'published'};
  const approval=structuredClone(r.approval),checks=structuredClone(r.checks);
  await assert.rejects(store.item(r.id,'intake',{outcome:'needs-fixes',notes:'',reason:'New'}),/read-only/);
  await assert.rejects(store.check(r.id,'intake',0,false),/read-only/);
  await assert.rejects(store.issue(r.id,{scenario:'intake',side:'changed',expected:'A',actual:'B'}),/read-only/);
  await store.issue(r.id,{scenario:'intake',side:'published',expected:'A',actual:'B'});
  assert.deepEqual(r.approval,approval);assert.deepEqual(r.checks,checks);assert.equal(r.issues.length,0);
  assert.equal(r.publishedFindings[0].side,'published');
  const next=await store.open({...snapshot,changed:{sha:'c'}},defaultManifest,'recipe');
  assert.equal(next.issues[0].status,'needs-retest');assert.equal(next.issues[0].commit,'b');
});
