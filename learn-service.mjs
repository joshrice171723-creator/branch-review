import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {loadFolderTour,readTourCode,sendTourAudio,jumpToRubyMine} from './learn-player.mjs';
import {createLibrary} from './learn-library.mjs';

const assets = new Map([
  ['/learn.html','text/html'], ['/learn-player.js','text/javascript'], ['/learn-library.js','text/javascript'], ['/learn.css','text/css'],
]);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

function json(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64*1024) throw Error('Learn request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export async function createLearnHandler({origin,root,directory,shared=process.env.BRANCH_REVIEW_TOURS_DIR || path.join(os.homedir(),'Documents','Tours')}) {
  await mkdir(directory,{recursive:true});
  const settingsFile = path.join(directory,'settings.json');
  let settings = JSON.parse(await readFile(settingsFile,'utf8').catch(error=>{
    if(error.code==='ENOENT')return '{}';
    throw error;
  }));
  let writes = Promise.resolve();
  function save(change) {
    const work = writes.catch(()=>{}).then(async()=>{
      const next = {...settings,...change};
      await writeFile(settingsFile+'.tmp',JSON.stringify(next,null,2));
      await rename(settingsFile+'.tmp',settingsFile);
      settings = next;
    });
    writes = work;
    return work;
  }
  const token = randomBytes(32).toString('hex');
  const tours = new Map();
  const library = await createLibrary({directory,shared,loadTour:loadFolderTour});

  function view(entry,tour) {
    const {id,position}=entry;
    return {
      id,title:entry.title,tourFolder:entry.source,repoFolder:entry.codeRoot,warnings:tour.warnings,
      position:position?{section:position.sectionIndex,seconds:position.seconds}:null,
      sections:tour.sections.map(({title,durationSecs,cues},section)=>({
        title,durationSecs,cues,audioUrl:`/api/learn/audio?id=${id}&section=${section}`,
      })),
    };
  }
  function requireTour(id) {
    const tour = tours.get(id);
    if (!tour) throw Error('Open this tour again.');
    return tour;
  }
  async function open(id){
    const {entry,tour}=await library.open(id);
    tours.set(entry.id,tour);
    return view(entry,tour);
  }
  return async function handleLearn(req,res,url) {
    const endpoint = url.pathname;
    if (!assets.has(endpoint) && !endpoint.startsWith('/api/learn/')) return false;
    if(req.headers.host!==new URL(origin).host || ['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) {
      json(res,403,{error:'Learn accepts local requests only.'});
      return true;
    }
    try {
      if(req.method==='GET' && assets.has(endpoint)) {
        const page = await readFile(path.join(root,'public',endpoint.slice(1)));
        res.writeHead(200,{'Content-Type':assets.get(endpoint)+'; charset=utf-8','Content-Security-Policy':csp,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        res.end(page);
      } else if(req.method==='GET' && endpoint==='/api/learn/bootstrap') {
        json(res,200,{rubyMine:settings.rubyMine,speed:settings.speed,volume:settings.volume,token});
      } else if(req.method==='GET' && endpoint==='/api/learn/library') {
        json(res,200,await library.list());
      } else if(['GET','HEAD'].includes(req.method) && endpoint==='/api/learn/audio') {
        await sendTourAudio(req,res,requireTour(url.searchParams.get('id')),Number(url.searchParams.get('section')));
      } else if(req.method==='GET' && endpoint==='/api/learn/code') {
        json(res,200,await readTourCode(requireTour(url.searchParams.get('id')),url.searchParams.get('file')));
      } else if(req.method==='POST') {
        if(req.headers.origin!==origin || req.headers['x-learn-token']!==token) {
          json(res,403,{error:'Reload Learn before continuing.'});return true;
        }
        const data = await body(req);
        if(endpoint==='/api/learn/open') {
          const input={source:data.tourFolder,codeRoot:data.repoFolder || null};
          const entry=data.id?await library.relocate(data.id,input):await library.add(input);
          json(res,200,await open(entry.id));
        } else if(endpoint==='/api/learn/library/open') {
          json(res,200,await open(data.id));
        } else if(endpoint==='/api/learn/library') {
          await library.scan();json(res,200,await library.list());
        } else if(endpoint==='/api/learn/library/rename') {
          json(res,200,await library.rename(data.id,data.title));
        } else if(endpoint==='/api/learn/library/remove') {
          await library.remove(data.id);tours.delete(data.id);json(res,200,{ok:true});
        } else if(endpoint==='/api/learn/library/reset') {
          await library.reset(data.id);json(res,200,{ok:true});
        } else if(endpoint==='/api/learn/preferences') {
          const change={};
          if(typeof data.rubyMine==='boolean') change.rubyMine=data.rubyMine;
          if([0.75,1,1.25,1.5,2].includes(data.speed)) change.speed=data.speed;
          if(Number.isFinite(data.volume) && data.volume>=0 && data.volume<=1) change.volume=data.volume;
          await save(change);
          json(res,200,{ok:true});
        } else if(endpoint==='/api/learn/position') {
          const tour=requireTour(data.id), position=data.position;
          if(!Number.isInteger(position?.section) || !tour.sections[position.section] ||
             !Number.isFinite(position.seconds) || position.seconds<0) throw Error('Invalid playback position.');
          const completedSection=data.completed===true?position.section:undefined;
          await library.progress(data.id,{sectionIndex:position.section,seconds:position.seconds,completedSection,
            finished:data.completed===true && position.section===tour.sections.length-1});
          json(res,200,{ok:true});
        } else if(endpoint==='/api/learn/jump') {
          if(settings.rubyMine===true) await jumpToRubyMine(requireTour(data.id),data.section,data.cue);
          json(res,200,{ok:true});
        } else json(res,404,{error:'Learn route not found.'});
      } else json(res,404,{error:'Learn route not found.'});
    } catch(error) {
      if(res.headersSent) res.destroy();
      else json(res,400,{error:error.message});
    }
    return true;
  };
}

// First-run Learn can open before a review project or coding agent is configured.
export async function startLearnOnly(options) {
  const handle=await createLearnHandler(options);
  const server=createServer(async(req,res)=>{
    if(!await handle(req,res,new URL(req.url,options.origin))) json(res,404,{error:'Not found'});
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(Number(new URL(options.origin).port),'127.0.0.1',resolve);
  });
  return ()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
