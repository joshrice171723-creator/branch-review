import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const exec=promisify(execFile);
export const museBillingMessage='Muse is signed in, but billing/allowance is not resolved.';
const billing=text=>/billing_error|(?:HTTP|API error)\s*402/i.test(text);
export function museUsage(stdout='',stderr=''){
  if(/not logged in/i.test(stdout+'\n'+stderr))return {status:'sign-in',message:'Run muse login in your terminal, complete sign-in, then test the connection again.'};
  let usage;try{usage=JSON.parse(stdout);}catch{}
  if(usage?.schemaVersion===1 && usage.reason==='no_allowance' && usage.allowance===null)return {status:'no-allowance',message:'Signed in — no allowance. '+museBillingMessage};
  return {status:'unverified',message:'Muse is installed; sign-in is not verified. Check connection to run a model smoke check.'};
}
export function museArgs({kind,cwd,output,chatId,images=[]}){
  return ['exec','--json','--workspace',cwd,'--disable-approval','--disable-shell','--disable-reminders','--disable-web-tools','--disable-request-user-input','--no-foreign-personal-context',...(kind==='plan'?['--disable-write']:[]),...(chatId?['--session-id',chatId]:[]),...images.flatMap(file=>['--image',file]),'--prompt-file',output+'.prompt.txt'];
}
export function consumeMuseEvent(job,event){
  if(event.schema_version!==1){job.agentStatus='Unrecognized Muse event: '+JSON.stringify(event);return;}
  const payload=event.payload || {};
  if(event.stream?.kind==='session')job.chatId=event.stream.id;
  job.agentStatus=payload.event?.message || payload.text || payload.reason || event.payload_type;
  if(event.payload_type?.startsWith('run.terminal.')){
    job.agentTerminal=payload.terminal;
    if(event.payload_type==='run.terminal.completed' && payload.terminal==='completed')job.agentResult=typeof payload.text==='string'?payload.text:'';
    else {job.agentError=billing(payload.reason || '')?museBillingMessage:payload.reason || 'Muse did not complete the request.';if(billing(payload.reason || ''))job.providerStatus='no-allowance';}
  }
}
export async function probeMuse(file){
  const options={windowsHide:true,timeout:15000,maxBuffer:1000000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}};
  const usage=await exec(file,['usage','--json'],options).catch(error=>({stdout:error.stdout || '',stderr:error.stderr || ''}));
  const state=museUsage(usage.stdout,usage.stderr);
  if(state.status!=='unverified')return state;
  // Only an actual successful model turn can establish readiness.
  const cwd=await mkdtemp(path.join(os.tmpdir(),'branch-review-muse-probe-'));
  try{
    await exec('git',['init','-q'],{...options,cwd});
    const result=await exec(file,['exec','--json','--workspace',cwd,'--disable-approval','--disable-write','--disable-shell','--disable-reminders','--disable-web-tools','--disable-request-user-input','--no-foreign-personal-context','--max-model-steps','1','Reply with MUSE_SMOKE_OK. Do not use tools.'],{...options,cwd,timeout:60000}).catch(error=>({stdout:error.stdout || '',stderr:error.stderr || '',failed:true}));
    const job={};let valid=true;
    for(const line of result.stdout.split('\n').filter(line=>line.trim())){try{consumeMuseEvent(job,JSON.parse(line));}catch{valid=false;}}
    if(job.providerStatus==='no-allowance' || billing(result.stderr))return {status:'no-allowance',message:'Signed in — no allowance. '+museBillingMessage};
    if(valid && !result.failed && !job.agentError && job.agentTerminal==='completed')return {status:'ready',message:'Muse completed a live model connection check.'};
    return {...state,message:job.agentError || 'Muse is installed; a successful model run has not been verified.'};
  }finally{await rm(cwd,{recursive:true,force:true});}
}
