const {chooseRepository,availableRepository}=require('./repository.cjs');
const {setupUrl,gitAvailable,requireGit}=require('./setup-help.cjs');
const {askProjectAgent,suggestPreviewRecipe}=require('./welcome-agent.cjs');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, screen, shell } = require('electron');
const { readFile, writeFile, appendFile, mkdir } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const exec = promisify(execFile);
const origin = 'http://127.0.0.1:4310';
if (!app.isPackaged && process.env.BRANCH_REVIEW_DEV === '1') {
  const devRoot = path.resolve(__dirname, '..', '.local-dev');
  app.setPath('userData', path.join(devRoot, 'desktop'));
  process.env.BRANCH_REVIEW_HOME ||= path.join(devRoot, 'workspace');
  delete process.env.META_CLINIC_REPO;
}
let window, welcomeWindow, closing = false, home;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(launch).catch(error => { dialog.showErrorBox('Branch Review could not start', error.message); app.exit(1); });
}
async function firstProject(detectProject) {
  const {probeProvider}=await import(pathToFileURL(path.join(path.dirname(__dirname),'providers.mjs')).href);
  const welcome=new BrowserWindow({title:'Branch Review',width:1000,height:720,minWidth:600,minHeight:500,backgroundColor:'#f6f7f4',webPreferences:{preload:path.join(__dirname,'welcome-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  welcomeWindow=welcome;welcome.setMenuBarVisibility(false);welcome.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const page=pathToFileURL(path.join(__dirname,'welcome.html')).href;
  welcome.webContents.on('will-navigate',(event,url)=>{if(url!==page)event.preventDefault();});
  return new Promise((resolve,reject)=>{
    let finished=false,foundProject=null;
    const finish=value=>{if(finished)return;finished=true;ipcMain.removeHandler('welcome:choose');ipcMain.removeHandler('welcome:probe');ipcMain.removeHandler('welcome:chat');ipcMain.removeHandler('welcome:help');ipcMain.removeHandler('welcome:git');resolve(value);};
    welcome.on('closed',()=>finish(null));
    const trustedWelcome=event=>{if(event.sender!==welcome.webContents || event.senderFrame!==welcome.webContents.mainFrame || event.senderFrame.url!==page)throw Error('Only the welcome screen can select a project.');};
    ipcMain.handle('welcome:probe',async(event,provider)=>{trustedWelcome(event);return probeProvider(provider);});
    ipcMain.handle('welcome:git',async event=>{trustedWelcome(event);return gitAvailable({exec});});
    ipcMain.handle('welcome:help',async(event,provider)=>{trustedWelcome(event);if(!['git','codex','claude','muse'].includes(provider))throw Error('Choose a coding agent.');await shell.openExternal(setupUrl(provider));});
    ipcMain.handle('welcome:chat',async(event,provider,messages)=>{
      trustedWelcome(event);foundProject=null;const agent=await probeProvider(provider);if(agent.status!=='ready')throw Error(agent.message);
      const reply=await askProjectAgent(provider,messages);
      if(finished || welcome.isDestroyed())throw Error('The welcome screen was closed.');
      if(reply.projectPath){try{const root=(await exec('git',['rev-parse','--show-toplevel'],{cwd:reply.projectPath,windowsHide:true,timeout:10000})).stdout.trim();foundProject=root;return {message:reply.message,project:{name:path.basename(root),path:root}};}catch{reply.message+=' I could not verify that folder as a Git project. Please provide another location.';}}
      return {message:reply.message,project:null};
    });
    ipcMain.handle('welcome:choose',async (event,provider,found)=>{
      trustedWelcome(event);const agent=await probeProvider(provider);if(agent.status!=='ready')throw Error(agent.message);
      if(!await requireGit({exec,dialog,openExternal:url=>shell.openExternal(url)}))return;
      let chosen;if(found){if(!foundProject || found!==foundProject || !await availableRepository(foundProject,exec))throw Error('That project is no longer available. Ask the agent to find it again.');chosen={repository:foundProject,projectInfo:await detectProject(foundProject)};}else chosen=await chooseRepository({dialog,window:welcome,exec,detectProject});if(!chosen)return;
      const trust=await dialog.showMessageBox(welcome,{buttons:['Open trusted project','Cancel'],cancelId:1,message:'Previews run this project’s code.',detail:'The agent may use your project instructions to set up a preview. Only open projects you trust.'});
      if(trust.response!==0)return;
      let suggestedRecipe=null;
      if(chosen.projectInfo.needsSetup){try{const {validateRecipe}=await import(pathToFileURL(path.join(path.dirname(__dirname),'project-settings.mjs')).href);const suggestion=await suggestPreviewRecipe(provider,chosen.repository);if(suggestion)suggestedRecipe=validateRecipe(suggestion);}catch{}}
      welcome.hide();finish({...chosen,provider,suggestedRecipe});
    });
    welcome.loadFile(path.join(__dirname,'welcome.html')).catch(error=>{ipcMain.removeHandler('welcome:choose');ipcMain.removeHandler('welcome:probe');ipcMain.removeHandler('welcome:chat');ipcMain.removeHandler('welcome:help');ipcMain.removeHandler('welcome:git');reject(error);});
  });
}
async function launch() {
  const root = path.dirname(__dirname);
  const {detectProject}=await import(pathToFileURL(path.join(root,'web-project.mjs')).href);
  const settingsPath = path.join(app.getPath('userData'), 'desktop.json');
  if (!app.isPackaged && process.env.BRANCH_REVIEW_DEV === '1') await mkdir(path.dirname(settingsPath), {recursive:true});
  const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'));
  home = (!app.isPackaged && process.env.BRANCH_REVIEW_DEV==='1' ? settings.home : process.env.BRANCH_REVIEW_HOME) || process.env.BRANCH_REVIEW_HOME || settings.home || (app.isPackaged ? path.join(app.getPath('userData'), 'workspace') : path.join(root, '.local'));
  await mkdir(home, { recursive: true });
  process.env.BRANCH_REVIEW_HOME = home;
  const configured=JSON.parse(await readFile(path.join(home,'config.json'),'utf8').catch(()=> '{}'));
  const previousRepository=process.env.META_CLINIC_REPO || configured.repository;
  if(previousRepository && !await requireGit({exec,dialog,openExternal:url=>shell.openExternal(url)})){app.quit();return;}
  const unavailable=previousRepository && !await availableRepository(previousRepository,exec);
  if(unavailable){
    const choice=await dialog.showMessageBox({type:'warning',buttons:['Choose a project','Close'],cancelId:1,message:'Your last project is unavailable.',detail:`${previousRepository}\n\nIt may have moved or its drive may be disconnected. Choose a project to continue. Existing reviews stay saved.`});
    if(choice.response!==0){app.quit();return;}
  }
  if(!previousRepository || unavailable){
    const chosen=previousRepository ? await chooseRepository({dialog,exec,detectProject}) : await firstProject(detectProject);
    if(!chosen){app.quit();return;}
    const {repository}=chosen;
    if(chosen.suggestedRecipe){const {readRecipe,saveRecipe}=await import(pathToFileURL(path.join(root,'project-settings.mjs')).href);if(!await readRecipe(home))await saveRecipe(home,chosen.suggestedRecipe);}
    if(!previousRepository && chosen.provider){const file=path.join(home,'agent-settings.json'),saved=JSON.parse(await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;}));await writeFile(file,JSON.stringify({...saved,provider:chosen.provider}));}
    if(previousRepository){const trust=await dialog.showMessageBox({buttons:['Open trusted project','Cancel'],cancelId:1,message:'Previews run this project’s code.',detail:'Branch Review creates isolated checkouts and installs locked web dependencies with install scripts disabled.'});if(trust.response!==0){app.quit();return;}}
    if(unavailable){
      const key=path.resolve(repository).toLowerCase();
      home=settings.projects?.[key] || path.join(app.getPath('userData'),'projects',createHash('sha256').update(key).digest('hex').slice(0,16));
      process.env.BRANCH_REVIEW_HOME=home;delete process.env.META_CLINIC_REPO;await mkdir(home,{recursive:true});
    }
    const existing=JSON.parse(await readFile(path.join(home,'config.json'),'utf8').catch(()=> '{}'));
    await writeFile(path.join(home,'config.json'),JSON.stringify({...existing,repository,previewRoot:existing.previewRoot || path.join(home,'previews')}));
  }
  const savedConfig=JSON.parse(await readFile(path.join(home,'config.json'),'utf8').catch(()=> '{}'));
  savedConfig.repository=process.env.META_CLINIC_REPO || savedConfig.repository;
  settings.projects={...settings.projects,[path.resolve(savedConfig.repository).toLowerCase()]:home};
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
  window = new BrowserWindow({ title: 'Branch Review', icon:path.join(__dirname,'icon.ico'), width, height, minWidth: 1000, minHeight: 700,
    backgroundColor: '#f6f7f5', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  if(welcomeWindow && !welcomeWindow.isDestroyed()){welcomeWindow.close();welcomeWindow=null;}
  if (!app.isPackaged && process.env.BRANCH_REVIEW_DEV === '1') {
    window.setTitle('Branch Review — Development');
    window.webContents.on('before-input-event', async (event, input) => {
      if (input.type !== 'keyDown' || !(input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) return;
      event.preventDefault();
      const state = await fetch(origin + '/api/state').then(r => r.json()).catch(() => null);
      if (!state || state.busy || state.jobsRunning || state.qaRunning) {
        await dialog.showMessageBox(window, {message:'Wait for the current operation to finish before refreshing.'}); return;
      }
      const choice = await dialog.showMessageBox(window, {type:'question',buttons:['Keep working','Refresh'],defaultId:0,cancelId:0,message:'Refresh the development window?',detail:'Save any unsaved form edits first. Saved reviews remain available.'});
      if (choice.response === 1) window.webContents.reload();
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', details => {
    if (details.level === 'error') void appendFile(path.join(home, 'renderer-errors.log'), `${new Date().toISOString()} ${details.message.slice(0,2000)}\n`);
  });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  function trusted(event) {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Only the review workspace can request desktop actions.');
  }
  ipcMain.handle('review:setup-help',async(event,key)=>{trusted(event);await shell.openExternal(setupUrl(key));});
  async function control(endpoint, data = {}) {
    const state = await fetch(origin + '/api/state').then(r => r.json());
    if (state.busy) { const error=new Error('Wait for the current operation to finish.');error.retryable=true;throw error; }
    const response = await fetch(origin + endpoint, { method: 'POST', headers: { Origin: origin, 'X-Review-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) { const error=new Error(result.error);error.retryable=response.status===409;throw error; }
    return result;
  }
  async function reportQa(data){
    for(let attempt=0;;attempt++){
      try{return await control('/api/browser-qa-result',data);}
      catch(error){if(!error.retryable || attempt>=40)throw error;await new Promise(resolve=>setTimeout(resolve,250));}
    }
  }
  const {state:runtimeState}=await import(pathToFileURL(path.join(root,'adapter.mjs')).href);
  runtimeState.automaticQa=false;
  let qaWindow,qaCancelled=false,qaTask,qaStarting=false;
  async function startQa(input){
    if(qaTask || qaStarting)throw Error('A browser run is already active.');
    qaStarting=true;
    try{
    const state=await fetch(origin+'/api/state').then(r=>r.json());
    if(state.record?.id!==input.id || state.status!=='ready')throw Error('Open the review before starting browser QA.');
    const {result:run}=await control('/api/browser-qa',input);if(run.reused)return run.id;qaCancelled=false;if(qaWindow&&!qaWindow.isDestroyed())qaWindow.close();
    const {runBrowserQa}=require('./browser-qa.cjs');
    qaTask=runBrowserQa({run,record:state.record,origin:`http://127.0.0.1:${state.changed.proxy}`,isCancelled:()=>qaCancelled,onWindow:browser=>{qaWindow=browser;runtimeState.browserQaWindowRunId=run.id;browser.on('closed',()=>{if(runtimeState.browserQaWindowRunId===run.id)runtimeState.browserQaWindowRunId=null;});},report:data=>reportQa({id:input.id,runId:run.id,commit:run.commit,...data})}).catch(async error=>{await control('/api/browser-qa-result',{id:input.id,runId:run.id,commit:run.commit,finish:'failed',error:error.message}).catch(()=>{});}).finally(()=>{qaTask=null;});
    return run.id;
    }finally{qaStarting=false;}
  }
  ipcMain.handle('review:browser-qa',async(event,input)=>{trusted(event);return startQa(input);});
  ipcMain.handle('review:stop-browser-qa',event=>{trusted(event);qaCancelled=true;if(qaWindow&&!qaWindow.isDestroyed())qaWindow.close();});
  ipcMain.handle('review:show-browser-qa',async event=>{trusted(event);const state=await fetch(origin+'/api/state').then(r=>r.json());if(!state.record?.browserQa?.some(run=>run.id===runtimeState.browserQaWindowRunId))throw Error('This review has no active QA browser. Open its saved evidence in Details.');if(qaWindow&&!qaWindow.isDestroyed()){qaWindow.show();qaWindow.focus();}});
  ipcMain.handle('review:recent-projects',async event=>{
    trusted(event);const current=path.resolve(savedConfig.repository).toLowerCase(),hidden=new Set(settings.hiddenProjects || []);
    const paths=[current,...(settings.recentProjects || []),...Object.keys(settings.projects || {})].filter((entry,index,all)=>all.indexOf(entry)===index && (entry===current||!hidden.has(entry)));
    return Promise.all(paths.map(async entry=>{
      const config=JSON.parse(await readFile(path.join(settings.projects?.[entry] || home,'config.json'),'utf8').catch(()=>'{}'));
      const display=typeof config.repository==='string' && path.resolve(config.repository).toLowerCase()===entry ? config.repository : entry;
      return {path:display,name:path.basename(display),current:entry===current,available:await availableRepository(display,exec)};
    }));
  });
  ipcMain.handle('review:forget-project',async(event,repository)=>{
    trusted(event);const key=typeof repository==='string'?path.resolve(repository).toLowerCase():'';
    if(!settings.projects?.[key] || key===path.resolve(savedConfig.repository).toLowerCase())throw Error('Choose a different saved project to remove.');
    settings.hiddenProjects=[...new Set([...(settings.hiddenProjects || []),key])];settings.recentProjects=(settings.recentProjects || []).filter(p=>p!==key);await writeFile(settingsPath,JSON.stringify({...settings,home}));return true;
  });
  ipcMain.handle('review:choose-repository', async (event,requested) => {
    trusted(event);
    let chosen;
    if(requested!==undefined){
      const key=typeof requested==='string'?path.resolve(requested).toLowerCase():'';
      if(!settings.projects?.[key])throw Error('Choose a saved project from the list.');
      if(key===path.resolve(savedConfig.repository).toLowerCase())return null;
      if(!await availableRepository(key,exec))throw Error('This project folder is unavailable. Use Locate folder to find it.');
      const repository=(await exec('git',['rev-parse','--show-toplevel'],{cwd:key,windowsHide:true})).stdout.trim();
      if(path.resolve(repository).toLowerCase()!==key)throw Error('This folder now belongs to a different project. Choose it as a new project.');
      chosen={repository,projectInfo:await detectProject(repository)};
    }else chosen=await chooseRepository({dialog,window,exec,detectProject,repository:savedConfig.repository});
    if(!chosen)return null;
    const {repository,projectInfo}=chosen;
    const response = await dialog.showMessageBox(window, { type: 'question', buttons: ['Open repository', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'Switch repositories?', detail: `Open ${projectInfo.name} using the ${projectInfo.kind} adapter? Previewing runs this repository’s code in isolated checkouts. Web previews install locked npm dependencies with install scripts disabled. Save preview edits first; existing reviews stay saved.` });
    if (response.response !== 0) return null;
    await control('/api/stop');
    for (let i = 0; i < 120; i++) { const state = await fetch(origin + '/api/state').then(r => r.json()); if (!state.busy) { if (state.status === 'error') throw new Error(state.error); break; } if (i === 119) throw new Error('Previews did not stop.'); await new Promise(r => setTimeout(r, 500)); }
    const project = createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 16);
    const newHome = settings.projects?.[path.resolve(repository).toLowerCase()] || path.join(app.getPath('userData'), 'projects', project);
    await mkdir(newHome, { recursive: true });
    const existing = JSON.parse(await readFile(path.join(newHome, 'config.json'), 'utf8').catch(() => '{}'));
    await writeFile(path.join(newHome, 'config.json'), JSON.stringify({ ...existing, repository, previewRoot: existing.previewRoot || path.join(newHome, 'previews') }, null, 2));
    const selectedKey=path.resolve(repository).toLowerCase();settings.hiddenProjects=(settings.hiddenProjects || []).filter(key=>key!==selectedKey);settings.recentProjects=[selectedKey,...(settings.recentProjects || []).filter(key=>key!==selectedKey)].slice(0,50);
    await writeFile(settingsPath, JSON.stringify({...settings,projects:{...settings.projects,[selectedKey]:newHome},home:newHome,window:{...window.getNormalBounds(),maximized:window.isMaximized()}}));
    delete process.env.BRANCH_REVIEW_HOME;
    closing = true; app.relaunch(); app.exit(0);
  });
  ipcMain.handle('review:capture', async (event,rect) => {
    trusted(event);
    if(rect){const [width,height]=window.getContentSize();if(!['x','y','width','height'].every(key=>Number.isInteger(rect[key]))||rect.x<0||rect.y<0||rect.width<1||rect.height<1||rect.x+rect.width>width||rect.y+rect.height>height)throw new Error('Capture must stay inside the review window.');}
    const png = await window.webContents.capturePage(rect);
    return png.toDataURL();
  });
  const { isReviewDestination } = await import(pathToFileURL(path.join(root, 'public/preview-routes.js')).href);
  ipcMain.handle('review:open-published',async(event,url)=>{trusted(event);const destination=new URL(url);if(destination.origin!=='https://aimetaclinic.com'||destination.username||destination.password||!isReviewDestination(url.slice(destination.origin.length)))throw new Error('Choose a Meta Clinic workflow URL.');await shell.openExternal(destination.href);});
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
    if (state?.busy || state?.jobsRunning || state?.qaRunning) { await dialog.showMessageBox(window, {message:'Wait for jobs to finish or stop browser QA before closing Branch Review.'}); return; }
    const result=await dialog.showMessageBox(window, { type: 'question', buttons: ['Keep working', 'Close app'], defaultId: 0, cancelId: 0,
      message: 'Close Branch Review?', detail: 'Reviews stay saved. Generic preview processes stop when the app closes. Meta Clinic previews remain available until you stop them.' });
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
