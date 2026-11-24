const {chooseRepository,availableRepository}=require('./repository.cjs');
const {setupUrl,gitAvailable,requireGit}=require('./setup-help.cjs');
const {askProjectAgent,suggestPreviewRecipe}=require('./welcome-agent.cjs');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, screen, shell } = require('electron');
const { readFile, writeFile, appendFile, mkdir, realpath, stat } = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const exec = promisify(execFile);
const {hasPortOverride} = require('./local-origin.cjs');
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
function projectHandler(diagnostics, trusted, channel, title, run,
  completed = result => result !== null && result !== undefined, identify = () => channel) {
  ipcMain.handle(channel, async (event, ...args) => {
    trusted(event);
    const identity = identify(...args);
    try {
      const result = await run(event, ...args);
      if (completed(result)) await diagnostics.operation(title, identity);
      return result;
    } catch (error) {
      if (error.code !== 'USER_CANCELLED' && !error.coordinatorReported) await diagnostics.operation(title, identity, error);
      throw error;
    }
  });
}
const projectInputError = (message, action) => Object.assign(Error(message), {action});
const projectSelectionIdentity = requested => 'review:choose-repository:' +
  (typeof requested === 'string' ? path.resolve(requested).toLowerCase() : 'browse');

async function writeDesktopSettings(filename, content) {
  const {atomicJson} = await import(pathToFileURL(path.join(__dirname,'..','workbench','environment','paths.mjs')).href);
  await atomicJson(path.dirname(filename),path.basename(filename),JSON.parse(content));
}

async function verifyProjectSelection({intent, repository, loaded, diagnostics, clear, title='Open a project', nextAction='Choose the project again'}) {
  if (!intent) return false;
  if (typeof intent.repository !== 'string' || typeof intent.identity !== 'string') {
    await clear();
    return false;
  }
  if (path.resolve(intent.repository).toLowerCase() !== path.resolve(repository).toLowerCase()) {
    await diagnostics.operation(title, intent.identity,
      projectInputError('The selected project did not open. Choose it again from Projects.', nextAction));
    await clear();
    return false;
  }
  if (!loaded) return false;
  await clear();
  await diagnostics.operation(title, intent.identity);
  return true;
}

