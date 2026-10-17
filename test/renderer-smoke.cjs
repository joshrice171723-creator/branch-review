// Optional renderer acceptance against a disposable project served on port 4310.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const {mkdir,writeFile}=require('node:fs/promises');
const path=require('node:path');
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:true}});
 const errors=[];window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
 const js=source=>window.webContents.executeJavaScript(source).catch(error=>{throw Error(source+'\n'+error.message+'\n'+errors.join('\n'));});
 const wait=async expression=>{const end=Date.now()+60000;while(!await js(expression)){assert.ok(Date.now()<end,'Timed out: '+expression);await new Promise(resolve=>setTimeout(resolve,100));}};
 try{
  const existing=await fetch('http://127.0.0.1:4310/api/state').then(r=>r.json());
  await window.loadURL('http://127.0.0.1:4310/');
  if(!existing.record){
  await wait("document.getElementById('onboarding')!==null");
  if(!await js("document.getElementById('onboarding').open"))await js("[...document.querySelectorAll('button')].find(button=>button.textContent==='Project setup guide').click()");
  await wait("document.getElementById('onboarding').open && !document.getElementById('onboarding-retry').disabled");
  await js("document.getElementById('onboarding-agent').value='claude';document.getElementById('onboarding-agent').onchange()");
  assert.equal(await js("document.getElementById('onboarding-done').disabled"),true);
  assert.match(await js("document.getElementById('onboarding-checks').textContent"),/Claude connection/);
  await js("document.getElementById('onboarding-agent').value='codex';document.getElementById('onboarding-agent').onchange()");
  assert.equal(await js("document.getElementById('onboarding-done').disabled"),false);
  await js("document.getElementById('onboarding-done').onclick()");
  await js("document.getElementById('new-change').click()");
  if(!existing.jobsRunning && !await js("!document.getElementById('review-changes').hidden")){
   await js("document.getElementById('change-request').value='Change only the Add a note button background in style.css from blue #2563eb to pink #db2777. Preserve its label and behavior.';document.getElementById('change-request').dispatchEvent(new Event('input',{bubbles:true}))");
   await wait("!document.getElementById('make-changes').disabled");
   await js("document.getElementById('make-changes').onclick()");
  }
  await wait("!document.getElementById('review-changes').hidden");
  assert.equal(await js("document.getElementById('tools-plan').hidden"),false);
  assert.equal(await js("document.getElementById('checklist-advanced').hidden"),true);
  await js("document.getElementById('review-changes').onclick()");
  }
  await wait("document.getElementById('loading').hidden && !document.getElementById('changed').disabled && document.querySelector('iframe')!==null");
  const state=await fetch('http://127.0.0.1:4310/api/state').then(r=>r.json());
  assert.equal(state.status,'ready');assert.ok(state.record.manifest.scenarios.some(item=>item.files?.includes('style.css')));
  await js("document.getElementById('original').click()");await wait("document.getElementById('original').getAttribute('aria-pressed')==='true'");
  await js("document.getElementById('changed').click()");await wait("document.getElementById('changed').getAttribute('aria-pressed')==='true'");
  for(const [port,color] of [[state.original.proxy,'rgb(37, 99, 235)'],[state.changed.proxy,'rgb(219, 39, 119)']]){
   const deadline=Date.now()+10000;let actual;
   while(actual!==color){const frame=window.webContents.mainFrame.frames.find(frame=>frame.url.startsWith('http://127.0.0.1:'+port));if(frame)actual=await frame.executeJavaScript("document.querySelector('button') && getComputedStyle(document.querySelector('button')).backgroundColor");assert.ok(Date.now()<deadline,`Preview ${port}: expected ${color}, got ${actual}`);await new Promise(resolve=>setTimeout(resolve,100));}
  }
  window.webContents.invalidate();await new Promise(resolve=>setTimeout(resolve,500));
  const directory=path.resolve(process.argv[2] || '.local/renderer-evidence');await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'first-change.png'),(await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);
  console.log('PASS: '+(existing.record?'Restored review':'Provider setup and first change')+' renders blue Original / pink Changed and toggles its previews.');
  app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
