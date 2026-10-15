import { workflow } from './workflow.js';
const $ = (id) => document.getElementById(id);
let allBranches = [],
  selected = null,
  token = "",
  currentState = {},
  active = "changed",
  frameKey = "",
  selectionGeneration = 0;
const reviewWorkflow = workflow({api, getState:()=>currentState, getSide:()=>active, error, poll, reopen:()=>mountFrames(currentState,true)});
async function api(path, data) {
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
  $("error").textContent = message || "";
  $("error").hidden = !message;
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
      button.onclick = () => select(branch);
      return button;
    }),
  );
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'repository-path'; empty.textContent = query ? 'No matching branches.' : 'No unmerged branches.'; $('branches').append(empty);
  }
}
function visibleBranches() { return allBranches.filter(b => $('branch-filter').value === 'all' || !b.merged); }
async function loadBranches() {
  allBranches = await api("/api/branches");
  await chooseVisibleBranch();
}
async function chooseVisibleBranch() {
  const visible = visibleBranches();
  selected =
    visible.find((b) => b.ref === selected?.ref) ||
    visible.find((b) => b.ref === currentState.comparison?.branch.ref || b.aliases.includes(currentState.comparison?.branch.ref)) ||
    visible[0];
  if (selected) await select(selected);
  else { branchList(); $('start').disabled = true; $('title').textContent = 'No branches needing review'; $('branch-name').textContent = 'Choose All branches to inspect merged work.'; $('files').replaceChildren(); $('file-count').textContent = '0'; $('comparison-note').textContent = ''; }
}
async function select(branch) {
  selected = branch;
  branchList();
  $("title").textContent = branch.subject;
  $("branch-name").textContent = branch.name;
  $("start").disabled = currentState.busy;
  const generation = ++selectionGeneration;
  try {
    const result = await api(
      `/api/comparison?ref=${encodeURIComponent(branch.ref)}&baseline=${$("baseline").value}`,
    );
    if (generation !== selectionGeneration) return;
    $("file-count").textContent = result.files.length;
    $("files").replaceChildren(
      ...result.files.map((name) => {
        const li = document.createElement("li");
        li.textContent = name;
        return li;
      }),
    );
    $("comparison-note").textContent =
      result.base === result.branch.sha
        ? "This branch is already contained in main. Choose Previous commit to inspect its latest change."
        : `${result.base.slice(0, 7)} → ${result.branch.sha.slice(0, 7)} · ${result.files.length} changed files`;
  } catch (e) {
    error(e.message);
  }
}
function toggle(side) {
  active = side;
  for (const name of ["original", "changed"]) {
    $(name).setAttribute("aria-pressed", String(side === name));
    const frame = $(`frame-${name}`);
    if (frame) frame.hidden = side !== name;
  }
  const preview = currentState[side];
  if (preview)
    $("context").textContent =
      `${side === "original" ? "Original" : "Changed"} · ${preview.sha.slice(0, 7)} · ${currentState.manifest?.title || "Review scenario"}`;
}
function mountFrames(state, force = false) {
  const key = `${state.original.sha}:${state.changed.sha}:${reviewWorkflow.scenario()}`;
  if (frameKey === key && !force) return;
  frameKey = key;
  $("frames").replaceChildren(
    ...["original", "changed"].map((side) => {
      const frame = document.createElement("iframe");
      frame.id = `frame-${side}`;
      frame.title = `${side === "original" ? "Original" : "Changed"} Meta Clinic review`;
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads",
      );
      frame.src = `http://127.0.0.1:${state[side].proxy}/__review/start?scenario=${encodeURIComponent(reviewWorkflow.scenario())}`;
      return frame;
    }),
  );
  toggle(active);
}
async function poll() {
  try {
    const previousBusy = currentState.busy;
    currentState = await api("/api/state");
    token = currentState.token;
    reviewWorkflow.render(currentState);
    const ready = currentState.status === "ready";
    const preparing = ["preparing", "stopping"].includes(currentState.status);
    $("empty").hidden = ready || preparing;
    $("loading").hidden = !preparing;
    $("frames").hidden = !ready;
    $("phase").textContent = currentState.phase;
    $("progress").textContent =
      currentState.log.map((entry) => entry.message).join("\n") +
      (currentState.lastOutput && preparing
        ? `\n\n${currentState.lastOutput}`
        : "");
    $("preview-status").textContent = ready
      ? "Running"
      : preparing
        ? "Preparing"
        : currentState.status === "error"
          ? "Needs attention"
          : "Not running";
    $("start").disabled = !selected || currentState.busy;
    $("start").textContent = currentState.busy
      ? "Preparing…"
      : ready
        ? "Open selected review ↗"
        : "Open review ↗";
    $("stop").disabled =
      currentState.busy || !["ready", "error"].includes(currentState.status);
    $("refresh").disabled = currentState.busy;
    $("reopen").disabled = !ready;
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
    if (previousBusy && !currentState.busy) await loadBranches();
  } catch (e) {
    $("connection").textContent = "REVIEW SERVER DISCONNECTED";
    error(e.message);
  }
}
$("search").oninput = branchList;
$('branch-filter').onchange = chooseVisibleBranch;
$("baseline").onchange = () => selected && select(selected);
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
    });
    await poll();
  } catch (e) {
    error(e.message);
  }
};
$("stop").onclick = async () => {
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
});
await poll();
await loadBranches().catch((e) => error(e.message));
setInterval(poll, 2000);
