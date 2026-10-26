// SEC editor helpers: prototype catalog, object builder, sector writer, facade helpers.

import { ART_TYPE } from '../core/art-id.js';
import { errText } from '../core/text-io.js';
import { parseArtBuffer } from '../art/art-decoder.js';
import { DATA_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import { enumerateMobFields, MOB_ENGINE, mobBitIsSet, readMobField } from '../mob/mob-decoder.js';
import { MOB_FIELD_NAMES, MOB_OD_TYPES } from '../mob/mob-schema.js';
import { decodeProtoForSearch } from '../proto/proto-decoder.js';
import { getProtoNumberIndex } from '../proto/proto-resolution.js';
import { loadDescriptionMes, protoDescriptionInfo } from '../proto/proto-mes.js';
import { SEC_GAME_PROTOS, SEC_GAME_SCENERY_TYPE } from './sec-game-protos.js';
import { secExtrasBytes, secExtrasDiffer } from './sec-sector-extras.js';
import {
  loadSecFacadeNames,
  secFacadeFileCache,
  secFacadeFileMissing,
} from '../sec/sec-tile-art.js';

// Walls (type 0), portals (type 1) and scenery (type 3) are instances of numbered
// prototypes (.pro). To offer them in a palette every prototype is decoded once,
// in the background, and sorted into buckets by object type. The objects that are filed as
// .mob (containers, items, NPCs) are listed too: their art need not be set by the prototype,
// and their label is the name the game shows (description.mes) rather than the file name.
const SEC_CATALOG_TYPES = [0, 1, 3, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16];
const SEC_CATALOG_WALL_TYPES = new Set([0, 1, 3]);      // (their entries need an art id, and keep the file name as label)
const SEC_QUANTITY_FIELD = { 6: 142, 8: 165 };          // ammo: F_AMMO_QUANTITY, gold: F_GOLD_QUANTITY
export const secProtoCatalog = { byType: Object.fromEntries(SEC_CATALOG_TYPES.map(t => [t, []])), scanned: 0, total: 0, done: false, started: false, error: null, listeners: [] };
function secProtoCatalogNotify() {
  for (const fn of secProtoCatalog.listeners.slice()) { try { fn(secProtoCatalog); } catch (e) { console.warn('prototype catalog listener failed:', e); } }
}
export function secStartProtoScan() {
  if (secProtoCatalog.started) return;
  secProtoCatalog.started = true;
  (async () => {
    try {
      try { await loadDescriptionMes(); } catch (_) { /* the labels are then the file names */ }
      const index = await getProtoNumberIndex();
      const entries = [...index.entries()].sort((a, b) => a[0] - b[0]);
      secProtoCatalog.total = entries.length;
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const [num, e] = entries[next++];
          try {
            const d = await decodeProtoForSearch(e.filename, e.relPath);
            const t = d.objType;
            const aidF = d.fields.find(f => f.field === 1);
            const fileLabel = e.filename.replace(/^\d+\s*-\s*/, '').replace(/\.pro$/i, '');
            if (SEC_CATALOG_WALL_TYPES.has(t)) {
              if (aidF != null && aidF.value != null) {
                secProtoCatalog.byType[t].push({
                  num, filename: e.filename, relPath: e.relPath, objType: t,
                  aid: Number(aidF.value) >>> 0,
                  label: fileLabel
                });
              }
            } else if (secProtoCatalog.byType[t]) {
              const descF = d.fields.find(f => f.field === 23), npcF = d.fields.find(f => f.field === 280);
              const qtyF = SEC_QUANTITY_FIELD[t] ? d.fields.find(f => f.field === SEC_QUANTITY_FIELD[t]) : null;
              const text = descF ? protoDescriptionInfo(descF.value)?.text : null;
              secProtoCatalog.byType[t].push({
                num, filename: e.filename, relPath: e.relPath, objType: t,
                aid: aidF != null && aidF.value != null ? Number(aidF.value) >>> 0 : null,
                label: text && String(text).trim() ? String(text).trim() : fileLabel, fileLabel,
                npcFlags: npcF ? Number(npcF.value) | 0 : 0,
                qty: qtyF ? Number(qtyF.value) | 0 : null          // (gold, ammo: how many the prototype holds)
              });
            }
          } catch (_) { /* unreadable prototype: skip */ }
          secProtoCatalog.scanned++;
          if (secProtoCatalog.scanned % 40 === 0) secProtoCatalogNotify();
        }
      };
      await Promise.all(Array.from({ length: 12 }, worker));
      for (const k of SEC_CATALOG_TYPES) secProtoCatalog.byType[k].sort((a, b) => a.num - b.num);
    } catch (err) {
      secProtoCatalog.error = errText(err);
    }
    secProtoCatalog.done = true;
    secProtoCatalogNotify();
  })();
}

