// Optional installed-runtime acceptance: provide resources/app and a Python executable.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
assert.ok(process.versions.electron,'Run with installed Electron and ELECTRON_RUN_AS_NODE=1');
const [appRoot,python]=process.argv.slice(2);
assert.ok(appRoot && path.isAbsolute(python),'Provide resources/app and an absolute Python executable');
const {WebPreviews}=await import(pathToFileURL(path.resolve(appRoot,'web-project.mjs')));
const {saveRecipe}=await import(pathToFileURL(path.resolve(appRoot,'project-settings.mjs')));
const root=await mkdtemp(path.join(os.tmpdir(),'branch-review-python-'));
const local=path.join(root,'state');await mkdir(local);
const paths={original:path.join(root,'original'),changed:path.join(root,'changed')};
for(const [side,cwd] of Object.entries(paths)){
  await mkdir(cwd);
  await writeFile(path.join(cwd,'index.html'),`<button style="background:${side==='original'?'blue':'pink'}">${side}</button>`);
}
await saveRecipe(local,{start:[python,'-m','http.server','{port}','--bind','127.0.0.1']});
process.env.PATH=process.platform==='win32'?path.join(process.env.SystemRoot,'System32'):'/usr/bin';
const exec=promisify(execFile);
const run=async(file,args,options={})=>(await exec(file,args,{...options,windowsHide:true,timeout:30000})).stdout;
const previews=new WebPreviews({run,local,progress:console.log});
let original,changed;
try{
  [original,changed]=await Promise.all(Object.entries(paths).map(([side,cwd])=>previews.prepare(side,side,cwd,async()=>{})));
  assert.notEqual(original.web,changed.web);
  assert.match(await fetch(`http://127.0.0.1:${original.web}`).then(r=>r.text()),/background:blue/);
  assert.match(await fetch(`http://127.0.0.1:${changed.web}`).then(r=>r.text()),/background:pink/);
  const reused=await previews.prepare('changed','changed',paths.changed,async()=>{throw Error('Healthy preview checked out again');});
  assert.equal(reused.web,changed.web);
  await previews.stop('changed');
  assert.equal(await previews.healthy('original','original'),true);
  assert.equal(await previews.healthy('changed','changed'),false);
  console.log('PASS: packaged custom Python previews have independent ports/content, reuse a healthy version, and stop independently without Node/agent PATH entries.');
}finally{await previews.stop('original');await previews.stop('changed');}
