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
Every map with a terrain.tdf (the world, but also modules like Bourrin or Dungeon Crawl 2) gets one picture per terrain
template (data/terrain/<folder>/<n>.sec) its grid uses: every sector without a .sec of its own is that template, so one
picture serves thousands of sectors (as in the game). The templates' pictures are in atlas/terrain/, shared by all maps
(drawn with the world's light scheme); a map's meta.json grid points at them (images of kind "tpl").

This is the OVERVIEW pass and the headless renderer of the Live builders (live/live_pack.py, live/live_objects.py). The ground itself is not
a picture: it is the .atlassec files and the art shards that live/live_pack.py writes, and the objects (people, creatures, items, containers,
doors) are the .atlasmob files of live/live_objects.py. What this script writes, in atlas/maps/<map>/ (the world in atlas/world/, a module's map
in atlas/modules/<map>/):  atlas.webp (every sector's picture at 1/64: the map's overview and the colour of each sector) and meta.json (the
sectors, their grid cell, the settings). js/atlas/data/map-pictures.js (window.ArcanumPictures) lists them for the map view of index.html.
Sectors already drawn with the same settings are kept (cut from the old atlas.webp), so a stopped run carries on where it was.
--glows: the glows the Atlas puts on what its filters mark, in the shape of each thing's art (atlas/graphics/glow-shards/, built from js/atlas/data/glow-shapes.js).

Needs Playwright with Chromium and Pillow.   py build_map_pictures.py [--maps "Tarant Sewers-02,BMC"] [--limit 4]
"""
import argparse
import base64
import hashlib
import io
import json
import math
import numpy as np
import os
import re
import shutil
import socketserver
import struct
import sys
import subprocess
import threading
import time
import zlib
from array import array

import arcanum_objects as ao
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'toolbox'))
import export_sec_maps as exp                                   # noqa: E402  (read-only: its local server + headless modules)
import sec_alias                                                  # noqa: E402
from playwright.sync_api import sync_playwright                  # noqa: E402

from arcanum_objects import clean_map                             # noqa: E402  (the map key the Atlas uses)

DATA_JS = ao.DATA_JS                   # the generated data the pages load
MAPS = ROOT / 'data' / 'maps'
MODULES = ROOT / 'data' / 'modules'            # the maps of the modules: one folder each, drawn like the game's own maps (--modules)
MAIN_MAP = {'Vormantown': 'maps/Multiplayer-Map', 'Bourrin': 'maps/bourin', 'Buried Secrets': 'maps/MainMap', 'Dusty Dunes': 'maps/Dusty Dunes', 'Hellgate': 'maps/Main', 'Hell Day': 'maps/Main', 'Arcanum City': 'maps/Island Arcanum-City', 'Addon01': 'maps/village01', 'Lost Dungeon of Souls': 'maps/MainMap'}               # (same as build_modules.MAIN_MAP) a full module's map folder
ALL_MAPS = ('MuHu', 'Deathmatch', 'Time', 'Woodmir Race', 'Affaire', 'Livre Ombres', 'Mystere', 'Naufrageur', 'Resident Eval', 'Secret', 'Tombeau', 'Tresor', 'Vallee', 'Battlearena', 'Deep15', 'Delirium of Evil', 'Doomsday', 'Dungeon of Quests', 'Escape Tarant', 'Grayhills', 'Terror', 'The Killer Inside', 'Virgil the Pervert', 'WhiteSands', 'Dolores 0.25')                                         # (same as build_modules.ALL_MAPS) modules shown as one map per maps/<name> folder, "<module> - <name>"
MODULE_MAP = {}                                                  # a module map's id -> its folder under MODULES
for _d in (sorted(MODULES.iterdir()) if MODULES.is_dir() else []):
    if not _d.is_dir():
        continue
    if _d.name in ALL_MAPS:
        for _s in sorted((_d / 'maps').iterdir(), key=lambda p: p.name.lower()):
            if _s.is_dir() and _s.name != 'ShopMap' and ao.has_suffix(_s, '.mob') and not _s.name.endswith('_original'):
                MODULE_MAP[f'{_d.name} - {_s.name}'] = f'{_d.name}/maps/{_s.name}'
    else:
        MODULE_MAP[_d.name] = _d.name + ('/' + MAIN_MAP[_d.name] if _d.name in MAIN_MAP else '')
MODULE_NAMES = sorted(MODULE_MAP)
OUT = ROOT / 'atlas' / 'maps'                                   # the game's maps
OUT_WORLD = ROOT / 'atlas' / 'world'                             # the world map (its own rules)
OUT_TERRAIN = ROOT / 'atlas' / 'terrain'                         # one picture per terrain template (data/terrain), shared by every map whose terrain.tdf uses it
OUT_MODULES = ROOT / 'atlas' / 'modules'                         # the modules' maps
BLANK_SEC_MD5 = ('abf3ae75', 'f23dbda2')                          # the editor's two empty sector templates (Blk tile everywhere, nothing else): prune_blank_sectors.py


def drop_fillers(by_xy, xys):
    """xys (the sectors a mod adds or changes) without the blank fillers (BLANK_SEC_MD5) that have no real sector of xys around them; by_xy:
    (x, y) -> .sec of the map as shown. A real room next to a filler that the mod does not change is in the base game's pictures (margins
    included), so the filler's own picture can only come out black. The mods' builders use it to pick what to draw BEFORE drawing: mods
    ship the fillers the base game no longer has (deleted 2026-10-14), and drawing them made black pictures and map folders holding
    nothing but atlas.webp and their bookkeeping (69 of them on 2026-10-18)."""
    memo = {}
    def filler(xy):
        p = by_xy[xy]
        if p not in memo:
            memo[p] = hashlib.md5(Path(p).read_bytes()).hexdigest().startswith(BLANK_SEC_MD5)
        return memo[p]
    xys = set(xys)
    return {(x, y) for x, y in xys
            if not filler((x, y)) or any((x + dx, y + dy) in xys and not filler((x + dx, y + dy)) for dy in (-1, 0, 1) for dx in (-1, 0, 1))}
NOT_IN_LAYER = {0, 3}                                             # walls and scenery: an objects layer draws every other object (the page's job.layer filter)
OUT_JS = DATA_JS / 'map-pictures.js'
GRIDS_JS = DATA_JS / 'map-grids.js'                             # (the grids of the maps but the world: write_index_files)
WORLD = 'Arcanum1-024-fixed'
SKIP_FOLDERS = set()                                             # (ShopMap and Scienticians Underground Lev 1 / 2 are not in Rules/MapList.mes: no door leads there, they are the Atlas's "Unreachable maps")
PAD = {'l': 192, 't': 384, 'r': 192, 'b': 64}                  # multiples of 64, so the 1/64 copy is exact
SECTOR_W, SECTOR_H = 5120, 2560
IMG_W, IMG_H = SECTOR_W + PAD['l'] + PAD['r'], SECTOR_H + PAD['t'] + PAD['b']
LEVELS = {1: 4, 2: 16}                                           # (the zoom steps the Atlas switches Live detail at, in map-pictures.js: world-atlas.js reads them; no pictures of these sizes exist)
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


def map_dirs():
    """Every map's picture folder: the world, the game's maps, the modules'."""
    return [OUT_WORLD] * OUT_WORLD.is_dir() + sorted(p for p in OUT.glob('*') if p.is_dir()) + sorted(p for p in OUT_MODULES.glob('*') if p.is_dir())


def metas():
    return [d / 'meta.json' for d in map_dirs() if (d / 'meta.json').is_file()]


def base_of(folder):
    return MODULES / MODULE_MAP[folder] if folder in MODULE_MAP else MAPS / folder


