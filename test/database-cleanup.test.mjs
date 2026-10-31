import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,access,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {databaseCleanup} from '../database-cleanup.mjs';

test('cleanup protects active previews and invalidates cache before dropping only selected databases',async()=>{
  const local=await mkdtemp(path.join(os.tmpdir(),'review-cleanup-'));
  const sha='a'.repeat(40),name=`apply_review_original_${sha.slice(0,12)}_development`,file=`preview-original-${sha}-${'b'.repeat(64)}.json`;
  const calls=[];let exists=true;
  const run=async(_cmd,args)=>{calls.push(args);if(args[0]==='info')return 'engine';if(args[0]==='ps')return 'apply-review-original';if(args.includes('DROP DATABASE'))throw Error('unexpected argument');if(args.includes('-c') && args.at(-1).startsWith('DROP')){await assert.rejects(access(path.join(local,file)));exists=false;return '';}if(args.includes('-c'))return exists?`${name}|1048576|0`:'';throw Error('unexpected command');};
  try{
    await writeFile(path.join(local,file),JSON.stringify({database:name,runtime:'original',sha}));
    const state={original:{database:name}},cleanup=databaseCleanup({run,local,state,records:[],preparedFix:()=>null,jobs:()=>[]});
    assert.match((await cleanup.inventory()).databases[0].reason,/Active/);
    await assert.rejects(cleanup.remove([name],'DELETE 1'),/protected/);
    state.original=null;state.prepared={database:name};await assert.rejects(cleanup.remove([name],'DELETE 1'),/protected/);
    state.prepared=null;assert.deepEqual((await cleanup.remove([name],'DELETE 1')).deleted,[name]);
    assert.equal((await cleanup.inventory()).databases.length,0);
    assert.equal(calls.filter(args=>args.at(-1)?.startsWith('DROP DATABASE')).length,1);
    await assert.rejects(cleanup.remove(['postgres'],'DELETE 1'),/valid/);
  }finally{await rm(local,{recursive:true,force:true});}
});
