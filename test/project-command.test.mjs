import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectCommand} from '../web-project.mjs';
import {configuredChecks} from '../jobs.mjs';

test('package manager JS entries run with literal arguments and support local .bin and Corepack layouts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'package managers ')),modules=path.join(root,'node_modules');
 for(const file of ['pnpm/bin/pnpm.mjs','corepack/dist/yarn.js']){const entry=path.join(modules,file);await mkdir(path.dirname(entry),{recursive:true});await writeFile(entry,'console.log(JSON.stringify(process.argv.slice(2)));');}
 for(const [manager,directory] of [['pnpm',path.join(modules,'.bin')],['yarn',root]]){
  const command=await projectCommand([manager,'run','hello & world'],{PATH:directory});assert.equal(command.file,process.execPath);
  const result=await promisify(execFile)(command.file,command.args,{windowsHide:true});assert.deepEqual(JSON.parse(result.stdout),['run','hello & world']);
 }
 await assert.rejects(projectCommand(['pnpm','dev'],{PATH:''}),/Install pnpm/);
 await assert.rejects(projectCommand(['untrusted.cmd']),/shell wrapper/);
 assert.deepEqual(await projectCommand(['scripts/server.mjs','--port','123']),{file:process.execPath,args:['scripts/server.mjs','--port','123']});
});

test('configured checks retain their declared package manager',async()=>{
 for(const manager of ['pnpm','yarn','bun','npm']){
  const checks=await configuredChecks(async()=>JSON.stringify({packageManager:manager+'@1.0.0',scripts:{test:'run-tests'}}),'commit');
  assert.ok(checks.every(check=>check.manager===manager));
 }
});
