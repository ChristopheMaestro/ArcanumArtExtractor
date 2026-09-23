#!/usr/bin/env python3
"""
Arcanum .mob field dumper.

Drop this file into a folder containing .mob files and run it.
It scans that folder (not subfolders) and writes:

    mob_field_dump.txt

With -flocation it also writes mob_flocation.txt and marks ./map.bmp,
creating map_marked.bmp with one red pixel per unique sector.

The decoder uses the ObjectFieldData/ObjectFieldEngine schema supplied with
this project. It reports every overridden field, including fields that do not
have a friendly name in ObjectInstanceReader.cs.

Generated from the supplied C# metadata; no third-party packages required.
"""

from pathlib import Path
import struct
import sys

# ---------------------------------------------------------------------------
# Project field metadata
# ---------------------------------------------------------------------------

OD_NAMES = {
    0: "Invalid",
    1: "Begin",
    2: "End",
    3: "Int32",
    4: "Int64",
    5: "String",
    6: "Handle",
    7: "Int32Array",
    8: "Int64Array",
    9: "UInt32Array",
    10: "UInt64Array",
    11: "ScriptArray",
    12: "QuestArray",
    13: "HandleArray",
    14: "Ptr",
    15: "PtrArray",
}

OD_TYPES = [1, 3, 4, 3, 3, 3, 9, 9, 9, 3, 3, 3, 3, 3, 3, 3, 9, 9, 9, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 7, 11, 3, 3, 9, 10, 2, 1, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 3, 13, 3, 3, 3, 3, 9, 10, 2, 1, 3, 6, 3, 3, 9, 10, 2, 1, 3, 3, 3, 6, 3, 3, 9, 10, 2, 1, 3, 6, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 3, 7, 7, 7, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 3, 7, 7, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 9, 10, 2, 1, 3, 9, 3, 3, 9, 10, 2, 1, 3, 3, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 3, 9, 10, 2, 1, 3, 3, 7, 7, 7, 9, 3, 3, 3, 3, 9, 9, 6, 3, 6, 6, 6, 6, 6, 3, 13, 3, 3, 13, 4, 3, 3, 3, 3, 3, 3, 9, 10, 2, 1, 3, 3, 9, 10, 3, 3, 12, 9, 10, 9, 10, 3, 10, 9, 9, 9, 3, 5, 3, 9, 9, 3, 3, 9, 10, 2, 1, 3, 6, 3, 6, 6, 3, 3, 10, 3, 4, 4, 3, 3, 3, 6, 3, 3, 13, 9, 9, 3, 3, 3, 9, 13, 2, 1, 3, 3, 3, 9, 10, 2]

GROUP_BEGIN = [0, 38, 45, 55, 68, 76, 86, 111, 140, 149, 163, 171, 178, 185, 192, 200, 210, 217, 252, 279, 306]
GROUP_PARENT_LAST = [-1, 36, 36, 36, 36, 36, 36, 109, 109, 109, 109, 109, 109, 109, 109, 109, 109, 36, 250, 250, 36]
TYPE_RANGE_BEGIN = [38, 45, 55, 68, 76, 86, 111, 86, 140, 86, 149, 86, 163, 86, 171, 86, 178, 86, 185, 86, 192, 86, 200, 86, 210, 217, 252, 217, 279, 306]
TYPE_RANGE_END = [44, 54, 67, 75, 85, 110, 139, 110, 148, 110, 162, 110, 170, 110, 177, 110, 184, 110, 191, 110, 199, 110, 209, 110, 216, 251, 278, 251, 305, 312]
TYPE_RANGE_OFFSET = [0, 1, 2, 3, 4, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 30]
TYPE_LAST_FIELD = [43, 53, 66, 74, 84, 138, 147, 161, 169, 176, 183, 190, 198, 208, 215, 277, 304, 311]

