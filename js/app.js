// Browse view: home, folders, favorites and search.
import * as data from './library.js';
import * as db from './db.js';
import { $, ICON, esc, bookName, parentOf, plural, byName, fold, openSheet, closeSheet } from './util.js';
import { openBook, closeBook, isReading } from './reader.js';
import { setupUpdates, appVersion } from './update.js';

const { lib } = data;
const urls = new Map(); // path -> { blob, url }
let view = { type: 'folder', path: '' };
let query = '', onlyHere = false, hasAccess = false;
let columns = { portrait: 5, landscape: 7 };
const portrait = matchMedia('(orientation: portrait)');

function coverUrl(book) {
  let entry = urls.get(book.path);
  if (entry?.blob !== book.cover) {
    if (entry) URL.revokeObjectURL(entry.url);
    entry = { blob: book.cover, url: URL.createObjectURL(book.cover) };
    urls.set(book.path, entry);
  }
  return entry.url;
}

function tileInner(path) {
  const book = lib.books.get(path);
  const badge = data.stateOf(path).fav ? `<span class="badge">${ICON.star}</span>` : '';
  return (book.cover ? `<img src="${coverUrl(book)}" alt="${esc(bookName(path))}" loading="lazy" decoding="async">` : '<span class="wait">…</span>') + badge;
}

const grid = paths => `<div class="grid">${paths.map(p =>
  `<button class="tile" data-book="${esc(p)}" aria-label="${esc(bookName(p))}">${tileInner(p)}</button>`).join('')}</div>`;

// Folders are worked out from the book paths. Counts include subfolders.
function folderCounts() {
  const counts = new Map();
  for (const path of lib.books.keys())
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) counts.set(dir, (counts.get(dir) || 0) + 1);
  return counts;
}

const leaf = path => path.split('/').pop();
const folderCard = (path, sub, star) => `<button class="folder" data-folder="${esc(path)}">${ICON.folder}${star ? '<em>★</em>' : ''}<b>${esc(leaf(path))}</b><span>${esc(sub)}</span></button>`;
const section = (title, note = '') => `<h2>${title}<small>${note}</small></h2>`;
const empty = (text, button = '') => `<div class="empty">${text}${button ? `<br>${button}` : ''}</div>`;

