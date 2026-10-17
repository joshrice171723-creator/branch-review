import {validateManifest} from './reviews.mjs';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {itemStatus} from './public/review-model.js';

export async function prepareTogether(previews, checklist) {
  const results=await Promise.allSettled([previews(),checklist()]);
  const failed=results.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
  return results[1].value;
}

export class PlanStore {
  constructor(directory){this.directory=directory;}
  file(sha){if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))throw new Error('An exact commit or comparison key is required.');return path.join(this.directory,'plans',sha+'.json');}
  async get(sha){try{return validateManifest(JSON.parse(await readFile(this.file(sha),'utf8')));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
  async save(sha,value){const plan=validateManifest(value),file=this.file(sha);await mkdir(path.dirname(file),{recursive:true});await writeFile(file+'.tmp',JSON.stringify(plan,null,2));await rename(file+'.tmp',file);return plan;}
}

export function retestAdvice(previous,manifest,files) {
  return manifest.scenarios.map(item=>{
    const prior=previous?.manifest.scenarios.find(old=>old.id===item.id),status=prior?itemStatus(previous,prior):null;
    const affected=item.files?.filter(file=>files.some(changed=>changed===file || changed.startsWith(file.endsWith('/')?file:file+'/'))) || [];
    const reason=!prior?'New review item':JSON.stringify(prior)!==JSON.stringify(item)?'Review requirements changed':['blocked','needs-fixes'].includes(status)?'Previously failed or blocked':affected.length?`Changed: ${affected.join(', ')}`:!item.files?.length?'Impact unknown — no source mapping':'No directly mapped files changed; indirect effects remain possible';
    return {id:item.id,title:item.title,priority:!prior || ['blocked','needs-fixes'].includes(status) || affected.length || JSON.stringify(prior)!==JSON.stringify(item)?'first':'review',reason,previousStatus:status,previousCommit:previous?.identity.changed || null};
  });
}

export async function branchUpdate(git,record) {
  let latest;try{latest=await git('rev-parse','--verify',record.identity.ref);}catch{return{missing:true};}
  if(latest===record.identity.source)return{latest,changed:false};
  const files=(await git('diff','--name-only','-z',record.identity.source,latest,'--')).split('\0').filter(Boolean);
  const commits=(await git('log','--format=%h %s','-12',`${record.identity.source}..${latest}`,'--')).split('\n').filter(Boolean);
  const plan=await loadPlan(git,latest,files);
  return{latest,changed:true,files,commits,recommendations:retestAdvice(record,plan,files)};
}

export async function branchRelationships(git,inventory,ref,defaultBranch='main') {
  const current=inventory.find(branch=>branch.ref===ref || branch.aliases?.includes(ref));if(!current)throw new Error('Select a current branch.');
  const main=await git('rev-parse','refs/remotes/origin/'+defaultBranch);
  const changed=async sha=>new Set((await git('diff','--name-only','-z',await git('merge-base',main,sha),sha,'--')).split('\0').filter(Boolean));
  const own=await changed(current.sha),related=[];
  for(const branch of inventory.filter(branch=>!branch.merged && branch.sha!==current.sha).slice(0,40)){
    const shared=await git('merge-base',current.sha,branch.sha),files=[...await changed(branch.sha)].filter(file=>own.has(file));
    const relation=shared===branch.sha?'included dependency':shared===current.sha?'builds on this branch':'independent history';
    if(files.length || relation!=='independent history')related.push({ref:branch.ref,sha:branch.sha,relation,overlap:files});
  }
  return{ref:current.ref,sha:current.sha,related,limited:inventory.filter(branch=>!branch.merged).length>41,note:'Ancestry proves inclusion; overlapping files indicate review risk, not a confirmed conflict.'};
}
export async function loadPlan(git,sha,files) {
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Choose an exact commit for the review plan.');
  return validateManifest({version:2,title:'Checklist pending',summary:'Opening this branch generates a checklist from its changes against the remote default branch.',source:'Pending diff analysis',scenarios:[{id:'pending',title:'Generate branch checklist',path:'/',steps:['Wait for the generated checklist before reviewing.']}]});
}

export async function candidateComparison(git,comparison,candidate) {
  const files=(await git('diff','--name-only','-z',candidate.main,candidate.sha,'--')).split('\0').filter(file=>file && file!=='.branch-review.json');
  const plan=await loadPlan(git,comparison.branch.sha,files);
  return {...comparison,base:candidate.main,main:candidate.main,files,plan};
}
