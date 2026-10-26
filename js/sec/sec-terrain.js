// Terrain-generated sectors of the world map.
//
// The world is a 2000 x 2000 grid of sectors but only a few hundred have a .sec of their own.
// For every other sector the engine (sector.c sector_load_game -> terrain.c terrain_sector_path)
// looks its terrain id up in the map's terrain.tdf and loads a template sector from
// data/terrain/<name>/<n>.sec, shifting that template's lights and objects to the real sector.
//
// terrain.tdf (terrain.c terrain_open): 0x20-byte header { float version = 1.2, u32 flags,
// i64 width, i64 height, i32 base type, i32 pad } followed by one record per row. With flag 0x1
// (what the game ships) each record is { i32 size, zlib stream of `width` u16 ids }.
// Terrain id bits: 15..11 base terrain, 10..6 "to" terrain, 5..2 transition shape, 1..0 variant.

import { DATA_ROOT, SEC_ROOT } from '../core/config.js';
import { parseMesText } from '../core/mes-parser.js';
import { indexSubfolderNames } from '../core/file-index.js';
import { encPath } from '../core/util.js';
import { readSecTileData } from './sec-parser.js';
import { secMapInfoBytes } from '../editor/sec-writer.js';

const TERRAIN_ROOT = `${DATA_ROOT}terrain/`;
const TERRAIN_HEADER_SIZE = 0x20;
// Only outdoor world maps are treated as terrain-backed (interior maps also ship a tiny terrain.tdf).
const MIN_WORLD_SECTORS = 1000;

// terrain.c qword_5B9968: transition shape (0..15) -> template sector file number, -1 = use the
// mirrored shape (15 - n) with the two terrain names swapped.
const SHAPE_SECTOR = [-1, 1, 0x8000001, 0x4000001, 0x8000003, 0, 0x8000002, -1, 3, 2, -1, -1, 0x4000003, -1, -1, -1];
// terrain.c sub_4E8E60: variant 0..3 -> template sector file number of a plain (non-transition) sector.
const variantSector = v => (v % 2) + Math.floor(v / 2) * 0x4000000;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let namesPromise = null;
function loadTerrainNames() {
  if (!namesPromise) namesPromise = (async () => {
    const resp = await fetch(`${TERRAIN_ROOT}terrain.mes`);
    if (!resp.ok) throw new Error(`terrain.mes: HTTP ${resp.status}`);
    const mes = parseMesText(await resp.text());
    // terrain_init_types: names are numbered 0.. without gaps; a "/b" suffix marks blocked terrain
    // and is cut off together with the spaces before it.
    const names = [], blocked = [];
    for (let i = 0; mes.has(i); i++) {
      let s = String(mes.get(i)), cut = s.indexOf('/b');
      blocked.push(cut >= 0);
      if (cut >= 0) s = s.slice(0, cut);
      names.push(s.trim());
    }
    return { names, blocked };
  })();
  return namesPromise;
}

// Base terrains with the editor colour terrain.mes gives each (messages 100 + id): [{ id, name, blocked, color: [r, g, b] }].
export async function loadTerrainTypes() {
  const { names, blocked } = await loadTerrainNames();
  const resp = await fetch(`${TERRAIN_ROOT}terrain.mes`);
  const mes = parseMesText(await resp.text());
  const folders = await loadTerrainFolders();
  return names.map((name, id) => {
    const rgb = String(mes.get(100 + id) ?? '').split(',').map(n => parseInt(n, 10));
    const color = rgb.length === 3 && rgb.every(Number.isFinite) ? rgb : [128, 128, 128];
    return { id, name, blocked: blocked[id], color, hasTemplates: folders.has(name.toLowerCase()) };   // e.g. "void plains" ships no sectors
  });
}

// Real (case-correct) template folder names, so lookups also work on case-sensitive servers.
let folderPromise = null;
function loadTerrainFolders() {
  if (!folderPromise) folderPromise = (async () => {
    const map = new Map();
    for (const name of await indexSubfolderNames('sec', 'terrain')) map.set(name.toLowerCase(), name);   // (folders that hold template sectors)
    return map;
  })();
  return folderPromise;
}

