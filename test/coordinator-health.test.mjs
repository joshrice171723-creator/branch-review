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
import {healthRegression, operationRegression, verifyHostHttpRegression} from '../workbench/coordinator/health-regression.mjs';

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'br-health-test-'));
  t.after(() => rm(dir, {recursive: true, force: true, maxRetries: 3}));
  return dir;
}

test('pausing aborts an active repair and remains paused after restart', async t => {
  const directory = await temp(t);
  let attempts = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const options = {directory, start:false, automatic:false, interval:10, idle:()=>true, observe:()=>[],
    repair:async (_row, _directory, signal) => {
      attempts++;
      if (attempts > 1) return {summary:'Fixed.', checks:'Checked.', files:['server.mjs']};
      started();
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      });
    }};
  const monitor = await createHealthReviewer(options);
  await monitor.report({id:'pause-test', title:'Review', issue:'Failed.', explicit:true});
  await monitor.tick(false);
  await ready;
  await monitor.setPaused(true);
  assert.equal(monitor.status().paused, true);
  assert.equal(monitor.status().incidents[0].state, 'paused');
  assert.equal(monitor.status().incidents[0].history[0].outcome, 'paused');
  await monitor.tick();
  assert.equal(attempts, 1);
  await monitor.close();

  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  assert.equal(restarted.status().paused, true);
  await restarted.tick();
  assert.equal(attempts, 1);
  await restarted.setPaused(false);
  await restarted.tick();
  assert.equal(attempts, 2);
  assert.equal(restarted.status().incidents[0].state, 'restart-required');
});

test('pausing waits for a repair already being applied', async t => {
  const directory = await temp(t);
  let started, release, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const monitor = await createHealthReviewer({directory, start:false, idle:()=>true, observe:()=>[],
    repair:async (_row, _directory, stop, mayApply) => {
      signal = stop;
      assert.equal(await mayApply(), true);
      started();
      await gate;
      return {summary:'Applied.', checks:'Checked.', files:['server.mjs']};
    }});
  t.after(() => { release(); return monitor.close(); });
  await monitor.report({title:'Apply', issue:'Failed.'});
  await monitor.tick(false);
  await ready;
  let finished = false;
  const pause = monitor.setPaused(true).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(signal.aborted, false);
  release();
  await pause;
  assert.equal(monitor.status().paused, true);
  assert.equal(monitor.status().incidents[0].state, 'restart-required');
});

test('pausing stops a running regression probe without recording a failure', async t => {
  const directory = await temp(t);
  await writeFile(path.join(directory, 'incidents.json'), JSON.stringify([{
    id:'probe', key:'host/probe', owner:'host', title:'Probe', error:'Failed.',
    state:'verifying', reported:true, attempts:1, detectedAt:1,
    regression:{kind:'http',path:'/api/workspace/design',status:200}, history:[{number:1,outcome:'restart-required'}]
  }]));
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const monitor = await createHealthReviewer({directory, start:false, idle:()=>true, observe:()=>[],
    verifyRegression:async (_check, signal) => {
      started();
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      });
    }});
  t.after(() => monitor.close());
  const check = monitor.tick(false);
  await ready;
  await monitor.setPaused(true);
  await check;
  assert.equal(monitor.status().paused, true);
  assert.equal(monitor.status().incidents[0].state, 'verifying');
  assert.equal(monitor.status().incidents[0].verification, undefined);
});

test('automatic repair stays off until the user explicitly requests repair', async t => {
  const directory = await temp(t);
  let attempts = 0;
  const monitor = await createHealthReviewer({directory, start:false, automatic:false, idle:()=>true, observe:()=>[],
    repair:async () => {
      attempts++;
      return {summary:'Fixed.', checks:'Checked.', files:['server.mjs']};
    }});
  t.after(() => monitor.close());
  await monitor.report({id:'operation:fixture', title:'Review', issue:'Failed.'});
  await monitor.tick();
  await monitor.tick();
  assert.equal(attempts, 0);
  await monitor.report({id:'operation:fixture', title:'Review', issue:'Failed.', explicit:true});
  await monitor.tick();
  assert.equal(attempts, 1);
});

