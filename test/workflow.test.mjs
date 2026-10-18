import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from '../public/workflow.js';
import { findingKey, loadDraft, saveDraft } from '../public/drafts.js';
import { defaultManifest } from '../reviews.mjs';

function harness(t, options = {}) {
  class Element {
    value = ''; children = []; hidden = false; disabled = false; dataset = {};
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get firstChild() { return this.children[0]; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    scrollIntoView() { this.scrolled = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    reset() { elements.expected.value = ''; elements.actual.value = ''; }
  }
  const elements = new Proxy({}, {get(target, key) { return target[key] ||= new Element(); }});
  const saved = new Map(), calls = [];
  globalThis.document = {getElementById: id => elements[id], createElement: () => new Element()};
  globalThis.window = {desktop:{capture:options.capture || (async()=> 'data:image/png;base64,example')}};
  globalThis.localStorage = {getItem:key=>saved.get(key), setItem:(key,value)=>saved.set(key,value), removeItem:key=>saved.delete(key)};
  t.after(()=>{delete globalThis.document;delete globalThis.window;delete globalThis.localStorage;delete globalThis.confirm;});
  const state = {status:'ready', busy:false, repository:'test', record:{id:'review-a',identity:{ref:'refs/heads/test',base:'aaaaaaa',changed:'bbbbbbb'},manifest:defaultManifest,checks:{},issues:[],updatedAt:'1'}};
  let side = 'changed';
  const view = workflow({getState:()=>state,getSide:()=>side,error:message=>{elements.error.textContent=message;},reopen:options.reopen || (()=>{}),
    api:async(path,data)=>{calls.push({path,data});if(path==='/api/history')return [];return options.api?.(path,data);},poll:async()=>view.render(state)});
  view.render(state);
  return {elements,state,view,calls,saved,switchSide(next){side=next;view.viewChanged();}};
}

test('successful Publish opens Office automatically once, and handoff failure stays visible',async t=>{
  const h=harness(t),opened=[];
  window.desktop.openPublished=async url=>opened.push(url);globalThis.confirm=()=>true;
  h.state.publishTarget='https://aimetaclinic.com';h.state.record.delivery={stage:'pushed'};
  h.elements.publish.onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opened.length,0);
  h.state.record.delivery.stage='published';h.state.record.museQa={status:'handoff-failed',error:'Connection unavailable'};
  h.view.render(h.state);h.view.render(h.state);
  assert.deepEqual(opened,['https://aimetaclinic.com/qa?view=office']);
  assert.equal(h.elements['retry-muse'].hidden,false);assert.match(h.elements['muse-qa-state'].textContent,/Connection unavailable/);
});

test('finding drafts stay with their exact review, scenario and side; screenshots never cross sides', async t => {
  const h = harness(t), {elements:e,view,state} = h;
  e.expected.value='Changed expectation';e.actual.value='Changed observation';e.expected.oninput();
  await e.capture.onclick();assert.equal(e.attachment.hidden,false);
  h.switchSide('original');assert.equal(e.expected.value,'');assert.equal(e.attachment.hidden,true);
  e.expected.value='Original expectation';e.expected.oninput();
  h.switchSide('changed');assert.equal(e.expected.value,'Changed expectation');assert.equal(e.actual.value,'Changed observation');
  state.record={...state.record,id:'review-b'};view.render(state);assert.equal(e.expected.value,'');
  state.record={...state.record,id:'review-a'};view.render(state);assert.equal(e.expected.value,'Changed expectation');
  await e['finding-form'].onsubmit({preventDefault(){}});
  const submitted=h.calls.find(c=>c.path==='/api/issue').data;
  assert.equal(submitted.side,'changed');assert.equal(submitted.screenshot,null);
  assert.equal(e.expected.value,'');assert.equal(h.saved.has(findingKey('review-a','intake','changed')),false);
});

test('late screenshot capture is discarded after a toggle and failed saves retain draft text', async t => {
  let finish;
  const h=harness(t,{capture:()=>new Promise(resolve=>{finish=resolve;}),api:async()=>{throw Error('Save failed');}}),e=h.elements;
  const capturing=e.capture.onclick();h.switchSide('original');finish('data:image/png;base64,example');await capturing;
  assert.equal(e.attachment.hidden,true);
  e.expected.value='Keep me';e.actual.value='Failure';e.expected.oninput();
  await e['finding-form'].onsubmit({preventDefault(){}});
  assert.equal(e.expected.value,'Keep me');assert.equal(e.error.textContent,'Save failed');assert.equal(e.report.disabled,false);
});

test('unfinished retest notes survive checklist and busy-state rerenders', t => {
  const h=harness(t),e=h.elements;
  h.state.record.issues=[{id:'issue',status:'open',expected:'a',actual:'b',side:'changed',commit:'bbbbbbb',scenario:'intake',consoleErrors:[]}];h.view.render(h.state);
  let note=e.findings.children[0].children.find(n=>n.placeholder==='Describe the retest result');note.value='Retest still in progress';note.oninput();
  h.state.busy=true;h.view.render(h.state);h.state.busy=false;h.view.render(h.state);
  note=e.findings.children[0].children.find(n=>n.placeholder==='Describe the retest result');assert.equal(note.value,'Retest still in progress');
});

test('broken or unavailable local draft storage does not break review controls', () => {
  assert.deepEqual(loadDraft({getItem:()=>'{broken'},'key'),{expected:'',actual:''});
  assert.equal(saveDraft({setItem(){throw Error('Full');}},'key',{expected:'a',actual:'b'}),false);
});

test('heading focus does not reload an intake screen merely because the app removed its anchor',t=>{
  const h=harness(t),item=h.state.record.manifest.scenarios[0];
  h.state.original={scenario:{path:'/clinic/patients/1/encounters/2#nurse-workspace'}};
  h.state.changed={scenario:{path:'/clinic/patients/1/encounters/2#nurse-workspace'}};
  h.view.context('changed',{location:'/clinic/patients/1/encounters/2'});
  assert.equal(h.view.needsNavigation(item),false);
  h.view.context('changed',{location:'/clinic/patients/1'});
  assert.equal(h.view.needsNavigation(item),true);
});

test('Next leaves unchecked items unfinished and requires an explicit continue choice', async t => {
  let h;
  h=harness(t,{api:async(path,data)=>{if(path==='/api/cursor')h.state.record.cursor={itemId:data.itemId,view:data.view};}});
  h.state.record.manifest={...defaultManifest,scenarios:[defaultManifest.scenarios[0],{...defaultManifest.scenarios[0],id:'second',title:'Second item'}]};h.view.render(h.state);
  await h.elements['item-next'].onclick();
  assert.equal(h.elements['unfinished-choice'].hidden,false);assert.equal(h.elements['unfinished-choice'].scrolled,true);
  assert.equal(h.calls.some(call=>call.path==='/api/cursor'),false);
  await h.elements['leave-unfinished'].onclick();
  assert.equal(h.state.record.cursor.itemId,'second');assert.deepEqual(h.state.record.checks,{});
  assert.equal(h.elements['guided-item'].scrolled,true);
});

test('item notes save before navigation and save failures prevent leaving the item',async t=>{
  let h, fail=true;
  h=harness(t,{api:async(path,data)=>{
    if(path==='/api/item'){if(fail)throw Error('Disk unavailable');h.state.record.items={[data.itemId]:data};}
    if(path==='/api/cursor')h.state.record.cursor={itemId:data.itemId,view:data.view};
  }});
  h.elements['item-notes'].value='Keep this note';h.elements['item-notes'].oninput();
  await h.elements['show-results'].onclick();
  assert.equal(h.state.record.cursor,undefined);assert.equal(h.elements['item-notes'].value,'Keep this note');
  fail=false;await h.elements['show-results'].onclick();
  assert.equal(h.state.record.items.intake.notes,'Keep this note');assert.equal(h.state.record.cursor.view,'results');
});

test('rapid Next clicks create only one navigation while saving',async t=>{
  let h,release;
  h=harness(t,{api:async(path,data)=>{
    if(path==='/api/item')await new Promise(resolve=>{release=resolve;});
    if(path==='/api/cursor')h.state.record.cursor={itemId:data.itemId,view:data.view};
  }});
  h.state.record.manifest={...defaultManifest,scenarios:[defaultManifest.scenarios[0],{...defaultManifest.scenarios[0],id:'second'}]};h.view.render(h.state);
  h.elements['item-notes'].value='Pending note';h.elements['item-notes'].oninput();
  const first=h.elements['leave-unfinished'].onclick(),second=h.elements['leave-unfinished'].onclick();
  await new Promise(resolve=>setImmediate(resolve));release();await Promise.all([first,second]);
  assert.equal(h.calls.filter(call=>call.path==='/api/cursor').length,1);assert.equal(h.state.record.cursor.itemId,'second');
});

test('navigating outside a queue filter reveals the selected item without losing its notes',async t=>{
  let h;
  h=harness(t,{api:async(path,data)=>{if(path==='/api/cursor')h.state.record.cursor={itemId:data.itemId,view:data.view};}});
  h.state.record.manifest={...defaultManifest,scenarios:[defaultManifest.scenarios[0],{...defaultManifest.scenarios[0],id:'second',title:'Second item'}]};
  h.state.record.items={second:{notes:'Resume me'}};h.view.render(h.state);
  h.elements['item-search'].value='Partially';h.elements['item-filter'].value='complete';
  await h.elements['leave-unfinished'].onclick();
  assert.equal(h.state.record.cursor.itemId,'second');
  assert.equal(h.elements['item-search'].value,'');assert.equal(h.elements['item-filter'].value,'all');
  assert.equal(h.elements['item-queue'].children.length,2);assert.equal(h.elements['item-notes'].value,'Resume me');
});

test('retest drafts recover after remount and failed item saves block approval',async t=>{
  const h=harness(t,{api:async(path)=>{if(path==='/api/item')throw Error('Disk unavailable');}}),e=h.elements;
  h.state.record.issues=[{id:'issue',status:'open',expected:'a',actual:'b',side:'changed',commit:'bbbbbbb',scenario:'intake',consoleErrors:[]}];h.view.render(h.state);
  let note=e.findings.children[0].children.find(n=>n.placeholder==='Describe the retest result');note.value='Recovered retest';note.oninput();
  const reloaded=workflow({api:async()=>[],getState:()=>h.state,getSide:()=> 'changed',error:()=>{},poll:async()=>{},reopen:()=>{}});reloaded.render(h.state);
  note=e.findings.children[0].children.find(n=>n.placeholder==='Describe the retest result');assert.equal(note.value,'Recovered retest');
  h.view.render(h.state);
  // Recreate the original event handlers before testing a failed save.
  const failing=workflow({api:async(path)=>{h.calls.push({path});if(path==='/api/item')throw Error('Disk unavailable');return [];},getState:()=>h.state,getSide:()=> 'changed',error:()=>{},poll:async()=>{},reopen:()=>{}});failing.render(h.state);
  h.state.record.issues=[];for(const item of h.state.record.manifest.scenarios)item.steps.forEach((_,i)=>h.state.record.checks[`${item.id}:${i}`]=true);
  e.reviewer.value='Josh';e['item-notes'].value='Unsaved approval context';e['item-notes'].oninput();await e.approve.onclick();
  assert.equal(h.calls.some(call=>call.path==='/api/approve'),false);
});

test('returning to an item restores its screen after navigating elsewhere',async t=>{
  const reopened=[];const h=harness(t,{reopen:force=>reopened.push(force)});
  h.state.original=h.state.changed={scenario:{path:'/clinic/patients/3/encounters/1'}};
  h.view.context('changed',{location:'/clinic/schedule',errors:[]});
  globalThis.confirm=()=>false;
  h.elements['scenario-select'].value='intake';await h.elements['scenario-select'].onchange();
  assert.equal(h.calls.some(call=>call.path==='/api/cursor'),false);
  globalThis.confirm=()=>true;await h.elements['scenario-select'].onchange();
  assert.equal(reopened.at(-1),true);
  h.view.context('changed',{location:'/clinic/patients/3/encounters/1',errors:[]});
  await h.elements['scenario-select'].onchange();assert.equal(reopened.at(-1),false);
});

test('findings filter without losing retest drafts and screenshot viewer retains exact evidence context',t=>{
  const h=harness(t),e=h.elements;
  h.state.record.issues=[
    {id:'one',status:'open',expected:'Expected',actual:'Observed',side:'changed',commit:'bbbbbbb',scenario:'intake',location:'/clinic/intake',consoleErrors:[],screenshot:'one.png'},
    {id:'two',status:'resolved',expected:'Other',actual:'Other',side:'original',commit:'aaaaaaa',scenario:'other',location:'/qa',consoleErrors:[]},
  ];h.view.render(h.state);
  const card=e.findings.children[0],note=card.children.find(n=>n.placeholder==='Describe the retest result');note.value='Retest draft';note.oninput();
  card.children.find(n=>n['aria-label']==='Enlarge finding screenshot').onclick();
  assert.equal(e['evidence-dialog'].open,true);assert.equal(e['evidence-image'].src,'/screenshots/one.png');
  assert.match(e['evidence-context'].textContent,/changed · bbbbbbb · intake · \/clinic\/intake/);
  e['close-evidence'].onclick();assert.equal(e['evidence-dialog'].open,false);assert.equal(e['evidence-image'].src,undefined);
  e['finding-filter'].value='open';e['finding-filter'].onchange();assert.equal(e.findings.children.length,1);
  e['finding-filter'].value='all';e['finding-filter'].onchange();assert.equal(e.findings.children.length,2);
  assert.equal(e.findings.children[0].children.find(n=>n.placeholder==='Describe the retest result').value,'Retest draft');
  e['finding-filter'].value='current';e['finding-filter'].onchange();assert.equal(e.findings.children.length,1);
});

test('Review fixes enters a scoped queue and Next skips unrelated unfinished work',async t=>{
  let h;h=harness(t,{api:async(path,data)=>{if(path==='/api/cursor')h.state.record.cursor={itemId:data.itemId,view:data.view};}});
  const first=defaultManifest.scenarios[0];h.state.record.manifest={...defaultManifest,scenarios:[first,{...first,id:'second'},{...first,id:'third'}]};h.state.record.items={intake:{outcome:'needs-fixes',reason:'Wrong'},third:{outcome:'blocked',reason:'Unavailable'}};h.view.render(h.state);
  await h.elements['review-fixes'].onclick();assert.equal(h.elements['fix-mode-note'].hidden,false);await h.elements['item-next'].onclick();assert.equal(h.state.record.cursor.itemId,'third');
  h.elements['exit-fix-mode'].onclick();assert.equal(h.elements['fix-mode-note'].hidden,true);assert.equal(h.elements['item-filter'].value,'all');
});

test('published view replaces editable item and keeps completed review collapsed',async t=>{
  const h=harness(t),e=h.elements;
  h.state.record.delivery={stage:'published'};h.state.record.cursor={itemId:'intake',view:'item'};
  h.state.record.museQa={status:'working',taskId:14};h.view.render(h.state);
  assert.equal(e['guided-item'].hidden,true);assert.equal(e['guided-results'].hidden,false);
  assert.equal(e['guided-queue'].hidden,true);assert.equal(e['results-options'].hidden,true);
  assert.equal(e['results-action'].textContent,'Watch Muse in Office');assert.match(e['muse-qa-state'].textContent,/working/);
  assert.equal(e['published-report'].hidden,false);assert.equal(e['results-checks-label'].textContent,'Completed review');
  assert.notEqual(e['results-checks'].open,true);
  assert.equal(e['branch-brief'].hidden,true);
  e['branch-brief'].dataset.selecting='true';h.view.render(h.state);
  assert.equal(e['branch-brief'].hidden,false);
  h.view.render(h.state);assert.equal(e['branch-brief'].hidden,false);
  e['published-expected'].value='Centered';e['published-actual'].value='Off center';e['published-problem-item'].value='intake';
  await e['published-problem-form'].onsubmit({preventDefault(){}});
  assert.equal(h.calls.find(call=>call.path==='/api/issue').data.side,'published');
});

test('unsaved outcome updates badge immediately and requires a reason',async t=>{
  const h=harness(t),e=h.elements;
  for(let i=0;i<4;i++)h.state.record.checks[`intake:${i}`]=true;
  h.view.render(h.state);assert.equal(e['item-status'].textContent,'Passed');
  e['item-outcome'].value='needs-fixes';e['item-outcome'].onchange();
  assert.equal(e['item-status'].textContent,'Needs fixes · unsaved');
  assert.equal(await h.view.flush(),false);assert.match(e['item-save'].textContent,/reason/);
});

test('completed review shows one clear approval action and hides branch setup',t=>{
  const h=harness(t),e=h.elements,r=h.state.record;
  r.cursor={itemId:r.manifest.scenarios[0].id,view:'results'};
  r.integration={sha:r.identity.changed,main:r.identity.base};
  for(const item of r.manifest.scenarios)item.steps.forEach((_,i)=>r.checks[`${item.id}:${i}`]=true);
  h.view.render(h.state);
  assert.equal(e['branch-brief'].hidden,true);
  assert.equal(e['results-title'].textContent,r.manifest.title);
  assert.match(e['results-counts'].textContent,/of .* review items passed/);
  assert.equal(e['results-action'].textContent,'Approve changes');
  assert.equal(e['results-message'].textContent,'Reviewed against the remote default branch. Ready to approve.');
  assert.equal(e['results-checks-label'].textContent,'Review details');
});

test('primary approve saves once then exposes merge and publish without another approval button',async t=>{
  let h,release;
  h=harness(t,{api:async(path,data)=>{if(path==='/api/approve'){await new Promise(resolve=>release=resolve);h.state.record.approval={reviewer:data.reviewer,commit:h.state.record.identity.changed};}}});
  const r=h.state.record,e=h.elements;h.state.releaseConfigured=true;r.integration={sha:r.identity.changed,main:r.identity.base};
  for(const item of r.manifest.scenarios)item.steps.forEach((_,i)=>r.checks[`${item.id}:${i}`]=true);
  h.view.render(h.state);e.reviewer.value=' Josh ';
  assert.equal(e['approval-section'].hidden,false);
  const first=e['approve'].onclick();await new Promise(resolve=>setImmediate(resolve));
  await e['approve'].onclick();assert.equal(e['results-action'].disabled,true);
  release();await first;
  assert.equal(h.calls.filter(c=>c.path==='/api/approve').length,1);
  assert.equal(r.approval.reviewer,'Josh');assert.equal(e['approval-section'].hidden,true);
  assert.equal(e['results-action'].textContent,'Merge and publish');
  assert.equal(h.calls.some(c=>c.path==='/api/ship'||c.path==='/api/publish'),false);
});

test('failed approval keeps the reviewer and approval action available',async t=>{
  const h=harness(t,{api:async path=>{if(path==='/api/approve')throw Error('Main changed');}}),r=h.state.record,e=h.elements;
  r.integration={sha:r.identity.changed,main:r.identity.base};for(const item of r.manifest.scenarios)item.steps.forEach((_,i)=>r.checks[`${item.id}:${i}`]=true);
  h.view.render(h.state);e.reviewer.value='Josh';await e['approve'].onclick();
  assert.equal(e.reviewer.value,'Josh');assert.equal(e['results-action'].textContent,'Approve changes');assert.equal(e['results-action'].disabled,false);assert.equal(r.approval,undefined);
  assert.match(e.error.textContent,/Main changed/);
});

test('latest fix opens a retest panel and requires completed checks before explicit verification',async t=>{
 const h=harness(t),r=h.state.record,item=r.manifest.scenarios[0],e=h.elements;
 r.fixComparison={before:'aaaaaaa',after:'bbbbbbb'};r.cursor={itemId:item.id,view:'item'};
 r.issues=[{id:'latest',status:'needs-retest',expected:'Restore rust',actual:'Pink',side:'changed',commit:'aaaaaaa',scenario:item.id,consoleErrors:[]}];
 h.view.render(h.state);
 assert.equal(e['guided-item'].hidden,false);assert.equal(e['guided-results'].hidden,true);assert.equal(e['item-status'].textContent,'Ready to retest');assert.equal(e['latest-fix-expected'].textContent,'Restore rust');assert.equal(e['verify-fix'].disabled,true);
 await e['verify-fix'].onclick();assert.equal(h.calls.filter(c=>c.path==='/api/resolve').length,0);
 item.steps.forEach((_,i)=>r.checks[`${item.id}:${i}`]=true);h.view.render(h.state);assert.equal(e['verify-fix'].disabled,false);
 await e['verify-fix'].onclick();assert.equal(h.calls.filter(c=>c.path==='/api/resolve').length,1);assert.equal(h.calls.find(c=>c.path==='/api/resolve').data.issueId,'latest');
 assert.equal(e['prepare-handoff'].hidden,true);
});


test('a requested change without defect findings opens the full visible checklist',t=>{
 const h=harness(t),e=h.elements;
 h.state.record={...h.state.record,id:'new-change',fixComparison:{before:'aaaaaaa',after:'bbbbbbb'},issues:[]};
 h.view.render(h.state);
 assert.equal(e['item-filter'].value,'all');assert.equal(e['fix-mode-note'].hidden,true);
 assert.equal(e['item-queue'].children.length,h.state.record.manifest.scenarios.length);
});

test('an unrelated old finding does not filter the latest changed item out of the queue',t=>{
 const h=harness(t),e=h.elements,first=h.state.record.manifest.scenarios[0];
 const latest={...first,id:'latest-appearance',title:'Check the button'};
 h.state.record={...h.state.record,id:'latest',manifest:{...h.state.record.manifest,scenarios:[first,latest]},cursor:{itemId:latest.id,view:'item'},fixComparison:{before:'aaaaaaa',after:'bbbbbbb'},issues:[{id:'old',scenario:first.id,status:'needs-retest',expected:'Old heading check',commit:'aaaaaaa',side:'changed',consoleErrors:[]}]};
 h.view.render(h.state);
 assert.equal(e['item-filter'].value,'all');assert.equal(e['item-title'].textContent,'Check the button');assert.equal(e['item-queue'].children.length,2);
});
