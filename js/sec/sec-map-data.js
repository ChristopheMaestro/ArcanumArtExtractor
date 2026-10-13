// Map-level files of a data/maps folder, read the way game/map.c and friends read them.
//
//   map.prp       MapProperties { int base_terrain_type; int pad; int64 width; int64 height }, in tiles
//                 (map_open(); the map spans tiles 0 .. width-1 / height-1, i.e. width / 64 sectors)
//   startloc.txt  two lines, x and y: the tile the player starts on (map_open())
//   map.jmp       int count, then JumpPoint[count] { flags; pad; int64 loc; int dst_map; pad;
//                 int64 dst_loc } (jumppoint.c); dst_map is a 1-based index into Rules/MapList.mes
//   map.sbf       int count, then int64 sector ids: the blocked sectors (sector.c)
// A location is int64 x | y << 32. Sector ids are x | y << 26 (in sectors).
// Sub-folders of a world map (towns, secret areas) have none of these: they use their map's.

import { DATA_ROOT } from '../core/config.js';
import { fetchBuffer, fetchText, memoAsync, mesTable } from '../core/text-io.js';
import { encPath } from '../core/util.js';

const MAPS_ROOT = `${DATA_ROOT}maps/`;
const fileUrl = (folder, name) => `${MAPS_ROOT}${encPath(folder)}/${name}`;
const optional = p => p.catch(() => null);
const locXY = (view, at) => ({ x: view.getUint32(at, true), y: view.getUint32(at + 4, true) });

const cache = new Map();
// Everything map-level about the map folder `folder` (the top folder of a path): { limits, start,
// jumps, blockedSectors }, each null / empty when the file is missing.
export function loadMapData(folder) {
  const key = String(folder || '').split('/')[0];
  if (!cache.has(key)) cache.set(key, (async () => {
    const [prp, start, jmp, sbf] = await Promise.all([
      optional(fetchBuffer(fileUrl(key, 'map.prp'))),
      optional(fetchText(fileUrl(key, 'startloc.txt'))),
      optional(fetchBuffer(fileUrl(key, 'map.jmp'))),
      optional(fetchBuffer(fileUrl(key, 'map.sbf'))),
    ]);
    const out = { folder: key, limits: null, start: null, jumps: [], blockedSectors: new Set() };
    if (prp && prp.byteLength >= 0x18) {
      const v = new DataView(prp);
      const w = Number(v.getBigInt64(8, true)), h = Number(v.getBigInt64(16, true));
      if (w > 0 && h > 0) out.limits = { baseTerrain: v.getInt32(0, true), widthTiles: w, heightTiles: h, sectorsX: Math.ceil(w / 64), sectorsY: Math.ceil(h / 64) };
    }
    if (start) {
      const [x, y] = start.split(/\r?\n/).map(s => parseInt(s, 10));
      if (Number.isFinite(x) && Number.isFinite(y)) out.start = { x, y };
    }
    if (jmp && jmp.byteLength >= 4) {
      const v = new DataView(jmp), n = v.getInt32(0, true);
      for (let i = 0; i < n && 4 + (i + 1) * 0x20 <= jmp.byteLength; i++) {
        const at = 4 + i * 0x20;
        out.jumps.push({ flags: v.getUint32(at, true), ...locXY(v, at + 8), dstMap: v.getInt32(at + 0x10, true), dst: locXY(v, at + 0x18) });
      }
    }
    if (sbf && sbf.byteLength >= 4) {
      const v = new DataView(sbf), n = v.getInt32(0, true);
      for (let i = 0; i < n && 4 + (i + 1) * 8 <= sbf.byteLength; i++) {
        const id = v.getBigUint64(4 + i * 8, true);
        out.blockedSectors.add(`${Number(id & 0x3FFFFFFn)},${Number(id >> 26n)}`);
      }
    }
    return out;
  })());
  return cache.get(key);
}

// Rules/MapList.mes: map number (1-based, as jump points and scripts use it) -> folder name.
const mapListMes = mesTable(`${DATA_ROOT}Rules/MapList.mes`);
export const loadMapList = memoAsync(async () => {
  const table = await mapListMes();
  const out = new Map();
  for (const [num, str] of [...table].sort((a, b) => a[0] - b[0])) {
    if (num < 5000) continue;
    out.set(num - 4999, String(str).split(',')[0].trim());   // map_list_info_load() reads from 5000 on
  }
  return out;
});

// Name tables for the sector properties.
export const loadTownMapNames = mesTable(`${DATA_ROOT}Rules/TownMap.mes`);
export const loadLightSchemeNames = mesTable(`${DATA_ROOT}Rules/Lighting Schemes.mes`);
