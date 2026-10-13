// .scr lines in plain English, and short notes for the operands of the normal view.
//
// What each condition / action does is read from game/script.c (script_execute_condition(),
// script_execute_action()); what each operand kind is, from script_get_value() / script_get_obj():
//   counter 0-3   a small number (0-255) kept by this script on the object it is attached to
//   local flag    a yes / no kept the same way (ScriptHeader.flags)
//   lc var        a temporary value: it only lives while the script runs (ScriptState.lc_vars)
//   gl var / flag a value / yes-no for the whole game
//   pc var / flag a value / yes-no kept on a player character
//   focus objects "triggerer" is whoever set the script off (the player who talks, uses, hits…),
//                 "attachee" the object the script is attached to; followers, party, team and group
//                 are the triggerer's; "vicinity" is around the attachee. In a condition, "every …"
//                 is true only if it holds for all of them, "any …" if it holds for one of them.

import { DATA_ROOT } from '../core/config.js';
import { fetchText, mesTable } from '../core/text-io.js';
import { gameNames as G, loadCodeTables } from '../text/dlg-codes.js';
import { loadMapList } from '../sec/sec-map-data.js';
import { SCR_ATTACHMENT_POINTS, SCR_FOCUS_OBJECTS, SCR_VALUE_TYPES } from './scr-schema.js';

// Name tables only some operands need. Effects and eye candy are named by their line's comment.
const commentNames = path => {
  let p = null;
  const load = () => (p ??= fetchText(`${DATA_ROOT}${path}`).then(text => {
    const out = new Map();
    for (const m of text.matchAll(/^\s*\{(\d+)\}\{[^}]*\}\s*\/\/\s*(.+?)\s*$/gm)) out.set(Number(m[1]), m[2]);
    return out;
  }).catch(() => new Map()));
  let value = null;
  return { load: () => load().then(v => (value = v)), get: n => value?.get(n) };
};
const BLESS = mesTable(`${DATA_ROOT}mes/gamebless.mes`), CURSE = mesTable(`${DATA_ROOT}mes/gamecurse.mes`);
const EFFECT = commentNames('Rules/effect.mes'), EYECANDY = commentNames('Rules/ScriptEyeCandy.mes');
let mapList = null;

export const loadExplainTables = () => Promise.all([
  loadCodeTables(), BLESS().catch(() => null), CURSE().catch(() => null), EFFECT.load(), EYECANDY.load(),
  loadMapList().then(m => { mapList = m; }).catch(() => null),
]);

const DAMAGE = ['normal', 'poison', 'electrical', 'fire', 'fatigue'];

// ---- operands ---------------------------------------------------------------------------------

// The objects a focus operand stands for. `plural`: what a condition / loop over a group reads like.
const TRIGGERER = 'the triggerer';
const FOCUS = {
  'triggerer': TRIGGERER,
  'attachee': 'this object',
  'every follower': "each of the triggerer's followers",
  'any follower': "any of the triggerer's followers",
  'everyone in party': "everyone in the triggerer's party",
  'anyone in party': "anyone in the triggerer's party",
  'everyone in team': "everyone in the triggerer's team",
  'anyone in team': "anyone in the triggerer's team",
  'everyone in vicinity': 'everyone near this object',
  'anyone in vicinity': 'anyone near this object',
  'current looped object': 'the current one (of the loop)',
  'extra object': 'the extra object',
  'everyone in group': 'the triggerer and each of their followers',
  'anyone in group': 'the triggerer or any of their followers',
  'every scenery in vicinity': 'every piece of scenery near this object',
  'any scenery in vicinity': 'any piece of scenery near this object',
  'every container in vicinity': 'every container near this object',
  'any container in vicinity': 'any container near this object',
  'every portal in vicinity': 'every door near this object',
  'any portal in vicinity': 'any door near this object',
  'player': 'the player',
  'every item in vicinity': 'every item near this object',
  'any item in vicinity': 'any item near this object',
};
// What each term means, for the tooltips and the glossary.
export const TERMS = {
  'triggerer': 'Whoever set this script off: the player who talks to, uses, picks up or hits the object, the critter that walks onto the tile… It depends on the event the script is attached to.',
  'attachee': 'The object this script is attached to (the NPC, door, item… that carries it).',
  'extra object': 'A third object some events pass to the script (for example the item being used).',
  'local object': 'An object this run of the script remembered with "assign obj" (it is forgotten when the script ends).',
  'current looped object': 'Inside a "loop for": the object the loop is on now.',
  'player': 'The player character.',
  'every / any': 'A group (followers, party, team, everyone nearby…). In a condition, "every / everyone" is true only if it is true for all of them, "any / anyone" if it is true for at least one.',
  'followers, party, team, group': "Always the triggerer's: followers are the NPCs following them, the party is them and their followers, the group is the same, the team is everyone on their side.",
  'vicinity': 'The critters (or scenery, containers, doors, items) around the object this script is attached to.',
  'counter': "One of four small numbers (0 to 255) this script keeps on the object it is attached to. They stay between runs, so a script can count how often something happened.",
  'local flag': "A yes / no this script keeps on the object it is attached to, between runs (32 of them per script). Only three things change it: this script's own “set / clear local flag” lines, a dialogue's “lf” effects (the NPC's dialogue script only), and the value the object was given when it was made. A script started with “call script” works on a fresh copy, so what it sets there is forgotten afterwards.",
  'local var': 'A temporary value this run of the script uses to hold a result (a stat, a random number…) for a later line. It is lost when the script ends.',
  'global var': 'A number for the whole game, shared by every script and dialogue.',
  'global flag': 'A yes / no for the whole game, shared by every script and dialogue.',
  'pc var': 'A number kept on a player character.',
  'pc flag': 'A yes / no kept on a player character.',
};
// How the "Simplify" sentences call a term, when they word it differently.
export const TERM_PLAIN = {
  'attachee': 'this object', 'local object': 'remembered object', 'current looped object': 'the current one (of the loop)',
  'local var': 'temporary value', 'global var': 'global variable', 'pc var': 'player variable', 'pc flag': 'player flag',
};
export const focusTermOf = name => (name === 'local object' ? 'local object' : name in TERMS ? name
  : /in vicinity/.test(name) ? 'vicinity' : /^(every|any)/.test(name) ? 'every / any' : null);

