#!/usr/bin/env python3
"""
Clear the black overlap band of the sector pictures (atlas/maps/*, atlas/world, atlas/modules/*), without drawing anything again.

build_map_pictures.py draws each sector over a black diamond 3 px larger than the sector, with the neighbours' tiles in that
band. Where a neighbour's tile was not drawn the band stays black, and since the Atlas lays the pictures back to front, the
sector drawn last paints a black line over the one before. The band is only there so that neighbours overlap: here every
near-black pixel just outside the sector's diamond turns transparent (what the neighbour's picture shows there is then seen).
Nothing inside the diamond changes. The overhang of the sector's own scenery does where it is dark: an object crossing the
edge loses its near-black pixels there (the dark windows of the Tarant bridge towers became a see-through line). So do not
run it again: build_map_pictures.py now clears the black while drawing, before the objects, and no longer calls cut_band().

For each picture: the full-size picture is put back together from its L0 pieces, cleaned, and the pieces that changed are
written again, then L0.5, L1, L2, L3 (and the map's atlas.webp) are made again from it, as build_map_pictures.py makes them
(only the sizes the map still has: build_map_pictures.prune_levels).
bandcut.json in each map folder lists the pictures done, so a second run only does what is new.

  py trim_band.py                       every map
  py trim_band.py --maps world --stems sec_123,sec_124   only these (for a test)
"""
import argparse
import json
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
PAD_L, PAD_T = 192, 384                      # build_map_pictures.PAD
SW, SH = 5120, 2560                          # a sector's diamond
REACH = 6                                    # px outside the diamond looked at (the band is 3 px, a lossy edge a little more)
DARK = 24                                    # max(r, g, b) up to here counts as black (the pictures are lossy WebP)
COLS, ROWS = 8, 4


def cut_band(im):
    """The picture (RGBA, full size) with the near-black pixels just outside its diamond transparent. Returns (picture, changed)."""
    a = np.array(im)
    h, w = a.shape[:2]
    cx, cy = PAD_L + SW / 2, PAD_T + SH / 2
    y0 = max(0, PAD_T - REACH - 2)
    # a thin frame around the diamond is all that is looked at: rows, then the pixels of each row
    ys = np.arange(y0, min(h, PAD_T + SH + REACH + 3))
    xs = np.arange(0, w)
    ex = np.abs(xs + 0.5 - cx)[None, :] / (SW / 2) + np.abs(ys + 0.5 - cy)[:, None] / (SH / 2)
    k = REACH * np.hypot(SW / 2, SH / 2) / (SW / 2 * SH / 2)           # one px of distance in diamond units
    ring = (ex > 1.0) & (ex <= 1.0 + k)
    sub = a[y0:y0 + len(ys)]
    dark = sub[..., :3].max(axis=2) <= DARK
    hit = ring & dark & (sub[..., 3] > 0)
    if not hit.any():
        return im, False
    sub[hit] = 0
    return Image.fromarray(a), True


def pieces_of(out, stem, mask):
    """The full-size picture from its L0 pieces."""
    full = Image.new('RGBA', (5504, 3008), (0, 0, 0, 0))
    tw, th = 5504 // COLS, 3008 // ROWS
    for r in range(ROWS):
        for c in range(COLS):
            if mask >> (r * COLS + c) & 1:
                with Image.open(out / 'L0' / f'{stem}_{c}_{r}.webp') as p:
                    full.paste(p.convert('RGBA'), (c * tw, r * th))
    return full


