// The collection: saved covers, per-book state, and checking the folder for changes.
import * as db from './db.js';
import { makeCover, coverWorker } from './covers.js';
import { warmUp } from './pdf.js';
import { byName } from './util.js';

export const lib = {
  root: null,
  books: new Map(),   // path -> { path, size, mtime, cover, stale }
  states: new Map(),  // path -> per-book settings
  favFolders: [],
  status: '',
  reading: false,
  timings: {},
  onChange: () => {},
  onCover: () => {},
  onStatus: () => {},
};

export async function load() {
  const [books, states, root, favs, timings] = await Promise.all(
    [db.getAll('books'), db.getAll('state'), db.kvGet('root'), db.kvGet('favFolders'), db.kvGet('timings')]);
  lib.timings = timings || {};
  books.forEach(b => lib.books.set(b.path, b));
  states.forEach(s => lib.states.set(s.path, s));
  lib.root = root || null;
  if (lib.root) warmUp();
  lib.favFolders = favs || [];
}

const DEFAULTS = { layout: 'cover', portraitSingle: false, rtl: false, trim: false, tone: 'normal', page: 1, marks: [], fav: false, coverPage: 1, coverPart: 'whole' };
export const stateOf = path => ({ ...DEFAULTS, marks: [], ...lib.states.get(path), path });
export function saveState(state) {
  lib.states.set(state.path, state);
  return db.put('state', state);
}
export function toggleFavFolder(path) {
  const i = lib.favFolders.indexOf(path);
  if (i < 0) lib.favFolders.push(path); else lib.favFolders.splice(i, 1);
  return db.kvSet('favFolders', lib.favFolders);
}

export async function permission(ask = false) {
  if (!lib.root) return false;
  if (!lib.root.queryPermission) return true;
  const mode = { mode: 'read' };
  if (await lib.root.queryPermission(mode) === 'granted') return true;
  return ask && await lib.root.requestPermission(mode) === 'granted';
}

export async function setRoot(handle) {
  const same = lib.root && await lib.root.isSameEntry(handle);
  lib.root = handle;
  handles.clear();
  await db.kvSet('root', handle);
  if (!same) {
    lib.books.clear();
    await db.clear('books');
  }
  navigator.storage?.persist?.();
}

// File handles seen while reading the folder. Looking a file up again by name can be slow on Android,
// where each step may mean listing a whole folder.
const handles = new Map();
export async function fileFor(path) {
  const known = handles.get(path);
  if (known) {
    try { return await known.getFile(); }
    catch { handles.delete(path); }
  }
  const parts = path.split('/');
  let dir = lib.root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await dir.getFileHandle(parts.at(-1))).getFile();
}

async function* walk(dir, prefix) {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (handle.kind === 'directory') yield* walk(handle, `${prefix}${name}/`);
    else if (/\.pdf$/i.test(name)) yield [prefix + name, handle];
  }
}

// How long the last check, cover run and book opening took (shown in Settings).
export function saveTiming(key, value) {
  lib.timings[key] = value;
  return db.kvSet('timings', lib.timings);
}
export const newStats = () => ({ bytes: 0, readMs: 0, reads: 0, drawMs: 0, direct: 0 });

// While books are being found, redraw now and then instead of for every file.
let lastNotify = 0;
function notify() {
  if (performance.now() - lastNotify < 800) return;
  lastNotify = performance.now();
  lib.onChange();
}

let scanning = null, again = false;
export function scan() {
  if (scanning) { again = true; return scanning; }
  return scanning = (async () => {
    try {
      do { again = false; await scanOnce(); } while (again);
      lib.status = '';
    } catch (e) {
      console.error(e);
      lib.status = e?.name === 'ReaderLoadError' ? 'The PDF reader could not be loaded. Check the network and try again.'
        : 'Could not read the whole folder. Showing saved covers.';
    } finally {
      scanning = null;
      lib.onChange();
    }
  })();
}

// Finding books and making covers run side by side, so covers appear while the folder is still being read.
let run = null;
function startRun() {
  return run = { queue: new Set(), lanes: [], finding: true, found: 0, total: 0, done: 0, error: null, started: 0, ms: 0, jobMs: 0, fileMs: 0, ...newStats() };
}

function showStatus() {
  const parts = [];
  if (run.finding) parts.push(`Looking for books: ${run.found} found`);
  if (run.total) parts.push(`Covers: ${run.done} of ${run.total}`);
  lib.status = parts.join(' · ');
}

