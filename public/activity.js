const node=(tag,text)=>{const element=document.createElement(tag);element.textContent=text;return element;};
export function activity({api,getState}){
  const button=document.getElementById('toolbar-qa');
  const dialog=document.createElement('dialog');dialog.id='activity-dialog';dialog.setAttribute('aria-label','Review activity');
  dialog.innerHTML=`<header class="dialog-heading"><h2>Activity</h2><button data-close>Close</button></header><p data-status role="status"></p><div class="tool-actions"><button data-start>Run browser checks</button><button data-watch>Watch browser</button><button data-stop>Stop browser checks</button></div><p>Page checks open each review screen and save screenshots. Add assertions below to test behavior. They never approve or merge your changes.</p><details><summary>Browser actions</summary><p>Leave empty for page checks. Use itemId, action (visit, click, fill, text, style), path or selector, and value. Style assertions also need property.</p><textarea data-actions rows="8" aria-label="Browser actions JSON"></textarea><button data-example>Show actions for this review</button></details><section data-runs></section><h3>Agent jobs</h3><section data-jobs></section>`;
  document.body.append(dialog);const find=selector=>dialog.querySelector(selector);
  button.onclick=()=>{dialog.showModal();void render();};find('[data-close]').onclick=()=>dialog.close();
  find('[data-example]').onclick=()=>{find('[data-actions]').value=JSON.stringify((getState().record?.manifest.scenarios || []).map(item=>({itemId:item.id,action:'visit',path:item.path})),null,2);};
  find('[data-start]').onclick=async()=>{try{if(!window.desktop?.startBrowserQa)throw Error('Browser QA requires the updated desktop app.');const record=getState().record;if(!record)throw Error('Open a review first.');const steps=JSON.parse(find('[data-actions]').value || '[]');await window.desktop.startBrowserQa({id:record.id,steps});find('[data-status]').textContent='Browser checks started. Watch the browser window or return here for evidence.';}catch(e){find('[data-status]').textContent=e.message;}};
  find('[data-watch]').onclick=()=>window.desktop?.showBrowserQa();find('[data-stop]').onclick=()=>window.desktop?.stopBrowserQa();
  let lastRecord,lastRuns,lastJobs;
  async function render(){
    const state=getState();button.classList.toggle('working',!!state.qaRunning || !!state.jobsRunning);const label=state.qaRunning?'Browser QA working':state.jobsRunning?'Agent working — view activity':'Browser QA and activity';button.dataset.tooltip=label;button.setAttribute('aria-label',label);
    if(!dialog.open)return;
    if(lastRecord!==state.record?.id){lastRecord=state.record?.id;find('[data-actions]').value='';}
    find('[data-start]').disabled=state.status!=='ready'||state.busy||state.qaRunning||state.jobsRunning;
    find('[data-stop]').disabled=!state.qaRunning;
    const runs=state.record?.browserQa || [];
    const runKey=JSON.stringify(runs);
    if(runKey!==lastRuns){lastRuns=runKey;find('[data-runs]').replaceChildren(...runs.toReversed().map(run=>{
      const section=node('article','');section.className='finding';section.append(node('h3',`${run.mode==='page-smoke'?'Page checks':'Browser assertions'} · ${run.status}`),node('p',`${run.commit.slice(0,7)} · ${run.results.length}/${run.actions.length} actions · ${new Date(run.startedAt).toLocaleString()}`));
      if(run.error)section.append(node('p',run.error));
      for(const result of run.results){const row=node('p',`${result.passed?'✓':'!'} ${result.index+1}. ${result.message}`);if(result.screenshot){const link=node('a',' View screenshot');link.href='/screenshots/'+result.screenshot;link.target='_blank';link.onclick=e=>{e.preventDefault();const img=node('img','');img.src=link.href;img.style.maxWidth='100%';row.append(img);};row.append(link);}section.append(row);}return section;
    }));}
    try{const jobs=await api('/api/jobs');const jobKey=JSON.stringify(jobs);if(jobKey===lastJobs)return;lastJobs=jobKey;find('[data-jobs]').replaceChildren(...jobs.filter(job=>job.reviewId===state.record?.id || job.commit===state.record?.identity.changed).toReversed().map(job=>{const row=node('details','');row.append(node('summary',`${job.provider || ''} ${job.kind} · ${job.status}`),node('p',job.error || job.result || ''),node('pre',job.log || 'Waiting for output…'));return row;}));}catch(e){find('[data-status]').textContent=e.message;}
  }
  return {render};
}
