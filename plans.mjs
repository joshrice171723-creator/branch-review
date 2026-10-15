import {validateManifest,manifestForFiles} from './reviews.mjs';
export async function loadPlan(git,sha,files) {
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Choose an exact commit for the review plan.');
  const found=await git('ls-tree','--name-only',sha,'--','.branch-review.json');
  if(!found)return validateManifest(manifestForFiles(files));
  const raw=await git('show',`${sha}:.branch-review.json`);
  if(Buffer.byteLength(raw)>64000)throw new Error('Review manifest is too large.');
  try{return validateManifest(JSON.parse(raw));}catch(error){throw new Error(`Invalid .branch-review.json: ${error.message}`);}
}
