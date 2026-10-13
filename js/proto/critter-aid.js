// Art id resolution for critters, monsters and unique NPCs.

import { ART_ID_INVALID, ART_TYPE, artType } from '../core/art-id.js';
import { parseArtBuffer } from '../art/art-decoder.js';
import { CRITTER_ART_ROOT, MONSTER_ART_ROOT, UNIQUE_NPC_ART_ROOT } from '../core/config.js';
import { encPath } from '../core/util.js';
import { flipCanvasHorizontally, pickArtFrameForRotation } from '../objects/art-frames.js';
import { critterFrameSource, loadCritterFrames, resolveCritterArt } from '../objects/critter-art.js';
import { PROTO_ART_TYPE_EYE_CANDY, protoArtRoot } from './proto-mes.js';

// The art table an object uses is decided by the type of the art id it
// holds, not by the object's own type. TIG art types: 4 = scenery, 6 = item,
// 7 = container. Several containers (barrels, crates, ...) are container
// objects whose F_CURRENT_AID is a *scenery* art id, so looking them up in
// container.mes either fails or shows the wrong picture.
export function protoArtObjectType(rawValue, objectType) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw)) return objectType;
  const typeNibble = artType(raw);
  // .PRO trap F_CURRENT_AID values are encoded as TIG eye-candy IDs with
  // nibble E. Their numeric Art ID is still the normal tig_art_num_get()
  // value; only the TIG type/folder is different from scenery/items.
  if (typeNibble === ART_TYPE.EYE_CANDY) return PROTO_ART_TYPE_EYE_CANDY;
  // A trap proto's real art is an eye-candy id (nibble E, handled above).
  // 026027 - 10001 Trap.pro instead holds 0x40000280 -- a scenery-typed id
  // (type 10, num 0 = Pedastal1.ART) that is only a leftover placeholder, so
  // don't let the generic nibble-4 rule turn a trap into a pedestal.
  if (objectType === 17 && typeNibble !== ART_TYPE.EYE_CANDY) return objectType;
  if (typeNibble === ART_TYPE.PORTAL) return 1; // portal
  if (typeNibble === ART_TYPE.SCENERY) return 3; // scenery
  if (objectType === 2 && typeNibble === ART_TYPE.CONTAINER) return 2; // container
  return objectType;
}

