"use strict";

let projectState;
const stateProfileApplied = () => projectState?.profile_applied;
const byId = id => panelRoot.getElementById(id);
const activeElement = () => panelRoot.activeElement;
const panelBody = embedded ? panelRoot.querySelector(".workbench-surface") : document.body;
const content = byId("content");
const dialog = byId("dialog");
const dialogContent = byId("dialog-content");
const titles = {
  live: ["Live run", "Start a task, answer questions, and follow its progress."],
  history: ["History", "Inspect recorded stages and check receipts for this project."],
  workflow: ["Design", embedded ? "Plan a change, build it, and review the result." : "Plan, build, and review project slices."],
  quality: ["Quality", "Prepare checks from project routes. Review drafts and trial evidence."],
  stages: ["Stage designer", "Configure stages, agent instructions, and audit return paths."],
  documents: ["Documents", "Add guidelines and configuration files to reuse across stages."],
  rules: ["Shared rules", "Set instructions and documents for every stage in this profile."]
};
const roleById = id => WorkbenchProfile.roles.find(role => role.id === id);
const routeLabels = {plan: "Return to plan", build: "Return to builder", stop: "Stop and report"};
let data = WorkbenchProfile.initial(presetDocuments);
let view = "workflow";
let selected = "build";
let noticeTimer;
let fieldId = 0;
const callMcp = workbenchClient(panelUrl("mcp"), signal, () => projectState?.csrf_token);
let selectedRun = "";
let historyTimer;
let currentStage;

function stageChanged(stage) {
  if (stage === currentStage) return;
  currentStage = stage;
  hostOptions.onStageChange?.(stage);
}

function openReview(runId) {
  if (signal.aborted) return;
  Promise.resolve().then(() => hostOptions.onReview(runId)).catch(error => notify(error.message));
}

function reviewLink(link, runId) {
  link.onclick = event => { event.preventDefault(); openReview(runId); };
}

function notify(message) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 3800);
}

async function api(route, body) {
  const response = await fetch(panelUrl("api/" + route), body === undefined ? {cache: "no-store", signal} : {
    method: "POST", signal, headers: {"Content-Type": "application/json", "X-Review-Token": projectState.csrf_token},
    body: JSON.stringify(body)
  });
  const value = await response.json().catch(() => null);
  if (response.status === 502 || response.status === 503) throw Error("Workbench restarted. Reload this page to reconnect.");
  if (!value) throw Error(response.statusText || "Workbench returned an unreadable response.");
  if (!response.ok) throw Error(value.error || response.statusText);
  return value;
}

async function loadProject() {
  const {design, profile, ...state} = await api("bootstrap");
  projectState = state;
  const query = new URLSearchParams(embedded ? "" : location.search);
  const savedView = hostOptions.initialView || query.get("view") || layoutSetting("view");
  if (Object.hasOwn(titles, savedView)) view = savedView;
  byId("project-name").textContent = projectState.project.label;
  if (!embedded) document.title = projectState.project.label + " · Workbench";
  const version = projectState.config?.engine?.version;
  const engine = byId("engine-version");
  engine.textContent = version ? "Engine " + version : "";
  engine.hidden = !version;
  if (!projectState.installed) {
    content.replaceChildren(button("Install Workbench", async () => {
      try { await api("setup", {action: "install"}); await loadProject(); }
      catch (error) { notify(error.message); }
    }, "button primary"));
    return;
  }
  data = WorkbenchProfile.validate(WorkbenchProfile.resolve(profile, projectState.config, presetDocuments, modelCatalog));
  projectConversation = connectProjectConversation(design);
  render(design);
  void checkWorkflowProviders();
  if (query.get("chat") === "1") projectConversation.open();
}
const active = () => data.profiles[data.active];
const current = () => active().stages[selected];

