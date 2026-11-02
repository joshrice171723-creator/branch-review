import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ReviewJobs} from '../jobs.mjs';
import {branchVersions,restoreVersion,advanceBranch} from '../branch-versions.mjs';
const exec=promisify(execFile);
async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),'same-branch-')),repo=path.join(directory,'repo');await mkdir(repo);
  const run=async(file,args,options={})=>(await exec(file,args,{...options,windowsHide:true})).stdout.trim();
  const git=(...args)=>run('git',args,{cwd:repo});
  await git('init','-b','main');await git('config','user.name','Synthetic reviewer');await git('config','user.email','test@example.invalid');
  await writeFile(path.join(repo,'button.css'),'button{color:#111111}');await git('add','.');await git('commit','-m','Baseline');const base=await git('rev-parse','HEAD');
  await git('checkout','-b','feature/button');await writeFile(path.join(repo,'button.css'),'button{color:#222222}');await git('commit','-am','Initial button change');const source=await git('rev-parse','HEAD');
  const record={id:'review',identity:{ref:'refs/heads/feature/button',source,changed:source,base},manifest:{version:2,scenarios:[]},issues:[]};
  return {directory,repo,run,git,record,base,source};
}
test('two isolated revisions advance one branch; preview is read-only and restore appends history',async()=>{
  const f=await fixture(),{directory,repo,run,git,record,base,source}=f;
  const jobs=await new ReviewJobs(directory,{git,run,repo,codex:'synthetic-agent'}).load();
  const branches=await git('for-each-ref','--format=%(refname)','refs/heads');let color='#333333';
  jobs.command=async(job,command,args,cwd)=>{assert.equal(await run('git',['branch','--show-current'],{cwd}),'');await writeFile(path.join(cwd,'button.css'),`button{color:${color}}`);await writeFile(args[args.indexOf('--output-last-message')+1],'Changed button');};
  for(const id of ['first','second']){
    const job={id,kind:'fix',status:'running',requestText:'Change button color'};jobs.rows.push(job);
    await jobs.execute(job,record,{},repo);job.status='succeeded';await jobs.save();
    assert.equal(job.sameBranch,true);assert.equal(job.applied,true);assert.equal(await git('rev-parse',record.identity.ref),job.resultCommit);assert.equal(await git('status','--porcelain'),'');
    record.identity.source=record.identity.changed=job.resultCommit;color='#444444';
  }
  assert.equal(await git('for-each-ref','--format=%(refname)','refs/heads'),branches);
  const history=await branchVersions(git,record);assert.equal(history.versions.length,4);assert.equal(history.versions[2].sha,source);assert.equal(history.versions.at(-1).sha,base);
  assert.equal(await git('show',source+':button.css'),'button{color:#222222}');assert.equal(await git('rev-parse',record.identity.ref),history.tip);
  const commit=await restoreVersion(git,run,record,source,history.tip,`RESTORE ${source} ON ${history.ref}`);
  assert.equal(await git('rev-parse',commit+'^'),history.tip);assert.equal(await readFile(path.join(repo,'button.css'),'utf8'),'button{color:#222222}');
  assert.equal(await git('rev-list','--count',`${base}..${commit}`),'4');assert.equal(await git('for-each-ref','--format=%(refname)','refs/heads'),branches);
  const reopened=await new ReviewJobs(directory,{git,run}).load();assert.equal(reopened.rows.length,2);assert.equal((await branchVersions(git,record)).versions[0].sha,commit);
});
test('dirty checkout blocks applying a saved commit; retry preserves edits and moved branch rejects',async()=>{
  const {directory,repo,run,git,record,source}=await fixture();const cwd=path.join(directory,'proposal');await git('worktree','add','--detach',cwd,source);
  await writeFile(path.join(cwd,'button.css'),'button{color:#555555}');await run('git',['commit','-am','Proposed color'],{cwd});const commit=await run('git',['rev-parse','HEAD'],{cwd});
  await writeFile(path.join(repo,'notes.txt'),'Unsaved unrelated work');
  await assert.rejects(advanceBranch(git,run,record.identity.ref,source,commit),/unsaved files/);assert.equal(await git('rev-parse','HEAD'),source);assert.equal(await readFile(path.join(repo,'notes.txt'),'utf8'),'Unsaved unrelated work');
  await git('add','notes.txt');await git('commit','-m','External branch change');
  await assert.rejects(advanceBranch(git,run,record.identity.ref,source,commit),/changed outside/);assert.equal(await git('show',commit+':button.css'),'button{color:#555555}');
  await assert.rejects(restoreVersion(git,run,record,source,source,`RESTORE ${source} ON ${record.identity.ref}`),/branch changed/);
});
test('interrupted proposals remain recoverable and apply after a dirty checkout is resolved',async()=>{
  const {directory,repo,run,git,record,source}=await fixture();
  const jobs=await new ReviewJobs(directory,{git,run,repo,codex:'synthetic-agent'}).load();
  jobs.command=async(job,_command,args,cwd)=>{
    await writeFile(path.join(cwd,'button.css'),'button{color:#666666}');
    await writeFile(path.join(repo,'unsaved.txt'),'Keep this work');
    await writeFile(args[args.indexOf('--output-last-message')+1],'Proposed color');
  };
  const job={id:'recover',kind:'fix',status:'running',requestText:'Use gray'};jobs.rows.push(job);
  await assert.rejects(jobs.execute(job,record,{},repo),/proposed commit.*saved/);
  assert.ok(job.resultCommit);assert.equal(await git('rev-parse',record.identity.ref),source);
  await jobs.save();
  const reopened=await new ReviewJobs(directory,{git,run,repo}).load();assert.equal(reopened.rows[0].status,'interrupted');
  await rename(path.join(repo,'unsaved.txt'),path.join(directory,'preserved-unsaved.txt'));
  await reopened.applyFix(job.id);assert.equal(await git('rev-parse',record.identity.ref),job.resultCommit);
  assert.equal(await readFile(path.join(directory,'preserved-unsaved.txt'),'utf8'),'Keep this work');
  await reopened.applyFix(job.id);assert.equal(reopened.rows[0].status,'succeeded');
  await git('checkout','--detach','main');const previousHead=await git('rev-parse','HEAD');
  const next=await git('commit-tree',await git('rev-parse',source+'^{tree}'),'-p',job.resultCommit,'-m','Another revision');
  await advanceBranch(git,run,record.identity.ref,job.resultCommit,next);assert.equal(await git('rev-parse','HEAD'),previousHead);assert.equal(await git('rev-parse',record.identity.ref),next);
});