FIELD_NAMES = {
    1: "F_CURRENT_AID",
    2: "F_LOCATION",
    3: "F_OFFSET_X",
    4: "F_OFFSET_Y",
    19: "F_FLAGS",
    22: "F_NAME",
    23: "F_DESCRIPTION",
    27: "F_HP_PTS",
    29: "F_HP_DAMAGE",
    30: "F_MATERIAL",
    31: "F_RESISTANCE",
    32: "F_SCRIPTS",
    33: "F_SOUND_EFFECT",14: 'F_LIGHT_AID', 15: 'F_LIGHT_COLOR', 69: 'F_SCENERY_FLAGS', 3: 'F_OFFSET_X', 4: 'F_OFFSET_Y', 19: 'F_FLAGS', 29: 'F_HP_DAMAGE', 23: 'F_DESCRIPTION', 32: 'F_SCRIPTS', 88: 'F_ITEM_PARENT', 89: 'F_ITEM_WEIGHT', 91: 'F_ITEM_WORTH', 97: 'F_ITEM_DISCIPLINE', 100: 'F_ITEM_SPELL_1', 105: 'F_ITEM_SPELL_MANA_STORE', 93: 'F_ITEM_INV_AID', 94: 'F_ITEM_INV_LOCATION', 295: 'F_NPC_REACTION_BASE', 293: 'F_NPC_RETAIL_PRICE_MULTIPLIER', 294: 'F_NPC_SUBSTITUTE_INVENTORY', 280: 'F_NPC_FLAGS', 282: 'F_NPC_AI_DATA', 296: 'F_NPC_SOCIAL_CLASS', 291: 'F_NPC_ORIGIN', 285: 'F_NPC_EXPERIENCE_WORTH', 22: 'F_NAME', 30: 'F_MATERIAL', 33: 'F_SOUND_EFFECT', 96: 'F_ITEM_MAGIC_TECH_COMPLEXITY', 152: 'F_ARMOR_AC_ADJ', 220: 'F_CRITTER_STAT_BASE', 31: 'F_RESISTANCE', 154: 'F_ARMOR_RESISTANCE_ADJ', 221: 'F_CRITTER_BASIC_SKILL', 223: 'F_CRITTER_SPELL_TECH', 222: 'F_CRITTER_TECH_SKILL', 112: 'F_WEAPON_FLAGS', 114: 'F_WEAPON_BONUS_TO_HIT', 116: 'F_WEAPON_DAMAGE_LOWER', 117: 'F_WEAPON_DAMAGE_UPPER', 119: 'F_WEAPON_SPEED_FACTOR', 121: 'F_WEAPON_RANGE', 123: 'F_WEAPON_MIN_STRENGTH', 125: 'F_WEAPON_AMMO_TYPE', 126: 'F_WEAPON_AMMO_CONSUMPTION', 142: 'F_AMMO_QUANTITY', 143: 'F_AMMO_TYPE', 127: 'F_WEAPON_MISSILE_AID', 27: 'F_HP_PTS', 46: 'F_PORTAL_FLAGS', 47: 'F_PORTAL_LOCK_DIFFICULTY', 48: 'F_PORTAL_KEY_ID', 56: 'F_CONTAINER_FLAGS', 57: 'F_CONTAINER_LOCK_DIFFICULTY', 58: 'F_CONTAINER_KEY_ID', 87: 'F_ITEM_FLAGS', 165: 'F_GOLD_QUANTITY', 186: 'F_KEY_KEY_ID', 202: 'F_WRITTEN_SUBTYPE', 203: 'F_WRITTEN_TEXT_START_LINE', 204: 'F_WRITTEN_TEXT_END_LINE', 218: 'F_CRITTER_FLAGS', 219: 'F_CRITTER_FLAGS2', 231: 'F_CRITTER_PORTRAIT', 292: 'F_NPC_FACTION'}

SCRIPT_POINTS = {0: 'SAP_EXAMINE', 1: 'SAP_USE', 9: 'SAP_DIALOG', 10: 'SAP_FIRST_HEARTBEAT', 17: 'SAP_BUY_OBJECT', 22: 'SAP_WILL_KOS', 19: 'SAP_HEARTBEAT', 31: 'SAP_DIALOG_OVERRIDE'}

# ObjectType names from arcanum-ce obj.h / data-formats.md.
OBJECT_TYPE_NAMES = {
    0: 'WALL',
    1: 'PORTAL',
    2: 'CONTAINER',
    3: 'SCENERY',
    4: 'PROJECTILE',
    5: 'WEAPON',
    6: 'AMMO',
    7: 'ARMOR',
    8: 'GOLD (money)',
    9: 'FOOD',
    10: 'SCROLL',
    11: 'KEY',
    12: 'KEY_RING',
    13: 'WRITTEN',
    14: 'GENERIC (item)',
    15: 'PC',
    16: 'NPC',
    17: 'TRAP',
    18: 'MONSTER',
    19: 'UNIQUE_NPC',
}

def object_type_name(obj_type):
    return OBJECT_TYPE_NAMES.get(obj_type, 'UNKNOWN')

