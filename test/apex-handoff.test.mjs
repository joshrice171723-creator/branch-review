import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {panelAddress} from '../apex-panel.mjs';
import {readHandoff,returnFindings,selectHandoffBranch,verifyCommittedSources,workbenchMockup,workbenchReview,pushWorkbenchReview} from '../workbench-handoff.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest} from '../reviews.mjs';

test('project panels accept canonical loopback workspace and bound server links',()=>{
  assert.ok(panelAddress('http://127.0.0.1:8794/__workbench/p/0123456789abcdef0123/'));
  assert.ok(panelAddress('http://localhost:8792/__workbench/'));
  for(const url of ['https://example.com/__workbench/','http://localhost:8792/api/','http://u:p@localhost/__workbench/']) {
    assert.throws(()=>panelAddress(url),/loopback/);
  }
});

test('only the exact source commit and selected open findings enter the project inbox',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'apex-review-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const out=path.join(root,'.harness','branch-review','outgoing');
  await mkdir(out,{recursive:true});
  const runId='20261122T024853906396-aaaaaaaa';
  const ref='refs/heads/feature/notes',commit='a'.repeat(40),reviewed='b'.repeat(40);
  const source={kind:'apex-branch-review',version:1,runId,ref,commit,sourceHash:'c'.repeat(64),title:'Review notes'};
  await writeFile(path.join(out,runId+'.json'),JSON.stringify(source));
  const handoff=await readHandoff(root,runId);
  assert.equal(selectHandoffBranch(handoff,[{ref,sha:commit}]).sha,commit);
  assert.throws(()=>selectHandoffBranch(handoff,[{ref,sha:reviewed}]),/moved/);
  const issue={id:'count',expected:'Three notes',actual:'Two notes',scenario:'notes',commit:reviewed,side:'changed',status:'open',location:'/notes'};
  const record={id:'review-1',identity:{source:commit,changed:reviewed,ref},issues:[issue,{...issue,id:'old',status:'resolved'}]};
  await assert.rejects(returnFindings(root,runId,record,['old']),/changed/);
  await assert.rejects(returnFindings(root,runId,{...record,identity:{...record.identity,source:reviewed}},['count']),/match/);
  const [one,two]=await Promise.all([returnFindings(root,runId,record,['count']),returnFindings(root,runId,record,['count'])]);
  assert.equal(one.id,two.id);assert.match(one.scope,/Three notes/);
  const incoming=path.join(root,'.harness','branch-review','incoming',runId);
  assert.deepEqual(await readdir(incoming),[one.id+'.json']);
  const saved=JSON.parse(await readFile(path.join(incoming,one.id+'.json'),'utf8'));
  assert.equal(saved.commit,commit);assert.equal(saved.reviewedCommit,reviewed);
  assert.deepEqual(saved.findings.map(row=>row.id),['count']);
});

test('Workbench reads the human decision for the current source and checklist',async t=>{
  const repository=await mkdtemp(path.join(os.tmpdir(),'workbench-approval-'));
  t.after(()=>rm(repository,{recursive:true,force:true}));
  const out=path.join(repository,'.harness','branch-review','outgoing');
  await mkdir(out,{recursive:true});
  const runId='20261122T024853906396-bbbbbbbb', commit='d'.repeat(40), ref='refs/heads/feature/notes';
  await writeFile(path.join(out,runId+'.json'), JSON.stringify({
    kind:'apex-branch-review',version:1,runId,commit,ref,sourceHash:'a'.repeat(64),title:'Notes'
  }));
  const record={id:'notes',identity:{repository,workbenchRun:runId,ref,source:commit,changed:commit},issues:[],checks:{},
    manifest:{scenarios:[{id:'count',title:'Check notes',steps:['Read the count']}]}};
  const state=(rows=[record],tip=commit)=>workbenchReview(repository,runId,rows,async()=>tip);
  assert.deepEqual((await state([])).slices,[]);
  const loop=path.join(repository,'.harness','loops',runId);
  const design=path.join(repository,'.harness','design'),asset='b'.repeat(32);
  await mkdir(loop,{recursive:true});await mkdir(path.join(design,'assets'),{recursive:true});
  await writeFile(path.join(loop,'design.json'),JSON.stringify({build:'demo'}));
  await writeFile(path.join(design,'workspace.json'),JSON.stringify({builds:[{
    id:'demo',attempts:[{task:runId,slice:'a',outcome:'completed'}],groups:[{sha:commit,slices:['a']}],
    roadmap:[{slices:[{id:'a',title:'Notes'}]}],attachments:{a:asset}
  }]}));
  const png=Buffer.from('89504e470d0a1a0a','hex');
  await writeFile(path.join(design,'assets',asset+'.png'),png);
  assert.deepEqual((await state([])).slices,[{id:'a',title:'Notes',mockup:asset}]);
  assert.deepEqual(await workbenchMockup(repository,runId,'a'),png);
  await assert.rejects(workbenchMockup(repository,runId,'b'),/No mockup/);
  assert.equal((await state([])).status,'waiting');
  assert.equal((await state([{...record,identity:{...record.identity,workbenchRun:'another-run'}}])).status,'waiting');
  assert.equal((await state([{...record,identity:{...record.identity,repository:'another-project'}}])).status,'waiting');
  assert.equal((await state()).status,'reviewing');
  record.approval={identity:digest(record.identity),commit,reviewer:'Test reviewer',at:'2026-11-22'};
  assert.equal((await state()).approval,null);
  record.checks['count:0']=true;
  assert.equal((await state()).status,'approved');
  assert.equal((await state([record],'b'.repeat(40))).status,'branch-changed');
  record.issues.push({id:'missing',scenario:'count',status:'open',actual:'Two notes',expected:'Three notes'});
  assert.equal((await state()).status,'changes-requested');
  record.issues=[];
  record.identity.changed='c'.repeat(40);
  assert.equal((await state()).status,'different-preview');
});

