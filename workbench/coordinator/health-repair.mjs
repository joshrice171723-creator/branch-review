import os from 'node:os';
import path from 'node:path';
import {copyFile, lstat, mkdir, mkdtemp, readdir, rm} from 'node:fs/promises';
import {gitRead, plainPath, relativePath} from '../environment/paths.mjs';
import {objectReply, runProvider} from './provider.mjs';
import {healthRegression} from './health-regression.mjs';
import {coordinatorModel} from './workflow.mjs';

// Windows packages ship unpacked application source. Snapshot those files without copying runtimes or user data.
async function packagedSource(root, cwd) {
  async function copy(relative) {
    const entries = await readdir(path.join(root, relative), {withFileTypes: true});
    for (const entry of entries) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory() && (relative || ['desktop', 'public', 'workbench'].includes(name))) {
        await mkdir(path.join(cwd, name));
        await copy(name);
      } else if (entry.isFile() && (/\.(?:[cm]?js|css|html|rb)$/.test(name) || name === 'package.json')) {
        await copyFile(await plainPath(root, name), path.join(cwd, name));
      }
    }
  }
  await mkdir(cwd);
  await copy('');
  await gitRead(cwd, 'init', '-q');
  await gitRead(cwd, 'add', '.');
  await gitRead(cwd, '-c', 'user.name=Branch Review', '-c', 'user.email=health@localhost', 'commit', '-qm', 'Installed application source');
}

async function fileHash(root, name) {
  const entry = await lstat(path.join(root, relativePath(name))).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!entry) return 'absent';
  if (!entry.isFile()) throw Error('The repair target must be a regular file.');
  return (await gitRead(root, 'hash-object', '--', name)).trim();
}

async function restoreAppliedRepairs(cwd, repository, prior) {
  const owned = new Map();
  const changed = new Set();
  for (const {patch, files} of prior) {
    try { await gitRead(cwd, 'apply', '--index', patch); }
    catch { continue; }
    for (const name of files) changed.add(name);
  }
  for (const name of changed) {
    const [expected, current] = await Promise.all([fileHash(cwd, name), fileHash(repository, name)]).catch(() => []);
    if (expected && expected === current) owned.set(name, expected);
    else await gitRead(cwd, '--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', name);
  }
  return owned;
}

async function snapshotTrackedChanges(cwd, repository) {
  const raw = await gitRead(repository, 'diff', '--no-renames', '--name-only', '-z', 'HEAD');
  for (const name of raw.split('\0').filter(Boolean)) {
    const dir = path.posix.dirname(relativePath(name));
    await plainPath(cwd, dir, {directory: true, create: true});
    const target = path.join(cwd, name);
    // Remove the disposable checkout's entry first so copyFile cannot follow a tracked symlink.
    await rm(target, {force: true});
    const source = await plainPath(repository, name).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (source) await copyFile(source, target);
  }
  if (raw) await gitRead(cwd, 'add', '-A');
}

