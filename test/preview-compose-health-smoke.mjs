import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PreviewProcess} from '../workbench/environment/preview.mjs';

const execute = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'branch-review-compose-health-'));
const name = 'br-health-' + Date.now();
const file = path.join(root, 'compose.json');
const preview = new PreviewProcess(root, root, async () => root);
try {
  await writeFile(file, JSON.stringify({services: {
    setup: {image: 'redis:7-alpine', command: ['sh', '-c', 'exit 7']},
    waiting: {image: 'redis:7-alpine', command: ['sh', '-c', 'sleep 300']}
  }}));
  await preview.setup({mode: 'web', url: 'http://127.0.0.1:{port}',
    argv: ['docker', 'compose', '--project-name', name, '--file', file, 'up']});
  await preview.start();
  let status;
  for (let attempt = 0; attempt < 30; attempt++) {
    status = await preview.status();
    if (status.state === 'exited') break;
    await delay(500);
  }
  assert.equal(status.state, 'exited');
  assert.equal(status.owned, true, 'Compose still has its waiting service alive.');
  assert.match(status.message, /setup exited with code 7/);
  console.log('PASS: a failed Compose setup service reaches preview health while its parent and another service stay alive.');
} finally {
  await preview.close();
  await execute('docker', ['compose', '--project-name', name, '--file', file, 'down'], {windowsHide: true});
  await rm(root, {recursive: true, force: true, maxRetries: 3});
}
