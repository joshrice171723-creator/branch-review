"use strict";

import * as fs from "node:fs/promises";
import path from "node:path";

const runIdPattern = /^\d{8}T\d{12}-[a-f0-9]{8}$/;
const recordPattern = /^(?:task\.json|execution_config\.json|snapshots\/[a-f0-9]{20}\.json|(?:answers|lifecycle|audits|reviews|reports|repair_rounds)\/[\w-]+\.json|results\/[\w.-]+\/(?:baseline|after)\/[\w-]+\/(?:result\.json|stdout\.log|stderr\.log))$/;
const string = value => typeof value === "string" ? value : "";

async function owned(root, name) {
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || await fs.realpath(file) !== file) {
    throw new Error("Unexpected file location");
  }
  return file;
}

async function read(root, name) {
  const file = await fs.open(await owned(root, name), "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Unsupported record");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function listRuns(root) {
  const warnings = [];
  let active = null;
  let ids = [];
  try {
    const id = (await read(root, ".harness/active_task")).trim();
    if (id && !runIdPattern.test(id)) throw new Error("Invalid run identity");
    active = id || null;
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push("Cannot read the active run identity.");
  }
  try {
    const entries = await fs.readdir(await owned(root, ".harness/tasks"), {withFileTypes: true});
    ids = entries.filter(entry => entry.isDirectory() && runIdPattern.test(entry.name)).map(entry => entry.name).sort().reverse();
  } catch {
    warnings.push("The task directory is unavailable.");
  }
  if (active && !ids.includes(active)) {
    warnings.push("The active task directory is missing.");
    ids.unshift(active);
  }
  return {active, ids, warnings};
}

function fileTime(name) {
  const match = name.match(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})\d{3}-/);
  return match ? match[1] + "-" + match[2] + "-" + match[3] + "T" + match[4] + ":" + match[5] + ":" + match[6] + "." + match[7] + "Z" : "";
}

// These assignments come from the installed audited_flow.py dispatch.
const assignments = new Map([
  ["plan", "Codex"], ["build", "Codex"], ["building", "Codex"],
  ["plan_review", "Muse"], ["build_review", "Muse"], ["final_review", "Muse"],
  ["baseline", "Workbench"], ["checks", "Workbench"], ["finish", "Workbench"]
]);

function checkpointRow(entry, previous, source) {
  const date = new Date(typeof entry.time === "number" ? entry.time * 1000 : string(entry.time) || NaN);
  const detail = entry.detail;
  const fromStage = string(previous?.stage);
  // checkpoint records arrival. Its payload describes the step that led here.
  return {
    stage: entry.stage, assignedTo: string(entry.assignedTo) || assignments.get(entry.stage) || "",
    actor: string(entry.actor || entry.component) || "Audited coordinator",
    source, id: entry.id ?? null, recordedTime: entry.time ?? null,
    time: Number.isNaN(date.valueOf()) ? "" : date.toISOString(),
    fromStage,
    previousResult: detail == null ? null : {
      verdict: string(detail.verdict),
      finding: string(detail.reason || detail.finding || detail.question || detail),
      detail
    }
  };
}

async function inspectRun(root, requested) {
  const index = await listRuns(root);
  const id = requested || index.active || index.ids[0];
  if (!id) return {...index, run: null};
  if (!runIdPattern.test(id) || !index.ids.includes(id)) throw new Error("Unknown recorded run.");
  const warnings = index.warnings;
  const run = {id, stage: "", blocker: "", transitions: [], events: [], checks: []};
  const base = ".harness/tasks/" + id + "/";
  let log = "";
  try { log = await read(root, base + "events.jsonl"); }
  catch { warnings.push("The task event log is unavailable."); }
  let lifecycle = null;
  for (const [lineIndex, line] of log.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let name;
    try { name = JSON.parse(line).path; } catch { /* Report the incomplete line below. */ }
    if (typeof name !== "string" || !recordPattern.test(name)) {
      warnings.push("Unsupported or incomplete event at line " + (lineIndex + 1) + ".");
      continue;
    }
    const row = {stage: name.split("/")[0], source: name, actor: "Workbench", time: fileTime(name), verdict: "", finding: ""};
    run.events.push(row);
    if (name.endsWith(".log")) continue;
    try {
      const record = JSON.parse(await read(root, base + name));
      row.time = string(record.at || record.recorded_at || record.created_at || record.started_at) || row.time;
      row.actor = string(record.actor || record.author || record.component) || row.actor;
      row.stage = string(record.stage || record.status || record.question) || row.stage;
      row.verdict = string(record.verdict || record.option);
      row.finding = string(record.reason || record.finding);
      if (name === "task.json") run.action = string(record.action);
      if (name.startsWith("lifecycle/")) lifecycle = record;
      if (name.endsWith("/result.json")) {
        row.stage = [record.check, record.phase].join(" · ");
        row.verdict = typeof record.exit_code !== "number" ? "incomplete" : record.exit_code === 0 && !record.source_changed ? "pass" : "fail";
        run.checks.push({...row});
      }
    } catch { warnings.push("Cannot read " + name + "."); }
  }
  if (!run.events.length) warnings.push("No readable task events.");
  try {
    const state = JSON.parse(await read(root, ".harness/loops/" + id + "/state.json"));
    if (!Array.isArray(state.history)) throw new Error("Missing history");
    for (const [position, entry] of state.history.entries()) {
      if (!entry || !string(entry.stage)) { warnings.push("Incomplete loop transition."); continue; }
      const source = "loops/" + id + "/state.json#/history/" + position;
      run.transitions.push(checkpointRow(entry, state.history[position - 1], source));
    }
    run.stage = string(state.stage) || run.transitions.at(-1)?.stage || "";
    if (["stopped", "blocked", "question"].includes(run.stage)) run.blocker = string(state.question && run.stage === "question" ? state.question : state.finding) || run.transitions.at(-1)?.previousResult?.finding || "";
    if (!run.transitions.length) warnings.push("No recorded loop transitions.");
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push("The audited loop history is unreadable.");
    else if (run.events.some(row => row.source.startsWith("audits/"))) warnings.push("The audited loop history is missing.");
  }
  if (lifecycle && lifecycle.status !== "active") {
    run.stage = string(lifecycle.status);
    if (["paused", "stopped", "blocked"].includes(run.stage)) run.blocker = string(lifecycle.reason);
  }
  run.stage ||= run.events.at(-1)?.stage || "";
  return {...index, run};
}

export {inspectRun, runIdPattern};