// NPC / PC (critter) art ids. Unlike scenery, containers or items, a critter
// art id is not a key into any .mes table: game/name.c builds the ART filename
// directly from the id's gender / body type / armor / shield / weapon / anim
// parts, so the "Art ID" shown for an NPC proto is the packed TIG id itself.
// Layout (type nibble 2 = critter):
//   bit 27      gender (0 = F, 1 = M)         bits 24-26  body type
//   bits 11-13  rotation
// Body type order is name_body_type_strs[] in game/name.c. The gender/body bit
// positions are inferred, not read from TIG source (not in the CE src zip): they
// reproduce a human-male NPC .mob (body 0, gender 1) and the three supplied
// NPC .pro files (all rotation 4, no other bits set). Armor/shield/weapon/anim
// bit positions are NOT decoded; the filename is only offered when every bit
// outside gender/body/rotation is zero, which is how game/proto.c creates the
// default NPC art id (armor UNDERWEAR, no shield/weapon, anim 0).
const CRITTER_BODY_NAMES = ['Human', 'Dwarf', 'Halfling', 'Half-ogre', 'Elf'];
const CRITTER_BODY_CODES = ['HM', 'DF', 'GH', 'HG', 'EF'];
const CRITTER_ARMOR_CODES = ['UW', 'V1', 'LA', 'CM', 'PM', 'RB', 'PC', 'BN', 'CD'];
const CRITTER_ARMOR_NAMES = ['underwear', 'villager', 'leather', 'chain', 'plate', 'robe', 'plate (classic)', 'barbarian', 'city dweller'];
// Additional layout, inferred from the order of tig_art_critter_id_create()'s
// arguments (gender, body, armor, shield, frame, rotation, anim, weapon, palette)
// packed from the high bits down, which the verified gender/body/rotation
// positions fit exactly:  bits 20-23 armor, bit 19 shield, bits 14-18 frame.
// Bits 0-10 (anim / weapon / palette) are NOT decoded.
// monster.mes: monster number -> art code. The number sits in bits 23-27 of a
// 0xC-type art id (inferred from four supplied monster .pro files: 0xC4802000,
// 0xC6802000, 0xC6002000, 0xC7002000 -> 9, 13, 12, 14 = bun, pha, liz, rat);
// rotation is bits 11-13 like critters. Remaining bits are not decoded.
const MONSTER_CODES = ['wlf','spd','ocm','ert','ld1','ls1','lz1','lm1','gd1','bun','msp','aut','liz','pha','rat','sna','ape','ber','chk','cug','shp','tgr','pig','cow','wow','mpg','FIR','WAT','AIR','dkn','spq','wwf'];
const MONSTER_NAMES = ['Wolf','Spider','Orc','Earth Elemental','Lesser Demon','Lesser Skeleton','Lesser Zombie','Lesser Mummy','Greater Demon','Bunny','Mechanical Spider','Automaton','Lizard Man','Phantom Knight','WereRat','SnakeMan','Ape','Bear','Chicken','Cougar','Sheep','Tiger','Pig','Cow',"Will 'O Wisp",'Mutant Pig','Fire Elemental','Water Elemental','Air Elemental','Death Knight','Spider Queen','Werewolf'];
// Weapon / animation / frame / palette parts of a critter-style art id.
// Layout (tig_art_critter_id_create argument order, packed from the high bits
// down -- INFERRED, the CE source is not part of this project; the rotation,
// gender/body/armor bit positions above were verified, these were not):
//   bits 14-18 frame   bits 6-10 anim   bits 4-5 palette   bits 0-3 weapon
// File name suffix: weapon letter 'A'+weapon, animation letter 'a'+anim (the
// default NPC id, all zero, is the ...Aa file). Palette selects one of the
// ART file's embedded palettes (see critterFrameSource). If pictures come out wrong, only this table needs to change.
const CRITTER_AID_BITS = { weaponShift: 0, weaponMask: 0xF, animShift: 6, animMask: 0x1F, frameShift: 14, frameMask: 0x1F, paletteShift: 4, paletteMask: 0x3 };
// game/name.c name_weapon_type_codes[], indexed by weapon type. NOT simply 'A'+n:
// the unnamed types 11, 12 and 14 map to X, Y and Z.
const CRITTER_WEAPON_CODES = 'ABCDEFGHIJKXYNZ';
const WEAPON_TYPE_SWORD = 3, WEAPON_TYPE_TWO_HANDED_SWORD = 7;
function critterAidWeaponAnimFrame(raw, shield = 0) {
  const B = CRITTER_AID_BITS;
  const weapon = (raw >>> B.weaponShift) & B.weaponMask;
  const anim = (raw >>> B.animShift) & B.animMask;
  const frameNo = (raw >>> B.frameShift) & B.frameMask;
  const palette = (raw >>> B.paletteShift) & B.paletteMask;
  // name_resolve_path(): a two-handed sword with a shield is drawn as a sword.
  const fileWeapon = (weapon === WEAPON_TYPE_TWO_HANDED_SWORD && shield) ? WEAPON_TYPE_SWORD : weapon;
  const weaponLetter = CRITTER_WEAPON_CODES[fileWeapon] || String.fromCharCode(65 + weapon);
  const animLetter = anim < 26 ? String.fromCharCode(97 + anim) : null;
  const waLetters = animLetter ? (weaponLetter + animLetter).toLowerCase() : null;
  const detail = `weapon ${weapon} (${weaponLetter}) \u00b7 anim ${anim}${animLetter ? ` (${animLetter})` : ' (no letter)'} \u00b7 frame ${frameNo}` + (palette ? ` \u00b7 palette ${palette}` : '');
  return { weapon, anim, frameNo, palette, weaponLetter, animLetter, waLetters, waKey: `${weapon}.${anim}`, detail };
}
function protoMonsterAidInfo(raw) {
  const hex = '0x' + raw.toString(16).toUpperCase().padStart(8, '0');
  const rotation = (raw >>> 11) & 0x7;
  const num = (raw >>> 23) & 0x1F;
  const code = MONSTER_CODES[num] || null;
  const name = MONSTER_NAMES[num] || `monster #${num}`;
  const wa = critterAidWeaponAnimFrame(raw);
  const text = `${raw} (${hex}) \u00b7 monster ${num}: ${name}${code ? ` (${code})` : ''} \u00b7 rotation ${rotation} \u00b7 ${wa.detail}`;
  // art/monster/<FOLDER>/<code>uwx<aa>.ART, e.g. AIR/airuwxab.ART. 'uw' = underwear
  // armor and 'x' = no shield (same slots as critter names); the last two letters
  // are weapon/animation. Monster folders are not all lower case (AIR, FIR, LIZ,
  // PHA, RAT, SNA, WAT), so the folder is taken from this exact-case list.
  const folder = code ? (MONSTER_UPPER_FOLDERS.has(code.toUpperCase()) ? code.toUpperCase() : code.toLowerCase()) : null;
  const lower = code ? code.toLowerCase() : null;
  // Nominal name only (the animation pair is resolved against the folder's
  // manifest at load time, see monsterArtCandidates).
  const filename = lower ? `${folder}\\${lower}uwxaa.ART` : null;
  return { raw, hex, rotation, monster: true, monsterNum: num, monsterCode: code, monsterName: name,
           monsterFolder: folder, gender: 0, body: 0, armor: 0, shield: 0, exact: false, filename, text,
           weapon: wa.weapon, anim: wa.anim, frameNo: wa.frameNo, waLetters: wa.waLetters, waKey: wa.waKey, palette: wa.palette };
}

