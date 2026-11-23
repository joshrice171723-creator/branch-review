// Run with Electron and a new scratch directory.
const {app, session} = require('electron');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {mkdirSync} = require('node:fs');
const {createServer} = require('node:http');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

assert.ok(process.argv[2], 'Supply a new scratch directory for the disposable desktop and project.');
const scratch = path.resolve(process.argv[2]);
mkdirSync(scratch);
const project = path.join(scratch, 'project');
execFileSync('git', ['init', '-b', 'main', project], {windowsHide: true});
execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  'commit', '--allow-empty', '-m', 'Initial fixture'], {windowsHide: true});
app.setPath('userData', scratch);
process.env.BRANCH_REVIEW_HOME = path.join(scratch, 'workspace');
process.env.META_CLINIC_REPO = project;
process.env.BRANCH_REVIEW_PORT = '4349';
delete process.env.BRANCH_REVIEW_DEV;

async function waitFor(label, read) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(50);
  }
  throw Error('Timed out waiting for ' + label);
}

async function exercise() {
  const preview = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('<!doctype html><style>*{margin:0}html{scrollbar-width:none}' +
      'section{height:100vh;background:red}section+section{background:lime}</style><section></section><section></section>');
  });
  preview.listen(0, '127.0.0.1');
  await once(preview, 'listening');
  const address = 'http://127.0.0.1:' + preview.address().port + '/striped-preview';
  const created = once(app, 'browser-window-created');
  require('../desktop/main.cjs');
  const [, win] = await created;
  const contents = win.webContents;
  const evaluate = (code, gesture = false) => contents.executeJavaScript(code, gesture);
  await once(contents, 'did-finish-load');
  await waitFor('the project preview settings', () => evaluate(
    '!!document.querySelector("#factory-view > div")?.shadowRoot?.querySelector("[data-design-focus=preview]")'));
  await evaluate(`window.root = document.querySelector('#factory-view > div').shadowRoot;
    window.byId = id => root.getElementById(id);
    window.button = label => [...root.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent) === label);
    const address = root.querySelector('[data-design-focus=preview]');
    address.value = ${JSON.stringify(address)};
    address.dispatchEvent(new Event('input'));
    button('Save app address').click();`);
  const frame = await waitFor('the loaded app', () => contents.mainFrame.frames.find(frame => frame.url === address));
  await waitFor('the preview sections', () => frame.executeJavaScript('document.querySelectorAll("section").length === 2'));

  // Inspect the outgoing chat request before it reaches a coding provider.
  let sent;
  const origin = await evaluate('location.origin');
  session.defaultSession.webRequest.onBeforeRequest({urls: [origin + '/api/workspace/design/guide']},
    (request, respond) => {
      respond({cancel: true});
      sent = JSON.parse(Buffer.concat(request.uploadData.map(part => part.bytes)).toString());
    });

  const measure = selector => evaluate(`(() => {
    const rect = root.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    return {top: rect.top, rightGap: width - rect.right, width, visible: rect.width > 0 && rect.left >= 0 && rect.right <= width + 1,
      offset: rect.left + rect.width / 2 - width / 2};
  })()`);
  win.setMinimumSize(320, 500);
  for (const width of [1000, 700, 400]) {
    contents.setZoomFactor(1);
    win.setContentSize(width, 700);
    await waitFor('window resize', () => evaluate('innerWidth === ' + width));
    const launch = await measure('#open-project-conversation');
    assert.ok(launch.visible && Math.abs(launch.offset) <= 1, 'Center the conversation button.');
    await evaluate('button("Full screen").click()', true);
    await waitFor('desktop full screen', () => evaluate(
      'root.fullscreenElement?.matches(".project-viewport") && Math.abs(innerWidth - screen.width) <= 1'));
    // Native full screen fills the display. Zoom supplies a narrow CSS viewport on the same display.
    if (width === 400) {
      contents.setZoomFactor(win.getContentSize()[0] / width);
      await waitFor('narrow full screen', () => evaluate('Math.abs(innerWidth - 400) <= 1'));
    }
    const sendSelector = '.project-fullscreen-tools .primary';
    const before = await measure(sendSelector);
    assert.ok(before.visible && before.top >= 0 && before.top < 20 && Math.abs(before.offset) <= 1);
    await frame.executeJavaScript('scrollTo(0, 0)');
    await frame.executeJavaScript('scrollTo(0, document.documentElement.scrollHeight)');
    await waitFor('the green section', () => frame.executeJavaScript(
      'scrollY > 0 && document.querySelector("section + section").getBoundingClientRect().top <= 0'));
    await frame.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.deepEqual(await measure(sendSelector), before);
    await evaluate('byId("mockup-target").value = "Plan"');
    await evaluate('button("Send to chat").click()', true);
    await waitFor('the attached screenshot', () => evaluate(
      '!root.fullscreenElement && !byId("project-conversation").hidden && !byId("change-screenshot").hidden'));
    contents.setZoomFactor(1);
    await waitFor('the restored workspace', () => evaluate('innerWidth === ' + width));
    const drawer = await measure('#project-conversation');
    assert.ok(drawer.visible && drawer.top >= 0 && drawer.top < 20);
    assert.ok(Math.abs(drawer.rightGap - (width > 460 ? 12 : 4)) <= 1, 'Keep the chat drawer at the right edge.');
    sent = undefined;
    await evaluate(`byId('project-conversation-message').value = 'Change this view';
      byId('project-conversation-form').requestSubmit();`);
    await waitFor('the outgoing chat message', () => sent);
    assert.equal(sent.message, 'Change this view');
    assert.equal(sent.changeScreenshot.page, '/striped-preview');
    const mismatch = await evaluate(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(sent.changeScreenshot.image)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] !== 0 || pixels[i+1] !== 255 || pixels[i+2] !== 0 || pixels[i+3] !== 255) {
          return {width: image.width, height: image.height, x: (i / 4) % image.width,
            y: Math.floor(i / 4 / image.width), color: Array.from(pixels.slice(i, i + 4))};
        }
      }
      return null;
    })()`);
    assert.equal(mismatch, null, 'The entire attachment must show the scrolled app. ' + JSON.stringify(mismatch));
    await evaluate('byId("close-project-conversation").click()');
    console.log('Workspace width %d, full-screen width %d. The outgoing attachment contains the green preview.', width, before.width);
  }
  preview.close();
}

exercise().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
