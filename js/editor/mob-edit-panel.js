// The side panel of the editor's "Edit NPC / container" tool: the characteristics, flags, inventory and scripts of one
// .mob object. The bytes live in the record `rec` ({ name, bytes, orig, pt, shipped, kind }); every change rewrites them
// with mob-edit.js and tells the editor (ctx.changed) so that the file goes into the next export.
import { DATA_ROOT } from '../core/config.js';
import { mesTable } from '../core/text-io.js';
import { MOB_FLAG_BITS } from '../mob/mob-schema.js';
import { decodeMobBuffer } from '../mob/mob-decoder.js';
import { SCR_ATTACHMENT_POINTS } from '../scr/scr-schema.js';
import { decodeProtoForSearch } from '../proto/proto-decoder.js';
import { resolveMobPrototype, mobOidTypeAndNumber } from '../proto/proto-resolution.js';
import { ensureProtoArtMesLoaded } from '../proto/proto-mes.js';
import { loadProtoCurrentAidArt, protoArtObjectType, protoCurrentAidArtId } from '../proto/critter-aid.js';
import { buildInventoryBlock, forgetInventoryItem, inventoryItemByOid, registerInventoryItem } from '../sec/sec-inventory.js';
import { secProtoCatalog, secStartProtoScan } from './sec-writer.js';
import * as ME from './mob-edit.js';

const invenSourceMes = mesTable(`${DATA_ROOT}Rules/InvenSource.mes`);
const ATTRIBUTES = ['Strength', 'Dexterity', 'Constitution', 'Beauty', 'Intelligence', 'Perception', 'Willpower', 'Charisma'];
const ITEM_KINDS = [['all', 'All items'], [5, 'Weapons'], [6, 'Ammo'], [7, 'Armor'], [8, 'Gold'], [9, 'Food'], [10, 'Scrolls'], [11, 'Keys'], [12, 'Key rings'], [13, 'Written'], [14, 'Other']];
const FLAG_GROUPS = [
  { field: 19, name: 'Object flags', for: 'both' },
  { field: 280, name: 'NPC flags', for: 'npc' },
  { field: 218, name: 'Critter flags', for: 'npc' },
  { field: 56, name: 'Container flags', for: 'container' }
];
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, title, fn) => { const b = el('button', 'sec-me-btn', text); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };

const sizeCache = new Map();
// Cells (width, height) an item takes in an inventory: its inventory art, in 32 pixel cells (item.c item_inv_icon_size)
async function iconCells(protoDec, objType) {
  const key = protoDec.filename;
  if (sizeCache.has(key)) return sizeCache.get(key);
  let cells = [1, 1];
  try {
    const inv = protoDec.fields.find(f => f.field === 93 && f.available)?.value;
    const artId = protoCurrentAidArtId(inv, objType);
    const name = artId == null ? null : (await ensureProtoArtMesLoaded(objType, 0))?.get(artId);
    if (name) {
      const cv = document.createElement('canvas');
      await loadProtoCurrentAidArt(artId, name, cv, protoArtObjectType(inv, objType), inv);
      if (cv.nativeFrame) cells = [Math.max(1, Math.ceil(cv.nativeFrame.width / 32)), Math.max(1, Math.ceil(cv.nativeFrame.height / 32))];
    }
  } catch (_) { /* one cell */ }
  sizeCache.set(key, cells);
  return cells;
}

