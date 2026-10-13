#!/usr/bin/env python3
"""
Put the Map Explorer's overworld labels on the real world map (the Atlas's render of Arcanum1-024-fixed).

The Map Explorer draws each town on its own stitched screenshot, with labels in screenshot pixels. On the world
map every place is part of one big map, so each label needs a world tile instead. Where it is found:

  1. The label names one object of the place's folder (data/maps/Arcanum1-024-fixed/<place>/): a .mob (NPC,
     container, item) or a .sec static object (sign, altar, door...). The object's own F_DESCRIPTION names it when
     it has one, else its prototype (description.mes key = prototype number - 20). It takes that object's tile.
  2. Those anchors fit screenshot px -> tile for the place. The screenshots are an isometric game view, so
        Y - X = a*sx + b,   X + Y = 2a*sy + c
     The scale a is fitted when the anchors are spread out, else it is the one every well-fitted map shares
     (the screenshots are all at half the game's resolution). Anchors that disagree with the rest are dropped.
  3. With no unique anchor, every (label, candidate) pair is tried and the offset most labels agree with wins.
  4. Labels naming several objects (5 "Heartstone", 4 "Barrel") get one each, nearest to the predicted spot first.
     Waypoints snap to a door / passage / sewer grate within 5 tiles of their predicted spot.
  5. Everything else is placed by the fit: approximate. A place with nothing to go on uses its gamearea.mes spot.

Places whose labels match nothing on the world map (Qintarra, T'sen-Ang...) are separate game maps: they keep
their screenshot. The World Map picture's labels take their area's gamearea.mes tile. Waypoints of every map
(base, CE Restored, modules) that arrive in a moved place get their arrival spot converted too.

Labels about a person or a container are used for the fit but not written: those come from the .mob files alone
(mob_backed). A copy of the labels as they were before that is in toolbox/atlas/backup/.

Writes js/atlas/data/world-labels.js (window.ArcanumWorldLabels) and toolbox/atlas/reports/world-labels-report.txt.
Needs: Playwright with Chromium (to read the Map Explorer's .js databases exactly as a browser does), numpy.
"""
import difflib, json, math, re, struct, sys, unicodedata
from collections import defaultdict
from pathlib import Path

import numpy as np

PROJECT = Path(__file__).resolve().parent.parent.parent
TOOLBOX = PROJECT / 'toolbox'
sys.path.insert(0, str(TOOLBOX))
import extract_mob_prototypes as emp  # noqa: E402  (schema, field reader, description.mes)

WORLD = PROJECT / 'data' / 'maps' / 'Arcanum1-024-fixed'
EXPLORER = PROJECT / 'ArcanumMapExplorer'
OUT_JS = PROJECT / 'js' / 'atlas' / 'data' / 'world-labels.js'
OUT_REPORT = Path(__file__).resolve().parent / 'reports' / 'world-labels-report.txt'
DATABASES = ('arcanummaps.js', 'cerestoredmaps.js', 'modulesmaps.js')
OVERWORLD_GROUPS = ('Cities', 'Quest locations', 'Other locations')

# .sec static objects too common or too vague to name a label
SKIP_STATIC = {'Plant', 'Tree', 'Big Tree', 'Small Tree', 'Dead Tree', 'Wooden Object', 'Metal Object', 'Small Metal Object',
               'Big Wooden Object', 'Something Small', 'Something Mid Sized', 'Small Wooden Object', 'Big Metal Object',
               'Non Opening Window', 'Window', 'Electric Light', 'Lantern', 'Candlestick', 'Light', 'Fire', 'Torch'}
DOORS = {'Light Wood Door', 'Metal Door', 'Heavy Wood Door', 'Passage', 'Sewer Grate'}
# words that never identify one object on their own
GENERIC = {'human', 'elf', 'dwarf', 'gnome', 'halfling', 'half', 'orc', 'ogre', 'guard', 'villager', 'chest', 'bandit',
           'altar', 'barrel', 'door', 'stone', 'body', 'boat', 'portal', 'items', 'coins'}

OBJECT, SEVERAL, FAR, DOOR, KIND, APPROX, AREA = ('object', 'one of several', 'object far from screenshot spot',
                                                  'door near screenshot spot', 'same kind of object near screenshot spot',
                                                  'approximate', 'area centre')


