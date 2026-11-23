import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {copyFile, cp, lstat, mkdir, mkdtemp, open, readlink, realpath, rm, stat, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {isDeepStrictEqual, promisify} from 'node:util';
import {resolveCheckCommand} from '../check-command.mjs';
import {label, lockedDefinition, number, relative} from './schema.mjs';

const exec = promisify(execFile);
const captures = new Set();
const MAX_OUTPUT = 256 * 1024;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export const sourceGuard = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const canonical = text => text.replace(/\\s+/g, ' ').trim();",
  "for (const argument of process.argv.slice(1)) {",
  "  const [file, token] = JSON.parse(argument);",
  "  try {",
  "    const target = fs.realpathSync(file);",
  "    const local = path.relative(fs.realpathSync('.'), target);",
  "    if (local === '..' || local.startsWith('..' + path.sep) || path.isAbsolute(local)) throw Error();",
  "    if (canonical(fs.readFileSync(target, 'utf8')).includes(canonical(token))) continue;",
  "  } catch {}",
  "  console.error('Expected route source evidence in ' + file + ': ' + token);",
  "  process.exit(1);",
  "}",
  "console.log('Route source evidence present');"
].join('\n');

const legacyGuard = [
  'import json,re,sys',
  'from pathlib import Path',
  'def canonical(text):',
  " return re.sub(r'\\s+', ' ', text).strip()",
  'for argument in sys.argv[1:]:',
  ' path,token=json.loads(argument)',
  ' target=Path(path)',
  " if not target.is_file() or canonical(token) not in canonical(target.read_text(encoding='utf-8')):",
  "  sys.exit('Expected route source evidence in '+path+': '+token)",
  "print('Route source evidence present')"
].join('\n');
const legacyGuardCode = 'exec(' + JSON.stringify(legacyGuard) + ')';

export function checkArgv(argv) {
  return argv[0] === 'python' && argv[1] === '-c' && argv[2] === legacyGuardCode ?
    ['node', '-e', sourceGuard, ...argv.slice(3)] : argv;
}

export async function gitOutput(repository, ...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {};
  try {
    const {stdout} = await exec('git', args, {cwd: repository, windowsHide: true, timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024, ...options});
    return stdout;
  } catch (error) {
    throw Error(error.stderr?.trim() || error.message);
  }
}

export function contains(root, candidate) {
  const remainder = path.relative(root, candidate);
  return !path.isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + path.sep);
}

export async function inside(root, name) {
  const target = await realpath(path.resolve(root, name));
  if (!contains(root, target)) throw Error('Path escapes the trial checkout: ' + name);
  return target;
}

