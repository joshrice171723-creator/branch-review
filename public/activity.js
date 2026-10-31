import {reviewProgress} from './progress-model.js';
import {officeChecks} from './office-model.js';
import {qaState} from './qa-model.js';
import {canApprove,isPublished} from './review-model.js';
const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el;};
export function activity({api,getState,navigate,flush,poll}){
  const button=document.getElementById('toolbar-qa'),workspace=document.querySelector('main'),badge=node('span','');
  button.hidden=true;
  badge.className='qa-badge';badge.hidden=true;button.append(badge);
  const strip=document.createElement('div');strip.id='work-progress';
  strip.innerHTML='<span class="work-light" aria-hidden="true"></span><div role="status"><strong data-label></strong><span data-detail></span></div><button class="quiet" data-details>View details</button>';
  document.getElementById('preview-area').before(strip);
  const page=document.createElement('details');page.id='qa-page';page.hidden=true;page.setAttribute('aria-label','QA workspace');
  page.innerHTML=`<button data-back hidden>Back to review</button><div class="qa-layout"><nav data-queue aria-label="Reviews sent to QA"></nav><section id="activity-dialog"><h2 data-title></h2><p data-status role="status"></p><p data-error role="alert"></p><p data-scope></p><div class="tool-actions"><button data-run>Run QA again</button><button data-watch>Watch browser</button><button data-stop>Stop QA</button><button data-open>Open this review</button></div><div class="office-legend"><span class="queued">Queued</span><span class="checking">Checking</span><span class="passed">Passed</span><span class="failed">Failed</span><span class="unverified">Unverified</span></div><div data-boxes class="qa-boxes"></div><section data-evidence hidden></section><section data-delivery><h2>Ready to deliver</h2><p data-delivery-message></p><div data-approval></div><div class="tool-actions" data-delivery-buttons><button data-approve>Approve changes</button></div><details data-delivery-details><summary>Delivery settings and recovery</summary></details></section><details data-technical><summary>Technical details</summary><p>Only the listed checks are covered. Full-app regression and exploratory agent QA are not configured by this runner.</p><section data-jobs></section></details></section></div>`;
  const checksHeading=node('summary','Automated checks');page.prepend(checksHeading);
  document.getElementById('guided-results').append(page);const find=s=>page.querySelector(s);let selectedId=null,savedRecord=null,selectedCheck=null,key='',evidenceKey='',sending=false,loading=false,jobKey='';
  const selected=()=>selectedId && selectedId!==getState().record?.id?savedRecord:getState().record;
  const close=()=>{};
  const open=async()=>{page.open=true;const r=getState().record;if(r){await navigate(r.cursor?.itemId || r.manifest.scenarios[0].id,'results');page.scrollIntoView({block:'nearest'});}void render();};
  find('[data-back]').hidden=true;find('[data-queue]').hidden=true;
  button.onclick=open;strip.querySelector('[data-details]').onclick=open;
  const go=async id=>{await navigate(id);close();};
  find('[data-open]').onclick=async()=>{try{await api('/api/start',{ref:selected().identity.ref});selectedId=null;savedRecord=null;await poll();}catch(e){find('[data-error]').textContent=e.message;}};
  find('[data-watch]').onclick=()=>window.desktop?.showBrowserQa();find('[data-stop]').onclick=()=>window.desktop?.stopBrowserQa();
  async function send(force=false){
    if(sending)return;
    const state=getState(),record=state.record;if(!record)return;
    selectedId=null;savedRecord=null;
    if(record.qaSubmission && !force){void open();return;}
    page.open=true;sending=true;find('[data-error]').textContent='';
    try{if(!await flush())return;if(!window.desktop?.startBrowserQa)throw Error('Automated checks require the desktop app.');if(!canApprove(getState().record))throw Error('Finish your review and resolve change requests before running checks.');await window.desktop.startBrowserQa({id:record.id,submit:true});await poll();}
    catch(e){open();find('[data-error]').textContent=e.message;}finally{sending=false;void render();}
  }
  window.addEventListener('review:send-qa',()=>void send());find('[data-run]').onclick=()=>void send(true);
  find('[data-approve]').onclick=()=>document.getElementById('approve').onclick();
  function deliveryControls(){
    const approval=document.getElementById('approval-section'),ship=document.getElementById('ship'),publish=document.getElementById('publish'),advanced=document.getElementById('delivery-heading').closest('details');
    if(approval.parentElement!==find('[data-approval]'))find('[data-approval]').append(approval);
    for(const control of [ship,publish,document.getElementById('project-deploy')])if(control.parentElement!==find('[data-delivery-buttons]'))find('[data-delivery-buttons]').append(control);
    if(advanced.parentElement!==find('[data-delivery-details]'))find('[data-delivery-details]').append(advanced);advanced.open=true;
  }
  function evidence(check){
    const section=find('[data-evidence]'),nextKey=JSON.stringify(check || null);section.hidden=!check;if(nextKey===evidenceKey)return;evidenceKey=nextKey;if(!check)return;
    section.replaceChildren(node('h3',check.title),node('p',`${check.action} · ${check.label} · ${check.path || ''}`),node('p',check.message || 'No result recorded yet.'));
    if(check.screenshot){const img=node('img','');img.src='/screenshots/'+encodeURIComponent(check.screenshot);img.alt=check.title+' — '+check.label;section.append(img);}
    if(selected()?.id===getState().record?.id){const back=node('button','Review this change');back.onclick=()=>void go(check.itemId);section.append(back);}
  }
  async function render(){
    const state=getState(),record=state.record,progress=reviewProgress(state,state.jobActivity || []),rows=state.qaReviews || [];
    deliveryControls();
    const count=rows.filter(row=>row.ready && !row.delivered).length;
    badge.textContent=String(count);badge.hidden=!count;button.classList.toggle('working',!!state.qaRunning);button.dataset.tooltip=`Testing${count?` · ${count} ready to deliver`:state.qaRunning?' · running':''}`;button.setAttribute('aria-label',button.dataset.tooltip);
    strip.hidden=!record && !state.busy && !state.jobsRunning;strip.classList.toggle('working',progress.working);
    strip.querySelector('[data-label]').textContent=record?.qaSubmission?qaState(record).label:progress.label;strip.querySelector('[data-detail]').textContent=progress.detail;
    page.hidden=!record || record.cursor?.view!=='results';
    page.dataset.reviewed=String(!!record && canApprove(record));
    checksHeading.textContent=record?.qaSubmission?`Automated checks - ${qaState(record).label}`:record && canApprove(record)?'Automated checks - ready to run':'Automated checks - available after review';
    selectedId=null;savedRecord=null;
    if(page.hidden)return;
    const r=selected(),qa=qaState(r),active=r?.id===record?.id,checks=officeChecks(r?{...r,browserQa:qa.run?[qa.run]:[]}:null);
    find('[data-title]').textContent='';find('[data-status]').textContent=qa.run?qa.label:'Not run';find('[data-status]').classList.toggle('working',qa.status==='running');
    if(state.error)find('[data-error]').textContent=state.error;
    const pages=qa.run?.actions.filter(a=>a.action==='visit').length || 0,assertions=(qa.run?.actions.length || 0)-pages;
    find('[data-scope]').textContent=qa.run?`${pages} page checks · ${assertions} behavior assertions. These checks do not cover the entire app.`:'Checks open the review pages and verify supported changes. Finish your review and resolve requests to enable Run checks.';
    find('[data-run]').hidden=!active || isPublished(r);find('[data-run]').textContent=qa.status==='running'?'Running checks…':r?.qaSubmission?'Run checks again':'Run checks';find('[data-run]').disabled=state.busy || state.qaRunning || state.jobsRunning || !r || !canApprove(r);
    find('[data-watch]').hidden=!active || !qa.run || qa.run.id!==state.browserQaWindowRunId;
    find('[data-stop]').hidden=qa.status!=='running';find('[data-open]').hidden=!r || active;find('[data-open]').disabled=state.busy || state.qaRunning;
    const nextKey=JSON.stringify(checks);if(key!==nextKey){key=nextKey;find('[data-boxes]').replaceChildren(...checks.map(check=>{const box=node('button','');box.className='qa-box '+check.tone;box.append(node('strong',check.title),node('span',check.path || ''),node('small',check.action+' · '+check.label));box.onclick=()=>{selectedCheck=check.id;evidence(check);};return box;}));}
    find('[data-boxes]').hidden=!qa.run;page.querySelector('.office-legend').hidden=!qa.run;
    evidence(checks.find(check=>check.id===selectedCheck));
    find('[data-delivery]').hidden=!r?.qaSubmission || !active;
    find('[data-delivery-message]').textContent=qa.ready?'The listed checks passed. Approve this version, then merge and push or publish.':'Delivery stays locked until this version passes automated checks and all review findings are resolved.';
    const approve=find('[data-approve]');approve.hidden=!!r?.approval;approve.disabled=!qa.ready || state.busy || state.qaRunning;
    for(const id of ['ship','publish'])document.getElementById(id).disabled ||= !qa.ready || state.qaRunning;
    const deploy=document.getElementById('project-deploy');deploy.hidden=state.publishTarget!==null;deploy.textContent='Publish';deploy.disabled=!qa.ready || !r?.approval || r?.delivery?.stage!=='pushed' || state.busy || state.qaRunning;
    if(find('[data-technical]').open && !loading){loading=true;try{const jobs=await api('/api/jobs'),relevant=jobs.filter(job=>job.reviewId===r?.id),j=JSON.stringify(relevant);if(j!==jobKey){jobKey=j;find('[data-jobs]').replaceChildren(...relevant.map(job=>{const details=node('details','');details.append(node('summary',`${job.provider || 'Agent'} ${job.kind} · ${job.status}`),node('pre',[job.error,job.result,job.log].filter(Boolean).join('\n')));return details;}));}}finally{loading=false;}}
  }
  return {render,open};
}
