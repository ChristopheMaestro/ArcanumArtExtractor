// Small shared helpers.

import { log } from './log.js';

// Encode each path segment so names containing #, ?, % or spaces survive
// being put into a URL. Slashes are kept as separators.
export function encPath(p) {
  return String(p ?? '').split('/').map(encodeURIComponent).join('/');
}

export async function saveFile(filename, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    log(`couldn't save ${filename}: ${e && e.message ? e.message : e}`, 'err');
  }
}

// The two libraries (copies in vendor/), loaded the first time they are needed: as <script> tags they held
// up the whole page for a ZIP or GIF download few people make.
const scriptLoads = new Map();
function loadScriptOnce(url, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!scriptLoads.has(url)) {
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error(`${url} did not define ${globalName}`));
      s.onerror = () => reject(new Error(`couldn't load ${url}`));
      document.head.appendChild(s);
    });
    scriptLoads.set(url, p);
    p.catch(() => scriptLoads.delete(url));
  }
  return scriptLoads.get(url);
}
export const vendorUrl = name => new URL(`../../vendor/${name}`, import.meta.url).href;
export const loadJSZip = () => loadScriptOnce(vendorUrl('jszip.min.js'), 'JSZip');   // JSZip 3.10.1
export const loadGifJs = () => loadScriptOnce(vendorUrl('gif.js'), 'GIF');           // gif.js 0.2.0

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// <p class="explorer-status err"> with the given text.
export function errorPara(text) {
  const p = document.createElement('p');
  p.className = 'explorer-status err';
  p.textContent = text;
  return p;
}

// What was read from the game's files depends on the version on show (the Atlas switches version without reloading the page,
// js/atlas/atlas-boot.js): every cache of such a read registers a function that empties it, and the switch calls them all.
const versionResets = new Set();
export function onVersionChange(reset) { versionResets.add(reset); return reset; }
export function versionChanged() { for (const reset of versionResets) { try { reset(); } catch (_) {} } }

// document.createElement with an optional class and text content.
export function createEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
