export function apexPanel({api,getState,openBranch}) {
  const byId = id => document.getElementById(id);
  const dialog = byId('apex-panel-dialog');
  const frame = byId('apex-panel-frame');
  const status = byId('apex-panel-status');
  const install = byId('install-apex-panel');
  const drawer = byId('apex-handoff');
  const runPicker = byId('apex-completed');
  const handoffButton = byId('apex-handoff-toggle');
  const choiceList = byId('apex-finding-choices');
  const initialRun = new URLSearchParams(location.search).get('workbenchRun');
  let selectedRun = initialRun, receipt;
  function message(text) {status.textContent=text; status.hidden=!text;}
  async function action(button,fn) {
    button.disabled=true;
    try {await fn();} catch(error) {message(error.message);}
    finally {button.disabled=false;}
  }
  async function showSelection() {
    const reviewState=byId('apex-review-state'), checks=byId('apex-review-checks');
    reviewState.hidden=true; checks.hidden=true; checks.replaceChildren();
    byId('apex-findings').hidden=true;
    byId('apex-repair').hidden=true;
    choiceList.replaceChildren();
    receipt=null;
    selectedRun=runPicker.value;
    const run=selectedRun;
    if(!run) return;
    let handoff;
    try {handoff=await api('/api/workbench-review?run='+encodeURIComponent(run));}
    catch {return;} // A completed run can be selected before its first handoff.
    if(handoff.runId!==selectedRun) return;
    const statuses={waiting:'Ready for review', reviewing:'Review in progress', approved:'Approved',
      'changes-requested':'Changes requested', 'branch-changed':'Branch moved. Review the current commit.',
      'different-preview':'The preview shows a different commit. Review the source commit to approve this run.'};
    reviewState.textContent=statuses[handoff.status]+' · '+handoff.commit.slice(0,8);
    reviewState.hidden=false;
    for(const item of handoff.checklist) {
      const row=document.createElement('li'); row.textContent=item.title+' · '+item.status.replaceAll('-',' '); checks.append(row);
    }
    checks.hidden=!checks.childElementCount;
    const record=getState().record;
    if(!record || handoff.commit!==record.identity.source || handoff.ref!==record.identity.ref) return;
    for(const finding of record.issues.filter(item=>item.status!=='resolved')) {
      const label=document.createElement('label');
      const choice=document.createElement('input');
      choice.type='checkbox'; choice.value=finding.id;
      label.append(choice,document.createTextNode(' '+(finding.actual || finding.expected || finding.id)));
      choiceList.append(label);
    }
    byId('apex-findings').hidden=!choiceList.childElementCount;
  }
  async function showHandoff() {
    const runs=await api('/api/workbench-runs');
    runPicker.replaceChildren();
    for(const run of runs) runPicker.add(new Option(run.title+' · '+run.id,run.id));
    if(selectedRun && runs.some(run=>run.id===selectedRun)) runPicker.value=selectedRun;
    byId('apex-review-run').disabled=!runs.length;
    drawer.hidden=false; handoffButton.setAttribute('aria-expanded','true');
    message(runs.length?'':'Complete a Workbench run to review its commit.');
    await showSelection();
  }
  async function open() {
    if(!dialog.open) dialog.showModal();
    message('Opening project Workbench…');
    try {
      const details=await api('/api/workbench');
      byId('apex-checkout').textContent='Project checkout · '+details.project;
      install.hidden=details.installed || details.connected;
      if(!install.hidden) {
        handoffButton.disabled=true; frame.hidden=true;
        message('Install the Workbench runtime in this project to open the panel.');return;
      }
      const {result}=await api('/api/workbench-open',{});
      const address=new URL(result.src,location.origin).href;
      if(frame.src!==address) frame.src=address;
      frame.hidden=false; handoffButton.disabled=false; message('');
      if(initialRun || !drawer.hidden) await showHandoff();
    } catch(error) {frame.hidden=true;message(error.message);}
  }
  byId('open-apex-panel').onclick=open;
  byId('close-apex-panel').onclick=()=>dialog.close();
  install.onclick=()=>action(install,async()=>{
    message('Installing Workbench in the selected project…');
    await api('/api/workbench-install',{});await open();
  });
  handoffButton.onclick=()=>action(handoffButton,async()=>{
    if(!drawer.hidden) {drawer.hidden=true;handoffButton.setAttribute('aria-expanded','false');message('');}
    else await showHandoff();
  });
  runPicker.onchange=()=>void showSelection().catch(error=>message(error.message));
  const review=byId('apex-review-run');
  review.onclick=()=>action(review,async()=>{
    const {result}=await api('/api/workbench-export',{runId:selectedRun});
    const inventory=await api('/api/branches');
    const branch=inventory.find(row=>row.ref===result.ref || row.aliases?.includes(result.ref));
    if(!branch || branch.sha!==result.commit) throw Error('The reviewed branch has moved. Choose a run for its current commit.');
    if(await openBranch({...branch,ref:result.ref},selectedRun)) dialog.close();
    else message('Finish the current review action or save pending changes, then try again.');
  });
  const prepare=byId('apex-pick-findings');
  prepare.onclick=()=>action(prepare,async()=>{
    const findings=[...choiceList.querySelectorAll('input:checked')].map(choice=>choice.value);
    if(!findings.length) throw Error('Select at least one finding.');
    const {result}=await api('/api/workbench-findings',{runId:selectedRun,reviewId:getState().record?.id,findings});
    receipt=result.id;
    byId('apex-repair-action').value=result.action;byId('apex-repair-scope').value=result.scope;
    byId('apex-repair').hidden=false;message('Review the action and scope before creating the task.');
  });
  const create=byId('apex-create-repair');
  create.onclick=()=>action(create,async()=>{
    const {result}=await api('/api/workbench-repair',{runId:selectedRun,receipt,
      action:byId('apex-repair-action').value,scope:byId('apex-repair-scope').value});
    byId('apex-repair').hidden=true;
    message('Created '+result.task_id+'. Open Live run to confirm its scope.');
  });
  return {open};
}