let providerStatusRequest = 0;
let providerStatuses = new Map();
function showWorkflowProviderStatus() {
  const notice = byId("workflow-provider-status");
  notice.hidden = !notice.childElementCount || notice.dataset.blocking !== "true" || view === "stages";
  for (const field of panelRoot.querySelectorAll("[data-provider-health]")) {
    const row = providerStatuses.get(field.dataset.providerHealth);
    const status = row?.status === "unverified" ? "Connection unverified" :
      row?.status === "ready" ? "Ready" : row?.status === "missing" ? "CLI missing" : row ? "Needs setup" : "";
    field.textContent = field.dataset.providerDetail !== undefined ? !row ? "" :
      row.status === "unverified" ? row.name + " is installed. Account readiness is unverified." : row.message :
      row?.status === "ready" ? "" : status;
    field.hidden = !field.textContent;
  }
}
async function checkWorkflowProviders(refresh = false) {
  const request = ++providerStatusRequest;
  const notice = byId("workflow-provider-status");
  if (refresh) {
    notice.replaceChildren(element("p", "", "Checking workflow providers…"));
    showWorkflowProviderStatus();
  }
  try {
    const rows = await api("design/providers" + (refresh ? "?refresh=1" : ""));
    if (request !== providerStatusRequest) return;
    providerStatuses = new Map(rows.map(row => [row.name, row]));
    const problems = rows.filter(row => !["ready", "unverified"].includes(row.status));
    notice.dataset.blocking = String(Boolean(problems.length));
    notice.replaceChildren(...problems.map(row => element("p", "",
      element("strong", "", row.roles.join(", ") + " · " + row.name), " · " + row.message)));
    if (problems.length) notice.append(element("div", "actions",
      button("Configure providers", () => openView("stages"))));
    showWorkflowProviderStatus();
  } catch (error) {
    if (request !== providerStatusRequest) return;
    notice.dataset.blocking = "false";
    notice.replaceChildren();
    showWorkflowProviderStatus();
  }
}

function updateProfileSaveStatus() {
  const button = byId("apply-profile");
  const dirty = button.textContent === "Apply changes";
  byId("profile-save-status").textContent = dirty ? "Unsaved changes" :
    stateProfileApplied() ? "Profile saved" : "Preset selected";
  button.hidden = !dirty && stateProfileApplied();
}

function apply(change, redraw = true) {
  try {
    const next = structuredClone(data);
    change(next, next.profiles[next.active], next.profiles[next.active].stages[selected]);
    WorkbenchProfile.executable(next, modelCatalog);
    byId("apply-profile").textContent = "Apply changes";
    data = next;
    updateProfileSaveStatus();
    if (redraw) render();
    return true;
  } catch (error) {
    notify("Change could not be saved. " + error.message);
    return false;
  }
}

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function button(label, handler, style = "button") {
  const node = element("button", style, label);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}

function heading(title, detail, action) {
  const text = element("div", "", element("h2", "", title));
  if (detail) text.append(element("p", "", detail));
  const head = element("div", "panel-head", text);
  if (action) head.append(action);
  return head;
}

function field(label, input) {
  input.id = "field-" + ++fieldId;
  const caption = element("label", "", label);
  caption.htmlFor = input.id;
  return element("div", "field", caption, input);
}

function control(type, value, onChange, options = {}) {
  const input = element(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") input.type = type;
  Object.assign(input, options);
  input.value = value;
  input.addEventListener("change", () => {
    if (!onChange(input.value)) input.value = value;
  });
  return input;
}

function select(value, choices, onChange) {
  const input = element("select");
  for (const [key, label] of choices) {
    const option = element("option", "", label);
    option.value = key;
    input.append(option);
  }
  input.value = value;
  input.addEventListener("change", () => {
    if (onChange(input.value)) value = input.value;
    else input.value = value;
  });
  return input;
}

function checkbox(label, checked, itemChanged) {
  const input = element("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => {
    if (!itemChanged(input.checked)) input.checked = checked;
  });
  return element("label", "check-option", input, label);
}

