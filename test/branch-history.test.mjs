import test from 'node:test';
import assert from 'node:assert/strict';
import {branchHistory} from '../public/branch-history.js';

class Element{
  constructor(tag){this.tag=tag;this.children=[];this.disabled=false;}
  append(...children){for(const child of children){child.parent?.children.splice(child.parent.children.indexOf(child),1);child.parent=this;this.children.push(child);}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  setAttribute(){}
  closest(){return this.parent;}
  querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.querySelectorAll(tag)]);}
  showModal(){this.open=true;}
  close(){this.open=false;}
  click(){this.clicked=true;}
}
function harness(t){
  const elements={history:new Element('select'),'toolbar-history':new Element('button'),changed:new Element('button')};
  const saved=new Element('details');saved.append(elements.history);
  const body=new Element('body');body.append(saved);
  globalThis.document={body,createElement:tag=>new Element(tag),getElementById:id=>elements[id]};
  globalThis.confirm=()=>true;t.after(()=>{delete globalThis.document;delete globalThis.confirm;});
  const state={record:{id:'review',identity:{ref:'refs/heads/demo'}},previewVersion:null};
  const history={tip:'latest',ref:'refs/heads/demo',versions:[{sha:'latest',subject:'New heading',date:'2026-11-01T12:00:00Z'},{sha:'older',subject:'Old heading'},{sha:'base',subject:'Starting point before this branch',startingPoint:true}]};
  const calls=[];let fail=false;
  branchHistory({getState:()=>state,api:async(endpoint,data)=>{calls.push({endpoint,data});if(fail)throw Error('Preview failed');return history;},flush:async()=>true,poll:async()=>{},error:()=>{}});
  const dialog=body.children.find(child=>child.tag==='dialog');
  return {elements,state,dialog,calls,fail:()=>{fail=true;},rows:()=>dialog.children.find(child=>child.className==='branch-version-list').children};
}

test('versions distinguish latest and current preview; viewing closes modal without restoring',async t=>{
  const h=harness(t);await h.elements['toolbar-history'].onclick();
  let rows=h.rows();assert.equal(rows.length,3);assert.equal(rows[0].querySelectorAll('button').length,1);
  assert.equal(rows[0].querySelectorAll('button')[0].textContent,'Viewing now');
  const preview=rows[1].querySelectorAll('button')[0];assert.equal(preview.textContent,'View this version');
  await preview.onclick();assert.equal(h.dialog.open,false);assert.equal(h.elements.changed.clicked,true);
  assert.deepEqual(h.calls.at(-1),{endpoint:'/api/version-preview',data:{id:'review',sha:'older'}});
  h.state.previewVersion={sha:'older'};await h.elements['toolbar-history'].onclick();rows=h.rows();
  assert.equal(rows[1].querySelectorAll('button')[0].disabled,true);
  await rows[0].querySelectorAll('button')[0].onclick();assert.equal(h.calls.at(-1).endpoint,'/api/version-latest');
});

test('failed preview stays open and can be retried; restore keeps explicit branch confirmation',async t=>{
  const h=harness(t);await h.elements['toolbar-history'].onclick();
  const [preview,restore]=h.rows()[1].querySelectorAll('button');h.fail();await preview.onclick();
  assert.equal(h.dialog.open,true);assert.equal(preview.disabled,false);
  let confirmed='';globalThis.confirm=message=>{confirmed=message;return false;};await restore.onclick();
  assert.match(confirmed,/all tracked files on demo/);assert.equal(h.calls.at(-1).endpoint,'/api/version-preview');
  globalThis.confirm=()=>true;await restore.onclick();assert.deepEqual(h.calls.at(-1),{endpoint:'/api/version-restore',data:{id:'review',sha:'older',expected:'latest',confirmation:'RESTORE older ON refs/heads/demo'}});
});
