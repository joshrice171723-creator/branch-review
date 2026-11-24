import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectView} from '../project-view.mjs';

test('Project view starts the recorded base and reuses it for the review', async () => {
  let target = {sha:'a'.repeat(40)}, review = {status:'idle'}, acquired = false, workspaceStops = 0, starts = 0;
  let releaseStart;
  const gate = new Promise(resolve => { releaseStart = resolve; });
  const slots = {original:{proxy:4311}};
  const view = createProjectView({getTarget:async()=>target, getReview:()=>review, slots,
    acquire:()=>{assert.equal(acquired,false); acquired=true;}, release:()=>{acquired=false;},
    stopWorkspace:async()=>{workspaceStops++;}, stopPreview:async()=>{},
    healthy:async()=>true,
    prepare:async (side, sha)=>{starts++; await gate; return {side,sha,runtime:side};}});
  assert.equal((await view.start()).state, 'starting');
  assert.equal((await view.start()).state, 'starting');
  assert.equal(starts, 1);
  releaseStart();
  while (acquired) await new Promise(resolve => setImmediate(resolve));
  const result = await view.status();
  assert.equal(result.state, 'running');
  assert.equal(result.revision, target.sha);
  assert.equal(result.url, 'http://127.0.0.1:4311/');
  assert.equal(workspaceStops, 1);
  review = {status:'ready',original:view.preview('original')};
  const shared = await view.start();
  assert.equal(shared.state, 'running');
  assert.equal(shared.shared, true);
  assert.equal(starts, 1);
  target = {sha:'b'.repeat(40)};
  assert.equal((await view.status()).state, 'stopped');
  assert.match((await view.start()).message, /Close the current review/);
});

test('stopping Project view aborts startup and releases the operation', async () => {
  let started, acquired = false;
  const ready = new Promise(resolve => { started = resolve; });
  const view = createProjectView({getTarget:async()=>({sha:'a'.repeat(40)}),getReview:()=>({status:'idle'}),
    slots:{original:{proxy:4311}}, acquire:()=>{acquired=true;}, release:()=>{acquired=false;},
    stopWorkspace:async()=>{}, stopPreview:async()=>{}, healthy:async()=>false,
    prepare:async (_side,_sha,_files,signal)=>{
      started();
      await new Promise((resolve,reject)=>{
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      });
    }});
  await view.start();
  await ready;
  assert.equal((await view.stop()).state, 'stopped');
  assert.equal(acquired,false);
});

test('stopping a previous base still releases its preview after the target changes', async () => {
  let target = {sha:'a'.repeat(40)}, stopped;
  const view = createProjectView({getTarget:async()=>target, getReview:()=>({status:'idle'}),
    slots:{original:{proxy:4311}}, acquire:()=>{}, release:()=>{}, stopWorkspace:async()=>{},
    stopPreview:async side=>{stopped=side;}, healthy:async()=>true,
    prepare:async (side,sha)=>({side,sha,runtime:side})});
  await view.start();
  while ((await view.status()).state === 'starting') await new Promise(resolve=>setImmediate(resolve));
  target = {sha:'b'.repeat(40)};
  assert.equal((await view.status()).state, 'stopped');
  await view.stop();
  assert.equal(stopped, 'original');
});
