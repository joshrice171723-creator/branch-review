import {canApprove} from './review-model.js';
export function qaState(record){
  const submission=record?.qaSubmission;
  if(!submission || submission.commit!==record.identity.changed)return {status:'not-sent',label:'Not sent to QA',ready:false};
  const run=record.browserQa?.findLast(run=>run.commit===submission.commit);
  if(run && run.id!==submission.runId)return {status:'review-changed',label:'Send the updated checks to QA',ready:false,run};
  if(!run)return {status:'interrupted',label:'QA needs restarting',ready:false};
  if(run.status==='running')return {status:'running',label:'QA running',ready:false,run};
  const passed=run.status==='passed' && run.actions.length>0 && run.results.length===run.actions.length && run.results.every(result=>result.passed && !result.skipped && result.screenshot);
  const ready=passed && canApprove(record);
  return {status:ready?'passed':passed?'review-changed':run.status,label:ready?'Checks passed':passed?'Review needs attention':run.status==='needs-review'?'Some checks are unverified':'QA needs attention',ready,run};
}
export function qaReviews(records){
  const latest=new Map();
  for(const record of records){const root=records.find(candidate=>candidate.id===record.reviewRootId);const key=root?.identity.ref || record.identity.ref;latest.set(key,record);}
  return [...latest.values()].filter(record=>record.qaSubmission).reverse().map(record=>({id:record.id,title:record.reviewTitle || record.manifest.title || record.title,ref:record.identity.ref,commit:record.identity.changed,updatedAt:record.updatedAt,status:qaState(record).status,ready:qaState(record).ready,delivered:['pushed','deploying','published','verified'].includes(record.delivery?.stage)}));
}
