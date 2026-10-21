#!/usr/bin/env python3
"""Work out how the cells of every facade fit together, for the editor's Facade tool.

A facade (art/facade/*.ART) is one big picture cut into diamond cells, but the order of the cells in the ART file is
NOT a plain grid (Mountain_03 runs in zig-zags, others in several blocks...), and nothing in the file says where a
cell goes. The game's own maps do: they stamp the cells next to each other. So:

  1. every map under data/maps is read; each time two cells of a facade stand on neighbouring tiles that is one vote
     for "cell B is at (+1,0) / (-1,0) / (0,+1) / (0,-1) from cell A";
  2. the cells are put down from the first one, taking the best-voted neighbour first (a facade stamped in a different
     orientation somewhere is simply out-voted);
  3. cells the maps never put next to a placed one (or a facade the maps never use) are placed by their pictures: the
     cell whose border continues its neighbours' best (facade_art.seam);
  4. each layout gets a quality: the mean colour difference across all its internal borders (lower = more seamless).

Tile offsets are the same (x, y) the sectors store: world x grows to the screen's lower-left, y to its lower-right.
Writes js/editor/sec-facade-layouts.js.

Usage:  python extract_facade_layouts.py [--max-guess 150]
"""
from __future__ import annotations
import argparse, heapq, json, os
from collections import Counter, defaultdict
from pathlib import Path

import facade_art as fa

ROOT = fa.ROOT
MAPS = ROOT / 'data' / 'maps'
OUT = ROOT / 'js' / 'editor' / 'sec-facade-layouts.js'
ART_TYPE_FACADE = 11


def collect_votes():
    """num -> Counter((frameA, frameB, dx, dy)) over all maps, and num -> number of maps using it."""
    votes: dict[int, Counter] = defaultdict(Counter)
    used: Counter = Counter()
    for d, _, files in os.walk(MAPS):
        secs = [f for f in files if f.endswith('.sec')]
        if not secs:
            continue
        at: dict[int, dict[tuple[int, int], int]] = defaultdict(dict)    # num -> (x, y) -> frame
        sids = {}
        for f in secs:
            try:
                sids[f] = int(f[:-4])
            except ValueError:
                continue
        for sid, b in zip(sids.values(), fa.read_files(Path(d, f) for f in sids)):
            ft = fa.facade_tiles(b)             # (the tiles of art type ART_TYPE_FACADE)
            if ft is None:
                continue
            bx, by = (sid & 0x3FFFFFF) * 64, (sid >> 26) * 64
            for i, raw in zip(*ft):
                num = ((raw >> 17) & 0xFF) | ((raw >> 19) & 0x100)
                at[num][(bx + (i & 63), by + (i >> 6))] = (raw >> 1) & 0x3FF
        for num, pts in at.items():
            used[num] += 1
            v = votes[num]
            for (x, y), a in pts.items():
                for dx, dy in fa.NEIGHBOURS:
                    b = pts.get((x + dx, y + dy))
                    if b is not None and b != a:
                        v[(a, b, dx, dy)] += 1
    return votes, used


def place_from_votes(frames, votes):
    by_a = defaultdict(list)
    for (a, b, dx, dy), n in votes.items():
        if a in frames and b in frames:
            by_a[a].append((n, b, dx, dy))
    # start from the lowest frame the maps put next to another one (frame 0 may never be stamped)
    first = min(by_a) if by_a else min(frames)
    out: dict[int, tuple[int, int]] = {first: (0, 0)}
    occ = {(0, 0): first}
    heap = []
    def push(a):
        for n, b, dx, dy in by_a[a]:
            heapq.heappush(heap, (-n, a, b, dx, dy))
    push(first)
    while heap:
        _, a, b, dx, dy = heapq.heappop(heap)
        if b in out:
            continue
        pos = (out[a][0] + dx, out[a][1] + dy)
        if pos in occ:
            continue
        out[b] = pos; occ[pos] = b
        push(b)
    return out