// unique_npc.mes: unique NPC number -> art folder (exact case, e.g. 'FM1uw',
// 'hmmvg'). Unlike monsters the code already includes the armour part, so the
// files are <folder>/<folder>x<anim>.ART (art/unique_npc/<folder>/).
const UNIQUE_NPC_CODES = ['hmmbs','hmmtn','hmmvg','ghmvg','hmmki','ghmst','hmmgb','effvg','efmvg','ghmv2','ghfvg','hmfvg','dfmvg','effsl','efmax','hmmpn','ghfcd','hmfc2','hopuw','ayauw','dgnuw','gwtuw','hlbuw','kituw','krguw','lycuw','snwuw','kergn','Kr1uw','Kr2uw','Kr3uw','SHMuw','GLMuw','FM1uw','PH1uw','PH2uw','PH3uw','SWGuw','nakuw','VORuw'];
// Type nibble 0xD (TIG unique-NPC art). INFERRED from a single supplied .pro
// (027343 - NPC.pro, F_CURRENT_AID 0xD1402010): rotation is bits 11-13 as for
// critters/monsters, and the unique number is taken as the 8-bit field at bits
// 20-27 that critters use for gender/body/armour (0xD14 -> 0x14 = 20, dgnuw).
// If the picture is wrong, change these two constants (e.g. shift 22 / mask 0x3F
// gives #5 ghmst; shift 23 / mask 0x1F gives #2 hmmvg) -- nothing else depends on them.
const UNIQUE_NPC_NUM_SHIFT = 20, UNIQUE_NPC_NUM_MASK = 0xFF;
function protoUniqueNpcAidInfo(raw) {
  const hex = '0x' + raw.toString(16).toUpperCase().padStart(8, '0');
  const rotation = (raw >>> 11) & 0x7;
  const num = (raw >>> UNIQUE_NPC_NUM_SHIFT) & UNIQUE_NPC_NUM_MASK;
  const code = UNIQUE_NPC_CODES[num] || null;
  const wa = critterAidWeaponAnimFrame(raw);
  const text = `${raw} (${hex}) \u00b7 unique NPC ${num}${code ? ` (${code})` : ' (not in unique_npc.mes)'} \u00b7 rotation ${rotation} \u00b7 ${wa.detail}`;
  const filename = code ? `${code}\\${code.toLowerCase()}xaa.ART` : null;
  // Reuses the monster loader path: info.monster + monsterFolder/monsterCode + artRoot.
  return { raw, hex, rotation, monster: true, uniqueNpc: true, monsterNum: num, monsterCode: code, monsterName: code,
           monsterFolder: code, artRoot: UNIQUE_NPC_ART_ROOT, gender: 0, body: 0, armor: 0, shield: 0, exact: false, filename, text,
           weapon: wa.weapon, anim: wa.anim, frameNo: wa.frameNo, waLetters: wa.waLetters, waKey: wa.waKey, palette: wa.palette };
}

