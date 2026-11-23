// Retain runtime faults until the same document loads again. Navigation elsewhere is not a retest.
exports.createRuntimeDiagnostics = function () {
  const pages = new Map();
  let window, hostOrigin;
  let unresponsive = false;
  const page = value => {
    const url = URL.parse(value);
    return url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.origin + url.pathname : null;
  };
  function record(url, detail) {
    const key = page(url);
    if (!key) return;
    if (pages.size >= 128 && !pages.has(key)) pages.delete(pages.keys().next().value);
    pages.set(key, String(detail).slice(0, 1200));
  }
  return {
    attach(target, origin) {
      window = target;
      hostOrigin = origin;
      const contents = target.webContents;
      target.on('unresponsive', () => { unresponsive = true; });
      target.on('responsive', () => { unresponsive = false; });
      contents.on('console-message', event => {
        if (event.level === 'error') record(event.frame?.url || event.sourceId, event.message);
      });
      contents.on('did-fail-load', (_event, code, message, url) => {
        if (code !== -3) record(url, message);
      });
      contents.on('did-start-navigation', details => {
        if (details && !details.isSameDocument && pages.has(page(details.url))) pages.set(page(details.url), null);
      });
      contents.session.webRequest.onCompleted({urls: ['http://127.0.0.1/*', 'http://localhost/*']}, details => {
        if (details.webContentsId !== contents.id || !['xhr','script','stylesheet','image','font'].includes(details.resourceType)) return;
        const url = page(details.url);
        if (!url) return;
        const key = url + '#request';
        if (details.statusCode >= 500 || (details.statusCode === 404 && details.resourceType !== 'xhr')) {
          pages.set(key, 'HTTP ' + details.statusCode + ' loading ' + details.resourceType);
        } else if (details.statusCode < 400) pages.set(key, '');
        if (pages.size > 128) pages.delete(pages.keys().next().value);
      });
      contents.on('did-frame-finish-load', (_event, _main, pid, rid) => {
        const frame = require('electron').webFrameMain.fromId(pid, rid);
        const key = page(frame?.url);
        if (key && !pages.get(key)) record(key, '');
      });
    },
    async observations(origin, previewUrl) {
      if (!window || window.isDestroyed()) return [];
      const preview = URL.parse(previewUrl)?.origin;
      const rows = [{owner: 'host', id: 'renderer', title: 'Workspace renderer',
        error: window.webContents.isCrashed() ? 'The workspace renderer crashed.' : '', restart: true}];
      rows.push({owner: 'host', id: 'responsive', title: 'Workspace responsiveness',
        error: unresponsive ? 'The desktop window is unresponsive.' : ''});
      for (const [url, error] of pages) {
        const address = new URL(url);
        const owner = address.origin === origin ? 'host' : address.origin === preview ? 'project' : '';
        if (owner && error !== null) rows.push({owner, id: 'page:' + address.pathname + address.hash,
          title: (address.hash ? 'Request ' : 'Page ') + address.pathname, error});
      }
      if (!unresponsive && !window.webContents.isCrashed()) {
        for (const frame of window.webContents.mainFrame.framesInSubtree) {
          const address = URL.parse(frame.url);
          const owner = address?.origin === origin ? 'host' : preview && address?.origin === preview ? 'project' : '';
          if (!owner || frame.detached) continue;
          let timer;
          try {
            const blank = await Promise.race([
              frame.executeJavaScript(`document.readyState === 'complete' && document.body &&
                !document.body.innerText.trim() &&
                !document.body.querySelector('canvas,svg,img,video,iframe,input,textarea,button,[role=application]')`),
              new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })
            ]);
            if (typeof blank === 'boolean') rows.push({owner, id: 'render:' + address.pathname,
              title: 'Rendered page ' + address.pathname, error: blank ? 'The loaded page contains no visible content or controls.' : ''});
          } catch { /* A detached or navigating frame has no current observation. */ }
          finally { clearTimeout(timer); }
        }
      }
      return rows;
    },
    recoverRenderer() {
      if (window && !window.isDestroyed() && window.webContents.isCrashed()) return window.loadURL(hostOrigin);
    },
    hasPendingEdits() {
      return window.webContents.executeJavaScript(`(function dirty(root) {
        if (root.querySelector('dialog[open], [contenteditable=true]:focus')) return true;
        if ([...root.querySelectorAll('input:not([type]),input[type=text],textarea')].some(
          el => !el.readOnly && !el.disabled && el.value && el.value !== el.defaultValue)) return true;
        return [...root.querySelectorAll('*')].some(el => el.shadowRoot && dirty(el.shadowRoot));
      })(document)`);
    }
  };
};
