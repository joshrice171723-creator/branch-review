import {readFile,access,writeFile,mkdir,realpath} from 'node:fs/promises';
import {readRecipe,expandRecipe} from './project-settings.mjs';
import {spawn,spawnSync} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const exists=file=>access(file).then(()=>true,()=>false);
export function hotReloadable(kind,files){
  return ['vite','next'].includes(kind) && files.every(file=>
    !/(^|\/)(?:node_modules|\.git|\.next|dist)\//.test(file) &&
    (/\.(css|scss|sass|less|png|jpe?g|gif|svg|webp|ico)$/i.test(file) ||
      kind==='vite' && (/\.html$/i.test(file) || /^(src|components)\/.+\.[jt]sx?$/.test(file))));
}
export async function detectProject(directory){
  if(await exists(path.join(directory,'bin/agent-resources')) && await exists(path.join(directory,'apps/api/Gemfile')))return {kind:'meta-clinic',name:'Meta Clinic'};
  const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8').catch(()=> '{}'));
  const dependencies={...pkg.dependencies,...pkg.devDependencies};
  const kind=dependencies.vite?'vite':dependencies.next?'next':null;
  if(!kind || pkg.packageManager && !pkg.packageManager.startsWith('npm@') || !await exists(path.join(directory,'package-lock.json')))return {kind:'custom',name:pkg.name || path.basename(directory),needsSetup:true};
  return {kind,name:pkg.name || path.basename(directory)};
}
export async function npmEntry(env=process.env){
  for(const directory of [path.dirname(process.execPath),...(env.PATH || '').split(path.delimiter)]){
    const file=path.join(directory,'node_modules/npm/bin/npm-cli.js');if(await exists(file))return file;
  }
  throw Error('Install Node.js with npm and reopen Branch Review.');
}
export async function projectCommand(args,env=process.env){
  const [file,...rest]=args;
  if(file==='node')return {file:process.execPath,args:rest};
  if(file==='npm')return {file:process.execPath,args:[await npmEntry(env),...rest]};
  if(['pnpm','yarn'].includes(file)){
    for(const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)){
      const native=path.join(directory,file+(process.platform==='win32'?'.exe':''));
      if(await exists(native))return {file:native,args:rest};
      const modules=path.basename(directory)==='.bin'?path.dirname(directory):path.join(directory,'node_modules');
      const entries=file==='pnpm'?['pnpm.cjs','pnpm.mjs']:['yarn.js'];
      for(const entry of [...entries.map(name=>path.join(modules,file,'bin',name)),path.join(modules,'corepack','dist',file+'.js')])if(await exists(entry))return {file:process.execPath,args:[entry,...rest]};
    }
    throw Error(`Install ${file} and reopen Branch Review, or use its absolute executable/JavaScript path in project settings.`);
  }
  if(/\.(cmd|bat|ps1)$/i.test(file))throw Error('Use the program executable or JavaScript entry file instead of a Windows shell wrapper.');
  return /\.[cm]?js$/i.test(file)?{file:process.execPath,args:[file,...rest]}:{file,args:rest};
}
async function freePort(){
  const server=net.createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
export class WebPreviews{
  constructor({run,progress,local}){Object.assign(this,{run,progress,local});this.running=new Map();
    process.once('exit',()=>{for(const entry of this.running.values())for(const child of entry.children || [entry.child])if(child.pid && child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}});
  }
  async stop(side){
    const entry=this.running.get(side);if(!entry)return;
    for(const child of entry.children || [entry.child])if(child.pid && child.exitCode===null){
      if(process.platform==='win32')await this.run('taskkill',['/PID',String(child.pid),'/T','/F']).catch(error=>{if(child.exitCode===null)throw error;});
      else child.kill();
    }
    this.running.delete(side);
  }
  async healthy(side,sha){
    const entry=this.running.get(side);
    if(!entry || entry.sha!==sha || (entry.children || [entry.child]).some(child=>child.exitCode!==null || child.signalCode))return false;
    return fetch(`http://127.0.0.1:${entry.port}${entry.readyPath || '/'}`,{signal:AbortSignal.timeout(2000)}).then(r=>r.ok,()=>false);
  }
  async prepare(side,sha,cwd,checkout){
    if(await this.healthy(side,sha))return this.running.get(side).preview;
    const running=this.running.get(side);
    if(running && path.resolve(running.preview.directory)===path.resolve(cwd) && hotReloadable(running.preview.kind,[]) && !await readRecipe(this.local) && await this.healthy(side,running.sha)){
      const files=(await this.run('git',['diff','--name-only','-z',running.sha,sha,'--'],{cwd})).split('\0').filter(Boolean);
      if(hotReloadable(running.preview.kind,files)){
        await checkout();
        running.sha=sha;running.preview={...running.preview,sha};
        if(await this.healthy(side,sha)){this.progress(`${side} · updated running preview; kept server and dependencies`);return running.preview;}
      }
    }
    await this.stop(side);await checkout();
    const project=await detectProject(cwd);
    if(project.kind==='meta-clinic')throw Error('This branch changed project type. Reopen the repository.');
    const recipe=await readRecipe(this.local);
    if(recipe)return this.custom(side,sha,cwd,recipe);
    if(project.needsSetup)throw Error('Set up this project in More tools → Workspace. Enter its setup and start commands.');
    const lock=await readFile(path.join(cwd,'package-lock.json'),'utf8'),key=side+'-dependencies';
    this[key] ||= await readFile(path.join(this.local,key+'.lock'),'utf8').catch(()=>null);
    if(this[key]!==lock || !await exists(path.join(cwd,'node_modules',project.kind))){
      this.progress(`${side} · installing locked npm dependencies (install scripts disabled)`);
      await this.run(process.execPath,[await npmEntry(),'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
      this[key]=lock;await writeFile(path.join(this.local,key+'.lock'),lock);
    }
    const port=await freePort(),entry=path.join(cwd,'node_modules',project.kind,project.kind==='vite'?'bin/vite.js':'dist/bin/next');
    const args=project.kind==='vite'?[entry,'--host','127.0.0.1','--port',String(port),'--strictPort']:[entry,'dev','--hostname','127.0.0.1','--port',String(port)];
    const child=spawn(process.execPath,args,{cwd,windowsHide:true,shell:false,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
    let output='',failure;const record=chunk=>{output=(output+chunk).slice(-12000);};child.stdout.on('data',record);child.stderr.on('data',record);child.on('error',error=>{failure=error;});
    const preview={side,sha,web:port,runtime:side,directory:cwd,kind:project.kind,scenario:{public:true,path:'/'}};
    this.running.set(side,{child,sha,port,preview});this.progress(`${side} · starting ${project.kind} preview`);
    try{
      const deadline=Date.now()+120000;
      while(Date.now()<deadline){
        if(failure || child.exitCode!==null)throw failure || Error(output || 'Preview process exited.');
        if(await this.healthy(side,sha))return preview;
        await new Promise(resolve=>setTimeout(resolve,300));
      }
      throw Error('Preview did not become ready within two minutes. '+output);
    }catch(error){await this.stop(side);throw error;}
    finally{await writeFile(path.join(this.local,side+'.log'),output);}
  }
  async custom(side,sha,root,recipe){
    const port=await freePort(),data=path.join(this.local,'preview-data',side,sha);
    await mkdir(data,{recursive:true});
    const cwd=await realpath(path.resolve(root,recipe.directory)),base=await realpath(root);
    if(cwd!==base && !cwd.startsWith(base+path.sep))throw Error('Preview directory resolves outside its checkout.');
    const config=expandRecipe(recipe,{port,root,side,commit:sha,data});
    const env={...process.env,...config.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(port),BRANCH_REVIEW_DATA:data,BRANCH_REVIEW_REVISION:sha,BRANCH_REVIEW_SIDE:side};
    const launch=args=>projectCommand(args,env);
    const stamp=JSON.stringify({sha,recipe});
    this[side+'-setup'] ||= await readFile(path.join(this.local,side+'-setup.json'),'utf8').catch(()=>null);
    if(this[side+'-setup']!==stamp){for(const args of config.setup){this.progress(`${side} · ${args[0]} setup`);const command=await launch(args);await this.run(command.file,command.args,{cwd,env});}this[side+'-setup']=stamp;await writeFile(path.join(this.local,side+'-setup.json'),stamp);}
    let output='',failure;const children=[];
    const preview={side,sha,web:port,runtime:side,directory:root,kind:'custom',scenario:{public:true,path:'/'}};
    this.running.set(side,{children,sha,port,preview,readyPath:config.readyPath});
    try{
      for(const service of [...config.services,{name:'preview',args:config.start}]){
        const command=await launch(service.args);
        const child=spawn(command.file,command.args,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});children.push(child);
        const capture=chunk=>{output=(output+`[${service.name}] `+chunk).slice(-12000);};child.stdout.on('data',capture);child.stderr.on('data',capture);child.on('error',error=>{failure=error;});
      }
      this.progress(`${side} · waiting for ${config.readyPath}`);
      const deadline=Date.now()+120000;
      while(Date.now()<deadline){
        if(failure || children.some(child=>child.exitCode!==null))throw failure || Error(output || 'A preview service stopped.');
        if(await this.healthy(side,sha))return preview;
        await new Promise(resolve=>setTimeout(resolve,300));
      }
      throw Error('Preview did not become ready within two minutes. '+output);
    }catch(error){await this.stop(side);throw error;}
    finally{await writeFile(path.join(this.local,side+'.log'),output);}
  }
}
