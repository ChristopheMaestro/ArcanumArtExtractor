// "Edit or erase a field" form of the .MOB hex view: pick a field (inherited from the prototype, already overridden, or
// not in the prototype), type a value, and the file is rewritten with that field set (mobRewrite keeps every other
// field's bytes). The hex view's "Export .mob" button saves the result.
import { decodeMobBuffer, enumerateMobFields, readMobField } from './mob-decoder.js';
import { MOB_FIELD_NAMES, MOB_OD_NAMES, MOB_OD_TYPES } from './mob-schema.js';
import { encArray, encInt32, encInt64, mobRewrite } from '../editor/mob-edit.js';
import { escapeHtml } from '../core/util.js';

const OD_INT32 = 3, OD_INT64 = 4, OD_STRING = 5, OD_PTR = 14;

function encString(text) {
  const out = new Uint8Array(1 + 4 + text.length + 1);
  out[0] = 1; new DataView(out.buffer).setInt32(1, text.length, true);
  for (let i = 0; i < text.length; i++) out[5 + i] = text.charCodeAt(i) & 255;   // latin1, as the decoder reads it
  return out;
}
// The field's bytes as the file holds them, from what was typed
function encodeValue(od, text) {
  const t = text.trim();
  if (od === OD_INT32) {
    if (!/^[-+]?(0x[0-9a-f]+|\d+)$/i.test(t)) throw new Error('Int32 needs a whole number (decimal or 0x hex)');
    return encInt32(Number(t));
  }
  if (od === OD_INT64) {
    if (!/^[-+]?(0x[0-9a-f]+|\d+)$/i.test(t)) throw new Error('Int64 needs a whole number (decimal or 0x hex)');
    return encInt64(BigInt(t[0] === '+' ? t.slice(1) : t));
  }
  if (od === OD_STRING) return encString(text);
  const digits = t.replace(/\s+/g, '');
  if (!digits || digits.length % 2 || /[^0-9a-f]/i.test(digits)) throw new Error('type the field\'s bytes as hex pairs, e.g. 00 or 01 0C 00 00 00 …');
  const out = Uint8Array.from(digits.match(/../g), h => parseInt(h, 16));   // "0000" = two bytes, as "00 00"
  // The bytes must be exactly one field of this type: an Int64 / string / handle / array starts with a presence byte,
  // and 00 there means "absent" and ends the field after that one byte.
  let size;
  try { size = readMobField(new DataView(out.buffer), out, 0, od).size; }
  catch (e) { throw new Error(`these bytes are not a complete ${MOB_OD_NAMES[od]} field (${e.message})`); }
  if (size !== out.length) throw new Error(`${MOB_OD_NAMES[od]} fields start with a presence byte: ${out[0] ? '' : '00 means absent, so the field is just "00". '}the field is ${size} byte${size === 1 ? '' : 's'} long, not ${out.length}`);
  return out;
}
// What the input starts with: the value of the field, as the same text encodeValue() reads back
function valueText(od, f) {
  if (!f) return od === OD_STRING ? '' : od === OD_INT32 || od === OD_INT64 ? '0' : '';
  if (od === OD_STRING) return typeof f.value === 'object' ? f.value.text : '';
  if (od === OD_INT32 || od === OD_INT64) return String(f.value);
  return f.raw;
}

// Erase: the field set to "nothing" while it is still stored, so the prototype's value no longer shows through.
// Numbers become 0, a string becomes empty, an array keeps its slots with every element zeroed (for scripts that is
// "script 0", which shipped mobs use for "no script"; an empty array is never written by the game).
// null when the field cannot be erased this way (handles, quest and handle arrays).
function eraseBytes(od, f) {
  if (od === OD_INT32) return encInt32(0);
  if (od === OD_INT64) return encInt64(0n);
  if (od === OD_STRING) return encString('');
  if (od >= 7 && od <= 11 && f && typeof f.value === 'object' && f.value.elements?.length) {
    const size = f.value.element_size, entries = new Map();
    for (const e of f.value.elements) if (Number.isInteger(e.index)) entries.set(e.index, new Uint8Array(size));
    return entries.size ? encArray(size, entries) : null;
  }
  return null;
}

