import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [{version}, {files}] = await Promise.all(['../package.json', 'installer.json'].map(
  async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'))
));

await packager({
  dir: root,
  name: 'Branch Review',
  platform: 'win32',
  arch: 'x64',
  out: path.resolve(root, '../desktop'),
  overwrite: true,
  asar: false,
  prune: true,
  ignore(file) {
    if (!file || file === '/node_modules') return false;
    if (file.startsWith('/node_modules/')) return file.startsWith('/node_modules/.');
    const relative = file.slice(1);
    return !files.some(pattern => pattern.startsWith(relative + '/') || path.posix.matchesGlob(relative, pattern));
  },
  executableName: 'Branch Review',
  icon: path.join(root, 'desktop/icon.ico'),
  appVersion: version,
  win32metadata: {
    ProductName: 'Branch Review',
    FileDescription: 'Local Git branch review workspace'
  }
});
