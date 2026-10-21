#!/usr/bin/env python3
"""
Extract effective F_CURRENT_AID values from every .mob below ./data/maps/.

Important:
.MOB instances can contain an overridden F_CURRENT_AID, but they can also
leave that field unset (or contain a placeholder such as 0x00403000).
In that case the game resolves F_CURRENT_AID from the .MOB's prototype.

This script therefore:
  1. Reads F_CURRENT_AID from the .MOB when present.
  2. Reads the prototype number from the .MOB's prototype OID.
  3. Finds the corresponding .pro below ./data/proto/.
  4. Reads the prototype's F_CURRENT_AID.
  5. Uses the prototype value when the MOB value is not a recognizable art ID.
  6. Decodes critter IDs into strings such as "Human male".

Run this from the directory containing the ./data/ folder.
"""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import csv
import struct
import sys

# Paths are found from this file (toolbox/ sits one level below the project root), not from the current folder.
TOOLBOX = Path(__file__).resolve().parent
PROJECT = TOOLBOX.parent
MAPS_ROOT = PROJECT / "data" / "maps"
PROTO_ROOT = PROJECT / "data" / "proto"
DESCRIPTION_MES = PROJECT / "data" / "mes" / "description.mes"
GAME_DESCRIPTION_MES = PROJECT / "data" / "mes" / "gamedesc.mes"
OUTPUT = TOOLBOX / "extract.xlsx"
OUTPUT_CSV = TOOLBOX / "extract.csv"   # only written with --csv

# Arcanum object types 0..17, matching MOB_TYPE_LAST_FIELD in js/mob/mob-schema.js.
OBJECT_TYPES = [
    "Wall",       # 0
    "Portal",     # 1
    "Container",  # 2
    "Scenery",    # 3
    "Projectile", # 4
    "Weapon",     # 5
    "Ammo",       # 6
    "Armor",      # 7
    "Gold",       # 8
    "Food",       # 9
    "Scroll",     # 10
    "Key",        # 11
    "Key Ring",   # 12
    "Written",    # 13
    "Generic",    # 14
    "PC",         # 15
    "NPC",        # 16
    "Trap",       # 17
]

# Dwords of the field bitmap of a .mob, per object type (MOB_ENGINE.dwordCount in mob-decoder.js).
MOB_BITMAP_DWORDS = [
    3, 3, 3, 3, 3, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 5, 5, 3,
]
# A .pro has its own, longer bitmap.
BITMAP_DWORDS = [
    2, 2, 3, 3, 3, 5, 5, 6, 6, 6,
    6, 6, 7, 7, 7, 9, 10, 10,
]

# Serialized type of each common field 1..23 (MOB_OD_TYPES in mob-schema.js): 3 Int32, 4 Int64, 9 UInt32 array.
COMMON_FIELD_TYPES = {
    1: 3, 2: 4, 3: 3, 4: 3, 5: 3, 6: 9, 7: 9, 8: 9, 9: 3, 10: 3, 11: 3, 12: 3, 13: 3, 14: 3, 15: 3,
    16: 9, 17: 9, 18: 9, 19: 3, 20: 3, 21: 3, 22: 3, 23: 3,
}

def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0], offset + 4


def i32(data, offset):
    return struct.unpack_from("<i", data, offset)[0], offset + 4


def i16(data, offset):
    return struct.unpack_from("<h", data, offset)[0], offset + 2


def prototype_number_from_oid(proto_oid):
    """
    mobOidTypeAndNumber() in js/proto/proto-resolution.js:
      OID_TYPE_A = type 1
      prototype number = union dword at offset +8
    """
    if len(proto_oid) != 24:
        return None

    oid_type = struct.unpack_from("<h", proto_oid, 0)[0]
    if oid_type != 1:
        return None

    return struct.unpack_from("<I", proto_oid, 8)[0]


FIELD_CRITTER_STAT_BASE = 220   # F_CRITTER_STAT_BASE_IDX: Int32Array of the basic stats
STAT_RACE = 27                  # stat.h
FIELD_CRITTER_FLAGS = 218       # F_CRITTER_FLAGS
OCF_UNDEAD = 0x4                # obj_flags.h
OCF_ANIMAL = 0x8
RACE_NAMES = [
    "Human", "Dwarf", "Elf", "Half Elf", "Gnome", "Halfling",
    "Half Orc", "Half Ogre", "Dark Elf", "Ogre", "Orc",
]


