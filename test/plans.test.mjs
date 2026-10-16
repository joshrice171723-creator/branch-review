import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlan,candidateComparison} from '../plans.mjs';

test('legacy committed checklist is never read or used as review guidance',async()=>{
  const git=async()=>{throw Error('Must not read the committed checklist');};
  const plan=await loadPlan(git,'a'.repeat(40),['unknown-feature.ts']);
  assert.equal(plan.source,'Pending diff analysis');
  await assert.rejects(loadPlan(git,'HEAD',[]),/exact commit/);
});
test('candidate analysis uses actual combined changes and excludes obsolete metadata',async()=>{
  const main='a'.repeat(40),sha='b'.repeat(40),calls=[];
  const git=async(...args)=>{calls.push(args);return 'apps/api/app/services/qa/office_qa.rb\0.branch-review.json\0';};
  const branch={sha:'c'.repeat(40)};
  const result=await candidateComparison(git,{branch},{main,sha});
  assert.deepEqual(calls,[['diff','--name-only','-z',main,sha,'--']]);
  assert.deepEqual(result.files,['apps/api/app/services/qa/office_qa.rb']);
  assert.equal(result.base,main);assert.equal(result.branch,branch);
});
