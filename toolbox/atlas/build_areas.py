"""
The areas of the world, read from the game's own list (data/mes/gamearea.mes), and its secret areas.

An area is a named spot of the world map: a town, a ruin, a cave, an altar. Each line gives its tile on the world map, its
name, a short description and a detection radius, in sectors (64 tiles): the world map shows the area once the player has
passed within that many sectors of it (5 when the line gives none). A radius of -1 means that walking past never shows it:
only the story (a person, a map, a book) reveals it - a hidden area.

The world map folders called "Secret Area - <name>" hold places that no area line points to: the secret areas. Each is placed
at the middle of its sectors.

Writes js/atlas/data/areas.js (window.ArcanumAreas), which both Atlas pages use for the names on the map and the sidebar, and the same
list for each mod (ce-areas.js, carcanum-areas.js, fp-areas.js, ru-areas.js: the base game's lines with the mod's over them by number).
Re-run rather than edit:  py build_areas.py
"""
import filecmp
import json
import re
import sys
from collections import Counter
from functools import lru_cache
from pathlib import Path

import arcanum_objects as ao
import build_submaps as bs
import sec_alias

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ao.DATA_JS                   # the generated data the pages load
MES = ROOT / 'data' / 'mes' / 'gamearea.mes'
WORLD = ROOT / 'data' / 'maps' / bs.WORLD
OUT_JS = DATA_JS / 'areas.js'
DEFAULT_RADIUS = 5
SETTLEMENTS = {"Qintarra", "T'sen-Ang"}              # towns that are not in the world labels' Cities
CE_MES = ROOT / 'data' / 'mods' / 'Arcanum CE Restored' / 'mes' / 'gamearea.mes'      # a patch: its lines replace the base game's of the same number, or add new ones
CE_WORLD = ROOT / 'data' / 'mods' / 'Arcanum CE Restored' / 'maps' / bs.WORLD
CE_JS = DATA_JS / 'ce-areas.js'
CAR_MES = ROOT / 'data' / 'mods' / 'Carcanum' / 'mes' / 'gamearea.mes'
CAR_WORLD = ROOT / 'data' / 'mods' / 'Carcanum' / 'maps' / bs.WORLD
CAR_JS = DATA_JS / 'carcanum-areas.js'
FP_MES = ROOT / 'data' / 'mods' / 'Forgotten Places 6.0' / 'mes' / 'gamearea.mes'
FP_WORLD = ROOT / 'data' / 'mods' / 'Forgotten Places 6.0' / 'maps' / 'Arcanum1'      # (the mod calls its world folder Arcanum1)
FP_JS = DATA_JS / 'fp-areas.js'
RU_MES = ROOT / 'data' / 'mods' / 'Russian Mod 2012 RC9' / 'mes' / 'gamearea.mes'
RU_WORLD = ROOT / 'data' / 'mods' / 'Russian Mod 2012 RC9' / 'maps' / bs.WORLD
RU_JS = DATA_JS / 'ru-areas.js'
TIN_WORLD = ROOT / 'data' / 'mods' / 'Terra Incognita' / 'maps' / bs.WORLD       # (the mod ships no gamearea.mes: its area list is the base game's)
TIN_JS = DATA_JS / 'tin-areas.js'
TIN_SECRET = {                    # the user's names (by tile), the same two places as the Russian mod's; the other 7 are still "Secret Area (n)"
    (84512, 115424): 'Cattan Grove',
    (3296, 123808): 'Testing Location',
}
CAR_SETTLEMENTS = {'Vaselan', 'Haunted Village', 'The Assassins village', 'Half-orc village', 'Undead city', 'Shady Grove'}      # the mod's areas that are villages
CAR_SECRET = {                    # the user's names for Carcanum's unnamed places (by tile), or the town a place belongs to ("with")
    (44309, 66029): {'name': 'Ashbury West Prison'},
    (27136, 40960): {'name': "Vendigroth's Labyrinth"},
    (67296, 46880): {'name': 'Wheel Clan South Forest'},
    (83104, 48992): {'name': 'Polar Bears Pack'},
    (91936, 82592): {'name': 'Shrouded Hills West Forest'},
    (89577, 84443): {'with': 'Shrouded Hills'},       # Safehouse of the bank robbers
    (90036, 84152): {'with': 'Shrouded Hills'},       # The secret exit from Shrouded Hills
    (90318, 84098): {'with': 'Shrouded Hills'},       # The Shrouded Hills Mine
    (61904, 65615): {'with': 'Tarant'},               # Tarant upper entrance
    (32327, 62371): {'with': 'Ashbury'},              # Ashbury train station
}
FP_SECRET = {                     # the user's names for Forgotten Places' unnamed places (by tile)
    (13189, 18007): 'FP 1.0 Secret Island',
    (44960, 50080): 'Not Built Yet (1)',
    (22816, 53216): 'Isle of Despair North',
    (22784, 54560): 'Isle of Despair West',
    (75488, 55008): 'Lynchbany North',
    (47200, 62176): 'Not Built Yet (2)',
    (89504, 66528): 'Unknown Cave',
    (67776, 89376): 'Tiny Island (1)',
    (64416, 90080): 'Tiny Island (2)',
    (85097, 115237): 'Monaco North',
}
RU_SETTLEMENTS = {'Грейсвандир'}  # the Russian Mod Pack's areas that are settlements (Grayswandir)
RU_SECRET = {                     # the user's names for the Russian Mod Pack's unnamed places (by tile)
    (84512, 115424): 'Cattan Grove',
    (3296, 123808): 'Testing Location',
}
CAR_NEAR = 6                   # sectors: a sector of the mod's world farther than this from every area is a secret area
WORLD_MIN = 10000                 # CE also lists areas of its own maps (Hell Day, Malicorne...) with tiles of those maps, and filler lines at y = 127998
NAME_FIX = {'Stringy Petes Cove': "Stringy Pete's Cove"}      # a typo of the base game, which CE Restored corrects: one name for both
CE_SETTLEMENTS = {'Brandybuck', 'Cotswold', 'Leahbo', 'Marsyona', 'Lynchbany', 'Plainwicke Plantation', 'Vaselan'}      # CE's areas that are settlements
CE_NOT_LISTED = {'Tol Guldur', 'Treasure Island'}           # maps of their own (modules): no place in the list, no name on the world map
LINE = re.compile(r'\{(\d+)\}\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*-?\d+\s*,\s*-?\d+\s*/(.*)\}')
nk = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())