# What a critter is, from the art it is drawn with. The code tables are MONSTER_CODES / UNIQUE_NPC_CODES of
# js/proto/critter-aid.js (art type 0xC: number in bits 23-27; type 0xD: bits 20-27). The groups were set
# by looking at what each art shows. A unique-NPC art that is not listed is a person (their race stat is used).
MONSTER_CODES = [
    "wlf", "spd", "ocm", "ert", "ld1", "ls1", "lz1", "lm1", "gd1", "bun", "msp", "aut", "liz", "pha", "rat", "sna",
    "ape", "ber", "chk", "cug", "shp", "tgr", "pig", "cow", "wow", "mpg", "FIR", "WAT", "AIR", "dkn", "spq", "wwf",
]
UNIQUE_NPC_CODES = [
    "hmmbs", "hmmtn", "hmmvg", "ghmvg", "hmmki", "ghmst", "hmmgb", "effvg", "efmvg", "ghmv2", "ghfvg", "hmfvg",
    "dfmvg", "effsl", "efmax", "hmmpn", "ghfcd", "hmfc2", "hopuw", "ayauw", "dgnuw", "gwtuw", "hlbuw", "kituw",
    "krguw", "lycuw", "snwuw", "kergn", "Kr1uw", "Kr2uw", "Kr3uw", "SHMuw", "GLMuw", "FM1uw", "PH1uw", "PH2uw",
    "PH3uw", "SWGuw", "nakuw", "VORuw",
]
CREATURE_GROUPS = {
    # animals
    "wlf": "Animal", "spd": "Animal", "bun": "Animal", "rat": "Animal", "ape": "Animal",
    "ber": "Animal", "chk": "Animal", "cug": "Animal", "shp": "Animal", "tgr": "Animal", "pig": "Animal",
    "cow": "Animal", "mpg": "Animal", "gwtuw": "Animal", "hlbuw": "Animal", "snwuw": "Animal",
    # undead
    "ls1": "Undead", "lz1": "Undead", "lm1": "Undead", "pha": "Undead", "dkn": "Undead", "lycuw": "Undead",
    "kergn": "Undead", "GLMuw": "Undead", "PH1uw": "Undead", "PH2uw": "Undead", "PH3uw": "Undead",
    # tribes with a type of their own
    "kituw": "Kite", "krguw": "Krag",
    # the rest of the creatures
    "ocm": "Monster", "ert": "Monster", "ld1": "Monster", "gd1": "Monster", "msp": "Monster", "aut": "Monster",
    "liz": "Monster", "sna": "Monster", "wow": "Monster", "FIR": "Monster", "WAT": "Monster", "AIR": "Monster", "spq": "Monster",
    "wwf": "Monster", "ayauw": "Monster", "dgnuw": "Monster", "Kr1uw": "Monster", "Kr2uw": "Monster",
    "Kr3uw": "Monster", "SHMuw": "Monster", "SWGuw": "Monster", "VORuw": "Monster",
}


UNIQUE_BODY_RACES = {"hmm": "Human", "hmf": "Human", "ghm": "Halfling", "ghf": "Halfling",
                     "efm": "Elf", "eff": "Elf", "dfm": "Dwarf"}


def art_race(art):
    """
    The race an NPC is drawn as: the body of a critter art id, or the folder of a unique NPC art (dfmvg = dwarf
    male). Placed NPCs often leave the race stat at its default (Human), so the art is the more reliable of the two.
    """
    kind = art >> 28
    if kind == 0x2:
        body = (art >> 24) & 0x7
        return ("Human", "Dwarf", "Halfling", "Half Ogre", "Elf")[body] if body < 5 else None
    if kind == 0xD:
        num = (art >> 20) & 0xFF
        return UNIQUE_BODY_RACES.get(UNIQUE_NPC_CODES[num][:3].lower()) if num < len(UNIQUE_NPC_CODES) else None
    return None


def creature_group(art):
    """Animal / Undead / Kite / Krag / Monster / Object for a critter art id, None for a person."""
    kind = art >> 28
    if kind == 0xC:
        code = MONSTER_CODES[(art >> 23) & 0x1F]
    elif kind == 0xD:
        num = (art >> 20) & 0xFF
        code = UNIQUE_NPC_CODES[num] if num < len(UNIQUE_NPC_CODES) else None
    elif kind == 0x4:
        return "Object"   # an "NPC" drawn as scenery: the rocks, the ship's wheel, the Pillar of Truth
    else:
        return None
    return CREATURE_GROUPS.get(code)


