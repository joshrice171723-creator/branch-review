const {BrowserWindow,dialog,ipcMain}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

exports.learnDoor=function learnDoor({origin,root,directory}){
  let learn,opening;
  const page=origin+'/learn.html';
  function trusted(event){
    if(!learn || event.sender!==learn.webContents || event.senderFrame!==learn.webContents.mainFrame || event.senderFrame.url!==page)
      throw Error('Only Learn can select its tour and repository folders.');
  }
  ipcMain.handle('learn:pick',async(event,kind)=>{
    trusted(event);
    if(!['folder','zip'].includes(kind))throw Error('Choose a tour ZIP or folder.');
    const result=await dialog.showOpenDialog(learn,kind==='zip'
      ? {properties:['openFile'],filters:[{name:'Tour ZIP',extensions:['zip']}]}
      : {properties:['openDirectory']});
    return result.canceled?null:result.filePaths[0];
  });
  ipcMain.handle('learn:back',event=>{trusted(event);learn.close();});
  async function open(parent,firstRun=false){
    if(learn && !learn.isDestroyed()){learn.show();learn.focus();return;}
    if(opening)return opening;
    opening=(async()=>{
      let stop;
      if(firstRun){
        const {startLearnOnly}=await import(pathToFileURL(path.join(root,'learn-service.mjs')).href);
        stop=await startLearnOnly({origin,root,directory});
      }
      try{
        learn=new BrowserWindow({title:'Learn — Walkthrough Player',width:1260,height:850,minWidth:790,minHeight:550,
          show:false,backgroundColor:'#101621',webPreferences:{preload:path.join(__dirname,'learn-preload.cjs'),
            contextIsolation:true,nodeIntegration:false,sandbox:true}});
        learn.setMenuBarVisibility(false);
        learn.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        learn.webContents.on('will-navigate',(event,url)=>{if(url!==page)event.preventDefault();});
        let closing=false;
        learn.on('close',event=>{
          if(closing)return;
          event.preventDefault();
          closing=true;
          learn.webContents.executeJavaScript('window.learnFlush?.()').catch(()=>{}).finally(()=>learn?.close());
        });
        learn.once('closed',async()=>{
          learn=null;
          await stop?.().catch(()=>{});
          if(!parent.isDestroyed()){parent.show();parent.focus();}
        });
        await learn.loadURL(page);
        parent.hide();
        learn.maximize();
        learn.show();
      }catch(error){
        learn?.destroy();
        await stop?.().catch(()=>{});
        throw error;
      }
    })();
    try{await opening;}finally{opening=null;}
  }
  return {open,focus:()=>{
    if(!learn || learn.isDestroyed())return false;
    learn.show();learn.focus();return true;
  }};
};
