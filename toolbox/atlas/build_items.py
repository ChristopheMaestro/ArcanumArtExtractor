#!/usr/bin/env python3
"""
Every item of the game, every container and what it holds, for the Atlas.

  * The item list starts from the prototypes (data/proto, types weapon .. generic). Prototypes that the player
    cannot tell apart (same name, same numbers: the S / M / L cuts of an armour) are one entry.
  * Placed items (.mob files of data/maps) that carry their own name ("Mace of Betrayal" on a mace prototype,
    every "Key to ...") are entries of their own, with their own numbers.
  * Containers: every container .mob, with the items it holds (F_CONTAINER_INVENTORY_LIST_IDX -> the item .mob
    files), its lock and the keys that open it, and the random list it rolls (Rules/InvenSource.mes).
  * NPCs that carry something and items lying on the ground, so an item can say where it is found.
  * InvenSource.mes lists (what a merchant or a container rolls), so an item can say who sells it.

Writes js/atlas/data/items.js (window.ArcanumItems) and atlas/item-icons.webp (the inventory pictures, lossless).
Needs Pillow.
"""
import json
import os
import re
import struct
from collections import defaultdict

from PIL import Image

import arcanum_objects as ao
import game_files
import sec_alias
import build_modules
import build_notices
from progress import say

DATA_JS = ao.DATA_JS
OUT_JS = DATA_JS / 'items.js'
OUT_ICONS = ao.ASSET_DIR / 'item-icons.webp'
MAPS = ao.DATA / 'maps'
WORLD = 'Arcanum1-024-fixed'

KINDS = {5: 'Weapon', 6: 'Ammunition', 7: 'Armor', 8: 'Gold', 9: 'Food & potion', 10: 'Scroll', 11: 'Key', 12: 'Key ring',
         13: 'Written', 14: 'Generic'}
WRITTEN = ['Book', 'Note', 'Newspaper', 'Telegram', 'Image', 'Schematic', 'Plaque']
WRITTEN_MES = {0: 'gamebook.mes', 1: 'gamenote.mes', 2: 'gamenewspaper.mes', 3: 'gametelegram.mes', 6: 'gameplaque.mes'}
OIF_NO_DISPLAY, OIF_IS_MAGICAL, OIF_HEXED = 0x10, 0x4, 0x40
TECHS = ['Herbology', 'Chemistry', 'Electric', 'Explosives', 'Gun Smithy', 'Mechanical', 'Smithy', 'Therapeutics']
DEGREES = ['Layman', 'Novice', 'Assistant', 'Associate', 'Technician', 'Engineer', 'Professor', 'Doctorate']
DEGREE_LEVEL = [0, 10, 20, 35, 50, 65, 80, 100]        # tech.c: the expertise a degree gives
OCOF_LOCKED, OCOF_JAMMED, OCOF_MAGICALLY_HELD, OCOF_NEVER_LOCKED, OCOF_BUSTED = 0x1, 0x2, 0x4, 0x8, 0x80
F_STORE = 294                                            # OBJ_F_NPC_SUBSTITUTE_INVENTORY: the box a merchant sells from
# containers the game tells apart by their basic prototype (descriptions.h BP_*; ui/intgame.c picks their picture by it)
BOX_KINDS = {3023: 'junk', 3033: 'safe', 3034: 'safe', 3055: 'bin', 3056: 'body', 3057: 'altar-good', 3058: 'altar-neutral',
             3059: 'altar-evil', 3060: 'plant'}
NO_AMMO = 10000
# item_inven.mes names a file that is spelled differently on disk
ART_FILE_TYPOS = {'i_elixir_of_hypnotic_suggestion.art': 'i_elixr_of_hypnotic_suggestion.ART'}


