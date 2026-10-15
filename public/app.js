import { workflow } from './workflow.js';
import { reviewShortcut } from './shortcuts.js';
const $ = (id) => document.getElementById(id);
let allBranches = [],
  selected = null,
  token = "",
  currentState = {},
  active = "changed",
  frameKey = "",
  selectionGeneration = 0, selectedComparison = null, commitBranchSha = '', diffGeneration = 0;
const reviewWorkflow = workflow({api, getState:()=>currentState, getSide:()=>active, error, poll, reopen:(force=true)=>mountFrames(currentState,force)});
let branchVisibility=null;
try{branchVisibility=JSON.parse(localStorage.getItem('branch-review:branches-visible') || 'null');}catch{}
function branchVisibilityUI() {
  const visible=branchVisibility ?? !currentState.record;
  $('branches').closest('.branches').classList.toggle('compact',!visible);
  $('toggle-branches').textContent=visible?'Hide branches':'Show branches';$('toggle-branches').setAttribute('aria-expanded',String(visible));
  $('rail-review').hidden=visible || !currentState.record;
  $('rail-review').textContent=currentState.record?.identity.ref.replace(/^refs\/(heads|remotes)\//,'') || '';
  $('rail-review').title=$('rail-review').textContent;
}
$('toggle-branches').onclick=()=>{branchVisibility=!($('toggle-branches').getAttribute('aria-expanded')==='true');try{localStorage.setItem('branch-review:branches-visible',JSON.stringify(branchVisibility));}catch{}branchVisibilityUI();};
let mutationQueue=Promise.resolve();
async function api(path, data) {
  if(data!==undefined){const request=mutationQueue.catch(()=>{}).then(()=>requestApi(path,data));mutationQueue=request;return request;}
  return requestApi(path,data);
}
async function requestApi(path, data) {
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
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function error(message) {
  const changed=$("error").textContent!==(message || "");
  $("error").textContent = message || "";
  $("error").hidden = !message;
  if(message && changed)$("error").scrollIntoView({block:'nearest'});
}
function branchList() {
  const query = $("search").value.toLowerCase();
  const items = visibleBranches().filter((branch) =>
    `${branch.name} ${branch.subject}`.toLowerCase().includes(query),
  );
  $("count").textContent = items.length;
  $("branches").replaceChildren(
    ...items.map((branch) => {
      const button = document.createElement("button");
      button.className = "branch";
      button.setAttribute("aria-current", String(selected?.ref === branch.ref));
      const title = document.createElement("span");
      title.className = "branch-title";
      title.textContent = branch.subject;
      const meta = document.createElement("span");
      meta.className = "branch-meta";
      const ref = document.createElement("span");
      ref.className = "branch-ref";
      ref.textContent = branch.name;
      const sha = document.createElement("code");
      sha.textContent = branch.merged ? 'Merged' : branch.sha.slice(0, 7);
      meta.append(ref, sha);
      button.append(title, meta);
      button.title = `${branch.name}\n${branch.sha}`;
      button.onclick = () => select(branch,true);
      return button;
    }),
  );
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
  $('revision-warning').hidden=!reviewed || latest?.sha===reviewed.source;
  $('revision-warning').textContent=reviewed && latest?.sha!==reviewed.source ? latest?`This branch has a new commit (${latest.sha.slice(0,7)}). You are reviewing ${reviewed.source.slice(0,7)}. Open the latest branch to retest; saved results stay attached to their original version.`:'The reviewed branch is no longer listed. Saved evidence remains available.':'';
  const latestSelection=selected && allBranches.find(branch=>branch.ref===selected.ref);
  if(refreshSelection || selected && latestSelection?.sha!==selected.sha)await chooseVisibleBranch();
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
  else { branchList(); $('start').disabled = true; $('title').textContent = 'No branches needing review'; $('branch-name').textContent = 'Choose All branches to inspect merged work.'; $('files').replaceChildren(); $('file-count').textContent = '0'; $('comparison-note').textContent = ''; }
}
async function select(branch,reveal=false) {
  selected = branch;
  $('branch-brief').open = reveal || !currentState.record || ![branch.ref,...branch.aliases].includes(currentState.comparison?.branch.ref);
  if(reveal)$('branch-brief').scrollIntoView({block:'start'});
  branchList();
  $("title").textContent = branch.subject;
  $("branch-name").textContent = branch.name;
  $("start").disabled = true;
  $('comparison-note').textContent='Loading comparison…';$('files').replaceChildren();$('file-count').textContent='—';$('plan-count').textContent='Loading review plan…';
  const generation = ++selectionGeneration;
  try {
    selectedComparison=null;$('view-diff').disabled=true;$('download-plan').disabled=true;$('plan-summary').textContent='Loading review plan…';$('plan-items').replaceChildren();
    if($('baseline').value==='commit' && commitBranchSha!==branch.sha){
      const commits=await api(`/api/commits?sha=${branch.sha}`);if(generation!==selectionGeneration)return;
      $('baseline-commit').replaceChildren(...commits.map(commit=>{const option=document.createElement('option');option.value=commit.sha;option.textContent=`${commit.sha.slice(0,7)} · ${commit.subject}`;return option;}));
      $('baseline-commit').value=commits[1]?.sha || commits[0]?.sha || '';commitBranchSha=branch.sha;
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
$('download-plan').onclick=()=>{if(!selectedComparison)return;const url=URL.createObjectURL(new Blob([JSON.stringify(selectedComparison.plan,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='.branch-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('close-diff').onclick=()=>{diffGeneration++;$('diff-dialog').close();};
function toggle(side) {
  active = side;
  reviewWorkflow.viewChanged();
  for (const name of ["original", "changed"]) {
    $(name).setAttribute("aria-pressed", String(side === name));
    const frame = $(`frame-${name}`);
    if (frame) {
      const hidden=$('layout-mode').value!=='side-by-side' && side!==name;
      frame.parentElement.classList.toggle('inactive',hidden);frame.parentElement.classList.toggle('active-pane',side===name);frame.parentElement.inert=hidden;
    }
  }
  const preview = currentState[side];
  if (preview)
    $("context").textContent =
      `${side === "original" ? "Original" : "Changed"} · ${preview.sha.slice(0, 7)} · ${currentState.manifest?.title || "Review scenario"}`;
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
let focusedItem = '';
function focusItem(item) {
  if(!item?.focus)return;
  for(const side of ['original','changed'])$(`frame-${side}`)?.contentWindow.postMessage({type:'review:focus',key:item.focus},`http://127.0.0.1:${currentState[side].proxy}`);
}
function mountFrames(state, force = false) {
  const item=state.manifest.scenarios.find(s=>s.id===reviewWorkflow.scenario()) || state.manifest.scenarios[0];
  const key = `${state.original.sha}:${state.changed.sha}:${item.path}:${item.originalPath || item.path}`;
  if(focusedItem!==item.id && reviewWorkflow.needsNavigation(item))force=true;
  if (frameKey === key && !force) { if(focusedItem!==item.id){focusedItem=item.id;focusItem(item);}return; }
  focusedItem=item.id;
  frameKey = key;
  reviewWorkflow.resetContexts();
  $("frames").replaceChildren(
    ...["original", "changed"].map((side) => {
      const pane=document.createElement('section');pane.className='preview-pane';pane.setAttribute('aria-label',`${side} preview`);
      const label=document.createElement('div');label.className='preview-side-label';label.textContent=`${side==='original'?'Original':'Changed'} · ${state[side].sha.slice(0,7)}`;
      const frame = document.createElement("iframe");
      frame.id = `frame-${side}`;
      frame.title = `${side === "original" ? "Original" : "Changed"} Meta Clinic review`;
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads",
      );
      frame.src = `http://127.0.0.1:${state[side].proxy}/__review/start?scenario=${encodeURIComponent(reviewWorkflow.scenario())}`;
      frame.addEventListener('load',()=>focusItem(currentState.manifest?.scenarios.find(s=>s.id===reviewWorkflow.scenario())));
      pane.append(label,frame);return pane;
    }),
  );
  applyLayout();
}
async function poll() {
  try {
    const previousBusy = currentState.busy;
    currentState = await api("/api/state");
    token = currentState.token;
    branchVisibilityUI();
    reviewWorkflow.render(currentState);
    const ready = currentState.status === "ready";
    const preparing = ["preparing", "stopping"].includes(currentState.status);
    $("empty").hidden = ready || preparing;
    $("loading").hidden = !preparing;
    $("frames").hidden = !ready;
    $("phase").textContent = currentState.phase;
    $('loading-label').textContent=currentState.status==='stopping'?'STOPPING PREVIEWS':'PREPARING YOUR WORKSPACE';
    $('loading-description').textContent=currentState.status==='stopping'?'Saved reviews and preview databases will be kept.':'First startup installs dependencies and prepares a database for each version.';
    $('diagnostic-log').textContent=currentState.log.map(entry=>`${entry.at} ${entry.message}`).join('\n')+(currentState.error?`\n${currentState.error}`:'');
    $("progress").textContent =
      currentState.log.map((entry) => entry.message).join("\n") +
      (currentState.lastOutput && preparing
        ? `\n\n${currentState.lastOutput}`
        : "");
    $("preview-status").textContent = ready
      ? healthResult?.key===healthKey() && !healthResult.healthy ? 'Needs attention' : "Running"
      : preparing
        ? currentState.status==='stopping'?'Stopping':"Preparing"
        : currentState.status === "error"
          ? "Needs attention"
          : "Not running";
    $("start").disabled = !selectedComparison || currentState.busy;
    $("start").textContent = currentState.busy
      ? "Preparing…"
      : ready
        ? "Open selected review ↗"
        : "Open review ↗";
    $("stop").disabled =
      currentState.busy || !["ready", "error"].includes(currentState.status);
    $("refresh").disabled = currentState.busy;
    $("reopen").disabled = !ready;
    $('review-code').disabled=!ready;
    $("original").disabled = !ready;
    $("changed").disabled = !ready;
    if (currentState.error) error(currentState.error);
    if (ready) {
      $("original-sha").textContent = currentState.original.sha.slice(0, 7);
      $("changed-sha").textContent = currentState.changed.sha.slice(0, 7);
      mountFrames(currentState);
    } else if (preparing) {
      $("frames").replaceChildren();
      frameKey = "";
    }
    $("connection").textContent = "LOCAL PREVIEW";
    if(Date.now()-lastHealth>15000)void checkHealth();
    if (previousBusy && !currentState.busy) await loadBranches();
  } catch (e) {
    $("connection").textContent = "REVIEW SERVER DISCONNECTED";
    error(e.message);
  }
}
$("search").oninput = branchList;
$('branch-filter').onchange = chooseVisibleBranch;
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
  const side =
    event.origin === "http://127.0.0.1:4311"
      ? "original"
      : event.origin === "http://127.0.0.1:4312"
        ? "changed"
        : null;
  if (
    side &&
    event.source === $(`frame-${side}`)?.contentWindow &&
    event.data?.type === "review:error"
  )
    error(`${side}: ${event.data.message}`);
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:context') reviewWorkflow.context(side,event.data);
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:active' && $('layout-mode').value==='side-by-side')toggle(side);
  if(side && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:shortcut')runShortcut(event.data.command);
  if ($('sync-scroll').checked && side === active && event.source === $(`frame-${side}`)?.contentWindow && event.data?.type === 'review:scroll') {
    const other = side === 'original' ? 'changed' : 'original';
    $(`frame-${other}`)?.contentWindow.postMessage(event.data, `http://127.0.0.1:${currentState[other].proxy}`);
  }
});
await poll();
await loadBranches().catch((e) => error(e.message));
setInterval(poll, 2000);
setInterval(()=>{if(!currentState.busy)void loadBranches(false).catch(e=>error(e.message));},30000);
