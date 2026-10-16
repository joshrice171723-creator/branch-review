export function reviewShortcut(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.isComposing || event.defaultPrevented) return null;
  if (event.target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return null;
  return {ArrowLeft:'previous',ArrowRight:'next',v:'toggle',V:'toggle'}[event.key] || null;
}

export function refreshedSelection(branches, selected, reviewedRef, showAll) {
  return branches.find(branch => branch.ref === selected?.ref || branch.aliases?.includes(selected?.ref))
    || branches.find(branch => branch.ref === reviewedRef || branch.aliases?.includes(reviewedRef))
    || branches.find(branch => showAll || !branch.merged);
}
