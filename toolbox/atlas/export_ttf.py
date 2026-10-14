#!/usr/bin/env python3
"""
Export the game's bitmap fonts (art/interface/*Font.ART) as TrueType fonts for Word / OpenOffice.

Each ART font is one frame per character (frame = character code - 31). A TTF needs outlines, so each glyph's grey
ramp (= how much ink a pixel has; index 0 is transparent, 1 an edge marker) is cut at THRESHOLD and every ink pixel
becomes a square (neighbours merge into one outline). Crisp pixel text: it looks right at the font's native size
(em = frame height in pixels, so 12 px = 9 pt on a 96 dpi screen) and at whole multiples of it. Smoothing the ramp up
first (SMOOTH 4) and picking the cut per font (threshold None) was tried and looked worse.
Advance width = the glyph's hotspot X, like tig_font.c. Baseline = bottom of the capital 'H'.
Fonts in REAL_FONTS are skipped: they are Arial / Comic Sans / Georgia / Morpheus, use those.
Usage:  py export_ttf.py [out_dir] [threshold 0-1, default 0.4]      Needs Pillow and fonttools.
"""
import sys
from collections import defaultdict
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from PIL import Image

import arcanum_objects as ao
from build_library import ART, FIRST_CHAR, art_frames

PX = 100                                    # font units per source pixel
SMOOTH = 1                                  # 1: one square per game pixel (what worked best); 4+ traces a finer smoothed grid
THRESHOLD = 0.4                             # grey ramp level (0-1) that counts as ink; None picks it per font
REAL_FONTS = {'arial10font', 'arialb12font', 'comic12font', 'georgia30font', 'morph15font', 'morph30font'}   # identified: use Arial, Arial Bold, Comic Sans MS, Georgia, Morpheus
SKIP ={'bookimagesfont', 'icons17font', 'icons32font', 'mpiconsfont', 'newsiconsfont'}   # pictures, not text


def outlines(ink):
    """Closed contours (clockwise, y up) around a set of (x, y) pixels, y counted downwards from the top."""
    nxt = defaultdict(list)
    for x, y in ink:
        if (x, y - 1) not in ink: nxt[(x, y)].append((x + 1, y))              # top edge, left to right
        if (x + 1, y) not in ink: nxt[(x + 1, y)].append((x + 1, y + 1))      # right edge, downwards
        if (x, y + 1) not in ink: nxt[(x + 1, y + 1)].append((x, y + 1))      # bottom edge, right to left
        if (x - 1, y) not in ink: nxt[(x, y + 1)].append((x, y))              # left edge, upwards
    loops = []
    while nxt:
        start = next(iter(nxt))
        loop, cur, prev = [start], start, None
        while True:
            outs = nxt[cur]
            if len(outs) > 1 and prev:                                         # pinch point: keep turning the same way
                dx, dy = cur[0] - prev[0], cur[1] - prev[1]
                outs.sort(key=lambda o: ((o[0] - cur[0]) * -dy + (o[1] - cur[1]) * dx))
            nx = outs.pop(0)
            if not outs: del nxt[cur]
            prev, cur = cur, nx
            if cur == start: break
            loop.append(cur)
        # drop collinear points
        pts = [p for i, p in enumerate(loop)
               if (loop[i - 1][0] - p[0]) * (loop[(i + 1) % len(loop)][1] - p[1]) != (loop[i - 1][1] - p[1]) * (loop[(i + 1) % len(loop)][0] - p[0])]
        loops.append(pts)
    return loops


