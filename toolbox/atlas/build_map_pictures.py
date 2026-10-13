"""
Pictures of every map of the game for the Atlas: the world map and the 77 other maps (castles, caves, sewers...).

Each sector (64 x 64 tiles) becomes one picture, drawn by the Asset Browser's own renderer in a headless browser, with
only what makes the place itself:
  * tiles and facades (the sector's ground, game/tile.c),
  * walls and scenery (the sector's own objects and the walls / scenery .mob files of the map),
drawn as the art is, without light. With --light, they are lit as the game computes it (game/light.c, ported in js/sec/sec-lighting.js): the ambient colour of the light
    scheme (Rules/Lighting Schemes.mes; mapinfo.txt LightScheme = the map's, a sector can name its own: the game
    switches to it when the player walks in, sector_object_list.c) at HOUR, indoor colour on indoor tiles, plus every
    light sprite of the sector, of its 8 neighbours (their glow reaches over the border) and of the objects drawn.
No people, creatures, items, containers, doors or roofs: the Atlas shows those as pins, and a roof would hide the inside.
The world map also gets one picture per terrain template (data/terrain/<n>.sec) its grid uses: every sector without a
.sec of its own is that template, so one picture serves thousands of sectors (as in the game, terrain.tdf).

Output, in atlas/maps/<map>/:  L0/<stem>_<col>_<row>.webp full size in 8 x 4 pieces (a sector is 5120 x 2560 px plus
a margin for sprites that reach over its edge), H/ the same at 1/2 in 4 x 2 pieces (pieces.json: which are not empty),
L1 1/4, L2 1/16, atlas.webp (all the pictures at 1/64), meta.json.  js/atlas/data/map-pictures.js
(window.ArcanumPictures) lists them for world-atlas.html.  Pictures already made with the same settings are kept, so a
stopped run carries on where it was.
--glows: the glows the Atlas puts on what its filters mark, in the shape of each thing's art (atlas/glows/, js/atlas/data/glow-shapes.js).
--objects: the objects layers O0 / O1; --off-objects: F0 / F1, the people and creatures switched off (OF_OFF), apart.

Needs Playwright with Chromium and Pillow.   py build_map_pictures.py [--maps "Tarant Sewers-02,BMC"] [--limit 4]
"""
import argparse
import base64
import io
import json
import re
import socketserver
import struct
import sys
import subprocess
import threading
import time
import zlib
from array import array
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'toolbox'))
import export_sec_maps as exp                                   # noqa: E402  (read-only: its local server + headless modules)
from playwright.sync_api import sync_playwright                  # noqa: E402

from arcanum_objects import clean_map                             # noqa: E402  (the map key the Atlas uses)

DATA_JS = ROOT / 'js' / 'atlas' / 'data'                   # the generated data the pages load
MAPS = ROOT / 'data' / 'maps'
MODULES = ROOT / 'data' / 'maps-modules' / '_Modules'            # the maps of the modules: one folder each, drawn like the game's own maps (--modules)
MODULE_NAMES = sorted(d.name for d in MODULES.iterdir() if d.is_dir()) if MODULES.is_dir() else []
OUT = ROOT / 'atlas' / 'maps'
OUT_JS = DATA_JS / 'map-pictures.js'
WORLD = 'Arcanum1-024-fixed'
SKIP_FOLDERS = {'ShopMap', 'Scienticians Underground Lev 1', 'Scienticians Underground Lev 2'}   # not in Rules/MapList.mes
PAD = {'l': 192, 't': 384, 'r': 192, 'b': 64}                  # multiples of 64, so the 1/64 copy is exact
SECTOR_W, SECTOR_H = 5120, 2560
IMG_W, IMG_H = SECTOR_W + PAD['l'] + PAD['r'], SECTOR_H + PAD['t'] + PAD['b']
LEVELS = {1: 4, 2: 16}                                           # L<n>: 1/factor of the full picture
ATLAS_FACTOR, ATLAS_COLS = 64, 32
QUALITY = 0.8                                                    # WebP; a full picture is ~1.6 MB (8 MB as PNG)
WATCHDOG_S = 150                                                 # a picture taking longer than this (normally ~4 s) is a hung page
RECYCLE_EVERY = 120                                             # pictures after which the headless browser is restarted
VERSION = 4
GROUND = 2                                                       # 2: black where there is no tile art, the neighbours' tiles overlap the edge (no seams)


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def sector_xy(path):
    if not path.stem.isdigit():
        return None
    v = int(path.stem)
    return v & 0x3FFFFFF, v >> 26


def base_of(folder):
    return MODULES / folder if folder in MODULE_NAMES else MAPS / folder


def map_light_scheme(folder):
    """mapinfo.txt LightScheme (1 = Lighting Default when there is none; map.c)."""
    for name in ('mapinfo.txt', 'MapInfo.txt'):
        p = base_of(folder) / name
        if p.is_file():
            m = re.search(r'LightScheme\s*:\s*(\d+)', p.read_text(encoding='cp1252', errors='replace'), re.I)
            return int(m.group(1)) if m and int(m.group(1)) > 0 else 1
    return 1


