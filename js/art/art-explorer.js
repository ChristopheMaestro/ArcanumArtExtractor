// .ART folder explorer: tree, grid, pagination, search, saved state.

import { joinPath } from '../core/manifest.js';
import { mountFolderTree } from '../explorer/folder-tree.js';
import { errText } from '../core/text-io.js';
import { createManifestLoader } from '../core/manifest.js';
import { parseArtBuffer } from './art-decoder.js';
import { attachArtPreview, deferArtPreview } from './art-preview.js';
import { folderPreviewCells, loadSheet, loadThumbIndex, sheetCellCanvas } from './art-thumb-sheets.js';
import { renderFileGroup } from './file-group.js';
import { ART_ROOT } from '../core/config.js';
import {
  breadcrumbEl,
  gridEl,
  pageSizeSelect,
  paginationEl,
  searchClearBtnEl,
  searchInputEl,
  treeEl,
  viewerEl,
} from '../core/dom.js';
import { log } from '../core/log.js';
import { explorerMode } from '../core/state.js';
import { encPath, errorPara } from '../core/util.js';
import { showBrowser } from '../explorer/viewer-shell.js';
import { clearProtoSearch, runProtoSearch } from '../proto/proto-explorer.js';
import { clearFileSearch, runFileSearch } from '../explorer/file-search.js';
import { visit } from '../explorer/nav-history.js';
import { matchFields, splitTerms } from '../explorer/match.js';
import { artBaseName, loadProtoIndex } from '../proto/proto-index.js';

// The root manifest follows the same <foldername>_manifest.json convention.
export const ROOT_FOLDER_NAME = 'art';
const ROOT_RELATIVE_PATH = '';

export const loadManifest = createManifestLoader({ root: ART_ROOT, rootName: ROOT_FOLDER_NAME, label: 'art' });

const PAGE_SIZE_OPTIONS = [50, 100, 200, 'all'];
export let pageSize = PAGE_SIZE_OPTIONS[0]; // 50, 100, 200, or 'all'
export function setPageSize(value) { pageSize = value; return pageSize; }
export let folderFiles = [];     // all .art files in the currently browsed folder, sorted
export let folderRelPath = '';
export let currentFolderName = '';
export let currentManifest = null;
let filesOffset = 0;

// Search ("research") across the whole library
let browseMode = 'folder'; // 'folder' | 'search'
let searchResults = [];    // [{ filename, relPath, folderName }]
let lastSearchQuery = '';
const SEARCH_RESULT_LIMIT = 300;
const EXPLORER_STATE_KEY = 'arcanum-art-explorer-state-v1';

function saveExplorerState(extra = {}) {
  const file = extra.file !== undefined ? extra.file : null;
  // The place for the Back button: the open file, or the folder / search results with the page shown.
  visit({
    mode: 'art', path: folderRelPath, folderName: currentFolderName, file,
    query: !file && browseMode === 'search' ? lastSearchQuery : '', offset: filesOffset,
  });
  try {
    const state = {
      folder: folderRelPath,
      folderName: currentFolderName,
      file,
      offset: filesOffset,
      pageSize,
      browseMode,
      searchQuery: lastSearchQuery,
    };
    localStorage.setItem(EXPLORER_STATE_KEY, JSON.stringify(state));
  } catch (_) {}
}