def u8(b, o):
    return b[o]

def i32(b, o):
    return struct.unpack_from("<i", b, o)[0]

def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]

def i64(b, o):
    return struct.unpack_from("<q", b, o)[0]

def u64(b, o):
    return struct.unpack_from("<Q", b, o)[0]

def hex_bytes(data):
    return " ".join(f"{x:02X}" for x in data)

def oid_text(data):
    if len(data) != 24:
        return hex_bytes(data)
    oid_type = u32(data, 0)
    number = u32(data, 8)
    if oid_type == 1:
        return f"A / number={number} / raw={hex_bytes(data)}"
    if oid_type == 2:
        guid = data[8:24].hex()
        return f"GUID / {guid} / raw={hex_bytes(data)}"
    return f"type={oid_type} / raw={hex_bytes(data)}"

def group_start(fld):
    start = 0
    for x in GROUP_BEGIN:
        if x < fld:
            start = x
        else:
            break
    return start

def group_index(begin_value):
    for i, x in enumerate(GROUP_BEGIN):
        if x == begin_value:
            return i
    return 0

def build_engine():
    n = len(OD_TYPES)
    change_idx = [-1] * n
    masks = [0] * n
    base_dword = [0] * len(GROUP_BEGIN)

    for fld in range(n):
        od = OD_TYPES[fld]
        if od == 1:  # Begin
            gi = group_index(fld)
            parent_last = GROUP_PARENT_LAST[gi]
            base_dword[gi] = 0 if parent_last < 0 else change_idx[parent_last] + 1
            continue

        if od == 2:  # End
            continue

        gs = group_start(fld)
        local_idx = fld - gs - 1
        gi = group_index(gs)
        change_idx[fld] = local_idx // 32 + base_dword[gi]
        masks[fld] = 1 << (local_idx % 32)

    dword_count = []
    for typ in range(18):
        last = TYPE_LAST_FIELD[typ] if typ < len(TYPE_LAST_FIELD) else -1
        dword_count.append(change_idx[last] + 1 if last >= 0 else 0)

    return change_idx, masks, dword_count

CHANGE_IDX, MASKS, DWORD_COUNT = build_engine()

def enumerate_fields(obj_type):
    # Common fields.
    for f in range(1, 37):
        if OD_TYPES[f] not in (1, 2):
            yield f

    # Type-specific ranges.
    start = TYPE_RANGE_OFFSET[obj_type]
    end = TYPE_RANGE_OFFSET[obj_type + 1]
    for r in range(start, end):
        for f in range(TYPE_RANGE_BEGIN[r] + 1, TYPE_RANGE_END[r]):
            if OD_TYPES[f] not in (1, 2):
                yield f

def bit_is_set(field48, fld):
    ci = CHANGE_IDX[fld]
    return ci >= 0 and ci < len(field48) and (field48[ci] & MASKS[fld]) != 0

def array_value(od, raw, elem_size):
    """Decode one compact array element as far as the field type allows."""
    if od == 7 and elem_size == 4:
        return i32(raw, 0)
    if od == 9 and elem_size == 4:
        return u32(raw, 0)
    if od == 8 and elem_size == 8:
        return i64(raw, 0)
    if od == 10 and elem_size == 8:
        return u64(raw, 0)
    if od == 11 and elem_size == 12:
        a, b, c = struct.unpack_from("<III", raw, 0)
        return {
            "script_record": f"{a}, {b}, {c}",
            "script_num": c,
        }
    if od == 13 and elem_size == 24:
        return oid_text(raw)
    return "0x" + raw.hex()

