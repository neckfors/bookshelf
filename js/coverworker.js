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

// Most scanned books have one JPEG covering the whole front page. The browser's own JPEG decoder is
// many times faster than the one inside PDFium, so such a picture is handed to it as it is.
// Returns where the picture goes, or null when the page has to be drawn the normal way.
function scanPicture(lib, page, width, height) {
  const m = lib.pdfium;
  if (lib.FPDFPage_GetRotation(page) || lib.FPDFPage_GetAnnotCount(page)) return null;
  let image = 0;
  for (let i = 0, n = lib.FPDFPage_CountObjects(page); i < n; i++) {
    const object = lib.FPDFPage_GetObject(page, i), type = lib.FPDFPageObj_GetType(object);
    // 1: text. Scans often carry invisible text (mode 3) so that they can be searched.
    if (type === 1 && lib.FPDFTextObj_GetTextRenderMode(object) === 3) continue;
    if (type !== 3 || image) return null;
    image = object;
  }
  if (!image || lib.FPDFImageObj_GetImageFilterCount(image) !== 1) return null;
  const memory = m.wasmExports.malloc(64);
  try {
    const length = lib.FPDFImageObj_GetImageFilter(image, 0, memory, 64);
    if (String.fromCharCode(...m.HEAPU8.subarray(memory, memory + Math.max(0, length - 1))) !== 'DCTDecode') return null;
    // Grey and colour only: bytes 16 and 20 are the bits per pixel and the kind of colour (3 is CMYK).
    if (!lib.FPDFImageObj_GetImageMetadata(image, page, memory)) return null;
    const bits = m.getValue(memory + 16, 'i32'), colors = m.getValue(memory + 20, 'i32');
    if ((bits !== 8 && bits !== 24) || colors === 3) return null;
    // The picture must stand upright, neither turned nor mirrored.
    if (!lib.FPDFPageObj_GetMatrix(image, memory)) return null;
    const [a, b, c, d] = [0, 4, 8, 12].map(at => m.getValue(memory + at, 'float'));
    if (!(a > 0 && d > 0 && Math.abs(b) < .001 && Math.abs(c) < .001)) return null;
    if (!lib.FPDFPageObj_GetBounds(image, memory, memory + 4, memory + 8, memory + 12)) return null;
    const [left, bottom, right, top] = [0, 4, 8, 12].map(at => m.getValue(memory + at, 'float'));
    const corner = (px, py) => {
      lib.FPDF_PageToDevice(page, 0, 0, width, height, 0, px, py, memory + 16, memory + 20);
      return [m.getValue(memory + 16, 'i32'), m.getValue(memory + 20, 'i32')];
    };
    const [x0, y0] = corner(left, top), [x1, y1] = corner(right, bottom);
    const covered = Math.max(0, Math.min(x1, width) - Math.max(x0, 0)) * Math.max(0, Math.min(y1, height) - Math.max(y0, 0));
    if (covered < width * height * .9) return null;
    const size = lib.FPDFImageObj_GetImageDataRaw(image, 0, 0);
    if (!size) return null;
    const data = m.wasmExports.malloc(size);
    if (!data) return null;
    try {
      lib.FPDFImageObj_GetImageDataRaw(image, data, size);
      const jpeg = m.HEAPU8.slice(data, data + size);
      return turnedByCamera(jpeg) ? null : { jpeg, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } finally {
      m.wasmExports.free(data);
    }
  } finally {
    m.wasmExports.free(memory);
  }
}

// A PDF ignores the "turn this photo" note a camera leaves in a JPEG, but the browser follows it.
function turnedByCamera(jpeg) {
  const view = new DataView(jpeg.buffer);
  for (let at = 2; at + 4 < view.byteLength && view.getUint8(at) === 0xff;) {
    const marker = view.getUint8(at + 1), length = view.getUint16(at + 2);
    if (marker === 0xda) break;
    if (marker === 0xe1 && length > 16 && view.getUint32(at + 4) === 0x45786966) {
      const tiff = at + 10, little = view.getUint16(tiff) === 0x4949;
      const list = tiff + view.getUint32(tiff + 4, little);
      for (let i = 0, n = view.getUint16(list, little); i < n; i++) {
        const entry = list + 2 + i * 12;
        if (view.getUint16(entry, little) === 0x112) return view.getUint16(entry + 8, little) > 1;
      }
    }
    at += 2 + length;
  }
  return false;
}

async function decodeScan({ jpeg, x, y, w, h }, width, height) {
  const picture = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }),
    { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(picture, x, y);
  picture.close();
  return { pixels: context.getImageData(0, 0, width, height).data, width, height };
}

// maxWidth and maxHeight are the box the page should fit; half pages get twice the width.
async function draw(lib, { file, coverPage, maxWidth, maxHeight }, stats) {
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
    try {
      const scan = scanPicture(lib, page, width, height);
      if (scan) {
        const result = await decodeScan(scan, width, height);
        stats.direct = 1;
        return result;
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
  const stats = { bytes: 0, readMs: 0, reads: 0, drawMs: 0, direct: 0 };
  let lib;
  try {
    lib = await load();
  } catch (e) {
    postMessage({ error: { name: 'ReaderLoadError', message: String(e?.message || e) } });
    return;
  }
  const started = performance.now();
  try {
    const result = await draw(lib, data, stats);
    stats.drawMs = performance.now() - started - stats.readMs;
    postMessage({ result, stats }, [result.pixels.buffer]);
  } catch (e) {
    // After a crash inside the engine this worker cannot be trusted and is replaced.
    postMessage({ error: { name: e?.name || 'Error', message: String(e?.message || e), crashed: e instanceof WebAssembly.RuntimeError }, stats });
  }
};
