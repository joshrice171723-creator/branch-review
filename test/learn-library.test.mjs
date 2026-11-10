import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,rename,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibrary,writeTourZip} from '../learn-library.mjs';
import {loadFolderTour,readTourCode} from '../learn-player.mjs';

test('shared snapshot ZIP survives library restart, relocation, rename and removal',{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'learn-library-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const snapshot=path.join(root,'snapshot'),shared=path.join(root,'Tours');
  const audio=path.join(snapshot,'audio'),code=path.join(snapshot,'code');
  for(const dir of [shared,audio,code])await mkdir(dir,{recursive:true});
  await writeFile(path.join(snapshot,'manifest.json'),JSON.stringify({
    format:1,title:'Tour snapshot',createdBy:'Branch Review Tour Maker',repo:'fixture',branch:'main',
    commitRange:null,createdAt:new Date().toISOString(),
  }));
  await writeFile(path.join(code,'demo.rb'),'def demo\nend\n');
  await writeFile(path.join(audio,'section.wav'),'fixture');
  await writeFile(path.join(snapshot,'cues.json'),JSON.stringify({sections:[1,2].map(index=>({
    audio:'section.wav',title:'Section '+index,durationSecs:120,
    cues:[{atSeconds:0,file:'demo.rb',line:1,note:'Method'}],
  }))}));
  const zip=path.join(shared,'sample.tour.zip');
  await writeTourZip(snapshot,zip);
  const options={directory:path.join(root,'learn-data'),shared,loadTour:loadFolderTour};
  let library=await createLibrary(options);
  const [entry]=await library.scan();
  assert.equal(entry.title,'Tour snapshot');
  assert.equal(entry.sectionCount,2);
  const {tour}=await library.open(entry.id);
  assert.equal((await readTourCode(tour,'demo.rb')).text,'def demo\nend\n');
  await library.progress(entry.id,{sectionIndex:1,seconds:60,completedSection:0,listened:4.1});
  await library.patch(entry.id,{flags:{'1:0':true},notes:{'1:0':'Review the method.'}});
  library=await createLibrary(options);
  const [resumed]=await library.list();
  assert.deepEqual(resumed.position,{sectionIndex:1,seconds:60});
  assert.equal(resumed.percent,75);
  assert.equal(resumed.secondsListened,4.1);
  assert.deepEqual(resumed.flags,{'1:0':true});
  assert.deepEqual(resumed.notes,{'1:0':'Review the method.'});
  const moved=path.join(root,'moved.tour.zip');
  await rename(zip,moved);
  assert.equal((await library.list())[0].state,'missing');
  assert.equal((await library.relocate(entry.id,{source:moved})).percent,75);
  assert.equal((await library.rename(entry.id,'Renamed')).title,'Renamed');
  assert.equal((await library.progress(entry.id,{sectionIndex:1,seconds:120,completedSection:1,finished:true})).percent,100);
  await library.remove(entry.id);
  assert.equal((await library.list()).length,0);
  await access(moved);
});
