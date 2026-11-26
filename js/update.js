import { $ } from './util.js';
import { app } from './native.js';

// The Android app compares itself with the newest release on GitHub.
const LATEST = 'https://raw.githubusercontent.com/neckfors/bookshelf/main/version.json';
// Shows the bar if there is a newer version, and says what was found.
export async function checkAppUpdate() {
  try {
    const response = await fetch(`${LATEST}?t=${Date.now()}`, { cache: 'no-store' });
    if (response.status === 404) return 'You have the newest version'; // nothing released yet
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!((await response.json()).versionCode > app.versionCode())) return 'You have the newest version';
    $('update').hidden = false;
    $('updateBtn').onclick = () => app.openDownloads();
    return 'New version available';
  } catch { return 'Could not check. Are you online?'; }
}

function setupAppUpdates() {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkAppUpdate(); });
  setInterval(checkAppUpdate, 30 * 60 * 1000);
  checkAppUpdate();
}

export async function setupUpdates() {
  if (app) return setupAppUpdates();
  if (!('serviceWorker' in navigator)) return;
  let asked = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (asked) location.reload(); });
  const reg = await navigator.serviceWorker.register('sw.js').catch(e => console.warn(e));
  if (!reg) return;
  const offer = worker => {
    $('update').hidden = false;
    $('updateBtn').onclick = () => { asked = true; worker.postMessage('skipWaiting'); };
  };
  if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
    });
  });
  const check = () => reg.update().catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(check, 30 * 60 * 1000);
}

export function appVersion() {
  if (app) return Promise.resolve(app.versionName());
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve('');
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = e => resolve(e.data);
    worker.postMessage('version', [channel.port2]);
    setTimeout(() => resolve(''), 1000);
  });
}
