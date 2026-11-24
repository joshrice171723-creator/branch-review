export async function observeRuntime(desktop) {
  const signals = await desktop.observations();
  const failures = signals.filter(signal => signal.error);
  return signals.map(signal => {
    if (!signal.error) return signal;
    const related = failures.filter(other => other !== signal).slice(0, 5);
    return {...signal, evidence: [signal.evidence, ...related.map(other => other.title + ': ' + other.error)]
      .filter(Boolean).join('\n')};
  });
}

export async function observeWorkspace(desktop, observePreview) {
  const probes = [
    ['app-observer', 'Read app health', () => observeRuntime(desktop)],
    ['preview-observer', 'Read preview health', observePreview]
  ];
  const results = await Promise.allSettled(probes.map(([, , probe]) => Promise.resolve().then(probe)));
  const signals = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  results.forEach((result, index) => {
    const [id, title] = probes[index];
    const error = result.status === 'rejected' ? String(result.reason?.message || result.reason) : '';
    // The original action already owns this failure when a probe reads the same broken data.
    if (error && signals.some(signal => signal.error === error)) return;
    signals.push({owner: 'host', id, title, error, occurredAt: Date.now()});
  });
  return signals;
}