// The key of an object's art in its .mes list: wall = structure.mes number, portal = portal.mes key (a window is its
// number + 1001), scenery = scenery.mes key (1000 * type + number).
export function secArtKey(objType, aid) {
  const a = aid >>> 0;
  if (objType === 0) return (a >>> 20) & 0xFF;
  if (objType === 1) return ((a >>> 19) & 0x1FF) + (((a >>> 10) & 1) ? 0 : 1001);
  if (objType === 3) return ((a >>> 6) & 0x1F) * 1000 + ((a >>> 19) & 0xFF);
  return null;
}
// How the game places an object of this art (sec-game-protos.js, read off the shipped sectors): { num, fields } - the
// prototype and the Int32 fields its objects set over it - or null when no map has it (scenery: then the prototype the
// game uses for that type of scenery, no fields). The art alone does not make an object behave: a bed needs 4045's
// OSCF_NO_AUTO_ANIMATE or its variants play as an animation, a table 4038's blocking, a window 2036 (jammed, see
// through) or it opens like a door - a generic prototype gets these wrong.
export function secGameProto(objType, aid) { return secGameProtoForKey(objType, secArtKey(objType, aid)); }
export function secGameProtoForKey(objType, k) {
  if (k == null) return null;
  const e = SEC_GAME_PROTOS[objType]?.[k];
  if (e) return { num: e[0], fields: e[1] || null };
  const n = objType === 3 ? SEC_GAME_SCENERY_TYPE[Math.floor(k / 1000)] : null;
  return n != null ? { num: n, fields: null } : null;
}

// Serialised static object with only F_CURRENT_AID (1) and F_LOCATION (2) set; every
// other field comes from the prototype. Mirrors decodeSecStaticObject() byte for byte:
// version 119 · proto OID (type 1 = numbered prototype) · object OID (type 0 = NULL) ·
// type · num_fields · change bitmap · Int32 (no presence byte) · Int64 (presence byte).
//
// Checked against all 421,797 static objects of the shipped sectors: num_fields (what
// obj_inst_write_file() writes from object->num_fields) always equals the number of
// set bits in the change bitmap, so a new object with two overrides has num_fields = 2
// (NOT the type's field count), and 99.7% of them carry a NULL object OID (type 0, as
// the game's own editor saves them); only 1,231 carry a GUID.
// `offset` ([x, y] pixels, optional): F_OFFSET_X / F_OFFSET_Y (3, 4, Int32), the sprite's shift from its tile's
// centre. Scenery is written the way the shipped sectors store it (1, 2, 3, 4 and F_AID 24 = the same art id,
// 199k of their 245k scenery objects): offsets even when zero, and a base art id that a few spells and scripts
// reset the object to. Walls and portals carry only 1 and 2, as in the game.
// `fields` ({ field: Int32 value }, optional): more fields set over the prototype - what the game's objects of that
// art set (secGameProto().fields: F_FLAGS, F_SCENERY_FLAGS, light...).
export function secBuildStaticObject(objType, protoNum, aid, locBig, offset = null, fields = null) {
  const scenery = objType === 3;
  const loc = BigInt.asIntN(64, locBig);
  const values = new Map([[1, aid | 0], [2, loc]]);
  if (scenery || (offset && (offset[0] || offset[1]))) { values.set(3, offset?.[0] | 0); values.set(4, offset?.[1] | 0); }
  if (scenery) values.set(24, aid | 0);
  for (const [f, v] of Object.entries(fields || {})) {
    const n = Number(f);
    if (n > 4 && n !== 24 && MOB_OD_TYPES[n] === 3) values.set(n, v | 0);     // (3 = Int32)
  }
  return secSerializeObject(objType, protoNum, values, null);
}

