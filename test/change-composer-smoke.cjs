// Render current source against a ready local review; intercept submissions so no agent job runs.
const {app,BrowserWindow,session,net,ipcMain,nativeImage}=require('electron');
const {readFile,mkdir,writeFile}=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]);
 const isolated=session.fromPartition('composer-test-'+Date.now());
 await isolated.protocol.handle('http',async request=>{
  const url=new URL(request.url);
  if(url.origin==='http://127.0.0.1:4310' && (url.pathname==='/' || /^\/[a-z-]+\.(js|css)$/.test(url.pathname))){
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
   return new Response(await readFile(path.join(root,'public',file)),{headers:{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'}});
  }
  return net.fetch(request,{bypassCustomProtocolHandlers:true});
 });
 const window=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{session:isolated,preload:path.join(root,'desktop/preload.cjs'),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
 ipcMain.handle('review:capture',async(_event,rect)=>(await window.webContents.capturePage(rect)).toDataURL());
 const js=source=>window.webContents.executeJavaScript(source),wait=async expression=>{const end=Date.now()+30000;while(!await js(expression)){assert.ok(Date.now()<end,'Timed out: '+expression);await new Promise(r=>setTimeout(r,100));}};
 try{
  await window.loadURL('http://127.0.0.1:4310');
  await wait("document.getElementById('change-context').textContent.includes('/') && !document.getElementById('changed').disabled");
  assert.equal(await js("document.getElementById('tools-dialog').open"),false);
  assert.equal(await js("document.getElementById('change-request').closest('aside').className"),'review');
  assert.equal(await js("document.getElementById('change-composer').contains(document.getElementById('plan-save'))"),false);
  await js(`globalThis.sent=null;const originalFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{if(url==='/api/job'){sent=JSON.parse(options.body);return new Response(JSON.stringify({result:{id:'test-job',reviewId:sent.id,kind:'fix',status:'running'}}),{headers:{'Content-Type':'application/json'}});}return originalFetch(url,options);};document.getElementById('change-request').value='Remove the brown shadow from this blue button';document.getElementById('change-request').dispatchEvent(new Event('input'));`);
  await wait("!document.getElementById('make-changes').disabled");
  window.webContents.invalidate();await new Promise(r=>setTimeout(r,400));
  await mkdir(output,{recursive:true});await writeFile(path.join(output,'composer.png'),(await window.webContents.capturePage()).toPNG());
  await js("document.getElementById('make-changes').click()");await wait('globalThis.sent!==null');
  const sent=await js('globalThis.sent'),image=nativeImage.createFromDataURL(sent.attachment.screenshot),size=image.getSize();
  assert.equal(sent.attachment.side,'changed');assert.match(sent.attachment.commit,/^[a-f0-9]{40}$/);assert.ok(sent.attachment.location.startsWith('/'));assert.ok(size.width>400 && size.width<1200 && size.height>200);
  await writeFile(path.join(output,'attached-preview.png'),image.toPNG());
  await writeFile(path.join(output,'receipt.json'),JSON.stringify({...sent,attachment:{...sent.attachment,screenshot:`PNG ${size.width}x${size.height}`}},null,2));
  assert.equal(await js("document.getElementById('change-request').value"),'');
  console.log('PASS: visible composer, separate checklist, one submit click, current page/commit and real cropped PNG; no agent job submitted.');app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
