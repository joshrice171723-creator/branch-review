const { app, BrowserWindow, dialog, ipcMain, Menu, session, screen } = require('electron');
const { readFile, writeFile, appendFile, mkdir } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const exec = promisify(execFile);
const origin = 'http://127.0.0.1:4310';
let window, closing = false, home;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(launch).catch(error => { dialog.showErrorBox('Branch Review could not start', error.message); app.exit(1); });
}
async function launch() {
  const root = path.dirname(__dirname);
  const settingsPath = path.join(app.getPath('userData'), 'desktop.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'));
  home = process.env.BRANCH_REVIEW_HOME || settings.home || (app.isPackaged ? path.join(app.getPath('userData'), 'workspace') : path.join(root, '.local'));
  await mkdir(home, { recursive: true });
  process.env.BRANCH_REVIEW_HOME = home;
  await writeFile(settingsPath, JSON.stringify({...settings,home}));
  // Refuse to attach privileged desktop APIs to an unknown listener.
  const occupied = await fetch(origin + '/api/state', { signal: AbortSignal.timeout(1200) }).then(() => true, () => false);
  if (occupied) throw new Error('Port 4310 is already in use. Close the existing Branch Review server, then open this app again.');
  await import(pathToFileURL(path.join(root, 'server.mjs')).href);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  Menu.setApplicationMenu(null);
  const area=screen.getPrimaryDisplay().workAreaSize;
  const width=Math.min(area.width,Math.max(1000,Number(settings.window?.width)||1600)),height=Math.min(area.height,Math.max(700,Number(settings.window?.height)||1000));
  window = new BrowserWindow({ title: 'Branch Review', width, height, minWidth: 1000, minHeight: 700,
    backgroundColor: '#f6f7f5', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', details => {
    if (details.level === 'error') void appendFile(path.join(home, 'renderer-errors.log'), `${new Date().toISOString()} ${details.message.slice(0,2000)}\n`);
  });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  function trusted(event) {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Only the review workspace can request desktop actions.');
  }
  async function control(endpoint, data = {}) {
    const state = await fetch(origin + '/api/state').then(r => r.json());
    if (state.busy) throw new Error('Wait for the current operation to finish.');
    const response = await fetch(origin + endpoint, { method: 'POST', headers: { Origin: origin, 'X-Review-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    return result;
  }
  ipcMain.handle('review:choose-repository', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: 'Choose a local Git repository', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const repository = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: result.filePaths[0], windowsHide: true })).stdout.trim();
    const response = await dialog.showMessageBox(window, { type: 'question', buttons: ['Open repository', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'Switch repositories?', detail: 'Save any preview edits first. Branch Review will stop its previews and restart with the selected folder. The first supported preview adapter is Meta Clinic.' });
    if (response.response !== 0) return null;
    await control('/api/stop');
    for (let i = 0; i < 120; i++) { const state = await fetch(origin + '/api/state').then(r => r.json()); if (!state.busy) { if (state.status === 'error') throw new Error(state.error); break; } if (i === 119) throw new Error('Previews did not stop.'); await new Promise(r => setTimeout(r, 500)); }
    const project = createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 16);
    const newHome = path.join(app.getPath('userData'), 'projects', project);
    await mkdir(newHome, { recursive: true });
    const existing = JSON.parse(await readFile(path.join(newHome, 'config.json'), 'utf8').catch(() => '{}'));
    const previous = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8').catch(() => '{}'));
    await writeFile(path.join(newHome, 'config.json'), JSON.stringify({ ...existing, repository, toolchain: existing.toolchain || previous.toolchain || path.resolve(root, '../../work/toolchain/node_modules/.bin'), previewRoot: existing.previewRoot || path.join(newHome, 'previews') }, null, 2));
    await writeFile(settingsPath, JSON.stringify({...settings,home:newHome,window:{...window.getNormalBounds(),maximized:window.isMaximized()}}));
    delete process.env.BRANCH_REVIEW_HOME;
    closing = true; app.relaunch(); app.exit(0);
  });
  ipcMain.handle('review:capture', async event => {
    trusted(event);
    const png = await window.webContents.capturePage();
    return png.toDataURL();
  });
  ipcMain.handle('review:release-files', async event => {
    trusted(event);
    const key = await dialog.showOpenDialog(window, { title: 'Select the existing Lightsail SSH key', properties: ['openFile'] });
    if (key.canceled) return null;
    const recovery = await dialog.showOpenDialog(window, { title: 'Select the encrypted recovery archive folder', properties: ['openDirectory'] });
    if (recovery.canceled) return null;
    return { keyPath: key.filePaths[0], recoveryDirectory: recovery.filePaths[0] };
  });
  window.on('close', async event => {
    if (closing) return;
    event.preventDefault();
    const state = await fetch(origin + '/api/state').then(r => r.json()).catch(() => null);
    if (state?.busy) { await dialog.showMessageBox(window, {message:'Wait for the current operation to finish before closing Branch Review.'}); return; }
    const result=await dialog.showMessageBox(window, { type: 'question', buttons: ['Keep working', 'Close app, keep previews'], defaultId: 0, cancelId: 0,
      message: 'Close Branch Review?', detail: 'Previews and saved data remain available. Use Stop previews before closing if you want them stopped.' });
    if(result.response===1){
      try {await writeFile(settingsPath,JSON.stringify({...settings,home,window:{...window.getNormalBounds(),maximized:window.isMaximized()}}));}
      catch(error){await dialog.showMessageBox(window,{message:'Could not save window settings.',detail:error.message});return;}
      closing=true;app.exit(0);
    }
  });
  await window.loadURL(origin);
  if(settings.window?.maximized)window.maximize();
  window.show();
  await writeFile(path.join(home, 'desktop-start.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), electron: process.versions.electron, url: window.webContents.getURL() }));
}
