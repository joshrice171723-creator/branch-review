import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,lstat,link,unlink} from 'node:fs/promises';

export function validateRecipe(value){
  if(!value || typeof value!=='object' || Array.isArray(value))throw Error('Enter project settings as an object.');
  const directory=value.directory || '.';
  if(typeof directory!=='string' || path.isAbsolute(directory) || directory.split(/[\\/]/).includes('..'))throw Error('Working directory must stay inside the project.');
  const command=(args,label)=>{
    if(!Array.isArray(args) || !args.length || args.length>100 || args.some(arg=>typeof arg!=='string'||arg.length>4000||arg.includes('\0')))throw Error(`${label} must be an executable followed by its arguments.`);
    return args;
  };
  const start=command(value.start,'Start command');
  const setup=(value.setup || []).map(args=>command(args,'Setup command'));
  const checks=(value.checks || []).map((check,index)=>({id:'custom-'+index,name:String(check.name || 'Check '+(index+1)).slice(0,100),args:command(check.args,'Check command')}));
  const readyPath=value.readyPath || '/';
  if(typeof readyPath!=='string' || !readyPath.startsWith('/') || readyPath.startsWith('//') || /[\\\r\n]/.test(readyPath))throw Error('Readiness path must be a local path, such as /health.');
  const env=value.env || {};
  if(typeof env!=='object'||Array.isArray(env)||Object.entries(env).some(([key,v])=>!/^\w+$/.test(key)||typeof v!=='string'||v.includes('\0')))throw Error('Environment entries must be named text values.');
  const services=(value.services || []).map(service=>({name:String(service.name || 'service').slice(0,60),args:command(service.args,'Service command')}));
  if(setup.length>10||checks.length>30||services.length>6)throw Error('Use at most 10 setup commands, 30 checks and 6 supporting services.');
  return {directory,start,setup,checks,services,readyPath,env};
}
export async function readRecipe(local){
  return readFile(path.join(local,'project-settings.json'),'utf8').then(text=>validateRecipe(JSON.parse(text))).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
}
export async function declaredReviewRecipe(directory) {
  const file = path.join(directory, 'workbench-capabilities.json');
  const entry = await lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry?.isFile() || entry.size > 384 * 1024) return null;
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.previews)) return null;
  const candidates = manifest.previews.filter(preview => preview?.mode === 'web' &&
    /^http:\/\/(?:127\.0\.0\.1|localhost):\{port\}(?:\/[^\r\n\\]*)?$/.test(preview.url));
  if (candidates.length !== 1) return null;
  const preview = candidates[0];
  const url = new URL(preview.url.replace('{port}', '4000'));
  return validateRecipe({directory: preview.cwd, start: preview.argv, env: preview.env,
    readyPath: url.pathname + url.search});
}
export async function reviewRecipe(local, directory) {
  return await readRecipe(local) ?? await declaredReviewRecipe(directory);
}
export async function saveRecipe(local,value){
  const recipe=validateRecipe(value),file=path.join(local,'project-settings.json');
  const temporary=path.join(local,'project-settings.'+randomUUID()+'.tmp');
  try {
    await writeFile(temporary,JSON.stringify(recipe,null,2),{flag:'wx'});
    await rename(temporary,file);
    return recipe;
  } finally {
    await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
}

export async function saveSuggestedRecipe(local, value) {
  const recipe = validateRecipe(value);
  const file = path.join(local, 'project-settings.json');
  const temporary = path.join(local, 'project-settings.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(recipe, null, 2), {flag: 'wx'});
    await link(temporary, file);
    return recipe;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function previewComposeName(namespace, side) {
  const absolute = path.resolve(namespace);
  const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  const slot = String(side).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'preview';
  return 'branchreview-' + hash + '-' + slot;
}

function isolateCompose(args, name) {
  const executable = path.basename(args[0]).toLowerCase();
  const compose = executable === 'docker' || executable === 'docker.exe' ? args.indexOf('compose', 1) :
    /^docker-compose(?:\.exe)?$/.test(executable) ? 0 : -1;
  if (compose < 0) return args;
  const result = [...args];
  for (let index = compose + 1; index < result.length; index++) {
    if (result[index] === '--project-name' || result[index] === '-p') {
      if (index + 1 < result.length) result.splice(index, 2, '--project-name', name);
      return result;
    }
    if (/^(?:--project-name|-p)=/.test(result[index])) {
      result.splice(index, 1, '--project-name', name);
      return result;
    }
    if (/^-p[^-].*/.test(result[index])) {
      result.splice(index, 1, '--project-name', name);
      return result;
    }
  }
  result.splice(compose + 1, 0, '--project-name', name);
  return result;
}

export function previewComposeStop(args) {
  const executable = path.basename(args[0]).toLowerCase();
  const compose = executable === 'docker' || executable === 'docker.exe' ? args.indexOf('compose', 1) :
    /^docker-compose(?:\.exe)?$/.test(executable) ? 0 : -1;
  if (compose < 0) return null;
  const index = args.indexOf('up', compose + 1);
  const name = args.indexOf('--project-name', compose + 1);
  if (index < 0 || name < 0 || !/^branchreview-[a-f0-9]{16}-[a-z0-9_-]+$/.test(args[name + 1] || '')) return null;
  return [...args.slice(0, index), 'stop'];
}

export function expandRecipe(value,context){
  const expand=text=>text.replace(/\{(port|root|side|commit|data)\}/g,(_,key)=>String(context[key]));
  const name=context.namespace && previewComposeName(context.namespace,context.side);
  const command=args=>{const expanded=args.map(expand);return name ? isolateCompose(expanded,name) : expanded;};
  return {...value,start:command(value.start),setup:value.setup.map(command),
    services:value.services.map(service=>({...service,args:command(service.args)})),
    env:Object.fromEntries(Object.entries(value.env).map(([key,v])=>[key,expand(v)]))};
}
