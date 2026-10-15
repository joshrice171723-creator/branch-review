const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
export function workflow({api, getState, getSide, error, poll, reopen}) {
  let scenario = 'intake', rendered = '', screenshot = null, screenshotRecord = null;
  const contexts = {original:{}, changed:{}};
  async function act(action, data = {}) {
    try { error(''); await api('/api/' + action, {id:getState().record?.id, ...data}); await poll(); }
    catch(e) { error(e.message); }
  }
  $('choose-repository').hidden = !window.desktop;
  $('choose-repository').onclick = async () => { try { await window.desktop.chooseRepository(); } catch(e) { error(e.message); } };
  $('scenario-select').onchange = () => { scenario = $('scenario-select').value; rendered = ''; render(getState()); reopen(); };
  $('capture').hidden = !window.desktop;
  $('capture').onclick = async () => {
    try { screenshot = await window.desktop.capture(); screenshotRecord = getState().record?.id; $('attachment').src = screenshot; $('attachment').hidden = false; $('remove-attachment').hidden = false; }
    catch(e) { error(e.message); }
  };
  function clearScreenshot() { screenshot = null; screenshotRecord = null; $('attachment').removeAttribute('src'); $('attachment').hidden = true; $('remove-attachment').hidden = true; }
  $('remove-attachment').onclick = clearScreenshot;
  $('finding-form').onsubmit = async event => {
    event.preventDefault(); const state = getState(), side = getSide();
    try {
      await api('/api/issue', {id:state.record.id, scenario, side, expected:$('expected').value, actual:$('actual').value, screenshot:screenshotRecord === state.record.id ? screenshot : null, location:contexts[side].location || '', consoleErrors:contexts[side].errors || []});
      $('finding-form').reset(); clearScreenshot(); await poll();
    } catch(e) { error(e.message); }
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
  let historyKey = '';
  async function history(state) {
    const key=state.record?.updatedAt + ':' + state.busy;
    if(key===historyKey) return;
    historyKey=key;
    try {
      const rows=await api('/api/history'), selected=$('history').value;
      $('history').replaceChildren(node('option','Choose a saved review'));
      $('history').firstChild.value='';
      for(const row of rows) { const option=node('option',`${row.identity.changed.slice(0,7)} · ${row.openIssues} open · ${row.title}`);option.value=row.id;$('history').append(option); }
      $('history').value=selected;
    } catch(e) { error(e.message); }
  }
  function render(state) {
    $('repository-path').textContent = state.repository;
    $('repository-path').title = state.repository;
    const r=state.record, enabled=state.status==='ready' && !!r && !state.busy;
    $('review-workflow').hidden=!r;
    $('choose-repository').disabled=state.busy;
    $('retest').disabled=state.busy || !$('history').value;
    if(!r) { void history(state); return; }
    if(screenshotRecord && screenshotRecord!==r.id) clearScreenshot();
    if(!r.manifest.scenarios.some(s=>s.id===scenario)) scenario=r.manifest.scenarios[0].id;
    const key=JSON.stringify([r,scenario,enabled]);
    if(key!==rendered) {
      rendered=key;
      $('active-review').textContent=`Reviewing ${r.identity.ref.replace(/^refs\/(heads|remotes)\//,'')} · ${r.identity.changed.slice(0,7)}`;
      $('scenario-select').replaceChildren(...r.manifest.scenarios.map(s=>{const option=node('option',s.title);option.value=s.id;return option;}));
      $('scenario-select').value=scenario;
      const item=r.manifest.scenarios.find(s=>s.id===scenario);
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
          const resolve=node('button','Resolve after retest','secondary');resolve.disabled=!enabled;resolve.onclick=()=>act('resolve',{issueId:issue.id,note:note.value});card.append(note,resolve);
        } else card.append(node('p',issue.resolution));
        return card;
      }));
      if(!r.issues.length) $('findings').append(node('p','No findings recorded.','small muted'));
      $('approval-state').textContent=r.approval?`Approved by ${r.approval.reviewer} · ${r.approval.commit.slice(0,7)}`:'Complete every check and resolve findings before approval.';
      $('delivery-state').textContent=r.delivery?`Delivery: ${r.delivery.stage.replaceAll('-',' ')}${r.delivery.error?' · '+r.delivery.error:''}`:r.integration?`Integration candidate ${r.integration.sha.slice(0,7)} against main ${r.integration.main.slice(0,7)}`:'Prepare the integration candidate before merging. It includes current main.';
    }
    for(const id of ['scenario-select','expected','actual','capture','report','reviewer','candidate','approve']) $(id).disabled=!enabled;
    $('approve').disabled=!enabled || r.issues.some(i=>i.status!=='resolved') || r.manifest.scenarios.some(s=>s.steps.some((_,i)=>!r.checks[`${s.id}:${i}`]));
    $('ship').disabled=!enabled || !r.approval || r.integration?.sha!==r.identity.changed || ['pushed','deploying','published','verified'].includes(r.delivery?.stage);
    $('publish').disabled=!enabled || !r.approval || r.delivery?.stage!=='pushed' || !state.releaseConfigured;
    $('release-settings').disabled=state.busy;
    $('smoke').disabled=!enabled || r.delivery?.stage!=='published';
    $('retry-publish').hidden=r.delivery?.stage!=='deployment-needs-inspection';
    $('retry-publish').disabled=!enabled;
    void history(state);
  }
  return {render, scenario:()=>scenario, context:(side,data)=>{contexts[side]={location:String(data.location||'').slice(0,700),errors:Array.isArray(data.errors)?data.errors.slice(-10):[]};}};
}
