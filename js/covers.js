// Makes covers in two stages. Waiting for the file is the slow part on Android, so the next books are
// fetched while a few workers turn already fetched data into pictures.
import { pageBox } from './tile.js';
import { app } from './native.js';

const WHOLE = 2 << 20, HEAD = 768 << 10, TAIL = 192 << 10;
const DRAWERS = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));

// The start of a file usually holds the front page and the end holds the index, so both are fetched
// right away, side by side. A small file is fetched whole. Every separate read costs a long wait.
async function prefetch(file, stats) {
  const started = performance.now();
  const ranges = file.size <= WHOLE ? [[0, file.size]] : [[0, HEAD], [file.size - TAIL, file.size]];
  const chunks = await Promise.all(ranges.map(async ([start, end]) =>
    ({ start, data: new Uint8Array(await file.slice(start, end).arrayBuffer()) })));
  if (stats) {
    stats.firstMs += performance.now() - started;
    for (const chunk of chunks) { stats.bytes += chunk.data.length; stats.reads++; }
  }
  return chunks;
}

function newDrawer() {
  let worker;
  const stop = () => { worker?.terminate(); worker = null; };
  const start = () => worker ??= new Worker(new URL('./coverworker.js', import.meta.url), { type: 'module' });
  return {
    // Loads the PDF engine ahead of the first page.
    warm() {
      if (worker) return;
      start().onerror = e => { e.preventDefault(); stop(); };
      worker.postMessage({ warm: true });
    },
    run(job, stats) {
      start();
      return new Promise((resolve, reject) => {
        const failed = error => {
          if (error.name === 'ReaderLoadError' || error.crashed) stop();
          reject(Object.assign(new Error(error.message), { name: error.name }));
        };
        worker.onmessage = ({ data }) => {
          if (data.warmed) return;
          if (stats && data.stats) for (const [key, value] of Object.entries(data.stats)) stats[key] = (stats[key] || 0) + value;
          if (data.crashed) stop();
          if (data.error) failed(data.error); else resolve(data.blob);
        };
        worker.onerror = e => { e.preventDefault(); failed({ name: 'ReaderLoadError', message: e.message || 'The cover reader could not be started' }); };
        worker.postMessage(job, (job.chunks || []).map(c => c.data.buffer));
      });
    },
  };
}

const free = Array.from({ length: DRAWERS }, newDrawer);
const waiting = [];
// The Android app draws pages itself, so there is no PDF engine to load.
export const warmDrawers = () => { if (!app) free.forEach(d => d.warm()); };

// When a worker gets free it takes the waiting book that is most wanted right now.
let viewOrder = () => [];
export const setDrawOrder = fn => { viewOrder = fn; };
function release(drawer) {
  if (!waiting.length) return free.push(drawer);
  let best = 0;
  if (waiting.length > 1) {
    const rank = new Map(viewOrder().map((path, i) => [path, i]));
    const of = entry => rank.get(entry.path) ?? Infinity;
    for (let i = 1; i < waiting.length; i++) if (of(waiting[i]) < of(waiting[best])) best = i;
  }
  waiting.splice(best, 1)[0].take(drawer);
}

export async function makeCover(file, path, options = {}, { stats } = {}) {
  // In the Android app the page arrives drawn; a worker only turns it into a tile.
  let picture, chunks;
  if (file.native) {
    const started = performance.now();
    picture = await file.frontPage(options.coverPage || 1, pageBox(options.coverPart && options.coverPart !== 'whole'));
    if (stats) stats.firstMs += performance.now() - started;
  } else chunks = await prefetch(file, stats);
  const asked = performance.now();
  const drawer = free.pop() || await new Promise(take => waiting.push({ path, take }));
  if (stats) stats.waitMs += performance.now() - asked;
  try {
    const job = picture ? { picture, path, coverPart: options.coverPart }
      : { file, path, chunks, coverPage: options.coverPage, coverPart: options.coverPart };
    return await drawer.run(job, stats);
  } finally {
    release(drawer);
  }
}
