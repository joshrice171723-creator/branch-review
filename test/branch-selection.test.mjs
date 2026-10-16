import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshedSelection} from '../public/shortcuts.js';

test('refresh keeps the completed review selected instead of silently selecting unrelated work',()=>{
  const pending={ref:'refs/heads/fixes',sha:'old',merged:false,aliases:[]};
  const published={ref:'refs/heads/demo',sha:'reviewed',merged:true,aliases:['refs/remotes/origin/demo']};
  const branches=[pending,published];
  assert.equal(refreshedSelection(branches,{...published,merged:false},published.ref,false),published);
  assert.equal(refreshedSelection(branches,null,published.aliases[0],false),published);
  assert.equal(refreshedSelection(branches,pending,published.ref,false),pending);
  assert.equal(refreshedSelection(branches,null,null,false),pending);
  assert.equal(refreshedSelection([published],null,null,false),undefined);
  assert.equal(refreshedSelection([published],null,null,true),published);
  assert.equal(refreshedSelection([pending],published,published.ref,false),pending);
});

test('switching branches never displays another branch preview or published status',async()=>{
  const {selectedReviewState}=await import('../public/shortcuts.js');
  const old={status:'ready',busy:false,record:{identity:{ref:'old',source:'aaa'},delivery:{stage:'published'}},original:{sha:'base'},changed:{sha:'aaa'},manifest:{},comparison:{}};
  const choice={ref:'new',sha:'bbb',name:'New branch',starting:true};
  const loading=selectedReviewState(old,choice);
  assert.equal(loading.record,null);assert.equal(loading.original,null);assert.equal(loading.changed,null);assert.equal(loading.status,'preparing');
  const failure=selectedReviewState({...old,error:'Merge conflict'},{...choice,starting:false});
  assert.equal(failure.record,null);assert.equal(failure.status,'error');assert.equal(failure.error,'Merge conflict');
  const ready={...old,record:{identity:{ref:'new',source:'bbb'}},changed:{sha:'candidate'}};
  assert.equal(selectedReviewState(ready,{...choice,starting:false}),ready);
  assert.equal(selectedReviewState({...ready,busy:true},{...choice,starting:false}).record,null);
  assert.equal(selectedReviewState({...ready,record:{identity:{ref:'new',source:'older'}}},{...choice,starting:false}).record,null);
});
