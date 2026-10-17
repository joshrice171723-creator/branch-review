import {access,readdir,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const exec=promisify(execFile);
export const providerNames={codex:'Codex',claude:'Claude Code'};
export function providerId(value='codex'){
  if(!Object.hasOwn(providerNames,value))throw Error('Choose Codex or Claude Code.');
  return value;
}
export async function executable(provider,override,env=process.env){
  providerId(provider);
  if(override || env['BRANCH_REVIEW_'+provider.toUpperCase()])return override || env['BRANCH_REVIEW_'+provider.toUpperCase()];
  const directories=(env.PATH || '').split(path.delimiter).filter(Boolean);
  if(provider==='claude' && (env.USERPROFILE || env.HOME))directories.push(path.join(env.USERPROFILE || env.HOME,'.local','bin'));
  for(const directory of directories){
    for(const candidate of [path.join(directory,process.platform==='win32'?provider+'.exe':provider),path.join(directory,'node_modules',provider==='claude'?'@anthropic-ai/claude-code/bin/claude.exe':'@openai/codex/bin/codex.js'),...(provider==='claude'?[path.join(directory,'node_modules/@anthropic-ai/claude-code/cli.js')]:[])]){
      if(await access(candidate).then(()=>true,()=>false))return candidate;
    }
  }
  if(provider==='codex' && env.LOCALAPPDATA){
    const bin=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    const versions=await readdir(bin,{withFileTypes:true}).catch(()=>[]);
    const candidates=await Promise.all(versions.filter(entry=>entry.isDirectory()).map(async entry=>{const file=path.join(bin,entry.name,'codex.exe'),info=await stat(file).catch(()=>null);return info?.isFile()?{file,time:info.mtimeMs}:null;}));
    const latest=candidates.filter(Boolean).sort((a,b)=>b.time-a.time)[0];if(latest)return latest.file;
  }
  throw Error(`${providerNames[provider]} CLI was not found. Install it or choose its executable in Workspace.`);
}
export function launchCommand(file,args){
  if(/\.[cm]?js$/i.test(file))return {file:process.execPath,args:[file,...args]};
  if(/\.(cmd|bat|ps1)$/i.test(file))throw Error('Choose the CLI executable or JavaScript entry file, not a shell wrapper.');
  return {file,args};
}
export async function probeProvider(provider,override){
  providerId(provider);
  let file;
  try{file=await executable(provider,override);}catch(error){return {provider,status:'missing',message:error.message};}
  const invoke=async args=>{const command=launchCommand(file,args);return exec(command.file,command.args,{windowsHide:true,timeout:15000,maxBuffer:16000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});};
  try{
    const version=(await invoke(['--version'])).stdout.trim();
    if(provider==='claude'){
      const match=version.match(/(\d+)\.(\d+)\.(\d+)/);
      if(!match || Number(match[1])<2 || (Number(match[1])===2 && (Number(match[2])<1 || Number(match[2])===1 && Number(match[3])<259)))return {provider,status:'upgrade',version,message:'Update Claude Code to 2.1.259 or later for restricted, unattended jobs.'};
    }
    try{
      const result=await invoke(provider==='claude'?['auth','status']:['login','status']);
      if(provider==='claude' && !JSON.parse(result.stdout).loggedIn)throw Error('Sign in required');
      return {provider,status:'ready',version,message:`${providerNames[provider]} is installed and signed in. A job may still encounter account or usage limits.`};
    }catch{return {provider,status:'sign-in',version,message:`Run ${provider==='claude'?'claude auth login':'codex login'} in your terminal, complete sign-in, then test the connection again.`};}
  }catch{return {provider,status:'unavailable',message:`Could not run ${providerNames[provider]}. Check its executable path and installation.`};}
}
export async function codexConnections(file,cwd){
  const launch=launchCommand(file,['--disable','plugins','--disable','apps','mcp','list','--json']);
  const result=await exec(launch.file,launch.args,{cwd,windowsHide:true,timeout:15000,maxBuffer:1000000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  const rows=JSON.parse(result.stdout);if(!Array.isArray(rows))throw Error('Could not inspect Codex connector configuration.');
  return rows.map(row=>row.name).filter(name=>typeof name==='string');
}
export function agentArgs(provider,{kind,cwd,output,chatId,connections=[],images=[]}){
  providerId(provider);
  if(provider==='codex' && connections.some(name=>! /^[A-Za-z0-9_-]+$/.test(name)))throw Error('Rename Codex connectors containing punctuation before running isolated jobs.');
  if(provider==='codex')return ['-a','never','-C',cwd,'--disable','plugins','--disable','apps','--disable','hooks',...connections.flatMap(name=>['-c',`mcp_servers.${name}.enabled=false`]),'exec','--sandbox',kind==='plan'?'read-only':'workspace-write',...(chatId?['resume',chatId]:[]),...(kind==='plan'?['--ephemeral']:[]),...images.flatMap(file=>['--image',file]),'--json','--color','never','--output-last-message',output,'-'];
  // Restricted file tools keep Claude inside the owned checkout. Host checks run separately.
  return ['-p','--restricted','--safe-mode','--permission-prompts','none','--permission-mode',kind==='plan'?'dontAsk':'acceptEdits','--tools',kind==='plan'?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write','--allowedTools','Read,Glob,Grep','--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--output-format','stream-json','--verbose',...(chatId?['--resume',chatId]:[]),...(kind==='plan'?['--no-session-persistence']:[])];
}
export function consumeAgentEvent(job,event){
  if((job.provider || 'codex')==='codex'){
    if(event.type==='thread.started')job.chatId=event.thread_id;
    if(event.type==='turn.failed')job.agentError=event.error?.message || 'Codex could not complete the request.';
  }else{
    if(event.type==='system' && event.subtype==='init')job.chatId=event.session_id;
    if(event.type==='result'){
      job.agentResult=typeof event.result==='string'?event.result:'';
      if(event.is_error || event.subtype!=='success')job.agentError=event.errors?.join('\n') || job.agentResult || 'Claude could not complete the request.';
    }
  }
}
