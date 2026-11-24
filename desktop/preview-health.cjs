const {BrowserWindow} = require('electron');

exports.verifyPreview = async function (url, {signal, embedOrigin} = {}) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) {
    throw Error('Preview verification requires a local project address.');
  }
  signal?.throwIfAborted();
  const parent = embedOrigin ? new URL(embedOrigin) : null;
  if (parent && (parent.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parent.hostname))) {
    throw Error('Preview verification requires a local workspace origin.');
  }
  const browser = new BrowserWindow({show: false, webPreferences: {
    partition: 'preview-health-' + require('node:crypto').randomUUID(), nodeIntegration: false,
    contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false
  }});
  browser.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  browser.webContents.session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const topOrigin = parent?.origin || address.origin;
  browser.webContents.session.webRequest.onBeforeRequest((details, done) => {
    done({cancel: details.resourceType === 'mainFrame' && new URL(details.url).origin !== topOrigin});
  });
  browser.webContents.on('will-redirect', (event, value) => {
    if (event.isMainFrame && new URL(value).origin !== topOrigin) event.preventDefault();
  });
  const probeUrl = parent && parent.origin + '/__coordinator_preview_probe';
  if (parent) browser.webContents.session.protocol.handle('http', request => {
    if (request.url === probeUrl) {
      const safeUrl = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
      return new Response('<!doctype html><html><body style="margin:0"><iframe style="border:0;width:100vw;height:100vh" src="' + safeUrl + '"></iframe></body></html>',
        {headers: {'Content-Type': 'text/html'}});
    }
    return browser.webContents.session.fetch(request, {bypassCustomProtocolHandlers: true});
  });
  let frameRefusal = '';
  browser.webContents.on('console-message', event => {
    if (event.level === 'error' && /frame|frame-ancestors/i.test(event.message)) frameRefusal = event.message;
  });
  const abort = () => browser.destroy();
  signal?.addEventListener('abort', abort, {once: true});
  let timer;
  try {
    await Promise.race([browser.loadURL(probeUrl || url), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('The project page did not finish loading.')), 15000);
    })]);
    for (let attempt = 0; attempt < 20; attempt++) {
      signal?.throwIfAborted();
      if (frameRefusal) return {passed: false, detail: 'The project page refuses to load inside Branch Review. ' + frameRefusal};
      const frame = parent ? browser.webContents.mainFrame.framesInSubtree.find(frame => {
        return frame !== browser.webContents.mainFrame && URL.parse(frame.url)?.origin === address.origin;
      }) : browser.webContents.mainFrame;
      const visible = frame && await frame.executeJavaScript(`(() => {
        const elements = [...document.querySelectorAll('body,body *')];
        return elements.some(element => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 &&
            box.width > 0 && box.height > 0 &&
            (element.matches('canvas,svg,img,video,input,textarea,button,[role=application]') || element.innerText?.trim());
        });
      })()`);
      if (visible) return {passed: true, detail: parent ? 'The project page displayed content inside the Branch Review preview.' :
        'The project page loaded and displayed content in the browser.'};
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return {passed: false, detail: 'The project page loaded, but it displayed no visible content or controls.'};
  } catch (error) {
    signal?.throwIfAborted();
    return {passed: false, detail: error.message};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!browser.isDestroyed()) browser.destroy();
  }
};