# ---- names ---------------------------------------------------------------------------------------------------
def norm(t):
    t = unicodedata.normalize('NFKD', t or '').encode('ascii', 'ignore').decode()
    t = re.sub(r'<br\s*/?>', ' ', t, flags=re.I).lower()
    t = re.sub(r"[’'`]", '', t)
    t = re.sub(r'\(.*?\)', ' ', t)                     # "Altar (Kree)" -> "altar"
    t = re.sub(r'[^a-z0-9]+', ' ', t)
    return ' '.join(w for w in t.split() if w not in ('the', 'of', 'a', 'an'))


def singular(t):
    return ' '.join(w[:-1] if len(w) > 3 and w.endswith('s') and not w.endswith('ss') else w for w in t.split())


# ---- world objects -------------------------------------------------------------------------------------------
def read_object(data, off, sch):
    """One serialized object (a .mob, or one entry of a .sec object list) -> (type, proto, own description, loc, end)."""
    proto_oid = data[off + 4:off + 28]
    otype = struct.unpack_from('<i', data, off + 52)[0]
    off += 58
    n = emp.MOB_BITMAP_DWORDS[otype]
    bitmap = struct.unpack_from('<%dI' % n, data, off)
    off += n * 4
    loc = own = None
    for fld in sch.fields_by_type[otype]:
        if not (bitmap[sch.change_idx[fld]] & sch.mask[fld]):
            continue
        od = sch.od[fld]
        if fld == 2 and od == 4:                      # F_LOCATION: x in the low dword, y in the high one
            if data[off]:
                loc = struct.unpack_from('<q', data, off + 1)[0]
            off += 9 if data[off] else 1
            continue
        value, off = emp.read_field(data, off, od)
        if fld == 23:                                 # F_DESCRIPTION
            own = value
    return otype, emp.prototype_number_from_oid(proto_oid), own, loc, off


def sec_objects(data, sch):
    """The static objects of a .sec (layout: js/sec/sec-parser.js)."""
    lights = struct.unpack_from('<I', data, 0)[0]
    off = 4 + lights * 0x30 + 4096 * 4
    roof_empty = struct.unpack_from('<i', data, off)[0]
    off += 4 + (1024 if roof_empty == 0 else 0)       # 256 roof art ids only when the list is not empty
    ph = struct.unpack_from('<i', data, off)[0]
    off += 4
    if ph != 0xAA0000:
        off += 4 + struct.unpack_from('<i', data, off)[0] * 0x18
        off += (12 if ph >= 0xAA0002 else 0) + (24 if ph >= 0xAA0003 else 0) + (512 if ph >= 0xAA0004 else 0)
    for _ in range(struct.unpack_from('<i', data, len(data) - 4)[0]):
        otype, proto, own, loc, off = read_object(data, off, sch)
        yield otype, proto, own, loc


def world_objects():
    sch, desc = emp.schema(), emp.load_description_mes()

    def row(path, src, otype, proto, own, loc):
        pname = desc.get(proto - 20, {}).get('name', '') if proto is not None else ''
        oname = desc.get(own, {}).get('name', '') if own is not None else ''
        return {'area': path.parent.name if path.parent != WORLD else '', 'file': path.name, 'src': src,
                'type': emp.OBJECT_TYPES[otype], 'name': oname if oname and oname != pname else pname,
                'unique': bool(oname and oname != pname), 'x': loc & 0xFFFFFFFF, 'y': (loc >> 32) & 0xFFFFFFFF}

    objs, statics = [], []
    for path in sorted(WORLD.rglob('*.mob')):
        otype, proto, own, loc, _ = read_object(path.read_bytes(), 0, sch)
        if loc is not None:
            objs.append(row(path, 'mob', otype, proto, own, loc))
    for path in sorted(WORLD.rglob('*.sec')):
        for otype, proto, own, loc in sec_objects(path.read_bytes(), sch):
            if otype != 0 and loc is not None:
                statics.append(row(path, 'sec', otype, proto, own, loc))
    return objs, statics


def game_areas():
    areas = {}
    for line in (PROJECT / 'data' / 'mes' / 'gamearea.mes').read_text(encoding='cp1252', errors='replace').splitlines():
        m = re.match(r'\s*\{(\d+)\}\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,[^/]*/([^/}]*)', line)
        if m and (int(m.group(2)) or int(m.group(3))):
            areas[norm(m.group(4))] = (int(m.group(2)), int(m.group(3)))
    return areas


