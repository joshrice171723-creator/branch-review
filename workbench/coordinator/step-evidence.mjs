export const buildStageRoles = {plan: 'plan', plan_review: 'planReview', baseline: 'baseline', build: 'build', building: 'build',
  checks: 'checks', build_review: 'buildReview', final_review: 'finalReview', final_skip: 'finalReview', finish: 'verify'};

export function buildTrace(history = []) {
  const visits = [];
  for (const [index, entry] of history.entries()) {
    const prior = visits.at(-1);
    if (prior?.role === 'plan' && prior.next === entry && entry.stage === 'question_retry') {
      prior.lastIndex = index;
      prior.next = history[index + 1];
    }
    if (entry.stage === 'question' && prior?.role === 'plan') prior.question = entry.detail;
    let role = buildStageRoles[entry.stage];
    if (!role) continue;
    if (entry.stage === 'building' && ['build', 'repair'].includes(prior?.role) && prior.next === entry) {
      prior.stage = 'building';
      prior.lastIndex = index;
      prior.next = history[index + 1];
      continue;
    }
    if (entry.stage === 'build' && ['buildReview', 'finalReview', 'verify'].includes(prior?.role) &&
        typeof entry.detail === 'string') role = 'repair';
    visits.push({id: String(index), role, stage: entry.stage, time: entry.time, entry, lastIndex: index, next: history[index + 1]});
  }
  return visits;
}

const text = (title, value) => ({title, text: value});
const facts = (title, values) => ({title, fields: Object.entries(values).filter(([, value]) => value != null && value !== '')});
const checks = rows => ({title: 'Check results', checks: rows});
const result = (...sections) => ({status: 'Complete', sections: sections.filter(Boolean)});
const inVisit = (visit, timestamp) => {
  const time = Date.parse(timestamp);
  return time >= visit.time * 1000 && (!visit.next || time <= visit.next.time * 1000);
};

export function checkRows(run, visit) {
  if (!visit) return [];
  const phase = visit.role === 'baseline' ? 'baseline' : 'after';
  const checkpoint = phase === 'baseline' ? 'build' : 'build_review';
  const ids = visit.next?.stage === checkpoint && Array.isArray(visit.next.detail)
    ? new Set(visit.next.detail.map(row => row.id)) : null;
  return run.checks.filter(row => row.phase === phase && (ids ? ids.has(row.id) : inVisit(visit, row.started_at)));
}

