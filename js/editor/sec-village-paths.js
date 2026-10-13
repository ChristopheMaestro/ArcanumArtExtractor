// Paths between houses, the way a village looks in the game: a strip of trodden dirt a few tiles wide that wanders
// round the houses and trees instead of running straight, leaves a door at right angles, and joins the other
// paths in T-junctions rather than running beside them.
//
// The editor describes the ground as a grid (see PATH_CELL) and the doors to join; this returns the cells to paint.
// No DOM here: the editor does the painting, and the blending of the edges, with its usual tile code.
//
//  * Each door's path is searched (Dijkstra) over the grid from the tile in front of the door to the paths already
//    laid, doors being taken nearest first, so the result is a spanning tree like a village's lanes.
//  * The cost of a tile has a smooth noise on it: the cheapest way bends round the dear places, which is what makes a
//    path wander. Tiles next to a house cost more (a path keeps a little away from the walls), a street or an existing
//    path costs less (paths join them), and a path already laid is nearly free (so paths merge).
//  * The line is then smoothed and stamped with a disc whose radius drifts along the way, with a ragged edge.

export const PATH_CELL = { GROUND: 0, STREET: 1, OBSTACLE: 2, HOUSE: 3 };
// The planner gives up after this long and keeps the paths it has found so far.
export const PATH_TIME_LIMIT_MS = 5000;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// GROUND: open earth that is painted; STREET: walkable but not painted (paving, planks...); OBSTACLE: water, trees, anything
// that blocks; HOUSE: a house (floor, facade, a tile that carries a wall or a door), never walked or painted.

const hash2 = (x, y, s) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = t => t * t * (3 - 2 * t);
const vnoise = (x, y, s) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = smooth(x - xi), fy = smooth(y - yi);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};
const fbm = (x, y, s) => 0.65 * vnoise(x / 9, y / 9, s) + 0.35 * vnoise(x / 4, y / 4, s + 101);

// A binary min-heap of (cost, cell) pairs.
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, topK = k[0], topV = v[0], lastK = k.pop(), lastV = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return [topK, topV];
  }
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

