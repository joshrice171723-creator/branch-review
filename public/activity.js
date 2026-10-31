import {reviewProgress} from './progress-model.js';
import {canApprove,isPublished} from './review-model.js';
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
