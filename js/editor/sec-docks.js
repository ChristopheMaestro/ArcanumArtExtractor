// The docks of a new world's town, as in Ashbury, Dernholm and Tarant: wooden piers of Dks tiles out into the sea, a ship moored
// along a pier for every boat (two boats to a pier at most, then there is another pier) and a small dock beside each ship.
// Positions are tiles. A pier runs south (towards larger y) with its ships on the west side, or east with its ships on the north side,
// because the ship facades only face one way: the first ship is Ashbury's (Ship1Bow, Ship1Masts, Ship1Stern and SRamp1, its gangway,
// 648 tiles from tiles x 32207-32246, y 62509-62547), the second is Tarant's (sec-ship-horizontal.js).
import { SHIP_H_TILES } from './sec-ship-horizontal.js';

export const PIER_W = 7;
export const DKS = 0x820100;                  // the wooden planks; + 0x200 * k, k 0-7, are the eight variants
export const DEEP_WATER = [9, 10, 11, 12];    // tilename.mes ids of the water tiles a pier and a ship can float on

// the ship's tiles around its anchor, the first tile of its gangway, which touches the pier 7 tiles to the east:
// [dy, dx, [raw tile values of the run]]
export const SHIP_TILES = [[-21,-25,[3057289216,3057289218]],[-20,-25,[3057289222,3057289224,3057289226,3057289228,3057289230]],[-20,-11,[3057420288,3057420290,3057420292,3057420294,3057420296]],[-19,-26,[3057289220,3057289242,3057289240,3057289238,3057289236,3057289234,3057289232]],[-19,-11,[3057420308,3057420306,3057420304,3057420302,3057420300,3057420298]],[-18,-23,[3057289248,3057289246,3057289244]],[-18,-12,[3057420324,3057420322,3057420320,3057420318,3057420316,3057420314,3057420312,3057420310]],[-17,-23,[3057289250,3057289252,3057289254,3057289256]],[-17,-16,[3057420350,3057420348,3057420346,3057420344,3057420342,3057420340,3057420338,3057420336,3057420334,3057420332,3057420330,3057420328,3057420326]],[-16,-22,[3057289264,3057289262,3057289260,3057289258]],[-16,-16,[3057420352,3057420354,3057420356,3057420358,3057420360,3057420362,3057420379,3057420377,3057420375,3057420373,3057420371,3057420364,3057420366,3057420368]],[-15,-20,[3057289266,3057289268,3057289270]],[-15,-16,[3057420408,3057420406,3057420404,3057420402,3057420400,3057420398,3057420397,3057420395,3057420393,3057420391,3057420389,3057420386,3057420384,3057420382,3057420380]],[-14,-19,[3057289272,3057289274,3057289276,3057289278,3057289280,3057420410,3057420412,3057420414,3057420416,3057420419,3057420421,3057420423,3057420425,3057420427,3057420428,3057420430,3057420432,3057420434,3057420436]],[-13,-18,[3057289290,3057289288,3057289286,3057289284,3057289282,3057420462,3057420460,3057420458,3057420457,3057420455,3057420453,3057420451,3057420449,3057420446,3057420444,3057420442,3057420440,3057420438]],[-12,-25,[3057289562,3057289564]],[-12,-20,[3057289292,3057289294,3057289296,3057289298,3057289300,3057289302,3057289304,3057289306,3057420464,3057420466,3057420469,3057420471,3057420473,3057420475,3057420477,3057420479,3057420480,3057420482,3057420484,3057420486,3057420488]],[-11,-25,[3057289560,3057289558,3057289556]],[-11,-18,[3057289320,3057289318,3057289316,3057289314,3057289312,3057289310,3057289308,3057420514,3057420513,3057420511,3057420509,3057420507,3057420505,3057420503,3057420500,3057420498,3057420496,3057420494,3057420492,3057420490]],[-10,-24,[3057289548,3057289550,3057289552,3057289554]],[-10,-16,[3057289322,3057289324,3057289326,3057289328,3057289330,3057289332,3057420517,3057420519,3057420521,3057420523,3057420525,3057420527,3057420529,3057420530,3057420532,3057420534,3057420536,3057420538,3057420540]],[-9,-24,[3057289546,3057289544,3057289542,3057289540,3057289538,3057289536]],[-9,-14,[3057289348,3057289346,3057289344,3057289342,3057289335,3057420565,3057420562,3057420560,3057420558,3057420557,3057420555,3057420552,3057420550,3057420548,3057420546,3057420544,3057420542]],[-8,-24,[3057289524,3057289526,3057289528,3057289530,3057289532,3057289534]],[-8,-13,[3057289356,3057289354,3057289352,3057289350,3057289337,3057420567,3057420568,3057420570,3057420573,3057420575,3057420577,3057420578,3057420580,3057420582,3057420584,3057420586]],[-7,-22,[3057289522,3057289520,3057289518,3057289516,3057289514]],[-7,-12,[3057289358,3057289360,3057289362,3057289339,3057420609,3057420606,3057420604,3057420602,3057420601,3057420599,3057420596,3057420594,3057420592,3057420590,3057420588]],[-6,-20,[3057289512,3057289510,3057289508,3057289506]],[-6,-13,[3057289370,3057289368,3057289366,3057289364,3057289341,3057420611,3057420613,3057420614,3057420616,3057420619,3057420621,3057420623,3057420624,3057420626,3057420628,3057420630,3057420632]],[-5,-19,[3057289504,3057289502,3057289500,3057289498]],[-5,-12,[3057289372,3057289374,3057289376,3057289378,3057420657,3057420655,3057420652,3057420650,3057420648,3057420647,3057420645,3057420642,3057420640,3057420638,3057420636,3057420634]],[-4,-18,[3057289488,3057289490,3057289492,3057289494,3057289496]],[-4,-11,[3057289384,3057289382,3057289380,3057420659,3057420661,3057420663,3057420665,3057420667,3057420669,3057420671,3057420673,3057420674,3057420676,3057420678,3057420680]],[-3,-18,[3057289486,3057289484,3057289482,3057289480,3057289478,3057289476]],[-3,-10,[3057289388,3057289386,3057420705,3057420703,3057420701,3057420699,3057420697,3057420695,3057420693,3057420691,3057420688,3057420686,3057420684,3057420682]],[-2,-20,[3057289412,3057289410,3057289408,3057289406,3057289404,3057289402,3057289400,3057289398,3057289396,3057289394,3057289392,3057289390,3057420707,3057420709,3057420711,3057420713,3057420715,3057420717,3057420719,3057420721,3057420722,3057420724,3057420726,3057420728,3057420730]],[-1,-18,[3057289432,3057289430,3057289428,3057289426,3057289424,3057289422,3057289420,3057289418,3057289416,3057289414,3057420756,3057420755,3057420753,3057420751,3057420749,3057420747,3057420745,3057420743,3057420741,3057420738,3057420736,3057420734,3057420732]],[0,-14,[3057289444,3057289442,3057289440,3057289438,3057289436,3057289434,3057420758,3057420760,3057420762,3057420765,3057420767,3057420769,3057420771,3057420773,3061352449,3061352462,3061352464,3061352466,3061352468,3061352470,3061352472]],[1,-13,[3057289446,3057289448,3057289450,3057289452,3057289454,3057420808,3057420806,3057420804,3057420803,3057420801,3057420799,3057420797,3057420795,3061352451,3061352457,3061352459,3061352461,3061352481,3061352479,3061352474,3061352477]],[2,-12,[3057289462,3057289460,3057289458,3057289456,3057420810,3057420812,3057420814,3057420817,3057420819,3057420821,3057420823,3057420825,3061352453,3061352493,3061352491,3061352489,3061352487,3061352485,3061352483]],[3,-11,[3057289464,3057289466,3057289468,3057158144,3057158146,3057158148,3057158150,3057158191,3057158189,3057158187,3057158185,3061352455,3061352526,3061352528,3061352535,3061352533,3061352531,3061352495]],[4,-10,[3057289472,3057289470,3057158152,3057158154,3057158156,3057158158,3057158160,3057158162,3057158164,3057158193,3057158195,3061352518,3061352520,3061352522,3061352524,3061352502,3061352500,3061352497]],[5,-10,[3057158250,3057289474,3057158244,3057158238,3057158236,3057158232,3057158230,3057158226,3057158224,3057158174,3057158172,3057158170,3061352512,3061352514,3061352516,3061352504,3061352499]],[6,-10,[3057158252,3057158248,3057158246,3057158242,3057158240,3057158234,3057158228,3057158222,3057158220,3057158218,3057158216,3057158214,3057158212,3061352510,3061352508,3061352506]],[7,-10,[3057158254,3057158256,3057158258,3057158260,3057158262,3057158264,3057158266,3057158268,3057158270,3057158272,3057158276,3057158274,3057158278,3057158280,3057158282]],[8,-10,[3057158312,3057158310,3057158308,3057158306,3057158304,3057158302,3057158300,3057158298,3057158296,3057158294,3057158292,3057158290,3057158288,3057158286,3057158284]],[9,-9,[3057158314,3057158316,3057158318,3057158320,3057158322,3057158324,3057158326,3057158328,3057158330,3057158332,3057158334,3057158336,3057158338,3057158340]],[10,-9,[3057158368,3057158366,3057158364,3057158362,3057158360,3057158358,3057158356,3057158354,3057158352,3057158350,3057158348,3057158346,3057158344,3057158342]],[11,-8,[3057158370,3057158372,3057158374,3057158376,3057158378,3057158380,3057158382,3057158384,3057158386,3057158388,3057158390,3057158392,3057158394]],[12,-9,[3057158422,3057158420,3057158418,3057158416,3057158414,3057158412,3057158410,3057158408,3057158406,3057158404,3057158402,3057158400,3057158398,3057158396]],[13,-9,[3057158424,3057158426,3057158428,3057158430,3057158438,3057158442,3057158440,3057158444,3057158446,3057158448,3057158450,3057158452,3057158454,3057158456]],[14,-7,[3057158432,3057158434,3057158436,3057158472,3057158470,3057158468,3057158466,3057158464,3057158462,3057158460,3057158458]],[15,-5,[3057158474,3057158476,3057158478,3057158480,3057158482,3057158484,3057158486,3057158488,3057158490]],[16,-2,[3057158502,3057158500,3057158498,3057158496,3057158494,3057158492]],[17,-1,[3057158504,3057158506,3057158508,3057158510]]];
export { SHIP_H_TILES };