class Schema:
    """The field layout of the game's objects, read from js/mob/mob-schema.js so both tools agree."""

    def __init__(self):
        text = (PROJECT / "js" / "mob" / "mob-schema.js").read_text(encoding="utf-8")

        def table(name):
            body = re.search(r"export const %s = \[([^\]]*)\]" % name, text).group(1)
            return [int(x) for x in body.split(",") if x.strip()]

        self.od = table("MOB_OD_TYPES")
        self.group_begin = table("MOB_GROUP_BEGIN")
        self.group_parent_last = table("MOB_GROUP_PARENT_LAST")
        range_begin = table("MOB_TYPE_RANGE_BEGIN")
        range_end = table("MOB_TYPE_RANGE_END")
        range_offset = table("MOB_TYPE_RANGE_OFFSET")

        # buildMobEngine(): the bitmap dword and mask of every field.
        count = len(self.od)
        self.change_idx = [-1] * count
        self.mask = [0] * count
        base = [0] * len(self.group_begin)
        for fld in range(count):
            od = self.od[fld]
            if od == 1:
                gi = self.group_begin.index(fld)
                parent_last = self.group_parent_last[gi]
                base[gi] = 0 if parent_last < 0 else self.change_idx[parent_last] + 1
                continue
            if od == 2:
                continue
            gs = max(x for x in self.group_begin if x < fld)
            local = fld - gs - 1
            self.change_idx[fld] = local // 32 + base[self.group_begin.index(gs)]
            self.mask[fld] = 1 << (local % 32)

        # enumerateMobFields(): common fields, then the ranges of the object type.
        self.fields_by_type = []
        for obj_type in range(len(range_offset) - 1):
            fields = [f for f in range(1, 37) if self.od[f] not in (1, 2)]
            for r in range(range_offset[obj_type], range_offset[obj_type + 1]):
                fields += [f for f in range(range_begin[r] + 1, range_end[r]) if self.od[f] not in (1, 2)]
            self.fields_by_type.append(fields)


_schema = None


def schema():
    global _schema
    if _schema is None:
        _schema = Schema()
    return _schema


def read_field(data, offset, od):
    """One serialized field -> (value, next offset); only Int32 and the Int32 arrays give a value."""
    if od == 3:
        return i32(data, offset)
    present = data[offset]
    offset += 1
    if od == 4:
        return None, offset + (8 if present else 0)
    if od == 5:
        if present:
            length, offset = i32(data, offset)
            offset += length + 1
        return None, offset
    if od == 6:
        return None, offset + (24 if present else 0)
    if od == 14:
        return None, offset
    # arrays: element size, count, bitset id, elements, bitset count, bitset
    if not present:
        return None, offset
    elem_size, count = struct.unpack_from("<ii", data, offset)
    offset += 12
    elements = None
    if od == 7 and elem_size == 4:
        elements = list(struct.unpack_from("<%di" % count, data, offset))
    offset += elem_size * count
    bitset_count, offset = i32(data, offset)
    bits = struct.unpack_from("<%dI" % bitset_count, data, offset)
    offset += bitset_count * 4
    if elements is None:
        return None, offset
    logical = [w * 32 + b for w, word in enumerate(bits) for b in range(32) if word >> b & 1]
    return dict(zip(logical, elements)), offset


def walk_fields(data, offset, object_type, bitmap=None):
    """
    Int32 values and Int32 arrays of an object's fields, by field number. A .mob (bitmap given) holds only the
    fields whose bit is set; a .pro holds every field.
    """
    sch = schema()
    values = {}
    for fld in sch.fields_by_type[object_type]:
        if bitmap is not None and not (bitmap[sch.change_idx[fld]] & sch.mask[fld]):
            continue
        value, offset = read_field(data, offset, sch.od[fld])
        if value is not None:
            values[fld] = value
    return values


def race_of(values):
    """STAT_RACE out of a field dictionary, or None."""
    stats = values.get(FIELD_CRITTER_STAT_BASE)
    if not isinstance(stats, dict) or STAT_RACE not in stats:
        return None
    race = stats[STAT_RACE]
    return RACE_NAMES[race] if 0 <= race < len(RACE_NAMES) else None


