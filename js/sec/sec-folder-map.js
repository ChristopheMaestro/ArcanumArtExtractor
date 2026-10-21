// Folder-wide SEC map drawing.

import { drawSecLodSectors, SEC_LOD_ZOOM } from './sec-lod.js';
import { SEC_ISO_HALF_H, SEC_ISO_HALF_W, secIsoMetrics, secIsoProject } from './sec-iso.js';
import { secDrawLightMask, secMakeLighting, secPrepareLightModel, secTintLayer } from './sec-lighting.js';
import { drawSecActualTiles, SEC_MAP_BACKGROUND } from './sec-map-view.js';
import { drawSecMobOverlay, secObjectAnim, secPoseOf } from './sec-mob-overlay.js';
import { drawSecPlaceholders, drawSecTerrainPlaceholders, secSectorKey, secVisibleSectorRange } from './sec-placeholders.js';
import { drawSecRoofs } from './sec-roofs.js';
import { secTileColor, secTileInfo } from './sec-tile-art.js';
import { drawSecWallOverlay, secMergeMovers, secSortObjectsLikeGame } from './sec-walls.js';

// renderOpts (export): { cssW, cssH, dpr } renders to an explicit size instead of
// the on-screen canvas size.
// Lighting is only paused during pan/zoom when lit frames have been measured slower than this
// (milliseconds; see redrawNow in the viewer). On a machine that keeps up it never pauses.
const LIGHT_PAUSE_FRAME_MS = 30;