// The record both a sector's object list and a .mob file hold: version 119 · prototype OID · object OID · type ·
// num_fields · change bitmap · the fields set, in the engine's order (Int32: 4 bytes, no presence byte; Int64: a
// presence byte and 8 bytes). `values`: field -> Int32 number, or Int64 BigInt. `guid` (16 bytes, optional): the
// object OID is that GUID (the instances the game files as .mob), else NULL (the static objects of a sector).
function secSerializeObject(objType, protoNum, values, guid) {
  const set = enumerateMobFields(objType).filter(f => values.has(f)), numFields = set.length;   // in the engine's field order
  const wide = f => MOB_OD_TYPES[f] === 4;
  const dwc = MOB_ENGINE.dwordCount[objType];
  const bitmap = new Array(dwc).fill(0);
  for (const f of set) { const ci = MOB_ENGINE.changeIdx[f]; bitmap[ci] = (bitmap[ci] | MOB_ENGINE.masks[f]) >>> 0; }
  const size = 4 + 24 + 24 + 4 + 2 + dwc * 4 + set.reduce((n, f) => n + (wide(f) ? 9 : 4), 0);
  const bytes = new Uint8Array(size), dv = new DataView(bytes.buffer);
  const protoOid = new Uint8Array(24), objectOid = new Uint8Array(24);
  new DataView(protoOid.buffer).setInt16(0, 1, true);
  new DataView(protoOid.buffer).setUint32(8, protoNum >>> 0, true);
  if (guid) { new DataView(objectOid.buffer).setInt16(0, 2, true); objectOid.set(guid, 8); }
  let o = 0;
  dv.setUint32(o, 119, true); o += 4;
  bytes.set(protoOid, o); o += 24;
  bytes.set(objectOid, o); o += 24;
  dv.setInt32(o, objType, true); o += 4;
  dv.setInt16(o, numFields, true); o += 2;
  for (const w of bitmap) { dv.setUint32(o, w >>> 0, true); o += 4; }
  for (const f of set) {
    if (wide(f)) { bytes[o++] = 1; dv.setBigInt64(o, BigInt.asIntN(64, BigInt(values.get(f))), true); o += 8; }
    else { dv.setInt32(o, values.get(f), true); o += 4; }
  }
  return {
    filename: 'new object', size, version: 119, objType, numFields, actualSet: numFields, bitmap, protoOid, objectOid,
    fields: set.map(f => ({ field: f, name: MOB_FIELD_NAMES[f], od: wide(f) ? 'Int64' : 'Int32', value: wide(f) ? BigInt.asIntN(64, BigInt(values.get(f))).toString() : values.get(f) })),
    endOffset: size, trailing: new Uint8Array(0), __bytes: bytes, __new: true
  };
}

