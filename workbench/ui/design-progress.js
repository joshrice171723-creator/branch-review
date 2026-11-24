"use strict";

const designStageSteps = {
  plan: ["Read the task and guidelines", "Draft the plan or ask a question", "Record the plan or question"],
  planReview: ["Collect the plan and acceptance criteria", "Audit the plan", "Record the verdict"],
  baseline: ["Run baseline checks"],
  build: ["Prepare the approved instructions", "Implement the change", "Return the build summary"],
  checks: ["Run project checks"],
  buildReview: ["Collect the source and check results", "Audit the build against the plan", "Record the verdict"],
  repair: ["Read the returned finding", "Repair the affected work", "Return the repair for checks"],
  finalReview: ["Collect the current review evidence", "Audit the acceptance criteria", "Record the verdict"],
  verify: ["Verify the source and check records", "Save the result"],
  humanReview: ["Open the exact commit", "Inspect the preview and checklist", "Approve or request changes"],
  push: ["Check the approved commit and branch", "Push on request", "Confirm the remote commit"]
};

const tokenNumber = new Intl.NumberFormat();
const sentenceSegments = new Intl.Segmenter("en", {granularity: "sentence"});

function stoppedSummary(message, recovery) {
  return recovery?.summary || (/Runtime verification is blocked|unavailable after-build check/i.test(message)
    ? "The audit needs a test result to confirm the change works."
    : /preview setup|fetch failed/i.test(message) ? "The checks couldn’t connect to the project preview."
    : "The build couldn’t finish this step.");
}

function formatEvidenceText(value) {
  const content = element("div", "formatted-evidence");
  let list;
  for (const raw of value.trim().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = undefined; continue; }
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      if (list?.localName !== tag) { list = element(tag); content.append(list); }
      list.append(element("li", "", (bullet || numbered)[1]));
      continue;
    }
    list = undefined;
    const heading = /^(?:#{1,6}\s+(.+)|\*\*([^*]{1,70})\*\*)$/.exec(line);
    if (heading) { content.append(element("strong", "", heading[1] || heading[2])); continue; }
    const sentences = [...sentenceSegments.segment(line)].map(row => row.segment);
    for (let i=0;i<sentences.length;i+=3) {
      content.append(element("p", "", sentences.slice(i,i+3).join("").trim()));
    }
  }
  return content;
}

function durationText(milliseconds) {
  if (milliseconds < 1000) return "<1s";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours && hours + "h", minutes && minutes + "m", seconds % 60 + "s"].filter(Boolean).join(" ");
}

function elapsedLabel(time) {
  if (!time) return null;
  const label = element("span", "step-elapsed");
  if (time.runningSince != null) {
    label.dataset.elapsedStart = time.runningSince;
    label.dataset.elapsedBase = time.milliseconds;
  }
  label.textContent = durationText(time.milliseconds + (time.runningSince == null ? 0 : Math.max(0, Date.now() - time.runningSince)));
  return label;
}

function tokenLabel(calls, missing = false) {
  const known = calls.filter(call => call.usage);
  if (!known.length) return calls.some(call => call.time.runningSince != null) ? "Tokens pending" : "Tokens unavailable";
  const total = known.reduce((sum, {usage}) => sum + usage.input + usage.output, 0);
  return tokenNumber.format(total) + (missing || known.length < calls.length ? " reported tokens" : " tokens");
}

function visitLabels(attempts, agentStage) {
  const measured = attempts.filter(attempt => attempt.metrics);
  if (!measured.length) return [];
  const times = measured.map(attempt => attempt.metrics.time);
  const elapsed = elapsedLabel({milliseconds: times.reduce((sum, time) => sum + time.milliseconds, 0),
    runningSince: times.find(time => time.runningSince != null)?.runningSince});
  const calls = measured.flatMap(attempt => attempt.metrics.providers);
  return [elapsed, ...(agentStage ? [element("span", "", tokenLabel(calls,
    measured.some(attempt => !attempt.metrics.providers.length)))] : [])];
}

function runStepLabels() {
  return element("li", "run-step-labels", ...["Step","Status","Elapsed","Tokens","Evidence"].map(label => element("span","",label)));
}

