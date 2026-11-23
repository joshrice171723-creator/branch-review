import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createCoordinator} from '../workbench/coordinator.mjs';
import {createEnvironment} from '../workbench/environment.mjs';
import {createStore} from '../workbench/store.mjs';

async function fixture(t, files, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'branch-review-setup-'));
  const repository = path.join(temp, 'project');
  await mkdir(repository);
  const git = async (...args) => {
    const options = typeof args.at(-1) === 'object' ? args.pop() : {};
    return execFileSync('git', args, {cwd: repository, encoding: 'utf8', windowsHide: true, ...options}).trim();
  };
  for (const [name, source] of Object.entries({'.gitignore': '.harness/\n', ...files})) {
    await writeFile(path.join(repository, name), source);
  }
  await git('init', '-q', '-b', 'working');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture');
  const store = createStore(repository);
  const environment = createEnvironment({repository, local: path.join(temp, 'data'), store});
  const coordinator = await createCoordinator({repository, store, git, prepareBuild: environment.prepareBuild,
    ...options, runtimeHealth: options.runtimeHealth && {...options.runtimeHealth, directory: path.join(temp, 'health')}});
  t.after(async () => {
    await coordinator.close();
    await environment.close();
    await rm(temp, {recursive: true, force: true, maxRetries: 3});
  });
  const send = data => coordinator.dispatch('design/guide', {revision: 0, mode: 'task',
    context: {view: 'workflow', tab: 'Plan'}, ...data}, {method: 'POST'});
  return {coordinator, store, send, git};
}

const plan = {kind: 'plan', title: 'Update greeting', plan: 'Update the greeting.\n\n## Acceptance criteria\n- Show the new greeting.'};

test('sending a saved proposal prepares its check and starts the detected preview', async t => {
  let calls = 0;
  const {send, store, coordinator, git} = await fixture(t, {
    'package.json': JSON.stringify({name: 'fixture', scripts: {test: 'node --test'}}),
    'server.cjs': [
      "const fs = require('node:fs');",
      "const marker = require('node:path').join(process.env.BRANCH_REVIEW_DATA, 'started');",
      "const first = !fs.existsSync(marker);",
      "fs.writeFileSync(marker, 'started');",
      "require('node:http').createServer((req, res) => { res.statusCode = first ? 500 : 200; res.end('Fixture'); }).listen(process.env.PORT, '127.0.0.1');"
    ].join('\n'),
    'workbench-capabilities.json': JSON.stringify({schema_version: 1,
      previews: [{label: 'Fixture', argv: ['node', 'server.cjs'], cwd: '.', url: 'http://127.0.0.1:{port}', mode: 'web'}]})
  }, {invoke: async () => {
    calls++;
    return {text: JSON.stringify({message: 'Drafted the plan.', proposal: plan})};
  }});
  const draft = (await send({message: 'Update the greeting.'})).messages.at(-1);
  assert.deepEqual((await store.effectiveConfig()).checks, []);
  const prepared = (await send({preparePlan: true, proposalId: draft.id})).messages.at(-1);
  assert.equal(calls, 1);
  assert.equal(prepared.projectPrepared, true);
  assert.match(prepared.text, /The managed preview responded after restart/);
  assert.deepEqual((await store.effectiveConfig()).checks[0].argv, ['npm', 'test']);
  const readiness = await coordinator.dispatch('design/readiness');
  assert.equal(readiness.items.find(item => item.id === 'checks').status, 'ready');
  assert.equal(await git('status', '--porcelain'), '');
});

