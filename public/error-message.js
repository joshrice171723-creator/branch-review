export function describeError(message) {
  if (!message) return {summary:'',technical:''};
  const separator='\n\nTechnical details\n';
  const index=message.indexOf(separator);
  if(index>=0) return {summary:message.slice(0,index),technical:message.slice(index+separator.length)};
  if (/filename too long|file name too long/i.test(message)) return {summary:'A project file path is too long for Git. Retry after updating Branch Review. If it still fails, move the development workspace to a shorter path.',technical:message};
  if (/runtime validation failed: pnpm|\[FAIL\] pnpm/i.test(message)) return {summary:'The preview needs a different pnpm version. Check the project’s pinned version and configured toolchain, then retry.',technical:message};
  if (/^(?:git|python|ruby|node|docker) (?:exited|failed)/i.test(message) || message.length>500 || message.split('\n').length>5) return {summary:'That action could not be completed. Check the details below, then retry.',technical:message};
  return {summary:message,technical:''};
}
