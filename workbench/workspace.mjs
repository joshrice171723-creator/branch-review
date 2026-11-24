import path from 'node:path';

import {createStore} from './store.mjs';
import {exportHandoff} from '../workbench-handoff.mjs';
import {createCoordinator} from './coordinator.mjs';
import {createQuality} from './quality.mjs';
import {createEnvironment} from './environment.mjs';
import {inspectRun} from './history.mjs';
import {probeProvider} from '../providers.mjs';
import {modelCatalog, WorkbenchProfile, presetDocuments} from './profile.mjs';
import {toolDescriptions, workspaceMcp} from './mcp.mjs';
import discovery from '../desktop/project-discovery.cjs';
import {observeWorkspace} from './coordinator/runtime-probes.mjs';
import {verifyHostHttpRegression} from './coordinator/health-regression.mjs';
import {repairRuntime} from './coordinator/health-repair.mjs';

const environmentRoutes = new Set([
  'environment','project-capabilities','project-instruction','design/preview',
  'design/app-process','design/app-process/setup','design/app-process/start','design/app-process/stop','design/app-process/auto','design/prepare-build',
  'prepare','cleanup/preview','cleanup','attachments','profile/import','profile/export','profile/parse',
  'capabilities','preview','preview/setup','preview/start','preview/stop'
]);

export async function recoverProjectPreview({incident, signal, history = [], environment, coordinator}) {
  const previous = history.filter(attempt => attempt.outcome !== 'running');
  const restored = previous.length ? await environment.verifyCurrentPreview({signal}) :
    await environment.recoverPreview({signal});
  if (restored.passed || restored.cancelled) return restored;
  const evidence = {process: await environment.dispatch('GET', 'design/app-process'),
    capabilities: await environment.capabilities({routes: false}), lastRecovery: restored};
  const diagnosis = await coordinator.diagnosePreview({incident, history, evidence, signal});
  if (diagnosis.action === 'handled') return environment.verifyCurrentPreview({signal});
  if (diagnosis.action === 'retry-preview' || diagnosis.action === 'select-preview') {
    const alternatives = evidence.capabilities.previews.filter(item => item.mode === 'web' &&
      JSON.stringify(item.argv) !== JSON.stringify(evidence.process.settings?.argv));
    if (diagnosis.action === 'retry-preview' || alternatives.some(item => item.id === diagnosis.previewId)) {
      return environment.recoverPreview({signal, rerunSetup: false,
        previewId: diagnosis.action === 'select-preview' ? diagnosis.previewId : undefined});
    }
  }
  const nextAction = typeof diagnosis.nextAction === 'string' && diagnosis.nextAction.trim();
  const asksCoordinator = /(?:ask|request|tell).*coordinator|coordinator.*(?:ask|request|tell)/i.test(nextAction || '');
  const needsUser = diagnosis.requiresUser === true && nextAction && !asksCoordinator;
  return {passed: false, detail: diagnosis.summary || restored.detail, ...(needsUser && {nextAction})};
}

