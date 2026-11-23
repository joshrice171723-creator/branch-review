import {createHash, randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createReadStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {WorkbenchProfile, modelCatalog, presetDocuments} from './profile.mjs';
import {capture, checkArgv} from './quality/runner.mjs';
import {checkFile, checkPathInside, resolveCheckCommand} from './check-command.mjs';
import {cosmeticCandidate, cosmeticDiff} from './automatic-route.mjs';

const exec = promisify(execFile);
const runPattern = /^\d{8}T\d{12}-[a-f0-9]{8}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const checkPattern = /^[a-z][a-z0-9_-]*$/;
const modes = ['audit', 'refactor', 'feature', 'build'];
const phases = ['baseline', 'after'];
const lifecycleStates = ['active', 'paused', 'stopped', 'completed'];
const evidenceFolders = ['answers', 'audits', 'lifecycle', 'repair_rounds', 'reports', 'reviews'];
const excluded = new Set(['.harness', '.git', 'node_modules', 'vendor', '.bundle', '.cache', '.next',
  '.vite', '.parcel-cache', 'coverage', 'dist', 'build', 'tmp', 'log', '__pycache__']);
const dependencies = /^(?:Gemfile(?:\.lock)?|package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|Pipfile(?:\.lock)?|pyproject\.toml|poetry\.lock|composer\.(?:json|lock)|Cargo\.(?:toml|lock)|go\.(?:mod|sum))$/;
const criteriaIds = ['correctness', 'human_readability', 'maintainability', 'performance', 'failure_handling', 'scope_and_constraints'];
const supportRoot = fileURLToPath(new URL('.', import.meta.url));
const maxRecord = 64 * 1024 * 1024;
let lastIdentifier = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = value => typeof value === 'string' && value.trim() !== '';
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const compareKeys = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const json = value => JSON.stringify(value, null, 2) + '\n';
const passing = result => result?.exit_code === 0 && result.source_changed === false && result.inputs_changed !== true;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item)).join(',') + ']';
  if (!object(value)) return JSON.stringify(value);
  return '{' + Object.keys(value).sort(compareKeys).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function fingerprint(value) {
  return hash(canonical(value));
}

function identifier() {
  lastIdentifier = Math.max(Date.now() * 1000, lastIdentifier + 1);
  const date = new Date(Math.floor(lastIdentifier / 1000)).toISOString().replace(/[-:.Z]/g, '');
  return date + String(lastIdentifier % 1000).padStart(3, '0') + '-' + randomBytes(4).toString('hex');
}

function missing(error) {
  if (error.code === 'ENOENT') return null;
  throw error;
}

function safePath(root, relative) {
  assert(filled(relative) && !path.isAbsolute(relative) && !relative.includes('\\') &&
    !relative.includes(':') && !relative.includes('\0') &&
    relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid Workbench path.');
  const destination = path.resolve(root, relative);
  assert(destination.startsWith(root + path.sep), 'Path escapes the Workbench directory.');
  return destination;
}

async function owned(root, relative, directory = false) {
  const file = safePath(root, relative);
  const info = await fs.lstat(file);
  assert(await fs.realpath(file) === file && (directory ? info.isDirectory() : info.isFile()),
    'Invalid Workbench path: ' + relative);
  return {file, info};
}

async function read(root, relative) {
  const {file, info} = await owned(root, relative);
  assert(info.size <= maxRecord, 'Workbench record is too large: ' + relative);
  return fs.readFile(file);
}

async function readJson(root, relative) {
  return JSON.parse((await read(root, relative)).toString('utf8').replace(/^\uFEFF/, ''));
}

async function directory(root, relative) {
  for (const part of relative.split('/')) {
    const child = safePath(root, part);
    await fs.mkdir(child).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    root = (await owned(root, part, true)).file;
  }
  return root;
}

async function entries(root, relative) {
  const place = await owned(root, relative, true).catch(missing);
  return place ? fs.readdir(place.file, {withFileTypes: true}) : [];
}

async function atomicWrite(target, value) {
  const draft = target + '.tmp-' + randomBytes(8).toString('hex');
  try {
    await fs.writeFile(draft, value, {flag:'wx'});
    await fs.rename(draft, target);
  } finally {
    await fs.rm(draft, {force:true});
  }
}

async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function filesUnder(root, {source = false, legacyGitFile = false, prefix = ''} = {}) {
  const files = [];
  for (const entry of await fs.readdir(root, {withFileTypes: true})) {
    const name = prefix + entry.name;
    const candidate = path.join(root, entry.name);
    if (source && (name === 'workbench-quality.json' || !legacyGitFile && entry.name === '.git' ||
      excluded.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))) continue;
    if (entry.isDirectory()) {
      files.push(...await filesUnder(candidate, {source, legacyGitFile, prefix:name + '/'}));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push({name, file:candidate, symlink:entry.isSymbolicLink()});
    }
  }
  return files;
}

async function git(root, ...args) {
  return exec('git', args, {cwd:root, windowsHide:true, maxBuffer:maxRecord})
    .then(result => result.stdout, () => '');
}

const localPreviewLog = '.local-dev/workspace/workbench-environment/preview-output.json';

async function sourceSnapshot(root, task) {
  const legacyGitFile = task?.harness_version !== '0.3.0-native' &&
    Object.keys(task?.initial_snapshot?.files ?? {}).some(name => path.posix.basename(name) === '.git');
  const all = await filesUnder(root, {source:true, legacyGitFile});
  all.sort((left, right) => compareKeys(left.name, right.name));
  const files = Object.create(null);
  const protectedFiles = Object.create(null);
  const index = await git(root, 'ls-files', '--stage', '-z');
  const tracked = new Set(index.split('\0').filter(Boolean).map(row => row.slice(row.indexOf('\t') + 1)));
  const trackedProtected = Object.create(null);
  for (const {name, file, symlink} of all) {
    if (name === localPreviewLog && !tracked.has(name)) continue;
    files[name] = symlink ?
      hash(Buffer.concat([Buffer.from('symlink:'), await fs.readlink(file, {encoding:'buffer'})])) : await fileHash(file);
    if (dependencies.test(path.posix.basename(name)) || /(?:^|\/)db\/(?:migrate\/|schema\.|structure\.)/.test(name)) {
      protectedFiles[name] = files[name];
      if (tracked.has(name)) trackedProtected[name] = files[name];
    }
  }
  const [head, branch] = await Promise.all([git(root, 'rev-parse', '--verify', 'HEAD'), git(root, 'symbolic-ref', '--quiet', 'HEAD')]);
  return {files, protected:protectedFiles, tracked_protected:trackedProtected, snapshot_sha256:fingerprint(files),
    head:head.trim() || null, branch:branch.trim() || null, index_sha256:hash(index)};
}