function render() {
  const counts = folderCounts();
  const all = [...lib.books.keys()].sort(byName);
  const inFolder = view.type === 'folder' && view.path !== '';
  const home = view.type === 'folder' && view.path === '';
  const favBooks = all.filter(p => data.stateOf(p).fav);
  let html = '', shown = [];

  $('backBtn').hidden = home;
  $('favBtn').hidden = !inFolder;
  $('favBtn').classList.toggle('on', lib.favFolders.includes(view.path));
  $('title').textContent = home ? 'Bookshelf' : view.type === 'favorites' ? 'Favorite books' : leaf(view.path);
  const inside = inFolder ? all.filter(p => p.startsWith(`${view.path}/`)) : [];
  const direct = all.filter(p => parentOf(p) === (inFolder ? view.path : ''));
  $('subtitle').textContent = lib.status || (home ? `${plural(all.length, 'book')} in ${plural(counts.size, 'folder')}`
    : view.type === 'favorites' ? plural(favBooks.length, 'book')
      : `${plural(inside.length, 'book')}, including subfolders · ${direct.length} here`);
  $('search').placeholder = inFolder ? `Search in ${leaf(view.path)} or everywhere` : 'Search books and folders';
  $('searchBox').hidden = !lib.root;
  $('clearSearch').hidden = !query;
  $('banner').hidden = !lib.root || hasAccess;
  $('banner').innerHTML = '<span>Allow access to your book folder to open books and check for changes.</span><button class="pill" data-act="allow">Allow</button>';

  if (!lib.root) {
    html = window.showDirectoryPicker
      ? empty('Choose the folder that holds your PDF books.<br>The books stay on this device.', '<button class="pill" data-act="pick">Choose folder</button>')
      : empty('This browser cannot open folders. Use Chrome on your tablet or computer.');
  } else if (query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const match = name => words.every(w => fold(name).includes(w));
    const scope = p => !(onlyHere && inFolder) || p.startsWith(`${view.path}/`);
    const folders = [...counts.keys()].filter(p => scope(p) && match(leaf(p))).sort(byName);
    shown = all.filter(p => scope(p) && match(bookName(p)));
    if (inFolder) html += `<div class="chips"><button class="chip ${onlyHere ? '' : 'on'}" data-act="everywhere">All folders</button><button class="chip ${onlyHere ? 'on' : ''}" data-act="here">Only ${esc(leaf(view.path))}</button></div>`;
    if (folders.length) html += section('Folders', folders.length) + `<div class="folders">${folders.map(p =>
      folderCard(p, `${plural(counts.get(p), 'book')}${parentOf(p) ? ` · ${parentOf(p).replaceAll('/', ' › ')}` : ''}`)).join('')}</div>`;
    if (shown.length) html += section('Books', shown.length) + grid(shown);
    if (!folders.length && !shown.length) html += empty('Nothing found.');
  } else if (view.type === 'favorites') {
    shown = favBooks;
    html = shown.length ? '<h2></h2>' + grid(shown) : empty('No favorite books yet.<br>Open a book, tap the middle of the page, then tap the star.');
  } else {
    const favs = lib.favFolders.filter(p => counts.has(p)).sort(byName);
    if (home && (favs.length || favBooks.length)) {
      html += section('Favorites') + '<div class="folders">' +
        (favBooks.length ? `<button class="folder" data-act="favorites">${ICON.star}<b>Favorite books</b><span>${plural(favBooks.length, 'book')}</span></button>` : '') +
        favs.map(p => folderCard(p, plural(counts.get(p), 'book'), true)).join('') + '</div>';
    }
    const subs = [...counts.keys()].filter(p => parentOf(p) === view.path).sort(byName);
    if (subs.length) html += section('Folders') + `<div class="folders">${subs.map(p =>
      folderCard(p, plural(counts.get(p), 'book'), lib.favFolders.includes(p))).join('')}</div>`;
    shown = home ? all : direct;
    if (shown.length) html += section(home ? 'All books' : 'Books', shown.length) + grid(shown);
    if (!html) html = empty(lib.status ? 'Looking for books…' : hasAccess ? 'No PDF files found here.' : 'No saved books yet.');
  }
  $('content').innerHTML = html;
}

// Tells the cover maker the order the books are being looked at: from the top of the screen
// downwards, then the ones above, nearest first.
function viewOrder() {
  const tiles = document.querySelectorAll('.tile');
  let low = 0, high = tiles.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tiles[mid].getBoundingClientRect().bottom <= 0) low = mid + 1; else high = mid;
  }
  const order = [];
  for (let i = low; i < tiles.length; i++) order.push(tiles[i].dataset.book);
  for (let i = low - 1; i >= 0; i--) order.push(tiles[i].dataset.book);
  return order;
}
data.setViewOrder(viewOrder);
addEventListener('scroll', data.scrolled, { capture: true, passive: true });

const seconds = ms => ms < 90000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;
const megabytes = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
function timingsHtml() {
  const { find, covers, open } = data.lib.timings;
  const lines = [];
  if (find) lines.push(`Last check: ${plural(find.files, 'book')} found in ${seconds(find.ms)}`);
  if (covers) lines.push(`Last covers: ${covers.count} in ${seconds(covers.ms)}. Per book: ${seconds(covers.jobMs / covers.count)}, of which reading ${seconds(covers.readMs / covers.count)}, ${megabytes(covers.bytes / covers.count)} read in ${Math.round((covers.reads || 0) / covers.count)} pieces, finding the file ${seconds((covers.fileMs || 0) / covers.count)}`);
  if (open) lines.push(`Last book opened in ${seconds(open.ms)}${open.picture ? ' (picture shown at once)' : ''}: file ${seconds(open.fileMs ?? 0)}, drawing ${seconds(open.ms - (open.fileMs ?? 0))}, of which reading ${seconds(open.readMs)}, ${megabytes(open.bytes)} read`);
  return lines.length ? `<h4>Timings</h4>${lines.map(l => `<p class="dim">${l}</p>`).join('')}` : '';
}

let renderTimer = 0;
const renderSoon = () => { renderTimer ||= setTimeout(() => { renderTimer = 0; render(); }, 100); };

lib.onChange = renderSoon;
lib.onCover = path => {
  document.querySelectorAll('.tile').forEach(el => { if (el.dataset.book === path) el.innerHTML = tileInner(path); });
};
lib.onStatus = () => { $('subtitle').textContent = lib.status || $('subtitle').textContent; };

