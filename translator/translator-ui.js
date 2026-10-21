// Translator: the Translation Review (app.js) as a tool page of the Workshop, next to the .ART Packer.
// Research and "same-English" search in the left bar, the entry being reviewed in the centre, the export in the right bar.
// app.js keeps working on its own element ids; they are built here and moved into the page by registerToolPage (tool-pages.js).
// app.js and the stylesheet load the first time the page opens.
import { registerToolPage } from '../js/editor/tool-pages.js';

const html = (s) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstChild; };
const base = new URL('.', import.meta.url);

// the files of translator/data, listed like the Asset Browser's own file list; the list is data/files.json
// (a plain folder cannot be listed online), or, on the local server, the folder's own listing
const files = html('<div class="explorer-tree tr-files" aria-label="Translation files"><div class="tr-files-empty">Loading…</div></div>');

const research = html(`<div id="menu-container">
  <div class="research-search">
    <input type="text" id="research-input" class="research-input" placeholder="Search dialogs…" autocomplete="off">
    <button type="button" id="research-clear-btn" class="research-clear-btn" hidden title="Clear search">✕</button>
  </div>
  <div class="collision-scan-wrap">
    <button type="button" id="collision-scan-btn" class="toggle-btn collision-scan-btn">Find same-English dialogs</button>
  </div>
  <div id="research-panel" class="research-panel">
    <div class="research-empty">Select a word or phrase in an entry, or search above, to see how it was translated elsewhere.</div>
  </div>
</div>`);

const exportBtn = html('<button type="button" class="tool-btn tool-export" id="exportBtn" disabled>⬇ Export</button>');

// the Prev / Next buttons and the counter stay out of sight (app.js drives them); the arrow keys and the progress bar move
const control = html(`<div id="control-bar">
  <h1 id="doc-title"></h1>
  <div class="review-timer" id="reviewTimer" title="Review time (counts while you are on this page)" hidden>00:00:00</div>
  <div class="progress-wrap" id="progressWrap" hidden>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-label" id="progressLabel">0 / 0</div>
  </div>
  <div hidden>
    <button id="prevBtn" type="button">←</button><button id="nextBtn" type="button">→</button>
    <div id="map-coordinates-hud"><span id="hud-val-pos">0</span><span class="coord-lbl">/ 0</span></div>
  </div>
</div>`);

const viewport = html(`<div id="viewport">
  <div class="tr-stage" id="trStage">
    <div class="placeholder" id="stagePlaceholder">Choose a file from the list.</div>
    <div class="card" id="card" hidden></div>
  </div>
</div>`);
registerToolPage('translator', {
  title: 'Translator', leftWidth: 320, rightWidth: 340, rightTitle: 'Research', rightAction: exportBtn,
  left: [files], main: [control, viewport], right: [research],
});

// the file list folds away (and does so by itself when a file opens), by a thin tab on its edge as in the Atlas;
// its own class, apart from the Asset Browser's fold
function foldFiles(fold) {
  document.body.classList.toggle('tr-collapsed', fold);
  const edge = document.getElementById('trEdge');
  if (edge) edge.title = edge.ariaLabel = (fold ? 'Show' : 'Hide') + ' the file list';
}
let appReady = null;
function load() {
  if (appReady) return appReady;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('translator.css', base).href;
  document.head.appendChild(link);
  const edge = html('<button type="button" id="trEdge"></button>');
  document.querySelector('.workspace').appendChild(edge);
  edge.addEventListener('click', () => foldFiles(!document.body.classList.contains('tr-collapsed')));
  foldFiles(document.body.classList.contains('tr-collapsed'));
  appReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('app.js', base).href;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  return appReady;
}

async function listFiles() {
  const dir = new URL('data/', base);
  try {          // a server that lists the folder (local) is always current
    const r = await fetch(dir);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const names = [...doc.querySelectorAll('a')].map(a => decodeURIComponent(a.getAttribute('href'))).filter(n => /\.txt$/i.test(n));
    if (r.ok && names.length) return names;
  } catch (_) {}
  const r = await fetch(new URL('files.json', dir));
  return r.ok ? await r.json() : [];
}

