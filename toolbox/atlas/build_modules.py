"""
The maps of the modules (data/modules/<module>), for the Atlas's "Modules" side.

A module's folder is a map like the game's own castles and caves: sectors (.sec), objects (.mob), startloc.txt (where the player
starts). It is added to the Atlas as one more map of ArcanumMaps, flagged with the module it belongs to, and the people standing
in it are added to ArcanumSubNpcs, so the Atlas draws, lists and filters it with the same code as any other map. Its containers and
items come from build_items.py, its signs from build_notices.py, its doors from build_waypoints.py, its pictures from
build_map_pictures.py --modules.

Writes js/atlas/data/modules.js (window.ArcanumModules), merged into the two globals by modules-merge.js.
Re-run rather than edit:  py build_modules.py
"""
import json
import os
import re
import sys
from pathlib import Path

import arcanum_objects as ao
import game_files
import sec_alias
import asset_refs as ar
import build_notices
import build_waypoints
import npc_roles
import npc_switch
from progress import say
from build_demographics import (KINDS, RACES, OCF_UNDEAD, OCF_ANIMAL, OCF_MONSTER, OCF_MECHANICAL, S_LEVEL, S_ALIGN,
                                person_race_gender)

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ao.DATA_JS                   # the generated data the pages load
MODULES = ao.DATA / 'modules'
OUT_JS = DATA_JS / 'modules.js'
NPC = 16
F_NAME, F_FLAGS, F_STATS, F_SOURCE = 23, 218, 220, 239
F_PORTRAIT, F_OBJ_FLAGS, OF_OFF = 231, 19, 0x2
FAR = 1500                                   # an object this far from the middle of the map is a stray


SHOWN = ('Buried Secrets','DarkRiver', 'Dungeon Crawl 2', 'Dusty Dunes', 'Hellgate', 'Lost Dungeon of Souls', 'Vormantown', 'Bourrin', 'MuHu', 'Deathmatch', 'Time', 'Woodmir Race', 'Affaire', 'Livre Ombres', 'Mystere', 'Naufrageur', 'Resident Eval', 'Secret', 'Tombeau', 'Tresor', 'Vallee', 'Battlearena', 'Deep15', 'Delirium of Evil', 'Doomsday', 'Dungeon of Quests', 'Escape Tarant', 'Grayhills', 'Terror', 'The Killer Inside', 'Virgil the Pervert', 'WhiteSands', 'Arcanum City', 'Hell Day', 'Addon01', 'Dolores 0.25', 'UltimateArcanum', 'Dungeon Crawl 1', 'Holliae', 'CrossRoad 2.1')                   # the modules the Atlas offers so far
MAIN_MAP = {'Vormantown': 'maps/Multiplayer-Map', 'Bourrin': 'maps/bourin', 'Buried Secrets': 'maps/MainMap', 'Dusty Dunes': 'maps/Dusty Dunes', 'Hellgate': 'maps/Main', 'Hell Day': 'maps/Main', 'Arcanum City': 'maps/Island Arcanum-City', 'Addon01': 'maps/village01', 'Lost Dungeon of Souls': 'maps/MainMap', 'UltimateArcanum': 'maps/Main', 'Dungeon Crawl 1': 'maps/start', 'Holliae': 'maps/Ile_principale'}   # a full module (dlg, scr, maps/...): the map folder the Atlas shows (not its _original backup, not ShopMap)
ALL_MAPS = ('MuHu', 'Deathmatch', 'Time', 'Woodmir Race', 'Affaire', 'Livre Ombres', 'Mystere', 'Naufrageur', 'Resident Eval', 'Secret', 'Tombeau', 'Tresor', 'Vallee', 'Battlearena', 'Deep15', 'Delirium of Evil', 'Doomsday', 'Dungeon of Quests', 'Escape Tarant', 'Grayhills', 'Terror', 'The Killer Inside', 'Virgil the Pervert', 'WhiteSands', 'Dolores 0.25', 'CrossRoad 2.1')                     # a full module whose every map (maps/<name>, but ShopMap and the ones with no objects) is shown, as "<module> - <name>"
NOT_SHOWN = {'ShopMap'}
NOT_WAYS = {'Holliae': ('Passer le jour',)}      # module -> part of the name of scripts whose teleports are not shown as waypoints (user, 2026-10-25)


def owned(key):
    """The modules a version has a build of its own for: a copy in data/mods/<mod>/modules/<module> (any of its layers). The others are the
    base game's under every mod (the pages show them with the base game's data: version-data.js, module-index.js)."""
    return [n for n in SHOWN if any((ao.DATA / 'mods' / m / 'modules' / n).is_dir() for m in game_files.MODS.get(key, []))]


