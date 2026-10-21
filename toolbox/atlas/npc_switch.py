"""
What switches a character on.

A character the game places switched off (OF_OFF, field 19 of the .mob) is not there at the start. Reading how the game runs
its scripts (game/script.c, monstergen.c) there are three kinds:

  * a person who comes in later. A script on the character (usually a heartbeat) tests something - the story state, a global
    flag a deed or a conversation set, the state of a quest, a rumour, the time of day - and then toggles the state of its
    attachee (action "toggle state", focus object 1). The first script often swaps itself for the real one first ("change
    script" / "change this script to script", or "call script"), so those are followed too. This reads the scripts the way the
    game runs them: from line 0, a line tests its condition and runs the action (GOTO / RETURN / ...) or the "else" action,
    and every path that reaches a toggle of the attachee gives the conditions that must hold on the way there.
  * a spawner. An NPC with ONF_GENERATOR (field 280 bit 0x80000) is switched off and invulnerable on purpose: it is never seen,
    the game copies it next to itself (OBJ_F_NPC_GENERATOR_DATA, field 301: how many at a time, how many in all, which
    generator number, when) and a script may stop or start the generator by its number ("toggle monster generator").
  * a stand-in. A character that is never switched on and whose scripts act on other things (lock a door, start a glow,
    change a bit of scenery): it is only the place where the game keeps such a script. (Scripts that toggle something else
    by name - the "loop over everything near me" ones - only name scenery, never a character.)

Used by build_npcs.py and build_submaps.py:  Switches().explain(effective NPC) -> 1 / "conditions" / {k, t, w}.
Switches().why(e) is only the "conditions" part ("Story state 4 or later"), "" when unknown.
"""
import json
import re
import struct
from itertools import combinations
from pathlib import Path

import arcanum_objects as ao

ROOT = Path(__file__).resolve().parents[2]
F_NAME, F_SCRIPTS, F_NPC_FLAGS, F_GENERATOR = 23, 32, 280, 301
ONF_GENERATOR = 0x80000
SFO_ATTACHEE = 1
SVT_COUNTER, SVT_GL_VAR, SVT_LC_VAR, SVT_NUMBER, SVT_GL_FLAG = 0, 1, 2, 3, 4
MAX_NODES = 4000                  # a script is walked line by line along every path; this stops the odd one that branches wildly
MAX_DEPTH = 4                     # scripts that swap in other scripts that swap in others...
MAX_ALTERNATIVES = 4
QUEST_STATE = ['unknown', 'mentioned', 'accepted', 'achieved', 'completed', 'completed by someone else', 'botched']
RATE = ['second', 'half minute', 'minute', 'hour', 'day', 'week', 'month', 'year']
# what a script does to other things than itself, in a few words (the stand-ins' text)
OTHER_VERBS = {
    'SET_LOCK_STATE': 'locks or unlocks a door', 'TOGGLE_OPEN_CLOSED': 'opens or closes something',
    'CHANGE_ART_NUM': 'changes how something nearby looks', 'PLAY_SCRIPT_EYE_CANDY': 'starts a glow or an effect',
    'STOP_SCRIPT_EYE_CANDY': 'stops a glow or an effect', 'CREATE_OBJECT': 'creates something', 'CREATE_ITEM': 'creates an item',
    'DESTROY': 'removes something', 'KILL': 'kills someone', 'TELEPORT': 'moves someone away', 'FADE_AND_TELEPORT': 'moves you elsewhere',
    'TOGGLE_SECTOR_BLOCKED': 'opens or shuts a way through', 'SET_STORY_STATE': 'moves the story on',
    'ATTACK': 'sets people nearby on you', 'CAST_SPELL': 'casts a spell', 'CAST_SPELL_ON': 'casts a spell',
    'TOGGLE_MONSTER_GENERATOR': 'starts or stops a spawner',
}


def enum(name, prefix):
    txt = (ROOT / 'toolbox' / 'Arcanum CE sources' / 'game' / 'script.h').read_text(encoding='utf-8', errors='replace')
    body = re.search(r'typedef enum ' + name + r' \{(.*?)\}', txt, re.S).group(1)
    return [x.strip().rstrip(',')[len(prefix):] for x in body.split('\n') if x.strip().startswith(prefix)]


