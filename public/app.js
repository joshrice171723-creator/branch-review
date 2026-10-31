import {batchReview} from './batch-review.js';
import {branchHistory} from './branch-history.js';
import {describeError} from './error-message.js';
import {framePool} from './frame-pool.js';
import {onboarding} from './onboarding.js';
import {projectSetup} from './project-setup.js';
import {activity} from './activity.js';
import { workflow } from './workflow.js';
import { reviewShortcut, refreshedSelection, selectedReviewState } from './shortcuts.js';
import {workbench} from './workbench.js';
import {evidenceTools} from './evidence-tools.js';
const $ = (id) => document.getElementById(id);
function dismissOverlays() {
  let pressedBackdrop=null;
  const outside=(dialog,event)=>{
    const box=dialog.getBoundingClientRect();
    return event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom;
  };
  const closeMenus=target=>{
    for(const menu of document.querySelectorAll('.comparison-menu[open]'))if(!target || !menu.contains(target))menu.open=false;
  };
  document.addEventListener('pointerdown',event=>{
    closeMenus(event.target);
    const dialog=event.target.closest?.('dialog[open]');
    pressedBackdrop=event.button===0 && dialog && event.target===dialog && outside(dialog,event)?dialog:null;
  });
  document.addEventListener('pointerup',event=>{
    const dialog=pressedBackdrop;pressedBackdrop=null;
    if(dialog?.open && event.target===dialog && outside(dialog,event))dialog.close();
  });
  document.addEventListener('pointercancel',()=>{pressedBackdrop=null;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenus();});
  // Preview frames own their pointer events, so detect focus moving into a frame.
  window.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement?.tagName==='IFRAME')closeMenus();},0));
}
dismissOverlays();
function resizablePanels(main) {
  const left=main.querySelector('.panel-divider-left'),right=main.querySelector('.panel-divider-right');
  if (!left || !right) return;
  main.classList.add('resizable-layout');
  const key='branch-review:panel-widths';
  let saved={};try{saved=JSON.parse(localStorage.getItem(key) || '{}') || {};}catch{}
  const narrow=()=>window.matchMedia('(max-width: 950px)').matches;
  const limits=side=>{
    const width=main.getBoundingClientRect().width;
    const rail=main.querySelector('.branches').getBoundingClientRect().width;
    const review=narrow()?0:main.querySelector('.review').getBoundingClientRect().width;
    return side==='left' ? [160,Math.max(160,width-review-320)] : [260,Math.max(260,width-rail-320)];
  };
  function set(side,value) {
    const [min,max]=limits(side), size=Math.round(Math.max(min,Math.min(max,value)));
    main.style.setProperty(side==='left'?'--rail-width':'--review-width',`${size}px`);
    const handle=side==='left'?left:right;
    handle.setAttribute('aria-valuemin',String(min));handle.setAttribute('aria-valuemax',String(max));handle.setAttribute('aria-valuenow',String(size));handle.setAttribute('aria-valuetext',`${size} pixels`);
    return size;
  }
  function persist(){try{localStorage.setItem(key,JSON.stringify(saved));}catch{}}
  for(const [handle,side,selector] of [[left,'left','.branches'],[right,'right','.review']]) {
    if(Number.isFinite(saved[side]))saved[side]=set(side,saved[side]);
    else {const [min,max]=limits(side);handle.setAttribute('aria-valuemin',String(min));handle.setAttribute('aria-valuemax',String(max));handle.setAttribute('aria-valuenow',String(Math.round(main.querySelector(selector).getBoundingClientRect().width)));}
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      event.preventDefault();handle.setPointerCapture(event.pointerId);handle.classList.add('active');document.body.classList.add('resizing-panels');
    });
    handle.addEventListener('pointermove',event=>{
      if(!handle.hasPointerCapture(event.pointerId))return;
      const box=main.getBoundingClientRect();saved[side]=set(side,side==='left'?event.clientX-box.left:box.right-event.clientX);
    });
    const finish=event=>{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);handle.classList.remove('active');document.body.classList.remove('resizing-panels');persist();};
    handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('lostpointercapture',()=>{handle.classList.remove('active');document.body.classList.remove('resizing-panels');});
    handle.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
      event.preventDefault();const direction=event.key==='ArrowRight'?1:-1;const current=main.querySelector(selector).getBoundingClientRect().width;
      saved[side]=set(side,current+direction*(side==='left'?1:-1)*(event.shiftKey?40:10));persist();
    });
  }
  window.addEventListener('resize',()=>{for(const side of ['left','right'])if(Number.isFinite(saved[side]) && (side==='left'||!narrow()))set(side,saved[side]);});
}

resizablePanels(document.querySelector('main'));
const pendingChecks=document.createElement('p');pendingChecks.setAttribute('role','status');pendingChecks.hidden=true;pendingChecks.textContent='Your preview is ready. Final checks are running. Review and approval unlock when all checks pass.';$('review-branch-status').before(pendingChecks);
const openingSummary=document.createElement('p');openingSummary.id='opening-summary';$('phase').before(openingSummary);
const fixNotice=document.createElement('p');fixNotice.style.cssText='font-size:12px;line-height:1.5;white-space:normal';fixNotice.hidden=true;$('review-branch-status').after(fixNotice);
const versionHistory=document.createElement('details'),versionHeading=document.createElement('summary'),versionResults=document.createElement('div');versionHeading.textContent='Review history';versionHistory.append(versionHeading,versionResults);versionHistory.hidden=true;fixNotice.after(versionHistory);$('review-context').append(fixNotice,versionHistory);
let allBranches = [],
  selected = null, openingSelection = null,
  token = "",
  currentState = {},
  active = "changed",
  frameKey = "",
  selectionGeneration = 0, selectedComparison = null, commitBranchSha = '', diffGeneration = 0;
