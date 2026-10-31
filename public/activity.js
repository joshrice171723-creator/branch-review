import {reviewProgress} from './progress-model.js';
import {canApprove,isPublished} from './review-model.js';
export function activity({api,getState,navigate,flush,poll}){
  document.getElementById('toolbar-qa').hidden=true;
  const strip=document.createElement('div');strip.id='work-progress';
  strip.innerHTML='<span class="work-light" aria-hidden="true"></span><div role="status"><strong data-label></strong><span data-detail></span></div>';
  document.getElementById('preview-area').before(strip);
  const delivery=document.createElement('section');delivery.id='review-delivery';
  delivery.innerHTML='<h3>Review approval</h3><div data-approval></div><div class="tool-actions" data-actions hidden></div><details><summary>Optional publishing and recovery</summary><div data-publishing></div><div data-settings></div></details>';
  document.getElementById('guided-results').append(delivery);
  const approval=document.getElementById('approval-section');delivery.querySelector('[data-approval]').append(approval);
  delivery.querySelector('[data-actions]').append(document.getElementById('ship'));
  for(const id of ['publish','project-deploy'])delivery.querySelector('[data-publishing]').append(document.getElementById(id));
  delivery.querySelector('[data-settings]').append(document.getElementById('delivery-heading').closest('details'));
  const advanced=document.getElementById('delivery-heading').closest('details');advanced.open=true;
  const setup=document.createElement('div');setup.innerHTML='<h3>Meta Clinic publishing</h3><p>Optional: configure publishing to aimetaclinic.com. Use an SSH key file path or paste a key, and choose an encrypted recovery archive folder. This does not publish anything.</p>';setup.innerHTML+='<label for="publishing-key-path">SSH key file path</label><input id="publishing-key-path" type="text" autocomplete="off" placeholder="Absolute path to your existing SSH key file"><label for="publishing-recovery-path">Encrypted recovery archive folder</label><input id="publishing-recovery-path" type="text" autocomplete="off" placeholder="Absolute path to an existing folder"><button id="publishing-save-paths" type="button">Save paths</button><p id="publishing-path-status" role="status"></p>';setup.append(document.getElementById('release-settings'));document.getElementById('release-settings').textContent='Choose files instead';document.getElementById('tools-workspace').append(setup);
  const paste=document.createElement('div');paste.innerHTML='<label for="publishing-key-text">Or paste an SSH private key</label><textarea id="publishing-key-text" rows="5" autocomplete="off" spellcheck="false" placeholder="Paste the complete private key"></textarea><p>Your key is saved in a protected local file and is not shown again. Enter the recovery folder above, or leave it blank to reuse the saved folder.</p><button id="publishing-save-key" type="button">Save pasted key</button><p id="publishing-key-status" role="status"></p>';setup.append(paste);
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
    const deploy=document.getElementById('project-deploy');deploy.hidden=state.publishTarget!==null;deploy.disabled=!r?.approval||r?.delivery?.stage!=='pushed'||state.busy;
  }};
}
