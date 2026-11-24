import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCoordinator} from '../workbench/coordinator.mjs';
import {createStore} from '../workbench/store.mjs';
import {gitRead} from '../workbench/environment/paths.mjs';

test('Coordinator diagnoses an unfamiliar preview failure using its failed approach and Sol high', async t => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'branch-review-preview-diagnosis-'));
  t.after(() => rm(repository, {recursive: true, force: true, maxRetries: 3}));
  await gitRead(repository, 'init', '-b', 'main');
  await writeFile(path.join(repository, '.gitignore'), '.harness/\n');
  await gitRead(repository, 'add', '.');
  await gitRead(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture');
  const store = createStore(repository);
  let calls = 0;
  const toolCalls = [];
  const coordinator = await createCoordinator({repository, store, git: (...args) => gitRead(repository, ...args),
    stageToolCall: async (name, values) => {
      toolCalls.push({name, values});
      return {started: true};
    },
    invoke: async request => {
      calls++;
      assert.equal(request.model, 'gpt-6.2-sol');
      assert.equal(request.effort, 'high');
      assert.equal(request.write, true);
      assert.equal(request.fullAccess, true);
      assert.equal(request.shellTools, true);
      assert.equal(request.timeoutMs, null);
      assert.match(request.prompt, /foxtrot spooler/);
      assert.match(request.prompt, /declared setup failed twice/);
      for (let index = 0; index < 10; index++) {
        const result = await fetch(request.stageMcp.url, {method: 'POST', body: JSON.stringify({
          jsonrpc: '2.0', id: index, method: 'tools/call',
          params: {name: 'start_project_preview', arguments: {id: 'fixture'}}
        })}).then(response => response.json());
        assert.equal(result.result.structuredContent.started, true);
      }
      request.onUsage({input: 90, output: 20, cached: 10});
      return {text: JSON.stringify({action: 'report', summary: 'The preview needs its local spooler.',
        nextAction: 'Ask Coordinator to configure the local spooler for this project.'})};
    }});
  t.after(() => coordinator.close());
  const result = await coordinator.diagnosePreview({incident: {error: 'foxtrot spooler could not open its queue'},
    history: [{detail: 'declared setup failed twice'}], evidence: {lastRecovery: {passed: false}},
    signal: new AbortController().signal});
  assert.equal(result.action, 'report');
  assert.match(result.nextAction, /local spooler/);
  assert.equal(calls, 1);
  assert.equal(toolCalls.length, 10);
});
