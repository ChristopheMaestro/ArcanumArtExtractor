// Changing the .mob file of an NPC or a container: stats, flags, scripts and what it carries.
//
// A .mob stores only the fields the object overrides (see mob-decoder.js); every other one comes from its prototype.
// mobRewrite() keeps the bytes of every field it is not told to change and writes the record again, in the engine's
// field order, with a fresh change bitmap. What the game itself writes was checked against the shipped .mob files:
//  - an array is: presence 1 · element size · count · bitset id · the elements (in index order) · bitset size (dwords)
//    · the bitset. The bitset id is only a handle the game replaces while loading (sa.c sa_read_file), so any value does.
//  - an item in an inventory is its own G_<guid>.mob: OF_INVENTORY (0x1000) added to the prototype's F_FLAGS, F_LOCATION
//    of its owner, F_ITEM_PARENT (the owner's object id), F_ITEM_INV_LOCATION (the grid cell, or 1000-1008 when worn) and
//    F_LIGHT_AID / F_OVERLAY_LIGHT_AID (-1). The owner lists the item in its inventory list and counts it.
//  - a critter keeps a handle to its gold and to each kind of ammo it carries (F_CRITTER_GOLD / _ARROWS ...).
import { decodeMobBuffer, enumerateMobFields, MOB_ENGINE } from '../mob/mob-decoder.js';
import { secMobFileName, secNewGuid } from './sec-writer.js';

export const hexBytes = s => Uint8Array.from(String(s).trim().split(/\s+/).filter(Boolean), h => parseInt(h, 16));
export const bytesHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();
const cat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
export const encInt32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0, true); return b; };
export const encInt64 = big => { const b = new Uint8Array(9); b[0] = 1; new DataView(b.buffer).setBigInt64(1, BigInt.asIntN(64, big), true); return b; };
export const encHandle = oid => cat([Uint8Array.of(1), oid]);
let bitsetSeq = 40000;
// `entries`: Map index -> Uint8Array(elemSize)
export function encArray(elemSize, entries) {
  const idx = [...entries.keys()].sort((a, b) => a - b);
  const words = Math.max(2, Math.ceil(((idx.length ? idx[idx.length - 1] : 0) + 1) / 32));
  const head = new Uint8Array(13), dv = new DataView(head.buffer);
  head[0] = 1; dv.setInt32(1, elemSize, true); dv.setInt32(5, idx.length, true); dv.setInt32(9, bitsetSeq++, true);
  const bits = new Uint8Array(4 + words * 4), bv = new DataView(bits.buffer);
  bv.setInt32(0, words, true);
  for (const i of idx) bv.setUint32(4 + (i >> 5) * 4, (bv.getUint32(4 + (i >> 5) * 4, true) | (1 << (i & 31))) >>> 0, true);
  return cat([head, ...idx.map(i => entries.get(i)), bits]);
}

// bytes -> { dec (decodeMobBuffer), chunks (field -> its bytes), get(field) -> the decoded value or undefined }
export function mobOpen(bytes) {
  const dec = decodeMobBuffer(bytes.slice().buffer, 'x');
  const chunks = new Map(dec.fields.map(f => [f.field, bytes.slice(f.offset, f.offset + f.size)]));
  return { dec, chunks, bytes, get: n => dec.fields.find(f => f.field === n)?.value };
}
// The value of a field as the game sees it: the object's own, else its prototype's (a decoded .pro).
export function effective(mob, proto, n) {
  const v = mob.get(n);
  if (v !== undefined) return v;
  const pf = proto?.fields?.find(f => f.field === n && f.available);
  return pf ? pf.value : undefined;
}
export const protoHas = (proto, n) => !!proto?.fields?.some(f => f.field === n && f.available);

