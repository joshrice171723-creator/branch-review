import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewShortcut,selectedReviewState} from '../public/shortcuts.js';
test('review shortcuts ignore typing, repeated keys and other modifiers',()=>{
  const event={altKey:true,key:'ArrowRight',target:{closest:()=>null}};
  assert.equal(reviewShortcut(event),'next');
  assert.equal(reviewShortcut({...event,key:'ArrowLeft'}),'previous');
  assert.equal(reviewShortcut({...event,key:'v'}),'toggle');
  for(const property of ['ctrlKey','metaKey','shiftKey','repeat','isComposing','defaultPrevented'])assert.equal(reviewShortcut({...event,[property]:true}),null);
  assert.equal(reviewShortcut({...event,target:{closest:()=>({})}}),null);
  assert.equal(reviewShortcut({...event,altKey:false}),null);
});

test('ready previews appear during checklist generation only for the selected branch version',()=>{
  const selection={ref:'refs/heads/fix',sha:'new',name:'Fix'};
  const state={status:'preview-ready',busy:true,comparison:{branch:selection},original:{sha:'before'},changed:{sha:'after'},manifest:{scenarios:[{id:'pending',path:'/demo'}]},record:{id:'old',identity:{ref:'old',source:'old'}}};
  const visible=selectedReviewState(state,selection);
  assert.equal(visible.status,'preview-ready');assert.equal(visible.changed.sha,'after');assert.equal(visible.record,null);
  for(const other of [{...selection,sha:'older'},{...selection,ref:'refs/heads/other'}]){
    const hidden=selectedReviewState(state,other);assert.equal(hidden.changed,null);assert.equal(hidden.record,null);assert.equal(hidden.status,'preparing');
  }
});