const monsterUrlCache = new Map();
export function resolveMonsterArtUrl(info) {
  const key = `${info.artRoot || MONSTER_ART_ROOT}${info.monsterFolder}/${info.monsterCode}|${info.waKey}`;
  if (!monsterUrlCache.has(key)) {
    monsterUrlCache.set(key, (async () => {
      const urls = await monsterArtCandidates(info);
      // With a manifest the first candidate is known to exist; without one,
      // probe in order, once.
      if (urls.length && urls[0] && monsterFolderCache.get(`${info.artRoot || MONSTER_ART_ROOT}${info.monsterFolder}`) && (await monsterFolderCache.get(`${info.artRoot || MONSTER_ART_ROOT}${info.monsterFolder}`))) return urls[0];
      for (const u of urls) {
        // loadCritterFrames() caches the decoded file, so the hit is not downloaded twice.
        const ok = await loadCritterFrames(u, info.frameNo).then(() => true).catch(() => false);
        if (ok) return u;
      }
      return null;
    })());
  }
  return monsterUrlCache.get(key);
}

const MONSTER_UPPER_FOLDERS = new Set(['AIR', 'FIR', 'LIZ', 'PHA', 'RAT', 'SNA', 'WAT']);
const monsterFolderCache = new Map();
// Returns candidate URLs for a monster's ART, best first. Uses the folder's
// <FOLDER>_manifest.json when available (the animation letters differ per
// monster: AIR has no 'aa' file, only ab/ad/af/...), otherwise guesses.
async function monsterArtCandidates(info) {
  if (!info || !info.monster || !info.monsterFolder) return [];
  const folder = info.monsterFolder;
  const root = info.artRoot || MONSTER_ART_ROOT;
  // Monsters: <code>uwx<anim>; unique NPCs: the folder name already ends in the
  // armour letters, so files are <folder>x<anim> (shield letter optional).
  const prefix = info.uniqueNpc ? info.monsterCode.toLowerCase() : `${info.monsterCode.toLowerCase()}uwx`;
  const cacheKey = `${root}${folder}`;
  if (!monsterFolderCache.has(cacheKey)) {
    monsterFolderCache.set(cacheKey, fetch(`${root}${folder}/${folder}_manifest.json`)
      .then(r => r.ok ? r.json() : null).then(j => (j && Array.isArray(j.files)) ? j.files : null).catch(() => null));
  }
  const files = await monsterFolderCache.get(cacheKey);
  let names = [];
  if (files) {
    names = files.filter(f => f.toLowerCase().startsWith(prefix) && /\.art$/i.test(f)).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
    // Preference: the weapon+animation decoded from the art id, then that
    // weapon's base animation, then the base animation ('aa', then 'ab').
    const wl = info.waLetters ? info.waLetters[0] : null;
    const rank = f => {
      const tail = f.toLowerCase().replace(/\.art$/, '').slice(-2);
      if (info.waLetters && tail === info.waLetters) return 0;
      if (wl && tail === `${wl}a`) return 1;
      return tail === 'aa' ? 2 : tail === 'ab' ? 3 : 4;
    };
    names.sort((a, b) => rank(a) - rank(b));
  } else {
    const wa = info.waLetters, wl = wa ? wa[0] : null;
    const tails = [...new Set([wa, wl && `${wl}a`, 'aa', 'ab'].filter(Boolean))];
    names = tails.flatMap(t => info.uniqueNpc ? [`${prefix}x${t}.ART`, `${prefix}${t}.ART`] : [`${prefix}${t}.ART`]);
  }
  return names.map(n => `${root}${folder}/${encodeURIComponent(n)}`);
}