// How each kind of pier lies. `along` is the way the pier runs (y for 'v', x for 'h'), `across` the other one, and the pier is
// PIER_W tiles wide across from c0. A ship has its anchor `at` across from c0 and reaches lo / hi across it and before / after
// it along the pier; the first anchor is `first` along from the first water tile, then every `step`.
export const ORIENT = {
  v: { tiles: SHIP_TILES, at: -7, lo: 26, hi: 7, before: 21, after: 17, first: 22, step: 34 },
  h: { tiles: SHIP_H_TILES, at: 0, lo: 32, hi: 1, before: 21, after: 17, first: 24, step: 44 }
};

// [dx, dy] from the pier's north-west corner of the barrels on the shore end (MetalBarrel, scenery art 7011)
export const PIER_BARRELS = [[0, 0], [1, 0], [6, 1]];
export const BARREL_AID = 0x405801C0;

const SHORE = 3;     // rows of the pier on the land before the first water row
const TAIL = 10;     // the pier past the last anchor
const NO_BOAT_LEN = 14;
export const PIER_BOATS = 2;                 // ships to a pier
export const MAX_BOATS = 6;

// The quay on the land at the water's edge, as in Tarant: Prh paving (0x410100 + 0x200 * k) QUAY_DEEP tiles deep, ending QUAY_GAP
// tiles before the first water row (the beach stays), and as wide as the open shore lets it be (QUAY_REACH cells of 4 tiles
// beyond each side of the pier at most). The small empty piers (Dks, JETTY_W wide, JETTY_LEN into the water) leave it on the
// free side of the main pier.
export const PRH = 0x410100;
const QUAY_DEEP = 8, QUAY_GAP = 3, QUAY_REACH = 6;
const JETTY_W = 3, JETTY_LEN = 12;

