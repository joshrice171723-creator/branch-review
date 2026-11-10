import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {authorTour,installedVoices} from '../learn-author.mjs';
import {createLibrary} from '../learn-library.mjs';
import {loadFolderTour,readTourCode} from '../learn-player.mjs';
import {readTranscript} from '../learn-transcript.mjs';
import {agentArgs} from '../providers.mjs';

test('author model and thinking flags use the existing provider argument builder',()=>{
  const input={kind:'plan',cwd:'repo',output:'out',model:'gpt-6.1-sol',reasoning:'low'};
  const codex=agentArgs('codex',input);
  assert(codex.includes('model_reasoning_effort="low"'));
  assert.equal(codex[codex.indexOf('--model')+1],input.model);
  const muse=agentArgs('muse',{...input,model:'muse-spark-1.3'});
  assert(muse.includes('--disable-write'));
  assert.equal(muse[muse.indexOf('--reasoning-effort')+1],'low');
  assert.throws(()=>agentArgs('codex',{...input,reasoning:'bad-value'}),/thinking/);
});

test('author engine pins diff code, drops invalid cues, and packages exact sentence timings',
  {skip:process.platform!=='win32',timeout:120000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'learn-author-test-')),repo=path.join(root,'repo');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(repo);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
  git('init','-q','-b','main');git('config','user.name','Tour fixture');git('config','user.email','fixture@example.invalid');
  await writeFile(path.join(repo,'runner.rb'),'def run\n  1\nend\n');
  git('add','runner.rb');git('commit','-qm','Runner');const base=git('rev-parse','HEAD');
  const source='LIMIT = 10\n\ndef cutoff\n  LIMIT\nend\n';
  await writeFile(path.join(repo,'schedule.rb'),source);
  git('add','schedule.rb');git('commit','-qm','Schedule');const head=git('rev-parse','HEAD');
  await writeFile(path.join(repo,'schedule.rb'),source.replace('10','99'));
  const [voice]=await installedVoices();
  assert(voice,'Windows SAPI voice unavailable');
  const shared=path.join(root,'Tours');
  const result=await authorTour({repoPath:repo,mode:'diff',base,head,instructions:'Focus on schedule.rb.',
    providerId:'codex',model:'gpt-6.1-sol',reasoning:'low',narrationVoice:voice},{
    directory:path.join(root,'jobs'),shared,runPlan:async input=>{
      assert.match(input.prompt,/Focus on schedule\.rb\./);
      assert.match(input.prompt,/1: LIMIT = 10/);
      assert.doesNotMatch(input.prompt,/LIMIT = 99/);
      return {status:'ready',text:JSON.stringify({title:'Schedule Tour',sections:[{title:'Schedule',steps:[
        {file:'schedule.rb',line:1,say:'Limit is ten. The value is constant.'},
        {file:'schedule.rb',line:3,say:'The cutoff method returns the limit.'},
        {file:'schedule.rb',line:99,say:'An invalid line.'},
      ]}]})};
    },
  });
  assert.equal(result.cues,2);assert.equal(result.dropped,1);
  const library=await createLibrary({directory:path.join(root,'learn'),shared,loadTour:loadFolderTour});
  const [entry]=await library.scan();
  const {tour}=await library.open(entry.id);
  assert.equal(tour.manifest.commitRange,base+'..'+head);
  assert.equal((await readTourCode(tour,'schedule.rb')).text,source);
  const {sentences,estimated}=await readTranscript(tour,0);
  assert.equal(estimated,false);assert.equal(sentences.length,3);
  assert.equal(sentences[0].end,sentences[1].start);
  assert.equal(sentences[2].start,tour.sections[0].cues[1].atSeconds);
  assert.equal(sentences[2].end,tour.sections[0].durationSecs);
});
