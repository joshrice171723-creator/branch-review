import path from 'node:path';
import {readFile,writeFile,rename} from 'node:fs/promises';

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
export async function saveRecipe(local,value){
  const recipe=validateRecipe(value),file=path.join(local,'project-settings.json');
  await writeFile(file+'.tmp',JSON.stringify(recipe,null,2));await rename(file+'.tmp',file);return recipe;
}
export function expandRecipe(value,context){
  const expand=text=>text.replace(/\{(port|root|side|commit|data)\}/g,(_,key)=>String(context[key]));
  return {...value,start:value.start.map(expand),setup:value.setup.map(args=>args.map(expand)),services:value.services.map(service=>({...service,args:service.args.map(expand)})),env:Object.fromEntries(Object.entries(value.env).map(([key,v])=>[key,expand(v)]))};
}