PAGE = r'''<!doctype html><html><head><meta charset="utf-8"><title>Atlas map pictures</title></head><body><script type="module">
(async () => {
  try {
    const [{ readSecTileData }, { loadMobsForSecMap, loadSecStaticObjectPoints }, tiles, { drawSecActualTiles }, { drawSortedObjects },
      { secIsoMetrics, secIsoProject }, L, terrain, { parseMesText }] = await Promise.all([
      import('/js/sec/sec-parser.js'), import('/js/sec/sec-object-points.js'), import('/js/sec/sec-tile-art.js'),
      import('/js/sec/sec-map-view.js'), import('/js/sec/sec-folder-map.js'), import('/js/sec/sec-iso.js'),
      import('/js/sec/sec-lighting.js'), import('/js/sec/sec-terrain.js'), import('/js/core/mes-parser.js')]);
    const enc = p => p.split('/').map(encodeURIComponent).join('/');
    const tileArt = new Map(), mobCache = new Map(), schemeCache = new Map();
    let schemeList = null;

    async function readSector(url, filename, position) {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return { filename, index: 0, position, decoded: readSecTileData(await r.arrayBuffer(), filename), error: null };
    }
    async function loadTileArt(decoded, where) {
      await tiles.loadSecTileNameMes(); await tiles.loadSecTileManifest();
      await Promise.all([...new Set(Array.from(decoded.tiles, v => Number(v) >>> 0))].map(async raw => {
        if (tileArt.has(raw)) return;
        const info = tiles.secTileInfo(raw);
        let art = null;
        try { art = await tiles.loadSecTileArt(info); } catch (_) {}
        if (art) tileArt.set(raw, art);
        else if (String(info?.name || '').trim().toUpperCase() !== 'BLK') console.warn('[PICTURES] tile art missing', where, raw);
      }));
    }
    // the 24 hours of a light scheme (Rules/<name>.mes, light_scheme.c)
    async function scheme(id) {
      if (!schemeList) schemeList = parseMesText(await (await fetch('/data/Rules/' + encodeURIComponent('Lighting Schemes.mes'))).text());
      if (!schemeCache.has(id)) {
        const name = (schemeList.get(id) || schemeList.get(1)).trim();
        const r = await fetch('/data/Rules/' + encodeURIComponent(name + '.mes'));
        schemeCache.set(id, { name, table: L.parseLightSchemeText(await r.text()) });
      }
      return schemeCache.get(id);
    }
    function mobsOf(job) {
      if (!job.mobs) return Promise.resolve([]);
      if (!mobCache.has(job.mobs.key)) mobCache.set(job.mobs.key, loadMobsForSecMap(job.mobs.dir, { files: job.mobs.files, relativeNames: true }));
      return mobCache.get(job.mobs.key);
    }

    // One sector: its tiles, walls and scenery, lit by the lights of all nine sectors and of the objects on them.
    async function render(job) {
      const [x, y] = job.at;
      const center = await readSector(job.url, job.file, { x, y });
      if (tiles.secSectorAllZero(center.decoded)) return { blank: true };
      const nbs = [];
      for (const n of job.neighbours) { try { nbs.push(await readSector(n.url, n.file, { x: n.at[0], y: n.at[1] })); } catch (e) { console.warn('[PICTURES] neighbour', n.url, String(e)); } }
      const nine = [center, ...nbs];
      await loadTileArt(center.decoded, job.url);
      // The ground also draws the tiles of the neighbours in a 3 px band outside the diamond (a terrain template: itself, as
      // all around it), so two pictures overlap along their edge: the soft edge of a tile of one would leave a hairline
      // seam between sectors, as a grid. Where no tile art exists the ground is black, as in the game.
      const tileSecs = [center];
      if (!job.layer) {
        if (job.wrap) { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) tileSecs.push({ ...center, position: { x: x + dx, y: y + dy } }); }
        else { for (const n of nbs) { await loadTileArt(n.decoded, n.filename); tileSecs.push(n); } }
      }
      const diag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
      const statics = await loadSecStaticObjectPoints(nine, diag);
      // Each object is drawn in its own sector's picture only: the pictures are laid back to front, so a sprite reaching
      // into the next sector is covered or covers it in the right order. The neighbours' objects still give their light.
      const near = o => Math.abs(o.sectorX - x) <= 1 && Math.abs(o.sectorY - y) <= 1;
      // job.layer: the objects layer (people, creatures, items, containers, doors) over the base picture, on a clear canvas
      const keep = job.layer ? (() => true) : (o => o.type === 0 || o.type === 3 || (job.doors && o.type === 1));
      const around = statics.concat((await mobsOf(job)).filter(near)).filter(keep);
      // Scenery standing on a blank / black tile (no tile art) would float on nothing, as dark tufts: left out.
      // Only ground cover is meant: structures that stand on a black tile (the metro entrances of Tarant, cave exits) are drawn.
      const groundCover = o => /grass|bush|tree|plant|weed|tuft|flower/i.test(o.artName || '');
      const secAt = new Map(nine.map(s => [`${s.position.x},${s.position.y}`, s]));
      const rawAt = o => Number(secAt.get(`${o.sectorX},${o.sectorY}`)?.decoded.tiles[o.tileY * 64 + o.tileX] ?? 0) >>> 0;   // the tile under an object (of its own sector)
      const onGround = o => o.type !== 3 || !groundCover(o) || tileArt.has(rawAt(o));
      // People and creatures the game keeps switched off (OF_OFF) until a script brings them in have a layer of their own
      // (job.off), which the Atlas only shows on request; the objects layer leaves them out.
      const offCritter = o => (o.type === 15 || o.type === 16) && ((o.objFlags | 0) & 0x2) !== 0;
      // Night-only scenery (OSCF_NOCTURNAL: the glows of the street lamps) is switched off by day on an outdoor tile, as its
      // light is (sec-lighting.js); on an indoor tile it stays on.
      const indoorAt = o => { const raw = rawAt(o); return (raw >>> 28) === 11 ? ((raw >>> 25) & 1) === 0 : ((raw >>> 8) & 1) === 0; };
      const dayOff = o => job.light && job.hour >= 6 && job.hour < 18 && o.type === 3 && o.nocturnal && !indoorAt(o);
      const objects = around.filter(o => o.sectorX === x && o.sectorY === y && o.tileX >= 0 && o.tileX < 64 && o.tileY >= 0 && o.tileY < 64 && onGround(o) && !dayOff(o)
        && (!job.layer || (o.type !== 0 && o.type !== 3 && offCritter(o) === !!job.off)));
      if (job.layer && !objects.length) return { blank: true };
      const B = { minX: x - 1, maxX: x + 1, minY: y - 1, maxY: y + 1 }, iso = secIsoMetrics(B);
      const one = secIsoProject(0, 0, secIsoMetrics({ minX: 0, maxX: 0, minY: 0, maxY: 0 })), mid = secIsoProject(64, 64, iso);
      const W = job.size[0], H = job.size[1];
      const layer = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.imageSmoothingEnabled = false; return g; };
      const vis = job.layer ? { containers: true, scenery: false, otherMobs: true, walls: false, bounds: false }
        : { containers: false, scenery: true, otherMobs: !!job.doors, walls: true, bounds: false };
      // The objects. Additive ones (blit flag 0x10: glows, flames) add their light to what is under them, black adding nothing.
      // Past the edge of the ground there is nothing under them, and adding to a clear pixel would leave their black there,
      // opaque, over the next sector's picture. So they are drawn last, on a layer of their own, then added: over the ground
      // as the game does, over clear pixels as a see-through glow (its brightness as alpha) that adds the same over anything.
      const additive = o => ((o.blitFlags | 0) & 0x10) !== 0;
      const drawObjects = (g, view, lighting) => {
        const solid = objects.filter(o => !additive(o)), glow = objects.filter(additive);
        drawSortedObjects(g, view, solid, () => solid, B, 'art', 1, view.offsetX, view.offsetY, iso, W, H, vis, lighting);
        if (!glow.length) return;
        const gl = layer();
        drawSortedObjects(gl, view, glow, () => glow, B, 'art', 1, view.offsetX, view.offsetY, iso, W, H, vis, lighting);
        const a = g.getImageData(0, 0, W, H), b = gl.getImageData(0, 0, W, H), d = a.data, s = b.data;
        for (let i = 0; i < d.length; i += 4) {
          if (!s[i + 3]) continue;
          const m = Math.max(s[i], s[i + 1], s[i + 2]);
          if (!m) continue;
          const A = d[i + 3] / 255, ao = Math.max(A, m / 255);
          for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, (d[i + k] * A + s[i + k]) / ao);
          d[i + 3] = Math.round(ao * 255);
        }
        g.putImageData(a, 0, 0);
      };
      // the sector's diamond plus a 3 px band, as a path
      const diamond = g => { g.moveTo(job.pad.l + 2560, job.pad.t - 3); g.lineTo(job.pad.l + 5126, job.pad.t + 1280); g.lineTo(job.pad.l + 2560, job.pad.t + 2563); g.lineTo(job.pad.l - 6, job.pad.t + 1280); g.closePath(); };
      // the ground: black over the diamond, the neighbours' tiles in the band, then the sector's own tiles (their overhang too)
      const ground = (g, view) => {
        g.save(); g.beginPath(); diamond(g); g.clip(); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        drawSecActualTiles(g, tileSecs.slice(1), B, tileArt, view);
        g.restore();
        drawSecActualTiles(g, [center], B, tileArt, view);
      };
      // Where the band has no tile (no neighbour, or no art there) the ground is black: that black is cleared, just outside the
      // diamond, before any object is drawn. (Clearing it afterwards, as trim_band.py did, also cleared the dark pixels of
      // objects crossing the edge: the windows of the Tarant bridge towers became a see-through line.)
      const cutBand = g => {
        const img = g.getImageData(0, 0, W, H), d = img.data, cx = job.pad.l + 2560, cy = job.pad.t + 1280;
        const k = 6 * Math.hypot(2560, 1280) / (2560 * 1280);            // trim_band.REACH px, in diamond units
        for (let py = Math.max(0, job.pad.t - 8); py < Math.min(H, job.pad.t + 2568); py++) {
          const ry = Math.abs(py + 0.5 - cy) / 1280;
          const a0 = Math.max(0, (1 - ry) * 2560 - 1), a1 = (1 + k - ry) * 2560 + 1;   // |x - cx| of the ring on this row
          for (const side of [-1, 1]) for (let dx = Math.floor(a0); dx <= Math.ceil(a1); dx++) {
            const px = Math.floor(cx + side * dx);
            if (px < 0 || px >= W) continue;
            const ex = Math.abs(px + 0.5 - cx) / 2560 + ry;
            if (ex <= 1 || ex > 1 + k) continue;
            const i = (py * W + px) * 4;
            if (d[i + 3] && Math.max(d[i], d[i + 1], d[i + 2]) <= 24) d[i + 3] = 0;
          }
        }
        g.putImageData(img, 0, 0);
      };
      if (!job.light) {             // the art as it is, no light
        const view = { zoom: 1, offsetX: job.pad.l + one.x - mid.x, offsetY: job.pad.t + one.y - mid.y,
          loadedSectors: new Set(nine.map(s => `${s.position.x},${s.position.y}`)), sectorMap: new Map(nine.map(s => [`${s.position.x},${s.position.y}`, s])) };
        const out = layer();
        if (!job.layer) { ground(out, view); cutBand(out); }
        drawObjects(out, view, null);
        return { dataUrl: out.canvas.toDataURL('image/webp', job.quality), objects: objects.length, lights: 0, scheme: 'no light', ambient: null };
      }
      const lightStats = await L.ensureSecLightArt(nine, around);
      const own = center.decoded.sectorInfo?.lightScheme | 0;
      const sch = await scheme(own > 0 ? own : job.mapScheme);
      const ambient = sch.table[job.hour];

      // with --light: the game's light (game/light.c via js/sec/sec-lighting.js)
      const view = { zoom: 1, offsetX: job.pad.l + one.x - mid.x, offsetY: job.pad.t + one.y - mid.y,
        loadedSectors: new Set(nine.map(s => `${s.position.x},${s.position.y}`)), sectorMap: new Map(nine.map(s => [`${s.position.x},${s.position.y}`, s])),
        light: { enabled: true, table: sch.table, hour: job.hour, animate: false, animTime: 0 } };
      const t = layer(), m = layer(), out = layer(), tb = layer();
      if (!job.layer) {            // tb: black + all the tiles, opaque, tinted whole and only then cut to the diamond; t: the sector's own tiles
        tb.fillStyle = '#000'; tb.fillRect(0, 0, W, H);                  // (tinting a soft, half-clear edge would brighten it into a line)
        drawSecActualTiles(tb, tileSecs, B, tileArt, view);
        drawSecActualTiles(t, [center], B, tileArt, view);
      }
      const model = L.secPrepareLightModel(view, nine, B, iso, ambient, around, job.hour);
      const lighting = L.secMakeLighting(view, B, iso, ambient, model);
      if (!job.layer) {
        L.secDrawLightMask(m, tileSecs, B, view, W, H, ambient, model);
        L.secTintLayer(tb.canvas, m.canvas);
        L.secTintLayer(t.canvas, m.canvas);
        out.save(); out.beginPath(); diamond(out); out.clip(); out.drawImage(tb.canvas, 0, 0); out.restore();
        out.save(); out.beginPath(); out.rect(0, 0, W, H); diamond(out); out.clip('evenodd'); out.drawImage(t.canvas, 0, 0); out.restore();   // only what overhangs the diamond
        cutBand(out);
      }
      drawObjects(out, view, lighting);
      return { dataUrl: out.canvas.toDataURL('image/webp', job.quality), objects: objects.length, lights: model.list.length,
        scheme: sch.name, ambient, lightStats };
    }

    // The world grid: the terrain template of every sector (terrain.tdf), as export_sec_maps.py reads it.
    async function terrainGrid(relativePath, b) {
      const t = await terrain.loadTerrainMap(relativePath);
      if (!t) return null;
      const W = b.maxX - b.minX + 1, H = b.maxY - b.minY + 1, ids = new Uint16Array(W * H), templates = [], index = new Map();
      for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
        const info = t.describe(b.minX + xx, b.minY + yy);
        if (!info?.template) continue;
        let i = index.get(info.template.path);
        if (i === undefined) { i = templates.push({ folder: info.template.folder, file: info.template.file, path: info.template.path, label: info.label }) - 1; index.set(info.template.path, i); }
        ids[yy * W + xx] = i + 1;
      }
      const bytes = new Uint8Array(ids.buffer); let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { templates, grid: btoa(bin) };
    }
    // --glows: the objects standing on some tiles of a sector (job.tiles, sector tiles), each tile's drawn alone without
    // light, one picture per group (n people and creatures, c containers, o anything else but walls). The Atlas makes
    // the glow of what it marks on that tile from the outline.
    async function shapes(job) {
      const [x, y] = job.at;
      const center = await readSector(job.url, job.file, { x, y });
      const diag = { decodeFailures: [], locationFailures: [], staticObjectCount: 0, staticObjectTypeCounts: {}, wallLoaded: 0 };
      const all = (await loadSecStaticObjectPoints([center], diag)).concat((await mobsOf(job)).filter(o => o.sectorX === x && o.sectorY === y));
      // job.tiles: [tile x, tile y, kinds]; per kind only what it is about: n people / creatures, c containers, i items on the floor,
      // s signs and w waypoints (the objects job.pick names: tiers, the first that draws anything is the one)
      const groups = new Map();
      for (const [tx, ty, kinds] of job.tiles) {
        const here = all.filter(o => o.tileX === tx && o.tileY === ty);
        for (const g of kinds) {
          const k = `${tx},${ty},${g}`;
          if (g === 'n') groups.set(k, [here.filter(o => o.type === 15 || o.type === 16)]);
          else if (g === 'c') groups.set(k, [here.filter(o => o.type === 2)]);
          else if (g === 'i') groups.set(k, [here.filter(o => o.type >= 5 && o.type <= 14)]);
          else groups.set(k, (job.pick[`${x * 64 + tx},${y * 64 + ty},${g}`] || []).map(ids => all.filter(o => ids.includes(o.file))));
        }
      }
      const B = { minX: x - 1, maxX: x + 1, minY: y - 1, maxY: y + 1 }, iso = secIsoMetrics(B);
      const one = secIsoProject(0, 0, secIsoMetrics({ minX: 0, maxX: 0, minY: 0, maxY: 0 })), mid = secIsoProject(64, 64, iso);
      const SW = 1024, SH = 1400, CX = 512, CY = 1200;            // the tile's centre lands at (CX, CY)
      const vis = { containers: true, scenery: true, otherMobs: true, walls: false, bounds: false };
      const c = document.createElement('canvas'); c.width = SW; c.height = SH;
      const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = false;
      const res = [];
      for (const [k, tiers] of groups) {
        const [tx, ty, grp] = k.split(','), X = +tx, Y = +ty;
        const px = 40 * (Y - X) + 2560 + job.pad.l, py = 20 * (X + Y) + 20 + job.pad.t;     // the tile's centre in the sector picture
        const ox = job.pad.l + one.x - mid.x - px + CX, oy = job.pad.t + one.y - mid.y - py + CY;
        const view = { zoom: 1, offsetX: ox, offsetY: oy, loadedSectors: new Set([`${x},${y}`]), sectorMap: new Map([[`${x},${y}`, center]]) };
        let x0 = SW, y0 = SH, x1 = -1, y1 = -1;
        for (const objs of tiers) {
          if (!objs.length) continue;
          g.clearRect(0, 0, SW, SH);
          drawSortedObjects(g, view, objs, () => objs, B, 'art', 1, ox, oy, iso, SW, SH, vis, null);
          const d = g.getImageData(0, 0, SW, SH).data;
          x0 = SW; y0 = SH; x1 = -1; y1 = -1;
          for (let yy = 0; yy < SH; yy++) for (let xx = 0, i = yy * SW * 4 + 3; xx < SW; xx++, i += 4) if (d[i] > 24) {
            if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
          }
          if (x1 >= 0) break;
        }
        if (x1 < 0) continue;
        const w = x1 - x0 + 1, h = y1 - y0 + 1, cut = document.createElement('canvas'); cut.width = w; cut.height = h;
        cut.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
        res.push({ tile: [X, Y], g: grp, x: x0 - CX, y: y0 - CY, png: cut.toDataURL('image/png') });
      }
      return res;
    }
    window.__pictures = { render, terrainGrid, shapes };
  } catch (err) { window.__picturesError = String(err?.stack || err); console.error(err); }
})();
</script></body></html>'''


