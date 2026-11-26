// Builds one finished tile image per book (blurred background + whole cover), so browsing never opens a PDF.
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
