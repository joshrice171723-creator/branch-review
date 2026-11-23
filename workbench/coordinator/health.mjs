import path from 'node:path';
import {mkdir, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../environment/paths.mjs';
import {redact} from '../../jobs.mjs';

const clean = value => redact(String(value || '')).slice(0, 2000);

export async function createHealthReviewer({directory, observe, recover, repair, activate, idle, interval = 15000,
  clock = Date.now, start = true}) {
  await mkdir(directory, {recursive: true});
  const rows = await readFile(path.join(directory, 'incidents.json'), 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const row of rows) {
    if (row.state === 'repairing') {
      row.state = 'verifying';
      row.actionAt = clock();
      row.note = 'Branch Review restarted. Waiting for a fresh runtime check.';
    }
  }
  let timer, running, paused = false, action, attemptController, applying = false, lastError = '', saved, checkedAt;
  let writes = Promise.resolve();
  const session = randomUUID();
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
    for (const signal of signals) {
      const key = signal.owner + '/' + signal.id;
      seen.add(key);
      let row = rows.find(item => item.key === key && item.state !== 'recovered');
      if (row?.state === 'repairing') continue;
      if (!signal.error) {
        if (row) {
          row.state = 'recovered';
          row.verifiedAt = clock();
        }
        continue;
      }
      const error = clean(signal.error);
      if (!row) {
        row = {id: randomUUID(), key, owner: signal.owner, title: signal.title, error, state: 'detected',
          detectedAt: clock(), observations: 0, attempts: 0};
        rows.unshift(row);
      }
      if (row.error !== error) {
        row.observations = 0;
        if (row.state === 'attention') { row.state = 'detected'; row.attempts = 0; }
      }
      row.error = error;
      row.evidence = clean(signal.evidence);
      row.observations = Math.min(10, row.observations + 1);
      if (row.observations < 2 || row.state === 'attention') continue;
      if (['verifying', 'retrying'].includes(row.state) && (row.activationSession === session || clock() - row.actionAt < 60000)) continue;
      if (row.attempts >= 2) {
        row.state = 'attention';
        row.note = 'The runtime check still fails after repair.';
      } else if (!next) next = {row, signal};
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
    if (!next || action || paused || !await idle()) return;
    const {row, signal} = next;
    const quick = signal.restart && !row.attempts;
    if (!quick && rows.filter(item => item.key === row.key).flatMap(item => item.calls || [])
      .filter(time => time > clock() - 3600000).length >= 3) return;
    action = perform(row, signal, quick).catch(error => { lastError = clean(error.message); })
      .finally(() => { action = null; });
  }
  async function perform(row, signal, quick) {
    attemptController = new AbortController();
    const stop = AbortSignal.any([controller.signal, attemptController.signal]);
    try {
      row.state = 'repairing';
      row.attempts++;
      if (!quick) (row.calls ||= []).push(clock());
      await persist();
      stop.throwIfAborted();
      if (quick) {
        applying = true;
        await recover(signal);
        row.note = 'Restarted the failed process.';
      } else {
        const stillFailing = async () => {
          if (paused || stop.aborted || !await idle()) return false;
          const latest = (await observe()).find(item => item.owner + '/' + item.id === row.key);
          applying = Boolean(latest && clean(latest.error) === row.error && await idle() && !paused && !stop.aborted);
          return applying;
        };
        const owner = row.repairOwner || row.owner;
        const prior = rows.filter(item => (item.repairOwner || item.owner) === owner && item.files)
          .flatMap(item => (item.repairs || [{files: item.files, time: item.actionAt}]).map(receipt => ({
            ...receipt, patch: path.join(directory, item.id, receipt.artifact || '', 'repair.patch')
          }))).sort((a, b) => a.time - b.time);
        const artifact = randomUUID();
        const result = await repair(row, path.join(directory, row.id, artifact), stop, stillFailing, prior);
        row.note = clean(result.summary);
        if (row.files && !row.repairs) row.repairs = [{files: row.files, time: row.actionAt}];
        (row.repairs ||= []).push({files: result.files, time: clock(), artifact});
        row.files = result.files;
        row.checks = clean(result.checks);
        row.state = 'verifying';
        if ((row.repairOwner || row.owner) === 'host') {
          row.activationSession = session;
          row.note += ' Waiting for Branch Review to restart and repeat the check.';
        }
        row.actionAt = clock();
        await persist();
        await activate(row);
      }
      row.state = 'verifying';
      row.actionAt = clock();
      row.observations = 0;
    } catch (error) {
      if (!row.repairOwner && ['host', 'project'].includes(error.repairOwner) && error.repairOwner !== row.owner) {
        row.repairOwner = error.repairOwner;
        row.diagnosis = clean(error.message);
      }
      row.state = row.attempts < 2 ? 'retrying' : 'attention';
      row.actionAt = clock();
      row.note = clean(error.message);
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
  return {tick, busy: () => applying, status: () => ({error: lastError, checkedAt, incidents: structuredClone(rows)}),
    async retry(id) {
      const row = rows.find(item => item.id === id && item.state === 'attention');
      if (!row) throw Error('Select an unresolved incident that needs attention.');
      row.state = 'detected';
      row.attempts = row.observations = 0;
      row.note = 'Waiting for the next check.';
      await persist();
      return {queued: true};
    },
    suspend() {
      paused = true;
      attemptController?.abort(Error('The workspace is closing or switching projects.'));
      return () => { paused = false; };
    },
    close() { paused = true; clearTimeout(timer); controller.abort(); return Promise.all([running, action]); }};
}
