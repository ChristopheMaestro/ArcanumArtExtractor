// Dynamic dialogue lines: a .dlg text of the form "x:" (or "x: args") is not shown as written.
// The engine replaces it with a line from the generic dialogue tables (data/mes/gd_*.mes) and
// often gives it a behaviour (barter, training, healing…). Ported from game/dialog.c:
//   PC options   sub_416C10()   a: b: c: d: e: f: h: i: k: l: n: p: q: r: s: t: u: w: x: y: z:
//   NPC lines    sub_416840()   g: i: m: r:
// The real wording is picked at random in a range (and depends on the NPC's gender and social
// class), so the viewer shows the first line of the range and lists the others in a tooltip.

import { DATA_ROOT } from '../core/config.js';
import { mesTable } from '../core/text-io.js';

const mes = name => mesTable(`${DATA_ROOT}mes/${name}.mes`);
const TABLES = {
  pc: mes('gd_pc2m'),             // PC to a male NPC (generic)
  clsPc: mes('gd_cls_pc2m'),      // PC to a male NPC, by the NPC's social class
  clsNpc: mes('gd_cls_m2m'),      // male NPC to a male PC, by social class
  clsNpcF: mes('gd_cls_m2f'),     // male NPC to a female PC
  rceNpc: mes('gd_rce_m2m'),      // male NPC to a male PC, by race
  rceNpcF: mes('gd_rce_m2f'),
  skill: mes('skill'),
  spell: mes('spell'),
  quest: mes('gamequestlog'),
};
const FILE = { pc: 'gd_pc2m.mes', clsPc: 'gd_cls_pc2m.mes', clsNpc: 'gd_cls_m2m.mes', clsNpcF: 'gd_cls_m2f.mes', rceNpc: 'gd_rce_m2m.mes', rceNpcF: 'gd_rce_m2f.mes' };

// Load every table the resolver reads; call before rendering (the resolver itself is synchronous).
export const loadDynamicTables = () => Promise.all(Object.values(TABLES).map(t => t().catch(() => null)));

function range(key, from, to) {
  const table = TABLES[key].peek();
  if (!table) return [];
  return [...table].filter(([n, s]) => n >= from && n <= to && s.trim()).sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}
const nameIn = (key, n) => TABLES[key].peek()?.get(n) || `#${n}`;
const numbers = s => (String(s).match(/-?\d+(?:\s*-\s*\d+)?/g) || []).map(x => x.replace(/\s+/g, ''));

// what: what the option does · t/from/to: the table and range its wording is taken from.
const PC = {
  a: { what: 'thank the NPC (wording by the NPC\'s social class)', t: 'clsPc', from: 1000, to: 1049 },
  b: { what: 'barter (1600–1699 instead when the NPC follows you)', t: 'pc', from: 300, to: 399 },
  c: { what: 'ask about the main quest; the line depends on the story state', t: 'pc', from: 1700, to: 1799 },
  d: { what: 'ask for directions to the listed areas (hidden if none is known)', t: 'pc', from: 1300, to: 1399 },
  e: { what: 'goodbye', t: 'pc', from: 400, to: 499 },
  f: { what: '"forget it"', t: 'pc', from: 800, to: 899 },
  h: { what: 'ask for healing (opens the healing offer)', t: 'pc', from: 700, to: 799 },
  i: { what: 'insult the NPC (reaction −10; may end the talk)', t: 'clsPc', from: 3000, to: 3049 },
  k: { what: 'ask more questions', t: 'pc', from: 1500, to: 1599 },
  l: { what: 'open the world map', t: 'pc', from: 2300, to: 2399 },
  n: { what: '"no"', t: 'pc', from: 100, to: 199 },
  p: { what: 'buy a newspaper', t: 'pc', from: 1900, to: 1999 },
  q: { what: 'quest line: replaced by the quest\'s own dialogue line for its current state' },
  r: { what: 'ask for rumors', t: 'clsPc', from: 2000, to: 2049 },
  s: { what: 'apologise', t: 'pc', from: 200, to: 299 },
  t: { what: 'ask for training (the NPC then lists the skills)', t: 'pc', from: 500, to: 599 },
  u: { what: 'ask the NPC to use a skill on you (hidden if it can\'t)', t: 'pc', from: 900, to: 999 },
  w: { what: '"who are you?"', t: 'pc', from: 1800, to: 1899 },
  x: { what: 'ask the NPC to mark a place on your map (hidden if none is known)', t: 'pc', from: 1400, to: 1499 },
  y: { what: '"yes"', t: 'pc', from: 1, to: 99 },
  z: { what: 'ask the NPC to cast a spell', t: 'pc', from: 1000, to: 1099 },
};
const NPC = {
  g: { what: 'generic greeting, picked from the NPC\'s reaction and how the PC looks (dead, invisible, polymorphed, in underwear…)', t: 'clsNpc', from: 10000, to: 10049 },
  i: { what: 'race-specific reply to an insult', t: 'rceNpc', from: 1000, to: 1049 },
  m: { what: 'ask the PC for money', t: 'clsNpc', from: 1000, to: 1049 },
  r: { what: 'tell a rumor for money', t: 'clsNpc', from: 1000, to: 1049 },
};

