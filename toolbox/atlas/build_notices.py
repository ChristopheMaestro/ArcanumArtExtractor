"""
The signs of the game: things on a map that tell the player something when they are looked at or used.

A sign, a plaque, a gravestone, a notice board is a static object (or a door, or a container) that carries a script on its
"examine" or "use" hook, and that script prints a line (action 24, "print line") or floats one over the object (action 23,
"float line"). The line is a number into the script's own dialogue file (data/dlg/<script>.dlg). Scripts that also teleport
are doors and belong to waypoints.js; scripts that start a conversation are left out.

The script is attached to:
  * a static object of a .sec (OBJ_F_SCRIPTS_IDX, field 32; the hook is the key of the list, the script number sits at +8 of a
    12-byte element), or
  * a .mob (a door, a container, a piece of scenery that was placed on its own).

Writes js/atlas/data/notices.js (window.ArcanumNotices), which the Atlas draws as its "signs" filter.
Re-run rather than edit:  py build_notices.py
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
OUT_JS = DATA_JS / 'notices.js'
F_SCRIPTS = 32
EXAMINE, USE = 0, 1                              # the hooks that read something out
TELEPORT, FADE_TELEPORT, FLOAT_LINE, PRINT_LINE, START_IMAGE = 44, 102, 23, 24, 65
IMAGES_SRC = ao.DATA / 'art' / 'interface'
OUT_IMG = ROOT / 'atlas' / 'graphics' / 'pictures'
SVT_NUMBER = 3
THINGS = {1, 2, 3}                               # portal, container, scenery
MERGE = 4                                        # (no longer merges notices; build_map_pictures.py glow_picks still reads it for a script's pieces)
DLG = re.compile(r'\{(\d+)\}\{(.*?)\}', re.S)
# names the game gives to objects that are not shown at all, only there to catch a click
PLACEHOLDER = re.compile(r'stone|something|object|passage|thing|bed|heavy|light wood door|door', re.I)


F_DESCRIPTION = 23                               # the name an object carries of its own (a sign is named after what it says)
# scenery that has a name of its own is shown on the maps (the street, shop and house signs, and stairs, ladders, altars, doors...), except these names
# (user, 2026-10-21; counts: all of data/maps, the objects that carry that description number themselves; "for now": remove a row to show it again)
NOT_DISPLAYED = {                                # name -> (description number(s), objects in the world / in the other maps)
    'torch':         ('31011', 24, 585),
    'lantern':       ('31010', 258, 273),
    'candlestick':   ('30018', 230, 166),
    'fire':          ('31008', 161, 164),
    'electric light': ('15070', 307, 15),
    'tombstone':     ('30787', 154, 0),
    'light':         ('31007, 4043', 10, 122),
    'mine cart':     ('30604', 0, 19),
    'candle stick':  ('15106', 3, 9),
    'sewer grate':   ('30606', 12, 0),
    'wooden object': ('4018', 12, 0),
    'metal object':  ('4012', 11, 0),
    'crystal ball':  ('15127', 6, 0),
    'bed':           ('4025', 3, 0),
    'candle':        ('31009', 2, 1),
    'fireplace':     ('30653', 0, 0),                # (user, 2026-10-26; counts not taken)
    'crates':        ('30620', 0, 0),
    'temple door':   ('30539', 0, 0),
    'dresser':       ('30678', 0, 0),
    'plastic couch': ('30683', 0, 0),
    'table':         ('30791', 0, 0),
}


NOT_INFO_RU = {'Факел', 'Фонарь', 'Подсвечник', 'Электрический Фонарь', 'Огонь', 'Надгробие', 'Свет', 'Свечка', 'Свеча'}      # torch, lantern, candlestick, electric lantern, fire, gravestone, light, candle


_NOT_DISPLAYED_NAMES = []


def not_displayed_names():
    """NOT_DISPLAYED's names, and what the version being built (ARCANUM_DATA: a translated mod) calls the same description numbers."""
    if not _NOT_DISPLAYED_NAMES:
        names, desc = set(NOT_DISPLAYED), ao.descriptions()
        for nums, _w, _o in NOT_DISPLAYED.values():
            for n in nums.split(','):
                if desc.get(int(n)):
                    names.add(desc[int(n)].strip().lower())
        _NOT_DISPLAYED_NAMES.append(names)
    return _NOT_DISPLAYED_NAMES[0]


def board_lines(own, proto_name):
    """The lines of a scenery's own description when it is shown as a notice (the street, shop and house signs, stairs, altars...), else []: one that
    is not in NOT_DISPLAYED and says more than its prototype's name. The glow of the notice (build_map_pictures.glow_picks) is put on the same objects."""
    if not own or own.lower() in not_displayed_names() or own.lower() == (proto_name or '').strip().lower():
        return []
    return [p for p in (re.sub(r'\s+', ' ', p).strip(' -*') for p in re.split(r'\s[*]\s|\s{2,}', own)) if p]


