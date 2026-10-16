import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { qaManifest } from './qa-manifest.mjs';
import { canApprove, reviewCounts } from './public/review-model.js';
import { isReviewDestination } from './public/preview-routes.js';
import { prepareRetest } from './fix-review.mjs';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const defaultManifest = { version: 1, title: 'Jordan Review · intake', scenarios: [{ id: 'intake', title: 'Partially completed intake', path: ':intake', focus: 'Guided intake · staff assisted', steps: ['Compare the answer controls in Original and Changed.', 'Edit and save an answer in Changed.', 'Confirm Original retains its previous answer.', 'Reopen Changed and confirm the saved answer persists.'] }] };
export function scenarioRecipe(files = []) { return files.some(file => ['apps/api/app/services/qa/office_qa.rb','apps/web/src/features/qa/QaOfficeQa.tsx'].includes(file)) ? 'qa-scenario.rb' : 'scenario.rb'; }
export function manifestForFiles(files = []) {
  if(files.length && scenarioRecipe(files)!=='qa-scenario.rb' && !files.some(file=>/intake|Intake/.test(file)))throw new Error('This branch needs a QA plan for its changed files. Add a .branch-review.json with testing instructions and the destination screen; an unrelated checklist cannot be used.');
  return scenarioRecipe(files) === 'qa-scenario.rb' ? qaManifest : {...defaultManifest,summary:'Starter intake comparison. Confirm these checks cover this branch before approving it.',source:'Built-in intake scenario. No branch-specific review plan was supplied.'};
}
export function validateManifest(value) {
  if (![1,2].includes(value?.version) || !Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > 100) throw new Error('Review manifest must contain 1–100 items and version 1 or 2.');
  const ids = new Set();
  for (const item of value.scenarios) {
    if (!/^[a-z0-9-]{1,60}$/.test(item.id) || ids.has(item.id)) throw new Error('Scenario IDs must be unique lowercase names.');
    ids.add(item.id);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160) throw new Error('Each scenario needs a short title.');
    if (item.path !== ':intake' && !isReviewDestination(item.path)) throw new Error('Scenario destinations must stay inside /clinic, /qa, /, /meta-clinic or /demo.');
    if (!Array.isArray(item.steps) || !item.steps.length || item.steps.length > 20 || item.steps.some(s => typeof s !== 'string' || !s.trim() || s.length > 500)) throw new Error('Each scenario needs 1–20 short test steps.');
    for (const field of ['description','instructions','expected']) if (item[field] !== undefined && (typeof item[field] !== 'string' || item[field].length > 2000)) throw new Error('Item descriptions must be text up to 2,000 characters.');
    if (item.focus !== undefined && (typeof item.focus !== 'string' || item.focus.length > 160)) throw new Error('Item focus must be a short row identifier or heading.');
    if (item.originalPath !== undefined) validateManifest({version:1,scenarios:[{id:'original',title:'Original',path:item.originalPath,steps:['Open']}]});
    if(item.files!==undefined && (!Array.isArray(item.files)||item.files.length>100||item.files.some(file=>typeof file!=='string'||file.length>300||file.startsWith('/')||file.includes('..')||file.includes('\\'))))throw new Error('Affected files must be repository-relative paths.');
    if(item.viewport!==undefined && !['desktop','tablet','phone'].includes(item.viewport))throw new Error('Choose desktop, tablet or phone.');
  }
  return { version: value.version, title: String(value.title || 'Branch review').slice(0, 160), summary:String(value.summary || '').slice(0,2000), source:String(value.source || 'Committed review manifest').slice(0,300), scenarios: value.scenarios.map(({id,title,path,steps,description='',instructions='',expected='',focus='',originalPath,files,viewport}) => ({id,title,path,steps,description,instructions,expected,focus,...(originalPath?{originalPath}:{}),...(files?{files}:{}),...(viewport?{viewport}:{})})) };
}
export {scenarioPath} from './public/preview-routes.js';
export class ReviewStore {
  constructor(directory) { this.directory = directory; this.records = []; this.saved='[]'; }
  async load() {
    await mkdir(this.directory, { recursive: true });
    this.records = JSON.parse(await readFile(path.join(this.directory, 'reviews.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '[]'; throw e; }));
    this.saved=JSON.stringify(this.records);
    for (const record of this.records) {
      prepareRetest(record);
      if (record.delivery?.stage === 'deploying') record.delivery.stage = 'deployment-needs-inspection';
      if (record.delivery?.stage === 'pushing') record.delivery.stage = 'push-unconfirmed';
    }
    await this.persist(); return this;
  }
  async persist() {
    const destination = path.join(this.directory, 'reviews.json'), snapshot=JSON.stringify(this.records,null,2);
    try { await writeFile(destination + '.tmp',snapshot);await rename(destination + '.tmp', destination);this.saved=snapshot; }
    catch(error) { this.records=JSON.parse(this.saved);throw new Error(`Could not save review data. Your last saved results are unchanged. ${error.message}`,{cause:error}); }
  }
  async open(snapshot, manifest, recipeHash) {
    const identity = { repository: snapshot.repository, ref: snapshot.comparison.branch.ref, source: snapshot.comparison.branch.sha, base: snapshot.original.sha, changed: snapshot.changed.sha, scenarioHash: digest({manifest, recipeHash}) };
    const id = digest(identity);
    let record = this.records.find(r => r.id === id);
    if (!record) {
      const previous = this.records.findLast(r => r.identity.repository === identity.repository && (snapshot.previousReviewId ? r.id === snapshot.previousReviewId : r.identity.ref === identity.ref));
      record = { id, identity, manifest, title: snapshot.comparison.branch.subject, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: {}, items:{}, cursor:{itemId:manifest.scenarios[0].id,view:'item'}, previousId:previous?.id || null, issues: previous ? [...previous.issues,...(previous.publishedFindings || [])].filter(i => i.status !== 'resolved').map(i => ({ ...i, status: 'needs-retest', carriedFrom: previous.id })) : [], events: [], approval: null, integration: null, delivery: null };
      record.comparisonMode={baseline:snapshot.comparison.baseline || 'parent',baselineCommit:snapshot.comparison.baselineCommit};
      record.requestHistory=structuredClone(previous?.requestHistory || []);
      for (const [itemId, saved] of Object.entries(previous?.items || {})) {
        if (!['needs-fixes','blocked'].includes(saved.outcome)) continue;
        if (manifest.scenarios.some(item=>item.id===itemId)) record.items[itemId]={...saved,carriedFrom:previous.id};
        else record.issues.push({id:randomUUID(),expected:previous.manifest.scenarios.find(item=>item.id===itemId)?.expected || 'Resolve the previous review item.',actual:saved.reason,scenario:itemId,side:'changed',status:'needs-retest',createdAt:new Date().toISOString(),commit:previous.identity.changed,location:'',consoleErrors:[],carriedFrom:previous.id});
      }
      this.records.push(record); await this.persist();
    }
    let remapped=false;
    for(const issue of record.issues){
      if(issue.status==='resolved' || manifest.scenarios.some(item=>item.id===issue.scenario))continue;
      const prior=this.records.find(r=>r.id===(issue.carriedFrom || record.previousId));
      const old=prior?.manifest.scenarios.find(item=>item.id===issue.scenario);
      const matches=old?.files?.length ? manifest.scenarios.filter(item=>item.path===old.path && item.files?.some(file=>old.files.includes(file))) : [];
      if(matches.length!==1)continue;
      issue.previousScenario ||= issue.scenario;issue.scenario=matches[0].id;remapped=true;
    }
    if(remapped)await this.event(record,'findings-remapped',{reason:'Unique matching screen and affected source file in regenerated checklist'});
    return record;
  }
  get(id) { const record = this.records.find(r => r.id === id); if (!record) throw new Error('Review not found. Reopen the branch.'); return record; }
  summary() { return this.records.slice().reverse().map(r => ({ id:r.id, title:r.title, identity:r.identity, updatedAt:r.updatedAt, approval:r.approval, progress:reviewCounts(r), openIssues:r.issues.filter(i=>i.status!=='resolved').length, delivery:r.delivery })); }
  editable(record) { if (["published","verified"].includes(record.delivery?.stage)) throw new Error("Published reviews are read-only. Report a new published finding instead."); }
  invalidate(record) { record.approval = null; }
  async event(record, type, detail) { record.updatedAt = new Date().toISOString(); record.events.push({ at:record.updatedAt,type,detail }); await this.persist(); return record; }
  async check(id, scenario, index, passed) {
    const r = this.get(id), item = r.manifest.scenarios.find(s => s.id === scenario);
    if (!item || !Number.isInteger(index) || index < 0 || index >= item.steps.length || typeof passed !== 'boolean') throw new Error('Invalid checklist item.');
    this.editable(r);
    r.checks[`${scenario}:${index}`] = passed; this.invalidate(r); return this.event(r, 'check', {scenario,index,passed});
  }
  async item(id, itemId, input) {
    const r = this.get(id);
    this.editable(r);
    if (!r.manifest.scenarios.some(item=>item.id===itemId)) throw new Error('Review item not found.');
    if (!['','needs-fixes','blocked','not-applicable'].includes(input.outcome) || typeof input.notes !== 'string' || input.notes.length > 4000 || typeof input.reason !== 'string' || input.reason.length > 2000) throw new Error('Invalid item outcome or notes.');
    if (['blocked','not-applicable','needs-fixes'].includes(input.outcome) && !input.reason.trim()) throw new Error('Describe why this item needs attention or does not apply.');
    r.items ||= {};
    r.items[itemId] = {...r.items[itemId], outcome:input.outcome, notes:input.notes, reason:input.reason.trim(), updatedAt:new Date().toISOString()};
    this.invalidate(r); return this.event(r,'item-saved',{itemId,outcome:input.outcome});
  }
  async cursor(id, itemId, view = 'item') {
    const r = this.get(id);
    if (!r.manifest.scenarios.some(item=>item.id===itemId) || !['item','results'].includes(view)) throw new Error('Choose an existing review item.');
    this.editable(r);
    r.cursor = {itemId,view}; r.items ||= {}; r.items[itemId] ||= {};
    r.items[itemId].visitedAt ||= new Date().toISOString();
    await this.persist(); return r;
  }
  async issue(id, input) {
    const r = this.get(id);
    const published=input.side==='published';
    if(published && !['published','verified'].includes(r.delivery?.stage))throw new Error('Publish before reporting a published finding.');
    if(!published)this.editable(r);
    for (const key of ['expected','actual']) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 4000) throw new Error('Describe expected and actual behavior (up to 4,000 characters each).');
    if (!r.manifest.scenarios.some(s => s.id === input.scenario)) throw new Error('Choose a scenario for this finding.');
    const issue = { id:randomUUID(), expected:input.expected.trim(), actual:input.actual.trim(), scenario:input.scenario, side:published ? 'published' : input.side === 'original' ? 'original' : 'changed', status:'open', createdAt:new Date().toISOString(), commit:input.side === 'original' ? r.identity.base : r.identity.changed, location:String(input.location || '').slice(0,700), consoleErrors:Array.isArray(input.consoleErrors) ? input.consoleErrors.slice(-10).map(s=>String(s).slice(0,500)) : [] };
    if (input.screenshot) {
      if (typeof input.screenshot !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.screenshot)) throw new Error('Screenshot must be PNG.');
      const data = Buffer.from(input.screenshot.split(',')[1], 'base64');
      if (data.length > 5_000_000 || data.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Screenshot is invalid or larger than 5 MB.');
      await mkdir(path.join(this.directory,'screenshots'),{recursive:true});
      issue.screenshot = issue.id + '.png'; await writeFile(path.join(this.directory,'screenshots',issue.screenshot),data);
    }
    if(input.video){
      if(typeof input.video!=='string'||!/^data:video\/webm(?:;codecs=[\w,]+)?;base64,[A-Za-z0-9+/=]+$/.test(input.video))throw new Error('Recording must be WebM.');
      const data=Buffer.from(input.video.split(',')[1],'base64');if(data.length>5000000||data.subarray(0,4).toString('hex')!=='1a45dfa3')throw new Error('Recording is invalid or larger than 5 MB.');
      await mkdir(path.join(this.directory,'recordings'),{recursive:true});issue.video=issue.id+'.webm';await writeFile(path.join(this.directory,'recordings',issue.video),data);
    }
    if(published){(r.publishedFindings ||= []).push(issue);return this.event(r,'published-finding-reported',{issue:issue.id});}
    r.issues.push(issue); this.invalidate(r); return this.event(r,'issue-reported',{issue:issue.id});
  }
  async resolve(id, issueId, note) {
    const r = this.get(id), issue = r.issues.find(i => i.id === issueId);
    this.editable(r);
    if (!issue || typeof note !== 'string' || !note.trim() || note.length > 2000) throw new Error('Record the retest result before resolving a finding.');
    issue.status = 'resolved'; issue.resolvedAt = new Date().toISOString(); issue.resolvedCommit = r.identity.changed; issue.resolution = note.trim(); this.invalidate(r); return this.event(r,'issue-resolved',{issue:issueId,note});
  }
  async approve(id, reviewer) {
    const r = this.get(id);
    this.editable(r);
    if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 100) throw new Error('Enter the reviewer name.');
    if (r.issues.some(i => i.status !== 'resolved')) throw new Error('Resolve or retest every open finding before approval.');
    if (!canApprove(r)) throw new Error('Complete every scenario check and resolve blocked or failed items before approval.');
    r.approval = { reviewer:reviewer.trim(), at:new Date().toISOString(), identity:digest(r.identity), commit:r.identity.changed };
    return this.event(r,'approved',{commit:r.identity.changed,reviewer:r.approval.reviewer});
  }
}
