const {app,BrowserWindow,ipcMain}=require('electron');
const {readFile,writeFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const directory=process.argv[2],fixture=JSON.parse(await readFile(path.join(directory,'fixture.json'),'utf8'));
 const win=new BrowserWindow({show:false,width:1500,height:980,webPreferences:{preload:path.join(__dirname,'../desktop/preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:true}});
 ipcMain.handle('review:capture',async(_,rect)=>(await win.webContents.capturePage(rect)).toDataURL());
 const js=code=>win.webContents.executeJavaScript(code),state=()=>fetch('http://127.0.0.1:4310/api/state').then(r=>r.json());
 const wait=async(check,label,timeout=240000)=>{const end=Date.now()+timeout;while(!await check()){assert.ok(Date.now()<end,'Timed out: '+label+' '+JSON.stringify(await state()));await new Promise(r=>setTimeout(r,300));}};
 const post=async(endpoint,data)=>{const s=await state(),response=await fetch('http://127.0.0.1:4310'+endpoint,{method:'POST',headers:{Origin:'http://127.0.0.1:4310','X-Review-Token':s.token,'Content-Type':'application/json'},body:JSON.stringify(data)});assert.ok(response.ok,await response.clone().text());return response.json();};
 try{
  await win.loadURL('http://127.0.0.1:4310');
  await wait(()=>js("[...document.querySelectorAll('#branches button')].some(b=>b.title.includes('feature/button'))"),'branch list');
  await js("[...document.querySelectorAll('#branches button')].find(b=>b.title.includes('feature/button')).click()");
  await wait(async()=>{const s=await state();return s.status==='ready' && s.record && !s.busy;},'initial preview');
  await wait(()=>js("!document.getElementById('changed').disabled && document.getElementById('change-context').textContent.includes('/')"),'loaded preview');
  const first=await state();assert.equal(first.original.sha,fixture.base);
  for(const color of (first.jobActivity.filter(j=>j.kind==='fix'&&j.status==='succeeded').length>=2?[]:first.jobActivity.some(j=>j.kind==='fix'&&j.status==='succeeded')?['#ea580c']:['#db2777','#ea580c'])){
   const rendered=await state();
   await wait(()=>js("document.getElementById('review-branch-status').textContent.includes("+JSON.stringify(rendered.record.identity.source.slice(0,7))+")"),'rendered current revision');
   const before=rendered.record.id;
   await js(`document.getElementById('new-change').click();document.getElementById('change-request').value=${JSON.stringify('Change only the button background-color in style.css to '+color+'. Do not modify any other CSS properties or files.')};document.getElementById('change-request').dispatchEvent(new Event('input'));`);
   await wait(()=>js("!document.getElementById('make-changes').disabled"),'enabled composer');await js("document.getElementById('make-changes').click()");
   await new Promise(r=>setTimeout(r,1000));console.log('Composer after submit: '+await js("JSON.stringify({status:document.getElementById('change-status').textContent,value:document.getElementById('change-request').value,disabled:document.getElementById('make-changes').disabled,context:document.getElementById('change-context').textContent})"));
   await wait(async()=>{const s=await state();if(s.jobActivity.some(j=>j.reviewId===before&&j.kind==='fix'&&j.status==='failed'))throw Error(JSON.stringify(s.jobActivity));return s.status==='ready' && s.record?.id!==before && !s.busy;},'automatic revision opening');
   const s=await state();assert.equal(s.record.identity.ref,'refs/heads/feature/button');assert.equal(s.original.sha,fixture.base);assert.deepEqual(s.record.checks,{});assert.equal(s.record.approval,null);
   await wait(()=>js("document.getElementById('review-branch-status').textContent.includes("+JSON.stringify(s.record.identity.source.slice(0,7))+") && document.getElementById('change-context').textContent.includes('/')"),'revision page');
   assert.match(await fetch('http://127.0.0.1:'+s.changed.proxy+'/style.css').then(r=>r.text()),new RegExp(color));console.log('PASS actual CLI revision '+color+' on '+s.record.identity.source.slice(0,7));
  }
  const current=await state();await post('/api/check',{id:current.record.id,scenario:'button',index:0,passed:true});
  await js("document.getElementById('toolbar-history').click()");await wait(()=>js("document.querySelectorAll('.branch-version-list article').length===4"),'branch versions');
  await writeFile(path.join(directory,'history.png'),(await win.webContents.capturePage()).toPNG());
  await js("document.querySelectorAll('.branch-version-list article')[2].querySelector('button').click()");await wait(async()=>!!(await state()).previewVersion,'historical preview');
  const historical=await state();assert.equal(historical.previewVersion.sha,fixture.initial);assert.equal(historical.record.identity.source,current.record.identity.source);assert.equal(historical.record.checks['button:0'],true);
  assert.match(await fetch('http://127.0.0.1:'+historical.changed.proxy+'/style.css').then(r=>r.text()),/#7c3aed/);
  const response=await fetch('http://127.0.0.1:4310/api/check',{method:'POST',headers:{Origin:'http://127.0.0.1:4310','X-Review-Token':historical.token,'Content-Type':'application/json'},body:JSON.stringify({id:current.record.id,scenario:'button',index:1,passed:true})});assert.equal(response.status,400);
  await wait(()=>js("[...document.querySelectorAll('#history-dialog button')].some(b=>b.textContent==='Return to latest version'&&!b.disabled&&!b.hidden)"),'enabled return to latest');
  await js("[...document.querySelectorAll('#history-dialog button')].find(b=>b.textContent==='Return to latest version').click()");await wait(async()=>!(await state()).previewVersion,'return latest');
  await wait(()=>js("!document.querySelectorAll('.branch-version-list article')[2].querySelectorAll('button')[1].disabled"),'enabled restore');
  await js("window.confirm=()=>true;document.querySelectorAll('.branch-version-list article')[2].querySelectorAll('button')[1].click()");await wait(async()=>{const s=await state();return s.status==='ready' && !s.busy && s.record?.identity.source!==current.record.identity.source;},'restore commit');
  const restored=await state();assert.equal(restored.record.identity.ref,current.record.identity.ref);assert.equal(restored.original.sha,fixture.base);assert.deepEqual(restored.record.checks,{});assert.match(await fetch('http://127.0.0.1:'+restored.changed.proxy+'/style.css').then(r=>r.text()),/#7c3aed/);
  await win.reload();await wait(()=>js("document.getElementById('review-branch-status').textContent.includes('Latest version')"),'reopened app');
  const reopen=await state();assert.equal(reopen.record.id,restored.record.id);await writeFile(path.join(directory,'latest.png'),(await win.webContents.capturePage()).toPNG());
  await writeFile(path.join(directory,'receipt.json'),JSON.stringify({base:fixture.base,initial:fixture.initial,revisions:current.record.identity.source,restored:restored.record.identity.source,historyPreviewReadOnly:true,originalStable:true,sameBranch:true},null,2));
  console.log('PASS: history Preview, return latest, restore-as-commit, reset checks and renderer reload.');win.destroy();app.exit(0);
 }catch(e){console.error(e);win.destroy();app.exit(1);}
});
