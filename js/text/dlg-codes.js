// .dlg test and effect fields ("me 1, qu1032 0, gf2363 1") explained in plain words.
//
// Parsing follows game/dialog.c: sub_4150D0() (tests) and sub_415BA0() (effects) skip to the
// next letter or '$', read a two-character code, then atoi() the first number right after it;
// codes with a second number read it with sub_4167C0() (skip spaces, skip the first number's
// digits, atoi() the rest). A test field is true only if every test passes.

import { DATA_ROOT } from '../core/config.js';
import { mesTable } from '../core/text-io.js';
import { flagMeaning, loadGlobalFlagIndex } from '../scr/scr-global-flags.js';

const mes = path => mesTable(`${DATA_ROOT}${path}`);
const T = {
  quest: mes('mes/gamequestlog.mes'),
  oname: mes('oemes/oname.mes'),
  desc: mes('mes/description.mes'),
  gamedesc: mes('mes/gamedesc.mes'),
  area: mes('mes/gamearea.mes'),
  rep: mes('mes/gamereplog.mes'),
  stat: mes('mes/stat.mes'),
  spell: mes('mes/spell.mes'),
  skill: mes('mes/skill.mes'),
  story: mes('mes/StoryState.mes'),
  rumor: mes('mes/game_rd_npc_m2m.mes'),
  xp: mes('Rules/xp_quest.mes'),
};
let flagIndex = null;

// Load everything the explanations look up; call before rendering (explain*() are synchronous).
export const loadCodeTables = () => Promise.all([
  ...Object.values(T).map(t => t().catch(() => null)),
  loadGlobalFlagIndex().then(i => { flagIndex = i; }).catch(() => null),
]);

const get = (t, n) => T[t].peek()?.get(n);
const short = (s, max = 90) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const quote = s => (s ? ` “${short(s)}”` : '');

