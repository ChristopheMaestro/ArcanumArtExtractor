// Generic folder tree / grid used by the .MOB, .PRO, .SEC, .DLG and .MES explorers.

import { errorPara } from '../core/util.js';

import { initExplorer } from '../art/art-explorer.js';

import { applySearchUi } from '../ui/shell.js';

import {
  breadcrumbEl,
  footerNoteEl,
  gridEl,
  logEl,
  manualLoadEl,
  paginationEl,
  protoObjectTypeFilterEl,
  searchClearBtnEl,
  searchInputEl,
  treeEl,
  viewerEl,
} from '../core/dom.js';

import { setExplorerMode } from '../core/state.js';

import { showBrowser, syncSidebarLaunchButtons } from './viewer-shell.js';

import { loadDataExplorerState } from './state-store.js';

import { scaffold } from './nav-history.js';

import { errText } from '../core/text-io.js';

import { joinPath } from '../core/manifest.js';

export function createDataFolderCard(folderName, fullPath, openFolderFn) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'explorer-item explorer-folder-item';
  const thumb = document.createElement('span');
  thumb.className = 'explorer-thumb';
  thumb.innerHTML = '<span class="folder-glyph">📁</span>';
  card.appendChild(thumb);
  const name = document.createElement('span');
  name.className = 'explorer-filename';
  name.textContent = folderName;
  card.appendChild(name);
  card.addEventListener('click', () => openFolderFn(fullPath, folderName));
  return card;
}

export function createDataFileCard(filename, fullPath, icon, onOpen) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'explorer-item';
  const thumb = document.createElement('span');
  thumb.className = 'explorer-thumb';
  thumb.innerHTML = `<span class="folder-glyph">${icon}</span>`;
  card.appendChild(thumb);
  const name = document.createElement('span');
  name.className = 'explorer-filename';
  name.textContent = filename;
  card.appendChild(name);
  card._iconThumb = thumb;
  card.addEventListener('click', () => onOpen(card, filename, fullPath));
  return card;
}

export function renderDataFolderGrid({ subfolders, files, relativePath, openFolderFn, openFileFn, fileIcon, afterFileCard = null, afterFolderCard = null }) {
  gridEl.innerHTML = '';
  const folders = Array.isArray(subfolders) ? subfolders : [];
  const fileList = Array.isArray(files) ? files : [];
  if (!folders.length && !fileList.length) {
    const p = document.createElement('p');
    p.className = 'explorer-status';
    p.textContent = 'This folder is empty.';
    gridEl.appendChild(p);
    paginationEl.hidden = true;
    return;
  }
  if (relativePath) {
    const backPath = relativePath.split('/').slice(0, -1).join('/');
    const back = createDataFolderCard('..', backPath, openFolderFn);
    back.classList.add('explorer-parent-item');
    gridEl.appendChild(back);
  }
  for (const sf of folders) {
    const fullPath = joinPath(relativePath, sf.relative_path);
    const card = createDataFolderCard(sf.folder_name, fullPath, openFolderFn);
    gridEl.appendChild(card);
    if (afterFolderCard) afterFolderCard(card, fullPath);
  }
  for (const filename of fileList) {
    const fullPath = relativePath ? `${relativePath}/${filename}` : filename;
    const card = createDataFileCard(filename, fullPath, fileIcon, card => openFileFn(filename, card, relativePath));
    gridEl.appendChild(card);
    if (afterFileCard) afterFileCard(card, filename, fullPath);
  }
  paginationEl.hidden = true;
}

export function leaveDataExplorer(skipAutoOpen = false) {
  document.querySelector('.explorer').hidden = false;
  setExplorerMode('art');
  syncSidebarLaunchButtons();
  if (protoObjectTypeFilterEl) protoObjectTypeFilterEl.hidden = true;
  applySearchUi('art');
  searchInputEl.value = '';
  searchClearBtnEl.hidden = true;
  showBrowser();
  treeEl.innerHTML = '';
  initExplorer(skipAutoOpen);
}

// Common start-up for the .MOB/.SEC/.PRO/.DLG/.MES explorers: switch the page
// into explorer mode, restore the saved folder (when asked) and show the
// loading message. Returns the folder to open: { path, name, file }.
export function beginDataExplorer(mode, { rootName, label = rootName, breadcrumb = null, restoreState = false,
    showLog = false, showArtControls = false, showTypeFilter = false, searchPlaceholder = null }) {
  document.querySelector('.explorer').hidden = false;
  if (manualLoadEl) manualLoadEl.hidden = true;
  if (logEl) logEl.hidden = !showLog;
  if (footerNoteEl) footerNoteEl.hidden = false;
  setExplorerMode(mode);
  syncSidebarLaunchButtons();
  // The search box (right side bar) is always there and follows the category being browsed.
  if (protoObjectTypeFilterEl) protoObjectTypeFilterEl.hidden = !showTypeFilter;
  if (searchInputEl) {
    searchInputEl.value = '';
    applySearchUi(mode);
    if (searchPlaceholder) {
      searchInputEl.placeholder = searchPlaceholder;
      searchInputEl.setAttribute('aria-label', searchPlaceholder);
    }
  }
  if (searchClearBtnEl) searchClearBtnEl.hidden = true;
  paginationEl.hidden = true;
  viewerEl.hidden = true;
  viewerEl.innerHTML = '';
  gridEl.hidden = false;
  gridEl.innerHTML = '';

  const saved = restoreState ? loadDataExplorerState() : null;
  const ok = saved?.mode === mode;
  const path = ok ? (saved.path || '') : '';
  const name = path ? ((saved.folderName && saved.folderName !== '..') ? saved.folderName : path.split('/').pop()) : rootName;
  if (ok && saved.file) scaffold(mode, path);   // the folder opens only to fill the tree: the file is the place
  if (breadcrumb) breadcrumbEl.textContent = `/${breadcrumb}/${path ? path + '/' : ''}`;
  treeEl.innerHTML = '';
  return { path, name, file: ok ? saved.file : null };
}

// The sidebar tree stays; the error replaces whatever the main pane showed.
export function showExplorerError(err) {
  gridEl.innerHTML = '';
  gridEl.appendChild(errorPara(errText(err)));
  gridEl.hidden = false;
  viewerEl.hidden = true;
}
