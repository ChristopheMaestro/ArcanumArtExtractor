"""
Who lives in Arcanum: every NPC placed in data/maps (.mob), counted by race, gender, level, alignment and place.

Reads the same files as build_items.py and writes js/atlas/data/demographics.js (window.ArcanumPeople). Re-run it rather
than editing the output:  py build_demographics.py
Stats come from F_CRITTER_STAT_BASE_IDX (field 220) laid over the prototype's own, indexed by the game's Stat enum
(stat.h): level 17, alignment 19, gender 26, race 27. Critter flags (field 218, OCF_ in obj_flags.h): the game (critter_is_monstrous, intgame.c) gives an NPC no race when it
is undead, a monster, an animal or mechanical - it is shown as that kind instead - so race and gender are kept for
people only (-1 otherwise).
"""
import json
import re
import sys
from pathlib import Path

import arcanum_objects as ao

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ao.DATA_JS                   # the generated data the pages load
MAPS = ao.DATA / 'maps'
WORLD = 'Arcanum1-024-fixed'
OUT_JS = DATA_JS / 'demographics.js'
NPC = 16
F_NAME, F_FLAGS, F_STATS = 23, 218, 220
S_LEVEL, S_ALIGN, S_GENDER, S_RACE = 17, 19, 26, 27
OCF_UNDEAD, OCF_ANIMAL, OCF_MONSTER, OCF_MECHANICAL = 0x4, 0x8, 0x8000, 0x20000000
RACES = ['Human', 'Dwarf', 'Elf', 'Half-elf', 'Gnome', 'Halfling', 'Half-orc', 'Half-ogre', 'Dark elf', 'Ogre', 'Orc']
KINDS = ['Person', 'Animal', 'Monster', 'Undead', 'Mechanical']


# What the art says (the folder of a person's art: first two letters the body, third the sex - hmm, dff, ghm, efm...). Critter art
# (type 2) packs it in the art id (gender bit 27, body 24-26); unique NPCs (type 0xD) name a folder in unique_npc.mes.
ART_BODIES = ['hm', 'df', 'gh', 'hg', 'ef']
UNIQUE_NPC_FOLDERS = ['hmmbs', 'hmmtn', 'hmmvg', 'ghmvg', 'hmmki', 'ghmst', 'hmmgb', 'effvg', 'efmvg', 'ghmv2', 'ghfvg', 'hmfvg', 'dfmvg',
                      'effsl', 'efmax', 'hmmpn', 'ghfcd', 'hmfc2']          # (the ones after these are not people)
# the races each body of the art can stand for; the first is the one used when the stats name none of them
BODY_RACES = {'hm': ['Human', 'Half-elf', 'Half-orc'], 'df': ['Dwarf'], 'gh': ['Halfling', 'Gnome'],
              'hg': ['Half-ogre', 'Half-orc', 'Ogre', 'Orc'], 'ef': ['Elf', 'Dark elf', 'Half-elf']}


def art_body_sex(aid):
    """(body, sex) of a person's art id, sex 0 female / 1 male; None when the art says neither (scenery art, a creature...)."""
    raw = aid & 0xFFFFFFFF
    if raw >> 28 == 2 and (raw >> 24) & 7 < len(ART_BODIES):
        return ART_BODIES[(raw >> 24) & 7], (raw >> 27) & 1
    if raw >> 28 == 0xD and (raw >> 20) & 0xFF < len(UNIQUE_NPC_FOLDERS):
        folder = UNIQUE_NPC_FOLDERS[(raw >> 20) & 0xFF]
        return folder[:2], 1 if folder[2] == 'm' else 0
    return None


def person_race_gender(e, stats):
    """(race index into RACES, gender) of a person: the art decides, the stats refine it (the art has five bodies, the game
    eleven races: a gnome and a halfling look alike). A female elf is drawn with the human body (name_normalize_aid)."""
    race, gender = stats.get(S_RACE, 0), stats.get(S_GENDER, 0) & 1
    race = race if 0 <= race < len(RACES) else 0
    art = art_body_sex(e.int(1))
    if art:
        body, gender = art
        ok = BODY_RACES[body] + (['Elf', 'Dark elf'] if body == 'hm' and not gender else [])
        if RACES[race] not in ok:
            race = RACES.index(ok[0])
    return race, gender


def main():
    desc = ao.descriptions()
    protos = {}
    for p in (ao.DATA / 'proto').rglob('*.pro'):
        o = ao.read_proto(p)
        protos[o.proto] = o

    world_place = {}
    wl = DATA_JS / 'world-labels.js'
    if wl.exists():
        data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))
        world_place = {p['worldFolder']: p['name'] for p in data['places'] if p.get('worldFolder')}

    places, place_idx, rows = [], {}, []
    for path in sorted(MAPS.rglob('*.mob')):
        o = ao.read_mob(path)
        if o.type != NPC:
            continue
        proto = protos.get(o.proto)
        rel = path.relative_to(MAPS).parts
        if rel[0] == WORLD:
            place = world_place.get(rel[1] if len(rel) > 2 else '', rel[1] if len(rel) > 2 else 'Wilderness')
        else:
            place = ao.clean_map(rel[0])
        e = ao.Effective(o, proto)
        name = (desc.get(e.int(F_NAME)) or '').strip()
        stats = {**((proto.get(F_STATS) if proto else None) or {}), **(o.get(F_STATS) or {})}
        flags = e.int(F_FLAGS) & 0xFFFFFFFF
        # intgame.c (portrait of an NPC): undead, then monster, animal, mechanical; only the rest are told apart by race
        kind = (3 if flags & OCF_UNDEAD else 2 if flags & OCF_MONSTER else 1 if flags & OCF_ANIMAL
                else 4 if flags & OCF_MECHANICAL else 0)
        race, gender = person_race_gender(e, stats) if kind == 0 else (-1, -1)
        if place not in place_idx:
            place_idx[place] = len(places)
            places.append(place)
        rows.append([place_idx[place], kind, race, gender,
                     stats.get(S_LEVEL, 0), stats.get(S_ALIGN, 0), name])

    out = {'source': 'toolbox/atlas/build_demographics.py', 'races': RACES, 'kinds': KINDS, 'places': places,
           'note': 'people[i] = [place, kind, race, gender (0 female / 1 male), level, alignment, name]', 'people': rows}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_demographics.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumPeople = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    by = {}
    for r in rows:
        by[r[1]] = by.get(r[1], 0) + 1
    print(f'{len(rows)} NPCs in {len(places)} places: ' + ', '.join(f'{KINDS[k]} {n}' for k, n in sorted(by.items())))
    print(f'Wrote {OUT_JS} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
