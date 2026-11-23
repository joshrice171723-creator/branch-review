import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {WorkbenchProfile} from './profile.mjs';
import {createAudit} from './coordinator/audit.mjs';
import {createBuilds} from './coordinator/builds.mjs';
import {createDesign, selectedProfile, stageKeys} from './coordinator/design.mjs';
import {id, now, ownedFiles, runPattern} from './coordinator/files.mjs';
import {generateMockup, runProvider} from './coordinator/provider.mjs';

const checklist = ['Inspect the commit diff', 'Check the included scope', 'Review the recorded project checks'];

export async function createCoordinator({
  repository, store, git, review, push, projectEvidence, qualityDraft, validateQuality, providerOptions, providerProbe,
  invoke = runProvider, image = generateMockup
}) {
  const root = await realpath(repository);
  const files = ownedFiles(root);
  const providerChecks = new Map();
  let pending = 0;

  async function options() {
    return typeof providerOptions === 'function' ? await providerOptions() : providerOptions;
  }

  async function checkProviders(profile, refresh = false) {
    if (!providerProbe) return [];
    const {stages} = selectedProfile(profile);
    const configuration = await options();
    const used = new Map();
    for (const role of WorkbenchProfile.roles) {
      const stage = stages[role.id];
      if (stage?.enabled && role.kind !== 'Gate') {
        const roles = used.get(stage.provider) || [];
        used.set(stage.provider, [...roles, role.name]);
      }
    }
    return Promise.all([...used].map(async ([name, roles]) => {
      const provider = name === 'Claude Code' ? 'claude' : name.toLowerCase();
      const override = configuration?.[provider]?.executable ??
        (configuration?.provider === provider ? configuration.executable : undefined);
      const key = JSON.stringify([provider, override]);
      let entry = providerChecks.get(key);
      if (refresh || !entry || entry.expires <= Date.now()) {
        const result = providerProbe(provider, override);
        entry = {result, expires: Date.now() + 15_000};
        providerChecks.set(key, entry);
      }
      const {status, message} = await entry.result;
      return {id: 'provider-' + provider, provider, name, roles, status, message};
    }));
  }

  async function agent({profile, folder, stage, prompt, schema, write, signal, report, images}) {
    const current = selectedProfile(profile);
    const key = stageKeys[stage];
    const configuration = current?.stages?.[key];
    if (!configuration?.provider) throw Error('Apply a profile with a provider for this step.');
    const {provider, model, effort} = configuration;
    const path = folder + '/provider-calls/' + id();
    const output = await files.path(path + '/reply.txt', true);
    const instructions = WorkbenchProfile.stagePrompt(current, key, profile.documents, profile.permittedTools);
    const request = prompt + '\n\n' + instructions;
    await files.write(path + '/request.json', {provider, model, effort, stage, time: now(), prompt: request});
    if (schema) await files.write(path + '/reply.schema.json', schema);
    if (provider === 'Muse') await files.write(path + '/reply.txt.prompt.txt', Buffer.from(request, 'utf8'));
    await report?.(provider, 'Requested model ' + (model || 'provider default') + ' · thinking effort ' + (effort || 'provider default'));
    const result = await invoke({provider, model, effort, stage, cwd: root, write, signal, output, images,
      providerOptions: await options(), schema: schema ? await files.path(path + '/reply.schema.json') : undefined,
      prompt: request, report: message => report?.(provider, message)});
    await files.write(path + '/result.json', {time: now(), ...result});
    return result;
  }

  const design = createDesign({files, store, git, agent, projectName: path.basename(root), projectEvidence, validateQuality,
    qualityDraft: async () => {
      const quality = await qualityDraft?.();
      return quality?.draft ?? (quality?.definition ? quality : null);
    },
    image: async payload => image({...payload, invoke, providerOptions: await options()})});
  const audit = createAudit({repository: root, files, git, store, agent});
  const builds = createBuilds({files, git, store, design, audit, review, push, checkProviders});
  async function readDesign() {
    const [state, layout] = await Promise.all([design.read(), design.layout()]);
    const current = state.builds.at(-1);
    let restartRequired = false;
    if (current && ['failed', 'cancelled'].includes(current.status)) {
      const head = await git('rev-parse', 'HEAD').catch(() => null);
      restartRequired = Boolean(head && head !== current.base);
    }
    return {...state, checklist, layout, restartRequired, resumeBlocker: await builds.resumeBlocker(current)};
  }

  async function dispatch(route, payload = {}, {method = 'GET'} = {}) {
    const address = new URL(route, 'http://localhost');
    const endpoint = address.pathname.replace(/^\/(?:api\/)?/, '');
    const data = method === 'GET' ? {...Object.fromEntries(address.searchParams),
      ...(payload instanceof URLSearchParams ? Object.fromEntries(payload) : payload)} : payload;
    const request = method + ' ' + endpoint;
    if (method === 'POST') pending++;
    try {
      switch (request) {
        case 'GET design': return await readDesign();
        case 'GET design/layout': return await design.layout();
        case 'GET design/readiness': return await builds.readiness();
        case 'GET design/providers': return await checkProviders(await store.getProfile(), data.refresh === '1');
        case 'GET design/history': return await builds.history();
        case 'GET design/conversations': return await design.conversations(data);
        case 'GET design/summary': return await builds.summary();
        case 'GET design/evidence': return await builds.evidence(data);
        case 'GET design/group': return await builds.group(data);
        case 'GET design/progress': return await builds.progress();
        case 'GET design/asset':
        case 'GET design/assets': {
          const {bytes} = await design.asset(await design.read(), data.id);
          return {bytes, type: 'image/png'};
        }
        case 'POST design/build': return await builds.launch(data);
        case 'POST design/archive': {
          if (builds.busy()) throw Error('Wait for the current run before archiving.');
          return await design.archive(data);
        }
        case 'POST design/continue': return await builds.advance(data);
        case 'POST design/cancel': return await builds.cancel(data);
        case 'POST design/reconnect': return await builds.reconnect(data);
        case 'POST design/finding':
        case 'POST design/review':
        case 'POST design/push':
        case 'POST design/retire': return await builds.decision(endpoint.split('/')[1], data);
        case 'GET live': return await builds.live();
        case 'GET events': return await builds.events(data);
        case 'GET run': return {data: await store.getRun(data.id)};
        case 'GET runs': return await store.listRuns();
        case 'GET state': return await builds.live();
        case 'GET job': return builds.job(data);
        case 'POST chat': return await builds.chat(data);
        case 'POST chat/cancel': return await builds.cancelJob(data);
        case 'POST task': {
          if (builds.busy()) throw Error('Wait for the current build.');
          return {created: {data: await store.startTask(data)}};
        }
        case 'POST answer': {
          const active = data.id ?? (await store.listRuns()).active;
          return await store.answer(active, data.question, data.option, {source: data.source, channel: 'form'});
        }
        case 'POST task/action': {
          if (builds.busy()) throw Error('Wait for the current build.');
          if (!runPattern.test(data.id ?? '')) throw Error('Choose a task run.');
          if (data.action === 'resume') return await store.resume(data.id);
          if (data.action === 'pause') return await store.pause(data.id, data.reason);
          if (data.action === 'stop') return await store.stop(data.id, data.reason);
          throw Error('Choose a task action.');
        }
        default:
          if (method === 'POST' && endpoint.startsWith('design/')) return await design.update(endpoint.split('/')[1], data);
          throw Error('Unknown Workbench operation.');
      }
    } finally {
      if (method === 'POST') pending--;
    }
  }
  return {dispatch, busy: () => pending > 0 || builds.busy(), close: builds.close};
}