def module_folders():
    key = os.environ.get('ATLAS_VERSION', 'base')            # (a mod's run: only the modules it has a copy of)
    names = SHOWN if key == 'base' else owned(key)
    return [MODULES / n for n in names if (MODULES / n).is_dir()]


def map_folder(folder):
    """Where a module's sectors / objects / startloc.txt are: the module folder itself, or its main map's folder."""
    return folder / MAIN_MAP[folder.name] if folder.name in MAIN_MAP else folder


_ENTRIES = []


def entries():
    """The maps the Atlas shows: (key, module folder, map folder). A module is one map, except the ALL_MAPS ones (one map per folder).
    Read once per process (about 4 s: every map folder of every module is listed), however many builders ask."""
    if not _ENTRIES:
        _ENTRIES.append(_entries())
    return list(_ENTRIES[0])


def _entries():
    out = []
    for module in module_folders():
        if module.name in ALL_MAPS:
            for sub in sorted((module / 'maps').iterdir(), key=lambda p: p.name.lower()):
                if sub.is_dir() and sub.name not in NOT_SHOWN and ao.has_suffix(sub, '.mob') and not sub.name.endswith('_original'):
                    out.append((f'{module.name} - {sub.name}', module, sub))
        else:
            out.append((module.name, module, map_folder(module)))
    return out


def start_of(folder):
    p = folder / 'startloc.txt'
    nums = ao.read_text(p).split() if p.is_file() else []
    if len(nums) >= 2 and all(n.lstrip('-').isdigit() for n in nums[:2]):
        return [int(nums[0]), int(nums[1])]
    for up in folder.parents[:3]:                       # no startloc.txt (Bourrin): the START_MAP line of the module's Rules/MapList.mes
        ml = up / 'Rules' / 'MapList.mes'
        if ml.is_file():
            m = re.search(r'\{\s*%s\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*Type:\s*START_MAP' % re.escape(folder.name),
                          ao.read_text(ml), re.I)
            return [int(m.group(1)), int(m.group(2))] if m else None
    return None


def start_map(module):
    """The folder name (lower case) of the map a module starts on: the START_MAP line of its Rules/MapList.mes, else None."""
    ml = module / 'Rules' / 'MapList.mes'
    for v in (ao.mes(ml).values() if ml.is_file() else ()):
        if re.search(r'Type:\s*START_MAP', v, re.I):
            return v.split(',')[0].strip().lower()
    return None


def mob_files(ver, module, folder):
    """The .mob files of a module's map: the module's own, with the mod's copy of the module (when the version has one: it keeps only the files it
    changes) laid over them by file name."""
    out = {p.name.lower(): p for p in folder.glob('*.mob')}
    rel = folder.relative_to(module)
    for d in ver.module_dirs[1:]:
        for p in (d / rel).glob('*.mob'):
            out[p.name.lower()] = p
    return [out[k] for k in sorted(out)]


