import { $ } from './util.js';

export async function setupUpdates() {
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
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve('');
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = e => resolve(e.data);
    worker.postMessage('version', [channel.port2]);
    setTimeout(() => resolve(''), 1000);
  });
}
