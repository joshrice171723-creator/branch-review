import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {Delivery} from '../delivery.mjs';
import {digest} from '../reviews.mjs';
test('integration candidate preserves main, gates exact approval and rejects moving refs',async()=>{
  mkdirSync('.local',{recursive:true});const directory=path.resolve(mkdtempSync('.local/delivery-test-'));
  const call=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  call(directory,'init','--bare','remote.git');call(directory,'init','-b','main','source');const source=path.join(directory,'source');
  const git=async(...args)=>call(source,...args);
  await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  const commit=async(file,value)=>{writeFileSync(path.join(source,file),value);await git('add','.');await git('commit','-m',value);return git('rev-parse','HEAD');};
  await commit('base.txt','base');await git('remote','add','origin',path.join(directory,'remote.git'));await git('push','origin','main');
  await git('checkout','-b','feature');const feature=await commit('feature.txt','feature');
  await git('checkout','main');const main=await commit('main.txt','main update');await git('push','origin','main');
  const record={id:'test',identity:{ref:'refs/heads/feature',source:feature,changed:feature},events:[]};
  const store={persist:async()=>{},event:async(r,type)=>r.events.push(type)};const delivery=new Delivery(git,store);
  const candidate=await delivery.candidate(record);
  assert.notEqual(candidate.sha,feature);assert.equal(candidate.main,main);
  assert.equal(await git('show',`${candidate.sha}:main.txt`),'main update');assert.equal(await git('show',`${candidate.sha}:feature.txt`),'feature');
  assert.equal(await git('rev-parse','HEAD'),main);assert.equal(await git('status','--porcelain'),'');
  const reopened=await delivery.prepare(record.identity.ref,feature,candidate);
  assert.equal(reopened.sha,candidate.sha,'Reopening unchanged refs reuses the exact tested candidate');
  await assert.rejects(delivery.push(record,feature),/Approve/);
  record.identity.changed=candidate.sha;record.approval={identity:digest(record.identity)};
  await assert.rejects(delivery.push(record,feature),/different commit/);
  await delivery.push(record,candidate.sha);assert.equal(record.delivery.stage,'pushed');
  await delivery.push(record,candidate.sha);assert.equal(record.delivery.stage,'pushed');
  await git('checkout','feature');const updated=await commit('new.txt','new feature');
  await assert.rejects(delivery.refs(record),/branch changed/);
  record.identity.source=updated;record.identity.changed=updated;record.integration=null;
  const second=await delivery.candidate(record);record.identity.changed=second.sha;record.approval={identity:digest(record.identity)};
  await git('checkout','main');await git('reset','--hard',candidate.sha);await commit('concurrent.txt','concurrent update');await git('push','origin','main');
  await assert.rejects(delivery.push(record,second.sha),/Main moved/);
});

test('review preparation fetches remote main before QA without approval or a review record',async()=>{
  const main='a'.repeat(40),source='b'.repeat(40),calls=[];
  const git=async(...args)=>{
    calls.push(args);
    if(args[0]==='fetch'||args[0]==='update-ref')return '';
    if(args[0]==='rev-parse')return args[1]==='refs/remotes/origin/main'?main:source;
    if(args[0]==='merge-base')return main;
    throw Error('Unexpected operation: '+args.join(' '));
  };
  const prepared=await new Delivery(git,{}).prepare('refs/heads/feature',source);
  assert.equal(calls[0][0],'fetch');assert.equal(prepared.main,main);assert.equal(prepared.sha,source);
  assert.ok(!calls.some(args=>args[0]==='push'));
});

test('a lost push response stays unconfirmed until the exact remote commit is reconciled',async()=>{
  const source='a'.repeat(40),main='b'.repeat(40),sha='c'.repeat(40);
  const record={id:'recovery',identity:{ref:'refs/heads/feature',source,changed:sha},integration:{source,main,sha}};
  record.approval={identity:digest(record.identity)};
  let remoteMain=main,pushes=0,failRead=true;
  const git=async(...args)=>{
    if(args[0]==='fetch')return '';
    if(args[0]==='rev-parse')return args[1]==='refs/remotes/origin/main'?remoteMain:source;
    if(args[0]==='push'){pushes++;remoteMain=sha;return '';}
    if(args[0]==='ls-remote'){if(failRead)throw Error('Connection lost after push');return `${remoteMain}\trefs/heads/main`;}
    throw Error('Unexpected Git operation');
  };
  const events=[],delivery=new Delivery(git,{persist:async()=>{},event:async(_r,event)=>events.push(event)});
  await assert.rejects(delivery.push(record,sha),/Connection lost/);
  assert.equal(record.delivery.stage,'push-unconfirmed');assert.equal(pushes,1);assert.equal(remoteMain,sha);
  failRead=false;await delivery.push(record,sha);assert.equal(record.delivery.stage,'pushed');assert.equal(pushes,1);assert.ok(events.includes('push-confirmed'));
  record.approval.identity='old';await assert.rejects(delivery.push(record,sha),/exact reviewed version/);
});

test('a conflicting integration candidate preserves the source checkout and remote main',async()=>{
  mkdirSync('.local',{recursive:true});const directory=path.resolve(mkdtempSync('.local/conflict-test-'));
  const call=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  call(directory,'init','--bare','remote.git');call(directory,'init','-b','main','source');const cwd=path.join(directory,'source');
  const git=async(...args)=>call(cwd,...args);
  await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  const commit=async value=>{writeFileSync(path.join(cwd,'shared.txt'),value);await git('add','.');await git('commit','-m',value);return git('rev-parse','HEAD');};
  await commit('base');await git('remote','add','origin',path.join(directory,'remote.git'));await git('push','origin','main');
  await git('checkout','-b','feature');const source=await commit('feature');
  await git('checkout','main');const main=await commit('main');await git('push','origin','main');
  const record={id:'conflict',identity:{ref:'refs/heads/feature',source,changed:source}};
  const delivery=new Delivery(git,{event:async()=>{throw Error('Must not save a conflicting candidate');}});
  await assert.rejects(delivery.candidate(record),/Merge conflict/);
  assert.equal(record.integration,undefined);assert.equal(await git('rev-parse','HEAD'),main);assert.equal(await git('status','--porcelain'),'');
  assert.equal((await git('ls-remote','origin','refs/heads/main')).split(/\s/)[0],main);
});