// terrain.c terrain_sector_path: { folder, file } of the template for a terrain id, or null when the
// id points at no valid template (the engine then fills the sector with a plain tile).
export function terrainTemplateFor(tid, names) {
  const base = (tid >> 11) & 0x1F, to = (tid >> 6) & 0x1F, shape = (tid >> 2) & 0xF, variant = tid & 3;
  if (base >= names.length) return null;
  if (base === to || shape === 0) return { folder: names[base], file: variantSector(variant), base, to: base, shape };
  if (to >= names.length) return null;
  let file = SHAPE_SECTOR[shape], from = base, into = to;
  if (file === -1) { from = to; into = base; file = SHAPE_SECTOR[15 - shape]; }
  if (file === -1) return null;
  return { folder: `${names[from]} to ${names[into]}`, file, base, to, shape };
}

// Reads <map>/terrain.tdf; resolves to null for maps without a world-sized terrain grid.
// Cached per folder: the explorer and the map viewer both ask.
const terrainMapCache = new Map();
// minSectors: the smallest grid (width and height) taken as terrain-backed; the Atlas passes 1, since a module's outdoor map
// has a small grid whose sectors without a .sec of their own are templates too.
export function loadTerrainMap(relativePath, minSectors = MIN_WORLD_SECTORS) {
  const key = `${minSectors}|${relativePath || ''}`;
  if (!terrainMapCache.has(key)) {
    const p = loadTerrainMapUncached(relativePath, minSectors);
    terrainMapCache.set(key, p);
    p.catch(() => terrainMapCache.delete(key));
  }
  return terrainMapCache.get(key);
}
async function loadTerrainMapUncached(relativePath, minSectors) {
  let resp;
  try { resp = await fetch(`${SEC_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}terrain.tdf`); } catch (_) { return null; }
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  if (buf.byteLength < TERRAIN_HEADER_SIZE) return null;
  const view = new DataView(buf);
  const flags = view.getUint32(4, true);
  const width = Number(view.getBigInt64(8, true)), height = Number(view.getBigInt64(16, true));
  if (Math.abs(view.getFloat32(0, true) - 1.2) > 1e-4 || width < minSectors || height < minSectors || width * height > 1 << 24) return null;
  const ids = new Uint16Array(width * height);
  if (flags & 1) {
    const jobs = [];
    let pos = TERRAIN_HEADER_SIZE;
    for (let y = 0; y < height; y++) {
      if (pos + 4 > buf.byteLength) throw new Error('terrain.tdf is truncated');
      const size = view.getInt32(pos, true); pos += 4;
      if (size < 0 || pos + size > buf.byteLength) throw new Error('terrain.tdf is truncated');
      jobs.push({ y, bytes: new Uint8Array(buf, pos, size) });
      pos += size;
    }
    for (let i = 0; i < jobs.length; i += 64) {
      await Promise.all(jobs.slice(i, i + 64).map(async job => {
        const row = await inflate(job.bytes);
        if (row.length < width * 2) throw new Error(`terrain.tdf row ${job.y} is short`);
        ids.set(new Uint16Array(row.buffer, row.byteOffset, width), job.y * width);
      }));
    }
  } else {
    if (buf.byteLength < TERRAIN_HEADER_SIZE + ids.length * 2) throw new Error('terrain.tdf is truncated');
    ids.set(new Uint16Array(buf.slice(TERRAIN_HEADER_SIZE, TERRAIN_HEADER_SIZE + ids.length * 2)));
  }
  const [{ names, blocked }, folders] = await Promise.all([loadTerrainNames(), loadTerrainFolders()]);
  return {
    width, height, names, ids,
    // What the engine would load for sector (x, y): null outside the grid.
    describe(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const tid = ids[y * width + x];
      const t = terrainTemplateFor(tid, names);
      const id = (BigInt(y) << 26n) | BigInt(x);
      const info = { x, y, id: String(id), tid, blocked: !!t && (blocked[t.base] || blocked[t.to]), template: null, label: '' };
      if (t) {
        const folder = folders.get(t.folder.toLowerCase()) || t.folder;
        info.template = { folder, file: t.file, path: `${folder}/${t.file}.sec` };
        info.label = t.base === t.to ? names[t.base] : `${names[t.base]} → ${names[t.to]}`;
      }
      return info;
    }
  };
}

