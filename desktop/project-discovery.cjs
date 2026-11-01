const {readdir}=require('node:fs/promises');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const os=require('node:os'),path=require('node:path');
const ignored=new Set(['node_modules','.git','.hg','.svn','vendor','dist','build','.next','__pycache__','cache','caches','system volume information','$recycle.bin','windows','program files','program files (x86)']);
const stop=new Set(['please','project','projects','bring','open','find','load','working','worked','using','review','branch','application','app','into','here','that','this','with','from','folder','want','could','would','like','my','the','for','and','one','it','me','to','go','an','on','at','of','in','up','be','we','us','as','am','is']);
async function localDrives(home){
  if(process.platform!=='win32' || path.resolve(home).toLowerCase()!==path.resolve(os.homedir()).toLowerCase())return [];
  try{const shell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');const result=await promisify(execFile)(shell,['-NoProfile','-NonInteractive','-Command',"Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID }"],{windowsHide:true,timeout:4000,maxBuffer:10000});const current=path.parse(home).root.toLowerCase();return result.stdout.split(/\s+/).filter(drive=>/^[a-z]:$/i.test(drive)).map(drive=>drive+'\\').filter(root=>root.toLowerCase()!==current); }catch{return [];}
}
async function findProjectCandidates(home,messages,options={}){
  const words=[...new Set(messages.filter(m=>m.role==='user').flatMap(m=>m.text.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>w.length>=2&&!stop.has(w)))];
  if(!words.length)return [];
  const roots=options.additionalRoots || await localDrives(home);
  const queue=[[home,0],...roots.map(root=>[root,0])],found=[],limit=options.limit||30000,deadline=Date.now()+(options.timeout||10000);let examined=0;
  while(examined<queue.length && examined<limit && Date.now()<deadline){
    const [dir,depth]=queue[examined++];let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{continue;}
    if(entries.some(entry=>entry.name.toLowerCase()==='.git')){
      const base=path.basename(dir).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const score=words.filter(word=>base.some(part=>part===word||word.length>=5&&(part.includes(word)||word.includes(part)))).length;
      if(score)found.push({path:dir,score});
      continue;
    }
    if(depth>=7)continue;
    if(dir===home && entries.some(entry=>entry.isDirectory() && entry.name==='.codex'))queue.push([path.join(dir,'.codex','worktrees'),1]);
    for(const entry of entries)if(queue.length<limit*2 && entry.isDirectory()&&!entry.isSymbolicLink()&&!entry.name.startsWith('.')&&!ignored.has(entry.name.toLowerCase()))queue.push([path.join(dir,entry.name),depth+1]);
  }
  return found.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,25).map(item=>item.path);
}
module.exports={findProjectCandidates};
