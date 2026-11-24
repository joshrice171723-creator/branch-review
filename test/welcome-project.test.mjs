import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import path from 'node:path';

const script=await readFile(new URL('../desktop/welcome.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function screen(git,probe,chat){
  const nodes=new Map(), openings=[];
  function get(id){
    if(!nodes.has(id))nodes.set(id,{value:'codex',events:{},hidden:true,append(){},addEventListener(name,listener){this.events[name]=listener;}});
    return nodes.get(id);
  }
  runInNewContext(script,{document:{getElementById:get,createElement:()=>({append(){}})},window:{welcome:{git,probe,chat,choose:async (...args)=>openings.push(args)}}});
  return {get,openings};
}

test('Git enables repository selection while the coding agent is still checking or signed out',async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const {get,openings}=screen(async()=>true,()=>pending);
  await tick();
  assert.equal(get('choose').disabled,false);
  assert.equal(get('chat-send').disabled,true);
  finish({status:'sign-in'});
  await tick();
  assert.equal(get('choose').disabled,false);
  assert.match(get('agent-status').textContent,/Sign in to Codex to use agent features/);
  await get('choose').events.click();
  assert.deepEqual(openings,[['codex',undefined]]);
});

test('a connected agent does not bypass the Git requirement',async()=>{
  const {get}=screen(async()=>false,async()=>({status:'ready'}));
  await tick();
  assert.equal(get('choose').disabled,true);
  assert.equal(get('chat-send').disabled,true);
  assert.equal(get('git-help').hidden,false);
});

test('a failed first-project search offers retry without duplicating the request',async()=>{
  const requests=[];
  const {get}=screen(async()=>true,async()=>({status:'ready'}),async(_provider,messages)=>{
    requests.push(structuredClone(messages));
    if(requests.length===1)throw Error('The project finder could not connect.');
    return {message:'Found the project.',project:{name:'Fixture',path:'C:/fixture'}};
  });
  await tick();
  get('chat-input').value='Find Fixture';
  await get('chat-form').events.submit({preventDefault(){}});
  assert.equal(get('retry-search').hidden,false);
  assert.match(get('status').textContent,/could not connect/);
  await get('retry-search').onclick();
  assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[1].length,1);
  assert.equal(get('retry-search').hidden,true);
  assert.equal(get('found-project').hidden,false);
  assert.equal(get('found-name').textContent,'Fixture');
});

test('project IPC reports an unfamiliar failure and preserves explicit cancellation',async()=>{
  const source=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
  const handlers=new Map(), observations=[];
  const context={ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},path};
  runInNewContext(source.slice(source.indexOf('function projectHandler('),source.indexOf('async function firstProject(')),context);
  let outcome='error';
  const issue=Error('A new project selection failure.');
  context.projectHandler({operation:(...args)=>observations.push(args)},()=>{},'review:choose-repository','Open a project',async()=>{
    if(outcome==='error')throw issue;
    if(outcome==='cancel')return null;
    return {repository:'C:/fixture'};
  });
  const handler=handlers.get('review:choose-repository');
  await assert.rejects(handler({}),/new project selection failure/);
  assert.equal(observations[0][2],issue);
  outcome='cancel';
  assert.equal(await handler({}),null);
  assert.equal(observations.length,1);
  outcome='success';
  assert.equal((await handler({})).repository,'C:/fixture');
  assert.equal(observations.length,2);
  assert.equal(observations[1][2],undefined);
});

test('selection recovery verifies the exact target after its workspace renders',async()=>{
  const source=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
  const context={path};
  runInNewContext(source.slice(source.indexOf('function projectHandler('),source.indexOf('async function firstProject(')),context);
  const observations=[];
  let clears=0;
  const intent={repository:'C:/fixture',identity:'review:choose-repository:fixture'};
  const verify=values=>context.verifyProjectSelection({intent,diagnostics:{operation:(...args)=>observations.push(args)},
    clear:async()=>{clears++;},...values});
  assert.equal(await verify({repository:'C:/fixture',loaded:false}),false);
  assert.equal(clears,0);
  assert.equal(observations.length,0);
  assert.equal(await verify({repository:'C:/different',loaded:true}),false);
  assert.equal(clears,1);
  assert.match(observations[0][2].message,/selected project did not open/);
  assert.equal(observations[0][2].action,'Choose the project again');
  assert.equal(await verify({repository:'C:/fixture',loaded:true}),true);
  assert.equal(clears,2);
  assert.equal(observations[1][1],intent.identity);
  assert.equal(observations[1][2],undefined);
  await assert.rejects(verify({repository:'C:/fixture',loaded:true,clear:async()=>{throw Error('Settings unavailable');}}),/Settings unavailable/);
  assert.equal(observations.length,2);
  assert.equal(await verify({repository:'C:/fixture',loaded:true,title:'Restart Branch Review',nextAction:'Restart Branch Review'}),true);
  assert.equal(observations[2][0],'Restart Branch Review');
  assert.equal(observations[2][1],intent.identity);
});

test('desktop capture failures reach Coordinator while owned server failures and queued work keep their owner',async()=>{
  const source=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
  const handlers=new Map(),observations=[];
  const context={path,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}};
  runInNewContext(source.slice(source.indexOf('function projectHandler('),source.indexOf('async function firstProject(')),context);
  const diagnostics={operation:(...args)=>observations.push(args)};
  let issue=Error('Unfamiliar screenshot failure.');
  context.projectHandler(diagnostics,event=>{if(!event.trusted)throw Error('Untrusted frame.');},
    'review:capture','Capture workspace',async()=>{if(issue)throw issue;return 'data:image/png;base64,fixture';},
    undefined,()=>JSON.stringify(['review:capture','fixture-project']));
  const capture=handlers.get('review:capture');
  await assert.rejects(capture({trusted:false}),/Untrusted frame/);
  assert.equal(observations.length,0);
  await assert.rejects(capture({trusted:true}),/Unfamiliar screenshot failure/);
  assert.equal(observations[0][2],issue);
  assert.equal(observations[0][1],JSON.stringify(['review:capture','fixture-project']));
  issue=Object.assign(Error('Server already sent this to Coordinator.'),{coordinatorReported:true});
  await assert.rejects(capture({trusted:true}),/already sent/);
  assert.equal(observations.length,1);
  issue=null;
  assert.match(await capture({trusted:true}),/^data:image/);
  assert.equal(observations.length,2);
  assert.equal(observations[1][2],undefined);
  context.projectHandler(diagnostics,()=>{},'review:browser-qa','Start browser checks',async()=>({id:'queued-run'}),()=>false);
  assert.equal((await handlers.get('review:browser-qa')({})).id,'queued-run');
  assert.equal(observations.length,2);
});