export function loadExplorerState() {
  try {
    const raw = localStorage.getItem(EXPLORER_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object') return null;
    return state;
  } catch (_) {
    return null;
  }
}

const paginationStatusEl = document.getElementById('explorerPaginationStatus');
const nextBtn = document.getElementById('explorerLoadMoreBtn');
const backBtn = document.getElementById('explorerBackBtn');

const searchBtnEl = document.getElementById('explorerSearchBtn');

function currentItemCount() {
  return browseMode === 'search' ? searchResults.length : folderFiles.length;
}

function effectivePageSize() {
  return pageSize === 'all' ? (currentItemCount() || 1) : pageSize;
}

function renderGrid(manifest, relativePath, folderName) {
  currentManifest = manifest;
  folderFiles = (manifest.files || [])
    .filter(f => /\.art$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
  folderRelPath = relativePath;
  currentFolderName = folderName;
  filesOffset = 0;
  breadcrumbEl.textContent = `/${relativePath}`.replace(/\/+/g, '/') || '/';
  renderFilePage();
}

function createFileCard(filename, relPath, folderName, opts) {
  const prefix = relPath ? `${relPath}/` : '';
  const artUrl = `${ART_ROOT}${encPath(prefix)}${encPath(filename)}`;

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'explorer-item';

  const thumb = document.createElement('span');
  thumb.className = 'explorer-thumb';
  // a folder page uses the folder's thumbnail sheets; search results come from many folders: one file each
  attachArtPreview(thumb, relPath, filename, opts?.showPath ? null : folderFiles);
  card.appendChild(thumb);

  const name = document.createElement('span');
  name.className = 'explorer-filename';
  name.textContent = filename;
  card.appendChild(name);

  if (opts && opts.showPath) {
    const pathLabel = document.createElement('span');
    pathLabel.className = 'explorer-item-path';
    pathLabel.textContent = `/${relPath}`.replace(/\/+/g, '/') || '/';
    card.appendChild(pathLabel);
  }
  if (opts && opts.note) {
    const note = document.createElement('span');
    note.className = 'explorer-item-note';
    note.textContent = opts.note;
    note.title = opts.note;
    card.appendChild(note);
  }

  card.addEventListener('click', () => {
    folderRelPath = relPath;
    currentFolderName = folderName;
    saveExplorerState({ file: filename });
    loadArtFromServer(artUrl, filename);
  });
  gridEl.appendChild(card);
  return card;
}

function renderSubfolderCard(sf, parentRelPath) {
  const fullPath = joinPath(parentRelPath, sf.relative_path);

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'explorer-item explorer-folder-item';

  const thumb = document.createElement('span');
  thumb.className = 'explorer-thumb explorer-thumb-mosaic';
  thumb.innerHTML = '<span class="folder-glyph">📁</span>';
  card.appendChild(thumb);

  const name = document.createElement('span');
  name.className = 'explorer-filename';
  name.textContent = sf.folder_name;
  card.appendChild(name);

  card.addEventListener('click', () => openFolder(fullPath, sf.folder_name));
  gridEl.appendChild(card);

  deferArtPreview(thumb, async () => {
    // The previews of a folder's sub-folders are one sheet; without it, walk the sub-folder for its first files.
    const cells = await folderPreviewCells(parentRelPath, fullPath);
    const sheetUrl = cells?.find(c => !c.missing)?.url;
    const sheet = sheetUrl ? await loadSheet(sheetUrl) : null;
    if (cells && (!sheetUrl || sheet)) {
      if (!cells.length || !thumb.isConnected) return;
      thumb.innerHTML = '';
      thumb.classList.add('has-mosaic');
      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('span');
        cell.className = 'mosaic-cell';
        if (!cells[i]) cell.classList.add('empty');
        else if (cells[i].missing) { cell.classList.add('missing'); cell.textContent = '🖼'; }
        else cell.appendChild(sheetCellCanvas(sheet, cells[i]));
        thumb.appendChild(cell);
      }
      return;
    }
    const arts = await findFirstArtFiles(fullPath, sf.folder_name, 4);
    if (!arts.length || !thumb.isConnected) return;
    thumb.innerHTML = '';
    thumb.classList.add('has-mosaic');
    for (let i = 0; i < 4; i++) {
      const cell = document.createElement('span');
      cell.className = 'mosaic-cell';
      if (arts[i]) {
        attachArtPreview(cell, arts[i].relativePath, arts[i].filename);
      } else {
        cell.classList.add('empty');
      }
      thumb.appendChild(cell);
    }
  });
}

// The first `limit` .art files of a folder and then of its sub-folders, depth first: a folder card's preview.
// toolbox/build_art_thumbs.py makes the preview sheets with it.
export async function findFirstArtFiles(relativePath, folderName, limit) {
  const arts = [];
  const visited = new Set();
  const MAX_FETCHES = 40;
  let fetches = 0;

  async function walk(relPath, fName) {
    if (arts.length >= limit || fetches >= MAX_FETCHES) return;
    if (visited.has(relPath)) return;
    visited.add(relPath);

    let manifest;
    try {
      fetches++;
      manifest = await loadManifest(relPath, fName);
    } catch (err) {
      return;
    }

    const files = (manifest.files || [])
      .filter(f => /\.art$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
    for (const f of files) {
      if (arts.length >= limit) return;
      arts.push({ filename: f, relativePath: relPath });
    }
    if (arts.length >= limit) return;

    const subfolders = manifest.subfolders || {};
    const keys = Object.keys(subfolders).sort();
    for (const key of keys) {
      if (arts.length >= limit || fetches >= MAX_FETCHES) return;
      const sf = subfolders[key];
      if (!sf || typeof sf !== 'object' || !sf.folder_name) continue;
      await walk(joinPath(relPath, sf.relative_path), sf.folder_name);
    }
  }

  await walk(relativePath, folderName);
  return arts.slice(0, limit);
}

function openFolder(relativePath, folderName) {
  selectFolder(relativePath, folderName);
}

// An art file matches on its name, its folder, or the prototypes that use it (their description, type, name).
function artSearchFields(filename, relativePath, index) {
  const fields = [{ label: 'name', text: filename }, { label: 'folder', text: relativePath }];
  for (const entry of index?.byArt.get(artBaseName(filename)) || []) {
    fields.push({ label: 'description', text: entry.description }, { label: 'type', text: entry.typeName }, { label: 'prototype', text: entry.filename });
  }
  return fields;
}

async function collectFilesRecursive(relativePath, folderName, terms, index, results, limit, visited) {
  if (results.length >= limit) return;
  if (visited.has(relativePath)) return;
  visited.add(relativePath);

  let manifest;
  try {
    manifest = await loadManifest(relativePath, folderName);
  } catch (err) {
    return;
  }

  const files = (manifest.files || []).filter(f => /\.art$/i.test(f));
  for (const f of files) {
    if (results.length >= limit) return;
    const hit = matchFields(artSearchFields(f, relativePath, index), terms);
    if (hit) results.push({ filename: f, relPath: relativePath, folderName, note: hit.note });
  }

  const subfolders = manifest.subfolders || {};
  const keys = Object.keys(subfolders).sort();
  for (const key of keys) {
    if (results.length >= limit) return;
    const sf = subfolders[key];
    await collectFilesRecursive(joinPath(relativePath, sf.relative_path), sf.folder_name, terms, index, results, limit, visited);
  }
}

async function runSearch(rawQuery) {
  const query = (rawQuery || '').trim();
  if (!query) return;

  lastSearchQuery = query;
  browseMode = 'search';
  searchResults = [];
  filesOffset = 0;
  searchClearBtnEl.hidden = false;
  saveExplorerState({ file: null });

  treeEl.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
  showBrowser();
  breadcrumbEl.textContent = `Searching for "${query}"…`;
  gridEl.innerHTML = '<p class="explorer-status">Searching…</p>';
  paginationEl.hidden = true;

  const results = [];
  try {
    // Descriptions live in the prototypes: index them first (once), then walk the art folders.
    const index = await loadProtoIndex((done, total) => { breadcrumbEl.textContent = `Indexing descriptions… ${done} / ${total}`; }).catch(() => null);
    breadcrumbEl.textContent = `Searching for "${query}"…`;
    await collectFilesRecursive(ROOT_RELATIVE_PATH, ROOT_FOLDER_NAME, splitTerms(query), index, results, SEARCH_RESULT_LIMIT, new Set());
  } catch (err) {
    log(`search: ${errText(err)}`, 'err');
  }
  results.sort((a, b) => a.filename.localeCompare(b.filename));
  searchResults = results;

  const cappedNote = results.length >= SEARCH_RESULT_LIMIT ? ` (showing first ${SEARCH_RESULT_LIMIT})` : '';
  breadcrumbEl.textContent = `Search results for "${query}" — ${results.length} match${results.length === 1 ? '' : 'es'}${cappedNote}`;
  renderFilePage();
}

function clearSearch() {
  browseMode = 'folder';
  searchResults = [];
  filesOffset = 0;
  searchInputEl.value = '';
  searchClearBtnEl.hidden = true;
  saveExplorerState({ file: null });
  breadcrumbEl.textContent = `/${folderRelPath}`.replace(/\/+/g, '/') || '/';
  renderFilePage();
}

// One search box serves every category: it searches what the current category is about.
export function runCategorySearch() {
  const query = searchInputEl.value;
  if (explorerMode === 'pro') runProtoSearch(query);
  else if (explorerMode === 'art') runSearch(query);
  else runFileSearch(query);
}
searchBtnEl.addEventListener('click', runCategorySearch);
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runCategorySearch();
  }
});
searchClearBtnEl.addEventListener('click', () => {
  if (explorerMode === 'pro') clearProtoSearch();
  else if (explorerMode === 'art') clearSearch();
  else clearFileSearch(searchInputEl);
});