def doors_and_signs(module, folder, key, desc, keys, ver, mobs=None, secs=None):
    """The waypoints and signs of a module, read from its scripts and dialogs with the layers of the version over them (the shapes of waypoints.js /
    notices.js). The destination of a teleport is a number of the module's Rules/MapList.mes; only the ones that name a shown map of the module
    are kept (keys: map folder name in lower case -> the Atlas key of that map)."""
    scr_dir, dlg_dir = ver.tree('scr'), ver.tree('dlg')
    tp = build_waypoints.teleports(scr_dir)
    ptp = build_waypoints.people_teleports(scr_dir)     # (the teleports that move the player: a person who takes you somewhere)
    for n in NOT_WAYS.get(module.name, ()):             # (scripts whose teleport is no way anywhere: Holliae's "Passer le jour" on 437 tiles)
        for f in Path(scr_dir).glob(f'*{n}*.scr') if Path(scr_dir).is_dir() else ():
            num = int(re.match(r'\d+', f.name).group()) if re.match(r'\d+', f.name) else None
            tp.pop(num, None)
            ptp.pop(num, None)
    scripts = build_notices.read_scripts(scr_dir)
    ids = {}
    ml = module / 'Rules' / 'MapList.mes'
    for k, v in (ao.mes(ml).items() if ml.is_file() else ()):
        ids[k] = v.split(',')[0].strip()
    # a mod's copy of the module may lead to the mod's own number of a map (CE's Lost Dungeon of Souls teleports to 5093, which CE's MapList.mes
    # names "Lost Dungeon of Souls", the module's own 5001 "MainMap"): its lines that name a map of the module, or the module itself when it has
    # one map, count too (the module's own number wins)
    alias = dict(keys, **({module.name.lower(): next(iter(keys.values()))} if len(set(keys.values())) == 1 else {}))
    for r in ver.copy_owners:
        for k, v in ao.mes(r / 'Rules' / 'MapList.mes').items():
            name = v.split(',')[0].strip()
            if name.lower() in alias and k not in ids:
                ids[k] = name
    shown = {k: alias[name.lower()] for k, name in ids.items() if name.lower() in alias}
    protos = ar.Protos()
    doors, signs = [], []                               # (x, y, what, script, object)
    things, on_tiles = [], []                           # (object, file) of what could stand on a tile script / jump point; (x, y, script, file)
    people = []                                         # (x, y, name, [scripts], object): the people who move the player (build_waypoints.person_way)

    def see(file, o, from_sec):
        if o.type in build_waypoints.WALKED and o.tile:
            things.append((o, file))
        way = build_waypoints.person_way(o, ptp, desc)
        if way:
            people.append((o.tile[0], o.tile[1], way[0], way[1], ar.ref(file, o, protos)))
        if o.type not in build_notices.THINGS or not o.tile:
            return
        name = (desc.get(o.proto - 20) or '').strip()
        for hook, num in build_notices.hooked(o):
            if num in scripts and (o.type != 2 or from_sec):        # (a container of a .mob is shown as a container, which says what it says: items.js)
                text = build_notices.says(scripts, num, o, hook, scr_dir, dlg_dir)      # (this object's lines: its counters pick them)
                signs.append((o.tile[0], o.tile[1], name, num, ar.ref(file, o, protos), text))
        for num in build_waypoints.scripts_of(o):
            if num in tp:
                doors.append((o.tile[0], o.tile[1], name, num, ar.ref(file, o, protos)))

    for sec in secs if secs is not None else sec_alias.rglob(folder, '*.sec'):     # (main() passes the list it has: a folder listing is slow on this disk)
        file = '../' + sec_alias.home(sec).relative_to(ao.DATA).as_posix()
        for o in ao.sec_objects(sec):
            see(file, o, True)
        sid = int(sec.stem)
        for tile, num in build_waypoints.tile_scripts(sec.read_bytes()):
            if num in tp:
                on_tiles.append((((sid & 0x3FFFFFF) << 6) + (tile & 63), ((sid >> 26) << 6) + ((tile >> 6) & 63), num, file))
    for mob, o in mobs if mobs is not None else ((m, ao.read_mob(m)) for m in mob_files(ver, module, folder)):     # (main() passes the ones it has read)
        see('../' + mob.relative_to(ao.DATA).as_posix(), o, False)

    def element(x, y):                                  # (name, object, tile) of the portal standing on a tile script / jump point (build_waypoints.standing)
        s = build_waypoints.standing(things, x, y)
        return ((desc.get(s[0].proto - 20) or '').strip(), ar.ref(s[1], s[0], protos), tuple(s[0].tile)) if s else None

    for x, y, num, file in on_tiles:                    # a tile script: the portal on the tile is the waypoint, the script added to its own
        el = element(x, y)
        if el:
            what, obj, (x, y) = el
            obj[4] = obj[4] + [[-1, num]]
        else:
            what, obj = '', [file, 0, 0, 0, [[-1, num]]]
        doors.append((x, y, what, num, obj))

    def merged(rows):                                   # one per door / sign: the objects of one script that stand together
        out = []
        for r in sorted(rows, key=lambda r: (r[3], r[0], r[1])):
            if not any(d[3] == r[3] and abs(d[0] - r[0]) <= build_waypoints.MERGE and abs(d[1] - r[1]) <= build_waypoints.MERGE for d in out):
                out.append(r)
        return out

    stems = {int(m.group(1)): f.stem for f in scr_dir.glob('*.scr') if (m := re.match(r'(\d+)', f.name))}

    def goes_to(num, dest):                             # the script is named for the way it leads: "00002Vormantown_to_Elf-Island_TEL"
        m = re.search(r'_to_(.+?)(?:_TEL)?$', stems.get(num, ''), re.I)
        return re.sub(r'[-_]+', ' ', m.group(1)).strip() if m else dest

    waypoints = []
    for x, y, what, num, obj in merged(doors):
        to = [[shown[mid], goes_to(num, shown[mid]), tx, ty] for mid, tx, ty in tp[num] if mid in shown]
        if to:
            waypoints.append([key, key, x, y, what, to, obj])
    own_spot = lambda t, x, y: t[0] == key and abs(t[2] - x) <= build_waypoints.OWN_SPOT and abs(t[3] - y) <= build_waypoints.OWN_SPOT
    for x, y, what, nums, obj in people:                # a person who takes the player elsewhere (not to where they stand)
        labels = build_waypoints.dialog_labels(nums, scr_dir, dlg_dir)       # (within the map: named by the dialog option that goes there)
        to = [t + ([labels[(mid, t[2], t[3])]] if t[0] == key and (mid, t[2], t[3]) in labels else [])
              for n in nums for mid, tx, ty in ptp[n] if mid in shown
              for t in [[shown[mid], goes_to(n, shown[mid]), tx, ty]] if not own_spot(t, x, y)]
        to = list({(t[0], t[2], t[3]): t for t in to}.values())
        if to:
            waypoints.append([key, key, x, y, what, to, obj])
    # the jump points (map.jmp): the way out of a house or a cave, no script. Neighbouring tiles to one place are one waypoint,
    # and a script door there to the same place stands for it (as in build_waypoints.py)
    for x, y, mid, tx, ty in build_waypoints.jump_points(folder):
        to = key if mid is None else shown.get(mid)     # (None: a jump within this map)
        same = lambda t: t[0] == to and (mid is not None or abs(t[2] - tx) <= 6 and abs(t[3] - ty) <= 6)     # (within a map: to the same spot)
        if to is None or any(abs(w[2] - x) <= 6 and abs(w[3] - y) <= 6 and any(same(t) for t in w[5]) for w in waypoints):
            continue
        what, obj, (x, y) = element(x, y) or ('Exit', None, (x, y))
        waypoints.append([key, key, x, y, what or 'Exit', [[to, to, tx, ty]], obj])
    notices = []
    seen = set()
    for x, y, what, num, obj, text in sorted(signs, key=lambda r: (r[3], r[0], r[1])):      # one notice per object (as build_notices.py)
        if (x, y, num, obj[0], obj[2]) in seen:
            continue
        seen.add((x, y, num, obj[0], obj[2]))
        if text:
            notices.append([key, key, x, y, build_notices.title_of(what, text), text, obj])
    return waypoints, notices


