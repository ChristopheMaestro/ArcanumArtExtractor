// .SEC sector explorer (folder tree and entry point).

import { mountFolderTree } from '../explorer/folder-tree.js';

import { joinPath, loadMapsManifest, manifestFileList, manifestFiles, manifestSubfolders } from '../core/manifest.js';

import { buildWorldFiles, createWorldSectors, loadTerrainMap } from './sec-terrain.js';

import { breadcrumbEl, gridEl, treeEl, viewerEl } from '../core/dom.js';

import { beginDataExplorer, createDataFolderCard, showExplorerError } from '../explorer/data-explorer.js';

import { saveDataExplorerState } from '../explorer/state-store.js';
import { mountBackBar } from '../explorer/nav-history.js';

import { renderSecFolderMap } from '../editor/sec-folder-viewer.js';
import { removeContextTools } from '../ui/shell.js';

import { loadSecFolderSectors, renderSecFolderLoading } from './sec-map-view.js';
import { explorerMode } from '../core/state.js';
import { openWorldEditorDialog } from '../editor/world-editor-dialog.js';

const secMobInfoStyle = document.createElement('style');
secMobInfoStyle.textContent = '.sec-mob-info-row{padding:4px 0;border-bottom:1px solid rgba(127,127,127,.25);overflow-wrap:anywhere;font-size:12px}';
document.head.appendChild(secMobInfoStyle);

// The world map's towns and secret areas sit in sub-folders of the world map folder. They are parts
// of that one map, so the world map folder is presented with their sectors and objects merged in
// (names become 'Town/123.sec'; `relativeNames` tells loadMobsForSecMap to resolve them from the
// folder instead of from the maps root). The sub-folders stay listed so they can be browsed too.
const mergedManifests = new Map();
export function loadSecManifest(relativePath = '', folderName) {
  const key = String(relativePath || '');
  if (!mergedManifests.has(key)) {
    const p = (async () => {
      // the terrain grid is read alongside the manifest, and the sub-folder manifests all at once (online each is a round trip)
      const terrain = key ? loadTerrainMap(key).catch(() => null) : null;
      const manifest = await loadMapsManifest(relativePath, folderName);
      if (!key || !manifestSubfolders(manifest).length || !(await terrain)) return manifest;
      const files = manifestFileList(manifest).slice();
      const subs = await Promise.all(manifestSubfolders(manifest).map(sf =>
        loadMapsManifest(joinPath(key, sf.relative_path || sf.folder_name), sf.folder_name).catch(() => null)));
      manifestSubfolders(manifest).forEach((sf, i) => {
        const sub = subs[i];
        if (!sub) return;
        const own = manifestFileList(sub).filter(f => /\.(sec|mob)$/i.test(f) && !/\//.test(f));
        if (!own.some(f => /\.sec$/i.test(f)) || manifestSubfolders(sub).length) return;
        const dir = sf.relative_path || sf.folder_name;
        for (const f of own) files.push(`${dir}/${f}`);
      });
      return { ...manifest, files, relativeNames: true };
    })();
    mergedManifests.set(key, p);
    p.catch(() => mergedManifests.delete(key));
  }
  return mergedManifests.get(key);
}

export let secManifest = null;
let secFiles = [];
let secTree = null;
let secMapView = null;   // { path, article }: the folder map currently in the viewer
let secMapToken = 0;
let secCurrentPath = null;
export let secCurrentFolderName = 'maps';

export function secDisplayName(path, fallback) {
  return (fallback && fallback !== '..') ? fallback : (path.split('/').filter(Boolean).pop() || 'maps');
}

function renderSecFolderGrid(manifest, relativePath) {
  gridEl.innerHTML = '';
  const subfolders = manifestSubfolders(manifest);
  for (const sf of subfolders) {
    const fullPath = joinPath(relativePath, sf.relative_path || sf.folder_name);
    const card = createDataFolderCard(sf.folder_name, fullPath, openSecFolder);
    gridEl.appendChild(card);
  }
  for (const filename of secFiles) {
    if (filename.includes('/')) continue;   // merged in from a sub-folder: listed when that folder is opened
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'explorer-item sec-file-item';
    card.innerHTML = '<span class="explorer-thumb">🗺️</span><span class="explorer-filename"></span>';
    card.querySelector('.explorer-filename').textContent = filename;
    card.addEventListener('click', () => openSecFile(filename, relativePath, null));
    gridEl.appendChild(card);
  }
  if (!subfolders.length && !secFiles.some(f => !f.includes('/'))) {
    gridEl.innerHTML = '<p class="explorer-status">This folder is empty.</p>';
  }
}

export async function openSecFolder(relativePath, folderName) {
  if (secTree) secTree.select(relativePath);
  try {
    await setSecContext(relativePath || '', folderName);
    saveDataExplorerState('sec', secCurrentPath, secCurrentFolderName, null);
    renderSecFolderGrid(secManifest, secCurrentPath);
    if (secFiles.length) await showSecMap(secCurrentPath, secCurrentFolderName, null);
    else { gridEl.hidden = false; viewerEl.hidden = true; viewerEl.innerHTML = ''; }
  } catch (err) {
    showExplorerError(err);
  }
}

// A .sec opens the map of its whole folder, fitted to that sector.
export async function openSecFile(filename, relativePath, rowEl) {
  if (secTree) secTree.select(relativePath);
  if (rowEl) {
    treeEl.querySelectorAll('.mob-file-row.active').forEach(r => r.classList.remove('active'));
    rowEl.classList.add('active');
  }
  try {
    await setSecContext(relativePath || '', null);
    saveDataExplorerState('sec', secCurrentPath, secCurrentFolderName, filename);
    await showSecMap(secCurrentPath, secCurrentFolderName, filename && filename.split('/').pop());
  } catch (err) {
    showExplorerError(err);
  }
}

// "Open world editor" in the top bar, only while the main folder of the maps is on screen.
const worldEditorBtn = document.getElementById('worldEditorLaunchBtn');
const syncWorldEditorBtn = () => { if (worldEditorBtn) worldEditorBtn.hidden = !(explorerMode === 'sec' && secCurrentPath === ''); };
worldEditorBtn?.addEventListener('click', openWorldEditorDialog);
document.addEventListener('explorermodechange', syncWorldEditorBtn);

// A new world from the dialog: its sectors are generated in memory and the editor opens on them.
// No .sec exists until the editor's export.
document.addEventListener('worldeditorcreate', async e => {
  const { width, height, terrain } = e.detail;
  const token = ++secMapToken;
  const loading = renderSecFolderLoading('New world', width * height);
  viewerEl.innerHTML = '';
  viewerEl.appendChild(loading.article);
  viewerEl.hidden = false; viewerEl.classList.add('revealed'); gridEl.hidden = true;
  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const sectors = await createWorldSectors(width, height, terrain.id, (n, total) => loading.update(n, total, { filename: 'Generating sectors' }));
    const article = await renderSecFolderMap('New world', 'New world', sectors, null, { virtual: true, startEditing: true, extraFiles: () => buildWorldFiles(width, height, terrain.id) });
    if (token !== secMapToken) { if (article) removeContextTools(article); return; }
    viewerEl.innerHTML = '';
    viewerEl.appendChild(article);
    secMapView = null;   // never matches a folder: this map is not on disk
    breadcrumbEl.textContent = `/maps/ (new world ${width} × ${height}, ${terrain.name})`;
  } catch (err) {
    showExplorerError(err);
  }
});

