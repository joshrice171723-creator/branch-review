import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';
import runtime from './stage-windows-runtimes.cjs';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const stage = await runtime.stageWindowsRuntimes();
try {
  await packager({ dir: '.', name: 'Branch Review', platform: 'win32', arch: 'x64', out: '../desktop', overwrite: true,
    asar: false, prune: true, extraResource: [stage.bundle],
    ignore: [/^\/\.(?:local|local-dev|git|harness|idea)(?:\/|$)/, /^\/(?:test|__pycache__)(?:\/|$)/],
    executableName: 'Branch Review', icon:'desktop/icon.ico', appVersion: version, win32metadata: { ProductName: 'Branch Review', FileDescription: 'Local Git branch review workspace' } });
} finally { await stage.cleanup(); }
