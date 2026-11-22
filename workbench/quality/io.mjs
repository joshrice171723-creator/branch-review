import {randomUUID} from 'node:crypto';
import {link, lstat, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseQualityJSON, stringifyQuality} from './schema.mjs';

async function qualityPath(root, name, {create = false, directory = false} = {}) {
  const parts = name.split('/');
  const filename = directory ? null : parts.pop();
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (create) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(current)).isDirectory()) throw Error('Invalid Quality record directory');
  }
  return filename ? path.join(current, filename) : current;
}

export async function readQuality(root, name) {
  try {
    const file = await qualityPath(root, name);
    if (!(await lstat(file)).isFile()) throw Error('Invalid Quality record file');
    return parseQualityJSON(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listQuality(root, name) {
  try { return await readdir(await qualityPath(root, name, {directory: true})); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeQuality(root, name, value, {exclusive = false} = {}) {
  const file = await qualityPath(root, name, {create: true});
  const temporary = path.join(path.dirname(file), '.quality-write-' + randomUUID());
  try {
    await writeFile(temporary, stringifyQuality(value), {flag: 'wx'});
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
  } finally {
    await rm(temporary, {force: true});
  }
}

export async function writeTrial(root, trialId, evidence, summary) {
  const home = '.harness/quality/trials';
  const staged = home + '/record-' + randomUUID();
  const stagedDirectory = await qualityPath(root, staged, {create: true, directory: true});
  try {
    await writeQuality(root, staged + '/evidence.json', evidence);
    await writeQuality(root, staged + '/summary.json', summary);
    await rename(stagedDirectory, path.join(root, home, trialId));
  } finally {
    await rm(stagedDirectory, {recursive: true, force: true});
  }
}
