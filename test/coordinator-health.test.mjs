import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import diagnostics from '../desktop/runtime-diagnostics.cjs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHealthReviewer} from '../workbench/coordinator/health.mjs';
import {observeRuntime} from '../workbench/coordinator/runtime-probes.mjs';
import {repairRuntime} from '../workbench/coordinator/health-repair.mjs';
import {gitRead} from '../workbench/environment/paths.mjs';

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'br-health-test-'));
  t.after(() => rm(dir, {recursive: true, force: true, maxRetries: 3}));
  return dir;
}
test('observes host requests during use and excludes the loaded project', async () => {
  const origin = 'http://127.0.0.1:4310';
  const project = 'http://127.0.0.1:4410';
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  const contents = window.webContents = new EventEmitter();
  contents.id = 9;
  contents.isCrashed = () => false;
  contents.mainFrame = {framesInSubtree: []};
  let complete, fail;
  contents.session = {webRequest: {
    onCompleted: (_filter, callback) => { complete = callback; },
    onErrorOccurred: (_filter, callback) => { fail = callback; }
  }};
  const monitor = diagnostics.createRuntimeDiagnostics();
  monitor.attach(window, origin);
  const request = {webContentsId: contents.id, url: origin + '/api/example', method: 'POST', statusCode: 500};
  complete({...request, initiatorOrigin: project});
  fail({...request, url: project + '/example', initiatorOrigin: origin, error: 'Connection failed'});
  contents.emit('console-message', {level: 'error', frame: {url: project}, message: 'Project error'});
  assert.deepEqual((await monitor.observations()).filter(row => row.error), []);

  complete({...request, initiatorOrigin: origin});
  const issue = (await monitor.observations()).find(row => row.id === 'request:POST /api/example');
  assert.equal(issue.error, 'HTTP 500');
  complete({...request, initiatorOrigin: origin, statusCode: 200});
  assert.equal((await monitor.observations()).find(row => row.id === issue.id).error, '');
});

test('ignores project failures and verifies a host repair only after restart', async t => {
  const directory = await temp(t);
  const host = {owner: 'host', id: 'api', title: 'Workspace API', error: 'HTTP 500'};
  const project = {owner: 'project', id: 'preview', title: 'Preview', error: 'Preview failed'};
  let signals = [host, project], canRepair = false, notices = 0;
  const options = {directory, start: false, idle: () => canRepair,
    observe: () => observeRuntime({observations: () => signals}),
    repair: async row => {
      assert.equal(row.owner, 'host');
      return {summary: 'Fixed the workspace response', checks: 'Request check passed', files: ['server.mjs']};
    },
    restartRequired: () => { notices++; }};
  const monitor = await createHealthReviewer(options);
  await monitor.tick(); await monitor.tick();
  assert.deepEqual(monitor.status().incidents.map(row => row.owner), ['host']);
  assert.equal(monitor.status().incidents[0].state, 'detected');
  canRepair = true;
  await monitor.tick();
  assert.equal(notices, 1);
  assert.equal(monitor.status().incidents[0].state, 'restart-required');
  signals = [{...host, error: ''}, project];
  await monitor.tick();
  assert.equal(monitor.status().incidents[0].state, 'restart-required');
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  signals = [project];
  await restarted.tick();
  assert.equal(restarted.status().incidents[0].state, 'verifying');
  signals = [{...host, error: ''}, project];
  await restarted.tick();
  const [row] = restarted.status().incidents;
  assert.equal(row.state, 'recovered');
  assert.equal(row.history[0].outcome, 'verified');
  assert.ok(row.verifiedAt);
});

