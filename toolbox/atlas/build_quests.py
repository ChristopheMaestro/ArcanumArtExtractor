"""
Every quest of the game, step by step, from the game's own text and scripts: no hand-made quest list.

Writes js/atlas/data/quests.js (window.ArcanumQuests); the Quests page and the people on the map read it. Re-run rather than edit:
  py build_quests.py            (about two minutes: it reads every .mob and .sec of data/maps to find who carries a script)

Where it all comes from
  mes/gamequestlog.mes   the logbook sentence of each quest (1000-1164). Rules/gamequest.mes: the quest's experience level and
                         alignment change; Rules/xp_quest.mes: the experience of a level.
  dlg/*.dlg + scr/*.scr  a quest changes state in two places: a dialog line whose effects contain "qu <quest> <state>" (dialog.c
                         sub_415BA0), and a script action "set pc quest state" / "set quest global state" (ids 16 and 17 of the
                         script table). States: 1 mentioned, 2 accepted, 3 achieved, 4 completed, 5 completed by someone else, 6 botched.
                         A dialog line gated by "qu/qa <quest> <state>" is a place where the quest goes on.
  data/maps (.mob/.sec)  field 32 holds the scripts an object carries (12-byte element per attachment point, script number at +8).
                         A dialog or script number is matched to whoever carries it, which gives the person or object and its tile.
  global flags           the deed that makes a quest giver pay out (the king dies, an item is picked up) is a script that sets a global flag the
                         giver's dialog line or heartbeat script tests (data/scr/global_flags.json, toolbox/gen_global_flags.py). Whoever
                         carries the script that sets it is added as an objective (step 2b).
  items                  a line that asks for or takes an item ("in N": a test, an effect; N is the object-name number of mes/oname.mes) makes
                         picking that item up a part of the quest, at the place on the maps where the item lies.
  script swaps           "change script" / "change this script to script": Bates's dialog is put on him by his heartbeat script, so the
                         carriers of the first script also carry the second (add_swapped).
Steps are ordered by the quest state they happen in: receive the quest (1-2) < talk during the quest (2-3) < reach the goal (3) <
finish (4). The title of a quest is written here (QUEST_TITLES) because the game only has the logbook sentence.
"""
import difflib
import json
import re
import struct
import sys
from pathlib import Path

import arcanum_objects as ao

ROOT = Path(__file__).resolve().parents[2]
DATA_JS = ROOT / 'js' / 'atlas' / 'data'                   # the generated data the pages load
DATA = ao.DATA
MAPS = DATA / 'maps'
WORLD = 'Arcanum1-024-fixed'
OUT_JS = DATA_JS / 'quests.js'
F_NAME, F_SCRIPTS = 23, 32
F_OBJ_FLAGS, OF_OFF = 19, 0x2          # OBJ_F_FLAGS: off until a script turns it on
NPC = 16
DIALOG_POINTS = (9, 31)           # DIALOG, DIALOG_OVERRIDE
ATTACH = ['EXAMINE', 'USE', 'DESTROY', 'UNLOCK', 'GET', 'DROP', 'THROW', 'HIT', 'MISS', 'DIALOG', 'FIRST_HEARTBEAT', 'CATCHING_THIEF_PC',
          'DYING', 'ENTER_COMBAT', 'EXIT_COMBAT', 'START_COMBAT', 'END_COMBAT', 'BUY_OBJECT', 'RESURRECT', 'HEARTBEAT', 'LEADER_KILLING',
          'INSERT_ITEM', 'WILL_KOS', 'TAKING_DAMAGE', 'WIELD_ON', 'WIELD_OFF', 'CRITTER_HITS', 'NEW_SECTOR', 'REMOVE_ITEM',
          'LEADER_SLEEPING', 'BUST', 'DIALOG_OVERRIDE', 'TRANSFER', 'CAUGHT_THIEF', 'CRITICAL_HIT', 'CRITICAL_MISS']
# what the player does to make a script on that attachment point run
VERB = {0: 'Examine', 1: 'Use', 2: 'Destroy', 3: 'Unlock', 4: 'Pick up', 5: 'Drop', 6: 'Throw', 7: 'Fight', 8: 'Fight', 9: 'Talk to',
        10: 'Go to', 12: 'Defeat', 13: 'Fight', 17: 'Buy from', 19: 'Go near', 21: 'Put the item in', 27: 'Go to', 28: 'Take from',
        31: 'Talk to'}
STATE_NAME = ['unknown', 'mentioned', 'accepted', 'achieved', 'completed', 'completed by someone else', 'botched']
TRAINING = ['', 'Apprentice', 'Expert', 'Master']