// ---- new .mob files -------------------------------------------------------------------------------------------------
// The game files every instance of a projectile, container, critter or item (obj_create_inst: they get a GUID) as
// G_<guid>.mob in its map's folder, and packs them into mobile.md when the map is first loaded (map_preprocess_mobile).
// What obj_create_inst sets is all a new one carries; the rest comes from its prototype. Checked against the shipped
// .mob files (data/maps): a ground item is its location and pixel offset; an NPC also its teleport destination and both
// standpoints on its tile, and its prototype's NPC flags with ONF_WAYPOINTS_DAY; a container is a location and offset.
export const SEC_MOB_KINDS = {
  items: { name: 'Ground items', types: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
  npcs: { name: 'NPCs', types: [16] },
  containers: { name: 'Containers', types: [2] }
};
const ONF_WAYPOINTS_DAY = 2;
// A random (version 4) GUID, in the byte order of the Windows GUID struct the game writes into a .mob.
export function secNewGuid() {
  const g = new Uint8Array(16);
  crypto.getRandomValues(g);
  g[7] = (g[7] & 0x0F) | 0x40;
  g[8] = (g[8] & 0x3F) | 0x80;
  return g;
}
// G_01234567_89AB_CDEF_0123_456789ABCDEF.mob, as the shipped files are named
export function secMobFileName(guid) {
  const h = i => guid[i].toString(16).padStart(2, '0').toUpperCase();
  return `G_${h(3)}${h(2)}${h(1)}${h(0)}_${h(5)}${h(4)}_${h(7)}${h(6)}_${h(8)}${h(9)}_${[10, 11, 12, 13, 14, 15].map(h).join('')}.mob`;
}
// `locBig`: the absolute F_LOCATION; `offset` ([x, y] pixels): the sprite's shift from its tile's centre;
// `npcFlags`: the prototype's F_NPC_FLAGS (an NPC only); `quantity`: how many coins or rounds (gold, ammo only; the
// shipped gold always sets it, as the prototype holds a single coin). Returns the decoded object, with .name (the
// file's name) and .__bytes (the file's content). `currentAid` (an NPC's art id, optional): F_CURRENT_AID (1), the art
// it is drawn with in place of its prototype's - how the game saves a critter in other clothes.
export function secBuildMobObject(objType, protoNum, locBig, { offset = null, npcFlags = 0, quantity = null, currentAid = null } = {}) {
  const loc = BigInt.asIntN(64, locBig);
  const values = new Map([[2, loc], [3, offset?.[0] | 0], [4, offset?.[1] | 0]]);
  if (currentAid != null) values.set(1, currentAid | 0);
  if (quantity != null && SEC_QUANTITY_FIELD[objType]) values.set(SEC_QUANTITY_FIELD[objType], Math.max(1, quantity | 0));
  if (objType === 16) {
    values.set(242, loc); values.set(289, loc); values.set(290, loc);          // teleport destination, standpoints (day, night)
    values.set(280, (npcFlags | ONF_WAYPOINTS_DAY) | 0);
  }
  const guid = secNewGuid(), obj = secSerializeObject(objType, protoNum, values, guid);
  obj.name = secMobFileName(guid); obj.filename = obj.name;
  return obj;
}

// The object `obj` (a static object of a sector, its bytes ready: secEnsureObjectBytes) moved to the absolute tile
// `locBig` (F_LOCATION): a copy with every other field as it was - prototype, art, offsets, flags, scripts. Null
// when it has no location of its own.
export function secObjectAt(obj, locBig) {
  const src = obj?.__bytes; if (!src) return null;
  const { at } = secObjectLayout(src);
  if (!at.has(2) || !src[at.get(2)]) return null;
  const bytes = src.slice(), loc = BigInt.asIntN(64, locBig);
  new DataView(bytes.buffer).setBigInt64(at.get(2) + 1, loc, true);
  return { ...obj, __bytes: bytes, __new: true, fields: (obj.fields || []).map(f => f.field === 2 ? { ...f, value: loc.toString() } : f) };
}

// Keep the original bytes of every object so a sector can be written back unchanged
// apart from the objects that were added or removed.
export function secEnsureObjectBytes(decoded) {
  if (decoded.__objBytesReady) return true;
  if (decoded.staticObjectOffset == null || !decoded.sourceBuffer) return false;
  const src = new Uint8Array(decoded.sourceBuffer);
  let off = decoded.staticObjectOffset;
  for (const obj of decoded.staticObjects) { obj.__bytes = src.slice(off, off + obj.size); off += obj.size; }
  decoded.__origObjects = decoded.staticObjects.slice();
  decoded.__objBytesReady = true;
  return true;
}
export function secObjectListDiffers(decoded) {
  const orig = decoded.__origObjects, cur = decoded.staticObjects;
  if (!orig) return false;
  if (orig.length !== cur.length) return true;
  for (let i = 0; i < cur.length; i++) if (orig[i] !== cur[i]) return true;
  return false;
}
// Lights: the sector's light records (LightSerializedData, 0x30 bytes, game/light.c), free-standing ones (obj 0) at
// a tile + pixel offset. `decoded.lights` is the list the editor works on: the original records carry `__idx` (their
// place in the file, so their bytes are kept as they are) and a new one has none. The original list is kept so the
// sector can be told apart from its unedited self (secLightsDiffer).
export function secEnsureLights(decoded) {
  if (!decoded.__origLights) {
    decoded.lights.forEach((l, i) => { l.__idx = i; });
    decoded.__origLights = decoded.lights.slice();
  }
  return decoded.lights;
}
export function secLightsDiffer(decoded) {
  const orig = decoded.__origLights, cur = decoded.lights;
  if (!orig) return false;
  if (orig.length !== cur.length) return true;
  for (let i = 0; i < cur.length; i++) if (orig[i] !== cur[i]) return true;
  return false;
}
// { x, y } (world tile), { offsetX, offsetY } (pixels), flags (light.h LF_*), artId, { r, g, b }. The engine works the
// tint colour out again when it loads the light (an LF_INDOOR / LF_OUTDOOR light takes the ambient colour then).
export function secLightBytes({ x, y, offsetX = 0, offsetY = 0, flags, artId, r, g, b }) {
  const rec = new Uint8Array(0x30), dv = new DataView(rec.buffer);
  dv.setUint32(8, x >>> 0, true); dv.setUint32(12, y >>> 0, true);
  dv.setInt32(0x10, offsetX, true); dv.setInt32(0x14, offsetY, true);
  dv.setUint32(0x18, flags >>> 0, true); dv.setUint32(0x1C, artId >>> 0, true);
  rec[0x20] = r; rec[0x21] = b; rec[0x22] = g;
  dv.setUint32(0x24, ((r << 16) | (g << 8) | b) >>> 0, true);
  return rec;
}
// Roofs: a 16 x 16 grid of cells (4 x 4 tiles each), an art id per cell. A sector without any
// roof stores just a flag (1); with roofs the flag is 0 and the 256 ids follow.
export const SEC_NO_ROOF = 0xFFFFFFFF;
export const secIsRoofId = v => ((v >>> 0) >>> 28) === ART_TYPE.ROOF;
// The roof grid of the sector, made editable (all cells empty when it had none). The original is
// kept so the sector can be told apart from its unedited self (secRoofsDiffer).
export function secEnsureRoofs(decoded) {
  if (!decoded.__roofsReady) {
    decoded.__origRoofs = decoded.roofArtIds ? Uint32Array.from(decoded.roofArtIds) : null;
    if (!decoded.roofArtIds) decoded.roofArtIds = new Uint32Array(256).fill(SEC_NO_ROOF);
    decoded.__roofsReady = true;
  }
  return decoded.roofArtIds;
}
export function secRoofsDiffer(decoded) {
  if (!decoded.__roofsReady) return false;
  const o = decoded.__origRoofs, c = decoded.roofArtIds;
  for (let i = 0; i < 256; i++) if ((c[i] >>> 0) !== (o ? o[i] >>> 0 : SEC_NO_ROOF)) return true;
  return false;
}
function secRoofSection(ids) {
  if (!ids.some(secIsRoofId)) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, 1, true); return b; }
  const b = new Uint8Array(4 + 256 * 4), dv = new DataView(b.buffer);
  dv.setInt32(0, 0, true);
  for (let i = 0; i < 256; i++) dv.setUint32(4 + i * 4, ids[i] >>> 0, true);
  return b;
}