export function drawSecFolderMap(canvas, sectors, bounds, selected, mode, artTiles, view, mobPoints = [], mapBackground = null, overlayVisibility = {}, renderOpts = null) {
  const sectorCols = bounds.maxX - bounds.minX + 1;
  const sectorRows = bounds.maxY - bounds.minY + 1;
  const mapW = sectorCols * 64;
  const mapH = sectorRows * 64;
  const iso = secIsoMetrics(bounds);
  const dpr = renderOpts?.dpr ?? (window.devicePixelRatio || 1);
  const cssW = renderOpts?.cssW ?? Math.max(320, Math.floor(canvas.clientWidth || 760));
  const cssH = renderOpts?.cssH ?? Math.max(260, Math.floor(canvas.clientHeight || 620));
  // Assigning canvas.width/height reallocates the backing store, so only do it when the size
  // really changed; otherwise reset the context (same effect: default state, cleared bitmap).
  const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  else if (ctx.reset) ctx.reset();
  else canvas.width = bw;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = SEC_MAP_BACKGROUND; ctx.fillRect(0, 0, cssW, cssH);

  const zoom = Math.max(0.001, Math.min(32, view.zoom));
  const ox = view.offsetX, oy = view.offsetY;
  const sectorMap = view.sectorMap || new Map(sectors.map(s => [`${s.position.x},${s.position.y}`, s]));
  // The sectors that can show anything in the viewport (a sector of margin for overhanging objects
  // and roofs). Everything below only walks these, so a frame costs what is on screen, not the map.
  const range = mode === 'art'
    ? secVisibleSectorRange({ zoom, offsetX: ox, offsetY: oy }, bounds, iso, cssW, cssH)
    : {
      x0: Math.max(bounds.minX, bounds.maxX - Math.floor(((cssW - ox) / zoom) / 64) - 1), x1: Math.min(bounds.maxX, bounds.maxX - Math.floor((-ox / zoom) / 64) + 1),
      y0: Math.max(bounds.minY, bounds.minY + Math.floor((-oy / zoom) / 64) - 1), y1: Math.min(bounds.maxY, bounds.minY + Math.floor(((cssH - oy) / zoom) / 64) + 1)
    };
  const near = list => list.filter(s => s.position && s.position.x >= range.x0 && s.position.x <= range.x1 && s.position.y >= range.y0 && s.position.y <= range.y1);

  // Map.png (the game's Map.bmp) is a sector-level image (one source pixel per 64x64 sector).
  // Draw it in grayscale first; SEC tiles and MOBs are drawn over it.
  if (mapBackground && mapBackground.complete && mapBackground.naturalWidth) {
    const bgLeft = (bounds.maxX - mapBackground.naturalWidth + 1) * 64;
    const bgTop = -bounds.minY * 64;
    const bgW = mapBackground.naturalWidth * 64;
    const bgH = mapBackground.naturalHeight * 64;
    ctx.save();
    ctx.globalAlpha = 0.72;
    if (mode === 'art') {
      // Isometric view: the picture is the sector grid, so it is drawn through the same tile -> screen
      // transform as the sectors (pixel column c is sector x = width - 1 - c, row r is sector y = r).
      const w = mapBackground.naturalWidth;
      const L0 = (w - bounds.minX) * 64 - .5, T0 = -bounds.minY * 64 - .5;
      const k = zoom * 64;
      ctx.imageSmoothingEnabled = k * SEC_ISO_HALF_W < 2;   // far out, a pixel is under 2 px wide: smooth it
      ctx.transform(k * SEC_ISO_HALF_W, -k * SEC_ISO_HALF_H, k * SEC_ISO_HALF_W, k * SEC_ISO_HALF_H,
        zoom * (iso.originX + (T0 - L0) * SEC_ISO_HALF_W) + ox, zoom * (iso.originY + (L0 + T0) * SEC_ISO_HALF_H) + oy);
      ctx.drawImage(mapBackground, 0, 0);
    } else {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mapBackground, bgLeft * zoom + ox, bgTop * zoom + oy, bgW * zoom, bgH * zoom);
    }
    ctx.restore();
  }

  let lighting = null;
  // In isometric mode only objects standing in loaded sectors are drawn (and lit).
  let loadedMobsMemo = null;
  const loadedMobs = () => loadedMobsMemo || (loadedMobsMemo = (mode === 'art' && view.loadedSectors)
    ? mobPoints.filter(m => view.loadedSectors.has(`${m.sectorX},${m.sectorY}`)) : mobPoints);
  // Zoomed far out the isometric map is drawn from cached one-pixel-per-tile sector images.
  const lod = !renderOpts && mode === 'art' && zoom < SEC_LOD_ZOOM;   // never for PNG export
  view.lodPending = false;
  view.perf = { objectsDrawn: 0, objectsTotal: 0 };
  view.lastDrawLit = false;
  const drawPlaceholders = () => {
    drawSecPlaceholders(ctx, near(sectors), bounds, iso, view, cssW, cssH);
    if (!renderOpts) drawSecTerrainPlaceholders(ctx, bounds, iso, view, cssW, cssH, mapBackground);
  };
  if (mode === 'color') {
    // Keep the existing fast rectangular semantic-color representation.
    const worldLeft = Math.max(0, Math.floor((-ox) / zoom) - 1);
    const worldTop = Math.max(0, Math.floor((-oy) / zoom) - 1);
    const worldRight = Math.min(mapW - 1, Math.ceil((cssW - ox) / zoom) + 1);
    const worldBottom = Math.min(mapH - 1, Math.ceil((cssH - oy) / zoom) + 1);
    const firstSX = Math.max(bounds.minX, bounds.maxX - Math.floor(worldRight / 64));
    const lastSX = Math.min(bounds.maxX, bounds.maxX - Math.floor(worldLeft / 64));
    const firstSY = Math.max(bounds.minY, bounds.minY + Math.floor(worldTop / 64));
    const lastSY = Math.min(bounds.maxY, bounds.minY + Math.floor(worldBottom / 64));

    // tile colour by raw tile value, worked out once per value for the sector images built in this frame (not once per tile)
    const rgbOf = new Map();
    for (let sy = firstSY; sy <= lastSY; sy++) for (let sx = firstSX; sx <= lastSX; sx++) {
      const sector = sectorMap.get(`${sx},${sy}`);
      if (!sector?.decoded) continue;
      const baseX = (bounds.maxX - sx) * 64;
      const baseY = (sy - bounds.minY) * 64;
      const px0 = Math.floor(baseX * zoom + ox);
      const py0 = Math.floor(baseY * zoom + oy);
      const pw = 64 * zoom, ph = 64 * zoom;
      let cache = view.colorSectorCache.get(sector.filename);
      if (!cache) {
        cache = document.createElement('canvas'); cache.width = 64; cache.height = 64;
        const cctx = cache.getContext('2d', { alpha: false });
        const image = cctx.createImageData(64, 64);
        for (let i = 0; i < sector.decoded.tiles.length; i++) {
          const raw = sector.decoded.tiles[i] >>> 0;
          let m = rgbOf.get(raw);
          if (m === undefined) rgbOf.set(raw, m = String(secTileColor(secTileInfo(raw).artId)).match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/));
          const off = i * 4;
          if (m) { image.data[off] = +m[1]; image.data[off+1] = +m[2]; image.data[off+2] = +m[3]; }
          image.data[off+3] = 255;
        }
        cctx.putImageData(image, 0, 0);
        view.colorSectorCache.set(sector.filename, cache);
      }
      ctx.save(); ctx.translate(px0 + pw, 0); ctx.scale(-1, 1); ctx.drawImage(cache, 0, py0, pw, ph); ctx.restore();
      if (zoom >= 1.5) {
        ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
        ctx.strokeRect(px0 + .5, py0 + .5, pw - 1, ph - 1);
      }
    }
  } else {
    // Actual tile mode uses the same renderer as the individual SEC viewer.
    // This keeps orientation, 78x40 placement, blank-tile handling and
    // viewport clipping identical in both views.
    let lightNow = view.light && view.light.enabled && view.light.table ? view.light.table[view.light.hour] : null;
    // Lighting is the most expensive pass; when it is measured to be slow it pauses while the user
    // pans or zooms (markGesture in the viewer) and returns in full once the view settles.
    if (lightNow && !renderOpts && view.fastUntil > performance.now() && view.litFrameMs > LIGHT_PAUSE_FRAME_MS) lightNow = null;
    view.lastDrawLit = !!lightNow;
    // Only sectors the user has loaded are drawn (and lit); the rest are placeholders.
    drawPlaceholders(); // below tiles; loaded sectors are skipped inside
    const allSectors = sectors;
    sectors = near(sectors).filter(s => view.loadedSectors?.has(secSectorKey(s)));
    if (lod) {
      // A miniature of each sector with everything it shows (tiles, objects, roofs).
      const byKey = view.lodMobs && view.lodMobs.src === mobPoints && view.lodMobs.n === mobPoints.length ? view.lodMobs.map : null;
      const groups = byKey || new Map();
      if (!byKey) {
        for (const m of mobPoints) { const k = `${m.sectorX},${m.sectorY}`; (groups.get(k) || groups.set(k, []).get(k)).push(m); }
        view.lodMobs = { src: mobPoints, n: mobPoints.length, map: groups };
      }
      const mine = s => groups.get(`${s.position.x},${s.position.y}`) || [];
      const vis = overlayVisibility;
      const signature = s => {
        const objs = mine(s);
        let withArt = 0;
        for (const o of objs) if (o.artCanvas) withArt++;
        return `${artTiles ? artTiles.size : 0}|${vis.containers ? 1 : 0}${vis.scenery ? 1 : 0}${vis.otherMobs ? 1 : 0}${vis.walls ? 1 : 0}${vis.roofs ? 1 : 0}|${objs.length}|${withArt}|${view.roofArt ? view.roofArt.size : 0}`;
      };
      const paint = (mctx, sector, fb, fiso, mv, w, h) => {
        mctx.imageSmoothingEnabled = true; mctx.imageSmoothingQuality = 'medium';
        drawSecActualTiles(mctx, [sector], fb, artTiles, mv);
        const objs = mine(sector);
        if (objs.length) drawSortedObjects(mctx, mv, objs, () => objs, fb, 'art', mv.zoom, mv.offsetX, mv.offsetY, fiso, w, h, vis, null);
        if (vis.roofs) { mv.roofArt = view.roofArt; drawSecRoofs(mctx, [sector], fb, fiso, mv, w, h); }
      };
      drawSecLodSectors(ctx, sectors, bounds, iso, view, zoom, ox, oy, cssW, cssH, paint, signature);
    } else if (lightNow) {
      // Three full-size canvases are needed every frame; keep them instead of allocating anew.
      const layers = view._lightLayers || (view._lightLayers = {});
      const layer = name => {
        const c = layers[name] || (layers[name] = document.createElement('canvas'));
        if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
        const x = c.getContext('2d');
        x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
        x.setTransform(dpr, 0, 0, dpr, 0, 0); x.imageSmoothingEnabled = false;
        return x;
      };
      const tileLayer = layer('tiles');
      drawSecActualTiles(tileLayer, sectors, bounds, artTiles, view);
      const lightModel = secPrepareLightModel(view, sectors, bounds, iso, lightNow, loadedMobs(), view.light.hour);
      lighting = secMakeLighting(view, bounds, iso, lightNow, lightModel);
      const mask = layer('mask');
      secDrawLightMask(mask, sectors, bounds, view, cssW, cssH, lightNow, lightModel);
      secTintLayer(tileLayer.canvas, mask.canvas, layers.copy || (layers.copy = document.createElement('canvas')));
      ctx.drawImage(tileLayer.canvas, 0, 0, cssW, cssH);
    } else {
      drawSecActualTiles(ctx, sectors, bounds, artTiles, view);
    }
  }

  // In low detail the objects and roofs are already part of the sector miniatures.
  if (!lod) drawSortedObjects(ctx, view, mobPoints, loadedMobs, bounds, mode, zoom, ox, oy, iso, cssW, cssH, overlayVisibility, lighting, range);

  // Roofs go on top of everything (isometric view only).
  if (mode === 'art' && !lod && overlayVisibility.roofs) drawSecRoofs(ctx, sectors, bounds, iso, view, cssW, cssH);

  if (selected) {
    const selectedWorldX = (selected.sectorX - bounds.minX) * 64 + selected.tileX;
    const selectedWorldY = (selected.sectorY - bounds.minY) * 64 + selected.tileY;
    const selectedMapWidthTiles = (bounds.maxX - bounds.minX + 1) * 64;
    const localX = mode === 'art' ? selectedWorldX : (selectedMapWidthTiles - 1 - selectedWorldX);
    const localY = selectedWorldY;
    if (mode === 'art') {
      const p = secIsoProject(localX, localY, iso);
      const px = p.x * zoom + ox, py = p.y * zoom + oy;
      ctx.strokeStyle = '#ffe066'; ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * .18));
      ctx.beginPath();
      ctx.moveTo(px, py - SEC_ISO_HALF_H * zoom);
      ctx.lineTo(px + SEC_ISO_HALF_W * zoom, py);
      ctx.lineTo(px, py + SEC_ISO_HALF_H * zoom);
      ctx.lineTo(px - SEC_ISO_HALF_W * zoom, py);
      ctx.closePath(); ctx.stroke();
    } else {
      const px = localX * zoom + ox, py = localY * zoom + oy;
      ctx.strokeStyle = '#ffe066'; ctx.lineWidth = Math.max(1.5, Math.min(4, zoom * 0.18));
      ctx.strokeRect(px + .5, py + .5, Math.max(1, zoom - 1), Math.max(1, zoom - 1));
    }
  }
}

