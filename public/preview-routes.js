export function isPublicDestination(destination) {
  return typeof destination === 'string' && /^\/(?:meta-clinic|demo)?(?:[?#]|$)/.test(destination);
}
export function isReviewDestination(destination) {
  if (typeof destination !== 'string' || destination.length > 500 || /[\\\x00-\x20]|%5c/i.test(destination)) return false;
  if (!(isPublicDestination(destination) || /^\/(?:clinic(?:[/?#]|$)|qa(?:[?#]|$))/.test(destination))) return false;
  const pathname = destination.split(/[?#]/, 1)[0];
  if (/\/(?:\.|%2e){1,2}(?:\/|$)/i.test(pathname)) return false;
  const parsed = new URL(destination, 'http://localhost');
  return parsed.origin === 'http://localhost' && (isPublicDestination(parsed.pathname) || /^\/(?:clinic(?:\/|$)|qa$)/.test(parsed.pathname));
}
export function scenarioPath(scenario, fixture) {
  if (scenario.path === ':intake') return fixture.path;
  const match = /patients\/(\d+)\/encounters\/(\d+)/.exec(fixture?.path || '');
  return scenario.path.replaceAll(':patientId', match?.[1] || '').replaceAll(':encounterId', match?.[2] || '');
}
export function previewDestination(item,side,state) {
  return scenarioPath({...item,path:side==='original' && item.originalPath ? item.originalPath : item.path},state[side].scenario);
}
