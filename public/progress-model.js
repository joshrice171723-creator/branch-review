import {itemStatus,isComplete} from './review-model.js';

export function reviewProgress(state,jobs=[],now=Date.now()){
  const record=state.record,sha=record?.identity.changed;
  const job=jobs.findLast(job=>job.reviewId===record?.id);
  const run=record?.browserQa?.findLast(run=>run.commit===sha);
  const pending=record?.manifest.scenarios.filter(item=>!isComplete(itemStatus(record,item))) || [];
  const current=record?.manifest.scenarios.find(item=>item.id===record.cursor?.itemId);
  const failed=run?.results.find(result=>result.passed===false);
  const next=record?.manifest.scenarios.find(item=>item.id===run?.actions[failed?.index]?.itemId) || pending.find(item=>item.id===current?.id) || pending[0];
  const pages=run?.results.filter(result=>result.passed && run.actions[result.index]?.action==='visit').length || 0;
  const assertions=run?.results.filter(result=>result.passed && ['text','style','url','visible'].includes(run.actions[result.index]?.action)).length || 0;
  const unverified=run?.results.filter(result=>result.skipped).length || 0;
  const result={label:'Choose a change',detail:'',working:false,run,next,pending:pending.length,pages,assertions,unverified};
  if(state.error)return {...result,label:'Needs attention',detail:state.error};
  if(job?.status==='running')return {...result,label:job.phase || (job.kind==='check'?'Running checks':'Making changes'),working:true,detail:'Your preview stays available while the agent works.'};
  if(job && ['failed','interrupted','cancelled'].includes(job.status))return {...result,label:'Needs attention',detail:job.error || `The agent job ${job.status}. Open Details for its saved work.`};
  if(state.busy || ['preparing','preview-ready'].includes(state.status))return {...result,label:state.status==='preview-ready'?'Checking the prepared preview':'Preparing preview',working:true,detail:'Review unlocks after the version checks pass.'};
  if(job?.status==='succeeded' && job.kind==='fix' && job.resultCommit && job.resultCommit!==sha)return {...result,awaitingReview:true,label:'Your changes are ready',detail:'Open Review changes to compare the new version and start its checks.'};
  if(!record)return result;
  if(['published','verified'].includes(record.delivery?.stage))return {...result,label:'Published',detail:record.museQa?`Live QA: ${record.museQa.status}`:'Local review and live verification are separate.'};
  if(run?.status==='running'){
    const last=run.results.at(-1)?.at || run.startedAt;
    if(now-Date.parse(last)>45000)return {...result,label:'Waiting for QA',detail:'No recent result. Open Details to inspect or stop the run.'};
    return {...result,label:'Testing your changes',working:true,detail:`${run.results.length} of ${run.actions.length} checks complete`};
  }
  if(run && ['failed','interrupted','cancelled'].includes(run.status))return {...result,label:'Needs attention',detail:run.error || `Browser checks ${run.status}. Results remain saved.`};
  if(!run)return {...result,label:state.automaticQa?'Preparing checks':'Ready for review',detail:'Behavior has not been checked automatically yet.'};
  return {...result,label:'Ready for review',detail:`${assertions} automatic ${assertions===1?'assertion':'assertions'} passed · ${pages} pages opened${unverified?` · ${unverified} checks need review`:''}`};
}
