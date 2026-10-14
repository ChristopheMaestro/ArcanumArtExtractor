// Folder manifests (<folder>/<folder>_manifest.json) and the helpers every
// explorer uses to read them.

import { MOB_ROOT as MAPS_ROOT } from './config.js';
import { errText, memoAsync } from './text-io.js';
import { encPath } from './util.js';

export function joinPath(parent, child) {
  const a = String(parent || '').replace(/^\/+|\/+$/g, '');
  const b = String(child || '').replace(/^\/+|\/+$/g, '');
  return a && b ? `${a}/${b}` : (a || b);
}

// A manifest entry is either a file name or an object carrying one.
export function manifestEntryName(x) {
  return typeof x === 'string' ? x : (x && (x.name || x.filename || x.file || x.path));
}

// All file names listed in a manifest (array form or { files: [...] }).
export function manifestFileList(manifest) {
  const list = Array.isArray(manifest) ? manifest : (Array.isArray(manifest?.files) ? manifest.files : []);
  return list.map(manifestEntryName).filter(x => typeof x === 'string');
}

// Sorted file names with one extension, e.g. manifestFiles(m, 'mob').
export function manifestFiles(manifest, ext) {
  const re = new RegExp(`\\.${ext}$`, 'i');
  return manifestFileList(manifest).filter(f => re.test(f)).sort((a, b) => a.localeCompare(b));
}

export function manifestSubfolders(manifest) {
  const sub = manifest?.subfolders && typeof manifest.subfolders === 'object' ? manifest.subfolders : {};
  return Object.keys(sub).sort().map(k => sub[k]).filter(sf => sf && typeof sf === 'object' && sf.folder_name);
}

export function manifestUrl(root, relativePath, folderName, rootName) {
  const path = String(relativePath || '').replace(/^\/+|\/+$/g, '');
  // The root manifest is <rootName>_manifest.json, and a '..' card passes '..'
  // as its label, which is not a folder name.
  const name = !path ? rootName : ((folderName && folderName !== '..') ? folderName : path.split('/').pop());
  return `${root}${path ? `${encPath(path)}/` : ''}${encodeURIComponent(name)}_manifest.json`;
}

// Cached `(relativePath, folderName) => Promise<manifest>` for one data folder.
export function createManifestLoader({ root, rootName, label }) {
  const cache = new Map();
  return async function loadManifest(relativePath = '', folderName = rootName) {
    const path = String(relativePath || '').replace(/^\/+|\/+$/g, '');
    if (cache.has(path)) return cache.get(path);
    const url = manifestUrl(root, path, folderName, rootName);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      cache.set(path, data);
      return data;
    } catch (err) {
      throw new Error(`couldn't load ${label} manifest at ${url} (${errText(err)})`);
    }
  };
}

// Loader for an optional manifest of .art names: lower-case name -> exact name.
// A missing manifest yields an empty map (callers fall back to the bare name).
export function artNameIndex(url) {
  return memoAsync(async () => {
    const map = new Map();
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        for (const f of manifestFileList(await resp.json())) {
          if (/\.art$/i.test(f)) { const base = f.split('/').pop(); map.set(base.toLowerCase(), base); }
        }
      }
    } catch (_) {}
    return map;
  });
}

// .mob and .sec files live in the same data/maps tree and share its manifests.
export const loadMapsManifest = createManifestLoader({ root: MAPS_ROOT, rootName: 'maps', label: 'maps' });
