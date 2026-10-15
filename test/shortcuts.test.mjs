import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewShortcut} from '../public/shortcuts.js';
test('review shortcuts ignore typing, repeated keys and other modifiers',()=>{
  const event={altKey:true,key:'ArrowRight',target:{closest:()=>null}};
  assert.equal(reviewShortcut(event),'next');
  assert.equal(reviewShortcut({...event,key:'ArrowLeft'}),'previous');
  assert.equal(reviewShortcut({...event,key:'v'}),'toggle');
  for(const property of ['ctrlKey','metaKey','shiftKey','repeat','isComposing','defaultPrevented'])assert.equal(reviewShortcut({...event,[property]:true}),null);
  assert.equal(reviewShortcut({...event,target:{closest:()=>({})}}),null);
  assert.equal(reviewShortcut({...event,altKey:false}),null);
});
