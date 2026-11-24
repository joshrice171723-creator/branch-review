import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {isolateComposeImages} from '../compose-preview.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'br-compose-images-'));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  const calls = [];
  const config = {services:{app:{image:'shared:local',build:{context:cwd}},worker:{image:'shared:local',build:{context:cwd}},
    job:{image:'shared:local'},
    redis:{image:'redis:7-alpine'}}};
  const run = async (_file, args, options) => {
    calls.push({args,options});
    options.signal?.throwIfAborted();
    return {stdout:args.includes('--environment') ? 'COMPOSE_FILE=custom.yml\nPRIVATE_SECRET=do-not-save\n' : JSON.stringify(config)};
  };
  return {cwd, calls, run};
}

test('runtime images preserve shared build groups and external images without writing resolved secrets', async t => {
  const {cwd,run,calls} = await fixture(t);
  const command = {file:'docker',args:['compose','--project-name','one','--file','base.yaml','--file','local.yaml','up','--build']};
  const first = await isolateComposeImages({command,cwd,directory:path.join(cwd,'one'),run});
  const second = await isolateComposeImages({command,cwd,directory:path.join(cwd,'two'),run});
  const one = JSON.parse(await readFile(first.override,'utf8'));
  const two = JSON.parse(await readFile(second.override,'utf8'));
  assert.equal(one.services.app.image,one.services.worker.image);
  assert.equal(one.services.app.image,one.services.job.image);
  assert.notEqual(one.services.app.image,two.services.app.image);
  assert.equal(one.services.redis,undefined);
  assert.deepEqual(Object.keys(one),['services']);
  assert.deepEqual(first.command.args,['compose','--project-name','one','--file','base.yaml','--file','local.yaml','--file',first.override,'up','--build']);
  assert.equal(calls.length,2);
});

test('compact and equals file options retain their original Compose inputs', async t => {
  const {cwd,run} = await fixture(t);
  for (const args of [['-fbase.yaml'],['-f=base.yaml'],['--file=base.yaml'],['-f','base.yaml']]) {
    const command={file:'docker',args:['compose',...args,'up']};
    const result=await isolateComposeImages({command,cwd,directory:path.join(cwd,'owned'),run});
    assert.deepEqual(result.sourceFiles,['base.yaml']);
    assert.deepEqual(result.command.args,['compose',...args,'--file',result.override,'up']);
  }
});

test('Compose-selected env files remain base files when the image override is added', async t => {
  const {cwd,run,calls} = await fixture(t);
  const command={file:'docker',args:['compose','--env-file','preview.env','up']};
  const result=await isolateComposeImages({command,cwd,directory:path.join(cwd,'owned'),env:{},run});
  assert.deepEqual(result.command.args,['compose','--env-file','preview.env','--file','custom.yml','--file',result.override,'up']);
  assert.equal(calls[1].args.at(-1),'--environment');
  assert.doesNotMatch(await readFile(result.override,'utf8'),/PRIVATE_SECRET|do-not-save/);
});

test('default discovery retains its override and cancellation stops config inspection', async t => {
  const {cwd,run} = await fixture(t);
  await writeFile(path.join(cwd,'compose.yaml'),'services: {}');
  await writeFile(path.join(cwd,'compose.override.yaml'),'services: {}');
  const command={file:'docker',args:['compose','up']};
  const inspect=async (file,args,options)=>args.includes('--environment') ? {stdout:''} : run(file,args,options);
  const result=await isolateComposeImages({command,cwd,directory:path.join(cwd,'owned'),env:{},run:inspect});
  assert.deepEqual(result.sourceFiles,[path.join(cwd,'compose.yaml'),path.join(cwd,'compose.override.yaml')]);
  const controller=new AbortController();controller.abort(Error('cancelled'));
  await assert.rejects(isolateComposeImages({command,cwd,directory:path.join(cwd,'stopped'),signal:controller.signal,run}),/cancelled/);
});
