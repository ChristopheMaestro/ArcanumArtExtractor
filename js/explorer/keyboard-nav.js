// Keyboard navigation of the left tree, in every category, like a file explorer:
//   ↑ / ↓      move the cursor over the visible folders and files; landing on a file opens it
//   → / ←      on a folder: unroll / roll it; → on an unrolled folder goes to its first entry,
//              ← on a file or a rolled folder goes up to the parent folder
//   Enter      open the folder under the cursor
// It works whether or not a file is open. With an ART file open (ART files are the cards of the
// folder grid, not tree rows) ↑ / ↓ go to the previous / next card instead. Shift + ← / → still
// page through a long ART folder.
// The .PRO viewer keeps its own ↑ / ↓ while a file is open (it also follows the type filter).

import { gridEl, treeEl, viewerEl } from '../core/dom.js';
import { explorerMode } from '../core/state.js';

let activeCard = null;
let cursor = null;

const isFileRow = r => r.classList.contains('mob-file-row') && !!r.querySelector('.tree-name');
const visibleRows = () => Array.from(treeEl.querySelectorAll('.tree-row, .mob-file-row'))
  .filter(r => (r.classList.contains('tree-row') || isFileRow(r)) && r.offsetParent !== null);

function setCursor(row) {
  cursor?.classList.remove('kb-cursor');
  cursor = row;
  if (!row) return;
  row.classList.add('kb-cursor');
  row.scrollIntoView({ block: 'nearest' });
}

gridEl.addEventListener('click', (e) => {
  const card = e.target.closest('.explorer-item');
  if (card) activeCard = card;
});

treeEl.addEventListener('click', (e) => {
  const row = e.target.closest('.tree-row, .mob-file-row');
  if (!row) return;
  if (isFileRow(row)) {
    treeEl.querySelectorAll('.mob-file-row.active').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
  }
  setCursor(row);
});

// The ART card of the file that is open: the last one clicked, or (deep link, restored session)
// the one whose file name appears in the viewer.
function currentCard(cards) {
  if (activeCard && cards.includes(activeCard)) return activeCard;
  const lines = new Set(viewerEl.innerText.split('\n').map(s => s.trim()));
  return cards.find(c => lines.has(c.querySelector('.explorer-filename')?.textContent)) || null;
}

function startRow(rows) {
  if (cursor && rows.includes(cursor)) return cursor;
  return rows.find(r => r.classList.contains('active')) || null;
}

function parentRow(row, rows) {
  const holder = row.closest('.tree-children');
  const parent = holder?.parentElement?.querySelector(':scope > .tree-row');
  return parent && rows.includes(parent) ? parent : null;
}

function onKey(e) {
  const k = e.key;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(k)) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const body = document.body.classList;
  if (body.contains('home-active') || body.contains('sec-edit-full')) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' && k === 'Enter' || e.target?.isContentEditable) return;
  if (document.querySelector('.modal-overlay.open, #hexOverlay.open')) return;
  const viewerOpen = !viewerEl.hidden;
  const up = k === 'ArrowUp', down = k === 'ArrowDown';

  if ((up || down) && viewerOpen && explorerMode === 'art') {
    const cards = Array.from(gridEl.querySelectorAll('.explorer-item'));
    const cur = currentCard(cards);
    const next = cur ? cards[cards.indexOf(cur) + (up ? -1 : 1)] : null;
    if (next) { e.preventDefault(); next.click(); }
    return;
  }
  if ((up || down) && viewerOpen && explorerMode === 'pro') return;   // the .PRO viewer's own handler

  const rows = visibleRows();
  if (!rows.length) return;
  let row = startRow(rows);
  if (!row) { e.preventDefault(); setCursor(rows[0]); return; }
  const i = rows.indexOf(row);
  const folder = row.classList.contains('tree-row');
  e.preventDefault();
  if (up || down) {
    const next = rows[i + (up ? -1 : 1)];
    if (!next) return;
    setCursor(next);
    if (isFileRow(next)) next.click();
  } else if (k === 'ArrowRight') {
    if (!folder) return;
    if (row.nextElementSibling?.classList.contains('open')) { if (rows[i + 1]) setCursor(rows[i + 1]); }
    else row.dispatchEvent(new CustomEvent('tree-expand'));
  } else if (k === 'ArrowLeft') {
    if (folder && row.nextElementSibling?.classList.contains('open')) row.dispatchEvent(new CustomEvent('tree-collapse'));
    else { const p = parentRow(row, rows); if (p) setCursor(p); }
  } else if (k === 'Enter') {
    row.click();
  }
}

document.addEventListener('keydown', onKey);