test('an explicit project retry runs when automatic repair is off', async t => {
  const directory = await temp(t);
  let attempts = 0;
  const observation = {owner:'project', scope:'/fixture', id:'preview', title:'Preview', error:'Failed.',
    nextAction:'Retry the preview.'};
  const monitor = await createHealthReviewer({directory, start:false, automatic:false, idle:()=>true,
    observe:()=>[observation], recoverProject:async () => {
      attempts++;
      return {passed:true, detail:'Preview loaded.'};
    }});
  t.after(() => monitor.close());
  await monitor.tick();
  const row = monitor.status().incidents[0];
  assert.equal(row.state, 'attention');
  delete observation.nextAction;
  await monitor.retryProject(row.id);
  await monitor.tick();
  assert.equal(attempts, 1);
  assert.equal(monitor.status().incidents[0].state, 'recovered');
});

test('stopping a Health repair cancels it and prevents retry after restart', async t => {
  const directory = await temp(t);
  let attempts = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const options = {directory, start:false, idle:()=>true,
    observe:()=>[{owner:'host', id:'report:start', title:'Start', error:'Preview timed out.'}],
    repair:async (_row, _directory, signal) => {
      attempts++;
      started();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
    }};
  const monitor = await createHealthReviewer(options);
  const incident = await monitor.report({title:'Start', issue:'Preview timed out.', request:'Open review.'});
  const ticking = monitor.tick();
  await ready;
  await monitor.cancel(incident.id);
  await ticking;
  assert.equal(monitor.status().incidents[0].state, 'cancelled');
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  await restarted.tick();
  assert.equal(restarted.status().incidents[0].state, 'cancelled');
  assert.equal(attempts, 1);
});

test('a reported repair runs its saved HTTP regression only after manual restart', async t => {
  const directory = await temp(t);
  let probes = 0;
  const options = {directory, start: false, idle: () => true, observe: () => [],
    repair: async () => ({summary: 'Fixed the workspace API.', checks: 'Focused request check passed.', files: ['server.mjs'],
      regression: {kind: 'http', path: '/api/workspace/design', status: 200}}),
    verifyRegression: async check => {
      probes++;
      assert.equal(check.path, '/api/workspace/design');
      return {passed: true, detail: 'GET /api/workspace/design returned HTTP 200.'};
    }};
  const monitor = await createHealthReviewer(options);
  await monitor.report({title: 'Workspace API failure', issue: 'The workspace response fails.', request: 'Fix it.'});
  await monitor.tick();
  assert.equal(monitor.status().incidents[0].state, 'restart-required');
  await monitor.tick();
  assert.equal(probes, 0);
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  await restarted.tick();
  const [row] = restarted.status().incidents;
  assert.equal(probes, 1);
  assert.equal(row.state, 'recovered');
  assert.equal(row.history[0].outcome, 'verified');
  assert.equal(row.verification.passed, true);
});

test('reported interaction repairs wait for their exact observation after restart', async t => {
  const directory = await temp(t);
  let observed = [];
  const options = {directory, start: false, idle: () => true, observe: () => observed,
    repair: async () => ({summary: 'Fixed settings.', checks: 'Settings request check passed.', files: ['server.mjs'],
      regression: {kind: 'observation', id: 'request:GET /api/settings'}})};
  const monitor = await createHealthReviewer(options);
  await monitor.report({title: 'Settings failure', issue: 'The settings request fails.', request: 'Fix it.'});
  await monitor.tick();
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  observed = [{owner: 'host', id: 'request:GET /api/other', title: 'Other request', error: ''}];
  await restarted.tick();
  assert.equal(restarted.status().incidents[0].state, 'awaiting-observation');
  observed = [{owner: 'host', id: 'request:GET /api/settings', title: 'Settings request', error: ''}];
  await restarted.tick();
  assert.equal(restarted.status().incidents[0].state, 'recovered');
});