// Make `relativePath` the current folder (manifest, file list, breadcrumb).
async function setSecContext(relativePath, folderName) {
  breadcrumbEl.textContent = `/maps/${relativePath ? relativePath + '/' : ''}`;
  const prevPath = secCurrentPath;
  secCurrentPath = relativePath; syncWorldEditorBtn();
  if (secManifest && relativePath === prevPath) return;
  secCurrentFolderName = secDisplayName(relativePath, folderName);
  secManifest = await loadSecManifest(relativePath, secCurrentFolderName);
  secFiles = manifestFiles(secManifest, 'sec');
}

// Show the folder map in the main pane, focused on one sector or (null) on all of it.
// When that folder's map is already on screen it is reused, so edits are kept.
async function showSecMap(path, folderName, focusFilename) {
  if (secMapView && secMapView.path === path && viewerEl.contains(secMapView.article)) {
    secMapView.article.focusSector(focusFilename);
    secMapView.article.attachHistory?.();   // the map shown for this place now, for the Back button
    gridEl.hidden = true; viewerEl.hidden = false; viewerEl.classList.add('revealed');
    return;
  }
  const token = ++secMapToken;
  const loading = renderSecFolderLoading(folderName, secFiles.length);
  viewerEl.innerHTML = '';
  viewerEl.appendChild(loading.article);
  viewerEl.hidden = false;
  viewerEl.classList.add('revealed');
  gridEl.hidden = true;
  // Give the browser a chance to paint the loading UI before the first fetch.
  await new Promise(resolve => requestAnimationFrame(resolve));
  const sectors = await loadSecFolderSectors(path, secFiles, loading.update);
  const article = await renderSecFolderMap(path, folderName, sectors, focusFilename);
  if (token !== secMapToken) { if (article) removeContextTools(article); return; }   // the user went somewhere else meanwhile
  if (!article) { gridEl.hidden = false; viewerEl.hidden = true; viewerEl.innerHTML = ''; secMapView = null; return; }
  viewerEl.innerHTML = '';   // replaces the loading view
  viewerEl.appendChild(article);
  secMapView = { path, article };
  mountBackBar(viewerEl);
}

// "See on map": the map of the folder, centred on a tile (a sector and the tile in it).
export async function openSecAtTile(relativePath, folderName, tile, label) {
  saveDataExplorerState('sec', relativePath, folderName, null);
  await enterSecExplorer(true);
  if (secMapView && secMapView.path === relativePath) await secMapView.article.goToTile(tile.sectorX, tile.sectorY, tile.tileX, tile.tileY, label);
}

export async function enterSecExplorer(restoreState = false) {
  const { path, name, file } = beginDataExplorer('sec', { rootName: 'maps', breadcrumb: 'maps', restoreState });
  secMapView = null;
  secCurrentPath = null; secManifest = null;
  secTree = mountFolderTree({
    // The tree (and the search) list each folder's own files; only the map merges in the sub-folders.
    rootName: 'maps', loadManifest: loadMapsManifest, openFolder: openSecFolder, ext: 'sec', fileIcon: '🗺️',
    openFile: (filename, row, folder) => openSecFile(filename, folder, row),
  });
  try {
    await setSecContext(path, name);
    if (file && secFiles.includes(file)) await openSecFile(file, path, null);
    else await openSecFolder(path, name);
  } catch (err) { showExplorerError(err); }
}
