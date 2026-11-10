import { randomUUID } from 'node:crypto';
import { open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tourFile } from './learn-player.mjs';

const watchLimit = 20 * 60 * 1000;
const sizeLimit = 2 * 1024 * 1024;
const reminderSchedule = 'appointment_app/app/services/reminder_schedule.rb';

function builtIn(entry, section, cue) {
  if (section !== 6 || cue?.file !== reminderSchedule ||
      path.basename(entry.source).toLowerCase() !== 'defenseloop') return null;
  return {
    prompt: 'In reminder_schedule.rb, change FOLLOW_UP_DAYS_BEFORE from 3 to 4.',
    file: reminderSchedule,
    contains: 'FOLLOW_UP_DAYS_BEFORE = 4',
    absent: null,
  };
}

function matches(text, exercise) {
  return text.includes(exercise.contains) && (!exercise.absent || !text.includes(exercise.absent));
}

async function readSource(file) {
  const handle = await open(file, 'r');
  try {
    const { size, mode } = await handle.stat();
    if (size > sizeLimit) throw new Error('Exercise files must be smaller than 2 MB.');
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== size) throw Object.assign(new Error('The exercise file is being saved.'), { code: 'EBUSY' });
    const bytes = buffer.subarray(0, length);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Exercise files must be UTF-8 text.');
    return { text, mode };
  } finally {
    await handle.close();
  }
}

function oneChangedLine(before, after) {
  const lines = text => text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) || [];
  const original = lines(before);
  const modified = lines(after);
  return original.length === modified.length &&
    original.reduce((count, line, index) => count + Number(line !== modified[index]), 0) === 1;
}

export function createExercises({ protectedRoots = [], onDone = () => {} } = {}) {
  const jobs = new Map();

  function describe(tour, entry, section, cueIndex) {
    if (!Number.isInteger(section) || !Number.isInteger(cueIndex)) return null;
    const cue = tour.sections[section]?.cues[cueIndex];
    if (!cue) return null;
    const exercise = cue.exercise ?? builtIn(entry, section, cue);
    if (!exercise) return null;
    const { prompt, file, contains, absent = null } = exercise;
    if ([prompt, file, contains].some(value => typeof value !== 'string' || !value.trim()) ||
        (absent !== null && (typeof absent !== 'string' || !absent.trim()))) {
      throw new Error('This cue has an invalid exercise.');
    }
    return { prompt, file, contains, absent };
  }

  async function protectedFile(file, entry) {
    if (/\.zip$/i.test(entry.source)) return true;
    for (const root of protectedRoots) {
      const resolved = await realpath(root).catch(error => {
        if (error.code === 'ENOENT') return path.resolve(root);
        throw error;
      });
      const relative = path.relative(resolved, file);
      if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) return true;
    }
    return false;
  }

  function result(job) {
    const { state, key, exercise, undoAvailable, error } = job;
    return { state, key, ...exercise, undoAvailable, ...(error ? { error } : {}) };
  }

  function stop(job) {
    clearInterval(job.timer);
  }

  async function inspect(job) {
    if (job.checking || job.state !== 'watching') return;
    if (Date.now() - job.startedAt >= watchLimit) {
      stop(job);
      job.state = 'expired';
      return;
    }
    job.checking = true;
    try {
      const file = await tourFile(job.root, job.exercise.file);
      if (file !== job.file) throw new Error('The exercise file moved.');
      const { text } = await readSource(file);
      if (jobs.get(job.id) !== job || !matches(text, job.exercise)) return;
      stop(job);
      job.after = text;
      job.undoAvailable = !await protectedFile(file, job.entry) && oneChangedLine(job.before, text);
      job.state = 'done';
      await onDone(job.id, job.key, result(job));
    } catch (error) {
      if (['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) return;
      stop(job);
      if (job.state !== 'done') job.state = 'error';
      job.error = error.message;
    } finally {
      job.checking = false;
    }
  }

  return {
    describe,
    async start(tour, entry, section, cue, confirmed) {
      if (confirmed !== true) throw new Error('Confirm that you will edit the real file in your editor.');
      const exercise = describe(tour, entry, section, cue);
      if (!exercise) throw new Error('This cue has no exercise.');
      const active = jobs.get(entry.id);
      if (active?.state === 'watching' || active?.checking) throw new Error('This tour already has an active exercise.');
      const file = await tourFile(tour.codeRoot, exercise.file);
      const { text } = await readSource(file);
      if (matches(text, exercise)) throw new Error('This file already satisfies the exercise.');
      if (jobs.get(entry.id) !== active) throw new Error('This tour already has an active exercise.');
      const job = {
        id: entry.id, entry, exercise, file, root: tour.codeRoot, state: 'watching',
        key: section + ':' + cue, startedAt: Date.now(), before: text, undoAvailable: false,
      };
      job.timer = setInterval(() => void inspect(job), 350).unref();
      jobs.set(entry.id, job);
      return result(job);
    },
    status(id) {
      const job = jobs.get(id);
      return job ? result(job) : null;
    },
    async undo(id, confirmed) {
      if (confirmed !== true) throw new Error('Confirm that you want to restore the original line.');
      const job = jobs.get(id);
      if (!job?.undoAvailable || job.state !== 'done' || job.checking) throw new Error('This exercise cannot be undone.');
      const temporary = path.join(path.dirname(job.file), '.learn-undo-' + randomUUID());
      job.checking = true;
      try {
        const file = await tourFile(job.root, job.exercise.file);
        if (file !== job.file || await protectedFile(file, job.entry)) throw new Error('This exercise file is protected or moved.');
        const { text, mode } = await readSource(file);
        if (text !== job.after) throw new Error('The file changed after the exercise.');
        await writeFile(temporary, job.before, { flag: 'wx', mode });
        if (await tourFile(job.root, job.exercise.file) !== file || (await readSource(file)).text !== job.after) {
          throw new Error('The file changed after the exercise.');
        }
        await rename(temporary, file);
        job.state = 'undone';
        job.undoAvailable = false;
        return result(job);
      } finally {
        job.checking = false;
        await rm(temporary, { force: true });
      }
    },
    dispose() {
      for (const job of jobs.values()) stop(job);
      jobs.clear();
    },
  };
}
