import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlan} from '../plans.mjs';
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
