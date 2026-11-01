const {spawn}=require('node:child_process');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
async function askProjectAgent(provider,messages){
  if(!Array.isArray(messages)||!messages.length||messages.length>16||messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>4000))throw Error('Please enter a shorter message.');
  const api=await import(pathToFileURL(path.join(__dirname,'..','providers.mjs')).href),file=await api.executable(provider),tmp=await mkdtemp(path.join(os.tmpdir(),'branch-review-chat-')),output=path.join(tmp,'reply.txt'),cwd=os.homedir();
  const prompt='Help the user find an existing local Git project to review. Search only for matching folder names and Git repositories in the user home. Verify an explicitly supplied folder with Git before saying it is not a repository. If you cannot verify it, say so rather than guessing. Never modify files or run project code. Ask a short clarifying question if uncertain. Do not assume a project or invent a path. Reply only as JSON: {"message":"brief user-facing reply","projectPath":null or "absolute local path"}. Conversation follows:\n'+JSON.stringify(messages);
  try{
    const connections=provider==='codex'?await api.codexConnections(file,cwd):[];
    const args=api.agentArgs(provider,{kind:'plan',cwd,output,connections});if(provider==='codex')args.splice(args.indexOf('exec')+1,0,'--skip-git-repo-check');
    const cmd=api.launchCommand(file,args);let events='',job={provider};
    await new Promise((resolve,reject)=>{const child=spawn(cmd.file,cmd.args,{cwd,windowsHide:true,shell:false,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});let stderr='',timed=false;const timer=setTimeout(()=>{timed=true;child.kill();},120000);child.stdout.on('data',chunk=>{events=(events+chunk).slice(-200000);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);for(const line of events.split('\n')){try{api.consumeAgentEvent(job,JSON.parse(line));}catch{}}if(code===0&&!job.agentError&&!timed)resolve();else reject(Error(timed?'The agent took too long. Try a more specific project name.':job.agentError || 'The coding agent could not finish. Check its connection and try again.'));});child.stdin.on('error',()=>{});child.stdin.end(prompt);});
    const raw=provider==='claude'?job.agentResult:await readFile(output,'utf8');const text=String(raw||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let result;try{result=JSON.parse(text);}catch{throw Error('The agent could not identify a project. Try describing it another way.');}
    if(typeof result.message!=='string')throw Error('The agent returned an unexpected response. Try again.');
    return {message:result.message.slice(0,2000),projectPath:typeof result.projectPath==='string' && path.isAbsolute(result.projectPath)?result.projectPath:null};
  }finally{await rm(tmp,{recursive:true,force:true});}
}
module.exports={askProjectAgent};
