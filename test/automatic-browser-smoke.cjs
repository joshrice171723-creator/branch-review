const {app}=require('electron');
const http=require('node:http');
const assert=require('node:assert/strict');
const {runBrowserQa}=require('../desktop/browser-qa.cjs');
app.whenReady().then(async()=>{
 const server=http.createServer((_req,res)=>res.end('<html><body><button id="button" style="background-color:#2563eb;border-radius:16px">Try it</button></body></html>'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  for(const [selector,value,expected] of [['#button','#2563eb','passed'],['#missing','blue','needs-review'],['#button','red','failed']]){
   const results=[];let browser;
   const run={id:crypto.randomUUID(),automatic:true,actions:[{itemId:'button',action:'visit',path:'/'},{itemId:'button',action:'style',selector,property:'background-color',value,optional:true}]};
   await runBrowserQa({run,origin:`http://127.0.0.1:${server.address().port}`,isCancelled:()=>false,onWindow:window=>{browser=window;assert.equal(window.isVisible(),false);},report:async result=>results.push(result)});
   assert.equal(results.at(-1).finish,expected);assert.ok(results.filter(r=>r.index!==undefined).every(r=>r.screenshot?.startsWith('data:image/png;base64,')));
   browser.close();
  }
  console.log('PASS: real hidden Electron browser color normalization, screenshot evidence, missing-selector review and failed assertion.');app.exit(0);
 }catch(error){console.error(error);app.exit(1);}finally{server.close();}
});
