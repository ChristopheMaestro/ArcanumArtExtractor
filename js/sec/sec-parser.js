// .SEC static-object parsing.

import { errText } from '../core/text-io.js';
import { enumerateMobFields, MOB_ENGINE, mobBitIsSet, mobHex, readMobField } from '../mob/mob-decoder.js';
import { MOB_FIELD_NAMES, MOB_OD_NAMES, MOB_OD_TYPES, MOB_TYPE_LAST_FIELD } from '../mob/mob-schema.js';

// SEC static objects are loaded by sector_object_list.c::objlist_load().
// That routine reads the final int32 as the object count, seeks back to the
// object-list start, then calls obj_read() once per object. Do NOT call the
// MOB loader here: the SEC path is deliberately parsed independently even
// though obj_read() and the standalone .mob writer share the same object
// serialization primitives.
//
// The implementation below mirrors obj_read() / obj_inst_read_file() and
// obj_data_read_file_fast() from obj.c / obj_private.c: version, two 0x18-byte
// ObjectIDs, type, num_fields, type-specific change bitmap, then only the
// overridden fields in object_inst_enumerate_overridden_fields() order.
function decodeSecStaticObject(bytes, offset, limit, filename, index) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = offset;
  const need = n => {
    if (offset + n > limit) throw new Error(`truncated SEC object #${index} at 0x${offset.toString(16).toUpperCase()}`);
  };
  need(4 + 24 + 24 + 4 + 2);
  const version = view.getUint32(offset, true); offset += 4;
  if (version !== 119) throw new Error(`SEC object #${index}: object file version ${version}, expected 119`);
  const protoOid = bytes.slice(offset, offset + 24); offset += 24;
  const objectOid = bytes.slice(offset, offset + 24); offset += 24;
  const objType = view.getInt32(offset, true); offset += 4;
  const numFields = view.getInt16(offset, true); offset += 2;
  if (objType < 0 || objType >= MOB_TYPE_LAST_FIELD.length) throw new Error(`SEC object #${index}: unsupported object type ${objType}`);
  if (numFields < 0 || numFields > 10000) throw new Error(`SEC object #${index}: invalid num_fields ${numFields}`);

  // sub_40C030(object->type) determines the number of change-array dwords.
  const dwordCount = MOB_ENGINE.dwordCount[objType];
  need(dwordCount * 4);
  const bitmap = [];
  for (let i = 0; i < dwordCount; i++) { bitmap.push(view.getUint32(offset, true)); offset += 4; }

  const fields = [];
  for (const fld of enumerateMobFields(objType)) {
    if (!mobBitIsSet(bitmap, fld)) continue;
    const od = MOB_OD_TYPES[fld];
    const fieldOffset = offset;
    const parsed = readMobField(view, bytes, offset, od);
    offset += parsed.size;
    if (offset > limit) throw new Error(`SEC object #${index}: field ${fld} extends past object-list count`);
    fields.push({
      field: fld,
      name: MOB_FIELD_NAMES[fld] || `FIELD_${String(fld).padStart(3, '0')}`,
      od: MOB_OD_NAMES[od] || `OdType_${od}`,
      change_idx: MOB_ENGINE.changeIdx[fld],
      bit: MOB_ENGINE.masks[fld] ? Math.round(Math.log2(MOB_ENGINE.masks[fld])) : -1,
      offset: fieldOffset,
      size: parsed.size,
      raw: mobHex(bytes.slice(fieldOffset, offset)),
      value: parsed.value
    });
  }

  return {
    filename: `${filename}#object${index}`, size: offset - start, version, objType, numFields,
    actualSet: bitmap.reduce((n, w) => n + ((w >>> 0).toString(2).match(/1/g) || []).length, 0),
    bitmap, protoOid, objectOid, fields, endOffset: offset - start, trailing: new Uint8Array(0)
  };
}

