import {digest} from '../reviews.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateRecipe,saveRecipe,expandRecipe} from '../project-settings.mjs';
import {WebPreviews} from '../web-project.mjs';
import {browserChecks,beginBrowserQa,browserQaResult} from '../browser-qa.mjs';
import {validateDelivery,saveDelivery,deployProject} from '../project-delivery.mjs';
const exec=promisify(execFile);

test('custom project recipes validate commands and isolate substitutions',()=>{
  const recipe=validateRecipe({start:['python','-m','http.server','{port}'],env:{DB:'test_{side}_{commit}',DATA:'{data}'}});
  const expanded=expandRecipe(recipe,{port:1234,side:'original',commit:'abc',data:'/private',root:'/repo'});
  assert.equal(expanded.start.at(-1),'1234');assert.equal(expanded.env.DB,'test_original_abc');assert.equal(expanded.env.DATA,'/private');
  for(const value of [{start:'python server.py'},{start:['node'],directory:'../outside'},{start:['node'],readyPath:'//outside'},{start:['node'],env:{BAD:1}}])assert.throws(()=>validateRecipe(value));
});

test('custom stack runs two real isolated previews, reuses live version and stops owned processes',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'review-custom-')),local=path.join(directory,'state');await mkdir(local);
  const source=`import http from 'node:http';http.createServer((req,res)=>res.end(process.env.BRANCH_REVIEW_SIDE+':'+process.env.BRANCH_REVIEW_REVISION)).listen(Number(process.env.PORT),'127.0.0.1');`;
  await writeFile(path.join(directory,'server.mjs'),source);
  await saveRecipe(local,{start:['node','server.mjs']});
  const previews=new WebPreviews({local,progress:()=>{},run:async(file,args,options)=>{const result=await exec(file,args,{...options,windowsHide:true});return result.stdout.trim();}});
  try{
    const a=await previews.prepare('original','a'.repeat(40),directory,async()=>{}),b=await previews.prepare('changed','b'.repeat(40),directory,async()=>{});
    assert.notEqual(a.web,b.web);assert.match(await fetch('http://127.0.0.1:'+a.web).then(r=>r.text()),/^original:aaa/);
    assert.match(await fetch('http://127.0.0.1:'+b.web).then(r=>r.text()),/^changed:bbb/);
    assert.equal((await previews.prepare('changed',b.sha,directory,async()=>{throw Error('must reuse');})).web,b.web);
    assert.equal(await previews.healthy('original',b.sha),false);
    await previews.stop('changed');assert.equal(await previews.healthy('changed',b.sha),false);
  }finally{await previews.stop('original');await previews.stop('changed');}
});

test('browser QA binds evidence to commit, rejects stale/out-of-order results and incomplete passes',async()=>{
  const local=await mkdtemp(path.join(os.tmpdir(),'review-browser-'));
  const record={identity:{changed:'a'.repeat(40)},manifest:{scenarios:[{id:'button',path:'/tutorials'}]}},store={records:[record],persist:async()=>{},event:async()=>{}};
  assert.throws(()=>browserChecks(record.manifest,[{itemId:'wrong',action:'visit',path:'/'}]));
  assert.throws(()=>browserChecks(record.manifest,[{itemId:'button',action:'visit',path:'https://other.test'}]));
  const run=await beginBrowserQa(store,record,[]),bound={runId:run.id,commit:run.commit};
  await assert.rejects(browserQaResult(store,local,record,{...bound,finish:'passed'}),/Every action/);
  await assert.rejects(browserQaResult(store,local,record,{...bound,index:1,passed:true}),/out of order/);
  await assert.rejects(browserQaResult(store,local,record,{...bound,commit:'bad',index:0,passed:true}),/no longer active/);
  const screenshot='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=';
  await browserQaResult(store,local,record,{...bound,index:0,passed:true,screenshot});
  await browserQaResult(store,local,record,{...bound,finish:'passed'});assert.equal(run.status,'passed');assert.equal(record.approval,undefined);
});

test('generic delivery requires exact remote and hosted receipts and never silently retries',async()=>{
  const local=await mkdtemp(path.join(os.tmpdir(),'review-deploy-')),sha='a'.repeat(40);
  await saveDelivery(local,{command:['node','deploy.mjs','{commit}'],buildUrl:'https://app.example/build.json'});
  assert.throws(()=>validateDelivery({command:['deploy'],buildUrl:'http://app.example/build.json'}));
  const record={identity:{changed:sha},delivery:{stage:'pushed',commit:sha}},store={persist:async()=>{},event:async()=>{}};
  record.approval={identity:digest(record.identity)};
  let deployments=0;
  const options={local,cwd:local,store,defaultBranch:async()=> 'master',confirmation:'DEPLOY '+sha,git:async()=>sha+'\trefs/heads/master',run:async(file,args)=>{if(file==='git')return args[0]==='rev-parse'?sha:'';deployments++;return '';},fetcher:async()=>({ok:true,json:async()=>({revision:'wrong'})})};
  await assert.rejects(deployProject(record,options),/exact clean/);assert.equal(record.projectDeployment.status,'needs-inspection');
  await assert.rejects(deployProject(record,options),/Inspect/);assert.equal(deployments,1);
  delete record.projectDeployment;options.fetcher=async()=>({ok:true,json:async()=>({revision:sha})});
  await deployProject(record,options);assert.equal(record.projectDeployment.status,'published');await deployProject(record,options);assert.equal(deployments,2);
});
