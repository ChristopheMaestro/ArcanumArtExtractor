"""
The maps of the modules (data/maps-modules/_Modules/<module>), for the Atlas's "Modules" side.

A module's folder is a map like the game's own castles and caves: sectors (.sec), objects (.mob), startloc.txt (where the player
starts). It is added to the Atlas as one more map of ArcanumMaps, flagged with the module it belongs to, and the people standing
in it are added to ArcanumSubNpcs, so the Atlas draws, lists and filters it with the same code as any other map. Its containers and
items come from build_items.py, its signs from build_notices.py, its doors from build_waypoints.py, its pictures from
build_map_pictures.py --modules.

Writes js/atlas/data/modules.js (window.ArcanumModules), merged into the two globals by modules-merge.js.
Re-run rather than edit:  py build_modules.py
"""
import json
import sys
from pathlib import Path

import arcanum_objects as ao
import npc_roles
import npc_switch
from build_demographics import (KINDS, RACES, OCF_UNDEAD, OCF_ANIMAL, OCF_MONSTER, OCF_MECHANICAL, S_LEVEL, S_ALIGN,
                                person_race_gender)

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ROOT / 'js' / 'atlas' / 'data'                   # the generated data the pages load
MODULES = ao.DATA / 'maps-modules' / '_Modules'
OUT_JS = DATA_JS / 'modules.js'
NPC = 16
F_NAME, F_FLAGS, F_STATS, F_SOURCE = 23, 218, 220, 239
F_PORTRAIT, F_OBJ_FLAGS, OF_OFF = 231, 19, 0x2
FAR = 1500                                   # an object this far from the middle of the map is a stray


SHOWN = ('Dusty Dunes',)                    # the modules the Atlas offers so far


def module_folders():
    return [MODULES / n for n in SHOWN if (MODULES / n).is_dir()]


def start_of(folder):
    p = folder / 'startloc.txt'
    nums = p.read_text(encoding='cp1252', errors='replace').split() if p.is_file() else []
    return [int(nums[0]), int(nums[1])] if len(nums) >= 2 and all(n.lstrip('-').isdigit() for n in nums[:2]) else None


def main():
    protos = {}
    for p in (ao.DATA / 'proto').rglob('*.pro'):
        o = ao.read_proto(p)
        protos[o.proto] = o
    adesc = ao.descriptions()
    switches = npc_switch.Switches()

    maps, sections, npc_rows, creature_rows, place_idx, report = [], [], [], [], {}, []
    for folder in module_folders():
        key = folder.name
        mobs = [(path, ao.read_mob(path)) for path in sorted(folder.glob('*.mob'))]
        pts = [o.tile for _, o in mobs if o.tile]
        if not pts:
            report.append(f'-- {key}: nothing in it: skipped')
            continue
        mx, my = sorted(p[0] for p in pts)[len(pts) // 2], sorted(p[1] for p in pts)[len(pts) // 2]
        pts = [p for p in pts if abs(p[0] - mx) <= FAR * 2 and abs(p[1] - my) <= FAR * 2]
        bbox = [min(p[0] for p in pts) - 10, min(p[1] for p in pts) - 10, max(p[0] for p in pts) + 10, max(p[1] for p in pts) + 10]
        start = start_of(folder)
        mi = len(maps)
        maps.append({'key': key, 'name': key, 'area': None, 'module': key, 'bbox': bbox, 'start': start})
        sections.append({'name': key, 'map': mi, 'group': key, 'view': start or [(bbox[0] + bbox[2]) // 2, (bbox[1] + bbox[3]) // 2], 'labels': []})
        n = 0
        for path, o in mobs:
            if o.type != NPC or not o.tile:
                continue
            e = ao.Effective(o, protos.get(o.proto))
            name = adesc.get(e.int(F_NAME)) or ''
            proto = protos.get(o.proto)
            stats = {**((proto.get(F_STATS) if proto else None) or {}), **(o.get(F_STATS) or {})}
            flags = e.int(F_FLAGS) & 0xFFFFFFFF
            kind = (3 if flags & OCF_UNDEAD else 2 if flags & OCF_MONSTER else 1 if flags & OCF_ANIMAL
                    else 4 if flags & OCF_MECHANICAL else 0)
            race, gender = person_race_gender(e, stats) if kind == 0 else (-1, -1)
            place_idx.setdefault(key, len(place_idx))
            row = ([place_idx[key], o.tile[0], o.tile[1], kind, race, gender, stats.get(S_LEVEL, 0), stats.get(S_ALIGN, 0), name.strip()]
                   + npc_roles.columns(None) + [e.int(F_PORTRAIT)]      # (the scripts and dialogs a module carries are not in data/: no roles)
                   + [(switches.spawner_only(e) or 1) if e.int(F_OBJ_FLAGS) & OF_OFF else 0, path.relative_to(ao.DATA / 'maps-modules').as_posix()])
            (npc_rows if kind == 0 else creature_rows).append(row)
            n += 1
        report.append(f'{key}: {len(list(folder.glob("*.sec")))} sectors, {len(mobs)} objects, {n} people and creatures, bbox {bbox}, start {start}')

    places = [None] * len(place_idx)
    for k, i in place_idx.items():
        places[i] = k
    note = ('maps[i] / sections[i] have the shape of ArcanumMaps (submaps.js) with maps[i].module = the module they belong to; '
            'npcs / creatures have the shape of ArcanumSubNpcs / ArcanumSubCreatures (toolbox/atlas/build_submaps.py); '
            'modules-merge.js adds them to those globals')
    data = {'source': 'toolbox/atlas/build_modules.py', 'note': note, 'modules': [m['key'] for m in maps], 'maps': maps, 'sections': sections,
            'places': places, 'races': RACES, 'kinds': KINDS, 'npcs': npc_rows, 'creatures': creature_rows}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_modules.py - re-run it rather than editing by hand.\nwindow.ArcanumModules = '
                      + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print('\n'.join(report))
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