def read_lines(mes):
    """number -> area, for the lines of one .mes"""
    out = {}
    for line in ao.read_text(mes).splitlines():
        m = LINE.match(line.strip())
        if not m:
            continue
        x, y = int(m.group(2)), int(m.group(3))
        parts = [p.strip() for p in m.group(4).split('/')]
        name, desc, radius = parts[0], parts[1] if len(parts) > 1 else '', DEFAULT_RADIUS
        for p in parts[2:]:
            r = re.match(r'Radius:\s*(-?\d+)', p)
            if r:
                radius = int(r.group(1))
        if (x, y) == (0, 0) or name.lower() == 'a place unimportant':
            continue
        name = name.split(',')[0].strip()
        out[int(m.group(1))] = {'name': NAME_FIX.get(name, name), 'description': desc, 'tile': [x, y], 'radius': radius}
    return out


def on_map(a, not_listed=()):
    """On the world map: not a line a mod gives to a map of its own (Hell Day, Malicorne...: tiles of that map), nor a filler (y = 127998)."""
    return min(a['tile']) >= WORLD_MIN and a['tile'][1] < 127000 and a['name'] not in not_listed


def number_same_names(areas):
    """Areas sharing a name (Port Ruins) are numbered, in file order, on the map as in the list."""
    count, seen = Counter(a['name'] for a in areas), Counter()
    for a in areas:
        if count[a['name']] > 1:
            seen[a['name']] += 1
            a['name'] = f"{a['name']} ({seen[a['name']]})"


def mark_changed(areas, base_areas, key=lambda a: (a['name'], tuple(a['tile']), a['radius'], a['description'])):
    """ce: the area is new, or changed by the mod (not one of base_areas as they are)."""
    old = {key(a) for a in base_areas}
    for a in areas:
        a['ce'] = key(a) not in old


def write_js(path, var, note, **data):
    path.write_text('// GENERATED by toolbox/atlas/build_areas.py - re-run it rather than editing by hand.\nwindow.' + var + ' = '
                    + json.dumps({'source': 'toolbox/atlas/build_areas.py', 'note': note, **data}, ensure_ascii=False, separators=(',', ':')) + ';\n',
                    encoding='utf-8')


