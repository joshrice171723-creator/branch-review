import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendOnly,groupedBranches,focusRetest,mergeFixPlan,carryUnchangedChecks} from '../fix-review.mjs';
const item=(id,path,file)=>({id,title:id,path,files:[file],steps:['Check color']});
const home=item('home','/meta-clinic','apps/web/src/Home.tsx'),tutorial=item('tutorial','/meta-clinic/resources','apps/web/src/Tutorial.tsx');
const prior={id:'review',title:'Two buttons',identity:{ref:'refs/heads/demo',source:'source',changed:'before'},manifest:{scenarios:[home,tutorial]},checks:{'home:0':true,'tutorial:0':true},items:{},issues:[]};
test('fix branches collapse under their original review without hiding independent or moved branches',()=>{
 const original={ref:'refs/heads/demo',sha:'source',aliases:[]},fix={ref:'refs/heads/branch-review/fix',sha:'after',aliases:[]},other={ref:'refs/heads/other',sha:'other'};
 const jobs=[{id:'job',kind:'fix',status:'succeeded',reviewId:'review',branch:'branch-review/fix',resultCommit:'after'}];
 const grouped=groupedBranches([original,fix,other],jobs,[prior]);assert.equal(grouped.length,2);assert.equal(grouped[0].name,'demo');assert.equal(grouped[0].fixJob,'job');assert.ok(grouped[0].aliases.includes(original.ref));
 assert.equal(groupedBranches([{...original,sha:'independent'},fix,other],jobs,[prior]).length,3);
 assert.equal(groupedBranches([original,{...fix,sha:'moved'},other],jobs,[prior]).length,3);
});
test('only frontend source changes can skip dependency and database setup',()=>{
 assert.equal(frontendOnly(['apps/web/src/Button.tsx']),true);
 for(const files of [[],['apps/api/db/migrate/change.rb'],['apps/web/package.json'],['pnpm-lock.yaml'],['apps/web/src/Button.tsx','apps/api/model.rb']])assert.equal(frontendOnly(files),false);
});
test('fix plan keeps unaffected items and stable IDs and lands directly on the unresolved finding',()=>{
 const plan=mergeFixPlan(prior.manifest,{scenarios:[{...tutorial,id:'new-id',steps:['Check blue']}]},tutorial.files);
 assert.deepEqual(plan.scenarios[0],home);assert.equal(plan.scenarios[1].id,'tutorial');
 const record={id:'new',identity:{changed:'after'},manifest:plan,checks:{},items:{},issues:[{scenario:'tutorial',status:'needs-retest'}]};
 focusRetest(record,prior,tutorial.files);carryUnchangedChecks(record,prior,tutorial.files);
 assert.equal(record.reviewRootId,'review');assert.equal(record.cursor.itemId,'tutorial');assert.equal(record.checks['home:0'],true);assert.equal(record.checks['tutorial:0'],undefined);assert.equal(record.items.home.verifiedAtCommit,'before');assert.deepEqual(record.fixComparison,{before:'before',after:'after'});
 assert.equal(prior.checks['tutorial:0'],true);
});

test('frontend-only preparation reuses data and skips setup; backend changes use full preparation',async()=>{
 const {readFile}=await import('node:fs/promises'),vm=await import('node:vm');
 const source=await readFile(new URL('../adapter.mjs',import.meta.url),'utf8');
 const prepareSource=source.slice(source.indexOf('export async function prepare('),source.indexOf('export async function resetScenario')).replace('export async function','async function');
 async function exercise(files,dirty=''){
  const calls=[],saved=[];
  const old={sha:'old',database:'existing_database',scenario:{path:'/demo'},runtime:'standby'};
  const context={project:{kind:'meta-clinic'},path:{join:(...parts)=>parts.join('/'),resolve:value=>value},previewRoot:'/previews',local:'/data',root:'/app',state:{comparison:{files}},slots:{standby:{api:1,web:2}},scenarioRecipe:()=> 'recipe',frontendOnly,createHash:()=>({update:()=>({digest:()=> 'hash'})}),exists:async()=>true,assertOwner:async()=>{},progress:()=>{},environment:()=>({APPLY_DEVELOPMENT_DATABASE:'new_database'}),
   readFile:async file=>{if(file==='/app/recipe')return'fixture';if(file.includes('-old-hash'))return JSON.stringify(old);throw Error('missing');},
   writeFile:async(file,data)=>saved.push(JSON.parse(data)),git:async(...args)=>args[0]==='diff'?files.join('\0'):'/repo/git',
   run:async(command,args)=>{if(command==='ruby')return 'BRANCH_REVIEW={"path":"/demo"}';if(args.includes('--git-common-dir'))return'/repo/git';if(args[0]==='status')return dirty;if(args[0]==='rev-parse')return'old';return'';},
   lifecycle:async(...args)=>calls.push(args)};
  vm.createContext(context);vm.runInContext(prepareSource+';globalThis.prepare=prepare;',context);
  const result=await context.prepare('standby','new',files);return{calls,saved,result};
 }
 const fast=await exercise(['apps/web/src/Button.tsx']);assert.deepEqual(fast.calls.map(call=>call[2]),['stop','start']);assert.equal(fast.calls[1][3],'existing_database');assert.equal(fast.result.database,'existing_database');assert.equal(fast.result.sha,'new');
 const full=await exercise(['apps/api/model.rb']);assert.deepEqual(full.calls.map(call=>call[2]),['stop','setup','start']);assert.equal(full.result.database,'new_database');
 await assert.rejects(exercise(['apps/web/src/Button.tsx'],' M Button.tsx'),/has edits/);
});
test('uncommitted fix attempts stay in Jobs while independently changed branches stay visible',()=>{
 const original={ref:prior.identity.ref,sha:'source'},attempt={ref:'refs/heads/branch-review/attempt',sha:'before'};
 const jobs=[{kind:'fix',status:'failed',reviewId:prior.id,branch:'branch-review/attempt',commit:'before'}];
 assert.deepEqual(groupedBranches([original,attempt],jobs,[prior]),[original]);
 assert.equal(groupedBranches([original,{...attempt,sha:'independent'}],jobs,[prior]).length,2);
});
