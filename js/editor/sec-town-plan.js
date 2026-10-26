// A little town for a new world: where its houses go and what each is for. Pure layout, no editor state: `open(a, b, c, e)`
// says whether the tiles [a, b) x [c, e) are free ground.
// A house spans 4n + 1 tiles, from a tile that is 2 mod 4 (the roof grid, see snapHouseSpan in sec-house-tools.js), so the
// rectangles made here are left as they are when the Generate tool snaps them.

import { TUNNEL_RIGHT, TUNNEL_UP } from './sec-train-station.js';

const GAP = 6;         // tiles of ground kept between two houses (room for a path)
const EDGE = 4;         // ... and between a house and the edge of the map

// Houses for a town of `npcs` people: a house holds one or two on average (1.5 here, a little random).
export const townHouseCount = (npcs, rand = Math.random) => Math.max(1, Math.round(npcs / (1 + rand())));

// The wall style (HOUSE_STYLES key) a town built on terrain `name` uses for all its houses: what its builders would have at hand.
export function townWallStyle(name = '') {
  if (/snow|frozen/.test(name)) return 27;         // cold stone, snowy
  if (/desert/.test(name)) return 7;               // beige stone
  if (/tropical|jungle/.test(name)) return 10;     // seaside village
  if (/swamp/.test(name)) return 17;               // wood shack
  if (/forest/.test(name)) return 14;              // wood shack
  if (/mountain/.test(name)) return 3;             // grey stone
  return 0;                                        // village, for grass and plains
}

// [kind, wide, deep] of the buildings a town has besides its homes, in the order they are added.
const SHOPS = [['tavern', 13, 13], ['store', 9, 13], ['smith', 9, 9], ['herbalist', 9, 9], ['temple', 13, 13], ['inn', 13, 17], ['tech', 9, 13]];

const SECTOR = 64;
const RAIL_TO_TUNNEL = 100;   // tiles of track after the station before the mountain, when the map's edge is far

// The track east of a station rect `r` (its top row is 4 below r.c): to the edge of the map, or - when that is more than
// 3 sectors away, as in the base game - to a mountain with a tunnel. `box` is the ground it takes, kept free of houses.
function railFrom(r, mapW) {
  if (mapW - r.b > 3 * SECTOR && r.c + 4 - TUNNEL_UP >= 2) {
    const end = r.b + RAIL_TO_TUNNEL;
    return { tunnel: true, end, box: { a: r.b, b: end + TUNNEL_RIGHT, c: r.c + 4 - TUNNEL_UP, e: r.c + 8 } };
  }
  return { tunnel: false, end: mapW, box: { a: r.b, b: mapW, c: r.c + 2, e: r.c + 9 } };
}

// `station`: [wide, deep] of a train station to fit in as well (kind 'station'; the caller stamps it). Its rect gets
// `rail`: { tunnel, end (the tile where the track stops), box }.
export function planTown({ rand, mapW, mapH, open, count, station = null }) {
  const shops = Math.min(SHOPS.length, Math.floor(count / 3));
  const wanted = [];
  for (let i = 0; i < shops; i++) wanted.push(SHOPS[i]);
  while (wanted.length < count) wanted.push(['home', rand() < 0.65 ? 9 : 13, rand() < 0.65 ? 9 : 13]);
  if (station) wanted.push(['station', station[0], station[1]]);
  count = wanted.length;
  wanted.sort((p, q) => q[1] * q[2] - p[1] * p[2]);   // the big ones first, the small fill the gaps
  const radius = 12 + 7 * Math.sqrt(count);
  const clear = (r, others) => r.a >= 2 && r.c >= 2 && r.b <= mapW - EDGE && r.e <= mapH - EDGE
    && others.every(o => r.a - GAP >= o.b || o.a - GAP >= r.b || r.c - GAP >= o.e || o.c - GAP >= r.e)
    && open(r.a - 2, r.b + 2, r.c - 2, r.e + 2);
  let best = null;
  for (let site = 0; site < 60; site++) {
    // the town's centre starts near the middle of the map and the search spreads out from there when the ground is not open
    const spread = 0.12 + 0.88 * site / 59;
    const cx = mapW / 2 + (rand() - 0.5) * spread * (mapW - 2 * EDGE - 12), cy = mapH / 2 + (rand() - 0.5) * spread * (mapH - 2 * EDGE - 12), rects = [], blocks = [];
    for (const [kind, w, d] of wanted) {
      for (let tryNo = 0; tryNo < 40; tryNo++) {
        const ang = rand() * Math.PI * 2, dist = rects.length ? rand() * radius * (1 + tryNo / 40) : 0;
        // the station's booth sits 5 tiles in, so it has the roof grid's 2 mod 4 when the station stands on 1 mod 4
        const grid = kind === 'station' ? 1 : 2;
        const a = 4 * Math.round((cx + Math.cos(ang) * dist - w / 2 - 2) / 4) + grid, c = 4 * Math.round((cy + Math.sin(ang) * dist - d / 2 - 2) / 4) + grid;
        const r = { kind, a, b: a + w, c, e: c + d };
        if (kind === 'station') r.rail = railFrom(r, mapW);
        if (clear(r, rects.concat(blocks))) { rects.push(r); if (r.rail) blocks.push(r.rail.box); break; }
      }
    }
    if (!best || rects.length > best.rects.length) best = { rects, cx, cy };
    if (rects.length === count) break;
  }
  return best && best.rects.length ? best : null;
}
