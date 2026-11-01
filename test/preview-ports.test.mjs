import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverPreviewPorts} from '../preview-ports.mjs';

test('missing ownership reallocates all service ports without stopping the foreign listener',async()=>{
  const slot={api:3411,web:3410,postgres:54541,proxy:4311};let next=40000;
  const recovered=await recoverPreviewPorts(process.cwd(),slot,{probe:async port=>port===3411?null:port || next++,read:async()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});}});
  assert.equal(recovered,true);assert.deepEqual(slot,{api:40000,web:40001,postgres:40002,proxy:4311});
});
test('owned listeners retain their service ports',async()=>{
  const slot={api:3411,web:3410,postgres:54541};
  assert.equal(await recoverPreviewPorts(process.cwd(),slot,{probe:async()=>null,read:async filename=>JSON.stringify({pid:process.pid,role:filename.endsWith('api.pid')?'api':'web',root:process.cwd()})}),false);
  assert.equal(slot.api,3411);
});