function runStepRow({title, status, time, calls, inspect}) {
  const elapsed = elapsedLabel(time) || element("span","step-elapsed","—");
  if(!time)elapsed.title="Elapsed time unavailable";
  const tokens = element("span","step-tokens",calls ? tokenLabel(calls).replace(/ tokens$/, "").replace(/^Tokens /, "") : "—");
  tokens.title = calls ? tokenLabel(calls) : "No model call in this step";
  return element("li","",element("span","run-step-title",title),
    element("span","run-step-status",...(status==="Running"?[element("span","runtime-spinner")]:[]),status),
    elapsed,tokens,inspect || element("span"));
}

function providerMetrics(calls) {
  if (!calls?.length) return null;
  const list = element("section", "design-stack", element("h3", "", "Provider calls"));
  for (const call of calls) {
    const model = call.model || "Provider default";
    const status = {complete:"Complete",failed:"Failed",cancelled:"Cancelled"}[call.outcome] ||
      (call.time.runningSince == null ? "Interrupted" : "Running");
    const details = element("div", "design-stack",
      element("strong", "", [call.provider, model, call.effort && call.effort + " effort"].filter(Boolean).join(" · ")),
      element("p", "step-runtime", element("span", "", status), elapsedLabel(call.time), element("span", "", tokenLabel([call]))));
    if (call.usage) {
      const uncached = call.usage.cached == null ? null : Math.max(0, call.usage.input - call.usage.cached);
      const fields = [["Input", call.usage.input], ["Output", call.usage.output], ["Cached input", call.usage.cached], ["Uncached input", uncached],
        ["Cache write", call.usage.cacheWrite], ["Reasoning output", call.usage.reasoning]];
      const counts = element("dl", "step-evidence-fields");
      for (const [label, count] of fields) {
        if (count != null) counts.append(element("dt", "", label), element("dd", "", tokenNumber.format(count)));
      }
      details.append(counts);
    }
    if (call.tools?.length) details.append(element("details", "", element("summary", "", "Tool activity"),
      element("ul", "", ...call.tools.map(tool => element("li", "", [
        tool.name, tool.status, tool.milliseconds != null && durationText(tool.milliseconds),
        tool.exitCode != null && "Exit code " + tool.exitCode
      ].filter(Boolean).join(" · "))))));
    list.append(details);
  }
  return list;
}

function stepEvidenceButton(title, run, role, visit, key, label = "View evidence for " + title) {
  const query = new URLSearchParams({task: run.id, role, key});
  if (visit) query.set("visit", visit);
  const route = "design/step-evidence?" + query;
  const trigger = button("", async () => {
    const content = element("div", "design-stack step-evidence", element("p", "", "Loading saved evidence…"));
    content.setAttribute("aria-live", "polite");
    showDialog(title, content);
    try {
      const evidence = await api(route);
      content.replaceChildren(element("p", "step-runtime", element("span", "", evidence.status),
        ...(evidence.timing ? [elapsedLabel(evidence.timing)] : [])),
        ...(evidence.providers?.length ? [providerMetrics(evidence.providers)] : []),
        ...evidence.sections.map(section => renderStepEvidence(section, route)));
    } catch (error) { content.textContent = error.message; }
  }, "button step-evidence-trigger");
  trigger.dataset.evidenceFocus = JSON.stringify([role, visit, key, label]);
  trigger.title = label;
  trigger.setAttribute("aria-label", label);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z");
  svg.append(path);
  trigger.append(svg);
  return trigger;
}

