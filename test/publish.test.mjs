import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {publish,target} from '../publish.mjs';
import {digest} from '../reviews.mjs';
test('publish requires exact confirmation, checks build identity and persists failures',async()=>{
  await mkdir('.local',{recursive:true});const local=path.resolve(await mkdtemp('.local/publish-test-'));
  const sha='a'.repeat(40), record={identity:{changed:sha},integration:{sha},delivery:{stage:'pushed',commit:sha}};
  record.approval={identity:digest(record.identity)};
  const checkout=path.join(local,'release-checkout');await mkdir(checkout);
  await writeFile(path.join(checkout,'.branch-review-owner'),'branch-review-release/v1');
  const key=path.join(local,'test-key');await writeFile(key,'synthetic');
  await writeFile(path.join(local,'release.json'),JSON.stringify({keyPath:key,recoveryDirectory:local}));
  let deploys=0, mismatch=false, preflights=0, handoffs=0;
  const options={local,repo:'unused',confirmation:`PUBLISH ${sha} TO ${target}`,
    git:async(...args)=>args[0]==='remote'?'https://github.com/joshrice171723-creator/meta_clinic.git':`${sha}\trefs/heads/main`,
    run:async(command,args,settings)=>{if(command==='pwsh'){deploys++;settings.onOutput('Building release\n');assert.equal(record.delivery.progress,'Building release');assert.ok(record.delivery.lastOutputAt);return 'release complete';}return args[0]==='rev-parse'?sha:'';},
    muse:{preflight:async()=>{preflights++;},prepare:r=>{r.museQa={status:'pending'};},dispatch:async r=>{assert.equal(r.delivery.stage,'published');handoffs++;}},
    store:{persist:async()=>{},event:async()=>{}},fetcher:async(url)=>({ok:true,json:async()=>({revision:mismatch?'b'.repeat(40):sha,dirty:false})})};
  await assert.rejects(publish(record,{...options,confirmation:'yes'}),/exact commit/);assert.equal(deploys,0);
  const approval=record.approval.identity;record.approval.identity='stale';
  await assert.rejects(publish(record,options),/exact candidate/);assert.equal(deploys,0);record.approval.identity=approval;
  record.delivery.commit='b'.repeat(40);await assert.rejects(publish(record,options),/exact candidate/);record.delivery.commit=sha;
  record.integration.sha='b'.repeat(40);await assert.rejects(publish(record,options),/exact candidate/);record.integration.sha=sha;
  await publish(record,options);assert.equal(record.delivery.stage,'published');assert.equal(deploys,1);
  assert.equal(preflights,1);assert.equal(handoffs,1);assert.equal(record.museQa.status,'pending');
  record.delivery.stage='pushed';mismatch=true;
  await assert.rejects(publish(record,options),/does not match/);assert.equal(record.delivery.stage,'deployment-needs-inspection');
  await assert.rejects(publish(record,options),/must be pushed/);assert.equal(deploys,2);
  assert.equal(handoffs,1);
});
