// Helpers for the folder listings every explorer reads. A listing is { subfolders: { name: { folder_name, relative_path } }, files: [names] };
// js/core/file-index.js builds them from js/index/files/file_index_<ext>.json (toolbox/file_index.py).

export function joinPath(parent, child) {
  const a = String(parent || '').replace(/^\/+|\/+$/g, '');
  const b = String(child || '').replace(/^\/+|\/+$/g, '');
  return a && b ? `${a}/${b}` : (a || b);
}

// A listing entry is either a file name or an object carrying one.
export function manifestEntryName(x) {
  return typeof x === 'string' ? x : (x && (x.name || x.filename || x.file || x.path));
}

// All file names listed (array form or { files: [...] }).
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