def read_array(data, o, od):
    start = o
    present = data[o]
    o += 1
    if not present:
        return {
            "value": "absent",
            "size": 1,
            "raw": data[start:o],
        }

    if o + 12 > len(data):
        raise ValueError("truncated array header")

    elem_size = i32(data, o)
    count = i32(data, o + 4)
    bitset_id = i32(data, o + 8)
    o += 12

    if elem_size < 0 or count < 0:
        raise ValueError(f"invalid array header size={elem_size} count={count}")

    data_bytes = elem_size * count
    if o + data_bytes + 4 > len(data):
        raise ValueError("truncated array payload")

    payload = data[o:o + data_bytes]
    o += data_bytes

    bitset_count = i32(data, o)
    o += 4
    if bitset_count < 0 or o + bitset_count * 4 > len(data):
        raise ValueError("invalid array bitset")

    bits = [u32(data, o + i * 4) for i in range(bitset_count)]
    o += bitset_count * 4

    logical_indices = []
    for wi, word in enumerate(bits):
        w = word
        bit = 0
        while w:
            if w & 1:
                logical_indices.append(wi * 32 + bit)
            w >>= 1
            bit += 1

    elements = []
    for i in range(count):
        chunk = payload[i * elem_size:(i + 1) * elem_size]
        logical = logical_indices[i] if i < len(logical_indices) else f"compact_{i}"
        value = array_value(od, chunk, elem_size)
        if od == 11 and isinstance(value, dict):
            value["script_attachment"] = SCRIPT_POINTS.get(
                logical, f"SAP_{logical}"
            )
            value["script_attachment_index"] = logical
        elements.append({
            "index": logical,
            "value": value,
            "raw": hex_bytes(chunk),
        })

    return {
        "value": {
            "element_size": elem_size,
            "count": count,
            "bitset_id": bitset_id,
            "bitset": [f"0x{x:08X}" for x in bits],
            "elements": elements,
        },
        "size": o - start,
        "raw": data[start:o],
    }

def read_field(data, o, od):
    start = o

    if od == 3:  # Int32
        if o + 4 > len(data):
            raise ValueError("truncated Int32")
        value = i32(data, o)
        o += 4
        return value, o - start

    if od == 4:  # Int64 with presence byte
        present = data[o]
        o += 1
        if present:
            if o + 8 > len(data):
                raise ValueError("truncated Int64")
            value = i64(data, o)
            o += 8
        else:
            value = None
        return value, o - start

    if od == 5:  # String
        present = data[o]
        o += 1
        if not present:
            return None, o - start
        length = i32(data, o)
        o += 4
        if length < 0 or o + length + 1 > len(data):
            raise ValueError("invalid string length")
        raw = data[o:o + length]
        o += length
        trailing = data[o]
        o += 1
        try:
            value = raw.decode("cp1252")
        except UnicodeDecodeError:
            value = raw.decode("latin-1")
        return {
            "text": value,
            "length": length,
            "trailing_byte": trailing,
            "raw": hex_bytes(raw),
        }, o - start

    if od == 6:  # Handle
        present = data[o]
        o += 1
        if present:
            if o + 24 > len(data):
                raise ValueError("truncated handle")
            raw_oid = data[o:o + 24]
            o += 24
            value = oid_text(raw_oid)
        else:
            value = None
        return value, o - start

    if od in (7, 8, 9, 10, 11, 12, 13):
        result = read_array(data, o, od)
        return result["value"], result["size"]

    # Ptr / PtrArray are transient and should not normally occur in serialized .mob data.
    return f"unsupported/transient OdType={OD_NAMES.get(od, str(od))}", 0

def decode_mob(path):
    data = path.read_bytes()
    if len(data) < 58:
        raise ValueError("file too small for .mob header")

    version = i32(data, 0)
    if version != 119:
        raise ValueError(f"version={version}, expected 119")

    proto_oid = data[4:28]
    object_oid = data[28:52]
    obj_type = i32(data, 52)
    num_fields = struct.unpack_from("<H", data, 56)[0]

    if not (0 <= obj_type < 18):
        raise ValueError(f"invalid object type {obj_type}")

    ndw = DWORD_COUNT[obj_type]
    bitmap_start = 58
    bitmap_end = bitmap_start + ndw * 4
    if bitmap_end > len(data):
        raise ValueError("truncated field bitmap")

    field48 = [u32(data, bitmap_start + i * 4) for i in range(ndw)]
    actual_set = sum(x.bit_count() for x in field48)

    fields = []
    o = bitmap_end

    for fld in enumerate_fields(obj_type):
        if not bit_is_set(field48, fld):
            continue

        od = OD_TYPES[fld]
        field_offset = o
        value, size = read_field(data, o, od)
        if size <= 0:
            raise ValueError(f"field {fld} has unsupported/non-serialized type {OD_NAMES.get(od, od)}")
        o += size

        fields.append({
            "field": fld,
            "name": FIELD_NAMES.get(fld, f"FIELD_{fld}"),
            "od": OD_NAMES.get(od, f"OdType_{od}"),
            "change_idx": CHANGE_IDX[fld],
            "bit": MASKS[fld].bit_length() - 1 if MASKS[fld] else -1,
            "offset": field_offset,
            "size": size,
            "raw": hex_bytes(data[field_offset:o]),
            "value": value,
        })

    return {
        "path": path,
        "size": len(data),
        "version": version,
        "proto_oid": proto_oid,
        "object_oid": object_oid,
        "obj_type": obj_type,
        "num_fields": num_fields,
        "actual_set_bits": actual_set,
        "field48": field48,
        "fields": fields,
        "end_offset": o,
        "trailing": data[o:],
    }

