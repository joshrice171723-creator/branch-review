import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const launch = new URL('data:text/javascript,' + encodeURIComponent(`
  import { parentPort, workerData } from 'node:worker_threads';
  const {slots} = await import(workerData.adapter);
  Object.values(slots).forEach((slot,index)=>{slot.proxy = workerData.occupied[index+1];});
  const {startServer} = await import(workerData.server);
  const {origin,port,beginDesktopExit} = await startServer({allowPortFallback:true,preferredPort:workerData.occupied[0],desktop:true});
  let resume;
  parentPort.on('message', command => {
    if (command === 'suspend') resume = beginDesktopExit();
    if (command === 'resume') resume();
    parentPort.postMessage(command);
  });
  parentPort.postMessage({origin,port,previewPorts:Object.values(slots).map(slot=>slot.proxy)});
`));
const originFor = port => `http://127.0.0.1:${port}`;

test('packaged mode binds available loopback ports and keeps an explicit controller port fixed', {timeout:30000}, async t => {
  const home = await mkdtemp(path.join(tmpdir(),'branch-review-startup-'));
  const foreign = [];
  const workers = [];
  t.after(async()=>{
    await Promise.all(workers.map(worker=>worker.terminate()));
    for (const server of foreign) server.close();
    await rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:150});
  });
  for (let index=0; index<4; index++) {
    const server = http.createServer((_req,res)=>res.end('Existing listener'));
    foreign.push(server);
    await once(server.listen(0,'127.0.0.1'),'listening');
  }
  const occupied = foreign.map(server=>server.address().port);
  function launchWorker(port) {
    const worker = new Worker(launch,{
      env:{...process.env,BRANCH_REVIEW_HOME:home,BRANCH_REVIEW_DESKTOP_REPOSITORY:home,BRANCH_REVIEW_PORT:port,APEX_WORKBENCH_URL:''},
      workerData:{occupied,adapter:new URL('../adapter.mjs',import.meta.url).href,server:new URL('../server.mjs',import.meta.url).href},
    });
    workers.push(worker);
    return once(worker,'message');
  }

  const jobsPath = path.join(home,'jobs.json');
  const savedJobs = '[{"status":"running"}]';
  await writeFile(jobsPath,savedJobs);
  await assert.rejects(launchWorker(String(occupied[0])),/EADDRINUSE|EACCES/);
  assert.equal(await readFile(jobsPath,'utf8'),savedJobs);

  const [{origin,port,previewPorts}] = await launchWorker('');
  const active = [port,...previewPorts];
  assert.equal(new Set(active).size,4);
  assert.ok(active.every(value=>!occupied.includes(value)));
  const shell = await fetch(origin);
  assert.equal(shell.status,200);
  const frames = shell.headers.get('content-security-policy').match(/frame-src ([^;]+);/)[1];
  assert.deepEqual(frames.split(' '),["'self'",...previewPorts.map(originFor),'http://127.0.0.1:*','http://localhost:*','https:']);
  await shell.text();
  const state = await fetch(origin+'/api/state').then(response=>response.json());
  assert.equal(state.repository,home);
  const worker = workers.at(-1);
  const request = async command => {
    const reply = once(worker,'message');
    worker.postMessage(command);
    assert.deepEqual(await reply,[command]);
  };
  const openWorkbench = () => fetch(origin+'/api/workbench-open',{method:'POST',
    headers:{Origin:origin,'X-Review-Token':state.token}});
  await request('suspend');
  const blocked = await openWorkbench();
  assert.equal(blocked.status,409);
  assert.match((await blocked.json()).error,/closing or switching projects/);
  await request('resume');
  const opened = await openWorkbench();
  assert.equal(opened.status,200);
  await opened.json();
  const settings = await fetch(origin+'/api/project-settings', {method:'POST',
    headers:{Origin:origin,'X-Review-Token':state.token,'Content-Type':'application/json'},
    body:JSON.stringify({directory:'.',start:['node','server.mjs']})});
  assert.equal(settings.status,200,await settings.clone().text());
  assert.deepEqual((await settings.json()).result.start,['node','server.mjs']);
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'project-settings.json'),'utf8')).start,['node','server.mjs']);
  const handoff = await fetch(origin+'/api/workbench-export',{
    method:'POST',headers:{Origin:origin,'X-Review-Token':state.token,'Content-Type':'application/json'},
    body:JSON.stringify({runId:'invalid'})
  });
  assert.equal(handoff.status,400);
  assert.deepEqual(await handoff.json(),{error:'Choose a completed Workbench run.'});
  for (const previewPort of previewPorts) {
    const preview = await fetch(originFor(previewPort));
    assert.equal(preview.status,503);
    assert.match(await preview.text(),/Preview is not ready/);
  }
  for (const port of occupied) {
    assert.equal(await fetch(originFor(port)).then(response=>response.text()),'Existing listener');
  }
});
