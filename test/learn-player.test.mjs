import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadFolderTour, readTourCode, sendTourAudio, tourFile } from '../learn-player.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'learn-player-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'tour');
  const repo = path.join(root, 'repo');
  await Promise.all([mkdir(folder), mkdir(repo)]);
  const data = {
    sections: [{
      title: 'Walkthrough', audio: 'narration.wav', durationSecs: 10,
      cues: [
        { atSeconds: 6, file: 'missing.rb', line: 1, note: 'Missing' },
        { atSeconds: 0, file: 'readme.md', line: 2, note: 'Introduction' },
      ],
    }],
  };
  const save = () => writeFile(path.join(folder, 'cues.json'), JSON.stringify(data));
  await Promise.all([
    save(),
    writeFile(path.join(repo, 'readme.md'), 'first\r\nsecond'),
    writeFile(path.join(folder, 'narration.wav'), '0123456789'),
    writeFile(path.join(root, 'outside.rb'), 'unrelated'),
  ]);
  return { root, folder, repo, data, save };
}

test('folder tour sorts cues, warns about missing files, and keeps one code snapshot per file', async t => {
  const { folder, repo } = await fixture(t);
  const tour = await loadFolderTour(folder, repo);
  assert.deepEqual(tour.sections[0].cues.map(cue => cue.file), ['readme.md', 'missing.rb']);
  assert.deepEqual(tour.warnings, ['Section 1 · missing.rb:1']);
  const code = await readTourCode(tour, 'readme.md');
  assert.deepEqual(code, { text: 'first\nsecond', lines: 2 });
  await writeFile(path.join(repo, 'readme.md'), 'changed');
  assert.deepEqual(await readTourCode(tour, 'readme.md'), code);
  await assert.rejects(readTourCode(tour, 'missing.rb'), /missing/);
});

test('invalid JSON and cues fail early; unsafe paths cannot resolve outside the folder', async t => {
  const { root, folder, repo, data, save } = await fixture(t);
  await writeFile(path.join(folder, 'cues.json'), '{');
  await assert.rejects(loadFolderTour(folder, repo), /Could not read cues\.json/);
  data.sections[0].cues[0].line = 0;
  await save();
  await assert.rejects(loadFolderTour(folder, repo), /invalid time, file, line, or note/);
  data.sections[0].cues[0].line = 1;
  data.sections[0].audio = '../outside.wav';
  await save();
  await assert.rejects(loadFolderTour(folder, repo), /outside the selected folder/);
  await assert.rejects(tourFile(repo, '..\\outside.rb'), /outside/);
  await assert.rejects(tourFile(repo, 'C:\\outside.rb'), /relative/);
  await symlink(root, path.join(repo, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tourFile(repo, 'escape/outside.rb'), /outside/);
});

test('media route supports seekable and suffix byte ranges, HEAD, and unsatisfiable ranges', async t => {
  const { folder, repo } = await fixture(t);
  const tour = await loadFolderTour(folder, repo);
  const server = createServer((req, res) => sendTourAudio(req, res, tour, 0).catch(error => res.destroy(error)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const read = async (range, method) => {
    const response = await fetch(url, { method, headers: range ? { Range: range } : {} });
    return [response.status, response.headers.get('content-range'), await response.text()];
  };
  assert.deepEqual(await read(), [200, null, '0123456789']);
  assert.deepEqual(await read('bytes=2-4'), [206, 'bytes 2-4/10', '234']);
  assert.deepEqual(await read('bytes=-2'), [206, 'bytes 8-9/10', '89']);
  assert.deepEqual(await read('bytes=2-4', 'HEAD'), [206, 'bytes 2-4/10', '']);
  assert.deepEqual(await read('bytes=10-'), [416, 'bytes */10', '']);
});
