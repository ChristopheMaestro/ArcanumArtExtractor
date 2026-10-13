#!/usr/bin/env python3
"""Sort the loose sectors and objects of the world map folder into sub-folders by place.

Every .sec directly inside data/maps/<world map>/ is given to the nearest named place of
data/mes/gamearea.mes when that place is at most --radius sectors away (default 10). A sector farther
from every place goes to a "Secret Area - <n>" folder; neighbouring far sectors share one folder.
Sectors already in a sub-folder stay where they are, and a far sector that touches one of them joins it.

Each .mob follows the sector it stands in (items in inventories carry their owner's location).

It first shows the plan and only moves files after you confirm. Every move is written to
toolbox/reports/organize_world_log.json, and `--undo` puts everything back.

    python organize_world_map.py                 plan, ask, move
    python organize_world_map.py --dry-run       plan only
    python organize_world_map.py --undo          reverse the last run
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

MASK = (1 << 26) - 1
SECRET = 'Secret Area - '


def sector_xy(name: str):
    stem = Path(name).stem
    if not stem.isdigit():
        return None
    v = int(stem)
    return v & MASK, v >> 26


def norm(s: str) -> str:
    return re.sub(r'[^a-z0-9]', '', s.lower())


def folder_name(area: str) -> str:
    s = re.sub(r'[<>:"/\\|?*]', '', area).strip().rstrip('.')
    return re.sub(r'\s+', ' ', s)


def read_areas(path: Path):
    """gamearea.mes: {n}{X, Y, dx, dy /Name/Description[/Radius:n]} with X, Y in world tiles."""
    areas = []
    for line in path.read_text(encoding='cp1252', errors='replace').splitlines():
        m = re.match(r'\s*\{(\d+)\}\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,[^/]*/([^/}]*)', line)
        if not m:
            continue
        x, y, name = int(m.group(2)), int(m.group(3)), m.group(4).strip()
        if (x == 0 and y == 0) or not name:
            continue
        areas.append({'name': name, 'sx': x // 64, 'sy': y // 64})
    return areas


def read_mob_sectors(project: Path, rel: str, files: list[str]):
    """{file: (sectorX, sectorY)} from the project's own MOB decoder (run in a headless browser)."""
    import export_sec_maps as exp
    from playwright.sync_api import sync_playwright
    server = exp.start_server(project, exp.build_headless_overrides(project, {}))
    js = r'''async ([dir, files]) => {
      const { decodeMobBuffer, mobLocationInfo } = await import('/js/mob/mob-decoder.js');
      const out = [];
      for (let i = 0; i < files.length; i += 64) {
        await Promise.all(files.slice(i, i + 64).map(async f => {
          // The local server drops a request now and then under load: ask again before giving up.
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const r = await fetch('/data/maps/' + dir.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(f), { cache: 'no-store' });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const m = decodeMobBuffer(await r.arrayBuffer(), f);
              const loc = m.fields.find(x => x.field === 2);
              const li = loc ? mobLocationInfo(loc.value) : null;
              out.push([f, li ? li.sectorX : null, li ? li.sectorY : null]);
              return;
            } catch (e) { await new Promise(res => setTimeout(res, 100 * (attempt + 1))); }
          }
          out.push([f, null, null]);
        }));
      }
      return out;
    }'''
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_address[1]}/__sec_batch__.html', wait_until='domcontentloaded')
            page.wait_for_function('() => !!window.__secBatch || !!window.__secBatchError', timeout=60000)
            rows = page.evaluate(js, [rel, files])
            browser.close()
    finally:
        server.shutdown(); server.server_close()
    return {f: (x, y) for f, x, y in rows if x is not None}


