// Lazy sector loading placeholders.

import { secIsoProject, secIsoUnproject } from './sec-iso.js';
import { secTileInfo } from './sec-tile-art.js';

// A sector whose 4096 tiles are all blank (raw 0 or the BLK tile) has nothing to
// draw, so it is detected up front and never shown. Every other sector starts as a
// light-blue placeholder carrying its name; clicking it loads its tile art.
const SEC_PLACEHOLDER_FILL = '#a9d8ff', SEC_PLACEHOLDER_EDGE = '#5aa9e6', SEC_PLACEHOLDER_TEXT = '#0b2f52';
export const secSectorKey = s => `${s.position.x},${s.position.y}`;
export function secDetectBlankSectors(sectors) {
  const blankRaw = new Map();   // raw tile value -> is blank? (names are looked up once per unique value)
  const isBlankRaw = raw => {
    if (raw === 0) return true;
    let b = blankRaw.get(raw);
    if (b === undefined) { b = String(secTileInfo(raw)?.name || '').trim().toUpperCase() === 'BLK'; blankRaw.set(raw, b); }
    return b;
  };
  const blank = new Set();
  for (const s of sectors) {
    const tiles = s.decoded?.tiles;
    if (!tiles) continue;
    let all = true;
    for (let i = 0; i < tiles.length; i++) if (!isBlankRaw(tiles[i] >>> 0)) { all = false; break; }
    if (all) blank.add(secSectorKey(s));
  }
  return blank;
}
// Corners of a sector's footprint in unzoomed iso space (a square in world space,
// so a diamond on screen). Same tile origin as drawSecActualTiles.
function secSectorDiamond(sector, bounds, iso) {
  const bx = (sector.position.x - bounds.minX) * 64, by = (sector.position.y - bounds.minY) * 64;
  return [
    secIsoProject(bx - .5, by - .5, iso), secIsoProject(bx + 63.5, by - .5, iso),
    secIsoProject(bx + 63.5, by + 63.5, iso), secIsoProject(bx - .5, by + 63.5, iso)
  ];
}
export function secSectorLabel(sector) { return String(sector.filename || secSectorKey(sector)).replace(/\.sec$/i, ''); }

