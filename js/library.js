// The collection: saved covers, per-book state, and checking the folder for changes.
import * as db from './db.js';
import { makeCover } from './covers.js';

export const lib = {
  root: null,
  books: new Map(),   // path -> { path, size, mtime, cover, stale }
  states: new Map(),  // path -> per-book settings
  favFolders: [],
  status: '',
  onChange: () => {},
  onCover: () => {},
};

export async function load() {
  const [books, states, root, favs] = await Promise.all(
    [db.getAll('books'), db.getAll('state'), db.kvGet('root'), db.kvGet('favFolders')]);
  books.forEach(b => lib.books.set(b.path, b));
  states.forEach(s => lib.states.set(s.path, s));
  lib.root = root || null;
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
  await db.kvSet('root', handle);
  if (!same) {
    lib.books.clear();
    await db.clear('books');
  }
  navigator.storage?.persist?.();
}

export async function fileFor(path) {
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

let scanning = null, again = false;
export function scan() {
  if (scanning) { again = true; return scanning; }
  return scanning = (async () => {
    try {
      do { again = false; await scanOnce(); await buildCovers(); } while (again);
      lib.status = '';
    } catch (e) {
      console.error(e);
      lib.status = 'Could not read the whole folder. Showing saved covers.';
    } finally {
      scanning = null;
      lib.onChange();
    }
  })();
}

async function scanOnce() {
  const root = lib.root;
  const found = new Set();
  let changed = false;
  for await (const [path, handle] of walk(root, '')) {
    if (lib.root !== root) { again = true; return; }
    found.add(path);
    const file = await handle.getFile();
    const old = lib.books.get(path);
    if (old && old.size === file.size && old.mtime === file.lastModified) continue;
    // A changed file keeps showing its old cover until the new one is ready.
    const book = { path, size: file.size, mtime: file.lastModified, cover: old?.cover || null, stale: true };
    lib.books.set(path, book);
    await db.put('books', book);
    changed = true;
  }
  // Only reached when the whole folder was read, so an error never removes books.
  for (const path of [...lib.books.keys()]) if (!found.has(path)) {
    lib.books.delete(path);
    await db.del('books', path);
    changed = true;
  }
  if (changed) lib.onChange();
}

// Paths on screen are done first.
export let wanted = new Set();
export const want = paths => { wanted = new Set(paths); };

async function buildCovers() {
  const queue = new Set([...lib.books.values()].filter(b => b.stale).map(b => b.path));
  const total = queue.size;
  while (queue.size) {
    const path = [...wanted].find(p => queue.has(p)) ?? queue.values().next().value;
    queue.delete(path);
    lib.status = `Creating covers: ${total - queue.size} of ${total}`;
    try { await refreshCover(path); }
    catch (e) {
      console.error(path, e);
      if (e?.name === 'ReaderLoadError') throw e;
    }
  }
}

export async function refreshCover(path) {
  const book = lib.books.get(path);
  if (!book) return;
  const cover = await makeCover(await fileFor(path), path, stateOf(path));
  if (lib.books.get(path) !== book) return;
  book.cover = cover;
  book.stale = false;
  await db.put('books', book);
  lib.onCover(path);
}

export async function refreshAll() {
  for (const book of lib.books.values()) {
    book.stale = true;
    await db.put('books', book);
  }
  return scan();
}
