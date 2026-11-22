import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {isDeepStrictEqual, promisify} from 'node:util';
import {link, lstat, mkdir, readFile, readdir, readlink, realpath, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './reviews.mjs';
import {canApprove, itemStatus} from './public/review-model.js';

const runPattern = /^\d{8}T\d{12}-[0-9a-f]{8}$/;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const hashPattern = /^[0-9a-f]{64}$/;
const policyFile='workbench-quality.json';
const execute = promisify(execFile);

async function cli(root,...args) {
  const result = await execute(process.env.HARNESS_RUBY || 'ruby',[path.join(root,'.harness','bin','harness'),...args,'--project',root],
    {cwd:root, windowsHide:true, maxBuffer:32*1024*1024, timeout:120000});
  return JSON.parse(result.stdout);
}

async function inbox(root,parts) {
  let directory=await realpath(root);
  for(const part of parts) {
    directory=path.join(directory,part);
    await mkdir(directory).catch(error=>{if(error.code!=='EEXIST') throw error;});
    if(await realpath(directory)!==directory || !(await stat(directory)).isDirectory()) throw Error('Invalid Workbench directory.');
  }
  return directory;
}

async function immutableJson(directory,filename,value,match) {
  const temp=path.join(directory,randomUUID()+'.tmp');
  await writeFile(temp,JSON.stringify(value,null,2),{flag:'wx'});
  try {await link(temp,path.join(directory,filename));}
  catch(error) {
    if(error.code!=='EEXIST') throw error;
    if (!match(await ownedFile(directory,filename))) throw Error('A different Workbench receipt already exists.');
  } finally {await unlink(temp);}
}

export async function completedRuns(repository) {
  const root=await realpath(repository);
  const {runs}=await cli(root,'runs','list');
  return runs.filter(row=>row.lifecycle?.status==='completed').map(({id,action})=>({id,title:action}));
}

export async function exportHandoff(repository,runId,git) {
  if(typeof runId!=='string' || !runPattern.test(runId)) throw Error('Choose a completed Workbench run.');
  const root=await realpath(repository);
  const current=await cli(root,'task','status','--id',runId);
  const digest=current.lifecycle?.snapshot_sha256;
  if(current.lifecycle?.status!=='completed' || !/^[0-9a-f]{64}$/.test(digest) ||
      current.snapshot_sha256!==digest) throw Error('This checkout differs from the completed run.');
  const evidence=path.join(root,'.harness','tasks',runId,'snapshots');
  let snapshot;
  for(const name of [digest.slice(0,20),digest]) {
    try { snapshot=await ownedFile(evidence,name+'.json',64_000_000); if(snapshot.snapshot_sha256===digest) break; }
    catch(error){if(error.code!=='ENOENT') throw error;}
  }
  if(snapshot?.snapshot_sha256!==digest || !snapshot.files) throw Error('The completed snapshot is missing.');
  const ref=await git('symbolic-ref','--quiet','HEAD');
  const commit=await git('rev-parse','HEAD');
  if(!ref.startsWith('refs/heads/') || !commitPattern.test(commit)) throw Error('Check out the committed branch for this run.');
  const design=await reviewGroup(root,{runId,ref,commit},git);
  await verifyCommittedSources(root,Object.keys(snapshot.files),git,{runId,ref,commit,files:snapshot.files});
  if(await git('rev-parse','HEAD')!==commit || await git('symbolic-ref','--quiet','HEAD')!==ref) throw Error('The checkout changed during handoff.');
  const record={kind:'apex-branch-review',version:1,runId,ref,commit,sourceHash:digest,title:current.action,
    ...(design && {design:design.identity}),...(current.quality_revision && {qualityRevision:current.quality_revision})};
  const directory=await inbox(root,['.harness','branch-review','outgoing']);
  await immutableJson(directory,runId+'.json',record,old=>old.commit===commit && old.ref===ref && old.sourceHash===digest &&
    (!old.design || isDeepStrictEqual(old.design,record.design)) &&
    (!old.qualityRevision || old.qualityRevision===record.qualityRevision));
  return record;
}

export async function verifyCommittedSources(root, names, git, design) {
  const baseline=design && await designBaseline(root,design);
  if (baseline) {
    await verifyDesignBaseline(root,baseline,design.files);
    return;
  }
  const {stdout}=await execute('git',['ls-files','--others','--exclude-standard','-z'],
    {cwd:root,windowsHide:true,maxBuffer:64*1024*1024});
  const untracked=new Set(stdout.split('\0'));
  const missing=names.find(name=>untracked.has(name) && !name.startsWith('.idea/'));
  if(missing)throw Error('Commit project source before opening Branch Review: '+missing);
  if(await git('status','--porcelain','--untracked-files=no'))throw Error('Commit the pending tracked changes before opening Branch Review.');
}

async function designBaseline(root,{runId,ref,commit}) {
  const folder=path.join('.harness','loops',runId);
  try {
    const mark=await ownedFile(root,path.join(folder,'design.json'));
    if ('refs/heads/'+mark.branch!==ref || !Object.keys(mark.preserved || {}).length) return null;
    const loop=await ownedFile(root,path.join(folder,'state.json'));
    if (loop.stage!=='completed' || loop.design_sha!==commit) return null;
    const workspace=await ownedFile(root,path.join('.harness','design','workspace.json'),32_000_000);
    const build=workspace.builds?.find(item=>item.id===mark.build && item.branch===mark.branch);
    const attempt=build?.attempts.findLast(item=>item.task===runId && item.outcome==='completed');
    if (!attempt || !build.groups.some(group=>group.sha===commit && group.pending?.length===0 &&
      group.slices.includes(attempt.slice))) return null;
    if (!mark.preserved_index || !isDeepStrictEqual(mark.preserved,build.preserved) ||
        !isDeepStrictEqual(mark.preserved_index,build.preserved_index)) return null;
    const first=build.attempts[0]?.task;
    if (!runPattern.test(first)) return null;
    const task=await ownedFile(root,path.join('.harness','tasks',first,'task.json'),64_000_000);
    if (task.id!==first || !task.initial_snapshot?.files) return null;
    const files={...task.initial_snapshot.files};
    const policyPinned=Object.hasOwn(mark.preserved,policyFile);
    if(policyPinned){
      const hash=mark.preservedPolicySha;
      if((hash!==null && !hashPattern.test(hash)) || hash!==build.preservedPolicySha) {
        throw Error('The Design build lacks a matching record of its uncommitted policy file.');
      }
      if(hash===null) delete files[policyFile];
      else files[policyFile]=hash;
    }
    return {status:mark.preserved,index:mark.preserved_index,files,policyPinned};
  } catch (error) {
    if (error.code==='ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function verifyDesignBaseline(root,baseline,files) {
  const gitOutput=async (...args)=>(await execute('git',args,
    {cwd:root,windowsHide:true,maxBuffer:64*1024*1024})).stdout.split('\0').filter(Boolean);
  const readStatus=async ()=>Object.fromEntries((await gitOutput('status','--porcelain','-z','--no-renames','--untracked-files=all'))
    .filter(row=>!row.startsWith('?? .harness/') && !row.startsWith('?? .idea/'))
    .map(row=>[row.slice(3),row.slice(0,2)]));
  const changed=()=>Error('The working changes differ from the recorded Design baseline.');
  if (!isDeepStrictEqual(await readStatus(),baseline.status)) throw changed();
  for (const [name,status] of Object.entries(baseline.status)) {
    const expected=Object.hasOwn(baseline.files,name)?baseline.files[name]:undefined;
    const completed=baseline.policyPinned && name===policyFile?expected:
      Object.hasOwn(files,name)?files[name]:undefined;
    if (expected!==completed) throw changed();
    const file=path.join(root,name);
    const entry=await lstat(file).catch(error=>{if(error.code!=='ENOENT') throw error; return null;});
    if (!entry && expected===undefined && status.includes('D')) continue;
    if (!entry || typeof expected!=='string') throw changed();
    const hash=createHash('sha256');
    if (entry.isSymbolicLink()) hash.update('symlink:').update(await readlink(file,{encoding:'buffer'}));
    else if (entry.isFile()) hash.update(await readFile(file));
    else throw changed();
    if (hash.digest('hex')!==expected) throw changed();
  }
  const index=new Map();
  for (const row of await gitOutput('ls-files','--stage','-z')) {
    const split=row.indexOf('\t'), name=row.slice(split+1);
    if (!Object.hasOwn(baseline.status,name)) continue;
    if (!index.has(name)) index.set(name,[]);
    index.get(name).push(row.slice(0,split));
  }
  if (!isDeepStrictEqual(Object.fromEntries(index),baseline.index)) throw changed();
  if (!isDeepStrictEqual(await readStatus(),baseline.status)) throw changed();
}

async function ownedFile(root, relative,limit=2_000_000) {
  const file = path.join(root, relative);
  if (await realpath(file) !== file || !(await stat(file)).isFile()) throw new Error('Invalid Workbench record.');
  const size = (await stat(file)).size;
  if (size > limit) throw new Error('The Workbench record exceeds the supported size.');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readHandoff(repository, runId) {
  if (typeof runId !== 'string' || !runPattern.test(runId)) throw new Error('Choose a valid Workbench run.');
  const root = await realpath(repository);
  let handoff;
  try {
    handoff = await ownedFile(root, path.join('.harness', 'branch-review', 'outgoing', runId + '.json'));
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Open Branch Review for this completed run first.'),{code:'HANDOFF_MISSING'});
    throw error;
  }
  if (handoff.kind !== 'apex-branch-review' || handoff.version !== 1 || handoff.runId !== runId ||
      !commitPattern.test(handoff.commit) || !/^[a-f0-9]{64}$/.test(handoff.sourceHash) ||
      typeof handoff.ref !== 'string' || !handoff.ref.startsWith('refs/heads/') ||
      typeof handoff.title !== 'string') throw new Error('This Workbench handoff is incomplete.');
  return {runId, ref:handoff.ref, commit:handoff.commit, sourceHash:handoff.sourceHash, title:handoff.title,
    ...(handoff.design && {design:handoff.design}),...(handoff.qualityRevision && {qualityRevision:handoff.qualityRevision})};
}

export function selectHandoffBranch(handoff, inventory) {
  const branch = inventory.find(item => item.ref === handoff.ref || item.aliases?.includes(handoff.ref));
  if (!branch || branch.sha !== handoff.commit) throw new Error('The branch moved or was removed. Select a run for the current commit.');
  return branch;
}

export async function workbenchReview(repository, runId, records, git) {
  let handoff;
  try {handoff=await readHandoff(repository,runId);}
  catch(error) {
    if(error.code==='HANDOFF_MISSING') return {runId,status:'not-exported',message:error.message};
    throw error;
  }
  const result={runId,ref:handoff.ref,commit:handoff.commit,status:'waiting',slices:[],checklist:[],findings:[]};
  let design,tipMatches;
  try {[design,tipMatches]=await Promise.all([reviewGroup(repository,handoff,git),currentTip(handoff,git)]);}
  catch(error) {
    if(error.code==='DESIGN_STALE') return {...result,status:'design-stale',message:error.message};
    throw error;
  }
  result.slices=design?.slices || [];
  result.base=design?.identity.base || null;
  if (design?.task) {
    result.taskBuild = design.identity.build;
    result.approvedPlan = design.task.plan;
  }
  if (!tipMatches) return {...result,status:'branch-changed'};
  const record = records.findLast(({identity}) => identity.workbenchRun === runId &&
    identity.repository === repository && identity.ref === handoff.ref && identity.source === handoff.commit &&
    (!design || identity.base === result.base));
  if (!record) return result;
  const reviewedCommit = record.identity.changed;
  const checklist = record.manifest.scenarios.map(item => ({id:item.id, title:item.title, status:itemStatus(record,item)}));
  const findings = record.issues.filter(issue => issue.status !== 'resolved').map(findingDetails);
  const rubric=await workbenchRubric(repository,runId);
  const approved = reviewedCommit === handoff.commit && record.approval?.commit === reviewedCommit &&
    record.approval.identity === digest(record.identity) && canApprove(record) && rubricComplete(record,rubric);
  const status = findings.length ? 'changes-requested' : approved ? 'approved' :
    reviewedCommit === handoff.commit ? 'reviewing' : 'different-preview';
  let destination,pushMessage;
  if(approved) {
    try {destination=await githubTarget(git,handoff.ref);}
    catch(error){pushMessage=error.message;}
  }
  let delivery=record.workbenchDelivery?.commit===reviewedCommit ? record.workbenchDelivery : null;
  if(delivery?.github && delivery.githubApprovalHash!==digest(record.approval)) delivery={...delivery,github:null};
  return {...result, status, reviewId:record.id, reviewedCommit, checklist, findings,
    base:record.identity.base,pushTarget:destination?.repository || null,pushMessage,delivery,
    evidenceUrl:approved ? '/api/workbench-evidence?'+new URLSearchParams({run:runId}) : null,
    approval:approved ? {reviewer:record.approval.reviewer, at:record.approval.at} : null};
}

function currentTip(handoff,git) {
  return git('rev-parse','--verify',handoff.ref).then(tip=>tip===handoff.commit,()=>false);
}

function staleDesign() {
  return Object.assign(Error('This Design group changed. Complete the current group and review its commit.'),{code:'DESIGN_STALE'});
}

async function reviewGroup(repository,handoff,git) {
  const root=await realpath(repository);
  let marker,workspace;
  try {
    marker=await ownedFile(root,path.join('.harness','loops',handoff.runId,'design.json'));
    workspace=await ownedFile(root,path.join('.harness','design','workspace.json'),32_000_000);
  } catch(error) {
    if(error.code==='ENOENT' && !marker && !handoff.design) return null;
    if(error.code==='ENOENT') throw staleDesign();
    throw error;
  }
  const build=workspace.builds?.find(b=>b.id===marker.build);
  if(!build || build.retired || build.status==='retired' || !Number.isSafeInteger(build.revision) ||
      workspace.approved!==build.revision || workspace.revision!==build.revision ||
      marker.branch!==build.branch || handoff.ref!=='refs/heads/'+build.branch) throw staleDesign();
  const attempt=build.attempts.find(a=>a.task===handoff.runId && a.outcome==='completed');
  const group=attempt && build.groups.find(g=>g.slices.includes(attempt.slice));
  const final=group && build.attempts.findLast(a=>a.outcome==='completed' && group.slices.includes(a.slice));
  if(!group || final?.task!==handoff.runId || group.sha!==handoff.commit || group.pending?.length!==0 ||
      group.findings?.some(finding=>!finding.repaired) ||
      !commitPattern.test(group.base) || group.base===handoff.commit) throw staleDesign();
  const identity={build:build.id,base:group.base,slices:group.slices};
  if(handoff.design && !isDeepStrictEqual(handoff.design,identity)) throw staleDesign();
  try {
    if(await git('merge-base',group.base,handoff.commit)!==group.base) throw staleDesign();
  } catch {throw staleDesign();}
  const slices=build.roadmap.flatMap(m=>m.slices);
  const task = build.mode === 'task' ? {title:build.title, plan:build.plan} : null;
  return {identity,task,slices:group.slices.map(id=>{
    const asset=build.attachments?.[id];
    return {id,title:slices.find(slice=>slice.id===id)?.title || id,mockup:/^[a-f0-9]{32}$/.test(asset)?asset:null};
  })};
}

export async function workbenchComparison(repository,runId,git) {
  const handoff=await readHandoff(repository,runId);
  if(!await currentTip(handoff,git)) throw Error('The branch moved. Review the current commit.');
  const design=await reviewGroup(repository,handoff,git);
  let base=design?.identity.base;
  if(!base) {
    const defaultRef=await git('symbolic-ref','--quiet','refs/remotes/origin/HEAD').catch(()=>null);
    for(const ref of [defaultRef,'refs/remotes/origin/main','refs/remotes/origin/master','refs/heads/main','refs/heads/master']) {
      if(!ref || ref===handoff.ref) continue;
      base=await git('merge-base',ref,handoff.commit).catch(()=>null);
      if(base && base!==handoff.commit) break;
    }
    if(!base || base===handoff.commit) base=await git('rev-parse','--verify',handoff.commit+'^').catch(()=>null);
    if(!base) throw Error('This commit needs a local comparison base. Add its parent history and retry.');
  }
  const subject=await git('show','-s','--format=%s',handoff.commit);
  const branch={ref:handoff.ref,sha:handoff.commit,subject,name:handoff.ref.slice('refs/heads/'.length),aliases:[],remote:false};
  return {handoff,branch,base,design};
}

export function taskChecklist(task) {
  const lines = task.plan.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*(?:#{1,6}\s*)?acceptance criteria\s*:?\s*$/i.test(line));
  const acceptance = [];
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^\s*#{1,6}\s/.test(line)) break;
      const item = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
      if (item) acceptance.push(item[1].trim());
    }
  }
  const title = task.title.trim().slice(0,160);
  const scenarios = (acceptance.length ? acceptance : [title]).slice(0,80).map((expected,index)=>({
    id:'acceptance-'+(index+1),title:expected.slice(0,160),path:'/',
    description:task.plan.slice(0,2000),expected:expected.slice(0,2000),
    steps:[acceptance.length ? expected.slice(0,500) : 'Check the changed app against the approved plan.']
  }));
  return {version:2,title,summary:task.plan.slice(0,2000),source:'Approved change plan',scenarios};
}

export function designChecklist(slices) {
  return {version:2,title:'Design group review',summary:'Review each approved slice against the recorded base.',
    source:'Approved Workbench Design slices',scenarios:slices.map(({title},index)=>({
      id:'slice-'+(index+1),title:title.slice(0,160),path:'/',expected:title.slice(0,2000),
      steps:['Compare the changed behavior with the Original preview.',
        'Check that the Changed preview meets the slice requirements.']
    }))};
}

export async function workbenchRubric(repository,runId) {
  const handoff=await readHandoff(repository,runId);
  const quality=await pinnedQuality(repository,handoff);
  const rubric=quality?.definition.rubrics?.find(row=>row.actor==='human' && row.stage==='branch_review');
  if(!rubric) return [];
  return rubric.criteria.map(({id,description,required},index)=>({
    criterionId:id,required,scenario:{
      id:'quality-criterion-'+(index+1),title:description.slice(0,160).trim(),expected:description,path:'/',
      steps:['Confirm this criterion in the Changed preview.']
    }
  }));
}

export function applyWorkbenchRubric(plan,rubric) {
  if(!Array.isArray(plan?.scenarios)) throw Error('Enter a valid review checklist.');
  const byId=new Map(rubric.map(({scenario})=>[scenario.id,scenario]));
  const scenarios=plan.scenarios.filter(item=>!byId.has(item.id));
  for(const {scenario} of rubric) {
    const route=plan.scenarios.find(item=>item.id===scenario.id)?.path;
    scenarios.push({...scenario,path:route || scenario.path});
  }
  return {...plan,scenarios};
}

export function rubricComplete(record,rubric) {
  return rubric.every(({scenario,required})=>{
    const item=record.manifest.scenarios.find(item=>item.id===scenario.id);
    return item?.title===scenario.title && item?.expected===scenario.expected &&
      isDeepStrictEqual(item.steps,scenario.steps) && (!required || itemStatus(record,item)==='passed');
  });
}

export async function validateWorkbenchPreview(repository,identity,git) {
  const handoff=await readHandoff(repository,identity.workbenchRun);
  if(identity.source!==handoff.commit || identity.changed!==handoff.commit || identity.ref!==handoff.ref ||
      !await currentTip(handoff,git)) throw Error('The branch moved. Review the current commit.');
  const design=await reviewGroup(repository,handoff,git);
  if(design && design.identity.base!==identity.base) throw Error('Open this group again to review its recorded base commit.');
}

export async function approvedWorkbenchEvidence(repository,runId,records,git) {
  const review=await workbenchReview(repository,runId,records,git);
  if(review.status!=='approved') {
    throw Error(review.message || 'Approve this exact Workbench commit before exporting its evidence.');
  }
  const handoff=await readHandoff(repository,runId);
  const record=records.find(item=>item.id===review.reviewId);
  const checklist=record.manifest.scenarios.map(item=>({
    id:item.id,title:item.title,route:item.path,status:itemStatus(record,item),
    reason:record.items?.[item.id]?.reason || '',
    steps:item.steps.map((text,index)=>({text,passed:record.checks[`${item.id}:${index}`]===true}))
  }));
  const checklistHash=digest(record.manifest);
  const quality=await workbenchQualityEvidence(repository,handoff);
  const rubric=(await workbenchRubric(repository,runId)).map(({criterionId,required,scenario})=>({
    criterionId,required,checklistItem:scenario.id
  }));
  const result={kind:'branch-review-evidence',version:1,runId,reviewId:review.reviewId,ref:handoff.ref,
    base:review.base,commit:review.commit,sourceHash:handoff.sourceHash,checklistHash,quality,rubric,
    result:'approved',approval:review.approval,checklist,
    slices:review.slices.map(({id,title})=>({id,title})),
    findings:record.issues.map(issue=>({...findingDetails(issue),resolution:issue.resolution,
      resolvedCommit:issue.resolvedCommit,resolvedAt:issue.resolvedAt}))};
  return {...result,evidenceHash:digest(result),delivery:review.delivery};
}

export async function draftWorkbenchPullRequest(repository,runId,records,git) {
  const evidence=await approvedWorkbenchEvidence(repository,runId,records,git);
  const handoff=await readHandoff(repository,runId);
  const cleanTitle=handoff.title.replace(/\s+/g,' ').trim();
  const passed=evidence.checklist.filter(item=>item.status==='passed').length;
  const excluded=evidence.checklist.length-passed;
  const summary=evidence.slices.map(slice=>'- '+slice.title.replace(/\s+/g,' ').trim());
  const quality=evidence.quality;
  const body=[
    '## Summary','',...(summary.length?summary:[cleanTitle || 'Review the changes for this Workbench run.']),'',
    '## Review evidence','',
    '- Commit: '+evidence.commit,'- Base: '+evidence.base,
    '- Manual review: '+passed+' passed, '+excluded+' not applicable.',
    '- Checklist fingerprint: '+evidence.checklistHash,
    quality.revision?'- Workbench Quality policy: '+quality.revision:'- Workbench Quality policy: No policy recorded.',
    ...quality.benchmarks.map(row=>'- Benchmark '+row.check+': '+row.status),
    '- Evidence fingerprint: '+evidence.evidenceHash,
    ...(evidence.delivery?.github ? ['- GitHub evidence: '+evidence.delivery.github.evidenceUrl] : [])
  ].join('\n');
  return {title:cleanTitle.slice(0,200) || 'Reviewed Workbench changes',body,commit:evidence.commit};
}

async function pinnedQuality(repository,handoff) {
  const root=await realpath(repository);
  const directory=path.join('.harness','tasks',handoff.runId);
  let task;
  try {task=await ownedFile(root,path.join(directory,'task.json'),64_000_000);}
  catch(error){if(error.code!=='ENOENT') throw error;}
  if(!task?.quality && !handoff.qualityRevision) return null;
  const quality=task?.quality;
  if(task?.id!==handoff.runId || !hashPattern.test(quality?.revision) ||
      (handoff.qualityRevision && handoff.qualityRevision!==quality.revision) ||
      !Array.isArray(quality.definition?.benchmarks) || !Array.isArray(quality.definition?.checks)) {
    throw Error('The review lacks its pinned Workbench Quality receipt.');
  }
  return quality;
}

async function workbenchQualityEvidence(repository,handoff) {
  const quality=await pinnedQuality(repository,handoff);
  if(!quality) return {status:'not-recorded',benchmarks:[]};
  const root=await realpath(repository);
  const directory=path.join('.harness','tasks',handoff.runId);
  const benchmarks=[];
  for(const definition of quality.definition.benchmarks) {
    const id=definition.check_id;
    if(typeof id!=='string' || !/^[\w-]{1,80}$/.test(id)) throw Error('Invalid pinned benchmark ID.');
    const check=quality.definition.checks.find(check=>check.id===id);
    const phases=check?.phases || ['baseline','after'];
    if(!phases.includes('after')) continue;
    const relative=path.join(directory,'results',id,'after');
    const folder=path.join(root,relative);
    let entries=[];
    try {
      if(await realpath(folder)!==folder) throw Error('Invalid Workbench benchmark receipt.');
      entries=(await readdir(folder)).filter(entry=>runPattern.test(entry)).sort().reverse();
    } catch(error){if(error.code!=='ENOENT') throw error;}
    let receipt;
    for(const entry of entries) {
      try {receipt=await ownedFile(root,path.join(relative,entry,'result.json'));}
      catch(error){if(error.code==='ENOENT') continue;throw error;}
      if(receipt.check===id && receipt.phase==='after' && receipt.quality_revision===quality.revision &&
          receipt.source_before_sha256===handoff.sourceHash && receipt.source_after_sha256===handoff.sourceHash &&
          receipt.source_changed===false) break;
      receipt=null;
    }
    const measurement=receipt?.measurement;
    benchmarks.push({
      check:id,phase:'after',status:receipt ? (receipt.exit_code===0 && measurement?.status==='passed'?'passed':'failed') : 'missing',
      benchmarkContractHash:receipt?.benchmark_contract_sha256 || null,
      metrics:(measurement?.metrics || []).map(({id,unit,aggregate,value,samples})=>({id,unit,aggregate,value,samples})),
      thresholds:(measurement?.thresholds || []).map(({metric,op,value,actual,passed})=>({metric,op,value,actual,passed}))
    });
  }
  return {status:'recorded',revision:quality.revision,benchmarks};
}

export async function workbenchMockup(repository,runId,sliceId,git) {
  const handoff=await readHandoff(repository,runId);
  const design=await reviewGroup(repository,handoff,git);
  const slice=design?.slices.find(s=>s.id===sliceId);
  if(!slice?.mockup)throw Error('No mockup is attached to this reviewed slice.');
  const root=await realpath(repository);
  const file=path.join(root,'.harness','design','assets',slice.mockup+'.png');
  if(await realpath(file)!==file || (await stat(file)).size>32*1024*1024)throw Error('Invalid project mockup.');
  const data=await readFile(file);
  if(data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid project mockup.');
  return data;
}

async function githubTarget(git,ref) {
  const branch=ref.slice('refs/heads/'.length);
  await git('check-ref-format','--branch',branch);
  // Push the branch named on the review. Use its configured push remote, or origin for new branches.
  const readSetting = async key => (await git('config','--get',key).catch(() => '')).trim();
  const remote = await readSetting('branch.'+branch+'.pushRemote') || await readSetting('remote.pushDefault') ||
    await readSetting('branch.'+branch+'.remote') || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) throw Error('Configure a GitHub push remote for this branch.');
  const address = (await git('remote','get-url','--push','--all',remote)).trim();
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+\/?$/i.test(address))
    throw Error('Select a remote with one GitHub push URL.');
  const repository=address.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i,'').replace(/\/$/,'').replace(/\.git$/i,'').toLowerCase();
  return {remote,address,repository};
}

export async function pushWorkbenchReview(repository,runId,expectedCommit,records,git,expectedTarget) {
  const review=await workbenchReview(repository,runId,records,git);
  if(review.status!=='approved' || review.commit!==expectedCommit)
    throw Error(review.message || 'Approve the current source commit in Branch Review before pushing.');
  const target=await githubTarget(git,review.ref);
  if(!expectedTarget || target.repository!==expectedTarget)
    throw Error('The GitHub destination changed. Refresh the review and confirm its destination.');
  await validateWorkbenchPreview(repository,{workbenchRun:runId,ref:review.ref,source:expectedCommit,
    changed:expectedCommit,base:review.base},git);
  const {address,remote}=target;
  await git('push','--no-follow-tags','--recurse-submodules=no','--',address,expectedCommit+':'+review.ref);
  const observed=(await git('ls-remote','--refs','--',address,review.ref)).trim().split(/\s+/);
  if(observed[0]!==expectedCommit || observed[1]!==review.ref)
    throw Error('GitHub has not confirmed this commit. Check the remote branch before retrying.');
  return {reviewId:review.reviewId,commit:expectedCommit,ref:review.ref,remote,repository:target.repository};
}

function findingDetails({id,scenario,actual,expected,side,location,commit,status}) {
  return {id,scenario,actual,expected,side,location:location || '',commit,status};
}

export async function returnFindings(repository, runId, record, selectedIds, git) {
  const handoff = await readHandoff(repository, runId);
  if (record.identity.source !== handoff.commit || record.identity.changed !== handoff.commit ||
      record.identity.ref !== handoff.ref || record.identity.workbenchRun !== runId) {
    throw new Error('Open the exact Workbench review for this branch and commit to return findings.');
  }
  if(await reviewGroup(repository,handoff,git)) throw Error('Select the findings and affected slices in Design to repair this group.');
  if(!await currentTip(handoff,git)) throw Error('The branch moved. Review the current commit.');
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 100 ||
      !selectedIds.every(id => typeof id === 'string') || new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('Select between 1 and 100 distinct findings.');
  }
  const findings = [...selectedIds].sort().map(id => {
    const issue = record.issues.find(row => row.id === id && row.status !== 'resolved');
    if (!issue) throw new Error('A selected finding changed. Refresh the review and select it again.');
    return findingDetails(issue);
  });
  const payload = {kind:'branch-review-findings', version:1, runId, sourceHash:handoff.sourceHash,
    ref:handoff.ref, commit:handoff.commit, reviewId:record.id, reviewedCommit:record.identity.changed, findings};
  const id = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const directory=await inbox(repository,['.harness','branch-review','incoming',runId]);
  await immutableJson(directory,id+'.json',{...payload,id,createdAt:new Date().toISOString()},old=>old.id===id && old.runId===runId);
  const scope=findings.map(issue=>[
    issue.location || issue.scenario || issue.id, 'Expected: '+issue.expected,'Observed: '+issue.actual
  ].join('\n')).join('\n\n');
  return {id,count:findings.length,action:'Address selected findings from Branch Review',scope,
    reference:'.harness/branch-review/incoming/'+runId+'/'+id+'.json'};
}

