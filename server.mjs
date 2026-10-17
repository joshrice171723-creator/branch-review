import {setupChecks} from './setup-checks.mjs';
import {npmEntry} from './web-project.mjs';
import http from 'node:http';
import { readFile, writeFile, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { branches, comparison, git, run, root, local, repo, previewRoot, toolchain, slots, state, progress, startReview, stopReview, restoreReview, prepare, resetScenario, project, webHealthy, defaultBranch } from './adapter.mjs';
import { previewProxy } from './proxy.mjs';
import { ReviewStore, scenarioRecipe, digest } from './reviews.mjs';
import { loadPlan, candidateComparison, PlanStore, branchUpdate, branchRelationships, retestAdvice, prepareTogether } from './plans.mjs';
import {ReviewJobs,configuredChecks,scrub} from './jobs.mjs';
import {publishedAction,publishedComplete} from './published-review.mjs';
import { Delivery } from './delivery.mjs';
import { publish, target } from './publish.mjs';
import {providerId,probeProvider} from './providers.mjs';
import {readRecipe,saveRecipe} from './project-settings.mjs';
import {beginBrowserQa,browserQaResult} from './browser-qa.mjs';
import {readDelivery,saveDelivery,deployProject,createReviewPr} from './project-delivery.mjs';
import { MuseQa } from './muse-qa.mjs';
import { changedFiles, fileDiff, commitHistory } from './changes.mjs';
import { reviewReport } from './report.mjs';
import { previewHealth } from './health.mjs';
import {groupedBranches,reviewRoot,focusRetest,mergeFixPlan,carryUnchangedChecks,frontendOnly,colorFixPlan} from './fix-review.mjs';

const port = 4310, origin = `http://127.0.0.1:${port}`, token = randomBytes(32).toString('hex');
let busy = false;
const store = await new ReviewStore(local).load();
for(const record of store.records)for(const run of record.browserQa || [])if(run.status==='running'){run.status='interrupted';run.error='The app closed before browser evidence completed.';}
await store.persist();
const qaRunning=()=>store.records.some(record=>record.browserQa?.some(run=>run.status==='running'));
const muse=new MuseQa(local,store);
const plans=new PlanStore(path.join(local,'diff-reviews'));
let agentSettings=JSON.parse(await readFile(path.join(local,'agent-settings.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '{}';throw e;}));
const selectedAgent=()=>({provider:providerId(agentSettings.provider),executable:agentSettings.executables?.[agentSettings.provider || 'codex']});
const jobs=await new ReviewJobs(local,{git,run,previewRoot,toolchain,repo,provider:selectedAgent,project,changedCwd:()=>path.join(previewRoot,state.changed?.runtime || 'changed'),prepareNext:async sha=>{
  const branch=(await branches()).find(branch=>branch.sha===sha);if(!branch)throw new Error('Choose a current branch.');
  const selected=await comparison(branch.ref,'parent'),runtime=state.changed?.runtime==='standby'?'changed':'standby';
  const prepared=await prepare(runtime,sha,selected.files);state.prepared={...prepared,recipe:scenarioRecipe(selected.files)};await writeFile(path.join(local,'prepared.json'),JSON.stringify(state.prepared));return prepared;
}}).load();
let toolsSettings=JSON.parse(await readFile(path.join(local,'tools-settings.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '{}';throw e;}));
const delivery = new Delivery(git, store, defaultBranch);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
async function manifestFor(sha) {
  const plan=await plans.get(sha);
  if(!plan)throw Error('Reopen this branch to generate its checklist from the current changes.');
  return plan;
}
async function startCandidate(ref, previousReviewId) {
  if(project.error)throw Error(project.error);
  if(project.needsSetup && !await readRecipe(local))throw Error('Set up preview commands in More tools → Workspace before opening a review.');
  state.status='preparing';progress('Checking changes against the remote default branch');
  const selected=await comparison(ref,'main');
  const previous=store.records.findLast(record=>record.identity.ref===ref && record.integration)?.integration;
  const integration=await delivery.prepare(ref,selected.branch.sha,previous);
  const combined=await candidateComparison(git,selected,integration);
  const prior=previousReviewId?store.get(previousReviewId):null;
  const fixFiles=prior?(await git('diff','--name-only','-z',prior.identity.changed,integration.sha,'--')).split('\0').filter(Boolean):[];
  const narrow=prior && prior.integration?.main===integration.main && frontendOnly(fixFiles) && fixFiles.every(file=>prior.manifest.scenarios.some(item=>item.files?.includes(file)));
  if(prior){combined.base=prior.identity.changed;combined.baseline='commit';combined.baselineCommit=prior.identity.changed;combined.fixReview={previousId:prior.id,files:fixFiles};}
  if(!combined.files.length)throw Error('This branch has no application changes left to review against the remote default branch. Its old checklist is no longer part of the code.');
  const planKey=prior?digest({before:prior.identity.changed,after:integration.sha}):integration.sha;
  combined.plan=await prepareTogether(
    async()=>{await startReview(ref,'main',undefined,{comparison:combined,integration,deferReady:true,beforeFix:!!prior});if(state.status==='error')throw Error(state.error);},
    async()=>{
      let plan=await plans.get(planKey);
      if(!plan && prior){
        plan=await colorFixPlan(git,prior,integration.sha,fixFiles,integration.main);
        if(plan)progress('Reusing affected screens for the color checks');
      }
      if(!plan){
        const agent=selectedAgent(),connection=await probeProvider(agent.provider,agent.executable);
        if(connection.status!=='ready')throw Error(connection.message+' Open More tools > Workspace.');
        progress('Generating checklist while previews prepare');
        plan=await jobs.generatePlan(prior?prior.identity.changed:integration.main,integration.sha,prior?fixFiles:combined.files,prior?.manifest || combined.plan);
      }
      if(prior)plan=mergeFixPlan(prior.manifest,{...plan,scenarios:plan.scenarios.filter(item=>item.files?.some(file=>fixFiles.includes(file)))},fixFiles);
      await plans.save(planKey,plan);await plans.save(integration.sha,plan);return plan;
    }
  );
  state.status='ready';progress('Checklist and previews are ready');
  await activate(previousReviewId);
  if(prior){
    const record=store.get(state.recordId);
    focusRetest(record,prior,fixFiles);
    const root=reviewRoot(prior,store.records);record.reviewRootId=root.id;record.reviewTitle=root.title;
    if(narrow){
      const colorOnly=await Promise.all(fixFiles.map(async file=>{
        const before=await git('show',`${prior.identity.changed}:${file}`),after=await git('show',`${integration.sha}:${file}`);
        return before.replace(/#[0-9a-fA-F]{3,8}\b/g,'#COLOR')===after.replace(/#[0-9a-fA-F]{3,8}\b/g,'#COLOR');
      }));
      if(colorOnly.every(Boolean))carryUnchangedChecks(record,prior,fixFiles);
    }
    await store.persist();
  }
}
async function activate(previousReviewId) {
  if (state.status !== 'ready') return;
  const manifest = await manifestFor(state.changed.sha);
  const record = await store.open({...state, repository:repo, previousReviewId:previousReviewId || state.comparison?.fixReview?.previousId}, manifest, digest(project.kind==='meta-clinic'?await readFile(path.join(root,scenarioRecipe(state.comparison.files)),'utf8'):JSON.stringify({version:'web-preview-v2',recipe:await readRecipe(local)})));
  state.recordId = record.id; state.manifest = manifest;
  if(state.comparison?.fixReview){const parent=store.get(state.comparison.fixReview.previousId),root=reviewRoot(parent,store.records);record.reviewRootId=root.id;record.reviewTitle=root.title;}
  if (state.integration?.sha === state.changed.sha) { record.integration = state.integration; await store.persist(); }
  await writeFile(path.join(local,'review.json'),JSON.stringify({comparison:state.comparison,original:state.original,changed:state.changed,integration:state.integration},null,2));
}
async function active(id, checkFresh = false) {
  if (state.status !== 'ready' || id !== state.recordId) throw new Error('Open this exact review before changing its results.');
  const record = store.get(id);
  if (checkFresh) {
    await delivery.refs(record);
    for (const side of ['original','changed']) {
      const cwd = path.join(previewRoot,state[side].runtime || side);
      if (await run('git',['rev-parse','HEAD'],{cwd}) !== state[side].sha || await run('git',['status','--porcelain'],{cwd})) throw new Error('Preview source changed. Reopen the exact committed version before approval.');
    }
    const health=await previewHealth(state,fetch,webHealthy);
    for(const [side,result] of Object.entries(health.sides))if(!result.ok)throw new Error(`${side==='original'?'Original':'Changed'} preview: ${result.message}`);
  }
  return record;
}
function json(res,status,data) { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
async function body(req) { let buffer=''; for await(const chunk of req) { buffer += chunk; if(Buffer.byteLength(buffer)>16_000_000) throw new Error('Request too large'); } return JSON.parse(buffer || '{}'); }
const diagnostics=()=>setupChecks({git,run,defaultBranch,project,recipe:()=>readRecipe(local),agent:selectedAgent(),probe:probeProvider,npm:npmEntry});
async function mutate(endpoint, data) {
  if(qaRunning() && !['/api/browser-qa-result','/api/check','/api/item','/api/cursor','/api/issue'].includes(endpoint))throw Error('Stop browser QA before changing its review, settings or runtime.');
  if(endpoint==='/api/new-change'){
    if(state.recordId)throw Error('Use Make changes in the open review to keep its history together.');
    if(jobs.rows.some(job=>job.status==='running'))throw Error('Wait for the running job to finish.');
    if(typeof data.requestText!=='string' || !data.requestText.trim() || data.requestText.length>60000)throw Error('Describe the change you want to make.');
    const agent=selectedAgent(),connection=await probeProvider(agent.provider,agent.executable);if(connection.status!=='ready')throw Error(connection.message);
    await git('fetch','origin');
    return jobs.startNew(await git('rev-parse',`refs/remotes/origin/${await defaultBranch()}`),data.requestText);
  }
  if(endpoint==='/api/onboarding'){
    const rows=await diagnostics();
    if(rows.some(row=>!row.ok))throw Error('Finish setup before continuing: '+rows.filter(row=>!row.ok).map(row=>row.name).join(', '));
    await writeFile(path.join(local,'onboarding.json'),JSON.stringify({repository:repo,completedAt:new Date().toISOString()}));return {ready:true};
  }
  if(endpoint==='/api/project-settings'){
    if(jobs.rows.some(job=>job.status==='running'))throw Error('Wait for running jobs before changing setup.');
    if(state.original || state.changed)throw Error('Stop previews before changing project setup. Your reviews remain saved.');
    return saveRecipe(local,data);
  }
  if(['/api/start','/api/stop','/api/retest','/api/candidate','/api/reset-data','/api/ship','/api/publish','/api/project-deploy','/api/pull-request','/api/project-delivery'].includes(endpoint) && jobs.rows.some(job=>job.status==='running'))throw new Error('Wait for the running review job before changing environments or delivering code.');
  if(endpoint==='/api/project-delivery')return saveDelivery(local,data);
  if(endpoint==='/api/agent-settings'){
    if(jobs.rows.some(job=>job.status==='running'))throw Error('Wait for the running job before changing providers.');
    const provider=providerId(data.provider);
    const executable=data.executable===undefined?(agentSettings.executables?.[provider] || ''):data.executable;
    if(typeof executable!=='string' || executable.length>1000 || executable && !path.isAbsolute(executable))throw Error('Choose an absolute executable path, or leave it blank for automatic discovery.');
    const next={provider,executables:{...agentSettings.executables,[provider]:executable}};
    await writeFile(path.join(local,'agent-settings.json.tmp'),JSON.stringify(next));await rename(path.join(local,'agent-settings.json.tmp'),path.join(local,'agent-settings.json'));agentSettings=next;return probeProvider(provider,executable);
  }
  if(endpoint==='/api/agent-probe'){const agent=selectedAgent();return probeProvider(agent.provider,agent.executable);}
  if(project.kind!=='meta-clinic' && ['/api/publish','/api/retry-muse','/api/release-settings','/api/published-review','/api/smoke'].includes(endpoint))throw Error('Publishing is not configured for this project. Use your existing delivery process.');
  if(endpoint==='/api/tools-settings'){if(typeof data.autoPlan!=='boolean')throw new Error('Choose whether to generate plans automatically.');const next={autoPlan:data.autoPlan};await writeFile(path.join(local,'tools-settings.json'),JSON.stringify(next));toolsSettings=next;return next;}
  if (endpoint === '/api/start') {
    let prior;
    const fixJob=data.fixJob || jobs.rows.findLast(row=>row.branch && data.ref==='refs/heads/'+row.branch && row.status==='succeeded')?.id;
    if(fixJob){
      const job=jobs.rows.find(row=>row.id===fixJob && row.kind==='fix' && row.status==='succeeded');
      if(!job || data.ref!=='refs/heads/'+job.branch || await git('rev-parse',data.ref)!==job.resultCommit)throw new Error('Choose an unchanged, committed fix job before retesting.');
      if(job.reviewId)prior=store.get(job.reviewId);
    }
    await startCandidate(data.ref,prior?.id);return;
  }
  if (endpoint === '/api/stop') return stopReview();
  if (endpoint === '/api/fetch') return git('fetch','origin');
  if (endpoint === '/api/retest') { const prior=store.get(data.id); await startCandidate(prior.identity.ref,prior.id); return; }
  if (endpoint === '/api/release-settings') {
    if (typeof data.keyPath !== 'string' || typeof data.recoveryDirectory !== 'string' || !path.isAbsolute(data.keyPath) || !path.isAbsolute(data.recoveryDirectory)) throw new Error('Choose an existing key and recovery folder.');
    await access(data.keyPath); await access(data.recoveryDirectory); await writeFile(path.join(local,'release.json'),JSON.stringify({keyPath:data.keyPath,recoveryDirectory:data.recoveryDirectory})); return;
  }
  const record = await active(data.id, ['/api/approve','/api/ship','/api/publish','/api/candidate','/api/browser-qa','/api/project-deploy','/api/pull-request'].includes(endpoint));
  if(endpoint==='/api/pull-request')return createReviewPr(record,{delivery,git,run,store,local,repo,defaultBranch});
  if(endpoint==='/api/project-deploy')return deployProject(record,{local,cwd:state.changed.directory,run,git,store,defaultBranch,confirmation:data.confirmation});
  if(endpoint==='/api/project-deploy-retry'){
    if(record.projectDeployment?.status!=='needs-inspection'||typeof data.note!=='string'||data.note.trim().length<10)throw Error('Describe your inspection of the failed deployment first.');
    await store.event(record,'project-deployment-retry',{previous:record.projectDeployment,note:data.note.slice(0,2000)});delete record.projectDeployment;await store.persist();return;
  }
  if(endpoint==='/api/browser-qa')return beginBrowserQa(store,record,data.steps);
  if(endpoint==='/api/browser-qa-result')return browserQaResult(store,local,record,data);
  if(endpoint==='/api/plan'){
    if(jobs.rows.some(job=>job.status==='running'))throw new Error('Wait for the running job before editing the plan.');
    await plans.save(record.identity.changed,data.manifest);await activate();return state.recordId;
  }
  if(endpoint==='/api/job')return jobs.start(record,data.kind,data);
  if(endpoint==='/api/fix-commit'){
    if(!jobs.rows.some(job=>job.id===data.jobId && job.reviewId===record.id))throw Error('Choose a fix job from this review.');
    return jobs.commitFix(data.jobId,data.files);
  }
  if(endpoint==='/api/published-review')return publishedAction(store,record,data);
  if(endpoint==='/api/reset-data'){
    if(data.confirmation!==`RESET ${data.side} ${record.identity.changed}`)throw new Error('Confirm the exact preview before restoring its starting data.');
    await resetScenario(data.side);
    const previousChecks={...record.checks};record.checks={};record.approval=null;
    return store.event(record,'scenario-data-reset',{side:data.side,previousChecks});
  }
  if(endpoint==='/api/tool-evidence'){
    if(!['accessibility','performance','replay','visual','recording','published-check'].includes(data.kind) || !record.manifest.scenarios.some(item=>item.id===data.itemId) || !['original','changed','published'].includes(data.side))throw new Error('Choose an existing item and supported evidence type.');
    const detail=JSON.stringify(data.detail);if(!detail || detail.length>60000)throw new Error('Evidence is too large.');
    record.toolEvidence ||= [];record.toolEvidence.push({kind:data.kind,itemId:data.itemId,side:data.side,commit:data.side==='original'?record.identity.base:record.identity.changed,at:new Date().toISOString(),detail:scrub(data.detail)});
    return store.event(record,'tool-evidence-saved',{kind:data.kind,itemId:data.itemId});
  }
  if (endpoint === '/api/check') return store.check(record.id,data.scenario,data.index,data.passed);
  if (endpoint === '/api/item') return store.item(record.id,data.itemId,data);
  if (endpoint === '/api/cursor') return store.cursor(record.id,data.itemId,data.view);
  if (endpoint === '/api/issue') return store.issue(record.id,data);
  if (endpoint === '/api/resolve') return store.resolve(record.id,data.issueId,data.note);
  if (endpoint === '/api/approve') return store.approve(record.id,data.reviewer);
  if (endpoint === '/api/candidate') {
    const candidate = await delivery.candidate(record);
    state.comparison = await candidateComparison(git,state.comparison,candidate);
    if (state.changed.sha === candidate.sha && state.original.sha === candidate.main) { state.integration=candidate; await activate(); return; }
    state.status='preparing'; state.integration=candidate;
    state.original = await prepare('original',candidate.main);
    state.changed = {...await prepare(state.changed?.runtime || 'changed',candidate.sha),side:'changed',proxy:slots.changed.proxy};
    state.status='ready';
    await activate(); return;
  }
  if (endpoint === '/api/ship') {
    if (data.confirmation !== `MERGE ${record.identity.changed} TO origin/${await defaultBranch()}`) throw new Error('Confirm the exact commit before merge and push.');
    return delivery.push(record,record.identity.changed);
  }
  if (endpoint === '/api/publish') return publish(record,{local,repo,run,git,store,toolchain,muse,confirmation:data.confirmation});
  if(endpoint==='/api/retry-muse')return muse.dispatch(record);
  if (endpoint === '/api/retry-publish') {
    if (record.delivery?.stage !== 'deployment-needs-inspection' || typeof data.note !== 'string' || data.note.trim().length < 10) throw new Error('Record your inspection of the failed release and recovery artifacts before enabling a retry.');
    record.delivery.stage='pushed'; return store.event(record,'release-retry-enabled',{note:data.note.slice(0,2000)});
  }
  if (endpoint === '/api/smoke') {
    if(!publishedComplete(record))throw new Error('Complete the published workflow checklist in Review tools first.');
    if (record.delivery?.stage !== 'published' || typeof data.note !== 'string' || data.note.trim().length < 10) throw new Error('Record the published workflow result.');
    const response=await fetch(target+'/build.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok || (await response.json()).revision !== record.identity.changed) throw new Error('The published revision changed. Verify the intended build.');
    record.delivery.stage='verified'; return store.event(record,'published-workflow-verified',{note:data.note.slice(0,2000),commit:record.identity.changed});
  }
  throw new Error('Unknown review action.');
}
const actions=new Set(['/api/start','/api/stop','/api/fetch','/api/retest','/api/release-settings','/api/check','/api/item','/api/cursor','/api/issue','/api/resolve','/api/approve','/api/candidate','/api/ship','/api/publish','/api/smoke','/api/retry-publish','/api/plan','/api/job','/api/reset-data','/api/tool-evidence']);
const longActions=new Set(['/api/start','/api/stop','/api/fetch','/api/retest','/api/candidate','/api/ship','/api/publish']);
actions.add('/api/published-review');
actions.add('/api/tools-settings');
actions.add('/api/fix-commit');
actions.add('/api/retry-muse');
actions.add('/api/agent-settings');actions.add('/api/agent-probe');
actions.add('/api/project-settings');
actions.add('/api/browser-qa');actions.add('/api/browser-qa-result');
for(const endpoint of ['/api/project-delivery','/api/project-deploy','/api/project-deploy-retry','/api/pull-request'])actions.add(endpoint);
actions.add('/api/onboarding');
actions.add('/api/job-cancel');
actions.add('/api/new-change');
longActions.add('/api/project-deploy');longActions.add('/api/pull-request');
const server=http.createServer(async(req,res)=>{
  try {
    if(req.headers.host!==`127.0.0.1:${port}`) return json(res,403,{error:'Invalid host'});
    const url=new URL(req.url,origin);
    if(req.method==='GET' && url.pathname==='/api/state') return json(res,200,{...state,busy,qaRunning:qaRunning(),jobsRunning:jobs.rows.some(job=>job.status==='running'),token,repository:repo,project,agent:selectedAgent(),defaultBranch:await defaultBranch().catch(()=>null),record:state.recordId?store.get(state.recordId):null,publishTarget:project.kind==='meta-clinic'?target:null,releaseConfigured:project.kind==='meta-clinic' && await access(path.join(local,'release.json')).then(()=>true,()=>false)});
    if(req.method==='GET' && url.pathname==='/api/branches') return json(res,200,groupedBranches(await branches(),jobs.rows,store.records));
    if(req.method==='GET' && url.pathname==='/api/history') return json(res,200,store.summary());
    if(req.method==='GET' && url.pathname==='/api/jobs')return json(res,200,jobs.rows.slice(-30));
    if(req.method==='GET' && url.pathname==='/api/project-settings')return json(res,200,await readRecipe(local));
    if(req.method==='GET' && url.pathname==='/api/project-delivery')return json(res,200,await readDelivery(local));
    if(req.method==='GET' && url.pathname==='/api/onboarding')return json(res,200,{needed:!store.records.length && !await access(path.join(local,'onboarding.json')).then(()=>true,()=>false),repository:repo,project,agent:selectedAgent()});
    if(req.method==='GET' && url.pathname==='/api/diagnostics')return json(res,200,await diagnostics());
    if(req.method==='GET' && url.pathname==='/api/fix-files')return json(res,200,await jobs.fixFiles(url.searchParams.get('job')));
    if(req.method==='GET' && url.pathname==='/api/tools-settings')return json(res,200,toolsSettings);
    if(req.method==='GET' && url.pathname==='/api/checks')return json(res,200,await jobs.checks(store.get(url.searchParams.get('id')).identity.changed));
    if(req.method==='GET' && url.pathname==='/api/update')return json(res,200,await branchUpdate(git,store.get(url.searchParams.get('id'))));
    if(req.method==='GET' && url.pathname==='/api/relationships')return json(res,200,await branchRelationships(git,await branches(),url.searchParams.get('ref'),await defaultBranch()));
    if(req.method==='GET' && url.pathname==='/api/retest-advice'){
      const record=store.get(url.searchParams.get('id')),previous=record.previousId?store.get(record.previousId):null;
      const files=previous?(await git('diff','--name-only','-z',previous.identity.changed,record.identity.changed,'--')).split('\0').filter(Boolean):state.comparison.files;
      return json(res,200,retestAdvice(previous,record.manifest,files));
    }
    if(req.method==='GET' && url.pathname==='/api/health')return json(res,200,await previewHealth({...state},fetch,webHealthy));
    if(req.method==='GET' && url.pathname==='/api/report'){
      const record=store.get(url.searchParams.get('id')),html=await reviewReport(record,local);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Disposition':`${url.searchParams.get('inline')==='1'?'inline':'attachment'}; filename="branch-review-${record.identity.changed.slice(0,7)}.html"`,'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; frame-ancestors 'self'; base-uri 'none'"});return res.end(html);
    }
    if(req.method==='GET' && url.pathname==='/api/comparison') {
      const selected=await comparison(url.searchParams.get('ref'),url.searchParams.get('baseline'),url.searchParams.get('commit'));
      selected.plan=await plans.get(selected.branch.sha) || selected.plan;
      return json(res,200,selected);
    }
    if(req.method==='GET' && url.pathname==='/api/commits')return json(res,200,await commitHistory(git,url.searchParams.get('sha')));
    if(req.method==='GET' && url.pathname==='/api/changes')return json(res,200,await changedFiles(git,url.searchParams.get('base'),url.searchParams.get('changed')));
    if(req.method==='GET' && url.pathname==='/api/diff')return json(res,200,await fileDiff(git,url.searchParams.get('base'),url.searchParams.get('changed'),url.searchParams.get('file')));
    if(req.method==='GET' && /^\/screenshots\/[a-f0-9-]{36}\.png$/.test(url.pathname)) { const image=await readFile(path.join(local,url.pathname.slice(1)));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"}); return res.end(image); }
    if(req.method==='GET' && /^\/recordings\/[a-f0-9-]{36}\.webm$/.test(url.pathname)){const clip=await readFile(path.join(local,url.pathname.slice(1)));res.writeHead(200,{'Content-Type':'video/webm','Content-Length':clip.length,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"});return res.end(clip);}
    if(req.method==='POST' && actions.has(url.pathname)) {
      if(req.headers.origin!==origin || req.headers['x-review-token']!==token) return json(res,403,{error:'Reload Branch Review before continuing.'});
      if(url.pathname==='/api/job-cancel')return json(res,200,{result:await jobs.cancel((await body(req)).jobId)});
      if(busy) return json(res,409,{error:'Another operation is still running.'});
      busy=true;
      let data; try { data=await body(req); } catch(error) { busy=false; throw error; }
      state.error=null;
      const operation=async()=>{try {return await mutate(url.pathname,data);}catch(error){state.error=error.message;if(state.status==='preparing'||state.status==='stopping') state.status='error';throw error;}finally{busy=false;}};
      if(longActions.has(url.pathname)){ operation().catch(()=>{}); return json(res,202,{accepted:true}); }
      return json(res,200,{result:await operation()});
    }
    if(req.method!=='GET'||!['/','/app.js','/workflow.js','/guided.js','/review-model.js','/drafts.js','/shortcuts.js','/preview-routes.js','/workbench.js','/change-request.js','/project-setup.js','/onboarding.js','/activity.js','/evidence-tools.js','/style.css'].includes(url.pathname))return json(res,404,{error:'Not found'});
    const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
    res.writeHead(200,{'Content-Type':types[path.extname(filename)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' http://127.0.0.1:4311 http://127.0.0.1:4312; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"});
    res.end(await readFile(path.join(root,'public',filename)));
  }catch(error){if(!res.headersSent)json(res,400,{error:error.message});else res.end();}
});
await restoreReview();state.prepared=JSON.parse(await readFile(path.join(local,'prepared.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return 'null';throw e;})); await activate().catch(error=>{state.status='error';state.error=error.message;});
for(const [side,slot] of Object.entries(slots).filter(([side])=>side!=='standby')) { const proxy=previewProxy(side,slot,()=>state,origin);proxy.on('error',error=>{console.error(error.message);process.exit(1);});proxy.listen(slot.proxy,'127.0.0.1'); }
server.on('error',error=>{console.error(error.message);process.exit(1);});
server.listen(port,'127.0.0.1',()=>console.log(`Branch Review: ${origin}`));
let checkingMuse=false;
setInterval(async()=>{
  if(busy || checkingMuse)return;checkingMuse=true;
  try{for(const record of store.records.filter(record=>record.museQa && ['published','verified'].includes(record.delivery?.stage) && (!['completed','result_confirmed','evidence-missing'].includes(record.museQa.status) || !record.museQa.evidenceChecked))){
    try{await muse.refresh(record);}catch{record.museQa.statusError='Office status is temporarily unavailable; the last reported state is shown.';await store.persist();}
  }}finally{checkingMuse=false;}
},15000).unref();
