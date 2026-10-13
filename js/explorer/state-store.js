// Remembers the last data-explorer location.

import { visit } from './nav-history.js';

const DATA_EXPLORER_STATE_KEY = 'arcanum-data-explorer-state-v1';

// Every location is also written to the address bar as a GET link: ?mode=pro&path=..&folderName=..&file=..
// While the map editor is open the link carries &editor=on, so a reload (F5) opens the editor again.
let editorOn = new URLSearchParams(window.location.search).get('editor') === 'on';
let startup = true;   // until the home screen has been drawn once
export const editorRequested = () => editorOn;
export function setEditorFlag(on) {
  editorOn = !!on;
  if (lastState) writeStateUrl(lastState);
}

export function writeStateUrl(state) {
  const url = new URL(window.location.href);
  url.hash = '';
  const params = new URLSearchParams();
  if (state) {
    params.set('mode', state.mode);
    if (state.path) params.set('path', state.path);
    if (state.folderName) params.set('folderName', state.folderName);
    if (state.file) params.set('file', state.file);
    if (editorOn) params.set('editor', 'on');
  } else if (startup) startup = false;   // the home screen the page starts on is not a leaving of the editor: a reload keeps it
  else editorOn = false;
  url.search = params.toString();
  try { window.history.replaceState(null, '', url.pathname + url.search); } catch (_) {}
}

let lastState = null;
export const currentDataState = () => lastState;

// A GET link with ?mode=… becomes the saved location, so the normal "restore" path opens it.
export function adoptUrlState() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  if (!mode || !['pro', 'mob', 'sec', 'dlg', 'scr', 'mes'].includes(mode)) return;
  const unsafe = (s) => /^[\\/]/.test(s) || s.split(/[\\/]/).some(seg => seg === '..');
  const path = params.get('path') || '', folderName = params.get('folderName') || '', file = params.get('file') || null;
  if (unsafe(path) || unsafe(folderName) || (file && unsafe(file))) return;
  persistState(mode, path, folderName, file);
}

// Every folder or file an explorer opens comes through here: it is saved for "Continue" and the address
// bar, and kept as a place for the Back button (nav-history.js).
export function saveDataExplorerState(mode, path, folderName, file = null) {
  persistState(mode, path, folderName, file);
  visit({ mode, path: path || '', folderName: lastState?.folderName, file: file || null });
}

function persistState(mode, path, folderName, file) {
  try {
    const shown = (folderName && folderName !== '..') ? folderName : (mode === 'pro' ? 'proto' : (mode === 'mes' ? 'mes' : (mode === 'scr' ? 'scr' : 'maps')));
    lastState = { mode, path: path || '', folderName: shown, file: file || null };
    writeStateUrl(lastState);
  } catch (_) {}
  try {
    localStorage.setItem(DATA_EXPLORER_STATE_KEY, JSON.stringify({
      mode,
      path: path || '',
      folderName: (folderName && folderName !== '..') ? folderName : (mode === 'pro' ? 'proto' : (mode === 'mes' ? 'mes' : (mode === 'scr' ? 'scr' : 'maps'))),
      file: file || null,
    }));
  } catch (_) {}
}

export function loadDataExplorerState() {
  try {
    const raw = localStorage.getItem(DATA_EXPLORER_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || (state.mode !== 'pro' && state.mode !== 'mob' && state.mode !== 'sec' && state.mode !== 'dlg' && state.mode !== 'scr' && state.mode !== 'mes')) return null;
    return state;
  } catch (_) {
    return null;
  }
}