export function protoCritterAidInfo(value, objectType) {
  if (objectType !== 15 && objectType !== 16) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const raw = numeric >>> 0;
  if (raw === ART_ID_INVALID) return null;
  // Monster protos (e.g. wolves, bunnies, phantom knights) do NOT use the
  // critter art type: their F_CURRENT_AID has type nibble 0xC (TIG monster art),
  // so the critter-only check below used to reject them and no art id was shown.
  if (artType(raw) === ART_TYPE.MONSTER) return protoMonsterAidInfo(raw);
  // Unique NPCs (type nibble 0xD) live in art/unique_npc/<folder>/ (unique_npc.mes).
  if (artType(raw) === ART_TYPE.UNIQUE_NPC) return protoUniqueNpcAidInfo(raw);
  if (artType(raw) !== ART_TYPE.CRITTER) return null;
  const hex = '0x' + raw.toString(16).toUpperCase().padStart(8, '0');
  const rotation = (raw >>> 11) & 0x7;
  const gender = (raw >>> 27) & 0x1;
  const body = (raw >>> 24) & 0x7;
  const armor = (raw >>> 20) & 0xF;
  const shield = (raw >>> 19) & 0x1;
  const bodyName = CRITTER_BODY_NAMES[body];
  const parts = [bodyName ? `${bodyName} ${(armor === 4 || armor === 6) ? '(unisex plate)' : (gender ? 'male' : 'female')}` : `body type ${body}`];
  if (armor) parts.push(CRITTER_ARMOR_NAMES[armor] ? `${CRITTER_ARMOR_NAMES[armor]} armor` : `armor ${armor}`);
  parts.push(`rotation ${rotation}`);
  // weapon (bits 0-3), animation (6-10) and frame (14-18) are decoded below by
  // critterAidWeaponAnimFrame(); the default NPC proto (all zero) is the ...Aa file.
  // name_normalize_aid(): the walk animation (anim 1, see the monster/unique-NPC
  // branches there) never uses a shield, so its file is the shieldless one. The other
  // normalisations (run..severed leg drop weapon and shield, stunned forces weapon 1,
  // explode uses armor XX) need TIG's anim enum, which is not in the CE sources, so
  // they are left to the existing-file fallback in resolveCritterArt().
  const animNo = (raw >>> CRITTER_AID_BITS.animShift) & CRITTER_AID_BITS.animMask;
  const fileShield = animNo === 1 ? 0 : shield;
  const wa = critterAidWeaponAnimFrame(raw, fileShield);
  let candidates = null;
  let filename = null;
  if (bodyName && CRITTER_ARMOR_CODES[armor]) {
    let g = gender, b = body;
    let unisex = false;
    if (b === 4 && !g) b = 0;               // name_normalize_aid(): elf female uses human art
    if (armor === 4 || armor === 6) {        // plate: one art set for both genders, elf->human, halfling->dwarf
      g = 1;
      unisex = true;
      if (b === 4) b = 0; else if (b === 2) b = 1;
    }
    const bodyCode = CRITTER_BODY_CODES[b];
    // Plate armour (PM / PC) has no male/female variants: its files live in the
    // gender-neutral "X" folders (DFX, HGX, HMX -- exactly the bodies left once
    // elf->human and halfling->dwarf are applied), e.g. DFX\DFXPCXAa.art. The
    // art id itself has no third gender value; the X comes from the armour.
    const gc = unisex ? 'X' : (g ? 'M' : 'F');
    // Decoded weapon+animation file first, then the same weapon's base
    // animation, then the unarmed base file (see resolveCritterArt()).
    const stem = `${bodyCode}${gc}${CRITTER_ARMOR_CODES[armor]}${fileShield ? 'S' : 'X'}`;
    const names = [wa.animLetter ? `${stem}${wa.weaponLetter}${wa.animLetter}.art` : null, `${stem}${wa.weaponLetter}a.art`, `${stem}Aa.art`].filter(Boolean);
    candidates = [...new Set(names)].map(n => `${bodyCode}${gc}\\${n}`);
    if (unisex) {
      // Safety net in case a body/plate combination only ships male art.
      const male = [...new Set(names)].map(n => n.replace(stem, stem.replace(`${bodyCode}X`, `${bodyCode}M`)));
      candidates.push(...male.map(n => `${bodyCode}M\\${n}`));
    }
    filename = candidates[0];
    parts.push(`${filename} \u00b7 ${wa.detail}`);
  }
  return { raw, hex, rotation, gender, body, armor, shield, exact: true, filename, candidates, weapon: wa.weapon, anim: wa.anim, frameNo: wa.frameNo,
           palette: wa.palette, waKey: wa.waKey, text: `${raw} (${hex}) \u00b7 ${parts.join(' \u00b7 ')}` };
}

