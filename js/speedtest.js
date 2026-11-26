// Measures how fast this device hands over files, to see where waiting time comes from.
import { lib, fileFor } from './library.js';
import { $, esc, openSheet } from './util.js';

const timed = async job => {
  const started = performance.now();
  await job();
  return performance.now() - started;
};
const ms = list => `${Math.round(list.reduce((a, b) => a + b, 0) / (list.length || 1))} ms`;

async function measure(say) {
  const all = [...lib.books.keys()];
  // Different books for every part, spread over the library, so nothing is already in memory.
  const pick = (count, offset) => Array.from({ length: Math.min(count, all.length) },
    (_, i) => all[(Math.floor(i * all.length / count) + offset) % all.length]);
  const find = [], small = [], middle = [], large = [];
  let sizes = 0;
  for (const path of pick(5, 0)) {
    let file;
    find.push(await timed(async () => { file = await fileFor(path); }));
    sizes += file.size;
    small.push(await timed(() => file.slice(0, 1024).arrayBuffer()));
    middle.push(await timed(() => file.slice(file.size >> 1, (file.size >> 1) + 1024).arrayBuffer()));
    large.push(await timed(() => file.slice(file.size >> 2, (file.size >> 2) + (1 << 20)).arrayBuffer()));
    say(`Testing one book at a time: ${find.length}`);
  }
  const lines = [
    `One at a time (${find.length} books, ${(sizes / (find.length || 1) / 1048576).toFixed(1)} MB on average):`,
    `Finding a file ${ms(find)}, first small read ${ms(small)}, small read in the middle ${ms(middle)}, 1 MB read ${ms(large)}`,
  ];
  for (const [count, offset] of [[4, 1], [16, 2]]) {
    say(`Testing ${count} books at once`);
    const books = pick(count, offset);
    const total = await timed(() => Promise.all(books.map(async path => {
      const file = await fileFor(path);
      await file.slice(0, 1 << 16).arrayBuffer();
    })));
    lines.push(`${books.length} books at once: ${Math.round(total)} ms, ${Math.round(total / (books.length || 1))} ms per book`);
  }
  return lines;
}

export async function showSpeedTest(version, timings) {
  const sheet = openSheet('<h3>File speed</h3><p class="dim" id="speedText">Testing…</p>');
  const say = text => { if ($('speedText')) $('speedText').textContent = text; };
  let lines;
  // Covers wait during the test, so they don't disturb the numbers.
  const reading = lib.reading;
  lib.reading = true;
  try { lines = await measure(say); }
  catch (e) { lines = [`The test failed: ${e.name} ${e.message}`]; }
  finally { lib.reading = reading; }
  if (!$('speedText')) return;
  const holder = document.createElement('div');
  holder.innerHTML = timings.replaceAll('</p>', '\n</p>').replace(/<h4>.*?<\/h4>/, '');
  const report = [`Bookshelf ${version}, ${lib.books.size} books, ${navigator.hardwareConcurrency} cores`, ...lines, holder.textContent.trim()].join('\n');
  sheet.innerHTML = `<h3>File speed</h3><p class="dim" style="white-space:pre-line">${esc(report)}</p>
    <button class="wide" id="copyReport">Copy report</button>`;
  $('copyReport').onclick = async () => {
    await navigator.clipboard.writeText(report);
    $('copyReport').textContent = 'Copied';
  };
}