def overrides():
    o = exp.build_headless_overrides(ROOT, exp.find_proto_index(ROOT / 'data' / 'proto'))
    folder_map, n1 = re.subn(r'^function drawSortedObjects\(', 'export function drawSortedObjects(', o['/js/sec/sec-folder-map.js'][0], count=1, flags=re.M)
    lighting, n2 = re.subn(r'^function parseLightSchemeText\(', 'export function parseLightSchemeText(',
                           (ROOT / 'js' / 'sec' / 'sec-lighting.js').read_text(encoding='utf-8'), count=1, flags=re.M)
    # A facade keeps its indoor / outdoor bit at bit 25, not at bit 8 like a tile (tig art.c tig_art_tile_id_type_get;
    # bit 8 of a facade id is part of its frame number): without this every facade is lit with the indoor colour.
    lighting, n3 = re.subn(r'(function secTileIsIndoor\(raw, decoded\) \{\n  raw = Number\(raw\) >>> 0;\n)',
                           r'\1  if ((raw >>> 28) === 11) return ((raw >>> 25) & 1) === 0;\n', lighting, count=1)
    if not (n1 and n2 and n3):
        raise SystemExit('ERROR: the renderer changed: drawSortedObjects / parseLightSchemeText / secTileIsIndoor not found')
    js = 'text/javascript; charset=utf-8'
    o['/js/sec/sec-folder-map.js'] = (folder_map, js)
    o['/js/sec/sec-lighting.js'] = (lighting, js)
    o['/__pictures__.html'] = (PAGE, 'text/html; charset=utf-8')
    return o