export function protoCurrentAidArtId(value, objectType) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const raw = numeric >>> 0;
  if (raw === ART_ID_INVALID) return null; // TIG_ART_ID_INVALID -- "no art", not an unknown format

  const rawArtType = artType(raw);
  // Verified directly against all eight supplied trap .PRO files. The raw
  // F_CURRENT_AID values are 0xE..., and the encoded eye-candy number is
  // bits 19..27. These produce exactly 351..357, matching eye_candy.mes:
  // 351 trap_arrow, 352 trap_elec, 353 trap_fire, 354 trap_gun,
  // 355 trap_magick, 356 trap_mechanical, 357 trap_poison.
  if (rawArtType === ART_TYPE.EYE_CANDY) {
    const eyeCandyType = (raw >>> 6) & 0x7;
    if (eyeCandyType < 0 || eyeCandyType > 2) return null;
    return (raw >>> 19) & 0x1FF;
  }

  objectType = protoArtObjectType(raw, objectType);

  // Portal encoding verified against the supplied SEC portal objects and
  // tig_art_portal_id_create()/name.c:
  //   Art type nibble = 0x3 (TIG_ART_TYPE_PORTAL)
  //   bits 19..27 = portal number
  //   bit 10 = portal type. Checked against 67108865.sec: all 20 portals there
  //   have bit 10 SET and they resolve to doors (adjacent a/b halves such as
  //   IN4E4aU0 + IN4E4bU0), so SET = door and CLEAR = window (the old reading
  //   was inverted and sent every door to the window table, e.g. VTIF4bu0).
  // name.c::sub_4EC8F0() looks up doors at `num` and windows at `num + 1001`.
  if (objectType === 1) {
    if (rawArtType !== 0x3) return null;
    const num = (raw >>> 19) & 0x1FF;
    const isWindow = ((raw >>> 10) & 0x1) === 0;
    return num + (isWindow ? 1001 : 0);
  }

  // Confirmed container encoding (game/name.c: mes_file_entry.num = 1000*type + num,
  // looked up in container.mes -- NOT item_inven.mes). Solved and round-trip-verified
  // against every F_CURRENT_AID/F_DESTROYED_AID in the game's 38 container .pro files,
  // cross-checked against game/proto.c's named container blueprints (BP_WOOD_CHEST_1,
  // BP_SAFE_1, the crate family, etc.) -- every non-invalid sample re-encodes exactly.
  //   bits 19-24 (6 bits): num        bits 6-7 + bit 8 (3 bits): type
  if (objectType === 2) {
    const num = (raw >>> 19) & 0x3F;
    const type = ((raw >>> 6) & 0x3) | (((raw >>> 8) & 0x1) << 2);
    const reencoded = (0x70000000 | (num << 19) | ((type & 0x3) << 6) | (((type >> 2) & 1) << 8)) >>> 0;
    // Placed containers carry extra state in F_CURRENT_AID (rotation in bits
    // 11-13, plus palette/frame bits) that the .pro files leave at zero.
    // Ignore those bits when matching num/type, or a rotated chest would
    // fail the round-trip check and lose its art.
    return reencoded === (raw & ~0x3E30) >>> 0 ? (type * 1000 + num) : null;
  }

  // Confirmed scenery encoding (game/name.c: mes_file_entry.num = 1000*type + num,
  // looked up in scenery.mes). Solved and round-trip-verified against every real
  // scenery .pro in the game (45/45), matching every named blueprint in proto.c
  // (trees, stones, lights 1-13, wall-of-fire/stone/force, dynamite, smoke, ...).
  //   bits 19-26 (8 bits): num        bits 6-10 (5 bits): type
  // num is 8 bits, not 7: scenery.mes has entries above 127 within a type
  // (e.g. 13139 HurbPlanter1 = type 13, num 139). With 7 bits, 139 & 127 = 11
  // wrapped to 13011 (T_stump_2).
  if (objectType === 3) {
    const num = (raw >>> 19) & 0xFF;
    const type = (raw >>> 6) & 0x1F;
    if (artType(raw) !== ART_TYPE.SCENERY) return null;
    return type * 1000 + num;
  }

  // Confirmed unified item encoding (game/a_name.c's a_name_item_aid_to_fname):
  //   mes_file_entry.num = tig_art_num_get(aid) + 20*(subtype + 50*type)
  //   if type==ARMOR and coverage!=TORSO: += 20*(5*coverage+10)
  // Solved and validated against game/proto.c's named item blueprints (every
  // weapon family: dagger/sword/axe/mace/revolver/broadsword/bow/shotgun/staff/
  // elephant gun/tesla rod/flame thrower; every armor family: wool clothes/
  // guard leather/chainmail/platemail/priest robes/mithril/dread armour/nice
  // suit/shield/helmet; gold/key/key ring) and cross-checked against every real
  // .pro of every item type in the game (742/744 = 99.7% resolve correctly;
  // the two misses are plausibly one-off unused/placeholder prototypes).
  //   bits 0-3 (4 bits): type (WEAPON=0..GENERIC=9, matches objectType-5)
  //   bits 6-9 (4 bits): subtype (weapon family; 0 for non-weapon/armor)
  //   bits 14-16 (3 bits, armor only): coverage (TORSO=0, SHIELD=1, HELMET=2, ...)
  //   bits 17-24 (8 bits): num
  // bits 4,5,12 encode disposition (which of ground/inven/paper/schematic a
  // FIELD is meant to read) but are not needed here: the caller already knows
  // which table to search from the field itself (see protoArtMesMap).
  if (objectType === 5 || objectType === 6 || objectType === 7 || (objectType >= 8 && objectType <= 14)) {
    const b3 = (raw >>> 24) & 0xFF;
    if (b3 !== 0x60 && b3 !== 0x61) return null;
    const type = raw & 0xF;
    const expectedType = objectType - 5;
    if (type !== expectedType) return null; // the value's own type bits must agree with the object's type
    const subtype = (raw >>> 6) & 0xF;
    const coverage = (raw >>> 14) & 0x7;
    // num is 8 bits (17-24), not 5: generic items run up to 9193 and food/keys/
    // pc items also exceed 31 in item_ground.mes. With only 5 bits, 9065 (steel,
    // num 65) was read as 65 & 31 = 1, i.e. 9001 (papers). Bit 24 is why the
    // 0x60/0x61 check above accepts both values of the top byte.
    const num = (raw >>> 17) & 0xFF;
    let key = num + 20 * subtype + 1000 * type;
    if (type === 2 && coverage !== 0) key += 20 * (5 * coverage + 10);
    return key;
  }

  return null;
}