class Items:
    def __init__(self, version=None):
        """version: a game_files.Version (None = the base game with the modules' own names and texts, as items.js is built): every table, prototype
        and icon is the game's with the version's layers over it."""
        import game_files
        self.version = v = version or game_files.Version('base')
        self.base_desc = self.desc = v.descriptions()
        key_env = os.environ.get('ATLAS_VERSION', 'base')            # (the module's names and texts: base game + the mod + the module + the mod's copy of the module)
        mods = {k: (m, game_files.Version(key_env, m.name)) for k, m, _ in build_modules.entries()}
        say(f'version "{key_env}": reading the names of {len(mods)} module maps (those with their own mes/gamedesc.mes)')
        self.module_desc = {}
        for k, (m, mv) in mods.items():
            if (m / 'mes' / 'gamedesc.mes').is_file():
                self.module_desc[k] = mv.descriptions()
                say(f'   names of {k}: {len(self.module_desc[k])} entries')
        self.inven = v.mes('art', 'item', 'item_inven.mes')
        self.effects = v.mes('mes', 'item_effect.mes')
        self.item_mes = v.mes('mes', 'item.mes')
        self.intgame = v.mes('mes', 'intgame.mes')
        self.base_written = self.written = {k: v.mes('mes', f) for k, f in WRITTEN_MES.items()}
        # a module's own books, notes, newspapers... (mes/game*.mes) replace the game's for its objects
        self.module_written = {k: {s: mv.mes('mes', f) for s, f in WRITTEN_MES.items()}
                               for k, (m, mv) in mods.items() if any((m / 'mes' / f).is_file() for f in WRITTEN_MES.values())}
        self.keys = v.mes('mes', 'gamekey.mes')
        self.onames = v.mes('oemes', 'oname.mes')
        self.protos = dict(v.protos())
        self.entries, self.by_sig, self.icons = [], {}, {}

    def use(self, o):
        """Names from here on are the descriptions of the object's own module (its mes/gamedesc.mes), when it has one."""
        self.desc = self.module_desc.get(getattr(o, 'map', None), self.base_desc)
        self.written = self.module_written.get(getattr(o, 'map', None), self.base_written)

    # ---- one entry per thing the player can tell apart --------------------------------------------------------
    def name_of(self, e):
        return (self.desc.get(e.int(23)) or '').strip()

    def entry_for(self, obj, proto, unique, name=None):
        e = ao.Effective(obj, proto)
        info = self.describe(e, obj.type)
        if info is None:
            return None
        if name:
            info['name'] = name
        info['unique'] = unique
        sig = json.dumps({k: v for k, v in info.items() if k not in ('icon', 'sizes', 'unique')}, sort_keys=True)
        idx = self.by_sig.get(sig)
        if idx is None:
            idx = self.by_sig[sig] = len(self.entries)
            self.entries.append(info)
        else:
            have = self.entries[idx]
            if info.get('sizes'):
                have['sizes'] = sorted(set(have.get('sizes', [])) | set(info['sizes']), key='SML'.index)
            if have['icon'] is None:
                have['icon'] = info['icon']
            elif info.get('sizes') == ['M'] and info['icon'] is not None:   # an armour shows its medium cut
                have['icon'] = info['icon']
        return idx

    def describe(self, e, t):
        name = self.name_of(e)
        if not name:
            return None
        flags = e.int(87) & 0xFFFFFFFF
        cx = e.int(96)
        info = {'name': name, 'kind': KINDS[t], 'weight': 0 if t == 8 else e.int(89), 'worth': e.int(91),
                'magick': cx > 0 or bool(flags & OIF_IS_MAGICAL), 'tech': cx < 0, 'complexity': abs(cx),
                'hidden': bool(flags & OIF_NO_DISPLAY) or name.upper().startswith('NO GOOD'),   # placeholders
                'icon': self.icon(e.int(93))}
        if flags & OIF_HEXED:
            info['hexed'] = True
        unknown = (self.desc.get(e.int(98)) or '').strip()
        if unknown and unknown != name:
            info['unknown'] = unknown
        eff = (self.effects.get(e.int(99)) or '').strip()
        if eff:
            info['effect'] = eff
        stats = []
        tl = lambda n: self.intgame.get(n, '')
        if t == 5:
            for i, lab in ((0, 'Damage'), (4, 'Fatigue'), (1, 'Poison'), (3, 'Fire'), (2, 'Electrical')):
                lo, hi, adj = e.elem(116, i), e.elem(117, i), e.elem(118, i)
                if lo or hi or adj:
                    stats.append([lab, f'{lo}-{hi}' if hi != lo else f'{lo}', adj])
            for n, adj, lab in ((114, 115, 'To hit'), (119, 120, 'Speed'), (123, 124, 'Min. strength')):
                if e.int(n) or e.int(adj):
                    stats.append([lab, e.int(n), e.int(adj)])
            rng = e.int(121)
            if rng > 1:
                stats.append(['Range', rng, e.int(122)])
            ammo, use = e.int(125), e.int(126)
            if ammo != NO_AMMO and use > 0:
                stats.append(['Uses', f'{use} {self.item_mes.get(ammo, "ammo").lower()}', 0])
            wf = e.int(112)
            if wf & 0x4:
                info['twoHanded'] = True
            if wf & 0x10:
                info['throwable'] = True
        elif t == 7:
            cov = (e.int(93) >> 14) & 0x7
            info['slot'] = self.item_mes.get(4 + cov, '')
            if e.int(152) or e.int(153):
                stats.append(['Armor class', e.int(152), e.int(153)])
            for i, lab in ((0, 'Damage res.'), (1, 'Fire res.'), (2, 'Electrical res.'), (3, 'Poison res.'), (4, 'Magic res.')):
                if e.elem(154, i) or e.elem(155, i):
                    stats.append([lab, f'{e.elem(154, i)}%', e.elem(155, i)])
            if e.int(156) or e.int(157):
                stats.append(['Silent move', e.int(156), e.int(157)])
            if e.int(158):
                stats.append(['Unarmed damage', e.int(158), 0])
            af = e.int(150)
            sizes = [s for s, b in (('S', 1), ('M', 2), ('L', 4)) if af & b]
            if sizes:
                info['sizes'] = sizes
            if af & 0x8:
                info['gender'] = 'male'
            if af & 0x10:
                info['gender'] = 'female'
        elif t == 6:
            info['ammo'] = self.item_mes.get(e.int(143), '')
        elif t == 13:
            sub = e.int(202)
            info['written'] = WRITTEN[sub] if 0 <= sub < len(WRITTEN) else 'Written'
            text = self.text_of(sub, e.int(203), e.int(204))
            if text:
                info['text'] = text
                info['doc'] = [sub, e.int(203)]        # which .mes and which line: the Library draws it from these
        elif t == 14:
            gf, bonus = e.int(211), e.int(212)
            if gf & 0x2:
                stats.append([tl(71), f'{bonus:+d}%', 0])
            elif gf & 0x8:
                stats.append([tl(72), f'{bonus:+d}%', 0])
            if e.int(213) > 0:
                stats.append(['Uses', e.int(213), 0])
        if t in (5, 7):
            hp = e.int(27) + e.int(28)
            if hp:
                info['hp'] = hp
        if stats:
            info['stats'] = stats
        return info

    def text_of(self, sub, start, end):
        table = self.written.get(sub)
        if not table or start <= 0:
            return None
        out, k = [], start
        while k in table and (end <= start or k <= end) and len(out) < 400:
            line = table[k].replace('\r', '').strip()
            k += 1
            m = re.match(r'^(\d+)([lcr])\s*(.*)$', line, re.S) if sub in (0, 2, 6) else None
            if m:
                body = m.group(3).strip()
                if not body or re.fullmatch(r'\d+', body):         # a picture, not text
                    continue
                out.append(['h' if m.group(2) == 'c' else 'p', body])
            elif line:
                out.append(['p', line])
        return out or None

    def icon(self, aid):
        name = self.inven.get(ao.item_art_key(aid)) if aid else None
        if not name:
            return None
        name = name.strip().split()[0]
        name = ART_FILE_TYPOS.get(name.lower(), name)
        pal = ((aid & 0xFFFFFFFF) >> 4) & 0x3
        key = (name.lower(), pal)
        if key not in self.icons:
            path = self.version.path('art', 'item', name)           # (the last layer that has the file: a mod's icon wins)
            if path is None:
                hits = [p for r in reversed(self.version.roots) if (r / 'art' / 'item').is_dir() for p in (r / 'art' / 'item').iterdir() if p.name.lower() == name.lower()]
                path = hits[0] if hits else None
            frame = ao.art_first_frame(path, pal) if path else None
            self.icons[key] = {'n': len(self.icons), 'frame': frame} if frame else None
        return self.icons[key]['n'] if self.icons[key] else None

    def proto_entry(self, num):
        p = self.protos.get(num)
        if p is None or p.type not in ao.ITEM_TYPES:
            return None
        if not hasattr(self, '_proto_idx'):
            self._proto_idx = {}
        if num not in self._proto_idx:
            self._proto_idx[num] = self.entry_for(p, None, False)
        return self._proto_idx[num]

    def mob_entry(self, obj):
        proto = self.protos.get(obj.proto)
        own = obj.get(23)
        unique = own is not None and (proto is None or own != proto.get(23))
        flags = obj.get(87)          # a placed copy can be hexed (or cleansed) without a name of its own
        hexed_differs = flags is not None and proto is not None and (flags ^ (proto.get(87) or 0)) & OIF_HEXED
        title = self.own_title(obj, proto) if not unique or 4010 <= (own or 0) <= 4029 else None   # 4010-4029: "Stone", "Something Big"...
        title = title or self.recycled_name(obj, proto)
        if not unique and not hexed_differs and not title:
            return self.proto_entry(obj.proto)
        return self.entry_for(obj, proto, unique, title)

    def recycled_name(self, obj, proto):
        """A recycled prototype: the placed copy has its own unidentified name ("Amulet") but keeps the old description
        ("Dark Helm"). When only the editor name (field 22) says what the unidentified name says, it is the real name."""
        if proto is None or obj.get(98) is None or obj.get(98) == proto.get(98):
            return None
        e = ao.Effective(obj, proto)
        last = (self.desc.get(obj.get(98)) or '').lower().split()[-1:]
        raw = re.sub(r'^\s*\d+\s+', '', self.onames.get(e.int(22)) or '').strip()
        if last and last[0] in raw.lower().split() and last[0] not in self.name_of(e).lower().split():
            return raw
        return None

    def own_title(self, obj, proto):
        """A placed key or written item that carries no name of its own is still not the plain prototype: a key opens one
        lock (the game's key list, gamekey.mes, says which) and a note or book has its own text. The name the game has for
        it, else a title taken from the text."""
        e = ao.Effective(obj, proto)
        if obj.type == 14 and (self.name_of(e).lower().startswith('generic item') or 4010 <= e.int(23) <= 4029):
            # a placeholder prototype: the placed copy is only named in the editor's object names (field 22), e.g.
            # "Stillwater Giant pelt, fake" -> what the player sees is a pelt
            raw = self.onames.get(e.int(22)) or ''
            raw = re.sub(r'^\s*\d+\s+', '', raw).split(',')[0].strip()
            if raw:
                return ' '.join(w[:1].upper() + w[1:] for w in raw.split())
        if obj.type == 11:
            kid = e.int(186)
            desc = re.sub(r'\s+', ' ', self.keys.get(kid) or '').strip() if kid > 1 else ''
            if not desc:
                return None
            return desc if re.search(r'\bkey\b', desc, re.I) else f'Key to {desc}'
        if obj.type == 13:
            sub, start = e.int(202), e.int(203)
            if proto is not None and start == proto.get(203):
                return None
            text = self.text_of(sub, start, e.int(204))
            if not text:
                return None
            base = self.name_of(e)
            head = next((re.sub(r'\s+', ' ', b).strip() for k, b in text if k == 'h'), None)
            if head and len(head) <= 70:
                return head
            first = re.sub(r'\s+', ' ', text[0][1]).strip()
            words = first.split(' ')
            snippet = ' '.join(words[:6]) + ('…' if len(words) > 6 else '')
            return f'{base}: “{snippet}”'
        return None

    # ---- the icon sheet -----------------------------------------------------------------------------------------
    def write_icons(self, out=None):
        out = out or OUT_ICONS
        frames = sorted((v for v in self.icons.values() if v), key=lambda v: v['n'])
        W, x, y, row, pos = 1024, 0, 0, 0, {}
        for v in sorted(frames, key=lambda v: -v['frame'][1]):
            w, h, _ = v['frame']
            if x + w > W:
                x, y, row = 0, y + row + 1, 0
            pos[v['n']] = (x, y, w, h)
            x += w + 1
            row = max(row, h)
        sheet = Image.new('RGBA', (W, y + row + 1), (0, 0, 0, 0))
        for v in frames:
            w, h, rgba = v['frame']
            sheet.paste(Image.frombytes('RGBA', (w, h), rgba), pos[v['n']][:2])
        out.parent.mkdir(exist_ok=True)
        sheet.save(out, 'WEBP', lossless=True, quality=100, method=6)          # (the same pixels as a PNG, 40% smaller)
        self.sheet = list(sheet.size)
        return pos


