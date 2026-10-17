import test from 'node:test';
import assert from 'node:assert/strict';
import {setupChecks} from '../setup-checks.mjs';
import repository from '../desktop/repository.cjs';
const options=()=>({git:async()=> 'configured',run:async()=> 'git version',defaultBranch:async()=> 'main',project:{kind:'vite'},recipe:async()=>null,agent:{provider:'codex'},probe:async()=>({status:'ready',message:'Signed in'}),npm:async()=>'/npm.js'});
test('first-run diagnostics reuse automatic setup and expose actionable independent failures',async()=>{
 const ready=await setupChecks(options());assert.ok(ready.every(row=>row.ok));
 const config=options();config.git=async(...args)=>{if(args[0]==='remote')throw Error('raw git failure');return 'ok';};config.probe=async()=>({status:'sign-in',message:'Sign in to Codex'});config.npm=async()=>{throw Error('Install Node.js with npm');};
 const rows=await setupChecks(config);assert.deepEqual(rows.filter(row=>!row.ok).map(row=>row.name),['Remote','Preview setup','Codex connection']);assert.match(rows.find(row=>row.name==='Remote').message,/origin/);
 config.project={kind:'custom',needsSetup:true};config.recipe=async()=>({start:['node','server.mjs']});assert.equal((await setupChecks(config)).find(row=>row.name==='Preview setup').ok,true);
});
test('invalid folder can be corrected or cancelled without replacing the current project',async()=>{
 let selections=0,notices=0;
 const dialog={showOpenDialog:async()=>({filePaths:[++selections===1?'invalid':'valid']}),showMessageBox:async()=>{notices++;return {response:0};}};
 const exec=async(_,__,options)=>{if(options.cwd==='invalid')throw Error('not git');return {stdout:'/valid'};};
 assert.deepEqual(await repository.chooseRepository({dialog,exec,detectProject:async()=>({kind:'vite'})}),{repository:'/valid',projectInfo:{kind:'vite'}});assert.equal(notices,1);
 dialog.showOpenDialog=async()=>({canceled:true});assert.equal(await repository.chooseRepository({dialog,exec}),null);
});
