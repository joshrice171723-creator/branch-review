import {randomUUID} from 'node:crypto';
import {appendFile, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export const id = () => randomUUID().replaceAll('-', '');
export const now = () => new Date().toISOString();
export const runPattern = /^\d{8}T\d{12}-[a-f0-9]{8}$/;
export const assetPattern = /^[a-f0-9]{32}$/;
export const sentence = (value, label, max = 64000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Enter ' + label + '.');
  return value;
};

export async function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      await delay(25 * (attempt + 1) ** 2);
    }
  }
}

export function ownedFiles(root) {
  async function owned(relative, create = false) {
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
      throw Error('Invalid Workbench path.');
    }
    let file = root;
    for (const [index, part] of parts.entries()) {
      file = path.join(file, part);
      const entry = await lstat(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!entry && create && index < parts.length - 1) {
        await mkdir(file).catch(error => { if (error.code !== 'EEXIST') throw error; });
        if (await realpath(file) !== file) throw Error('Invalid Workbench directory.');
      } else if (entry && (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory()))) {
        throw Error('Invalid Workbench path.');
      }
    }
    return file;
  }

  return {
    path: owned,
    async bytes(relative, max, fallback) {
      const file = await owned(relative);
      const entry = await lstat(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!entry) {
        if (fallback !== undefined) return fallback;
        throw Object.assign(Error('This Workbench record is missing.'), {code: 'ENOENT'});
      }
      if (!entry.isFile() || entry.size > max) throw Error('Invalid Workbench record size.');
      return readFile(file);
    },
    async read(relative, fallback = null) {
      const bytes = await this.bytes(relative, 64_000_000, null);
      return bytes ? JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) : fallback;
    },
    async write(relative, value) {
      const file = await owned(relative, true);
      const temp = path.join(path.dirname(file), id() + '.tmp');
      try {
        await writeFile(temp, Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2), {flag: 'wx'});
        await replaceFile(temp, file);
      } finally {
        await rm(temp, {force: true});
      }
    },
    async append(relative, value) {
      const file = await owned(relative, true);
      await appendFile(file, JSON.stringify(value) + '\n');
    },
    async acquire(relative) {
      const file = await owned(relative, true);
      const temp = file + '.' + id();
      try {
        await writeFile(temp, process.pid + '\n', {flag: 'wx'});
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await link(temp, file);
            return () => rm(file, {force: true});
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
          const reclaim = file + '.reclaim';
          try { await link(temp, reclaim); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            break;
          }
          try {
            const owner = Number(await readFile(file, 'utf8').catch(error => {
              if (error.code !== 'ENOENT') throw error;
              return '';
            }));
            if (!owner) continue;
            if (!Number.isSafeInteger(owner) || owner < 0) break;
            try {
              process.kill(owner, 0);
              break;
            } catch (error) {
              if (error.code !== 'ESRCH') break;
              await rm(file, {force: true});
            }
          } finally {
            await rm(reclaim, {force: true});
          }
        }
      } finally {
        await rm(temp, {force: true});
      }
      throw Error('This checkout already has an active Workbench operation.');
    }
  };
}