def place_from_seams(cells, out):
    """Add the frames of `cells` missing from `out` (frame -> (x, y)), best-fitting border first."""
    if not out:
        first = min(cells); out[first] = (0, 0)
    occ = {p: f for f, p in out.items()}
    cache: dict[tuple[int, int, int, int], float] = {}
    def seam(a, b, n):
        k = (a, b, n[0], n[1])
        if k not in cache:
            cache[k] = fa.seam(cells[a], cells[b], n[0], n[1])[0]
        return cache[k]
    todo = set(cells) - set(out)
    # per frontier cell: (its placed neighbours, score of every frame, the best frame) - kept until those neighbours
    # change (a frame placed next to it) or its best frame is placed elsewhere, as only then does its choice change
    memo: dict[tuple[int, int], tuple[list, dict, float, int]] = {}
    while todo:
        frontier = {}
        for f, (x, y) in out.items():
            for n in fa.NEIGHBOURS:
                c = (x + n[0], y + n[1])
                if c not in occ:
                    frontier.setdefault(c, []).append((f, n))
        best = None
        for c, nbrs in frontier.items():
            m = memo.get(c)
            if m is None or m[0] != nbrs:
                # a cell touching several placed cells is the most informative
                scores = {u: sum(seam(f, u, n) for f, n in nbrs) / len(nbrs) - 2.0 * len(nbrs) for u in todo}
                m = None
            else:
                scores = m[1]
            if m is None or m[3] not in todo:
                # the first frame (in the order of `todo`) with the lowest score, as a scan of every pair picks
                cb = None
                for u in todo:
                    if cb is None or scores[u] < cb[0]:
                        cb = (scores[u], u)
                m = memo[c] = (nbrs, scores, cb[0], cb[1])
            if best is None or m[2] < best[0]:
                best = (m[2], m[3], c)
        _, u, c = best
        out[u] = c; occ[c] = u; todo.discard(u)


def quality(cells, layout):
    occ = {p: f for f, p in layout.items()}
    tot, n = 0.0, 0
    for f, (x, y) in layout.items():
        for dx, dy in ((1, 0), (0, 1)):
            g = occ.get((x + dx, y + dy))
            if g is not None:
                s, k = fa.seam(cells[f], cells[g], dx, dy)
                if k:
                    tot += s; n += 1
    return tot / n if n else 255.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-guess', type=int, default=150, help='largest unused facade to place by pictures alone')
    args = ap.parse_args()
    names = fa.facade_names()
    print('reading maps...', flush=True)
    votes, used = collect_votes()
    result = {}
    for num in sorted(names):
        cells = fa.load_cells(names[num])
        if not cells:
            print(f'#{num} {names[num]}: no art'); continue
        frames = set(cells)
        if num in votes:
            layout = place_from_votes(frames, votes[num]); src = 'm'
            if len(layout) < len(frames):
                place_from_seams(cells, layout); src = 'ms'
        elif len(frames) <= args.max_guess:
            layout = {}; place_from_seams(cells, layout); src = 's'
        else:
            print(f'#{num} {names[num]}: {len(frames)} cells, not in any map - skipped'); continue
        q = quality(cells, layout)
        result[num] = {'src': src, 'q': round(q, 1), 'maps': used.get(num, 0),
                       'cells': [v for f in sorted(layout) for v in (f, layout[f][0], layout[f][1])]}
        print(f'#{num} {names[num]}: {len(frames)} cells  {src}  quality {q:.1f}', flush=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('// GENERATED by toolbox/extract_facade_layouts.py from the facades stamped in data/maps. Do not edit by hand.\n')
        fh.write('// facade number -> { src: m = from the maps, ms = maps + borders, s = borders only (a guess), q: mean border\n')
        fh.write('// difference (lower = more seamless), cells: flat [frame, dx, dy, ...] - tile offsets from the first frame }\n')
        fh.write('export const SEC_FACADE_LAYOUTS = {\n')
        for num, r in result.items():
            fh.write(f'  {num}: {{ src: {json.dumps(r["src"])}, q: {r["q"]}, cells: {json.dumps(r["cells"], separators=(",", ":"))} }},\n')
        fh.write('};\n')
    print(f'wrote {OUT} ({len(result)} facades)')


if __name__ == '__main__':
    main()
