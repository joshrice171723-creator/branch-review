import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const slots=['original','changed','standby'];
const pattern=/^apply_review_(original|changed|standby)_([a-f0-9]{12})_development$/;

// Only inspect the app's explicitly named containers and databases; never remove a volume.
export function databaseCleanup({run,local,state,records,preparedFix,jobs}) {
  const docker=process.platform==='win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles,'Docker','Docker','resources','bin','docker.exe') : 'docker';
  async function caches() {
    const names=(await readdir(local)).filter(name=>/^preview-(original|changed|standby)-[a-f0-9]{40}-[a-f0-9]{64}\.json$/.test(name));
    return Promise.all(names.map(async name=>({name,data:JSON.parse(await readFile(path.join(local,name),'utf8'))})));
  }
  const protectedNames=()=>new Set([state.original,state.changed,state.previewVersion?.latestChanged,state.prepared,preparedFix()?.original,preparedFix()?.changed].filter(Boolean).map(x=>x.database).filter(Boolean));
  async function inventory() {
    try { await run(docker,['info','--format','{{.ID}}']); } catch(e) { throw Error('Docker is unavailable. Start Docker Desktop and try again. '+e.message); }
    const cache=await caches().catch(e=>{throw Error('A preview cache cannot be read; cleanup is disabled until it is inspected. '+e.message);});
    const existing=(await run(docker,['ps','-a','--format','{{.Names}}'])).split(/\r?\n/);
    const running=new Set((await run(docker,['ps','--format','{{.Names}}'])).split(/\r?\n/));
    const databases=[], unavailable=[], stopped=[];
    for(const slot of slots) {
      const container=`apply-review-${slot}`;
      if(!existing.includes(container))continue;
      if(!running.has(container)){ stopped.push(slot); continue; }
      let output;
      try { output=await run(docker,['exec',container,'psql','-X','-U','postgres','-d','postgres','-A','-t','-F','|','-c',"SELECT d.datname, pg_database_size(d.datname), (SELECT count(*) FROM pg_stat_activity a WHERE a.datname=d.datname) FROM pg_database d WHERE d.datname ~ '^apply_review_(original|changed|standby)_[a-f0-9]{12}_development$' ORDER BY d.datname"]); }
      catch(e){unavailable.push(`${container} could not be inspected: ${e.message}`);continue;}
      for(const line of output.split(/\r?\n/).filter(Boolean)) {
        const [name,bytes,connections]=line.split('|'), match=pattern.exec(name);
        if(!match || match[1]!==slot || !/^\d+$/.test(bytes) || !/^\d+$/.test(connections)) {unavailable.push(`${container} returned an unexpected database entry.`);continue;}
        const matching=cache.filter(c=>c.data.database===name && (c.data.runtime||c.data.side)===slot);
        const commits=[...new Set(matching.map(c=>c.data.sha).filter(s=>/^[a-f0-9]{40}$/.test(s)))];
        const reviews=records.filter(r=>[r.identity?.base,r.identity?.changed].some(sha=>commits.includes(sha) || (typeof sha==='string' && sha.startsWith(match[2])))).map(r=>({title:r.title,ref:r.identity.ref}));
        const reason=!matching.length?'No matching preview cache; ownership cannot be confirmed':protectedNames().has(name)?'Active or prepared preview':Number(connections)>0?'Database has active connections':jobs().some(j=>j.status==='running')?'A review job is running':'';
        databases.push({name,slot,bytes:Number(bytes),connections:Number(connections),commits,reviews,reason});
      }
    }
    return {databases,unavailable,stopped,cacheCount:cache.length};
  }
  async function remove(names, confirmation) {
    if(!Array.isArray(names)||!names.length||names.length>100||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!pattern.test(name)))throw Error('Select valid, unique preview databases.');
    if(confirmation!==`DELETE ${names.length}`)throw Error('Confirm the exact selection.');
    if(jobs().some(j=>j.status==='running'))throw Error('Wait for the review job to finish.');
    const snapshot=await inventory();
    if(snapshot.unavailable.length || snapshot.stopped.length)throw Error('Resolve unavailable preview containers before cleanup.');
    const rows=names.map(name=>snapshot.databases.find(row=>row.name===name));
    if(rows.some(row=>!row || row.reason))throw Error('A selected database is missing or protected. Refresh the list.');
    const cache=await caches();
    // Invalidate first: a failed drop may cause a rebuild, but never reuse a deleted database.
    for(const item of cache)if(names.includes(item.data.database))await unlink(path.join(local,item.name));
    const deleted=[];
    for(const row of rows) {
      try { await run(docker,['exec',`apply-review-${row.slot}`,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-c',`DROP DATABASE "${row.name}"`]);deleted.push(row.name); }
      catch(e){throw Error(`Deleted: ${deleted.join(', ') || 'none'}. Could not delete ${row.name}: ${e.message}`);}
    }
    return {deleted};
  }
  async function start(slot) {
    if(!slots.includes(slot))throw Error('Choose an existing preview slot.');
    if(jobs().some(j=>j.status==='running'))throw Error('Wait for the review job to finish.');
    const container=`apply-review-${slot}`;
    const all=(await run(docker,['ps','-a','--format','{{.Names}}'])).split(/\r?\n/);
    if(!all.includes(container))throw Error('Preview container no longer exists. Refresh the list.');
    await run(docker,['start',container]);
  }
  return {inventory,remove,start};
}
