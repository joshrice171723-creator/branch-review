import {canApprove} from './public/review-model.js';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isReviewDestination} from './public/preview-routes.js';

export function browserChecks(manifest,steps=[]){
  if(!Array.isArray(steps)||steps.length>100)throw Error('Use at most 100 browser actions.');
  if(!steps.length)return manifest.scenarios.map(item=>({itemId:item.id,action:'visit',path:item.path===':intake'?null:item.path}));
  return steps.map(step=>{
    if(!manifest.scenarios.some(item=>item.id===step.itemId))throw Error('Choose a current review item for each action.');
    if(!['visit','click','fill','text','style'].includes(step.action))throw Error('Browser actions are visit, click, fill, text or style.');
    if(step.action==='visit'){if(!isReviewDestination(step.path))throw Error('Browser navigation must stay in the preview.');return {itemId:step.itemId,action:step.action,path:step.path};}
    if(typeof step.selector!=='string'||!step.selector.trim()||step.selector.length>1000)throw Error('Enter a CSS selector for this action.');
    if(['fill','text','style'].includes(step.action) && (typeof step.value!=='string'||step.value.length>4000))throw Error('Enter an expected value or field value.');
    if(step.action==='style' && (typeof step.property!=='string'||!/^[-a-z]+$/.test(step.property)))throw Error('Enter a CSS property, such as background-color.');
    return {itemId:step.itemId,action:step.action,selector:step.selector,...(step.value!==undefined?{value:step.value}:{}),...(step.property?{property:step.property}:{})};
  });
}
export async function beginBrowserQa(store,record,steps,automatic=false,submitted=false){
  if(submitted && !canApprove(record))throw Error('Finish your guided review and resolve findings before sending to QA.');
  if(automatic && !submitted){const previous=record.browserQa?.find(run=>run.automatic && run.commit===record.identity.changed);if(previous)return {...previous,reused:true};}
  if(store.records.some(r=>r.browserQa?.some(run=>run.status==='running')))throw Error('A browser check is already running.');
  const actions=automatic?steps:browserChecks(record.manifest,steps);
  const run={id:randomUUID(),commit:record.identity.changed,status:'running',startedAt:new Date().toISOString(),automatic,mode:actions.some(step=>step.action!=='visit')?'assertions':'page-smoke',actions,results:[]};
  (record.browserQa ||= []).push(run);if(submitted)record.qaSubmission={commit:run.commit,runId:run.id,sentAt:run.startedAt};await store.event(record,'browser-qa-started',{runId:run.id,commit:run.commit});return run;
}
export async function browserQaResult(store,local,record,data){
  const run=record.browserQa?.find(run=>run.id===data.runId);
  if(!run || run.status!=='running' || data.commit!==run.commit)throw Error('This browser run is no longer active.');
  if(data.finish){
    if(!['passed','failed','cancelled','needs-review'].includes(data.finish))throw Error('Invalid browser result.');
    if(data.finish==='passed' && (run.results.length!==run.actions.length || run.results.some(row=>!row.passed || !row.screenshot)))throw Error('Every action needs successful screenshot evidence before passing.');
    if(data.finish==='needs-review' && (run.results.length!==run.actions.length || !run.results.some(row=>row.skipped) || run.results.some(row=>!row.screenshot || !row.passed && !row.skipped)))throw Error('Unverified checks must be recorded without hiding failures.');
    run.status=data.finish;run.error=typeof data.error==='string'?data.error.slice(0,2000):null;run.finishedAt=new Date().toISOString();
  }else{
    if(data.index!==run.results.length || data.index>=run.actions.length || typeof data.passed!=='boolean')throw Error('Browser evidence arrived out of order.');
    let screenshot;
    if(data.screenshot){if(typeof data.screenshot!=='string'||!data.screenshot.startsWith('data:image/png;base64,')||data.screenshot.length>12000000)throw Error('Invalid screenshot.');const png=Buffer.from(data.screenshot.slice(22),'base64');if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Screenshot must be PNG.');screenshot=randomUUID()+'.png';await mkdir(path.join(local,'screenshots'),{recursive:true});await writeFile(path.join(local,'screenshots',screenshot),png);}
    if(data.skipped && (!run.automatic || !run.actions[data.index].optional || data.passed))throw Error('Only optional automatic assertions may be unverified.');
    run.results.push({index:data.index,passed:data.passed,...(data.skipped?{skipped:true}:{}),message:String(data.message || '').slice(0,2000),screenshot,at:new Date().toISOString()});
    if(run.automatic && !data.passed && !data.skipped){
      const action=run.actions[data.index];
      await store.issue(record.id,{scenario:action.itemId,side:'changed',expected:action.action==='style'?`${action.selector}: ${action.property} should be ${action.value}`:'The review page should load successfully.',actual:String(data.message || 'Automatic browser check failed.').slice(0,2000),location:action.path || record.manifest.scenarios.find(item=>item.id===action.itemId)?.path});
      const finding=record.issues.at(-1);finding.screenshot=screenshot;finding.browserRunId=run.id;
    }
  }
  await store.persist();return run;
}
