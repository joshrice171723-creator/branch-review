export async function setupChecks({git,run,defaultBranch,project,recipe,agent,probe,npm}){
  const rows=[];
  async function check(name,fn,help){try{rows.push({name,ok:true,message:await fn()});}catch(error){rows.push({name,ok:false,message:help || error.message,code:error.code});}}
  await check('Git',()=>run('git',['--version']),'Install Git, then reopen Branch Review.');
  await check('Repository',()=>git('rev-parse','--show-toplevel'),'Choose a folder containing a Git repository.');
  await check('Remote',async()=>{await git('remote','get-url','origin');return 'Origin is configured.';},'Add an origin remote to this repository, then fetch it.');
  await check('Default branch',defaultBranch,'Fetch origin and set its default branch before starting a review.');
  await check('Commit identity',async()=>{const name=await git('config','user.name'),email=await git('config','user.email');if(!name||!email)throw Error();return name;},'Set git user.name and user.email in this repository before requesting changes.');
  await check('Preview setup',async()=>{const saved=await recipe();if(project.error)throw Error(project.error);if(project.needsSetup&&!saved){const error=Error('Tell your agent a little more about this project so it can set up the preview.');error.code='preview-config';throw error;}if(!saved&&['vite','next'].includes(project.kind))await npm();return saved?'Saved custom preview commands.':project.kind==='meta-clinic'?'Existing Meta Clinic setup.':`${project.kind} detected. Preview commands are automatic.`;});
  await check(agent.provider==='claude'?'Claude connection':'Codex connection',async()=>{const result=await probe(agent.provider,agent.executable);if(result.status!=='ready')throw Error(result.message);return result.message;});
  return rows;
}