def cut(s, n=70):
    s = re.sub(r'\s+', ' ', s).strip()
    return s if len(s) <= n else s[:n].rstrip() + '…'


def _script_lines(f):
    """[[condition, action, else action], ...] of a script: (type, [operand types], [operand values]) each."""
    d = f.read_bytes()
    out = []
    for i in range(max(min(struct.unpack_from('<i', d, 0x34)[0], (len(d) - 0x40) // 0x84), 0)):
        o = 0x40 + i * 0x84
        part = []
        for off in (0, 0x2C, 0x58):
            t = struct.unpack_from('<i', d, o + off)[0]
            part.append((t, list(d[o + off + 4:o + off + 12]), list(struct.unpack_from('<8i', d, o + off + 12))))
        out.append(part)
    return out


class Switches:
    def __init__(self, module=None, version=None):
        """`module`: a module folder - its own scr, dlg and names. A module's flag and quest numbers are its own, which no table
        here knows: a flag then reads "flag N is set", a quest "quest N".
        `version`: a game_files.Version (a mod, a module over the game): scripts, dialogs, flags and tables with every layer over the game's."""
        self.sat, self.sct = enum('ScriptActionType', 'SAT_'), enum('ScriptConditionType', 'SCT_')
        self.module = module
        if version is not None:
            self.dlg = version.tree('dlg')
            self.files = version.script_numbers()
            if version.module:                       # a module's flag and quest numbers are its own, which no table here knows
                self.flags, self.names, self.quests = {}, {}, {}
            else:
                flags = version.global_flags()
                self.flags, self.names = flags['flags'], flags['scripts']
                import build_quests
                self.quests = build_quests.QUEST_TITLES
            self.oname = {k: re.sub(r'^\s*\d+\s+', '', v).strip() for k, v in version.mes('oemes', 'oname.mes').items()}
            self.rumours = version.mes('mes', 'game_rd_npc_m2m.mes')
            self.desc = version.descriptions()
            self.cache, self._paths, self._sig = {}, {}, None
            self.gen_cache = None
            return
        self.dlg = (module or ao.DATA) / 'dlg'
        self.files = {}
        for f in ((module or ao.DATA) / 'scr').glob('*.scr'):
            m = re.match(r'(\d+)', f.name)
            if m:
                self.files[int(m.group(1))] = f
        if module:
            self.flags, self.names, self.quests = {}, {}, {}
        else:
            flags = json.loads((ao.DATA / 'scr' / 'global_flags.json').read_text(encoding='utf-8'))
            self.flags, self.names = flags['flags'], flags['scripts']
            import build_quests
            self.quests = build_quests.QUEST_TITLES
        oname = ao.mes(ao.DATA / 'oemes' / 'oname.mes')
        self.oname = {k: re.sub(r'^\s*\d+\s+', '', v).strip() for k, v in oname.items()}
        self.rumours = ao.mes(ao.DATA / 'mes' / 'game_rd_npc_m2m.mes')
        self.desc = ao.descriptions(module)
        self.cache, self._paths, self._sig = {}, {}, None
        self.gen_cache = None

    # ---- a script as lines -------------------------------------------------------------------------------------------
    def lines(self, num):
        if num not in self.cache:
            import game_files
            self.cache[num] = game_files.parse_file(self.files[num], 'switch-lines', _script_lines)     # (each file read once, kept between runs)
        return self.cache[num]

    def title(self, num):
        """The script's name as the game's list has it ("Geoffrey Tile Level1")."""
        return re.sub(r'^\d+', '', self.files[num].stem).replace('_', ' ').strip() if num in self.files else f'script {num}'

    # ---- values -------------------------------------------------------------------------------------------------------
    @staticmethod
    def value(var, optype, opval, counters):
        if optype == SVT_NUMBER:
            return ('num', opval)
        if optype == SVT_COUNTER:
            return ('num', counters[opval]) if 0 <= opval < 4 else ('?', 0)
        if optype == SVT_LC_VAR:
            return var.get(opval, ('?', 0))
        if optype == SVT_GL_FLAG:
            return ('flag', opval)
        if optype == SVT_GL_VAR:
            return ('gvar', opval)
        return ('?', 0)

    def num(self, var, optype, opval, counters):
        v = self.value(var, optype, opval, counters)
        return v[1] if v[0] == 'num' else None

    # ---- walking a script ----------------------------------------------------------------------------------------------
    def run(self, num, counters, depth=0, start=0, seen=None):
        """Walks a script. Returns (own, others): own = [[condition, ...], ...] for every path that toggles the attachee (also through
        the scripts it swaps in); others = [(phrase, [condition, ...])] for what it does to other things."""
        own, others = [], []
        seen = seen if seen is not None else set()
        if num not in self.files or depth > MAX_DEPTH or (num, start) in seen:
            return own, others
        seen = seen | {(num, start)}
        lines = self.lines(num)
        budget = [MAX_NODES]

        def walk(i, var, cons, steps):
            budget[0] -= 1
            if not (0 <= i < len(lines)) or steps > 60 or budget[0] < 0:
                return
            cond, act, els = lines[i]
            ctype = self.sct[cond[0]] if 0 <= cond[0] < len(self.sct) else '?'
            for a, outcome in ([(act, None)] if ctype == 'TRUE' else [(act, True), (els, False)]):
                # the character starts switched off: "is it switched off?" is yes, so the other way is a path it never takes
                if ctype == 'OBJ_IS_SWITCHED_OFF' and cond[1][0] == SFO_ATTACHEE and outcome is False:
                    continue
                v2, c2 = dict(var), list(cons)
                if outcome is not None:
                    c2 += self.describe(ctype, cond, outcome, v2, counters)
                nxt = self.act(a, v2, counters, c2, own, others, depth, seen)
                if nxt is not None:
                    walk(i + 1 if nxt is True else nxt, v2, c2, steps + 1)

        walk(start, {}, [], 0)
        return own, others

    def act(self, a, var, counters, cons, own, others, depth, seen):
        """Runs an action: the next line (True, or a line number), or None when the script stops here."""
        t, ot, ov = a
        name = self.sat[t] if 0 <= t < len(self.sat) else '?'
        if name == 'GOTO':
            return ov[0] if ot[0] == SVT_NUMBER else None
        if name in ('RETURN_AND_SKIP_DEFAULT', 'RETURN_AND_RUN_DEFAULT', 'REMOVE_THIS_SCRIPT'):
            return None
        if name == 'TOGGLE_STATE':
            if ot[0] == SFO_ATTACHEE:
                own.append(list(cons))
            else:
                others.append(('switches something nearby on or off', list(cons)))
        elif name in ('CHANGE_SCRIPT', 'CHANGE_THIS_SCRIPT_TO_SCRIPT', 'CALL_SCRIPT', 'CALL_SCRIPT_IN', 'CALL_SCRIPT_AT'):
            # the swapped-in / called script carries on from here (change script: of the attachee, constant script number; call
            # script: run now, in a while, or at a time of day, with the attachee as its attachee)
            target, line = None, 0
            if name == 'CHANGE_SCRIPT' and ot[0] == SFO_ATTACHEE and ot[2] == SVT_NUMBER:
                target = ov[2]
            elif name == 'CHANGE_THIS_SCRIPT_TO_SCRIPT' and ot[0] == SVT_NUMBER:
                target = ov[0]
            elif name in ('CALL_SCRIPT', 'CALL_SCRIPT_IN', 'CALL_SCRIPT_AT') and ot[0] == SVT_NUMBER and ot[3] == SFO_ATTACHEE:
                target, line = ov[0], (ov[1] if ot[1] == SVT_NUMBER else 0)
            if target:
                o2, x2 = self.run(target, counters, depth + 1, line, seen)
                own += [list(cons) + p for p in o2]
                others += [(p, list(cons) + c) for p, c in x2]
        elif name == 'GET_STORY_STATE':
            var[ov[0]] = ('story', 0)
        elif name == 'ASSIGN_NUM':
            var[ov[0]] = self.value(var, ot[1], ov[1], counters)
        elif name in ('ADD', 'SUBTRACT'):
            x, y = self.value(var, ot[1], ov[1], counters), self.value(var, ot[2], ov[2], counters)
            sign = 1 if name == 'ADD' else -1
            if x[0] in ('num', 'story') and y[0] == 'num':
                var[ov[0]] = (x[0], x[1] + sign * y[1])
            else:
                var[ov[0]] = ('?', 0)
        elif name in OTHER_VERBS and not (ot[0] == SFO_ATTACHEE and name in ('KILL', 'DESTROY')):
            others.append((OTHER_VERBS[name], list(cons)))
        return True

    # ---- conditions: small tuples, put into words by render() ------------------------------------------------------------
    #   ('story', 'ge' | 'le' | 'eq' | 'ne', n)   ('flag', n, on)   ('quest', q, state, holds, whole world)
    #   ('rumour', n, known, quelled)   ('item', name, carried)   ('day', is day)
    def describe(self, ctype, c, outcome, var, counters):
        """The conditions a test adds on the way: [] for a test that says nothing (is it still switched off?), [('other', test)] for
        one this cannot read (so a path is never called unconditional when it is not)."""
        t, ot, ov = c
        if ctype in ('EQ', 'LE'):
            x, y = self.value(var, ot[0], ov[0], counters), self.value(var, ot[1], ov[1], counters)
            if ctype == 'EQ':
                if 'flag' in (x[0], y[0]):
                    flag, other = (x, y) if x[0] == 'flag' else (y, x)
                    if other[0] == 'num' and other[1] in (0, 1):
                        return [('flag', flag[1], bool(other[1]) == outcome)]
                if 'story' in (x[0], y[0]):
                    s, other = (x, y) if x[0] == 'story' else (y, x)
                    if other[0] == 'num':
                        return [('story', 'eq' if outcome else 'ne', other[1] - s[1])]
                if 'gvar' in (x[0], y[0]):
                    g, other = (x, y) if x[0] == 'gvar' else (y, x)
                    if other[0] == 'num':
                        return [('gvar', g[1], 'eq' if outcome else 'ne', other[1])]
                return [('other', ctype)]
            if x[0] == 'story' and y[0] == 'num':          # story + k <= n
                n = y[1] - x[1]
                return [('story', 'le', n)] if outcome else [('story', 'ge', n + 1)]
            if x[0] == 'num' and y[0] == 'story':          # n <= story + k
                n = x[1] - y[1]
                return [('story', 'ge', n)] if outcome else [('story', 'le', n - 1)]
            if x[0] == 'gvar' and y[0] == 'num':           # var <= n
                return [('gvar', x[1], 'le' if outcome else 'gt', y[1])]
            if x[0] == 'num' and y[0] == 'gvar':           # n <= var
                return [('gvar', y[1], 'ge' if outcome else 'lt', x[1])]
            return [('other', ctype)]
        if ctype == 'GLOBAL_FLAG':
            x = self.value(var, ot[0], ov[0], counters)
            return [('flag', x[1], outcome)] if x[0] == 'num' else [('other', ctype)]
        if ctype in ('PC_QUEST_STATE', 'GLOBAL_QUEST_STATE'):
            k = 1 if ctype == 'PC_QUEST_STATE' else 0
            q, s = self.num(var, ot[k], ov[k], counters), self.num(var, ot[k + 1], ov[k + 1], counters)
            return [('quest', q, s, outcome, k == 0)] if q is not None and s is not None else [('other', ctype)]
        if ctype in ('RUMOR_KNOWN', 'RUMOR_QUELLED'):
            k = 1 if ctype == 'RUMOR_KNOWN' else 0
            r = self.num(var, ot[k], ov[k], counters)
            return [('rumour', r, outcome, ctype == 'RUMOR_QUELLED')] if r is not None else [('other', ctype)]
        if ctype == 'OBJ_HAS_ITEM_NAMED' and ot[0] != SFO_ATTACHEE:
            n = self.num(var, ot[1], ov[1], counters)
            return [('item', n, outcome)] if n in self.oname else [('other', ctype)]
        if ctype == 'DAYTIME':
            return [('day', outcome)]
        if ctype == 'OBJ_IS_SWITCHED_OFF' and ot[0] == SFO_ATTACHEE:
            return []
        return [('other', ctype)]

    @staticmethod
    def opposite(x, y):
        """Two conditions that cover both ways of the same test (so a path that has either needs neither)."""
        if x[0] != y[0]:
            return False
        if x[0] in ('flag', 'item', 'day'):
            return x[:-1] == y[:-1] and x[-1] != y[-1]
        if x[0] == 'quest':
            return x[1:3] == y[1:3] and x[4] == y[4] and x[3] != y[3]
        if x[0] == 'rumour':
            return x[1] == y[1] and x[3] == y[3] and x[2] != y[2]
        if x[0] == 'story':
            a, b = sorted((x, y), key=lambda i: i[1])             # 'ge' < 'le'
            return a[1] == 'ge' and b[1] == 'le' and a[2] == b[2] + 1
        if x[0] == 'gvar':
            return x[1] == y[1] and x[3] == y[3] and {x[2], y[2]} in ({'eq', 'ne'}, {'le', 'gt'}, {'ge', 'lt'})
        return False

    def simplify(self, paths):
        """Paths (sets of conditions) any of which switches the character on: drops what another path already covers and what makes no
        difference ("once X" next to "as long as not X")."""
        paths = list(dict.fromkeys(frozenset(p) for p in paths))
        changed = True
        while changed:
            changed = False
            for a, b in combinations(paths, 2):
                da, db = a - b, b - a
                if len(da) == 1 and len(db) == 1 and self.opposite(next(iter(da)), next(iter(db))):
                    paths.remove(a)
                    paths.remove(b)
                    paths.append(a & b)
                    changed = True
                    break
            if changed:
                continue
            for a in paths:
                if any(b < a for b in paths):
                    paths.remove(a)
                    changed = True
                    break
        return list(dict.fromkeys(paths))

    def flag_text(self, flag, on):
        f = self.flags.get(str(flag)) or {}
        event = f'flag {flag} is set'
        lines = [(s[0], s[5].strip()) for s in f.get('dlg', []) if s[2] == 'set' and s[3] == 1]
        good = [x for x in lines if len(x[1]) >= 8 and not re.match(r'^[A-Za-z]:', x[1])]         # not a stage-direction stub like "E:"
        setters = [s for s in f.get('scr', []) if s[2] == 'set']
        if good or (lines and not setters):
            file, line = (good or lines)[0]
            who = re.sub(r'^\d+\s*', '', self.names.get(file[:-4] + '.scr') or re.sub(r'^\d+', '', file[:-4]).replace('_', ' '))
            event = f'“{line[:60].rstrip()}{"…" if len(line) > 60 else ""}” has been said ({who.strip()})'
        elif setters:
            event = 'the script “' + re.sub(r'^\d+', '', setters[0][0][:-4]).replace('_', ' ').strip() + '” has run'
        return ('once ' if on else 'as long as not ') + event

    def gvar_setters(self):
        """global variable -> {'dlg': [(file, line text, value)], 'set': [(script, value)], 'add': [script]}: what writes the variable."""
        if getattr(self, '_gv', None) is None:
            self._gv = {}
            gv = re.compile(r'(?<![a-z])gv\s*(\d+)\s+(-?\d+)', re.I)
            for f in sorted(self.dlg.glob('*.dlg')):
                for raw in ao.read_text(f).splitlines():
                    raw = raw.strip()
                    if not (raw.startswith('{') and raw.endswith('}')):
                        continue
                    parts = raw[1:-1].split('}{')
                    if len(parts) < 7:
                        continue
                    for m in gv.finditer(parts[6]):
                        self._gv.setdefault(int(m.group(1)), {}).setdefault('dlg', []).append((f.name, parts[1].strip(), int(m.group(2))))
            for num in sorted(self.files):
                try:
                    L = self.lines(num)
                except Exception:
                    continue
                for c, a, e in L:
                    for t, ot, ov in (a, e):
                        name = self.sat[t] if 0 <= t < len(self.sat) else '?'
                        if name in ('ASSIGN_NUM', 'ADD', 'SUBTRACT') and ot[0] == SVT_GL_VAR:
                            d = self._gv.setdefault(ov[0], {})
                            if name == 'ASSIGN_NUM' and ot[1] == SVT_NUMBER:
                                d.setdefault('set', []).append((num, ov[1]))
                            elif num not in d.setdefault('add', []):
                                d['add'].append(num)
        return self._gv

    def gvar_text(self, n, rel, k):
        """"the counter n is k" in words: by the dialog line or script that makes it so, else by the script that counts it."""
        d = self.gvar_setters().get(n, {})
        event = None
        counted = d.get('add', [])
        what = f'the count kept by the script “{self.title(counted[0])}”' if counted else f'game counter {n}'
        if k == 0 and rel in ('eq', 'ne'):               # every counter starts at 0: "is 0" means nothing has changed it yet
            return f'{what} is still 0 (as at the start)' if rel == 'eq' else f'{what} is no longer 0'
        if rel in ('eq', 'ne'):
            lines = [(f, t) for f, t, v in d.get('dlg', []) if v == k]
            good = [x for x in lines if len(x[1]) >= 8 and not re.match(r'^[A-Za-z]:', x[1])]
            if good:
                f, t = good[0]
                who = re.sub(r'^\d+\s*', '', self.names.get(f[:-4] + '.scr') or re.sub(r'^\d+', '', f[:-4]).replace('_', ' '))
                event = f'“{t[:60].rstrip()}{"…" if len(t) > 60 else ""}” has been said ({who.strip()})'
            else:
                sets = [s for s, v in d.get('set', []) if v == k]
                if sets:
                    event = f'the script “{self.title(sets[0])}” has run'
            if event:
                return ('once ' if rel == 'eq' else 'as long as not ') + event
        words = {'eq': f'has reached {k}' if counted else f'is {k}', 'ne': f'has not reached {k}' if counted else f'is not {k}',
                 'le': f'is at most {k}', 'gt': f'is above {k}', 'ge': f'is at least {k}', 'lt': f'is below {k}'}
        return f'{what} {words[rel]}'

    def render(self, items):
        """A path's conditions as one sentence."""
        items = list(dict.fromkeys(items))
        out = []
        ge = max((i[2] for i in items if i[0] == 'story' and i[1] == 'ge'), default=None)
        le = min((i[2] for i in items if i[0] == 'story' and i[1] == 'le'), default=None)
        if ge is not None and le is not None:
            out.append(f'story state {ge} to {le}' if ge != le else f'story state {ge}')
        elif ge is not None:
            out.append(f'story state {ge} or later')
        elif le is not None:
            out.append(f'story state {le} or earlier')
        for i in items:
            if i[0] == 'story' and i[1] in ('eq', 'ne'):
                out.append(f'story state is {"" if i[1] == "eq" else "not "}{i[2]}')
        quests = {}
        for i in items:
            if i[0] == 'quest':
                quests.setdefault((i[1], i[4]), []).append(i)
        for (q, whole), group in quests.items():
            name = self.quests.get(q) or f'quest {q}'
            yes = [i for i in group if i[3]]
            if yes:
                s = yes[0][2]
                out.append(f'the quest “{name}” is {QUEST_STATE[s] if 0 <= s < len(QUEST_STATE) else s}' if s else
                           f'the quest “{name}” has not come up yet')
                continue
            states = [i[2] for i in group]
            if 0 in states:
                out.append(f'the quest “{name}” has come up (been mentioned or taken)')
                states = [s for s in states if s]
            if states:
                words = [QUEST_STATE[s] if 0 <= s < len(QUEST_STATE) else str(s) for s in states]
                out.append(f'the quest “{name}” is not ' + (', '.join(words[:-1]) + ' or ' + words[-1] if len(words) > 1 else words[0]))
        for i in items:
            if i[0] == 'flag':
                out.append(self.flag_text(i[1], i[2]))
            elif i[0] == 'gvar':
                out.append(self.gvar_text(i[1], i[2], i[3]))
            elif i[0] == 'rumour':
                line = cut(self.rumours.get(20 * i[1]) or self.rumours.get(20 * i[1] + 1) or '', 80)
                what = f'the rumour “{line}”' if line else 'a rumour'
                if i[3]:
                    out.append(f'{what} has {"" if i[2] else "not "}been quelled')
                else:
                    out.append(f'you {"know" if i[2] else "do not know"} {what}' + ('' if i[2] else ' yet'))
            elif i[0] == 'item':
                out.append(f'you {"carry" if i[2] else "do not carry"} “{self.oname[i[1]]}”')
            elif i[0] == 'day':
                out.append('it is day' if i[1] else 'it is night')
        return ' and '.join(dict.fromkeys(out))

    # ---- spawners ------------------------------------------------------------------------------------------------------
    def generator_toggles(self):
        """generator number -> [(script number, conditions on the way to the toggle)]: the scripts that stop or start that spawner."""
        if self.gen_cache is None:
            self.gen_cache = {}
            tid = self.sat.index('TOGGLE_MONSTER_GENERATOR')
            for num in sorted(self.files):
                try:
                    L = self.lines(num)
                except Exception:
                    continue
                for i, (c, a, e) in enumerate(L):
                    for p in (a, e):
                        if p[0] == tid and p[1][0] == SVT_NUMBER:
                            self.gen_cache.setdefault(p[2][0], []).append((num, self.path_to(num, i)))
        return self.gen_cache

    def path_to(self, num, line):
        """The conditions on the first way to line `line` of a script."""
        lines = self.lines(num)
        found = []

        def walk(i, var, cons, steps):
            if not (0 <= i < len(lines)) or steps > 60 or found:
                return
            cond, act, els = lines[i]
            ctype = self.sct[cond[0]] if 0 <= cond[0] < len(self.sct) else '?'
            for a, outcome in ([(act, None)] if ctype == 'TRUE' else [(act, True), (els, False)]):
                v2, c2 = dict(var), list(cons)
                if outcome is not None:
                    c2 += self.describe(ctype, cond, outcome, v2, [0, 0, 0, 0])
                if i == line and a is act:
                    found.append(c2)
                    return
                t, ot, ov = a
                name = self.sat[t] if 0 <= t < len(self.sat) else '?'
                if name == 'GOTO' and ot[0] == SVT_NUMBER:
                    walk(ov[0], v2, c2, steps + 1)
                elif name not in ('RETURN_AND_SKIP_DEFAULT', 'RETURN_AND_RUN_DEFAULT', 'REMOVE_THIS_SCRIPT'):
                    if name == 'GET_STORY_STATE':
                        v2[ov[0]] = ('story', 0)
                    walk(i + 1, v2, c2, steps + 1)

        walk(0, {}, [], 0)
        return found[0] if found else []

    def spawner(self, e):
        """{name, concurrent, total (0 = no limit), id, rate, day, night, hidden, group} for a spawner, else None."""
        flags = e.int(F_NPC_FLAGS) & 0xFFFFFFFF
        if not flags & ONF_GENERATOR:
            return None
        d = e.int(F_GENERATOR) & 0xFFFFFFFF
        g = (d >> 27) & 0x1F
        return {'name': (self.desc.get(e.int(F_NAME)) or '').strip(), 'concurrent': (d >> 14) & 0x1F,
                'total': 0 if g & 0x10 else (d >> 7) & 0x7F, 'id': (d >> 19) & 0xFF, 'rate': (flags >> 21) & 7,
                'day': bool(g & 1), 'night': bool(g & 2), 'hidden': bool(g & 4), 'group': bool(g & 8)}

    def spawner_text(self, g):
        n, mc, mt = g['name'] or 'someone', g['concurrent'], g['total']
        at_once = 'one at a time' if mc <= 1 else f'up to {mc} at a time'
        total = ', and once only' if mt == 1 and mc <= 1 else f', {mt} in all' if mt else ', with no limit in all'
        when = ' by day only' if g['day'] and not g['night'] else ' at night only' if g['night'] and not g['day'] else ''
        return ('Not a person but a spawner: it stays switched off on purpose and is never seen. '
                f'It creates “{n}” within a few tiles of itself, {at_once}{total}. It checks about every {RATE[g["rate"]]}{","  if when else ""}{when}'
                f'{", and only while it is out of your sight" if g["hidden"] else ""}'
                f'{"; whenever the group has thinned it fills it up again at once" if g["group"] and mc > 1 else ""}.')

    # ---- an NPC --------------------------------------------------------------------------------------------------------
    def scripts_of(self, e):
        v = e[F_SCRIPTS]
        out = []
        if isinstance(v, dict):
            for hook, b in v.items():
                if isinstance(b, bytes) and len(b) >= 12:
                    num = struct.unpack_from('<I', b, 8)[0]
                    if num in self.files:
                        out.append((hook, num, list(b[4:8])))
        return out

    def own_paths(self, e):
        """The ways the NPC's own scripts switch it on: [sentence, ...] (an empty path reads 'right away'), and what they do to others.
        The same scripts give the same answer: worked out once per set of scripts (a town's guards all carry the same ones)."""
        mine = self.scripts_of(e)
        key = tuple((hook, num, tuple(c)) for hook, num, c in mine)
        if key not in self._paths:
            self._paths[key] = self._own_paths(mine)
        texts, others = self._paths[key]
        return list(texts), list(others)

    def _walked(self, mine):
        """(paths, others) of run() over the scripts: kept between runs (reports/cache), keyed by those scripts and every script of this set
        of files (a walk follows the scripts it swaps in or calls). A walk can take minutes; what it found does not depend on the tables."""
        import game_files
        if self._sig is None:
            import zlib
            stats = sorted((n, p.name.lower(), st.st_size, st.st_mtime_ns) for n, p in self.files.items() for st in [p.stat()])     # (one stat per file)
            self._sig = zlib.crc32(repr((stats, sorted(self.oname))).encode())     # (describe() keeps an item test only when oname.mes has the number)
        key = (self._sig, tuple((hook, num, tuple(c)) for hook, num, c in mine))
        memo = game_files._parsed('switch-walks')
        if key not in memo:
            paths, others = [], []
            for hook, num, counters in mine:
                own, oth = self.run(num, counters)
                paths += own
                others += oth
            memo[key] = (paths, others)
            game_files._DIRTY.add('switch-walks')
        return memo[key]

    def _own_paths(self, mine):
        paths, others = self._walked(mine)
        paths, others = list(paths), list(others)
        texts = []
        for p in self.simplify(paths):
            t = self.render(sorted(p, key=repr))       # (a set: in a fixed order, or the sentence changes from one run to the next)
            if not t:       # nothing readable on the way: unconditional, or only tests this cannot read
                t = ('when its own script decides so (it tests something this tool cannot read)' if any(i[0] == 'other' for i in p)
                     else 'right away (its own script switches it on when the game starts it)')
            if t not in texts:
                texts.append(t)
        return texts, others

    def why(self, e):
        """The reason text for an ao.Effective NPC that is switched off, or ''."""
        texts, _ = self.own_paths(e)
        if set(texts) == {'it is day', 'it is night'}:
            return 'by the time of day (it comes and goes with day and night)'
        return ' — or — '.join(texts[:MAX_ALTERNATIVES])

    def spawner_only(self, e):
        """For maps whose scripts are not in data/ (the modules): a spawner can still be told from its own fields, nothing else can."""
        g = self.spawner(e)
        return {'k': 'spawner', 't': self.spawner_text(g)} if g else 0

    def explain(self, e):
        """1: nothing found; a string: the conditions; a dict: {k: 'spawner' | 'helper', t: text, w: [what else matters]}."""
        texts, others = self.own_paths(e)
        if set(texts) == {'it is day', 'it is night'}:
            texts = ['by the time of day (it comes and goes with day and night)']
        g = self.spawner(e)
        if g:
            out = {'k': 'spawner', 't': self.spawner_text(g)}
            stops = []
            for num, cons in self.generator_toggles().get(g['id'], []):
                s = f'the script “{self.title(num)}” can stop it and start it again'
                c = self.render(cons)
                stops.append(s + (f' (when {c})' if c else ''))
            if stops:
                out['w'] = list(dict.fromkeys(stops))[:3]
            if texts:
                out['w'] = out.get('w', []) + ['a script of its own also switches it on: ' + t for t in texts[:2]]
            return out
        if texts:
            return ' — or — '.join(texts[:MAX_ALTERNATIVES])
        if others:
            verbs = list(dict.fromkeys(p for p, _ in others))[:3]
            when = list(dict.fromkeys(self.render(c) for _, c in others if c))[:2]
            out = {'k': 'helper', 't': 'Not really a person: an invisible stand-in that is never switched on. It only carries a script that '
                   + ', '.join(verbs) + '.'}
            if when:
                out['w'] = [w for w in when if w]
            return out
        return 1
