// Search index over every .PRO: file name, object type, description (description.mes) and the
// names of the art files it uses. It serves the .PRO search and, through byArt, the .ART search
// (an art file is "described" by the prototypes that use it). Built once, on the first search.

import { joinPath, manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { MOB_OBJECT_TYPE_NAMES } from '../mob/mob-schema.js';
import { protoCritterAidInfo } from './critter-aid.js';
import { resolveProtoFileCardArts } from './proto-card-art.js';
import { decodeProtoForSearch } from './proto-decoder.js';
import { loadProtoManifest } from './proto-explorer.js';
import {
  loadContainerMes, loadDescriptionMes, loadItemGroundMes, loadItemInvenMes, loadItemPaperMes, loadSceneryMes,
  protoDescriptionInfo,
} from './proto-mes.js';

const CONCURRENCY = 12;
const baseName = name => String(name || '').split(/[\\/]/).pop().toLowerCase();

let indexPromise = null;
const listeners = new Set();

async function listProtoFiles(path, name, out, visited) {
  if (visited.has(path)) return;
  visited.add(path);
  let manifest;
  try { manifest = await loadProtoManifest(path, name); } catch (_) { return; }
  for (const filename of manifestFiles(manifest, 'pro')) out.push({ filename, path, folderName: name });
  // sub-folders all at once (a round trip each online), their files kept in folder order
  const subs = await Promise.all(manifestSubfolders(manifest).map(async sf => {
    const sub = [];
    await listProtoFiles(joinPath(path, sf.relative_path || sf.folder_name), sf.folder_name, sub, visited);
    return sub;
  }));
  for (const sub of subs) out.push(...sub);
}

async function buildIndex() {
  try {
    await Promise.all([loadDescriptionMes(), loadItemInvenMes(), loadItemGroundMes(), loadItemPaperMes(), loadContainerMes(), loadSceneryMes()]);
  } catch (_) { /* descriptions are simply missing then */ }
  const files = [];
  await listProtoFiles('', 'proto', files, new Set());

  const entries = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      try {
        const decoded = await decodeProtoForSearch(file.filename, file.path);
        const descField = decoded.fields.find(f => f.field === 23);
        const description = (descField && protoDescriptionInfo(descField.value)?.text) || '';
        const aidField = decoded.fields.find(f => f.field === 1);
        const artNames = [];
        const critter = aidField ? protoCritterAidInfo(aidField.value, decoded.objType) : null;
        if (critter?.filename) artNames.push(critter.filename);
        const arts = await resolveProtoFileCardArts(decoded).catch(() => null);
        for (const n of [arts?.inventoryArtName, arts?.currentArtName]) if (n && !artNames.includes(n)) artNames.push(n);
        const typeName = MOB_OBJECT_TYPE_NAMES[decoded.objType] || '';
        entries.push({
          ...file, objType: decoded.objType, typeName, description, artNames,
          fields: [
            { label: 'name', text: file.filename },
            { label: 'description', text: description },
            { label: 'type', text: typeName },
            { label: 'art', text: artNames.join(' ') },
          ],
        });
      } catch (_) { /* unreadable prototype: left out of the index */ }
      done++;
      for (const cb of listeners) cb(done, files.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byArt = new Map();   // lower-case art file name -> entries that use it
  for (const entry of entries) {
    for (const art of entry.artNames) {
      const key = baseName(art);
      if (!byArt.has(key)) byArt.set(key, []);
      byArt.get(key).push(entry);
    }
  }
  return { entries, byArt };
}

// `onProgress(done, total)` is called while the index is being built (first call only).
export function loadProtoIndex(onProgress) {
  if (onProgress) listeners.add(onProgress);
  if (!indexPromise) indexPromise = buildIndex().catch(err => { indexPromise = null; throw err; });
  return indexPromise.finally(() => { if (onProgress) listeners.delete(onProgress); });
}

export const artBaseName = baseName;
