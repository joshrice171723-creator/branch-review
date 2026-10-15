import { findingKey, loadDraft, saveDraft } from './drafts.js';
import { guided } from './guided.js';
import { canApprove } from './review-model.js';
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
export function workflow({api, getState, getSide, error, poll, reopen}) {
  let scenario = 'intake', rendered = '', screenshot = null, screenshotKey = null, screenshotContext = null, draftKey = '', savingFinding = false, capturing = false;
  const retestNotes = new Map();
  const contexts = {original:{}, changed:{}};
  const guide = guided({api,getState,poll,error,onSelect:next=>{scenario=next;rendered='';render(getState());reopen(false);}});
  const currentKey = () => findingKey(getState().record?.id, scenario, getSide());
  const notice = message => { $('review-notice').textContent = message; };
  async function act(action, data = {}) {
    try { error(''); await api('/api/' + action, {id:getState().record?.id, ...data}); notice(action === 'check' ? 'Checklist saved.' : action === 'resolve' ? 'Retest result saved.' : action === 'approve' ? 'Approval saved for this exact version.' : 'Request accepted.'); }
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
  $('choose-repository').onclick = async () => { try { await window.desktop.chooseRepository(); } catch(e) { error(e.message); } };
  $('scenario-select').onchange = () => guide.navigate($('scenario-select').value);
  $('capture').hidden = !window.desktop;
  $('capture').onclick = async () => {
    const key = currentKey();
    const context = contexts[getSide()];
    try {
      capturing = true;
      $('capture').disabled = true;
      const captured = await window.desktop.capture();
      if (key !== currentKey()) { notice('The version changed during capture. Capture a new screenshot.'); return; }
      screenshot = captured; screenshotKey = key; screenshotContext = context; $('attachment').src = screenshot; $('attachment').hidden = false; $('remove-attachment').hidden = false;
      notice('Screenshot attached to this version. Switching versions clears the attachment.');
    }
    catch(e) { error(e.message); }
    finally { capturing = false; render(getState()); }
  };
  function clearScreenshot() { screenshot = null; screenshotKey = null; screenshotContext = null; $('attachment').removeAttribute('src'); $('attachment').hidden = true; $('remove-attachment').hidden = true; }
  $('remove-attachment').onclick = clearScreenshot;
  $('finding-form').onsubmit = async event => {
    event.preventDefault(); if (savingFinding) return;
    const state = getState(), side = getSide(), key = currentKey();
    savingFinding = true; render(state);
    try {
      error('');
      const context = screenshotKey === key ? screenshotContext : contexts[side];
      await api('/api/issue', {id:state.record.id, scenario, side, expected:$('expected').value, actual:$('actual').value, screenshot:screenshotKey === key ? screenshot : null, location:context?.location || '', consoleErrors:context?.errors || []});
      saveDraft(localStorage, key, {expected:'',actual:''});
      if (key === currentKey()) { $('finding-form').reset(); clearScreenshot(); }
      notice('Finding saved. It must be resolved before approval.');
    } catch(e) { error(e.message); }
    finally { savingFinding = false; await poll(); }
  };
  $('approve').onclick = () => act('approve', {reviewer:$('reviewer').value});
  $('candidate').onclick = () => { if(confirm('Prepare the merged result against current main? Save your preview edits first. The new candidate needs its own completed checklist and approval.')) act('candidate'); };
  $('ship').onclick = () => {
    const r = getState().record;
    if(confirm(`Merge and push reviewed commit ${r.identity.changed} to origin/main in ${r.identity.repository}?`)) act('ship', {confirmation:`MERGE ${r.identity.changed} TO origin/main`});
  };
  $('release-settings').hidden = !window.desktop;
  $('release-settings').onclick = async () => { try { const files=await window.desktop.chooseReleaseFiles(); if(files) await act('release-settings',files); } catch(e) { error(e.message); } };
  $('publish').onclick = () => {
    const state=getState(), sha=state.record.identity.changed;
    if(confirm(`Publish commit ${sha} to ${state.publishTarget}? This runs Meta Clinic's release pipeline, including backup and database migrations.`)) act('publish',{confirmation:`PUBLISH ${sha} TO ${state.publishTarget}`});
  };
  $('retry-publish').onclick = () => act('retry-publish',{note:$('release-note').value});
  $('smoke').onclick = () => act('smoke',{note:$('release-note').value});
  $('history').onchange = () => { $('retest').disabled = !$('history').value || getState().busy; };
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
    $('review-workflow').hidden=!r;
    $('choose-repository').disabled=state.busy;
    $('retest').disabled=state.busy || !$('history').value;
    if(!r) { void history(state); return; }
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
        const label=node('label','', 'check'), box=document.createElement('input');box.type='checkbox';box.checked=!!r.checks[`${scenario}:${index}`];box.disabled=!enabled;
        box.onchange=()=>act('check',{scenario,index,passed:box.checked});label.append(box,node('span',step));return label;
      }));
      $('findings').replaceChildren(...r.issues.map(issue=>{
        const card=node('article','', 'finding');card.append(node('strong',issue.status==='needs-retest'?'Needs retest':issue.status==='resolved'?'Resolved':'Open finding'),node('p',`Expected: ${issue.expected}`),node('p',`Actual: ${issue.actual}`),node('small',`${issue.side} · ${issue.commit.slice(0,7)} · ${issue.scenario} ${issue.location}`));
        if(issue.screenshot) { const image=document.createElement('img');image.src='/screenshots/'+issue.screenshot;image.alt='Captured review finding';image.loading='lazy';card.append(image); }
        if(issue.consoleErrors.length) card.append(node('pre',issue.consoleErrors.join('\n')));
        if(issue.status!=='resolved') {
          const note=document.createElement('textarea');note.placeholder='Describe the retest result';note.setAttribute('aria-label','Retest result');note.maxLength=2000;
          const noteKey = `${r.id}:${issue.id}`; note.value = retestNotes.get(noteKey) || ''; note.oninput = () => retestNotes.set(noteKey,note.value);
          const resolve=node('button','Resolve after retest','secondary');resolve.disabled=!enabled;resolve.onclick=()=>act('resolve',{issueId:issue.id,note:note.value});card.append(note,resolve);
        } else card.append(node('p',issue.resolution));
        return card;
      }));
      if(!r.issues.length) $('findings').append(node('p','No findings recorded.','small muted'));
      $('approval-state').textContent=r.approval?`Approved by ${r.approval.reviewer} · ${r.approval.commit.slice(0,7)}`:'Complete every check and resolve findings before approval.';
      $('delivery-state').textContent=r.delivery?`Delivery: ${r.delivery.stage.replaceAll('-',' ')}${r.delivery.error?' · '+r.delivery.error:''}`:r.integration?`Integration candidate ${r.integration.sha.slice(0,7)} against main ${r.integration.main.slice(0,7)}`:'Prepare the integration candidate before merging. It includes current main.';
    }
    for(const id of ['scenario-select','expected','actual','capture','report','reviewer','candidate','approve']) $(id).disabled=!enabled;
    for(const id of ['expected','actual','capture','report']) $(id).disabled=!enabled || savingFinding;
    $('capture').disabled ||= capturing;
    $('report').disabled ||= capturing;
    $('approve').disabled=!enabled || !canApprove(r);
    $('ship').disabled=!enabled || !r.approval || r.integration?.sha!==r.identity.changed || ['pushed','deploying','published','verified'].includes(r.delivery?.stage);
    $('publish').disabled=!enabled || !r.approval || r.delivery?.stage!=='pushed' || !state.releaseConfigured;
    $('release-settings').disabled=state.busy;
    $('smoke').disabled=!enabled || r.delivery?.stage!=='published';
    $('retry-publish').hidden=r.delivery?.stage!=='deployment-needs-inspection';
    $('retry-publish').disabled=!enabled;
    void history(state);
  }
  return {render, viewChanged, flush:guide.flush, resetContexts:()=>{contexts.original={};contexts.changed={};clearScreenshot();}, scenario:()=>scenario, context:(side,data)=>{contexts[side]={location:String(data.location||'').slice(0,700),errors:Array.isArray(data.errors)?data.errors.slice(-10):[]};}};
}
