#!/usr/bin/env python3
"""Mine the houses of the world map (data/maps/Arcanum1-024-fixed) for the editor's placeholder houses.

A house is a block of roof cells (every house of the game has a roof; one cell = 4 x 4 tiles): the roof covers the
house's tiles plus two tiles on its NE / NW sides and one on its SW / SE sides, so the house's tiles are the roof's
footprint shrunk by that much - a rectangle, or an L, T, U... shape. The roof blocks whose outline is (mostly) walled
are kept, the walls of the whole map being stitched in WORLD tiles (a house can straddle sectors).

For each house: its wall style, shape, rooms (split by its inner walls), and every object standing in it or in the
yard around it - scenery key and rotation, tile, room, the walls it touches and whether it stands in a doorway. From
those, the tables the generator needs: wall pieces at corners, roof pieces, how objects keep clear of each other,
which objects stand in doorways, how often houses are split into rooms and where; and, tile by tile, the walls, openings
and hearths of every house and its yard (HOUSE_GRIDS: what the wave function collapse of the furniture learns from).
Writes js/editor/sec-house-data.js. toolbox/review_houses.py draws what the generator makes from it.

Usage:  python extract_house_data.py [--objects dump.json] [--save-objects dump.json]
        (needs Playwright + Chromium, like export_sec_maps.py; --objects reuses a dump instead of reading the sectors)
"""
from __future__ import annotations
import argparse, http.server, json, math, re, socketserver, sys, threading
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAPDIR = ROOT / 'data' / 'maps' / 'Arcanum1-024-fixed'
OUT = ROOT / 'js' / 'editor' / 'sec-house-data.js'
SCENERY_MES = ROOT / 'data' / 'art' / 'scenery' / 'scenery.mes'
PORTAL_MES = ROOT / 'data' / 'art' / 'portal' / 'portal.mes'
# wall styles the editor knows how to build a house of (HOUSE_STYLES in sec-house-plan.js)
STYLES = {0, 1, 2, 3, 4, 7, 10, 14, 15, 16, 17, 22, 23, 25, 27, 30, 40}
NB = {0: (-1, 0), 1: (0, 1), 2: (1, 0), 3: (0, -1)}       # edge directions: NE, SE, SW, NW
ALONG = {0: (0, 1), 1: (1, 0), 2: (0, 1), 3: (1, 0)}      # increasing position along a side of that direction
DOOR_PIECES = set(range(21, 34))                          # d3*, d4*, d6* wall pieces
WINDOW_PIECES = set(range(9, 21))                         # w3*, w4*, w5* wall pieces (the portal on the middle ones)
WINDOW_GLASS = {10, 13, 14, 17, 18, 19}                   # ... those middle ones: the window itself; the others its frame
HEARTH = 35                                               # the middle of a hearth (34 | 35 | 36): the fire stands on it
NEAR = 4                                                  # how far (tiles) a thing that goes with another stands from it

HTML = r'''<!doctype html><html><body><script type="module">
(async () => {
  try {
    const real = document.getElementById.bind(document);
    document.getElementById = id => real(id) || document.createElement('div');
    const qs = document.querySelector.bind(document); document.querySelector = s => qs(s) || document.createElement('div');
    const { readSecTileData } = await import('/js/sec/sec-parser.js');
    const { resolveMobPrototype } = await import('/js/proto/proto-resolution.js');
    const cache = new Map(), mask = (1n << 26n) - 1n;
    window.dumpSector = async relPath => {
      const name = relPath.split('/').pop(), id = BigInt(name.replace(/\.sec$/i, ''));
      const sx = Number(id & mask), sy = Number((id >> 26n) & mask);
      const resp = await fetch('/data/maps/Arcanum1-024-fixed/' + relPath.split('/').map(encodeURIComponent).join('/'));
      const d = readSecTileData(await resp.arrayBuffer(), name), out = [];
      for (const o of d.staticObjects) {
        if (o.objType !== 0 && o.objType !== 1 && o.objType !== 3) continue;
        const loc = o.fields.find(f => f.field === 2); if (!loc) continue;
        const raw = BigInt(loc.value), tx = Number(raw & 63n), ty = Number((raw >> 32n) & 63n);
        const aidF = o.fields.find(f => f.field === 1); let aid = aidF ? Number(aidF.value) >>> 0 : null;
        const num = n => { const f = o.fields.find(f => f.field === n); return f ? Number(f.value) | 0 : null; };
        let ox = num(3), oy = num(4);                 // pixel offsets of the sprite from its tile's centre
        if (aid === null || aid === 0xFFFFFFFF || ox === null || oy === null) {   // ...from the prototype
          try {
            const p = await resolveMobPrototype(o, cache), pf = p.decodedProto?.fields || [];
            const pn = n => { const f = pf.find(f => f.field === n); return f ? Number(f.value) | 0 : null; };
            if (aid === null || aid === 0xFFFFFFFF) { const a = pf.find(f => f.field === 1); if (a) aid = Number(a.value) >>> 0; }
            if (ox === null) ox = pn(3);
            if (oy === null) oy = pn(4);
          } catch (_) {}
        }
        out.push([o.objType, sx * 64 + tx, sy * 64 + ty, aid, ox || 0, oy || 0]);
      }
      // the roof grid: one art id per 4 x 4 tiles (16 x 16 cells a sector), in world cells
      const roofs = [];
      if (d.roofArtIds) d.roofArtIds.forEach((raw, i) => { if (((raw >>> 28) & 0xF) === 10) roofs.push([sx * 16 + (i & 15), sy * 16 + (i >> 4), raw >>> 0]); });
      return { err: d.staticObjectError, objs: out, roofs };
    };
    window.ready = true;
  } catch (e) { window.initError = String(e && e.stack || e); }
})();
</script></body></html>'''


def dump_objects() -> dict:
    from playwright.sync_api import sync_playwright

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
        def do_GET(self):
            if self.path.split('?')[0] == '/dump.html':
                b = HTML.encode()
                self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
                return
            return super().do_GET()
        def log_message(self, *a): pass

    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    files = sorted(str(p.relative_to(MAPDIR)).replace('\\', '/') for p in MAPDIR.rglob('*.sec'))
    res = {}
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page()
        pg.goto(f'http://127.0.0.1:{srv.server_address[1]}/dump.html')
        pg.wait_for_function('window.ready || window.initError', timeout=60000)
        if pg.evaluate('window.initError'): raise SystemExit('init error: ' + pg.evaluate('window.initError'))
        for i, f in enumerate(files):
            res[f] = pg.evaluate('f => window.dumpSector(f)', f)
            if i % 100 == 0: print(f'  sector {i}/{len(files)}', file=sys.stderr)
        b.close()
    return res


# The floor under a thing, from its art: for every 4th column of the sprite, the lowest opaque pixel - on the floor, at
# the thing's front edge. [x of the first column, y of each (null: an empty column)], in pixels from the hotspot (the
# tile's centre). The tiles those points fall on, once the sprite is shifted as placed, are the floor it takes.
CONTOUR_STEP = 4
CONTOUR_JS = r'''
async ([parts, step]) => {
  const { loadMobMapArtShared } = await import('/js/objects/map-art-loader.js');
  const out = {};
  for (const [key, rot] of parts) {
    const art = await loadMobMapArtShared(key, 3, null, rot, null);
    if (!art?.canvas) continue;
    const c = art.canvas, W = c.width, H = c.height;
    const px = c.getContext('2d').getImageData(0, 0, W, H).data, ys = [];
    const x0 = (art.hotspotX % step + step) % step;
    for (let x = x0; x < W; x += step) {
      let b = null;
      for (let y = H - 1; y >= 0; y--) if (px[(y * W + x) * 4 + 3] > 128) { b = y - art.hotspotY; break; }
      ys.push(b);
    }
    while (ys.length && ys[ys.length - 1] === null) ys.pop();
    let lead = 0; while (lead < ys.length && ys[lead] === null) lead++;
    out[`${key}:${rot}`] = [x0 - art.hotspotX + lead * step, ...ys.slice(lead)];
  }
  return out;
}
'''


def art_body(contour, ox, oy) -> set:
    """The tiles besides its own a thing with this contour, shifted by (ox, oy) pixels, stands on: those where 4 of its
    sampled bottom points or more fall 0.2 tile or more past a tile's border (a point on the line between two tiles is
    the near one's), within 2 tiles. As bodyOf() in sec-house-plan.js."""
    def snap(f):
        return int(math.copysign(math.floor(abs(f) + .3), f))
    x0, ys, cnt = contour[0], contour[1:], Counter()
    for i, y in enumerate(ys):
        if y is None: continue
        a, h = (x0 + CONTOUR_STEP * i + ox) / 40, (y + oy) / 20
        cnt[(snap((h - a) / 2), snap((a + h) / 2))] += 1
    return {t for t, n in cnt.items() if n >= 4 and t != (0, 0) and max(abs(t[0]), abs(t[1])) <= 2}


def art_contours(parts) -> dict:
    from playwright.sync_api import sync_playwright

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
        def log_message(self, *a): pass

    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page()
        pg.goto(f'http://127.0.0.1:{srv.server_address[1]}/logo.png')
        res = pg.evaluate(CONTOUR_JS, [[list(p) for p in sorted(parts)], CONTOUR_STEP])
        b.close()
    srv.shutdown()
    return res


