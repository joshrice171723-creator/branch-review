import assert from 'node:assert/strict';
import {test} from 'node:test';
import {visitMetrics} from '../workbench/coordinator/build-metrics.mjs';
import {reportedUsage} from '../workbench/coordinator/provider.mjs';

test('measures repeated work at a checkpoint without counting time between attempts', () => {
  const stamp = milliseconds => new Date(milliseconds).toISOString();
  const attempts = [{started: stamp(1000), finished: stamp(3000)}, {started: stamp(20_000)}];
  const visit = {id: '0', lastIndex: 1, time: 1.5};
  const metrics = [{visit: 0, provider: 'Codex', startedAt: 1600, finishedAt: 2600, usage: {input: 22, output: 3}},
    {visit: 1, provider: 'Codex', startedAt: 21_000}];
  const running = visitMetrics(visit, attempts, metrics, []);
  assert.deepEqual(running.time, {milliseconds: 1500, runningSince: 20_000});
  assert.deepEqual(running.steps['1'], {milliseconds: 1000, runningSince: 21_000});
  assert.equal(running.providers[1].usage, null);
  const completed = visitMetrics({...visit, next: {time: 23}}, attempts, metrics, []);
  assert.deepEqual(completed.time, {milliseconds: 4500, runningSince: null});
});

test('accepts only reported provider counts and preserves cache and reasoning subsets', () => {
  assert.deepEqual(reportedUsage('codex', {type: 'turn.completed', usage: {
    input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, reasoning_output_tokens: 10
  }}), {input: 100, output: 20, cached: 40, reasoning: 10});
  assert.deepEqual(reportedUsage('claude', {type: 'result', usage: {
    input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 5
  }}), {input: 65, output: 0, cached: 50, cacheWrite: 5});
  assert.equal(reportedUsage('muse', {payload_type: 'run.terminal.completed', payload: {text: 'Done'}}), null);
  assert.equal(reportedUsage('codex', {type: 'turn.completed', usage: {input_tokens: 100}}), null);
});
