// The item info box, built the way the game's examine-item message window does it
// (Arcanum CE sources/ui/intgame.c: intgame_examine_item, format_weapon_stats, format_armor_stats).
//
//   name (blue when the item is magickal / technological)            Speed: N (weapons)
//   stats line - item_effect.mes text, or the D/FT/TH/RNG… or AC/DR/PR… summary
//   Magic power available: 100%                                        Ammo: consumption
//   Weight: N stone                                                    hp/hp
//
// Values that depend on the character holding the item (skill training, magic adjustments,
// identification) are shown for an identified item carried by an untrained owner.

import { DATA_ROOT } from '../core/config.js';
import { mesTable } from '../core/text-io.js';
import { loadDescriptionMes } from './proto-mes.js';
import { parseArtBuffer } from '../art/art-decoder.js';
import { drawText, loadGameFont } from './game-font.js';

const intgameMes = mesTable(`${DATA_ROOT}mes/intgame.mes`);
const itemEffectMes = mesTable(`${DATA_ROOT}mes/item_effect.mes`);
const itemMes = mesTable(`${DATA_ROOT}mes/item.mes`);
const interfaceMesTable = mesTable(`${DATA_ROOT}art/interface/interface.mes`);

const F = {
  description: 23, hpPts: 27, hpAdj: 28, hpDamage: 29, itemWeight: 89, complexity: 96, effects: 99,
  weaponBonusToHit: 114, weaponMagicHitAdj: 115, damageLower: 116, damageUpper: 117, damageMagicAdj: 118,
  speedFactor: 119, magicSpeedAdj: 120, range: 121, magicRangeAdj: 122, ammoType: 125, ammoConsumption: 126,
  ammoQuantity: 142, armorAc: 152, armorMagicAc: 153, resistance: 154, magicResistance: 155,
  silentMove: 156, magicSilentMove: 157, unarmedBonus: 158, goldQuantity: 165, genericFlags: 211, usageBonus: 212,
};
const OBJ_WEAPON = 5, OBJ_AMMO = 6, OBJ_ARMOR = 7, OBJ_GOLD = 8, OBJ_GENERIC = 14;
const NO_AMMO = 10000;

function fieldValue(decoded, num) {
  const f = decoded.fields.find(x => x.field === num);
  return f ? f.value : undefined;
}
const int = (decoded, num) => { const v = Number(fieldValue(decoded, num)); return Number.isFinite(v) ? v : 0; };
const element = (decoded, num, index) => {
  const v = fieldValue(decoded, num);
  const e = v && v.elements ? v.elements.find(x => x.index === index) : null;
  const n = e ? Number(e.value) : 0;
  return Number.isFinite(n) ? n : 0;
};

// One "D:3-6(+2)" style entry, exactly as append_stat() writes it.
function statText(label, min, max, adj, modifier) {
  if (!min && !max && !adj) return '';
  let s = `${label}:`;
  if (max) s += `${min}-${max}`;
  else if (min) s += modifier ? (min > 0 ? `+${min}` : `${min}`) : `${min}`;
  if (adj) s += `(${adj > 0 ? '+' : ''}${adj})`;
  return s + '  ';
}

function weaponStats(d, t) {
  const dmg = i => [element(d, F.damageLower, i), element(d, F.damageUpper, i), element(d, F.damageMagicAdj, i)];
  const range = int(d, F.range) === 1 ? 0 : int(d, F.range);
  return [
    statText(t(43), ...dmg(0), false),
    statText(t(44), ...dmg(4), false),
    statText(t(45), int(d, F.weaponBonusToHit), 0, int(d, F.weaponMagicHitAdj), true),
    statText(t(46), range, 0, int(d, F.magicRangeAdj), false),
    statText(t(47), ...dmg(1), false),
    statText(t(48), ...dmg(3), false),
    statText(t(49), ...dmg(2), false),
  ].join('');
}

