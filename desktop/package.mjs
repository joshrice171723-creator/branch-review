import { packager } from '@electron/packager';
await packager({ dir: '.', name: 'Branch Review', platform: 'win32', arch: 'x64', out: '../desktop', overwrite: true,
  asar: false, prune: true, ignore: [/^\/\.local(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/test(?:\/|$)/],
  executableName: 'Branch Review', appVersion: '0.2.0', win32metadata: { ProductName: 'Branch Review', FileDescription: 'Local Git branch review workspace' } });
