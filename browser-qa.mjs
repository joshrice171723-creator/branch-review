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
export async function beginBrowserQa(store,record,steps){
  if(store.records.some(r=>r.browserQa?.some(run=>run.status==='running')))throw Error('A browser check is already running.');
  const actions=browserChecks(record.manifest,steps);
  const run={id:randomUUID(),commit:record.identity.changed,status:'running',startedAt:new Date().toISOString(),mode:steps?.length?'assertions':'page-smoke',actions,results:[]};
  (record.browserQa ||= []).push(run);await store.event(record,'browser-qa-started',{runId:run.id,commit:run.commit});return run;
}
export async function browserQaResult(store,local,record,data){
  const run=record.browserQa?.find(run=>run.id===data.runId);
  if(!run || run.status!=='running' || data.commit!==run.commit)throw Error('This browser run is no longer active.');
  if(data.finish){
    if(!['passed','failed','cancelled'].includes(data.finish))throw Error('Invalid browser result.');
    if(data.finish==='passed' && (run.results.length!==run.actions.length || run.results.some(row=>!row.passed || !row.screenshot)))throw Error('Every action needs successful screenshot evidence before passing.');
    run.status=data.finish;run.error=typeof data.error==='string'?data.error.slice(0,2000):null;run.finishedAt=new Date().toISOString();
  }else{
    if(data.index!==run.results.length || data.index>=run.actions.length || typeof data.passed!=='boolean')throw Error('Browser evidence arrived out of order.');
    let screenshot;
    if(data.screenshot){if(typeof data.screenshot!=='string'||!data.screenshot.startsWith('data:image/png;base64,')||data.screenshot.length>12000000)throw Error('Invalid screenshot.');const png=Buffer.from(data.screenshot.slice(22),'base64');if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Screenshot must be PNG.');screenshot=randomUUID()+'.png';await mkdir(path.join(local,'screenshots'),{recursive:true});await writeFile(path.join(local,'screenshots',screenshot),png);}
    run.results.push({index:data.index,passed:data.passed,message:String(data.message || '').slice(0,2000),screenshot,at:new Date().toISOString()});
  }
  await store.persist();return run;
}