function renderFilePage() {
  gridEl.innerHTML = '';

  if (browseMode === 'search') {
    if (searchResults.length === 0) {
      const p = document.createElement('p');
      p.className = 'explorer-status';
      p.textContent = `No .ART files match "${lastSearchQuery}".`;
      gridEl.appendChild(p);
      paginationEl.hidden = true;
      return;
    }
    const size = effectivePageSize();
    const pageItems = searchResults.slice(filesOffset, filesOffset + size);
    for (const item of pageItems) {
      createFileCard(item.filename, item.relPath, item.folderName, { showPath: true, note: item.note });
    }
    updatePaginationBar();
    return;
  }

  if (folderFiles.length === 0) {
    const subfolders = (currentManifest && currentManifest.subfolders) || {};
    const keys = Object.keys(subfolders).sort();
    if (keys.length === 0) {
      const p = document.createElement('p');
      p.className = 'explorer-status';
      p.textContent = 'This folder is empty.';
      gridEl.appendChild(p);
    } else {
      keys.forEach(key => renderSubfolderCard(subfolders[key], folderRelPath));
    }
    paginationEl.hidden = true;
    return;
  }

  const pageFiles = folderFiles.slice(filesOffset, filesOffset + effectivePageSize());
  for (const filename of pageFiles) {
    createFileCard(filename, folderRelPath, currentFolderName);
  }

  updatePaginationBar();
}

