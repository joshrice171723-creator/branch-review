// Regenerate the Windows icon with the existing Electron runtime; no extra image dependency.
const {app,BrowserWindow}=require('electron');
const {readFile,writeFile}=require('node:fs/promises');
const path=require('node:path');
app.whenReady().then(async()=>{
 try{
  const svg=await readFile(path.join(__dirname,'icon.svg'),'utf8');
  const window=new BrowserWindow({show:false,width:256,height:256,webPreferences:{offscreen:true,backgroundThrottling:false}});
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="margin:0;background:transparent">'+svg));
  await new Promise(resolve=>setTimeout(resolve,500));
  const png=(await window.webContents.capturePage()).resize({width:256,height:256}).toPNG();
  const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  await writeFile(path.join(__dirname,'icon.ico'),Buffer.concat([header,png]));app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