export async function createWorkspace({repository,local,git,origin,token,review,push,providerOptions,selectedAgent,diagnostics,canRepair,configureReviewPreviews,projectKind,beforeBrowserRecovery}) {
  const quality = await createQuality({repository});
  const tasks = await createStore(repository,{qualityPin:quality.pin,qualityCheck:quality.taskCheck,
    browserPreview: () => environment.browserPreview(), browserArtifacts: local && path.join(local, 'browser-checks')});
  let coordinator;
  const environment = await createEnvironment({repository,store:tasks,git,local,origin,
    defaultProfile:()=>WorkbenchProfile.initial(presetDocuments),
    savedPreview:async()=> (await coordinator.dispatch('design')).preview,
    selectedAgent,
    isActive:({coordinator: fromCoordinator} = {}) => fromCoordinator ?
      coordinator?.busyForProjectSetup?.() || false : coordinator?.busy?.() || false,
    verifyPreview: diagnostics?.verifyPreview?.bind(diagnostics)
  });
  const readEnvironment = (route,params=new URLSearchParams()) => environment.dispatch('GET',route,{},params);
  coordinator = await createCoordinator({
    repository,store:tasks,git,review,push,providerOptions,
    stageToolCall:call, superviseFailures:true, prepareBuild: environment.prepareBuild,
    prepareBrowserRecovery: async options => {
      await beforeBrowserRecovery?.();
      return environment.prepareBrowserRecovery(options);
    },
    refreshPreviewAfterBuild: environment.refreshAfterBuild,
    runtimeHealth: diagnostics && !process.env.BRANCH_REVIEW_PREVIEW_PARENT && {
      directory: diagnostics.healthDirectory,
      observe: () => observeWorkspace(diagnostics, environment.observePreview),
      recoverProject: (incident, signal, history) => recoverProjectPreview({incident, signal, history, environment, coordinator}),
      verifyRegression: (probe, signal) => verifyHostHttpRegression({probe, origin, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])}),
      idle: canRepair,
      repair: async (incident, directory, signal, mayApply, prior) => repairRuntime({
        repository: diagnostics.repository,
        incident, directory, signal, mayApply, prior, stageToolCall: call, packaged: diagnostics.packaged,
        profile: await tasks.getProfile(), providerOptions: await providerOptions()
      }),
      restartRequired: row => diagnostics.notifyRestartRequired(row)
    },
    providerProbe:(provider,override)=>probeProvider(provider,override,{liveMuse:false}),
    projectEvidence:()=>readEnvironment('project-capabilities'),
    saveQualityDraft: payload => quality.mcp('quality_draft', payload),
    qualityDraft:()=>quality.dispatch('GET','quality',{},new URLSearchParams()),
    validateQuality:definition=>quality.dispatch('POST','quality/validate',{definition},new URLSearchParams())
  });

  if (diagnostics) diagnostics.onOperationFailure = coordinator.reportOperation;

  async function status() {
    return {engine:'native',project:repository,installed:true,connected:true,mounted:true,
      upgradeAvailable:false,managed:true};
  }

  async function prepare(context = {}) {
    await tasks.initialize();
    return environment.prepare({}, context);
  }

  async function bootstrap() {
    const [config,profile,questions,design,runs,profileApplied] = await Promise.all([
      tasks.config(),tasks.getProfile(),tasks.questions(),coordinator.dispatch('design'),tasks.listRuns(),tasks.profileApplied()
    ]);
    const selected = runs.runs.find(row=>row.id===runs.active);
    const active = selected ? {...selected,status:selected.lifecycle.status} : null;
    return {project:{path:repository,label:repository.split(/[\\/]/).filter(Boolean).at(-1),exists:true,kind:projectKind},
      installed:true,profile_applied:profileApplied,profile,config,
      questions:questions?.questions ?? questions ?? [],active_task:active ?? null,
      design_layout:design.layout || {},design,csrf_token:token,host_links:[{name:'Branch Review',url:origin}]};
  }

  const qualityCall = (method,operation,data={},params=new URLSearchParams()) =>
    quality.dispatch(method,operation,data,params);

  async function call(name,values,{signal, coordinator: fromCoordinator = false} = {}) {
    if (name.startsWith('quality_')) return quality.mcp(name,values);
    switch(name) {
      case 'find_local_projects': return {projects:await discovery.findLocalProjects(values.query)};
      case 'get_profile': return tasks.getProfile();
      case 'inspect_run': return inspectRun(repository,values.runId,values);
      case 'project_capabilities': return readEnvironment('project-capabilities');
      case 'inspect_environment': return readEnvironment('environment');
      case 'prepare_environment': return prepare({coordinator: fromCoordinator});
      case 'configure_project_preview': return environment.dispatch('POST','design/app-process/setup',values,new URLSearchParams());
      case 'start_project_preview': return environment.dispatch('POST','design/app-process/auto',
        {...values,retry:true,signal},new URLSearchParams());
      case 'restart_project_preview': return environment.recoverPreview({signal, previewId:values.id});
      case 'stop_project_preview': return environment.dispatch('POST','design/app-process/stop',{},new URLSearchParams());
      case 'configure_review_previews':
        if (!configureReviewPreviews) throw Error('Review preview setup is unavailable.');
        return configureReviewPreviews(values);
      case 'preview_cleanup': return environment.dispatch('POST','cleanup/preview',{},new URLSearchParams());
      case 'clean_environment': return environment.dispatch('POST','cleanup',values,new URLSearchParams());
      case 'set_repair_budget':
      case 'set_builder_effort': {
        const data = structuredClone(await tasks.getProfile());
        if (!data?.profiles?.[values.profile]) throw Error('Apply a workflow profile first.');
        const stages = data.profiles[values.profile].stages;
        const repair = name==='set_repair_budget';
        if (repair) stages.buildReview.limit=values.value;
        else stages.build.effort=values.value;
        await tasks.setProfile(data);
        return {profile:values.profile,field:repair?'stages.buildReview.limit':'stages.build.effort',value:values.value};
      }
      case 'app_list_factory_models':
        return Object.fromEntries(Object.entries(modelCatalog).filter(([name])=>name==='captured' || !values.provider || name===values.provider));
      default: throw Error('Unknown project tool.');
    }
  }

  async function dispatch(method,route,data={},params=new URLSearchParams()) {
    if (route==='bootstrap' && method==='GET') return bootstrap();
    if (route==='setup' && method==='POST') return prepare();
    if (route==='app-tools' && method==='GET') return toolDescriptions();
    if (route==='profile') return method==='GET'?tasks.getProfile():tasks.setProfile(data);
    if (route==='package' && method==='GET') {
      const profile = await readEnvironment('profile/export');
      return {bytes:Buffer.from(JSON.stringify(profile,null,2)+'\n'),type:'application/json; charset=utf-8',
        download:'branch-review-workflow.json'};
    }
    if (route==='quality' || route.startsWith('quality/')) return qualityCall(method,route,data,params);
    if (environmentRoutes.has(route)) return environment.dispatch(method,route,data,params);
    return coordinator.dispatch(route,method==='GET'?Object.fromEntries(params):data,{method});
  }

  return {status,prepare,dispatch,
    exportHandoff: async runId => {
      try { return await exportHandoff(repository,runId,git,{store:tasks}); }
      catch (error) {
        if (error.code !== 'REVIEW_VERIFICATION_REQUIRED') {
          await coordinator.dispatch('design/review-outcome', {runId, opened:false, error:error.message}, {method:'POST'});
          throw error;
        }
        await coordinator.dispatch('design/recover-review', {runId}, {method:'POST'});
        try { return await exportHandoff(repository,runId,git,{store:tasks}); }
        catch (blocked) {
          await coordinator.dispatch('design/review-outcome', {runId, opened:false, error:blocked.message}, {method:'POST'});
          throw blocked;
        }
      }
    },
    open:async()=>({src:'/workspace/',project:repository,managed:true}),
    cleanupPreview:()=>environment.dispatch('POST','cleanup/preview',{},new URLSearchParams()),
    mcp:(message,verified)=>workspaceMcp(message,{call,getProfile:()=>tasks.getProfile(),verified}),
    busy:()=>coordinator.busy?.() || false,
    suspendRecovery:()=>coordinator.suspendRecovery(),
    prepareExit:()=>environment.close(),
    close:()=>{coordinator.close?.();void environment.close();void quality.dispose();}
  };
}
