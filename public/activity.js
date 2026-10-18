import {reviewProgress} from './progress-model.js';
import {officeItems} from './office-model.js';
const node=(tag,text)=>{const element=document.createElement(tag);element.textContent=text;return element;};
export function activity({api,getState,navigate}){
  const button=document.getElementById('toolbar-qa'),aside=document.querySelector('aside.review');
  const strip=document.createElement('div');strip.id='work-progress';
  strip.innerHTML='<span class="work-light" aria-hidden="true"></span><div role="status"><strong data-label></strong><span data-detail></span></div><button class="quiet" data-watch>Watch</button><button class="quiet" data-details>Office</button>';
  document.getElementById('preview-area').before(strip);
  const panel=document.createElement('section');panel.id='activity-dialog';panel.hidden=true;panel.setAttribute('aria-label','Office');
  panel.innerHTML=`<header class="dialog-heading"><h2>Office</h2><button data-close>Back to review</button></header><p data-status role="status"></p><section><h3>What changed</h3><p data-changed></p></section><section><h3>What was tested</h3><p data-tested></p><div data-map class="office-map"></div></section><section><h3>Needs your attention</h3><p data-attention></p><button data-next>Review next item →</button></section><div class="tool-actions"><button data-watch>Watch browser</button><button data-stop>Stop browser checks</button></div><details data-evidence><summary>Test evidence</summary><section data-runs></section></details><details data-technical><summary>Technical details</summary><p>These checks never approve or publish changes.</p><details><summary>Custom browser actions</summary><p>Use itemId, action (visit, click, fill, text, style), path or selector, and value. Style assertions also need property.</p><textarea data-actions rows="8" aria-label="Browser actions JSON"></textarea><button data-example>Show actions for this review</button><button data-start>Run browser checks</button></details><h3>Agent jobs</h3><section data-jobs></section></details>`;
  aside.prepend(panel);const find=selector=>panel.querySelector(selector);
  let lastRuns='',lastJobs='',lastMap='',recordId,refreshing=false;
  const close=()=>{panel.hidden=true;aside.classList.remove('office-open');};
  const open=()=>{panel.hidden=false;aside.classList.add('office-open');aside.scrollTop=0;void render();find('[data-close]').focus();};
  const select=async id=>{await navigate(id);close();};
  button.onclick=open;strip.querySelector('[data-details]').onclick=open;find('[data-close]').onclick=close;
  const watch=()=>window.desktop?.showBrowserQa();strip.querySelector('[data-watch]').onclick=watch;find('[data-watch]').onclick=watch;
  find('[data-stop]').onclick=()=>window.desktop?.stopBrowserQa();
  find('[data-next]').onclick=()=>{const next=reviewProgress(getState(),getState().jobActivity || []).next;if(next)void select(next.id);};
  find('[data-technical]').ontoggle=()=>{if(find('[data-technical]').open)void render();};
  find('[data-example]').onclick=()=>{find('[data-actions]').value=JSON.stringify((getState().record?.manifest.scenarios || []).map(item=>({itemId:item.id,action:'visit',path:item.path})),null,2);};
  find('[data-start]').onclick=async()=>{try{if(!window.desktop?.startBrowserQa)throw Error('Browser QA requires the desktop app.');const record=getState().record;if(!record)throw Error('Open a review first.');await window.desktop.startBrowserQa({id:record.id,steps:JSON.parse(find('[data-actions]').value || '[]')});}catch(e){find('[data-status]').textContent=e.message;}};
  async function render(){
    const state=getState(),progress=reviewProgress(state,state.jobActivity || []),record=state.record;
    strip.hidden=!record && !state.busy && !state.jobsRunning;strip.classList.toggle('working',progress.working);
    strip.querySelector('[data-label]').textContent=progress.label;strip.querySelector('[data-detail]').textContent=progress.detail;
    const watchable=!!progress.run && progress.run.id===state.browserQaWindowRunId && !state.jobsRunning && !progress.awaitingReview;
    strip.querySelector('[data-watch]').hidden=!watchable;
    button.classList.toggle('working',progress.working);button.dataset.tooltip='Office — work and QA';button.setAttribute('aria-label','Office — work and QA');
    if(panel.hidden)return;
    if(recordId!==record?.id){recordId=record?.id;find('[data-actions]').value='';lastMap='';}
    panel.classList.toggle('working',progress.working);find('[data-status]').textContent=progress.label;
    const completedJob=state.jobActivity?.findLast(job=>job.status==='succeeded' && job.resultCommit===record?.identity.changed);
    find('[data-changed]').textContent=completedJob?.requestSummary?`Request: ${completedJob.requestSummary} Saved in ${completedJob.resultCommit.slice(0,7)} (${completedJob.committedFiles?.length || 0} files).`:record?`${record.manifest.summary || record.manifest.title || 'Current change'} · ${record.identity.changed.slice(0,7)}`:'Select a branch to see its work.';
    find('[data-tested]').textContent=progress.run?`${progress.assertions} assertions passed · ${progress.pages} pages opened. ${progress.unverified?`${progress.unverified} checks could not be verified.`:''}`:'No automatic test evidence for this version yet.';
    find('[data-attention]').textContent=progress.awaitingReview?progress.detail:state.error || (progress.pending?`${progress.pending} items need your review. Automatic checks do not replace your approval.`:'All review items are complete. Return to review for the next step.');
    find('[data-next]').hidden=!progress.next || !!progress.awaitingReview;find('[data-next]').disabled=!!state.busy || state.status!=='ready';
    const items=officeItems(record),mapKey=JSON.stringify(items);
    if(lastMap!==mapKey){lastMap=mapKey;find('[data-map]').replaceChildren(...items.map(item=>{const tile=node('button','');tile.className='office-tile '+item.tone;tile.append(node('strong',item.title),node('span',item.label));tile.onclick=()=>void select(item.id);return tile;}));}
    for(const tile of find('[data-map]').children)tile.disabled=!!state.busy || state.status!=='ready';
    find('[data-start]').disabled=state.status!=='ready'||state.busy||state.qaRunning||state.jobsRunning;find('[data-stop]').disabled=!state.qaRunning;find('[data-watch]').disabled=!watchable;
    const runs=record?.browserQa?.filter(run=>run.commit===record.identity.changed) || [],runKey=JSON.stringify(runs);
    if(lastRuns!==runKey){lastRuns=runKey;find('[data-runs]').replaceChildren(...runs.toReversed().map(run=>{const section=node('article','');section.className='finding';section.append(node('h3',`${run.mode==='page-smoke'?'Page checks':'Browser checks'} · ${run.status}`),node('p',`${run.commit.slice(0,7)} · ${new Date(run.startedAt).toLocaleString()}`));for(const result of run.results){const row=node('details','');row.append(node('summary',`${result.skipped?'Unverified':result.passed?'Passed':'Failed'}: ${result.message}`));if(result.screenshot){const img=node('img','');img.src='/screenshots/'+encodeURIComponent(result.screenshot);img.alt=result.message;img.loading='lazy';row.append(img);}section.append(row);}return section;}));}
    if(!find('[data-technical]').open || refreshing)return;
    refreshing=true;
    try{const requestedId=recordId;const jobs=await api('/api/jobs');if(getState().record?.id!==requestedId)return;const relevant=jobs.filter(job=>job.reviewId===recordId || record && job.resultCommit===record.identity.changed),key=JSON.stringify(relevant);if(lastJobs===key)return;lastJobs=key;find('[data-jobs]').replaceChildren(...relevant.toReversed().map(job=>{const row=node('details','');row.append(node('summary',`${job.provider || ''} ${job.kind} · ${job.status}`),node('p',job.error || (job.resultCommit?`Saved commit ${job.resultCommit.slice(0,7)}`:job.phase || job.status)));if(job.status==='running' && job.cancellable){const stop=node('button','Stop job');stop.disabled=!!job.cancelRequested;stop.onclick=async()=>{try{await api('/api/job-cancel',{jobId:job.id});await render();}catch(e){find('[data-status]').textContent=e.message;}};row.append(stop);}const logs=node('details','');logs.append(node('summary','Raw output'),node('pre',[job.result,job.log].filter(Boolean).join('\n') || 'Waiting for output…'));row.append(logs);return row;}));}catch(e){find('[data-status]').textContent=e.message;}finally{refreshing=false;}
  }
  return {render,open};
}