// Critter (NPC/PC) preview: fetch art/critter/<dir>/<file>.art and draw the
// frame for the proto's rotation (an 8-direction ART stores frames
// direction-major, so index = rotation * framesPerDirection).
export async function loadCritterAidArt(info, previewCanvas, maxSide = 92) {
  if (!info || !info.filename) return false;
  let url = `${CRITTER_ART_ROOT}${info.filename.split('\\').map(encodeURIComponent).join('/')}`;
  try {
    // Resolved once per art-id type (cached) instead of probing candidate
    // files with a fresh download for every card.
    const res = await resolveCritterArt(info);
    if (!res) throw new Error('no ART file found');
    url = res.url;
    const frames = await loadCritterFrames(url, info.frameNo);
    if (!frames.length) throw new Error('no drawable frame');
    const { frame, mirrored } = pickArtFrameForRotation(frames, info.rotation);
    let source = critterFrameSource(frame || frames[0], info.palette);
    if (!source) throw new Error('no drawable frame');
    if (mirrored) source = flipCanvasHorizontally(source);
    const scale = Math.max(1, Math.min(maxSide / source.width, maxSide / source.height));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    previewCanvas.width = w;
    previewCanvas.height = h;
    previewCanvas.style.width = `${w}px`;
    previewCanvas.style.height = `${h}px`;
    const ctx = previewCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    previewCanvas.title = `${info.filename} · Art ID ${info.raw}`;
    previewCanvas.classList.remove('missing');
    return true;
  } catch (err) {
    previewCanvas.classList.add('missing');
    previewCanvas.title = `${info.filename} · bitmap unavailable (${url})`;
    return false;
  }
}

