// Structures the game builds from two of the groups of sec-facade-groups.js stamped together: the temple. Temple-01..06 and 10
// (one group) and Temple-07..13 (the other) always stand 20 tiles west and 6 south of each other (read off the temple of Caladon;
// Shrouded Hills' has the vine-covered Temple-vines-01..06 and 10 in the first group's place, at the same offset). The palette lists
// each as one structure, and the New world editor's Temple option stamps one.
import { SEC_FACADE_GROUPS } from './sec-facade-groups.js';
import { SEC_FACADE_LAYOUTS } from './sec-facade-layouts.js';

const JOIN_OFFSET = [-20, 6];
const COMPOSITES = [{ name: 'Temple', main: 119, join: 125 }, { name: 'Temple-vine', main: 132, join: 125 }];

const groupWith = num => SEC_FACADE_GROUPS.find(g => { for (let i = 0; i < g.length; i += 3) if (g[i] === num) return true; return false; });
const positionIn = (g, num) => { for (let i = 0; i < g.length; i += 3) if (g[i] === num) return [g[i + 1], g[i + 2]]; return [0, 0]; };

const used = new Set();
const merged = COMPOSITES.map(c => {
  const a = groupWith(c.main), b = groupWith(c.join), pa = positionIn(a, c.main), pb = positionIn(b, c.join);
  used.add(a); used.add(b);
  const shift = [pa[0] + JOIN_OFFSET[0] - pb[0], pa[1] + JOIN_OFFSET[1] - pb[1]], flat = a.slice();
  for (let i = 0; i < b.length; i += 3) flat.push(b[i], b[i + 1] + shift[0], b[i + 2] + shift[1]);
  flat.name = c.name; flat.rep = c.main;
  return flat;
});

// the groups the palette lists: the generated ones, the two halves of the temples replaced by the whole temples
export const FACADE_GROUPS = SEC_FACADE_GROUPS.filter(g => !used.has(g)).concat(merged);

// Every tile of the game's temples carries these flag bits (and is not walkable: a building).
export const TEMPLE_KEEP = 0x06000000;
// Where a path meets a temple, from the tile of Temple-01's first cell: the tile in front of the arched door (on the face towards +x,
// where the temple's tiles end at dx 5) and the one behind it.
export const TEMPLE_FRONT = { ox: 6, oy: 12, ix: 5, iy: 12 };
// The tiles of a temple, [{ num, frame, dx, dy }], from the tile where Temple-01 (or Temple-vines-01) has its first cell. `vine`: the
// vine-covered one.
export function templeTiles(vine) {
  const g = merged.find(m => m.name === (vine ? 'Temple-vine' : 'Temple')), out = [];
  for (let i = 0; i < g.length; i += 3) {
    const lay = SEC_FACADE_LAYOUTS[g[i]]; if (!lay) continue;
    for (let k = 0; k < lay.cells.length; k += 3) out.push({ num: g[i], frame: lay.cells[k], dx: g[i + 1] + lay.cells[k + 1], dy: g[i + 2] + lay.cells[k + 2] });
  }
  return out;
}
