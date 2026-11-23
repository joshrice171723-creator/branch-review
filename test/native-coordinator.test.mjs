import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createCoordinator} from '../workbench/coordinator.mjs';
import {createStore} from '../workbench/store.mjs';
import {exportHandoff, workbenchComparison} from '../workbench-handoff.mjs';

const decisions = {scope_confirmed: 'confirmed', code_changes: 'allow_scoped', migrations: 'deny',
  dependencies: 'deny', engine_integration: 'confirmed'};
const criteria = ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints']
  .map(id => ({id, verdict: 'pass', reason: '', evidence: ['The current source and recorded check establish this criterion.']}));

async function fixture(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'branch-review-coordinator-'));
  t.after(() => rm(repository, {recursive: true, force: true}));
  const git = async (...args) => {
    const options = typeof args.at(-1) === 'object' ? args.pop() : {};
    return execFileSync('git', args, {cwd: repository, encoding: 'utf8', windowsHide: true, ...options}).trim();
  };
  await git('init', '-q', '-b', 'change');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Coordinator test');
  await writeFile(path.join(repository, '.gitignore'), '.harness/\n');
  await writeFile(path.join(repository, 'greeting.txt'), 'Before');
  await writeFile(path.join(repository, 'unrelated.txt'), 'Original');
  await git('add', '.');
  await git('commit', '-qm', 'Baseline');
  await writeFile(path.join(repository, 'unrelated.txt'), 'Staged unrelated change');
  await git('add', 'unrelated.txt');
  const store = createStore(repository);
  const check = {name: 'greeting', argv: ['node', '-e',
    'process.exit(require("node:fs").readFileSync("greeting.txt","utf8")==="Invalid" ? 1 : 0)'],
    cwd: '.', phases: ['baseline', 'after'], required: true, benchmark: false};
  await store.setConfig({...await store.config(), checks: [check]});
  await store.setProfile(await store.getProfile());
  return {git, store, repository};
}

async function waitForBuild(coordinator, wanted = 'review') {
  for (let attempt = 0; attempt < 900; attempt++) {
    const build = (await coordinator.dispatch('design')).builds.at(-1);
    if (build?.status === wanted) return build;
    if (build?.status === 'failed') assert.fail(build.error);
    await delay(200);
  }
  assert.fail('Build did not reach ' + wanted);
}

test('restarts a stopped build with saved agent settings and preserves working changes', async t => {
  const {git, store, repository} = await fixture(t);
  const audits = [];
  const coordinator = await createCoordinator({repository, store, git, async invoke({stage, provider, model}) {
    if (stage === 'plan') return {text: JSON.stringify({plan: ['Edit the greeting.']})};
    assert.equal(stage, 'plan_review');
    audits.push({provider, model});
    throw Error(provider === 'Muse' ? 'API error 429: Subscription quota exhausted.' : 'Test stop on Terra.');
  }});
  t.after(() => coordinator.close());
  const action = (name, data) => coordinator.dispatch(name, data, {method: 'POST'});
  const draft = await action('design/draft', {revision: 0, mode: 'task', title: 'Update greeting',
    plan: 'Edit the greeting.\n\n## Acceptance criteria\n- The greeting is updated.'});
  await action('design/approve', {revision: draft.revision, mode: 'task'});
  await action('design/build', {revision: draft.revision, mode: 'task', decisions});
  const build = await waitForBuild(coordinator, 'failed');
  assert.equal((await coordinator.dispatch('design')).resumeBlocker, '');
  const profile = await store.getProfile();
  const agent = {provider: 'Codex', model: 'gpt-6.1-terra', effort: 'high'};
  Object.assign(profile.profiles[profile.active].stages.planReview, agent);
  await store.setProfile(profile);

  const {run} = await coordinator.dispatch('design/progress');
  assert.equal(run.stages.planReview.provider, 'Muse');
  assert.equal(run.failure.role, 'planReview');
  assert.deepEqual(run.failure.savedAgent, agent);
  assert.match((await coordinator.dispatch('design')).resumeBlocker, /Agent settings changed/);
  await assert.rejects(action('design/continue', {build: build.id}), /Agent settings changed/);
  assert.equal(audits.length, 1);
  assert.equal((await coordinator.dispatch('design')).builds.at(-1).attempts.length, 1);

  const restart = {build: build.id, mode: 'task', revision: draft.revision};
  await assert.rejects(action('design/restart', {...restart, stages: {}}), /applied workflow changed/);
  assert.equal((await coordinator.dispatch('design')).builds.at(-1).status, 'failed');
  await writeFile(path.join(repository, 'greeting.txt'), 'Edit kept from the stopped build');
  const before = await git('status', '--short');
  const restarted = await action('design/restart', restart);
  assert.equal(restarted.builds.at(-2).status, 'retired');
  const fresh = await waitForBuild(coordinator, 'failed');
  assert.notEqual(fresh.id, build.id);
  assert.notEqual(fresh.attempts[0].task, build.attempts[0].task);
  assert.equal(fresh.plan, build.plan);
  assert.deepEqual(fresh.decisions, build.decisions);
  assert.equal(fresh.error, 'Test stop on Terra.');
  assert.deepEqual(audits.at(-1), {provider: 'Codex', model: agent.model});
  assert.equal(await git('status', '--short'), before);
  assert.equal(await readFile(path.join(repository, 'greeting.txt'), 'utf8'), 'Edit kept from the stopped build');
});

