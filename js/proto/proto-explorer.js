// .PRO prototype explorer, including search.

import { mountFolderTree } from '../explorer/folder-tree.js';

import { errText } from '../core/text-io.js';

import { createManifestLoader, manifestFiles, manifestSubfolders } from '../core/manifest.js';

import { PRO_ROOT } from '../core/config.js';

import { breadcrumbEl, gridEl, paginationEl, protoObjectTypeFilterEl, searchClearBtnEl, searchInputEl, treeEl, viewerEl } from '../core/dom.js';

import { log } from '../core/log.js';

import { explorerMode } from '../core/state.js';

import { encPath, errorPara } from '../core/util.js';

import { beginDataExplorer, createDataFileCard, renderDataFolderGrid, showExplorerError } from '../explorer/data-explorer.js';

import { saveDataExplorerState } from '../explorer/state-store.js';

import { visit } from '../explorer/nav-history.js';

import { MOB_OBJECT_TYPE_NAMES } from '../mob/mob-schema.js';

import { applyProtoCurrentArtToFileCard } from './proto-card-art.js';

import { decodeProtoBuffer, decodeProtoForSearch } from './proto-decoder.js';

import {
  loadContainerMes,
  loadDescriptionMes,
  loadItemGroundMes,
  loadItemInvenMes,
  loadItemPaperMes,
  loadSceneryMes,
} from './proto-mes.js';

import { renderProtoViewer } from './proto-viewer.js';

import { loadProtoIndex } from './proto-index.js';

import { matchFields, splitTerms } from '../explorer/match.js';

let protoFiles = [];
let protoManifest = null;
let protoCurrentPath = '';
let protoCurrentFolderName = 'proto';
let protoBrowseMode = 'folder'; // 'folder' | 'search'
let protoViewerFilename = '';
let protoSearchResults = [];
let protoLastSearchQuery = '';
let protoObjectTypeFilter = 'all';
const PROTO_SEARCH_RESULT_LIMIT = 300;
export const protoDecodedCache = new Map();

let protoTree = null;
export const loadProtoManifest = createManifestLoader({ root: PRO_ROOT, rootName: 'proto', label: '.pro' });

function protoDisplayName(path, fallback) {
  return fallback || path.split('/').filter(Boolean).pop() || 'proto';
}

async function protoFileMatchesType(filename, relativePath, filter = protoObjectTypeFilter) {
  if (!filter || filter === 'all') return true;
  try {
    const decoded = await decodeProtoForSearch(filename, relativePath);
    return String(decoded.objType) === String(filter);
  } catch (_) { return false; }
}

async function filterProtoFilesByObjectType(files, relativePath) {
  if (protoObjectTypeFilter === 'all') return files;
  const out = [];
  for (const filename of files) {
    if (await protoFileMatchesType(filename, relativePath)) out.push(filename);
  }
  return out;
}

function populateProtoObjectTypeFilter() {
  const select = document.getElementById('protoObjectTypeFilter');
  if (!select || select.options.length > 1) return;
  MOB_OBJECT_TYPE_NAMES.forEach((name, type) => {
    const opt = document.createElement('option');
    opt.value = String(type);
    opt.textContent = `${name} (${type})`;
    select.appendChild(opt);
  });
}

async function renderProtoGrid(manifest, relativePath) {
  populateProtoObjectTypeFilter();
  const subfolders = manifestSubfolders(manifest);
  const files = await filterProtoFilesByObjectType(manifestFiles(manifest, 'pro'), relativePath);
  renderDataFolderGrid({
    subfolders, files, relativePath, openFolderFn: openProtoFolder, openFileFn: loadProtoFromServer, fileIcon: '🧬',
    afterFileCard: (card, filename) => applyProtoCurrentArtToFileCard(card, filename, relativePath)
  });
}