function armorStats(d, t) {
  const res = i => [element(d, F.resistance, i), 0, element(d, F.magicResistance, i)];
  // RESISTANCE_TYPE_*: 0 normal, 1 fire, 2 electrical, 3 poison, 4 magic
  return [
    statText(t(50), int(d, F.armorAc), 0, int(d, F.armorMagicAc), false),
    statText(t(51), ...res(0), true),
    statText(t(52), ...res(3), true),
    statText(t(53), ...res(1), true),
    statText(t(54), ...res(2), true),
    statText(t(55), ...res(4), true),
    statText(t(56), int(d, F.silentMove), 0, int(d, F.magicSilentMove), true),
  ].join('');
}


// The icon the game draws in this box is an interface icon, not the item's inventory art:
// intgame_item_icon_get() picks interface.mes entry `num` from the item's type, subtype and
// magic / tech complexity (+1 magick, +2 tech).
const WEAPON_ICONS = [391, 391, 391, 391, 391, 391, 392, 391, 395, 391, 392, 391, 391, 391, 391];
const AMMO_ICONS = [398, 399, 400, 401];
const ARMOR_TYPE_ICONS = [402, 402, 405, 405, 405, 408, 405, 405, 402];
const ARMOR_COVERAGE_ICONS = [0, 405, 405, 405, 405, 411, 414];
const WRITTEN_ICONS = [428, 429, 431, 430, 428, 462, 428];
const TECH_HERBOLOGY = 0, TECH_CHEMISTRY = 1, TECH_THERAPEUTICS = 7;

function interfaceIconNumber(d, complexity) {
  const bump = complexity > 0 ? 1 : complexity < 0 ? 2 : 0;
  const useAid = int(d, 95) >>> 0, invAid = int(d, 93) >>> 0;
  const subtype = aid => (aid >>> 6) & 0xF;
  switch (d.objType) {
    case OBJ_WEAPON: return (WEAPON_ICONS[subtype(useAid)] ?? 391) + bump;
    case OBJ_AMMO: return AMMO_ICONS[int(d, 143)] ?? 398;
    case OBJ_ARMOR: {
      const coverage = (invAid >>> 14) & 0x7;
      const base = coverage === 0 ? ARMOR_TYPE_ICONS[subtype(useAid)] : ARMOR_COVERAGE_ICONS[coverage];
      return (base ?? 405) + bump;
    }
    case OBJ_GOLD: return 417;
    case 9: { // food
      if (complexity > 0) return 418;
      if (complexity < 0) {
        const discipline = int(d, 97);
        return discipline === TECH_HERBOLOGY ? 420 : discipline === TECH_CHEMISTRY ? 421 : discipline === TECH_THERAPEUTICS ? 419 : 423;
      }
      return 423;
    }
    case 10: return 425;
    case 11: return 426;
    case 12: return 427;
    case 13: return WRITTEN_ICONS[int(d, 202)] ?? 428;
    default: return 432 + bump;   // generic
  }
}

// An art/interface file, read once: the same few icons and bars serve every card of a folder.
// The canvas is only drawn from. A failed read is not kept, so the next card tries again.
const interfaceArt = new Map();   // file name -> Promise<canvas | null>
function interfaceIconArt(file) {
  let p = interfaceArt.get(file);
  if (!p) {
    p = (async () => {
      const resp = await fetch(`${DATA_ROOT}art/interface/${encodeURIComponent(file)}`);
      if (!resp.ok) { interfaceArt.delete(file); return null; }
      const frames = await parseArtBuffer(await resp.arrayBuffer(), 1);
      return frames[0]?.canvas ?? null;
    })();
    interfaceArt.set(file, p);
    p.catch(() => interfaceArt.delete(file));
  }
  return p;
}

async function loadInterfaceIcon(num, interfaceMes) {
  const file = interfaceMes.get(num);
  if (!file) return null;
  return interfaceIconArt(file.trim());
}

