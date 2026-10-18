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
export function officeChecks(record){
  if(!record)return [];
  const run=record.browserQa?.findLast(run=>run.commit===record.identity.changed);
  if(!run)return record.manifest.scenarios.map(item=>({id:item.id,itemId:item.id,title:item.title,action:'Review',tone:'queued',label:'Not run',path:item.path}));
  return run.actions.map((action,index)=>{
    const result=run.results.find(result=>result.index===index),item=record.manifest.scenarios.find(item=>item.id===action.itemId);
    const active=run.status==='running' && index===run.results.length;
    const tone=result?.skipped?'unverified':result?.passed?'passed':result?.passed===false?'failed':active?'checking':run.status==='running'?'queued':'unverified';
    return {id:run.id+':'+index,itemId:action.itemId,title:item?.title || action.itemId,path:action.path || item?.path,action:action.action==='visit'?'Page load':action.action==='style'?action.property:action.action,tone,label:({queued:'Queued',checking:'Checking',passed:'Passed',failed:'Failed',unverified:'Not verified'})[tone],message:result?.message,screenshot:result?.screenshot,commit:run.commit};
  });
}