function assemble(header, objType, chunks) {
  const set = enumerateMobFields(objType).filter(f => chunks.has(f));
  const dwc = MOB_ENGINE.dwordCount[objType], bitmap = new Array(dwc).fill(0);
  for (const f of set) { const ci = MOB_ENGINE.changeIdx[f]; bitmap[ci] = (bitmap[ci] | MOB_ENGINE.masks[f]) >>> 0; }
  const size = 56 + 2 + dwc * 4 + set.reduce((n, f) => n + chunks.get(f).length, 0);   // header: version, two OIDs, type
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out.set(header.subarray(0, 56), 0);
  dv.setInt16(56, set.length, true);
  let o = 58;
  for (const w of bitmap) { dv.setUint32(o, w >>> 0, true); o += 4; }
  for (const f of set) { out.set(chunks.get(f), o); o += chunks.get(f).length; }
  return out;
}
// `edits`: Map field -> new bytes (as the file holds the field), or null to drop the override
export function mobRewrite(bytes, edits) {
  const m = mobOpen(bytes);
  for (const [f, v] of edits) { if (v == null) m.chunks.delete(f); else m.chunks.set(f, v); }
  return assemble(bytes, m.dec.objType, m.chunks);
}
function mobHeader(objType, protoNum, guid) {
  const h = new Uint8Array(56), dv = new DataView(h.buffer);
  dv.setUint32(0, 119, true);
  dv.setInt16(4, 1, true); dv.setUint32(12, protoNum >>> 0, true);          // prototype OID (type 1: numbered)
  dv.setInt16(28, 2, true); h.set(guid, 36);                                // object OID (type 2: GUID)
  dv.setInt32(52, objType, true);
  return h;
}

// ---- arrays ---------------------------------------------------------------------------------------------------------
// Map index -> the element's bytes, from a decoded array value (absent when it is not an array)
export function arrayEntries(value) {
  const out = new Map();
  if (value && typeof value === 'object') for (const e of value.elements || []) if (Number.isInteger(e.index)) out.set(e.index, hexBytes(e.raw));
  return out;
}
const i32At = (b, o = 0) => new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(o, true);

// ---- stats (F_CRITTER_STAT_BASE_IDX), indexed by the game's Stat enum -----------------------------------------------------
export const F_STAT_BASE = 220, STAT_COUNT = 28;
export const STAT = { STRENGTH: 0, DEXTERITY: 1, CONSTITUTION: 2, BEAUTY: 3, INTELLIGENCE: 4, PERCEPTION: 5, WILLPOWER: 6, CHARISMA: 7, LEVEL: 17, EXPERIENCE: 18, ALIGNMENT: 19 };
export function statEntries(mob, proto) {
  const e = arrayEntries(effective(mob, proto, F_STAT_BASE));
  for (let i = 0; i < STAT_COUNT; i++) if (!e.has(i)) e.set(i, encInt32(0));
  return e;
}
export const statOf = (mob, proto, i) => i32At(statEntries(mob, proto).get(i));
export function editStat(mob, proto, i, value) {
  const e = statEntries(mob, proto); e.set(i, encInt32(value));
  return new Map([[F_STAT_BASE, encArray(4, e)]]);
}
// the game's maximum hit points (object.c object_hp_max): F_HP_ADJ + 4 * F_HP_PTS + willpower + 2 * (strength + level) + 4
export function maxHitPoints(mob, proto) {
  const n = f => Number(effective(mob, proto, f)) | 0;
  return n(28) + 4 * n(27) + statOf(mob, proto, STAT.WILLPOWER) + 2 * (statOf(mob, proto, STAT.STRENGTH) + statOf(mob, proto, STAT.LEVEL)) + 4;
}

// ---- Int32 fields and flag bits ---------------------------------------------------------------------------------------
export function editInt(proto, field, value) {
  const pf = proto?.fields?.find(f => f.field === field && f.available);
  return new Map([[field, pf && (Number(pf.value) | 0) === (value | 0) ? null : encInt32(value)]]);
}
export function editFlag(mob, proto, field, mask, on) {
  const cur = Number(effective(mob, proto, field)) | 0;
  return editInt(proto, field, on ? (cur | mask) : (cur & ~mask));
}