export async function loadProtoCurrentAidArt(artId, artName, previewCanvas, objectType, rawAid = null) {
  if (!artName) return false;
  let filename = artName.replace(/^.*[\/]/, '');

  // portal.mes stores the ART filename followed by the numeric display/name
  // value, e.g. `BR2f5cu2.art 2036`. The game uses the filename portion for
  // the actual asset path; do not include the trailing MES number in the URL.
  if (objectType === 1) {
    const portalFilename = filename.match(/^(.*?\.art)(?:\s+\d+)?$/i);
    if (portalFilename) filename = portalFilename[1];
  }

  // eye_candy.mes explicitly defines the filename suffix from the eye-candy
  // type: foreground overlay = _f, background overlay = _b, underlay = _u.
  // Read that type from the packed AID instead of assuming every eye-candy
  // prototype is an underlay.
  if (objectType === PROTO_ART_TYPE_EYE_CANDY) {
    const raw = Number(rawAid);
    const eyeCandyType = Number.isFinite(raw) ? ((raw >>> 6) & 0x7) : null;
    const suffix = eyeCandyType === 0 ? '_f' : eyeCandyType === 1 ? '_b' : eyeCandyType === 2 ? '_u' : null;
    if (suffix && !new RegExp(`${suffix}\\.art$`, 'i').test(filename)) {
      filename = `${filename}${suffix}.art`;
    }
  }
  const url = `${protoArtRoot(objectType)}${encPath(filename)}`;
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const frames = await parseArtBuffer(await resp.arrayBuffer(), 1);
    if (!frames.length || !frames[0].canvas) throw new Error('no drawable frame');
    // The art id's palette (bits 4-5, tig_art_id_palette_get) picks one of the file's palettes;
    // a palette the file lacks falls back to palette 0, as in tig_art's video-buffer lookup.
    const raw = Number(rawAid);
    const wanted = Number.isFinite(raw) ? (raw >>> 4) & 0x3 : 0;
    const source = wanted < (frames[0].palettes?.length || 1)
      ? critterFrameSource(frames[0], wanted)
      : frames[0].canvas;
    previewCanvas.nativeFrame = source;   // the frame at its real size, for "as in the game" previews
    const maxSide = 92;
    const scale = Math.max(1, Math.min(maxSide / source.width, maxSide / source.height));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    previewCanvas.width = w;
    previewCanvas.height = h;
    previewCanvas.style.width = `${w}px`;
    previewCanvas.style.height = `${h}px`;
    const ctx = previewCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    previewCanvas.title = `${artName} · Art ID ${artId}`;
    previewCanvas.classList.remove('missing');
    return true;
  } catch (err) {
    previewCanvas.classList.add('missing');
    previewCanvas.title = `${artName} · bitmap unavailable`;
    return false;
  }
}
