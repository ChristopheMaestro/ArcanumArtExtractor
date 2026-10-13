"""
The game's other maps (castles, caves, basements, separate towns): every map of Rules/MapList.mes except the world map.

The Atlas draws each of them black (their pictures are made later) with what the game files hold:
  * the people (and, on request, the creatures) standing in it - every NPC .mob of the map folder;
  * its containers and carried items (items.js joins them by map name);
  * the Map Explorer's labels for it, put on game tiles the way locate_world_labels.py does it for the world map
    (labels that name an object of the folder sit on that object; the rest follow the fit of the screenshot), except
    the labels about a person or a container: those come from the .mob files alone (locate_world_labels.mob_backed).
The Map Explorer cuts some big maps into several pictures (Wheel Clan: Town, Mine, Castle...; the Void: one per island).
Each picture becomes a "section": a named viewpoint on the one black map the game has.

Writes js/atlas/data/submaps.js (window.ArcanumMaps: maps + sections, window.ArcanumSubNpcs: the people) and
js/atlas/data/subcreatures.js (window.ArcanumSubCreatures: loaded only when the player asks for creatures).
Needs: Playwright with Chromium (to read the Map Explorer's databases), numpy.   py build_submaps.py
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import arcanum_objects as ao
import locate_world_labels as L
import npc_roles
import npc_switch
from build_demographics import (KINDS, RACES, OCF_UNDEAD, OCF_ANIMAL, OCF_MONSTER, OCF_MECHANICAL, S_LEVEL, S_ALIGN,
                                person_race_gender)

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ROOT / 'js' / 'atlas' / 'data'                   # the generated data the pages load
MAPS = ao.DATA / 'maps'
WORLD = 'Arcanum1-024-fixed'
OUT_JS = DATA_JS / 'submaps.js'
OUT_CREATURES = DATA_JS / 'subcreatures.js'
REPORT = Path(__file__).resolve().parent / 'reports' / 'submaps-report.txt'
NPC = 16
F_NAME, F_FLAGS, F_STATS, F_SOURCE, F_MARKUP = 23, 218, 220, 239, 293      # F_NPC_RETAIL_PRICE_MULTIPLIER
F_PORTRAIT = 231                                                            # OBJ_F_CRITTER_PORTRAIT
F_OBJ_FLAGS, OF_OFF = 19, 0x2                                               # OBJ_F_FLAGS: off until a script turns it on
A0 = 1 / (40 * 0.502)          # screenshot px -> tiles: the scale every Map Explorer picture shares (world-labels-report.txt)

# Map Explorer picture -> map folder. Pictures not listed here are matched by name (the folder's own name).
PICTURE_FOLDER = {
    'The Black Mountain Mines': 'BMC', 'The Black Mountain Mines - Entrance': 'BMC', 'The Black Mountain Mines - Level 1': 'BMC',
    'The Black Mountain Mines - Level 2': 'BMC', 'The Black Mountain Mines - Castle': 'BMC',
    'Ancient Temple - Underground': 'Temple of the Derian Ka',
    'Ashbury Crematorium - Level 1': 'Crematorium-lev 1', 'Ashbury Crematorium - Level 2': 'Crematorium-lev 2',
    'Ashbury Crematorium - Level 3': 'Crematorium-lev 3',
    'Haunted Castle - Ground Floor': 'Ashbury Haunted Castle', 'Haunted Castle - Basement': 'Ashbury Haunted Castle',
    'Haunted Castle - Upstairs': 'Ashbury Haunted Castle',
    'Scienticians Underground': 'Ashbury-Scienticians Underground',
    'Caladon Castle - Basement': 'Caladon-Castle Main Floor', 'Caladon Castle - Main Floor': 'Caladon-Castle Main Floor',
    'Caladon Castle - Upstairs': 'Caladon-Castle Main Floor', 'Caladon Castle - Vents': 'Caladon-Castle Main Floor',
    'Caladon Panarii Temple - Catacombs': 'Caladon-Panarrii Temple-Basement',
    'Caladon Panarii Temple - Level 1': 'Caladon-Panarrii Temple', 'Caladon Panarii Temple - Level 2': 'Caladon-Panarrii Temple',
    'Caladon Panarii Temple - Level 3': 'Caladon-Panarrii Temple',
    'Caladon - Sewers': 'Caladons Sewers', 'Guardhouse Basement': 'Caladon Guardhouse Basement',
    'High Security Prison': 'Caladon High Security Prison', 'Mafia Underground': 'Caladon-Mafia Underground',
    'Sanders Basement': 'Caladon Sanders Basement', 'Trap Disarm Dungeon': 'Caladon Trap Disarm Dungeon',
    'Crash Site - Cave': 'Crash Site Cave', 'Dernholm Castle': 'Dernholm-Castle',
    'Dungeon of the Dragon Pool - Level 1': 'Dungeon of the Dragon Pool', 'Dungeon of the Dragon Pool - Level 2': 'Dungeon of the Dragon Pool',
    'Elven Ruins - Underground': 'Elven Ruins',
    "K'na Tha - Level 1": "K'na Tha", "K'na Tha - Level 2": "K'na Tha", "K'na Tha - Level 3": "K'na Tha",
    "K'na Tha - Level 4": "K'na Tha", "K'na Tha - Level 5": "K'na Tha", "K'na Tha - Level 6": "K'na Tha",
    'Silver Lady Chambers': 'Qintarra-Queens Chambers', 'Roseborough Inn': 'Roseborough Inn2',
    'Ruins of Szabo - Level 1': 'Ruins of Szabo', 'Ruins of Szabo - Level 2': 'Ruins of Szabo',
    'Iron Clan - Gate': 'Iron Clan HQ', 'Iron Clan - Throne Hall': 'Iron Clan HQ',
    'Panarii Temple': 'Shrouded Hills-Panarii Temple Lev 1', 'Bessie Toone Mine': 'BessieToonesMine-fixed',
    'Stonecutter Clan - Level 1': 'Stonecutter Clan', 'Stonecutter Clan - Level 2': 'Stonecutter Clan',
    'Bates Tunnel': 'Bates Tunnel-fixed', 'Bates Mansion Level 1': 'Bates Mansion Lev 1', 'Bates Mansion Level 2': 'Bates Mansion Lev 2',
    'Hall of Records': 'Tarant-City Hall Downstairs', 'Tarant New Sewers': 'Tarant Sewers-02', 'Tarant Old Sewers': 'Tarant Sewers-01',
    'P. Schuyler & Sons - Level 1': 'PSchuylers Lev 1-fixed', 'P. Schuyler & Sons - Level 2': 'PSchuylers Lev 2-fixed',
    'P. Schuyler & Sons - Level 3': 'PSchuylers Lev 3-fixed',
    'The Bangellian Deeps - Inside': 'Cave of the Bangellian Scourge', 'The Castle S’nel N’fa - Inside': "Castle S'nel N'fa",
    'The Lair of Bellerogrim - Entrance': 'The Lair of Bellerogrim', 'The Lair of Bellerogrim - Underground': 'The Lair of Bellerogrim',
    'The Pit': 'The Pit-fixed', 'The Pit of Fires - Inside': 'Pit of Fires',
    'The Place of Lost Voices - Entrance': 'Iron Clan - Music Box', 'Thieves Cave - Inside': 'Thieves Cave',
    'T’sen-Ang Entrance': "T'sen-Ang", 'M\'in Gorad Chamber': "T'sen-Ang", 'T’sen-Ang': "T'sen-Ang",
    'Tulla - Main Floor': 'Tulla Interior', 'Simeons Hallway': 'Tulla Interior', 'Simeons Chamber': 'Tulla Interior',
    "Fa'al Kin's Maze": "Fal'kins Maze", 'Uncharted Cave - Inside': 'Uncharted Cave',
    'Vendigroth Ruins - Level 1': 'Vendigroth Underground', 'Vendigroth Ruins - Level 2': 'Vendigroth Underground',
    'Vendigroth Ruins - Level 3': 'Vendigroth Underground', 'Vendigroth Ruins - Level 4': 'Vendigroth Underground',
    'Vendigroth Ruins - Level 5': 'Vendigroth Underground', 'Vendigroth Ruins - Level 6': 'Vendigroth Underground',
    'Vendigroth Ruins - Laboratory': 'Vendigroth Underground', 'Vendigroth Ruins - Velorien’s Altar': 'Vendigroth Underground',
    'Void - Hub Island': 'Void', 'Void - Arronax Prison Island': 'Void', 'Void - Araya Island 1': 'Void', 'Void - Araya Island 2': 'Void',
    'Void - Bane of Kree Island': 'Void', 'Void - Gorgoth Island': 'Void', 'Void - Kerghan’s Castle Island': 'Void',
    'Void - Kraka-tur Island': 'Void', 'Void - Kryggyrd’s Falchion Island': 'Void',
    'Arronax Prison': "Void - Arronax's Interior", 'Cave of the Kryggyrd’s Falchion': "Void - Cave of Kriggyrd's Falchion",
    'Kerghan’s Castle - Level 1': 'VOID-Kerghans Castle', 'Kerghan’s Castle - Level 2': 'VOID-Kerghans Castle',
    'Kerghan’s Castle - Level 3': 'VOID-Kerghans Castle', 'Kerghan’s Chambers': 'VOID-Kerghans Castle',
    'Vollinger’s Meeting Place - Basement': 'Vollingers Basement',
    'Wheel Clan - Level 1': 'Wheel Clan', 'Wheel Clan - Castle': 'Wheel Clan', 'Wheel Clan - Town': 'Wheel Clan',
    'Wheel Clan - Throne Hall': 'Wheel Clan', 'Loghaire\'s Chambers': 'Wheel Clan', 'Wheel Clan - Dredge': 'Wheel Clan',
    'Wheel Clan - Mine': 'Wheel Clan', 'Wolf Cave - Inside': 'Wolf-Cave',
}
SKIP_FOLDERS = {WORLD, 'ShopMap', 'Scienticians Underground Lev 1', 'Scienticians Underground Lev 2'}   # character creation / not in MapList
AREA_BY_FOLDER = {'Void': 'The Void', "Void - Arronax's Interior": 'The Void', "Void - Cave of Kriggyrd's Falchion": 'The Void',
                  'VOID-Kerghans Castle': 'The Void'}


NAMES = {'Caladons Sewers': 'Caladon Sewers', 'Roseborough Inn2': 'Roseborough Inn', 'BMC': 'The Black Mountain Mines',
         'Crematorium-lev 1': 'Ashbury Crematorium - Level 1', 'Crematorium-lev 2': 'Ashbury Crematorium - Level 2',
         'Crematorium-lev 3': 'Ashbury Crematorium - Level 3', "Fal'kins Maze": "Fa'al Kin's Maze", 'Wolf-Cave': 'Wolf Cave',
         'Pit of Fires': 'The Pit of Fires', 'Temple of the Derian Ka': 'Ancient Temple - Underground',
         'BessieToonesMine-fixed': "Bessie Toone's Mine", 'PSchuylers Lev 1-fixed': 'P. Schuyler & Sons - Level 1',
         'PSchuylers Lev 2-fixed': 'P. Schuyler & Sons - Level 2', 'PSchuylers Lev 3-fixed': 'P. Schuyler & Sons - Level 3',
         'Tarant Sewers-01': 'Tarant Sewers 1', 'Tarant Sewers-02': 'Tarant Sewers 2', 'Tarant-City Hall Downstairs': 'Hall of Records',
         'Caladon-Panarrii Temple': 'Caladon Panarii Temple', 'Caladon-Panarrii Temple-Basement': 'Caladon Panarii Temple - Catacombs',
         'Shrouded Hills-Panarii Temple Lev 1': 'Shrouded Hills Panarii Temple', 'Cave of the Bangellian Scourge': 'The Bangellian Deeps - Inside',
         'Bates Tunnel-fixed': 'Bates Tunnel', 'The Pit-fixed': 'The Pit', 'Caladon-Mafia Underground': 'Caladon Mafia Underground',
         'Caladon-Castle Main Floor': 'Caladon Castle', 'Dernholm-Castle': 'Dernholm Castle', 'VOID-Kerghans Castle': "Kerghan's Castle",
         "Void - Arronax's Interior": 'Arronax Prison', "Void - Cave of Kriggyrd's Falchion": "Cave of Kryggyrd's Falchion",
         'Qintarra-Queens Chambers': "Queen's Chambers", "Castle S'nel N'fa": "The Castle S'nel N'fa - Inside",
         'Ashbury-Scienticians Underground': 'Scienticians Underground', 'Mannox\'s Hole': "Mannox's Hole"}


def pretty(folder):
    if folder in NAMES:
        return NAMES[folder]
    s = ao.clean_map(folder)
    m = re.match(r'Tulla Interior - Battle - (.+)', s)
    return f'Tulla: Battle of {m.group(1)}' if m else s


def map_list():
    """Rules/MapList.mes -> {folder: {id, start, area}} (the case of the names differs from the folders)."""
    out = {}
    for line in (ao.DATA / 'Rules' / 'MapList.mes').read_text(encoding='cp1252', errors='replace').splitlines():
        m = re.match(r'\{(\d+)\}\{([^,}]+),\s*(\d+)\s*,\s*(\d+)(.*)\}', line)
        if m:
            a = re.search(r'Area:\s*(\d+)', m.group(5))
            out[m.group(2).strip().lower()] = {'id': int(m.group(1)), 'start': [int(m.group(3)), int(m.group(4))], 'area': int(a.group(1)) if a else None}
    return out


def area_names():
    names = {}
    for line in (ao.DATA / 'mes' / 'gamearea.mes').read_text(encoding='cp1252', errors='replace').splitlines():
        m = re.match(r'\s*\{(\d+)\}\{[^/]*/([^/}]*)', line)
        if m:
            names[int(m.group(1))] = m.group(2).strip()
    return names


# ---- objects of one folder -----------------------------------------------------------------------------------------
def folder_objects(folder, sch, desc):
    """(objects, statics) as locate_world_labels.world_objects() makes them, for one map folder."""
    def row(path, src, otype, proto, own, loc):
        pname = desc.get(proto - 20, {}).get('name', '') if proto is not None else ''
        oname = desc.get(own, {}).get('name', '') if own is not None else ''
        return {'area': '', 'file': path.name, 'src': src, 'type': L.emp.OBJECT_TYPES[otype],
                'name': oname if oname and oname != pname else pname, 'unique': bool(oname and oname != pname),
                'x': loc & 0xFFFFFFFF, 'y': (loc >> 32) & 0xFFFFFFFF}
    objs, statics = [], []
    for path in sorted((MAPS / folder).glob('*.mob')):
        otype, proto, own, loc, _ = L.read_object(path.read_bytes(), 0, sch)
        if loc is not None:
            objs.append(row(path, 'mob', otype, proto, own, loc))
    for path in sorted((MAPS / folder).glob('*.sec')):
        for otype, proto, own, loc in L.sec_objects(path.read_bytes(), sch):
            if otype != 0 and loc is not None:
                statics.append(row(path, 'sec', otype, proto, own, loc))
    return objs, statics


def main():
    print('Reading the Map Explorer databases...')
    dbs = L.read_databases()
    base = dbs['arcanummaps.js']['ArcanumCitiesMapData']
    wl = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', (DATA_JS / 'world-labels.js').read_text(encoding='utf-8'), re.S).group(1))
    in_world = {p['name'] for p in wl['places']}
    pictures = [m for m in base if m.get('typemap') != 'overworld' and m['displayName'] not in in_world]

    listing, areas = map_list(), area_names()
    folders = sorted(d.name for d in MAPS.iterdir() if d.is_dir() and d.name not in SKIP_FOLDERS)
    folder_of = {f.lower(): f for f in folders}
    sch, desc = L.emp.schema(), L.emp.load_description_mes()
    adesc = ao.descriptions()
    roles = npc_roles.Roles()
    switches = npc_switch.Switches()

    # ---- which folder each picture shows -----------------------------------------------------------------------
    report = []
    by_folder = defaultdict(list)
    for m in pictures:
        name = m['displayName']
        f = PICTURE_FOLDER.get(name) or (folder_of.get(name.lower()) or folder_of.get(ao.clean_map(name).lower()))
        if f is None or f not in folders:
            report.append(f'-- {name}: no map of the game for it (layout from the screenshot alone)')
        by_folder[f if f in folders else None].append(m)

    # ---- people and creatures -----------------------------------------------------------------------------------
    protos = {}
    for p in (ao.DATA / 'proto').rglob('*.pro'):
        o = ao.read_proto(p)
        protos[o.proto] = o

    maps, sections, npc_rows = [], [], []
    place_idx = {}
    for folder in folders:
        key = ao.clean_map(folder)
        info = listing.get(folder.lower(), {})
        objs, statics = folder_objects(folder, sch, desc)
        pts = [(o['x'], o['y']) for o in objs + statics]
        if not pts:
            report.append(f'-- {folder}: no objects: skipped')
            continue
        mx_, my_ = sorted(p[0] for p in pts)[len(pts) // 2], sorted(p[1] for p in pts)[len(pts) // 2]
        pts = [p for p in pts if abs(p[0] - mx_) <= 1500 and abs(p[1] - my_) <= 1500] or pts      # a stray object far away
        objs = [o for o in objs if abs(o['x'] - mx_) <= 1500 and abs(o['y'] - my_) <= 1500]
        statics = [o for o in statics if abs(o['x'] - mx_) <= 1500 and abs(o['y'] - my_) <= 1500]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        area = areas.get(info.get('area')) if info.get('area') else AREA_BY_FOLDER.get(folder)
        area = area.split(',')[0].strip() if area else area
        mp = {'key': key, 'name': pretty(folder), 'area': area, 'bbox': bbox, 'start': info.get('start')}
        mi = len(maps)
        maps.append(mp)

        # NPCs
        for path in sorted((MAPS / folder).glob('*.mob')):
            o = ao.read_mob(path)
            if o.type != NPC or not o.tile or abs(o.tile[0] - mx_) > 1500 or abs(o.tile[1] - my_) > 1500:
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
            npc_rows.append([place_idx[key], o.tile[0], o.tile[1], kind, race, gender, stats.get(S_LEVEL, 0), stats.get(S_ALIGN, 0),
                             name.strip()] + npc_roles.columns(roles.of(e) if kind == 0 else None) + [e.int(F_PORTRAIT)]
                            + [switches.explain(e) if e.int(F_OBJ_FLAGS) & OF_OFF else 0, path.relative_to(MAPS).as_posix()])

        # sections (the pictures of the Map Explorer, or one for the whole map)
        pics = by_folder.get(folder, [])
        world = L.World([], [], {})
        world.folders['sub'] = objs + [s for s in statics if s['name'] not in L.SKIP_STATIC]
        world.doors['sub'] = [s for s in statics if s['type'] == 'Portal' or s['name'] in L.DOORS]
        centre = (round(sum(xs) / len(xs)), round(sum(ys) / len(ys)))
        if not pics:
            sections.append({'name': mp['name'], 'map': mi, 'group': area, 'view': list(centre), 'labels': []})
        for pic in pics:
            r = world.place({'displayName': 'sub', 'labels': pic.get('labels', [])}, A0)
            labels, kinds, every = [], defaultdict(int), []
            for row in r['rows']:
                lb = row['lb']
                pos, how, o = r['placed'].get(row['i'], (None, 'unplaced', None))
                if r['fit'] is None or how == L.AREA:                # nothing to go on: keep the screenshot's layout
                    sx, sy = lb['x'], lb['y']
                    pos = (round((2 * A0 * sy - A0 * sx) / 2), round((2 * A0 * sy + A0 * sx) / 2))
                    how = 'screenshot layout'
                every.append(pos)
                if L.mob_backed(lb, o):                              # the person or container itself comes from its .mob
                    kinds['person or container (from .mob)'] += 1
                    continue
                kinds[how] += 1
                out = {k: v for k, v in lb.items() if k not in ('x', 'y', 'textX', 'textY')}
                out.update({'tile': list(pos), 'placed': how})
                if o:
                    out['object'] = f"{o['name']} ({o['src']} {o['file']})"
                labels.append(out)
            if r['fit'] is None and labels:                         # lay the whole layout (people too) over the map's middle
                mx = sum(p[0] for p in every) / len(every); my = sum(p[1] for p in every) / len(every)
                for l in labels:
                    l['tile'] = [round(l['tile'][0] - mx + centre[0]), round(l['tile'][1] - my + centre[1])]
            view = pic.get('defaultView')
            if r['fit'] and view:
                vt = list(map(round, L.predict(r['fit'], view['x'], view['y'])))
            elif every and r['fit'] is None:                        # the middle of the layout laid over the map's middle
                vt = list(centre)
            elif every:
                vt = [round(sum(p[0] for p in every) / len(every)), round(sum(p[1] for p in every) / len(every))]
            else:
                vt = list(centre)
            sections.append({'name': pic['displayName'], 'map': mi, 'group': area, 'view': vt, 'labels': labels})
            head = f"== {pic['displayName']} -> {folder}: {len(labels)} labels"
            if r['fit']:
                head += f", fit rms {r['rms']:.1f} tiles" if r['rms'] is not None else ', offset from a consensus'
            else:
                head += ', no fit'
            report.append(head + ' | ' + ', '.join(f'{k}: {v}' for k, v in sorted(kinds.items())))

    # pictures with no folder: laid out from the screenshot, around an arbitrary origin, as a map of their own
    for pic in by_folder.get(None, []):
        labels = []
        for lb in pic.get('labels', []):
            if L.mob_backed(lb, None):
                continue
            sx, sy = lb['x'], lb['y']
            out = {k: v for k, v in lb.items() if k not in ('x', 'y', 'textX', 'textY')}
            out.update({'tile': [round((2 * A0 * sy - A0 * sx) / 2) + 200, round((2 * A0 * sy + A0 * sx) / 2) + 200], 'placed': 'screenshot layout'})
            labels.append(out)
        pts = [l['tile'] for l in labels] or [[200, 200]]
        mi = len(maps)
        maps.append({'key': pic['displayName'], 'name': pic['displayName'], 'area': None, 'bbox': [min(p[0] for p in pts), min(p[1] for p in pts),
                                                                                                     max(p[0] for p in pts), max(p[1] for p in pts)], 'start': None})
        sections.append({'name': pic['displayName'], 'map': mi, 'group': None, 'view': pts[0], 'labels': labels})

    places = [None] * len(place_idx)
    for k, i in place_idx.items():
        places[i] = k
    note = ('npcs[i] = [map (index into places = map key), tile x, tile y, kind (0 person / 1 animal / 2 monster / 3 undead / 4 mechanical), '
            'race (people only, else -1), gender (0 female / 1 male, people only), level, alignment, name, '
            'shopkeeper (0 / 1: their dialog opens the barter screen), price multiplier in % (shopkeepers), '
            'role (0, or {j: 1 joins your party, t: ["Master Bow", ...] trains you}), all from the dialog (npc_roles.py), '
            'portrait (field 231, a gameport.mes number; 0 = none: portraits.js), '
            'off (0, or OF_OFF is set, the NPC is switched off: 1 = no script was found that turns them on, a string = what turns them on, '
            'an object {k: "spawner" | "helper", t: what it is, w: [what else matters]} = an invisible spawner / script holder, npc_switch.py), '
            'file (the .mob, path under data/maps: the Advanced view links to it)]')
    head = '// GENERATED by toolbox/atlas/build_submaps.py - re-run it rather than editing by hand.\n'
    data = {'source': 'toolbox/atlas/build_submaps.py',
            'note': 'maps[i] = a map of Rules/MapList.mes (tile bbox [x0,y0,x1,y1]); sections = the Map Explorer pictures (or the whole map) '
                    'as named viewpoints; label tiles are game tiles of that map.',
            'maps': maps, 'sections': sections}
    OUT_JS.write_text(head + 'window.ArcanumMaps = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
                      + 'window.ArcanumSubNpcs = ' + json.dumps({'races': RACES, 'kinds': KINDS, 'places': places, 'note': note,
                                                                'npcs': [r for r in npc_rows if r[3] == 0]}, ensure_ascii=False, separators=(',', ':')) + ';\n',
                      encoding='utf-8')
    OUT_CREATURES.write_text(head + 'window.ArcanumSubCreatures = ' + json.dumps({'races': RACES, 'kinds': KINDS, 'places': places, 'note': note,
                                                                                 'npcs': [r for r in npc_rows if r[3] != 0]}, ensure_ascii=False, separators=(',', ':')) + ';\n',
                             encoding='utf-8')
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text('\n'.join(report) + '\n', encoding='utf-8')
    print('\n'.join(report))
    people = sum(1 for r in npc_rows if r[3] == 0)
    print(f'\n{len(maps)} maps, {len(sections)} sections, {people} people and {len(npc_rows) - people} creatures')
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB), {OUT_CREATURES.name} ({OUT_CREATURES.stat().st_size // 1024} KB), {REPORT.name}')


if __name__ == '__main__':
    sys.exit(main())