// Field offsets inside one serialized static object (see decodeSecStaticObject): { objType, protoNum, at: Map field -> offset }.
const SEC_OBJ_BITMAP_AT = 4 + 24 + 24 + 4 + 2;
function secObjectLayout(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objType = view.getInt32(52, true);
  const protoNum = view.getInt16(4, true) === 1 ? view.getUint32(12, true) : null;
  const dwc = MOB_ENGINE.dwordCount[objType], bitmap = [];
  for (let i = 0; i < dwc; i++) bitmap.push(view.getUint32(SEC_OBJ_BITMAP_AT + i * 4, true));
  const at = new Map();
  let o = SEC_OBJ_BITMAP_AT + dwc * 4;
  for (const f of enumerateMobFields(objType)) {
    if (!mobBitIsSet(bitmap, f)) continue;
    at.set(f, o);
    o += readMobField(view, bytes, o, MOB_OD_TYPES[f]).size;
  }
  return { objType, protoNum, at, view };
}

// The prototype fields the engine's object order depends on (secEngineObjectOrder), for every prototype the
// objects of these sectors use: Map protoNum -> { 1, 3, 4, 19, 69 }. Pass it to secBuildSectorBytes.
const SEC_ORDER_FIELDS = [1, 3, 4, 19, 69];
export async function secLoadProtoOrderFields(decodedList) {
  const nums = new Set();
  for (const d of decodedList) for (const o of d.staticObjects || []) {
    const v = new DataView(o.protoOid.buffer, o.protoOid.byteOffset, 24);
    if (v.getInt16(0, true) === 1) nums.add(v.getUint32(8, true));
  }
  const index = await getProtoNumberIndex(), out = new Map();
  await Promise.all([...nums].map(async num => {
    const e = index.get(num);
    if (!e) throw new Error(`prototype ${num} was not found under /proto/`);
    const p = await decodeProtoForSearch(e.filename, e.relPath);
    const vals = {};
    for (const f of p.fields) if (SEC_ORDER_FIELDS.includes(f.field)) vals[f.field] = Number(f.value) | 0;
    out.set(num, vals);
  }));
  return out;
}

