import assert from 'node:assert/strict';
import test from 'node:test';
import diagnostics from '../desktop/runtime-diagnostics.cjs';
import {observeWorkspace} from '../workbench/coordinator/runtime-probes.mjs';
import {coordinatorTools, workspaceMcp} from '../workbench/mcp.mjs';

test('a broken preview observer does not hide a failed workspace action', async () => {
  const desktop = diagnostics.createRuntimeDiagnostics();
  const reports = [];
  desktop.onOperationFailure = signal => reports.push(signal);
  const failure = Error('Unexpected fixture response');
  await desktop.operation('Load settings', 'project A', failure, 'GET /api/project-settings');
  await desktop.operation('Load settings', 'project B');
  const observe = () => observeWorkspace(desktop, () => { throw failure; });
  const events = await observe();
  const issue = events.find(signal => signal.error === failure.message);
  assert.match(issue.id, /^operation:[a-f0-9]{64}$/);
  assert.equal(issue.id, reports[0].id);
  assert.equal(events.filter(signal => signal.error).length, 1);
  assert.equal((await observe()).find(signal => signal.id === issue.id).evidence, issue.evidence);
  await desktop.operation('Load settings', 'project A');
  const restored = await observe();
  assert.equal(restored.find(signal => signal.id === issue.id).error, '');
  assert.equal(restored.find(signal => signal.id === 'preview-observer').error, failure.message);
});

test('Coordinator can restore managed setup while build stage tool permissions still apply', async () => {
  const called = [];
  const request = {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'prepare_environment',arguments:{}}};
  const context = {call: async name => {called.push(name); return {prepared:true};}, getProfile: async () => ({})};
  const chat = {...context,stageTools:coordinatorTools(false),verified:true,coordinatorChat:true};
  assert.deepEqual((await workspaceMcp(request,chat)).result.structuredContent, {prepared:true});
  assert.equal((await workspaceMcp(request,{...chat,coordinatorChat:false})).error.code, -32602);
  assert.equal((await workspaceMcp(request,{...chat,stageTools:coordinatorTools(true)})).error.code, -32602);
  assert.deepEqual(called,['prepare_environment']);
});
