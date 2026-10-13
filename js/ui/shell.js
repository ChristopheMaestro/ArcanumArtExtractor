// App shell: top bar · left side bar · centre · right side bar · status bar.
//
//   top bar    file-type tabs (browse) / editor menu (edit) / tools of the current category
//   left bar   the file list; becomes the editor's tool strip while a map is edited
//   right bar  search for the current category, then the details a viewer wants to show aside
//
// Viewers keep building their own DOM inside the centre pane. Anything they mark as "side"
// content (see SIDE_SELECTORS) is moved into the right bar, and removed again when the viewer
// that owns it goes away. Tools a viewer registers with addContextTool() follow the same rule.

import { searchInputEl, viewerEl } from '../core/dom.js';
import { explorerMode } from '../core/state.js';

export const topbarTools = document.getElementById('topbarTools');
export const editorSlot = document.getElementById('topbarEditor');
export const toolRail = document.getElementById('toolRail');
export const sidePanel = document.getElementById('sidePanel');

const MODE_EXT = { art: 'ART', pro: 'PRO', sec: 'SEC', mob: 'MOB', dlg: 'DLG', mes: 'MES', scr: 'SCR' };
const tabs = [...document.querySelectorAll('#topbarTabs .file-mode-btn')];
const treeTitle = document.getElementById('sideTreeTitle');

// Elements of a viewer that belong in the right side bar.
const SIDE_SELECTORS = ['.mob-side-actions', '.sec-tile-info', '.mes-summary', '.dlg-summary', '.dlg-flow-map', '.mob-summary', '.mob-ids', '.art-side-actions', '.scr-flags', '.scr-terms'];

const sideItems = new Set();   // { el, owner }
const contextTools = new Set(); // { el, owner, seen }

const isHome = () => document.body.classList.contains('home-active');

// A tool shown in the top bar for as long as the viewer `owner` is on screen.
export function addContextTool(el, owner) {
  let tool = [...contextTools].find(t => t.el === el);
  if (!tool) { tool = { el, owner, seen: owner.isConnected }; contextTools.add(tool); }
  el.classList.add('tool-btn', 'tool-object');
  topbarTools.prepend(el);
  return tool;
}

// Drop the tools of a viewer that was built but is never going to be shown (superseded while loading).
export function removeContextTools(owner) {
  for (const tool of contextTools) {
    if (tool.owner === owner) { tool.el.remove(); contextTools.delete(tool); }
  }
}

function sweepContextTools(force = false) {
  for (const tool of contextTools) {
    if (tool.owner.isConnected) { tool.seen = true; continue; }
    // Not attached yet (the viewer is still being built): leave it alone until it has been seen once.
    if (force || tool.seen) { tool.el.remove(); contextTools.delete(tool); }
  }
}

// .ART files have no side element of their own: summarise the open file (name, frames, sizes) for the right bar.
const artCards = new WeakSet();
function artDetailsCard(group) {
  const card = document.createElement('section');
  card.className = 'side-card';
  const title = group.querySelector('.file-group-header h2')?.textContent?.trim() || 'ART file';
  const frames = [...group.querySelectorAll('.frame-card .dims')].map(el => el.textContent.trim());
  const rows = [['File', title], ['Frames', String(frames.length)]];
  const sizes = [...new Set(frames)];
  if (sizes.length) rows.push([sizes.length === 1 ? 'Size' : 'Sizes', sizes.length > 6 ? `${sizes.slice(0, 6).join(', ')}, …` : sizes.join(', ')]);
  card.innerHTML = '<h3>Details</h3>' + rows.map(() => '<div class="side-row"><span></span><span></span></div>').join('');
  card.querySelectorAll('.side-row').forEach((row, i) => { row.children[0].textContent = rows[i][0]; row.children[1].textContent = rows[i][1]; });
  return card;
}

function syncSidePanel() {
  for (const item of sideItems) {
    if (!item.owner.isConnected || !viewerEl.contains(item.owner)) { item.el.remove(); sideItems.delete(item); }
  }
  for (const owner of viewerEl.children) {
    for (const sel of SIDE_SELECTORS) {
      for (const el of owner.querySelectorAll(sel)) {
        sidePanel.appendChild(el);
        sideItems.add({ el, owner });
      }
    }
    const group = owner.matches('.file-group') ? owner : owner.querySelector('.file-group');
    if (group && !artCards.has(group)) {
      artCards.add(group);
      const el = artDetailsCard(group);
      sidePanel.appendChild(el);
      sideItems.add({ el, owner });
    }
  }
  sidePanel.classList.toggle('is-empty', sideItems.size === 0);
  sweepContextTools();
}

new MutationObserver(syncSidePanel).observe(viewerEl, { childList: true, subtree: true });

// Staggered entrance of the tool buttons when the left bar turns into the tool strip.
new MutationObserver(() => {
  [...toolRail.querySelectorAll('.sec-tool, .sec-tool-sep')].forEach((el, i) => el.style.setProperty('--i', i));
}).observe(toolRail, { childList: true, subtree: true });

export function searchPlaceholderFor(mode) {
  const ext = MODE_EXT[mode] || 'ART';
  if (mode === 'pro') return 'Search .PRO name, description, type…';
  if (mode === 'art') return 'Search .ART name or description…';
  if (mode === 'dlg' || mode === 'mes') return `Search .${ext} name or text…`;
  if (mode === 'scr') return 'Search .SCR name or description…';
  return `Search .${ext} files by name…`;
}

// Point the right bar's search box at the category being browsed.
export function applySearchUi(mode = explorerMode) {
  const text = searchPlaceholderFor(mode);
  searchInputEl.placeholder = text;
  searchInputEl.setAttribute('aria-label', text);
}

function syncChrome() {
  const home = isHome();
  document.body.dataset.mode = home ? 'home' : explorerMode;
  for (const tab of tabs) {
    const on = !home && tab.id === `${explorerMode}ExploreBtn`;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-pressed', String(on));
  }
  if (treeTitle) treeTitle.textContent = `.${MODE_EXT[explorerMode] || 'ART'} files`;
  if (!home) applySearchUi();
  window.dispatchEvent(new Event('resize'));
}

document.addEventListener('explorermodechange', () => {
  sweepContextTools(true);
  syncChrome();
});
new MutationObserver(syncChrome).observe(document.body, { attributes: true, attributeFilter: ['class'] });
document.body.classList.add('home-active');
syncChrome();

// The bars take this long (see shell.css) to move between the browse and the editor layout;
// a viewer that measures the centre pane (zoom, fit…) waits for them first.
export const SHELL_TRANSITION_MS = 460;
export const layoutSettled = () => new Promise(resolve => setTimeout(resolve, SHELL_TRANSITION_MS));

// The side bars change width with a transition: let canvases that listen to window size catch up.
for (const id of ['sideLeft', 'sideRight']) {
  document.getElementById(id)?.addEventListener('transitionend', e => {
    if (e.propertyName === 'width') window.dispatchEvent(new Event('resize'));
  });
}
