import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {PreviewProcess} from '../workbench/environment/preview.mjs';
import {WebPreviews} from '../web-project.mjs';
import {previewComposeName, validateRecipe} from '../project-settings.mjs';

const execute = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'branch-review-isolated-compose-'));
const file = path.join(root, 'compose.json');
const run = async (program, args, options = {}) => {
  const result = await execute(program, args, {windowsHide:true, ...options});
  return result.stdout.trim();
};
const namespace = slot => previewComposeName(root, slot);
const recipe = validateRecipe({start:['docker','compose','--project-name','shared-fixture','--file',file,'up']});
const reviews = new WebPreviews({local:root, run, progress:() => {}});
const live = new PreviewProcess(root, root, async () => root);
try {
  await writeFile(file, JSON.stringify({services:{web:{
    image:'redis:7-alpine',
    command:['sh','-c',`while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok' | nc -l -p 8080; done`],
    ports:['127.0.0.1:${PORT}:8080']
  }}}));
  await live.setup({mode:'web', cwd:'.', argv:recipe.start, url:'http://127.0.0.1:{port}'});
  const [original, changed] = await Promise.all([
    reviews.custom('original', 'a'.repeat(40), root, recipe),
    reviews.custom('changed', 'b'.repeat(40), root, recipe),
    live.start()
  ]);
  let workspace;
  for (let attempt = 0; attempt < 120; attempt++) {
    workspace = await live.status();
    if (workspace.state === 'running') {
      try { if ((await fetch(workspace.url)).ok) break; } catch {}
    }
    await delay(500);
  }
  assert.equal(workspace.state, 'running');
  assert.equal(new Set([workspace.url, original.web, changed.web]).size, 3);
  for (const slot of ['workspace','original','changed']) {
    assert.equal(await run('docker',['inspect',namespace(slot)+'-web-1','--format','{{.State.Running}}']), 'true');
  }
  await reviews.stop('original');
  assert.equal(await run('docker',['inspect',namespace('original')+'-web-1','--format','{{.State.Running}}']), 'false');
  assert.equal((await fetch('http://127.0.0.1:' + changed.web)).status, 200);
  assert.equal((await fetch(workspace.url)).status, 200);
  await live.stop();
  assert.equal((await fetch('http://127.0.0.1:' + changed.web)).status, 200);
  console.log('PASS: workspace, Original and Changed use separate Compose stacks and stop independently.');
} finally {
  await reviews.stop('original').catch(() => {});
  await reviews.stop('changed').catch(() => {});
  await live.close().catch(() => {});
  for (const slot of ['workspace','original','changed']) {
    await run('docker',['compose','--project-name',namespace(slot),'--file',file,'down']).catch(() => {});
  }
  await rm(root,{recursive:true,force:true,maxRetries:3});
}
