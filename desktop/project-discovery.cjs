const {readdir}=require('node:fs/promises');
const path=require('node:path');
const ignored=new Set(['node_modules','.git','.hg','.svn','vendor','dist','build','.next','__pycache__','cache','caches']);
const stop=new Set(['please','project','projects','bring','open','find','load','working','worked','using','review','branch','application','app','into','here','that','this','with','from','folder','want','could','would','like','my','the','for','and','one']);
async function findProjectCandidates(home,messages,options={}){
  const words=[...new Set(messages.filter(m=>m.role==='user').flatMap(m=>m.text.toLowerCase().match(/[a-z0-9]+/g)||[]).filter(w=>w.length>=3&&!stop.has(w)))];
  if(!words.length)return [];
  const queue=[[home,0]],found=[],limit=options.limit||30000,deadline=Date.now()+(options.timeout||10000);let examined=0;
  while(examined<queue.length && examined<limit && Date.now()<deadline){
    const [dir,depth]=queue[examined++];let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{continue;}
    if(entries.some(entry=>entry.name.toLowerCase()==='.git')){
      const base=path.basename(dir).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const score=words.filter(word=>base.some(part=>part===word||word.length>=5&&(part.includes(word)||word.includes(part)))).length;
      if(score)found.push({path:dir,score});
      continue;
    }
    if(depth>=7)continue;
    if(depth===0 && entries.some(entry=>entry.isDirectory() && entry.name==='.codex'))queue.push([path.join(dir,'.codex','worktrees'),1]);
    for(const entry of entries)if(queue.length<limit*2 && entry.isDirectory()&&!entry.isSymbolicLink()&&!entry.name.startsWith('.')&&!ignored.has(entry.name.toLowerCase()))queue.push([path.join(dir,entry.name),depth+1]);
  }
  return found.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,25).map(item=>item.path);
}
module.exports={findProjectCandidates};
