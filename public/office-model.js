import {itemStatus,isComplete,statusLabels} from './review-model.js';

export function officeItems(record){
  if(!record)return [];
  const run=record.browserQa?.findLast(run=>run.commit===record.identity.changed);
  return record.manifest.scenarios.map(item=>{
    const manual=itemStatus(record,item);
    const results=run?.results.filter(result=>run.actions[result.index]?.itemId===item.id) || [];
    const failed=results.some(result=>result.passed===false && !result.skipped);
    const assertions=results.filter(result=>result.passed && ['text','style','url','visible'].includes(run.actions[result.index]?.action)).length;
    const checking=run?.status==='running' && run.actions[run.results.length]?.itemId===item.id;
    const tone=failed || ['needs-fixes','blocked'].includes(manual)?'attention':checking?'checking':isComplete(manual)?'complete':'pending';
    const evidence=failed?'Browser check failed':checking?'Checking now':assertions?`${assertions} assertions passed`:results.some(result=>result.passed)?'Page opened; behavior unverified':'Not automatically verified';
    return {id:item.id,title:item.title,tone,label:`${evidence} · ${statusLabels[manual]}`};
  });
}
