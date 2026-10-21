// Wave function collapse (the "overlapping model") for the furniture of a house, learned from the houses of the game.
//
// A cell is a tile of the house or of the yard ring around it. Its CONTEXT (walls on its edges, a door / window / hearth
// on them, in the house or not, in a doorway, before a hearth) is given by the plan; what is to be found is its CLASS: nothing
// (EMPTY) or the kind of thing that stands on it ("bed", "table", "seat+table"...). A pattern is the classes of a 3 x 3
// window of cells around one cell, with that cell's context; the patterns are read off the game's own houses
// (HOUSE_SAMPLES + HOUSE_GRIDS), with the number of times each is seen in each house. A cell may take a pattern only when its
// context is the pattern's and the window's cells outside the house + yard are OUT, and neighbouring cells take patterns that
// agree on the cells their windows share. So a bed comes with a wall on its head side, a chair with a table beside it, a lamp
// where lamps stand - all as the game's houses have them - without a rule written for each.
//
//   const model = new WfcModel();                         // add the games' houses: model.addWitness(grid, classAt) ...
//   const out = solveWfc(model, cells, { weights, rng }); // cells: [{ x, y, ctx, fixed }] -> Map "x,y" -> class name, or null

export const EMPTY = 0, OUT = 1;
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const OPP = [7, 6, 5, 4, 3, 2, 1, 0];
const PAIR = [0, 1, 2, 3, 3, 2, 1, 0];                 // the key table a direction and its opposite share

// the window cells (u, v in -1..1) a pattern shares with the one of the neighbour in direction k, in reading order
const REGION = DIRS.map(([dx, dy]) => {
  const out = [];
  for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) if (u - dx >= -1 && u - dx <= 1 && v - dy >= -1 && v - dy <= 1) out.push((v + 1) * 3 + (u + 1));
  return out;
});

export class WfcModel {
  constructor() {
    this.classNames = ['.', '#'];                       // EMPTY, OUT, then the classes
    this.classIds = new Map();
    this.pats = [];                                     // { ctx, sig, cells: Uint8Array(9), out: bits of the OUT cells, reg: Int32Array(8), seen: [[witness, n], ...] }
    this.byKey = new Map();                             // "ctx|sig|cells" -> pattern id
    this.byDom = new Map();                             // domKey(ctx, sig, out) -> [pattern ids]
    this.tables = [new Map(), new Map(), new Map(), new Map()];   // region text -> id, per direction pair
    this.byReg = DIRS.map(() => []);                    // direction -> region id -> [pattern ids whose region (in that direction) it is]
    this.witnesses = 0;
    this.groups = new Map();                            // domKey -> the solver's group of the patterns of such cells (groupOf)
    this.groupCount = 0;
  }
  classId(name) {
    if (name == null) return EMPTY;
    let id = this.classIds.get(name);
    if (id == null) { id = this.classNames.length; this.classNames.push(name); this.classIds.set(name, id); }
    return id;
  }
  // grid: rows (width w) of contexts (null: neither house nor yard); classAt(col, row) -> class name or null
  addWitness(ctxRows, classAt) {
    const wi = this.witnesses++, h = ctxRows.length, w = ctxRows[0].length;
    const ctxAt = (c, r) => (c < 0 || r < 0 || c >= w || r >= h) ? null : ctxRows[r][c];
    const val = (c, r) => ctxAt(c, r) == null ? OUT : this.classId(classAt(c, r));
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (ctxRows[r][c] == null) continue;
      const cells = new Uint8Array(9);
      let sig = 0;
      for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
        const i = (v + 1) * 3 + u + 1;
        cells[i] = val(c + u, r + v);
        sig += neighbourSig(ctxAt(c + u, r + v)) * 8 ** i;
      }
      this.addPattern(ctxRows[r][c], sig, cells, wi);
    }
  }
  addPattern(ctx, sig, cells, wi) {
    const key = `${ctx}|${sig}|${cells.join(',')}`;
    let id = this.byKey.get(key);
    if (id == null) {
      id = this.pats.length;
      let out = 0; cells.forEach((v, i) => { if (v === OUT) out |= 1 << i; });
      const reg = new Int32Array(8);
      for (let k = 0; k < 8; k++) {
        const text = REGION[k].map(i => cells[i]).join(','), t = this.tables[PAIR[k]];
        let rid = t.get(text); if (rid == null) { rid = t.size; t.set(text, rid); }
        reg[k] = rid;
        const lists = this.byReg[k]; (lists[rid] || (lists[rid] = [])).push(id);
      }
      // alone: something in the middle of its window, nothing around it and no wall near - a thing standing in the open
      let lone = cells[4] > OUT && sig === neighbourSig(ctx) * 8 ** 4 && !(ctx & 15);
      for (let i = 0; i < 9 && lone; i++) if (i !== 4 && cells[i] > OUT) lone = false;
      this.pats.push({ ctx, sig, cells, out, reg, lone, seen: [] });
      this.byKey.set(key, id);
      const ck = domKey(ctx, sig, out); if (!this.byDom.has(ck)) this.byDom.set(ck, []); this.byDom.get(ck).push(id);
    }
    if (wi >= 0) { const s = this.pats[id].seen, last = s[s.length - 1]; if (last && last[0] === wi) last[1]++; else s.push([wi, 1]); }
    return id;
  }
  // the pattern that has nothing in its window (the OUT cells aside) for a cell of this context: always there, so a cell can
  // always be left empty
  emptyPattern(ctx, sig, out) {
    const cells = new Uint8Array(9); for (let i = 0; i < 9; i++) if (out >> i & 1) cells[i] = OUT;
    return this.addPattern(ctx, sig, cells, -1);
  }
}