// What stands on the quay: [scenery.mes number, weight, kind]: 'edge' ones go on the water side, 'any' anywhere. Names as in
// Tarant's and Ashbury's docks.
export const QUAY_PROPS = [
  [14001, 3, 'any'], [14002, 3, 'any'], [14000, 1, 'any'], [14003, 1, 'any'], [14004, 1, 'any'], [14008, 2, 'any'], [14009, 1, 'any'], [14010, 2, 'any'],
  [13038, 2, 'any'], [13034, 1, 'any'], [9006, 1, 'any'], [9008, 1, 'any'], [9009, 1, 'any'], [9011, 1, 'any'], [13021, 2, 'any'], [7011, 2, 'any'],
  [14049, 1, 'any'], [16005, 1, 'any'], [17000, 1, 'edge'], [17001, 1, 'edge']
];
// The art id of a scenery.mes number: the thousands in bits 6-10, the rest from bit 19, scenery type 4 on top.
export const sceneryAid = n => (0x40000000 | ((n % 1000) << 19) | (Math.floor(n / 1000) << 6)) | 0;

const xy = (o, along, across) => o === 'v' ? { x: across, y: along } : { x: along, y: across };
const rect = (o, a0, a1, c0, c1) => o === 'v' ? { x0: c0, y0: a0, x1: c1, y1: a1 } : { x0: a0, y0: c0, x1: a1, y1: c1 };
const joined = (p, q) => ({ x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) });

