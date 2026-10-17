import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {ReviewJobs} from '../jobs.mjs';
const exec=promisify(execFile);
const until=async predicate=>{const end=Date.now()+10000;while(!predicate()){assert.ok(Date.now()<end,'job timed out');await new Promise(resolve=>setTimeout(resolve,20));}};

test('stop terminates the owned agent job and preserves unfinished work without finalizing',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'review-cancel-'));
 const jobs=new ReviewJobs(directory,{previewRoot:directory,toolchain:path.dirname(process.execPath),run:async(file,args,options)=>file==='git'?(args[0]==='rev-parse'?'sha':''):(await exec(file,args,{...options,windowsHide:true})).stdout});
 const script=process.platform==='win32'?`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('started child='+child.pid);setInterval(()=>{},1000);`:'console.log("started");setInterval(()=>{},1000)';
 jobs.execute=async job=>{await jobs.command(job,process.execPath,['-e',script],directory);job.finalized=true;};
 const job=await jobs.start({id:'review',identity:{changed:'sha'}},'plan');
 await until(()=>job.log.includes('started'));const child=jobs.processes.get(job.id);
 await jobs.cancel(job.id);await until(()=>job.status!=='running');
 assert.equal(job.status,'cancelled');assert.equal(job.finalized,undefined);assert.equal(job.cancellable,false);assert.ok(child.exitCode!==null || child.signalCode);
 assert.match(job.error,/saved files remain/);await assert.rejects(jobs.cancel(job.id),/finished/);
 if(process.platform==='win32'){const descendant=Number(job.log.match(/child=(\d+)/)[1]);await until(()=>{try{process.kill(descendant,0);return false;}catch{return true;}});}
 await jobs.saving;
});

test('stop before process launch never runs an agent; finalization and warm jobs cannot be cancelled',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'review-cancel-'));
 const jobs=new ReviewJobs(directory,{}),job={id:'queued',kind:'plan',status:'running',cancellable:true};jobs.rows.push(job);
 await jobs.cancel(job.id);await assert.rejects(jobs.command(job,'does-not-exist',[],directory),/Job stopped/);assert.equal(jobs.processes.size,0);
 job.cancelRequested=false;job.cancellable=false;await assert.rejects(jobs.cancel(job.id),/finalizing/);
});