def read_ce_areas():
    """The areas of the world as CE Restored has them: the base game's list with CE's lines laid over it, by number. Only those that are
    on the world map: the lines CE gives to its own maps (Hell Day, Malicorne, Delirium of Evil) and the empty filler ones are left out."""
    merged = {**read_lines(MES), **read_lines(CE_MES)}
    return [a for _, a in sorted(merged.items()) if a['name'] and on_map(a, CE_NOT_LISTED)], \
           [a for _, a in sorted(merged.items()) if a['name'] and not on_map(a, CE_NOT_LISTED) and a['tile'][1] < 127000]


def read_secret(*worlds):
    """the secret areas, from the "Secret Area - " folders of one or more world folders (a sector in any of them counts)"""
    folders = {}
    for w in worlds:
        for d in sorted(p for p in w.iterdir() if p.is_dir() and p.name.lower().startswith('secret area - ')):
            folders.setdefault(d.name, set()).update(int(s.stem) for s in sec_alias.rglob(d, '*.sec') if s.stem.isdigit())
    out = []
    for name, ids in sorted(folders.items()):
        if not ids:
            continue
        xs = [(i & 0x3FFFFFF) * 64 + 32 for i in ids]
        ys = [(i >> 26) * 64 + 32 for i in ids]
        label = name[len('Secret Area - '):].strip()
        if label.isdigit():                  # a folder not named yet ("Secret Area - 3"): shown as "Secret area (3)"
            label = f'Secret area ({label})'
        out.append({'name': label, 'tile': [round(sum(xs) / len(xs)), round(sum(ys) / len(ys))], 'sectors': len(ids)})
    return out


@lru_cache(maxsize=1)
def base_world():
    """sector number -> .sec of the base game's world (a deleted duplicate as its kept copy), read once for every mod."""
    return {int(s.stem): s for s in sec_alias.rglob(WORLD, '*.sec') if s.stem.isdigit()}


def unnamed_places(world, near, first=1):
    """The places a mod adds to the world that nothing names: "Secret Area (n)", numbered from first. Its world sectors that are not the base game's
    (a sector with the base game's number and bytes is no addition), in groups of sectors at most 2 apart; a group is a place of its own only if
    none of its sectors lies within CAR_NEAR sectors of a spot of near (areas, named secret areas): a large land around a named area is that area's.
    A hand-made sector is a place whatever it holds (people or only landscape)."""
    base = base_world()
    pts = [(i & 0x3FFFFFF, i >> 26) for i, s in sorted((int(s.stem), s) for s in sec_alias.rglob(world, '*.sec') if s.stem.isdigit())
           if i not in base or not filecmp.cmp(s, base[i], shallow=False)]
    groups = []
    for p in pts:
        for g in groups:
            if any(abs(p[0] - q[0]) <= 2 and abs(p[1] - q[1]) <= 2 for q in g):
                g.append(p)
                break
        else:
            groups.append([p])
    spots = [a['tile'] for a in near]
    out = []
    for g in groups:
        if all(((tx - (x * 64 + 32)) ** 2 + (ty - (y * 64 + 32)) ** 2) ** 0.5 / 64 > CAR_NEAR for x, y in g for tx, ty in spots):
            cx, cy = sum(p[0] for p in g) / len(g) * 64 + 32, sum(p[1] for p in g) / len(g) * 64 + 32
            out.append({'name': f'Secret Area ({first + len(out)})', 'tile': [round(cx), round(cy)], 'description': '', 'radius': 5, 'sectors': len(g)})
    return out


def link(areas, places):
    by_nk = {nk(p['name']): p['name'] for p in places}
    for a in areas:
        a['place'] = by_nk.get(nk(a['name']))              # the Atlas place (sidebar entry) it is, if it has one
        a['hidden'] = a['radius'] < 0
        a['settlement'] = a['name'] in SETTLEMENTS or any(p['name'] == a['place'] and p.get('modGroup') == 'Cities' for p in places)


