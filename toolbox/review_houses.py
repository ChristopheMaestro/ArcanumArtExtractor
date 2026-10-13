#!/usr/bin/env python3
"""Generate placeholder houses with sec-house-plan.js (headless Chromium) and draw them for a look.

Each house is drawn isometrically as the game shows it: floor, walls (windows blue, doors brown, hearths red), and the
scenery as labelled boxes coloured by kind. Pages of PNG are written to --out.

Usage:  python review_houses.py --out DIR [--n 20] [--seed 1] [--old] [--per-image 2]
"""
from __future__ import annotations
import argparse, http.server, json, random, socketserver, threading
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

from extract_house_data import category_of, scenery_names

ROOT = Path(__file__).resolve().parent.parent
TW, TH = 72, 36
COLORS = {'bed': (200, 120, 160), 'table': (170, 120, 60), 'seat': (230, 190, 90), 'storage': (140, 100, 70), 'stove': (230, 90, 50),
          'fire': (255, 140, 0), 'light': (255, 240, 120), 'wall decor': (150, 200, 230), 'plant': (80, 170, 80), 'barrel': (150, 110, 80),
          'vessel': (190, 160, 130), 'workbench': (120, 120, 170), 'decal': (150, 150, 150), 'rope': (200, 200, 200), 'junk': (130, 130, 110)}
NBR = [(-1, 0), (0, 1), (1, 0), (0, -1)]


def run(cases, wfc, tuning=None):
    from playwright.sync_api import sync_playwright

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
        def log_message(self, *a): pass

    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(m.text)); pg.on('pageerror', lambda e: logs.append('ERR ' + str(e)))
        pg.goto(f'http://127.0.0.1:{srv.server_address[1]}/logo.png')
        res = pg.evaluate('''async ([cases, wfc, tuning]) => {
            const m = await import('/js/editor/sec-house-plan.js');
            Object.assign(m.WFC_TUNING, tuning || {});
            return cases.map(c => {
              const t0 = performance.now();
              // (style -1: one the game's houses of the kind have, drawn from the seed)
              let r = c.seed; const rng = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
              const style = c.style >= 0 ? c.style : m.styleForKind(c.kind, rng);
              const plan = m.planHouse(style, { a: 2, b: 2 + c.w, c: 2, e: 2 + c.h }, null, { shapes: c.shapes, seed: c.seed, furnishSeed: c.fseed, wfc, kind: c.kind || null });
              return plan && { style, kind: plan.kind, w: c.w, h: c.h, ms: Math.round(performance.now() - t0), seed: c.seed, fseed: c.fseed, shapes: c.shapes, name: plan.style.name,
                walls: plan.walls, portals: plan.portals, scenery: plan.scenery, tiles: plan.tiles, facades: plan.facades || [], rugs: plan.rugs || [], wfc: plan.wfc || null, unplaced: plan.unplaced || 0, placed: plan._placed || null };
            });
        }''', [cases, wfc, tuning])
        b.close()
    srv.shutdown()
    for l in logs[:10]: print('console:', l)
    return res