test('a failed saved regression becomes evidence for the next repair attempt', async t => {
  const directory = await temp(t);
  let now = 1000;
  const options = {directory, start: false, interval: 10, clock: () => now, idle: () => true, observe: () => [],
    repair: async row => {
      if (row.attempts === 2) assert.match(row.history[0].detail, /HTTP 500/);
      return {summary: 'Fixed the request.', checks: 'Focused check passed.', files: ['server.mjs'],
        regression: {kind: 'http', path: '/api/workspace/design', status: 200}};
    },
    verifyRegression: async () => ({passed: false, detail: 'GET /api/workspace/design returned HTTP 500.'})};
  const monitor = await createHealthReviewer(options);
  await monitor.report({title: 'Request fails', issue: 'Workspace fails.', request: 'Fix it.'});
  await monitor.tick();
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  await restarted.tick();
  await restarted.tick();
  assert.equal(restarted.status().incidents[0].state, 'retrying');
  now += 30;
  await restarted.tick();
  const [row] = restarted.status().incidents;
  assert.equal(row.state, 'restart-required');
  assert.equal(row.attempts, 2);
  assert.equal(row.history[0].outcome, 'failed');
});

test('legacy reported repairs show an observation wait and a repeated report resumes repair', async t => {
  const directory = await temp(t);
  const options = {directory, start: false, idle: () => true, observe: () => [],
    repair: async () => ({summary: 'Fixed dialog.', checks: 'Open the dialog to observe its behavior.', files: ['public/app.js']})};
  const monitor = await createHealthReviewer(options);
  await monitor.report({title: 'Dialog failure', issue: 'The dialog does not open.', request: 'Fix it.'});
  await monitor.tick();
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  await restarted.tick();
  const [row] = restarted.status().incidents;
  assert.equal(row.state, 'awaiting-observation');
  assert.match(row.note, /Retry Dialog failure/);
  await restarted.report({title: row.title, issue: row.error, request: 'It still fails.'});
  assert.equal(restarted.status().incidents[0].state, 'retrying');
  assert.equal(restarted.status().incidents[0].history[0].outcome, 'failed');
});

