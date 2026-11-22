const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {stageWindowsRuntimes}=require('./stage-windows-runtimes.cjs');
const root=path.resolve(__dirname,'..'), output=path.resolve(process.env.BRANCH_REVIEW_INSTALLER_OUTPUT || path.resolve(root,'../installers'));
const metadata=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const version=metadata.version;
function run(file,args,env=process.env){const result=spawnSync(file,args,{cwd:root,env,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw Error(`${path.basename(file)} failed (${result.status}).`);}
function localElectronOptions(){
  const relative='node_modules/electron/dist';
  const directory=path.join(root,relative);
  const versionFile=path.join(directory,'version');
  const expected=metadata.devDependencies.electron;
  if(!fs.existsSync(versionFile) || fs.readFileSync(versionFile,'utf8').trim()!==expected)return [];
  const probe=spawnSync(path.join(directory,'electron.exe'),['-p','process.versions.electron+"|"+process.arch'],
    {cwd:root,encoding:'utf8',windowsHide:true,timeout:60_000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  return probe.status===0 && probe.stdout.trim()===expected+'|x64' ? ['--config.electronDist='+relative] : [];
}
async function build(){
  const temporary=os.tmpdir();
  const sameDrive=path.parse(root).root.toLowerCase()===path.parse(temporary).root.toLowerCase();
  const stage=await stageWindowsRuntimes(sameDrive ? temporary : path.dirname(root));
  try {
    const stagedPath=path.relative(root,stage.bundle).split(path.sep).join('/');
    run(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--config','desktop/installer.json',
      '--config.directories.output='+output,...localElectronOptions(),'--win','nsis','--x64','--publish','never'],
      {...process.env,BRANCH_REVIEW_RUNTIME_STAGE:stagedPath});
    const bundled=path.join(output,'win-unpacked','resources','runtime');
    if(!fs.readFileSync(path.join(bundled,'windows-runtimes.json')).equals(fs.readFileSync(path.join(__dirname,'windows-runtimes.json')))){
      throw Error('The packaged runtime lock differs from the build lock.');
    }
    for(const spec of Object.values(require('./windows-runtimes.json'))){
      if(!fs.existsSync(path.join(bundled,spec.executable)))throw Error('The packaged app is missing its private Workbench runtimes.');
    }
    const framework=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319');
    const payload=path.join(output,`Branch-Review-${version}-Windows-x64-Payload.exe`);
    const setup=path.join(output,`Branch-Review-${version}-Windows-x64-Setup.exe`);
    const refs=['System.dll','System.Core.dll','System.Xaml.dll',path.join('WPF','WindowsBase.dll'),path.join('WPF','PresentationCore.dll'),path.join('WPF','PresentationFramework.dll')];
    run(path.join(framework,'csc.exe'),['/nologo','/target:winexe','/optimize+','/win32icon:'+path.join(__dirname,'icon.ico'),'/out:'+setup,'/resource:'+payload+',installer.exe',...refs.map(ref=>'/reference:'+path.join(framework,ref)),path.join(__dirname,'installer-window.cs')]);
    console.log('Animated installer: '+setup);
  } finally { await stage.cleanup(); }
}
build().catch(error=>{console.error(error.message);process.exitCode=1;});
