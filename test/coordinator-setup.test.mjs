import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createCoordinator} from '../workbench/coordinator.mjs';
import {createEnvironment} from '../workbench/environment.mjs';
import {createStore} from '../workbench/store.mjs';
import {discoverCapabilities} from '../workbench/environment/discovery.mjs';

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
  const {configureStore, ...coordinatorOptions} = options;
  configureStore?.(store);
  const environment = createEnvironment({repository, local: path.join(temp, 'data'), store});
  const coordinator = await createCoordinator({repository, store, git, prepareBuild: environment.prepareBuild,
    ...coordinatorOptions, runtimeHealth: options.runtimeHealth && {...options.runtimeHealth, directory: path.join(temp, 'health')}});
  t.after(async () => {
    await coordinator.close();
    await environment.close();
    await rm(temp, {recursive: true, force: true, maxRetries: 3});
  });
  const send = data => coordinator.dispatch('design/guide', {revision: 0, mode: 'task',
    context: {view: 'workflow', tab: 'Plan'}, ...data}, {method: 'POST'});
  return {coordinator, store, send, git, environment, repository};
}

const plan = {kind: 'plan', title: 'Update greeting', plan: 'Update the greeting.\n\n## Acceptance criteria\n- Show the new greeting.'};

test('preview setup without a build does not create a missing check or select build settings', async t => {
  let selections = 0;
  const {send, store, environment} = await fixture(t, {
    'server.cjs': "require('node:http').createServer((_, res) => res.end('Ready')).listen(process.env.PORT, '127.0.0.1');",
    'workbench-capabilities.json': JSON.stringify({schema_version:1,
      previews:[{label:'Fixture', argv:['node','server.cjs'], cwd:'.', url:'http://127.0.0.1:{port}', mode:'web'}]})
  }, {invoke: async ({prompt}) => {
    if (prompt.startsWith('Choose execution settings')) { selections++; return {text:'{"stages":{}}'}; }
    return {text:JSON.stringify({message:'Setting up the preview.', proposal:{kind:'project-setup', title:'Set up preview'}})};
  }});
  const reply = (await send({message:'Set up the live preview.'})).messages.at(-1);
  assert.equal(selections, 0);
  assert.match(reply.text, /preview responded/i);
  assert.doesNotMatch(reply.text, /build will add/i);
  assert.equal((await store.effectiveConfig()).checks.length, 0);
  assert.equal((await environment.dispatch('GET', 'design/app-process')).state, 'running');
});