# Titles. The game only has one logbook sentence per quest; these say what the quest is about in a few words.
QUEST_TITLES = {
    1: "Mrs. Randolph's Ancient Tome", 1000: 'Taxes of Black Root', 1001: "The King's Lost Daughter", 1002: 'The Death of Prince Farad',
    1003: "Gladys's Family Ring", 1004: 'The Bow of Ecclesiates', 1005: "The Mayor's Stolen Dagger", 1006: 'Robbing the Hedgewizard',
    1007: 'Poison from Grunwalde', 1008: "Theodore's Improved Plate", 1009: "The Halfling's Game", 1010: 'Origins of the Strange Ring',
    1011: 'Inquiry at P. Schuyler & Sons', 1012: 'Gilbert Bates and the Ring', 1013: 'Reporting the Mine Clues to Bates',
    1014: 'Searching the Black Mountain Mines', 1015: 'The Black Mountain Clan on the Isle of Despair', 1016: 'Fate of the Black Mountain Clan',
    1017: 'The Wheel Clan Inquiry', 1018: 'The Elven Village of Qintarra', 1019: "Clearing Falcon's Ache", 1020: 'The Village of the Dark Elves',
    1021: 'Renford A. Terwilliger', 1022: 'Horror Among the Dark Elves', 1023: 'Who Is Arronax?', 1024: 'Finding Nasrudin',
    1025: 'The Massacre at Stillwater', 1026: 'An Audience with K\'an Hua', 1027: "The Vendigroth Device for K'an Hua", 1028: 'To the Ring of Brodgar',
    1029: 'The Hunt for Arronax', 1030: 'Defeating Kerghan', 1031: 'Joining Kerghan', 1032: 'Clearing the Bridge Thieves',
    1033: 'Sabotaging the New Bridge', 1034: 'Destroying the Steam Engine', 1035: 'Repairing the Steam Engine', 1036: 'Pure Ore for Lloyd',
    1037: "Ristezze's Camera", 1038: "Milly's Lost Grandpa", 1039: 'Evidence Against Bates', 1040: 'The Factory Saboteurs',
    1041: "Sabotaging Bates's Prototype", 1042: "Thorvald's Imprisonment", 1043: "The Stillwater Giant's Pelt", 1044: "Ogdin's Book, The Hand",
    1046: 'M\'in Gorad of the Dark Elves', 1047: "Weldo's Missing Part", 1048: 'Finding Victor Misk', 1049: 'A Piece of Nasrudin',
    1050: 'Rescuing Tollo Underhill', 1051: 'The Vendigroth Device for Nasrudin', 1052: 'The Misk Betrayal', 1053: 'The Bogaroth',
    1054: "Stringy Pete's Treasure", 1055: 'The Desecrated Altar of Vooriden', 1056: 'The Bangellian Scourge', 1057: 'Freeing Arronax',
    1058: 'A Package from Dernholm', 1059: 'The Payroll Heist', 1060: 'The Bank Robbery', 1061: 'A Note for Low Dervish Row',
    1062: 'The Elven Funerary Stone', 1063: 'Kerghan and Persephone', 1064: 'Stealing the Crystal Ball', 1065: 'Delivering the Crystal Ball',
    1066: 'Joining the Thieves Underground', 1067: 'The Tarantian Sewer Map', 1068: "Matthew's Wedding Ring", 1069: 'Skulls of the Ren\'ar Twins',
    1070: 'Goods for Maximillian', 1071: 'The Sorcerous Beast', 1072: 'Maximillian Still Lives', 1073: 'Treasures of Shades Beach',
    1074: "Cynthia's Escape", 1075: 'The Ashbury Cemetery Mystery', 1076: 'The Ashbury Town Council', 1077: 'Mithril of the Wheel Clan',
    1078: 'Escort Swyft to Tarant', 1079: 'The Lost Elven Hunter', 1080: 'Poachers for Kan Kerai', 1081: "Wrath's Killer",
    1082: 'Essence of the Vol\'ars Wisp', 1083: "The Innkeeper's Strong Box", 1084: "Muggs's Debt", 1085: 'A Crate of Ale',
    1086: "Caleb's Whiskey Shipment", 1087: 'Revenge on Treat', 1089: 'Pollock Wants Darian Maug Dead', 1090: 'Darian Maug Wants Pollock Dead',
    1091: 'Erland of the Stonecutters', 1092: 'Heirloom of the Dredge', 1093: 'The Durin Stone', 1094: 'A Fool in His Underwear',
    1095: 'The Idol of Geshtianna', 1096: 'Cyrus the Missing Friend', 1097: "Azram's Star", 1098: 'Caladon and the Unified Kingdom',
    1099: 'Trap Master Training', 1100: 'The Whytechurch Murderer', 1101: "The Staff of K'an T'au", 1102: 'Breaking Morgan Out of Prison',
    1103: 'The Blade of Xerxes', 1104: 'Assassinating King Farad', 1105: "The Dodge Master's Request", 1106: "The Haggle Master's Price",
    1107: 'The Golden Idol of Kree', 1108: 'Gambling Lessons', 1109: 'The Great Ruby', 1110: 'The Master of Prowling',
    1111: 'Stop Arronax', 1112: 'Tools for the Locksmith', 1113: 'The Willbecker Gang', 1114: 'Lady Druella', 1115: 'Healing Adkin Chambers',
    1116: 'The Eyes of Garrick Stout', 1117: "Theo's Wild Pigs", 1118: "Theo's Boulders", 1119: 'Finding Liam Cameron', 1120: "Liam's Portal",
    1121: 'A Package for Mrs. Morgan', 1122: "The Adept Wizard's Book", 1123: 'The Necklace of Queen K\'na S\'ea', 1124: 'Hot Jewels for Adam Maxwell',
    1125: "Cassie's Necklace", 1126: "Mr. Langley's Debt", 1127: 'A Gift for Mrs. Halster', 1128: 'The Medallion of Beauty',
    1129: 'Service for Mr. Franklin', 1130: 'Finding Sir Matt de Cesare', 1131: 'Rats in the Warehouses', 1132: "Wilhemina's Fate",
    1133: "Wilhemina's Tombstone", 1134: 'Payment for Mrs. Halster', 1135: 'Photograph of the Lethe Wyvern', 1136: "Ryan's Father",
    1137: 'What Kills the Rabbits', 1138: "Cynthia Wit's Curse", 1139: "Pelojian's Spirit", 1140: "T'val N'or and the Ogre Slaves",
    1141: 'Proof of Flight', 1142: 'The Gem of Water Purification', 1143: 'Half Ogre Island', 1144: 'The Orc Uprising: Kill Donn Throgg',
    1145: 'The Orc Uprising: Make Donn Surrender', 1146: 'The Orc Uprising: Slip Away', 1150: "The Platinum Chalice of Fa'al Kin",
    1151: 'A New Altar Stone', 1152: "Freeing Percival's Mother", 1153: 'Master Thrower Training', 1154: 'Skulls for Sir Matt',
    1155: 'Skulls for Arthur Tyron', 1156: 'Death in the Wheel Clan Mines', 1157: 'Planting the Heirloom', 1158: 'The Curse of Charles Brehgo',
    1159: "Arbalah's Sacred Artifact", 1160: "The Amulet of N'Tala", 1161: "Sebastian's Request: Pollok", 1162: "Sebastian's Request: Darien Maug",
    1163: 'The Bessie Toone Mine', 1164: 'Maximillian Still Lives (Lianna)',
}
MAIN = {1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1020, 1021, 1022, 1023, 1024, 1026, 1027, 1028, 1029, 1030, 1031,
        1042, 1046, 1049, 1051, 1053, 1057, 1103, 1111}      # my first guess, kept only to print what the StoryState rule changes
