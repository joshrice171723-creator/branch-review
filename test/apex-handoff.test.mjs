import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {panelAddress} from '../apex-panel.mjs';
import {readHandoff,returnFindings,selectHandoffBranch} from '../workbench-handoff.mjs';

test('project panels accept canonical loopback workspace and bound server links',()=>{
  assert.ok(panelAddress('http://127.0.0.1:8794/__workbench/p/0123456789abcdef0123/'));
  assert.ok(panelAddress('http://localhost:8792/__workbench/'));
  for(const url of ['https://example.com/__workbench/','http://localhost:8792/api/','http://u:p@localhost/__workbench/']) {
    assert.throws(()=>panelAddress(url),/loopback/);
  }
});

test('only the exact source commit and selected open findings enter the project inbox',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'apex-review-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const out=path.join(root,'.harness','branch-review','outgoing');
  await mkdir(out,{recursive:true});
  const runId='20261122T024853906396-aaaaaaaa';
  const ref='refs/heads/feature/notes',commit='a'.repeat(40),reviewed='b'.repeat(40);
  const source={kind:'apex-branch-review',version:1,runId,ref,commit,sourceHash:'c'.repeat(64),title:'Review notes'};
  await writeFile(path.join(out,runId+'.json'),JSON.stringify(source));
  const handoff=await readHandoff(root,runId);
  assert.equal(selectHandoffBranch(handoff,[{ref,sha:commit}]).sha,commit);
  assert.throws(()=>selectHandoffBranch(handoff,[{ref,sha:reviewed}]),/moved/);
  const issue={id:'count',expected:'Three notes',actual:'Two notes',scenario:'notes',commit:reviewed,side:'changed',status:'open',location:'/notes'};
  const record={id:'review-1',identity:{source:commit,changed:reviewed,ref},issues:[issue,{...issue,id:'old',status:'resolved'}]};
  await assert.rejects(returnFindings(root,runId,record,['old']),/changed/);
  await assert.rejects(returnFindings(root,runId,{...record,identity:{...record.identity,source:reviewed}},['count']),/match/);
  const [one,two]=await Promise.all([returnFindings(root,runId,record,['count']),returnFindings(root,runId,record,['count'])]);
  assert.equal(one.id,two.id);assert.match(one.scope,/Three notes/);
  const incoming=path.join(root,'.harness','branch-review','incoming',runId);
  assert.deepEqual(await readdir(incoming),[one.id+'.json']);
  const saved=JSON.parse(await readFile(path.join(incoming,one.id+'.json'),'utf8'));
  assert.equal(saved.commit,commit);assert.equal(saved.reviewedCommit,reviewed);
  assert.deepEqual(saved.findings.map(row=>row.id),['count']);
});
