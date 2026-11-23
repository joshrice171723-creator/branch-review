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
      content.replaceChildren(element("p", "stage-meta", evidence.status),
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
  if (section.text) block.append(element("p", "step-evidence-text", section.text));
  if (section.fields?.length) {
    const fields = element("dl", "step-evidence-fields");
    for (const [label, value] of section.fields) fields.append(element("dt", "", label), element("dd", "", String(value)));
    block.append(fields);
  }
  for (const criterion of section.criteria ?? []) {
    block.append(element("article", "design-stack",
      element("strong", "", criterion.id.replaceAll("_", " ") + " · " + criterion.verdict.replaceAll("_", " ")),
      ...(criterion.reason ? [element("p", "step-evidence-text", criterion.reason)] : []),
      ...(criterion.evidence?.length ? [element("ul", "", ...criterion.evidence.map(value => element("li", "", value)))] : [])));
  }
  for (const check of section.checks ?? []) {
    const status = check.exit_code === 0 && !check.source_changed && !check.spawn_error ? "Passed" : "Failed";
    const summary = element("summary", "", check.check + " · " + status);
    const command = element("div", "design-stack", element("strong", "", "Command arguments"),
      element("pre", "", JSON.stringify(check.argv)), element("p", "", "Working directory " + check.cwd),
      element("p", "", "Exit code " + (check.exit_code ?? "unavailable") + " · " + check.duration_seconds + " s"),
      element("p", "stage-meta", "Started " + new Date(check.started_at).toLocaleString()));
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
  const grid=element("div","run-map-grid");
  const detail=element("section","run-map-detail");
  const mode=button("Preview next build",()=>{previewNext=!previewNext; selectedStage=null; draw();});
  const actions=element("div","actions",mode);
  const log=button("Show log",()=>showDesignLog(run.id,run.running));
  if(openBuild)actions.append(button("Build options",openBuild),log);
  box.append(heading(active().name,"",actions),taskTitle,shell);
  shell.append(grid,detail);
  let run, group, previewNext=false, selectedStage=null, previousState;
  const definitions=WorkbenchProfile.roles;
  const extra={
    baseline:{name:"Baseline checks",icon:"✓",kind:"Gate"},repair:{name:"Repair",icon:"↺",kind:"Agent"},
    humanReview:{name:"Branch Review",icon:"◇",kind:"Gate"},push:{name:"Push to GitHub",icon:"↑",kind:"Gate"}
  };
  function draw() {
    const focused=activeElement();
    const focus=box.contains(focused)?focused.dataset.stageKey:null;
    const evidenceFocus=detail.contains(focused)?focused.dataset.evidenceFocus:null;
    const expanded=detail.querySelector("details[open]")?detail.dataset.stageKey:null;
    const current=previewNext?null:run;
    const history=current?.attempts || [];
    const last=history.at(-1);
    const failure=current?.failure;
    const gate=previewNext?null:group;
    const pick=selectedStage || failure?.role || (gate?.waiting?"humanReview":last?.role || "plan");
    mode.hidden=!run;
    log.hidden=!run;
    mode.textContent=previewNext?"Show current run":"Preview next build";
    taskTitle.textContent=current ? current.title + (current.running ? " · Running" : "") : "Next build";
    grid.replaceChildren();
    for(const [key,steps] of Object.entries(designStageSteps)){
      const role=extra[key] || definitions.find(r=>r.id===key);
      const configId=key==="repair"?"build":key;
      const config=current?.stages?.[configId] || active().stages[configId];
      const attempts=history.filter(item=>item.role===key);
      const attempt=attempts.at(-1);
      const next=attempt?history[history.indexOf(attempt)+1]:null;
      const live=Boolean(current?.running && last===attempt && attempt);
      const failed=failure?.role===key;
      const waiting=key==="plan" && current?.stage==="question" || key==="humanReview" && gate?.waiting;
      const skipped=config?.enabled===false || attempt?.stage==="final_skip";
      const isReturn=next?.reason && ["plan","repair"].includes(next.role);
      const completed=Boolean(attempt && (next || current?.stage==="completed")) || key==="humanReview" && gate?.approved || key==="push" && gate?.pushed;
      const limited=failed && /\b429\b|rate_limit_error|quota exhausted/i.test(failure.message);
      const status=failed?(limited?"Quota reached":"Stopped"):skipped?"Skipped":waiting?"Waiting for you":live?"Running":isReturn?"Returned":
        completed?"Complete":key==="repair"&&!attempt?"If requested":key==="push"?"On request":attempt?"Paused":"Upcoming";
      const card=button("",()=>{selectedStage=key;draw();},"stage-card run-map-card");
      card.dataset.stageKey=key;card.dataset.status=status;
      if(failed)card.dataset.failed="";
      card.setAttribute("aria-pressed",String(key===pick));
      if(live)card.setAttribute("aria-current","step");
      const glyph = failed ? element("span","run-map-error-icon","!") :
        live ? element("span","runtime-spinner") : stageIcon(role);
      if(failed)glyph.setAttribute("aria-hidden","true");
      card.append(glyph,element("span","",element("strong","stage-name",role.name),
        element("small","stage-meta",status)));
      grid.append(card);
      if(key!==pick)continue;
      detail.dataset.stageKey=key;
      detail.replaceChildren(element("h3","",role.name),element("p","stage-meta",config?.provider || (key==="humanReview"?"Human":"Workbench")));
      if(failed) {
        const agentLabel = ({provider,model,effort}) =>
          [provider,model || "Provider default",effort].filter(Boolean).join(" · ");
        const reset = /resets at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(failure.message)?.[1];
        const resetTime = reset && new Date(reset);
        detail.append(element("div","run-map-error",
          element("strong","",limited?"Provider quota reached":"Stage stopped"),
          ...(config?.provider ? [element("p","","Stopped attempt · " + agentLabel(config))] : []),
          ...(failure.savedAgent ? [element("p","","Saved agent · " + agentLabel(failure.savedAgent))] : []),
          element("p","",failure.message.replace(/\s*\[request_id=[^\]]+\]/i,"")),
          ...(resetTime && !Number.isNaN(resetTime.valueOf()) ? [element("p","","Quota resets " +
            resetTime.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}) + " local time.")] : []),
          ...(failure.resumeBlocker ? [element("p","",failure.resumeBlocker)] :
            limited ? [element("p","","Resume after the quota resets.")] : [])));
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
      const cursor=verdict?titles.length-1:hasAgentEvent && titles.length>1?1:0;
      const list=element("ol","run-map-steps");
      for(const [i,title] of titles.entries()){
        let state=failed?"Stopped":completed?"Complete":live?(i<cursor?"Complete":i===cursor?"Running":"Upcoming"):"Upcoming";
        if(live && checkStage){
          const e=events.filter(e=>["Started","Passed","Failed"].some(verb=>e.text===verb+" run "+title || e.text===verb+" "+title)).at(-1);
          state=e?(e.text.startsWith("Passed")?"Complete":e.text.startsWith("Failed")?"Failed":"Running"):"Upcoming";
        }
        if(skipped)state="Skipped";
        const stepKey=checkStage?title:String(i);
        if(evidence[stepKey])state=evidence[stepKey];
        else if(completed && !skipped)state="No result";
        const row=element("li","",element("span","",title),element("small","",state));
        if(state==="Running")row.prepend(element("span","runtime-spinner"));
        if(evidence[stepKey])row.append(stepEvidenceButton(title,current,key,attempt?.id,stepKey));
        list.append(row);
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
          const line=element("p","",new Date(a.time*1000).toLocaleTimeString()+" · "+(a.reason ||
            (following?.reason && ["plan","repair"].includes(following.role)?following.reason:"Entered "+role.name)));
          const previous=element("ul","run-map-steps");
          for(const [stepKey,status] of Object.entries(a.evidence || {})){
            const title=checkStage?stepKey:steps[Number(stepKey)];
            previous.append(element("li","",element("span","",title),element("small","",status),
              stepEvidenceButton(title,current,key,a.id,stepKey,"View "+title+" for attempt "+(attemptIndex+1))));
          }
          archive.append(line);
          if(previous.childElementCount)archive.append(previous);
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
      if(!inspecting)await onProgress?.(data);
    }catch(error){taskTitle.textContent=error.message;}
    const active=run?.running || run?.stage==="question" || run?.stage==="question_retry" || group?.waiting;
    if(box.isConnected)setTimeout(refresh,active?2500:6500);
  }
  draw();queueMicrotask(refresh);
  return box;
}
