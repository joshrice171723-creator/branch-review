const {webFrameMain} = require('electron');
const {createHash} = require('node:crypto');

exports.createRuntimeDiagnostics = function () {
  const events = new Map();
  let window, origin;
  let unresponsive = false;
  const networkSuspended = error => /\bERR_NETWORK_IO_SUSPENDED\b/.test(error || '');
  const appUrl = value => {
    const url = URL.parse(value);
    return url?.origin === origin ? url : null;
  };
  function record(id, title, error, evidence, extra = {}) {
    if (events.size >= 128 && !events.has(id)) {
      const firstSuccess = [...events.values()].find(row => !row.error);
      if (!firstSuccess && !error) return;
      events.delete(firstSuccess?.id ?? events.keys().next().value);
    }
    const signal = {owner: 'host', id, title, error: String(error || '').slice(0, 1200), evidence,
      occurredAt: Date.now(), ...extra};
    events.set(id, signal);
    return signal;
  }
  return {
    async operation(name, identity, error, evidence = '', readPath, workspace) {
      const id = 'operation:' + createHash('sha256').update(JSON.stringify([name,identity])).digest('hex');
      const signal = record(id, name, error?.message ?? error, evidence, {source: 'operation', readPath, workspace,
        nextAction: error?.nextAction || error?.userAction || error?.action});
      if (signal?.error) await this.onOperationFailure?.(signal);
    },
    verifyPreview: require('./preview-health.cjs').verifyPreview,
    attach(target, hostOrigin) {
      window = target;
      origin = hostOrigin;
      const contents = target.webContents;
      target.on('unresponsive', () => { unresponsive = true; });
      target.on('responsive', () => { unresponsive = false; });
      contents.on('console-message', event => {
        const url = appUrl(event.frame?.url);
        if (event.level === 'error' && url && !networkSuspended(event.message)) {
          // Chromium also logs our handled API responses to the console. Their server actions already have owners.
          if (appUrl(event.sourceId)?.pathname.startsWith('/api/') &&
              /^Failed to load resource: the server responded with a status of 4\d\d\b/.test(event.message)) return;
          record('page:' + url.pathname, 'Page ' + url.pathname, event.message, event.sourceId && 'Source: ' + event.sourceId);
        }
      });
      contents.on('did-fail-load', (_event, code, message, value) => {
        const url = appUrl(value);
        if (url && code !== -3 && !networkSuspended(message)) record('load:' + url.pathname, 'Page load ' + url.pathname, message);
      });
      contents.on('did-start-navigation', details => {
        const url = appUrl(details?.url);
        if (url && !details.isSameDocument) events.delete('page:' + url.pathname);
      });
      contents.on('did-frame-finish-load', (_event, _main, pid, rid) => {
        const url = appUrl(webFrameMain.fromId(pid, rid)?.url);
        if (url) record('load:' + url.pathname, 'Page load ' + url.pathname, '');
      });
      const filter = {urls: ['http://127.0.0.1/*']};
      function request(details, error) {
        if (details.webContentsId !== contents.id) return;
        const initiator = details.initiatorOrigin || appUrl(details.frame?.url)?.origin;
        if (initiator !== origin) return;
        const url = appUrl(details.url);
        if (!url || url.pathname === '/api/workspace/coordinator/health') return;
        const title = details.method + ' ' + url.pathname;
        record('request:' + title, title, error);
      }
      contents.session.webRequest.onCompleted(filter, details => {
        if (details.statusCode >= 500 || (details.statusCode === 404 && ['script','stylesheet'].includes(details.resourceType))) {
          request(details, 'HTTP ' + details.statusCode);
        } else if (details.statusCode < 400) request(details, '');
      });
      contents.session.webRequest.onErrorOccurred(filter, details => {
        if (details.error !== 'net::ERR_ABORTED' && !networkSuspended(details.error)) request(details, details.error);
      });
    },
    rendererUnavailable() {
      return unresponsive || window?.webContents.isCrashed();
    },
    async observations() {
      if (!window || window.isDestroyed()) return [...events.values()];
      const crashed = window.webContents.isCrashed();
      const rows = [...events.values()].map(row => ({...row}));
      const loaded = !crashed && appUrl(window.webContents.mainFrame?.url) && !window.webContents.isLoadingMainFrame();
      if (crashed || loaded) rows.push({owner: 'host', id: 'renderer', title: 'Workspace renderer',
        error: crashed ? 'The workspace renderer crashed.' : '', restart: true});
      if (unresponsive || loaded) rows.push({owner: 'host', id: 'responsive', title: 'Workspace responsiveness',
        error: unresponsive ? 'The desktop window is unresponsive.' : '', restart: true});
      if (unresponsive || crashed) return rows;
      for (const frame of window.webContents.mainFrame.framesInSubtree) {
        const address = appUrl(frame.url);
        if (!address || frame.detached) continue;
        let timer;
        try {
          const blank = await Promise.race([
            frame.executeJavaScript(`document.readyState === 'complete' && document.body ? (
              !document.body.innerText.trim() &&
              !document.body.querySelector('canvas,svg,img,video,iframe,input,textarea,button,[role=application]')
            ) : null`),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })
          ]);
          if (typeof blank === 'boolean') rows.push({owner: 'host', id: 'render:' + address.pathname,
            title: 'Rendered page ' + address.pathname, error: blank ? 'The loaded page contains no visible content or controls.' : ''});
        } catch { /* A detached or navigating frame has no current observation. */ }
        finally { clearTimeout(timer); }
      }
      return rows;
    }
  };
};