def read_databases():
    from playwright.sync_api import sync_playwright
    res = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content('<html><body></body></html>')
        for f in DATABASES:
            if not (EXPLORER / f).exists():          # only the base game's labels are needed; the others are optional
                continue
            src = (EXPLORER / f).read_text(encoding='utf-8')
            names = re.findall(r'^\s*(?:const|let|var)\s+(\w+)\s*=\s*\[', src, re.M)
            page.add_script_tag(content=src + '\n;window.__v = {' + ','.join(names) + '};')
            res[f] = page.evaluate('window.__v')
        browser.close()
    return res


# ---- fit -------------------------------------------------------------------------------------------------------
def predict(sol, sx, sy):
    a, b, c = sol
    u, v = a * sx + b, 2 * a * sy + c                # u = Y - X, v = X + Y
    return (v - u) / 2, (v + u) / 2


def fit(anchors, a_fixed=None):
    A, y = [], []
    for sx, sy, X, Y in anchors:
        if a_fixed is None:
            A += [[sx, 1, 0], [2 * sy, 0, 1]]; y += [Y - X, X + Y]
        else:
            A += [[1, 0], [0, 1]]; y += [Y - X - a_fixed * sx, X + Y - 2 * a_fixed * sy]
    sol = np.linalg.lstsq(np.array(A, float), np.array(y, float), rcond=None)[0]
    return tuple(map(float, sol)) if a_fixed is None else (a_fixed, float(sol[0]), float(sol[1]))


def spread(anchors):
    return max((math.hypot(p[2] - q[2], p[3] - q[3]) for p in anchors for q in anchors), default=0)


def dist(p, o):
    return math.hypot(p[0] - o['x'], p[1] - o['y'])


# People and containers come from the game's .mob files alone (npcs.js, submaps.js, items.js): one entry per object, on its
# own tile. A Map Explorer label about one of them would be a second entry for the same person or chest (often a few tiles
# off), so those labels still help the fit but are not written. What stays: waypoints, notes, altars, quest objects.
MOB_CATEGORIES = {'npc', 'shop', 'followers', 'master', 'bounty', 'chest'}


def mob_backed(lb, o):
    """True for a label about a person or a container: by its category, or because it sits on an NPC / container .mob."""
    cats = lb.get('category')
    cats = set(cats if isinstance(cats, list) else [cats])
    return bool(cats & MOB_CATEGORIES) or bool(o and o['src'] == 'mob' and o['type'] in ('NPC', 'Container'))


