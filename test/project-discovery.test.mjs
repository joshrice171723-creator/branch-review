import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import discovery from '../desktop/project-discovery.cjs';

test('finds matching projects by name, retains duplicates, and ignores dependency checkouts',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'branch-review-discovery-test-'));
  try{
    const first=path.join(root,'work','orchard-lantern'),second=path.join(root,'archive','orchard_lantern'),worktree=path.join(root,'.codex','worktrees','sample','orchard-lantern'),dependency=path.join(root,'node_modules','orchard-lantern');
    await Promise.all([first,second,worktree,dependency].map(p=>mkdir(path.join(p,'.git'),{recursive:true})));
    const result=await discovery.findProjectCandidates(root,[{role:'user',text:'Bring in my Orchard Lantern project'}]);
    assert.deepEqual(new Set(result),new Set([first,second,worktree]));
    assert.deepEqual(await discovery.findProjectCandidates(root,[{role:'user',text:'Open my project'}]),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('agent preview suggestions keep standard static servers local and do not save secret fields',async()=>{
  const {safeSuggestedRecipe}=await import('../desktop/welcome-agent.cjs');
  const recipe=safeSuggestedRecipe({start:['python','-m','http.server','{port}'],env:{}});
  assert.deepEqual(recipe.start.slice(-2),['--bind','127.0.0.1']);
  assert.deepEqual(safeSuggestedRecipe({start:['python','-m','http.server','{port}','--bind','127.0.0.1','--bind=0.0.0.0']}).start,['python','-m','http.server','{port}','--bind','127.0.0.1']);
  assert.equal(safeSuggestedRecipe({start:['node','server.js'],env:{API_KEY:'secret'}}),null);
});
