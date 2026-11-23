import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {createEnvironment} from '../workbench/environment.mjs';

const execute = promisify(execFile);

async function fixture(t, files = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'branch-review-environment-'));
  const repository = path.join(base, 'project');
  const local = path.join(base, 'local');
  await mkdir(repository);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(repository, name);
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, content);
  }
  const git = (...args) => execute('git', args, {cwd: repository, windowsHide: true});
  await git('init', '--initial-branch=main');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture');
  let profile = {version: 1, active: 'fast', documents: [], profiles: {fast: {sharedDocs: [], stages: {build: {docs: []}}}}};
  const store = {
    getProfile: async () => structuredClone(profile),
    setProfile: async value => { profile = structuredClone(value); },
    config: async () => ({checks: []})
  };
  const environment = createEnvironment({repository, local, store, projectId: 'fixture'});
  t.after(async () => {
    await environment.close();
    await rm(base, {recursive: true, force: true});
  });
  return {repository, local, environment, store};
}

test('discovers tracked project commands and includes bounded instructions in a portable profile', async t => {
  const {repository, environment, store} = await fixture(t, {
    'ui/package.json': JSON.stringify({name: 'web', scripts: {test: 'node --test', dev: 'vite'}, devDependencies: {vite: '*'}}),
    'ui/package-lock.json': '{}',
    'api/server.mjs': 'import express from "express";\nconst app = express();\napp.get("/status", (_request, response) => response.send("ok"));',
    '.github/workflows/checks.yml': 'jobs:\n  checks:\n    steps:\n      - run: npm test\n        working-directory: ui\n',
    'docs/AGENTS.md': '# Build instructions\n',
    'workbench-capabilities.json': JSON.stringify({schema_version: 1, files: [{path: 'docs/Guide.txt', kind: 'instruction'}]}),
    'docs/Guide.txt': 'Project guide.'
  });
  await writeFile(path.join(repository, 'CLAUDE.md'), 'Untracked instruction.');
  const inventory = await environment.dispatch('GET', 'project-capabilities');
  assert.equal(inventory.git.branch, 'main');
  assert.deepEqual(inventory.checks[0].argv, ['npm', 'test']);
  assert.equal(inventory.checks[0].cwd, 'ui');
  assert.ok(inventory.checks[0].source.some(row => row.path === 'ui/package-lock.json'));
  assert.ok(inventory.checks[0].source.some(row => row.path === '.github/workflows/checks.yml' && row.line === 4));
  const capabilities = await environment.dispatch('GET', '/api/workspace/capabilities');
  assert.ok(capabilities.routes.some(route => route.method === 'GET' && route.path === '/status'));
  assert.equal(inventory.previews[0].url, 'http://127.0.0.1:{port}');
  assert.ok(inventory.previews[0].argv.includes('{port}'));
  assert.ok(inventory.files.some(row => row.path === 'docs/AGENTS.md'));
  assert.ok(!inventory.files.some(row => row.path === 'CLAUDE.md'));
  const instruction = file => environment.dispatch('GET', 'project-instruction', {}, new URLSearchParams({path: file}));
  await assert.rejects(instruction('../outside'), /relative/);
  await assert.rejects(instruction('CLAUDE.md'), /tracked/);
  assert.equal((await instruction('docs/Guide.txt')).content, 'Project guide.');
  const attached = await environment.dispatch('POST', 'attachments', {path: 'docs/AGENTS.md', stage: 'build'});
  assert.deepEqual(attached.profile.profiles.fast.stages.build.docs, [attached.document.id]);
  const kit = await environment.exportProfile();
  assert.equal(kit.kind, 'branch-review-workbench-profile');
  assert.equal(kit.profile.documents[0].content, '# Build instructions\n');
  const legacy = await store.getProfile();
  legacy.documents[0].content = undefined;
  const draft = await environment.dispatch('POST', 'profile/parse', {profile: legacy});
  assert.equal(draft.profile.documents[0].content, '# Build instructions\n');
  assert.deepEqual(await store.getProfile(), kit.profile);
  assert.equal((await environment.importProfile(legacy)).profile.documents[0].content, '# Build instructions\n');
  await environment.importProfile(kit);
  assert.deepEqual(await store.getProfile(), kit.profile);
});

test('records an owned workspace and verifies cleanup against the confirmed inventory', async t => {
  const {repository, local, environment} = await fixture(t);
  const prepared = await environment.prepare();
  assert.equal(prepared.prepared, true);
  const file = path.join(prepared.directories.scratch, 'test.txt');
  const sibling = path.join(repository, 'preserved.txt');
  await writeFile(file, 'initial');
  await writeFile(sibling, 'keep');
  const initial = await environment.cleanupPreview();
  assert.equal(initial.entries[0].path, 'scratch/test.txt');
  await writeFile(file, 'changed content');
  await assert.rejects(environment.cleanup({previewId: initial.previewId}), /before confirming cleanup/);
  assert.equal(await readFile(file, 'utf8'), 'changed content');
  const fresh = await environment.cleanupPreview();
  assert.equal((await environment.cleanup({previewId: fresh.previewId})).removed, 1);
  await assert.rejects(readFile(file, 'utf8'), {code: 'ENOENT'});
  assert.equal(await readFile(sibling, 'utf8'), 'keep');
  const other = createEnvironment({repository, local, projectId: 'different'});
  await assert.rejects(other.cleanupPreview(), /ownership record/);
});

async function until(callback) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await delay(50);
  }
  throw Error('The preview did not reach the expected state.');
}

test('starts a web preview, captures desktop output, and leaves external previews running', async t => {
  const {environment} = await fixture(t, {
    'index.html': '<h1>Owned preview</h1>',
    'desktop.mjs': 'console.log("desktop output"); setInterval(() => {}, 1000);'
  });
  const post = (route, args = {}) => environment.dispatch('POST', '/api/workspace/' + route, args);
  const status = () => environment.dispatch('GET', '/api/workspace/preview');
  await post('design/app-process/auto');
  const web = await until(async () => {
    const app = await status();
    return app.state === 'running' && app;
  });
  assert.equal(web.owned, true);
  assert.equal(await fetch(web.url).then(response => response.text()), '<h1>Owned preview</h1>');
  assert.equal((await post('preview/stop')).owned, false);
  assert.equal((await post('design/app-process/auto')).owned, false);
  await post('design/app-process/setup', {argv: ['desktop.mjs'], cwd: '.', url: ''});
  await post('design/app-process/start');
  await until(async () => (await status()).log.includes('desktop output'));
  assert.equal((await post('design/app-process/stop')).state, 'stopped');
  const external = http.createServer((_request, response) => response.end('external'));
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  t.after(() => external.close());
  const url = 'http://127.0.0.1:' + external.address().port;
  assert.equal((await post('preview/setup', {mode: 'external', url})).state, 'external');
  assert.equal((await post('preview/stop')).owned, false);
  assert.equal(await fetch(url).then(response => response.text()), 'external');
  await assert.rejects(post('preview/setup', {argv: ['node'], cwd: '.', url: 'https://example.invalid:8080'}), /local HTTP/);
});
