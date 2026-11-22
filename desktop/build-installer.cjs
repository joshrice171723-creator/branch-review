const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
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
function build(){
  if (process.platform !== 'win32') throw Error('Build the Windows installer on Windows.');
  const stageParent = fs.realpathSync(os.tmpdir());
  const stage = fs.mkdtempSync(path.join(stageParent, 'branch-review-nsis-'));
  try {
    run(process.execPath,['--require',path.join(__dirname,'nsis-progress.cjs'),
      path.join(root,'node_modules/electron-builder/cli.js'),'--config','desktop/installer.json',
      '--config.directories.output='+output,...localElectronOptions(),'--win','nsis','--x64','--publish','never'],
      {...process.env,BRANCH_REVIEW_NSIS_TEMPLATE_STAGE:path.join(stage,'templates')});
    const resources = path.join(output,'win-unpacked','resources');
    fs.accessSync(path.join(resources,'app','workbench','renderer.mjs'));
    if (fs.existsSync(path.join(resources,'runtime'))) throw Error('The installer contains an obsolete runtime bundle.');
    const framework=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319');
    const payload=path.join(output,`Branch-Review-${version}-Windows-x64-Payload.exe`);
    const setup=path.join(output,`Branch-Review-${version}-Windows-x64-Setup.exe`);
    const refs=['System.dll','System.Core.dll','System.Xaml.dll',path.join('WPF','WindowsBase.dll'),path.join('WPF','PresentationCore.dll'),path.join('WPF','PresentationFramework.dll')];
    run(path.join(framework,'csc.exe'),['/nologo','/target:winexe','/optimize+','/win32icon:'+path.join(__dirname,'icon.ico'),'/out:'+setup,'/resource:'+payload+',installer.exe',...refs.map(ref=>'/reference:'+path.join(framework,ref)),path.join(__dirname,'installer-window.cs')]);
    console.log('Animated installer: '+setup);
  } finally {
    if (path.dirname(stage) === stageParent && fs.realpathSync(stage) === stage) {
      fs.rmSync(stage, {recursive:true, force:true, maxRetries:3});
    }
  }
}
try { build(); } catch (error) { console.error(error.message); process.exitCode=1; }
