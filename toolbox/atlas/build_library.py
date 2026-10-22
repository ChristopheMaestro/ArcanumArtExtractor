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
black everywhere, white on the plaque. This script turns the pictures used into lossless WebP files (atlas/graphics/library/, a pool
shared by the versions; a font is its black strip, the page tints it white) named by js/atlas/data/library.js, and copies
the text of the five .mes files; index.html lays the text out with the same rectangles as written_ui.c. Re-run it rather
than editing the output:  py build_library.py
Needs Pillow.
"""
import hashlib
import io
import json
import re
import struct

from PIL import Image

import arcanum_objects as ao

DATA_JS = ao.DATA_JS
OUT_JS = DATA_JS / 'library.js'
POOL = ao.PROJECT / 'atlas' / 'graphics' / 'library'
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


def picture(img, kind):
    """The picture as a lossless WebP in the shared pool (atlas/graphics/library/<md5>.webp: every version's library.js points there, a picture they
    have alike is one file) -> its path for the page. Loaded on the Library's first use (atlas-app.js libLoad), not with the data."""
    buf = io.BytesIO()
    img.convert('RGBA').save(buf, 'WEBP', lossless=True, quality=100, method=6)
    b = buf.getvalue()
    p = POOL / f'{kind}-{hashlib.md5(b).hexdigest()[:8]}.webp'
    if not p.is_file():
        POOL.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    return p.relative_to(ao.PROJECT).as_posix()


def prune_pool():
    """Pool pictures no version's library.js names any more go."""
    used = set()
    base = ao.PROJECT / 'js' / 'atlas' / 'data'                        # (a version's run writes js/atlas/data/<key>/: the base game's file counts too)
    for js in {OUT_JS, base / 'library.js', *base.glob('*/library.js')}:
        if not js.is_file():
            continue
        used |= set(re.findall(r'atlas/graphics/library/([a-z]+-[0-9a-f]{8}\.webp)', js.read_text(encoding='utf-8')))
    for p in POOL.glob('*.webp'):
        if p.name not in used:
            p.unlink()


def sheet(entries, images, kind):
    """Packs the pictures into one WebP, stacked top to bottom: each entry gets its 'src' (the sheet) and 'y' (its top row)."""
    keys = list(images)
    out = Image.new('RGBA', (max(images[k].width for k in keys), sum(images[k].height for k in keys)), (0, 0, 0, 0))
    y, tops = 0, {}
    for k in keys:
        out.paste(images[k].convert('RGBA'), (0, y))
        tops[k] = y
        y += images[k].height
    src = picture(out, kind)
    for k in keys:
        entries[k].update({'src': src, 'y': tops[k]})


def background(path):
    w, h, _, _, idx, pal = art_frames(path)[0]
    img = Image.new('P', (w, h))
    img.putdata(bytes(idx))
    img.putpalette([c for rgb in pal for c in rgb])
    return {'w': w, 'h': h}, img


def font(path):
    frames = art_frames(path)
    peak = max([f[5][v][0] for f in frames for v in f[4] if v > 1] or [1])
    height = max(f[1] for f in frames)
    total = sum(f[0] for f in frames)
    black = Image.new('RGBA', (total, height), (0, 0, 0, 0))
    glyphs, x = {}, 0
    for n, (w, h, hx, hy, idx, pal) in enumerate(frames):
        if w and h:
            px = [(0, 0, 0, 0) if v < 2 else (0, 0, 0, min(255, round(255 * pal[v][0] / peak))) for v in idx]   # 0 transparent, 1 edge marker; the grey ramp is how much ink, not a grey
            tile = Image.new('RGBA', (w, h))
            tile.putdata(px)
            black.paste(tile, (x, 0))
        glyphs[n + FIRST_CHAR] = [x, w, hx]
        x += w
    return {'h': height, 'glyphs': glyphs}, black      # (the white ink of the plaque: the page tints this strip)


