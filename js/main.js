// Entry point. Importing the modules below registers every feature (they wire their own
// DOM listeners); the code underneath decides what to show on page load.

import { errText } from './core/text-io.js';
import './core/dom.js';
import './core/config.js';
import './core/canvas-utils.js';
import './core/state.js';
import './ui/sidebar.js';
import './ui/shell.js';
import './core/log.js';
import './art/art-decoder.js';
import './core/util.js';
import './art/art-export.js';
import './explorer/viewer-shell.js';
import './art/share-links.js';
import './art/file-group.js';
import './art/gif-builder.js';
import './art/hex-viewer.js';
import './art/packer-art-builder.js';
import './art/packer-png.js';
import './art/packer-ui.js';
import './mob/mob-schema.js';
import './mob/mob-decoder.js';
import './mob/mob-explorer.js';
import './explorer/data-explorer.js';
import './proto/proto-card-art.js';
import './mob/mob-map.js';
import './proto/proto-explorer.js';
import './proto/proto-mes.js';
import './core/mes-parser.js';
import './objects/wall-art.js';
import './objects/object-fields.js';
import './objects/art-frames.js';
import './objects/critter-art.js';
import './objects/map-art-loader.js';
import './proto/critter-aid.js';
import './proto/proto-decoder.js';
import './proto/proto-resolution.js';
import './proto/proto-viewer.js';
import './mob/mob-viewer.js';
import './explorer/home.js';
import './text/mes-explorer.js';
import './text/dlg-explorer.js';
import './scr/scr-schema.js';
import './scr/scr-decoder.js';
import './scr/scr-explorer.js';
import './art/art-explorer.js';
import './sec/sec-explorer.js';
import './sec/sec-map-view.js';
import './sec/sec-parser.js';
import './editor/sec-writer.js';
import './sec/sec-tile-art.js';
import './sec/sec-iso.js';
import './sec/sec-object-points.js';
import './sec/sec-walls.js';
import './sec/sec-mob-overlay.js';
import './sec/sec-placeholders.js';
import './sec/sec-folder-map.js';
import './sec/sec-lighting.js';
import './editor/sec-folder-viewer.js';
import './art/art-preview.js';
import './explorer/state-store.js';
import './art/dropzone.js';
import './explorer/keyboard-nav.js';
import { initExplorer, loadExplorerState, openDeepLink, pageSize, setPageSize } from './art/art-explorer.js';
import { parseDeepLink } from './art/share-links.js';
import { explorerHome, footerNoteEl, logEl, manualLoadEl, pageSizeSelect, treeEl } from './core/dom.js';
import { log } from './core/log.js';
import { showExplorerHome } from './explorer/home.js';
import { adoptUrlState, loadDataExplorerState } from './explorer/state-store.js';
import { enterMobExplorer } from './mob/mob-explorer.js';
import { enterProtoExplorer } from './proto/proto-explorer.js';
import { enterSecExplorer } from './sec/sec-explorer.js';
import { enterScrExplorer } from './scr/scr-explorer.js';
import { enterDlgExplorer } from './text/dlg-explorer.js';
import { enterMesExplorer } from './text/mes-explorer.js';

// The landing page is intentionally minimal: no explorer, search, local drop zone, or log.
document.body.classList.add('home-active');
const deepLinkTarget = parseDeepLink();   // read before the home screen rewrites the address
adoptUrlState();                          // ?mode=pro&… links become the location to restore
showExplorerHome();
const savedExplorerState = loadExplorerState();
if (savedExplorerState && [50, 100, 200, 'all'].includes(savedExplorerState.pageSize)) {
  setPageSize(savedExplorerState.pageSize);
  pageSizeSelect.value = String(pageSize);
}
if (deepLinkTarget) {
  if (manualLoadEl) manualLoadEl.hidden = false;
  if (logEl) logEl.hidden = false;
  if (footerNoteEl) footerNoteEl.hidden = false;
  document.body.classList.remove('home-active');
  document.querySelector('.explorer').hidden = false;
  explorerHome.hidden = true;
  initExplorer(true);
  openDeepLink(deepLinkTarget).catch(err => {
    log(`share link: couldn't open — ${errText(err)}`, 'err');
    const rootRow = treeEl.querySelector('.tree-row');
    if (rootRow) rootRow.click();
  });
} else {
  const savedDataState = loadDataExplorerState();
  if (savedDataState?.mode === 'sec') enterSecExplorer(true);
  else if (savedDataState?.mode === 'dlg') enterDlgExplorer(true);
  else if (savedDataState?.mode === 'scr') enterScrExplorer(true);
  else if (savedDataState?.mode === 'pro') enterProtoExplorer(true);
  else if (savedDataState?.mode === 'mob') enterMobExplorer(true);
  else if (savedDataState?.mode === 'mes') enterMesExplorer(true);
}
