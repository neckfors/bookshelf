// Builds one finished tile image per book (the whole cover in its own shape), so browsing never opens a PDF.
import { makeCanvas, inkBox, crop } from './pdf.js';
import { bookName } from './util.js';

const W = 400, H = 600;

// The box a page should be drawn to fit; a half page needs twice the width.
export const pageBox = half => ({ maxWidth: W * (half ? 2 : 1) * 1.15, maxHeight: H * 1.15 });

export async function finishTile(art, path, coverPart) {
  if (coverPart === 'left' || coverPart === 'right') art = crop(art, { x: coverPart === 'right' ? .5 : 0, y: 0, w: .5, h: 1 });
  const box = inkBox(art);
  if (!box) return titleTile(path);
  // Only trim real scan borders: a solid picture with a modest white margin around it.
  if (box.solid && box.w > .5 && box.h > .5) art = crop(art, box);
  return tile(art);
}

const toBlob = canvas => canvas.convertToBlob({ type: 'image/jpeg', quality: .86 });

// The cover and nothing else, as large as fits in the tile.
function tile(art) {
  const fit = Math.min(W / art.width, H / art.height);
  const out = makeCanvas(art.width * fit, art.height * fit), ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(art, 0, 0, out.width, out.height);
  return toBlob(out);
}

export function titleTile(path) {
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
