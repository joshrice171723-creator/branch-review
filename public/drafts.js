export const findingKey = (record, scenario, side) => `branch-review:draft:${record}:${scenario}:${side}`;
export function loadDraft(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || '{}');
    return {expected: typeof value.expected === 'string' ? value.expected.slice(0, 4000) : '', actual: typeof value.actual === 'string' ? value.actual.slice(0, 4000) : ''};
  } catch { return {expected: '', actual: ''}; }
}
export function saveDraft(storage, key, draft) {
  try {
    if (!draft.expected && !draft.actual) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch { return false; }
}