try{openingSelection=JSON.parse(sessionStorage.getItem('branch-review:opening') || 'null');if(openingSelection){openingSelection.starting=false;selected=openingSelection;}}catch{}
const reviewWorkflow = workflow({api, getState:()=>currentState, getSide:()=>active, error, poll, reopen:(force=true)=>mountFrames(currentState,force)});
const reviewTools=workbench({api,getState:()=>currentState,getSide:()=>active,workflow:reviewWorkflow,capture:()=>evidence.snapshot(),previewReady:()=>previews.isPrepared(currentState.preparedReview),poll,error,reopen:()=>mountFrames(currentState,true)});
const batch=batchReview({api,getState:()=>currentState,getSide:()=>active,workflow:reviewWorkflow,capture:()=>evidence.snapshot(),poll,error});
const evidence=evidenceTools({api,getState:()=>currentState,getSide:()=>active,workflow:reviewWorkflow,toggle,reopen:()=>mountFrames(currentState,true),poll});
projectSetup({api,getState:()=>currentState,poll});
const activityView=activity({api,getState:()=>currentState,navigate:reviewWorkflow.navigate,flush:reviewWorkflow.flush,poll});
$('toolbar-review').onclick=()=>reviewTools.open('plan');
$('new-change').onclick=()=>reviewTools.requestChange();
$('toolbar-agent').onclick=()=>reviewTools.open('updates');
const evidenceMenu=document.createElement('button');evidenceMenu.textContent='Evidence tools';evidenceMenu.className='secondary';evidenceMenu.onclick=()=>reviewTools.open('evidence');$('item-more').append(evidenceMenu);
const branchHistoryView=branchHistory({api,getState:()=>currentState,flush:reviewWorkflow.flush,poll,error});

