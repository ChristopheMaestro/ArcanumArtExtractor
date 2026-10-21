// Which script lines show which dialogue lines.
//
// A script's "dialog", "float line" and "print line" actions name a line of the .dlg that has
// the script's number (script_name_build_dlg_name() in game/script_name.c), so the lines of a
// .dlg are triggered by the .scr with the same number, matched by number as the engine does
// (the file names do not always agree on case).

import { DATA_ROOT } from '../core/config.js';
import { manifestFiles } from '../core/manifest.js';
import { createIndexLoader } from '../core/file-index.js';
import { fetchBuffer } from '../core/text-io.js';
import { decodeScrBuffer, scrNumberFromFilename } from './scr-decoder.js';
import { SCR_ACTIONS, SCR_VALUE_TYPES } from './scr-schema.js';

const SCR_ROOT = `${DATA_ROOT}scr/`;
const TRIGGER_ACTIONS = new Set(['dialog', 'float line', 'print line']);
// The base game's scr/ folder (the .scr explorer shares it for the script numbers).
const loadScrIndex = createIndexLoader('scr');
export const loadScrManifest = () => loadScrIndex('scr');

let scrByNumber = null;
function scriptFiles() {
  scrByNumber ??= loadScrManifest().then(m => {
    const index = new Map();
    for (const f of manifestFiles(m, 'scr')) {
      const n = scrNumberFromFilename(f);
      if (n !== null && !index.has(n)) index.set(n, f);
    }
    return index;
  }).catch(() => new Map());
  return scrByNumber;
}

const cache = new Map();
// dialogue file name -> Promise<Map<dialogue line, [{ scr, line, action, branch }]>>
export function dlgTriggers(dlgFilename) {
  if (!cache.has(dlgFilename)) cache.set(dlgFilename, (async () => {
    const out = new Map();
    const scr = (await scriptFiles()).get(scrNumberFromFilename(dlgFilename));
    if (!scr) return out;
    let decoded;
    try { decoded = decodeScrBuffer(await fetchBuffer(`${SCR_ROOT}${encodeURIComponent(scr)}`), scr); } catch (_) { return out; }
    for (const e of decoded.entries) {
      // An always-true line never takes its else branch (same rule as the viewer).
      const branches = e.type === 0 ? [['', e.action]] : [['THEN', e.action], ['ELSE', e.els]];
      for (const [branch, st] of branches) {
        const def = SCR_ACTIONS[st.type];
        if (!def || !TRIGGER_ACTIONS.has(def.name) || SCR_VALUE_TYPES[st.opType[0]] !== 'number') continue;
        const num = st.opValue[0];
        if (!out.has(num)) out.set(num, []);
        out.get(num).push({ scr, line: e.line, action: def.name, branch });
      }
    }
    return out;
  })());
  return cache.get(dlgFilename);
}

// Open a script at one of its lines (loaded on demand: the .scr explorer imports the .dlg one).
export async function openTrigger(t) {
  const { openScrFile } = await import('./scr-explorer.js');
  return openScrFile(t.scr, t.line);
}

export const triggerLabel = t => `${t.scr} · line ${t.line}${t.branch === 'ELSE' ? ' (else)' : ''} · ${t.action}`;
