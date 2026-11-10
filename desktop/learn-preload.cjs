const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('learnDesktop',{
  pick:kind=>ipcRenderer.invoke('learn:pick',kind),
  projects:()=>ipcRenderer.invoke('learn:projects'),
  back:()=>ipcRenderer.invoke('learn:back'),
});
