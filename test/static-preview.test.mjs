import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {WebPreviews,projectCommand,detectProject} from '../web-project.mjs';

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
