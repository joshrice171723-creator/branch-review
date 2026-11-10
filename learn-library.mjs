import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const isZip = source => /\.zip$/i.test(source);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const info = source => stat(source).catch(error => {
  if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
  throw error;
});

async function zipCommand(script) {
  if (process.platform !== 'win32') throw new Error('Tour zip support requires Windows.');
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = "$ErrorActionPreference = 'Stop'\r\n$ProgressPreference = 'SilentlyContinue'\r\ntry {\r\n" +
    'Add-Type -AssemblyName System.IO.Compression.FileSystem\r\n' + script +
    '\r\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
  try {
    const worker = exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 120000 });
    worker.child.stdin.end();
    await worker;
  } catch (error) {
    throw new Error('Tour zip operation failed: ' + (error.stderr?.trim() || error.message));
  }
}

async function extractZip(source, destination) {
  await zipCommand(String.raw`
$target = ` + quote(destination) + String.raw`
$zip = [IO.Compression.ZipFile]::OpenRead(` + quote(source) + String.raw`)
try {
  if ($zip.Entries.Count -gt 5000) { throw 'Too many files in tour zip.' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total = 0L
  foreach ($item in $zip.Entries) {
    $name = $item.FullName.Replace('\', '/')
    $parts = $name.TrimEnd('/').Split('/')
    if ($name -match '[\\:\x00-\x1f<>""|?*]' -or ($parts | Where-Object {
      $_ -eq '' -or $_ -match '^[.]{1,2}$|[ .]$|^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)'
    })) { throw 'Unsafe entry path in tour zip.' }
    $top = $parts[0]
    if ($top -notin @('manifest.json','cues.json','audio','code','transcript')) { throw 'Unexpected entry in tour zip.' }
    if (!$seen.Add($name.TrimEnd('/'))) { throw 'Duplicate entry in tour zip.' }
    $total += $item.Length
    if ($item.Length -gt 64MB -or $total -gt 512MB) { throw 'Tour zip exceeds extraction limits.' }
  }
  foreach ($item in $zip.Entries) {
    $name = $item.FullName.Replace('\', '/')
    $file = [IO.Path]::GetFullPath([IO.Path]::Combine($target, $name))
    if (!$file.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Unsafe entry path in tour zip.'
    }
    if ($name.EndsWith('/')) {
      [void][IO.Directory]::CreateDirectory($file)
    } else {
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
      $entryStream = $item.Open()
      try {
        $output = [IO.File]::Open($file, [IO.FileMode]::CreateNew)
        try {
          $buffer = New-Object byte[] 65536
          while (($size = $entryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($output.Length + $size -gt $item.Length) { throw 'Invalid entry size.' }
            $output.Write($buffer, 0, $size)
          }
          if ($output.Length -ne $item.Length) { throw 'Invalid entry size.' }
        } finally { $output.Dispose() }
      } finally { $entryStream.Dispose() }
    }
  }
} finally { $zip.Dispose() }
`);
}

export async function writeTourZip(root, out) {
  root = await realpath(root);
  out = path.resolve(out);
  await mkdir(path.dirname(out), { recursive: true });
  const temporary = path.join(path.dirname(out), '.tour-' + randomUUID() + '.zip');
  try {
    await zipCommand('[IO.Compression.ZipFile]::CreateFromDirectory(' + quote(root) + ', ' + quote(temporary) + ')');
    await copyFile(temporary, out, constants.COPYFILE_EXCL);
  } finally {
    await rm(temporary, { force: true });
  }
  return out;
}

