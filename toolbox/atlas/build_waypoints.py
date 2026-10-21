"""
The waypoints of the game, read from its scripts.

A waypoint is a thing on a map - most of the time a door, a ladder or a manhole - that carries a script with the
"teleport" command (action 44) or "fade and teleport" (102): stepping through puts you on another map, or another
place of the same one. Both actions name the destination as three constants: a map (Rules/MapList.mes number, 5000 =
the world) and a tile. The script is attached to:
  * a static object of a .sec (OBJ_F_SCRIPTS_IDX, field 32, the script number at +8 of a 12-byte element),
  * a .mob (a trap door, a lid...), or
  * a tile of a sector (the sector's tile-script list: walking onto the tile triggers it).
A person is a waypoint too when a script hung on them moves the player (a ferryman, a ship's captain, a module's "teleport
assistant"): teleports that move the person themselves (a guard walking off, a clan regrouping) are left out, and so is a
destination at the person's own spot; a person switched off at the start (OF_OFF: they only appear later) is not one.
A script on a tile, and a jump point of map.jmp, have no object of their own, but something stands there that you walk into:
the magic portals of Tulla and of the Void, the standing stones outside Tulla. The waypoint is that thing (on the tile, or
the nearest within a tile of it): its tile, its name and its object, the tile script added to its scripts (point -1).

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
import sec_alias
import asset_refs as ar
import build_submaps as bs

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ao.DATA_JS                   # the generated data the pages load
MAPS = ao.DATA / 'maps'
WORLD = bs.WORLD
OUT_JS = DATA_JS / 'waypoints.js'
F_SCRIPTS = 32
TELEPORT, FADE_TELEPORT = 44, 102
SVT_NUMBER = 3                                  # an operand that is a plain number
WALKED = {1, 2, 3}                              # portal, container, scenery: the things a script door hangs on
MERGE = 4                                       # tiles of one door (a double door is two objects with one script)
STANDS_ON = 1                                   # tiles from a tile script / jump point to the portal that stands there
PEOPLE = {15, 16}                               # PC, NPC: a teleport script hung on a person (a ferryman...)
# who a teleport moves (script.h ScriptFocusObject, the object operand): the player, or the party / team they are in. Not the attachee (the person
# moving themselves) nor anyone in the vicinity
MOVES_PLAYER = {0, 4, 5, 6, 7, 21}              # triggerer, everyone / anyone in party, everyone / anyone in team, player
OF_OFF = 0x2
OWN_SPOT = 20                                   # tiles: a person's teleport to where they stand themselves is no way anywhere (a ferry's own dock: 14)


def people_teleports(scr=None):
    """script number -> [(map id, x, y)] of the teleports that move the player (MOVES_PLAYER), for scripts hung on people.
    `scr`: a module's own scr folder, in place of the game's."""
    import game_files
    out = {}
    for f, dests in game_files.parse_files(scr or ao.DATA / 'scr', '.scr', 'teleports-player', _player_teleports_of):
        m = re.match(r'(\d+)', f.name)
        if m and dests:
            out[int(m.group(1))] = list(dests)
    return out


def _player_teleports_of(f):
    return _teleports_of(f, MOVES_PLAYER)


def person_way(o, tp, desc):
    """(name, [script numbers]) when person o may be a waypoint (a script on them moves the player: `tp` = people_teleports()), else None.
    The caller drops a destination within OWN_SPOT tiles of the person on the same map (it knows which map that is)."""
    if o.type not in PEOPLE or not o.tile or (o.get(19) or 0) & OF_OFF:
        return None
    nums = list(dict.fromkeys(n for n in scripts_of(o) if n in tp))
    return ((desc.get(o.get(23)) or desc.get(o.proto - 20) or '').strip(), nums) if nums else None


def teleports(scr=None):
    """script number -> [(map id, x, y)] for every teleport the script can do with all three operands plain numbers.
    `scr`: a module's own scr folder, in place of the game's."""
    import game_files
    out = {}
    for f, dests in game_files.parse_files(scr or ao.DATA / 'scr', '.scr', 'teleports', _teleports_of):     # (each file read once, kept between runs)
        m = re.match(r'(\d+)', f.name)
        if m and dests:
            out[int(m.group(1))] = list(dests)
    return out


def _teleports_of(f, who=None):
    """[(map id, x, y)] of one script's teleports with plain numbers (`who`: only those that move one of these objects, script.h
    ScriptFocusObject: the operand before the map)."""
    return list(dict.fromkeys(dest for _, dest in _teleport_lines(f, who)))


def _teleport_lines(f, who=None):
    """[(script line, (map id, x, y))] of one script's teleports with plain numbers (`who`: as in _teleports_of)."""
    d, out = f.read_bytes(), []
    for i in range(max(min(struct.unpack_from('<i', d, 0x34)[0], (len(d) - 0x40) // 0x84), 0)):
        o = 0x40 + i * 0x84
        for a in (o + 0x2C, o + 0x58):             # the action and the "else" action
            typ = struct.unpack_from('<i', d, a)[0]
            if typ not in (TELEPORT, FADE_TELEPORT):
                continue
            at, v = d[a + 4:a + 12], struct.unpack_from('<8i', d, a + 12)
            first = 1 if typ == TELEPORT else 4
            if who is not None and at[first - 1] not in who:
                continue
            if all(at[first + k] == SVT_NUMBER for k in range(3)):
                out.append((i, (v[first], v[first + 1], v[first + 2])))
    return out


DLG_ROW = re.compile(r'\{(\d+)\}\{(.*?)\}\{(.*?)\}\{(.*?)\}\{(.*?)\}\{(.*?)\}\{(.*?)\}', re.S)


def dialog_labels(nums, scr=None, dlg=None):
    """{(map id, x, y): what the player picks} for the teleports of a person's scripts: a dialog option whose answer is -N runs line N of the
    script (Tarant's steamrail: "Station A: West Garrillon Bridge" -> -4 -> line 4 teleports to its platform; Addon01's assistant: "Téléport vers
    l'Entrepot No 1."). The first option leading to a destination names it. `scr` / `dlg`: a module's (version's) own folders."""
    out = {}
    for num in nums:
        f = next((scr or ao.DATA / 'scr').glob(f'{num:05d}*.scr'), None)
        p = (dlg or ao.DATA / 'dlg') / (f.stem + '.dlg') if f else None
        if not p or not p.is_file():
            continue
        at = dict(_teleport_lines(f, MOVES_PLAYER))
        for row in DLG_ROW.findall(ao.read_text(p)):
            text, answer = re.sub(r'\s+', ' ', row[1]).strip().rstrip('.'), row[5].strip()
            if text and re.fullmatch(r'-\d+', answer):
                n = -int(answer)
                dest = at.get(n, at.get(n + 1))         # (the teleport on that line, or the next one: a sound or a fade first)
                if dest:
                    out.setdefault(dest, text)
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


def standing(things, x, y):
    """The (object, file) of `things` standing on tile x, y, or the nearest within STANDS_ON tiles (a door first), else None:
    the portal of a tile script or a jump point."""
    near = []
    for i, (o, f) in enumerate(things):
        if o.type in WALKED:
            t = o.tile                                  # (a property: worked out once, not three times per thing)
            if t:
                d = max(abs(t[0] - x), abs(t[1] - y))
                if d <= STANDS_ON:
                    near.append((d, o.type != 1, i, o, f))
    return min(near)[3:] if near else None


def jump_points(folder):
    """[(x, y, MapList number of the destination or None for this same map, tile x, tile y)] of a map's map.jmp."""
    f = Path(folder) / 'map.jmp'
    if not f.exists():
        return []
    raw, out = f.read_bytes(), []
    for i in range(struct.unpack_from('<i', raw, 0)[0]):
        fl, x, y, dmap, dx, dy = struct.unpack_from('<I4xII i4x II', raw, 4 + i * 0x20)
        out.append((x, y, dmap + 4999 if dmap > 0 else None, dx, dy))    # the engine counts maps from 1: 1 = MapList 5000; -1 = within the map
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
    by_key = {None if f == WORLD else ao.clean_map(f): i for i, f in by_id.items()}     # (a jump within its own map)

    world_place = {}
    wl = DATA_JS / 'world-labels.js'
    data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))
    plain = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())        # a few folders spell an apostrophe as a stray character
    for p in data['places']:
        if p.get('worldFolder'):
            world_place[plain(p['worldFolder'])] = p['name']
    sector_area = {}                                # world sector id -> the place its folder stands for
    for sec in sec_alias.rglob(MAPS / WORLD, '*.sec'):
        rel = sec_alias.rel(sec, MAPS / WORLD).parts
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
    secs, mobs = defaultdict(dict), defaultdict(list)   # map key -> {sector id: .sec}, [(.mob, object)]: what stands on a tile (element)

    def element(key, x, y):
        """(name, object, tile) of the thing standing on tile x, y or nearest to it within STANDS_ON tiles, else None."""
        things = []
        for sid in {((x + dx) >> 6) | (((y + dy) >> 6) << 26) for dx in (-STANDS_ON, STANDS_ON) for dy in (-STANDS_ON, STANDS_ON)}:
            if sid in secs[key]:
                things += [(o, ar.sector_of(secs[key][sid])) for o in ao.sec_objects(secs[key][sid])]
        things += [(o, mob.relative_to(MAPS).as_posix()) for mob, o in mobs[key]]
        s = standing(things, x, y)
        if not s:
            return None
        o, f = s
        return (desc.get(o.proto - 20) or '').strip(), ar.ref(f, o, protos), tuple(o.tile)

    ptp = people_teleports()
    people = []                                     # (map key, place, x, y, name, [scripts], object): the people who move the player
    found = []                                      # (source map key, source place, x, y, what, script, object: asset_refs.ref)
    on_tiles = []                                   # (key, area, x, y, script, sector): the tile scripts, given their element below
    for folder in sorted(d.name for d in MAPS.iterdir() if d.is_dir()):
        if folder in bs.SKIP_FOLDERS and folder != WORLD:
            continue
        key = None if folder == WORLD else ao.clean_map(folder)
        for sec in sec_alias.rglob(MAPS / folder, '*.sec'):
            sid = int(sec.stem)
            secs[key][sid] = sec
            sx, sy = (sid & 0x3FFFFFF) << 6, (sid >> 26) << 6
            area = sector_area.get(sid, 'Wilderness') if folder == WORLD else bs.pretty(folder)
            raw = sec.read_bytes()
            for tile, num in tile_scripts(raw):
                if num in tp:
                    on_tiles.append((key, area, sx + (tile & 63), sy + ((tile >> 6) & 63), num, sec))
            for o in ao.sec_objects(sec):
                if o.type in WALKED and o.tile:
                    for num in scripts_of(o):
                        if num in tp:
                            found.append((key, area, o.tile[0], o.tile[1], (desc.get(o.proto - 20) or '').strip(), num, ar.ref(ar.sector_of(sec), o, protos)))
        for mob in (MAPS / folder).rglob('*.mob'):
            o = ao.read_mob(mob)
            way = person_way(o, ptp, desc)
            if way:
                area = sector_area.get((o.tile[0] >> 6) | ((o.tile[1] >> 6) << 26), 'Wilderness') if folder == WORLD else bs.pretty(folder)
                people.append((key, area, o.tile[0], o.tile[1], way[0], way[1], ar.ref(mob.relative_to(MAPS).as_posix(), o, protos)))
            if o.type in WALKED and o.tile:
                mobs[key].append((mob, o))
                for num in scripts_of(o):
                    if num in tp:
                        area = sector_area.get((o.tile[0] >> 6) | ((o.tile[1] >> 6) << 26), 'Wilderness') if folder == WORLD else bs.pretty(folder)
                        found.append((key, area, o.tile[0], o.tile[1], (desc.get(o.proto - 20) or '').strip(), num, ar.ref(mob.relative_to(MAPS).as_posix(), o, protos)))
    for key, area, x, y, num, sec in on_tiles:       # a tile script: the portal standing on the tile is the waypoint, with the script added to it
        el = element(key, x, y)
        if el:
            what, obj, (x, y) = el
            obj[4] = obj[4] + [[-1, num]]
        else:
            what, obj = '', [ar.sector_of(sec), 0, 0, 0, [[-1, num]]]
        found.append((key, area, x, y, what, num, obj))

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
    for key, area, x, y, what, nums, obj in people:  # a person who takes the player elsewhere (not to where they stand)
        to, labels = [], dialog_labels(nums)
        for map_id, tx, ty in dict.fromkeys(d for n in nums for d in ptp[n]):
            tkey, tplace = where(map_id, tx, ty)
            if tkey == 'skip':
                skipped['to a map the atlas does not have'] += 1
            elif not (tkey == key and abs(tx - x) <= OWN_SPOT and abs(ty - y) <= OWN_SPOT):
                label = labels.get((map_id, tx, ty)) if tkey == key else None     # (within the map: named by the dialog option that goes there)
                to.append([tkey, tplace, tx, ty] + ([label] if label else []))
        if to:
            rows.append([key, area, x, y, what, to, obj])

    # The jump points of a map (map.jmp): tiles that take you to another map when you step on them - the way out of
    # a house or a dungeon, which has no door script. Neighbouring tiles with one destination are one waypoint; a script
    # door already standing there for that destination is not repeated.
    jumps = []
    for folder in sorted(d.name for d in MAPS.iterdir() if d.is_dir()):
        if folder in bs.SKIP_FOLDERS and folder != WORLD:
            continue
        key = None if folder == WORLD else ao.clean_map(folder)
        for x, y, dmap, dx, dy in jump_points(MAPS / folder):
            tkey, tplace = where(dmap if dmap is not None else by_key.get(key), dx, dy)
            if tkey == 'skip':
                skipped['jump point to a map the atlas does not have'] += 1
                continue
            if folder == WORLD:
                area = sector_area.get((x >> 6) | ((y >> 6) << 26), 'Wilderness')
            else:
                area = bs.pretty(folder)
            jumps.append((key, area, x, y, tkey, tplace, dx, dy, dmap is None))
    near = lambda a, b, n: abs(a[0] - b[0]) <= n and abs(a[1] - b[1]) <= n
    for key, area, x, y, tkey, tplace, dx, dy, inside in jumps:
        same = lambda t: t[0] == tkey and t[1] == tplace and (not inside or near((t[2], t[3]), (dx, dy), 6))     # (within a map: to the same spot)
        if any(r[0] == key and near((r[2], r[3]), (x, y), 6) and any(same(t) for t in r[5]) for r in rows):
            continue                                    # a script door (or the first tile of this jump) covers it
        el = element(key, x, y)                         # the portal standing on the jump point, if any
        what, obj, (x, y) = el or ('Exit', None, (x, y))
        rows.append([key, area, x, y, what or 'Exit', [[tkey, tplace, dx, dy]], obj])
    note = ('waypoints[i] = [map (null = the world, else the key of a map in submaps.js), place (the area it stands in), tile x, tile y, '
            'what it is (the object\'s name, "" for a tile), destinations [[map, place, tile x, tile y], ...], '
            'the object the script hangs on, or that stands on the tile script / jump point (asset_refs.py: [.mob or .sec, object type, prototype, art id, scripts, '
            'a tile script as point -1]; the Advanced view), else the tile alone (type 0) or null]; read from the '
            'teleport commands of the scripts hung on doors, ladders and tiles (toolbox/atlas/build_waypoints.py)')
    out = {'source': 'toolbox/atlas/build_waypoints.py', 'note': note, 'waypoints': rows}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_waypoints.py - re-run it rather than editing by hand.\nwindow.ArcanumWaypoints = '
                      + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    per = defaultdict(int)
    for r in rows:
        per[r[0] or 'World'] += 1
    print(f'{len(tp)} scripts teleport; {len(found)} doors and tiles carry one, {len(rows)} waypoints after merging doors')
    bare = sum(1 for r in rows if not r[6] or not r[6][1])
    print(f'  {len(on_tiles)} tile scripts and {len(jumps)} jump points; {bare} waypoints have nothing standing on their tile (the tile alone)')
    print('  ' + ', '.join(f'{k} {n}' for k, n in sorted(per.items())))
    print('  left out: ' + (', '.join(f'{k}: {n}' for k, n in skipped.items()) or 'nothing'))
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