def inven_sources(items):
    out = {}
    for k, v in items.version.mes('Rules', 'InvenSource.mes').items():
        if ':' not in v:
            continue
        name, rest = v.split(':', 1)
        toks = re.findall(r'(-?\d+)\s*,\s*(-?\d+)', rest)
        if not toks:
            continue
        gold = [int(toks[0][0]), int(toks[0][1])]
        lst = defaultdict(list)
        for rate, bp in toks[1:]:
            idx = items.proto_entry(int(bp) + 20)        # a basic prototype is the description number = proto - 20
            if idx is not None:
                lst[idx].append(int(rate))
        out[k] = {'name': name.strip(), 'gold': gold, 'items': [[i, r] for i, r in lst.items()]}
    # what a merchant whose box rolls list k buys from the player: item numbers, or "all"
    # (lines read {n}Name:{numbers}, the name outside the braces)
    buys = {}                                                    # (a mod's file over the game's: the later layer's line of a number wins)
    for root in items.version.roots:
        f = root / 'Rules' / 'InvenSourceBuy.mes'
        if f.is_file():
            for m in re.finditer(r'\{(\d+)\}[^{}\n]*:\s*\{([^}]*)\}', ao.read_text(f)):
                buys[int(m.group(1))] = m.group(2).strip()
    for k, rest in buys.items():
        if k in out:
            if rest.lower() == 'all':
                out[k]['buys'] = 'all'
            elif rest:
                got = []
                for tok in rest.split():
                    idx = items.proto_entry(int(tok) + 20) if tok.isdigit() else None
                    if idx is not None and idx not in got:
                        got.append(idx)
                out[k]['buys'] = got
    return out


