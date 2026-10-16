import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const state = await fetch('http://127.0.0.1:4310/api/state').then(r=>r.json());
assert.equal(state.status,'ready','Open qa-grid-freshness and wait until both previews are ready.');
assert.equal(state.comparison.branch.ref,process.env.BRANCH_REVIEW_QA_REF || 'refs/heads/codex/qa-grid-freshness');
assert.equal(state.manifest.scenarios[0].path,'/qa?view=coverage');
const results={};
for (const side of ['original','changed']) {
  const origin=`http://127.0.0.1:${state[side].proxy}`;
  const start=await fetch(origin+'/__review/start?scenario='+encodeURIComponent(state.manifest.scenarios[0].id)).then(r=>r.text());
  assert.match(start,/\/qa\?view=coverage/);assert.match(start,/"public":true/);
  const page=await fetch(origin+'/qa?view=coverage');assert.equal(page.status,200);
  assert.match(await page.text(),/id="root"/);
  const response=await fetch(origin+'/api/qa/office/qa',{signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);const ledger=await response.json();
  assert.equal(ledger.build.revision,state[side].sha);assert.equal(ledger.build.dirty,false);
  assert.equal(ledger.coverage.workflows.length,116);
  const rows=ledger.coverage.workflows.filter(row=>['WF-011','WF-012','WF-013'].includes(row.id));
  assert.equal(rows.length,3);
  if(side==='original') { for(const row of rows){assert.equal(row.status,'untested');assert.equal(row.stale_build,true);} }
  else { assert.equal(rows[0].status,'fail');assert.equal(rows[1].status,'pass');assert.equal(rows[0].stale_build,false);assert.equal(rows[1].stale_build,false);assert.equal(rows[2].stale_build,true); }
  const repeated=await fetch(origin+'/api/qa/office/qa').then(r=>r.json());
  assert.deepEqual(repeated.coverage.workflows,ledger.coverage.workflows);
  results[side]={commit:state[side].sha,route:'/qa?view=coverage',rows:rows.map(({id,status,historical,stale_build})=>({id,status,historical,stale_build}))};
}
await writeFile('.local/qa-verification.json',JSON.stringify({at:new Date().toISOString(),results},null,2));
console.log('PASS: both previews serve QA coverage at their exact clean commits. Original retains historical imported rows; Changed restores Fail/Pass while keeping older-build evidence stale. Repeated reads persist.');
console.log(JSON.stringify(results,null,2));
