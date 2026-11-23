import assert from 'node:assert/strict';
import test from 'node:test';
import {runProtectedChecks} from '../workbench/coordinator/audit.mjs';

const expected = {snapshot_sha256: 'before', head: 'commit', branch: 'working', index_sha256: 'index', files: {'src.js': 'before'}};
const modified = {...expected, snapshot_sha256: 'after', files: {'src.js': 'after', 'output.log': 'new'}};

test('retries once after the original checkout returns', async () => {
  const snapshots = [expected, modified, expected, expected];
  const reports = [];
  let calls = 0;
  const output = await runProtectedChecks({
    read: () => snapshots.shift(), wait: async () => {}, signal: new AbortController().signal,
    report: message => reports.push(message),
    run: () => ({checks: [{source_changed: ++calls === 1}], verdict: calls === 1 ? 'fail' : 'pass'})
  });
  assert.equal(calls, 2);
  assert.equal(output.result.verdict, 'pass');
  assert.match(reports.at(-1), /Retrying checks once/);
});

test('reports persistent edits and a branch switch without running another check', async () => {
  let calls = 0;
  let reads = 0;
  const output = await runProtectedChecks({
    read: () => reads++ ? {...modified, branch: 'other'} : expected,
    wait: async () => {}, report: async () => {}, signal: new AbortController().signal,
    run: () => { calls++; return {checks: [], verdict: 'fail'}; }
  });
  assert.equal(calls, 1);
  assert.match(output.blocked, /branch, src.js, output.log/);
});
