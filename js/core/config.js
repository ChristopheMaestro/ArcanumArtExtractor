// Data-folder roots used to fetch game files.

export const DATA_ROOT = 'data/';
// The .mob and .sec explorers list from data/ (maps, mods, modules): their folder paths are under data/.
export const MOB_ROOT = DATA_ROOT;

export const PRO_ROOT = `${DATA_ROOT}proto/`;
export const PORTAL_ART_ROOT = `${DATA_ROOT}art/portal/`;

export const CRITTER_ART_ROOT = `${DATA_ROOT}art/critter/`;
export const MONSTER_ART_ROOT = `${DATA_ROOT}art/monster/`;

export const UNIQUE_NPC_ART_ROOT = `${DATA_ROOT}art/unique_npc/`;
export const ART_ROOT = `${DATA_ROOT}art/`;

export const SEC_ROOT = DATA_ROOT;

// Lookup files built from data/ by the toolbox (file lists, search text, alias lists), not game data:
// files/ (toolbox/file_index.py, module_template_index.py), search/ (search_text.py), aliases/ (dedupe_sectors.py, dedupe_art.py).
export const INDEX_ROOT = 'js/index/';

// Thumbnail sheets of the .ART grid (toolbox/build_art_thumbs.py), not game data.
export const ART_THUMBS_ROOT = 'js/art/art-thumbs/';