MASTER = {1004, 1099, 1101, 1102, 1105, 1106, 1108, 1110, 1112, 1114, 1115, 1116, 1153}
HIDDEN = {1045, 1088}     # "DUPLICATE DO NOT USE" and "NO LONGER A QUEST"
STOP = {'that', 'with', 'this', 'from', 'have', 'wants', 'want', 'will', 'your', 'their', 'them', 'into', 'been', 'what', 'then', 'help'}
SAME_QUEST = 0.2         # share of the words of two logbook sentences that makes one quest the older version of the other
GF = re.compile(r'(?<![a-z])gf\s*(\d+)\s+(-?\d+)', re.I)      # "gf2224 1" in a dialog line: global flag 2224 must be / is made 1
F_ONAME = 22               # the object-name number: what a dialog's "in N" means (mes/oname.mes), not the prototype number
ITEM_TYPES = range(5, 15)  # weapon .. generic: things the player can pick up
ITEM_WANT, ITEM_SPOTS = set(), {}     # item name numbers a quest asks for -> where they lie (filled by find_carriers)
ITEM_SPOTS_MAX = 8        # an item lying in more places than this is a commodity, not a quest item
FLAGS_PER_SCRIPT_MAX = 3
FLAG_SETTERS_MAX = 4    # a global flag that more scripts than this set is not a quest's own


# ---- the games's code strings ("qu1000 2, $$ 200") -----------------------------------------------------------------
def parse_codes(s):
    """dialog.c: skip to a letter or '$', read two characters, atoi the number after them (a second number is read after the first)."""
    out, i, n = [], 0, len(s or '')
    s = s or ''

    def atoi(j):
        m = re.match(r'\s*([+-]?\d+)', s[j:])
        return int(m.group(1)) if m else 0

    def second(j):
        while j < n and s[j].isspace():
            j += 1
        while j < n and s[j].isdigit():
            j += 1
        return atoi(j)

    while i < n:
        while i < n and not re.match(r'[A-Za-z$]', s[i]):
            i += 1
        if i + 1 >= n:
            break
        code = s[i:i + 2].lower()
        i += 2
        out.append((code, atoi(i), second(i)))
        while i < n and not re.match(r'[A-Za-z$]', s[i]):
            i += 1
    return out


def clean(t):
    return re.sub(r'\s+', ' ', t or '').strip()


# ---- dialogs ---------------------------------------------------------------------------------------------------------
def script_number(name):
    m = re.match(r'(\d+)', name)
    return int(m.group(1)) if m else None


def load_dialogs():
    """script number -> {line number: {pc, text, test, goto, effect, parent}} (an answer's parent is the line it is offered under)."""
    out = {}
    for f in sorted((DATA / 'dlg').glob('*.dlg')):
        n = script_number(f.name)
        lines, last_npc = {}, None
        for raw in f.read_text(encoding='cp1252', errors='replace').splitlines():
            raw = raw.strip()
            if not raw.startswith('{') or not raw.endswith('}'):
                continue
            parts = raw[1:-1].split('}{')
            if len(parts) < 7 or not parts[0].lstrip('-').isdigit():
                continue
            num = int(parts[0])
            pc = parts[3].strip() != ''
            line = {'pc': pc, 'text': clean(parts[1]), 'test': parts[4], 'goto': parts[5].strip(), 'effect': parts[6], 'parent': None}
            if pc:
                line['parent'] = last_npc
            else:
                last_npc = num
            lines[num] = line
        out[n] = lines
    return out


