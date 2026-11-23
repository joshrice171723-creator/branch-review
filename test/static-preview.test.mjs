import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {WebPreviews,projectCommand,detectProject} from '../web-project.mjs';
import {reviewRecipe,saveRecipe} from '../project-settings.mjs';

test('built-in static preview serves the project locally without exposing hidden files',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'branch-review-static-test-')),repo=path.join(root,'repo'),local=path.join(root,'state');
  await mkdir(repo);await mkdir(local);await writeFile(path.join(repo,'index.html'),'<h1>Example</h1>');await writeFile(path.join(repo,'.env'),'not for preview');
  const command=await projectCommand(['branch-review-static','example','1234'],{PATH:''});assert.equal(command.file,process.execPath);
  const run=promisify(execFile),previews=new WebPreviews({local,progress:()=>{},run:async(file,args,options)=>(await run(file,args,options)).stdout});
  try{
    assert.equal((await detectProject(repo)).kind,'static');
    const preview=await previews.prepare('changed','synthetic',repo,async()=>{}),origin=`http://127.0.0.1:${preview.web}`;
    const response=await fetch(origin+'/');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/html/);assert.match(await response.text(),/Example/);
    assert.equal((await fetch(origin+'/.env')).status,404);assert.equal((await fetch(origin+'/missing')).status,404);
    await writeFile(path.join(repo,'server.js'),'// server fixture');assert.equal((await detectProject(repo)).kind,'custom');
  }finally{await previews.stop('changed');await rm(root,{recursive:true,force:true});}
});

test('review previews use each checkout’s declared web app on an isolated loopback port',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'branch-review-declared-preview-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const local=path.join(root,'state');
  await mkdir(local);
  const run=promisify(execFile);
  const parentOrigin='http://127.0.0.1:4338';
  const previews=new WebPreviews({local,parentOrigin,progress:()=>{},run:async(file,args,options)=>(await run(file,args,options)).stdout});
  const script="require('node:http').createServer((_req,res)=>res.end(process.env.TEST_SIDE+' '+process.env.BRANCH_REVIEW_PREVIEW_PARENT)).listen(Number(process.env.TEST_PORT),'127.0.0.1')";
  try {
    const ports=[];
    for (const side of ['original','changed']) {
      const cwd=path.join(root,side);
      await mkdir(cwd);
      await writeFile(path.join(cwd,'server.cjs'),script);
      await writeFile(path.join(cwd,'workbench-capabilities.json'),JSON.stringify({schema_version:1,previews:[
        {mode:'desktop',argv:['unavailable-electron']},
        {mode:'web',url:'http://127.0.0.1:{port}/health',argv:['node','server.cjs'],env:{TEST_PORT:'{port}',TEST_SIDE:side}}
      ]}));
      const preview=await previews.prepare(side,side+'-commit',cwd,async()=>{});
      assert.equal(await (await fetch('http://127.0.0.1:'+preview.web+'/health')).text(),side+' '+parentOrigin);
      ports.push(preview.web);
    }
    assert.notEqual(ports[0],ports[1]);
    await saveRecipe(local,{start:['node','override.cjs']});
    assert.deepEqual((await reviewRecipe(local,path.join(root,'changed'))).start,['node','override.cjs']);
  }finally{
    await Promise.all(['original','changed'].map(side=>previews.stop(side)));
  }
});
