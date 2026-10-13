// The game's areas, from data/mes/gamearea.mes (read by area_mod_load() in game/area.c), and the
// secret areas of the world map folder. Used by the folder map's "Areas" overlay.
//
// Each entry is {n}{X, Y, labelDX, labelDY /Name/Description[/Radius:n]}: X and Y are world-map tile
// coordinates (the same grid as sector * 64 + tile), the offsets only place the name on the in-game
// world map. A place belongs to an area when its tile distance (location_dist(): the larger of |dx|
// and |dy|) is below the radius, 5 sectors unless given; a negative radius means the area is never
// found by walking near it. Entries at 0,0 are the "unknown area" placeholders (0, and unused slots).

import { DATA_ROOT } from '../core/config.js';
import { parseMesText } from '../core/mes-parser.js';

export const DEFAULT_AREA_RADIUS = 5;

export function parseGameAreas(text) {
  const places = [];
  for (const [num, raw] of parseMesText(text)) {
    const parts = String(raw).split('/');
    const nums = (parts[0] || '').split(',').map(s => parseInt(s, 10));
    if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1]) || (nums[0] === 0 && nums[1] === 0)) continue;
    const name = (parts[1] || '').trim();
    if (!name) continue;
    const radius = /^Radius:\s*(-?\d+)/i.exec((parts[3] || '').trim());
    const sectors = radius ? Number(radius[1]) : DEFAULT_AREA_RADIUS;
    places.push({
      num, name, description: (parts[2] || '').trim(), radius: radius ? Number(radius[1]) : null,
      sectors, tiles: sectors * 64,   // the detection radius actually used
      x: nums[0], y: nums[1], sectorX: Math.floor(nums[0] / 64), sectorY: Math.floor(nums[1] / 64),
      tileX: nums[0] & 63, tileY: nums[1] & 63
    });
  }
  return places;
}

let placesPromise = null;
export function loadGameAreas() {
  if (!placesPromise) placesPromise = (async () => {
    const resp = await fetch(`${DATA_ROOT}mes/gamearea.mes`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`gamearea.mes: HTTP ${resp.status}`);
    return parseGameAreas(await resp.text());
  })().catch(err => { placesPromise = null; throw err; });
  return placesPromise;
}

// Secret areas are the "Secret Area - <n or name>" sub-folders of the world map folder. Shown as
// "Secret Area - 3" when the suffix is a number, else by the name ("Fan Graveyard"); null otherwise.
export function secretAreaName(folder) {
  const m = /^secret area\s*-\s*(.+)$/i.exec(String(folder || '').trim());
  if (!m) return null;
  const suffix = m[1].trim();
  return /^\d+$/.test(suffix) ? `Secret Area - ${suffix}` : suffix;
}
