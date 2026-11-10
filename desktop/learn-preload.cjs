const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('learnDesktop',{
  pick:kind=>ipcRenderer.invoke('learn:pick',kind),
  back:()=>ipcRenderer.invoke('learn:back'),
});
