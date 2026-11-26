// Fullscreen reader.
import * as data from './library.js';
import * as db from './db.js';
import { openPdf, makeCanvas, renderPage, inkBox, crop } from './pdf.js';
import { openNative } from './native.js';
import { attachGestures } from './gestures.js';
import { $, ICON, esc, bookName, openSheet, closeSheet } from './util.js';

let book = null; // the open book
let wake = null;
let kept = null; // the last closed book stays open, so going back to it is instant
const slots = [...document.querySelectorAll('.slot')];
const stage = $('stage'), strip = $('strip');
const portrait = matchMedia('(orientation: portrait)');

export const isReading = () => !!book;

// What the saved picture of a book must match to be shown while the book is opening.
function previewKey(path, state) {
  const file = data.lib.books.get(path);
  return [file?.size, file?.mtime, state.page, state.layout, state.portraitSingle, state.rtl, state.trim, portrait.matches].join();
}

// A picture of the page that was showing is saved, to be shown at once next time.
function savePreview() {
  const canvas = slots[1].firstChild;
  if (canvas?.tagName !== 'CANVAS' || !book.spreads[book.index]?.includes(book.state.page)) return;
  const path = book.path, key = previewKey(path, book.state);
  canvas.toBlob(blob => { if (blob) db.kvSet(`preview:${path}`, { key, blob }).catch(console.error); }, 'image/jpeg', .85);
}

// Fills the screen while the book is opened: the saved page, or else the cover when that is what comes first.
async function showPreview(opening) {
  const { path, state } = opening;
  const saved = await db.kvGet(`preview:${path}`).catch(() => null);
  let blob = saved?.key === previewKey(path, state) ? saved.blob : null;
  const coverFirst = state.page === 1 && state.coverPage === 1 && state.coverPart === 'whole'
    && (state.layout !== 'double' || (state.portraitSingle && portrait.matches));
  if (!blob && coverFirst) blob = data.lib.books.get(path)?.cover;
  // The real page may already be there.
  if (!blob || book !== opening || slots[1].firstChild) return false;
  const img = new Image();
  img.className = 'preview';
  img.alt = '';
  img.onload = img.onerror = () => URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  slots[1].replaceChildren(img);
  $('loading').hidden = true;
  return true;
}

// Opens the file, unless it is the one that is still open from last time.
async function load(path, stats) {
  const file = await data.fileFor(path);
  const same = kept && kept.path === path && kept.size === file.size && kept.mtime === file.lastModified;
  const pdf = same ? kept.pdf : await (file.native ? openNative : openPdf)(file, { stats });
  if (same) kept = null;
  return { pdf, source: { path, size: file.size, mtime: file.lastModified } };
}

function buildSpreads() {
  const { state, count } = book;
  const single = state.layout === 'single' || (state.portraitSingle && portrait.matches);
  const spreads = [];
  let n = 1;
  if (!single && state.layout === 'cover') spreads.push([n++]);
  while (n <= count) {
    const spread = [n++];
    if (!single && n <= count) spread.push(n++);
    spreads.push(spread);
  }
  book.spreads = spreads;
  book.index = Math.max(0, spreads.findIndex(s => s.includes(book.page)));
}

export async function openBook(path) {
  // Full screen and folder access both need to be asked for while the tap is still fresh.
  const root = $('reader');
  root.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  if (!await data.permission(true)) { leaveFullscreen(); return false; }

  const state = data.stateOf(path);
  const opening = book = { path, state, spreads: [], index: 0, page: state.page, count: 0, cache: new Map(), sizes: new Set(), zoom: 1, x: 0, y: 0 };
  history.pushState({ reading: true }, '');
  root.hidden = false;
  document.body.style.overflow = 'hidden';
  slots.forEach(s => s.replaceChildren());
  showBars(false);
  $('loading').hidden = false;
  $('loading').textContent = 'Opening…';
  $('rTitle').textContent = bookName(path);
  applyTone();
  keepAwake();
  const preview = showPreview(opening);
  data.lib.reading = true;
  const began = performance.now(), stats = data.newStats();
  try {
    const { pdf, source } = await load(path, stats);
    if (book !== opening) { pdf.destroy(); return true; }
    const fileMs = performance.now() - began;
    book.pdf = pdf;
    book.source = source;
    book.count = pdf.numPages;
    // The file may have been replaced by a shorter one.
    if (book.page > book.count) book.page = book.count;
    state.marks = state.marks.filter(m => m <= book.count);
    buildSpreads();
    await show();
    if (book === opening) {
      $('loading').hidden = true;
      data.saveTiming('open', { ms: performance.now() - began, fileMs, picture: await preview, bytes: stats.bytes, readMs: stats.readMs });
    }
  } catch (e) {
    console.error(e);
    if (book === opening) {
      book.broken = true;
      slots[1].replaceChildren();
      $('loading').hidden = false;
      $('loading').textContent = e?.name === 'PasswordException' ? 'This book is password protected and cannot be opened.' : 'This book could not be opened.';
      showBars(true);
      $('bottomBar').hidden = true;
    }
  }
  return true;
}

function leaveFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Called when the history entry of the reader is left (close button, back gesture, end of book).
export function closeBook() {
  if (!book) return;
  save();
  savePreview();
  if (book.pdf && !book.broken) {
    kept?.pdf.destroy();
    kept = { ...book.source, pdf: book.pdf };
  } else book.pdf?.destroy();
  book = null;
  data.lib.reading = false;
  $('reader').hidden = true;
  document.body.style.overflow = '';
  slots.forEach(s => s.replaceChildren());
  wake?.release().catch(() => {});
  wake = null;
  leaveFullscreen();
}
const requestClose = () => history.back();

// A book whose last page is on screen starts from the beginning next time.
function save() {
  if (!book?.spreads.length) return;
  const atEnd = book.spreads[book.index].includes(book.count);
  book.state.page = atEnd ? 1 : book.page;
  data.saveState(book.state);
}

async function keepAwake() {
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not available */ }
}

// Draws the pages of one spread side by side into a canvas that fits the screen.
async function drawSpread(index, quality) {
  const current = book;
  const { pdf, state, spreads } = current;
  const numbers = state.rtl ? [...spreads[index]].reverse() : spreads[index];
  const pages = await Promise.all(numbers.map(n => pdf.getPage(n)));
  const parts = [];
  for (const page of pages) {
    let box = { x: 0, y: 0, w: 1, h: 1 };
    if (state.trim) {
      const ink = inkBox(await renderPage(page, 200 / page.getViewport({ scale: 1 }).width));
      if (ink) {
        // A little air around the text, and never more than 20% off any side.
        const x0 = Math.min(Math.max(ink.x - .015, 0), .2), y0 = Math.min(Math.max(ink.y - .015, 0), .2);
        const x1 = Math.max(Math.min(ink.x + ink.w + .015, 1), .8), y1 = Math.max(Math.min(ink.y + ink.h + .015, 1), .8);
        box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
    const size = page.getViewport({ scale: 1 });
    parts.push({ page, box, ratio: size.width * box.w / (size.height * box.h), height: size.height * box.h });
  }
  const vw = stage.clientWidth, vh = stage.clientHeight;
  current.sizes.add(`${vw}x${vh}`);
  const totalRatio = parts.reduce((sum, p) => sum + p.ratio, 0);
  const cssH = Math.min(vh, vw / totalRatio), cssW = cssH * totalRatio;
  let density = (window.devicePixelRatio || 1) * quality;
  density = Math.min(density, Math.sqrt(16e6 / (cssW * cssH))); // stay within canvas memory limits
  const out = makeCanvas(cssW * density, cssH * density);
  const ctx = out.getContext('2d', { alpha: false });
  let x = 0;
  // The pages of a spread are drawn at the same time.
  const images = await Promise.all(parts.map(part => renderPage(part.page, out.height / part.height)));
  for (const [i, part] of parts.entries()) {
    const image = state.trim ? crop(images[i], part.box) : images[i];
    const w = out.height * part.ratio;
    ctx.drawImage(image, x, 0, w + .5, out.height);
    x += w;
  }
  out.style.width = `${cssW}px`;
  out.style.height = `${cssH}px`;
  return out;
}

function cached(index) {
  const { cache } = book;
  let entry = cache.get(index);
  if (!entry) {
    entry = drawSpread(index, 1);
    entry.catch(() => cache.delete(index));
    cache.set(index, entry);
  }
  return entry;
}

let showToken = 0;
async function show() {
  const current = book, token = ++showToken;
  const { index, spreads } = current;
  current.zoom = 1; current.x = current.y = 0;
  updateBars();
  for (const key of current.cache.keys()) if (Math.abs(key - index) > 2) current.cache.delete(key);
  const order = current.state.rtl ? [index + 1, index, index - 1] : [index - 1, index, index + 1];
  const fill = async i => {
    const target = order[i];
    if (target < 0 || target >= spreads.length) return slots[i].replaceChildren();
    const canvas = await cached(target);
    if (book !== current || token !== showToken) return;
    canvas.style.transform = '';
    slots[i].replaceChildren(canvas);
  };
  // Clear stale neighbours at once, then draw the current spread first.
  await fill(1);
  if (book !== current || token !== showToken) return;
  await fill(0);
  await fill(2);
}

function slide(x, animate) {
  strip.classList.toggle('anim', animate);
  strip.style.transform = x ? `translateX(${x}px)` : '';
}

let turning = false;
// step: +1 = next, -1 = previous
async function turn(step) {
  if (!book?.spreads.length || turning) return;
  const next = book.index + step;
  if (next >= book.spreads.length) return requestClose(); // past the last page: close the book
  if (next < 0) return slide(0, true);
  turning = true;
  const current = book;
  try {
    resetZoom();
    await cached(next);
    if (book !== current) return;
    const side = (current.state.rtl ? -step : step) > 0 ? 2 : 0;
    const canvas = await cached(next);
    if (slots[side].firstChild !== canvas) slots[side].replaceChildren(canvas);
    slide(side === 2 ? -stage.clientWidth : stage.clientWidth, true);
    await new Promise(resolve => setTimeout(resolve, 210));
    if (book !== current) return;
    current.index = next;
    current.page = current.spreads[next][0];
    // Move the new page into the middle before the strip jumps back.
    slots[1].replaceChildren(canvas);
    slide(0, false);
    save();
    show();
  } finally {
    turning = false;
  }
}

function jumpTo(page) {
  if (!book?.spreads.length) return;
  book.page = Math.min(Math.max(Math.round(page) || 1, 1), book.count);
  book.index = Math.max(0, book.spreads.findIndex(s => s.includes(book.page)));
  slots.forEach(s => s.replaceChildren());
  save();
  show();
}

// Redraw after rotation, resize or a setting that changes how pages look.
function redraw() {
  if (!book?.spreads.length) return;
  book.cache.clear();
  book.sizes.clear();
  buildSpreads();
  slide(0, false);
  slots.forEach(s => s.replaceChildren());
  show();
}
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  // Pages already drawn for this size are not drawn again.
  resizeTimer = setTimeout(() => {
    const size = `${stage.clientWidth}x${stage.clientHeight}`;
    if (book && [...book.sizes].some(s => s !== size)) redraw();
  }, 150);
}).observe(stage);

