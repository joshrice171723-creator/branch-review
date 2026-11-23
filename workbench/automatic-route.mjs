const visual = /\b(?:align|center|centre|colour|color|spacing|padding|margin|layout|typography|font|cosmetic|style|styling|position)\w*\b/i;
const behavioral = /\b(?:auth\w*|permission\w*|payment\w*|account\w*|security|migration\w*|dependenc\w*|schema|storage|persist\w*|capture|upload|send|submit|ipc|electron|server|api|route\w*|database|logic|handler\w*|install\w*|cache|workflow|accessibility)\b/i;
const scalar = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh)?|auto|normal|start|end|left|right|center|flex-start|flex-end|stretch|baseline|space-between|space-around|space-evenly)$/i;
const layoutProperty = /^(?:margin(?:-(?:block|inline|left|right|top|bottom)(?:-(?:start|end))?)?|padding(?:-(?:block|inline|left|right|top|bottom)(?:-(?:start|end))?)?|(?:row-|column-)?gap|top|right|bottom|left|inset(?:-inline|-block)?|text-align|align-(?:items|self|content)|justify-(?:items|self|content)|font-size|font-weight|line-height|letter-spacing)$/i;

export function cosmeticCandidate({plan, profile, quality, checks}) {
  if (profile?.active !== 'audited' || quality || !visual.test(plan) || behavioral.test(plan) ||
      checks.some(check => check.benchmark)) return null;
  const settings = profile.profiles.audited;
  if (settings.rules !== defaults.rules ||
      settings.sharedDocs.length || ['planReview', 'buildReview', 'finalReview'].some(key =>
    settings.stages[key].docs.some(name => name !== 'REVIEW.md') || settings.stages[key].toolHints?.length ||
    settings.stages[key].instructions !== defaults.stages[key].instructions)) return null;
  return checks.find(check => check.required && (check.phases ?? ['baseline', 'after']).includes('after') &&
    /(?:^|[_-])(?:ui|layout|visual|browser|desktop|playwright|e2e)(?:[_-]|$)/i.test(check.name))?.name ?? null;
}

export function cosmeticDiff(paths, patch) {
  if (paths.length !== 1 || !/\.css$/i.test(paths[0]) || behavioral.test(paths[0].replace(/[\/_-]/g, ' ')) ||
      !patch || patch.length > 12000 || /^(?:new file mode|deleted file mode|old mode|rename from)/m.test(patch)) return false;
  const edits = patch.split(/\r?\n/).filter(line => /^[+-](?![+-])/.test(line));
  return edits.length > 0 && edits.length <= 24 && edits.every(line => {
    const declaration = /^\s*([a-z-]+)\s*:\s*([^;]+);?\s*$/i.exec(line.slice(1));
    if (!declaration) return false;
    const [, name, raw] = declaration;
    const value = raw.trim();
    if (/^(?:color|background-color|border-color)$/i.test(name)) return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
    return layoutProperty.test(name) && value.split(/\s+/).every(part => scalar.test(part));
  });
}
import {WorkbenchProfile} from './profile.mjs';

const defaults = WorkbenchProfile.initial([]).profiles.audited;
