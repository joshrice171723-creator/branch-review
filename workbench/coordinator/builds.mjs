import {isDeepStrictEqual} from 'node:util';
import {assetPattern, id, now, runPattern, sentence} from './files.mjs';
import {checkMode, hash, jsonHash, selectedProfile, workspaceFile} from './design.mjs';
import {commitment, currentGroup, loopPath, markerPath, statePath} from './audit.mjs';
import {buildStageRoles, buildTrace, checkRows, gateEvidence, stageEvidence} from './step-evidence.mjs';
import {legacyProviderMetrics, readMetrics, visitMetrics} from './build-metrics.mjs';
import {WorkbenchProfile} from '../profile.mjs';
import {annotateProviderFailure} from './provider-limit.mjs';
import {cosmeticCandidate} from '../automatic-route.mjs';

const leasePath = '.harness/design/build.owner';
const pendingStates = ['working', 'cancelling'];
const closedStates = ['closed', 'retired'];
const decisionStages = ['question', 'question_retry', 'evidence'];
const budgetErrors = ['PROVIDER_CALL_TIMEOUT', 'PROVIDER_TASK_TIME_BUDGET', 'PROVIDER_USAGE_BUDGET'];
function applyBuildBudget(build, payload) {
  for (const [key, label] of [['providerTokenLimit', 'token limit'], ['providerTimeSeconds', 'provider time in seconds']]) {
    const value = payload[key];
    if (value === undefined) continue;
    const [min, max] = WorkbenchProfile.providerBounds[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw Error('Set the build ' + label + ' between ' + min + ' and ' + max + '.');
    }
    build[key] = value;
  }
}
const repairLimitMessage = 'This run reached its repair limit. Review the last audit before starting another build.';
const workflowChangedMessage = build => 'Agent settings changed after this run started. ' + (build.mode === 'task'
  ? 'Restart the build to use the saved settings.'
  : 'Retire the run and start a new build to use the saved settings.');

function agentSettings(stage) {
  return stage && {provider: stage.provider, model: stage.model, effort: stage.effort};
}

function changedAgents(pinned, saved) {
  const before = selectedProfile(pinned)?.stages ?? {};
  const after = selectedProfile(saved)?.stages ?? {};
  return Object.keys(before).filter(key => before[key]?.enabled !== false && after[key]?.enabled !== false &&
    before[key]?.provider && after[key]?.provider &&
    !isDeepStrictEqual(agentSettings(before[key]), agentSettings(after[key])));
}

function current(state, key) {
  const build = state.builds.at(-1);
  if (!build || build.id !== key) throw Error('Select the current build.');
  return build;
}
function groupAt(build, raw = 0) {
  const index = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(index) || !build.groups[index]) throw Error('Select a review group.');
  return build.groups[index];
}
function approved(state, build) {
  return state.approved === build.revision && state.revision === build.revision &&
    !state.question && !state.plannerRetry;
}
function pendingReply(loop) {
  if (loop?.stage === 'evidence') return {question: loop.evidenceRequest.text, question_id: loop.evidenceRequest.id,
    decision_kind: 'evidence', evidence_stage: loop.evidenceRequest.stage};
  if (loop?.stage === 'question') return {question: loop.question, question_id: loop.question_id, suggestions: loop.suggestions};
  return null;
}
function validateReply(loop, task, payload, message) {
  if (loop?.stage === 'question_retry' && message === '/run') return;
  const pending = pendingReply(loop);
  if (!pending || payload.task !== task || payload.question !== pending.question ||
      payload.question_id !== pending.question_id || message === '/run') throw Error('The pending build decision changed.');
  if (pending.decision_kind === 'evidence') sentence(message, 'an evidence note', 8000);
}
function groupMembers(state, payload) {
  if (state.mode === 'task') return [['task']];
  const {scope = 'plan', key, frequency = 'slice'} = payload;
  if (!['plan', 'milestone', 'slice'].includes(scope) || !['plan', 'milestone', 'slice'].includes(frequency)) {
    throw Error('Select a build scope and review frequency.');
  }
  const selected = state.roadmap.filter(row => scope !== 'milestone' || row.id === key)
    .map(row => row.slices.filter(slice => scope !== 'slice' || slice.id === key).map(slice => slice.id)).filter(row => row.length);
  if (!selected.length) throw Error('The approved roadmap does not contain this scope.');
  if (frequency === 'slice') return selected.flat().map(slice => [slice]);
  return frequency === 'plan' ? [selected.flat()] : selected;
}