function showDialog(title, ...children) {
  byId("dialog-title").textContent = title;
  dialogContent.replaceChildren(...children);
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

function stageIcon(role) {
  const icon = element("span", "stage-icon " + role.kind.toLowerCase(), role.icon);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function canvas() {
  const item = active();
  const enabledAudits = WorkbenchProfile.audits.filter(role => item.stages[role.id].enabled).length;
  const list = element("ol", "stage-list");
  for (const role of WorkbenchProfile.roles) {
    const stage = item.stages[role.id];
    const card = button("", () => {
      selected = role.id;
      render();
      panelRoot.querySelector('[data-stage="' + role.id + '"]').focus();
    }, "stage-card" + (stage.enabled ? "" : " dim"));
    card.dataset.stage = role.id;
    card.setAttribute("aria-pressed", String(selected === role.id));
    const meta = !stage.enabled ? "Skipped in this profile" : role.kind === "Gate" ? stage.provider :
      stage.provider + " · " + (stage.model || "Provider default");
    const health = element("small", "provider-health");
    health.dataset.providerHealth = stage.enabled && role.kind !== "Gate" ? stage.provider : "";
    health.hidden = true;
    card.replaceChildren(stageIcon(role), element("span", "",
      element("span", "stage-name", role.name), element("span", "stage-meta", meta), health));
    list.append(element("li", "", card));
  }
  const inspect = button("Preview workflow", preview);
  const details = enabledAudits + " active audit" + (enabledAudits === 1 ? "" : "s") + " · " + item.stages.buildReview.limit + " repair rounds";
  return element("section", "panel", heading("Workflow stages", details, inspect),
    element("div", "stage-picker", field("Selected stage", select(selected, WorkbenchProfile.roles.map(role => [role.id, role.name]), value => {
      selected = value;
      render();
      content.querySelector(".stage-picker select").focus();
      return true;
    }))),
    element("div", "canvas", list),
    element("div", "panel-foot workflow-foot", "Baseline checks run before the first build."));
}

function editStage(key, value, redraw = false) {
  const saved = apply((_, profile, stage) => { stage[key] = value; }, false);
  if (saved && redraw) {
    const layout = content.querySelector(".layout");
    layout.firstElementChild.replaceWith(canvas());
    showWorkflowProviderStatus();
  }
  return saved;
}

function agentFields(stage) {
  const group = element("div", "design-stack");
  const fields = element("div", "form-grid");
  const providers = WorkbenchProfile.stageProviders(selected, modelCatalog);
  const provider = select(stage.provider, providers.map(name => [name, name]), value => {
    if (!apply((_, item, target) => { target.provider = value; target.model = ""; }, false)) return false;
    group.replaceWith(agentFields(current()));
    content.querySelector(".layout").firstElementChild.replaceWith(canvas());
    content.querySelector(".agent-provider").focus();
    showWorkflowProviderStatus();
    return true;
  });
  provider.className = "agent-provider";
  const models = modelCatalog[stage.provider]?.models || [];
  const choices = [["", stage.provider === "Codex" ? "Project model" : "Provider default"], ...models.map(id => [id, id])];
  const picker = select(stage.model, choices, value => editStage("model", value, true));
  const effort = select(stage.effort, WorkbenchProfile.efforts.map(name => [name, name]), value => editStage("effort", value));
  fields.append(field("Provider", provider), field("Model", picker), field("Thinking level", effort));
  group.append(fields);
  const health = element("small", "stage-provider-detail");
  health.dataset.providerHealth = stage.provider;
  health.dataset.providerDetail = "";
  health.hidden = true;
  const recheck = button("Recheck provider status", async () => {
    recheck.disabled = true;
    try { await checkWorkflowProviders(true); }
    finally { recheck.disabled = false; }
  });
  group.append(element("div", "stage-provider-line", health, recheck));
  const preset = WorkbenchProfile.initial([]).profiles[data.active].stages[selected];
  const reset = button("Reset agent settings", () => {
    const {provider, model, effort} = preset;
    showDialog("Reset agent settings",
      element("p", "", "Use " + provider + " · " + (model || "Provider default") + " · " + effort + " thinking."),
      element("div", "actions", button("Cancel", () => dialog.close()),
        button("Reset", () => {
          if (!apply((_, item, stage) => Object.assign(stage, {provider, model, effort}), false)) return;
          dialog.close();
          const replacement = agentFields(current());
          group.replaceWith(replacement);
          content.querySelector(".layout").firstElementChild.replaceWith(canvas());
          showWorkflowProviderStatus();
          replacement.querySelector("[data-stage-preset]").focus();
        }, "button primary")));
  });
  reset.dataset.stagePreset = "";
  group.append(element("div", "actions", reset));
  return group;
}

async function chooseToolSettings(forStage) {
  const title = forStage ? "Tools for " + roleById(selected).name : "Project tools";
  const body = element("div", "library", element("p", "copy", "Loading tools…"));
  showDialog(title, body);
  try {
    const rows = await api("app-tools");
    const allowed = data.permittedTools || [];
    const choices = rows.filter(tool => forStage ? !tool.app || allowed.includes(tool.name) : tool.app);
    body.replaceChildren(element("p", "copy", forStage
      ? "Selected tools appear in this stage’s instructions."
      : "Allow registered app tools for this project."));
    if (!choices.length) body.append(element("p", "copy", "No app tools are registered for this project."));
    for (const tool of choices) {
      const row = checkbox(tool.name, (forStage ? current().toolHints || [] : allowed).includes(tool.name), checked =>
        apply((next, _, stage) => {
          const owner = forStage ? stage : next;
          const key = forStage ? "toolHints" : "permittedTools";
          const entries = (owner[key] || []).filter(name => name !== tool.name);
          owner[key] = checked ? [...entries, tool.name] : entries;
        }, false));
      body.append(element("div", "", row, element("p", "copy", tool.description)));
    }
  } catch (error) {
    body.replaceChildren(element("p", "copy", error.message));
  }
}

async function chooseProjectInstruction(shared) {
  const title = shared ? "Attach project instructions" : "Attach to " + roleById(selected).name;
  const body = element("div", "library", element("p", "copy", "Finding tracked instruction files…"));
  showDialog(title, body);
  try {
    const catalog = await api("project-capabilities");
    const choices = catalog.files.filter(file => file.kind === "instruction");
    if (!choices.length) {
      body.replaceChildren(element("p", "copy", "No project instruction files found."));
      return;
    }
    const picker = select(choices[0].path, choices.map(file => [file.path, file.path]), () => true);
    const attach = button("Attach file", async () => {
      attach.disabled = true;
      try {
        const file = await api("project-instruction?path=" + encodeURIComponent(picker.value));
        const filename = file.path.slice(0, 150);
        if (apply((next, profile, stage) => {
          let document = next.documents.find(row => row.source === "Project" &&
            row.filename === filename && row.content === file.content);
          if (!document) {
            document = {id: crypto.randomUUID(), name: file.path.split("/").at(-1).slice(0, 120), filename,
              source: "Project", content: file.content};
            next.documents.push(document);
          }
          const target = shared ? profile : stage;
          const key = shared ? "sharedDocs" : "docs";
          target[key] = [...new Set([...target[key], document.id])];
        })) dialog.close();
      } catch (error) {
        body.append(element("p", "copy", error.message));
      } finally {
        attach.disabled = false;
      }
    }, "button primary");
    body.replaceChildren(field("Project instruction", picker), attach);
  } catch (error) {
    body.replaceChildren(element("p", "copy", error.message));
  }
}

function inspector() {
  const role = roleById(selected);
  const stage = current();
  const badge = element("span", "badge", role.kind === "Audit" ? "Read-only audit" : role.id === "build" ? "Scoped writes" : role.kind === "Gate" ? "Runtime gate" : "Planning");
  const head = element("div", "panel-head", element("div", "",
    element("div", "inspector-title", stageIcon(role), element("h2", "", role.name)),
    element("p", "", role.description)), badge);
  const body = element("div", "panel-body");
  if (role.kind !== "Gate") {
    body.append(agentFields(stage), button("Choose stage tools", () => chooseToolSettings(true)));
  }
  if (role.kind === "Audit") {
    body.append(element("div", "audit-fields",
      checkbox("Include this audit", stage.enabled, value => editStage("enabled", value, true)),
      element("div", "form-grid",
        field(role.id === "planReview" ? "On a finding" : "On a code finding", select(stage.route, WorkbenchProfile.decisions[role.id].map(key => [key, routeLabels[key]]), value => editStage("route", value, true))),
        ...(role.id === "buildReview" ? [] : [field("Return limit", control("number", stage.limit, value => editStage("limit", Number(value), true), {min: 1, max: 20, step: 1}))])),
      ...(role.id === "planReview" ? [] : [
        field("On a requirements finding", select(stage.requirementsRoute, ["plan", "stop"].map(key => [key, routeLabels[key]]), value => editStage("requirementsRoute", value, true)))
      ])));
    if (role.id === "buildReview") body.append(field("Repair rounds", control("number", stage.limit,
      value => editStage("limit", Number(value), true), {min: 1, max: 20, step: 1})),
      element("small", "", "A round is used when an audit sends work back to the builder."));
  }
  body.append(field(role.kind === "Gate" ? "Gate rules" : "Stage instructions", control("textarea", stage.instructions,
    value => editStage("instructions", value), {maxLength: 20000, rows: 3})));
  body.append(documentSection(stage.docs, false));
  const footer = element("div", "panel-foot section-row",
    button("Preview instructions", () => {
      const text = WorkbenchProfile.stagePrompt(active(), selected, data.documents, data.permittedTools);
      showDialog(role.name + " instructions", element("pre", "", text),
        button("Download instructions", () => download(role.id + "-instructions.md", text, "text/markdown")));
    }));
  return element("aside", "panel", head, body, footer);
}

function docName(doc) {
  return doc.source === "Upload" ? doc.filename : doc.name;
}

function showDocument(doc) {
  showDialog(docName(doc), element("p", "copy", doc.source + " · " + doc.filename), element("pre", "", doc.content));
}

function documentSection(ids, shared) {
  const chips = element("div", "doc-chips");
  for (const doc of data.documents.filter(item => ids.includes(item.id))) {
    chips.append(button(docName(doc), () => showDocument(doc), "doc-chip"));
  }
  if (!ids.length) chips.append(element("small", "", "No documents attached."));
  return element("section", "", element("div", "section-row",
    element("h3", "", shared ? "Shared documents" : "Stage documents"), element("div", "actions", button("Manage attachments", () => chooseDocuments(shared)),
      button("Find project files", () => chooseProjectInstruction(shared)))), chips);
}

function chooseDocuments(shared) {
  const list = element("div", "library");
  const ids = shared ? active().sharedDocs : current().docs;
  for (const doc of data.documents) {
    list.append(checkbox(docName(doc) + " · " + doc.source, ids.includes(doc.id), checked =>
      apply((_, profile, stage) => {
        const target = shared ? profile : stage;
        const key = shared ? "sharedDocs" : "docs";
        target[key] = checked ? [...new Set([...target[key], doc.id])] : target[key].filter(id => id !== doc.id);
      })));
  }
  showDialog(shared ? "Attach shared documents" : "Attach documents to " + roleById(selected).name,
    element("p", "copy", "Selected documents are included in the instruction preview for this profile."), list);
}

function documentLibrary() {
  const list = element("div", "library");
  for (const doc of data.documents) {
    const attached = WorkbenchProfile.roles.filter(role => active().stages[role.id].docs.includes(doc.id)).map(role => role.name);
    if (active().sharedDocs.includes(doc.id)) attached.unshift("Shared");
    const buttons = element("div", "actions", button("View", () => showDocument(doc)));
    if (["Upload", "Project"].includes(doc.source)) buttons.append(button("Remove", () => {
      showDialog("Remove " + doc.filename, element("p", "copy", "This removes the local copy and its attachments from both profiles."), button("Remove document", () => {
        if (apply(next => {
          next.documents = next.documents.filter(item => item.id !== doc.id);
          for (const profile of Object.values(next.profiles)) {
            profile.sharedDocs = profile.sharedDocs.filter(id => id !== doc.id);
            for (const stage of Object.values(profile.stages)) stage.docs = stage.docs.filter(id => id !== doc.id);
          }
        })) dialog.close();
      }, "button primary"));
    }));
    list.append(element("div", "doc-row", element("div", "", element("strong", "", docName(doc)),
      element("span", "", doc.source + " · " + (attached.join(", ") || "Unassigned in this profile"))), buttons));
  }
  return element("section", "panel", heading("Instruction library", data.documents.length + " documents",
    button("Upload documents", () => byId("document-files").click(), "button primary")), element("div", "panel-body", list));
}

function rulesPanel() {
  return element("section", "panel", heading(active().name, "Shared rules appear first in each stage instruction preview."),
    element("div", "panel-body",
      field("Profile name", control("text", active().name, value => {
        if (!apply((_, item) => { item.name = value.trim(); }, false)) return false;
        content.querySelector(".panel-head h2").textContent = active().name;
        return true;
      }, {maxLength: 80})),
      field("Instructions for all stages", control("textarea", active().rules, value => apply((_, item) => { item.rules = value; }, false), {rows: 5, maxLength: 20000})),
      documentSection(active().sharedDocs, true),
      field("Project checks (JSON)", control("textarea", jsonText(data.checks), value =>
        apply(next => { next.checks = JSON.parse(value); }, false), {rows: 6})),
      button("Choose project tools", () => chooseToolSettings(false)),
      element("details", "", element("summary", "", "Advanced tool settings"),
        field("Permitted app tool names (one per line)", control("textarea", (data.permittedTools || []).join("\n"),
          value => apply(next => { next.permittedTools = value.split(/\s+/).filter(Boolean); }, false), {rows: 3})))));
}

function preview() {
  const scenarios = [["pass", "All stages pass"], ["planReview", "Plan audit finds a requirements issue"],
    ["requirements", "Build audit reopens requirements"], ["checks", "A project check fails"],
    ["buildReview", "Build audit finds a code issue"], ["finalReview", "Final audit finds a code issue"],
    ["verify", "Final verification finds a repairable issue"], ["limit", "Build findings exhaust the repair budget"]];
  const result = element("ol", "run-list");
  const update = value => {
    const scenario = value === "pass" ? {} : value === "limit" ? {buildReview: 21}
      : value === "requirements" ? {buildReview: 1, requirements: true} : {[value]: 1};
    result.replaceChildren(...WorkbenchProfile.simulate(active(), scenario).map(row => element("li", "", row)));
    return true;
  };
  const selector = select("pass", scenarios, update);
  update("pass");
  showDialog("Workflow preview",
    element("p", "copy", "Choose a sample outcome to see which stages would run. No agents or checks start."),
    field("Scenario", selector), result);
}

function render(design) {
  clearTimeout(historyTimer);
  const [title, description] = titles[view];
  byId("profile-group").hidden = ["history", "live", "quality"].includes(view);
  const configuring = ["stages", "documents", "rules"].includes(view);
  byId("profile-actions").hidden = !configuring;
  byId("configure-sections").hidden = !configuring;
  showWorkflowProviderStatus();
  if (configuring) byId("open-configure").setAttribute("aria-current", "page");
  else byId("open-configure").removeAttribute("aria-current");
  byId("view-title").textContent = title;
  byId("view-description").textContent = description;
  for (const tab of panelRoot.querySelectorAll("[data-profile]")) tab.setAttribute("aria-pressed", String(tab.dataset.profile === data.active));
  for (const item of panelRoot.querySelectorAll("[data-view]")) {
    if (item.dataset.view === view) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  const panel = view === "workflow" ? designPanel(design) : view === "quality" ? qualityPanel()
    : view === "stages" ? element("div", "layout", canvas(), inspector())
    : view === "live" ? livePanel() : view === "history" ? element("div", "design-stack", conversationHistory(), deliveryPanel(), designHistory(), historyPanel())
    : view === "documents" ? documentLibrary() : rulesPanel();
  content.replaceChildren(panel);
  updateProfileSaveStatus();
  showWorkflowProviderStatus();
  projectConversation?.context();
  if (view !== "workflow") stageChanged(view);
}

const historyStageNames = new Map(Object.entries({
  plan: "Plan", plan_review: "Plan audit", question: "Awaiting an answer",
  baseline: "Baseline checks", build: "Build & repair", building: "Building",
  checks: "Project checks", build_review: "Build audit", final_review: "Final audit",
  final_skip: "Record final audit skip", finish: "Verify & finish", completed: "Completed", stopped: "Stopped", paused: "Paused", blocked: "Blocked"
}));
const stageName = id => historyStageNames.get(id) || id || "Unavailable";
const localDateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short"
});

function historyTime(value) {
  const date = new Date(value || NaN);
  if (Number.isNaN(date.valueOf())) return element("span", "", "Time unavailable");
  return Object.assign(element("time", "", localDateTime.format(date)), {dateTime: value, title: value});
}

function transitionRows(rows) {
  const list = element("ol", "timeline transitions");
  for (const row of rows) {
    const title = element("div", "event-title", element("strong", "", "Entered " + stageName(row.stage)));
    if (row.assignedTo) title.append(element("span", "assignment", "Assigned to " + row.assignedTo));
    const li = element("li", "", title, historyTime(row.time));
    const result = row.previousResult;
    const sourceLabel = row.fromStage ? stageName(row.fromStage) : "Unknown stage";
    if (result?.verdict) li.append(element("div", "event-verdict", sourceLabel + " verdict · " + result.verdict));
    const details = element("details", "checkpoint", element("summary", "", "Checkpoint details"));
    details.dataset.record = row.source;
    details.append(element("p", "", "Recorded by " + row.actor),
      element("code", "", "Destination stage · " + row.stage),
      element("code", "", "Previous stage · " + (row.fromStage || "Unavailable")),
      element("code", "", "Recorded time · " + (row.recordedTime ?? "Unavailable")),
      element("code", "", row.source));
    if (row.id != null) details.append(element("code", "", "Checkpoint ID · " + row.id));
    if (result) {
      const text = result.finding || result.detail?.plan || JSON.stringify(result.detail, null, 2);
      details.append(element("p", "", sourceLabel + " record"), element("pre", "", text));
      if (result.detail?.criteria) details.append(element("pre", "", JSON.stringify(result.detail.criteria, null, 2)));
    }
    li.append(details);
    list.append(li);
  }
  return list;
}

function historyRows(rows) {
  const list = element("ol", "timeline");
  for (const row of rows) {
    const title = element("div", "event-title", element("strong", "", stageName(row.stage)));
    if (row.verdict) title.append(element("span", "event-verdict", row.verdict));
    const li = element("li", "", title, element("small", "", row.actor + " · ", historyTime(row.time)));
    if (row.finding) li.append(element("p", "", row.finding));
    if (row.source) li.append(element("code", "", row.source));
    list.append(li);
  }
  return list;
}

function recordedDetails(response) {
  const box = element("div", "history-details");
  for (const warning of response.warnings) box.append(element("p", "evidence-warning", warning));
  const run = response.run;
  if (!run) { box.append(element("p", "", "No recorded runs.")); return box; }
  box.append(element("code", "run-id", run.id));
  if (run.stage === "completed") box.append(button("Review changes", () => openReview(run.id)));
  if (run.action) box.append(element("p", "run-action", run.action));
  box.append(element("div", "stage-status", element("small", "", "Latest recorded stage"),
    element("strong", "", stageName(run.stage))));
  if (run.blocker) box.append(element("p", "evidence-warning", "Blocker · " + run.blocker));
  box.append(element("h3", "", "Check receipts"));
  if (!run.checks.length) box.append(element("p", "copy", "No recorded check results."));
  for (const check of run.checks) box.append(element("div", "check-receipt", element("strong", "", check.stage), element("span", "", check.verdict)));
  if (run.transitions.length) box.append(element("h3", "", "Loop transitions"), transitionRows(run.transitions));
  const receipts = element("details", "", element("summary", "", "Task events (" + run.events.length + ")"), historyRows(run.events));
  receipts.dataset.record = "events";
  receipts.open = !run.transitions.length;
  box.append(receipts);
  return box;
}

function deliveryPanel() {
  const body = element("div", "panel-body", "Reading build summaries…");
  const panel = element("section", "panel", heading("Delivery summary"), body);
  api("design/summary").then(summary => {
    if (!panel.isConnected) return;
    const latest = summary.builds[0];
    if (!latest) {
      body.textContent = "Start a build from Design to record delivery results.";
      return;
    }
    const minutes = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1}).format(latest.runSeconds / 60);
    const values = [
      ["Approved slices", latest.approvedSlices + " of " + latest.plannedSlices],
      ["Attempts", latest.attempts], ["Findings repaired", latest.repairedFindings + " of " + latest.findings],
      ["Run time", minutes + " min across " + latest.finishedAttempts + " finished attempts"],
      ["Active review time", "Unavailable"], ["Provider cost", "Unavailable"]
    ];
    const grid = element("dl", "delivery-summary", ...values.flatMap(([key,value]) => [
      element("dt", "", key), element("dd", "", String(value))
    ]));
    body.replaceChildren(element("small", "", latest.branch + " · Plan revision " + latest.planRevision),
      grid, button("Export delivery data", () => jsonDownload("workbench-delivery.json", summary)));
  }).catch(error=>{body.textContent=error.message;});
  return panel;
}

