export async function observeRuntime(desktop) {
  const signals = await desktop.observations();
  const failures = signals.filter(signal => signal.error);
  for (const signal of failures) {
    const related = failures.filter(other => other !== signal).slice(0, 5);
    signal.evidence = [signal.evidence, ...related.map(other => other.title + ': ' + other.error)]
      .filter(Boolean).join('\n');
  }
  return signals;
}