export function stageEvidence(run, build, visit, visits) {
  const {role, stage, entry, next} = visit;
  const profile = run.task.profile?.profiles?.[run.task.profile.active];
  const config = profile?.stages?.[role === 'repair' ? 'build' : role];
  const agent = config && facts('Agent settings', {Provider: config.provider, Model: config.model || 'Provider default',
    'Thinking level': config.effort});
  const instructions = config?.instructions && text('Stage instructions', config.instructions);
  const plan = text('Approved plan', build.plan);
  const methodVisit = visits.findLast(item => item.entry.stage === 'plan_review' && item.entry.detail?.plan && item.time <= visit.time);
  const method = methodVisit?.entry.detail?.plan && text('Implementation steps', methodVisit.entry.detail.plan);
  if (role === 'plan') {
    const recorded = next?.stage === 'plan_review' ? text('Implementation steps', next.detail?.plan) :
      visit.question?.question ? text('Plan question', visit.question.question) : null;
    return {0: result(plan, agent, instructions, profile?.rules && text('Shared rules', profile.rules)),
      ...(recorded && {1: result(recorded), 2: result(recorded)})};
  }
  if (role === 'build' || role === 'repair') {
    const summary = next?.stage === 'checks' && typeof next.detail === 'string' && next.detail;
    return {0: result(role === 'repair' && typeof entry.detail === 'string' && text('Returned finding', entry.detail),
      method, plan, agent, instructions), ...(summary && {1: result(text('Implementation summary', summary)),
      2: result(text('Implementation summary', summary))})};
  }
  if (role === 'baseline' || role === 'checks') {
    const rows = checkRows(run, visit);
    const names = new Set(rows.map(row => row.check));
    return Object.fromEntries([...names].map(name => {
      const found = rows.filter(row => row.check === name);
      const last = found.at(-1);
      return [name, {status: last.exit_code === 0 && !last.source_changed && !last.spawn_error ? 'Passed' : 'Failed',
        sections: [checks(found)]}];
    }));
  }
  if (role.endsWith('Review')) {
    const verdict = run.audits.findLast(row => row.stage === (stage === 'final_skip' ? 'final_review' : stage) &&
      inVisit(visit, row.at));
    const checkVisit = visits.findLast(item => item.role === 'checks' && item.time < visit.time);
    const receipts = role === 'planReview' ? [] : checkRows(run, checkVisit);
    const input = result(plan, method, agent, instructions, receipts.length && checks(receipts));
    if (!verdict) return stage === 'final_skip' ? {} : {0: input};
    const status = {pass: 'Passed', repair: 'Returned', replan: 'Returned', needs_evidence: 'Needs evidence', skipped: 'Skipped'}[verdict.verdict];
    const recorded = {status, sections: [facts('Recorded verdict', {Verdict: status, Decision: verdict.verdict,
      Auditor: verdict.actor, 'Recorded at': verdict.at, Rubric: verdict.rubric_id, 'Quality revision': verdict.quality_revision,
      'Source snapshot': verdict.snapshot_sha256, 'Plan fingerprint': verdict.plan_sha256}),
    text('Auditor’s reason', verdict.reason), ...(verdict.criteria?.length ?
      [{title: 'Rubric results', criteria: verdict.criteria}] : []), agent].filter(Boolean)};
    return {...(stage !== 'final_skip' && {0: input, 1: {...recorded,
      sections: [...recorded.sections, ...(receipts.length ? [checks(receipts)] : [])]}}), 2: recorded};
  }
  const report = next?.stage === 'completed' && run.reports.findLast(row => row.snapshot_sha256 === next.detail?.snapshot_sha256);
  if (report) {
    const verified = result(facts('Verification result', {Verdict: report.verdict, Commit: next.detail.sha,
      'Source snapshot': report.snapshot_sha256, 'Change fingerprint': report.diff_sha256,
      'Quality revision': report.quality_revision}), report.issues?.length &&
      text('Recorded issues', report.issues.map(issue => issue.message || issue).join('\n')));
    return {0: {...verified, sections: [...verified.sections, checks(checkRows(run,
      visits.findLast(item => item.role === 'checks' && item.time < visit.time)))]}, 1: verified};
  }
  if (role === 'verify' && typeof next?.detail === 'string') {
    return {0: {status: 'Returned', sections: [text('Verification finding', next.detail)]}};
  }
  return {};
}

export function gateEvidence(role, build, group, review) {
  if (!group?.sha) return {};
  const approval = group.reviews.findLast(row => row.sha === group.sha);
  const push = group.pushed?.sha === group.sha && group.pushed;
  if (role === 'push') {
    const target = facts('Push target', {Commit: group.sha, Branch: build.branch,
      Destination: approval?.pushTarget});
    const receipt = push && result(facts('Push receipt', {Commit: push.sha, Ref: push.ref,
      Remote: push.destination, 'Recorded at': push.time}));
    return {...(approval && {0: result(target)}), ...(receipt && {1: receipt, 2: receipt})};
  }
  const checklist = approval?.checklist ?? review?.checklist;
  const findings = review?.findings ?? [];
  return {0: result(facts('Review target', {Commit: group.sha, 'Base commit': group.base, Branch: build.branch}),
    ...(review?.url ? [{title: 'Branch Review', link: review.url}] : [])),
    1: {...result(facts('Review status', {Status: approval ? 'Approved' : review?.status}),
      checklist?.length && {title: 'Review checklist', checklist},
      findings.length && {title: 'Review findings', findings}), status: approval ? 'Complete' : 'Waiting for you'},
    ...(approval && {2: result(facts('Recorded approval', {Reviewer: approval.author, Commit: approval.sha,
      'Review ID': approval.reviewId, 'Recorded at': approval.time}))}),
    ...(!approval && review?.status === 'changes-requested' && {2: {status: 'Returned', sections: [
      {title: 'Review findings', findings}]}})};
}
