import path from 'node:path';
import {mkdir, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../environment/paths.mjs';
import {redact} from '../../jobs.mjs';

const maxAttempts = 5;
const clean = value => redact(String(value || '')).slice(0, 2000);

export async function createHealthReviewer({directory, observe, repair, restartRequired, idle, interval = 3000,
  clock = Date.now, start = true}) {
  await mkdir(directory, {recursive: true});
  const savedRows = await readFile(path.join(directory, 'incidents.json'), 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const rows = savedRows.filter(row => row.owner === 'host' && row.repairOwner !== 'project');
  function finishAttempt(row, outcome, detail) {
    const attempt = row.history?.at(-1);
    if (attempt) Object.assign(attempt, {outcome, detail: clean(detail)});
  }
  function failed(row, detail) {
    row.state = row.attempts >= maxAttempts ? 'attention' : 'retrying';
    row.actionAt = clock();
    row.note = clean(detail);
    finishAttempt(row, 'failed', detail);
  }
  for (const row of rows) {
    if (row.state === 'repairing') failed(row, 'Branch Review closed before the attempt finished.');
    if (row.state === 'restart-required') {
      row.state = 'verifying';
      row.observations = 0;
      row.note = 'Branch Review restarted. Waiting for a fresh runtime check.';
    }
  }
  let timer, running, paused = false, action, attemptController, applying = false, lastError = '', saved, checkedAt;
  let writes = Promise.resolve();
  const controller = new AbortController();
  const persist = async () => {
    const json = JSON.stringify(rows);
    if (saved !== json) {
      writes = writes.catch(() => {}).then(() => atomicJson(directory, 'incidents.json', JSON.parse(json)));
      saved = json;
    }
    await writes.catch(error => { saved = undefined; throw error; });
  };
  async function run() {
    if (paused || controller.signal.aborted) return;
    const signals = await observe();
    checkedAt = clock();
    const seen = new Set();
    let next;
    for (const signal of signals.filter(item => item.owner === 'host')) {
      const key = signal.owner + '/' + signal.id;
      seen.add(key);
      let row = rows.find(item => item.key === key && item.state !== 'recovered');
      if (['repairing', 'restart-required'].includes(row?.state)) continue;
      if (!signal.error) {
        if (row) {
          row.state = 'recovered';
          row.verifiedAt = clock();
          finishAttempt(row, 'verified', 'The runtime check passed.');
        }
        continue;
      }
      const error = clean(signal.error);
      if (!row) {
        row = {id: randomUUID(), key, owner: signal.owner, title: signal.title, error, state: 'detected',
          detectedAt: clock(), observations: 0, attempts: 0};
        rows.unshift(row);
      }
      if (row.error !== error) row.observations = 0;
      row.error = error;
      row.evidence = clean(signal.evidence);
      row.observations = Math.min(10, row.observations + 1);
      if (row.observations < 2 || row.state === 'attention') continue;
      if (row.state === 'verifying') failed(row, 'The runtime check still fails after restart. ' + error);
      if (row.state === 'retrying' && clock() - row.actionAt < interval * 2) continue;
      if (row.attempts >= maxAttempts) row.state = 'attention';
      else if (!next) next = {row, signal};
    }
    for (const row of rows) {
      if (!seen.has(row.key) && row.state === 'detected') row.observations = 0;
    }
    while (rows.length > 80) {
      const old = rows.findLastIndex(row => row.state === 'recovered');
      if (old < 0) break;
      rows.splice(old, 1);
    }
    await persist();
    if (!next || action || paused || rows.some(row => row.state === 'restart-required') || !await idle()) return;
    action = perform(next.row, next.signal.restart && !next.row.attempts)
      .catch(error => { lastError = clean(error.message); }).finally(() => { action = null; });
  }
  async function perform(row, restartOnly) {
    attemptController = new AbortController();
    const stop = AbortSignal.any([controller.signal, attemptController.signal]);
    try {
      row.state = 'repairing';
      row.attempts++;
      const attempt = {number: row.attempts, approach: restartOnly ? 'Restart Branch Review' : 'Investigate and repair Branch Review',
        failure: row.error, outcome: 'running'};
      (row.history ||= []).push(attempt);
      row.note = restartOnly ? 'A restart can recover the window.' :
        'Investigating the failure and checking a repair in an isolated copy.';
      await persist();
      stop.throwIfAborted();
      if (!restartOnly) {
        const stillFailing = async () => {
          if (paused || stop.aborted || !await idle()) return false;
          const latest = (await observe()).find(item => item.owner + '/' + item.id === row.key);
          applying = Boolean(latest && clean(latest.error) === row.error && await idle() && !paused && !stop.aborted);
          return applying;
        };
        const prior = rows.filter(item => item.files).flatMap(item =>
          (item.repairs || [{files: item.files, time: item.actionAt}]).map(receipt => ({
            ...receipt, patch: path.join(directory, item.id, receipt.artifact || '', 'repair.patch')
          }))).sort((a, b) => a.time - b.time);
        const artifact = randomUUID();
        const result = await repair(row, path.join(directory, row.id, artifact), stop, stillFailing, prior);
        row.note = clean(result.summary);
        attempt.approach = clean(result.summary);
        if (row.files && !row.repairs) row.repairs = [{files: row.files, time: row.actionAt}];
        (row.repairs ||= []).push({files: result.files, time: clock(), artifact});
        row.files = result.files;
        row.checks = attempt.checks = clean(result.checks);
      }
      row.state = 'restart-required';
      row.observations = 0;
      row.actionAt = clock();
      finishAttempt(row, 'restart-required', row.note);
      await persist();
      restartRequired?.(row);
    } catch (error) {
      if (typeof error.checks === 'string') row.history.at(-1).checks = clean(error.checks);
      failed(row, error.message);
    } finally {
      try { await persist(); }
      finally { applying = false; attemptController = null; }
    }
  }
  async function tick(waitForRepair = true) {
    if (!running) running = run().then(() => { lastError = ''; }, error => { lastError = clean(error.message); })
      .finally(() => { running = null; });
    await running;
    if (waitForRepair) await action;
  }
  function schedule() {
    if (controller.signal.aborted) return;
    timer = setTimeout(async () => { await tick(false); schedule(); }, interval);
    timer.unref();
  }
  if (start) schedule();
  return {tick, busy: () => applying,
    status: () => ({error: lastError, checkedAt, maxAttempts, incidents: structuredClone(rows)}),
    suspend() {
      paused = true;
      attemptController?.abort(Error('The workspace is closing or switching projects.'));
      return () => { paused = false; };
    },
    close() { paused = true; clearTimeout(timer); controller.abort(); return Promise.all([running, action]); }};
}
