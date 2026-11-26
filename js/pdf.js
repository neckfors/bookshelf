const BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
let libPromise;

function lib() {
  return libPromise ??= import(`${BASE}build/pdf.min.mjs`).then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}build/pdf.worker.min.mjs`;
    return pdfjs;
  }).catch(e => {
    libPromise = null;
    throw Object.assign(new Error('The PDF reader could not be loaded', { cause: e }), { name: 'ReaderLoadError' });
  });
}

// Reads the file in slices, so a large book is not loaded into memory to show one page.
export async function openPdf(file) {
  const pdfjs = await lib();
  let task;
  class FileRange extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin, end) {
      // If the file can no longer be read, give up instead of waiting for ever.
      file.slice(begin, end).arrayBuffer().then(buf => this.onDataRange(begin, new Uint8Array(buf)), () => task.destroy());
    }
  }
  task = pdfjs.getDocument({
    range: new FileRange(file.size, null),
    rangeChunkSize: 1 << 20,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    isEvalSupported: false,
  });
  return task.promise;
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = makeCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
  return canvas;
}

// Finds the area that is not near-white, as fractions of the page. null = the page is blank.
export function inkBox(source) {
  const w = 120, h = Math.max(1, Math.round(120 * source.height / source.width));
  const small = makeCanvas(w, h);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const ink = (x, y) => { const i = (y * w + x) * 4; return Math.min(data[i], data[i + 1], data[i + 2]) < 232; };
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink(x, y)) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < 0) return null;
  // How much of each edge of the box is ink: high for a scanned picture, low for text on white.
  const share = (n, test) => { let c = 0; for (let i = 0; i < n; i++) if (test(i)) c++; return c / n; };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const solid = [
    share(bw, i => ink(x0 + i, y0) || ink(x0 + i, Math.min(y0 + 1, y1))),
    share(bw, i => ink(x0 + i, y1) || ink(x0 + i, Math.max(y1 - 1, y0))),
    share(bh, i => ink(x0, y0 + i) || ink(Math.min(x0 + 1, x1), y0 + i)),
    share(bh, i => ink(x1, y0 + i) || ink(Math.max(x1 - 1, x0), y0 + i)),
  ].every(s => s > .6);
  return { x: x0 / w, y: y0 / h, w: bw / w, h: bh / h, solid };
}

export function crop(source, box) {
  const sx = Math.floor(box.x * source.width), sy = Math.floor(box.y * source.height);
  const out = makeCanvas(box.w * source.width, box.h * source.height);
  out.getContext('2d').drawImage(source, sx, sy, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