// g: arguments are "situation value" pairs (sub_419260()): the situation's own greeting is
// skipped (0), replaced by a jump to a line (N) or by a floated line (fl N).
const GREETING_CASES = ['PC dead', 'bad associates', 'invisible', 'elemental body', 'polymorphed', '?', 'shrunk', 'in underwear', 'barbarian armor', 'normal greeting'];
function greetingArgs(arg) {
  const out = [];
  for (const m of arg.matchAll(/(\d+)\s+(fl\s*)?(-?\d+)/gi)) {
    const what = GREETING_CASES[Number(m[1])] || `case ${m[1]}`;
    out.push(`${what}: ${m[2] ? `float line ${m[3]}` : Number(m[3]) ? `go to line ${m[3]}` : 'skip'}`);
  }
  return out.join(', ');
}

// What a "x:" line turns into: null for an ordinary line, else
// { code, text (the line the player sees), caption (what it does), variants (other wordings) }.
export function resolveDynamic(rawText, { npc = false, femalePc = false } = {}) {
  const m = String(rawText || '').trim().match(/^([a-z]):(.*)$/is);
  if (!m) return null;
  const code = m[1].toLowerCase(), arg = m[2].trim();
  const def = (npc ? NPC : PC)[code];
  if (!def) return null; // printed as written by the engine
  let key = def.t;
  if (npc && femalePc && key) key = key === 'clsNpc' ? 'clsNpcF' : key === 'rceNpc' ? 'rceNpcF' : key;
  const variants = key ? range(key, def.from, def.to) : [];
  let text = variants[0] || '';
  const notes = [def.what];

  if (!npc && code === 'u' && arg) { const s = nameIn('skill', Number.parseInt(arg, 10)); text = text.replace('%s', s); notes.push(`skill: ${s}`); }
  else if (!npc && code === 'z' && arg) { const s = nameIn('spell', Number.parseInt(arg, 10)); text = text.replace('%s', s); notes.push(`spell: ${s}`); }
  else if (!npc && code === 't' && arg) notes.push(`skills: ${arg.split(',').map(x => nameIn('skill', Number.parseInt(x, 10))).join(', ')}`);
  else if (!npc && code === 'q') {
    const q = Number.parseInt(arg, 10);
    text = TABLES.quest.peek()?.get(q) ? `[Quest ${q}: ${TABLES.quest.peek().get(q)}]` : `[Quest ${q}]`;
  } else if (code === 'r' || code === 'm') {
    const cost = arg.match(/\$\s*(-?\d+)/);
    if (cost) { text = text.replace('%d', cost[1]); notes.push(`costs ${cost[1]} coins`); }
    const ids = numbers(arg.replace(/\$\s*-?\d+/, ''));
    if (ids.length) notes.push(`${code === 'r' ? 'rumors' : 'then line'} ${ids.join(', ')}`);
  } else if ((code === 'd' || code === 'x') && arg) notes.push(`areas ${numbers(arg).join(', ')}`);
  else if (npc && code === 'g' && arg) { const g = greetingArgs(arg); if (g) notes.push(g); }

  const source = key ? `${FILE[key] || ''} ${def.from}–${def.to}`.trim() : '';
  return {
    code,
    text: text || `[${def.what}]`,
    caption: `Dynamic dialog ${code}:${arg ? ` ${arg}` : ''} · ${notes.join(' · ')}`,
    variants,
    source,
  };
}
