// Object field readers shared by map overlays.

import { ART_TYPE, artType } from '../core/art-id.js';
import { mobLocationInfo } from '../mob/mob-decoder.js';
import { resolveMobPrototype } from '../proto/proto-resolution.js';

// Shared MOB-map artwork loader.  The standalone MOB map has its own
// loader, but the SEC viewer lives outside that function's scope.  Keep the
// same ART/MES resolution available to both viewers.
// Scenery (and any other 8-direction ART) stores one group of frames per
// rotation. The placed object's F_CURRENT_AID carries that rotation in bits
// 11-13 (same field the wall decoder uses), so the sprite has to come from
// that direction's group rather than from frames[0].
// F_OFFSET_X / F_OFFSET_Y (fields 3 and 4): signed pixel offsets the game
// adds to the tile-centre position of an object before subtracting the ART
// hotspot. This is what places an object "between" tiles.
function secFieldInt(fields, n) {
  const f = Array.isArray(fields) ? fields.find(x => x.field === n) : null;
  const v = f ? Number(f.value) : NaN;
  return Number.isFinite(v) ? v : null;
}
export async function secObjectPixelOffsets(obj, protoCache) {
  let ox = secFieldInt(obj.fields, 3), oy = secFieldInt(obj.fields, 4);
  if (ox === null || oy === null) {
    // Absent on the instance means "same as the prototype".
    try {
      const proto = await resolveMobPrototype(obj, protoCache);
      const pf = proto?.decodedProto?.fields;
      if (ox === null) ox = secFieldInt(pf, 3);
      if (oy === null) oy = secFieldInt(pf, 4);
    } catch (_) {}
  }
  return { offsetX: ox ?? 0, offsetY: oy ?? 0 };
}

// F_BLIT_SCALE (field 12): per-object sprite size in percent (100 = the ART's
// native size). Monster/NPC protos use it to make e.g. big or small variants
// share one ART file, so ignoring it draws every one at the generic size.
// A placed object that doesn't carry the field inherits the prototype's value.
// Returns a multiplier (1 = normal); 0 / negative / missing mean "unset" -> 1.
const BLIT_SCALE_NORMAL = 100;
export function blitScaleFactor(raw) {
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v / BLIT_SCALE_NORMAL : null;
}
export async function secObjectBlitScale(obj, protoCache) {
  let sc = blitScaleFactor(secFieldInt(obj.fields, 12));
  if (sc === null) {
    try {
      const proto = await resolveMobPrototype(obj, protoCache);
      sc = blitScaleFactor(secFieldInt(proto?.decodedProto?.fields, 12));
    } catch (_) {}
  }
  return sc ?? 1;
}

// F_FLAGS (field 19) and F_SCENERY_FLAGS (field 69). A placed object only stores
// the fields that differ from its prototype, so OF_FLAT (0x4), OF_SHRUNK (0x80),
// OSCF_UNDER_ALL (0x200) ... usually live ONLY in the .pro. The draw order
// (flats first, then upright objects) depends on OF_FLAT, so these have to be
// inherited exactly like the offsets and the scale are.
export async function secObjectFlagWords(obj, protoCache) {
  let of = secFieldInt(obj.fields, 19), scf = secFieldInt(obj.fields, 69);
  if (of === null || (obj.objType === 3 && scf === null)) {
    try {
      const proto = await resolveMobPrototype(obj, protoCache);
      const pf = proto?.decodedProto?.fields;
      if (of === null) of = secFieldInt(pf, 19);
      if (scf === null) scf = secFieldInt(pf, 69);
    } catch (_) {}
  }
  return { objFlags: (of ?? 0) >>> 0, sceneryFlags: (scf ?? 0) >>> 0 };
}

// F_SCRIPTS_IDX (field 32): the scripts attached to an object. The prototype's attachments are kept
// unless the object has its own in the same slot.
export async function secObjectScripts(obj, protoCache) {
  const slots = new Map();
  let pf = null;
  try { pf = (await resolveMobPrototype(obj, protoCache))?.decodedProto?.fields || null; } catch (_) {}
  for (const source of [pf, obj.fields]) {
    const f = Array.isArray(source) ? source.find(x => x.field === 32) : null;
    for (const e of f?.value?.elements || []) if (e.value && e.value.script_num) slots.set(e.index, e.value);
  }
  return [...slots.values()].map(s => ({ num: s.script_num, point: String(s.script_attachment || '').replace(/^SAP_/, '').replace(/_/g, ' ').toLowerCase() }));
}

// F_BLIT_FLAGS (field 9). Bit 0x10 is the additive blend: the flame sprites
// (TorchFlame, CampFire, ...) carry it, and their black background is meant to
// add nothing. Without it the sprite is drawn opaque and shows a black box.
export const SEC_BLIT_ADD = 0x10;
export async function secObjectBlitFlags(obj, protoCache) {
  let v = secFieldInt(obj.fields, 9);
  if (v === null) {
    try {
      const proto = await resolveMobPrototype(obj, protoCache);
      v = secFieldInt(proto?.decodedProto?.fields, 9);
    } catch (_) {}
  }
  return (v ?? 0) >>> 0;
}

// F_PORTAL_FLAGS (field 46): whether a door is jammed, held or always locked decides if an
// NPC can walk through it. Inherited from the prototype like the other flag words.
export async function secObjectPortalFlags(obj, protoCache) {
  if (obj.objType !== 1) return 0;
  let v = secFieldInt(obj.fields, 46);
  if (v === null) {
    try { v = secFieldInt((await resolveMobPrototype(obj, protoCache))?.decodedProto?.fields, 46); } catch (_) {}
  }
  return (v ?? 0) >>> 0;
}

