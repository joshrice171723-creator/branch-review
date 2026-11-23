import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuality, qualityTools, validateQuality} from '../workbench/quality.mjs';
import {parseQualityJSON, stringifyQuality} from '../workbench/quality/schema.mjs';

async function project(t, samples) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-quality-test-'));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 3}));
  const git = (...args) => execFileSync('git', args, {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
    .toString().trim();
  const put = async (name, content) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, content);
  };
  const commit = message => {
    git('add', '-A');
    git('-c', 'user.name=Quality', '-c', 'user.email=quality@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  await put('.gitignore', '.harness/\n');
  await Promise.all(Object.entries(samples).map(([name, source]) => put(name, source)));
  const first = commit('Add Quality fixture');
  return {root, first, commit, put, quality: createQuality({repository: root})};
}

const measure = [
  "import {existsSync,readFileSync,writeFileSync} from 'node:fs';",
  "if (existsSync('scratch.txt')) throw Error('Reset did not run');",
  "writeFileSync('scratch.txt','created in export');",
  "console.log(JSON.stringify({metrics:{rows:Number(readFileSync('value.txt','utf8'))}}));"
].join('\n');
const reset = "require('node:fs').rmSync('scratch.txt',{force:true})";
const benchmark = {
  schema_version: 1,
  checks: [{id: 'measure', name: 'Measure rows', argv: ['node', 'measure.mjs'], required: true, input_paths: ['value.txt']},
    {id: 'check', name: 'Check isolation', argv: ['node', '-e',
      "if(require('node:fs').existsSync('scratch.txt'))process.exit(1);require('node:fs').writeFileSync('scratch.txt','isolated')"],
      required: true}],
  benchmarks: [{
    id: 'rows', name: 'Rows', check_id: 'measure', fixtures: [{path: 'fixture.txt', description: 'Fixed input'}],
    scripts: ['measure.mjs'], repetitions: 2, metrics: [{id: 'rows', unit: 'rows'}],
    thresholds: [{metric: 'rows', op: 'lte', value: 15}], reset: {argv: ['node', '-e', reset]}
  }],
  rubrics: []
};

test('trials pin committed files, check measurements, and require human publication', async t => {
  const {root, quality, first, put, commit} = await project(t, {
    'measure.mjs': measure, 'fixture.txt': 'fixed input', 'value.txt': '10'
  });
  const {draft: initial} = await quality.dispatch('GET', 'quality');
  const payload = {definition: benchmark, base_revision: null, expected_revision: initial.revision};
  const verdicts = await Promise.allSettled([
    quality.mcp('quality_draft', payload), quality.dispatch('POST', 'quality/draft', payload)
  ]);
  assert.equal(verdicts.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(verdicts.find(result => result.status === 'rejected').reason.message, /draft changed/);
  const draft = verdicts.find(result => result.status === 'fulfilled').value;
  assert.equal(draft.actor, verdicts[0].status === 'fulfilled' ? 'agent' : 'human');
  assert.equal(draft.revision, validateQuality(benchmark).revision);

  await put('value.txt', '25');
  const second = commit('Add failing control');
  await put('value.txt', '999');
  const trial = await quality.dispatch('POST', 'quality/trial', {revision: draft.revision, refs: [first, second]});
  assert.equal(trial.status, 'failed', JSON.stringify(trial.refs));
  assert.deepEqual(trial.refs.map(item => [item.sha, item.status]), [[first, 'passed'], [second, 'failed']]);
  const firstBenchmark = trial.refs[0].benchmarks[0];
  assert.equal(firstBenchmark.fixtures[0].sha256, createHash('sha256').update('fixed input').digest('hex'));
  assert.equal(firstBenchmark.metrics[0].unit, 'rows');
  assert.deepEqual(firstBenchmark.metrics[0].samples, [10, 10]);
  assert.match(firstBenchmark.samples[0].command.stdout, /metrics/);
  assert.equal(firstBenchmark.samples[0].reset.status, 'passed');
  assert.equal(trial.refs[1].benchmarks[0].thresholds[0].passed, false);
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), '999');
  await assert.rejects(readFile(path.join(root, 'scratch.txt')), {code: 'ENOENT'});
  assert.equal(await quality.pin(), null);
  assert.equal(qualityTools.some(tool => tool.name === 'quality_publish'), false);
  await assert.rejects(quality.mcp('quality_publish', {}), /Unknown Quality tool/);

  const publication = {revision: draft.revision, trial_id: trial.id};
  await assert.rejects(quality.dispatch('POST', 'quality/publish', publication), /Confirm any failed results/);
  const published = await quality.dispatch('POST', 'quality/publish', {...publication, allow_failed: true});
  assert.deepEqual(await quality.dispatch('GET', 'quality/version?id=' + trial.id), published);
  assert.deepEqual(await quality.dispatch('GET', 'quality/evidence?id=' + trial.id), trial);
  assert.deepEqual(await quality.pin(), published);
  const report = await quality.mcp('quality_evidence', {id: trial.id});
  assert.equal(report.publication.reviewer, 'human');
  assert.doesNotMatch(JSON.stringify(report), /stdout|stderr|reset/);
  const current = await quality.dispatch('GET', 'quality');
  assert.equal(current.draft.base_revision, published.revision);
  assert.equal(current.trials[0].refs[0].checks, undefined);
  await assert.rejects(quality.mcp('quality_trial', {revision: published.revision, refs: [first]}), /committed policy/);
  commit('Publish Quality');
  assert.equal((await quality.mcp('quality_trial', {revision: published.revision, refs: [first]})).status, 'passed');
});

