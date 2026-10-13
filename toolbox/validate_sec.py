#!/usr/bin/env python3
"""Checks .sec files against what the game needs to load them (Arcanum CE sources: sector.c sector_load_game,
sector_object_list.c, obj.c, light.c) and what every shipped sector does.

    py toolbox/validate_sec.py <file.sec | folder | export.zip> ...

Errors (exit code 1):
  - a section the engine cannot read (lights, tiles, roofs, placeholder, scripts, properties, blocks, objects,
    final count)
  - num_fields that differs from the set bits of the change bitmap (the engine allocates num_fields slots)
  - an object or light outside sector N in a map's own N.sec (it is loaded with sector_id = -1: nothing is moved)
  - a light record with a non-zero obj (it would be taken for an object's light)
  - a prototype number with no file in data/proto
  - wall / portal art ids whose mirror bits 0x11 disagree with the rotation (set exactly for rotations 2, 3, 6, 7)
  - objects not stored in the engine's order (by tile, then sub_4F20A0): a save's .dif records are applied in file
    order, so they land on the wrong objects and the sector fails to load
Warnings: scenery without F_AID (24), shipped scenery nearly always has it.

Terrain templates (anything under a folder named 'terrain') are moved by the engine, so their locations are not
checked. 37 of the 2,487 shipped sectors fail the order check (objects whose flags changed after placement).
"""
from __future__ import annotations

import os
import re
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROTO_ROOT = ROOT / 'data' / 'proto'

# ---- object field schema (js/mob/mob-schema.js) ------------------------------------------------------------
OD = [1,3,4,3,3,3,9,9,9,3,3,3,3,3,3,3,9,9,9,3,3,3,3,3,3,3,3,3,3,3,3,7,11,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,3,13,3,3,3,3,9,10,2,1,3,6,3,3,9,10,2,1,3,3,3,6,3,3,9,10,2,1,3,6,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,7,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,9,10,2,1,3,3,3,3,3,9,10,2,1,3,3,3,3,7,7,3,3,3,3,9,10,2,1,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,9,3,3,9,10,2,1,3,3,3,3,3,3,9,10,2,1,3,3,3,9,10,2,1,3,3,7,7,7,9,3,3,3,3,9,9,6,3,6,6,6,6,6,3,13,3,3,13,4,3,3,3,3,3,3,9,10,2,1,3,3,9,10,3,3,12,9,10,9,10,3,10,9,9,9,3,5,3,9,9,3,3,9,10,2,1,3,6,3,6,6,3,3,10,3,4,4,3,3,3,6,3,3,13,9,9,3,3,3,9,13,2,1,3,3,3,9,10,2]
GROUP_BEGIN = [0,38,45,55,68,76,86,111,140,149,163,171,178,185,192,200,210,217,252,279,306]
GROUP_PARENT_LAST = [-1,36,36,36,36,36,36,109,109,109,109,109,109,109,109,109,109,36,250,250,36]
RANGE_BEGIN = [38,45,55,68,76,86,111,86,140,86,149,86,163,86,171,86,178,86,185,86,192,86,200,86,210,217,252,217,279,306]
RANGE_END = [44,54,67,75,85,110,139,110,148,110,162,110,170,110,177,110,184,110,191,110,199,110,209,110,216,251,278,251,305,312]
RANGE_OFF = [0,1,2,3,4,5,7,9,11,13,15,17,19,21,23,25,27,29,30]
TYPE_LAST = [43,53,66,74,84,138,147,161,169,176,183,190,198,208,215,277,304,311]


def _engine():
    ci, mk, base = [-1] * len(OD), [0] * len(OD), [0] * len(GROUP_BEGIN)
    gidx = lambda b: GROUP_BEGIN.index(b) if b in GROUP_BEGIN else 0
    for f, od in enumerate(OD):
        if od == 1:
            pl = GROUP_PARENT_LAST[gidx(f)]
            base[gidx(f)] = 0 if pl < 0 else ci[pl] + 1
            continue
        if od == 2:
            continue
        gs = max([x for x in GROUP_BEGIN if x < f], default=0)
        ci[f], mk[f] = (f - gs - 1) // 32 + base[gidx(gs)], 1 << ((f - gs - 1) % 32)
    return ci, mk, [ci[TYPE_LAST[t]] + 1 for t in range(18)]


CI, MK, DWC = _engine()


def fields_of(t):
    out = [f for f in range(1, 37) if OD[f] not in (1, 2)]
    for r in range(RANGE_OFF[t], RANGE_OFF[t + 1]):
        out += [f for f in range(RANGE_BEGIN[r] + 1, RANGE_END[r]) if OD[f] not in (1, 2)]
    return out


