// Optional installed-runner acceptance. Requires the disposable pink Field Notes review.
const {app}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
app.whenReady().then(async()=>{
 let browser;
 try{
  const origin='http://127.0.0.1:4310',state=await fetch(origin+'/api/state').then(r=>r.json());
  assert.equal(state.project.name,'field-notes-demo');assert.equal(state.status,'ready');assert.equal(state.busy,false);
  const record=state.record,itemId=record.manifest.scenarios[0].id;
  const post=async(endpoint,data)=>{const response=await fetch(origin+endpoint,{method:'POST',headers:{Origin:origin,'X-Review-Token':state.token,'Content-Type':'application/json'},body:JSON.stringify(data)});const body=await response.json();assert.equal(response.ok,true,body.error);return body.result;};
  const run=await post('/api/browser-qa',{id:record.id,steps:[{itemId,action:'visit',path:'/'},{itemId,action:'style',selector:'#add-note',property:'background-color',value:'rgb(219, 39, 119)'},{itemId,action:'click',selector:'#add-note'},{itemId,action:'text',selector:'#result',value:'Your note is ready.'}]});
  const {runBrowserQa}=require(path.resolve(process.argv[2],'desktop/browser-qa.cjs'));
  await runBrowserQa({run,record,origin:`http://127.0.0.1:${state.changed.proxy}`,isCancelled:()=>false,onWindow:value=>{browser=value;},report:data=>post('/api/browser-qa-result',{id:record.id,runId:run.id,commit:run.commit,...data})});
  const finished=await fetch(origin+'/api/state').then(r=>r.json()),saved=finished.record.browserQa.find(row=>row.id===run.id);
  assert.equal(saved.status,'passed',saved.error);assert.equal(saved.results.length,4);assert.ok(saved.results.every(row=>row.passed && row.screenshot));assert.equal(finished.record.approval,null);
  console.log('PASS: installed browser runner verified pink color, clicked Add a note, confirmed response, saved four screenshots, and did not grant approval.');
  app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
