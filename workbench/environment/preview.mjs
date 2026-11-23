import {spawn, spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {access, lstat} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {projectCommand} from '../../web-project.mjs';
import {executable as agentExecutable} from '../../providers.mjs';
import {expandRecipe, readRecipe, validateRecipe} from '../../project-settings.mjs';
import {atomicJson, boundedText, gitRead, plainPath, relativePath, stableId} from './paths.mjs';
import {literalArguments} from './discovery.mjs';

const localHosts = ['127.0.0.1', 'localhost', '[::1]'];
const portRequest = '{port}';

export function previewAddress(raw, {local = false, template = false} = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 1500 || /[\s\u0000-\u001f\u007f\\]/.test(raw)) {
    throw Error('Enter a valid preview address.');
  }
  const substitute = template ? raw.replaceAll(portRequest, '49152') : raw;
  let address;
  try { address = new URL(substitute); }
  catch { throw Error('Enter a valid preview address.'); }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw Error('Enter an HTTP or HTTPS preview address without credentials.');
  }
  if (local && (address.protocol !== 'http:' || !localHosts.includes(address.hostname) ||
      !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:[/?#]|$)/.test(substitute))) {
    throw Error('Enter a local HTTP preview address with its port.');
  }
  return raw;
}

async function portFor(url) {
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:[/?#]|$)/.exec(url);
  if (match) return Number(match[1]);
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function listening(url) {
  if (!url) return false;
  const address = new URL(url);
  const host = address.hostname.replace(/^\[|\]$/g, '');
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  return (await Promise.all(hosts.map(host => new Promise(resolve => {
    const socket = net.connect({host, port: Number(address.port || '80')});
    const end = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(250, () => end(false));
    socket.once('error', () => end(false));
    socket.once('connect', () => end(true));
  })))).includes(true);
}

async function executableOnPath(name, env) {
  const suffixes = process.platform === 'win32' && !path.extname(name) ? ['.exe', '.com', ''] : [''];
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const file = path.resolve(directory, name + suffix);
      if (await access(file, constants.X_OK).then(() => true, () => false) &&
          await lstat(file).then(info => info.isFile() || info.isSymbolicLink(), () => false)) return file;
    }
  }
  return null;
}

export async function resolveProjectCommand(argv, {cwd, env = process.env, desktop = false}) {
  const [program, ...args] = literalArguments(argv);
  if (program === 'electron') {
    const executable = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' :
      process.platform === 'win32' ? 'electron.exe' : 'electron';
    const local = path.join(cwd, 'node_modules', 'electron', 'dist', executable);
    const file = await access(local, constants.X_OK).then(() => local, () => executableOnPath('electron', env));
    if (!file) throw Error('Install the project Electron dependencies and retry.');
    return {file, args, nodeMode: false};
  }
  const command = await projectCommand(argv, {...env, PATH: env.PATH || env.Path || ''});
  if (command.file === process.execPath) {
    if (/\.[cm]?js$/i.test(program) && !path.isAbsolute(program)) {
      command.args[0] = await plainPath(cwd, relativePath(program.replaceAll('\\', '/').replace(/^\.\//, '')));
    }
    if (desktop && process.versions.electron) {
      const file = await executableOnPath('node', env);
      if (!file) throw Error('Install Node.js for the desktop project and retry.');
      return {...command, file, nodeMode: false};
    }
    return {...command, nodeMode: true};
  }
  if (!path.isAbsolute(command.file) && /[\\/]/.test(command.file)) {
    const relative = relativePath(command.file.replace(/^\.\//, '').replaceAll('\\', '/'));
    command.file = await plainPath(cwd, relative);
  }
  return {...command, nodeMode: false};
}

export async function programAvailable(name, cwd) {
  try {
    const file = ['codex', 'muse'].includes(name) ? await agentExecutable(name) :
      (await resolveProjectCommand([name], {cwd})).file;
    return path.isAbsolute(file) ?
      access(file, constants.X_OK).then(() => true, () => false) :
      Boolean(await executableOnPath(file, process.env));
  } catch { return false; }
}

function killTree(child, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', timeout: 3000});
      if (result.status !== 0) child.kill();
    }
    return;
  }
  try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function normalizedSettings(input) {
  const url = input.url || '';
  const mode = input.mode === 'process' ? 'desktop' : input.mode || (url ? 'web' : 'desktop');
  if (!['web', 'desktop', 'external'].includes(mode)) throw Error('Choose a preview mode.');
  if (mode === 'external') return {mode, argv: [], cwd: '.', url: previewAddress(url)};
  const recipe = validateRecipe({
    directory: input.cwd || '.', start: literalArguments(input.argv), setup: input.setup, services: input.services,
    readyPath: input.readyPath, env: input.env
  });
  const cwd = relativePath(recipe.directory.replaceAll('\\', '/'), {directory: true});
  const settings = {mode, argv: recipe.start, cwd, url: mode === 'web' ? previewAddress(url, {local: true, template: true}) : ''};
  if (recipe.setup.length) settings.setup = recipe.setup;
  if (recipe.services.length) settings.services = recipe.services;
  if (Object.keys(recipe.env).length) settings.env = recipe.env;
  if (recipe.readyPath !== '/') settings.readyPath = recipe.readyPath;
  return settings;
}

export class PreviewProcess {
  constructor(root, local, directory, parentOrigin) {
    this.root = root;
    this.local = local;
    this.directory = directory;
    this.parentOrigin = parentOrigin;
    this.children = [];
    this.log = null;
    this.queue = Promise.resolve();
    this.exitHook = () => this.children.forEach(item => killTree(item.child, true));
  }

  edit(callback) {
    const result = this.queue.then(callback);
    this.queue = result.catch(() => {});
    return result;
  }

  running() {
    return this.starting || this.children.some(({live}) => live);
  }

  async settings() {
    const dir = await this.directory();
    const saved = dir && await boundedText(dir, 'preview.json', 512 * 1024).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (saved) return normalizedSettings(JSON.parse(saved));
    const recipe = await readRecipe(this.local);
    if (!recipe) return null;
    return normalizedSettings({
      mode: 'web', cwd: recipe.directory, argv: recipe.start, url: 'http://127.0.0.1:{port}' + recipe.readyPath,
      setup: recipe.setup, services: recipe.services, env: recipe.env, readyPath: recipe.readyPath
    });
  }

  async status() {
    const settings = await this.settings();
    if (!settings) return {settings: null, state: 'unconfigured', owned: false, url: '', log: ''};
    const {mode} = settings;
    const url = this.url || (!settings.url.includes(portRequest) ? settings.url : '');
    const owned = this.children.some(({live}) => live);
    let state = this.exitCode != null || this.failure ? 'exited' : 'stopped';
    if (mode === 'external' || url && await listening(url)) state = owned ? 'running' : 'external';
    else if (owned) state = mode === 'desktop' ? 'running' : 'starting';
    if (this.log === null) {
      const dir = await this.directory();
      const saved = dir && await boundedText(dir, 'preview-output.json', 512 * 1024).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      this.log ??= saved ? JSON.parse(saved).log : '';
    }
    return {settings, state, owned, url, log: this.log, exitCode: this.exitCode, message: this.failure || ''};
  }

  setup(payload) {
    return this.edit(async () => {
      if (this.running()) throw Error('Stop the preview before changing its settings.');
      const settings = normalizedSettings(payload);
      await plainPath(this.root, settings.cwd, {directory: true});
      await atomicJson(await this.directory(true), 'preview.json', settings);
      this.exitCode = null;
      this.failure = '';
      this.url = '';
      this.log = '';
      await this.saveLog();
      return this.status();
    });
  }

  launch(name, command, cwd, sourceEnv) {
    const env = {...sourceEnv};
    if (command.nodeMode && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command.file, command.args, {
      cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    });
    const item = {child, live: true};
    const record = chunk => { this.log = (this.log + '[' + name + '] ' + chunk).slice(-64000); };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    item.finished = new Promise(resolve => {
      let failure;
      child.once('error', error => { failure = error; record(error.message); });
      child.once('close', (code, signal) => {
        item.live = false;
        resolve({code, signal, failure});
      });
    });
    this.children.push(item);
    return item;
  }

  start() {
    return this.edit(async () => {
      const settings = await this.settings();
      if (!settings) throw Error('Save the preview command before starting it.');
      if (settings.mode === 'external' || this.running()) return this.status();
      const port = settings.mode === 'web' ? await portFor(settings.url) : '';
      this.url = settings.url.replaceAll(portRequest, String(port));
      if (this.url && await listening(this.url)) return this.status();
      const dir = await this.directory(true);
      const cwd = await plainPath(this.root, settings.cwd, {directory: true});
      const data = await plainPath(dir, 'scratch/preview-data', {directory: true, create: true});
      const recipe = validateRecipe({start: settings.argv, setup: settings.setup, services: settings.services, env: settings.env});
      const commit = await gitRead(this.root, 'rev-parse', 'HEAD').then(value => value.trim(), () => '');
      const expanded = expandRecipe(recipe, {port, root: this.root, side: 'workspace', data, commit});
      const env = {...process.env, ...expanded.env, BRANCH_REVIEW_DATA: data};
      if (this.parentOrigin) env.BRANCH_REVIEW_PREVIEW_PARENT = this.parentOrigin;
      if (port) env.PORT = String(port);
      const command = argv => resolveProjectCommand(argv, {cwd, env, desktop: settings.mode === 'desktop'});
      this.children = [];
      this.log = '';
      this.exitCode = null;
      this.failure = '';
      const stamp = stableId([settings, commit, await lstat(cwd).then(info => info.ino)]);
      this.starting = true;
      process.once('exit', this.exitHook);
      try {
        const applied = await boundedText(dir, 'preview-setup.json', 80000).then(JSON.parse, error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (expanded.setup.length && applied?.stamp !== stamp) {
          for (const argv of expanded.setup) {
            const item = this.launch('setup', await command(argv), cwd, env);
            const timer = setTimeout(() => killTree(item.child, true), 120000);
            const {code, failure} = await item.finished.finally(() => clearTimeout(timer));
            if (failure || code !== 0) throw failure || Error('A preview setup command failed. See the preview output.');
          }
          await atomicJson(dir, 'preview-setup.json', {stamp});
        }
        for (const service of [...expanded.services, {name: 'preview', args: expanded.start}]) {
          const item = this.launch(service.name, await command(service.args), cwd, env);
          item.finished.then(({code, signal, failure}) => {
            if (!this.children.includes(item)) return;
            this.exitCode = code;
            this.failure = failure?.message || (code === 0 ? 'Preview process finished.' :
              signal ? 'Preview process stopped.' : 'Preview process exited. See its output.');
            this.edit(async () => {
              if (this.children.includes(item)) {
                await this.stopChildren();
                await this.saveLog();
              }
            }).catch(() => {});
          });
        }
      } catch (error) {
        this.failure = error.message;
        await this.stopChildren();
        await this.saveLog();
        throw error;
      } finally {
        this.starting = false;
      }
      return this.status();
    });
  }

  async saveLog() {
    if (this.log === null) return;
    const dir = await this.directory();
    if (dir) await atomicJson(dir, 'preview-output.json', {log: this.log});
  }

  async stopChildren() {
    process.removeListener('exit', this.exitHook);
    const children = this.children;
    this.children = [];
    for (const {child, live} of children) if (live || process.platform !== 'win32') killTree(child);
    if (!children.some(({live}) => live)) return;
    let timer;
    try {
      await Promise.race([
        Promise.all(children.map(item => item.finished)),
        new Promise(resolve => {
          timer = setTimeout(() => {
            for (const {child, live} of children) if (live) killTree(child, true);
            resolve();
          }, 3000);
        })
      ]);
    } finally { clearTimeout(timer); }
  }

  stop() {
    return this.edit(async () => {
      await this.stopChildren();
      await this.saveLog();
      this.failure = '';
      this.exitCode = null;
      return this.status();
    });
  }

  close() {
    return this.edit(async () => {
      await this.stopChildren();
      await this.saveLog();
    });
  }
}
