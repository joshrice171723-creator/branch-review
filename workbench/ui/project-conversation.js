"use strict";

function buildEvidenceAnswer(task, submit) {
  const note = element("textarea");
  note.maxLength = 8000;
  note.rows = 4;
  const send = button("Send evidence and retry audit", async () => {
    if (send.disabled) return;
    send.disabled = true;
    try { await submit(note.value.trim()); }
    finally { send.disabled = !note.value.trim(); }
  }, "button primary");
  send.disabled = true;
  note.addEventListener("input", () => { send.disabled = !note.value.trim(); });
  return element("div", "design-stack", formatEvidenceText(task.question),
    element("p", "", "Include the check command or report path, the result, and any observations the auditor requested."),
    field("Evidence for this audit", note), send);
}

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
  const buildDecisionCard = byId("project-conversation-build-decision");
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
  const archiveStatus = byId("archive-project-conversation-status");
  let archiveFeedback = "";
  const acceptedKey = "workbench.conversation.accepted:" + projectState.project.path;
  let accepted = {};
  try { accepted = JSON.parse(localStorage.getItem(acceptedKey)) || {}; } catch {}
  let state = initial, busy = false, outgoing, previousOpener, quality = {}, slice = {}, review = {}, lastQuestion, fingerprint;
  let buildQuestionKey = "";
  let decisionLabel = "", buildAttention;
  const seenAttentionKey = "workbench.build.attention:" + projectState.project.path;
  let seenAttention;
  try { seenAttention = localStorage.getItem(seenAttentionKey); } catch {}
  const visible = () => !drawer.hidden;
  composer.value = stored.message;

  function syncLauncher() {
    launch.textContent = "Project conversation" +
      (decisionLabel ? " · " + decisionLabel : buildAttention ? " · Build needs attention" : "");
    launch.toggleAttribute("data-build-attention", Boolean(buildAttention));
  }
  function markAttentionSeen(message) {
    seenAttention = message.id;
    try { localStorage.setItem(seenAttentionKey, seenAttention); } catch {}
  }
  function showBuildAttention(message) {
    const changed = buildAttention?.id !== message?.id;
    buildAttention = message;
    syncLauncher();
    if (!message || !state) return;
    if (!state.messages.some(row => row.id === message.id)) state.messages.push(message);
    if (changed && visible()) {
      markAttentionSeen(message);
      renderMessages();
      messages.scrollTop = messages.scrollHeight;
    } else if (changed && message.id !== seenAttention) {
      notify("Build needs attention. Open Project conversation.");
    }
  }

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
    planner.disabled = busy || Boolean(state?.question || state?.plannerRetry);
    const building = ["working", "cancelling"].includes(state?.builds?.at(-1)?.status);
    archive.disabled = busy || building;
    archiveStatus.textContent = building ? "Wait for the build to stop before archiving." : archiveFeedback;
    archiveStatus.hidden = !archiveStatus.textContent;
  }
  function showBuildDecision(task) {
    const waiting = task?.question || task?.question_error;
    const signature = waiting ? JSON.stringify([task.id, task.question_id, task.question, task.suggestions, task.question_error]) : "";
    if (signature === buildQuestionKey) return;
    buildQuestionKey = signature;
    const evidence = task?.decision_kind === "evidence";
    decisionLabel = evidence ? "Evidence needed" : waiting ? "Reply needed" : "";
    syncLauncher();
    buildDecisionCard.replaceChildren();
    buildDecisionCard.hidden = !waiting;
    if (!waiting) return;
    const feedback = element("p", "", "");
    feedback.setAttribute("role", "status");
    const answer = async message => {
      feedback.textContent = evidence ? "Sending evidence to the audit…" : "Sending your answer…";
      try {
        await api("chat", task.question ? {message, task: task.id, question: task.question,
          question_id: task.question_id} : {message});
        showBuildDecision(null);
        const next = await api("design");
        update(next, true);
      } catch (error) { feedback.textContent = error.message; }
    };
    buildDecisionCard.append(element("h3", "", evidence ? "Audit needs evidence" : "Build needs your answer"),
      evidence ? buildEvidenceAnswer(task, answer) :
        task.question ? planningAnswer(task.question, task.suggestions, answer) :
        element("div", "", element("p", "", task.question_error),
          button("Retry suggestions", () => answer("/run"))), feedback);
  }
  async function followBuildQuestions() {
    if (signal.aborted) return;
    try {
      const build = state?.builds.at(-1);
      const offPlan = view !== "workflow" || (layoutSetting("tab") || "Plan") !== "Plan";
      if (!document.hidden) {
        const active = ["working", "question", "cancelling"].includes(build?.status);
        const [attention, live] = await Promise.all([api("design/attention"),
          offPlan && (visible() || active) ? api("live").catch(() => null) : null]);
        if (signal.aborted) return;
        showBuildAttention(attention);
        if (live) showBuildDecision(live.active_task?.status === "active" ? live.active_task : null);
      }
    } catch {}
    finally { setTimeout(followBuildQuestions, 4000); }
  }
  setTimeout(followBuildQuestions, 4000);
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
    if (buildAttention) markAttentionSeen(buildAttention);
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
  archive.onclick = async () => {
    if (busy) return;
    archiveFeedback = "Archiving conversation…";
    busy = send.disabled = true;
    showContext();
    try {
      const next = await api("design/archive", {revision: state.revision,
        draft: {title: stored.plan?.title, plan: stored.plan?.plan, message: composer.value}});
      Object.assign(stored, {message: "", mockupMessage: "", plan: null, baseRevision: null, slice: ""});
      persistDesignDraft(key, stored);
      showBuildDecision(null);
      update(next, true);
      archiveFeedback = "Conversation archived in History.";
      composer.focus();
    } catch (error) {
      archiveFeedback = error.message;
    } finally {
      busy = send.disabled = false;
      showContext();
    }
  };
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
  byId("conversation-build-status").onclick = () => submit("guide", {message: "Build status", context: context()});
  planner.onclick = () => {
    const message = composer.value;
    const latest = state.messages.findLast(item => item.author === "agent" && !item.asset && !item.decision && !item.coordinator);
    const plan = planFromReply(latest);
    if (!message.trim() && !changeScreenshot && plan) {
      edit(plan, true);
      return;
    }
    if (!message.trim() && !state.messages.length) { composer.focus(); return; }
    submit("guide", {message: message.trim() || "Draft a plan from this conversation.",
      context: context(), preparePlan: true, ...(changeScreenshot && {changeScreenshot})}, message);
  };
  function planFromReply(item) {
    if (item?.proposal?.kind === "plan") return item.proposal;
    if (!embedded || !item || item.proposal ||
        !/^\s*(?:#{1,6}\s+|\*\*)?(?:Plan|Acceptance criteria)\b/im.test(item.text)) return null;
    const title = state.title || titleFromPlan(item.text);
    return {kind: "plan", mode: "task", title, plan: item.text, revision: state.revision};
  }
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
    const current = state.builds?.at(-1);
    const message = current?.status === "failed" && state.messages.find(row => row.id === current.attention?.id);
    showBuildAttention(message || null);
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
      if (body.preparePlan) {
        const plan = planFromReply(next.messages.at(-1));
        if (plan) edit(plan, true);
      }
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
  function edit(proposal, review = false) {
    if (proposal.kind === "quality") {
      route("quality");
      panelRoot.dispatchEvent(new CustomEvent("workbench-quality-proposal", {detail: proposal}));
      return;
    }
    if (proposal.kind === "plan") {
      const draft = embedded || proposal.mode === "task"
        ? {title: proposal.title?.trim() || titleFromPlan(proposal.plan), plan: proposal.plan} :
        {plan: proposal.plan, roadmap: structuredClone(proposal.roadmap)};
      const openDraft = () => {
        stored.plan = draft;
        stored.baseRevision = proposal.revision;
        persistDesignDraft(key, stored);
        status.textContent = "";
        route("workflow", "Plan", review ? "plan-reading" : "plan");
      };
      if (stored.plan && JSON.stringify(stored.plan) !== JSON.stringify(draft)) {
        const keep = button("Keep current draft", () => dialog.close());
        showDialog("Replace unsaved draft?",
          element("p", "", "Use the plan from this conversation in place of your unsaved edits."),
          ...(draft.title ? [element("p", "", element("strong", "", draft.title))] : []),
          element("details", "", element("summary", "", "Preview incoming plan"), element("pre", "", draft.plan)),
          element("div", "actions", keep,
            button("Replace draft", () => { dialog.close(); openDraft(); }, "button primary")));
        keep.focus();
      } else openDraft();
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
      proposal.kind === "plan" ? null : button("Apply",
        () => perform("Applying proposal…", () => revise(item, false)), "button primary");
    return element("div", "conversation-proposal", element("strong", "", proposal.title),
      element("details", "", element("summary", "", "Proposed changes"), element("pre", "", preview)),
      element("div", "actions", ...(action ? [action] : []), button("Edit", () => edit(proposal))));
  }
  function renderMessages() {
    if (!state) return;
    const next = JSON.stringify([state.messages, state.question?.id, accepted, outgoing]);
    if (fingerprint !== next) {
      fingerprint = next;
      const scrollEnd = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 28;
      messages.replaceChildren(...state.messages.filter(item => !item.decision || item.decision !== state.question?.id)
      .map(item => {
        const row = element("li", item.author, element("small", "", item.author === "user" ? "You" : "Workbench coordinator"),
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
  return {open, update, buildDecision: showBuildDecision, current: () => state, context: showContext,
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