// What makes an NPC walk around (game/ai.c ai_action_perform_non_combat): the route
// fields F_NPC_FLAGS (280), F_NPC_WAYPOINTS_IDX (287, array of locations),
// F_NPC_WAYPOINT_CURRENT (288) and F_NPC_STANDPOINT_DAY / _NIGHT (289 / 290). Each falls
// back to the prototype when the placed NPC does not carry it. Returns null when the
// NPC has nothing that could move it (no waypoints, no standpoint to go to or wander round).
export async function secObjectNpcMotion(obj, protoCache) {
  if (obj.objType !== 16) return null;
  const inst = Array.isArray(obj.fields) ? obj.fields : [];
  const has = n => inst.some(f => f.field === n && f.value !== 'absent' && f.value != null);
  let pf = null;
  if (![220, 280, 287, 288, 289, 290].every(has)) {
    try { pf = (await resolveMobPrototype(obj, protoCache))?.decodedProto?.fields || null; } catch (_) {}
  }
  const geti = n => { const v = secFieldInt(inst, n); return v !== null ? v : secFieldInt(pf, n); };
  const loc = v => {
    if (v === null || v === undefined || v === 'absent') return null;
    const info = mobLocationInfo(v);
    // Location 0 is "not set": the editor leaves unused standpoints at 0,0.
    return info && (info.worldX || info.worldY) ? { x: info.worldX, y: info.worldY } : null;
  };
  const getloc = n => {
    const f = inst.find(x => x.field === n && x.value !== 'absent' && x.value != null) || pf?.find(x => x.field === n);
    return f ? loc(f.value) : null;
  };
  const flags = (geti(280) ?? 0) >>> 0;
  const wpMap = secFieldArray(inst, 287) || secFieldArray(pf, 287);
  const waypoints = wpMap ? [...wpMap.entries()].sort((a, b) => a[0] - b[0]).map(e => loc(e[1])).filter(Boolean) : [];
  const standDay = getloc(289), standNight = getloc(290);
  if (!waypoints.length && !standDay && !standNight) return null;
  // STAT_SPEED is derived (stat_base_get): the dexterity (F_CRITTER_STAT_BASE_IDX[1], default 8)
  // plus 5 for an extraordinary one (20+). It sets how fast the walk animation ticks.
  const statsInst = secFieldArray(inst, 220), statsProto = secFieldArray(pf, 220);
  const dexRaw = statsInst?.has(1) ? statsInst.get(1) : statsProto?.get(1);
  const dex = Number.isFinite(Number(dexRaw)) && dexRaw != null ? Number(dexRaw) : 8;
  return { flags, waypoints, current: geti(288) ?? 0, standDay, standNight, speed: dex + (dex >= 20 ? 5 : 0) };
}

// Objects can carry lights too (game/light.c sub_4D9590, run for every object of a
// sector by sector_light_list_fold()): F_LIGHT_FLAGS / F_LIGHT_AID / F_LIGHT_COLOR
// (13-15) plus four overlay lights F_OVERLAY_LIGHT_* (16-18, arrays). Colour packs
// as 0xRRGGBB, and an AID of 0xFFFFFFFF means "no light". Fields missing on the
// placed object come from its prototype. Overlay lights are created with the main
// light's flags (| their overlay bit), exactly as the game does when it loads them.
function secFieldArray(fields, n) {
  const f = Array.isArray(fields) ? fields.find(x => x.field === n) : null;
  const v = f?.value;
  if (!v || typeof v !== 'object' || !Array.isArray(v.elements)) return null;
  const m = new Map();
  for (const e of v.elements) if (typeof e.index === 'number') m.set(e.index, e.value);
  return m;
}
export async function secObjectLightSources(obj, protoCache) {
  const inst = Array.isArray(obj.fields) ? obj.fields : [];
  const has = n => inst.some(f => f.field === n && f.value !== 'absent' && f.value != null);
  const wanted = [13, 14, 15, 16, 17, 18].concat(obj.objType === 3 ? [69] : []);
  let pf = null;
  if (!wanted.every(has)) {
    try { pf = (await resolveMobPrototype(obj, protoCache))?.decodedProto?.fields || null; } catch (_) {}
  }
  const geti = n => { const v = secFieldInt(inst, n); return v !== null ? v : secFieldInt(pf, n); };
  const arr = n => secFieldArray(inst, n) || secFieldArray(pf, n);
  const valid = aid => aid !== 0xFFFFFFFF && aid !== 0 && artType(aid) !== ART_TYPE.TILE;
  const unpack = c => { c = (c ?? 0) >>> 0; return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 }; };
  const sources = [];
  const mainFlags = (geti(13) ?? 0) >>> 0;
  const mainAid = geti(14);
  if (mainAid !== null && valid(mainAid >>> 0)) sources.push({ aid: mainAid >>> 0, flags: mainFlags, ...unpack(geti(15)), overlay: -1 });
  const aids = arr(17), cols = arr(18);
  if (aids) for (let i = 0; i < 4; i++) {
    if (!aids.has(i)) continue;
    const aid = Number(aids.get(i)) >>> 0;
    if (valid(aid)) sources.push({ aid, flags: mainFlags, ...unpack(cols?.get(i)), overlay: i });
  }
  return { sources, nocturnal: obj.objType === 3 && ((geti(69) ?? 0) & 0x4) !== 0 };
}
