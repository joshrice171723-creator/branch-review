import assert from 'node:assert/strict';
import {access,readdir,mkdtemp,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(process.argv[2]);
const run=promisify(execFile);
const require=createRequire(import.meta.url);
assert.ok(process.versions.electron,'Run using the installed Electron executable');
for(const file of ['desktop/main.cjs','desktop/preload.cjs','desktop/repository.cjs','desktop/setup-help.cjs','desktop/browser-qa.cjs','desktop/icon.ico'])await access(path.join(root,file));
for(const forbidden of ['.local','.git','.harness','test','.env','__pycache__'])assert.equal(await access(path.join(root,forbidden)).then(()=>true,()=>false),false,forbidden+' leaked into installer');
assert.deepEqual((await readdir(path.join(root,'node_modules'))).filter(name=>!name.startsWith('.')),['axe-core']);
const {detectProject,npmEntry}=await import(pathToFileURL(path.join(root,'web-project.mjs')));
const {probeProvider}=await import(pathToFileURL(path.join(root,'providers.mjs')));
const fixture=await mkdtemp(path.join(os.tmpdir(),'installed-review-'));
const empty=path.join(fixture,'empty');await mkdir(empty);
const systemPath=path.join(process.env.SystemRoot || 'C:\\Windows','System32');
process.env.PATH=systemPath;
process.env.LOCALAPPDATA=empty;process.env.USERPROFILE=empty;process.env.HOME=empty;
for(const name of ['APEX_WORKBENCH_URL','HARNESS_PYTHON','HARNESS_RUBY','HARNESS_NODE','BRANCH_REVIEW_CODEX','BRANCH_REVIEW_CLAUDE'])delete process.env[name];
const runtime=path.join(path.dirname(root),'runtime');
const {configureBundledRuntimes}=require(path.join(root,'desktop/windows-runtime.cjs'));
const tools=configureBundledRuntimes(runtime);
assert.equal(process.env.PATH.split(path.delimiter)[0],systemPath);
const locked=JSON.parse(await readFile(path.join(runtime,'windows-runtimes.json'),'utf8'));
const versions={python:['-c','import sqlite3, ssl, sys; print(sys.version.split()[0])'],
  ruby:['-e','require "json"; require "openssl"; print RUBY_VERSION'],node:['-p','process.versions.node']};
for(const [name,executable] of Object.entries(tools)){
  assert.equal(process.env['HARNESS_'+name.toUpperCase()],executable);
  assert.equal((await run(executable,versions[name],{cwd:fixture,windowsHide:true,timeout:120000})).stdout.trim(),locked[name].version);
}
const npm=await npmEntry();
assert.equal(await realpath(npm),await realpath(path.join(runtime,'node/node_modules/npm/bin/npm-cli.js')));
assert.match((await run(tools.node,[npm,'--version'],{cwd:fixture,windowsHide:true})).stdout,/^\d+\.\d+\.\d+/);
await writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'independent',devDependencies:{vite:'1'}}));
await writeFile(path.join(fixture,'package-lock.json'),'{}');
assert.equal((await detectProject(fixture)).kind,'vite');
const {projectPanel}=await import(pathToFileURL(path.join(root,'apex-panel.mjs')));
const panel=projectPanel(await realpath(fixture));
assert.equal((await panel.status()).installed,false);
let workbench=await panel.install();
assert.equal(workbench.installed,true);
assert.equal(workbench.runtimeRevision,workbench.availableRevision);
if(process.env.BRANCH_REVIEW_EXPECTED_WORKBENCH_REVISION){
  assert.equal(workbench.runtimeRevision,process.env.BRANCH_REVIEW_EXPECTED_WORKBENCH_REVISION);
}
const record=path.join(fixture,'.harness','pilot-record.json');
await writeFile(record,'{"layout":"Design"}');
await writeFile(path.join(fixture,'.harness','MANIFEST.sha256'),'outdated manifest');
assert.equal((await panel.status()).upgradeAvailable,true);
workbench=await panel.install();
assert.equal(workbench.upgradeAvailable,false);
assert.equal(await readFile(record,'utf8'),'{"layout":"Design"}');
try {
  const mounted=await panel.open();
  assert.equal(mounted.src,'/__workbench/');
  assert.equal((await panel.status()).mounted,true);
  const proxy=createServer((request,response)=>{if(!panel.handle(request,response))response.writeHead(404).end();});
  try {
    await new Promise((resolve,reject)=>proxy.once('error',reject).listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${proxy.address().port}${mounted.src}api/bootstrap`,{signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);
    assert.equal((await response.json()).installed,true);
  } finally { await new Promise(resolve=>proxy.close(resolve)); }
} finally { panel.close(); }
for(const provider of ['codex','claude'])assert.equal((await probeProvider(provider)).status,'missing');
console.log('Installed runtime passed on a restricted PATH: private Python, Ruby, Node and npm, Workbench install, record-preserving upgrade and mounted bootstrap.');
