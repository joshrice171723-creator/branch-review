import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createStore} from '../workbench/store.mjs';

const decisions = {
  scope_confirmed:'confirmed', code_changes:'allow_scoped', migrations:'deny', dependencies:'deny', engine_integration:'confirmed'
};
const criteria = ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints']
  .map(id => ({id, verdict:'pass', evidence:['Observed the check receipts and reviewed source.']}));
const start = {mode:'feature', action:'Change the greeting', scope:'greeting.txt', decisions};
const check = {name:'greeting', argv:['node', '-e', 'console.log(require("node:fs").readFileSync("greeting.txt","utf8")); console.error("receipt");'],
  cwd:'.', phases:['baseline', 'after'], required:true, benchmark:false};

async function setup(t, configuredCheck = check) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'br-records-'));
  t.after(() => fs.rm(folder, {recursive:true, force:true}));
  await fs.writeFile(path.join(folder, 'greeting.txt'), 'Before');
  const store = createStore(folder);
  const config = await store.config();
  await store.setConfig({...config, checks:[configuredCheck]});
  return {store, folder};
}

test('runs pinned checks and verifies current audited evidence', async t => {
  const {store, folder} = await setup(t);
  assert.equal(await store.profileApplied(), false);
  await store.setProfile(await store.getProfile());
  assert.equal(await store.profileApplied(), true);
  const {task_id:id, task} = await store.startTask(start);
  assert.match(id, /^\d{8}T\d{12}-[a-f0-9]{8}$/);
  assert.equal((await store.listRuns()).active, id);
  assert.equal((await store.questions(id)).missing_required.length, 0);
  const plan = 'e'.repeat(64);
  const profile = task.profile_sha256;
  await store.record(id, 'audits', {stage:'plan_review', verdict:'pass', reason:'Confirmed scope',
    plan_sha256:plan, snapshot_sha256:task.initial_snapshot.snapshot_sha256, profile_sha256:profile});
  const baseline = await store.runCheck(id, {name:check.name, phase:'baseline'});
  assert.equal(baseline.exit_code, 0);
  assert.equal((await store.readRunRecord(id, baseline.evidence_path + '/stdout.log')).toString().trim(), 'Before');
  await assert.rejects(store.answer(id, 'dependencies', 'allow'), /frozen/);
  const edited = await store.getProfile();
  edited.profiles.audited.stages.buildReview.limit = 2;
  await store.setProfile(edited);
  assert.equal((await store.executionConfig(id)).execution.max_repair_rounds, 3);
  await fs.writeFile(path.join(folder, 'greeting.txt'), 'After');
  const {checks, verdict} = await store.runChecks(id, {phase:'after'});
  assert.equal(verdict, 'pass');
  const after = checks[0];
  assert.notEqual(after.source_after_sha256, baseline.source_after_sha256);
  const evidence = {verdict:'pass', snapshot_sha256:after.source_after_sha256, profile_sha256:profile, criteria};
  for (const stage of ['build_review', 'final_review']) {
    await store.record(id, 'audits', {...evidence, stage, reason:'Reviewed check and scope', plan_sha256:plan});
  }
  await store.record(id, 'reviews', {...evidence, author:'agent'});
  const report = await store.verify(id, {record:true, complete:true});
  assert.equal(report.verdict, 'pass', report.issues.join('\n'));
  assert.equal(report.lifecycle.status, 'completed');
  const run = await store.getRun(id);
  assert.equal(run.ledger.verdict, 'pass');
  assert.equal(run.checks.find(row => row.phase === 'after').stderr_preview.trim(), 'receipt');
  await fs.writeFile(path.join(folder, 'greeting.txt'), 'Changed again');
  assert.match((await store.status(id)).issues.join('\n'), /After evidence is stale/);
  const log = path.join(run.artifact_directory, ...after.evidence_path.split('/'), 'stdout.log');
  await fs.writeFile(log, 'altered');
  assert.match((await store.getRun(id)).ledger.issues.join('\n'), /Artifact changed/);
  await assert.rejects(store.readRunRecord(id, '../task.json'), /recorded Workbench artifact/);
});

test('serializes run ownership and records source-mutating checks as failures', async t => {
  const bad = {...check, argv:['node', '-e', 'require("node:fs").writeFileSync("greeting.txt","Mutated")']};
  const {store, folder} = await setup(t, bad);
  const first = store.startTask(start);
  const second = createStore(folder).startTask(start);
  const starts = await Promise.allSettled([first, second]);
  const success = starts.find(row => row.status === 'fulfilled');
  const failure = starts.find(row => row.status === 'rejected');
  assert.ok(success);
  assert.match(failure.reason.message, /active task owns/);
  const id = success.value.task_id;
  const result = await store.runChecks(id, {phase:'baseline'});
  assert.equal(result.verdict, 'revise');
  assert.equal(result.checks[0].exit_code, 0);
  assert.equal(result.checks[0].source_changed, true);
  await assert.rejects(store.runCheck(id, {name:check.name, phase:'after'}), /passing baseline/);
  assert.equal((await store.pause(id, 'Review the check command')).lifecycle.status, 'paused');
  await assert.rejects(store.runChecks(id, {phase:'after'}), /Resume the task/);
  assert.equal((await store.resume(id)).lifecycle.status, 'active');
  assert.equal((await store.getRun(id)).ledger.verdict, 'pass');
});
