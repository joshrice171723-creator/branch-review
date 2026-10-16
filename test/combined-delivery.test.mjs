import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeAndPublish} from '../public/workflow.js';
const state={record:{id:'review',identity:{changed:'abc'}},publishTarget:'https://aimetaclinic.com'};
test('combined delivery waits for confirmed push, then publishes the same reviewed commit',async()=>{
 const calls=[];let polls=0;
 await mergeAndPublish(async(path,data)=>{calls.push({path,data});if(path==='/api/state')return {...state,busy:polls++===0,record:{...state.record,delivery:{stage:'pushed'}}};},state,async()=>{});
 assert.deepEqual(calls.map(c=>c.path),['/api/ship','/api/state','/api/state','/api/publish']);
 assert.equal(calls.at(-1).data.confirmation,'PUBLISH abc TO https://aimetaclinic.com');
});
test('failed, unconfirmed or changed push never publishes',async()=>{
 for(const next of [{...state,error:'Push failed',busy:false},{...state,busy:false},{...state,busy:false,record:{...state.record,id:'other'}}]){
  const calls=[];await assert.rejects(mergeAndPublish(async path=>{calls.push(path);return next;},state,async()=>{}));assert.ok(!calls.includes('/api/publish'));
 }
});
test('resume after pushed does not push twice; publish failures remain failures',async()=>{
 const calls=[];await assert.rejects(mergeAndPublish(async path=>{calls.push(path);throw Error('Release failed');},{...state,record:{...state.record,delivery:{stage:'pushed'}}}),/Release failed/);
 assert.deepEqual(calls,['/api/publish']);
});