def read_field(b, o, od):
    """(value, size) of one serialized field (obj_private.c obj_data_read_file_fast)."""
    if od == 3:
        return struct.unpack_from('<i', b, o)[0], 4
    present = b[o]
    if not present:
        return None, 1
    if od == 4:
        return struct.unpack_from('<q', b, o + 1)[0], 9
    if od == 5:
        n = struct.unpack_from('<i', b, o + 1)[0]
        return b[o + 5:o + 5 + n].decode('latin1'), 6 + n
    if od == 6:
        return b[o + 1:o + 25], 25
    if od in (7, 8, 9, 10, 11, 12, 13):
        es, cnt, _ = struct.unpack_from('<iii', b, o + 1)
        p = o + 13 + es * cnt
        return None, p + 4 + 4 * struct.unpack_from('<i', b, p)[0] - o
    raise ValueError(f'unsupported field type {od}')


class SecError(Exception):
    pass


def parse_sec(b: bytes) -> dict:
    """Every section, read the way sector_load_game does."""
    need = lambda o, n, what: (_ for _ in ()).throw(SecError(f'truncated {what}')) if o + n > len(b) else None
    need(0, 4, 'light count')
    lc = struct.unpack_from('<i', b, 0)[0]
    if lc < 0:
        raise SecError(f'light count {lc}')
    o = 4
    need(o, lc * 0x30, 'light list')
    lights = [struct.unpack_from('<qqiiII', b, o + i * 0x30) for i in range(lc)]
    o += lc * 0x30
    need(o, 4 * 4096, 'tile list')
    tiles = struct.unpack_from('<4096I', b, o)
    o += 4 * 4096
    need(o, 4, 'roof list')
    if struct.unpack_from('<i', b, o)[0] == 0:
        o += 4 + 1024
    else:
        o += 4
    need(o, 4, 'placeholder')
    ph = struct.unpack_from('<i', b, o)[0]
    o += 4
    if not 0xAA0000 <= ph <= 0xAA0004:
        raise SecError(f'placeholder {ph:#x}')
    if ph != 0xAA0000:
        n = struct.unpack_from('<i', b, o)[0]
        o += 4 + n * 0x18
        if ph >= 0xAA0002:
            o += 12
        if ph >= 0xAA0003:
            o += 24
        if ph >= 0xAA0004:
            o += 512
    need(o, 4, 'object list')
    end = len(b) - 4
    cnt = struct.unpack_from('<i', b, end)[0]
    objs = []
    for i in range(cnt):
        s = o
        if o + 58 > end or struct.unpack_from('<I', b, o)[0] != 119:
            raise SecError(f'object #{i}: not an object (version) at {o:#x}')
        ptype, pnum = struct.unpack_from('<h', b, o + 4)[0], struct.unpack_from('<I', b, o + 12)[0]
        t, nf = struct.unpack_from('<ih', b, o + 52)
        if not 0 <= t < 18:
            raise SecError(f'object #{i}: type {t}')
        bm = struct.unpack_from(f'<{DWC[t]}I', b, o + 58)
        o += 58 + 4 * DWC[t]
        fl = {}
        for f in fields_of(t):
            if bm[CI[f]] & MK[f]:
                fl[f], n = read_field(b, o, OD[f])
                o += n
        if o > end:
            raise SecError(f'object #{i} runs into the final count')
        objs.append({'i': i, 'type': t, 'proto_type': ptype, 'proto': pnum, 'num_fields': nf,
                     'setbits': sum(bin(w).count('1') for w in bm), 'fields': fl, 'size': o - s})
    if o != end:
        raise SecError(f'{end - o} bytes between the last object and the final count')
    return {'lights': lights, 'tiles': tiles, 'objects': objs}


# ---- prototypes and the engine's object order ---------------------------------------------------------------
_protos: dict[int, dict] | None = None


def protos() -> dict[int, dict]:
    global _protos
    if _protos is None:
        _protos = {}
        for dp, _, fn in os.walk(PROTO_ROOT):
            for f in fn:
                m = re.match(r'^(\d+)\s*-', f)
                if not m or not f.lower().endswith('.pro'):
                    continue
                b = Path(dp, f).read_bytes()
                t = struct.unpack_from('<i', b, 52)[0]
                o, vals = 56 + 4 * DWC[t], {}
                for fld in fields_of(t):          # a prototype stores every field of its type
                    vals[fld], n = read_field(b, o, OD[fld])
                    o += n
                _protos[int(m.group(1))] = vals
    return _protos


def get(o, f):
    if f in o['fields']:
        return o['fields'][f] or 0
    return protos().get(o['proto'], {}).get(f) or 0


def loc_xy(v):
    v &= (1 << 64) - 1
    return v & 0xFFFFFFFF, v >> 32


def sort_key(o):
    if o['type'] in (0, 1):
        rot = (get(o, 1) >> 11) & 7
        ox, oy = 0, (19 if 1 < rot < 6 else -20)
    else:
        ox, oy = get(o, 3), get(o, 4)
    v1, v2 = int((ox - 40) / 2), 2 * int(oy / 2)       # location.c sub_4B93F0 (C division)
    return v2 - v1, v1 + v2


