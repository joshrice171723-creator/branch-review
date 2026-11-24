import {reviewProgress} from './progress-model.js';
import {canApprove,isPublished} from './review-model.js';
export function coordinatorHealth(api) {
  if (!window.desktop) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toolbar-icon labeled-tool';
  button.textContent = 'Health';
  document.querySelector('.main-tools').append(button);
  const dialog = document.createElement('dialog');
  dialog.className = 'health-dialog';
  dialog.setAttribute('aria-labelledby', 'health-title');
  dialog.innerHTML = `<header class="dialog-heading health-heading"><div><span class="health-eyebrow">COORDINATOR</span><h2 id="health-title">App health</h2><p>Monitor checks and repair activity.</p></div><button type="button" class="quiet">Close</button></header><div class="health-content"><div class="health-summary" role="status"></div><div class="health-list"></div></div>`;
  document.body.append(dialog);
  const summary = dialog.querySelector('.health-summary');
  const list = dialog.querySelector('.health-list');
  dialog.querySelector('button').onclick = () => dialog.close();
  const notice = document.createElement('aside');
  notice.className = 'health-notice';
  notice.hidden = true;
  notice.innerHTML = '<div role="status"><strong></strong><p></p><p></p></div><button type="button" class="quiet">Close</button>';
  document.body.append(notice);
  const [finding, progress] = notice.querySelectorAll('p');
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.className = 'secondary';
  restart.textContent = 'Restart';
  restart.onclick = () => document.getElementById('restart-app').click();
  notice.insertBefore(restart, notice.querySelector('.quiet'));
  const dismissalKey = 'branch-review:health-dismissed';
  let dismissed = [];
  try {
    const saved = JSON.parse(localStorage.getItem(dismissalKey));
    if (Array.isArray(saved)) dismissed = saved;
  } catch {}
  let visibleNotice;
  notice.querySelector('.quiet').onclick = () => {
    dismissed = [...dismissed, visibleNotice].slice(-80);
    try { localStorage.setItem(dismissalKey, JSON.stringify(dismissed)); } catch {}
    notice.hidden = true;
  };
  function showNotice(incidents, maxAttempts) {
    const key = row => row.id + (row.state === 'attention' ? ':failed' : row.state === 'restart-required' ? ':restart' : row.state === 'awaiting-observation' ? ':observing' : ':active');
    const row = incidents.find(row => row.state === 'attention' && !dismissed.includes(key(row))) ||
      incidents.find(row => !['recovered', 'cancelled'].includes(row.state) && !dismissed.includes(key(row)));
    notice.hidden = !row;
    if (!row) return;
    visibleNotice = key(row);
    restart.hidden = row.state !== 'restart-required';
    const heading = row.state === 'attention' ? 'Coordinator needs your attention' :
      row.state === 'restart-required' ? 'Restart required' :
      row.state === 'awaiting-observation' ? 'Repair loaded · awaiting observation' :
      row.state === 'verifying' ? 'App Health is checking a repair' : 'App Health found an issue';
    const detail = row.state === 'attention' ? [row.note, row.nextAction].filter(Boolean).join(' ') :
      row.state === 'restart-required' ? `${row.note || ''} Select Restart to load the repair.` :
      row.state === 'verifying' ? row.note :
      row.state === 'awaiting-observation' ? row.note :
      row.state === 'retrying' ? `Attempt ${row.attempts} of ${maxAttempts} failed. App Health will try another approach.` :
      row.note || 'App Health will investigate and repair it automatically.';
    const message = row.title;
    const title = notice.querySelector('strong');
    if (title.textContent !== heading) title.textContent = heading;
    if (finding.textContent !== message) finding.textContent = message;
    if (progress.textContent !== detail) progress.textContent = detail;
  }
  let displayed;
  async function refresh() {
    try {
      const {incidents, error, disabled, checkedAt, maxAttempts} = await api('/api/workspace/coordinator/health');
      button.hidden = Boolean(disabled);
      const count = incidents.filter(row => !['recovered', 'cancelled'].includes(row.state)).length;
      button.textContent = count ? 'Health (' + count + ')' : 'Health';
      showNotice(incidents, maxAttempts);
      if (!dialog.open) return;
      summary.replaceChildren();
      const overview = document.createElement('strong');
      overview.textContent = error ? 'Health check unavailable' : count ? `${count} active ${count === 1 ? 'issue' : 'issues'}` : 'No active issues';
      const timestamp = document.createElement('span');
      timestamp.textContent = error || (checkedAt ? 'Last check ' + new Date(checkedAt).toLocaleTimeString() : 'Waiting for the first check.');
      summary.append(overview, timestamp);
      const snapshot = JSON.stringify(incidents);
      if (snapshot === displayed) return;
      displayed = snapshot;
      const expanded = new Set([...list.querySelectorAll('details[open]')].map(item => item.closest('article').dataset.id));
      list.replaceChildren();
      if (!incidents.length) {
        const empty = document.createElement('p');
        empty.className = 'health-empty';
        empty.textContent = 'Health checks will appear here.';
        list.append(empty);
      }
      for (const row of incidents.slice(0, 30)) {
        const item = document.createElement('article');
        item.className = 'health-card';
        item.dataset.id = row.id;
        const heading = document.createElement('div');
        heading.className = 'health-card-heading';
        const title = document.createElement('h3');
        title.textContent = row.title;
        const status = document.createElement('span');
        status.className = 'health-status';
        status.dataset.state = row.state;
        status.textContent = row.state.replaceAll('-', ' ');
        heading.append(title, status);
        item.append(heading);
        for (const [label, text] of [['Issue', row.error], ['Activity', row.note], ['Next action', row.nextAction], ['Checks', row.checks],
          ['Regression check', row.verification?.detail], ['Verified', row.verifiedAt && new Date(row.verifiedAt).toLocaleString()]]) {
          if (!text) continue;
          const detail = document.createElement('div');
          detail.className = 'health-detail';
          const name = document.createElement('span');
          name.textContent = label;
          const value = document.createElement('p');
          value.textContent = text;
          detail.append(name, value);
          item.append(detail);
        }
        if (row.state === 'restart-required') {
          const apply = restart.cloneNode(true);
          apply.hidden = false;
          apply.classList.add('health-apply');
          apply.onclick = restart.onclick;
          item.append(apply);
        }
        if (row.history?.length) {
          const history = document.createElement('details');
          history.className = 'health-detail';
          history.open = expanded.has(row.id);
          const heading = document.createElement('summary');
          heading.textContent = 'Repair attempts';
          const attempts = document.createElement('ol');
          for (const attempt of row.history) {
            const entry = document.createElement('li');
            entry.textContent = [attempt.approach, attempt.detail !== attempt.approach && attempt.detail, attempt.checks].filter(Boolean).join(' ');
            attempts.append(entry);
          }
          history.append(heading, attempts);
          item.append(history);
        }
        list.append(item);
      }
    } catch (error) { summary.textContent = error.message; }
  }
  button.onclick = () => { dialog.showModal(); void refresh(); };
  void refresh();
  setInterval(refresh, 3000);
}
export function activity({api,getState,navigate,flush,poll}){
  const strip=document.createElement('div');strip.id='work-progress';
  strip.innerHTML='<span class="work-light" aria-hidden="true"></span><div role="status"><strong data-label></strong><span data-detail></span></div>';
  document.getElementById('preview-area').before(strip);
  const delivery=document.createElement('section');delivery.id='review-delivery';
  delivery.innerHTML='<h3>Review approval</h3><div data-approval></div><div class="tool-actions" data-actions hidden></div><details><summary>Optional publishing and recovery</summary><div data-publishing></div><p id="project-deploy-feedback" role="status"></p><div data-settings></div></details>';
  document.getElementById('guided-results').append(delivery);
  const approval=document.getElementById('approval-section');delivery.querySelector('[data-approval]').append(approval);
  delivery.querySelector('[data-actions]').append(document.getElementById('ship'));
  for(const id of ['publish','project-deploy'])delivery.querySelector('[data-publishing]').append(document.getElementById(id));
  delivery.querySelector('[data-settings]').append(document.getElementById('delivery-heading').closest('details'));
  const advanced=document.getElementById('delivery-heading').closest('details');advanced.open=true;
  const setup=document.getElementById('publishing-setup'),paste=document.getElementById('publishing-paste');
  paste.querySelector('#publishing-save-key').onclick=async()=>{const status=paste.querySelector('#publishing-key-status'),button=paste.querySelector('#publishing-save-key'),key=paste.querySelector('#publishing-key-text');button.disabled=true;status.textContent='Saving...';try{await api('/api/release-key-text',{privateKey:key.value,recoveryDirectory:setup.querySelector('#publishing-recovery-path').value.trim()});key.value='';status.textContent='Key and recovery folder saved. Nothing was published.';await poll();}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
  setup.querySelector('#publishing-save-paths').onclick=async()=>{const status=setup.querySelector('#publishing-path-status'),button=setup.querySelector('#publishing-save-paths');button.disabled=true;status.textContent='Saving...';try{await api('/api/release-settings',{keyPath:setup.querySelector('#publishing-key-path').value.trim(),recoveryDirectory:setup.querySelector('#publishing-recovery-path').value.trim()});status.textContent='Publishing paths saved. Nothing was published.';await poll();}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
  return {open:async()=>{const r=getState().record;if(r)await navigate(r.cursor.itemId,'results');},render(){
    if(approval.parentElement!==delivery.querySelector('[data-approval]'))delivery.querySelector('[data-approval]').append(approval);
    if(advanced.parentElement!==delivery.querySelector('[data-settings]'))delivery.querySelector('[data-settings]').append(advanced);
    const state=getState(),r=state.record,progress=reviewProgress({...state,record:r?{...r,browserQa:[],qaSubmission:null}:null},state.jobActivity || []);
    strip.hidden=!r&&!state.busy&&!state.jobsRunning;strip.classList.toggle('working',progress.working);
    strip.querySelector('[data-label]').textContent=r?.delivery?.stage==='pushed'?'Merged and pushed':progress.label;strip.querySelector('[data-detail]').textContent=r?.delivery?.stage==='pushed'?`Reviewed commit ${r.delivery.commit.slice(0,7)} was pushed to main.`:progress.label==='Ready for review'?(canApprove(r)?r.approval?'Approved. Ready to merge and push.':'Manual review complete. Approve this version from the summary.':`${progress.pending} review items remaining`):progress.detail;
    delivery.hidden=!r||!canApprove(r)||isPublished(r);delivery.dataset.merged=String(r?.delivery?.stage==='pushed');
    delivery.querySelector('h3').textContent=r?.delivery?.stage==='pushed'?'Merged to main':'Review approval';
    setup.hidden=state.publishTarget===null;document.getElementById('candidate').hidden=!r || r.integration?.sha===r.identity.changed || r.delivery?.stage==='pushed';
    const deploy=document.getElementById('project-deploy');deploy.hidden=state.publishTarget!==null||!state.projectDelivery?.configured||!!r?.projectDeployment;deploy.disabled=!r?.approval||r?.delivery?.stage!=='pushed'||state.busy;
    const feedback=document.getElementById('project-deploy-feedback'),deployment=r?.projectDeployment;if(feedback)feedback.textContent=deployment?`Project deployment: ${deployment.status}${deployment.error?` · ${deployment.error}`:''}`:'';
  }};
}
