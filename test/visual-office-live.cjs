const {app,BrowserWindow,ipcMain}=require('electron');
const http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const {readFile,mkdir,writeFile}=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {runBrowserQa}=require('../desktop/browser-qa.cjs');
app.whenReady().then(async()=>{
 const root=path.resolve(__dirname,'..'),saved=new Map();let browser,task,fail=false;
 const {beginBrowserQa}=await import(pathToFileURL(path.join(root,'browser-qa.mjs')));
 const record={id:'fixture',identity:{ref:'fixture',changed:'fixture-commit'},manifest:{title:'Blue button',scenarios:[{id:'button',title:'Button appearance',path:'/fixture',steps:['Looks right']}]},issues:[],checks:{'button:0':true},items:{},browserQa:[]};
 const store={records:[record],event:async()=>{},persist:async()=>{}};
 const server=http.createServer(async(req,res)=>{try{
  if(req.url==='/fixture'){res.setHeader('Content-Type','text/html');res.end('<html><body>Loading this page…<script>setTimeout(()=>{document.body.innerHTML=\'<button id="button" style="background-color:#2563eb">Blue button</button>\'},500)</script></body></html>');return;}
  if(req.url.startsWith('/screenshots/')){res.setHeader('Content-Type','image/png');res.end(saved.get(req.url));return;}
  if(req.url==='/'){
   res.setHeader('Content-Type','text/html');res.end(`<link rel="stylesheet" href="/style.css"><header class="topbar"><button id="toolbar-qa">QA</button></header><main><div id="preview-area"><iframe id="preserved-preview" src="/fixture"></iframe></div><button id="results-action">Send to QA</button><p id="results-message"></p><section id="approval-section"><input id="reviewer" value="Fixture reviewer"><button id="approve">Approve</button></section><details><summary id="delivery-heading">Delivery</summary><button id="ship">Merge and push</button><button id="publish">Publish</button></details><button id="project-deploy">Publish</button></main><script type="module">import {activity} from '/activity.js';import {qaReviews} from '/qa-model.js';globalThis.state={status:'ready',agent:{provider:'codex'},jobActivity:[],record:${JSON.stringify(record)},qaReviews:[],publishTarget:'fixture'};globalThis.paint=()=>{state.qaReviews=qaReviews([state.record]);view.render();};const view=activity({api:async()=>[],getState:()=>state,navigate:async()=>{},flush:async()=>true,poll:async()=>paint()});document.querySelector('#results-action').onclick=()=>window.dispatchEvent(new Event('review:send-qa'));globalThis.receive=r=>{state.record=r;state.qaRunning=r.browserQa.at(-1)?.status==='running';paint();};paint();</script>`);return;
  }
  const file=path.basename(req.url);if(!['style.css','activity.js','qa-model.js','office-model.js','progress-model.js','review-model.js'].includes(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(path.join(root,'public',file)));
 }catch(e){res.writeHead(500).end(e.message);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 await mkdir(path.join(root,'.local/qa-workspace-evidence'),{recursive:true});const preload=path.join(root,'.local/qa-workspace-evidence/preload.cjs');
 await writeFile(preload,"require('electron').contextBridge.exposeInMainWorld('desktop',{startBrowserQa:input=>require('electron').ipcRenderer.invoke('qa-fixture',input)});");
 const window=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{preload,offscreen:true}}),js=code=>window.webContents.executeJavaScript(code);
 const paint=()=>js(`receive(${JSON.stringify(record)})`);
 ipcMain.handle('qa-fixture',async(_event,input)=>{
  assert.equal(input.submit,true);const actions=[{itemId:'button',action:'visit',path:'/fixture'},{itemId:'button',action:'style',selector:'#button',property:'background-color',value:fail?'red':'#2563eb'}];
  const run=await beginBrowserQa(store,record,actions,true,true);await paint();
  task=runBrowserQa({run,origin,isCancelled:()=>false,onWindow:w=>{browser=w;assert.equal(w.isVisible(),false);},report:async result=>{if(result.index===0)assert.equal(await browser.webContents.executeJavaScript('document.body.innerText.trim()'),'Blue button');if(result.index!==undefined){const screenshot=`${run.id}-${result.index}.png`;saved.set('/screenshots/'+screenshot,Buffer.from(result.screenshot.split(',')[1],'base64'));run.results.push({...result,screenshot});}if(result.finish)run.status=result.finish;await paint();}});return run.id;
 });
 try{
  await window.loadURL(origin);for(let i=0;i<100&&!await js('!!globalThis.paint');i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(record.browserQa.length,0,'opening review must not start QA');await js("globalThis.preview=document.getElementById('preserved-preview');document.getElementById('results-action').click()");
  for(let i=0;i<50&&!task;i++)await new Promise(r=>setTimeout(r,100));assert.ok(task);await new Promise(r=>setTimeout(r,200));
  assert.equal(await js("document.querySelector('#qa-page').hidden"),true,'sending starts in background');await js("document.getElementById('toolbar-qa').click()");assert.equal(await js("document.querySelector('#qa-page').hidden"),false);assert.equal(await js("getComputedStyle(document.querySelector('main')).display"),'none');assert.ok(await js("document.querySelectorAll('.qa-box.checking').length")>0);
  await js("document.querySelector('[data-back]').click()");assert.notEqual(await js("getComputedStyle(document.querySelector('main')).display"),'none');assert.equal(await js("preview===document.getElementById('preserved-preview')"),true);
  await task;assert.equal(record.browserQa.at(-1).status,'passed');await js("document.getElementById('toolbar-qa').click()");assert.equal(await js("document.querySelector('.qa-badge').textContent"),'1');assert.equal(await js("document.querySelector('[data-approve]').disabled"),false);assert.equal(await js("document.querySelectorAll('dialog[open]').length"),0);
  await js("document.querySelector('.qa-box.passed').click()");assert.equal(await js("!!document.querySelector('[data-evidence] img')"),true);assert.equal(record.approval,undefined);
  await writeFile(path.join(root,'.local/qa-workspace-evidence/passed.png'),(await window.webContents.capturePage()).toPNG());
  browser.destroy();fail=true;task=null;await js("document.querySelector('[data-run]').click()");for(let i=0;i<50&&!task;i++)await new Promise(r=>setTimeout(r,100));await task;
  assert.equal(record.browserQa.at(-1).status,'failed');assert.equal(await js("document.querySelector('.qa-badge').hidden"),true);assert.equal(await js("document.querySelector('[data-approve]').disabled"),true);assert.ok(await js("document.querySelectorAll('.qa-box.failed').length")>0);
  await writeFile(path.join(root,'.local/qa-workspace-evidence/failed.png'),(await window.webContents.capturePage()).toPNG());
  console.log('PASS: explicit Send to QA, real browser pass/fail, background return, preserved preview, QA page and badge, failed-delivery lock, inline evidence.');browser.destroy();window.destroy();server.close();app.exit(0);
 }catch(e){console.error(e);browser?.destroy();window.destroy();server.close();app.exit(1);}
});
