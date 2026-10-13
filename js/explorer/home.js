// Landing page and mode switching.

import { initExplorer, openArtPlace, runCategorySearch } from '../art/art-explorer.js';
import {
  artExploreBtn,
  dlgExploreBtn,
  explorerHome,
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
import { applySearchUi } from '../ui/shell.js';
import { loadDataExplorerState, saveDataExplorerState, writeStateUrl } from './state-store.js';
import { registerPlaceOpener, visit } from './nav-history.js';
import { resumeFileSearch } from './file-search.js';

// "Continue where you left off", like the recent-files list of a welcome screen.
const resumeEl = document.getElementById('welcomeResume');
function renderResume() {
  if (!resumeEl) return;
  const saved = loadDataExplorerState();
  resumeEl.hidden = !saved;
  resumeEl.innerHTML = '';
  if (!saved) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'welcome-resume-btn';
  const place = [saved.folderName, saved.file].filter(Boolean).join(' / ');
  button.innerHTML = '<span class="welcome-resume-kicker">Continue</span><strong></strong>';
  button.querySelector('strong').textContent = `.${saved.mode.toUpperCase()} · ${saved.path ? `${saved.path} ` : ''}${saved.file ? `· ${saved.file}` : `· ${place}`}`;
  button.addEventListener('click', () => enterMode(saved.mode, true));
  resumeEl.appendChild(button);
}

export function showExplorerHome() {
  visit({ mode: 'home' });
  document.body.classList.add('home-active');
  writeStateUrl(null);
  renderResume();
  explorerHome.hidden = false;
  document.querySelector('.explorer').hidden = true;
  if (manualLoadEl) manualLoadEl.hidden = true;
  if (logEl) logEl.hidden = true;
  if (footerNoteEl) footerNoteEl.hidden = true;
}

export function leaveExplorerHome() {
  document.body.classList.remove('home-active');
}
function enterArtExplorer(skipAutoOpen = false) {
  leaveExplorerHome();
  explorerHome.hidden = true;
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
const appTitle = document.getElementById('appTitle');
if (appTitle) {
  appTitle.addEventListener('click', showExplorerHome);
  appTitle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      showExplorerHome();
    }
  });
}

mobExploreBtn.addEventListener('click',()=>{ enterMode('mob'); });
if (secExploreBtn) secExploreBtn.addEventListener('click',()=>{ enterMode('sec'); });
if (dlgExploreBtn) dlgExploreBtn.addEventListener('click',()=>{ enterMode('dlg'); });
if (scrExploreBtn) scrExploreBtn.addEventListener('click',()=>{ enterMode('scr'); });
if (mesExploreBtn) mesExploreBtn.addEventListener('click',()=>{ enterMode('mes'); });
protoExploreBtn.addEventListener('click',()=>{ enterMode('pro'); });
artExploreBtn.addEventListener('click',()=>{ enterArtExplorer(); });

// Entering a category from the tabs, the cards or "Continue": the search it was left on shows its results again.
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
}

// How Back reopens a place (nav-history.js): the home page, an .ART place, or a place of one of the
// data explorers, which all open from the saved location and then show the search that was on screen.
registerPlaceOpener('home', showExplorerHome);
registerPlaceOpener('art', async place => { enterArtExplorer(true); await openArtPlace(place); });
const openDataPlace = async place => {
  saveDataExplorerState(place.mode, place.path, place.folderName, place.file);
  await openMode(place.mode, true);
  if (place.query) { searchInputEl.value = place.query; await runCategorySearch(); }
};
for (const mode of ['pro', 'mob', 'sec', 'dlg', 'scr', 'mes']) registerPlaceOpener(mode, openDataPlace);
explorerHome.querySelectorAll('[data-open-mode]').forEach(card => {
  card.addEventListener('click', () => enterMode(card.dataset.openMode));
});
