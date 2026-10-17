const {app,BrowserWindow}=require('electron');
const http=require('node:http'),assert=require('node:assert/strict');
const {readFile}=require('node:fs/promises');
const path=require('node:path');
app.whenReady().then(async()=>{
 let loads=0;
 const server=http.createServer(async(req,res)=>{
  if(req.url.startsWith('/__review/start')){loads++;res.setHeader('Content-Type','text/html');res.end(`<h1>Button preview</h1><script>window.instance=${loads};addEventListener('load',()=>parent.postMessage({type:'review:context',location:'/button',painted:true},location.origin));</script>`);return;}
  if(req.url.endsWith('.js')){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(__dirname,'../public',req.url.slice(1))));return;}
  res.end('<div id="frames"></div>');
 }).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));const port=server.address().port;
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 try{
  await win.loadURL(`http://127.0.0.1:${port}`);
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const {framePool}=await import('/frame-pool.js'),pool=framePool(document.getElementById('frames'));
   const item={id:'button',path:'/button'},preview=sha=>({sha,proxy:${port},scenario:{}});
   const initial={original:preview('base'),changed:preview('old')};pool.mount(initial,item,false,()=>{});
   const wait=async test=>{for(let i=0;i<100&&!test();i++)await new Promise(r=>setTimeout(r,20));if(!test())throw Error('Timed out');};
   await wait(()=>document.querySelectorAll('iframe').length===2 && [...document.querySelectorAll('iframe')].every(f=>f.contentWindow.instance));
   const old=document.getElementById('frame-changed'),oldInstance=old.contentWindow.instance;
   const prepared={changed:preview('new'),item};pool.preload(prepared);await pool.waitPrepared(prepared);
   const next=[...document.querySelectorAll('iframe')].find(f=>!f.id),nextInstance=next.contentWindow.instance;
   const start=performance.now();pool.mount({original:preview('old'),changed:preview('new')},item,false,()=>{});
   const elapsed=performance.now()-start;await new Promise(r=>setTimeout(r,100));
   return {sameBefore:old===document.getElementById('frame-original'),sameAfter:next===document.getElementById('frame-changed'),beforeInstance:old.contentWindow.instance===oldInstance,afterInstance:next.contentWindow.instance===nextInstance,count:document.querySelectorAll('iframe').length,elapsed};
  })()`);
  for(const key of ['sameBefore','sameAfter','beforeInstance','afterInstance'])assert.equal(result[key],true,key);
  assert.equal(result.count,2);assert.equal(loads,3,'switch must not reload either page');console.log(JSON.stringify(result));app.exit(0);
 }catch(error){console.error(error);app.exit(1);}finally{server.close();}
});
