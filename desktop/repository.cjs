const path=require('node:path');
async function chooseRepository({dialog,window,exec,detectProject,repository}){
  const show=(method,options)=>dialog[method](...(window?[window,options]:[options]));
  for(;;){
    const choice=await show('showOpenDialog',{title:'Choose a local Git project',properties:['openDirectory'],...(repository?{defaultPath:path.resolve(repository)}:{})});
    if(choice.canceled)return null;
    try{
      const repository=(await exec('git',['rev-parse','--show-toplevel'],{cwd:choice.filePaths[0],windowsHide:true})).stdout.trim();
      return {repository,projectInfo:await detectProject(repository)};
    }catch(error){
      const result=await show('showMessageBox',{type:'warning',buttons:['Choose another folder','Cancel'],cancelId:1,message:error.code==='ENOENT'?'Git is not installed or is not on PATH.':'This folder could not be opened as a Git project.',detail:error.code==='ENOENT'?'Install Git and reopen Branch Review. Your current project has not changed.':'Choose the project folder containing your Git checkout. Your current project has not changed.'});
      if(result.response!==0)return null;
    }
  }
}
async function availableRepository(repository,exec){
  try { await exec('git',['rev-parse','--show-toplevel'],{cwd:repository,windowsHide:true});return true; }
  catch { return false; }
}
module.exports={chooseRepository,availableRepository};
