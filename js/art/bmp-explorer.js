// .BMP explorer: every folder under data/ that holds (directly or deeper) at least one .bmp.

import { mountFolderTree } from '../explorer/folder-tree.js';
import { joinPath, manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { loadIndexTree } from '../core/file-index.js';
import { backButton } from '../explorer/nav-history.js';
import { DATA_ROOT } from '../core/config.js';
import { breadcrumbEl, gridEl, paginationEl, viewerEl } from '../core/dom.js';
import { encPath } from '../core/util.js';
import { beginDataExplorer, renderDataFolderGrid, showExplorerError } from '../explorer/data-explorer.js';
import { saveDataExplorerState } from '../explorer/state-store.js';

let bmpFiles = [];
let bmpTree = null;

// js/index/files/file_index_bmp.json (toolbox/file_index.py) lists every .bmp under data/, mods and modules included.
// One request gives the whole folder tree; the folders it holds all contain a .bmp.
let bmpFolders = null;   // path -> { subs: Set<name>, files: [] }
async function loadBmpFolders() {
  if (bmpFolders) return bmpFolders;
  const folders = new Map();
  (function visit(tree, path) {
    folders.set(path, { subs: new Set(Object.keys(tree.d || {})), files: tree.f || [] });
    for (const [name, sub] of Object.entries(tree.d || {})) visit(sub, joinPath(path, name));
  })(await loadIndexTree('bmp'), '');
  return (bmpFolders = folders);
}
// The same shape as a folder manifest, so the shared tree and grid work on it.
async function loadBmpManifest(relativePath = '') {
  const node = (await loadBmpFolders()).get(String(relativePath || '').replace(/^\/+|\/+$/g, ''));
  if (!node) throw new Error(`no .bmp in ${relativePath}`);
  const subfolders = {};
  for (const name of node.subs) subfolders[name] = { folder_name: name, relative_path: name };
  return { subfolders, files: node.files };
}
// The first `limit` .bmp files of a folder and then of its sub-folders, depth first: a folder card's preview.
function firstBmps(path, limit, out = []) {
  const node = bmpFolders?.get(path);
  if (!node) return out;
  for (const file of [...node.files].sort()) { if (out.length >= limit) return out; out.push({ path, file }); }
  for (const sub of [...node.subs].sort()) { if (out.length >= limit) break; firstBmps(joinPath(path, sub), limit, out); }
  return out;
}
const bmpVisibleSubfolders =async manifest => manifestSubfolders(manifest);
const bmpFileUrl = (relativePath, filename) => `${DATA_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`;

function bmpOpenViewer(filename, relativePath) {
  saveDataExplorerState('bmp', relativePath, relativePath.split('/').pop() || 'data', filename);
  gridEl.hidden = true; paginationEl.hidden = true;
  viewerEl.hidden = false; viewerEl.classList.add('revealed'); viewerEl.innerHTML = '';
  const wrap = document.createElement('article');
  wrap.className = 'bmp-viewer';
  const head = document.createElement('div');
  head.className = 'bmp-viewer-head';
  head.appendChild(backButton());
  const title = document.createElement('div');
  title.innerHTML = '<strong></strong> <span></span>';
  title.querySelector('strong').textContent = filename;
  title.querySelector('span').textContent = `/${relativePath || 'data'}`;
  head.appendChild(title);
  wrap.appendChild(head);
  const img = document.createElement('img');
  img.className = 'bmp-viewer-img';
  img.alt = filename;
  img.style.cssText = 'max-width:100%;image-rendering:pixelated;background:repeating-conic-gradient(#8884 0 25%,#0000 0 50%) 0 0/16px 16px';
  const info = document.createElement('div');
  info.className = 'bmp-viewer-info';
  info.style.cssText = 'margin:8px 0;opacity:.75';
  img.addEventListener('load', () => { info.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`; });
  img.addEventListener('error', () => { info.textContent = `Couldn't read ${filename}.`; });
  img.src = bmpFileUrl(relativePath, filename);
  wrap.appendChild(info);
  wrap.appendChild(img);
  viewerEl.appendChild(wrap);
  viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openBmpFolder(relativePath, folderName) {
  if (bmpTree) bmpTree.select(relativePath);
  const manifest = await loadBmpManifest(relativePath, folderName);
  bmpFiles = manifestFiles(manifest, 'bmp');
  saveDataExplorerState('bmp', relativePath, folderName, null);
  breadcrumbEl.textContent = `/data/${relativePath ? relativePath + '/' : ''}`;
  gridEl.hidden = false; viewerEl.hidden = true; viewerEl.classList.remove('revealed'); viewerEl.innerHTML = '';
  const subfolders = await bmpVisibleSubfolders(manifest, relativePath);
  renderDataFolderGrid({
    subfolders, files: bmpFiles, relativePath, openFolderFn: openBmpFolder, fileIcon: '🖼️',
    openFileFn: (fn, _card, parent) => bmpOpenViewer(fn, parent),
    // a folder shows the first four pictures it holds, like the .ART folders
    afterFolderCard: (card, fullPath) => {
      const pics = firstBmps(fullPath, 4);
      if (!pics.length) return;
      const thumb = card.querySelector('.explorer-thumb');
      thumb.innerHTML = '';
      thumb.classList.add('explorer-thumb-mosaic', 'has-mosaic');
      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('span');
        cell.className = 'mosaic-cell';
        if (!pics[i]) cell.classList.add('empty');
        else {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.alt = '';
          img.addEventListener('error', () => { img.remove(); cell.classList.add('missing'); });
          cell.appendChild(img);
          img.src = bmpFileUrl(pics[i].path, pics[i].file);
        }
        thumb.appendChild(cell);
      }
    },
    // the picture itself as the card's thumbnail
    afterFileCard: (card, filename) => {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;image-rendering:pixelated';
      // attached before src is set: only a picture in the page is loaded lazily, a detached one is fetched at once
      const glyph = card._iconThumb.querySelector('.folder-glyph');
      img.addEventListener('load', () => { if (glyph) glyph.hidden = true; });
      img.addEventListener('error', () => img.remove());
      card._iconThumb.appendChild(img);
      img.src = bmpFileUrl(relativePath, filename);
    },
  });
}

export async function enterBmpExplorer(restoreState = false) {
  const { path, name, file } = beginDataExplorer('bmp', { rootName: 'data', restoreState });
  bmpTree = mountFolderTree({
    rootName: 'data', loadManifest: loadBmpManifest, openFolder: openBmpFolder,
    ext: 'bmp', fileIcon: '🖼️', openFile: (filename, _row, parent) => bmpOpenViewer(filename, parent),
  });
  try {
    await openBmpFolder(path, name);
    if (file && bmpFiles.includes(file)) bmpOpenViewer(file, path);
  } catch (err) { showExplorerError(err); }
}
