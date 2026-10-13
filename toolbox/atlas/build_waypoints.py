"""
The waypoints of the game, read from its scripts.

A waypoint is a thing on a map - most of the time a door, a ladder or a manhole - that carries a script with the
"teleport" command (action 44) or "fade and teleport" (102): stepping through puts you on another map, or another
place of the same one. Both actions name the destination as three constants: a map (Rules/MapList.mes number, 5000 =
the world) and a tile. The script is attached to:
  * a static object of a .sec (OBJ_F_SCRIPTS_IDX, field 32, the script number at +8 of a 12-byte element),
  * a .mob (a trap door, a lid...), or
  * a tile of a sector (the sector's tile-script list: walking onto the tile triggers it).
Scripts hung on people (their death, their dialog) also teleport, but they are not places you walk through: left out.

Writes js/atlas/data/waypoints.js (window.ArcanumWaypoints), which the Atlas draws as its waypoints in place of the Map Explorer's
hand-made labels. Re-run rather than edit:  py build_waypoints.py
"""
import json
import re
import struct
import sys
from collections import defaultdict
from pathlib import Path

import arcanum_objects as ao
import asset_refs as ar
import build_submaps as bs

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ROOT / 'js' / 'atlas' / 'data'                   # the generated data the pages load
MAPS = ao.DATA / 'maps'
WORLD = bs.WORLD
OUT_JS = DATA_JS / 'waypoints.js'
F_SCRIPTS = 32
TELEPORT, FADE_TELEPORT = 44, 102
SVT_NUMBER = 3                                  # an operand that is a plain number
WALKED = {1, 2, 3}                              # portal, container, scenery: the things a script door hangs on
MERGE = 4                                       # tiles of one door (a double door is two objects with one script)


