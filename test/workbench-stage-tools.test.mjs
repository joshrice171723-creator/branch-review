import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openStageMcp, selectStageTools, workspaceMcp} from '../workbench/mcp.mjs';

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
  assert.deepEqual((await rpc('tools/list')).result.tools.map(tool => tool.name), ['get_profile', 'quality_routes']);
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
