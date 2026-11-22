import {execFile} from 'node:child_process';
import {access, mkdir, readFile, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const prefix = '/__workbench/';

export function panelAddress(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash ||
      !/^\/__workbench\/(?:(?:[a-z0-9]+|p\/[0-9a-f]{20})\/)?$/.test(url.pathname)) {
    throw Error('Use a loopback Workbench panel address.');
  }
  return url;
}

export function projectPanel(repository, configured = process.env.APEX_WORKBENCH_URL, origin) {
  const remote = panelAddress(configured);
  const root = path.resolve(repository);
  const entry = path.join(root, '.harness', 'portable', 'mount.cjs');
  const installer = fileURLToPath(new URL('./workbench-install.py', import.meta.url));
  let starting, owned;

  async function externalAddress() {
    let target = remote;
    for (let hops = 0; hops < 2; hops++) {
      const response = await fetch(target, {redirect:'manual', signal:AbortSignal.timeout(10000)});
      await response.body?.cancel();
      if (response.status === 302 && response.headers.has('location')) {
        const next = panelAddress(new URL(response.headers.get('location'),target).href);
        if (next.origin !== remote.origin) throw Error('The configured panel changed server.');
        target = next;
        continue;
      }
      if (!response.ok) throw Error('Open the configured Apex Workbench service and retry.');
      const state = await fetch(new URL('api/state',target), {redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!state.ok) throw Error('Workbench could not identify its project.');
      const targetRoot = (await state.json()).project?.path;
      if (!targetRoot || await realpath(targetRoot) !== await realpath(root)) {
        throw Error('The running Workbench serves a different project.');
      }
      return target.href;
    }
    throw Error('The configured service did not return a project-bound panel.');
  }
  async function available() {
    return await access(entry).then(()=>true,()=>false);
  }
  async function register() {
    if (!origin || !await available()) return;
    const home=path.join(await realpath(root),'.harness');
    if(await realpath(home)!==home) throw Error('The project runtime must be inside its checkout.');
    const hosts=path.join(home,'hosts');
    await mkdir(hosts,{recursive:true});
    if(await realpath(hosts)!==hosts) throw Error('Invalid project host directory.');
    const record=JSON.stringify({version:1,name:'Branch Review',url:origin+'/#workbench'});
    const file=path.join(hosts,'branch-review.json');
    if(await readFile(file,'utf8').catch(error=>{if(error.code!=='ENOENT') throw error;})===record) return;
    const temp=path.join(hosts,randomUUID()+'.tmp');
    await writeFile(temp,record,{flag:'wx'});
    try {await rename(temp,file);} finally {await unlink(temp).catch(error=>{if(error.code!=='ENOENT') throw error;});}
  }
  return {
    frameOrigin: remote?.origin || '',
    async status() {
      return {project:root, installed:await available(), connected:Boolean(remote), mounted:Boolean(owned)};
    },
    async install() {
      if (owned || remote) throw Error('Close the active Workbench service before installing a runtime.');
      await execute(process.env.HARNESS_PYTHON || 'python', [installer, root],
        {cwd:root,windowsHide:true,timeout:120000,maxBuffer:512*1024});
      if (!await available()) throw Error('The installation did not supply a portable panel.');
      return this.status();
    },
    async open() {
      if (remote) {
        const src=await externalAddress();
        await register();return {src,project:root};
      }
      if (!await available()) throw Error('Install Apex Workbench for this project first.');
      if (!starting) starting = require(entry).mountWorkbench(root).then(panel => owned = panel)
        .catch(error => {starting = null; throw error;});
      await starting;
      await register();
      return {src:prefix, project:root};
    },
    handle(req,res) {
      if (!req.url.startsWith(prefix)) return false;
      if (owned) return owned.handle(req,res);
      res.writeHead(409,{'Content-Type':'text/plain; charset=utf-8'}).end('Open Workbench from the Branch Review toolbar.');
      return true;
    },
    close() {owned?.close();}
  };
}
