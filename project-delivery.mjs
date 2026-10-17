import {digest} from './reviews.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {npmEntry} from './web-project.mjs';

export function validateDelivery(value){
  if(!value || !Array.isArray(value.command)||!value.command.length||value.command.some(arg=>typeof arg!=='string'||arg.includes('\0')||arg.length>4000))throw Error('Enter a deployment executable and arguments.');
  const url=new URL(value.buildUrl);
  if(url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('Build receipt must use HTTPS or local HTTP, without credentials.');
  return {command:value.command,buildUrl:url.href};
}
export async function readDelivery(local){return readFile(path.join(local,'project-delivery.json'),'utf8').then(text=>validateDelivery(JSON.parse(text))).catch(e=>{if(e.code==='ENOENT')return null;throw e;});}
export async function saveDelivery(local,value){const config=validateDelivery(value),file=path.join(local,'project-delivery.json');await writeFile(file+'.tmp',JSON.stringify(config,null,2));await rename(file+'.tmp',file);return config;}
export async function deployProject(record,{local,cwd,run,git,store,defaultBranch,confirmation,fetcher=fetch}){
  const config=await readDelivery(local);if(!config)throw Error('Configure deployment in Workspace first.');
  const sha=record.identity.changed;
  if(record.approval?.identity!==digest(record.identity))throw Error('Approve this exact reviewed version before deploying.');
  if(record.projectDeployment?.status==='published')return record.projectDeployment;
  if(record.projectDeployment)throw Error('Inspect the previous deployment before enabling a retry.');
  if(confirmation!==`DEPLOY ${sha}` || record.delivery?.stage!=='pushed' || record.delivery.commit!==sha)throw Error('Push and confirm this exact reviewed version before deploying.');
  const remote=(await git('ls-remote','origin','refs/heads/'+await defaultBranch())).split(/\s/)[0];
  if(remote!==sha || await run('git',['rev-parse','HEAD'],{cwd})!==sha || await run('git',['status','--porcelain'],{cwd}))throw Error('The remote or preview changed. Reopen and review before deploying.');
  record.projectDeployment={status:'running',commit:sha,startedAt:new Date().toISOString()};await store.persist();
  try{
    const [file,...args]=config.command.map(arg=>arg.replaceAll('{commit}',sha).replaceAll('{root}',cwd));
    await run(file==='node'||file==='npm'?process.execPath:file,file==='npm'?[await npmEntry(),...args]:args,{cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',BRANCH_REVIEW_REVISION:sha}});
    const response=await fetcher(config.buildUrl,{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Deployment command finished, but its build receipt could not be read.');
    const receipt=await response.json();if(receipt.revision!==sha || receipt.dirty)throw Error('Deployment receipt does not identify the exact clean reviewed commit.');
    record.projectDeployment.status='published';record.projectDeployment.verifiedAt=new Date().toISOString();record.projectDeployment.buildUrl=config.buildUrl;
    await store.event(record,'project-deployed',{commit:sha,buildUrl:config.buildUrl});
  }catch(error){record.projectDeployment.status='needs-inspection';record.projectDeployment.error=error.message;await store.persist();throw error;}
  return record.projectDeployment;
}
export async function createReviewPr(record,{delivery,git,run,store,local,repo,defaultBranch}){
  if(record.approval?.identity!==digest(record.identity) || record.integration?.sha!==record.identity.changed)throw Error('Approve the reviewed candidate before creating a pull request.');
  const refs=await delivery.refs(record);if(refs.main!==record.integration.main)throw Error('The default branch moved. Reopen the review first.');
  const branch='branch-review/approved-'+record.identity.changed.slice(0,12);
  await git('push','origin',`${record.identity.changed}:refs/heads/${branch}`);
  let url=await run('gh',['pr','view',branch,'--json','url','--jq','.url'],{cwd:repo}).catch(()=>null);
  if(!url){const file=path.join(local,'pull-request.md');await writeFile(file,`Reviewed commit: ${record.identity.changed}\n\n${record.manifest.summary || record.title}\n\nManual review approved in Branch Review. Automated checks and browser evidence remain separate from approval.\n`);url=await run('gh',['pr','create','--base',await defaultBranch(),'--head',branch,'--title',String(record.title || 'Reviewed changes').slice(0,200),'--body-file',file],{cwd:repo});}
  if(!/^https:\/\//.test(url.trim()))throw Error('Could not confirm the pull request URL. Inspect the remote before retrying.');
  record.pullRequest={url:url.trim(),commit:record.identity.changed,branch};await store.event(record,'pull-request-created',record.pullRequest);return record.pullRequest;
}