def proto_fields(path):
    """The fields of a .pro (version 119: header, availability bitmap, every field)."""
    data = path.read_bytes()
    object_type = struct.unpack_from("<i", data, 52)[0]
    offset = 56 + MOB_BITMAP_DWORDS[object_type] * 4
    return walk_fields(data, offset, object_type)


_proto_values = {}


def proto_values(proto_number, proto_index):
    """The fields of a prototype by number, read once."""
    if proto_number not in _proto_values:
        path = proto_index.get(proto_number)
        try:
            _proto_values[proto_number] = proto_fields(path) if path else {}
        except Exception:
            _proto_values[proto_number] = {}
    return _proto_values[proto_number]


def read_or_error(path):
    """The bytes of a file, or the exception reading it raised (raised again where the file is parsed)."""
    try:
        return path.read_bytes()
    except Exception as exc:
        return exc


def parse_mob_header_and_aid(path, data=None):
    """
    Parse only what is needed from a .mob (its bytes `data`, when already read).

    Unlike .PRO, a .MOB serializes only fields whose bitmap bit is set.
    F_CURRENT_AID is field 1 and is the first serialized field when present.
    """
    if data is None:
        data = path.read_bytes()
    elif isinstance(data, Exception):
        raise data

    if len(data) < 62:
        raise ValueError("file is too small")

    offset = 0

    version, offset = u32(data, offset)

    proto_oid = data[offset:offset + 24]
    offset += 24

    offset += 24  # the object's own OID

    object_type, offset = i32(data, offset)
    num_fields, offset = i16(data, offset)

    if object_type < 0 or object_type >= len(MOB_BITMAP_DWORDS):
        raise ValueError(f"unsupported object type {object_type}")

    dword_count = MOB_BITMAP_DWORDS[object_type]

    if offset + dword_count * 4 > len(data):
        raise ValueError("truncated bitmap")

    bitmap = []
    for _ in range(dword_count):
        value, offset = u32(data, offset)
        bitmap.append(value)

    fields = walk_fields(data, offset, object_type, bitmap)

    # The common fields 1..23 come first, in order; field N is bit N-1 of the first bitmap dword.
    # Int32 is stored bare, Int64 and the UInt32 arrays behind a presence byte (see mob-decoder.js).
    current_aid = None
    description = None

    for field in range(1, 24):
        if not bitmap[0] & (1 << (field - 1)):
            continue
        od = COMMON_FIELD_TYPES[field]
        if od == 3:
            value, offset = i32(data, offset)
            if field == 1:
                current_aid = value & 0xFFFFFFFF
            elif field == 23:
                description = value
        elif od == 4:
            offset += 9 if data[offset] else 1
        else:  # UInt32 array: present, element size, count, bitset id, payload, bitset count, bitset
            present = data[offset]
            offset += 1
            if present:
                elem_size, count = struct.unpack_from("<ii", data, offset)
                offset += 12 + elem_size * count
                bitset_count, offset = i32(data, offset)
                offset += bitset_count * 4

    return {
        "fields": fields,
        "description": description,
        "version": version,
        "proto_oid": proto_oid,
        "proto_number": prototype_number_from_oid(proto_oid),
        "object_type": object_type,
        "num_fields": num_fields,
        "current_aid": current_aid,
    }


def load_description_mes():
    """Load prototype names and optional //gender annotations."""
    result = {}

    pattern = re.compile(
        r"\{([+-]?\d+)\}\{([^}]*)\}(?:\s*//([^\r\n]*))?"
    )

    # Keys from 30000 up (special NPCs and items) are in the module's gamedesc.mes, like the game does.
    for path, first_key in ((DESCRIPTION_MES, None), (GAME_DESCRIPTION_MES, 30000)):
        if not path.exists():
            continue
        text = path.read_text(encoding="cp1252", errors="replace")
        for match in pattern.finditer(text):
            key = int(match.group(1))
            if first_key is not None and key < first_key:
                continue
            result[key] = {
                "name": match.group(2).strip(),
                "gender": (match.group(3) or "").strip(),
            }

    return result