function renderStepEvidence(section, route) {
  const block = element("section", "design-stack", element("h3", "", section.title));
  if (section.text) block.append(formatEvidenceText(section.text));
  if (section.fields?.length) {
    const fields = element("dl", "step-evidence-fields");
    for (const [label, value] of section.fields) fields.append(element("dt", "", label), element("dd", "", String(value)));
    block.append(fields);
  }
  for (const criterion of section.criteria ?? []) {
    block.append(element("article", "design-stack",
      element("strong", "", criterion.id.replaceAll("_", " ") + " · " + criterion.verdict.replaceAll("_", " ")),
      ...(criterion.reason ? [formatEvidenceText(criterion.reason)] : []),
      ...(criterion.evidence?.length ? [element("ul", "", ...criterion.evidence.map(value => element("li", "", value)))] : [])));
  }
  for (const check of section.checks ?? []) {
    const status = check.reused ? "Reused" : check.exit_code === 0 && !check.source_changed && !check.inputs_changed && !check.spawn_error ? "Passed" : "Failed";
    const summary = element("summary", "", check.check + " · " + status);
    const command = element("div", "design-stack", element("strong", "", "Command arguments"),
      element("pre", "", JSON.stringify(check.argv)), element("p", "", "Working directory " + check.cwd),
      element("p", "", "Exit code " + (check.exit_code ?? "unavailable") + " · " + check.duration_seconds + " s"),
      element("p", "stage-meta", "Started " + new Date(check.started_at).toLocaleString()));
    if (check.rerunReason) command.append(element("p", "", check.rerunReason));
    if (check.reused) command.append(element("p", "", "This build used the earlier passing result."));
    if (check.source_changed) command.append(element("p", "", "Source changed during this check."));
    if (check.spawn_error) command.append(element("p", "step-evidence-text", check.spawn_error));
    if (check.measurement) command.append(element("details", "", element("summary", "", "Benchmark results"),
      element("pre", "", JSON.stringify(check.measurement, null, 2))));
    const output = element("div", "design-stack");
    const renderOutput = (stdout, stderr) => output.replaceChildren(...[["Standard output", stdout], ["Standard error", stderr]]
      .filter(([, value]) => value).flatMap(([title, value]) => [element("strong", "", title), element("pre", "", value)]));
    renderOutput(check.stdout_preview, check.stderr_preview);
    command.append(output);
    if (check.stdout_truncated || check.stderr_truncated) {
      const more = button("Show captured output", async () => {
        more.disabled = true;
        try {
          const captured = await api(route + "&output=" + encodeURIComponent(check.id));
          renderOutput(captured.stdout, captured.stderr);
          more.replaceWith(element("p", "stage-meta", "Showing the saved output. Capture limits may apply."));
        } catch (error) { more.disabled = false; output.append(element("p", "", error.message)); }
      });
      command.append(more);
    }
    const details = element("details", "", summary, command);
    details.open = section.checks.length === 1;
    block.append(details);
  }
  if (section.checklist) block.append(element("ul", "",
    ...section.checklist.map(item => element("li", "", item.title + " · " + item.status.replaceAll("-", " ")))));
  for (const finding of section.findings ?? []) block.append(element("p", "step-evidence-text", finding.actual),
    element("p", "step-evidence-text", "Expected " + finding.expected));
  if (section.link) {
    const link = element("a", "button", "Open Branch Review");
    link.href = section.link;
    link.target = "_blank";
    link.rel = "noopener";
    block.append(link);
  }
  return block;
}