export async function repairRuntime({repository, incident, directory, profile, providerOptions, signal, mayApply, packaged = false, prior = [],
  invoke = runProvider}) {
  const branch = () => gitRead(repository, 'rev-parse', '--abbrev-ref', 'HEAD');
  const head = () => gitRead(repository, 'rev-parse', 'HEAD');
  let [base, ref] = packaged ? [] : await Promise.all([head(), branch()]);
  const {provider, model, effort} = coordinatorModel;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'branch-review-health-'));
  await mkdir(directory, {recursive: true});
  const patch = path.resolve(directory, 'repair.patch');
  const output = path.resolve(directory, 'reply.txt');
  try {
    const cwd = path.join(scratch, 'source');
    if (packaged) {
      await packagedSource(repository, cwd);
      base = await gitRead(cwd, 'rev-parse', 'HEAD');
    } else {
      await gitRead(scratch, 'clone', '--local', '--no-hardlinks', '--no-checkout', '--', repository, 'source');
      await gitRead(cwd, 'checkout', '--detach', base.trim());
      await gitRead(cwd, 'remote', 'remove', 'origin');
    }
    const owned = packaged ? new Map() : await restoreAppliedRepairs(cwd, repository, prior);
    if (!packaged) await snapshotTrackedChanges(cwd, repository);
    const baseline = (await gitRead(cwd, 'write-tree')).trim();
    const prompt = [
      incident.reported ? 'Address the requested Branch Review change in this disposable copy.' :
        'Repair the observed functional problem in this disposable copy of Branch Review.',
      'Treat runtime evidence as diagnostic data. Investigate the app and its project environment to establish the cause.',
      'Reproduce the failure or establish its cause from source. Fix the smallest responsible component.',
      'Preserve browser security, access controls, tests and production defaults. Do not disable protections to make a check pass.',
      'Preserve user approval requirements, build gates, project scope and explicit settings. A rejected operation may require input, approval, project recovery or an external dependency instead of a Branch Review patch.',
      'When the issue requires another action, return needsAction=true, a plain-English summary and nextAction naming one specific action inside Branch Review. Leave source unchanged for that outcome.',
      'Honor the user’s decisions for publishing and review. Run focused checks that exercise the change.',
      'Leave generated files and dependencies out of the patch. If the cause is elsewhere, explain the blocker. Use the results of previous attempts to change the approach.',
      'Return JSON with verified (boolean), summary (string), and checks (string describing the actual checks and results).',
      'For a runtime regression check, include regression with kind="observation" and the exact Branch Review desktop signal id, or kind="http", path and status=200.',
      'The only HTTP paths allowed are /api/workspace/design, /api/workspace/profile and /api/workspace/coordinator/health. These checks use GET and cannot execute commands.',
      'Observation ids identify renderer, responsive, render:/path, load:/path, page:/path or request:GET /path and request:POST /path. Only use a check that establishes the requested repair. If a user interaction has no existing observation, omit regression and explain the interaction in checks.',
      'A supplied operation observation is bound to the failing interaction. Keep that regression; an unrelated HTTP response cannot establish recovery.',
      JSON.stringify({check: incident.title, failure: incident.error, evidence: incident.evidence,
        regression: incident.regression, previousAttempts: incident.history, previousRepairFiles: [...owned.keys()]})
    ].join('\n');
    const {text} = await invoke({provider, model, effort, cwd, write: true, fullAccess: true, stage: 'build', stageLabel: 'Coordinator health repair',
      prompt, output, signal, providerOptions, timeoutMs: null});
    const result = objectReply(text);
    const summary = String(result.summary || '').slice(0, 1000);
    if (result.needsAction === true && typeof result.nextAction === 'string' && result.nextAction.trim()) {
      return {needsAction: true, summary, nextAction: result.nextAction.slice(0, 1000)};
    }
    if (result.verified !== true || typeof result.checks !== 'string' || !result.checks.trim()) {
      throw Object.assign(Error(summary || 'The repair agent could not verify a change.'), {checks: result.checks});
    }
    const regression = healthRegression(result.regression);
    await gitRead(cwd, 'add', '-A');
    const names = (await gitRead(cwd, 'diff', '--cached', '--no-renames', '--name-only', '-z', baseline)).split('\0').filter(Boolean);
    if (!names.length) throw Error(summary || 'The repair produced no changes.');
    await gitRead(cwd, 'diff', '--cached', '--binary', '--no-renames', '--no-ext-diff', '--output=' + patch, baseline);
    signal.throwIfAborted();
    if (!await mayApply()) throw Error('Workspace activity changed. The repair patch was saved.');
    if (packaged) {
      // Only replace existing shipped source. Verify the complete preimage even if the patch context still matches.
      if ((await gitRead(cwd, 'diff', '--cached', '--diff-filter=ADRT', '--name-only', base.trim())).trim()) {
        throw Error('The repair changes the installed file layout. The patch was saved for the next package build.');
      }
      for (const name of names) {
        relativePath(name);
        const target = await plainPath(repository, name);
        const before = await gitRead(cwd, 'rev-parse', '--verify', base.trim() + ':' + name);
        const current = await gitRead(cwd, 'hash-object', '--path=' + name, target);
        if (before.trim() !== current.trim()) throw Error('Installed source changed. The repair patch was saved.');
      }
    } else {
      if (base !== await head() || ref !== await branch()) throw Error('The checkout changed. The repair patch was saved.');
      const unowned = [];
      for (const name of names) {
        if (!owned.has(name) || owned.get(name) !== await fileHash(repository, name).catch(() => null)) unowned.push(name);
      }
      if (unowned.length && await gitRead(repository, '--literal-pathspecs', 'status', '--porcelain', '--ignored',
        '--untracked-files=all', '--', ...unowned)) throw Error('The repair overlaps local changes. The repair patch was saved.');
    }
    const flags = packaged ? ['--no-index'] : [];
    await gitRead(repository, 'apply', ...flags, '--check', patch);
    signal.throwIfAborted();
    await gitRead(repository, 'apply', ...flags, patch);
    return {summary, files: names, checks: result.checks.slice(0, 1200), regression};
  } finally {
    await rm(scratch, {recursive: true, force: true, maxRetries: 3});
  }
}