// Terrain id of sector (x, y) of a new world: the plain terrain with one of its four variants.
const worldTerrainId = (terrainId, x, y) => (terrainId << 11) | (terrainId << 6) | ((x * 3 + y * 5) & 3);
// The ids of a world of one terrain only.
const uniformWorldIds = (width, height, terrainId) => {
  const ids = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) ids[y * width + x] = worldTerrainId(terrainId, x, y);
  return ids;
};

// Corner of a sector, in the order the planner keeps them: 0 = point (x, y) (top on screen), 1 = (x, y + 1) (left),
// 2 = (x + 1, y + 1) (bottom), 3 = (x + 1, y) (right). The shape bit k of a terrain id is set where that corner is the
// sector's BASE terrain, and bit k belongs to corner SHAPE_BIT_CORNER[k]: bit 0 = bottom, 1 = right, 2 = top, 3 = left.
// Found on Arcanum1-024-fixed: of the 24 bit orders and both readings (base / to), only this one makes every shared
// corner of two neighbouring transition sectors agree (8443 of 8443; the other readings 54 % or less).
const SHAPE_BIT_CORNER = [2, 3, 0, 1];

// Painting a new world. The game's own world map is a grid of corner points: every sector has four corners (shared with
// its neighbours), a sector whose corners are all one terrain is plain, one whose corners are two terrains is a transition
// sector (base, to, and the shape: see SHAPE_BIT_CORNER).
// So the world is painted on that grid of corner points ((width + 1) x (height + 1) of them), and the sectors follow: a
// painted area keeps its size, and the transition sectors lie along its border. Where the corners of one sector are
// terrains without transition art between them (plains and forest...), the terrain between them (grassland) is put on
// the corners of one of them, as the game's own map does. A sector the templates still cannot show (three terrains
// in its corners, or two without transition art) stays plain with a hard edge.
// Resolves to { types, plan(width, height, painted) }: painted = one terrain id per corner point (y * (width + 1) + x),
// plan gives { ids (one per sector), points (the corner points after the repair), corners (4 terrain ids per sector, in the
// corner order above), transitions, hard, hardPairs }.
export async function loadWorldPlanner() {
  const [types, { names }, folders] = await Promise.all([loadTerrainTypes(), loadTerrainNames(), loadTerrainFolders()]);
  const n = names.length;
  const usable = names.map(nm => folders.has(nm.toLowerCase()));
  const adj = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    adj[a][b] = a !== b && usable[a] && usable[b] && (folders.has(`${names[a]} to ${names[b]}`.toLowerCase()) || folders.has(`${names[b]} to ${names[a]}`.toLowerCase()));
  }
  // How far each terrain is from the first one (grassland) over the transitions: the farther one wins a border.
  const depth = new Array(n).fill(0), seen = new Array(n).fill(false);
  for (let q = [0], i = 0; i < q.length; i++) {
    seen[q[i]] = true;
    for (let b = 0; b < n; b++) if (adj[q[i]][b] && !seen[b]) { seen[b] = true; depth[b] = depth[q[i]] + 1; q.push(b); }
  }
  // The terrain next to (or equal to) every terrain of `set`, a painted one first, then the one nearest grassland; -1 when none.
  const hubFor = set => {
    let best = -1, bestKey = 0;
    for (let r = 0; r < n; r++) {
      if (!usable[r] || !set.every(s => s === r || adj[r][s])) continue;
      const key = (set.includes(r) ? 100 : 0) - depth[r];
      if (best < 0 || key > bestKey) { best = r; bestKey = key; }
    }
    return best;
  };
  // The transition sector id for these two corner terrains, or -1 when the templates have no folder for it.
  const transitionId = (corners, a, b, preferred) => {
    for (const [base, to] of preferred === b ? [[b, a], [a, b]] : [[a, b], [b, a]]) {
      let shape = 0;
      SHAPE_BIT_CORNER.forEach((corner, bit) => { if (corners[corner] === base) shape |= 1 << bit; });
      const tid = (base << 11) | (to << 6) | (shape << 2);
      const t = terrainTemplateFor(tid, names);
      if (t && folders.has(t.folder.toLowerCase())) return tid;
    }
    return -1;
  };
  function plan(width, height, painted) {
    const vw = width + 1, points = Uint8Array.from(painted);
    const cornersOf = (x, y) => [points[y * vw + x], points[(y + 1) * vw + x], points[(y + 1) * vw + x + 1], points[y * vw + x + 1]];
    const drawable = c => { const set = [...new Set(c)]; return set.length === 1 || (set.length === 2 && transitionId(c, set[0], set[1], c[0]) >= 0); };
    // Repair: in a sector the templates cannot show, the corners of the terrain nearest grassland (the lower id on a tie)
    // become the hub terrain, or all those not equal to it when the hub is one of them; neighbours may need it too, so repeat.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const c = cornersOf(x, y);
        if (drawable(c)) continue;
        const set = [...new Set(c)], hub = hubFor(set);
        if (hub < 0) continue;
        const give = set.includes(hub) ? set.filter(t => t !== hub) : [set.reduce((a, t) => depth[t] < depth[a] || (depth[t] === depth[a] && t < a) ? t : a)];
        [[x, y], [x, y + 1], [x + 1, y + 1], [x + 1, y]].forEach(([px, py], k) => { if (give.includes(c[k])) { points[py * vw + px] = hub; changed = true; } });
      }
      if (!changed) break;
    }
    const ids = new Uint16Array(width * height), corners = new Uint8Array(width * height * 4), hardPairs = new Set();
    let transitions = 0, hard = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const c = cornersOf(x, y), set = [...new Set(c)];
      let tid = -1, shown = c;   // (0 is a real id: plain grassland, variant 0)
      if (set.length === 1) tid = worldTerrainId(set[0], x, y);
      else if (set.length === 2) {
        tid = transitionId(c, set[0], set[1], c[0]);
        if (tid >= 0) transitions++;
      }
      if (tid < 0) {
        tid = worldTerrainId(c[0], x, y); shown = [c[0], c[0], c[0], c[0]]; hard++;
        for (const t of set) if (t !== c[0]) hardPairs.add(`${names[c[0]]} / ${names[t]}`);
      }
      ids[y * width + x] = tid;
      corners.set(shown, (y * width + x) * 4);
    }
    return { ids, points, corners, transitions, hard, hardPairs: [...hardPairs] };
  }
  return { types, plan };
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// map.prp (size in tiles), terrain.tdf (one terrain id per sector, rows zlib-compressed like the game's own) and
// mapinfo.txt for a new world: [{ name, bytes }].
// `ids` is the sector id grid of the planner (one id per sector), or one base terrain id for a world of that terrain only;
// the base terrain (map.prp, terrain.tdf header) is that one, or grassland (0) for a grid.
export async function buildWorldFiles(width, height, ids, terrainId = 0) {
  if (typeof ids === 'number') { terrainId = ids; ids = uniformWorldIds(width, height, ids); }
  const prp = new Uint8Array(0x18), pv = new DataView(prp.buffer);
  pv.setInt32(0, terrainId, true);
  pv.setBigInt64(8, BigInt(width * 64), true); pv.setBigInt64(16, BigInt(height * 64), true);
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(await deflate(new Uint8Array(ids.slice(y * width, (y + 1) * width).buffer)));
  const tdf = new Uint8Array(TERRAIN_HEADER_SIZE + rows.reduce((n, r) => n + 4 + r.length, 0)), tv = new DataView(tdf.buffer);
  tv.setFloat32(0, 1.2, true); tv.setUint32(4, 1, true);
  tv.setBigInt64(8, BigInt(width), true); tv.setBigInt64(16, BigInt(height), true);
  tv.setInt32(24, terrainId, true);
  let at = TERRAIN_HEADER_SIZE;
  for (const r of rows) { tv.setInt32(at, r.length, true); tdf.set(r, at + 4); at += 4 + r.length; }
  // The map's default light scheme (sectors use 0 = this default) and its music / ambience come from mapinfo.txt;
  // without one the game keeps whatever the previous map set. The values of the shipped outdoor world map.
  const mapinfo = secMapInfoBytes(null, { LightScheme: 1, SoundScheme: '1,40' });
  return [{ name: 'map.prp', bytes: prp }, { name: 'terrain.tdf', bytes: tdf }, { name: 'mapinfo.txt', bytes: mapinfo }];
}