// Window geometry from intgame.c: the icon is blitted at (217, 69) and the text rectangles start at x = 290,
// 291 wide, at y = 63 (name), 87 (stats), 105 (power / ammo) and 123 (weight / hit points).
const ORIGIN = { x: 207, y: 55 };
const ICON_AT = { x: 217, y: 69 };
const RECTS = { name: { x: 290, y: 63, width: 291 }, stats: { x: 290, y: 87, width: 291 },
  extra: { x: 290, y: 105, width: 291 }, bottom: { x: 290, y: 123, width: 291 } };
const WHITE = [255, 255, 255], RED = [255, 0, 0], BLUE = [100, 100, 255];

// ---- the other kinds of object (intgame_examine_critter / scenery / portal / container) ----------
const OF_INVULNERABLE = 0x00400000, OPF_LOCKED = 1, OPF_JAMMED = 2, OPF_MAGICALLY_HELD = 4, OPF_NEVER_LOCKED = 8, OPF_BUSTED = 0x80;
const OCF_UNDEAD = 0x4, OCF_ANIMAL = 0x8, OCF_MONSTER = 0x8000, OCF_MECHANICAL = 0x20000000;
const STAT = { strength: 0, willpower: 6, level: 17, race: 27 };
// intgame_race_icons[RACE_*]
const RACE_ICONS = [375, 378, 376, 377, 379, 380, 381, 382, 376, 382, 381];
// BP_* containers (descriptions.h) are prototype number - 20: junk pile, safes, bin, body, altars, plant.
const CONTAINER_ICONS = new Map([[3043, 832], [3053, 834], [3054, 834], [3075, 835], [3076, 833], [3077, 837], [3078, 838], [3079, 839], [3080, 836]]);
const F_CRITTER_PORTRAIT = 231, F_NPC_LEADER = 281;
const OBJ_PORTAL = 1, OBJ_CONTAINER = 2, OBJ_SCENERY = 3, OBJ_PC = 15, OBJ_NPC = 16;

