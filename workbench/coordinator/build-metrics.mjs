import {readdir} from 'node:fs/promises';

const metricPath = folder => folder + '/metrics.jsonl';

export async function readMetrics(files, folder, strict = false) {
  const bytes = files.bytes(metricPath(folder), 4_000_000, Buffer.alloc(0));
  const data = await (strict ? bytes : bytes.catch(() => Buffer.alloc(0)));
  const records = new Map();
  for (const line of data.toString('utf8').split('\n').slice(0, -1)) {
    try {
      const metric = JSON.parse(line);
      records.set(metric.id, metric);
    } catch { /* Keep the other records if a write was interrupted. */ }
  }
  return [...records.values()];
}

export function appendMetric(files, folder, value, strict = false) {
  const write = files.append(metricPath(folder), value);
  return strict ? write : write.catch(() => {});
}

export function providerSpend(metrics) {
  let tokens = 0;
  let cached = 0;
  let unknown = 0;
  let milliseconds = 0;
  for (const call of metrics.filter(row => row.provider)) {
    const {input, output, cached: reads} = call.usage ?? {};
    if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) {
      const cacheReads = Number.isSafeInteger(reads) && reads >= 0 ? Math.min(input, reads) : 0;
      cached += cacheReads;
      tokens += input - cacheReads + output;
    } else {
      unknown++;
    }
    if (Number.isFinite(call.finishedAt) && Number.isFinite(call.startedAt)) {
      milliseconds += Math.max(0, call.finishedAt - call.startedAt);
    } else if (Number.isSafeInteger(call.timeoutMs) && call.timeoutMs > 0) {
      // A lost call can consume its allocation before Workbench reconnects.
      milliseconds += call.timeoutMs;
    }
  }
  return {tokens, cached, unknown, milliseconds};
}

export function usageSummary(metrics, attempts, stopped = false) {
  const calls = metrics.filter(row => row.provider);
  let cached = 0, uncached = 0, unclassifiedInput = 0, output = 0, stoppedMs = 0;
  for (const {usage} of calls) {
    if (!usage) continue;
    output += usage.output;
    if (usage.cached == null) {
      unclassifiedInput += usage.input;
    } else {
      const reads = Math.min(usage.input, usage.cached);
      cached += reads;
      uncached += usage.input - reads;
    }
  }
  for (const [index, attempt] of attempts.entries()) {
    const next = attempts[index + 1];
    if (attempt.outcome === 'failed' && attempt.finished && next) {
      stoppedMs += Math.max(0, Date.parse(next.started) - Date.parse(attempt.finished));
    }
  }
  const stoppedSince = stopped ? Date.parse(attempts.at(-1)?.finished) : NaN;
  return {cached, uncached, unclassifiedInput, output, stoppedMs, stoppedSince: Number.isFinite(stoppedSince) ? stoppedSince : null, calls: calls.length,
    unknown: calls.filter(call => !call.usage).length,
    recovery: calls.filter(call => call.purpose === 'Coordinator recovery').map(call => ({
      provider: call.provider, model: call.actualModel || call.model, effort: call.effort, outcome: call.outcome, usage: call.usage,
      time: {milliseconds: call.finishedAt ? call.finishedAt - call.startedAt : 0, runningSince: call.finishedAt ? null : call.startedAt}
    }))};
}

export async function legacyProviderMetrics(files, folder, visits) {
  const prefix = folder + '/provider-calls';
  const calls = await readdir(await files.path(prefix), {withFileTypes: true}).catch(() => []);
  const rows = await Promise.all(calls.filter(row => row.isDirectory() && /^[a-f0-9]{32}$/.test(row.name)).map(async row => {
    const [request, result] = await Promise.all([
      files.read(prefix + '/' + row.name + '/request.json'), files.read(prefix + '/' + row.name + '/result.json')
    ]).catch(() => []);
    const startedAt = Date.parse(request?.time);
    const finishedAt = Date.parse(result?.time);
    if (!request?.provider || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return null;
    const recovery = request.prompt?.startsWith('Supervise this stopped Branch Review build');
    const visit = visits.find(item => item.entry.stage === request.stage && startedAt >= item.time * 1000 &&
      (!item.next || startedAt < item.next.time * 1000));
    return visit || recovery ? {id: row.name, visit: visit ? Number(visit.id) : undefined, provider: request.provider,
      model: request.model, effort: request.effort, actualModel:result.actualModel, usage:result.usage,
      ...(recovery && {purpose:'Coordinator recovery'}), startedAt, finishedAt, outcome: 'complete'} : null;
  }));
  return rows.filter(Boolean).sort((a, b) => a.startedAt - b.startedAt);
}

function elapsed(start, end, windows) {
  let milliseconds = 0;
  let runningSince = null;
  for (const {startedAt, finishedAt} of windows) {
    const from = Math.max(start, startedAt);
    const to = end == null ? finishedAt : finishedAt == null ? end : Math.min(end, finishedAt);
    if (to == null) runningSince = from;
    else milliseconds += Math.max(0, to - from);
  }
  return {milliseconds, runningSince};
}

export function visitMetrics(visit, attempts, metrics, receipts) {
  const windows = attempts.map(row => ({startedAt: Date.parse(row.started), finishedAt: row.finished ? Date.parse(row.finished) : null}));
  const time = elapsed(visit.time * 1000, visit.next ? visit.next.time * 1000 : null, windows);
  const steps = Object.create(null);
  const providers = [];
  for (const metric of metrics.filter(row => row.visit >= Number(visit.id) && row.visit <= visit.lastIndex)) {
    const window = windows.find(row => row.startedAt <= metric.startedAt && (row.finishedAt == null || row.finishedAt >= metric.startedAt));
    if (!window) continue;
    const duration = elapsed(metric.startedAt, metric.finishedAt, [window]);
    const key = metric.provider ? '1' : metric.key;
    const step = steps[key] ??= {milliseconds: 0, runningSince: null};
    step.milliseconds += duration.milliseconds;
    if (duration.runningSince !== null) step.runningSince = duration.runningSince;
    if (metric.provider) providers.push({provider: metric.provider, model: metric.actualModel || metric.model, effort: metric.effort, outcome: metric.outcome,
      time: duration, usage: metric.usage ?? null, sourceAccess: metric.sourceAccess, shellTools: metric.shellTools,
      timeoutMs: metric.timeoutMs, tools: metric.toolActivity});
  }
  const recordedChecks = new Map();
  for (const receipt of receipts) if (Number.isFinite(receipt.duration_seconds)) {
    recordedChecks.set(receipt.check, (recordedChecks.get(receipt.check) ?? 0) + (receipt.reused ? 0 : receipt.duration_seconds * 1000));
  }
  for (const [key, milliseconds] of recordedChecks) steps[key] ??= {milliseconds, runningSince: null};
  return {time, steps, providers};
}