class World:
    def __init__(self, objs, statics, areas):
        self.areas = areas
        self.folders, self.doors, self.folder_name = defaultdict(list), defaultdict(list), {}
        for o in objs + [s for s in statics if s['name'] not in SKIP_STATIC]:
            self.folders[norm(o['area'])].append(o)
            self.folder_name[norm(o['area'])] = o['area']
        for o in statics:
            if o['type'] == 'Portal' or o['name'] in DOORS:
                self.doors[norm(o['area'])].append(o)

    def candidates(self, labels, cands):
        byname, bysing = defaultdict(list), defaultdict(list)
        for o in cands:
            if o['name']:
                byname[norm(o['name'])].append(o)
                bysing[singular(norm(o['name']))].append(o)
        rows = []
        for i, lb in enumerate(labels):
            t, hits = norm(lb.get('text', '')), []
            if t in byname:
                hits = byname[t]
            elif singular(t) in bysing:
                hits = bysing[singular(t)]
            else:
                best = None    # "Lukan the Witless" -> "Lukan"; "Makaal's Altar" -> the place's Altar
                for n, ms in byname.items():
                    if n in GENERIC or len(n) < 4:
                        if not (n == 'altar' and t.endswith(' altar')):
                            continue
                    elif not any(o['unique'] for o in ms):
                        continue
                    if (t.startswith(n + ' ') or t.endswith(' ' + n) or n.startswith(t + ' ')) and (best is None or len(n) > len(best)):
                        best = n
                if best:
                    hits = byname[best]
                else:          # spelling slips: "William Radclife" / "William Radcliffe"
                    scored = [(difflib.SequenceMatcher(None, t, n).ratio(), n) for n, ms in byname.items()
                              if len(n) >= 6 and any(o['unique'] for o in ms)]
                    if scored and max(scored)[0] >= 0.88:
                        hits = [o for o in byname[max(scored)[1]] if o['unique']]
            rows.append({'i': i, 'lb': lb, 'hits': hits})
        return rows

    def place(self, mp, a_shared):
        key = norm(mp['displayName'])
        cands = self.folders.get(key, [])
        rows = self.candidates(mp.get('labels', []), cands)

        anchors = [(r['lb']['x'], r['lb']['y'], r['hits'][0]['x'], r['hits'][0]['y'], r['i']) for r in rows if len(r['hits']) == 1]
        sol, free = None, False
        for _ in range(8):
            if not anchors or (a_shared is None and len(anchors) < 2):
                break
            free = len(anchors) >= 4 and spread(anchors) >= 20
            if not free and a_shared is None:
                break
            sol = fit([a[:4] for a in anchors], None if free else a_shared)
            res = [math.hypot(*(p - q for p, q in zip(predict(sol, a[0], a[1]), a[2:4]))) for a in anchors]
            med = sorted(res)[len(res) // 2]
            keep = [a for a, d in zip(anchors, res) if d <= max(8.0, 3 * med)]
            if len(keep) == len(anchors) or not keep:
                break
            anchors = keep

        if sol is None and a_shared is not None:       # no unique anchor: consensus over every pairing
            best = None
            for r in rows:
                for o in r['hits']:
                    trial = fit([(r['lb']['x'], r['lb']['y'], o['x'], o['y'])], a_shared)
                    score = sum(1 for r2 in rows if r2['hits'] and
                                min(dist(predict(trial, r2['lb']['x'], r2['lb']['y']), o2) for o2 in r2['hits']) <= 4)
                    if best is None or score > best[0]:
                        best = (score, trial)
            if best:
                cons = []
                for r2 in rows:
                    if r2['hits']:
                        p = predict(best[1], r2['lb']['x'], r2['lb']['y'])
                        o2 = min(r2['hits'], key=lambda o: dist(p, o))
                        if dist(p, o2) <= 4:
                            cons.append((r2['lb']['x'], r2['lb']['y'], o2['x'], o2['y']))
                sol = fit(cons, a_shared)

        rms = None
        if sol is not None and anchors:
            res = [math.hypot(*(p - q for p, q in zip(predict(sol, a[0], a[1]), a[2:4]))) for a in anchors]
            rms = math.sqrt(sum(d * d for d in res) / len(res))
        anchor_ids = {a[4] for a in anchors}

        placed, used = {}, set()
        for r in rows:
            if r['i'] in anchor_ids:
                o = r['hits'][0]; placed[r['i']] = ((o['x'], o['y']), OBJECT, o); used.add(id(o))
        for r in rows:   # a named one-of-a-kind object that disagrees with the fit still goes where the game puts it,
            o = r['hits'][0] if len(r['hits']) == 1 else None   # unless the label is a second spot ("... (Bridge)")
            if r['i'] not in placed and o and o['unique'] and id(o) not in used and '(' not in r['lb'].get('text', ''):
                placed[r['i']] = ((o['x'], o['y']), FAR, o); used.add(id(o))
        if sol is not None:
            pend = []
            for r in rows:
                if r['i'] not in placed:
                    p = predict(sol, r['lb']['x'], r['lb']['y'])
                    pend += [(dist(p, o), r['i'], o) for o in r['hits']]
            lim = max(10, 3 * (rms or 0))
            for d, i, o in sorted(pend, key=lambda t: t[0]):
                if i not in placed and id(o) not in used and d <= lim:
                    placed[i] = ((o['x'], o['y']), SEVERAL, o); used.add(id(o))
            doors = self.doors.get(key, [])
            for r in rows:
                if r['i'] in placed:
                    continue
                p = predict(sol, r['lb']['x'], r['lb']['y'])
                cats = r['lb'].get('category'); cats = cats if isinstance(cats, list) else [cats]
                if 'waypoint' in cats and doors:
                    o = min(doors, key=lambda o: dist(p, o))
                    if dist(p, o) <= 5:
                        placed[r['i']] = ((o['x'], o['y']), DOOR, o)
                        continue
                # an object of the same kind right there ("Warning Stone" -> the "Big Stone" beside it)
                kind = singular(norm(r['lb'].get('text', ''))).split()[-1:] or ['']
                near = [o for o in cands if id(o) not in used and o['name'] and dist(p, o) <= 3
                        and singular(norm(o['name'])).split()[-1:] == kind]
                if near:
                    o = min(near, key=lambda o: dist(p, o))
                    placed[r['i']] = ((o['x'], o['y']), KIND, o); used.add(id(o))
                    continue
                placed[r['i']] = ((round(p[0]), round(p[1])), APPROX, None)
        else:
            centre = self.area_centre(key, cands)
            for r in rows:
                if r['i'] not in placed and centre:
                    placed[r['i']] = (centre, AREA, None)
        return {'rows': rows, 'placed': placed, 'fit': sol, 'rms': rms, 'free': free, 'anchors': len(anchors),
                'centre': self.area_centre(key, cands)}

    def area_centre(self, key, cands):
        if key in self.areas:
            return self.areas[key]
        if cands:
            return (round(sum(o['x'] for o in cands) / len(cands)), round(sum(o['y'] for o in cands) / len(cands)))
        return None


def main():
    print('Reading the Map Explorer databases...')
    dbs = read_databases()
    base = dbs['arcanummaps.js']['ArcanumCitiesMapData']
    print('Reading the world map objects (.mob and .sec)...')
    objs, statics = world_objects()
    print(f'  {len(objs)} .mob objects, {len(statics)} static objects')
    world = World(objs, statics, game_areas())

    overworld = [m for m in base if m.get('modGroup') in OVERWORLD_GROUPS and norm(m['displayName']) in world.folders]
    scales = [r['fit'][0] for r in (world.place(m, None) for m in overworld) if r['free'] and r['fit']]
    a0 = sorted(scales)[len(scales) // 2]
    print(f'  shared screenshot scale from {len(scales)} maps: {1 / (40 * a0):.3f} px per half tile')

    report = [f'Shared screenshot scale: {1 / (40 * a0):.3f} px per half tile (from {len(scales)} maps).', '']
    places, fits, tiles_of = [], {}, {}
    totals = defaultdict(int)
    for mp in [m for m in base if m.get('modGroup') in OVERWORLD_GROUPS]:
        name = mp['displayName']
        if norm(name) not in world.folders:
            report.append(f'-- {name}: no folder in the world map: keeps its screenshot.')
            continue
        r = world.place(mp, a0)
        if not any(p[2] for p in r['placed'].values()) and len(r['rows']) > 2:
            report.append(f'-- {name}: none of its {len(r["rows"])} labels is on the world map (a separate game map): keeps its screenshot.')
            continue
        fits[name] = (r['fit'], r['centre'])
        kinds = defaultdict(int)
        labels = []
        for row in r['rows']:
            lb = row['lb']
            pos, how, o = r['placed'].get(row['i'], (None, 'unplaced', None))
            if mob_backed(lb, o):
                totals['person or container (from .mob)'] += 1
                continue
            kinds[how] += 1; totals[how] += 1
            out = {k: v for k, v in lb.items() if k not in ('x', 'y', 'textX', 'textY')}
            out.update({'tile': list(pos) if pos else None, 'placed': how, 'screenshot': [lb['x'], lb['y']]})
            if o:
                out['object'] = f"{o['name']} ({o['src']} {o['file']})"
            labels.append(out)
            tiles_of[(name, lb['x'], lb['y'])] = pos
        view = mp.get('defaultView')
        view_tile = (list(map(round, predict(r['fit'], view['x'], view['y']))) if r['fit'] and view else
                     list(r['centre']) if r['centre'] else None)
        places.append({'name': name, 'modGroup': mp.get('modGroup'), 'worldFolder': world.folder_name.get(norm(name)),
                       'screenshot': mp.get('filename'), 'view': view_tile, 'labels': labels})
        head = f'== {name}: {len(r["rows"])} labels, {r["anchors"]} anchors'
        if r['fit']:
            head += f', fit rms {r["rms"]:.1f} tiles' if r['rms'] is not None else ', offset from a consensus'
            head += f', scale {"fitted" if r["free"] else "shared"} {1 / (40 * r["fit"][0]):.3f}'
        else:
            head += ', no fit (area centre)'
        report.append(head + ' | ' + ', '.join(f'{k}: {v}' for k, v in sorted(kinds.items())))
        for lab in labels:
            if lab['placed'] in (APPROX, AREA, FAR):
                report.append(f"     {lab['placed']:32} {str(lab['tile']):18} {lab.get('text', '')!r}")

    # World Map picture: each label is an area of gamearea.mes
    wm = next(m for m in base if m.get('typemap') == 'overworld')
    wm_labels = []
    for lb in wm['labels']:
        tile = next((world.areas[k] for k in (norm(lb.get('targetMapFilename')), norm(lb.get('text'))) if k in world.areas), None)
        out = {k: v for k, v in lb.items() if k not in ('x', 'y', 'textX', 'textY')}
        out.update({'tile': list(tile) if tile else None, 'placed': 'gamearea.mes' if tile else 'unplaced', 'screenshot': [lb['x'], lb['y']]})
        wm_labels.append(out)
    report.append(f"\n== {wm['displayName']}: {sum(1 for l in wm_labels if l['tile'])}/{len(wm_labels)} labels at their gamearea.mes tile")

    # arrival spots of every waypoint that travels into a moved place
    travel = []
    for f, vs in dbs.items():
        for var, maps in vs.items():
            for m in maps:
                for i, lb in enumerate(m.get('labels', [])):
                    t = lb.get('targetMapFilename')
                    if t not in fits or 'targetX' not in lb:
                        continue
                    sol, centre = fits[t]
                    # Best: the target's waypoint that leads back here (Tarant's "Bates Mansion" for the mansion's
                    # exit); some stored arrival spots are stale. Next: a target label at the stored spot. Else the fit.
                    back = [(math.hypot(l['screenshot'][0] - lb['targetX'], l['screenshot'][1] - lb['targetY']), l['tile'])
                            for p in places if p['name'] == t for l in p['labels']
                            if l.get('targetMapFilename') == m['displayName'] and l['tile']]
                    near = [(math.hypot(x - lb['targetX'], y - lb['targetY']), pos) for (mn, x, y), pos in tiles_of.items() if mn == t and pos]
                    near = min(near, default=(1e9, None))
                    if back:
                        d, tile = min(back)
                        how = 'waypoint back' + (f' (stored spot was {d:.0f} px away on the screenshot)' if d > 200 else '')
                    elif near[0] <= 40:
                        tile, how = near[1], 'entrance label'
                    elif sol:
                        tile, how = tuple(map(round, predict(sol, lb['targetX'], lb['targetY']))), 'fit'
                    else:
                        tile, how = centre, 'area centre'
                    travel.append({'database': f, 'map': m['displayName'], 'label': i, 'text': lb.get('text'), 'target': t,
                                   'targetTile': list(tile) if tile else None, 'placed': how, 'screenshot': [lb['targetX'], lb['targetY']]})
    kinds = defaultdict(int)
    for x in travel:
        kinds[x['placed'].split(' (')[0]] += 1
    report.append(f'\n== {len(travel)} waypoints arrive in a moved place: ' + ', '.join(f'{k}: {v}' for k, v in sorted(kinds.items())))
    for x in travel:
        if '(' in x['placed']:
            report.append(f"     {x['map']} -> {x['target']}: {x['placed']}")

    # the one exact exit the game stores for a moved place: Bates Mansion's map.jmp leads to (61976, 65664) in Tarant
    jmp = (61976, 65664)
    tar = next((p for p in places if p['name'] == 'Tarant'), None)
    lab = next((l for l in tar['labels'] if l.get('targetMapFilename') == 'Bates Mansion Level 1'), None) if tar else None
    bates = next((x for x in travel if x['map'] == 'Bates Mansion Level 1' and x['target'] == 'Tarant'), None)
    if lab and lab['tile']:
        report.append(f"\nCheck: Tarant's 'Bates Mansion' label at {lab['tile']} ({lab['placed']}); the game's map.jmp exit is "
                      f"{list(jmp)}: {math.hypot(lab['tile'][0] - jmp[0], lab['tile'][1] - jmp[1]):.1f} tiles apart.")
    if bates and bates['targetTile']:
        report.append(f"Check: the mansion's exit arrives at {bates['targetTile']}: "
                      f"{math.hypot(bates['targetTile'][0] - jmp[0], bates['targetTile'][1] - jmp[1]):.1f} tiles from map.jmp.")

    OUT_JS.parent.mkdir(exist_ok=True)
    data = {'source': 'toolbox/atlas/locate_world_labels.py', 'world': 'Arcanum1-024-fixed',
            'note': 'tile = world tile [x, y] (F_LOCATION). The Atlas draws tile (X, Y) at world px (40*(Y-X), 20*(X+Y)).',
            'places': places, 'worldMap': {'name': wm['displayName'], 'labels': wm_labels}, 'travel': travel}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/locate_world_labels.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumWorldLabels = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n', encoding='utf-8')
    report.insert(1, 'Totals: ' + ', '.join(f'{k}: {v}' for k, v in sorted(totals.items())) + f' ({sum(totals.values())} labels)')
    OUT_REPORT.parent.mkdir(exist_ok=True)
    OUT_REPORT.write_text('\n'.join(report) + '\n', encoding='utf-8')
    print('\n'.join(l for l in report if not l.startswith('     ')))
    print(f'\nWrote {OUT_JS.relative_to(PROJECT)} and {OUT_REPORT.relative_to(PROJECT)}')


if __name__ == '__main__':
    main()
