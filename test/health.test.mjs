import test from 'node:test';
import assert from 'node:assert/strict';
import {previewHealth} from '../health.mjs';
test('health distinguishes exact ready builds, stopped services and stale revisions',async()=>{
  const snapshot={status:'ready',original:{api:1,web:2,sha:'a'},changed:{api:3,web:4,sha:'b'}};
  let fail=false,dirty=false;
  const fetcher=async url=>{if(fail && url.includes(':3/'))throw Error('Connection refused');return{ok:true,json:async()=>({revision:url.includes(':2/')?'a':'b',dirty})};};
  const ready=await previewHealth(snapshot,fetcher);assert.equal(ready.sides.original.ok,true);assert.equal(ready.sides.changed.ok,true);
  fail=true;const stopped=await previewHealth(snapshot,fetcher);assert.equal(stopped.sides.original.ok,true);assert.match(stopped.sides.changed.message,/refused/);
  fail=false;dirty=true;assert.equal((await previewHealth(snapshot,fetcher)).sides.original.ok,false);
  assert.equal((await previewHealth({...snapshot,status:'idle'},()=>{throw Error('Should not fetch');})).sides.original.ok,false);
});
