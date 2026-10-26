// The town guards of the new-world editor: one for every five people of the town, each on a stretch of the village paths.
// Dressed like the guards of Shrouded Hills, Black Root and Ashbury (measured on their .mob files): the "Human Guard" prototype
// (17098) with the guard dialog script (01934Guards.scr), a level and attributes that grow with the town, armor and a weapon
// worn, and a patrol: F_NPC_WAYPOINTS_IDX walked in a loop by day and by night (F_NPC_FLAGS 2 | 4, the flags of most guards).
import * as ME from './mob-edit.js';

export const GUARD_PROTO = 17098, GUARD_AID = 671096832, GUARD_DIALOG = 1934, PEOPLE_PER_GUARD = 5;
const ONF_WAYPOINTS_NIGHT = 4, SAP_DIALOG = 9, F_SKILLS = 221, F_WAYPOINTS = 287, F_NPC_FLAGS = 280, F_CURRENT_AID = 1;
// by the size of the town: armor (item number, the armor part of the NPC's art: 1 villager, 3 chain mail, 4 plate), weapon, and
// the potions in the pack. Shrouded Hills: jacket and a rusty dagger; Black Root: chain mail; Ashbury: plate, potions.
export const GUARD_TIERS = [
  { armor: 8110, part: 1, weapon: 6050, pack: [] },
  { armor: 8112, part: 3, weapon: 6056, pack: [10079] },
  { armor: 8113, part: 4, weapon: 6051, pack: [10079, 10099] }
];
export const guardCount = people => Math.floor(Math.max(0, people) / PEOPLE_PER_GUARD);
export const guardTier = people => (people < 20 ? 0 : people < 60 ? 1 : 2);
// the guards of Shrouded Hills are level 5-14, Ashbury's 22-38: 8 for a hamlet, 38 for a city
export const guardLevel = (people, rand = Math.random) => Math.max(8, Math.min(38, Math.round(8 + people * 0.4 + rand() * 4)));

// Patrol loops over the path tiles `tiles` ([[x, y], ...]), one per guard: a start tile, a far tile of the same paths and the
// way between them in a waypoint every five steps, walked there and back. Starts are spread: each is the farthest of a few
// random tiles from the guards already placed. Returns [[[x, y], ...], ...], the first tile of each the guard's place.
export function planPatrols(tiles, count, rand = Math.random) {
  const key = (x, y) => y * 100003 + x, open = new Map(tiles.map(t => [key(t[0], t[1]), t]));
  const bfs = s => {
    const dist = new Map([[key(s[0], s[1]), 0]]), prev = new Map(), queue = [s];
    for (let h = 0; h < queue.length; h++) {
      const [x, y] = queue[h], d = dist.get(key(x, y));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = key(x + dx, y + dy);
        if ((dx || dy) && open.has(k) && !dist.has(k)) { dist.set(k, d + 1); prev.set(k, key(x, y)); queue.push(open.get(k)); }
      }
    }
    return { dist, prev };
  };
  const starts = [], out = [];
  for (let n = 0; n < count && tiles.length; n++) {
    let s = tiles[0], best = -1;
    for (let t = 0; t < 12; t++) {
      const c = tiles[(rand() * tiles.length) | 0];
      const d = starts.length ? Math.min(...starts.map(o => Math.hypot(o[0] - c[0], o[1] - c[1]))) : 0;
      if (d > best) { best = d; s = c; }
    }
    starts.push(s);
    const { dist, prev } = bfs(s);
    const far = [...dist].filter(([, d]) => d >= 12 && d <= 28);
    const [target] = far.length ? far[(rand() * far.length) | 0] : [...dist].reduce((a, b) => (b[1] > a[1] ? b : a));
    const route = [];
    for (let k = target; k !== undefined; k = prev.get(k)) route.push(open.get(k));
    route.reverse();                                                       // start .. target
    const way = route.filter((_, i) => i % 5 === 0 || i === route.length - 1);
    out.push(way.length > 1 ? way.concat(way.slice(1, -1).reverse()) : way);
  }
  return out;
}

// The .mob bytes of a guard placed as a plain NPC (`bytes`), dressed and given his patrol. `proto`: the decoded prototype
// 17098; `route`: the absolute locations (BigInt) of the waypoints; `items`: [{ objType, num, slot, flags }] with the worn
// slots 1004 (weapon) and 1006 (armor) or a cell of the pack. Returns { bytes, kids }: the inventory items are .mob files too.
export function dressGuard(bytes, { proto, level, aid, route, items }) {
  const mob = ME.mobOpen(bytes), edits = new Map();
  const attr = Math.min(18, 8 + (level >> 2)), per = Math.min(18, 8 + Math.floor(level / 3));
  const stats = ME.statEntries(mob, proto);
  for (const [i, v] of [[ME.STAT.STRENGTH, attr], [ME.STAT.DEXTERITY, attr], [ME.STAT.CONSTITUTION, attr], [ME.STAT.PERCEPTION, per], [ME.STAT.WILLPOWER, attr], [ME.STAT.LEVEL, level]]) stats.set(i, ME.encInt32(v));
  edits.set(ME.F_STAT_BASE, ME.encArray(4, stats));
  // bow, dodge, melee, throwing: 2 at level 8 up to 5 at level 28 (Shrouded Hills 3, Ashbury 5)
  const skills = ME.arrayEntries(ME.effective(mob, proto, F_SKILLS)), rank = Math.min(5, 1 + Math.floor(level / 7));
  for (let i = 0; i < 12; i++) if (!skills.has(i)) skills.set(i, ME.encInt32(0));
  for (let i = 0; i < 4; i++) skills.set(i, ME.encInt32(rank));
  edits.set(F_SKILLS, ME.encArray(4, skills));
  edits.set(F_CURRENT_AID, ME.encInt32(aid));
  for (const [f, v] of ME.editFlag(mob, proto, F_NPC_FLAGS, ONF_WAYPOINTS_NIGHT, true)) edits.set(f, v);
  for (const [f, v] of ME.editScript(mob, proto, SAP_DIALOG, GUARD_DIALOG)) edits.set(f, v);
  edits.set(F_WAYPOINTS, ME.encArray(8, new Map(route.map((loc, i) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt.asIntN(64, loc), true); return [i, b]; }))));
  const loc = BigInt(mob.get(2)), kids = items.map(it => ME.buildInventoryItem({ objType: it.objType, protoNum: it.num, parentOid: mob.dec.objectOid, loc, slot: it.slot, flags: it.flags }));
  for (const [f, v] of ME.editInventory(16, kids.map(k => k.oid))) edits.set(f, v);
  return { bytes: ME.mobRewrite(bytes, edits), kids };
}