// The address bar keeps the place, so a refresh comes back to it: ?mode=trans&file=<first 4 hex of the md5 of the file name>&progress=<line>
// (the Atlas repeats it as #workshop&mode=trans&…). What was asked for is read now, before the Asset Browser rewrites its own link.
const want = new URLSearchParams(location.search);
const wantTrans = want.get('mode') === 'trans';
function md5(str) {
  const bytes = new TextEncoder().encode(str), n = bytes.length;
  const words = new Uint32Array((((n + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i & 3) * 8);
  words[n >> 2] |= 0x80 << ((n & 3) * 8);
  words[words.length - 2] = (n * 8) >>> 0; words[words.length - 1] = Math.floor(n / 0x20000000);
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < words.length; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + K[i] + words[o + g]) >>> 0;
      a = d; d = c; c = b;
      const s = S[(i >> 4) * 4 + (i & 3)];
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(w => [0, 8, 16, 24].map(s => ((w >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('');
}
const fileKey = (name) => md5(name).slice(0, 4);
function writeLink(name, progress) {
  const p = new URLSearchParams({ mode: 'trans' });
  if (name) { p.set('file', fileKey(name)); if (progress) p.set('progress', progress); }
  try { history.replaceState(null, '', location.pathname + '?' + p); } catch (_) {}
}
let cur = {};
document.addEventListener('translatorstate', (e) => {
  cur = e.detail;
  if (document.body.classList.contains('ws-tool-translator')) writeLink(cur.name, cur.progress);
});
// the Asset Browser's own explorer rewrites the link when it starts up: while this page is open, the link is put back
setInterval(() => {
  if (!document.body.classList.contains('ws-tool-translator')) return;
  const p = new URLSearchParams(location.search);
  if (p.get('mode') !== 'trans' || (cur.name && p.get('file') !== fileKey(cur.name))) writeLink(cur.name, cur.progress);
}, 400);
document.addEventListener('toolpageclose', (e) => {
  if (e.detail === 'translator' && new URLSearchParams(location.search).get('mode') === 'trans') { try { history.replaceState(null, '', location.pathname); } catch (_) {} }
});

// The file an export makes goes to the Downloads folder, out of reach of this page, so its text is also kept here
// (localStorage) for the reload that follows; it is dropped once a file of that name shows up in translator/data.
const PENDING_KEY = 'arcanum-translator-pending-v1';
const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (_) { return null; } };
let pending = readPending();
document.addEventListener('translatorexport', (e) => {
  if (!e.detail.saved) {
    pending = { name: e.detail.name, text: e.detail.text };
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch (_) {}
  }
  cur = { name: e.detail.name, progress: e.detail.progress };
});

// Exports go into translator/data, the folder the files are loaded from. A page cannot write to a folder by itself, so the
// first export asks once to pick that folder (File System Access API, Chromium); the choice is remembered in IndexedDB
// (the browser asks to allow writing again after a restart). files.json is rewritten with it, for the online version.
const idb = (fn) => new Promise((resolve, reject) => {
  const open = indexedDB.open('arcanum-translator', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = fn(open.result.transaction('kv', 'readwrite').objectStore('kv'));
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  };
});
async function dataDir() {
  let dir = null;
  try { dir = await idb(s => s.get('dir')); } catch (_) {}
  if (dir && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = null;
  if (!dir) {
    dir = await window.showDirectoryPicker({ id: 'arcanum-translator', mode: 'readwrite' });
    try { await idb(s => s.put(dir, 'dir')); } catch (_) {}
  }
  return dir;
}
window.translatorSave = async (name, text) => {
  if (!window.showDirectoryPicker) return false;
  try {
    const dir = await dataDir();
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(text); await w.close();
    const names = [];
    for await (const [n, h] of dir.entries()) if (h.kind === 'file' && /\.txt$/i.test(n)) names.push(n);
    const m = await (await dir.getFileHandle('files.json', { create: true })).createWritable();
    await m.write(JSON.stringify(names.sort(), null, 1) + '\n'); await m.close();
    return true;
  } catch (_) { return false; }
};
document.addEventListener('translatorreload', () => {
  writeLink(cur.name, cur.progress);
  setTimeout(() => { try { window.top.location.reload(); } catch (_) { location.reload(); } }, 600);   // the Atlas copies the link in 400 ms
});

async function pick(row, name, startAt) {
  files.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
  row.classList.add('active');
  try {
    await load();
    let text;
    if (pending && pending.name === name && row.dataset.pending) text = pending.text;
    else {
      const r = await fetch(new URL('data/' + encodeURIComponent(name), base));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    }
    window.translatorOpen(name, text, startAt);
    foldFiles(true);
  } catch (err) {
    alert('Could not open ' + name + ': ' + err.message);
  }
}

let listed = false;
async function showFiles() {
  if (listed) return;
  listed = true;
  let names = [];
  try { names = await listFiles(); } catch (_) {}
  files.textContent = '';
  if (pending && names.includes(pending.name)) { pending = null; try { localStorage.removeItem(PENDING_KEY); } catch (_) {} }
  if (pending) names = [pending.name, ...names];       // exported, not yet saved in translator/data
  if (!names.length) { files.innerHTML = '<div class="tr-files-empty">No .txt files in translator/data.</div>'; return; }
  for (const name of names) {
    const row = html('<div class="tree-row" tabindex="0"><span class="tree-icon" aria-hidden="true">📄</span><span class="tree-name"></span></div>');
    row.querySelector('.tree-name').textContent = name.replace(/\.txt$/i, '');
    row.title = name;
    if (pending && name === pending.name) { row.dataset.pending = '1'; row.querySelector('.tree-name').textContent += '  (not saved in data yet)'; }
    row.addEventListener('click', () => pick(row, name));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(row, name); } });
    files.appendChild(row);
  }
  // a refresh: back to the file and the line of the link
  const key = wantTrans && want.get('file');
  const row = key && [...files.children].find(r => fileKey(r.title) === key);
  if (row) pick(row, row.title, +want.get('progress') || undefined);
}

document.addEventListener('toolpageopen', (e) => { if (e.detail === 'translator') { load(); showFiles(); writeLink(cur.name, cur.progress); } });
// Opening from a link: the page starts the explorer (the Workshop's maps) as it comes up, which closes a tool page,
// so for the first seconds a closing is followed by opening it again.
if (wantTrans) {
  const open = () => document.dispatchEvent(new CustomEvent('toolpage', { detail: 'translator' }));
  let booting = true;
  setTimeout(() => { booting = false; }, 5000);
  document.addEventListener('toolpageclose', (e) => { if (booting && e.detail === 'translator') setTimeout(open, 0); });
  setTimeout(open, 0);
}