// What the game draws for these: an icon, the name, a few lines and for a critter two bars.
// `lines` = { text, rect, font: 'name' | 'body', color, align }; `bars` fill / empty interface art numbers.
function otherObjectSpec(d, t, descriptions) {
  const type = d.objType;
  // The game names an object by its description.mes entry; a placed object without one carries its own F_NAME.
  const ownName = fieldValue(d, 22);
  const name = descriptions.get(int(d, F.description)) || (typeof ownName === 'string' && ownName.trim()) || d.filename;
  const hpMax = int(d, F.hpPts) + int(d, F.hpAdj);
  const hpText = `${hpMax - int(d, F.hpDamage)}/${hpMax}`;
  const vulnerable = (int(d, 19) & OF_INVULNERABLE) === 0;
  const row = (y, height = 18) => ({ x: 290, y, width: 291, height });
  if (type === OBJ_SCENERY) {
    return { icon: 437, name, nameRect: row(63, 55), lines: vulnerable ? [{ text: hpText, rect: row(123), font: 'body', color: RED, align: 'right' }] : [] };
  }
  if (type === OBJ_PORTAL || type === OBJ_CONTAINER) {
    const flags = int(d, type === OBJ_PORTAL ? 46 : 56) >>> 0;
    let state = t(10);                                  // Unlocked
    if (flags & OPF_JAMMED) state = t(26);
    else if (flags & OPF_MAGICALLY_HELD) state = t(27);
    else if ((flags & OPF_LOCKED) && !(flags & (OPF_NEVER_LOCKED | OPF_BUSTED))) state = t(9);
    let icon;
    if (type === OBJ_PORTAL) icon = ((int(d, 1) >>> 10) & 1) === 0 ? 786 : 436;   // window / door
    else icon = CONTAINER_ICONS.get(d.protoNumber) ?? 435;
    const lines = [{ text: state, rect: row(123), font: 'body', color: RED, align: 'left' }];
    if (vulnerable || type === OBJ_PORTAL) lines.push({ text: hpText, rect: row(123), font: 'body', color: RED, align: 'right' });
    return { icon, name, nameRect: row(63), lines };
  }
  if (type === OBJ_NPC || type === OBJ_PC) {
    const flags = int(d, 218) >>> 0;
    const stat = i => element(d, 220, i);
    let icon = RACE_ICONS[stat(STAT.race)] ?? 375;
    if (flags & OCF_UNDEAD) icon = 384;
    else if (flags & OCF_MONSTER) icon = 383;
    else if (flags & OCF_ANIMAL) icon = 385;
    else if (flags & OCF_MECHANICAL) icon = 434;
    // Hit points of a critter: 4 per point, plus willpower + 2 (strength + level) + 4. A critter nobody has hurt
    // shows 100 %; the game prints a percentage for anyone but the player and their followers.
    const lines = [{ text: `${t(0)}: ${stat(STAT.level)}`, rect: row(87), font: 'body', color: WHITE, align: 'right' }];
    const hpMax = int(d, F.hpAdj) + 4 * int(d, F.hpPts) + stat(STAT.willpower) + 2 * (stat(STAT.strength) + stat(STAT.level)) + 4;
    const hpPct = hpMax > 0 ? Math.max(0, Math.min(100, Math.floor(100 * (hpMax - int(d, F.hpDamage)) / hpMax))) : 100;
    lines.push({ text: `${hpPct}%`, rect: row(105), font: 'body', color: RED, align: 'right' });
    lines.push({ text: '100%', rect: row(123), font: 'body', color: BLUE, align: 'right' });
    // intgame_examine_portrait: the portrait replaces the race icon for a PC and for an NPC following the player.
    const leader = fieldValue(d, F_NPC_LEADER);
    const follows = typeof leader === 'string' && leader !== 'absent' && !leader.startsWith('NULL');
    // The portraits made for one NPC (NPCVirg.bmp, ...) are always shown, whoever follows whom.
    const portrait = int(d, F_CRITTER_PORTRAIT) >= 1000 ? int(d, F_CRITTER_PORTRAIT) : 0;
    return { icon, portrait, portraitAlways: type === OBJ_PC || follows, name, nameRect: row(63), lines, bars: [{ fill: 463, empty: 464, rect: row(105), pct: hpPct }, { fill: 465, empty: 466, rect: row(123), pct: 100 }] };
  }
  return null;
}

const OTHER_TYPES = new Set([OBJ_PORTAL, OBJ_CONTAINER, OBJ_SCENERY, OBJ_NPC, OBJ_PC]);

const gameportMes = mesTable(`${DATA_ROOT}portrait/gameport.mes`);
// portrait/gameport.mes numbers a portrait (1000 and up) and names its .bmp (portrait_path).
async function portraitFile(num, always) {
  const name = (await gameportMes()).get(num);
  return name && (always || /^NPC/i.test(name.trim())) ? `${name.trim()}.bmp` : null;
}
async function loadPortrait(num, always) {
  const file = await portraitFile(num, always);
  if (!file) return null;
  const img = new Image();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = `${DATA_ROOT}portrait/${encodeURIComponent(file)}`; });
  return img;
}

// Where the picture of the info box comes from: { kind: 'portrait', url, file } or { kind: 'interface', url, file, num }
// (the file under art/interface), null when the game draws no box. `decoded` as for buildItemCard.
export async function cardIconSource(decoded) {
  const [intgame, descriptions, interfaceMes] = await Promise.all([
    intgameMes().catch(() => new Map()), loadDescriptionMes().catch(() => new Map()), interfaceMesTable().catch(() => new Map()),
  ]);
  const type = decoded.objType;
  let num;
  if (OTHER_TYPES.has(type)) {
    const spec = otherObjectSpec(decoded, n => intgame.get(n) ?? '', descriptions);
    if (!spec) return null;
    num = spec.icon;
    const file = spec.portrait ? await portraitFile(spec.portrait, spec.portraitAlways).catch(() => null) : null;
    if (file) return { kind: 'portrait', file, url: `${DATA_ROOT}portrait/${encodeURIComponent(file)}` };
  } else if (type >= 5 && type <= 14) {
    num = interfaceIconNumber(decoded, int(decoded, F.complexity));
  } else return null;
  const file = interfaceMes.get(num)?.trim();
  return file ? { kind: 'interface', num, file, url: `${DATA_ROOT}art/interface/${encodeURIComponent(file)}` } : null;
}

