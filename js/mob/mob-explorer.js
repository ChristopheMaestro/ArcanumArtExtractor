// .MOB file explorer.

import { applyMobCardIcon, startMobCardIcons } from './mob-card-art.js';
import { MOB_FIELDS } from '../explorer/file-search.js';
import { mountFolderTree } from '../explorer/folder-tree.js';
import { errText } from '../core/text-io.js';
import { manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { createIndexLoader, toDataPath } from '../core/file-index.js';

import { MOB_ROOT } from '../core/config.js';

import { breadcrumbEl, gridEl, treeEl, viewerEl } from '../core/dom.js';

import { log } from '../core/log.js';

import { encPath, errorPara } from '../core/util.js';

import { beginDataExplorer, renderDataFolderGrid, showExplorerError } from '../explorer/data-explorer.js';

import { saveDataExplorerState } from '../explorer/state-store.js';

import { decodeMobBuffer } from './mob-decoder.js';

import { renderMobViewer } from './mob-viewer.js';

import { renderMobPrototypeInfo, resolveMobPrototype } from '../proto/proto-resolution.js';

import { renderMobExtras } from './mob-extras.js';
import { loadDescriptionMes } from '../proto/proto-mes.js';

// Listed from data/ (the base maps, the mods and the modules): paths are under data/ (toolbox/file_index.py)
const loadMobManifest = createIndexLoader('mob');
// A search reads every object it looks through: it covers the game, mod or module of the folder on show (the base game from the data root).
const mobSearchScope = path => { const p = String(path || '').split('/').filter(Boolean); return !p.length ? 'maps' : (p[0] === 'mods' || p[0] === 'modules') && p.length > 1 ? p.slice(0, 2).join('/') : p[0] === 'maps' ? 'maps' : p.join('/'); };
export let mobFiles = [];
let mobManifest = null;
let mobTree = null;
export let mobCurrentPath = '';
let mobCurrentFolderName = 'data';
// The folder being browsed: what a jump to another file needs to come back here.
export const mobState = () => ({ path: mobCurrentPath, folderName: mobCurrentFolderName });

function mobDisplayName(path, fallback) { return (fallback && fallback !== '..') ? fallback : (path.split('/').filter(Boolean).pop() || 'data'); }

function renderMobGrid(manifest, relativePath) {
  startMobCardIcons();
  renderDataFolderGrid({
    subfolders: manifestSubfolders(manifest), files: manifestFiles(manifest, 'mob'), relativePath,
    openFolderFn: openMobFolder, openFileFn: loadMobFromServer, fileIcon: '📦',
    afterFileCard: (card, filename) => applyMobCardIcon(card, filename, relativePath),
  });
}
async function openMobFolder(relativePath, folderName) {
  if (mobTree) mobTree.select(relativePath);
  breadcrumbEl.textContent = `/data/${relativePath ? relativePath + '/' : ''}`;
  try {
    mobCurrentPath = relativePath;
    mobCurrentFolderName = mobDisplayName(relativePath, folderName);
    saveDataExplorerState('mob', mobCurrentPath, mobCurrentFolderName, null);
    mobManifest = await loadMobManifest(relativePath);
    mobFiles = manifestFiles(mobManifest, 'mob');
    renderMobGrid(mobManifest, relativePath);
    gridEl.hidden = false; viewerEl.hidden = true;
  } catch (err) { showExplorerError(err); }
}
export async function enterMobExplorer(restoreState = false) {
  const { path, name, file } = beginDataExplorer('mob', { rootName: 'data', label: 'mob', breadcrumb: 'data', restoreState });
  mobTree = mountFolderTree({
    rootName: 'data', loadManifest: loadMobManifest, openFolder: openMobFolder, ext: 'mob', fileIcon: '📦', searchFields: MOB_FIELDS, searchScope: mobSearchScope,
    openFile: (filename, row, folder) => loadMobFromServer(filename, row, folder),
    searchCards: { begin: startMobCardIcons, decorate: (card, filename, relativePath) => applyMobCardIcon(card, filename, relativePath) },
  });
  await openMobFolder(path, name);
  if (file && mobFiles.includes(file)) await loadMobFromServer(file, null, path);
}
let mobViewerRequestToken = 0;
export async function loadMobFromServer(filename,rowEl,relativePath='') {
  treeEl.querySelectorAll('.mob-file-row.active').forEach(r=>r.classList.remove('active'));if(rowEl)rowEl.classList.add('active');
  const url=`${MOB_ROOT}${relativePath?encPath(relativePath)+'/':''}${encPath(filename)}`;
  saveDataExplorerState('mob',relativePath,mobDisplayName(relativePath,rowEl?.parentElement?.querySelector?.('.mob-list-heading strong')?.textContent?.replace(/^📦\s*/, '') || mobCurrentFolderName),filename);
  const requestId = ++mobViewerRequestToken;
  try {
    const resp=await fetch(url);
    if(!resp.ok)throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buffer=await resp.arrayBuffer();
    const decoded=decodeMobBuffer(buffer,filename);
    await loadDescriptionMes().catch(() => null);   // so the name of a special NPC shows in the field table
    if (requestId !== mobViewerRequestToken) return;
    const parts = renderMobViewer(decoded, buffer);
    const { protoSection } = parts;
    resolveMobPrototype(decoded).then(proto => {
      if (requestId !== mobViewerRequestToken) return;
      renderMobPrototypeInfo(decoded, proto, protoSection);
      return renderMobExtras(decoded, proto, { ...parts, filename, relativePath });
    }).catch(err => {
      if (requestId !== mobViewerRequestToken) return;
      protoSection.innerHTML = '';
      protoSection.appendChild(errorPara(`Prototype resolution failed: ${errText(err)}`));
    });
  }
  catch(err){log(`${filename}: ${errText(err)}`,'err');}
}
