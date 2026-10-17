import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await packager({ dir: '.', name: 'Branch Review', platform: 'win32', arch: 'x64', out: '../desktop', overwrite: true,
  asar: false, prune: true, ignore: [/^\/\.local(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/test(?:\/|$)/],
  executableName: 'Branch Review', icon:'desktop/icon.ico', appVersion: version, win32metadata: { ProductName: 'Branch Review', FileDescription: 'Local Git branch review workspace' } });