function readSecStaticObjects(bytes, objectStart, filename) {
  if (objectStart < 0 || objectStart + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // objlist_load() reads the count by seeking to the final sizeof(int).
  const countPos = bytes.length - 4;
  const count = view.getInt32(countPos, true);
  if (count < 0 || count > 100000) return null;

  let offset = objectStart;
  const objects = [];
  for (let i = 0; i < count; i++) {
    const obj = decodeSecStaticObject(bytes, offset, countPos, filename, i);
    if (!obj || !Number.isInteger(obj.endOffset) || obj.endOffset <= 0) return null;
    offset += obj.endOffset;
    if (offset > countPos) return null;
    objects.push(obj);
  }
  // objlist_load() immediately reads the same final count and rejects if the
  // number of successfully read objects does not match it.
  if (offset !== countPos) {
    throw new Error(`SEC static object list ended at 0x${offset.toString(16).toUpperCase()}, expected final count at 0x${countPos.toString(16).toUpperCase()}`);
  }
  return { offset: objectStart, count, objects };
}

function parseSecStaticObjectList(bytes, tileEnd, filename) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = tileEnd;
  const readI32 = () => {
    if (offset + 4 > bytes.length) throw new Error('truncated SEC while reading static-object sections');
    const v = view.getInt32(offset, true); offset += 4; return v;
  };
  const skip = n => {
    if (n < 0 || offset + n > bytes.length) throw new Error('truncated SEC while skipping static-object sections');
    offset += n;
  };

  // sector_roof_list_load(): int empty, followed by 256 art IDs only when the
  // list is NOT empty. (The test used to be inverted, so every sector with an
  // empty roof list skipped 1 KB of object data and the wall list was lost.)
  const roofEmpty = readI32();
  // The 256 art IDs are a 16x16 grid of roof cells (each cell covers 4x4 tiles
  // of the sector), row-major.  Keep them so the viewer can draw the roofs.
  let roofArtIds = null;
  if (roofEmpty === 0) {
    if (offset + 256 * 4 > bytes.length) throw new Error('truncated SEC while reading the roof list');
    roofArtIds = new Uint32Array(256);
    for (let i = 0; i < 256; i++) roofArtIds[i] = view.getUint32(offset + i * 4, true);
    skip(256 * 4);
  }
  const roofListSize = offset - tileEnd;   // the whole roof section: the flag, plus the 256 ids when it is not empty

  // sector_load_editor(): placeholder determines which following sections exist.
  const placeholder = readI32();
  if (placeholder < 0xAA0000 || placeholder > 0xAA0004) {
    throw new Error(`invalid SEC placeholder 0x${(placeholder >>> 0).toString(16).toUpperCase()}`);
  }

  let blockMask = null;
  const tileScripts = [];
  let sectorInfo = null;
  // Script (script.h, 0x0C bytes): ScriptHeader { flags, counters } then the script number.
  const readScript = at => ({ flags: view.getUint32(at, true), counters: view.getUint32(at + 4, true), num: view.getInt32(at + 8, true) });
  if (placeholder !== 0xAA0000) {
    // tile_script_list_load(): count + 0x18-byte serialized nodes
    // { flags, id (tile: x | y << 6), Script, next }.
    const tileScriptCount = readI32();
    if (tileScriptCount < 0 || tileScriptCount > 100000) throw new Error(`invalid tile-script count ${tileScriptCount}`);
    if (offset + tileScriptCount * 0x18 > bytes.length) throw new Error('truncated SEC while reading the tile scripts');
    for (let i = 0; i < tileScriptCount; i++) {
      const at = offset + i * 0x18, tile = view.getUint32(at + 4, true);
      tileScripts.push({ flags: view.getUint32(at, true), tile, tileX: tile & 63, tileY: (tile >> 6) & 63, script: readScript(at + 8), next: view.getUint32(at + 0x14, true) });
    }
    skip(tileScriptCount * 0x18);
    sectorInfo = {};

    if (placeholder >= 0xAA0002) {
      // sector_script_list_load(): one Script for the whole sector.
      if (offset + 0x0C > bytes.length) throw new Error('truncated SEC while reading the sector script');
      sectorInfo.script = readScript(offset);
      skip(0x0C);
    }

    if (placeholder >= 0xAA0003) {
      // townmap_info, aptitude_adj, light_scheme (int each), then SectorSoundList
      // { flags, music_scheme_idx, ambient_scheme_idx } (sector_sound_list.h).
      if (offset + 24 > bytes.length) throw new Error('truncated SEC while reading the sector properties');
      sectorInfo.townmap = view.getInt32(offset, true);
      sectorInfo.aptitudeAdj = view.getInt32(offset + 4, true);
      sectorInfo.lightScheme = view.getInt32(offset + 8, true);
      sectorInfo.soundFlags = view.getUint32(offset + 12, true);
      sectorInfo.music = view.getInt32(offset + 16, true);
      sectorInfo.ambient = view.getInt32(offset + 20, true);
      skip(4 + 4 + 4 + 0x0C);
    }

    if (placeholder >= 0xAA0004) {
      // sector_block_list_load(): uint32_t mask[128] = 512 bytes, one bit per tile
      // (tile / 32, 1 << tile % 32; tile = y * 64 + x): the tiles the level designer
      // marked as blocked (tileblock_is_tile_blocked).
      if (offset + 128 * 4 > bytes.length) throw new Error('truncated SEC while reading the tile block list');
      blockMask = new Uint32Array(128);
      for (let i = 0; i < 128; i++) blockMask[i] = view.getUint32(offset + i * 4, true);
      skip(128 * 4);
    }
  }

  const objectList = readSecStaticObjects(bytes, offset, filename);
  if (!objectList) throw new Error(`could not decode static object list at 0x${offset.toString(16).toUpperCase()}`);
  return { ...objectList, placeholder, roofEmpty, roofArtIds, roofListOffset: tileEnd, roofListSize, blockMask, tileScripts, sectorInfo, objectListOffset: offset };
}

