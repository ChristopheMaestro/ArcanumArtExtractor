#!/usr/bin/env python3
"""
Generates data/scr/local_flags.json: where every script is attached, and what can change its local flags.

A script's "local flags" (32 yes / no bits, ScriptHeader.flags) are not stored in the script: they live
in the attachment, i.e. the copy of the script that an object, prototype or sector object carries at
one event (SAP_*). The engine (game/script.c, dialog.c) changes them in only three ways:

    * a "set local flag" / "clear local flag" line of the script, run on that attachment;
    * a dialogue's "lfN V" effect, on the NPC's attachment at the dialog event (SAP_DIALOG);
    * the value stored with the attachment (object, prototype or sector object file), its initial one.

A script started with "call script" works on a fresh copy and forgets it afterwards. A script that is
replaced ("change this script to script", "change script") leaves its flags to the one that takes its
place, so the scripts that turn into another one are listed too.

The files are read through the viewer's own decoders (a headless browser), so this needs Playwright:

    python toolbox/gen_local_flags.py

Run it again after the data changes. Used by the .SCR viewer (js/scr/scr-local-flags.js).
"""

import json
import socketserver
import http.server
import struct
import sys
import threading
from urllib.parse import quote

from gen_global_flags import (DATA, HEADER_SIZE, ENTRY_SIZE, ACTION_SIZE, ROOT, SCHEMA,
                              VT_NUMBER, read_stmt, schema_table)

OUT = DATA / "scr" / "local_flags.json"
ACT_SET_LOCAL, ACT_CLEAR_LOCAL = 8, 9
ACT_CHANGE_THIS, ACT_CHANGE_SCRIPT = 6, 99      # "change this script to script", "change script"

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("ERROR: Playwright is required: pip install playwright && playwright install chromium", file=sys.stderr)
    raise SystemExit(2)


# ---- the scripts: who turns into whom, and which local flags a script sets -----------------------------

def scan_scripts():
    turns = {}      # target script number -> [[file, line, kind]]
    sets = {}       # file -> {"set": set(), "clear": set()}
    for path in sorted((DATA / "scr").glob("*.scr")):
        buf = path.read_bytes()
        if len(buf) < HEADER_SIZE:
            continue
        count = min(struct.unpack_from("<i", buf, 0x34)[0], (len(buf) - HEADER_SIZE) // ENTRY_SIZE)
        for line in range(max(count, 0)):
            o = HEADER_SIZE + line * ENTRY_SIZE
            cond_type = struct.unpack_from("<i", buf, o)[0]
            stmts = [read_stmt(buf, o + ACTION_SIZE)]
            if cond_type != 0:      # an always-true line never takes its else branch
                stmts.append(read_stmt(buf, o + 2 * ACTION_SIZE))
            for kind, op_type, op_value in stmts:
                if kind in (ACT_SET_LOCAL, ACT_CLEAR_LOCAL) and op_type[0] == VT_NUMBER:
                    sets.setdefault(path.name, {"set": set(), "clear": set()})["set" if kind == ACT_SET_LOCAL else "clear"].add(op_value[0])
                elif kind == ACT_CHANGE_THIS and op_type[0] == VT_NUMBER:
                    turns.setdefault(op_value[0], []).append([path.name, line, "change this script to script"])
                elif kind == ACT_CHANGE_SCRIPT and op_type[2] == VT_NUMBER:
                    turns.setdefault(op_value[2], []).append([path.name, line, "change script"])
    return turns, sets


# ---- the attachments: read by the viewer's decoders in a headless browser ----------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".html": "text/html"}

    def log_message(self, *args):
        pass


def start_server():
    def factory(*args, **kwargs):
        return Handler(*args, directory=str(ROOT), **kwargs)
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), factory)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