// Everything of a pier of orientation `o` ('v' or 'h') for `boats` ships, from its first across tile (c0) and its first water tile along (w0).
export function dockShape(o, c0, w0, boats) {
  const k = ORIENT[o], top = w0 - SHORE, last = k.first + k.step * (boats - 1);
  const end = w0 + (boats ? last + TAIL : NO_BOAT_LEN);
  const pier = rect(o, top, end, c0, c0 + PIER_W - 1), wet = rect(o, w0, end, c0, c0 + PIER_W - 1);
  const anchors = [], ships = [], jetties = [];
  for (let i = 0; i < boats; i++) {
    const a = w0 + k.first + k.step * i;
    anchors.push(xy(o, a, c0 + k.at));
    ships.push(rect(o, a - k.before, a + k.after, c0 + k.at - k.lo, c0 + k.at + k.hi));
  }
  const box = ships.reduce(joined, pier);
  const at = xy(o, top, c0 + PIER_W / 2 | 0);
  return {
    orient: o, boats, c0, w0, top, end, pier, wet, anchors, ships, jetties, box, at, quay: null,
    barrels: PIER_BARRELS.map(([dx, dy]) => xy(o, top + dy, c0 + dx)),
    link: (() => { const out = xy(o, top - 1, c0 + 3), inn = xy(o, top, c0 + 3); return { ox: out.x, oy: out.y, ix: inn.x, iy: inn.y }; })()   // the tile on the land in front of the pier and the pier tile behind it
  };
}