# ---- object categories (from the art names of scenery.mes): what "a stove", "a bed"... is -------------------------
CATEGORY_RULES = [
    ('decal', r'blood|web|bone|stain|puddle|crack|dirt|debris|g_bone|faint'),
    ('rope', r'rope'),
    ('fixture', r'pipe|grate|vent|manhole|gc_cover|trap_door|trap_door'),
    ('coffin', r'sarcoph|coffin'),
    ('junk', r'junk|cargo|lumber|supplies|cart|plow|crane|hook|tank|spool|bags|cinder'),
    ('trap', r'trap|cage'),
    ('bed', r'bed'),
    ('stove', r'stove|cooker|firpl|fireplace|oven'),
    ('fire', r'campfire|firepit|brazure|brazier|fireflame|torchflame|flame'),
    ('workbench', r'workbench|smithbench|smtihbench|techbench|vendbench|anvil|machine|lab_|control|engine|press|junktable'),
    ('light', r'lantern|lamp|light|candle|torch'),
    ('table', r'table|desk|podium'),
    ('seat', r'chair|couch|bench|throne|stool'),
    ('storage', r'shelf|shelves|dresser|cabinet|cabnet|nightstand|bookcase|bc_|cupboard|wardrobe|safe|chest|coat'),
    ('barrel', r'barrel|keg|stack'),
    ('vessel', r'bucket|milk|pottery|pot|sack|basket|can|jar|urn|vase|bowl|bottle|crate|box'),
    ('wall decor', r'painting|poster|banner|magedecor|wall_|walldecor|symb|shield|sword|axes|gunwall|scimitar|display|clock|mirror|rug|tapestry|hurb|hang|plaque|sign|crest'),
    ('bath', r'bath|tub'),
    ('plant', r'^p_|fern|bush|shr\d|fwd\d|tdpl|plant|flower|grass|reed|weed|tree|stump|log'),
    ('rock', r'rock|stone|rck'),
    ('book', r'book'),
    ('clothes', r'cloth'),
]


def scenery_names() -> dict:
    out = {}
    for line in SCENERY_MES.read_text(encoding='latin1').splitlines():
        m = re.match(r'\{(\d+)\}\{([^}]*)\}', line.strip())
        if m: out[int(m.group(1))] = m.group(2)
    return out


def portal_sets() -> dict:
    """The portal arts by family, from their names in portal.mes ("VilF4bu1" = Village, window 4 wide, its 2nd middle
    piece, variant 1): {family: {kind: [portal numbers of the middle pieces]}}, kind w3 / w4 / w5 for a window, d3 / d4
    for a door (a window's portal number is its key - 1001). The windows of one family and variant are made to go
    together - the same frame, glass, curtains or boards at every width - and so are its doors."""
    sets = defaultdict(dict)
    for line in PORTAL_MES.read_text(encoding='latin1').splitlines():
        m = re.match(r'\{(\d+)\}\{(\w{3})[EF]([345])([ABC])([UD])(\d)\.art', line.strip(), re.I)
        if not m: continue
        key, fam, width, piece = int(m.group(1)), (m.group(2) + m.group(5) + m.group(6)).upper(), int(m.group(3)), 'ABC'.index(m.group(4).upper())
        win = key >= 1001
        kind = ('w' if win else 'd') + str(width)
        if not win and width == 5: continue
        nums = sets[('F:' if win else 'D:') + fam].setdefault(kind, [None] * (width - 2))
        if piece < len(nums): nums[piece] = key - 1001 if win else key
    return {f: {k: v for k, v in sorted(ks.items()) if None not in v} for f, ks in sorted(sets.items())}


def category_of(name: str) -> str:
    n = name.lower().replace('.art', '')
    for cat, rx in CATEGORY_RULES:
        if re.search(rx, n): return cat
    return 'other'


def edge_dir(rot: int) -> int:
    """Walls and portals store their edge as a rotation 1, 3, 5, 7 = NE, SE, SW, NW."""
    return (rot - 1) // 2 if rot % 2 else rot // 2


def components(cells):
    seen, out = set(), []
    for c in cells:
        if c in seen: continue
        stack, comp = [c], []; seen.add(c)
        while stack:
            p = stack.pop(); comp.append(p)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                q = (p[0] + dx, p[1] + dy)
                if q in cells and q not in seen: seen.add(q); stack.append(q)
        out.append(comp)
    return out


def house_tiles(cells: set) -> set:
    """The tiles of a house under a block of roof cells: those whose 4 x 4 box [x-2, x+1] x [y-2, y+1] is roofed."""
    foot = lambda x, y: (x >> 2, y >> 2) in cells
    tiles = set()
    for cx, cy in cells:
        for y in range(cy * 4, cy * 4 + 4):
            for x in range(cx * 4, cx * 4 + 4):
                if all(foot(xx, yy) for xx in range(x - 2, x + 2) for yy in range(y - 2, y + 2)): tiles.add((x, y))
    return tiles


RUGS = range(218, 226)                                    # facadename.mes: Rug1..Rug4 and their flips (3 x 5 / 5 x 3 cells)
OPENING_START = {9: 'w3', 12: 'w4', 16: 'w5', 21: 'd3', 24: 'd4'}   # the first wall piece of a window / door of that width


def read_facades(nums) -> dict:
    """(world x, y) -> (facade number, cell) of the facades `nums` stamped on the map's tiles (a sector's tile array)."""
    import struct
    out = {}
    for p in MAPDIR.rglob('*.sec'):
        try: sid = int(p.stem)
        except ValueError: continue
        b = p.read_bytes(); at = 4 + struct.unpack_from('<I', b, 0)[0] * 0x30
        if at + 16384 > len(b): continue
        bx, by = (sid & 0x3FFFFFF) * 64, (sid >> 26) * 64
        for i, raw in enumerate(struct.unpack_from('<4096I', b, at)):
            if raw >> 28 != 11: continue
            num = ((raw >> 17) & 0xFF) | ((raw >> 19) & 0x100)
            if num in nums: out[(bx + (i & 63), by + (i >> 6))] = (num, (raw >> 1) & 0x3FF)
    return out


# ---- what each premises is: an inn, a store, a warehouse... ------------------------------------------------------------
# By its sign first (hung outside, within 3 tiles: the nearest premises' - a row of shops has one each), else by what is
# in it. The order is the order of the editor's Generate list.
KINDS = [
    ('home', 'House'), ('dorm', 'Dormitory'), ('inn', 'Inn'), ('tavern', 'Tavern'), ('store', 'General store'),
    ('herbalist', 'Herbalist'), ('smith', 'Smithy'), ('tech', 'Mechanic'), ('magic', 'Magic shop'), ('bank', 'Bank'),
    ('museum', 'Museum'), ('hall', 'Hall'), ('temple', 'Temple'), ('study', 'Study / office'), ('workshop', 'Workshop'),
    ('warehouse', 'Warehouse'), ('crypt', 'Crypt'), ('empty', 'Empty')]
SIGN_KIND_RX = re.compile(r'sign', re.I)
SIGN_KINDS = [('inn', r'^inn_sign'), ('bank', r'^bank_sign'), ('smith', r'^armour_sign'), ('tech', r'^(machanic|tech)_sign'),
              ('magic', r'^magic_sign'), ('herbalist', r'^med_sign'), ('store', r'^(general|jeweler)_sign'), ('tavern', r'^bar_sign')]
SMITH_RX = r'^smithbench|^anvil|armordisplay|swordrack|shieldstnd|^wall_sword|helmshelf|swordholder'
TECH_RX = r'^techbench|^techtable|^techcab'


