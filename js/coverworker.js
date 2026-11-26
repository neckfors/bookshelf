// Draws one page for a cover with PDFium, the engine behind Chrome's own PDF viewer and Android's.
// It follows the PDF's index straight to the page, so only a few small parts of the file are read.
// pdf.js (used for reading books) also looks up the last page when it opens a file, which in many
// books means one lookup for every page.
const BASE = 'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium@2.15.1/dist/';
const BLOCK = 1 << 16;

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

// PDFium asks for many tiny pieces, so whole blocks are read and kept.
function blockReader(file, stats) {
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
    const end = position + size;
    if (size >= BLOCK) return read(position, end);
    const out = new Uint8Array(size);
    for (let i = Math.floor(position / BLOCK); i * BLOCK < end; i++) {
      let block = blocks.get(i);
      if (!block) blocks.set(i, block = read(i * BLOCK, Math.min((i + 1) * BLOCK, file.size)));
      const from = Math.max(position, i * BLOCK);
      out.set(block.subarray(from - i * BLOCK, Math.min(end - i * BLOCK, block.length)), from - position);
    }
    return out;
  };
}

// maxWidth and maxHeight are the box the page should fit; half pages get twice the width.
function draw(lib, { file, coverPage, maxWidth, maxHeight }, stats) {
  const m = lib.pdfium;
  const read = blockReader(file, stats);
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
    return { pixels, width, height };
  } finally {
    if (bitmap) lib.FPDFBitmap_Destroy(bitmap);
    if (page) lib.FPDF_ClosePage(page);
    if (doc) lib.FPDF_CloseDocument(doc);
    m.wasmExports.free(access);
    m.removeFunction(getBlock);
  }
}

onmessage = async ({ data }) => {
  const stats = { bytes: 0, readMs: 0, reads: 0 };
  let lib;
  try {
    lib = await load();
  } catch (e) {
    postMessage({ error: { name: 'ReaderLoadError', message: String(e?.message || e) } });
    return;
  }
  try {
    const result = draw(lib, data, stats);
    postMessage({ result, stats }, [result.pixels.buffer]);
  } catch (e) {
    // After a crash inside the engine this worker cannot be trusted and is replaced.
    postMessage({ error: { name: e?.name || 'Error', message: String(e?.message || e), crashed: e instanceof WebAssembly.RuntimeError }, stats });
  }
};
