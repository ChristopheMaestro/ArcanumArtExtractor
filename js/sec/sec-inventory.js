// Inventories of NPCs and containers on SEC maps.
//
// The game never places the items an NPC carries or a container holds in the world: they carry
// OF_INVENTORY (0x1000) and the map loader skips them. They are still objects in the same .mob
// files / sector object lists, and the owner's inventory list (F_CRITTER_INVENTORY_LIST_IDX or
// F_CONTAINER_INVENTORY_LIST_IDX) holds their object ids. The loaders register every skipped item
// here, keyed by object id; the side bar then lists the items of the owner that was clicked.

import { DATA_ROOT } from '../core/config.js';
import { mesTable } from '../core/text-io.js';
import { mobHex } from '../mob/mob-decoder.js';
import { loadProtoCurrentAidArt, protoArtObjectType, protoCurrentAidArtId } from '../proto/critter-aid.js';
import { ensureProtoArtMesLoaded, loadDescriptionMes, protoDescriptionInfo } from '../proto/proto-mes.js';
import { resolveMobPrototype } from '../proto/proto-resolution.js';
import { mobObjectTypeName } from '../mob/mob-schema.js';

const F_FLAGS = 19, F_DESCRIPTION = 23, F_ITEM_WORTH = 91, F_AMMO_QUANTITY = 142, F_GOLD_QUANTITY = 165;
const F_CONTAINER_LIST = 60, F_CRITTER_LIST = 238;
const F_CONTAINER_SOURCE = 61, F_CRITTER_SOURCE = 239;
const invenSourceMes = mesTable(`${DATA_ROOT}Rules/InvenSource.mes`);
const OF_INVENTORY = 0x1000;
const MAX_DEPTH = 3;

const registry = new Map();   // object id (hex) -> decoded item object
const protoCache = new Map();

export const isInventoryItem = fields => {
  const flags = fields?.find(f => f.field === F_FLAGS);
  return !!flags && ((Number(flags.value) >>> 0) & OF_INVENTORY) !== 0;
};

export function registerInventoryItem(obj) {
  if (obj?.objectOid) registry.set(mobHex(obj.objectOid), obj);
}
export const inventoryItemByOid = hex => registry.get(hex) || null;
export const forgetInventoryItem = hex => { registry.delete(hex); };

// Object ids (hex strings) in the owner's inventory list, or null when it has none.
export function inventoryOidsOf(fields) {
  for (const n of [F_CONTAINER_LIST, F_CRITTER_LIST]) {
    const elements = fields?.find(f => f.field === n)?.value?.elements;
    if (elements?.length) return elements.map(e => e.raw);
  }
  return null;
}

// Number of the InvenSource.mes list that fills the owner's inventory at random, or 0 when it has none.
export function inventorySourceOf(fields) {
  for (const n of [F_CONTAINER_SOURCE, F_CRITTER_SOURCE]) {
    const v = Number(fields?.find(f => f.field === n)?.value);
    if (v > 0) return v;
  }
  return 0;
}

// The owner's inventory for the side bar: the items it carries and/or a note that more are rolled at random.
export function buildOwnerInventory(owner) {
  const oids = owner.inventoryOids?.length ? owner.inventoryOids : null;
  const source = owner.inventorySource || 0;
  if (!oids && !source) return null;
  const note = source ? `Randomized inventory (source #${source})` : '';
  const noteEl = note && Object.assign(document.createElement('div'), { className: 'sec-inventory-note', textContent: note });
  if (noteEl) {
    invenSourceMes().then(t => {
      const name = String(t.get(source) ?? '').split(':')[0].trim();
      if (name) noteEl.textContent = `Randomized inventory: ${name} (source #${source})`;
    }).catch(() => {});
  }
  if (!oids) return noteEl;
  const block = buildInventoryBlock(oids);
  if (noteEl) block.insertBefore(noteEl, block.querySelector('.sec-inventory-list'));
  return block;
}

const fieldValue = (obj, proto, n) => (obj.fields.find(f => f.field === n) || proto?.fields?.find(f => f.field === n))?.value;

async function describeItem(obj) {
  let proto = null;
  try { proto = (await resolveMobPrototype(obj, protoCache)).decodedProto; } catch (_) { /* name falls back to the file */ }
  let name = '';
  try {
    await loadDescriptionMes();
    const id = fieldValue(obj, proto, F_DESCRIPTION);
    name = (id != null && protoDescriptionInfo(id)?.text) || '';
  } catch (_) { /* no description.mes */ }
  if (!name) name = (proto?.filename || '').replace(/^\d+\s*-\s*/, '').replace(/\.pro$/i, '') || obj.filename || 'Unknown item';
  const quantity = fieldValue(obj, proto, F_GOLD_QUANTITY) ?? fieldValue(obj, proto, F_AMMO_QUANTITY);
  return { name, proto, quantity: Number(quantity) > 0 ? Number(quantity) : null, worth: fieldValue(obj, proto, F_ITEM_WORTH) };
}

// Inventory (icon) art of an item, as the .PRO viewer shows it.
async function drawItemIcon(obj, proto, canvas) {
  const aid = fieldValue(obj, proto, 1);
  const artId = protoCurrentAidArtId(aid, obj.objType);
  if (artId === null) return;
  const names = await ensureProtoArtMesLoaded(obj.objType, 0);
  const artName = names?.get(artId);
  if (artName) await loadProtoCurrentAidArt(artId, artName, canvas, protoArtObjectType(aid, obj.objType), aid);
}

// A foldable list of what `oids` (an owner's inventory list) holds. Rows fill in as names and icons load.
export function buildInventoryBlock(oids, depth = 0) {
  const block = document.createElement('details');
  block.className = 'sec-inventory';
  block.open = true;
  const summary = document.createElement('summary');
  summary.textContent = `Inventory (${oids.length})`;
  const list = document.createElement('div');
  list.className = 'sec-inventory-list';
  block.append(summary, list);

  for (const oid of oids) {
    const row = document.createElement('div');
    row.className = 'sec-inventory-item';
    const icon = document.createElement('canvas');
    icon.className = 'sec-inventory-icon'; icon.width = 40; icon.height = 40;
    const text = document.createElement('div');
    text.className = 'sec-inventory-text';
    row.append(icon, text);
    list.appendChild(row);

    const obj = registry.get(oid);
    if (!obj) { text.textContent = 'Item not found in the loaded .mob files'; row.classList.add('missing'); continue; }
    text.textContent = 'Loading…';
    describeItem(obj).then(info => {
      const strong = document.createElement('strong');
      strong.textContent = info.quantity ? `${info.name} × ${info.quantity}` : info.name;
      const meta = document.createElement('span');
      const bits = [mobObjectTypeName(obj.objType)];
      if (info.worth != null && Number(info.worth) > 0) bits.push(`worth ${info.worth}`);
      meta.textContent = bits.join(' · ');
      text.replaceChildren(strong, meta);
      drawItemIcon(obj, info.proto, icon).catch(() => {});
    });
    const inner = inventoryOidsOf(obj.fields);
    if (inner && depth < MAX_DEPTH) row.appendChild(buildInventoryBlock(inner, depth + 1));
  }
  return block;
}