function applyColumns() {
  document.documentElement.style.setProperty('--cols', columns[portrait.matches ? 'portrait' : 'landscape']);
}
portrait.addEventListener('change', applyColumns);

function go(next) {
  view = next;
  history.pushState({ view }, '');
  resetSearch();
  render();
  scrollTo(0, 0);
}
function resetSearch() { query = ''; onlyHere = false; $('search').value = ''; }

addEventListener('popstate', e => {
  closeSheet();
  if (isReading()) { closeBook(); render(); return; }
  view = e.state?.view || { type: 'folder', path: '' };
  resetSearch();
  render();
});

async function pick() {
  let handle;
  try { handle = await showDirectoryPicker({ id: 'books', mode: 'read' }); }
  catch { return; }
  await data.setRoot(handle);
  hasAccess = await data.permission(true);
  view = { type: 'folder', path: '' };
  history.replaceState({ view }, '');
  lib.status = 'Looking for books…';
  render();
  data.scan();
}

async function allow() {
  hasAccess = await data.permission(true);
  render();
  if (hasAccess) data.scan();
}

$('content').addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;
  if (el.dataset.book !== undefined) {
    const wasAllowed = hasAccess;
    const opened = await openBook(el.dataset.book);
    hasAccess = await data.permission();
    if (opened && !wasAllowed && hasAccess) data.scan();
  } else if (el.dataset.folder !== undefined) go({ type: 'folder', path: el.dataset.folder });
  else if (el.dataset.act === 'favorites') go({ type: 'favorites' });
  else if (el.dataset.act === 'pick') pick();
  else if (el.dataset.act === 'here' || el.dataset.act === 'everywhere') { onlyHere = el.dataset.act === 'here'; render(); }
});
$('banner').addEventListener('click', e => { if (e.target.closest('button')) allow(); });
$('backBtn').onclick = () => history.back();
$('favBtn').onclick = async () => { await data.toggleFavFolder(view.path); render(); };
$('search').addEventListener('input', e => { query = e.target.value.trim(); render(); });
$('clearSearch').onclick = () => { resetSearch(); render(); };
$('sheetBack').addEventListener('click', e => { if (e.target === $('sheetBack')) closeSheet(); });

$('menuBtn').onclick = async () => {
  const side = portrait.matches ? 'portrait' : 'landscape';
  const sheet = openSheet(`<h3>Settings</h3>
    <div class="setting"><span>Columns (${side})</span><div class="step"><button class="round" data-step="-1">−</button><b id="colCount">${columns[side]}</b><button class="round" data-step="1">+</button></div></div>
    <h4>Library</h4>
    <button class="wide" data-act="rescan">Check for new and changed books</button>
    <button class="wide" data-act="covers">Refresh all covers</button>
    <button class="wide" data-act="pick">${lib.root ? 'Change book folder' : 'Choose book folder'}</button>
    ${timingsHtml()}
    <p class="dim" id="version" style="margin-top:16px"></p>`);
  sheet.onclick = async e => {
    const el = e.target.closest('button');
    if (!el) return;
    if (el.dataset.step) {
      columns[side] = Math.min(10, Math.max(2, columns[side] + Number(el.dataset.step)));
      $('colCount').textContent = columns[side];
      applyColumns();
      db.kvSet('columns', columns);
      return;
    }
    closeSheet();
    if (el.dataset.act === 'pick') return pick();
    hasAccess = await data.permission(true);
    render();
    if (!hasAccess) return;
    if (el.dataset.act === 'covers') data.refreshAll(); else data.scan();
  };
  const version = await appVersion();
  if ($('version')) $('version').textContent = `Bookshelf ${version}`;
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && hasAccess && !isReading()) data.scan();
});

async function start() {
  $('backBtn').innerHTML = ICON.back;
  $('favBtn').innerHTML = ICON.star;
  $('menuBtn').innerHTML = ICON.settings;
  $('searchIcon').innerHTML = ICON.search;
  await data.load();
  columns = { ...columns, ...await db.kvGet('columns') };
  applyColumns();
  hasAccess = await data.permission();
  history.replaceState({ view }, '');
  render();
  setupUpdates();
  if (hasAccess) data.scan();
}
start();
