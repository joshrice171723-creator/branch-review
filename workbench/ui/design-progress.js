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
    const expanded=detail.querySelector("details[open]")?detail.dataset.stageKey:null;
    const current=previewNext?null:run;
    const history=current?.attempts || [];
    const last=history.at(-1);
    const gate=previewNext?null:group;
    const pick=selectedStage || (gate?.waiting?"humanReview":last?.role || "plan");
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
      const waiting=key==="plan" && current?.stage==="question" || key==="humanReview" && gate?.waiting;
      const skipped=config?.enabled===false || attempt?.stage==="final_skip";
      const isReturn=next?.reason && ["plan","repair"].includes(next.role);
      const completed=Boolean(attempt && (next || current?.stage==="completed")) || key==="humanReview" && gate?.approved || key==="push" && gate?.pushed;
      const status=skipped?"Skipped":waiting?"Waiting for you":live?"Running":isReturn?"Returned":
        completed?"Complete":key==="repair"&&!attempt?"If requested":key==="push"?"On request":attempt?"Paused":"Upcoming";
      const card=button("",()=>{selectedStage=key;draw();},"stage-card run-map-card");
      card.dataset.stageKey=key;card.dataset.status=status;
      card.setAttribute("aria-pressed",String(key===pick));
      if(live)card.setAttribute("aria-current","step");
      card.append(live?element("span","runtime-spinner"):stageIcon(role),element("span","",element("strong","stage-name",role.name),
        element("small","stage-meta",status)));
      grid.append(card);
      if(key!==pick)continue;
      detail.dataset.stageKey=key;
      detail.replaceChildren(element("h3","",role.name),element("p","stage-meta",config?.provider || (key==="humanReview"?"Human":"Workbench")));
      let titles=steps;
      if(key==="baseline" || key==="checks"){
        const phase=key==="baseline"?"baseline":"after";
        const checks=(current?.checks || projectState.config?.checks || []).filter(c=>(c.phases || ["baseline","after"]).includes(phase));
        if(checks.length)titles=checks.map(c=>c.name);
      }
      const events=live?current.events:[];
      const hasAgentEvent=events.some(e=>!e.text.startsWith("Entered ") && e.actor!=="Workbench");
      const verdict=events.some(e=>e.text.startsWith("Audit verdict:"));
      const cursor=verdict?titles.length-1:hasAgentEvent && titles.length>1?1:0;
      const list=element("ol","run-map-steps");
      for(const [i,title] of titles.entries()){
        let state=completed?"Complete":live?(i<cursor?"Complete":i===cursor?"Running":"Upcoming"):"Upcoming";
        if(live && (key==="baseline" || key==="checks")){
          const e=events.filter(e=>["Started","Passed","Failed"].some(verb=>e.text===verb+" run "+title || e.text===verb+" "+title)).at(-1);
          state=e?(e.text.startsWith("Passed")?"Complete":e.text.startsWith("Failed")?"Failed":"Running"):"Upcoming";
        }
        if(skipped)state="Skipped";
        const row=element("li","",element("span","",title),element("small","",state));
        if(state==="Running")row.prepend(element("span","runtime-spinner"));
        list.append(row);
      }
      detail.append(list);
      if(waiting && current?.question && key==="plan")detail.append(element("p","",String(current.question)));
      if(live && events.length)detail.append(element("p","run-map-event",events.at(-1).text));
      if(key==="repair" && !attempt)detail.append(element("p","copy","A build or final audit can return work here. Checks run again after a repair."));
      if(attempts.length){
        const archive=element("details","",element("summary","",attempts.length===1?"1 attempt":attempts.length+" attempts"));
        archive.open=expanded===key;
        for(const a of attempts){
          const following=history[history.indexOf(a)+1];
          archive.append(element("p","",new Date(a.time*1000).toLocaleTimeString()+" · "+(a.reason ||
            (following?.reason && ["plan","repair"].includes(following.role)?following.reason:"Entered "+role.name))));
        }
        detail.append(archive);
      }
      if(config && definitions.some(r=>r.id===configId))detail.append(button("Stage settings",()=>{
        selected=configId;panelRoot.querySelector('[data-view="stages"]').click();
      }));
    }
    if(focus)grid.querySelector('[data-stage-key="'+focus+'"]')?.focus({preventScroll:true});
  }
  async function refresh(){
    if(!box.isConnected)return;
    if(document.hidden){setTimeout(refresh,8000);return;}
    try{
      const data=await api("design/progress");
      if(!box.isConnected)return;
      const fingerprint=JSON.stringify([data.run,data.review]);
      if(fingerprint!==previousState && !detail.contains(activeElement())){
        run=data.run;group=data.review;draw();previousState=fingerprint;
      }
      await onProgress?.(data);
    }catch(error){taskTitle.textContent=error.message;}
    const active=run?.running || run?.stage==="question" || run?.stage==="question_retry" || group?.waiting;
    if(box.isConnected)setTimeout(refresh,active?2500:6500);
  }
  draw();queueMicrotask(refresh);
  return box;
}
