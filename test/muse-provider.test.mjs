import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {museUsage,museArgs,consumeMuseEvent,museBillingMessage} from '../muse-provider.mjs';
import {providerId,executable} from '../providers.mjs';
const fixture=async name=>readFile(new URL('./fixtures/muse/'+name,import.meta.url),'utf8');
test('Muse never infers readiness from signed-out, no-allowance, or ambiguous usage',async()=>{
  assert.equal(museUsage(await fixture('signed-out.txt')).status,'sign-in');
  assert.equal(museUsage(await fixture('no-allowance.json')).status,'no-allowance');
  for(const text of ['', '{}','{"schemaVersion":1,"allowance":{}}'])assert.equal(museUsage(text).status,'unverified');
  assert.equal(museUsage('{}','NOT LOGGED IN').status,'sign-in');
});
test('captured Muse status and billing terminal events preserve failure',async()=>{
  const events=JSON.parse(await fixture('billing-events.json')),job={provider:'muse'};
  consumeMuseEvent(job,events[0]);assert.equal(job.agentStatus,'failed meta model stream attempt 1/10');
  consumeMuseEvent(job,events[1]);assert.equal(job.agentTerminal,'failed');assert.equal(job.providerStatus,'no-allowance');assert.equal(job.agentError,museBillingMessage);assert.equal(job.agentResult,undefined);
});
test('synthetic success requires the completed terminal event; unknown events remain visible',()=>{
  const job={};consumeMuseEvent(job,{schema_version:1,payload_type:'run.lifecycle.started',payload:{}});assert.equal(job.agentTerminal,undefined);
  consumeMuseEvent(job,{schema_version:1,payload_type:'run.terminal.completed',payload:{terminal:'completed',text:'Done'}});assert.equal(job.agentResult,'Done');
  consumeMuseEvent(job,{schema_version:1,payload_type:'new.event',payload:{}});assert.equal(job.agentStatus,'new.event');
});
test('Muse uses native executable discovery and file prompts with restricted tools',async()=>{
  assert.equal(providerId('muse'),'muse');await assert.rejects(executable('muse',undefined,{PATH:''}),/not found/);
  const args=museArgs({kind:'plan',cwd:'/repo',output:'/output',chatId:'session',images:['/image']});
  assert.deepEqual(args.slice(0,2),['exec','--json']);assert.ok(args.includes('--disable-write'));assert.ok(args.includes('--disable-shell'));assert.ok(args.includes('/output.prompt.txt'));assert.ok(args.includes('--session-id'));assert.ok(!args.includes('--disable-sandbox'));
});