test('version requests match exact fix commits and preserve user wording without agent context',async()=>{
  const record={identity:{ref:'refs/heads/demo',base:'base'}};
  const git=async(command)=>command==='rev-parse'?'tip':command==='merge-base'?'base':['tip\t2026-11-01\tFix','legacy\t2026-10-31\tOlder fix','manual\t2026-10-30\tManual commit','plain\t2026-10-29\tCustom request'].join('\n');
  const request='Change this to blue.\n\nKeep the label exactly as it is.';
  const jobs=[
    {kind:'fix',resultCommit:'tip',commit:'previous',requestText:`Requested change:\n${request}\n\nPreview context: changed at /home\nSelected area: #button\nApply only this request.`},
    {kind:'fix',resultCommit:'other',requestText:'This belongs to a different version'},
    {kind:'plan',resultCommit:'tip',requestText:'Not a fix request'},
    {kind:'fix',resultCommit:'legacy',requestText:'# Branch Review: fixes requested\n\nFinding one: Make the button blue.\nKeep its size.\nExpected: Blue\nObserved in changed\nFinding two: Use white text.\nExpected: White\nObserved in changed'},
    {kind:'fix',resultCommit:'plain',requestText:'Change the title.\nAttached current page: /home\nObserved changed commit: old'}
  ];
  const history=await branchVersions(git,record,jobs);
  assert.equal(history.versions[0].request,request);
  assert.equal(history.versions[1].request,'Make the button blue.\nKeep its size.\n\nUse white text.');
  assert.equal(history.versions[2].request,null);
  assert.equal(history.versions[3].request,'Change the title.');
  assert.equal(history.versions.at(-1).request,undefined);
});
