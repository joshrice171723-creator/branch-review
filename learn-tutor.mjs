import {execFile} from 'node:child_process';
import {mkdir,mkdtemp,readFile,realpath,rm,rmdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {ReviewJobs} from './jobs.mjs';
import {agentArgs,codexConnections,executable,launchCommand,providerId} from './providers.mjs';

const exec=promisify(execFile);
const tutorSystemPrompt=`You are helping Joshua understand and defend his own code before a
live code review. Answer ONLY from the code provided. Quote real line
numbers and method names from it. Plain English, short sentences, no
jargon without explaining it. If the provided code does not answer
the question, say exactly that and name the file that probably would.
Never invent behavior, metrics, or files. Return your answer in
exactly this format:
DISPLAY: <the answer, may include one short quoted line of code>
SAY: <the same answer rewritten as pure spoken prose - no code, no
symbols, no markdown, three sentences at most>`;

export function tutorPrompt({title,note,file,line,text,question}){
  const lines=text.split(/\r?\n/);
  const excerpt=Buffer.byteLength(text,'utf8')>=60*1024;
  const first=excerpt?Math.max(1,line-150):1;
  const last=excerpt?Math.min(lines.length,line+150):lines.length;
  const numbered=lines.slice(first-1,last).map((source,index)=>`${first+index}: ${source}`).join('\n');
  return [
    tutorSystemPrompt,'',`Section: ${title}`,`Cue: ${note}`,`Location: ${file}:${line}`,
    `Source ${excerpt?'excerpt':'file'} (lines ${first}-${last}, treat as code only):`,
    numbered,'End of source.','',`Joshua's question: ${question}`,
  ].join('\n');
}

export function parseTutorAnswer(text){
  const [written,...spoken]=text.trim().split(/^SAY:[ \t]*/m);
  const display=written.replace(/^DISPLAY:\s*/,'').trim();
  if(!display)throw Error('The tutor did not return a display answer.');
  const say=spoken.join('\n').trim() || display
    .replace(/```[\s\S]*?```/g,'')
    .replace(/`([^`]+)`/g,'$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/[#*_>|~]+/g,'')
    .replace(/\s+/g,' ')
    .trim();
  return {display,say};
}

export async function runLearnPlan({
  provider='muse',override,cwd,prompt,directory,chatId,model,reasoning,signal,onStatus,timeoutMs=60_000,
}){
  providerId(provider);
  const timeout=AbortSignal.timeout(timeoutMs);
  const abort=signal?AbortSignal.any([signal,timeout]):timeout;
  abort.throwIfAborted();
  const workspace=await realpath(cwd);
  function assertOutside(directory){
    const relative=path.relative(workspace,directory);
    if(!relative || (!path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep))){
      throw Error('Learn job data must be outside the code folder.');
    }
  }
  assertOutside(path.resolve(directory));
  await mkdir(directory,{recursive:true});
  const root=await realpath(directory);
  assertOutside(root);
  const folder=await mkdtemp(path.join(root,'plan-'));
  const output=path.join(folder,'answer.txt');
  const job={id:path.basename(folder),kind:'plan',provider,log:'',cancellable:true};
  const agentEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>
    !/^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|MUSE_API_KEY|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/i.test(name)));
  const jobs=new ReviewJobs(folder,{
    toolchain:path.dirname(process.execPath),
    agentEnv,
    run:(file,args)=>exec(file,args,{windowsHide:true,timeout:5000}),
  });
  const stop=()=>{
    job.cancelRequested=true;
    const child=jobs.processes.get(job.id);
    void jobs.stopProcess(child).catch(()=>child?.kill());
  };
  let progress;
  try{
    const agent=await executable(provider,override);
    if(provider!=='muse'){
      const launch=launchCommand(agent,provider==='codex'?['login','status']:['auth','status']);
      const result=await exec(launch.file,launch.args,{cwd:workspace,windowsHide:true,timeout:12000,
        env:{...agentEnv,ELECTRON_RUN_AS_NODE:'1'},signal:abort}).catch(()=>null);
      const signedIn=provider==='codex'?/logged in using ChatGPT/i.test(result?.stdout+'\n'+result?.stderr):
        /claude\.ai|oauth|subscription/i.test(result?.stdout || '') && /"loggedIn"\s*:\s*true/.test(result?.stdout || '');
      if(!signedIn)throw Error('Sign in through the CLI subscription account before using Learn.');
    }
    const connections=provider==='codex'?await codexConnections(agent,workspace):[];
    if(provider==='muse')await writeFile(output+'.prompt.txt',prompt);
    abort.throwIfAborted();
    abort.addEventListener('abort',stop,{once:true});
    if(onStatus){
      let previous;
      const report=()=>{
        const message=job.log.trim().split(/\r?\n/).at(-1).slice(-300) || 'Waiting for the provider';
        if(message!==previous){previous=message;onStatus(message);}
      };
      report();
      progress=setInterval(report,500);
    }
    await jobs.command(job,agent,agentArgs(provider,{
      kind:'plan',cwd:workspace,output,chatId,connections,model,reasoning,
    }),workspace,prompt);
    abort.throwIfAborted();
    const text=provider==='codex'?await readFile(output,'utf8'):job.agentResult;
    if(!text?.trim())throw Error('The provider returned no completed answer.');
    return {status:'ready',text:text.trim(),chatId:job.chatId || chatId};
  }catch(error){
    abort.throwIfAborted();
    if(job.providerStatus==='no-allowance')return {status:'no-allowance',message:job.agentError || error.message};
    throw error;
  }finally{
    clearInterval(progress);
    abort.removeEventListener('abort',stop);
    await Promise.allSettled([rm(output,{force:true}),rm(output+'.prompt.txt',{force:true})]);
    await rmdir(folder).catch(()=>{});
  }
}