async function firstProject(detectProject, diagnostics) {
  const {probeProvider}=await import(pathToFileURL(path.join(path.dirname(__dirname),'providers.mjs')).href);
  const welcome=new BrowserWindow({title:'Branch Review',width:1000,height:720,minWidth:600,minHeight:500,backgroundColor:'#f6f7f4',webPreferences:{preload:path.join(__dirname,'welcome-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  welcomeWindow=welcome;welcome.setMenuBarVisibility(false);welcome.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const page=pathToFileURL(path.join(__dirname,'welcome.html')).href;
  welcome.webContents.on('will-navigate',(event,url)=>{if(url!==page)event.preventDefault();});
  return new Promise((resolve,reject)=>{
    let finished=false,foundProject=null;
    const readyProviders=new Set();
    const finish=value=>{if(finished)return;finished=true;ipcMain.removeHandler('welcome:choose');ipcMain.removeHandler('welcome:probe');ipcMain.removeHandler('welcome:chat');ipcMain.removeHandler('welcome:help');ipcMain.removeHandler('welcome:git');resolve(value);};
    welcome.on('closed',()=>finish(null));
    const trustedWelcome=event=>{if(event.sender!==welcome.webContents || event.senderFrame!==welcome.webContents.mainFrame || event.senderFrame.url!==page)throw Error('Only the welcome screen can select a project.');};
    projectHandler(diagnostics, trustedWelcome, 'welcome:probe', 'Check coding agent', async(event,provider)=>{
      trustedWelcome(event);readyProviders.delete(provider);
      const result=await probeProvider(provider);
      if(result.status==='ready')readyProviders.add(provider);
      else await diagnostics.operation('Check coding agent', 'welcome:probe', projectInputError(result.message, 'Check connection'));
      return result;
    }, result => result.status === 'ready');
    projectHandler(diagnostics, trustedWelcome, 'welcome:git', 'Check Git', async event=>{
      const ready=await gitAvailable({exec});
      if(!ready)await diagnostics.operation('Check Git', 'welcome:git', projectInputError('Git is required to open a project.', 'Get Git'));
      return ready;
    }, result=>result===true);
    projectHandler(diagnostics, trustedWelcome, 'welcome:help', 'Open setup help', async(event,provider)=>{
      if(!['git','codex','claude','muse'].includes(provider))throw projectInputError('Choose a coding agent.', 'Choose a coding agent');
      await shell.openExternal(setupUrl(provider));return true;
    });
    projectHandler(diagnostics, trustedWelcome, 'welcome:chat', 'Find a project', async(event,provider,messages)=>{
      trustedWelcome(event);foundProject=null;const agent=await probeProvider(provider);if(agent.status!=='ready')throw projectInputError(agent.message, 'Check connection');
      const reply=await askProjectAgent(provider,messages);
      if(finished || welcome.isDestroyed())throw Object.assign(Error('The welcome screen was closed.'), {code:'USER_CANCELLED'});
      if(reply.projectPath){
        try{
          const root=(await exec('git',['rev-parse','--show-toplevel'],{cwd:reply.projectPath,windowsHide:true,timeout:10000})).stdout.trim();
          foundProject=root;
          await diagnostics.operation('Verify project folder', 'welcome:project-folder');
          return {message:reply.message,project:{name:path.basename(root),path:root}};
        }catch{
          await diagnostics.operation('Verify project folder', 'welcome:project-folder', projectInputError('The suggested folder could not be opened as a Git project.', 'Browse for a folder'));
          reply.message+=' I could not verify that folder as a Git project. Please provide another location.';
        }
      }
      return {message:reply.message,project:null};
    });
    projectHandler(diagnostics, trustedWelcome, 'welcome:choose', 'Open a project', async (event,provider,found)=>{
      trustedWelcome(event);
      if(!['codex','claude','muse'].includes(provider))throw Error('Choose a coding agent.');
      if(!await requireGit({exec,dialog,openExternal:url=>shell.openExternal(url)}))return;
      let chosen;if(found){if(!foundProject || found!==foundProject || !await availableRepository(foundProject,exec))throw projectInputError('That project is no longer available. Ask the agent to find it again.', 'Browse for a folder');chosen={repository:foundProject,projectInfo:await detectProject(foundProject)};}else chosen=await chooseRepository({dialog,window:welcome,exec,detectProject});if(!chosen)return;
      const trust=await dialog.showMessageBox(welcome,{buttons:['Open trusted project','Cancel'],cancelId:1,message:'Previews run this project’s code.',detail:'The agent may use your project instructions to set up a preview. Only open projects you trust.'});
      if(trust.response!==0)return;
      let suggestedRecipe=null;
      if(chosen.projectInfo.needsSetup && readyProviders.has(provider)){try{const {validateRecipe}=await import(pathToFileURL(path.join(path.dirname(__dirname),'project-settings.mjs')).href);const suggestion=await suggestPreviewRecipe(provider,chosen.repository);if(suggestion)suggestedRecipe=validateRecipe(suggestion);}catch{}}
      welcome.hide();finish({...chosen,provider,suggestedRecipe});return true;
    });
    welcome.loadFile(path.join(__dirname,'welcome.html')).catch(error=>{ipcMain.removeHandler('welcome:choose');ipcMain.removeHandler('welcome:probe');ipcMain.removeHandler('welcome:chat');ipcMain.removeHandler('welcome:help');ipcMain.removeHandler('welcome:git');reject(error);});
  });
}
async function launch() {
  const root = path.dirname(__dirname);
  const diagnostics = require('./runtime-diagnostics.cjs').createRuntimeDiagnostics();
  diagnostics.repository = root;
  diagnostics.packaged = app.isPackaged;
  diagnostics.healthDirectory = path.join(app.getPath('userData'), 'coordinator-health');
  const {detectProject}=await import(pathToFileURL(path.join(root,'web-project.mjs')).href);
  const settingsPath = path.join(app.getPath('userData'), 'desktop.json');
  if (!app.isPackaged && process.env.BRANCH_REVIEW_DEV === '1') await mkdir(path.dirname(settingsPath), {recursive:true});
  const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'));
  home = (!app.isPackaged && process.env.BRANCH_REVIEW_DEV==='1' ? settings.home : process.env.BRANCH_REVIEW_HOME) || process.env.BRANCH_REVIEW_HOME || settings.home || (app.isPackaged ? path.join(app.getPath('userData'), 'workspace') : path.join(root, '.local'));
  await mkdir(home, { recursive: true });
  process.env.BRANCH_REVIEW_HOME = home;
  const configured=JSON.parse(await readFile(path.join(home,'config.json'),'utf8').catch(()=> '{}'));
  const previousRepository=configured.repository || process.env.META_CLINIC_REPO;
  if(previousRepository && !await requireGit({exec,dialog,openExternal:url=>shell.openExternal(url)})){app.quit();return;}
  const unavailable=previousRepository && !await availableRepository(previousRepository,exec);
  if(unavailable){
    const choice=await dialog.showMessageBox({type:'warning',buttons:['Choose a project','Close'],cancelId:1,message:'Your last project is unavailable.',detail:`${previousRepository}\n\nIt may have moved or its drive may be disconnected. Choose a project to continue. Existing reviews stay saved.`});
    if(choice.response!==0){app.quit();return;}
  }
  if(!previousRepository || unavailable){
    const chosen=previousRepository ? await chooseRepository({dialog,exec,detectProject}) : await firstProject(detectProject,diagnostics);
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
  savedConfig.repository=savedConfig.repository || process.env.META_CLINIC_REPO;
  process.env.BRANCH_REVIEW_DESKTOP_REPOSITORY=savedConfig.repository;
  settings.projects={...settings.projects,[path.resolve(savedConfig.repository).toLowerCase()]:home};
  const {startServer} = await import(pathToFileURL(path.join(root, 'server.mjs')).href);
  const {origin, port, beginDesktopExit} = await startServer({allowPortFallback:app.isPackaged || hasPortOverride,
    preferredPort:settings.controllerPort, desktop:true, diagnostics});
  if (app.isPackaged && !hasPortOverride) settings.controllerPort=port;
  await writeDesktopSettings(settingsPath, JSON.stringify({...settings,home}));
  function allowWorkspaceFullscreen(contents, permission, isMainFrame, url) {
    return permission === 'fullscreen' && isMainFrame && contents === window?.webContents &&
      URL.parse(url)?.origin === origin;
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowWorkspaceFullscreen(contents, permission, details.isMainFrame, details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowWorkspaceFullscreen(contents, permission, details.isMainFrame, requestingOrigin));
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
      if (!state || state.busy || state.workspaceBusy || state.jobsRunning || state.qaRunning) {
        await dialog.showMessageBox(window, {message:'Wait for the current operation to finish before refreshing.'}); return;
      }
      const choice = await dialog.showMessageBox(window, {type:'question',buttons:['Keep working','Refresh'],defaultId:0,cancelId:0,message:'Refresh the development window?',detail:'Save any unsaved form edits first. Saved reviews remain available.'});
      if (choice.response === 1) window.webContents.reload();
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  diagnostics.attach(window, origin);
  window.webContents.on('console-message', details => {
    if (details.level === 'error') void appendFile(path.join(home, 'renderer-errors.log'), `${new Date().toISOString()} ${details.message.slice(0,2000)}\n`);
  });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  function trusted(event) {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Only the review workspace can request desktop actions.');
  }
  projectHandler(diagnostics, trusted, 'review:open-app-preview', 'Open app preview in browser', async (event, url) => {
    trusted(event);
    if (!URL.canParse(url)) throw projectInputError('Choose a valid app preview address.', 'Choose an app preview address');
    const dest = new URL(url);
    const loopback = ['localhost','127.0.0.1','[::1]'].includes(dest.hostname);
    if (dest.username || dest.password || dest.protocol !== 'https:' && !(loopback && dest.protocol === 'http:')) {
      throw projectInputError('Open an HTTPS app preview or a local HTTP preview.', 'Choose an app preview address');
    }
    await shell.openExternal(dest.href);
    return true;
  }, undefined, url=>JSON.stringify(['review:open-app-preview',savedConfig.repository,url]));
  projectHandler(diagnostics, trusted, 'review:open-editor', 'Start editor', async (event, filename) => {
    trusted(event);
    const project = await realpath(savedConfig.repository);
    let target = project;
    if (filename !== undefined) {
      if (typeof filename !== 'string' || !filename || path.isAbsolute(filename)) throw projectInputError('Select a changed file.', 'Select a changed file');
      target = await realpath(path.resolve(project,filename));
      const relative = path.relative(project,target);
      if (!relative || relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative) ||
          !await stat(target).then(info=>info.isFile())) throw projectInputError('Select a file in this project.', 'Select a changed file');
    }
    const editor = settings.editor || (await dialog.showOpenDialog(window, {
      title:'Choose your IDE executable',properties:['openFile'],
      ...(process.platform==='win32' && {filters:[{name:'Applications',extensions:['exe']}]})
    })).filePaths[0];
    if (!editor) return;
    if (!path.isAbsolute(editor)) throw projectInputError('Choose the path to your IDE executable.', 'Choose an editor');
    await new Promise((resolve,reject)=>{
      const child = spawn(editor,[target],{cwd:project,detached:true,stdio:'ignore',windowsHide:true});
      child.once('error',reject);
      child.once('spawn',()=>{child.unref();resolve();});
    });
    if (!settings.editor) {
      settings.editor = editor;
      await writeDesktopSettings(settingsPath, JSON.stringify(settings));
    }
    return true;
  }, undefined, filename=>JSON.stringify(['review:open-editor',savedConfig.repository,filename]));
  projectHandler(diagnostics, trusted, 'review:setup-help', 'Open setup help', async(event,key)=>{trusted(event);await shell.openExternal(setupUrl(key));return true;},
    undefined,key=>'review:setup-help:'+String(key));
  async function control(endpoint, data = {}) {
    const state = await fetch(origin + '/api/state').then(r => r.json());
    if (state.busy || state.workspaceBusy) { const error=projectInputError('Wait for the current operation to finish.', 'Wait for the current operation to finish');error.retryable=true;throw error; }
    const response = await fetch(origin + endpoint, { method: 'POST', headers: { Origin: origin, 'X-Review-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) {
      const error=new Error(result.error);
      error.retryable=response.status===409;
      error.coordinatorReported=response.headers?.get('x-branch-review-recovery')==='coordinator';
      throw error;
    }
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
  function protectDesktopExit() {
    if (qaTask || qaStarting) throw projectInputError('Finish or cancel browser QA before leaving this project.', 'Wait for browser checks to finish');
    return beginDesktopExit();
  }
  diagnostics.notifyRestartRequired = row => {
    if (window.isDestroyed() || !diagnostics.rendererUnavailable()) return;
    void dialog.showMessageBox(window, {
      type: 'warning', message: 'App Health needs to restart Branch Review',
      detail: row.note, buttons: ['Close', 'Restart'], defaultId: 0, cancelId: 0
    }).then(choice => {
      if (choice.response === 1) return requestExit(true);
    }).catch(error => diagnostics.operation('Show restart notice','desktop:restart-notice',error));
  };
  async function startQa(input){
    if(qaTask || qaStarting)throw projectInputError('A browser run is already active.', 'Wait for browser checks to finish');
    qaStarting=true;
    try{
    const state=await fetch(origin+'/api/state').then(r=>r.json());
    if(state.record?.id!==input.id || state.status!=='ready')throw projectInputError('Open the review before starting browser QA.', 'Open the review');
    const {result:run}=await control('/api/browser-qa',input);if(run.reused)return run.id;qaCancelled=false;if(qaWindow&&!qaWindow.isDestroyed())qaWindow.close();
    const {runBrowserQa}=require('./browser-qa.cjs');
    const identity=JSON.stringify(['browser-qa',savedConfig.repository,input.id,run.id,run.commit]);
    qaTask=runBrowserQa({run,record:state.record,origin:`http://127.0.0.1:${state.changed.proxy}`,isCancelled:()=>qaCancelled,
      onWindow:browser=>{
        qaWindow=browser;runtimeState.browserQaWindowRunId=run.id;
        browser.on('closed',()=>{if(runtimeState.browserQaWindowRunId===run.id)runtimeState.browserQaWindowRunId=null;});
      },
      report:async data=>{
        await reportQa({id:input.id,runId:run.id,commit:run.commit,...data});
        if(data.finish==='passed'){
          await diagnostics.operation('Browser checks',identity,undefined,'',undefined,savedConfig.repository);
          await diagnostics.operation('Start browser checks',JSON.stringify(['review:browser-qa',savedConfig.repository,input.id]));
        }else if(data.finish==='failed'||data.finish==='needs-review'){
          const issue=projectInputError(data.finish==='failed'?'A browser check failed. Open its evidence to review the result.':
            'The browser checks need your review.','Open browser QA evidence');
          await diagnostics.operation('Browser checks',identity,issue,
            JSON.stringify({review:input.id,run:run.id,commit:run.commit,error:data.error}),undefined,savedConfig.repository);
        }
      }
    }).catch(async error=>{
      if(!error.coordinatorReported)await diagnostics.operation('Record browser checks',identity,error,'',undefined,savedConfig.repository);
      await control('/api/browser-qa-result',{id:input.id,runId:run.id,commit:run.commit,
        finish:qaCancelled||qaWindow?.isDestroyed()?'cancelled':'failed',error:error.message}).catch(()=>{});
    }).finally(()=>{qaTask=null;});
    return run.id;
    }finally{qaStarting=false;}
  }
  projectHandler(diagnostics, trusted, 'review:browser-qa', 'Start browser checks', async(event,input)=>{trusted(event);return startQa(input);},
    ()=>false,input=>JSON.stringify(['review:browser-qa',savedConfig.repository,input?.id]));
  projectHandler(diagnostics, trusted, 'review:stop-browser-qa', 'Stop browser checks', event=>{trusted(event);qaCancelled=true;if(qaWindow&&!qaWindow.isDestroyed())qaWindow.close();},()=>false);
  projectHandler(diagnostics, trusted, 'review:show-browser-qa', 'Show browser checks', async event=>{
    trusted(event);
    const state=await fetch(origin+'/api/state').then(r=>r.json());
    if(!state.record?.browserQa?.some(run=>run.id===runtimeState.browserQaWindowRunId))
      throw projectInputError('This review has no active QA browser. Open its saved evidence in Details.', 'Open saved browser QA evidence');
    if(qaWindow&&!qaWindow.isDestroyed()){qaWindow.show();qaWindow.focus();return true;}
  },undefined,()=>JSON.stringify(['review:show-browser-qa',savedConfig.repository,runtimeState.browserQaWindowRunId]));
  projectHandler(diagnostics, trusted, 'review:recent-projects', 'List saved projects', async event=>{
    trusted(event);const current=path.resolve(savedConfig.repository).toLowerCase(),hidden=new Set(settings.hiddenProjects || []);
    const paths=[current,...(settings.recentProjects || []),...Object.keys(settings.projects || {})].filter((entry,index,all)=>all.indexOf(entry)===index && (entry===current||!hidden.has(entry)));
    return Promise.all(paths.map(async entry=>{
      const config=JSON.parse(await readFile(path.join(settings.projects?.[entry] || home,'config.json'),'utf8').catch(()=>'{}'));
      const display=typeof config.repository==='string' && path.resolve(config.repository).toLowerCase()===entry ? config.repository : entry;
      return {path:display,name:path.basename(display),current:entry===current,available:await availableRepository(display,exec)};
    }));
  });
  projectHandler(diagnostics, trusted, 'review:forget-project', 'Remove a saved project', async(event,repository)=>{
    trusted(event);const key=typeof repository==='string'?path.resolve(repository).toLowerCase():'';
    if(!settings.projects?.[key] || key===path.resolve(savedConfig.repository).toLowerCase())throw projectInputError('Choose a different saved project to remove.', 'Choose another saved project');
    settings.hiddenProjects=[...new Set([...(settings.hiddenProjects || []),key])];settings.recentProjects=(settings.recentProjects || []).filter(p=>p!==key);await writeDesktopSettings(settingsPath,JSON.stringify({...settings,home}));return true;
  });
  let discoveredProjects = new Map();
  projectHandler(diagnostics, trusted, 'review:find-projects', 'Find a project', async (event, messages) => {
    trusted(event);
    if (!Array.isArray(messages) || !messages.length || messages.length > 15 ||
        messages.some(turn => !turn || !['user', 'assistant'].includes(turn.role) ||
          typeof turn.text !== 'string' || turn.text.length > (turn.role === 'user' ? 500 : 2000)) ||
        messages.at(-1).role !== 'user' || !messages.at(-1).text.trim()) throw projectInputError('Enter a project description.', 'Enter a project description');
    const latest = messages.at(-1).text.trim();
    const first = messages.find(turn => turn.role === 'user').text.trim();
    const query = /^(?:[a-z]:[\\/]|\/)/i.test(latest) || /["'][a-z]:[\\/]/i.test(latest)
      ? latest : [latest, first === latest ? '' : first].join(' ').trim().slice(0, 500);
    discoveredProjects.clear();
    const reply = await control('/api/workspace/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {name: 'find_local_projects', arguments: {query}}});
    const projects = reply.result?.structuredContent?.projects;
    if (!projects) throw Error(reply.error?.message || reply.result?.content?.[0]?.text || 'Project search failed.');
    const settings = JSON.parse(await readFile(path.join(home, 'agent-settings.json'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
    const provider = settings.provider || 'codex';
    let answer;
    try {
      answer = await askProjectAgent(provider, messages, {candidates: projects, executable: settings.executables?.[provider]});
      await diagnostics.operation('Ask the project finder', 'review:project-finder-agent');
    } catch (error) {
      await diagnostics.operation('Ask the project finder', 'review:project-finder-agent', error);
      answer = {message: 'The agent could not reply. Check the search results or try again.'};
    }
    const current = path.resolve(savedConfig.repository).toLowerCase();
    discoveredProjects = new Map(projects.map(project => [path.resolve(project.path).toLowerCase(), project.path]));
    const recommended = answer.projectPath && path.resolve(answer.projectPath).toLowerCase();
    const results = projects.map(project => {
      const key = path.resolve(project.path).toLowerCase();
      return {...project, current: key === current, recommended: key === recommended};
    });
    results.sort((a, b) => Number(b.recommended) - Number(a.recommended));
    return {message: answer.projectPath && !discoveredProjects.has(recommended)
      ? 'The suggested folder did not match the search results. Try its full path.' : answer.message, projects: results};
  });
  projectHandler(diagnostics, trusted, 'review:choose-repository', 'Open a project', async (event,requested,discovered=false) => {
    trusted(event);
    let chosen;
    if(requested!==undefined){
      const key=typeof requested==='string'?path.resolve(requested).toLowerCase():'';
      const folder=discovered===true ? discoveredProjects.get(key) : settings.projects?.[key] && requested;
      if(!folder)throw projectInputError('Choose a project from the list.', 'Choose a project from the list');
      if(key===path.resolve(savedConfig.repository).toLowerCase())return null;
      if(!await availableRepository(folder,exec))throw projectInputError('This project folder is unavailable. Find it again or browse for the folder.', 'Browse for a folder');
      const repository=(await exec('git',['rev-parse','--show-toplevel'],{cwd:folder,windowsHide:true})).stdout.trim();
      if(path.resolve(repository).toLowerCase()!==key)throw projectInputError('This folder now belongs to a different project. Choose it as a new project.', 'Browse for a folder');
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
    const selectedKey = path.resolve(repository).toLowerCase();
    const hiddenProjects = (settings.hiddenProjects || []).filter(key => key !== selectedKey);
    const recentProjects = [selectedKey, ...(settings.recentProjects || []).filter(key => key !== selectedKey)].slice(0,50);
    const resume = protectDesktopExit();
    try {
      await writeDesktopSettings(settingsPath, JSON.stringify({...settings, hiddenProjects, recentProjects,
        projects:{...settings.projects,[selectedKey]:newHome}, home:newHome,
        selectionIntent:{repository,identity:projectSelectionIdentity(requested),requestedAt:Date.now()},
        window:{...window.getNormalBounds(),maximized:window.isMaximized()}}));
    } catch (error) {
      resume();
      throw error;
    }
    delete process.env.BRANCH_REVIEW_HOME;
    try { app.relaunch(); }
    catch (error) {
      await writeDesktopSettings(settingsPath, JSON.stringify({...settings,home}));
      process.env.BRANCH_REVIEW_HOME=home;
      resume();
      throw error;
    }
    closing = true; app.exit(0);
  }, undefined, projectSelectionIdentity);
  projectHandler(diagnostics, trusted, 'review:capture', 'Capture workspace', async (event,rect) => {
    trusted(event);
    if (rect) {
      const [width, height] = window.getContentSize();
      const zoom = window.webContents.getZoomFactor();
      if (!['x','y','width','height'].every(key => Number.isSafeInteger(rect[key])) ||
          rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 ||
          rect.x + rect.width > Math.ceil(width / zoom) || rect.y + rect.height > Math.ceil(height / zoom)) {
        throw projectInputError('Capture must stay inside the review window.', 'Select an area inside the review window');
      }
      // The renderer measures CSS pixels. Electron captures in device-independent pixels.
      const x = Math.ceil(rect.x * zoom), y = Math.ceil(rect.y * zoom);
      const right = Math.min(width, Math.floor((rect.x + rect.width) * zoom));
      const bottom = Math.min(height, Math.floor((rect.y + rect.height) * zoom));
      if (right <= x || bottom <= y) throw projectInputError('The capture area is empty.', 'Select a larger capture area');
      rect = {x, y, width: right - x, height: bottom - y};
    }
    const png = await window.webContents.capturePage(rect);
    return png.toDataURL();
  },undefined,()=>JSON.stringify(['review:capture',savedConfig.repository]));
  const { isReviewDestination } = await import(pathToFileURL(path.join(root, 'public/preview-routes.js')).href);
  projectHandler(diagnostics, trusted, 'review:open-published', 'Open published workflow', async(event,url)=>{
    trusted(event);
    if(!URL.canParse(url))throw projectInputError('Choose a Meta Clinic workflow URL.', 'Choose a workflow address');
    const destination=new URL(url);
    if(destination.origin!=='https://aimetaclinic.com'||destination.username||destination.password||!isReviewDestination(url.slice(destination.origin.length)))
      throw projectInputError('Choose a Meta Clinic workflow URL.', 'Choose a workflow address');
    await shell.openExternal(destination.href);return true;
  },undefined,url=>JSON.stringify(['review:open-published',url]));
  projectHandler(diagnostics, trusted, 'review:open-workbench-evidence', 'Open review evidence', async(event,url)=>{
    trusted(event);
    if(typeof url!=='string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*#issuecomment-[1-9]\d*$/.test(url))
      throw projectInputError('Choose a Branch Review evidence link on GitHub.', 'Choose a review evidence link');
    await shell.openExternal(url);
    return true;
  },undefined,url=>JSON.stringify(['review:open-workbench-evidence',url]));
  projectHandler(diagnostics, trusted, 'review:release-files', 'Choose release files', async event => {
    trusted(event);
    const key = await dialog.showOpenDialog(window, { title: 'Select the existing Lightsail SSH key', properties: ['openFile'] });
    if (key.canceled) return null;
    const recovery = await dialog.showOpenDialog(window, { title: 'Select the encrypted recovery archive folder', properties: ['openDirectory'] });
    if (recovery.canceled) return null;
    return { keyPath: key.filePaths[0], recoveryDirectory: recovery.filePaths[0] };
  });
  let exiting = false;
  async function requestExit(restart) {
    if (closing || exiting) return;
    exiting = true;
    try {
      const state = await fetch(origin + '/api/state').then(r => r.json()).catch(() => null);
      if (state?.busy || state?.workspaceBusy || state?.jobsRunning || state?.qaRunning || qaTask || qaStarting) {
        await diagnostics.operation(restart?'Restart Branch Review':'Close Branch Review',restart?'review:restart':'desktop:close',
          projectInputError('Branch Review is still working. Wait for active work to finish.', 'Wait for active work to finish'));
        await dialog.showMessageBox(window, {message: 'Finish or cancel active builds, jobs, and browser QA before exiting Branch Review.'});
        return;
      }
      if (!restart) {
        const {response} = await dialog.showMessageBox(window, {type: 'question', buttons: ['Keep working', 'Close app'],
          defaultId: 0, cancelId: 0, message: 'Close Branch Review?',
          detail: 'Save any unsaved edits first. Reviews stay saved. Generic preview processes stop when the app closes. Meta Clinic previews stay available until you stop them.'});
        if (response !== 1) return;
      }
      let resume;
      try { resume = protectDesktopExit(); }
      catch (error) {
        await diagnostics.operation(restart?'Restart Branch Review':'Close Branch Review',restart?'review:restart':'desktop:close',error);
        await dialog.showMessageBox(window, {message: error.message}); return;
      }
      try {
        await writeDesktopSettings(settingsPath, JSON.stringify({...settings, home,
          ...(restart && {restartIntent:{repository:savedConfig.repository,identity:'review:restart',requestedAt:Date.now()}}),
          window: {...window.getNormalBounds(), maximized: window.isMaximized()}}));
        if (restart) app.relaunch();
      } catch (error) {
        resume();
        if(restart)await writeDesktopSettings(settingsPath,JSON.stringify({...settings,home}));
        await diagnostics.operation(restart?'Restart Branch Review':'Close Branch Review',restart?'review:restart':'desktop:close',error);
        await dialog.showMessageBox(window, {message: restart ? 'Could not restart Branch Review.' : 'Could not save window settings.', detail: error.message});
        return;
      }
      closing = true;
      app.exit(0);
    } finally {
      exiting = false;
    }
  }
  projectHandler(diagnostics, trusted, 'review:restart', 'Restart Branch Review', async event => {
    trusted(event);
    await requestExit(true);
  },()=>false);
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    void requestExit(false).catch(error=>diagnostics.operation('Close Branch Review','desktop:close',error));
  });
  await window.loadURL(origin);
  if(settings.window?.maximized)window.maximize();
  window.show();
  if (settings.selectionIntent || settings.restartIntent) {
    let verifying = false;
    const checkSelection = async () => {
      if (verifying || window.isDestroyed()) return;
      verifying = true;
      try {
        const loaded = await window.webContents.executeJavaScript(`(() => {
          const root = document.querySelector('#factory-view > div')?.shadowRoot;
          return document.readyState === 'complete' && Boolean(root?.getElementById('open-project-conversation')) &&
            root?.getElementById('project-name')?.textContent === ${JSON.stringify(path.basename(savedConfig.repository))};
        })()`);
        for(const field of ['selectionIntent','restartIntent']){
          await verifyProjectSelection({intent:settings[field],repository:savedConfig.repository,loaded,diagnostics,
            ...(field==='restartIntent' && {title:'Restart Branch Review',nextAction:'Restart Branch Review'}),
            clear:async()=>{
              const intent=settings[field];
              delete settings[field];
              try { await writeDesktopSettings(settingsPath,JSON.stringify({...settings,home})); }
              catch(error){settings[field]=intent;throw error;}
            }});
        }
        if(!settings.selectionIntent&&!settings.restartIntent)clearInterval(selectionTimer);
      } catch(error) {
        await diagnostics.operation('Verify selected project', 'desktop:verify-project-selection', error);
      } finally { verifying = false; }
    };
    const selectionTimer = setInterval(checkSelection,250);
    window.once('closed',()=>clearInterval(selectionTimer));
    await checkSelection();
  }
  await writeFile(path.join(home, 'desktop-start.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), electron: process.versions.electron, url: window.webContents.getURL() }));
}