async function fileHash(file) {
  if (!(await stat(file)).isFile()) throw Error('Expected a fixture or script file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function killTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 5_000})
      .catch(() => { if (child.exitCode === null && !child.signalCode) child.kill(); });
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  return Promise.resolve();
}

export async function capture(argv, {
  cwd, env = process.env, signal, timeout = 120, limit = MAX_OUTPUT, stopOnLimit = false, encoding = 'utf8', command
}) {
  signal?.throwIfAborted();
  command ??= await resolveCheckCommand(argv, cwd, env);
  signal?.throwIfAborted();
  let error, stopping, timed_out;
  const streams = Object.fromEntries(['stdout', 'stderr'].map(key => [key, {chunks: [], bytes: 0, truncated: false}]));
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  if (command.nodeMode) childEnv.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(command.file, command.args, {
    cwd, env: childEnv, windowsHide: true, shell: false,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  captures.add(child);
  const stop = (message, timeoutExpired = false) => {
    if (!error) {
      error = message;
      timed_out = timeoutExpired;
    }
    stopping ??= killTree(child).finally(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    });
  };
  const abort = () => stop('Command canceled');
  return new Promise(resolve => {
    const timer = timeout == null ? null : setTimeout(() => {
      stop('Command timed out after ' + timeout + (timeout === 1 ? ' second.' : ' seconds.'), true);
    }, 1000 * timeout);
    signal?.addEventListener('abort', abort, {once: true});
    for (const [name, stream] of Object.entries(streams)) child[name].on('data', chunk => {
      const remaining = limit - stream.bytes;
      const accepted = chunk.subarray(0, remaining);
      if (accepted.length) stream.chunks.push(accepted);
      stream.bytes += accepted.length;
      if (chunk.length > accepted.length) {
        stream.truncated = true;
        if (stopOnLimit) stop('Command exceeded the output limit');
      }
    });
    child.once('error', failure => { error ??= failure.message; });
    if (process.platform !== 'win32') child.once('exit', () => { void killTree(child); });
    child.once('close', async (exit_code, processSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await stopping;
      captures.delete(child);
      if (processSignal) error ??= 'Command ended with ' + processSignal;
      resolve({
        exit_code: error ? null : exit_code,
        status: error ? 'error' : exit_code === 0 ? 'passed' : 'failed',
        ...(error && {error}),
        ...(timed_out && {timed_out:true}),
        ...Object.fromEntries(Object.entries(streams).flatMap(([name, stream]) => {
          const output = Buffer.concat(stream.chunks);
          return [[name, encoding ? output.toString(encoding) : output], [name + '_truncated', stream.truncated]];
        }))
      });
    });
    if (signal?.aborted) abort();
  });
}

export async function stopQualityProcesses() {
  await Promise.all(Array.from(captures, killTree));
}

async function runCommand(root, spec, signal) {
  const started = performance.now();
  const result = {argv: spec.argv, cwd: spec.cwd};
  try {
    for (const name of spec.input_paths ?? []) {
      if (!(await stat(await inside(root, name))).isFile()) throw Error('Expected a check input file: ' + name);
    }
    Object.assign(result, await capture(checkArgv(spec.argv), {cwd: await inside(root, spec.cwd), signal, timeout: null}));
  } catch (error) {
    Object.assign(result, {status: 'error', exit_code: null, error: error.message,
      stdout: '', stdout_truncated: false, stderr: '', stderr_truncated: false});
  }
  result.duration_seconds = Math.round((performance.now() - started) * 1000) / 1e6;
  return result;
}

async function pathEvidence(root, entry) {
  return {...entry, sha256: await fileHash(await inside(root, entry.path))};
}

function aggregate(values, method) {
  if (method === 'mean') return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (method === 'min') return Math.min(...values);
  if (method === 'max') return Math.max(...values);
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measure(root, spec, check, signal) {
  const output = {id: spec.id, check_id: check.id, status: 'error',
    fixtures: [], scripts: [], samples: [], metrics: [], thresholds: []};
  try {
    output.fixtures = await Promise.all(spec.fixtures.map(item => pathEvidence(root, item)));
    output.scripts = await Promise.all(spec.scripts.map(path => pathEvidence(root, {path})));
    for (let index = 0; index < spec.repetitions; index++) {
      const reset = await runCommand(root, spec.reset, signal);
      const sample = {reset};
      output.samples.push(sample);
      if (reset.status !== 'passed') throw Error('Benchmark reset failed');
      const command = sample.command = await runCommand(root, check, signal);
      if (command.status === 'error') throw Error(command.error || 'Benchmark command failed to run');
      if (command.status === 'failed') {
        return {...output, status: 'failed', error: 'Benchmark command returned a nonzero exit code'};
      }
      if (command.stdout_truncated) throw Error('Benchmark stdout exceeded the evidence limit');
      const line = command.stdout.split(/\r?\n/).findLast(text => text.trim());
      const metrics = line ? JSON.parse(line)?.metrics : null;
      if (!metrics || Array.isArray(metrics) || typeof metrics !== 'object' ||
          Object.keys(metrics).length !== spec.metrics.length || spec.metrics.some(({id}) => !Object.hasOwn(metrics, id))) {
        throw Error('Benchmark must return one numeric value per declared metric');
      }
      sample.metrics = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, number(value, key)]));
    }
    output.metrics = spec.metrics.map(metric => {
      const samples = output.samples.map(sample => sample.metrics[metric.id]);
      return {...metric, value: aggregate(samples, metric.aggregate), samples};
    });
    const values = new Map(output.metrics.map(metric => [metric.id, metric.value]));
    output.thresholds = spec.thresholds.map(threshold => {
      const actual = values.get(threshold.metric);
      const {op, value} = threshold;
      const passed = op === 'lte' ? actual <= value : op === 'gte' ? actual >= value : actual === value;
      return {...threshold, actual, passed};
    });
    output.status = output.thresholds.every(row => row.passed) ? 'passed' : 'failed';
  } catch (error) {
    output.error = error.message;
  }
  return output;
}

