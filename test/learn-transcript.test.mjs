import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTranscript, transcriptSentence } from '../learn-transcript.mjs';

test('reads exact timings and estimates only when no timed transcript exists', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'learn-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tourFolder = path.join(root, 'tour');
  const transcript = path.join(tourFolder, 'transcript');
  const cache = path.join(root, 'cache');
  const tour = { tourFolder, sections: [{ audio: 'audio/a.mp3', durationSecs: 20 }] };
  await mkdir(transcript, { recursive: true });
  assert.deepEqual(await readTranscript(tour, 0, cache), { sentences: [], estimated: false });

  await writeFile(path.join(tourFolder, 'a.txt'), 'First. A longer sentence.');
  const estimate = await readTranscript(tour, 0, cache);
  assert.equal(estimate.estimated, true);
  assert.equal(estimate.sentences.length, 2);
  assert.equal(estimate.sentences[0].end, 20 * (6 / 24));
  assert.equal(estimate.sentences[1].end, 20);
  assert.deepEqual(await readTranscript(tour, 0, cache), estimate);
  assert.equal((await readdir(cache)).length, 1);
  assert.deepEqual((await readdir(tourFolder)).sort(), ['a.txt', 'transcript']);

  const exact = [
    { start: 0, end: 5, text: 'Read this.' },
    { start: 5, end: 7, text: 'Then this.' },
  ];
  await writeFile(path.join(transcript, '1.json'), JSON.stringify(exact));
  const result = await readTranscript(tour, 0, cache);
  assert.deepEqual(result, { sentences: exact, estimated: false });
  assert.equal(transcriptSentence(result, 5).text, 'Then this.');
  assert.equal(transcriptSentence(result, 3).text, 'Read this.');
  assert.equal(transcriptSentence(result, 7), null);
  await writeFile(path.join(transcript, 'a.json'), JSON.stringify([...exact].reverse()));
  await assert.rejects(readTranscript(tour, 0, cache), /ordered, finite/);
});