export function createBuilds({files, git, store, design, audit, review, push, checkProviders = async () => []}) {
  const jobs = new Map();
  let recoveryTimer;
  let recoverySuspended = false;
  let closing = false;
  let operations = 0;
  let legacyMetrics;
  const providerReady = row => ['ready', 'unverified'].includes(row.status);
  const providerMessage = row => row.roles.join(', ') + ' · ' + row.message;

  async function ensureProfile() {
    if (store.profileApplied && !await store.profileApplied()) throw Error('Apply a workflow profile before building.');
    const profile = await store.getProfile();
    if (!selectedProfile(profile)?.stages?.build) throw Error('Apply a valid workflow profile before building.');
    return profile;
  }
  async function ensureChecks() {
    const config = store.effectiveConfig ? await store.effectiveConfig() : await store.getProfile();
    if (!config.checks?.some(row => row.required || row.benchmark)) {
      throw Error('Configure a required project check or benchmark.');
    }
    return config;
  }
  async function active() {
    const runs = await store.listRuns();
    return runs.active ? store.getRun(runs.active) : null;
  }
  async function metricsFor(task, build, visits) {
    const folder = loopPath(task);
    const recorded = await readMetrics(files, folder);
    const last = build.attempts.findLast(row => row.task === task);
    if (recorded.length || !last?.finished) return recorded;
    if (legacyMetrics?.attempt !== last.id) {
      legacyMetrics = {attempt: last.id, calls: legacyProviderMetrics(files, folder, visits).catch(() => [])};
    }
    return legacyMetrics.calls;
  }
  async function providerLimitFor(attempt, run) {
    if (attempt.providerLimit) return attempt.providerLimit;
    const stage = attempt.step === 'question_retry' ? 'plan' : attempt.step;
    const role = buildStageRoles[stage];
    if (!role || !attempt.error) return null;
    const limit = annotateProviderFailure({message: attempt.error}, {stage}).providerLimit;
    if (!limit) return null;
    const pinned = run ?? await store.getRun(attempt.task);
    const settings = selectedProfile(pinned.task.profile)?.stages[role];
    return settings?.provider ? {...limit, provider: settings.provider, model: settings.model} : null;
  }
  async function resumeBlocker(build, run) {
    const attempt = build?.attempts.at(-1);
    if (!attempt || !['failed', 'cancelled'].includes(build.status)) return '';
    const pinned = run ?? await store.getRun(attempt.task);
    if (pinned.lifecycle.cause === 'repair_limit' && !await verificationAvailable(build)) return repairLimitMessage;
    if (attempt.step === 'stopped' && pinned.lifecycle.cause !== 'repair_limit') {
      return 'The audit stopped this run. Review the last audit before starting another build.';
    }
    if (changedAgents(pinned.task.profile, await store.getProfile()).length) return workflowChangedMessage(build);
    if (Date.parse((await providerLimitFor(attempt, pinned))?.resetAt) > Date.now()) {
      return 'The provider reported a reset time. This run will resume when the quota resets.';
    }
    return '';
  }
  function verificationCheckpoint(run, loop) {
    if (loop?.design_sha) return null;
    if (run?.lifecycle.status === 'active' && loop?.stage === 'evidence_blocked' && loop.checked_source) {
      return loop.checked_source;
    }
    if (run?.lifecycle.cause === 'repair_limit' && loop?.stage === 'stopped' &&
        ['build_review', 'final_review'].includes(loop.history.at(-2)?.stage)) return run.lifecycle.snapshot_sha256;
    return null;
  }
  async function verificationAvailable(build) {
    const attempt = build?.attempts.at(-1);
    if (build?.status !== 'failed' || !['stopped', 'evidence_blocked'].includes(attempt?.step)) return false;
    const [run, loop] = await Promise.all([store.getRun(attempt.task), files.read(statePath(attempt.task))]);
    return Boolean(verificationCheckpoint(run, loop));
  }
  async function restartRequired(build) {
    if (!build || !['failed', 'cancelled'].includes(build.status)) return false;
    try {
      await ensureResumeTarget(build, build.attempts.at(-1)?.task);
      return false;
    } catch {
      return true;
    }
  }
  async function ensureResumeTarget(build, taskId, checkpoint) {
    if (await commitment(git, build.branch) === build.base) return;
    const loop = checkpoint ?? (taskId && await files.read(statePath(taskId)));
    if (loop?.design_sha) return audit.ensureCleanTarget(audit.withRecoveredPaths(build, loop), loop.design_sha);
    if (loop?.commitIntent && await audit.findPendingCommit(await store.getRun(taskId).then(run => run.task), build, loop)) return;
    throw Error('Restore the exact branch and commit for this task.');
  }
  async function profileMatches(build, profile) {
    if (build.profile === jsonHash(profile)) return true;
    const bytes = await files.bytes('.harness/profile.json', 4_000_000, null);
    return !!bytes && hash(bytes) === build.profile;
  }
  async function runtimeProfile(previous, taskId) {
    if (previous?.task !== taskId) return;
    if (!budgetErrors.includes(previous.errorCode)) return previous.runtimeProfile;
    const saved = await store.getProfile();
    const profile = selectedProfile(saved);
    const stages = Object.fromEntries(Object.entries(profile.stages)
      .filter(([, stage]) => stage.timeoutSeconds !== undefined)
      .map(([key, stage]) => [key, {timeoutSeconds: stage.timeoutSeconds}]));
    const {providerTimeSeconds, providerTokenLimit} = WorkbenchProfile.providerLimits(profile, saved.active);
    return {providerTimeSeconds, providerTokenLimit, stages};
  }

  async function readiness({automaticRouting} = {}) {
    const state = await design.read();
    const build = state.builds.at(-1);
    const running = await active();
    const check = (id, ready, message) => ({id, status: ready ? 'ready' : 'blocked', message});
    const test = async (id, resolve, ready) => {
      try { await resolve(); return check(id, true, ready); }
      catch (error) { return check(id, false, error.message); }
    };
    const plan = state.approved === state.revision && !state.question && !state.plannerRetry;
    const native = (!build || closedStates.includes(build.status)) && (!running || !['active', 'unverified'].includes(running.lifecycle.status));
    const profile = await store.getProfile();
    const config = automaticRouting === '1' ? await ensureChecks().catch(() => null) : null;
    const visual = config && state.mode === 'task' &&
      cosmeticCandidate({plan: state.plan, profile, quality: config.quality_revision, checks: config.checks});
    const items = [
      check('plan', plan, plan ? 'The current draft is approved.' : 'Resolve planning and approve the current draft.'),
      await test('profile', ensureProfile, 'A workflow profile is applied.'),
      ...(await checkProviders(profile, false, visual ? 'Codex' : undefined)).map(row =>
        check(row.id, providerReady(row), providerMessage(row))),
      await test('checks', ensureChecks, 'Required project checks are configured.'),
      await test('branch', () => commitment(git, state.branch), 'The configured branch is checked out.'),
      check('review', !!review, review ? 'Branch Review is ready.' : 'Open the completed commit in Branch Review.'),
      check('native', native, native ? 'No unfinished build or active task.' : 'Finish or pause the current build or task.')
    ];
    return {ready: items.filter(row => row.id !== 'review').every(row => row.status === 'ready'), items};
  }

  async function newAttempt(state, build, answer, verificationOnly, automaticRecovery) {
    if (!approved(state, build)) throw Error('The approved plan changed. Retire this build before continuing.');
    if (state.branch !== build.branch) throw Error('Restore the configured branch before continuing.');
    const previous = build.attempts.at(-1);
    const group = currentGroup(build);
    group.base ??= build.base;
    const member = group.pending[0];
    if (!member) throw Error('This group is waiting for Branch Review.');
    const prior = previous?.slice === member && previous.outcome !== 'completed'
      ? await store.getRun(previous.task) : null;
    const loop = prior && await files.read(statePath(prior.id));
    const manualRetry = Boolean(prior && !automaticRecovery && !answer && ['failed', 'cancelled'].includes(build.status));
    const retryRepair = manualRetry && !verificationOnly && Boolean(verificationCheckpoint(prior, loop));
    let verificationSource;
    if (verificationOnly || retryRepair) {
      verificationSource = verificationCheckpoint(prior, loop);
      if (!verificationSource) {
        throw Error('Select a build stopped during audit before it produced a review commit.');
      }
      if (await commitment(git, build.branch) !== build.base) throw Error('Restore the stopped build’s branch and commit.');
    }
    const blocker = verificationOnly ? '' : await resumeBlocker(build, prior);
    if (blocker) throw Error(blocker);
    let task = prior && (verificationOnly || retryRepair || ['active', 'paused', 'completed'].includes(prior.lifecycle.status)) ? prior.task : null;
    if (automaticRecovery && !task) throw Error('The original task is unavailable for recovery.');
    if (task && !verificationOnly && !retryRepair) {
      if (loop?.stage === 'stopped') throw Error('The audit return limit was reached. Retire this build before continuing.');
      await ensureResumeTarget(build, task.id, loop);
      if (prior.lifecycle.status === 'paused') await store.resume(task.id);
    } else if (!task) {
      await audit.ensureCleanTarget(build, build.base);
      const profile = await ensureProfile();
      if (!await profileMatches(build, profile)) throw Error('Restore the applied profile before continuing.');
      const config = await ensureChecks();
      if (Object.hasOwn(build, 'policyRevision') && (config.quality_revision ?? null) !== build.policyRevision) throw Error('Restore the pinned Quality policy before continuing.');
      const title = build.roadmap.flatMap(milestone => milestone.slices).find(slice => slice.id === member)?.title;
      if (!title) throw Error('The approved task scope is missing.');
      const scope = build.mode === 'task' ? 'Implement the approved task plan.' : 'Implement the selected slice.';
      const repair = group.findings.filter(finding => !finding.repaired);
      const result = await store.startTask({action: title, mode: 'build', decisions: build.decisions, channel: 'form',
        automaticPlan: build.automaticRouting && build.mode === 'task' && !repair.length ? build.plan : undefined,
        scope: (repair.length ? 'Address the selected findings within the approved plan.' : scope) +
          '\n' + JSON.stringify({build: build.id, revision: build.revision, planSha: hash(build.plan),
            ...(repair.length ? {priorRuns: repair.map(finding => finding.runId)} : {})})});
      task = result.task;
      if (!isDeepStrictEqual(task.profile, profile)) {
        await store.pause(task.id, 'Workflow profile changed before launch.');
        throw Error('Restore the applied profile before continuing.');
      }
      const pinned = task.quality?.revision ?? null;
      if (Object.hasOwn(build, 'policyRevision') && build.policyRevision !== pinned) {
        await store.pause(task.id, 'Quality policy changed before launch.');
        throw Error('Restore the pinned Quality policy before continuing.');
      }
      build.policyRevision = pinned;
      build.preservedHashes ??= Object.fromEntries(Object.keys(build.preserved).map(name =>
        [name, task.initial_snapshot.files[name] ?? null]));
    }
    const marker = {branch: build.branch, build: build.id, group: build.index, slice: member,
      base: build.base, preserved: build.preserved ?? {}, preserved_index: build.preserved_index ?? {},
      rejected: group.findings.filter(finding => !finding.repaired).map(finding => finding.sha),
      ...(build.mode ? {mode: build.mode} : {}),
      ...(Object.hasOwn(build, 'preservedPolicySha') ? {preservedPolicySha: build.preservedPolicySha} : {})};
    const saved = await files.read(markerPath(task.id));
    if (!saved) await files.write(markerPath(task.id), marker);
    else if (!isDeepStrictEqual(saved, marker)) throw Error('The recorded build scope changed.');
    if (verificationOnly || retryRepair) await store.retryVerification(task.id, verificationSource,
      retryRepair ? 'User requested a build retry with fresh allowances.' : undefined);
    else if (manualRetry && prior.lifecycle.status !== 'completed') await store.resetRetryLimits(task.id);
    const savedLimits = await runtimeProfile(previous, task.id);
    const overrides = Object.fromEntries(['providerTokenLimit', 'providerTimeSeconds']
      .filter(key => build[key] !== undefined).map(key => [key, build[key]]));
    let limits = Object.keys(overrides).length ? {...savedLimits, ...overrides} : savedLimits;
    if (automaticRecovery?.kind === 'stageTimeout') {
      const {role, timeoutSeconds} = automaticRecovery;
      limits = {...limits, stages: {...limits?.stages, [role]: {timeoutSeconds}}};
    }
    const attempt = {id: id(), job: id(), slice: member, task: task.id, started: now(), outcome: 'running',
      ...(limits && {runtimeProfile: limits}),
      ...(automaticRecovery && {automaticRecovery}),
      reason: group.findings.at(-1)?.text ?? previous?.error ?? ''};
    const budgetResetAt = manualRetry ? Date.now() : previous?.task === task.id ? previous.budgetResetAt : undefined;
    if (budgetResetAt !== undefined) attempt.budgetResetAt = budgetResetAt;
    build.attempts.push(attempt);
    build.status = 'working';
    delete build.error;
    delete build.attention;
    const recoveredPaths = automaticRecovery?.kind === 'handoff' ? automaticRecovery.paths : undefined;
    return {build: structuredClone(build), attempt, task, answer, verificationOnly, retryRepair, runtimeProfile: limits,
      recoveredPaths, step: recoveredPaths ? 'finish' : verificationOnly || retryRepair ? 'checks' : loop?.stage};
  }

  async function recordResult(buildId, job, loop) {
    await design.edit(state => {
      const build = current(state, buildId);
      const attempt = build.attempts.find(row => row.job === job.id);
      if (!attempt || attempt.finished) return;
      const group = currentGroup(build);
      Object.assign(attempt, {outcome: job.state, finished: job.finished_at ?? now(), step: loop?.stage, error: job.error ?? '',
        ...(job.providerLimit && {providerLimit: job.providerLimit}), ...(job.errorCode && {errorCode: job.errorCode})});
      if (loop?.stage === 'completed' && job.state === 'completed' && loop.design_sha) {
        attempt.sha = group.sha = build.base = loop.design_sha;
        group.pending = group.pending.filter(member => member !== attempt.slice);
        for (const finding of group.findings) {
          if (!finding.slices.some(member => group.pending.includes(member))) finding.repaired = true;
        }
        build.status = group.pending.length ? 'ready' : 'review';
      } else if (job.state === 'cancelled') {
        build.status = 'cancelled';
      } else if (job.state === 'completed' && decisionStages.includes(loop?.stage)) {
        build.status = 'question';
        attempt.outcome = {question: 'waiting for answer', question_retry: 'retry suggestions', evidence: 'waiting for evidence'}[loop.stage];
      } else {
        build.status = 'failed';
        build.error = job.error || loop?.finding || 'The build stopped before verification.';
      }
    });
  }

  async function publishAttention(build, attempt, recoveryError) {
    const loop = await files.read(statePath(attempt.task), {});
    const detail = loop.stage === 'evidence_blocked' ? loop.history?.at(-1)?.detail : null;
    const role = buildStageRoles[detail?.stage ?? attempt.step];
    const stage = WorkbenchProfile.roles.find(item => item.id === role)?.name ??
      ({baseline: 'Baseline checks', checks: 'Project checks', repair: 'Repair'})[role] ?? 'Build';
    const reason = (build.error || attempt.error || 'The build stopped.')
      .replace(/\s*\[request_id=[^\]]+\]/gi, '').trim().slice(0, 2800);
    const fingerprint = hash(JSON.stringify([attempt.task, role, attempt.errorCode ?? detail?.kind, reason]));
    if (build.attention?.fingerprint === fingerprint) return;
    const budget = budgetErrors.includes(attempt.errorCode);
    const next = budget
      ? attempt.errorCode === 'PROVIDER_CALL_TIMEOUT'
        ? 'The provider call reached its stage time limit. Check the call time limit in Configure → Stages.'
        : 'Retry starts a fresh allowance. Use Build budget in Plan if you want to change the limit.'
      : detail?.kind === 'no_task_changes' || detail?.kind === 'checkout_ownership'
        ? 'I need you to decide which changes belong to this build before I can include them in a commit.'
        : /\b429\b|rate_limit_error|quota exhausted/i.test(reason)
          ? 'The provider still cannot run. Check its quota or connection before retrying.'
          : 'Review this blocker before retrying. You can ask me about it here.';
    const checked = (loop.checks ?? []).filter(row => row.exit_code === 0 && !row.source_changed && !row.inputs_changed);
    const receiptNote = checked.length
      ? 'I kept ' + checked.length + ' passing check ' + (checked.length === 1 ? 'receipt.' : 'receipts.') : '';
    const recoveryNote = attempt.automaticRecovery?.kind === 'stageTimeout' ? 'I retried this stage with a longer call allowance.' :
      attempt.automaticRecovery?.resetAt ? 'I retried this stage after the provider reset.' : '';
    const text = ['“' + (build.title || 'Current build') + '” needs attention at ' + stage + '.',
      reason, receiptNote, recoveryNote, recoveryError && 'Automatic recovery could not start. ' + recoveryError, next].filter(Boolean).join('\n\n');
    await design.edit(state => {
      const current = state.builds.at(-1);
      if (current?.id !== build.id || current.status !== 'failed' || current.attempts.at(-1)?.id !== attempt.id ||
          current.attention?.fingerprint === fingerprint) return;
      const existing = state.messages.find(row => row.buildAttention?.fingerprint === fingerprint);
      const message = existing ?? {id: id(), author: 'agent', coordinator: true, time: now(), text,
        buildAttention: {fingerprint, stage, task: attempt.task}, choices: budget ?
          ['Where is the build budget?', 'Build status'] : ['Build status']};
      if (!existing) state.messages.push(message);
      current.attention = {id: message.id, fingerprint};
    });
  }

  async function attention() {
    const state = await files.read(workspaceFile);
    const build = state?.builds?.at(-1);
    return build?.status === 'failed' && build.attention ?
      state.messages?.find(row => row.id === build.attention.id) ?? null : null;
  }

  function start(prepared, release) {
    const {build, attempt, task} = prepared;
    const controller = new AbortController();
    const job = {id: attempt.job, task_id: task.id, state: 'running', started_at: attempt.started, step: prepared.step ?? 'plan',
      cancellable: true, response: '', error: null};
    const execution = {job, controller, active: true};
    jobs.set(job.id, execution);
    execution.done = (async () => {
      let loop;
      try {
        if (attempt.automaticRecovery?.kind === 'stageTimeout') {
          await audit.activity(task.id, prepared.step, 'Workbench', 'Retrying the audit with more time.');
        }
        loop = await audit.workflow({...prepared, signal: controller.signal,
          setCancellable: value => { job.cancellable = value; },
          refresh: stage => { job.step = stage; },
          validateTarget: build.standalone ? undefined : async () => {
            const state = await design.read();
            if (current(state, build.id).attempts.at(-1).task !== task.id || !approved(state, build) ||
                state.branch !== build.branch) throw Error('The approved plan or configured branch changed.');
          }});
        job.response = loop.stage === 'completed' ? loop.summary ?? 'Verified for Branch Review.' :
          pendingReply(loop)?.question ?? '';
        job.state = loop.stage === 'stopped' ? 'failed' : 'completed';
        if (loop.stage === 'stopped') {
          const detail = loop.history?.at(-1)?.detail;
          job.error = (typeof detail === 'string' ? detail : detail?.reason) || loop.finding;
        }
      } catch (error) {
        loop = await files.read(statePath(task.id), {}).catch(() => ({}));
        job.state = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = controller.signal.aborted ? 'Task cancelled.' : error.message;
        if (!controller.signal.aborted) {
          job.providerLimit = error.providerLimit;
          if (budgetErrors.includes(error.code)) job.errorCode = error.code;
        }
        await audit.activity(task.id, loop.stage ?? 'plan', 'Workbench', job.error).catch(() => {});
        if (controller.signal.aborted) await store.pause(task.id, 'Task cancelled.').catch(() => {});
      } finally {
        job.cancellable = false;
        job.finished_at = now();
        try {
          await files.write(loopPath(task.id) + '/jobs/' + job.id + '.json', job);
          if (!build.standalone) await recordResult(build.id, job, loop);
        } catch (error) {
          job.state = 'failed';
          job.error = error.message;
        } finally {
          try { await release(); }
          finally { execution.active = false; }
        }
      }
      if (!build.standalone && job.state === 'failed') await refreshRecovery();
      if (!build.standalone && job.state === 'completed' && loop?.stage === 'completed') {
        const state = await design.read();
        if (state.builds.at(-1)?.id === build.id && state.builds.at(-1).status === 'ready') {
          await advance({build: build.id}).catch(error => {
            job.error = error.message;
          });
        }
      }
    })().catch(error => {
      job.state = 'failed';
      job.error = error.message;
    });
    return {...job};
  }

  async function drive(change, answer, verificationOnly = false, automaticRecovery) {
    if (closing || recoverySuspended) throw Error('Branch Review is closing or switching projects.');
    operations++;
    let release;
    let handedOff = false;
    try {
      release = await files.acquire(leasePath);
      let prepared;
      const state = await design.edit(async state => {
        const build = await change(state);
        prepared = await newAttempt(state, build, answer, verificationOnly, automaticRecovery);
      });
      const job = start(prepared, release);
      handedOff = true;
      return {state, job};
    } finally {
      try { if (!handedOff) await release?.(); }
      finally { operations--; }
    }
  }

  async function launch(payload, restart = false) {
    const {state} = await drive(async state => {
      checkMode(state, payload);
      if (payload.revision !== state.revision || !approved(state, {revision: state.revision}) || !state.plan.trim()) {
        throw Error('Approve the current draft before building.');
      }
      const previous = state.builds.at(-1);
      if (restart) {
        if (state.mode !== 'task' || !previous || previous.id !== payload.build || previous.revision !== state.revision ||
            !['failed', 'cancelled'].includes(previous.status)) throw Error('Select the stopped build for the current approved plan.');
        if (previous.branch !== state.branch) throw Error('Restore the stopped build’s branch or retire the build to use a different branch.');
      } else if (previous && !closedStates.includes(previous.status)) throw Error('Finish the current build first.');
      const previousTask = await active();
      const ownsTask = restart && previousTask?.id === previous.attempts.at(-1)?.task;
      if (previousTask && ['active', 'unverified'].includes(previousTask.lifecycle.status) &&
          !(ownsTask && previousTask.lifecycle.status === 'active')) throw Error('Finish or pause the current task.');
      const profile = await ensureProfile();
      const config = await ensureChecks();
      const visual = payload.automaticRouting === true && state.mode === 'task' &&
        cosmeticCandidate({plan: state.plan, profile, quality: config.quality_revision, checks: config.checks});
      const blockers = (await checkProviders(profile, false, visual ? 'Codex' : undefined)).filter(row => !providerReady(row));
      if (blockers.length) throw Error(blockers.map(providerMessage).join(' '));
      if (payload.stages && !isDeepStrictEqual(payload.stages, selectedProfile(profile).stages)) {
        throw Error('The applied workflow changed. Reload the build steps.');
      }
      const base = await commitment(git, state.branch);
      const baseline = await audit.baseline();
      const groups = groupMembers(state, payload).map(slices => ({slices, pending: [...slices], findings: [], reviews: [], sha: null}));
      const build = {id: id(), revision: state.revision, index: 0, branch: state.branch, plan: state.plan, roadmap: state.roadmap,
        attachments: {...state.attachments}, base, decisions: restart ? previous.decisions : payload.decisions ?? {}, status: 'ready', attempts: [],
        profile: jsonHash(profile), groups, ...baseline, ...(state.mode === 'task' ? {mode: 'task', title: state.title} : {})};
      applyBuildBudget(build, payload);
      if (payload.automaticRouting === true && state.mode === 'task') build.automaticRouting = true;
      if (restart) {
        if (ownsTask && previousTask.lifecycle.status === 'active') await store.pause(previousTask.id, 'Build restarted.');
        Object.assign(previous, {status: 'retired', retired: true});
      }
      state.builds.push(build);
      return build;
    });
    return state;
  }

  async function advance(payload) {
    return (await drive(state => {
      const build = current(state, payload.build);
      if (!['ready', 'failed', 'cancelled'].includes(build.status)) throw Error('This build is waiting for another action.');
      applyBuildBudget(build, payload);
      return build;
    })).state;
  }

  async function retryVerification(payload) {
    return (await drive(state => {
      const build = current(state, payload.build);
      if (build.status !== 'failed') throw Error('Select the stopped build.');
      applyBuildBudget(build, payload);
      return build;
    }, undefined, true)).state;
  }

  function scheduleRecovery(callback, wait) {
    clearTimeout(recoveryTimer);
    if (!closing && !recoverySuspended) {
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        void callback().catch(() => {});
      }, Math.min(wait, 2147483647));
      recoveryTimer.unref();
    }
  }

  async function refreshRecovery(reconnectPending = false) {
    if (closing || recoverySuspended) return;
    const state = await files.read(workspaceFile);
    const build = state?.builds?.at(-1);
    const attempt = build?.attempts.at(-1);
    if (!attempt || jobs.get(attempt.job)?.active) return;
    if (reconnectPending && pendingStates.includes(build.status)) {
      try { await reconnect({build: build.id}); }
      catch (error) {
        if (error.message === 'This checkout already has an active Workbench operation.') {
          scheduleRecovery(() => refreshRecovery(true), 1000);
        }
        return;
      }
      return refreshRecovery();
    }
    if (build.status !== 'failed') return;
    let recovery = await providerLimitFor(attempt);
    let deadline = Date.parse(recovery?.resetAt);
    if (attempt.step === 'evidence_blocked' && build.mode === 'task' &&
        !build.attempts.some(row => row.task === attempt.task && row.automaticRecovery?.kind === 'handoff')) {
      const loop = await files.read(statePath(attempt.task), {});
      if (loop.history?.at(-1)?.detail?.kind === 'no_task_changes') {
        const earlier = [...(state.archivedBuilds ?? []), ...state.builds]
          .filter(item => item.id !== build.id && item.branch === build.branch && item.base === build.base && item.plan === build.plan)
          .flatMap(item => item.attempts.map(row => ({task: row.task, preserved: item.preserved ?? {}})))
          .filter(row => row.task !== attempt.task);
        const run = await store.getRun(attempt.task);
        let paths;
        try { paths = await audit.recoverHandoff(build, run.task, loop, earlier); }
        catch (error) {
          await publishAttention(build, attempt, error.message);
          return;
        }
        if (paths) {
          recovery = {kind: 'handoff', paths};
          deadline = Date.now();
        }
      }
    }
    if (attempt.errorCode === 'PROVIDER_CALL_TIMEOUT' &&
        ['plan', 'plan_review', 'build_review', 'final_review'].includes(attempt.step)) {
      const role = buildStageRoles[attempt.step];
      const run = await store.getRun(attempt.task);
      const pinned = selectedProfile(run.task.profile);
      const saved = selectedProfile(await store.getProfile());
      if (pinned?.stages[role]?.timeoutSeconds === undefined && saved?.stages[role]?.timeoutSeconds === undefined) {
        const defaults = WorkbenchProfile.providerLimits(pinned, run.task.profile.active, role);
        recovery = {kind: 'stageTimeout', role, budgetResetAt: attempt.budgetResetAt ?? null,
          timeoutSeconds: Math.min(1800, defaults.timeoutSeconds * 2)};
        deadline = Date.now();
      }
    }
    const tried = build.attempts.some(row => row.task === attempt.task && isDeepStrictEqual(row.automaticRecovery, recovery));
    if (!Number.isFinite(deadline) || tried) {
      try { await publishAttention(build, attempt); }
      catch (error) {
        if (error.message === 'This checkout already has an active Workbench operation.') scheduleRecovery(refreshRecovery, 1000);
        else throw error;
      }
      return;
    }
    const wait = deadline - Date.now();
    if (wait > 0) {
      scheduleRecovery(refreshRecovery, wait);
      return;
    }
    try {
      await drive(state => {
        const next = state.builds.at(-1);
        if (next?.id !== build.id || next.status !== 'failed' || next.attempts.at(-1)?.id !== attempt.id) {
          throw Error('The run has already changed.');
        }
        return next;
      }, undefined, false, recovery);
    } catch (error) {
      if (error.message === 'This checkout already has an active Workbench operation.') scheduleRecovery(refreshRecovery, 1000);
      else await publishAttention(build, attempt, error.message);
    }
  }

  async function cancel(payload) {
    let execution;
    const state = await design.edit(state => {
      const build = current(state, payload.build);
      if (['cancelling', 'cancelled'].includes(build.status)) return;
      if (build.status !== 'working') throw Error('Select the active build.');
      const attempt = build.attempts.at(-1);
      execution = jobs.get(attempt.job);
      if (!execution?.job.cancellable || execution.job.state !== 'running') {
        throw Error('This job is finalizing. Refresh its status before continuing.');
      }
      build.status = execution.job.state = 'cancelling';
    });
    execution?.controller.abort();
    return state;
  }
  async function reconnect(payload) {
    const state = await design.read();
    const build = current(state, payload.build);
    if (!pendingStates.includes(build.status)) return state;
    const attempt = build.attempts.at(-1);
    if (jobs.get(attempt.job)?.active) return state;
    if (closing || recoverySuspended) throw Error('Branch Review is closing or switching projects.');
    operations++;
    let release;
    let handedOff = false;
    try {
      release = await files.acquire(leasePath);
      const fresh = await design.read();
      const latest = fresh.builds.at(-1);
      if (latest?.id !== build.id || latest.attempts.at(-1)?.id !== attempt.id || !pendingStates.includes(latest.status)) return fresh;
      const loop = await files.read(statePath(attempt.task), {});
      const result = await readJob(attempt.task, attempt.job);
      if (!result && loop.stage === 'finish' && (loop.design_sha || loop.commitIntent) &&
          latest.branch === fresh.branch && approved(fresh, latest)) {
        const {task} = await store.getRun(attempt.task);
        const committed = loop.design_sha || await audit.findPendingCommit(task, latest, loop).catch(() => null);
        if (committed) {
          start({build: latest, attempt, task, step: 'finish', runtimeProfile: attempt.runtimeProfile}, release);
          handedOff = true;
          return fresh;
        }
      }
      const completed = loop.stage === 'completed' || decisionStages.includes(loop.stage);
      const detail = loop.history?.at(-1)?.detail;
      const recordedError = ['evidence_blocked', 'stopped'].includes(loop.stage) &&
        (typeof detail === 'string' ? detail : detail?.reason);
      const job = result ?? {id: attempt.job, task_id: attempt.task, step: loop.stage, started_at: attempt.started,
        state: completed ? 'completed' : latest.status === 'cancelling' ? 'cancelled' : 'failed', cancellable: false,
        finished_at: now(), error: completed ? '' : recordedError || 'Recovered the saved build checkpoint.'};
      if (job.state === 'cancelled') await store.pause(attempt.task, 'Task cancelled.').catch(() => {});
      if (!result && assetPattern.test(attempt.job ?? '')) await files.write(loopPath(attempt.task) + '/jobs/' + attempt.job + '.json', job);
      await recordResult(build.id, job, loop);
      return design.read();
    } finally {
      try { if (!handedOff) await release?.(); }
      finally { operations--; }
    }
  }

  const readJob = (task, job) => assetPattern.test(job ?? '') ? files.read(loopPath(task) + '/jobs/' + job + '.json') : null;

  async function reviewed(build, group) {
    const attempt = build.attempts.findLast(row => row.outcome === 'completed' && group.slices.includes(row.slice));
    if (!group.sha || !attempt?.task) return {status: 'waiting', message: 'Complete the task checks before Branch Review.'};
    const url = '/?workbenchRun=' + encodeURIComponent(attempt.task) + '#workbench';
    if (!review) return {runId: attempt.task, status: 'waiting', url};
    const result = await review(attempt.task);
    if (result.runId !== attempt.task || (result.status !== 'not-exported' &&
        (result.ref !== 'refs/heads/' + build.branch || result.commit !== group.sha ||
          (result.base != null && result.base !== group.base)))) {
      throw Error('The Branch Review handoff differs from this group.');
    }
    return {...result, url};
  }

  async function decision(operation, payload) {
    const release = await files.acquire(leasePath);
    try {
      return await design.edit(async state => {
        const build = current(state, payload.build);
        if (operation === 'retire') {
          if (pendingStates.includes(build.status) || closedStates.includes(build.status)) throw Error('Stop the current run before retiring the build.');
          const last = build.attempts.at(-1);
          const running = await active();
          if (running && last?.task === running.id && running.lifecycle.status === 'active') await store.pause(last.task, 'Build retired.');
          Object.assign(build, {status: 'retired', retired: true});
          return;
        }
        const group = groupAt(build, payload.group ?? 0);
        const sha = group.sha;
        if (!sha || sha !== payload.sha || (payload.slices != null && !isDeepStrictEqual(group.slices, payload.slices)) ||
            !approved(state, build) || state.branch !== build.branch || build.retired) {
          throw Error('The review target changed. Refresh Branch Review.');
        }
        await audit.ensureCleanTarget(build, sha);
        const result = await reviewed(build, group);
        if (!result.reviewId || result.reviewedCommit !== sha || result.base !== group.base ||
            (payload.reviewId != null && payload.reviewId !== result.reviewId)) {
          throw Error('Select this exact commit in Branch Review.');
        }
        if (operation === 'finding') {
          if (result.status !== 'changes-requested' || !['review', 'closed'].includes(build.status)) {
            throw Error('Select changes requested in Branch Review.');
          }
          const findings = new Map(result.findings.filter(row => row.status !== 'resolved').map(row => [row.id, row]));
          const picked = payload.findingIds ?? [...findings.keys()];
          if (!Array.isArray(picked) || !picked.length || new Set(picked).size !== picked.length || picked.some(key => !findings.has(key))) {
            throw Error('Select findings from this review.');
          }
          const selected = picked.map(key => findings.get(key));
          const slices = build.mode === 'task' ? group.slices : payload.affected ?? group.slices;
          if (!Array.isArray(slices) || !slices.length || slices.some(key => !group.slices.includes(key))) {
            throw Error('Select the affected scope.');
          }
          group.findings.push({slices, text: selected.map(item => item.actual + '\nExpected: ' + item.expected).join('\n\n'),
            branchReviewFindings: picked, sha, time: now(), repaired: false, findings: selected, reviewId: result.reviewId, runId: result.runId});
          Object.assign(group, {sha: null, pending: [...slices]});
          Object.assign(build, {status: 'ready', index: build.groups.indexOf(group)});
          return;
        }
        if (result.status !== 'approved' || !result.approval?.reviewer || !result.checklist?.length ||
            result.checklist.some(item => !['passed', 'not-applicable'].includes(item.status)) ||
            result.findings?.length || group.pending.length || group.findings.some(item => !item.repaired) ||
            !isDeepStrictEqual(result.slices?.map(item => item.id), group.slices)) {
          throw Error('Complete and approve this exact commit in Branch Review.');
        }
        const saved = group.reviews.at(-1);
        if (operation === 'review') {
          if (saved?.sha === sha && saved.reviewId === result.reviewId && saved.runId === result.runId) return;
          if (build.status !== 'review' || group !== currentGroup(build)) throw Error('Select the current review.');
          group.reviews.push({sha, slices: [...group.slices], checklist: result.checklist, branch: build.branch,
            author: result.approval.reviewer, time: result.approval.at, pushTarget: result.pushTarget,
            reviewId: result.reviewId, runId: result.runId});
          build.index = build.groups.findIndex(item => item.reviews.at(-1)?.sha !== item.sha);
          if (build.index < 0) build.index = build.groups.length;
          build.status = build.index === build.groups.length ? 'closed' : 'ready';
        } else if (operation === 'push') {
          if (saved?.sha !== sha || saved.reviewId !== result.reviewId || saved.runId !== result.runId) throw Error('Record the current approval first.');
          if (!push || !payload.expectedTarget || payload.expectedTarget !== result.pushTarget) throw Error('Confirm the current GitHub destination.');
          const start = performance.now();
          const receipt = await push({runId: result.runId, commit: sha, expectedTarget: payload.expectedTarget});
          if (receipt.commit !== sha || receipt.ref !== result.ref || receipt.repository !== payload.expectedTarget) {
            throw Error('Branch Review could not confirm the requested remote branch.');
          }
          group.pushed = {sha, destination: receipt.remote, ref: receipt.ref, time: now(), milliseconds: performance.now() - start};
        } else {
          throw Error('Unknown review action.');
        }
      });
    } finally { await release(); }
  }

  async function runStandalone(running, payload, message) {
    if (closing || recoverySuspended) throw Error('Branch Review is closing or switching projects.');
    const release = await files.acquire(leasePath);
    let started = false;
    try {
      const {task, lifecycle} = running;
      if (lifecycle.status !== 'active') throw Error('Resume or start a task before running it.');
      const agreement = await store.questions(task.id);
      if (agreement.missing_required.length) throw Error('Record the required task answers before running it.');
      const loop = await files.read(statePath(task.id), {});
      if (loop.stage === 'stopped') throw Error('This task reached its recorded stop condition.');
      if (decisionStages.includes(loop.stage)) {
        validateReply(loop, task.id, payload, message);
      } else if (message !== '/run') {
        throw Error('Use /run to continue this task.');
      }
      const branch = task.initial_snapshot.branch?.replace(/^refs\/heads\//, '');
      const base = task.initial_snapshot.head;
      if (!base || await commitment(git, branch) !== base) throw Error('Restore the task branch and starting commit.');
      const build = {standalone: true, branch, base, index: 0, title: task.action, plan: task.scope,
        attachments: {}, preserved: {}, groups: [{findings: []}], decisions: agreement.answers};
      const attempt = {id: id(), job: id(), task: task.id, started: now(), outcome: 'running'};
      const job = start({build, attempt, task, answer: pendingReply(loop) ? message : undefined}, release);
      started = true;
      return job;
    } finally {
      if (!started) await release();
    }
  }

  async function chat(payload) {
    const message = sentence(payload.message, 'a message');
    const state = await design.read();
    const build = state.builds.at(-1);
    const running = await active();
    if (running && build?.attempts.at(-1)?.task !== running.id) return runStandalone(running, payload, message);
    if (!build) throw Error('Start a task to use Live run.');
    if (message === '/run' && build.status !== 'question') {
      return (await drive(currentState => {
        const next = current(currentState, build.id);
        if (!['ready', 'failed', 'cancelled'].includes(next.status)) throw Error('This build is waiting for another action.');
        return next;
      })).job;
    }
    return (await drive(async currentState => {
      const next = current(currentState, build.id);
      const task = next.attempts.at(-1)?.task;
      const loop = task && await files.read(statePath(task));
      if (next.status !== 'question') throw Error('The pending build decision changed.');
      validateReply(loop, task, payload, message);
      return next;
    }, message === '/run' ? undefined : message)).job;
  }

  async function events({id: run, after = 0}) {
    if (!runPattern.test(run ?? '')) throw Error('Select a project run.');
    await store.getRun(run);
    const cursor = Number(after);
    const bytes = await files.bytes(loopPath(run) + '/activity.jsonl', 32_000_000, Buffer.alloc(0));
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > bytes.length || (cursor && bytes[cursor - 1] !== 10)) {
      throw Error('Unknown activity cursor.');
    }
    let offset = cursor;
    const events = [];
    while (events.length < 200) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) break;
      const row = JSON.parse(bytes.subarray(offset, end));
      offset = end + 1;
      events.push({...row, cursor: offset});
    }
    return {events, cursor: offset};
  }

  async function live() {
    const state = await design.read();
    const candidate = state.builds.at(-1);
    const last = candidate?.attempts.at(-1);
    const running = await active() ?? (candidate?.status !== 'retired' && last ? await store.getRun(last.task) : null);
    const loop = running ? await files.read(statePath(running.id), {}) : {};
    const task = running ? {id: running.id, status: running.lifecycle.status, lifecycle: running.lifecycle,
      action: running.action, answers: Object.fromEntries((running.answers ?? []).map(item => [item.question, item.option])),
      ...pendingReply(loop),
      ...(loop.stage === 'question_retry' ? {question_error: loop.question_error} : {})} : null;
    const jobsData = [...jobs.values()].map(entry => entry.job);
    if (last && !jobs.has(last.job)) {
      const saved = await readJob(last.task, last.job);
      if (saved) jobsData.push(saved);
    }
    const {questions} = await store.questions(running?.id);
    return {active_task: task, jobs: jobsData, questions, coordinator_running: jobsData.some(job => ['running', 'cancelling'].includes(job.state)),
      design_question: state.question, design_retry: state.plannerRetry, design_revision: state.revision};
  }

  async function progress() {
    const state = await design.read();
    const build = state.builds.at(-1);
    const attempt = build?.attempts.at(-1);
    const group = build && currentGroup(build);
    const buildStamp = {revision: state.revision, approved: state.approved, build: build?.id ?? null,
      status: build?.status ?? null, index: build?.index ?? null, error: build?.error ?? null, attempt: attempt ?? null,
      groups: (build?.groups ?? []).map(row => ({sha: row.sha, approval: row.reviews.at(-1) ?? null, pushed: row.pushed ?? null}))};
    if (!attempt || build.status === 'retired') return {run: null, review: null, buildStamp};
    const task = await store.getRun(attempt.task);
    const loop = await files.read(statePath(attempt.task), {});
    const checks = (await store.executionConfig(attempt.task)).checks;
    const statuses = evidence => Object.fromEntries(Object.entries(evidence).map(([key, row]) => [key, row.status]));
    const visits = buildTrace(loop.history);
    const metrics = await metricsFor(attempt.task, build, visits);
    const windows = build.attempts.filter(row => row.task === attempt.task);
    const attempts = visits.map(visit => {
      const {id, role, stage, time, entry} = visit;
      return {id, role, stage, time,
        metrics: visitMetrics(visit, windows, metrics,
          ['baseline', 'checks'].includes(role) ? checkRows(task, visit) : []),
        reason: (typeof entry.detail === 'string' ? entry.detail : entry.detail?.reason ?? '').slice(0, 1200),
        evidence: statuses(stageEvidence(task, build, visit, visits))};
    });
    const tail = attempts.at(-1);
    const blockedStage = loop.stage === 'evidence_blocked' ? loop.history?.at(-1)?.detail?.stage : null;
    const failedRole = buildStageRoles[blockedStage] || tail?.role || buildStageRoles[attempt.step];
    let failure = null;
    if (build.status === 'failed' && build.error && failedRole) {
      const saved = await store.getProfile();
      const stage = failedRole === 'repair' ? 'build' : failedRole;
      const changed = changedAgents(task.task.profile, saved);
      failure = {role: failedRole, message: build.error.slice(0, 4000), repairLimit: task.lifecycle.cause === 'repair_limit',
        resumeBlocker: await resumeBlocker(build, task),
        providerLimit: await providerLimitFor(attempt, task), errorCode: attempt.errorCode ?? null,
        savedAgent: changed.includes(stage) ? agentSettings(selectedProfile(saved).stages[stage]) : null};
    }
    const activity = await files.bytes(loopPath(attempt.task) + '/activity.jsonl', 32_000_000, Buffer.alloc(0));
    const tailStart = Math.max(0, activity.length - 65536);
    const lines = activity.subarray(tailStart ? activity.indexOf(10, tailStart) + 1 : 0).toString('utf8').split('\n').slice(0, -1);
    const latest = lines.filter(Boolean).map(line => JSON.parse(line))
      .filter(row => tail && Date.parse(row.timestamp) / 1000 >= tail.time - 0.01 && row.stage === tail.stage)
      .map(row => ({time: row.timestamp, text: row.activity, actor: row.actor}));
    return {buildStamp, run: {id: attempt.task, title: task.action, stage: loop.stage ?? '', lifecycle: task.lifecycle.status,
      running: pendingStates.includes(build.status), attempts, events: latest, failure,
      evidenceRequest: loop.stage === 'evidence' ? {role: buildStageRoles[loop.evidenceRequest.stage], text: loop.evidenceRequest.text} : null,
      stages: selectedProfile(task.task.profile)?.stages ?? {}, checks,
      ...(build.automaticRouting && {routing: task.task.cosmetic_route && !loop.fullAudit ? 'visual' :
        loop.fullAudit ? 'expanded' : 'full'}),
      question: ['question', 'question_retry'].includes(loop.stage) ? loop.question : ''},
      review: {waiting: build.status === 'review', approved: !!group.sha && group.reviews.at(-1)?.sha === group.sha,
        ...(group.sha && !group.pending.length && {target: {build: build.id, group: build.index}}),
        pushed: !!group.sha && group.pushed?.sha === group.sha,
        pushMs: group.pushed?.sha === group.sha ? group.pushed?.milliseconds : undefined,
        evidence: {humanReview: statuses(gateEvidence('humanReview', build, group)),
          push: statuses(gateEvidence('push', build, group))}}};
  }

  async function conversationContext(build) {
    if (!build || build.status === 'retired') return null;
    const attempt = build.attempts.at(-1);
    const loop = attempt ? await files.read(statePath(attempt.task), {}) : {};
    const detail = loop.history?.at(-1)?.detail;
    const step = buildStageRoles[detail?.stage ?? loop.stage] ?? buildStageRoles[attempt?.step];
    const stage = WorkbenchProfile.roles.find(role => role.id === step)?.name ??
      ({baseline: 'Baseline checks', repair: 'Repair', checks: 'Project checks'})[step];
    return {id: build.id, title: build.title || 'Current build', state: build.status, stage,
      pendingQuestion: build.status === 'question' ? loop.question : undefined,
      waitingForReview: build.status === 'review', failure: build.error?.slice(0, 4000),
      activity: typeof detail === 'string' ? detail.slice(0, 800) : detail?.reason?.slice(0, 800)};
  }

  async function step({task: id, visit, role, key, output}) {
    if (!runPattern.test(id ?? '')) throw Error('Select a recorded build step.');
    const state = await design.read();
    const build = [...(state.archivedBuilds ?? []), ...state.builds].findLast(row => row.attempts.some(item => item.task === id));
    if (!build) throw Error('Select a recorded build step.');
    let evidence, metrics;
    if (['humanReview', 'push'].includes(role)) {
      const group = build.groups.find(row => row.sha && build.attempts.some(item => item.task === id && item.sha === row.sha));
      const review = group && role === 'humanReview' ? await reviewed(build, group).catch(() => null) : null;
      evidence = gateEvidence(role, build, group, review);
    } else {
      const trace = buildTrace((await files.read(statePath(id), {})).history);
      const found = trace.find(row => row.id === visit && row.role === role);
      if (!found) throw Error('Select a recorded build step.');
      const run = await store.getRun(id);
      evidence = stageEvidence(run, build, found, trace);
      metrics = visitMetrics(found, build.attempts.filter(row => row.task === id),
        await metricsFor(id, build, trace), ['baseline', 'checks'].includes(role) ? checkRows(run, found) : []);
    }
    const timing = Object.hasOwn(metrics?.steps ?? {}, key) ? metrics.steps[key] : undefined;
    const record = Object.hasOwn(evidence, key) ? evidence[key] :
      timing ? {status: timing.runningSince == null ? 'Timing recorded' : 'Running', sections: []} : null;
    if (!record) throw Error('This step has no saved evidence.');
    if (output !== undefined) {
      const row = record.sections.flatMap(section => section.checks ?? []).find(check => check.id === output);
      if (!row) throw Error('Select a recorded check.');
      const read = stream => store.readRunRecord(id, row.evidence_path + '/' + stream + '.log')
        .then(value => value.toString('utf8'));
      const [stdout, stderr] = await Promise.all([read('stdout'), read('stderr')]);
      return {stdout, stderr};
    }
    return {...record, timing, ...(key === '1' && metrics?.providers.length && {providers: metrics.providers})};
  }

  async function history() {
    const state = await design.read();
    const rows = [];
    for (const build of [...(state.archivedBuilds || []), ...state.builds]) {
      for (const attempt of build.attempts) {
        const loop = await files.read(statePath(attempt.task), {});
        const start = Date.parse(attempt.started) / 1000;
        const end = attempt.finished ? Date.parse(attempt.finished) / 1000 : Infinity;
        const entries = (loop.history ?? []).filter(row => row.time >= start && row.time <= end);
        const counts = new Map();
        const transitions = entries.map((row, index) => {
          const next = entries[index + 1];
          const number = (counts.get(row.stage) ?? 0) + 1;
          counts.set(row.stage, number);
          return {stage: row.stage, time: row.time, number, outcome: next?.detail?.verdict ?? (next ? 'advanced' : attempt.outcome),
            reason: typeof row.detail === 'string' ? row.detail : row.detail?.reason ?? ''};
        });
        rows.push({...attempt, build: build.id, active: !attempt.finished && pendingStates.includes(build.status),
          title: build.roadmap.flatMap(milestone => milestone.slices).find(slice => slice.id === attempt.slice)?.title,
          step: attempt.step ?? loop.stage, transitions});
      }
    }
    return rows;
  }

  async function summary() {
    const state = await design.read();
    return {builds: [...(state.archivedBuilds || []), ...state.builds].reverse().map(build => {
      const groups = build.groups.filter(row => row.sha && row.reviews.at(-1)?.sha === row.sha);
      const findings = build.groups.flatMap(row => row.findings);
      const elapsed = build.attempts.reduce((seconds, attempt) => seconds + (attempt.finished ?
        Math.max(0, Date.parse(attempt.finished) - Date.parse(attempt.started)) / 1000 : 0), 0);
      return {build: build.id, branch: build.branch, planRevision: build.revision, status: build.status,
        plannedSlices: build.groups.flatMap(row => row.slices).length, approvedSlices: groups.flatMap(row => row.slices).length,
        pushedGroups: groups.filter(row => row.pushed?.sha === row.sha).length, attempts: build.attempts.length,
        finishedAttempts: build.attempts.filter(row => row.finished).length, findings: findings.length,
        repairedFindings: findings.filter(row => row.repaired).length, runSeconds: Number(elapsed.toFixed(3)),
        providerCost: null, activeReviewerMinutes: null};
    })};
  }

  const busy = () => operations > 0 || [...jobs.values()].some(entry => entry.active);
  void refreshRecovery(true).catch(() => {});
  return {launch, advance, retryVerification, verificationAvailable, restartRequired, cancel, reconnect, decision, readiness, chat, live, history, progress, attention, conversationContext, step, events, summary, resumeBlocker, busy,
    suspendRecovery() {
      if (busy() || closing || recoverySuspended) throw Error('Finish or cancel the active build before leaving this project.');
      recoverySuspended = true;
      clearTimeout(recoveryTimer);
      return () => {
        recoverySuspended = false;
        void refreshRecovery(true).catch(() => {});
      };
    },
    async group(payload) {
      const build = current(await design.read(), payload.build);
      return reviewed(build, groupAt(build, payload.group));
    },
    async evidence(payload) {
      const build = current(await design.read(), payload.build);
      const group = groupAt(build, payload.group);
      if (!group.sha) throw Error('Wait for the review commit.');
      return {sha: group.sha, branch: build.branch, diff: await git('diff', '--no-ext-diff', '--no-textconv', group.base, group.sha, '--')};
    },
    async cancelJob(payload) {
      const build = (await design.read()).builds.at(-1);
      if (build?.attempts.at(-1)?.job === payload.id) return cancel({build: build.id});
      const entry = jobs.get(payload.id);
      if (!entry?.job.cancellable || entry.job.state !== 'running') throw Error('Select the active job.');
      entry.job.state = 'cancelling';
      entry.controller.abort();
      return {...entry.job};
    },
    async job(payload) {
      let job = jobs.get(payload.id)?.job;
      if (!job && assetPattern.test(payload.id ?? '')) {
        const state = await design.read();
        const attempt = [...state.builds, ...(state.archivedBuilds ?? [])].flatMap(build => build.attempts)
          .find(row => row.job === payload.id);
        const task = attempt?.task ?? (await active())?.id;
        if (task) job = await readJob(task, payload.id);
      }
      if (!job) throw Error('Unknown job.');
      return {...job, events: [], next_cursor: 0};
    },
    async close() {
      closing = true;
      clearTimeout(recoveryTimer);
      const executions = [...jobs.values()].filter(entry => entry.active);
      for (const {job, controller} of executions) if (job.cancellable) controller.abort();
      await Promise.all(executions.map(entry => entry.done));
    }
  };
}
