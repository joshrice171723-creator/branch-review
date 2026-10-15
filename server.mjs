import http from 'node:http';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { branches, comparison, git, run, root, local, repo, previewRoot, toolchain, slots, state, startReview, stopReview, restoreReview, prepare } from './adapter.mjs';
import { previewProxy } from './proxy.mjs';
import { ReviewStore, scenarioRecipe, digest } from './reviews.mjs';
import { loadPlan } from './plans.mjs';
import { Delivery } from './delivery.mjs';
import { publish, target } from './publish.mjs';
import { changedFiles, fileDiff, commitHistory } from './changes.mjs';
import { reviewReport } from './report.mjs';
import { previewHealth } from './health.mjs';

const port = 4310, origin = `http://127.0.0.1:${port}`, token = randomBytes(32).toString('hex');
let busy = false;
const store = await new ReviewStore(local).load();
const delivery = new Delivery(git, store);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
async function manifestFor(sha) {
  return loadPlan(git,sha,state.comparison.files);
}
async function activate() {
  if (state.status !== 'ready') return;
  const manifest = await manifestFor(state.changed.sha);
  const record = await store.open({...state, repository:repo}, manifest, digest(await readFile(path.join(root,scenarioRecipe(state.comparison.files)),'utf8')));
  state.recordId = record.id; state.manifest = manifest;
  if (state.integration?.sha === state.changed.sha) { record.integration = state.integration; await store.persist(); }
  await writeFile(path.join(local,'review.json'),JSON.stringify({comparison:state.comparison,original:state.original,changed:state.changed,integration:state.integration},null,2));
}
async function active(id, checkFresh = false) {
  if (state.status !== 'ready' || id !== state.recordId) throw new Error('Open this exact review before changing its results.');
  const record = store.get(id);
  if (checkFresh) {
    await delivery.refs(record);
    for (const side of ['original','changed']) {
      const cwd = path.join(previewRoot,side);
      if (await run('git',['rev-parse','HEAD'],{cwd}) !== state[side].sha || await run('git',['status','--porcelain'],{cwd})) throw new Error('Preview source changed. Reopen the exact committed version before approval.');
      const ready = await fetch(`http://127.0.0.1:${state[side].api}/up`,{signal:AbortSignal.timeout(3000)});
      if (!ready.ok) throw new Error('A preview is not running.');
    }
  }
  return record;
}
function json(res,status,data) { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
async function body(req) { let buffer=''; for await(const chunk of req) { buffer += chunk; if(Buffer.byteLength(buffer)>7_000_000) throw new Error('Request too large'); } return JSON.parse(buffer || '{}'); }
async function mutate(endpoint, data) {
  if (endpoint === '/api/start') { state.integration = null; await startReview(data.ref,data.baseline,data.baselineCommit); await activate(); return; }
  if (endpoint === '/api/stop') return stopReview();
  if (endpoint === '/api/fetch') return git('fetch','origin');
  if (endpoint === '/api/retest') { const prior=store.get(data.id); state.integration=null; await startReview(prior.identity.ref,prior.comparisonMode?.baseline || 'parent',prior.comparisonMode?.baselineCommit); await activate(); return; }
  if (endpoint === '/api/release-settings') {
    if (typeof data.keyPath !== 'string' || typeof data.recoveryDirectory !== 'string' || !path.isAbsolute(data.keyPath) || !path.isAbsolute(data.recoveryDirectory)) throw new Error('Choose an existing key and recovery folder.');
    await access(data.keyPath); await access(data.recoveryDirectory); await writeFile(path.join(local,'release.json'),JSON.stringify({keyPath:data.keyPath,recoveryDirectory:data.recoveryDirectory})); return;
  }
  const record = await active(data.id, ['/api/approve','/api/ship','/api/publish','/api/candidate'].includes(endpoint));
  if (endpoint === '/api/check') return store.check(record.id,data.scenario,data.index,data.passed);
  if (endpoint === '/api/item') return store.item(record.id,data.itemId,data);
  if (endpoint === '/api/cursor') return store.cursor(record.id,data.itemId,data.view);
  if (endpoint === '/api/issue') return store.issue(record.id,data);
  if (endpoint === '/api/resolve') return store.resolve(record.id,data.issueId,data.note);
  if (endpoint === '/api/approve') return store.approve(record.id,data.reviewer);
  if (endpoint === '/api/candidate') {
    const candidate = await delivery.candidate(record);
    if (state.changed.sha === candidate.sha && state.original.sha === candidate.main) { state.integration=candidate; await activate(); return; }
    state.status='preparing'; state.integration=candidate;
    state.original = await prepare('original',candidate.main);
    state.changed = await prepare('changed',candidate.sha);
    state.status='ready'; state.comparison={...state.comparison,base:candidate.main,main:candidate.main};
    await activate(); return;
  }
  if (endpoint === '/api/ship') {
    if (data.confirmation !== `MERGE ${record.identity.changed} TO origin/main`) throw new Error('Confirm the exact commit before merge and push.');
    return delivery.push(record,record.identity.changed);
  }
  if (endpoint === '/api/publish') return publish(record,{local,repo,run,git,store,toolchain,confirmation:data.confirmation});
  if (endpoint === '/api/retry-publish') {
    if (record.delivery?.stage !== 'deployment-needs-inspection' || typeof data.note !== 'string' || data.note.trim().length < 10) throw new Error('Record your inspection of the failed release and recovery artifacts before enabling a retry.');
    record.delivery.stage='pushed'; return store.event(record,'release-retry-enabled',{note:data.note.slice(0,2000)});
  }
  if (endpoint === '/api/smoke') {
    if (record.delivery?.stage !== 'published' || typeof data.note !== 'string' || data.note.trim().length < 10) throw new Error('Record the published workflow result.');
    const response=await fetch(target+'/build.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok || (await response.json()).revision !== record.identity.changed) throw new Error('The published revision changed. Verify the intended build.');
    record.delivery.stage='verified'; return store.event(record,'published-workflow-verified',{note:data.note.slice(0,2000),commit:record.identity.changed});
  }
  throw new Error('Unknown review action.');
}
const actions=new Set(['/api/start','/api/stop','/api/fetch','/api/retest','/api/release-settings','/api/check','/api/item','/api/cursor','/api/issue','/api/resolve','/api/approve','/api/candidate','/api/ship','/api/publish','/api/smoke','/api/retry-publish']);
const longActions=new Set(['/api/start','/api/stop','/api/fetch','/api/retest','/api/candidate','/api/ship','/api/publish']);
const server=http.createServer(async(req,res)=>{
  try {
    if(req.headers.host!==`127.0.0.1:${port}`) return json(res,403,{error:'Invalid host'});
    const url=new URL(req.url,origin);
    if(req.method==='GET' && url.pathname==='/api/state') return json(res,200,{...state,busy,token,repository:repo,record:state.recordId?store.get(state.recordId):null,publishTarget:target,releaseConfigured:await access(path.join(local,'release.json')).then(()=>true,()=>false)});
    if(req.method==='GET' && url.pathname==='/api/branches') return json(res,200,await branches());
    if(req.method==='GET' && url.pathname==='/api/history') return json(res,200,store.summary());
    if(req.method==='GET' && url.pathname==='/api/health')return json(res,200,await previewHealth({...state}));
    if(req.method==='GET' && url.pathname==='/api/report'){
      const record=store.get(url.searchParams.get('id')),html=await reviewReport(record,local);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Disposition':`${url.searchParams.get('inline')==='1'?'inline':'attachment'}; filename="branch-review-${record.identity.changed.slice(0,7)}.html"`,'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'"});return res.end(html);
    }
    if(req.method==='GET' && url.pathname==='/api/comparison') return json(res,200,await comparison(url.searchParams.get('ref'),url.searchParams.get('baseline'),url.searchParams.get('commit')));
    if(req.method==='GET' && url.pathname==='/api/commits')return json(res,200,await commitHistory(git,url.searchParams.get('sha')));
    if(req.method==='GET' && url.pathname==='/api/changes')return json(res,200,await changedFiles(git,url.searchParams.get('base'),url.searchParams.get('changed')));
    if(req.method==='GET' && url.pathname==='/api/diff')return json(res,200,await fileDiff(git,url.searchParams.get('base'),url.searchParams.get('changed'),url.searchParams.get('file')));
    if(req.method==='GET' && /^\/screenshots\/[a-f0-9-]{36}\.png$/.test(url.pathname)) { const image=await readFile(path.join(local,url.pathname.slice(1)));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"}); return res.end(image); }
    if(req.method==='POST' && actions.has(url.pathname)) {
      if(req.headers.origin!==origin || req.headers['x-review-token']!==token) return json(res,403,{error:'Reload Branch Review before continuing.'});
      if(busy) return json(res,409,{error:'Another operation is still running.'});
      busy=true;
      let data; try { data=await body(req); } catch(error) { busy=false; throw error; }
      state.error=null;
      const operation=async()=>{try {return await mutate(url.pathname,data);}catch(error){state.error=error.message;if(state.status==='preparing'||state.status==='stopping') state.status='error';throw error;}finally{busy=false;}};
      if(longActions.has(url.pathname)){ operation().catch(()=>{}); return json(res,202,{accepted:true}); }
      return json(res,200,{result:await operation()});
    }
    if(req.method!=='GET'||!['/','/app.js','/workflow.js','/guided.js','/review-model.js','/drafts.js','/shortcuts.js','/preview-routes.js','/style.css'].includes(url.pathname))return json(res,404,{error:'Not found'});
    const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
    res.writeHead(200,{'Content-Type':types[path.extname(filename)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self' http://127.0.0.1:4311 http://127.0.0.1:4312; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"});
    res.end(await readFile(path.join(root,'public',filename)));
  }catch(error){if(!res.headersSent)json(res,400,{error:error.message});else res.end();}
});
await restoreReview(); await activate();
for(const [side,slot] of Object.entries(slots)) { const proxy=previewProxy(side,slot,()=>state,origin);proxy.on('error',error=>{console.error(error.message);process.exit(1);});proxy.listen(slot.proxy,'127.0.0.1'); }
server.on('error',error=>{console.error(error.message);process.exit(1);});
server.listen(port,'127.0.0.1',()=>console.log(`Branch Review: ${origin}`));
