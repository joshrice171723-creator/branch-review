import {execFile} from 'node:child_process';
import {lstat, readFile, readdir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {promisify} from 'node:util';
import {id, now, sentence} from './files.mjs';
import {hash, questionContract, resolveQuestion, selectedProfile, stageKeys} from './design.mjs';
import {appendMetric} from './build-metrics.mjs';
import {auditSchema, objectReply} from './provider.mjs';

const exec = promisify(execFile);
const policyFile = 'workbench-quality.json';
const criteriaIds = ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints'];
const stageNames = {
  plan: 'Plan', plan_review: 'Plan audit', baseline: 'Baseline checks', build: 'Build and repair', checks: 'Project checks',
  build_review: 'Build audit', final_review: 'Final audit', final_skip: 'Final audit', finish: 'Verify evidence'
};

export const loopPath = run => '.harness/loops/' + run;
export const statePath = run => loopPath(run) + '/state.json';
export const markerPath = run => loopPath(run) + '/design.json';
export const currentGroup = build => build.groups[Math.min(build.index, build.groups.length - 1)];
export const commitment = async (git, branch) => {
  if (!branch || typeof branch !== 'string') throw Error('Configure a destination branch.');
  await git('check-ref-format', 'refs/heads/' + branch);
  if (await git('symbolic-ref', '--quiet', '--short', 'HEAD') !== branch) throw Error('Check out the configured branch.');
  return git('rev-parse', '--verify', 'HEAD^{commit}');
};

async function relevantNotes(repository, vaults, request) {
  const words = new Set(request.toLowerCase().match(/[a-z0-9]{3,}/g));
  const matches = [];
  for (const vault of vaults ?? []) {
    const expanded = vault.replace(/^~(?=[\\/]|$)/, homedir());
    const root = await realpath(path.resolve(repository, expanded));
    if (!(await lstat(root)).isDirectory()) throw Error('Select a directory for the project notes.');
    const directories = [root];
    while (directories.length) {
      const directory = directories.shift();
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (entry.name.startsWith('.')) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) directories.push(file);
        if (!entry.isFile() || !/\.md$/i.test(entry.name) || (await lstat(file)).size > 512000) continue;
        for (const block of (await readFile(file, 'utf8')).split(/\r?\n\r?\n/)) {
          const terms = new Set((entry.name + ' ' + block).toLowerCase().match(/[a-z0-9]{3,}/g));
          const score = [...terms].filter(word => words.has(word)).length;
          if (!score) continue;
          matches.push({score, path: file, passage: block.slice(0, 1800)});
          matches.sort((left, right) => right.score - left.score);
          if (matches.length > 8) matches.pop();
        }
      }
    }
  }
  return matches.map(({path, passage}) => ({path, passage}));
}