// Much of the time goes to waiting for the file, so several covers are worked on at once.
const LANES = Math.min(6, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
function addJobs(paths) {
  for (const path of paths) if (!run.queue.has(path)) { run.queue.add(path); run.total++; }
  if (run.queue.size) run.started ||= performance.now();
  let busy = run.lanes.filter(l => l.busy).length;
  while (busy < LANES && busy < run.queue.size) {
    const lane = { busy: true };
    run.lanes.push(lane);
    lane.promise = coverLane(run, lane);
    busy++;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The browse view says what is being looked at: books on screen first, then the ones below, then above.
// It is asked each time a cover is started, so after scrolling the work moves to where you stopped.
let viewOrder = () => [];
let scrolledAt = -1000;
export const setViewOrder = fn => { viewOrder = fn; };
export const scrolled = () => { scrolledAt = performance.now(); };
function nextJob(queue) {
  for (const path of viewOrder()) if (queue.has(path)) return path;
  // Nothing in this view is waiting: carry on with the rest, in the order the library shows them.
  let first;
  for (const path of queue) if (first === undefined || byName(path, first) < 0) first = path;
  return first;
}
const workers = [];

async function coverLane(current, lane) {
  let worker;
  try {
    worker = workers.pop() || coverWorker();
    while (current.queue.size && !current.error) {
      // An open book gets all the speed.
      if (lib.reading) { await sleep(500); continue; }
      // Nothing is started in the middle of a scroll; books that only fly past are left for later.
      if (performance.now() - scrolledAt < 150) { await sleep(60); continue; }
      const path = nextJob(current.queue);
      current.queue.delete(path);
      const started = performance.now(), stats = newStats();
      try { await refreshCover(path, { worker, stats }); }
      catch (e) {
        console.error(path, e);
        if (e?.name === 'ReaderLoadError') throw e;
      }
      current.done++;
      current.jobMs += performance.now() - started;
      current.bytes += stats.bytes;
      current.readMs += stats.readMs;
      current.reads += stats.reads;
      current.fileMs += stats.fileMs || 0;
      current.drawMs += stats.drawMs;
      current.direct += stats.direct;
      current.ms = performance.now() - current.started;
      if (run === current) {
        showStatus();
        lib.onStatus();
      }
    }
  } catch (e) {
    current.error = e;
  } finally {
    lane.busy = false;
    if (worker) workers.push(worker);
  }
}

// Listing a folder only gives names, which is enough to show the books. New ones are added right away.
async function addFound(batch) {
  const added = [];
  for (const [path, handle] of batch) {
    handles.set(path, handle);
    if (lib.books.has(path)) continue;
    const book = { path, size: null, mtime: null, cover: null, stale: true };
    lib.books.set(path, book);
    added.push(book);
  }
  if (added.length) await db.putMany('books', added);
  return added.map(b => b.path);
}

// Asking for a file's size and date is slow on Android, so changed files are looked for afterwards.
async function checkChanged(root, paths) {
  for (let i = 0; i < paths.length && lib.root === root; i += 4) {
    while (lib.reading) await sleep(500);
    const changed = [];
    await Promise.all(paths.slice(i, i + 4).map(async path => {
      const book = lib.books.get(path);
      if (!book || book.stale) return;
      try {
        const file = await fileFor(path);
        if (book.size === file.size && book.mtime === file.lastModified) return;
        // A changed file keeps showing its old cover until the new one is ready.
        book.stale = true;
        changed.push(book);
      } catch (e) { console.warn(path, e); }
    }));
    if (changed.length && lib.root === root) {
      await db.putMany('books', changed);
      addJobs(changed.map(b => b.path));
    }
  }
}

async function scanOnce() {
  const root = lib.root;
  const current = startRun();
  const began = performance.now();
  const found = new Set(), known = [];
  let batch = [];
  const flush = async () => {
    const added = await addFound(batch);
    batch = [];
    addJobs(added);
    showStatus();
    notify();
  };
  try {
    // Covers left over from last time can start right away.
    addJobs([...lib.books.values()].filter(b => b.stale).map(b => b.path));
    for await (const entry of walk(root, '')) {
      if (lib.root !== root) { again = true; current.queue.clear(); return; }
      found.add(entry[0]);
      if (lib.books.has(entry[0])) known.push(entry[0]);
      current.found = found.size;
      batch.push(entry);
      if (batch.length >= 12) await flush();
    }
    if (batch.length) await flush();
    // Only reached when the whole folder was read, so an error never removes books.
    for (const path of [...lib.books.keys()]) if (!found.has(path)) {
      lib.books.delete(path);
      current.queue.delete(path);
      await db.del('books', path);
      await db.del('kv', `preview:${path}`);
    }
    await saveTiming('find', { files: found.size, ms: performance.now() - began });
    current.finding = false;
    showStatus();
    lib.onChange();
    // New covers come first: both jobs would be waiting for the same files.
    await Promise.all(current.lanes.map(l => l.promise));
    if (!current.error) await checkChanged(root, known);
  } finally {
    current.finding = false;
    await Promise.all(current.lanes.map(l => l.promise));
    if (current.done) await saveTiming('covers', { count: current.done, ms: current.ms, jobMs: current.jobMs, bytes: current.bytes, readMs: current.readMs, reads: current.reads, fileMs: current.fileMs,
      drawMs: current.drawMs, direct: current.direct, lanes: LANES });
  }
  if (current.error) throw current.error;
}

export async function refreshCover(path, tools = {}) {
  const book = lib.books.get(path);
  if (!book) return;
  const began = performance.now();
  const file = await fileFor(path);
  if (tools.stats) tools.stats.fileMs = performance.now() - began;
  const cover = await makeCover(file, path, stateOf(path), tools);
  if (lib.books.get(path) !== book) return;
  Object.assign(book, { cover, stale: false, size: file.size, mtime: file.lastModified });
  await db.put('books', book);
  lib.onCover(path);
}

export async function refreshAll() {
  // New objects, so a cover that is being made right now is thrown away and redone.
  for (const [path, book] of lib.books) lib.books.set(path, { ...book, stale: true });
  await db.putMany('books', [...lib.books.values()]);
  return scan();
}