// What a pattern knows of the cells around its own, besides their classes: whether a wall is on their back edges (NE, NW: 1)
// or their front ones (SE, SW: 2), and whether they are in a doorway (4) - so a bed is not taken for one against a wall when
// the wall is two tiles away, nor a table for one that may stand against a front wall (the game's things hardly ever do).
export const neighbourSig = ctx => ctx == null ? 0 : ((ctx & 9) ? 1 : 0) + ((ctx & 6) ? 2 : 0) + ((ctx & 128) ? 4 : 0);
const domKey = (ctx, sig, out) => (ctx * 134217728 + sig) * 512 + out;

// The cells of one kind (context, sig, OUT cells) share their patterns: a group numbers them 0.. in the model's order and
// knows their middles and regions; slot: where a region (per direction) is counted in a cell's table of counts. w, wlw: the
// weights of the run at hand (solveWfc sets them). Kept by the model, made again when the model has learned more such patterns.
function groupOf(model, key) {
  const ids = model.byDom.get(key) || [], L = ids.length;
  let g = model.groups.get(key);
  if (g && g.L === L) return g;
  g = { gi: model.groupCount++, ids, L, mid: new Uint8Array(L), w: new Float64Array(L), wlw: new Float64Array(L), rid: new Int32Array(L * 8), slot: new Int32Array(L * 8),
    slotOf: DIRS.map(() => new Map()), byReg: DIRS.map(() => new Map()), byMid: new Map(), slots: 0, open: false, links: new Map() };
  for (let q = 0; q < L; q++) {
    const pat = model.pats[ids[q]], m = g.byMid.get(pat.cells[4]);
    g.mid[q] = pat.cells[4];
    if (m) m.push(q); else g.byMid.set(pat.cells[4], [q]);
    if (pat.cells[4] !== EMPTY) g.open = true;
    for (let k = 0; k < 8; k++) {
      const r = pat.reg[k];
      let s = g.slotOf[k].get(r); if (s == null) { s = g.slots++; g.slotOf[k].set(r, s); }
      g.rid[q * 8 + k] = r; g.slot[q * 8 + k] = s;
      const l = g.byReg[k].get(r); if (l) l.push(q); else g.byReg[k].set(r, [q]);
    }
  }
  model.groups.set(key, g);
  return g;
}
// A cell of group A and its neighbour of group B in direction k: for each of A's patterns the slot of that region in B's
// counts (-1: none of B's patterns has it), and for each of A's slots B's patterns with that region
const NONE = [];
function linkOf(A, k, B) {
  let l = A.links.get(B.gi * 8 + k);
  if (l) return l;
  const back = B.slotOf[OPP[k]], to = new Int32Array(A.L), lists = new Array(A.slots).fill(NONE);
  for (let q = 0; q < A.L; q++) { const s = back.get(A.rid[q * 8 + k]); to[q] = s == null ? -1 : s; }
  for (const [r, s] of A.slotOf[k]) lists[s] = B.byReg[OPP[k]].get(r) || NONE;
  l = { to, lists };
  A.links.set(B.gi * 8 + k, l);
  return l;
}

