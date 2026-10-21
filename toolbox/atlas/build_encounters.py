"""
Random encounters on the world map, as the game rolls them (ui/wmap_rnd.c), from Rules/WMap_Rnd.mes:

  10000+  chance zones   {x, y, radius, n%}: the chance of an encounter at each roll; 5 % outside every zone
  20000+  power zones    {x, y, radius, None/Easy/Average/Powerful}: how hard; Average outside every zone, None = no encounter
  30000+  table zones    {x, y, radius, table}: a fixed table for that spot
  50000 + 100 * table    the tables: "freq%, First: <basic proto>, <n or a-b>, Second: ..., MinLevel:, GlobalFlag:, TriggerCount:"
                         basic proto + 20 = the critter prototype. Table of a spot = (terrain - 1) * 6 + (power - 1) * 2 + night.
A spot is in a zone when max(|dx|, |dy|) <= radius (location_dist), the smallest zone wins. The terrain is the base terrain
of the sector (terrain.tdf of the world map: per sector a 16-bit id, base type = id >> 11, the transition's other type =
(id >> 6) & 31); water, mountains and scorched earth (either side) mean no encounter, and so do the sectors of a town map
(the townmap number in the sector's .sec). The game reads "MinLevel:" twice, so a MaxLevel never applies.

Writes js/atlas/data/encounters.js (window.ArcanumEncounters). Re-run rather than edit:  py build_encounters.py
"""
import json
import re
import struct
import sys
import zlib
from pathlib import Path

import arcanum_objects as ao
import sec_alias

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ao.DATA_JS                   # the generated data the pages load
WORLD = ao.DATA / 'maps' / 'Arcanum1-024-fixed'
OUT_JS = DATA_JS / 'encounters.js'
POWER = ['none', 'easy', 'average', 'powerful']
TERRAINS = ['', 'Grasslands', 'Plains', 'Swamps', 'Elven forest', 'Tropical jungle', 'Desert', 'Forest', 'Snowy plains', 'Void']
# engine terrain type (terrain.mes order) -> encounter terrain (wmap_rnd_terrain_type_tbl); 0 = never an encounter
TERRAIN_TBL = [1, 3, 0, 2, 7, 6, 9, 2, 6, 0, 4, 2, 8, 5, 0, 0, 0, 0, 0]
SLOTS = ['First:', 'Second:', 'Third:', 'Fourth:', 'Fifth:']


def raw_mes(path):
    """The entries of a .mes as raw text (the values hold commas and colons ao.mes keeps as they are)."""
    out = {}
    for m in re.finditer(r'\{(\d+)\}\{([^}]*)\}', ao.read_text(path)):
        out[int(m.group(1))] = m.group(2)
    return out


def chart(mes, start, value):
    out = []
    k = start
    while k in mes:
        parts = [p.strip() for p in mes[k].split(',')]
        out.append([int(parts[0]), int(parts[1]), int(parts[2]), value(parts[3])])
        k += 1
    return out


def critter_names():
    desc = ao.descriptions()
    names = {}
    for p in (ao.DATA / 'proto').rglob('*.pro'):
        o = ao.read_proto(p)
        if o.type == 16:
            names[o.proto] = (desc.get(o.get(23) or 0) or '').strip()
    return names


def tables(mes, names):
    count = int(mes.get(49999, '0').split()[0]) + 54
    out = []
    for t in range(count):
        rows = []
        for k in range(50000 + 100 * t, 50100 + 100 * t):
            if k not in mes:
                continue
            s = mes[k]
            freq = int(re.match(r'\s*(\d+)', s).group(1))
            group = []
            for slot in SLOTS:
                # "Thrid:" is how the file spells it twice; the game does not find it there either
                m = re.search(re.escape(slot) + r'\s*(\d+)\s*,\s*(\d+)(?:\s*-\s*(\d+))?', s)
                if not m:
                    break
                bp, lo = int(m.group(1)), int(m.group(2))
                hi = int(m.group(3)) if m.group(3) else lo
                group.append([names.get(bp + 20) or f'#{bp}', lo, hi])
            if not group:
                continue
            row = [freq, group]
            extra = {}
            m = re.search(r'MinLevel:\s*(\d+)', s)
            if m and int(m.group(1)) > 0:
                extra['min'] = int(m.group(1))
            if re.search(r'GlobalFlag:\s*\d+', s):
                extra['story'] = 1          # only once something has happened in the story
            m = re.search(r'TriggerCount:\s*(\d+)', s)
            if m:
                extra['times'] = int(m.group(1))
            if extra:
                row.append(extra)
            rows.append(row)
        out.append(rows)
    return out


