"use strict";

let layoutWrite = Promise.resolve();
const designDrafts = new Map();

function titleFromPlan(plan) {
  const generic = /^(?:plan|proposed plan|change plan|acceptance criteria|verification|scope|constraints)\s*:?$/i;
  const lines = plan.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const heading = lines.filter(line => /^#{1,6}\s/.test(line))
    .map(line => line.replace(/^#{1,6}\s+/, "").replace(/[*`]/g, ""))
    .find(line => !generic.test(line));
  const opening = lines.map(line => line.replace(/^(?:#{1,6}\s+|[-+*]\s+|\d+\.\s+)/, "").replace(/[*`]/g, "").trim())
    .find(line => !generic.test(line) && !/^(?:here(?:'s| is)|proposed changes:)/i.test(line));
  const text = (heading || opening || "Project change").replace(/^For [^,]+,\s*/i, "")
    .split(/[.!?](?:\s|$)/, 1)[0].trim();
  const title = text.length > 96 ? text.slice(0, 96).replace(/\s+\S*$/, "") : text;
  return title ? title[0].toUpperCase() + title.slice(1) : "Project change";
}

function designDraftKey(state) {
  return "workbench.design.draft.v1:" + projectState.project.path +
    (state?.conversationId ? ":" + state.conversationId : "");
}

function designDraftFor(key) {
  if (!designDrafts.has(key)) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
    const validItem = item => typeof item?.id === "string" && typeof item.title === "string";
    const plan = Number.isInteger(saved?.baseRevision) && typeof saved?.plan?.plan === "string" &&
      (typeof saved.plan.title === "string" || Array.isArray(saved.plan.roadmap) &&
        saved.plan.roadmap.every(row => validItem(row) && Array.isArray(row.slices) &&
          row.slices.every(validItem))) ? saved.plan : null;
    designDrafts.set(key, {
      plan, baseRevision: plan ? saved.baseRevision : null,
      message: typeof saved?.message === "string" ? saved.message : "",
      mockupMessage: typeof saved?.mockupMessage === "string" ? saved.mockupMessage : "",
      slice: typeof saved?.slice === "string" ? saved.slice : ""
    });
  }
  return designDrafts.get(key);
}

function persistDesignDraft(key, draft) {
  try {
    if (draft.plan || draft.message || draft.mockupMessage || draft.slice) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {}
}

const projectCapabilityRequests = new Map();
function projectCapabilities() {
  const key = projectState.project.path;
  if (!projectCapabilityRequests.has(key)) {
    const request = api("project-capabilities").catch(error => {
      projectCapabilityRequests.delete(key);
      throw error;
    });
    projectCapabilityRequests.set(key, request);
  }
  return projectCapabilityRequests.get(key);
}

function layoutSetting(name, value) {
  if (!projectState?.project) return null;
  if (value !== undefined) {
    projectState.design_layout[name] = value;
    layoutWrite = layoutWrite.then(() => api("design/layout", {name, value})).catch(error => notify(error.message));
  }
  return projectState.design_layout[name];
}

function assetImage(id, label) {
  const img = element("img", "mockup");
  img.src = panelUrl("api/design/asset?id=" + encodeURIComponent(id));
  img.alt = label;
  img.loading = "lazy";
  return img;
}

function roadmapStatus(slice,builds) {
  for(const build of [...builds].reverse()){
    const group=build.groups.find(g=>g.slices.includes(slice));
    if(!group || build.retired)continue;
    if(group.reviews.at(-1)?.sha===group.sha && group.sha)return "Approved";
    if(group.findings.some(f=>f.slices.includes(slice) && !f.repaired))return "Needs repair";
    if(build.status==="review" && group.sha)return "Ready for review";
    const attempt=build.attempts.filter(a=>a.slice===slice).at(-1);
    if(attempt)return attempt.outcome==="completed"?"Checks finished":attempt.outcome;
    return "Queued";
  }
  return "Planned";
}

function watchGroupReview(area,evidence,target,actions) {
  let signature;
  async function refresh() {
    if(!area.isConnected)return;
    if(document.hidden){setTimeout(refresh,6000);return;}
    try{
      const details=await api("design/group?build="+encodeURIComponent(target.build)+"&group="+target.group);
      if(!area.isConnected)return;
      actions.update?.(details);
      const fingerprint=JSON.stringify(details);
      if(fingerprint!==signature){
        signature=fingerprint;evidence.replaceChildren();
        const labels={waiting:"Ready for review",reviewing:"Review in progress",approved:"Approved",
          "changes-requested":"Changes requested","branch-changed":"Branch changed","different-preview":"Review the exact commit"};
        evidence.append(element("strong","",details.message || labels[details.status] || "Connect Branch Review"));
        if(details.url){
          const link=element("a","button","Open Branch Review");
          link.href=details.url;link.target="_blank";link.rel="noopener";
          reviewLink(link,details.runId);
          evidence.append(link);
        }
        for(const item of details.checklist || [])evidence.append(element("p","",item.title+" · "+item.status.replaceAll("-"," ")));
        for(const issue of details.findings || [])evidence.append(button(issue.actual,()=>actions.selectFinding(issue)));
        if(details.status==="approved" && actions.approve){
          evidence.append(button("Record approval",actions.approve));
          if(actions.canApply())await actions.approve();
        }
      }
    }catch(error){evidence.textContent=error.message;signature=null;}
    if(area.isConnected)setTimeout(refresh,6000);
  }
  queueMicrotask(refresh);
}

function designHistory() {
  const rows = element("div", "panel-body");
  const reload = button("Refresh attempts", () => refresh());
  const panel = element("section", "panel", heading("Slice attempts", "", reload), rows);
  let previous, loading = false;
  async function refresh() {
    if (!panel.isConnected || loading) return;
    loading = true;
    reload.disabled = true;
    try {
      const attempts = await api("design/history");
      const signature = JSON.stringify(attempts);
      if (previous !== signature) {
        const open = new Set([...rows.querySelectorAll("details[open]")].map(d => d.dataset.key));
        rows.replaceChildren();
        if (!attempts.length) rows.append(element("p", "copy", "No recorded slice attempts."));
        const counts = new Map();
        for (const a of attempts) {
          const key = a.build + a.slice;
          const count = (counts.get(key) || 0) + 1;
          counts.set(key, count);
          const title = element("summary", "", a.title + " · Attempt " + count + " · " +
            (a.step ? stageName(a.step) + " · " : "") + a.outcome);
          if (a.active) title.prepend(element("span", "runtime-spinner"));
          const row = element("details", "attempt", title, element("small", "", new Date(a.started).toLocaleString()));
          row.dataset.key = a.id;
          row.open = open.has(a.id);
          if (a.reason || a.error) row.append(element("p", "", [a.reason, a.error].filter(Boolean).join(" · ")));
          const list = element("ol", "timeline");
          for (const step of a.transitions) list.append(element("li", "", stageName(step.stage) + " · " + step.number + " · " + step.outcome,
            element("small", "", new Date(step.time * 1000).toLocaleTimeString()), step.reason));
          row.append(list);
          rows.prepend(row);
        }
        previous = signature;
      }
    } catch (error) { rows.textContent = error.message; previous = null; }
    finally { loading = false; reload.disabled = false; }
  }
  queueMicrotask(refresh);
  return panel;
}

function showDesignLog(task, follow) {
  const rows = element("ol", "timeline design-log");
  const status = element("p", "design-status", "Loading activity…");
  status.setAttribute("role", "status");
  let cursor = 0, loading = false, timer;
  const reload = button("Refresh log", () => refresh());
  const content = element("div", "design-stack", element("code", "run-id", task), status, rows, reload);
  async function refresh() {
    clearTimeout(timer);
    if (!content.isConnected || !byId("dialog").open || loading) return;
    if (!document.hidden) {
      loading = true;
      reload.disabled = true;
      try {
        const page = await api("events?" + new URLSearchParams({id: task, after: cursor}));
        for (const entry of page.events) rows.append(element("li", "",
          element("strong", "", entry.activity), element("small", "", stageName(entry.stage), " · ", entry.actor,
            " · ", historyTime(entry.timestamp))));
        cursor = page.cursor;
        status.textContent = rows.childElementCount ? "" : "No activity recorded yet.";
        reload.textContent = page.events.length >= 200 ? "Load more" : "Refresh log";
        if (page.events.some(entry => ["completed", "stopped", "paused"].includes(entry.stage))) follow = false;
      } catch (error) { status.textContent = error.message; }
      finally { loading = false; reload.disabled = false; }
    }
    if (follow && content.isConnected && byId("dialog").open) timer = setTimeout(refresh, 2500);
  }
  showDialog("Run log", content);
  queueMicrotask(refresh);
}

function designPanel(initialState) {
  const panel = element("section", "design-stack design-workspace");
  const tabs = element("div", "design-tabs");
  const body = element("div", "design-stack");
  const status = element("p", "design-status");
  const liveDecision = element("div");
  const nextAction = element("div", "design-next");
  let decisionKey;
  status.setAttribute("role", "status");
  panel.append(tabs, nextAction, status, liveDecision, body);
  const canShowChanges = embedded && hostOptions.workingFiles && hostOptions.workingDiff;
  const names = embedded ? ["Plan", "Mockups", ...(canShowChanges ? ["Changes"] : [])] : ["Plan", "Mockups", "Preview", "Build"];
  let tab = !embedded && names.includes(layoutSetting("tab")) ? layoutSetting("tab") : "Plan";
  let state = initialState || projectConversation?.current(), selectedAsset, busy = false;
  let draftKey = designDraftKey(state);
  let localDraft = designDraftFor(draftKey);
  const defaultDecisions = {scope_confirmed: "confirmed", engine_integration: "confirmed",
    code_changes: "allow_scoped", migrations: "deny", dependencies: "deny"};
  const launchForm = {scope: "plan", frequency: "slice", decisions: {}, agreementOpen: true};
  for (const question of projectState.questions.filter(q => q.required)) {
    const option = defaultDecisions[question.id];
    if (question.options.includes(option)) launchForm.decisions[question.id] = option;
  }
  const settings = {branch: null, host: null};
  const previewDraft = {};
  const reviewDrafts = new Map();
  let readiness, readinessKey, buildStamp, runControls, refreshing = false;
  function rememberDraft() {
    persistDesignDraft(draftKey, localDraft);
  }
  const draftDiffers = plan => plan.plan !== state.plan || (embedded
    ? plan.title !== (state.title || "") || state.mode !== "task"
    : JSON.stringify(plan.roadmap) !== JSON.stringify(state.roadmap));
  function clearPlanDraft() {
    localDraft.plan = null;
    localDraft.baseRevision = null;
    rememberDraft();
  }
  const box = (title, ...items) => element("section", "panel", heading(title), element("div", "panel-body design-stack", ...items));
  const input = (value, label, change) => {
    const node = element("input");
    node.value = value;
    node.setAttribute("aria-label", label);
    node.addEventListener("input", () => change(node.value));
    return node;
  };
  const redraw = () => { if (panel.isConnected) draw(); };
  async function change(action, payload, options = {}) {
    if (busy) return;
    const submittedDraft = JSON.stringify(localDraft.plan);
    const submittedRevision = localDraft.baseRevision;
    const submittedMessage = localDraft.message;
    busy = true;
    panel.setAttribute("aria-busy", "true");
    status.textContent = options.wait || "Saving…";
    try {
      const next = await api("design/" + action, {revision: state.revision, ...(embedded && {mode: "task"}), ...payload});
      state = {...next, checklist: state.checklist};
      if (["approve", "settings"].includes(action)) { readiness = null; readinessKey = null; }
      if (options.reset && localDraft.baseRevision === submittedRevision && JSON.stringify(localDraft.plan) === submittedDraft) {
        clearPlanDraft();
      }
      if (options.clear && localDraft.message === submittedMessage) localDraft.message = "";
      if (action === "image" && payload.asset && localDraft.mockupMessage === payload.message) localDraft.mockupMessage = "";
      rememberDraft();
      const plannerError = ["chat", "answer", "retry"].includes(action) && next.plannerRetry?.error;
      status.textContent = plannerError || options.done || "Saved.";
      redraw();
      projectConversation?.update(state);
      return state;
    } catch (error) {
      status.textContent = error.message;
      options.onError?.(error);
      // Keep local edits and the submitted base revision until the user resolves the conflict.
      try { state = await api("design"); redraw(); projectConversation?.update(state); } catch {}
    } finally { busy = false; panel.removeAttribute("aria-busy"); }
  }
  let editPlan = false;
  let planHeight = 340;
  let planStartStatus = "";
  let startingFromPlan = false;
  function showPlanStartStatus(message) {
    planStartStatus = message;
    const feedback = panel.querySelector("[data-plan-start-status]");
    if (feedback) {
      feedback.textContent = message;
      feedback.hidden = !message;
    }
  }
  function renderPlan(text, target) {
    target.replaceChildren();
    let list, code;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) {
        if (code) code = null;
        else { code = element("code"); target.append(element("pre", "", code)); }
        list = null;
        continue;
      }
      if (code) { code.textContent += line + "\n"; continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      const bullet = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(line);
      if (!line.trim()) { list = null; continue; }
      const tag = bullet ? (/\d/.test(bullet[1]) ? "ol" : "ul") : null;
      if (tag && list?.localName !== tag) { list = element(tag); target.append(list); }
      if (!tag) list = null;
      const node = element(heading ? "h" + Math.max(3, heading[1].length) : bullet ? "li" :
        /^(Acceptance criteria|Verification|Scope|Constraints)$/i.test(line.trim()) ? "h3" : "p");
      for (const fragment of (heading?.[2] || bullet?.[2] || line).split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g)) {
        if (fragment.startsWith("**") && fragment.endsWith("**")) node.append(element("strong", "", fragment.slice(2, -2)));
        else if (fragment.startsWith("`") && fragment.endsWith("`")) node.append(element("code", "", fragment.slice(1, -1)));
        else if (fragment.startsWith("*") && fragment.endsWith("*") && fragment.length > 2) node.append(element("em", "", fragment.slice(1, -1)));
        else node.append(fragment);
      }
      (list || target).append(node);
    }
  }
  function taskEditor() {
    const editing = localDraft.plan?.title !== undefined ? localDraft.plan : {title: state.title || "", plan: state.plan};
    if (editing === localDraft.plan && !editing.title.trim() && editing.plan.trim()) {
      editing.title = titleFromPlan(editing.plan);
      rememberDraft();
    }
    const baseRevision = localDraft.plan?.title !== undefined ? localDraft.baseRevision : state.revision;
    const title = input(editing.title, "Title", value => { editing.title = value; edited(); });
    title.dataset.designFocus = "plan-title";
    const draft = element("textarea", "plan-text");
    draft.dataset.designFocus = "plan";
    draft.value = editing.plan;
    draft.setAttribute("aria-label", "Plan and acceptance criteria");
    draft.addEventListener("input", () => { editing.plan = draft.value; edited(); });
    const rendered = element("div", "plan-readable");
    rendered.dataset.designFocus = "plan-reading";
    rendered.tabIndex = -1;
    const placeholder = element("p", "", "Draft the plan in Project conversation or select Edit plan.");
    const toggle = button("✎", () => {
      editPlan = !editPlan;
      if (!editPlan) planHeight = Math.max(340, draft.offsetHeight);
      updatePlanView();
      if (editPlan) draft.focus();
    });
    toggle.classList.add("plan-edit-toggle");
    function updatePlanView() {
      draft.hidden = !editPlan;
      rendered.hidden = editPlan;
      toggle.setAttribute("aria-pressed", String(editPlan));
      toggle.setAttribute("aria-label", editPlan ? "Show formatted plan" : "Edit plan");
      toggle.title = editPlan ? "Show formatted plan" : "Edit plan";
      // Preserve the vertical resize when switching between edit and reading.
      draft.style.minHeight = rendered.style.minHeight = planHeight + "px";
      if (!editPlan) {
        if (editing.plan.trim()) renderPlan(editing.plan, rendered);
        else rendered.replaceChildren(placeholder);
      }
    }
    updatePlanView();
    const summary = element("p", "design-draft-state");
    const save = button("Save draft", () => change("draft", {...editing, revision: baseRevision}, {reset: true}));
    save.dataset.designFocus = "plan-save";
    const discard = button("Discard local draft", () => { clearPlanDraft(); draw(); });
    const questions = projectState.questions.filter(q => q.required);
    const agreement = element("details", "", element("summary", "", "Build agreement"));
    agreement.open = launchForm.agreementOpen;
    agreement.addEventListener("toggle", () => { launchForm.agreementOpen = agreement.open; });
    for (const question of questions) {
      agreement.append(field(question.text, select(launchForm.decisions[question.id], question.options.map(value => [
        value, question.option_details?.find(option => option.id === value)?.label || value
      ]), value => { launchForm.decisions[question.id] = value; return true; })));
    }
    const start = button("Start build", async () => {
      if (startingFromPlan) return;
      startingFromPlan = true;
      start.disabled = true;
      showPlanStartStatus("Checking build readiness…");
      const onError = error => showPlanStartStatus(error.message);
      try {
        if (!stateProfileApplied() || byId("apply-profile").textContent === "Apply changes") {
          showPlanStartStatus("Preparing the " + active().name + " workflow…");
          await saveWorkflowProfile();
        }
        const preflight = await api("design/readiness");
        const blockers = preflight.items.filter(item => item.status === "blocked" && !["plan", "review"].includes(item.id));
        if (blockers.length) {
          showPlanStartStatus(blockers.map(item => item.message).join(" "));
          return;
        }
        if (draftDiffers(editing) && !await change("draft", {...editing, revision: baseRevision}, {reset: true, onError})) return;
        if (state.approved !== state.revision && !await change("approve", {}, {onError})) return;
        const checked = await api("design/readiness");
        if (!checked.ready) {
          showPlanStartStatus(checked.items.filter(item => item.status === "blocked").map(item => item.message).join(" "));
          return;
        }
        showPlanStartStatus("Starting build…");
        if (await change("build", {stages: active().stages, decisions: launchForm.decisions},
          {wait: "Starting build…", done: "Build started.", onError})) {
          showPlanStartStatus("");
          goBuild();
        }
      } catch (error) { onError(error); }
      finally {
        startingFromPlan = false;
        if (start.isConnected) updateActions();
        else if (tab === "Plan") draw();
      }
    }, "button primary");
    start.dataset.designFocus = "plan-approve";
    const startFeedback = element("p", "design-status", planStartStatus);
    startFeedback.dataset.planStartStatus = "";
    startFeedback.setAttribute("role", "status");
    startFeedback.hidden = !planStartStatus;
    function updateActions() {
      const stale = baseRevision !== state.revision;
      const dirty = draftDiffers(editing);
      const pending = state.question || state.plannerRetry;
      const current = state.builds.at(-1);
      const running = current && !["closed", "retired"].includes(current.status);
      const valid = Boolean(editing.title.trim() && editing.plan.trim());
      save.disabled = stale || !dirty || !valid || Boolean(running);
      discard.hidden = !localDraft.plan;
      start.disabled = startingFromPlan || stale || !valid || Boolean(pending || running);
      summary.textContent = stale ? "Saved plan changed. Compare it before applying this draft."
        : running ? "A build is active for this change."
        : localDraft.plan ? "Unsaved draft" : state.approved === state.revision ? "Approved plan" : "Draft plan";
    }
    function edited() {
      localDraft.plan = draftDiffers(editing) ? editing : null;
      localDraft.baseRevision = localDraft.plan ? baseRevision : null;
      rememberDraft();
      updateActions();
    }
    updateActions();
    const result = box("Plan", field("Title", title),
      element("div", "plan-reading-tools", element("strong", "", "Plan and acceptance criteria"), toggle),
      rendered, draft, summary,
      agreement, element("p", "", "Start build uses the " + active().name + " workflow and approves this plan and agreement."),
      element("div", "actions", save, discard, start), startFeedback);
    if (baseRevision !== state.revision) result.append(
      element("details", "", element("summary", "", "Compare saved plan"), element("pre", "", state.plan)),
      button("Use local draft", () => { localDraft.baseRevision = state.revision; rememberDraft(); draw(); }));
    return result;
  }
  function editor() {
    if (embedded) return taskEditor();
    const editing = localDraft.plan || {plan: state.plan, roadmap: structuredClone(state.roadmap)};
    const baseRevision = localDraft.plan ? localDraft.baseRevision : state.revision;
    const changed = () => draftDiffers(editing);
    function edited() {
      localDraft.plan = changed() ? editing : null;
      localDraft.baseRevision = localDraft.plan ? baseRevision : null;
      rememberDraft();
      updateActions();
      guideNext();
    }
    const focusRoadmap = id => body.querySelector('[data-roadmap-id="' + CSS.escape(id) + '"]')?.focus();
    function roadmapActions(items, index, subject, fallback) {
      const item = items[index];
      const move = (label, shift) => {
        const neighbor = index + shift;
        const control = button(label, () => {
          items.splice(index, 1);
          items.splice(neighbor, 0, item);
          edited();
          draw();
          focusRoadmap(item.id);
        });
        control.disabled = neighbor < 0 || neighbor >= items.length;
        control.setAttribute("aria-label", "Move " + subject + (shift < 0 ? " up" : " down"));
        return control;
      };
      const remove = button("Remove", () => {
        items.splice(index, 1);
        edited();
        draw();
        focusRoadmap(items[index]?.id || items[index - 1]?.id || fallback);
      });
      remove.setAttribute("aria-label", "Remove " + subject);
      return element("div", "actions roadmap-actions", move("Move up", -1), move("Move down", 1), remove);
    }
    function titleInput(item, label) {
      const node = input(item.title, label, value => { item.title = value; edited(); });
      node.dataset.roadmapId = item.id;
      return node;
    }
    const draft = element("textarea", "plan-text");
    draft.dataset.designFocus = "plan";
    draft.value = editing.plan;
    draft.addEventListener("input", () => { editing.plan = draft.value; edited(); });
    const map = element("div", "roadmap");
    for (const [index, milestone] of editing.roadmap.entries()) {
      const section = element("div", "milestone", field("Milestone", titleInput(milestone, "Milestone title")),
        roadmapActions(editing.roadmap, index, "milestone " + (index + 1), "add-milestone"));
      for (const [sliceIndex, slice] of milestone.slices.entries()) {
        const row = element("div", "roadmap-slice", field("Slice", titleInput(slice, "Slice title")),
          element("small", "stage-meta", roadmapStatus(slice.id, state.builds)),
          roadmapActions(milestone.slices, sliceIndex, "slice " + (sliceIndex + 1) + " of milestone " + (index + 1), milestone.id));
        const asset = state.attachments[slice.id];
        if (asset) row.append(assetImage(asset, slice.title + " selected mockup"));
        section.append(row);
      }
      section.append(button("Add slice", () => {
        const id = crypto.randomUUID();
        milestone.slices.push({id, title: ""});
        edited();
        draw();
        focusRoadmap(id);
      }));
      map.append(section);
    }
    const addMilestone = button("Add milestone", () => {
      const id = crypto.randomUUID();
      editing.roadmap.push({id, title: "", slices: []});
      edited();
      draw();
      focusRoadmap(id);
    });
    addMilestone.dataset.roadmapId = "add-milestone";
    map.append(addMilestone);
    const stale = baseRevision !== state.revision;
    const save = button("Save draft", () => change("draft", {...editing, revision: baseRevision}, {reset: true}), "button primary");
    save.dataset.designFocus = "plan-save";
    const discardDraft = () => { clearPlanDraft(); draw(); };
    const discard = button("Discard local draft", discardDraft);
    const approve = button("Approve revision " + state.revision, () => change("approve", {}));
    approve.dataset.designFocus = "plan-approve";
    const current = state.builds.at(-1);
    const ongoing = current && !["closed", "retired"].includes(current.status);
    const start = button(ongoing ? "View build" : "Build options", () => {
      openTab("Build");
    });
    const saved = element("small", "design-draft-state");
    function updateActions() {
      const dirty = changed();
      const missingNames = editing.roadmap.some(row => !row.title.trim() || row.slices.some(slice => !slice.title.trim()));
      save.disabled = stale || !dirty || missingNames;
      discard.hidden = stale || !dirty;
      approve.disabled = stale || dirty || !state.plan.trim() || !state.roadmap.some(row => row.slices.length) ||
        state.approved === state.revision || Boolean(state.question || state.plannerRetry);
      saved.textContent = stale ? "Local draft from revision " + baseRevision :
        missingNames ? "Name each milestone and slice before saving." :
        dirty ? "Unsaved draft" : state.approved === state.revision ? "Approved revision " + state.revision : "Draft revision " + state.revision;
    }
    updateActions();
    const result = box("Draft plan", saved, field("Plan text", draft), map, element("div", "actions", save, discard, approve, start));
    if (stale) {
      const conflict = element("details", "", element("summary", "", "Compare saved revision " + state.revision),
        element("pre", "", state.plan), element("pre", "", JSON.stringify(state.roadmap, null, 2)));
      result.append(element("div", "design-draft-conflict", element("p", "", "The saved revision changed. Compare it before saving your draft."),
        conflict, element("div", "actions", button("Use my draft with revision " + state.revision, () => {
          localDraft.baseRevision = state.revision;
          rememberDraft();
          draw();
        }), button("Discard local draft", discardDraft))));
    }
    return result;
  }
  function conversationActions() {
    const slices = (localDraft.plan?.roadmap || state.roadmap).flatMap(row => row.slices.map(slice =>
      [slice.id, row.title + " / " + slice.title]));
    function selectSlice(id) {
      if (localDraft.slice !== id) { localDraft.slice = id; rememberDraft(); }
      projectConversation?.selectSlice(id ? {section: "slice", id, label: slices.find(row => row[0] === id)?.[1]} : {});
      return true;
    }
    selectSlice(slices.some(row => row[0] === localDraft.slice) ? localDraft.slice : "");
    return box("Design context", field("Current slice", select(localDraft.slice, [["", "Whole plan"], ...slices], selectSlice)),
      button("Open project conversation", () => projectConversation.open()));
  }
  function mockups() {
    const assets = state.assets;
    const generate = button("Plan a mockup", () => projectConversation.openMockup());
    if (!assets.length) return box("Mockup versions", generate);
    if (!assets.some(a => a.id === selectedAsset)) selectedAsset = assets.at(-1).id;
    const choices = select(selectedAsset, assets.map((a, i) => [a.id, "Version " + (i + 1) + " · " +
      (a.target ? [a.target, a.page, "Plan revision " + a.planRevision].filter(Boolean).join(" · ") : a.prompt)]),
      id => { selectedAsset = id; draw(); return true; });
    const revise = element("textarea");
    revise.dataset.designFocus = "mockup";
    revise.value = localDraft.mockupMessage;
    revise.addEventListener("input", () => { localDraft.mockupMessage = revise.value; rememberDraft(); });
    const slices = state.roadmap.flatMap(m => m.slices.map(s => [s.id, m.title + " / " + s.title]));
    const target = select(slices.some(row => row[0] === localDraft.slice) ? localDraft.slice : slices[0]?.[0] || "", slices, () => true);
    return box("Mockup versions", generate, field("Version", choices), assetImage(selectedAsset, choices.selectedOptions[0].textContent),
      field("Revision request", revise), button("Generate revision", () => change("image",
        {asset: selectedAsset, message: revise.value}, {wait: "Revising mockup…"})),
      ...(embedded ? [] : [field("Roadmap slice", target)]),
      button("Attach this version", () => change("attach", {asset: selectedAsset, ...(embedded ? {} : {slice: target.value})})));
  }
  function preview(inPlan = false) {
    const mount = element("div", "preview-frame");
    const address = input(previewDraft.address ?? state.preview ?? "", "App address", value => { previewDraft.address = value; });
    address.dataset.designFocus = "preview";
    address.placeholder = "http://localhost:3000";
    const save = button("Save app address", async () => {
      if (await change("settings", {preview: address.value.trim(), branch: state.branch})) await checkAddress();
    });
    const open = element("a", "button", "Open app preview");
    open.target = "_blank";
    open.rel = "noopener";
    open.hidden = true;
    if (embedded && hostOptions.openPreview) open.onclick = event => {
      event.preventDefault();
      Promise.resolve(hostOptions.openPreview(open.href)).catch(error => notify(error.message));
    };
    const previewStatus = element("p", "design-status");
    const viewport = element("div", "project-viewport");
    const fullStatus = element("span", "");
    fullStatus.setAttribute("role", "status");
    const sendView = button("Capture and send to change", async () => {
      sendView.disabled = true;
      fullStatus.textContent = "Capturing project view…";
      try {
        const saved = await projectConversation.capturePreview?.({sendToChange: true, openDrawer: false});
        if (!saved) { fullStatus.textContent = "Capture unavailable. Choose this tab in Chrome, or upload a screenshot."; return; }
        if (document.fullscreenElement) await document.exitFullscreen();
        fullStatus.textContent = "";
        projectConversation.open();
      } catch (error) { fullStatus.textContent = error.message; }
      finally { sendView.disabled = false; }
    }, "button primary");
    const fullTools = element("div", "project-fullscreen-tools", sendView,
      button("Exit full screen", () => document.exitFullscreen().catch(error => notify(error.message))), fullStatus);
    function toolbarButton(label, glyph, action, iconClass = "") {
      const control = button("", action, "button preview-icon-button");
      control.title = label;
      control.setAttribute("aria-label", label);
      const icon = element("span", "preview-icon " + iconClass, glyph);
      icon.setAttribute("aria-hidden", "true");
      control.append(icon);
      return control;
    }
    const fullScreen = toolbarButton("Full screen", "⛶", () => {
      if (viewport.querySelector("iframe")) viewport.requestFullscreen().catch(error => notify(error.message));
    });
    const captureView = toolbarButton("Capture this view", "", () => projectConversation.capturePreview?.(), "preview-camera-icon");
    const refreshView = toolbarButton("Reload page", "↻", () => {
      const frame = viewport.querySelector("iframe");
      if (frame) frame.src = frame.src;
    });
    const pages = element("div", "project-preview-pages");
    const automaticControls = element("div", "design-stack");
    const tools = element("div", "project-preview-toolbar", pages,
      element("div", "actions", refreshView, captureView, fullScreen));
    tools.setAttribute("role", "group");
    tools.setAttribute("aria-label", "Project preview controls");
    viewport.hidden = true;
    mount.append(previewStatus, automaticControls, viewport);
    let process, checked, source, timer, pending = false, version = 0;
    let pageAddress = "", baseAddress = "";
    const publishView = () => {
      const frame = viewport.querySelector("iframe");
      if (mount.isConnected) projectConversation.setPreview?.(frame ? {frame, address: pageAddress} : null);
    };
    function loadPage(url) {
      pageAddress = url;
      viewport.replaceChildren(tools, fullTools);
      if (url) {
        const frame = element("iframe");
        frame.title = projectState.project.label + " app preview";
        frame.setAttribute("sandbox", "allow-forms allow-scripts allow-same-origin");
        frame.src = url;
        viewport.append(frame);
        open.href = url;
      }
      viewport.hidden = !url;
      publishView();
    }
    function showPages(url) {
      pages.replaceChildren(url ? element("small", "", new URL(url).pathname) : "");
      if (!url) return;
      api("quality/routes").then(({routes}) => {
        if (!mount.isConnected || baseAddress !== url) return;
        const paths = [...new Set((routes || []).filter(row => row.method === "GET" &&
          /^\/(?!\/)[^:*{}()?#\\]*$/.test(row.path)).map(row => row.path))].slice(0, 150);
        if (paths.length) pages.replaceChildren(field("Project page", select("", [["", "Preview start page"],
          ...paths.map(path => [path, path])], path => {
          loadPage(path ? new URL(path, url).href : url);
          return true;
        })));
      }).catch(() => {});
    }
    const previewMode = select(previewDraft.mode || "web", [["web", "Web preview"], ["process", "Desktop or command output"]], value => {
      previewDraft.mode = value;
      if (value === "process") details.open = true;
      embed();
      return true;
    });
    const live = () => process?.owned && ["starting", "running"].includes(process.state);
    function embed() {
      if (!mount.isConnected) return;
      let selected = previewMode.value === "web" ? checked : null;
      const url = process?.settings?.url;
      const ready = ["running", "external"].includes(process?.state);
      if (previewMode.value === "web" && url && (ready || !selected?.address || selected.address === url)) {
        selected = {address: url, url: ready ? process.url : "", status: ready ? "" : "Preview is not ready."};
      }
      const target = selected?.url || selected?.address;
      open.hidden = !target;
      if (target) open.href = target;
      previewStatus.textContent = selected?.status || (!target ? "Set up a preview to load this project's app." : "");
      if (selected?.url && new URL(selected.url).origin === location.origin) {
        previewStatus.textContent = "Choose the project's preview address.";
        selected = null;
      }
      if (source === selected?.url) return;
      source = selected?.url;
      baseAddress = source;
      loadPage(source || "");
      showPages(source);
    }
    async function checkAddress() {
      try { checked = await api("design/preview"); }
      catch (error) { checked = {status: error.message}; }
      embed();
    }

    const program = input(previewDraft.program || "", "Executable", value => { previewDraft.program = value; });
    const args = element("textarea");
    args.value = previewDraft.args || "";
    args.rows = 3;
    args.addEventListener("input", () => { previewDraft.args = args.value; });
    const cwd = input(previewDraft.cwd ?? ".", "Preview working directory", value => { previewDraft.cwd = value; });
    const discovered = element("div", "design-stack");
    projectCapabilities().then(capabilities => {
      if (!discovered.isConnected || !capabilities.previews.length) return;
      const origin = element("p", "design-status");
      const picker = select(previewDraft.choice || "", [["", "Enter a command manually"],
        ...capabilities.previews.map(item => [item.id, item.label])], id => {
        previewDraft.choice = id;
        const item = capabilities.previews.find(candidate => candidate.id === id);
        if (!item) { origin.textContent = ""; return true; }
        previewDraft.program = program.value = item.argv[0];
        previewDraft.args = args.value = item.argv.slice(1).join("\n");
        previewDraft.cwd = cwd.value = item.cwd;
        const stack = (capabilities.components || []).find(component => component.id === item.component_id)?.stack;
        if (item.url) {
          previewDraft.address = address.value = item.url;
          previewDraft.mode = previewMode.value = "web";
        } else if (stack === "Electron") {
          previewDraft.mode = previewMode.value = "process";
          details.open = true;
        }
        origin.textContent = item.source.map(row => row.path).join(", ");
        embed();
        return true;
      });
      discovered.append(field("Detected preview", picker), origin);
    }).catch(() => {});
    const processStatus = element("p", "design-status");
    processStatus.setAttribute("role", "status");
    const output = element("textarea");
    output.rows = 7;
    output.readOnly = true;
    output.addEventListener("blur", () => { output.value = process?.log || "No output yet."; });
    const details = element("details", "", element("summary", "", "Preview output"), field("Process output", output));
    const start = button("Start preview", () => run("start"), "button primary");
    const stop = button("Stop preview", () => run("stop"));
    stop.disabled = true;
    function controls() {
      start.disabled = pending || Boolean(live());
      stop.disabled = pending || !live();
    }
    function showProcess(next) {
      process = next;
      if (next.settings) {
        if (previewDraft.program === undefined) program.value = next.settings.argv[0];
        if (previewDraft.args === undefined) args.value = next.settings.argv.slice(1).join("\n");
        if (previewDraft.cwd === undefined) cwd.value = next.settings.cwd;
        if (previewDraft.address === undefined && next.settings.url) address.value = next.settings.url;
        if (previewDraft.mode === undefined) previewMode.value = next.settings.url ? "web" : "process";
      }
      const labels = {unconfigured: "Enter a preview command.", stopped: "Stopped", starting: "Starting",
        running: "Running", external: "App is running outside Workbench.", exited: "Exited"};
      processStatus.textContent = next.message || labels[next.state] || next.state;
      if (next.exitCode != null) processStatus.textContent += " · Exit " + next.exitCode;
      if (document.activeElement !== output) output.value = next.log || "No output yet.";
      controls();
      embed();
      if (inPlan) {
        automaticControls.replaceChildren();
        if (!source && next.message) previewStatus.textContent = next.message;
        if (!source && next.choices?.length) {
          const appPicker = select("", [["", "Select the app"],
            ...next.choices.map(item => [item.id, item.label])], value => {
            if (value) void startAutomatic({id: value, retry: true});
            return true;
          });
          automaticControls.append(field("Project app", appPicker));
        } else if (!source && ["exited", "stopped"].includes(next.state)) {
          automaticControls.append(button("Start project preview", () => startAutomatic({retry: true})));
        }
      }
    }
    function follow() {
      clearTimeout(timer);
      if (mount.isConnected && live()) timer = setTimeout(refresh, 2500);
    }
    async function refresh() {
      if (!mount.isConnected || pending) return;
      if (!document.hidden) {
        const observed = version;
        try {
          const next = await api("design/app-process");
          if (!pending && observed === version && mount.isConnected) showProcess(next);
        } catch (error) { processStatus.textContent = error.message; }
      }
      follow();
    }
    async function startAutomatic(options = {}) {
      if (pending || !mount.isConnected) return;
      pending = true;
      version++;
      controls();
      previewStatus.textContent = "Preparing project preview…";
      try { showProcess(await api("design/app-process/auto", options)); }
      catch (error) { previewStatus.textContent = error.message; }
      finally { pending = false; controls(); follow(); }
    }
    async function run(action) {
      if (pending) return;
      pending = true;
      version++;
      const focused = document.activeElement;
      controls();
      try {
        if (action === "start") {
          const argv = [program.value.trim(), ...(args.value ? args.value.split("\n") : [])];
          const url = previewMode.value === "web" ? address.value.trim() : "";
          if (previewMode.value === "web" && !url) throw Error("Enter the address for this web preview.");
          const configured = await api("design/app-process/setup", {argv, cwd: cwd.value.trim() || ".", url});
          showProcess(configured);
          if (configured.state === "external") return;
        }
        showProcess(await api("design/app-process/" + action, {}));
      } catch (error) { processStatus.textContent = error.message; }
      finally {
        pending = false;
        controls();
        if (mount.isConnected && (document.activeElement === focused || document.activeElement === document.body)) {
          (live() ? stop : start).focus({preventScroll: true});
        }
        follow();
      }
    }
    const reload = button("Refresh preview", () => { checkAddress(); refresh(); });
    queueMicrotask(async () => {
      await checkAddress();
      if (inPlan && !checked?.url) await startAutomatic();
      else await refresh();
    });
    const setup = box("Manage preview process", discovered, field("Preview mode", previewMode), field("Executable", program),
      field("Arguments (one literal argument per line)", args), field("Working directory", cwd),
      element("div", "actions", start, stop), processStatus, details);
    const addressControls = element("div", "design-stack", field("App address", address), element("div", "actions", save, reload, open));
    if (inPlan) return box("Live project preview", mount,
      element("details", "", element("summary", "", "Preview settings"), addressControls, setup));
    return element("div", "design-stack", box("Project app preview", addressControls, mount), setup);
  }
  function review(build, group, index, continueBuild) {
    const target = {build: build.id, group: index, sha: group.sha, slices: group.slices};
    const members = group.slices.map(id => [id, build.roadmap.flatMap(m => m.slices).find(s => s.id === id).title]);
    const area = box("Branch Review", element("code", "run-id", group.sha), element("p", "", members.map(s => s[1]).join(" · ")));
    const diff = element("pre", "commit-diff");
    const inspect = element("details", "", element("summary", "", "Inspect commit diff"), diff);
    inspect.addEventListener("toggle", async () => {
      if (!inspect.open || diff.textContent) return;
      try {
        const evidence = await api("design/evidence?build=" + build.id + "&group=" + index);
        diff.textContent = evidence.sha === group.sha ? evidence.diff || "No file changes." : "The review target changed.";
      } catch (error) { diff.textContent = error.message; }
    });
    area.append(inspect);
    const approved = group.reviews.at(-1)?.sha === group.sha;
    const held = approved && build.status === "ready" && group.sha === build.base;
    let updateDelivery;
    for(const [id,title] of members){
      const asset=build.attachments[id];
      if(asset)area.append(element("details","",element("summary","","Selected mockup · "+title),assetImage(asset,title)));
    }
    if (approved) {
      const decision = group.reviews.at(-1);
      area.append(element("p", "", "Approved by " + decision.author + " · " + decision.branch));
      const destination = element("small", "", "Checking GitHub destination…");
      const publish = button("Push reviewed commit", () => change("push", {...target, expectedTarget:publish.dataset.target},
        {wait:"Pushing approved commit…", done:"Push completed."}));
      publish.disabled = true;
      if (group.pushed?.sha === group.sha) {
        area.append(element("p", "design-push-receipt", "Pushed to " + (group.pushed.destination || decision.branch)),
          element("code", "run-id", group.pushed.sha));
      } else {
        area.append(destination, element("div", "actions", publish, ...(continueBuild ? [continueBuild] : [])));
        updateDelivery = review => {
          publish.dataset.target=review.pushTarget || "";
          publish.disabled=build.retired || !review.pushTarget || review.status!=="approved";
          destination.textContent=review.pushTarget ? review.pushTarget+" / "+decision.branch :
            review.message || "Configure a GitHub remote to push.";
        };
        if (!held) api("design/group?"+new URLSearchParams({build:build.id,group:index})).then(updateDelivery)
          .catch(error=>{destination.textContent=error.message;});
      }
      if (group.pushed?.sha === group.sha && continueBuild) area.append(continueBuild);
      if (build.status !== "closed" && !held) return area;
    }
    const evidence=element("div","design-stack");
    area.append(evidence);
    const identity = build.id + ":" + index + ":" + group.sha;
    if (!reviewDrafts.has(identity)) reviewDrafts.set(identity, {affected: new Set(), text: "", open: false, findingId: null});
    const draft = reviewDrafts.get(identity);
    const finding = element("textarea");
    finding.value = draft.text;
    finding.dataset.designFocus = "finding-" + identity;
    finding.addEventListener("input", () => { draft.text = finding.value; draft.findingId = null; });
    const findings = element("details", "", element("summary", "", "Record a finding"), field("Finding", finding));
    findings.open = draft.open;
    findings.addEventListener("toggle", () => { draft.open = findings.open; });
    for (const [id, title] of members) findings.append(checkbox(title, draft.affected.has(id), on => {
      if (on) draft.affected.add(id); else draft.affected.delete(id); return true;
    }));
    findings.append(button("Reopen affected slices", () => change("finding", {...target, affected: [...draft.affected],
      ...(draft.findingId ? {findingIds: [draft.findingId]} : {text: draft.text})})));
    area.append(findings);
    if (!approved || held) watchGroupReview(area,evidence,target,{
      approve:approved ? null : ()=>change("review",target,{done:"Branch Review approval recorded."}),
      update:details=>{
        updateDelivery?.(details);
        if (continueBuild) continueBuild.disabled = ["changes-requested", "design-stale", "branch-changed", "different-preview"].includes(details.status);
      },
      canApply:()=>!busy && !document.hidden && !findings.open,
      selectFinding:issue=>{
        draft.findingId = issue.id || null;
        draft.text = finding.value = issue.actual+"\nExpected: "+issue.expected;
        findings.open=true;
        finding.focus();
      }
    });
    return area;
  }
  function taskReview(build, group, index) {
    const evidence = element("div", "design-stack");
    const area = box("Branch Review", evidence);
    let last;
    async function update() {
      if (!area.isConnected) return;
      try {
        const current = await api("design/group?" + new URLSearchParams({build: build.id, group: index}));
        if (!area.isConnected) return;
        const key = JSON.stringify([current.status, current.runId, current.message]);
        if (key !== last) {
          last = key;
          evidence.replaceChildren(element("p", "", current.message || "Commit " + group.sha.slice(0, 8)));
          if (current.runId && !["branch-changed", "design-stale"].includes(current.status)) {
            const open = element("a", "button primary", "Review changes");
            open.href = current.url || "#";
            reviewLink(open, current.runId);
            evidence.append(open);
          }
        }
      } catch (error) {
        evidence.textContent = error.message;
        last = null;
      } finally {
        if (area.isConnected) setTimeout(update, 5000);
      }
    }
    queueMicrotask(update);
    return area;
  }
  let selectedChangedFile = "";
  let changedFilesFilter = "";
  function changedFilesPanel() {
    const build = state.builds.at(-1);
    let base = build?.groups[0]?.base || build?.base;
    let rows = [], request = 0, patchKey, signature, loading = false, timer;
    const criteria = element("p", "design-status");
    criteria.setAttribute("role", "status");
    const files = element("div", "changes-tree");
    const diff = element("div", "changes-diff");
    const search = input(changedFilesFilter, "Filter files", value => { changedFilesFilter = value; drawFiles(); });
    search.type = "search";
    const counts = element("small", "");
    const viewer = element("section", "panel changes-viewer", diff);
    const refreshButton = button("Refresh changes", () => refresh(true));
    const changes = element("section", "design-stack",
      element("header", "panel changes-header", heading("Changes", "", refreshButton), criteria),
      element("div", "changes-layout", box("Files", field("Filter files", search), counts, files), viewer));
    const statuses = {A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed"};
    function drawFiles() {
      const query = changedFilesFilter.trim().toLowerCase();
      const shown = rows.filter(file => !query || (file.path + " " + (file.previousPath || "")).toLowerCase().includes(query));
      counts.textContent = rows.length + (rows.length === 1 ? " file changed" : " files changed");
      if (!shown.length) files.replaceChildren(element("p", "", rows.length ? "No matching files." : "No tracked changes."));
      else files.replaceChildren(...shown.map(file => {
        const parts = file.path.split("/");
        const name = parts.pop();
        const selectFile = button("", () => { selectedChangedFile = file.path; drawFiles(); void showDiff(file); }, "changes-file");
        selectFile.setAttribute("aria-pressed", String(file.path === selectedChangedFile));
        selectFile.title = (statuses[file.status] || file.status) + " · " + file.path;
        selectFile.append(element("span", "changes-file-status", file.status),
          element("span", "changes-file-name", element("strong", "", name),
            ...(parts.length ? [element("small", "", parts.join("/"))] : [])));
        return selectFile;
      }));
    }
    function displayPatch(result) {
      const lines = result.patch.replace(/\n$/, "").split("\n");
      const code = element("div", "changes-code");
      let before, after;
      for (const line of lines.slice(0, 2500)) {
        const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (range) {
          before = Number(range[1]); after = Number(range[2]);
          code.append(element("div", "changes-hunk", line));
          continue;
        }
        if (before === undefined || !/^[ +\-]/.test(line)) {
          code.append(element("div", "changes-meta", line));
          continue;
        }
        const added = line.startsWith("+"), removed = line.startsWith("-");
        code.append(element("div", "changes-line" + (added ? " addition" : removed ? " deletion" : ""),
          element("span", "changes-line-number", added ? "" : String(before++)),
          element("span", "changes-line-number", removed ? "" : String(after++)),
          element("code", "", line || " ")));
      }
      if (result.truncated || lines.length > 2500) code.append(element("p", "changes-meta", "Showing the first part of this diff."));
      return code;
    }
    async function showDiff(file) {
      const id = ++request;
      try {
        const result = await hostOptions.workingDiff(base, file.path);
        if (id !== request || !changes.isConnected) return;
        const key = JSON.stringify([file.path, result.patch, result.truncated]);
        if (patchKey === key) return;
        patchKey = key;
        const editor = hostOptions.openEditor && file.status !== "D" ? button("Open in IDE", () =>
          hostOptions.openEditor(file.path).catch(error => notify(error.message))) : null;
        const count = file.binary ? "Binary file" : "+" + file.added + " −" + file.removed;
        diff.replaceChildren(heading(file.path, file.previousPath ? "From " + file.previousPath + " · " + count : count, editor),
          result.patch ? displayPatch(result) : element("p", "panel-body", "No text diff is available."));
      } catch (error) {
        if (id === request && changes.isConnected) {
          patchKey = undefined;
          diff.textContent = error.message;
        }
      }
    }
    async function refresh(force = false) {
      if (loading || !changes.isConnected) return;
      loading = refreshButton.disabled = true;
      clearTimeout(timer);
      try {
        base ||= (await projectCapabilities()).head || (await projectCapabilities()).git?.head;
        if (!base) throw Error("Choose a project with a Git commit.");
        const latest = await hostOptions.workingFiles(base);
        if (!changes.isConnected) return;
        criteria.textContent = (build ? "Build starting commit " : "Commit ") + base.slice(0, 8) + " → Working tree";
        const next = JSON.stringify(latest);
        if (next !== signature) {
          signature = next;
          rows = latest;
          if (!rows.some(file => file.path === selectedChangedFile)) selectedChangedFile = rows[0]?.path || "";
          drawFiles();
        }
        if (force) patchKey = undefined;
        const file = rows.find(row => row.path === selectedChangedFile);
        if (file) await showDiff(file);
        else diff.replaceChildren(element("p", "panel-body", "File diffs will appear here."));
      } catch (error) { criteria.textContent = error.message; }
      finally {
        loading = refreshButton.disabled = false;
        if (changes.isConnected && ["working", "cancelling"].includes(build?.status)) timer = setTimeout(refresh, 5000);
      }
    }
    queueMicrotask(refresh);
    return changes;
  }
  function buildPanel() {
    const result = element("div", "design-stack");
    if (embedded) {
      result.classList.add("plan-build-section");
      result.tabIndex = -1;
    }
    const build = state.builds.at(-1);
    if (build) {
      const attempt = build.attempts.at(-1);
      const labels = {ready: "Ready to continue", working: "Running", cancelling: "Cancelling",
        cancelled: "Cancelled", failed: "Needs attention", question: "Waiting for an answer",
        review: "Waiting for Branch Review", closed: "Complete", retired: "Retired"};
      const controls = element("div", "actions");
      const latestReview = build.groups.findLastIndex(group => group.sha && group.reviews.at(-1)?.sha === group.sha);
      const showContinueByReview = latestReview >= 0 && latestReview !== build.index &&
        build.groups[latestReview].slices.includes(attempt?.slice);
      const continueBuild = build.status === "ready" ? button(embedded ? "Start repair" : "Continue build", () =>
        change("continue", {build: build.id}, {wait: embedded ? "Starting repair…" : "Starting the next slice…"}), "button primary") : null;
      if (continueBuild && !showContinueByReview) controls.append(continueBuild);
      if (["failed", "cancelled"].includes(build.status) && !state.restartRequired && !state.resumeBlocker) controls.append(button("Resume run", () =>
        change("continue", {build: build.id}, {wait: "Resuming the run…"}), "button primary"));
      if (["working", "cancelling"].includes(build.status)) {
        const cancel = button("Cancel run", () => change("cancel", {build: build.id},
          {wait: "Cancelling the run…", done: "Cancellation requested."}));
        const reconnect = button("Reconnect run", () => change("reconnect", {build: build.id}, {wait: "Checking the run…"}));
        const ownership = element("small", "design-status");
        cancel.hidden = build.status === "cancelling";
        controls.append(cancel, reconnect, ownership);
        runControls = next => {
          const running = next.active_task?.id === attempt?.task && next.coordinator_running;
          const ownsRun = next.jobs.some(job => job.id === attempt?.job &&
            ["created", "starting", "running", "cancelling"].includes(job.state));
          cancel.hidden = !ownsRun || build.status === "cancelling";
          reconnect.hidden = ownsRun || running;
          ownership.textContent = running && !ownsRun ? "This run is active in another Workbench panel." : "";
        };
      }
      if (attempt?.task) controls.append(button("Show log", () =>
        showDesignLog(attempt.task, ["working", "cancelling"].includes(build.status))));
      if (!["working", "cancelling", "closed", "retired"].includes(build.status)) {
        controls.append(button(state.restartRequired ? "Retire failed run" : "Retire build", async () => {
          if (await change("retire", {build: build.id}) && state.builds.at(-1)?.status === "retired") {
            const start = body.querySelector('[data-design-focus="plan-approve"]');
            start?.focus();
          }
        }));
      }
      const headingText = element("strong", "", labels[build.status] || build.status);
      const info = box("Current build", element("p", "design-build-status", headingText, " · Revision " + build.revision), controls);
      if (state.restartRequired) {
        info.append(element("p", "evidence-warning",
          "The branch changed after this run started. Retire this run, then start a new build from the current commit."));
        if (build.error) info.append(element("details", "", element("summary", "", "Previous attempt error"),
          element("p", "", build.error)));
      } else if (state.resumeBlocker) {
        info.append(element("p", "evidence-warning", state.resumeBlocker));
        if (build.error) info.append(element("details", "", element("summary", "", "Previous attempt error"),
          element("p", "", build.error)));
      } else if (build.error) info.append(element("p", "evidence-warning",
        build.error === "Enter an implementation method."
          ? "The planner’s implementation steps could not be read. Select Resume run to retry planning."
          : build.error));
      for (const [i, group] of build.groups.entries()) {
        if (group.sha && (i === latestReview || (build.status === "review" && i === build.index))) {
          info.append(embedded && build.mode === "task"
            ? taskReview(build, group, i)
            : review(build, group, i, i === latestReview && showContinueByReview ? continueBuild : null));
        } else if (group.sha && group.reviews.at(-1)?.sha === group.sha) {
          const archived = element("details", "", element("summary", "", "Review group " + (i + 1) + " · " + group.sha.slice(0, 8)));
          archived.addEventListener("toggle", () => {
            if (archived.open && archived.childElementCount === 1) archived.append(review(build, group, i));
          });
          info.append(archived);
        }
        for (const finding of group.findings) info.append(element("p", "", "Finding · " + finding.text));
      }
      result.append(info);
      if (canShowChanges) controls.append(button("View changes", () => openTab("Changes")));
    }
    if (!embedded && (!build || ["closed", "retired"].includes(build.status))) {
      const targets = [["plan", "Whole approved plan"]];
      for (const m of state.roadmap) targets.push(["milestone/" + m.id, "Milestone · " + m.title],
        ...m.slices.map(s => ["slice/" + s.id, "Slice · " + s.title]));
      if (!targets.some(([key]) => key === launchForm.scope)) launchForm.scope = "plan";
      const scope = select(launchForm.scope, targets, value => { launchForm.scope = value; return true; });
      scope.dataset.designFocus = "scope";
      const frequency = select(launchForm.frequency, [["slice", "Each slice"], ["milestone", "Each milestone"],
        ["plan", "End of selection"]], value => { launchForm.frequency = value; return true; });
      frequency.dataset.designFocus = "frequency";
      const steps = element("details", "steps", element("summary", "", "Build steps and repair routes"));
      for (const role of WorkbenchProfile.roles) {
        const stage = active().stages[role.id];
        if (!stage.enabled) continue;
        const row = element("details", "", element("summary", "", role.name + " · " + stage.provider),
          element("p", "", stage.instructions));
        if (role.kind === "Audit") row.append(element("p", "", "Finding → " + routeLabels[stage.route] +
          ". Requirements finding → " + routeLabels[role.id === "planReview" ? stage.route : stage.requirementsRoute] +
          ". Return limit " + stage.limit + "."));
        steps.append(row);
      }
      steps.append(element("p", "", embedded
        ? "Review the verified commit in the live app before you push."
        : "Workbench commits verified changes locally. Review each group before continuing."));
      const agreement = element("details", "", element("summary", "", "Build agreement"));
      const questions = projectState.questions.filter(q => q.required);
      agreement.open = launchForm.agreementOpen;
      agreement.addEventListener("toggle", () => { launchForm.agreementOpen = agreement.open; });
      for (const q of questions) {
        const choice = select(launchForm.decisions[q.id] || "", [["", "Select an answer"], ...q.options.map(v => [v, q.option_details?.find(option => option.id === v)?.label || v])],
          v => { launchForm.decisions[q.id] = v; updateLaunch(); return true; });
        choice.dataset.designFocus = "answer-" + q.id;
        agreement.append(field(q.text, choice));
      }
      const reasons = element("p", "design-status");
      const readinessList = element("ul", "design-readiness-list");
      const readinessStatus = element("p", "design-status");
      const refreshReadiness = button("Refresh readiness", () => checkReadiness());
      const openQuality = button("Open Quality", () => goQuality("checks"));
      const prepare = button("Prepare project", async () => {
        if (byId("apply-profile").textContent === "Apply changes") {
          notify("Apply profile changes in Configure → Stage designer before preparing the project.");
          return;
        }
        prepare.disabled = true;
        try {
          await api("prepare", {});
          const profile = await api("profile");
          data = WorkbenchProfile.validate(WorkbenchProfile.resolve(profile, projectState.config, presetDocuments, modelCatalog));
          projectState.profile_applied = true;
          await checkReadiness();
        } catch (error) { readinessStatus.textContent = error.message; }
        finally { prepare.disabled = false; }
      });
      const launch = button("Start build", async () => {
        const [kind, key] = scope.value.split("/");
        const target = embedded ? {} : {scope: kind, key, frequency: frequency.value};
        launch.disabled = true;
        try {
          if (!stateProfileApplied() || byId("apply-profile").textContent === "Apply changes") await saveWorkflowProfile();
          await change("build", {...target, stages: active().stages, decisions: launchForm.decisions},
            {wait: "Starting build…", done: "Build started.", onError: error => { readinessStatus.textContent = error.message; }});
        } catch (error) { readinessStatus.textContent = error.message; }
        finally { updateLaunch(); }
      }, "button primary");
      function updateLaunch() {
        const agreementMissing = questions.some(q => !launchForm.decisions[q.id]);
        const blocker = localDraft.plan ? "Save or discard your local plan draft." :
          agreementMissing ? "Complete the build agreement." : "";
        launch.disabled = !readiness || readiness.items.some(item =>
          item.status === "blocked" && !["profile", "review"].includes(item.id)) || Boolean(blocker);
        reasons.textContent = blocker;
      }
      function showReadiness() {
        readinessList.replaceChildren(...(readiness?.items || []).map(item => {
          const row = element("li", "", element("strong", "", item.status === "ready" ? "Ready" : "Blocked"),
            element("span", "", item.id === "profile" && item.status === "blocked"
              ? "Start build prepares the selected workflow." : item.message));
          if (item.id === "profile" && item.status === "blocked") row.firstElementChild.textContent = "On start";
          row.dataset.status = item.status;
          return row;
        }));
        prepare.hidden = !readiness?.items?.some(item => item.id === "checks" && item.status === "blocked");
        updateLaunch();
      }
      async function checkReadiness() {
        if (!readinessList.isConnected || refreshReadiness.disabled) return;
        refreshReadiness.disabled = true;
        readinessStatus.textContent = "Checking readiness…";
        try {
          const result = await api("design/readiness");
          if (!readinessList.isConnected) return;
          readiness = result;
          readinessStatus.textContent = "";
          showReadiness();
          guideNext();
        } catch (error) {
          readiness = null;
          readinessStatus.textContent = error.message;
          showReadiness();
        } finally { refreshReadiness.disabled = false; }
      }
      showReadiness();
      queueMicrotask(checkReadiness);
      result.append(box("Build readiness", readinessStatus, readinessList,
        element("div", "actions", prepare, openQuality, refreshReadiness)),
        box("Start a build", ...(embedded ? [] : [field("Build scope", scope), field("Review frequency", frequency)]),
          steps, agreement, reasons, launch));
    }
    const branch = input(settings.branch ?? state.branch, "Project branch", value => { settings.branch = value; });
    branch.dataset.designFocus = "branch";
    const detectedBranch = element("div");
    projectCapabilities().then(capabilities => {
      const local = capabilities.git.refs.filter(row => row.ref?.startsWith("refs/heads/"));
      if (!detectedBranch.isConnected || !local.length) return;
      const picker = select(local.some(row => row.name === branch.value) ? branch.value : "",
        [["", "Enter a branch manually"], ...local.map(row => [row.name, row.name])], name => {
          if (name) settings.branch = branch.value = name;
          return true;
        });
      detectedBranch.append(field("Local branch", picker));
    }).catch(() => {});
    const host = input(settings.host ?? (state.reviewHost || (projectState.host_links || [])
      .find(item => item.name.toLowerCase() === "branch review")?.url || ""), "Branch Review address", value => { settings.host = value; });
    host.dataset.designFocus = "review-host";
    const buildSettings = box("Build settings", detectedBranch, field("Git branch", branch),
      ...(embedded ? [] : [field("Branch Review address", host)]),
      button("Save build settings", () => change("settings", {branch: branch.value, preview: state.preview,
        ...(embedded ? {} : {reviewHost: host.value.trim()})})));
    if (build) result.append(button(embedded ? "Show attempts" : "Show slice attempts", () => showDialog("Build attempts", designHistory())));
    result.append(progressPanel(null, syncProgress));
    result.append(embedded ? element("details", "", element("summary", "", "Build settings"), buildSettings) : buildSettings);
    return result;
  }
  function openTab(name) {
    tab = name;
    layoutSetting("tab", tab);
    draw();
    projectConversation?.context();
    tabs.querySelector('[data-design-tab="' + name + '"]')?.focus({preventScroll: true});
    refreshLive();
  }
  function goQuality(section) {
    const item = panelRoot.querySelector('[data-view="quality"]');
    item?.click();
    item?.focus({preventScroll: true});
    panelRoot.dispatchEvent(new CustomEvent("workbench-quality-focus", {detail: {section}}));
  }
  function goBuild(focus) {
    if (embedded) {
      if (tab !== "Plan") openTab("Plan");
      const section = body.querySelector(".plan-build-section");
      const target = focus && section?.querySelector('[data-design-focus="' + focus + '"]');
      if (target) {
        const settings = target.closest("details");
        if (settings) settings.open = true;
        target.focus();
      } else {
        section?.focus({preventScroll: true});
        section?.scrollIntoView({block: "start"});
      }
      return;
    }
    openTab("Build");
    if (focus) body.querySelector('[data-design-focus="' + focus + '"]')?.focus();
  }
  function guideNext() {
    const build = state.builds.at(-1);
    const activeBuild = build && !["closed", "retired"].includes(build.status);
    const focus = name => () => {
      openTab("Plan");
      const field = body.querySelector('[data-design-focus="' + name + '"]');
      (field && !field.disabled ? field : body.querySelector('[data-design-focus="plan"]'))?.focus();
    };
    const problem = readiness?.items.find(item => item.status === "blocked" && item.id !== "profile");
    const actions = {
      plan: ["Review the plan", focus("plan")],
      checks: ["Configure project checks", () => goQuality("checks")],
      branch: ["Choose a build branch", () => goBuild("branch")],
      review: ["Connect Branch Review", () => goBuild("review-host")],
      native: ["Open the active run", () => openView("live")]
    };
    let next;
    if (activeBuild) {
      const resumeLabel = state.restartRequired || state.resumeBlocker ? "View the stopped build" : "Resume the run";
      const label = {ready: "Continue the build", review: "Review checked work", failed: resumeLabel,
        cancelled: resumeLabel, question: "Answer the build question"}[build.status] || "View the current build";
      next = [label, () => goBuild()];
    } else if (state.question || state.plannerRetry) next = ["Resolve the planning decision", () => projectConversation.open()];
    else if (localDraft.plan) next = ["Save the local draft", focus("plan-save")];
    else if (!state.plan.trim()) next = ["Draft a plan", () => projectConversation.open()];
    else if (state.approved !== state.revision && !embedded) next = ["Approve the saved plan", focus("plan-approve")];
    else if (tab === "Plan" && embedded && !problem) {
      nextAction.replaceChildren();
      return;
    }
    else if (problem) next = actions[problem.id] || ["Review build readiness", () => goBuild()];
    else next = [readiness?.ready ? "Set up the build" : "Check build readiness", () => goBuild()];
    nextAction.replaceChildren(button(next[0], next[1], "button primary"));
    if (problem && !activeBuild && state.approved === state.revision) nextAction.append(element("p", "", problem.message));
    if (!activeBuild && tab === "Plan" && state.approved === state.revision && !readiness) {
      const key = JSON.stringify([state.revision, state.branch, state.reviewHost]);
      if (readinessKey === key) return;
      readinessKey = key;
      setTimeout(async () => {
        if (!panel.isConnected || tab !== "Plan" || readinessKey !== key) return;
        try {
          const next = await api("design/readiness");
          if (readinessKey === key && panel.isConnected) { readiness = next; guideNext(); }
        } catch {}
      }, 500);
    }
  }
  function draw() {
    const conversationKey = designDraftKey(state);
    if (draftKey !== conversationKey) {
      draftKey = conversationKey;
      localDraft = designDraftFor(draftKey);
      selectedAsset = undefined;
      editPlan = false;
      readiness = readinessKey = undefined;
      planStartStatus = "";
    }
    stageChanged(tab.toLowerCase());
    if (localDraft.plan && !draftDiffers(localDraft.plan)) clearPlanDraft();
    const focused = activeElement();
    const focus = body.contains(focused) && focused;
    const focusKey = focus && (focus.dataset.designFocus || focus.dataset.roadmapId);
    const selection = focusKey && Number.isInteger(focus.selectionStart) ? [focus.selectionStart, focus.selectionEnd] : null;
    runControls = null;
    tabs.replaceChildren(...names.map(name => {
      const node = button(name, () => openTab(name));
      node.dataset.designTab = name;
      node.setAttribute("aria-pressed", String(name === tab));
      return node;
    }));
    const layout = layoutSetting("panes") || "beside";
    const planEditor = tab === "Plan" ? editor() : null;
    if (planEditor) {
      const nextLayout = layout === "beside" ? "stack" : "beside";
      const label = nextLayout === "stack" ? "Stack panes" : "Show panes side by side";
      const toggle = button("", () => { layoutSetting("panes", nextLayout); draw(); }, "button plan-layout-toggle");
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
      toggle.dataset.designFocus = "pane-layout";
      const icon = element("span", "plan-layout-icon");
      icon.dataset.layout = nextLayout;
      icon.setAttribute("aria-hidden", "true");
      toggle.append(icon);
      planEditor.querySelector(".panel-head")?.append(toggle);
    }
    if (tab === "Plan" && embedded) {
      const columns = body.querySelector(":scope > [data-plan-columns]") ||
        element("div", "", preview(true), element("div"));
      columns.dataset.planColumns = "";
      columns.className = layout === "beside" ? "design-columns" : "design-stack";
      columns.lastElementChild.replaceChildren(planEditor);
      const progress = buildPanel();
      if (columns.parentNode === body) body.lastElementChild.replaceWith(progress);
      else body.replaceChildren(columns, progress);
    } else {
      if (tab !== "Preview") projectConversation.setPreview?.(null);
      body.replaceChildren(tab === "Plan" ? element("div","design-stack",
        element("div", layout === "beside" ? "design-columns" : "design-stack", conversationActions(), planEditor),
        progressPanel(() => openTab("Build"), syncProgress)) :
        tab === "Mockups" ? mockups() : tab === "Changes" ? changedFilesPanel() : tab === "Preview" ? preview() : buildPanel());
    }
    guideNext();
    liveDecision.hidden = !["Plan", "Build"].includes(tab) || !liveDecision.childElementCount;
    if (focusKey) {
      const replacement = body.querySelector('[data-design-focus="' + CSS.escape(focusKey) + '"], [data-roadmap-id="' + CSS.escape(focusKey) + '"]');
      replacement?.focus({preventScroll: true});
      if (replacement?.setSelectionRange && selection) replacement.setSelectionRange(...selection);
    }
  }
  function showLiveDecision(task) {
    if (embedded) projectConversation?.buildDecision(task);
    const key = JSON.stringify([task?.id, task?.question_id, task?.question, task?.suggestions, task?.question_error]);
    if (key !== decisionKey) {
      liveDecision.replaceChildren();
      const answer = async message => {
        try {
          await api("chat", task.question ? {message, task: task.id, question: task.question, question_id: task.question_id} : {message});
          showLiveDecision(null);
          await refreshLive();
        } catch (error) { status.textContent = error.message; }
      };
      if (embedded && (task?.question || task?.question_error)) liveDecision.append(box("Build decision",
        element("p", "", task.question ? "The build is waiting for your answer." : "The planner needs to retry its suggested answers."),
        button("Open Project conversation", () => projectConversation.open(), "button primary")));
      if (!embedded && task?.question) liveDecision.append(box("Build decision", planningAnswer(task.question, task.suggestions, answer)));
      if (!embedded && task?.question_error) liveDecision.append(box("Build decision", element("p", "", task.question_error),
        button("Retry suggestions", () => answer("/run"))));
      decisionKey = key;
    }
    liveDecision.hidden = !["Plan", "Build"].includes(tab) || !liveDecision.childElementCount;
  }
  async function refreshLive() {
    if (!panel.isConnected || document.hidden || refreshing || !["Plan", "Build"].includes(tab)) return;
    const build = state?.builds.at(-1);
    if (!build || !["working", "question", "cancelling"].includes(build.status)) {
      showLiveDecision(null);
      return;
    }
    refreshing = true;
    try {
      const next = await api("live");
      const attempt = state.builds.at(-1)?.attempts.at(-1);
      const task = next.active_task;
      if (panel.isConnected) {
        runControls?.(next);
        showLiveDecision(task?.status === "active" && task.id === attempt?.task ? task : null);
      }
    } catch (error) { status.textContent = error.message; }
    finally { refreshing = false; }
  }
  async function syncProgress(progress) {
    if (!panel.isConnected || document.hidden || busy || !["Plan", "Build"].includes(tab)) return;
    const recorded = progress.buildStamp;
    const stamp = JSON.stringify(recorded);
    if (buildStamp === undefined && recorded?.revision === state.revision &&
        recorded.status === (state.builds.at(-1)?.status ?? null)) buildStamp = stamp;
    const old = state;
    if (stamp !== buildStamp) {
      try {
        const next = await api("design");
        if (!busy && state === old && panel.isConnected) {
          buildStamp = stamp;
          state = next;
          readiness = null;
          redraw();
          projectConversation?.update(state);
        }
      } catch (error) { status.textContent = error.message; }
    }
    await refreshLive();
  }
  if (state) {
    draw();
    const task = projectState.active_task;
    const attempt = state.builds.at(-1)?.attempts.at(-1);
    showLiveDecision(task?.status === "active" && task.id === attempt?.task ? task : null);
  }
  if (!initialState) queueMicrotask(async () => {
    try {
      state = await api("design");
      redraw();
      projectConversation?.update(state);
      panel.dispatchEvent(new Event("workbench-design-ready"));
    } catch (error) { status.textContent = error.message; }
  });
  if (projectConversation) {
    projectConversation.design = next => { state = next; redraw(); };
    projectConversation.repair = async ({build, sha, reviewId, findingIds}) => {
      if (!await change("finding", {build, sha, reviewId, findingIds}, {wait: "Returning findings to the build…"})) {
        throw Error(status.textContent);
      }
      goBuild();
      if (!await change("continue", {build}, {wait: "Starting repair…"})) throw Error(status.textContent);
    };
    projectConversation.goToDesign = (next, focus) => {
      if (embedded && next === "Build") { goBuild(focus); return; }
      if (embedded && next === "Preview") {
        next = "Plan";
        focus ||= "preview";
      }
      if (next === "Plan" && focus === "plan") editPlan = true;
      if (next === "Plan" && focus === "plan-reading") editPlan = false;
      tab = next;
      layoutSetting("tab", tab);
      if (state) draw();
      const focusWhenReady = () => {
        if (!focus) return;
        const field = body.querySelector('[data-design-focus="' + CSS.escape(focus) + '"]');
        const details = field?.closest("details");
        if (details) details.open = true;
        field?.focus();
      };
      if (state) focusWhenReady();
      else panel.addEventListener("workbench-design-ready", focusWhenReady, {once: true});
    };
    projectConversation.settingsProposal = fields => {
      if (Object.hasOwn(fields, "preview")) previewDraft.address = fields.preview;
      if (Object.hasOwn(fields, "branch")) settings.branch = fields.branch;
      redraw();
    };
  }
  return panel;
}