def undo(maps_root: Path, log_file: Path):
    if not log_file.is_file():
        raise SystemExit(f'Nothing to undo: {log_file} does not exist.')
    log = json.loads(log_file.read_text(encoding='utf-8'))
    back = skipped = 0
    for mv in reversed(log['moves']):
        src, dst = maps_root / mv['to'], maps_root / mv['from']
        if src.is_file() and not dst.exists():
            os.rename(src, dst); back += 1
        else:
            skipped += 1
    for d in sorted(log.get('created_dirs', []), key=len, reverse=True):
        p = maps_root / d
        try:
            p.rmdir()
        except OSError:
            pass
    print(f'Put back {back} files' + (f', {skipped} could not be put back (missing or the original name is taken)' if skipped else '') + '.')
    if not skipped:
        log_file.rename(log_file.with_suffix('.undone.json'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument('--folder', default='Arcanum1-024-fixed')
    ap.add_argument('--radius', type=int, default=10, help='sectors around a place that belong to it')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--yes', action='store_true', help='move without asking')
    ap.add_argument('--undo', action='store_true')
    args = ap.parse_args()

    project = args.project_root.resolve()
    maps_root = project / 'data' / 'maps'
    folder = maps_root / args.folder
    export = Path(__file__).resolve().parent / 'reports'
    log_file = export / 'organize_world_log.json'
    if args.undo:
        undo(maps_root, log_file)
        return 0
    if not folder.is_dir():
        raise SystemExit(f'ERROR: {folder} does not exist')
    if log_file.is_file():
        raise SystemExit(f'A previous run is still on record ({log_file}). Run with --undo first, or delete that file '
                         'if you want to keep its result.')

    areas = read_areas(project / 'data' / 'mes' / 'gamearea.mes')
    print(f'{len(areas)} named places in gamearea.mes')

    loose = sorted(p for p in folder.glob('*.sec') if sector_xy(p.name))
    subdirs = {d.name: d for d in folder.iterdir() if d.is_dir()}
    in_sub: dict[tuple[int, int], str] = {}          # sectors that already sit in a sub-folder
    for name, d in subdirs.items():
        for p in d.glob('*.sec'):
            xy = sector_xy(p.name)
            if xy:
                in_sub[xy] = name
    print(f'{len(loose)} loose sectors, {len(in_sub)} sectors already in {len(subdirs)} sub-folders')

    def existing_folder_for(area_name: str):
        a = norm(area_name)
        for name in subdirs:
            n = norm(name)
            if n and (n == a or a.startswith(n)) and not name.startswith(SECRET.strip()):
                return name
        return None

    def nearest_area(x: int, y: int):
        best = min(areas, key=lambda a: max(abs(a['sx'] - x), abs(a['sy'] - y)))
        return best, max(abs(best['sx'] - x), abs(best['sy'] - y))

    sector_folder: dict[tuple[int, int], str] = {}
    reason: dict[tuple[int, int], str] = {}
    duplicates: list[Path] = []
    far: list[tuple[int, int]] = []
    for p in loose:
        xy = sector_xy(p.name)
        if xy in in_sub:                              # the sub-folder's copy is the one the viewer uses
            duplicates.append(p)
            continue
        area, dist = nearest_area(*xy)
        if dist <= args.radius:
            sector_folder[xy] = existing_folder_for(area['name']) or folder_name(area['name'])
            reason[xy] = f'{dist} sectors from {area["name"]}'
        else:
            far.append(xy)

    # Far sectors: neighbouring ones (8-neighbourhood, also with the sectors of existing folders) share a folder.
    far_set = set(far)
    seen: set[tuple[int, int]] = set()
    taken = set(subdirs) | set(sector_folder.values())
    counter = 0
    for start in sorted(far, key=lambda s: (s[1], s[0])):
        if start in seen:
            continue
        comp, stack, joined = [], [start], Counter()
        seen.add(start)
        while stack:
            cx, cy = stack.pop()
            comp.append((cx, cy))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    nb = (cx + dx, cy + dy)
                    if nb in far_set and nb not in seen:
                        seen.add(nb); stack.append(nb)
                    elif nb in in_sub:
                        joined[in_sub[nb]] += 1
        if joined:
            name = joined.most_common(1)[0][0]
            why = f'touches the sectors of "{name}"'
        else:
            counter += 1
            while f'{SECRET}{counter}' in taken:
                counter += 1
            name = f'{SECRET}{counter}'
            taken.add(name)
            why = 'more than %d sectors from any place' % args.radius
        for xy in comp:
            sector_folder[xy] = name
            reason[xy] = why

    # Objects.
    mob_files = sorted(p.name for p in folder.glob('*.mob'))
    print(f'Reading the location of {len(mob_files)} objects ...')
    mob_sector = read_mob_sectors(project, args.folder, mob_files) if mob_files else {}
    mob_folder: dict[str, str] = {}
    mob_why: dict[str, str] = {}
    unplaced: list[str] = []
    for f in mob_files:
        xy = mob_sector.get(f)
        if xy is None:
            unplaced.append(f); mob_why[f] = 'location could not be read'
            continue
        if xy in sector_folder:
            mob_folder[f] = sector_folder[xy]; mob_why[f] = 'stands in a moved sector'
        elif xy in in_sub:
            mob_folder[f] = in_sub[xy]; mob_why[f] = f'stands in a sector of "{in_sub[xy]}"'
        else:
            area, dist = nearest_area(*xy)
            if dist <= args.radius:
                mob_folder[f] = existing_folder_for(area['name']) or folder_name(area['name'])
                mob_why[f] = f'no sector file there; {dist} sectors from {area["name"]}'
            else:
                unplaced.append(f); mob_why[f] = 'no sector file there and no place nearby'

    # ---- the plan --------------------------------------------------------------------------------------
    moves: list[dict] = []
    rel = args.folder
    for p in loose:
        xy = sector_xy(p.name)
        if xy in sector_folder:
            moves.append({'kind': 'sec', 'name': p.name, 'folder': sector_folder[xy], 'why': reason[xy]})
    for f, dest in mob_folder.items():
        moves.append({'kind': 'mob', 'name': f, 'folder': dest, 'why': mob_why[f]})
    for mv in moves:
        mv['from'] = f'{rel}/{mv["name"]}'
        mv['to'] = f'{rel}/{mv["folder"]}/{mv["name"]}'

    per = defaultdict(lambda: [0, 0])
    for mv in moves:
        per[mv['folder']][0 if mv['kind'] == 'sec' else 1] += 1
    width = max([len(k) for k in per] + [10])
    print(f'\n{"Destination folder":<{width}}  {"sectors":>7}  {"objects":>7}  ')
    for name in sorted(per, key=str.lower):
        tag = '' if name in subdirs else '  (new)'
        print(f'{name:<{width}}  {per[name][0]:>7}  {per[name][1]:>7}{tag}')
    print(f'\n{sum(1 for m in moves if m["kind"] == "sec")} sectors and {sum(1 for m in moves if m["kind"] == "mob")} objects '
          f'would move into {len(per)} folders ({sum(1 for k in per if k not in subdirs)} of them new).')
    if duplicates:
        print(f'{len(duplicates)} loose sector(s) also exist inside a sub-folder; left where they are: '
              + ', '.join(f'{p.name} (in "{in_sub[sector_xy(p.name)]}")' for p in duplicates))
    if unplaced:
        print(f'{len(unplaced)} object(s) stay where they are: ' + '; '.join(f'{f} ({mob_why[f]})' for f in unplaced[:6])
              + (' ...' if len(unplaced) > 6 else ''))

    export.mkdir(exist_ok=True)
    plan_csv = export / 'organize_world_plan.csv'
    with plan_csv.open('w', newline='', encoding='utf-8-sig') as fh:
        w = csv.writer(fh)
        w.writerow(['kind', 'file', 'to folder', 'reason'])
        for mv in moves:
            w.writerow([mv['kind'], mv['name'], mv['folder'], mv['why']])
        for f in unplaced:
            w.writerow(['mob', f, '(stays)', mob_why[f]])
    print(f'Full plan: {plan_csv}')

    if args.dry_run or not moves:
        print('Dry run: nothing was moved.')
        return 0
    if not args.yes:
        if not sys.stdin.isatty():
            print('Not moving anything without a confirmation (use --yes).')
            return 0
        try:
            answer = input(f'\nMove these {len(moves)} files now? Type YES to go ahead: ').strip().lstrip('﻿')
        except (EOFError, KeyboardInterrupt):
            answer = ''
        if answer != 'YES':
            print('Cancelled: nothing was moved.')
            return 0

    # ---- do it -----------------------------------------------------------------------------------------
    created, done, skipped = [], [], 0
    for mv in moves:
        src, dst = maps_root / mv['from'], maps_root / mv['to']
        if not src.is_file() or dst.exists():
            skipped += 1
            continue
        d = dst.parent
        if not d.exists():
            d.mkdir(parents=True)
            created.append(f'{rel}/{mv["folder"]}')
        os.rename(src, dst)
        done.append({'from': mv['from'], 'to': mv['to']})
    log_file.write_text(json.dumps({'moves': done, 'created_dirs': sorted(set(created))}, indent=1), encoding='utf-8')
    print(f'\nMoved {len(done)} files' + (f' ({skipped} skipped: missing, or the name was already taken)' if skipped else '') + '.')
    print(f'Log: {log_file}  (python organize_world_map.py --undo reverses it)')
    print('The manifests are not updated: run "Build folder manifests" before using the folders in the viewer.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
