#!/usr/bin/env python3
"""
Generates js/scr/scr-schema.js from the Arcanum CE sources.

The .scr viewer needs to know, for every condition / action type, which operand
slots are read as values, written as values, read as objects, and so on. The CE
source is regular enough to extract that mechanically from script.c, so the
table is generated instead of typed by hand:

    python toolbox/gen_scr_schema.py

It reads toolbox/Arcanum CE sources/game/script.{h,c}.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAME = ROOT / "toolbox" / "Arcanum CE sources" / "game"
OUT = ROOT / "js" / "scr" / "scr-schema.js"


def read(p):
    return p.read_text(encoding="utf-8", errors="replace")


def enum_members(src, enum_name):
    m = re.search(r"typedef enum %s \{(.*?)\}" % enum_name, src, re.S)
    if not m:
        raise SystemExit(f"enum {enum_name} not found")
    body = re.sub(r"//.*", "", m.group(1))
    return [re.sub(r"\s*=.*", "", x).strip() for x in body.split(",") if x.strip()]


def function_body(src, name):
    """Body of the first definition `... name(...) {` (brace matched)."""
    m = re.search(r"^\w[\w\s\*]*\b%s\([^;]*?\)\s*\{" % re.escape(name), src, re.M)
    if not m:
        return ""
    i = m.end()
    depth = 1
    while depth and i < len(src):
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    return src[m.end():i]


def split_cases(body, prefix):
    """{case_name: text} for `case PREFIX_*:` labels; stacked labels share a body."""
    pat = re.compile(r"case (%s_\w+):" % prefix)
    marks = [(m.group(1), m.start(), m.end()) for m in pat.finditer(body)]
    out = {}
    pending = []
    for idx, (name, _s, e) in enumerate(marks):
        end = marks[idx + 1][1] if idx + 1 < len(marks) else len(body)
        text = body[e:end]
        pending.append(name)
        if re.sub(r"\s", "", text):
            for p in pending:
                out[p] = text
            pending = []
    for p in pending:
        out[p] = ""
    return out


HELPERS = {}


def operand_kinds(text, owner, src):
    """-> (kinds list of up to 8 slots, helper-expanded)"""
    text = expand_helpers(text, owner, src)
    kinds = {}

    def mark(slot, kind):
        # a slot used both ways keeps the first (most specific) reading
        kinds.setdefault(int(slot), kind)

    for m in re.finditer(r"script_set_value\(\s*\w+->op_type\[(\d)\]", text):
        mark(m.group(1), "dst")
    for m in re.finditer(r"script_set_obj\(\s*\w+->op_type\[(\d)\]", text):
        mark(m.group(1), "objdst")
    for m in re.finditer(r"script_get_value\(\s*\w+->op_type\[(\d)\]", text):
        mark(m.group(1), "val")
    for m in re.finditer(r"(?:script_get_obj|script_resolve_focus_obj)\(\s*\w+->op_type\[(\d)\]", text):
        mark(m.group(1), "obj")
    for m in re.finditer(r"%s->op_value\[(\d)\]" % owner, text):
        kinds.setdefault(int(m.group(1)), "lit")
    # op_type[i] used some other way (e.g. stored as loop focus type)
    for m in re.finditer(r"%s->op_type\[(\d)\]" % owner, text):
        kinds.setdefault(int(m.group(1)), "obj")
    return kinds


def expand_helpers(text, owner, src):
    """Inline the body of helper functions that receive the action/condition."""
    extra = ""
    for m in re.finditer(r"\b(\w+)\(\s*(?:&\()?%s\b" % owner, text):
        fn = m.group(1)
        if fn in ("script_execute_action", "script_get_value", "script_get_obj"):
            continue
        body = function_body(src, fn)
        if body:
            extra += "\n" + body.replace("action->", "%s->" % owner)
    return text + extra


def comment_of(text):
    lines = []
    for ln in text.splitlines():
        s = ln.strip()
        if s.startswith("//"):
            lines.append(s[2:].strip())
        elif s == "" and not lines:
            continue
        else:
            break
    return " ".join(lines)


def pretty(name, prefix):
    return name[len(prefix) + 1:].lower().replace("_", " ")


def js(v):
    import json
    return json.dumps(v, ensure_ascii=False)


def main():
    h = read(GAME / "script.h")
    c = read(GAME / "script.c")
    cond_cases = split_cases(function_body(c, "script_execute_condition"), "SCT")
    act_cases = split_cases(function_body(c, "script_execute_action"), "SAT")

    sct = enum_members(h, "ScriptConditionType")
    sat = enum_members(h, "ScriptActionType")
    sap = enum_members(h, "ScriptAttachmentPoint")
    sfo = enum_members(h, "ScriptFocusObject")
    svt = enum_members(h, "ScriptValueType")
    flags = re.findall(r"#define (SF_\w+)\s+(0x[0-9A-Fa-f]+)u?", h)

    def table(names, cases, owner, prefix):
        out = {}
        for i, n in enumerate(names):
            text = cases.get(n, "")
            kinds = operand_kinds(text, owner, c)
            maxslot = max(kinds) + 1 if kinds else 0
            out[i] = {
                "name": pretty(n, prefix),
                "ops": [kinds.get(s, "") for s in range(maxslot)],
                "doc": comment_of(text),
            }
        return out

    lines = [
        "// GENERATED by toolbox/gen_scr_schema.py from the Arcanum CE sources (game/script.h, game/script.c).",
        "// Do not edit by hand; re-run the generator instead.",
        "//",
        "// Operand kinds per slot (ScriptCondition/ScriptAction op_type[i] / op_value[i]):",
        "//   val    read with script_get_value(): op_type is a ScriptValueType, op_value its index/number",
        "//   dst    written with script_set_value(): same encoding, destination variable",
        "//   obj    read with script_get_obj()/script_resolve_focus_obj(): op_type is a ScriptFocusObject",
        "//   objdst written with script_set_obj()",
        "//   lit    op_value used directly",
        "",
        "export const SCR_ATTACHMENT_POINTS = %s;" % js([pretty(n, "SAP").upper().replace(" ", "_") for n in sap]),
        "export const SCR_FOCUS_OBJECTS = %s;" % js([pretty(n, "SFO") for n in sfo]),
        "export const SCR_VALUE_TYPES = %s;" % js([pretty(n, "SVT") for n in svt]),
        "export const SCR_FLAG_BITS = %s;" % js([[int(v, 16), k[3:].lower().replace("_", " ")] for k, v in flags]),
        "export const SCR_CONDITIONS = %s;" % js(table(sct, cond_cases, "condition", "SCT")),
        "export const SCR_ACTIONS = %s;" % js(table(sat, act_cases, "action", "SAT")),
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT} ({len(sct)} conditions, {len(sat)} actions, {len(sap)} attachment points)")


if __name__ == "__main__":
    main()
