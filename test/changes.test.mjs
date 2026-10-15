import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {changedFiles,fileDiff,commitHistory} from '../changes.mjs';

test('code comparison handles modified, renamed, deleted and binary files at exact commits',async()=>{
  mkdirSync('.local',{recursive:true});const cwd=path.resolve(mkdtempSync('.local/changes-test-'));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  writeFileSync(path.join(cwd,'edit.txt'),'before\n');writeFileSync(path.join(cwd,'old.txt'),'same content\n');writeFileSync(path.join(cwd,'removed.txt'),'remove\n');
  git('add','.');git('commit','-m','Original');const base=git('rev-parse','HEAD');
  writeFileSync(path.join(cwd,'edit.txt'),'after\n');renameSync(path.join(cwd,'old.txt'),path.join(cwd,'renamed.txt'));unlinkSync(path.join(cwd,'removed.txt'));writeFileSync(path.join(cwd,'image.bin'),Buffer.from([0,1,2,0,3]));
  git('add','.');git('commit','-m','Changed');const changed=git('rev-parse','HEAD');
  const files=await changedFiles(git,base,changed);
  assert.equal(files.find(f=>f.path==='renamed.txt').status,'R');assert.equal(files.find(f=>f.path==='renamed.txt').added,0);
  assert.equal(files.find(f=>f.path==='removed.txt').status,'D');assert.equal(files.find(f=>f.path==='image.bin').binary,true);
  const diff=await fileDiff(git,base,changed,'edit.txt');assert.match(diff.patch,/-before/);assert.match(diff.patch,/\+after/);assert.equal(diff.base,base);
  assert.match((await fileDiff(git,base,changed,'renamed.txt')).patch,/rename from old.txt/);
  await assert.rejects(fileDiff(git,base,changed,'unrelated.txt'),/Choose a file/);
  await assert.rejects(changedFiles(git,'HEAD',changed),/exact comparison/);
  assert.equal((await commitHistory(git,changed))[0].subject,'Changed');
  assert.equal(git('status','--porcelain'),'');
});
