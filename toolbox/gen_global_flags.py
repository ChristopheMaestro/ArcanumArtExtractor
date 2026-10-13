#!/usr/bin/env python3
"""
Generates data/scr/global_flags.json: who sets, clears and tests every global flag.

The game has no names for its global flags (script.c keeps 3200 bare bits), so the
.scr viewer explains a flag by where it is used instead:

    scripts      condition "global flag", actions "set/clear global flag", and any
                 operand whose value type is "gl flag"            (data/scr/*.scr)
    dialogues    "gfN V" in a line's test or result field          (data/dlg/*.dlg)
    encounters   "GlobalFlag: N" in the random encounter tables    (data/Rules/WMap_Rnd.mes)
    pregens      the flag set when a pregenerated character is picked (data/mes/MainMenu.mes 551+)

Reading every .scr and .dlg in the browser would mean thousands of requests, so the
index is built once here:

    python toolbox/gen_global_flags.py

Run it again after changing scripts or dialogues.
"""

import json
import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SCHEMA = ROOT / "js" / "scr" / "scr-schema.js"
OUT = DATA / "scr" / "global_flags.json"

HEADER_SIZE, ENTRY_SIZE, ACTION_SIZE = 0x40, 0x84, 0x2C
VT_NUMBER, VT_GL_FLAG = 3, 4          # ScriptValueType (SCR_VALUE_TYPES in scr-schema.js)
COND_GLOBAL_FLAG = 43
ACT_ASSIGN, ACT_SET, ACT_CLEAR = 10, 100, 101
TEXT_MAX = 110


def schema_table(src, name):
    m = re.search(r"export const %s = (\{.*?\});\n" % name, src)
    if not m:
        raise SystemExit(f"{name} not found in {SCHEMA}")
    return {int(k): v for k, v in json.loads(m.group(1)).items()}


def short(text):
    text = " ".join(text.split())
    return text if len(text) <= TEXT_MAX else text[:TEXT_MAX - 1] + "…"


def read_stmt(buf, o):
    kind = struct.unpack_from("<i", buf, o)[0]
    return kind, list(buf[o + 4:o + 12]), list(struct.unpack_from("<8i", buf, o + 12))


class Index:
    def __init__(self):
        self.flags = {}
        self.scripts = {}  # .scr file name -> its description, for the files listed

    def flag(self, n):
        return self.flags.setdefault(n, {})

    def add(self, n, key, item):
        if 0 <= n < 3200 and item not in self.flag(n).setdefault(key, []):
            self.flag(n)[key].append(item)


