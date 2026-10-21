"""
The game files behind every person, creature, container, door and piece of scenery placed as a .mob: what the Atlas's
Advanced view lists under "Advanced view" (and opens in Files).

Writes js/atlas/data/assets.js (window.ArcanumAssets), loaded by the Atlas only once Advanced view is turned on:
  mobs[path] = [object type, prototype number, art id, scripts, sector, portrait, random inventory] (written grouped by folder: pack_mobs)
    path        the .mob under data/maps (the "file" of npcs.js, submaps.js, modules.js, items.js)
    type / prototype / art id / scripts   as in asset_refs.py
    sector      the .sec under data/maps its tile lies in (0 = none found)
    portrait    OBJ_F_CRITTER_PORTRAIT (field 231), a portrait/gameport.mes number (0 = none)
    random inventory   the Rules/InvenSource.mes list it rolls (NPC field 239, container field 61; 0 = none)
  protos[n] = the .pro under data/proto; scr[n] / dlg[n] = data/scr/<file> / data/dlg/<file> of script n (a script's
  dialog file shares its number); portraits[n] = the .bmp under data/portrait.
The waypoints and signs carry their own object (asset_refs.ref) in waypoints.js and notices.js.
Re-run rather than edit:  py build_assets.py
"""
import json
import re
import sys
from pathlib import Path

import arcanum_objects as ao
import sec_alias
import asset_refs as ar

ROOT = Path(__file__).resolve().parents[2]
OUT_JS = ao.DATA_JS / 'assets.js'
MAPS = ao.DATA / 'maps'
MODULES = ao.DATA / 'modules'
TYPES = {1, 2, 3, 15, 16}                       # portal, container, scenery, PC, NPC
F_PORTRAIT, F_NPC_SOURCE, F_BOX_SOURCE = 231, 239, 61


def numbered(folder, ext):
    out = {}
    for f in sorted(folder.glob('*.' + ext)):
        m = re.match(r'(\d+)', f.name)
        if m:
            out.setdefault(int(m.group(1)), f.name)
    return out


def pack_mobs(mobs):
    """mobs ({path: [type, proto, aid, scripts, sector, portrait, source]}) as written: {folder: {name without .mob: row}}, a sector in the
    .mob's own folder as its number, the zeros at the end of a row left out (atlas-app.js loadAssets puts it back as mobs[path]).
    40% smaller than one line per path."""
    out = {}
    for path, row in sorted(mobs.items()):
        folder, _, name = path.rpartition('/')
        row = list(row)
        sec = row[4]
        stem = sec.rpartition('/')[2][:-4] if sec else ''
        if sec and sec.rpartition('/')[0] == folder and sec.endswith('.sec') and stem.isdigit() and int(stem):    # (0.sec stays a path: 0 is none)
            row[4] = int(sec.rpartition('/')[2][:-4])
        while row and row[-1] in (0, []):
            row.pop()
        out.setdefault(folder, {})[name[:-4]] = row                    # (every key is a .mob)
    return out


def main():
    protos = ar.Protos()
    sectors = {}                                # (map folder, sector id) -> .sec path
    for root in (MAPS, MODULES):
        for sec in sec_alias.rglob(root, '*.sec'):
            if sec.stem.isdigit():
                sectors[(sec_alias.home(sec).parent, int(sec.stem))] = ('modules/' if root is MODULES else '') + sec_alias.rel(sec, root).as_posix()
    port = {k: v.strip() + '.bmp' for k, v in ao.mes(ao.DATA / 'portrait' / 'gameport.mes').items()
            if k >= 1000 and (ao.DATA / 'portrait' / (v.strip() + '.bmp')).exists()}

    # a module's own scripts and dialogs: their numbers collide with the game's, so they are listed per module
    mod = {}
    for scr in sorted(MODULES.glob('*/scr')):
        m = scr.parent.name
        mod[m] = {'scr': {str(k): v for k, v in numbered(scr, 'scr').items()},
                  'dlg': {str(k): v for k, v in numbered(scr.parent / 'dlg', 'dlg').items()} if (scr.parent / 'dlg').is_dir() else {}}

    mobs, used_ports = {}, set()
    for root in (MAPS, MODULES):
      for path in sorted(root.rglob('*.mob')):
        o = ao.read_mob(path)
        if o.type not in TYPES:
            continue
        rel = ('modules/' if root is MODULES else '') + path.relative_to(root).as_posix()    # as modules.js names its .mob files
        _, otype, num, aid, scr, *own = ar.ref(rel, o, protos)
        e = ao.Effective(o, protos.get(o.proto))
        t = o.tile
        sector = sectors.get((path.parent, (t[0] >> 6) | ((t[1] >> 6) << 26)), 0) if t else 0
        portrait = e.int(F_PORTRAIT) if o.type in (15, 16) and e.int(F_PORTRAIT) in port else 0
        source = e.int(F_NPC_SOURCE if o.type in (15, 16) else F_BOX_SOURCE) if o.type in (2, 15, 16) else 0
        used_ports.add(portrait)
        mobs[rel] = [otype, num, aid, scr, sector, portrait, source] + own

    note = ('mobs[folder under data/maps][.mob name without .mob] = [object type, prototype number (protos), art id (F_CURRENT_AID), scripts [[attachment point, number], ...], '
            'sector (.sec under data/maps, a number: <number>.sec in the same folder; 0 = none), portrait (gameport.mes number: portraits), random inventory '
            '(Rules/InvenSource.mes number), own .mes texts ([[file, text], ...]: a name from oname.mes, a description from description.mes / gamedesc.mes that is not its prototype\'s)], the zeros at the end left out; '
            'protos[n] = .pro under data/proto; scr[n] / dlg[n] = file of script n under data/scr / data/dlg; portraits[n] = .bmp under data/portrait')
    out = {'source': 'toolbox/atlas/build_assets.py', 'note': note,
           'protos': {str(k): p.file for k, p in sorted(protos.by_num.items())},
           'scr': {str(k): v for k, v in numbered(ao.DATA / 'scr', 'scr').items()},
           'dlg': {str(k): v for k, v in numbered(ao.DATA / 'dlg', 'dlg').items()},
           'mod': mod,
           'portraits': {str(k): v for k, v in sorted(port.items()) if k in used_ports},
           'mobs': pack_mobs(mobs)}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_assets.py - re-run it rather than editing by hand.\nwindow.ArcanumAssets = '
                      + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(f'{len(mobs)} .mob objects, {sum(1 for m in mobs.values() if m[3])} with scripts, {sum(1 for m in mobs.values() if not m[4])} without a sector')
    print(f'Wrote {OUT_JS.name} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    sys.exit(main())
