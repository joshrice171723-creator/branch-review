import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlan,candidateComparison} from '../plans.mjs';
test('review plans come from the exact commit and reject invalid guidance before startup',async()=>{
  const sha='a'.repeat(40),calls=[];
  const manifest={version:2,title:'Branch-specific change',scenarios:[{id:'test',title:'Test',path:'/qa',steps:['Verify result']}]};
  let contents=JSON.stringify(manifest),exists=true;
  const git=async(...args)=>{calls.push(args);return args[0]==='ls-tree'?(exists?'.branch-review.json':''):contents;};
  assert.equal((await loadPlan(git,sha,[])).title,manifest.title);assert.equal(calls[1][1],`${sha}:.branch-review.json`);
  contents='{broken';await assert.rejects(loadPlan(git,sha,[]),/Invalid .branch-review/);
  contents='x'.repeat(64001);await assert.rejects(loadPlan(git,sha,[]),/too large/);
  exists=false;assert.match((await loadPlan(git,sha,[])).source,/No branch-specific/);
  assert.equal((await loadPlan(git,sha,['apps/api/app/services/qa/office_qa.rb'])).scenarios.length,6);
  await assert.rejects(loadPlan(git,'HEAD',[]),/exact commit/);
});
test('integration review derives files from the candidate but guidance from the selected branch',async()=>{
  const main='a'.repeat(40),sha='b'.repeat(40),calls=[];
  const git=async(...args)=>{calls.push(args);return args[0]==='diff'?'apps/api/app/services/qa/office_qa.rb\0':'';};
  const branch={sha:'c'.repeat(40)},prior={branch,base:'d'.repeat(40),files:['unrelated.txt'],baseline:'parent'};
  const result=await candidateComparison(git,prior,{main,sha});
  assert.deepEqual(calls[0],['diff','--name-only','-z',main,sha,'--']);
  assert.equal(calls[1][2],branch.sha);assert.equal(result.base,main);assert.equal(result.main,main);
  assert.deepEqual(result.files,['apps/api/app/services/qa/office_qa.rb']);assert.equal(result.plan.scenarios.length,6);
  assert.equal(result.branch,branch);assert.deepEqual(prior.files,['unrelated.txt']);
});

test('main marketing plan cannot replace the QA branch plan after integration',async()=>{
  const source='a'.repeat(40),sha='b'.repeat(40),main='c'.repeat(40);
  const git=async(...args)=>{
    if(args[0]==='diff')return 'apps/api/app/services/qa/office_qa.rb\0';
    if(args[0]==='ls-tree')return args[2]===sha?'.branch-review.json':'';
    if(args[0]==='show')throw Error('Must not read main-inherited marketing plan');
    throw Error('Unexpected command');
  };
  const result=await candidateComparison(git,{branch:{sha:source}},{sha,main});
  assert.equal(result.plan.scenarios.length,6);
  assert.ok(result.plan.scenarios.every(item=>item.path==='/qa?view=coverage'));
});

test('unrelated mapped checklist is replaced only by a matching built-in plan',async()=>{
  const manifest={version:2,title:'Blue button',scenarios:[{id:'color',title:'Color',path:'/',steps:['Blue'],files:['apps/web/src/features/marketing/MetaClinicMarketing.tsx']}]};
  const git=async(...args)=>args[0]==='ls-tree'?'.branch-review.json':JSON.stringify(manifest);
  const plan=await loadPlan(git,'a'.repeat(40),['apps/api/app/services/qa/office_qa.rb']);
  assert.equal(plan.scenarios[0].path,'/qa?view=coverage');
  await assert.rejects(loadPlan(git,'a'.repeat(40),['unknown-feature.ts']),/needs a QA plan/);
});