export function secFolderLegendEntries(sectors) {
  const counts = new Map();
  for (const sector of sectors) if (sector.decoded) for (const raw of sector.decoded.tiles) {
    const info = secTileInfo(raw);
    const entry = counts.get(info.artId) || { artId: info.artId, name: info.name, count: 0, color: secTileColor(info.artId) };
    entry.count++; if (!entry.name && info.name) entry.name = info.name; counts.set(info.artId, entry);
  }
  return [...counts.values()].sort((a, b) => a.artId - b.artId);
}

// The order objects are drawn in only changes when objects, visibility or loaded sectors
// change, so it is cached on the view and re-checked with a cheap signature each frame
// (sorting every object like the game does is far more expensive than that check).
function objectOrder(view, mobPoints, loadedMobs, mode, vis) {
  let h = mobPoints.length;
  for (let i = 0; i < mobPoints.length; i++) {
    const o = mobPoints[i];
    h = (Math.imul(h, 31) + (o.worldX | 0) * 7 + (o.worldY | 0) * 13 + (o.seq | 0) + (o.type | 0) * 3
      + (o.objFlags | 0) * 5 + (o.sceneryFlags | 0) * 11 + (o.artCanvas ? 1 : 0)) | 0;
  }
  const flags = `${mode}|${vis.containers ? 1 : 0}${vis.scenery ? 1 : 0}${vis.otherMobs ? 1 : 0}${vis.walls ? 1 : 0}|${view.loadedSectors ? view.loadedSectors.size : -1}`;
  const c = view._objOrder;
  if (c && c.hash === h && c.flags === flags) return c;
  const pts = loadedMobs();
  const portalsOnEdges = m => m.type === 1 && mode === 'art' && !!m.artCanvas;
  const visible = pts.filter(m => {
    if (m.type === 0 || portalsOnEdges(m)) return false;
    if (m.type === 2) return vis.containers;
    if (m.type === 3) return vis.scenery;
    return vis.otherMobs;
  });
  const walls = pts.filter(m => m.type === 0);
  const edgeObjects = (vis.walls ? walls : []).concat(vis.otherMobs ? pts.filter(portalsOnEdges) : []);
  // One shared, game-ordered pass so nearer walls/objects cover farther ones
  // (and vice versa) instead of all walls being painted after every object.
  const ordered = secSortObjectsLikeGame(visible.concat(edgeObjects));
  // Positions in the draw order, per sector, so a frame can pick out just the sectors in view.
  const bySector = new Map();
  ordered.forEach((o, i) => {
    const k = `${o.sectorX},${o.sectorY}`;
    const list = bySector.get(k);
    if (list) list.push(i); else bySector.set(k, [i]);
  });
  return (view._objOrder = { hash: h, flags, ordered, bySector, edgeSet: new Set(edgeObjects) });
}

