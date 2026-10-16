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
