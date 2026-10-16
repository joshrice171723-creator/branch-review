export function refreshedSelection(branches, selected, reviewedRef, showAll) {
  return branches.find(branch => branch.ref === selected?.ref || branch.aliases?.includes(selected?.ref))
    || branches.find(branch => branch.ref === reviewedRef || branch.aliases?.includes(reviewedRef))
    || branches.find(branch => showAll || !branch.merged);
}
