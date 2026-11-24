import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {openStageMcp, selectStageTools, workspaceMcp} from '../workbench/mcp.mjs';
import {inspectRun} from '../workbench/history.mjs';
import {auditSchema} from '../workbench/coordinator/provider.mjs';

test('scope selects relevant tools and an explicit empty selection allows none', () => {
  assert.deepEqual(selectStageTools('build_review', undefined, {scope: 'Check a new endpoint and its rubric.'}),
    ['quality_routes', 'quality_status']);
  assert.deepEqual(selectStageTools('build_review', undefined, {scope: 'Check an endpoint.', evidenceOnly: true}), []);
  assert.deepEqual(selectStageTools('plan', [], {scope: 'Prepare the environment.'}), []);
  assert.deepEqual(selectStageTools('plan', ['get_profile', 'clean_environment', 'find_local_projects']), ['get_profile']);
});

test('the stage endpoint only lists and runs selected read tools', async t => {
  const calls = [];
  const session = await openStageMcp(async (name, args) => {
    calls.push([name, args]);
    return {name};
  }, {}, ['quality_routes', 'get_profile', 'clean_environment']);
  t.after(() => session.close());
  const rpc = async (method, params) => fetch(session.url, {method: 'POST', body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method, params
  })}).then(response => response.json());
  const listed = (await rpc('tools/list')).result.tools;
  assert.deepEqual(listed.map(tool => tool.name), ['get_profile', 'quality_routes']);
  assert.equal(listed[0].annotations.readOnlyHint, true);
  assert.equal(listed[1].annotations, undefined);
  assert.ok((await rpc('tools/call', {name: 'inspect_run'})).error);
  assert.ok((await rpc('tools/call', {name: 'clean_environment'})).error);
  assert.ok((await rpc('tools/call', {name: 'quality_routes', arguments: {runtime: true}})).error);
  assert.equal((await rpc('tools/call', {name: 'get_profile'})).result.structuredContent.name, 'get_profile');
  assert.deepEqual(calls, [['get_profile', {}]]);
});

test('local project discovery requires the host token and stays outside stage tools', async () => {
  const call = async (name, values) => {
    assert.equal(name, 'find_local_projects');
    return {projects: [values.query]};
  };
  const params = {name: 'find_local_projects', arguments: {query: 'Find Orchard Lantern'}};
  const request = {jsonrpc: '2.0', id: 1, method: 'tools/call', params};
  const settings = {call, getProfile: async () => ({})};
  assert.ok((await workspaceMcp(request, {...settings, verified: false})).error);
  assert.ok((await workspaceMcp(request, {...settings, verified: true, stageTools: ['find_local_projects']})).error);
  const accepted = await workspaceMcp(request, {...settings, verified: true});
  assert.deepEqual(accepted.result.structuredContent, {projects: [params.arguments.query]});
});

test('run inspection accepts a noncanonical project path', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branch-review-run-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const id = '20261124T083106348000-3e537a19';
  await mkdir(path.join(root, '.harness', 'tasks', id), {recursive:true});
  await writeFile(path.join(root, '.harness', 'active_task'), id);
  const result = await inspectRun(root + '/.');
  assert.equal(result.active, id);
  assert.equal(result.run.id, id);
});

test('a large run exposes later checks through paged stage inspection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branch-review-run-pages-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const id = '20261124T083106348000-3e537a19', base = path.join(root, '.harness', 'tasks', id);
  await mkdir(path.join(base, 'audits'), {recursive:true});
  await mkdir(path.join(base, 'results', 'unit', 'after', 'one'), {recursive:true});
  await writeFile(path.join(base, 'audits', 'long.json'), JSON.stringify({reason:'Long evidence. '.repeat(100)}));
  await writeFile(path.join(base, 'results', 'unit', 'after', 'one', 'result.json'), JSON.stringify({check:'unit',phase:'after',exit_code:0}));
  await writeFile(path.join(base, 'events.jsonl'), [
    ...Array.from({length:25}, () => JSON.stringify({path:'audits/long.json'})),
    JSON.stringify({path:'results/unit/after/one/result.json'})
  ].join('\n'));
  const session = await openStageMcp((name, values) => inspectRun(root, values.runId, values), {}, ['inspect_run']);
  t.after(() => session.close());
  const call = args => fetch(session.url, {method:'POST', body:JSON.stringify({jsonrpc:'2.0',id:1,
    method:'tools/call',params:{name:'inspect_run',arguments:{runId:id,...args}}})}).then(response=>response.json());
  assert.equal((await call({})).result.structuredContent.truncated, true);
  const checks = (await call({section:'checks'})).result.structuredContent;
  assert.equal(checks.run.entries[0].verdict, 'pass');
  assert.match(checks.run.entries[0].source, /result\.json$/);
  assert.equal(checks.run.nextOffset, null);
  const page = (await call({section:'events',offset:5,limit:2})).result.structuredContent;
  assert.equal(page.run.entries.length,2);assert.equal(page.run.nextOffset,7);assert.equal(page.run.total,26);
  assert.equal(page.run.entries[0].textTruncated,true);
});

test('audit output limits criterion IDs to the selected rubric', () => {
  const schema = auditSchema('build_review', [{id:'correctness'}, {id:'performance'}]);
  assert.deepEqual(schema.properties.criteria.items.properties.id.enum, ['correctness', 'performance']);
});