def main():
    wl = (DATA_JS / 'world-labels.js').read_text(encoding='utf-8')
    places = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl, re.S).group(1))['places']
    areas = list(read_lines(MES).values())
    link(areas, places)
    secret = read_secret(WORLD)
    note = ('areas[i] = {name, description, tile [x, y] on the world map, radius (in sectors: the world map shows it once the player has been '
            'that near; -1 = never by walking, only the story reveals it), place (the Atlas place of that name, or null), hidden, settlement}; '
            'secret[i] = {name, tile (middle of its sectors), sectors} (toolbox/atlas/build_areas.py)')
    write_js(OUT_JS, 'ArcanumAreas', note, areas=areas, secret=secret)
    print(f'{len(areas)} areas ({sum(a["hidden"] for a in areas)} hidden, {sum(a["place"] is None for a in areas)} without an Atlas place), {len(secret)} secret areas')
    print('  without a place: ' + ', '.join(a['name'] for a in areas if a['place'] is None))
    build_ce(areas, places)
    build_carcanum(areas, places)
    build_fp(areas, places)
    build_ru(places)
    build_tin(areas, places)
    build_rb(areas, places)


def build_tin(base_areas, places):
    """js/atlas/data/tin-areas.js (window.ArcanumTINAreas), same shape as fp-areas.js, for Terra Incognita. The mod ships no gamearea.mes, so the list is the base
    game's; what it adds to the world (sectors no area is near) are "Secret Area (n)" places for the user to name."""
    areas = [a for _, a in sorted(read_lines(MES).items()) if a['name'] and on_map(a)]
    link(areas, places)
    number_same_names(areas)
    have = {nk(a['name']) for a in areas}
    secret = [s for s in read_secret(WORLD, TIN_WORLD) if nk(s['name']) not in have]
    secret += unnamed_places(TIN_WORLD, areas + secret)
    secret = [{**s, 'name': TIN_SECRET.get(tuple(s['tile']), s['name'])} for s in secret]
    mark_changed(areas, base_areas)
    note = ('Same shape as ce-areas.js, for Terra Incognita: areas = the base game\'s gamearea.mes (the mod has none); secret = the "Secret Area - " folders of the base game '
            'and the mod, plus "Secret Area (n)" for sectors of the mod no area is near')
    write_js(TIN_JS, 'ArcanumTINAreas', note, areas=areas, secret=secret)
    print(f'Terra Incognita: {len(areas)} areas, {len(secret)} secret areas')
    print('  secret areas of the mod: ' + ', '.join(f'{s["name"]} {s["tile"]}' for s in secret if s['name'].startswith('Secret Area (')))


def build_rb(base_areas, places):
    """js/atlas/data/rb-areas.js (window.ArcanumRBAreas), same shape as tin-areas.js, for Arcanum ReBulid (no gamearea.mes either: the base game's list, plus
    "Secret Area (n)" places for the mod's sectors no area is near)."""
    world = ROOT / 'data' / 'mods' / 'Arcanum ReBulid' / 'maps' / bs.WORLD
    areas = [a for _, a in sorted(read_lines(MES).items()) if a['name'] and on_map(a)]
    link(areas, places)
    number_same_names(areas)
    have = {nk(a['name']) for a in areas}
    secret = [s for s in read_secret(WORLD, world) if nk(s['name']) not in have]
    secret += unnamed_places(world, areas + secret)
    mark_changed(areas, base_areas)
    note = ('Same shape as ce-areas.js, for Arcanum ReBulid: areas = the base game\'s gamearea.mes (the mod has none); secret = the "Secret Area - " folders of the base game '
            'and the mod, plus "Secret Area (n)" for sectors of the mod no area is near')
    write_js(DATA_JS / 'rb-areas.js', 'ArcanumRBAreas', note, areas=areas, secret=secret)
    print(f'Arcanum ReBulid: {len(areas)} areas, {len(secret)} secret areas')
    print('  secret areas of the mod: ' + ', '.join(f'{s["name"]} {s["tile"]}' for s in secret if s['name'].startswith('Secret Area (')))