def scan_scripts(index, conds, acts):
    for path in sorted((DATA / "scr").glob("*.scr")):
        buf = path.read_bytes()
        if len(buf) < HEADER_SIZE:
            continue
        count = min(struct.unpack_from("<i", buf, 0x34)[0], (len(buf) - HEADER_SIZE) // ENTRY_SIZE)
        for line in range(max(count, 0)):
            o = HEADER_SIZE + line * ENTRY_SIZE
            cond = read_stmt(buf, o)
            stmts = [(cond, conds), (read_stmt(buf, o + ACTION_SIZE), acts)]
            if cond[0] != 0:  # an always-true line never takes its else branch
                stmts.append((read_stmt(buf, o + 2 * ACTION_SIZE), acts))
            for (kind, op_type, op_value), table in stmts:
                d = table.get(kind)
                if not d:
                    continue
                used = False
                for i, op in enumerate(d["ops"]):
                    if op_type[i] == VT_GL_FLAG and op in ("val", "dst"):
                        role = "read"
                        if op == "dst":
                            # "assign num" of a constant is a plain set / clear.
                            constant = kind == ACT_ASSIGN and op_type[1] == VT_NUMBER
                            role = ("set" if op_value[1] else "clear") if constant else "write"
                        index.add(op_value[i], "scr", [path.name, line, role])
                        used = True
                # The flag number itself is the operand (a variable there is resolved at run time).
                roles = {COND_GLOBAL_FLAG: "test"} if table is conds else {ACT_SET: "set", ACT_CLEAR: "clear"}
                if kind in roles and op_type[0] == VT_NUMBER:
                    index.add(op_value[0], "scr", [path.name, line, roles[kind]])
                    used = True
                if used:
                    index.scripts[path.name] = scr_description(buf)


def scr_description(buf):
    end = buf.find(b"\0", 8, 48)
    return buf[8:end if end >= 0 else 48].decode("cp1252", "replace").strip()


def dlg_entries(text):
    """Same field reader as dlgParseFields() in js/text/dlg-explorer.js."""
    i, n = 0, len(text)

    def field():
        nonlocal i
        prev = ""
        while True:
            if i >= n:
                return None
            ch = text[i]; i += 1
            if ch == "{":
                break
            if ch == "/" and prev == "/":
                while i < n and text[i] != "\n":
                    i += 1
                prev = ""
                continue
            if ch != "}":
                prev = ch
        start = text.find("}", i)
        if start < 0:
            return None
        value, i = text[i:start], start + 1
        return value

    while True:
        fields = []
        for _ in range(7):
            v = field()
            if v is None:
                return
            fields.append(v)
        yield fields


GF = re.compile(r"(?<![a-z])gf\s*(\d+)\s+(-?\d+)", re.I)


def scan_dialogues(index):
    for path in sorted((DATA / "dlg").glob("*.dlg")):
        text = path.read_text(encoding="cp1252", errors="replace")
        # The dialogue is run by the script of the same name (script_name_build_dlg_name()).
        scr = path.with_name(path.stem + ".scr").name
        scr_path = DATA / "scr" / scr
        if GF.search(text) and scr_path.exists() and scr not in index.scripts:
            index.scripts[scr] = scr_description(scr_path.read_bytes())
        for num, line, _gender, iq, tests, _resp, results in dlg_entries(text):
            try:
                num = int(num)
            except ValueError:
                continue
            speaker = "pc" if iq.strip() not in ("", "0") else "npc"
            for field, role in ((tests, "test"), (results, "set")):
                for flag, value in GF.findall(field):
                    item = [path.name, num, role, int(value), speaker, short(line)]
                    # Male/female copies of a line: keep the first.
                    if not any(o[0] == item[0] and o[2:] == item[2:] for o in index.flags.get(int(flag), {}).get("dlg", [])):
                        index.add(int(flag), "dlg", item)


def scan_encounters(index):
    path = DATA / "Rules" / "WMap_Rnd.mes"
    if not path.exists():
        return
    for raw in path.read_text(encoding="cp1252", errors="replace").splitlines():
        m = re.match(r"\s*\{(\d+)\}\{([^}]*)\}(.*)", raw)
        if not m:
            continue
        g = re.search(r"GlobalFlag:\s*(\d+)", m.group(2))
        if g:
            note = m.group(3).strip().lstrip("/").strip()
            index.add(int(g.group(1)), "rnd", [int(m.group(1)), short(note)])


def scan_pregens(index):
    path = DATA / "mes" / "MainMenu.mes"
    if not path.exists():
        return
    for m in re.finditer(r"\{(5[5-9]\d)\}\{\s*(-?\d+)\s*\}", path.read_text(encoding="cp1252", errors="replace")):
        num, flag = int(m.group(1)), int(m.group(2))
        if num >= 551 and flag > 0:  # mainmenu_ui_pregen_char_execute()
            index.add(flag, "pregen", num - 550)


def main():
    src = SCHEMA.read_text(encoding="utf-8")
    index = Index()
    scan_scripts(index, schema_table(src, "SCR_CONDITIONS"), schema_table(src, "SCR_ACTIONS"))
    scan_dialogues(index)
    scan_encounters(index)
    scan_pregens(index)
    out = {"scripts": dict(sorted(index.scripts.items())), "flags": {str(k): index.flags[k] for k in sorted(index.flags)}}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(index.flags)} global flags -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
