import {execFile} from 'node:child_process';
import {lstat, mkdir, open, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
const ignored = new Set(['.git', '.harness', 'node_modules', 'vendor', 'venv', '.venv', 'dist', 'coverage']);

export function stableId(value, size = 20) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, size);
}

export function relativePath(value, {directory = false} = {}) {
  if (directory && value === '.') return value;
  if (typeof value !== 'string' || !value || value.length > 1000 ||
      /[\\:\u0000-\u001f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('Enter a path relative to this project.');
  }
  return value;
}

export async function plainPath(root, relative, {directory = false, create = false} = {}) {
  const name = relativePath(relative, {directory});
  if (name === '.') return root;
  const parts = name.split('/');
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    if (create) await mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(target, {bigint: true});
    const isDirectory = directory || index < parts.length - 1;
    if ((isDirectory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() ||
        path.relative(target, await realpath(target))) {
      throw Error('Use a project path without links.');
    }
  }
  return target;
}

export async function boundedText(root, relative, maxBytes) {
  const file = await plainPath(root, relative);
  const before = await lstat(file, {bigint: true});
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat({bigint: true});
    if (!info.isFile() || before.dev !== info.dev || before.ino !== info.ino || info.size > BigInt(maxBytes)) {
      throw Error('The project file is unreadable or too large.');
    }
    const buffer = Buffer.alloc(Number(info.size));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    const text = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, bytesRead));
    if (text.includes('\0')) throw Error('Choose a text file.');
    return text;
  } finally {
    await handle.close();
  }
}

export async function gitRead(root, ...args) {
  const env = {...process.env, GIT_OPTIONAL_LOCKS: '0'};
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  return (await execute('git', ['-C', root, ...args], {
    windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    env
  })).stdout;
}

export async function trackedFiles(root) {
  const raw = await gitRead(root, 'ls-files', '--stage', '-z');
  return [...new Set(raw.split('\0').flatMap(row => {
    const match = /^100(?:644|755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(row);
    if (!match || match[1].split('/').some(part => ignored.has(part))) return [];
    try { return [relativePath(match[1])]; }
    catch { return []; }
  }))].sort();
}

export async function atomicJson(root, name, value) {
  const draft = path.join(root, randomUUID() + '.tmp');
  await writeFile(draft, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  try { await rename(draft, path.join(root, relativePath(name))); }
  finally { await unlink(draft).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
