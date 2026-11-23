
export async function mount(root, hostOptions = {}) {
  const controller = new AbortController();
  const signal = hostOptions.signal ? AbortSignal.any([controller.signal,hostOptions.signal]) : controller.signal;
  const panelUrl = name => new URL(
    name.startsWith('api/') ? '/api/workspace/'+name.slice(4) :
      name === 'mcp' ? '/api/workspace/mcp' : '/workspace-assets/'+name, location.origin
  ).href;
  const timers = new Set();
  const container = document.createElement('div');
  container.hidden = true;
  const panelRoot = container.attachShadow({mode:'open'});
  const surface = document.createElement('div');
  surface.className = 'workbench-surface';
  const template = document.createElement('template');
  template.innerHTML = workspaceMarkup;
  surface.append(template.content);

  function setTimeout(callback, delay) {
    if (signal.aborted) return;
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  }
  function clearTimeout(timer) {
    timers.delete(timer);
    window.clearTimeout(timer);
  }
  const dispose = () => controller.abort();
  signal.addEventListener('abort', () => {
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    container.remove();
  }, {once:true});

  try {
    signal.throwIfAborted();
    const styles = workspaceStyles.map(name => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = panelUrl(name);
      const loaded = new Promise((resolve, reject) => {
        link.onload = resolve;
        link.onerror = () => reject(Error('Cannot load workspace styles.'));
        signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      });
      panelRoot.append(link);
      return loaded;
    });
    panelRoot.append(surface);
    root.append(container);
    const [workspace] = await Promise.all([createWorkbench(panelRoot,{
      dispose,embedded:true,hostOptions,panelUrl,signal,setTimeout,clearTimeout
    }),...styles]);
    signal.throwIfAborted();
    container.hidden = false;
    const shellHeader = document.querySelector("body > .topbar");
    const workspaceNav = surface.querySelector(".compact-nav");
    const measureHeaders = () => {
      surface.style.setProperty("--shell-header-height", (shellHeader?.offsetHeight || 0) + "px");
      surface.style.setProperty("--workspace-nav-height", workspaceNav.offsetHeight + "px");
    };
    const headerObserver = new ResizeObserver(measureHeaders);
    if (shellHeader) headerObserver.observe(shellHeader);
    headerObserver.observe(workspaceNav);
    signal.addEventListener("abort", () => headerObserver.disconnect(), {once:true});
    measureHeaders();
    return workspace;
  } catch (error) {
    dispose();
    throw error;
  }
}
