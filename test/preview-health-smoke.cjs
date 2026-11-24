const {app} = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {verifyPreview} = require('../desktop/preview-health.cjs');
app.on('window-all-closed', () => {});
app.setPath('userData', require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'branch-review-preview-browser-')));

app.whenReady().then(async () => {
  const {createEnvironment} = await import('../workbench/environment.mjs');
  const {createHealthReviewer} = await import('../workbench/coordinator/health.mjs');
  const {gitRead} = await import('../workbench/environment/paths.mjs');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-review-preview-recovery-'));
  const repository = path.join(base, 'project');
  const origin = 'http://127.0.0.1:4310';
  let environment, monitor;
  try {
    await fs.mkdir(repository);
    await fs.writeFile(path.join(repository, 'setup.cjs'), `
      const fs = require('node:fs'); const path = require('node:path');
      const marker = path.join(process.env.BRANCH_REVIEW_DATA, 'setup-attempt');
      if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'attempted'); console.error('Disposable setup failure'); process.exit(1); }
    `);
    await fs.writeFile(path.join(repository, 'server.cjs'), `
      require('node:http').createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html');
        if (req.url === '/blocked') res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        if (req.url === '/csp-blocked') res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        if (req.url === '/allowed') res.setHeader('Content-Security-Policy', 'frame-ancestors ${origin}');
        res.end(req.url === '/blank' ? '<html><body></body></html>' : '<html><body><button>Recovered preview</button></body></html>');
      }).listen(process.env.PORT, '127.0.0.1');
    `);
    await gitRead(repository, 'init', '-b', 'main');
    await gitRead(repository, 'add', '.');
    await gitRead(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Disposable fixture');
    let backgroundBrowserChecks = 0;
    environment = createEnvironment({repository, local: path.join(base, 'local'), store: {}, origin,
      verifyPreview: async (url, options) => { backgroundBrowserChecks++; return verifyPreview(url, options); }});
    await environment.dispatch('POST', 'design/app-process/setup', {mode: 'web', argv: ['node', 'server.cjs'],
      setup: [['node', 'setup.cjs']], url: 'http://127.0.0.1:{port}'});
    await assert.rejects(environment.dispatch('POST', 'design/app-process/start'), /setup command failed/);
    const failed = await environment.dispatch('GET', 'design/app-process');
    assert.equal(failed.state, 'exited');
    assert.equal(failed.wanted, true);
    let repairs = 0;
    monitor = await createHealthReviewer({directory: path.join(base, 'health'), start: false, idle: () => true,
      observe: () => environment.observePreview(), recoverProject: async (_incident, signal) => {
        repairs++;
        return environment.recoverPreview({signal});
      }});
    await monitor.tick();
    await monitor.tick();
    const [incident] = monitor.status().incidents;
    assert.equal(incident.state, 'recovered');
    assert.equal(repairs, 1);
    assert.equal(incident.verification.passed, true);
    const restored = await environment.dispatch('GET', 'design/app-process');
    assert.equal((await verifyPreview(restored.url, {embedOrigin: origin})).passed, true);
    assert.equal((await verifyPreview(restored.url + '/blank', {embedOrigin: origin})).passed, false);
    assert.equal((await verifyPreview(restored.url + '/blocked')).passed, true);
    assert.equal((await verifyPreview(restored.url + '/blocked', {embedOrigin: origin})).passed, false);
    assert.equal((await verifyPreview(restored.url + '/csp-blocked', {embedOrigin: origin})).passed, false);
    assert.equal((await verifyPreview(restored.url + '/allowed', {embedOrigin: origin})).passed, true);
    for (let check = 0; check < 4; check++) await monitor.tick();
    assert.equal(backgroundBrowserChecks, 1, 'Healthy observations reuse the post-repair browser result for one minute.');
    assert.equal(repairs, 1);
    await environment.dispatch('POST', 'design/app-process/stop');
    assert.equal((await environment.observePreview())[0].cancelled, true);
    assert.equal((await environment.recoverPreview()).cancelled, true);
    await environment.close();
    environment = createEnvironment({repository, local: path.join(base, 'local'), store: {}, origin, verifyPreview});
    assert.equal((await environment.dispatch('POST', 'design/app-process/auto')).stoppedByUser, true);
    assert.equal((await environment.observePreview())[0].cancelled, true);
    await environment.dispatch('POST', 'design/app-process/setup', {mode: 'web', argv: ['node', 'server.cjs'],
      setup: [['node', '-e', 'throw Error("Unknown setup dependency")']], url: 'http://127.0.0.1:{port}'});
    await assert.rejects(environment.dispatch('POST', 'design/app-process/start'));
    const setupFailure = await environment.recoverPreview();
    assert.equal(setupFailure.passed, false);
    assert.match(setupFailure.detail, /setup did not finish/);
    console.log('PASS: automatic preview recovery, embedded Electron rendering, frame refusal, throttled probes, structured setup failures, deduplication, and Stop across restart.');
    app.exitCode = 0;
  } catch (error) {
    console.error(error);
    app.exitCode = 1;
  } finally {
    await monitor?.close();
    await environment?.close();
    await fs.rm(base, {recursive: true, force: true, maxRetries: 3});
    app.exit(app.exitCode);
  }
});
