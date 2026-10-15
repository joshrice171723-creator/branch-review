import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from '../public/workflow.js';
import { findingKey, loadDraft, saveDraft } from '../public/drafts.js';
import { defaultManifest } from '../reviews.mjs';

function harness(t, options = {}) {
  class Element {
    value = ''; children = []; hidden = false; disabled = false;
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

test('retest drafts recover after remount and failed item saves block approval',async t=>{
  const h=harness(t,{api:async(path)=>{if(path==='/api/item')throw Error('Disk unavailable');}}),e=h.elements;
  h.state.record.issues=[{id:'issue',status:'open',expected:'a',actual:'b',side:'changed',commit:'bbbbbbb',scenario:'intake',consoleErrors:[]}];h.view.render(h.state);
  let note=e.findings.children[0].children.find(n=>n.placeholder==='Describe the retest result');note.value='Recovered retest';note.oninput();
  const reloaded=workflow({api:async()=>[],getState:()=>h.state,getSide:()=> 'changed',error:()=>{},poll:async()=>{},reopen:()=>{}});reloaded.render(h.state);
  note=e.findings.children[0].children.find(n=>n.placeholder==='Describe the retest result');assert.equal(note.value,'Recovered retest');
  h.view.render(h.state);
  // Recreate the original event handlers before testing a failed save.
  const failing=workflow({api:async(path)=>{h.calls.push({path});if(path==='/api/item')throw Error('Disk unavailable');return [];},getState:()=>h.state,getSide:()=> 'changed',error:()=>{},poll:async()=>{},reopen:()=>{}});failing.render(h.state);
  e['item-notes'].value='Unsaved approval context';e['item-notes'].oninput();await e.approve.onclick();
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
