#!/usr/bin/env python3
"""Writes js/editor/sec-game-protos.js: for every wall structure, door / window and scenery art the shipped sectors use,
the prototype the game places it with and the fields its objects set over that prototype.

    py toolbox/extract_game_protos.py

The game has few scenery prototypes and many arts: an object takes a generic prototype and overrides what differs -
a bed is prototype 4045 (OSCF_NO_AUTO_ANIMATE: its art's frames are variants, not an animation), blood 4048 (flat,
under all, not animated), a table 4038 (blocks), grass 4030 (OF_NO_BLOCK). An object placed with the wrong one
walks through, animates its variants or opens like a door. Read off data/maps/Arcanum1-024-fixed with the parser of
validate_sec.py. Run it again only when the maps change.
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_sec import parse_sec, protos, read_files, SecError  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MAPDIR = ROOT / 'data' / 'maps' / 'Arcanum1-024-fixed'
OUT = ROOT / 'js' / 'editor' / 'sec-game-protos.js'

# The fields a new object takes over from the game's objects of its art (Int32 only; never location, scripts, locks):
#   all: F_FLAGS 19, F_NAME 22, F_DESCRIPTION 23
#   wall: F_WALL_FLAGS 39 · portal: F_PORTAL_FLAGS 46
#   scenery: F_BLIT_FLAGS 9, F_LIGHT_FLAGS / AID / COLOR 13-15, F_SOUND_EFFECT 33, F_SCENERY_FLAGS 69, F_SCENERY_RESPAWN_DELAY 71
FIELDS = {0: (19, 39), 1: (19, 22, 23, 46), 3: (9, 13, 14, 15, 19, 22, 23, 33, 69, 71)}
BEHAVIOUR = {19, 39, 46, 69}       # what decides blocking, animating, opening
OF_DESTROYED, OF_OFF = 0x1, 0x2
OSCF_BUSTED, OSCF_NOCTURNAL, OSCF_RESPAWNING = 0x2, 0x4, 0x400
OPF_LOCKING = 0x1 | 0x4 | 0x10 | 0x20 | 0x40       # locked, magically held, always / day / night locked
OPF_NEVER_LOCKED = 0x8


def art_key(t: int, aid: int) -> int:
    if t == 0:
        return (aid >> 20) & 0xFF                                        # structure.mes number
    if t == 1:
        return ((aid >> 19) & 0x1FF) + (0 if (aid >> 10) & 1 else 1001)  # portal.mes: a window is its number + 1001
    return ((aid >> 6) & 0x1F) * 1000 + ((aid >> 19) & 0xFF)             # scenery.mes: 1000 * type + number


def clean(t: int, eff) -> bool:
    """An object in its usual state: not destroyed, off (a nocturnal light is: the game turns it on at night), busted
    or respawning."""
    if eff(19) & OF_DESTROYED or (eff(19) & OF_OFF and not (t == 3 and eff(69) & OSCF_NOCTURNAL)):
        return False
    if t == 3 and eff(69) & (OSCF_BUSTED | OSCF_RESPAWNING):
        return False
    return True


def main() -> int:
    P = protos()
    # type -> key -> (clean, state, proto) -> objects; state = the values of FIELDS[t] the object ends up with (its own,
    # else its prototype's). A door's lock is left out (a new door is not locked: no key opens it), a jammed window kept.
    seen = {t: defaultdict(Counter) for t in FIELDS}
    by_type = Counter()                                       # scenery type (key // 1000), proto -> objects
    files = 0
    paths = [p for p in sorted(MAPDIR.rglob('*.sec')) if p.name != '134217730001.sec']
    for b in read_files(paths):
        try:
            sec = parse_sec(b)
        except SecError:
            continue
        files += 1
        for o in sec['objects']:
            t = o['type']
            if t not in FIELDS or o['proto_type'] != 1 or o['proto'] not in P:
                continue
            pf, own = P[o['proto']], o['fields']
            eff = lambda f: (own[f] if f in own else pf.get(f)) or 0
            k = art_key(t, eff(1) & 0xFFFFFFFF)
            state = tuple(eff(f) & ~OPF_LOCKING if f == 46 else eff(f) for f in FIELDS[t])
            seen[t][k][(clean(t, eff), state, o['proto'])] += 1
            if t == 3:
                by_type[(k // 1000, o['proto'])] += 1

    out = {}
    for t, keys in seen.items():
        out[t] = {}
        for k, c in sorted(keys.items()):
            # how most of the game's objects of that art behave (F_FLAGS, F_SCENERY_FLAGS, F_PORTAL_FLAGS... of those in
            # their usual state, when there are any), then the state most of those are in (light, name...), then the
            # prototype most of those use; the fields are what that state sets over the prototype
            crit = [i for i, f in enumerate(FIELDS[t]) if f in BEHAVIOUR]
            behaves, states = Counter(), Counter()
            for (ok, state, _), n in c.items():
                behaves[(ok, tuple(state[i] for i in crit))] += n
            ok, how = max(behaves.items(), key=lambda kv: (kv[0][0], kv[1]))[0]
            for (ok2, state, _), n in c.items():
                if ok2 == ok and tuple(state[i] for i in crit) == how:
                    states[state] += n
            state = max(states.items(), key=lambda kv: kv[1])[0]
            num = max(((p, n) for (o2, s2, p), n in c.items() if (o2, s2) == (ok, state)), key=lambda pn: pn[1])[0]
            pf = P[num]
            over = {f: v for f, v in zip(FIELDS[t], state) if v != ((pf.get(f) or 0) & ~OPF_LOCKING if f == 46 else (pf.get(f) or 0))}
            out[t][k] = [num, over] if over else [num]
    types = {}
    for (st, num), n in by_type.items():
        if n > types.get(st, (0, 0))[1]:
            types[st] = (num, n)

    j = lambda v: json.dumps(v, separators=(',', ':'))
    lines = [
        '// GENERATED by toolbox/extract_game_protos.py from the shipped sectors - do not edit by hand.',
        '//',
        '// How the game places each art: SEC_GAME_PROTOS[objType][key] = [prototype, { field: value }], the prototype its',
        '// objects use most and the Int32 fields they set over it (F_FLAGS 19, F_SCENERY_FLAGS 69, light 13-15...). key:',
        '// wall = structure.mes number, portal = portal.mes key (window = number + 1001), scenery = scenery.mes key.',
        '// SEC_GAME_SCENERY_TYPE[type] = the prototype most used for scenery of that type (key // 1000), for arts no map uses.',
        f'export const SEC_GAME_PROTOS = {{{",".join(f"{j(str(t))}:{j({str(k): v for k, v in m.items()})}" for t, m in out.items())}}};',
        f'export const SEC_GAME_SCENERY_TYPE = {j({str(k): v[0] for k, v in sorted(types.items())})};',
        '',
    ]
    OUT.write_text('\n'.join(lines), encoding='utf-8')
    print(f'{files} sectors · {len(out[0])} wall structures, {len(out[1])} portals, {len(out[3])} scenery arts, '
          f'{len(types)} scenery types -> {OUT.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
