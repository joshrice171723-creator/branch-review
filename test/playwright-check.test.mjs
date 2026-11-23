import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {playwrightCheck, verifyBrowserPreview} from '../workbench/playwright-check.mjs';

test('recognizes a Playwright npm script with a configurable base URL', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'br-browser-check-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({scripts: {
    'test:ui': 'playwright test', custom: 'playwright test --output=custom', compound: 'playwright test && node cleanup.js'
  }}));
  await writeFile(path.join(root, 'playwright.config.js'), 'module.exports={use:{baseURL:process.env.BASE_URL}};');
  assert.deepEqual(await playwrightCheck(['npm', 'run', 'test:ui'], root), {npm: true, managedUrl: true});
  assert.equal(await playwrightCheck(['npm', 'run', 'custom'], root), null);
  assert.equal(await playwrightCheck(['npm', 'run', 'compound'], root), null);
});

test('probes the exact base URL used by the check and reports HTTP failures', async () => {
  const target = 'http://127.0.0.1:59800/';
  const verify = status => verifyBrowserPreview(target, undefined, async (url, options) => {
    assert.equal(url, target);
    assert.equal(options.redirect, 'manual');
    return new Response('', {status});
  });
  assert.equal(await verify(200), target);
  await assert.rejects(verify(500), /59800\/ returned HTTP 500/);
  await assert.rejects(verifyBrowserPreview('https://example.com'), /local project preview/);
});
test('moves recorded browser results and reruns the pinned baseline with isolated output', async t => {
  const {execFileSync} = await import('node:child_process');
  const {mkdir, readFile} = await import('node:fs/promises');
  const {createServer} = await import('node:http');
  const {createStore} = await import('../workbench/store.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'br-browser-baseline-'));
  t.after(() => rm(temp, {recursive: true, force: true, maxRetries: 3}));
  const root = path.join(temp, 'source');
  await mkdir(root);
  const git = (...args) => execFileSync('git', args, {cwd: root, windowsHide: true});
  await writeFile(path.join(root, '.gitignore'), '.harness/\nnode_modules/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({scripts: {'test:ui': 'playwright test'}}));
  await writeFile(path.join(root, 'playwright.config.js'), 'module.exports={use:{baseURL:process.env.BASE_URL}};');
  await writeFile(path.join(root, 'fake.cjs'), [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const dest = args.includes('--output') ? args[args.indexOf('--output') + 1] : 'test-results';",
    "fs.mkdirSync(dest, {recursive:true});",
    "fs.writeFileSync(require('node:path').join(dest, 'receipt.txt'), process.env.BASE_URL || 'legacy');",
    "fs.writeFileSync(require('node:path').join(dest, '.last-run.json'), JSON.stringify({status:'failed', failedTests:['fixture']}));"
  ].join('\n'));
  await mkdir(path.join(root, 'node_modules', '.bin'), {recursive: true});
  await writeFile(path.join(root, 'node_modules', '.bin', 'playwright.cmd'), '@node fake.cjs %*\r\n');
  await writeFile(path.join(root, 'node_modules', '.bin', 'playwright'), '#!/bin/sh\nexec node fake.cjs "$@"\n', {mode: 0o755});
  git('init', '-q', '-b', 'working');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture');
  const baselineMarker = JSON.stringify({status: 'passed', failedTests: []}, null, 2);
  await mkdir(path.join(root, 'test-results'));
  await writeFile(path.join(root, 'test-results', '.last-run.json'), baselineMarker);
  const legacy = createStore(root);
  const check = {name: 'browser', cwd: '.', argv: ['npm', 'run', 'test:ui'], required: true, benchmark: false};
  await legacy.setProfile({...await legacy.getProfile(), checks: [check]});
  const {task} = await legacy.startTask({mode: 'build', action: 'Browser check', scope: 'Exercise the browser check.',
    channel: 'form', decisions: {scope_confirmed: 'confirmed', code_changes: 'allow_scoped',
      migrations: 'deny', dependencies: 'deny', engine_integration: 'confirmed'}});
  await legacy.freeze(task.id);
  const first = await legacy.runChecks(task.id, {phase: 'baseline'});
  assert.equal(first.checks[0].source_changed, true, first.checks[0].spawn_error);
  const server = createServer((_request, response) => response.end('ready'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const store = createStore(root, {browserPreview: () => ({url}), browserArtifacts: path.join(temp, 'artifacts')});
  const directory = await store.restoreBrowserBaseline(task.id);
  assert.equal(await readFile(path.join(directory, 'receipt.txt'), 'utf8'), 'legacy');
  assert.equal(await readFile(path.join(root, 'test-results', '.last-run.json'), 'utf8'), baselineMarker);
  const retry = await store.runChecks(task.id, {phase: 'baseline'});
  const [receipt] = retry.checks;
  assert.equal(retry.verdict, 'pass', receipt.spawn_error);
  assert.equal(receipt.source_changed, false);
  assert.equal(receipt.browser.base_url, url);
  assert.equal(await readFile(path.join(receipt.browser.output, 'results', 'receipt.txt'), 'utf8'), url);
});