def read_scripts(scr=None):
    """script number -> (file stem, [dialogue line numbers it prints or floats]) for scripts that do not teleport.
    `scr`: a module's own scr folder, in place of the game's."""
    import game_files
    out = {}
    for f, (lines, tele) in game_files.parse_files(scr or ao.DATA / 'scr', '.scr', 'notice-lines', _lines_of):   # (each file read once, kept between runs)
        m = re.match(r'(\d+)', f.name)
        if m and lines and not tele:
            out[int(m.group(1))] = (f.stem, list(lines))
    return out


def _lines_of(f):
    """(dialogue lines one script prints or floats, whether it teleports)."""
    d = f.read_bytes()
    lines, tele = [], False
    for i in range(max(min(struct.unpack_from('<i', d, 0x34)[0], (len(d) - 0x40) // 0x84), 0)):
        o = 0x40 + i * 0x84
        for a in (o + 0x2C, o + 0x58):
            typ = struct.unpack_from('<i', d, a)[0]
            if typ in (TELEPORT, FADE_TELEPORT):
                tele = True
            elif typ in (FLOAT_LINE, PRINT_LINE) and d[a + 4] == SVT_NUMBER:
                n = struct.unpack_from('<i', d, a + 12)[0]
                if n not in lines:
                    lines.append(n)
    return lines, tele


_ENUMS = []
WRITES = {'ASSIGN_NUM', 'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'RANDOM', 'DISTANCE_BETWEEN', 'LOOP_FOR'}     # (and every GET_...): actions that set a variable
STOPS = {'RETURN_AND_SKIP_DEFAULT', 'RETURN_AND_RUN_DEFAULT', 'REMOVE_THIS_SCRIPT'}


def said(path, counters, lines):
    """The lines of `lines` (read_scripts) that one object's script can print or float, read with the object's own counters (bytes 4-7 of its
    script slot): a script shared by many objects picks each one's line by a counter (Addon01's 00099Grille: the grates, the signposts and the
    plaques each say one of its 7 lines). A test of counters and numbers is decided, any other goes both ways; after an action that sets a
    variable (GET_STAT into a counter...) the counters are unknown. In the order of `lines`."""
    import game_files
    import npc_switch
    if not _ENUMS:
        _ENUMS.append((npc_switch.enum('ScriptActionType', 'SAT_'), npc_switch.enum('ScriptConditionType', 'SCT_')))
    sat, sct = _ENUMS[0]
    script = game_files.parse_file(path, 'switch-lines', npc_switch._script_lines)
    name = lambda t, tab: tab[t] if 0 <= t < len(tab) else '?'

    def value(t, v, known):
        return v if t == SVT_NUMBER else (counters[v] if known and t == npc_switch.SVT_COUNTER and 0 <= v < 4 else None)

    out, seen, todo = set(), set(), [(0, True)]
    while todo:
        i, known = todo.pop()
        if (i, known) in seen or not 0 <= i < len(script) or len(seen) > 4000:
            continue
        seen.add((i, known))
        (ct, cot, cov), act, els = script[i]
        c = name(ct, sct)
        a, b = (value(cot[0], cov[0], known), value(cot[1], cov[1], known)) if c in ('EQ', 'LE') else (None, None)
        if c == 'TRUE':
            ways = [act]
        elif a is not None and b is not None:
            ways = [act if (a == b if c == 'EQ' else a <= b) else els]
        else:
            ways = [act, els]
        for t, ot, ov in ways:
            n = name(t, sat)
            if n in STOPS:
                continue
            if n == 'GOTO':
                if ot[0] == SVT_NUMBER:
                    todo.append((ov[0], known))
                continue
            if t in (FLOAT_LINE, PRINT_LINE) and ot[0] == SVT_NUMBER:
                out.add(ov[0])
            todo.append((i + 1, known and not (n in WRITES or n.startswith('GET_'))))
    return [n for n in lines if n in out]


def counters_of(o, hook):
    """The 4 counters of an object's script slot (hook)."""
    b = (o.get(F_SCRIPTS) or {}).get(hook)
    return list(b[4:8]) if isinstance(b, bytes) and len(b) >= 12 else [0, 0, 0, 0]


def says(scripts, num, o, hook, scr=None, dlg=None):
    """What object o's script `num` (on `hook`) says, its lines one per row: read_scripts' entry, walked with the object's counters.
    `scr` / `dlg`: a module's (or a version's) own folders, in place of the game's."""
    stem, lines = scripts[num]
    table = dialogue(stem, dlg)
    lines = said((scr or ao.DATA / 'scr') / (stem + '.scr'), counters_of(o, hook), lines)
    return '\n'.join(re.sub(r'\s+', ' ', table[n]).strip() for n in lines if table.get(n, '').strip())


def read_images():
    """script number -> the interface picture it opens (action 65, "start written UI image": a diagram, a mural). The
    picture number is the first operand; data/art/interface/interface.mes names its .ART."""
    names = ao.mes(ao.DATA / 'art' / 'interface' / 'interface.mes')
    out = {}
    for f in (ao.DATA / 'scr').glob('*.scr'):
        m = re.match(r'(\d+)', f.name)
        if not m:
            continue
        d = f.read_bytes()
        for i in range(max(min(struct.unpack_from('<i', d, 0x34)[0], (len(d) - 0x40) // 0x84), 0)):
            o = 0x40 + i * 0x84
            for a in (o + 0x2C, o + 0x58):
                if struct.unpack_from('<i', d, a)[0] == START_IMAGE and d[a + 4] == SVT_NUMBER:
                    art = names.get(struct.unpack_from('<i', d, a + 12)[0], '')
                    if art.lower().endswith('.art') and (IMAGES_SRC / art).exists():
                        out[int(m.group(1))] = art[:-4]
    return out


def save_image(stem):
    """The picture as atlas/graphics/pictures/<stem>.webp; -> its path as the pages name it."""
    from PIL import Image
    OUT_IMG.mkdir(parents=True, exist_ok=True)
    w, h, rgba = ao.art_first_frame(IMAGES_SRC / (stem + '.ART'))
    Image.frombytes('RGBA', (w, h), rgba).convert('RGB').save(OUT_IMG / (stem + '.webp'), quality=85)
    return f'atlas/graphics/pictures/{stem}.webp'


def dialogue(stem, dlg=None, cache={}):
    """`dlg`: a module's own dlg folder, in place of the game's."""
    p = (dlg or ao.DATA / 'dlg') / (stem + '.dlg')
    if p not in cache:
        cache[p] = {int(a): b for a, b in DLG.findall(ao.read_text(p))} if p.exists() else {}
    return cache[p]


def hooked(o):
    """[(hook, script number)] of an object."""
    v = o.get(F_SCRIPTS)
    out = []
    if isinstance(v, dict):
        for k, b in v.items():
            if isinstance(b, bytes) and len(b) >= 12 and k in (EXAMINE, USE):
                out.append((k, struct.unpack_from('<I', b, 8)[0]))
    return out


_PLACEHOLDER_NAMES = []


def placeholder_names():
    """The version's names for what the game calls a placeholder in English (PLACEHOLDER matches English): a translated mod (Russian) names the same
    description numbers otherwise, so the base game's English names are tested and the version's name at that number is the one to skip."""
    if not _PLACEHOLDER_NAMES:
        base = ao.mes(ao.PROJECT / 'data' / 'mes' / 'description.mes')
        base.update({k: v for k, v in ao.mes(ao.PROJECT / 'data' / 'mes' / 'gamedesc.mes').items() if k >= 30000})
        mine = ao.descriptions() if ao.DATA != ao.PROJECT / 'data' else {}
        _PLACEHOLDER_NAMES.append({mine[k] for k, v in base.items() if k in mine and mine[k] != v and PLACEHOLDER.search(v)})
    return _PLACEHOLDER_NAMES[0]


def title_of(name, text):
    if name and not PLACEHOLDER.search(name) and name not in placeholder_names():
        return name
    words = text.split()
    return ' '.join(words[:6]) + ('…' if len(words) > 6 else '')


def main():
    scripts = read_scripts()
    images = read_images()
    desc = ao.descriptions()
    world_place = {}
    data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', (DATA_JS / 'world-labels.js').read_text(encoding='utf-8'), re.S).group(1))
    plain = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
    for p in data['places']:
        if p.get('worldFolder'):
            world_place[plain(p['worldFolder'])] = p['name']
    sector_area = {}
    for sec in sec_alias.rglob(MAPS / WORLD, '*.sec'):
        rel = sec_alias.rel(sec, MAPS / WORLD).parts
        sector_area[int(sec.stem)] = world_place.get(plain(rel[0]), rel[0]) if len(rel) > 1 else 'Wilderness'

    protos = ar.Protos()
    found = []                                       # (map key, area, x, y, object name, script, object: asset_refs.ref)
    boards = []                                      # (map key, area, x, y, text, title, object) of named signs without a script
    def add(file, key, o, area, from_sec=False):
        if o.type not in THINGS or not o.tile:
            return
        if o.type == 2 and not from_sec:             # a container of a .mob is shown as a container (items.js), which says what it says
            return
        own = (desc.get(o.get(F_DESCRIPTION)) or '').strip() if o.get(F_DESCRIPTION) else ''
        if from_sec and o.type == 3:
            lines = board_lines(own, desc.get(o.proto - 20))
            if lines:
                boards.append((key, area, o.tile[0], o.tile[1], '\n'.join(lines), lines[-1], ar.ref(file, o, protos)))
        name = (desc.get(o.proto - 20) or '').strip()
        if name.lower() == 'bed':                    # "you must pay the innkeeper": a shop, not a sign
            return
        for hook, num in hooked(o):
            if num in scripts or num in images:
                text = says(scripts, num, o, hook) if num in scripts else ''        # (this object's lines: its counters pick them)
                found.append((key, area, o.tile[0], o.tile[1], name, num, ar.ref(file, o, protos), text))

    for folder in sorted(d.name for d in MAPS.iterdir() if d.is_dir()):
        if folder in bs.SKIP_FOLDERS and folder != WORLD:
            continue
        key = None if folder == WORLD else ao.clean_map(folder)
        for sec in sec_alias.rglob(MAPS / folder, '*.sec'):
            sid = int(sec.stem)
            area = sector_area.get(sid, 'Wilderness') if folder == WORLD else bs.pretty(folder)
            for o in ao.sec_objects(sec):
                add(ar.sector_of(sec), key, o, area, True)
        for mob in (MAPS / folder).rglob('*.mob'):
            o = ao.read_mob(mob)
            area = (sector_area.get((o.tile[0] >> 6) | ((o.tile[1] >> 6) << 26), 'Wilderness') if o.tile else '') if folder == WORLD else bs.pretty(folder)
            add(mob.relative_to(MAPS).as_posix(), key, o, area)

    found.sort(key=lambda r: (r[0] or '', r[5], r[2], r[3]))
    signs, seen = [], set()                          # one notice per object (a long board's pieces, the signs of a post: each is clickable and glows alone)
    for r in found:
        k = (r[0], r[2], r[3], r[5], r[6][0], r[6][2])
        if k in seen:
            continue
        seen.add(k)
        signs.append(r)

    rows, per = [], defaultdict(int)
    for key, area, x, y, name, num, obj, text in signs:
        if num in images:          # opens a picture: the sign is named after it and carries it as its 8th field
            pic = images[num]
            title = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', pic)
            rows.append([key, area, x, y, title, text, obj, save_image(pic)])
            per[key or 'World'] += 1
            continue
        if not text:
            continue
        rows.append([key, area, x, y, title_of(name, text), text, obj])
        per[key or 'World'] += 1
    # the shop, street and house signs: scenery named after what it says, no script; one per object, and not where a script
    # already made a notice
    taken, taken_boards = {(r[0], r[2], r[3]) for r in rows}, set()
    for key, area, x, y, text, title, obj in sorted(boards, key=lambda b: (b[0] or '', b[2], b[3])):
        if (key, x, y) in taken or (key, x, y, obj[2], text) in taken_boards:      # (two boards on one tile are two notices; an exact copy is one)
            continue
        taken_boards.add((key, x, y, obj[2], text))
        rows.append([key, area, x, y, title, text, obj])
        per[key or 'World'] += 1
    # the Russian mod hangs a script on every torch, lantern, candlestick, fire, light, candle and gravestone: thousands of "signs" that are only scenery (user, 2026-10-21)
    n0 = len(rows)
    rows = [r for r in rows if r[4].strip() not in NOT_INFO_RU]
    if n0 != len(rows):
        print(f'{n0 - len(rows)} light sources and gravestones left out of the signs')
    note = ('notices[i] = [map (null = the world, else the key of a map in submaps.js), place, tile x, tile y, title, what it says, '
            'the object (asset_refs.py: [.mob or .sec, object type, prototype, art id, scripts]; the Advanced view), '
            'and for a diagram or mural the script opens, the picture (atlas/graphics/pictures/)]; '
            'read from the scripts hung on signs, plaques and other scenery that print or float a line when examined or used '
            '(toolbox/atlas/build_notices.py)')
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_notices.py - re-run it rather than editing by hand.\nwindow.ArcanumNotices = '
                      + json.dumps({'source': 'toolbox/atlas/build_notices.py', 'note': note, 'notices': rows}, ensure_ascii=False, separators=(',', ':')) + ';\n',
                      encoding='utf-8')
    print(f'{len(scripts)} scripts print a line; {len(found)} objects carry one, {len(rows)} signs after merging')
    print('  ' + ', '.join(f'{k} {n}' for k, n in sorted(per.items())))
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
