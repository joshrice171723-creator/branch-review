const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('desktop', {
  chooseRepository: () => ipcRenderer.invoke('review:choose-repository'),
  capture: () => ipcRenderer.invoke('review:capture'),
  chooseReleaseFiles: () => ipcRenderer.invoke('review:release-files'),
});
