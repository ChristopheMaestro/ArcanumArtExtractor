// Mode switching (the file-type tabs).

import { initExplorer, openArtPlace, runCategorySearch } from '../art/art-explorer.js';
import {
  artExploreBtn,
  bmpExploreBtn,
  dlgExploreBtn,
  footerNoteEl,
  logEl,
  manualLoadEl,
  mesExploreBtn,
  mobExploreBtn,
  protoExploreBtn,
  protoObjectTypeFilterEl,
  scrExploreBtn,
  searchClearBtnEl,
  searchInputEl,
  secExploreBtn,
  treeEl,
} from '../core/dom.js';
import { setExplorerMode } from '../core/state.js';
import { showBrowser, syncSidebarLaunchButtons } from './viewer-shell.js';
import { enterMobExplorer } from '../mob/mob-explorer.js';
import { enterProtoExplorer } from '../proto/proto-explorer.js';
import { enterSecExplorer } from '../sec/sec-explorer.js';
import { enterScrExplorer } from '../scr/scr-explorer.js';
import { enterDlgExplorer } from '../text/dlg-explorer.js';
import { enterMesExplorer } from '../text/mes-explorer.js';
import { enterBmpExplorer } from '../art/bmp-explorer.js';
import { applySearchUi } from '../ui/shell.js';
import { saveDataExplorerState } from './state-store.js';
import { registerPlaceOpener } from './nav-history.js';
import { resumeFileSearch } from './file-search.js';

function enterArtExplorer(skipAutoOpen = false) {
  document.querySelector('.explorer').hidden = false;
  if (manualLoadEl) manualLoadEl.hidden = false;
  if (logEl) logEl.hidden = false;
  if (footerNoteEl) footerNoteEl.hidden = false;
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
mobExploreBtn.addEventListener('click',()=>{ enterMode('mob'); });
if (secExploreBtn) secExploreBtn.addEventListener('click',()=>{ enterMode('sec'); });
if (dlgExploreBtn) dlgExploreBtn.addEventListener('click',()=>{ enterMode('dlg'); });
if (scrExploreBtn) scrExploreBtn.addEventListener('click',()=>{ enterMode('scr'); });
if (mesExploreBtn) mesExploreBtn.addEventListener('click',()=>{ enterMode('mes'); });
if (bmpExploreBtn) bmpExploreBtn.addEventListener('click',()=>{ enterMode('bmp'); });
protoExploreBtn.addEventListener('click',()=>{ enterMode('pro'); });
artExploreBtn.addEventListener('click',()=>{ enterArtExplorer(); });

// Entering a category from the tabs: the search it was left on shows its results again.
async function enterMode(mode, restore = false) {
  await openMode(mode, restore);
  resumeFileSearch();
}
function openMode(mode, restore = false) {
  if (mode === 'art') return enterArtExplorer();
  if (mode === 'pro') return enterProtoExplorer(restore);
  if (mode === 'mob') return enterMobExplorer(restore);
  if (mode === 'sec') return enterSecExplorer(restore);
  if (mode === 'dlg') return enterDlgExplorer(restore);
  if (mode === 'scr') return enterScrExplorer(restore);
  if (mode === 'mes') return enterMesExplorer(restore);
  if (mode === 'bmp') return enterBmpExplorer(restore);
}

// How Back reopens a place (nav-history.js): an .ART place, or a place of one of the
// data explorers, which all open from the saved location and then show the search that was on screen.
registerPlaceOpener('art', async place => { enterArtExplorer(true); await openArtPlace(place); });
const openDataPlace = async place => {
  saveDataExplorerState(place.mode, place.path, place.folderName, place.file);
  await openMode(place.mode, true);
  if (place.query) { searchInputEl.value = place.query; await runCategorySearch(); }
};
for (const mode of ['pro', 'mob', 'sec', 'dlg', 'scr', 'mes', 'bmp']) registerPlaceOpener(mode, openDataPlace);
