export function changeRequest({api,getState,getSide,workflow,capture,previewReady=()=>true,poll,close}){
  const $=id=>document.getElementById(id),drafts=new Map();
  let target=null;
  let reviewId=null,submitting=false,opening=false,latest=null,notice='';
  const draftKey=()=>`branch-review:change:${getState().repository}:${getState().record?.id || 'new'}`;
  const readDraft=()=>{try{return localStorage.getItem(draftKey()) || '';}catch{return '';}};
  const storeDraft=value=>{try{if(value)localStorage.setItem(draftKey(),value);else localStorage.removeItem(draftKey());}catch{}};
  const provider=()=>getState().agent?.provider==='muse'?'Muse':getState().agent?.provider==='claude'?'Claude Code':'Codex';
  function render(rows){
    const state=getState(),id=state.record?.id;
    if(id!==reviewId){target=null;$('change-composer').hidden=true;reviewId=id;latest=null;notice='';$('change-request').value=drafts.get(id)||readDraft();}
    if(rows)latest=rows.findLast(row=>row.kind==='fix' && (row.reviewId===id || row.resultCommit && row.resultCommit===state.record?.identity?.changed))||null;
    const running=submitting || latest?.status==='running';
    $('make-changes').disabled=(!!id && state.status!=='ready') || state.busy || state.jobsRunning || !!state.previewVersion || running || opening || !$('change-request').value.trim();
    $('change-request').disabled=running || opening || !!state.previewVersion;
    $('checklist-advanced').hidden=!id;
    $('change-context').textContent=target?`Selected: ${target.label} · ${target.location}`:id?`${getSide()==='original'?'Original':'Changed'} · ${workflow.getContext(getSide()).location || 'Waiting for page…'} · screenshot included when sent`:'No preview open yet.';
    $('change-explanation').textContent=id?`${provider()} saves a new commit on this branch. Use history to preview or restore earlier versions.`:`${provider()} creates a work branch from the remote default branch. You review before publishing.`;
    $('change-status').textContent=notice || (latest?.previewReady && !previewReady()?'Loading the changed page…':'') || latest?.phase || (running?`${provider()} is making your changes…`:latest?.status==='succeeded'?'Your changes are ready to review.':latest && ['failed','interrupted','cancelled'].includes(latest.status)?`Changes need attention: ${latest.error || 'The run did not finish. Open Agent fixes for details.'}`:'');
    $('review-changes').hidden=latest?.status!=='succeeded' || !latest.resultCommit || latest.resultCommit===latest.commit || latest.resultCommit===state.record?.identity?.changed || !!latest.dirty;
    $('review-changes').disabled=opening || state.busy || running || !previewReady();
    $('agent-progress').hidden=!latest;
    $('agent-progress-title').textContent=running?`${provider()} is working`:latest?.status==='succeeded'?(latest.resultCommit===state.record?.identity?.changed?'Latest agent change':'Changes ready to review'):'Changes need attention';
    const summary=latest?.result?.split(/\n\s*\n/)[0].replace(/\[([^\]]+)\]\([^\n]+?\)/g,'$1');
    $('agent-progress-detail').textContent=notice || latest?.error || latest?.phase || summary || (running?'Your preview stays available while the agent works.':'');
    $('agent-progress-files').textContent=latest?.committedFiles?.length?'Changed files: '+latest.committedFiles.join(', '):'';
    $('agent-progress-stop').hidden=!latest?.cancellable || !running;
    $('agent-progress-stop').disabled=!!latest?.cancelRequested;
    $('agent-progress-review').hidden=$('review-changes').hidden;
    $('agent-progress-review').disabled=$('review-changes').disabled;
    $('agent-progress-recovery').hidden=!latest || !['failed','interrupted','cancelled'].includes(latest.status) && !latest.dirty && !latest.applyError;
  }
  $('change-request').oninput=()=>{drafts.set(reviewId,$('change-request').value);storeDraft($('change-request').value);notice='';render();};
  $('make-changes').onclick=async()=>{
    const state=getState(),id=state.record?.id,text=$('change-request').value.trim();
    if(submitting || !text || state.busy || state.jobsRunning)return;
    const side=getSide(),context=workflow.getContext(side),commit=state.record?.identity?.[side==='original'?'base':'changed'];
    const identity=()=>JSON.stringify([getState().record?.id,getState().record?.identity?.[getSide()==='original'?'base':'changed'],getSide(),workflow.getContext(getSide()).location]);
    const capturedIdentity=identity();
    if(target && target.identity!==capturedIdentity){notice='The page or version changed. Right-click the area again.';render();return;}
    submitting=true;notice='';render();
    try{
      if(id && !await workflow.flush())throw Error('Save your review notes before making changes.');
      if(getState().record?.id!==id)throw Error('The review changed. Submit your request again on the correct branch.');
      let attachment;
      if(id){
        if(!context.location)throw Error('Wait for the current page to finish loading.');
        const wasHidden=$('change-composer').hidden;$('change-composer').hidden=true;
        let screenshot;try{screenshot=await capture();}finally{$('change-composer').hidden=wasHidden;}
        if(identity()!==capturedIdentity)throw Error('The page or version changed during capture. Your request is saved; try again.');
        attachment={side,commit,location:context.location,screenshot};
      }
      const requestText=`Requested change:\n${text}\n\n${id?`Preview context: ${side} at ${context.location || 'the selected review screen'}${context.heading?'\nPage heading: '+context.heading:''}`:'This is a new change from the remote default branch; no preview has been opened.'}${target?'\nSelected area: '+JSON.stringify({selector:target.selector,label:target.label,rect:target.rect}):''}\nApply only this request. The old checklist is context, not additional work.`;
      const {result}=await api(id?'/api/job':'/api/new-change',{...(id?{id,kind:'fix'}:{}),requestText,...(attachment?{attachment}:{})});
      if(getState().record?.id===id){latest=result;drafts.delete(id);storeDraft('');$('change-request').value='';$('change-composer').hidden=true;}
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
      await api('/api/start',{ref:'refs/heads/'+job.branch,fixJob:job.id});close();await poll();if(job.sameBranch)document.getElementById('changed').click();
    }catch(error){notice=error.message;}
    finally{opening=false;render();}
  };
  function open(selection){
    render();
    target=selection?{...selection,identity:JSON.stringify([getState().record?.id,getState().record?.identity?.[getSide()==='original'?'base':'changed'],getSide(),workflow.getContext(getSide()).location])}:null;
    $('change-composer').hidden=false;render();$('change-request').focus?.();
  }
  $('close-change').onclick=()=>{$('change-composer').hidden=true;};
  $('agent-progress-review').onclick=()=>$('review-changes').onclick();
  $('agent-progress-stop').onclick=async()=>{if(!latest?.cancellable)return;try{await api('/api/job-cancel',{jobId:latest.id});await poll();}catch(error){notice=error.message;render();}};
  return {render,open};
}