export async function createRepair(repository,{runId,receipt,action,scope},git) {
  const root=await realpath(repository);
  const run=await readHandoff(root,runId);
  if(await reviewGroup(root,run,git)) throw Error('Select the findings and affected slices in Design to repair this group.');
  if(!/^[a-f0-9]{64}$/.test(receipt)) throw Error('Select a saved group of findings.');
  const incoming=await ownedFile(root,path.join('.harness','branch-review','incoming',runId,receipt+'.json'));
  const {id,createdAt,...payload}=incoming;
  if(id!==receipt || digest(payload)!==receipt || incoming.runId!==runId || incoming.commit!==run.commit ||
      incoming.reviewedCommit!==run.commit || incoming.ref!==run.ref || incoming.sourceHash!==run.sourceHash) {
    throw Error('Prepare the selected findings again for this run.');
  }
  if(await git('rev-parse','HEAD')!==run.commit || await git('symbolic-ref','--quiet','HEAD')!==run.ref) {
    throw Error('Check out the reviewed project branch and commit before creating its repair task.');
  }
  const current=await cli(root,'task','status','--id',runId);
  if(current.lifecycle?.status!=='completed' || current.snapshot_sha256!==run.sourceHash) {
    throw Error('The project source changed after review. Select a run for the current source.');
  }
  if(typeof action!=='string' || !action.trim() || action.length>4000 ||
      typeof scope!=='string' || !scope.trim() || scope.length>16000) throw Error('Enter an action and scope within the displayed limits.');
  await accessProfile(root);
  const reference='.harness/branch-review/incoming/'+runId+'/'+receipt+'.json';
  return cli(root,'feature','--action',action.trim(),'--scope',scope.trim()+'\nReview evidence: '+reference,'--answer-channel','form');
}

async function accessProfile(root) {
  if(!(await stat(path.join(root,'.harness','profile.json')).catch(()=>null))?.isFile() ||
      await stat(path.join(root,'.harness','profile.disabled')).catch(()=>null)) {
    throw Error('Apply a profile in Workbench Design before creating the repair task.');
  }
}