SPRITES_JS = r'''
async (plans) => {
  const { loadMobMapArtShared } = await import('/js/objects/map-art-loader.js');
  const { loadSecFacadeArt } = await import('/js/sec/sec-tile-art.js');
  // (a facade cell's tile id, with the bits the game's rugs have: walkable, 0x4000800)
  const facadeRaw = (num, frame) => ((11 << 28) | 0x4000800 | 1 | ((frame & 0x3FF) << 1) | ((num & 0xFF) << 17) | (((num >> 8) & 1) << 27)) >>> 0;
  const cache = new Map();
  const art = async (key, rot) => {
    const id = key + ':' + rot;
    if (!cache.has(id)) { try { cache.set(id, await loadMobMapArtShared(key, 3, null, rot, null)); } catch (e) { cache.set(id, null); } }
    return cache.get(id);
  };
  const out = [];
  for (const p of plans) {
    const T = new Set(p.tiles.map(t => t.join(',')));
    const xs = p.tiles.map(t => t[0]), ys = p.tiles.map(t => t[1]);
    const x0 = Math.min(...xs) - 2, x1 = Math.max(...xs) + 2, y0 = Math.min(...ys) - 2, y1 = Math.max(...ys) + 2;
    const pos = (x, y) => [(y - x) * 40, (x + y) * 20];
    const cs = [[x0, y0], [x1 + 1, y0], [x0, y1 + 1], [x1 + 1, y1 + 1]].map(([x, y]) => pos(x, y));
    const minx = Math.min(...cs.map(c => c[0])) - 120, maxx = Math.max(...cs.map(c => c[0])) + 120;
    const miny = Math.min(...cs.map(c => c[1])) - 200, maxy = Math.max(...cs.map(c => c[1])) + 80;
    const cv = document.createElement('canvas'); cv.width = maxx - minx; cv.height = maxy - miny + 24;
    const g = cv.getContext('2d'); g.fillStyle = '#f5f5f0'; g.fillRect(0, 0, cv.width, cv.height);
    const cen = (x, y) => { const [a, b] = pos(x, y); return [a - minx, b - miny + 24]; };
    const dia = (x, y, fill, stroke) => { const [cx, cy] = cen(x, y); g.beginPath(); g.moveTo(cx, cy - 20); g.lineTo(cx + 40, cy); g.lineTo(cx, cy + 20); g.lineTo(cx - 40, cy); g.closePath(); g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); };
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (T.has(x + ',' + y)) dia(x, y, '#e8e0cd', '#d2c8b4');
      else if ([-1, 0, 1].some(dx => [-1, 0, 1].some(dy => T.has((x + dx) + ',' + (y + dy))))) dia(x, y, '#cde1c3', '#bed2b4');
    }
    for (const f of p.facades || []) {
      const a = await loadSecFacadeArt(facadeRaw(f.num, f.frame)), [cx, cy] = cen(f.wx, f.wy);
      if (a && a.canvas) g.drawImage(a.canvas, cx - 40, cy - 20); else dia(f.wx, f.wy, '#c04080', '#802050');
    }
    const edge = (w, col, width) => {
      const [cx, cy] = cen(w.wx, w.wy), v = [[cx, cy - 20], [cx + 40, cy], [cx, cy + 20], [cx - 40, cy]];
      const [a, b] = [[v[0], v[1]], [v[1], v[2]], [v[2], v[3]], [v[3], v[0]]][w.dir];
      g.strokeStyle = col; g.lineWidth = width; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
    };
    // back walls (NE, NW) under the furniture, front walls (SE, SW) over it
    const col = w => w.piece >= 9 && w.piece <= 20 ? '#3b6de0' : w.piece >= 21 && w.piece <= 33 ? '#96501a' : w.piece >= 34 && w.piece <= 36 ? '#dc2828' : '#2b2b2b';
    // (the back walls also as a see-through face as high as the game's walls, so what hangs on them shows where it hangs)
    for (const w of p.walls) if (w.dir === 0 || w.dir === 3) {
      const [cx, cy] = cen(w.wx, w.wy), v = [[cx, cy - 20], [cx + 40, cy], [cx, cy + 20], [cx - 40, cy]];
      const [a, b] = [[v[0], v[1]], [v[1], v[2]], [v[2], v[3]], [v[3], v[0]]][w.dir];
      g.fillStyle = 'rgba(120,110,95,0.28)'; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineTo(b[0], b[1] - 90); g.lineTo(a[0], a[1] - 90); g.closePath(); g.fill();
      edge(w, col(w), 5);
    }
    const items = [...p.scenery].sort((a, b) => (a.wx + a.wy) - (b.wx + b.wy) || a.wx - b.wx);
    for (const s of items) {
      const a = await art(s.key, s.rot || 0), [cx, cy] = cen(s.wx, s.wy);
      if (a && a.canvas) g.drawImage(a.canvas, Math.round(cx - a.hotspotX + (s.off ? s.off[0] : 0)), Math.round(cy - a.hotspotY + (s.off ? s.off[1] : 0)));
      else { g.fillStyle = '#f0f'; g.fillRect(cx - 4, cy - 4, 8, 8); }
    }
    for (const w of p.walls) if (w.dir === 1 || w.dir === 2) edge(w, col(w), 5);
    // each portal's art number by its edge (doors brown, windows blue)
    g.font = 'bold 11px sans-serif';
    for (const q of p.portals) {
      const [cx, cy] = cen(q.wx, q.wy), m = [[cx + 20, cy - 10], [cx + 20, cy + 10], [cx - 20, cy + 10], [cx - 20, cy - 10]][q.dir];
      const o = [[10, -12], [14, 14], [-30, 14], [-30, -12]][q.dir];
      g.fillStyle = q.door ? '#7a3a08' : '#1d3fa8'; g.fillText(String(q.num), m[0] + o[0], m[1] + o[1]);
    }
    g.fillStyle = '#000'; g.font = '13px sans-serif';
    g.fillText(`${p.kind}: ${p.name} (style ${p.style}) ${p.w}x${p.h} seed ${p.seed}/${p.fseed} things ${p.scenery.length}`, 8, 16);
    out.push(cv.toDataURL('image/png'));
  }
  return out;
}
'''


def render_sprites(plans):
    import base64
    from playwright.sync_api import sync_playwright

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
        def log_message(self, *a): pass

    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page()
        pg.goto(f'http://127.0.0.1:{srv.server_address[1]}/logo.png')
        urls = pg.evaluate(SPRITES_JS, plans)
        b.close()
    srv.shutdown()
    import io
    return [Image.open(io.BytesIO(base64.b64decode(u.split(',', 1)[1]))).convert('RGB') for u in urls]