// The picture itself (a canvas or an image), at its real size.
export async function loadCardIcon(source) {
  if (!source) return null;
  if (source.kind === 'interface') {
    // a copy of the shared canvas: the caller puts it in the page
    const art = await interfaceIconArt(source.file);
    if (!art) return null;
    const copy = document.createElement('canvas');
    copy.width = art.width; copy.height = art.height;
    if (copy.width && copy.height) copy.getContext('2d').drawImage(art, 0, 0);
    return copy;
  }
  const img = new Image();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = source.url; });
  return img;
}

async function drawSpec(spec, fonts, interfaceMes) {
  const portrait = spec.portrait ? await loadPortrait(spec.portrait, spec.portraitAlways).catch(() => null) : null;
  const icon = portrait || await loadInterfaceIcon(spec.icon, interfaceMes).catch(() => null);
  const bars = await Promise.all((spec.bars || []).map(async b => ({ ...b, fillArt: await loadInterfaceIcon(b.fill, interfaceMes).catch(() => null), emptyArt: await loadInterfaceIcon(b.empty, interfaceMes).catch(() => null) })));
  const canvas = document.createElement('canvas');
  canvas.className = 'item-card';
  canvas.width = 384;
  canvas.height = Math.max(96, ICON_AT.y - ORIGIN.y + (icon ? icon.height : 0) + 12);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  if (icon) ctx.drawImage(icon, ICON_AT.x - ORIGIN.x, ICON_AT.y - ORIGIN.y);
  const at = r => ({ ...r, x: r.x - ORIGIN.x, y: r.y - ORIGIN.y });
  // sub_554640: the filled part of the bar on the left, the rest of the empty bar on its right.
  for (const b of bars) {
    const r = at(b.rect), v = b.pct;
    if (b.fillArt && v > 0) { const w = Math.min(b.fillArt.width, Math.floor(v * b.fillArt.width / 100) + (v < 100 ? 1 : 0)); ctx.drawImage(b.fillArt, 0, 0, w, b.fillArt.height, r.x, r.y, w, b.fillArt.height); }
    if (b.emptyArt && v !== 100) { const w = Math.floor(b.emptyArt.width * (100 - v) / 100), x0 = b.emptyArt.width - w; ctx.drawImage(b.emptyArt, x0, 0, w, b.emptyArt.height, r.x + x0, r.y, w, b.emptyArt.height); }
  }
  drawText(ctx, fonts.name, spec.name, at(spec.nameRect), spec.nameColor || WHITE);
  for (const l of spec.lines) drawText(ctx, fonts[l.font], l.text, at(l.rect), l.color, l.align);
  return canvas;
}

