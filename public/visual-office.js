import {officeChecks} from './office-model.js';
const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el;};
export function visualOffice({getState,navigate,details,start}){
  const dock=document.createElement('section');dock.id='visual-office';dock.hidden=true;dock.setAttribute('aria-label','Visual Office');
  dock.innerHTML=`<header><strong>Office <span data-live role="status"></span></strong><div><button data-run>Run QA</button><button data-details>Details</button><button data-hide aria-label="Hide Office">−</button></div></header><div class="office-studio"><div class="office-floor" role="group" aria-label="Office work stations"><div class="office-window" aria-hidden="true"></div><div class="office-rug" aria-hidden="true">BRANCH REVIEW</div><div class="office-station" data-agent><span class="office-monitor" aria-hidden="true">⌘</span><span class="office-person" aria-hidden="true"></span><strong data-agent-name>Codex</strong><small data-agent-status>Idle</small></div><div class="office-station" data-qa><span class="office-monitor" aria-hidden="true">✓</span><span class="office-person" aria-hidden="true"></span><strong>Browser QA <i class="station-light" aria-hidden="true"></i></strong><small data-qa-status>Waiting</small></div><div class="office-review-seat"><span aria-hidden="true">◎</span> You <small data-human></small></div><span class="office-plant" aria-hidden="true">♣</span></div><div class="office-board"><div class="office-legend"><span class="queued">Queued</span><span class="checking">Checking</span><span class="passed">Passed</span><span class="failed">Failed</span><span class="unverified">Unverified</span></div><div data-boxes class="qa-boxes" aria-label="QA checks"></div><p class="office-footnote">Each box is one browser check. Passing checks does not approve the review.</p></div></div>`;
  document.querySelector('.preview-footer').before(dock);const find=selector=>dock.querySelector(selector);
  const evidence=document.createElement('section');evidence.id='office-check-detail';evidence.hidden=true;document.querySelector('#activity-dialog header').after(evidence);
  let selected=null,boxKey='';
  function show(check){
    evidence.hidden=false;evidence.replaceChildren(node('h3',check.title),node('p',`${check.action} · ${check.label}`),node('p',check.path || ''),node('p',check.message || (check.tone==='checking'?'The browser is checking this now.':'No result recorded yet.')));
    if(check.screenshot){const img=node('img','');img.src='/screenshots/'+encodeURIComponent(check.screenshot);img.alt=`${check.title}: ${check.label}`;evidence.append(img);}
    const review=node('button','Review this item →');review.disabled=getState().busy || getState().status!=='ready';review.onclick=async()=>{await navigate(check.itemId);document.getElementById('activity-dialog').hidden=true;document.querySelector('aside.review').classList.remove('office-open');};evidence.append(review);
  }
  find('[data-hide]').onclick=()=>{dock.hidden=true;};find('[data-details]').onclick=details;
  find('[data-run]').onclick=()=>{find('[data-run]').disabled=true;start();};
  function render(state,progress){
    const record=state.record,checks=officeChecks(record),key=JSON.stringify(checks);
    find('[data-live]').textContent=progress.working?'● Working':progress.label;
    const agentBusy=(state.jobActivity || []).some(job=>job.reviewId===record?.id && job.status==='running');
    find('[data-agent-name]').textContent=state.agent?.provider==='claude'?'Claude':'Codex';find('[data-agent]').classList.toggle('working',agentBusy);find('[data-agent-status]').textContent=agentBusy?'Working':'Idle';
    const qaBusy=progress.run?.status==='running' && progress.working && !agentBusy;
    find('[data-qa]').classList.toggle('working',qaBusy);find('[data-qa-status]').textContent=qaBusy?'Checking…':progress.run?.status==='running'?'Waiting for result':progress.run?.status || 'Not run';
    find('[data-human]').textContent=`${progress.pending} to review`;
    find('[data-run]').disabled=state.status!=='ready'||state.busy||state.qaRunning||state.jobsRunning;
    if(key!==boxKey){boxKey=key;find('[data-boxes]').replaceChildren(...checks.map((check,index)=>{const box=node('button','');box.className='qa-box '+check.tone;box.dataset.checkId=check.id;box.setAttribute('aria-label',`${check.title}: ${check.action}, ${check.label}`);box.title=check.title+' · '+(check.path || '');box.append(node('strong',`${index+1}. ${check.action}`),node('span',check.path || check.title),node('small',check.label));box.onclick=()=>{selected=check.id;show(check);details();};return box;}));}
    if(selected){const check=checks.find(check=>check.id===selected);if(check)show(check);else{selected=null;evidence.hidden=true;}}
  }
  return {render,open(){dock.hidden=false;}};
}