// ---- scripts (F_SCRIPTS_IDX): one 12-byte element per attachment point = flags, counters, script number ------------------
export const F_SCRIPTS = 32;
export function scriptSlots(mob, proto) {
  const out = new Map();
  for (const [i, b] of arrayEntries(effective(mob, proto, F_SCRIPTS))) out.set(i, new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(8, true));
  return out;
}
// `num` null removes the script of that attachment point
export function editScript(mob, proto, point, num) {
  const e = arrayEntries(effective(mob, proto, F_SCRIPTS));
  if (num == null) e.delete(point);
  else { const b = (e.get(point) || new Uint8Array(12)).slice(); new DataView(b.buffer).setUint32(8, num >>> 0, true); e.set(point, b); }
  // (an emptied array stays written when the prototype has scripts, else they would come back)
  return new Map([[F_SCRIPTS, e.size || protoHas(proto, F_SCRIPTS) ? encArray(12, e) : null]]);
}

// ---- inventory ----------------------------------------------------------------------------------------------------------
export const INV = { critter: { list: 238, num: 237, source: 239 }, container: { list: 60, num: 59, source: 61 } };
export const invFields = objType => (objType === 2 ? INV.container : INV.critter);
export const WEAR = { weapon: 1004, shield: 1005, armor: 1006, helmet: 1000, gauntlets: 1007, boots: 1008, ring: 1001, medallion: 1003 };
// the armor coverage in the inventory art id (bits 14-16) -> where it is worn (read off the shipped .mob files)
export const COVERAGE_SLOT = [1006, 1005, 1000, 1007, 1008, 1001, 1003];
export const CRITTER_STACK_FIELD = { gold: 232, 0: 233, 1: 234, 2: 235, 3: 236 };   // F_CRITTER_GOLD, _ARROWS, _BULLETS, _POWER_CELLS, _FUEL
export const QTY_FIELD = { 6: 142, 8: 165 };
export const OF_INVENTORY = 0x1000;

export const ownerOids = (mob, objType) => {
  const e = arrayEntries(mob.get(invFields(objType).list));
  return [...e.keys()].sort((a, b) => a - b).map(i => e.get(i));
};
// The edits that make `oids` (Uint8Array(24) each) the owner's inventory
export function editInventory(objType, oids, extra = null) {
  const f = invFields(objType), edits = new Map(extra || []);
  if (!oids.length) { edits.set(f.list, null); edits.set(f.num, null); }
  else { edits.set(f.list, encArray(24, new Map(oids.map((o, i) => [i, o])))); edits.set(f.num, encInt32(oids.length)); }
  return edits;
}
export const sameOid = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// First free cell, row by row, for an item `w` x `h` cells (the grid is 10 wide: 12 rows on a critter, 96 in a container).
// `used`: [[cell, w, h], ...] of what lies in the grid already. -1 when there is no room.
export function findFreeSlot(used, w, h, rows) {
  const taken = new Set();
  for (const [cell, uw, uh] of used) for (let y = 0; y < uh; y++) for (let x = 0; x < uw; x++) taken.add(cell + y * 10 + x);
  for (let cell = 0; cell < rows * 10; cell++) {
    if ((cell % 10) + w > 10 || Math.floor(cell / 10) + h > rows) continue;
    let ok = true;
    for (let y = 0; y < h && ok; y++) for (let x = 0; x < w && ok; x++) if (taken.has(cell + y * 10 + x)) ok = false;
    if (ok) return cell;
  }
  return -1;
}

// The .mob of an item carried by `parentOid` (the owner's object id, 24 bytes) lying at `slot`.
// `flags`: the prototype's F_FLAGS; `qty` (gold, ammo): how many. Returns { name, bytes, oid, guid }.
export function buildInventoryItem({ objType, protoNum, parentOid, loc, slot, flags, qty = null }) {
  const guid = secNewGuid(), chunks = new Map();
  chunks.set(2, encInt64(BigInt(loc)));
  chunks.set(14, encInt32(-1));
  chunks.set(17, encArray(4, new Map([0, 1, 2, 3].map(i => [i, encInt32(-1)]))));
  chunks.set(19, encInt32((Number(flags) | OF_INVENTORY) | 0));
  chunks.set(88, encHandle(parentOid));
  chunks.set(94, encInt32(slot));
  if (qty != null && QTY_FIELD[objType]) chunks.set(QTY_FIELD[objType], encInt32(Math.max(1, qty | 0)));
  const oid = new Uint8Array(24); oid[0] = 2; oid.set(guid, 8);
  return { name: secMobFileName(guid), bytes: assemble(mobHeader(objType, protoNum, guid), objType, chunks), oid, guid };
}
