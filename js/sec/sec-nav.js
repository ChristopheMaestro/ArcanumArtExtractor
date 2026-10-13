// Walkability of a SEC map and path-finding over it, for the NPCs that roam under "Animate".
// A port of what game/path.c (path_make) consults for a walking NPC:
//  * tile_is_blocking() (tile.c): the sector's tile block mask, a facade that is not walkable,
//    and tiles whose tilename.mes entry carries the b or f flag (water, lava, cliffs...);
//  * object_calc_traversal_cost_func() (object.c): walls and portals stand on tile EDGES and
//    block the step across that edge (windows can be climbed through, but not diagonally);
//    containers and scenery without OF_NO_BLOCK block the tile they stand on; a diagonal step
//    is four edge steps, so it cannot cut a corner;
//  * sub_41F840: first try a straight line; sub_41F9F0: otherwise an A* over a 64x64 window
//    (cost 10 per step, +1 for a turn, +50 for a window).
// Left out: other critters (they move, and never block each other here), traps, fire.

import { ART_TYPE, artType } from '../core/art-id.js';
import { decodeWallArtId } from '../objects/wall-art.js';
import { secFacadeWalkable, secSectorAllZero, secTileInfo, secTileNameMesMap } from './sec-tile-art.js';
import { secRotationFromDelta } from './sec-rotation.js';

// location_in_dir(): the tile offset of each rotation.
export const SEC_ROT_STEP = [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1]];
export const secCheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const OF_DESTROYED = 0x1, OF_NO_BLOCK = 0x400;
const OPF_JAMMED = 0x2, OPF_MAGICALLY_HELD = 0x4, OPF_ALWAYS_LOCKED = 0x10, OPF_BUSTED = 0x80;
// Wall pieces (p_piece) with a window, and those that can be walked through.
const WINDOW_PIECES = new Set([10, 13, 14, 17, 18, 19]);
const OPEN_PIECES = new Set([22, 25, 26, 29, 30, 31, 32]);
const BLOCKED = 1, WINDOW = 2, OBJECT = 3;     // traversal results (0 = free)
const NO_PATH = -32768;

const tileKey = (x, y) => y * 65536 + x;
const edgeKey = (x, y, rot) => (y * 65536 + x) * 8 + rot;

let navSeq = 0;

