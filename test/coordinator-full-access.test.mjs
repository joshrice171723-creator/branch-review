import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runProvider} from '../workbench/coordinator/provider.mjs';
import {recoverProjectPreview} from '../workbench/workspace.mjs';

test('Coordinator launches the CLI with full access and its configured tools', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'coordinator-access-'));
  t.after(() => rm(folder, {recursive:true, force:true, maxRetries:3}));
  const cli = path.join(folder, 'codex.cjs');
  const argsFile = path.join(folder, 'args.json');
  const output = path.join(folder, 'answer.txt');
  await writeFile(cli, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"ok":true}');
    console.log(JSON.stringify({type:'turn.completed'}));
  `);
  const options = {provider:'Codex', stage:'plan', cwd:folder, prompt:'Complete the fixture.', output,
    providerOptions:{codex:{executable:cli}}};
  await runProvider({...options, write:true, fullAccess:true});
  let args = JSON.parse(await readFile(argsFile, 'utf8'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(!args.includes('--ignore-user-config'));
  assert.ok(!args.includes('--ephemeral'));
  assert.ok(!args.includes('--disable'));
  assert.ok(args.includes('approval_policy="never"'));
  await runProvider({...options, write:false});
  args = JSON.parse(await readFile(argsFile, 'utf8'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('--ignore-user-config'));
});

test('preview recovery lets Coordinator act and verifies the same preview', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  let repaired = false;
  const environment = {
    recoverPreview: async () => { calls.push('initial recovery'); return {passed:false, detail:'Service is unavailable.'}; },
    verifyCurrentPreview: async () => { calls.push('verify'); return {passed:repaired, detail:'Page rendered.'}; },
    dispatch: async () => ({settings:{argv:['old']}}),
    capabilities: async () => ({previews:[]})
  };
  const coordinator = {diagnosePreview: async ({history}) => {
    calls.push('Coordinator repair');
    assert.equal(history.length, 1);
    repaired = true;
    return {action:'handled'};
  }};
  const result = await recoverProjectPreview({incident:{error:'Service unavailable'}, signal,
    history:[{outcome:'running'}], environment, coordinator});
  assert.equal(result.passed, true);
  assert.deepEqual(calls, ['initial recovery', 'Coordinator repair', 'verify']);
});

test('preview recovery does not ask the user to request another Coordinator repair', async () => {
  const environment = {
    recoverPreview: async () => ({passed:false, detail:'Setup failed.'}),
    dispatch: async () => ({settings:{argv:['old']}}),
    capabilities: async () => ({previews:[]})
  };
  const coordinator = {diagnosePreview: async () => ({action:'report', requiresUser:true,
    summary:'The setup still fails.', nextAction:'In Coordinator, request a project repair.'})};
  const result = await recoverProjectPreview({incident:{}, signal:new AbortController().signal,
    environment, coordinator});
  assert.equal(result.passed, false);
  assert.equal(result.nextAction, undefined);
});