def main():
    key_env = os.environ.get('ATLAS_VERSION', 'base')         # the version being built (run_version.py): a mod's files lie over the base game's, the module's over those
    quick = '--quick' in sys.argv                             # the maps and their people only (run_module_pipeline.py's first step, so the new maps show while
                                                              # the pictures render): no roles, no "switched off because", no doors or signs; the last step redoes it all
    if quick:
        say('--quick: maps and people only (no roles, no switch explanations, no doors or signs)')
    else:
        say(f'version "{key_env}": what switches the game\'s people on (scripts of {ao.DATA})')
    switches = None if quick else npc_switch.Switches()

    maps, sections, npc_rows, creature_rows, place_idx = [], [], [], [], {}
    waypoints, notices = [], []
    cache = {}                                            # per module: what its maps share
    all_entries = entries()
    say(f'{len(all_entries)} maps in {len(module_folders())} modules')
    for i, (key, module, folder) in enumerate(all_entries, 1):
        if module.name not in cache:
            say(f'[{i}/{len(all_entries)}] module {module.name}: names, prototypes'
                + (', what switches its people on' if (module / 'scr').is_dir() else '') + (', its dialogs' if (module / 'dlg').is_dir() else ''))
            ver = game_files.Version(key_env, module.name)            # base game + (the mod) + the module + (the mod's copy of the module)
            cache[module.name] = (ver.descriptions(),                 # (names from 30000 up: the layers' gamedesc.mes, the module's own over the others)
                                  npc_switch.Switches(version=ver) if (module / 'scr').is_dir() and not quick else None,     # (what switches its people on: the scripts of the layers)
                                  npc_roles.Roles(version=ver) if (module / 'dlg').is_dir() and not quick else None,         # (its dialogs, over the game's)
                                  ver.protos(), ver)
        adesc, own_switches, roles, protos, ver = cache[module.name]
        keys = {f.name.lower(): k for k, m, f in all_entries if m == module}
        mobs = [(path, ao.read_mob(path)) for path in mob_files(ver, module, folder)]
        pts = [o.tile for _, o in mobs if o.tile]
        if not pts:
            say(f'-- {key}: nothing in it: skipped')
            continue
        mx, my = sorted(p[0] for p in pts)[len(pts) // 2], sorted(p[1] for p in pts)[len(pts) // 2]
        pts = [p for p in pts if abs(p[0] - mx) <= FAR * 2 and abs(p[1] - my) <= FAR * 2]
        bbox = [min(p[0] for p in pts) - 10, min(p[1] for p in pts) - 10, max(p[0] for p in pts) + 10, max(p[1] for p in pts) + 10]
        start = start_of(folder)
        sec_files = sec_alias.rglob(folder, '*.sec')                 # (listed once: also for doors_and_signs and the count below)
        secs = {int(p.stem) for p in sec_files if p.stem.isdigit()}
        on_sector = start and ((start[1] // 64) << 26 | start[0] // 64) in secs        # (Lost Dungeon of Souls starts 22 tiles past its last object)
        if start and not on_sector and not (bbox[0] <= start[0] <= bbox[2] and bbox[1] <= start[1] <= bbox[3]):
            start = [mx, my]                     # a startloc.txt that points off the map (DarkRiver): the middle of the objects
        mi = len(maps)
        maps.append({'key': key, 'name': key, 'area': None, 'module': module.name, 'bbox': bbox, 'start': start})
        if folder.name.lower() == start_map(module) or sum(1 for _, m, _ in all_entries if m == module) == 1:
            maps[-1]['main'] = True              # the map the module starts on (the Modules list opens it from the module's own row)
        sections.append({'name': key, 'map': mi, 'group': module.name,'view': start or [(bbox[0] + bbox[2]) // 2, (bbox[1] + bbox[3]) // 2], 'labels': []})
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
                   + npc_roles.columns(roles.of(e) if roles and kind == 0 else None) + [e.int(F_PORTRAIT)]
                   + [(own_switches.explain(e) if own_switches else ((switches.spawner_only(e) or 1) if switches else 1)) if e.int(F_OBJ_FLAGS) & OF_OFF else 0,
                      path.relative_to(ao.DATA).as_posix()])
            (npc_rows if kind == 0 else creature_rows).append(row)
            n += 1
        if (module / 'scr').is_dir() and not quick:
            w, s = doors_and_signs(module, folder, key, adesc, keys, ver, mobs, sec_files)
            waypoints += w
            notices += s
            say(f'  {key}: {len(w)} doors and ladders, {len(s)} signs (from its scripts)')
        say(f'{key}: {sum(1 for p in sec_files if len(sec_alias.rel(p, folder).parts) == 1)} sectors, {len(mobs)} objects, {n} people and creatures, bbox {bbox}, start {start}')

    places = [None] * len(place_idx)
    for k, i in place_idx.items():
        places[i] = k
    note = ('maps[i] / sections[i] have the shape of ArcanumMaps (submaps.js) with maps[i].module = the module they belong to; '
            'npcs / creatures have the shape of ArcanumSubNpcs / ArcanumSubCreatures (toolbox/atlas/build_submaps.py); '
            'modules-merge.js adds them to those globals')
    data = {'source': 'toolbox/atlas/build_modules.py', 'note': note, 'modules': list(dict.fromkeys(m['module'] for m in maps)), 'maps': maps, 'sections': sections,
            'places': places, 'races': RACES, 'kinds': KINDS, 'npcs': npc_rows, 'creatures': creature_rows,
            'waypoints': waypoints, 'notices': notices}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_modules.py - re-run it rather than editing by hand.\nwindow.ArcanumModules = '
                      + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB)')
    if key_env == 'base':
        write_index()


def write_index():
    """js/atlas/data/module-index.js: the modules each mod has a build of its own for (listed in blue; the others are the base game's,
    spliced into the mod's files by splice_modules.py)."""
    owned_by = {k: owned(k) for k in game_files.MODS if k != 'base'}
    out = DATA_JS / 'module-index.js'
    j = lambda v: json.dumps(v, ensure_ascii=False, separators=(', ', ': '))
    mods = ',\n'.join(f'    {j(k)}: {j(v)}' for k, v in owned_by.items())
    out.write_text('// GENERATED by toolbox/atlas/build_modules.py: which modules each mod has its own build of (data/mods/<mod>/modules/<module>)\n'
                   'window.AtlasModuleIndex = {\n  "owned": {\n' + mods + '\n  }\n};\n', encoding='utf-8')
    print(f'Wrote {out.name}: owned ' + ', '.join(f'{k} {len(v)}' for k, v in owned_by.items()))


if __name__ == '__main__':
    sys.exit(main())
