import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const empty = () => ({ sentences: [], estimated: false });
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const maxBytes = 2 * 1024 * 1024;

async function sourceText(root, ...parts) {
  try {
    const filename = await realpath(path.join(root, ...parts));
    const relative = path.relative(root, filename);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Transcript path is outside the tour folder.');
    }
    const info = await stat(filename);
    if (!info.isFile() || info.size > maxBytes) throw new Error('Transcript must be a file no larger than 2 MB.');
    const data = await readFile(filename);
    if (data.length > maxBytes) throw new Error('Transcript must be no larger than 2 MB.');
    return data.toString('utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function checkedSentences(value) {
  if (!Array.isArray(value)) throw new Error('Transcript must be an array of timed sentences.');
  let previous = -1;
  return value.map(sentence => {
    const { start, end, text } = sentence ?? {};
    if (!Number.isFinite(start) || start < 0 || start < previous ||
        !Number.isFinite(end) || end <= start || typeof text !== 'string' || !text.trim()) {
      throw new Error('Transcript sentences need ordered, finite times and nonblank text.');
    }
    previous = start;
    return { start, end, text: text.trim() };
  });
}

export async function readTranscript(tour, sectionIndex, cacheDirectory) {
  const section = tour?.sections?.[sectionIndex];
  if (!section || typeof section.audio !== 'string' || !tour.tourFolder) return empty();
  const root = await realpath(tour.tourFolder).catch(error => {
    if (missing(error)) return null;
    throw error;
  });
  if (!root) return empty();
  const stem = path.parse(path.basename(section.audio.replaceAll('\\', '/'))).name;
  for (const name of new Set([stem, String(sectionIndex + 1)])) {
    const json = await sourceText(root, 'transcript', name + '.json');
    if (json !== null) return { sentences: checkedSentences(JSON.parse(json)), estimated: false };
  }
  const script = (await sourceText(root, stem + '.txt')) ?? await sourceText(root, 'transcript', stem + '.txt');
  if (!script?.trim() || !Number.isFinite(section.durationSecs) || section.durationSecs <= 0) return empty();

  const hash = createHash('sha256').update(JSON.stringify([1, section.durationSecs, script])).digest('hex');
  const cacheFile = cacheDirectory && path.join(cacheDirectory, hash + '.json');
  if (cacheFile) {
    try {
      const sentences = checkedSentences(JSON.parse(await readFile(cacheFile, 'utf8')));
      return { sentences, estimated: true };
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError) && error.code) throw error;
    }
  }
  const parts = Array.from(segmenter.segment(script), ({ segment }) => segment.trim()).filter(Boolean);
  const lengths = parts.map(text => [...text].length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let used = 0;
  const sentences = parts.map((text, i) => {
    const start = section.durationSecs * (used / total);
    used += lengths[i];
    return { start, end: section.durationSecs * (used / total), text };
  });
  if (cacheFile) {
    await mkdir(cacheDirectory, { recursive: true });
    const temporary = cacheFile + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(sentences), { flag: 'wx' });
      await rename(temporary, cacheFile);
    } finally {
      await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    }
  }
  return { sentences, estimated: true };
}

export function transcriptSentence(transcript, seconds) {
  if (!Number.isFinite(seconds)) return null;
  const sentences = transcript?.sentences ?? [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].start <= seconds && seconds < sentences[i].end) return sentences[i];
  }
  return null;
}
