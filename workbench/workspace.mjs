
import {createStore} from './store.mjs';
import {createCoordinator} from './coordinator.mjs';
import {createQuality} from './quality.mjs';
import {createEnvironment} from './environment.mjs';
import {inspectRun} from './history.mjs';
import {modelCatalog, WorkbenchProfile, presetDocuments} from './profile.mjs';
import {toolDescriptions, workspaceMcp} from './mcp.mjs';

const environmentRoutes = new Set([
  'environment','project-capabilities','project-instruction','design/preview',
  'design/app-process','design/app-process/setup','design/app-process/start','design/app-process/stop','design/app-process/auto',
  'prepare','cleanup/preview','cleanup','attachments','profile/import','profile/export','profile/parse',
  'capabilities','preview','preview/setup','preview/start','preview/stop'
]);

export async function createWorkspace({repository,local,git,origin,token,review,push,providerOptions,selectedAgent}) {
  const quality = await createQuality({repository});
  const tasks = await createStore(repository,{qualityPin:quality.pin,qualityCheck:quality.taskCheck});
  let coordinator;
  const environment = await createEnvironment({repository,store:tasks,git,local,origin,
    defaultProfile:()=>WorkbenchProfile.initial(presetDocuments),
    savedPreview:async()=> (await coordinator.dispatch('design')).preview,
    selectedAgent,
    isActive:()=>coordinator?.busy?.() || false
  });
  const readEnvironment = (route,params=new URLSearchParams()) => environment.dispatch('GET',route,{},params);
  coordinator = await createCoordinator({
    repository,store:tasks,git,review,push,providerOptions,
    projectEvidence:()=>readEnvironment('project-capabilities'),
    qualityDraft:()=>quality.dispatch('GET','quality',{},new URLSearchParams()),
    validateQuality:definition=>quality.dispatch('POST','quality/validate',{definition},new URLSearchParams())
  });

  async function status() {
    return {engine:'native',project:repository,installed:true,connected:true,mounted:true,
      upgradeAvailable:false,managed:true};
  }

  async function prepare() {
    await tasks.initialize();
    return environment.dispatch('POST','prepare',{},new URLSearchParams());
  }

  async function bootstrap() {
    const [config,profile,questions,design,runs,profileApplied] = await Promise.all([
      tasks.config(),tasks.getProfile(),tasks.questions(),coordinator.dispatch('design'),tasks.listRuns(),tasks.profileApplied()
    ]);
    const selected = runs.runs.find(row=>row.id===runs.active);
    const active = selected ? {...selected,status:selected.lifecycle.status} : null;
    return {project:{path:repository,label:repository.split(/[\\/]/).filter(Boolean).at(-1),exists:true},
      installed:true,profile_applied:profileApplied,profile,config,
      questions:questions?.questions ?? questions ?? [],active_task:active ?? null,
      design_layout:design.layout || {},design,csrf_token:token,host_links:[{name:'Branch Review',url:origin}]};
  }

  const qualityCall = (method,operation,data={},params=new URLSearchParams()) =>
    quality.dispatch(method,operation,data,params);

  async function call(name,values) {
    if (name.startsWith('quality_')) return quality.mcp(name,values);
    switch(name) {
      case 'get_profile': return tasks.getProfile();
      case 'inspect_run': return inspectRun(repository,values.runId);
      case 'project_capabilities': return readEnvironment('project-capabilities');
      case 'inspect_environment': return readEnvironment('environment');
      case 'prepare_environment': return prepare();
      case 'start_project_preview': return environment.dispatch('POST','design/app-process/auto',
        {...values,retry:true},new URLSearchParams());
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
    open:async()=>({src:'/workspace/',project:repository,managed:true}),
    cleanupPreview:()=>environment.dispatch('POST','cleanup/preview',{},new URLSearchParams()),
    mcp:(message,verified)=>workspaceMcp(message,{call,getProfile:()=>tasks.getProfile(),verified}),
    busy:()=>coordinator.busy?.() || false,
    close:()=>{coordinator.close?.();void environment.close();void quality.dispose();}
  };
}