def flocation_coordinates(value):
    """Translate a packed Arcanum LOCATION into world and sector coordinates."""
    if value is None:
        return None

    # F_LOCATION stores X in the low 32 bits and Y in the high 32 bits.
    world_x = value & 0xFFFFFFFF
    world_y = (value >> 32) & 0xFFFFFFFF

    # A sector is 64x64 LOCATION units.
    sector_x = world_x >> 6
    sector_y = world_y >> 6
    tile_x = world_x & 0x3F
    tile_y = world_y & 0x3F

    return world_x, world_y, sector_x, sector_y, tile_x, tile_y


def format_flocation(d):
    for f in d["fields"]:
        if f["field"] == 2:  # F_LOCATION
            value = f["value"]
            coords = flocation_coordinates(value)
            if coords is None:
                return f'{d["path"].name}, , , , , , '
            world_x, world_y, sector_x, sector_y, tile_x, tile_y = coords
            return (
                f'{d["path"].name}, {value}, '
                f'{world_x}, {world_y}, '
                f'{sector_x}, {sector_y}, '
                f'{tile_x}, {tile_y}'
            )
    return f'{d["path"].name}, , , , , , , '



def mark_map_with_sectors(map_path, decoded_entries):
    """Create map_marked.bmp with one red pixel per unique sector.

    The source map is exactly 2000x2000. Sector X/Y are used directly
    as the BMP pixel X/Y coordinates, with no axis conversion.
    """
    try:
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError(
            "Map marking requires Pillow. Install it with: python -m pip install Pillow"
        ) from exc

    if not map_path.is_file():
        raise FileNotFoundError(f"Map file not found: {map_path}")

    image = Image.open(map_path)
    if image.size != (2000, 2000):
        raise ValueError(
            f"map.bmp must be exactly 2000x2000 pixels; "
            f"got {image.size[0]}x{image.size[1]}"
        )

    image = image.convert("RGB")
    pixels = image.load()
    marked = set()
    outside = 0

    for decoded in decoded_entries:
        for field in decoded["fields"]:
            if field["field"] != 2:  # F_LOCATION
                continue

            coords = flocation_coordinates(field["value"])
            if coords is None:
                break

            _, _, sector_x, sector_y, _, _ = coords

            # Use the game's sector coordinates directly as map pixel coordinates.
            map_x = sector_x
            map_y = sector_y

            if 0 <= map_x < 2000 and 0 <= map_y < 2000:
                pixels[map_x, map_y] = (255, 0, 0)
                marked.add((map_x, map_y))
            else:
                outside += 1
            break

    output = map_path.parent / "map_marked.bmp"
    image.save(output, format="BMP")
    return output, len(marked), outside

def format_value(value, indent="    "):
    if isinstance(value, dict):
        lines = []
        for k, v in value.items():
            if k == "elements":
                lines.append("elements:")
                for e in v:
                    lines.append(f"      [{e['index']}] {e['value']} | raw={e['raw']}")
            else:
                lines.append(f"{k}={v}")
        return "\n".join(indent + x for x in lines)
    if value is None:
        return "NULL / absent"
    return str(value)

def format_mob(d):
    lines = []
    lines.append("=" * 88)
    lines.append(f"FILE: {d['path'].name}")
    lines.append(f"SIZE: {d['size']} bytes")
    lines.append(f"VERSION: {d['version']}")
    lines.append(f"OBJECT TYPE: {object_type_name(d['obj_type'])} ({d['obj_type']})")
    lines.append(f"NUM_FIELDS: {d['num_fields']}")
    lines.append(f"SET BITS: {d['actual_set_bits']}")
    lines.append(f"BITMAP DWORDS: {len(d['field48'])}")
    lines.append("FIELD_48: " + " ".join(f"0x{x:08X}" for x in d["field48"]))
    lines.append(f"PROTOTYPE OID: {oid_text(d['proto_oid'])}")
    lines.append(f"OBJECT OID:    {oid_text(d['object_oid'])}")
    lines.append("")
    lines.append("OVERRIDDEN FIELDS")
    lines.append("-" * 88)

    for f in d["fields"]:
        lines.append(
            f"FIELD {f['field']:3d} | {f['name']:<36} | "
            f"{f['od']:<13} | change[{f['change_idx']}] bit {f['bit']:2d} | "
            f"offset 0x{f['offset']:04X} | size {f['size']}"
        )
        lines.append(f"  RAW:   {f['raw']}")
        lines.append("  VALUE:")
        lines.append(format_value(f["value"], "    "))

    lines.append("")
    lines.append(f"END OFFSET: 0x{d['end_offset']:04X} ({d['end_offset']})")
    if d["trailing"]:
        lines.append(f"TRAILING BYTES: {len(d['trailing'])}")
        lines.append("TRAILING RAW: " + hex_bytes(d["trailing"]))
    else:
        lines.append("TRAILING BYTES: 0")
    lines.append("")
    return "\n".join(lines)

