// What an NPC / monster is, as shown in the .mob view: its name, race and type. Mirrors the rules of
// toolbox/extract_mob_prototypes.py, which fills the Race / Type columns of extract.xlsx.
//
// The race stat is not enough: placed NPCs and monsters often leave it at its default (Human). The art
// the object is drawn with says more (a monster art code, or the folder of a unique NPC such as dfmvg =
// dwarf male), so a stat other than Human wins, then the art, then the stat.

const F_CURRENT_AID = 1, F_DESCRIPTION = 23, F_CRITTER_FLAGS = 218, F_CRITTER_STAT_BASE_IDX = 220;
const STAT_RACE = 27, OCF_UNDEAD = 0x4, OCF_ANIMAL = 0x8;
const RACE_NAMES = ['Human', 'Dwarf', 'Elf', 'Half Elf', 'Gnome', 'Halfling', 'Half Orc', 'Half Ogre', 'Dark Elf', 'Ogre', 'Orc'];
const RACES = ['Half Ogre', 'Half Orc', 'Half Elf', 'Dark Elf', 'Halfling', 'Human', 'Dwarf', 'Gnome', 'Ogre', 'Orc', 'Elf'];

// art type 0xC: number in bits 23-27; type 0xD: bits 20-27 (see critter-aid.js)
const MONSTER_CODES = ['wlf','spd','ocm','ert','ld1','ls1','lz1','lm1','gd1','bun','msp','aut','liz','pha','rat','sna','ape','ber','chk','cug','shp','tgr','pig','cow','wow','mpg','FIR','WAT','AIR','dkn','spq','wwf'];
const UNIQUE_NPC_CODES = ['hmmbs','hmmtn','hmmvg','ghmvg','hmmki','ghmst','hmmgb','effvg','efmvg','ghmv2','ghfvg','hmfvg','dfmvg','effsl','efmax','hmmpn','ghfcd','hmfc2','hopuw','ayauw','dgnuw','gwtuw','hlbuw','kituw','krguw','lycuw','snwuw','kergn','Kr1uw','Kr2uw','Kr3uw','SHMuw','GLMuw','FM1uw','PH1uw','PH2uw','PH3uw','SWGuw','nakuw','VORuw'];
const GROUPS = {};
const addGroup = (group, codes) => codes.split(' ').forEach(c => { GROUPS[c] = group; });
addGroup('Animal', 'wlf spd bun rat ape ber chk cug shp tgr pig cow mpg gwtuw hlbuw snwuw');
addGroup('Undead', 'ls1 lz1 lm1 pha dkn lycuw kergn GLMuw PH1uw PH2uw PH3uw');
addGroup('Kite', 'kituw');
addGroup('Krag', 'krguw');
addGroup('Monster', 'ocm ert ld1 gd1 msp aut liz sna wow FIR WAT AIR spq wwf ayauw dgnuw Kr1uw Kr2uw Kr3uw SHMuw SWGuw VORuw');
const UNIQUE_BODY_RACES = { hmm: 'Human', hmf: 'Human', ghm: 'Halfling', ghf: 'Halfling', efm: 'Elf', eff: 'Elf', dfm: 'Dwarf' };
const CRITTER_BODY_RACES = ['Human', 'Dwarf', 'Halfling', 'Half Ogre', 'Elf'];

function creatureGroup(art) {
  const kind = art >>> 28;
  if (kind === 0x4) return 'Object';   // an "NPC" drawn as scenery
  let code = null;
  if (kind === 0xC) code = MONSTER_CODES[(art >>> 23) & 0x1F];
  else if (kind === 0xD) code = UNIQUE_NPC_CODES[(art >>> 20) & 0xFF];
  else return null;
  return GROUPS[code] || null;
}

function artRace(art) {
  const kind = art >>> 28;
  if (kind === 0x2) return CRITTER_BODY_RACES[(art >>> 24) & 0x7] || null;
  if (kind === 0xD) return UNIQUE_BODY_RACES[(UNIQUE_NPC_CODES[(art >>> 20) & 0xFF] || '').slice(0, 3).toLowerCase()] || null;
  return null;
}

export function splitRaceType(name) {
  for (const race of RACES) {
    if (name === race) return { race, type: '' };
    if (name.startsWith(`${race} `)) return { race, type: name.slice(race.length + 1).trim() };
  }
  return { race: '', type: name };
}

const statRace = stats => {
  const e = stats?.elements?.find(x => x.index === STAT_RACE);
  return e && typeof e.value === 'number' ? (RACE_NAMES[e.value] || null) : null;
};

// What the object is: { race, source } where source says where the race was read from. `fields` are the
// effective fields (prototype overridden by the .mob), objType the .mob's object type.
export function mobCreatureRace(fields, objType) {
  if (objType !== 15 && objType !== 16) return null;
  const get = n => fields.find(f => f.field === n)?.value;
  const aid = Number(get(F_CURRENT_AID));
  const stat = statRace(get(F_CRITTER_STAT_BASE_IDX));
  if (!Number.isFinite(aid)) return stat ? { race: stat, source: 'race stat' } : null;
  const art = aid >>> 0;
  const flags = Number(get(F_CRITTER_FLAGS) || 0) >>> 0;
  let group = creatureGroup(art);
  if (!group && (art >>> 28) === 0xC) group = 'Monster';
  if (!group && (flags & OCF_UNDEAD)) group = 'Undead';
  if (!group && (flags & OCF_ANIMAL)) group = 'Animal';
  if (group) return { race: group, source: 'art' };
  if (stat && stat !== 'Human') return { race: stat, source: 'race stat' };
  const drawn = artRace(art);
  if (drawn) return { race: drawn, source: 'art' };
  return stat ? { race: stat, source: 'race stat (default)' } : null;
}

export { F_DESCRIPTION };
