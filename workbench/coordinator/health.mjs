import path from 'node:path';
import {mkdir, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../environment/paths.mjs';
import {redact} from '../../jobs.mjs';
import {healthRegression} from './health-regression.mjs';

const maxAttempts = 5;
const clean = value => redact(String(value || '')).slice(0, 2000);
const evidenceText = value => redact(String(value || ''));
const legacyComparisonActions = new Map([
  ['Fetch origin and set its default branch before reviewing this repository.', 'Configure the origin remote and fetch its default branch.'],
  ['This is the first commit. Choose another comparison baseline.', 'Choose another branch or comparison baseline.']
]);

export async function createHealthReviewer({directory, workspace, observe, repair, recoverProject, verifyRegression, restartRequired, idle, interval = 3000,
  clock = Date.now, start = true}) {
  await mkdir(directory, {recursive: true});
  const savedRows = await readFile(path.join(directory, 'incidents.json'), 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const rows = savedRows.filter(row => row.owner === 'host' || row.owner === 'project');
  const active = row => (!workspace || !(row.workspace || row.scope) || (row.workspace || row.scope) === workspace) &&
    (row.owner === 'host' && row.repairOwner !== 'project' || recoverProject && row.owner === 'project');
  const currentRows = () => rows.filter(active);
  const signalKey = signal => signal.owner + '/' + (signal.scope ? signal.scope + '/' : '') + signal.id;
  const fresh = (signal, row) => signal.occurredAt == null || signal.occurredAt >= (row.observationAfter ?? row.detectedAt);
  function finishAttempt(row, outcome, detail) {
    const attempt = row.history?.at(-1);
    if (attempt) Object.assign(attempt, {outcome, detail: clean(detail)});
  }
  function failed(row, detail) {
    row.state = row.attempts >= maxAttempts ? 'attention' : 'retrying';
    row.actionAt = clock();
    row.note = clean(detail);
    row.nextAction = row.state === 'attention' ? 'Open Health to see what Coordinator tried.' : '';
    finishAttempt(row, 'failed', detail);
  }
  for (const row of currentRows()) {
    try { row.regression = healthRegression(row.regression); }
    catch { row.regression = null; }
    const comparisonAction = row.title === 'Comparison' && !row.files && legacyComparisonActions.get(row.error);
    if (comparisonAction && ['detected', 'repairing', 'retrying', 'attention'].includes(row.state)) {
      row.state = 'attention';
      row.note = row.error;
      row.nextAction = comparisonAction;
      finishAttempt(row, 'needs-action', row.note);
      continue;
    }
    if (row.state === 'repairing') failed(row, 'Branch Review closed before the attempt finished.');
    if (row.owner === 'project' && row.state === 'attention' && row.attempts < maxAttempts &&
        /(?:ask|request|tell).*coordinator|coordinator.*(?:ask|request|tell)/i.test(row.nextAction || '')) {
      row.state = 'retrying';
      row.actionAt = clock() - interval * 2;
      row.note = 'Coordinator is continuing the preview repair.';
      row.nextAction = '';
    }
    if (row.state === 'restart-required') {
      row.state = row.reported ? 'awaiting-observation' : 'verifying';
      row.observations = 0;
      row.observationAfter = clock();
      row.note = row.reported ? 'The repair loaded. Coordinator is checking ' + row.title + '.' :
        'Branch Review restarted. Waiting for a fresh runtime check.';
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
  async function report({id, title, issue, request, regression, nextAction, workspace: reportedWorkspace}) {
    const key = 'host/' + (id ? clean(id) : 'report:' + clean(title).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    let row = rows.find(item => item.key === key && item.workspace === reportedWorkspace && item.state !== 'recovered');
    if (!row) {
      row = {id: randomUUID(), key, owner: 'host', workspace: reportedWorkspace, title: clean(title), error: clean(issue),
        evidence: clean(request), state: 'detected', reported: true, detectedAt: clock(), observations: 1, attempts: 0};
      rows.unshift(row);
    } else if (['verifying', 'awaiting-observation'].includes(row.state)) {
      failed(row, 'The user reported the issue again after restart. ' + clean(issue));
      row.error = clean(issue);
      row.evidence = clean(request);
    }
    row.reported = true;
    if (regression) {
      row.regression = healthRegression(regression);
      row.boundRegression = true;
    }
    if (nextAction) Object.assign(row, {state: 'attention', note: clean(issue), nextAction: clean(nextAction)});
    await persist();
    return {id: row.id, state: row.state};
  }
  async function retryProject(id) {
    const row = currentRows().find(item => item.id === id && item.owner === 'project' &&
      !['recovered', 'cancelled'].includes(item.state));
    if (!row) throw Error('There is no active project preview issue.');
    if (row.state === 'attention') {
      if (row.attempts >= maxAttempts) row.attempts = 0;
      row.state = 'retrying';
      row.actionAt = clock() - interval * 2;
      row.note = 'Coordinator is continuing the preview repair.';
      row.nextAction = '';
      await persist();
    }
    return {id: row.id, state: row.state};
  }
  async function run() {
    if (paused || controller.signal.aborted) return;
    const observed = (await observe()).filter(active);
    const verified = [];
    for (const row of currentRows().filter(row => row.reported && ['verifying', 'awaiting-observation'].includes(row.state))) {
      const check = row.regression;
      if (!check) {
        row.state = 'awaiting-observation';
        row.note = 'The repair loaded. Retry ' + row.title + ' so Coordinator can check the result. No automatic regression check is available.';
        continue;
      }
      let result;
      if (check.kind === 'observation') {
        const signal = observed.find(item => item.owner === 'host' && item.id === check.id && fresh(item, row));
        if (signal) result = {passed: !signal.error, detail: signal.error || 'The affected interaction passed its runtime check.'};
      } else if (verifyRegression) {
        try { result = await verifyRegression(check, controller.signal); }
        catch (error) { result = {passed: false, detail: error.message}; }
      }
      if (!result) {
        row.state = 'awaiting-observation';
        row.note = 'The repair loaded. Retry ' + row.title + ' so Coordinator can check the result.';
        continue;
      }
      row.verification = {probe: check, checkedAt: clock(), passed: result.passed === true, detail: clean(result.detail)};
      verified.push({owner: 'host', id: row.key.slice(5), title: row.title,
        error: result.passed === true ? '' : clean(result.detail) || 'The regression check failed.'});
    }
    const verifiedKeys = new Set(verified.map(signalKey));
    const observations = [...observed.filter(signal => !verifiedKeys.has(signalKey(signal))), ...verified];
    const observedKeys = new Set(observations.map(signalKey));
    const signals = [...observations, ...currentRows().filter(row => row.reported && ['detected', 'retrying'].includes(row.state) && !observedKeys.has(row.key))
      .map(row => ({owner: 'host', id: row.key.slice(5), title: row.title, error: row.error, evidence: row.evidence}))];
    checkedAt = clock();
    const seen = new Set();
    const awaitingRestart = currentRows().some(row => row.state === 'restart-required');
    let next;
    for (const signal of signals.filter(item => item.owner === 'host' || recoverProject && item.owner === 'project')) {
      const key = signalKey(signal);
      seen.add(key);
      let row = currentRows().find(item => item.key === key && !['recovered', 'cancelled'].includes(item.state));
      if (signal.cancelled) {
        if (row) {
          const repairing = row.state === 'repairing';
          row.state = 'cancelled';
          row.note = 'Preview recovery stopped because you stopped the preview.';
          row.actionAt = clock();
          finishAttempt(row, 'cancelled', row.note);
          if (repairing) attemptController?.abort(Error(row.note));
        }
        continue;
      }
      if (['repairing', 'restart-required'].includes(row?.state)) continue;
      if (row && ['verifying', 'awaiting-observation'].includes(row.state) && !fresh(signal, row)) continue;
      if (!signal.error) {
        if (row && fresh(signal, row)) {
          row.state = 'recovered';
          row.verifiedAt = clock();
          row.note = row.verification?.passed ? row.verification.detail : 'The affected action now passes its check.';
          delete row.nextAction;
          finishAttempt(row, 'verified', 'The runtime check passed.');
        }
        continue;
      }
      const error = clean(signal.error);
      if (!row) {
        row = {id: randomUUID(), key, owner: signal.owner, workspace: signal.workspace, scope: signal.scope, title: clean(signal.title), error, state: 'detected',
          detectedAt: clock(), observations: 0, attempts: 0};
        rows.unshift(row);
      }
      if (row.error !== error) row.observations = 0;
      row.error = error;
      if (signal.nextAction) Object.assign(row, {state: 'attention', note: error, nextAction: clean(signal.nextAction)});
      row.signal = {owner: signal.owner, id: signal.id, scope: signal.scope, title: clean(signal.title), error,
        evidence: evidenceText(signal.evidence), occurredAt: signal.occurredAt};
      row.evidence = evidenceText(signal.evidence);
      row.observations = Math.min(10, row.observations + 1);
      if (row.observations < 2 || row.state === 'attention') continue;
      if (['verifying', 'awaiting-observation'].includes(row.state)) failed(row, 'The runtime check still fails after restart. ' + error);
      if (row.state === 'retrying' && clock() - row.actionAt < interval * 2) continue;
      if (row.attempts >= maxAttempts) row.state = 'attention';
      else if (!next && (row.owner === 'project' || !awaitingRestart)) next = {row, signal};
    }
    for (const row of currentRows()) {
      if (!seen.has(row.key) && row.state === 'detected') row.observations = 0;
    }
    while (rows.length > 80) {
      const old = rows.findLastIndex(row => row.state === 'recovered');
      if (old < 0) break;
      rows.splice(old, 1);
    }
    await persist();
    if (!next || action || paused || !await idle()) return;
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
      if (row.owner === 'project') {
        row.note = 'Coordinator is restoring the preview and checking that the page loads.';
        await persist();
        const result = await recoverProject(row.signal, stop, structuredClone(row.history));
        stop.throwIfAborted();
        if (result?.cancelled) {
          row.state = 'cancelled';
          row.note = clean(result.detail) || 'Preview recovery stopped because you stopped the preview.';
          row.actionAt = clock();
          finishAttempt(row, 'cancelled', row.note);
          return;
        }
        if (result?.passed !== true && result?.nextAction) {
          row.state = 'attention';
          row.note = clean(result.detail);
          row.nextAction = clean(result.nextAction);
          row.actionAt = clock();
          finishAttempt(row, 'needs-action', row.note);
          return;
        }
        if (result?.passed !== true) throw Error(result?.detail || 'The preview still needs repair.');
        row.verification = {checkedAt: clock(), passed: true, detail: clean(result.detail)};
        row.state = 'recovered';
        row.verifiedAt = clock();
        row.note = clean(result.detail);
        finishAttempt(row, 'verified', row.note);
        return;
      }
      if (!restartOnly) {
        const stillFailing = async () => {
          if (paused || stop.aborted || !await idle()) return false;
          const observations = (await observe()).filter(active);
          const latest = observations.find(item => signalKey(item) === row.key);
          const regression = row.boundRegression && row.regression?.kind === 'observation' &&
            observations.find(item => item.owner === 'host' && item.id === row.regression.id && fresh(item, row));
          const resolved = regression && !regression.error || latest && fresh(latest, row) && !latest.error;
          applying = Boolean(!resolved && (row.reported || latest && clean(latest.error) === row.error) &&
            await idle() && !paused && !stop.aborted);
          return applying;
        };
        const prior = rows.filter(item => item.files).flatMap(item =>
          (item.repairs || [{files: item.files, time: item.actionAt}]).map(receipt => ({
            ...receipt, patch: path.join(directory, item.id, receipt.artifact || '', 'repair.patch')
          }))).sort((a, b) => a.time - b.time);
        const artifact = randomUUID();
        const result = await repair(row, path.join(directory, row.id, artifact), stop, stillFailing, prior);
        if (result.needsAction) {
          row.state = 'attention';
          row.note = clean(result.summary);
          row.nextAction = clean(result.nextAction);
          row.actionAt = clock();
          finishAttempt(row, 'needs-action', row.note);
          return;
        }
        row.note = clean(result.summary);
        attempt.approach = clean(result.summary);
        if (row.files && !row.repairs) row.repairs = [{files: row.files, time: row.actionAt}];
        (row.repairs ||= []).push({files: result.files, time: clock(), artifact});
        row.files = result.files;
        row.checks = attempt.checks = clean(result.checks);
        if (!row.boundRegression) row.regression = healthRegression(result.regression) || row.regression;
        delete row.verification;
      }
      row.state = 'restart-required';
      row.observations = 0;
      row.actionAt = clock();
      row.observationAfter = clock();
      finishAttempt(row, 'restart-required', row.note);
      await persist();
      restartRequired?.(row);
    } catch (error) {
      if (typeof error.checks === 'string') row.history.at(-1).checks = clean(error.checks);
      if (row.state !== 'cancelled') failed(row, error.message);
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
  return {tick, report, retryProject, busy: () => applying,
    status: () => ({error: lastError, checkedAt, maxAttempts, incidents: structuredClone(currentRows())}),
    suspend() {
      paused = true;
      attemptController?.abort(Error('The workspace is closing or switching projects.'));
      return () => { paused = false; };
    },
    close() { paused = true; clearTimeout(timer); controller.abort(); return Promise.all([running, action]); }};
}
