// Global flags: what they stand for and who changes them.
//
// The engine has no names for its 3200 global flags (script.c), so a flag is explained by
// where it is used, from data/scr/global_flags.json (built by toolbox/gen_global_flags.py):
//   scr     [file, line, role]                       role: set | clear | write | test | read
//   dlg     [file, line num, role, value, speaker, text]  role: set (result field) | test
//   rnd     [encounter entry, note]                  WMap_Rnd.mes "GlobalFlag:"
//   pregen  n                                        set when pregenerated character n is picked

import { DATA_ROOT } from '../core/config.js';
import { memoAsync } from '../core/text-io.js';

export const loadGlobalFlagIndex = memoAsync(async () => {
  const res = await fetch(`${DATA_ROOT}scr/global_flags.json`);
  if (!res.ok) throw new Error(`global_flags.json: HTTP ${res.status}`);
  return res.json();
});

// "01005Farad.dlg" -> "Farad"
export const shortName = file => file.replace(/\.(scr|dlg)$/i, '').replace(/^\d+_?/, '') || file;

const WRITES = new Set(['set', 'clear', 'write']);

// Every file that uses flag `n`, one record per file: { file, kind: 'scr'|'dlg', script, roles:Set, lines:[], text }.
// `script` is the .scr that runs the file (a dialogue belongs to the script of the same name).
export function flagUsers(index, n) {
  const f = index.flags[n] || {};
  const byFile = new Map();
  const add = (file, kind, role, line, text) => {
    let u = byFile.get(file);
    if (!u) byFile.set(file, u = { file, kind, script: kind === 'scr' ? file : file.replace(/\.dlg$/i, '.scr'), roles: new Set(), lines: [], text: '' });
    u.roles.add(role);
    if (!u.lines.includes(line)) u.lines.push(line);
    // The quoted line: the one that changes the flag if there is one, else the first that tests it.
    if (text && (!u.text || (role !== 'test' && !u.textSets))) { u.text = text; u.textSets = role !== 'test'; }
  };
  for (const [file, line, role] of f.scr || []) add(file, 'scr', role, line);
  for (const [file, num, role, value, , text] of f.dlg || []) add(file, 'dlg', role === 'set' ? (value ? 'set' : 'clear') : 'test', num, text);
  return [...byFile.values()];
}

export const isWriter = u => [...u.roles].some(r => WRITES.has(r));

// Explanation of flag `n`, from the most telling use first. `self` is the open script.
// Returns a list of pieces: plain strings, and { user, label } for a file that can be opened.
export function flagMeaningParts(index, n, self = '') {
  const f = index.flags[n];
  if (!f) return ['not used anywhere else'];
  const out = [];
  const sep = () => { if (out.length) out.push(' · '); };
  if (f.pregen) { sep(); out.push(`picked pregenerated character #${f.pregen.join(', #')}`); }
  if (f.rnd) {
    const notes = [...new Set(f.rnd.map(([, note]) => note).filter(Boolean))];
    sep(); out.push(`enables random encounters${notes.length ? `: ${notes.slice(0, 3).join(', ')}${notes.length > 3 ? '…' : ''}` : ` (${f.rnd.length})`}`);
  }
  const users = flagUsers(index, n);
  const setters = users.filter(u => u.roles.has('set') || u.roles.has('write'));
  const describe = u => {
    if (u.file === self) return ['this script'];
    const label = `${index.scripts?.[u.script] || shortName(u.file)}${u.kind === 'dlg' ? ' dialogue' : ''}`;
    return u.kind === 'dlg' && u.text ? [{ user: u, label }, ` “${u.text}”`] : [{ user: u, label }];
  };
  const list = (us, total) => {
    us.forEach((u, i) => { if (i) out.push('; '); out.push(...describe(u)); });
    if (total > us.length) out.push(` (+${total - us.length} more)`);
  };
  if (setters.length) {
    const others = setters.filter(u => u.file !== self);
    sep(); out.push('set by ');
    list((others.length ? others : setters).slice(0, 2), setters.length);
    // Set only here: who reads it says more about what it means.
    if (!others.length) {
      const readers = users.filter(u => u.file !== self && !isWriter(u)).sort((a, b) => (b.kind === 'dlg') - (a.kind === 'dlg'));
      if (readers.length) { out.push(' · checked by '); list(readers.slice(0, 1), readers.length); }
    }
  } else if (!out.length) {
    const cleared = users.filter(u => u.roles.has('clear'));
    if (cleared.length) { out.push('only ever cleared by '); list(cleared.slice(0, 2), cleared.length); }
    else out.push('never set by any script or dialogue');
  }
  return out;
}

export const flagMeaning = (index, n, self = '') =>
  flagMeaningParts(index, n, self).map(p => (typeof p === 'string' ? p : p.label)).join('');
