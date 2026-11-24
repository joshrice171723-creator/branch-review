import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, stat} from 'node:fs/promises';
import {atomicJson} from './workbench/environment/paths.mjs';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const actions = new Set(['up', 'run', 'build', 'create', 'start']);
const valued = new Set(['-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile', '--ansi', '--progress', '--parallel']);
const exists = filename => stat(filename).then(value => value.isFile(), () => false);

async function composeFiles(prefix, cwd, env, inspect) {
  const files = [];
  let projectDirectory = cwd;
  for (let index = 1; index < prefix.length; index++) {
    const arg = prefix[index];
    if (arg === '-f' || arg === '--file') files.push(prefix[++index]);
    else if (arg.startsWith('--file=')) files.push(arg.slice(7));
    else if (arg.startsWith('-f') && arg.length > 2) files.push(arg.slice(2).replace(/^=/, ''));
    else if (arg === '--project-directory') projectDirectory = path.resolve(cwd, prefix[++index]);
    else if (arg.startsWith('--project-directory=')) projectDirectory = path.resolve(cwd, arg.slice(20));
  }
  if (files.length) {
    if (files.some(filename => !filename)) throw Error('Choose a Compose file before previewing it.');
    if (files.includes('-')) throw Error('Save the Compose configuration to a file before previewing it.');
    return {files, explicit: true};
  }
  // Compose resolves .env and --env-file itself. Capture only its file-selection variables.
  const variables = env.COMPOSE_FILE ? env : Object.fromEntries((await inspect('config', '--environment')).split(/\r?\n/)
    .filter(line => /^(?:COMPOSE_FILE|COMPOSE_PATH_SEPARATOR)=/.test(line))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (variables.COMPOSE_FILE) return {files: variables.COMPOSE_FILE.split(variables.COMPOSE_PATH_SEPARATOR || path.delimiter), explicit: false};
  for (let directory = projectDirectory;; directory = path.dirname(directory)) {
    for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
      const base = path.join(directory, name);
      if (!await exists(base)) continue;
      const overrideNames = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
      const override = [];
      for (const candidate of overrideNames) {
        const filename = path.join(directory, candidate);
        if (await exists(filename)) { override.push(filename); break; }
      }
      return {files: [base, ...override], explicit: false};
    }
    if (path.dirname(directory) === directory) break;
  }
  throw Error('Coordinator could not identify the Compose files for this preview.');
}

export async function isolateComposeImages({command, cwd, env = process.env, directory, signal, run = execute}) {
  if (!/^docker(?:\.exe)?$/i.test(path.basename(command.file)) || command.args[0] !== 'compose') return {command};
  let action = -1;
  for (let index = 1; index < command.args.length; index++) {
    const arg = command.args[index];
    if (valued.has(arg)) { index++; continue; }
    if (actions.has(arg)) { action = index; break; }
  }
  if (action < 0) return {command};
  const prefix = command.args.slice(0, action);
  const inspect = async (...args) => {
    signal?.throwIfAborted();
    const result = await run(command.file, [...prefix, ...args], {cwd, env, signal, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
    return result.stdout;
  };
  const config = JSON.parse(await inspect('config', '--format', 'json'));
  const builtImages = new Set(Object.values(config.services || {})
    .filter(service => service.build && typeof service.image === 'string').map(service => service.image));
  const services = {};
  for (const [name, service] of Object.entries(config.services || {})) {
    if (builtImages.has(service.image)) {
      services[name] = {image: 'branch-review/' + digest(path.resolve(directory)) + ':' + digest(service.image)};
    }
  }
  if (!Object.keys(services).length) return {command};
  const source = await composeFiles(prefix, cwd, env, inspect);
  const extra = source.explicit ? [] : source.files.flatMap(filename => ['--file', filename]);
  const override = path.resolve(directory, 'compose-images.json');
  signal?.throwIfAborted();
  await mkdir(path.dirname(override), {recursive: true});
  await atomicJson(path.dirname(override), 'compose-images.json', {services});
  return {command: {...command, args: [...prefix, ...extra, '--file', override, ...command.args.slice(action)]}, override,
    sourceFiles: source.files};
}