# ---- scripts -----------------------------------------------------------------------------------------------------------
def load_scripts():
    """script number -> {description, ops: [(kind, quest, state)]} for the scripts that set a quest state with fixed numbers."""
    out = {}
    for f in sorted((DATA / 'scr').glob('*.scr')):
        n = script_number(f.name)
        b = f.read_bytes()
        if len(b) < 0x40:
            continue
        desc = b[8:48].split(b'\0')[0].decode('cp1252', 'replace').strip()
        count = min(struct.unpack_from('<i', b, 0x34)[0], (len(b) - 0x40) // 0x84)
        ops, story, swaps = [], [], []
        for i in range(max(count, 0)):
            o = 0x40 + i * 0x84
            for off in (0x2C, 0x58):
                typ = struct.unpack_from('<i', b, o + off)[0]
                ot = b[o + off + 4:o + off + 12]
                ov = struct.unpack_from('<8i', b, o + off + 12)
                # 16 = set pc quest state (obj, quest, state), 17 = set quest global state (quest, state); a fixed number has type 3
                if typ == 16 and ot[1] == 3 and ot[2] == 3:
                    ops.append((ov[1], ov[2]))
                elif typ == 17 and ot[0] == 3 and ot[1] == 3:
                    ops.append((ov[0], ov[1]))
                elif typ == 43 and ot[0] == 3:      # set story state (number)
                    story.append(ov[0])
                elif typ == 6 and ot[0] == 3:       # change this script to script (number)
                    swaps.append((None, ov[0]))
                elif typ == 99 and ot[0] == 1 and ot[1] == 3 and ot[2] == 3:      # change script (attachee, attachment point, script)
                    swaps.append((ov[1], ov[2]))
        out[n] = {'desc': desc, 'name': f.stem, 'ops': ops, 'story': story, 'swaps': swaps}
    return out


def add_swapped(carriers, scripts):
    """A script often swaps itself for another one ("change script" / "change this script to script"): Gilbert Bates carries no dialog
    of his own, his heartbeat script puts it on him once the story has moved on. Whoever carries the first script then carries the second."""
    for _ in range(3):
        for src, sc in scripts.items():
            for point, target in sc['swaps']:
                have = carriers.setdefault(target, [])
                for c in list(carriers.get(src, [])):
                    d = dict(c, point=c['point'] if point is None else point)
                    if not any(x['oid'] == d['oid'] and x['map'] == d['map'] and x['point'] == d['point'] and x['tile'] == d['tile']
                               and x['mtile'] == d['mtile'] for x in have):
                        have.append(d)
    return carriers


def make_people(who, sc, has_dialog, where):
    """The people / objects a step names: the carriers of a script, the ones with a dialog first, at most four (and how many more)."""
    actors, seen = [], set()
    for c in who:
        key = (c['place'], tuple(c['tile'] or []), c['name'], c['point'])
        if key not in seen:
            seen.add(key)
            actors.append(c)
    actors.sort(key=lambda a: (not a['world'], a['type'] != NPC))
    dialog_actors = [a for a in actors if a['point'] in DIALOG_POINTS]
    pool = dialog_actors or actors
    shown = pool[:4]
    people = []
    for a in shown:
        p = {'name': a['name'] or sc['desc'] or 'Someone', 'place': a['place'], 'world': 1 if a['world'] else 0, 'tile': a['tile'],
             'verb': VERB.get(a['point'], 'Go to'), 'npc': 1 if a['type'] == NPC else 0}
        if not a['world']:
            p['mtile'] = a['mtile']          # the tile on its own map (the atlas draws that map)
            near = where.find(a['map'])
            if near:
                p['near'] = near
        people.append(p)
    if not people and sc['desc'] and has_dialog:
        people = [{'name': sc['desc'], 'place': '', 'world': 0, 'tile': None, 'verb': 'Talk to', 'npc': 1}]
    return people, max(0, len(pool) - len(shown))


def flag_links():
    """(script number -> global flags that script tests, flag -> [(script number, 'scr' | 'dlg')] that set it), from
    data/scr/global_flags.json (toolbox/gen_global_flags.py: scripts, and dialog lines with "gf N V"). The tests of a dialog are
    read line by line instead (GF)."""
    path = DATA / 'scr' / 'global_flags.json'
    flags = json.loads(path.read_text(encoding='utf-8'))['flags']
    tested, setters = {}, {}
    for f, d in flags.items():
        f = int(f)
        for file, line, role in d.get('scr', []):
            n = script_number(file)
            if role in ('read', 'test'):
                tested.setdefault(n, set()).add(f)
            elif role in ('set', 'write') and (n, 'scr') not in setters.get(f, []):
                setters.setdefault(f, []).append((n, 'scr'))
        for file, num, role, value, speaker, text in d.get('dlg', []):
            n = script_number(file)
            if role != 'test' and value and (n, 'dlg') not in setters.get(f, []):
                setters.setdefault(f, []).append((n, 'dlg'))
    return tested, setters


def sc_name(scripts, n):
    return scripts.get(n, {}).get('name', n)


def pretty_map(folder):
    """A map folder's name as a place name: 'Dernholm-Castle' -> 'Dernholm Castle', 'PSchuylers Lev 3-fixed' -> 'PSchuylers Level 3'."""
    s = re.sub(r'-fixed$', '', folder).replace('Lev ', 'Level ').strip()
    return s if s.startswith("T'sen") else re.sub(r'(?<=[a-z])-(?=[A-Z])', ' ', s)


# ---- who carries a script ----------------------------------------------------------------------------------------------
def find_carriers(wanted, protos, desc, world_place):
    """script number -> [{map, place, world, type, name, tile, point}] over every object of data/maps."""
    carriers = {}

    def note(o, rel, proto):
        e = ao.Effective(o, proto)
        if ITEM_WANT and o.type in ITEM_TYPES and e.int(F_ONAME) in ITEM_WANT:       # an item a quest asks for, lying somewhere
            world = rel[0] == WORLD
            ITEM_SPOTS.setdefault(e.int(F_ONAME), []).append({
                'oid': str(o.oid), 'off': 0, 'map': rel[0], 'type': o.type, 'name': clean(desc.get(e.int(F_NAME)) or ''), 'point': 4,
                'place': world_place.get(rel[1] if len(rel) > 2 else '', rel[1] if len(rel) > 2 else 'Wilderness') if world else pretty_map(rel[0]),
                'world': world, 'tile': list(o.tile) if o.tile and world else None, 'mtile': list(o.tile) if o.tile and not world else None})
        v = e[F_SCRIPTS]
        if not isinstance(v, dict):
            return
        for point, b in v.items():
            if not (isinstance(b, (bytes, bytearray)) and len(b) >= 12):
                continue
            n = struct.unpack_from('<I', b, 8)[0]
            if wanted is not None and n not in wanted:
                continue
            area = rel[1] if len(rel) > 2 else ''
            world = rel[0] == WORLD
            place = world_place.get(area, area or 'Wilderness') if world else pretty_map(rel[0])
            name = clean(desc.get(e.int(F_NAME)) or '')
            carriers.setdefault(n, []).append({'oid': str(o.oid), 'off': 1 if e.int(F_OBJ_FLAGS) & OF_OFF else 0, 'map': rel[0], 'place': place, 'world': world, 'type': o.type, 'name': name,
                                                'tile': list(o.tile) if o.tile and world else None,
                                                'mtile': list(o.tile) if o.tile and not world else None, 'point': point})

    for path in sorted(MAPS.rglob('*.mob')):
        o = ao.read_mob(path)
        note(o, path.relative_to(MAPS).parts, protos.get(o.proto))
    for path in sorted(MAPS.rglob('*.sec')):
        try:
            objs = ao.sec_objects(path)
        except Exception:
            continue
        for o in objs:
            note(o, path.relative_to(MAPS).parts, protos.get(o.proto))
    return carriers


# ---- assembling ----------------------------------------------------------------------------------------------------------
class Names:
    """Item, skill and reputation names for the effects of a line."""

    def __init__(self):
        self.desc = ao.descriptions()
        oname = ao.mes(DATA / 'oemes' / 'oname.mes')
        self.oname = {k: re.sub(r'^\s*\d+\s+', '', v) for k, v in oname.items()}
        self.skill = ao.mes(DATA / 'mes' / 'skill.mes')
        self.rep = ao.mes(DATA / 'mes' / 'gamereplog.mes')
        self.area = ao.mes(DATA / 'mes' / 'gamearea.mes')

    def item(self, n):
        return clean(self.desc.get(n) or self.oname.get(n) or '') or 'an item'

    def reputation(self, n):
        s = clean(self.rep.get(n, ''))
        return re.split(r'(?<=[.!])\s', s)[0] if s else ''

    def place(self, n):
        m = re.search(r'/([^/]*)/', self.area.get(n, ''))
        return clean(m.group(1)) if m else ''


def effects(codes, names):
    """What a line's effects give the player, in words: gold, items, training, reputation, followers."""
    out = {'gold': [], 'give': [], 'take': [], 'extra': []}
    for code, v, w in codes:
        if code == '$$':
            if v > 0:
                out['gold'].append(v)
        elif code == 'in':
            (out['give'] if v < 0 else out['take']).append(names.item(abs(v)))
        elif code == 'tr' and w > 0:
            out['extra'].append(f"{TRAINING[w] if w < len(TRAINING) else ''} training in {names.skill.get(v, 'a skill')}".strip())
        elif code == 'rp':
            r = names.reputation(abs(v))
            if r:
                out['extra'].append(('Reputation: ' if v > 0 else 'Lose the reputation: ') + r.rstrip('.'))
        elif code == 'jo':
            out['extra'].append('Joins you as a follower')
        elif code == 'mm':
            p = names.place(v)
            out['extra'].append(f'{p} is marked on your map' if p else 'A place is marked on your map')
        elif code == 'fp':
            out['extra'].append('A fate point')
        elif code == 'xp':
            out['extra'].append(f'Bonus experience (level {v})')
        elif code == 'nk':
            out['extra'].append('The person dies')
        elif code == 'co':
            out['extra'].append('The person attacks you')
    return out


def merge_fx(a, b):
    for k in ('give', 'take', 'extra'):
        for x in b[k]:
            if x not in a[k]:
                a[k].append(x)
    a['gold'] += [g for g in b['gold'] if g not in a['gold']]


def role_of(state):
    return {1: 'start', 2: 'start', 3: 'goal', 4: 'done', 5: 'other', 6: 'fail'}.get(state)


ORDER = {'start': 2, 'talk': 2.6, 'goal': 3, 'done': 4, 'other': 5, 'fail': 6}


def main():
    names = Names()
    qlog = ao.mes(DATA / 'mes' / 'gamequestlog.mes')
    meta = {}
    for q, s in ao.mes(DATA / 'Rules' / 'gamequest.mes').items():
        p = s.split()
        meta[q] = (int(p[0]), int(p[1]))
    xp_levels = {k: int(v) for k, v in ao.mes(DATA / 'Rules' / 'xp_quest.mes').items()}
    dialogs, scripts = load_dialogs(), load_scripts()
    quest_ids = sorted(q for q in qlog if q not in HIDDEN and (q >= 1000 or q in QUEST_TITLES) and q in QUEST_TITLES)

    # 1. which scripts say something about which quest
    by_script = {}   # (script, quest) -> {'sets': {state: [(line, how)]}, 'gates': [(state, line)]}
    for n, lines in dialogs.items():
        for num, ln in lines.items():
            for code, v, w in parse_codes(ln['effect']):
                if code == 'qu' and v in quest_ids and 0 < w <= 6:
                    by_script.setdefault((n, v), {'sets': {}, 'gates': []})['sets'].setdefault(w, []).append(num)
            for code, v, w in parse_codes(ln['test']):
                if code in ('qu', 'qa') and v in quest_ids and w in (1, 2, 3):
                    by_script.setdefault((n, v), {'sets': {}, 'gates': []})['gates'].append((w, num))
    for n, sc in scripts.items():
        for q, state in sc['ops']:
            if q in quest_ids and 0 < state <= 6:
                by_script.setdefault((n, q), {'sets': {}, 'gates': []})['sets'].setdefault(state, []).append(None)

    # 1b. the story states a quest sets: a main quest is one that moves the StoryState on (dialog effect "ss N", script action 43)
    story_of = {}      # quest -> {story state: 'where'}
    for n, lines in dialogs.items():
        script_ss = set()
        for num, ln in lines.items():
            codes = parse_codes(ln['effect'])
            resp = lines.get(int(ln['goto'])) if ln['pc'] and re.fullmatch(r'\d+', ln['goto'] or '') else None
            if resp:
                codes += parse_codes(resp['effect'])
            ss = {v for c, v, w in codes if c == 'ss' and v >= 0}
            script_ss |= ss
            # a line often touches several quests (finishes one, mentions another): the story moves on with the one it finishes
            sets = {}
            for c, v, w in codes:
                if c == 'qu' and v in quest_ids and 0 < w <= 6:
                    sets[v] = max(sets.get(v, 0), w)
            top = max(sets.values(), default=0)
            for q in [q for q, w in sets.items() if w == top]:
                for s in ss:
                    story_of.setdefault(q, {}).setdefault(s, []).append(f'dlg {n} line {num}')
    for n, sc in scripts.items():       # a script (a book, a note, a death) that sets a quest and the story state
        if sc['story']:
            sets = {}
            for q, state in sc['ops']:
                if q in quest_ids and 0 < state <= 6:
                    sets[q] = max(sets.get(q, 0), state)
            top = max(sets.values(), default=0)
            for q in [q for q, w in sets.items() if w == top]:
                for s in sc['story']:
                    story_of.setdefault(q, {}).setdefault(s, []).append(f'scr {n}')
    # a story state that nothing quest-related sets (a talk that only says "go to Thanatos") continues the quest that reached the state before it;
    # when several did, the one that also reaches the state after it; still several: left alone
    seen = {s for d in story_of.values() for s in d}
    orphans = {s for lines in dialogs.values() for ln in lines.values() for c, s, w in parse_codes(ln['effect']) if c == 'ss' and s > 0}
    orphans |= {s for sc in scripts.values() for s in sc['story']}
    for s in sorted(orphans - seen):
        prev = [q for q, d in story_of.items() if s - 1 in d]
        if len(prev) > 1:
            prev = [q for q in prev if s + 1 in story_of[q]]
        if len(prev) == 1:
            story_of[prev[0]].setdefault(s, []).append('story only')
            print(f'story state {s} has no quest of its own, goes to {prev[0]}')
        else:
            print(f'story state {s} has no quest of its own, left unassigned ({len(prev)} candidates)')
    print('story states by quest:', {q: sorted(d) for q, d in sorted(story_of.items())})
    print('  was main by hand, sets no story state:', sorted(MAIN - set(story_of)), '| sets one, was not main:', sorted(set(story_of) - MAIN))

    protos = {}
    for p in (DATA / 'proto').rglob('*.pro'):
        o = ao.read_proto(p)
        protos[o.proto] = o
    world_place = {}
    wl = DATA_JS / 'world-labels.js'
    if wl.exists():
        data = json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))
        world_place = {p['worldFolder']: p['name'] for p in data['places'] if p.get('worldFolder')}
    print(f'{len(by_script)} (script, quest) pairs; reading the maps for who carries every script...')
    # the items a quest's lines ask for or take ("in N" in a test / an effect): picking them up is a part of the quest, unless the quest hands them over
    quest_items, handed = {}, {}
    for (n, q), info in by_script.items():
        nums = {num for s in info['sets'].values() for num in s if num is not None} | {num for s, num in info['gates']}
        for num in nums:
            ln = dialogs.get(n, {}).get(num)
            if not ln:
                continue
            for code, v, w in parse_codes(ln['test']) + parse_codes(ln['effect']):
                if code == 'in' and v:
                    (handed if v < 0 else quest_items).setdefault(q, []).append(abs(v))
    quest_items = {q: [k for k in dict.fromkeys(l) if k not in handed.get(q, ())] for q, l in quest_items.items()}
    ITEM_WANT.update(k for l in quest_items.values() for k in l)
    carriers = add_swapped(find_carriers(None, protos, names.desc, world_place), scripts)
    print(f'{len(carriers)} scripts are carried by something')

    # 2. one candidate step per (script, role)
    wl_data = load_world_labels()
    where = Entrances(wl_data)
    quests = {q: [] for q in quest_ids}
    dropped = []
    for (n, q), info in sorted(by_script.items()):
        lines = dialogs.get(n, {})
        who = carriers.get(n, [])
        sc = scripts.get(n, {'desc': '', 'name': ''})
        if not who and re.search(r'test', sc['name'] + ' ' + sc['desc'], re.I):
            dropped.append(n)       # the developers' test scripts
            continue
        roles = {}
        for state, nums in info['sets'].items():
            roles.setdefault(role_of(state), []).append((state, nums))
        gate_states = sorted({s for s, _ in info['gates']})
        if not any(r in roles for r in ('start', 'goal', 'done')) and gate_states:
            roles['talk'] = [(gate_states[0], [num for s, num in info['gates'] if s == gate_states[0]])]
        for role, groups in roles.items():
            if role in (None, 'other'):
                continue
            groups.sort()
            state = groups[0][0]
            fx = {'gold': [], 'give': [], 'take': [], 'extra': []}
            ask = npc_say = opt_say = ''
            for st, nums in groups[::-1]:    # (a quest is accepted, 2, after it is mentioned, 1)
                for num in nums:
                    ln = lines.get(num)
                    if not ln:
                        continue
                    merge_fx(fx, effects(parse_codes(ln['effect']), names))
                    if ln['pc']:
                        resp = lines.get(int(ln['goto'])) if re.fullmatch(r'\d+', ln['goto'] or '') else None
                        if resp:
                            merge_fx(fx, effects(parse_codes(resp['effect']), names))
                        parent = lines.get(ln['parent']) if ln['parent'] is not None else None
                        if not ask and not re.match(r'^[A-Z]:', ln['text']):
                            ask = ln['text']
                        opt_say = opt_say or (resp or parent or {}).get('text', '')
                    else:
                        npc_say = npc_say or ln['text']
            say = npc_say or opt_say
            if role == 'talk':   # lines that only check the quest: what they ask for
                for st, nums in groups:
                    for num in nums:
                        ln = lines.get(num)
                        for code, v, w in parse_codes(ln['test'] if ln else ''):
                            if code == 'in' and v > 0 and names.item(v) not in fx['take']:
                                fx['take'].append(names.item(v))
            people, more = make_people(who, sc, bool(lines), where)
            if not people:
                continue
            quests[q].append({'role': role, 'state': state, 'script': n, 'say': clean_text(say), 'ask': clean_text(ask), 'fx': fx,
                              'who': people, 'more': more})

    # 2b. global flags. A part of a quest is often a deed, not a conversation: the king dies, his death script sets a global flag, the
    # quest giver's heartbeat script sees it and the giver now pays out. So every flag that a script of the quest (or of whoever carries
    # it) or a dialog line of the quest tests is followed back to the scripts and dialogs that set it, and whoever carries those is a part.
    tested, setters = flag_links()
    def okey(c):        # (a sector's objects do not all have their own id)
        return c['map'], c['oid'], tuple(c['tile'] or c['mtile'] or ())
    carried = {}        # object -> the scripts it carries
    for n, cs in carriers.items():
        for c in cs:
            carried.setdefault(okey(c), set()).add(n)
    chain = {}          # quest -> [(flag, script, kind)] printed at the end for review
    for q in quest_ids:
        # the flags that gate the goal or the finish: the ones tested by the dialog line that sets state 3 / 4 (and the line it answers),
        # and the ones tested by the other scripts of whoever carries that line (a heartbeat script that swaps in the paying-out dialog)
        gates, mine = {}, set()
        for (n, qq), info in by_script.items():
            if qq != q:
                continue
            mine.add(n)
            if not info['sets'].keys() & {3, 4}:
                continue
            lines = dialogs.get(n, {})
            for state in (3, 4):
                for num in info['sets'].get(state, []):
                    ln = lines.get(num)
                    parent = lines.get(ln['parent']) if ln and ln['parent'] is not None else None
                    for l in (ln, parent):
                        fl = {int(f) for f, v in GF.findall(l['test'] if l else '') if int(v)}
                        if len(fl) <= FLAGS_PER_SCRIPT_MAX:
                            for f in fl:
                                gates.setdefault(f, (n, False))
            for c in carriers.get(n, []):
                for m in carried[okey(c)] - {n}:
                    mine.add(m)
                    # someone switched off from the start (the giver who pays out) is switched on by a script once a flag says so. One
                    # that stays on only counts when the flag is set by a deed (a heartbeat script may well switch him off instead).
                    # A script that tests dozens of flags is a general one (a guard, a citizen).
                    if len(tested.get(m, ())) <= FLAGS_PER_SCRIPT_MAX:
                        for f in tested.get(m, ()):
                            if f not in gates or (gates[f][1] and c.get('off')):
                                gates[f] = (m, not c.get('off'))
        for f in sorted(gates):
            sets = setters.get(f, [])
            if not sets or len(sets) > FLAG_SETTERS_MAX:
                continue          # a flag set all over the game says nothing about this quest
            for n, kind in sets:
                if n in mine or any(s['script'] == n for s in quests[q]) or (kind == 'dlg' and gates[f][1]):
                    continue
                who = carriers.get(n, [])
                sc = scripts.get(n, {'desc': '', 'name': ''})
                if not who and re.search(r'test', sc['name'] + ' ' + sc['desc'], re.I):
                    continue
                people, more = make_people(who, sc, kind == 'dlg', where)
                if not people:
                    continue
                quests[q].append({'role': 'goal', 'state': 3, 'script': n, 'say': '', 'ask': '', 'chain': True,
                                  'fx': {'gold': [], 'give': [], 'take': [], 'extra': []}, 'who': people, 'more': more})
                chain.setdefault(q, []).append((f, n, kind))
    for q, items in sorted(quest_items.items()):
        for k in items:
            spots = ITEM_SPOTS.get(k, [])
            if not spots or len(spots) > ITEM_SPOTS_MAX or re.search(r'\b(door|shutters?)\b', names.item(k), re.I):   # (a few names are shared with scenery)
                continue
            people, more = make_people(spots, {'desc': names.item(k)}, False, where)
            for p in people:
                p['name'] = names.item(k)
            quests[q].append({'role': 'goal', 'state': 3, 'script': 1000000 + k, 'say': '', 'ask': '', 'chain': True,
                              'fx': {'gold': [], 'give': [], 'take': [], 'extra': []}, 'who': people, 'more': more})
            print(f'  item part: {q} {QUEST_TITLES[q]} <- pick up {names.item(k)} ({len(spots)} places)')
    print('parts added through global flags:')
    for q, l in sorted(chain.items()):
        print('  ', q, QUEST_TITLES[q], '<-', [(f, sc_name(scripts, n), k) for f, n, k in l])

    # 3. build the final quests
    out_q = []
    for q in quest_ids:
        steps = quests[q]
        level, align = meta.get(q, (1, 0))
        log = clean(qlog.get(q, ''))
        # lines that only mention the quest in passing do not make a quest: it needs a start, a goal or a finish
        if not {s['role'] for s in steps if not s.get('chain')} & {'start', 'goal', 'done'}:
            steps = [s for s in steps if s['role'] == 'fail']
        # several people can start it (the game mentions it in many conversations): the one named in the logbook sentence gives it
        starts = [s for s in steps if s['role'] == 'start']
        logwords = set(re.findall(r"[a-z']{3,}", log.lower()))

        def named(s):
            return any(set(re.findall(r"[a-z']{3,}", w['name'].lower())) & logwords - {'the', 'and'} for w in s['who'])
        if len(starts) > 1 and any(named(s) for s in starts):
            for s in starts:
                if not named(s):
                    s['role'] = 'talk'
        steps.sort(key=lambda s: (ORDER[s['role']], s['state'], s['script']))
        merged = []
        for s in steps:
            f = s['fx']
            b = {'role': s['role'], 'state': s['state'], 'who': s['who'], 'more': s['more'], 'say': s['say'], 'ask': s['ask'],
                 'gold': [min(f['gold']), max(f['gold'])] if f['gold'] else [], 'give': f['give'][:6], 'take': f['take'][:6], 'extra': f['extra'][:5]}
            twin = next((m for m in merged if m['role'] == b['role'] and [w['name'] for w in m['who']] == [w['name'] for w in b['who']]), None)
            if twin:       # the same people twice (another conversation of theirs): one step
                for k in ('give', 'take', 'extra'):
                    twin[k] = list(dict.fromkeys(twin[k] + b[k]))
                twin['gold'] = twin['gold'] or b['gold']
                twin['say'] = twin['say'] or b['say']
                twin['ask'] = twin['ask'] or b['ask']
            else:
                merged.append(b)
        story = sorted(story_of.get(q, {}))
        kind = 'main' if story else 'master' if q in MASTER else 'side'     # a quest that moves the StoryState on is a main quest
        giver = next((w for m in merged if m['role'] in ('start', 'talk', 'goal', 'done') for w in m['who']), None)
        done = [m for m in merged if m['role'] == 'done']
        golds = [g for m in done for g in m['gold']]
        reward = {'xp': xp_levels.get(level, 0), 'level': level, 'align': align, 'gold': [min(golds), max(golds)] if golds else [],
                  'items': list(dict.fromkeys(x for m in done for x in m['give'])), 'extra': list(dict.fromkeys(x for m in done for x in m['extra']))}
        out_q.append({'id': q, 'title': QUEST_TITLES[q], 'log': log, 'kind': kind, 'story': story, 'unused': 0 if any(m['role'] != 'fail' for m in merged) else 1,
                      'giver': giver, 'steps': merged, 'reward': reward})
    # a quest nothing starts is often an older version of one the game does use ("Breaking Morgan Out of Prison" became "Tools for the
    # Locksmith"): the used quest whose logbook sentence shares the most words says which one the player met instead
    def words(q):
        return {w for w in re.findall(r"[a-z']{4,}", q['log'].lower()) if w not in STOP}
    live = [q for q in out_q if not q['unused']]
    for q in out_q:
        if q['unused'] and q['log']:
            w = words(q)
            score, best = max(((len(w & words(o)) / max(1, len(w | words(o))), o) for o in live if o['log']), key=lambda t: t[0])
            print(f"  unused {q['id']} {q['title']}: closest {best['id']} {best['title']} ({score:.2f}, {len(w & words(best))} words)")
            if score >= SAME_QUEST and len(w & words(best)) >= 3:
                q['sameAs'] = best['id']
    note = ('storyStates[n] =the game\'s sentence for story state n (mes/StoryState.mes). '
            'quests[i] = {id, title, log (the logbook sentence), kind (main = it sets a story state; master / side), story (the story states it sets), unused (1 = nothing in the game starts it), '
            'sameAs (of an unused one: the quest in use that tells the same errand), giver '
            '(first person met), steps: [{role (start / talk / goal / done / fail), state, who: [{name, place, world (1 = on the world map), tile, verb, '
            'npc, near: {place, tile, name} (for a place that is a separate map: its entrance)}], more, say, ask, gold [min, max], give, take, extra}], '
            'reward: {xp, level, align, gold [min, max], items, extra}}')
    story_text = {k: clean(v) for k, v in ao.mes(DATA / 'mes' / 'StoryState.mes').items()}
    js = {'source': 'toolbox/atlas/build_quests.py', 'note': note, 'storyStates': [story_text.get(i, '') for i in range(max(story_text) + 1)],
          'quests': out_q}
    OUT_JS.write_text('// GENERATED by toolbox/atlas/build_quests.py - re-run it rather than editing by hand.\nwindow.ArcanumQuests = '
                      + json.dumps(js, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    used = [q for q in out_q if not q['unused']]
    print(f'Wrote {OUT_JS.name}: {len(out_q)} quests, {len(used)} with steps ({OUT_JS.stat().st_size // 1024} KB); test scripts left out: {dropped}')
    print('  nothing starts them:', [q['id'] for q in out_q if q['unused']])
    print('  no first person:', [q['id'] for q in used if not q['giver']])
    nw = sorted({(w['place'], (w.get('near') or {}).get('name', '-')) for q in out_q for s in q['steps'] for w in s['who'] if not w['world']})
    print('  places that are separate maps -> entrance:')
    for p, e in nw:
        print('    ', p, '->', e)


def clean_text(t):
    return clean((t or '').replace('@pcname@', 'adventurer'))[:260]


def load_world_labels():
    wl = DATA_JS / 'world-labels.js'
    return json.loads(re.search(r'=\s*(\{.*\})\s*;\s*$', wl.read_text(encoding='utf-8'), re.S).group(1))


def norm(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())


class Entrances:
    """A place that is a separate map (a castle, a cave, a basement) -> the spot on the world map where one walks in."""

    def __init__(self, wl):
        self.cands = []
        for p in wl['places']:
            for l in p['labels']:
                t = l.get('targetMapFilename')
                if t and l.get('tile'):
                    self.cands.append((norm(t), l['tile'], p['name'], l['text'], 2))
        for p in wl['places']:
            if p.get('view'):
                self.cands.append((norm(p['name']), p['view'], p['name'], p['name'], 1))
        self.cache = {}

    def find(self, folder):
        if folder in self.cache:
            return self.cache[folder]
        m = norm(re.sub(r'-fixed$', '', folder).replace('Lev ', 'Level '))
        best, best_score = None, 0
        for nm, tile, place, text, kind in self.cands:
            if len(nm) < 4:
                continue
            score = difflib.SequenceMatcher(None, m, nm).ratio()
            if nm in m or m in nm:
                score = max(score, 0.7 + 0.2 * min(len(nm), len(m)) / max(len(nm), len(m)))
            score += 0.02 * kind
            if score > best_score:
                best, best_score = (tile, place, text), score
        out = {'place': best[1], 'tile': best[0], 'name': best[2]} if best and best_score >= 0.72 else None
        self.cache[folder] = out
        return out


if __name__ == '__main__':
    sys.exit(main())