const QUEST_STATES = ['not started', 'mentioned', 'accepted', 'achieved', 'completed', 'completed by someone else', 'botched'];
const TRAINING = ['none', 'apprentice', 'expert', 'master'];
const questState = v => QUEST_STATES[v] ?? `state ${v}`;
const quest = n => `quest ${n}${quote(get('quest', n))}`;
const item = n => {
  const name = get('oname', n)?.replace(/^\s*\d+\s+/, '') || get('desc', n) || get('gamedesc', n);
  return name ? `“${short(name, 60)}” (name ${n})` : `item with name ${n}`;
};
const person = n => { const name = get('desc', n) || get('gamedesc', n) || get('oname', n)?.replace(/^\s*\d+\s+/, ''); return name ? `“${name}” (name ${n})` : `name ${n}`; };
const area = n => { const m = /\/([^/]*)\//.exec(get('area', n) || ''); return m ? `“${m[1].trim()}” (area ${n})` : `area ${n}`; };
const rumor = n => `rumor ${n}${quote(get('rumor', 20 * n) || get('rumor', 20 * n + 1))}`;
const reputation = n => { const s = get('rep', n); return `reputation ${n}${s ? ` “${short(s.split(/(?<=\.)\s/)[0], 70)}”` : ''}`; };
const skill = n => get('skill', n) || `skill ${n}`;
const college = n => get('spell', 500 + n) || `college ${n}`;
const race = n => get('stat', 30 + n) || `race ${n}`;
const story = n => `story state ${n}${quote(get('story', n))}`;
const flag = (n, on) => {
  const meaning = flagIndex ? flagMeaning(flagIndex, n) : '';
  return `${on}${meaning ? ` — ${meaning}` : ''}`;
};
// "at least N" for N >= 0, "at most -N" for N < 0 (the usual dialogue convention).
const bound = (what, v) => (v < 0 ? `${what} at most ${-v}` : `${what} at least ${v}`);

// The same names for the .scr explanations (scr/scr-explain.js), after loadCodeTables().
export const gameNames = {
  get, short, QUEST_STATES, questState, quest, item, person, area, rumor, reputation, skill, college, race, story,
  questText: n => get('quest', n) || '', statName: n => get('stat', n) || `stat ${n}`, spellName: n => get('spell', n) || `spell ${n}`,
  flagMeaningOf: n => (flagIndex ? flagMeaning(flagIndex, n) : ''),
};

// The engine's tokenizer.
export function parseCodes(str) {
  const s = String(str || ''), out = [];
  const atoi = i => { const m = /^\s*([+-]?\d+)/.exec(s.slice(i)); return m ? Number(m[1]) : 0; };
  const second = i => { let j = i; while (/\s/.test(s[j] || '')) j++; while (/\d/.test(s[j] || '')) j++; return atoi(j); };
  let i = 0;
  while (i < s.length) {
    while (i < s.length && !/[A-Za-z$]/.test(s[i])) i++;
    if (i + 1 >= s.length) break;
    const start = i;
    const code = s.slice(i, i + 2).toLowerCase();
    i += 2;
    const value = atoi(i), value2 = second(i);
    const op = (/^\s*([+\-<>])/.exec(s.slice(i)) || [])[1] || '';
    // The raw token runs to the next code.
    let end = i;
    while (end < s.length && !/[A-Za-z$]/.test(s[end])) end++;
    out.push({ code, value, value2, op, raw: s.slice(start, end).replace(/[\s,]+$/, '') });
    i = end;
  }
  return out;
}

function condition({ code, value: v, value2: w }) {
  switch (code) {
    case 'ps': return bound('Persuasion skill', v);
    case 'ch': return bound('Charisma', v);
    case 'pe': return bound('Perception', v);
    case 'al': return bound('alignment', v);
    case 'ma': return bound('magickal aptitude', v);
    case 'ta': return bound('technological aptitude', v);
    case 'ha': return bound('Haggle skill', v);
    case 're': return bound('NPC\'s reaction to the PC', v);
    case 'le': return bound('PC level', v);
    case 'ss': return bound('story state', v) + (v >= 0 ? quote(get('story', v)) : '');
    case '$$': return v < 0 ? `PC and followers have at most ${-v} gold` : `PC and followers have at least ${v} gold`;
    case 'gv': return `global variable ${v} = ${w}`;
    case 'gf': return flag(v, `global flag ${v} is ${w ? 'set' : 'not set'}`);
    case 'qu': return `${quest(v)} is ${questState(w)}`;
    case 'qb': return `${quest(v)} is at most ${questState(w)}`;
    case 'qa': return `${quest(v)} is at least ${questState(w)}`;
    case 'in': return v < 0 ? `NPC carries ${item(-v)}` : `PC or a follower carries ${item(v)}`;
    case 'ni': return v < 0 ? `NPC does not carry ${item(-v)}` : `neither the PC nor a follower carries ${item(v)}`;
    case 'lf': return `NPC's local flag ${v} is ${w ? 'set' : 'not set'}`;
    case 'lc': return `NPC's local counter ${v} = ${w}`;
    case 'tr': return `${skill(v)} training ${w < 0 ? 'at most' : 'at least'} ${TRAINING[Math.abs(w)] ?? Math.abs(w)}`;
    case 'sk': return bound(`${skill(v)} skill`, w);
    case 'ru': return v < 0 ? `PC does not know ${rumor(-v)}` : `PC knows ${rumor(v)}`;
    case 'rq': return v < 0 ? `${rumor(-v)} is not quelled` : `${rumor(v)} has been quelled`;
    case 'fo': return v === 0 ? 'NPC is following the PC' : v === 1 ? 'NPC is not following the PC' : `fo ${v} (always true)`;
    case 'me': return v === 0 ? 'first meeting: the NPC has not met the PC' : v === 1 ? 'the NPC has met the PC before' : `me ${v} (always true)`;
    case 'ra': return v > 0 ? `PC is a ${race(v - 1)}` : `PC is not a ${race(-v - 1)}`;
    case 'pa': return v < 0 ? `${person(-v)} is not in the party` : `${person(v)} is in the party`;
    case 'wa': return v ? 'NPC is waiting (was told to wait here)' : 'NPC is not waiting';
    case 'wt': return v ? 'NPC has been jilted' : 'NPC has not been jilted';
    case 'pv': return `PC variable ${v} = ${w}`;
    case 'pf': return `PC flag ${v} is ${w ? 'set' : 'not set'}`;
    case 'na': return v < 0 ? `alignment at most ${v}` : `alignment at least ${-v}`;
    case 'ar': return v > 0 ? `PC knows ${area(v)}` : `PC does not know ${area(-v)}`;
    case 'rp': return v > 0 ? `PC has ${reputation(v)}` : `PC does not have ${reputation(-v)}`;
    case 'ia': return v > 0 ? `PC is in ${area(v)}` : `PC is not in ${area(-v)}`;
    case 'sc': return bound(`${college(v)} college level`, w);
    default: return `unknown test “${code}” (the engine treats the line as failing)`;
  }
}

function action({ code, value: v, value2: w, op }) {
  const adjust = what => (op === '+' || op === '-' ? `${what} ${v >= 0 ? '+' : ''}${v}` : op === '>' ? `raise ${what} to at least ${v}` : op === '<' ? `lower ${what} to at most ${v}` : `set ${what} to ${v}`);
  switch (code) {
    case '$$': return v > 0 ? `PC receives ${v} gold` : v < 0 ? `PC pays ${-v} gold to the NPC (followers chip in)` : 'no gold change';
    case 're': return adjust('NPC\'s reaction to the PC');
    case 'al': return adjust('PC alignment');
    case 'qu': return `${quest(v)} becomes ${questState(w)}`;
    case 'fl': return `NPC floats line ${v} and the dialogue ends`;
    case 'co': return 'NPC attacks the PC (combat)';
    case 'gv': return `global variable ${v} = ${w}`;
    case 'gf': return flag(v, `${w ? 'set' : 'clear'} global flag ${v}`);
    case 'mm': return `mark ${area(v)} on the PC's map`;
    case 'in': return v < 0 ? `NPC gives ${item(-v)} to the PC` : `PC gives ${item(v)} to the NPC`;
    case 'lf': return `${w ? 'set' : 'clear'} the NPC's local flag ${v}`;
    case 'lc': return `NPC's local counter ${v} = ${w}`;
    case 'tr': return `set ${skill(v)} training to ${TRAINING[w] ?? w}`;
    case 'ru': return `PC learns ${rumor(v)}`;
    case 'rq': return `${rumor(v)} is quelled`;
    case 'jo': return `NPC joins the party, then line ${w} (if it refuses, it says why)`;
    case 'wa': return 'NPC waits here';
    case 'lv': return 'NPC leaves the party';
    case 'ss': return `set ${story(v)}`;
    case 'sc': return 'NPC stays close';
    case 'so': return 'NPC spreads out';
    case 'uw': return `NPC stops waiting and rejoins, then line ${w}`;
    case 'pv': return `PC variable ${v} = ${w}`;
    case 'pf': return `${w ? 'set' : 'clear'} PC flag ${v}`;
    case 'xp': { const xp = get('xp', v); return `PC gains quest experience of level ${v}${xp ? ` (${xp} XP)` : ''}`; }
    case 'nk': return 'NPC dies';
    case 'rp': return v > 0 ? `PC gains ${reputation(v)}` : `PC loses ${reputation(-v)}`;
    case 'np': return `queue newspaper ${v} (${w})`;
    case 'ce': return 'opens the NPC\'s character sheet';
    case 'fp': return 'PC gains a fate point';
    case 'su': return 'opens the NPC\'s schematics';
    case 'or': return `set the NPC's origin to ${v}`;
    case 'ii': return 'NPC identifies the PC\'s items';
    case 'ri': return 'NPC repairs the PC\'s items';
    case 'et': return `expert training in ${skill(v)} (needs the skill level and apprentice training), then line ${w}`;
    default: return `unknown effect “${code}” (ignored by the engine)`;
  }
}

// [{ raw, text }] for each test / effect of a field.
export const explainConditions = str => parseCodes(str).map(c => ({ raw: c.raw, text: condition(c) }));
export const explainActions = str => parseCodes(str).map(a => ({ raw: a.raw, text: action(a) }));