// A new world of width x height sectors, held in memory only (no .sec exists until the editor exports). `ids` is the
// planner's id grid, or one base terrain id for a world of that terrain only. Each sector is its own editable copy of
// the template of its terrain id: tiles, lights (moved to the sector's place, in the bytes too) and objects are not shared.
export async function createWorldSectors(width, height, ids, onProgress) {
  if (typeof ids === 'number') ids = uniformWorldIds(width, height, ids);
  const [{ names }, folders] = await Promise.all([loadTerrainNames(), loadTerrainFolders()]);
  const cells = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push({ x, y });
  const out = [];
  for (let i = 0; i < cells.length; i += 4) {
    onProgress?.(i, cells.length);
    await Promise.all(cells.slice(i, i + 4).map(async ({ x, y }) => {
      const t = terrainTemplateFor(ids[y * width + x], names);
      if (!t) throw new Error(`no template for sector ${x}, ${y} (terrain id ${ids[y * width + x]})`);
      const folder = folders.get(t.folder.toLowerCase()) || t.folder;
      const info = { x, y, id: String((BigInt(y) << 26n) | BigInt(x)), template: { folder, file: t.file, path: `${folder}/${t.file}.sec` } };
      const shared = await loadTerrainSector(info);
      if (!shared) throw new Error(`template ${info.template.path} was not found`);
      out.push(editableTerrainSector(shared));
    }));
  }
  return out;
}

