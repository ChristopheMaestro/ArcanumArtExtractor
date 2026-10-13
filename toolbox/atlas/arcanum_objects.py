"""
Reading Arcanum's objects for the Atlas tools: .pro prototypes, .mob files and the static objects of .sec sectors,
with every field kept (numbers, strings, object ids, arrays), plus the .mes tables and .ART pictures they point to.

Same layouts as js/mob/mob-decoder.js and js/sec/sec-parser.js; the field schema is read from js/mob/mob-schema.js
(through toolbox/extract_mob_prototypes.py) so all the tools agree.
"""
import re
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
DATA = PROJECT / 'data'
sys.path.insert(0, str(PROJECT / 'toolbox'))
import extract_mob_prototypes as emp  # noqa: E402  (schema, object types, prototype numbers)

OBJECT_TYPES = emp.OBJECT_TYPES
ITEM_TYPES = range(5, 15)          # weapon, ammo, armor, gold, food, scroll, key, key ring, written, generic


def oid_key(raw):
    """An object id as a hashable key: its type and the 16 id bytes (the padding between them varies)."""
    return bytes(raw[0:2]) + bytes(raw[8:24]) if raw else None


def read_value(data, off, od):
    """One serialized field -> (value, next offset). Arrays come back as {index: element}."""
    if od == 3:
        return struct.unpack_from('<i', data, off)[0], off + 4
    present = data[off]
    off += 1
    if od == 4:
        return (struct.unpack_from('<q', data, off)[0] if present else None), off + (8 if present else 0)
    if od == 5:
        if not present:
            return None, off
        n = struct.unpack_from('<i', data, off)[0]
        return data[off + 4:off + 4 + n].decode('cp1252', 'replace').rstrip('\0'), off + 4 + n + 1
    if od == 6:
        return (bytes(data[off:off + 24]) if present else None), off + (24 if present else 0)
    if od == 14:
        return None, off
    if not present:
        return None, off
    size, count = struct.unpack_from('<ii', data, off)
    off += 12
    if size == 4:
        elems = list(struct.unpack_from('<%di' % count, data, off))
    elif size == 8:
        elems = list(struct.unpack_from('<%dq' % count, data, off))
    else:
        elems = [bytes(data[off + i * size:off + (i + 1) * size]) for i in range(count)]
    off += size * count
    nbits = struct.unpack_from('<i', data, off)[0]
    bits = struct.unpack_from('<%dI' % nbits, data, off + 4)
    off += 4 + nbits * 4
    logical = [w * 32 + b for w, word in enumerate(bits) for b in range(32) if word >> b & 1]
    return dict(zip(logical, elems)), off


class Obj:
    """One object: type, prototype number, own id, and its fields {number: value}."""
    __slots__ = ('type', 'proto', 'oid', 'fields', 'file', 'map', 'area')

    def __init__(self, otype, proto, oid, fields, file=''):
        self.type, self.proto, self.oid, self.fields, self.file = otype, proto, oid, fields, file

    def get(self, n, default=None):
        return self.fields.get(n, default)

    @property
    def tile(self):
        loc = self.fields.get(2)
        return (loc & 0xFFFFFFFF, (loc >> 32) & 0xFFFFFFFF) if loc is not None else None


def read_object(data, off=0, every_field=False):
    """A .mob record (every_field=False: only the fields whose bit is set) or a .pro (every field)."""
    sch = emp.schema()
    proto_oid = data[off + 4:off + 28]
    oid = bytes(data[off + 28:off + 52])
    otype = struct.unpack_from('<i', data, off + 52)[0]
    off += 56 if every_field else 58
    n = emp.MOB_BITMAP_DWORDS[otype]                  # a .pro has no field count before its bitmap
    bitmap = struct.unpack_from('<%dI' % n, data, off)
    off += n * 4
    fields = {}
    for fld in sch.fields_by_type[otype]:
        if not every_field and not (bitmap[sch.change_idx[fld]] & sch.mask[fld]):
            continue
        value, off = read_value(data, off, sch.od[fld])
        if value is not None:
            fields[fld] = value
    return Obj(otype, emp.prototype_number_from_oid(proto_oid), oid, fields), off


def read_proto(path):
    obj, _ = read_object(path.read_bytes(), 0, every_field=True)
    obj.file = path.name
    m = re.match(r'(\d+)', path.name)
    obj.proto = int(m.group(1)) if m else obj.proto
    return obj


def read_mob(path):
    obj, _ = read_object(path.read_bytes())
    obj.file = path.name
    return obj


