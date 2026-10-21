// The explorers of .art .pro .sec .mob .dlg .mes .scr all start from data/ (as the .BMP one does), so the mods and the modules
// are listed too. data/file_index_<ext>.json (toolbox/file_index.py) holds the folder tree of one kind of file:
// { f: [file names], d: { folder: tree } }. One request per category builds the whole tree.

import { DATA_ROOT } from './config.js';
import { joinPath } from './manifest.js';

const trees = new Map();   // ext -> Promise<tree>
function loadTree(ext) {
  if (!trees.has(ext)) {
    const p = (async () => {
      const resp = await fetch(`${DATA_ROOT}file_index_${ext}.json`);
      if (!resp.ok) throw new Error(`couldn't load ${DATA_ROOT}file_index_${ext}.json (HTTP ${resp.status}); run toolbox/file_index.py`);
      return resp.json();
    })();
    trees.set(ext, p);
    p.catch(() => trees.delete(ext));
  }
  return trees.get(ext);
}

export const loadIndexTree = loadTree;   // ext -> Promise<{ f, d }>, the whole folder tree of one kind of file

// A big index (.mob: 119 000 names) lists only its folders in file_index_<ext>.json; a folder marked `s` (a game, mod or module) keeps
// its files in data/file_index_<ext>/<path with / as __>.json, fetched the first time something inside it is read.
const shards = new Map();   // "ext:path" -> Promise
async function openShard(ext, node, path) {
  if (!node.s) return node;
  const key = `${ext}:${path}`;
  if (!shards.has(key)) {
    const p = fetch(`${DATA_ROOT}file_index_${ext}/${encodeURIComponent(path.replaceAll('/', '__'))}.json`).then(r => {
      if (!r.ok) throw new Error(`couldn't load the ${path} part of the .${ext} index (HTTP ${r.status}); run toolbox/file_index.py`);
      return r.json();
    });
    shards.set(key, p);
    p.catch(() => shards.delete(key));
  }
  Object.assign(node, await shards.get(key));
  delete node.s;
  return node;
}

const walk = async (ext, tree, path) => {
  const done = [];
  for (const part of String(path || '').split('/').filter(Boolean)) {
    tree = tree?.d?.[part];
    if (!tree) return null;
    done.push(part);
    tree = await openShard(ext, tree, done.join('/'));
  }
  return tree;
};

// `(relativePath) => Promise<manifest>` in the shape of a folder manifest, so the shared folder tree and grid work on it.
// relativePath is under data/ ('' = data). Only folders that hold (at any depth) a file of the kind are listed.
export function createIndexLoader(ext) {
  return async function loadIndexManifest(relativePath = '') {
    const node = await walk(ext, await loadTree(ext), relativePath);
    if (!node) throw new Error(`no .${ext} in ${relativePath || 'data'}`);
    const subfolders = {};
    for (const name of Object.keys(node.d || {})) subfolders[name] = { folder_name: name, relative_path: name };
    return { subfolders, files: node.f || [] };
  };
}

// The file names of one folder (under data/) for one kind of file, or null when the index has none there (or cannot be read).
export async function indexFolderFiles(ext, relativePath) {
  try { return (await walk(ext, await loadTree(ext), relativePath))?.f || null; } catch (_) { return null; }
}
// The folder names directly inside a folder (under data/) that hold a file of the kind, at any depth.
export async function indexSubfolderNames(ext, relativePath) {
  try { return Object.keys((await walk(ext, await loadTree(ext), relativePath))?.d || {}); } catch (_) { return []; }
}
// Loader for the .art names of one folder (under data/): lower-case name -> exact name (callers fall back to the bare name when it is empty).
export function artNameIndex(relativePath) {
  let p = null;
  return () => p ??= indexFolderFiles('art', relativePath).then(files => {
    const map = new Map();
    for (const f of files || []) if (/\.art$/i.test(f)) map.set(f.toLowerCase(), f);
    return map;
  });
}

// The listing of a map folder for the sector map: its .sec and .mob files (a folder with only one kind lists that kind), and the sub-folders that hold .sec.
const secIndex = createIndexLoader('sec'), mobIndex = createIndexLoader('mob');
export async function loadMapFolderIndex(relativePath = '') {
  const [sec, mob] = await Promise.all([secIndex(relativePath).catch(() => null), mobIndex(relativePath).catch(() => null)]);
  if (!sec && !mob) throw new Error(`no .sec or .mob in ${relativePath || 'data'}`);
  return { subfolders: sec?.subfolders || {}, files: [...(sec?.files || []), ...(mob?.files || [])] };
}

// Every file of the kind, as paths under data/ ('maps/Tarant/1.sec'): what a script needs to find a file by name.
export async function listIndexFiles(ext) {
  const out = [];
  await (async function visit(tree, path) {
    tree = await openShard(ext, tree, path);
    for (const f of tree.f || []) out.push(joinPath(path, f));
    for (const [name, sub] of Object.entries(tree.d || {})) await visit(sub, joinPath(path, name));
  })(await loadTree(ext), '');
  return out;
}

// A map folder is <something>/maps/<Map>: data/maps/<Map>, data/mods/<Mod>/maps/<Map>, data/modules/<Module>/maps/<Map>.
// mapFolderPath('mods/CE/maps/Arcanum1/Tarant') = 'mods/CE/maps/Arcanum1' (the folder holding map.prp, terrain.tdf...);
// a sub-folder (a town of the world map) belongs to the map above it. A path with no maps/ in it is returned as it is.
export function mapFolderPath(path) {
  const parts = String(path || '').split('/').filter(Boolean), at = parts.indexOf('maps');
  return at < 0 || at + 1 >= parts.length ? parts.join('/') : parts.slice(0, at + 2).join('/');
}
export const mapFolderName = path => mapFolderPath(path).split('/').pop();
// Another map of the same game or mod or module as `path` (a jump leads to maps of the same maps/ folder).
export function siblingMapPath(path, name) {
  const parts = String(path || '').split('/').filter(Boolean), at = parts.indexOf('maps');
  return at < 0 ? `maps/${name}` : `${parts.slice(0, at + 1).join('/')}/${name}`;
}

// A path from before the explorers started at data/ (under the folder the category used to open: maps, proto, dlg, scr, art)
// becomes a path under data/. A path that already starts at data/ is left alone.
const LEGACY_ROOT = { mob: 'maps', sec: 'maps', pro: 'proto', dlg: 'dlg', scr: 'scr', art: 'art' };
export function toDataPath(mode, path, hasFile = false) {
  const p = String(path || '').replace(/^\/+|\/+$/g, '');
  const root = LEGACY_ROOT[mode];
  if (!root) return p;
  if (!p) return hasFile ? root : '';
  if (p === root || p.startsWith(`${root}/`) || p === 'mods' || p.startsWith('mods/') || p === 'modules' || p.startsWith('modules/')) return p;
  return `${root}/${p}`;
}
