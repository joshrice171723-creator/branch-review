const commitPattern=/^[a-f0-9]{40}$/;
export async function changedFiles(git, base, changed) {
  if(!commitPattern.test(base) || !commitPattern.test(changed))throw new Error('Choose exact comparison commits.');
  const tokens=(await git('diff','--name-status','-z','--find-renames',base,changed,'--')).split('\0').filter(Boolean),files=[];
  for(let i=0;i<tokens.length;){const status=tokens[i++],first=tokens[i++];if(!first)break;const renamed=/^[RC]/.test(status);files.push({status:status[0],path:renamed?tokens[i++]:first,...(renamed?{previousPath:first}:{})});}
  const stats=(await git('diff','--numstat','-z','--find-renames',base,changed,'--')).split('\0'),counts=new Map();
  for(let i=0;i<stats.length;i++){
    const row=stats[i];if(!row)continue;
    const first=row.indexOf('\t'),second=row.indexOf('\t',first+1);let name=row.slice(second+1);
    if(!name){i++;name=stats[++i];}
    counts.set(name,{added:row.slice(0,first),removed:row.slice(first+1,second)});
  }
  return files.map(file=>{const count=counts.get(file.path);return{...file,added:Number(count?.added)||0,removed:Number(count?.removed)||0,binary:count?.added==='-'};});
}
export async function fileDiff(git, base, changed, filename) {
  const files=await changedFiles(git,base,changed),file=files.find(file=>file.path===filename);
  if(!file)throw new Error('Choose a file from this exact comparison.');
  const patch=await git('--literal-pathspecs','diff','--no-ext-diff','--no-textconv','--no-color','--unified=4','--find-renames',base,changed,'--',...(file.previousPath?[file.previousPath]:[]),file.path);
  const limit=100000;
  return {base,changed,file,patch:patch.slice(0,limit),truncated:patch.length>limit};
}
export async function commitHistory(git, sha) {
  if(!commitPattern.test(sha))throw new Error('Choose a listed branch.');
  const output=await git('log','-60','--format=%H%x09%aI%x09%s',sha,'--');
  return output.split('\n').filter(Boolean).map(line=>{const [sha,date,...subject]=line.split('\t');return{sha,date,subject:subject.join('\t')};});
}
