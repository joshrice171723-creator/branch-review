import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './reviews.mjs';
export const target = 'https://aimetaclinic.com';
export async function publish(record, { local, repo, run, git, store, confirmation, toolchain, muse, fetcher = fetch }) {
  const sha = record.identity.changed;
  if (confirmation !== `PUBLISH ${sha} TO ${target}`) throw new Error('Confirm the exact commit and publishing destination.');
  if (!record.approval || record.delivery?.stage !== 'pushed') throw new Error('The approved candidate must be pushed before publishing.');
  if (record.approval.identity !== digest(record.identity) || record.integration?.sha !== sha || record.delivery.commit !== sha) throw new Error('Publishing requires approval and push evidence for this exact candidate.');
  const remote = await git('remote','get-url','origin');
  if (!/^(https:\/\/github\.com\/|git@github\.com:)joshrice171723-creator\/meta_clinic(?:\.git)?$/.test(remote)) throw new Error('Publishing is configured only for the Meta Clinic repository.');
  const config = JSON.parse(await readFile(path.join(local,'release.json'),'utf8').catch(()=> '{}'));
  if (!config.keyPath || !config.recoveryDirectory) throw new Error('Select the existing SSH key and recovery folder in Publish settings.');
  await access(config.keyPath); await access(config.recoveryDirectory);
  if ((await git('ls-remote','origin','refs/heads/main')).split(/\s/)[0] !== sha) throw new Error('Main moved. Publishing requires the exact reviewed main revision.');
  if(muse)await muse.preflight(record);
  const directory = path.join(local,'release-checkout');
  const exists = await access(directory).then(()=>true,()=>false);
  if (!exists) { await run('git',['clone',repo,directory]); await writeFile(path.join(directory,'.branch-review-owner'),'branch-review-release/v1'); }
  if ((await readFile(path.join(directory,'.branch-review-owner'),'utf8').catch(()=>'')) !== 'branch-review-release/v1') throw new Error('Release checkout is not owned by Branch Review.');
  const g = (...args) => run('git',args,{cwd:directory});
  if (await g('status','--porcelain','--untracked-files=no')) throw new Error('Release checkout contains edits. Preserve them before publishing.');
  await g('remote','set-url','origin',await git('remote','get-url','origin'));
  await g('fetch','origin','main');
  if (await g('rev-parse','origin/main') !== sha) throw new Error('Remote changed while preparing release.');
  await g('checkout','-B','main',sha);
  record.delivery.stage = 'deploying'; record.delivery.target = target; await store.persist();
  try {
    const output = await run('pwsh',['-NoProfile','-File',path.join(directory,'ops/lightsail/release.ps1'),'-KeyPath',config.keyPath,'-RecoveryDirectory',config.recoveryDirectory,'-Server','ubuntu@aimetaclinic.com','-BuildWebOnHost','-StreamImages'],{cwd:directory,env:{...process.env,PATH:toolchain ? `${toolchain}${path.delimiter}${process.env.PATH}` : process.env.PATH}});
    await writeFile(path.join(local,'release.log'),output);
    const buildResponse = await fetcher(target + '/build.json', {cache:'no-store',signal:AbortSignal.timeout(15000)});
    if (!buildResponse.ok) throw new Error('Could not read published build identity.');
    const build = await buildResponse.json();
    if (build.revision !== sha || build.dirty) throw new Error('Published revision does not match the approved candidate.');
    const health = await fetcher(target + '/up',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if (!health.ok) throw new Error('Published health check failed.');
    record.delivery.stage = 'published'; record.delivery.publishedAt = new Date().toISOString(); record.delivery.build = build;
    if(muse)muse.prepare(record);
    await store.event(record,'published',{commit:sha,target});
  } catch (error) {
    record.delivery.stage = 'deployment-needs-inspection'; record.delivery.error = error.message;
    await store.event(record,'deployment-needs-inspection',{error:error.message}); throw error;
  }
  // A failed QA handoff must never turn a successful deployment into a failed release.
  if(muse)await muse.dispatch(record);
  return record.delivery;
}