def build_ce(base_areas, places):
    """js/atlas/data/ce-areas.js (window.ArcanumCEAreas): the whole list as CE Restored has it, for the Atlas to swap in with the version on."""
    areas, other = read_ce_areas()
    link(areas, places)
    for a in areas:
        if a['name'] in CE_SETTLEMENTS:
            a['settlement'] = True
    number_same_names(areas)
    have = {nk(a['name']) for a in areas}
    secret = [s for s in read_secret(WORLD, CE_WORLD) if nk(s['name']) not in have]      # (an area CE gives a line to - Fan Graveyard - is no secret any more)
    mark_changed(areas, base_areas)
    note = ('Same shape as areas.js, for CE Restored: ' + 'areas = the base game\'s gamearea.mes with CE\'s lines laid over it by number (ce = new or changed by CE); '
            'secret = the "Secret Area - " folders of the base game and CE together; other = CE areas that are not on the world map (tiles of Hell Day, Malicorne...)')
    write_js(CE_JS, 'ArcanumCEAreas', note, areas=areas, secret=secret, other=other)
    print(f'CE Restored: {len(areas)} areas ({sum(a["ce"] for a in areas)} new or changed, {sum(a["hidden"] for a in areas)} hidden), {len(secret)} secret areas, {len(other)} not on the world map')
    print('  new or changed: ' + ', '.join(a['name'] for a in areas if a['ce']))
    print('  not on the world map: ' + ', '.join(f'{a["name"]} {a["tile"]}' for a in other))


def build_ru(places):
    """js/atlas/data/ru-areas.js (window.ArcanumRUAreas), same shape as fp-areas.js, for the Russian Mod Pack. The mod translates the names (gamearea.mes is read as
    Windows-1251), so an area is matched with the Atlas place by its NUMBER (the base game's line of the same number), not by its name; the Russian name is what
    is shown. Base game + the mod's folder only."""
    base_lines = read_lines(MES)
    base_list = list(base_lines.values())
    link(base_list, places)                                       # the base game's places by (English) name
    merged = {**base_lines, **read_lines(RU_MES)}
    areas, number = [], []
    for n, a in sorted(merged.items()):
        if a['name'] and on_map(a):
            areas.append(a)
            number.append(n)
    link(areas, places)
    for n, a in zip(number, areas):
        b = base_lines.get(n)
        if b is not None and a['place'] is None:                  # translated name: the place of the base game's area of the same number
            # (an area that is no place in areas.js - Qintarra, Land Bridge... - is the Atlas place of its English name: a section, or made one by the Atlas)
            a['place'], a['settlement'] = b['place'] or b['name'], b['settlement'] or a['settlement']
    for a in areas:
        if a['name'] in RU_SETTLEMENTS:
            a['settlement'] = True
    number_same_names(areas)
    have = {nk(a['name']) for a in areas}
    secret = [s for s in read_secret(WORLD, RU_WORLD) if nk(s['name']) not in have]
    secret += unnamed_places(RU_WORLD, areas + secret)               # sectors of the mod's world no area is near (same rule as the other mods)
    secret = [{**s, 'name': RU_SECRET.get(tuple(s['tile']), s['name'])} for s in secret]
    mark_changed(areas, base_list, key=lambda a: (tuple(a['tile']), a['radius'], a['description']))     # (a translated name alone is not a change)
    note = ('Same shape as ce-areas.js, for the Russian Mod Pack 2012 RC9: names and descriptions are the mod\'s (Russian); areas = the base game\'s gamearea.mes with the '
            'mod\'s lines laid over it by number (ce = new or changed position / radius / text); place = the Atlas place of the base game\'s area of that number; '
            'secret = the "Secret Area - " folders plus "Secret Area (n)" for sectors of the mod no area is near')
    write_js(RU_JS, 'ArcanumRUAreas', note, areas=areas, secret=secret)
    print(f'Russian Mod: {len(areas)} areas ({sum(a["ce"] for a in areas)} new or changed, {sum(a["place"] is None for a in areas)} without an Atlas place), {len(secret)} secret areas')


