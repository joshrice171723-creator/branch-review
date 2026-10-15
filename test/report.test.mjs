import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {reviewReport} from '../report.mjs';
import {defaultManifest} from '../reviews.mjs';

test('portable report includes exact review evidence and screenshots without executing note content',async()=>{
  await mkdir('.local',{recursive:true});const directory=await mkdtemp('.local/report-test-');await mkdir(path.join(directory,'screenshots'));
  const filename='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png';await writeFile(path.join(directory,'screenshots',filename),Buffer.from('89504e470d0a1a0a','hex'));
  const record={id:'review',title:'<script>unsafe</script>',identity:{repository:'test',ref:'refs/heads/test',base:'aaa',changed:'bbb'},manifest:defaultManifest,checks:{'intake:0':true},items:{intake:{notes:'<img src=x onerror=alert(1)>'}},issues:[{id:'finding',scenario:'intake',side:'changed',status:'resolved',commit:'bbb',actual:'Broken',expected:'Works',screenshot:filename,resolution:'Retested'}],events:[],updatedAt:'2026-10-15'};
  const html=await reviewReport(record,directory);
  assert.match(html,/Original: aaa/);assert.match(html,/Changed: bbb/);assert.match(html,/data:image\/png;base64,/);assert.match(html,/Retested/);
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html,/Not approved/);assert.match(html,/1 unfinished/);
});
