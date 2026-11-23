import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
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
async function listen(t, respond) {
  const server = createServer(respond);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('detects project and host failures independently and verifies recovery from new observations', async t => {
  const directory = await temp(t);
  let hostStatus = 500, denyFrame = true, canRepair = false;
  const origin = await listen(t, (_req, res) => {
    res.writeHead(hostStatus); res.end(JSON.stringify({builds: []}));
  });
  const url = await listen(t, (_req, res) => {
    res.writeHead(200, denyFrame ? {'X-Frame-Options':'SAMEORIGIN'} : {}); res.end('Project');
  });
  const owners = [];
  const monitor = await createHealthReviewer({directory, start: false,
    idle: () => canRepair,
    observe: () => observeRuntime({origin, preview: () => ({owned: true, url, state:'running', settings:{mode:'web'}})}),
    repair: async row => { owners.push(row.owner); return {summary:'Fixture correction', checks:'Fixture check'}; },
    activate: row => { if (row.owner === 'host') hostStatus = 200; else denyFrame = false; }});
  t.after(() => monitor.close());
  await Promise.all([monitor.tick(), monitor.tick()]);
  assert.deepEqual(owners, []);
  await monitor.tick();
  assert.deepEqual(owners, []);
  canRepair = true;
  await monitor.tick(); await monitor.tick(); await monitor.tick();
  assert.deepEqual(owners, ['host','project']);
  assert.equal(monitor.status().incidents.length, 2);
  assert.ok(monitor.status().incidents.every(row => row.state === 'recovered' && row.verifiedAt));
  const persisted = JSON.parse(await readFile(path.join(directory, 'incidents.json')));
  assert.equal(persisted.filter(row => row.state === 'recovered').length, 2);
});

test('recovers a process first and keeps missing evidence pending', async t => {
  const directory = await temp(t);
  const finding = {owner:'project', id:'process', title:'Process', error:'Exited', restart:true};
  let signals = [finding], restarts = 0;
  const reviewer = await createHealthReviewer({directory, start:false, observe: () => signals, idle: () => true,
    recover: () => { restarts++; }, repair: () => assert.fail('Unexpected provider call')});
  t.after(() => reviewer.close());
  await reviewer.tick(); await reviewer.tick();
  assert.equal(restarts, 1);
  signals = [];
  await reviewer.tick();
  assert.equal(reviewer.status().incidents[0].state, 'verifying');
  signals = [{...finding,error:''}];
  await reviewer.tick();
  assert.equal(reviewer.status().incidents[0].state, 'recovered');
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
  signals = [{...host,error:''}, {owner:'project', id:'page', title:'Page', error:'Blank page'}];
  await reviewer.tick(false);
  assert.equal(reviewer.status().incidents.find(row => row.owner === 'project').state, 'detected');
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
  const repair = () => repairRuntime({repository, directory, incident:{owner:'host',error:'fixture error'},
    profile:{active:'fast',profiles:{fast:{stages:{build:{provider:'Codex'}}}}},
    signal:new AbortController().signal, mayApply: () => true, invoke:async ({cwd}) => {
      assert.notEqual(cwd, repository);
      await writeFile(path.join(cwd, 'service.js'), 'fixed\n');
      return {text: JSON.stringify({verified:true,summary:'Fixed service',checks:'Fixture check passed'})};
    }});
  assert.deepEqual((await repair()).files, ['service.js']);
  assert.equal(await readFile(file,'utf8'), 'fixed\n');
  await writeFile(file,'user edit\n');
  await assert.rejects(repair(), /overlaps local changes/);
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