// `sectorMap`: "sectorX,sectorY" -> sector with decoded tiles; `points`: every placed object.
export function buildSecNav(sectorMap, points) {
  const objBlocked = new Set();     // tiles holding a blocking container / scenery
  const edges = new Map();          // tile edge -> BLOCKED | WINDOW
  const addEdge = (x, y, rot, kind) => {
    // The step across an edge is blocked from either side: also store it for the neighbour.
    const [dx, dy] = SEC_ROT_STEP[rot];
    for (const k of [edgeKey(x, y, rot), edgeKey(x + dx, y + dy, (rot + 4) & 7)]) {
      if ((edges.get(k) || 0) !== BLOCKED) edges.set(k, kind);
    }
  };
  // A wall or portal's rotation names its edge; the game folds even rotations onto the next odd one.
  const edgeRot = r => (r & 1) ? r : (r + 1) & 7;
  for (const o of points) {
    const flags = o.objFlags | 0;
    if (o.type === 2 || o.type === 3) {
      if (!(flags & (OF_DESTROYED | OF_NO_BLOCK))) objBlocked.add(tileKey(o.worldX, o.worldY));
    } else if (o.type === 0) {
      const d = o.wallDecode || (o.currentAidRaw != null ? decodeWallArtId(o.currentAidRaw) : null);
      if (!d || !Number.isInteger(d.rotation)) continue;
      const kind = WINDOW_PIECES.has(d.piece) ? WINDOW : OPEN_PIECES.has(d.piece) ? 0 : BLOCKED;
      if (kind) addEdge(o.worldX, o.worldY, edgeRot(d.rotation & 7), kind);
    } else if (o.type === 1 && Number.isInteger(o.portalRotation)) {
      // ai_attempt_open_portal(): an NPC opens any door except a jammed, held or always-locked one.
      const pf = o.portalFlags | 0;
      if ((pf & (OPF_JAMMED | OPF_MAGICALLY_HELD | OPF_ALWAYS_LOCKED)) && !(pf & OPF_BUSTED)) addEdge(o.worldX, o.worldY, edgeRot(o.portalRotation & 7), BLOCKED);
    }
  }

  const rawBlocks = new Map();
  const tileArtBlocks = raw => {
    let v = rawBlocks.get(raw);
    if (v === undefined) {
      if (artType(raw) === ART_TYPE.FACADE) v = !secFacadeWalkable(raw);
      else v = /[bf]/.test(String(secTileNameMesMap?.get(secTileInfo(raw).artId)?.flags || '').split(/\s/)[0]);
      rawBlocks.set(raw, v);
    }
    return v;
  };
  // tile_is_blocking(): tiles outside the map's sectors do not exist, so they block too.
  const tileBlocked = (x, y) => {
    if (x < 0 || y < 0) return true;
    const d = sectorMap.get(`${x >> 6},${y >> 6}`)?.decoded;
    if (!d?.tiles || secSectorAllZero(d)) return true;
    const i = (y & 63) * 64 + (x & 63);
    if (d.blockMask && ((d.blockMask[i >> 5] >>> (i & 31)) & 1)) return true;
    return tileArtBlocks(d.tiles[i] >>> 0);
  };

  // One step across an edge in an odd direction; `orig` is the direction of the whole move.
  const orthStep = (x, y, rot, orig) => {
    const e = edges.get(edgeKey(x, y, rot));
    let res = 0;
    if (e === BLOCKED) return BLOCKED;
    if (e === WINDOW) { if (!(orig & 1)) return BLOCKED; res = WINDOW; }
    const [dx, dy] = SEC_ROT_STEP[rot];
    return objBlocked.has(tileKey(x + dx, y + dy)) ? OBJECT : res;
  };
  const traversal = (x, y, rot) => {
    if (rot & 1) return orthStep(x, y, rot, rot);
    const ccw = (rot + 7) & 7, cw = (rot + 1) & 7;
    const [ax, ay] = SEC_ROT_STEP[ccw], [bx, by] = SEC_ROT_STEP[cw];
    let res = 0;
    for (const [px, py, r] of [[x, y, ccw], [x + ax, y + ay, cw], [x, y, cw], [x + bx, y + by, ccw]]) {
      const v = orthStep(px, py, r, rot);
      if (v === BLOCKED || v === OBJECT) return BLOCKED;
      res = Math.max(res, v);
    }
    return res;
  };
  const passable = (x, y) => !tileBlocked(x, y) && !objBlocked.has(tileKey(x, y));

  const nav = { id: ++navSeq, passable, tileBlocked, traversal };

  // sub_41F840: straight toward the target; gives up at the first obstacle (windows included).
  const straight = (from, to, maxRot) => {
    if (secCheb(from, to) > 32) return null;
    const path = [];
    let loc = from;
    for (let i = 0; i < maxRot && (loc.x !== to.x || loc.y !== to.y); i++) {
      const rot = secRotationFromDelta(to.x - loc.x, to.y - loc.y);
      const [dx, dy] = SEC_ROT_STEP[rot];
      const adj = { x: loc.x + dx, y: loc.y + dy };
      if (tileBlocked(adj.x, adj.y) || traversal(loc.x, loc.y, rot)) break;
      path.push(adj); loc = adj;
    }
    return loc.x === to.x && loc.y === to.y ? path : null;
  };

  // sub_41F9F0: A* over the 64x64 window around both ends, one array slot per tile.
  const cost = new Int32Array(4096), back = new Int16Array(4096);
  const astar = (from, to, maxRot) => {
    const ddx = Math.abs(from.x - to.x), ddy = Math.abs(from.y - to.y);
    if (ddx > 32 || ddy > 32) return null;
    const ox = Math.min(from.x, to.x) - ((64 - ddx) >> 1), oy = Math.min(from.y, to.y) - ((64 - ddy) >> 1);
    const start = (from.x - ox) + (from.y - oy) * 64, target = (to.x - ox) + (to.y - oy) * 64;
    const dist = i => 10 * Math.max(Math.abs((i & 63) - (target & 63)), Math.abs((i >> 6) - (target >> 6)));
    cost.fill(0);
    cost[start] = 1; back[start] = -1;
    let open = [start];
    for (let guard = 0; guard < 8000; guard++) {
      let cur = -1, best = 0;
      const live = [];
      for (const i of open) {
        if (cost[i] <= 0) continue;
        const est = cost[i] + dist(i);
        if (Math.trunc(est / 10) > maxRot) { cost[i] = NO_PATH; continue; }
        live.push(i);
        if (cur === -1 || est < best || (est === best && i < cur)) { best = est; cur = i; }
      }
      open = live;
      if (cur === -1) return null;
      if (cur === target) break;
      const lx = ox + (cur & 63), ly = oy + (cur >> 6);
      for (let rot = 0; rot < 8; rot++) {
        const ax = lx + SEC_ROT_STEP[rot][0], ay = ly + SEC_ROT_STEP[rot][1];
        const wx = ax - ox, wy = ay - oy;
        if (wx < 0 || wx >= 64 || wy < 0 || wy >= 64) continue;
        const nb = wx + wy * 64;
        if (cost[nb] === NO_PATH) continue;
        if (tileBlocked(ax, ay)) { cost[nb] = NO_PATH; continue; }
        const t = traversal(lx, ly, rot);
        if (t === BLOCKED || t === OBJECT) {
          // An object on the tile ahead rules the tile out; a wall only closes this one edge.
          if ((rot & 1) && t === OBJECT) cost[nb] = NO_PATH;
          continue;
        }
        let c = 10 + (t === WINDOW ? 50 : 0) + cost[cur];
        if (back[cur] !== -1 && secRotationFromDelta((cur & 63) - (back[cur] & 63), (cur >> 6) - (back[cur] >> 6)) !== rot) c++;
        const old = cost[nb];
        if (old === 0 || (old > 0 && old > c) || (old < 0 && -old > c)) {
          cost[nb] = c; back[nb] = cur;
          if (old <= 0) open.push(nb);
        }
      }
      cost[cur] = -cost[cur];
    }
    const chain = [];
    for (let i = target; i !== start; i = back[i]) chain.push(i);
    if (chain.length > maxRot) return null;
    return chain.reverse().map(i => ({ x: ox + (i & 63), y: oy + (i >> 6) }));
  };

  // path_make(): the tiles to step on (the start excluded), or null when there is no way.
  const plan = (from, to) => {
    if (from.x === to.x && from.y === to.y) return [];
    if (!passable(to.x, to.y)) return null;
    const maxRot = Math.min(60, secCheb(from, to) * 2 + 10);
    return straight(from, to, maxRot) || astar(from, to, maxRot);
  };
  // The free tile closest to `at` (within a few tiles), or null.
  const nearestFree = (at, radius = 3) => {
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r && passable(at.x + dx, at.y + dy)) return { x: at.x + dx, y: at.y + dy };
      }
    }
    return null;
  };
  // A path longer than the 32 tiles one search covers is made of several: each aims at a free
  // tile on the line to the goal.
  const planLong = (from, to) => {
    const out = [];
    let pos = from;
    for (let n = 0; n < 40; n++) {
      const d = secCheb(pos, to);
      let hop = to;
      if (d > 30) {
        const s = 28 / d;
        hop = nearestFree({ x: Math.round(pos.x + (to.x - pos.x) * s), y: Math.round(pos.y + (to.y - pos.y) * s) });
        if (!hop) return out.length ? out : null;
      }
      const part = plan(pos, hop);
      if (!part) return out.length ? out : null;
      out.push(...part);
      if (part.length) pos = part[part.length - 1];
      if (hop === to) return out;
    }
    return out;
  };

  nav.plan = plan;
  nav.planLong = planLong;
  // ai_move_to(obj, goal, range): walk toward `goal` and stop once within `range` of it.
  // Tiles stepped on, [] when already close enough, null when it cannot be reached.
  nav.leg = (from, goal, range) => {
    if (secCheb(from, goal) <= range) return [];
    const target = passable(goal.x, goal.y) ? goal : nearestFree(goal);
    const path = target ? planLong(from, target) : null;
    if (!path) return null;
    const stop = path.findIndex(t => secCheb(t, goal) <= range);
    return stop < 0 ? path : path.slice(0, stop + 1);
  };
  return nav;
}
