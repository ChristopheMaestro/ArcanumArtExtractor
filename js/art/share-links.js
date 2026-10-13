// Deep links and share URLs for .ART files.

import { ROOT_FOLDER_NAME } from './art-explorer.js';
import { log } from '../core/log.js';
import { explorerMode } from '../core/state.js';
import { currentDataState, writeStateUrl } from '../explorer/state-store.js';

//
// A share link encodes the item's folder path, the folder's own manifest
// name (needed to fetch its manifest file), and the filename itself.

function buildShareUrl(folder, folderName, filename) {
  const url = new URL(window.location.href);
  url.hash = '';
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  params.set('folderName', folderName || ROOT_FOLDER_NAME);
  params.set('file', filename);
  url.search = params.toString();
  return url.toString();
}

export function updateUrlForItem(folder, folderName, filename) {
  window.history.replaceState(null, '', buildShareUrl(folder, folderName, filename));
}

export function clearShareUrl() {
  // Outside .ART the address keeps the folder, only the file goes.
  const state = currentDataState();
  if (explorerMode !== 'art' && state) { writeStateUrl({ ...state, file: null }); return; }
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState(null, '', url.pathname + url.hash);
}

export async function copyShareLink(folder, folderName, filename, btn) {
  const link = buildShareUrl(folder, folderName, filename);
  const original = btn.textContent;
  const flash = (text) => {
    btn.textContent = text;
    btn.classList.add('flash');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('flash');
    }, 1600);
  };
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('clipboard API unavailable');
    await navigator.clipboard.writeText(link);
    flash('Link copied!');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
      flash('Link copied!');
    } catch (e2) {
      flash('Copy failed');
      log(`couldn't copy share link: ${e2 && e2.message ? e2.message : e2}`, 'err');
    }
  }
}

export function parseDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const file = params.get('file');
  if (!file || params.has('mode')) return null;
  const folder = params.get('folder') || '';
  const folderName = params.get('folderName') || ROOT_FOLDER_NAME;
  // Share links come from the address bar: never let them climb out of art/.
  const unsafe = (s) => /^[\\/]/.test(s) || s.split(/[\\/]/).some(seg => seg === '..');
  if (unsafe(folder) || unsafe(folderName) || unsafe(file)) return null;
  return { folder, folderName, file };
}
