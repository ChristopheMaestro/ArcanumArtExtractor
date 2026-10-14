// .PRO decoding.

import { PRO_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import {
  enumerateMobFields,
  MOB_ENGINE,
  mobBitIsSet,
  mobHex,
  mobI32,
  readMobField,
} from '../mob/mob-decoder.js';
import { MOB_FIELD_NAMES, MOB_OD_NAMES, MOB_OD_TYPES, MOB_TYPE_LAST_FIELD } from '../mob/mob-schema.js';
import { protoDecodedCache } from './proto-explorer.js';

export function decodeProtoBuffer(buf, filename) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  if (bytes.length < 56) throw new Error('file is too small to be a valid .pro');

  let offset = 0;
  const version = mobI32(view, offset); offset += 4;
  if (version !== 119) throw new Error(`version=${version}, expected 119`);

  const protoOid = bytes.slice(offset, offset + 24); offset += 24;
  const objectOid = bytes.slice(offset, offset + 24); offset += 24;
  const objType = mobI32(view, offset); offset += 4;
  if (objType < 0 || objType >= MOB_TYPE_LAST_FIELD.length) {
    throw new Error(`unsupported object type ${objType}`);
  }

  const dwordCount = MOB_ENGINE.dwordCount[objType];
  if (!Number.isFinite(dwordCount) || dwordCount <= 0) throw new Error(`no field-bitmap schema for object type ${objType}`);
  if (offset + dwordCount * 4 > bytes.length) throw new Error('truncated available-field bitmap');

  const bitmap = [];
  for (let i = 0; i < dwordCount; i++) {
    bitmap.push(view.getUint32(offset, true));
    offset += 4;
  }
  const actualAvailable = bitmap.reduce((n, w) => n + ((w >>> 0).toString(2).match(/1/g) || []).length, 0);

  const fields = [];
  for (const fld of enumerateMobFields(objType)) {
    const fieldOffset = offset;
    const od = MOB_OD_TYPES[fld];
    const parsed = readMobField(view, bytes, offset, od);
    offset += parsed.size;
    fields.push({
      field: fld,
      name: MOB_FIELD_NAMES[fld] || `FIELD_${fld}`,
      od: MOB_OD_NAMES[od] || `OdType_${od}`,
      available: mobBitIsSet(bitmap, fld),
      change_idx: MOB_ENGINE.changeIdx[fld],
      bit: MOB_ENGINE.masks[fld] ? Math.round(Math.log2(MOB_ENGINE.masks[fld])) : -1,
      offset: fieldOffset,
      size: parsed.size,
      raw: mobHex(bytes.slice(fieldOffset, offset)),
      value: parsed.value
    });
  }

  return {
    filename,
    size: bytes.length,
    version,
    protoOid,
    objectOid,
    objType,
    bitmap,
    actualAvailable,
    fields,
    endOffset: offset,
    trailing: bytes.slice(offset)
  };
}

export async function decodeProtoForSearch(filename, relativePath = '') {
  const key = `${relativePath}\0${filename}`;
  if (protoDecodedCache.has(key)) return protoDecodedCache.get(key);
  const url = `${PRO_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`;
  const promise = fetch(url)
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      return resp.arrayBuffer();
    })
    .then(buf => decodeProtoBuffer(buf, filename));
  protoDecodedCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    protoDecodedCache.delete(key);
    throw err;
  }
}
