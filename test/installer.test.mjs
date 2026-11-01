import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import setup from '../desktop/setup-help.cjs';
import {executable,probeProvider} from '../providers.mjs';

test('missing Git has a download path and never opens a project; help URLs are fixed',async()=>{
  let opened='';
  assert.equal(await setup.requireGit({exec:async()=>{throw Error('missing');},dialog:{showMessageBox:async()=>({response:0})},openExternal:async url=>{opened=url;}}),false);
  assert.equal(opened,'https://git-scm.com/downloads/win');
  assert.equal(await setup.requireGit({exec:async()=>({stdout:'git'})}),true);
  assert.throws(()=>setup.setupUrl('https://evil.test'));assert.throws(()=>setup.setupUrl('__proto__'));
});
test('installer includes only application source and preserves user data',async()=>{
  const config=JSON.parse(await readFile(new URL('../desktop/installer.json',import.meta.url)));
  assert.equal(config.nsis.perMachine,false);assert.equal(config.nsis.deleteAppDataOnUninstall,false);assert.equal(config.nsis.runAfterFinish,true);
  assert.ok(config.files.includes('desktop/project-discovery.cjs'));assert.ok(config.files.includes('desktop/welcome-agent.cjs'));
  assert.ok(!config.files.includes('**/*'));assert.ok(!config.files.some(file=>file.startsWith('.local')));
});
test('Claude npm entry discovery and signed-out probe use actionable guidance',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'claude-discovery-')),entry=path.join(root,'node_modules/@anthropic-ai/claude-code/cli.js');
  await mkdir(path.dirname(entry),{recursive:true});await writeFile(entry,"console.log(process.argv.includes('--version')?'Claude Code 2.1.259':JSON.stringify({loggedIn:false}));");
  assert.equal(await executable('claude',null,{PATH:root}),entry);
  const result=await probeProvider('claude',entry);assert.equal(result.status,'sign-in');assert.match(result.message,/claude auth login/);
});

test('finds a standalone Codex install without requiring an app restart for PATH',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codex-discovery-')),file=path.join(root,'Programs/OpenAI/Codex/bin',process.platform==='win32'?'codex.exe':'codex');
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'fixture');
  assert.equal(await executable('codex',null,{PATH:'',LOCALAPPDATA:root}),file);
});

test('finds a newly installed Git without requiring an app restart',async()=>{
  const env={ProgramFiles:path.join(os.tmpdir(),'git-programs'),PATH:'old'},file=path.join(env.ProgramFiles,'Git','cmd','git.exe');
  const exec=async command=>{if(command!==file)throw Error('missing');return {stdout:'git'};};
  assert.equal(await setup.gitAvailable({exec,env}),true);assert.equal(env.PATH.split(path.delimiter)[0],path.dirname(file));
});