// sector_object_list.c sub_4F20A0: the order in which the engine keeps the objects of one tile. Flat objects
// first, a portal right after the wall of its edge, then by the screen position sub_4B93F0 makes of the sprite
// offset (walls and portals: a fixed 19 / -20 by rotation).
const OF_FLAT = 0x4, OSCF_UNDER_ALL = 0x200;
function secObjectSortKey(get, type) {
  let ox, oy;
  if (type === 0 || type === 1) { const rot = (get(1) >>> 11) & 7; ox = 0; oy = rot > 1 && rot < 6 ? 19 : -20; }
  else { ox = get(3); oy = get(4); }
  const v1 = Math.trunc((ox - 40) / 2), v2 = 2 * Math.trunc(oy / 2);
  return [v2 - v1, v1 + v2];
}
function secInsertEngineOrder(list, n) {
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (n.flags & OF_FLAT) {
      if (!(e.flags & OF_FLAT)) { list.splice(i, 0, n); return; }
      if (n.type === 3 && (n.sceneryFlags & OSCF_UNDER_ALL)) { list.splice(i, 0, n); return; }
    } else {
      if (n.type === 0 && e.type === 1) { list.splice(i, 0, n); return; }
      if (n.type === 1 && e.type === 0) { list.splice(i + 1, 0, n); return; }
    }
    if (!(e.flags & OF_FLAT) && (n.key[1] < e.key[1] || (n.key[1] === e.key[1] && n.key[0] < e.key[0]))) { list.splice(i, 0, n); return; }
  }
  list.push(n);
}

// Wall and portal art ids carry the mirror bits 0x11 exactly when the rotation is 2, 3, 6 or 7 (the axis whose
// picture is drawn flipped) - true of every one of the ~114,000 walls and portals of the shipped sectors. The game
// draws from these bits, so bits that disagree with the rotation show the other axis's image and palette.
const SEC_MIRROR_BITS = 0x11;
export function secEdgeAid(aid) {
  const a = aid >>> 0, t = a >>> 28;
  if (t !== ART_TYPE.WALL && t !== ART_TYPE.PORTAL) return a;
  return ((a & ~SEC_MIRROR_BITS) | (((a >>> 11) & 2) ? SEC_MIRROR_BITS : 0)) >>> 0;
}

// The bytes the game expects for one object of sector (sx, sy): its location absolute and inside the sector (a
// map's own N.sec is loaded with sector_id = -1, so nothing is moved for it - only terrain templates are), and
// wall / portal mirror bits that agree with the rotation. Also the facts its place in the engine order needs.
function secExportObject(objBytes, sx, sy, protoFields) {
  const { objType, protoNum, at, view } = secObjectLayout(objBytes);
  let bytes = objBytes;
  const patch = () => { if (bytes === objBytes) bytes = objBytes.slice(); return new DataView(bytes.buffer); };
  let tile = 0;
  if (at.has(2) && objBytes[at.get(2)]) {
    const p = at.get(2) + 1, x = view.getUint32(p, true), y = view.getUint32(p + 4, true);
    const nx = sx * 64 + (x & 63), ny = sy * 64 + (y & 63);
    if (nx !== x || ny !== y) { const v = patch(); v.setUint32(p, nx, true); v.setUint32(p + 4, ny, true); }
    tile = (ny & 63) * 64 + (nx & 63);
  }
  if (at.has(1)) {
    const aid = view.getUint32(at.get(1), true), fixed = secEdgeAid(aid);
    if (fixed !== aid) patch().setUint32(at.get(1), fixed, true);
  }
  const own = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const proto = protoNum != null ? protoFields?.get(protoNum) : null;
  const get = f => at.has(f) ? own.getInt32(at.get(f), true) : (proto?.[f] ?? 0);
  if (!proto && SEC_ORDER_FIELDS.some(f => !at.has(f) && (f !== 69 || objType === 3))) {
    throw new Error(`prototype ${protoNum} of a type ${objType} object is not loaded (secLoadProtoOrderFields)`);
  }
  return { bytes, changed: bytes !== objBytes, tile, type: objType, flags: get(19), sceneryFlags: objType === 3 ? get(69) : 0, key: secObjectSortKey(get, objType) };
}