test('a project without checks receives a required after-build smoke test in the plan', async t => {
  let interrupted = false, supervised = 0;
  const {send, store, coordinator, git} = await fixture(t, {'greeting.txt': 'Before'}, {
    superviseFailures: true,
    invoke: async ({stage, prompt, cwd}) => {
      if (prompt.startsWith('Supervise this stopped Branch Review build')) {
        supervised++;
        assert.match(prompt, /Temporary connection interruption/);
        return {text: JSON.stringify({action: 'retry', reason: 'The planning connection was interrupted.'})};
      }
      if (prompt.startsWith('You are the Branch Review Coordinator')) {
        return {text: JSON.stringify({message: 'Drafted the plan.', proposal: plan})};
      }
      if (stage === 'plan' && !interrupted) {
        interrupted = true;
        throw Error('Temporary connection interruption');
      }
      if (stage === 'plan') return {text: JSON.stringify({plan: ['Update the greeting and add a smoke test.']})};
      if (stage === 'plan_review') return {text: JSON.stringify({verdict: 'pass', reason: 'The plan covers both requirements.'})};
      if (stage === 'build') {
        await writeFile(path.join(cwd, 'greeting.txt'), 'After');
        await mkdir(path.join(cwd, 'test'));
        await writeFile(path.join(cwd, 'test/branch-review-smoke.cjs'),
          "require('node:test')('greeting', () => require('node:assert/strict').equal(require('node:fs').readFileSync('greeting.txt','utf8'), 'After'));");
        return {text: 'Updated the greeting and added the smoke test.'};
      }
      return {text: JSON.stringify({verdict: 'pass', reason: 'The greeting check passed.',
        criteria: ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints']
          .map(id => ({id, verdict: 'pass', evidence: ['The check and source confirm the change.'], reason: ''}))})};
    }
  });
  const prepared = (await send({message: 'Update the greeting.', preparePlan: true})).messages.at(-1);
  assert.match(prepared.proposal.plan, /Add .*branch-review-smoke/);
  const [check] = (await store.effectiveConfig()).checks;
  assert.equal(check.required, true);
  assert.deepEqual(check.phases, ['after']);
  assert.deepEqual(check.argv, ['node', '--test', 'test/branch-review-smoke.cjs']);
  assert.equal(await git('status', '--porcelain'), '');
  const post = (route, data) => coordinator.dispatch('design/' + route, data, {method: 'POST'});
  const {revision} = await post('draft', {...prepared.proposal, mode: 'task'});
  await post('approve', {revision, mode: 'task'});
  await post('build', {revision, mode: 'task', decisions: {scope_confirmed: 'confirmed', code_changes: 'allow_scoped',
    migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  let build;
  for (let attempt = 0; attempt < 400; attempt++) {
    build = (await coordinator.dispatch('design')).builds.at(-1);
    if (build.status === 'review' || build.attention) break;
    await delay(150);
  }
  assert.equal(build.status, 'review', build.error);
  assert.equal(supervised, 1);
  assert.equal(build.attempts.at(-1).automaticRecovery?.kind, 'supervisor');
  assert.equal(build.attempts[0].task, build.attempts.at(-1).task);
  const run = build.attempts.at(-1).task;
  const receipt = (await store.getRun(run)).checks.find(row => row.check === check.name && row.phase === 'after');
  assert.equal(receipt?.exit_code, 0);
  assert.equal(receipt.spawn_error, null);
  assert.match(receipt.check_inputs_sha256, /^[a-f0-9]{64}$/);
});

test('a Branch Review repair goes directly to App Health without preparing a project build', async t => {
  const {send, coordinator, store} = await fixture(t, {'greeting.txt': 'Before'}, {
    runtimeHealth: {start: false, observe: () => [], idle: () => true},
    invoke: async () => ({text: JSON.stringify({message: 'I will fix it.', proposal: {
      kind: 'app-repair', title: 'Settings window fails to open', issue: 'The Branch Review settings button does not open its window.'
    }})})
  });
  const reply = await send({message: 'Fix the settings button in Branch Review itself.'});
  assert.match(reply.messages.at(-1).text, /App Health is handling/);
  assert.equal(reply.messages.at(-1).proposal, undefined);
  assert.deepEqual(reply.builds, []);
  assert.equal(reply.revision, 0);
  assert.deepEqual((await store.effectiveConfig()).checks, []);
  const [issue] = (await coordinator.dispatch('coordinator/health')).incidents;
  assert.equal(issue.owner, 'host');
  assert.equal(issue.state, 'detected');
});
test('a direct recovery instruction resumes the stopped build without drafting a plan', async t => {
  let planCalls = 0;
  const {send, store, coordinator} = await fixture(t, {'greeting.txt': 'Before'}, {
    invoke: async ({stage}) => {
      assert.equal(stage, 'plan');
      if (++planCalls === 1) throw Error('Planning interrupted.');
      throw Error('Confirmed that the same planning stage resumed.');
    }
  });
  const profile = await store.getProfile();
  await store.setProfile({...profile, checks: [{name: 'fixture', argv: ['node', '-e', 'process.exit(0)'],
    required: true, benchmark: false, cwd: '.'}]});
  const post = (route, data) => coordinator.dispatch('design/' + route, data, {method: 'POST'});
  const {revision} = await post('draft', {...plan, revision: 0, mode: 'task'});
  await post('approve', {revision, mode: 'task'});
  const started = await post('build', {revision, mode: 'task', decisions: {scope_confirmed: 'confirmed',
    code_changes: 'allow_scoped', migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  for (let i = 0; i < 150; i++) {
    if ((await coordinator.dispatch('design')).builds.at(-1).status === 'failed') break;
    await delay(100);
  }
  const resumed = await send({revision, message: 'do it fix it'});
  assert.match(resumed.messages.at(-1).text, /Resumed the existing build/);
  assert.equal(resumed.builds.length, 1);
  assert.equal(resumed.builds[0].id, started.builds[0].id);
  assert.equal(resumed.builds[0].attempts.length, 2);
  assert.equal(resumed.builds[0].attempts[0].task, resumed.builds[0].attempts[1].task);
});
