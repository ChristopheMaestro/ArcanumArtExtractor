"""
Music and ambient sound of every place, as the game plays them (game/gsound.c, sector.c, map.c, area.c), from data/sound:

  SchemeIndex.mes   scheme number -> "<name> #<first line in SchemeList.mes>" (a scheme = up to 100 lines from there)
  SchemeList.mes    "<file> /loop /vol:a-b /time:h1-h2 /freq:n /bal:a-b /scatter:n": a /loop line is a song that plays while
                    h1 <= hour <= h2; a line without /loop, /anchor or /over is a sound fired at random (n in 1000 every
                    250 ms, default 5) while the hour is in range
  mapinfo.txt       "SoundScheme: m, a" of a map: the two schemes that start when the map is loaded
  <sector>.sec      after the townmap number, the aptitude and the light scheme: flags, scheme 1, scheme 2 (12 bytes). When
                    the player walks into a sector whose schemes are not both 0, the game plays them; a sector with 0, 0 keeps
                    what was playing. Both numbers are just schemes: either slot can hold music or ambience.
  mes/gamearea.mes  the areas: "x, y, ..., /Name/Description/Radius:n". On the world map, a spot belongs to the nearest area
                    only when its sector has the same townmap as the sector of the area's centre (area_from_loc).
The game's travel map (ui/wmap_ui.c) plays music/arcanum.mp3.

Writes js/atlas/data/sound.js (window.ArcanumSound). The Atlas plays the files straight from data/sound/.
Re-run rather than edit:  py build_sound.py
"""
import json
import re
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path

import arcanum_objects as ao

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ROOT / 'js' / 'atlas' / 'data'                   # the generated data the pages load
SOUND = ao.DATA / 'sound'
MAPS = ao.DATA / 'maps'
WORLD = 'Arcanum1-024-fixed'
OUT_JS = DATA_JS / 'sound.js'
REPORT = Path(__file__).resolve().parent / 'reports' / 'sound-report.txt'
TRAVEL = 'music\\arcanum.mp3'
# SchemeList.mes misspells the wastes ambience; the game finds no file there and stays silent, these are the files meant
SPELLING = {'wastland_day.wav': 'wasteland_day.wav', 'wastland_night.wav': 'wasteland_night.wav'}


def mes_lines(path):
    """{number: text} of a .mes; SchemeList puts words before some entries ("RESERVED{2700}{...}"), the game skips them."""
    return {int(m.group(1)): m.group(2).strip()
            for m in re.finditer(r'\{(\d+)\}\{([^}]*)\}', path.read_text(encoding='cp1252', errors='replace'))}


def param(opts, key):
    m = re.search(re.escape(key) + r'(\d+)(?:-(\d+))?', opts)
    if not m:
        return None
    a = int(m.group(1))
    return [a, int(m.group(2)) if m.group(2) else a]


