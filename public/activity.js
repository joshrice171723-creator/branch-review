import {reviewProgress} from './progress-model.js';
import {canApprove,isPublished} from './review-model.js';
export function activity({api,getState,navigate,flush,poll}){
  document.getElementById('toolbar-qa').hidden=true;
  const strip=document.createElement('div');strip.id='work-progress';
  strip.innerHTML='<span class="work-light" aria-hidden="true"></span><div role="status"><strong data-label></strong><span data-detail></span></div>';
  document.getElementById('preview-area').before(strip);
  const delivery=document.createElement('section');delivery.id='review-delivery';
  delivery.innerHTML='<h3>Approve and deliver</h3><div data-approval></div><div class="tool-actions" data-actions></div><details><summary>Delivery settings and recovery</summary><div data-settings></div></details>';
  document.getElementById('guided-results').append(delivery);
  const approval=document.getElementById('approval-section');delivery.querySelector('[data-approval]').append(approval);
  for(const id of ['ship','publish','project-deploy'])delivery.querySelector('[data-actions]').append(document.getElementById(id));
  delivery.querySelector('[data-settings]').append(document.getElementById('delivery-heading').closest('details'));
  const advanced=document.getElementById('delivery-heading').closest('details');
  return {open:async()=>{const r=getState().record;if(r)await navigate(r.cursor.itemId,'results');},render(){
    if(approval.parentElement!==delivery.querySelector('[data-approval]'))delivery.querySelector('[data-approval]').append(approval);
    if(advanced.parentElement!==delivery.querySelector('[data-settings]'))delivery.querySelector('[data-settings]').append(advanced);
    const state=getState(),r=state.record,progress=reviewProgress({...state,record:r?{...r,browserQa:[],qaSubmission:null}:null},state.jobActivity || []);
    strip.hidden=!r&&!state.busy&&!state.jobsRunning;strip.classList.toggle('working',progress.working);
    strip.querySelector('[data-label]').textContent=progress.label;strip.querySelector('[data-detail]').textContent=progress.label==='Ready for review'?(canApprove(r)?'Manual review complete. Approve this version from the summary.':`${progress.pending} review items remaining`):progress.detail;
    delivery.hidden=!r||!canApprove(r)||isPublished(r);
    const deploy=document.getElementById('project-deploy');deploy.hidden=state.publishTarget!==null;deploy.disabled=!r?.approval||r?.delivery?.stage!=='pushed'||state.busy;
  }};
}