def build_fp(base_areas, places):
    """js/atlas/data/fp-areas.js (window.ArcanumFPAreas), same shape as ce-areas.js, for Forgotten Places 6.0. Like every mod it is the base game + its own
    folder: the list is the base game's gamearea.mes with the mod's lines over it by number (CE Restored is not under it)."""
    merged = {**read_lines(MES), **read_lines(FP_MES)}
    areas = [a for _, a in sorted(merged.items()) if a['name'] and on_map(a, CE_NOT_LISTED)]
    link(areas, places)
    for a in areas:
        if a['name'] in CE_SETTLEMENTS:
            a['settlement'] = True
    number_same_names(areas)
    have = {nk(a['name']) for a in areas}
    secret = [s for s in read_secret(WORLD, FP_WORLD) if nk(s['name']) not in have]
    secret += unnamed_places(FP_WORLD, areas + secret)               # what the mod adds to the world that no area names
    secret = [{**s, 'name': FP_SECRET.get(tuple(s['tile']), s['name'])} for s in secret]
    mark_changed(areas, base_areas)
    note = ('Same shape as ce-areas.js, for Forgotten Places 6.0: areas = the base game\'s gamearea.mes with the mod\'s lines laid over it by number '
            '(ce = new or changed); secret = the "Secret Area - " folders of the base game and the mod, plus "Secret Area (n)" for sectors of the mod no area is near')
    write_js(FP_JS, 'ArcanumFPAreas', note, areas=areas, secret=secret)
    print(f'Forgotten Places: {len(areas)} areas ({sum(a["ce"] for a in areas)} new or changed), {len(secret)} secret areas')
    print('  secret areas of the mod: ' + ', '.join(f'{s["name"]} {s["tile"]}' for s in secret if s['name'].startswith('Secret Area (')))


def read_car_areas():
    """The areas of the world as the Carcanum mod has them (gamearea.mes is a patch by number, like CE's). A line with no name
    (the name slot holds the description: "The Old Prison") is a place the map does not name: a secret area, "Secret Area (n)"
    in file order; the sectors the mod adds to the world that no area line is near come after them."""
    merged = {**read_lines(MES), **read_lines(CAR_MES)}
    named = [a for _, a in sorted(merged.items()) if a['name'] and on_map(a)]
    unnamed = [a for _, a in sorted(merged.items()) if not a['name'] and a['description'] and on_map(a)]
    secret = [{'name': f'Secret Area ({i})', 'tile': a['tile'], 'description': a['description'], 'radius': a['radius'], 'sectors': 0}
              for i, a in enumerate(unnamed, 1)]
    # world sectors the mod adds that no area (named or not, or a secret area of the base game) is near: a place of its own
    secret += unnamed_places(CAR_WORLD, named + unnamed + read_secret(WORLD), len(secret) + 1)
    kept = []                                                       # CAR_SECRET: a name of its own, or an area of the town it belongs to
    for s in secret:
        fix = CAR_SECRET.get(tuple(s['tile']), {})
        if fix.get('with'):
            d = s['description'].strip().rstrip('.')
            named.append({'name': d or fix['with'], 'description': s['description'], 'tile': s['tile'], 'radius': s['radius'], 'with': fix['with']})
        else:
            kept.append({**s, 'name': fix.get('name', s['name'])})
    n = 0
    for s in kept:                                                  # the ones still unnamed, numbered again
        if s['name'].startswith('Secret Area ('):
            n += 1
            s['name'] = f'Secret Area ({n})'
    return named, kept


def build_carcanum(base_areas, places):
    """js/atlas/data/carcanum-areas.js (window.ArcanumCarcanumAreas), the same shape as ce-areas.js, for the "Polished CAR Arcanum" version."""
    areas, secret = read_car_areas()
    link(areas, places)
    for a in areas:
        if a['name'] in CAR_SETTLEMENTS:
            a['settlement'] = True
        if a.get('with'):                                       # a spot of a town: its pin opens the town
            a['place'] = a['with']
    have = {nk(a['name']) for a in areas}
    secret = [s for s in read_secret(WORLD) if nk(s['name']) not in have] + secret      # (the base game's secret areas stay secret unless the mod names them)
    mark_changed(areas, base_areas)
    note = ('Same shape as ce-areas.js, for the Carcanum mod (Polished CAR Arcanum): areas = the base game\'s gamearea.mes with the mod\'s lines laid over it by number '
            '(ce = new or changed); secret = the base game\'s "Secret Area - " folders, plus the places the mod leaves unnamed (nameless area lines, sectors no area is near) as "Secret Area (n)"')
    write_js(CAR_JS, 'ArcanumCarcanumAreas', note, areas=areas, secret=secret)
    print(f'Carcanum: {len(areas)} areas ({sum(a["ce"] for a in areas)} new or changed), {len(secret)} secret areas')
    print('  secret areas of the mod: ' + ', '.join(f'{s["name"]} {s["tile"]} {s["description"]}' for s in secret if s['name'].startswith('Secret Area (')))


if __name__ == '__main__':
    sys.exit(main())