// Move existing controls so their state and handlers stay intact.
for(const id of ['history','health-status','files'])$('workspace-details').append($(id).closest('details'));
$('results-options').append($('export-review'),$('delivery-heading').closest('details'));
$('results-action').before($('approval-section'));
$('results-checks').append($('resume-review'));
$('results-checks').append($('review-context'),$('results-options'));
$('results-action').after($('muse-qa-state'),$('retry-muse'));
$('results-checks').before($('prepare-handoff'),$('handoff-panel'));
const problem=$('problem-dialog'),findingSection=$('finding-form').closest('details');
problem.append(findingSection,$('findings-title').closest('details'));findingSection.open=true;
$('close-problem').onclick=()=>problem.close();
$('problem-evidence').onclick=()=>{problem.close();reviewTools.open('evidence');};
$('open-codex-handoff').onclick=()=>reviewTools.open('updates');
let branchVisibility=null;
try{branchVisibility=JSON.parse(localStorage.getItem('branch-review:branches-visible') || 'null');}catch{}
function branchVisibilityUI() {
  const visible=branchVisibility ?? !currentState.record;
  const rail=$('branches').closest('.branches');
  rail.classList.toggle('compact',!visible);
  rail.classList.toggle('show-branches',visible);
  $('toggle-branches').hidden=!currentState.record;
  $('toggle-branches').textContent=visible?'Show review items':'Show branches';$('toggle-branches').setAttribute('aria-expanded',String(visible));
  $('rail-review').hidden=visible || !currentState.record;
  $('rail-review').textContent=currentState.record?.identity.ref.replace(/^refs\/(heads|remotes)\//,'') || '';
  $('rail-review').title=$('rail-review').textContent;
}
$('toggle-branches').onclick=()=>{branchVisibility=!($('toggle-branches').getAttribute('aria-expanded')==='true');try{localStorage.setItem('branch-review:branches-visible',JSON.stringify(branchVisibility));}catch{}branchVisibilityUI();};
const previews=framePool($('frames'));
let mutationQueue=Promise.resolve();
async function api(path, data) {
  if(data!==undefined){const request=mutationQueue.catch(()=>{}).then(()=>requestApi(path,data));mutationQueue=request;return request;}
  return requestApi(path,data);
}
async function requestApi(path, data) {
  if(path==='/api/start' && data?.fixJob)await previews.waitPrepared(currentState.preparedReview);
  const response = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Review-Token": token,
          },
          body: JSON.stringify(data),
        },
  );
  const text=await response.text();
  let result;try{result=JSON.parse(text);}catch{throw Error(`Could not read ${path.split('?')[0]} (HTTP ${response.status}). Retry the operation.`);}
  if (!response.ok) throw new Error(result.error);
  return result;
}
let lastErrorMessage=null;
function error(message) {
  message=message || '';
  if(message===lastErrorMessage)return;
  lastErrorMessage=message;
  $("error").replaceChildren();
  const {summary,technical}=describeError(message);
  $("error").append(document.createTextNode(summary));
  if(technical){const details=document.createElement('details'),label=document.createElement('summary'),body=document.createElement('pre');label.textContent='Technical details';body.textContent=technical;body.style.whiteSpace='pre-wrap';details.append(label,body);$("error").append(details);}
  $("error").hidden = !message;
  if(message)$("error").scrollIntoView({block:'nearest'});
}
const branchTitle=branch=>branch.subject==='fix: address Branch Review findings' && branch.displaySubject ? `${branch.displaySubject} · ${branch.sha.slice(0,7)}` : branch.subject;
function branchList() {
  const query = $("search").value.toLowerCase();
  const reviewedRef=currentState.record?.identity.ref;
  const current=reviewedRef && (allBranches.find(branch=>branch.ref===reviewedRef) || allBranches.filter(branch=>branch.aliases?.includes(reviewedRef)).filter((_,index,found)=>found.length===1)[0]);
  const inventory=visibleBranches().filter(branch=>branch!==current);
  if(current)inventory.unshift(current);
  const items = inventory.filter((branch) =>
    `${branch.name} ${branch.subject} ${branch.displaySubject || ""}`.toLowerCase().includes(query),
  );
  $("count").textContent = items.length;
  $("branches").replaceChildren(
    ...items.map((branch) => {
      const button = document.createElement("button");
      button.className = "branch";
      const isCurrent=branch===current;
      button.setAttribute("aria-current", String(isCurrent));
      const title = document.createElement("span");
      title.className = "branch-title";
      title.textContent = (isCurrent && currentState.manifest?.title || branchTitle(branch))+(branch.fixCount?` · ${branch.fixCount} fix${branch.fixCount===1?'':'es'}`:'');
      const meta = document.createElement("span");
      meta.className = "branch-meta";
      const ref = document.createElement("span");
      ref.className = "branch-ref";
      ref.textContent = branch.name;
      const sha = document.createElement("code");
      sha.textContent = branch.merged && !isCurrent ? 'Merged' : branch.sha.slice(0, 7);
      meta.append(ref, sha);
      if(isCurrent){const badge=document.createElement('span');badge.className='branch-current';badge.textContent=branch.merged?'Current review · Merged':'Current review';button.append(badge);}
      button.append(title, meta);
      const committed = new Date(branch.date);
      if(Number.isFinite(committed.getTime())){
        const date=document.createElement('time');date.className='branch-meta';date.dateTime=committed.toISOString();
        date.textContent='Last commit: '+committed.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
        date.title=committed.toLocaleString(undefined,{dateStyle:'full',timeStyle:'long'});button.append(date);
      }
      button.title = `${branch.name}\n${branch.sha}`;
      button.disabled=currentState.busy || !!openingSelection?.starting;
      button.onclick = () => {if(isCurrent){branchVisibility=false;try{localStorage.setItem('branch-review:branches-visible','false');}catch{}branchVisibilityUI();}else openBranch(branch);};
      return button;
    }),
  );
  if(reviewedRef && !current && !query){const note=document.createElement('p');note.className='repository-path';note.textContent='Current review: branch is no longer available. Saved review remains open.';$('branches').prepend(note);}
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'repository-path'; empty.textContent = query ? 'No matching branches.' : 'No unmerged branches.'; $('branches').append(empty);
  }
}
function visibleBranches() { return allBranches.filter(b => $('branch-filter').value === 'all' || !b.merged); }
let inventoryLoading=false;
async function loadBranches(refreshSelection=true) {
  if(inventoryLoading)return;
  inventoryLoading=true;
  try {
  const previous=JSON.stringify(allBranches);
  allBranches = await api("/api/branches");
  if(!refreshSelection && JSON.stringify(allBranches)===previous)return;
  const reviewed=currentState.record?.identity, latest=reviewed && allBranches.find(branch=>[branch.ref,...branch.aliases].includes(reviewed.ref));
  const update=reviewed?await api('/api/update?id='+encodeURIComponent(currentState.record.id)):null;
  $('revision-warning').hidden=!update?.missing && !update?.changed;
  $('revision-warning').textContent=update?.missing?'The source branch is unavailable. Saved evidence remains available.':update?.changed?`This branch has a new commit (${update.latest.slice(0,7)}). Reopen it to review the latest version.`:'';
  const latestSelection=selected && allBranches.find(branch=>branch.ref===selected.ref);
  if(refreshSelection || selected && latestSelection?.sha!==selected.sha){
    const next=(!openingSelection && currentState.status==='ready' && allBranches.find(branch=>[branch.ref,...branch.aliases].includes(reviewed?.ref))) || refreshedSelection(allBranches,selected,reviewed?.ref,$('branch-filter').value==='all');
    if(next)await select(next);else await chooseVisibleBranch();
  }
  else branchList();
  }finally{inventoryLoading=false;}
}
let healthChecking=false, lastHealth=0, healthResult=null;
const healthKey=()=>`${currentState.status}:${currentState.original?.sha}:${currentState.changed?.sha}`;
async function checkHealth() {
  if(healthChecking || currentState.busy)return;
  healthChecking=true;$('check-health').disabled=true;
  try {
    const key=healthKey();
    const result=await api('/api/health');
    if(key!==healthKey())return;
    $('health-status').textContent=['original','changed'].map(side=>`${side==='original'?'Original':'Changed'}: ${result.sides[side].message}`).join('\n')+`\nChecked ${new Date(result.checkedAt).toLocaleTimeString()}`;
    const healthy=Object.values(result.sides).every(side=>side.ok);
    healthResult={key,healthy};
    if(currentState.status==='ready' && !healthy)$('preview-status').textContent='Needs attention';
    $('health-status').classList.toggle('health-error',currentState.status==='ready' && !healthy);
    lastHealth=Date.now();
  }catch(e){$('health-status').textContent=`Could not check previews: ${e.message}`;}
  finally{healthChecking=false;$('check-health').disabled=false;}
}
$('check-health').onclick=checkHealth;
async function chooseVisibleBranch() {
  const visible = visibleBranches();
  selected =
    visible.find((b) => b.ref === selected?.ref) ||
    visible.find((b) => b.ref === currentState.comparison?.branch.ref || b.aliases.includes(currentState.comparison?.branch.ref)) ||
    visible[0];
  if (selected) await select(selected);
  else { selectedComparison=null; selectionGeneration++; branchList(); $('view-diff').disabled=true; $('download-plan').disabled=true; $('plan-count').textContent='Review plan'; $('plan-summary').textContent='Select a branch to see its checks.'; $('plan-items').replaceChildren(); $('start').disabled = true; $('title').textContent = 'No branches needing review'; $('branch-name').textContent = 'Choose All branches to inspect merged work.'; $('files').replaceChildren(); $('file-count').textContent = '0'; $('comparison-note').textContent = ''; }
}
async function select(branch,reveal=false) {
  selected = branch;
  if(reveal){ $('branch-brief').dataset.selecting=branch.sha===currentState.record?.identity.source && [branch.ref,...branch.aliases].includes(currentState.record?.identity.ref)?'':'true'; $('branch-brief').hidden=!!currentState.record && !$('branch-brief').dataset.selecting; }
  $('branch-brief').open = reveal || !currentState.record || ![branch.ref,...branch.aliases].includes(currentState.comparison?.branch.ref);
  if(reveal)$('branch-brief').scrollIntoView({block:'start'});
  branchList();
  $("title").textContent = branchTitle(branch);
  $("branch-name").textContent = branch.name;
  $("start").disabled = true;
  $('comparison-note').textContent='Loading comparison…';$('files').replaceChildren();$('file-count').textContent='—';$('plan-count').textContent='Loading review plan…';
  const generation = ++selectionGeneration;
  try {
    selectedComparison=null;$('view-diff').disabled=true;$('download-plan').disabled=true;$('plan-summary').textContent='Loading review plan…';$('plan-items').replaceChildren();
    if($('baseline').value==='commit' && commitBranchSha!==branch.sha){
      const commits=await api(`/api/commits?sha=${branch.sha}`);if(generation!==selectionGeneration)return;
      $('baseline-commit').replaceChildren(...commits.map(commit=>{const option=document.createElement('option');option.value=commit.sha;option.textContent=`${commit.sha.slice(0,7)} · ${commit.subject}`;return option;}));
      const reviewed=currentState.record?.identity;
      $('baseline-commit').value=reviewed && [branch.ref,...branch.aliases].includes(reviewed.ref) && commits.some(commit=>commit.sha===reviewed.base)?reviewed.base:commits[1]?.sha || commits[0]?.sha || '';commitBranchSha=branch.sha;
    }
    const result = await api(
      `/api/comparison?ref=${encodeURIComponent(branch.ref)}&baseline=${$("baseline").value}&commit=${$('baseline-commit').value}`,
    );
    if (generation !== selectionGeneration) return;
    selectedComparison=result;$('start').disabled=currentState.busy;$('view-diff').disabled=!result.files.length;
    $('download-plan').disabled=false;$('plan-count').textContent=`Review plan · ${result.plan.scenarios.length} items`;
    $('plan-summary').textContent=result.plan.summary || result.plan.title;$('plan-source').textContent=result.plan.source;
    $('plan-items').replaceChildren(...result.plan.scenarios.map(item=>{const entry=document.createElement('li');entry.textContent=item.title;entry.title=item.instructions || item.steps.join('\n');return entry;}));
    $("file-count").textContent = result.files.length;
    $("files").replaceChildren(
      ...result.files.map((name) => {
        const li = document.createElement("li");
        const button=document.createElement('button');button.className='file-link';button.textContent=name;button.onclick=()=>openDiff(name);li.append(button);
        return li;
      }),
    );
    $("comparison-note").textContent =
      result.base === result.branch.sha
        ? "This branch is already contained in main. Choose Previous commit to inspect its latest change."
        : `${result.base.slice(0, 7)} → ${result.branch.sha.slice(0, 7)} · ${result.files.length} changed files`;
  } catch (e) {
    if(generation!==selectionGeneration)return;
    $('plan-summary').textContent=e.message;
    error(e.message);
  }
}
async function openBranch(branch) {
  if(currentState.busy || openingSelection?.starting)return;
  if(currentState.status==='ready' && currentState.record?.identity.ref===branch.ref && currentState.record.identity.source===branch.sha && (!branch.fixJob || currentState.record.fixComparison))return;
  if(!await reviewWorkflow.flush())return;
  openingSelection={...branch,starting:true};selected=branch;selectedComparison=null;
  openingSummary.textContent=`${branchTitle(branch)} · ${branch.name} · ${branch.sha.slice(0,7)}`;
  try{sessionStorage.setItem('branch-review:opening',JSON.stringify(openingSelection));}catch{}
  $('frames').hidden=true;$('frames').replaceChildren();frameKey='';
  $('review-workflow').hidden=true;$('review-branch-status').hidden=true;$('branch-brief').hidden=true;
  $('loading').hidden=false;$('empty').hidden=true;$('loading-label').textContent='OPENING REVIEW';$('phase').textContent=`Opening ${branch.name}…`;
  $('original-sha').textContent='';$('changed-sha').textContent='';error('');branchList();
  $('context').textContent=`Opening ${branch.name}…`;
  try{await api('/api/start',{ref:branch.ref,baseline:'main',...(branch.fixJob?{fixJob:branch.fixJob}:{})});openingSelection.starting=false;await poll();}
  catch(e){openingSelection.starting=false;currentState.busy=false;error(e.message);$('loading').hidden=true;branchList();}
}
async function openDiff(filename,comparison=selectedComparison) {
  if(!comparison)return;
  const generation=++diffGeneration;
  $('diff-dialog').showModal();$('diff-patch').textContent='Loading changes…';$('diff-title').textContent='Code changes';
  $('diff-identity').textContent=`Original ${comparison.base.slice(0,7)} → Changed ${comparison.branch.sha.slice(0,7)} · ${comparison.branch.name}`;
  try {
    const files=await api(`/api/changes?base=${comparison.base}&changed=${comparison.branch.sha}`);if(generation!==diffGeneration)return;
    $('diff-files').replaceChildren(...files.map(file=>{const option=document.createElement('option');option.value=file.path;option.textContent=`${file.status} · ${file.path} ${file.binary?'· binary':`· +${file.added} −${file.removed}`}`;return option;}));
    if(filename)$('diff-files').value=filename;
    $('diff-files').onchange=()=>loadDiff(comparison,$('diff-files').value);
    await loadDiff(comparison,$('diff-files').value);
  }catch(e){$('diff-patch').textContent=e.message;}
}
async function loadDiff(comparison,filename) {
  const generation=++diffGeneration;$('diff-patch').textContent='Loading changes…';
  try {
    const diff=await api(`/api/diff?base=${comparison.base}&changed=${comparison.branch.sha}&file=${encodeURIComponent(filename)}`);if(generation!==diffGeneration)return;
    $('diff-title').textContent=diff.file.previousPath?`${diff.file.previousPath} → ${diff.file.path}`:diff.file.path;
    $('diff-warning').textContent=diff.truncated?'Large diff: showing a limited excerpt. Inspect the full change in Git before approval.':diff.file.binary?'Binary file changed. Review the rendered behavior or original file.':'';
    $('diff-patch').replaceChildren(...diff.patch.split('\n').map(line=>{const span=document.createElement('span');span.textContent=line+'\n';span.className=line.startsWith('+')&&!line.startsWith('+++')?'diff-add':line.startsWith('-')&&!line.startsWith('---')?'diff-remove':line.startsWith('@@')?'diff-hunk':'';return span;}));
  }catch(e){if(generation===diffGeneration)$('diff-patch').textContent=e.message;}
}
$('view-diff').onclick=()=>openDiff();
$('review-code').onclick=()=>{const r=currentState.record;if(r)void openDiff(undefined,{base:r.identity.base,branch:{sha:r.identity.changed,name:r.identity.ref.replace(/^refs\/(heads|remotes)\//,'')}});};
$('download-plan').onclick=()=>{if(!selectedComparison)return;const url=URL.createObjectURL(new Blob([JSON.stringify(selectedComparison.plan,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='review-checklist.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('close-diff').onclick=()=>{diffGeneration++;$('diff-dialog').close();};
function renderAddress(){
  const input=$('preview-url'),preview=currentState[active],location=reviewWorkflow.getContext(active).location;
  $('preview-address-label').textContent=active==='original'?'Original:':'Changed:';
  input.disabled=$('preview-go').disabled=!preview || !$(`frame-${active}`);
  if(document.activeElement!==input)input.value=preview && location?`http://127.0.0.1:${preview.proxy}${location}`:'';
}
$('preview-address').onsubmit=event=>{
  event.preventDefault();const preview=currentState[active],frame=$(`frame-${active}`),input=$('preview-url'),message=$('preview-url-error');
  if(!preview || !frame)return;
  try{
    const origin=`http://127.0.0.1:${preview.proxy}`,value=input.value.trim();
    const url=new URL(value,origin);
    if(url.origin!==origin || url.username || url.password)throw Error('Enter a path or URL for the selected preview.');
    message.textContent='';frame.src=url.href;input.blur();
  }catch(e){message.textContent=e.message || 'Enter a valid preview address.';}
};
function toggle(side) {
  active = side;
  renderAddress();
  reviewWorkflow.viewChanged();
  for (const name of ["original", "changed"]) {
    $(name).setAttribute("aria-pressed", String(side === name));
    const frame = $(`frame-${name}`);
    if (frame) {
      const hidden=$('layout-mode').value!=='side-by-side' && side!==name;
      frame.parentElement.classList.toggle('inactive',hidden);frame.parentElement.classList.toggle('active-pane',side===name);frame.parentElement.inert=hidden;
    }
  }
  renderFocusStatus();
  const preview = currentState[side];
  if (preview)
    $("context").textContent =
      `${currentState.record?.fixComparison && !currentState.record?.sameBranch?(side==='original'?'Before fix':'After fix'):(side === "original" ? "Original" : "Changed")} · ${preview.sha.slice(0, 7)} · ${currentState.manifest?.title || "Review scenario"}`;
}
function runShortcut(command) {
  if(document.querySelector('dialog[open]') || currentState.status!=='ready' || currentState.busy)return;
  if(command==='toggle')toggle(active==='changed'?'original':'changed');
  else if(['next','previous'].includes(command) && currentState.record?.cursor?.view!=='results') {
    const button=$(`item-${command}`);if(!button.disabled)button.click();
  }
}
window.addEventListener('keydown',event=>{const command=reviewShortcut(event);if(command){event.preventDefault();runShortcut(command);}});
function applyLayout() {
  const split=$('layout-mode').value==='side-by-side';
  $('frames').classList.toggle('side-by-side',split);$('split-control').hidden=!split;
  $('frames').style.gridTemplateColumns=split?`${$('split-position').value}fr ${100-Number($('split-position').value)}fr`:'';
  toggle(active);
  try{localStorage.setItem('branch-review:layout',JSON.stringify({mode:$('layout-mode').value,sync:$('sync-scroll').checked,split:$('split-position').value}));}catch{}
}
try{const layout=JSON.parse(localStorage.getItem('branch-review:layout')||'{}');if(['toggle','side-by-side'].includes(layout.mode))$('layout-mode').value=layout.mode;if(typeof layout.sync==='boolean')$('sync-scroll').checked=layout.sync;if(Number(layout.split)>=30 && Number(layout.split)<=70)$('split-position').value=layout.split;}catch{}
$('layout-mode').onchange=$('split-position').oninput=applyLayout;
$('sync-scroll').onchange=()=>{applyLayout();if($('sync-scroll').checked)$(`frame-${active}`)?.contentWindow.postMessage({type:'review:request-scroll'},`http://127.0.0.1:${currentState[active].proxy}`);};
let focusedItem = '', focusStates = {};
function renderFocusStatus() {
  const item=currentState.manifest?.scenarios.find(item=>item.id===reviewWorkflow.scenario());
  const status=focusStates[active],label=$('target-status');
  label.hidden=!item?.focus || currentState.status!=='ready';
  label.textContent=status==='found'?`Located ${item?.focus}`:status==='missing'?'Review target not found · inspect the screen or Reset item':status==='cancelled'?'Automatic focus paused · use Reset item to return':'Locating review target…';
  label.classList.toggle('health-error',status==='missing');
}
function focusItem(item,sides=['original','changed']) {
  if(!item?.focus){focusStates={};renderFocusStatus();return;}
  for(const side of sides){focusStates[side]='waiting';$(`frame-${side}`)?.contentWindow.postMessage({type:'review:focus',key:item.focus},`http://127.0.0.1:${currentState[side].proxy}`);}
  renderFocusStatus();
}
function mountFrames(state, force = false) {
  const item=(state.record && state.manifest.scenarios.find(s=>s.id===reviewWorkflow.scenario())) || state.manifest.scenarios[0];
  const key = `${state.original.sha}:${state.changed.sha}:${item.path}:${item.originalPath || item.path}`;
  if(focusedItem!==item.id && reviewWorkflow.needsNavigation(item))force=true;
  if (frameKey === key && !force) { if(focusedItem!==item.id){focusedItem=item.id;focusItem(item);}return; }
  focusedItem=item.id;
  frameKey = key;
  reviewWorkflow.resetContexts();
  previews.mount(state,item,force,side=>focusItem(item,[side]));
  applyLayout();
}
async function poll() {
  try {
    const previousBusy = currentState.busy;
    const previousReview=currentState.record?.id;
    currentState = selectedReviewState(await api("/api/state"),openingSelection);
    if (previousBusy && !currentState.busy && currentState.status === "ready" && !currentState.error) error("");
    if(openingSelection && currentState.record && currentState.status==='ready' && !currentState.busy){openingSelection=null;try{sessionStorage.removeItem('branch-review:opening');}catch{}}
    token = currentState.token;
    previews.preload(currentState.preparedReview);
    $('project-name').textContent=$('preview-project-name').textContent=currentState.project?.name || 'Project';
    branchVisibilityUI();
    reviewWorkflow.render(currentState);
    if(!currentState.record)$('revision-warning').hidden=true;
    const fixRecord=currentState.record;
    fixNotice.hidden=versionHistory.hidden=!fixRecord?.fixComparison;
    if(fixRecord?.fixComparison){
      const findings=fixRecord.issues.filter(issue=>issue.scenario===fixRecord.cursor?.itemId && issue.status!=='resolved');
      fixNotice.textContent=`${fixRecord.sameBranch?'Original stays at the starting point. Changed shows your latest revision.':'Compare before and after this fix.'} ${findings.some(issue=>issue.status==='needs-retest')?'Ready to retest the latest fix.':'Check the affected behavior below.'}`;
      const historyKey=JSON.stringify([fixRecord.id,fixRecord.previousResults,fixRecord.requestHistory]);
      if(versionResults.dataset.key!==historyKey){
      versionResults.dataset.key=historyKey;
      versionResults.replaceChildren(...(fixRecord.previousResults || []).map(result=>{const p=document.createElement('p');p.textContent=`${result.title} · ${result.status} at ${result.commit.slice(0,7)}`;return p;}));
      for(const request of fixRecord.requestHistory || []){
        const entry=document.createElement('details'),heading=document.createElement('summary'),body=document.createElement('p');
        heading.textContent=`Earlier request · ${(request.commit || '').slice(0,7)}`;
        body.textContent=`Requested: ${request.expected || ''} — Observed: ${request.actual || ''}`;
        entry.append(heading,body);versionResults.append(entry);
      }
      }
    }
    for(const side of ['original','changed'])$(side).firstChild.textContent=currentState.record?.fixComparison && !currentState.record?.sameBranch?(side==='original'?'Before fix ':'After fix '):(side==='original'?'Original ':'Changed ');
    if(currentState.record?.fixComparison)openingSummary.textContent='Retesting fixes in the same review';
    if(openingSelection)$('branch-brief').hidden=true;
    const reviewedBranch=allBranches.find(branch=>[branch.ref,...branch.aliases].includes(currentState.record?.identity.ref));
    const reviewedRelease=currentState.record?.delivery;
    const published=['published','verified'].includes(reviewedRelease?.stage) && reviewedRelease.commit===currentState.record?.identity.changed;
    $('review-branch-status').hidden=published || !currentState.record || currentState.record.cursor?.view==='results';
    $('review-branch-status').textContent=currentState.record ? `${published?'Published':reviewedBranch?.merged && reviewedBranch.sha===currentState.record.identity.source?'Merged into main':'Reviewing'} · ${currentState.record.identity.ref.replace(/^refs\/(heads|remotes)\//,'')} · ${currentState.record.identity.changed.slice(0,7)}${published?' — completed review; choose another branch to review new work.':''}`:'';
    if(currentState.record?.reviewTitle)$('review-branch-status').textContent=`${currentState.record.reviewTitle} · Fix review · ${currentState.record.identity.changed.slice(0,7)}`;
    if(currentState.record?.sameBranch)$('review-branch-status').textContent=`${currentState.record.identity.ref.replace('refs/heads/','')} · ${currentState.record.identity.source.slice(0,7)} · Latest version`;
    if(currentState.previewVersion){$('review-branch-status').hidden=false;$('review-branch-status').textContent=`Previewing ${currentState.previewVersion.sha.slice(0,7)} · Branch stays at ${currentState.record.identity.source.slice(0,7)} · Use history to return or restore`;$('review-workflow').hidden=true;}
    branchHistoryView.render(currentState);
    reviewTools.render(currentState);batch.render(currentState);
    void activityView.render();
    renderFocusStatus();
    const ready = currentState.status === "ready";
    const previewReady=ready || currentState.status==='preview-ready';
    pendingChecks.hidden=currentState.status!=='preview-ready';
    if(currentState.status==='preview-ready')$('change-composer').hidden=true;
    renderAddress();
      const publishing=currentState.busy && currentState.record?.delivery?.stage==='deploying';
      const release=currentState.record?.delivery;
      $('publish-progress').hidden=!publishing;
      if(publishing){const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(release.deployStartedAt || release.startedAt))/60000));$('publish-progress').textContent=`Publishing ${release.commit.slice(0,7)}${Number.isFinite(elapsed)?` · ${elapsed} min elapsed`:''}. ${release.progress || 'Building and transferring the release, then verifying the live site.'} Review controls unlock when publishing finishes. Keep this app open.`;}
    const preparing = ["preparing", "stopping"].includes(currentState.status);
    $("empty").hidden = previewReady || preparing;
    $("loading").hidden = !preparing;
    $("frames").hidden = !previewReady;
    $("phase").textContent = currentState.phase;
    $('loading-label').textContent=currentState.status==='stopping'?'STOPPING PREVIEWS':'PREPARING YOUR WORKSPACE';
    $('loading-description').textContent=currentState.status==='stopping'?'Saved reviews and preview databases will be kept.':'Checklist and previews prepare together. The two most recent branch previews stay available for reuse.';
    $('diagnostic-log').textContent=currentState.log.map(entry=>`${entry.at} ${entry.message}`).join('\n')+(currentState.error?`\n${currentState.error}`:'');
    $("progress").textContent =
      currentState.log.map((entry) => entry.message).join("\n") +
      (currentState.lastOutput && preparing
        ? `\n\n${currentState.lastOutput}`
        : "");
    $("preview-status").textContent = ready
      ? healthResult?.key===healthKey() && !healthResult.healthy ? 'Needs attention' : "Running"
      : currentState.status==='preview-ready' ? "Preview ready - checking" : preparing
        ? currentState.status==='stopping'?'Stopping':"Preparing"
        : currentState.status === "error"
          ? "Needs attention"
          : "Not running";
    $("start").disabled = !selectedComparison || currentState.busy;
      $("start").textContent = currentState.busy
        ? publishing ? "Publishing…" : "Working…"
      : ready
        ? "Open selected review ↗"
        : "Open review ↗";
    $("stop").disabled =
      currentState.busy || !["ready", "error"].includes(currentState.status);
    $("refresh").disabled = currentState.busy;
    $("reopen").disabled = !ready;
    $('review-code').disabled=!ready;
    $("original").disabled = !previewReady;
    $("changed").disabled = !previewReady;
    if (currentState.error) error(currentState.error);
    if (previewReady) {
      $("original-sha").textContent = currentState.original.sha.slice(0, 7);
      $("changed-sha").textContent = currentState.changed.sha.slice(0, 7);
      mountFrames(currentState);
      evidence.render();
    } else {
      $("frames").replaceChildren();
      frameKey = "";
      $('original-sha').textContent='';$('changed-sha').textContent='';
      $('context').textContent=openingSelection?openingSelection.name:'No active preview';
    }
    $("connection").textContent = "LOCAL PREVIEW";
    if(Date.now()-lastHealth>15000)void checkHealth();
    const reviewChanged=ready && !!currentState.record && currentState.record.id!==previousReview;
    if(reviewChanged){delete $('branch-brief').dataset.selecting;selected=null;$('baseline').value=currentState.record.comparisonMode?.baseline || 'parent';$('commit-choice').hidden=$('baseline').value!=='commit';commitBranchSha='';}
    if (reviewChanged || previousBusy && !currentState.busy) await loadBranches();
    if(previousBusy!==currentState.busy || previousReview!==currentState.record?.id)branchList();
    batch.render(currentState);
  } catch (e) {
    $("connection").textContent = "REVIEW SERVER DISCONNECTED";
    error(e.message);
  }
}
$("search").oninput = branchList;
try{if(localStorage.getItem('branch-review:branch-filter')==='all')$('branch-filter').value='all';}catch{}
$('branch-filter').onchange = () => {try{localStorage.setItem('branch-review:branch-filter',$('branch-filter').value);}catch{}void chooseVisibleBranch();};
$("baseline").onchange = () => { $('commit-choice').hidden=$('baseline').value!=='commit';if(selected)void select(selected,true); };
$('baseline-commit').onchange=()=>selected && select(selected,true);
$("original").onclick = () => toggle("original");
$("changed").onclick = () => toggle("changed");
$("focus").onclick = () => {
  const focused = document.body.classList.toggle("focused");
  $("focus").setAttribute("aria-pressed", String(focused));
  $("focus").textContent = focused ? "Show review panels" : "Expand preview";
};
$("reopen").onclick = () => {
  if (
    confirm(
      "Reopen both scenario screens? Unsaved edits in either version will be lost.",
    )
  )
    mountFrames(currentState, true);
};
$("start").onclick = async () => {
  if(!selectedComparison || currentState.busy)return;
  if(!await reviewWorkflow.flush())return;
  if (
    frameKey &&
    !confirm(
      "Switch review? Unsaved edits in the current previews will be lost.",
    )
  )
    return;
  try {
    error("");
    $("start").disabled = true;
    await api("/api/start", {
      ref: selected.ref,
      baseline: $("baseline").value,
      baselineCommit:$('baseline-commit').value,
    });
    await poll();
  } catch (e) {
    error(e.message);
  }
};
$("stop").onclick = async () => {
  if(!await reviewWorkflow.flush())return;
  if (!confirm("Stop both previews? Save any edits first.")) return;
  try {
    await api("/api/stop", {});
    await poll();
  } catch (e) {
    error(e.message);
  }
};
$("refresh").onclick = async () => {
  try {
    error("");
    await api("/api/fetch", {});
    await poll();
  } catch (e) {
    error(e.message);
  }
};
window.addEventListener("message", (event) => {
  const side = ['original','changed'].find(side=>event.origin===`http://127.0.0.1:${currentState[side]?.proxy}`);
  if (
    side &&
    event.source === $(`frame-${side}`)?.contentWindow &&
    event.data?.type === "review:error"
  )
    error(`${side}: ${event.data.message}`);
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:focus-status' && event.data.key===currentState.manifest?.scenarios.find(item=>item.id===reviewWorkflow.scenario())?.focus && ['waiting','found','missing','cancelled'].includes(event.data.status)){focusStates[side]=event.data.status;renderFocusStatus();}
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:context'){reviewWorkflow.context(side,event.data);renderAddress();}
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:change-target' && currentState.status==='ready' && !currentState.busy){
    const data=event.data;if(typeof data.location!=='string' || !data.location.startsWith('/') || !data.target)return;
    toggle(side);reviewWorkflow.context(side,{...reviewWorkflow.getContext(side),location:data.location});renderAddress();
    batch.openTarget({location:data.location,selector:String(data.target.selector || '').slice(0,1000),label:String(data.target.label || '').slice(0,160),rect:data.target.rect});
  }
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:active' && $('layout-mode').value==='side-by-side')toggle(side);
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:shortcut')runShortcut(event.data.command);
  if ($('sync-scroll').checked && side === active && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:scroll') {
    const other = side === 'original' ? 'changed' : 'original';
    $(`frame-${other}`)?.contentWindow.postMessage(event.data, `http://127.0.0.1:${currentState[other].proxy}`);
  }
});
await poll();
const setupGuide=onboarding({api,settings:()=>reviewTools.open('workspace'),refresh:async()=>{await poll();await loadBranches();error('');}});
void setupGuide.initialize();
await loadBranches().catch((e) => error(e.message));
setInterval(poll, 2000);
setInterval(()=>{if(!currentState.busy)void loadBranches(false).catch(e=>error(e.message));},30000);
