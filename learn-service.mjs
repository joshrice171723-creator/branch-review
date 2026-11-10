import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {loadFolderTour,readTourCode,sendTourAudio,jumpToRubyMine} from './learn-player.mjs';
import {createLibrary} from './learn-library.mjs';
import {parseTutorAnswer,runLearnPlan,tutorPrompt} from './learn-tutor.mjs';
import {readTranscript} from './learn-transcript.mjs';
import {createExercises} from './learn-exercise.mjs';

const assets = new Map([
  ['/learn.html','text/html'], ['/learn-player.js','text/javascript'], ['/learn-library.js','text/javascript'], ['/learn-tutor.js','text/javascript'], ['/learn.css','text/css'],
  ['/learn-transcript.js','text/javascript'],
  ['/learn-practice.js','text/javascript'], ['/learn-exercise.js','text/javascript'],
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
  const exercises=createExercises({
    protectedRoots:[path.join(os.homedir(),'appointment-flow'),path.join(os.homedir(),'Desktop','DefenseLoop')],
    onDone:(id,key,result)=>{
      tours.get(id)?.cache.delete(result.file);
      return library.patch(id,{exercises:{...library.get(id).exercises,[key]:result}});
    },
  });
  let tutorJob;
  async function agentSettings(){
    const home=process.env.BRANCH_REVIEW_HOME;
    return home?JSON.parse(await readFile(path.join(home,'agent-settings.json'),'utf8').catch(()=> '{}')):{};
  }

  function view(entry,tour) {
    const {id,position}=entry;
    return {
      id,title:entry.title,tourFolder:entry.source,repoFolder:entry.codeRoot,warnings:tour.warnings,
      flags:entry.flags,notes:entry.notes,exercises:entry.exercises,
      position:position?{section:position.sectionIndex,seconds:position.seconds}:null,
      sections:tour.sections.map(({title,durationSecs,cues},section)=>({
        title,durationSecs,cues:cues.map((cue,index)=>({...cue,exercise:exercises.describe(tour,entry,section,index)})),
        audioUrl:`/api/learn/audio?id=${id}&section=${section}`,
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
        const {rubyMine,speed,volume,tutorVoice,tutorRate,tutorAutoSpeak}=settings;
        json(res,200,{rubyMine,speed,volume,tutorVoice,tutorRate,tutorAutoSpeak,token});
      } else if(req.method==='GET' && endpoint==='/api/learn/library') {
        json(res,200,await library.list());
      } else if(['GET','HEAD'].includes(req.method) && endpoint==='/api/learn/audio') {
        await sendTourAudio(req,res,requireTour(url.searchParams.get('id')),Number(url.searchParams.get('section')));
      } else if(req.method==='GET' && endpoint==='/api/learn/code') {
        json(res,200,await readTourCode(requireTour(url.searchParams.get('id')),url.searchParams.get('file')));
      } else if(req.method==='GET' && endpoint==='/api/learn/transcript') {
        const tour=requireTour(url.searchParams.get('id')),section=Number(url.searchParams.get('section'));
        if(!Number.isInteger(section) || !tour.sections[section])throw Error('Choose an available section.');
        json(res,200,await readTranscript(tour,section,path.join(directory,'transcripts')));
      } else if(req.method==='GET' && endpoint==='/api/learn/exercise') {
        const id=url.searchParams.get('id'),entry=library.get(id);
        json(res,200,exercises.status(id) || entry.exercises?.[url.searchParams.get('key')] || null);
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
          if(typeof data.tutorVoice==='string' && data.tutorVoice.length<256)change.tutorVoice=data.tutorVoice;
          if(Number.isFinite(data.tutorRate) && data.tutorRate>=0.9 && data.tutorRate<=1.2)change.tutorRate=data.tutorRate;
          if(typeof data.tutorAutoSpeak==='boolean')change.tutorAutoSpeak=data.tutorAutoSpeak;
          await save(change);
          json(res,200,{ok:true});
        } else if(endpoint==='/api/learn/position') {
          const tour=requireTour(data.id), position=data.position;
          if(!Number.isInteger(position?.section) || !tour.sections[position.section] ||
             !Number.isFinite(position.seconds) || position.seconds<0) throw Error('Invalid playback position.');
          const completedSection=data.completed===true?position.section:undefined;
          const entry=await library.progress(data.id,{sectionIndex:position.section,seconds:position.seconds,completedSection,
            listened:Number.isFinite(data.listened)?Math.max(0,Math.min(20,data.listened)):0,
            finished:data.completed===true && position.section===tour.sections.length-1});
          json(res,200,{secondsListened:entry.secondsListened,completedSections:entry.completedSections.length,flags:Object.keys(entry.flags).length});
        } else if(['/api/learn/practice/flag','/api/learn/practice/note'].includes(endpoint)){
          const tour=requireTour(data.id),entry=library.get(data.id);
          if(!Number.isInteger(data.section)||!Number.isInteger(data.cue)||!tour.sections[data.section]?.cues[data.cue])
            throw Error('Choose an available cue.');
          const key=data.section+':'+data.cue;
          if(endpoint.endsWith('/flag')){
            if(typeof data.flag!=='boolean')throw Error('Choose whether this cue is flagged.');
            if(data.flag)entry.flags[key]=true;else delete entry.flags[key];
            await library.patch(data.id,{flags:entry.flags});
          }else{
            if(typeof data.note!=='string'||data.note.length>4000)throw Error('Enter a note under 4,000 characters.');
            if(data.note.trim())entry.notes[key]=data.note;else delete entry.notes[key];
            await library.patch(data.id,{notes:entry.notes});
          }
          json(res,200,{ok:true});
        } else if(endpoint==='/api/learn/exercise/start') {
          json(res,200,await exercises.start(requireTour(data.id),library.get(data.id),data.section,data.cue,data.confirmed));
        } else if(endpoint==='/api/learn/exercise/undo') {
          const result=await exercises.undo(data.id,data.confirmed);
          const entry=library.get(data.id);
          await library.patch(data.id,{exercises:{...entry.exercises,[result.key]:result}});
          requireTour(data.id).cache.clear();
          json(res,200,result);
        } else if(endpoint==='/api/learn/jump') {
          if(settings.rubyMine===true) await jumpToRubyMine(requireTour(data.id),data.section,data.cue);
          json(res,200,{ok:true});
        } else if(endpoint==='/api/learn/tutor') {
          if(tutorJob)throw Error('A Tutor question is already running.');
          const tour=requireTour(data.id), section=tour.sections[data.section], cue=section?.cues[data.cue];
          if(!cue)throw Error('Choose a cue before asking Tutor.');
          if(typeof data.question!=='string' || !data.question.trim() || data.question.length>6000)
            throw Error('Enter a question under 6,000 characters.');
          const controller=new AbortController();
          tutorJob={id:data.id,controller};
          res.once('close',()=>{if(!res.writableEnded)controller.abort(Error('Tutor stopped.'));});
          try{
            const {text}=await readTourCode(tour,cue.file);
            const question=data.grade===true
              ? `Joshua's explanation: ${data.question}. Grade it against the code: one line - Solid, Partly, or Off - then one sentence on what to fix.`
              : data.question;
            const configured=await agentSettings();
            const result=await runLearnPlan({provider:'muse',override:configured.executables?.muse,cwd:tour.codeRoot,
              prompt:tutorPrompt({title:section.title,...cue,text,question}),directory:path.join(directory,'jobs'),
              chatId:library.get(data.id).tutorSession,signal:controller.signal});
            if(result.status==='no-allowance')json(res,200,result);
            else{
              if(result.chatId)await library.patch(data.id,{tutorSession:result.chatId});
              json(res,200,{status:'ready',...parseTutorAnswer(result.text)});
            }
          }finally{tutorJob=null;}
        } else if(endpoint==='/api/learn/tutor/stop') {
          if(tutorJob?.id===data.id)tutorJob.controller.abort(Error('Tutor stopped.'));
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