def terrain_grid():
    b = (WORLD / 'terrain.tdf').read_bytes()
    _, flags, w, h, _ = struct.unpack_from('<fIqqi', b, 0)
    off, grid = 32, []
    for _ in range(h):
        if flags & 1:
            size = struct.unpack_from('<i', b, off)[0]
            row = zlib.decompress(b[off + 4:off + 4 + size])
            off += 4 + size
        else:
            row = b[off:off + 2 * w]
            off += 2 * w
        ids = struct.unpack('<%dH' % w, row)
        out = bytearray(w)
        for x, tid in enumerate(ids):
            base, comp = tid >> 11 & 31, tid >> 6 & 31
            if base < len(TERRAIN_TBL) and comp < len(TERRAIN_TBL) and TERRAIN_TBL[base] and TERRAIN_TBL[comp]:
                out[x] = TERRAIN_TBL[base]
        grid.append(out)
    return w, h, grid


def town_sectors():
    """Sectors of the world map with a town map: no random encounter there (wmap_rnd_check)."""
    towns = set()
    for path in sec_alias.rglob(WORLD, '*.sec'):
        if not path.stem.isdigit():
            continue
        data = path.read_bytes()
        lights = struct.unpack_from('<I', data, 0)[0]
        off = 4 + lights * 0x30 + 4096 * 4
        roof_empty = struct.unpack_from('<i', data, off)[0]
        off += 4 + (1024 if roof_empty == 0 else 0)
        ph = struct.unpack_from('<i', data, off)[0]
        off += 4
        if ph < 0xAA0003:
            continue
        off += 4 + struct.unpack_from('<i', data, off)[0] * 0x18 + 12
        if struct.unpack_from('<i', data, off)[0]:
            sid = int(path.stem)
            towns.add((sid & 0x3FFFFFF, sid >> 26))
    return towns


def rle(row):
    """A row of small numbers as runs "<value><length>,": the browser expands it on demand."""
    out, x = [], 0
    while x < len(row):
        v, n = row[x], 1
        while x + n < len(row) and row[x + n] == v:
            n += 1
        out.append(f'{v}{n}' if n > 1 else str(v) + '1')
        x += n
    return ','.join(out)


def main():
    mes = raw_mes(ao.DATA / 'Rules' / 'WMap_Rnd.mes')
    names = critter_names()
    zones = chart(mes, 10000, lambda v: int(v.rstrip('%')))
    powers = chart(mes, 20000, lambda v: POWER.index(v.lower()) if v.lower() in POWER else 2)
    fixed = chart(mes, 30000, int)
    tabs = tables(mes, names)
    w, h, grid = terrain_grid()
    towns = town_sectors()
    for x, y in towns:
        if 0 <= x < w and 0 <= y < h:
            grid[y][x] = 0
    data = {'source': 'toolbox/atlas/build_encounters.py',
            'note': 'zones/powers/fixed = [x, y, radius in tiles (max(|dx|,|dy|)), value]: chance %, power (0 none, 1 easy, 2 average, '
                    '3 powerful), table. Outside: 5 %, average. tables[(terrain - 1) * 6 + (power - 1) * 2 + night] = '
                    '[[freq, [[critter, min, max], ...], {min: level, story: 1, times: n}]]. grid: per sector (64 x 64 tiles) the '
                    'encounter terrain (index into terrains, 0 = none: water, mountains, a town), one run-length row per sector row.',
            'terrains': TERRAINS, 'powers': ['None', 'Easy', 'Average', 'Powerful'],
            'zones': zones, 'powerZones': powers, 'fixed': fixed, 'tables': tabs,
            'grid': {'w': w, 'h': h, 'sector': 64, 'rows': [rle(r) for r in grid]}}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_encounters.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumEncounters = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    land = sum(1 for r in grid for v in r if v)
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB): {len(zones)} chance zones, {len(powers)} power zones, '
          f'{len(fixed)} fixed, {len(tabs)} tables ({sum(map(len, tabs))} rows), {land} sectors where encounters happen, {len(towns)} town sectors')


if __name__ == '__main__':
    sys.exit(main())