/* ---------- zoom ---------- */
const canvasNow = () => slots[1].querySelector('canvas');

function applyZoom() {
  const canvas = canvasNow();
  if (!canvas) return;
  const w = parseFloat(canvas.style.width), h = parseFloat(canvas.style.height);
  const vw = stage.clientWidth, vh = stage.clientHeight;
  const left = (vw - w) / 2, top = (vh - h) / 2;
  // Keep the page on screen: centred while smaller than the screen, edge to edge when larger.
  const limit = (pos, offset, size, view) => size <= view ? (view - size) / 2 - offset : Math.min(-offset, Math.max(view - size - offset, pos));
  book.x = limit(book.x, left, w * book.zoom, vw);
  book.y = limit(book.y, top, h * book.zoom, vh);
  canvas.style.transform = book.zoom === 1 ? '' : `translate(${book.x}px,${book.y}px) scale(${book.zoom})`;
}

function resetZoom() {
  if (!book) return;
  book.zoom = 1; book.x = book.y = 0;
  const canvas = canvasNow();
  if (canvas) canvas.style.transform = '';
}

let sharpToken = 0;
// After zooming in, draw the page again with more detail.
async function sharpen() {
  const current = book, canvas = canvasNow(), token = ++sharpToken;
  if (!current || !canvas || current.zoom < 1.3) return;
  const quality = Math.min(current.zoom, 4);
  if (canvas.dataset.quality >= quality) return;
  const index = current.index;
  const sharp = await drawSpread(index, quality);
  if (book !== current || token !== sharpToken || current.index !== index || current.zoom < 1.3 || canvasNow() !== canvas) return;
  sharp.dataset.quality = quality;
  slots[1].replaceChildren(sharp);
  applyZoom();
}