def draw(plan, names):
    xs = [t[0] for t in plan['tiles']]; ys = [t[1] for t in plan['tiles']]
    x0, x1, y0, y1 = min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1
    pos = lambda x, y: ((y - x) * TW // 2, (x + y) * TH // 2)
    corners = [pos(x, y) for x in (x0, x1 + 1) for y in (y0, y1 + 1)]
    minx = min(c[0] for c in corners) - TW; maxx = max(c[0] for c in corners) + TW
    miny = min(c[1] for c in corners) - 40; maxy = max(c[1] for c in corners) + TH + 10
    im = Image.new('RGB', (maxx - minx, maxy - miny + 30), (245, 245, 240)); d = ImageDraw.Draw(im)
    font = ImageFont.load_default()
    cen = lambda x, y: (pos(x, y)[0] - minx, pos(x, y)[1] - miny + 30)
    inside = {tuple(t) for t in plan['tiles']}
    def diamond(x, y, fill, outline=None, shrink=0):
        cx, cy = cen(x, y); w, h = TW // 2 - shrink, TH // 2 - shrink // 2
        d.polygon([(cx, cy - h), (cx + w, cy), (cx, cy + h), (cx - w, cy)], fill=fill, outline=outline)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            if (x, y) in inside: diamond(x, y, (232, 224, 205), (210, 200, 180))
            elif any((x + dx, y + dy) in inside for dx in (-1, 0, 1) for dy in (-1, 0, 1)): diamond(x, y, (205, 225, 195), (190, 210, 180))
    # scenery, back to front
    items = sorted(plan['scenery'], key=lambda s: (s['wx'] + s['wy'], s['wx']))
    for s in items:
        nm = names.get(s['key'], str(s['key'])).replace('.ART', '').replace('.art', '')
        cat = category_of(names.get(s['key'], ''))
        cx, cy = cen(s['wx'], s['wy'])
        diamond(s['wx'], s['wy'], COLORS.get(cat, (180, 180, 180)), (60, 60, 60), shrink=6)
        d.text((cx - 28, cy - 5), nm[:10], fill=(0, 0, 0), font=font)
    # walls on top
    for w in plan['walls']:
        if w['piece'] == 0 and False: continue
        cx, cy = cen(w['wx'], w['wy']); hw, hh = TW // 2, TH // 2
        v = [(cx, cy - hh), (cx + hw, cy), (cx, cy + hh), (cx - hw, cy)]
        a, b = [(v[0], v[1]), (v[1], v[2]), (v[2], v[3]), (v[3], v[0])][w['dir']]
        p = w['piece']
        col = (40, 90, 220) if 9 <= p <= 20 else (150, 80, 20) if 21 <= p <= 33 else (220, 40, 40) if 34 <= p <= 36 else (30, 30, 30)
        d.line([a, b], fill=col, width=4)
    d.text((6, 4), f"{plan['name']} (style {plan['style']})  {plan['w']}x{plan['h']}  shapes={plan['shapes']}  seed {plan['seed']}/{plan['fseed']}  {plan['ms']} ms  things {len(plan['scenery'])}  unplaced {plan['unplaced']}  wfc {plan['wfc']}", fill=(0, 0, 0), font=font)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True); ap.add_argument('--n', type=int, default=20); ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--old', action='store_true'); ap.add_argument('--per-image', type=int, default=2)
    ap.add_argument('--styles', default='0,1,3,4,10,14,15,17,22,27,40,7,2,16,23,30')
    ap.add_argument('--sizes', default='9,13,17')
    ap.add_argument('--tune', default='', help='WFC_TUNING overrides, e.g. emptyBias=0.4,likeness=1')
    ap.add_argument('--sprites', action='store_true', help="draw the things with the game's art instead of labelled boxes")
    ap.add_argument('--stats', action='store_true', help='print the density and the kinds of things, draw nothing')
    ap.add_argument('--kinds', default='', help='house kinds to cycle through (inn,warehouse,...; "all": every kind); with them --styles -1 draws a style the kind has')
    args = ap.parse_args()
    rnd = random.Random(args.seed)
    styles = [int(s) for s in args.styles.split(',')]; sizes = [int(s) for s in args.sizes.split(',')]
    if args.kinds == 'all':
        import re
        text = (ROOT / 'js' / 'editor' / 'sec-house-data.js').read_text(encoding='utf-8')
        kinds = [k['id'] for k in json.loads(re.search(r'HOUSE_KINDS = (.*?);\n', text).group(1)) if k['id'] != 'empty']
    else: kinds = [k for k in args.kinds.split(',') if k]
    cases = [dict(style=styles[i % len(styles)], kind=kinds[i % len(kinds)] if kinds else None, w=rnd.choice(sizes), h=rnd.choice(sizes),
                  shapes=rnd.random() < .35, seed=rnd.randrange(2 ** 31), fseed=rnd.randrange(2 ** 31)) for i in range(args.n)]
    num = lambda v: float(v) if v.replace('.', '', 1).isdigit() else v
    tuning = {k: num(v) for k, v in (kv.split('=') for kv in args.tune.split(',') if kv)}
    plans = [p for p in run(cases, not args.old, tuning) if p]
    names = scenery_names()
    if args.stats:
        from collections import Counter
        cats = Counter(category_of(names.get(s['key'], '')) for p in plans for s in p['scenery'])
        tiles = sum(len(p['tiles']) for p in plans)
        print(f'{len(plans)} houses, {sum(len(p["scenery"]) for p in plans) / len(plans):.1f} things each, {sum(len(p["scenery"]) for p in plans) / tiles:.3f} per house tile,',
              f'unplaced {sum(p["unplaced"] for p in plans)}, mean {sum(p["ms"] for p in plans) / len(plans):.0f} ms')
        print(dict(cats.most_common(14)))
        # density by kind of tile: free of walls on its edges / walled (inside the house)
        cells, things = Counter(), Counter()
        for p in plans:
            wall = set()
            for w_ in p['walls']:
                wall.add((w_['wx'], w_['wy'])); dx, dy = NBR[w_['dir']]; wall.add((w_['wx'] + dx, w_['wy'] + dy))
            T = {tuple(t) for t in p['tiles']}
            for t in T: cells['wall' if t in wall else 'free'] += 1
            for s in p['scenery']:
                t = (s['wx'], s['wy'])
                if t in T: things['wall' if t in wall else 'free'] += 1
        print('density inside:', {k: round(things[k] / cells[k], 3) for k in cells})
        # things standing alone in the open (no wall within a tile, nothing else within a tile): the game has ~1.3 a house
        lone = 0; lone_names = Counter()
        for p in plans:
            wall = set()
            for w_ in p['walls']:
                wall.add((w_['wx'], w_['wy'])); dx, dy = NBR[w_['dir']]; wall.add((w_['wx'] + dx, w_['wy'] + dy))
            # (doors and windows are portals, not walls: a thing against one is not alone)
            for q in p['portals']:
                wall.add((q['wx'], q['wy'])); dx, dy = NBR[q['dir']]; wall.add((q['wx'] + dx, q['wy'] + dy))
            T = {tuple(t) for t in p['tiles']}; occ = {(s['wx'], s['wy']) for s in p['scenery']}
            for (x, y) in occ:
                if (x, y) not in T: continue
                near = [(x + a, y + b) for a in (-1, 0, 1) for b in (-1, 0, 1)]
                if not any(q in wall for q in near) and not any(q in occ for q in near if q != (x, y)):
                    lone += 1; lone_names.update(names.get(s['key'], s['key']) for s in p['scenery'] if (s['wx'], s['wy']) == (x, y))
        print(f'lone things in the open: {lone / len(plans):.2f} a house', dict(lone_names.most_common(12)))
        # inside things per tile of the bounding box, house by house: p10 p25 median p75 p90
        dens = sorted(sum(1 for s in p['scenery'] if (s['wx'], s['wy']) in {tuple(t) for t in p['tiles']}) / (p['w'] * p['h']) for p in plans)
        print('inside things per tile, per house: p10 %.3f p25 %.3f median %.3f p75 %.3f p90 %.3f' % tuple(dens[int(q * (len(dens) - 1))] for q in (.1, .25, .5, .75, .9)))
        w = [p['wfc'] for p in plans if p['wfc']]
        drops = Counter()
        for p in plans:
            for k, v in ((p['wfc'] or {}).get('dropped') or {}).items(): drops[k] += v
        if drops: print('dropped:', dict(drops.most_common(14)))
        if w: print('wfc: objects', sum(x['objects'] for x in w), 'placed', sum(x['placed'] for x in w), 'tries', Counter(x['tries'] for x in w),
                    'cells that can hold something:', sum(x['open'] for x in w), 'of', sum(x['cells'] for x in w))
        return
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    ims = render_sprites(plans) if args.sprites else [draw(p, names) for p in plans]
    for k in range(0, len(ims), args.per_image):
        grp = ims[k:k + args.per_image]
        W = max(i.width for i in grp); Hh = sum(i.height for i in grp)
        page = Image.new('RGB', (W, Hh), (255, 255, 255)); y = 0
        for i in grp: page.paste(i, (0, y)); y += i.height
        page.save(out / f'page{k // args.per_image + 1:02d}.png')
    print('ms:', [p['ms'] for p in plans]); print('wfc:', [p['wfc'] for p in plans])
    print(len(ims), 'houses ->', out)


if __name__ == '__main__':
    main()