def teleports():
    """script number -> [(map id, x, y)] for every teleport the script can do with all three operands plain numbers."""
    out = {}
    for f in (ao.DATA / 'scr').glob('*.scr'):
        m = re.match(r'(\d+)', f.name)
        if not m:
            continue
        d = f.read_bytes()
        for i in range(max(min(struct.unpack_from('<i', d, 0x34)[0], (len(d) - 0x40) // 0x84), 0)):
            o = 0x40 + i * 0x84
            for a in (o + 0x2C, o + 0x58):             # the action and the "else" action
                typ = struct.unpack_from('<i', d, a)[0]
                if typ not in (TELEPORT, FADE_TELEPORT):
                    continue
                at, v = d[a + 4:a + 12], struct.unpack_from('<8i', d, a + 12)
                first = 1 if typ == TELEPORT else 4
                if all(at[first + k] == SVT_NUMBER for k in range(3)):
                    dest = (v[first], v[first + 1], v[first + 2])
                    if dest not in out.setdefault(int(m.group(1)), []):
                        out[int(m.group(1))].append(dest)
    return out


def tile_scripts(data):
    """(tile index in the sector, script number) of the tile scripts of a .sec."""
    lights = struct.unpack_from('<I', data, 0)[0]
    off = 4 + lights * 0x30 + 4096 * 4
    roof_empty = struct.unpack_from('<i', data, off)[0]
    off += 4 + (1024 if roof_empty == 0 else 0)
    ph = struct.unpack_from('<i', data, off)[0]
    off += 4
    out = []
    if ph != 0xAA0000:
        for i in range(struct.unpack_from('<i', data, off)[0]):
            a = off + 4 + i * 0x18
            out.append((struct.unpack_from('<I', data, a + 4)[0], struct.unpack_from('<i', data, a + 16)[0]))
    return out


def scripts_of(o):
    v = o.get(F_SCRIPTS)
    if isinstance(v, dict):
        for b in v.values():
            if isinstance(b, bytes) and len(b) >= 12:
                yield struct.unpack_from('<I', b, 8)[0]


def main():
    tp = teleports()
    desc = ao.descriptions()
    listing = bs.map_list()
    by_id = {}
    for folder in (d.name for d in MAPS.iterdir() if d.is_dir()):
        info = listing.get(folder.lower())
        if info:
            by_id[info['id']] = folder

    world_place = {}
    wl = DATA_JS / 'world-labels.js'
    data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))
    plain = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())        # a few folders spell an apostrophe as a stray character
    for p in data['places']:
        if p.get('worldFolder'):
            world_place[plain(p['worldFolder'])] = p['name']
    sector_area = {}                                # world sector id -> the place its folder stands for
    for sec in (MAPS / WORLD).rglob('*.sec'):
        rel = sec.relative_to(MAPS / WORLD).parts
        sector_area[int(sec.stem)] = world_place.get(plain(rel[0]), rel[0]) if len(rel) > 1 else 'Wilderness'

    def where(map_id, x, y):
        """-> (map key or None for the world, place name)."""
        folder = by_id.get(map_id)
        if folder is None or folder in bs.SKIP_FOLDERS and folder != WORLD:
            return 'skip', None
        if folder == WORLD:
            return None, sector_area.get((x >> 6) | ((y >> 6) << 26), 'Wilderness')
        return ao.clean_map(folder), bs.pretty(folder)

    protos = ar.Protos()
    found = []                                      # (source map key, source place, x, y, what, script, object: asset_refs.ref)
    for folder in sorted(d.name for d in MAPS.iterdir() if d.is_dir()):
        if folder in bs.SKIP_FOLDERS and folder != WORLD:
            continue
        key = None if folder == WORLD else ao.clean_map(folder)
        for sec in (MAPS / folder).rglob('*.sec'):
            sid = int(sec.stem)
            sx, sy = (sid & 0x3FFFFFF) << 6, (sid >> 26) << 6
            area = sector_area.get(sid, 'Wilderness') if folder == WORLD else bs.pretty(folder)
            raw = sec.read_bytes()
            for tile, num in tile_scripts(raw):
                if num in tp:
                    found.append((key, area, sx + (tile & 63), sy + ((tile >> 6) & 63), '', num, [ar.sector_of(sec), 0, 0, 0, [[-1, num]]]))
            for o in ao.sec_objects(sec):
                if o.type in WALKED and o.tile:
                    for num in scripts_of(o):
                        if num in tp:
                            found.append((key, area, o.tile[0], o.tile[1], (desc.get(o.proto - 20) or '').strip(), num, ar.ref(ar.sector_of(sec), o, protos)))
        for mob in (MAPS / folder).rglob('*.mob'):
            o = ao.read_mob(mob)
            if o.type in WALKED and o.tile:
                for num in scripts_of(o):
                    if num in tp:
                        area = sector_area.get((o.tile[0] >> 6) | ((o.tile[1] >> 6) << 26), 'Wilderness') if folder == WORLD else bs.pretty(folder)
                        found.append((key, area, o.tile[0], o.tile[1], (desc.get(o.proto - 20) or '').strip(), num, ar.ref(mob.relative_to(MAPS).as_posix(), o, protos)))

    # one waypoint per door: the objects of one script that stand within a few tiles of each other are one
    found.sort(key=lambda r: (r[0] or '', r[5], r[2], r[3]))
    doors = []
    for r in found:
        for d in doors:
            if d[0] == r[0] and d[5] == r[5] and abs(d[2] - r[2]) <= MERGE and abs(d[3] - r[3]) <= MERGE:
                break
        else:
            doors.append(r)

    rows, skipped = [], defaultdict(int)
    for key, area, x, y, what, num, obj in doors:
        to = []
        for map_id, tx, ty in tp[num]:
            tkey, tplace = where(map_id, tx, ty)
            if tkey == 'skip':
                skipped['to a map the atlas does not have'] += 1
                continue
            to.append([tkey, tplace, tx, ty])
        if to:
            rows.append([key, area, x, y, what, to, obj])
    note = ('waypoints[i] = [map (null = the world, else the key of a map in submaps.js), place (the area it stands in), tile x, tile y, '
            'what it is (the object\'s name, "" for a tile), destinations [[map, place, tile x, tile y], ...], '
            'the object or tile the script hangs on (asset_refs.py: [.mob or .sec, object type, prototype, art id, scripts]; the Advanced view)]; read from the '
            'teleport commands of the scripts hung on doors, ladders and tiles (toolbox/atlas/build_waypoints.py)')
    out = {'source': 'toolbox/atlas/build_waypoints.py', 'note': note, 'waypoints': rows}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_waypoints.py - re-run it rather than editing by hand.\nwindow.ArcanumWaypoints = '
                      + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    per = defaultdict(int)
    for r in rows:
        per[r[0] or 'World'] += 1
    print(f'{len(tp)} scripts teleport; {len(found)} doors and tiles carry one, {len(rows)} waypoints after merging doors')
    print('  ' + ', '.join(f'{k} {n}' for k, n in sorted(per.items())))
    print('  left out: ' + (', '.join(f'{k}: {n}' for k, n in skipped.items()) or 'nothing'))
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
