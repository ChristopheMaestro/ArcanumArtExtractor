"""
Everyone who stands on the world map: every NPC .mob under data/maps/Arcanum1-024-fixed, with the tile it stands on.

Writes js/atlas/data/npcs.js (window.ArcanumNpcs, the people) and js/atlas/data/creatures.js (window.ArcanumCreatures: animals,
monsters, undead, mechanical); the Atlas map (the map view of index.html) draws them as pins. People are shown by default;
creatures are only loaded and drawn when the player turns them on. Re-run rather than edit:  py build_npcs.py
The fields are the same ones build_demographics.py reads (see its header for the stat numbers and critter flags); on top
of those: field 2 = tile, field 23 = name, field 239 = InvenSource list the NPC rolls from (a merchant's stock),
field 238 = what the NPC carries (the items themselves are in items.js; the map joins them by place and tile).
"""
import json
import re
import sys
from pathlib import Path

import arcanum_objects as ao
import npc_roles
import npc_switch
from build_demographics import KINDS, RACES, OCF_UNDEAD, OCF_ANIMAL, OCF_MONSTER, OCF_MECHANICAL, S_LEVEL, S_ALIGN, person_race_gender

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ao.DATA_JS                   # the generated data the pages load
MAPS = ao.DATA / 'maps'
WORLD = 'Arcanum1-024-fixed'
OUT_JS = DATA_JS / 'npcs.js'
CREATURES_JS = DATA_JS / 'creatures.js'
NPC = 16
F_NAME, F_FLAGS, F_STATS, F_INVENTORY, F_SOURCE, F_MARKUP = 23, 218, 220, 238, 239, 293     # F_NPC_RETAIL_PRICE_MULTIPLIER
F_PORTRAIT = 231                                                                              # OBJ_F_CRITTER_PORTRAIT
F_OBJ_FLAGS, OF_OFF = 19, 0x2                                                                 # OBJ_F_FLAGS: off until a script turns it on


class RowMaker:
    """One NPC .mob -> its row in npcs.js / creatures.js. version: a game_files.Version (None = the base game): every table, prototype, script and
    dialog it reads (names, roles, switched-off state) is the game's with the version's layers over it."""
    def __init__(self, version=None):
        import game_files
        self.version = version or game_files.Version('base')
        self.desc = self.version.descriptions()
        self.roles = npc_roles.Roles(version=self.version if len(self.version.roots) > 1 else None)
        self.switches = npc_switch.Switches(version=self.version if len(self.version.roots) > 1 else None)
        self.protos = dict(self.version.protos())
        self.world_place = {}
        wl = DATA_JS / 'world-labels.js'
        if wl.exists():
            data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))
            self.world_place = {p['worldFolder']: p['name'] for p in data['places'] if p.get('worldFolder')}
        self.places, self.place_idx = [], {}

    def row(self, path, area, file):
        """path: the .mob; area: the town folder it sits in ('' = the wilderness); file: what the Advanced view opens. None: not an NPC."""
        o = ao.read_mob(path)
        if o.type != NPC or not o.tile:
            return None
        place = self.world_place.get(area, area or 'Wilderness')
        e = ao.Effective(o, self.protos.get(o.proto))
        name = (self.desc.get(e.int(F_NAME)) or '').strip()
        proto = self.protos.get(o.proto)
        stats = {**((proto.get(F_STATS) if proto else None) or {}), **(o.get(F_STATS) or {})}
        flags = e.int(F_FLAGS) & 0xFFFFFFFF
        kind = (3 if flags & OCF_UNDEAD else 2 if flags & OCF_MONSTER else 1 if flags & OCF_ANIMAL
                else 4 if flags & OCF_MECHANICAL else 0)
        race, gender = person_race_gender(e, stats) if kind == 0 else (-1, -1)
        if place not in self.place_idx:
            self.place_idx[place] = len(self.places)
            self.places.append(place)
        cols = npc_roles.columns(self.roles.of(e) if kind == 0 else None)
        return [self.place_idx[place], o.tile[0], o.tile[1], kind, race, gender, stats.get(S_LEVEL, 0), stats.get(S_ALIGN, 0),
                name] + cols + [e.int(F_PORTRAIT), self.switches.explain(e) if e.int(F_OBJ_FLAGS) & OF_OFF else 0, file]


def main():
    maker = RowMaker()
    places, rows = maker.places, []
    for path in sorted((MAPS / WORLD).rglob('*.mob')):
        rel = path.relative_to(MAPS).parts
        r = maker.row(path, rel[1] if len(rel) > 2 else '', path.relative_to(MAPS).as_posix())
        if r:
            rows.append(r)

    note = ('npcs[i] = [place, tile x, tile y, kind (0 person / 1 animal / 2 monster / 3 undead / 4 mechanical), '
            'race (people only, else -1), gender (0 female / 1 male, people only), level, alignment, name, '
            'shopkeeper (0 / 1: their dialog opens the barter screen), price multiplier in % (shopkeepers), '
            'role (0, or {j: 1 joins your party, t: ["Master Bow", ...] trains you}), all from the dialog (npc_roles.py), '
            'portrait (field 231, a gameport.mes number; 0 = none: portraits.js), '
            'off (0, or OF_OFF is set, the NPC is switched off: 1 = no script was found that turns them on, a string = what turns them on, '
            'an object {k: "spawner" | "helper", t: what it is, w: [what else matters]} = an invisible spawner / script holder, npc_switch.py), '
            'file (the .mob, path under data/maps: the Advanced view links to it)]')
    # people are what the map shows by default; creatures sit in a file of their own that is only loaded on request
    for js, var, subset in ((OUT_JS, 'ArcanumNpcs', [r for r in rows if r[3] == 0]),
                            (CREATURES_JS, 'ArcanumCreatures', [r for r in rows if r[3] != 0])):
        out = {'source': 'toolbox/atlas/build_npcs.py', 'races': RACES, 'kinds': KINDS, 'places': places, 'note': note, 'npcs': subset}
        js.write_text(f'// GENERATED by toolbox/atlas/build_npcs.py - re-run it rather than editing by hand.\nwindow.{var} = '
                      + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
        print(f'Wrote {js.name}: {len(subset)} NPCs ({js.stat().st_size // 1024} KB)')
    by = {}
    for r in rows:
        by[r[3]] = by.get(r[3], 0) + 1
    print(f'{len(rows)} NPCs on the world map in {len(places)} places: ' + ', '.join(f'{KINDS[k]} {n}' for k, n in sorted(by.items())))
    print(f'  {sum(1 for r in rows if r[-2])} switched off (OF_OFF), {sum(1 for r in rows if not r[8])} without a name, {sum(1 for r in rows if r[9])} shopkeepers, '
          f'{sum(1 for r in rows if r[11] and r[11].get("j"))} followers, {sum(1 for r in rows if r[11] and r[11].get("t"))} trainers')


if __name__ == '__main__':
    sys.exit(main())