function historyPanel() {
  const picker = element("select");
  const message = element("p", "history-status", "Reading local records…");
  message.setAttribute("role", "status");
  const body = element("div", "");
  const panel = element("section", "panel", heading("Recorded runs"), element("div", "panel-body",
    field("Recorded run", picker), message, body));
  let request = 0;
  let displayed = "";
  let options = "";
  async function refresh() {
    clearTimeout(historyTimer);
    const turn = ++request;
    const currentPanel = () => panel.isConnected && turn === request;
    try {
      const response = await callMcp("inspect_run", selectedRun ? {runId: selectedRun} : {});
      if (!currentPanel()) return;
      const choices = [["", response.active ? "Follow active run" : "Follow latest run"], ...response.ids.map(id => [id, id])];
      if (options !== JSON.stringify(choices)) {
        picker.replaceChildren(...choices.map(([key, label]) => Object.assign(element("option", "", label), {value: key})));
        picker.value = selectedRun;
        options = JSON.stringify(choices);
      }
      const fingerprint = JSON.stringify([response.run, response.warnings]);
      if (displayed !== fingerprint) {
        const details = recordedDetails(response);
        let focusTarget;
        if (response.run && body.querySelector(".run-id")?.textContent === response.run.id) {
          const states = new Map(Array.from(body.querySelectorAll("details[data-record]"), node => [node.dataset.record, node.open]));
          const focused = activeElement()?.closest("details")?.dataset.record;
          for (const node of details.querySelectorAll("details[data-record]")) {
            if (states.has(node.dataset.record)) node.open = states.get(node.dataset.record);
            if (node.dataset.record === focused) focusTarget = node.querySelector("summary");
          }
        }
        body.replaceChildren(details);
        focusTarget?.focus({preventScroll: true});
        displayed = fingerprint;
      }
      message.textContent = "Connected · Updates every two seconds.";
    } catch (error) {
      if (currentPanel()) message.textContent = "Cannot refresh run history. " + error.message + " Retrying…";
    } finally {
      if (currentPanel()) historyTimer = setTimeout(refresh, 2000);
    }
  }
  picker.addEventListener("change", () => {
    selectedRun = picker.value;
    body.replaceChildren();
    displayed = "";
    message.textContent = "Reading selected run…";
    refresh();
  });
  queueMicrotask(refresh);
  return panel;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const link = element("a");
  link.href = url;
  link.download = name;
  panelBody.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const jsonText = value => JSON.stringify(value, null, 2) + "\n";
const jsonDownload = (name, value) => download(name, jsonText(value), "application/json");

panelRoot.querySelectorAll("[data-view]").forEach(node => node.addEventListener("click", () => {
  view = node.dataset.view;
  projectConversation?.selectView();
  layoutSetting("view", view);
  render();
}));
byId("open-configure").onclick = () => openView("stages");
panelRoot.querySelectorAll("[data-profile]").forEach(node => node.addEventListener("click", () => {
  if (data.active !== node.dataset.profile && apply(next => { next.active = node.dataset.profile; }, false)) {
    render();
  }
}));
byId("close-dialog").addEventListener("click", () => dialog.close());
byId("export").addEventListener("click", () => {
  const archive = element("a", "button", "Download workflow kit");
  archive.href = panelUrl("api/package");
  archive.download = "branch-review-workflow.json";
  showDialog("Export profile", button("Download draft JSON", () =>
    jsonDownload("workbench-profile.json", data), "button primary"), archive,
    element("p", "copy", "The kit includes the applied project profile."));

});
byId("import").addEventListener("click", () => byId("profile-file").click());
byId("profile-file").addEventListener("change", async event => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 5500000) throw new Error("The profile file is too large.");
    const {profile} = await api("profile/parse", JSON.parse(await file.text()));
    const imported = WorkbenchProfile.executable(profile, modelCatalog);
    showDialog("Import profile", element("p", "copy", "Load both profiles and their documents from " + file.name + "?"),
      button("Load profile draft", () => {
        if (apply(next => Object.assign(next, imported), false)) {
          render();
          dialog.close();
          notify("Profile loaded. Apply it to use it on future runs.");
        }
      }, "button primary"));
  } catch (error) {
    notify("Import failed. " + error.message);
  }
});
byId("document-files").addEventListener("change", async event => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (!files.length) return;
  try {
    const additions = [];
    for (const file of files) {
      if (!/\.(md|txt|json|ya?ml|toml)$/i.test(file.name) || file.size > 350000) {
        throw new Error(file.name + " must be a supported text file of 350 KB or less.");
      }
      const content = await file.text();
      if (!content.trim() || content.includes("\0")) throw new Error(file.name + " needs readable text.");
      additions.push({id: crypto.randomUUID(), name: file.name.slice(0, 120), filename: file.name.slice(0, 150), source: "Upload", content});
    }
    if (apply(next => next.documents.push(...additions))) notify(additions.length + " document(s) added.");
  } catch (error) {
    notify("Upload failed. " + error.message);
  }
});
async function saveWorkflowProfile() {
  const button = byId("apply-profile");
  if (button.disabled) throw Error("Wait for the workflow profile to finish saving.");
  const selected = data;
  button.disabled = true;
  try {
    await api("profile", selected);
    projectState.profile_applied = true;
    if (data !== selected) throw Error("The workflow profile changed while saving. Try again.");
    button.textContent = "Apply profile";
    updateProfileSaveStatus();
    void checkWorkflowProviders();
  }
  finally { button.disabled = false; }
}
byId("apply-profile").addEventListener("click", async () => {
  try {
    await saveWorkflowProfile();
    notify("Project profile applied to future runs.");
  } catch (error) { notify(error.message); }
});
await loadProject();

function openView(next) {
  if (view !== next) panelRoot.querySelector('[data-view="' + next + '"]').click();
}

function openDesign(tab) {
  openView("workflow");
  projectConversation?.goToDesign?.(tab);
}

return {
  dispose,
  openConversation: (context = null) => projectConversation?.open(context),
  openPlan: () => openDesign("Plan"),
  openBuild: () => openDesign("Build"),
  async syncReview({build, sha, expectedTarget}) {
    const current = await api("design");
    const change = current.builds.find(item => item.id === build && item.mode === "task");
    if (!change || change.groups[0]?.sha !== sha) throw Error("Return to the current build and review its commit.");
    const approved = change.groups[0].reviews.at(-1)?.sha === sha;
    let saved = approved ? current : await api("design/review", {build, sha});
    if (expectedTarget) saved = await api("design/push", {build, sha, expectedTarget});
    projectConversation?.update(saved, true);
    return saved;
  },
  repair(...args) {
    openDesign("Build");
    return projectConversation?.repair?.(...args);
  },
  openQuality(section = "prepare", detail = {}) {
    openView("quality");
    qualityPage?.focus({...detail, section});
  },
  setVisible(visible) {
    if (embedded) panelBody.toggleAttribute("data-view-hidden", !visible);
  }
};