SCAN_JS = """
async ({ items }) => {
  const mob = await import('/js/mob/mob-decoder.js');
  const pro = await import('/js/proto/proto-decoder.js');
  const sec = await import('/js/sec/sec-parser.js');
  const sch = await import('/js/scr/scr-schema.js');
  const F_SCRIPTS_IDX = 32;
  const out = [], errors = [], tiles = [];
  // Tile scripts: the script runs when something steps on the tile (sector id = x | y << 26).
  const tileScripts = (name, data) => {
    const id = BigInt(name.split('/').pop().replace(/\\.sec$/i, ''));
    const sx = Number(id & 0x3FFFFFFn), sy = Number((id >> 26n) & 0x3FFFFFFn);
    for (const t of data.tileScripts || []) if (t.script.num) tiles.push([t.script.num, name, sx, sy, t.tileX, t.tileY]);
  };
  const attachments = (kind, name, fields) => {
    const f = (fields || []).find(x => x.field === F_SCRIPTS_IDX);
    for (const e of f?.value?.elements || []) {
      const v = e.value;
      if (!v || !v.script_num) continue;
      const flags = Number(String(v.script_record || '').split(',')[0]) >>> 0;
      out.push([v.script_num, kind, name, sch.SCR_ATTACHMENT_POINTS[e.index] || String(e.index), flags]);
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const [kind, url, name] = items[next++];
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        if (kind === 'mob') attachments('mob', name, mob.decodeMobBuffer(buf, name).fields);
        else if (kind === 'pro') attachments('pro', name, pro.decodeProtoBuffer(buf, name).fields);
        else {
          const data = sec.readSecTileData(buf, name);
          for (const o of data.staticObjects) attachments('sec', name, o.fields);
          tileScripts(name, data);
        }
      } catch (err) { errors.push(name + ': ' + (err && err.message || err)); }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return { out, errors, tiles };
}
"""


def collect_attachments():
    maps = DATA / "maps"
    items = []
    for kind, pattern, base in (("mob", "*.mob", maps), ("pro", "*.pro", DATA / "proto"), ("sec", "*.sec", maps)):
        for p in sorted(base.rglob(pattern)):
            rel = p.relative_to(DATA).as_posix()
            items.append([kind, "/data/" + quote(rel), rel])
    print(f"{len(items)} files to read ({sum(1 for i in items if i[0] == 'mob')} .mob, "
          f"{sum(1 for i in items if i[0] == 'pro')} .pro, {sum(1 for i in items if i[0] == 'sec')} .sec)")
    server = start_server()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    rows, errors, tiles = [], [], []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page()
            page.goto(base_url + "/asset-browser.html", wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            for start in range(0, len(items), 1500):
                res = page.evaluate(SCAN_JS, {"items": items[start:start + 1500]})
                rows += res["out"]
                tiles += res["tiles"]
                errors += res["errors"]
                print(f"  {min(start + 1500, len(items))} / {len(items)}", end="\r", flush=True)
            browser.close()
    finally:
        server.shutdown()
    print()
    return rows, errors, tiles


def main():
    src = SCHEMA.read_text(encoding="utf-8")
    schema_table(src, "SCR_ACTIONS")        # fails early when the schema is missing
    turns, sets = scan_scripts()
    rows, errors, tiles = collect_attachments()

    scripts = {}
    for num, kind, name, point, flags in rows:
        s = scripts.setdefault(str(num), {"attached": {}, "initial": []})
        by = s["attached"].setdefault(point, {})
        by[kind] = by.get(kind, 0) + 1
        if flags:
            s["initial"].append([kind, name, point, flags])
    # Tile scripts: [map folder, sector x, sector y, tile x, tile y]; "maps/<map>/[town/]<id>.sec" -> <map>.
    for num, name, sx, sy, tx, ty in tiles:
        s = scripts.setdefault(str(num), {"attached": {}, "initial": []})
        s.setdefault("tiles", []).append([name.split("/")[1], sx, sy, tx, ty])
    for num, lst in turns.items():
        s = scripts.setdefault(str(num), {"attached": {}, "initial": []})
        s["turnsInto"] = [[f, line, kind, sorted(sets.get(f, {}).get("set", ())), sorted(sets.get(f, {}).get("clear", ()))]
                          for f, line, kind in lst]
    OUT.write_text(json.dumps({"scripts": scripts}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    flagged = sum(1 for s in scripts.values() if s["initial"])
    print(f"{len(rows)} attachments of {sum(1 for s in scripts.values() if s['attached'])} scripts; "
          f"{sum(len(s['initial']) for s in scripts.values())} start with local flags set ({flagged} scripts); "
          f"{sum(1 for s in scripts.values() if s.get('turnsInto'))} scripts are the target of a switch -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    if errors:
        print(f"{len(errors)} file(s) could not be read, e.g. {errors[:3]}")


if __name__ == "__main__":
    main()
