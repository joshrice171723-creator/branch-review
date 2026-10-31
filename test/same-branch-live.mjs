// Explicit acceptance run: real CLI edits, real previews, real Electron controls, disposable Git repository.
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PlanStore} from '../plans.mjs';
import {saveRecipe} from '../project-settings.mjs';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const directory=await mkdtemp(path.join(os.tmpdir(),'branch-workflow-live-')),repo=path.join(directory,'repo'),home=path.join(directory,'home');await mkdir(repo);await mkdir(home);
const git=async(...args)=>(await exec('git',args,{cwd:repo,windowsHide:true})).stdout.trim();
await git('init','-b','main');await git('config','user.name','Synthetic acceptance');await git('config','user.email','test@example.invalid');
await writeFile(path.join(repo,'package.json'),'{"name":"Button workshop","type":"module"}');
await writeFile(path.join(repo,'index.html'),'<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Button workshop</h1><button id="button">Continue</button></body></html>');
await writeFile(path.join(repo,'style.css'),'button{background-color:#2563eb;color:#ffffff;padding:20px;border:0}');
await writeFile(path.join(repo,'server.mjs'),"import http from 'node:http';import{readFile}from'node:fs/promises';http.createServer(async(req,res)=>{try{const file=req.url==='/style.css'?'style.css':'index.html';res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(file));}catch{res.statusCode=500;res.end('Failed');}}).listen(Number(process.env.PORT),'127.0.0.1');");
await git('add','.');await git('commit','-m','Baseline blue button');const base=await git('rev-parse','HEAD');
const remote=path.join(directory,'origin.git');await exec('git',['init','--bare','-b','main',remote],{windowsHide:true});await git('remote','add','origin',remote);await git('push','-u','origin','main');await git('remote','set-head','origin','main');
await git('checkout','-b','feature/button');await writeFile(path.join(repo,'style.css'),'button{background-color:#7c3aed;color:#ffffff;padding:20px;border:0}');await git('commit','-am','Initial purple button');const initial=await git('rev-parse','HEAD');
await writeFile(path.join(home,'config.json'),JSON.stringify({repository:repo,previewRoot:path.join(home,'previews')}));
await saveRecipe(home,{start:[process.execPath,'server.mjs']});
await writeFile(path.join(home,'onboarding.json'),JSON.stringify({repository:repo,completedAt:new Date().toISOString()}));
await new PlanStore(path.join(home,'diff-reviews')).save(initial,{version:2,summary:'Review the Continue button color',scenarios:[{id:'button',title:'Check Continue button',path:'/',description:'Button color changed',instructions:'Compare the button colors.',expected:'The requested button color is visible.',steps:['The button has the requested color.','The label stays readable.'],files:['style.css']}]});
await writeFile(path.join(directory,'fixture.json'),JSON.stringify({directory,repo,home,base,initial}));console.log('Fixture: '+directory);
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,BRANCH_REVIEW_HOME:home,META_CLINIC_REPO:repo},windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';server.stdout.on('data',c=>log+=c);server.stderr.on('data',c=>log+=c);
try{
  const deadline=Date.now()+30000;while(true){try{const state=await fetch('http://127.0.0.1:4310/api/state').then(r=>r.json());if(state.repository===repo)break;}catch{}assert.ok(Date.now()<deadline,log);await new Promise(r=>setTimeout(r,200));}
  const electronEnv={...process.env};delete electronEnv.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),['test/same-branch-ui.cjs',directory],{cwd:root,windowsHide:true,env:electronEnv,stdio:'inherit'});
  const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,0,'Electron workflow failed');
  const branches=await git('for-each-ref','--format=%(refname)','refs/heads');assert.equal(branches,'refs/heads/feature/button\nrefs/heads/main');
  const history=await git('log','--format=%s',`${base}..feature/button`);assert.equal(history.split('\n').length,4);assert.match(history,/Restore branch version/);
  console.log('PASS: actual Codex revisions and restore preserved one work branch, four commits, and clean checked-out files.');
}finally{
  try{const state=await fetch('http://127.0.0.1:4310/api/state').then(r=>r.json());await fetch('http://127.0.0.1:4310/api/stop',{method:'POST',headers:{Origin:'http://127.0.0.1:4310','X-Review-Token':state.token,'Content-Type':'application/json'},body:'{}'});for(let i=0;i<100;i++){if(!(await fetch('http://127.0.0.1:4310/api/state').then(r=>r.json())).busy)break;await new Promise(r=>setTimeout(r,100));}}catch{}
  server.kill();await writeFile(path.join(directory,'server.log'),log);console.log('Evidence retained at '+directory);
}
