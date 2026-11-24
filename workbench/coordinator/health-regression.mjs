const readOnlyPaths = new Set(['/api/workspace/design', '/api/workspace/profile', '/api/workspace/coordinator/health',
  '/api/project-settings', '/api/project-delivery', '/api/tools-settings', '/api/branches', '/api/history', '/api/jobs',
  '/api/onboarding', '/api/workbench-runs']);
const observationId = /^(?:renderer|responsive|render:\/[^\s?#]*|load:\/[^\s?#]*|page:\/[^\s?#]*|request:(?:GET|POST) \/[^\s?#]*|operation:[a-f0-9]{64})$/;

export function operationRegression(id, readPath) {
  return healthRegression(readOnlyPaths.has(readPath) ? {kind:'http',path:readPath,status:200,json:true} : {kind:'observation',id});
}

export function healthRegression(value) {
  if (value == null) return null;
  if (value.kind === 'observation' && typeof value.id === 'string' && value.id.length <= 400 && observationId.test(value.id)) {
    return {kind: 'observation', id: value.id};
  }
  if (value.kind === 'http' && readOnlyPaths.has(value.path) && value.status === 200) {
    return {kind: 'http', path: value.path, status: 200, ...(value.json === true && {json: true})};
  }
  throw Error('Choose an exact desktop observation or a supported read-only Branch Review HTTP check.');
}

export async function verifyHostHttpRegression({probe, origin, signal, request = fetch}) {
  const check = healthRegression(probe);
  if (check?.kind !== 'http') throw Error('Choose a supported Branch Review HTTP check.');
  const address = URL.parse(origin);
  if (!address || address.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) ||
      address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw Error('Use the local Branch Review origin for its regression check.');
  }
  const response = await request(new URL(check.path, address).href, {method: 'GET', redirect: 'manual', signal});
  if (response.status === check.status && check.json) {
    try {
      const body = await response.json();
      if (body !== null && typeof body !== 'object' || body?.error) throw Error('The response does not contain a successful JSON result.');
      return {passed: true, detail: 'The affected settings or list opened successfully.'};
    } catch {
      return {passed: false, detail: 'The affected action returned an invalid response.'};
    }
  }
  await response.body?.cancel();
  return {passed: response.status === check.status,
    detail: 'GET ' + check.path + ' returned HTTP ' + response.status + '.'};
}