async function openProtoFolder(relativePath, folderName) {
  if (protoTree) protoTree.select(relativePath);
  breadcrumbEl.textContent = `/proto/${relativePath ? relativePath + '/' : ''}`;
  try {
    protoCurrentPath = relativePath;
    protoCurrentFolderName = protoDisplayName(relativePath, folderName);
    protoBrowseMode = 'folder';
    protoSearchResults = [];
    protoLastSearchQuery = '';
    searchInputEl.value = '';
    searchClearBtnEl.hidden = true;
    saveDataExplorerState('pro', protoCurrentPath, protoCurrentFolderName, null);
    protoManifest = await loadProtoManifest(relativePath, folderName);
    protoFiles = manifestFiles(protoManifest, 'pro');
    await renderProtoGrid(protoManifest, relativePath);
    gridEl.hidden = false;
    viewerEl.hidden = true;
  } catch (err) { showExplorerError(err); }
}

export async function enterProtoExplorer(restoreState = false) {
  const { path, name, file } = beginDataExplorer('pro', {
    rootName: 'proto', breadcrumb: 'proto', restoreState, showLog: true, showArtControls: true, showTypeFilter: true,
    searchPlaceholder: 'Search .PRO name, description, type…'
  });
  protoTree = mountFolderTree({
    rootName: 'proto', loadManifest: loadProtoManifest, openFolder: openProtoFolder, ext: 'pro', fileIcon: '🧬',
    openFile: loadProtoFromServer,
    fileFilter: (filename, folder) => protoFileMatchesType(filename, folder, protoObjectTypeFilter),
  });
  await openProtoFolder(path, name);
  if (file && protoFiles.includes(file)) await loadProtoFromServer(file, null, path);
}

// Open a prototype of the .PRO explorer from elsewhere (a .mob's "See .pro").
export async function openProtoFile(filename, relativePath = '') {
  saveDataExplorerState('pro', relativePath, relativePath.split('/').pop() || 'proto', filename);
  await enterProtoExplorer(true);
}

export async function loadProtoFromServer(filename, rowEl, relativePath = '') {
  protoCurrentPath = relativePath || '';
  protoBrowseMode = 'folder';
  try {
    protoManifest = await loadProtoManifest(protoCurrentPath, protoCurrentPath ? protoCurrentPath.split('/').pop() : 'proto');
    protoFiles = manifestFiles(protoManifest, 'pro');
  } catch (err) {
    protoFiles = [];
  }
  protoCurrentFolderName = protoCurrentPath ? protoCurrentPath.split('/').pop() : 'proto';
  treeEl.querySelectorAll('.mob-file-row.active').forEach(r => r.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');
  const url = `${PRO_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`;
  saveDataExplorerState('pro', relativePath, protoCurrentFolderName, filename);
  protoViewerFilename = filename;
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const decoded = decodeProtoBuffer(await resp.arrayBuffer(), filename);
    try { await Promise.all([loadDescriptionMes(), loadItemInvenMes(), loadItemGroundMes(), loadItemPaperMes(), loadContainerMes(), loadSceneryMes()]); }
    catch (mesErr) { log(`.mes lookup: ${mesErr && mesErr.message ? mesErr.message : mesErr}`, 'err'); }
    renderProtoViewer(decoded);
  } catch (err) {
    log(`${filename}: ${errText(err)}`, 'err');
    gridEl.hidden = true;
    viewerEl.hidden = false;
    viewerEl.innerHTML = '';
    viewerEl.appendChild(errorPara(`Couldn't open ${filename}: ${errText(err)}`));
  }
}

async function navigateProtoFile(delta) {
  if (explorerMode !== 'pro' || viewerEl.hidden) return;
  if (!protoFiles.length) {
    try {
      protoManifest = await loadProtoManifest(protoCurrentPath, protoCurrentFolderName);
      protoFiles = manifestFiles(protoManifest, 'pro');
    } catch (_) { return; }
  }
  const currentIndex = protoFiles.findIndex(name => name.toLowerCase() === String(protoViewerFilename || '').toLowerCase());
  if (currentIndex < 0) return;
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= protoFiles.length) return;
  const filename = protoFiles[nextIndex];
  const row = Array.from(treeEl.querySelectorAll('.mob-file-row')).find(r => r.querySelector('.tree-name')?.textContent === filename);
  await loadProtoFromServer(filename, row || null, protoCurrentPath);
}

document.addEventListener('keydown', (e) => {
  if (explorerMode !== 'pro' || viewerEl.hidden) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (document.getElementById('gbOverlay').classList.contains('open')) return;
  e.preventDefault();
  navigateProtoFile(e.key === 'ArrowUp' ? -1 : 1);
});