def do_one(job):
    out, stem, mask = job
    import build_map_pictures as bp
    full = pieces_of(out, stem, mask)
    full2, changed = cut_band(full)
    if not changed:
        return stem, None
    # the L0 pieces that changed: those holding a pixel that differs
    tw, th = 5504 // COLS, 3008 // ROWS
    old, new = np.array(full), np.array(full2)
    for r in range(ROWS):
        for c in range(COLS):
            box = (slice(r * th, (r + 1) * th), slice(c * tw, (c + 1) * tw))
            if mask >> (r * COLS + c) & 1 and not np.array_equal(old[box], new[box]):
                piece = full2.crop((c * tw, r * th, (c + 1) * tw, (r + 1) * th))
                piece.save(out / 'L0' / f'{stem}_{c}_{r}.webp', 'WEBP', quality=85, method=0)
    # the others, made again from it like build_map_pictures.py makes them
    masks = []
    for sub, (cols, rows, f) in bp.PIECES.items():
        if sub == 'L0' or not (out / sub).is_dir():              # (a size the map no longer has: bp.prune_levels; mask kept)
            masks.append(mask if sub == 'L0' else None)
            continue
        for p in (out / sub).glob(f'{stem}_*_*.webp'):
            if bp.piece_stem(p) == stem:
                p.unlink()
        masks.append(bp.split_layer(bp.shrink(full2, f), out / sub, stem, cols, rows, quality=85, method=0))
    im = full2
    for k, f in bp.LEVELS.items():
        im = bp.shrink(im, f // (1 if k == 1 else bp.LEVELS[k - 1]))
        if (out / f'L{k}').is_dir():
            im.save(out / f'L{k}' / f'{stem}.webp', 'WEBP', quality=85, method=4)
    (out / 'L3').mkdir(exist_ok=True)                            # for the atlas (prune_levels removes it again)
    bp.shrink(im, bp.ATLAS_FACTOR // bp.LEVELS[2]).save(out / 'L3' / f'{stem}.png')
    return stem, masks


def rebuild_atlas(out, meta):
    import build_map_pictures as bp
    aw, ah = bp.IMG_W // bp.ATLAS_FACTOR, bp.IMG_H // bp.ATLAS_FACTOR
    images, smalls = meta['images'], bp.atlas_cells(out)
    atlas = Image.new('RGBA', (aw * bp.ATLAS_COLS, ah * max(1, -(-len(images) // bp.ATLAS_COLS))), (0, 0, 0, 0))
    for i, e in enumerate(images):
        atlas.paste(bp.small_picture(out, e['stem'], smalls), ((i % bp.ATLAS_COLS) * aw, (i // bp.ATLAS_COLS) * ah))
    atlas.save(out / 'atlas.webp', 'WEBP', lossless=True)
    bp.prune_levels(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--maps', help='map folder names (e.g. world, bmc), comma separated (default: all)')
    ap.add_argument('--stems', help='only these pictures, comma separated')
    args = ap.parse_args()
    sys.path.insert(0, str(HERE))
    wanted = set(args.maps.split(',')) if args.maps else None
    only = set(args.stems.split(',')) if args.stems else None
    import build_map_pictures as bp
    with Pool(2, maxtasksperchild=8) as pool:
        for meta_file in bp.metas():
            out = meta_file.parent
            if wanted and out.name not in wanted:
                continue
            try:
                pieces = json.loads((out / 'pieces.json').read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            done_file = out / 'bandcut.json'
            done = set(json.loads(done_file.read_text(encoding='utf-8'))) if done_file.exists() else set()
            todo = [(out, s, m[0]) for s, m in pieces.items() if s not in done and (only is None or s in only) and m[0]]
            if not todo:
                continue
            t0, changed = time.time(), 0
            for stem, masks in pool.imap_unordered(do_one, todo):
                done.add(stem)
                if masks is not None:
                    pieces[stem] = [o if n is None else n for n, o in zip(masks, pieces[stem])] + pieces[stem][2:]   # (the masks of the black pieces, not kept as files, stay)
                    changed += 1
                if len(done) % 20 == 0:
                    done_file.write_text(json.dumps(sorted(done)), encoding='utf-8')
                    (out / 'pieces.json').write_text(json.dumps(pieces), encoding='utf-8')
            done_file.write_text(json.dumps(sorted(done)), encoding='utf-8')
            (out / 'pieces.json').write_text(json.dumps(pieces), encoding='utf-8')
            if changed:
                rebuild_atlas(out, json.loads(meta_file.read_text(encoding='utf-8')))
            print(f'{out.name}: {len(todo)} pictures, {changed} changed ({time.time() - t0:.0f} s)', flush=True)
    bp.write_index()


if __name__ == '__main__':
    main()