// host: element to fill. proto: the decoded .pro (or null). selected: the field to start on. onSelect(field): the
// dropdown changed. onChange(bytes, field): the file was rewritten (field = the one set, or null).
export function mountOverrideForm(host, { decoded, bytes, filename, proto, selected, onSelect, onChange }) {
  const own = new Map(decoded.fields.map(f => [f.field, f]));
  const protoField = n => proto?.fields.find(f => f.field === n && f.available);
  const groups = { inherited: [], own: [], other: [] };
  for (const n of enumerateMobFields(decoded.objType)) {
    if (MOB_OD_TYPES[n] === OD_PTR) continue;
    (own.has(n) ? groups.own : protoField(n) ? groups.inherited : groups.other).push(n);
  }
  const opts = (label, list) => list.length ? `<optgroup label="${label}">${list.map(n =>
    `<option value="${n}">#${n} ${escapeHtml(MOB_FIELD_NAMES[n] || 'FIELD_' + n)} (${MOB_OD_NAMES[MOB_OD_TYPES[n]]})</option>`).join('')}</optgroup>` : '';
  host.innerHTML = `
    <div class="hex-analysis-title">Edit or erase a field <span class="hex-analysis-clickhint">${proto ? 'Inherited fields come from ' + escapeHtml(proto.filename) : 'Prototype not found: only the fields in this file and the unlisted ones are known'}</span></div>
    <div class="hex-override">
      <select class="hex-override-field">${opts('Inherited from the prototype', groups.inherited)}${opts('Already overridden here', groups.own)}${opts('Not in the prototype', groups.other)}</select>
      <input class="hex-override-value" type="text" spellcheck="false" placeholder="value">
      <button type="button" class="hex-override-apply">Set override</button>
      <button type="button" class="hex-override-erase" title="Store the field as nothing (0, empty, or zeroed entries) so the prototype's value no longer applies">Erase</button>
      <button type="button" class="hex-override-remove" title="Drop the field from this file: the prototype's value applies again">Remove override</button>
      <span class="hex-override-note"></span>
    </div>`;
  const sel = host.querySelector('.hex-override-field'), inp = host.querySelector('.hex-override-value');
  const note = host.querySelector('.hex-override-note'), rm = host.querySelector('.hex-override-remove'), er = host.querySelector('.hex-override-erase');
  if (selected != null && [...sel.options].some(o => Number(o.value) === selected)) sel.value = String(selected);
  const current = () => Number(sel.value);
  const refresh = () => {
    const n = current(), od = MOB_OD_TYPES[n], f = own.get(n) || protoField(n);
    inp.value = valueText(od, f);
    inp.placeholder = od === OD_STRING ? 'text' : od === OD_INT32 || od === OD_INT64 ? 'number (decimal or 0x hex)' : 'bytes in hex, the whole field';
    rm.disabled = !own.has(n);
    er.disabled = !eraseBytes(od, f);
    note.textContent = f ? '' : 'Not set anywhere: the starting value is empty';
  };
  sel.addEventListener('change', () => { refresh(); onSelect?.(current()); });
  const apply = (edit, added) => {
    try {
      const field = current();
      const next = mobRewrite(bytes, new Map([[field, edit()]]));
      decodeMobBuffer(next.slice().buffer, filename);   // must still decode
      onChange(next, added ? field : null);
    } catch (e) { note.textContent = e.message || String(e); }
  };
  host.querySelector('.hex-override-apply').addEventListener('click', () => apply(() => encodeValue(MOB_OD_TYPES[current()], inp.value), true));
  er.addEventListener('click', () => apply(() => eraseBytes(MOB_OD_TYPES[current()], own.get(current()) || protoField(current())), true));
  rm.addEventListener('click', () => apply(() => null));
  if (sel.options.length) refresh();
}
