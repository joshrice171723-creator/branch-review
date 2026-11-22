"use strict";

const qualitySections = [
  {key: "prepare", title: "Prepare"},
  {key: "checks", title: "Checks", item: "check", empty: "Add a command to verify project behavior."},
  {key: "benchmarks", title: "Benchmarks", item: "benchmark", empty: "Add a benchmark to measure a check on the same workload."},
  {key: "rubrics", title: "Rubrics", item: "rubric", empty: "Add a rubric to define the criteria for a review."},
  {key: "trials", title: "Trials"},
  {key: "versions", title: "Versions"}
];
const qualityStages = {
  plan_review: "Plan audit (agent)", build_review: "Build audit (agent)",
  final_review: "Final audit (agent)", branch_review: "Branch Review (human)"
};
const qualityEmpty = () => ({schema_version: 1, checks: [], benchmarks: [], rubrics: []});
const qualityJson = value => JSON.stringify(value, null, 2) + "\n";
const qualityId = prefix => `${prefix}-${crypto.randomUUID()}`;
const qualityShort = value => String(value ?? "").slice(0, 12);
const qualityName = row => row.name || row.id;
const qualityNumberFormat = new Intl.NumberFormat(undefined, {maximumSignificantDigits: 9});
const qualityRouteMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "IPC"];

let qualityPage;

panelRoot.addEventListener("workbench-quality-focus", event => {
  if (qualityPage?.node.isConnected) qualityPage.focus(event.detail);
}, {signal});
panelRoot.addEventListener("workbench-quality-proposal", event => {
  if (qualityPage?.node.isConnected) qualityPage.propose(event.detail);
}, {signal});
panelRoot.addEventListener("workbench-quality-write", event => {
  const key = qualityProjectKey();
  if (!key) return;
  if (qualityPage?.key === key) {
    if (!qualityPage.canWrite()) event.preventDefault();
  } else try {
    if (sessionStorage.getItem(key)) event.preventDefault();
  } catch { /* No cached draft is available. */ }
}, {signal});

function qualityProjectKey() {
  const project = projectState?.project;
  return project ? "workbench-quality:" + (project.path || panelUrl("")) : null;
}

function qualityPanel() {
  const key = qualityProjectKey();
  if (!key) return element("p", "panel panel-body", "Loading project…");
  if (qualityPage?.key !== key) qualityPage = {key, ...createQualityPanel(key)};
  else if (!qualityPage.node.isConnected) qualityPage.refresh();
  return qualityPage.node;
}

