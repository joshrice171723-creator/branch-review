import {constants} from 'node:fs';
import {access, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {projectCommand} from '../web-project.mjs';

export const checkPathInside = (root, file) => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

export async function checkFile(file, executable = false) {
  try {
    const target = await realpath(file);
    const info = await stat(target);
    if (!info.isFile()) return null;
    if (executable) await access(target, constants.X_OK);
    return {file, target, mode:info.mode};
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) return null;
    throw error;
  }
}

async function executableFile(program, cwd, searchPath) {
  const direct = path.isAbsolute(program) || /[\\/]/.test(program);
  const directories = direct ? [cwd] : searchPath.split(path.delimiter).map(directory => path.resolve(cwd, directory));
  const suffixes = process.platform === 'win32' && !path.extname(program) ? ['.com', '.exe', ''] : [''];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const file = await checkFile(path.resolve(directory, program + suffix), true);
      if (file) return file;
    }
  }
  return null;
}

function nodeEntry(args) {
  const optionsWithValue = new Set(['-r', '--require', '--import', '--conditions', '-C', '--env-file',
    '--env-file-if-exists', '--loader', '--experimental-loader', '--test-name-pattern', '--test-skip-pattern',
    '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-shard', '--test-timeout', '--input-type']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^(?:-e|-p|--(?:eval|print|run)(?:=|$))/.test(arg) || ['-', '-h', '--help', '-v', '--version'].includes(arg)) return null;
    if (arg === '--') return args[i + 1] ?? null;
    if (optionsWithValue.has(arg)) i++;
    else if (!arg.startsWith('-')) return arg;
  }
  return null;
}

async function nodeEntryFiles(entry) {
  const file = await checkFile(entry) ?? await checkFile(entry + '.js') ?? await checkFile(entry + '.json') ??
    await checkFile(entry + '.node');
  if (file) return [file];
  if (!(await stat(entry).catch(() => null))?.isDirectory()) return null;
  return (await Promise.all(['package.json', 'index.js', 'index.json', 'index.node'].map(name =>
    checkFile(path.join(entry, name))))).filter(Boolean);
}

export async function resolveCheckCommand(argv, cwd, env = process.env) {
  const searchPath = env.PATH ?? env.Path ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin');
  const [program, ...args] = argv;
  const command = await projectCommand(/^npm(?:\.cmd)?$/i.test(program) ? ['npm', ...args] : argv,
    {...env, PATH:searchPath});
  const mappedNode = command.file === process.execPath && program !== command.file;
  const standalone = mappedNode && process.versions.electron ? await executableFile('node', cwd, searchPath) : null;
  const executable = standalone ?? await executableFile(command.file, cwd, searchPath);
  if (!executable) {
    throw Object.assign(Error('Check executable is missing or cannot run: ' + program),
      {input:locationOf(cwd, command.file)});
  }
  const nodeMode = Boolean(process.versions.electron && mappedNode && !standalone);
  const entry = mappedNode || /^node(?:\.exe)?$/i.test(path.basename(executable.file)) ? nodeEntry(command.args) : null;
  const entryPath = entry && !/[*?]/.test(entry) ? path.resolve(cwd, entry) : null;
  const entryFiles = entryPath ? await nodeEntryFiles(entryPath) : [];
  if (!entryFiles) {
    throw Object.assign(Error('Check entry file is missing or unreadable: ' + entry), {input:entryPath});
  }
  return {...command, file:executable.file, executable, entryFiles, nodeMode};
}

function locationOf(cwd, file) {
  return path.isAbsolute(file) || /[\\/]/.test(file) ? path.resolve(cwd, file) : null;
}