test('handoff permits only the unchanged baseline of the completed Design commit',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'workbench-baseline-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const exec=promisify(execFile);
  const git=async (...args)=>(await exec('git',args,{cwd:root,windowsHide:true})).stdout.trimEnd();
  const put=(name,value)=>writeFile(path.join(root,name),value);
  const receipt=async (name,value)=>{
    await mkdir(path.dirname(path.join(root,name)),{recursive:true});
    await put(name,JSON.stringify(value));
  };
  const hash=text=>createHash('sha256').update(text).digest('hex');
  const firstRun='20261122T024853906396-dddddddd', runId='20261122T024853906396-eeeeeeee', ref='refs/heads/design';
  await git('init','-b','design');
  await git('config','user.name','Fixture'); await git('config','user.email','fixture@example.invalid');
  await put('tracked.txt','Committed');
  await git('add','tracked.txt'); await git('commit','-qm','Baseline');
  await put('tracked.txt','Staged'); await git('add','tracked.txt');
  await put('tracked.txt','Unstaged'); await put('personal.txt','Untracked');
  const commit=await git('rev-parse','HEAD');
  const preserved={'tracked.txt':'MM','personal.txt':'??'};
  const preserved_index={'tracked.txt':[(await git('ls-files','--stage','tracked.txt')).split('\t')[0]]};
  const files={'tracked.txt':hash('Unstaged'),'personal.txt':hash('Untracked')};
  const design={runId,ref,commit,files};
  const loop='.harness/loops/'+runId;
  const check=(evidence=design)=>verifyCommittedSources(root,Object.keys(files),git,evidence);
  await assert.rejects(check(),/Commit project source/);
  await receipt(loop+'/design.json',{branch:'design',build:'build',preserved,preserved_index});
  await receipt(loop+'/state.json',{stage:'completed',design_sha:commit});
  const baselineRecord='.harness/tasks/'+firstRun+'/task.json';
  await receipt(baselineRecord,{id:firstRun,initial_snapshot:{files}});
  await receipt('.harness/design/workspace.json',{builds:[{id:'build',branch:'design',preserved,preserved_index,
    attempts:[{task:firstRun,slice:'a',outcome:'completed'},{task:runId,slice:'b',outcome:'completed'}],
    groups:[{sha:commit,slices:['a','b'],pending:[]}]}]});
  await check();
  await assert.rejects(check({...design,commit:'f'.repeat(40)}),/Commit project source/);
  await assert.rejects(check({...design,files:{...files,'personal.txt':hash('Different')}}),/recorded Design baseline/);
  await receipt(baselineRecord,{id:firstRun,initial_snapshot:{files:{...files,'personal.txt':hash('Original')}}});
  await assert.rejects(check(),/recorded Design baseline/);
  await receipt(baselineRecord,{id:firstRun,initial_snapshot:{files}});
  await put('personal.txt','Changed untracked');
  await assert.rejects(check(),/recorded Design baseline/);
  await put('personal.txt','Untracked');
  await put('tracked.txt','Changed staged'); await git('add','tracked.txt'); await put('tracked.txt','Unstaged');
  await assert.rejects(check(),/recorded Design baseline/);
  await put('tracked.txt','Staged'); await git('add','tracked.txt'); await put('tracked.txt','Unstaged');
  await put('other.txt','Added after the build');
  await assert.rejects(check(),/recorded Design baseline/);
});

