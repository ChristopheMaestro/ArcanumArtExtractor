// Local flags of a script: what can set, clear and read each one.
//
// A local flag is one of 32 yes / no bits (ScriptHeader.flags) that lives in a script *attachment*:
// the copy of the script an object, prototype or sector object carries at one event. The engine
// changes it in only three ways (game/script.c, game/dialog.c):
//   1. the script's own "set local flag" / "clear local flag" lines;
//   2. a dialogue's "lfN V" effect: it changes the NPC's copy attached at the dialog event
//      (script_local_flag_set(npc, SAP_DIALOG, N, V)), and "lfN V" in a player option's test reads it;
//   3. the value stored with the attachment when the object was made (its initial flags).
// A script started with "call script" runs on a fresh copy that is forgotten afterwards, and a script
// that is swapped for another ("change this script to script", "change script") leaves its flags to the
// one that takes its place. toolbox/gen_local_flags.py finds the attachments, their stored flags and the
// scripts that turn into others (data/scr/local_flags.json).

import { DATA_ROOT } from '../core/config.js';
import { memoAsync } from '../core/text-io.js';
import { parseCodes } from '../text/dlg-codes.js';
import { SCR_ACTIONS, SCR_CONDITIONS, SCR_VALUE_TYPES } from './scr-schema.js';

export const loadLocalFlagIndex = memoAsync(async () => {
  const resp = await fetch(`${DATA_ROOT}scr/local_flags.json`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`local_flags.json: HTTP ${resp.status}`);
  return resp.json();
});

// { flags: Map(n -> facts), usedByLine: Map(line -> Set(n)), dynamic, attached }.
//   dlg: Map(num -> dialogue entry) of the .dlg that shares the script's file name, or null.
//   index: the local_flags.json index, or null.
export function analyzeLocalFlags({ decoded, dlg, ownNumber, index }) {
  const flags = new Map(), usedByLine = new Map();
  let dynamic = false;
  const get = n => {
    let f = flags.get(n);
    if (!f) flags.set(n, f = { n, sets: [], clears: [], tests: [], header: false, initial: [], turns: [], dlgSets: [], dlgClears: [] });
    return f;
  };
  const used = (line, n) => { if (!usedByLine.has(line)) usedByLine.set(line, new Set()); usedByLine.get(line).add(n); };

  // 1. the script's own lines (an always-true line never runs its else branch).
  for (const e of decoded.entries) {
    const sts = [['cond', e, SCR_CONDITIONS[e.type]], ['act', e.action, SCR_ACTIONS[e.action.type]]];
    if (e.type !== 0) sts.push(['act', e.els, SCR_ACTIONS[e.els.type]]);
    for (const [kind, st, def] of sts) {
      if (!def) continue;
      const role = kind === 'cond' ? (def.name === 'local flag' ? 'tests' : null)
        : def.name === 'set local flag' ? 'sets' : def.name === 'clear local flag' ? 'clears' : null;
      if (!role) continue;
      if (SCR_VALUE_TYPES[st.opType[0]] !== 'number') { dynamic = true; continue; }   // the flag number is worked out while running
      const n = st.opValue[0];
      get(n)[role].push({ src: 'scr', line: e.line });
      used(e.line, n);
    }
  }

  const me = index?.scripts?.[ownNumber] || null;
  const attached = me?.attached || null;
  // The dialogue's effects only reach the copy attached at the dialog event; without the index, assume they do.
  const dlgReaches = !attached || !Object.keys(attached).length || !!attached.DIALOG;
  const dlgEntries = dlg ? [...dlg.values()] : [];

  for (const f of flags.values()) {
    // 2. the dialogue: effects of every line, tests of the player's options (an NPC line's test field is a voice-over number).
    for (const d of dlgEntries) {
      for (const c of parseCodes(d.actions)) if (c.code === 'lf' && c.value === f.n) (c.value2 ? f.dlgSets : f.dlgClears).push({ src: 'dlg', num: d.num, pc: d.iq !== 0 });
      if (d.iq !== 0) for (const c of parseCodes(d.conditions)) if (c.code === 'lf' && c.value === f.n) f.tests.push({ src: 'dlg', num: d.num, wants: c.value2 ? 1 : 0 });
    }
    f.dlgReaches = dlgReaches;
    // 3. what the attachments start with: the script file's own header, then the objects.
    f.header = !!((decoded.initialFlags >>> f.n) & 1);
    for (const [kind, name, point, bits] of me?.initial || []) if ((bits >>> f.n) & 1) f.initial.push({ kind, name, point });
    // Scripts that turn into this one keep the object's flags: those that set / clear it count.
    for (const [file, line, how, sets, clears] of me?.turnsInto || []) {
      if (sets.includes(f.n)) f.turns.push({ file, line, how, sets: true });
      if (clears.includes(f.n)) f.turns.push({ file, line, how, clears: true });
    }
  }
  return { flags, usedByLine, dynamic, attached };
}

