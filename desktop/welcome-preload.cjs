const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('welcome',{probe:provider=>ipcRenderer.invoke('welcome:probe',provider),choose:provider=>ipcRenderer.invoke('welcome:choose',provider)});
