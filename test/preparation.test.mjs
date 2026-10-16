import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTogether} from '../plans.mjs';

test('checklist and previews start together, and both finish before review opens',async()=>{
  let previewStarted=false,planStarted=false,finishPreview,finishPlan,done=false;
  const result=prepareTogether(()=>{previewStarted=true;return new Promise(r=>finishPreview=r);},()=>{planStarted=true;return new Promise(r=>finishPlan=r);}).then(value=>{done=true;return value;});
  assert.ok(previewStarted && planStarted);finishPlan('plan');await Promise.resolve();assert.equal(done,false);
  finishPreview();assert.equal(await result,'plan');
});
test('failed generation waits for preview preparation to settle before allowing another switch',async()=>{
  let finishPreview,done=false;
  const result=prepareTogether(()=>new Promise(r=>finishPreview=r),async()=>{throw Error('generation failed');}).catch(e=>{done=true;return e.message;});
  await Promise.resolve();assert.equal(done,false);finishPreview();assert.equal(await result,'generation failed');
});