// Sectors the map has no .sec for are generated from data/terrain (see sec-terrain.js). They get
// their own placeholder colour and, like the others, are only loaded when clicked. There are far
// too many to draw at once (2000 x 2000), so only those in the viewport are drawn, and none
// while more than SEC_TERRAIN_MAX_CELLS would be visible.
const SEC_TERRAIN_FILL = '#e8d9a0', SEC_TERRAIN_EDGE = '#b79a3a', SEC_TERRAIN_TEXT = '#4a3a05';
export const SEC_TERRAIN_MAX_CELLS = 3000;
export function secVisibleSectorRange(view, bounds, iso, cssW, cssH) {
  const zoom = view.zoom, ox = view.offsetX, oy = view.offsetY;
  const corners = [[0, 0], [cssW, 0], [0, cssH], [cssW, cssH]].map(([x, y]) => secIsoUnproject((x - ox) / zoom, (y - oy) / zoom, iso));
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  return {
    x0: Math.max(bounds.minX, bounds.minX + Math.floor(Math.min(...xs) / 64) - 1), x1: Math.min(bounds.maxX, bounds.minX + Math.floor(Math.max(...xs) / 64) + 1),
    y0: Math.max(bounds.minY, bounds.minY + Math.floor(Math.min(...ys) / 64) - 1), y1: Math.min(bounds.maxY, bounds.minY + Math.floor(Math.max(...ys) / 64) + 1)
  };
}
// The sectors whose diamond touches the viewport (isometric view).
export function secSectorsInView(sectors, bounds, iso, view, cssW, cssH) {
  const zoom = view.zoom, ox = view.offsetX, oy = view.offsetY;
  return sectors.filter(sector => {
    const pts = secSectorDiamond(sector, bounds, iso);
    const xs = pts.map(p => p.x * zoom + ox), ys = pts.map(p => p.y * zoom + oy);
    return Math.max(...xs) >= 0 && Math.min(...xs) <= cssW && Math.max(...ys) >= 0 && Math.min(...ys) <= cssH;
  });
}
// One pixel of Map.png (the game's Map.bmp) per sector (same placement as the background drawn in sec-folder-map.js):
// column = width - 1 - sectorX, row = sectorY. Read once into an ImageData.
function secMapBmpColor(view, mapBackground, x, y) {
  if (!mapBackground?.complete || !mapBackground.naturalWidth) return null;
  if (view.mapBmpPixels?.src !== mapBackground) {
    try {
      const c = document.createElement('canvas'); c.width = mapBackground.naturalWidth; c.height = mapBackground.naturalHeight;
      const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(mapBackground, 0, 0);
      view.mapBmpPixels = { src: mapBackground, w: c.width, h: c.height, data: cx.getImageData(0, 0, c.width, c.height).data };
    } catch (_) { view.mapBmpPixels = { src: mapBackground, w: 0, h: 0, data: null }; }
  }
  const p = view.mapBmpPixels, col = p.w - 1 - x;
  if (!p.data || col < 0 || col >= p.w || y < 0 || y >= p.h) return null;
  const i = (y * p.w + col) * 4;
  return `rgb(${p.data[i]},${p.data[i + 1]},${p.data[i + 2]})`;
}
export function drawSecTerrainPlaceholders(ctx, bounds, iso, view, cssW, cssH, mapBackground) {
  const terrain = view.terrain;
  view.terrainHidden = false;
  if (!terrain?.map) return;
  const zoom = view.zoom, ox = view.offsetX, oy = view.offsetY;
  const r = secVisibleSectorRange(view, bounds, iso, cssW, cssH);
  if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > SEC_TERRAIN_MAX_CELLS) { view.terrainHidden = true; return; }
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    const key = `${x},${y}`;
    if (view.sectorMap?.has(key) || view.loadedSectors?.has(key)) continue;
    const pts = secSectorDiamond({ position: { x, y } }, bounds, iso).map(p => ({ x: p.x * zoom + ox, y: p.y * zoom + oy }));
    const minPX = Math.min(...pts.map(p => p.x)), maxPX = Math.max(...pts.map(p => p.x));
    const minPY = Math.min(...pts.map(p => p.y)), maxPY = Math.max(...pts.map(p => p.y));
    if (maxPX < 0 || minPX > cssW || maxPY < 0 || minPY > cssH) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    // Plain Map.png colour (no outline, no name): the sector simply reads as part of the map.
    const bmp = secMapBmpColor(view, mapBackground, x, y);
    ctx.fillStyle = bmp || SEC_TERRAIN_FILL; ctx.fill();
    if (!bmp) { ctx.strokeStyle = SEC_TERRAIN_EDGE; ctx.lineWidth = 1; ctx.stroke(); }
    if (terrain.loading.has(key) && maxPX - minPX >= 36) {
      const size = Math.max(9, Math.min(26, (maxPX - minPX) / 11));
      ctx.fillStyle = SEC_TERRAIN_TEXT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `500 ${size}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.fillText('loading…', (minPX + maxPX) / 2, (minPY + maxPY) / 2);
    }
  }
}
export function drawSecPlaceholders(ctx, sectors, bounds, iso, view, cssW, cssH) {
  const zoom = view.zoom, ox = view.offsetX, oy = view.offsetY;
  for (const sector of sectors) {
    if (!sector?.decoded || !sector.position) continue;
    const key = secSectorKey(sector);
    if (view.blankSectors?.has(key) || view.loadedSectors?.has(key)) continue;
    const pts = secSectorDiamond(sector, bounds, iso).map(p => ({ x: p.x * zoom + ox, y: p.y * zoom + oy }));
    const minPX = Math.min(...pts.map(p => p.x)), maxPX = Math.max(...pts.map(p => p.x));
    const minPY = Math.min(...pts.map(p => p.y)), maxPY = Math.max(...pts.map(p => p.y));
    if (maxPX < 0 || minPX > cssW || maxPY < 0 || minPY > cssH) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = SEC_PLACEHOLDER_FILL; ctx.fill();
    ctx.strokeStyle = SEC_PLACEHOLDER_EDGE; ctx.lineWidth = 1; ctx.stroke();
    const width = maxPX - minPX;
    if (width < 36) continue;
    const cx = (minPX + maxPX) / 2, cy = (minPY + maxPY) / 2;
    const size = Math.max(9, Math.min(26, width / 11));
    ctx.fillStyle = SEC_PLACEHOLDER_TEXT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    const loading = view.loadingSectors?.has(key);
    ctx.fillText(secSectorLabel(sector), cx, loading ? cy - size * .7 : cy);
    if (loading) { ctx.font = `500 ${Math.max(8, size * .8)}px ui-monospace, Menlo, Consolas, monospace`; ctx.fillText('loading…', cx, cy + size * .7); }
  }
}
