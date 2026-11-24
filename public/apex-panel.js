export function apexPanel({api, getState, openBranch, flush, reportError, refreshBranches,
    loadPanel = source => import(source)}) {
  const byId = id => document.getElementById(id);
  const workspace = byId('change-workspace');
  const factory = byId('factory-view');
  const preview = byId('review-workspace');
  const back = byId('open-apex-panel');
  const openProjectQa = byId('open-project-qa');
  const phase = byId('workspace-phase');
  const status = byId('apex-panel-status');
  const deliveryStatus = byId('apex-delivery-status');
  const install = byId('install-apex-panel');
  const retry = byId('retry-apex-panel');
  const recovery = byId('apex-recovery');
  const recoveryToggle = byId('apex-recovery-toggle');
  byId('tools-workspace').append(recoveryToggle, recovery);
  const drawer = byId('apex-handoff');
  const choiceList = byId('apex-finding-choices');
  const push = byId('apex-push');
  const publish = byId('apex-github-check');
  const download = byId('apex-evidence-download');
  const githubEvidence = byId('apex-github-evidence');
  const draft = byId('apex-pr-draft');
  const draftPanel = byId('apex-pr-draft-panel');
  const draftText = byId('apex-pr-draft-text');
  let selectedRun, receipt, requestId = 0, opening, panel, qa = false, selectedStage = 'plan';
  let deliveryKey, approvalKey, approvalSync;
  function message(text) {
    const target = qa ? deliveryStatus : status;
    target.textContent = text;
    target.hidden = !text;
  }
  async function action(button, fn) {
    button.disabled = true;
    try { await fn(); } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  }
  function showStage(stage) {
    selectedStage = stage;
    const labels = {plan:'Design', build:'Build', preview:'Preview', mockups:'Mockups', quality:'Quality',
      stages:'Workflow settings', documents:'Instructions', rules:'Shared rules', history:'History', live:'Run activity'};
    phase.textContent = qa ? 'Review' : labels[stage] || 'Design';
  }
  function showWorkspace(inQa) {
    qa = inQa;
    preview.hidden = !qa;
    back.hidden = !qa;
    openProjectQa.hidden = qa;
    byId('qa-conversation').hidden = !qa;
    if (qa) {
      recovery.hidden = true;
      recoveryToggle.setAttribute('aria-expanded', 'false');
      if (refreshBranches) void refreshBranches().catch(error => reportError(error.message));
    }
    workspace.dataset.qa = String(qa);
    panel?.setVisible?.(!qa);
    showStage(selectedStage);
  }
  function render(state) {
    if (!qa) return;
    const run = state.record?.identity.workbenchRun;
    drawer.hidden = !run;
    const key = JSON.stringify([run,state.record?.updatedAt,state.record?.approval]);
    if (!run || key === deliveryKey) return;
    deliveryKey = key;
    selectedRun = run;
    void showSelection().catch(error => {
      deliveryKey = null;
      message(error.message);
    });
  }
  async function syncApproval(handoff, runtime) {
    const key = handoff.runId + ':' + handoff.commit;
    if (approvalKey !== key) {
      approvalKey = key;
      approvalSync = runtime.syncReview({build:handoff.taskBuild,sha:handoff.commit}).catch(error => {
        if (approvalKey === key) { approvalKey = null; approvalSync = null; }
        throw error;
      });
    }
    await approvalSync;
  }
  async function showSelection() {
    const request=++requestId;
    const reviewState=byId('apex-review-state'), checks=byId('apex-review-checks');
    reviewState.hidden=true; checks.hidden=true; checks.replaceChildren();
    push.hidden=true; push.onclick=null;
    publish.hidden=true; publish.onclick=null;
    draft.hidden=true; draft.onclick=null; draftPanel.hidden=true; draftText.value='';
    download.hidden=true; githubEvidence.hidden=true;
    byId('apex-findings').hidden=true;
    byId('apex-repair').hidden=true;
    choiceList.replaceChildren();
    receipt=null;
    const run=selectedRun;
    if(!run) return;
    const handoff=await api('/api/workbench-review?run='+encodeURIComponent(run));
    if(request!==requestId || handoff.runId!==selectedRun) return;
    const statuses={waiting:'Ready for review', reviewing:'Review in progress', approved:'Approved',
      'changes-requested':'Changes requested', 'branch-changed':'Branch moved. Review the current commit.',
      'not-exported':'Open this run in Branch Review.',
      'different-preview':'The preview shows a different commit. Review the source commit to approve this run.'};
    reviewState.textContent=[handoff.message || statuses[handoff.status],handoff.commit?.slice(0,8),
      handoff.base && 'Base '+handoff.base.slice(0,8)].filter(Boolean).join(' · ');
    reviewState.hidden=false;
    byId('approved-plan').hidden = !handoff.approvedPlan;
    byId('approved-plan-text').textContent = handoff.approvedPlan || '';
    for(const slice of (handoff.slices || []).filter(item=>item.mockup)){
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
      if (handoff.taskBuild && panel) await syncApproval(handoff, panel);
      const branch=handoff.ref.slice('refs/heads/'.length);
      const destination=handoff.pushTarget;
      const pushed=handoff.delivery?.repository===destination;
      reviewState.textContent+=' · '+(destination ? destination+' / '+branch : handoff.pushMessage || 'Set a GitHub push remote.');
      if(pushed) reviewState.textContent+=' · Push confirmed';
      download.hidden=!handoff.evidenceUrl;download.href=handoff.evidenceUrl;
      draft.hidden=false;
      draft.onclick=()=>action(draft,async()=>{
        const result=await api('/api/workbench-pr-draft?run='+encodeURIComponent(run));
        if(request!==requestId) return;
        draftText.value=result.title+'\n\n'+result.body;
        draftPanel.hidden=false;
        draftText.focus();
        message('Draft ready. Attach the downloaded review evidence if your team needs the full results.');
      });
      githubEvidence.hidden=!handoff.delivery?.github;
      if(!githubEvidence.hidden) {
        githubEvidence.href=handoff.delivery.github.evidenceUrl;
        reviewState.textContent+=' · PR check published by @'+handoff.delivery.github.publisher;
      }
      push.hidden=!destination || pushed;
      push.onclick=()=>action(push,async()=>{
        if(!confirm('Push '+handoff.commit+' to '+destination+'/'+branch+'?')) return;
        message('Pushing the reviewed commit…');
        if (handoff.taskBuild && panel) {
          await panel.syncReview({build:handoff.taskBuild,sha:handoff.commit,expectedTarget:destination});
        } else {
          await api('/api/workbench-push',{runId:run,commit:handoff.commit,expectedTarget:destination});
        }
        await showSelection();
        message('Pushed '+handoff.commit.slice(0,8)+' to '+destination+'/'+branch+'.');
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
    checks.hidden=!checks.childElementCount;
    if(handoff.slices?.length && handoff.findings?.length) {
      reviewState.textContent+=' · Send your findings from the QA summary.';
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
  async function inspect(runId) {
    let handoff;
    message('Coordinator is checking the saved results and opening the review.');
    try {
      const {result} = await api('/api/workbench-export', {runId});
      handoff = result;
      const branch = {ref:result.ref,sha:result.commit,name:result.ref.slice('refs/heads/'.length),
        subject:result.title,aliases:[],base:result.design?.base};
      if (!await openBranch(branch, runId)) throw Error('Save changes in the current review and try again.');
      message('');
      showWorkspace(true);
      render(getState());
    } catch (error) {
      if (handoff) await api('/api/workspace/design/review-outcome',
        {runId,commit:handoff.commit,opened:false,error:error.message}).catch(() => {});
      message(error.message);
      if (error.code === 'REVIEW_VERIFICATION_REQUIRED') {
        const target = qa ? deliveryStatus : status;
        const design = await api('/api/workspace/design');
        const build = design.builds.at(-1);
        if (build?.status === 'review' && build.attempts.at(-1)?.task === runId && target.textContent === error.message) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.textContent = 'Retry verification';
          target.append(' ', retry);
          retry.onclick = async () => {
            retry.disabled = true;
            target.replaceChildren('Running the saved checks… ', retry);
            try {
              await api('/api/workspace/design/retry-verification', {build:build.id, runId});
            } catch (blocker) {
              target.replaceChildren(blocker.message + ' ', retry);
              retry.disabled = false;
              return;
            }
            await inspect(runId).catch(error => reportError(error.message));
          };
        }
      }
      throw error;
    }
  }

  function load() {
    if (panel) return Promise.resolve(panel);
    if (opening) return opening;
    opening = (async () => {
      retry.hidden = true;
      try {
        const info = await api('/api/workbench');
        if (!info.installed || info.upgradeAvailable) {
          install.hidden = false;
          message('Prepare this project to start a change.');
          return null;
        }
        message('Opening the change workspace…');
        const {result} = await api('/api/workbench-open', {});
        const address = new URL(result.src, location.origin);
        if (address.origin !== location.origin || address.pathname !== '/workspace/') {
          throw Error('Open the workspace for the selected project.');
        }
        const {mount} = await loadPanel(new URL('/workspace.js',address).href);
        panel = await mount(factory, {
          initialView:'workflow', onReview:inspect, onStageChange:showStage,
          workingFiles:base=>api('/api/changes?'+new URLSearchParams({base,working:'1'})),
          workingDiff:(base,file)=>api('/api/diff?'+new URLSearchParams({base,file,working:'1'})),
          openEditor:window.desktop?.openEditor,
          openPreview:window.desktop?.openAppPreview
        });
        recoveryToggle.hidden = !result.managed;
        panel.setVisible?.(!qa);
        if (qa) { deliveryKey = null; render(getState()); }
        message('');
        return panel;
      } catch (error) {
        retry.hidden = false;
        message(error.message);
        return null;
      }
    })().finally(() => { opening = null; });
    return opening;
  }

  async function open() {
    if (qa && !await flush()) return null;
    showWorkspace(false);
    return load();
  }
  async function completeReview(record) {
    const runId = record?.identity?.workbenchRun;
    if (!runId || getState().record?.id !== record.id) return;
    const handoff = await api('/api/workbench-review?run=' + encodeURIComponent(runId));
    if (!handoff.taskBuild) return;
    if (handoff.status !== 'approved' || handoff.reviewId !== record.id || handoff.commit !== record.identity.changed) {
      throw Error('The active review no longer matches this plan.');
    }
    const runtime = await load();
    if (!runtime) throw Error('Open Workbench to continue with the approved plan.');
    await syncApproval(handoff, runtime);
    if (getState().record?.id !== record.id) return;
    showWorkspace(false);
    runtime.openPlan();
  }

  async function repair(record, findings) {
    const runtime = await load();
    if (!runtime) throw Error('Open the project workspace to start a repair.');
    const runId = record.identity.workbenchRun;
    const handoff = await api('/api/workbench-review?run=' + encodeURIComponent(runId));
    if (handoff.reviewId !== record.id || handoff.commit !== record.identity.changed || !handoff.taskBuild) {
      throw Error('Open the current build commit before starting a repair.');
    }
    showWorkspace(false);
    await runtime.repair({build:handoff.taskBuild, sha:handoff.commit, reviewId:record.id, findingIds:findings.map(issue=>issue.id)});
  }

  back.onclick = () => void open().catch(error => reportError(error.message));
  openProjectQa.onclick = () => { showWorkspace(true); render(getState()); };
  retry.onclick = () => void load();
  install.onclick = () => action(install, async () => {
    message('Preparing the project runtime…');
    await api('/api/workbench-install', {});
    install.hidden = true;
    await load();
  });
  recoveryToggle.onclick=()=>{
    recovery.hidden=!recovery.hidden;
    recoveryToggle.setAttribute('aria-expanded',String(!recovery.hidden));
    if (!recovery.hidden) void readEnvironment();
  };
  async function readEnvironment() {
    const output = byId('workspace-environment-status');
    output.textContent='Reading project environment…';
    try {
      const details = await api('/api/workspace/environment');
      output.textContent = details.prepared ?
        'Project prepared. '+details.checks.length+' configured checks.' :
        'Prepare the project to discover check and preview commands.';
    } catch (error) { output.textContent=error.message; }
  }
  const prepareEnvironment = byId('workspace-prepare');
  prepareEnvironment.onclick=()=>action(prepareEnvironment,async()=>{
    await api('/api/workbench-prepare',{});
    panel?.dispose();
    panel=null;
    await load();
    await readEnvironment();
  });
  byId('workspace-copy-mcp').onclick=async()=>{
    try {
      await navigator.clipboard.writeText(new URL('/api/workspace/mcp',location.origin).href);
      byId('workspace-environment-status').textContent='MCP endpoint copied.';
    } catch (error) { byId('workspace-environment-status').textContent=error.message; }
  };
  let cleanupReceipt;
  const applyCleanup=byId('apex-cleanup-apply');
  applyCleanup.onclick=()=>action(applyCleanup,async()=>{
    if (!cleanupReceipt || !confirm('Clean the listed managed files?')) return;
    const result = await api('/api/workspace/cleanup',{previewId:cleanupReceipt});
    cleanupReceipt=null;
    byId('apex-cleanup-files').replaceChildren();
    byId('apex-cleanup-status').textContent='Cleaned '+result.removed+' entries.';
    applyCleanup.hidden=true;
  });
  const cleanup=byId('apex-cleanup-preview');
  cleanup.onclick=()=>action(cleanup,async()=>{
    const status=byId('apex-cleanup-status'),list=byId('apex-cleanup-files');
    list.replaceChildren();
    cleanupReceipt=null;
    applyCleanup.hidden=true;
    status.hidden=false;
    status.textContent='Reading managed scratch and temporary files…';
    try {
      const result=await api('/api/workbench-cleanup-preview');
      const count=result.entries.length;
      cleanupReceipt=result.previewId;
      applyCleanup.hidden=!count || !cleanupReceipt;
      status.textContent=count?`${count} entries · ${result.bytes.toLocaleString()} bytes`:'No managed files to clean.';
      for(const item of result.entries.slice(0,100)){
        const row=document.createElement('li');
        row.textContent=item.type==='directory'?item.path+'/':item.path+' · '+item.size.toLocaleString()+' bytes';
        list.append(row);
      }
      if(count>100) status.textContent+=' · Showing the first 100 entries.';
    } catch(error){status.textContent=error.message;}
  });
  byId('apex-pr-draft-copy').onclick=async()=>{
    try {await navigator.clipboard.writeText(draftText.value);message('Copied pull request draft.');}
    catch {draftText.select();message('Copy the selected draft.');}
  };
  if(window.desktop?.openWorkbenchEvidence) githubEvidence.onclick=async event=>{
    event.preventDefault();
    try {await window.desktop.openWorkbenchEvidence(githubEvidence.href);}
    catch(error){message(error.message);}
  };
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
    await open();
    message('Created repair task '+result.task_id+'.');
  });
  return {
    open, inspect, render, repair, completeReview,
    async prepareChecks(route) {
      const runtime = await open();
      runtime?.openQuality('prepare',{route});
    },
    prepare: () => api('/api/workbench-prepare', {}),
    openReview: () => {
      showWorkspace(true);
      render(getState());
      drawer.scrollIntoView({block:'nearest'});
    },
    openChat: async context => {
      const runtime = await load();
      if (runtime) runtime.openConversation(context);
    }
  };
}
