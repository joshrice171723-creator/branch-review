export function scenarioPath(scenario, fixture) {
  if (scenario.path === ':intake') return fixture.path;
  const match = /patients\/(\d+)\/encounters\/(\d+)/.exec(fixture.path);
  return scenario.path.replaceAll(':patientId', match?.[1] || '').replaceAll(':encounterId', match?.[2] || '');
}
export function previewDestination(item,side,state) {
  return scenarioPath({...item,path:side==='original' && item.originalPath ? item.originalPath : item.path},state[side].scenario);
}
