import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {execFile, spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
assert.ok(process.versions.electron, 'Run using the installed Electron executable.');
assert.ok(process.argv[2] && path.isAbsolute(process.argv[3] || ''), 'Supply the packaged app directory and absolute Git executable.');
const root = path.resolve(process.argv[2]);
const git = process.argv[3];
for (const file of ['server.mjs', 'workbench/renderer.mjs', 'public/index.html', 'desktop/main.cjs', 'desktop/preload.cjs',
  'desktop/repository.cjs', 'desktop/setup-help.cjs', 'desktop/browser-qa.cjs', 'desktop/icon.ico']) {
  await access(path.join(root, file));
}
for (const file of ['.local', '.git', '.harness', 'test', '.env', '__pycache__', 'workbench-install.py', 'workbench-release']) {
  await assert.rejects(access(path.join(root, file)), {code:'ENOENT'}, file + ' leaked into the package.');
}
await assert.rejects(access(path.join(path.dirname(root), 'runtime')), {code:'ENOENT'});
assert.deepEqual((await readdir(path.join(root, 'node_modules'))).filter(name => !name.startsWith('.')), ['axe-core']);

const temporary = await realpath(os.tmpdir());
const fixture = await mkdtemp(path.join(temporary, 'installed-review-'));
let child, closed, timer;
try {
  const home = path.join(fixture, 'workspace');
  const project = path.join(fixture, 'project');
  const remote = path.join(fixture, 'origin.git');
  const profile = path.join(fixture, 'profile');
  await Promise.all([mkdir(home), mkdir(project), mkdir(profile)]);
  const env = {...process.env, HOME:profile, USERPROFILE:profile, LOCALAPPDATA:profile,
    BRANCH_REVIEW_HOME:home, BRANCH_REVIEW_DESKTOP_REPOSITORY:project, ELECTRON_RUN_AS_NODE:'1',
    GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(profile, 'gitconfig')};
  for (const name of ['BRANCH_REVIEW_PORT', 'APEX_WORKBENCH_URL', 'HARNESS_PYTHON', 'HARNESS_RUBY', 'HARNESS_NODE',
    'BRANCH_REVIEW_CODEX', 'BRANCH_REVIEW_CLAUDE', 'BRANCH_REVIEW_MUSE', 'META_CLINIC_REPO']) delete env[name];
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  if (process.platform === 'win32') {
    const systemPath = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
    env[pathKey] = [path.dirname(git), systemPath].join(path.delimiter);
  } else {
    await symlink(git, path.join(profile, 'git'));
    env[pathKey] = profile;
  }
  const options = {cwd:project, env, windowsHide:true, timeout:20000};
  for (const executable of ['node', 'python', 'ruby']) {
    await assert.rejects(run(executable, ['--version'], options), {code:'ENOENT'});
  }
  await run(git, ['init', '-b', 'main'], options);
  await writeFile(path.join(project, 'index.html'), '<!doctype html><title>Branch Review smoke project</title>');
  await run(git, ['add', 'index.html'], options);
  await run(git, ['-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'Initial fixture'], options);
  await run(git, ['init', '--bare', '-b', 'main', remote], options);
  await run(git, ['remote', 'add', 'origin', remote], options);
  await run(git, ['push', '-u', 'origin', 'main'], options);
  const entry = pathToFileURL(path.join(root, 'server.mjs')).href;
  const command = 'const {startServer}=await import(process.argv[1]); await startServer({allowPortFallback:true});';
  child = spawn(process.execPath, ['--input-type=module', '--eval', command, entry], {
    cwd:project, env, windowsHide:true, stdio:['ignore', 'pipe', 'pipe']
  });
  closed = new Promise(resolve => child.once('close', resolve));
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-10000); });
  const lines = createInterface({input:child.stdout});
  const origin = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => reject(Error(`Controller exited ${code}. ${errors}`)));
    timer = setTimeout(() => reject(Error('Controller did not start. ' + errors)), 30000);
    lines.on('line', line => {
      const match = /^Branch Review: (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (match) resolve(match[1]);
    });
  });
  clearTimeout(timer);
  const page = await fetch(origin + '/', {signal:AbortSignal.timeout(15000)});
  assert.ok(page.ok, 'The packaged desktop page failed to load.');
  assert.match(await page.text(), /<title>Branch Review<\/title>/);
  const renderer = await fetch(origin + '/workspace.js', {signal:AbortSignal.timeout(15000)});
  assert.ok(renderer.ok, 'The packaged workspace renderer failed to load.');
  assert.match(await renderer.text(), /export async function mount\(/);

  async function get(route) {
    const result = await fetch(origin + route, {signal:AbortSignal.timeout(15000)});
    assert.ok(result.ok, route + ' returned ' + result.status);
    return result.json();
  }
  const {token} = await get('/api/state');
  async function post(route, body) {
    const result = await fetch(origin + route, {method:'POST', signal:AbortSignal.timeout(15000),
      headers:{Origin:origin, 'X-Review-Token':token, 'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const data = await result.json();
    assert.ok(result.ok, route + ' returned ' + result.status + ' ' + JSON.stringify(data));
    return data;
  }
  assert.equal((await get('/api/workbench')).engine, 'native');
  await post('/api/workbench-prepare', {});
  const bootstrap = await get('/api/workspace/bootstrap');
  assert.equal(bootstrap.project.path, project);
  assert.equal(bootstrap.installed, true);
  const rpc = await post('/api/workspace/mcp', {jsonrpc:'2.0', id:1, method:'initialize',
    params:{protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'installed-smoke', version:'1'}}});
  assert.equal(rpc.id, 1);
  assert.ok(rpc.result?.protocolVersion);
  console.log('Installed Electron started the native workspace and MCP using Git on a restricted PATH.');
} finally {
  clearTimeout(timer);
  if (child) {
    child.kill();
    await closed;
  }
  if (path.dirname(fixture) === temporary && await realpath(fixture) === fixture) {
    await rm(fixture, {recursive:true, force:true, maxRetries:3});
  }
}