def stock_blocks(mod_texts):
    """(module, kind, first line) of the blocks of ten lines a module still has as the editor's template left them
    (the same text, line by line, in at least three modules): placeholders, not content of the module."""
    seen = {}
    for texts in mod_texts.values():
        for sub, t in texts.items():
            for k, v in t.items():
                seen.setdefault((sub, k), {}).setdefault(v, 0)
                seen[sub, k][v] += 1
    out = set()
    for name, texts in mod_texts.items():
        for sub, t in texts.items():
            blocks = {}
            for k, v in t.items():
                if k >= (1020 if sub == 3 else 1000):
                    blocks.setdefault(k // 10 * 10, []).append((k, v))
            for start, lines in blocks.items():
                if all(seen[sub, k][v] >= 3 for k, v in lines):
                    out.add((name, sub, start))
    return out


def copy_version(module):
    """The game_files.Version of a module under the running mod when that mod has a copy of it (data/mods/<mod>/modules/<M>), else None."""
    import os
    import game_files
    v = game_files.Version(os.environ.get('ATLAS_VERSION', 'base'), module.name)
    return v if v.copy_owners else None


def module_texts(module):
    """A module's own texts (its mes/game*.mes); under a mod with a copy of it, also the mod's blocks its objects point at (CE moved Lost Dungeon
    of Souls' books to its own gamebook.mes, 1920+: its copy's books read those)."""
    own = {sub: ao.mes(module / 'mes' / name) for sub, name in MES.items()}
    v = copy_version(module)
    if v is None:
        return own
    import build_modules
    full = {sub: v.mes('mes', name) for sub, name in MES.items()}
    protos = v.protos()
    for key, mod, folder in build_modules.entries():
        for path in sorted(folder.glob('*.mob')) if mod.name == module.name else []:
            o = ao.read_mob(path)
            if o.type == 13:
                e = ao.Effective(o, protos.get(o.proto))
                sub, start = e.int(202), e.int(203)
                if sub in full and start // 10 * 10 not in {k // 10 * 10 for k in own[sub]}:
                    own[sub].update({k: t for k, t in full[sub].items() if k // 10 * 10 == start // 10 * 10})
    return own


def documents(texts, module=None):
    """Every readable text (each starts a block of ten lines, written_ui.c) and where a copy is placed in the world.
    `module`: a module folder, whose own texts these are; its copies lie on its own maps (the place is the map's key)."""
    v = copy_version(module) if module else None
    desc = v.descriptions() if v else ao.descriptions(module)          # (under a mod with a copy of the module: its names too, game_files)
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

    for p in ([] if module else protos.values()):          # (a module has no protos of its own: the base ones name the game's texts)
        if p.type == 13:
            sub, start, name, nid = info(p, ao.Effective(p, None))
            if (sub, start) in docs and name:
                docs[sub, start]['n'].add(name)
                if nid == 14072:
                    docs[sub, start]['v'] = 1
    objs, holder = [], {}
    if module:
        import build_modules
        for key, mod, folder in build_modules.entries():
            for path in sorted(folder.glob('*.mob')) if mod.name == module.name else []:
                o = ao.read_mob(path)
                o.map, o.area = key, ''
                objs.append(o)
    else:
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
        place = world_place.get(at.area, at.area or 'Wilderness') if world else at.map if module else ao.clean_map(at.map)
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
    import build_modules
    mods = [m for m in build_modules.module_folders() if any((m / 'mes' / n).is_file() for n in MES.values())]
    mod_texts = {m.name: module_texts(m) for m in mods}
    wanted = set(UI_FONTS)
    for tx in [texts, *mod_texts.values()]:
        for sub in (0, 2, 6):
            for line in tx[sub].values():
                m = re.match(r'^\s*(\d+)[lcLC]', line)
                if m:
                    wanted.add(int(m.group(1)))
    fonts, strips, missing = {}, {}, []
    for num in sorted(wanted):
        name = interface.get(num, '').strip()
        try:
            fonts[num], strips[num] = font(find(name))
        except (StopIteration, struct.error, ValueError, IndexError):
            missing.append(num)
    sheet(fonts, strips, 'fonts')                                             # all fonts in one picture, all backgrounds in another
    bgs, pics = {}, {}
    for n in BACKGROUNDS:
        bgs[n], pics[n] = background(find(interface[n].strip()))
    sheet(bgs, pics, 'backgrounds')
    docs = documents(texts)
    mes = {str(sub): {str(k): v.replace('\r', '') for k, v in t.items()} for sub, t in texts.items()}
    # a module's texts (its own mes/gamebook.mes ...): the page puts them over the game's headings and fillers (the lines below 1000)
    module_mes = {}
    stock = stock_blocks(mod_texts)
    for m in mods:
        d = documents(mod_texts[m.name], m)
        keep = [x for x in d if (m.name, x['k'], x['s']) not in stock]
        docs += [{**x, 'g': m.name} for x in keep]
        module_mes[m.name] = {str(sub): {str(k): v.replace('\r', '') for k, v in t.items()
                                         if (m.name, sub, k // 10 * 10) not in stock or k < (1020 if sub == 3 else 1000)}
                              for sub, t in mod_texts[m.name].items()}
        print(f'  {m.name}: {len(keep)} documents ({sum(1 for x in keep if x["f"])} placed)'
              + (f', {len(d) - len(keep)} editor placeholders left out ({sum(1 for x in d if x["f"] and x not in keep)} placed)'
                 if len(keep) != len(d) else ''))
    data = {'source': 'toolbox/atlas/build_library.py',
            'note': 'backgrounds / fonts are keyed by interface art number (art/interface/interface.mes); fonts: h = line '
                    'height, glyphs[code] = [x in the strip, width, advance]; src = the strip in black (white: the page tints '
                    'it); src = one sheet of atlas/graphics/library/ for all fonts and one for all backgrounds, y = the picture\'s top row in it (w x h or the strip\'s height h). mes[kind][line] = text of gamebook / gamenote / gamenewspaper / gametelegram / '
                    'gameplaque (kind = the written subtype 0 / 1 / 2 / 3 / 6). docs: k = kind, s = first line, v = the '
                    'Vendigroth Times, n = names of the items that carry it, f = [place, world map?, tile, held by, copies].',
            'docs': docs, 'backgrounds': bgs, 'fonts': fonts, 'mes': mes, 'moduleMes': module_mes}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_library.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumLibrary = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    prune_pool()
    print(f'{len(docs)} documents ({sum(1 for d in docs if d["f"])} with a copy placed in the world), '
          f'{len(fonts)} fonts, {len(bgs)} backgrounds, {sum(len(t) for t in texts.values())} text lines'
          + (f'; fonts not read: {missing}' if missing else ''))
    print(f'Wrote {OUT_JS.relative_to(ao.PROJECT)} ({OUT_JS.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
