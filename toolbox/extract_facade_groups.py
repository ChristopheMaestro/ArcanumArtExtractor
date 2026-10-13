#!/usr/bin/env python3
"""Find the facades that are parts of one bigger thing (a boat's hull, prop and rudder; a castle's walls...).

The game's maps put such parts down together: every time facade A is stamped, facade B stands at the same offset
from it. Using the cell layouts of sec-facade-layouts.js, each map's facade tiles are first cut into stamps (the
cells whose frame offsets agree on one anchor tile), then every pair of stamps of different facades that touch is a
vote for "B is at (dx, dy) from A". A pair is kept when, among the maps that use both, that offset is the one almost
always seen; the kept pairs are joined into groups. Writes js/editor/sec-facade-groups.js.

Usage:  python extract_facade_groups.py [--report]
"""
from __future__ import annotations
import argparse, json, os, re, struct
from collections import Counter, defaultdict
from pathlib import Path

import facade_art as fa

ROOT = fa.ROOT
MAPS = ROOT / 'data' / 'maps'
LAYOUTS = ROOT / 'js' / 'editor' / 'sec-facade-layouts.js'
OUT = ROOT / 'js' / 'editor' / 'sec-facade-groups.js'
GAP = 1            # two stamps whose tiles are at most this far apart (in tiles) touch
MIN_FULL = 0.5     # a stamp counts when at least this part of its cells is present
MIN_SEEN = 1       # an offset must have been seen at least this many times...
MIN_SHARE = 0.8    # ...and be at least this share of the times A or B was stamped near the other


def read_layouts():
    out = {}
    for m in re.finditer(r'\n  (\d+): \{ src: "(\w+)", q: [\d.]+, cells: (\[.*?\]) \}', LAYOUTS.read_text(encoding='utf-8')):
        c = json.loads(m.group(3))
        out[int(m.group(1))] = {c[i]: (c[i + 1], c[i + 2]) for i in range(0, len(c), 3)}
    return out


def stamps_of_map(tiles, layouts):
    """tiles: (x, y) -> (num, frame). Returns [(num, ax, ay, cells)] for the complete stamps."""
    votes = defaultdict(set)
    for (x, y), (num, fr) in tiles.items():
        lay = layouts.get(num)
        if lay and fr in lay:
            votes[(num, x - lay[fr][0], y - lay[fr][1])].add(fr)
    out = []
    for (num, ax, ay), frames in votes.items():
        n = len(layouts[num])
        if len(frames) >= MIN_FULL * n and n > 1:
            out.append((num, ax, ay, [(ax + dx, ay + dy) for dx, dy in layouts[num].values()]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()
    layouts = read_layouts()
    names = fa.facade_names()
    seen: Counter = Counter()                                  # facade -> stamps seen next to another facade or not
    pair: dict[tuple[int, int], Counter] = defaultdict(Counter)    # (A, B) -> Counter((dx, dy))
    near_a: Counter = Counter()                                # (A, B) -> times an A stamp had a B stamp touching
    for d, _, files in os.walk(MAPS):
        secs = [f for f in files if f.endswith('.sec')]
        if not secs:
            continue
        tiles = {}
        for f in secs:
            try:
                sid = int(f[:-4])
            except ValueError:
                continue
            b = Path(d, f).read_bytes()
            to = 4 + struct.unpack_from('<I', b, 0)[0] * 0x30
            if to + 16384 > len(b):
                continue
            bx, by = (sid & 0x3FFFFFF) * 64, (sid >> 26) * 64
            for i, raw in enumerate(struct.unpack_from('<4096I', b, to)):
                if raw >> 28 == 11:
                    tiles[(bx + (i & 63), by + (i >> 6))] = (((raw >> 17) & 0xFF) | ((raw >> 19) & 0x100), (raw >> 1) & 0x3FF)
        stamps = stamps_of_map(tiles, layouts)
        if not stamps:
            continue
        cellmap = defaultdict(list)                            # tile -> stamp indices
        for si, (_, _, _, cells) in enumerate(stamps):
            for c in cells:
                cellmap[c].append(si)
        for si, (num, ax, ay, cells) in enumerate(stamps):
            seen[num] += 1
            touching = set()
            for (x, y) in cells:
                for dx in range(-GAP, GAP + 1):
                    for dy in range(-GAP, GAP + 1):
                        for sj in cellmap.get((x + dx, y + dy), ()):
                            if sj != si and stamps[sj][0] != num:
                                touching.add(sj)
            for sj in touching:
                n2, bx2, by2, _ = stamps[sj]
                pair[(num, n2)][(bx2 - ax, by2 - ay)] += 1
                near_a[(num, n2)] += 1
    edges = {}
    for (a, b), ctr in pair.items():
        (off, n), = ctr.most_common(1)
        share = n / max(seen[a], seen[b]) if max(seen[a], seen[b]) else 0
        if n >= MIN_SEEN and share >= MIN_SHARE and a < b:
            # the reverse direction must agree
            rev = pair.get((b, a), Counter()).most_common(1)
            if rev and rev[0][0] == (-off[0], -off[1]):
                edges[(a, b)] = (off, n, share)
    # join the edges into groups; a facade keeps one position per group (first edge wins on a conflict)
    parent = {}
    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for a, b in edges:
        parent[find(a)] = find(b)
    comps = defaultdict(list)
    for x in list(parent):
        comps[find(x)].append(x)
    groups = []
    for members in comps.values():
        members.sort()
        pos = {members[0]: (0, 0)}
        changed = True
        while changed:
            changed = False
            for (a, b), (off, n, s) in sorted(edges.items(), key=lambda kv: -kv[1][1]):
                if a in pos and b not in pos and b in members:
                    pos[b] = (pos[a][0] + off[0], pos[a][1] + off[1]); changed = True
                elif b in pos and a not in pos and a in members:
                    pos[a] = (pos[b][0] - off[0], pos[b][1] - off[1]); changed = True
        # all parts must have distinct cells
        # a part that lands on the others (a ramp drawn over a ship...) is not one of them: drop the worst until clear
        while len(pos) > 1:
            occ, clashes = {}, Counter()
            for num, (px, py) in pos.items():
                for dx, dy in layouts[num].values():
                    if (px + dx, py + dy) in occ:
                        clashes[num] += 1
                    occ[(px + dx, py + dy)] = num
            if sum(clashes.values()) <= 0.02 * len(occ):
                break
            del pos[clashes.most_common(1)[0][0]]
        ok = True
        if ok and len(pos) > 1:
            groups.append(pos)
        elif args.report:
            print('rejected (overlap):', [names[m] for m in members])
    groups.sort(key=lambda g: min(g))
    if args.report:
        for g in groups:
            print(', '.join(f'{names[n]}#{n}@{p}' for n, p in sorted(g.items())))
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('// GENERATED by toolbox/extract_facade_groups.py from the facades the game\'s maps stamp together. Do not edit by hand.\n')
        fh.write('// Each group is the parts of one bigger thing: [facade number, dx, dy, ...] - tile offsets of each part\'s first cell.\n')
        fh.write('export const SEC_FACADE_GROUPS = [\n')
        for g in groups:
            fh.write('  ' + json.dumps([v for n, p in sorted(g.items()) for v in (n, p[0], p[1])], separators=(',', ':')) + ',\n')
        fh.write('];\n')
    print(f'{len(groups)} groups, {sum(len(g) for g in groups)} facades -> {OUT}')


if __name__ == '__main__':
    main()

