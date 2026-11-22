const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lock = require('./windows-runtimes.json');

async function archivePath(spec, cache, verified) {
  const name = path.basename(new URL(spec.archive).pathname);
  const file = path.join(cache, name);
  let bytes = await fs.readFile(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const download = !bytes;
  if (download) {
    console.log(`Downloading ${name}`);
    const response = await fetch(spec.archive, {signal: AbortSignal.timeout(180_000)});
    if (!response.ok) throw Error(`Could not download ${name} (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) {
    throw Error(`SHA-256 verification failed for ${name}.`);
  }
  const staged = path.join(verified, name);
  if (download && file !== staged) await fs.writeFile(file, bytes);
  await fs.writeFile(staged, bytes);
  return staged;
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {encoding:'utf8', windowsHide:true, timeout:120_000, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${path.basename(executable)} failed (${result.status}). ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function stageWindowsRuntimes(stagingParent = os.tmpdir()) {
  if (process.platform !== 'win32') throw Error('Build the Windows installer on Windows.');
  const parent = await fs.realpath(stagingParent);
  const staging = await fs.mkdtemp(path.join(parent, 'branch-review-runtime-'));
  const cleanup = async () => {
    if (path.dirname(staging) === parent && await fs.realpath(staging) === staging) {
      await fs.rm(staging, {recursive:true, force:true, maxRetries:3});
    }
  };
  try {
    const bundle = path.join(staging, 'runtime');
    const verified = path.join(staging, 'archives');
    const cache = process.env.BRANCH_REVIEW_RUNTIME_CACHE ? path.resolve(process.env.BRANCH_REVIEW_RUNTIME_CACHE) : verified;
    await fs.mkdir(bundle);
    await fs.mkdir(verified);
    await fs.mkdir(cache, {recursive:true});
    const archives = await Promise.all(Object.values(lock).map(spec => archivePath(spec, cache, verified)));
    const extractor = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    for (const [index, [name, spec]] of Object.entries(lock).entries()) {
      const extracted = path.join(staging, name + '-archive');
      await fs.mkdir(extracted);
      console.log(`Extracting ${name} ${spec.version}`);
      const exclude = name === 'ruby' ? ['--exclude=' + spec.directory + '/share/ri'] : [];
      command(extractor, ['-xf', archives[index], '-C', extracted, ...exclude], {timeout:600_000});
      const source = spec.directory ? path.join(extracted, spec.directory) : extracted;
      if (!(await fs.realpath(source)).startsWith(staging + path.sep)) throw Error('Invalid runtime archive layout.');
      await fs.rename(source, path.join(bundle, name));
    }
    const env = {...process.env};
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
    for (const key of ['PYTHONHOME','PYTHONPATH','PYTHONUSERBASE','RI_DEVKIT','RUBYOPT','RUBYLIB','GEM_HOME','GEM_PATH','NODE_OPTIONS','NODE_PATH']) delete env[key];
    const outputs = {
      python: ['-c', 'import sqlite3, ssl, subprocess, sys; print(sys.version.split()[0])'],
      ruby: ['-e', 'require "json"; require "openssl"; print RUBY_VERSION'],
      node: ['-p', 'process.versions.node']
    };
    for (const [name, spec] of Object.entries(lock)) {
      if (command(path.join(bundle, spec.executable), outputs[name], {env}) !== spec.version) {
        throw Error(`The bundled ${name} version does not match the runtime lock.`);
      }
    }
    command(path.join(bundle, lock.node.executable), [path.join(bundle, 'node/node_modules/npm/bin/npm-cli.js'), '--version'], {env});
    console.log('Verified the private Python, Ruby, Node and npm executables');
    await fs.copyFile(path.join(__dirname, 'windows-runtimes.json'), path.join(bundle, 'windows-runtimes.json'));
    return {bundle, cleanup};
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = {stageWindowsRuntimes};