attachGestures(stage, {
  zoomed: () => book?.zoom > 1,
  zoom(factor, cx, cy, dx, dy) {
    const canvas = canvasNow();
    if (!canvas) return;
    const zoom = Math.min(6, Math.max(1, book.zoom * factor)), ratio = zoom / book.zoom;
    const originX = (stage.clientWidth - parseFloat(canvas.style.width)) / 2;
    const originY = (stage.clientHeight - parseFloat(canvas.style.height)) / 2;
    book.x = cx - originX - (cx - dx - originX - book.x) * ratio;
    book.y = cy - originY - (cy - dy - originY - book.y) * ratio;
    book.zoom = zoom;
    showBars(false);
    applyZoom();
  },
  pan(dx, dy) { if (!book) return; book.x += dx; book.y += dy; applyZoom(); },
  zoomEnd() {
    if (!book) return;
    if (book.zoom < 1.05) resetZoom(); else sharpen();
  },
  swipeMove(dx) { if (!turning) slide(dx, false); },
  swipeCancel() { if (!turning) slide(0, true); },
  swipeEnd(dx, speed) {
    if (turning) return;
    if (Math.abs(dx) > stage.clientWidth * .18 || (Math.abs(speed) > .4 && Math.abs(dx) > 30)) {
      turn((dx < 0 ? 1 : -1) * (book?.state.rtl ? -1 : 1));
    } else slide(0, true);
  },
  tap(x) {
    if (!book) return;
    if (!$('topBar').hidden) return showBars(false);
    const at = x / stage.clientWidth;
    if (at > .3 && at < .7) return showBars(true);
    turn((at >= .7 ? 1 : -1) * (book.state.rtl ? -1 : 1));
  },
});

addEventListener('keydown', e => {
  if (!book || !$('sheetBack').hidden || e.target.matches?.('input')) return;
  const dir = book.state.rtl ? -1 : 1;
  if (e.key === 'ArrowRight') turn(dir);
  else if (e.key === 'ArrowLeft') turn(-dir);
  else if (e.key === 'PageDown' || e.key === ' ') turn(1);
  else if (e.key === 'PageUp') turn(-1);
  else if (e.key === 'Escape') requestClose();
});

document.addEventListener('visibilitychange', () => {
  if (!book) return;
  if (document.visibilityState === 'hidden') save(); else keepAwake();
});

/* ---------- menu ---------- */
function showBars(on) {
  $('topBar').hidden = !on;
  $('bottomBar').hidden = !on || !book?.spreads.length;
}

const spreadLabel = () => {
  const spread = book.spreads[book.index];
  return `Page ${spread.join('–')} of ${book.count}`;
};

function updateBars() {
  $('slider').max = book.spreads.length - 1;
  $('slider').value = book.index;
  $('slider').style.direction = book.state.rtl ? 'rtl' : 'ltr';
  $('pageLabel').textContent = spreadLabel();
  $('rFav').classList.toggle('on', book.state.fav);
  $('rMark').classList.toggle('on', book.spreads[book.index].some(p => book.state.marks.includes(p)));
}

function applyTone() {
  $('reader').classList.remove('sepia', 'dark');
  if (book.state.tone !== 'normal') $('reader').classList.add(book.state.tone);
}

$('rClose').innerHTML = ICON.back;
$('rFav').innerHTML = ICON.star;
$('rMark').innerHTML = ICON.mark;
$('rToc').innerHTML = ICON.list;
$('rSet').innerHTML = ICON.settings;
$('rClose').onclick = requestClose;
$('rFav').onclick = () => {
  book.state.fav = !book.state.fav;
  data.saveState(book.state);
  $('rFav').classList.toggle('on', book.state.fav);
};
$('rMark').onclick = () => {
  if (!book.spreads.length) return;
  const spread = book.spreads[book.index], marks = book.state.marks;
  book.state.marks = spread.some(p => marks.includes(p)) ? marks.filter(p => !spread.includes(p)) : [...marks, spread[0]].sort((a, b) => a - b);
  save();
  updateBars();
};
$('slider').addEventListener('input', e => {
  $('pageLabel').textContent = `Page ${book.spreads[e.target.value].join('–')} of ${book.count}`;
});
$('slider').addEventListener('change', e => jumpTo(book.spreads[e.target.value][0]));

$('goTo').onclick = () => {
  // The reader element is what is in full screen, so the sheet cannot be seen until we leave it.
  const sheet = sheetInReader(`<h3>Go to page</h3><form><input class="num" type="number" inputmode="numeric" min="1" max="${book.count}" placeholder="1–${book.count}"><button class="pill">Go</button></form>`);
  const input = sheet.querySelector('input');
  input.focus();
  sheet.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const page = Number(input.value);
    closeSheet();
    if (page) { jumpTo(page); showBars(false); }
  };
};

// While reading, the sheet lives inside the reader so that it also shows in full screen.
function sheetInReader(html, onClose) {
  const back = $('sheetBack');
  $('reader').append(back);
  const sheet = openSheet(html, () => { document.body.append(back); onClose?.(); });
  sheet.onclick = null;
  return sheet;
}