def classify(houses, scenery, names) -> list:
    """The kind (KINDS) of each premises of `houses` (dicts with its tiles)."""
    owner = {}
    for i, h in enumerate(houses):
        for x, y in h['tiles']:
            for dx in range(-3, 4):
                for dy in range(-3, 4):
                    t = (x + dx, y + dy); d = max(abs(dx), abs(dy))
                    if t not in owner or owner[t][0] > d: owner[t] = (d, i)
    signs = defaultdict(set)
    for t, lst in scenery.items():
        if t not in owner: continue
        for k, _ in lst:
            n = names.get(k, '').lower()
            for kind, rx in SIGN_KINDS:
                if re.search(rx, n): signs[owner[t][1]].add(kind)
    out = []
    for i, h in enumerate(houses):
        cat, nm = Counter(), Counter()
        for t in h['tiles']:
            for k, _ in scenery.get(t, []):
                c = category_of(names.get(k, '')); cat[c] += 1
                nm[names.get(k, '').lower()] += 1
        has = lambda rx: sum(c for n, c in nm.items() if re.search(rx, n))
        things = sum(c for k, c in cat.items() if k not in ('decal', 'light', 'plant', 'rock', 'fire', 'fixture'))
        beds, seats, tables = cat['bed'], cat['seat'], cat['table']
        stored = cat['barrel'] + cat['vessel'] + cat['junk'] + cat['storage'] + cat['trap']
        # (hanging herbs, and their tables and shelves - the herb shops hang the general sign)
        herbs = has(r'^hanghurb') and 2 * has(r'^hanghurb') + has(r'^hurbtable|^hurbshelf') >= 5
        # a sign whose wares are in it: of two signs hung near, the one this premises sells (the other is the next shop's)
        # (how many of its wares: of two signs with wares in, the one with the more - a magic shop that also sells armour)
        wares = {'inn': beds >= 2 and beds, 'bank': has(r'file_cabinet|safe'), 'smith': has(SMITH_RX), 'tech': has(TECH_RX),
                 'magic': has(r'^mage|crystal|pedestal')}
        s = [k for k, _ in SIGN_KINDS if k in signs.get(i, set())]
        sold = [k for k in s if wares.get(k, 1)]
        kind = max(sold, key=lambda k: (wares.get(k, 0), -s.index(k))) if sold else s[0] if s else None
        if 'inn' in sold: kind = 'inn'
        if kind == 'store' and herbs: kind = 'herbalist'
        if kind: pass
        elif things <= 1 and not beds: kind = 'empty'
        elif cat['coffin'] >= 4 and not beds: kind = 'crypt'
        elif has(r'red_rope') >= 4: kind = 'museum'
        elif has(r'book_on_pedestal|god_of') >= 2: kind = 'temple'
        elif not beds and seats >= 10 and seats >= 3 * tables: kind = 'hall'
        elif has(TECH_RX) >= 2 and beds <= 2: kind = 'tech'
        elif has(r'^smithbench|^anvil|armordisplay|swordrack|shieldstnd') >= 2: kind = 'smith'   # (not swords on a wall: barracks have those)
        elif has(r'^mage|crystal_ball') >= 3: kind = 'magic'
        elif herbs: kind = 'herbalist'
        elif not beds and (cat['workbench'] >= 3 or cat['workbench'] >= .5 * things): kind = 'workshop'
        elif (not beds and stored >= .5 * things) or (beds <= 1 and len(h['tiles']) >= 200 and stored >= .7 * things): kind = 'warehouse'   # (a watchman's bed)
        elif not beds: kind = 'study'
        elif beds >= 3 and beds >= .35 * things and beds > tables: kind = 'dorm'
        else: kind = 'home'
        out.append(kind)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--objects', help='reuse a dump (json) of the sectors'); ap.add_argument('--save-objects', help='save the dump')
    args = ap.parse_args()
    if args.objects: data = json.loads(Path(args.objects).read_text())
    else:
        print('reading the sectors...', file=sys.stderr); data = dump_objects()
        if args.save_objects: Path(args.save_objects).write_text(json.dumps(data))
    names = scenery_names()

    walls, portals, scenery, roofs = {}, {}, defaultdict(list), {}
    shift = {}                                    # (x, y, key, rotation) -> its sprite's pixel offset [ox, oy]
    for v in data.values():
        for t, x, y, aid, *off in v['objs']:
            if aid is None: continue
            rot = (aid >> 11) & 7
            if t == 0: walls[(x, y, edge_dir(rot))] = ((aid >> 20) & 0xFF, (aid >> 14) & 0x3F)    # structure, piece
            elif t == 1: portals.setdefault((x, y, edge_dir(rot)), []).append((aid >> 19) & 0x1FF)
            elif t == 3:
                k = ((aid >> 6) & 0x1F) * 1000 + ((aid >> 19) & 0x1FF)
                scenery[(x, y)].append((k, rot))
                shift.setdefault((x, y, k, rot), list(off[:2]) if off else [0, 0])
        for cx, cy, raw in v.get('roofs', []): roofs[(cx, cy)] = raw
    offs_of = lambda x, y, sig: [shift[(x, y, *map(int, p.split(':')))] for p in sig.split('|')]
    wall_between = lambda x, y, d: (x, y, d) in walls or (x + NB[d][0], y + NB[d][1], (d + 2) % 4) in walls
    wall_at = lambda x, y, d: walls.get((x, y, d)) or walls.get((x + NB[d][0], y + NB[d][1], (d + 2) % 4))
    # the wall styles whose pieces 34 | 35 | 36 are a hearth: those a fire burns on somewhere on the map (elsewhere they
    # are a timber frame, a bookcase niche... - a wall like the others)
    is_fire = lambda k: category_of(names.get(k, '')) == 'fire'
    hearth_styles = sorted({w[0] for (x, y, d), w in walls.items() if w[1] == HEARTH and any(is_fire(k) for k, _ in scenery.get((x, y), []))})
    is_hearth = lambda w: w is not None and w[1] in (HEARTH - 1, HEARTH, HEARTH + 1) and w[0] in hearth_styles

    def feature(x, y, d):
        """What the wall on edge d of tile (x, y) is: _ none, w a window (x its frame), d a door, h a hearth (k its
        sides), n a plain wall next to a window's frame, o another piece (37-45...), . a plain wall."""
        w = wall_at(x, y, d)
        if not w: return '_'
        p = w[1]
        if p in WINDOW_GLASS: return 'w'
        if p in WINDOW_PIECES: return 'x'
        if p in DOOR_PIECES: return 'd'
        if p == HEARTH and is_hearth(w): return 'h'
        if p in (HEARTH - 1, HEARTH + 1) and is_hearth(w): return 'k'
        if p > 8: return 'o'
        for s in (-1, 1):
            w2 = wall_at(x + s * ALONG[d][0], y + s * ALONG[d][1], d)
            if w2 and w2[1] in WINDOW_PIECES: return 'n'
        return '.'

    corner_good, corner_all = Counter(), Counter()
    for (cx, cy), raw in roofs.items():
        for dx, dy in ((1, 1), (-1, -1), (1, -1), (-1, 1)):
            if (cx + dx, cy) in roofs and (cx, cy + dy) in roofs and (cx + dx, cy + dy) not in roofs:
                n = (raw >> 19) & 0x1FF; corner_all[n] += 1; corner_good[n] += ((raw >> 14) & 31) in (3, 5, 6)
    # (an inner corner without an inside piece is mostly two houses side by side: a roof the game closes a corner with
    # twice has the art for it)
    concave_roofs = sorted(n for n in corner_all if corner_good[n] >= 2)
    # the roof pieces, by which of the 8 cells around have the same roof: counted over every cell of the roofs that close
    # inner corners (the ones a generated L, T or U gets), not only those of the house blocks - a few hundred cells would
    # leave most masks to a tie, and a house's arm end beside another house's roof would turn into a corner piece
    roof_votes = defaultdict(Counter)
    for (cx, cy), raw in roofs.items():
        n = (raw >> 19) & 0x1FF
        if n not in concave_roofs: continue
        m = 0
        for i, (dx, dy) in enumerate(((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))):
            r2 = roofs.get((cx + dx, cy + dy))
            if r2 is not None and (r2 >> 19) & 0x1FF == n: m |= 1 << i
        roof_votes[m][f'{(raw >> 14) & 0x1F},{raw & 1}'] += 1
    houses, piece_votes = [], defaultdict(Counter)
    style_roofs = defaultdict(Counter)    # wall style -> roof number -> houses roofed with it
    inner_doors = defaultdict(Counter)
    junction = Counter()
    all_house_tiles = set()                # every house's tiles: the yard around one never takes another's
    for comp in components(set(roofs)): all_house_tiles |= house_tiles(set(comp))
    feat_base = Counter()                 # walled edges of the houses' tiles and their ring, by feature
    hearth_where = Counter()              # hearths by side (0..3) and o(utline) / i(nner wall)
    hearths_in_room = Counter()           # (hearths in a room, its tiles // 40)
    rug_at = read_facades(set(RUGS)); rug_art = Counter()
    blocks, samples = [], []              # the houses (roof blocks) and their premises (HOUSE_SAMPLES)
    portal_between = lambda x, y, d: bool(portals.get((x, y, d)) or portals.get((x + NB[d][0], y + NB[d][1], (d + 2) % 4)))

    def premises_sample(P, style, shape, room_of, rooms, per_room, doorway, hfront):
        """One premises (tiles P of a house of wall style `style`) as a sample: its rooms, the things in it and in the yard
        ring around it, its hearths, rugs and grid of tile contexts - all from the back corner of its bounding box."""
        x0 = min(x for x, _ in P); y0 = min(y for _, y in P)
        W = max(x for x, _ in P) - x0 + 1; H = max(y for _, y in P) - y0 + 1
        mine = sorted({room_of[t] for t in P}); local = {r: i for i, r in enumerate(mine)}
        boxes = []
        for r in mine:
            tiles = rooms[r]; rx0 = min(x for x, _ in tiles); ry0 = min(y for _, y in tiles)
            boxes.append([rx0 - x0, ry0 - y0, max(x for x, _ in tiles) - rx0 + 1, max(y for _, y in tiles) - ry0 + 1, len(tiles), per_room[r]])
        ring = {(x + dx, y + dy) for (x, y) in P for dx in (-1, 0, 1) for dy in (-1, 0, 1)} - P - all_house_tiles
        units = []
        for (x, y) in sorted(P | ring):
            here = scenery.get((x, y))
            if not here: continue
            sig = '|'.join(sorted(f'{k}:{r}' for k, r in here))
            mask = sum(1 << d for d in range(4) if wall_between(x, y, d))
            units.append([sig, x - x0, y - y0, local[room_of[(x, y)]] if (x, y) in P else -1, mask, 1 if (x, y) in doorway else 0,
                          ''.join(feature(x, y, d) for d in range(4)), hfront[(x, y)] + 1 if (x, y) in hfront else 0, offs_of(x, y, sig)])
        # the grid of tile contexts over the bounding box and one tile around it (the yard ring): three hex digits per tile,
        # bit 0-3 the walls on the tile's edges, 16 a door / window on one of them, 32 a hearth, 64 a tile of the house,
        # 128 a tile of a doorway, 256 a tile on or before a hearth; "xxx" a tile that is neither the house nor its ring
        grid = []
        for y in range(y0 - 1, y0 + H + 1):
            row = []
            for x in range(x0 - 1, x0 + W + 1):
                if (x, y) not in P and (x, y) not in ring: row.append('xxx'); continue
                feats = [feature(x, y, d) for d in range(4)]
                v = sum(1 << d for d in range(4) if wall_between(x, y, d))
                if any(f in 'wxd' for f in feats): v |= 16
                if any(f in 'hk' for f in feats): v |= 32
                if (x, y) in P: v |= 64
                if (x, y) in doorway: v |= 128
                if (x, y) in hfront: v |= 256
                row.append(f'{v:03x}')
            grid.append(''.join(row))
        # its rugs (whole ones: all 15 cells of one, on its tiles - every rug of the game is): [facade, x, y of its back corner]
        rugs = []
        for blob in components({t for t in P if t in rug_at}):
            nums = {rug_at[t][0] for t in blob}
            if len(blob) != 15 or len(nums) != 1: continue
            rugs.append([nums.pop(), min(x for x, _ in blob) - x0, min(y for _, y in blob) - y0]); rug_art[rugs[-1][0]] += 1
        return dict(s=style, W=W, H=H, shape=shape, rooms=boxes, units=units, hc=sum(per_room[r] for r in mine), grid='/'.join(grid),
                    rugs=rugs, tiles=P, x0=x0, y0=y0)
    run_patterns = defaultdict(Counter)   # (F / B side, run length) -> (its openings as a pattern, style) -> runs
    opening_arts = defaultdict(lambda: defaultdict(Counter))   # style -> side + kind ("Fw3") -> portal numbers -> openings
    for comp in components(set(roofs)):
        cells = set(comp)
        T = house_tiles(cells)
        if not T: continue
        per = lambda x, y, d: (x, y) in T and (x + NB[d][0], y + NB[d][1]) not in T
        edges = [(x, y, d) for (x, y) in T for d in range(4) if per(x, y, d)]
        have = [walls[e] for e in edges if e in walls]
        if len(have) < .8 * len(edges): continue                   # a roof over something that is not walled
        style = Counter(w[0] for w in have).most_common(1)[0][0]
        if style not in STYLES: continue
        style_roofs[style][Counter((roofs[c] >> 19) & 0x1FF for c in cells).most_common(1)[0][0]] += 1
        x0 = min(x for x, _ in T); y0 = min(y for _, y in T); W =max(x for x, _ in T) - x0 + 1; H = max(y for _, y in T) - y0 + 1
        cx0 = min(c[0] for c in cells); cy0 = min(c[1] for c in cells)
        cw = max(c[0] for c in cells) - cx0 + 1; ch = max(c[1] for c in cells) - cy0 + 1
        rect = len(cells) == cw * ch
        shape = None if rect else '/'.join(''.join('1' if (cx0 + i, cy0 + j) in cells else '0' for i in range(cw)) for j in range(ch))
        # the pieces of the outline, by what is at either end of the edge's tile along its side
        for (x, y, d) in edges:
            ends = []
            for sgn in (-1, 1):
                ax, ay = x + sgn * ALONG[d][0], y + sgn * ALONG[d][1]
                ends.append('X' if (ax, ay) not in T else '-' if per(ax, ay, d) else 'V')
                if ends[-1] == 'V':        # a concave corner: is the line on into the house walled (a divider)?
                    junction[wall_between(ax, ay, d)] += 1
            if (x, y, d) in walls: piece_votes[f'{d}{ends[0]}{ends[1]}'][walls[(x, y, d)][1]] += 1
        # the openings of each straight run of the outline, as a pattern (one letter a tile: . wall, W w a window, D d a
        # door - the capital on its first tile), and the portal numbers of each kind of opening (side F front = SE / SW)
        for d in range(4):
            line = (lambda t: t[0]) if d in (0, 2) else (lambda t: t[1]); pos = (lambda t: t[1]) if d in (0, 2) else (lambda t: t[0])
            by_line = defaultdict(list)
            for (x, y, dd) in edges:
                if dd == d: by_line[line((x, y))].append((x, y))
            for lst in by_line.values():
                lst.sort(key=pos)
                cuts = [i for i in range(1, len(lst)) if pos(lst[i]) != pos(lst[i - 1]) + 1]
                for run in (lst[a:b] for a, b in zip([0] + cuts, cuts + [len(lst)])):
                    side = 'F' if d in (1, 2) else 'B'
                    pcs = [walls.get((x, y, d), (None, None))[1] for x, y in run]
                    pat, i = ['.'] * len(run), 0
                    while i < len(run):
                        kind = OPENING_START.get(pcs[i]); n = int(kind[1]) if kind else 0
                        nums = tuple(nn for x, y in run[i + 1:i + n - 1] for nn in portals.get((x, y, d), [])) if kind else ()
                        if not kind or i + n > len(run) or len(nums) != n - 2: i += 1; continue
                        pat[i:i + n] = [kind[0].upper()] + [kind[0]] * (n - 1)
                        opening_arts[style][side + kind][nums] += 1
                        i += n
                    run_patterns[(side, len(run))][(''.join(pat), style)] += 1
        # rooms: the house's tiles split by every wall between two of them
        room_of, rooms = {}, []
        for t in sorted(T):
            if t in room_of: continue
            idx = len(rooms); stack = [t]; room_of[t] = idx; tiles = []
            while stack:
                p = stack.pop(); tiles.append(p)
                for d in range(4):
                    q = (p[0] + NB[d][0], p[1] + NB[d][1])
                    if q in T and q not in room_of and not wall_between(p[0], p[1], d): room_of[q] = idx; stack.append(q)
            rooms.append(tiles)
        boxes = []
        for tiles in rooms:
            rx0 = min(x for x, _ in tiles); ry0 = min(y for _, y in tiles)
            boxes.append([rx0 - x0, ry0 - y0, max(x for x, _ in tiles) - rx0 + 1, max(y for _, y in tiles) - ry0 + 1])
        # doorways: both tiles of a door (outer or inner), and the doors between rooms
        doorway = set()
        for (x, y) in T:
            for d in range(4):
                w = walls.get((x, y, d))
                if not w or w[1] not in DOOR_PIECES or not portals.get((x, y, d)): continue
                doorway.add((x, y)); doorway.add((x + NB[d][0], y + NB[d][1]))
                if not per(x, y, d):
                    for n in portals[(x, y, d)]:
                        if w[1] == 22: inner_doors[style][('door', n)] += 1
                        elif w[1] == 25: inner_doors[style][('d1', n)] += 1
                        elif w[1] == 26: inner_doors[style][('d2', n)] += 1
        # what stands in the house and in the ring of tiles around it
        ring = {(x + dx, y + dy) for (x, y) in T for dx in (-1, 0, 1) for dy in (-1, 0, 1)} - T - all_house_tiles
        # hearths: the middle piece of each, on a wall of one of the house's tiles; in front of one: the tiles of its
        # three pieces (row 0) and the two rows before them (1, 2) - the nearest row a tile is in
        hc, hfront, per_room = 0, {}, Counter()
        for (x, y) in T:
            for d in range(4):
                w = walls.get((x, y, d))
                if not is_hearth(w): continue
                p = w[1]
                if p == HEARTH: hc += 1; hearth_where[f'{d}{"o" if per(x, y, d) else "i"}'] += 1; per_room[room_of[(x, y)]] += 1
                if p in (HEARTH - 1, HEARTH, HEARTH + 1):
                    for k in range(3):
                        t = (x - k * NB[d][0], y - k * NB[d][1])
                        if t in T and room_of.get(t) == room_of[(x, y)]: hfront[t] = min(k, hfront.get(t, 9))
        for (x, y) in T | ring:
            for f in feature(x, y, 0) + feature(x, y, 1) + feature(x, y, 2) + feature(x, y, 3):
                if f != '_': feat_base[f] += 1
        # dividers of a rectangular house (for the room-split statistics)
        dividers = []
        if rect:
            lines = defaultdict(set)
            for (x, y) in T:
                for d in (0, 3):
                    q = (x + NB[d][0], y + NB[d][1])
                    if q in T and wall_between(x, y, d): lines[('V' if d == 0 else 'H', (x - x0) if d == 0 else (y - y0))].add((y - y0) if d == 0 else (x - x0))
            dividers = [[ax, k, len(v)] for (ax, k), v in sorted(lines.items())]
        if hc:
            for i in range(len(rooms)): hearths_in_room[(min(len(rooms[i]) // 40, 4), per_room[i])] += 1
        blocks.append(dict(s=style, W=W, H=H, shape=shape, rooms=boxes, dividers=dividers, rect=rect))
        # the premises under the roof: its rooms joined by doors - a row of shops under one roof is a shop, a shop, an inn...
        # each with its own door to the street. A room with no door out (a back room reached some other way, a closet) goes
        # with the premises it shares the most wall with. Each is a sample of its own (HOUSE_SAMPLES), of its kind.
        prem = {}
        for t in sorted(T):
            if t in prem: continue
            i = len(set(prem.values())); stack = [t]; prem[t] = i
            while stack:
                x, y = stack.pop()
                for d in range(4):
                    q = (x + NB[d][0], y + NB[d][1]); w = wall_at(x, y, d)
                    if q in T and q not in prem and (w is None or (w[1] in DOOR_PIECES and portal_between(x, y, d))): prem[q] = i; stack.append(q)
        while True:
            ids = set(prem.values())
            outer = {prem[(x, y)] for x, y, d in edges if (walls.get((x, y, d)) or (0, 0))[1] in DOOR_PIECES and portal_between(x, y, d)}
            shut = [i for i in sorted(ids) if i not in outer]
            if len(ids) < 2 or not shut: break
            touch = Counter()
            for (x, y), i in prem.items():
                if i != shut[0]: continue
                for d in range(4):
                    q = (x + NB[d][0], y + NB[d][1])
                    if q in prem and prem[q] != i: touch[prem[q]] += 1
            if not touch: break
            into = touch.most_common(1)[0][0]
            for t, i in prem.items():
                if i == shut[0]: prem[t] = into
        parts = defaultdict(set)
        for t, i in prem.items(): parts[i].add(t)
        for P in parts.values():
            samples.append(premises_sample(P, style, shape if len(parts) == 1 else None, room_of, rooms, per_room, doorway, hfront))

    print(f'{len(blocks)} roofed houses of the {len(STYLES)} styles; {sum(h["rect"] for h in blocks)} rectangular; {len(samples)} premises', file=sys.stderr)
    houses = samples
    kinds = classify(houses, scenery, names)
    for h, k in zip(houses, kinds): h['kind'] = k
    sign_keys = sorted(k for k in {k for lst in scenery.values() for k, _ in lst} if SIGN_KIND_RX.search(names.get(k, '')) and not re.search(r'road', names.get(k, ''), re.I))

    # categories of the keys that occur, and of the units (a unit holding several things: their categories joined)
    keys = {int(p.split(':')[0]) for h in houses for u in h['units'] for p in u[0].split('|')}
    cat = {k: category_of(names.get(k, '')) for k in keys}
    unit_cat = lambda sig: '+'.join(sorted({cat[int(p.split(':')[0])] for p in sig.split('|')}))
    # clearance: the offsets (within 2 tiles) at which other things stand around a thing of each category
    near, doorway_rate = defaultdict(set), defaultdict(lambda: [0, 0])
    for h in houses:
        us = [u for u in h['units'] if unit_cat(u[0]) != 'decal']
        for u in h['units']:
            c = unit_cat(u[0]); doorway_rate[c][0] += u[5]; doorway_rate[c][1] += 1
        for u in us:
            for v in us:
                if u is v: continue
                dx, dy = v[1] - u[1], v[2] - u[2]
                if max(abs(dx), abs(dy)) <= 2: near[unit_cat(u[0])].add(f'{dx},{dy}')
    split = defaultdict(lambda: [0, 0]); cuts = defaultdict(Counter)
    for h in blocks:
        if not h['rect']: continue
        L = max(h['W'], h['H']); split[L][0] += 1; split[L][1] += len(h['rooms']) > 1
        for ax, k, n in h['dividers']:
            across, along = (h['H'], h['W']) if ax == 'V' else (h['W'], h['H'])
            if n == across and along == L: cuts[L][k] += 1
    doors = {}
    for s, cnt in inner_doors.items():
        best = lambda tag: max(((n, c) for (t, n), c in cnt.items() if t == tag), key=lambda q: q[1], default=(None, 0))[0]
        if best('door') is not None:
            doors[s] = {'door': best('door'), 'double': [best('d1'), best('d2')] if best('d1') is not None and best('d2') is not None else None}

    # walls: what kind of wall a thing hangs on, counted - a painting on plain walls, never on a window; a shop sign
    # beside a door... Per key when it is seen hung often enough, else per category.
    # A thing hung on a wall is judged by that wall alone (a painting in a corner beside a window is not "on" it): the
    # edges a key at a rotation has a wall on in 80 % of its instances (HOUSE_ATTACH); a free-standing thing, by all.
    part_walls = defaultdict(lambda: [0, Counter()])
    for h in houses:
        for u in h['units']:
            for part in u[0].split('|'):
                part_walls[part][0] += 1
                for d in range(4):
                    if u[4] >> d & 1: part_walls[part][1][d] += 1
    # ...counted over the whole map (a thing is drawn for one wall: a shelf facing SW hangs on the NE wall wherever it is)
    map_walls = defaultdict(lambda: [0, Counter()])
    for (x, y), lst in scenery.items():
        for k, r in lst:
            p = f'{k}:{r}'
            if p not in part_walls: continue
            map_walls[p][0] += 1
            for d in range(4):
                if wall_between(x, y, d): map_walls[p][1][d] += 1
    attach = {p: sum(1 << d for d, c in cnt.items() if c >= .6 * n) for p, (n, cnt) in map_walls.items()}
    # how far the wall it hangs on goes on, on either side (along the wall; 0..3 tiles): a painting is wider than its
    # tile, and is never hung where the wall ends beside it. Per thing, what 90 % of its instances have, each side.
    along_dir = lambda d, s: (1 if d in (0, 2) else 2) if s > 0 else (3 if d in (0, 2) else 0)
    span_obs = defaultdict(lambda: ([], []))
    for (x, y), lst in scenery.items():
        for k, r in lst:
            p = f'{k}:{r}'
            if not attach.get(p): continue
            for d in range(4):
                if not attach[p] >> d & 1 or not wall_between(x, y, d): continue
                for si, s in enumerate((-1, 1)):
                    n = 0
                    while n < 3:
                        tx, ty = x + s * (n + 1) * ALONG[d][0], y + s * (n + 1) * ALONG[d][1]
                        if not wall_between(tx, ty, d) or wall_between(tx - s * ALONG[d][0], ty - s * ALONG[d][1], along_dir(d, s)): break
                        n += 1
                    span_obs[p][si].append(n)
    def need(vals):
        vals = sorted(vals)
        return vals[int(.1 * len(vals))] if vals else 0
    span = {p: [need(a), need(b)] for p, (a, b) in span_obs.items() if len(a) >= 3 and (need(a) or need(b))}

    # outdoor things (trees, bushes...) and indoor ones: the share of a thing's instances on the map that are under a
    # roof - under 10 %: never put inside a house; over 90 %: never in a yard
    under_roof = set()
    for comp in components(set(roofs)): under_roof |= house_tiles(set(comp))
    indoor = defaultdict(lambda: [0, 0])
    for (x, y), lst in scenery.items():
        for k, _ in lst: indoor[k][0] += (x, y) in under_roof; indoor[k][1] += 1
    # (a thing seen fewer than 5 times: as the things of its category are - a boulder is a rock)
    cat_in = defaultdict(lambda: [0, 0])
    for k, (i, n) in indoor.items():
        c = cat.get(k) or category_of(names.get(k, '')); cat_in[c][0] += i; cat_in[c][1] += n
    def share(k):
        i, n = indoor[k]
        if n >= 5: return i / n
        c = cat_in[cat.get(k) or category_of(names.get(k, ''))]
        return c[0] / max(1, c[1])
    outdoor_only = sorted(k for k in indoor if share(k) < .1 and k in cat)
    # one of a kind: what the whole map has once (the museum's stuffed cow behind its ropes) is no furniture to copy
    unique = sorted(k for k, (i, n) in indoor.items() if n == 1 and k in cat)
    indoor_only = sorted(k for k, (i, n) in indoor.items() if n >= 5 and i > .9 * n and k in cat)

    # hearths: how far (along their wall) the nearest wall across it is - the end of the room or an inner wall - from the
    # middle of the hearth: its chimney is wider than its three pieces
    hearth_room = []
    for (x, y, d), w in walls.items():
        if w[1] != HEARTH or not is_hearth(w) or (x, y) not in under_roof: continue
        best = 9
        for s in (-1, 1):
            k, px, py = 0, x, y
            while k < 8:
                if wall_between(px, py, along_dir(d, s)): break
                px, py = px + s * ALONG[d][0], py + s * ALONG[d][1]; k += 1
                if not wall_between(px, py, d): break
            best = min(best, k)
        hearth_room.append(best)
    hearth_gap = Counter(hearth_room)
    # two hearths on the same wall: how far apart (tiles between their middles, along it)
    h35 = [(x, y, d) for (x, y, d), w in walls.items() if w[1] == HEARTH and is_hearth(w) and (x, y) in under_roof]
    line_of = lambda x, y, d: (d, x if d in (0, 2) else y)
    pos_of = lambda x, y, d: y if d in (0, 2) else x
    by_line = defaultdict(list)
    for x, y, d in h35: by_line[line_of(x, y, d)].append(pos_of(x, y, d))
    hearth_apart = [b - a for ps in by_line.values() for a, b in zip(sorted(ps), sorted(ps)[1:])]
    seen_key, seen_cat = defaultdict(Counter), defaultdict(Counter)
    for h in houses:
        for u in h['units']:
            for part in u[0].split('|'):
                k = int(part.split(':')[0])
                if not attach[part]: continue
                # the kind of the wall it hangs on: the most particular of its edges' (a corner of plain walls is ".")
                fs = [u[6][d] for d in range(4) if attach[part] >> d & 1 and u[6][d] != '_']
                f = next((g for g in 'hkwxdon' if g in fs), '.')
                seen_key[k][f] += 1; seen_cat[cat[k]][f] += 1
    wall_feats = {'key': {str(k): dict(sorted(o.items())) for k, o in sorted(seen_key.items()) if sum(o.values()) >= 4},
                  'cat': {c: dict(sorted(o.items())) for c, o in sorted(seen_cat.items())}}
    # in front of a hearth: of the things of each category in the houses that have one, [how many stand there, all]
    hearth_front = defaultdict(lambda: [0, 0, 0, 0])
    for h in houses:
        if not h['hc']: continue
        for u in h['units']:
            if u[3] < 0: continue
            c = unit_cat(u[0])
            if u[7]: hearth_front[c][u[7] - 1] += 1
            hearth_front[c][3] += 1

    # footprints. A thing hung on a wall (a painting, a lantern, a wall shelf: by its name) may hang above furniture; the
    # things on the floor keep out of each other's room. Around a thing ("key:rotation"), the offsets (within 2 tiles) at
    # which others of its sort (on the floor / on the walls) have stood on the whole map - those seen often enough: at
    # least twice and in 5 % of its instances (once, for a thing seen fewer than 10 times). Elsewhere is its own room:
    # a bed's other half, the front of a cupboard.
    def hung(k):
        n = names.get(k, '').lower()
        if re.search(r'rack|display|stand|holder|statue|rug|table', n): return False
        return all_cat_(k) == 'wall decor' or bool(re.search(r'hang|wall|torch|sconce|^hurbshelf|^shelf\d*_[lr]', n))
    all_cat_ = lambda k: cat.get(k) or category_of(names.get(k, ''))
    is_decal = lambda k: all_cat_(k) == 'decal'
    house_parts = {p for h in houses for u in h['units'] for p in u[0].split('|')}
    by_part = defaultdict(list)
    for (x, y), lst in scenery.items():
        for k, r in lst:
            if f'{k}:{r}' in house_parts: by_part[(k, r)].append((x, y))
    # how wide (pixels) each thing on the floor is, from its art: what may stand where only a small thing ever did
    floor_kr = {(k, r) for lst in scenery.values() for k, r in lst if not is_decal(k) and not hung(k)}
    raw_contours = art_contours(floor_kr)
    width = {p: CONTOUR_STEP * (len(c) - 1) for p, c in raw_contours.items()}
    floor_at = {}
    for t, lst in scenery.items():
        ws = [width.get(f'{k}:{r}', 0) for k, r in lst if not is_decal(k) and not hung(k)]
        if ws: floor_at[t] = max(ws)
    wall_at_ = {t: 0 for t, lst in scenery.items() if any(hung(k) for k, _ in lst)}
    # (what stands on the other side of a wall - in the next room, outside - is not beside it: both L-shaped paths there
    # cross a wall)
    STEP = {(1, 0): 2, (-1, 0): 0, (0, 1): 1, (0, -1): 3}
    def walled_off(x, y, dx, dy):
        def path_crosses(first_x):
            cx, cy = x, y
            moves = ([(1 if dx > 0 else -1, 0)] * abs(dx) + [(0, 1 if dy > 0 else -1)] * abs(dy)) if first_x else \
                    ([(0, 1 if dy > 0 else -1)] * abs(dy) + [(1 if dx > 0 else -1, 0)] * abs(dx))
            for mx, my in moves:
                if wall_between(cx, cy, STEP[(mx, my)]): return True
                cx, cy = cx + mx, cy + my
            return False
        return path_crosses(True) and path_crosses(False)
    # ...each offset with the width of the widest thing that stood there (its 2nd widest, when seen 5 times or more)
    def offsets(pts, occupied):
        c = defaultdict(list)
        for x, y in pts:
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    if (dx or dy) and (x + dx, y + dy) in occupied and not walled_off(x, y, dx, dy): c[f'{dx},{dy}'].append(occupied[(x + dx, y + dy)])
        need = 1 if len(pts) < 10 else max(2, .05 * len(pts))
        return {o: sorted(w)[-2 if len(w) >= 5 else -1] for o, w in sorted(c.items()) if len(w) >= need}
    foot = {'floor': {}, 'wall': {}}
    key_pts = defaultdict(list)
    for (k, r), pts in by_part.items():
        if is_decal(k): continue
        kind = 'wall' if hung(k) else 'floor'
        key_pts[k] += pts
        if len(pts) >= 3: foot[kind][f'{k}:{r}'] = offsets(pts, wall_at_ if kind == 'wall' else floor_at)
    for k, pts in key_pts.items():
        kind = 'wall' if hung(k) else 'floor'
        if len(pts) >= 3: foot[kind][str(k)] = offsets(pts, wall_at_ if kind == 'wall' else floor_at)
    footprints = {**foot, 'hung': sorted(k for k in cat if hung(k))}

    # keys that only stand on a hearth (the fire): counted among the houses that have one
    on_hearth = defaultdict(lambda: [0, 0])
    for h in houses:
        for u in h['units']:
            for k in {int(p.split(':')[0]) for p in u[0].split('|')}: on_hearth[k][0] += 'h' in u[6]; on_hearth[k][1] += 1
    needs = {str(k): 'h' for k, (o, n) in sorted(on_hearth.items()) if n >= 3 and o >= .8 * n}

    # things that go with another (cues with a pool table, a flame with its torch, a glow with its street lamp): a key K
    # of the houses depends on A when 80 % of K's instances on the whole map have an A within NEAR tiles - A being no
    # more than 4 times as common, so a table does not "depend" on the chairs that are everywhere. Of a pair that go
    # with each other, the rarer is the one that depends.
    inst = defaultdict(list)
    for (x, y), lst in scenery.items():
        for k, r in lst: inst[k].append((x, y, r))
    all_cat = lambda k: cat.get(k) or category_of(names.get(k, ''))
    house_keys = set(cat)
    dep = {}
    for k in sorted(house_keys):
        pts = inst[k]
        if len(pts) < 2 or all_cat(k) in ('decal', 'plant'): continue
        near_k = Counter()
        for x, y, _ in pts:
            seen = {a for dy in range(-NEAR, NEAR + 1) for dx in range(-NEAR, NEAR + 1) for a, _ in scenery.get((x + dx, y + dy), []) if a != k}
            for a in seen: near_k[a] += 1
        best = None
        for a, c in near_k.items():
            if c < .8 * len(pts) or all_cat(a) in ('decal', 'plant') or len(inst[a]) > 4 * len(pts): continue
            key = (c / len(pts), -len(inst[a]))
            if best is None or key > best[0]: best = (key, a)
        if best: dep[k] = best[1]
    for k, a in list(dep.items()):
        if dep.get(a) == k and k in dep:
            rarer = min((k, a), key=lambda q: (len(inst[q]), -q))
            dep.pop(a if rarer == k else k, None)
    # around each anchor's instances (60 at most), what depends on it: [anchor rotation, [[dx, dy, unit, walls], ...]] -
    # each dependent thing counted with its nearest anchor only (a rope of a museum's line goes with one pole, not five)
    satellites = {}
    for a in sorted(set(dep.values())):
        anchors = inst[a]
        mine = defaultdict(lambda: defaultdict(list))        # anchor index -> (dx, dy) -> parts
        for k in [k for k, aa in dep.items() if aa == a]:
            for x, y, r in inst[k]:
                best = min(((max(abs(ax - x), abs(ay - y)), i) for i, (ax, ay, _) in enumerate(anchors)), default=None)
                if best and best[0] <= NEAR:
                    ax, ay, _ = anchors[best[1]]
                    mine[best[1]][(x - ax, y - ay)].append(f'{k}:{r}')
        rows = []
        for i, (x, y, r) in enumerate(anchors[:60]):
            sat = [[dx, dy, '|'.join(sorted(parts)), sum(1 << d for d in range(4) if wall_between(x + dx, y + dy, d)),
                    offs_of(x + dx, y + dy, '|'.join(sorted(parts)))]
                   for (dx, dy), parts in sorted(mine[i].items())]
            rows.append([r, sat, shift[(x, y, a, r)]])
        satellites[str(a)] = rows

    # things that go with a KIND of thing rather than one (a lantern's glow with any lantern): a key K of the houses (5
    # instances or more, not depending on one key already) needs a thing of category C (not K) within r tiles (0..2, the
    # least that holds) when 80 % of its instances on the map have one, and no more than 40 % of the houses' tiles do.
    house_tiles_all = sorted(under_roof)
    def share_near(pts, c, r, skip):
        n = 0
        for x, y in pts:
            n += any(all_cat(a) == c and a != skip for dy in range(-r, r + 1) for dx in range(-r, r + 1) for a, _ in scenery.get((x + dx, y + dy), []))
        return n / max(1, len(pts))
    sample = house_tiles_all[::max(1, len(house_tiles_all) // 3000)]
    base = {}
    near_cat = {}
    for k in sorted(house_keys):
        pts = [(x, y) for x, y, _ in inst[k]]
        if len(pts) < 5 or k in dep or all_cat(k) in ('decal', 'plant'): continue
        cats_near = {all_cat(a) for x, y in pts for dy in range(-2, 3) for dx in range(-2, 3) for a, _ in scenery.get((x + dx, y + dy), []) if a != k}
        for c in sorted(cats_near - {'decal', 'plant', 'other'}):
            for r in range(3):
                if share_near(pts, c, r, k) < .8: continue
                if (c, r) not in base: base[(c, r)] = share_near(sample, c, r, None)
                if base[(c, r)] <= .4 and (str(k) not in near_cat or r < near_cat[str(k)][1]): near_cat[str(k)] = [c, r]
                break
    print('near a kind:', {names.get(int(k)): v for k, v in near_cat.items()}, file=sys.stderr)

    # pixel offsets: nearly every thing of the game is shifted from its tile's centre (a bed pushed against its wall, a
    # shelf slid along it). Per "key:rotation" and walls touched (bits as the units'), up to 8 of the offsets it had.
    used_parts = house_parts | {f'{k}:{r}' for k in set(dep) | set(dep.values()) for _, _, r in inst[k]}
    pools = defaultdict(lambda: defaultdict(list))
    for (x, y), lst in sorted(scenery.items()):
        for k, r in lst:
            p = f'{k}:{r}'
            if p in used_parts: pools[p][sum(1 << d for d in range(4) if wall_between(x, y, d))].append(shift[(x, y, k, r)])
    shifts = {p: {str(m): [v[int(i * len(v) / min(8, len(v)))] for i in range(min(8, len(v)))] for m, v in sorted(ms.items())}
              for p, ms in sorted(pools.items())}

    # the floor a thing takes, from its art (CONTOUR_JS) shifted by its offset (art_body). Kept for the things whose game
    # instances bear it out - it crosses a wall in 15 % of them at most (a tree's crown, a candle stand's foot are not
    # the floor they take); for those with fewer than 3 instances, when it crosses none and keeps within a tile of them.
    floor_parts = {p for p in used_parts if not is_decal(int(p.split(':')[0])) and not hung(int(p.split(':')[0]))}
    contours = {}
    for p in sorted(floor_parts):
        c = raw_contours.get(p)
        if not c: continue
        k, r = map(int, p.split(':'))
        pts = [(x, y) for x, y, rr in inst[k] if rr == r]
        bad = tiles = 0; far = False
        for x, y in pts:
            for dx, dy in art_body(c, *shift[(x, y, k, r)]):
                tiles += 1; far |= max(abs(dx), abs(dy)) > 1
                bad += walled_off(x, y, dx, dy)
        if tiles and ((len(pts) >= 3 and bad <= .15 * len(pts)) or (len(pts) < 3 and not bad and not far)): contours[p] = c

    j = lambda o: json.dumps(o, separators=(',', ':'))
    lines = [
        '// GENERATED by toolbox/extract_house_data.py from the roofed houses of data/maps/Arcanum1-024-fixed. Do not edit by hand.',
        '', '// [wall structure, width, depth (tiles of its bounding box), shape (roof cells, rows "/"-separated, 1 = roofed; null =',
        '//  a rectangle), [[room x, y, width, depth], ...], [[unit, x, y, room (-1 = the yard), walls touched (bit per edge',
        '//  NE SE SW NW), in a doorway, what those walls are (per edge NE SE SW NW: see HOUSE_WALL_FEATS), the row before a',
        '//  hearth it is in (1 = on its pieces\' tiles, 2, 3; 0 = none), the pixel offset of each thing], ...], hearths,',
        '//  [[rug facade (HOUSE_RUG_ART), x, y of its back corner], ...], its kind (HOUSE_KINDS)]:',
        '//  x towards the SW side, y towards the SE side, from the bounding box\'s back corner.',
        '// A sample is one premises: a house, or one of the shops (inn...) of a row under one roof, each with its door out.',
        '// A unit is what stands on one tile: "key:rotation" of each thing, "|"-separated.',
        'export const HOUSE_SAMPLES = [']
    for h in houses: lines.append(f"  [{h['s']},{h['W']},{h['H']},{j(h['shape'])},{j(h['rooms'])},{j(h['units'])},{h['hc']},{j(h['rugs'])},{j(h['kind'])}],")
    kind_count = Counter(h['kind'] for h in houses)
    lines += [
        '];', '',
        '// What the premises are, in the order of the editor\'s Generate list: told by their sign (an inn\'s, a smithy\'s...) or by',
        '// what is in them (no bed and mostly barrels: a warehouse; beds for many: a dormitory...). n: the samples of the kind.',
        f'export const HOUSE_KINDS = {j([{"id": k, "name": nm, "n": kind_count[k]} for k, nm in KINDS if kind_count[k]])};', '',
        '// The shops\' signs (scenery keys): one goes with a house of its kind only.',
        f'export const HOUSE_SIGN_KEYS = {j(sign_keys)};', '',
        '// The houses (whole roof blocks) as [wall structure, width, depth, shape (as HOUSE_SAMPLES; null = a rectangle)]: the',
        '// shapes a house of a style and size takes.',
        f'export const HOUSE_SHAPES = {j([[h["s"], h["W"], h["H"], h["shape"]] for h in blocks])};', '',
        '// The tiles of each house of HOUSE_SAMPLES (same order), over its bounding box and one tile around it: rows of',
        '// "/"-separated text, three hex digits a tile - bits 0-3 the walls on its edges (NE SE SW NW), 16 a door or window on',
        '// one of them, 32 a hearth, 64 a tile of the house, 128 a tile of a doorway, 256 a tile on or before a hearth;',
        '// "xxx" neither the house nor its yard ring.',
        'export const HOUSE_GRIDS = [']
    for h in houses: lines.append(f"  {j(h['grid'])},")
    lines += [
        '];', '',
        '// The category of each scenery key (from its art name): the generator counts "stoves", "beds"... not keys.',
        f'export const HOUSE_CATEGORIES = {j({str(k): v for k, v in sorted(cat.items())})};', '',
        '// Around a thing of each category, the offsets (dx,dy within 2 tiles) at which something else has stood in a',
        '// house of the game: anywhere else is too close (a bed\'s neighbours, the space a table takes...).',
        f'export const HOUSE_CLEARANCE = {j({c: sorted(v) for c, v in sorted(near.items())})};', '',
        '// Of the things of each category: [standing in a doorway, all].',
        f'export const HOUSE_DOORWAYS = {j({c: v for c, v in sorted(doorway_rate.items())})};', '',
        '// Wall pieces of a house\'s outline by direction (0..3 = NE SE SW NW) and what is at either end of the wall\'s tile',
        '// along its side: X = the house ends (a corner), - = the side goes on, V = the outline turns into the house.',
        f'export const HOUSE_WALL_PIECES = {j({k: v.most_common(1)[0][0] for k, v in sorted(piece_votes.items())})};', '',
        '// Roof pieces "piece,mirrored" by which of the 8 cells around are roofed (bits: NW N NE W E SW S SE of the cell grid).',
        f'export const HOUSE_ROOF_PIECES = {j({str(k): v.most_common(1)[0][0] for k, v in sorted(roof_votes.items())})};', '',
        '// The roofs (roof numbers) whose art has proper inner-corner pieces (3, 5, 6): where the map has an L-shaped roof of',
        '// that number, at least 60 % of its inner corners use them. Others (the brick parapets) are only ever rectangles, side by',
        '// side - an L of them has a hole in its corner.',
        f'export const HOUSE_CONCAVE_ROOFS = {j(concave_roofs)};', '',
        '// The roofs (roof numbers) the houses of each wall style have, with how many houses: the roof that goes with the walls.',
        f'export const HOUSE_STYLE_ROOFS = {j({str(s): dict(c.most_common()) for s, c in sorted(style_roofs.items())})};', '',
        '// Rectangular houses: share split into rooms by longest side, and where the cut falls (tile, multiple of 4);',
        '// other shapes: the share of the inner corners whose line on into the house is walled.',
        f'export const HOUSE_SPLIT = {j({"p": {L: round(v[1] / v[0], 2) for L, v in sorted(split.items())}, "cut": {L: dict(sorted(c.items())) for L, c in sorted(cuts.items())}, "junction": round(junction[True] / max(1, sum(junction.values())), 2)})};', '',
        '// Portal numbers of the doors between two rooms, per wall style: a single door and the two halves of a double one.',
        f'export const HOUSE_INNER_DOORS = {j(doors)};', '',
        '// The openings of the outline: `runs` - per side (F front = SE / SW, B back) and length of a straight run of wall,',
        '// the runs of the houses as [pattern, wall style, runs] (a letter a tile: . wall, W w a window, D d a door, the',
        '// capital on its first tile: "..Wwwww.." is a 5-wide window); `arts` - per wall style, side and kind (w3 = a window',
        '// 3 wide... d4 = a double door), the portal numbers of its middle pieces as the houses have them, with how many.',
        f'export const HOUSE_OPENINGS = {j({"runs": {f"{s}{n}": [[p, st, c] for (p, st), c in cnt.most_common()] for (s, n), cnt in sorted(run_patterns.items())}, "arts": {str(st): {k: [[list(nums), c] for nums, c in cnt.most_common()] for k, cnt in sorted(kinds.items())} for st, kinds in sorted(opening_arts.items())}})};', '',
        '// The portal arts by family and variant (portal.mes names; "F:VILU1" the Village windows, variant 1, "D:" doors):',
        '// per kind of opening, the portal numbers of its middle pieces. A house keeps to one family for its windows and one',
        '// for its doors - they are drawn for one another.',
        f'export const HOUSE_PORTAL_SETS = {j(portal_sets())};', '',
        '// The rugs (facade numbers): how many of the houses\' rugs are of each.',
        f'export const HOUSE_RUG_ART = {j({str(k): c for k, c in sorted(rug_art.items())})};', '',
        '// The kind of wall a thing hangs on (. plain, w window or its frame, n plain next to a window, d door or its frame,',
        '// h hearth, k its sides, o other), counted in the houses: per scenery key, else per category.',
        f'export const HOUSE_WALL_FEATS = {j(wall_feats)};', '',
        '// The edges ("key:rotation") a thing hangs on: those it has a wall on in 60 % of its instances on the map (bit per edge).',
        '// Missing: a free-standing thing.',
        f'export const HOUSE_ATTACH = {j({p: m for p, m in sorted(attach.items()) if m})};', '',
        '// In the houses with a hearth, of the things of each category inside: [standing on the tiles of a hearth\'s three',
        '// pieces, on the row before them, on the next row, all].',
        f'export const HOUSE_HEARTH_FRONT = {j({c: v for c, v in sorted(hearth_front.items())})};', '',
        '// Footprints: around a thing on the floor (floor) or hung on a wall (wall; the keys hung: hung), by "key:rotation"',
        '// else by key, the offsets "dx,dy" within 2 tiles at which others of its sort have stood on the map often enough,',
        '// with the width (px) of the widest of them (the 2nd widest when seen 5 times or more; 0 on walls); nothing of its',
        '// sort is put at any other (it is the thing\'s own room), nor wider. Hung things may hang above floor things.',
        f'export const HOUSE_FOOTPRINTS = {j(footprints)};', '',
        '// How far the wall a thing hangs on goes on beside it ("key:rotation": [tiles before, tiles after] along the wall,',
        '// what 90 % of its instances have): a painting is wider than its tile and never hangs where its wall ends.',
        f'export const HOUSE_SPAN = {j(span)};', '',
        '// Keys under a roof in fewer than 10 % of their instances on the map (trees, bushes...: never inside a house), and',
        '// in more than 90 % (never in a yard).',
        f'export const HOUSE_OUTDOOR = {j(outdoor_only)};',
        f'export const HOUSE_INDOOR = {j(indoor_only)};',
        '// Keys the whole map has once (a museum piece, a quest prop): never copied.',
        f'export const HOUSE_UNIQUE = {j(unique)};', '',
        '// Hearths: the fewest tiles there are, in the game, between the middle of a hearth and the nearest wall across its',
        '// wall (the end of the room, an inner wall) - what 90 % of them have: a chimney is wider than its three pieces.',
        f'export const HOUSE_HEARTH_GAP = {sorted(hearth_room)[int(.1 * len(hearth_room))] if hearth_room else 2};', '',
        '// In the houses that have hearths, the rooms by size (tiles // 40, 4 = 160 and more): how many have 0, 1, 2... hearths.',
        f'export const HOUSE_ROOM_HEARTHS = {j({b: [hearths_in_room[(b, k)] for k in range(1 + max(k for (bb, k) in hearths_in_room if bb == b))] for b in sorted({b for b, _ in hearths_in_room})})};', '',
        '// Two hearths on the same wall: the fewest tiles between their middles that 90 % of such pairs have.',
        f'export const HOUSE_HEARTH_APART = {sorted(hearth_apart)[int(.1 * len(hearth_apart))] if hearth_apart else 8};', '',
        '// Keys that only stand on a hearth: counted among the houses that have one.',
        f'export const HOUSE_NEEDS = {j(needs)};', '',
        '// The wall styles whose pieces 34 | 35 | 36 are a hearth (a fire burns on one somewhere on the map); elsewhere they',
        '// are a timber frame, a bookcase niche...: no hearth is built of them.',
        f'export const HOUSE_HEARTH_STYLES = {j(hearth_styles)};',
        '// Hearths (wall pieces 34 | 35 | 36) by side (0..3 = NE SE SW NW) and o(utline) or i(nner wall).',
        f'export const HOUSE_HEARTHS = {j(dict(hearth_where.most_common()))};', '',
        '// Things that only stand near another (key: the key it goes with), and around instances of each of those:',
        '// [its rotation, [[dx, dy, unit, walls touched], ...]] - what stood with it, where.',
        f'export const HOUSE_DEPENDS = {j({str(k): a for k, a in sorted(dep.items())})};',
        '// ...and the offsets of each thing of those units, then of the anchor.',
        f'export const HOUSE_SATELLITES = {j(satellites)};', '',
        '// Things that go with a kind of thing (a lantern\'s glow with any lantern, a nightstand with a bed): key -> [the',
        '// category it needs, within how many tiles] - 80 % of its instances on the map have one that near, 40 % at most of',
        '// the houses\' tiles do.',
        f'export const HOUSE_NEAR_KIND = {j(near_cat)};', '',
        '// Pixel offsets ([x, y] from the tile\'s centre) things had on the map, by "key:rotation" and the walls their tile',
        '// touches (bits NE SE SW NW): up to 8 each.',
        f'export const HOUSE_SHIFTS = {j(shifts)};', '',
        '// The bottom edge of the things on the floor, from their art: [x of the first column sampled, y of the lowest opaque',
        '// pixel of every HOUSE_CONTOUR_STEP-th column (null: none)], pixels from the hotspot - the floor they take, once',
        '// shifted (bodyOf in sec-house-plan.js). Only for the things whose game instances bear it out.',
        '// How wide (pixels) the things on the floor are ("key:rotation"): HOUSE_FOOTPRINTS.floor gives, at each offset, the',
        '// widest that stood there.',
        f'export const HOUSE_WIDTHS = {j({p: width[p] for p in sorted(floor_parts) if p in width})};',
        f'export const HOUSE_CONTOUR_STEP = {CONTOUR_STEP};',
        f'export const HOUSE_CONTOURS = {j(dict(sorted(contours.items())))};', '']
    OUT.write_text('\n'.join(lines), encoding='utf-8')
    print('wrote', OUT, f'({OUT.stat().st_size // 1024} KB)', file=sys.stderr)
    print('kinds:', dict(kind_count.most_common()), file=sys.stderr)
    for h in sorted(houses, key=lambda h: (h['kind'], h['s'])):
        top = Counter(names.get(int(p.split(':')[0]), '?').replace('.ART', '') for u in h['units'] if u[3] >= 0 for p in u[0].split('|'))
        print(f"  {h['kind']:<10} s{h['s']:<2} {h['x0']},{h['y0']} {h['W']}x{h['H']} n={len(h['tiles'])}:", ', '.join(f'{k}{"x%d" % c if c > 1 else ""}' for k, c in top.most_common(9)), file=sys.stderr)
    print('categories:', Counter(unit_cat(u[0]) for h in houses for u in h['units']).most_common(30), file=sys.stderr)
    print('wall pieces:', {k: v.most_common(3) for k, v in sorted(piece_votes.items())}, file=sys.stderr)
    print('roof masks:', len(roof_votes), 'junction walled:', dict(junction), file=sys.stderr)
    print('roof votes:', {m: dict(v) for m, v in sorted(roof_votes.items())}, file=sys.stderr)
    print('split:', {L: v for L, v in sorted(split.items())}, 'cuts:', dict(cuts), file=sys.stderr)
    print('walls by feature:', dict(feat_base), 'hearths:', dict(hearth_where), 'needs:', needs, file=sys.stderr)
    print('depends:', {f'{names.get(k)}': names.get(a) for k, a in sorted(dep.items())}, file=sys.stderr)
    print('hung on (cat):', wall_feats['cat'], file=sys.stderr)
    print('in front of a hearth:', dict(hearth_front), file=sys.stderr)
    print('hearth gap to the nearest wall across:', sorted(hearth_gap.items()), file=sys.stderr)
    print('hearths on one wall, apart:', sorted(Counter(hearth_apart).items()), file=sys.stderr)
    print('hearths per room (n, tiles//40): rooms', sorted(hearths_in_room.items()), file=sys.stderr)
    print('spans:', len(span), 'outdoor-only keys:', [names.get(k) for k in outdoor_only], 'indoor-only:', len(indoor_only), file=sys.stderr)
    print('footprints:', len(foot['floor']), 'floor,', len(foot['wall']), 'wall;', len(footprints['hung']), 'hung keys', file=sys.stderr)
    print('shifts:', len(shifts), 'things; contours kept:', len(contours), 'of', len(floor_parts), file=sys.stderr)


if __name__ == '__main__':
    main()
