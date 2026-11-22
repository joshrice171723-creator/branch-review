import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {link, mkdir, readFile, realpath, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './reviews.mjs';
import {canApprove, itemStatus} from './public/review-model.js';

const runPattern = /^\d{8}T\d{12}-[0-9a-f]{8}$/;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const execute = promisify(execFile);

async function cli(root,...args) {
  const result = await execute('ruby',[path.join(root,'.harness','bin','harness'),...args,'--project',root],
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
  await verifyCommittedSources(root,Object.keys(snapshot.files),git);
  if(await git('rev-parse','HEAD')!==commit || await git('symbolic-ref','--quiet','HEAD')!==ref) throw Error('The checkout changed during handoff.');
  const record={kind:'apex-branch-review',version:1,runId,ref,commit,sourceHash:digest,title:current.action};
  const directory=await inbox(root,['.harness','branch-review','outgoing']);
  await immutableJson(directory,runId+'.json',record,old=>old.commit===commit && old.ref===ref && old.sourceHash===digest);
  return record;
}

export async function verifyCommittedSources(root, names, git) {
  const {stdout}=await execute('git',['ls-files','--others','--exclude-standard','-z'],
    {cwd:root,windowsHide:true,maxBuffer:64*1024*1024});
  const untracked=new Set(stdout.split('\0'));
  const missing=names.find(name=>untracked.has(name) && !name.startsWith('.idea/'));
  if(missing)throw Error('Commit project source before opening Branch Review: '+missing);
  if(await git('status','--porcelain','--untracked-files=no'))throw Error('Commit the pending tracked changes before opening Branch Review.');
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
    if (error.code === 'ENOENT') throw new Error('Open the repository that exported this Workbench run.');
    throw error;
  }
  if (handoff.kind !== 'apex-branch-review' || handoff.version !== 1 || handoff.runId !== runId ||
      !commitPattern.test(handoff.commit) || !/^[a-f0-9]{64}$/.test(handoff.sourceHash) ||
      typeof handoff.ref !== 'string' || !handoff.ref.startsWith('refs/heads/') ||
      typeof handoff.title !== 'string') throw new Error('This Workbench handoff is incomplete.');
  return {runId, ref:handoff.ref, commit:handoff.commit, sourceHash:handoff.sourceHash, title:handoff.title};
}

export function selectHandoffBranch(handoff, inventory) {
  const branch = inventory.find(item => item.ref === handoff.ref || item.aliases?.includes(handoff.ref));
  if (!branch || branch.sha !== handoff.commit) throw new Error('The branch moved or was removed. Select a run for the current commit.');
  return branch;
}

export async function workbenchReview(repository, runId, records, git) {
  const handoff = await readHandoff(repository, runId);
  const record = records.findLast(({identity}) => identity.workbenchRun === runId &&
    identity.repository === repository && identity.ref === handoff.ref && identity.source === handoff.commit);
  const tip = await git('rev-parse','--verify',handoff.ref).catch(() => null);
  const slices=await reviewSlices(repository,handoff);
  const result = {runId, ref:handoff.ref, commit:handoff.commit, status:'waiting', slices, checklist:[], findings:[]};
  if (tip !== handoff.commit) return {...result, status:'branch-changed'};
  if (!record) return result;
  const reviewedCommit = record.identity.changed;
  const checklist = record.manifest.scenarios.map(item => ({id:item.id, title:item.title, status:itemStatus(record,item)}));
  const findings = record.issues.filter(issue => issue.status !== 'resolved').map(({id,scenario,actual,expected}) => ({id,scenario,actual,expected}));
  const approved = reviewedCommit === handoff.commit && record.approval?.commit === reviewedCommit &&
    record.approval.identity === digest(record.identity) && canApprove(record);
  const status = findings.length ? 'changes-requested' : approved ? 'approved' :
    reviewedCommit === handoff.commit ? 'reviewing' : 'different-preview';
  const destination=approved ? await githubTarget(git,handoff.ref).catch(()=>null) : null;
  return {...result, status, reviewId:record.id, reviewedCommit, checklist, findings,
    pushTarget:destination?.repository || null,
    approval:approved ? {reviewer:record.approval.reviewer, at:record.approval.at} : null};
}

async function reviewSlices(repository,handoff) {
  const root=await realpath(repository);
  let groupData;
  try {groupData=await ownedFile(root,path.join('.harness','loops',handoff.runId,'design.json'));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  const workspace=await ownedFile(root,path.join('.harness','design','workspace.json'),32_000_000);
  const build=workspace.builds.find(b=>b.id===groupData.build);
  const attempt=build?.attempts.findLast(a=>a.task===handoff.runId && a.outcome==='completed');
  const group=build?.groups.find(g=>g.sha===handoff.commit && g.slices.includes(attempt?.slice));
  if(!group)return [];
  const slices=build.roadmap.flatMap(m=>m.slices);
  return group.slices.map(id=>{
    const asset=build.attachments?.[id];
    return {id,title:slices.find(slice=>slice.id===id)?.title || id,mockup:/^[a-f0-9]{32}$/.test(asset)?asset:null};
  });
}

export async function workbenchMockup(repository,runId,sliceId) {
  const handoff=await readHandoff(repository,runId);
  const slice=(await reviewSlices(repository,handoff)).find(s=>s.id===sliceId);
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
    throw Error('Approve the current source commit in Branch Review before pushing.');
  const target=await githubTarget(git,review.ref);
  if(!expectedTarget || target.repository!==expectedTarget)
    throw Error('The GitHub destination changed. Refresh the review and confirm its destination.');
  const {address,remote}=target;
  await git('push','--no-follow-tags','--recurse-submodules=no','--',address,expectedCommit+':'+review.ref);
  const observed=(await git('ls-remote','--refs','--',address,review.ref)).trim().split(/\s+/);
  if(observed[0]!==expectedCommit || observed[1]!==review.ref)
    throw Error('GitHub has not confirmed this commit. Check the remote branch before retrying.');
  return {reviewId:review.reviewId,commit:expectedCommit,ref:review.ref,remote,repository:target.repository};
}

export async function returnFindings(repository, runId, record, selectedIds) {
  const handoff = await readHandoff(repository, runId);
  if (record.identity.source !== handoff.commit || record.identity.ref !== handoff.ref ||
      (record.identity.workbenchRun && record.identity.workbenchRun !== runId)) {
    throw new Error('The review must match the branch and source commit from Workbench.');
  }
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 100 ||
      !selectedIds.every(id => typeof id === 'string') || new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('Select between 1 and 100 distinct findings.');
  }
  const findings = [...selectedIds].sort().map(id => {
    const issue = record.issues.find(row => row.id === id && row.status !== 'resolved');
    if (!issue) throw new Error('A selected finding changed. Refresh the review and select it again.');
    return {id:issue.id, expected:issue.expected, actual:issue.actual, scenario:issue.scenario,
      side:issue.side, location:issue.location || '', commit:issue.commit, status:issue.status};
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
  if(!/^[a-f0-9]{64}$/.test(receipt)) throw Error('Select a saved group of findings.');
  const incoming=await ownedFile(root,path.join('.harness','branch-review','incoming',runId,receipt+'.json'));
  if(incoming.id!==receipt || incoming.runId!==runId || incoming.commit!==run.commit) throw Error('This receipt belongs to another run.');
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
