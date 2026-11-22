import {randomUUID} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {listQuality, readQuality, writeQuality, writeTrial} from './quality/io.mjs';
import {discoverRoutes, prepareRoute} from './quality/routes.mjs';
import {gitOutput, resolveRefs, snapshotCheck, stopQualityProcesses, trialResults} from './quality/runner.mjs';
import {
  boolean, lockedDefinition, parseQualityJSON, policyFile, trialIdPattern, validPublication, validateQuality
} from './quality/schema.mjs';

const home = '.harness/quality/';
const writes = new Map();
const running = new Set();
const fields = (entry, keys) => Object.fromEntries(keys.map(key => [key, entry[key]]));
const trialFields = ['id', 'revision', 'policy', 'created_at', 'status', 'environment'];
const refFields = ['ref', 'sha', 'status'];
const publicationFields = ['published_at', 'reviewer', 'trial_status'];
const publicId = ['trial_id', 'revision', ...publicationFields];

function validId(id, name) {
  if (typeof id !== 'string' || id.length !== 32 || !trialIdPattern.test(id)) throw Error('Invalid ' + name + ' ID');
  return id;
}

function serialized(root, action) {
  const result = (writes.get(root) || Promise.resolve()).then(action);
  const settled = result.then(() => {}, () => {});
  writes.set(root, settled);
  void settled.then(() => { if (writes.get(root) === settled) writes.delete(root); });
  return result;
}

async function withRunner(root, action) {
  if (running.has(root)) throw Error('Another Quality measurement is running for this project');
  running.add(root);
  try { return await action(); }
  finally { running.delete(root); }
}

async function defaultDraft(root) {
  const profileDisabled = await lstat(path.join(root, '.harness/profile.disabled')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  const legacy = (!profileDisabled && await readQuality(root, '.harness/profile.json')) ||
    await readQuality(root, '.harness/project.json') || {};
  const checks = [];
  const upgrade_warnings = [];
  for (const item of legacy.checks || []) {
    const {name, argv, cwd, phases, required, benchmark} = item;
    const candidate = {id: name, name, argv, ...(cwd !== undefined && {cwd}), ...(phases !== undefined && {phases}),
      required: Boolean(required || benchmark)};
    try {
      validateQuality({schema_version: 1, checks: [...checks, candidate], benchmarks: [], rubrics: []});
      checks.push(candidate);
    } catch (error) {
      const reason = /^\.harness(?:$|[\\/])/.test(cwd) ?
        'Its working directory is outside the committed export.' : error.message.replace(/\.$/, '') + '.';
      upgrade_warnings.push('Could not import check ' + (name || '(unnamed)') + '. ' + reason +
        ' Add a replacement in Checks.');
    }
  }
  return {...validateQuality({schema_version: 1, checks, benchmarks: [], rubrics: []}),
    ...(upgrade_warnings.length && {upgrade_warnings})};
}

function tool(name, description, properties = {}, required = []) {
  return {name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}};
}

const text = {type: 'string'};
const nullableText = {type: ['string', 'null']};
const definition = {type: 'object'};
export const qualityTools = [
  tool('quality_status', 'Read the Quality draft, publication, and recorded trials.'),
  tool('quality_validate', 'Validate a Quality definition and get its revision.', {definition}, ['definition']),
  tool('quality_draft', 'Propose a Quality draft for human review.',
    {definition, base_revision: nullableText, expected_revision: text}, ['definition', 'expected_revision']),
  tool('quality_trial', 'Run the committed Quality policy against one or two Git revisions.',
    {revision: text, refs: {type: 'array', items: text, minItems: 1, maxItems: 2}}, ['revision', 'refs']),
  tool('quality_evidence', 'Read the shareable report for a Quality trial.', {id: text}, ['id']),
  tool('quality_routes', 'Discover HTTP routes and Electron IPC channels. Runtime discovery loads the selected Rails app.',
    {runtime: {type: 'boolean'}, app: text}),
  tool('quality_prepare_route', 'Trace a route and add a source check and criteria to the draft.',
    {route_id: text, method: text, path: text, source_path: text, base_revision: nullableText, expected_revision: text})
];

