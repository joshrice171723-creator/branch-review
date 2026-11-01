const {spawn}=require('node:child_process');
const {mkdtemp,readFile,rm,access}=require('node:fs/promises');
const os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {findProjectCandidates}=require('./project-discovery.cjs');
async function askAgent(provider,cwd,prompt,override){
  const api=await import(pathToFileURL(path.join(__dirname,'..','providers.mjs')).href),file=await api.executable(provider,override),tmp=await mkdtemp(path.join(os.tmpdir(),'branch-review-chat-')),output=path.join(tmp,'reply.txt');
  try{
    const connections=provider==='codex'?await api.codexConnections(file,cwd):[];
    const args=api.agentArgs(provider,{kind:'plan',cwd,output,connections});if(provider==='codex')args.splice(args.indexOf('exec')+1,0,'--skip-git-repo-check');
    const cmd=api.launchCommand(file,args);let events='',job={provider};
    await new Promise((resolve,reject)=>{const child=spawn(cmd.file,cmd.args,{cwd,windowsHide:true,shell:false,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});let timed=false;const timer=setTimeout(()=>{timed=true;child.kill();},120000);child.stdout.on('data',chunk=>{events=(events+chunk).slice(-200000);});child.stderr.on('data',()=>{});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);for(const line of events.split('\n')){try{api.consumeAgentEvent(job,JSON.parse(line));}catch{}}if(code===0&&!job.agentError&&!timed)resolve();else reject(Error(timed?'The agent took too long. Try again.':job.agentError || 'The coding agent could not finish. Check its connection and try again.'));});child.stdin.on('error',()=>{});child.stdin.end(prompt);});
    const raw=provider==='claude'?job.agentResult:await readFile(output,'utf8');const text=String(raw||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(text);}catch{throw Error('The agent returned an unexpected response. Try again.');}
  }finally{await rm(tmp,{recursive:true,force:true});}
}
async function askProjectAgent(provider,messages){
  if(!Array.isArray(messages)||!messages.length||messages.length>16||messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>4000))throw Error('Please enter a shorter message.');
  const cwd=os.homedir(),candidates=await findProjectCandidates(cwd,messages);
  const prompt='These are possible matching Git project folders found on this computer: '+JSON.stringify(candidates)+'. If more than one could be the requested project, ask which one and mention enough of each path to distinguish them. If none match, search further or ask for a location. Help the user find an existing local Git project to review. Search only for matching folder names and Git repositories on local disks. Verify an explicitly supplied folder with Git before saying it is not a repository. If you cannot verify it, say so rather than guessing. Never modify files or run project code. Ask a short clarifying question if uncertain. Do not assume a project or invent a path. Reply only as JSON: {"message":"brief user-facing reply","projectPath":null or "absolute local path"}. Conversation follows:\n'+JSON.stringify(messages);
  const result=await askAgent(provider,cwd,prompt);
  if(typeof result.message!=='string')throw Error('The agent returned an unexpected response. Try again.');
  return {message:result.message.slice(0,2000),projectPath:typeof result.projectPath==='string' && path.isAbsolute(result.projectPath)?result.projectPath:null};
}
async function suggestPreviewRecipe(provider,repository,context='',override){
  const prompt='Inspect this local project read-only to determine how to start an isolated local web preview. Read project documentation and manifests as needed, but do not read secrets, modify files, install packages, or run project code. Return only JSON: {"recipe":null} if the setup is unclear or requires unknown credentials, external services, or unsupported platform commands. For databases, return null unless the project documents a separate safe preview database or data directory for each preview; never assume it is safe to use the normal project database. Otherwise return {"recipe":{"directory":".","setup":[],"start":["executable","argument"],"readyPath":"/","services":[],"env":{}}}. Use arguments as arrays, never a shell string. Use {port} for the allocated port. The working directory must be relative to the repository. For a static HTML site without its own server, the Python standard http.server is acceptable if Python is installed; check interpreter availability with a version command. Only give commands supported by evidence in this project or the user description. Never include credentials or secret values in commands or environment variables. Do not invent commands or credentials.';
  const result=await askAgent(provider,repository,prompt+' User description: '+JSON.stringify(context),override);
  if(!result || typeof result!=='object')throw Error('The agent could not determine preview setup.');
  const suggested=safeSuggestedRecipe(result.recipe || null);
  if((!suggested || suggested.start?.[1]==='-m' && suggested.start?.[2]==='http.server') && /\bhtml\b/i.test(context) && /\b(?:simple|static)\b/i.test(context) && !/\b(?:backend|database|api|server-side)\b/i.test(context) && await access(path.join(repository,'index.html')).then(()=>true,()=>false)){
    return {directory:'.',setup:[],start:['branch-review-static','{root}','{port}'],readyPath:'/',services:[],env:{}};
  }
  return suggested;
}
function safeSuggestedRecipe(recipe){
  if(recipe?.env && Object.keys(recipe.env).some(key=>/(?:secret|password|token|credential|api_?key|private_?key)/i.test(key)))return null;
  if(Array.isArray(recipe?.start) && /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(recipe.start[0] || '')) && recipe.start[1]==='-m' && recipe.start[2]==='http.server'){
    const args=recipe.start.slice(0,3);
    for(let i=3;i<recipe.start.length;i++){
      const arg=recipe.start[i];
      if(arg==='--bind'||arg==='-b'){i++;continue;}
      if(typeof arg==='string' && (arg.startsWith('--bind=') || /^-b.+/.test(arg)))continue;
      args.push(arg);
    }
    recipe.start=[...args,'--bind','127.0.0.1'];
  }
  return recipe;
}
module.exports={askProjectAgent,suggestPreviewRecipe,safeSuggestedRecipe};
