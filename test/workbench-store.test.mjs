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

test('reuses after receipts only while their source and file inputs match', async t => {
  const wrapper = '.harness/check.js';
  const declared = '.harness/fixture.txt';
  const verify = {...check, argv:['node', wrapper], input_paths:[declared], phases:['after']};
  const {store, folder} = await setup(t, verify);
  const edit = (name, data) => fs.writeFile(path.join(folder, name), data);
  await edit(wrapper, 'console.log("Version 1")');
  await edit(declared, 'Original');
  const {task_id:id} = await store.startTask(start);
  const run = async () => (await store.runChecks(id, {phase:'after', reusePassing:true})).checks[0];

  const first = await run();
  assert.equal(first.exit_code, 0);
  assert.equal(first.inputs_changed, false);
  const previewFolder = path.join(folder, '.local-dev/workspace/workbench-environment');
  await fs.mkdir(previewFolder, {recursive:true});
  await edit('.local-dev/workspace/workbench-environment/preview-output.json', 'Changed preview log');
  const reused = await run();
  assert.equal(reused.reused, true);
  assert.equal(reused.id, first.id);

  await edit(wrapper, 'console.log("Version 2")');
  assert.equal(await store.checkReceiptStatus(id, first, await store.snapshot(id)), 'stale');
  assert.match((await store.status(id)).issues.join('\n'), /After evidence is stale after check inputs changed/);
  const second = await run();
  assert.notEqual(second.id, first.id);
  assert.equal(second.source_after_sha256, first.source_after_sha256);

  await edit(declared, 'Changed');
  const third = await run();
  assert.notEqual(third.id, second.id);
  await edit('greeting.txt', 'Changed source');
  assert.match((await store.status(id)).issues.join('\n'), /After evidence is stale after source mutation/);
  assert.notEqual((await run()).id, third.id);
});

test('preflight defers future project scripts and detects missing tools', async t => {
  const future = {...check, name:'future', argv:['node', 'verify.js'], cwd:'tests', phases:['after']};
  const {store, folder} = await setup(t, future);
  const {task_id:id} = await store.startTask(start);
  assert.deepEqual(await store.preflightChecks(id), []);
  const testFolder = path.join(folder, 'tests');
  await fs.mkdir(testFolder);
  const missing = await store.preflightChecks(id, {phase:'after'});
  assert.equal(missing[0]?.check, future.name);
  assert.match(missing[0]?.reason, /verify.js/);
  await fs.writeFile(path.join(testFolder, 'verify.js'), 'require("./missing-import.cjs");');
  assert.deepEqual(await store.preflightChecks(id, {phase:'after'}), []);
  const row = await store.runCheck(id, {name:future.name, phase:'after'});
  assert.equal(row.exit_code, 1);
  assert.equal(row.spawn_error, null);
  assert.match((await store.readRunRecord(id, row.evidence_path + '/stderr.log')).toString(), /MODULE_NOT_FOUND/);
  assert.equal(await store.checkReceiptStatus(id, row, await store.status(id)), 'failed');

  await store.stop(id, 'Check another prerequisite');
  const config = await store.config();
  const missingTool = {...check, argv:['workbench-test-missing-tool-8073']};
  await store.setConfig({...config, checks:[missingTool]});
  const fresh = await store.startTask(start);
  assert.deepEqual(await store.preflightChecks(fresh.task_id), [{check:check.name,
    reason:'Check executable is missing or cannot run: ' + missingTool.argv[0]}]);
});

test('check commands clear an inherited Electron Node mode', async t => {
  const prior = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  t.after(() => {
    if (prior === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prior;
  });
  const command = {...check, argv:['node', '-e', 'process.exit(Number(Boolean(process.env.ELECTRON_RUN_AS_NODE)))']};
  const {store} = await setup(t, command);
  const {task_id:id} = await store.startTask(start);
  assert.equal((await store.runCheck(id, {name:check.name, phase:'baseline'})).exit_code, 0);
});

test('checks record timeout failures and retain output', async t => {
  const slow = {...check, argv:['node', '-e', 'console.log("started"); setInterval(() => {}, 100);'], timeout_seconds:1};
  const {store} = await setup(t, slow);
  const {task_id:id} = await store.startTask(start);
  const result = await store.runChecks(id, {phase:'baseline'});
  assert.equal(result.verdict, 'revise');
  const row = result.checks[0];
  assert.equal(row.timed_out, true);
  assert.match(row.spawn_error, /Command timed out after 1 second/);
  assert.match((await store.readRunRecord(id, row.evidence_path + '/stdout.log')).toString(), /started/);
});
