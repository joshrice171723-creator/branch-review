import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendOnly,groupedBranches,focusRetest,mergeFixPlan,carryUnchangedChecks,colorFixPlan,appearanceFixPlan} from '../fix-review.mjs';
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
 async function exercise(files,dirty='',warm=false){
  const calls=[],saved=[];
  const old={sha:'old',database:'existing_database',scenario:{path:'/demo'},runtime:'standby'};
  const context={previewHealth:async snapshot=>({sides:{original:{ok:typeof warm==='function'?warm(snapshot.original):warm}}}),project:{kind:'meta-clinic'},path:{join:(...parts)=>parts.join('/'),resolve:value=>value},previewRoot:'/previews',local:'/data',root:'/app',state:{comparison:{files}},slots:{standby:{api:1,web:2}},scenarioRecipe:()=> 'recipe',frontendOnly,createHash:()=>({update:()=>({digest:()=> 'hash'})}),exists:async()=>true,assertOwner:async()=>{},progress:()=>{},environment:()=>({APPLY_DEVELOPMENT_DATABASE:'new_database'}),
   readFile:async file=>{if(file==='/app/recipe')return'fixture';if(file.includes('-old-hash'))return JSON.stringify(old);throw Error('missing');},
   writeFile:async(file,data)=>saved.push(JSON.parse(data)),git:async(...args)=>args[0]==='diff'?files.join('\0'):'/repo/git',
   run:async(command,args)=>{if(command==='ruby')return 'BRANCH_REVIEW={"path":"/demo"}';if(args.includes('--git-common-dir'))return'/repo/git';if(args[0]==='status')return dirty;if(args[0]==='rev-parse')return'old';return'';},
   lifecycle:async(...args)=>calls.push(args)};
  vm.createContext(context);vm.runInContext(prepareSource+';globalThis.prepare=prepare;',context);
  const result=await context.prepare('standby','new',files);return{calls,saved,result};
 }
 const fast=await exercise(['apps/web/src/Button.tsx']);assert.deepEqual(fast.calls.map(call=>call[2]),['stop','start']);assert.equal(fast.calls[1][3],'existing_database');assert.equal(fast.result.database,'existing_database');assert.equal(fast.result.sha,'new');
 const warm=await exercise(['apps/web/src/Button.tsx'],'',true);assert.deepEqual(warm.calls,[]);assert.equal(warm.result.sha,'new');assert.equal(warm.result.database,'existing_database');
 const identical=await exercise([],'',true);assert.deepEqual(identical.calls,[]);assert.equal(identical.result.sha,'new');assert.equal(identical.result.database,'existing_database');
 const identicalStopped=await exercise([]);assert.deepEqual(identicalStopped.calls.map(call=>call[2]),['stop','start']);assert.equal(identicalStopped.result.database,'existing_database');
 const stale=await exercise(['apps/web/src/Button.tsx'],'',preview=>preview.sha==='old');assert.deepEqual(stale.calls.map(call=>call[2]),['stop','start']);
 const full=await exercise(['apps/api/model.rb']);assert.deepEqual(full.calls.map(call=>call[2]),['stop','setup','start']);assert.equal(full.result.database,'new_database');
 await assert.rejects(exercise(['apps/web/src/Button.tsx'],' M Button.tsx'),/has edits/);
});
test('uncommitted fix attempts stay in Jobs while independently changed branches stay visible',()=>{
 const original={ref:prior.identity.ref,sha:'source'},attempt={ref:'refs/heads/branch-review/attempt',sha:'before'};
 const jobs=[{kind:'fix',status:'failed',reviewId:prior.id,branch:'branch-review/attempt',commit:'before'}];
 assert.deepEqual(groupedBranches([original,attempt],jobs,[prior]),[original]);
 assert.equal(groupedBranches([original,{...attempt,sha:'independent'}],jobs,[prior]).length,2);
});

test('color-only fixes reuse mapped screens without stale expectations; broader changes regenerate',async()=>{
 const file='apps/web/src/button.css',record={...prior,integration:{main:'main'},manifest:{version:2,scenarios:[{...tutorial,files:[file],focus:'Sandbox',steps:['Must be purple']}]}};
 const git=async(_,ref)=>ref.startsWith('before:')?'.button{color:#abc;background:#123456}':'.button{color:#fff;background:#654321}';
 const plan=await colorFixPlan(git,record,'after',[file],'main');
 assert.equal(plan.scenarios[0].path,tutorial.path);assert.equal(plan.scenarios[0].focus,'Sandbox');assert.match(plan.scenarios[0].description,/#123456 to #654321/);assert.ok(!JSON.stringify(plan).includes('purple'));
 assert.equal(await colorFixPlan(git,record,'after',[file],'new-main'),null);
 for(const css of ['#abc{color:red}', '/* #abc */ .button{color:red}', '.button{background:url("#abc")}'])assert.equal(await colorFixPlan(async(_,ref)=>ref.startsWith('before:')?css:css.replace('#abc','#def'),record,'after',[file],'main'),null);
 assert.equal(await colorFixPlan(git,record,'after',['unknown.css'],'main'),null);
 assert.equal(await colorFixPlan(async(_,ref)=>await git(_,ref)+(ref.startsWith('after:')?' .new{}':''),record,'after',[file],'main'),null);
});

test('a fix opens on the previously selected affected screen',()=>{
 const record={identity:{changed:'after'},manifest:prior.manifest,issues:[],items:{}};
 focusRetest(record,{...prior,cursor:{itemId:tutorial.id}},[...home.files,...tutorial.files]);
 assert.equal(record.cursor.itemId,tutorial.id);
});

test('appearance-only changes build exact checks locally; structural and behavioral CSS falls back',async()=>{
 const file='button.css',record={...prior,integration:{main:'main'},manifest:{version:2,scenarios:[{...tutorial,files:[file]}]}};
 const before='.button { border-radius: 16px; color: blue; }';
 const make=after=>appearanceFixPlan(async(_,ref)=>ref.startsWith('before:')?before:after,record,'after',[file],'main');
 const plan=await make(before.replace('16px','24px'));
 assert.equal(plan.scenarios[0].path,tutorial.path);assert.match(plan.scenarios[0].description,/16px/);assert.match(plan.scenarios[0].description,/24px/);
 for(const after of [before.replace('.button','.other'),before+' .new {color:red;}',before.replace('border-radius','display'),before.replace('16px','url(secret)'),before])assert.equal(await make(after),null);
 assert.equal(await appearanceFixPlan(async()=>before,record,'after',[file],'moved-main'),null);
});
test('latest affected item wins over an unrelated old finding',()=>{
 const record={identity:{changed:'after'},manifest:prior.manifest,issues:[{scenario:home.id,status:'needs-retest'}],items:{}};
 focusRetest(record,{...prior,cursor:{itemId:home.id}},tutorial.files);
 assert.equal(record.cursor.itemId,tutorial.id);assert.equal(record.issues[0].scenario,home.id);
});

test('latest request page wins when a shared stylesheet affects several screens',()=>{
 const record={identity:{changed:'after'},manifest:prior.manifest,issues:[],items:{}};
 focusRetest(record,{...prior,cursor:{itemId:home.id}},[...home.files,...tutorial.files],tutorial.path+'?test=1');
 assert.equal(record.cursor.itemId,tutorial.id);
});