test('explicit push sends only the approved commit to its branch',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'workbench-push-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repository=path.join(root,'notes'), remote=path.join(root,'remote.git');
  const runId='20261122T024853906396-cccccccc',ref='refs/heads/notes';
  const url='https://github.com/workbench-tests/notes.git';
  const exec=promisify(execFile);
  await mkdir(repository);
  // Translate only transport calls to the disposable remote. Network protocols are disabled.
  const call=async(args,cwd=repository)=>(await exec('git',args,{cwd,windowsHide:true,
    env:{...process.env,GIT_ALLOW_PROTOCOL:'file',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
  const git=(...args)=>call(['push','ls-remote'].includes(args[0])?args.map(arg=>arg===url?remote:arg):args);
  await git('init','-b','notes'); await call(['init','--bare',remote],root);
  await git('config','user.name','Fixture'); await git('config','user.email','fixture@example.invalid');
  await git('commit','--allow-empty','-m','Notes'); await git('remote','add','origin',url);
  await mkdir(path.join(repository,'.idea'));
  await writeFile(path.join(repository,'.idea','workspace.xml'),'fixture IDE state');
  await writeFile(path.join(repository,'.gitignore'),'cache/\n');
  await mkdir(path.join(repository,'cache'));
  await writeFile(path.join(repository,'cache','local.txt'),'local data');
  await git('add','.gitignore');await git('commit','-m','Ignore local cache');
  await verifyCommittedSources(repository,['.gitignore','.idea/workspace.xml','cache/local.txt'],git);
  await writeFile(path.join(repository,'new-feature.js'),'const enabled=true;');
  await assert.rejects(verifyCommittedSources(repository,['new-feature.js'],git),/new-feature.js/);
  const commit=await git('rev-parse','HEAD');
  const directory=path.join(repository,'.harness','branch-review','outgoing');
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,runId+'.json'),JSON.stringify({kind:'apex-branch-review',version:1,
    runId,ref,commit,sourceHash:'a'.repeat(64),title:'Notes'}));
  const identity={repository,workbenchRun:runId,source:commit,changed:commit,ref};
  const record={id:'notes',identity,manifest:{scenarios:[{id:'count',title:'Count',steps:['Count notes']}]},
    checks:{'count:0':true},issues:[],approval:null};
  const target='workbench-tests/notes';
  const push=()=>pushWorkbenchReview(repository,runId,commit,[record],git,target);
  await assert.rejects(push(),/Approve/);
  assert.equal(await git('ls-remote','--heads',url),'');
  record.approval={identity:digest(identity),commit,reviewer:'Fixture',at:'2026-11-22'};
  assert.equal((await workbenchReview(repository,runId,[record],git)).pushTarget,target);
  await assert.rejects(pushWorkbenchReview(repository,runId,commit,[record],git,'workbench-tests/different'),/destination changed/);
  assert.equal(await git('ls-remote','--heads',url),'');
  const result=await push();
  assert.equal(result.ref,ref);assert.equal(result.commit,commit);
  assert.equal(await git('ls-remote','--heads',url),commit+'\t'+ref);
  await git('commit','--allow-empty','-m','Next revision');
  await assert.rejects(push(),/Approve/);
  assert.equal(await git('ls-remote','--heads',url),commit+'\t'+ref);
  const next=await git('rev-parse','HEAD'), nextId='20261122T024853906396-dddddddd';
  const remoteChange=await git('commit-tree',await git('rev-parse','HEAD^{tree}'),'-p',commit,'-m','Independent remote change');
  await git('push',url,remoteChange+':'+ref);
  await writeFile(path.join(directory,nextId+'.json'),JSON.stringify({kind:'apex-branch-review',version:1,
    runId:nextId,ref,commit:next,sourceHash:'b'.repeat(64),title:'Next revision'}));
  const nextIdentity={...identity,workbenchRun:nextId,source:next,changed:next};
  const nextRecord={...record,identity:nextIdentity,approval:{...record.approval,identity:digest(nextIdentity),commit:next}};
  await assert.rejects(pushWorkbenchReview(repository,nextId,next,[nextRecord],git,target),/rejected|non-fast-forward/i);
  assert.equal(await git('ls-remote','--heads',url),remoteChange+'\t'+ref);
});
