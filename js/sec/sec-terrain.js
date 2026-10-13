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
import { encPath } from '../core/util.js';
import { readSecTileData } from './sec-parser.js';
import { secMapInfoBytes } from '../editor/sec-writer.js';

const TERRAIN_ROOT = `${DATA_ROOT}terrain/`;
const TERRAIN_HEADER_SIZE = 0x20;
const FIRST_TRANSITION_ID = 200;
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
    const resp = await fetch(`${TERRAIN_ROOT}terrain.mes`, { cache: 'no-store' });
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
  const resp = await fetch(`${TERRAIN_ROOT}terrain.mes`, { cache: 'no-store' });
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
    try {
      const resp = await fetch(`${TERRAIN_ROOT}terrain_manifest.json`, { cache: 'no-store' });
      if (resp.ok) for (const name of Object.keys((await resp.json()).subfolders || {})) map.set(name.toLowerCase(), name);
    } catch (_) {}
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
export function loadTerrainMap(relativePath) {
  const key = String(relativePath || '');
  if (!terrainMapCache.has(key)) {
    const p = loadTerrainMapUncached(relativePath);
    terrainMapCache.set(key, p);
    p.catch(() => terrainMapCache.delete(key));
  }
  return terrainMapCache.get(key);
}
async function loadTerrainMapUncached(relativePath) {
  let resp;
  try { resp = await fetch(`${SEC_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}terrain.tdf`, { cache: 'no-store' }); } catch (_) { return null; }
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  if (buf.byteLength < TERRAIN_HEADER_SIZE) return null;
  const view = new DataView(buf);
  const flags = view.getUint32(4, true);
  const width = Number(view.getBigInt64(8, true)), height = Number(view.getBigInt64(16, true));
  if (Math.abs(view.getFloat32(0, true) - 1.2) > 1e-4 || width < MIN_WORLD_SECTORS || height < MIN_WORLD_SECTORS || width * height > 1 << 24) return null;
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
  const { names, blocked } = await loadTerrainNames();
  const folders = await loadTerrainFolders();
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

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// map.prp (size in tiles), terrain.tdf (one terrain id per sector, rows zlib-compressed like the game's own) and
// mapinfo.txt for a new world: [{ name, bytes }].
export async function buildWorldFiles(width, height, terrainId) {
  const prp = new Uint8Array(0x18), pv = new DataView(prp.buffer);
  pv.setInt32(0, terrainId, true);
  pv.setBigInt64(8, BigInt(width * 64), true); pv.setBigInt64(16, BigInt(height * 64), true);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const ids = new Uint16Array(width);
    for (let x = 0; x < width; x++) ids[x] = worldTerrainId(terrainId, x, y);
    rows.push(await deflate(new Uint8Array(ids.buffer)));
  }
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

// A new world of width x height sectors of one base terrain, held in memory only (no .sec exists until
// the editor exports). Each sector is its own editable copy of a plain template of that terrain:
// tiles, lights (moved to the sector's place, in the bytes too) and objects are not shared.
export async function createWorldSectors(width, height, terrainId, onProgress) {
  const { names } = await loadTerrainNames();
  const folders = await loadTerrainFolders();
  const cells = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells.push({ x, y });
  const out = [];
  for (let i = 0; i < cells.length; i += 4) {
    onProgress?.(i, cells.length);
    await Promise.all(cells.slice(i, i + 4).map(async ({ x, y }) => {
      const t = terrainTemplateFor(worldTerrainId(terrainId, x, y), names);
      if (!t) throw new Error(`no template for terrain ${names[terrainId]}`);
      const folder = folders.get(t.folder.toLowerCase()) || t.folder;
      const info = { x, y, id: String((BigInt(y) << 26n) | BigInt(x)), template: { folder, file: t.file, path: `${folder}/${t.file}.sec` } };
      const shared = await loadTerrainSector(info);
      if (!shared) throw new Error(`template ${info.template.path} was not found`);
      const d = shared.decoded;
      const buf = d.sourceBuffer.slice(0), dv = new DataView(buf);
      d.lights.forEach((l, n) => { dv.setUint32(4 + n * 0x30 + 8, l.x >>> 0, true); dv.setUint32(4 + n * 0x30 + 12, l.y >>> 0, true); });
      out.push({
        filename: shared.filename, position: { x, y },
        decoded: { ...d, filename: shared.filename, sourceBuffer: buf, tiles: Uint32Array.from(d.tiles), lights: d.lights.map(l => ({ ...l })),
          staticObjects: d.staticObjects.map(o => ({ ...o })), tileScripts: (d.tileScripts || []).slice(), roofArtIds: d.roofArtIds && Uint32Array.from(d.roofArtIds) }
      });
    }));
  }
  return out;
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
      const resp = await fetch(`${TERRAIN_ROOT}${encPath(info.template.folder)}/${info.template.file}.sec`, { cache: 'no-store' });
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