// grid: { w, h, kind: Uint8Array(w * h) of PATH_CELL, prefer?: Uint8Array (1 = a path already lies here) }
// doors: [{ x, y, dx, dy }]  x, y: the tile just outside the door (grid coordinates); dx, dy: the step away from it
// opts:  { width (tiles), wind (0..1), seed }
// returns { paint: Uint8Array(w * h) (1 = paint this cell), joined: door indexes that got a path, failed: those that could not }
export function planVillagePaths(grid, doors, { width = 3, wind = 0.5, seed = 1, timeLimit = PATH_TIME_LIMIT_MS } = {}) {
  const { w, h, kind, prefer } = grid, N = w * h;
  const deadline = now() + timeLimit;
  let timedOut = false;
  const paint = new Uint8Array(N), net = new Uint8Array(N);
  const open = i => kind[i] === PATH_CELL.GROUND || kind[i] === PATH_CELL.STREET;
  const near = (x, y, what) => {
    for (const [dx, dy] of STEPS) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && kind[ny * w + nx] === what) return true; }
    return false;
  };

  // What a step onto each cell costs.
  const base = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!open(i)) { base[i] = Infinity; continue; }
    let c = 1 + wind * 3 * fbm(x, y, seed);
    if (near(x, y, PATH_CELL.HOUSE)) c += 2.5;
    else if (near(x, y, PATH_CELL.OBSTACLE)) c += 0.4;
    if (kind[i] === PATH_CELL.STREET) c = Math.min(c, 0.7);
    if (prefer && prefer[i]) c = Math.min(c, 0.45);
    base[i] = c;
  }

  // The tile in front of each door and the few tiles straight out of it: a path leaves a door at right angles.
  const leads = doors.map(d => {
    const cells = [];
    let x = d.x, y = d.y;
    for (let k = 0; k < 3; k++, x += d.dx, y += d.dy) {
      if (x < 0 || y < 0 || x >= w || y >= h || !open(y * w + x)) break;
      cells.push(y * w + x);
    }
    return cells;
  });
  const lines = [];   // the cells of every path, door first
  const joined = [], failed = [];
  const order = doors.map((_, i) => i).filter(i => leads[i].length);
  for (let i = 0; i < doors.length; i++) if (!leads[i].length) failed.push(i);
  if (!order.length) return { paint, joined, failed };

  // (dist must be as precise as the heap's keys: with 32-bit floats a cell popped with its own, unrounded, key looked
  // "stale" and was dropped, so some doors could not find a path that was plainly there)
  const dist = new Float64Array(N), prev = new Int32Array(N);
  const route = start => {
    dist.fill(Infinity); prev.fill(-1);
    const heap = new Heap();
    dist[start] = 0; heap.push(0, start);
    for (let pops = 0; heap.size; pops++) {
      // A search that cannot find its way (shut in, or a huge area) is cut after the time limit.
      if ((pops & 2047) === 2047 && now() > deadline) { timedOut = true; return null; }
      const [d, i] = heap.pop();
      if (d > dist[i]) continue;
      if (net[i]) {
        const out = [];
        for (let c = i; c !== -1; c = prev[c]) out.push(c);
        return out.reverse();
      }
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of STEPS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!open(j)) continue;
        if (dx && dy && !(open(y * w + nx) && open(ny * w + x))) continue;   // no cutting a corner
        const nd = d + (dx && dy ? 1.4142 : 1) * (net[j] ? 0.3 : base[j]);
        if (nd < dist[j]) { dist[j] = nd; prev[j] = i; heap.push(nd, j); }
      }
    }
    return null;
  };

  // Which pieces of open ground are connected (one pass over the grid): a door shut in a piece of its own can be
  // told at once, instead of by a search over the whole area for a way that does not exist.
  const piece = new Int32Array(N).fill(-1);
  const flood = [];
  let pieces = 0;
  for (const i of order) {
    const s = leads[i][leads[i].length - 1];
    if (piece[s] !== -1) continue;
    piece[s] = pieces; flood.length = 0; flood.push(s);
    for (let q = 0; q < flood.length; q++) {
      const c = flood[q], x = c % w, y = (c - x) / w;
      for (const [dx, dy] of STEPS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (piece[j] !== -1 || !open(j)) continue;
        if (dx && dy && !(open(y * w + nx) && open(ny * w + x))) continue;
        piece[j] = pieces; flood.push(j);
      }
    }
    pieces++;
  }

  // In each piece the first door starts a network; each next door is the nearest one to a door already in it.
  const gap = (a, b) => Math.hypot(doors[a].x - doors[b].x, doors[a].y - doors[b].y);
  for (let p = 0; p < pieces; p++) {
    const mine = order.filter(i => piece[leads[i][leads[i].length - 1]] === p);
    const done = [mine[0]], rest = mine.slice(1);
    for (const c of leads[mine[0]]) net[c] = 1;
    lines.push(leads[mine[0]].slice());
    joined.push(mine[0]);
    while (rest.length) {
      if (timedOut || now() > deadline) { timedOut = true; failed.push(...rest); break; }
      let bi = 0, bd = Infinity;
      rest.forEach((r, ri) => { for (const d of done) { const g = gap(r, d); if (g < bd) { bd = g; bi = ri; } } });
      const di = rest.splice(bi, 1)[0], lead = leads[di];
      const way = route(lead[lead.length - 1]);
      if (!way) { failed.push(di); continue; }   // (after a timeout the loop above gives up on the rest)
      const line = lead.slice(0, -1).concat(way);
      for (const c of line) net[c] = 1;
      lines.push(line); done.push(di); joined.push(di);
    }
    if (timedOut) { for (let q = p + 1; q < pieces; q++) failed.push(...order.filter(i => piece[leads[i][leads[i].length - 1]] === q)); break; }
  }

  // Stamp the paths. The cells found are always painted (so the path never breaks); a smoothed line, thickened by a
  // radius that drifts and a ragged edge, makes the strip.
  const r0 = Math.max(0.5, width / 2);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (kind[i] === PATH_CELL.GROUND) paint[i] = 1;
  };
  const stamp = (px, py, r) => {
    for (let cy = Math.floor(py - r - 1); cy <= Math.ceil(py + r + 1); cy++) for (let cx = Math.floor(px - r - 1); cx <= Math.ceil(px + r + 1); cx++) {
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const d = Math.hypot(cx - px, cy - py);
      if (d <= r || (width > 1 && d <= r + 0.8 && hash2(cx, cy, seed + 7) < 0.3)) put(cx, cy);
    }
  };
  for (const line of lines) {
    for (const c of line) put(c % w, (c / w) | 0);
    if (line.length < 2) { const c = line[0]; stamp(c % w, (c / w) | 0, r0); continue; }
    let pts = line.map(c => [c % w, (c / w) | 0]);
    for (let pass = 0; pass < 4; pass++) {
      pts = pts.map((p, k) => (k === 0 || k === pts.length - 1) ? p : [0.25 * pts[k - 1][0] + 0.5 * p[0] + 0.25 * pts[k + 1][0], 0.25 * pts[k - 1][1] + 0.5 * p[1] + 0.25 * pts[k + 1][1]]);
    }
    let along = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1], len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / 0.5));
      for (let s = 0; s <= n; s++) {
        const t = s / n, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        const r = width > 1 ? r0 * (0.8 + 0.5 * vnoise((along + len * t) * 0.12, 0.5, seed + 31)) : r0;
        stamp(px, py, r);
      }
      along += len;
    }
  }
  return { paint, joined, failed, timedOut };
}
