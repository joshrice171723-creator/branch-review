// Optional acceptance check against an existing two-commit Vite color-change fixture.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {WebPreviews} from '../web-project.mjs';
const exec=promisify(execFile);
const run=async(file,args,options={})=>(await exec(file,args,{...options,windowsHide:true,maxBuffer:2e6,timeout:120000})).stdout.trim();
const source=path.resolve(process.argv[2]);
const before=await run('git',['rev-parse','main'],{cwd:source});
const after=await run('git',['rev-parse','feature/green-button'],{cwd:source});
const root=await mkdtemp(path.join(os.tmpdir(),'branch-review-vite-')),local=path.join(root,'state');await mkdir(local);
const paths={original:path.join(root,'original'),changed:path.join(root,'changed')};
for(const cwd of Object.values(paths))await run('git',['clone','--no-hardlinks',source,cwd]);
const previews=new WebPreviews({run,local,progress:console.log});
const prepare=(side,sha)=>previews.prepare(side,sha,paths[side],()=>run('git',['checkout','--detach',sha],{cwd:paths[side]}));
const css=preview=>fetch(`http://127.0.0.1:${preview.web}/style.css`).then(r=>r.text());
try{
  const original=await prepare('original',before),changed=await prepare('changed',before);
  const pid=previews.running.get('changed').child.pid,start=performance.now();
  const updated=await prepare('changed',after),elapsed=Math.round(performance.now()-start);
  assert.equal(updated.web,changed.web);assert.equal(previews.running.get('changed').child.pid,pid);
  assert.match(await css(original),/#2563eb/);assert.match(await css(updated),/#15803d/);
  const cwd=paths.changed;
  await writeFile(path.join(cwd,'vite.config.js'),'export default { clearScreen: false };\n');
  await run('git',['add','vite.config.js'],{cwd});
  await run('git',['-c','user.name=Branch Review Test','-c','user.email=test@example.invalid','commit','-m','test: change preview configuration'],{cwd});
  const config=await run('git',['rev-parse','HEAD'],{cwd});await prepare('changed',config);
  assert.notEqual(previews.running.get('changed').child.pid,pid);
  console.log(`PASS: real Vite CSS update reused PID ${pid} and port ${updated.web} in ${elapsed} ms; Original stayed blue; config change restarted.`);
}finally{await previews.stop('original');await previews.stop('changed');}
