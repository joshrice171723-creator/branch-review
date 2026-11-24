const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const {pathToFileURL} = require('node:url');

const userData = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'br-health-electron-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'br-health-browser-'));
  const {createHealthReviewer} = await import(pathToFileURL(path.join(root, 'workbench/coordinator/health.mjs')));
  let release;
  const repairGate = new Promise(resolve => { release = resolve; });
  const reviewer = await createHealthReviewer({directory, start: false, idle: () => true, observe: () => [],
    repair: async () => {
      await repairGate;
      return {summary: 'The dialog repair is ready.', checks: 'Dialog check passed.', files: ['public/app.js']};
    }});
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/workspace/coordinator/health') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(reviewer.status()));
      }
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        return res.end('<html><body><div class="main-tools"></div><button id="restart-app">Restart</button>' +
          '<script type="module">import {coordinatorHealth} from "/activity.js";' +
          'window.desktop=true;coordinatorHealth(url=>fetch(url).then(r=>r.json()));window.ready=true;</script></body></html>');
      }
      const name = req.url.slice(1);
      if (!/^[a-z-]+\.js$/.test(name)) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-type', 'text/javascript');
      res.end(await readFile(path.join(root, 'public', name)));
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  let exitCode = 0;
  try {
    await reviewer.report({title: 'Dialog failure', issue: 'The dialog does not open.'});
    await reviewer.tick(false);
    browser = new BrowserWindow({show: false, webPreferences: {sandbox: true, contextIsolation: true}});
    await browser.loadURL('http://127.0.0.1:' + server.address().port);
    const waitFor = async source => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await browser.webContents.executeJavaScript(source)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('The expected health notice did not appear.');
    };
    await waitFor('window.ready && !document.querySelector(".health-notice").hidden');
    await browser.webContents.executeJavaScript('document.querySelector(".health-notice .quiet").click()');
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".health-notice").hidden'), true);
    assert.equal(reviewer.status().incidents[0].state, 'repairing');
    release();
    await reviewer.tick();
    assert.equal(reviewer.status().incidents[0].state, 'restart-required');
    await waitFor('!document.querySelector(".health-notice").hidden && !document.querySelector(".health-notice .secondary").hidden');
    await reviewer.report({id: 'operation:' + 'c'.repeat(64), title: 'Project folder missing',
      issue: 'Choose the project folder.', nextAction: 'Open Projects and choose an existing folder.'});
    await waitFor('document.querySelector(".health-notice").innerText.includes("Open Projects and choose an existing folder.")');
    assert.equal(reviewer.status().incidents[0].state, 'attention');
    console.log('PASS: actual App Health UI dismissal keeps repair active, restart notice appears on completion, and required action appears in plain English.');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    release();
    browser?.destroy();
    await reviewer.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
    await rm(userData, {recursive: true, force: true}).catch(() => {});
    app.exit(exitCode);
  }
});
