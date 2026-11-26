// Builds one finished tile image per book (blurred background + whole cover), so browsing never opens a PDF.
import { makeCanvas, inkBox, crop } from './pdf.js';
import { bookName } from './util.js';

const W = 400, H = 600;

// Each lane has its own worker, so several covers are drawn at once without freezing the page.
export function coverWorker() {
  let worker;
  const stop = () => { worker?.terminate(); worker = null; };
  // One page at a time: a second request waits for the first.
  let last = Promise.resolve();
  const run = (job, stats) => {
    worker ??= new Worker(new URL('./coverworker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const failed = error => {
        if (error.name === 'ReaderLoadError' || error.crashed) stop();
        reject(Object.assign(new Error(error.message), { name: error.name }));
      };
      worker.onmessage = ({ data }) => {
        if (stats && data.stats) { stats.bytes += data.stats.bytes; stats.readMs += data.stats.readMs; stats.reads += data.stats.reads; }
        if (data.error) failed(data.error); else resolve(data.result);
      };
      worker.onerror = e => { e.preventDefault(); failed({ name: 'ReaderLoadError', message: e.message || 'The cover reader could not be started' }); };
      worker.postMessage(job);
    });
  };
  return { draw: (job, stats) => last = last.catch(() => {}).then(() => run(job, stats)) };
}
let spare;

export async function makeCover(file, path, options = {}, { worker, stats } = {}) {
  worker ??= spare ??= coverWorker();
  try {
    const half = options.coverPart === 'left' || options.coverPart === 'right';
    const { pixels, width, height } = await worker.draw({ file, coverPage: options.coverPage,
      maxWidth: W * (half ? 2 : 1) * 1.15, maxHeight: H * 1.15 }, stats);
    let art = makeCanvas(width, height);
    art.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    if (half) art = crop(art, { x: options.coverPart === 'right' ? .5 : 0, y: 0, w: .5, h: 1 });
    const box = inkBox(art);
    if (!box) return await titleTile(path);
    // Only trim real scan borders: a solid picture with a modest white margin around it.
    if (box.solid && box.w > .5 && box.h > .5) art = crop(art, box);
    return await tile(art);
  } catch (e) {
    if (['ReaderLoadError', 'NotFoundError', 'NotAllowedError', 'NotReadableError'].includes(e?.name)) throw e;
    return await titleTile(path);
  }
}

function toBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .86));
}

function tile(art) {
  const out = makeCanvas(W, H), ctx = out.getContext('2d');
  // Blur by shrinking to a few pixels and scaling up again (works in every browser).
  const tiny = makeCanvas(16, 24);
  const cover = Math.max(16 / art.width, 24 / art.height);
  tiny.getContext('2d').drawImage(art, (16 - art.width * cover) / 2, (24 - art.height * cover) / 2, art.width * cover, art.height * cover);
  const mid = makeCanvas(64, 96);
  mid.getContext('2d').drawImage(tiny, 0, 0, 64, 96);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mid, -20, -30, W + 40, H + 60);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(0, 0, W, H);
  const fit = Math.min(W / art.width, H / art.height);
  const w = art.width * fit, h = art.height * fit, x = (W - w) / 2, y = (H - h) / 2;
  ctx.shadowColor = 'rgba(0,0,0,.7)';
  ctx.shadowBlur = 18;
  ctx.drawImage(art, x, y, w, h);
  ctx.shadowColor = 'transparent';
  const spine = ctx.createLinearGradient(x, 0, x + w * .09, 0);
  spine.addColorStop(0, 'rgba(0,0,0,.35)');
  spine.addColorStop(.45, 'rgba(255,255,255,.12)');
  spine.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = spine;
  ctx.fillRect(x, y, w * .09, h);
  return toBlob(out);
}

function titleTile(path) {
  const out = makeCanvas(W, H), ctx = out.getContext('2d');
  let hue = 0;
  for (const c of path) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  ctx.fillStyle = `hsl(${hue} 28% 25%)`;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = ctx.fillStyle = '#e8d6b0';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, W - 48, H - 48);
  ctx.font = '600 40px Georgia, serif';
  ctx.textAlign = 'center';
  const lines = [''];
  for (const word of bookName(path).split(/[\s_]+/)) {
    const last = lines[lines.length - 1], next = last ? `${last} ${word}` : word;
    if (!last || ctx.measureText(next).width <= W - 90) lines[lines.length - 1] = next;
    else lines.push(word);
  }
  lines.slice(0, 7).forEach((line, i) => ctx.fillText(line, W / 2, 160 + i * 52, W - 80));
  return toBlob(out);
}