function objText(type, index) {
  const name = SCR_FOCUS_OBJECTS[type];
  if (name === undefined) return `object ${type}:${index}`;
  if (name === 'local object') return `remembered object ${index}`;
  return FOCUS[name] || name;
}

// A value operand: a plain number (named after its role when it has one) or a variable.
function valueText(type, value, role, ctx) {
  const kind = SCR_VALUE_TYPES[type];
  switch (kind) {
    case 'number': return roleText(role, value, ctx);
    case 'counter': return `counter ${value}`;
    case 'lc var': return `temporary value ${value}`;
    case 'gl var': return `global variable ${value}`;
    case 'gl flag': { const m = G.flagMeaningOf(value); return `global flag ${value}${m ? ` (${m})` : ''}`; }
    case 'pc var': return `player variable ${value & 0xFFFF} of ${objText(value >> 16, 0)}`;
    case 'pc flag': return `player flag ${value & 0xFFFF} of ${objText(value >> 16, 0)}`;
    default: return `value ${type}:${value}`;
  }
}
const quoted = (s, max = 80) => (s ? `“${G.short(s, max)}”` : '');
// A number in its role (a quest, a quest state, a line…). Markers ⟦L:n⟧ / ⟦S:n⟧ become links.
function roleText(role, n, ctx) {
  switch (role) {
    case 'line': return `⟦L:${n}⟧`;
    case 'script': return `⟦S:${n}⟧`;
    case 'quest': { const t = G.questText(n); return t ? `the quest ${quoted(t)}` : `quest ${n}`; }
    case 'qstate': return `“${G.questState(n)}”`;
    // What is said, then where it comes from: “Get away from me, dog!” (dialogue line 280)
    case 'dlgline': { const t = ctx?.dlgText?.(n); return t ? `${quoted(t, ctx?.maxQuote || 80)} (dialogue line ${n})` : `dialogue line ${n}`; }
    case 'name': return G.item(n);
    case 'rep': return G.reputation(n);
    case 'rumor': return G.rumor(n);
    case 'area': return G.area(n);
    case 'skill': return `the ${G.skill(n)} skill`;
    case 'stat': return G.statName(n);
    case 'spell': return `the spell ${quoted(G.spellName(n))}`;
    case 'college': return `${G.college(n)}`;
    case 'bless': return `the blessing ${quoted(BLESS.peek()?.get(n * 10)) || n}`;
    case 'curse': return `the curse ${quoted(CURSE.peek()?.get(n * 10)) || n}`;
    case 'effect': { const t = EFFECT.get(n); return t ? `the effect ${quoted(t)}` : `effect ${n}`; }
    case 'eyecandy': { const t = EYECANDY.get(n); return t ? `the visual effect ${quoted(t)}` : `visual effect ${n}`; }
    case 'story': return G.story(n);
    case 'sap': return `“${String(SCR_ATTACHMENT_POINTS[n] || n).toLowerCase().replace(/_/g, ' ')}”`;
    case 'map': { const f = mapList?.get(n - 4999); return f ? `the map ${quoted(f)}` : `map ${n}`; }
    case 'gold': return `${n} gold`;
    case 'seconds': return n % 3600 === 0 && n ? `${n / 3600} hour${n === 3600 ? '' : 's'}` : n % 60 === 0 && n ? `${n / 60} minute${n === 60 ? '' : 's'}` : `${n} second${n === 1 ? '' : 's'}`;
    case 'daytime': { const s = ((n % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`; }
    case 'damage': return DAMAGE[n] ?? `type ${n}`;
    case 'lock': return n ? 'locked' : 'unlocked';
    case 'lflag': return `local flag ${n}`;
    case 'gflag': { const m = G.flagMeaningOf(n); return `global flag ${n}${m ? ` (${m})` : ''}`; }
    case 'xplevel': return `level ${n}`;
    default: return String(n);
  }
}
// One operand of a statement, in words.
function operandText(kind, type, value, role, ctx) {
  switch (kind) {
    case 'val': return valueText(type, value, role, ctx);
    case 'dst': return valueText(type, value, null, ctx);
    case 'obj': case 'objdst': return objText(type, value);
    default: return String(value);
  }
}

// Which number each slot holds, by statement (only slots whose meaning is not plain).
const ROLES = {
  // conditions
  'has gold': [null, 'gold'], 'local flag': ['lflag'], 'pc quest state': [null, 'quest', 'qstate'], 'global quest state': ['quest', 'qstate'],
  'obj has bless': [null, 'bless'], 'obj has curse': [null, 'curse'], 'obj has item named': [null, 'name'], 'obj is named': [null, 'name'],
  'obj is wielding item': [null, 'name'], 'obj has reputation': [null, 'rep'], 'obj is influenced by spell': [null, 'spell'],
  'rumor known': [null, 'rumor'], 'rumor quelled': ['rumor'], 'global flag': ['gflag'], 'knows spell': [null, 'spell'],
  'mastered spell college': [null, 'college'],
  // actions
  'goto': ['line'], 'dialog': ['dlgline'], 'change this script to script': ['script'], 'call script': ['script', 'line'],
  'set local flag': ['lflag'], 'clear local flag': ['lflag'], 'set pc quest state': [null, 'quest', 'qstate'], 'set quest global state': ['quest', 'qstate'],
  'float line': ['dlgline'], 'print line': ['dlgline'], 'add blessing': ['bless'], 'remove blessing': ['bless'], 'add curse': ['curse'], 'remove curse': ['curse'],
  'get stat': ['stat'], 'adjust gold': [null, 'gold'], 'transfer item': ['name'], 'set story state': ['story'], 'teleport': [null, 'map'],
  'get skill': ['skill'], 'cast spell': [null, 'spell'], 'mark map location': ['area'], 'set rumor': ['rumor'], 'quell rumor': ['rumor'],
  'set lock state': [null, 'lock'], 'call script in': ['script', 'line', null, null, 'seconds'], 'call script at': ['script', 'line', null, null, 'daytime'],
  'damage': [null, null, 'damage'], 'apply unresistable damage': [null, null, 'damage'], 'cast spell on': ['spell'], 'give quest xp': [null, 'xplevel'],
  'add reputation': [null, 'rep'], 'remove reputation': [null, 'rep'], 'add effect': [null, 'effect'], 'remove effect': [null, 'effect'],
  'call script ex': [null, 'sap', 'line'], 'change script': [null, 'sap', 'script'], 'set global flag': ['gflag'], 'clear global flag': ['gflag'],
  'play spell eye candy': ['spell'], 'stop spell eye candy': ['spell'], 'play script eye candy': ['eyecandy'], 'stop script eye candy': ['eyecandy'],
  'give spell mastery in college': [null, 'college'], 'cast free spell': [null, 'spell'], 'set pc quest unbotched': [null, 'quest'],
  'action cast unresistable spell': [null, 'spell'], 'action cast free unresistable spell': [null, 'spell'], 'destroy item named': ['name'],
  'stop spell': ['spell'], 'cast unresistable spell': ['spell'], 'adjust stat': ['stat'], 'fade and teleport': [null, null, null, null, 'map'],
};
export const roleOf = (stmtName, slot) => ROLES[stmtName]?.[slot] || null;

// A short note for a number operand in the normal view ("= not started", "“Find the ring”"), or ''.
export function operandNote(stmtName, slot, type, value, ctx) {
  if (SCR_VALUE_TYPES[type] !== 'number') return '';
  const role = roleOf(stmtName, slot);
  if (!role || role === 'line' || role === 'script' || role === 'gold' || role === 'lflag' || role === 'gflag' || role === 'dlgline') return '';
  if (role === 'qstate') return `= ${G.questState(value)}`;
  if (role === 'seconds') return value >= 60 && value % 60 === 0 ? `= ${roleText(role, value, ctx)}` : 'seconds';
  if (role === 'xplevel') return '';
  return roleText(role, value, ctx).replace(/^the (quest|spell|blessing|curse|effect|visual effect|map) /, '');
}

// ---- sentences --------------------------------------------------------------------------------

// Conditions: (o) => text, o = the operands in words.
const COND = {
  'true': () => 'always',
  'daytime': () => 'it is daytime',
  'has gold': o => `${o[0]} has at least ${o[1]}`,
  'local flag': o => `this script's ${o[0]} is set`,
  'eq': o => `${o[0]} is equal to ${o[1]}`,
  'le': o => `${o[0]} is ${o[1]} or less`,
  'pc quest state': (o, simple) => (simple && o[0] === TRIGGERER ? `${o[1]} was ${o[2]}` : `${o[1]} is ${o[2]} for ${o[0]}`),
  'global quest state': o => `${o[0]} is ${o[1]} (for everyone)`,
  'obj has bless': o => `${o[0]} has ${o[1]}`,
  'obj has curse': o => `${o[0]} has ${o[1]}`,
  'obj met pc before': o => `${o[0]} has met ${o[1]} before`,
  'obj has bad associates': o => `${o[0]} travels with bad company`,
  'obj is polymorphed': o => `${o[0]} is polymorphed (turned into something else by a spell)`,
  'obj is shrunk': o => `${o[0]} is shrunk`,
  'obj has body spell': o => `${o[0]} is under a "Body of …" spell (air, earth, fire or water)`,
  'obj is invisible': o => `${o[0]} is invisible`,
  'obj has mirror image': o => `${o[0]} has mirror images (from the spell)`,
  'obj has item named': o => `${o[0]} carries ${o[1]}`,
  'obj following pc': o => `${o[0]} is following ${o[1]}`,
  'obj is monster of type': o => `${o[0]} is a monster of species ${o[1]}`,
  'obj is named': o => `${o[0]} is ${o[1]}`,
  'obj is wielding item': o => `${o[0]} has ${o[1]} in hand or worn`,
  'obj is dead': o => `${o[0]} is dead`,
  'obj has max followers': o => `${o[0]} cannot lead any more followers`,
  'obj can open container': o => `${o[0]} is able to open the container ${o[1]}`,
  'obj has surrendered': o => `${o[0]} has surrendered`,
  'obj is in dialog': o => `${o[0]} is in a conversation`,
  'obj is switched off': o => `${o[0]} is switched off`,
  'obj can see obj': o => `${o[0]} can see ${o[1]}`,
  'obj can hear obj': o => `${o[0]} can hear ${o[1]}`,
  'obj is invulnerable': o => `${o[0]} cannot be hurt`,
  'obj is in combat': o => `${o[0]} is fighting`,
  'obj is at location': o => `${o[0]} stands on tile ${o[1]}, ${o[2]}`,
  'obj has reputation': o => `${o[0]} has ${o[1]}`,
  'obj within range': o => `${o[0]} is no more than ${o[1]} tiles from tile ${o[2]}, ${o[3]}`,
  'obj is influenced by spell': o => `${o[0]} is under ${o[1]}`,
  'obj is open': o => `${o[0]} is open`,
  'obj is animal': o => `${o[0]} is an animal`,
  'obj is undead': o => `${o[0]} is undead`,
  'obj jilted': o => `${o[0]} has been jilted`,
  'rumor known': o => `${o[0]} knows ${o[1]}`,
  'rumor quelled': o => `${o[0]} has been quelled`,
  'obj is busted': o => `${o[0]} is broken`,
  'global flag': o => `${o[0]} is set`,
  'can open portal': o => `${o[0]} is able to open the door ${o[1]}`,
  'sector is blocked': o => `the sector at tile ${o[0]}, ${o[1]} is blocked`,
  'monstergen disabled': o => `monster generator ${o[0]} is switched off`,
  'identified': o => `${o[0]} has been identified`,
  'knows spell': o => `${o[0]} knows ${o[1]}`,
  'mastered spell college': o => `${o[0]} is a master of the college of ${o[1]}`,
  'items are being rewielded': () => 'items are being re-equipped (the game is swapping someone\'s gear)',
  'prowling': o => `${o[0]} is sneaking`,
  'waiting for leader': o => `${o[0]} is waiting for their leader to come back`,
};
// Actions.
const ACT = {
  'do nothing': () => 'carry on with the next line',
  'return and skip default': () => 'stop the script, and the game does NOT do what it normally does for this event',
  'return and run default': () => 'stop the script, and let the game do what it normally does for this event',
  'goto': o => `go to ${o[0]}`,
  'dialog': (o, simple) => `start a conversation${simple ? '' : ' with the triggerer'}, opening with ${o[0]}`,
  'remove this script': () => 'remove this script from the object (it will not run again)',
  'change this script to script': o => `replace this script with ${o[0]}`,
  'call script': o => `run ${o[0]} from ${o[1]}, with ${o[2]} as its triggerer and ${o[3]} as the object it is attached to`,
  'set local flag': o => `set this script's ${o[0]}`,
  'clear local flag': o => `clear this script's ${o[0]}`,
  'assign num': o => `put ${o[1]} into ${o[0]}`,
  'add': o => `put ${o[1]} + ${o[2]} into ${o[0]}`,
  'subtract': o => `put ${o[1]} − ${o[2]} into ${o[0]}`,
  'multiply': o => `put ${o[1]} × ${o[2]} into ${o[0]}`,
  'divide': o => `put ${o[1]} ÷ ${o[2]} into ${o[0]}`,
  'assign obj': o => `remember ${o[1]} as ${o[0]}`,
  'set pc quest state': (o, simple) => (simple && o[0] === TRIGGERER ? `mark ${o[1]} as ${o[2]}` : `for ${o[0]}, mark ${o[1]} as ${o[2]}`),
  'set quest global state': o => `mark ${o[0]} as ${o[1]} for everyone`,
  'loop for': o => `repeat the next lines for ${o[0]} (up to "end of loop"), one at a time`,
  'loop end': () => 'end of the loop: go back to its start with the next one',
  'loop break': () => 'leave the loop',
  'critter follow': o => `make ${o[0]} follow ${o[1]}`,
  'critter disband': o => `make ${o[0]} stop following their leader`,
  'float line': o => `${o[1]} says, in floating text: ${o[0]}`,
  'print line': o => `show ${o[0]} in the message window`,
  'add blessing': o => `give ${o[1]} ${o[0]}`,
  'remove blessing': o => `take ${o[0]} away from ${o[1]}`,
  'add curse': o => `give ${o[1]} ${o[0]}`,
  'remove curse': o => `take ${o[0]} away from ${o[1]}`,
  'get reaction': o => `put how much ${o[0]} likes ${o[1]} (their reaction) into ${o[2]}`,
  'set reaction': o => `make ${o[0]}'s reaction to ${o[1]} ${o[2]}`,
  'adjust reaction': o => `change ${o[0]}'s reaction to ${o[1]} by ${o[2]}`,
  'get armor': o => `put ${o[0]}'s armour class into ${o[1]}`,
  'get stat': o => `put ${o[1]}'s ${o[0]} into ${o[2]}`,
  'get object type': o => `put the kind of object ${o[0]} is into ${o[1]}`,
  'adjust gold': o => `give ${o[0]} ${o[1]} (a negative amount takes it away)`,
  'attack': o => `make ${o[0]} attack ${o[1]}`,
  'random': o => `put a random number from ${o[0]} to ${o[1]} into ${o[2]}`,
  'get social class': o => `put ${o[0]}'s social class into ${o[1]}`,
  'get origin': o => `put ${o[0]}'s origin into ${o[1]}`,
  'transform attachee into basic prototype': o => `turn this object back into its basic prototype ${o[0]}`,
  'transfer item': o => `move ${o[0]} from ${o[1]} to ${o[2]}`,
  'get story state': (o, simple) => `put the ${simple ? 'main ' : 'story state (how far the main story is)'}${simple ? 'story state' : ''} into ${o[0]}`,
  'set story state': o => `move the main story on to ${o[0]}`,
  'teleport': o => `teleport ${o[0]} to ${o[1]}, tile ${o[2]}, ${o[3]}`,
  'set day standpoint': o => `make ${o[0]} stand on tile ${o[1]}, ${o[2]} during the day`,
  'set night standpoint': o => `make ${o[0]} stand on tile ${o[1]}, ${o[2]} at night`,
  'get skill': o => `put ${o[1]}'s level in ${o[0]} into ${o[2]}`,
  'cast spell': o => `make ${o[0]} cast ${o[1]} on ${o[2]}`,
  'mark map location': o => `mark ${o[0]} on ${o[1]}'s world map`,
  'set rumor': o => `${o[1]} learns ${o[0]}`,
  'quell rumor': o => `quell ${o[0]}`,
  'create object': o => `create prototype ${o[0]} where ${o[1]} stands`,
  'set lock state': o => `make ${o[0]} ${o[1]}`,
  'call script in': o => `in ${o[4]}, run ${o[0]} from ${o[1]} (triggerer: ${o[2]}, attached to: ${o[3]})`,
  'call script at': o => `at ${o[4]} (game time), run ${o[0]} from ${o[1]} (triggerer: ${o[2]}, attached to: ${o[3]})`,
  'toggle state': o => `switch ${o[0]} on if it is off, off if it is on`,
  'toggle invulnerability': o => `make ${o[0]} unhurtable, or hurtable again`,
  'kill': o => `kill ${o[0]}`,
  'change art num': o => `change the picture of ${o[0]} (art number ${o[1]})`,
  'damage': o => `hurt ${o[0]}: ${o[1]} points of ${o[2]} damage`,
  'cast spell on': o => `cast ${o[0]} on ${o[1]}`,
  'action perform animation': o => `make ${o[0]} play animation ${o[1]}`,
  'give quest xp': o => `give ${o[0]} the experience of a ${o[1]} quest`,
  'written ui start book': o => `open book ${o[0]} for ${o[1]}`,
  'written ui start image': o => `show picture ${o[0]} to ${o[1]}`,
  'create item': o => `create prototype ${o[0]} in ${o[1]}'s inventory`,
  'action wait for leader': o => `make ${o[0]} wait here for their leader`,
  'destroy': o => `destroy ${o[0]}`,
  'action walk to': o => `make ${o[0]} walk to tile ${o[1]}, ${o[2]}`,
  'get weapon type': o => `put the kind of weapon ${o[0]} holds into ${o[1]}`,
  'distance between': o => `put the distance (in tiles) between ${o[0]} and ${o[1]} into ${o[2]}`,
  'add reputation': o => `give ${o[0]} ${o[1]}`,
  'remove reputation': o => `take ${o[1]} away from ${o[0]}`,
  'action run to': o => `make ${o[0]} run to tile ${o[1]}, ${o[2]}`,
  'heal hp': o => `heal ${o[0]} by ${o[1]} hit points`,
  'heal fatigue': o => `restore ${o[1]} fatigue points to ${o[0]}`,
  'add effect': o => `put ${o[1]} on ${o[0]}`,
  'remove effect': o => `take ${o[1]} away from ${o[0]}`,
  'action use item': o => `make ${o[0]} use ${o[1]} on ${o[2]}`,
  'get magictech adjustment': o => `put ${o[0]} adjusted for how well magick and technology mix here into ${o[4]}`,
  'call script ex': o => `run ${o[0]}'s own script for its ${o[1]} event, from ${o[2]}, with ${o[3]} as its triggerer`,
  'play sound': o => `play sound ${o[0]}`,
  'play sound on': o => `play sound ${o[0]} from ${o[1]}`,
  'get area': o => `put the area ${o[0]} is in into ${o[1]}`,
  'queue newspaper': o => `print newspaper ${o[0]} later (${o[1]})`,
  'float newspaper headline': o => `${o[1]} shows today's newspaper headline`,
  'play sound scheme': o => `switch the music to scheme ${o[0]} and the ambient sound to scheme ${o[1]}`,
  'toggle open closed': o => `open ${o[0]} if it is closed, close it if it is open`,
  'get faction': o => `put ${o[0]}'s faction into ${o[1]}`,
  'get scroll distance': o => `put how far the screen has scrolled into ${o[0]}`,
  'get magictech adjustment ex': o => `put ${o[0]}, scaled by how well ${o[1]} works for ${o[2]} (magick and technology), into ${o[3]}`,
  'rename': o => `rename ${o[0]} to ${o[1]}`,
  'action become prone': o => `make ${o[0]} lie down`,
  'set written start': o => `make the book ${o[0]} open at page ${o[1]}`,
  'get location': o => `put the tile ${o[0]} stands on into ${o[1]} (x) and ${o[2]} (y)`,
  'get day since startup': o => `put the number of days since the game started into ${o[0]}`,
  'get current hour': o => `put the hour of the day into ${o[0]}`,
  'get current minute': o => `put the minute into ${o[0]}`,
  'change script': o => `make ${o[0]} run ${o[2]} for its ${o[1]} event`,
  'set global flag': o => `set ${o[0]}`,
  'clear global flag': o => `clear ${o[0]}`,
  'fade and teleport': o => `fade the screen and teleport ${o[3]} to ${o[4]}, tile ${o[5]}, ${o[6]}`,
  'fade': () => 'fade the screen out or in',
  'play spell eye candy': o => `play the look of ${o[0]} on ${o[1]}`,
  'get hours since startup': o => `put the number of hours since the game started into ${o[0]}`,
  'toggle sector blocked': o => `block the sector at tile ${o[0]}, ${o[1]} (or unblock it)`,
  'get hit points': o => `put ${o[0]}'s hit points into ${o[1]} (now) and ${o[2]} (maximum)`,
  'get fatigue points': o => `put ${o[0]}'s fatigue points into ${o[1]} (now) and ${o[2]} (maximum)`,
  'action stop attacking': o => `make ${o[0]} stop fighting`,
  'toggle monster generator': o => `switch monster generator ${o[0]} off (or back on)`,
  'get armor coverage': o => `put how much of ${o[0]} is covered by armour into ${o[1]}`,
  'give spell mastery in college': o => `make ${o[0]} a master of the college of ${o[1]}`,
  'unfog townmap': o => `reveal the whole town map ${o[0]}`,
  'start written ui': o => `show the written text ${o[0]} to ${o[1]}`,
  'action try to steal 100 coins': o => `make ${o[0]} try to steal 100 coins from ${o[1]}`,
  'stop spell eye candy': o => `stop the look of ${o[0]} on ${o[1]}`,
  'grant one fate point': o => `give ${o[0]} one fate point`,
  'cast free spell': o => `make ${o[0]} cast ${o[1]} on ${o[2]} for free`,
  'set pc quest unbotched': o => `for ${o[0]}, undo the failure of ${o[1]}`,
  'play script eye candy': o => `play ${o[0]} on ${o[1]}`,
  'action cast unresistable spell': o => `make ${o[0]} cast ${o[1]} on ${o[2]} (it cannot be resisted)`,
  'action cast free unresistable spell': o => `make ${o[0]} cast ${o[1]} on ${o[2]} for free (it cannot be resisted)`,
  'touch art': o => `load picture ${o[0]} in advance`,
  'stop script eye candy': o => `stop ${o[0]} on ${o[1]}`,
  'remove script call': o => `cancel the delayed call of script ${o[0]} on ${o[1]}`,
  'destroy item named': o => `destroy ${o[0]} carried by ${o[1]}`,
  'toggle item inventory display': o => `hide ${o[0]} in inventories (or show it again)`,
  'heal poison': o => `cure ${o[1]} points of poison from ${o[0]}`,
  'start schematic ui': o => `open the schematics window for ${o[0]}`,
  'stop spell': o => `end ${o[0]} on ${o[1]}`,
  'queue slide': o => `add slide ${o[0]} to the ending of the game`,
  'end game and play slides': () => 'end the game and show the ending slides',
  'set rotation': o => `turn ${o[0]} to face direction ${o[1]}`,
  'set faction': o => `put ${o[0]} in faction ${o[1]}`,
  'drain charges': o => `use up ${o[0]} charges of ${o[1]}`,
  'cast unresistable spell': o => `cast ${o[0]} on ${o[1]} (it cannot be resisted)`,
  'adjust stat': o => `change ${o[1]}'s ${o[0]} by ${o[2]}`,
  'apply unresistable damage': o => `hurt ${o[0]}: ${o[1]} points of ${o[2]} damage that nothing can resist`,
  'set autolevel scheme': o => `make ${o[0]} level up following scheme ${o[1]}`,
  'set day standpoint ex': o => `make ${o[0]} stand on tile ${o[2]}, ${o[3]} of map ${o[1]} during the day`,
  'set night standpoint ex': o => `make ${o[0]} stand on tile ${o[2]}, ${o[3]} of map ${o[1]} at night`,
};

const words = (def, st, ctx) => def.ops.map((kind, i) => operandText(kind, st.opType[i], st.opValue[i], roleOf(def.name, i), ctx));
const generic = (def, o) => `${def.name}${o.length ? ` (${o.join(', ')})` : ''}`;
export function conditionText(def, st, ctx) {
  // "global flag N == 1 / 0" (and pc flags): a yes / no compared with 1 or 0 reads as "is set / is not set".
  if (def.name === 'eq') {
    const isFlag = i => /flag$/.test(SCR_VALUE_TYPES[st.opType[i]] || '');
    const isBit = i => SCR_VALUE_TYPES[st.opType[i]] === 'number' && (st.opValue[i] === 0 || st.opValue[i] === 1);
    for (const [f, n] of [[0, 1], [1, 0]]) {
      if (isFlag(f) && isBit(n)) return `${valueText(st.opType[f], st.opValue[f], null, ctx)} is ${st.opValue[n] ? 'set' : 'not set'}`;
    }
  }
  return (COND[def.name] || (o => generic(def, o)))(words(def, st, ctx), ctx?.simple);
}
export const actionText = (def, st, ctx) => (ACT[def.name] || (o => generic(def, o)))(words(def, st, ctx), ctx?.simple);

// The whole line as one or two sentences (with ⟦L:n⟧ / ⟦S:n⟧ link markers).
export function lineText(entry, condDef, actDef, elsDef, ctx) {
  const act = actionText(actDef, entry.action, ctx);
  if (entry.type === 0) return `${cap(act)}.`;
  const cond = conditionText(condDef, entry, ctx);
  const otherwise = entry.els.type !== 0 && elsDef ? ` Otherwise, ${actionText(elsDef, entry.els, ctx)}.` : ' Otherwise, carry on with the next line.';
  return `If ${cond}, ${act}.${otherwise}`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// The terms a script uses (for the glossary), from its operands.
export function termsUsed(entries, defOf) {
  const used = new Set();
  for (const e of entries) {
    const parts = [[e, defOf.cond(e.type)], [e.action, defOf.act(e.action.type)]];
    if (e.type !== 0) parts.push([e.els, defOf.act(e.els.type)]);   // an always-true line never takes its else
    for (const [st, def] of parts) {
      if (!def) continue;
      def.ops.forEach((kind, i) => {
        if (kind === 'obj' || kind === 'objdst') { const t = focusTermOf(SCR_FOCUS_OBJECTS[st.opType[i]]); if (t) used.add(t); if (/follower|party|team|group/.test(SCR_FOCUS_OBJECTS[st.opType[i]] || '')) used.add('followers, party, team, group'); }
        else if (kind === 'val' || kind === 'dst') {
          const v = SCR_VALUE_TYPES[st.opType[i]];
          const t = { counter: 'counter', 'lc var': 'local var', 'gl var': 'global var', 'gl flag': 'global flag', 'pc var': 'pc var', 'pc flag': 'pc flag' }[v];
          if (t) used.add(t);
          const r = roleOf(def.name, i);
          if (r === 'lflag') used.add('local flag');
          if (r === 'gflag') used.add('global flag');
        }
      });
    }
  }
  return [...used];
}

// ---- "Simplify": lines merged into readable paragraphs ------------------------------------------------
//
// The engine runs a line, then goes to the next one unless the action jumps ("goto") or ends the script
// ("return and skip / run default"). So a line whose branch just falls through to an unconditional line
// can be told together with it: "If …, this object says …, and then stop the script. Otherwise, go to line 2."
// A line is only folded into the one before it when no "goto" (and no loop) lands on it, so every
// line a jump goes to still has a row of its own. Loops are left alone.

const RET_SKIP = 'return and skip default', RET_RUN = 'return and run default';
const isLoopAction = name => name === 'loop for' || name === 'loop end' || name === 'loop break';
const MAX_CHAIN = 6;   // actions told in one row at most

const STOP_SKIP = "stop the script (skipping the game's normal reaction)";
const STOP_RUN = 'stop the script (the game then reacts normally)';

// Where a branch leads: { next } falls to the following line, { go } jumps, { stop } ends the script.
function flowOf(def, st) {
  if (def.name === 'goto' && SCR_VALUE_TYPES[st.opType[0]] === 'number') return { go: st.opValue[0] };
  if (def.name === RET_SKIP) return { stop: STOP_SKIP };
  if (def.name === RET_RUN) return { stop: STOP_RUN };
  return { next: true };
}
const flowPhrase = f => (f.go !== undefined ? `go to ⟦L:${f.go}⟧` : f.stop);
// "A", "A, and then B", "A, then B, and then C"
const joinSteps = items => (items.length < 2 ? (items[0] || '') : `${items.slice(0, -1).join(', then ')}, and then ${items[items.length - 1]}`);
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);

// A quest named again in the same row is just "it".
const shortenRepeats = text => {
  const seen = new Set();
  return text.replace(/the quest “[^”]*”/g, q => (seen.has(q) ? 'it' : (seen.add(q), q)));
};

// Rows [{ from, to, text }] for `entries` (decoded lines). defs: { cond(type), act(type) } -> schema entry.
export function simplifyRows(entries, defs, ctxIn) {
  const ctx = { ...ctxIn, simple: true };   // the triggerer is the default subject here, so it is not spelled out
  const n = entries.length;
  const cDef = e => defs.cond(e.type) || { name: `condition ${e.type}`, ops: [] };
  const aDef = st => defs.act(st.type) || { name: `action ${st.type}`, ops: [] };

  // Lines a jump can land on, and lines that hold a loop: neither is folded into the line before.
  const targets = new Set();
  entries.forEach((e, i) => {
    const sts = e.type === 0 ? [e.action] : [e.action, e.els];
    for (const st of sts) {
      const d = aDef(st);
      if (d.name === 'goto' && SCR_VALUE_TYPES[st.opType[0]] === 'number') targets.add(st.opValue[0]);
      if (d.name === 'loop for' || d.name === 'loop end') targets.add(i + 1);   // the loop's start / where a "break" lands
    }
  });
  const hasLoop = e => isLoopAction(aDef(e.action).name) || (e.type !== 0 && isLoopAction(aDef(e.els).name));

  // The unconditional lines that follow `from`, told in one go: { parts, flow, end (the first line not told) }.
  // `own`: `from` is the line whose row this is, so it may be a jump target itself (only absorbed lines may not).
  const chain = (from, own = false) => {
    const parts = [];
    let t = from, flow = { next: true };
    while (t < n && parts.length < MAX_CHAIN) {
      const x = entries[t];
      if ((targets.has(t) && !(own && t === from)) || x.type !== 0 || hasLoop(x)) break;
      const d = aDef(x.action), f = flowOf(d, x.action);
      if (f.next && d.name !== 'do nothing') parts.push(actionText(d, x.action, ctx));
      t++; flow = f;
      if (!f.next) break;
    }
    return { parts, flow, end: t };
  };
  // "<parts>, then <where it ends>"
  const tell = (parts, flow, fallThrough = 'carry on with the next line') => {
    const items = parts.slice();
    if (!flow.next) items.push(flowPhrase(flow)); else if (!items.length) items.push(fallThrough);
    return joinSteps(items);
  };
  const own = (d, st, flow) => (flow.next && d.name !== 'do nothing' ? actionText(d, st, ctx) : null);

  const rows = [];
  for (let i = 0; i < n;) {
    const e = entries[i];
    if (hasLoop(e)) {
      rows.push({ from: i, to: i, text: lineText(e, cDef(e), aDef(e.action), e.type !== 0 ? aDef(e.els) : null, ctx) });
      i++; continue;
    }
    if (e.type === 0) {
      const c = chain(i, true);
      rows.push({ from: i, to: Math.max(i, c.end - 1), text: shortenRepeats(`${cap1(tell(c.parts, c.flow))}.`) });
      i = Math.max(i + 1, c.end); continue;
    }
    const cond = conditionText(cDef(e), e, ctx);
    const ad = aDef(e.action), thenFlow = flowOf(ad, e.action), thenOwn = own(ad, e.action, thenFlow);
    const hasElse = e.els.type !== 0, ed = aDef(e.els);
    const elseFlow = hasElse ? flowOf(ed, e.els) : { next: true }, elseOwn = hasElse ? own(ed, e.els, elseFlow) : null;
    let text, end = i + 1;
    if (thenFlow.next && elseFlow.next) {
      // Both branches fall to the next line: what follows is told once, for both.
      const c = chain(i + 1);
      const first = thenOwn ? `If ${cond}, ${thenOwn}.` : `If ${cond}, nothing happens.`;
      const second = elseOwn ? ` Otherwise, ${elseOwn}.` : '';
      text = `${first}${second} ${elseOwn ? 'Either way' : 'Then'}, ${tell(c.parts, c.flow)}.`;
      end = c.end;
    } else if (thenFlow.next) {
      // The yes-branch carries on into the following lines (the else-branch jumps or stops).
      const c = chain(i + 1);
      const mine = [thenOwn, ...c.parts].filter(Boolean);
      text = `If ${cond}, ${tell(mine, c.parts.length || !c.flow.next ? c.flow : { next: true })}. Otherwise, ${joinSteps([elseOwn, flowPhrase(elseFlow)].filter(Boolean))}.`;
      end = c.end;
    } else if (elseFlow.next) {
      // The else-branch carries on into the following lines (the yes-branch jumps or stops).
      const c = chain(i + 1);
      const mine = [elseOwn, ...c.parts].filter(Boolean);
      text = `If ${cond}, ${flowPhrase(thenFlow)}. Otherwise, ${tell(mine, c.parts.length || !c.flow.next ? c.flow : { next: true })}.`;
      end = c.end;
    } else {
      text = `If ${cond}, ${flowPhrase(thenFlow)}. Otherwise, ${flowPhrase(elseFlow)}.`;
    }
    rows.push({ from: i, to: end - 1, text: shortenRepeats(text) });
    i = end;
  }
  return rows;
}
