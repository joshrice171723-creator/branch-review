const {app,BrowserWindow,session}=require('electron');
const {readFile}=require('node:fs/promises');
const path=require('node:path'),assert=require('node:assert/strict');
app.whenReady().then(async()=>{
 const isolated=session.fromPartition('retest-flow-'+Date.now());
 await isolated.protocol.handle('http',async request=>{
  const file=new URL(request.url).pathname.slice(1);
  if(!['guided.js','review-model.js'].includes(file))return new Response('Not found',{status:404});
  return new Response(await readFile(path.join(__dirname,'../public',file)),{headers:{'Content-Type':'application/javascript'}});
 });
 const win=new BrowserWindow({show:false,webPreferences:{session:isolated}});
 try{
  await win.loadURL('http://review.test/');
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const {guided}=await import('/guided.js');
   const ids=${JSON.stringify((await readFile(path.join(__dirname,'../public/guided.js'),'utf8')).match(/\$\('[^']+'\)/g).map(s=>s.slice(3,-2)))};
   for(const id of new Set(ids)){const node=document.createElement(id==='item-filter'?'select':'div');node.id=id;if(id==='item-filter')node.innerHTML='<option value="all">All</option><option value="attention">Attention</option>';document.body.append(node);}
   const record={id:'test',identity:{changed:'after'},fixComparison:{before:'before',after:'after'},manifest:{scenarios:[{id:'fix',title:'Fix',path:'/same',steps:['Problem resolved']},{id:'passed',title:'Passed',path:'/same',steps:['Done']},{id:'remaining',title:'Remaining',path:'/same',steps:['Check']}]},items:{},checks:{'passed:0':true},issues:[{id:'finding',scenario:'fix',status:'needs-retest',expected:'No brown shadow'}],cursor:{itemId:'fix',view:'item'}};
   const state={record,status:'ready'},calls=[];
   const view=guided({getState:()=>state,poll:async()=>view.render(state),error:message=>{throw Error(message)},onSelect:()=>{},api:async(url,data)=>{calls.push(url);if(url==='/api/resolve')record.issues[0].status='resolved';if(url==='/api/cursor')record.cursor={itemId:data.itemId,view:data.view};}});
   view.render(state);await document.getElementById('item-next').onclick();
   const blocked=!document.getElementById('unfinished-choice').hidden && !calls.includes('/api/resolve');
   record.checks['fix:0']=true;view.render(state);await document.getElementById('item-next').onclick();
   const next=record.cursor.itemId,filter=document.getElementById('item-filter').value;
   record.checks['remaining:0']=true;view.render(state);await document.getElementById('item-next').onclick();
   return {blocked,next,filter,summary:record.cursor.view,resolutions:calls.filter(c=>c==='/api/resolve').length,oldButtonHidden:document.getElementById('verify-fix').hidden};
  })()`);
  assert.deepEqual(result,{blocked:true,next:'remaining',filter:'all',summary:'results',resolutions:1,oldButtonHidden:true});
  console.log('PASS: real Electron retest controls require checks, verify once, skip passed items, escape fix filter and show summary only after completion');
  win.destroy();app.exit(0);
 }catch(error){console.error(error);win.destroy();app.exit(1);}
});