function createQualityPanel(key) {
  const panel = element("div", "quality-workspace");
  const message = element("p", "quality-message");
  message.setAttribute("role", "status");
  const header = element("section", "quality-overview");
  const upgrade = element("ul", "quality-message");
  upgrade.hidden = true;
  upgrade.setAttribute("aria-label", "Check import warnings");
  const navigation = element("div", "quality-nav");
  navigation.setAttribute("role", "group");
  navigation.setAttribute("aria-label", "Quality sections");
  const body = element("div", "quality-content");
  panel.append(header, upgrade, navigation, message, body);

  let state, draft, expectedRevision, baseRevision, report, busy = false, dirty = false;
  let section = "prepare", selected = {};
  let policy = "draft", baselineRef = "", candidateRef = "HEAD";
  let routeCatalog, routeDiscovery, discoveryError = "";
  let capabilities, capabilityRequest, pendingFocus, pendingProposal, reportedSelection;
  let runtimeApp = "", triedRailsRefresh = false;
  let routeSelection = "", advancedOpen = false, manualMethod = "GET", manualPath = "", manualSource = "";
  let routeSource = "", sourceFor = "";
  let preparation;

  function notices(text, error = false) {
    message.textContent = text;
    message.classList.toggle("quality-error", error);
  }

  function remember() {
    try {
      if (dirty) sessionStorage.setItem(key, JSON.stringify({draft, expectedRevision, baseRevision}));
      else sessionStorage.removeItem(key);
    } catch { /* Keep the in-memory draft if storage is unavailable. */ }
  }

  function restore() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(key));
      if (cached?.draft && ["checks", "benchmarks", "rubrics"].every(name => Array.isArray(cached.draft[name]))) {
        ({draft, expectedRevision, baseRevision} = cached);
        dirty = true;
      }
    } catch { /* Use the server draft if local storage is unavailable. */ }
  }

  function useDraft() {
    draft = structuredClone(state.draft?.definition || state.published?.definition || qualityEmpty());
    expectedRevision = state.draft?.revision ?? null;
    baseRevision = state.draft ? state.draft.base_revision : state.published?.revision ?? null;
    dirty = false;
  }

  function edited() {
    const wasDirty = dirty;
    dirty = true;
    remember();
    notices("");
    if (!wasDirty) renderHeader();
  }

  function action(label, run, style = "button", disabled = false, focusKey = "") {
    const node = button(label, run, style);
    node.disabled = busy || disabled;
    if (focusKey) node.dataset.qualityFocus = focusKey;
    return node;
  }

  function renderHeader() {
    if (!state) return;
    const warnings = state.draft?.upgrade_warnings || [];
    upgrade.replaceChildren(...warnings.map(text => element("li", "", text)));
    upgrade.hidden = warnings.length === 0;
    const publication = state.published;
    const conflict = dirty && (expectedRevision !== (state.draft?.revision ?? null) || baseRevision !== (publication?.revision ?? null));
    const savedLabel = state.draft?.actor === "agent" ? "Agent draft" : "Draft";
    const draftStatus = dirty ? "Unsaved changes" : state.draft ? `${savedLabel} ${qualityShort(state.draft.revision)}` : "No draft";
    const save = conflict ? action("Resolve draft conflict", openConflict, "button primary", false, "conflict") :
      action("Save draft", saveDraft, "button primary", !dirty, "save");
    const preview = action("Review publication", openPublication, "button", dirty || !state.draft || state.draft.revision === publication?.revision, "preview");
    const controls = element("div", "actions");
    if (dirty || section !== "prepare") controls.append(save);
    if (section !== "prepare") controls.append(preview,
      action("Export draft", () => showExport("Draft definition", draft, "workbench-quality-draft.json"), "button", false, "export"));
    header.replaceChildren(
      element("div", "quality-overview-status", element("div", "quality-overview-title",
        element("strong", "", publication ? `Published ${qualityShort(publication.revision)}` : "No published definition"),
        ...(publication?.trial_status === "failed" ? [element("span", "quality-tag quality-failed", "Trial failed")] : [])),
        element("p", dirty ? "quality-unsaved" : "", draftStatus)),
      controls
    );
  }

  function render(focusKey = activeElement()?.dataset.qualityFocus) {
    renderHeader();
    navigation.replaceChildren(...qualitySections.map(({key: name, title}) => {
      const tab = action(title, () => { pendingFocus = null; section = name; render(`section-${name}`); }, "quality-tab", false, `section-${name}`);
      tab.setAttribute("aria-pressed", String(section === name));
      return tab;
    }));
    const group = qualitySections.find(item => item.key === section);
    if (section === "prepare" && !routeCatalog && !routeDiscovery && !discoveryError) discoverRoutes();
    if (["prepare", "checks", "benchmarks", "trials"].includes(section) && !capabilities && !capabilityRequest) loadCapabilities();
    body.replaceChildren(group.item ? editor(group) : section === "prepare" ? prepareView() : section === "trials" ? trialsView() : versionsView());
    if (panel.isConnected) {
      const row = group.item ? draft[section].find(item => item.id === selected[section]) || draft[section][0] : null;
      const route = section === "prepare" && !advancedOpen ? selectedRoute() : null;
      const id = row?.id || route?.id || (section === "trials" ? report?.id : null) || null;
      const label = row ? qualityName(row) : route ? routeChoice(route, false) : group.title;
      const change = {section, id, label};
      const signature = JSON.stringify(change);
      if (signature !== reportedSelection) {
        reportedSelection = signature;
        panelRoot.dispatchEvent(new CustomEvent("workbench-quality-selection", {detail: change}));
      }
    }
    if (focusKey && !panelRoot.querySelector("dialog[open]")) for (const node of panel.querySelectorAll("[data-quality-focus]")) {
      if (node.dataset.qualityFocus === focusKey) { node.focus(); break; }
    }
  }

  async function perform(label, task) {
    if (busy) return;
    const focusKey = activeElement()?.dataset.qualityFocus;
    busy = true;
    notices(label);
    render();
    let nextFocus;
    try { nextFocus = await task(); }
    catch (error) { notices(error.message, true); }
    finally { busy = false; if (!applyPendingFocus()) render(nextFocus || focusKey); }
  }

  function saveDraft() {
    return perform("Saving draft…", async () => {
      try {
        state.draft = await api("quality/draft", {definition: draft, base_revision: baseRevision, expected_revision: expectedRevision});
      } catch (error) {
        if (/Quality (draft|publication) changed/.test(error.message)) state = await api("quality");
        throw error;
      }
      useDraft();
      remember();
      notices("Draft saved.");
    });
  }

  function openConflict() {
    const review = overlay("Resolve draft conflict", element("p", "quality-muted", "The server draft or publication changed while you edited."),
      definitionDiff(state.draft.definition, draft, ["Server draft", "Local draft"]));
    const keep = action("Keep local draft", () => {
      expectedRevision = state.draft.revision;
      baseRevision = state.published?.revision ?? null;
      remember();
      review.close();
      notices("Save the local draft to replace the server draft.");
      render("save");
    }, "button primary");
    const discard = action("Discard local edits", () => {
      useDraft();
      remember();
      review.close();
      notices("Loaded the server draft.");
      render("section-" + section);
    });
    review.append(element("div", "actions", keep, discard));
  }

  async function loadCapabilities() {
    capabilityRequest = api("project-capabilities");
    try { capabilities = await capabilityRequest; }
    catch { capabilities = {checks: [], previews: [], files: [], components: [], git: {refs: []}}; }
    finally {
      capabilityRequest = null;
      const active = activeElement();
      const editing = panel.contains(active) && active.matches("input, textarea, select");
      if (!busy && state && !editing && !panelRoot.querySelector("dialog[open]")) render();
    }
  }

  function selectedRoute() {
    return routeCatalog?.routes.find(route => route.id === routeSelection);
  }

  function routeTarget() {
    return advancedOpen ? `${manualMethod} ${manualPath.trim()}` : routeSelection;
  }

  function chooseRoute(id) {
    if (!routeCatalog.routes.some(route => route.id === id)) return;
    if (routeSelection !== id || advancedOpen) {
      routeSelection = id;
      advancedOpen = false;
      sourceFor = "";
      routeSource = "";
      preparation = null;
      notices("");
    }
    render("prepare-picker");
  }

  function openRoutePicker() {
    const choices = routeCatalog.routes.map(route => ({id: route.id, label: `${route.method} ${route.path}`,
      detail: routeDetails(route), terms: route.app_root}));
    qualityPicker("Choose a route", "Search routes", choices, routeSelection, choice => chooseRoute(choice.id));
  }

  async function discoverRoutes(runtime = false, app = "", rescan = false) {
    if (routeDiscovery) return;
    const request = runtime ? callMcp("quality_routes", {runtime: true, ...(app ? {app} : {})}, {timeout: 150000}) : api("quality/routes");
    routeDiscovery = request;
    if (runtime) triedRailsRefresh = true;
    discoveryError = "";
    if (runtime || rescan) render(runtime ? "refresh-routes" : "rescan-routes");
    try {
      routeCatalog = await request;
      if (routeSelection && !selectedRoute()) {
        routeSelection = "";
        routeSource = "";
        sourceFor = "";
        preparation = null;
        notices("Choose a route from the updated list.");
      }
    } catch (error) {
      discoveryError = error.message;
    } finally {
      routeDiscovery = null;
      if (!busy && section === "prepare" && !applyPendingFocus()) render();
    }
  }

  function prepareView() {
    const routes = routeCatalog?.routes || [];
    const route = selectedRoute();
    const readyTarget = () => advancedOpen ? manualPath.trim() && (manualMethod === "IPC" || manualPath.trim().startsWith("/")) : route && !routeDiscovery;
    const canPrepare = () => !dirty && state.draft && readyTarget() &&
      (sourceFor !== routeTarget() || (advancedOpen ? manualSource : routeSource).trim());
    const prepare = action("Prepare", prepareRoute, "button primary", !canPrepare(), "prepare-route-action");
    const updateAction = () => { prepare.disabled = busy || !canPrepare(); };
    const fields = element("div", "panel-body quality-fields");
    if (routeDiscovery) {
      const finding = element("p", "quality-muted", "Finding project routes…");
      finding.setAttribute("role", "status");
      fields.append(finding);
    }
    if (discoveryError) fields.append(element("p", "quality-error", `Route discovery failed. ${discoveryError}`));
    if (routes.length) {
      const pick = action(route ? "Change route" : "Choose a route", openRoutePicker, "button", Boolean(routeDiscovery), "prepare-picker");
      pick.setAttribute("aria-haspopup", "dialog");
      const current = route ? element("div", "quality-route-summary", element("strong", "", `${route.method} ${route.path}`),
        element("small", "", routeDetails(route))) : element("p", "quality-muted", "Choose a route to prepare its draft.");
      fields.append(element("div", "quality-route-selection", current, pick));
    } else if (routeCatalog && !routeDiscovery && !discoveryError) {
      fields.append(element("p", "quality-muted", "No routes found. Enter a route under Advanced."));
    }
    if (route && !advancedOpen) {
      const source = route.handler?.path ? route.handler : route.source;
      if (source?.path) fields.append(element("p", "quality-route-source", "App source ", element("code", "", routeLocation(source))));
      if (route.provenance === "rails_runtime") fields.append(element("p", "quality-muted", "Observed by Rails."));
      const previews = routePreviews(route);
      if (previews.length) fields.append(details("Matching preview commands", qualityCommandList(previews)));
      if (sourceFor === routeSelection || routeSource) fields.append(sourceField(routeSource, value => { routeSource = value; updateAction(); }));
    }
    const manual = details("Advanced");
    if (advancedOpen) manual.append(manualRouteFields(updateAction));
    manual.open = advancedOpen;
    manual.addEventListener("toggle", () => {
      if (!manual.isConnected || manual.open === advancedOpen) return;
      advancedOpen = manual.open;
      notices("");
      render(advancedOpen ? "prepare-method" : "prepare-advanced");
    });
    manual.querySelector("summary").dataset.qualityFocus = "prepare-advanced";
    fields.append(manual);
    if (dirty) fields.append(element("p", "quality-callout quality-prepare-notice", "Save your draft before preparing a route."));
    const controls = element("div", "actions quality-prepare-actions", prepare);
    controls.append(action("Rescan routes", () => discoverRoutes(false, "", true), "button", Boolean(routeDiscovery), "rescan-routes"));
    const railsApps = routeCatalog?.rails_apps || [...new Set(routes.filter(row => row.framework === "Rails").map(row => row.app_root).filter(Boolean))];
    if (railsApps.length || routeCatalog?.frameworks.some(framework => framework.toLowerCase() === "rails")) {
      const app = runtimeApp || (route?.framework === "Rails" ? route.app_root : railsApps[0]);
      if (railsApps.length > 1) fields.append(input("Rails app", app, value => { runtimeApp = value; }, {
        options: Object.fromEntries(railsApps.map(path => [path, path === "." ? "Project root" : path])), disabled: Boolean(routeDiscovery), edit: () => {}
      }));
      controls.append(action("Refresh Rails routes", () => discoverRoutes(true, runtimeApp || app), "button", Boolean(routeDiscovery), "refresh-routes"));
    }
    fields.append(controls);
    if (routeCatalog?.gaps.length) {
      const discovery = details("Route discovery details", routeList(routeCatalog.gaps));
      discovery.open = triedRailsRefresh;
      fields.append(discovery);
    }
    const setup = element("section", "panel quality-prepare", heading("Prepare from a route", "Choose a route to find query sites and draft a check."), fields);
    const content = element("div", "quality-stack", setup);
    if (preparation) content.append(preparationView());
    return content;
  }

  function manualRouteFields(updateAction) {
    const ipc = manualMethod === "IPC";
    const methods = Object.fromEntries(qualityRouteMethods.map(method => [method, method]));
    const method = input("Method", manualMethod, value => {
      manualMethod = value;
      render("prepare-method");
    }, {options: methods, focusKey: "prepare-method", edit: () => {}});
    const routePath = input(ipc ? "IPC channel" : "Route path", manualPath, value => {
      manualPath = value;
      updateAction();
    }, {placeholder: ipc ? "review:open" : "/items/:id", spellcheck: false, focusKey: "prepare-path", edit: () => {}});
    return element("div", "quality-fields quality-advanced", element("h3", "", "Manual route"),
      element("div", "quality-route-fields", method, routePath), sourceField(manualSource, value => { manualSource = value; updateAction(); }));
  }

  function sourceField(value, change) {
    return input("Route source file", value, change, {hint: "Enter a project-relative path to a tracked source file.", spellcheck: false,
      focusKey: "prepare-source", edit: () => {}});
  }

  function routePreviews(route) {
    const source = route.handler?.path || route.source?.path || "";
    const expectedStack = {"Rails": /rails|ruby/i, "Electron IPC": /electron|node/i, "Node HTTP": /node|electron/i, "Python HTTP": /python/i}[route.framework];
    const components = (capabilities?.components || []).filter(component =>
      (component.root === route.app_root || (component.root !== "." && source.startsWith(component.root + "/"))) &&
      (!expectedStack || expectedStack.test(component.stack)));
    if (!components.length) return [];
    const deepest = Math.max(...components.map(component => component.root.length));
    const sameApp = new Set(components.filter(component => component.root.length === deepest).map(component => component.id));
    return capabilities.previews.filter(command => sameApp.has(command.component_id));
  }

  function prepareRoute() {
    if (dirty || !state.draft) return;
    const route = advancedOpen ? null : selectedRoute();
    if (!advancedOpen && !route) return;
    const source = (advancedOpen ? manualSource : routeSource).trim();
    const target = route ? {method: route.method, path: route.path} : {method: manualMethod, path: manualPath.trim()};
    if (route && !source) target.route_id = route.id;
    if (source) target.source_path = source;
    return perform("Preparing route…", async () => {
      const before = state.draft.definition;
      const revision = {...(baseRevision ? {base_revision: baseRevision} : {}), expected_revision: expectedRevision};
      let result;
      try {
        result = await callMcp("quality_prepare_route", {...target, ...revision}, {timeout: 75000});
      } catch (error) {
        if (/Quality (draft|publication) changed/.test(error.message)) {
          state = await api("quality");
          useDraft();
        }
        throw error;
      }
      preparation = {result, before};
      if (result.status === "needs_source") {
        sourceFor = routeTarget();
        notices("Choose a route source file to continue.");
        return "prepare-source";
      }
      state.draft = result.draft;
      useDraft();
      remember();
      sourceFor = "";
      notices("Route draft prepared.");
      return "prepare-results";
    });
  }

  function preparationView() {
    const {result, before} = preparation;
    const {route, trace, generated} = result;
    const title = routeChoice(route, false);
    const header = heading(result.status === "prepared" ? "Prepared route" : "Route source needed", title);
    const label = header.querySelector("h2");
    label.tabIndex = -1;
    label.dataset.qualityFocus = "prepare-results";
    const data = element("div", "panel-body quality-fields");
    if (result.status === "prepared") {
      const definition = result.draft.definition;
      const checks = definition.checks.filter(check => generated.check_ids.includes(check.id));
      const authored = [
        ...checks.map(check => `${before.checks.some(row => row.id === check.id) ? "Check in draft" : "Check added"} · ${qualityName(check)}`),
        ...definition.rubrics.filter(row => generated.rubric_ids.includes(row.id)).map(row =>
          `${before.rubrics.some(item => item.id === row.id) ? "Rubric in draft" : "Rubric added"} · ${qualityName(row)}`),
        ...definition.rubrics.flatMap(rubric => rubric.criteria.filter(row => generated.criterion_ids.includes(row.id)).map(row =>
          `${before.rubrics.some(item => item.criteria.some(criterion => criterion.id === row.id)) ? "Criterion in draft" : "Criterion added"} · ${row.description}`)),
        ...definition.benchmarks.filter(row => generated.benchmark_ids.includes(row.id)).map(row =>
          `${before.benchmarks.some(item => item.id === row.id) ? "Benchmark in draft" : "Benchmark added"} · ${qualityName(row)}`)
      ];
      if (authored.length) data.append(element("section", "quality-prepare-group", element("h3", "", "Draft entries"), routeList(authored)));
      const actions = element("div", "actions");
      const current = checks.find(check => draft.checks.some(row => row.id === check.id));
      if (current) actions.append(action("Review check", () => {
        selected.checks = current.id;
        section = "checks";
        render(`name-${current.id}`);
      }));
      if (trace.suggested_checks?.length) actions.append(action("Add a test command", () => pickProjectCheck(true)));
      actions.append(action("Open trials", () => {
        policy = "draft";
        section = "trials";
        render("section-trials");
      }));
      data.append(actions);
    }
    const evidence = element("section", "quality-prepare-group", element("h3", "", "Source coverage"),
      element("p", "quality-muted", "This scan reads project source. Runtime queries need separate evidence."));
    if (trace.sites.length) {
      const sites = element("ul", "quality-route-evidence");
      for (const site of trace.sites) {
        const item = element("li", "", element("strong", "", site.operation), element("code", "", routeLocation(site)));
        if (typeof site.boundary === "string") item.append(element("small", "", site.boundary));
        sites.append(item);
      }
      const querySites = details(`Query sites (${trace.sites.length})`, sites);
      querySites.open = true;
      evidence.append(querySites);
    } else evidence.append(element("p", "quality-muted", "The scan found no query sites in the inspected source."));
    if (trace.boundaries.length) {
      const sources = element("ul", "quality-route-evidence");
      for (const boundary of trace.boundaries) sources.append(element("li", "", element("strong", "", boundary.symbol), element("code", "", routeLocation(boundary))));
      evidence.append(details("Inspected entry points", sources));
    }
    if (trace.suggested_checks?.length) {
      const tests = element("ul", "quality-route-evidence");
      for (const test of trace.suggested_checks) tests.append(element("li", "", element("code", "", routeLocation(test)), element("small", "", test.note)));
      evidence.append(details("Existing test candidates", tests));
    }
    if (trace.gaps.length) {
      const gaps = details("Coverage gaps", routeList(trace.gaps));
      gaps.open = !trace.sites.length;
      evidence.append(gaps);
    }
    data.append(evidence);
    return element("section", "panel quality-prepare", header, data);
  }

  function commandCandidates(routeOnly = false) {
    const recorded = preparation?.result.trace.suggested_checks || [];
    const routeTests = recorded.map((test, index) => ({...test, id: `route-test-${index}`, label: test.path,
      source: [{path: test.path, detail: test.note}]}));
    const commands = [...routeTests, ...(routeOnly ? [] : capabilities?.checks || [])];
    const unique = new Map();
    for (const command of commands) {
      const key = commandIdentity(command);
      if (!unique.has(key)) unique.set(key, command);
    }
    return [...unique.values()];
  }

  function pickProjectCheck(routeOnly = false) {
    const choices = commandCandidates(routeOnly).map(command => ({...command,
      detail: [command.argv.join(" "), ...command.source.map(source => source.path)].join(" · ")}));
    qualityPicker("Choose a test command", "Search test commands", choices, null, command => {
      let row = draft.checks.find(check => commandIdentity(check) === commandIdentity(command));
      if (!row) {
        row = {...newRow("check"), name: command.label.slice(0, 120), argv: [...command.argv], cwd: command.cwd};
        draft.checks.push(row);
        edited();
        notices("Check added to the draft.");
      }
      showItem("checks", row.id);
    });
  }

  function showItem(key, id) {
    section = key;
    selected[key] = id;
    render(`name-${id}`);
  }

  function definitionsForReuse() {
    return [["Current draft", draft], ["Published definition", state.published?.definition], ["Recorded trial", report?.definition]]
      .filter(([, definition]) => definition);
  }

  function reuseChoices(key) {
    const choices = [];
    for (const [label, definition] of definitionsForReuse()) for (const row of definition[key]) {
      choices.push({id: `${label}:${row.id}`, label: qualityName(row), detail: label, row, definition});
    }
    return choices;
  }

  function reuseDefinition(group) {
    qualityPicker(`Reuse a ${group.item}`, `Search ${group.title.toLowerCase()}`, reuseChoices(group.key), null, choice => {
      const template = choice.row;
      const current = draft[group.key].find(row => row.id === template.id);
      if (current && choice.definition === draft) { showItem(group.key, current.id); return; }
      if (group.key === "benchmarks") reuseBenchmark(choice);
      else reuseRubric(template);
    });
  }

  function reuseBenchmark({row: template, definition}) {
    const command = definition.checks.find(check => check.id === template.check_id);
    if (!command) { notices("The source benchmark has no check.", true); return; }
    let check = draft.checks.find(row => row.phases.includes("baseline") && commandIdentity(row) === commandIdentity(command));
    const existing = draft.benchmarks.find(row => row.check_id === check?.id);
    if (existing) { showItem("benchmarks", existing.id); return; }
    if (!check) {
      check = {...structuredClone(command), id: qualityId("check")};
      draft.checks.push(check);
    }
    const row = {...structuredClone(template), id: qualityId("benchmark"), check_id: check.id};
    draft.benchmarks.push(row);
    edited();
    notices("Benchmark added to the draft.");
    showItem("benchmarks", row.id);
  }

  function reuseRubric(template) {
    let row = draft.rubrics.find(rubric => rubric.stage === template.stage);
    if (row) {
      const added = template.criteria.filter(item => !row.criteria.some(criterion => criterion.id === item.id || criterion.description === item.description));
      if (added.length) {
        row.criteria.push(...structuredClone(added));
        edited();
        notices("Criteria added to the draft.");
      }
    } else {
      row = {...structuredClone(template), id: qualityId("rubric")};
      draft.rubrics.push(row);
      edited();
      notices("Rubric added to the draft.");
    }
    showItem("rubrics", row.id);
  }

  function editor(group) {
    const rows = draft[group.key];
    const current = rows.find(row => row.id === selected[group.key]) || rows[0];
    const roster = element("section", "panel quality-roster");
    const create = action(`Add ${group.item}`, () => {
      const row = newRow(group.item);
      rows.push(row);
      selected[group.key] = row.id;
      edited();
      render(`name-${row.id}`);
    }, "button", false, `add-${group.key}`);
    const actions = element("div", "actions", create);
    if (group.key === "checks" && commandCandidates().length) actions.append(action("Add project check", () => pickProjectCheck()));
    if (group.key !== "checks" && reuseChoices(group.key).length) actions.append(action(`Reuse ${group.item}`, () => reuseDefinition(group)));
    roster.append(heading(group.title, null, actions));
    if (!current) {
      roster.append(element("p", "panel-body quality-muted", group.empty));
      return roster;
    }
    const choices = element("ul", "quality-choices");
    for (const row of rows) {
      const caption = element("strong", "", qualityName(row));
      caption.dataset.qualityCaption = row.id;
      const choice = action("", () => { selected[group.key] = row.id; render(); }, "quality-choice", false, `choose-${row.id}`);
      choice.replaceChildren(caption, element("small", "", row.id));
      choice.setAttribute("aria-pressed", String(row.id === current.id));
      choices.append(element("li", "", choice));
    }
    roster.append(choices);
    const index = rows.indexOf(current);
    const controls = rowActions(rows, index, group.item, current.id, () => {
      if (group.key === "checks" && draft.benchmarks.some(row => row.check_id === current.id)) {
        notices("Choose a different check for each benchmark that uses this check.", true);
        return false;
      }
      return true;
    }, `add-${group.key}`);
    const edit = element("section", "panel quality-edit", heading(`Edit ${group.item}`, current.id, controls));
    const fields = element("div", "panel-body quality-fields");
    fields.append(input(`${group.item[0].toUpperCase()}${group.item.slice(1)} name`, current.name, value => {
      current.name = value;
      for (const caption of choices.querySelectorAll("[data-quality-caption]")) {
        if (caption.dataset.qualityCaption === current.id) caption.textContent = qualityName(current);
      }
    }, {focusKey: `name-${current.id}`}));
    fields.append(...(group.key === "checks" ? checkFields(current) : group.key === "benchmarks" ? benchmarkFields(current) : rubricFields(current)));
    edit.append(fields);
    return element("div", "quality-editor", roster, edit);
  }

  function newRow(name) {
    const row = {id: qualityId(name), name: `New ${name}`};
    if (name === "check") return {...row, argv: [], cwd: ".", timeout_seconds: 120, required: true, phases: ["baseline", "after"]};
    if (name === "benchmark") {
      const check = draft.checks.find(item => item.phases.includes("baseline") && !draft.benchmarks.some(benchmark => benchmark.check_id === item.id));
      return {...row, check_id: check?.id || "", fixtures: [], scripts: [], metrics: [], repetitions: 3, thresholds: [], reset: {argv: [], cwd: ".", timeout_seconds: 120}};
    }
    return {...row, actor: "human", stage: "branch_review", criteria: []};
  }

  function rowActions(rows, index, item, id, canRemove = () => true, removeFocus) {
    const move = delta => {
      const destination = index + delta;
      [rows[index], rows[destination]] = [rows[destination], rows[index]];
      edited();
      render(`${destination === 0 ? "down" : "up"}-${id}`);
    };
    const up = action("↑", () => move(-1), "button quality-arrow", index === 0, `up-${id}`);
    const down = action("↓", () => move(1), "button quality-arrow", index === rows.length - 1, `down-${id}`);
    up.setAttribute("aria-label", `Move ${item} up`);
    down.setAttribute("aria-label", `Move ${item} down`);
    const remove = action("Remove", () => {
      if (!canRemove()) return;
      rows.splice(index, 1);
      edited();
      render(removeFocus);
    });
    remove.setAttribute("aria-label", `Remove ${item}`);
    return element("div", "actions", up, down, remove);
  }

  function input(label, value, change, {type = "text", options, hint, focusKey, metric, edit = edited, ...attributes} = {}) {
    const node = element(options ? "select" : type === "textarea" ? "textarea" : "input");
    if (node.tagName === "INPUT") node.type = type;
    Object.assign(node, attributes);
    if (options) for (const [id, title] of Object.entries(options)) node.append(new Option(title, id));
    node.value = value ?? "";
    node.disabled = busy || node.disabled;
    if (focusKey) node.dataset.qualityFocus = focusKey;
    if (metric) node.dataset.qualityMetric = "";
    node.addEventListener(options ? "change" : "input", () => {
      change(type === "number" && node.value !== "" ? node.valueAsNumber : node.value);
      edit();
    });
    const result = field(label, node);
    if (hint) {
      const detail = element("small", "", hint);
      detail.id = `${node.id}-hint`;
      node.setAttribute("aria-describedby", detail.id);
      result.append(detail);
    }
    return result;
  }

  function flag(label, value, change) {
    const node = Object.assign(element("input"), {type: "checkbox", checked: value, disabled: busy});
    node.addEventListener("change", () => { change(node.checked); edited(); });
    return element("label", "check-option", node, label);
  }

  function commandFields(row) {
    const [program = "", ...args] = row.argv;
    return [
      input("Program", program, value => { row.argv = [value, ...row.argv.slice(1)]; }),
      input("Arguments", args.join("\n"), value => { row.argv = [row.argv[0] || "", ...(value ? value.split("\n") : [])]; },
        {type: "textarea", rows: 3, hint: "Enter one literal argument per line."}),
      element("div", "quality-form-pair", input("Working directory", row.cwd, value => { row.cwd = value; }),
        input("Timeout (seconds)", row.timeout_seconds, value => { row.timeout_seconds = value; }, {type: "number", min: 1}))
    ];
  }

  function checkFields(row) {
    return [...commandFields(row),
      input("Phases", row.phases.includes("baseline") ? "both" : "after", value => { row.phases = value === "both" ? ["baseline", "after"] : ["after"]; },
        {options: {both: "Baseline and after", after: "After only"}}),
      flag("Required check", row.required, value => { row.required = value; })];
  }

  function nestedGroup(title, item, parentId, rows, make, fields, {remove = () => true, pick} = {}) {
    const focusKey = `add-${parentId}-${item}`;
    const controls = element("div", "actions",
      action(`Add ${item}`, () => { rows.push(make()); edited(); render(`field-${parentId}-${item}-${rows.length - 1}`); }, "button", false, focusKey));
    if (pick) controls.append(pick);
    const section = element("section", "quality-group", element("div", "quality-group-head", element("h3", "", title),
      controls));
    rows.forEach((row, index) => {
      const id = `${parentId}-${item}-${index}`;
      const label = `${item} ${index + 1}`;
      const subrow = element("div", "quality-subrow", element("div", "quality-group-head", element("strong", "", label),
        rowActions(rows, index, label, id, () => remove(row), focusKey)), ...fields(row));
      subrow.querySelector("input, select, textarea").dataset.qualityFocus = `field-${id}`;
      section.append(subrow);
    });
    return section;
  }

  function pickProjectFile(kind, apply) {
    const files = (capabilities?.files || []).filter(file => file.kind === kind);
    if (!files.length) return null;
    return action(`Choose ${kind}`, () => qualityPicker(`Choose a ${kind}`, `Search ${kind} paths`,
      files.map(file => ({...file, label: file.path, detail: file.label === file.path ? "" : file.label})), null, apply));
  }

  function pickMetric(row) {
    const choices = [];
    const used = new Set(row.metrics.map(metric => metric.id));
    for (const [label, definition] of definitionsForReuse()) for (const benchmark of definition.benchmarks) {
      for (const metric of benchmark.metrics) {
        if (used.has(metric.id)) continue;
        const key = `${metric.id}:${metric.unit}:${metric.aggregate}`;
        if (choices.some(item => item.id === key)) continue;
        choices.push({id: key, label: metric.id, detail: `${metric.unit} · ${qualityName(benchmark)} · ${label}`, metric});
      }
    }
    if (!choices.length) return null;
    return action("Choose metric", () => qualityPicker("Choose a metric", "Search recorded metrics", choices, null, choice => {
      row.metrics.push(structuredClone(choice.metric));
      edited();
      render(`field-${row.id}-metric-${row.metrics.length - 1}`);
    }));
  }

  function benchmarkFields(row) {
    const checkChoices = {"": "Choose a check", ...Object.fromEntries(draft.checks.map(check => [check.id, qualityName(check)]))};
    const metricChoices = {"": "Choose a metric", ...Object.fromEntries(row.metrics.map(metric => [metric.id, metric.id]))};
    const reset = element("fieldset", "quality-fieldset quality-reset", element("legend", "", "Reset command"),
      element("small", "", "Runs before each sample."), ...commandFields(row.reset));
    const scriptPaths = input("Benchmark script paths", (row.scripts || []).join("\n"), value => { row.scripts = value.split("\n").filter(Boolean); },
      {type: "textarea", rows: 2, hint: "Enter one project path per line. Trials compare these files across commits.", focusKey: `scripts-${row.id}`});
    const scriptPicker = pickProjectFile("script", file => {
      if (!row.scripts.includes(file.path)) { row.scripts.push(file.path); edited(); }
      render(`scripts-${row.id}`);
    });
    const fixturePicker = pickProjectFile("fixture", file => {
      let index = row.fixtures.findIndex(fixture => fixture.path === file.path);
      if (index === -1) {
        index = row.fixtures.length;
        row.fixtures.push({path: file.path, description: file.label || file.path});
        edited();
      }
      render(`field-${row.id}-fixture-${index}`);
    });
    return [element("div", "quality-form-pair", input("Check", row.check_id, value => { row.check_id = value; }, {
      options: checkChoices, hint: 'End the check output with a JSON line such as {"metrics":{"latency":12.3}}.'
    }),
      input("Repetitions", row.repetitions, value => { row.repetitions = value; }, {type: "number", min: 1})),
    nestedGroup("Fixtures", "fixture", row.id, row.fixtures, () => ({path: "", description: ""}), item => [
      input("Fixture path", item.path, value => { item.path = value; }),
      input("Fixture description", item.description, value => { item.description = value; })
    ], {pick: fixturePicker}), element("div", "quality-fields", scriptPaths, ...(scriptPicker ? [element("div", "actions", scriptPicker)] : [])),
    nestedGroup("Metrics", "metric", row.id, row.metrics, () => ({id: qualityId("metric"), unit: "ms", aggregate: "median"}), item => [
      input("Metric ID", item.id, value => {
        const previous = item.id;
        for (const threshold of row.thresholds) if (threshold.metric === previous) threshold.metric = value;
        item.id = value;
        for (const select of body.querySelectorAll("[data-quality-metric]")) {
          const option = Array.from(select.options).find(item => item.value === previous);
          if (option) { option.value = value; option.textContent = value; }
        }
      }, {hint: "Use the key emitted by the check."}),
      element("div", "quality-form-pair", input("Unit", item.unit, value => { item.unit = value; }, {hint: "Emit values in this unit."}),
        input("Aggregate", item.aggregate, value => { item.aggregate = value; }, {options: {mean: "Mean", median: "Median", min: "Minimum", max: "Maximum"}}))
    ], {pick: pickMetric(row), remove: item => {
      if (!row.thresholds.some(threshold => threshold.metric === item.id)) return true;
      notices("Remove the thresholds for this metric first.", true);
      return false;
    }}), nestedGroup("Thresholds", "threshold", row.id, row.thresholds, () => ({metric: row.metrics[0]?.id || "", op: "lte", value: 0}), item => [
      input("Metric", item.metric, value => { item.metric = value; }, {options: metricChoices, metric: true}),
      element("div", "quality-form-pair", input("Comparison", item.op, value => { item.op = value; }, {options: {lte: "At most", gte: "At least", eq: "Equal to"}}),
        input("Threshold value", item.value, value => { item.value = value; }, {type: "number", step: "any"}))
    ]), reset];
  }

  function rubricFields(row) {
    return [input("Review stage", row.stage, value => {
      row.stage = value;
      row.actor = value === "branch_review" ? "human" : "agent";
    }, {options: qualityStages}),
    nestedGroup("Criteria", "criterion", row.id, row.criteria, () => ({id: qualityId("criterion"), description: "", required: true}), item => [
      element("small", "", item.id), input("Criterion description", item.description, value => { item.description = value; }, {type: "textarea", rows: 2}),
      flag("Required criterion", item.required, value => { item.required = value; })
    ])];
  }

  function gitRefField(kind, value, change) {
    const options = (capabilities?.git.refs || []).map(ref => ({id: ref.ref || ref.name, value: ref.ref || ref.name,
      label: ref.name, detail: [ref.kind, ref.ref, qualityShort(ref.sha)].filter(Boolean).join(" · ")}));
    const name = kind === "baseline" ? "Baseline" : "Candidate";
    const focusKey = `ref-${kind}`;
    const field = input(`${name} Git ref`, value, change, {
      placeholder: kind === "baseline" ? "Optional" : "HEAD", spellcheck: false, focusKey, edit: () => {}
    });
    const controls = element("div", "quality-ref-field", field);
    if (options.length) controls.append(action(`Choose ${kind} ref`, () => {
      qualityPicker(`Choose ${kind} ref`, "Search Git refs", options, value, ref => { change(ref.value); render(focusKey); });
    }));
    return controls;
  }

  function trialsView() {
    const policies = {draft: "Saved draft", published: "Published definition"};
    function blocker() {
      if (policy === "draft" && dirty) return "Save a draft to run it here.";
      if (!state[policy]) return "Publish a definition to run it here.";
      const definition = state[policy].definition;
      return definition.checks.some(row => row.required) || definition.benchmarks.length ? "" : "Add a required check or benchmark to run a trial.";
    }
    const run = action("Run trial", runTrial, "button primary", Boolean(blocker()), "run-trial");
    const help = element("p", "quality-muted", blocker());
    const policyField = input("Definition", policy, value => {
      policy = value;
      help.textContent = blocker();
      run.disabled = Boolean(help.textContent);
    },
      {options: policies, edit: () => {}});
    const fields = element("div", "quality-fields", policyField, element("div", "quality-form-pair",
      gitRefField("baseline", baselineRef, value => { baselineRef = value; }),
      gitRefField("candidate", candidateRef, value => { candidateRef = value; })));
    const setup = element("section", "panel", heading("Trial setup", "Run checks and benchmarks on one or two Git commits."),
      element("div", "panel-body quality-fields", fields, element("div", "actions", run, help)));
    const records = element("section", "panel", heading("Trial history"));
    const rows = latest(state.trials, "created_at");
    if (!rows.length) records.append(element("p", "panel-body quality-muted", "No trials have run for this project."));
    else {
      const list = element("ul", "quality-records");
      for (const row of rows) {
        const refs = row.refs.map(ref => typeof ref === "string" ? ref : ref.ref || qualityShort(ref.sha));
        const choice = action("View results", () => readTrial(row.id), "button", false, `trial-${row.id}`);
        choice.setAttribute("aria-label", `View results for trial ${row.id}`);
        list.append(element("li", "", element("div", "quality-record-text", element("strong", "", refs.join(" → ")),
          element("small", "", `${qualityShort(row.revision)} · ${dateText(row.created_at)}`)), statusTag(row.status), choice));
      }
      records.append(list);
    }
    const content = element("div", "quality-stack", element("div", "quality-trial-layout", setup, records));
    if (report) content.append(reportView(report));
    return content;
  }

  async function runTrial() {
    if (!candidateRef.trim()) { notices("Enter a candidate Git ref.", true); return; }
    const refs = [baselineRef.trim(), candidateRef.trim()].filter(Boolean);
    if (refs.length === 2 && refs[0] === refs[1]) { notices("Choose different refs for the comparison.", true); return; }
    return perform("Running trial…", async () => {
      const response = await api("quality/trial", {policy, revision: state[policy].revision, refs});
      const trial = response.trial || response;
      state = await api("quality");
      const id = trial.id || latest(state.trials, "created_at")[0]?.id;
      if (!id) throw Error("No trial evidence is available.");
      report = trial.refs?.[0]?.sha ? trial : await api(`quality/evidence?id=${encodeURIComponent(id)}`);
      notices(report.status === "error" ? "The trial could not complete." : `Trial ${statusText(report.status).toLowerCase()}.`);
      return "trial-results";
    });
  }

  async function readTrial(id) {
    return perform("Loading trial evidence…", async () => {
      report = await api(`quality/evidence?id=${encodeURIComponent(id)}`);
      section = "trials";
      notices("");
      return "trial-results";
    });
  }

  function reportView(value) {
    const refs = value.refs || [];
    const refLabel = index => refs.length === 2 ? index === 0 ? "Baseline" : "Candidate" : "Commit";
    const evidence = link("Raw evidence", `api/quality/evidence?id=${encodeURIComponent(value.id)}`);
    const exportReport = action("Export report", () => perform("Preparing trial report…", async () => {
      const summary = await api(`quality/export?id=${encodeURIComponent(value.id)}`);
      notices("");
      showExport("Trial report", summary, `quality-trial-${value.id}.json`);
    }));
    const summary = element("section", "panel quality-report", heading("Trial results", `Trial ${value.id}`, element("div", "actions", statusTag(value.status), evidence, exportReport)));
    const title = summary.querySelector("h2");
    title.tabIndex = -1;
    title.dataset.qualityFocus = "trial-results";
    const contents = element("div", "panel-body quality-fields");
    if (value.error) contents.append(element("p", "quality-error", value.error));
    if (refs.length === 2 && !value.error) {
      const comparison = compareRefs(value);
      if (comparison.childElementCount > 1) contents.append(comparison);
    }
    const commits = element("div", refs.length > 1 ? "quality-ref-grid" : "quality-fields");
    refs.forEach((ref, index) => {
      const card = element("section", "quality-ref", element("div", "quality-group-head", element("h3", "", `${refLabel(index)} · ${ref.ref}`), statusTag(ref.status)),
        element("code", "quality-sha", ref.sha ?? "Unresolved"));
      if (ref.error) card.append(element("p", "quality-error", ref.error));
      for (const check of ref.checks || []) {
        const title = reportName(value, "checks", check.id);
        const row = element("div", "quality-result", element("div", "quality-group-head", element("strong", "", title), statusTag(check.status)));
        row.append(commandResult(check));
        card.append(row);
      }
      for (const benchmark of ref.benchmarks || []) card.append(benchmarkResult(benchmark, reportName(value, "benchmarks", benchmark.id)));
      commits.append(card);
    });
    if (refs.length) contents.append(commits);
    if (value.environment) contents.append(details("Execution environment", element("pre", "", qualityJson(value.environment))));
    summary.append(contents);
    return summary;
  }

  function compareRefs(value) {
    const [baseline, candidate] = value.refs;
    const comparison = element("section", "quality-comparison", element("h3", "", "Benchmark comparison"));
    for (const after of candidate.benchmarks || []) {
      const before = baseline.benchmarks?.find(row => row.id === after.id);
      if (!before) continue;
      for (const metric of after.metrics || []) {
        const prior = before.metrics?.find(row => row.id === metric.id && row.unit === metric.unit && row.aggregate === metric.aggregate);
        if (!Number.isFinite(prior?.value) || !Number.isFinite(metric.value)) continue;
        const delta = metric.value - prior.value;
        const title = element("strong", "", `${reportName(value, "benchmarks", after.id)} · ${metric.id}`);
        const values = `${numberText(prior.value)} → ${numberText(metric.value)} ${metric.unit}`;
        const change = `Change ${delta > 0 ? "+" : ""}${numberText(delta)} ${metric.unit}`;
        comparison.append(element("div", "quality-comparison-row", title, element("span", "", values), element("small", "", change)));
      }
    }
    return comparison;
  }

  function commandResult(command) {
    const content = element("div", "quality-command");
    const elapsed = Number.isFinite(command.duration_seconds) ? `${numberText(command.duration_seconds)} s` : "";
    const facts = [command.exit_code == null ? "" : `Exit ${command.exit_code}`, elapsed].filter(Boolean).join(" · ");
    if (facts) content.append(element("small", "", facts));
    if (command.error) content.append(element("p", "quality-error", command.error));
    if (command.stdout || command.stderr) content.append(details("Command output",
      ...(command.stdout ? [element("strong", "", "Standard output"), element("pre", "", command.stdout)] : []),
      ...(command.stderr ? [element("strong", "", "Standard error"), element("pre", "", command.stderr)] : [])));
    return content;
  }

  function benchmarkResult(value, title) {
    const result = element("section", "quality-result", element("div", "quality-group-head", element("strong", "", title), statusTag(value.status)));
    if (value.error) result.append(element("p", "quality-error", value.error));
    const metrics = element("dl", "quality-metrics");
    for (const metric of value.metrics || []) {
      const raw = (metric.samples || []).map(sample => String(sample)).join(", ");
      metrics.append(element("div", "", element("dt", "", `${metric.id} · ${metric.aggregate}`),
        element("dd", "", `${numberText(metric.value)} ${metric.unit}`),
        element("small", "", raw ? `Samples ${raw} ${metric.unit}` : "No samples")));
    }
    if (metrics.childElementCount) result.append(metrics);
    const operators = {lte: "≤", gte: "≥", eq: "="};
    for (const threshold of value.thresholds || []) {
      const unit = value.metrics?.find(metric => metric.id === threshold.metric)?.unit || "";
      result.append(element("div", "quality-threshold", statusTag(threshold.passed ? "passed" : "failed"),
        element("span", "", `${threshold.metric} ${operators[threshold.op] ?? threshold.op} ${threshold.value} ${unit}`)));
    }
    if (value.fixtures?.length) result.append(details("Fixtures", ...value.fixtures.map(fixture => element("div", "quality-fixture-result",
      element("strong", "", fixture.path), element("small", "", fixture.description || ""), element("code", "", fixture.sha256 || "")))));
    if (value.scripts?.length) result.append(details("Benchmark scripts", ...value.scripts.map(script => element("div", "quality-fixture-result",
      element("strong", "", script.path), element("code", "", script.sha256)))));
    if (value.samples?.length) result.append(details("Raw samples and output", ...value.samples.map((sample, index) =>
      element("div", "quality-sample", element("strong", "", `Sample ${index + 1}`), element("pre", "", qualityJson(sample))))));
    return result;
  }

  function versionsView() {
    const publications = latest(state.publications, "published_at");
    if (state.published && !publications.some(row => row.trial_id === state.published.trial_id)) publications.unshift(state.published);
    const panel = element("section", "panel", heading("Published versions"));
    if (!publications.length) {
      panel.append(element("p", "panel-body quality-muted", "Published versions appear here after publication."));
      return panel;
    }
    const list = element("ol", "quality-records");
    for (const version of publications) {
      const current = version.trial_id === state.published?.trial_id;
      const display = element("div", "quality-record-text", element("strong", "", qualityShort(version.revision)),
        element("small", "", dateText(version.published_at)));
      const controls = element("div", "actions");
      controls.append(action("View definition", () => perform("Loading definition…", async () => {
        const publication = current ? state.published : await api(`quality/version?id=${encodeURIComponent(version.trial_id)}`);
        notices("");
        showExport(`Version ${qualityShort(version.revision)}`, publication, "workbench-quality.json");
      })));
      if (state.trials.some(trial => trial.id === version.trial_id)) controls.append(action("View trial", () => readTrial(version.trial_id), "button", false, `version-${version.trial_id}`));
      const status = element("div", "actions", statusTag(version.trial_status));
      if (current) status.append(element("span", "quality-tag quality-current", "Current"));
      list.append(element("li", "", display, status, controls));
    }
    panel.append(list);
    return panel;
  }

  function openPublication() {
    const before = state.published?.definition || qualityEmpty();
    const revision = state.draft.revision;
    const trials = latest(state.trials, "created_at").filter(trial => trial.policy === "draft" && trial.revision === revision && ["passed", "failed"].includes(trial.status));
    const eligible = trials.find(trial => trial.status === "passed") || trials[0];
    const diff = definitionDiff(before, draft);
    const explanation = element("p", "quality-muted", "Publication writes workbench-quality.json in this project.");
    const publication = overlay("Review publication", explanation, diff);
    if (!eligible) {
      publication.append(element("p", "quality-callout", "Run a trial for this draft before publishing."),
        action("Open trials", () => { publication.close(); section = "trials"; render("section-trials"); }));
      return;
    }

    let chosen = eligible;
    const acceptance = Object.assign(element("input"), {type: "checkbox"});
    const override = Object.assign(element("input"), {type: "checkbox"});
    const overrideRow = element("label", "check-option quality-failed", override, "Publish this definition with a failed trial");
    const proof = link("Open trial evidence", `api/quality/evidence?id=${encodeURIComponent(chosen.id)}`);
    const choices = Object.fromEntries(trials.map(trial => [trial.id, `${statusText(trial.status)} · ${dateText(trial.created_at)} · ${trial.id}`]));
    const publish = action("Publish definition", () => {
      const id = chosen.id;
      const allowFailed = chosen.status === "failed" && override.checked;
      publication.close();
      perform("Publishing definition…", async () => {
        await api("quality/publish", {revision, trial_id: id, allow_failed: allowFailed});
        state = await api("quality");
        useDraft();
        remember();
        section = "versions";
        notices("Definition published.");
        return "section-versions";
      });
    }, "button primary", true, "section-versions");
    function update() {
      overrideRow.hidden = chosen.status !== "failed";
      proof.href = panelUrl(`api/quality/evidence?id=${encodeURIComponent(chosen.id)}`);
      publish.disabled = !acceptance.checked || (chosen.status === "failed" && !override.checked);
    }
    const trialField = input("Trial evidence", chosen.id, id => {
      chosen = trials.find(trial => trial.id === id);
      acceptance.checked = false;
      override.checked = false;
      update();
    }, {options: choices, edit: () => {}});
    acceptance.addEventListener("change", update);
    override.addEventListener("change", update);
    publication.append(element("div", "quality-publication-controls", trialField, proof,
      element("label", "check-option", acceptance, "I reviewed the changes and trial evidence"), overrideRow,
      element("div", "actions", publish)));
    update();
  }

  function showExport(title, value, filename) {
    const json = qualityJson(value);
    const status = element("p", "quality-message");
    status.setAttribute("role", "status");
    const copy = button("Copy JSON", async () => {
      try { await navigator.clipboard.writeText(json); status.textContent = "Copied JSON."; }
      catch { status.textContent = "Clipboard unavailable. Select the JSON to copy it."; }
    });
    const download = button("Download JSON", () => {
      const url = URL.createObjectURL(new Blob([json], {type: "application/json"}));
      Object.assign(element("a"), {href: url, download: filename}).click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    overlay(title, element("div", "actions", copy, download), status, element("pre", "", json));
  }

  function focus(request) {
    if (!qualitySections.some(group => group.key === request?.section)) return;
    pendingFocus = request;
    applyPendingFocus();
  }

  function applyPendingFocus() {
    if (!pendingFocus || !state || busy) return false;
    const {section: target, id, route} = pendingFocus;
    section = target;
    const prepareRoute = target === "prepare" && (id || route);
    if (prepareRoute && !routeCatalog && !discoveryError) {
      render(`section-${target}`);
      return true;
    }
    pendingFocus = null;
    if (prepareRoute) {
      const matches = routeCatalog?.routes.filter(row => id ? row.id === id :
        row.path === route || row.method + " " + row.path === route) || [];
      if (matches.length === 1) chooseRoute(matches[0].id);
      else {
        routeSelection = "";
        routeSource = "";
        sourceFor = "";
        preparation = null;
        notices(matches.length > 1 ? "Choose a matching route." : "The requested route is missing from the current list.", true);
        render("prepare-picker");
      }
      return true;
    }
    if (target === "trials" && id && state.trials.some(trial => trial.id === id)) {
      readTrial(id);
      return true;
    }
    if (draft[target]?.some(row => row.id === id)) {
      selected[target] = id;
      render(`name-${id}`);
      return true;
    }
    render(`section-${target}`);
    return true;
  }

  function propose(proposal) {
    if (!state && !draft) { pendingProposal = proposal; return; }
    if (busy || dirty) { notices("Save your draft before opening a proposal.", true); return; }
    if (proposal?.revision !== state.draft?.revision || proposal.baseRevision !== (state.published?.revision ?? null)) {
      notices("This proposal uses an older draft. Open a current proposal.", true);
      return;
    }
    const definition = proposal.definition;
    const changed = qualitySections.find(group => group.item && Array.isArray(definition?.[group.key]) &&
      JSON.stringify(definition[group.key]) !== JSON.stringify(draft[group.key]));
    if (!changed || !["checks", "benchmarks", "rubrics"].every(name => Array.isArray(definition?.[name]))) return;
    draft = structuredClone(definition);
    section = changed.key;
    edited();
    notices("Review the proposal before saving the draft.");
    render(`section-${section}`);
  }

  async function load() {
    if (busy) return;
    const firstLoad = !state;
    if (firstLoad) body.replaceChildren(element("p", "panel panel-body", "Loading quality definitions…"));
    busy = true;
    try {
      state = await api("quality");
      if (!dirty) useDraft();
      if (firstLoad) restore();
    } catch (error) {
      notices(error.message, true);
    } finally {
      busy = false;
      if (!state) body.replaceChildren(action("Retry", load));
      else if (pendingProposal) {
        const proposal = pendingProposal;
        pendingProposal = null;
        render();
        propose(proposal);
      } else if (!applyPendingFocus()) render();
    }
  }

  load();
  return {node: panel, refresh: load, focus, propose, canWrite: () => !busy && !dirty};
}

function qualityPicker(title, searchLabel, items, current, apply) {
  const query = Object.assign(element("input"), {type: "search", spellcheck: false, autocomplete: "off"});
  const options = element("ul", "quality-picker-list");
  const empty = element("p", "quality-muted");
  empty.setAttribute("role", "status");
  const dialog = overlay(title, field(searchLabel, query), empty, options);
  function filter() {
    const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matching = items.filter(row => terms.every(term => `${row.label} ${row.detail || ""} ${row.terms || ""}`.toLowerCase().includes(term)));
    empty.textContent = matching.length ? "" : "No matches.";
    options.replaceChildren(...matching.map(row => {
      const pick = button("", () => { dialog.close(); apply(row); }, "quality-choice");
      pick.dataset.choiceId = row.id;
      pick.setAttribute("aria-pressed", String(row.id === current));
      pick.append(element("strong", "", row.label));
      if (row.detail) pick.append(element("small", "", row.detail));
      return element("li", "", pick);
    }));
  }
  query.addEventListener("input", filter);
  filter();
  query.focus();
}

function qualityCommandList(commands) {
  const list = element("ul", "quality-route-evidence");
  for (const command of commands) {
    const row = element("li", "", element("strong", "", command.label), element("code", "", command.argv.join(" ")),
      element("small", "", command.source.map(source => source.path).join(", ")));
    if (command.url && /^https?:\/\//i.test(command.url)) row.append(link("Open configured URL", command.url));
    list.append(row);
  }
  return list;
}

function commandIdentity(command) {
  return JSON.stringify([command.cwd || ".", command.argv]);
}

function routeLocation(source) {
  return source.line ? `${source.path}:${source.line}` : source.path;
}

function routeChoice(route, includeSource = true) {
  return [`${route.method} ${route.path}`, routeDetails(route, includeSource)].filter(Boolean).join(" · ");
}

function routeDetails(route, includeSource = true) {
  const framework = route.framework === "Electron IPC" ? "Electron" : route.framework;
  const source = route.handler?.path || route.source?.path;
  const app = route.app_root === "." ? null : route.app_root;
  return [framework, app, includeSource ? source : null].filter(Boolean).join(" · ");
}

function routeList(items) {
  return element("ul", "quality-route-list", ...items.map(item => element("li", "", item)));
}

function latest(rows = [], fieldName) {
  return [...rows].sort((left, right) => String(right[fieldName] ?? "").localeCompare(String(left[fieldName] ?? "")));
}

function dateText(value) {
  const date = new Date(value ?? NaN);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
}

function numberText(value) {
  return Number.isFinite(value) ? qualityNumberFormat.format(value) : "Unavailable";
}

function statusText(status) {
  return {passed: "Passed", failed: "Failed", error: "Error", skipped: "Skipped"}[status] || "Unknown";
}

function reportName(report, collection, id) {
  return report.definition?.[collection]?.find(row => row.id === id)?.name || id;
}

function statusTag(status) {
  const variant = ["passed", "failed", "error", "skipped"].includes(status) ? status : "unknown";
  return element("span", `quality-tag quality-${variant}`, statusText(status));
}

function details(label, ...children) {
  return element("details", "quality-details", element("summary", "", label), ...children);
}

function link(label, href) {
  return Object.assign(element("a", "button quality-link", label), {href, target: "_blank", rel: "noopener noreferrer"});
}

function overlay(title, ...children) {
  const dialog = element("dialog", "quality-dialog");
  dialog.setAttribute("aria-label", title);
  dialog.append(element("div", "dialog-heading", element("h2", "", title), button("Close", () => dialog.close())), ...children);
  dialog.addEventListener("close", () => dialog.remove());
  panelBody.append(dialog);
  dialog.showModal();
  return dialog;
}

function definitionDiff(before, after, labels = ["Published", "Draft"]) {
  const result = element("div", "quality-diff");
  for (const {key, title, item} of qualitySections.filter(row => row.item)) {
    const previous = before[key];
    const proposed = after[key];
    if (JSON.stringify(previous) === JSON.stringify(proposed)) continue;
    const group = element("section", "quality-fields", element("h3", "", title));
    const originalOrder = previous.map(row => row.id).join(" ");
    const newOrder = proposed.map(row => row.id).join(" ");
    const sameRows = previous.length === proposed.length && previous.every(row => proposed.some(item => item.id === row.id));
    if (sameRows && originalOrder !== newOrder) {
      const sequence = row => `${qualityName(row)} · ${row.id}`;
      group.append(details("Order changed", changeValues(previous.map(sequence), proposed.map(sequence), labels)));
    }
    for (const id of new Set([...previous, ...proposed].map(row => row.id))) {
      const oldRow = previous.find(row => row.id === id);
      const newRow = proposed.find(row => row.id === id);
      if (JSON.stringify(oldRow) === JSON.stringify(newRow)) continue;
      const label = !oldRow ? "Added" : !newRow ? "Removed" : "Changed";
      const row = details(`${label} ${item} · ${qualityName(newRow || oldRow)}`, changeValues(oldRow, newRow, labels));
      group.append(row);
    }
    result.append(group);
  }
  if (!result.childElementCount) result.append(element("p", "quality-muted", "No definition changes."));
  return result;
}

function changeValues(before, after, labels) {
  return element("div", "quality-change-values",
    element("div", "", element("strong", "", labels[0]), element("pre", "", before ? qualityJson(before) : "None")),
    element("div", "", element("strong", "", labels[1]), element("pre", "", after ? qualityJson(after) : "None")));
}
