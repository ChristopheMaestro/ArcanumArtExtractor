// What a .sec holds between its roof list and its object list (sector_load_editor): the placeholder, the tile scripts,
// the sector's script, its properties (town map, aptitude, light scheme, sounds) and the block list (one bit per tile,
// the tiles the level designer marked as blocked). The parser reads them into `decoded`; here they are made editable,
// told apart from their unedited selves, and written again - always as the newest form (0xAA0004), which every
// older sector can be upgraded to: what it lacked is empty.

export const SEC_PLACEHOLDER = 0xAA0004;
const defaultInfo = () => ({ script: { flags: 0, counters: 0, num: 0 }, townmap: 0, aptitudeAdj: 0, lightScheme: 0, soundFlags: 0, music: 0, ambient: 0 });

const signature = d => {
  const i = d.sectorInfo || {}, s = i.script || {};
  const mask = d.blockMask && d.blockMask.some(v => v) ? Array.from(d.blockMask).join(',') : '';
  return [(d.tileScripts || []).map(t => `${t.tile}:${t.flags}:${t.script.flags}:${t.script.counters}:${t.script.num}`).join(','),
    s.flags | 0, s.counters | 0, s.num | 0, i.townmap | 0, i.aptitudeAdj | 0, i.lightScheme | 0, i.soundFlags | 0, i.music | 0, i.ambient | 0, mask].join('|');
};

// Makes the sector's tile scripts, properties and block list editable (what it lacked is empty) and remembers how they were.
export function secEnsureExtras(decoded) {
  if (decoded.__extrasReady) return decoded;
  decoded.__origExtras = signature(decoded);
  const info = decoded.sectorInfo || {}, def = defaultInfo();
  decoded.sectorInfo = { ...def, ...info, script: { ...def.script, ...(info.script || {}) } };
  if (!decoded.blockMask) decoded.blockMask = new Uint32Array(128);
  if (!decoded.tileScripts) decoded.tileScripts = [];
  decoded.__extrasReady = true;
  return decoded;
}
export const secExtrasDiffer = decoded => !!decoded.__extrasReady && signature(decoded) !== decoded.__origExtras;

export const secTileBlocked = (decoded, idx) => !!decoded.blockMask && ((decoded.blockMask[idx >> 5] >>> (idx & 31)) & 1) === 1;
// Marks a tile blocked or open; false when it already was so.
export function secSetTileBlocked(decoded, idx, on) {
  secEnsureExtras(decoded);
  if (secTileBlocked(decoded, idx) === !!on) return false;
  decoded.blockMask[idx >> 5] = (decoded.blockMask[idx >> 5] ^ (1 << (idx & 31))) >>> 0;
  return true;
}

// The tile script of a tile ({ ...node } or undefined)
export const secTileScriptAt = (decoded, idx) => (decoded.tileScripts || []).find(t => t.tile === idx);
// Gives a tile a script (number 0 takes it away); returns the node it had before (or null) so a caller can undo this.
export function secSetTileScript(decoded, idx, num) {
  secEnsureExtras(decoded);
  const list = decoded.tileScripts, at = list.findIndex(t => t.tile === idx), before = at >= 0 ? list[at] : null;
  if (before && before.script.num === num) return { changed: false, before };
  if (before) list.splice(at, 1);
  if (num) list.push({ flags: 0, tile: idx, tileX: idx & 63, tileY: idx >> 6, script: { flags: 0, counters: 0, num: num | 0 }, next: 0 });
  return { changed: true, before };
}

// The bytes from the placeholder up to the object list: placeholder, tile-script count and nodes (0x18 bytes: flags,
// id, Script {flags, counters, number}, next), the sector's script, townmap / aptitude / light scheme, the sounds
// {flags, music, ambient}, the block list.
export function secExtrasBytes(decoded) {
  secEnsureExtras(decoded);
  const list = decoded.tileScripts, i = decoded.sectorInfo;
  const out = new Uint8Array(4 + 4 + list.length * 0x18 + 0x0C + 24 + 512), dv = new DataView(out.buffer);
  let o = 0;
  const u32 = v => { dv.setUint32(o, v >>> 0, true); o += 4; };
  const i32 = v => { dv.setInt32(o, v | 0, true); o += 4; };
  u32(SEC_PLACEHOLDER);
  i32(list.length);
  for (const t of list) { u32(t.flags); u32(t.tile); u32(t.script.flags); u32(t.script.counters); i32(t.script.num); u32(t.next || 0); }
  u32(i.script.flags); u32(i.script.counters); i32(i.script.num);
  i32(i.townmap); i32(i.aptitudeAdj); i32(i.lightScheme);
  u32(i.soundFlags); i32(i.music); i32(i.ambient);
  for (let k = 0; k < 128; k++) u32(decoded.blockMask[k]);
  return out;
}
