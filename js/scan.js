// Most scanned books have one JPEG covering the whole front page. The browser's own JPEG decoder is
// many times faster than the one inside PDFium, so such a picture is handed to it as it is.
// Returns where the picture goes, or null when the page has to be drawn the normal way.
export function scanPicture(lib, page, width, height) {
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

// Decoded straight to the size it is shown at, and drawn without ever copying the pixels back.
export async function decodeScan({ jpeg, x, y, w, h }, width, height) {
  const picture = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }),
    { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(picture, x, y);
  picture.close();
  return canvas;
}
