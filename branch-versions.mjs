const commitPattern=/^[a-f0-9]{40}$/;

export async function writableBranch(git,ref,expected){
  if(!/^refs\/heads\/.+/.test(ref || '') || !commitPattern.test(expected || ''))throw Error('Open a local work branch before making changes.');
  const main=await git('symbolic-ref','--quiet','refs/remotes/origin/HEAD').catch(()=>'refs/remotes/origin/main');
  if(ref==='refs/heads/'+main.replace('refs/remotes/origin/','') || ['refs/heads/main','refs/heads/master'].includes(ref))throw Error('Choose a work branch before making changes. The default branch is protected.');
  if(await git('rev-parse','--verify',ref)!==expected)throw Error('This branch changed outside Branch Review. Reopen its latest version. Your proposed edits remain saved.');
  return ref;
}

export async function advanceBranch(git,run,ref,expected,commit){
  await writableBranch(git,ref,expected);
  if(await git('merge-base',expected,commit)!==expected)throw Error('The proposed version does not descend from the reviewed branch.');
  const checkouts=(await git('worktree','list','--porcelain')).split(/\r?\n\r?\n/).filter(row=>row.split(/\r?\n/).includes('branch '+ref));
  if(checkouts.length>1)throw Error('This branch is checked out in several workspaces. Your proposed commit is saved; release the extra checkouts before retrying.');
  if(checkouts.length){
    const cwd=checkouts[0].split(/\r?\n/).find(line=>line.startsWith('worktree ')).slice(9);
    if(await run('git',['status','--porcelain','--untracked-files=all'],{cwd}))throw Error('This branch has unsaved files in '+cwd+'. Your proposed commit is saved. Commit or move those edits, then retry applying it.');
    if(await run('git',['rev-parse','HEAD'],{cwd})!==expected)throw Error('The checked-out branch moved. Reopen its latest version; your proposed commit is saved.');
    // Git's fast-forward updates the checkout and rejects conflicting concurrent edits.
    await run('git',['merge','--ff-only','--no-edit',commit],{cwd});
  }else await git('update-ref',ref,commit,expected);
  if(await git('rev-parse',ref)!==commit)throw Error('The branch moved again. Reopen its latest version before continuing.');
}

export async function branchVersions(git,record){
  const ref=record.identity.ref;
  if(!/^refs\/heads\/.+/.test(ref))throw Error('Open a local work branch to view its versions.');
  const tip=await git('rev-parse','--verify',ref),base=record.branchBaseline || record.identity.base;
  const boundary=await git('merge-base',base,tip);
  const output=await git('log','--first-parent','-200','--format=%H%x09%aI%x09%s',`${boundary}..${tip}`,'--');
  const versions=output.split('\n').filter(Boolean).map(line=>{const [sha,date,...subject]=line.split('\t');return {sha,date,subject:subject.join('\t')};});
  versions.push({sha:boundary,subject:'Starting point before this branch',startingPoint:true});
  return {ref,tip,base,versions,truncated:versions.length>200};
}

export async function restoreVersion(git,run,record,sha,expected,confirmation){
  const history=await branchVersions(git,record);
  if(history.tip!==expected)throw Error('The branch changed. Refresh history before restoring.');
  if(confirmation!==`RESTORE ${sha} ON ${history.ref}` || !history.versions.some(row=>row.sha===sha))throw Error('Confirm a version from this branch history.');
  await writableBranch(git,history.ref,expected);
  const tree=await git('rev-parse',`${sha}^{tree}`);
  if(tree===await git('rev-parse',`${expected}^{tree}`))throw Error('This branch already contains the selected files.');
  const commit=await git('commit-tree',tree,'-p',expected,'-m',`Restore branch version ${sha.slice(0,7)}`);
  // Keep a recovery reference if publishing is interrupted or blocked by local edits.
  await git('update-ref',`refs/branch-review/restores/${commit}`,commit);
  await advanceBranch(git,run,history.ref,expected,commit);
  return commit;
}
