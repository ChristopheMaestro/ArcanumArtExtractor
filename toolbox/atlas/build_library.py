#!/usr/bin/env python3
"""
The Library of the Atlas: books, notes, newspapers, telegrams and plaques drawn the way the game draws them.

written_ui.c (the screen that opens when the player reads such an item) uses a background picture and bitmap fonts
from art/interface, picked by number through art/interface/interface.mes:
  * the background of each kind (BookBackground, NoteBackground, NewsBackground, TeleBackground, Stone_Plaque,
    vendnewsback for the Vendigroth Times);
  * every line of gamebook / gamenewspaper / gameplaque .mes begins with a font number and a justification letter
    ("492c _ WEATHER _"); the page furniture (newspaper title, telegram headings) names fonts in the C source.
A font is one ART frame per character (frame = character code - 31); the game draws the grey ramp in the font's colour:
black everywhere, white on the plaque. This script turns the pictures used into PNGs inside js/atlas/data/library.js
(data: URIs, so the page works from a plain file) and copies the text of the five .mes files; index.html lays the
text out with the same rectangles as written_ui.c. Re-run it rather than editing the output:  py build_library.py
Needs Pillow.
"""
import base64
import io
import json
import re
import struct

from PIL import Image

import arcanum_objects as ao

DATA_JS = ao.PROJECT / 'js' / 'atlas' / 'data'
OUT_JS = DATA_JS / 'library.js'
ART = ao.DATA / 'art' / 'interface'
FIRST_CHAR = 31                       # tig_font: frame 0 is character 31
MES = {0: 'gamebook.mes', 1: 'gamenote.mes', 2: 'gamenewspaper.mes', 3: 'gametelegram.mes', 6: 'gameplaque.mes'}
WORLD = 'Arcanum1-024-fixed'
BACKGROUNDS = [477, 489, 487, 491, 633, 817]
UI_FONTS = [479, 480, 481, 482, 484, 485, 497, 815]      # named in written_ui.c


def find(name):
    p = ART / name
    if p.exists():
        return p
    return next(q for q in ART.iterdir() if q.name.lower() == name.lower())


def art_frames(path):
    """Every frame of the first direction of a .ART: (width, height, hot_x, hot_y, palette indices, palette)."""
    data = path.read_bytes()
    head = struct.unpack_from('<33I', data, 0)
    npal = max(1, sum(1 for x in head[3:7] if x))
    dirs = 1 if head[0] & 1 else 8
    per = head[8]
    off = 0x84
    pals = []
    for _ in range(npal):
        p = data[off:off + 1024]
        pals.append([(p[i * 4 + 2], p[i * 4 + 1], p[i * 4]) for i in range(256)])
        off += 1024
    infos = [struct.unpack_from('<IIIiiii', data, off + i * 28) for i in range(dirs * per)]
    off += dirs * per * 28
    out = []
    for i, (w, h, size, hx, hy, *_ ) in enumerate(infos):
        chunk = data[off:off + size]
        off += size
        if i >= per:
            continue                        # one direction is all a picture or a font needs
        n = w * h
        if size == n:
            idx = bytearray(chunk)
        else:
            idx, p, o = bytearray(n), 0, 0
            while p < len(chunk) and o < n:
                c = chunk[p]; p += 1
                k = c & 0x7F
                if c & 0x80:
                    m = min(k, n - o)
                    idx[o:o + m] = chunk[p:p + m]; p += k; o += m
                else:
                    if p >= len(chunk):
                        break
                    e = min(n, o + k)
                    idx[o:e] = bytes([chunk[p]]) * (e - o); p += 1; o = e
        out.append((w, h, hx, hy, idx, pals[0]))
    return out


def data_uri(img):
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def background(path):
    w, h, _, _, idx, pal = art_frames(path)[0]
    img = Image.new('P', (w, h))
    img.putdata(bytes(idx))
    img.putpalette([c for rgb in pal for c in rgb])
    return {'w': w, 'h': h, 'src': data_uri(img)}


def font(path):
    frames = art_frames(path)
    peak = max([f[5][v][0] for f in frames for v in f[4] if v > 1] or [1])
    height = max(f[1] for f in frames)
    total = sum(f[0] for f in frames)
    black = Image.new('RGBA', (total, height), (0, 0, 0, 0))
    white = Image.new('RGBA', (total, height), (0, 0, 0, 0))
    glyphs, x = {}, 0
    pictures = False
    full = Image.new('RGBA', (total, height), (0, 0, 0, 0)) if pictures else None
    for n, (w, h, hx, hy, idx, pal) in enumerate(frames):
        if pictures and w and h:
            tile = Image.new('RGBA', (w, h)); tile.putdata([(0, 0, 0, 0) if v == 0 else (*pal[v], 255) for v in idx]); full.paste(tile, (x, 0))
        if w and h and not pictures:
            b, wh = [], []
            for v in idx:
                if v < 2:                       # 0 transparent, 1 edge marker
                    b.append((0, 0, 0, 0)); wh.append((0, 0, 0, 0))
                else:
                    k = min(255, round(255 * pal[v][0] / peak))
                    b.append((0, 0, 0, k)); wh.append((255, 255, 255, k))      # the grey ramp is how much ink, not a grey
            for img, px in ((black, b), (white, wh)):
                tile = Image.new('RGBA', (w, h)); tile.putdata(px); img.paste(tile, (x, 0))
        glyphs[n + FIRST_CHAR] = [x, w, hx]
        x += w
    if pictures:
        return {'h': height, 'glyphs': glyphs, 'black': data_uri(full), 'white': data_uri(full)}
    return {'h': height, 'glyphs': glyphs, 'black': data_uri(black), 'white': data_uri(white)}


