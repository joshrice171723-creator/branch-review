import { findingKey, loadDraft, saveDraft } from './drafts.js';
import { guided } from './guided.js';
import { canApprove,deliveryStep,isPublished } from './review-model.js';
import { previewDestination } from './preview-routes.js';
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
export async function mergeAndPublish(api, state, wait = ms => new Promise(resolve=>setTimeout(resolve,ms))) {
  const id=state.record.id, sha=state.record.identity.changed;
  if(state.record.delivery?.stage!=='pushed') {
    await api('/api/ship',{id,confirmation:`MERGE ${sha} TO origin/main`});
    for(let attempt=0;attempt<120;attempt++) {
      const next=await api('/api/state');
      if(next.record?.id!==id || next.record.identity.changed!==sha)throw Error('The active review changed. Publishing stopped.');
      if(!next.busy){if(next.error)throw Error(next.error);if(next.record.delivery?.stage!=='pushed')throw Error('Push was not confirmed. Publishing stopped.');break;}
      if(attempt===119)throw Error('Push is still running. Wait for it to finish, then resume publishing.');
      await wait(1000);
    }
  }
  await api('/api/publish',{id,confirmation:`PUBLISH ${sha} TO ${state.publishTarget}`});
}
export function workflow({api, getState, getSide, error, poll, reopen}) {
  let scenario = 'intake', rendered = '', screenshot = null, screenshotKey = null, screenshotContext = null, draftKey = '', savingFinding = false, capturing = false;
  const retestNotes = new Map();
  const contexts = {original:{}, changed:{}};
  let video=null,videoKey=null;
  let officeAfterPublish=null, delivering=false;
  const needsNavigation=item=>['original','changed'].some(side=>{
    const actual=contexts[side].location;if(!actual)return false;
    const expected=previewDestination(item,side,getState());
    return item.focus?actual.split('#')[0]!==expected.split('#')[0]:actual!==expected;
  });
  const guide = guided({api,getState,poll,error,needsNavigation,onSelect:next=>{scenario=next;rendered='';render(getState());reopen(needsNavigation(getState().record.manifest.scenarios.find(item=>item.id===next)));}});
  const currentKey = () => findingKey(getState().record?.id, scenario, getSide());
  const notice = message => { $('review-notice').textContent = message; if($('problem-status'))$('problem-status').textContent=message; };
  async function act(action, data = {}) {
    try { if(!await guide.flush())return;error(''); await api('/api/' + action, {id:getState().record?.id, ...data});if(action==='resolve'){const key=`${getState().record.id}:${data.issueId}`;retestNotes.delete(key);saveDraft(localStorage,`branch-review:retest:${key}`,{expected:'',actual:''});} notice(action === 'check' ? 'Checklist saved.' : action === 'resolve' ? 'Retest result saved.' : action === 'approve' ? 'Approval saved for this exact version.' : 'Request accepted.'); }
    catch(e) { error(e.message); }
    finally { await poll(); }
  }
  function saveFindingDraft() {
    if (draftKey && !saveDraft(localStorage, draftKey, {expected:$('expected').value, actual:$('actual').value})) notice('Draft could not be stored on this device. Keep this window open until you save the finding.');
  }
  $('expected').oninput = $('actual').oninput = saveFindingDraft;
  function viewChanged() {
    const key = currentKey();
    if (key === draftKey) return;
    saveFindingDraft();
    draftKey = key;
    const draft = loadDraft(localStorage, key);
    $('expected').value = draft.expected; $('actual').value = draft.actual;
    clearScreenshot();
    $('finding-context').textContent = `${getSide() === 'original' ? 'Original' : 'Changed'} · ${getState().record?.identity[getSide() === 'original' ? 'base' : 'changed']?.slice(0,7) || ''}. Text drafts are saved locally for this version and scenario.`;
    notice('');
  }
  $('choose-repository').hidden = !window.desktop;
  $('choose-repository').onclick = async () => { try { if(await guide.flush())await window.desktop.chooseRepository(); } catch(e) { error(e.message); } };
  $('scenario-select').onchange = () => guide.navigate($('scenario-select').value);
  $('capture').hidden = !window.desktop;
  $('capture').onclick = async () => {
    const key = currentKey();
    const context = contexts[getSide()];
    try {
      capturing = true;
      $('capture').disabled = true;
      const problem=$('problem-dialog');const wasOpen=problem?.open;if(wasOpen)problem.close();
      let captured;try{if(wasOpen)await new Promise(resolve=>setTimeout(resolve,100));captured=await window.desktop.capture();}finally{if(wasOpen)problem.showModal();}
      if (key !== currentKey()) { notice('The version changed during capture. Capture a new screenshot.'); return; }
      screenshot = captured; screenshotKey = key; screenshotContext = context; $('attachment').src = screenshot; $('attachment').hidden = false; $('remove-attachment').hidden = false;
      notice('Screenshot attached to this version. Switching versions clears the attachment.');
    }
    catch(e) { error(e.message); }
    finally { capturing = false; render(getState()); }
  };
  function clearScreenshot() { screenshot = null; screenshotKey = null; screenshotContext = null; video=null;videoKey=null;$('video-attachment').removeAttribute('src');$('video-attachment').hidden=true; $('attachment').removeAttribute('src'); $('attachment').hidden = true; $('remove-attachment').hidden = true; }
  $('remove-attachment').onclick = clearScreenshot;
  $('finding-form').onsubmit = async event => {
    event.preventDefault(); if (savingFinding) return;
    const state = getState(), side = getSide(), key = currentKey();
    savingFinding = true; render(state);
    try {
      error('');
      const context = screenshotKey === key ? screenshotContext : contexts[side];
      await api('/api/issue', {id:state.record.id, scenario, side, expected:$('expected').value, actual:$('actual').value, screenshot:screenshotKey === key ? screenshot : null, video:videoKey===key?video:null, location:context?.location || '', consoleErrors:context?.errors || []});
      saveDraft(localStorage, key, {expected:'',actual:''});
      if (key === currentKey()) { $('finding-form').reset(); clearScreenshot(); }
      notice('Finding saved. It must be resolved before approval.');
    } catch(e) { error(e.message); }
    finally { savingFinding = false; await poll(); }
  };
  $('published-report').onclick=()=>{
    const r=getState().record;
    $('published-problem-item').replaceChildren(...r.manifest.scenarios.map(item=>{const option=node('option',item.title);option.value=item.id;return option;}));
    $('published-problem-status').textContent='';$('published-problem').showModal();
  };
  $('close-published-problem').onclick=()=>$('published-problem').close();
  $('published-problem-form').onsubmit=async event=>{
    event.preventDefault();const r=getState().record,button=$('published-problem-save');if(button.disabled)return;
    button.disabled=true;$('published-problem-status').textContent='Saving…';
    try{await api('/api/issue',{id:r.id,scenario:$('published-problem-item').value,side:'published',expected:$('published-expected').value,actual:$('published-actual').value,location:getState().publishTarget});$('published-problem-form').reset();$('published-problem-status').textContent='Finding saved. Completed review unchanged.';await poll();}
    catch(e){$('published-problem-status').textContent='Save failed: '+e.message;}finally{button.disabled=false;}
  };
  $('approve').onclick = () => act('approve', {reviewer:$('reviewer').value});
  $('results-action').onclick=async()=>{
    const state=getState(),r=state.record;
    if(delivering || state.busy)return;
    if(['published','verified'].includes(r.delivery?.stage)){try{await api('/api/published-review',{id:r.id,action:'start'});await window.desktop.openPublished(state.publishTarget+'/qa?view=office');}catch(e){error(e.message);}return;}
    if(canApprove(r) && r.approval && r.integration?.sha===r.identity.changed && state.releaseConfigured && !['deployment-needs-inspection','push-unconfirmed'].includes(r.delivery?.stage)){
      if(!await guide.flush())return;
      if(!confirm(`Merge and publish this approved version to ${state.publishTarget}, then start Muse QA?`))return;
      delivering=true;officeAfterPublish=r.identity.changed;render(state);
      try{error('');await mergeAndPublish(api,state);}catch(e){officeAfterPublish=null;error(e.message);}finally{delivering=false;await poll();}return;
    }

    const action=deliveryStep(getState().record,getState().releaseConfigured).action;if(!action)return;
    const target=$(action);
    if(['reviewer','release-note'].includes(action)){$('results-options').open=true;const section=target.closest('details');if(section)section.open=true;target.scrollIntoView({block:'center'});target.focus();}
    else if(!target.disabled)target.click();
  };
  $('candidate').onclick = () => { if(confirm('Prepare the merged result against current main? Save your preview edits first. The new candidate needs its own completed checklist and approval.')) act('candidate'); };
  $('ship').onclick = () => {
    const r = getState().record;
    if(confirm(`Merge and push reviewed commit ${r.identity.changed} to origin/main in ${r.identity.repository}?`)) act('ship', {confirmation:`MERGE ${r.identity.changed} TO origin/main`});
  };
  $('release-settings').hidden = !window.desktop;
  $('release-settings').onclick = async () => { try { const files=await window.desktop.chooseReleaseFiles(); if(files) await act('release-settings',files); } catch(e) { error(e.message); } };
  $('publish').onclick = () => {
    const state=getState(), sha=state.record.identity.changed;
    if(confirm(`Publish commit ${sha} to ${state.publishTarget}? This runs Meta Clinic's release pipeline, including backup and database migrations, then requests one Muse QA pass and opens Office.`)){officeAfterPublish=sha;act('publish',{confirmation:`PUBLISH ${sha} TO ${state.publishTarget}`});}
  };
  $('retry-muse').onclick=()=>act('retry-muse');
  $('retry-publish').onclick = () => act('retry-publish',{note:$('release-note').value});
  $('smoke').onclick = () => act('smoke',{note:$('release-note').value});
  $('history').onchange = () => { $('retest').disabled = !$('history').value || getState().busy; $('view-history').disabled=!$('history').value; };
  $('finding-filter').onchange=()=>{rendered='';render(getState());};
  $('close-evidence').onclick=()=>{$('evidence-dialog').close();$('evidence-image').removeAttribute('src');};
  function report(id) {
    if(!id)return;
    $('report-frame').src=`/api/report?id=${encodeURIComponent(id)}&inline=1`;
    $('download-report').href=`/api/report?id=${encodeURIComponent(id)}`;
    $('report-dialog').showModal();
  }
  $('view-history').onclick=()=>report($('history').value);
  $('export-review').onclick=async()=>{if(await guide.flush())report(getState().record.id);};
  $('close-report').onclick=()=>{$('report-dialog').close();$('report-frame').removeAttribute('src');};
  $('retest').onclick = () => { if(confirm('Open the latest commit for this saved branch? Save preview edits first. Existing findings carry forward for retesting.')) act('retest',{id:$('history').value}); };
  let historyKey = '', historyLoading = false;
  async function history(state) {
    const key=state.record?.updatedAt + ':' + state.busy;
    if(key===historyKey || historyLoading) return;
    historyLoading=true;
    try {
      const rows=await api('/api/history'), selected=$('history').value;
      $('history').replaceChildren(node('option','Choose a saved review'));
      $('history').firstChild.value='';
      for(const row of rows) { const option=node('option',`${row.identity.changed.slice(0,7)} · ${row.openIssues} open · ${row.title}`);option.value=row.id;$('history').append(option); }
      $('history').value=selected;
      historyKey=key;
    } catch(e) { error(e.message); }
    finally { historyLoading=false; }
  }
  function render(state) {
    $('repository-path').textContent = state.repository;
    $('repository-path').title = state.repository;
    const r=state.record, enabled=state.status==='ready' && !!r && !state.busy;
    guide.render(state);
    const published=isPublished(r);
    $('published-report').hidden=!published;
    $('published-findings-status').hidden=!published;
    $('published-findings-status').textContent=r?.publishedFindings?.length?`${r.publishedFindings.length} published finding(s) saved`:' ';
    $('results-counts').hidden=published;
    $('results-options').hidden=published;
    $('results-checks-label').textContent=published?'Completed review':'Review checks';
    if(published)$('results-checks').append($('export-review'));else $('results-options').append($('export-review'));
    $('review-context').hidden=published;
    $('branch-brief').hidden=published;
    $('published-findings').hidden=!published || !r?.publishedFindings?.length;
    if(published)$('published-findings-list').replaceChildren(...(r.publishedFindings||[]).map(finding=>{const row=node('article','','finding');row.append(node('strong',finding.scenario),node('p',finding.actual),node('small',`Expected: ${finding.expected}`));return row;}));
    if(published){$('prepare-handoff').hidden=true;$('handoff-panel').hidden=true;$('results-message').hidden=true;}
    if(r){const step=deliveryStep(r,state.releaseConfigured);$('results-action').textContent=step.label;$('results-action-detail').textContent=step.detail;$('results-action').disabled=!enabled || !step.action || step.action==='release-settings' && !window.desktop;}
    if(r){
      const stage=r.delivery?.stage,done=['published','verified'].includes(stage),approved=canApprove(r) && !!r.approval && r.integration?.sha===r.identity.changed;
      $('results-title').textContent=done?'Published':stage==='deploying'?'Publishing…':delivering?'Merging…':approved?'Ready to publish':'Your review summary';
      $('results-action-detail').hidden=true;
      $('approval-section').hidden=!!r.approval;
      $('review-notice').hidden=published || r.cursor?.view==='results';
      if(done){$('results-action').textContent='Watch Muse in Office';$('results-action').disabled=!enabled || !window.desktop;}
      else if(approved && state.releaseConfigured && !['deployment-needs-inspection','push-unconfirmed'].includes(stage)){$('results-action').textContent=stage==='deploying'?'Publishing…':delivering?'Merging…':stage==='pushed'?'Publish':'Merge & publish';$('results-action').disabled=!enabled || delivering;}
    }
    $('review-workflow').hidden=!r;
    $('choose-repository').disabled=state.busy;
    $('retest').disabled=state.busy || !$('history').value;
    $('view-history').disabled=!$('history').value;
    if(!r) { void history(state); return; }
    if(state.busy && r.delivery?.stage==='deploying')officeAfterPublish=r.identity.changed;
    if(officeAfterPublish===r.identity.changed && ['published','verified'].includes(r.delivery?.stage) && !state.busy){officeAfterPublish=null;if(window.desktop)void window.desktop.openPublished(state.publishTarget+'/qa?view=office').catch(e=>error(e.message));}
    const qa=r.museQa;
    $('muse-qa-state').textContent=qa?`Muse QA: ${qa.status.replaceAll('-',' ')}${qa.status==='queued'?' · waiting for automatic pickup (usually within 60 seconds)':''}${qa.taskId?' · Office task '+qa.taskId:''}${qa.error?' · '+qa.error:''}${qa.statusError?' · '+qa.statusError:''}`:'';
    $('retry-muse').hidden=qa?.status!=='handoff-failed';$('retry-muse').disabled=state.busy;
    if(r.cursor?.itemId) scenario=r.cursor.itemId;
    if(!r.manifest.scenarios.some(s=>s.id===scenario)) scenario=r.manifest.scenarios[0].id;
    viewChanged();
    const key=JSON.stringify([r,scenario,enabled]);
    if(key!==rendered) {
      rendered=key;
      $('active-review').textContent=`Reviewing ${r.identity.ref.replace(/^refs\/(heads|remotes)\//,'')} · ${r.identity.changed.slice(0,7)}`;
      $('scenario-select').replaceChildren(...r.manifest.scenarios.map(s=>{const option=node('option',s.title);option.value=s.id;return option;}));
      $('scenario-select').value=scenario;
      const item=r.manifest.scenarios.find(s=>s.id===scenario);
      const total = r.manifest.scenarios.reduce((sum,s)=>sum+s.steps.length,0);
      const complete = r.manifest.scenarios.reduce((sum,s)=>sum+s.steps.filter((_,i)=>r.checks[`${s.id}:${i}`]).length,0);
      $('review-progress').textContent = `${complete} of ${total} checks passed · ${r.issues.filter(i=>i.status!=='resolved').length} open findings`;
      $('checks').replaceChildren(...item.steps.map((step,index)=>{
        const label=node('label','', 'check'), box=document.createElement('input');box.type='checkbox';box.checked=!!r.checks[`${scenario}:${index}`];box.disabled=!enabled || published;
        box.onchange=()=>act('check',{scenario,index,passed:box.checked});label.append(box,node('span',step));return label;
      }));
      const visibleFindings=r.issues.filter(issue=>$('finding-filter').value==='current'?issue.scenario===scenario:$('finding-filter').value==='open'?issue.status!=='resolved':true);
      $('findings-title').textContent=`Findings and retests · ${r.issues.filter(issue=>issue.status!=='resolved').length} open`;
      $('findings').replaceChildren(...visibleFindings.map(issue=>{
        const card=node('article','', 'finding');card.append(node('strong',issue.status==='needs-retest'?'Needs retest':issue.status==='resolved'?'Resolved':'Open finding'),node('p',`Expected: ${issue.expected}`),node('p',`Actual: ${issue.actual}`),node('small',`${issue.side} · ${issue.commit.slice(0,7)} · ${issue.scenario} ${issue.location}`));
        if(issue.screenshot) {
          const image=document.createElement('img');image.src='/screenshots/'+issue.screenshot;image.alt='Captured review finding';image.loading='lazy';
          const zoom=node('button','','evidence-thumbnail');zoom.type='button';zoom.setAttribute('aria-label','Enlarge finding screenshot');zoom.append(image);
          zoom.onclick=()=>{$('evidence-context').textContent=`${issue.side} · ${issue.commit} · ${issue.scenario} · ${issue.location}`;$('evidence-image').src=image.src;$('evidence-dialog').showModal();};card.append(zoom);
        }
        if(issue.consoleErrors.length) card.append(node('pre',issue.consoleErrors.join('\n')));
        if(issue.video){const video=document.createElement('video');video.controls=true;video.preload='metadata';video.src='/recordings/'+issue.video;card.append(video);}
        if(issue.status!=='resolved') {
          const note=document.createElement('textarea');note.placeholder='Describe the retest result';note.setAttribute('aria-label','Retest result');note.maxLength=2000;
          const noteKey = `${r.id}:${issue.id}`, savedKey=`branch-review:retest:${noteKey}`;
          note.value = retestNotes.get(noteKey) ?? loadDraft(localStorage,savedKey).actual;
          note.oninput = () => {retestNotes.set(noteKey,note.value);if(!saveDraft(localStorage,savedKey,{expected:'',actual:note.value}))notice('Keep this window open until your retest note is saved.');};
          const resolve=node('button','Resolve after retest','secondary');resolve.disabled=!enabled;resolve.onclick=()=>act('resolve',{issueId:issue.id,note:note.value});card.append(note,resolve);
        } else card.append(node('p',issue.resolution));
        return card;
      }));
      if(!visibleFindings.length) $('findings').append(node('p',r.issues.length?'No findings match this view.':'No findings recorded.','small muted'));
      $('approval-state').textContent=r.approval?`Approved by ${r.approval.reviewer} · ${r.approval.commit.slice(0,7)}`:canApprove(r)?'Review complete. Enter your name to approve this exact version.':'Complete every check and resolve findings before approval.';
      $('delivery-state').textContent=r.delivery?`Delivery: ${r.delivery.stage.replaceAll('-',' ')}${r.delivery.error?' · '+r.delivery.error:''}`:r.integration?`Integration candidate ${r.integration.sha.slice(0,7)} against main ${r.integration.main.slice(0,7)}`:'Prepare the integration candidate before merging. It includes current main.';
    }
    for(const id of ['scenario-select','expected','actual','capture','report','reviewer','candidate','approve']) $(id).disabled=!enabled;
    for(const id of ['expected','actual','capture','report']) $(id).disabled=!enabled || savingFinding;
    $('capture').disabled ||= capturing;
    $('report').disabled ||= capturing;
    $('approve').disabled=published || !enabled || !canApprove(r);
    $('ship').disabled=!enabled || !r.approval || r.integration?.sha!==r.identity.changed || ['pushed','deploying','published','verified'].includes(r.delivery?.stage);
    $('publish').disabled=!enabled || !r.approval || r.delivery?.stage!=='pushed' || !state.releaseConfigured;
    $('release-settings').disabled=state.busy;
    $('smoke').disabled=!enabled || r.delivery?.stage!=='published';
    $('retry-publish').hidden=r.delivery?.stage!=='deployment-needs-inspection';
    $('retry-publish').disabled=!enabled;
    void history(state);
  }
  return {render, viewChanged, flush:guide.flush, needsNavigation,
    attachScreenshot(data,notes=''){screenshot=data;screenshotKey=currentKey();screenshotContext=contexts[getSide()];$('attachment').src=data;$('attachment').hidden=false;$('remove-attachment').hidden=false;if(notes){$('actual').value=[$('actual').value,notes].filter(Boolean).join('\n');saveFindingDraft();}$('finding-form').closest('details').open=true;if($('problem-dialog')?.showModal && !$('problem-dialog').open)$('problem-dialog').showModal();$('finding-form').scrollIntoView({block:'start'});},
    attachVideo(data){video=data;videoKey=currentKey();$('video-attachment').src=data;$('video-attachment').hidden=false;$('remove-attachment').hidden=false;$('finding-form').closest('details').open=true;if($('problem-dialog')?.showModal && !$('problem-dialog').open)$('problem-dialog').showModal();$('finding-form').scrollIntoView({block:'start'});},
    getContext:side=>contexts[side] || {}, resetContexts:()=>{contexts.original={};contexts.changed={};clearScreenshot();}, scenario:()=>scenario, context:(side,data)=>{contexts[side]={location:String(data.location||'').slice(0,700),heading:String(data.heading||'').slice(0,160),anchor:String(data.anchor||'').slice(0,160),errors:Array.isArray(data.errors)?data.errors.slice(-10):[]};}};
}
