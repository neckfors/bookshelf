const VERSION = '1.6';
const SHELL = `bookshelf-${VERSION}`;
const LIBS = 'bookshelf-pdfjs-4.10.38';
const CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const PDFIUM = 'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.15.1/dist/';
const FILES = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/reader.js', 'js/gestures.js', 'js/library.js', 'js/covers.js', 'js/coverworker.js', 'js/scan.js', 'js/tile.js', 'js/speedtest.js', 'js/pdf.js', 'js/db.js', 'js/util.js', 'js/update.js'];

self.addEventListener('install', event => {
  event.waitUntil(Promise.all([
    caches.open(SHELL).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))),
    caches.open(LIBS).then(c => c.addAll([`${CDN}build/pdf.min.mjs`, `${CDN}build/pdf.worker.min.mjs`,
      `${PDFIUM}index.browser.js`, `${PDFIUM}pdfium.wasm`])),
  ]));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('bookshelf-') && k !== SHELL && k !== LIBS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'version') event.ports[0].postMessage(VERSION);
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const fromCdn = request.url.startsWith(CDN) || request.url.startsWith(PDFIUM);
  if (!fromCdn && new URL(request.url).origin !== location.origin) return;
  event.respondWith(caches.open(fromCdn ? LIBS : SHELL).then(async cache => {
    const hit = await cache.match(request, { ignoreSearch: !fromCdn });
    if (hit) return hit;
    const response = await fetch(request);
    if (fromCdn && response.ok) cache.put(request, response.clone());
    return response;
  }));
});