def main():
    # .mob files are always taken from ./mob/ relative to this script.
    folder = Path(__file__).resolve().parent / "mob"
    output = folder / ("mob_flocation.txt" if "-flocation" in sys.argv[1:] else "mob_field_dump.txt")

    if not folder.is_dir():
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(f"Mob folder not found: {folder}\n", encoding="utf-8")
        print(f"Mob folder not found: {folder}")
        print(f"Expected .mob files in: {folder}")
        print(f"Wrote: {output}")
        return

    mob_files = sorted(
        (p for p in folder.glob("*") if p.is_file() and p.suffix.lower() == ".mob"),
        key=lambda p: p.name.lower()
    )

    flocation_only = "-flocation" in sys.argv[1:]

    if flocation_only:
        lines = ["Filename, F_LOCATION, World X, World Y, Sector X, Sector Y, Tile X, Tile Y"]
        decoded_entries = []

        for path in mob_files:
            try:
                decoded = decode_mob(path)
                decoded_entries.append(decoded)
                lines.append(format_flocation(decoded))
            except Exception as exc:
                lines.append(f"{path.name}, ERROR, ERROR, ERROR, ERROR, ERROR, ERROR, ERROR")
                print(f"Error decoding {path.name}: {type(exc).__name__}: {exc}")

        output.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"Scanned {len(mob_files)} .mob files.")
        print(f"Output: {output}")

        # Also mark every sector represented by an F_LOCATION on map.bmp.
        map_path = folder.parent / "map.bmp"
        try:
            map_output, marked, outside = mark_map_with_sectors(map_path, decoded_entries)
            print(f"Marked {marked} unique sectors on: {map_output}")
            if outside:
                print(f"Skipped {outside} objects outside the 0..1999 sector range.")
        except Exception as exc:
            print(f"Map marking failed: {type(exc).__name__}: {exc}")
            print(f"Expected map: {map_path}")

        return

    if not mob_files:
        output.write_text(
            f"No .mob files found in {folder}.\n",
            encoding="utf-8"
        )
        print(f"No .mob files found in: {folder}")
        print(f"Wrote: {output}")
        return

    chunks = []
    ok = 0
    failed = 0

    for path in mob_files:
        try:
            decoded = decode_mob(path)
            chunks.append(format_mob(decoded))
            ok += 1
        except Exception as exc:
            failed += 1
            chunks.append(
                "=" * 88 + "\n"
                f"FILE: {path.name}\n"
                f"ERROR: {type(exc).__name__}: {exc}\n"
            )

    header = [
        "ARCANUM .MOB FIELD DUMP",
        f"Folder: {folder}",
        f"Files scanned: {len(mob_files)}",
        f"Decoded successfully: {ok}",
        f"Failed: {failed}",
        "",
        "This dump lists every field whose field_48 bitmap bit is set.",
        "Offsets are file offsets in hexadecimal and decimal.",
        "",
    ]

    output.write_text("\n".join(header) + "\n".join(chunks), encoding="utf-8")
    print(f"Scanned {len(mob_files)} .mob files.")
    print(f"Decoded: {ok}   Failed: {failed}")
    print(f"Output: {output}")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        folder = Path(__file__).resolve().parent
        output = folder / "mob_field_dump.txt"
        error = (
            "FATAL ERROR\\n"
            f"{type(exc).__name__}: {exc}\\n"
        )
        try:
            output.write_text(error, encoding="utf-8")
            print(error)
            print(f"Error details written to: {output}")
        except Exception:
            print(error)
        input("\\nPress Enter to close...")