function changeFingerprint(before, after) {
  return fingerprint([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort(compareKeys).filter(name => before[name] !== after[name])
    .map(name => [name, before[name] ?? null, after[name] ?? null]));
}

function verifyCriteria(data, rubric) {
  const rows = data.criteria;
  if (!Array.isArray(rows) || rows.some(row => !object(row))) return ['Record all required review criteria.'];
  const used = rows.map(row => row.id);
  const issues = [];
  if (new Set(used).size !== used.length) issues.push('Review criterion IDs must be unique.');
  if (rubric && used.some(id => !rubric.criteria.some(row => row.id === id))) issues.push('Review contains an unknown criterion.');
  const required = rubric ? rubric.criteria.filter(row => row.required).map(row => row.id) : criteriaIds;
  for (const id of required) {
    const row = rows.find(item => item.id === id);
    if (!Array.isArray(row?.evidence) || !row.evidence.some(filled) ||
        !(row.verdict === 'pass' || row.verdict === 'not_applicable' && filled(row.reason))) {
      issues.push('Required criterion needs passing evidence: ' + id);
    }
  }
  return issues;
}

function checkList(config) {
  assert(Array.isArray(config.checks), 'Checks must be an array.');
  assert(new Set(config.checks.map(row => row?.name)).size === config.checks.length, 'Check names must be unique.');
  for (const row of config.checks) {
    assert(object(row) && typeof row.name === 'string' && checkPattern.test(row.name), 'Invalid check name.');
    assert(Array.isArray(row.argv) && row.argv.length &&
      row.argv.every(arg => typeof arg === 'string' && arg.length && !arg.includes('\0')),
      'Checks require explicit argv arrays.');
    assert(typeof row.required === 'boolean' && typeof row.benchmark === 'boolean', 'Check flags must be boolean.');
    assert(row.timeout_seconds === undefined || Number.isInteger(row.timeout_seconds) &&
      row.timeout_seconds >= 1 && row.timeout_seconds <= 900, 'Set the check timeout from 1 to 900 seconds.');
    assert(row.input_paths === undefined || Array.isArray(row.input_paths) &&
      new Set(row.input_paths).size === row.input_paths.length && row.input_paths.every(name =>
        filled(name) && !/[\\:\x00-\x1f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..')),
    'Check input_paths must contain unique project-relative file paths.');
    const selected = row.phases ?? phases;
    const both = Array.isArray(selected) && selected.join(',') === 'baseline,after';
    assert(both || Array.isArray(selected) && selected.length === 1 && selected[0] === 'after' && !row.benchmark,
      'Configure baseline and after, or after only for a check.');
  }
  return config.checks;
}

async function projectCwd(root, cwd = '.', allowFuture = false) {
  assert(filled(cwd) && !path.isAbsolute(cwd), 'Select a check working directory inside the project.');
  const target = path.resolve(root, cwd);
  assert(checkPathInside(root, target), 'Select a check working directory inside the project.');
  const directory = await fs.realpath(target).catch(missing);
  if (!directory && allowFuture) return target;
  assert(directory && checkPathInside(root, directory) && (await fs.stat(directory)).isDirectory(),
    'Select a check working directory inside the project.');
  return directory;
}

function projectedConfig(config, profile, quality) {
  if (profile) {
    const selected = profile.profiles[profile.active];
    config = {...config, checks:profile.checks, benchmark:profile.benchmark, execution:{...config.execution,
      workflow:'audited', max_repair_rounds:selected.stages.buildReview.limit}};
  }
  if (quality) {
    assert(digestPattern.test(quality.revision) && Array.isArray(quality.definition?.checks) &&
      Array.isArray(quality.definition?.benchmarks), 'Invalid Workbench Quality pin.');
    const measured = new Set(quality.definition.benchmarks.map(row => row.check_id));
    config = {...config, quality_revision:quality.revision, benchmark:{},
      checks:quality.definition.checks.map(row => ({...row, name:row.id, benchmark:measured.has(row.id)}))};
  }
  return config;
}

async function prepareCheck(root, check, {quality, allowFuture} = {}) {
  const cwd = await projectCwd(root, check.cwd, allowFuture);
  const argv = quality ? checkArgv(check.argv) : check.argv;
  const command = await resolveCheckCommand(argv, cwd).catch(error => {
    if (allowFuture && error.input && checkPathInside(root, error.input)) return null;
    throw error;
  });
  const inputs = [];
  for (const name of check.input_paths ?? []) {
    const file = await checkFile(safePath(root, name));
    assert(file || allowFuture, 'Check input file is missing or unreadable: ' + name);
    if (file) {
      assert(checkPathInside(root, file.target), 'Check input file must resolve inside the project: ' + name);
      inputs.push(file);
    }
  }
  return {root, cwd, argv, command, inputs, timeout:check.timeout_seconds ?? 300};
}

async function checkInputFingerprint({root, cwd, command, inputs, timeout}, executableHash) {
  const files = new Map([command.executable, ...command.entryFiles, ...inputs].map(file => [file.file, file]));
  for (const arg of command.args) {
    const name = arg.replace(/^--[^=]+=/, '');
    if (name.startsWith('-') || /[\x00-\x1f<>"|*?]/.test(name) || /^(?:[a-z]+:)?[/\\]{2}/i.test(name)) continue;
    const file = path.resolve(cwd, name);
    if (files.has(file) || file === path.join(root, localPreviewLog)) continue;
    const input = await checkFile(file);
    if (input) files.set(file, input);
  }
  const knownInputs = await Promise.all([...files.values()].map(async ({file, target, mode}) => ({
    file, target, mode,
    sha256:await (file === command.file ? executableHash(target) : fileHash(target))
  })));
  return fingerprint({cwd, file:command.file, args:command.args, node_mode:command.nodeMode, timeout, files:knownInputs});
}

async function executableSignature(file) {
  const {dev, ino, size, mode, mtimeNs, ctimeNs} = await fs.stat(file, {bigint:true});
  return [dev, ino, size, mode, mtimeNs, ctimeNs].join(':');
}

function failedCommand(error, signal) {
  return {stdout:'', stderr:error.message, exit_code:signal?.aborted ? 128 : 127, spawn_error:error.message};
}

async function command(prepared, signal) {
  try {
    const {cwd, argv, command, timeout} = prepared;
    const result = await capture(argv, {cwd, command, signal, encoding:null, limit:maxRecord, timeout, stopOnLimit:true});
    return {...result, exit_code:result.exit_code ?? (signal?.aborted ? 128 : 127), spawn_error:result.error ?? null};
  } catch (error) {
    return failedCommand(error, signal);
  }
}

async function artifactLedger(taskDir) {
  const raw = await read(taskDir, 'events.jsonl').catch(missing);
  if (!raw) return {raw:null, rows:[]};
  const lines = raw.toString('utf8').trimEnd().split('\n');
  return {raw, rows:lines.map(line => JSON.parse(line))};
}

async function integrityIssues(taskDir) {
  try {
    const {raw, rows} = await artifactLedger(taskDir);
    if (!raw) return ['Task artifact ledger is missing.'];
    let previous = null;
    const registered = new Set();
    const issues = [];
    for (const entry of rows) {
      const {sha256, ...payload} = entry;
      if (payload.previous !== previous || fingerprint(payload) !== sha256 || registered.has(entry.path)) {
        issues.push('Artifact ledger was changed.');
      }
      registered.add(entry.path);
      const place = await owned(taskDir, entry.path).catch(missing);
      if (!place || await fileHash(place.file) !== entry.file_sha256) {
        issues.push('Artifact changed or is missing: ' + entry.path);
      }
      previous = sha256;
    }
    const actual = (await filesUnder(taskDir)).filter(row => row.name !== 'events.jsonl');
    if (actual.length !== registered.size || actual.some(row => !registered.has(row.name))) {
      issues.push('Task contains unregistered evidence artifacts.');
    }
    return [...new Set(issues)];
  } catch (error) {
    return ['Artifact ledger is invalid: ' + error.message];
  }
}

async function batch(taskDir, artifacts, home) {
  if (!artifacts.length) return;
  const {raw, rows} = await artifactLedger(taskDir);
  let previous = rows.at(-1)?.sha256 ?? null;
  const additions = [];
  for (const [relative, contents] of artifacts) {
    const target = safePath(taskDir, relative);
    assert(await fs.lstat(target).catch(missing) === null, 'Evidence already exists: ' + relative);
    const payload = {path:relative, file_sha256:hash(contents), previous};
    previous = fingerprint(payload);
    additions.push({...payload, sha256:previous});
  }
  const ledger = Buffer.concat([raw ?? Buffer.alloc(0), Buffer.from(additions.map(row => JSON.stringify(row) + '\n').join(''))]);
  const journal = home && safePath(home, 'native-transaction.json');
  const staging = await fs.mkdtemp(path.join(home ?? path.dirname(taskDir), 'native-evidence-'));
  const created = [];
  let clearJournal = false;
  try {
    for (const [index, [, contents]] of artifacts.entries()) {
      await fs.writeFile(path.join(staging, String(index)), contents, {flag:'wx'});
    }
    const nextLedger = path.join(staging, 'ledger');
    await fs.writeFile(nextLedger, ledger, {flag:'wx'});
    if (journal) {
      await atomicWrite(journal, json({task:path.basename(taskDir), previous:raw ? hash(raw) : null,
        next:hash(ledger), artifacts:additions.map(row => ({path:row.path, hash:row.file_sha256}))}));
    }
    for (const [index, [relative]] of artifacts.entries()) {
      const parent = path.posix.dirname(relative);
      if (parent !== '.') await directory(taskDir, parent);
      const target = safePath(taskDir, relative);
      await fs.link(path.join(staging, String(index)), target);
      created.push(target);
    }
    await fs.rename(nextLedger, safePath(taskDir, 'events.jsonl'));
    clearJournal = true;
  } catch (error) {
    for (const target of created) await fs.unlink(target).catch(missing);
    clearJournal = true;
    throw error;
  } finally {
    if (journal && clearJournal) await fs.rm(journal, {force:true});
    await fs.rm(staging, {recursive:true, force:true});
  }
}

async function recoverBatch(home) {
  const journal = await readJson(home, 'native-transaction.json').catch(missing);
  if (!journal) return;
  if (journal.kind === 'start') {
    assert(runPattern.test(journal.task) && /^native-start-[\w-]+$/.test(journal.stage), 'Invalid Workbench start journal.');
    const task = await owned(home, 'tasks/' + journal.task, true).catch(missing);
    if (task) {
      assert((await readJson(task.file, 'task.json')).id === journal.task && !(await integrityIssues(task.file)).length,
        'The interrupted task start requires inspection.');
      const pointer = (await read(home, 'active_task').catch(missing))?.toString().trim() ?? null;
      assert(pointer === journal.previous || pointer === journal.task, 'The active task changed during an interrupted start.');
      await atomicWrite(safePath(home, 'active_task'), journal.task);
    }
    const stage = await owned(home, journal.stage, true).catch(missing);
    if (stage) await fs.rm(stage.file, {recursive:true});
    await fs.unlink(safePath(home, 'native-transaction.json'));
    return;
  }
  assert(runPattern.test(journal.task) && Array.isArray(journal.artifacts), 'Invalid Workbench transaction journal.');
  const taskDir = (await owned(home, 'tasks/' + journal.task, true)).file;
  const raw = await read(taskDir, 'events.jsonl').catch(missing);
  const current = raw ? hash(raw) : null;
  assert(current === journal.previous || current === journal.next, 'Task ledger changed during an interrupted Workbench write.');
  if (current === journal.previous) {
    for (const entry of journal.artifacts) {
      const target = await owned(taskDir, entry.path).catch(missing);
      if (!target) continue;
      assert(await fileHash(target.file) === entry.hash, 'Interrupted Workbench evidence requires inspection.');
      await fs.unlink(target.file);
    }
  }
  await fs.unlink(safePath(home, 'native-transaction.json'));
}

async function lock(home, operation) {
  const file = safePath(home, 'native.lock');
  const until = Date.now() + 30_000;
  let handle;
  while (!handle) {
    try { handle = await fs.open(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await read(home, 'native.lock').catch(missing);
      if (!owner) continue;
      const pid = Number(owner.toString());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, 0); }
        catch (probe) {
          if (probe.code === 'ESRCH' && owner.equals(await read(home, 'native.lock').catch(missing) ?? Buffer.alloc(0))) {
            await fs.unlink(file).catch(missing);
            continue;
          }
        }
      }
      assert(Date.now() < until, 'The Workbench workspace is busy.');
      await delay(80);
    }
  }
  try {
    await handle.writeFile(String(process.pid));
    await recoverBatch(home);
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(file).catch(missing);
  }
}

export function createStore(repository, {engineRoot = path.join(supportRoot, 'engine'), qualityPin, qualityCheck} = {}) {
  const resolvedRoot = fs.realpath(repository);
  const executables = new Map();
  let qualityService;

  async function executableHash(file) {
    const signature = await executableSignature(file);
    const saved = executables.get(file);
    if (saved?.signature === signature) return saved.sha256;
    const sha256 = fileHash(file).then(async digest => {
      assert(signature === await executableSignature(file), 'Check executable changed while reading: ' + file);
      return digest;
    });
    executables.set(file, {signature, sha256});
    try { return await sha256; }
    catch (error) {
      if (executables.get(file)?.sha256 === sha256) executables.delete(file);
      throw error;
    }
  }

  async function qualityRunner() {
    qualityService ??= import('./quality.mjs').then(({createQuality}) => createQuality({repository}));
    return qualityService;
  }

  async function publishedQuality() {
    if (qualityPin) return qualityPin();
    const root = await resolvedRoot;
    if (!await owned(root, 'workbench-quality.json').catch(missing)) return null;
    return (await qualityRunner()).pin();
  }

  async function homeDirectory(create = false) {
    const root = await resolvedRoot;
    if (create) return directory(root, '.harness');
    return (await owned(root, '.harness', true).catch(missing))?.file ?? null;
  }

  async function mutate(operation) {
    const home = await homeDirectory(true);
    return lock(home, () => operation(home));
  }

  async function bundledConfig() {
    const source = await fs.realpath(engineRoot);
    const included = Object.fromEntries(await Promise.all((await filesUnder(source)).map(async ({name, file, symlink}) => {
      assert(!symlink, 'Invalid bundled engine file: ' + name);
      return ['.harness/engine/' + name, await fileHash(file)];
    })));
    const instructions = '.harness/engine/ENGINE.md';
    assert(included[instructions], 'The bundled coding engine is missing.');
    return {schema_version:1, engine:{version:'generic-2.10.6.3.1-derived-0.2.0', instructions_path:instructions,
      sha256:included[instructions], included_files:included, included_files_sha256:fingerprint(included)},
      checks:[], benchmark:{name:'', version:'', cases:[], workload:'', metrics:[], assertions:[], checks:[], scripts:[]},
      execution:{max_repair_rounds:3}, agent:{model:'gpt-6.2-astra', effort:'high'}};
  }

  async function config() {
    const home = await homeDirectory();
    const installed = home && await readJson(home, 'project.json').catch(missing);
    if (installed) {
      assert(object(installed) && installed.schema_version === 1, 'Use a version 1 project configuration.');
      return installed;
    }
    return bundledConfig();
  }

  async function questionsDefinition() {
    const home = await homeDirectory();
    const installed = home && await read(home, 'config/questions.json').catch(missing);
    const raw = installed ?? await fs.readFile(path.join(supportRoot, 'questions.json'));
    return {raw, value:JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))};
  }

  async function install(home) {
    const installed = await readJson(home, 'project.json').catch(missing);
    if (installed) return installed;
    const settings = await bundledConfig();
    for (const [name, expected] of Object.entries(settings.engine.included_files)) {
      const relative = name.slice('.harness/'.length);
      const source = await fs.readFile(path.join(engineRoot, relative.slice('engine/'.length)));
      assert(hash(source) === expected, 'Bundled engine file changed: ' + relative);
      await directory(home, path.posix.dirname(relative));
      const target = safePath(home, relative);
      const current = await read(home, relative).catch(missing);
      if (current) assert(hash(current) === expected, 'Existing engine differs from the bundled engine: ' + relative);
      else await fs.writeFile(target, source, {flag:'wx'});
    }
    await directory(home, 'config');
    if (!await read(home, 'config/questions.json').catch(missing)) {
      await fs.writeFile(safePath(home, 'config/questions.json'), (await questionsDefinition()).raw, {flag:'wx'});
    }
    await atomicWrite(safePath(home, 'project.json'), json(settings));
    return settings;
  }

  async function engineIssues(engine) {
    if (!filled(engine?.instructions_path) || !digestPattern.test(engine.sha256 ?? '')) {
      return ['Configure the coding engine instructions and SHA-256.'];
    }
    const root = await resolvedRoot;
    const manifest = engine.included_files ?? {};
    if (!object(manifest)) return ['Engine included_files must map paths to SHA-256 values.'];
    const issues = [];
    if (Object.keys(manifest).length && fingerprint(manifest) !== engine.included_files_sha256) {
      issues.push('Engine included-file manifest changed.');
    }
    const checks = [[engine.instructions_path, engine.sha256], ...Object.entries(manifest)];
    for (const [name, expected] of checks) {
      let verified = false;
      try { verified = await fileHash((await owned(root, name)).file) === expected; }
      catch { /* Report invalid or missing engine files without using them. */ }
      if (!verified) issues.push('Engine file changed or is missing: ' + name);
    }
    return [...new Set(issues)];
  }

  async function profileFor(settings) {
    const home = await homeDirectory();
    const saved = home && await readJson(home, 'profile.json').catch(missing);
    return WorkbenchProfile.resolve(saved, settings, presetDocuments, modelCatalog);
  }

  async function getProfile() {
    return profileFor(await config());
  }

  async function profileApplied() {
    const home = await homeDirectory();
    return Boolean(home && await owned(home, 'profile.json').catch(missing) &&
      !await owned(home, 'profile.disabled').catch(missing));
  }

  async function effectiveConfig() {
    const settings = await config();
    return projectedConfig(settings, await profileFor(settings), await publishedQuality());
  }

  async function validateChecks(settings) {
    const root = await resolvedRoot;
    const checks = checkList(settings);
    for (const check of checks) await projectCwd(root, check.cwd, check.phases?.join(',') === 'after');
    return checks;
  }

  async function setProfile(candidate) {
    return mutate(async home => {
      const settings = await install(home);
      const profile = WorkbenchProfile.resolve(candidate, settings, presetDocuments, modelCatalog);
      const configured = projectedConfig(settings, profile);
      const checks = await validateChecks(configured);
      if (checks.some(row => row.benchmark)) await benchmarkContract(configured);
      await atomicWrite(safePath(home, 'profile.json'), json(profile));
      await fs.unlink(safePath(home, 'profile.disabled')).catch(missing);
      return profile;
    });
  }

  async function activeId(home) {
    if (!home) return null;
    const raw = await read(home, 'active_task').catch(missing);
    const id = raw?.toString('utf8').trim() || null;
    assert(id === null || runPattern.test(id), 'Invalid active Workbench run ID.');
    return id;
  }

  async function selected(id, home) {
    home ??= await homeDirectory();
    id ??= await activeId(home);
    assert(home && typeof id === 'string' && runPattern.test(id), 'Choose a recorded Workbench run.');
    const taskDir = (await owned(home, 'tasks/' + id, true)).file;
    const task = await readJson(taskDir, 'task.json');
    assert(task?.id === id, 'Invalid Workbench task identity.');
    return {home, taskDir, task, id};
  }

  async function records(taskDir, folder) {
    const names = (await entries(taskDir, folder)).filter(row => row.isFile() && /^[\w-]+\.json$/.test(row.name))
      .map(row => row.name).sort();
    return Promise.all(names.map(name => readJson(taskDir, folder + '/' + name)));
  }

  async function lifecycle({taskDir, task}) {
    try {
      const latest = (await records(taskDir, 'lifecycle')).at(-1);
      assert(!latest || lifecycleStates.includes(latest.status), 'Invalid task status.');
      return latest ?? {status:'active', reason:'Task started', at:task.created_at};
    } catch (error) {
      return {status:'unverified', reason:'Cannot read task lifecycle. ' + error.message};
    }
  }

  async function setConfig(candidate) {
    assert(object(candidate) && candidate.schema_version === 1, 'Use a version 1 project configuration.');
    candidate = structuredClone(candidate);
    return mutate(async home => {
      const current = await install(home);
      const execution = candidate.execution ?? {max_repair_rounds:3};
      const limit = execution?.max_repair_rounds;
      assert(Number.isInteger(limit) && limit >= 1 && limit <= 20, 'Set a repair limit from 1 to 20.');
      assert(['manual', 'audited', undefined].includes(execution.workflow), 'Select manual or audited workflow.');
      assert(execution.vaults === undefined || Array.isArray(execution.vaults) && execution.vaults.every(filled),
        'Vaults must be an array of directory names.');
      assert(filled(candidate.agent?.model) && WorkbenchProfile.efforts.includes(candidate.agent.effort),
        'Set the agent model and reasoning effort.');
      candidate.execution = execution;
      const state = await activeId(home);
      if (state) {
        const run = await selected(state, home);
        const latest = await lifecycle(run);
        assert(latest.status !== 'unverified', latest.reason);
        if (latest.status === 'active') {
          assert(!run.task.configuration || fingerprint(current) === fingerprint(candidate),
            'The execution configuration is pinned for the active task.');
          assert(!await read(run.taskDir, 'execution_config.json').catch(missing),
            'Execution configuration is frozen for the active task.');
          assert(['engine', 'agent', 'execution'].every(key => fingerprint(current[key]) === fingerprint(candidate[key])),
            'The engine, agent, and repair limit are pinned for the active task.');
        }
      }
      const issues = await engineIssues(candidate.engine);
      assert(!issues.length, issues.join(' '));
      const checks = await validateChecks(candidate);
      if (checks.some(row => row.benchmark)) await benchmarkContract(candidate);
      await atomicWrite(safePath(home, 'project.json'), json(candidate));
      return {configured:true, project:await resolvedRoot, config_sha256:fingerprint(candidate),
        engine:candidate.engine, checks:candidate.checks, execution:candidate.execution};
    });
  }

  async function benchmarkContract(settings, quality) {
    const root = await resolvedRoot;
    const checks = checkList(settings).filter(row => row.benchmark);
    const scripts = {};
    if (quality) {
      const definitions = quality.definition.benchmarks;
      for (const name of new Set(definitions.flatMap(row => [...row.scripts, ...row.fixtures.map(fixture => fixture.path)]))) {
        scripts[name] = await fileHash((await owned(root, name)).file);
      }
      return {quality_revision:quality.revision, definitions, checks, scripts};
    }
    const contract = settings.benchmark;
    assert(object(contract) && ['name', 'version', 'workload'].every(key => filled(contract[key])),
      'Set the benchmark name, version, and workload.');
    assert(['cases', 'metrics', 'assertions', 'checks'].every(key => Array.isArray(contract[key]) && contract[key].length),
      'Set benchmark cases, metrics, assertions, and checks.');
    assert([...contract.checks].sort().join('\0') === checks.map(row => row.name).sort().join('\0'),
      'List each benchmark check once in the benchmark contract.');
    assert(Array.isArray(contract.scripts ?? []) && (contract.scripts ?? []).every(filled), 'List the benchmark scripts.');
    for (const name of contract.scripts ?? []) scripts[name] = await fileHash((await owned(root, name)).file);
    return {contract, checks, scripts};
  }

  async function validateAnswer(task, question, option, source, channel) {
    const row = (await questionsDefinition()).value.questions.find(item => item.id === question);
    assert(row, 'Unknown agreement question: ' + question);
    assert(filled(option) && (row.custom || row.options.includes(option)), 'Choose an allowed answer for ' + question + '.');
    assert(task.mode !== 'audit' || question !== 'code_changes' || option === 'deny', 'Audit mode requires read-only access.');
    assert(['form', 'cli', 'chat'].includes(channel), 'Choose a supported answer channel.');
    if (source) {
      assert(['code_changes', 'migrations', 'dependencies'].includes(question) && option === 'deny' &&
        object(source) && filled(source.quote), 'Citations can only support explicit restrictions.');
      const quote = source.quote.trim();
      if (source.kind === 'task_request') {
        assert([task.action, task.scope].some(value => value.includes(quote)), 'The cited decision is missing from the task request.');
        source = {kind:source.kind, quote, channel};
      } else {
        assert(source.kind === 'project_file', 'Choose a task request or project file citation.');
        const root = await resolvedRoot;
        const {file, info} = await owned(root, source.path);
        assert(!source.path.split('/').some(part => excluded.has(part)) && /\.(?:md|txt)$/i.test(source.path) &&
          info.size <= 1_048_576, 'Choose a project Markdown or text decision file.');
        const content = await fs.readFile(file);
        const text = new TextDecoder('utf-8', {fatal:true}).decode(content);
        assert(text.replace(/\r\n/g, '\n').includes(quote.replace(/\r\n/g, '\n')),
          'The cited decision is missing from the project file.');
        source = {kind:source.kind, quote, channel, path:source.path, sha256:hash(content)};
      }
    } else {
      source = {kind:'task_answer', channel};
    }
    return {question, option, source, recorded_at:now()};
  }

  async function startTask({mode = 'build', action, scope, decisions = {}, channel = 'form', automaticPlan} = {}) {
    assert(modes.includes(mode), 'Choose audit, refactor, feature, or build.');
    assert(filled(action) && action.length <= 4_000 && filled(scope) && scope.length <= 16_000, 'Enter the task action and scope.');
    assert(object(decisions), 'Task answers must be an object.');
    return mutate(async home => {
      const active = await activeId(home);
      if (active) {
        const state = await lifecycle(await selected(active, home));
        assert(state.status !== 'unverified', state.reason);
        assert(state.status !== 'active', 'An active task owns this workspace. Pause, stop, or finish it first.');
      }
      const settings = await install(home);
      const saved = await read(home, 'profile.json').catch(missing);
      const manual = await read(home, 'profile.disabled').catch(missing);
      const profile = manual || !saved && settings.execution?.workflow === 'manual' ? null : await profileFor(settings);
      const quality = await publishedQuality();
      const configuration = projectedConfig(settings, profile, quality);
      const engine = await engineIssues(configuration.engine);
      assert(!engine.length, engine.join(' '));
      const checks = await validateChecks(configuration);
      if (saved && !manual || quality) {
        assert(checks.some(row => row.required || row.benchmark), 'Configure a required check before starting this task.');
      }
      if (mode === 'audit' || mode === 'refactor') {
        assert(checks.every(row => (row.phases ?? phases).includes('baseline')), 'Configure baseline and after checks for this mode.');
      }
      if (checks.some(row => row.benchmark)) await benchmarkContract(configuration, quality);
      const root = await resolvedRoot;
      const snapshot = await sourceSnapshot(root);
      const id = identifier();
      const task = {id, mode, action:action.trim(), scope:scope.trim(), created_at:now(), initial_snapshot:snapshot,
        initial_config_sha256:fingerprint(configuration), harness_version:'0.3.0-native', configuration,
        engine:configuration.engine, agent:configuration.agent, execution:configuration.execution,
        questions_sha256:hash((await questionsDefinition()).raw)};
      if (profile) Object.assign(task, {profile, profile_sha256:fingerprint(profile)});
      if (quality) task.quality = quality;
      if (mode === 'build' && typeof automaticPlan === 'string' && automaticPlan.length <= 64000) {
        const check = cosmeticCandidate({plan:automaticPlan, profile, quality, checks});
        if (check) task.cosmetic_route = {check, approved_plan_sha256:hash(automaticPlan)};
      }
      const artifacts = [['task.json', json(task)], ['snapshots/' + snapshot.snapshot_sha256.slice(0, 20) + '.json', json(snapshot)]];
      for (const [question, choice] of Object.entries(decisions)) {
        const answer = await validateAnswer(task, question, object(choice) ? choice.option : choice, choice?.source, channel);
        artifacts.push(['answers/' + identifier() + '.json', json(answer)]);
      }
      const tasks = await directory(home, 'tasks');
      const stage = await fs.mkdtemp(path.join(home, 'native-start-'));
      const target = safePath(tasks, id);
      const journal = safePath(home, 'native-transaction.json');
      try {
        await batch(stage, artifacts);
        await atomicWrite(journal, json({kind:'start', task:id, stage:path.basename(stage), previous:active}));
        await fs.rename(stage, target);
        try { await atomicWrite(safePath(home, 'active_task'), id); }
        catch (error) {
          await fs.rename(target, stage);
          throw error;
        }
      } finally {
        await fs.rm(stage, {recursive:true, force:true});
        await fs.rm(journal, {force:true});
      }
      return {task_id:id, mode, task, snapshot_sha256:snapshot.snapshot_sha256, ...(quality && {quality_revision:quality.revision})};
    });
  }

  async function questions(id) {
    const {value} = await questionsDefinition();
    const home = await homeDirectory();
    const current = id ?? await activeId(home);
    if (!current) return {...value, answers:{}, unanswered_questions:value.questions.filter(row => row.required),
      missing_required:value.questions.filter(row => row.required).map(row => row.id)};
    const {taskDir, task} = await selected(current, home);
    const recorded = new Map((await records(taskDir, 'answers')).map(row => [row.question, row]));
    const rows = value.questions.map(row => ({...row,
      suggested_answer:row.recommended_by_mode?.[task.mode] ?? row.suggested_answer,
      recorded_answer:recorded.get(row.id)?.option ?? null, answer_source:recorded.get(row.id)?.source ?? null}));
    const missing = rows.filter(row => row.required && !recorded.has(row.id));
    return {...value, questions:rows, answers:Object.fromEntries([...recorded].map(([key, row]) => [key, row.option])),
      unanswered_questions:missing, missing_required:missing.map(row => row.id)};
  }

  async function executionConfig(id) {
    return configurationFor(await selected(id));
  }

  async function pinnedConfiguration(run) {
    return run.task.configuration ?? await readJson(run.taskDir, 'execution_config.json').catch(missing) ??
      projectedConfig(await config(), run.task.profile, run.task.quality);
  }

  async function configurationFor(run) {
    const pinned = await pinnedConfiguration(run);
    const added = (await records(run.taskDir, 'lifecycle')).findLast(row => row.verification_checks)?.verification_checks;
    return added?.length ? {...pinned, checks: [...pinned.checks, ...added]} : pinned;
  }

  async function preflightChecks(id, {phase = 'baseline'} = {}) {
    const run = await selected(id);
    const root = await resolvedRoot;
    const blockers = [];
    for (const check of checkList(await configurationFor(run))) {
      if (!(check.required || check.benchmark) || !(check.phases ?? phases).includes('after')) continue;
      try {
        const allowFuture = phase === 'baseline' && !(check.phases ?? phases).includes('baseline');
        await prepareCheck(root, check, {quality:run.task.quality, allowFuture});
      } catch (error) {
        blockers.push({check:check.name, reason:error.message});
      }
    }
    return blockers;
  }

  async function agreementIssues(run) {
    const {task, taskDir, id} = run;
    const issues = await integrityIssues(taskDir);
    issues.push(...await engineIssues(task.engine));
    if (hash((await questionsDefinition()).raw) !== task.questions_sha256) {
      issues.push('Required question definitions changed after task start.');
    }
    issues.push(...(await questions(id)).missing_required.map(question => 'Required question unresolved: ' + question));
    if (!filled(task.action) || !filled(task.scope)) issues.push('The action or scope is missing.');
    const settings = await configurationFor(run);
    for (const key of ['engine', 'agent', 'execution']) {
      if (canonical(task[key]) !== canonical(settings[key])) issues.push('Task ' + key + ' changed since agreement.');
    }
    if (task.configuration && task.initial_config_sha256 !== fingerprint(task.configuration)) {
      issues.push('The pinned execution configuration differs from the task agreement.');
    }
    if (task.profile && task.profile_sha256 !== fingerprint(task.profile)) issues.push('The pinned profile differs from the task agreement.');
    const frozen = await readJson(taskDir, 'execution_config.json').catch(missing);
    if (frozen && fingerprint(frozen) !== fingerprint(await pinnedConfiguration(run))) issues.push('The frozen execution configuration changed.');
    if (!task.configuration && frozen &&
        fingerprint(projectedConfig(await config(), task.profile, task.quality)) !== fingerprint(frozen)) {
      issues.push('The project execution configuration changed after agreement.');
    }
    const state = await lifecycle(run);
    if (state.status === 'unverified') issues.push(state.reason);
    return issues;
  }

  async function requireAgreement(run) {
    const current = await lifecycle(run);
    assert(current.status === 'active', 'Resume the task before continuing implementation or checks.');
    const issues = await agreementIssues(run);
    assert(!issues.length, issues.join(' '));
  }

  async function pin(run) {
    const configured = await configurationFor(run);
    if (!await read(run.taskDir, 'execution_config.json').catch(missing)) {
      await batch(run.taskDir, [['execution_config.json', json(configured)]], run.home);
    }
    return configured;
  }

  async function freeze(id) {
    return mutate(async home => {
      const run = await selected(id, home);
      await requireAgreement(run);
      await pin(run);
      return {frozen:true};
    });
  }

  async function answer(id, question, option, {source, channel = 'form'} = {}) {
    return mutate(async home => {
      const run = await selected(id, home);
      assert((await lifecycle(run)).status === 'active', 'Only an active task accepts answers.');
      assert(question === 'notes' || !await read(run.taskDir, 'execution_config.json').catch(missing),
        'Task permissions are frozen. Start a new task to change them.');
      const issues = await integrityIssues(run.taskDir);
      assert(!issues.length, issues.join(' '));
      const data = await validateAnswer(run.task, question, option, source, channel);
      await batch(run.taskDir, [['answers/' + identifier() + '.json', json(data)]], home);
      return data;
    });
  }

  async function prompt(id) {
    const run = await selected(id);
    await requireAgreement(run);
    const {task} = run;
    const {answers, questions:rows} = await questions(task.id);
    const root = await resolvedRoot;
    const engine = await read(root, task.engine.instructions_path);
    return ['# Action', task.action, 'Scope: ' + task.scope, 'Mode: ' + task.mode, '# Agreement', JSON.stringify(answers),
      'Decision sources: ' + JSON.stringify(rows.filter(row => row.answer_source).map(row => [row.id, row.answer_source])),
      '# Coding engine', engine.toString('utf8'), 'Engine SHA-256: ' + task.engine.sha256].join('\n\n');
  }

  async function snapshotArtifacts(run, snapshot) {
    const digest = snapshot.snapshot_sha256;
    for (const key of [digest.slice(0, 20), digest]) {
      const relative = 'snapshots/' + key + '.json';
      const prior = await readJson(run.taskDir, relative).catch(missing);
      if (!prior) return [[relative, json(snapshot)]];
      if (prior.snapshot_sha256 === digest) return [];
    }
    throw new Error('Snapshot identity conflicts with recorded evidence.');
  }

  async function snapshot(id) {
    if (!id) return sourceSnapshot(await resolvedRoot);
    return mutate(async home => {
      const run = await selected(id, home);
      const issues = await integrityIssues(run.taskDir);
      assert(!issues.length, issues.join(' '));
      const state = await sourceSnapshot(await resolvedRoot, run.task);
      state.diff_sha256 = changeFingerprint(run.task.initial_snapshot.files, state.files);
      await batch(run.taskDir, await snapshotArtifacts(run, state), home);
      return state;
    });
  }

  async function checkResults(run, name, phase) {
    const folder = 'results/' + name + '/' + phase;
    const rows = (await entries(run.taskDir, folder)).filter(row => row.isDirectory() && runPattern.test(row.name));
    return Promise.all(rows.map(row => row.name).sort().map(async id => {
      const relative = folder + '/' + id;
      const data = await readJson(run.taskDir, relative + '/result.json').catch(missing);
      return data && {...data, id, evidence_path:relative};
    })).then(results => results.filter(Boolean));
  }

  async function checkInputs(run, check) {
    const prepared = await prepareCheck(await resolvedRoot, check, {quality:run.task.quality});
    return {prepared, sha256:await checkInputFingerprint(prepared, executableHash)};
  }

  async function receiptIssues(run, receipt, check, current, contractHash) {
    const issues = [];
    if (receipt.check_sha256 !== fingerprint(check)) issues.push('Check configuration changed: ' + check.name);
    if (check.benchmark && receipt.benchmark_contract_sha256 !== contractHash) {
      issues.push('Check benchmark contract changed: ' + check.name);
    }
    if (run.task.quality && receipt.quality_revision !== run.task.quality.revision) {
      issues.push('Check Quality revision differs from the task: ' + check.name);
    }
    if (receipt.phase === 'after') {
      if (receipt.source_before_sha256 !== current.snapshot_sha256 || receipt.source_after_sha256 !== current.snapshot_sha256 ||
          receipt.diff_sha256 && receipt.diff_sha256 !== current.diff_sha256) {
        issues.push('After evidence is stale after source mutation: ' + check.name);
      } else if (passing(receipt)) {
        const inputs = await checkInputs(run, check).catch(() => null);
        if (!receipt.check_inputs_sha256 || receipt.check_inputs_sha256 !== inputs?.sha256) {
          issues.push('After evidence is stale after check inputs changed: ' + check.name);
        }
      }
    }
    return issues;
  }

  async function checkReceiptStatus(id, receipt, current) {
    if (!receipt) return 'stale';
    const run = await selected(id);
    const settings = await configurationFor(run);
    const check = checkList(settings).find(row => row.name === receipt.check);
    if (!check || receipt.phase !== 'after') return 'stale';
    if (!current || !current.diff_sha256 && !current.files) current = await sourceSnapshot(await resolvedRoot, run.task);
    current = {...current, diff_sha256:current.diff_sha256 ?? changeFingerprint(run.task.initial_snapshot.files, current.files)};
    const contract = check.benchmark && await benchmarkContract(settings, run.task.quality).catch(() => null);
    if (check.benchmark && !contract) return 'stale';
    if ((await receiptIssues(run, receipt, check, current, contract && fingerprint(contract))).length) return 'stale';
    return passing(receipt) ? 'passed' : 'failed';
  }

  function baselineSource(run, before, contract) {
    const initial = run.task.initial_snapshot.files;
    const filtered = {...before.files};
    for (const name of Object.keys(contract?.scripts ?? {})) {
      if (!Object.hasOwn(initial, name)) delete filtered[name];
    }
    assert(fingerprint(filtered) === run.task.initial_snapshot.snapshot_sha256, 'Application source changed before baseline verification.');
  }

  async function runPinnedCheck(run, check, phase, contract, signal) {
    const root = await resolvedRoot;
    const selected = check.phases ?? phases;
    assert(selected.includes(phase), 'This check does not define the requested phase.');
    assert(selected.includes('baseline') || ['build', 'feature'].includes(run.task.mode),
      'After-only checks require feature or build mode.');
    signal?.throwIfAborted();
    const before = await sourceSnapshot(root, run.task);
    const checkHash = fingerprint(check);
    if (phase === 'baseline') baselineSource(run, before, contract);
    else if (selected.includes('baseline')) {
      const baseline = (await checkResults(run, check.name, 'baseline')).at(-1);
      assert(passing(baseline), 'A passing baseline is required for ' + check.name + '.');
      assert(baseline.check_sha256 === checkHash, 'Check configuration changed after baseline.');
    }
    const id = identifier();
    const started_at = now();
    const start = performance.now();
    const quality = run.task.quality;
    let result;
    let measurement;
    let inputs;
    try {
      inputs = await checkInputs(run, check);
      if (quality) {
        const executeCheck = qualityCheck ?? (await qualityRunner()).taskCheck;
        measurement = await executeCheck({policy:quality, check:check.name, files:before.files, signal});
        result = {stdout:check.benchmark ? json(measurement) : measurement.stdout ?? '',
          stderr:measurement.stderr ?? measurement.error ?? '', exit_code:measurement.exit_code ?? (measurement.status === 'passed' ? 0 : 1),
          spawn_error:measurement.status === 'error' ? measurement.error ?? null : null,
          timed_out:measurement.timed_out || measurement.samples?.some(row => row.command?.timed_out || row.reset?.timed_out),
          stdout_truncated:measurement.stdout_truncated, stderr_truncated:measurement.stderr_truncated};
      } else {
        result = await command(inputs.prepared, signal);
      }
    } catch (error) {
      result = failedCommand(error, signal);
    }
    const duration_seconds = Math.round((performance.now() - start) * 1_000) / 1_000_000;
    const after = await sourceSnapshot(root, run.task);
    const source_changed = before.snapshot_sha256 !== after.snapshot_sha256 || before.head !== after.head ||
      before.branch !== after.branch || before.index_sha256 !== after.index_sha256;
    const afterInputs = inputs && await checkInputs(run, check).catch(() => null);
    const inputs_changed = Boolean(inputs && inputs.sha256 !== afterInputs?.sha256);
    const relative = 'results/' + check.name + '/' + phase + '/' + id;
    const receipt = {check:check.name, phase, argv:check.argv, cwd:check.cwd ?? '.', check_sha256:checkHash,
      source_before_sha256:before.snapshot_sha256, source_after_sha256:after.snapshot_sha256, source_changed,
      check_inputs_sha256:inputs?.sha256 ?? null, inputs_changed,
      exit_code:result.exit_code, spawn_error:result.spawn_error, started_at, duration_seconds, stdout_sha256:hash(result.stdout),
      stderr_sha256:hash(result.stderr), stdout_truncated:Boolean(result.stdout_truncated), stderr_truncated:Boolean(result.stderr_truncated),
      ...(result.timed_out && {timed_out:true}),
      benchmark_contract_sha256:contract && check.benchmark ? fingerprint(contract) : null,
      diff_sha256:changeFingerprint(run.task.initial_snapshot.files, after.files)};
    if (quality) receipt.quality_revision = quality.revision;
    if (measurement) {
      const {stdout, stderr, samples, ...summary} = measurement;
      receipt.measurement = summary;
    }
    await batch(run.taskDir, [
      [relative + '/stdout.log', result.stdout], [relative + '/stderr.log', result.stderr],
      [relative + '/result.json', json(receipt)], ...await snapshotArtifacts(run, after)
    ], run.home);
    return {...receipt, id, evidence_path:relative};
  }

  async function runConfigured(id, {name, phase, signal, benchmarks = false, reusePassing = false,
    measure = (_name, run) => run()} = {}) {
    assert(phases.includes(phase), 'Choose baseline or after.');
    return mutate(async home => {
      const run = await selected(id, home);
      await requireAgreement(run);
      const settings = await configurationFor(run);
      const configured = await validateChecks(settings);
      const checks = name ? configured.filter(row => row.name === name) : configured.filter(row =>
        (row.phases ?? phases).includes(phase) && (!benchmarks || row.benchmark));
      if (name) assert(checks.length === 1 && !checks[0].benchmark, 'Choose a configured check. Run benchmarks through the benchmark command.');
      if (!checks.length) return {checks:[], verdict:'pass'};
      const needsContract = configured.some(row => row.benchmark) &&
        (checks.some(row => row.benchmark) || phase === 'baseline');
      const contract = needsContract ? await benchmarkContract(settings, run.task.quality) : null;
      if (checks.some(row => row.benchmark)) {
        const frozen = await readJson(run.taskDir, 'benchmark/contract.json').catch(missing);
        if (frozen) assert(fingerprint(frozen) === fingerprint(contract), 'The benchmark contract, fixtures, or scripts changed.');
        else {
          assert(phase === 'baseline', 'Run a benchmark baseline before the after phase.');
          baselineSource(run, await sourceSnapshot(await resolvedRoot, run.task), contract);
          await batch(run.taskDir, [['benchmark/contract.json', json(contract)]], run.home);
        }
      }
      await pin(run);
      const results = [];
      const reuse = reusePassing && phase === 'after';
      const current = reuse && await sourceSnapshot(await resolvedRoot, run.task);
      if (reuse) current.diff_sha256 = changeFingerprint(run.task.initial_snapshot.files, current.files);
      const contractHash = contract && fingerprint(contract);
      for (const check of checks) {
        signal?.throwIfAborted();
        const receipt = reuse && (await checkResults(run, check.name, phase)).at(-1);
        if (passing(receipt) && !(await receiptIssues(run, receipt, check, current, contractHash)).length) {
          results.push({...receipt, reused:true});
        } else {
          results.push(await measure(check.name, () => runPinnedCheck(run, check, phase, contract, signal)));
        }
      }
      const gating = results.filter(row => configured.some(check => check.name === row.check && (check.required || check.benchmark)));
      return {checks:results, verdict:gating.every(passing) ? 'pass' : 'revise'};
    });
  }

  async function runCheck(id, options) {
    assert(filled(options?.name), 'Choose a configured check.');
    return (await runConfigured(id, options)).checks[0];
  }

  function skipsFinal(task) {
    return task.profile?.active === 'fast' && task.profile.profiles.fast.stages.finalReview.enabled === false;
  }

  async function checksCosmeticSource(task, current) {
    if (!task.cosmetic_route || !task.initial_snapshot.head) return false;
    const initial = task.initial_snapshot.files;
    const paths = [...new Set([...Object.keys(initial), ...Object.keys(current.files)])]
      .filter(name => initial[name] !== current.files[name]);
    if (paths.length !== 1) return false;
    const patch = await git(await resolvedRoot, '--literal-pathspecs', 'diff', '--no-ext-diff', '-U0',
      task.initial_snapshot.head, '--', paths[0]);
    return cosmeticDiff(paths, patch);
  }

  async function cosmeticSource(id, current) {
    const run = await selected(id);
    return checksCosmeticSource(run.task, current ?? await sourceSnapshot(await resolvedRoot, run.task));
  }

  function policyRubric(task, stage) {
    return task.quality?.definition.rubrics?.find(row => row.actor === 'agent' && row.stage === stage);
  }

  function reviewIssues(task, data, snapshot) {
    const issues = [];
    if (data.snapshot_sha256 !== snapshot.snapshot_sha256 ||
        data.diff_sha256 && data.diff_sha256 !== snapshot.diff_sha256) issues.push('Review is for a different source snapshot.');
    if (data.author !== 'agent' || data.verdict !== 'pass') issues.push('An agent-authored passing review is required.');
    const stage = skipsFinal(task) ? 'build_review' : 'final_review';
    if (task.quality && (data.quality_revision !== task.quality.revision || data.stage !== stage)) {
      issues.push('Review must match the pinned Quality revision and review stage.');
    }
    return issues.concat(verifyCriteria(data, policyRubric(task, stage)));
  }

  async function record(id, folder, data) {
    assert(['audits', 'reviews', 'reports'].includes(folder) && object(data), 'Choose a supported evidence record.');
    return mutate(async home => {
      const run = await selected(id, home);
      await requireAgreement(run);
      const {task} = run;
      const snapshot = await sourceSnapshot(await resolvedRoot, task);
      snapshot.diff_sha256 = changeFingerprint(task.initial_snapshot.files, snapshot.files);
      if (folder === 'audits') {
        const auditStages = ['plan_review', 'build_review', 'final_review'];
        assert(auditStages.includes(data.stage), 'Choose a supported audit stage.');
        const automatic = task.cosmetic_route && data.approved_plan_sha256 === task.cosmetic_route.approved_plan_sha256;
        const routedSkip = data.verdict === 'skipped' && automatic &&
          (data.stage === 'plan_review' && snapshot.snapshot_sha256 === task.initial_snapshot.snapshot_sha256 ||
           data.stage === 'final_review' && await checksCosmeticSource(task, snapshot));
        assert(['pass', 'replan', 'repair', 'needs_evidence'].includes(data.verdict) || routedSkip ||
          data.verdict === 'skipped' && data.stage === 'final_review' && skipsFinal(task), 'The audit verdict conflicts with the pinned profile.');
        assert(filled(data.reason) && digestPattern.test(data.plan_sha256 ?? ''), 'Record the audit evidence and plan fingerprint.');
        assert(data.snapshot_sha256 === snapshot.snapshot_sha256, 'The audit is for a different source snapshot.');
        assert(!task.profile || task.profile_sha256 === data.profile_sha256, 'The audit differs from the pinned profile.');
        assert(!task.quality || task.quality.revision === data.quality_revision, 'The audit differs from the pinned Quality revision.');
        const rubric = policyRubric(task, data.stage);
        if (rubric && data.verdict === 'pass') {
          const issues = verifyCriteria(data, rubric);
          assert(!issues.length, issues.join(' '));
        }
        data = {...data, diff_sha256:snapshot.diff_sha256};
      } else if (folder === 'reviews') {
        data = {...data, diff_sha256:snapshot.diff_sha256, review_type:'agent_authored',
          validation_issues:reviewIssues(task, data, snapshot)};
      }
      const recorded = {...data, at:data.at ?? now()};
      const evidenceId = identifier();
      const relative = folder + '/' + evidenceId + '.json';
      await batch(run.taskDir, [[relative, json(recorded)], ...await snapshotArtifacts(run, snapshot)], home);
      return {...recorded, id:evidenceId, path:relative};
    });
  }

  async function completionIssues(run, snapshot, state) {
    const {task, taskDir} = run;
    const issues = await agreementIssues(run);
    if (state.status === 'paused' || state.status === 'stopped') issues.push('Resume the task before completion.');
    const {answers} = await questions(task.id);
    const initial = task.initial_snapshot;
    if ((task.mode === 'audit' || answers.code_changes === 'deny') && initial.snapshot_sha256 !== snapshot.snapshot_sha256) {
      issues.push('Application source changed without code-change permission.');
    }
    for (const name of new Set([...Object.keys(initial.protected), ...Object.keys(snapshot.protected)])) {
      const kind = dependencies.test(path.posix.basename(name)) ? 'dependencies' : 'migrations';
      if (initial.protected[name] !== snapshot.protected[name] && answers[kind] !== 'allow') {
        issues.push('Forbidden ' + kind + ' change: ' + name);
      }
    }
    const settings = await configurationFor(run);
    const configured = checkList(settings);
    const required = configured.filter(row => row.required || row.benchmark);
    if (!required.length) issues.push('Configure at least one required check.');
    const frozenContract = await readJson(taskDir, 'benchmark/contract.json').catch(missing);
    const contractHash = frozenContract ? fingerprint(frozenContract) : null;
    if (required.some(row => row.benchmark)) {
      if (!frozenContract) issues.push('Required benchmark contract and baseline are missing.');
      else {
        try {
          if (contractHash !== fingerprint(await benchmarkContract(settings, task.quality))) {
            issues.push('Benchmark contract, fixtures, or scripts changed after the baseline.');
          }
        } catch (error) {
          issues.push('Cannot verify benchmark contract. ' + error.message);
        }
      }
    }
    for (const check of required) {
      const selected = check.phases ?? phases;
      if (!selected.includes('baseline') && !['feature', 'build'].includes(task.mode)) {
        issues.push('After-only checks require feature or build mode: ' + check.name);
      }
      for (const phase of selected) {
        const latest = (await checkResults(run, check.name, phase)).at(-1);
        if (!latest) {
          issues.push('Required ' + phase + ' check has not run: ' + check.name);
          continue;
        }
        if (!passing(latest)) issues.push('Required ' + phase + ' check failed: ' + check.name);
        issues.push(...await receiptIssues(run, latest, check, snapshot, contractHash));
      }
    }
    const review = (await records(taskDir, 'reviews')).at(-1);
    issues.push(...review ? reviewIssues(task, review, snapshot) : ['An agent-authored semantic review is unverified.']);
    if (task.execution?.workflow === 'audited') {
      const audits = await records(taskDir, 'audits');
      const index = audits.findLastIndex(row => row.stage === 'plan_review');
      const recent = index < 0 ? [] : audits.slice(index);
      const plan = recent[0];
      const build = recent.findLast(row => row.stage === 'build_review');
      const final = recent.at(-1);
      const automatic = plan?.verdict === 'skipped' && task.cosmetic_route &&
        [plan, build, final].every(row => row?.approved_plan_sha256 === task.cosmetic_route.approved_plan_sha256) &&
        await checksCosmeticSource(task, snapshot);
      const passed = (plan?.verdict === 'pass' || automatic) && build?.verdict === 'pass' && final?.stage === 'final_review' &&
        (skipsFinal(task) || automatic ? final.verdict === 'skipped' && canonical(build.criteria) === canonical(review?.criteria) : final.verdict === 'pass');
      const source = [build, final].every(row => row?.snapshot_sha256 === snapshot.snapshot_sha256 &&
        (!row.diff_sha256 || row.diff_sha256 === snapshot.diff_sha256));
      const pinned = [plan, build, final].every(row => digestPattern.test(row?.plan_sha256 ?? '') &&
        row.plan_sha256 === plan?.plan_sha256 && (!task.profile || row.profile_sha256 === task.profile_sha256) &&
        (!task.quality || row.quality_revision === task.quality.revision));
      if (!passed || !source || !pinned) issues.push('The reviewed plan, build audit, and final audit must pass for the current work.');
    }
    return [...new Set(issues)];
  }

  async function summary(run) {
    const {id, task, taskDir} = run;
    return {id, mode:task.mode, action:task.action, scope:task.scope, created_at:task.created_at,
      lifecycle:await lifecycle(run), initial_snapshot_sha256:task.initial_snapshot?.snapshot_sha256, artifact_directory:taskDir};
  }

  async function listRuns() {
    const home = await homeDirectory();
    const warnings = [];
    if (!home) return {active:null, ids:[], warnings, runs:[]};
    const active = await activeId(home).catch(error => {
      warnings.push(error.message);
      return null;
    });
    const ids = (await entries(home, 'tasks')).filter(row => row.isDirectory() && runPattern.test(row.name))
      .map(row => row.name).sort().reverse();
    if (active && !ids.includes(active)) warnings.push('The active task directory is missing.');
    const runs = [];
    for (const id of ids) {
      try { runs.push(await summary(await selected(id, home))); }
      catch (error) { warnings.push('Cannot read task ' + id + '. ' + error.message); }
    }
    return {active, ids, warnings, runs};
  }

  async function getRun(id) {
    if (id == null) {
      const index = await listRuns();
      id = index.active ?? index.ids[0];
    }
    const run = await selected(id);
    const {task, taskDir} = run;
    const issues = await integrityIssues(taskDir);
    const lifecycle = (await summary(run)).lifecycle;
    if (lifecycle.status === 'unverified') issues.push(lifecycle.reason);
    const checks = [];
    for (const entry of await entries(taskDir, 'results')) {
      if (!entry.isDirectory() || !checkPattern.test(entry.name)) continue;
      for (const phase of phases) {
        for (const receipt of await checkResults(run, entry.name, phase)) {
          for (const stream of ['stdout', 'stderr']) {
            const relative = receipt.evidence_path + '/' + stream + '.log';
            const place = await owned(taskDir, relative).catch(missing);
            if (!place) continue;
            const f = await fs.open(place.file, 'r');
            try {
              const {buffer, bytesRead} = await f.read(Buffer.alloc(4096), 0, 4096, 0);
              receipt[stream + '_path'] = task.id + '/' + relative;
              receipt[stream + '_preview'] = buffer.subarray(0, bytesRead).toString('utf8');
              receipt[stream + '_truncated'] = receipt[stream + '_truncated'] === true || place.info.size > bytesRead;
            } finally { await f.close(); }
          }
          checks.push(receipt);
        }
      }
    }
    const groups = await Promise.all(evidenceFolders.map(folder => records(taskDir, folder)));
    const evidence = Object.fromEntries(evidenceFolders.map((folder, index) =>
      [folder === 'lifecycle' ? 'lifecycle_history' : folder, groups[index]]));
    return {...await summary(run), task, checks, ...evidence, benchmark:await readJson(taskDir, 'benchmark/contract.json').catch(missing),
      ledger:{verdict:issues.length ? 'revise' : 'pass', issues}};
  }

  async function readRunRecord(id, relative) {
    const {taskDir} = await selected(id);
    assert(typeof relative === 'string' && /^(?:task\.json|execution_config\.json|events\.jsonl|benchmark\/contract\.json|snapshots\/[a-f0-9]{20,64}\.json|(?:answers|lifecycle|audits|reviews|reports|repair_rounds)\/[\w-]+\.json|results\/[\w-]+\/(?:baseline|after)\/[\w-]+\/(?:result\.json|stdout\.log|stderr\.log))$/.test(relative),
      'Choose a recorded Workbench artifact.');
    return relative.endsWith('.json') ? readJson(taskDir, relative) : read(taskDir, relative);
  }

  async function currentStatus(run) {
    const {task, taskDir} = run;
    const state = await lifecycle(run);
    const current = await sourceSnapshot(await resolvedRoot, task);
    current.diff_sha256 = changeFingerprint(task.initial_snapshot.files, current.files);
    const issues = state.status === 'unverified' ? [state.reason] : await completionIssues(run, current, state);
    return {task_id:task.id, mode:task.mode, action:task.action, scope:task.scope,
      snapshot_sha256:current.snapshot_sha256, diff_sha256:current.diff_sha256, verdict:state.status === 'unverified' ? 'unverified' : issues.length ? 'revise' : 'pass',
      issues, lifecycle:state, artifact_directory:taskDir,
      repair_rounds:(await records(taskDir, 'repair_rounds')).length, max_repair_rounds:task.execution?.max_repair_rounds ?? 3,
      ...(task.quality && {quality_revision:task.quality.revision})};
  }

  async function status(id) {
    return currentStatus(await selected(id));
  }

  async function verify(id, {record:save = true, complete = false} = {}) {
    if (!save && !complete) return status(id);
    return mutate(async home => {
      const run = await selected(id, home);
      const report = await currentStatus(run);
      const issues = await integrityIssues(run.taskDir);
      if (issues.length || report.lifecycle.status === 'unverified') return report;
      const artifacts = save ? [['reports/' + identifier() + '.json', json(report)]] : [];
      if (complete && report.verdict === 'pass' && report.lifecycle.status === 'active') {
        const state = await sourceSnapshot(await resolvedRoot, run.task);
        assert(state.snapshot_sha256 === report.snapshot_sha256, 'The checkout changed during verification.');
        const completed = {status:'completed', reason:'All recorded completion gates passed', cause:null, at:now(),
          snapshot_sha256:report.snapshot_sha256, diff_sha256:report.diff_sha256, head:state.head, branch:state.branch};
        artifacts.push(['lifecycle/' + identifier() + '.json', json(completed)], ...await snapshotArtifacts(run, state));
        await batch(run.taskDir, artifacts, home);
        return {...report, lifecycle:completed};
      }
      await batch(run.taskDir, artifacts, home);
      return report;
    });
  }

  async function changeLifecycle(id, operation, reason, verificationSource) {
    assert(filled(reason), 'Record the reason for this task action.');
    return mutate(async home => {
      const run = await selected(id, home);
      const state = await lifecycle(run);
      assert(state.status !== 'unverified', state.reason);
      const integrity = await integrityIssues(run.taskDir);
      assert(!integrity.length, integrity.join(' '));
      const rounds = (await records(run.taskDir, 'repair_rounds')).length;
      if (operation === 'pause' || operation === 'stop' || operation === 'limit') {
        assert(state.status === 'active', 'Only an active task accepts this action.');
      } else if (operation === 'retryVerification') {
        assert(state.status === 'active' || state.status === 'stopped' && state.cause === 'repair_limit',
          'Select a build stopped during verification.');
      } else if (operation === 'retryLimits') {
        assert(state.status === 'active', 'Only an active task can reset its retry allowances.');
      } else if (operation === 'resume') {
        assert(['paused', 'stopped'].includes(state.status), 'Only a paused or stopped task can resume.');
      } else {
        assert(['active', 'completed'].includes(state.status), 'Resume the task before recording a repair.');
      }
      if (['resume', 'repair', 'retryVerification'].includes(operation)) {
        assert(operation === 'retryVerification' || state.cause !== 'repair_limit', 'This task reached its repair limit.');
        const active = await activeId(home);
        if (active && active !== run.id) {
          const other = await lifecycle(await selected(active, home));
          assert(other.status !== 'unverified', other.reason);
          assert(other.status !== 'active', 'Another active task owns this workspace.');
        }
      }
      if (operation === 'repair' && state.status === 'active') await requireAgreement(run);
      const snapshot = await sourceSnapshot(await resolvedRoot, run.task);
      const common = {reason:reason.trim(), at:now(), snapshot_sha256:snapshot.snapshot_sha256};
      if (operation === 'retryVerification') {
        const expected = state.status === 'stopped' ? state.snapshot_sha256 : verificationSource;
        if (snapshot.snapshot_sha256 !== expected) {
          assert(digestPattern.test(expected ?? ''), 'The stopped build has no recorded source snapshot.');
          const prior = await readJson(run.taskDir, 'snapshots/' + expected.slice(0, 20) + '.json').catch(missing);
          const files = {...prior?.files};
          const recordedPreviewLog = Object.hasOwn(files, localPreviewLog);
          delete files[localPreviewLog];
          assert(recordedPreviewLog && fingerprint(prior.files) === expected && fingerprint(files) === snapshot.snapshot_sha256,
            'Restore the stopped build’s source before retrying verification.');
        }
        const pinned = await pinnedConfiguration(run);
        const current = await effectiveConfig();
        const additions = run.task.quality || current.quality_revision ? [] : current.checks.filter(check =>
          check.required && !check.benchmark && check.phases?.join(',') === 'after' &&
          !pinned.checks.some(row => row.name === check.name));
        await validateChecks({...pinned, checks: [...pinned.checks, ...additions]});
        common.verification_checks = additions;
      }
      if (operation === 'retryLimits' || operation === 'retryVerification') common.repair_rounds_base = rounds;
      const allowanceBase = operation === 'repair' ? (await records(run.taskDir, 'lifecycle'))
        .findLast(row => Number.isSafeInteger(row.repair_rounds_base))?.repair_rounds_base ?? 0 : 0;
      const reached = operation === 'limit' || operation === 'repair' &&
        rounds - allowanceBase >= (run.task.execution?.max_repair_rounds ?? 3);
      const artifacts = [];
      if (operation === 'repair' && !reached) artifacts.push(['repair_rounds/' + identifier() + '.json', json({...common, round:rounds + 1})]);
      let latest = state;
      if (operation !== 'repair' || reached || state.status === 'completed') {
        const status = reached || operation === 'stop' ? 'stopped' : operation === 'pause' ? 'paused' : 'active';
        latest = {...common, status, cause:reached ? 'repair_limit' : null};
        artifacts.push(['lifecycle/' + identifier() + '.json', json(latest)]);
      }
      const pointer = await activeId(home);
      const changesOwner = latest.status === 'active' && pointer !== run.id;
      const pointerPath = safePath(home, 'active_task');
      if (changesOwner) await atomicWrite(pointerPath, run.id);
      try { await batch(run.taskDir, artifacts, home); }
      catch (error) {
        if (changesOwner) {
          if (pointer) await atomicWrite(pointerPath, pointer);
          else await fs.unlink(pointerPath);
        }
        throw error;
      }
      if (operation === 'repair' && reached) throw new Error('The task stopped at its repair limit.');
      return {task_id:run.id, lifecycle:latest, repair_rounds:rounds + Number(operation === 'repair')};
    });
  }

  async function discover() {
    const root = await resolvedRoot;
    const names = Object.keys((await sourceSnapshot(root)).files);
    const available = new Set(names);
    const rails_roots = names.filter(name => /(?:^|\/)config\/application\.rb$/.test(name))
      .map(name => name.replace(/config\/application\.rb$/, '')).filter(prefix => available.has(prefix + 'bin/rails'))
      .map(prefix => prefix.slice(0, -1) || '.');
    const react_roots = [];
    const command_candidates = rails_roots.map(root => ({root, argv:['ruby', 'bin/rails', 'test'], executed:false}));
    for (const name of names.filter(name => path.posix.basename(name) === 'package.json')) {
      let manifest;
      try { manifest = await readJson(root, name); }
      catch { continue; }
      const location = path.posix.dirname(name);
      const scripts = manifest?.scripts ?? {};
      if (manifest?.dependencies?.react || manifest?.devDependencies?.react) react_roots.push({root:location, scripts});
      if (filled(scripts.test)) command_candidates.push({root:location, argv:['npm', 'test'], executed:false});
    }
    return {rails_roots, react_roots, command_candidates};
  }

  return {initialize:() => mutate(install), config, setConfig, effectiveConfig, getProfile, setProfile, profileApplied, discover, startTask, questions, answer,
    freeze, prompt, executionConfig, snapshot, cosmeticSource, runCheck, runChecks:runConfigured,
    preflightChecks, checkReceiptStatus,
    benchmark:(id, options) => runConfigured(id, {...options, benchmarks:true}), record, readRunRecord, getRun, listRuns,
    status, verify, repair:(id, reason) => changeLifecycle(id, 'repair', reason),
    pause:(id, reason) => changeLifecycle(id, 'pause', reason), stop:(id, reason) => changeLifecycle(id, 'stop', reason),
    stopAtLimit:(id, reason) => changeLifecycle(id, 'limit', reason),
    retryVerification:(id, source, reason = 'User requested verification only.') => changeLifecycle(id, 'retryVerification', reason, source),
    resetRetryLimits:id => changeLifecycle(id, 'retryLimits', 'User requested a retry with fresh allowances.'),
    resume:(id, reason = 'Explicit resume request') => changeLifecycle(id, 'resume', reason)};
}
