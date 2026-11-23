import {WorkbenchProfile, modelCatalog} from '../profile.mjs';
import {toolDescriptions, selectStageTools} from '../mcp.mjs';

export function workflowProfile(profile, setup) {
  const copy = structuredClone(profile);
  const stages = copy.profiles[copy.active].stages;
  for (const [key, choice] of Object.entries(setup.stages)) {
    const stage = stages[key];
    if (!stage || stage.provider === 'Workbench') continue;
    if (!WorkbenchProfile.stageProviders(key, modelCatalog).includes(choice.provider) ||
        !modelCatalog[choice.provider].models.includes(choice.model) ||
        !WorkbenchProfile.efforts.includes(choice.effort) || typeof choice.shellTools !== 'boolean' ||
        !Array.isArray(choice.toolHints) || choice.toolHints.some(name =>
          !toolDescriptions().some(tool => tool.name === name && tool.stageAllowed && (!tool.app || profile.permittedTools?.includes(name))))) {
      throw Error('Coordinator selected unavailable stage settings. Prepare the plan again.');
    }
    if (stage.shellTools === false && choice.shellTools) throw Error('The saved stage disables shell access.');
    if (Array.isArray(stage.toolHints) && choice.toolHints.some(name => !stage.toolHints.includes(name))) {
      throw Error('Coordinator selected a tool outside the saved stage permissions.');
    }
    Object.assign(stage, {provider: choice.provider, model: choice.model, effort: choice.effort,
      shellTools: choice.shellTools, toolHints: choice.toolHints});
  }
  WorkbenchProfile.validate(copy);
  return copy;
}

export async function selectWorkflow({profile, plan, ask, checkProviders}) {
  const roles = WorkbenchProfile.roles.filter(role => role.kind !== 'Gate');
  const tools = toolDescriptions().filter(tool => tool.stageAllowed && (!tool.app || profile.permittedTools?.includes(tool.name)));
  const availableModels = {};
  for (const provider of ['Codex', 'Muse']) {
    const candidate = structuredClone(profile);
    for (const stage of Object.values(candidate.profiles[candidate.active].stages)) {
      if (stage.provider !== 'Workbench') stage.provider = provider;
    }
    const checks = await checkProviders(candidate);
    if (checks.every(row => ['ready', 'unverified'].includes(row.status))) availableModels[provider] = modelCatalog[provider];
  }
  if (!availableModels.Codex) throw Error('Codex must be available to build this project.');
  const prompt = 'Choose execution settings for every stage of this approved project change. Return JSON with stages keyed by ' +
    roles.map(role => role.id).join(', ') + '. Each stage has provider, model, effort, shellTools, toolHints, and reason. ' +
    'Select from the supplied models and tools. Build must use Codex. Prefer gpt-6.2-sol with low or medium effort for routine work. ' +
    'Use Astra and high effort only for demonstrated complexity or risk. Keep audits independent and read-only. ' +
    'Select only useful tools. Give one short plain-English reason per stage. Keep existing audit routes, enabled stages, and loop limits.\n' +
    JSON.stringify({plan, models: availableModels, tools, stages: profile.profiles[profile.active].stages});
  const reply = await ask(prompt);
  const stages = {};
  for (const role of roles) {
    const stageName = ({planReview:'plan_review',buildReview:'build_review',finalReview:'final_review'})[role.id] || role.id;
    stages[role.id] = reply?.stages?.[role.id] ?? {provider:'Codex',model:'gpt-6.2-sol',
      effort:role.id === 'build' ? 'medium' : 'low', shellTools:role.id === 'build',
      toolHints:selectStageTools(stageName, undefined, {scope:plan}).filter(name => tools.some(tool=>tool.name===name)),
      reason:'Use the lighter model for this stage and escalate if evidence requires it.'};
    const choice = stages[role.id];
    const saved = profile.profiles[profile.active].stages[role.id];
    if (choice.provider === 'Muse') {
      choice.shellTools = false;
      choice.toolHints = [];
    }
    if (saved.shellTools === false) choice.shellTools = false;
    if (Array.isArray(saved.toolHints) && Array.isArray(choice.toolHints)) {
      choice.toolHints = choice.toolHints.filter(name => saved.toolHints.includes(name));
    }
    if (!availableModels[choice.provider]) throw Error('Coordinator selected an unavailable provider. Prepare the plan again.');
    if (typeof choice.reason !== 'string' || !choice.reason.trim() || choice.reason.length > 500) {
      throw Error('Coordinator must explain each stage choice.');
    }
  }
  const setup = {plan, stages};
  const selected = workflowProfile(profile, setup);
  const readiness = await checkProviders(selected);
  const unavailable = readiness.filter(row => !['ready','unverified'].includes(row.status));
  if (unavailable.length) throw Error(unavailable.map(row=>row.message).join(' '));
  return setup;
}
