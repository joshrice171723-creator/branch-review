const path=require('node:path');
const links=Object.freeze({git:'https://git-scm.com/downloads/win',node:'https://nodejs.org/en/download',codex:'https://developers.openai.com/codex/cli/',claude:'https://code.claude.com/docs/en/setup',muse:'https://dev.meta.ai/docs/muse-code'});
function setupUrl(key){if(!Object.hasOwn(links,key))throw Error('Unknown setup help page.');return links[key];}
async function gitAvailable({exec,env=process.env}){
  const options={windowsHide:true,timeout:10000};
  try{await exec('git',['--version'],options);return true;}catch{}
  const roots=[env.ProgramFiles && path.join(env.ProgramFiles,'Git','cmd'),env.LOCALAPPDATA && path.join(env.LOCALAPPDATA,'Programs','Git','cmd')].filter(Boolean);
  for(const root of roots){try{await exec(path.join(root,'git.exe'),['--version'],options);env.PATH=[root,env.PATH || ''].filter(Boolean).join(path.delimiter);return true;}catch{}}
  return false;
}
async function requireGit({exec,dialog,openExternal}){
  if(await gitAvailable({exec}))return true;
  const result=await dialog.showMessageBox({type:'info',buttons:['Download Git','Close'],cancelId:1,message:'Install Git to get started',detail:'Branch Review is installed. Git is needed to open your project. Install Git for Windows, then reopen Branch Review. Your projects and reviews are unchanged.'});
  if(result.response===0)await openExternal(setupUrl('git'));
  return false;
}
module.exports={setupUrl,gitAvailable,requireGit};
