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
  const push = byId('apex-push');
  const publish = byId('apex-github-check');
  const download = byId('apex-evidence-download');
  const githubEvidence = byId('apex-github-evidence');
  const refresh = byId('apex-refresh-handoff');
  const review=byId('apex-review-run');
  const initialRun = new URLSearchParams(location.search).get('workbenchRun');
  let selectedRun = initialRun, receipt, requestId=0;
  function message(text) {status.textContent=text; status.hidden=!text;}
  async function action(button,fn) {
    button.disabled=true;
    try {await fn();} catch(error) {message(error.message);}
    finally {button.disabled=false;}
  }
  async function showSelection() {
    const request=++requestId;
    const reviewState=byId('apex-review-state'), checks=byId('apex-review-checks');
    reviewState.hidden=true; checks.hidden=true; checks.replaceChildren();
    push.hidden=true; push.onclick=null;
    publish.hidden=true; publish.onclick=null;
    download.hidden=true; githubEvidence.hidden=true;
    byId('apex-findings').hidden=true;
    byId('apex-repair').hidden=true;
    choiceList.replaceChildren();
    receipt=null;
    selectedRun=runPicker.value;
    const run=selectedRun;
    review.disabled=true;
    if(!run) return;
    const handoff=await api('/api/workbench-review?run='+encodeURIComponent(run));
    if(request!==requestId || handoff.runId!==selectedRun) return;
    review.disabled=['design-stale','branch-changed'].includes(handoff.status);
    const statuses={waiting:'Ready for review', reviewing:'Review in progress', approved:'Approved',
      'changes-requested':'Changes requested', 'branch-changed':'Branch moved. Review the current commit.',
      'not-exported':'Open this run in Branch Review.',
      'different-preview':'The preview shows a different commit. Review the source commit to approve this run.'};
    reviewState.textContent=[handoff.message || statuses[handoff.status],handoff.commit?.slice(0,8),
      handoff.base && 'Base '+handoff.base.slice(0,8)].filter(Boolean).join(' · ');
    reviewState.hidden=false;
    for(const slice of handoff.slices || []){
      const row=document.createElement('li');
      row.textContent=slice.title;
      if(slice.mockup){
        const details=document.createElement('details'),summary=document.createElement('summary');
        summary.textContent='View mockup';
        const mockup=document.createElement('img');
        mockup.alt='Design mockup for '+slice.title;mockup.loading='lazy';
        mockup.src='/api/workbench-mockup?'+new URLSearchParams({run,slice:slice.id});
        details.append(summary,mockup);row.append(details);
      }
      checks.append(row);
    }
    if(handoff.status==='approved'){
      const branch=handoff.ref.slice('refs/heads/'.length);
      const destination=handoff.pushTarget;
      const pushed=handoff.delivery?.repository===destination;
      reviewState.textContent+=' · '+(destination ? destination+' / '+branch : handoff.pushMessage || 'Set a GitHub push remote.');
      if(pushed) reviewState.textContent+=' · Push confirmed';
      download.hidden=!handoff.evidenceUrl;download.href=handoff.evidenceUrl;
      githubEvidence.hidden=!handoff.delivery?.github;
      if(!githubEvidence.hidden) {
        githubEvidence.href=handoff.delivery.github.evidenceUrl;
        reviewState.textContent+=' · PR check published by @'+handoff.delivery.github.publisher;
      }
      push.hidden=!destination || pushed;
      push.onclick=()=>action(push,async()=>{
        if(!confirm('Push '+handoff.commit+' to '+destination+'/'+branch+'?')) return;
        message('Pushing the reviewed commit…');
        const {result}=await api('/api/workbench-push',{runId:run,commit:handoff.commit,expectedTarget:destination});
        await showSelection();
        message('Pushed '+result.commit.slice(0,8)+' to '+result.remote+'/'+branch+'.');
      });
      publish.hidden=!pushed || !githubEvidence.hidden;
      publish.onclick=()=>action(publish,async()=>{
        if(!confirm('Publish a manual review check and evidence summary for '+handoff.commit+' in '+destination+'?')) return;
        message('Publishing the GitHub PR check…');
        await api('/api/workbench-publish-check',{runId:run,commit:handoff.commit,expectedTarget:destination});
        await showSelection();
        message('GitHub confirmed the evidence comment and exact-commit check.');
      });
    }
    for(const item of handoff.checklist) {
      const row=document.createElement('li'); row.textContent=item.title+' · '+item.status.replaceAll('-',' '); checks.append(row);
    }
    checks.hidden=!checks.childElementCount;
    if(handoff.slices?.length && handoff.findings?.length) {
      reviewState.textContent+=' · Select the findings and affected slices in Design.';
      return;
    }
    const record=getState().record;
    if(!record || handoff.reviewId!==record.id || handoff.reviewedCommit!==handoff.commit) return;
    for(const finding of handoff.findings) {
      const label=document.createElement('label');
      const choice=document.createElement('input');
      choice.type='checkbox'; choice.value=finding.id;
      const location=finding.location || finding.scenario || finding.side;
      label.append(choice,document.createTextNode(' '+location+' · '+finding.actual+' · Expected '+finding.expected));
      choiceList.append(label);
    }
    byId('apex-findings').hidden=!choiceList.childElementCount;
  }
  async function showHandoff() {
    const runs=await api('/api/workbench-runs');
    runPicker.replaceChildren();
    for(const run of runs) runPicker.add(new Option(run.title+' · '+run.id,run.id));
    if(selectedRun && runs.some(run=>run.id===selectedRun)) runPicker.value=selectedRun;
    refresh.disabled=!runs.length;
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
      const missing=!details.installed && !details.connected;
      install.hidden=!missing && !details.upgradeAvailable;
      install.textContent=details.upgradeAvailable?'Upgrade Workbench':'Install Workbench for this project';
      if(missing) {
        handoffButton.disabled=true; frame.hidden=true;
        message('Install the Workbench runtime in this project to open the panel.');return;
      }
      const {result}=await api('/api/workbench-open',{});
      const address=new URL(result.src,location.origin).href;
      if(frame.src!==address) frame.src=address;
      frame.hidden=false; handoffButton.disabled=false; message('');
      selectedRun ||= getState().record?.identity.workbenchRun;
      if(selectedRun || !drawer.hidden) await showHandoff().catch(error=>message(error.message));
    } catch(error) {frame.hidden=true;message(error.message);}
  }
  byId('open-apex-panel').onclick=open;
  byId('close-apex-panel').onclick=()=>dialog.close();
  install.onclick=()=>action(install,async()=>{
    message(install.textContent==='Upgrade Workbench'?'Upgrading Workbench…':'Installing Workbench…');
    await api('/api/workbench-install',{});
    frame.src='about:blank';
    await open();
  });
  handoffButton.onclick=()=>action(handoffButton,async()=>{
    if(!drawer.hidden) {drawer.hidden=true;handoffButton.setAttribute('aria-expanded','false');message('');}
    else await showHandoff();
  });
  runPicker.onchange=()=>void showSelection().catch(error=>message(error.message));
  refresh.onclick=()=>action(refresh,async()=>{message('');await showHandoff();});
  if(window.desktop?.openWorkbenchEvidence) githubEvidence.onclick=async event=>{
    event.preventDefault();
    try {await window.desktop.openWorkbenchEvidence(githubEvidence.href);}
    catch(error){message(error.message);}
  };
  window.addEventListener('message',async event=>{
    if(event.source!==frame.contentWindow || !frame.src || event.origin!==new URL(frame.src).origin ||
       event.data?.type!=='workbench-review-run' || !/^\d{8}T\d{12}-[a-f0-9]{8}$/.test(event.data.runId))return;
    try{
      selectedRun=event.data.runId;
      await showHandoff();
      if(runPicker.value!==event.data.runId)throw Error('This run is not ready for Branch Review.');
      byId('apex-review-run').click();
    }catch(error){message(error.message);}
  });
  review.onclick=()=>action(review,async()=>{
    const {result}=await api('/api/workbench-export',{runId:selectedRun});
    const branch={ref:result.ref,sha:result.commit,name:result.ref.slice('refs/heads/'.length),
      subject:result.title,aliases:[],base:result.design?.base};
    if(await openBranch(branch,selectedRun)) dialog.close();
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