export function createQuality({repository}) {
  const root = () => realpath(repository);
  const controllers = new Set();
  const publicationPath = id => home + 'publications/' + validId(id, 'publication') + '.json';
  const trialPath = id => home + 'trials/' + validId(id, 'trial') + '/';

  async function publication(dir, committed = false) {
    const value = await readQuality(dir, policyFile);
    if (!value) return null;
    validPublication(value);
    if (!committed && isDeepStrictEqual(await readQuality(dir, publicationPath(value.trial_id)), value)) return value;
    try {
      const current = parseQualityJSON(await gitOutput(dir, 'show', 'HEAD:' + policyFile));
      validPublication(current);
      if (isDeepStrictEqual(current, value)) return value;
    } catch {}
    throw Error('Quality policy requires a recorded human publication or the committed policy');
  }

  async function currentDraft(dir, published) {
    const value = await readQuality(dir, home + 'draft.json');
    const base_revision = published?.revision ?? null;
    if (value) {
      lockedDefinition(value);
      return value.revision === base_revision && value.base_revision !== base_revision ?
        {...value, base_revision} : value;
    }
    const policy = published ? lockedDefinition(published) : await defaultDraft(dir);
    return {...policy, base_revision, actor: 'human'};
  }

  async function status() {
    const dir = await root();
    const published = await publication(dir);
    const [draft, trialNames, versionNames] = await Promise.all([
      currentDraft(dir, published), listQuality(dir, home + 'trials'), listQuality(dir, home + 'publications')
    ]);
    const trials = (await Promise.all(trialNames.filter(id => id.length === 32 && trialIdPattern.test(id))
      .map(id => readQuality(dir, trialPath(id) + 'summary.json')))).filter(Boolean);
    const versions = (await Promise.all(versionNames.filter(name => /^[a-f0-9]{32}\.json$/.test(name))
      .map(name => readQuality(dir, home + 'publications/' + name)))).filter(Boolean);
    if (published && !versions.some(item => item.trial_id === published.trial_id)) versions.push(published);
    return {
      published, draft,
      trials: trials.sort((left, right) => right.created_at.localeCompare(left.created_at)),
      publications: versions.map(item => fields(item, publicId)).sort((left, right) =>
        right.published_at.localeCompare(left.published_at))
    };
  }

  async function pin({committed = false} = {}) {
    return publication(await root(), committed);
  }

  async function writeDraft({definition, base_revision = null, expected_revision}, actor = 'human') {
    const candidate = validateQuality(definition);
    const dir = await root();
    return serialized(dir, async () => {
      const published = await publication(dir);
      const prior = await currentDraft(dir, published);
      const base = published?.revision ?? null;
      if (base_revision !== base) throw Error('Quality publication changed. Reload before saving.');
      if (expected_revision !== prior.revision) throw Error('Quality draft changed. Reload before saving.');
      const value = {...candidate, base_revision: base, actor};
      await writeQuality(dir, home + 'draft.json', value);
      return value;
    });
  }

  async function evidenceAt(dir, id) {
    const value = await readQuality(dir, trialPath(id) + 'evidence.json');
    if (!value) throw Error('Quality trial does not exist');
    if (value.id !== id) throw Error('Quality trial identity does not match');
    lockedDefinition(value);
    return value;
  }

  async function versionAt(dir, id) {
    const value = await readQuality(dir, publicationPath(id));
    if (value) {
      if (value.trial_id !== id) throw Error('Quality publication identity does not match');
      return validPublication(value);
    }
    const active = await publication(dir);
    if (active?.trial_id !== id) throw Error('Quality publication does not exist');
    return active;
  }

  async function exportEvidence(id) {
    const dir = await root();
    const trial = await evidenceAt(dir, id);
    const published = await readQuality(dir, publicationPath(id));
    return {
      ...fields(trial, trialFields),
      ...(published && {publication: fields(published, publicationFields)}),
      refs: trial.refs.map(ref => ({
        ...fields(ref, refFields),
        checks: ref.checks.map(item => fields(item, ['id', 'status', 'exit_code', 'required', 'duration_seconds'])),
        benchmarks: ref.benchmarks.map(item =>
          fields(item, ['id', 'check_id', 'status', 'fixtures', 'scripts', 'metrics', 'thresholds']))
      }))
    };
  }

  async function operation(signal, action) {
    const controller = new AbortController();
    const commandSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    controllers.add(controller);
    try { return await action(commandSignal); }
    finally { controllers.delete(controller); }
  }

  async function trial({revision, refs, policy = 'draft'}, {committed = false} = {}) {
    const dir = await root();
    if (committed && policy !== 'published') throw Error('Agent trials require the committed Quality publication');
    if (!['published', 'draft'].includes(policy)) throw Error('Select the draft or published Quality policy');
    const active = await publication(dir, committed);
    const selected = policy === 'published' ? active : await currentDraft(dir, active);
    if (!selected || revision !== selected.revision) throw Error('Select the current Quality revision before starting a trial');
    const {definition} = selected;
    if (!definition.checks.some(item => item.required) && !definition.benchmarks.length) {
      throw Error('Configure a required check or benchmark before testing');
    }
    const resolved = await resolveRefs(dir, refs);
    return withRunner(dir, () => operation(undefined, async signal => {
      const environment = {kind: 'local_disposable_export', image: null, os: os.version(),
        architecture: process.arch, node: process.versions.node, git: (await gitOutput(dir, '--version')).trim()};
      const value = {id: randomUUID().replaceAll('-', ''), revision, policy, created_at: new Date().toISOString(),
        environment, definition, ...await trialResults(dir, resolved, definition, signal)};
      const summary = {...fields(value, trialFields), refs: value.refs.map(ref => fields(ref, refFields))};
      await writeTrial(dir, value.id, value, summary);
      return value;
    }));
  }

  async function publish({revision, trial_id, allow_failed = false}) {
    boolean(allow_failed, 'allow_failed');
    const dir = await root();
    const filename = publicationPath(trial_id);
    return serialized(dir, async () => {
      const previous = await publication(dir);
      if (previous?.trial_id === trial_id && previous.revision === revision) return previous;
      const draft = await currentDraft(dir, previous);
      if (revision !== draft.revision) throw Error('Quality draft changed. Test the current draft before publishing.');
      if (draft.base_revision !== (previous?.revision ?? null)) {
        throw Error('Quality publication changed. Save and test a new draft.');
      }
      const proof = await evidenceAt(dir, trial_id);
      if (proof.policy !== 'draft' || proof.revision !== revision ||
          !(proof.status === 'passed' || (allow_failed && proof.status === 'failed'))) {
        throw Error('Publication requires a completed trial of this draft. Confirm any failed results.');
      }
      const saved = await readQuality(dir, filename);
      const value = saved ? validPublication(saved) : {...lockedDefinition(draft),
        trial_id, published_at: new Date().toISOString(), reviewer: 'human', trial_status: proof.status};
      if (value.revision !== revision || value.trial_id !== trial_id) throw Error('Publication receipt uses another revision');
      if (!saved) await writeQuality(dir, filename, value, {exclusive: true});
      await writeQuality(dir, policyFile, value);
      await writeQuality(dir, home + 'draft.json', {...lockedDefinition(draft), base_revision: revision, actor: 'human'});
      return value;
    });
  }

  const routes = options => operation(undefined, signal => discoverRoutes(repository, {...options, signal}));

  async function prepare(payload, actor = 'human') {
    const dir = await root();
    const prepared = await prepareRoute(dir, payload);
    if (prepared.status === 'needs_source') return prepared;
    const published = await publication(dir);
    const draft = await currentDraft(dir, published);
    const base = payload.base_revision ?? null;
    const expected = payload.expected_revision;
    if (base !== (published?.revision ?? null)) throw Error('Quality publication changed. Reload before preparing.');
    if (expected !== draft.revision) throw Error('Quality draft changed. Reload before preparing.');
    const pending = lockedDefinition(draft).definition;
    const {add, ...response} = prepared;
    const generated = add(pending);
    const candidate = validateQuality(pending);
    return {...response, generated, draft: candidate.revision === draft.revision ? draft :
      await writeDraft({definition: pending, base_revision: base, expected_revision: expected}, actor)};
  }

  async function taskCheck(payload) {
    const dir = await root();
    let policy = payload.policy;
    try { lockedDefinition(policy); }
    catch (error) {
      const previous = policy?.trial_id && await versionAt(dir, policy.trial_id).catch(() => null);
      if (!previous || !isDeepStrictEqual(previous, policy)) throw error;
      policy = previous;
    }
    return withRunner(dir, () => operation(payload.signal, signal => snapshotCheck(dir, {...payload, policy, signal})));
  }

  async function dispatch(method, route, payload = {}, searchParams) {
    const query = searchParams || new URLSearchParams(route.split('?')[1] || '');
    const endpoint = route.split('?')[0].replace(/^\/?(?:api\/)?/, '');
    if (method === 'GET') {
      if (endpoint === 'quality') return status();
      if (endpoint === 'quality/routes') return routes({runtime: query.get('runtime') === 'true', app: query.get('app')});
      if (endpoint === 'quality/evidence') return evidenceAt(await root(), query.get('id'));
      if (endpoint === 'quality/export') return exportEvidence(query.get('id'));
      if (endpoint === 'quality/version') return versionAt(await root(), query.get('id'));
    }
    if (method === 'POST') {
      if (endpoint === 'quality/validate') return validateQuality(payload.definition);
      if (endpoint === 'quality/draft') return writeDraft(payload);
      if (endpoint === 'quality/trial') return trial(payload);
      if (endpoint === 'quality/publish') return publish(payload);
      if (endpoint === 'quality/prepare') return prepare(payload);
    }
    throw Object.assign(Error('Unknown Quality action'), {status: 404});
  }

  async function mcp(name, args = {}) {
    switch (name) {
      case 'quality_status': return status();
      case 'quality_validate': return validateQuality(args.definition);
      case 'quality_draft': return writeDraft(args, 'agent');
      case 'quality_trial': return trial({...args, policy: 'published'}, {committed: true});
      case 'quality_evidence': return exportEvidence(args.id);
      case 'quality_routes': return routes(args);
      case 'quality_prepare_route': return prepare(args, 'agent');
      default: throw Error('Unknown Quality tool');
    }
  }

  async function dispose() {
    controllers.forEach(controller => controller.abort());
  }

  return {dispatch, mcp, pin, taskCheck, dispose};
}

export {stopQualityProcesses, validateQuality};