def terrain_size(folder):
    """(width, height) in sectors of a map's terrain.tdf, or None: no such file, or a 1 x 1 grid (the interiors' stubs)."""
    for name in ('terrain.tdf', 'TERRAIN.TDF'):
        p = base_of(folder) / name
        if p.is_file():
            head = p.read_bytes()[:0x20]
            if len(head) < 0x20 or abs(struct.unpack_from('<f', head, 0)[0] - 1.2) > 1e-4:
                return None
            w, h = struct.unpack_from('<qq', head, 8)
            return (w, h) if w * h > 1 and w * h <= 1 << 24 else None
    return None


def blocked_terrains():
    """The base terrains terrain.mes marks as blocked ("/b": water, mountains...), lower case."""
    names = re.findall(r'^\{(\d+)\}\{([^}]*)\}', (ROOT / 'data' / 'terrain' / 'terrain.mes').read_text(encoding='cp1252', errors='replace'), re.M)
    return {n.split('/b')[0].strip().lower() for i, n in names if int(i) < 32 and '/b' in n}


def rel_of(folder):
    """The map folder as the page reads it under /data/maps/ (a module's is reached from there)."""
    return ('../modules/' + MODULE_MAP[folder]) if folder in MODULE_MAP else folder


class Dest:
    """Where pictures go: a map's own folder, or the terrain folder. What was kept from an earlier run (same settings) and what
    this run has drawn / found black."""
    def __init__(self, out, kept, kept_black, with_objects=()):
        self.out, self.kept, self.kept_black, self.with_objects = out, kept, kept_black, with_objects
        self.drawn, self.black = set(), set()


