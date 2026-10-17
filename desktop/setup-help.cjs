const links=Object.freeze({git:'https://git-scm.com/downloads/win',node:'https://nodejs.org/en/download',codex:'https://developers.openai.com/codex/cli/',claude:'https://code.claude.com/docs/en/setup'});
function setupUrl(key){if(!Object.hasOwn(links,key))throw Error('Unknown setup help page.');return links[key];}
async function requireGit({exec,dialog,openExternal}){
  try{await exec('git',['--version'],{windowsHide:true,timeout:10000});return true;}
  catch{
    const result=await dialog.showMessageBox({type:'info',buttons:['Download Git','Close'],cancelId:1,message:'Install Git to get started',detail:'Branch Review is installed. Git is needed to open your project. Install Git for Windows, then reopen Branch Review. Your projects and reviews are unchanged.'});
    if(result.response===0)await openExternal(setupUrl('git'));
    return false;
  }
}
module.exports={setupUrl,requireGit};
