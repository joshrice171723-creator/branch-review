import {reviewProgress} from './progress-model.js';
import {officeChecks} from './office-model.js';
import {qaState} from './qa-model.js';
import {canApprove,isPublished} from './review-model.js';
const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el;};
export function activity({api,getState,navigate,flush,poll}){
  const button=document.getElementById('toolbar-qa'),workspace=document.querySelector('main'),badge=node('span','');
  badge.className='qa-badge';badge.hidden=true;button.append(badge);
  const strip=document.createElement('div');strip.id='work-progress';
  strip.innerHTML='<span class="work-light" aria-hidden="true"></span><div role="status"><strong data-label></strong><span data-detail></span></div><button class="quiet" data-details>QA</button>';
  document.getElementById('preview-area').before(strip);
  const page=document.createElement('section');page.id='qa-page';page.hidden=true;page.setAttribute('aria-label','QA workspace');
  page.innerHTML=`<header class="qa-heading"><div><p class="eyebrow">TESTING & DELIVERY</p><h1>QA</h1><p>Review first. Send to QA when you are ready. Results stay with the tested version.</p></div><button data-back>Back to review</button></header><div class="qa-layout"><nav data-queue aria-label="Reviews sent to QA"></nav><section id="activity-dialog"><h2 data-title></h2><p data-status role="status"></p><p data-error role="alert"></p><p data-scope></p><div class="tool-actions"><button data-run>Run QA again</button><button data-watch>Watch browser</button><button data-stop>Stop QA</button><button data-open>Open this review</button></div><div class="office-legend"><span class="queued">Queued</span><span class="checking">Checking</span><span class="passed">Passed</span><span class="failed">Failed</span><span class="unverified">Unverified</span></div><div data-boxes class="qa-boxes"></div><section data-evidence hidden></section><section data-delivery><h2>Ready to deliver</h2><p data-delivery-message></p><div data-approval></div><div class="tool-actions" data-delivery-buttons><button data-approve>Approve changes</button></div><details data-delivery-details><summary>Delivery settings and recovery</summary></details></section><details data-technical><summary>Technical details</summary><p>Only the listed checks are covered. Full-app regression and exploratory agent QA are not configured by this runner.</p><section data-jobs></section></details></section></div>`;
  workspace.after(page);const find=s=>page.querySelector(s);let selectedId=null,savedRecord=null,selectedCheck=null,key='',evidenceKey='',sending=false,loading=false,jobKey='';
  const selected=()=>selectedId && selectedId!==getState().record?.id?savedRecord:getState().record;
  const close=()=>{page.hidden=true;document.body.classList.remove('qa-open');button.setAttribute('aria-pressed','false');};
  const open=()=>{page.hidden=false;document.body.classList.add('qa-open');button.setAttribute('aria-pressed','true');void render();};
  find('[data-back]').onclick=close;button.onclick=open;strip.querySelector('[data-details]').onclick=open;
  const go=async id=>{await navigate(id);close();};
  find('[data-open]').onclick=async()=>{try{await api('/api/start',{ref:selected().identity.ref});selectedId=null;savedRecord=null;await poll();}catch(e){find('[data-error]').textContent=e.message;}};
  find('[data-watch]').onclick=()=>window.desktop?.showBrowserQa();find('[data-stop]').onclick=()=>window.desktop?.stopBrowserQa();
  async function send(force=false){
    if(sending)return;
    const state=getState(),record=state.record;if(!record)return;
    selectedId=null;savedRecord=null;
    if(record.qaSubmission && !force){open();return;}
    sending=true;find('[data-error]').textContent='';
    try{if(!await flush())return;if(!window.desktop?.startBrowserQa)throw Error('Send to QA requires the desktop app.');if(!canApprove(getState().record))throw Error('Finish your review and resolve findings before sending to QA.');await window.desktop.startBrowserQa({id:record.id,submit:true});await poll();}
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
    badge.textContent=String(count);badge.hidden=!count;button.classList.toggle('working',!!state.qaRunning);button.dataset.tooltip=`QA${count?` · ${count} ready to deliver`:state.qaRunning?' · running':''}`;button.setAttribute('aria-label',button.dataset.tooltip);
    strip.hidden=!record && !state.busy && !state.jobsRunning;strip.classList.toggle('working',progress.working);
    strip.querySelector('[data-label]').textContent=record?.qaSubmission?qaState(record).label:progress.label;strip.querySelector('[data-detail]').textContent=progress.detail;
    if(record && canApprove(record) && !isPublished(record)){const action=document.getElementById('results-action');action.textContent=record.qaSubmission?'View QA':'Send to QA';action.disabled=state.busy || state.jobsRunning || sending || state.status!=='ready';document.getElementById('results-message').textContent=record.qaSubmission?'Your QA results and delivery controls are on the QA page.':'Review complete. Send this version to QA when you are ready.';}
    if(page.hidden)return;
    find('[data-queue]').replaceChildren(...rows.map(row=>{const b=node('button','');b.className='qa-review-row';b.setAttribute('aria-current',String(row.id===(selectedId || record?.id)));b.append(node('strong',row.title),node('span',row.delivered?'Delivered':row.status==='passed'?'Checks passed':row.status.replaceAll('-',' ')));b.onclick=async()=>{selectedId=row.id;selectedCheck=null;key='';if(row.id===getState().record?.id)savedRecord=getState().record;else {try{savedRecord=await api('/api/qa-review?id='+encodeURIComponent(row.id));}catch(e){find('[data-error]').textContent=e.message;return;}}void render();};return b;}));
    if(!rows.length)find('[data-queue]').append(node('p','No reviews sent yet. Finish a guided review, then choose Send to QA.'));
    const r=selected(),qa=qaState(r),active=r?.id===record?.id,checks=officeChecks(r?{...r,browserQa:qa.run?[qa.run]:[]}:null);
    find('[data-title]').textContent=r?.manifest.title || 'Your testing queue';find('[data-status]').textContent=qa.label;find('[data-status]').classList.toggle('working',qa.status==='running');
    if(state.error)find('[data-error]').textContent=state.error;
    const pages=qa.run?.actions.filter(a=>a.action==='visit').length || 0,assertions=(qa.run?.actions.length || 0)-pages;
    find('[data-scope]').textContent=qa.run?`${pages} page checks · ${assertions} behavior assertions. These checks do not cover the entire app.`:'QA starts only when you send a finished review. Opening a branch does not start it.';
    find('[data-run]').hidden=!r?.qaSubmission || !active || isPublished(r);find('[data-run]').disabled=state.busy || state.qaRunning || state.jobsRunning || !r || !canApprove(r);
    find('[data-watch]').hidden=!active || !qa.run || qa.run.id!==state.browserQaWindowRunId;
    find('[data-stop]').hidden=qa.status!=='running';find('[data-open]').hidden=!r || active;find('[data-open]').disabled=state.busy || state.qaRunning;
    const nextKey=JSON.stringify(checks);if(key!==nextKey){key=nextKey;find('[data-boxes]').replaceChildren(...checks.map(check=>{const box=node('button','');box.className='qa-box '+check.tone;box.append(node('strong',check.title),node('span',check.path || ''),node('small',check.action+' · '+check.label));box.onclick=()=>{selectedCheck=check.id;evidence(check);};return box;}));}
    evidence(checks.find(check=>check.id===selectedCheck));
    find('[data-delivery]').hidden=!r?.qaSubmission || !active;
    find('[data-delivery-message]').textContent=qa.ready?'The listed checks passed. Approve this version, then merge and push or publish.':'Delivery stays locked until this version passes QA and all review findings are resolved.';
    const approve=find('[data-approve]');approve.hidden=!!r?.approval;approve.disabled=!qa.ready || state.busy || state.qaRunning;
    for(const id of ['ship','publish'])document.getElementById(id).disabled ||= !qa.ready || state.qaRunning;
    const deploy=document.getElementById('project-deploy');deploy.hidden=state.publishTarget!==null;deploy.textContent='Publish';deploy.disabled=!qa.ready || !r?.approval || r?.delivery?.stage!=='pushed' || state.busy || state.qaRunning;
    if(find('[data-technical]').open && !loading){loading=true;try{const jobs=await api('/api/jobs'),relevant=jobs.filter(job=>job.reviewId===r?.id),j=JSON.stringify(relevant);if(j!==jobKey){jobKey=j;find('[data-jobs]').replaceChildren(...relevant.map(job=>{const details=node('details','');details.append(node('summary',`${job.provider || 'Agent'} ${job.kind} · ${job.status}`),node('pre',[job.error,job.result,job.log].filter(Boolean).join('\n')));return details;}));}}finally{loading=false;}}
  }
  return {render,open};
}