const EVENT = p => String(p).toLowerCase().replace(/_/g, ' ');
const KIND_NAME = { mob: 'placed object', pro: 'prototype', sec: 'object in a sector' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "dialog (1 placed object), heartbeat (2 prototypes)": where a script is attached.
export function attachedText(attached) {
  if (!attached) return '';
  return Object.entries(attached).map(([point, by]) => {
    const what = Object.entries(by).map(([k, c]) => plural(c, KIND_NAME[k] || k)).join(', ');
    return `${EVENT(point)} (${what})`;
  }).join(' · ');
}

// What is known about one flag, as items { text, link? } (link: { line } | { dlg } | { script, line }).
// h.dlgText(num) gives the words of a dialogue line.
export function flagFacts(f, h) {
  const q = num => { const t = h.dlgText(num); return t ? `“${t}” ` : ''; };
  const own = list => list.map(s => ({ text: `line ${s.line}`, link: { line: s.line } }));
  const dlgItem = s => ({ text: `${s.pc ? 'the dialogue answer' : "the NPC's dialogue line"} ${q(s.num)}(line ${s.num})`, link: { dlg: s.num } });
  const sets = [...own(f.sets.filter(s => s.src === 'scr'))];
  const clears = [...own(f.clears.filter(s => s.src === 'scr'))];
  if (f.dlgReaches) { sets.push(...f.dlgSets.map(dlgItem)); clears.push(...f.dlgClears.map(dlgItem)); }
  const turnItems = pred => f.turns.filter(pred).map(t => ({ text: `${h.scriptName(t.file)} (line ${t.line})`, link: { script: t.file, line: t.line } }));
  sets.push(...turnItems(t => t.sets));
  clears.push(...turnItems(t => t.clears));

  const starts = [];
  if (f.header) starts.push({ text: 'set in the script file itself (the starting value of a fresh copy)' });
  if (f.initial.length) {
    const by = {};
    for (const i of f.initial) by[i.kind] = (by[i.kind] || 0) + 1;
    starts.push({ text: `set when created, on ${Object.entries(by).map(([k, c]) => plural(c, KIND_NAME[k] || k)).join(' and ')} that carry this script (stored with them)` });
  }
  const tests = f.tests.map(t => (t.src === 'scr'
    ? { text: `line ${t.line}`, link: { line: t.line } }
    : { text: `the dialogue answer ${q(t.num)}(line ${t.num}), offered only while it is ${t.wants ? 'set' : 'not set'}`, link: { dlg: t.num } }));
  // Dialogue effects that do not reach this script's copies (it is not attached at the dialog event).
  const elsewhere = f.dlgReaches ? [] : [...f.dlgSets.map(dlgItem), ...f.dlgClears.map(dlgItem)];
  return { sets, clears, starts, tests, elsewhere, neverSet: !sets.length && !starts.length, dlgCaveat: !f.dlgReaches && elsewhere.length };
}
