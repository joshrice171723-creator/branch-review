import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {agentArgs,consumeAgentEvent,providerId,launchCommand} from '../providers.mjs';
import {ReviewJobs} from '../jobs.mjs';
import {detectProject} from '../web-project.mjs';
import {validateManifest} from '../reviews.mjs';

test('Claude jobs use restricted file tools with no shell or external MCP; Codex keeps sandbox boundaries',()=>{
  const plan=agentArgs('claude',{kind:'plan',cwd:'/work',output:'/out'}),fix=agentArgs('claude',{kind:'fix',chatId:'id'});
  assert.ok(plan.includes('--restricted'));assert.ok(plan.includes('--safe-mode'));assert.ok(plan.includes('--no-session-persistence'));
  assert.equal(plan[plan.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(fix[fix.indexOf('--tools')+1],'Read,Glob,Grep,Edit,Write');
  assert.equal(fix[fix.indexOf('--resume')+1],'id');assert.equal(fix.includes('--dangerously-skip-permissions'),false);
  const codex=agentArgs('codex',{kind:'fix',connections:['unrelated']});assert.equal(codex[codex.indexOf('--sandbox')+1],'workspace-write');assert.ok(codex.includes('mcp_servers.unrelated.enabled=false'));assert.ok(codex.includes('plugins'));
  assert.throws(()=>providerId('other'),/Choose/);assert.throws(()=>launchCommand('cli.cmd',[]),/wrapper/);
});
test('terminal error events cannot become success and provider sessions stay distinct',()=>{
  const codex={provider:'codex'},claude={provider:'claude'};
  consumeAgentEvent(codex,{type:'thread.started',thread_id:'codex-id'});
  consumeAgentEvent(claude,{type:'system',subtype:'init',session_id:'claude-id'});
  consumeAgentEvent(claude,{type:'result',subtype:'error_max_turns',is_error:true,result:'Limit reached'});
  assert.equal(codex.chatId,'codex-id');assert.equal(claude.chatId,'claude-id');assert.equal(claude.agentError,'Limit reached');
});
test('first change uses Claude protocol and host commit finalization without a preview or edits to the original branch',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'provider-workflow-')),repo=path.join(directory,'repo');await mkdir(repo);
  const run=async(command,args,options)=>{const result=await promisify(execFile)(command,args,options);return result.stdout.trim();};
  const git=(...args)=>run('git',args,{cwd:repo});
  await git('init','-b','main');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  await writeFile(path.join(repo,'button.css'),'button { background: purple; }');await git('add','.');await git('commit','-m','base');
  const source=await git('rev-parse','HEAD'),jobs=await new ReviewJobs(directory,{git,run,repo,provider:()=>({provider:'claude',executable:'fixture.exe'})}).load();
  jobs.command=async(job,command,args,cwd)=>{
    assert.equal(command,'fixture.exe');assert.ok(args.includes('--restricted'));assert.notEqual(cwd,repo);
    await writeFile(path.join(cwd,'button.css'),'button { background: blue; }');
    consumeAgentEvent(job,{type:'result',subtype:'success',result:'Changed the button to blue.'});
  };
  await writeFile(path.join(repo,'personal-draft.txt'),'Keep my uncommitted work.');
  await assert.rejects(jobs.startNew(source,''),/Describe/);
  const job=await jobs.startNew(source,'Make the button blue.');
  const deadline=Date.now()+10000;while(job.status==='running'){assert.ok(Date.now()<deadline,'job did not finish');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(job.status,'succeeded',job.error);assert.equal(job.reviewId,undefined);
  assert.notEqual(job.resultCommit,source);assert.equal(await git('rev-parse','HEAD'),source);
  assert.match(await git('show',job.resultCommit+':button.css'),/blue/);assert.equal(await git('status','--porcelain'),'?? personal-draft.txt');
  assert.equal(await readFile(path.join(repo,'personal-draft.txt'),'utf8'),'Keep my uncommitted work.');await jobs.saving;
  jobs.command=async(job,command,args,cwd)=>{await writeFile(path.join(cwd,'button.css'),'button { background: pink; }');job.cancelRequested=true;job.agentResult='Changed to pink.';};
  const stopped=await jobs.startNew(source,'Make it pink.');
  const end=Date.now()+10000;while(stopped.status==='running'){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(stopped.status,'cancelled');assert.equal(stopped.resultCommit,undefined);
  assert.equal(await run('git',['rev-parse','HEAD'],{cwd:stopped.worktree}),source);
  assert.match(await readFile(path.join(stopped.worktree,'button.css'),'utf8'),/pink/);await jobs.saving;
});
test('unknown stacks get project setup instead of being rejected',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'web-project-'));
  assert.equal((await detectProject(directory)).needsSetup,true);
  await writeFile(path.join(directory,'package.json'),JSON.stringify({name:'sample',devDependencies:{vite:'1'}}));
  assert.equal((await detectProject(directory)).needsSetup,true);
  await writeFile(path.join(directory,'package-lock.json'),'{}');assert.deepEqual(await detectProject(directory),{name:'sample',kind:'vite'});
  await writeFile(path.join(directory,'package.json'),JSON.stringify({name:'next-app',dependencies:{next:'1'}}));assert.equal((await detectProject(directory)).kind,'next');
});
test('generic review routes preserve query and fragment and reject escape paths',()=>{
  const item={id:'button',title:'Button',steps:['Compare'],path:'/tutorials?tab=one#try'};
  assert.equal(validateManifest({version:2,scenarios:[item]}).scenarios[0].path,item.path);
  for(const route of ['//other.test','/a/../b','/%2e%2e/b','/%2fother.test','/a\\b','javascript:alert(1)'])assert.throws(()=>validateManifest({version:2,scenarios:[{...item,path:route}]}));
});