EFFECT_WORDS = {   # game/effect.c lookup tables -> the names of mes/stat.mes and mes/skill.mes
    'st': 'Strength', 'dx': 'Dexterity', 'cn': 'Constitution', 'be': 'Beauty', 'in': 'Intelligence', 'pe': 'Perception',
    'wp': 'Willpower', 'ch': 'Charisma', 'carry': 'Carry Weight', 'damage': 'Damage Bonus', 'ac': 'AC Adjustment',
    'speed': 'Speed', 'healrate': 'Heal Rate', 'poisonrate': 'Poison Recovery', 'maxfollowers': 'Max Followers',
    'bow': 'Bow', 'dodge': 'Dodge', 'melee': 'Melee', 'throwing': 'Throwing', 'backstab': 'Backstab', 'pickpocket': 'Pick Pocket',
    'prowling': 'Prowling', 'spottrap': 'Spot Trap', 'gambling': 'Gambling', 'haggle': 'Haggle', 'heal': 'Heal',
    'persuasion': 'Persuasion', 'repair': 'Repair', 'firearms': 'Firearms', 'picklock': 'Pick Locks', 'armtrap': 'Disarm Traps',
    'resistdamage': 'Damage resistance', 'resistfire': 'Fire resistance', 'resistelectrical': 'Electrical resistance',
    'resistpoison': 'Poison resistance', 'resistmagic': 'Magick resistance', 'maxhps': 'Hit points', 'maxfatigue': 'Fatigue',
    'reaction': 'Reaction', 'crithitchance': 'Critical hit chance', 'xpgain': 'Experience gained'}
SCT_OBJ_IS_NAMED = 20


def effect_text(line):
    """An effect.mes line ("pe +1, bow +4") in words: "+1 Perception, +4 Bow"."""
    out = []
    for word, num in re.findall(r'([a-z_]+)\s*([+-]\d+%?)', line or ''):
        out.append(f'{num} {EFFECT_WORDS.get(word, word)}')
    return ', '.join(out)


