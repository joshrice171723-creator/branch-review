import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {providerSpend, usageSummary, visitMetrics} from '../workbench/coordinator/build-metrics.mjs';
import {reportedUsage, runProvider} from '../workbench/coordinator/provider.mjs';
import {WorkbenchProfile} from '../workbench/profile.mjs';

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
  assert.deepEqual(reportedUsage('muse', {payload_type: 'run.terminal.completed', payload: {result: {usage: {
    inputTokens: 100, outputTokens: 20, cachedInputTokens: 30
  }}}}), {input: 100, output: 20, cached: 30});
  assert.equal(reportedUsage('codex', {type: 'turn.completed', usage: {input_tokens: 100}}), null);
});

test('counts Coordinator usage and keeps missing cache data out of uncached input', () => {
  const calls = [
    {provider:'Codex', purpose:'Coordinator recovery', startedAt:2000, finishedAt:2500, usage:{input:100, cached:70, output:15}},
    {provider:'Muse', usage:{input:20, output:2}},
    {provider:'Muse'}
  ];
  const totals = usageSummary(calls, [
    {outcome:'failed', finished:'2026-11-23T16:00:00Z'}, {started:'2026-11-23T16:00:05Z'}
  ]);
  assert.equal(totals.uncached, 30);
  assert.equal(totals.cached, 70);
  assert.equal(totals.unclassifiedInput, 20);
  assert.equal(totals.output, 17);
  assert.equal(totals.unknown, 1);
  assert.equal(totals.stoppedMs, 5000);
  assert.equal(totals.recovery[0].time.milliseconds, 500);
});

test('charges reported usage and preserves cache reads and unknown calls', () => {
  assert.deepEqual(providerSpend([
    {provider: 'Codex', startedAt: 0, finishedAt: 1500, usage: {input: 100, output: 20, cached: 40}},
    {provider: 'Muse', startedAt: 5000, finishedAt: 6000},
    {provider: 'Codex', startedAt: 6000, timeoutMs: 2000},
    {key: 'checks', startedAt: 8000, finishedAt: 9000}
  ]), {tokens: 80, cached: 40, unknown: 2, milliseconds: 4500});
});

test('loads historical provider limit fields with the configured repair loop', () => {
  const profile = WorkbenchProfile.initial([]);
  profile.profiles.fast.providerTokenLimit = 1000;
  profile.profiles.fast.providerTimeSeconds = 60;
  profile.profiles.fast.stages.planReview.timeoutSeconds = 10;
  profile.profiles.fast.stages.buildReview.limit = 4;
  const loaded = WorkbenchProfile.validate(profile);
  assert.equal(loaded.profiles.fast.stages.buildReview.limit, 4);
  assert.equal(loaded.profiles.fast.providerTokenLimit, 1000);
  assert.equal(loaded.profiles.fast.providerTimeSeconds, 60);
  assert.equal(loaded.profiles.fast.stages.planReview.timeoutSeconds, 10);
});

test('launches a Codex evidence-only call without a deadline and supports cancellation', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'branch-review-provider-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const executable = path.join(cwd, 'provider.mjs');
  await writeFile(executable,
    'const argv = process.argv.slice(2);\n' +
    'if (argv.includes("slow-provider")) setInterval(() => {}, 1000);\n' +
    'else {\n' +
    '  console.log(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: JSON.stringify(argv)}}));\n' +
    '  console.log(JSON.stringify({type: "turn.completed", usage: {input_tokens: 3, output_tokens: 2}}));\n' +
    '}\n');
  const request = {cwd, output: path.join(cwd, 'reply.txt'), stage: 'final_review', provider: 'Codex',
    prompt: 'Review the supplied evidence.', providerOptions: {codex: {executable}}, write: true, evidenceOnly: true, timeoutMs: null};
  const {text} = await runProvider(request);
  const args = JSON.parse(text);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.some((arg, index) => arg === '--disable' && args[index + 1] === 'shell_tool'));
  const controller = new AbortController();
  const pending = runProvider({...request, model: 'slow-provider', signal: controller.signal});
  setTimeout(() => controller.abort(), 250);
  await assert.rejects(pending, /cancel|abort/i);
});