def parse_entry(text, files):
    """One SchemeList line as gsound_scheme_parse_entry reads it."""
    text = text.lower()
    path, _, opts = text.partition(' ')
    path = path.replace('/', '\\')
    real = files.get(path) or files.get(SPELLING.get(path, ''))
    if real is None:
        return None, path
    e = {'f': real}
    vol = param(opts, '/vol:')
    if '/loop' in opts or '/anchor' in opts or '/over' in opts:
        e['song'] = 'loop' if '/loop' in opts else 'over' if '/over' in opts else 'once'
        if vol:
            e['vol'] = vol[0]                 # a song plays at the low end of its range
        t = param(opts, '/time:') if '/loop' in opts else None
        if t and t != [0, 23]:
            e['time'] = t
    else:
        e['freq'] = (param(opts, '/freq:') or [5])[0]
        t = param(opts, '/time:')
        if t and t != [0, 23]:
            e['time'] = t
        bal = param(opts, '/bal:')
        sc = param(opts, '/scatter:')
        if sc:
            vol, bal = [100 - sc[0], 100], [50 - sc[0] // 2, 50 + sc[0] // 2]
        if vol and vol != [100, 100]:
            e['vol'] = [vol[0], max(vol)]
        if bal and bal != [50, 50]:
            e['bal'] = [bal[0], max(bal)]
    return e, None


def sector_sound(path):
    """(townmap, scheme 1, scheme 2) of a .sec, or None for an old sector without them."""
    data = path.read_bytes()
    lights = struct.unpack_from('<I', data, 0)[0]
    off = 4 + lights * 0x30 + 4096 * 4
    roof_empty = struct.unpack_from('<i', data, off)[0]
    off += 4 + (1024 if roof_empty == 0 else 0)
    ph = struct.unpack_from('<i', data, off)[0]
    off += 4
    if ph < 0xAA0003:
        return None
    off += 4 + struct.unpack_from('<i', data, off)[0] * 0x18 + 12
    town, _apt, _light, _flags, s1, s2 = struct.unpack_from('<6i', data, off)
    return town, s1, s2


def map_sectors(folder):
    out = {}
    for p in (MAPS / folder).rglob('*.sec'):
        if p.stem.isdigit():
            s = sector_sound(p)
            if s:
                sid = int(p.stem)
                out[(sid & 0x3FFFFFF, sid >> 26)] = (s, p.relative_to(MAPS / folder).parts[0] if len(p.relative_to(MAPS / folder).parts) > 1 else '')
    return out


def map_default(folder):
    info = MAPS / folder / 'mapinfo.txt'
    if not info.exists():
        return None
    m = re.search(r'SoundScheme:\s*(\d+)\s*,\s*(\d+)', info.read_text(errors='replace'), re.I)
    return [int(m.group(1)), int(m.group(2))] if m else None


def main():
    files = {str(p.relative_to(SOUND)).lower(): str(p.relative_to(SOUND)).replace('\\', '/')
             for p in SOUND.rglob('*') if p.suffix.lower() in ('.wav', '.mp3') and 'speech' not in p.parts[len(SOUND.parts)].lower()}
    index = mes_lines(SOUND / 'schemeindex.mes')
    lst = mes_lines(SOUND / 'schemelist.mes')
    report, missing = [], set()

    # ---- schemes ------------------------------------------------------------------------------------------------
    schemes = {}
    for n, text in index.items():
        m = re.match(r'(.*?)\s*#(\d+)', text)
        if not m:
            continue                           # <<NONE>>, <<No Sound>>: nothing loads, the slot stays silent
        start = int(m.group(2))
        entries = []
        for k in range(start, start + 100):
            if k in lst and lst[k]:
                e, miss = parse_entry(lst[k], files)
                if e:
                    entries.append(e)
                else:
                    missing.add(miss)
        name = m.group(1).strip()
        kind = 'music' if name.startswith('M.') else 'ambient'
        schemes[n] = {'name': re.sub(r'^[MA]\.\s*', '', name).replace('Liar', 'Lair').replace('Tarrant', 'Tarant')
                      .replace('Ligh)', 'Light)').replace('Moores', 'Moors').replace('Bordellow', 'Bordello'), 'kind': kind, 'list': entries}

    # ---- the world map: sectors that set schemes, townmaps ----------------------------------------------------------
    world = map_sectors(WORLD)
    wsec, folders = [], []
    used = {1, 40}
    for (x, y), ((town, s1, s2), folder) in sorted(world.items()):
        if folder not in folders:
            folders.append(folder)
        wsec.append([x, y, s1, s2, town, folders.index(folder)])
        used.update((s1, s2))

    # ---- the other maps -------------------------------------------------------------------------------------------
    maps = {}
    for d in sorted(MAPS.iterdir()):
        if not d.is_dir() or d.name == WORLD:
            continue
        secs = [[x, y, s1, s2] for (x, y), ((_t, s1, s2), _f) in sorted(map_sectors(d.name).items()) if s1 or s2]
        dflt = map_default(d.name)
        if dflt or secs:
            maps[ao.clean_map(d.name)] = {'def': dflt, 'sectors': secs} if secs else {'def': dflt}
            used.update(dflt or [])
            for s in secs:
                used.update(s[2:])
        else:
            report.append(f'-- {d.name}: no sound scheme (the game keeps what was playing)')

    # ---- areas --------------------------------------------------------------------------------------------------
    areas = []
    for n, text in sorted(mes_lines(ao.DATA / 'mes' / 'gamearea.mes').items()):
        if n == 0:
            continue
        nums = [int(v) for v in re.findall(r'-?\d+', text.split('/')[0])]
        parts = text.split('/')
        name = parts[1].strip() if len(parts) > 1 else ''
        rm = re.search(r'Radius:\s*(-?\d+)', text)
        radius = int(rm.group(1)) * 64 if rm else 5 * 64
        sx, sy = nums[0] >> 6, nums[1] >> 6
        town = world.get((sx, sy), ((0, 0, 0), ''))[0][0]
        areas.append([name, nums[0], nums[1], radius, town])

    # ---- check: areas against the world map's own folders --------------------------------------------------------
    by_town = defaultdict(Counter)
    for (x, y), ((town, _a, _b), folder) in world.items():
        if town:
            by_town[town][folder] += 1
    report.append('\n== Areas of mes/gamearea.mes: townmap of the centre sector, and the world folders of that townmap\'s sectors')
    for name, x, y, r, town in areas:
        sx, sy = x >> 6, y >> 6
        folder = world.get((sx, sy), ((0, 0, 0), '(sector not in the files)'))[1]
        report.append(f'{name:32} townmap {town:3}  centre in folder "{folder}"  ' +
                      (', '.join(f'{f} {c}' for f, c in by_town[town].most_common()) if town else '(no townmap: never "in" it)'))
    report.append('\n== Schemes the world map\'s folders set (sectors per pair)')
    pairs = defaultdict(Counter)
    for (x, y), ((town, s1, s2), folder) in world.items():
        if s1 or s2:
            pairs[folder][(s1, s2)] += 1
    for folder, c in sorted(pairs.items()):
        report.append(f'{folder:44} ' + ', '.join(f'{schemes.get(a, {}).get("name", a)} + {schemes.get(b, {}).get("name", b)} x{k}'
                                                for (a, b), k in c.most_common()))

    # ---- the files the used schemes play (the Atlas reads them from data/sound/) -------------------------------------
    used.discard(0)
    out_schemes = {n: schemes[n] for n in sorted(used) if n in schemes}
    need = {e['f'] for s in out_schemes.values() for e in s['list']} | {files[TRAVEL]}
    total = sum((SOUND / rel).stat().st_size for rel in need)
    if missing:
        report.insert(0, '-- files named in SchemeList.mes that are not in data/sound: ' + ', '.join(sorted(missing)))

    data = {'source': 'toolbox/atlas/build_sound.py',
            'note': 'schemes[n] = {name, kind, list: [{f: file under sound/, song: loop/once/over, vol: % (songs) or [min, max], '
                    'time: [h1, h2] plays while h1 <= hour <= h2, freq: chance in 1000 every 250 ms (random sounds), bal: [l, r] 0-100}]}. '
                    'world.sectors = [sector x, sector y, scheme 1, scheme 2, townmap, folder] (64 x 64 tiles a sector; 0, 0 = keep '
                    'what plays; folder = index into world.folders, the place the designers filed the sector under). '
                    'maps[key] = {def: [scheme 1, scheme 2] from mapinfo.txt, sectors}. areas = [name, x, y, radius in tiles, townmap].',
            'schemes': out_schemes, 'travel': files[TRAVEL],
            'world': {'def': map_default(WORLD), 'sectors': wsec, 'folders': folders}, 'maps': maps, 'areas': areas}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_sound.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumSound = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text('\n'.join(report) + '\n', encoding='utf-8')
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB): {len(out_schemes)} schemes, {len(wsec)} world sectors, '
          f'{len(maps)} maps, {len(areas)} areas; {len(need)} sound files played ({total // 2**20} MB, from data/sound/). Report: {REPORT.name}')


if __name__ == '__main__':
    sys.exit(main())