class Altars:
    """What an altar wants and gives. An altar is a container of basic prototype 3057-3059 (good / neutral / evil) carrying a
    script: its description names the god ("Altar of Ter'el, the god of Wisdom"); the item it accepts is the constant of its
    "object is named" conditions (an oemes/oname.mes number = the item's OBJ_F_NAME, field 22); the blessing is the
    mes/gamebless.mes entry that names the god, whose next line is the Rules/effect.mes number of what it does."""

    def __init__(self, items, objs):
        self.items = items
        bless = items.version.mes('mes', 'gamebless.mes')
        effects = items.version.mes('Rules', 'effect.mes')
        self.blessings = []          # (text of the three lines, title, effect in words)
        for k in sorted(bless):
            if k % 10 == 0 and k + 2 in bless:
                eff = bless.get(k + 1, '').strip()
                self.blessings.append((bless[k] + ' ' + bless[k + 2], bless[k + 2].strip().rstrip('!'),
                                       effect_text(effects.get(int(eff))) if eff.isdigit() else ''))
        self.by_name = defaultdict(set)      # OBJ_F_NAME -> item entries of the prototypes
        for num, p in items.protos.items():
            if p.type in ao.ITEM_TYPES and p.get(22):
                idx = items.proto_entry(num)
                if idx is not None:
                    self.by_name[p.get(22)].add(idx)
        self.placed = defaultdict(list)      # OBJ_F_NAME -> placed items with a name of their own
        for o in objs:
            if o.type in ao.ITEM_TYPES and o.get(22):
                self.placed[o.get(22)].append(o)
        self.scripts = items.version.script_numbers()

    def named(self, n):
        """The item entries an OBJ_F_NAME stands for: prototypes, else placed items that carry it themselves."""
        got = sorted(self.by_name.get(n, ()))
        if not got:
            got = sorted({i for i in map(self.items.mob_entry, self.placed.get(n, ())) if i is not None})
        return got

    def of(self, e):
        v = e[32]
        if not isinstance(v, dict):
            return None
        own = e.int(22)
        for b in v.values():
            f = self.scripts.get(struct.unpack_from('<I', b, 8)[0]) if isinstance(b, bytes) and len(b) >= 12 else None
            if not f:
                continue
            data = f.read_bytes()
            m = re.match(r"(?:The )?Altar of ([^,]+), (.+)", data[8:48].split(b'\0')[0].decode(ao.RAW_ENC, 'replace').strip())
            if not m:
                continue
            god, title = m.group(1).strip(), m.group(2).strip()      # "Ter'el", "the god of Wisdom" / "the Stone God"
            wants = []
            count = min(struct.unpack_from('<i', data, 0x34)[0], (len(data) - 0x40) // 0x84)
            for i in range(max(count, 0)):
                o = 0x40 + i * 0x84
                typ, ot = struct.unpack_from('<i', data, o)[0], data[o + 4:o + 12]
                val = struct.unpack_from('<8i', data, o + 12)[1]
                if typ == SCT_OBJ_IS_NAMED and ot[1] == 3 and val != own:
                    wants += [i for i in self.named(val) if i not in wants]
            out = {'god': god, 'title': title}
            if wants:
                out['offering'] = wants
            key = god.replace("'", '').lower()
            hits = [b for b in self.blessings if key in b[0].replace("'", '').lower()]
            hits.sort(key=lambda b: key not in b[1].replace("'", '').lower())    # "The Blessing of <god>" before other mentions
            if hits:
                out['blessing'], out['effect'] = hits[0][1], hits[0][2]
            return out
        return None


def _actions(f):
    """[(script line, action type, operand types (8 bytes), operand values (8))] of both actions of every line of a .scr."""
    d = f.read_bytes()
    out = []
    for i in range(max(min(struct.unpack_from('<i', d, 0x34)[0], (len(d) - 0x40) // 0x84), 0) if len(d) >= 0x40 else 0):
        o = 0x40 + i * 0x84
        for a in (o + 0x2C, o + 0x58):
            out.append((i, struct.unpack_from('<i', d, a)[0], d[a + 4:a + 12], struct.unpack_from('<8i', d, a + 12)))
    return out


class ScriptGifts:
    """Items a script makes: the actions "create item" (into an object's inventory: the player, or the script's own NPC, who then
    sells, hands over or drops it) and "create object" (on the ground next to someone). Their first value is the item's basic
    prototype, like InvenSource.mes (proto = number + 20; game/proto.c sub_468860). A conversation runs a script line by jumping
    to it (a .dlg answer whose next line is -N), and the answer's effect "$$-750" is what the player pays for it.
    Who runs the script: whatever carries it on a hook (placed NPCs and things, static scenery of the .sec files, prototypes),
    also through the scripts that call it or swap it in."""
    FOCUS_PLAYER = (0, 21)               # SFO_TRIGGERER, SFO_PLAYER: straight into the player's hands
    CALLS = ('CALL_SCRIPT', 'CALL_SCRIPT_IN', 'CALL_SCRIPT_AT', 'CALL_SCRIPT_EX', 'CHANGE_SCRIPT', 'CHANGE_THIS_SCRIPT_TO_SCRIPT')
    HOOKS = {'DIALOG': 'talk', 'DIALOG_OVERRIDE': 'talk', 'DYING': 'death', 'USE': 'use', 'EXAMINE': 'look'}

    def __init__(self, items, module=None):
        """`module`: a module folder - its own scr and dlg in place of the game's (a module numbers its scripts from 1)."""
        from npc_switch import enum
        sat, self.sap = enum('ScriptActionType', 'SAT_'), enum('ScriptAttachmentPoint', 'SAP_')
        if module is None:                       # the game's, with the layers of the version over it
            self.dlg = items.version.tree('dlg')
            self.files = items.version.script_numbers()
        else:
            mv = game_files.Version(os.environ.get('ATLAS_VERSION', 'base'), module.name)      # base game + (mod) + the module + (the mod's copy of it)
            self.dlg = mv.tree('dlg')
            self.files = mv.script_numbers()
        self.makes = defaultdict(list)       # script -> [(script line, item entry, to the player)]
        self.calls = defaultdict(set)        # script -> the scripts it runs or swaps in
        for num, f in self.files.items():
            for i, t, ot, ov in _actions(f):
                name = sat[t] if 0 <= t < len(sat) else ''
                if name in ('CREATE_ITEM', 'CREATE_OBJECT', 'TRANSFORM_ATTACHEE_INTO_BASIC_PROTOTYPE') and ot[0] == 3:
                    idx = items.proto_entry(ov[0] + 20)
                    if idx is not None:
                        # a transformation makes nothing new: the script's holder turns into the item (an empty trap used on a bunny)
                        self.makes[num].append((i, idx, name[0] == 'C' and ot[1] in self.FOCUS_PLAYER, name[0] == 'T'))
                elif name in self.CALLS:
                    k = 2 if name == 'CHANGE_SCRIPT' else 0
                    if ot[k] == 3 and ov[k] in self.files and ov[k] != num:
                        self.calls[num].add(ov[k])
        self.holders = defaultdict(list)     # script -> [(hook name, object, is a prototype)]

    def hold(self, o, is_proto=False):
        v = o.get(32)
        if isinstance(v, dict):
            for k, b in v.items():
                if isinstance(b, bytes) and len(b) >= 12:
                    num = struct.unpack_from('<I', b, 8)[0]
                    if num in self.files:
                        self.holders[num].append((self.sap[k] if 0 <= k < len(self.sap) else '', o, is_proto))

    def prices(self, num):
        """script line -> the gold an answer of its conversation takes before jumping to it."""
        p = self.dlg / (self.files[num].stem + '.dlg')
        out = {}
        if p.exists():
            for m in re.finditer(r'\{\d+\}\{[^{}]*\}\{[^{}]*\}\{[^{}]*\}\{[^{}]*\}\{(-\d+)\}\{([^{}]*)\}', ao.read_text(p)):
                gold = re.search(r'\$\$\s*-(\d+)', m.group(2))
                if gold:
                    out[-int(m.group(1))] = int(gold.group(1))
        return out

    def gifts(self):
        """[(item entry, script, hook, holder object, holder is a prototype, price, to the player)] for every script that makes an
        item (holder None: nothing carries the script)."""
        callers = defaultdict(set)
        for a, targets in self.calls.items():
            for b in targets:
                callers[b].add(a)
        out = []
        for num, made in self.makes.items():
            todo, seen = [num], {num}            # the script and every script that leads to it
            while todo:
                for c in callers[todo.pop()]:
                    if c not in seen:
                        seen.add(c)
                        todo.append(c)
            held = [h for s in sorted(seen) for h in self.holders.get(s, [])]
            price = self.prices(num)
            for line, idx, to_pc, turns in made:
                for hook, o, is_proto in held or [(None, None, False)]:
                    out.append((idx, num, hook, o, is_proto, price.get(line), to_pc, turns))
        return out

    def title(self, num):
        return re.sub(r'^\d+', '', self.files[num].stem).replace('_', ' ').strip()


def recipes(items, objs):
    """Rules/schematic.mes: 2000-3999 learned with a tech degree (2000 + 200 * tech + 10 * (degree - 1)),
    4000+ found in the world as a written item of subtype Schematic whose text start line is the number.
    Item numbers are basic prototypes, like InvenSource.mes: proto = number + 20."""
    rules = items.version.mes('Rules', 'schematic.mes')
    text = items.version.mes('mes', 'schematic_text.mes')
    docs = defaultdict(set)              # schematic number -> item entries of the schematic papers
    papers = [(p, None, items.proto_entry) for p in items.protos.values() if p.type == 13]
    papers += [(o, items.protos.get(o.proto), None) for o in objs if o.type == 13]
    for o, proto, of_proto in papers:
        e = ao.Effective(o, proto)
        if e.int(202) == 5 and e.int(203) >= 4000:
            idx = of_proto(o.proto) if of_proto else items.mob_entry(o)
            if idx is not None:
                docs[e.int(203)].add(idx)

    def entries(num):
        out = []
        for tok in (rules.get(num) or '').split():
            idx = items.proto_entry(int(tok) + 20) if tok.lstrip('-').isdigit() else None
            if idx is not None and idx not in out:
                out.append(idx)
        return out

    def expertise(num):                  # schematic_ui.c: each part needs its own discipline at -complexity
        need = {}
        for tok in (rules.get(num) or '').split()[:1]:
            p = items.protos.get(int(tok) + 20)
            if p is None:
                continue
            level = -(p.get(96) or 0)
            if level > 0:
                tech = p.get(97) or 0
                deg = next(d for d, lv in enumerate(DEGREE_LEVEL) if lv >= level)
                need[tech] = max(need.get(tech, 0), deg)
        return need

    out = []
    for num in sorted(k for k in rules if k % 10 == 0 and 2000 <= k < 6000):
        makes = entries(num + 5)
        if not makes:
            continue
        r = {'name': (text.get(int(rules[num]) if rules[num].strip().isdigit() else -1) or '').strip(),
             'parts': [entries(num + 3), entries(num + 4)], 'makes': makes,
             'qty': int(rules.get(num + 6, '1').split()[0] or 1)}
        if num < 4000:
            r['tech'], r['degree'] = (num - 2000) // 200, (num - 2000) % 200 // 10 + 1
        else:
            p = items.protos.get(int(rules[num + 5].split()[0]) + 20)
            r['tech'] = (p.get(97) or 0) if p else 0
            r['found'] = sorted(docs.get(num, ()))
        need = {}
        for part in (num + 3, num + 4):
            for t, d in expertise(part).items():
                need[t] = max(need.get(t, 0), d)
        if r.get('degree') and need.get(r['tech'], 0) <= r['degree']:
            need.pop(r['tech'], None)         # the degree that teaches it already covers its own discipline
        if need:
            r['needs'] = [[t, d] for t, d in sorted(need.items())]
        out.append(r)
    return out


def main():
    say(f'reading the tables and prototypes of {ao.DATA}')
    items = Items()
    print(f'{len(items.protos)} prototypes')
    for num in sorted(items.protos):
        items.proto_entry(num)
    print(f'  {len(items.entries)} items from the prototypes')
    say('reading the .mob files of the game\'s maps')

    world_place = {}
    wl = DATA_JS / 'world-labels.js'
    if wl.exists():
        data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))
        world_place = {p['worldFolder']: p['name'] for p in data['places'] if p.get('worldFolder')}

    objs, by_oid = [], {}
    for path in sorted(MAPS.rglob('*.mob')):
        o = ao.read_mob(path)
        rel = path.relative_to(MAPS).parts
        o.map = rel[0]
        o.file = path.relative_to(MAPS).as_posix()
        o.area = rel[1] if rel[0] == WORLD and len(rel) > 2 else ''
        objs.append(o)
        by_oid[ao.oid_key(o.oid)] = o
    say(f'   {len(objs)} .mob files in the game\'s maps')
    # the modules' maps (build_modules.py) come last, so nothing of the game's own maps changes place in the lists
    for key, module, folder in build_modules.entries():
        mv = game_files.Version(os.environ.get('ATLAS_VERSION', 'base'), module.name)
        n = len(objs)
        for path in build_modules.mob_files(mv, module, folder):
            o = ao.read_mob(path)
            o.map = key
            o.file = '../' + path.relative_to(ao.DATA).as_posix()      # (the Advanced view opens it from data/maps)
            o.area = ''
            objs.append(o)
            by_oid[ao.oid_key(o.oid)] = o
        say(f'   module map {key}: {len(objs) - n} .mob files')
    print(f'{len(objs)} .mob files')

    def where(o):
        if o.map == WORLD:
            return {'world': True, 'place': world_place.get(o.area, o.area or 'Wilderness')}
        return {'world': False, 'place': ao.clean_map(o.map)}

    def contents(owner, list_field):
        got = defaultdict(int)
        for raw in (owner.get(list_field) or {}).values():
            it = by_oid.get(ao.oid_key(raw))
            if it is None or it.type not in ao.ITEM_TYPES:
                continue
            idx = items.mob_entry(it)
            if idx is None:
                continue
            qty = it.get(165) if it.type == 8 else it.get(142) if it.type == 6 else None
            if qty is None and it.type in (6, 8):
                p = items.protos.get(it.proto)
                qty = p.get(165 if it.type == 8 else 142) if p else 1
            got[idx] += qty or 1
        return [[i, q] for i, q in got.items()]

    keys = defaultdict(set)      # key id -> item entries of the keys that carry it
    for o in objs:
        if o.type == 11:
            kid = ao.Effective(o, items.protos.get(o.proto)).int(186)
            idx = items.mob_entry(o)
            if kid and idx is not None:
                keys[kid].add(idx)
    for num, p in items.protos.items():
        if p.type == 11 and p.get(186):
            idx = items.proto_entry(num)
            if idx is not None:
                keys[p.get(186)].add(idx)

    # an item listed in a container's or a character's inventory is not lying on the ground, whatever its own parent field says
    # (some keep an inventory slot, field 94, and lose the parent: the rubbish bins of Tarant are full of them)
    held = set()
    for o in objs:
        for f in (60, 238):
            if o.type in (2, 15, 16):
                held.update(ao.oid_key(raw) for raw in (o.get(f) or {}).values())
    say('reading the game\'s scripts (what containers say when examined)')
    notice_scripts = build_notices.read_scripts()
    mods_v = {k: game_files.Version(os.environ.get('ATLAS_VERSION', 'base'), m.name) for k, m, _ in build_modules.entries()}
    module_notices = {}
    for k, m, _ in build_modules.entries():
        if (m / 'scr').is_dir():
            module_notices[k] = (build_notices.read_scripts(mods_v[k].tree('scr')), mods_v[k].tree('dlg'))
            say(f'   scripts of module map {k}: {len(module_notices[k][0])}')
    say(f'containers, NPC inventories and items on the ground, from {len(objs)} objects')
    containers, npcs, ground = [], [], []
    box_at, stores = {}, []          # container id -> its index; (NPC entry, id of its store box)
    altars = Altars(items, objs)
    for o in objs:
        items.use(o)
        proto = items.protos.get(o.proto)
        e = ao.Effective(o, proto)
        if o.type == 2:
            box_at[ao.oid_key(o.oid)] = len(containers)
            flags = e.int(56) & 0xFFFFFFFF
            locked = bool(flags & OCOF_LOCKED) and not flags & (OCOF_NEVER_LOCKED | OCOF_BUSTED)
            c = {'name': (items.desc.get(e.int(23)) or 'Container').strip(), **where(o), 'tile': list(o.tile) if o.tile else None,
                 'items': contents(o, 60), 'file': o.file}
            scr_of, dlg_of = module_notices.get(o.map, (notice_scripts, None))
            for hook, num in build_notices.hooked(o):         # what it says when it is examined or used (one object, one entry; its counters pick its lines)
                if num in scr_of and 'says' not in c:
                    text = build_notices.says(scr_of, num, o, hook, mods_v[o.map].tree('scr') if o.map in module_notices else None, dlg_of)
                    if text:
                        c['says'] = text
            if locked:
                c['locked'] = e.int(57)
                ks = sorted(keys.get(e.int(58), ())) if e.int(58) else []
                if ks:
                    c['keys'] = ks
            if flags & OCOF_JAMMED:
                c['jammed'] = True
            if flags & OCOF_MAGICALLY_HELD:
                c['held'] = True
            if e.int(61) > 0:
                c['source'] = e.int(61)
            if o.proto - 20 in BOX_KINDS:          # the basic prototype: what kind of container it is (descriptions.h)
                c['kind'] = BOX_KINDS[o.proto - 20]
                if c['kind'].startswith('altar') and o.map not in module_notices:      # (an altar's script: the game's own scripts only)
                    a = altars.of(e)
                    if a:
                        c['altar'] = a
            containers.append(c)
        elif o.type in (15, 16):
            inv = contents(o, 238)
            src = e.int(239)
            store = e[F_STORE] if o.type == 16 else None
            store = store if isinstance(store, bytes) and any(store[8:24]) else None
            if inv or src > 0 or store:
                n = {'name': (items.desc.get(e.int(23)) or '').strip(), **where(o), 'tile': list(o.tile) if o.tile else None, 'items': inv}
                if src > 0:
                    n['source'] = src
                if store:
                    stores.append((len(npcs), ao.oid_key(store)))
                npcs.append(n)
        elif o.type in ao.ITEM_TYPES and not o.get(88) and o.get(94) is None and o.tile and ao.oid_key(o.oid) not in held:
            idx = items.mob_entry(o)
            if idx is not None and not items.entries[idx]['hidden']:
                qty = o.get(165) if o.type == 8 else o.get(142) if o.type == 6 else None
                ground.append({'item': idx, 'qty': qty or 1, **where(o), 'tile': list(o.tile), 'file': o.file})

    # a merchant sells from a box of their own, usually tucked away out of reach (OBJ_F_NPC_SUBSTITUTE_INVENTORY)
    for ni, key in stores:
        ci = box_at.get(key)
        if ci is not None:
            npcs[ni]['store'] = ci
            containers[ci]['storeOf'] = ni
    say(f'   {len(containers)} containers, {len(npcs)} NPCs carrying something, {len(ground)} items on the ground')
    # what scripts make: the manuals the University Bookseller sells, the telegram the Caladon operator hands over...
    say('items that scripts create: who holds the scripts (.mob, prototypes, then every .sec)')
    gifts = ScriptGifts(items)
    for o in objs:
        if o.map not in module_notices:                  # (a module numbers its scripts from 1 like the game: not the game's scripts)
            gifts.hold(o)
    for p in items.protos.values():
        gifts.hold(p, True)
    folders = [(d, d.name) for d in MAPS.iterdir() if d.is_dir()] + [(f, k) for k, _, f in build_modules.entries() if k not in module_notices]
    for folder, name in folders:
        n_sec = 0
        for sec in sec_alias.rglob(folder, '*.sec'):
            n_sec += 1
            rel = sec_alias.rel(sec, folder).parts
            for o in ao.sec_objects(sec):
                if isinstance(o.get(32), dict):
                    o.map, o.area = name, rel[0] if name == WORLD and len(rel) > 1 else ''
                    gifts.hold(o)
        if n_sec >= 200 or name == WORLD:
            say(f'   {name}: {n_sec} .sec files read')
    say(f'   .sec files of {len(folders)} maps read')
    # a module with scripts of its own: its own scripts, held by its own objects only (no prototypes: those are the game's)
    module_gifts = []
    mg_of = {}                                               # one ScriptGifts per module, whatever its number of maps
    objs_of = defaultdict(list)                              # map key -> its objects, in the order of objs (not all 50,000 looked at for each map)
    for o in objs:
        objs_of[o.map].append(o)
    for key, module, folder in build_modules.entries():
        if key in module_notices:
            mg = mg_of.setdefault(module.name, ScriptGifts(items, module))
            for o in objs_of.get(key, ()):
                mg.hold(o)
            for sec in sec_alias.rglob(folder, '*.sec'):
                for o in ao.sec_objects(sec):
                    if isinstance(o.get(32), dict):
                        o.map, o.area = key, ''
                        mg.hold(o)
            say(f'   module map {key}: its own scripts\' gifts')
    module_gifts = list(mg_of.values())
    scripted, seen_gift = [], {}
    rows = [(gifts, r) for r in sorted(gifts.gifts(), key=lambda r: r[4])]
    for mg in module_gifts:
        rows += [(mg, r) for r in sorted(mg.gifts(), key=lambda r: r[4])]
    for gifts, (idx, num, hook, o, is_proto, price, to_pc, turns) in rows:     # placed holders first
        if items.entries[idx]['hidden']:
            continue
        g = {'item': idx, 'script': gifts.title(num)}
        if o is not None:
            items.use(o)
            p = o if is_proto else items.protos.get(o.proto)
            g['name'] = (items.desc.get(ao.Effective(o, p).int(23)) or '').strip()
            if is_proto:
                g['proto'] = True        # any character or thing made from this prototype
            else:
                g.update(where(o))
                g['tile'] = list(o.tile) if o.tile else None
                if o.type in (15, 16):
                    g['npc'] = True
        if gifts.HOOKS.get(hook):
            g['when'] = gifts.HOOKS[hook]
        if to_pc:
            g['toPc'] = True
        if turns:
            g['turns'] = True        # the holder itself becomes the item
        # one row per item and holder: two script lines that make it (with and without a price) are one row, and a character
        # already listed where it stands is not listed again as "any <prototype>"
        who = json.dumps([idx, g.get('name')])
        key = who if is_proto else json.dumps([idx, g['script'], g.get('name'), g.get('place'), g.get('tile')])
        if key in seen_gift:
            if price:
                seen_gift[key].setdefault('price', price)
            continue
        if price:
            g['price'] = price
        seen_gift[key] = g
        seen_gift.setdefault(who, g)
        scripted.append(g)
    say(f'   {len(scripted)} script gifts')
    say('random lists (InvenSource), schematics, wandering creatures')
    sources = inven_sources(items)
    crafts = recipes(items, objs)
    used = {c.get('source') for c in containers + npcs} - {None}
    for s in used:
        if s in sources:
            sources[s]['used'] = True
    # creatures the world map's random encounters make (Rules/WMap_Rnd.mes, basic proto + 20) roll their list when they appear
    enc = set()
    for text in ao.read_text(ao.DATA.joinpath('Rules', 'WMap_Rnd.mes')).split('}{')[1::2]:
        enc.update(int(n) + 20 for n in re.findall(r'(?:First|Second|Third|Thrid|Fourth|Fifth):\s*(\d+)', text))
    wander = defaultdict(set)
    for num in enc:
        p = items.protos.get(num) or next((ao.read_proto(f) for f in ao.DATA.joinpath('proto').glob(f'{num:06d} - *.pro')), None)
        if p is not None and p.type in (15, 16):
            e = ao.Effective(p, None)
            if e.int(239) in sources:
                wander[e.int(239)].add((items.desc.get(e.int(23)) or '').strip())
    for s, names in wander.items():
        sources[s]['wander'] = sorted(n for n in names if n)
    say(f'the inventory pictures -> {OUT_ICONS.relative_to(ao.PROJECT)}')
    pos = items.write_icons()
    say(f'writing {OUT_JS.relative_to(ao.PROJECT)}')
    for it in items.entries:
        it['icon'] = list(pos[it['icon']]) if it['icon'] is not None and it['icon'] in pos else None

    data = {'source': 'toolbox/atlas/build_items.py', 'icons': OUT_ICONS.relative_to(ao.PROJECT).as_posix(), 'iconSheet': items.sheet,
            'note': 'items[i]: one thing the player can tell apart. containers / npcs / ground refer to items by index; '
                    'tile = [x, y] on the map named by place (world: true = the world map). sources = Rules/InvenSource.mes. '
                    'recipes = Rules/schematic.mes (tech / needs index techs; degree set = learned with that degree, '
                    'found = the schematic papers that teach it). scripted = items a script creates (.scr "create item" / '
                    '"create object"): who runs it (name + place, npc = a character, or proto: any made from that prototype; no '
                    'name = nothing in the game carries the script), when (talk / death / '
                    'use / look), price = gold the conversation takes, toPc = straight into the player\'s inventory.',
            'techs': TECHS, 'degrees': DEGREES,
            'items': items.entries, 'containers': containers, 'npcs': npcs, 'ground': ground, 'recipes': crafts, 'scripted': scripted,
            'blessings': [[t, e] for _, t, e in altars.blessings if e],
            'sources': {str(k): v for k, v in sorted(sources.items())}}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_items.py - re-run it rather than editing by hand.\n'
                      'window.ArcanumItems = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    shown = sum(1 for i in items.entries if not i['hidden'])
    print(f'  {len(items.entries)} items in all ({shown} shown, {sum(1 for i in items.entries if i["unique"])} with their own name), '
          f'{len(pos)} pictures')
    print(f'  {len(containers)} containers ({sum(1 for c in containers if c["world"])} on the world map), '
          f'{sum(1 for c in containers if c["items"])} hold items, {sum(1 for c in containers if c.get("source"))} roll a random list')
    print(f'  {len(npcs)} NPCs carry something, {len(ground)} items lie on the ground, {len(sources)} InvenSource lists')
    print(f'  {len(scripted)} script gifts ({len({g["item"] for g in scripted})} items), '
          f'{sum(1 for g in scripted if "name" not in g)} from scripts nothing carries')
    print(f'  {sum(1 for i in items.entries if i.get("hexed"))} hexed items; {len(crafts)} schematics '
          f'({sum(1 for r in crafts if "degree" in r)} learned, {sum(1 for r in crafts if r.get("found"))} found with a paper)')
    print(f'Wrote {OUT_JS.relative_to(ao.PROJECT)} ({OUT_JS.stat().st_size // 1024} KB) and {OUT_ICONS.relative_to(ao.PROJECT)}')


if __name__ == '__main__':
    main()
