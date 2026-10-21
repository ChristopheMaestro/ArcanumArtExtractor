"""
The game files behind one object, for the Atlas's Advanced view: its prototype, its art id and the scripts hung on it.

An object is listed as [file, object type, prototype number, art id, scripts, own .mes texts (only when it has any)]:
  file       its .mob, or the .sec it is a static object of (paths under data/maps)
  type       the object type (1 portal, 2 container, 3 scenery, 15 PC, 16 NPC...; 0 = a tile script, no object)
  art id     F_CURRENT_AID (field 1), the object's own or its prototype's (the page turns it into an .ART file name the way
             the Asset Browser does: js/proto/critter-aid.js, js/proto/proto-card-art.js)
  scripts    [[attachment point, script number], ...] from OBJ_F_SCRIPTS_IDX (field 32; the point is the array index, the
             number at +8 of the 12-byte element); the .mob's own take the place of the prototype's at the same point.
             Point -1 = a tile script of the sector (walking onto the tile runs it).
build_assets.py writes the .mob ones, build_waypoints.py and build_notices.py put one on each waypoint and sign.
"""
import struct

import arcanum_objects as ao

F_AID, F_NAME, F_DESCRIPTION, F_SCRIPTS = 1, 22, 23, 32


class Protos:
    """Every .pro under data/proto, by number (loaded once)."""
    _all = None

    def __init__(self):
        if Protos._all is None:
            Protos._all = {}
            for p in (ao.DATA / 'proto').rglob('*.pro'):
                o = ao.read_proto(p)
                o.file = p.relative_to(ao.DATA / 'proto').as_posix()
                Protos._all[o.proto] = o
        self.by_num = Protos._all

    def get(self, num):
        return self.by_num.get(num)


def scripts(o, proto):
    slots = {}
    for src in (proto.get(F_SCRIPTS) if proto else None, o.get(F_SCRIPTS)):
        if isinstance(src, dict):
            for point, b in src.items():
                if isinstance(b, (bytes, bytearray)) and len(b) >= 12:
                    num = struct.unpack_from('<I', b, 8)[0]
                    if num:
                        slots[point] = num
    return [[p, n] for p, n in sorted(slots.items())]


def aid(o, proto):
    v = o.get(F_AID)
    if v is None and proto is not None:
        v = proto.get(F_AID)
    return v & 0xFFFFFFFF if isinstance(v, int) else 0


_mes = {}


def own_texts(o, proto):
    """The .mes entries of the object's own F_NAME (oemes/oname.mes) and F_DESCRIPTION (mes/description.mes, from 30000 mes/gamedesc.mes) when they
    differ from its prototype's: [[mes file, text], ...] - "801 Door to Pollock's House", "Caleb Malloy's Pub"; [] = none."""
    if not _mes:
        _mes['oname'] = ao.mes(ao.DATA / 'oemes' / 'oname.mes')
        _mes['desc'] = ao.descriptions()
    out = []
    for fld, table, files in ((F_NAME, 'oname', ('oname.mes',)), (F_DESCRIPTION, 'desc', ('description.mes', 'gamedesc.mes'))):
        n = o.get(fld)
        if not n or (proto is not None and proto.get(fld) == n):
            continue
        text = _mes[table].get(n, '').strip()
        if text:
            out.append([files[-1] if n >= 30000 else files[0], text if table == 'oname' else f'{n} · {text}'])
    return out


def ref(file, o, protos):
    """[file, object type, prototype number, art id, scripts(, own .mes texts)] of an object (see above)."""
    p = protos.get(o.proto)
    r = [file, o.type, o.proto if p else 0, aid(o, p), scripts(o, p)]
    texts = own_texts(o, p)
    return r + [texts] if texts else r


def sector_of(sec_path):
    """A .sec (a Path under data/maps) -> its path as the Atlas names files."""
    return sec_path.relative_to(ao.DATA / 'maps').as_posix()
