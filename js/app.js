// Browse view: home, folders, favorites and search.
import * as data from './library.js';
import { showSpeedTest } from './speedtest.js';
import * as db from './db.js';
import { $, ICON, esc, bookName, parentOf, plural, byName, fold, openSheet, closeSheet } from './util.js';
import { openBook, closeBook, isReading } from './reader.js';
import { setupUpdates, appVersion, checkAppUpdate } from './update.js';
import { app } from './native.js';

const { lib } = data;
const urls = new Map(); // path -> { blob, url }
let view = { type: 'folder', path: '' };
let query = '', onlyHere = false, hasAccess = false;
// A phone starts with fewer columns than a tablet.
let columns = Math.min(screen.width, screen.height) < 600 ? { portrait: 3, landscape: 6 } : { portrait: 5, landscape: 7 };
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

// Folders are worked out from the book paths. A folder holds only the books directly in it, and
// every folder with books of its own is listed on the home screen, however deep it is.
function folderCounts() {
  const counts = new Map();
  for (const path of lib.books.keys()) {
    const dir = parentOf(path);
    if (dir) counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  return counts;
}

const leaf = path => path.split('/').pop();
const folderCard = (path, sub, star) => `<button class="folder" data-folder="${esc(path)}">${ICON.folder}${star ? '<em>★</em>' : ''}<b>${esc(leaf(path))}</b><span>${esc(sub)}</span></button>`;
// The folders it lies in, to tell equal names apart.
const where = path => parentOf(path) ? ` · ${parentOf(path).replaceAll('/', ' › ')}` : '';
const section = (title, note = '') => `<h2>${title}<small>${note}</small></h2>`;
const empty = (text, button = '') => `<div class="empty">${text}${button ? `<br>${button}` : ''}</div>`;

function render() {
  const counts = folderCounts();
  const listed = new Set(counts.keys());
  const all = [...lib.books.keys()].sort(byName);
  const inFolder = view.type === 'folder' && view.path !== '';
  const home = view.type === 'folder' && view.path === '';
  const favBooks = all.filter(p => data.stateOf(p).fav);
  let html = '', shown = [];

  $('backBtn').hidden = home;
  $('favBtn').hidden = !inFolder;
  $('favBtn').classList.toggle('on', lib.favFolders.includes(view.path));
  $('title').textContent = home ? 'Bookshelf' : view.type === 'favorites' ? 'Favorite books' : leaf(view.path);
  const direct = inFolder ? all.filter(p => parentOf(p) === view.path) : [];
  $('subtitle').textContent = lib.status || (home ? `${plural(all.length, 'book')} in ${plural(listed.size, 'folder')}`
    : view.type === 'favorites' ? plural(favBooks.length, 'book')
      : plural(direct.length, 'book'));
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
    const here = onlyHere && inFolder;
    const folders = here ? [] : [...listed].filter(p => match(leaf(p))).sort(byName);
    shown = (here ? direct : all).filter(p => match(bookName(p)));
    if (inFolder) html += `<div class="chips"><button class="chip ${onlyHere ? '' : 'on'}" data-act="everywhere">All folders</button><button class="chip ${onlyHere ? 'on' : ''}" data-act="here">Only ${esc(leaf(view.path))}</button></div>`;
    if (folders.length) html += section('Folders', folders.length) + `<div class="folders">${folders.map(p =>
      folderCard(p, `${plural(counts.get(p), 'book')}${where(p)}`)).join('')}</div>`;
    if (shown.length) html += section('Books', shown.length) + grid(shown);
    if (!folders.length && !shown.length) html += empty('Nothing found.');
  } else if (view.type === 'favorites') {
    shown = favBooks;
    html = shown.length ? '<h2></h2>' + grid(shown) : empty('No favorite books yet.<br>Open a book, tap the middle of the page, then tap the star.');
  } else {
    const favs = lib.favFolders.filter(p => listed.has(p)).sort(byName);
    if (home && (favs.length || favBooks.length)) {
      html += section('Favorites') + '<div class="folders">' +
        (favBooks.length ? `<button class="folder" data-act="favorites">${ICON.star}<b>Favorite books</b><span>${plural(favBooks.length, 'book')}</span></button>` : '') +
        favs.map(p => folderCard(p, plural(counts.get(p), 'book'), true)).join('') + '</div>';
    }
    const subs = home ? [...listed].sort((a, b) => byName(leaf(a), leaf(b)) || byName(a, b)) : [];
    if (subs.length) html += section('Folders') + `<div class="folders">${subs.map(p =>
      folderCard(p, `${plural(counts.get(p), 'book')}${where(p)}`, lib.favFolders.includes(p))).join('')}</div>`;
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
  if (covers && window.AndroidBridge) lines.push(`Last covers: ${covers.count} in ${seconds(covers.ms)} (${(covers.count / covers.ms * 1000).toFixed(1)} a second)`);
  else if (covers) {
    const each = key => seconds((covers[key] || 0) / covers.count);
    lines.push(`Last covers: ${covers.count} in ${seconds(covers.ms)} (${(covers.count / covers.ms * 1000).toFixed(1)} a second, ${covers.lanes || 3} at a time). Per book ${each('jobMs')}: finding the file ${each('fileMs')}, first read ${each('firstMs')}, waiting to draw ${each('waitMs')}, more reading ${each('readMs')}, picture ${each('drawMs')}, tile ${each('tileMs')}, saving ${each('saveMs')}. ${megabytes(covers.bytes / covers.count)} in ${((covers.reads || 0) / covers.count).toFixed(1)} reads per book, ${covers.direct || 0} scanned pictures taken directly`);
  }
  if (open) lines.push(`Last book opened in ${seconds(open.ms)}${open.picture ? ' (picture shown at once)' : ''}: file ${seconds(open.fileMs ?? 0)}, drawing ${seconds(open.ms - (open.fileMs ?? 0))}${open.bytes ? `, of which reading ${seconds(open.readMs)}, ${megabytes(open.bytes)} read` : ''}`);
  return lines.length ? `<h4>Timings</h4>${lines.map(l => `<p class="dim">${l}</p>`).join('')}` : '';
}

let renderTimer = 0;
const renderSoon = () => { renderTimer ||= setTimeout(() => { renderTimer = 0; render(); }, 100); };

lib.onChange = renderSoon;
lib.onFound = () => { if (!isReading()) render(); };
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
    ${app ? '' : '<button class="wide" data-act="speed">Test file speed</button>'}
    <button class="wide" data-act="pick">${lib.root ? 'Change book folder' : 'Choose book folder'}</button>
    ${timingsHtml()}
    <p class="dim" id="version" style="margin-top:16px"></p>
    ${app ? '<button class="wide" data-act="update">Check for updates</button>' : ''}
    <a class="support" href="https://paypal.me/neckfors" target="_blank" rel="noopener">&#9829; Support the author</a>`);
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
    if (el.dataset.act === 'update') {
      el.textContent = 'Checking…';
      el.textContent = await checkAppUpdate();
      return;
    }
    closeSheet();
    if (el.dataset.act === 'pick') return pick();
    hasAccess = await data.permission(true);
    render();
    if (!hasAccess) return;
    if (el.dataset.act === 'speed') return showSpeedTest(await appVersion(), timingsHtml());
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