function progressPanel(openBuild, onProgress) {
  const box=element("section","panel run-map");
  const shell=element("div","run-map-body");
  const taskTitle=element("p","run-map-task");
  const coordinatorStatus=element("span");
  const coordinatorInfo=element("details","run-map-coordinator",
    element("summary","",element("strong","","Workbench coordinator"),document.createTextNode(" · "),coordinatorStatus),
    element("p","stage-meta","Starts stages, runs project checks, and saves where the build can resume. Select a stage to see its agent, checks, and recovery activity."));
  const usageDetails=element("div","design-stack");
  coordinatorInfo.append(usageDetails);
  const grid=element("div","run-map-grid");
  const detail=element("section","run-map-detail");
  const mode=button("Preview next build",()=>{previewNext=!previewNext; selectedStage=null; draw();});
  const actions=element("div","actions",mode);
  const log=button("Show log",()=>showDesignLog(run.id,run.running));
  if(openBuild)actions.append(button("Build options",openBuild),log);
  const toolbar=element("div","panel-head run-map-toolbar",actions);
  box.setAttribute("aria-label","Build progress");
  box.append(toolbar,taskTitle,coordinatorInfo,shell);
  shell.append(grid,detail);
  let run, group, previewNext=false, selectedStage=null, previousState;
  const definitions=WorkbenchProfile.roles;
  const extra={
    baseline:{name:"Baseline checks",icon:"✓",kind:"Gate"},repair:{name:"Repair",icon:"↺",kind:"Agent"},
    humanReview:{name:"Branch Review",icon:"◇",kind:"Gate"},push:{name:"Push to GitHub",icon:"↑",kind:"Gate"}
  };
  const isRecovery=text=>/^(Coordinator is sending |Recovering |Reusing current receipt|Checking a specific gap|Retrying |Retry the blocked stage)/.test(text);
  function draw() {
    const focused=activeElement();
    const focus=box.contains(focused)?focused.dataset.stageKey:null;
    const evidenceFocus=detail.contains(focused)?focused.dataset.evidenceFocus:null;
    const expanded=detail.querySelector("details[open]")?detail.dataset.stageKey:null;
    const current=previewNext?null:run;
    const usage=current?.usage;
    if (usage?.calls) {
      const values = [["Cached input", usage.cached], ["Uncached input", usage.uncached], ["Output", usage.output],
        ["Input with unknown cache status", usage.unclassifiedInput]];
      usageDetails.replaceChildren(element("h3","","Build token usage"), element("dl","step-evidence-fields",
        ...values.flatMap(([label,value]) => [element("dt","",label),element("dd","",tokenNumber.format(value))])),
        ...(usage.unknown ? [element("p","stage-meta",usage.unknown + " calls have no reported usage. Totals are partial.")] : []),
        element("p","stage-meta","Time stopped · ",elapsedLabel({milliseconds:usage.stoppedMs,runningSince:usage.stoppedSince})),
        ...(usage.recovery.length ? [element("h3","","Coordinator recovery calls"),providerMetrics(usage.recovery)] : []));
    } else usageDetails.replaceChildren();
    const history=current?.attempts || [];
    const last=history.at(-1);
    const failure=current?.failure;
    const gate=previewNext?null:group;
    const pick=selectedStage || failure?.role || current?.evidenceRequest?.role || (gate?.waiting?"humanReview":last?.role || "plan");
    mode.hidden=!run;
    log.hidden=!run;
    toolbar.hidden=!run && !openBuild;
    mode.textContent=previewNext?"Show current run":"Preview next build";
    const routeLabel={visual:"Automatic visual route", expanded:"Full audit required by the diff", full:"Full workflow"}[current?.routing];
    taskTitle.textContent=current ? [current.title, routeLabel, current.running && "Running"].filter(Boolean).join(" · ") : "Next build";
    const currentStage=last && (extra[last.role] || definitions.find(role=>role.id===last.role))?.name;
    const recoveryStatus=current?.events?.findLast(event=>isRecovery(event.text))?.text ||
      (isRecovery(last?.reason) ? last.reason : "");
    const quotaWait=Date.parse(failure?.providerLimit?.resetAt) > Date.now();
    coordinatorStatus.textContent=current?.running ? (recoveryStatus || "Running " + (currentStage || "build")) :
      quotaWait ? "Waiting for provider quota to reset" : failure ? "Stopped at " +
        ((extra[failure.role] || definitions.find(role=>role.id===failure.role))?.name || "current stage") :
      current?.question || current?.evidenceRequest ? "Waiting for a response" :
      gate?.waiting ? "Waiting for Branch Review" : current?.stage==="completed" ? "Build complete" : "Waiting to start";
    grid.replaceChildren();
    for(const [key,steps] of Object.entries(designStageSteps)){
      const role=extra[key] || definitions.find(r=>r.id===key);
      const configId=key==="repair"?"build":key;
      const config=current?.stages?.[configId] || active().stages[configId];
      const attempts=history.filter(item=>item.role===key);
      const attempt=attempts.at(-1);
      const agentStage=["plan","planReview","build","repair","buildReview","finalReview"].includes(key);
      const next=attempt?history[history.indexOf(attempt)+1]:null;
      const live=Boolean(current?.running && last===attempt && attempt);
      const failed=failure?.role===key;
      const stoppedRecovery=failed ? failure.recovery : null;
      const recovering=stoppedRecovery && ["queued","reviewing","waiting","resuming"].includes(stoppedRecovery.status);
      const needsEvidence=current?.evidenceRequest?.role===key;
      const waiting=key==="plan" && current?.stage==="question" || key==="humanReview" && gate?.waiting;
      const skipped=config?.enabled===false || ["plan_skip","final_skip"].includes(attempt?.stage);
      const isReturn=next?.reason && ["plan","repair"].includes(next.role);
      const completed=Boolean(attempt && (next || current?.stage==="completed")) || key==="humanReview" && gate?.approved || key==="push" && gate?.pushed;
      const limited=failed && /\b429\b|rate_limit_error|quota exhausted/i.test(failure.message);
      const recovery=live && ((current.events || []).findLast(event => isRecovery(event.text))?.text ||
        (isRecovery(attempt.reason) ? attempt.reason : ""));
      const budgetStopped=failed && /^PROVIDER_(?:CALL_TIMEOUT|(?:TASK_TIME|USAGE)_BUDGET)$/.test(failure.errorCode || "");
      const status=failed?(recovering?"Recovering":limited?"Quota reached":budgetStopped?"Limit reached":failure.repairLimit?"Repair limit reached":"Stopped"):
        needsEvidence?"Needs evidence":skipped?"Skipped":waiting?"Waiting for you":live?(recovery?"Recovering":"Running"):isReturn?"Returned":
        completed?"Complete":key==="repair"&&!attempt?"If requested":key==="push"?"On request":attempt?"Paused":"Upcoming";
      const reviewTarget=key==="humanReview" && gate?.target;
      const card=button("",async()=>{
        if (!reviewTarget) { selectedStage=key; draw(); return; }
        card.disabled=true;
        try {
          const review=await api("design/group?" + new URLSearchParams(reviewTarget));
          if(!review.runId || ["branch-changed","design-stale","different-preview"].includes(review.status)) {
            throw Error(review.message || "This plan does not have a current review commit.");
          }
          await openReview(review.runId);
        } catch(error) { notify(error.message); }
        finally { card.disabled=false; }
      },"stage-card run-map-card");
      card.dataset.stageKey=key;card.dataset.status=status;
      if(failed)card.dataset.failed="";
      if(reviewTarget) card.setAttribute("aria-label","Open Branch Review for " + current.title);
      else card.setAttribute("aria-pressed",String(key===pick));
      if(live)card.setAttribute("aria-current","step");
      const glyph = failed ? element("span","run-map-error-icon","!") :
        live ? element("span","runtime-spinner") : stageIcon(role);
      if(failed)glyph.setAttribute("aria-hidden","true");
      const metrics=visitLabels(attempts,agentStage && !skipped);
      if(key==="push" && Number.isFinite(gate?.pushMs))metrics.push(elapsedLabel({milliseconds:gate.pushMs}));
      card.append(glyph,element("span","",element("strong","stage-name",role.name),
        element("small","stage-meta",status), ...(metrics.length?[element("span","step-runtime",...metrics)]:[])));
      grid.append(card);
      if(key!==pick)continue;
      detail.dataset.stageKey=key;
      const provider = skipped ? "Workbench" : attempt?.metrics?.providers?.at(-1)?.provider || config?.provider;
      detail.replaceChildren(element("h3","",role.name),element("p","stage-meta",provider || (key==="humanReview"?"Human":"Workbench")));
      if(recovery)detail.append(element("p","stage-meta",recovery));
      if(needsEvidence)detail.append(element("div","run-map-error",element("strong","","Audit needs evidence"),
        formatEvidenceText(current.evidenceRequest.text)));
      if(metrics.length)detail.append(element("p","step-runtime",element("span","",
        attempts.length>1?"Across "+attempts.length+" attempts":"Elapsed"),...visitLabels(attempts,agentStage && !skipped),
        ...(key==="push" && Number.isFinite(gate?.pushMs)?[elapsedLabel({milliseconds:gate.pushMs})]:[])));
      if(failed) {
        const agentLabel = ({provider,model,effort}) =>
          [provider,model || "Provider default",effort].filter(Boolean).join(" · ");
        const reset = /resets at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(failure.message)?.[1];
        const resetTime = reset && new Date(reset);
        detail.append(element("div","run-map-error",
          element("strong","",recovering?"Coordinator recovery":limited?"Provider quota reached":budgetStopped?"Provider limit reached":
            failure.repairLimit?"Repair limit reached":"Stage stopped"),
          element("p","",stoppedSummary(failure.message, stoppedRecovery)),
          ...(stoppedRecovery?.message && stoppedRecovery.message !== failure.message ?
            [element("p","",stoppedRecovery.message)] : []),
          ...(resetTime && !Number.isNaN(resetTime.valueOf()) ? [element("p","","Quota resets " +
            resetTime.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}) + " local time.")] : []),
          ...(failure.resumeBlocker ? [element("p","",failure.resumeBlocker)] :
            limited && !recovering ? [element("p","","Resume after the quota resets.")] : []),
          element("details","run-attempt-notes",element("summary","","Technical details"),
            ...(config?.provider ? [element("p","","Stopped attempt · " + agentLabel(config))] : []),
            ...(failure.savedAgent ? [element("p","","Saved agent · " + agentLabel(failure.savedAgent))] : []),
            formatEvidenceText(failure.message.replace(/\s*\[request_id=[^\]]+\]/i,"")),
            ...(stoppedRecovery?.detail ? [formatEvidenceText(stoppedRecovery.detail)] : []))));
      }
      const evidence=attempt?.evidence || gate?.evidence?.[key] || {};
      let titles=steps;
      const checkStage=key==="baseline" || key==="checks";
      if(checkStage){
        const phase=key==="baseline"?"baseline":"after";
        const checks=(current?.checks || projectState.config?.checks || []).filter(c=>(c.phases || ["baseline","after"]).includes(phase));
        const checkNames=[...new Set([...checks.map(c=>c.name),...Object.keys(evidence)])];
        if(checkNames.length)titles=checkNames;
      }
      const events=live?current.events:[];
      const hasAgentEvent=events.some(e=>!e.text.startsWith("Entered ") && e.actor!=="Workbench");
      const verdict=events.some(e=>e.text.startsWith("Audit verdict ·"));
      const timedStep=Object.entries(attempt?.metrics?.steps || {}).find(([,time])=>time.runningSince!=null)?.[0];
      const cursor=timedStep!==undefined && !checkStage?Number(timedStep):
        verdict?titles.length-1:hasAgentEvent && titles.length>1?1:0;
      const list=element("ol","run-map-steps",runStepLabels());
      const previewTiming=checkStage && attempt?.metrics?.steps?.["@preview"];
      if(previewTiming)list.append(runStepRow({title:"Preview setup",
        status:previewTiming.runningSince!=null?"Running":failed&&!titles.some(title=>attempt.metrics.steps[title])?"Stopped":"Complete",
        time:previewTiming}));
      for(const [i,title] of titles.entries()){
        let state=failed?"Stopped":completed?"Complete":live?(i<cursor?"Complete":i===cursor?"Running":"Upcoming"):"Upcoming";
        if(live && checkStage){
          const e=events.filter(e=>e.text.startsWith("Started "+title+".") || e.text==="Reused the passing result for "+title+"." ||
            ["Started","Passed","Failed"].some(verb=>e.text===verb+" run "+title || e.text===verb+" "+title)).at(-1);
          state=e?(e.text.startsWith("Reused")?"Reused":e.text.startsWith("Passed")?"Complete":e.text.startsWith("Failed")?"Failed":"Running"):"Upcoming";
        }
        if(skipped)state="Skipped";
        const stepKey=checkStage?title:String(i);
        const timed=attempt?.metrics?.steps || {};
        const hasTiming=Object.hasOwn(timed,stepKey);
        const hasEvidence=Object.hasOwn(evidence,stepKey);
        const time=(hasTiming?timed[stepKey]:null) ||
          (key==="push" && stepKey==="1" && Number.isFinite(gate?.pushMs)?{milliseconds:gate.pushMs}:null);
        if(live && time?.runningSince!=null)state="Running";
        if(hasEvidence)state=evidence[stepKey];
        else if(completed && !skipped)state="No result";
        list.append(runStepRow({title,status:state,time,
          calls:stepKey==="1" && agentStage && attempt && !skipped ? attempt.metrics?.providers || [] : null,
          inspect:hasEvidence || hasTiming ? stepEvidenceButton(title,current,key,attempt?.id,stepKey) : null}));
      }
      detail.append(list);
      if(waiting && current?.question && key==="plan")detail.append(element("p","",String(current.question)));
      if(live && events.length)detail.append(element("p","run-map-event",events.at(-1).text));
      if(key==="repair" && !attempt)detail.append(element("p","copy","A build or final audit can return work here. Checks run again after a repair."));
      if(attempts.length){
        const archive=element("details","",element("summary","",attempts.length===1?"1 attempt":attempts.length+" attempts"));
        archive.open=expanded===key;
        for(const [attemptIndex,a] of attempts.entries()){
          const following=history[history.indexOf(a)+1];
          const reason=a.reason || (following?.reason && ["plan","repair"].includes(following.role)?following.reason:"");
          const line=element("p","",element("strong","","Attempt "+(attemptIndex+1)),
            " · "+new Date(a.time*1000).toLocaleTimeString());
          const summary=visitLabels([a],agentStage && !skipped);
          if(summary.length)line.append(element("span","step-runtime",...summary));
          const previous=element("ul","run-map-steps",runStepLabels());
          for(const [stepKey,status] of Object.entries(a.evidence || {})){
            const title=checkStage?stepKey:steps[Number(stepKey)];
            const timing=a.metrics?.steps || {};
            previous.append(runStepRow({title,status,time:Object.hasOwn(timing,stepKey)?timing[stepKey]:null,
              calls:stepKey==="1" && agentStage && !skipped ? a.metrics?.providers || [] : null,
              inspect:stepEvidenceButton(title,current,key,a.id,stepKey,"View "+title+" for attempt "+(attemptIndex+1))}));
          }
          archive.append(line);
          if(reason)archive.append(element("details","run-attempt-notes",element("summary","","Read attempt notes"),formatEvidenceText(reason)));
          if(previous.childElementCount>1)archive.append(previous);
        }
        detail.append(archive);
      }
      if(config && definitions.some(r=>r.id===configId))detail.append(button("Stage settings",()=>{
        selected=configId;panelRoot.querySelector('[data-view="stages"]').click();
      }));
    }
    if(focus)grid.querySelector('[data-stage-key="'+focus+'"]')?.focus({preventScroll:true});
    if(evidenceFocus)[...detail.querySelectorAll("[data-evidence-focus]")]
      .find(node=>node.dataset.evidenceFocus===evidenceFocus)?.focus({preventScroll:true});
  }
  function tick(){
    if(!box.isConnected)return;
    for(const root of [box,dialog]){
      for(const clock of root.querySelectorAll("[data-elapsed-start]")){
        clock.textContent=durationText(Number(clock.dataset.elapsedBase)+Math.max(0,Date.now()-Number(clock.dataset.elapsedStart)));
      }
    }
    if(run?.running)setTimeout(tick,1000);
    else ticking=false;
  }
  let ticking=false;
  async function refresh(){
    if(!box.isConnected)return;
    if(document.hidden){setTimeout(refresh,8000);return;}
    try{
      const data=await api("design/progress");
      if(!box.isConnected)return;
      const fingerprint=JSON.stringify([data.run,data.review]);
      const focused=activeElement();
      const inspecting=dialog.open && dialog.querySelector(".step-evidence");
      if(fingerprint!==previousState && !inspecting && (!detail.contains(focused) || focused.dataset.evidenceFocus)){
        if(data.run?.failure && JSON.stringify(run?.failure)!==JSON.stringify(data.run.failure)) selectedStage=null;
        run=data.run;group=data.review;draw();previousState=fingerprint;
      }
      if(run?.running && !ticking){ticking=true;tick();}
      if(!inspecting)await onProgress?.(data);
    }catch(error){taskTitle.textContent=error.message;}
    const active=run?.running || run?.stage==="question" || run?.stage==="question_retry" || group?.waiting;
    if(box.isConnected)setTimeout(refresh,active?2500:6500);
  }
  draw();queueMicrotask(refresh);
  return box;
}