RACES = (
    "Half Ogre", "Half Orc", "Half Elf", "Dark Elf",
    "Halfling", "Human", "Dwarf", "Gnome", "Ogre", "Orc", "Elf",
)


def split_race_type(name):
    """'Half Orc Beggar' -> ('Half Orc', 'Beggar'); names without a race -> ('', name)."""
    for race in RACES:
        if name == race:
            return race, ""
        if name.startswith(race + " "):
            return race, name[len(race) + 1:].strip()
    return "", name


def build_proto_index():
    """
    js/proto/proto-resolution.js maps:
      "<number> - Name.pro" -> prototype number

    We reproduce that by scanning ./data/proto recursively.
    """
    index = {}

    if not PROTO_ROOT.exists():
        return index

    for path in PROTO_ROOT.rglob("*.pro"):
        match = re.match(r"^(\d+)\s*-\s*", path.name)
        if not match:
            continue

        number = int(match.group(1))

        if number not in index:
            index[number] = path

    return index


def xlsx_column(index):
    """0 -> A, 25 -> Z, 26 -> AA."""
    name = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        name = chr(65 + rest) + name
    return name


def write_xlsx(path, header, table):
    """
    A one-sheet .xlsx written by hand (no extra package needed): bold header row, frozen, with the
    filter buttons already on, and column widths that fit the text. Numbers stay numbers.
    """
    from xml.sax.saxutils import escape
    import zipfile

    def text(value):
        return escape(re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value)))

    def cell(col, row, value, style=0):
        ref = f"{xlsx_column(col)}{row}"
        if isinstance(value, int) and not isinstance(value, bool):
            return f'<c r="{ref}"><v>{value}</v></c>'
        if value == "":
            return ""
        return f'<c r="{ref}" t="inlineStr" s="{style}"><is><t xml:space="preserve">{text(value)}</t></is></c>'

    widths = [len(h) for h in header]
    for row in table:
        for col, value in enumerate(row):
            widths[col] = max(widths[col], len(str(value)))

    last = f"{xlsx_column(len(header) - 1)}{len(table) + 1}"
    sheet = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
        "<cols>" + "".join(
            f'<col min="{i + 1}" max="{i + 1}" width="{min(max(w + 2, 8), 60)}" customWidth="1"/>'
            for i, w in enumerate(widths)
        ) + "</cols>",
        "<sheetData>",
        '<row r="1">' + "".join(cell(c, 1, h, 1) for c, h in enumerate(header)) + "</row>",
    ]
    for r, row in enumerate(table, 2):
        sheet.append(f'<row r="{r}">' + "".join(cell(c, r, v) for c, v in enumerate(row)) + "</row>")
    sheet += ["</sheetData>", f'<autoFilter ref="A1:{last}"/>', "</worksheet>"]

    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Mobs" sheetId="1" r:id="rId1"/></sheets>'
            f'<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Mobs!$A$1:${xlsx_column(len(header) - 1)}${len(table) + 1}</definedName></definedNames>'
            "</workbook>"
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            "</Relationships>"
        ),
        "xl/styles.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
            "</styleSheet>"
        ),
        "xl/worksheets/sheet1.xml": "".join(sheet),
    }
    try:
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, content in files.items():
                zf.writestr(name, content)
    except PermissionError:
        raise SystemExit(f"ERROR: cannot write {path} - close it in Excel and run again.")


