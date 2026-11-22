import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdir, readFile, realpath, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const prefix = '/__workbench/';
const workspaceCommand = `
import json
from pathlib import Path
import runpy
import sys

project = Path(sys.argv[2]).resolve(strict=True)
environment = runpy.run_path(sys.argv[1])
if sys.argv[3] == "prepare":
    folder = environment["managed"](project, create=True)
    result = {name: str(folder / name) for name in ("scratch", "tmp")}
else:
    result = environment["cleanup"](project)
print(json.dumps(result))
`;

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
  const python=process.env.HARNESS_PYTHON || 'python';
  const entry = path.join(root, '.harness', 'portable', 'mount.cjs');
  const environment=path.join(root,'.harness','portable','environment.py');
  const installer = fileURLToPath(new URL('./workbench-install.py', import.meta.url));
  let starting, owned, installing, preparing, directories, opened=false;

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
  async function info() {
    const bundled = JSON.parse(await readFile(new URL('./workbench-release/release.json', import.meta.url),'utf8'));
    const home = path.join(root,'.harness');
    const read = async name => readFile(path.join(home,name)).catch(error=>{
      if(error.code==='ENOENT') return null;
      throw error;
    });
    const [installed,manifest,record] = await Promise.all([available(),read('MANIFEST.sha256'),read('workbench-runtime.json')]);
    const actual = manifest && createHash('sha256').update(manifest).digest('hex');
    const known = record && JSON.parse(record.toString('utf8'));
    const current = Boolean(actual && actual === bundled.manifestSha256);
    return {project:root,installed,connected:Boolean(remote),mounted:Boolean(owned),
      managed:Boolean(directories),
      availableRevision:bundled.revision,runtimeRevision:current?bundled.revision:known?.revision || null,
      upgradeAvailable:Boolean(installed && !remote && bundled.manifestSha256 && !current)};
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
  async function mount() {
    if (installing) throw Error('Workbench is updating. Try again when it finishes.');
    if (!await available()) throw Error('Install Workbench for this project first.');
    if (!starting) {
      const request=(async()=>{
        const checkout=await realpath(root),actual=await realpath(entry);
        if(actual!==path.join(checkout,'.harness','portable','mount.cjs'))
          throw Error('The Workbench runtime must belong to this checkout.');
        return require(actual).mountWorkbench(checkout,{python,workDirectories:directories,onExit:()=>{
          if(starting===request) { starting=null; owned=null; }
        }});
      })().then(panel=>{
        if(panel.active===false) throw Error('Workbench stopped before opening.');
        return owned=panel;
      }).catch(error=>{ if(starting===request) starting=null; throw error; });
      starting=request;
    }
    return starting;
  }
  async function upgrade() {
    if (starting) await starting;
    if (owned) {
      if (!origin) throw Error('Close the Workbench panel before updating.');
      const reply = await fetch(origin+prefix+'api/state',{signal:AbortSignal.timeout(15000),redirect:'error'});
      if (!reply.ok) throw Error('Check Workbench run status before updating.');
      const state = await reply.json();
      if (state.jobs.some(job=>['created','starting','running','cancelling'].includes(job.state)))
        throw Error('Finish or pause the running task before updating Workbench.');
      owned.close();
      owned=null;
      starting=null;
    }
    await execute(python, [installer, root],
      {cwd:root,windowsHide:true,timeout:120000,maxBuffer:512*1024});
    if (!await available()) throw Error('The installation did not supply a portable panel.');
    delete require.cache[require.resolve(entry)];
    directories=null;
    return info();
  }
  function install() {
    if (remote) throw Error('Update the configured Workbench service from its project picker.');
    if (!installing) installing=upgrade().finally(()=>{installing=null;});
    return installing;
  }
  async function workspace(mode) {
    const actual=await realpath(environment);
    if(actual!==path.join(await realpath(root),'.harness','portable','environment.py'))
      throw Error('The Workbench environment must belong to this checkout.');
    try {
      const reply=await execute(python,['-I','-c',workspaceCommand,actual,root,mode],
        {cwd:root,windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
      return JSON.parse(reply.stdout);
    } catch(error) {
      const detail=error.stderr?.trim().split(/\r?\n/).at(-1);
      throw Error(detail || 'The Workbench environment could not be read. Retry Workbench.');
    }
  }
  function prepare() {
    if(remote) return info();
    if(!preparing) preparing=(async()=>{
      if(installing) await installing;
      if(!await available()) await install();
      if(!directories && await access(environment).then(()=>true,error=>{
        if(error.code==='ENOENT') return false;
        throw error;
      })) directories=await workspace('prepare');
      await register();
      return info();
    })().finally(()=>{preparing=null;});
    return preparing;
  }
  return {
    frameOrigin: remote?.origin || '',
    status: info,
    install,
    prepare,
    async cleanupPreview() {
      if(remote || !directories) throw Error('Prepare this checkout in Branch Review before previewing cleanup.');
      return workspace('cleanup');
    },
    async open() {
      if (remote) {
        const src=await externalAddress();
        await register();return {src,project:root,managed:false};
      }
      if(!owned) await prepare();
      await mount();
      await register();
      opened=true;
      return {src:prefix,project:root,managed:Boolean(directories)};
    },
    handle(req,res) {
      if (!req.url.startsWith(prefix)) return false;
      if (owned) return owned.handle(req,res);
      if (opened && !installing && req.method==='GET') {
        mount().then(panel=>panel.handle(req,res)).catch(error=>{
          res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));
        });
        return true;
      }
      res.writeHead(409,{'Content-Type':'text/plain; charset=utf-8'}).end('Open Workbench from the Branch Review toolbar.');
      return true;
    },
    close() {owned?.close();}
  };
}