// `position` { x, y }: the sector's place in the world (sector coordinates). `protoFields`: secLoadProtoOrderFields()
// of these sectors, needed whenever the object list has to be written again.
export function secBuildSectorBytes(decoded, { position, protoFields } = {}) {
  if (!decoded.sourceBuffer) throw new Error(`original bytes of ${decoded.filename} are not available`);
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) throw new Error(`${decoded.filename}: sector position is not known`);
  const sx = Number(position.x), sy = Number(position.y);
  let out = new Uint8Array(decoded.sourceBuffer.slice(0));
  // Lights added or taken away: the light list is written again and everything after it moves by the difference.
  let tileOffset = decoded.tileOffset, lightCount = decoded.lightCount | 0, shift = 0;
  if (secLightsDiffer(decoded)) {
    const recs = decoded.lights.map(l => l.__idx != null ? out.slice(4 + l.__idx * 0x30, 4 + (l.__idx + 1) * 0x30) : secLightBytes(l));
    const res = new Uint8Array(4 + recs.length * 0x30 + (out.length - decoded.tileOffset));
    new DataView(res.buffer).setInt32(0, recs.length, true);
    recs.forEach((r, i) => res.set(r, 4 + i * 0x30));
    res.set(out.subarray(decoded.tileOffset), 4 + recs.length * 0x30);
    shift = 4 + recs.length * 0x30 - decoded.tileOffset; tileOffset += shift; lightCount = recs.length; out = res;
  }
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4096; i++) dv.setUint32(tileOffset + i * 4, decoded.tiles[i] >>> 0, true);
  // Light records (0x30 bytes): loc at +8, x and y dwords - absolute and inside this sector, like the objects.
  for (let i = 0; i < lightCount; i++) {
    const p = 4 + i * 0x30 + 8;
    dv.setUint32(p, sx * 64 + (dv.getUint32(p, true) & 63), true);
    dv.setUint32(p + 4, sy * 64 + (dv.getUint32(p + 4, true) & 63), true);
  }
  let objectOffset = decoded.staticObjectOffset == null ? null : decoded.staticObjectOffset + shift;
  if (secRoofsDiffer(decoded)) {
    if (decoded.roofListOffset == null || decoded.roofListSize == null) throw new Error(`${decoded.filename}: roof list could not be located`);
    const roofAt = decoded.roofListOffset + shift;
    const section = secRoofSection(decoded.roofArtIds);
    const tail = out.subarray(roofAt + decoded.roofListSize);
    const res = new Uint8Array(roofAt + section.length + tail.length);
    res.set(out.subarray(0, roofAt), 0);
    res.set(section, roofAt);
    res.set(tail, roofAt + section.length);
    if (objectOffset != null) objectOffset += section.length - decoded.roofListSize;
    out = res;
  }
  // Tile scripts, sector properties and the block list changed: everything between the roof list and the object list is
  // written again (as the newest form), and the object list moves by the difference.
  if (secExtrasDiffer(decoded)) {
    if (objectOffset == null || decoded.roofListOffset == null || decoded.roofListSize == null) throw new Error(`${decoded.filename}: its tile scripts / block list could not be located`);
    const origLen = decoded.staticObjectOffset - (decoded.roofListOffset + decoded.roofListSize), at = objectOffset - origLen;
    const section = secExtrasBytes(decoded), tail = out.subarray(objectOffset);
    const res = new Uint8Array(at + section.length + tail.length);
    res.set(out.subarray(0, at), 0);
    res.set(section, at);
    res.set(tail, at + section.length);
    objectOffset = at + section.length;
    out = res;
  }
  if (objectOffset == null) {
    if (secObjectListDiffers(decoded)) throw new Error(`${decoded.filename}: object list could not be located`);
    return out;
  }
  secEnsureObjectBytes(decoded);
  const objs = decoded.staticObjects.map(o => secExportObject(o.__bytes, sx, sy, protoFields));
  if (!secObjectListDiffers(decoded) && !objs.some(o => o.changed)) return out;
  // Written in the order the engine keeps them (by tile, then sub_4F20A0): a save stores the changes of each object
  // in that order and reads them back in file order (objlist_load_with_difs), so any other order hands one
  // object's changes to another and the sector fails to load. Every shipped sector is stored this way.
  const heads = Array.from({ length: 4096 }, () => []);
  for (const o of objs) secInsertEngineOrder(heads[o.tile], o);
  const ordered = heads.flat();
  const head = out.subarray(0, objectOffset);
  const res = new Uint8Array(head.length + ordered.reduce((n, o) => n + o.bytes.length, 0) + 4);
  res.set(head, 0);
  let off = head.length;
  for (const o of ordered) { res.set(o.bytes, off); off += o.bytes.length; }
  new DataView(res.buffer).setInt32(off, ordered.length, true);
  return res;
}

