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

test('startup detects a missing or non-Git previous project before opening its server',async()=>{
 const exec=async(file,args,{cwd})=>{assert.equal(file,'git');assert.deepEqual(args,['rev-parse','--show-toplevel']);if(cwd==='/moved')throw Error('directory missing');return {stdout:cwd};};
 assert.equal(await repository.availableRepository('/present',exec),true);
 assert.equal(await repository.availableRepository('/moved',exec),false);
});

test('switch project starts in the current repository; first run keeps the system default',async()=>{
 const shown=[],window={};
 const dialog={showOpenDialog:async(...args)=>{shown.push(args.at(-1));return {canceled:true};}};
 await repository.chooseRepository({dialog,window,repository:'C:/projects/current'});
 await repository.chooseRepository({dialog});
 assert.equal(shown[0].defaultPath,'C:/projects/current');
 assert.equal(Object.hasOwn(shown[1],'defaultPath'),false);
});