// Resolves to the finished element: a canvas drawn with the game's own icon and fonts.
// `decoded` = { objType, fields, filename, protoNumber? } where the fields are the object's effective ones.
export async function buildItemCard(decoded) {
  const [intgame, effects, items, descriptions, interfaceMes, nameFont, bodyFont] = await Promise.all([
    intgameMes().catch(() => new Map()), itemEffectMes().catch(() => new Map()),
    itemMes().catch(() => new Map()), loadDescriptionMes().catch(() => new Map()),
    interfaceMesTable().catch(() => new Map()),
    loadGameFont('morph15font.art'), loadGameFont('Flare12Font.art'),
  ]);
  const t = n => intgame.get(n) ?? '';
  const type = decoded.objType;
  if (OTHER_TYPES.has(type)) {
    const spec = otherObjectSpec(decoded, t, descriptions);
    if (!spec) return null;
    const canvas = await drawSpec(spec, { name: nameFont, body: bodyFont }, interfaceMes);
    canvas.title = 'Info box as drawn by the game (intgame_examine_object)';
    return canvas;
  }
  if (type < 5 || type > 14) return null;      // walls, projectiles, traps…: the game shows no info box for them
  const complexity = int(decoded, F.complexity);

  const name = descriptions.get(int(decoded, F.description)) || decoded.filename;
  const speed = type === OBJ_WEAPON ? `${t(8)}: ${int(decoded, F.speedFactor) + int(decoded, F.magicSpeedAdj)}` : '';

  // Line 2: effect text from item_effect.mes when there is one, else the computed stat summary.
  let stats = '';
  const effectText = effects.get(int(decoded, F.effects));
  if (type === OBJ_WEAPON || type === OBJ_ARMOR) {
    stats = effectText ? effectText : (type === OBJ_WEAPON ? weaponStats(decoded, t) : armorStats(decoded, t));
  } else if (type === OBJ_AMMO || type === OBJ_GOLD) {
    stats = `${t(6)}: ${int(decoded, type === OBJ_AMMO ? F.ammoQuantity : F.goldQuantity)}`;
  } else if (effectText) {
    stats = effectText;
  }
  if (type === OBJ_GENERIC) {
    const flags = int(decoded, F.genericFlags), bonus = int(decoded, F.usageBonus);
    const sign = bonus >= 0 ? '+' : '';
    if (flags & 0x2) stats = `${t(71)}: ${sign}${bonus}%`;
    else if (flags & 0x8) stats = `${t(72)}: ${sign}${bonus}%`;
  }

  // Line 3: magic power (magickal weapon / armor), and the ammunition a weapon uses.
  const power = complexity > 0 && (type === OBJ_WEAPON || type === OBJ_ARMOR) ? `${t(2)}: 100%` : '';
  let ammoText = '';
  if (type === OBJ_WEAPON) {
    const ammo = int(decoded, F.ammoType), use = int(decoded, F.ammoConsumption);
    if (ammo !== NO_AMMO && use > 0) ammoText = `${items.get(ammo) ?? `Ammo ${ammo}`}: ${use}`;
  }

  // Line 4: weight and hit points.
  const weight = type === OBJ_GOLD ? 0 : int(decoded, F.itemWeight);
  let hp = '';
  if (type === OBJ_WEAPON || type === OBJ_ARMOR || (type === OBJ_GENERIC && (int(decoded, F.genericFlags) & 0x20))) {
    const max = int(decoded, F.hpPts) + int(decoded, F.hpAdj);
    hp = `${max - int(decoded, F.hpDamage)}/${max}`;
  }

  const icon = await loadInterfaceIcon(interfaceIconNumber(decoded, complexity), interfaceMes).catch(() => null);

  const canvas = document.createElement('canvas');
  canvas.className = 'item-card';
  canvas.width = 384;
  canvas.height = Math.max(96, ICON_AT.y - ORIGIN.y + (icon ? icon.height : 0) + 12);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  if (icon) ctx.drawImage(icon, ICON_AT.x - ORIGIN.x, ICON_AT.y - ORIGIN.y);

  const at = r => ({ ...r, x: r.x - ORIGIN.x, y: r.y - ORIGIN.y });
  drawText(ctx, nameFont, name, at(RECTS.name), complexity > 0 ? BLUE : WHITE);
  drawText(ctx, bodyFont, speed, at(RECTS.name), RED, 'right');
  drawText(ctx, bodyFont, stats.trim(), at(RECTS.stats), WHITE);
  drawText(ctx, bodyFont, power, at(RECTS.extra), WHITE);
  drawText(ctx, bodyFont, ammoText, at(RECTS.extra), WHITE, 'right');
  drawText(ctx, bodyFont, `${t(4)}: ${weight} ${t(5)}`, at(RECTS.bottom), RED);
  drawText(ctx, bodyFont, hp, at(RECTS.bottom), RED, 'right');
  canvas.title = 'Item info box as drawn by the game (intgame_examine_item)';
  return canvas;
}