def sec_objects(path):
    """The static objects of a .sec (layout: js/sec/sec-parser.js)."""
    data = path.read_bytes()
    lights = struct.unpack_from('<I', data, 0)[0]
    off = 4 + lights * 0x30 + 4096 * 4
    roof_empty = struct.unpack_from('<i', data, off)[0]
    off += 4 + (1024 if roof_empty == 0 else 0)
    ph = struct.unpack_from('<i', data, off)[0]
    off += 4
    if ph != 0xAA0000:
        off += 4 + struct.unpack_from('<i', data, off)[0] * 0x18
        off += (12 if ph >= 0xAA0002 else 0) + (24 if ph >= 0xAA0003 else 0) + (512 if ph >= 0xAA0004 else 0)
    out = []
    for i in range(struct.unpack_from('<i', data, len(data) - 4)[0]):
        obj, off = read_object(data, off)
        obj.file = f'{path.name}#{i}'
        out.append(obj)
    return out


class Effective:
    """An object's fields over its prototype's: what the game uses."""

    def __init__(self, obj, proto):
        self.obj, self.proto = obj, proto

    def __getitem__(self, n):
        v = self.obj.get(n)
        if v is None and self.proto is not None:
            v = self.proto.get(n)
        return v

    def int(self, n):
        v = self[n]
        return v if isinstance(v, int) else 0

    def elem(self, n, i):
        v = self[n]
        return v.get(i, 0) if isinstance(v, dict) else 0


# ---- .mes ----------------------------------------------------------------------------------------------------
def mes(path):
    out = {}
    if not path.exists():
        return out
    for m in re.finditer(r'\{(-?\d+)\}\{([^}]*)\}', path.read_text(encoding='cp1252', errors='replace')):
        out[int(m.group(1))] = m.group(2)
    return out


def descriptions():
    """description.mes, with the module's gamedesc.mes from 30000 up (game/description.c)."""
    d = mes(DATA / 'mes' / 'description.mes')
    d.update({k: v for k, v in mes(DATA / 'mes' / 'gamedesc.mes').items() if k >= 30000})
    return d


# ---- maps ----------------------------------------------------------------------------------------------------
def clean_map(name):
    """A map folder -> the map key the Atlas uses ("Bates Mansion Lev 1" -> "Bates Mansion Level 1", no "-fixed")."""
    return re.sub(r'-fixed$', '', name).replace('Lev ', 'Level ').strip()


# ---- art -----------------------------------------------------------------------------------------------------
def item_art_key(aid):
    """An item art id -> its key in item_inven.mes / item_ground.mes (js/proto/critter-aid.js)."""
    if aid is None:
        return None
    raw = aid & 0xFFFFFFFF
    if raw >> 28 != 6:
        return None
    # num is bits 17-27: Cassie's Jewelry (0x65841002) has num 706 -> 2706, I_CopperRing.art
    t, sub, cov, num = raw & 0xF, (raw >> 6) & 0xF, (raw >> 14) & 0x7, (raw >> 17) & 0x7FF
    key = num + 20 * sub + 1000 * t
    if t == 2 and cov:
        key += 20 * (5 * cov + 10)
    return key


def art_first_frame(path, palette=0):
    """The first picture of a .ART as (width, height, RGBA bytes); palette index 0 is transparent."""
    data = path.read_bytes()
    head = struct.unpack_from('<33I', data, 0)
    npal = max(1, sum(1 for x in head[3:7] if x))
    dirs = 1 if head[0] & 1 else 8
    total = dirs * head[8]
    off = 0x84
    pals = []
    for _ in range(npal):
        p = data[off:off + 1024]
        pals.append([(p[i * 4 + 2], p[i * 4 + 1], p[i * 4]) for i in range(256)])
        off += 1024
    infos = [struct.unpack_from('<IIIiiii', data, off + i * 28) for i in range(total)]
    off += total * 28
    pal = pals[palette] if palette < len(pals) else pals[0]
    key = pal[0]
    for w, h, size, *_ in infos:
        if not w or not h:
            continue
        chunk = data[off:off + size]
        n = w * h
        if size == n:
            idx = chunk
        else:
            idx, p = bytearray(n), 0
            o = 0
            while p < len(chunk) and o < n:
                c = chunk[p]; p += 1
                k = c & 0x7F
                if c & 0x80:
                    m = min(k, n - o)
                    idx[o:o + m] = chunk[p:p + m]; p += k; o += m
                else:
                    if p >= len(chunk):
                        break
                    e = min(n, o + k)
                    idx[o:e] = bytes([chunk[p]]) * (e - o); p += 1; o = e
        rgba = bytearray(n * 4)
        for i, v in enumerate(idx):
            r, g, b = pal[v]
            if (r, g, b) != key:
                rgba[i * 4:i * 4 + 4] = bytes((r, g, b, 255))
        return w, h, bytes(rgba)
    return None
