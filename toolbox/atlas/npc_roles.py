"""
What a person does for the player, read from their dialog: sells goods, joins the party, trains a skill.

Every NPC carries scripts in field 32 (a 12-byte element per attachment point, the script number at +8). The script whose
number matches a data/dlg file at the DIALOG (9) or DIALOG_OVERRIDE (31) point is their conversation. In that file:
  a line "B:" opens the barter screen            -> a shopkeeper (the price multiplier is the NPC's field 293)
  an effect "jo"                                 -> the person joins the player as a follower
  an effect "tr <skill> <level>"                 -> trains the player (1 apprentice, 2 expert, 3 master; skill.mes names the skill)
Used by build_npcs.py and build_submaps.py.
"""
import struct

import build_quests as bq

F_SCRIPTS, F_MARKUP = 32, 293


def columns(r):
    """The three columns of an NPC row: shop (0 / 1), price multiplier in % (shops), follower / trainer ({j: 1, t: [...]} or 0)."""
    if not r:
        return [0, 0, 0]
    role = {}
    if r['join']:
        role['j'] = 1
    if r['train']:
        role['t'] = r['train']
    return [1 if r['shop'] else 0, r['markup'], role or 0]


class Roles:
    def __init__(self, dlg_folder=None, version=None):
        """dlg_folder: a module's dlg folder (its script numbers are its own, not the game's).
        version: a game_files.Version: the dialogs and tables of the game with every layer over them (a mod, a module)."""
        names = bq.Names(version=version)
        if version is not None:
            dlg_folder = version.tree('dlg')
        self.by_script = {}
        for n, lines in bq.load_dialogs(dlg_folder).items():
            r = {'shop': False, 'join': False, 'train': []}
            for ln in lines.values():
                if ln['text'].strip() == 'B:':
                    r['shop'] = True
                for code, v, w in bq.parse_codes(ln['effect']):
                    if code == 'jo':
                        r['join'] = True
                    elif code == 'tr' and 0 < w < len(bq.TRAINING) and names.skill.get(v):
                        t = f"{bq.TRAINING[w]} {bq.clean(names.skill[v])}"
                        if t not in r['train']:
                            r['train'].append(t)
            if r['shop'] or r['join'] or r['train']:
                self.by_script[n] = r

    def of(self, eff):
        """An ao.Effective NPC -> {shop, markup, join, train} (or None when its conversation does none of that)."""
        v = eff[F_SCRIPTS]
        if not isinstance(v, dict):
            return None
        out = {'shop': False, 'join': False, 'train': []}
        for point in bq.DIALOG_POINTS:
            b = v.get(point)
            if isinstance(b, (bytes, bytearray)) and len(b) >= 12:
                r = self.by_script.get(struct.unpack_from('<I', b, 8)[0])
                if r:
                    out['shop'] = out['shop'] or r['shop']
                    out['join'] = out['join'] or r['join']
                    out['train'] += [t for t in r['train'] if t not in out['train']]
        out['shop'] = out['shop'] and not out['join']        # a follower also has a barter line (trading with the party), but is no shop
        if not (out['shop'] or out['join'] or out['train']):
            return None
        out['markup'] = eff.int(F_MARKUP) if out['shop'] else 0
        return out
