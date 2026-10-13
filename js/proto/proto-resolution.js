// .MOB to .PRO prototype resolution.

import { errText, memoAsync } from '../core/text-io.js';
import { PRO_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import { mobCurrentAidText, mobFieldValueText } from '../mob/mob-decoder.js';
import { joinPath, manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { decodeProtoBuffer } from './proto-decoder.js';
import { descriptionLabel } from './proto-mes.js';
import { loadProtoManifest } from './proto-explorer.js';

// data-formats.md: an instance record stores only its overridden fields; every
// unset bit means "use the prototype's value". To show a .mob's *effective*
// fields we need to resolve its linked prototype (by number, from prototype_oid's
// OID_TYPE_A payload) and merge. protoNumberIndex walks the /proto/ manifest tree
// once (folder listings only, cheap) to map "NNNNNN - Name.pro" -> path.
export const getProtoNumberIndex = memoAsync(async () => {
  const index = new Map();
  const visited = new Set();
  async function walk(relativePath, folderName) {
    if (visited.has(relativePath)) return;
    visited.add(relativePath);
    let manifest;
    try { manifest = await loadProtoManifest(relativePath, folderName); } catch (_) { return; }
    for (const f of manifestFiles(manifest, 'pro')) {
      const m = /^(\d+)\s*-\s*/.exec(f);
      if (m) {
        const num = parseInt(m[1], 10);
        if (!index.has(num)) index.set(num, { relPath: relativePath, filename: f });
      }
    }
    await Promise.all(manifestSubfolders(manifest).map(sf =>
      walk(joinPath(relativePath, sf.relative_path), sf.folder_name)));
  }
  await walk('', 'proto');
  return index;
});

// ObjectID union: int16 type, 2 bytes padding, int32 padding, then a 16-byte
// union — for OID_TYPE_A (type 1) the union's first dword (offset +8) is the
// prototype number. Mirrors ObjectOidNumberOffset/OidNumberOffset in the C# readers.
export function mobOidTypeAndNumber(bytes) {
  if (!bytes || bytes.length !== 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: view.getInt16(0, true), number: view.getUint32(8, true) };
}

// `cache` (optional Map) memoizes by prototype number so a map with thousands
// of mobs fetches and decodes each .pro once. Failures are not cached.
const sharedProtoResolveCache = new Map();
export async function resolveMobPrototype(decoded, cache, _internal) {
  const info = mobOidTypeAndNumber(decoded.protoOid);
  if (!info || info.type !== 1) return { protoNumber: null, entry: null, decodedProto: null, error: null };
  if (!_internal) {
    cache = cache || sharedProtoResolveCache;
    if (cache.has(info.number)) return cache.get(info.number);
    const pending = resolveMobPrototype(decoded, null, true);
    cache.set(info.number, pending);
    const result = await pending;
    if (result.error) cache.delete(info.number);
    return result;
  }
  const protoNumber = info.number;
  try {
    const index = await getProtoNumberIndex();
    const entry = index.get(protoNumber);
    if (!entry) return { protoNumber, entry: null, decodedProto: null, error: `#${protoNumber} not found under /proto/` };
    const url = `${PRO_ROOT}${entry.relPath ? encPath(entry.relPath) + '/' : ''}${encPath(entry.filename)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const decodedProto = decodeProtoBuffer(await resp.arrayBuffer(), entry.filename);
    return { protoNumber, entry, decodedProto, error: null };
  } catch (err) {
    return { protoNumber, entry: null, decodedProto: null, error: errText(err) };
  }
}

// navigate(open) (optional) runs a jump to another file so that it can be returned from.
export function renderMobPrototypeInfo(decoded, proto, container, navigate = open => open()) {
  container.innerHTML = '';

  if (proto.protoNumber === null) {
    const p = document.createElement('p');
    p.className = 'explorer-status';
    p.textContent = "This object's prototype OID isn't a numbered (A-type) reference, so effective fields can't be resolved.";
    container.appendChild(p);
    return;
  }
  if (proto.error || !proto.decodedProto) {
    const p = document.createElement('p');
    p.className = 'explorer-status err';
    p.textContent = `Prototype #${proto.protoNumber}: ${proto.error || 'not found'}`;
    container.appendChild(p);
    return;
  }

  // The jump to the .pro is a button in the right bar (mob-extras.js).

  if (proto.decodedProto.objType !== decoded.objType) {
    const warn = document.createElement('p');
    warn.className = 'explorer-status err';
    warn.textContent = `Prototype object type (${proto.decodedProto.objType}) doesn't match this instance's type (${decoded.objType}) — skipping the merge.`;
    container.appendChild(warn);
    return;
  }

  const overrideMap = new Map(decoded.fields.map(f => [f.field, f]));
  const title = document.createElement('h3');
  title.className = 'mob-section-title';
  title.textContent = 'Effective fields (override + inherited)';
  container.appendChild(title);

  const table = document.createElement('div');
  table.className = 'mob-field-table mob-effective-table';
  const head = document.createElement('div');
  head.className = 'mob-field-row mob-field-head';
  ['Field', 'Source', 'Type', 'Value', 'Raw'].forEach(t => {
    const c = document.createElement('div'); c.textContent = t; head.appendChild(c);
  });
  table.appendChild(head);

  for (const pf of proto.decodedProto.fields) {
    const override = overrideMap.get(pf.field);
    const f = override || pf;
    const row = document.createElement('div');
    row.className = 'mob-field-row';
    const c1 = document.createElement('div');
    c1.innerHTML = `<strong>${f.name}</strong><small>#${f.field}</small>`;
    const c2 = document.createElement('div');
    c2.textContent = override ? 'Overridden' : 'Inherited';
    c2.classList.add(override ? 'proto-available' : 'mob-field-inherited');
    const c3 = document.createElement('div'); c3.textContent = f.od;
    const c4 = document.createElement('div'); c4.className = 'mob-value';
    c4.textContent = f.field === 1 ? mobCurrentAidText(f.value, decoded.objType)
      : (f.field === 23 && descriptionLabel(f.value)) || mobFieldValueText(f.field, f.value);
    const c5 = document.createElement('div'); c5.className = 'mob-raw'; c5.textContent = f.raw;
    [c1, c2, c3, c4, c5].forEach(c => row.appendChild(c));
    table.appendChild(row);
  }
  container.appendChild(table);
}
