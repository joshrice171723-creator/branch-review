import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {WorkbenchProfile} from './profile.mjs';
import {createAudit} from './coordinator/audit.mjs';
import {createBuilds} from './coordinator/builds.mjs';
import {createDesign, selectedProfile, stageKeys} from './coordinator/design.mjs';
import {id, now, ownedFiles, runPattern} from './coordinator/files.mjs';
import {generateMockup, runProvider} from './coordinator/provider.mjs';
import {appendMetric, providerSpend, readMetrics} from './coordinator/build-metrics.mjs';
import {annotateProviderFailure} from './coordinator/provider-limit.mjs';
import {openStageMcp, selectStageTools} from './mcp.mjs';

const checklist = ['Inspect the commit diff', 'Check the included scope', 'Review the recorded project checks'];

export async function createCoordinator({
  repository, store, git, review, push, projectEvidence, qualityDraft, validateQuality, providerOptions, providerProbe, stageToolCall,
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

  async function agent({profile, runtimeProfile, folder, stage, prompt, schema, write, signal, report, images, visit, evidenceOnly,
    toolScope}) {
    const current = selectedProfile(profile);
    const key = stageKeys[stage];
    const configuration = current?.stages?.[key];
    if (!configuration?.provider) throw Error('Apply a profile with a provider for this step.');
    const {provider, model, effort} = configuration;
    const stageLabel = WorkbenchProfile.roles.find(role => role.id === key)?.name ?? stage;
    const override = selectedProfile(runtimeProfile) ?? runtimeProfile;
    const limitProfile = override ? {...current, ...override, stages: {...current.stages, ...override.stages}} : current;
    const limits = WorkbenchProfile.providerLimits(limitProfile, runtimeProfile?.active ?? profile.active, key);
    const spend = visit === undefined ? null : providerSpend(await readMetrics(files, folder, true));
    const remaining = spend ? limits.providerTimeSeconds * 1000 - spend.milliseconds : Infinity;
    if (remaining <= 0) {
      throw Object.assign(Error('The task reached its ' + limits.providerTimeSeconds + '-second provider time limit.'),
        {code: 'PROVIDER_TASK_TIME_BUDGET'});
    }
    if (spend && spend.tokens >= limits.providerTokenLimit) {
      const unknown = spend.unknown ? ' Usage is unavailable for ' + spend.unknown + ' prior calls.' : '';
      throw Object.assign(Error('The task reached its ' + limits.providerTokenLimit + '-token limit. Providers reported ' +
        spend.tokens + ' tokens plus ' + spend.cached + ' cached input tokens.' + unknown), {code: 'PROVIDER_USAGE_BUDGET'});
    }
    signal?.throwIfAborted();
    const timeoutMs = Math.min(limits.timeoutSeconds * 1000, remaining);
    const timeoutCode = remaining <= limits.timeoutSeconds * 1000 ? 'PROVIDER_TASK_TIME_BUDGET' : 'PROVIDER_CALL_TIMEOUT';
    const shellTools = provider === 'Codex' && configuration.shellTools !== false && !evidenceOnly;
    const stageTools = provider === 'Codex' && stageToolCall ?
      selectStageTools(stage, configuration.toolHints, {scope: toolScope, evidenceOnly})
        .filter(name => !name.startsWith('app_') || profile.permittedTools?.includes(name)) : [];
    const sourceAccess = write && !evidenceOnly ? 'workspace-write' : 'read-only';
    const callId = id();
    const path = folder + '/provider-calls/' + callId;
    const output = await files.path(path + '/reply.txt', true);
    const instructions = WorkbenchProfile.stagePrompt(current, key, profile.documents, profile.permittedTools, stageTools);
    const request = prompt + '\n\n' + instructions;
    await files.write(path + '/request.json', {provider, model, effort, stage, time: now(), prompt: request,
      sourceAccess, shellTools, stageTools, timeoutMs, ...(spend && {budget: {...limits, priorUsage: spend}})});
    if (schema) await files.write(path + '/reply.schema.json', schema);
    if (provider === 'Muse') await files.write(path + '/reply.txt.prompt.txt', Buffer.from(request, 'utf8'));
    await report?.(provider, 'Requested model ' + (model || 'provider default') + ' · thinking effort ' + (effort || 'provider default'));
    await report?.('Workbench', (sourceAccess === 'workspace-write' ? 'Workspace writes enabled' : 'Read-only workspace') +
      ' · shell ' + (shellTools ? 'allowed' : 'disabled') + ' · ' + Math.ceil(timeoutMs / 1000) + 's call limit');
    if (stageTools.length) await report?.('Workbench', 'Selected MCP tools · ' + stageTools.join(', '));
    const call = {id: callId, visit, stage, provider, model, startedAt: Date.now(), timeoutMs, sourceAccess, shellTools, stageTools};
    if (visit !== undefined) await appendMetric(files, folder, call, true);
    let usage, stageMcp;
    let outcome = 'failed';
    try {
      if (stageTools.length) stageMcp = await openStageMcp(stageToolCall, profile, stageTools);
      const result = await invoke({provider, model, effort, stage, stageLabel, cwd: root, write, signal, output, images,
        evidenceOnly, shellTools, timeoutMs, timeoutCode, stageMcp,
        providerOptions: await options(), schema: schema ? await files.path(path + '/reply.schema.json') : undefined,
        prompt: request, report: message => report?.(provider, message), onUsage: value => { usage = value; }});
      outcome = 'complete';
      await files.write(path + '/result.json', {time: now(), ...result});
      return result;
    } catch (error) {
      if (error.code === 'PROVIDER_CALL_TIMEOUT' || error.code === 'PROVIDER_TASK_TIME_BUDGET') outcome = 'timed_out';
      throw annotateProviderFailure(error, {provider, model, stage});
    } finally {
      stageMcp?.close();
      if (visit !== undefined) await appendMetric(files, folder, {...call, outcome: signal?.aborted ? 'cancelled' : outcome,
        finishedAt: Date.now(), ...(usage && {usage})}, true);
    }
  }

  const design = createDesign({files, store, git, agent, projectName: path.basename(root), projectEvidence, validateQuality,
    buildContext: build => builds.conversationContext(build),
    retryBuildVerification: build => builds.retryVerification({build}),
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
    const restartRequired = await builds.restartRequired(current);
    return {...state, checklist, layout, restartRequired, resumeBlocker: await builds.resumeBlocker(current),
      verificationAvailable: !restartRequired && await builds.verificationAvailable(current)};
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
        case 'GET design/tool-suggestions': {
          const stage = Object.keys(stageKeys).find(key => stageKeys[key] === data.stage);
          if (!stage) return [];
          const state = await design.read();
          return selectStageTools(stage, undefined, {scope: state.plan});
        }
        case 'GET design/conversations': return await design.conversations(data);
        case 'GET design/summary': return await builds.summary();
        case 'GET design/evidence': return await builds.evidence(data);
        case 'GET design/group': return await builds.group(data);
        case 'GET design/progress': return await builds.progress();
        case 'GET design/step-evidence': return await builds.step(data);
        case 'GET design/asset':
        case 'GET design/assets': {
          const {bytes} = await design.asset(await design.read(), data.id);
          return {bytes, type: 'image/png'};
        }
        case 'POST design/build': return await builds.launch(data);
        case 'POST design/restart': return await builds.launch(data, true);
        case 'POST design/archive': {
          if (builds.busy()) throw Error('Wait for the current run before archiving.');
          return await design.archive(data);
        }
        case 'POST design/continue': return await builds.advance(data);
        case 'POST design/retry-verification': return await builds.retryVerification(data);
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
  return {dispatch, busy: () => pending > 0 || builds.busy(), close: builds.close,
    suspendRecovery: builds.suspendRecovery};
}

