// Pre-made thumbnail sheets for the .ART grid (art-thumbs/, written by toolbox/build_art_thumbs.py).
// Online, one sheet of 50 thumbnails is one request where the .art files are 50 (several MB for critters).
//
//   art-thumbs/index.json        what the sheets hold (below)
//   art-thumbs/<folder>/<k>.webp the folder's .art files k*50 .. k*50+49 (sheetOrder), 10 per row
//   art-thumbs/<folder>/folders.webp   the 4-picture previews of the folder's sub-folder cards
//
// index.json: { cell, cols, perSheet,
//   folders: { "<folder>": { count, hash, missing: [index of a file with no picture] } },
//   previews: { "<folder>": { rows, cards: { "<sub-folder path>": [cell or null (no picture)] } } } }
// A folder whose file list no longer matches its hash (files added, renamed or removed) gets no sheet: its
// thumbnails come from the .art files, as without sheets.

import { ART_THUMBS_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';

let indexPromise = null;
export function loadThumbIndex() {
  if (!indexPromise) {
    indexPromise = fetch(`${ART_THUMBS_ROOT}index.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return indexPromise;
}

// The order of the files in the sheets: English collation, whatever the browser's language (a Turkish or
// Filipino browser sorts some names differently, and would otherwise never match the sheets).
const sheetCollator = new Intl.Collator('en');
export const sheetOrder = names => [...names].sort(sheetCollator.compare);

// FNV-1a of the names in sheet order: the sheets are only used for the exact list they were made from.
export function fileListHash(names) {
  let h = 0x811c9dc5;
  const s = names.join('\n');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const folderUrl = rel => `${ART_THUMBS_ROOT}${rel ? `${encPath(rel)}/` : ''}`;

// name -> position, per sorted file list of the grid (null: no usable sheet for it)
const positions = new WeakMap();

// The sheet cell of one file of a folder grid, or null. `folderFiles` is the grid's list of the folder's .art files.
export async function sheetCellForFile(relPath, filename, folderFiles) {
  const index = await loadThumbIndex();
  const entry = index?.folders?.[relPath || ''];
  if (!entry) return null;
  if (!positions.has(folderFiles)) {
    const files = sheetOrder(folderFiles);
    const ok = entry.count === files.length && entry.hash === fileListHash(files);
    positions.set(folderFiles, ok ? new Map(files.map((f, i) => [f, i])) : null);
  }
  const i = positions.get(folderFiles)?.get(filename);
  if (i === undefined) return null;
  const { cols, perSheet } = index;
  const k = Math.floor(i / perSheet), j = i % perSheet;
  return {
    url: `${folderUrl(relPath)}${k}.webp`,
    x: (j % cols) * index.cell, y: Math.floor(j / cols) * index.cell, size: index.cell,
    missing: (entry.missing || []).includes(i),
  };
}

// The cells of a sub-folder card's 4-picture preview: [] (no picture: keep the folder glyph), or up to 4 cells
// ({ missing: true } for a file without a picture), or null when there is no sheet for it.
export async function folderPreviewCells(parentRelPath, childRelPath) {
  const index = await loadThumbIndex();
  const preview = index?.previews?.[parentRelPath || ''];
  const cells = preview?.cards?.[childRelPath];
  if (!cells) return null;
  const url = `${folderUrl(parentRelPath)}folders.webp`;
  return cells.map(c => (c === null ? { missing: true } : {
    url, x: (c % index.cols) * index.cell, y: Math.floor(c / index.cols) * index.cell, size: index.cell, missing: false,
  }));
}

// A sheet, decoded once (null if it can't be loaded: the caller falls back to the .art files).
const sheets = new Map();
export function loadSheet(url) {
  if (!sheets.has(url)) {
    const img = new Image();
    img.src = url;
    const p = img.decode().then(() => img, () => null);
    sheets.set(url, p);
    p.then(r => { if (!r) sheets.delete(url); });
  }
  return sheets.get(url);
}

// One cell as a canvas, the same pixels as the thumbnail art-preview.js draws from the .art file.
export function sheetCellCanvas(sheet, cell) {
  const canvas = document.createElement('canvas');
  canvas.className = 'art-sheet-cell';
  canvas.width = canvas.height = cell.size;
  canvas.getContext('2d').drawImage(sheet, cell.x, cell.y, cell.size, cell.size, 0, 0, cell.size, cell.size);
  return canvas;
}
