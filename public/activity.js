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
  dialog.setAttribute('aria-label', 'Coordinator health');
  dialog.innerHTML = '<header class="dialog-heading"><h2>Coordinator health</h2><button type="button">Close</button></header><div></div>';
  document.body.append(dialog);
  const body = dialog.querySelector('div');
  dialog.querySelector('button').onclick = () => dialog.close();
  async function refresh() {
    try {
      const {incidents, error, disabled, checkedAt} = await api('/api/workspace/coordinator/health');
      button.hidden = Boolean(disabled);
      const count = incidents.filter(row => row.state !== 'recovered').length;
      button.textContent = count ? 'Health (' + count + ')' : 'Health';
      if (!dialog.open) return;
      body.textContent = error || (checkedAt ? 'Last check ' + new Date(checkedAt).toLocaleTimeString() : 'Waiting for the first check.');
      for (const row of incidents.slice(0, 30)) {
        const item = document.createElement('article');
        const title = document.createElement('h3');
        title.textContent = (row.owner === 'host' ? 'Branch Review' : 'Project') + ' · ' + row.title;
        item.append(title);
        for (const text of [row.state, row.error, row.note, row.checks, row.verifiedAt && 'Check passed at ' + new Date(row.verifiedAt).toLocaleString()]) {
          if (text) { const p = document.createElement('p'); p.textContent = text; item.append(p); }
        }
        if (row.state === 'attention') {
          const retry = document.createElement('button');
          retry.textContent = 'Retry repair';
          retry.onclick = async () => {
            retry.disabled = true;
            try { await api('/api/workspace/coordinator/health/retry', {id: row.id}); await refresh(); }
            catch (issue) { body.textContent = issue.message; }
          };
          item.append(retry);
        }
        body.append(item);
      }
    } catch (error) { body.textContent = error.message; }
  }
  button.onclick = () => { dialog.showModal(); void refresh(); };
  void refresh();
  setInterval(refresh, 15000);
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
