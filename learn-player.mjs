import { execFile } from 'node:child_process';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const audioTypes = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function localPath(root, name) {
  if (typeof name !== 'string' || !name.trim() || /[:\0]/.test(name) ||
      path.win32.isAbsolute(name) || path.posix.isAbsolute(name)) {
    throw new Error('Expected a relative file path.');
  }
  const candidate = path.resolve(root, name.replaceAll('\\', '/'));
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('File path is outside the selected folder.');
  }
  return candidate;
}

export async function tourFile(root, name) {
  root = await realpath(root);
  const file = await realpath(localPath(root, name));
  localPath(root, path.relative(root, file));
  if (!(await stat(file)).isFile()) throw new Error('Expected a file.');
  return file;
}

export async function loadFolderTour(tourFolder, codeRoot) {
  if (typeof tourFolder !== 'string' || typeof codeRoot !== 'string' || !tourFolder.trim() || !codeRoot.trim()) {
    throw new Error('Choose both the tour and code folders.');
  }
  [tourFolder, codeRoot] = await Promise.all([realpath(tourFolder), realpath(codeRoot)]);
  if (!(await stat(codeRoot)).isDirectory()) throw new Error('Choose a code folder.');
  let data;
  try {
    data = JSON.parse((await readFile(await tourFile(tourFolder, 'cues.json'), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error('Could not read cues.json: ' + error.message);
  }
  if (!Array.isArray(data?.sections) || !data.sections.length) {
    throw new Error('cues.json needs a non-empty sections array.');
  }
  const sections = [];
  const files = new Map();
  const warnings = [];
  for (const [index, section] of data.sections.entries()) {
    const label = 'Section ' + (index + 1);
    if (typeof section?.title !== 'string' || !section.title.trim() ||
        typeof section.audio !== 'string' || !Object.hasOwn(audioTypes, path.extname(section.audio).toLowerCase()) ||
        !Number.isFinite(section.durationSecs) || section.durationSecs <= 0 || !Array.isArray(section.cues)) {
      throw new Error(label + ' needs a title, MP3 or WAV, positive durationSecs, and cues.');
    }
    let audioPath;
    try { audioPath = await tourFile(tourFolder, section.audio); }
    catch (error) { throw new Error(label + ' cannot open ' + section.audio + ': ' + error.message); }
    const cues = [];
    for (const [cueIndex, cue] of section.cues.entries()) {
      if (!Number.isFinite(cue?.atSeconds) || cue.atSeconds < 0 || !Number.isSafeInteger(cue.line) ||
          cue.line < 1 || typeof cue.file !== 'string' || !cue.file.trim() || typeof cue.note !== 'string') {
        throw new Error(label + ', cue ' + (cueIndex + 1) + ' has invalid time, file, line, or note.');
      }
      if (!files.has(cue.file)) files.set(cue.file, await tourFile(codeRoot, cue.file).catch(() => null));
      if (!files.get(cue.file)) warnings.push(label + ' · ' + cue.file + ':' + cue.line);
      const { atSeconds, file, line, note, exercise } = cue;
      cues.push({ atSeconds, file, line, note, ...(exercise ? { exercise } : {}) });
    }
    cues.sort((a, b) => a.atSeconds - b.atSeconds);
    sections.push({ title: section.title, durationSecs: section.durationSecs, audio: section.audio, audioPath, cues });
  }
  return { tourFolder, codeRoot, sections, warnings, files, cache: new Map() };
}

export async function readTourCode(tour, file) {
  if (!tour.files.get(file)) throw new Error('Cue file is missing or outside the code folder.');
  if (!tour.cache.has(file)) {
    tour.cache.set(file, tourFile(tour.codeRoot, file).then(real => readFile(real, 'utf8')).then(source => {
      const text = source.replace(/\r\n?/g, '\n');
      return { text, lines: text.split('\n').length };
    }).catch(error => {
      tour.cache.delete(file);
      throw error;
    }));
  }
  return tour.cache.get(file);
}

export async function sendTourAudio(req, res, tour, sectionIndex) {
  const section = Number.isInteger(sectionIndex) && tour.sections[sectionIndex];
  if (!section) throw new Error('Choose an available section.');
  const file = await open(await tourFile(tour.tourFolder, section.audio), 'r');
  try {
    const { size } = await file.stat();
    const headers = {
      'Content-Type': audioTypes[path.extname(section.audio).toLowerCase()],
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const bounds = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (bounds) {
        if (bounds[1]) {
          start = Number(bounds[1]);
          if (bounds[2]) end = Math.min(end, Number(bounds[2]));
        } else {
          start = Math.max(0, size - Number(bounds[2]));
        }
      }
      if (!bounds || !size || !Number.isSafeInteger(start) || start >= size || end < start) {
        res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + size });
        return res.end();
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || !size) return res.end();
    await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
  } finally {
    await file.close();
  }
}

async function findRubyMine() {
  async function search(root, depth, filter = false) {
    const executable = path.join(root, 'bin', 'rubymine64.exe');
    if (await stat(executable).then(info => info.isFile(), () => false)) return executable;
    if (!depth) return null;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (!entry.isDirectory() || (filter && !/^RubyMine/i.test(entry.name))) continue;
      const found = await search(path.join(root, entry.name), depth - 1);
      if (found) return found;
    }
    return null;
  }
  const { ProgramFiles, LOCALAPPDATA, PATH } = process.env;
  const roots = [
    [ProgramFiles, 'JetBrains', 1],
    [LOCALAPPDATA, 'Programs', 1],
    [LOCALAPPDATA, 'JetBrains/Toolbox/apps', 5],
  ];
  for (const [base, folder, depth] of roots) {
    if (!base) continue;
    const found = await search(path.join(base, folder), depth, depth === 1);
    if (found) return found;
  }
  for (const entry of (PATH || '').split(path.delimiter)) {
    const executable = path.join(entry.replace(/^"|"$/g, ''), 'rubymine64.exe');
    if (path.isAbsolute(executable) && await stat(executable).then(info => info.isFile(), () => false)) return executable;
  }
  throw new Error('RubyMine launcher not found.');
}

export async function jumpToRubyMine(tour, sectionIndex, cueIndex) {
  if (process.platform !== 'win32') throw new Error('RubyMine follow mode requires Windows.');
  const cue = Number.isInteger(sectionIndex) && Number.isInteger(cueIndex) && tour.sections[sectionIndex]?.cues[cueIndex];
  if (!cue || !tour.files.get(cue.file)) throw new Error('Cue file is missing or outside the code folder.');
  const file = await tourFile(tour.codeRoot, cue.file);
  const launcher = await findRubyMine();
  const args = [launcher, '--line ' + cue.line + ' "' + file + '"', tour.codeRoot, 'open']
    .map(value => "'" + value.replaceAll("'", "''") + "'").join(', ');
  // Explorer activates the existing IDE without inheriting the launcher socket restriction.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$windows = (New-Object -ComObject Shell.Application).Windows()',
    '$hwnd = 0',
    '$desktop = $windows.FindWindowSW(0, 0, 8, [ref]$hwnd, 1)',
    "if (-not $desktop) { throw 'Windows desktop shell unavailable' }",
    '$desktop.Document.Application.ShellExecute(' + args + ', 1)',
  ].join('\r\n');
  await exec(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 12000 });
}
