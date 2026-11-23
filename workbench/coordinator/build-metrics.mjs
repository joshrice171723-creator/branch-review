const metricPath = folder => folder + '/metrics.jsonl';

export async function readMetrics(files, folder) {
  const data = await files.bytes(metricPath(folder), 4_000_000, Buffer.alloc(0)).catch(() => Buffer.alloc(0));
  const records = new Map();
  for (const line of data.toString('utf8').split('\n').slice(0, -1)) {
    try {
      const metric = JSON.parse(line);
      records.set(metric.id, metric);
    } catch { /* Keep the other records if a write was interrupted. */ }
  }
  return [...records.values()];
}

export const appendMetric = (files, folder, value) => files.append(metricPath(folder), value).catch(() => {});

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
    if (metric.provider) providers.push({provider: metric.provider, model: metric.model, outcome: metric.outcome,
      time: duration, usage: metric.usage ?? null});
  }
  const recordedChecks = new Map();
  for (const receipt of receipts) if (Number.isFinite(receipt.duration_seconds)) {
    recordedChecks.set(receipt.check, (recordedChecks.get(receipt.check) ?? 0) + receipt.duration_seconds * 1000);
  }
  for (const [key, milliseconds] of recordedChecks) steps[key] ??= {milliseconds, runningSince: null};
  return {time, steps, providers};
}
