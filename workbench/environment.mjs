import {lstat, mkdir, readdir, realpath, rmdir, unlink} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {redact} from '../jobs.mjs';
import {discoverCapabilities, readInstruction} from './environment/discovery.mjs';
import {atomicJson, boundedText, plainPath, stableId} from './environment/paths.mjs';
import {PreviewProcess, previewAddress, programAvailable} from './environment/preview.mjs';

const kitKind = 'branch-review-workbench-profile';
const smokePath = 'test/branch-review-smoke.cjs';
const smokeCheck = {name: 'coordinator_smoke', argv: ['node', '--test', smokePath], cwd: '.',
  required: true, benchmark: false, phases: ['after'], input_paths: [smokePath]};
const managedNames = ['scratch', 'tmp'];
const isMissing = error => error.code === 'ENOENT';
const missing = (error, value = null) => { if (isMissing(error)) return value; throw error; };
const secretOrMachinePath = /(?:\b[A-Za-z]:[\\/]|\/(?:Users|home)\/[^/\s]+\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-proj-|ghp_|github_pat_|sk_live_)[a-zA-Z0-9_-]{12,}|:\/\/[^/\s]+:[^/\s]+@)/i;

function checkDefinition(check) {
  return {
    name: check.id.replaceAll('-', '_'), argv: check.argv, cwd: check.cwd,
    required: true, benchmark: false, phases: ['baseline', 'after']
  };
}

function useLegacyProfile(value) {
  const candidate = value?.kit ?? value;
  if (candidate?.kind === kitKind && candidate.version !== 1) throw Error('Select a version 1 profile kit.');
  if (candidate?.kind && candidate.kind !== kitKind) throw Error('Select a Branch Review profile kit.');
  const profile = candidate?.profile || candidate;
  if (!profile || profile.version !== 1 || !Array.isArray(profile.documents)) throw Error('Select a version 1 profile.');
  return structuredClone(profile);
}

async function profileFromInput(root, value) {
  const profile = useLegacyProfile(value);
  for (const document of profile.documents) {
    if (!document || typeof document !== 'object') throw Error('An instruction document has invalid fields.');
    if (typeof document.content === 'string') continue;
    const file = document.path || (document.source === 'Project' ? document.filename : '');
    if (!file) throw Error('An instruction document is missing its content.');
    const instruction = await readInstruction(root, file);
    document.content = instruction.content;
    document.filename = file.slice(0, 150);
    document.name ||= path.posix.basename(file).slice(0, 120);
    document.source = 'Project';
    delete document.path;
  }
  return profile;
}

async function cleanupEntries(folder) {
  const entries = [];
  async function visit(relative) {
    const base = await plainPath(folder, relative, {directory: true}).catch(missing);
    if (!base) return;
    const children = await readdir(base, {withFileTypes: true});
    for (const item of children.sort((first, second) => first.name.localeCompare(second.name))) {
      if (entries.length >= 10000) throw Error('The managed directory contains too many files for one cleanup.');
      const name = relative + '/' + item.name;
      if (!item.isFile() && !item.isDirectory()) throw Error('Remove links and special entries before cleanup.');
      const target = await plainPath(folder, name, {directory: item.isDirectory()});
      const info = await lstat(target, {bigint: true});
      entries.push({
        path: name, type: item.isDirectory() ? 'directory' : 'file', size: item.isFile() ? Number(info.size) : 0,
        modifiedNs: String(info.mtimeNs), identity: String(info.dev) + ':' + String(info.ino)
      });
      if (item.isDirectory()) await visit(name);
    }
  }
  for (const name of managedNames) await visit(name);
  return entries;
}

