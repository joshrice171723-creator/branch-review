const path=require('node:path');
async function welcomeProject({dialog}){
  const choice=await dialog.showMessageBox({type:'info',title:'Welcome to Branch Review',message:'Welcome to Branch Review',detail:'See your changes before they go live.\n\nTo get started, choose the project folder on your computer—the folder containing the code you want to review. Branch Review will check your setup next.\n\nYour code stays in its project folder. Nothing is merged or published during setup.',buttons:['Choose my project','I don’t have a project yet'],defaultId:0,cancelId:1});
  if(choice.response===0)return true;
  await dialog.showMessageBox({type:'info',title:'A project is needed',message:'Start with a project on this computer',detail:'Branch Review works with a local Git project. Once you have a project folder, open Branch Review again and choose it.',buttons:['Close']});
  return false;
}
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
module.exports={chooseRepository,availableRepository,welcomeProject};
