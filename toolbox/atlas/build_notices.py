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
import asset_refs as ar
import build_submaps as bs

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ROOT / 'js' / 'atlas' / 'data'                   # the generated data the pages load
MAPS = ao.DATA / 'maps'
WORLD = bs.WORLD
OUT_JS = DATA_JS / 'notices.js'
F_SCRIPTS = 32
EXAMINE, USE = 0, 1                              # the hooks that read something out
TELEPORT, FADE_TELEPORT, FLOAT_LINE, PRINT_LINE = 44, 102, 23, 24
SVT_NUMBER = 3
THINGS = {1, 2, 3}                               # portal, container, scenery
MERGE = 4                                        # tiles of one sign (a long board is several objects with one script)
DLG = re.compile(r'\{(\d+)\}\{(.*?)\}', re.S)
# names the game gives to objects that are not shown at all, only there to catch a click
PLACEHOLDER = re.compile(r'stone|something|object|passage|thing|bed|heavy|light wood door|door', re.I)


F_DESCRIPTION = 23                               # the name an object carries of its own (a sign is named after what it says)
# scenery that has a name of its own and is not a sign
NOT_A_SIGN = re.compile(r'candle|lantern|light|torch|fire|altar|ladder|stairs|portal|door|passage|vent|grate|hatch|trap|sarcophag|'
                        r'bed$|barrel|crate|cart|rock|couch|table|throne|dresser|window|control box|device|crystal ball|blood|book|tree|'
                        r'machine|engine|diagram|mural|tombstone|object|statue|plaque', re.I)


def read_scripts():
    """script number -> (file stem, [dialogue line numbers it prints or floats]) for scripts that do not teleport."""
    out = {}
    for f in (ao.DATA / 'scr').glob('*.scr'):
        m = re.match(r'(\d+)', f.name)
        if not m:
            continue
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
        if lines and not tele:
            out[int(m.group(1))] = (f.stem, lines)
    return out


def dialogue(stem, cache={}):
    if stem not in cache:
        p = ao.DATA / 'dlg' / (stem + '.dlg')
        cache[stem] = {int(a): b for a, b in DLG.findall(p.read_text(encoding='cp1252', errors='replace'))} if p.exists() else {}
    return cache[stem]


def hooked(o):
    """[(hook, script number)] of an object."""
    v = o.get(F_SCRIPTS)
    out = []
    if isinstance(v, dict):
        for k, b in v.items():
            if isinstance(b, bytes) and len(b) >= 12 and k in (EXAMINE, USE):
                out.append((k, struct.unpack_from('<I', b, 8)[0]))
    return out


def title_of(name, text):
    if name and not PLACEHOLDER.search(name):
        return name
    words = text.split()
    return ' '.join(words[:6]) + ('…' if len(words) > 6 else '')


def main():
    scripts = read_scripts()
    desc = ao.descriptions()
    world_place = {}
    data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', (DATA_JS / 'world-labels.js').read_text(encoding='utf-8'), re.S).group(1))
    plain = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
    for p in data['places']:
        if p.get('worldFolder'):
            world_place[plain(p['worldFolder'])] = p['name']
    sector_area = {}
    for sec in (MAPS / WORLD).rglob('*.sec'):
        rel = sec.relative_to(MAPS / WORLD).parts
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
        if from_sec and o.type == 3 and own and not NOT_A_SIGN.search(own) and own.lower() != (desc.get(o.proto - 20) or '').strip().lower():
            lines = [re.sub(r'\s+', ' ', p).strip(' -*') for p in re.split(r'\s[*]\s|\s{2,}', own)]
            lines = [p for p in lines if p]
            if lines:
                boards.append((key, area, o.tile[0], o.tile[1], '\n'.join(lines), lines[-1], ar.ref(file, o, protos)))
        name = (desc.get(o.proto - 20) or '').strip()
        if name.lower() == 'bed':                    # "you must pay the innkeeper": a shop, not a sign
            return
        for _hook, num in hooked(o):
            if num in scripts:
                found.append((key, area, o.tile[0], o.tile[1], name, num, ar.ref(file, o, protos)))

    for folder in sorted(d.name for d in MAPS.iterdir() if d.is_dir()):
        if folder in bs.SKIP_FOLDERS and folder != WORLD:
            continue
        key = None if folder == WORLD else ao.clean_map(folder)
        for sec in (MAPS / folder).rglob('*.sec'):
            sid = int(sec.stem)
            area = sector_area.get(sid, 'Wilderness') if folder == WORLD else bs.pretty(folder)
            for o in ao.sec_objects(sec):
                add(ar.sector_of(sec), key, o, area, True)
        for mob in (MAPS / folder).rglob('*.mob'):
            o = ao.read_mob(mob)
            area = (sector_area.get((o.tile[0] >> 6) | ((o.tile[1] >> 6) << 26), 'Wilderness') if o.tile else '') if folder == WORLD else bs.pretty(folder)
            add(mob.relative_to(MAPS).as_posix(), key, o, area)

    found.sort(key=lambda r: (r[0] or '', r[5], r[2], r[3]))
    signs = []
    for r in found:
        if any(s[0] == r[0] and s[5] == r[5] and abs(s[2] - r[2]) <= MERGE and abs(s[3] - r[3]) <= MERGE for s in signs):
            continue
        signs.append(r)

    rows, per = [], defaultdict(int)
    for key, area, x, y, name, num, obj in signs:
        stem, lines = scripts[num]
        table = dialogue(stem)
        text = '\n'.join(re.sub(r'\s+', ' ', table[n]).strip() for n in lines if table.get(n, '').strip())
        if not text:
            continue
        rows.append([key, area, x, y, title_of(name, text), text, obj])
        per[key or 'World'] += 1
    # the shop, street and house signs: scenery named after what it says, no script; one per object, and not where a script
    # already made a notice
    taken = {(r[0], r[2], r[3]) for r in rows}
    for key, area, x, y, text, title, obj in sorted(boards, key=lambda b: (b[0] or '', b[2], b[3])):
        if (key, x, y) in taken:
            continue
        taken.add((key, x, y))
        rows.append([key, area, x, y, title, text, obj])
        per[key or 'World'] += 1
    note = ('notices[i] = [map (null = the world, else the key of a map in submaps.js), place, tile x, tile y, title, what it says, '
            'the object (asset_refs.py: [.mob or .sec, object type, prototype, art id, scripts]; the Advanced view)]; '
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