test('pins a checked commit, returns a failed check, and repairs the same approved task against its original base', async t => {
  const {git, store, repository} = await fixture(t);
  let reviewState;
  const stages = [];
  let edits = 0;
  const invoke = async ({stage, provider, write, prompt}) => {
    stages.push(stage);
    if (stage === 'plan') return {text: JSON.stringify({plan: ['Edit the greeting.', 'Inspect the configured check.']})};
    if (stage === 'build') {
      assert.equal(write, true);
      assert.match(prompt, /## Acceptance criteria/);
      await writeFile(path.join(repository, 'greeting.txt'), ['Invalid', 'After', 'Repaired'][edits++]);
      return {text: 'Updated the greeting.'};
    }
    assert.equal(provider, 'Muse');
    return {text: JSON.stringify({verdict: 'pass', reason: 'Reviewed the current evidence.', ...(stage === 'final_review' ? {criteria} : {})})};
  };
  const coordinator = await createCoordinator({repository, store, git, invoke, review: runId => ({runId, ...reviewState})});
  t.after(() => coordinator.close());
  const action = (name, data) => coordinator.dispatch(name, data, {method: 'POST'});
  const plan = '# Update the greeting\n\n## Acceptance criteria\n- The file contains the requested greeting.';
  let state = await action('design/draft', {revision: 0, mode: 'task', title: 'Update greeting', plan});
  state = await action('design/approve', {revision: state.revision, mode: 'task'});
  const base = await git('rev-parse', 'HEAD');
  await action('design/build', {revision: state.revision, mode: 'task', decisions});
  const first = await waitForBuild(coordinator);
  const group = first.groups[0];
  const attempt = first.attempts.at(-1);
  assert.deepEqual(stages, ['plan', 'plan_review', 'build', 'build_review', 'build', 'build_review', 'final_review']);
  assert.equal(group.base, base);
  assert.equal(group.sha, await git('rev-parse', 'HEAD'));
  assert.equal((await store.status(attempt.task)).lifecycle.status, 'completed');
  assert.equal((await store.getRun(attempt.task)).ledger.verdict, 'pass');
  const handoff = await exportHandoff(repository, attempt.task, git);
  assert.equal(handoff.commit, group.sha);
  assert.equal(handoff.design.base, base);
  assert.match(await git('diff', '--cached', '--name-only'), /^unrelated\.txt$/);
  assert.equal(await readFile(path.join(repository, 'unrelated.txt'), 'utf8'), 'Staged unrelated change');

  reviewState = {status: 'changes-requested', ref: 'refs/heads/change', commit: group.sha,
    reviewedCommit: group.sha, base, reviewId: 'review-one', slices: [{id: 'task'}],
    findings: [{id: 'one', actual: 'Existing greeting', expected: 'Repaired greeting', status: 'open'}]};
  await action('design/finding', {build: first.id, sha: group.sha, findingIds: ['one']});
  await action('design/continue', {build: first.id});
  const repaired = await waitForBuild(coordinator);
  const second = repaired.groups[0];
  assert.equal(repaired.id, first.id);
  assert.equal(repaired.revision, first.revision);
  assert.equal(repaired.plan, plan);
  assert.equal(second.base, base);
  assert.notEqual(second.sha, group.sha);
  assert.notEqual(repaired.attempts.at(-1).task, attempt.task);
  assert.equal(second.findings[0].repaired, true);
  assert.equal(await git('rev-parse', second.sha + '^'), group.sha);
  const nextRun = repaired.attempts.at(-1).task;
  const repairedHandoff = await exportHandoff(repository, nextRun, git);
  assert.equal(repairedHandoff.commit, second.sha);
  assert.equal((await workbenchComparison(repository, nextRun, git)).base, base);
  assert.equal(await readFile(path.join(repository, 'greeting.txt'), 'utf8'), 'Repaired');

  reviewState = {status: 'approved', ref: 'refs/heads/change', commit: second.sha,
    reviewedCommit: second.sha, base, reviewId: 'review-two', slices: [{id: 'task'}], findings: [],
    checklist: [{id: 'acceptance-1', status: 'passed'}], approval: {reviewer: 'QA', at: '2026-11-22T00:00:00Z'}};
  state = await action('design/review', {build: first.id, sha: second.sha});
  assert.equal(state.builds.at(-1).status, 'closed');
  assert.equal((await coordinator.dispatch('design/history')).length, 2);
  const archived = await action('design/archive', {revision: state.revision});
  assert.equal(archived.builds.length, 0);
  assert.equal(archived.conversations.at(-1).status, 'Completed');
  assert.equal((await coordinator.dispatch('design/history')).length, 2);
  assert.equal((await workbenchComparison(repository, nextRun, git)).base, base);
});

test('keeps a planning question until it has distinct suggestions and applies proposals only through a draft save', async t => {
  const {git, store, repository} = await fixture(t);
  const replies = [
    {question: 'Which greeting?', suggestions: ['Hello', 'hello']},
    {question: 'Which greeting?', suggestions: ['Hello', 'Welcome']},
    {plan: '## Acceptance criteria\n- Use Welcome.', message: 'Drafted the greeting.'},
    {message: 'Here is the proposal.', proposal: {kind: 'plan', title: 'Edit title', plan: 'Revised plan'}},
    {message: 'Here is the review plan.', proposal: {kind: 'plan', title: 'Fix finding', plan: 'Plan from review'}}
  ];
  let prompt, requestedModel, requestedEffort, attachedImages;
  let mockupRequest;
  const coordinator = await createCoordinator({repository, store, git,
    providerProbe: async provider => ({status: provider === 'muse' ? 'missing' : 'ready',
      message: provider === 'muse' ? 'Muse CLI is missing.' : 'Codex is ready.'}), invoke: async request => {
    prompt = request.prompt;
    requestedModel = request.model;
    requestedEffort = request.effort;
    attachedImages = request.images;
    return {text: JSON.stringify(replies.shift())};
  }, image: async request => { mockupRequest = request; return Buffer.from('mockup bytes'); }});
  const action = (name, data) => coordinator.dispatch(name, data, {method: 'POST'});
  let state = await action('design/draft', {revision: 0, mode: 'task', title: 'Update greeting', plan: ''});
  state = await action('design/chat', {revision: state.revision, mode: 'task', message: 'Draft the greeting change.'});
  assert.deepEqual(state.question.suggestions, ['Hello', 'Welcome']);
  await assert.rejects(action('design/answer', {revision: state.revision, mode: 'task', id: 'stale', message: 'Welcome'}), /question has changed/);
  state = await action('design/answer', {revision: state.revision, mode: 'task', id: state.question.id, message: 'Welcome'});
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=';
  state = await action('design/guide', {revision: state.revision, mode: 'task', message: 'Revise this plan.',
    changeScreenshot: {image: 'data:image/png;base64,' + screenshot, page: '/appointments'},
    conversationModel: {provider: 'Codex', model: 'gpt-6.2-sol', effort: 'low'},
    context: {view: 'workflow', tab: 'Plan', projectPage: '/appointments', activeProject: 'Other project', conversationOpen: false}});
  const context = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"activeProject":')));
  assert.equal(context.activeProject, path.basename(repository));
  assert.equal(context.conversationOpen, true);
  assert.deepEqual(context.screen, {view: 'workflow', tab: 'Plan', projectPage: '/appointments'});
  assert.deepEqual(context.screenshot, {page: '/appointments'});
  assert.equal((await readFile(attachedImages[0])).toString('base64'), screenshot);
  assert.match(context.planControls['Draft a plan'], /focuses the message box/);
  assert.equal(requestedModel, 'gpt-6.2-sol');
  assert.equal(requestedEffort, 'low');
  assert.notEqual((await store.getProfile()).profiles.audited.stages.plan.effort, 'low');
  assert.match(state.plan, /Use Welcome/);
  assert.equal(state.messages.at(-1).proposal.plan, 'Revised plan');
  assert.equal(state.messages.at(-1).proposal.before.plan, state.plan);
  state = await action('design/guide', {revision: state.revision, mode: 'task', message: 'Draft a fix.',
    preparePlan: true, context: {view: 'workflow', tab: 'Preview', kind: 'branch-review'}});
  assert.equal(state.messages.at(-1).proposal.plan, 'Plan from review');
  const mockup = {revision: state.revision, target: 'Project preview', referencePage: '/appointments',
    message: 'Add a confirmation button.', keep: 'Appointment details'};
  await assert.rejects(action('design/image', mockup), /Attach a screenshot/);
  const image = Buffer.from('reference bytes');
  state = await action('design/image', {...mockup, screenshot: 'data:image/png;base64,' + image.toString('base64')});
  assert.deepEqual(mockupRequest.reference, image);
  assert.match(mockupRequest.prompt, /"target":"Project preview"/);
  assert.match(mockupRequest.prompt, /"keep":"Appointment details"/);
  assert.equal(state.assets.at(-1).page, '/appointments');
  assert.equal(state.assets.at(-1).planRevision, mockup.revision);
  const revision = state.revision;
  const previous = state.messages;
  state = await action('design/archive', {revision, draft: {message: 'Unsaved thought'}});
  assert.equal(state.plan, '');
  assert.deepEqual(state.messages, []);
  assert.ok(state.conversationId);
  await assert.rejects(action('design/archive', {revision}), /draft changed/i);
  const index = await coordinator.dispatch('design/conversations');
  const entry = index.archived[0];
  assert.equal(entry.status, 'Draft plan');
  const archive = await coordinator.dispatch('design/conversations', {id: entry.id});
  assert.deepEqual(archive.messages, previous);
  assert.equal(archive.draft.message, 'Unsaved thought');
  const readiness = await coordinator.dispatch('design/readiness');
  const missing = readiness.items.find(row => row.id === 'provider-muse');
  assert.equal(missing.status, 'blocked');
  assert.match(missing.message,/Plan audit.*Muse CLI is missing/);
  state = await action('design/draft', {revision: state.revision, mode: 'task', title: 'Follow-up', plan: 'Update greeting.'});
  state = await action('design/approve', {revision: state.revision, mode: 'task'});
  await assert.rejects(action('design/build', {revision: state.revision, mode: 'task', decisions}), /Muse CLI is missing/);
  assert.equal((await coordinator.dispatch('design')).builds.length,0);
});

