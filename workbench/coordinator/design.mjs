import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assetPattern, id, now, sentence} from './files.mjs';
import {objectReply, validPng} from './provider.mjs';
import {modelCatalog, WorkbenchProfile} from '../profile.mjs';

export const workspaceFile = '.harness/design/workspace.json';
export const stageKeys = {
  plan: 'plan', plan_review: 'planReview', baseline: 'checks', build: 'build', building: 'build',
  checks: 'checks', build_review: 'buildReview', final_review: 'finalReview', final_skip: 'finalReview', finish: 'verify'
};
export const selectedProfile = profile => profile?.profiles?.[profile.active];
export const hash = value => createHash('sha256').update(value).digest('hex');
export const jsonHash = value => hash(JSON.stringify(value));
export const questionContract = 'Return one unresolved question in question and at least two distinct, actionable answers in suggestions. Each suggestion must answer that question.';

function revision(state, payload) {
  if (state.revision !== payload.revision) throw Error('The draft changed. Reload the saved revision.');
}
export function checkMode(state, payload) {
  if (payload.mode != null && payload.mode !== (state.mode ?? 'roadmap')) throw Error('Save a draft for this workflow first.');
}

function roadmap(value) {
  if (!Array.isArray(value)) throw Error('Supply an ordered list of milestones.');
  const ids = new Set();
  function item(row) {
    if (!row || !/^[a-z0-9_-]{1,80}$/i.test(row.id ?? '') || ids.has(row.id)) throw Error('Each milestone and slice needs a unique ID.');
    ids.add(row.id);
    return {id: row.id, title: sentence(row.title, 'a title', 240)};
  }
  return value.map(row => {
    const milestone = item(row);
    if (!Array.isArray(row.slices)) throw Error('Supply the slices for each milestone.');
    return {...milestone, slices: row.slices.map(item)};
  });
}

function saveDraft(state, {plan, title, milestones, author}) {
  if (typeof plan !== 'string' || plan.length > 64000) throw Error('Enter a draft of at most 64000 characters.');
  const mode = title == null ? undefined : 'task';
  if (mode !== state.mode) {
    if (state.question || state.plannerRetry) throw Error('Resolve the planning decision before changing workflows.');
    state.attachments = {};
  }
  const fields = mode ? {mode, title} : {};
  if (!mode) {
    delete state.mode;
    delete state.title;
  }
  const rows = mode ? [{id: 'task-plan', title, slices: [{id: 'task', title}]}] : roadmap(milestones);
  const members = new Set(rows.flatMap(row => row.slices.map(slice => slice.id)));
  const attachments = Object.fromEntries(Object.entries(state.attachments).filter(([key]) => members.has(key)));
  const revision = state.revision + 1;
  Object.assign(state, {revision, plan, roadmap: rows, attachments, approved: null}, fields);
  state.revisions.push({revision, author, plan, roadmap: rows, attachments, time: now(), ...fields});
}

export function choices(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20 ||
      value.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 2000)) return [];
  const cleaned = value.map(choice => choice.trim());
  return new Set(cleaned.map(choice => choice.toLowerCase().replace(/\s+/g, ' '))).size === cleaned.length ? cleaned : [];
}

export async function resolveQuestion(reply, context, ask, limit = 3) {
  const question = sentence(reply.question, 'a planning question', 2000);
  let suggestions = choices(reply.suggestions);
  for (let attempt = 0; !suggestions.length && attempt < limit; attempt++) {
    const result = await ask('Keep the question unchanged. ' + questionContract +
      ' Return one JSON object.\n' + JSON.stringify({question, context}));
    let answer;
    try { answer = objectReply(result); }
    catch { continue; }
    if ((answer.question ?? question) === question) suggestions = choices(answer.suggestions);
  }
  if (!suggestions.length) throw Error('The planner could not supply distinct answers. Retry suggestions.');
  return {question, suggestions};
}

export function previewUrl(value) {
  if (typeof value !== 'string') throw Error('Enter an HTTPS app address or a local HTTP address.');
  if (!value.trim()) return '';
  const parsed = URL.parse(value);
  if (!parsed || parsed.username || parsed.password ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
    throw Error('Enter an HTTPS app address or a local HTTP address.');
  }
  return value.trim();
}

