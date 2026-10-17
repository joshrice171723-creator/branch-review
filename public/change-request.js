export function changeRequest({api,getState,getSide,workflow,poll,close}){
  const $=id=>document.getElementById(id),drafts=new Map();
  let reviewId,submitting=false,opening=false,latest=null,notice='';
  const provider=()=>getState().agent?.provider==='claude'?'Claude Code':'Codex';
  function render(rows){
    const state=getState(),id=state.record?.id;
    if(id!==reviewId){reviewId=id;latest=null;notice='';$('change-request').value=drafts.get(id)||'';}
    if(rows)latest=rows.findLast(row=>row.reviewId===id && row.kind==='fix')||null;
    const running=submitting || latest?.status==='running';
    $('make-changes').disabled=(!!id && state.status!=='ready') || state.busy || state.jobsRunning || running || opening || !$('change-request').value.trim();
    $('change-request').disabled=running || opening;
    $('checklist-advanced').hidden=!id;
    $('change-explanation').textContent=`${provider()} will make your changes on a separate branch${id?'':' from the latest remote default branch'}. You review them before anything is merged or published.`;
    $('change-status').textContent=notice || (running?`${provider()} is making your changes…`:latest?.status==='succeeded'?'Your changes are ready to review.':latest && ['failed','interrupted','cancelled'].includes(latest.status)?`Changes need attention: ${latest.error || 'The run did not finish. Open Advanced for details.'}`:'');
    $('review-changes').hidden=latest?.status!=='succeeded' || !latest.resultCommit || latest.resultCommit===latest.commit || !!latest.dirty;
    $('review-changes').disabled=opening || state.busy || running;
  }
  $('change-request').oninput=()=>{drafts.set(reviewId,$('change-request').value);notice='';render();};
  $('make-changes').onclick=async()=>{
    const state=getState(),id=state.record?.id,text=$('change-request').value.trim();
    if(submitting || !text || state.busy || state.jobsRunning)return;
    const side=getSide(),context=workflow.getContext(side);
    submitting=true;notice='';render();
    try{
      if(id && !await workflow.flush())throw Error('Save your review notes before making changes.');
      if(getState().record?.id!==id)throw Error('The review changed. Submit your request again on the correct branch.');
      const requestText=`Requested change:\n${text}\n\n${id?`Preview context: ${side} at ${context.location || 'the selected review screen'}${context.heading?'\nPage heading: '+context.heading:''}`:'This is a new change from the remote default branch; no preview has been opened.'}\nApply only this request. The old checklist is context, not additional work.`;
      const {result}=await api(id?'/api/job':'/api/new-change',{...(id?{id,kind:'fix'}:{}),requestText});
      if(getState().record?.id===id){latest=result;drafts.delete(id);$('change-request').value='';}
      await poll();
    }catch(error){if(getState().record?.id===id)notice=error.message;}
    finally{submitting=false;render();}
  };
  $('review-changes').onclick=async()=>{
    if(opening || !latest || latest.status!=='succeeded')return;
    const job=latest,id=reviewId;opening=true;notice='Preparing your before and after preview…';render();
    try{
      if(id && !await workflow.flush())throw Error('Save your review notes before opening changes.');
      if(getState().record?.id!==id)throw Error('The active review changed. Open the changes from their original review.');
      await api('/api/start',{ref:'refs/heads/'+job.branch,fixJob:job.id});close();await poll();
    }catch(error){notice=error.message;}
    finally{opening=false;render();}
  };
  return {render};
}
