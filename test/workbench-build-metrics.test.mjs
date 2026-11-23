import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {providerSpend, visitMetrics} from '../workbench/coordinator/build-metrics.mjs';
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
  assert.equal(reportedUsage('codex', {type: 'turn.completed', usage: {input_tokens: 100}}), null);
});

test('charges reported usage and preserves cache reads and unknown calls', () => {
  assert.deepEqual(providerSpend([
    {provider: 'Codex', startedAt: 0, finishedAt: 1500, usage: {input: 100, output: 20, cached: 40}},
    {provider: 'Muse', startedAt: 5000, finishedAt: 6000},
    {provider: 'Codex', startedAt: 6000, timeoutMs: 2000},
    {key: 'checks', startedAt: 8000, finishedAt: 9000}
  ]), {tokens: 80, cached: 40, unknown: 2, milliseconds: 4500});
});

test('keeps provider budget defaults for older profiles and validates explicit limits', () => {
  const {profiles} = WorkbenchProfile.initial([]);
  const limits = (mode, stage) => WorkbenchProfile.providerLimits(profiles[mode], mode, stage);
  assert.deepEqual(limits('fast', 'planReview'), {timeoutSeconds: 120, providerTimeSeconds: 600, providerTokenLimit: 60_000});
  assert.deepEqual(limits('audited', 'build'), {timeoutSeconds: 300, providerTimeSeconds: 1800, providerTokenLimit: 180_000});
  profiles.fast.stages.planReview.timeoutSeconds = 12000;
  assert.throws(() => WorkbenchProfile.validate({version: 1, active: 'fast', documents: [], profiles}), /call time limit/);
});

test('launches a Codex evidence-only call with shell disabled and enforces its time limit', async t => {
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
    prompt: 'Review the supplied evidence.', providerOptions: {codex: {executable}}, write: true, evidenceOnly: true};
  const {text} = await runProvider(request);
  const args = JSON.parse(text);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.some((arg, index) => arg === '--disable' && args[index + 1] === 'shell_tool'));
  await assert.rejects(runProvider({...request, model: 'slow-provider', timeoutMs: 250,
    timeoutCode: 'PROVIDER_TASK_TIME_BUDGET'}), {code: 'PROVIDER_TASK_TIME_BUDGET'});
});
