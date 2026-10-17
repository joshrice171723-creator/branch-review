import {itemStatus} from './public/review-model.js';

export const frontendOnly = files => files.length>0 && files.every(file=>/^apps\/web\/src\/.+\.(tsx?|jsx?|css|scss)$/.test(file));

export function reviewRoot(record,records){
  const seen=new Set();
  while(record?.previousId && !seen.has(record.id)){
    seen.add(record.id);const previous=records.find(row=>row.id===record.previousId);if(!previous)break;record=previous;
  }
  return record;
}

export function groupedBranches(branches,jobs,records){
  const groups=new Map(),hidden=new Set();
  // Uncommitted attempts remain recoverable in Jobs, not duplicate review branches.
  for(const job of jobs.filter(job=>job.kind==='fix' && job.status!=='succeeded')){
    const branch=branches.find(row=>row.ref==='refs/heads/'+job.branch);
    if(branch && branch.sha===job.commit && records.some(row=>row.id===job.reviewId))hidden.add(branch.ref);
  }
  for(const job of jobs.filter(job=>job.kind==='fix' && job.status==='succeeded')){
    const prior=records.find(row=>row.id===job.reviewId),root=reviewRoot(prior,records);
    const fix=branches.find(branch=>branch.ref==='refs/heads/'+job.branch && branch.sha===job.resultCommit);
    if(!root || !fix)continue;
    const key=root.identity.ref,group=groups.get(key) || {root,fixes:[]};group.fixes.push({job,fix});groups.set(key,group);
  }
  const replacements=[];
  for(const [ref,{root,fixes}] of groups){
    const latest=fixes.at(-1),original=branches.find(branch=>branch.ref===ref);
    // A separately advanced original branch must remain visible as independent work.
    if(original && original.sha!==root.identity.source)continue;
    hidden.add(ref);for(const {fix} of fixes)hidden.add(fix.ref);
    replacements.push({...latest.fix,subject:root.title,name:root.identity.ref.replace(/^refs\/heads\//,''),fixJob:latest.job.id,reviewRootId:root.id,fixCount:fixes.length,aliases:[...new Set([ref,...fixes.flatMap(({fix})=>[fix.ref,...(fix.aliases || [])])])]});
  }
  return [...replacements,...branches.filter(branch=>!hidden.has(branch.ref))];
}

export function focusRetest(record,previous,files,requestedPath){
  record.reviewRootId=previous.reviewRootId || previous.id;
  record.reviewTitle=previous.reviewTitle || previous.title;
  record.fixComparison={before:previous.identity.changed,after:record.identity.changed};
  record.previousResults=previous.manifest.scenarios.map(item=>({id:item.id,title:item.title,status:itemStatus(previous,item),commit:previous.identity.changed}));
  prepareRetest(record);
  const finding=record.issues.find(issue=>issue.status!=='resolved' && record.manifest.scenarios.some(item=>item.id===issue.scenario));
  const affectedItems=record.manifest.scenarios.filter(item=>item.files?.some(file=>files.includes(file)));
  const affected=affectedItems.find(item=>requestedPath && item.path===requestedPath.split(/[?#]/)[0]) || affectedItems.find(item=>item.id===previous.cursor?.itemId) || affectedItems[0];
  record.cursor={itemId:affected?.id || finding?.scenario || record.manifest.scenarios[0].id,view:'item'};
}

export function prepareRetest(record){
  if(!record.fixComparison || record.retestVersion===1 || record.delivery || record.approval)return;
  record.requestHistory ||= [];
  // A later request for the same item replaces earlier revision requests, not findings from the same revision.
  const latest=new Map();
  for(const issue of record.issues.filter(issue=>issue.status==='needs-retest')){
    const key=JSON.stringify([issue.scenario,issue.location || '']);
    if(!latest.has(key) || (issue.createdAt || '')>(latest.get(key).createdAt || ''))latest.set(key,issue);
  }
  record.issues=record.issues.filter(issue=>{
    const next=latest.get(JSON.stringify([issue.scenario,issue.location || '']));
    if(issue.status!=='needs-retest' || !next?.commit || !issue.commit || issue.commit===next.commit)return true;
    if(!record.requestHistory.some(old=>old.id===issue.id))record.requestHistory.push({...issue,supersededBy:next.id});
    return false;
  });
  for(const item of record.manifest.scenarios){
    const saved=record.items?.[item.id];
    if(saved?.carriedFrom && ['needs-fixes','blocked'].includes(saved.outcome)){
      record.requestHistory.push({scenario:item.id,actual:saved.reason,expected:item.expected,commit:record.fixComparison.before});
      record.items[item.id]={...saved,outcome:'',reason:''};
    }
  }
  const first=record.issues.find(issue=>issue.status==='needs-retest' && record.manifest.scenarios.some(item=>item.id===issue.scenario));
  if(first)record.cursor={itemId:first.scenario,view:'item'};
  record.retestVersion=1;
}

export function mergeFixPlan(previous,generated,files){
  const affected=previous.scenarios.filter(item=>!item.files?.length || item.files.some(file=>files.includes(file)));
  const replacements=generated.scenarios.map(item=>{
    const matches=affected.filter(old=>old.path===item.path && old.files?.some(file=>item.files?.includes(file)));
    return {...item,id:matches.length===1?matches[0].id:item.id};
  });
  if(new Set(replacements.map(item=>item.id)).size!==replacements.length)return generated;
  return {...previous,summary:generated.summary,scenarios:[...previous.scenarios.filter(item=>!affected.includes(item)),...replacements]};
}

export function carryUnchangedChecks(record,previous,files){
  for(const item of record.manifest.scenarios){
    const old=previous.manifest.scenarios.find(old=>old.id===item.id);
    if(!old || !item.files?.length || item.files.some(file=>files.includes(file)) || JSON.stringify(old)!==JSON.stringify(item) || itemStatus(previous,old)!=='passed')continue;
    for(let index=0;index<item.steps.length;index++)record.checks[`${item.id}:${index}`]=true;
    record.items[item.id]={...previous.items?.[item.id],carriedFrom:previous.id,verifiedAtCommit:previous.identity.changed};
  }
}

// Reuse routes only when the diff proves that CSS hex values are the entire change.
export async function colorFixPlan(git,previous,after,files,main){
  if(previous.integration?.main!==main || !files.length || !files.every(file=>file.endsWith('.css') && previous.manifest.scenarios.some(item=>item.files?.includes(file))))return null;
  const changes=new Map();
  for(const file of files){
    const before=await git('show',`${previous.identity.changed}:${file}`),next=await git('show',`${after}:${file}`);
    const pattern=/#(?:[a-f0-9]{8}|[a-f0-9]{6}|[a-f0-9]{4}|[a-f0-9]{3})\b/gi;
    if(before===next || before.replace(pattern,'#COLOR')!==next.replace(pattern,'#COLOR'))return null;
    const oldMatches=[...before.matchAll(pattern)],newMatches=[...next.matchAll(pattern)];
    const inDeclaration=(text,match)=>{
      const prefix=text.slice(0,match.index),boundary=Math.max(prefix.lastIndexOf('{'),prefix.lastIndexOf(';'),prefix.lastIndexOf('}'));
      return /^\s*[\w-]+\s*:\s*[^{};'"/]*$/.test(prefix.slice(boundary+1));
    };
    if(newMatches.some((match,index)=>match[0]!==oldMatches[index][0] && (!inDeclaration(before,oldMatches[index]) || !inDeclaration(next,match))))return null;
    const old=oldMatches.map(match=>match[0]),colors=newMatches.map(match=>match[0]);
    changes.set(file,[...new Set(colors.flatMap((color,index)=>color!==old[index]?[`${old[index]} to ${color}`]:[]))]);
  }
  return {...previous.manifest,source:'Color-only diff; existing screen mappings',summary:'Compare the updated colors on the affected screens.',scenarios:previous.manifest.scenarios.filter(item=>item.files?.some(file=>changes.has(file))).map(item=>{
    const colors=[...new Set(item.files.flatMap(file=>changes.get(file)||[]))].join(', ');
    return {...item,title:'Check updated colors on '+item.path,description:`Color changes: ${colors}`.slice(0,2000),instructions:'Toggle Before fix and After fix. Compare the changed control on this screen, including hover and keyboard focus.',expected:'The updated colors match your request. Text stays readable and the control still works.',steps:['The changed colors match my request.','Text, hover, keyboard focus, and the control action still work.']};
  })};
}

// Only reuse mapped screens when every source change is an appearance declaration.
export async function appearanceFixPlan(git,previous,after,files,main){
  if(previous.integration?.main!==main || !files.length || !files.every(file=>file.endsWith('.css') && previous.manifest.scenarios.some(item=>item.files?.includes(file))))return null;
  const changes=new Map();
  const declaration=/(?<=[{;])\s*(color|background-color|border-color|border-radius|box-shadow|text-shadow|outline-color)\s*:\s*([^;{}]+);?/gi;
  const parse=text=>{
    const values=[];
    const structure=text.replace(declaration,(whole,property,value)=>{
      if(/url\(|expression|@|\/\*/i.test(value))return whole;
      values.push(`${property}: ${value.trim()}`);return '';
    });
    return {structure,values};
  };
  for(const file of files){
    const before=await git('show',`${previous.identity.changed}:${file}`),next=await git('show',`${after}:${file}`);
    const old=parse(before),updated=parse(next);
    if(before===next || old.structure!==updated.structure || JSON.stringify(old.values)===JSON.stringify(updated.values))return null;
    const removed=old.values.filter((value,index)=>value!==updated.values[index]);
    const added=updated.values.filter((value,index)=>value!==old.values[index]);
    changes.set(file,`Before: ${removed.join('; ') || 'unset'}. After: ${added.join('; ') || 'unset'}.`);
  }
  return {...previous.manifest,source:'Verified appearance-only CSS diff; existing screen mappings',summary:'Check the latest appearance change on its affected screens.',scenarios:previous.manifest.scenarios.filter(item=>item.files?.some(file=>changes.has(file))).map(item=>({...item,title:'Check updated appearance on '+item.path,description:item.files.map(file=>changes.get(file)).filter(Boolean).join(' ').slice(0,2000),instructions:'Compare Before fix and After fix on this screen. Inspect the changed control at rest, on hover, with keyboard focus, and at a narrow width.',expected:'The changed appearance matches the request and the listed CSS values. Text remains readable and the control still works.',steps:['The changed appearance matches the request and the listed before/after values.','Hover, keyboard focus, and the control action still work.','At a narrow width, the control remains readable without clipping.']}))};
}