def url_of(path):
    return '/' + path.relative_to(ROOT).as_posix()


def shrink(im, factor):                                          # premultiplied, so the transparent margin does not darken edges
    return im.convert('RGBa').resize((max(1, im.width // factor), max(1, im.height // factor)), Image.BOX).convert('RGBA')


OBJ_COLS, OBJ_ROWS = 8, 4                                        # a full-size objects layer is kept in 8 x 4 pieces: the Atlas loads only those in view
# Full-size pictures are kept in pieces too (a whole one is 66 MB once decoded: drawing a few froze the Atlas for seconds):
# L0/<stem>_<col>_<row>.webp 8 x 4 pieces of the full size, H/<stem>_<col>_<row>.webp 4 x 2 pieces of the half size,
# all 688 x 752 px; only the pieces that are not empty. pieces.json keeps their masks per picture.
PIECES = {'L0': (8, 4, 1), 'H': (4, 2, 2)}                       # folder: columns, rows, 1/factor of the full picture


def split_layer(im, folder, stem, cols=OBJ_COLS, rows=OBJ_ROWS, quality=90, method=4):
    """Write the pieces of a picture that are not empty as <folder>/<stem>_<col>_<row>.webp; the mask has bit row*cols+col set for each."""
    tw, th = im.width // cols, im.height // rows
    mask = 0
    for r in range(rows):
        for c in range(cols):
            piece = im.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th))
            if piece.getchannel('A').getbbox() is None:
                continue
            piece.save(folder / f'{stem}_{c}_{r}.webp', 'WEBP', quality=quality, method=method)
            mask |= 1 << (r * cols + c)
    return mask


def split_picture(im, out, stem):
    """The pieces of a full-size picture at full and half size; returns their masks [L0, H]."""
    masks = []
    for sub, (cols, rows, f) in PIECES.items():
        (out / sub).mkdir(parents=True, exist_ok=True)
        masks.append(split_layer(im if f == 1 else shrink(im, f), out / sub, stem, cols, rows, quality=85, method=0))   # 3x faster than 4, same size
    return masks


def piece_stem(p):                                               # sec_123_4_1 -> sec_123
    return p.stem.rsplit('_', 2)[0]


def read_pieces(out):
    try:
        return json.loads((out / 'pieces.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def _split_one(job):
    path, out = job
    with Image.open(path) as im:
        return path.stem, split_picture(im.convert('RGBA'), out, path.stem)


def split_existing_pictures():
    """Turn the whole full-size L0/<stem>.webp pictures of earlier runs into pieces (no rendering needed)."""
    from multiprocessing import Pool
    with Pool(5) as pool:
        for meta in sorted(OUT.glob('*/meta.json')):
            out = meta.parent
            wholes = sorted((out / 'L0').glob('*.webp'))
            pieces = read_pieces(out)
            wholes = [p for p in wholes if not re.search(r'_\d_\d$', p.stem)]
            if not wholes:
                continue
            t0 = time.time()
            for stem, masks in pool.imap_unordered(_split_one, [(p, out) for p in wholes]):
                pieces[stem] = masks
                (out / 'pieces.json').write_text(json.dumps(pieces), encoding='utf-8')   # before the whole picture goes
                (out / 'L0' / f'{stem}.webp').unlink()
            print(f'{out.name}: {len(wholes)} pictures in pieces ({time.time() - t0:.0f} s)', flush=True)
    write_index()


def split_existing_layers():
    """Turn the full-size O0/<stem>.webp files of earlier runs into pieces (no rendering needed)."""
    for f in sorted(OUT.glob('*/objects.json')):
        d = json.loads(f.read_text(encoding='utf-8'))
        masks = d.setdefault('masks', {})
        o0 = f.parent / 'O0'
        for stem in d['stems']:
            whole = o0 / f'{stem}.webp'
            if not whole.is_file():
                continue
            masks[stem] = split_layer(Image.open(whole).convert('RGBA'), o0, stem)
            whole.unlink()
        f.write_text(json.dumps(d), encoding='utf-8')
        print(f'{f.parent.name}: {len(masks)} layers in pieces')
    write_index()


# ---- the maps and their jobs ---------------------------------------------------------------------------------------
class MapJob:
    def __init__(self, folder):
        self.folder, self.key = folder, ('World' if folder == WORLD else clean_map(folder))
        self.dir = OUT / ('world' if folder == WORLD else slug(self.key))
        base = base_of(folder)
        by_xy = {}
        own = [p for p in base.glob('*.sec') if sector_xy(p)]
        subs = [p for d in sorted(base.iterdir(), key=lambda p: p.name.lower()) if d.is_dir() for p in sorted(d.glob('*.sec')) if sector_xy(p)]
        for p in own + subs:                                     # a sector in a town sub-folder replaces the world folder's
            by_xy[sector_xy(p)] = p
        self.by_xy = by_xy
        self.scheme = map_light_scheme(folder)
        mobs = [p.relative_to(base).as_posix() for p in sorted(base.rglob('*.mob'))]
        # the page reads .mob files under /data/maps/: a module's folder is reached from there
        self.mobs = {'key': folder, 'dir': ('../maps-modules/_Modules/' + folder) if folder in MODULE_NAMES else folder, 'files': mobs} if mobs else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--maps', default='all', help='comma-separated map folders or keys (default: every map)')
    ap.add_argument('--skip', default='', help='comma-separated map folders or keys to leave out (e.g. "world", to run it in a second process)')
    ap.add_argument('--modules', action='store_true', help='with every map ("all"): the modules\' maps too (data/maps-modules/_Modules)')
    ap.add_argument('--limit', type=int, default=0, help='only the first N sectors (and N templates) of each map: a test')
    ap.add_argument('--around', default='', help='"x,y,r": only the sectors within r of sector x, y (a test; terrain is still all drawn)')
    ap.add_argument('--no-terrain', action='store_true', help='a test: reuse the terrain pictures on disk, whatever their settings')
    ap.add_argument('--no-light', action='store_true', help="draw the art as it is, without the game's light")
    ap.add_argument('--hour', type=int, default=15, help='the hour of the light schemes (15 = 3 pm)')
    ap.add_argument('--doors', action='store_true', help='draw the doors too')
    ap.add_argument('--objects', action='store_true', help='draw the objects layers instead (people, creatures, items, containers, doors on a clear picture, '
                                                           'shown by the Atlas when zoomed in; people and creatures switched off are left out); '
                                                           'the base pictures must exist')
    ap.add_argument('--off-objects', action='store_true', help='draw the layers of the people and creatures switched off (OF_OFF) instead, which '
                                                               'the Atlas only shows on request')
    ap.add_argument('--force', action='store_true', help='draw again the pictures already made')
    ap.add_argument('--only-index', action='store_true', help='just rewrite map-pictures.js from what is on disk')
    ap.add_argument('--split-objects', action='store_true', help='cut the full-size objects layers already on disk into pieces (no rendering)')
    ap.add_argument('--split-pictures', action='store_true', help='cut the whole full-size pictures already on disk into pieces (no rendering)')
    ap.add_argument('--glows', action='store_true', help='the glows of what the Atlas marks (containers, people, creatures, labels), '
                                                         'shaped on their art: atlas/glows/ and js/atlas/data/glow-shapes.js')
    args = ap.parse_args()
    args.light = not args.no_light
    if args.split_objects:
        split_existing_layers()
        return 0
    if args.split_pictures:
        split_existing_pictures()
        return 0

    folders = sorted(d.name for d in MAPS.iterdir() if d.is_dir() and d.name not in SKIP_FOLDERS)
    if args.modules or args.maps != 'all':
        folders += MODULE_NAMES                                  # (a named map may be a module's; "all" adds them only with --modules)
    named = lambda f, names: f.lower() in names or clean_map(f).lower() in names or (f == WORLD and 'world' in names)
    if args.maps != 'all':
        want = [w.strip().lower() for w in args.maps.split(',') if w.strip()]
        folders = [f for f in folders if named(f, want)]
    skip = [w.strip().lower() for w in args.skip.split(',') if w.strip()]
    folders = [f for f in folders if not named(f, skip)]
    signature = {'version': VERSION, 'light': args.light, 'hour': args.hour if args.light else None, 'doors': args.doors, 'pad': PAD, 'quality': QUALITY, 'ground': GROUND}
    OUT.mkdir(parents=True, exist_ok=True)
    if args.only_index:
        write_index()
        return 0

    socketserver.ThreadingTCPServer.request_queue_size = 128    # the default (5) refuses the page's burst of module requests
    server = exp.start_server(ROOT, overrides())
    url = f'http://127.0.0.1:{server.server_address[1]}'
    errors, state = [], {'browser': None, 'page': None, 'n': 0, 'what': ''}
    t_start = time.time()
    try:
        with sync_playwright() as pw:
            def on_console(m):
                if m.type in ('warning', 'error') and 'status of 404' not in (m.text or ''):
                    errors.append(f'{state["what"]}: {m.type}: {m.text}'[:400])

            def open_page():
                if state['browser']:
                    try:
                        state['browser'].close()
                    except Exception:
                        pass
                b = pw.chromium.launch(headless=True)
                pg = b.new_page(viewport={'width': 800, 'height': 600})
                pg.on('console', on_console)
                pg.on('pageerror', lambda e: errors.append(f'{state["what"]}: page error: {e}'))
                # the page asks for ~60 modules at once and the local server sometimes refuses one: load it again
                for attempt in (1, 2, 3, 4):
                    pg.goto(url + '/__pictures__.html')
                    pg.wait_for_function('() => !!window.__pictures || !!window.__picturesError', timeout=60000)
                    err = pg.evaluate('() => window.__picturesError')
                    if not err:
                        break
                    if attempt == 4:
                        raise RuntimeError(err)
                    time.sleep(1)
                state.update(browser=b, page=pg, n=0)

            def run(script, job):
                if state['page'] is None or state['n'] >= RECYCLE_EVERY:
                    open_page()
                for attempt in (1, 2, 3):
                    # a render that hangs (the page's thread stuck) would wait for ever: after WATCHDOG_S the browser is killed
                    done = threading.Event()
                    def watch():
                        if not done.wait(WATCHDOG_S):
                            subprocess.run(['powershell', '-NoProfile', '-Command',
                                            "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*ms-playwright*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
                                           capture_output=True)
                    threading.Thread(target=watch, daemon=True).start()
                    try:
                        res = state['page'].evaluate(script, job)
                        state['n'] += 1
                        return res
                    except Exception as e:
                        if attempt == 3:
                            raise
                        done.set()
                        print(f' ({type(e).__name__}, restarting the browser)', end='', flush=True)
                        open_page()
                    finally:
                        done.set()

            if args.glows:
                draw_glows(folders, run, state, errors)
                folders = []
            for folder in folders:
                if args.objects or args.off_objects:
                    draw_objects(MapJob(folder), args, signature, run, state, errors, url)
                else:
                    draw_map(MapJob(folder), args, signature, run, state, errors)
            if state['browser']:
                state['browser'].close()
    finally:
        server.shutdown()
        server.server_close()
    write_index()
    log = '\n'.join(dict.fromkeys(errors)) or 'No errors.'
    report = Path(__file__).resolve().parent / 'reports' / 'map-pictures-report.txt'
    report.parent.mkdir(exist_ok=True)
    report.write_text(log + '\n', encoding='utf-8')
    print(f'\nDone in {(time.time() - t_start) / 60:.1f} min. {len(set(errors))} warnings (toolbox/atlas/reports/map-pictures-report.txt).')
    return 0


def draw_map(mj, args, signature, run, state, errors):
    out = mj.dir
    for sub in ('L1', 'L2', 'L3', *PIECES):
        (out / sub).mkdir(parents=True, exist_ok=True)
    meta_file = out / 'meta.json'
    try:
        old = json.loads(meta_file.read_text(encoding='utf-8'))
        kept = set(old.get('drawn', [])) if old.get('signature') == signature and not args.force else set()
    except (OSError, ValueError):
        old, kept = {}, set()
    progress_file = out / 'progress.json'                        # pictures done by a run that did not finish (resumed)
    try:
        prog = json.loads(progress_file.read_text(encoding='utf-8'))
        if prog.get('signature') == signature and not args.force and not (args.limit or args.around):
            kept |= set(prog['drawn'])
    except (OSError, ValueError, KeyError):
        pass
    world = mj.folder == WORLD
    secs = sorted(mj.by_xy.items(), key=lambda kv: (kv[0][1], kv[0][0]))
    if args.around:
        cx, cy, r = map(int, args.around.split(','))
        secs = [kv for kv in secs if abs(kv[0][0] - cx) <= r and abs(kv[0][1] - cy) <= r]
    if args.limit:
        secs = pick(secs, args.limit)
    partial = bool(args.limit or args.around)
    print(f'\n== {mj.key}: {len(secs)} sectors, light scheme {mj.scheme}' + (' (+ terrain)' if world else ''))
    jobs = [('sec', xy, p) for xy, p in secs]

    terrain = None
    if world:
        with open(MAPS / WORLD / 'terrain.tdf', 'rb') as f:
            w, h = struct.unpack_from('<qq', f.read(0x20), 8)
        bounds = {'minX': 0, 'minY': 0, 'maxX': max(w - 1, max(x for x, _ in mj.by_xy)), 'maxY': max(h - 1, max(y for _, y in mj.by_xy))}
        state['what'] = 'terrain.tdf'
        terrain = run('([rel, b]) => window.__pictures.terrainGrid(rel, b)', [WORLD, bounds])
        tpls = list(range(len(terrain['templates'])))
        if args.no_terrain:                                      # a test: keep the terrain pictures already made
            tpls = [i for i in tpls if tpl_stem(terrain['templates'][i]) in read_pieces(out)]
        if args.limit:
            tpls = tpls[:args.limit]
        jobs = [('tpl', i, None) for i in tpls] + jobs
    else:
        xs, ys = [x for x, _ in mj.by_xy], [y for _, y in mj.by_xy]
        bounds = {'minX': min(xs), 'minY': min(ys), 'maxX': max(xs), 'maxY': max(ys)}

    images, drawn, blank = [], set(), set()
    pieces = read_pieces(out)
    for n, (kind, ref, path) in enumerate(jobs, 1):
        if kind == 'tpl':
            tp = terrain['templates'][ref]
            stem = tpl_stem(tp)
            src = ROOT / 'data' / 'terrain' / tp['folder'] / f'{tp["file"]}.sec'
            job = {'url': url_of(src), 'file': src.name, 'at': [0, 0], 'neighbours': [], 'mobs': None, 'wrap': True}
            what = f'terrain/{tp["path"]}'
        else:
            stem = f'sec_{path.stem}'
            x, y = ref
            job = {'url': url_of(path), 'file': path.name, 'at': [x, y], 'mobs': mj.mobs,
                   'neighbours': [{'url': url_of(mj.by_xy[(x + dx, y + dy)]), 'file': mj.by_xy[(x + dx, y + dy)].name, 'at': [x + dx, y + dy]}
                                  for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dx or dy) and (x + dx, y + dy) in mj.by_xy]}
            what = f'{mj.folder}/{path.relative_to(base_of(mj.folder)).as_posix()}'
        job.update(mapScheme=mj.scheme, light=args.light, hour=args.hour, doors=args.doors, pad=PAD, size=[IMG_W, IMG_H], quality=QUALITY)
        state['what'] = what
        have = (stem in kept or (kind == 'tpl' and args.no_terrain)) and stem in pieces and all((out / f'L{k}' / f'{stem}.{"png" if k == 3 else "webp"}').exists() for k in range(1, 4))
        print(f'[{n}/{len(jobs)}] {what} ...', end='', flush=True)
        t0 = time.time()
        if not have:
            try:
                res = run('(job) => window.__pictures.render(job)', job)
            except Exception as e:
                errors.append(f'{what}: FAILED: {e}')
                print(f' FAILED: {e}')
                continue
            if res.get('blank'):
                print(' blank')
                if kind == 'sec':
                    blank.add(ref)
                continue
            raw = base64.b64decode(res['dataUrl'].split(',', 1)[1])
            if not raw.startswith(b'RIFF'):                      # the browser sometimes gives a PNG (memory): once more in a new one
                print(' (no WebP, again)', end='', flush=True)
                state['page'] = None
                res = run('(job) => window.__pictures.render(job)', job)
                raw = base64.b64decode(res['dataUrl'].split(',', 1)[1]) if not res.get('blank') else b''
            if not raw.startswith(b'RIFF'):
                errors.append(f'{what}: FAILED: no WebP')
                print(' FAILED: no WebP')
                continue
            try:
                im = Image.open(io.BytesIO(raw)).convert('RGBA')
            except OSError as e:                                 # a picture the decoder cannot read: leave it out, go on
                errors.append(f'{what}: FAILED: {e}')
                print(f' FAILED: {e}')
                continue
            for sub in PIECES:                                   # pieces of an earlier drawing of it
                for p in (out / sub).glob(f'{stem}_*_*.webp'):
                    if piece_stem(p) == stem:
                        p.unlink()
            pieces[stem] = split_picture(im, out, stem)
            (out / 'pieces.json').write_text(json.dumps(pieces), encoding='utf-8')
            for k, f in LEVELS.items():
                im = shrink(im, f // (1 if k == 1 else LEVELS[k - 1]))
                im.save(out / f'L{k}' / f'{stem}.webp', 'WEBP', quality=85, method=4)
            shrink(im, ATLAS_FACTOR // LEVELS[2]).save(out / 'L3' / f'{stem}.png')
            detail = f'objects {res["objects"]}' + (f', lights {res["lights"]}, {res["scheme"]} {res["ambient"]["outdoor"]}/{res["ambient"]["indoor"]}' if res['ambient'] else '')
        else:
            detail = 'kept'
        drawn.add(stem)
        if not (args.limit or args.around) and len(drawn) % 10 == 0:
            progress_file.write_text(json.dumps({'signature': signature, 'drawn': sorted(drawn)}), encoding='utf-8')
        e = {'stem': stem, 'kind': kind}
        if kind == 'sec':
            e['x'], e['y'] = ref
        else:
            e['tpl'] = ref
        images.append(e)
        print(f' {detail} ({time.time() - t0:.1f} s)')

    # placement grid (picture number + 1 per sector), atlas and colours
    W, H = bounds['maxX'] - bounds['minX'] + 1, bounds['maxY'] - bounds['minY'] + 1
    if world:
        raw = array('H')
        raw.frombytes(base64.b64decode(terrain['grid']))
        lut = [0] * (len(terrain['templates']) + 1)
        for i, e in enumerate(images):
            if e['kind'] == 'tpl':
                lut[e['tpl'] + 1] = i + 1
        cells = array('H', (lut[v] for v in raw))
    else:
        cells = array('H', [0]) * (W * H)
    for i, e in enumerate(images):
        if e['kind'] == 'sec':
            cells[(e['y'] - bounds['minY']) * W + (e['x'] - bounds['minX'])] = i + 1
    for (x, y) in blank:
        cells[(y - bounds['minY']) * W + (x - bounds['minX'])] = 0
    aw, ah = IMG_W // ATLAS_FACTOR, IMG_H // ATLAS_FACTOR
    atlas = Image.new('RGBA', (aw * ATLAS_COLS, ah * max(1, -(-len(images) // ATLAS_COLS))), (0, 0, 0, 0))
    for i, e in enumerate(images):
        with Image.open(out / 'L3' / f'{e["stem"]}.png') as small:
            small = small.convert('RGBA')
            atlas.paste(small, ((i % ATLAS_COLS) * aw, (i // ATLAS_COLS) * ah))
            r, g, b, _ = small.convert('RGBa').resize((1, 1), Image.BOX).convert('RGBA').getpixel((0, 0))
        e['color'] = [r, g, b]
        e['atlas'] = [i % ATLAS_COLS, i // ATLAS_COLS]
        e.pop('tpl', None)
    atlas.save(out / 'atlas.webp', 'WEBP', lossless=True)
    meta = {'key': mj.key, 'folder': mj.folder, 'dir': out.relative_to(ROOT).as_posix(), 'signature': signature,
            'drawn': sorted(drawn | (kept if partial else set())), 'complete': not partial,
            'lightScheme': mj.scheme, 'bounds': bounds, 'gridW': W, 'gridH': H, 'images': images,
            'grid': base64.b64encode(zlib.compress(cells.tobytes(), 9)).decode('ascii')}
    meta_file.write_text(json.dumps(meta, separators=(',', ':')), encoding='utf-8')
    if not partial:                                              # pictures of sectors that are gone (another run's)
        for sub, ext in (('L1', 'webp'), ('L2', 'webp'), ('L3', 'png')):
            for p in (out / sub).glob(f'*.{ext}'):
                if p.stem not in drawn:
                    p.unlink()
        for sub in PIECES:
            for p in (out / sub).glob('*.webp'):
                if piece_stem(p) not in drawn:
                    p.unlink()
        pieces = {s: m for s, m in pieces.items() if s in drawn}
        (out / 'pieces.json').write_text(json.dumps(pieces), encoding='utf-8')
    write_index()


def draw_objects(mj, args, signature, run, state, errors, url):
    """The objects layer of each sector of a map: O0/<stem>.webp full size and O1 at 1/4, only for sectors that have some.
    objects.json keeps which sectors were looked at, so a stopped run carries on. With --off-objects: the layer of the people
    and creatures switched off (OF_OFF) instead, which the objects layer leaves out: F0 / F1 and offobjects.json."""
    out = mj.dir
    meta_file = out / 'meta.json'
    if not meta_file.is_file():
        print(f'\n== {mj.key}: no base pictures yet, skipped')
        return
    off = args.off_objects
    D0, D1 = ('F0', 'F1') if off else ('O0', 'O1')
    sig = dict(signature, objects=True, off_critters='own layer', off=off)
    sig.pop('ground')                                            # the ground does not change the objects layers
    f = out / ('offobjects.json' if off else 'objects.json')
    try:
        old = json.loads(f.read_text(encoding='utf-8'))
        done, has, masks = (set(old['checked']), set(old['stems']), dict(old.get('masks', {}))) if old.get('signature') == sig and not args.force else (set(), set(), {})
    except (OSError, ValueError, KeyError):
        done, has, masks = set(), set(), {}
    save = lambda: f.write_text(json.dumps({'signature': sig, 'checked': sorted(done), 'stems': sorted(has), 'masks': masks}), encoding='utf-8')
    for sub in (D0, D1):
        (out / sub).mkdir(parents=True, exist_ok=True)
    secs = sorted(mj.by_xy.items(), key=lambda kv: (kv[0][1], kv[0][0]))
    if args.around:
        cx, cy, r = map(int, args.around.split(','))
        secs = [kv for kv in secs if abs(kv[0][0] - cx) <= r and abs(kv[0][1] - cy) <= r]
    if args.limit:
        secs = secs[:args.limit]
    print(f'\n== {mj.key}: objects layers of {len(secs)} sectors')
    for n, (xy, path) in enumerate(secs, 1):
        stem = f'sec_{path.stem}'
        if stem in done:
            continue
        x, y = xy
        job = {'url': url_of(path), 'file': path.name, 'at': [x, y], 'mobs': mj.mobs, 'layer': True, 'off': off,
               'neighbours': [{'url': url_of(mj.by_xy[(x + dx, y + dy)]), 'file': mj.by_xy[(x + dx, y + dy)].name, 'at': [x + dx, y + dy]}
                              for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dx or dy) and (x + dx, y + dy) in mj.by_xy]}
        job.update(mapScheme=mj.scheme, light=args.light, hour=args.hour, doors=args.doors, pad=PAD, size=[IMG_W, IMG_H], quality=QUALITY)
        what = f'{mj.folder}/{path.relative_to(base_of(mj.folder)).as_posix()}'
        state['what'] = what
        print(f'[{n}/{len(secs)}] {what} ...', end='', flush=True)
        t0 = time.time()
        try:
            res = run('(job) => window.__pictures.render(job)', job)
            raw = b'' if res.get('blank') else base64.b64decode(res['dataUrl'].split(',', 1)[1])
            if not res.get('blank') and not raw.startswith(b'RIFF'):
                state['page'] = None
                res = run('(job) => window.__pictures.render(job)', job)
                raw = b'' if res.get('blank') else base64.b64decode(res['dataUrl'].split(',', 1)[1])
                if not raw.startswith(b'RIFF'):
                    raise RuntimeError('no WebP')
        except Exception as e:
            errors.append(f'{what}: objects FAILED: {e}')
            print(f' FAILED: {e}')
            continue
        if raw:
            im = Image.open(io.BytesIO(raw)).convert('RGBA')
            masks[stem] = split_layer(im, out / D0, stem)
            shrink(im, 4).save(out / D1 / f'{stem}.webp', 'WEBP', quality=85, method=4)
            has.add(stem)
            print(f' {res["objects"]} objects ({time.time() - t0:.1f} s)')
        else:
            print(' none')
        done.add(stem)
        if len(done) % 10 == 0:
            save()
    save()
    write_index()


# ---- glows -----------------------------------------------------------------------------------------------------------
# What the Atlas marks (its filters: containers, people, creatures, labels) glows in the shape of its own art: each marked
# tile's objects are drawn alone, and their outline, widened and blurred, becomes a halo (faint over the figure itself, so it
# stays readable). Halos are kept at half size, packed in sheets of GLOW_SHEET px (like the item icons); identical ones once.
GLOW_DIR = ROOT / 'atlas' / 'glows'
GLOW_JS = DATA_JS / 'glow-shapes.js'
GLOW_R, GLOW_SCALE, GLOW_SHEET = 7, 2, 1024


def read_js_globals(path):
    """The window.<Name> = {...}; objects of a generated data file."""
    text, dec, out = path.read_text(encoding='utf-8'), json.JSONDecoder(), {}
    for m in re.finditer(r'window\.(\w+)\s*=\s*', text):
        out[m.group(1)], _ = dec.raw_decode(text, m.end())
    return out


def glow_marks():
    """map key ('World' or a map of submaps.js) -> {(world tile x, y): kinds}, the tiles the Atlas can make glow, and what for:
    n people and creatures, c containers, i what lies on the floor, s signs (notices.js), w waypoints (waypoints.js)."""
    marks = {}

    def add(key, t, kind):
        if t:
            marks.setdefault(key, {}).setdefault((int(t[0]), int(t[1])), set()).add(kind)
    g = {}
    for f in ('items.js', 'notices.js', 'waypoints.js', 'modules.js', 'npcs.js', 'creatures.js', 'subcreatures.js', 'submaps.js'):
        g.update(read_js_globals(DATA_JS / f))
    for c in g['ArcanumItems']['containers']:
        add('World' if c.get('world') else c.get('place'), c.get('tile'), 'c')
    for c in g['ArcanumItems']['ground']:
        add('World' if c.get('world') else c.get('place'), c.get('tile'), 'i')
    for n in g['ArcanumNotices']['notices']:
        add(n[0] or 'World', (n[2], n[3]), 's')
    for r in g['ArcanumWaypoints']['waypoints']:
        add(r[0] or 'World', (r[2], r[3]), 'w')
    for name, sub in (('ArcanumNpcs', False), ('ArcanumCreatures', False), ('ArcanumSubNpcs', True), ('ArcanumSubCreatures', True)):
        d = g[name]
        for r in d['npcs']:
            add(d['places'][r[0]] if sub else 'World', (r[1], r[2]), 'n')
    M = g['ArcanumModules']                                       # the people of the modules' maps
    for r in M['npcs'] + M['creatures']:
        add(M['places'][r[0]], (r[1], r[2]), 'n')
    return marks


# What a glow is put on: not everything on the marked tile (a bucket under a sign, a bush around a herb), only the thing itself.
DOORLIKE = re.compile(r'door|gate|entrance|exit|stair|ladder|hatch|passage|manhole|trap ?door|portal|arch|cave|tunnel|opening|elevator|lift|grate',
                      re.I)


def glow_picks(folder, by_sec, marks):
    """For the signs ('s') and waypoints ('w') of a map: {"x,y,k": [tier, ...]}, a tier = the ids of the objects to glow
    (static: '<sector file>#object<i>', else the .mob's file name). The picture of the first tier that shows anything is used.
      sign:     the object(s) at the tile with the script that prints it (and the other pieces of that script within a few
                tiles: a long board), else the named scenery at the tile (a shop sign has no script);
      waypoint: the object(s) with the teleport script (a double door: both), else, for a script on a tile or on something
                invisible, the door-like object nearest to it."""
    import arcanum_objects as ao
    import build_notices as bn
    import build_waypoints as bw
    notice_scripts = set(bn.read_scripts())
    tele = set(bw.teleports())
    want = {k: v for k, v in marks.items() if v & {'s', 'w'}}
    if not want:
        return {}
    desc = ao.descriptions()
    base = base_of(folder)
    recs = []                                                    # one per portal / container / scenery in a sector with a mark
    sectors = {(X >> 6, Y >> 6) for X, Y in want}
    def rec(o, ident):
        if o.type not in (1, 2, 3) or not o.tile:
            return
        scripts = set(bw.scripts_of(o))
        own = (desc.get(o.get(23)) or '').strip() if o.get(23) else ''
        recs.append({'id': ident, 'type': o.type, 'x': o.tile[0], 'y': o.tile[1], 'scripts': scripts,
                     'hooked': {n for _h, n in bn.hooked(o)}, 'own': own, 'name': (desc.get(o.proto - 20) or '').strip(), 'proto': o.proto})
    for xy, path in by_sec.items():
        if xy in sectors:
            for i, o in enumerate(ao.sec_objects(path)):
                rec(o, f'{path.name}#object{i}')
    for mob in base.rglob('*.mob'):
        try:
            o = ao.read_mob(mob)
        except Exception:
            continue
        if o.tile and (o.tile[0] >> 6, o.tile[1] >> 6) in sectors:
            rec(o, mob.name)
    at = {}
    for (X, Y), kinds in want.items():
        here = [r for r in recs if r['x'] == X and r['y'] == Y]
        near = lambda r: abs(r['x'] - X) <= bn.MERGE and abs(r['y'] - Y) <= bn.MERGE
        if 's' in kinds:
            mine = {n for r in here for n in r['hooked'] if n in notice_scripts}
            tier = [r['id'] for r in recs if near(r) and r['hooked'] & mine] if mine else []
            if not tier:                                        # a shop or street sign: scenery named after what it says
                tier = [r['id'] for r in here if r['type'] == 3 and r['own'] and not bn.NOT_A_SIGN.search(r['own'])]
            if tier:
                at[f'{X},{Y},s'] = [tier]
        if 'w' in kinds:
            mine = {n for r in here for n in r['scripts'] if n in tele}
            tiers = []
            if mine:
                tiers.append([r['id'] for r in recs if near(r) and r['scripts'] & mine])
            doors = sorted((r for r in recs if r['type'] == 1 or DOORLIKE.search(r['name'] + ' ' + r['own']) and r['type'] == 3),
                           key=lambda r: max(abs(r['x'] - X), abs(r['y'] - Y)))
            doors = [r for r in doors if max(abs(r['x'] - X), abs(r['y'] - Y)) <= 3]
            if doors:                                           # the nearest door-like thing, with its twin (a double door)
                d = doors[0]
                tiers.append([r['id'] for r in doors if r['proto'] == d['proto'] and max(abs(r['x'] - d['x']), abs(r['y'] - d['y'])) <= 1])
            if tiers:
                at[f'{X},{Y},w'] = tiers
    return at


def halo(cut):
    """The glow around the art of a cut-out (RGBA): its outline widened and blurred, faint over the art itself; half size."""
    from PIL import ImageChops, ImageFilter
    m = 3 * GLOW_R
    a = Image.new('L', (cut.width + 2 * m, cut.height + 2 * m), 0)
    a.paste(cut.getchannel('A').point(lambda v: 255 if v > 40 else 0), (m, m))
    glow = a.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(GLOW_R)).point(lambda v: min(255, v * 2))
    inner = a.filter(ImageFilter.GaussianBlur(1.5)).point(lambda v: 255 - int(v * 0.86))
    h = ImageChops.multiply(glow, inner)
    h = h.resize((max(1, h.width // GLOW_SCALE), max(1, h.height // GLOW_SCALE)), Image.BOX)
    out = Image.new('RGBA', h.size, (255, 255, 255, 0))
    out.putalpha(h)
    return out, m


def silhouette(cut):
    """The art's own outline at full size (white, opaque where the art is): the Atlas lifts the selected figure out of the map
    picture through it and puts it back in front of its glow."""
    out = Image.new('RGBA', cut.size, (255, 255, 255, 0))
    out.putalpha(cut.getchannel('A').point(lambda v: 255 if v > 40 else 0))
    return out


def pack_sheets(pics, prefix):
    """Shelf packing, tallest first, in sheets of GLOW_SHEET x GLOW_SHEET (glows/<prefix>-<n>.webp): [sheet, x, y, w, h] each."""
    for p in GLOW_DIR.glob(f'{prefix}-*.webp'):
        p.unlink()
    place, sheets = [None] * len(pics), []
    x = y = row = 0
    for i in sorted(range(len(pics)), key=lambda i: -pics[i].height):
        w, h = min(pics[i].width, GLOW_SHEET), min(pics[i].height, GLOW_SHEET)
        if x + w > GLOW_SHEET:
            x, y, row = 0, y + row, 0
        if not sheets or y + h > GLOW_SHEET:
            sheets.append(Image.new('RGBA', (GLOW_SHEET, GLOW_SHEET), (255, 255, 255, 0)))
            x = y = row = 0
        sheets[-1].paste(pics[i].crop((0, 0, w, h)), (x, y))
        place[i] = [len(sheets) - 1, x, y, w, h]
        x, row = x + w, max(row, h)
    for n, s in enumerate(sheets):
        bb = s.getchannel('A').getbbox() or (0, 0, 1, 1)
        s.crop((0, 0, GLOW_SHEET, bb[3])).save(GLOW_DIR / f'{prefix}-{n}.webp', 'WEBP', lossless=True)
    return place, len(sheets)


def draw_glows(folders, run, state, errors):
    import hashlib
    marks = glow_marks()
    shapes, ids, at = [], {}, {}                                  # shapes: halo pictures; at[map]["X,Y"][group] = [shape, dx, dy, mask]
    masks, mask_ids = [], {}                                      # masks: the art's own outline (full size, top-left at dx + m, dy + m)
    t0 = time.time()
    for folder in folders:
        mj = MapJob(folder)
        tiles = marks.get(mj.key)
        if not tiles:
            continue
        by_sec = {}
        for (X, Y), kinds in tiles.items():
            by_sec.setdefault((X // 64, Y // 64), []).append([X % 64, Y % 64, ''.join(sorted(kinds))])
        picks = glow_picks(folder, mj.by_xy, tiles)
        found = 0
        for n, (xy, local) in enumerate(sorted(by_sec.items(), key=lambda kv: (kv[0][1], kv[0][0])), 1):
            path = mj.by_xy.get(xy)
            if not path:
                continue
            state['what'] = f'{mj.folder}/{path.name} glows'
            job = {'url': url_of(path), 'file': path.name, 'at': list(xy), 'mobs': mj.mobs, 'tiles': local, 'pad': PAD,
                   'pick': {k: v for k, v in picks.items() if (int(k.split(',')[0]) >> 6, int(k.split(',')[1]) >> 6) == xy}}
            try:
                res = run('(job) => window.__pictures.shapes(job)', job)
            except Exception as e:
                errors.append(f'{state["what"]}: FAILED: {e}')
                continue
            for r in res:
                cut = Image.open(io.BytesIO(base64.b64decode(r['png'].split(',', 1)[1]))).convert('RGBA')
                h, m = halo(cut)
                key = hashlib.md5(h.tobytes() + bytes(str(h.size), 'ascii')).hexdigest()
                if key not in ids:
                    ids[key] = len(shapes)
                    shapes.append(h)
                s = silhouette(cut)
                mkey = hashlib.md5(s.tobytes() + bytes(str(s.size), 'ascii')).hexdigest()
                if mkey not in mask_ids:
                    mask_ids[mkey] = len(masks)
                    masks.append(s)
                X, Y = xy[0] * 64 + r['tile'][0], xy[1] * 64 + r['tile'][1]
                at.setdefault(mj.key, {}).setdefault(f'{X},{Y}', {})[r['g']] = [ids[key], r['x'] - m, r['y'] - m, mask_ids[mkey]]
                found += 1
            print(f'\r{mj.key}: {n}/{len(by_sec)} sectors, {found} glows, {len(shapes)} shapes', end='', flush=True)
        print(f'  ({len(tiles)} marked tiles)')
    GLOW_DIR.mkdir(parents=True, exist_ok=True)
    place, n_sheets = pack_sheets(shapes, 'glows')
    mask_place, n_mask_sheets = pack_sheets(masks, 'masks')
    data = {'note': 'GENERATED by toolbox/atlas/build_map_pictures.py --glows. shapes[i] = [sheet, x, y, w, h] in atlas/glows/glows-<sheet>.webp, '
                    f'drawn {GLOW_SCALE}x; at[map]["X,Y"][n people and creatures | c containers | i items on the floor | s signs | w waypoints] = [shape, dx, dy, mask]: dx, dy '
                    f'= world px of the halo\'s top-left from the centre of tile (X, Y); masks[mask] = [sheet, x, y, w, h] in '
                    f'atlas/glows/masks-<sheet>.webp, the art\'s outline at full size, its top-left {3 * GLOW_R} px right of and below the halo\'s.',
            'scale': GLOW_SCALE, 'margin': 3 * GLOW_R, 'sheets': n_sheets, 'shapes': place, 'maskSheets': n_mask_sheets, 'masks': mask_place, 'at': at}
    GLOW_JS.write_text('// GENERATED by toolbox/atlas/build_map_pictures.py - re-run it rather than editing by hand.\n'
                       'window.ArcanumGlows = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(f'{len(shapes)} shapes in {n_sheets} sheets, {len(masks)} outlines in {n_mask_sheets} sheets ({time.time() - t0:.0f} s)')


def tpl_stem(tp):
    return 'tpl_' + re.sub(r'[^A-Za-z0-9_.-]+', '_', f'{tp["folder"]}__{tp["file"]}')


def pick(secs, n):
    """A test run: n sectors spread over the map, the busiest first (most bytes: walls, scenery, lights)."""
    return sorted(sorted(secs, key=lambda kv: -kv[1].stat().st_size)[:n], key=lambda kv: (kv[0][1], kv[0][0]))


def write_index():
    maps = {}
    for f in sorted(OUT.glob('*/meta.json')):
        m = json.loads(f.read_text(encoding='utf-8'))
        pieces = read_pieces(f.parent)                           # p: masks of the full and half-size pieces (bit row*cols+col)
        maps[m['key']] = {k: m[k] for k in ('dir', 'bounds', 'gridW', 'gridH', 'grid', 'complete')} | {
            'images': [{'stem': e['stem'], 'kind': e['kind'], 'color': e['color'], 'atlas': e['atlas']} | ({'p': pieces[e['stem']]} if e['stem'] in pieces else {})
                       for e in m['images']]}
        for file, k in (('objects.json', 'objects'), ('offobjects.json', 'offObjects')):
            try:                                                 # sectors with an objects layer (--objects, --off-objects), as picture numbers
                od = json.loads((f.parent / file).read_text(encoding='utf-8'))
                have = set(od['stems']) & set(od.get('masks', {}))
                idx = [i for i, e in enumerate(m['images']) if e['stem'] in have]
                maps[m['key']][k] = idx                          # picture numbers, and which of the 8 x 4 full-size pieces are not empty (bit row*8+col)
                maps[m['key']][k[:-1] + 'Masks'] = [od['masks'][m['images'][i]['stem']] for i in idx]
            except (OSError, ValueError, KeyError):
                pass
    data = {'note': 'GENERATED by toolbox/atlas/build_map_pictures.py. Per map: sector pictures (L0 full and H 1/2 in pieces, L1 1/4, L2 1/16, '
                    'atlas.webp 1/64), grid = picture number + 1 per sector of bounds (zlib, uint16).',
            'sector': {'w': SECTOR_W, 'h': SECTOR_H}, 'pad': PAD, 'img': {'w': IMG_W, 'h': IMG_H}, 'levels': {str(k): v for k, v in LEVELS.items()},
            'pieces': {k: [c, r, f] for k, (c, r, f) in PIECES.items()},
            'atlas': {'w': IMG_W // ATLAS_FACTOR, 'h': IMG_H // ATLAS_FACTOR, 'cols': ATLAS_COLS}, 'maps': maps}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_map_pictures.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumPictures = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')


if __name__ == '__main__':
    sys.exit(main())