export function createAudit({repository, files, git, store, agent}) {
  async function gitRaw(args) {
    return (await exec('git', args, {cwd: repository, windowsHide: true, timeout: 90000,
      maxBuffer: 64_000_000, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}})).stdout;
  }
  async function changes() {
    const rows = await gitRaw(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', '.', ':(exclude).harness']);
    return Object.fromEntries(rows.split('\0').filter(row => row && !row.startsWith('?? .idea/'))
      .map(row => [row.slice(3), row.slice(0, 2)]));
  }
  async function indexEntries(paths) {
    if (!Object.keys(paths).length) return {};
    const rows = await gitRaw(['ls-files', '--stage', '-z']);
    const index = new Map();
    for (const line of rows.split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      const name = line.slice(tab + 1);
      if (Object.hasOwn(paths, name)) index.set(name, [...index.get(name) ?? [], line.slice(0, tab)]);
    }
    return Object.fromEntries(index);
  }
  async function policyHash() {
    const policy = await files.bytes(policyFile, 4_000_000, null);
    return policy && hash(policy);
  }

  async function baseline() {
    const preserved = await changes();
    const preserved_index = await indexEntries(preserved);
    const policySha = await policyHash();
    return {preserved, preserved_index, policySha,
      ...(Object.hasOwn(preserved, policyFile) ? {preservedPolicySha: policySha} : {})};
  }

  async function assertPreserved(build, snapshot, task, dirty) {
    const policy = Object.hasOwn(build, 'policySha') ? build.policySha : build.preservedPolicySha;
    if (policy !== undefined && await policyHash() !== policy) {
      throw Error('The published Quality policy changed. Restore it before continuing.');
    }
    if (!isDeepStrictEqual(await indexEntries(build.preserved), build.preserved_index) ||
        Object.entries(build.preserved).some(([name, status]) => dirty[name] !== status ||
          snapshot.files[name] !== task.initial_snapshot.files[name])) {
      throw Error('The task overlaps existing working changes. Restore those files before continuing.');
    }
  }

  async function ensureCleanTarget(build, expectedCommit) {
    if (await commitment(git, build.branch) !== expectedCommit ||
        !isDeepStrictEqual(await changes(), build.preserved ?? {}) ||
        !isDeepStrictEqual(await indexEntries(build.preserved ?? {}), build.preserved_index ?? {}) ||
        (Object.hasOwn(build, 'policySha') && await policyHash() !== build.policySha) ||
        (Object.hasOwn(build, 'preservedPolicySha') && await policyHash() !== build.preservedPolicySha)) {
      throw Error('The checkout changed since the recorded baseline.');
    }
    if (Object.keys(build.preservedHashes ?? {}).length) {
      const {files} = await store.snapshot();
      if (Object.entries(build.preservedHashes).some(([name, digest]) => (files[name] ?? null) !== digest)) {
        throw Error('An existing working change differs from the recorded baseline.');
      }
    }
  }

  async function commit(task, build, state) {
    const recorded = state.design_sha;
    if (recorded) {
      await ensureCleanTarget(build, recorded);
      return recorded;
    }
    const head = await commitment(git, build.branch);
    if (head !== build.base) throw Error('The branch advanced during the task. Inspect the checkout before continuing.');
    const dirty = await changes();
    const snapshot = await store.snapshot(task.id);
    await assertPreserved(build, snapshot, task, dirty);
    if (snapshot.snapshot_sha256 !== state.final_snapshot) throw Error('The checked source changed before the local commit.');
    const paths = Object.keys(dirty).filter(name => !Object.hasOwn(build.preserved, name));
    if (!paths.length) throw Error('The task must produce a checked commit before Branch Review.');
    if (paths.some(name => snapshot.files[name] === task.initial_snapshot.files[name])) {
      throw Error('The Git changes include files outside the checked source.');
    }
    const input = paths.join('\0') + '\0';
    const pathspec = ['--pathspec-from-file=-', '--pathspec-file-nul'];
    await git('--literal-pathspecs', 'add', '-A', ...pathspec, {input});
    if ((await store.snapshot()).snapshot_sha256 !== state.final_snapshot || await commitment(git, build.branch) !== head) {
      throw Error('The checked source changed while staging the local commit.');
    }
    const title = (build.title || task.action).trim().split(/\r?\n/)[0];
    await git('--literal-pathspecs', 'commit', '--only', '-m', title, ...pathspec, {input});
    const result = await commitment(git, build.branch);
    if (result === head || await git('rev-parse', result + '^') !== head || currentGroup(build).findings.some(row => row.sha === result)) {
      throw Error('The task did not produce a distinct commit.');
    }
    await ensureCleanTarget(build, result);
    return result;
  }

  function action(stage, profile) {
    return selectedProfile(profile)?.stages[stageKeys[stage]] ?? {};
  }

  function rubric(task, stage) {
    return task.quality?.definition?.rubrics?.find(item => item.actor === 'agent' && item.stage === stage);
  }

  function criterionErrors(reply, selected) {
    if (!Array.isArray(reply.criteria) || reply.criteria.some(item => !item || typeof item !== 'object')) {
      return ['Record evidence for every required criterion.'];
    }
    const allowed = new Map(selected.map(item => [item.id, item.required]));
    const supplied = new Map();
    for (const item of reply.criteria) {
      if (!allowed.has(item.id) || supplied.has(item.id)) return ['Audit criterion IDs must be unique and defined.'];
      supplied.set(item.id, item);
    }
    return selected.filter(({id, required}) => {
      if (!required) return false;
      const item = supplied.get(id);
      return !item || !Array.isArray(item.evidence) ||
        !item.evidence.some(evidence => typeof evidence === 'string' && evidence.trim()) ||
        (item.verdict !== 'pass' && !(item.verdict === 'not_applicable' && item.reason?.trim()));
    }).map(({id}) => 'Required criterion needs passing evidence: ' + id);
  }

  async function activity(run, stage, actor, message) {
    await files.append(loopPath(run) + '/activity.jsonl', {run, stage, actor, timestamp: now(), activity: String(message).slice(0, 500)});
  }

  async function workflow({build, attempt, task, answer, signal, setCancellable, refresh, validateTarget}) {
    const run = task.id;
    const profile = task.profile;
    const config = await store.executionConfig(run);
    const pending = await files.read(statePath(run));
    const state = pending ?? {stage: 'plan', history: [], answers: [], returns: {}, baseline: false, finding: ''};
    const folder = loopPath(run);
    const selectedGroup = currentGroup(build);
    const scope = await store.prompt(run);
    const finalEnabled = action('final_review', profile).enabled !== false;

    async function measure(key, work) {
      const span = {id: id(), key, visit: state.history.length - 1, startedAt: Date.now()};
      await appendMetric(files, folder, span);
      try { return await work(); }
      finally { await appendMetric(files, folder, {...span, finishedAt: Date.now()}); }
    }

    const checkpoint = async (stage, detail) => {
      const actor = action(stage, profile).provider ?? 'Workbench';
      state.stage = stage;
      state.history.push({stage, assignedTo: actor, time: Date.now() / 1000, detail});
      await files.write(statePath(run), state);
      await activity(run, stage, actor, 'Entered ' + (stageNames[stage] ?? stage));
      await refresh?.(stage);
    };
    const ask = ({stage, prompt, schema, write = false, images = []}) =>
      agent({profile, folder, stage, prompt, schema, write, images, signal, visit: state.history.length - 1,
        report: (actor, message) => activity(run, stage, actor, message)}).then(reply => reply.text);
    const context = {
      approvedPlan: build.plan, title: build.title ?? task.action, projectAgreement: scope,
      notes: state.notes ?? [],
      reviewedFindings: selectedGroup.findings.filter(item => !item.repaired),
      configuredChecks: config.checks, qualityRevision: task.quality?.revision,
      ...(build.mode === 'task' ? {} : {slice: attempt.slice})
    };

    async function question(reply) {
      state.question = sentence(reply.question, 'a planning question', 2000);
      state.question_id = id();
      state.suggestions = [];
      state.question_error = '';
      await checkpoint('question_retry', 'Preparing suggested answers.');
      let decision;
      try {
        decision = await resolveQuestion(reply, context, prompt => ask({stage: 'plan', prompt}),
          action('plan_review', profile).limit);
      } catch (error) {
        if (signal.aborted) throw error;
        state.question_error = error.message;
        await checkpoint('question_retry', error.message);
        return;
      }
      Object.assign(state, decision);
      await measure('2', () => checkpoint('question', decision));
    }

    async function returnTo(stage, verdict, reason) {
      const {route, requirementsRoute, limit, provider} = action(stage, profile);
      const next = verdict === 'replan' && stage !== 'plan_review' ? requirementsRoute ?? 'plan' :
        route ?? (stage === 'plan_review' ? 'plan' : 'build');
      const bucket = {plan_review: 'planning', build_review: 'build', final_review: 'audit'}[stage];
      const count = state.returns[bucket] ?? state.returns[stage] ?? 0;
      state.finding = reason;
      if (next === 'stop' || count >= (limit ?? 3)) {
        await checkpoint('stopped', reason);
        await (next === 'stop' ? store.stop(run, reason) : store.stopAtLimit(run, reason));
        return;
      }
      if (next === 'build') {
        const repairLimit = action('build_review', profile).limit ?? 3;
        if ((state.returns.repair ?? 0) >= repairLimit) {
          await checkpoint('stopped', reason);
          await store.stopAtLimit(run, reason);
          return;
        }
        await store.repair(run, reason);
        state.returns.repair = (state.returns.repair ?? 0) + 1;
      }
      state.returns[bucket] = count + 1;
      await activity(run, stage, provider ?? 'Workbench', 'Finding returned to ' + next);
      await checkpoint(next, reason);
    }

    async function checkStage(phase) {
      const stage = phase === 'after' ? 'checks' : 'baseline';
      await activity(run, stage, 'Workbench', 'Started configured ' + phase + ' checks');
      const before = await store.snapshot();
      const result = await store.runChecks(run, {phase, signal, measure});
      signal.throwIfAborted();
      const after = await store.snapshot();
      if (before.snapshot_sha256 !== after.snapshot_sha256) throw Error('Project source changed during checks. Restore the expected source and retry.');
      for (const row of result.checks) {
        await activity(run, stage, 'Workbench', (row.exit_code === 0 && !row.source_changed ? 'Passed ' : 'Failed ') + row.check);
      }
      return {checks: result.checks, passed: result.verdict === 'pass', source: after.snapshot_sha256};
    }

    async function audit(stage) {
      const before = await measure('0', () => store.snapshot());
      if (stage !== 'plan_review' && before.snapshot_sha256 !== state.checked_source) {
        await checkpoint('checks', 'Source changed since checks.');
        return;
      }
      const selectedRubric = rubric(task, stage);
      const ownsReview = stage === 'final_review' || (stage === 'build_review' && !finalEnabled);
      const required = selectedRubric?.criteria ?? (ownsReview ? criteriaIds.map(id => ({id, required: true})) : null);
      const prompt = 'Independently audit the original request and approved plan. Inspect relevant files and exact check receipts. ' +
        'Return the JSON verdict and cite evidence in reason. Return replan only for a requirements finding. ' +
        (stage === 'plan_review' ? 'Review the proposed method. Baseline and after checks run after the plan audit. ' :
          'Audit the current checked implementation. Identify unsupported acceptance criteria. ') +
        (required ? 'Record a criterion for every required ID on a pass. Include verdict, reason and evidence strings. ' : '') +
        '\n' + JSON.stringify({...context, stage, implementationPlan: state.plan, answers: state.answers, checks: state.checks,
          summary: state.build_summary, snapshot: before.snapshot_sha256, rubric: selectedRubric ?? required});
      const reply = objectReply(await ask({stage, prompt, schema: auditSchema(stage, !!required)}));
      const valid = stage === 'plan_review' ? ['pass', 'replan'] : ['pass', 'repair', 'replan'];
      if (!valid.includes(reply.verdict)) throw Error('The auditor returned an invalid verdict.');
      let verdict = reply.verdict;
      let reason = sentence(reply.reason, 'an audit reason');
      if (verdict === 'pass' && required) {
        const issues = criterionErrors(reply, required);
        if (issues.length) {
          verdict = stage === 'plan_review' ? 'replan' : 'repair';
          reason = issues.join('\n');
        }
      }
      if (verdict === 'pass' && stage === 'build_review' && !state.checked_pass) {
        verdict = 'repair';
        reason = 'A required project check failed. Inspect the recorded check receipts.';
      }
      const row = {stage, actor: action(stage, profile).provider, verdict, reason,
        snapshot_sha256: before.snapshot_sha256, plan_sha256: hash(state.plan), approved_plan_sha256: hash(build.plan),
        profile_sha256: task.profile_sha256, quality_revision: task.quality?.revision,
        ...(selectedRubric ? {rubric_id: selectedRubric.id} : {}),
        ...(Array.isArray(reply.criteria) ? {criteria: reply.criteria} : {})};
      await measure('2', () => store.record(run, 'audits', row));
      await activity(run, stage, row.actor, 'Audit verdict · ' + verdict);
      await activity(run, stage, row.actor, reason);
      if (verdict !== 'pass') {
        await returnTo(stage, verdict, reason);
      } else if (stage === 'plan_review') {
        await checkpoint(state.baseline ? 'build' : 'baseline', row);
      } else if (!ownsReview) {
        await checkpoint('final_review', row);
      } else {
        await store.record(run, 'reviews', {author: 'agent', verdict: 'pass', snapshot_sha256: before.snapshot_sha256,
          stage, criteria: reply.criteria, quality_revision: task.quality?.revision});
        state.final_snapshot = before.snapshot_sha256;
        state.summary = reason;
        await checkpoint(finalEnabled ? 'finish' : 'final_skip', row);
      }
    }

    if (!pending) await checkpoint('plan');
    if (state.stage === 'completed') return state;
    if (state.stage === 'question' && answer) {
      state.answers.push({id: state.question_id, question: state.question, answer, time: now()});
      await checkpoint('plan', 'Recorded a user answer.');
    } else if (state.stage === 'question_retry') {
      await question({question: state.question});
      return state;
    } else if (state.stage === 'building') {
      await checkpoint('checks', 'The builder was interrupted. Check the saved source.');
    }

    while (true) {
      signal.throwIfAborted();
      const stage = state.stage;
      if (['question', 'question_retry', 'stopped', 'completed'].includes(stage)) return state;
      if (stage !== 'finish' || !state.design_sha) {
        if (await commitment(git, build.branch) !== build.base) throw Error('Restore the exact branch and commit for this task.');
      }
      if (stage === 'plan') {
        context.notes = state.notes = await measure('0', () => relevantNotes(repository, config.execution?.vaults,
          [task.action, task.scope, build.plan, state.finding, JSON.stringify(state.answers)].join(' ')));
        const prompt = 'Treat quoted notes as project source material. Prepare an implementation method within the user-approved plan. Keep its scope and acceptance criteria fixed. ' +
          'Return one JSON object with plan as a nonempty Markdown string, or as a list of nonempty steps. If a user decision is necessary, use the question field exclusively. ' +
          questionContract + '\n' + JSON.stringify({...context, answers: state.answers, finding: state.finding});
        const reply = objectReply(await ask({stage, prompt}));
        if (Object.hasOwn(reply, 'question')) {
          if (Object.hasOwn(reply, 'plan')) throw Error('The planner must return either the method or one question.');
          await question(reply);
        } else {
          const method = Array.isArray(reply.plan) && reply.plan.every(step => typeof step === 'string' && step.trim())
            ? reply.plan.map((step, index) => (index + 1) + '. ' + step.trim()).join('\n')
            : reply.plan;
          if (typeof method !== 'string' || !method.trim()) {
            throw Error('The planner returned no implementation steps. Select Resume run to retry planning.');
          }
          state.plan = sentence(method, 'an implementation method');
          await measure('2', () => checkpoint('plan_review', {plan: state.plan, approvedPlanHash: hash(build.plan)}));
        }
      } else if (stage === 'baseline') {
        await store.freeze(run);
        const result = await checkStage('baseline');
        if (!result.passed) throw Error('A required baseline check failed. Inspect the check receipts before retrying.');
        state.baseline = true;
        await checkpoint('build', result.checks);
      } else if (stage === 'build') {
        const images = await measure('0', async () => {
          const reference = build.attachments[attempt.slice];
          return reference && /^[a-f0-9]{32}$/.test(reference) ?
            [await files.path('.harness/design/assets/' + reference + '.png')] : [];
        });
        const write = task.mode !== 'audit' && (build.decisions.code_changes?.option ??
          build.decisions.code_changes) === 'allow_scoped';
        const prompt = 'Implement the reviewed method within the approved plan and task agreement. ' +
          'Leave Git commits, .harness records, project checks and verification to Workbench. ' +
          'Keep the published workbench-quality.json and pre-existing changes intact. Report changes and evidence you actually observed.\n' +
          JSON.stringify({...context, method: state.plan, answers: state.answers, finding: state.finding,
            preservedPaths: Object.keys(build.preserved)});
        await checkpoint('building');
        try {
          state.build_summary = await ask({stage, prompt, write, images});
          await measure('2', () => checkpoint('checks', state.build_summary));
        } catch (error) {
          if (!signal.aborted) await checkpoint('build', error.message);
          throw error;
        }
      } else if (stage === 'checks') {
        const result = await checkStage('after');
        Object.assign(state, {checks: result.checks, checked_source: result.source, checked_pass: result.passed});
        await checkpoint('build_review', result.checks);
      } else if (stage.endsWith('_review')) {
        await audit(stage);
      } else if (stage === 'final_skip') {
        const current = await store.snapshot();
        if (current.snapshot_sha256 !== state.final_snapshot) {
          await checkpoint('checks', 'Source changed before the final audit receipt.');
          continue;
        }
        await store.record(run, 'audits', {stage: 'final_review', actor: 'Workbench', verdict: 'skipped',
          reason: 'Disabled in the pinned Fast profile.', snapshot_sha256: state.final_snapshot, plan_sha256: hash(state.plan),
          profile_sha256: task.profile_sha256, quality_revision: task.quality?.revision});
        await checkpoint('finish');
      } else if (stage === 'finish') {
        if ((await store.snapshot()).snapshot_sha256 !== state.final_snapshot) {
          if (state.design_sha) throw Error('Restore the checked commit before completing this task.');
          await checkpoint('checks', 'Source changed after the final audit.');
          continue;
        }
        const result = await measure('0', () => store.verify(run, {record: false}));
        if (result.verdict !== 'pass') {
          const messages = (result.issues ?? []).map(issue => typeof issue === 'string' ? issue : issue.message);
          await returnTo('final_review', 'repair', messages.filter(Boolean).join('\n') || 'Verification did not pass.');
          continue;
        }
        signal.throwIfAborted();
        await validateTarget?.();
        signal.throwIfAborted();
        setCancellable(false);
        const completion = await measure('1', async () => {
          if (!build.standalone) {
            state.design_sha = await commit(task, build, state);
            await files.write(statePath(run), state);
          }
          if ((await store.snapshot()).snapshot_sha256 !== state.final_snapshot) throw Error('Source changed during commit.');
          return store.verify(run, {record: true, complete: true});
        });
        if (completion.verdict !== 'pass' || completion.lifecycle.status !== 'completed') throw Error('The checked commit cannot complete verification.');
        await checkpoint('completed', {sha: state.design_sha, snapshot_sha256: state.final_snapshot, reason: state.summary});
      } else {
        throw Error('Unknown task stage: ' + stage);
      }
    }
  }

  return {baseline, ensureCleanTarget, activity, workflow};
}
