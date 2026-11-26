const icon = (d, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
export const ICON = {
  back: icon('M15 5l-7 7 7 7'),
  folder: icon('M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'),
  search: icon('M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0zM20 20l-4.5-4.5'),
  settings: icon('M4 7h16M4 17h16M9 4v6M15 14v6'),
  star: icon('m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z', 'star'),
  mark: icon('M6 4h12v17l-6-4-6 4z', 'star'),
  list: icon('M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'),
};

export const $ = id => document.getElementById(id);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const bookName = path => path.split('/').pop().replace(/\.pdf$/i, '');
export const parentOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
export const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

let onSheetClose = null;
export function openSheet(html, onClose = null) {
  onSheetClose = onClose;
  $('sheet').innerHTML = html;
  $('sheetBack').hidden = false;
  return $('sheet');
}
export function closeSheet() {
  if ($('sheetBack').hidden) return;
  $('sheetBack').hidden = true;
  const done = onSheetClose;
  onSheetClose = null;
  done?.();
}
