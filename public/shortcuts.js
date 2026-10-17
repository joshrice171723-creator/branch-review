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

export function selectedReviewState(state, selection) {
  if(!selection)return state;
  if(state.status==='preview-ready' && state.comparison?.branch.ref===selection.ref && state.comparison.branch.sha===selection.sha)return {...state,record:null};
  const matches=state.record?.identity.ref===selection.ref && state.record.identity.source===selection.sha;
  if(matches && state.status==='ready' && !state.busy)return state;
  const loading=selection.starting || state.busy;
  return {...state,record:null,manifest:null,original:null,changed:null,comparison:null,
    status:loading?'preparing':'error',busy:!!loading,
    phase:loading && state.busy?state.phase:`Opening ${selection.name}…`,error:loading?null:state.error || 'Could not open this branch. Click it to retry.'};
}