def documents(texts):
    """Every readable text (each starts a block of ten lines, written_ui.c) and where a copy is placed in the world."""
    desc = ao.descriptions()
    docs = {}
    for sub, t in texts.items():
        for n in t:
            if n >= (1020 if sub == 3 else 1000):
                docs.setdefault((sub, n // 10 * 10), {'k': sub, 's': n // 10 * 10, 'n': set(), 'f': {}})
    protos = {}
    for p in (ao.DATA / 'proto').rglob('*.pro'):
        o = ao.read_proto(p)
        protos[o.proto] = o

    world_place = {}
    wl = DATA_JS / 'world-labels.js'
    if wl.exists():
        data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))
        world_place = {p['worldFolder']: p['name'] for p in data['places'] if p.get('worldFolder')}

    def info(o, e):
        return e.int(202), e.int(203), (desc.get(e.int(23)) or '').strip(), e.int(23)

    for p in protos.values():
        if p.type == 13:
            sub, start, name, nid = info(p, ao.Effective(p, None))
            if (sub, start) in docs and name:
                docs[sub, start]['n'].add(name)
                if nid == 14072:
                    docs[sub, start]['v'] = 1
    objs, holder = [], {}
    for path in sorted((ao.DATA / 'maps').rglob('*.mob')):
        o = ao.read_mob(path)
        rel = path.relative_to(ao.DATA / 'maps').parts
        o.map, o.area = rel[0], (rel[1] if rel[0] == WORLD and len(rel) > 2 else '')
        objs.append(o)
    for o in objs:
        field = 60 if o.type == 2 else 238 if o.type in (15, 16) else None
        if field:
            for raw in (o.get(field) or {}).values():
                holder[ao.oid_key(raw)] = o
    for o in objs:
        if o.type != 13:
            continue
        e = ao.Effective(o, protos.get(o.proto))
        sub, start, name, nid = info(o, e)
        d = docs.get((sub, start))
        if d is None:
            continue
        if name:
            d['n'].add(name)
        if nid == 14072:
            d['v'] = 1
        owner = holder.get(ao.oid_key(o.oid))
        at = owner or o
        if not at.tile and owner is None:
            continue
        world = at.map == WORLD
        place = world_place.get(at.area, at.area or 'Wilderness') if world else ao.clean_map(at.map)
        by = (desc.get(ao.Effective(owner, protos.get(owner.proto)).int(23)) or '').strip() if owner else ''
        if owner is not None and owner.type == 2:
            by = by or 'Container'
        key = (place, int(world), tuple(at.tile) if at.tile else None, by)
        d['f'][key] = d['f'].get(key, 0) + 1
    out = []
    for d in sorted(docs.values(), key=lambda d: (d['k'], d['s'])):
        out.append({'k': d['k'], 's': d['s'], **({'v': 1} if d.get('v') else {}), 'n': sorted(d['n']),
                    'f': [[p, w, list(t) if t else None, b, c] for (p, w, t, b), c in d['f'].items()]})
    return out


def main():
    interface = ao.mes(ART / 'interface.mes')
    texts = {sub: ao.mes(ao.DATA / 'mes' / name) for sub, name in MES.items()}
    wanted = set(UI_FONTS)
    for sub in (0, 2, 6):
        for line in texts[sub].values():
            m = re.match(r'^\s*(\d+)[lcLC]', line)
            if m:
                wanted.add(int(m.group(1)))
    fonts, missing = {}, []
    for num in sorted(wanted):
        name = interface.get(num, '').strip()
        try:
            fonts[num] = font(find(name))
        except (StopIteration, struct.error, ValueError, IndexError):
            missing.append(num)
    bgs = {n: background(find(interface[n].strip())) for n in BACKGROUNDS}
    docs = documents(texts)
    mes = {str(sub): {str(k): v.replace('\r', '') for k, v in t.items()} for sub, t in texts.items()}
    data = {'source': 'toolbox/atlas/build_library.py',
            'note': 'backgrounds / fonts are keyed by interface art number (art/interface/interface.mes); fonts: h = line '
                    'height, glyphs[code] = [x in the strip, width, advance]; black / white = the strip in the two colours '
                    'the game uses. mes[kind][line] = text of gamebook / gamenote / gamenewspaper / gametelegram / '
                    'gameplaque (kind = the written subtype 0 / 1 / 2 / 3 / 6). docs: k = kind, s = first line, v = the '
                    'Vendigroth Times, n = names of the items that carry it, f = [place, world map?, tile, held by, copies].',
            'docs': docs, 'backgrounds': bgs, 'fonts': fonts, 'mes': mes}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_library.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumLibrary = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    print(f'{len(docs)} documents ({sum(1 for d in docs if d["f"])} with a copy placed in the world), '
          f'{len(fonts)} fonts, {len(bgs)} backgrounds, {sum(len(t) for t in texts.values())} text lines'
          + (f'; fonts not read: {missing}' if missing else ''))
    print(f'Wrote {OUT_JS.relative_to(ao.PROJECT)} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
