const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const root=path.resolve(__dirname,'..'), output=path.resolve(root,'../installers');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
function run(file,args){const result=spawnSync(file,args,{cwd:root,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
run(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--config','desktop/installer.json','--win','nsis','--x64','--publish','never']);
const framework=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319');
const payload=path.join(output,`Branch-Review-${version}-Windows-x64-Payload.exe`);
const setup=path.join(output,`Branch-Review-${version}-Windows-x64-Setup.exe`);
const refs=['System.dll','System.Core.dll','System.Xaml.dll',path.join('WPF','WindowsBase.dll'),path.join('WPF','PresentationCore.dll'),path.join('WPF','PresentationFramework.dll')];
run(path.join(framework,'csc.exe'),['/nologo','/target:winexe','/optimize+','/win32icon:'+path.join(__dirname,'icon.ico'),'/out:'+setup,'/resource:'+payload+',installer.exe',...refs.map(ref=>'/reference:'+path.join(framework,ref)),path.join(__dirname,'installer-window.cs')]);
