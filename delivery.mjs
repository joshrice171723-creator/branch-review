import { digest } from './reviews.mjs';

export class Delivery {
  constructor(git, store, defaultBranch=async()=> 'main') { this.git = git; this.store = store; this.defaultBranch=defaultBranch; }
  async refs(record) {
    await this.git('fetch','origin');
    const main = await this.git('rev-parse','refs/remotes/origin/'+await this.defaultBranch());
    const source = await this.git('rev-parse',record.identity.ref);
    if (source !== record.identity.source) throw new Error('The branch changed. Reopen it and review the new commit.');
    return {main,source};
  }
  async candidate(record) {
    record.integration = await this.prepare(record.identity.ref,record.identity.source,record.integration);
    await this.store.event(record,'candidate-prepared',record.integration); return record.integration;
  }
  async withoutChecklist(sha) {
    const entries=await this.git('ls-tree',sha);
    if(!entries.split('\n').some(line=>line.endsWith('\t.branch-review.json')))return sha;
    const tree=await this.git('mktree',{input:entries.split('\n').filter(line=>!line.endsWith('\t.branch-review.json')).join('\n')+'\n'});
    return this.git('commit-tree',tree,'-p',sha,'-m','Exclude legacy Branch Review checklist metadata');
  }
  async prepare(ref, expectedSource, previous) {
    const {main,source} = await this.refs({identity:{ref,source:expectedSource}});
    const common = await this.git('merge-base',main,source);
    if (common === source) throw new Error('This branch is already included in main. There is nothing to merge.');
    let sha = source;
    const cleanMain=await this.withoutChecklist(main),cleanSource=await this.withoutChecklist(source);
    if (common !== main || cleanMain!==main || cleanSource!==source) {
      if (previous?.main === main && previous.source === source && !await this.git('ls-tree','--name-only',previous.sha,'--','.branch-review.json')) return previous;
      const output = await this.git('merge-tree','--write-tree',cleanMain,cleanSource).catch(e => { throw new Error('Merge conflict: this branch conflicts with GitHub main. Resolve the code conflicts, then open it again.\n\nTechnical details\n' + e.message); });
      const tree = output.split('\n')[0];
      if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('Could not produce a merge candidate.');
      sha = await this.git('commit-tree',tree,'-p',main,'-p',source,'-m',`Merge reviewed branch ${ref.replace('refs/heads/','')}`);
    }
    await this.git('update-ref',`refs/branch-review/${digest({ref,main,source})}`,sha);
    return {main,source,sha,preparedAt:new Date().toISOString()};
  }
  async push(record, expectedCommit) {
    if (expectedCommit !== record.identity.changed) throw new Error('The shipping confirmation names a different commit.');
    if (!record.approval || record.approval.identity !== digest(record.identity)) throw new Error('Approve this exact reviewed version before merging.');
    if (!record.integration || record.integration.sha !== record.identity.changed) throw new Error('Prepare and test the integration candidate before merging.');
    const {main} = await this.refs(record);
    if (main === record.integration.sha) {
      record.delivery = {...record.delivery, stage:'pushed', commit:main};
      await this.store.event(record,'push-confirmed',{commit:main}); return record.delivery;
    }
    if (main !== record.integration.main) throw new Error('Main moved. Prepare a fresh candidate and review it again.');
    record.delivery = { stage:'pushing', commit:expectedCommit, startedAt:new Date().toISOString() }; await this.store.persist();
    try {
      // A normal fast-forward push cannot overwrite concurrent main changes.
      await this.git('push','origin',`${expectedCommit}:refs/heads/${await this.defaultBranch()}`);
      const actual = (await this.git('ls-remote','origin','refs/heads/'+await this.defaultBranch())).split(/\s/)[0];
      if (actual !== expectedCommit) throw new Error('Remote main differs after push. Outcome requires inspection.');
      record.delivery.stage = 'pushed'; await this.store.event(record,'pushed',{commit:expectedCommit});
    } catch (error) { record.delivery.stage = 'push-unconfirmed'; record.delivery.error = error.message; await this.store.persist(); throw error; }
    return record.delivery;
  }
}
