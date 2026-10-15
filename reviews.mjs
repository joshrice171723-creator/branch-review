import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const defaultManifest = { version: 1, title: 'Jordan Review · intake', scenarios: [{ id: 'intake', title: 'Partially completed intake', path: ':intake', steps: ['Compare the answer controls in Original and Changed.', 'Edit and save an answer in Changed.', 'Confirm Original retains its previous answer.', 'Reopen Changed and confirm the saved answer persists.'] }] };
export function validateManifest(value) {
  if (value?.version !== 1 || !Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > 12) throw new Error('Review manifest must contain 1–12 scenarios and version 1.');
  const ids = new Set();
  for (const item of value.scenarios) {
    if (!/^[a-z0-9-]{1,60}$/.test(item.id) || ids.has(item.id)) throw new Error('Scenario IDs must be unique lowercase names.');
    ids.add(item.id);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160) throw new Error('Each scenario needs a short title.');
    if (typeof item.path !== 'string' || !(item.path === ':intake' || /^\/clinic(?:[/?#]|$)/.test(item.path)) || /[\\\r\n]|%5c/i.test(item.path) || item.path.length > 500) throw new Error('Scenario destinations must stay inside /clinic.');
    if (item.path !== ':intake' && !/^\/clinic(?:\/|$)/.test(new URL(item.path, 'http://localhost').pathname)) throw new Error('Scenario destinations must stay inside /clinic.');
    if (!Array.isArray(item.steps) || !item.steps.length || item.steps.length > 20 || item.steps.some(s => typeof s !== 'string' || !s.trim() || s.length > 500)) throw new Error('Each scenario needs 1–20 short test steps.');
  }
  return { version: 1, title: String(value.title || 'Branch review').slice(0, 160), scenarios: value.scenarios.map(({id,title,path,steps}) => ({id,title,path,steps})) };
}
export function scenarioPath(scenario, fixture) {
  if (scenario.path === ':intake') return fixture.path;
  const match = /patients\/(\d+)\/encounters\/(\d+)/.exec(fixture.path);
  return scenario.path.replaceAll(':patientId', match?.[1] || '').replaceAll(':encounterId', match?.[2] || '');
}
export class ReviewStore {
  constructor(directory) { this.directory = directory; this.records = []; }
  async load() {
    await mkdir(this.directory, { recursive: true });
    this.records = JSON.parse(await readFile(path.join(this.directory, 'reviews.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '[]'; throw e; }));
    for (const record of this.records) {
      if (record.delivery?.stage === 'deploying') record.delivery.stage = 'deployment-needs-inspection';
      if (record.delivery?.stage === 'pushing') record.delivery.stage = 'push-unconfirmed';
    }
    await this.persist(); return this;
  }
  async persist() { const destination = path.join(this.directory, 'reviews.json'); await writeFile(destination + '.tmp', JSON.stringify(this.records, null, 2)); await rename(destination + '.tmp', destination); }
  async open(snapshot, manifest, recipeHash) {
    const identity = { repository: snapshot.repository, ref: snapshot.comparison.branch.ref, source: snapshot.comparison.branch.sha, base: snapshot.original.sha, changed: snapshot.changed.sha, scenarioHash: digest({manifest, recipeHash}) };
    const id = digest(identity);
    let record = this.records.find(r => r.id === id);
    if (!record) {
      const previous = this.records.findLast(r => r.identity.repository === identity.repository && r.identity.ref === identity.ref);
      record = { id, identity, manifest, title: snapshot.comparison.branch.subject, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: {}, issues: previous?.issues.filter(i => i.status !== 'resolved').map(i => ({ ...i, status: 'needs-retest', carriedFrom: previous.id })) || [], events: [], approval: null, integration: null, delivery: null };
      this.records.push(record); await this.persist();
    }
    return record;
  }
  get(id) { const record = this.records.find(r => r.id === id); if (!record) throw new Error('Review not found. Reopen the branch.'); return record; }
  summary() { return this.records.slice().reverse().map(r => ({ id:r.id, title:r.title, identity:r.identity, updatedAt:r.updatedAt, approval:r.approval, openIssues:r.issues.filter(i=>i.status!=='resolved').length, delivery:r.delivery })); }
  invalidate(record) { record.approval = null; }
  async event(record, type, detail) { record.updatedAt = new Date().toISOString(); record.events.push({ at:record.updatedAt,type,detail }); await this.persist(); return record; }
  async check(id, scenario, index, passed) {
    const r = this.get(id), item = r.manifest.scenarios.find(s => s.id === scenario);
    if (!item || !Number.isInteger(index) || index < 0 || index >= item.steps.length || typeof passed !== 'boolean') throw new Error('Invalid checklist item.');
    r.checks[`${scenario}:${index}`] = passed; this.invalidate(r); return this.event(r, 'check', {scenario,index,passed});
  }
  async issue(id, input) {
    const r = this.get(id);
    for (const key of ['expected','actual']) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 4000) throw new Error('Describe expected and actual behavior (up to 4,000 characters each).');
    if (!r.manifest.scenarios.some(s => s.id === input.scenario)) throw new Error('Choose a scenario for this finding.');
    const issue = { id:randomUUID(), expected:input.expected.trim(), actual:input.actual.trim(), scenario:input.scenario, side:input.side === 'original' ? 'original' : 'changed', status:'open', createdAt:new Date().toISOString(), commit:input.side === 'original' ? r.identity.base : r.identity.changed, location:String(input.location || '').slice(0,700), consoleErrors:Array.isArray(input.consoleErrors) ? input.consoleErrors.slice(-10).map(s=>String(s).slice(0,500)) : [] };
    if (input.screenshot) {
      if (typeof input.screenshot !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.screenshot)) throw new Error('Screenshot must be PNG.');
      const data = Buffer.from(input.screenshot.split(',')[1], 'base64');
      if (data.length > 5_000_000 || data.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Screenshot is invalid or larger than 5 MB.');
      await mkdir(path.join(this.directory,'screenshots'),{recursive:true});
      issue.screenshot = issue.id + '.png'; await writeFile(path.join(this.directory,'screenshots',issue.screenshot),data);
    }
    r.issues.push(issue); this.invalidate(r); return this.event(r,'issue-reported',{issue:issue.id});
  }
  async resolve(id, issueId, note) {
    const r = this.get(id), issue = r.issues.find(i => i.id === issueId);
    if (!issue || typeof note !== 'string' || !note.trim() || note.length > 2000) throw new Error('Record the retest result before resolving a finding.');
    issue.status = 'resolved'; issue.resolvedAt = new Date().toISOString(); issue.resolvedCommit = r.identity.changed; issue.resolution = note.trim(); this.invalidate(r); return this.event(r,'issue-resolved',{issue:issueId,note});
  }
  async approve(id, reviewer) {
    const r = this.get(id);
    if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 100) throw new Error('Enter the reviewer name.');
    if (r.issues.some(i => i.status !== 'resolved')) throw new Error('Resolve or retest every open finding before approval.');
    if (r.manifest.scenarios.some(s => s.steps.some((_,i) => !r.checks[`${s.id}:${i}`]))) throw new Error('Complete every scenario check before approval.');
    r.approval = { reviewer:reviewer.trim(), at:new Date().toISOString(), identity:digest(r.identity), commit:r.identity.changed };
    return this.event(r,'approved',{commit:r.identity.changed,reviewer:r.approval.reviewer});
  }
}
