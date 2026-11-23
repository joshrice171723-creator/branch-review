"use strict";

let projectConversation;

function conversationHistory() {
  const body = element("div", "panel-body design-stack");
  const panel = element("section", "panel", heading("Project conversations"), body);
  queueMicrotask(async () => {
    try {
      const {active, archived} = await api("design/conversations");
      body.append(element("p", "", element("strong", "", "Current · " + active.status),
        " · " + active.title + " · " + active.messageCount + " messages"));
      if (!archived.length) body.append(element("p", "", "No archived conversations."));
      for (const entry of archived) {
        const details = element("details", "attempt", element("summary", "",
          entry.title + " · " + entry.status + " · Archived"));
        const transcript = element("div", "design-stack",
          element("small", "", new Date(entry.archivedAt).toLocaleString() + " · " + entry.messageCount + " messages"));
        let loaded = false;
        details.addEventListener("toggle", async () => {
          if (!details.open || loaded) return;
          loaded = true;
          try {
            const record = await api("design/conversations?" + new URLSearchParams({id: entry.id}));
            if (record.plan) transcript.append(element("details", "", element("summary", "", "Saved plan"),
              element("pre", "", record.plan)));
            if (record.draft?.plan) transcript.append(element("details", "", element("summary", "", "Unsaved plan"),
              element("pre", "", [record.draft.title, record.draft.plan].filter(Boolean).join("\n\n"))));
            if (record.draft?.message) transcript.append(element("p", "conversation-text", "Unsent message · " + record.draft.message));
            const messages = element("ol", "conversation");
            for (const item of record.messages) {
              const row = element("li", item.author, element("small", "", item.author === "user" ? "You" : "Project agent"),
                element("p", "conversation-text", item.text));
              if (item.asset) row.append(assetImage(item.asset, "Archived mockup"));
              if (item.proposal?.plan) row.append(element("details", "", element("summary", "", "Proposed plan"),
                element("pre", "", item.proposal.plan)));
              messages.append(row);
            }
            transcript.append(messages);
          } catch (error) { transcript.append(element("p", "", error.message)); }
        });
        details.append(transcript);
        body.append(details);
      }
    } catch (error) { body.textContent = error.message; }
  });
  return panel;
}

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
  let reference, referencePage, livePreview, changeScreenshot;
  const changeAttachment = byId("change-screenshot");
  function showChangeScreenshot() {
    changeAttachment.hidden = !changeScreenshot;
    byId("change-screenshot-label").textContent = changeScreenshot ?
      "Attached project screenshot" + (changeScreenshot.page ? " · " + changeScreenshot.page : "") : "";
    showContext();
  }
  byId("remove-change-screenshot").onclick = () => { changeScreenshot = undefined; showChangeScreenshot(); };
  const planner = byId("update-plan-with-conversation");
  const models = Object.entries(modelCatalog).filter(([, catalog]) => catalog?.models)
    .flatMap(([provider, catalog]) => [["" + provider + ":", provider + " default"],
      ...catalog.models.map(model => [provider + ":" + model, model])]);
  const model = select("", [["", "Workflow model"], ...models], () => true);
  const effort = select("", [["", "Workflow level"], ...WorkbenchProfile.efforts.map(level =>
    [level, level[0].toUpperCase() + level.slice(1)])], () => true);
  byId("conversation-model-controls").append(field("Model", model), field("Thinking level", effort));
  if (embedded) mockupSource.querySelector('option[value="slice"]').remove();
  let key = designDraftKey(initial);
  let stored = designDraftFor(key);
  const archive = byId("archive-project-conversation");
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
    if (view === "workflow") return {view, tab: layoutSetting("tab") || "Plan", ...slice,
      ...(livePreview?.frame.isConnected ? {projectPage: new URL(livePreview.address).pathname} : {})};
    return {view};
  }
  function showContext() {
    const current = context();
    headingContext.textContent = [projectState.project.label, current.projectPage,
      current.kind === "branch-review" ? "Review" : titles[current.view][0],
      current.tab || current.section, current.label || current.scenarioTitle].filter(Boolean).join(" / ");
    mockup.hidden = current.view !== "workflow" || Boolean(embedded && current.kind);
    planner.hidden = current.view !== "workflow" || current.tab !== "Plan" || !!current.kind;
    planner.disabled = busy || Boolean(state?.question || state?.plannerRetry);
    const unfinished = state?.builds?.some(build => !["closed", "retired"].includes(build.status));
    archive.disabled = busy || Boolean(unfinished);
    archive.title = unfinished ? "Finish or retire the current build before archiving." : "";
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
  archive.onclick = () => perform("Archiving conversation…", async () => {
    const next = await api("design/archive", {revision: state.revision,
      draft: {title: stored.plan?.title, plan: stored.plan?.plan, message: composer.value}});
    Object.assign(stored, {message: "", mockupMessage: "", plan: null, baseRevision: null, slice: ""});
    persistDesignDraft(key, stored);
    update(next, true);
    notify("Conversation archived in History.");
    composer.focus();
  });
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
    const attachment = changeScreenshot;
    submit("guide", {message, context: context(), ...(attachment && {changeScreenshot: attachment})}, message);
  };
  planner.onclick = () => {
    const message = composer.value;
    if (!message.trim()) { composer.focus(); return; }
    if (changeScreenshot) submit("guide", {message, context: context(), changeScreenshot}, message);
    else submit("chat", {message}, message);
  };
  function setReference(source, target = mockupTarget.value, page = "") {
    if (target !== mockupTarget.value) return false;
    const canvas = document.createElement("canvas");
    const width = source.videoWidth || source.width;
    const height = source.videoHeight || source.height;
    const scale = Math.min(1, 1600 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    reference = canvas.toDataURL("image/png");
    referencePage = page;
    referenceImage.src = reference;
    referenceImage.hidden = false;
    referenceStatus.textContent = (page || target) + " screenshot attached.";
    return true;
  }
  function updateMockupControls() {
    byId("mockup-reference-controls").hidden = mockupSource.value !== "screen";
  }
  mockupSource.onchange = updateMockupControls;
  mockupTarget.onchange = () => {
    reference = undefined;
    referencePage = undefined;
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
  async function captureReference({sendToChange = false, openDrawer = true} = {}) {
    const target = mockupTarget.value;
    const project = target === "Project preview";
    const view = livePreview;
    if (project && (!view?.frame.isConnected || !globalThis.CropTarget?.fromElement)) {
      referenceStatus.textContent = "Load the project preview in Chrome, or upload a screenshot.";
      if (openDrawer) open();
      return false;
    }
    if (!project && context().tab !== target) {
      referenceStatus.textContent = "Open " + target + " before capturing, or upload a screenshot.";
      return false;
    }
    let stream;
    capture.disabled = true;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw Error("Screen capture unavailable.");
      stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false, preferCurrentTab: true});
      close(false);
      const track = stream.getVideoTracks()[0];
      if (project) {
        if (livePreview !== view || !view.frame.isConnected || !track?.cropTo) throw Error("Choose this Chrome tab.");
        await track.cropTo(await CropTarget.fromElement(view.frame));
      }
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const saved = setReference(video, target, project ? new URL(view.address).pathname : "");
      if (saved && sendToChange) {
        changeScreenshot = {image: reference, page: referencePage};
        showChangeScreenshot();
      }
      return saved;
    } catch {
      referenceStatus.textContent = "Screen capture was unavailable. Upload a screenshot instead.";
      return false;
    }
    finally {
      stream?.getTracks().forEach(track => track.stop());
      capture.disabled = false;
      if (openDrawer) open();
    }
  }
  capture.onclick = () => captureReference();
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
        target: mockupTarget.value, screenshot: reference, referencePage, keep: byId("mockup-keep").value}, brief);
      return;
    }
    const target = mockupSource.value === "slice" ? "Slice: " + activeContext.label : "";
    submit("image", {message: [target, brief].filter(Boolean).join("\n")}, brief);
  };

  function update(next, changeDesign = false) {
    if (!next) return;
    if (key !== designDraftKey(next)) {
      key = designDraftKey(next);
      stored = designDraftFor(key);
      composer.value = stored.message;
      slice = {};
      review = {};
      changeScreenshot = undefined;
      showChangeScreenshot();
      mockupTarget.onchange();
    }
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
      if (body.changeScreenshot && body.changeScreenshot === changeScreenshot) {
        changeScreenshot = undefined;
        showChangeScreenshot();
      }
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
      route("workflow", "Plan", embedded && !proposal.title ? "plan-title" : "plan");
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
      button(proposal.kind === "plan" ? "Save to Plan" : "Apply",
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
        else if (embedded && item.author === "agent" && !item.asset && !item.decision &&
            /^\s*(?:#{1,6}\s+|\*\*)?(?:Plan|Acceptance criteria)\b/im.test(item.text)) {
          row.append(button("Send to Plan", () => {
            const heading = /^#{1,6}\s+(.+)$/m.exec(item.text)?.[1]?.trim();
            const title = state.title || (heading && !/^(plan|acceptance criteria|verification)$/i.test(heading)
              ? heading.slice(0, 240) : "");
            edit({kind: "plan", mode: "task", title, plan: item.text, revision: state.revision});
          }));
        }
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
    setPreview(value) { livePreview = value; showContext(); },
    capturePreview(options) {
      mockupSource.value = "screen";
      if (mockupTarget.value !== "Project preview") {
        mockupTarget.value = "Project preview";
        mockupTarget.onchange();
      }
      updateMockupControls();
      return captureReference(options);
    },
    openMockup() { open(); mockupTarget.focus(); },
    selectView() { review = {}; showContext(); },
    selectSlice(value) { slice = value; showContext(); }};
}