def build(path, out_dir, threshold):
    frames = art_frames(path)
    height = max(f[1] for f in frames)
    pal = frames[0][5]
    peak = max([pal[v][0] for f in frames for v in f[4] if v > 1] or [1])

    def smooth(f):
        w, h, _, _, idx, p = f
        if not (w and h): return None
        cov = Image.new('L', (w, h))
        cov.putdata([round(255 * min(1, p[v][0] / peak)) if v > 1 else 0 for v in idx])
        return list(cov.resize((w * SMOOTH, h * SMOOTH), Image.BICUBIC).get_flattened_data()), w * SMOOTH

    bigs = [smooth(f) for f in frames]
    if threshold is None:       # the cut that keeps as much ink as the game draws (thin fonts need a lower one)
        game_ink = sum(255 * min(1, f[5][v][0] / peak) for f in frames for v in f[4] if v > 1) * SMOOTH * SMOOTH
        hist = [0] * 256
        for b in bigs:
            for v in (b[0] if b else ()): hist[v] += 1
        threshold = min((t / 100 for t in range(15, 71)), key=lambda t: abs(sum(hist[round(255 * t):]) * 255 - game_ink))

    def pixels(n):
        """Ink pixels of frame n on a grid SMOOTH times finer: the grey ramp is how much ink a pixel has, so smooth it up
        and cut at `threshold`; edges land at sub-pixel positions and the stroke weight stays what the game draws."""
        b = bigs[n]
        if not b: return set()
        cut = round(255 * threshold)
        return {(i % b[1], i // b[1]) for i, v in enumerate(b[0]) if v >= cut}

    h_ink = pixels(ord('H') - FIRST_CHAR)
    baseline = round((max(y for _, y in h_ink) + 1) / SMOOTH) if h_ink else height   # whole pixel rows above the baseline
    ascent, descent = baseline * PX, (height - baseline) * PX
    if descent < 0: descent = 0

    order, glyphs, advances, cmap = ['.notdef'], {}, {}, {}
    box = TTGlyphPen(None)
    box.moveTo((PX, 0)); box.lineTo((PX, baseline * PX)); box.lineTo((4 * PX, baseline * PX)); box.lineTo((4 * PX, 0)); box.closePath()
    glyphs['.notdef'] = box.glyph(); advances['.notdef'] = 6 * PX
    for n, f in enumerate(frames):
        code = n + FIRST_CHAR
        if code < 32 or code == 127: continue
        try:
            ch = bytes([code]).decode('cp1252')
        except UnicodeDecodeError:
            continue
        name = f'uni{ord(ch):04X}'
        pen = TTGlyphPen(None)
        for loop in outlines(pixels(n)):
            pts = [(x * PX // SMOOTH, baseline * PX - y * PX // SMOOTH) for x, y in loop]
            pen.moveTo(pts[0])
            for p in pts[1:]: pen.lineTo(p)
            pen.closePath()
        glyphs[name] = pen.glyph()
        advances[name] = max(f[2], 0) * PX or f[0] * PX
        cmap[ord(ch)] = name
        order.append(name)
    if 0xA0 not in cmap and 32 in cmap:
        cmap[0xA0] = cmap[32]

    family = path.stem.replace('Font', '').replace('font', '') or path.stem
    family = 'Arcanum ' + family[0].upper() + family[1:]
    fb = FontBuilder(height * PX, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (advances[n], 0) for n in order})
    fb.setupHorizontalHeader(ascent=ascent, descent=-descent)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' Regular',
                       'fullName': family, 'psName': family.replace(' ', '') + '-Regular', 'version': 'Version 1.0'})
    fb.setupOS2(sTypoAscender=ascent, sTypoDescender=-descent, usWinAscent=ascent, usWinDescent=descent, sTypoLineGap=0)
    fb.setupPost()
    out = out_dir / (family.replace(' ', '') + '.ttf')
    fb.save(out)
    return out, height, len(cmap)


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ao.PROJECT / 'exported-fonts'
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else THRESHOLD
    out_dir.mkdir(parents=True, exist_ok=True)
    for p in sorted(ART.iterdir(), key=lambda q: q.name.lower()):
        if p.suffix.lower() != '.art' or not p.stem.lower().endswith('font') or p.stem.lower() in SKIP | REAL_FONTS: continue
        out, h, n = build(p, out_dir, threshold)
        print(f'{out.name}: {h} px high, {n} characters  ->  best at {round(h * 0.75, 1)} pt')


if __name__ == '__main__':
    main()