def terrain_dest(signature, force):
    """atlas/terrain/: the templates' 1/64 pictures (L3/<stem>.png, kept here for the maps' atlas.webp) and meta.json (settings, which are drawn / black);
    the templates' ground is their .atlassec files (live/live_pack.py)."""
    (OUT_TERRAIN / 'L3').mkdir(parents=True, exist_ok=True)
    try:
        old = json.loads((OUT_TERRAIN / 'meta.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        old = {}
    same = old.get('signature') == signature and not force
    return Dest(OUT_TERRAIN, set(old.get('drawn', [])) if same else set(), set(old.get('black', [])) if same else set())


def save_terrain(T, signature):
    (OUT_TERRAIN / 'meta.json').write_text(json.dumps({'signature': signature, 'drawn': sorted(T.kept | T.drawn), 'black': sorted(T.kept_black | T.black)}), encoding='utf-8')


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
      if (!mobCache.has(job.mobs.key)) mobCache.set(job.mobs.key, loadMobsForSecMap('maps/' + job.mobs.dir, { files: job.mobs.files, relativeNames: true }));
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
      // A transition template has no tiles to give the band (it is not seamless with itself), so its band was cleared and the
      // picture ends on a hard edge: laid next to another, the two soft, half-clear edges let the background show as a line.
      // The band is filled by stretching the sector's own edge outwards (each pixel takes the colour of the one at the same
      // angle, just inside the edge), so the neighbours overlap there as they do with real tiles.
      const extendBand = g => {
        const img = g.getImageData(0, 0, W, H), d = img.data, src = new Uint8ClampedArray(d), cx = job.pad.l + 2560, cy = job.pad.t + 1280;
        const k = 6 * Math.hypot(2560, 1280) / (2560 * 1280), inside = 1 - 3 * Math.hypot(2560, 1280) / (2560 * 1280);   // (ex of the pixel to copy: 3 px inside)
        for (let py = Math.max(0, job.pad.t - 8); py < Math.min(H, job.pad.t + 2568); py++) {
          const ry = Math.abs(py + 0.5 - cy) / 1280;
          for (let px = Math.max(0, job.pad.l - 8); px < Math.min(W, job.pad.l + 5128); px++) {
            const ex = Math.abs(px + 0.5 - cx) / 2560 + ry;
            if (ex <= 1 || ex > 1 + k) continue;
            const i = (py * W + px) * 4;
            if (d[i + 3] === 255) continue;
            const f = inside / ex, sx = Math.floor(cx + (px + 0.5 - cx) * f), sy = Math.floor(cy + (py + 0.5 - cy) * f);
            if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
            const j = (sy * W + sx) * 4;
            if (src[j + 3] !== 255) continue;
            d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; d[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
      };
      if (!job.light) {             // the art as it is, no light
        const view = { zoom: 1, offsetX: job.pad.l + one.x - mid.x, offsetY: job.pad.t + one.y - mid.y,
          loadedSectors: new Set(nine.map(s => `${s.position.x},${s.position.y}`)), sectorMap: new Map(nine.map(s => [`${s.position.x},${s.position.y}`, s])) };
        const out = layer();
        if (!job.layer) { ground(out, view); cutBand(out); if (job.wrap === false) extendBand(out); }
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
        if (job.wrap === false) extendBand(out);
      }
      drawObjects(out, view, lighting);
      return { dataUrl: out.canvas.toDataURL('image/webp', job.quality), objects: objects.length, lights: model.list.length,
        scheme: sch.name, ambient, lightStats };
    }

    // The world grid: the terrain template of every sector (terrain.tdf), as export_sec_maps.py reads it.
    async function terrainGrid(relativePath, b) {
      const t = await terrain.loadTerrainMap(relativePath, 1);          // (any grid: a module's outdoor map has a small one)
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
      // One glow per object (n, c, i: each object of the tile; s: each piece job.pick names under "each"); w keeps its tiers.
      // group: {tx, ty, g, tiers: [[objects]], ids: the first object id of each tier}; the result says which tier drew (its id).
      const groups = new Map();
      for (const [tx, ty, kinds] of job.tiles) {
        const here = all.filter(o => o.tileX === tx && o.tileY === ty);
        for (const g of kinds) {
          if (g === 'n' || g === 'c' || g === 'i') {
            const sel = g === 'n' ? here.filter(o => o.type === 15 || o.type === 16) : g === 'c' ? here.filter(o => o.type === 2) : here.filter(o => o.type >= 5 && o.type <= 14);
            for (const o of sel) groups.set(`${tx},${ty},${g},${o.file}`, { tx, ty, g, tiers: [[o]], ids: [o.file] });
            continue;
          }
          const p = job.pick[`${x * 64 + tx},${y * 64 + ty},${g}`];
          if (!p) continue;
          if (p.each) p.each.forEach((ids, i) => groups.set(`${tx},${ty},${g},e${i}`, { tx, ty, g, tiers: [all.filter(o => ids.includes(o.file))], ids: [ids[0]] }));
          else groups.set(`${tx},${ty},${g}`, { tx, ty, g, tiers: p.map(ids => all.filter(o => ids.includes(o.file))), ids: p.map(ids => ids[0]) });
        }
      }
      const B = { minX: x - 1, maxX: x + 1, minY: y - 1, maxY: y + 1 }, iso = secIsoMetrics(B);
      const one = secIsoProject(0, 0, secIsoMetrics({ minX: 0, maxX: 0, minY: 0, maxY: 0 })), mid = secIsoProject(64, 64, iso);
      const SW = 1024, SH = 1400, CX = 512, CY = 1200;            // the tile's centre lands at (CX, CY)
      const vis = { containers: true, scenery: true, otherMobs: true, walls: false, bounds: false };
      const c = document.createElement('canvas'); c.width = SW; c.height = SH;
      const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = false;
      const res = [];
      for (const { tx, ty, g: grp, tiers, ids: tierIds } of groups.values()) {
        const X = +tx, Y = +ty;
        let used = -1;
        const px = 40 * (Y - X) + 2560 + job.pad.l, py = 20 * (X + Y) + 20 + job.pad.t;     // the tile's centre in the sector picture
        const ox = job.pad.l + one.x - mid.x - px + CX, oy = job.pad.t + one.y - mid.y - py + CY;
        const view = { zoom: 1, offsetX: ox, offsetY: oy, loadedSectors: new Set([`${x},${y}`]), sectorMap: new Map([[`${x},${y}`, center]]) };
        let x0 = SW, y0 = SH, x1 = -1, y1 = -1;
        for (let ti = 0; ti < tiers.length; ti++) {
          const objs = tiers[ti];
          if (!objs.length) continue;
          g.clearRect(0, 0, SW, SH);
          drawSortedObjects(g, view, objs, () => objs, B, 'art', 1, ox, oy, iso, SW, SH, vis, null);
          const d = g.getImageData(0, 0, SW, SH).data;
          x0 = SW; y0 = SH; x1 = -1; y1 = -1;
          for (let yy = 0; yy < SH; yy++) for (let xx = 0, i = yy * SW * 4 + 3; xx < SW; xx++, i += 4) if (d[i] > 24) {
            if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
          }
          if (x1 >= 0) { used = ti; break; }
        }
        if (x1 < 0) continue;
        const w = x1 - x0 + 1, h = y1 - y0 + 1, cut = document.createElement('canvas'); cut.width = w; cut.height = h;
        cut.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
        res.push({ tile: [X, Y], g: grp, id: tierIds[used], x: x0 - CX, y: y0 - CY, png: cut.toDataURL('image/png') });
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


PIECES = {'L0': (8, 4, 1), 'L0.5': (4, 2, 2)}                     # (only written to map-pictures.js: world-atlas.js takes its half-size zoom step from it; no pieces of these sizes exist)


def only_black(im):
    """True if what shows of an RGBA picture is black (or nothing shows)."""
    a = im.getchannel('A')
    if a.getbbox() is None:
        return True
    seen = a.point(lambda x: 255 if x > 8 else 0)
    zero = Image.new('L', im.size, 0)
    shown = [Image.composite(im.getchannel(c), zero, seen) for c in 'RGB']
    if any(ch.getextrema()[1] > 24 for ch in shown):
        return False
    # black with a few lighter specks (lossy pictures, an edge's anti-aliasing), not dark ground (the Void's is ~15, 11, 8)
    lit = sum(ch.point(lambda x: 255 if x > 8 else 0).histogram()[255] for ch in shown)
    return lit <= 0.001 * max(1, seen.histogram()[255])


def widen(im, w):
    """A copy of a full-size picture whose opaque ground reaches w px outside the sector's diamond (3 px of real tiles, or a
    transition template's stretched edge, are there already): the colour of the pixel just inside the edge on the same line to
    the centre. In a smaller copy that band is less than a pixel, so the half-clear edge pixels of two neighbours would both
    let the background through as a line; w = the shrink factor makes the edge pixel opaque."""
    a = np.array(im.convert('RGBA'))
    cx, cy = PAD['l'] + SECTOR_W / 2, PAD['t'] + SECTOR_H / 2
    per = math.hypot(SECTOR_W / 2, SECTOR_H / 2) / (SECTOR_W / 2 * SECTOR_H / 2)            # ex units per px across the edge
    y0, y1 = max(0, PAD['t'] - w - 2), min(a.shape[0], PAD['t'] + SECTOR_H + w + 2)
    x0, x1 = max(0, PAD['l'] - w - 2), min(a.shape[1], PAD['l'] + SECTOR_W + w + 2)
    ys, xs = np.mgrid[y0:y1, x0:x1]
    ex = np.abs(xs + 0.5 - cx) / (SECTOR_W / 2) + np.abs(ys + 0.5 - cy) / (SECTOR_H / 2)
    ring = (ex > 1) & (ex <= 1 + w * per) & (a[y0:y1, x0:x1, 3] < 255)
    f = (1 - 3 * per) / ex[ring]
    sx = np.floor(cx + (xs[ring] + 0.5 - cx) * f).astype(int)
    sy = np.floor(cy + (ys[ring] + 0.5 - cy) * f).astype(int)
    src = a[sy, sx]
    ok = src[:, 3] == 255
    block = a[y0:y1, x0:x1]
    block[ring] = np.where(ok[:, None], src, block[ring])
    return Image.fromarray(a, 'RGBA')


def empty_dir(d):
    """not any(d.iterdir()), but without listing the whole folder first (a map folder holds thousands of sector files)."""
    with os.scandir(d) as it:
        return next(it, None) is None


def drop_empty(out):
    """No empty folders."""
    for sub in out.iterdir():
        if sub.is_dir() and empty_dir(sub):
            sub.rmdir()


def atlas_cells(out):
    """stem -> its 1/64 picture, cut from the map's atlas.webp (the sectors an earlier run drew)."""
    try:
        meta = json.loads((out / 'meta.json').read_text(encoding='utf-8'))
        with Image.open(out / 'atlas.webp') as a:
            atlas = a.convert('RGBA')
    except (OSError, ValueError):
        return {}
    aw, ah = IMG_W // ATLAS_FACTOR, IMG_H // ATLAS_FACTOR
    return {e['stem']: atlas.crop((e['atlas'][0] * aw, e['atlas'][1] * ah, (e['atlas'][0] + 1) * aw, (e['atlas'][1] + 1) * ah))
            for e in meta.get('images', []) if 'atlas' in e}


def small_picture(out, stem, cells):
    """A picture at 1/64: L3/<stem>.png, or its cell of the atlas already made."""
    p = out / 'L3' / f'{stem}.png'
    if p.is_file():
        with Image.open(p) as small:
            return small.convert('RGBA')
    return cells[stem]


# ---- the maps and their jobs ---------------------------------------------------------------------------------------
class MapJob:
    def __init__(self, folder):
        self.folder, self.key = folder, ('World' if folder == WORLD else clean_map(folder))
        self.dir = OUT_WORLD if folder == WORLD else (OUT_MODULES if folder in MODULE_NAMES else OUT) / slug(self.key)
        base = base_of(folder)
        by_xy = {}
        own = [p for p in sec_alias.glob(base, '*.sec') if sector_xy(p)]            # (sec_alias: the duplicates moved to data/temp count as the map's own)
        subs = sorted((p for p in sec_alias.rglob(base, '*.sec') if len(sec_alias.rel(p, base).parts) == 2 and sector_xy(p)),
                      key=lambda p: (p.parent.name.lower(), p.name))
        for p in own + subs:                                     # a sector in a town sub-folder replaces the world folder's
            by_xy[sector_xy(p)] = p
        self.by_xy = by_xy
        self.scheme = map_light_scheme(folder)
        mobs = [p.relative_to(base).as_posix() for p in sorted(base.rglob('*.mob'))]
        # the page reads .mob files under /data/maps/: a module's folder is reached from there
        self.mobs = {'key': folder, 'dir': ('../modules/' + MODULE_MAP[folder]) if folder in MODULE_MAP else folder, 'files': mobs} if mobs else None
        self._base, self._mob_xy, self._filler = base, None, {}

    def has_objects(self, xy, path):
        """Something an objects layer shows (not a wall, not scenery) stands in sector xy: in the map's .mob files or kept in its .sec. Read
        from the files, so it is known before the objects layers (.atlasmob) are built."""
        if self._mob_xy is None:
            self._mob_xy, self._has = set(), {}
            for rel in (self.mobs or {}).get('files', ()):        # (the map's .mob files, listed once in __init__: a listing is slow on this disk)
                try:
                    o = ao.read_mob(self._base / rel)
                except Exception:
                    continue
                if o.tile and o.type not in NOT_IN_LAYER:
                    self._mob_xy.add((o.tile[0] >> 6, o.tile[1] >> 6))
        if xy in self._mob_xy:
            return True
        if (xy, path) not in self._has:                          # (asked up to 9 times per sector: once for itself, once per neighbour)
            try:
                self._has[(xy, path)] = any(o.type not in NOT_IN_LAYER for o in ao.sec_objects(path))
            except Exception:
                self._has[(xy, path)] = False
        return self._has[(xy, path)]

    def blank_filler(self, xy):
        """Sector xy and every neighbour it has are the editor's empty templates (BLANK_SEC_MD5): its picture can only come out black, so it is
        not drawn at all (a filler next to a real room is drawn: the room's walls and light reach into it)."""
        def filler(p):
            if p not in self._filler:
                self._filler[p] = hashlib.md5(p.read_bytes()).hexdigest().startswith(BLANK_SEC_MD5)
            return self._filler[p]
        x, y = xy
        return all(filler(self.by_xy[(x + dx, y + dy)]) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (x + dx, y + dy) in self.by_xy)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--maps', default='all', help='comma-separated map folders or keys (default: every map)')
    ap.add_argument('--skip', default='', help='comma-separated map folders or keys to leave out (e.g. "world", to run it in a second process)')
    ap.add_argument('--modules', action='store_true', help='with every map ("all"): the modules\' maps too (data/modules)')
    ap.add_argument('--limit', type=int, default=0, help='only the first N sectors (and N templates) of each map: a test')
    ap.add_argument('--around', default='', help='"x,y,r": only the sectors within r of sector x, y (a test; terrain is still all drawn)')
    ap.add_argument('--no-terrain', action='store_true', help='a test: reuse the terrain pictures on disk, whatever their settings')
    ap.add_argument('--only-templates', default='', help='a test: of the terrain templates, only those whose folder name contains this text (e.g. "water to"); the others are neither drawn nor listed')
    ap.add_argument('--no-light',action='store_true', help="draw the art as it is, without the game's light")
    ap.add_argument('--hour', type=int, default=15, help='the hour of the light schemes (15 = 3 pm)')
    ap.add_argument('--doors', action='store_true', help='draw the doors too')
    ap.add_argument('--force', action='store_true', help='draw again the pictures already made')
    ap.add_argument('--only-index', action='store_true', help='just rewrite map-pictures.js from what is on disk')
    ap.add_argument('--glows', action='store_true', help='the glows of what the Atlas marks (containers, people, creatures, labels), '
                                                         'shaped on their art: atlas/graphics/glow-shards/ and js/atlas/data/glow-shapes.js')
    ap.add_argument('--glow-kinds', default='', help='with --glows: redo only these kinds (e.g. sw = signs and waypoints) of the maps named, '
                                                     'and keep every other glow already in glow-shapes.js')
    args = ap.parse_args()
    args.light = not args.no_light

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
    if args.only_index:
        write_index()
        return 0

    t_start = time.time()
    with sync_playwright() as pw:
        s = Session(pw)
        try:
            if args.glows:
                draw_glows(folders, s.run, s.state, s.errors, args.glow_kinds)
                folders = []
            for folder in folders:
                draw_map(MapJob(folder), args, signature, s.run, s.state, s.errors)
        finally:
            s.close()
    write_index()
    log = '\n'.join(dict.fromkeys(s.errors)) or 'No errors.'
    report = Path(__file__).resolve().parent / 'reports' / 'map-pictures-report.txt'
    report.parent.mkdir(exist_ok=True)
    report.write_text(log + '\n', encoding='utf-8')
    print(f'\nDone in {(time.time() - t_start) / 60:.1f} min. {len(set(s.errors))} warnings (toolbox/atlas/reports/map-pictures-report.txt).')
    return 0


class Session:
    """The local server and the headless browser that draw: run(script, job) evaluates one job on the page (a new browser every RECYCLE_EVERY
    pictures, or after a failure), errors gathers the page's warnings and errors, state['what'] says what is being drawn (for them).
    build_map_pictures.py and every mod's builder (mod_pictures.py) draw through it."""
    def __init__(self, pw):
        self.pw, self.errors = pw, []
        self.state = {'browser': None, 'page': None, 'n': 0, 'what': ''}
        socketserver.ThreadingTCPServer.request_queue_size = 128    # the default (5) refuses the page's burst of module requests
        self.server = exp.start_server(ROOT, overrides())
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'

    def open_page(self):
        st = self.state
        if st['browser']:
            try:
                st['browser'].close()
            except Exception:
                pass
        b = self.pw.chromium.launch(headless=True)
        pg = b.new_page(viewport={'width': 800, 'height': 600})
        pg.on('console', lambda m: self.errors.append(f'{st["what"]}: {m.type}: {m.text}'[:400]) if m.type in ('warning', 'error') and 'status of 404' not in (m.text or '') else None)
        pg.on('pageerror', lambda e: self.errors.append(f'{st["what"]}: page error: {e}'))
        # the page asks for ~60 modules at once and the local server sometimes refuses one: load it again
        for attempt in (1, 2, 3, 4):
            pg.goto(self.url + '/__pictures__.html')
            pg.wait_for_function('() => !!window.__pictures || !!window.__picturesError', timeout=60000)
            err = pg.evaluate('() => window.__picturesError')
            if not err:
                break
            if attempt == 4:
                raise RuntimeError(err)
            time.sleep(1)
        st.update(browser=b, page=pg, n=0)

    def run(self, script, job):
        st = self.state
        if st['page'] is None or st['n'] >= RECYCLE_EVERY:
            self.open_page()
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
                res = st['page'].evaluate(script, job)
                st['n'] += 1
                return res
            except Exception as e:
                if attempt == 3:
                    raise
                done.set()
                print(f' ({type(e).__name__}, restarting the browser)', end='', flush=True)
                self.open_page()
            finally:
                done.set()

    def close(self):
        if self.state['browser']:
            self.state['browser'].close()
        self.server.shutdown()
        self.server.server_close()


def draw_map(mj, args, signature, run, state, errors):
    out = mj.dir
    if not mj.by_xy:                                             # (a module folder whose maps are in sub-folders, not set up yet)
        print(f'\n== {mj.key}: no .sec files, skipped')
        return
    (out / 'L3').mkdir(parents=True, exist_ok=True)              # (the sectors' 1/64 pictures of this run, until atlas.webp is made; removed at the end)
    meta_file = out / 'meta.json'
    try:
        old = json.loads(meta_file.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        old = {}
    same = old.get('signature') == signature                     # (drawn with these settings: what it lists as drawn / black is still so)
    prev_drawn, prev_black = (set(old.get('drawn', [])), set(old.get('black', []))) if same else (set(), set())
    kept, kept_black = (prev_drawn, prev_black) if not args.force else (set(), set())
    smalls = atlas_cells(out)                                    # the 1/64 pictures of the sectors an earlier run drew
    progress_file = out / 'progress.json'                        # pictures done by a run that did not finish (resumed)
    try:
        prog = json.loads(progress_file.read_text(encoding='utf-8'))
        if prog.get('signature') == signature and not args.force and not (args.limit or args.around):
            kept |= set(prog['drawn'])
    except (OSError, ValueError, KeyError):
        pass
    world = mj.folder == WORLD
    secs = sorted(mj.by_xy.items(), key=lambda kv: (kv[0][1], kv[0][0]))
    only = getattr(mj, 'only', None)                             # build_ce_pictures.py: just the sectors CE Restored adds or changes (the others are the neighbours)
    if only:
        secs = [kv for kv in secs if kv[0] in only]
    if args.around:
        cx, cy, r = map(int, args.around.split(','))
        secs = [kv for kv in secs if abs(kv[0][0] - cx) <= r and abs(kv[0][1] - cy) <= r]
    if args.limit:
        secs = pick(secs, args.limit)
    partial = bool(args.limit or args.around)
    print(f'\n== {mj.key}: {len(secs)} sectors, light scheme {mj.scheme}' + (' (+ terrain)' if world else ''))
    jobs = [('sec', xy, p) for xy, p in secs]

    # Terrain: a sector without a .sec of its own is the template its terrain.tdf names (as in the game). The templates'
    # pictures are shared by every map (atlas/terrain/); a map keeps only a cell of its grid pointing at each.
    terrain, T = None, None
    xs, ys = [x for x, _ in mj.by_xy], [y for _, y in mj.by_xy]
    bounds = {'minX': min(xs), 'minY': min(ys), 'maxX': max(xs), 'maxY': max(ys)}
    size = None if only else terrain_size(mj.folder)             # (a map CE adds sectors to keeps the base game's terrain pictures)
    if size:
        grid_bounds = {'minX': 0, 'minY': 0, 'maxX': max(size[0] - 1, bounds['maxX']), 'maxY': max(size[1] - 1, bounds['maxY'])}
        state['what'] = 'terrain.tdf'
        terrain = run('([rel, b]) => window.__pictures.terrainGrid(rel, b)', [rel_of(mj.folder), grid_bounds])
    if terrain:
        GW0 = grid_bounds['maxX'] - grid_bounds['minX'] + 1
        own_cells = array('H')
        own_cells.frombytes(base64.b64decode(terrain['grid']))
        for (x, y) in mj.by_xy:                                  # a sector with a .sec of its own is not the template
            own_cells[(y - grid_bounds['minY']) * GW0 + (x - grid_bounds['minX'])] = 0
        tpls = [v - 1 for v in sorted(set(own_cells) - {0})]
        # Every interior's terrain.tdf is the editor's default: water (blocked), all over. That is no landscape, nothing to draw.
        kinds = {terrain['templates'][i]['folder'].lower() for i in tpls}
        if len(kinds) == 1 and next(iter(kinds)) in blocked_terrains():
            print(f'   terrain.tdf {size[0]} x {size[1]}: only {next(iter(kinds))} (blocked, the default fill): not drawn')
            terrain = None
    if terrain:
        bounds = grid_bounds
        T = terrain_dest(signature, args.force)
        if args.no_terrain:                                      # a test: keep the terrain pictures already made
            tpls = [i for i in tpls if tpl_stem(terrain['templates'][i]) in T.kept]
        if args.only_templates:                                  # a test: only the templates whose folder name has this in it
            names = [n.strip().lower() for n in args.only_templates.split(',') if n.strip()]
            tpls = [i for i in tpls if any(n in terrain['templates'][i]['folder'].lower() for n in names)]
            T.kept -= {tpl_stem(terrain['templates'][i]) for i in tpls}      # (drawn again, even if the last run kept them)
        if args.limit:
            tpls = tpls[:args.limit]
        print(f'   terrain.tdf {size[0]} x {size[1]}: {len(tpls)} templates in use')
        jobs = [('tpl', i, None) for i in tpls] + ([] if args.only_templates else jobs)

    # A sector whose picture is only black (black tiles, nothing on them) is left out like a blank one: on the Atlas's black
    # it would show nothing. Its objects layer (.atlasmob), if it has one, is drawn all the same: such a sector stays.
    images, blank = [], set()
    with_objects = set()
    try:
        art = json.loads((out / 'art.json').read_text(encoding='utf-8'))
        with_objects = set(art.get('o', [])) | set(art.get('f', []))
    except (OSError, ValueError):
        pass
    M = Dest(out, kept, kept_black, with_objects)
    drawn, black = M.drawn, M.black
    for n, (kind, ref, path) in enumerate(jobs, 1):
        d = T if kind == 'tpl' else M                            # where this picture goes
        if kind == 'tpl':
            tp = terrain['templates'][ref]
            stem = tpl_stem(tp)
            src = ROOT / 'data' / 'terrain' / tp['folder'] / f'{tp["file"]}.sec'
            job = {'url': url_of(src), 'file': src.name, 'at': [0, 0], 'neighbours': [], 'mobs': None,
                   'wrap': ' to ' not in tp['folder'].lower()}    # (a transition template is not seamless with itself: wrapped, the far edge's other terrain shows in the band)
            what = f'terrain/{tp["path"]}'
        else:
            stem = f'sec_{path.stem}'
            x, y = ref
            job = {'url': url_of(path), 'file': path.name, 'at': [x, y], 'mobs': mj.mobs,
                   'neighbours': [{'url': url_of(mj.by_xy[(x + dx, y + dy)]), 'file': mj.by_xy[(x + dx, y + dy)].name, 'at': [x + dx, y + dy]}
                                  for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dx or dy) and (x + dx, y + dy) in mj.by_xy]}
            try:
                what = f'{mj.folder}/{path.relative_to(base_of(mj.folder)).as_posix()}'
            except ValueError:                                   # a sector read from a copy elsewhere (reports/sec-view)
                what = f'{mj.folder}/{path.name}'
        # (a template is one picture for every map: it is always drawn with the world's light scheme)
        job.update(mapScheme=map_light_scheme(WORLD) if kind == 'tpl' else mj.scheme, light=args.light, hour=args.hour, doors=args.doors, pad=PAD, size=[IMG_W, IMG_H], quality=QUALITY)
        state['what'] = what
        objects = stem in d.with_objects or (kind == 'sec' and mj.has_objects(ref, path))
        if stem in d.kept_black and not objects:
            print(f'[{n}/{len(jobs)}] {what} ... black (kept out)')
            d.black.add(stem)
            if kind == 'sec':
                blank.add(ref)
            continue
        if kind == 'sec' and not objects and stem not in d.kept and mj.blank_filler(ref):
            print(f'[{n}/{len(jobs)}] {what} ... blank filler, its neighbours too: black, not drawn')
            (d.out / 'L3' / f'{stem}.png').unlink(missing_ok=True)
            d.black.add(stem)
            blank.add(ref)
            continue
        have = (stem in d.kept or (kind == 'tpl' and args.no_terrain)) and (
            (d.out / 'L3' / f'{stem}.png').is_file() or (kind == 'sec' and stem in smalls))      # (a template's 1/64 picture is its L3 png; a sector's may be only a cell of atlas.webp)
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
            if not objects and only_black(im):
                print(' black (kept out)')
                (d.out / 'L3' / f'{stem}.png').unlink(missing_ok=True)
                d.black.add(stem)
                if kind == 'sec':
                    blank.add(ref)
                continue
            shrink(widen(im, ATLAS_FACTOR), ATLAS_FACTOR).save(d.out / 'L3' / f'{stem}.png')      # (the .atlassec file is the ground; only the 1/64 picture is kept)
            detail = f'objects {res["objects"]}' + (f', lights {res["lights"]}, {res["scheme"]} {res["ambient"]["outdoor"]}/{res["ambient"]["indoor"]}' if res['ambient'] else '')
        else:
            detail = 'kept'
        d.drawn.add(stem)
        if kind == 'tpl':
            if len(T.drawn) % 10 == 0:
                save_terrain(T, signature)
        elif not (args.limit or args.around) and len(drawn) % 10 == 0:
            progress_file.write_text(json.dumps({'signature': signature, 'drawn': sorted(drawn)}), encoding='utf-8')
        e = {'stem': stem, 'kind': kind}
        if kind == 'sec':
            e['x'], e['y'] = ref
        else:
            e['tpl'] = ref
        images.append(e)
        print(f' {detail} ({time.time() - t0:.1f} s)')

    if args.only_templates:                                      # a test of the templates alone: no map is written (its index, grid, pictures and pruning stay as they are)
        if T:
            save_terrain(T, signature)
        return
    window = {f'sec_{p.stem}' for _, p in secs}
    if partial:                                                # a window drawn again (--around / --limit): the rest of the map stays as the last run left
        here = window | {e['stem'] for e in images}              # it (meta.json listed only the window: a 10/17 --around run cut CE's World from 632 sectors to 19)
        images += [{'stem': e['stem'], 'kind': 'sec', 'x': e['x'], 'y': e['y']} for e in old.get('images', [])
                   if e['kind'] == 'sec' and e['stem'] not in here and e['stem'] in smalls]
        drawn, black = drawn | (prev_drawn - window), black | (prev_black - window)

    # placement grid (picture number + 1 per sector), atlas and colours
    if T:
        save_terrain(T, signature)
    W, H = bounds['maxX'] - bounds['minX'] + 1, bounds['maxY'] - bounds['minY'] + 1
    if terrain:
        lut = [0] * (len(terrain['templates']) + 1)
        for i, e in enumerate(images):
            if e['kind'] == 'tpl':
                lut[e['tpl'] + 1] = i + 1
        cells = array('H', (lut[v] for v in own_cells))          # (own_cells: 0 where the map has a .sec)
    else:
        cells = array('H', [0]) * (W * H)
    for i, e in enumerate(images):
        if e['kind'] == 'sec':
            cells[(e['y'] - bounds['minY']) * W + (e['x'] - bounds['minX'])] = i + 1
    for (x, y) in blank:
        cells[(y - bounds['minY']) * W + (x - bounds['minX'])] = 0
    used = [k for k, v in enumerate(cells) if v]
    if terrain and not world and used:                           # a small map's grid is cut to what shows (the world keeps its 2000 x 2000)
        cols, rows = [k % W for k in used], [k // W for k in used]
        x0, x1, y0, y1 = min(cols), max(cols), min(rows), max(rows)
        cells = array('H', (cells[y * W + x] for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)))
        bounds = {'minX': bounds['minX'] + x0, 'minY': bounds['minY'] + y0, 'maxX': bounds['minX'] + x1, 'maxY': bounds['minY'] + y1}
        W, H = x1 - x0 + 1, y1 - y0 + 1
    aw, ah = IMG_W // ATLAS_FACTOR, IMG_H // ATLAS_FACTOR
    atlas = Image.new('RGBA', (aw * ATLAS_COLS, ah * max(1, -(-len(images) // ATLAS_COLS))), (0, 0, 0, 0))
    for i, e in enumerate(images):
        small = small_picture(OUT_TERRAIN, e['stem'], {}) if e['kind'] == 'tpl' else small_picture(out, e['stem'], smalls)
        atlas.paste(small, ((i % ATLAS_COLS) * aw, (i // ATLAS_COLS) * ah))
        r, g, b, _ = small.convert('RGBa').resize((1, 1), Image.BOX).convert('RGBA').getpixel((0, 0))
        e['color'] = [r, g, b]
        e['atlas'] = [i % ATLAS_COLS, i // ATLAS_COLS]
        e.pop('tpl', None)
    atlas.save(out / 'atlas.webp', 'WEBP', lossless=True)
    meta = {'key': mj.key, 'folder': mj.folder, 'dir': out.relative_to(ROOT).as_posix(), 'signature': signature,
            'drawn': sorted(drawn), 'black': sorted(black), 'complete': not partial,
            'lightScheme': mj.scheme, 'bounds': bounds, 'gridW': W, 'gridH': H, 'images': images,
            'grid': base64.b64encode(zlib.compress(cells.tobytes(), 9)).decode('ascii')}
    meta_file.write_text(json.dumps(meta, separators=(',', ':')), encoding='utf-8')
    if not partial:                                              # (the run finished: meta.json lists what it drew)
        progress_file.unlink(missing_ok=True)
    shutil.rmtree(out / 'L3', ignore_errors=True)                # (atlas.webp has every 1/64 picture now; the templates' stay in atlas/terrain/L3)
    drop_empty(out)
    write_index()


# ---- glows -----------------------------------------------------------------------------------------------------------
# What the Atlas marks (its filters: containers, people, creatures, labels) glows in the shape of its own art: each marked
# tile's objects are drawn alone, and their outline, widened and blurred, becomes a halo (faint over the figure itself, so it
# stays readable). Halos are kept at half size, each saved once in the shared pool (POOL_DIR) under the hash of its content, with the art's outline beside it.
GLOW_JS = DATA_JS / 'glow-shapes.js'
GLOW_R, GLOW_SCALE = 7, 2


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
    for r in M['waypoints']:                                      # their doors and signs (from the module's own scripts)
        add(r[0], (r[2], r[3]), 'w')
    for r in M['notices']:
        add(r[0], (r[2], r[3]), 's')
    return marks


def mod_item_marks(key):
    """map key ('World' or a map only the mod has) -> {(x, y): {'c' | 'i'}}: where the containers and floor items of the mod's .mob files stand
    (the version's items.js, run_version.py; game_files.make_root lists the files that come from the mod in modfiles.json). Each gets a glow of
    its own in the mod's set (found by the object's file name, so a base-game object the mod moved or redrew on its tile is not mistaken for it)."""
    import game_files
    root = game_files.MERGED_DATA / key
    names = {x.split('/', 1)[1] for x in json.loads((root / 'modfiles.json').read_text(encoding='utf-8'))}
    data = read_js_globals(ROOT / 'js' / 'atlas' / 'data' / key / 'items.js')['ArcanumItems']
    marks = {}
    for rows, kind in ((data['containers'], 'c'), (data['ground'], 'i')):
        for r in rows:
            if r.get('tile') and (r.get('file') or '').replace('\\', '/').rsplit('/', 1)[-1].lower() in names:
                marks.setdefault('World' if r.get('world') else r['place'], {}).setdefault((int(r['tile'][0]), int(r['tile'][1])), set()).add(kind)
    mods_js = ROOT / 'js' / 'atlas' / 'data' / key / 'modules.js'      # the people of the modules' maps that the mod (its copy of the module) adds or changes
    if mods_js.is_file():
        M = read_js_globals(mods_js)['ArcanumModules']
        for r in M['npcs'] + M['creatures']:
            if str(r[-1]).replace('\\', '/').rsplit('/', 1)[-1].lower() in names:
                marks.setdefault(M['places'][r[0]], {}).setdefault((r[1], r[2]), set()).add('n')
    # the waypoints the version has and the base game has not on that tile (the mod's own doors and portals, build_waypoints.py run on
    # its root): the object on the tile glows (glow_picks; the mod's scripts are not the base game's, so "what stands on the tile")
    ways = ROOT / 'js' / 'atlas' / 'data' / key / 'waypoints.js'
    if ways.is_file():
        base = {(r[0] or 'World', r[2], r[3]) for r in read_js_globals(ROOT / 'js' / 'atlas' / 'data' / 'waypoints.js')['ArcanumWaypoints']['waypoints']}
        for r in read_js_globals(ways)['ArcanumWaypoints']['waypoints']:
            if (r[0] or 'World', r[2], r[3]) not in base:
                marks.setdefault(r[0] or 'World', {}).setdefault((r[2], r[3]), set()).add('w')
    return marks

# What a glow is put on: not everything on the marked tile (a bucket under a sign, a bush around a herb), only the thing itself.
DOORLIKE = re.compile(r'door|gate|entrance|exit|stair|ladder|hatch|passage|manhole|trap ?door|portal|arch|cave|tunnel|opening|elevator|lift|grate',
                      re.I)


_IMAGE_SCRIPTS = {}            # the base game's picture scripts (build_notices.read_images), read once


def glow_picks(folder, by_sec, marks):
    """For the signs ('s') and waypoints ('w') of a map: {"x,y,k": [tier, ...]}, a tier = the ids of the objects to glow
    (static: '<sector file>#object<i>', else the .mob's file name). The picture of the first tier that shows anything is used.
      sign:     the object(s) at the tile with the script that prints it (and the other pieces of that script within a few
                tiles: a long board), else the named scenery at the tile (a shop sign has no script);
      waypoint: the object(s) with the teleport script (a double door: both), else what stands on the tile (the portal of a
                tile script or jump point: build_waypoints puts the waypoint there), else, for something invisible, the door-like
                object nearest to it."""
    import arcanum_objects as ao
    import build_notices as bn
    import build_waypoints as bw
    scr = MODULES / MODULE_MAP[folder].split('/')[0] / 'scr' if folder in MODULE_MAP else None
    if scr is not None and not scr.is_dir():
        scr = None
    notice_scripts = set(bn.read_scripts(scr) if scr else bn.read_scripts())      # (a module numbers its scripts from 1: its own scr first...)
    if scr:                                                      # ...and the base game's: a module with a few scripts of its own (Escape Tarant: 5) hangs the game's on the rest
        notice_scripts |= set(bn.read_scripts())
    _IMAGE_SCRIPTS.update(_IMAGE_SCRIPTS or bn.read_images())     # (and the scripts that open a picture, a diagram or a mural: build_notices.main makes a notice of them too)
    notice_scripts |= set(_IMAGE_SCRIPTS)
    tele = set(bw.teleports(scr) if scr else bw.teleports())
    ptele = set(bw.people_teleports(scr) if scr else bw.people_teleports())
    want = {k: v for k, v in marks.items() if v & {'s', 'w'}}
    if not want:
        return {}
    desc = ao.descriptions()
    base = base_of(folder)
    recs = []                                                    # one per portal / container / scenery in a sector with a mark
    sectors = {(X >> 6, Y >> 6) for X, Y in want}
    def rec(o, ident):
        if o.type not in (1, 2, 3, *bw.PEOPLE) or not o.tile:        # (a person: only as a waypoint, the one whose script moves the player)
            return
        scripts = set(bw.scripts_of(o))
        own = (desc.get(o.get(23)) or '').strip() if o.get(23) else ''
        recs.append({'id': ident, 'type': o.type, 'x': o.tile[0], 'y': o.tile[1], 'scripts': scripts,
                     'hooked': {n for _h, n in bn.hooked(o)}, 'own': own, 'name': (desc.get(o.proto - 20) or '').strip(), 'proto': o.proto,
                     'board': bn.board_lines(own, (desc.get(o.proto - 20) or '')) if o.type == 3 else []})      # (a scenery shown as a notice: its lines)
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
    # recs by tile, kept in their order (number in recs), so each marked tile looks only at its own and its neighbours' tiles, not at all of them
    by_tile, door_tile = {}, {}
    for i, r in enumerate(recs):
        by_tile.setdefault((r['x'], r['y']), []).append((i, r))
        if r['type'] == 1 or DOORLIKE.search(r['name'] + ' ' + r['own']) and r['type'] == 3:
            door_tile.setdefault((r['x'], r['y']), []).append((i, r))

    def around(X, Y, d, pool):                                   # the recs of pool within d tiles of X, Y, in their order
        got = [ir for dy in range(-d, d + 1) for dx in range(-d, d + 1) for ir in pool.get((X + dx, Y + dy), ())]
        got.sort(key=lambda ir: ir[0])
        return [r for _, r in got]
    at = {}
    for (X, Y), kinds in want.items():
        on_tile = [r for _, r in by_tile.get((X, Y), ())]
        here = [r for r in on_tile if r['type'] not in bw.PEOPLE]
        if 's' in kinds:
            each = [[r['id']] for r in here if r['hooked'] & notice_scripts]      # each object that prints something glows alone (notices are one per object)
            titles = None
            if not each:                                        # a shop or street sign, stairs, an altar...: scenery named after what it says (the notice's own objects)
                boards = [r for r in here if r['board']]
                each, titles = [[r['id']] for r in boards], [r['board'][-1] for r in boards]
            if each:
                at[f'{X},{Y},s'] = {'each': each, **({'titles': titles} if titles else {})}      # (titles: what the notice is called, to tell its glow from the tile's others)
        if 'w' in kinds:
            mine = {n for r in here for n in r['scripts'] if n in tele}
            person = [r for r in on_tile if r['type'] in bw.PEOPLE and r['scripts'] & ptele]
            tiers = []
            if person and not mine:                             # a person who takes the player somewhere (build_waypoints.person_way): they glow
                tiers.append([r['id'] for r in person])
            elif mine:                                          # (within bn.MERGE tiles: a door's other half)
                tiers.append([r['id'] for r in around(X, Y, bn.MERGE, by_tile) if r['scripts'] & mine and r['type'] not in bw.PEOPLE])
            elif here:                                          # a tile script / jump point: the portal standing on it (build_waypoints.element)
                tiers.append([r['id'] for r in here])
            doors = sorted(around(X, Y, 3, door_tile), key=lambda r: max(abs(r['x'] - X), abs(r['y'] - Y)))
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


POOL_DIR = ROOT / 'toolbox' / 'atlas' / 'cache' / 'glow-pool'     # one file per distinct glow (halo + outline in one picture), shared by every set: the game, its modules, CE Restored, Carcanum, Forgotten Places
# (a build cache, not served: build_glow_shards.py packs it into atlas/graphics/glow-shards/, which the Atlas loads by place)
GLOW_FORMAT = 2


def oid_of(ident, static_protos):
    """What the viewer knows an object by: a .mob = its lower-case file name, a static object (an id '<sector>.sec#object<i>') = 'p<prototype>'."""
    if '#object' not in ident:
        return ident.lower()
    name, i = ident.split('#object')
    return 'p' + str(static_protos.get(name, {}).get(int(i), 0))


def glow_file(h, s):
    """The halo (half size) and the art's outline (full size) side by side in one lossless webp, named after its content: returns (hash, [hw, hh, mw, mh])."""
    import hashlib
    key = hashlib.md5(h.tobytes() + bytes(str(h.size), 'ascii') + s.tobytes() + bytes(str(s.size), 'ascii')).hexdigest()[:20]
    path = POOL_DIR / f'{key}.webp'
    if not path.exists():
        sheet = Image.new('RGBA', (h.width + s.width, max(h.height, s.height)), (255, 255, 255, 0))
        sheet.paste(h, (0, 0))
        sheet.paste(s, (h.width, 0))
        sheet.save(path, 'WEBP', lossless=True)
    return key, [h.width, h.height, s.width, s.height]


def draw_glows(folders, run, state, errors, only_kinds='', marks=None, glow_js=GLOW_JS, var='ArcanumGlows', make_job=None, window=None, extra_picks=None):
    """window (x, y, r) with only_kinds: redo just the sectors within r of sector x, y. marks / glow_js / var / make_job: a mod's own (build_ce_pictures.py --glows ...): the tiles to do, where the lookup goes, and how a map
    folder becomes its job. The pictures go to the shared pool (POOL_DIR), whatever set they are for.
    at[map]["X,Y"][kind] = [[hash, dx, dy, object], ...]: one entry per object (the object = what the Atlas rows know it by: oid_of)."""
    make_job = make_job or MapJob
    marks = marks if marks is not None else glow_marks()
    POOL_DIR.mkdir(parents=True, exist_ok=True)
    shapes, at = {}, {}
    if only_kinds:                                                # a partial run: start from what is there
        old = read_js_globals(glow_js)[var]
        if old.get('format') != GLOW_FORMAT:
            raise SystemExit(f'{glow_js.name} is in the old sheet format: run the full glow build once (no --glow-kinds)')
        shapes, at = old['shapes'], old['at']
        marks = {k: {xy: set(v) & set(only_kinds) for xy, v in t.items() if set(v) & set(only_kinds)} for k, t in marks.items()}
        near = (lambda xy: abs(xy[0] // 64 - window[0]) <= window[2] and abs(xy[1] // 64 - window[1]) <= window[2]) if window else (lambda xy: True)
        marks = {k: {xy: v for xy, v in t.items() if near(xy)} for k, t in marks.items()}       # (a window: only the sectors within r of sector x, y)
        for k in {make_job(f).key for f in folders}:              # the kinds being redone are dropped first (a wrong halo goes away)
            for xy in at.get(k, {}):
                if not near(tuple(map(int, xy.split(',')))):
                    continue
                for g in only_kinds:
                    at[k][xy].pop(g, None)
            at[k] = {xy: v for xy, v in at.get(k, {}).items() if v}
    t0 = time.time()
    print(f'glows started [{time.strftime("%Y-%m-%d %H:%M:%S")}]', flush=True)
    for folder in folders:
        mj = make_job(folder)
        tiles = marks.get(mj.key)
        if not tiles:
            continue
        by_sec = {}
        for (X, Y), kinds in tiles.items():
            by_sec.setdefault((X // 64, Y // 64), []).append([X % 64, Y % 64, ''.join(sorted(kinds))])
        picks = glow_picks(folder, mj.by_xy, tiles)
        if extra_picks:                                           # a mod's own (its signs: the notice names its object)
            picks.update(extra_picks(mj, tiles, picks))
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
            protos = None
            title_of = {p['each'][i][0]: t for p in job['pick'].values() if isinstance(p, dict) for i, t in enumerate(p.get('titles', ()))}       # object id -> the notice it is the glow of
            for r in res:
                cut = Image.open(io.BytesIO(base64.b64decode(r['png'].split(',', 1)[1]))).convert('RGBA')
                h, m = halo(cut)
                key, dims = glow_file(h, silhouette(cut))
                shapes[key] = dims
                if '#object' in r['id'] and protos is None:       # a static object: its prototype stands for it
                    import arcanum_objects as ao
                    protos = {path.name: {i: o.proto for i, o in enumerate(ao.sec_objects(path))}}
                X, Y = xy[0] * 64 + r['tile'][0], xy[1] * 64 + r['tile'][1]
                at.setdefault(mj.key, {}).setdefault(f'{X},{Y}', {}).setdefault(r['g'], []).append([key, r['x'] - m, r['y'] - m, oid_of(r['id'], protos or {})] + ([title_of[r['id']]] if r['g'] == 's' and r['id'] in title_of else []))
                found += 1
            print(f'[{time.strftime("%H:%M:%S")}] {mj.key}: {n}/{len(by_sec)} sectors ({path.name}), {found} glows, {len(shapes)} shapes', flush=True)
        print(f'{mj.key} done: {len(tiles)} marked tiles  [{time.strftime("%Y-%m-%d %H:%M:%S")}, {time.time() - t0:.0f} s in]', flush=True)
    used = {e[0] for m in at.values() for t in m.values() for lst in t.values() for e in lst}
    shapes = {k: v for k, v in shapes.items() if k in used}
    data = {'note': 'GENERATED by toolbox/atlas/build_map_pictures.py --glows. at[map]["X,Y"][n people and creatures | c containers | i items on the floor | s signs | w waypoints] = '
                    f'[[picture, dx, dy, object], ...], one per object (object: a .mob\'s lower-case file name, or p<prototype> for an object of a .sec); drawn {GLOW_SCALE}x; dx, dy '
                    f'= world px of the halo\'s top-left from the centre of tile (X, Y); the picture is in a shard of atlas/graphics/glow-shards/ (glow-shards.js): the halo (shapes[picture] = [w, h, mask w, mask h]) '
                    f'with the art\'s outline at full size, its top-left {3 * GLOW_R} px right of and below the halo\'s, to its right.',
            'format': GLOW_FORMAT, 'scale': GLOW_SCALE, 'margin': 3 * GLOW_R, 'shapes': shapes, 'at': at}
    glow_js.write_text('// GENERATED by toolbox/atlas/build_map_pictures.py - re-run it rather than editing by hand.\n'
                       f'window.{var} = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(f'{len(shapes)} shapes ({time.time() - t0:.0f} s)  [{time.strftime("%Y-%m-%d %H:%M:%S")}]')
    import build_glow_shards
    build_glow_shards.main()                                      # (the pictures the page loads: repacked from every set after each glow run)

def tpl_stem(tp):
    return 'tpl_' + re.sub(r'[^A-Za-z0-9_.-]+', '_', f'{tp["folder"]}__{tp["file"]}')


def pick(secs, n):
    """A test run: n sectors spread over the map, the busiest first (most bytes: walls, scenery, lights)."""
    return sorted(sorted(secs, key=lambda kv: -kv[1].stat().st_size)[:n], key=lambda kv: (kv[0][1], kv[0][0]))


def map_entry(out):
    """The index entry of one map's picture folder (what map-pictures.js has for it, the mods' indexes too) and its meta.json: (entry, meta)."""
    m = json.loads((out / 'meta.json').read_text(encoding='utf-8'))
    entry = {k: m[k] for k in ('dir', 'bounds', 'gridW', 'gridH', 'grid', 'complete')} | {
        'images': [{'stem': e['stem'], 'kind': e['kind'], 'color': e['color'], 'atlas': e['atlas']} for e in m['images']]}
    return entry, m


def write_index():
    for d in map_dirs():                                       # no empty folders, nor a map folder with nothing in it (a stale key's)
        if d.is_dir():
            drop_empty(d)
            if d != OUT_WORLD and empty_dir(d):
                d.rmdir()
    maps = {}
    for f in metas():
        entry, m = map_entry(f.parent)
        maps[m['key']] = entry
    data = {'note': 'GENERATED by toolbox/atlas/build_map_pictures.py. Per map: its sectors (atlas.webp holds each at 1/64: colour and cell), '
                    'grid = picture number + 1 per sector of bounds (zlib, uint16). The ground and the objects are the .atlassec / .atlasmob files.',
            'terrain': OUT_TERRAIN.relative_to(ROOT).as_posix(),
            'sector': {'w': SECTOR_W, 'h': SECTOR_H}, 'pad': PAD, 'img': {'w': IMG_W, 'h': IMG_H}, 'levels': {str(k): v for k, v in LEVELS.items()},
            'pieces': {k: [c, r, f] for k, (c, r, f) in PIECES.items()},
            'atlas': {'w': IMG_W // ATLAS_FACTOR, 'h': IMG_H // ATLAS_FACTOR, 'cols': ATLAS_COLS}, 'maps': maps}
    write_index_files(data)


def write_index_files(data):
    """map-pictures.js, with only the world's grid, and map-grids.js, the grids of the other maps ({key: grid}): the page loads the
    first with the world map and the second the first time it opens another map (0.9 MB of 1.6 MB gzipped, not needed to start)."""
    grids = {k: e.pop('grid') for k, e in data['maps'].items() if k != 'World' and 'grid' in e}
    w = data['maps'].get('World')
    if w and 'grid' in w and not w.get('gridPlanes'):            # the world's grid, loaded with the page: its low bytes, then its high bytes, deflated
        cells = zlib.decompress(base64.b64decode(w['grid']))       # (18% smaller than the uint16 cells as they are: 572 KB for 698)
        w['grid'] = base64.b64encode(zlib.compress(cells[0::2] + cells[1::2], 9)).decode('ascii')
        w['gridPlanes'] = 1
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_map_pictures.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumPictures = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    GRIDS_JS.write_text('// GENERATED by toolbox/atlas/build_map_pictures.py - re-run it rather than editing by hand. The grid of each map but the world\'s.\n'
                        'window.ArcanumMapGrids = ' + json.dumps(grids, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')


def read_index():
    """map-pictures.js as one object, every map with its grid (map-grids.js put back; the world's as plain uint16 cells again)."""
    t = OUT_JS.read_text(encoding='utf-8')
    data = json.loads(t[t.index('{'):t.rindex('}') + 1])
    for e in data['maps'].values():
        if e.pop('gridPlanes', None):
            p = zlib.decompress(base64.b64decode(e['grid']))
            cells = bytearray(len(p))
            cells[0::2], cells[1::2] = p[:len(p) // 2], p[len(p) // 2:]
            e['grid'] = base64.b64encode(zlib.compress(bytes(cells), 9)).decode('ascii')
    if GRIDS_JS.is_file():
        g = GRIDS_JS.read_text(encoding='utf-8')
        for k, grid in json.loads(g[g.index('{'):g.rindex('}') + 1]).items():
            if k in data['maps']:
                data['maps'][k]['grid'] = grid
    return data


if __name__ == '__main__':
    sys.exit(main())