// Objects (walls, critters, portals, scenery, ground items) are lit one by one: ambient colour
// of the tile they stand on plus any light shining on them (game/light.c sub_4DC210), so each
// sprite is tinted with its own colour. Objects well outside the view are skipped.
function drawSortedObjects(ctx, view, mobPoints, loadedMobs, bounds, mode, zoom, ox, oy, iso, cssW, cssH, vis, lighting, range = null) {
  const { ordered: allOrdered, bySector, edgeSet } = objectOrder(view, mobPoints, loadedMobs, mode, vis);
  let staticOrder = allOrdered;
  // Only the objects of the sectors in view (still in draw order); walking NPCs move between sectors.
  if (range && !secObjectAnim.enabled) {
    const idx = [];
    const cells = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
    if (cells <= bySector.size) {
      for (let y = range.y0; y <= range.y1; y++) for (let x = range.x0; x <= range.x1; x++) { const l = bySector.get(`${x},${y}`); if (l) for (const i of l) idx.push(i); }
    } else {
      for (const [k, l] of bySector) {
        const c = k.indexOf(','), x = +k.slice(0, c), y = +k.slice(c + 1);
        if (x >= range.x0 && x <= range.x1 && y >= range.y0 && y <= range.y1) for (const i of l) idx.push(i);
      }
    }
    idx.sort((a, b) => a - b);
    staticOrder = idx.map(i => allOrdered[i]);
  }
  // Walking NPCs are ordered by the tile they are on now, not the one they started from.
  let ordered = staticOrder;
  if (secObjectAnim.enabled) {
    const movers = [];
    for (const o of staticOrder) { const p = secPoseOf(o); if (p) movers.push({ o, x: Math.round(p.x), y: Math.round(p.y) }); }
    if (movers.length) { const set = new Set(movers.map(m => m.o)); ordered = secMergeMovers(staticOrder.filter(o => !set.has(o)), movers); }
  }
  const mapW = (bounds.maxX - bounds.minX + 1) * 64;
  const margin = Math.max(120, 700 * zoom);    // generous: the biggest sprites are several hundred px
  let drawn = 0;
  for (const o of ordered) {
    const pose = secPoseOf(o);
    const lx = pose ? pose.x - bounds.minX * 64 : (o.sectorX - bounds.minX) * 64 + o.tileX, ly = pose ? pose.y - bounds.minY * 64 : (o.sectorY - bounds.minY) * 64 + o.tileY;
    let px, py;
    if (mode === 'art') {
      px = (iso.originX + (ly - lx) * SEC_ISO_HALF_W) * zoom + ox;
      py = (iso.originY + (lx + ly) * SEC_ISO_HALF_H) * zoom + oy;
    } else {
      px = (mapW - 1 - lx) * zoom + ox; py = ly * zoom + oy;
    }
    if (px < -margin || px > cssW + margin || py < -margin || py > cssH + margin) continue;
    drawn++;
    if (edgeSet.has(o)) drawSecWallOverlay(ctx, [o], bounds, mode, zoom, ox, oy, iso, lighting);
    else drawSecMobOverlay(ctx, [o], bounds, mode, zoom, ox, oy, iso, vis.bounds, lighting);
  }
  view.perf = { objectsDrawn: drawn, objectsTotal: allOrdered.length };
}