function contextOf(state) {
  return {
    plan: state.plan,
    conversation: state.messages.slice(-30),
    ...(state.mode === 'task' ? {mode: 'task', title: state.title} : {roadmap: state.roadmap})
  };
}

export function createDesign({files, store, git, agent, image, projectName, projectEvidence, qualityDraft, validateQuality,
  buildContext, retryBuildVerification}) {
  async function read() {
    const saved = await files.read(workspaceFile);
    if (saved) {
      return {assets: [], attachments: {}, builds: [], messages: [], revision: 0, revisions: [], question: null, ...saved};
    }
    return {revision: 0, plan: '', roadmap: [], approved: null, revisions: [], messages: [], question: null,
      assets: [], attachments: {}, builds: [], branch: await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''),
      preview: ''};
  }

  async function edit(change) {
    const release = await files.acquire('.harness/design/workspace.owner');
    try {
      const state = await read();
      await change(state);
      await files.write(workspaceFile, state);
      return state;
    } finally { await release(); }
  }

  async function layout(payload) {
    const file = '.harness/design/layout.json';
    if (!payload) return files.read(file, {});
    const options = {view: ['workflow', 'stages', 'history', 'live', 'documents', 'rules', 'quality'],
      tab: ['Plan', 'Mockups', 'Changes', 'Preview', 'Build'], panes: ['beside', 'stack']};
    if (!options[payload.name]?.includes(payload.value)) throw Error('Unknown project layout choice.');
    const release = await files.acquire('.harness/design/layout.owner');
    try {
      const result = {...await files.read(file, {}), [payload.name]: payload.value};
      await files.write(file, result);
      return result;
    } finally { await release(); }
  }

  async function asset(state, key) {
    if (!assetPattern.test(key ?? '') || (!state.assets.some(item => item.id === key) &&
        !state.conversations?.some(item => item.assetIds?.includes(key)))) throw Error('Unknown mockup version.');
    const file = '.harness/design/assets/' + key + '.png';
    const bytes = await files.bytes(file, 32_000_000);
    return {file, bytes};
  }

  function conversationSummary(state) {
    const build = state.builds.at(-1);
    return {
      title: state.title || state.messages.find(item => item.author === 'user')?.text.slice(0, 100) || 'Untitled change',
      status: build ? ({closed: 'Completed', retired: 'Retired', review: 'In review', working: 'Building',
        cancelling: 'Cancelling', ready: 'Ready to continue', cancelled: 'Cancelled', failed: 'Build failed',
        question: 'Build needs input'}[build.status] || build.status) :
        state.question || state.plannerRetry ? 'Planning needs input' :
        state.plan.trim() ? state.approved === state.revision ? 'Approved plan' : 'Draft plan' :
        state.messages.length ? 'Conversation' : 'New change',
      messageCount: state.messages.length
    };
  }

  async function conversations(query) {
    const state = await read();
    if (query.id !== undefined) {
      if (!assetPattern.test(query.id) || !state.conversations?.some(item => item.id === query.id))
        throw Error('Choose an archived conversation.');
      return files.read('.harness/design/conversations/' + query.id + '.json');
    }
    return {active: conversationSummary(state), archived: [...(state.conversations || [])].reverse()};
  }

  async function archive(payload) {
    const releases = [];
    try {
      for (const name of ['planner', 'guide', 'mockup']) releases.push(await files.acquire('.harness/design/' + name + '.owner'));
      return await edit(async state => {
        revision(state, payload);
        if (state.builds.some(build => !['closed', 'retired'].includes(build.status)))
          throw Error('Finish or retire the current build before archiving.');
        const draft = {};
        for (const field of ['title', 'plan', 'message']) {
          const value = payload.draft?.[field];
          if (typeof value === 'string' && value.trim()) {
            if (value.length > 64000) throw Error('The unsaved draft is too long to archive.');
            draft[field] = value;
          }
        }
        if (!(state.messages.length || state.plan || state.assets.length || state.builds.length || Object.keys(draft).length))
          throw Error('There is no conversation or plan to archive.');
        const entry = {...conversationSummary(state), id: id(), archivedAt: now(), revision: state.revision,
          approved: state.approved, buildIds: state.builds.map(build => build.id), assetIds: state.assets.map(asset => asset.id)};
        await files.write('.harness/design/conversations/' + entry.id + '.json', {...entry,
          plan: state.plan, messages: state.messages, revisions: state.revisions, assets: state.assets,
          question: state.question, plannerRetry: state.plannerRetry ?? null, draft});
        state.conversations = [...(state.conversations || []), entry];
        state.archivedBuilds = [...(state.archivedBuilds || []), ...state.builds];
        Object.assign(state, {conversationId: id(), revision: state.revision + 1, title: '', plan: '', roadmap: [],
          approved: null, messages: [], revisions: [], question: null, assets: [], attachments: {}, builds: []});
        delete state.plannerRetry;
      });
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  async function planner(profile, folder, prompt, images) {
    return (await agent({profile, folder, stage: 'plan', prompt, images})).text;
  }

  async function conversationProfile(settings) {
    const profile = await store.getProfile();
    if (settings === undefined) return profile;
    const {provider, model, effort} = settings ?? {};
    if (!['Codex', 'Muse'].includes(provider) ||
        (model !== '' && !modelCatalog[provider].models.includes(model)) ||
        !WorkbenchProfile.efforts.includes(effort)) throw Error('Select a conversation model and thinking level.');
    const copy = structuredClone(profile);
    Object.assign(selectedProfile(copy).stages.plan, {provider, model, effort});
    return copy;
  }

  async function plan(operation, payload) {
    const release = await files.acquire('.harness/design/planner.owner');
    try {
      let marker;
      let request;
      let folder;
      await edit(async state => {
        revision(state, payload);
        checkMode(state, payload);
        const pending = state.question;
        marker = state.plannerRetry;
        if (marker) {
          if (operation !== 'retry') throw Error('Retry the pending planner request first.');
          if (!assetPattern.test(marker.id)) throw Error('Select a recorded planning turn.');
          folder = '.harness/design/turns/' + marker.id;
          request = await files.read(folder + '/request.json');
          if (!request) throw Error('The recorded planner request is missing.');
          return;
        }
        if (operation === 'answer' && (pending?.id !== payload.id || !pending?.suggestions?.length)) {
          throw Error('This planning question has changed.');
        }
        if (operation === 'retry' && !pending?.error) throw Error('There is no pending planning retry.');
        if (operation === 'chat' && pending) throw Error('Resolve the pending decision first.');
        if (operation !== 'retry') {
          state.messages.push({id: id(), author: 'user', text: sentence(payload.message, 'a message'), time: now(),
            answers: operation === 'answer' ? pending.id : null});
        }
        marker = {id: id(), operation, error: 'Retry the pending planner request.'};
        folder = '.harness/design/turns/' + marker.id;
        request = {revision: state.revision, context: contextOf(state), profile: await conversationProfile(payload.conversationModel)};
        if (operation === 'retry') request.question = pending.question;
        await files.write(folder + '/request.json', request);
        state.plannerRetry = marker;
      });
      const {context} = request;
      const profile = request.profile ?? request.settings?.profile ?? await store.getProfile();
      const title = context.mode === 'task' ? context.title : undefined;
      const ask = prompt => planner(profile, folder, prompt);
      let decision;
      let answer;
      try {
        const prompt = 'Edit the shared draft to address the user message. Return one JSON object. ' + questionContract +
          ' If no decision is needed, return the complete plan and a brief message. ' +
          (title ? 'Use a Markdown Acceptance criteria heading and observable bullets.' : 'Retain the roadmap and existing IDs.') +
          '\n' + JSON.stringify(context);
        answer = request.question ? {question: request.question, suggestions: request.suggestions} : objectReply(await ask(prompt));
        if (Object.hasOwn(answer, 'question')) {
          request.question = sentence(answer.question, 'a planning question', 2000);
          request.suggestions = answer.suggestions;
          await files.write(folder + '/request.json', request);
          decision = await resolveQuestion(answer, context, ask, selectedProfile(profile)?.stages.planReview.limit);
        } else {
          sentence(answer.plan, 'a complete plan');
          if (!title) answer.roadmap = roadmap(answer.roadmap ?? context.roadmap);
        }
      } catch (error) {
        return edit(state => {
          state.plannerRetry = {...marker, error: error.message};
          if (request.question) state.question = {id: marker.id, question: request.question, suggestions: [], error: error.message};
        });
      }

      return edit(state => {
        delete state.plannerRetry;
        state.question = decision ? {...decision, id: marker.id} : null;
        let text = decision?.question ?? answer.message ?? 'Updated the draft.';
        if (!decision && state.revision === request.revision) {
          saveDraft(state, {plan: answer.plan, milestones: answer.roadmap, title, author: 'agent'});
        } else if (!decision) {
          state.messages.push({id: id(), author: 'agent', text: answer.plan, time: now(),
            ...(title ? {proposedTitle: title} : {proposedRoadmap: answer.roadmap})});
          text = 'The draft changed. Compare the proposal before saving it.';
        }
        state.messages.push({id: id(), author: 'agent', text: sentence(text, 'a planning reply'), time: now(),
          ...(decision ? {decision: marker.id, suggestions: decision.suggestions} : {})});
      });
    } finally { await release(); }
  }

  async function mockup(payload) {
    const release = await files.acquire('.harness/design/mockup.owner');
    try {
      const state = await read();
      revision(state, payload);
      const text = sentence(payload.message, 'a mockup request');
      const {target, screenshot, keep} = payload;
      const page = target === 'Project preview' && typeof payload.referencePage === 'string'
        ? payload.referencePage.slice(0, 400) : undefined;
      if (target !== undefined && !['Project preview', 'Plan', 'Preview', 'Build'].includes(target)) throw Error('Choose a target screen.');
      if (target && (typeof screenshot !== 'string' || screenshot.length > 8_000_000 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot))) throw Error('Attach a screenshot of the target screen.');
      const reference = target ? Buffer.from(screenshot.slice('data:image/png;base64,'.length), 'base64') : undefined;
      const profile = await store.getProfile();
      const provider = selectedProfile(profile)?.stages.plan.provider;
      const previous = payload.asset ? await files.path((await asset(state, payload.asset)).file) : undefined;
      const prompt = target
        ? 'Edit the attached screenshot. Preserve the visible layout and controls outside the requested change. Do not add navigation or sample conversation.\n' +
          JSON.stringify({target, page, project: projectName, request: text,
            keep: typeof keep === 'string' ? keep.slice(0, 3000) : '', plan: state.plan})
        : JSON.stringify({request: text, ...contextOf(state)});
      const data = await image({provider, previous, reference, prompt});
      const key = id();
      return edit(async current => {
        await files.write('.harness/design/assets/' + key + '.png', data);
        current.assets.push({id: key, parent: payload.asset ?? null, prompt: text, time: now(),
          ...(target && {target, page, planRevision: state.revision})});
        current.messages.push({id: id(), author: 'user', text, time: now()},
          {id: id(), author: 'agent', text: 'Mockup generated.', asset: key, time: now()});
      });
    } finally { await release(); }
  }

  async function guide(payload) {
    const release = await files.acquire('.harness/design/guide.owner');
    try {
      const state = await read();
      revision(state, payload);
      const text = sentence(payload.message, 'a message');
      if (!payload.context || typeof payload.context !== 'object' || Array.isArray(payload.context)) {
        throw Error('Supply the current Workbench context.');
      }
      const fields = ['view', 'tab', 'section', 'id', 'label', 'kind', 'reviewId', 'commit', 'ref', 'scenarioId', 'scenarioTitle', 'route', 'projectPage'];
      const screen = Object.fromEntries(fields.filter(key => typeof payload.context[key] === 'string')
        .map(key => [key, payload.context[key].slice(0, 400)]));
      const build = await buildContext?.(state.builds.at(-1));
      const command = !payload.preparePlan && !payload.changeScreenshot ?
        text.trim().toLowerCase().replace(/[?.]+$/, '') : '';
      if (['/status', 'build status', 'what is the build status', 'why did the build stop', '/retry-verification'].includes(command)) {
        let reply = 'There is no current build for this project.';
        if (build && command === '/retry-verification') {
          try {
            await retryBuildVerification(build.id);
            reply = 'Verification restarted for “' + build.title + '” using the existing changes.';
          } catch (error) {
            reply = error.message;
          }
        } else if (build) {
          const position = build.stage ? ' at ' + build.stage : '';
          const status = build.waitingForReview ? 'Waiting for Branch Review' :
            ({failed: 'Stopped' + position, cancelled: 'Cancelled' + position, question: 'Waiting for your answer',
              working: 'Running' + position, cancelling: 'Cancelling' + position, closed: 'Complete'})[build.state] ??
            ('Current stage' + position);
          reply = ['“' + build.title + '” · ' + status, build.failure, build.resumeBlocker, build.pendingQuestion,
            !build.failure && build.activity].filter(Boolean).join('\n\n');
        }
        return edit(current => {
          current.messages.push({id: id(), author: 'user', text, context: screen, time: now()},
            {id: id(), author: 'agent', coordinator: true, text: reply, context: screen, time: now()});
        });
      }
      const quality = screen.view === 'quality' ? await qualityDraft?.() : null;
      const taskMode = payload.mode === 'task' || state.mode === 'task';
      const context = {activeProject: projectName, conversationOpen: true, screen, ...contextOf(state),
        mode: taskMode ? 'task' : 'roadmap', approved: state.approved === state.revision,
        branch: state.branch, preview: state.preview, message: text, build,
        ...(quality ? {quality: quality.definition} : {})};
      if (quality || ['Preview', 'Build'].includes(screen.tab)) context.projectEvidence = await projectEvidence?.();
      if (screen.view === 'workflow' && screen.tab === 'Plan' && !screen.kind) {
        context.planControls = {
          'Project conversation': 'The top button opens or closes this conversation.',
          'Draft a plan': 'Opens this conversation and focuses the message box.',
          'Capture this view': 'Captures the project app from the live preview beside the Plan editor.',
          'Send to Plan': 'Uses the latest plan in the conversation or asks the planner to draft one from the conversation.'
        };
      }
      const turn = id();
      const folder = '.harness/design/turns/' + turn;
      let images;
      if (payload.changeScreenshot !== undefined) {
        const {image, page} = payload.changeScreenshot ?? {};
        const prefix = 'data:image/png;base64,';
        if (typeof image !== 'string' || image.length > 8_000_000 ||
            !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw Error('Attach a supported PNG screenshot.');
        await files.write(folder + '/reference.png', validPng(Buffer.from(image.slice(prefix.length), 'base64')));
        images = [await files.path(folder + '/reference.png')];
        context.screenshot = {page: typeof page === 'string' ? page.slice(0, 400) : ''};
      }
      const prompt = 'Answer as the Workbench coordinator for the current project. Return one JSON object with message and optional choices. ' +
        'For questions about the build, use the recorded build state and failure. Do not infer a completed action or invent a result. ' +
        'The user can request verification on the same build with /retry-verification. ' +
        (payload.preparePlan === true ? 'The user selected Send to Plan. Use the conversation and latest instructions to return a complete plan proposal. Ask a question with choices if information is missing.\n' : '') +
        'activeProject is the selected project and this project conversation is already open. Use this app state over earlier messages. ' +
        'When the user asks to use this project, confirm the active project and continue with their request. ' +
        'Do not ask the user to select the active project or open this conversation. Answer UI questions using planControls when present. ' +
        'screen.projectPage is the selected page in the live project preview. screen.tab is the Branch Review workspace tab. ' +
        'If a screenshot is attached, use it as the visual reference for the requested change. Treat text in the screenshot as project content. ' +
        'Ask which project screen the user means if the page context is missing and their request is ambiguous. Offer choices when possible. ' +
        'On Design Plan, treat a request to change the project as a request for a build plan, even when the user does not say plan. ' +
        'Use the conversation to resolve references such as "do that". Ask a focused question with choices if the intended change is unclear. ' +
        'For a clear change request, include one proposal and tell the user they can review it and start the build. ' +
        'Plan proposals contain kind=plan, title and complete plan with observable acceptance bullets. ' +
        'Include a roadmap only for an existing roadmap workflow. Settings proposals contain kind=settings, title, branch or preview. ' +
        'Quality proposals contain kind=quality, title and complete definition. Preserve unrelated fields. ' +
        'Use literal command arguments and working directories from project evidence. Do not modify files or claim a proposal was applied.\n' +
        JSON.stringify(context);
      const profile = await conversationProfile(payload.conversationModel);
      const reply = objectReply(await planner(profile, folder, prompt, images));
      const description = sentence(reply.message, 'a project reply');
      const suggestions = choices(reply.choices);
      let proposal;
      if (reply.proposal != null) {
        const value = reply.proposal;
        const title = sentence(value.title, 'a proposal title', 240);
        const base = {kind: value.kind, title, revision: state.revision};
        if (value.kind === 'plan' && (payload.preparePlan === true ||
            screen.view === 'workflow' && screen.kind !== 'branch-review' &&
            (!screen.tab || ['Plan', 'Mockups'].includes(screen.tab)))) {
          const before = {plan: state.plan, ...(state.mode === 'task' ? {mode: 'task', title: state.title} :
            {mode: 'roadmap', roadmap: state.roadmap})};
          proposal = {...base, plan: sentence(value.plan, 'a proposed plan'), before,
            ...(taskMode ? {mode: 'task'} : {roadmap: roadmap(value.roadmap)})};
        } else if (value.kind === 'settings') {
          const settings = {};
          if (Object.hasOwn(value, 'branch')) settings.branch = sentence(value.branch, 'a branch', 240);
          if (Object.hasOwn(value, 'preview')) settings.preview = previewUrl(sentence(value.preview, 'an app address', 2000));
          if (!Object.keys(settings).length) throw Error('Choose an app address or a branch.');
          proposal = {...base, fields: settings, before: Object.fromEntries(Object.keys(settings).map(key => [key, state[key]]))};
        } else if (value.kind === 'quality' && quality && validateQuality) {
          const validated = await validateQuality(value.definition);
          proposal = {...base, definition: validated.definition, before: quality.definition,
            revision: quality.revision, baseRevision: quality.base_revision};
        } else {
          throw Error('The proposal does not match this screen.');
        }
      }
      return edit(current => {
        current.messages.push({id: id(), author: 'user', text, context: screen, time: now()},
          {id: turn, author: 'agent', text: description, context: screen, time: now(),
            ...(suggestions.length ? {choices: suggestions} : {}), ...(proposal ? {proposal} : {})});
      });
    } finally { await release(); }
  }

  async function update(operation, payload) {
    if (['chat', 'answer', 'retry'].includes(operation)) return plan(operation, payload);
    if (operation === 'guide') return guide(payload);
    if (operation === 'image') return mockup(payload);
    if (operation === 'layout') return layout(payload);
    return edit(async state => {
      revision(state, payload);
      if (operation === 'draft') {
        const mode = payload.mode ?? (state.mode !== 'task' && Array.isArray(payload.roadmap) ? 'roadmap' : 'task');
        if (!['task', 'roadmap'].includes(mode)) throw Error('Select the task workflow.');
        if (mode === 'roadmap' && state.mode === 'task' &&
            !state.revisions.some(row => !row.mode && row.plan === payload.plan && isDeepStrictEqual(row.roadmap, payload.roadmap)) &&
            !(payload.plan === '' && payload.roadmap?.length === 0)) throw Error('Use one task plan for a new change.');
        const title = mode === 'task' ? sentence(payload.title, 'a task title', 240) : undefined;
        saveDraft(state, {title, plan: payload.plan, milestones: payload.roadmap, author: 'user'});
      } else if (operation === 'attach') {
        checkMode(state, payload);
        await asset(state, payload.asset);
        const member = state.mode === 'task' ? 'task' : payload.slice;
        if (!state.roadmap.some(row => row.slices.some(slice => slice.id === member))) throw Error('Save the task plan before attaching a mockup.');
        state.attachments[member] = payload.asset;
        saveDraft(state, {plan: state.plan, title: state.title, milestones: state.roadmap, author: 'user'});
      } else if (operation === 'approve') {
        checkMode(state, payload);
        if (!state.plan.trim() || state.question || state.plannerRetry || (state.mode !== 'task' &&
            (!state.roadmap.length || state.roadmap.some(row => !row.slices.length)))) {
          throw Error('Resolve planning and save the plan before approval.');
        }
        state.approved = state.revision;
      } else if (operation === 'settings') {
        const expected = payload.expected ?? {};
        if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
            Object.entries(expected).some(([key, value]) => !['branch', 'preview', 'reviewHost'].includes(key) ||
              !isDeepStrictEqual(state[key] ?? '', value))) throw Error('Design settings changed. Reload them before saving.');
        if (Object.hasOwn(payload, 'branch')) {
          if (typeof payload.branch !== 'string' || payload.branch.length > 240) throw Error('Enter a branch.');
          if (payload.branch) await git('check-ref-format', 'refs/heads/' + payload.branch);
          state.branch = payload.branch;
        }
        if (Object.hasOwn(payload, 'preview')) state.preview = previewUrl(payload.preview);
      } else {
        throw Error('Unknown Design operation.');
      }
    });
  }

  return {read, edit, layout, update, asset, archive, conversations};
}
