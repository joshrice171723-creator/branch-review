import {isDeepStrictEqual} from 'node:util';
import {id, now, runPattern, sentence} from './files.mjs';
import {checkMode, hash, jsonHash, selectedProfile} from './design.mjs';
import {commitment, currentGroup, loopPath, markerPath, statePath} from './audit.mjs';
import {buildStageRoles, buildTrace, gateEvidence, stageEvidence} from './step-evidence.mjs';

const leasePath = '.harness/design/build.owner';
const pendingStates = ['working', 'cancelling'];
const closedStates = ['closed', 'retired'];
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
  async function resumeBlocker(build, run) {
    const attempt = build?.attempts.at(-1);
    if (!attempt || !['failed', 'cancelled'].includes(build.status)) return '';
    const pinned = run ?? await store.getRun(attempt.task);
    return changedAgents(pinned.task.profile, await store.getProfile()).length ? workflowChangedMessage(build) : '';
  }
  async function profileMatches(build, profile) {
    if (build.profile === jsonHash(profile)) return true;
    const bytes = await files.bytes('.harness/profile.json', 4_000_000, null);
    return !!bytes && hash(bytes) === build.profile;
  }

  async function readiness() {
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
    const items = [
      check('plan', plan, plan ? 'The current draft is approved.' : 'Resolve planning and approve the current draft.'),
      await test('profile', ensureProfile, 'A workflow profile is applied.'),
      ...(await checkProviders(await store.getProfile())).map(row =>
        check(row.id, providerReady(row), providerMessage(row))),
      await test('checks', ensureChecks, 'Required project checks are configured.'),
      await test('branch', () => commitment(git, state.branch), 'The configured branch is checked out.'),
      check('review', !!review, review ? 'Branch Review is ready.' : 'Open the completed commit in Branch Review.'),
      check('native', native, native ? 'No unfinished build or active task.' : 'Finish or pause the current build or task.')
    ];
    return {ready: items.filter(row => row.id !== 'review').every(row => row.status === 'ready'), items};
  }

  async function newAttempt(state, build, answer) {
    if (!approved(state, build)) throw Error('The approved plan changed. Retire this build before continuing.');
    if (state.branch !== build.branch) throw Error('Restore the configured branch before continuing.');
    const previous = build.attempts.at(-1);
    const group = currentGroup(build);
    group.base ??= build.base;
    const member = group.pending[0];
    if (!member) throw Error('This group is waiting for Branch Review.');
    const prior = previous?.slice === member && previous.outcome !== 'completed'
      ? await store.getRun(previous.task) : null;
    const blocker = await resumeBlocker(build, prior);
    if (blocker) throw Error(blocker);
    let task = prior && ['active', 'paused', 'completed'].includes(prior.lifecycle.status) ? prior.task : null;
    if (task) {
      const loop = await files.read(statePath(task.id));
      if (loop?.stage === 'stopped') throw Error('The audit return limit was reached. Retire this build before continuing.');
      if (prior.lifecycle.status === 'paused') await store.resume(task.id);
    } else {
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
    const attempt = {id: id(), job: id(), slice: member, task: task.id, started: now(), outcome: 'running',
      reason: group.findings.at(-1)?.text ?? previous?.error ?? ''};
    build.attempts.push(attempt);
    build.status = 'working';
    delete build.error;
    return {build: structuredClone(build), attempt, task, answer};
  }

  async function recordResult(buildId, job, loop) {
    await design.edit(state => {
      const build = current(state, buildId);
      const attempt = build.attempts.find(row => row.job === job.id);
      if (!attempt || attempt.finished) return;
      const group = currentGroup(build);
      Object.assign(attempt, {outcome: job.state, finished: now(), step: loop?.stage, error: job.error ?? ''});
      if (loop?.stage === 'completed' && job.state === 'completed' && loop.design_sha) {
        attempt.sha = group.sha = build.base = loop.design_sha;
        group.pending = group.pending.filter(member => member !== attempt.slice);
        for (const finding of group.findings) {
          if (!finding.slices.some(member => group.pending.includes(member))) finding.repaired = true;
        }
        build.status = group.pending.length ? 'ready' : 'review';
      } else if (job.state === 'cancelled') {
        build.status = 'cancelled';
      } else if (['question', 'question_retry'].includes(loop?.stage)) {
        build.status = 'question';
        attempt.outcome = loop.stage === 'question' ? 'waiting for answer' : 'retry suggestions';
      } else {
        build.status = 'failed';
        build.error = job.error ?? loop?.finding ?? 'The build stopped before verification.';
      }
    });
  }

  function start(prepared, release) {
    const {build, attempt, task} = prepared;
    const controller = new AbortController();
    const job = {id: attempt.job, task_id: task.id, state: 'running', started_at: attempt.started, step: 'plan',
      cancellable: true, response: '', error: null};
    const execution = {job, controller};
    jobs.set(job.id, execution);
    execution.done = (async () => {
      let loop;
      try {
        loop = await audit.workflow({...prepared, signal: controller.signal,
          setCancellable: value => { job.cancellable = value; },
          refresh: stage => { job.step = stage; },
          validateTarget: build.standalone ? undefined : async () => {
            const state = await design.read();
            if (current(state, build.id).attempts.at(-1).task !== task.id || !approved(state, build) ||
                state.branch !== build.branch) throw Error('The approved plan or configured branch changed.');
          }});
        job.response = loop.stage === 'completed' ? loop.summary ?? 'Verified for Branch Review.' :
          loop.stage === 'question' ? loop.question : '';
        job.state = loop.stage === 'stopped' ? 'failed' : 'completed';
        if (loop.stage === 'stopped') job.error = loop.finding;
      } catch (error) {
        loop = await files.read(statePath(task.id), {}).catch(() => ({}));
        job.state = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = controller.signal.aborted ? 'Task cancelled.' : error.message;
        await audit.activity(task.id, loop.stage ?? 'plan', 'Workbench', job.error).catch(() => {});
        if (controller.signal.aborted) await store.pause(task.id, 'Task cancelled.').catch(() => {});
      } finally {
        job.cancellable = false;
        try {
          await files.write(loopPath(task.id) + '/jobs/' + job.id + '.json', job);
          if (!build.standalone) await recordResult(build.id, job, loop);
        } catch (error) {
          job.state = 'failed';
          job.error = error.message;
        } finally { await release(); }
      }
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

  async function drive(change, answer) {
    const release = await files.acquire(leasePath);
    let handedOff = false;
    try {
      let prepared;
      const state = await design.edit(async state => {
        const build = await change(state);
        prepared = await newAttempt(state, build, answer);
      });
      const job = start(prepared, release);
      handedOff = true;
      return {state, job};
    } finally {
      if (!handedOff) await release();
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
      await ensureChecks();
      const blockers = (await checkProviders(profile)).filter(row => !providerReady(row));
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
      return build;
    })).state;
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
    if (pendingStates.includes(jobs.get(attempt.job)?.job.state) || jobs.get(attempt.job)?.job.state === 'running') return state;
    const release = await files.acquire(leasePath);
    try {
      const loop = await files.read(statePath(attempt.task), {});
      const result = attempt.job ? await files.read(loopPath(attempt.task) + '/jobs/' + attempt.job + '.json') : null;
      const job = result ?? {id: attempt.job,
        state: loop.stage === 'completed' || loop.stage === 'question' || loop.stage === 'question_retry' ? 'completed' :
          build.status === 'cancelling' ? 'cancelled' : 'failed',
        error: loop.stage === 'completed' ? '' : 'Recovered the saved build checkpoint.'};
      if (job.state === 'cancelled') await store.pause(attempt.task, 'Task cancelled.').catch(() => {});
      await recordResult(build.id, job, loop);
      return design.read();
    } finally { await release(); }
  }

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
          const receipt = await push({runId: result.runId, commit: sha, expectedTarget: payload.expectedTarget});
          if (receipt.commit !== sha || receipt.ref !== result.ref || receipt.repository !== payload.expectedTarget) {
            throw Error('Branch Review could not confirm the requested remote branch.');
          }
          group.pushed = {sha, destination: receipt.remote, ref: receipt.ref, time: now()};
        } else {
          throw Error('Unknown review action.');
        }
      });
    } finally { await release(); }
  }

  async function runStandalone(running, payload, message) {
    const release = await files.acquire(leasePath);
    let started = false;
    try {
      const {task, lifecycle} = running;
      if (lifecycle.status !== 'active') throw Error('Resume or start a task before running it.');
      const agreement = await store.questions(task.id);
      if (agreement.missing_required.length) throw Error('Record the required task answers before running it.');
      const loop = await files.read(statePath(task.id), {});
      if (loop.stage === 'stopped') throw Error('This task reached its recorded stop condition.');
      if (loop.stage === 'question') {
        if (payload.task !== task.id || payload.question !== loop.question || payload.question_id !== loop.question_id ||
            message === '/run') throw Error('Answer the current task question.');
      } else if (message !== '/run') {
        throw Error('Use /run to continue this task.');
      }
      const branch = task.initial_snapshot.branch?.replace(/^refs\/heads\//, '');
      const base = task.initial_snapshot.head;
      if (!base || await commitment(git, branch) !== base) throw Error('Restore the task branch and starting commit.');
      const build = {standalone: true, branch, base, index: 0, title: task.action, plan: task.scope,
        attachments: {}, preserved: {}, groups: [{findings: []}], decisions: agreement.answers};
      const attempt = {id: id(), job: id(), task: task.id, started: now(), outcome: 'running'};
      const job = start({build, attempt, task, answer: loop.stage === 'question' ? message : undefined}, release);
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
      if (next.status !== 'question' || (message === '/run' ? loop?.stage !== 'question_retry' :
          loop?.stage !== 'question' || payload.task !== task || payload.question !== loop.question || payload.question_id !== loop.question_id)) {
        throw Error('The pending build decision changed.');
      }
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
      ...(loop.stage === 'question' ? {question: loop.question, question_id: loop.question_id, suggestions: loop.suggestions} : {}),
      ...(loop.stage === 'question_retry' ? {question_error: loop.question_error} : {})} : null;
    const jobsData = [...jobs.values()].map(entry => entry.job);
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
    const attempts = visits.map(visit => {
      const {id, role, stage, time, entry} = visit;
      return {id, role, stage, time,
        reason: (typeof entry.detail === 'string' ? entry.detail : entry.detail?.reason ?? '').slice(0, 1200),
        evidence: statuses(stageEvidence(task, build, visit, visits))};
    });
    const tail = attempts.at(-1);
    const failedRole = tail?.role || buildStageRoles[attempt.step];
    let failure = null;
    if (build.status === 'failed' && build.error && failedRole) {
      const saved = await store.getProfile();
      const stage = failedRole === 'repair' ? 'build' : failedRole;
      const changed = changedAgents(task.task.profile, saved);
      failure = {role: failedRole, message: build.error.slice(0, 4000),
        resumeBlocker: changed.length ? workflowChangedMessage(build) : '',
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
      stages: selectedProfile(task.task.profile)?.stages ?? {}, checks,
      question: ['question', 'question_retry'].includes(loop.stage) ? loop.question : ''},
      review: {waiting: build.status === 'review', approved: !!group.sha && group.reviews.at(-1)?.sha === group.sha,
        pushed: !!group.sha && group.pushed?.sha === group.sha,
        evidence: {humanReview: statuses(gateEvidence('humanReview', build, group)),
          push: statuses(gateEvidence('push', build, group))}}};
  }

  async function step({task: id, visit, role, key, output}) {
    if (!runPattern.test(id ?? '')) throw Error('Select a recorded build step.');
    const state = await design.read();
    const build = [...(state.archivedBuilds ?? []), ...state.builds].findLast(row => row.attempts.some(item => item.task === id));
    if (!build) throw Error('Select a recorded build step.');
    let evidence;
    if (['humanReview', 'push'].includes(role)) {
      const group = build.groups.find(row => row.sha && build.attempts.some(item => item.task === id && item.sha === row.sha));
      const review = group && role === 'humanReview' ? await reviewed(build, group).catch(() => null) : null;
      evidence = gateEvidence(role, build, group, review);
    } else {
      const trace = buildTrace((await files.read(statePath(id), {})).history);
      const found = trace.find(row => row.id === visit && row.role === role);
      if (!found) throw Error('Select a recorded build step.');
      evidence = stageEvidence(await store.getRun(id), build, found, trace);
    }
    const record = Object.hasOwn(evidence, key) ? evidence[key] : null;
    if (!record) throw Error('This step has no saved evidence.');
    if (output !== undefined) {
      const row = record.sections.flatMap(section => section.checks ?? []).find(check => check.id === output);
      if (!row) throw Error('Select a recorded check.');
      const read = stream => store.readRunRecord(id, row.evidence_path + '/' + stream + '.log')
        .then(value => value.toString('utf8'));
      const [stdout, stderr] = await Promise.all([read('stdout'), read('stderr')]);
      return {stdout, stderr};
    }
    return record;
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

  return {launch, advance, cancel, reconnect, decision, readiness, chat, live, history, progress, step, events, summary, resumeBlocker, busy: () => [...jobs.values()].some(({job}) => ['running', 'cancelling'].includes(job.state)),
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
    job(payload) {
      const job = jobs.get(payload.id)?.job;
      if (!job) throw Error('Unknown job.');
      return {...job, events: [], next_cursor: 0};
    },
    async close() {
      const executions = [...jobs.values()].filter(({job}) => job.state === 'running' || job.state === 'cancelling');
      for (const {job, controller} of executions) if (job.cancellable) controller.abort();
      await Promise.all(executions.map(entry => entry.done));
    }
  };
}