if (protoObjectTypeFilterEl) {
  protoObjectTypeFilterEl.addEventListener('change', async () => {
    protoObjectTypeFilter = protoObjectTypeFilterEl.value;
    if (explorerMode !== 'pro') return;
    if (protoBrowseMode === 'search') {
      await runProtoSearch(protoLastSearchQuery);
    } else {
      if (protoTree) protoTree.refresh();
      await renderProtoGrid(protoManifest, protoCurrentPath);
    }
  });
}

// Search looks at every field of a prototype (file name, object type, description, art names) through
// the shared index (proto-index.js) and honors the object-type filter.

function renderProtoSearchResults() {
  gridEl.innerHTML = '';
  paginationEl.hidden = true;
  if (protoSearchResults.length === 0) {
    const p = document.createElement('p');
    p.className = 'explorer-status';
    p.textContent = `No .pro files match "${protoLastSearchQuery}".`;
    gridEl.appendChild(p);
    return;
  }
  for (const item of protoSearchResults) {
    const fullPath = item.relPath ? `${item.relPath}/${item.filename}` : item.filename;
    const card = createDataFileCard(item.filename, fullPath, '🧬', card =>
      loadProtoFromServer(item.filename, card, item.relPath));
    const pathLabel = document.createElement('span');
    pathLabel.className = 'explorer-item-path';
    pathLabel.textContent = `/proto/${item.relPath}`.replace(/\/+/g, '/') || '/proto/';
    card.appendChild(pathLabel);
    if (item.note) { const note = document.createElement('span'); note.className = 'explorer-item-note'; note.textContent = item.note; note.title = item.note; card.appendChild(note); }
    gridEl.appendChild(card);
    applyProtoCurrentArtToFileCard(card, item.filename, item.relPath);
  }
}

export async function runProtoSearch(rawQuery) {
  const query = (rawQuery || '').trim();
  if (!query) return;

  protoLastSearchQuery = query;
  protoBrowseMode = 'search';
  protoSearchResults = [];
  searchClearBtnEl.hidden = false;
  visit({ mode: 'pro', path: protoCurrentPath, folderName: protoCurrentFolderName, query });   // Back from a result lands on these results

  treeEl.querySelectorAll('.tree-row.active, .mob-file-row.active').forEach(r => r.classList.remove('active'));
  gridEl.hidden = false;
  viewerEl.hidden = true;
  breadcrumbEl.textContent = `Searching for "${query}"…`;
  gridEl.innerHTML = '<p class="explorer-status">Searching…</p>';
  paginationEl.hidden = true;

  const results = [];
  try {
    const terms = splitTerms(query);
    const { entries } = await loadProtoIndex((done, total) => { breadcrumbEl.textContent = `Indexing prototypes… ${done} / ${total}`; });
    for (const entry of entries) {
      if (results.length >= PROTO_SEARCH_RESULT_LIMIT) break;
      if (protoObjectTypeFilter !== 'all' && String(entry.objType) !== String(protoObjectTypeFilter)) continue;
      const hit = matchFields(entry.fields, terms);
      if (hit) results.push({ filename: entry.filename, relPath: entry.path, folderName: entry.folderName, note: hit.note });
    }
  } catch (err) {
    log(`.pro search: ${errText(err)}`, 'err');
  }  results.sort((a, b) => a.filename.localeCompare(b.filename));
  protoSearchResults = results;

  const cappedNote = results.length >= PROTO_SEARCH_RESULT_LIMIT ? ` (showing first ${PROTO_SEARCH_RESULT_LIMIT})` : '';
  breadcrumbEl.textContent = `Search results for "${query}" — ${results.length} match${results.length === 1 ? '' : 'es'}${cappedNote}`;
  renderProtoSearchResults();
}

export function clearProtoSearch() {
  protoBrowseMode = 'folder';
  protoSearchResults = [];
  protoLastSearchQuery = '';
  searchInputEl.value = '';
  searchClearBtnEl.hidden = true;
  saveDataExplorerState('pro', protoCurrentPath, protoCurrentFolderName, null);
  breadcrumbEl.textContent = `/proto/${protoCurrentPath ? protoCurrentPath + '/' : ''}`;
  renderProtoGrid(protoManifest, protoCurrentPath);
}