def insert(lst, n):
    """sector_object_list.c sub_4F20A0."""
    nflags, (nv1, nv2) = get(n, 19), sort_key(n)
    for i, e in enumerate(lst):
        flags = get(e, 19)
        if nflags & 0x4:                                   # OF_FLAT
            if not flags & 0x4 or (n['type'] == 3 and get(n, 69) & 0x200):   # OSCF_UNDER_ALL
                lst.insert(i, n)
                return
        elif n['type'] == 0 and e['type'] == 1:
            lst.insert(i, n)
            return
        elif n['type'] == 1 and e['type'] == 0:
            lst.insert(i + 1, n)
            return
        if not flags & 0x4:
            v3, v4 = sort_key(e)
            if nv2 < v4 or (nv2 == v4 and nv1 < v3):
                lst.insert(i, n)
                return
    lst.append(n)


def engine_order(objs):
    heads = [[] for _ in range(4096)]
    for o in objs:
        x, y = loc_xy(get(o, 2))
        insert(heads[(y & 63) * 64 + (x & 63)], o)
    return [o for h in heads for o in h]


# ---- checks ----------------------------------------------------------------------------------------------------
def check(name: str, b: bytes, terrain: bool) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    try:
        r = parse_sec(b)
    except (SecError, struct.error, ValueError) as e:
        return [f'cannot be read: {e}'], []
    m = re.match(r'^(\d+)\.sec$', re.split(r'[\\/:]', name)[-1], re.I)
    sector = None
    if m and not terrain:
        sid = int(m.group(1))
        sector = (sid & 0x3FFFFFF, sid >> 26)
    count = lambda what, n: f'{n} {what}' if n else None
    out_l = sum(1 for l in r['lights'] if sector and tuple(v >> 6 for v in loc_xy(l[1])) != sector)
    errors.append(count(f'light(s) outside sector {sector}', out_l))
    errors.append(count('light record(s) with a non-zero obj', sum(1 for l in r['lights'] if l[0])))
    objs = r['objects']
    errors.append(count('object(s) whose num_fields differs from the change bitmap', sum(1 for o in objs if o['num_fields'] != o['setbits'])))
    errors.append(count('object(s) with an unknown prototype', sum(1 for o in objs if o['proto_type'] == 1 and o['proto'] not in protos())))
    out_o = [o for o in objs if sector and tuple(v >> 6 for v in loc_xy(get(o, 2))) != sector]
    if out_o:
        where = sorted({tuple(v >> 6 for v in loc_xy(get(o, 2))) for o in out_o})
        errors.append(f'{len(out_o)} object(s) outside sector {sector} (they claim {", ".join(map(str, where[:4]))})')
    mirror = 0
    for o in objs:
        a = (o['fields'].get(1) or 0) & 0xFFFFFFFF
        if 1 in o['fields'] and a >> 28 in (1, 3) and (a & 0x11) != (0x11 if (a >> 11) & 2 else 0):
            mirror += 1
    errors.append(count('wall/portal art id(s) whose mirror bits disagree with the rotation', mirror))
    if [id(o) for o in engine_order(objs)] != [id(o) for o in objs]:
        first = next(i for i, (a, e) in enumerate(zip(objs, engine_order(objs))) if a is not e)
        errors.append(f'objects are not in the engine order (first difference at object #{first})')
    warnings.append(count('scenery object(s) without F_AID (24)', sum(1 for o in objs if o['type'] == 3 and 1 in o['fields'] and 24 not in o['fields'])))
    return [e for e in errors if e], [w for w in warnings if w]


def inputs(args):
    for a in args:
        p = Path(a)
        if p.is_dir():
            for f in sorted(p.rglob('*')):
                if f.suffix.lower() == '.sec':
                    yield str(f), f.read_bytes(), 'terrain' in [x.lower() for x in f.parts]
        elif p.suffix.lower() == '.zip':
            with zipfile.ZipFile(p) as z:
                for n in sorted(z.namelist()):
                    if n.lower().endswith('.sec'):
                        yield f'{p.name}:{n}', z.read(n), False
        elif p.is_file():
            yield str(p), p.read_bytes(), 'terrain' in [x.lower() for x in p.parts]
        else:
            print(f'not found: {a}')


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except Exception:
            pass
    files = bad = 0
    for name, b, terrain in inputs(argv):
        if re.split(r'[\\/:]', name)[-1] == '134217730001.sec':   # demo-limits text file, not a sector
            continue
        files += 1
        errors, warnings = check(name, b, terrain)
        if errors:
            bad += 1
        if errors or warnings:
            print(f'{"FAIL" if errors else "ok  "}  {name}')
            for e in errors:
                print(f'        error:   {e}')
            for w in warnings:
                print(f'        warning: {w}')
    print(f'{files} sector file(s) checked, {bad} with errors.')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