export function updatePaginationBar() {
  const total = currentItemCount();
  if (total <= PAGE_SIZE_OPTIONS[0]) {
    paginationEl.hidden = true;
    return;
  }
  const size = effectivePageSize();
  const shownEnd = Math.min(filesOffset + size, total);
  paginationStatusEl.textContent = `Showing ${filesOffset + 1}–${shownEnd} of ${total}`;
  backBtn.disabled = filesOffset === 0;
  nextBtn.disabled = shownEnd >= total;
  paginationEl.hidden = false;
}

nextBtn.addEventListener('click', () => {
  if (nextBtn.disabled) return;
  filesOffset += effectivePageSize();
  saveExplorerState();
  renderFilePage();
  gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

backBtn.addEventListener('click', () => {
  if (backBtn.disabled) return;
  filesOffset = Math.max(0, filesOffset - effectivePageSize());
  saveExplorerState();
  renderFilePage();
  gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

pageSizeSelect.addEventListener('change', () => {
  const v = pageSizeSelect.value;
  pageSize = v === 'all' ? 'all' : parseInt(v, 10);
  filesOffset = 0;
  saveExplorerState();
  renderFilePage();
});

document.addEventListener('keydown', (e) => {
  if (paginationEl.hidden) return;
  if (document.getElementById('gbOverlay').classList.contains('open')) return;
  if (document.getElementById('packerOverlay').classList.contains('open')) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!e.shiftKey) return;   // plain arrows move through the tree (keyboard-nav.js)
  if (e.key === 'ArrowLeft' && !backBtn.disabled) {
    e.preventDefault();
    backBtn.click();
  } else if (e.key === 'ArrowRight' && !nextBtn.disabled) {
    e.preventDefault();
    nextBtn.click();
  }
});

async function loadArtFromServer(url, filename) {
  log(`decoding ${filename}…`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buf = await resp.arrayBuffer();
    const frames = await parseArtBuffer(buf);
    if (frames.length === 0) {
      log(`${filename}: header parsed but no drawable frames were found`, 'err');
      return;
    }
    log(`${filename}: extracted ${frames.length} frame${frames.length === 1 ? '' : 's'}`, 'ok');
    renderFileGroup(filename.replace(/\.art$/i, ''), frames, {
      folder: folderRelPath,
      folderName: currentFolderName,
      file: filename,
    }, buf);
    viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    log(`${filename}: ${errText(err)}`, 'err');
  }
}

async function selectFolder(relativePath, folderName) {
  folderRelPath = relativePath; currentFolderName = folderName; filesOffset = 0;
  saveExplorerState({ file: null });
  if (artTree) artTree.select(relativePath);
  showBrowser();
  paginationEl.hidden = true;
  gridEl.innerHTML = '<p class="explorer-status">Loading…</p>';
  try {
    const manifest = await loadManifest(relativePath, folderName);
    renderGrid(manifest, relativePath, folderName);
  } catch (err) {
    gridEl.innerHTML = '';
    gridEl.appendChild(errorPara(errText(err)));
  }
}

let artTree = null;

export function initExplorer(skipAutoOpen) {
  loadThumbIndex();   // alongside the first folder manifest, not after it
  artTree = mountFolderTree({
    rootName: ROOT_FOLDER_NAME, loadManifest, ext: 'art', fileIcon: '🖼️',
    openFolder: selectFolder,
    openFile: (filename, _row, folder) => openDeepLink({ folder, folderName: folder.split('/').pop() || ROOT_FOLDER_NAME, file: filename }),
  });
  if (!skipAutoOpen) selectFolder(ROOT_RELATIVE_PATH, ROOT_FOLDER_NAME);
}

// Opens a place kept by the Back button: a file, the results of a search, or a folder, on the same page.
export async function openArtPlace({ path, folderName, file, query, offset }) {
  if (file) return openDeepLink({ folder: path, folderName: folderName || path.split('/').pop() || ROOT_FOLDER_NAME, file });
  if (query) { searchInputEl.value = query; await runSearch(query); }
  else await selectFolder(path, folderName || path.split('/').pop() || ROOT_FOLDER_NAME);
  if (offset) { filesOffset = offset; renderFilePage(); }
}

export async function openDeepLink(target) {
  if (artTree) artTree.select(target.folder);
  const manifest = await loadManifest(target.folder, target.folderName);
  renderGrid(manifest, target.folder, target.folderName);

  // the game's names are not cased like the files on disk (HMMRBXAa.art / hmmrbxaa.ART)
  let idx = folderFiles.indexOf(target.file);
  if (idx === -1) {
    idx = folderFiles.findIndex(f => f.toLowerCase() === target.file.toLowerCase());
    if (idx !== -1) target = { ...target, file: folderFiles[idx] };
  }
  if (idx === -1) {
    log(`share link: "${target.file}" wasn't found in that folder`, 'err');
    return;
  }
  const size = effectivePageSize();
  filesOffset = Math.floor(idx / size) * size;
  saveExplorerState({ file: target.file });
  renderFilePage();

  const folderPrefix = target.folder ? `${target.folder}/` : '';
  const artUrl = `${ART_ROOT}${encPath(folderPrefix)}${encPath(target.file)}`;
  await loadArtFromServer(artUrl, target.file);
}