test('incompatible fixtures prevent publication and task pins reject changed sources', async t => {
  const files = {'measure.mjs': measure, 'fixture.txt': 'fixed input', 'value.txt': '10'};
  const {quality, first, put, commit} = await project(t, files);
  const {draft: initial} = await quality.dispatch('GET', 'quality');
  const draft = await quality.dispatch('POST', 'quality/draft', {definition: benchmark, expected_revision: initial.revision});
  await put('fixture.txt', 'changed input');
  const second = commit('Change benchmark fixture');
  const failed = await quality.dispatch('POST', 'quality/trial', {revision: draft.revision, refs: [first, second]});
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /fixtures or declared scripts differ/);
  await assert.rejects(quality.dispatch('POST', 'quality/publish',
    {revision: draft.revision, trial_id: failed.id, allow_failed: true}), /completed trial/);
  const trial = await quality.dispatch('POST', 'quality/trial', {revision: draft.revision, refs: [first]});
  const approved = await quality.dispatch('POST', 'quality/publish', {revision: draft.revision, trial_id: trial.id});
  const hashes = Object.fromEntries(Object.entries(files).map(([name, text]) =>
    [name, createHash('sha256').update(text).digest('hex')]));
  await assert.rejects(quality.taskCheck({policy: approved, check: 'measure', files: hashes}),
    /Source changed before the Quality check: fixture.txt/);
  await put('fixture.txt', files['fixture.txt']);
  const receipt = await quality.taskCheck({policy: approved, check: 'measure', files: hashes});
  assert.equal(receipt.status, 'passed');
});

