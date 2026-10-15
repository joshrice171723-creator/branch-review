export const statusLabels = {'not-started':'Not started','in-progress':'In progress',passed:'Passed','needs-fixes':'Needs fixes',blocked:'Blocked','not-applicable':'Not applicable'};
export function itemStatus(record, item) {
  const saved = record.items?.[item.id] || {};
  if (record.issues.some(issue => issue.scenario === item.id && issue.status !== 'resolved')) return 'needs-fixes';
  if (['needs-fixes','blocked','not-applicable'].includes(saved.outcome)) return saved.outcome;
  if (item.steps.every((_,index) => record.checks[`${item.id}:${index}`])) return 'passed';
  return saved.visitedAt || saved.notes || item.steps.some((_,index) => record.checks[`${item.id}:${index}`]) ? 'in-progress' : 'not-started';
}
export const isComplete = status => status === 'passed' || status === 'not-applicable';
export function matchesItem(record,item,query='',filter='all') {
  const status=itemStatus(record,item);
  return `${item.title} ${item.id} ${item.description || ''}`.toLowerCase().includes(query.toLowerCase().trim()) &&
    (filter==='all' || filter==='remaining' && !isComplete(status) || filter==='attention' && ['needs-fixes','blocked'].includes(status) || filter==='complete' && isComplete(status));
}
export function reviewCounts(record) {
  const counts = Object.fromEntries(Object.keys(statusLabels).map(key => [key,0]));
  for (const item of record.manifest.scenarios) counts[itemStatus(record,item)]++;
  return {...counts,total:record.manifest.scenarios.length,complete:counts.passed+counts['not-applicable']};
}
export function nextItem(record, current) {
  const items = record.manifest.scenarios, index = items.findIndex(item=>item.id===current);
  return items.slice(index+1).find(item=>!isComplete(itemStatus(record,item)))?.id || null;
}
export function canApprove(record) {
  return record.issues.every(issue=>issue.status==='resolved') && record.manifest.scenarios.every(item => {
    const status = itemStatus(record,item);
    return status === 'passed' || (status === 'not-applicable' && !!record.items?.[item.id]?.reason?.trim());
  });
}
export function deliveryStep(record,configured=false) {
  if(!canApprove(record))return{action:'resume-review',label:'Continue remaining checks',detail:'Finish the review or prepare a fix request for Codex.'};
  if(record.integration?.sha!==record.identity.changed)return{action:'candidate',label:'Prepare merge candidate',detail:'Combine this branch with current main, then test the combined result. This does not push or publish.'};
  if(!record.approval)return{action:'reviewer',label:'Approve this tested candidate',detail:'Enter your reviewer name and approve the exact candidate.'};
  const stage=record.delivery?.stage;
  if(stage==='verified')return{action:null,label:'Published workflow verified',detail:'The release and its workflow result have been recorded.'};
  if(stage==='published')return{action:'release-note',label:'Verify published workflow',detail:'Record your test of the published app. Deployment alone does not complete QA.'};
  if(stage==='deployment-needs-inspection')return{action:'release-note',label:'Inspect interrupted release',detail:'Review the release and recovery artifacts before enabling a retry.'};
  if(stage==='pushed')return{action:configured?'publish':'release-settings',label:configured?'Publish approved commit':'Set up publishing',detail:'Main has the reviewed candidate. Publishing is a separate, confirmed action.'};
  return{action:'ship',label:stage==='push-unconfirmed'?'Reconcile merge and push':'Merge and push to main',detail:stage==='push-unconfirmed'?'The previous push is unconfirmed. Recheck remote main before proceeding.':'Push only the approved candidate. A moving branch or main stops this action.'};
}
export function fixRequest(record) {
  const lines = ['# Branch Review: fixes requested', '', `Repository: ${record.identity.repository}`, `Branch: ${record.identity.ref}`, `Reviewed commit: ${record.identity.changed}`, `Original commit: ${record.identity.base}`, '', 'Fix the findings below, preserve unrelated work, and update the review manifest with any additional checks. Do not merge or publish.'];
  for (const [index,item] of record.manifest.scenarios.entries()) {
    const status = itemStatus(record,item), saved = record.items?.[item.id] || {};
    if (isComplete(status)) continue;
    lines.push('', `## Item ${index+1}: ${item.title} [${item.id}]`, `Status: ${statusLabels[status]}`, `Route: ${item.path}`, `Expected: ${item.expected || item.steps.join(' ')}`);
    if (item.instructions) lines.push(`Steps: ${item.instructions}`);
    item.steps.forEach((step,i)=>lines.push(`- [${record.checks[`${item.id}:${i}`]?'x':' '}] ${step}`));
    if (saved.notes) lines.push(`Notes: ${saved.notes}`);
    if (saved.reason) lines.push(`Reason: ${saved.reason}`);
    for (const issue of record.issues.filter(issue=>issue.scenario===item.id && issue.status!=='resolved')) {
      lines.push(`Finding ${issue.id}: ${issue.actual}`, `Expected: ${issue.expected}`, `Observed in ${issue.side} at ${issue.commit}, ${issue.location || item.path}`);
      if (issue.screenshot) lines.push(`Screenshot attachment: ${issue.screenshot}`);
    }
  }
  const unassigned=record.issues.filter(issue=>issue.status!=='resolved' && !record.manifest.scenarios.some(item=>item.id===issue.scenario));
  if(unassigned.length){lines.push('','## Unresolved findings from earlier review items');for(const issue of unassigned)lines.push(`- ${issue.id} [${issue.scenario}]: ${issue.actual} (expected: ${issue.expected}; originally observed at ${issue.commit})`);}
  lines.push('', 'Unchecked items are unverified, not confirmed defects. Retest resolved items against the new commit.');
  return lines.join('\n');
}