test('regression probes reject writes, external paths, and arbitrary commands', async () => {
  for (const probe of [
    {kind: 'http', path: '/api/workspace/design/build', status: 200},
    {kind: 'http', path: 'https://example.com', status: 200},
    {kind: 'command', argv: ['node', '-e', 'process.exit(0)']},
    {kind: 'observation', id: 'request:DELETE /api/settings'}
  ]) assert.throws(() => healthRegression(probe), /supported read-only/);
  const probe = {kind: 'http', path: '/api/workspace/design', status: 200};
  const result = await verifyHostHttpRegression({probe, origin: 'http://127.0.0.1:4310', request: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:4310/api/workspace/design');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    return new Response('', {status: 500});
  }});
  assert.equal(result.passed, false);
  await assert.rejects(verifyHostHttpRegression({probe, origin: 'https://example.com'}), /local Branch Review origin/);
});
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
  fail({...request, initiatorOrigin: origin, error: 'net::ERR_NETWORK_IO_SUSPENDED'});
  contents.emit('console-message', {level:'error', frame:{url:origin}, message:'Failed to load resource: net::ERR_NETWORK_IO_SUSPENDED'});
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
    signal:new AbortController().signal, mayApply: () => true, invoke:async ({cwd, timeoutMs}) => {
      assert.notEqual(cwd, repository);
      assert.equal(timeoutMs, null);
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

test('app repair can call active project MCP tools and closes the connection', async t => {
  const repository = await temp(t), directory = await temp(t);
  await gitRead(repository, 'init', '-b', 'main');
  await writeFile(path.join(repository, 'app.mjs'), 'export default true;\n');
  await gitRead(repository, 'add', '.');
  await gitRead(repository, '-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  let url;
  const result = await repairRuntime({repository, directory, incident:{owner:'host',error:'fixture error'},
    profile:{active:'fast',profiles:{fast:{stages:{build:{provider:'Codex'}}}}},
    signal:new AbortController().signal, mayApply:() => true,
    stageToolCall:async name => ({project:'fixture', tool:name}),
    invoke:async ({stageMcp}) => {
      url = stageMcp.url;
      const response = await fetch(url, {method:'POST', body:JSON.stringify({jsonrpc:'2.0',id:1,
        method:'tools/call',params:{name:'project_capabilities',arguments:{}}})}).then(reply => reply.json());
      assert.deepEqual(response.result.structuredContent, {project:'fixture',tool:'project_capabilities'});
      return {text:JSON.stringify({needsAction:true,summary:'Fixture checked.',nextAction:'Choose a project.'})};
    }});
  assert.equal(result.needsAction, true);
  await assert.rejects(fetch(url, {method:'POST'}));
});

test('a saved missing-remote comparison does not restart app repair', async t => {
  const directory = await temp(t);
  await writeFile(path.join(directory, 'incidents.json'), JSON.stringify([{
    id:'old-comparison', key:'host/operation:old', owner:'host', title:'Comparison',
    error:'Fetch origin and set its default branch before reviewing this repository.',
    state:'repairing', reported:true, attempts:1, observations:2,
    history:[{number:1,outcome:'running'}]
  }]));
  let repairs = 0;
  const reviewer = await createHealthReviewer({directory, start:false, observe:() => [], idle:() => true,
    repair:async () => { repairs++; }});
  t.after(() => reviewer.close());
  await reviewer.tick();
  const [incident] = reviewer.status().incidents;
  assert.equal(incident.state, 'attention');
  assert.match(incident.nextAction, /origin remote/);
  assert.equal(repairs, 0);
});

test('deduplicates an unfamiliar operation and preserves its exact verification after restart', async t => {
  const directory = await temp(t);
  const id = 'operation:' + 'a'.repeat(64);
  let now = 1000, repairs = 0;
  let observed = [{owner: 'host', id, title: 'Open review', error: 'Unfamiliar failure', occurredAt: now}];
  const options = {directory, start: false, clock: () => now, idle: () => true, observe: () => observed,
    repair: async () => {
      repairs++;
      return {summary: 'Fixed review.', files: ['server.mjs'], checks: 'Review check passed.',
        regression: {kind: 'http', path: '/api/workspace/design', status: 200}};
    }};
  const monitor = await createHealthReviewer(options);
  await monitor.report({id, title: 'Open review', issue: 'Unfamiliar failure',
    regression: {kind: 'observation', id}});
  await monitor.tick();
  await monitor.report({id, title: 'A different title', issue: 'Unfamiliar failure'});
  assert.equal(monitor.status().incidents.length, 1);
  assert.equal(repairs, 1);
  await monitor.close();
  now = 2000;
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  observed = [{owner: 'host', id, title: 'Open review', error: '', occurredAt: 1500}];
  await restarted.tick();
  assert.equal(restarted.status().incidents[0].state, 'awaiting-observation');
  observed[0].occurredAt = 2001;
  await restarted.tick();
  assert.equal(restarted.status().incidents[0].state, 'recovered');
  assert.equal(restarted.status().incidents[0].verification.probe.id, id);
});

test('persists project preview recovery and verifies its result without restarting the host', async t => {
  const directory = await temp(t);
  let now = 1000, attempts = 0;
  const observed = [{owner: 'project', id: 'preview', scope: '/fixture', title: 'Project preview', error: 'Setup exited.'}];
  const options = {directory, start: false, interval: 10, clock: () => now, idle: () => true, observe: () => observed,
    recoverProject: async signal => {
      assert.equal(signal.scope, '/fixture');
      attempts++;
      return {passed: attempts === 2, detail: attempts === 2 ? 'The intended page rendered.' : 'The page is still blank.'};
    }};
  const monitor = await createHealthReviewer(options);
  await monitor.tick(); await monitor.tick();
  assert.equal(monitor.status().incidents[0].state, 'retrying');
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  now += 100;
  await restarted.tick();
  const [row] = restarted.status().incidents;
  assert.equal(row.state, 'recovered');
  assert.equal(row.attempts, 2);
  assert.equal(row.verification.passed, true);
  assert.equal(row.history[0].outcome, 'failed');
});

test('a required user action does not launch a code repair', async t => {
  const directory = await temp(t);
  let repairs = 0;
  const monitor = await createHealthReviewer({directory, start: false, idle: () => true, observe: () => [],
    repair: () => { repairs++; }});
  t.after(() => monitor.close());
  await monitor.report({id: 'operation:' + 'b'.repeat(64), title: 'Astra approval', issue: 'Astra needs your approval.',
    nextAction: 'Open Plan and approve the proposed Astra stages.'});
  await monitor.tick(); await monitor.tick();
  assert.equal(repairs, 0);
  assert.equal(monitor.status().incidents[0].state, 'attention');
  assert.match(monitor.status().incidents[0].nextAction, /Open Plan/);
});

test('an unfamiliar blocker can produce a specific in-app action without a patch or restart', async t => {
  const directory = await temp(t);
  const monitor = await createHealthReviewer({directory, start: false, idle: () => true, observe: () => [],
    repair: async () => ({needsAction: true, summary: 'This folder no longer exists.',
      nextAction: 'Open Projects and choose the folder at its new location.'})});
  t.after(() => monitor.close());
  await monitor.report({id: 'operation:' + 'd'.repeat(64), title: 'Open project', issue: 'Unknown project failure.'});
  await monitor.tick();
  const [row] = monitor.status().incidents;
  assert.equal(row.state, 'attention');
  assert.equal(row.history[0].outcome, 'needs-action');
  assert.equal(row.files, undefined);
  assert.equal(row.nextAction, 'Open Projects and choose the folder at its new location.');
});

test('stopping a preview cancels its active recovery and remains stopped after restart', async t => {
  const directory = await temp(t);
  const signal = {owner: 'project', scope: '/fixture', id: 'preview', title: 'Project preview', error: 'Preview failed.'};
  let recoveries = 0;
  let started;
  const working = new Promise(resolve => { started = resolve; });
  const options = {directory, start: false, idle: () => true, observe: () => [signal],
    recoverProject: async (_issue, stop) => {
      recoveries++;
      started();
      await new Promise((resolve, reject) => stop.addEventListener('abort', () => reject(stop.reason), {once: true}));
    }};
  const monitor = await createHealthReviewer(options);
  await monitor.tick(); await monitor.tick(false);
  await working;
  assert.equal(monitor.status().incidents[0].state, 'repairing');
  signal.cancelled = true;
  await monitor.tick();
  assert.equal(monitor.status().incidents[0].state, 'cancelled');
  await monitor.close();
  const restarted = await createHealthReviewer(options);
  t.after(() => restarted.close());
  await restarted.tick();
  assert.equal(recoveries, 1);
  assert.equal(restarted.status().incidents[0].history[0].outcome, 'cancelled');
});

test('a reported operation repair cannot apply after the exact operation succeeds', async t => {
  const directory = await temp(t);
  const id = 'operation:' + 'e'.repeat(64);
  let now = 1000, release, started, applicable;
  const gate = new Promise(resolve => { release = resolve; });
  const working = new Promise(resolve => { started = resolve; });
  const signal = {owner: 'host', id, title: 'Open review', error: 'Review failed.', occurredAt: now};
  const monitor = await createHealthReviewer({directory, start: false, clock: () => now, idle: () => true, observe: () => [signal],
    repair: async (_row, _directory, _stop, mayApply) => {
      started(); await gate;
      applicable = await mayApply();
      throw Error('The operation already recovered.');
    }});
  t.after(() => monitor.close());
  await monitor.report({id, title: signal.title, issue: signal.error, regression: {kind: 'observation', id}});
  await monitor.tick(false); await working;
  signal.error = '';
  signal.occurredAt = ++now;
  release(); await monitor.tick();
  assert.equal(applicable, false);
  await monitor.tick();
  assert.equal(monitor.status().incidents[0].state, 'recovered');
});

test('a host repair waiting for restart does not block a project preview recovery', async t => {
  const directory = await temp(t);
  const signals = [];
  let previewRepairs = 0;
  const monitor = await createHealthReviewer({directory, start: false, idle: () => true, observe: () => signals,
    repair: async () => ({summary: 'The host repair is ready.', checks: 'Host check passed.', files: ['server.mjs']}),
    recoverProject: async () => { previewRepairs++; return {passed: true, detail: 'Project page rendered.'}; }});
  t.after(() => monitor.close());
  await monitor.report({title: 'Host dialog', issue: 'Dialog fails.'});
  await monitor.tick();
  signals.push({owner: 'project', scope: '/fixture', id: 'preview', title: 'Project preview', error: 'Setup failed.'});
  await monitor.tick(); await monitor.tick();
  assert.equal(previewRepairs, 1);
  assert.equal(monitor.status().incidents.find(row => row.owner === 'project').state, 'recovered');
  assert.equal(monitor.status().incidents.find(row => row.owner === 'host').state, 'restart-required');
});

test('project switch preserves other incidents without verifying or blocking the active project', async t => {
  const directory = await temp(t);
  const repairs = [];
  const options = {directory, start: false, idle: () => true, observe: () => [],
    repair: async row => {
      repairs.push(row.workspace);
      return {summary: 'The repair is ready.', checks: 'Focused check passed.', files: ['server.mjs']};
    }, verifyRegression: () => { throw Error('The inactive project must not be verified.'); }};
  const first = await createHealthReviewer({...options, workspace: '/first'});
  await first.report({id: 'first', workspace: '/first', title: 'First settings', issue: 'Settings failed.',
    regression: operationRegression('operation:' + '1'.repeat(64), '/api/project-settings')});
  await first.tick();
  await first.close();
  const second = await createHealthReviewer({...options, workspace: '/second'});
  t.after(() => second.close());
  assert.equal(second.status().incidents.length, 0);
  await second.report({id: 'second', workspace: '/second', title: 'Second settings', issue: 'Settings failed.'});
  await second.tick();
  assert.deepEqual(repairs, ['/first', '/second']);
  assert.equal(second.status().incidents[0].workspace, '/second');
  assert.equal(second.status().incidents[0].state, 'restart-required');
  const saved = JSON.parse(await readFile(path.join(directory, 'incidents.json'), 'utf8'));
  assert.equal(saved.find(row => row.workspace === '/first').state, 'restart-required');
});

test('trusted read metadata permits exact JSON replay and keeps query or mutation actions bound', async () => {
  const id = 'operation:' + '2'.repeat(64);
  const probe = operationRegression(id, '/api/project-settings');
  assert.deepEqual(probe, {kind: 'http', path: '/api/project-settings', status: 200, json: true});
  for (const path of [undefined, '/api/project-settings?project=other', '/api/workspace/design/build', 'https://example.com']) {
    assert.deepEqual(operationRegression(id, path), {kind: 'observation', id});
  }
  for (const [body, passed] of [['{}', true], ['null', true], ['{"error":"Still broken"}', false], ['<html>wrong page</html>', false]]) {
    const result = await verifyHostHttpRegression({probe, origin: 'http://127.0.0.1:4310',
      request: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:4310/api/project-settings');
        assert.equal(options.method, 'GET');
        return new Response(body, {status: 200});
      }});
    assert.equal(result.passed, passed);
  }
});
