import test from 'node:test';
import assert from 'node:assert/strict';
import {MuseQa,publishAssignment} from '../muse-qa.mjs';
function fixture(){
  const record={id:'review',identity:{changed:'a'.repeat(40)},delivery:{stage:'published'},manifest:{scenarios:[{id:'button',title:'Button',path:'/',instructions:'Click button',expected:'Sandbox opens',steps:['Open']}]}},calls=[];
  const store={persist:async()=>{},event:async(_r,type)=>calls.push(type)};
  let lost=false,moved=false,posts=0;
  const muse=new MuseQa('unused',store,{fetcher:async()=>({ok:true,json:async()=>({revision:moved?'b'.repeat(40):record.identity.changed})}),transport:async(action,task)=>{
    if(action==='preflight')return{ready:true};posts++;if(lost)throw Error('Connection lost after submission');return{id:42,revision:task.revision,request_key:task.request_key,status:'queued'};
  }});
  return{record,muse,calls,get posts(){return posts;},loseResponse(){lost=true;},restore(){lost=false;},move(){moved=true;}};
}
test('publish assignment uses actual Office schema and stable release key',()=>{
  const {record}=fixture(),task=publishAssignment(record);
  assert.deepEqual(Object.keys(task.payload),['description']);assert.equal(task.assigned_actor,'muse');
  assert.equal(task.request_key,publishAssignment(record).request_key);assert.match(task.payload.description,/Sandbox opens/);
  record.manifest.scenarios[0].instructions='x'.repeat(4001);assert.throws(()=>publishAssignment(record),/4,000/);
});
test('handoff persists receipt and duplicate dispatch does not queue another run',async()=>{
  const f=fixture();await f.muse.preflight(f.record);await f.muse.dispatch(f.record);await f.muse.dispatch(f.record);
  assert.equal(f.posts,1);assert.equal(f.record.museQa.taskId,42);assert.equal(f.record.museQa.status,'queued');assert.equal(f.record.delivery.stage,'published');
});
test('lost response retries identical stored payload and leaves publication intact',async()=>{
  const f=fixture();f.loseResponse();await f.muse.dispatch(f.record);const original=JSON.stringify(f.record.museQa.task);
  assert.equal(f.record.delivery.stage,'published');assert.equal(f.record.museQa.status,'handoff-failed');
  f.record.manifest.scenarios[0].expected='Edited later';f.restore();await f.muse.refresh(f.record);
  assert.equal(JSON.stringify(f.record.museQa.task),original);assert.equal(f.record.museQa.taskId,42);assert.equal(f.posts,2);
});
test('wrong live build, unpublished record and mismatched receipt fail closed',async()=>{
  const f=fixture();f.move();await f.muse.dispatch(f.record);assert.equal(f.posts,0);assert.equal(f.record.museQa.status,'handoff-failed');
  f.record.delivery.stage='pushed';await assert.rejects(f.muse.dispatch(f.record),/Publish the exact/);
  const g=fixture();g.muse.transport=async()=>({id:99,revision:'b'.repeat(40),request_key:'wrong'});await g.muse.dispatch(g.record);assert.equal(g.record.museQa.taskId,undefined);
});
test('restart resumes pending handoff and Office receipts alone drive working state',async()=>{
  const f=fixture();f.muse.prepare(f.record);await f.muse.refresh(f.record);assert.equal(f.posts,1);
  f.muse.fetcher=async()=>({ok:true,json:async()=>({tasks:[{id:42,revision:f.record.identity.changed,request_key:f.record.museQa.task.request_key,status:'claimed',office_status:'working'}]})});
  await f.muse.refresh(f.record);assert.equal(f.record.museQa.status,'working');
});

test('browser completion requires evidence and stalled tasks stay actionable',async()=>{
  const f=fixture();await f.muse.dispatch(f.record);
  const task={id:42,revision:f.record.identity.changed,request_key:f.record.museQa.task.request_key,office_status:'completed',result:{evidence_refs:[]}};
  f.muse.fetcher=async()=>({ok:true,json:async()=>({tasks:[task]})});
  await f.muse.refresh(f.record);assert.equal(f.record.museQa.status,'evidence-missing');
  task.result.evidence_refs=[7];await f.muse.refresh(f.record);assert.equal(f.record.museQa.status,'completed');assert.equal(f.record.museQa.statusError,null);
  task.office_status='queued';f.record.museQa.queuedAt=new Date(Date.now()-180000).toISOString();
  await f.muse.refresh(f.record);assert.match(f.record.museQa.statusError,/not acknowledged/);assert.equal(f.posts,1);
  task.office_status='working';task.lease_expired=true;await f.muse.refresh(f.record);assert.equal(f.record.museQa.status,'lease-expired');
  assert.match(publishAssignment(f.record).payload.description,/REAL BROWSER/);
});