// cells: [{ x, y, ctx, fixed }] (fixed: must stay empty). opts: weights (per witness, or null for all 1), emptyWeight (what
// the pattern with nothing in it weighs where the game's houses have none), emptyBias (multiplies the weight of every pattern
// whose middle is empty), rng, tries. Returns { classes: Map "x,y" -> class name (EMPTY ones left out), tries, stats } or null
// when every try ran into a contradiction.
// seeds: class names to put somewhere first (where such a thing is likeliest to stand), each in one cell; suppress: Map class
// name -> factor on the weight of the patterns with that class in the middle (so that class comes from the seeds, mostly);
// loneBias: factor on the patterns of a thing standing alone in the open.
export function solveWfc(model, cells, { weights = null, emptyWeight = .3, emptyBias = 1, seeds = [], suppress = null, loneBias = 1, seedOpen = null, rng = Math.random, tries = 12 } = {}) {
  const n = cells.length, at = new Map(cells.map((c, i) => [`${c.x},${c.y}`, i]));
  const nb = new Int32Array(n * 8), outMask = new Int32Array(n), sigOf = new Array(n);
  cells.forEach((c, i) => {
    let sig = neighbourSig(c.ctx) * 8 ** 4;
    DIRS.forEach(([dx, dy], k) => {
      const j = at.get(`${c.x + dx},${c.y + dy}`), idx = (dy + 1) * 3 + dx + 1;
      nb[i * 8 + k] = j == null ? -1 : j;
      if (j == null) outMask[i] |= 1 << idx; else sig += neighbourSig(cells[j].ctx) * 8 ** idx;
    });
    sigOf[i] = sig;
  });
  // the pattern with nothing in it must be there for every cell (the model learns it, with a small weight if the game never had it)
  const emptyIds = cells.map((c, i) => model.emptyPattern(c.ctx, sigOf[i], outMask[i]));
  const P = model.pats.length;
  const suppressFactor = {};
  if (suppress) for (const [name, f] of suppress) { const id = model.classIds.get(name); if (id != null) suppressFactor[id] = f; }
  const seedIds = seeds.map(name => model.classIds.get(name)).filter(id => id != null);
  // the cells of a room with a wall on them or beside them, and the share of the rooms' cells that are in the open
  const nearWall = new Uint8Array(n);
  cells.forEach((c, i) => { if (c.ctx & 15) nearWall[i] = 1; for (let k = 0; k < 8; k++) { const j = nb[i * 8 + k]; if (j >= 0 && cells[j].ctx & 15) nearWall[i] = 1; } });
  let roomCells = 0, openCells = 0;
  cells.forEach((c, i) => { if (c.room != null) { roomCells++; if (!nearWall[i]) openCells++; } });
  const baseOpen = Math.min(.95, Math.max(.05, roomCells ? openCells / roomCells : .5));
  let stats = null;
  // the cells' groups (kept by the model), with the weights of their patterns for this run - only the patterns these cells
  // may take are weighed
  const grp = cells.map((c, i) => groupOf(model, domKey(c.ctx, sigOf[i], outMask[i])));
  for (const g of new Set(grp)) for (let q = 0; q < g.L; q++) {
    const pat = model.pats[g.ids[q]], seen = pat.seen; let s = 0;
    for (let t = 0; t < seen.length; t++) s += seen[t][1] * (weights ? weights[seen[t][0]] : 1);
    if (!s) s = emptyWeight; else if (pat.cells[4] === EMPTY) s *= emptyBias;
    if (pat.lone) s *= loneBias;
    if (suppress && pat.cells[4] > OUT) s *= suppressFactor[pat.cells[4]] ?? 1;
    g.w[q] = s; g.wlw[q] = s * Math.log(s);
  }
  const link = new Array(n * 8).fill(null);
  for (let i = 0; i < n; i++) for (let k = 0; k < 8; k++) { const j = nb[i * 8 + k]; if (j >= 0) link[i * 8 + k] = linkOf(grp[i], k, grp[j]); }
  // the domains (the same for every try) and the state they start each try with, in flat typed arrays
  const dom = new Array(n), aOff = new Int32Array(n), cOff = new Int32Array(n);
  let aTot = 0, cTot = 0, domTot = 0;
  for (let i = 0; i < n; i++) {
    const c = cells[i], g = grp[i], list = [];
    for (let q = 0; q < g.L; q++) if ((!c.fixed || g.mid[q] === EMPTY) && !(c.ban && c.ban.has(g.mid[q]))) list.push(q);
    dom[i] = list.length ? list : [g.ids.indexOf(emptyIds[i])];
    aOff[i] = aTot; aTot += g.L; cOff[i] = cTot; cTot += g.slots; domTot += dom[i].length;
  }
  const alive0 = new Uint8Array(aTot), cnt0 = new Uint16Array(cTot), size0 = new Int32Array(n), sumW0 = new Float64Array(n), sumWL0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = grp[i], a = aOff[i], co = cOff[i];
    for (const p of dom[i]) {
      alive0[a + p] = 1; size0[i]++; sumW0[i] += g.w[p]; sumWL0[i] += g.wlw[p];
      for (let k = 0; k < 8; k++) cnt0[co + g.slot[p * 8 + k]]++;
    }
  }
  const alive = new Uint8Array(aTot), cnt = new Uint16Array(cTot), size = new Int32Array(n), sumW = new Float64Array(n), sumWL = new Float64Array(n);
  const stack = new Int32Array(2 * domTot), H = new Float64Array(n), dirty = new Uint8Array(n);

  for (let attempt = 1; attempt <= tries; attempt++) {
    alive.set(alive0); cnt.set(cnt0); size.set(size0); sumW.set(sumW0); sumWL.set(sumWL0); dirty.fill(1);
    let sp = 0, broken = false;
    const remove = (i, p) => {
      const g = grp[i];
      alive[aOff[i] + p] = 0; size[i]--; sumW[i] -= g.w[p]; sumWL[i] -= g.wlw[p]; dirty[i] = 1;
      if (size[i] === 0) broken = true;
      stack[sp++] = i; stack[sp++] = p;
    };
    const propagate = () => {
      while (sp > 0 && !broken) {
        const p = stack[--sp], i = stack[--sp], slot = grp[i].slot, co = cOff[i];
        for (let k = 0; k < 8; k++) {
          const s = slot[p * 8 + k];
          if (--cnt[co + s] > 0) continue;
          const j = nb[i * 8 + k];
          if (j < 0) continue;
          // the neighbour's patterns that needed what is gone
          const list = link[i * 8 + k].lists[s], a = aOff[j];
          for (let t = 0; t < list.length; t++) { const q = list[t]; if (alive[a + q]) { remove(j, q); if (broken) return; } }
        }
      }
    };
    // arc consistency to begin with
    for (let j = 0; j < n && !broken; j++) {
      const a = aOff[j];
      for (const q of dom[j]) {
        if (!alive[a + q]) continue;
        for (let k = 0; k < 8; k++) {
          const i = nb[j * 8 + k];
          if (i < 0) continue;
          const s = link[j * 8 + k].to[q];
          if (s < 0 || cnt[cOff[i] + s] === 0) { remove(j, q); break; }
        }
        if (broken) break;
      }
      propagate();
    }
    const decided = new Uint8Array(n);
    let steps = 0;
    // the seeds: each in a cell drawn by how likely its class is there - in a room (cell.room) that has none yet, rather; one
    // that makes a contradiction is given up
    const seeded = new Set();
    for (let s = 0; s < seedIds.length && !broken; s++) {
      const id = seedIds[s], chance = new Float64Array(n);
      let tot = 0;
      for (let i = 0; i < n; i++) {
        if (decided[i] || size[i] < 2) continue;
        const g = grp[i], a = aOff[i], ps = g.byMid.get(id) || NONE;
        let c = 0; for (let t = 0; t < ps.length; t++) if (alive[a + ps[t]]) c += g.w[ps[t]];
        // (the share of its weight, as it would be unsuppressed: how likely it is on such a cell - so the cells of a kind get it
        // as often as the game's do. Weighing by its weight too favours the open floor, whose windows are all alike while
        // those along a wall split among many: the game's tables stood in the open half the time, seeded ones 4 in 5.)
        const f = suppressFactor[id] ?? 1, raw = c / f;
        // (and in the open or at a wall as often as the game's houses of its kind have that thing)
        chance[i] = raw / (sumW[i] - c + raw) * (cells[i].room != null && seeded.has(cells[i].room) ? .15 : 1);
      }
      // (the window patterns favour the open floor whatever the kind: the cells at a wall are scaled so that the open and the
      // walled get the chances the game's houses of the kind give that thing)
      const want = seedOpen?.get(model.classNames[id]);
      if (want != null) {
        let so = 0, sw = 0;
        for (let i = 0; i < n; i++) if (cells[i].room != null) { if (nearWall[i]) sw += chance[i]; else so += chance[i]; }
        if (so > 0 && sw > 0) { const f = so * (1 - want) / Math.max(.02, want) / sw; for (let i = 0; i < n; i++) if (cells[i].room != null && nearWall[i]) chance[i] *= f; }
      }
      for (let i = 0; i < n; i++) tot += chance[i];
      if (!(tot > 0)) continue;
      let r = rng() * tot, at0 = 0;
      for (let i = 0; i < n; i++) { r -= chance[i]; if (r <= 0 && chance[i] > 0) { at0 = i; break; } }
      for (const p of dom[at0]) if (alive[aOff[at0] + p] && grp[at0].mid[p] !== id) { remove(at0, p); if (broken) break; }
      decided[at0] = 1;
      if (cells[at0].room != null) seeded.add(cells[at0].room);
      propagate();
      if (broken) { seedIds.splice(s, 1); break; }
    }
    while (!broken) {
      // the undecided cell with the fewest possibilities (entropy of its patterns, with a little noise)
      let best = -1, bestH = Infinity;
      for (let i = 0; i < n; i++) {
        if (decided[i]) continue;
        // (the entropy is kept until the cell loses a pattern; the noise is drawn each time)
        let e = -1;
        if (size[i] > 1) { if (dirty[i]) { H[i] = Math.log(sumW[i]) - sumWL[i] / sumW[i]; dirty[i] = 0; } e = H[i] + rng() * 1e-3; }
        if (e < bestH) { bestH = e; best = i; }
      }
      if (best < 0) break;
      const i = best, g = grp[i], a = aOff[i];
      // what its middle may be, with weights
      const byMid = new Map();
      for (const p of dom[i]) if (alive[a + p]) { const m = g.mid[p]; byMid.set(m, (byMid.get(m) || 0) + g.w[p]); }
      if (byMid.size <= 1) { decided[i] = 1; continue; }
      let t = 0; for (const v of byMid.values()) t += v;
      let r = rng() * t, pick = null;
      for (const [m, v] of byMid) { pick = m; r -= v; if (r <= 0) break; }
      for (const p of dom[i]) if (alive[a + p] && g.mid[p] !== pick) { remove(i, p); if (broken) break; }
      decided[i] = 1;
      propagate();
      steps++;
    }
    if (broken) { stats = { attempt, steps, broken: true }; continue; }
    const classes = new Map();
    let objects = 0;
    for (let i = 0; i < n; i++) {
      const p = dom[i].find(q => alive[aOff[i] + q]), m = grp[i].mid[p];
      if (m !== EMPTY) { classes.set(`${cells[i].x},${cells[i].y}`, model.classNames[m]); objects++; }
    }
    // (how many cells had a pattern the game's houses have with something in the middle)
    let open = 0;
    for (let i = 0; i < n; i++) if (grp[i].open) open++;
    return { classes, tries: attempt, stats: { steps, objects, patterns: P, open } };
  }
  return null;
}
