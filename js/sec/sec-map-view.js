// Shared by the .SEC folder map: tile drawing, sector loading and the loading card.

import { errText, fetchBuffer, memoAsync } from '../core/text-io.js';

import { DATA_ROOT, SEC_ROOT } from '../core/config.js';

import { encPath } from '../core/util.js';
import { SEC_ISO_HALF_H, SEC_ISO_HALF_W, SEC_ISO_TILE_H, SEC_ISO_TILE_W, secIsoMetrics } from './sec-iso.js';
import { readSecTileData } from './sec-parser.js';

import { secSectorAllZero } from './sec-tile-art.js';

// Map viewer background (plain black).
export const SEC_MAP_BACKGROUND = '#000000';
// renderOpts (export): { full: true, cssW, cssH, dpr } draws the whole sector at
// 100% zoom (1 source pixel per screen pixel) instead of fitting the display.

export function drawSecActualTiles(ctx, sectors, bounds, artTiles, view) {
  const iso = secIsoMetrics(bounds);
  const zoom = Math.max(0.01, Math.min(32, Number(view?.zoom) || 1));
  const ox = Number(view?.offsetX) || 0;
  const oy = Number(view?.offsetY) || 0;
  // Use the context's own scale (set by the caller) rather than the window's
  // devicePixelRatio, so off-screen exports rendered at dpr 1 are not clipped.
  const dpr = (ctx.getTransform && ctx.getTransform().a) || window.devicePixelRatio || 1;
  const cssW = ctx.canvas.width / dpr;
  const cssH = ctx.canvas.height / dpr;

  for (const sector of sectors || []) {
    if (!sector?.decoded || !sector.position) continue;
    const baseX = (sector.position.x - bounds.minX) * 64;
    const baseY = (sector.position.y - bounds.minY) * 64;
    // Skip sectors that are entirely off screen. Now that edge tiles resolve,
    // nearly every tile has art, so walking all 4096 tiles of every loaded
    // sector on each redraw got noticeably slower. Bounding box = the four
    // sector corners, padded for oversized edge art.
    {
      const PAD = 160;
      // (the corners' extremes: x is smallest at tile (63, 0) and largest at (0, 63); y at (0, 0) and (63, 63))
      const minSX = iso.originX + ((baseY + 0) - (baseX + 63)) * SEC_ISO_HALF_W - PAD, maxSX = iso.originX + ((baseY + 63) - (baseX + 0)) * SEC_ISO_HALF_W + PAD;
      const minSY = iso.originY + ((baseX + 0) + (baseY + 0)) * SEC_ISO_HALF_H - PAD, maxSY = iso.originY + ((baseX + 63) + (baseY + 63)) * SEC_ISO_HALF_H + PAD;
      if (maxSX * zoom + ox < 0 || minSX * zoom + ox > cssW || maxSY * zoom + oy < 0 || minSY * zoom + oy > cssH) continue;
    }
    const tilesArr = sector.decoded.tiles;
    const sectorAllZero = secSectorAllZero(sector.decoded);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const raw = tilesArr[y * 64 + x] >>> 0;
      if (raw === 0 && sectorAllZero) continue;
      const art = artTiles?.get(raw);
      if (!art?.canvas) continue;
      // inline secIsoProject (no per-tile object allocation)
      const centerX = iso.originX + ((baseY + y) - (baseX + x)) * SEC_ISO_HALF_W;
      const centerY = iso.originY + ((baseX + x) + (baseY + y)) * SEC_ISO_HALF_H;
      // Draw the ART frame at its own native size, centred on the tile.
      // Edge/transition tiles are not guaranteed to be the same size as a
      // plain 78x40 floor tile; forcing them into 78x40 squashed or clipped
      // their blended borders.
      const artW = art.canvas.width || SEC_ISO_TILE_W;
      const artH = art.canvas.height || SEC_ISO_TILE_H;
      const left = centerX - artW / 2;
      const right = centerX + artW / 2;
      const top = centerY - artH / 2;
      const bottom = centerY + artH / 2;
      if (right * zoom + ox < 0 || left * zoom + ox > cssW || bottom * zoom + oy < 0 || top * zoom + oy > cssH) continue;
      const dw = artW * zoom;
      const dh = artH * zoom;
      const px = centerX * zoom + ox;
      const py = centerY * zoom + oy;
      ctx.drawImage(art.canvas, px - dw / 2, py - dh / 2, dw, dh);
    }
  }
}

function parseSecSectorPosition(filename) {
  const stem = String(filename || '').replace(/\.sec$/i, '').trim();
  if (!/^\d+$/.test(stem)) return null;
  try {
    const id = BigInt(stem);
    const mask = (1n << 26n) - 1n;
    return { id, x: Number(id & mask), y: Number((id >> 26n) & mask) };
  } catch (_) { return null; }
}