// An editable copy of a sector made by loadTerrainSector(): its own tiles, lights (moved to the sector's place, in the
// bytes too), objects, tile scripts and roofs, and no `terrain` mark, so the editor treats it like a sector of the
// map and exports it as a .sec of its own place (the writer moves the objects there).
export function editableTerrainSector(shared) {
  const d = shared.decoded;
  const buf = d.sourceBuffer.slice(0), dv = new DataView(buf);
  d.lights.forEach((l, n) => { dv.setUint32(4 + n * 0x30 + 8, l.x >>> 0, true); dv.setUint32(4 + n * 0x30 + 12, l.y >>> 0, true); });
  return {
    filename: shared.filename, position: { x: shared.position.x, y: shared.position.y },
    decoded: { ...d, filename: shared.filename, sourceBuffer: buf, tiles: Uint32Array.from(d.tiles), lights: d.lights.map(l => ({ ...l })),
      staticObjects: d.staticObjects.map(o => ({ ...o })), tileScripts: (d.tileScripts || []).slice(), roofArtIds: d.roofArtIds && Uint32Array.from(d.roofArtIds) }
  };
}

// Loads and decodes the template of one sector, moved to the sector's own place the way
// sector_light_list_load does (lights keep their tile inside the sector, objects are already placed
// by their sector-local tile). Resolves to a sector shaped like the folder's own ones, or null when
// the engine would have no template for it either.
// Many sectors share one template, so each template is fetched and decoded once. Sectors get their
// own copy of the decoded record (tiles and objects are shared and read-only: terrain sectors are not
// editable) with their own, shifted lights.
const templateCache = new Map();   // template path -> Promise<decoded | null>
export async function loadTerrainSector(info) {
  if (!info?.template) return null;
  const path = info.template.path;
  if (!templateCache.has(path)) {
    const p = (async () => {
      const resp = await fetch(`${TERRAIN_ROOT}${encPath(info.template.folder)}/${info.template.file}.sec`);
      return resp.ok ? readSecTileData(await resp.arrayBuffer(), path) : null;
    })();
    templateCache.set(path, p);
    p.catch(() => templateCache.delete(path));
  }
  const template = await templateCache.get(path);
  if (!template) return null;
  const filename = `${info.id}.sec`;
  const lights = template.lights.map(l => ({ ...l, x: (l.x & 63) + info.x * 64, y: (l.y & 63) + info.y * 64 }));
  return { filename, position: { x: info.x, y: info.y }, decoded: { ...template, lights }, terrain: info };
}