async function outlineItems() {
  const items = [];
  const walk = async (nodes, depth) => {
    for (const node of nodes || []) {
      if (items.length >= 500) return;
      try {
        const dest = typeof node.dest === 'string' ? await book.pdf.getDestination(node.dest) : node.dest;
        if (dest?.[0] != null) {
          const page = typeof dest[0] === 'object' ? await book.pdf.getPageIndex(dest[0]) + 1 : dest[0] + 1;
          items.push({ title: node.title, page, depth });
        }
      } catch { /* entry points nowhere */ }
      await walk(node.items, depth + 1);
    }
  };
  await walk(await book.pdf.getOutline(), 0);
  return items;
}

$('rToc').onclick = async () => {
  if (!book.pdf) return;
  const current = book, toc = await outlineItems();
  if (book !== current) return;
  const row = (title, page, depth = 0) => `<button class="item" data-page="${page}" style="padding-left:${2 + depth * 16}px"><span>${esc(title)}</span><span class="dim">${page}</span></button>`;
  const sheet = sheetInReader(
    '<h3>Bookmarks</h3>' + (book.state.marks.map(p => row(`Page ${p}`, p)).join('') || '<p class="dim">No bookmarks yet.</p>') +
    '<h4>Contents</h4>' + (toc.map(t => row(t.title, t.page, t.depth)).join('') || '<p class="dim">This PDF has no table of contents.</p>'));
  sheet.onclick = e => {
    const el = e.target.closest('[data-page]');
    if (!el) return;
    closeSheet();
    showBars(false);
    jumpTo(Number(el.dataset.page));
  };
};

const screens = groups => `<div class="screens">${groups.map(g => `<span>${g.map(n => `<u>${n}</u>`).join('')}</span>`).join('')}</div>`;
const chips = (key, value, options) => `<div class="chips">${options.map(([v, label]) =>
  `<button class="chip ${v === value ? 'on' : ''}" data-key="${key}" data-value="${v}">${label}</button>`).join('')}</div>`;
const onOff = (key, value) => chips(key, String(value), [['false', 'Off'], ['true', 'On']]);

function settingsHtml() {
  const s = book.state;
  const layout = (id, label, groups) => `<button class="opt ${s.layout === id ? 'on' : ''}" data-key="layout" data-value="${id}">${label}${screens(groups)}</button>`;
  return `<h3>Settings for this book</h3><p class="dim">Saved for this book only.</p>
    <div class="layouts">${layout('single', 'Single page', [[1], [2], [3]])}${layout('double', 'Two pages', [[1, 2], [3, 4]])}${layout('cover', 'Two pages, cover alone', [[1], [2, 3], [4, 5]])}</div>
    <div class="setting"><span>Single page in portrait</span>${onOff('portraitSingle', s.portraitSingle)}</div>
    <div class="setting"><span>Right to left (manga)</span>${onOff('rtl', s.rtl)}</div>
    <div class="setting"><span>Trim white margins</span>${onOff('trim', s.trim)}</div>
    <div class="setting"><span>Page colour</span>${chips('tone', s.tone, [['normal', 'Normal'], ['sepia', 'Sepia'], ['dark', 'Dark']])}</div>
    <h4>Front cover in the browse view</h4>
    <div class="setting"><span>Taken from page</span><div class="step"><button class="round" data-cover="-1">−</button><b>${s.coverPage}</b><button class="round" data-cover="1">+</button></div></div>
    <div class="setting"><span>Part of the page</span>${chips('coverPart', s.coverPart, [['whole', 'Whole'], ['left', 'Left half'], ['right', 'Right half']])}</div>
    <button class="wide" data-cover="0">Refresh cover</button>`;
}

$('rSet').onclick = () => {
  if (!book.pdf) return;
  let coverChanged = false;
  const path = book.path;
  const sheet = sheetInReader(settingsHtml(), () => { if (coverChanged) data.refreshCover(path).catch(console.error); });
  sheet.onclick = e => {
    const el = e.target.closest('button');
    if (!el || !book) return;
    const s = book.state;
    if (el.dataset.cover !== undefined) {
      s.coverPage = Math.min(book.count, Math.max(1, s.coverPage + Number(el.dataset.cover)));
      coverChanged = true;
      if (el.dataset.cover === '0') el.textContent = 'Cover is refreshed when you close this';
    } else {
      const { key, value } = el.dataset;
      s[key] = value === 'true' ? true : value === 'false' ? false : value;
      if (key === 'coverPart') coverChanged = true;
      else if (key === 'tone') applyTone();
      else redraw();
    }
    data.saveState(s);
    if (el.dataset.cover !== '0') sheet.innerHTML = settingsHtml();
  };
};
