// Ambient lighting, sector lights and the light model.

import { fetchText, mesTable, errText } from '../core/text-io.js';
import { frameImageData, parseArtBuffer } from '../art/art-decoder.js';
import { DATA_ROOT, SEC_ROOT } from '../core/config.js';
import { parseMesText } from '../core/mes-parser.js';
import { encPath } from '../core/util.js';
import { SEC_ISO_HALF_H, SEC_ISO_HALF_W, secIsoMetrics, secIsoProject } from './sec-iso.js';
import { secSectorAllZero } from './sec-tile-art.js';

// Ported from game/light_scheme.c and game/map.c: mapinfo.txt's `LightScheme:N`
// names the map's default scheme; "Lighting Schemes.mes" maps N to a scheme file
// (Rules/<name>.mes) holding 24 hourly entries "ro, go, bo, ri, gi, bi" (outdoor
// then indoor RGB, 0-255, 255 = unchanged); empty entries are interpolated.
// Per-sector light_scheme overrides are not decoded by this viewer.
const LIGHT_RULES_ROOTS = [`${DATA_ROOT}rules/`, `${DATA_ROOT}Rules/`, `${DATA_ROOT}mes/`, `${DATA_ROOT}`];
const lightRulesCache = new Map();
async function fetchLightRulesFile(baseName) {
  if (lightRulesCache.has(baseName)) return lightRulesCache.get(baseName);
  const promise = (async () => {
    const names = [...new Set([`${baseName}.mes`, `${baseName.replace(/ /g, '_')}.mes`])];
    for (const root of LIGHT_RULES_ROOTS) for (const name of names) {
      try {
        return await fetchText(`${root}${encodeURIComponent(name)}`);
      } catch (_) {}
    }
    return null;
  })();
  lightRulesCache.set(baseName, promise);
  return promise;
}
// Port of light_scheme_parse(), including its integer (truncating) interpolation.
function parseLightSchemeText(text) {
  const entries = parseMesText(text);
  const colors = Array.from({ length: 24 }, () => ({ outdoor: [0, 0, 0], indoor: [0, 0, 0] }));
  let interpolate = false, prevIndex = 0;
  let outdoor = [0, 0, 0], indoor = [0, 0, 0], prevOutdoor = [0, 0, 0], prevIndoor = [0, 0, 0];
  for (let index = 0; index < 24; index++) {
    const str = entries.get(index);
    if (str != null && str.trim() !== '') {
      const v = str.split(',').map(x => parseInt(x, 10) || 0);
      outdoor = [v[0] || 0, v[1] || 0, v[2] || 0];
      indoor = [v[3] || 0, v[4] || 0, v[5] || 0];
      colors[index] = { outdoor: outdoor.slice(), indoor: indoor.slice() };
      if (interpolate) {
        const span = index - prevIndex;
        const so = outdoor.map((c, k) => Math.trunc((c - prevOutdoor[k]) / span));
        const si = indoor.map((c, k) => Math.trunc((c - prevIndoor[k]) / span));
        let o = prevOutdoor.slice(), i = prevIndoor.slice();
        for (let h = prevIndex; h < index; h++) {
          colors[h] = { outdoor: o.slice(), indoor: i.slice() };
          o = o.map((c, k) => c + so[k]);
          i = i.map((c, k) => c + si[k]);
        }
        interpolate = false;
      }
      prevIndex = index;
    } else {
      prevOutdoor = outdoor.slice();
      prevIndoor = indoor.slice();
      interpolate = true;
    }
  }
  return colors;
}
async function loadMapLightInfo(relativePath) {
  const base = `${SEC_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}`;
  let info = { lightScheme: 1, found: false };
  for (const fname of ['mapinfo.txt', 'MapInfo.txt', 'Mapinfo.txt']) {
    try {
      const resp = await fetch(`${base}${fname}`);
      if (!resp.ok) continue;
      const text = await resp.text();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*LightScheme\s*:\s*(-?\d+)/i);
        if (m && Number(m[1]) > 0) info = { lightScheme: Number(m[1]), found: true };
      }
      info.found = true;
      break;
    } catch (_) {}
  }
  return info;
}
// Resolves the map's scheme to its 24-hour table (falling back to scheme 1 when
// the scheme's own file is missing, and saying so in `note`).
export async function loadMapLighting(relativePath) {
  const info = await loadMapLightInfo(relativePath);
  const listText = (await fetchLightRulesFile('Lighting Schemes')) || (await fetchLightRulesFile('LightingSchemes'));      // (the 2000 beta's name for the list)
  if (!listText) return { error: 'Lighting Schemes.mes not found (tried data/rules/, data/Rules/, data/mes/, data/)' };
  const list = parseMesText(listText);
  const tryScheme = async id => {
    const name = list.get(id);
    if (!name) return null;
    const text = await fetchLightRulesFile(name.trim());
    return text ? { id, name: name.trim(), table: parseLightSchemeText(text) } : null;
  };
  let result = await tryScheme(info.lightScheme), note = '';
  if (!result) {
    const wanted = list.get(info.lightScheme);
    result = await tryScheme(1);
    note = ` (${wanted ? `"${wanted.trim()}.mes"` : `scheme ${info.lightScheme}`} not found, showing the default scheme instead)`;
  }
  if (!result) return { error: 'No lighting scheme file could be loaded' };
  return { ...result, requested: info.lightScheme, mapinfoFound: info.found, note };
}
function secLightRgb(c) { return `rgb(${Math.max(0, Math.min(255, c[0]))},${Math.max(0, Math.min(255, c[1]))},${Math.max(0, Math.min(255, c[2]))})`; }
// Multiplies a transparent-backed layer by a colour (or mask canvas), keeping its alpha.
export function secTintLayer(layerCanvas, fill, scratch = null) {
  // `scratch` lets a caller that tints every frame reuse one canvas for the copy.
  const copy = scratch || document.createElement('canvas');
  if (copy.width !== layerCanvas.width || copy.height !== layerCanvas.height) { copy.width = layerCanvas.width; copy.height = layerCanvas.height; }
  const cc = copy.getContext('2d');
  cc.setTransform(1, 0, 0, 1, 0, 0);
  cc.clearRect(0, 0, copy.width, copy.height);
  cc.drawImage(layerCanvas, 0, 0);
  const c = layerCanvas.getContext('2d');
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'multiply';
  if (typeof fill === 'string') { c.fillStyle = fill; c.fillRect(0, 0, layerCanvas.width, layerCanvas.height); }
  else c.drawImage(fill, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(copy, 0, 0);
  c.restore();
}
// game/light.c (TIG_ART_TYPE_FACADE case): facades are tinted exactly like tiles,
// indoor colour when tig_art_tile_id_type_get(aid) == 0, outdoor otherwise. The
// game reads that same type bit (bit 8) on a facade id, so facades must NOT be
// forced to the outdoor colour.
// A stored value of 0 is a real indoor tile (type bit 0), e.g. Dn1bse0a. It is
// only "no tile" when its whole sector is zero / not loaded, so callers pass the
// sector's decoded data; without it a 0 falls back to outdoor.
function secTileIsIndoor(raw, decoded) {
  raw = Number(raw) >>> 0;
  if (raw === 0 && (!decoded || secSectorAllZero(decoded))) return false;
  return ((raw >>> 8) & 1) === 0;
}
// Mask: outdoor colour everywhere, indoor colour on tiles whose art type is 0
// (game/tile.c: `color = !tile_type ? indoor_color : outdoor_color`).
// Indices (y * 64 + x) of the indoor tiles of a sector, cached on its decoded data
// (the editor drops the cache when it changes the sector).
function secIndoorTiles(decoded) {
  if (decoded.__indoor) return decoded.__indoor;
  const out = [];
  for (let i = 0; i < 4096; i++) if (secTileIsIndoor(decoded.tiles[i] >>> 0, decoded)) out.push(i);
  return (decoded.__indoor = Uint16Array.from(out));
}
// Tile lighting, ported from game/tile.c + game/light.c.
//
// The game keeps a lattice of light colours, one per (40 x 20) pixel step of the
// screen: `lighter_colors` (every light sprite sampled at the lattice points, added)
// and `darker_colors` (LF_DARK sprites). A tile covers 3 x 3 lattice points
// (sub_4DA360()): vertex colour = clamp(clamp(ambient + lighter) - darker), where
// ambient is the indoor colour for tile type 0 and the outdoor colour otherwise. The
// tile is then blitted as four 39 x 20 quadrants, each interpolating the colours of
// its four corner points (TIG_ART_BLT_BLEND_COLOR_LERP). Because the lattice cells
// are plain axis-aligned (40 x 20) rectangles, that interpolation is exactly what
// scaling a one-pixel-per-lattice-point image up with bilinear smoothing does, so the
// mask is built as two small lattice images (outdoor / indoor ambient) that are scaled
// up; the indoor one is clipped to the indoor tiles' diamonds.
const SEC_LIGHT_MAX_LATTICE = 90000;   // zoomed far out the lattice is sampled more sparsely
export function secDrawLightMask(mctx, sectors, bounds, view, cssW, cssH, light, model) {
  const iso = secIsoMetrics(bounds);
  const zoom = Math.max(0.01, Math.min(32, Number(view?.zoom) || 1));
  const ox = Number(view?.offsetX) || 0, oy = Number(view?.offsetY) || 0;
  const hw = SEC_ISO_HALF_W * zoom + 0.5, hh = SEC_ISO_HALF_H * zoom + 0.5;

  // Diamonds of the indoor tiles (tile type 0), which take the indoor ambient colour.
  const indoorPath = new Path2D();
  let anyIndoor = false;
  for (const sector of sectors || []) {
    if (!sector?.decoded || !sector.position) continue;
    const baseX = (sector.position.x - bounds.minX) * 64;
    const baseY = (sector.position.y - bounds.minY) * 64;
    // a sector entirely off screen has no tile to draw
    const left = (iso.originX + (baseY - baseX - 63) * SEC_ISO_HALF_W) * zoom + ox - hw;
    const right = (iso.originX + (baseY - baseX + 63) * SEC_ISO_HALF_W) * zoom + ox + hw;
    const top = (iso.originY + (baseX + baseY) * SEC_ISO_HALF_H) * zoom + oy - hh;
    const bottom = (iso.originY + (baseX + baseY + 126) * SEC_ISO_HALF_H) * zoom + oy + hh;
    if (right < 0 || left > cssW || bottom < 0 || top > cssH) continue;
    const indoor = secIndoorTiles(sector.decoded);
    for (let k = 0; k < indoor.length; k++) {
      const x = indoor[k] & 63, y = indoor[k] >> 6;
      const px = (iso.originX + ((baseY + y) - (baseX + x)) * SEC_ISO_HALF_W) * zoom + ox;
      const py = (iso.originY + ((baseX + x) + (baseY + y)) * SEC_ISO_HALF_H) * zoom + oy;
      if (px + hw < 0 || px - hw > cssW || py + hh < 0 || py - hh > cssH) continue;
      indoorPath.moveTo(px, py - hh); indoorPath.lineTo(px + hw, py); indoorPath.lineTo(px, py + hh); indoorPath.lineTo(px - hw, py); indoorPath.closePath();
      anyIndoor = true;
    }
  }

  if (!model || !model.list.length) {   // no light sprites: two flat colours
    mctx.fillStyle = secLightRgb(light.outdoor);
    mctx.fillRect(0, 0, cssW, cssH);
    if (anyIndoor) { mctx.fillStyle = secLightRgb(light.indoor); mctx.fill(indoorPath); }
    return;
  }

  // Visible part of the lattice, in unzoomed iso pixels.
  const ux0 = -ox / zoom, ux1 = (cssW - ox) / zoom, uy0 = -oy / zoom, uy1 = (cssH - oy) / zoom;
  const dims = s => {
    const i0 = Math.floor(ux0 / (40 * s)) - 1, i1 = Math.ceil(ux1 / (40 * s)) + 1;
    const j0 = Math.floor(uy0 / (20 * s)) - 1, j1 = Math.ceil(uy1 / (20 * s)) + 1;
    return { i0, j0, nx: i1 - i0 + 1, ny: j1 - j0 + 1 };
  };
  let step = 1, g = dims(1);
  if (g.nx * g.ny > SEC_LIGHT_MAX_LATTICE) { step = Math.ceil(Math.sqrt(g.nx * g.ny / SEC_LIGHT_MAX_LATTICE)); g = dims(step); }

  const fields = secLightField(view, model, light, g, step);

  // One lattice pixel is centred on its lattice point, so the image starts half a cell early.
  const dx = (fields.i0 * 40 * step - 20 * step) * zoom + ox, dy = (fields.j0 * 20 * step - 10 * step) * zoom + oy;
  const dw = fields.nx * 40 * step * zoom, dh = fields.ny * 20 * step * zoom;
  mctx.save();
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(fields.outdoor, dx, dy, dw, dh);
  if (anyIndoor) {
    mctx.save();
    mctx.clip(indoorPath);
    mctx.drawImage(fields.indoor, dx, dy, dw, dh);
    mctx.restore();
  }
  mctx.restore();
}

// The lattice colours depend on the lights and the ambient colours, not on pan or zoom.
// So the lattice is computed for the visible part plus a margin, kept on the view, and
// reused until the view leaves it or a light frame, an ambient colour or the sampling
// step changes. When only the colours change (animated lights) the region is kept.
function secLightField(view, model, light, g, step) {
  let f = view._lightField;
  if (!f || !f.outdoor) f = view._lightField = { outdoor: document.createElement('canvas'), indoor: document.createElement('canvas') };
  const key = `${model.stamp}|${light.outdoor}|${light.indoor}`;
  const covers = f.step === step && g.i0 >= f.i0 && g.j0 >= f.j0 && g.i0 + g.nx <= f.i0 + f.nx && g.j0 + g.ny <= f.j0 + f.ny;
  if (covers && f.model === model && f.key === key) return f;
  if (!covers) {
    const mx = Math.ceil(g.nx / 4), my = Math.ceil(g.ny / 4);
    f.i0 = g.i0 - mx; f.j0 = g.j0 - my; f.nx = g.nx + 2 * mx; f.ny = g.ny + 2 * my; f.step = step;
    for (const c of [f.outdoor, f.indoor]) { c.width = f.nx; c.height = f.ny; }
  }
  f.model = model; f.key = key;
  secComputeLightLattice(f, model, light);
  return f;
}

// Fills the field's two lattice images. Port of the lattice colours of game/light.c:
// every light sprite sampled at the lattice points, the LF_DARK ones summed apart from
// the others, each sum saturating at 255. Each light only visits the lattice points
// under its own sprite, instead of every point looking up the lights around it.
function secComputeLightLattice(f, model, light) {
  const { i0, j0, nx, ny, step } = f;
  const n = nx * ny;
  const lighter = new Int32Array(n * 3), darker = model.hasDark ? new Int32Array(n * 3) : null;
  const cw = 40 * step, ch = 20 * step;
  for (const e of model.list) {
    const d = e.data && e.data.data;
    if (!d) continue;
    // lattice points (i * cw, j * ch) that fall inside the sprite
    const ia = Math.max(i0, Math.ceil(e.left / cw)), ib = Math.min(i0 + nx - 1, Math.floor((e.left + e.w - 1) / cw));
    const ja = Math.max(j0, Math.ceil(e.top / ch)), jb = Math.min(j0 + ny - 1, Math.floor((e.top + e.h - 1) / ch));
    if (ia > ib || ja > jb) continue;
    const t = e.dark ? darker : lighter;
    const kr = e.rgb[0], kg = e.rgb[1], kb = e.rgb[2];
    for (let j = ja; j <= jb; j++) {
      const row = (j * ch - e.top) * e.w - e.left;
      let q = ((j - j0) * nx + (ia - i0)) * 3;
      for (let i = ia; i <= ib; i++, q += 3) {
        const o = (row + i * cw) * 4;
        if (d[o + 3] === 0) continue; // colour key: no light here
        t[q] += Math.round(d[o] * kr / 255); t[q + 1] += Math.round(d[o + 1] * kg / 255); t[q + 2] += Math.round(d[o + 2] * kb / 255);
      }
    }
  }
  const outImg = f.outdoor.getContext('2d').createImageData(nx, ny), inImg = f.indoor.getContext('2d').createImageData(nx, ny);
  const od = outImg.data, id = inImg.data, outBase = light.outdoor, inBase = light.indoor;
  for (let p = 0, q = 0, o = 0; p < n; p++, q += 3, o += 4) {
    for (let c = 0; c < 3; c++) {
      const l = Math.min(255, lighter[q + c]), dk = darker ? Math.min(255, darker[q + c]) : 0;
      od[o + c] = Math.max(0, Math.min(255, outBase[c] + l) - dk);
      id[o + c] = Math.max(0, Math.min(255, inBase[c] + l) - dk);
    }
    od[o + 3] = id[o + 3] = 255;
  }
  f.outdoor.getContext('2d').putImageData(outImg, 0, 0);
  f.indoor.getContext('2d').putImageData(inImg, 0, 0);
}

// Each sector light record names a light ART (art/light/<light.mes name>.art, a
// radial sprite) at a tile + pixel offset. game/light.c adds the sprite, tinted
// by the light's colour, to the scene (LF_DARK lights are subtracted instead).
// LF_INDOOR / LF_OUTDOOR lights take the current ambient colour as their tint.
// LF_ANIMATING lights cycle through the frames of their ART (see `animTime` below).
// The art id's `num` is bits 19-27 (tig_art_num_get; same field as portals/eye candy).
const SEC_LIGHT_ART_ROOT = `${DATA_ROOT}art/light/`;
const LF_OFF = 0x1, LF_DARK = 0x2, LF_ANIMATING = 0x4, LF_INDOOR = 0x8, LF_OUTDOOR = 0x10;
const secLightArtCache = new Map();   // num -> { frames: [{ canvas, hotspotX, hotspotY, data }], fps } | null
function secLightNum(light) { return (light.artId >>> 19) & 0x1FF; }
const secLoadLightNames = mesTable(`${SEC_LIGHT_ART_ROOT}light.mes`);
// Loads the ART for every light in the given sectors; returns counts for the UI.
export async function ensureSecLightArt(sectors, objectPoints) {
  const stats = { total: 0, drawn: 0, dark: 0, off: 0, missingArt: 0, objectLights: 0, animated: 0 };
  let names;
  try { names = await secLoadLightNames(); } catch (err) { return { ...stats, error: errText(err) }; }
  const wanted = new Set();
  for (const sector of sectors || []) for (const l of sector?.decoded?.lights || []) {
    stats.total++;
    if (l.flags & LF_OFF) { stats.off++; continue; }
    if (l.flags & LF_DARK) stats.dark++;
    wanted.add(secLightNum(l));
  }
  for (const m of objectPoints || []) for (const src of m.lightSources || []) wanted.add(secLightNum({ artId: src.aid }));
  await Promise.all([...wanted].filter(n => !secLightArtCache.has(n)).map(async num => {
    const name = names.get(num);
    let result = null;
    if (name) {
      for (const file of [`${name.trim()}.art`, `${name.trim().toLowerCase()}.art`]) {
        try {
          const resp = await fetch(`${SEC_LIGHT_ART_ROOT}${encodeURIComponent(file)}`);
          if (!resp.ok) continue;
          const parsed = await parseArtBuffer(await resp.arrayBuffer());
          // Light ARTs may be rotated 8-direction sprites; the first direction is used.
          const frames = parsed.filter(f => f.direction === 0).map(f => ({
            src: f, width: f.width, height: f.height, hotspotX: Number(f.hotspotX) || 0, hotspotY: Number(f.hotspotY) || 0, data: undefined
          }));
          if (frames.length) { result = { frames, fps: Number(parsed.frameRate) > 0 ? Number(parsed.frameRate) : 8 }; break; }
        } catch (_) {}
      }
    }
    secLightArtCache.set(num, result);
  }));
  const isAnimated = (flags, art) => !!(flags & LF_ANIMATING) && art && art.frames.length > 1;
  for (const sector of sectors || []) for (const l of sector?.decoded?.lights || []) {
    if (l.flags & LF_OFF) continue;
    const art = secLightArtCache.get(secLightNum(l));
    if (art) { stats.drawn++; if (isAnimated(l.flags, art)) stats.animated++; } else stats.missingArt++;
  }
  for (const m of objectPoints || []) for (const src of m.lightSources || []) {
    const art = secLightArtCache.get(secLightNum({ artId: src.aid }));
    if (art) { stats.objectLights++; if (isAnimated(src.flags, art)) stats.animated++; }
  }
  return stats;
}
// game/light.c does not paint light sprites over the finished scene. Every light
// sprite is accumulated into a "lighter" buffer (LF_DARK ones into a "darker"
// buffer), and each tile/object is then drawn multiplied by
//     colour = clamp(ambient + lighter - darker)
// where `ambient` is the indoor or outdoor colour (light_render_internal,
// sub_4DA360 for tiles, sub_4D89E0 / sub_4DC210 for objects). So lights brighten
// the tiles AND every object standing in their glow, instead of sitting on top.
const SEC_LIGHT_CELL = 128;
// Numeric key of a grid cell (a string key per lookup was most of the sampling cost).
const secLightCellKey = (cx, cy) => (cx + 0x8000) * 0x10000 + (cy + 0x8000);
function secLightSpriteData(frame) {
  if (frame.data === undefined) frame.data = frameImageData(frame.src);
  return frame.data;
}
// Points the entry at one frame of its ART and recomputes where that frame lands.
function secSetLightFrame(e, fi) {
  const frame = e.art.frames[fi];
  e.fi = fi; e.frame = frame;
  e.data = secLightSpriteData(frame);
  e.left = Math.round(e.ax - frame.hotspotX);
  e.top = Math.round(e.ay - frame.hotspotY);
  e.w = frame.width; e.h = frame.height;
}
// Builds (and caches on the view) the lit light list with a coarse lookup grid, then
// refreshes each light's tint and animation frame for the current ambient colours and
// time (LF_INDOOR / LF_OUTDOOR lights take the ambient colour as their tint).
// `view.light.animate` / `view.light.animTime` (ms) drive LF_ANIMATING lights.
export function secPrepareLightModel(view, sectors, bounds, iso, ambient, objectPoints, hour) {
  const isDay = hour >= 6 && hour < 18;
  const sig = `${secLightArtCache.size}|${isDay}|${objectPoints ? objectPoints.length : 0}|${sectors.length}|${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY}`;
  let model = view._lightModel;
  if (!model || model.sig !== sig) {
    const list = [];
    const add = (flags, r, g, b, num, art, gx, gy, ax, ay) => {
      const e = {
        flags, r, g, b, num, art, dark: !!(flags & LF_DARK), gx, gy, rgb: [255, 255, 255], ax, ay,
        animated: !!(flags & LF_ANIMATING) && art.frames.length > 1, fi: -1
      };
      secSetLightFrame(e, 0);
      if (!e.data) return;
      list.push(e);
    };
    for (const sector of sectors || []) for (const l of sector?.decoded?.lights || []) {
      if (l.flags & LF_OFF) continue;
      const num = secLightNum(l);
      const art = secLightArtCache.get(num);
      if (!art) continue;
      const p = secIsoProject(l.x - bounds.minX * 64, l.y - bounds.minY * 64, iso);
      add(l.flags, l.r, l.g, l.b, num, art, l.x, l.y, p.x + l.offsetX, p.y + l.offsetY);
    }
    // Lights carried by objects (lamps, torches, braziers, glowing critters...). They sit at
    // the object's tile + pixel offset. Nocturnal scenery (street lamps and the like) is only
    // lit at night on outdoor tiles, and always on indoor tiles (sector_light_list_fold()).
    for (const m of objectPoints || []) {
      if (!m.lightSources || !m.lightSources.length) continue;
      const wx = m.sectorX * 64 + m.tileX, wy = m.sectorY * 64 + m.tileY;
      let indoor = false;
      if (m.nocturnal) {
        const sec = view.sectorMap && view.sectorMap.get(`${m.sectorX},${m.sectorY}`);
        const raw = sec?.decoded ? (sec.decoded.tiles[(m.tileY & 63) * 64 + (m.tileX & 63)] >>> 0) : 0;
        indoor = secTileIsIndoor(raw, sec?.decoded);
        if (!indoor && isDay) continue;
      }
      const p = secIsoProject((m.sectorX - bounds.minX) * 64 + m.tileX, (m.sectorY - bounds.minY) * 64 + m.tileY, iso);
      for (const src of m.lightSources) {
        let flags = src.flags;
        if (m.nocturnal && ((m.objFlags | 0) & 0x2) !== 0) flags &= ~LF_OFF; // OF_OFF scenery is switched back on
        if (flags & LF_OFF) continue;
        const num = secLightNum({ artId: src.aid });
        const art = secLightArtCache.get(num);
        if (!art) continue;
        add(flags, src.r, src.g, src.b, num, art, wx, wy, p.x + (Number(m.offsetX) || 0), p.y + (Number(m.offsetY) || 0));
      }
    }
    // Frames of one ART can differ in size, so an animated light is bucketed by the box
    // that covers all of its frames.
    const grid = new Map();
    list.forEach((e, idx) => {
      let l0 = e.left, t0 = e.top, r0 = e.left + e.w, b0 = e.top + e.h;
      if (e.animated) {
        for (const f of e.art.frames) {
          const fl = Math.round(e.ax - f.hotspotX), ft = Math.round(e.ay - f.hotspotY);
          l0 = Math.min(l0, fl); t0 = Math.min(t0, ft); r0 = Math.max(r0, fl + f.width); b0 = Math.max(b0, ft + f.height);
        }
      }
      for (let cy = Math.floor(t0 / SEC_LIGHT_CELL); cy <= Math.floor((b0 - 1) / SEC_LIGHT_CELL); cy++)
        for (let cx = Math.floor(l0 / SEC_LIGHT_CELL); cx <= Math.floor((r0 - 1) / SEC_LIGHT_CELL); cx++) {
          const key = secLightCellKey(cx, cy);
          const bucket = grid.get(key);
          if (bucket) bucket.push(idx); else grid.set(key, [idx]);
        }
    });
    model = { sig, list, grid, hasDark: list.some(e => e.dark), stamp: 0 };
    view._lightModel = model;
  }
  const animate = !!(view.light && view.light.animate);
  const now = Number(view.light && view.light.animTime) || 0;
  for (const e of model.list) {
    e.rgb = (e.flags & LF_INDOOR) ? ambient.indoor : (e.flags & LF_OUTDOOR) ? ambient.outdoor : [e.r, e.g, e.b];
    if (e.animated) {
      // The phase differs per light so a row of torches does not flicker in lockstep.
      const n = e.art.frames.length;
      const fi = animate ? (Math.floor(now * e.art.fps / 1000) + ((e.gx * 7 + e.gy * 13) % n + n)) % n : 0;
      if (fi !== e.fi) { secSetLightFrame(e, fi); model.stamp++; }
    }
  }
  return model;
}
// Port of sub_4D89E0(): starts from `base` and adds (or, for dark lights,
// subtracts) the light sprite pixel found under the point (sx, sy), given in
// unzoomed iso pixels. `accept(entry)` can veto lights (used for walls).
function secSampleLights(model, sx, sy, base, accept) {
  let r = base[0], g = base[1], b = base[2];
  const bucket = model.grid.get(secLightCellKey(Math.floor(sx / SEC_LIGHT_CELL), Math.floor(sy / SEC_LIGHT_CELL)));
  if (!bucket) return [r, g, b];
  const fx = Math.floor(sx), fy = Math.floor(sy);
  for (const idx of bucket) {
    const e = model.list[idx];
    const px = fx - e.left, py = fy - e.top;
    if (px < 0 || py < 0 || px >= e.w || py >= e.h) continue;
    if (accept && !accept(e)) continue;
    const o = (py * e.w + px) * 4, d = e.data.data;
    if (d[o + 3] === 0) continue; // colour key: no light here
    const cr = Math.round(d[o] * e.rgb[0] / 255), cg = Math.round(d[o + 1] * e.rgb[1] / 255), cb = Math.round(d[o + 2] * e.rgb[2] / 255);
    if (e.dark) { r = Math.max(0, r - cr); g = Math.max(0, g - cg); b = Math.max(0, b - cb); }
    else { r = Math.min(255, r + cr); g = Math.min(255, g + cg); b = Math.min(255, b + cb); }
  }
  return [r, g, b];
}

// Per-object lighting for the object overlays. Each object is tinted by its own
// colour like the game does (sub_4DC210): one colour sampled at the object's anchor
// for ordinary objects and portals, one colour per pixel column along the base of a wall.
const OF_DONTLIGHT = 0x00100000;
// Tinted copies of object sprites, kept between frames (sprite -> colour -> canvas).
let secObjTintCache = new WeakMap();
let secObjTintCount = 0;
// Per-object colours do not depend on zoom or pan, only on the light model and the ambient
// colours, so they are remembered per object and reused every frame until either changes.
// (A tile edit builds a new model, which starts a fresh memo.)
const secLightMemo = new WeakMap();   // model -> { key, walls, points }
function secLightMemoFor(model, ambient) {
  if (!model) return null;
  const key = `${ambient.outdoor}|${ambient.indoor}|${model.stamp}`;   // stamp: an animated light changed frame
  let m = secLightMemo.get(model);
  if (!m || m.key !== key) { m = { key, walls: new WeakMap(), points: new WeakMap() }; secLightMemo.set(model, m); }
  return m;
}
const secNear = (a, b) => Math.abs(a - b) < 0.05;   // sx/sy are re-derived from screen pixels each frame
export function secMakeLighting(view, bounds, iso, ambient, model) {
  const sectorMap = view.sectorMap;
  const memo = secLightMemoFor(model, ambient);
  const lighting = {
    ambient, model,
    // Tile type 0 is "indoor": such tiles (and objects standing on them) use the indoor colour.
    baseAt(wx, wy) {
      const sector = sectorMap && sectorMap.get(`${Math.floor(wx / 64)},${Math.floor(wy / 64)}`);
      const raw = sector?.decoded ? (sector.decoded.tiles[(wy & 63) * 64 + (wx & 63)] >>> 0) : 0;
      const indoor = secTileIsIndoor(raw, sector?.decoded);
      return indoor ? ambient.indoor : ambient.outdoor;
    },
    quantize(rgb, base) {
      if (rgb[0] === base[0] && rgb[1] === base[1] && rgb[2] === base[2]) return rgb;
      const q = v => Math.min(255, (v + 2) & ~3);
      return [q(rgb[0]), q(rgb[1]), q(rgb[2])];
    },
    sprite(canvas, rgb) {
      if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) return canvas;
      let per = secObjTintCache.get(canvas);
      if (!per) { per = new Map(); secObjTintCache.set(canvas, per); }
      const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
      let t = per.get(key);
      if (!t) {
        // Bound memory: drop every tinted copy once there are too many.
        if (++secObjTintCount > 2000) { secObjTintCache = new WeakMap(); secObjTintCount = 0; per = new Map(); secObjTintCache.set(canvas, per); }
        t = document.createElement('canvas'); t.width = canvas.width; t.height = canvas.height;
        t.getContext('2d').drawImage(canvas, 0, 0);
        secTintLayer(t, secLightRgb(rgb));
        per.set(key, t);
      }
      return t;
    },
    // Single colour for an ordinary object whose anchor is (sx, sy) in unzoomed iso pixels.
    pointColor(wx, wy, sx, sy) {
      const base = lighting.baseAt(wx, wy);
      return lighting.quantize(secSampleLights(model, sx, sy, base), base);
    },
    mobColor(mob, sx, sy) {
      if (((mob.objFlags | 0) & OF_DONTLIGHT) !== 0) return null;
      const hit = memo && memo.points.get(mob);
      if (hit && hit.k === 'm' && secNear(hit.sx, sx) && secNear(hit.sy, sy)) return hit.v;
      const v = lighting.pointColor(mob.sectorX * 64 + mob.tileX, mob.sectorY * 64 + mob.tileY, sx, sy);
      if (memo) memo.points.set(mob, { k: 'm', sx, sy, v });
      return v;
    },
    // Portals: fixed anchor, nudged onto the adjoining tile for rotations 3 and 5.
    portalColor(portal, edgeRot, centreX, centreY) {
      if (((portal.objFlags | 0) & OF_DONTLIGHT) !== 0) return null;
      const hit = memo && memo.points.get(portal);
      if (hit && hit.k === 'p' && hit.rot === edgeRot && secNear(hit.sx, centreX) && secNear(hit.sy, centreY)) return hit.v;
      let wx = portal.sectorX * 64 + portal.tileX, wy = portal.sectorY * 64 + portal.tileY;
      let rot = edgeRot; if ((rot & 1) === 0) rot++;
      let dx = -20, dy = -10, tx = 0, ty = 0;
      if (rot === 1) { dx = 20; }
      else if (rot === 3) { ty = 1; }
      else if (rot === 5) { dx = 20; tx = 1; }
      wx += tx; wy += ty;
      // centreX/Y is the portal tile's centre; shift by the adjoining tile if needed.
      const shift = secIsoProject(tx, ty, { originX: 0, originY: 0 });
      const v = lighting.pointColor(wx, wy, centreX + shift.x + dx, centreY + shift.y + dy);
      if (memo) memo.points.set(portal, { k: 'p', rot: edgeRot, sx: centreX, sy: centreY, v });
      return v;
    },
    // Colour per pixel column (every 4th column sampled) along a wall's base line.
    // Returns null when the wall is unlit, otherwise [{x0, x1, rgb}] runs.
    wallRuns(wall, edgeRot, spriteLeft, spriteWidth, edgeX0, edgeY0, slope) {
      if (((wall.objFlags | 0) & OF_DONTLIGHT) !== 0) return null;
      const hit = memo && memo.walls.get(wall);
      if (hit && hit.rot === edgeRot && hit.l === spriteLeft && hit.w === spriteWidth && hit.x === edgeX0 && hit.y === edgeY0 && hit.s === slope) return hit.v;
      const wx = wall.sectorX * 64 + wall.tileX, wy = wall.sectorY * 64 + wall.tileY;
      const rot = edgeRot & ~1;
      // Walls facing rot 2 / 4 always take the outdoor colour as their base.
      const base = (rot === 2 || rot === 4) ? ambient.outdoor : lighting.baseAt(wx, wy);
      // Only lights on the inner side of the wall reach it (sub_4DC210).
      const accept = e => (rot === 0 && e.gx >= wx) || (rot === 2 && e.gy > wy) || (rot === 4 && e.gx > wx) || (rot === 6 && e.gy >= wy);
      const runs = [];
      const STEP = 4;
      for (let x = 0; x < spriteWidth; x += STEP) {
        const sx = spriteLeft + x + STEP / 2;
        const sy = edgeY0 + slope * (sx - edgeX0);
        const rgb = lighting.quantize(secSampleLights(model, sx, sy, base, accept), base);
        const last = runs[runs.length - 1];
        if (last && last.rgb[0] === rgb[0] && last.rgb[1] === rgb[1] && last.rgb[2] === rgb[2]) last.x1 = Math.min(spriteWidth, x + STEP);
        else runs.push({ x0: x, x1: Math.min(spriteWidth, x + STEP), rgb });
      }
      if (memo) memo.walls.set(wall, { rot: edgeRot, l: spriteLeft, w: spriteWidth, x: edgeX0, y: edgeY0, s: slope, v: runs });
      return runs;
    }
  };
  return lighting;
}