export function readSecTileData(buf, filename) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  if (bytes.length < 4) throw new Error('file is too small to contain a sector light count');
  const lightCount = view.getUint32(0, true);
  const tileOffset = 4 + lightCount * 0x30;
  const tileEnd = tileOffset + 4096 * 4;
  if (lightCount > 100000 || tileOffset < 4 || tileEnd > bytes.length) {
    throw new Error(`invalid sector layout: ${lightCount} light records would place the tile list at 0x${tileOffset.toString(16).toUpperCase()}`);
  }
  const tiles = new Uint32Array(4096);
  for (let i = 0; i < 4096; i++) {
    tiles[i] = view.getUint32(tileOffset + i * 4, true);
  }

  // Light records (LightSerializedData, 0x30 bytes, game/light.c): obj i64,
  // loc i64 (x = low dword, y = high dword), offset_x/y i32, flags u32,
  // art_id u32, then r, b, g bytes (in that order), tint, palette, padding.
  const lights = [];
  for (let i = 0; i < lightCount; i++) {
    const o = 4 + i * 0x30;
    lights.push({
      x: view.getUint32(o + 8, true), y: view.getUint32(o + 12, true),
      offsetX: view.getInt32(o + 0x10, true), offsetY: view.getInt32(o + 0x14, true),
      flags: view.getUint32(o + 0x18, true), artId: view.getUint32(o + 0x1C, true),
      r: bytes[o + 0x20], b: bytes[o + 0x21], g: bytes[o + 0x22]
    });
  }

  let objectList = null;
  let staticObjectError = null;
  try {
    objectList = parseSecStaticObjectList(bytes, tileEnd, filename);
  } catch (err) {
    staticObjectError = errText(err);
  }
  const staticObjects = objectList?.objects || [];
  return {
    filename, size: bytes.length, lightCount, lights, tileOffset, tiles,
    sourceBuffer: buf,
    staticObjectOffset: objectList?.offset ?? null,
    staticObjectCount: staticObjects.length,
    staticObjects,
    roofArtIds: objectList?.roofArtIds || null,
    roofListOffset: objectList?.roofListOffset ?? null,
    roofListSize: objectList?.roofListSize ?? null,
    blockMask: objectList?.blockMask || null,
    tileScripts: objectList?.tileScripts || [],
    sectorInfo: objectList?.sectorInfo || null,   // sector script, town map, aptitude, light scheme, sounds
    staticObjectError,
    staticObjectPlaceholder: objectList?.placeholder ?? null
  };
}
