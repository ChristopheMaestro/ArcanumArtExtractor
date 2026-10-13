"""
The game files behind one object, for the Atlas's Advanced view: its prototype, its art id and the scripts hung on it.

An object is listed as [file, object type, prototype number, art id, scripts]:
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

F_AID, F_SCRIPTS = 1, 32


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


def ref(file, o, protos):
    """[file, object type, prototype number, art id, scripts] of an object (see above)."""
    p = protos.get(o.proto)
    return [file, o.type, o.proto if p else 0, aid(o, p), scripts(o, p)]


def sector_of(sec_path):
    """A .sec (a Path under data/maps) -> its path as the Atlas names files."""
    return sec_path.relative_to(ao.DATA / 'maps').as_posix()