// mapinfo.txt (map.c map_load_extension): "Key:value" lines, e.g. LightScheme:1 and SoundScheme:music,ambient.
// `changes` { Key: value } replaces those keys and keeps every other line of `original` as it is (a map that
// already exists keeps its own file); with no original the file is made from the changes alone. Bytes, CRLF.
export function secMapInfoBytes(original, changes) {
  const lines = String(original || '').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const left = new Map(Object.entries(changes || {}));
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].split(':')[0].trim();
    const hit = [...left.keys()].find(k => k.toLowerCase() === key.toLowerCase());
    if (hit) { lines[i] = `${key}:${left.get(hit)}`; left.delete(hit); }
  }
  for (const [k, v] of left) lines.push(`${k}:${v}`);
  return new TextEncoder().encode(lines.join('\r\n') + '\r\n');
}

// Facade ART file by facade number (shares secFacadeFileCache with loadSecFacadeArt).
export async function secFacadeFile(num) {
  const names = await loadSecFacadeNames();
  const name = names[num];
  if (!name) return null;
  const key = name.toLowerCase();
  if (secFacadeFileMissing.has(key)) return null;
  let promise = secFacadeFileCache.get(key);
  if (!promise) {
    promise = (async () => {
      try {
        const resp = await fetch(`${DATA_ROOT}art/facade/${encPath(name)}.art`);
        if (!resp.ok) return null;
        const frames = await parseArtBuffer(await resp.arrayBuffer());
        if (!frames.length || !frames[0]?.indices?.length) return null;
        return { frames, filename: `${name}.art`, facadeName: name };
      } catch (_) { return null; }
    })();
    secFacadeFileCache.set(key, promise);
  }
  const file = await promise;
  if (!file) { secFacadeFileMissing.add(key); return null; }
  return file;
}
export const SEC_FACADE_FIELD_MASK = (0xF0000000 | 1 | (0x3FF << 1) | (0xFF << 17) | (1 << 27)) >>> 0;
export function secMakeFacadeRaw(num, frame, walkable, keepBits) {
  return (((keepBits >>> 0) & ~SEC_FACADE_FIELD_MASK) | (ART_TYPE.FACADE << 28) | (walkable ? 1 : 0) |
    ((frame & 0x3FF) << 1) | ((num & 0xFF) << 17) | (((num >> 8) & 1) << 27)) >>> 0;
}

// Wall / portal / scenery art ids: rotation is bits 11-13; walls also carry the piece
// (14-19) and variation (8-9), see decodeWallArtId().
// Walls and portals also get the mirror bits of their rotation (secEdgeAid).
export function secAidWithRotation(aid, rotation) { return secEdgeAid((((aid >>> 0) & ~(7 << 11)) | ((rotation & 7) << 11)) >>> 0); }
export function secWallAid(baseAid, piece, rotation, variation) {
  const clear = (3 << 8) | (7 << 11) | (0x3F << 14);
  return secEdgeAid((((baseAid >>> 0) & ~clear) | ((variation & 3) << 8) | ((rotation & 7) << 11) | ((piece & 0x3F) << 14)) >>> 0);
}

// Tile edges. Direction 0..3 = NE, SE, SW, NW (a wall's rotation / 2). The neighbour
// across each edge, in world (x, y): NE = (x-1, y), SE = (x, y+1), SW = (x+1, y),
// NW = (x, y-1). An edge shared by two tiles gets one canonical key (NE / SE form).
export function secEdgeKey(x, y, dir) {
  if (dir === 2) return `${x + 1},${y},0`;
  if (dir === 3) return `${x},${y - 1},1`;
  return `${x},${y},${dir}`;
}
