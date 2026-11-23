// Probe only the selected, locally managed preview. Never follow an application redirect.
async function responseAt(url) {
  const response = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(3500)});
  await response.body?.cancel();
  return response;
}

function blocksFrame(headers, origin) {
  const policies = (headers.get('content-security-policy') || '').split(',');
  const rules = policies.flatMap(policy => policy.split(';').map(rule => rule.trim().split(/\s+/))
    .filter(tokens => tokens[0]?.toLowerCase() === 'frame-ancestors'));
  if (!rules.length) return /^(deny|sameorigin)$/i.test((headers.get('x-frame-options') || '').trim());
  // Only report an unambiguous denial. Chromium evaluates wildcard and scheme expressions.
  return rules.some(([, ...sources]) => sources.every(source =>
    ["'self'", "'none'"].includes(source) || /^https?:\/\/[\w.:-]+$/.test(source) && source !== origin));
}

export async function observeRuntime({preview, origin, desktop}) {
  const signals = [];
  const host = (id, title, error) => signals.push({owner: 'host', id, title, error});
  try {
    const health = await fetch(origin + '/api/workspace/design', {signal: AbortSignal.timeout(4500)});
    if (!health.ok) throw Error('HTTP ' + health.status);
    const design = await health.json();
    if (!Array.isArray(design.builds)) throw Error('The workspace returned an invalid design response.');
    host('workspace', 'Workspace API', '');
  } catch (error) { host('workspace', 'Workspace API', error.message); }
  let state = {};
  try {
    state = await preview();
    host('preview-manager', 'Preview manager', '');
  } catch (error) { host('preview-manager', 'Preview manager', error.message); }
  const managed = state.settings?.mode === 'web' && state.state !== 'external';
  const project = (id, title, error, extra) => signals.push({owner: 'project', id, title, error, ...extra});
  if (managed && state.state === 'exited') {
    project('process', 'Preview process', state.message || 'Process exited.', {restart: true, evidence: state.log?.slice(-2000)});
  } else if (managed && state.owned && (state.state !== 'starting' || Date.now() - (state.startedAt || 0) > 90000)) {
    const url = URL.parse(state.url);
    if (url?.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
      try {
        const response = await responseAt(url);
        project('process', 'Preview process', '');
        project('response', 'Preview response', response.status >= 400 ? 'HTTP ' + response.status + ' on ' + url.pathname : '');
        if (response.ok) project('embedding', 'Embedded preview',
          blocksFrame(response.headers, origin) ? 'The preview response prevents embedding by the workspace origin.' : '',
          {evidence: 'Managed preview parent (BRANCH_REVIEW_PREVIEW_PARENT): ' + origin +
            '. X-Frame-Options: ' + (response.headers.get('x-frame-options') || '(unset)') +
            '. Frame policy: ' + (response.headers.get('content-security-policy')?.match(/frame-ancestors[^;,]*/i)?.[0] || '(unset)')});
      } catch (error) {
        project('response', 'Preview response', error.message, {restart: true});
      }
    }
  }
  try {
    signals.push(...(await desktop?.observations(origin, state.owned ? state.url : '') || []));
    host('desktop-diagnostics', 'Desktop diagnostics', '');
  } catch (error) { host('desktop-diagnostics', 'Desktop diagnostics', error.message); }
  return signals;
}
