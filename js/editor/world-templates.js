// Map templates for the new-world page: each one paints the corner points of a world (see world-editor-dialog.js) from
// smooth random noise, so every click gives a different map of the same kind. A template gets the noise samplers and
// returns a terrain name for each point; unknown names fall back to green grasslands.

// Small seeded generator (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Value noise in [0, 1): `scale` is how many sectors one blob spans; `octaves` adds finer detail.
function noiseField(rand, scale, octaves = 3) {
  const lattice = new Map(), at = (i, j, o) => { const k = `${o},${i},${j}`; let v = lattice.get(k); if (v === undefined) lattice.set(k, v = rand()); return v; };
  const smooth = t => t * t * (3 - 2 * t);
  return (x, y) => {
    let sum = 0, amp = 1, norm = 0, f = 1 / scale;
    for (let o = 0; o < octaves; o++, f *= 2, amp /= 2) {
      const gx = x * f, gy = y * f, i = Math.floor(gx), j = Math.floor(gy), tx = smooth(gx - i), ty = smooth(gy - j);
      const a = at(i, j, o) + (at(i + 1, j, o) - at(i, j, o)) * tx, b = at(i, j + 1, o) + (at(i + 1, j + 1, o) - at(i, j + 1, o)) * tx;
      sum += (a + (b - a) * ty) * amp; norm += amp;
    }
    return sum / norm;
  };
}

// u, v: 0..1 across the map. e: elevation noise, m: a second noise (moisture / patches), d: 0 at the centre .. 1 at the edge.
const TEMPLATES = [
  { name: 'Island', hint: 'One island with beaches of grass, forests and a mountain core',
    scale: 0.28, at: ({ e, m, d }) => {
      const h = e * 0.45 + (1 - d) * 0.8;
      if (h < 0.55 || d > 0.8) return 'water';
      if (h > 0.97) return 'mountains';
      return m > 0.58 ? 'forest' : 'green grasslands';
    } },
  { name: 'Continental', hint: 'A big landmass with ragged coasts, forests, mountains and a desert',
    scale: 0.35, at: ({ e, m, d, v }) => {
      const h = e * 0.9 + (1 - d * d) * 0.45;
      if (h < 0.55) return 'water';
      if (h > 0.98) return 'mountains';
      if (m < 0.3 && v > 0.5) return 'desert';
      return m > 0.6 ? 'forest' : m < 0.4 ? 'plains' : 'green grasslands';
    } },
  { name: 'Archipelago', hint: 'Many small islands in the sea',
    scale: 0.14, at: ({ e, m }) => e > 0.56 ? (m > 0.62 ? 'forest' : 'green grasslands') : 'water' },
  { name: 'Mountains', hint: 'Ranges and foothills, snow on the highest peaks',
    scale: 0.22, at: ({ e, m }) => e > 0.64 ? 'snowy mountains' : e > 0.5 ? 'mountains' : e > 0.4 ? (m > 0.5 ? 'forest' : 'plains') : 'green grasslands' },
  { name: 'Lakes', hint: 'Grassland with lakes, swamps on their shores',
    scale: 0.18, at: ({ e, m }) => e < 0.34 ? 'water' : e < 0.4 ? 'swamps' : m > 0.64 ? 'forest' : 'green grasslands' },
  { name: 'Desert', hint: 'Dunes and dry mountains, grassland at the edges',
    scale: 0.25, at: ({ e }) => e > 0.7 ? 'desert mountains' : e > 0.64 ? 'plains' : e > 0.4 ? 'desert' : e > 0.3 ? 'plains' : 'green grasslands' },
  { name: 'Frozen north', hint: 'Snowy plains and mountains, with some forest',
    scale: 0.25, at: ({ e, m }) => e > 0.62 ? 'snowy mountains' : e < 0.32 && m > 0.5 ? 'forest' : 'snowy plains' },
  { name: 'Jungle', hint: 'Tropical jungle with a sandy shore, mountains inland',
    scale: 0.2, at: ({ e, d }) => e < 0.3 ? 'water' : e < 0.36 ? 'desert island' : e > 0.7 - (1 - d) * 0.05 ? 'tropical mountains' : 'tropical jungle' },
];

export const worldTemplates = TEMPLATES.map(({ name, hint }) => ({ name, hint }));

// The points ((width + 1) x (height + 1) terrain ids) for template `name`. `types` is the planner's terrain list.
export function generateTemplate(name, width, height, planner) {
  const types = planner.types;
  const t = TEMPLATES.find(x => x.name === name), seed = (Math.random() * 2 ** 32) >>> 0, rand = rng(seed);
  const id = n => (types.find(x => x.name === n && x.hasTemplates) || types[0]).id;
  const e = noiseField(rand, t.scale * Math.max(width, height), 4), m = noiseField(rand, t.scale * 0.8 * Math.max(width, height), 3);
  const ids = {}, pick = n => ids[n] ?? (ids[n] = id(n));
  const out = new Uint8Array((width + 1) * (height + 1));
  // Noise is flat around 0.5, so stretch it to use the whole range the thresholds expect.
  const stretch = x => Math.min(1, Math.max(0, (x - 0.5) * 1.9 + 0.5));
  for (let y = 0; y <= height; y++) for (let x = 0; x <= width; x++) {
    const u = x / width, v = y / height, d = Math.min(1, Math.hypot((u - 0.5) * 2, (v - 0.5) * 2) / 1.15);
    out[y * (width + 1) + x] = pick(t.at({ e: stretch(e(x, y)), m: stretch(m(x + 1000, y + 1000)), d, u, v }));
  }
  separateHardPairs(out, width + 1, height + 1, types, planner);
  return out;
}

// The game has no transition sectors between some pairs of terrains (mountains and plains, say). Where two such terrains
// touch, the point is turned into a terrain that goes with both (grassland first) or, failing that, into the other one.
function separateHardPairs(pts, vw, vh, types, planner) {
  const n = types.length, ok = new Map();
  const goes = (a, b) => {
    if (a === b) return true;
    const k = a * n + b;
    if (!ok.has(k)) {   // as a straight border and as a diagonal one
      const p = new Uint8Array(25), q = new Uint8Array(25);
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) { p[y * 5 + x] = x < 2 ? a : b; q[y * 5 + x] = x + y < 4 ? a : b; }
      ok.set(k, !planner.plan(4, 4, p).hard && !planner.plan(4, 4, q).hard);
    }
    return ok.get(k);
  };
  const usable = types.filter(t => t.hasTemplates).map(t => t.id), grass = types.find(t => t.name === 'green grasslands')?.id;
  const around = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
      const a = pts[y * vw + x], bad = [];
      for (const [dx, dy] of around) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= vw || Y >= vh) continue;
        const b = pts[Y * vw + X];
        if (!goes(a, b) || !goes(b, a)) bad.push(b);
      }
      if (!bad.length) continue;
      const mid = [grass, ...usable].find(c => bad.every(b => goes(c, b) && goes(b, c)) && goes(c, a) && goes(a, c));
      pts[y * vw + x] = mid ?? bad[0];
      changed = true;
    }
    if (!changed) break;
  }
}
