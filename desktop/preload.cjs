const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('desktop', {
  chooseRepository: () => ipcRenderer.invoke('review:choose-repository'),
  capture: rect => ipcRenderer.invoke('review:capture',rect),
  openPublished: url => ipcRenderer.invoke('review:open-published',url),
  chooseReleaseFiles: () => ipcRenderer.invoke('review:release-files'),
});