function archivePath(root, name) {
  if (!name || name.includes('\\') || name.startsWith('/') ||
      name.split('/').some(part => part === '..' || part.toLowerCase() === '.git' || part.includes(':'))) {
    throw Error('Invalid path in the committed export');
  }
  const target = path.resolve(root, name);
  if (target === root || !contains(root, target)) throw Error('Invalid path in the committed export');
  return target;
}

function safeLink(root, filename, target) {
  if (!target || path.isAbsolute(target) || path.win32.isAbsolute(target) ||
      target.includes(':') || !contains(root, path.resolve(path.dirname(filename), target))) {
    throw Error('Symlink escapes the disposable checkout: ' + path.relative(root, filename));
  }
}

async function restoreLinks(root, links) {
  for (const [file, target] of links) {
    safeLink(root, file, target);
    const directory = (await stat(path.resolve(path.dirname(file), target)).catch(() => null))?.isDirectory();
    await symlink(target, file, directory ? 'dir' : 'file');
  }
  for (const [file] of links) {
    const resolved = await realpath(file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (resolved && !contains(root, resolved)) throw Error('Symlink escapes the disposable checkout');
  }
}

function paxFields(buffer) {
  const fields = {};
  for (let index = 0; index < buffer.length;) {
    const separator = buffer.indexOf(32, index);
    if (separator < 0) throw Error('Invalid extended Git archive header');
    const length = Number(buffer.subarray(index, separator).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= separator - index + 2 || index + length > buffer.length) {
      throw Error('Invalid extended Git archive header');
    }
    const record = buffer.subarray(separator + 1, index + length - 1).toString('utf8');
    const equal = record.indexOf('=');
    if (equal < 1) throw Error('Invalid extended Git archive header');
    if (['path', 'linkpath', 'size'].includes(record.slice(0, equal))) fields[record.slice(0, equal)] = record.slice(equal + 1);
    index += length;
  }
  return fields;
}

async function exportCommit(repository, commit, folder, signal) {
  const archive = path.join(path.dirname(folder), path.basename(folder) + '.tar');
  await gitOutput(repository, 'archive', '--format=tar', '-o', archive, commit, {signal});
  const handle = await open(archive);
  const links = [];
  try {
    await mkdir(folder);
    const {size: archiveSize} = await handle.stat();
    const header = Buffer.alloc(512);
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    let extended = {};
    for (let offset = 0; offset + 512 <= archiveSize;) {
      signal?.throwIfAborted();
      if ((await handle.read(header, 0, 512, offset)).bytesRead !== 512) throw Error('Incomplete Git archive header');
      if (header.every(byte => byte === 0)) break;
      const type = field(156, 157) || '0';
      const start = offset + 512;
      const storedSize = parseInt(field(124, 136).trim(), 8);
      const size = Number(type === 'x' || type === 'g' ? storedSize : extended.size ?? storedSize);
      if (!Number.isSafeInteger(size) || size < 0 || start + size > archiveSize) throw Error('Invalid entry in the Git archive');
      offset = start + Math.ceil(size / 512) * 512;
      if (type === 'g') continue;
      if (type === 'x') {
        if (size > 64 * 1024) throw Error('Extended Git archive header is too large');
        const buffer = Buffer.alloc(size);
        if ((await handle.read(buffer, 0, size, start)).bytesRead !== size) throw Error('Incomplete Git archive header');
        extended = paxFields(buffer);
        continue;
      }
      const target = archivePath(folder, extended.path || [field(345, 500), field(0, 100)].filter(Boolean).join('/'));
      await mkdir(type === '5' ? target : path.dirname(target), {recursive: true});
      if (type === '2') links.push([target, extended.linkpath || field(157, 257)]);
      else if (type === '0') {
        const output = createWriteStream(target, {flags: 'wx', mode: parseInt(field(100, 108).trim(), 8) & 0o777});
        await pipeline(size ? createReadStream(archive, {start, end: start + size - 1}) : [], output, {signal});
      } else if (type !== '5') throw Error('Unsupported entry in the Git archive');
      extended = {};
    }
    await restoreLinks(folder, links);
  } finally {
    await handle.close();
    await rm(archive, {force: true});
  }
}

async function disposable(prefix, run, parent = os.tmpdir()) {
  const folder = await realpath(await mkdtemp(path.join(parent, prefix)));
  try { return await run(folder); }
  finally { await rm(folder, {recursive: true, force: true, maxRetries: 3}); }
}

async function trialRef(repository, ref, definition, destination, signal) {
  const output = {...ref, checks: [], benchmarks: [], status: 'error'};
  try {
    await exportCommit(repository, ref.sha, destination, signal);
    const measured = new Set(definition.benchmarks.map(item => item.check_id));
    const checkout = run => definition.checks.length < 2 ? run(destination) :
      disposable('command-', async folder => {
        const target = path.join(folder, 'project');
        await cp(destination, target, {recursive: true, verbatimSymlinks: true});
        return run(target);
      }, path.dirname(destination));
    for (const check of definition.checks) {
      if (measured.has(check.id)) continue;
      const result = await checkout(root => runCommand(root, check, signal));
      output.checks.push({...result, id: check.id, required: check.required});
    }
    for (const spec of definition.benchmarks) {
      const check = definition.checks.find(item => item.id === spec.check_id);
      output.benchmarks.push(await checkout(root => measure(root, spec, check, signal)));
    }
    if (![...output.checks, ...output.benchmarks].some(item => item.status === 'error')) {
      const gated = [...output.checks.filter(item => item.required), ...output.benchmarks];
      output.status = gated.every(item => item.status === 'passed') ? 'passed' : 'failed';
    }
  } catch (error) {
    output.error = error.message;
  }
  return output;
}

export async function resolveRefs(repository, refs) {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 2) throw Error('Supply one or two committed Git refs');
  const resolved = await Promise.all(refs.map(async ref => {
    label(ref, 'Git ref', 200);
    const commit = (await gitOutput(repository, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}')).trim();
    if (!sha.test(commit)) throw Error('Select a committed Git ref');
    return {ref, sha: commit};
  }));
  if (resolved.length === 2 && resolved[0].sha === resolved[1].sha) throw Error('Select two different Git commits');
  return resolved;
}

export async function trialResults(repository, refs, definition, signal) {
  return disposable('workbench-quality-', async folder => {
    const results = [];
    for (const [index, ref] of refs.entries()) {
      results.push(await trialRef(repository, ref, definition, path.join(folder, 'ref-' + index), signal));
    }
    if (results.some(ref => ref.status === 'error')) return {refs: results, status: 'error'};
    if (results.length === 2 && results[0].benchmarks.some((before, index) => {
      const after = results[1].benchmarks[index];
      return !isDeepStrictEqual(before.fixtures, after.fixtures) || !isDeepStrictEqual(before.scripts, after.scripts);
    })) return {refs: results, status: 'error', error: 'Benchmark fixtures or declared scripts differ between refs'};
    return {refs: results, status: results.some(ref => ref.status === 'failed') ? 'failed' : 'passed'};
  });
}

export async function snapshotCheck(repository, {policy, check, files, signal}) {
  const {definition} = lockedDefinition(policy);
  const checkSpec = definition.checks.find(item => item.id === check);
  if (!checkSpec) throw Error('Choose a check from the pinned Quality policy');
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw Error('Choose a recorded source snapshot');
  const spec = definition.benchmarks.find(item => item.check_id === check);
  return disposable('workbench-quality-check-', async folder => {
    const links = [];
    for (const [name, expected] of Object.entries(files)) {
      signal?.throwIfAborted();
      if (name === '.git') {
        if (await fileHash(await inside(repository, name)) !== expected) {
          throw Error('Source changed before the Quality check: ' + name);
        }
        continue;
      }
      const filename = relative(name, 'snapshot path');
      const source = path.join(repository, filename);
      const resolved = await inside(repository, filename);
      const target = path.join(folder, filename);
      await mkdir(path.dirname(target), {recursive: true});
      let actual;
      if ((await lstat(source)).isSymbolicLink()) {
        const link = await readlink(source, {encoding: 'buffer'});
        const text = link.toString('utf8');
        links.push([target, text]);
        actual = createHash('sha256').update('symlink:').update(link).digest('hex');
      } else {
        await copyFile(resolved, target);
        actual = await fileHash(target);
      }
      if (actual !== expected) throw Error('Source changed before the Quality check: ' + name);
    }
    await restoreLinks(folder, links);
    return spec ? measure(folder, spec, checkSpec, signal) : runCommand(folder, checkSpec, signal);
  });
}
