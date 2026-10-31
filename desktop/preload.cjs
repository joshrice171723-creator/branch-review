const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('desktop', {
  openSetupHelp: key => ipcRenderer.invoke('review:setup-help',key),
  chooseRepository: path => ipcRenderer.invoke('review:choose-repository',path),
  recentProjects: () => ipcRenderer.invoke('review:recent-projects'),
  forgetProject: path => ipcRenderer.invoke('review:forget-project',path),
  capture: rect => ipcRenderer.invoke('review:capture',rect),
  openPublished: url => ipcRenderer.invoke('review:open-published',url),
  chooseReleaseFiles: () => ipcRenderer.invoke('review:release-files'),
  startBrowserQa: input => ipcRenderer.invoke('review:browser-qa',input),
  stopBrowserQa: () => ipcRenderer.invoke('review:stop-browser-qa'),
  showBrowserQa: () => ipcRenderer.invoke('review:show-browser-qa'),
});