// A .sec stored once: its copies were moved away (toolbox/atlas/dedupe_sectors.py) and data/sec-aliases.tsv names the copy kept
// ("moved path <tab> kept path", both under data/). Read on the first sector that is not there, so a folder without any costs nothing.
const secAliases = memoAsync(async () => {
  try { return new Map(new TextDecoder().decode(await fetchBuffer(`${DATA_ROOT}sec-aliases.tsv`)).split('\n').filter(Boolean).map(l => l.trimEnd().split('\t'))); }
  catch (_) { return new Map(); }
});
async function fetchSec(rel) {           // rel: under data/
  const resp = await fetch(`${SEC_ROOT}${encPath(rel)}`);
  if (resp.status !== 404) return resp;
  const kept = (await secAliases()).get(rel);
  return kept ? fetch(`${DATA_ROOT}${encPath(kept)}`) : resp;
}

export async function loadSecFolderSectors(relativePath, filenames, onProgress) {
  const results = [];
  const queue = filenames.map((filename, index) => ({ filename, index }));
  // online every sector is a round trip of its own: measured on GitHub Pages (HTTP/2), 621 sectors take ~13 s at 16
  // at a time, ~6 s at 32, no better at 64. A local server (HTTP/1.1, 6 connections) is not slowed by the extra ones.
  const workerCount = Math.min(32, Math.max(1, queue.length));
  let completed = 0;

  const loadOne = async item => {
    // A name may carry a sub-folder ('Stillwater/123.sec', see loadSecManifest); the sector itself
    // is known by its bare file name.
    const { filename: path, index } = item;
    const filename = path.split('/').pop(), dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const position = parseSecSectorPosition(filename);
    let result;
    if (!position) {
      result = { filename, dir, index, position: null, decoded: null, error: 'filename does not contain a numeric sector ID' };
    } else {
      try {
        const prefix = relativePath ? `${relativePath}/` : '';
        const resp = await fetchSec(`${prefix}${path}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        result = { filename, dir, index, position, decoded: readSecTileData(await resp.arrayBuffer(), filename), error: null };
      } catch (err) {
        result = { filename, dir, index, position, decoded: null, error: errText(err) };
      }
    }
    results[index] = result;
    completed++;
    if (typeof onProgress === 'function') onProgress(completed, filenames.length, result);
  };

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const item = queue[next++];
      await loadOne(item);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.filter(item => item && item.position);
}

// Shown in the place of the loading card for a map with many sectors: the map loads only when the user says so.
export function renderSecLargeConfirm(folderName, total, onLoad) {
  const article = document.createElement('article');
  article.className = 'sec-viewer sec-folder-loading';
  article.innerHTML = `
      <div class="sec-viewer-head"><div>
        <h2 class="sec-viewer-title"></h2>
        <div class="sec-viewer-meta">This map is not loaded yet.</div>
      </div></div>
      <section class="sec-map-card sec-loading-card">
        <div class="sec-loading-title">This map has ${total} sectors.</div>
        <div class="sec-loading-sector">Loading it can take a while. Do you want to load it?</div>
        <button type="button" class="sec-large-load">Load map</button>
      </section>`;
  article.querySelector('.sec-viewer-title').textContent = `Map · ${folderName}`;
  article.querySelector('.sec-large-load').addEventListener('click', onLoad, { once: true });
  return article;
}

export function renderSecFolderLoading(folderName, total) {
  const article = document.createElement('article');
  article.className = 'sec-viewer sec-folder-loading';
  article.innerHTML = `
      <div class="sec-viewer-head"><div>
        <h2 class="sec-viewer-title"></h2>
        <div class="sec-viewer-meta">Reading all SEC sectors in this folder…</div>
      </div></div>
      <section class="sec-map-card sec-loading-card">
        <div class="sec-loading-title">Loading map…</div>
        <div class="sec-loading-sector">Preparing sector 1 / ${total}</div>
        <div class="sec-loading-track"><div class="sec-loading-fill"></div></div>
        <div class="sec-loading-percent">0%</div>
      </section>`;
  article.querySelector('.sec-viewer-title').textContent = `Map · ${folderName}`;
  const sectorEl = article.querySelector('.sec-loading-sector');
  const fillEl = article.querySelector('.sec-loading-fill');
  const percentEl = article.querySelector('.sec-loading-percent');
  return { article, update(done, count, result) {
    const pct = count ? Math.round(done * 100 / count) : 100;
    const pos = result?.position;
    const label = pos ? `Sector ${pos.x}, ${pos.y}` : result?.filename || 'Unknown sector';
    sectorEl.textContent = `${label} · ${done} / ${count}${result?.error ? ` · ${result.error}` : ''}`;
    fillEl.style.width = `${pct}%`;
    percentEl.textContent = `${pct}%`;
  }};
}
