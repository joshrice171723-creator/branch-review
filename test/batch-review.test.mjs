import test from 'node:test';
import assert from 'node:assert/strict';
import {batchReview} from '../public/batch-review.js';
class Element{
 constructor(){this.children=[];this.value='';this.hidden=false;}
 append(...children){this.children.push(...children);}
 before(){} after(){} setAttribute(){} replaceChildren(...children){this.children=children;}
}
test('queued items continue without accepting them; only the final explicit action sends the batch',async t=>{
 const created=[],elements=new Proxy({},{get:(obj,id)=>created.find(e=>e.id===id) || (obj[id] ||=new Element())});
 globalThis.document={getElementById:id=>elements[id],createElement:()=>{const e=new Element();created.push(e);return e;},body:new Element()};t.after(()=>delete globalThis.document);
 const record={id:'one',identity:{changed:'sha',base:'base',ref:'refs/heads/demo'},manifest:{scenarios:[{id:'a',title:'Button',path:'/one',steps:['Works']},{id:'b',title:'Title',path:'/two',steps:['Works']}]},cursor:{view:'item',itemId:'a'},issues:[{id:'first',scenario:'a',status:'open',actual:'Blue button',expected:'Blue',screenshot:'first.png',target:{selector:'#cta',label:'Button'}}],items:{},checks:{}};
 const state={status:'ready',record},calls=[];
 const batch=batchReview({getState:()=>state,api:async(path,data)=>calls.push({path,data}),workflow:{flush:async()=>true,navigate:async(itemId,view='item')=>{record.cursor={itemId,view};}},poll:async()=>{},error:message=>assert.fail(message)});
 batch.render(state);assert.equal(elements['item-next'].textContent,'Continue');assert.equal(elements['item-next'].disabled,false);
 await elements['item-next'].onclick();assert.equal(record.cursor.itemId,'b');assert.equal(calls.length,0);
 record.cursor.view='results';batch.render(state);assert.equal(elements['batch-send'].disabled,true);await elements['batch-send'].onclick();assert.equal(calls.length,0);
 record.issues.push({id:'second',scenario:'b',status:'open',actual:'Larger title',expected:'Larger',screenshot:'second.png'});
 batch.render(state);assert.equal(elements['batch-send'].disabled,false);assert.equal(elements['batch-send'].textContent,'Apply 2 queued changes');
 await elements['batch-send'].onclick();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/job');assert.equal(calls[0].data.batch,true);
 for(const text of ['Blue button','Larger title','first.png','second.png','#cta'])assert.ok(calls[0].data.requestText.includes(text));
});