def main():
    if not MAPS_ROOT.exists():
        print(f"ERROR: {MAPS_ROOT} does not exist.")
        print("The data/ folder is expected next to toolbox/.")
        return

    print("Building prototype index...")
    proto_index = build_proto_index()
    print(f"Indexed {len(proto_index)} numbered .pro files.")

    print("Loading description.mes...")
    description_map = load_description_mes()
    print(f"Loaded {len(description_map)} prototype descriptions.")

    mob_files = sorted(
        MAPS_ROOT.rglob("*.mob"),
        key=lambda p: str(p).lower()
    )

    print(f"Found {len(mob_files)} .mob files.")

    # Read by a few threads, in order, while the files are parsed one by one (on Windows opening a file is the slow part).
    pool = ThreadPoolExecutor(16)
    mob_data = pool.map(read_or_error, mob_files)

    rows = []
    unique_rows = set()   # rows named by the object's own F_DESCRIPTION
    race_type = {}        # row -> (race, type)

    for n, (path, data) in enumerate(zip(mob_files, mob_data), 1):
        relative = path.relative_to(MAPS_ROOT)

        try:
            mob = parse_mob_header_and_aid(path, data)

            object_type = mob["object_type"]
            type_name = OBJECT_TYPES[object_type]
            proto_number = mob["proto_number"]

            if proto_number is not None:
                # The prototype number stored in the MOB is 20 higher than
                # the corresponding key in description.mes.
                description_number = proto_number - 20
                description = description_map.get(description_number)

                # The object's own F_DESCRIPTION (special NPCs: "Gilbert Bates") wins over the prototype's
                # generic name; it only counts when it is a name of its own (not just the prototype's again).
                own = description_map.get(mob["description"]) if mob["description"] is not None else None
                if own is not None and (description is None or own["name"] != description["name"]):
                    proto_name = description["name"] if description else ""
                    description = {
                        "name": own["name"],
                        "gender": own["gender"] or (description["gender"] if description else ""),
                    }
                    unique_rows.add(len(rows))
                else:
                    proto_name = ""

                # Race and type: from the name when it starts with a race ("Half Orc Beggar"); a named NPC
                # keeps the ones of its prototype, and a critter without either has its race stat.
                name = description["name"] if description else ""
                if len(rows) in unique_rows:
                    race, kind = split_race_type(proto_name)
                    if not race:
                        kind = ""
                    race = ""   # a named NPC is drawn as what it is: the art / race stat below decides
                elif name:
                    race, kind = split_race_type(name)
                else:
                    race, kind = "", ""
                if not race and object_type in (15, 16):
                    values = dict(proto_values(proto_number, proto_index))
                    values.update(mob["fields"])
                    # Creatures have no race (the stat is just its default, Human): they get a group from the
                    # art they are drawn with. The critter flags tell an undead or animal person from the rest.
                    art = values.get(1)
                    if art is not None:
                        art &= 0xFFFFFFFF
                        flags = values.get(FIELD_CRITTER_FLAGS, 0) & 0xFFFFFFFF
                        group = creature_group(art)
                        if group is None and (art >> 28) in (0xC, 0xD):
                            group = None if (art >> 28) == 0xD else "Monster"
                        if flags & OCF_UNDEAD and group is None:
                            group = "Undead"
                        elif flags & OCF_ANIMAL and group is None:
                            group = "Animal"
                        # The stat only says more than the art when it is not the default Human (a gnome is
                        # drawn with halfling art, a half-orc with human art...).
                        stat = race_of(values)
                        race = group or (stat if stat != "Human" else None) or art_race(art) or stat or ""
                race_type[len(rows)] = (race, kind)

                if description is not None:
                    rows.append([
                        str(relative),
                        type_name,
                        object_type,
                        proto_number,
                        description["name"],
                        description["gender"],
                    ])
                else:
                    rows.append([
                        str(relative),
                        type_name,
                        object_type,
                        proto_number,
                        "[description not found]",
                        "",
                    ])
            else:
                rows.append([
                    str(relative),
                    type_name,
                    object_type,
                    "",
                    "[prototype number not found]",
                    "",
                ])

        except Exception as exc:
            rows.append([
                str(relative),
                "",
                "",
                "",
                f"[ERROR: {exc}]",
                "",
            ])

        if n % 100 == 0:
            print(f"Processed {n}/{len(mob_files)}...")
    pool.shutdown()

    header = ["Folder", "File", "Object type", "Type ID", "Proto", "Name", "Race", "Type", "Gender"]
    table = []
    for index, row in enumerate(rows):
        race, kind = race_type.get(index, ("", ""))
        rel = Path(row[0])
        folder = "" if str(rel.parent) == "." else str(rel.parent)
        table.append([folder, rel.name] + row[1:5] + [race, kind] + row[5:])

    write_xlsx(OUTPUT, header, table)
    outputs = [OUTPUT]
    if "--csv" in sys.argv:
        with OUTPUT_CSV.open("w", newline="", encoding="utf-8-sig") as csv_file:
            writer = csv.writer(csv_file)
            writer.writerow(header)
            writer.writerows(table)
        outputs.append(OUTPUT_CSV)

    print()
    print("Done.")
    print(f"Processed: {len(mob_files)} files")
    for path in outputs:
        print(f"Output:    {path}")


if __name__ == "__main__":
    main()
