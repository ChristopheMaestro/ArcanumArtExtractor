// Lazy thumbnails for .ART cards: a cell of a pre-made sheet (art-thumb-sheets.js) when the grid has one,
// otherwise the first frame of the .art file itself.

import { parseArtBuffer } from './art-decoder.js';
import { loadSheet, sheetCellCanvas, sheetCellForFile } from './art-thumb-sheets.js';
import { ART_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';

const artPreviewCache = new Map();
const pendingPreviewLoaders = new WeakMap();
const artPreviewObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      artPreviewObserver.unobserve(entry.target);
      const load = pendingPreviewLoaders.get(entry.target);
      pendingPreviewLoaders.delete(entry.target);
      if (load) load();
    }
  }, { rootMargin: '240px' })
  : null;

export function deferArtPreview(element, load) {
  pendingPreviewLoaders.set(element, load);
  if (artPreviewObserver) artPreviewObserver.observe(element);
  else load();
}

// The thumbnail of an .art file: its first frame, fitted (never enlarged) and centred in a 96 px square.
// toolbox/build_art_thumbs.py draws the sheets with this function, so both give the same pixels.
export async function renderArtThumb(buf) {
  const frames = await parseArtBuffer(buf, 1);
  const frame = frames[0];
  if (!frame) return null;

  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const scale = Math.min(1, size / frame.width, size / frame.height);
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  canvas.getContext('2d').drawImage(frame.canvas, (size - width) / 2, (size - height) / 2, width, height);
  return canvas;
}

async function loadArtPreview(relativePath, filename) {
  const prefix = relativePath ? `${relativePath}/` : '';
  const url = `${ART_ROOT}${encPath(prefix)}${encPath(filename)}`;
  if (artPreviewCache.has(url)) return artPreviewCache.get(url);

  const previewPromise = (async () => {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const canvas = await renderArtThumb(await response.arrayBuffer());
    if (!canvas) return null;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return blob ? URL.createObjectURL(blob) : null;
  })().catch(() => null);
  artPreviewCache.set(url, previewPromise);
  return previewPromise;
}

function showMissing(container) {
  container.classList.add('missing');
  container.textContent = '🖼';
}

// `folderFiles`: the folder grid's list of .art files, which picks the sheet; null (search results, which
// come from many folders) loads the file itself.
export function attachArtPreview(container, relativePath, filename, folderFiles = null) {
  const image = document.createElement('img');
  image.alt = '';
  image.loading = 'lazy';
  container.appendChild(image);
  deferArtPreview(container, async () => {
    const cell = folderFiles ? await sheetCellForFile(relativePath, filename, folderFiles) : null;
    if (cell?.missing) { if (container.isConnected) showMissing(container); return; }
    const sheet = cell ? await loadSheet(cell.url) : null;
    if (sheet) {
      if (container.isConnected) image.replaceWith(sheetCellCanvas(sheet, cell));
      return;
    }
    const url = await loadArtPreview(relativePath, filename);
    if (!container.isConnected) return;
    if (url) {
      image.src = url;
    } else {
      showMissing(container);
    }
  });
}