// Docks for `boats` ships (two to a pier, more piers for more), the first on the stretch of shore nearest `near` ({ x, y }, tiles),
// the next ones along the same shore. `cell(cx, cy)` says what the 4 x 4 tiles at that cell are: 1 deep water, 2 open ground (a beach,
// grass), 0 anything else. When the sea is too small it places fewer ships; null when not even a pier fits.
// Returns { piers: [dockShape + { boats }], boats, at }.
export function planDocks({ rand, mapW, mapH, boats, cell, near }) {
  const cw = mapW >> 2, ch = mapH >> 2, cands = [];
  for (let cy = 1; cy < ch - 3; cy++) for (let cx = 1; cx < cw - 5; cx++) {
    const w = cell(cx, cy) === 1;
    if (!w) continue;
    // a shore facing south: the pier runs south from it; a shore facing west: the pier runs east
    if (cx >= 9 && cell(cx + 1, cy) === 1 && cell(cx, cy - 1) === 2 && cell(cx + 1, cy - 1) === 2) cands.push({ o: 'v', c0: cx * 4, w0: cy * 4, j: 0.85 + 0.3 * rand() });
    if (cy >= 9 && cell(cx, cy + 1) === 1 && cell(cx - 1, cy) === 2 && cell(cx - 1, cy + 1) === 2) cands.push({ o: 'h', c0: cy * 4, w0: cx * 4, j: 0.85 + 0.3 * rand() });
  }
  const cellsOn = (r, test) => { for (let cy = r.y0 >> 2; cy <= r.y1 >> 2; cy++) for (let cx = r.x0 >> 2; cx <= r.x1 >> 2; cx++) if (!test(cell(cx, cy))) return false; return true; };
  // the quay along the shore in front of the pier and the small empty piers off it (when the shore has the room), and the tile
  // on the land just before the quay that the path from the village ends at
  const landCell = (o, a, c) => o === 'v' ? cell(c, a) : cell(a, c);
  const addQuay = s => {
    const o = s.orient, wa = s.w0 >> 2, pc = s.c0 >> 2;
    const shore = ci => landCell(o, wa, ci) === 1 && [1, 2, 3].every(d => landCell(o, wa - d, ci) === 2);   // open ground three cells deep with the sea at its end
    if (!shore(pc) || !shore(pc + 1)) {
      const out = xy(o, s.top - 1, s.c0 + 3), inn = xy(o, s.top, s.c0 + 3);
      s.link = { ox: out.x, oy: out.y, ix: inn.x, iy: inn.y };
      return;
    }
    let nl = 0, nr = 0;
    const ground = ci => [1, 2, 3].every(d => landCell(o, wa - d, ci) === 2);   // the shore may bend a little: the quay only needs the ground
    while (nl < QUAY_REACH && ground(pc - nl - 1)) nl++;
    while (nr < QUAY_REACH && ground(pc + 2 + nr)) nr++;
    const a0 = s.w0 - QUAY_GAP - QUAY_DEEP, a1 = s.w0 - QUAY_GAP - 1;
    s.quay = rect(o, a0, a1, s.c0 - 4 * nl, s.c0 + 7 + 4 * nr);
    const out = xy(o, a0 - 1, s.c0 + 3), inn = xy(o, a0, s.c0 + 3);
    s.link = { ox: out.x, oy: out.y, ix: inn.x, iy: inn.y };
    // empty piers: on the side without ships, 10+ tiles from the main pier; both sides when there are no ships
    const cs = [];
    if (nr >= 4) cs.push(s.c0 + 7 + 4 * nr - 6);
    if (!s.boats && nl >= 4) cs.push(s.c0 - 4 * nl + 4);
    for (const c of cs) {
      if (!cellsOn(rect(o, s.w0, s.w0 + JETTY_LEN - 1, c, c + JETTY_W - 1), v => v === 1)) continue;
      s.jetties.push(rect(o, s.w0 - QUAY_GAP, s.w0 + JETTY_LEN - 1, c, c + JETTY_W - 1));
    }
    s.box = [s.quay, ...s.jetties].reduce(joined, s.box);
  };
  const apart = (p, q) => p.x1 + 6 < q.x0 || q.x1 + 6 < p.x0 || p.y1 + 6 < q.y0 || q.y1 + 6 < p.y0;
  const place = (n, from, taken) => {
    const sorted = cands.map(c => ({ c, d: Math.hypot((c.o === 'v' ? c.c0 : c.w0) - from.x, (c.o === 'v' ? c.w0 : c.c0) - from.y) * c.j })).sort((p, q) => p.d - q.d);
    for (const { c } of sorted.slice(0, 400)) {
      const s = dockShape(c.o, c.c0, c.w0, n), b = s.box;
      if (b.x0 < 2 || b.y0 < 2 || b.x1 >= mapW - 4 || b.y1 >= mapH - 4 || !taken.every(t => apart(b, t.box))) continue;
      if (!cellsOn(s.wet, v => v === 1)) continue;   // the pier itself is all on water
      let water = 0, total = 0;     // the ships: most of their box is water (they may overlap a little shore)
      for (const r of s.ships) for (let cy = r.y0 >> 2; cy <= r.y1 >> 2; cy++) for (let cx = r.x0 >> 2; cx <= r.x1 >> 2; cx++) { total++; if (cell(cx, cy) === 1) water++; }
      if (total && water < total * 0.9) continue;
      addQuay(s);
      const b2 = s.box;
      if (b2.x0 < 2 || b2.y0 < 2 || b2.x1 >= mapW - 4 || b2.y1 >= mapH - 4 || !taken.every(t => apart(b2, t.box))) continue;
      return s;
    }
    return null;
  };
  const piers = [];
  let left = Math.min(Math.max(boats | 0, 0), MAX_BOATS), from = near;
  do {
    let s = null;
    for (let n = Math.min(left, PIER_BOATS); n >= (piers.length ? 1 : 0) && !s; n--) s = place(n, from, piers);
    if (!s) break;
    piers.push(s); left -= s.boats; from = s.at;
  } while (left > 0);
  return piers.length ? { piers, boats: piers.reduce((t, p) => t + p.boats, 0), at: piers[0].at } : null;
}
