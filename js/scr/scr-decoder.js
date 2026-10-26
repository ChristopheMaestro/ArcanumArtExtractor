// .SCR decoding.
//
// Layout (game/script.c script_file_load_hdr() + script_file_load_code(), and
// game/script.h):
//   0x00  ScriptHeader   { uint32 flags; uint32 counters }          8 bytes
//   0x08  char description[40]
//   0x30  uint32 flags            (SF_* script flags)
//   0x34  int32  num_entries
//   0x38  int32  max_entries
//   0x3C  4 bytes (a stale pointer in the original file, skipped by the loader)
//   0x40  ScriptCondition entries[num_entries]                      0x84 bytes each
// ScriptCondition = { int type; uint8 op_type[8]; int op_value[8]; ScriptAction action; ScriptAction els }
// ScriptAction    = { int type; uint8 op_type[8]; int op_value[8] }  0x2C bytes

import { SCR_ACTIONS, SCR_CONDITIONS, SCR_FLAG_BITS } from './scr-schema.js';
import { sniffCodepage } from '../core/text-io.js';

export const SCR_HEADER_SIZE = 0x40;
export const SCR_ENTRY_SIZE = 0x84;
const SCR_ACTION_SIZE = 0x2C;

function readAction(view, bytes, o) {
  const opType = Array.from(bytes.subarray(o + 4, o + 12));
  const opValue = [];
  for (let i = 0; i < 8; i++) opValue.push(view.getInt32(o + 12 + i * 4, true));
  return { type: view.getInt32(o, true), opType, opValue };
}

export function decodeScrBuffer(buf, filename = '', { sniff = false } = {}) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  if (bytes.length < SCR_HEADER_SIZE) throw new Error(`file is too small to be a .scr (${bytes.length} bytes)`);

  const descEnd = bytes.indexOf(0, 8);
  const descBytes = bytes.subarray(8, descEnd >= 8 && descEnd < 48 ? descEnd : 48);
  const description = new TextDecoder(sniff ? sniffCodepage(descBytes) : 'windows-1252').decode(descBytes);   // (sniff: read-only callers, a Russian module's header is windows-1251)
  const numEntries = view.getInt32(0x34, true);
  const warnings = [];
  if (numEntries < 0) throw new Error(`invalid entry count ${numEntries}`);

  const available = Math.floor((bytes.length - SCR_HEADER_SIZE) / SCR_ENTRY_SIZE);
  let count = numEntries;
  if (numEntries > available) {
    warnings.push(`header says ${numEntries} entries but the file only holds ${available}; the game would fail to load it`);
    count = available;
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = SCR_HEADER_SIZE + i * SCR_ENTRY_SIZE;
    const cond = readAction(view, bytes, o);
    entries.push({
      line: i,
      type: cond.type, opType: cond.opType, opValue: cond.opValue,
      action: readAction(view, bytes, o + SCR_ACTION_SIZE),
      els: readAction(view, bytes, o + 2 * SCR_ACTION_SIZE),
    });
  }
  const end = SCR_HEADER_SIZE + count * SCR_ENTRY_SIZE;
  if (end < bytes.length && numEntries <= available) warnings.push(`${bytes.length - end} unused trailing bytes`);
  for (const e of entries) {
    if (!SCR_CONDITIONS[e.type]) warnings.push(`line ${e.line}: unknown condition type ${e.type}`);
    for (const a of [e.action, e.els]) if (!SCR_ACTIONS[a.type]) warnings.push(`line ${e.line}: unknown action type ${a.type}`);
  }

  const flags = view.getUint32(0x30, true);
  return {
    filename, size: bytes.length,
    initialFlags: view.getUint32(0, true),
    counters: [0, 1, 2, 3].map(i => bytes[4 + i]),
    description, flags, flagNames: scrFlagNames(flags),
    numEntries, maxEntries: view.getInt32(0x38, true),
    entries, warnings,
  };
}

export function scrFlagNames(flags) {
  return SCR_FLAG_BITS.filter(([mask]) => (flags & mask) !== 0).map(([, name]) => name);
}

// Script number the engine derives from the file name (script_name.c: atoi of the
// path), e.g. "01000praetor.scr" -> 1000.
export function scrNumberFromFilename(filename) {
  const n = parseInt(String(filename).replace(/^.*[\\/]/, ''), 10);
  return Number.isFinite(n) ? n : null;
}
