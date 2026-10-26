// Prebuilt search text (toolbox/search_text.py): js/index/search/<ext>/<scope>.json holds, for one kind of file (.dlg .mes .scr .mob)
// and one scope, what the file search looks into, keyed by the path under data/. A scope is the base game ('base') or one mod / module
// ('mods__Name', 'modules__Name'). One request then replaces reading every file of the scope one by one.
//
//   dlg, mes -> the text of the file     scr -> [[label, text], ...]     mob -> its name (F_DESCRIPTION), '' when it has none
//
// A file the index does not know (or a scope it has no file for) is read from the file itself, as before.

import { INDEX_ROOT } from '../core/config.js';

let enabled = true;
// The builder turns the index off so it reads the real files.
export function setSearchIndexEnabled(on) { enabled = on; }

export function scopeOf(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return (parts[0] === 'mods' || parts[0] === 'modules') && parts.length > 1 ? `${parts[0]}__${parts[1]}` : 'base';
}

const loaded = new Map();   // "ext/scope" -> Promise<object | null>
function loadScope(ext, scope) {
  const key = `${ext}/${scope}`;
  if (!loaded.has(key)) {
    loaded.set(key, fetch(`${INDEX_ROOT}search/${ext}/${encodeURIComponent(scope)}.json`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return loaded.get(key);
}

// The indexed value of a file ('dlg/x.dlg', a path under data/), or undefined when the index has nothing for it.
export async function indexedValue(dataPath) {
  if (!enabled) return undefined;
  const ext = /\.([a-z]+)$/i.exec(dataPath)?.[1].toLowerCase();
  if (!ext) return undefined;
  return (await loadScope(ext, scopeOf(dataPath)))?.[dataPath];
}
