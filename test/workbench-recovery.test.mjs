import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createCoordinator} from '../workbench/coordinator.mjs';
import {annotateProviderFailure} from '../workbench/coordinator/provider-limit.mjs';
import {createStore} from '../workbench/store.mjs';

test('reads a provider reset without inventing a deadline', () => {
  const request = {provider: 'Codex', model: 'test-model', stage: 'plan_review'};
  const resetAt = '2026-11-22T12:00:03.000Z';
  const limited = annotateProviderFailure(Object.assign(Error('Request failed'), {status: 429, resetAt: Date.parse(resetAt)}), request);
  assert.deepEqual(limited.providerLimit, {...request, resetAt});
  assert.deepEqual(annotateProviderFailure(Error('Usage limit reached'), request).providerLimit, {...request, resetAt: null});
  assert.equal(annotateProviderFailure(Error('API error 402: Billing Issue'), request).providerLimit, undefined);
});

test('restores a quota retry after restart and keeps the task and stage', {timeout: 90000}, async t => {
  const repository = await mkdtemp(path.join(tmpdir(), 'branch-review-recovery-'));
  const git = async (...args) => execFileSync('git', args, {cwd: repository, encoding: 'utf8', windowsHide: true}).trim();
  let coordinator;
  t.after(async () => {
    await coordinator?.close();
    await rm(repository, {recursive: true, force: true});
  });
  await git('init', '-q', '-b', 'change');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Recovery test');
  await writeFile(path.join(repository, '.gitignore'), '.harness/\n');
  await writeFile(path.join(repository, 'greeting.txt'), 'Before');
  await git('add', '.');
  await git('commit', '-qm', 'Baseline');
  const store = createStore(repository);
  await store.setConfig({...await store.config(), checks: [{name: 'greeting', argv: ['node', '-e', 'process.exit(0)'],
    cwd: '.', phases: ['baseline', 'after'], required: true, benchmark: false}]});
  await store.setProfile(await store.getProfile());

  let resetAt;
  const calls = [];
  const args = {repository, store, git, async invoke({stage, provider, model}) {
    calls.push({stage, provider, model});
    if (stage === 'plan') return {text: JSON.stringify({plan: ['Edit the greeting.']})};
    assert.equal(stage, 'plan_review');
    resetAt ??= new Date(Date.now() + 10000).toISOString();
    throw Error('API error 429: Subscription quota exhausted. It resets at ' + resetAt);
  }};
  const post = (endpoint, data) => coordinator.dispatch(endpoint, data, {method: 'POST'});
  const current = async () => (await coordinator.dispatch('design')).builds.at(-1);
  async function waitForAttempt(count) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const build = await current();
      if (build?.status === 'failed' && build.attempts.length === count && !coordinator.busy()) return build;
      await delay(100);
    }
    assert.fail('The requested attempt did not finish. ' + JSON.stringify(await current()));
  }

  coordinator = await createCoordinator(args);
  const draft = await post('design/draft', {revision: 0, mode: 'task', title: 'Update greeting',
    plan: 'Edit the greeting.\n\n## Acceptance criteria\n- The greeting is updated.'});
  await post('design/approve', {revision: draft.revision, mode: 'task'});
  await post('design/build', {revision: draft.revision, mode: 'task', decisions: {scope_confirmed: 'confirmed',
    code_changes: 'allow_scoped', migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  const before = await waitForAttempt(1);
  const first = before.attempts[0];
  assert.equal(first.providerLimit?.resetAt, resetAt, before.error);
  assert.equal(first.step, 'plan_review');
  assert.match((await coordinator.dispatch('design')).resumeBlocker, /resume when the quota resets/);
  assert.equal(coordinator.busy(), false);
  await coordinator.close();

  coordinator = await createCoordinator(args);
  const saved = await coordinator.dispatch('job', {id: first.job});
  assert.equal(saved.error, before.error);
  const after = await waitForAttempt(2);
  assert.equal(after.id, before.id);
  assert.equal(after.attempts[1].task, first.task);
  assert.equal(after.attempts[1].step, first.step);
  assert.deepEqual(calls.map(call => call.stage), ['plan', 'plan_review', 'plan_review']);
  assert.deepEqual(calls.at(-1), calls.at(-2));
  assert.equal((await store.listRuns()).runs.length, 1);
  await delay(250);
  assert.equal((await current()).attempts.length, 2);
});
