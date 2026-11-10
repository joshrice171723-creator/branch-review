import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseTutorAnswer,runLearnPlan,tutorPrompt} from '../learn-tutor.mjs';

test('tutor context uses real line numbers and a bounded excerpt',()=>{
  const text=Array.from({length:400},(_,i)=>'line '+i+' '+'a'.repeat(200)).join('\n');
  const prompt=tutorPrompt({title:'Reminders',note:'Due batches',file:'runner.rb',line:200,text,question:'What happens first?'});
  assert.match(prompt,/Source excerpt \(lines 50-350/);
  assert.match(prompt,/200: line 199/);
  assert.doesNotMatch(prompt,/400: line/);
  const followUp=tutorPrompt({file:'runner.rb',line:200,text,question:'Why?',followUp:true});
  assert.match(followUp,/source already provided in this session/);
  assert.match(followUp,/Joshua's question: Why\?/);
  assert.doesNotMatch(followUp,/200: line 199/);
  assert.deepEqual(parseTutorAnswer('DISPLAY: First calculate due batches.\nSAY: First calculate due batches.'),{
    display:'First calculate due batches.',say:'First calculate due batches.',
  });
});

test('existing Muse PLAN protocol returns display, preserves session and surfaces plan allowance',async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'learn-tutor-test-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const workspace=path.join(temp,'repo'),fixture=path.join(temp,'fixture.cjs'),directory=path.join(temp,'learn');
  await mkdir(workspace);
  await writeFile(fixture,`
const assert=require('node:assert/strict');
const fs=require('node:fs');
const args=process.argv.slice(2);
assert(args.includes('--disable-write') && args.includes('--disable-shell') && args.includes('--disable-web-tools'));
const prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');
const session=args.indexOf('--session-id');
if(prompt==='follow-up')assert.equal(args[session+1],'session-1');
console.log(JSON.stringify({schema_version:1,stream:{kind:'session',id:'session-1'},payload_type:'run.started'}));
const denied=prompt==='limit';
console.log(JSON.stringify({schema_version:1,payload_type:'run.terminal.'+(denied?'failed':'completed'),
payload:denied?{reason:'billing_error'}:{terminal:'completed',text:'DISPLAY: Grounded.\\nSAY: Grounded.'}}));
  `);
  const options={provider:'muse',override:fixture,cwd:workspace,directory};
  const first=await runLearnPlan({...options,prompt:'first'});
  assert.equal(first.chatId,'session-1');
  assert.equal(parseTutorAnswer(first.text).display,'Grounded.');
  assert.equal((await runLearnPlan({...options,prompt:'follow-up',chatId:first.chatId})).status,'ready');
  assert.equal((await runLearnPlan({...options,prompt:'limit'})).status,'no-allowance');
});