export function createEnvironment({repository, store, local, projectId, defaultProfile, isActive, savedPreview, selectedAgent, origin, verifyPreview}) {
  let automaticPreviewStopped = false;
  let rootPromise, directoryWrite, preview, readinessController, queue = Promise.resolve();
  let renderObservation;
  const repo = () => rootPromise ||= realpath(repository);
  const stateDirectory = path.resolve(local || path.join(repository, '.harness'));
  const id = async () => projectId || stableId(process.platform === 'win32' ? (await repo()).toLowerCase() : await repo());

  function write(callback) {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  }

  async function materializeDirectory(create) {
    if (create) await mkdir(stateDirectory, {recursive: true});
    const stateRoot = await realpath(stateDirectory).catch(missing);
    if (!stateRoot) return null;
    if (path.relative(stateDirectory, stateRoot)) throw Error('Use a workspace directory without links.');
    const folder = await plainPath(stateRoot, 'workbench-environment', {directory: true}).catch(missing);
    const owner = {version: 1, projectId: await id(), repository: await repo()};
    if (folder) {
      const marker = await boundedText(folder, 'owner.json', 4096).catch(missing);
      if (!marker || JSON.stringify(JSON.parse(marker)) !== JSON.stringify(owner)) throw Error('The workspace ownership record does not match this project.');
      return folder;
    }
    if (!create) return null;
    const owned = await plainPath(stateRoot, 'workbench-environment', {directory: true, create: true});
    try {
      await atomicJson(owned, 'owner.json', owner);
    } catch (error) {
      await rmdir(owned).catch(() => {});
      throw error;
    }
    return owned;
  }

  function directory(create = false) {
    if (directoryWrite) return directoryWrite;
    if (!create) return materializeDirectory(false);
    directoryWrite = materializeDirectory(true).finally(() => { directoryWrite = null; });
    return directoryWrite;
  }

  async function activeTask() {
    const listing = await store?.listRuns?.();
    const active = listing?.active;
    if (!active) return null;
    const summary = listing.runs?.find(row => row.id === active);
    return {id: active, status: summary?.lifecycle?.status || 'active'};
  }

  async function assertIdle(action) {
    if (await isActive?.() || (await activeTask())?.status === 'active') {
      throw Error('Finish or pause the active task before ' + action + '.');
    }
  }

  async function getPreview() {
    const root = await repo();
    return preview ||= new PreviewProcess(root, stateDirectory, directory, origin);
  }

  async function capabilities({routes = true} = {}) {
    const root = await repo();
    const inventory = await discoverCapabilities(root);
    let routeRows = [];
    if (routes) {
      const {discoverRoutes} = await import('./quality/routes.mjs');
      routeRows = (await discoverRoutes(root, {runtime: false})).routes;
    }
    return {...inventory, projectId: await id(), ...inventory.git, routes: routeRows};
  }

  async function inspect() {
    const root = await repo();
    const [inventory, config, profile, folder, active, process, applied] = await Promise.all([
      capabilities({routes: false}), store?.config?.(), store?.getProfile?.(), directory(),
      activeTask(), getPreview().then(app => app.status()), store?.profileApplied?.()
    ]);
    const checks = profile?.checks || config?.checks || [];
    const programs = [...new Set(['node', 'git', 'ruby', 'python', 'codex', 'muse',
      ...checks.map(check => check.argv?.[0]).filter(Boolean)])];
    const availability = await Promise.all(programs.map(async name => [name, await programAvailable(name, root)]));
    const current = profile?.profiles?.[profile.active];
    const activeAgents = Array.from(new Set(Object.values(current?.stages || {})
      .filter(stage => stage.enabled && ['Codex', 'Muse'].includes(stage.provider)).map(stage => stage.provider))).sort();
    const directories = {};
    if (folder) {
      for (const name of managedNames) {
        const managed = await plainPath(folder, name, {directory: true}).catch(missing);
        if (managed) directories[name] = managed;
      }
    }
    return {
      projectId: await id(), name: path.basename(root), path: root, project: root, installed: true, native: true,
      engine: 'branch-review', prepared: managedNames.every(name => directories[name]), profileApplied: applied ?? Boolean(profile),
      activeTask: active, activeAgents, programs: Object.fromEntries(availability), directories, checks: checks.map(check => check.name),
      suggestedChecks: inventory.checks.map(checkDefinition), branch: inventory.branch, head: inventory.head, refs: inventory.refs,
      previewAddress: process.url || await savedPreview?.() || '', preview: process, agent: await selectedAgent?.(), runtimeUpdate: false
    };
  }

  function prepare(input = {}) {
    return write(async () => {
      await assertIdle('preparing this workspace');
      let profile = input.profile ? await profileFromInput(await repo(), input.profile) :
        await store?.getProfile?.() || await defaultProfile?.();
      const newChecks = input.checks ?? (input.discoverChecks !== false && !profile?.checks?.length
        ? (await capabilities({routes: false})).checks.filter(check => check.kind === 'test').slice(0, 6).map(checkDefinition) : null);
      if (profile && newChecks) profile = {...profile, checks: newChecks};
      const folder = await directory(true);
      for (const name of managedNames) await plainPath(folder, name, {directory: true, create: true});
      if (profile) await store.setProfile(profile);
      else if (newChecks?.length && store?.setConfig) await store.setConfig({...await store.config(), checks: newChecks});
      return inspect();
    });
  }

  async function cleanupPreview() {
    const folder = await directory();
    const entries = folder ? await cleanupEntries(folder) : [];
    const projectId = await id();
    return {projectId, previewId: stableId([projectId, entries], 64), entries, bytes: entries.reduce((sum, entry) => sum + entry.size, 0)};
  }

  function cleanup(input) {
    return write(async () => {
      await assertIdle('cleaning the workspace');
      if (preview?.running()) throw Error('Stop the managed preview before cleaning its workspace.');
      const view = await cleanupPreview();
      if (!/^[a-f0-9]{64}$/.test(input?.previewId || '') || input.previewId !== view.previewId) {
        throw Error('Preview the current managed files before confirming cleanup.');
      }
      const folder = await directory();
      for (const entry of view.entries.reverse()) {
        const target = await plainPath(folder, entry.path, {directory: entry.type === 'directory'});
        const info = await lstat(target, {bigint: true});
        if (entry.identity !== String(info.dev) + ':' + String(info.ino) ||
            entry.type === 'file' && (String(info.mtimeNs) !== entry.modifiedNs || Number(info.size) !== entry.size)) {
          throw Error('The managed files changed. Preview cleanup again.');
        }
        if (entry.type === 'directory') await rmdir(target);
        else await unlink(target);
      }
      return {projectId: view.projectId, removed: view.entries.length, bytes: view.bytes};
    });
  }

  async function exportProfile() {
    const saved = await store.getProfile();
    if (!saved || store.profileApplied && !await store.profileApplied()) throw Error('Apply a project profile before exporting it.');
    const profile = await profileFromInput(await repo(), saved);
    if (secretOrMachinePath.test(JSON.stringify(profile))) throw Error('Remove credentials and machine-specific paths before exporting the profile.');
    return {kind: kitKind, version: 1, profile};
  }

  function importProfile(input) {
    return write(async () => {
      await assertIdle('applying a profile');
      const profile = await profileFromInput(await repo(), input);
      await store.setProfile(profile);
      return {profile: await store.getProfile()};
    });
  }

  function attachProjectInstruction(input) {
    return write(async () => {
      await assertIdle('applying project instructions');
      const {path: file, content} = await readInstruction(await repo(), input.path);
      const profile = structuredClone(await store.getProfile() || await defaultProfile?.());
      if (!profile) throw Error('Apply a profile before attaching instructions.');
      const mode = input.mode || profile.active;
      if (!['audited', 'fast'].includes(mode)) throw Error('Choose a workflow profile.');
      const owner = profile.profiles[mode];
      const stage = input.stage;
      if (stage != null && !Object.hasOwn(owner.stages, stage)) throw Error('Choose a workflow stage.');
      const attachments = stage == null ? owner.sharedDocs : owner.stages[stage].docs;
      const filename = file.slice(0, 150);
      let document = profile.documents.find(row => row.source === 'Project' && row.filename === filename && row.content === content);
      if (!document) {
        document = {id: 'project-' + stableId([file, content]), filename, name: path.posix.basename(file).slice(0, 120),
          source: 'Project', content};
        profile.documents.push(document);
      }
      if (!attachments.includes(document.id)) attachments.push(document.id);
      await store.setProfile(profile);
      return {document, profile: await store.getProfile()};
    });
  }

  async function checkedPreview() {
    const process = await (await getPreview()).status();
    if (process.url && ['external', 'running'].includes(process.state)) {
      return {address: process.url, url: process.url, status: ''};
    }
    const saved = await savedPreview?.();
    if (!saved) return {address: '', url: '', status: process.owned ? 'Preview is starting.' : ''};
    const address = previewAddress(saved);
    return {address, url: address, status: ''};
  }

  async function setupPreview(input) {
    if (input.id || input.candidateId) {
      const candidate = (await capabilities({routes: false})).previews.find(row => row.id === (input.id || input.candidateId));
      if (!candidate) throw Error('Choose a current preview command.');
      input = {...candidate, ...input};
    }
    return (await getPreview()).setup(input);
  }

  async function startPreview(app, options = {}) {
    const {taskId, ...settings} = options;
    const snapshot = await store.snapshot?.(taskId, {record: false});
    try { return await app.start({...settings, source: snapshot?.snapshot_sha256}); }
    catch (error) {
      const state = await app.status().catch(() => null);
      if (state?.wanted && !state.stoppedByUser && state.settings?.mode === 'web') error.recoveryOwner = 'project-preview';
      throw error;
    }
  }

  async function autoPreview(input) {
    const app = await getPreview();
    const current = await app.status();
    if (process.env.BRANCH_REVIEW_PREVIEW_PARENT) return current;
    if (input.retry) automaticPreviewStopped = false;
    if (input.retry && current.state === 'exited' && current.owned) await app.stop({preserveIntent: true});
    if (["external", "running", "starting"].includes(current.state)) return current;
    if ((automaticPreviewStopped || current.stoppedByUser) && !input.retry) return current;
    if (current.state === "exited" && !input.retry) return current;
    if (await savedPreview?.()) return current;
    if (current.settings) {
      if (current.settings.mode !== "web") return current;
      return startPreview(app, {taskId: input.taskId, signal: input.signal});
    }
    const candidates = (await capabilities({routes: false})).previews.filter(row =>
      row.url && ["web", "external"].includes(row.mode));
    const declared = candidates.filter(row => row.source.some(source => source.path === "workbench-capabilities.json"));
    const choices = declared.length ? declared : candidates;
    const selected = input.id ? candidates.find(row => row.id === input.id) :
      choices.length === 1 ? choices[0] : null;
    if (input.id && !selected) throw Error("Choose a detected project preview.");
    if (!selected) return {...current, choices: choices.map(({id, label}) => ({id, label})),
      message: choices.length ? "Choose the project app to preview." : "No web preview was detected. Set an app address in Preview settings."};
    await app.setup(selected);
    return startPreview(app, {taskId: input.taskId, signal: input.signal});
  }

  async function previewForPlan(inventory, previewId, expectedRevision, {
    rerunSetup = false, taskId, signal, waitForReady = false, requireSetup = false
  } = {}) {
    try {
      const candidate = inventory.previews.find(row => row.id === previewId && row.url && ['web', 'external'].includes(row.mode));
      const app = await getPreview();
      if (requireSetup) {
        const settings = await app.settings();
        if (!settings?.setup?.length && !settings?.services?.length) {
          return {state: 'blocked', message: 'This project has no declared setup commands for the test environment.'};
        }
      }
      let state = await autoPreview({retry: true, id: candidate?.id, taskId, signal});
      async function check() {
        let connectionError, status, progress = '', lastProgress = Date.now(), attempts = 0;
        while (state.owned && ['starting', 'running'].includes(state.state) && state.settings?.mode === 'web') {
          const currentProgress = state.state + '\n' + (state.log || '');
          if (currentProgress !== progress) {
            progress = currentProgress;
            lastProgress = Date.now();
          }
          if (state.state === 'running') {
            const deadline = AbortSignal.timeout(5000);
            try {
              const response = await fetch(state.url, {redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline]) : deadline});
              await response.body?.cancel();
              status = response.status;
              connectionError = undefined;
              if (status < 500 || !waitForReady) return {status};
            } catch (error) {
              signal?.throwIfAborted();
              connectionError = error.cause?.code || error.message;
            }
          }
          if (!waitForReady && ++attempts >= 10) break;
          if (waitForReady && Date.now() - lastProgress >= 60000) return {status, connectionError, stalled: true};
          await delay(500, undefined, {signal});
          state = await app.status();
        }
        return {status, connectionError};
      }
      let result = await check();
      const expectedSource = (await store.snapshot?.(taskId, {record: false}))?.snapshot_sha256;
      const outdated = state.owned && ((expectedRevision && state.revision !== expectedRevision) ||
        (expectedSource && state.source !== expectedSource));
      const retrying = !result.stalled && (result.status >= 500 || Boolean(result.connectionError) || outdated ||
        state.state === 'exited' && state.wanted || (rerunSetup && state.owned));
      if (retrying) {
        const preferredUrl = state.owned ? state.url : undefined;
        await app.stop({preserveIntent: true});
        state = await startPreview(app, {rerunSetup, taskId, signal, preferredUrl});
        result = await check();
      }
      const report = (stateName, message) => ({state: stateName, message, url: state.url || '', revision: state.revision ?? null, source: state.source ?? null});
      const {status, connectionError} = result;
      if (result.stalled) return report('blocked', 'The project preview stopped making progress. Coordinator needs to inspect its current state.');
      if (connectionError) return report('blocked', 'The managed preview could not answer at ' + state.url +
        (retrying ? ' after restart. ' : '. ') + redact(connectionError));
      if (status >= 400) return report('blocked', ['The managed preview responded with HTTP ' + status +
        (retrying ? ' after a restart.' : '.'), state.log && redact(state.log).slice(-750)].filter(Boolean).join('\n'));
      if (status >= 200 && status < 300 && (!expectedRevision || state.revision === expectedRevision) &&
          (!expectedSource || state.source === expectedSource)) {
        return report('ready', retrying ? 'The managed preview responded after restart.' : 'The preview responded.');
      }
      if (status) return report('blocked', 'The managed preview did not confirm the expected revision and a successful response.');
      if (state.state === 'starting') return report('pending', 'The preview is still starting.');
      if (state.state === 'external' || await savedPreview?.()) {
        return report('external', 'The saved preview address is available. Its revision is unverified.');
      }
      return report('blocked', [state.message || 'The preview is unavailable.',
        state.state === 'exited' && state.log && redact(state.log).slice(-750)].filter(Boolean).join('\n'));
    } catch (error) {
      return {state: 'blocked', message: 'Preview setup did not finish. ' + redact(error.message)};
    }
  }

  function prepareBuild({checkId, previewId, acceptanceChecks = []} = {}) {
    return write(async () => {
      const active = await activeTask();
      if (active?.status === 'active') throw Error('An active build owns the project settings. Use Coordinator to recover that build.');
      const root = await repo();
      let profile = await store.getProfile();
      const config = await store.effectiveConfig();
      const inventory = await capabilities({routes: false});
      if (!config.checks.some(row => row.required || row.benchmark)) {
        if (config.quality_revision) throw Error('The published Quality policy lacks a required check.');
        const preferred = ['test', 'check', 'typecheck', 'lint', 'build'];
        const ordered = [...(checkId ? inventory.checks.filter(row => row.id === checkId) : []),
          ...preferred.flatMap(kind => inventory.checks.filter(row => row.kind === kind))];
        let discovered;
        for (const candidate of ordered) {
          if (!preferred.includes(candidate.kind)) continue;
          const [evidence] = await store.configuredCheckReadiness({checks: [checkDefinition(candidate)]});
          if (evidence.status === 'ready') { discovered = candidate; break; }
        }
        const required = discovered ? checkDefinition(discovered) : smokeCheck;
        const checks = profile.checks.filter(row => row.name !== required.name);
        await store.setProfile({...profile, checks: [...checks, required]});
        profile = await store.getProfile();
      } else if (!await store.profileApplied()) {
        await store.setProfile(profile);
      }
      const mapped = (Array.isArray(acceptanceChecks) ? acceptanceChecks : [])
        .filter(row => typeof row?.criterion === 'string')
        .map(row => ({criterion: row.criterion, candidate: inventory.checks.find(item => item.id === row.checkId && item.kind === 'test')}));
      const configured = await store.effectiveConfig();
      if (!configured.quality_revision) {
        const additions = [];
        for (const candidate of new Set(mapped.map(row => row.candidate).filter(Boolean))) {
          if ([...configured.checks, ...additions].some(check => check.cwd === candidate.cwd &&
              JSON.stringify(check.argv) === JSON.stringify(candidate.argv))) continue;
          const check = {...checkDefinition(candidate), phases: ['after']};
          const [readiness] = await store.configuredCheckReadiness({checks: [check]});
          if (readiness.status === 'ready') additions.push(check);
        }
        if (additions.length) await store.setProfile({...profile, checks: [...profile.checks, ...additions]});
      }
      const effective = await store.effectiveConfig();
      const smoke = !effective.quality_revision && effective.checks.some(row => row.name === smokeCheck.name &&
        row.argv.join(' ') === smokeCheck.argv.join(' ')) &&
        !await plainPath(root, smokePath).catch(missing) ? smokePath : '';
      let checks = await store.configuredCheckReadiness(effective);
      const app = await getPreview();
      const settings = await app.settings();
      const rerunSetup = Boolean(settings?.setup?.length && checks.some(row => row.status === 'blocked'));
      const preview = await previewForPlan(inventory, previewId, inventory.head, {rerunSetup});
      if (preview.state === 'ready') checks = await store.configuredCheckReadiness(effective);
      return {checks, smoke, previewMessage: preview.message, preview, acceptanceChecks: mapped.map(({criterion, candidate}) => ({
        criterion, check: candidate && effective.checks.find(check => check.cwd === candidate.cwd &&
          JSON.stringify(check.argv) === JSON.stringify(candidate.argv))?.name
      }))};
    });
  }

  async function dispatch(method, route, payload = {}, searchParams = new URLSearchParams()) {
    const endpoint = route.replace(/^\/?(?:api\/)?(?:workspace\/)?/, '');
    const requestedProject = payload?.projectId || searchParams.get('projectId');
    if (requestedProject && requestedProject !== await id()) throw Error('Select this project before changing its workspace.');
    switch (method + ' ' + endpoint) {
      case 'GET environment': return inspect();
      case 'POST prepare':
      case 'POST workbench-prepare': return prepare(payload);
      case 'POST cleanup/preview':
      case 'GET cleanup/preview': return cleanupPreview();
      case 'POST cleanup': return cleanup(payload);
      case 'GET project-capabilities': return capabilities({routes: false});
      case 'GET capabilities': return capabilities();
      case 'GET project-instruction': return readInstruction(await repo(), searchParams.get('path'));
      case 'GET attachments': return (await capabilities({routes: false})).files.filter(row => row.kind === 'instruction');
      case 'POST attachments': return attachProjectInstruction(payload);
      case 'GET profile/export': return exportProfile();
      case 'POST profile/parse': return {profile: await profileFromInput(await repo(), payload)};
      case 'POST profile/import': return importProfile(payload);
      case 'GET design/preview': return checkedPreview();
      case 'GET design/app-process':
      case 'GET preview': return (await getPreview()).status();
      case 'POST design/app-process/setup':
      case 'POST preview/setup': return write(() => setupPreview(payload));
      case 'POST design/app-process/auto': return write(() => autoPreview(payload));
      case 'POST design/app-process/start':
      case 'POST preview/start':
        return write(async () => {
          if (payload.id || payload.candidateId) await setupPreview(payload);
          automaticPreviewStopped = false;
          return startPreview(await getPreview());
        });
      case 'POST design/app-process/stop':
      case 'POST preview/stop': {
        automaticPreviewStopped = true;
        readinessController?.abort();
        (await getPreview()).cancelSetup();
        return write(async () => {
          return (await getPreview()).stop();
        });
      }
      default: return undefined;
    }
  }

  async function observePreview() {
    const app = await getPreview();
    const state = await app.status();
    if (automaticPreviewStopped || state.stoppedByUser) return [{owner: 'project', id: 'preview', scope: await repo(),
      title: 'Project preview', cancelled: true, occurredAt: Date.now()}];
    if (!state.wanted || state.settings?.mode !== 'web') return [];
    let error = '';
    if (state.state === 'exited') error = state.message || 'The project preview stopped before it was ready.';
    else if (state.state === 'external') error = 'Another process is using the managed preview address.';
    else if (state.state === 'starting') {
      if (Date.now() - state.startedAt < 60000) return [];
      error = 'The project preview is still starting and cannot accept connections.';
    } else if (state.state === 'running') {
      try {
        const response = await fetch(state.url, {signal: AbortSignal.timeout(5000)});
        await response.body?.cancel();
        if (!response.ok) error = 'The project preview returned HTTP ' + response.status + '.';
        else if (verifyPreview) {
          const key = state.url + '|' + state.startedAt;
          if (renderObservation?.key !== key || Date.now() >= renderObservation.nextAt) {
            renderObservation = {key, nextAt: Date.now() + 60000,
              result: await verifyPreview(state.url, {embedOrigin: origin})};
          }
          if (!renderObservation.result.passed) error = renderObservation.result.detail;
        }
      } catch (failure) { error = failure.message; }
    }
    return [{owner: 'project', id: 'preview', scope: await repo(), title: 'Project preview', error,
      url: state.url, evidence: redact(state.log || '').slice(-6000), occurredAt: Date.now()}];
  }

  async function verifyCurrentPreview({signal} = {}) {
    signal?.throwIfAborted();
    const app = await getPreview();
    let progress = '', lastProgress = Date.now(), detail = 'The managed preview is not ready.';
    for (;;) {
      const state = await app.status();
      if (automaticPreviewStopped || state.stoppedByUser) {
        return {cancelled: true, passed: false, detail: 'The managed preview was stopped by the user.'};
      }
      if (!state.owned || !['starting', 'running'].includes(state.state) || !state.url) {
        return {passed: false, detail: state.message || detail};
      }
      const currentProgress = state.state + '\n' + (state.log || '');
      if (currentProgress !== progress) {
        progress = currentProgress;
        lastProgress = Date.now();
      }
      if (state.state === 'running') {
        try {
          const deadline = AbortSignal.timeout(5000);
          const response = await fetch(state.url, {signal: signal ? AbortSignal.any([signal, deadline]) : deadline});
          await response.body?.cancel();
          if (response.ok) {
            if (!verifyPreview) return {passed: false, detail: 'The preview responds. Browser rendering still needs verification.'};
            const rendered = await verifyPreview(state.url, {signal, embedOrigin: origin});
            renderObservation = {key: state.url + '|' + state.startedAt, nextAt: Date.now() + 60000, result: rendered};
            return rendered;
          }
          detail = 'The project preview returned HTTP ' + response.status + '.';
          if (response.status < 500) return {passed: false, detail};
        } catch (error) {
          signal?.throwIfAborted();
          detail = redact(error.message);
        }
      }
      if (Date.now() - lastProgress >= 60000) return {passed: false, detail: 'The project preview stopped making progress. ' + detail};
      await delay(500, undefined, {signal});
    }
  }

  return {inspect, prepare, prepareBuild, observePreview, verifyCurrentPreview,
    async browserPreview() {
      const process = await (await getPreview()).status();
      return {url: process.url || await savedPreview?.(), revision: process.revision, source: process.source, owned: process.owned};
    },
    prepareBrowserRecovery: ({signal, ...options} = {}) => write(async () => {
      readinessController = new AbortController();
      try {
        const stop = signal ? AbortSignal.any([signal, readinessController.signal]) : readinessController.signal;
        const inventory = await capabilities({routes: false});
        return await previewForPlan(inventory, undefined, inventory.head, {...options, signal: stop});
      } finally {
        readinessController = null;
      }
    }), cleanupPreview, cleanup, capabilities, exportProfile, importProfile, checkedPreview, dispatch,
    recoverPreview: ({signal, previewId, rerunSetup = true} = {}) => write(async () => {
      readinessController = new AbortController();
      try {
        const stop = signal ? AbortSignal.any([signal, readinessController.signal]) : readinessController.signal;
        const app = await getPreview();
        const state = await app.status();
        if (automaticPreviewStopped || state.stoppedByUser || !state.wanted || state.settings?.mode !== 'web') {
          return {cancelled: true, passed: false, detail: 'The managed preview was stopped by the user.'};
        }
        const inventory = await capabilities({routes: false});
        await app.stop({preserveIntent: true});
        if (previewId) {
          const candidate = inventory.previews.find(item => item.id === previewId && item.mode === 'web');
          if (!candidate) throw Error('The alternative preview command is no longer available.');
          await app.setup(candidate);
        }
        const result = await previewForPlan(inventory, previewId, inventory.head, {rerunSetup, waitForReady: true, signal: stop});
        if (result.state !== 'ready') return {passed: false, detail: result.message};
        if (!verifyPreview) return {passed: false, detail: 'The preview responds. Browser rendering still needs verification.'};
        const rendered = await verifyPreview(result.url, {signal: stop, embedOrigin: origin});
        const current = await app.status();
        renderObservation = {key: current.url + '|' + current.startedAt, nextAt: Date.now() + 60000, result: rendered};
        return rendered;
      } catch (error) {
        if (automaticPreviewStopped) return {cancelled: true, passed: false, detail: 'The managed preview was stopped by the user.'};
        signal?.throwIfAborted();
        return {passed: false, detail: redact(error.message)};
      } finally { readinessController = null; }
    }),
    close: () => {
      readinessController?.abort();
      preview?.cancelSetup();
      return write(() => preview?.close());
    }};
}