test('uses failed repair results and stops after five attempts across a restart', async t => {
  const directory = await temp(t);
  const signal = {owner: 'host', id: 'renderer', title: 'Workspace renderer', error: 'Renderer crashed', restart: true};
  let now = 1000, notices = 0;
  const failures = [];
  const options = {directory, start: false, interval: 10, clock: () => now, observe: () => [signal],
    idle: () => true, restartRequired: () => { notices++; },
    repair: row => {
      assert.ok(row.history.slice(0, -1).every(attempt => attempt.outcome === 'failed' && attempt.detail));
      const detail = 'Approach ' + row.attempts + ' did not pass its checks';
      failures.push(detail);
      throw Error(detail);
    }};
  const monitor = await createHealthReviewer(options);
  await monitor.tick(); await monitor.tick();
  assert.equal(notices, 1);
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  for (let tick = 0; tick < 12; tick++) {
    now += 50;
    await restarted.tick();
  }
  const [row] = restarted.status().incidents;
  assert.equal(row.state, 'attention');
  assert.equal(row.attempts, 5);
  assert.equal(failures.length, 4);
  assert.match(row.history[0].detail, /still fails after restart/);
  assert.deepEqual(row.history.slice(1).map(attempt => attempt.detail), failures);
  signal.error = 'Renderer crashed with a different error';
  now += 500;
  await restarted.tick(); await restarted.tick();
  assert.equal(restarted.status().incidents[0].attempts, 5);
});

test('keeps observing other failures during a repair and rejects a stale application', async t => {
  const directory = await temp(t);
  const host = {owner:'host', id:'api', title:'API', error:'Response failed'};
  let signals = [host], release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const working = new Promise(resolve => { started = resolve; });
  let applicable;
  const reviewer = await createHealthReviewer({directory, start:false, observe: () => signals, idle: () => true,
    repair: async (_row, _dir, _signal, mayApply) => {
      started(); await gate;
      applicable = await mayApply();
      throw Error('The runtime evidence changed.');
    }});
  t.after(() => reviewer.close());
  await reviewer.tick(); await reviewer.tick(false); await working;
  signals = [{...host,error:''}, {owner:'host', id:'other', title:'Page', error:'Blank page'}];
  await reviewer.tick(false);
  assert.equal(reviewer.status().incidents.find(row => row.key === 'host/other').state, 'detected');
  release(); await reviewer.tick();
  assert.equal(Boolean(applicable), false);
});

test('applies a repair from an isolated checkout and preserves local edits', async t => {
  const repository = await temp(t), directory = await temp(t);
  await gitRead(repository, 'init', '-b', 'main');
  await gitRead(repository, 'config', 'core.autocrlf', 'false');
  const file = path.join(repository, 'service.js');
  await writeFile(file, 'broken\n');
  await gitRead(repository, 'add', '.');
  await gitRead(repository, '-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  const repair = (prior = [], change = 'fixed', receiptDir = directory) => repairRuntime({repository, directory: receiptDir, prior,
    incident:{owner:'host',error:'fixture error'},
    profile:{active:'fast',profiles:{fast:{stages:{build:{provider:'Codex'}}}}},
    signal:new AbortController().signal, mayApply: () => true, invoke:async ({cwd}) => {
      assert.notEqual(cwd, repository);
      await writeFile(path.join(cwd, 'service.js'), change + '\n');
      return {text: JSON.stringify({verified:true,summary:'Fixed service',checks:'Fixture check passed'})};
    }});
  assert.deepEqual((await repair()).files, ['service.js']);
  assert.equal(await readFile(file,'utf8'), 'fixed\n');
  const prior = [{patch: path.join(directory,'repair.patch'), files:['service.js']}];
  const followup = path.join(directory,'followup');
  await repair(prior, 'verified', followup);
  assert.equal(await readFile(file,'utf8'), 'verified\n');
  await writeFile(file,'user edit\n');
  await assert.rejects(repair(prior, 'verified', followup), /overlaps local changes/);
  assert.equal(await readFile(file,'utf8'), 'user edit\n');
});

test('repairs shipped host source without a Git checkout at the installation', async t => {
  const repository = await temp(t), directory = await temp(t);
  const file = path.join(repository, 'host.mjs');
  await writeFile(file, 'export default false;\n');
  const result = await repairRuntime({repository, directory, packaged: true, incident:{owner:'host',error:'fixture error'},
    profile:{active:'fast',profiles:{fast:{stages:{build:{provider:'Codex'}}}}},
    signal:new AbortController().signal, mayApply: () => true, invoke:async ({cwd}) => {
      await writeFile(path.join(cwd, 'host.mjs'), 'export default true;\n');
      return {text: JSON.stringify({verified:true,summary:'Fixed host',checks:'Fixture check passed'})};
    }});
  assert.deepEqual(result.files, ['host.mjs']);
  assert.equal((await readFile(file,'utf8')).trim(), 'export default true;');
  await assert.rejects(readFile(path.join(repository,'.git','HEAD')), {code:'ENOENT'});
});