test('Prepare links tracked HTTP, IPC, Rails, and manual sources to the current draft', async t => {
  const server = [
    "import {writeRecord} from './storage.mjs';",
    "const actions = new Set(['/api/default']);",
    "actions.add('/api/record');",
    "async function mutate(endpoint) {",
    "  if (endpoint === '/api/record') return await writeRecord();",
    "  return null;",
    "}",
    "http.createServer(async (req, res) => {",
    "  if (req.method === 'POST' && actions.has(url.pathname)) return await mutate(url.pathname);",
    "});"
  ].join('\n');
  const {quality, first, put, commit} = await project(t, {
    'server.mjs': server,
    'storage.mjs': "export async function writeRecord() {\n  return store.query('INSERT INTO audit VALUES (1)');\n}",
    'desktop/channels.cjs': "const channels = {load: 'review:load'};\nmodule.exports = {channels};",
    'desktop/main.cjs': [
      "const {channels} = require('./channels.cjs');",
      "ipcMain.handle(channels.load, async () => await store.findOne());",
      "ipcMain.on('review:closed', async () => await store.save());"
    ].join('\n'),
    'test/record.test.mjs': "import test from 'node:test';\nconst route='/api/record';",
    'config/application.rb': 'module Example; class Application < Rails::Application; end; end',
    'config/routes.rb': "Rails.application.routes.draw do\n  namespace :staff do\n    resources :orders, only: %i[index] do\n      resources :lines, only: %i[show]\n    end\n  end\nend",
    'app/controllers/staff/lines_controller.rb': "class Staff::LinesController < ApplicationController\n  def show\n    LoadLine.call(params[:id])\n  end\nend",
    'app/services/load_line.rb': "class LoadLine\n  def self.call(id)\n    LineItem.find(id)\n  end\nend",
    'routes.conf': 'GET /reports/custom reports#index'
  });
  await put('untracked.mjs', "router.get('/untracked',target);");
  const catalog = await quality.dispatch('GET', 'quality/routes');
  const route = (method, path) => catalog.routes.find(row => row.method === method && row.path === path);
  const prepare = async data => {
    const {draft} = await quality.dispatch('GET', 'quality');
    return quality.dispatch('POST', 'quality/prepare', {...data, base_revision: draft.base_revision, expected_revision: draft.revision});
  };
  assert.equal(route('GET', '/untracked'), undefined);
  assert.deepEqual(catalog.rails_apps, ['.']);
  assert.equal(route('POST', '/staff/orders'), undefined);
  const http = route('POST', '/api/record');
  assert.deepEqual(http.source, {path: 'server.mjs', line: 3});
  const prepared = await prepare({route_id: http.id});
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.trace.sites.find(item => item.path === 'storage.mjs'), {
    path: 'storage.mjs', line: 2, operation: 'query/data access candidate: store.query', boundary: 'writeRecord'
  });
  assert.deepEqual(prepared.trace.suggested_checks[0].argv, ['node', '--test', 'test/record.test.mjs']);
  assert.deepEqual(prepared.draft.definition.checks[0].phases, ['after']);
  assert.deepEqual(prepared.draft.definition.checks[0].argv.slice(0, 2), ['node', '-e']);
  const positive = await quality.dispatch('POST', 'quality/trial', {revision: prepared.draft.revision, refs: [first]});
  assert.equal(positive.status, 'passed');
  await put('server.mjs', server.replace("actions.add('/api/record');", ''));
  const removed = commit('Remove dispatch entry');
  const negative = await quality.dispatch('POST', 'quality/trial', {revision: prepared.draft.revision, refs: [removed]});
  assert.equal(negative.status, 'failed');
  await put('server.mjs', server);

  const edited = prepared.draft.definition;
  edited.checks[0].name = 'Edited by reviewer';
  await quality.dispatch('POST', 'quality/draft', {definition: edited, expected_revision: prepared.draft.revision});
  const again = await prepare({route_id: http.id});
  assert.equal(again.draft.definition.checks[0].name, 'Edited by reviewer');
  const ipc = await prepare({route_id: route('IPC', 'review:load').id});
  assert.equal(ipc.route.transport, 'ipc');
  assert.ok(ipc.trace.sites.some(item => item.operation.endsWith('store.findOne')));
  const rails = await prepare({route_id: route('GET', '/staff/orders/:order_id/lines/:id').id});
  assert.ok(rails.trace.sites.some(item => item.operation.endsWith('LineItem.find')));
  assert.ok(rails.trace.boundaries.some(item => item.path === 'app/services/load_line.rb'));
  const manual = await prepare({method: 'GET', path: '/reports/custom', source_path: 'routes.conf'});
  assert.equal(manual.status, 'prepared');
  assert.match(manual.trace.gaps.join(' '), /unverified/);
  const unresolved = await prepare({method: 'GET', path: '/not-found'});
  assert.equal(unresolved.status, 'needs_source');
  assert.equal(unresolved.draft, null);
});

test('legacy definitions retain Unicode and fractional threshold revision hashes', () => {
  const policy = parseQualityJSON(JSON.stringify(benchmark)
    .replace('Measure rows', 'Measure métrics 📏').replace('"value":15', '"value":15.0'));
  const locked = validateQuality(policy);
  assert.equal(locked.revision, validateQuality(parseQualityJSON(stringifyQuality(locked.definition))).revision);
  assert.match(stringifyQuality(locked.definition), /"value": 15\.0/);
});
