import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {authorTour,installedVoices} from './learn-author.mjs';
import {executable,providerId,providerNames} from './providers.mjs';
import {redact} from './jobs.mjs';

const run=promisify(execFile);
const git=async(cwd,...args)=>(await run('git',args,{cwd,windowsHide:true,timeout:10000,maxBuffer:4*1024*1024})).stdout.trim();
const efforts=['low','medium','high','xhigh','max','ultra'];
export async function makerRefs(repoPath){
  if(typeof repoPath!=='string' || !repoPath.trim())throw Error('Choose a repository folder.');
  const folder=await realpath(repoPath);
  const repo=await git(folder,'rev-parse','--show-toplevel');
  const refs=(await git(repo,'for-each-ref','--format=%(refname:short)','refs/heads')).split(/\r?\n/).filter(Boolean);
  return {repoPath:repo,refs};
}

async function providerOptions(){
  const cache=path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'models_cache.json');
  const catalog=await readFile(cache,'utf8').then(JSON.parse).catch(()=>({}));
  const models=(Array.isArray(catalog.models)?catalog.models:[]).filter(model=>model.visibility==='list' && typeof model.slug==='string')
    .map(model=>({id:model.slug,label:model.display_name||model.slug,reasoning:(model.supported_reasoning_levels || []).map(item=>item.effort).filter(value=>efforts.includes(value))}));
  const claude=await executable('claude').then(()=>true,()=>false);
  return [
    {id:'codex',name:providerNames.codex,models,reasoning:efforts,
      note:models.length?'':'The CLI default model will be used.'},
    {id:'muse',name:providerNames.muse,models:[{id:'muse-spark-1.3',label:'Muse Spark 1.3'}],
      reasoning:['none','minimal',...efforts]},
    {id:'claude',name:providerNames.claude,
      models:claude?['sonnet','opus','haiku'].map(id=>({id,label:id})):[],
      reasoning:claude?['low','medium','high','xhigh','max']:[],note:claude?'':'Claude Code CLI is unavailable.'},
  ];
}

export async function createMaker({directory,shared,library,agentSettings,preferences,savePreferences,reviewSource}){
  await mkdir(directory,{recursive:true});
  const file=path.join(directory,'maker-jobs.json');
  const saved=JSON.parse(await readFile(file,'utf8').catch(()=> '[]'));
  const jobs=new Map(saved.map(job=>[job.id,job.status==='running'
    ? {...job,status:'interrupted',error:'The app closed before this tour was finished.'}
    : job]));
  const controllers=new Map();
  let writes=Promise.resolve();
  function persist(){
    writes=writes.catch(()=>{}).then(async()=>{
      await writeFile(file+'.tmp',JSON.stringify([...jobs.values()].slice(-30),null,2));
      await rename(file+'.tmp',file);
    });
    return writes;
  }
  const get=id=>{
    const job=jobs.get(id);
    if(!job)throw Error('Tour job is unavailable.');
    return job;
  };
  async function review(id){
    if(!reviewSource)throw Error('Open this action from a completed review.');
    return reviewSource(id);
  }
  async function start(data){
    if(controllers.size)throw Error('Wait for the active tour or cancel it.');
    if(typeof data.instructions!=='string' || data.instructions.length>60000)throw Error('Enter tour instructions under 60,000 characters.');
    const reference=data.reviewId?await review(data.reviewId):null;
    const provider=providerId(data.providerId);
    const configured=await agentSettings();
    const input={
      repoPath:reference?.repoPath || data.repoPath,mode:reference?'diff':data.mode,
      base:reference?.base || data.base,head:reference?.head || data.head,branch:reference?.branch,
      requestText:reference?.requestText,findings:reference?.findings,
      instructions:data.instructions,providerId:provider,model:data.model,reasoning:data.reasoning,
      narrationVoice:data.narrationVoice,override:configured.executables?.[provider],
    };
    if(!['repo','diff'].includes(input.mode))throw Error('Choose a tour mode.');
    if(controllers.size)throw Error('Wait for the active tour or cancel it.');
    const controller=new AbortController();
    const job={id:randomUUID(),status:'running',phase:'Reading repo',provider,
      model:data.model || null,reasoning:data.reasoning || null,startedAt:new Date().toISOString()};
    controllers.set(job.id,controller);
    jobs.set(job.id,job);
    try{
      await savePreferences({maker:{provider,model:job.model,reasoning:job.reasoning,narrationVoice:data.narrationVoice}});
      await persist();
    }catch(error){
      controllers.delete(job.id);jobs.delete(job.id);throw error;
    }
    void (async()=>{
      try{
        const result=await authorTour(input,{directory:path.join(directory,'author-jobs'),shared,signal:controller.signal,
          onProgress:(phase,message)=>{
            const changed=job.phase!==phase;
            job.phase=phase;job.message=message?redact(message):phase;
            if(changed)void persist().catch(()=>{});
          }});
        controller.signal.throwIfAborted();
        const entry=await library.add({source:result.path,title:result.title});
        Object.assign(job,result,{tourId:entry.id,status:'succeeded',message:'Tour ready.'});
      }catch(error){
        job.status=controller.signal.aborted?'cancelled':'failed';
        job.error=redact(error.message);
        job.message=job.error;
      }finally{
        controllers.delete(job.id);
        job.finishedAt=new Date().toISOString();
        await persist().catch(()=>{});
      }
    })();
    return job;
  }
  return {get,review,start,refs:makerRefs,async options(){
    const [providers,voices,configured]=await Promise.all([providerOptions(),installedVoices(),agentSettings()]);
    return {providers,voices,defaults:{provider:configured.provider||'codex',model:configured.model,
      reasoning:configured.reasoning,...preferences().maker}};
  },cancel(id){
    const controller=controllers.get(id);
    if(!controller)throw Error('This tour job has finished.');
    controller.abort(Error('Tour creation stopped.'));
    return {ok:true};
  }};
}