test('sending a saved proposal prepares its check and starts the detected preview', async t => {
  let calls = 0, selections = 0, frontendCheck, backendCheck;
  const {send, store, coordinator, git, environment, repository} = await fixture(t, {
    'package.json': JSON.stringify({name: 'fixture', scripts: {test: 'node --test', 'test:backend': 'node --test'}}),
    'server.cjs': [
      "const fs = require('node:fs');",
      "const marker = require('node:path').join(process.env.BRANCH_REVIEW_DATA, 'started');",
      "const first = !fs.existsSync(marker);",
      "fs.writeFileSync(marker, 'started');",
      "require('node:http').createServer((req, res) => { res.statusCode = first ? 500 : 200; res.end('Fixture'); }).listen(process.env.PORT, '127.0.0.1');"
    ].join('\n'),
    'workbench-capabilities.json': JSON.stringify({schema_version: 1,
      previews: [{label: 'Fixture', argv: ['node', 'server.cjs'], cwd: '.', url: 'http://127.0.0.1:{port}', mode: 'web'}]})
  }, {invoke: async ({prompt, model, effort}) => {
    if (prompt.startsWith('Choose execution settings')) {
      selections++;
      return {text: JSON.stringify({stages: {}})};
    }
    calls++;
    assert.equal(model, 'gpt-6.2-sol');
    assert.equal(effort, 'high');
    return {text: JSON.stringify({message: 'Drafted the plan.', proposal: {...plan, checkId:frontendCheck?.id,
      acceptanceChecks: [{criterion:'Show the greeting', checkId:frontendCheck?.id},
        {criterion:'Save the greeting', checkId:backendCheck?.id}]}})};
  }});
  const inventory = await discoverCapabilities(repository);
  frontendCheck = inventory.checks.find(check => check.argv.join(' ') === 'npm test');
  backendCheck = inventory.checks.find(check => check.argv.join(' ') === 'npm run test:backend');
  assert.ok(frontendCheck && backendCheck);
  const draft = (await send({message: 'Update the greeting.'})).messages.at(-1);
  assert.deepEqual((await store.effectiveConfig()).checks, []);
  const prepared = (await send({preparePlan: true, proposalId: draft.id})).messages.at(-1);
  assert.equal(calls, 1);
  assert.equal(selections, 1);
  assert.equal(prepared.projectSetup.executionSetup.stages.build.model, 'gpt-6.2-sol');
  assert.equal(prepared.projectPrepared, true);
  assert.match(prepared.text, /The managed preview responded after restart/);
  assert.deepEqual((await store.effectiveConfig()).checks[0].argv, ['npm', 'test']);
  assert.deepEqual((await store.effectiveConfig()).checks[1].phases, ['after']);
  assert.match(prepared.proposal.plan, /## Acceptance checks[\s\S]+Save the greeting/);
  const readiness = await coordinator.dispatch('design/readiness');
  assert.equal(readiness.items.find(item => item.id === 'checks').status, 'ready');
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal(prepared.projectSetup.checks[0].status, 'ready');
  const launch = prepared.projectSetup.preview;
  assert.equal(launch.revision, await git('rev-parse', 'HEAD'));
  await writeFile(path.join(repository, 'greeting.txt'), 'Check modified source');
  const updated = await environment.prepareBrowserRecovery();
  assert.equal(updated.state, 'ready');
  assert.equal(updated.revision, launch.revision);
  assert.equal(updated.url, launch.url);
  assert.notEqual(updated.source, launch.source);
  assert.equal(updated.source, (await store.snapshot()).snapshot_sha256);
});

test('a project without checks receives a required after-build smoke test in the plan', async t => {
  let interrupted = false, supervised = 0, refreshed;
  const {send, store, coordinator, git} = await fixture(t, {'greeting.txt': 'Before'}, {
    superviseFailures: true,
    refreshPreviewAfterBuild: async ({revision}) => { refreshed = revision; },
    invoke: async ({stage, prompt, cwd}) => {
      if (prompt.startsWith('Supervise this stopped Branch Review build')) {
        supervised++;
        assert.match(prompt, /Temporary connection interruption/);
        return {text: JSON.stringify({action: 'retry', reason: 'The planning connection was interrupted.'})};
      }
      if (prompt.startsWith('You are the Branch Review Coordinator')) {
        return {text: JSON.stringify({message: 'Drafted the plan.', proposal: plan})};
      }
      if (prompt.startsWith('Choose execution settings')) return {text: JSON.stringify({stages: {}})};
      if (stage === 'plan' && !interrupted) {
        interrupted = true;
        throw Error('Temporary connection interruption');
      }
      if (stage === 'plan') return {text: JSON.stringify({plan: 'Update the greeting and add a smoke test.', question:'', suggestions:[]})};
      if (stage === 'plan_review') {
        assert.match(prompt, /Do not require their future results or implemented changes to pass the plan audit/);
        const context = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1).split('\n')[0]);
        assert.deepEqual(context.configuredChecks[0].argv, ['node', '--test', 'test/branch-review-smoke.cjs']);
        assert.deepEqual(context.configuredChecks[0].phases, ['after']);
        assert.equal(context.checks, undefined);
        assert.equal(context.receiptStatus, undefined);
        return {text: JSON.stringify({verdict: 'pass', reason: 'The plan covers both requirements.'})};
      }
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
  await post('build', {revision, mode: 'task', automaticRouting: true, decisions: {scope_confirmed: 'confirmed', code_changes: 'allow_scoped',
    migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  let build;
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    build = (await coordinator.dispatch('design')).builds.at(-1);
    if (build.status === 'review' || build.attention) break;
    await delay(150);
  }
  assert.equal(build.status, 'review', build.error);
  for (let attempt = 0; attempt < 50 && !refreshed; attempt++) await delay(100);
  assert.equal(refreshed, await git('rev-parse', 'HEAD'));
  assert.equal(supervised, 1);
  assert.equal(build.attempts.at(-1).automaticRecovery?.kind, 'supervisor');
  assert.equal(build.attempts[0].task, build.attempts.at(-1).task);
  const run = build.attempts.at(-1).task;
  const pinned = (await store.getRun(run)).task.profile;
  assert.equal(pinned.profiles[pinned.active].stages.build.model, 'gpt-6.2-sol');
  assert.equal(pinned.profiles[pinned.active].stages.build.effort, 'medium');
  assert.equal(build.executionSetup.stages.build.model, 'gpt-6.2-sol');
  assert.equal((await store.getProfile()).profiles[pinned.active].stages.build.model, 'gpt-6.2-sol');
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
  const followUp = await send({message: 'do it'});
  assert.equal(followUp.messages.at(-1).coordinatorAction.target, issue.id);
  assert.deepEqual(followUp.builds, []);
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
  await send({revision, message: 'Build status'});
  const resumed = await send({revision, message: 'try again'});
  assert.deepEqual(resumed.messages.at(-1).coordinatorAction, {
    kind: 'build-recovery', target: started.builds[0].id, state: 'completed'
  });
  assert.match(resumed.messages.at(-1).text, /Resumed the existing build/);
  assert.equal(resumed.builds.length, 1);
  assert.equal(resumed.builds[0].id, started.builds[0].id);
  assert.equal(resumed.builds[0].attempts.length, 2);
  assert.equal(resumed.builds[0].attempts[0].task, resumed.builds[0].attempts[1].task);
});
test('Retry checks the stopped baseline before starting another attempt', async t => {
  let diagnosed = 0;
  const {store, coordinator, git} = await fixture(t, {'greeting.txt': 'Before'}, {
    superviseFailures: true,
    invoke: async ({stage, prompt}) => {
      if (prompt.startsWith('Supervise this stopped Branch Review build')) {
        diagnosed++;
        return {text: JSON.stringify({action: 'retry', reason: 'Check the stopped checkout.'})};
      }
      return {text: JSON.stringify(stage === 'plan' ? {plan: ['Update the greeting.']} :
        {verdict: 'pass', reason: 'The plan covers the greeting.'})};
    }
  });
  const argv = ['node', '-e', "require('node:fs').writeFileSync('external-change.txt', 'keep me')"];
  await store.setProfile({...await store.getProfile(), checks: [{name: 'fixture', argv, cwd: '.', required: true, benchmark: false}]});
  const post = (route, data) => coordinator.dispatch('design/' + route, data, {method: 'POST'});
  const {revision} = await post('draft', {...plan, revision: 0, mode: 'task'});
  await post('approve', {revision, mode: 'task'});
  const started = await post('build', {revision, mode: 'task', decisions: {scope_confirmed: 'confirmed',
    code_changes: 'allow_scoped', migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  const build = started.builds.at(-1);
  for (let i = 0; i < 200; i++) {
    if ((await coordinator.dispatch('design')).builds.at(-1).attention) break;
    await delay(100);
  }
  await assert.rejects(post('continue', {build: build.id}), /baseline differs in external-change.txt/);
  assert.equal(diagnosed, 1);
  assert.equal((await coordinator.dispatch('design')).builds.at(-1).attempts.length, 1);
  assert.match(await git('status', '--porcelain'), /external-change.txt/);
});

test('every preview stop is supervised and failed preparation restarts the same build again', async t => {
  const server = createServer((_request, response) => response.end('ready'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const diagnostics = [];
  let previewCalls = 0, builds = 0;
  const ready = {state: 'ready', message: 'Preview responded.'};
  const {store, coordinator} = await fixture(t, {'greeting.txt': 'Before'}, {
    superviseFailures: true,
    configureStore: store => {
      store.needsBrowserPreview = async () => true;
      store.browserCheckUrl = async () => url;
    },
    prepareBrowserRecovery: async ({rerunSetup} = {}) => {
      previewCalls++;
      if (previewCalls === 2 || previewCalls === 3) return {state: 'blocked', message: 'Preview connection refused.'};
      if (previewCalls === 4) assert.equal(rerunSetup, true);
      return ready;
    },
    invoke: async ({stage, prompt, cwd}) => {
      if (prompt.startsWith('Supervise this stopped Branch Review build')) {
        diagnostics.push(prompt);
        return {text: JSON.stringify({action: 'report', reason: 'The preview did not respond.'})};
      }
      if (stage === 'plan') return {text: JSON.stringify({plan: ['Update greeting.']})};
      if (stage === 'plan_review') return {text: JSON.stringify({verdict: 'pass', reason: 'Plan is ready.'})};
      if (stage === 'build') {
        builds++;
        await writeFile(path.join(cwd, 'greeting.txt'), 'After');
        return {text: 'Updated the greeting.'};
      }
      return {text: JSON.stringify({verdict: 'pass', reason: 'The check passed.',
        criteria: ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints']
          .map(id => ({id, verdict: 'pass', evidence: ['The check and source confirm the change.'], reason: ''}))})};
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
  let build;
  for (let index = 0; index < 400; index++) {
    build = (await coordinator.dispatch('design')).builds.at(-1);
    if (build.status === 'review' || build.attention) break;
    await delay(150);
  }
  assert.equal(build.status, 'review', build.attention?.id || build.error);
  assert.equal(build.id, started.builds[0].id);
  assert.equal(builds, 1);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every(value => value.includes('Preview connection refused.')));
  assert.equal(new Set(build.attempts.map(row => row.task)).size, 1);
  assert.deepEqual(build.attempts.slice(1).map(row => row.automaticRecovery.action), ['prepare-environment', 'rerun-declared-setup']);
});

test('Coordinator returns a missing audit result through the configured repair loop', async t => {
  const finding = 'A delivery test result is missing for the saved preference.';
  let builderCalls = 0, diagnoses = 0;
  const {store, coordinator} = await fixture(t, {'greeting.txt': 'Before'}, {
    superviseFailures: true,
    invoke: async ({stage, prompt, cwd}) => {
      if (prompt.startsWith('Supervise this stopped Branch Review build')) {
        diagnoses++;
        assert.match(prompt, /"canReturn":true/);
        return {text: JSON.stringify({action: 'return-to-loop', reason: finding,
          summary: 'The audit needs one more test result.'})};
      }
      if (stage === 'plan') return {text: JSON.stringify({plan: ['Update greeting.']})};
      if (stage === 'plan_review') return {text: JSON.stringify({verdict: 'pass', reason: 'Plan is ready.'})};
      if (stage === 'build') {
        builderCalls++;
        if (builderCalls === 2) assert.ok(prompt.includes(finding));
        await writeFile(path.join(cwd, 'greeting.txt'), builderCalls === 1 ? 'After' : 'Verified greeting');
        return {text: builderCalls === 1 ? 'Updated greeting.' : 'Added the focused check result.'};
      }
      if (builderCalls === 1) return {text: JSON.stringify({verdict: 'needs_evidence', reason: finding})};
      return {text: JSON.stringify({verdict: 'pass', reason: 'The check passed.',
        criteria: ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints']
          .map(id => ({id, verdict: 'pass', evidence: ['The check and source confirm the change.'], reason: ''}))})};
    }
  });
  await store.setProfile({...await store.getProfile(), checks: [{name: 'fixture', argv: ['node', '-e', 'process.exit(0)'],
    required: true, benchmark: false, cwd: '.'}]});
  const checks = (await store.effectiveConfig()).checks;
  const post = (route, data) => coordinator.dispatch('design/' + route, data, {method: 'POST'});
  const {revision} = await post('draft', {...plan, revision: 0, mode: 'task'});
  await post('approve', {revision, mode: 'task'});
  const started = await post('build', {revision, mode: 'task', decisions: {scope_confirmed: 'confirmed',
    code_changes: 'allow_scoped', migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  let build;
  for (let index = 0; index < 400; index++) {
    build = (await coordinator.dispatch('design')).builds.at(-1);
    if (build.status === 'review' || build.attention) break;
    await delay(150);
  }
  assert.equal(build.status, 'review', build.error);
  assert.equal(build.id, started.builds[0].id);
  assert.equal(builderCalls, 2);
  assert.equal(diagnoses, 1);
  assert.equal(build.attempts[1].task, build.attempts[0].task);
  assert.equal(build.attempts[1].automaticRecovery.action, 'return-to-loop');
  assert.deepEqual((await store.effectiveConfig()).checks, checks);
});

test('Coordinator collects a missing declared test result inside the repair loop', async t => {
  const finding = 'A delivery test result is missing for the saved preference.';
  let builderCalls = 0, diagnoses = 0, setupAttempts = 0, fixtureRoot;
  const {store, coordinator, repository} = await fixture(t, {
    'greeting.txt': 'Before',
    'package.json': JSON.stringify({scripts: {test: 'node check.cjs'}}),
    'check.cjs': "if (!require('node:fs').existsSync('.harness/setup-ready')) { console.error('ActiveRecord::PendingMigrationError'); process.exit(1); }"
  }, {
    superviseFailures: true,
    prepareBrowserRecovery: async ({requireSetup} = {}) => {
      assert.equal(requireSetup, true);
      setupAttempts++;
      await writeFile(path.join(fixtureRoot, '.harness/setup-ready'), '');
      return {state:'ready'};
    },
    invoke: async ({stage, prompt, cwd, model, effort, onUsage}) => {
      if (prompt.startsWith('Supervise this stopped Branch Review build')) {
        diagnoses++;
        assert.equal(model, 'gpt-6.2-sol');
        assert.equal(effort, 'high');
        onUsage({input:100, cached:70, output:15});
        assert.match(prompt, /"canReturn":true/);
        const context = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1).split('\n\n')[0]);
        return {text: JSON.stringify({action: 'test-only', checkId: context.evidence.evidenceTests[0].id, reason: finding,
          summary: 'The audit needs one more test result.'})};
      }
      if (stage === 'plan') return {text: JSON.stringify({plan: ['Update greeting.']})};
      if (stage === 'plan_review') return {text: JSON.stringify({verdict: 'pass', reason: 'Plan is ready.'})};
      if (stage === 'build') {
        assert.equal(model, 'gpt-6.2-astra');
        builderCalls++;
        if (builderCalls === 2) assert.ok(prompt.includes(finding));
        await writeFile(path.join(cwd, 'greeting.txt'), builderCalls === 1 ? 'After' : 'Verified greeting');
        return {text: builderCalls === 1 ? 'Updated greeting.' : 'Added the focused check result.'};
      }
      if (!prompt.includes('"receipt":')) return {text: JSON.stringify({verdict: 'needs_evidence', reason: finding})};
      assert.match(prompt, /"receipt"/);
      return {text: JSON.stringify({verdict: 'pass', reason: 'The check passed.',
        criteria: ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints']
          .map(id => ({id, verdict: 'pass', evidence: ['The check and source confirm the change.'], reason: ''}))})};
    }
  });
  fixtureRoot = repository;
  const profile = await store.getProfile();
  profile.profiles[profile.active].stages.build.model = 'gpt-6.2-astra';
  await store.setProfile({...profile, checks: [{name: 'fixture', argv: ['node', '-e', 'process.exit(0)'],
    required: true, benchmark: false, cwd: '.'}]});
  const checks = (await store.effectiveConfig()).checks;
  const post = (route, data) => coordinator.dispatch('design/' + route, data, {method: 'POST'});
  const {revision} = await post('draft', {...plan, revision: 0, mode: 'task'});
  await post('approve', {revision, mode: 'task'});
  const buildRequest = {revision, mode: 'task', decisions: {scope_confirmed: 'confirmed',
    code_changes: 'allow_scoped', migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}};
  await assert.rejects(post('build', buildRequest), /Approve Astra/);
  assert.equal((await coordinator.dispatch('design')).builds.length, 0);
  const {astra} = await post('execution', {revision});
  assert.deepEqual(astra.stages.map(stage => stage.name), ['Build & repair']);
  const started = await post('build', {...buildRequest, astraApproval:astra.approval});
  let build;
  for (let index = 0; index < 400; index++) {
    build = (await coordinator.dispatch('design')).builds.at(-1);
    if (build.status === 'review' || build.attention) break;
    await delay(150);
  }
  assert.equal(build.status, 'review', build.error);
  assert.equal(build.id, started.builds[0].id);
  assert.equal(builderCalls, 1);
  assert.equal(diagnoses, 1);
  assert.equal(setupAttempts, 1);
  assert.equal(build.attempts[1].task, build.attempts[0].task);
  assert.equal(build.attempts[1].automaticRecovery.action, 'return-to-loop');
  assert.deepEqual((await store.effectiveConfig()).checks, checks);
  const progress = await coordinator.dispatch('design/progress');
  assert.equal(progress.run.usage.recovery.length, 1);
  assert.equal(progress.run.usage.uncached, 30);
});

test('Coordinator reads an unfamiliar failed check and keeps its actionable report without blind retries', async t => {
  const failure = 'Fixture seed orchard-739 requires the amber setting.';
  const nextAction = 'Open Workspace and set the fixture seed to amber, then select Retry.';
  let diagnoses = 0;
  const {store, coordinator} = await fixture(t, {'greeting.txt': 'Before'}, {
    superviseFailures: true,
    invoke: async ({stage, prompt}) => {
      if (prompt.startsWith('Supervise this stopped Branch Review build')) {
        diagnoses++;
        assert.ok(prompt.includes(failure), 'Coordinator must receive the actual saved check output.');
        return {text: JSON.stringify({action: 'report', reason: 'The required fixture setting is missing.',
          summary: 'The project check needs a fixture setting.', nextAction})};
      }
      if (stage === 'plan') return {text: JSON.stringify({plan: ['Update the greeting.']})};
      assert.equal(stage, 'plan_review');
      return {text: JSON.stringify({verdict: 'pass', reason: 'The plan covers the requested greeting.'})};
    }
  });
  await store.setProfile({...await store.getProfile(), checks: [{name: 'fixture',
    argv: ['node', '-e', 'console.error(' + JSON.stringify(failure) + '); process.exit(1)'],
    required: true, benchmark: false, cwd: '.'}]});
  const post = (route, data) => coordinator.dispatch('design/' + route, data, {method: 'POST'});
  const {revision} = await post('draft', {...plan, revision: 0, mode: 'task'});
  await post('approve', {revision, mode: 'task'});
  const started = await post('build', {revision, mode: 'task', decisions: {scope_confirmed: 'confirmed',
    code_changes: 'allow_scoped', migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  let state, build;
  for (let index = 0; index < 400; index++) {
    state = await coordinator.dispatch('design');
    build = state.builds.at(-1);
    if (build.attention) break;
    await delay(100);
  }
  assert.equal(build.id, started.builds[0].id);
  assert.equal(build.status, 'failed');
  assert.equal(build.attempts.length, 1);
  assert.equal(diagnoses, 1);
  assert.ok(state.messages.some(message => message.buildAttention && message.text.includes(nextAction)));
  const run = await store.getRun(build.attempts[0].task);
  assert.equal(run.checks[0].exit_code, 1);
  assert.notEqual((await store.status(build.attempts[0].task)).verdict, 'pass');
});

for (const operation of ['cancel', 'archive']) test(operation + ' interrupts Coordinator diagnosis and survives restart', async t => {
  let diagnosing;
  const diagnosisStarted = new Promise(resolve => { diagnosing = resolve; });
  let diagnoses = 0, interrupted = false;
  const invoke = async ({stage, prompt, signal}) => {
    if (prompt.startsWith('Supervise this stopped Branch Review build')) {
      diagnoses++;
      diagnosing();
      return new Promise((_resolve, reject) => {
        const abort = () => { interrupted = true; reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, {once: true});
      });
    }
    assert.equal(stage, 'plan');
    throw Error('Fixture interrupted before planning.');
  };
  const {store, coordinator, git, repository} = await fixture(t, {'greeting.txt': 'Before'}, {
    superviseFailures: true, invoke
  });
  await store.setProfile({...await store.getProfile(), checks: [{name: 'fixture',
    argv: ['node', '-e', 'process.exit(0)'], required: true, benchmark: false, cwd: '.'}]});
  const post = (route, data) => coordinator.dispatch('design/' + route, data, {method: 'POST'});
  const {revision} = await post('draft', {...plan, revision: 0, mode: 'task'});
  await post('approve', {revision, mode: 'task'});
  const started = await post('build', {revision, mode: 'task', decisions: {scope_confirmed: 'confirmed',
    code_changes: 'allow_scoped', migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  await diagnosisStarted;
  const stopped = await post(operation, {build: started.builds[0].id, revision});
  if (operation === 'cancel') assert.equal(stopped.builds[0].status, 'cancelled');
  else assert.deepEqual(stopped.builds, []);
  assert.equal(interrupted, true);
  await coordinator.close();
  const resumed = await createCoordinator({repository, store, git, superviseFailures: true, invoke});
  t.after(() => resumed.close());
  let state = await resumed.dispatch('design');
  if (operation === 'cancel') {
    assert.equal(state.builds[0].status, 'cancelled');
    assert.equal(state.builds[0].attempts.length, 1);
  } else assert.deepEqual(state.builds, []);
  await resumed.dispatch('design/attention');
  assert.equal(diagnoses, 1);
  if (operation === 'cancel') {
    state = await resumed.dispatch('design/archive', {revision: state.revision}, {method: 'POST'});
    assert.deepEqual(state.builds, []);
  }
  await resumed.dispatch('design/attention');
  assert.equal(diagnoses, 1);
});
