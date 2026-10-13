// Lazy thumbnails for .ART cards.

import { parseArtBuffer } from './art-decoder.js';
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

async function loadArtPreview(relativePath, filename) {
  const prefix = relativePath ? `${relativePath}/` : '';
  const url = `${ART_ROOT}${encPath(prefix)}${encPath(filename)}`;
  if (artPreviewCache.has(url)) return artPreviewCache.get(url);

  const previewPromise = (async () => {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const frames = await parseArtBuffer(await response.arrayBuffer(), 1);
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
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return blob ? URL.createObjectURL(blob) : null;
  })().catch(() => null);
  artPreviewCache.set(url, previewPromise);
  return previewPromise;
}

export function attachArtPreview(container, relativePath, filename) {
  const image = document.createElement('img');
  image.alt = '';
  image.loading = 'lazy';
  container.appendChild(image);
  deferArtPreview(container, async () => {
    const url = await loadArtPreview(relativePath, filename);
    if (!container.isConnected) return;
    if (url) {
      image.src = url;
    } else {
      container.classList.add('missing');
      container.textContent = '🖼';
    }
  });
}