export function createMobEditPanel(host, ctx) {
  let rec = null, seq = 0, proto = null, others = [];
  let pending = 0, shownNotice = '';   // the script number of a dialog that waits for its NPC
  const root = el('div', 'sec-me'); host.appendChild(root);
  let scriptNames = null;
  const scriptIndex = () => scriptNames || (scriptNames = import('../scr/scr-explorer.js').then(m => m.getScrNumberIndex()).catch(() => new Map()));
  const scriptLabel = file => String(file || '').replace(/^\d+_?|\.scr$/gi, '');

  const objType = () => ME.mobOpen(rec.bytes).dec.objType;
  const isNpc = () => rec.kind === 'npcs';
  // Change the object: `edits` is a Map field -> bytes (see mobRewrite)
  const apply = edits => {
    rec.bytes = ME.mobRewrite(rec.bytes, edits);
    ctx.changed(rec);
  };

  // ---- small widgets ----
  const numberRow = (label, value, { min = 0, max = 999999, title = '' } = {}, onCommit) => {
    const row = el('label', 'sec-me-row'); row.title = title;
    const input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.value = value;
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v)) { input.value = value; return; }
      onCommit(v);
    });
    row.append(el('span', null, label), input);
    return { row, input };
  };

  // ---- characteristics ----
  function characteristics(sec, mob) {
    sec.append(el('h4', 'sec-me-h', 'Characteristics'));
    const grid = el('div', 'sec-me-grid');
    if (isNpc()) {
      const readout = el('div', 'sec-me-readout');
      const showHp = () => { readout.textContent = `Hit points (maximum): ${ME.maxHitPoints(ME.mobOpen(rec.bytes), proto)}`; };
      ATTRIBUTES.forEach((name, i) => {
        const { row } = numberRow(name, ME.statOf(mob, proto, i), { min: 1, max: 30, title: `${name} (the game keeps it between 1 and about 20; races go higher)` }, v => { apply(ME.editStat(ME.mobOpen(rec.bytes), proto, i, v)); showHp(); });
        grid.appendChild(row);
      });
      const more = [
        ['Level', ME.STAT.LEVEL, 1, 99], ['Alignment', ME.STAT.ALIGNMENT, -1000, 1000]
      ];
      for (const [name, idx, min, max] of more) {
        const { row } = numberRow(name, ME.statOf(mob, proto, idx), { min, max }, v => { apply(ME.editStat(ME.mobOpen(rec.bytes), proto, idx, v)); showHp(); });
        grid.appendChild(row);
      }
      const fields = [
        ['Hit point bonus', 28, -9999, 99999, 'F_HP_ADJ: added to the hit points the attributes and level give'],
        ['Armor class bonus', 26, -999, 999, 'F_AC'],
        ['Experience worth', 285, 0, 9999999, 'F_NPC_EXPERIENCE_WORTH: what killing it gives'],
        ['Faction', 292, 0, 9999, 'F_NPC_FACTION']
      ];
      for (const [name, f, min, max, title] of fields) {
        const { row } = numberRow(name, Number(ME.effective(mob, proto, f)) | 0, { min, max, title }, v => { apply(ME.editInt(proto, f, v)); if (f === 28) showHp(); });
        grid.appendChild(row);
      }
      sec.append(grid, readout);
      showHp();
    } else {
      const fields = [
        ['Lock difficulty', 57, 0, 999, 'F_CONTAINER_LOCK_DIFFICULTY: 0 = not locked by skill'],
        ['Key id', 58, 0, 99999, 'F_CONTAINER_KEY_ID: the key whose F_KEY_KEY_ID is the same opens it (0 = none)']
      ];
      for (const [name, f, min, max, title] of fields) {
        const { row } = numberRow(name, Number(ME.effective(mob, proto, f)) | 0, { min, max, title }, v => apply(ME.editInt(proto, f, v)));
        grid.appendChild(row);
      }
      sec.appendChild(grid);
    }
  }

  // ---- flags ----
  function flags(sec, mob) {
    const box = el('details', 'sec-me-flags');
    box.appendChild(el('summary', null, 'Flags (advanced)'));
    for (const g of FLAG_GROUPS) {
      if (g.for === 'npc' && !isNpc()) continue;
      if (g.for === 'container' && isNpc()) continue;
      const table = MOB_FLAG_BITS[g.field]; if (!table) continue;
      const cur = Number(ME.effective(mob, proto, g.field)) >>> 0;
      box.appendChild(el('h5', 'sec-me-h5', g.name));
      const list = el('div', 'sec-me-flaglist');
      for (const [mask, name] of table) {
        const label = el('label', 'sec-me-flag'); label.title = `${g.name}: 0x${(mask >>> 0).toString(16).toUpperCase()}`;
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = ((cur & mask) >>> 0) === (mask >>> 0);
        cb.addEventListener('change', () => apply(ME.editFlag(ME.mobOpen(rec.bytes), proto, g.field, mask | 0, cb.checked)));
        label.append(cb, ' ', name);
        list.appendChild(label);
      }
      box.appendChild(list);
    }
    sec.appendChild(box);
  }

  // ---- inventory ----
  const hexOf = oid => ME.bytesHex(oid);
  const kidsOfRec = () => ctx.kids.filter(k => k.owner === rec.name);
  function registerKid(kid) { registerInventoryItem(decodeMobBuffer(kid.bytes.slice().buffer, kid.name)); }
  function dropKid(kid) {
    const i = ctx.kids.indexOf(kid); if (i >= 0) ctx.kids.splice(i, 1);
    forgetInventoryItem(hexOf(kid.oid));
  }
  async function itemCells(kidObj) {
    try {
      const p = (await resolveMobPrototype(kidObj, ctx.cache)).decodedProto;
      return p ? await iconCells(p, kidObj.objType) : [1, 1];
    } catch (_) { return [1, 1]; }
  }

  async function addItem(it, qty, equip) {
    const mob = ME.mobOpen(rec.bytes), ot = mob.dec.objType, f = ME.invFields(ot);
    const pd = await decodeProtoForSearch(it.filename, it.relPath);
    const pget = n => pd.fields.find(x => x.field === n && x.available)?.value;
    const oids = ME.ownerOids(mob, ot);
    const existing = oids.map(o => inventoryItemByOid(hexOf(o))).filter(Boolean);
    // gold and ammo stack: the game keeps one stack of each, and a critter points at it
    let cacheField = null;
    if (ME.QTY_FIELD[it.objType]) {
      if (ot !== 2) cacheField = it.objType === 8 ? ME.CRITTER_STACK_FIELD.gold : ME.CRITTER_STACK_FIELD[Number(pget(143)) | 0];
      const has = existing.some(k => k.objType === it.objType && mobOidTypeAndNumber(k.protoOid)?.number === it.num)
        || (cacheField != null && typeof ME.effective(mob, proto, cacheField) === 'string' && ME.effective(mob, proto, cacheField) !== 'absent');
      if (has) return `It already carries ${it.label}: the game keeps one stack of it. Remove that one first.`;
    }
    const [w, h] = await iconCells(pd, it.objType);
    let slot = -1, worn = false;
    if (equip) {
      const want = it.objType === 5 ? ME.WEAR.weapon : it.objType === 7 ? ME.COVERAGE_SLOT[(Number(pget(93)) >>> 14) & 7] : null;
      if (want != null && !existing.some(k => Number(k.fields.find(x => x.field === 94)?.value) === want)) { slot = want; worn = true; }
    }
    if (slot < 0) {
      const used = [];
      for (const k of existing) {
        const loc = Number(k.fields.find(x => x.field === 94)?.value);
        if (Number.isFinite(loc) && loc >= 0 && loc < 1000) { const [kw, kh] = await itemCells(k); used.push([loc, kw, kh]); }
      }
      slot = ME.findFreeSlot(used, w, h, ot === 2 ? 96 : 12);
      if (slot < 0) return 'There is no room left in the inventory.';
    }
    const qtyField = ME.QTY_FIELD[it.objType];
    const kid = ME.buildInventoryItem({
      objType: it.objType, protoNum: it.num, parentOid: mob.dec.objectOid, loc: BigInt(ME.effective(mob, proto, 2)),
      slot, flags: Number(pget(19)) | 0, qty: qtyField ? Math.max(1, qty | 0) : null
    });
    kid.owner = rec.name; ctx.kids.push(kid); registerKid(kid);
    apply(ME.editInventory(ot, [...oids, kid.oid], cacheField != null ? new Map([[cacheField, ME.encHandle(kid.oid)]]) : null));
    return worn ? `${it.label} added and worn.` : `${it.label} added.`;
  }
  function removeKid(kid) {
    const mob = ME.mobOpen(rec.bytes), ot = mob.dec.objType;
    const oids = ME.ownerOids(mob, ot).filter(o => !ME.sameOid(o, kid.oid));
    const extra = new Map();
    for (const cf of Object.values(ME.CRITTER_STACK_FIELD)) {
      const c = mob.chunks.get(cf);
      if (c && ME.sameOid(c.subarray(1), kid.oid)) extra.set(cf, null);
    }
    dropKid(kid);
    apply(ME.editInventory(ot, oids, extra));
  }

  function inventory(sec, mob) {
    const ot = mob.dec.objType, f = ME.invFields(ot);
    sec.append(el('h4', 'sec-me-h', 'Inventory'));
    const listBox = el('div', 'sec-me-inv');
    const oids = ME.ownerOids(mob, ot);
    if (oids.length) {
      const block = buildInventoryBlock(oids.map(hexOf));
      const rows = block.querySelectorAll(':scope > .sec-inventory-list > .sec-inventory-item');
      oids.forEach((oid, i) => {
        const row = rows[i]; if (!row) return;
        const kid = kidsOfRec().find(k => ME.sameOid(k.oid, oid));
        const loc = Number(inventoryItemByOid(hexOf(oid))?.fields.find(x => x.field === 94)?.value);
        const tag = el('span', 'sec-me-slot', kid ? 'new' : 'already there');
        if (Number.isFinite(loc) && loc >= 1000 && loc <= 1008) tag.textContent += ' · worn';
        row.appendChild(tag);
        if (kid) row.appendChild(button('Remove', 'Take this item out of the inventory', () => { removeKid(kid); render(); }));
      });
      listBox.appendChild(block);
    } else listBox.appendChild(el('p', 'sec-me-none', 'Nothing in the inventory.'));
    sec.appendChild(listBox);

    // a random list the game rolls the inventory from
    const srcRow = el('label', 'sec-me-row sec-me-wide'); srcRow.title = 'InvenSource.mes: the game rolls the inventory from this list when the object is placed in the world';
    const select = el('select'); select.append(new Option('(none)', '0'));
    const srcNow = Number(ME.effective(mob, proto, f.source)) | 0;
    select.value = '0';
    srcRow.append(el('span', null, 'Random list'), select);
    invenSourceMes().then(t => {
      for (const [id, text] of t) { const name = String(text ?? '').split(':')[0].trim(); select.append(new Option(`${id} · ${name || 'unnamed'}`, String(id))); }
      select.value = [...select.options].some(o => o.value === String(srcNow)) ? String(srcNow) : '0';
    }).catch(() => {});
    select.addEventListener('change', () => { apply(ME.editInt(proto, f.source, Number(select.value) | 0)); render(); });
    sec.appendChild(srcRow);
    if (srcNow) sec.appendChild(el('p', 'sec-me-warn', 'The game also rolls items from this list, besides the ones above (the game\'s own NPCs often have both). Pick (none) to give it only the items you add.'));

    // add an item
    const add = el('div', 'sec-me-add');
    add.appendChild(el('h5', 'sec-me-h5', 'Add an item'));
    const kind = el('select'); kind.setAttribute('aria-label', 'Kind of item');
    for (const [v, n] of ITEM_KINDS) kind.append(new Option(n, String(v)));
    const search = el('input'); search.type = 'search'; search.placeholder = 'Search name or number…'; search.setAttribute('aria-label', 'Search items');
    const qty = el('input'); qty.type = 'number'; qty.min = 1; qty.max = 1000000000; qty.value = 1; qty.title = 'How many (gold, ammo)'; qty.className = 'sec-me-qty';
    const equipLabel = el('label', 'sec-me-flag'); const equip = el('input'); equip.type = 'checkbox';
    equipLabel.append(equip, ' Wear / wield it'); equipLabel.title = 'Weapons go in the hand, armor on the body part it covers (when that place is free)';
    const bar = el('div', 'sec-me-addbar'); bar.append(kind, search, qty);
    const results = el('div', 'sec-me-results'), msg = el('p', 'sec-me-msg');
    add.append(bar);
    if (ot !== 2) add.appendChild(equipLabel);
    add.append(results, msg);
    const fill = () => {
      results.replaceChildren();
      if (!secProtoCatalog.done) { secStartProtoScan(); results.appendChild(el('p', 'sec-me-none', `Scanning prototypes… ${secProtoCatalog.scanned}/${secProtoCatalog.total || '?'}`)); return; }
      const types = kind.value === 'all' ? [5, 6, 7, 8, 9, 10, 11, 12, 13, 14] : [Number(kind.value)];
      const q = search.value.trim().toLowerCase();
      let list = types.flatMap(t => secProtoCatalog.byType[t] || []);
      if (q) list = list.filter(i => i.label.toLowerCase().includes(q) || String(i.num).includes(q));
      list.sort((a, b) => a.label.localeCompare(b.label));
      for (const it of list.slice(0, 60)) {
        const b = el('button', 'sec-me-result'); b.type = 'button';
        b.append(el('span', null, it.label), el('em', null, `#${it.num}`));
        b.addEventListener('click', async () => {
          const mine = seq;
          msg.textContent = 'Adding…';
          try {
            const text = await addItem(it, Number(qty.value) || 1, equip.checked);
            if (mine !== seq) return;
            if (/added/.test(text)) { await render(); const m2 = root.querySelector('.sec-me-msg'); if (m2) m2.textContent = text; } else msg.textContent = text;
          } catch (err) { msg.textContent = `Could not add it: ${err?.message || err}`; }
        });
        results.appendChild(b);
      }
      if (list.length > 60) results.appendChild(el('p', 'sec-me-none', `${list.length - 60} more - type to narrow the list`));
      if (!list.length) results.appendChild(el('p', 'sec-me-none', 'No item matches.'));
    };
    kind.addEventListener('change', fill); search.addEventListener('input', fill);
    const listener = () => { if (rec && root.contains(results)) fill(); };
    secProtoCatalog.listeners.push(listener);
    root.__listener = listener;
    fill();
    sec.appendChild(add);
  }

  // ---- scripts ----
  async function scripts(sec, mob) {
    sec.append(el('h4', 'sec-me-h', 'Scripts'));
    const index = new Map(await scriptIndex());
    for (const [n, file] of ctx.extraScripts?.() || []) index.set(n, file);   // the dialogs made in this session
    const slots = ME.scriptSlots(mob, proto);
    const list = el('div', 'sec-me-scripts');
    const pointSelect = (value, taken) => {
      const s = el('select'); s.setAttribute('aria-label', 'Attachment point');
      SCR_ATTACHMENT_POINTS.forEach((n, i) => { const o = new Option(n.toLowerCase().replace(/_/g, ' '), String(i)); if (taken.has(i) && i !== value) o.disabled = true; s.append(o); });
      s.value = String(value); return s;
    };
    const nameOf = n => (index.get(n) ? scriptLabel(index.get(n)) : 'no such script');
    for (const [point, num] of [...slots].sort((a, b) => a[0] - b[0])) {
      const row = el('div', 'sec-me-script');
      const sel = pointSelect(point, slots);
      const input = el('input'); input.type = 'number'; input.min = 1; input.max = 99999; input.value = num; input.setAttribute('list', 'sec-me-scripts'); input.setAttribute('aria-label', 'Script number');
      const label = el('span', 'sec-me-scriptname', nameOf(num));
      sel.addEventListener('change', () => {
        apply(ME.editScript(ME.mobOpen(rec.bytes), proto, point, null));
        apply(ME.editScript(ME.mobOpen(rec.bytes), proto, Number(sel.value), Number(input.value) | 0));
        render();
      });
      input.addEventListener('change', () => {
        const v = Math.round(Number(input.value));
        if (!(v > 0)) { input.value = num; return; }
        apply(ME.editScript(ME.mobOpen(rec.bytes), proto, point, v));
        label.textContent = nameOf(v);
      });
      row.append(sel, input, label, button('Remove', 'Detach this script', () => { apply(ME.editScript(ME.mobOpen(rec.bytes), proto, point, null)); render(); }));
      list.appendChild(row);
    }
    if (!slots.size) list.appendChild(el('p', 'sec-me-none', 'No script is attached.'));
    sec.appendChild(list);
    // the list the number boxes offer
    {
      document.getElementById('sec-me-scripts')?.remove();
      const dl = el('datalist'); dl.id = 'sec-me-scripts';
      for (const [n, file] of [...index].sort((a, b) => a[0] - b[0])) { const o = el('option'); o.value = String(n); o.label = `${n} · ${scriptLabel(file)}`; o.textContent = o.label; dl.appendChild(o); }
      document.body.appendChild(dl);
    }
    const add = el('div', 'sec-me-script sec-me-script-new');
    const free = SCR_ATTACHMENT_POINTS.findIndex((_, i) => !slots.has(i) && i === 9) >= 0 ? 9 : SCR_ATTACHMENT_POINTS.findIndex((_, i) => !slots.has(i));
    const sel = pointSelect(free < 0 ? 0 : free, slots);
    const input = el('input'); input.type = 'number'; input.min = 1; input.max = 99999; input.placeholder = 'script #'; input.setAttribute('list', 'sec-me-scripts'); input.setAttribute('aria-label', 'New script number');
    const msg = el('span', 'sec-me-scriptname', 'pick a point and a script number');
    input.addEventListener('input', () => { const v = Math.round(Number(input.value)); msg.textContent = v > 0 ? nameOf(v) : 'pick a point and a script number'; });
    add.append(sel, input, msg, button('Attach', 'Attach this script at that point (a dialog needs "dialog")', () => {
      const v = Math.round(Number(input.value)), p = Number(sel.value);
      if (!(v > 0)) { msg.textContent = 'Type a script number first.'; return; }
      if (slots.has(p)) { msg.textContent = 'That point already has a script.'; return; }
      if (!index.get(v)) { msg.textContent = `There is no script ${v} in data/scr.`; return; }
      apply(ME.editScript(ME.mobOpen(rec.bytes), proto, p, v));
      render();
    }));
    sec.appendChild(add);
  }

  // ---- the whole panel ----
  async function render() {
    const mine = ++seq;
    if (root.__listener) { const i = secProtoCatalog.listeners.indexOf(root.__listener); if (i >= 0) secProtoCatalog.listeners.splice(i, 1); root.__listener = null; }
    if (!rec) { root.replaceChildren(el('p', 'sec-eye-head', pending ? `Click the NPC that will use dialog ${pending}.` : 'Click an NPC or a container on the map to edit it.')); return; }
    const keepScroll = host.scrollTop;
    const mob = ME.mobOpen(rec.bytes);
    try { proto = (await resolveMobPrototype(mob.dec, ctx.cache)).decodedProto; } catch (_) { proto = null; }
    if (mine !== seq) return;
    if (!proto) { root.replaceChildren(el('p', 'sec-eye-head', 'The prototype of this object could not be read, so it cannot be edited.')); return; }
    const frag = document.createDocumentFragment();
    // a dialog waits for its NPC (the Dialog tool's "Give it to an NPC"): the first NPC shown gets it at "dialog"
    let notice = '';
    if (pending && isNpc()) {
      const had = ME.scriptSlots(mob, proto).get(9);
      apply(ME.editScript(ME.mobOpen(rec.bytes), proto, 9, pending));
      notice = `Dialog ${pending} is now this NPC's dialog${had && had !== pending ? ` (it replaces script ${had})` : ''}.`;
      pending = 0; shownNotice = notice;
      return render();
    }
    if (pending && !isNpc()) notice = `Dialog ${pending} needs an NPC: click one.`;
    else if (shownNotice) notice = shownNotice;
    shownNotice = '';
    if (notice) frag.append(el('p', 'sec-me-banner', notice));
    const head = el('div', 'sec-me-head');
    // the name the game shows for its prototype (description.mes), else the one the map point has
    const named = (secProtoCatalog.byType[mob.dec.objType] || []).find(i => i.num === rec.protoNum)?.label;
    head.append(el('strong', null, named || rec.pt?.name || rec.name), el('span', null, `${isNpc() ? 'NPC' : 'Container'} · prototype #${rec.protoNum ?? '?'} · ${rec.name}`));
    const sub = el('div', 'sec-me-sub');
    sub.append(rec.shipped ? `From the map (${rec.name}). Your changes are exported as a replacement of that file.` : 'Placed in this session. It is exported with the other new .mob files.');
    const changed = ME.bytesHex(rec.bytes) !== ME.bytesHex(rec.orig) || kidsOfRec().length > 0;
    sub.appendChild(button('Undo all changes to this object', 'Put the object back as it was when you opened it (the items you added are dropped)', () => {
      for (const k of kidsOfRec()) dropKid(k);
      rec.bytes = rec.orig.slice(); ctx.changed(rec, true); render();
    }));
    sub.lastChild.disabled = !changed;
    frag.append(head, sub);
    if (others.length) {
      const o = el('div', 'sec-me-others'); o.append('Also near: ');
      for (const x of others) o.appendChild(button(x.label, 'Edit this one instead', x.pick));
      frag.appendChild(o);
    }
    const secs = { c: el('section', 'sec-me-sec'), f: el('section', 'sec-me-sec'), i: el('section', 'sec-me-sec'), s: el('section', 'sec-me-sec') };
    characteristics(secs.c, mob); flags(secs.f, mob); inventory(secs.i, mob);
    frag.append(secs.c, secs.f, secs.i, secs.s);
    root.replaceChildren(frag);
    host.scrollTop = keepScroll;
    await scripts(secs.s, mob);
  }

  return {
    // `near`: [{ label, pick() }] other objects close to the one clicked
    show(next, near = []) { rec = next; others = near; if (rec) rec.orig = rec.orig || rec.bytes.slice(); return render(); },
    clear() { rec = null; others = []; return render(); },
    current: () => rec,
    // the next NPC shown gets script `num` as its dialog
    expect(num) { pending = num; rec = null; others = []; return render(); },
    refresh: () => render()
  };
}
