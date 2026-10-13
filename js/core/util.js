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

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