export async function createLibrary({ directory, shared, loadTour }) {
  await mkdir(path.join(directory, 'cache'), { recursive: true });
  const root = await realpath(directory);
  const cache = await realpath(path.join(root, 'cache'));
  if (!samePath(cache, path.join(root, 'cache'))) throw new Error('Learn cache must be inside Learn data.');
  const filename = path.join(root, 'library.json');
  let { entries, ignored } = await readFile(filename, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return { entries: [], ignored: [] };
    throw error;
  });
  const loaded = new Map();
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function save(next, nextIgnored = ignored) {
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ entries: next, ignored: nextIgnored }), { flag: 'wx' });
      await rename(temporary, filename);
      entries = next;
      ignored = nextIgnored;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  function get(id) {
    const entry = entries.find(candidate => candidate.id === id);
    if (!entry) throw new Error('Tour is no longer in the library.');
    return structuredClone(entry);
  }
  async function update(entry) {
    await save(entries.map(old => old.id === entry.id ? entry : old));
    return summary(entry);
  }
  function cachePath(id) {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid tour id.');
    return path.join(cache, id);
  }
  async function available(entry) {
    const source = await info(entry.source);
    if (isZip(entry.source)) return source?.isFile() ? 'ready' : 'missing';
    if (!source?.isDirectory() || !(await info(path.join(entry.source, 'cues.json')))?.isFile()) return 'missing';
    if (!entry.codeRoot) return 'needs-repo';
    return (await info(entry.codeRoot))?.isDirectory() ? 'ready' : 'missing';
  }
  async function summary(entry) {
    const total = entry.durations.reduce((sum, seconds) => sum + seconds, 0);
    const completed = new Set(entry.completedSections);
    let progress = [...completed].reduce((sum, index) => sum + (entry.durations[index] || 0), 0);
    const position = entry.position;
    if (position && !completed.has(position.sectionIndex)) {
      progress += Math.min(position.seconds, entry.durations[position.sectionIndex] || 0);
    }
    return {
      ...structuredClone(entry), sectionCount: entry.durations.length, totalDuration: total,
      percent: entry.finished ? 100 : total ? Math.min(100, Math.floor(progress / total * 100)) : 0,
      state: await available(entry),
    };
  }
  async function zipTour(entry, version) {
    const extracted = cachePath(entry.id);
    const staged = await mkdtemp(path.join(cache, 'extract-'));
    try {
      let candidate = extracted;
      const saved = await readFile(path.join(extracted, '.source'), 'utf8').catch(() => '');
      if (saved !== version) {
        candidate = staged;
        await extractZip(entry.source, candidate);
      }
      const manifest = JSON.parse((await readFile(path.join(candidate, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
      if (manifest?.format !== 1 || typeof manifest.title !== 'string' || !manifest.title.trim() ||
          !(await info(path.join(candidate, 'audio')))?.isDirectory() ||
          !(await info(path.join(candidate, 'code')))?.isDirectory()) {
        throw new Error('Expected format 1 manifest, audio and code in the tour zip.');
      }
      const tour = await loadTour(candidate, path.join(candidate, 'code'), { zip: true });
      if (candidate === extracted) return { ...tour, manifest };
      await writeFile(path.join(staged, '.source'), version);
      await rm(extracted, { recursive: true, force: true });
      await rename(staged, extracted);
      return { ...await loadTour(extracted, path.join(extracted, 'code'), { zip: true }), manifest };
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  async function prepare(entry, refresh = false) {
    const state = await available(entry);
    if (state !== 'ready') throw new Error(state === 'needs-repo' ? 'Choose the code folder for this tour.' : 'Tour files moved or are unavailable.');
    const source = await stat(entry.source);
    const version = JSON.stringify([entry.source, entry.codeRoot, source.size, source.mtimeMs]);
    const cached = loaded.get(entry.id);
    if (!refresh && cached?.version === version) return cached.tour;
    const tour = isZip(entry.source) ? await zipTour(entry, version) : await loadTour(entry.source, entry.codeRoot);
    loaded.set(entry.id, { version, tour });
    return tour;
  }
  function entryFor(source, codeRoot, title) {
    return {
      id: randomUUID(), source, codeRoot, title, durations: [], addedAt: new Date().toISOString(),
      lastPlayedAt: null, position: null, completedSections: [], finished: false,
      secondsListened: 0, flags: {}, notes: {},
    };
  }
  const list = () => Promise.all(entries.slice().sort((a, b) =>
    (b.lastPlayedAt || b.addedAt).localeCompare(a.lastPlayedAt || a.addedAt)).map(summary));
  const titleOf = value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a tour title.');
    return value.trim().slice(0, 200);
  };
  const fallback = source => path.basename(source).replace(/(?:\.tour)?\.zip$/i, '');

  return {
    get, list,
    add: ({ source, codeRoot, title }) => serial(async () => {
      source = await realpath(source);
      codeRoot = !isZip(source) && codeRoot ? await realpath(codeRoot) : null;
      const existing = entries.find(entry => samePath(entry.source, source) &&
        (isZip(source) || !entry.codeRoot || (codeRoot && samePath(entry.codeRoot, codeRoot))));
      if (existing?.codeRoot || (existing && isZip(source))) return summary(existing);
      const entry = existing ? { ...existing, codeRoot } : entryFor(source, codeRoot, fallback(source));
      try {
        const tour = await prepare(entry, true);
        entry.title = title ? titleOf(title) : tour.manifest?.title || entry.title;
        entry.durations = tour.sections.map(section => section.durationSecs);
        await save(existing ? entries.map(old => old.id === entry.id ? entry : old) : [...entries, entry],
          ignored.filter(removed => !samePath(removed, source)));
      } catch (error) {
        if (!existing) {
          loaded.delete(entry.id);
          await rm(cachePath(entry.id), { recursive: true, force: true });
        }
        throw error;
      }
      return summary(entry);
    }),
    open: id => serial(async () => {
      const entry = get(id);
      const tour = await prepare(entry);
      entry.durations = tour.sections.map(section => section.durationSecs);
      return { entry: await update(entry), tour };
    }),
    rename: (id, title) => serial(() => update({ ...get(id), title: titleOf(title) })),
    relocate: (id, { source, codeRoot }) => serial(async () => {
      const entry = get(id);
      entry.source = await realpath(source || entry.source);
      const repo = codeRoot || entry.codeRoot;
      entry.codeRoot = !isZip(entry.source) && repo ? await realpath(repo) : null;
      if (entries.some(other => other.id !== id && samePath(other.source, entry.source) &&
        (isZip(entry.source) || (other.codeRoot && entry.codeRoot && samePath(other.codeRoot, entry.codeRoot))))) {
        throw new Error('That tour is already in the library.');
      }
      const tour = await prepare(entry, true);
      entry.durations = tour.sections.map(section => section.durationSecs);
      return update(entry);
    }),
    remove: id => serial(async () => {
      const entry = get(id);
      await save(entries.filter(old => old.id !== id), [...new Set([...ignored, entry.source])]);
      loaded.delete(id);
      await rm(cachePath(id), { recursive: true, force: true });
      return { id };
    }),
    reset: id => serial(() => update({ ...get(id), position: null, completedSections: [], finished: false })),
    progress: (id, { sectionIndex, seconds, completedSection, finished, listened }) => serial(() => {
      const entry = get(id);
      const valid = index => Number.isInteger(index) && index >= 0 && index < entry.durations.length;
      if (sectionIndex !== undefined || seconds !== undefined) {
        if (!valid(sectionIndex) || !Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid tour position.');
        entry.position = { sectionIndex, seconds: Math.min(seconds, entry.durations[sectionIndex]) };
      }
      if (valid(completedSection)) entry.completedSections = [...new Set([...entry.completedSections, completedSection])];
      if (finished === true) entry.finished = true;
      if (Number.isFinite(listened) && listened > 0) entry.secondsListened += listened;
      entry.lastPlayedAt = new Date().toISOString();
      return update(entry);
    }),
    patch: (id, change) => serial(() => {
      const entry = get(id);
      for (const key of ['flags', 'notes', 'tutorSession', 'tutorContext', 'exercises']) {
        if (Object.hasOwn(change, key)) entry[key] = structuredClone(change[key]);
      }
      return update(entry);
    }),
    scan: () => serial(async () => {
      if (!shared) return list();
      const children = await readdir(shared, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const next = [...entries];
      for (const child of children) {
        if (!child.isDirectory() && !(child.isFile() && isZip(child.name))) continue;
        const source = await realpath(path.join(shared, child.name));
        if (next.some(entry => samePath(entry.source, source)) || ignored.some(entry => samePath(entry, source))) continue;
        if (child.isDirectory() && !(await info(path.join(source, 'cues.json')))?.isFile()) continue;
        const entry = entryFor(source, null, fallback(source));
        if (isZip(source)) {
          try {
            const tour = await prepare(entry);
            entry.title = tour.manifest.title;
            entry.durations = tour.sections.map(section => section.durationSecs);
          } catch {
            await rm(cachePath(entry.id), { recursive: true, force: true });
            continue;
          }
        }
        next.push(entry);
      }
      if (next.length !== entries.length) await save(next);
      return list();
    }),
  };
}
