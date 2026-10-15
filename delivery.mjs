import { digest } from './reviews.mjs';

export class Delivery {
  constructor(git, store) { this.git = git; this.store = store; }
  async refs(record) {
    await this.git('fetch','origin');
    const main = await this.git('rev-parse','refs/remotes/origin/main');
    const source = await this.git('rev-parse',record.identity.ref);
    if (source !== record.identity.source) throw new Error('The branch changed. Reopen it and review the new commit.');
    return {main,source};
  }
  async candidate(record) {
    const {main,source} = await this.refs(record);
    const common = await this.git('merge-base',main,source);
    if (common === source) throw new Error('This branch is already included in main. There is nothing to merge.');
    let sha = source;
    if (common !== main) {
      if (record.integration?.main === main && record.integration.source === source) return record.integration;
      const output = await this.git('merge-tree','--write-tree',main,source).catch(e => { throw new Error('Merge conflict: resolve the branch against current main, then review again.\n' + e.message); });
      const tree = output.split('\n')[0];
      if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('Could not produce a merge candidate.');
      sha = await this.git('commit-tree',tree,'-p',main,'-p',source,'-m',`Merge reviewed branch ${record.identity.ref.replace('refs/heads/','')}`);
    }
    await this.git('update-ref',`refs/branch-review/${record.id}`,sha);
    record.integration = {main,source,sha,preparedAt:new Date().toISOString()};
    await this.store.event(record,'candidate-prepared',record.integration); return record.integration;
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
      await this.git('push','origin',`${expectedCommit}:refs/heads/main`);
      const actual = (await this.git('ls-remote','origin','refs/heads/main')).split(/\s/)[0];
      if (actual !== expectedCommit) throw new Error('Remote main differs after push. Outcome requires inspection.');
      record.delivery.stage = 'pushed'; await this.store.event(record,'pushed',{commit:expectedCommit});
    } catch (error) { record.delivery.stage = 'push-unconfirmed'; record.delivery.error = error.message; await this.store.persist(); throw error; }
    return record.delivery;
  }
}
