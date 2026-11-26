// Draws a front page with PDFium, the engine behind Chrome's own PDF viewer and Android's, and turns
// it into the finished tile. It follows the PDF's index straight to the page, so only a few parts of
// the file are needed. pdf.js (used for reading books) also looks up the last page when it opens a
// file, which in many books means one lookup for every page.
import { scanPicture, decodeScan } from './scan.js';
import { pageBox, finishTile, titleTile } from './tile.js';

const BASE = 'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.15.1/dist/';
const BLOCK = 1 << 18;

let engine;
function load() {
  return engine ??= (async () => {
    const [{ init }, wasm] = await Promise.all([
      import(`${BASE}index.browser.js`),
      fetch(`${BASE}pdfium.wasm`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
    ]);
    const lib = await init({ wasmBinary: wasm });
    lib.PDFiumExt_Init();
    return lib;
  })().catch(e => { engine = null; throw e; });
}

const reader = new FileReaderSync();

// PDFium asks for many tiny pieces. Most are in the data already fetched; for the rest whole blocks
// are read and kept.
function blockReader(file, chunks, stats) {
  const blocks = new Map();
  const read = (from, to) => {
    const started = performance.now();
    const data = new Uint8Array(reader.readAsArrayBuffer(file.slice(from, to)));
    stats.readMs += performance.now() - started;
    stats.bytes += data.length;
    stats.reads++;
    return data;
  };
  return (position, size) => {
    const out = new Uint8Array(size), end = position + size;
    for (let at = position; at < end;) {
      let piece = chunks.find(c => at >= c.start && at < c.start + c.data.length);
      if (!piece) {
        const index = Math.floor(at / BLOCK);
        piece = blocks.get(index);
        if (!piece) {
          // A large request, such as the rest of a scanned picture, is read in one go.
          const stop = Math.min(end, ...chunks.filter(c => c.start > at).map(c => c.start));
          if (stop - at >= BLOCK) {
            out.set(read(at, stop), at - position);
            at = stop;
            continue;
          }
          blocks.set(index, piece = { start: index * BLOCK, data: read(index * BLOCK, Math.min((index + 1) * BLOCK, file.size)) });
        }
      }
      const from = at - piece.start, length = Math.min(end - at, piece.data.length - from);
      if (length <= 0) throw new Error('The file is shorter than expected');
      out.set(piece.data.subarray(from, from + length), at - position);
      at += length;
    }
    return out;
  };
}

// Returns a canvas with the page, fitted to the cover box.
async function draw(lib, { file, chunks, coverPage, coverPart }, stats) {
  const { maxWidth, maxHeight } = pageBox(coverPart === 'left' || coverPart === 'right');
  const m = lib.pdfium;
  const read = blockReader(file, chunks, stats);
  let readError = null, doc = 0, page = 0, bitmap = 0;
  const getBlock = m.addFunction((param, position, buffer, size) => {
    try { m.HEAPU8.set(read(position >>> 0, size >>> 0), buffer >>> 0); return 1; }
    catch (e) { readError = e; return 0; }
  }, 'iiiii');
  const access = m.wasmExports.malloc(12);
  const fail = what => { throw readError || new Error(what); };
  try {
    m.setValue(access, file.size, 'i32');
    m.setValue(access + 4, getBlock, 'i32');
    m.setValue(access + 8, 0, 'i32');
    doc = lib.FPDF_LoadCustomDocument(access, '');
    if (!doc) fail(`Could not open the PDF (${lib.FPDF_GetLastError()})`);
    const count = lib.FPDF_GetPageCount(doc);
    page = lib.FPDF_LoadPage(doc, Math.min(Math.max(coverPage || 1, 1), count) - 1);
    if (!page) fail('Could not open the page');
    const w = lib.FPDF_GetPageWidthF(page), h = lib.FPDF_GetPageHeightF(page);
    const scale = Math.min(maxWidth / w, maxHeight / h);
    const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale));
    try {
      const scan = scanPicture(lib, page, width, height);
      if (scan) {
        const canvas = await decodeScan(scan, width, height);
        stats.direct = 1;
        return canvas;
      }
    } catch (e) {
      console.warn('Drawing the page the normal way', e);
    }
    if (readError) fail();
    bitmap = lib.FPDFBitmap_Create(width, height, 0);
    if (!bitmap) fail('Out of memory');
    lib.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    // 0x01: show annotations. 0x10: red and blue in the order a canvas wants.
    lib.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0x11);
    if (readError) fail();
    const start = lib.FPDFBitmap_GetBuffer(bitmap), stride = lib.FPDFBitmap_GetStride(bitmap);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) pixels.set(m.HEAPU8.subarray(start + y * stride, start + y * stride + width * 4), y * width * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas;
  } finally {
    if (bitmap) lib.FPDFBitmap_Destroy(bitmap);
    if (page) lib.FPDF_ClosePage(page);
    if (doc) lib.FPDF_CloseDocument(doc);
    m.wasmExports.free(access);
    m.removeFunction(getBlock);
  }
}

// Errors that say the file could not be read; any other failure gives the book a title cover.
const FILE_ERRORS = ['NotFoundError', 'NotAllowedError', 'NotReadableError'];

// A front page that Android has already drawn. An empty one means the PDF can't be shown.
async function framePicture({ picture, path, coverPart }) {
  if (!picture.size) return titleTile(path);
  const bitmap = await createImageBitmap(picture);
  const art = new OffscreenCanvas(bitmap.width, bitmap.height);
  art.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return finishTile(art, path, coverPart);
}

onmessage = async ({ data }) => {
  if (data.picture) {
    const started = performance.now();
    const blob = await framePicture(data).catch(e => { console.error(e); return titleTile(data.path); });
    return postMessage({ blob, stats: { tileMs: performance.now() - started } });
  }
  let lib;
  try {
    lib = await load();
  } catch (e) {
    if (!data.warm) postMessage({ error: { name: 'ReaderLoadError', message: String(e?.message || e) } });
    return;
  }
  if (data.warm) return postMessage({ warmed: true });
  const stats = { bytes: 0, readMs: 0, reads: 0, drawMs: 0, tileMs: 0, direct: 0 };
  const started = performance.now();
  let drawn = 0;
  try {
    const art = await draw(lib, data, stats);
    drawn = performance.now();
    const blob = await finishTile(art, data.path, data.coverPart);
    stats.drawMs = drawn - started - stats.readMs;
    stats.tileMs = performance.now() - drawn;
    postMessage({ blob, stats });
  } catch (e) {
    // After a crash inside the engine this worker cannot be trusted and is replaced.
    const crashed = e instanceof WebAssembly.RuntimeError;
    if (FILE_ERRORS.includes(e?.name)) postMessage({ error: { name: e.name, message: String(e.message), crashed }, stats });
    else postMessage({ blob: await titleTile(data.path), crashed, stats });
  }
};
