"use strict";

let projectConversation;

function connectProjectConversation(initial) {
  const drawer = byId("project-conversation");
  const launch = byId("open-project-conversation");
  const headingContext = byId("project-conversation-context");
  const messages = byId("project-conversation-messages");
  const pending = byId("project-conversation-pending");
  const composer = byId("project-conversation-message");
  const send = byId("send-project-conversation");
  const status = byId("project-conversation-status");
  const mockup = byId("conversation-mockup");
  const mockupSource = byId("conversation-mockup-source");
  const mockupTarget = byId("mockup-target");
  const referenceImage = byId("mockup-reference-image");
  const referenceFile = byId("mockup-reference-file");
  const referenceStatus = byId("mockup-reference-status");
  const capture = byId("capture-mockup-reference");
  const previewCleanup = byId("preview-plan-cleanup");
  let reference;
  const planner = byId("update-plan-with-conversation");
  const models = Object.entries(modelCatalog).filter(([, catalog]) => catalog?.models)
    .flatMap(([provider, catalog]) => [["" + provider + ":", provider + " default"],
      ...catalog.models.map(model => [provider + ":" + model, model])]);
  const model = select("", [["", "Workflow model"], ...models], () => true);
  const effort = select("", [["", "Workflow level"], ...WorkbenchProfile.efforts.map(level =>
    [level, level[0].toUpperCase() + level.slice(1)])], () => true);
  byId("conversation-model-controls").append(field("Model", model), field("Thinking level", effort));
  if (embedded) mockupSource.querySelector('option[value="slice"]').remove();
  const key = "workbench.design.draft.v1:" + projectState.project.path;
  const stored = designDraftFor(key);
  const acceptedKey = "workbench.conversation.accepted:" + projectState.project.path;
  let accepted = {};
  try { accepted = JSON.parse(localStorage.getItem(acceptedKey)) || {}; } catch {}
  let state = initial, busy = false, outgoing, previousOpener, quality = {}, slice = {}, review = {}, lastQuestion, fingerprint;
  const visible = () => !drawer.hidden;
  composer.value = stored.message;

  function context() {
    if (Object.keys(review).length) return {view, ...review};
    if (view === "quality") return {view, ...quality};
    if (view === "stages") return {view, section: "stages", id: selected, label: roleById(selected)?.name};
    if (view === "workflow") return {view, tab: layoutSetting("tab") || "Plan", ...slice};
    return {view};
  }
  function showContext() {
    const current = context();
    headingContext.textContent = [projectState.project.label, current.kind === "branch-review" ? "Review" : titles[current.view][0],
      current.tab || current.section, current.label || current.scenarioTitle].filter(Boolean).join(" / ");
    mockup.hidden = current.view !== "workflow" || Boolean(embedded && current.kind);
    planner.hidden = current.view !== "workflow" || current.tab !== "Plan" || !!current.kind;
    planner.disabled = busy || Boolean(state?.question || state?.plannerRetry);
  }
  function editComposer(value) {
    composer.value = stored.message = value;
    persistDesignDraft(key, stored);
  }
  function open(next) {
    if (next !== undefined) {
      review = next?.kind === "branch-review" ? Object.fromEntries(
        ["kind", "reviewId", "commit", "ref", "scenarioId", "scenarioTitle", "route"]
          .filter(name => typeof next[name] === "string").map(name => [name, next[name].slice(0, 400)])) : {};
    }
    if (!visible()) previousOpener = activeElement() || document.activeElement;
    drawer.hidden = false;
    launch.setAttribute("aria-expanded", "true");
    showContext();
    renderMessages();
    composer.focus();
  }
  function close(restore = true) {
    drawer.hidden = true;
    launch.setAttribute("aria-expanded", "false");
    if (restore) (previousOpener?.isConnected ? previousOpener : launch).focus();
  }
  launch.onclick = () => visible() ? close() : open();
  launch.hidden = false;
  byId("close-project-conversation").onclick = () => close();
  drawer.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  composer.addEventListener("input", () => editComposer(composer.value));
  panelRoot.addEventListener("workbench-quality-selection", event => {
    quality = event.detail || {};
    showContext();
  }, {signal});
  byId("project-conversation-form").onsubmit = event => {
    event.preventDefault();
    const message = composer.value;
    if (!message.trim()) return;
    submit("guide", {message, context: context()}, message);
  };
  planner.onclick = () => {
    const message = composer.value;
    if (!message.trim()) { composer.focus(); return; }
    submit("chat", {message}, message);
  };
  function setReference(source, target = mockupTarget.value) {
    if (target !== mockupTarget.value) return;
    const canvas = document.createElement("canvas");
    const width = source.videoWidth || source.width;
    const height = source.videoHeight || source.height;
    const scale = Math.min(1, 1600 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    reference = canvas.toDataURL("image/png");
    referenceImage.src = reference;
    referenceImage.hidden = false;
    referenceStatus.textContent = target + " screenshot attached.";
  }
  function updateMockupControls() {
    byId("mockup-reference-controls").hidden = mockupSource.value !== "screen";
    previewCleanup.hidden = !embedded || mockupTarget.value !== "Plan";
  }
  mockupSource.onchange = updateMockupControls;
  mockupTarget.onchange = () => {
    reference = undefined;
    referenceImage.removeAttribute("src");
    referenceImage.hidden = true;
    referenceStatus.textContent = "";
    updateMockupControls();
  };
  updateMockupControls();
  byId("upload-mockup-reference").onclick = () => referenceFile.click();
  referenceFile.onchange = async () => {
    const file = referenceFile.files[0];
    referenceFile.value = "";
    if (!file) return;
    const target = mockupTarget.value;
    try {
      if (file.size > 16_000_000) throw Error("Choose an image under 16 MB.");
      const bitmap = await createImageBitmap(file);
      try { setReference(bitmap, target); } finally { bitmap.close(); }
    } catch (error) { referenceStatus.textContent = error.message; }
  };
  capture.hidden = !navigator.mediaDevices?.getDisplayMedia;
  capture.onclick = async () => {
    const target = mockupTarget.value;
    if (context().tab !== target) {
      referenceStatus.textContent = "Open " + target + " before capturing, or upload a screenshot.";
      return;
    }
    let stream;
    capture.disabled = true;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false, preferCurrentTab: true});
      close(false);
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      setReference(video, target);
    } catch { referenceStatus.textContent = "Screen capture was unavailable. Upload a screenshot instead."; }
    finally {
      stream?.getTracks().forEach(track => track.stop());
      capture.disabled = false;
      open();
    }
  };
  previewCleanup.onclick = () => projectConversation.previewCleanup?.();
  byId("generate-conversation-mockup").onclick = () => {
    const brief = composer.value;
    const activeContext = context();
    if (mockupSource.value === "slice" && !activeContext.id) {
      status.textContent = "Select a slice on Plan.";
      return;
    }
    if (mockupSource.value === "brief" && !brief.trim()) {
      status.textContent = "Enter a mockup brief.";
      return;
    }
    if (mockupSource.value === "screen") {
      if (!reference) { referenceStatus.textContent = "Capture or upload the target screen first."; return; }
      submit("image", {message: brief.trim() || "Apply the saved plan to this screen.",
        target: mockupTarget.value, screenshot: reference, keep: byId("mockup-keep").value}, brief);
      return;
    }
    const target = mockupSource.value === "slice" ? "Slice: " + activeContext.label : "";
    submit("image", {message: [target, brief].filter(Boolean).join("\n")}, brief);
  };

  function update(next, changeDesign = false) {
    if (!next) return;
    state = next;
    showContext();
    if (visible()) renderMessages();
    if (changeDesign) projectConversation.design?.(next);
  }
  async function perform(label, action) {
    if (busy) return;
    busy = send.disabled = true;
    showContext();
    status.textContent = label;
    try {
      await action();
      status.textContent = "";
    } catch (error) { status.textContent = error.message; }
    finally { busy = send.disabled = false; showContext(); }
  }
  async function submit(action, body, submitted) {
    if (busy) return;
    const usePlanner = action === "chat" || action === "guide" || action === "answer";
    const target = active().stages.plan;
    const [provider, modelId] = model.value ? model.value.split(":") : [target.provider, target.model];
    const conversationModel = usePlanner && (model.value || effort.value)
      ? {provider, model: modelId, effort: effort.value || target.effort} : undefined;
    outgoing = body.message || undefined;
    renderMessages();
    if (outgoing) messages.scrollTop = messages.scrollHeight;
    await perform(action === "image" ? "Generating mockup…" : "Working on your message…", async () => {
      const current = await api("design");
      const mode = embedded || current.mode === "task" ? {mode: "task"} : {};
      const next = await api("design/" + action, {revision: current.revision, ...mode, ...body, conversationModel});
      if (submitted !== undefined && composer.value === submitted) editComposer("");
      outgoing = undefined;
      update(next, true);
    });
    outgoing = undefined;
    renderMessages();
  }

  function route(destination, tab, focus) {
    close(false);
    panelRoot.querySelector('[data-view="' + destination + '"]')?.click();
    if (tab) projectConversation.goToDesign?.(tab, focus);
  }
  function remember(id, snapshot) {
    if (snapshot) accepted[id] = snapshot;
    else delete accepted[id];
    try { localStorage.setItem(acceptedKey, JSON.stringify(accepted)); } catch {}
  }
  function planFields(proposal) {
    return proposal.mode === "task" ? {mode: "task", title: proposal.title, plan: proposal.plan} :
      {plan: proposal.plan, roadmap: proposal.roadmap};
  }
  async function revise(item, undo) {
    const proposal = item.proposal;
    const prior = accepted[item.id];
    if (proposal.kind === "quality") {
      if (!panelRoot.dispatchEvent(new CustomEvent("workbench-quality-write", {cancelable: true}))) {
        throw Error("Save or discard your local Quality draft first.");
      }
      const quality = await api("quality");
      const expected = undo ? prior.revision : proposal.revision;
      if (quality.draft?.revision !== expected || (quality.published?.revision ?? null) !== proposal.baseRevision) {
        throw Error("The Quality draft changed. Open Quality to review it.");
      }
      const saved = await api("quality/draft", {base_revision: proposal.baseRevision, expected_revision: expected,
        definition: undo ? proposal.before : proposal.definition});
      remember(item.id, undo ? null : {revision: saved.revision});
      if (view === "quality") qualityPage?.refresh();
    } else {
      const current = await api("design");
      const expected = undo ? prior.revision : proposal.revision;
      if (expected !== current.revision) throw Error("The saved plan changed. Open Plan to review the proposal.");
      if (proposal.kind === "plan" && stored.plan) throw Error("Save or discard your local plan draft first.");
      const isPlan = proposal.kind === "plan";
      if (!isPlan) {
        const before = undo ? proposal.fields : proposal.before;
        if (Object.keys(before).some(name => current[name] !== before[name])) {
          throw Error("The project settings changed. Open Design to review them.");
        }
      }
      const fields = isPlan ? planFields(proposal) : proposal.fields;
      const original = isPlan ? {} : {branch: current.branch, preview: current.preview};
      const guard = isPlan ? {} : {expected: {...original, ...(undo ? proposal.fields : proposal.before)}};
      const saved = await api("design/" + (isPlan ? "draft" : "settings"),
        {revision: expected, ...original, ...guard, ...(undo ? proposal.before : fields)});
      remember(item.id, undo ? null : {revision: saved.revision});
      update(saved, true);
    }
    renderMessages();
    if (!undo && proposal.kind === "plan") {
      route("workflow", "Plan", "plan-approve");
      notify("Plan saved. Review it before you start the build.");
    } else notify(undo ? "Proposal undone." : "Proposal applied.");
  }
  function edit(proposal) {
    if (proposal.kind === "quality") {
      route("quality");
      panelRoot.dispatchEvent(new CustomEvent("workbench-quality-proposal", {detail: proposal}));
      return;
    }
    if (proposal.kind === "plan") {
      if (stored.plan) { status.textContent = "Save or discard your local plan draft first."; return; }
      stored.plan = embedded || proposal.mode === "task" ? {title: proposal.title, plan: proposal.plan} :
        {plan: proposal.plan, roadmap: structuredClone(proposal.roadmap)};
      stored.baseRevision = proposal.revision;
      persistDesignDraft(key, stored);
      route("workflow", "Plan", "plan");
    } else {
      const preview = Object.hasOwn(proposal.fields, "preview");
      route("workflow", preview ? "Preview" : "Build", preview ? "preview" : "branch");
      projectConversation.settingsProposal?.(proposal.fields);
    }
  }
  function proposalCard(item) {
    const proposal = item.proposal;
    const preview = proposal.kind === "plan" ? proposal.plan :
      JSON.stringify(proposal.kind === "quality" ? proposal.definition : proposal.fields, null, 2);
    const action = accepted[item.id] ? button("Undo", () => perform("Undoing proposal…", () => revise(item, true))) :
      button(proposal.kind === "plan" ? "Save and review plan" : "Apply",
        () => perform("Applying proposal…", () => revise(item, false)), "button primary");
    return element("div", "conversation-proposal", element("strong", "", proposal.title),
      element("details", "", element("summary", "", "Proposed changes"), element("pre", "", preview)),
      element("div", "actions", action, button("Edit", () => edit(proposal))));
  }
  function renderMessages() {
    if (!state) return;
    const next = JSON.stringify([state.messages, state.question?.id, accepted, outgoing]);
    if (fingerprint !== next) {
      fingerprint = next;
      const scrollEnd = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 28;
      messages.replaceChildren(...state.messages.filter(item => !item.decision || item.decision !== state.question?.id)
      .map(item => {
        const row = element("li", item.author, element("small", "", item.author === "user" ? "You" : "Project agent"),
          element("p", "conversation-text", item.text));
        if (item.asset) row.append(assetImage(item.asset, "Generated mockup"));
        if (item.proposal) row.append(proposalCard(item));
        if (item.choices) row.append(element("div", "answer-choices", ...item.choices.map(choice =>
          button(choice, () => { editComposer(choice); composer.focus(); }))));
        return row;
      }), ...(outgoing ? [element("li", "user", element("small", "", "You · Working"),
        element("p", "conversation-text", outgoing))] : []));
      if (scrollEnd) messages.scrollTop = messages.scrollHeight;
    }
    const question = state.question;
    const identity = JSON.stringify([question?.id, question?.error, question?.suggestions, state.plannerRetry?.error]);
    if (identity !== lastQuestion) {
      lastQuestion = identity;
      const error = state.plannerRetry?.error || question?.error;
      pending.replaceChildren();
      if (error) pending.append(element("p", "evidence-warning", error),
        button("Retry planner", () => submit("retry", {})));
      else if (question) pending.append(planningAnswer(question.question, question.suggestions,
        message => submit("answer", {id: question.id, message})));
    }
  }
  const initialSlice = initial?.roadmap?.flatMap(row => row.slices.map(item => [item.id, row.title + " / " + item.title]))
    .find(row => row[0] === stored.slice);
  if (initialSlice) slice = {section: "slice", id: initialSlice[0], label: initialSlice[1]};
  return {open, update, current: () => state, context: showContext,
    openMockup() { open(); mockupTarget.focus(); },
    selectView() { review = {}; showContext(); },
    selectSlice(value) { slice = value; showContext(); }};
}
