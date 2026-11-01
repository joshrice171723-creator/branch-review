const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('welcome',{probe:provider=>ipcRenderer.invoke('welcome:probe',provider),chat:(provider,messages)=>ipcRenderer.invoke('welcome:chat',provider,messages),choose:(provider,found)=>ipcRenderer.invoke('welcome:choose',provider,found)});
