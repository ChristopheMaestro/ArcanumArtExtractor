// What the editor's Dialog and Quest tools write, as pure functions (no DOM).
//
//  - a dialog is a model (an NPC line with the options the player can pick, each with its own answer) that becomes a
//    .dlg file (game/dialog.c: seven {braced} fields per line) plus the small .scr script that opens it; both files
//    carry the same script number in their name, which is how the game finds the dialog of a script;
//  - a quest is the text of a line of mes/gamequestlog.mes (the logbook), keyed by the quest number.

export const QUEST_STATES = ['not started', 'mentioned', 'accepted', 'achieved', 'completed', 'completed by someone else', 'botched'];

// Text in a {braced} field: no braces, one line.
const clean = s => String(s ?? '').replace(/[{}]/g, '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
const int = (v, lo, hi, def = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const signed = n => `${n >= 0 ? '+' : ''}${n}`;

// What an option can need before it is offered ("tests") and do when picked ("effects"). `code` writes the field
// text the game's parser reads (dlg-codes.js explains the same codes back in words).
export const CONDITIONS = {
  cha: { label: 'Charisma is at least', args: [{ n: 'value', min: 1, max: 30, def: 8 }], code: a => `ch ${int(a.value, 1, 30, 8)}` },
  ps: { label: 'Persuasion skill is at least', args: [{ n: 'value', min: 1, max: 100, def: 20 }], code: a => `ps ${int(a.value, 1, 100, 20)}` },
  level: { label: 'Level is at least', args: [{ n: 'value', min: 1, max: 99, def: 5 }], code: a => `le ${int(a.value, 1, 99, 5)}` },
  gold: { label: 'The player has at least … gold', args: [{ n: 'value', min: 1, max: 1000000000, def: 100 }], code: a => `$$ ${int(a.value, 1, 1e9, 100)}` },
  questIs: { label: 'Quest is exactly', quest: true, code: a => `qu${int(a.quest, 1, 99999, 1)} ${int(a.state, 0, 6, 0)}` },
  questAtLeast: { label: 'Quest is at least', quest: true, code: a => `qa${int(a.quest, 1, 99999, 1)} ${int(a.state, 0, 6, 0)}` }
};
export const EFFECTS = {
  giveGold: { label: 'Player receives … gold', args: [{ n: 'value', min: 1, max: 1000000000, def: 100 }], code: a => `$$ ${int(a.value, 1, 1e9, 100)}` },
  takeGold: { label: 'Player pays … gold', args: [{ n: 'value', min: 1, max: 1000000000, def: 100 }], code: a => `$$ -${int(a.value, 1, 1e9, 100)}` },
  reaction: { label: 'NPC likes the player more (+) or less (−) by', args: [{ n: 'value', min: -50, max: 50, def: 5 }], code: a => `re ${signed(int(a.value, -50, 50, 5))}` },
  alignment: { label: 'Player alignment: good (+) or evil (−) by', args: [{ n: 'value', min: -100, max: 100, def: 5 }], code: a => `al ${signed(int(a.value, -100, 100, 5))}` },
  quest: { label: 'Set quest', quest: true, code: a => `qu${int(a.quest, 1, 99999, 1)} ${int(a.state, 0, 6, 2)}` },
  xp: { label: 'Player gains quest experience of level', args: [{ n: 'value', min: 1, max: 40, def: 1 }], code: a => `xp ${int(a.value, 1, 40, 1)}` }
};
export const conditionCode = c => (CONDITIONS[c.t] ? CONDITIONS[c.t].code(c) : '');
export const effectCode = e => (EFFECTS[e.t] ? EFFECTS[e.t].code(e) : '');

// ---- dialog model --------------------------------------------------------------------------------------------------
//   dialog = { num, name, root: node }       node = { say, options: [option], bye: bool }
//   option = { text, conds: [{ t, ...args }], effects: [{ t, ...args }], then: 'reply' | 'end' | 'back' | 'attack', reply: node }
export const MAX_OPTIONS = 8;
export const newNode = say => ({ say: say || '', options: [], bye: true });
export const newOption = text => ({ text: text || '', conds: [], effects: [], then: 'reply', reply: newNode('') });
export const newDialog = (num, name) => ({ num, name: name || 'Talker', root: newNode('') });

// "Innkeeper's Rest" -> "InnkeepersRest": the part of the file name after the five digits
export const safeName = s => String(s || '').replace(/[^A-Za-z0-9_]+/g, '').slice(0, 40) || 'Dialog';
export const dialogStem = d => `${String(Math.max(0, Math.round(Number(d.num) || 0))).padStart(5, '0')}${safeName(d.name)}`;

// Number the lines: the opening line is 1 and its options are 2-9; every other NPC line is a multiple of ten (10, 20...)
// followed by its options (11-19, ...); the last slot of a group is the goodbye. The game reads the options of a line
// as the lines that follow it up to the next NPC line.
export function compileDialog(dialog) {
  const lines = [], problems = [];
  let next = 0;
  const addLine = (num, text, female, iq, cond, response, action) => lines.push({ num, text, female, iq, cond, response, action });
  function node(n, base, where) {
    const base0 = base === 1 ? 1 : base;
    const say = clean(n.say);
    if (!say) problems.push(`${where}: the NPC has nothing to say here`);
    const act = '';
    addLine(base0, say || '...', say || '...', 0, '', '', act);
    const slot0 = base === 1 ? 2 : base + 1, last = base === 1 ? 9 : base + 9;
    let slot = slot0;
    const todo = [];
    n.options.slice(0, MAX_OPTIONS).forEach((o, i) => {
      const num = slot++, label = `${where} › option ${i + 1}`;
      const text = clean(o.text);
      if (!text) problems.push(`${label}: the player has nothing to say`);
      const conds = (o.conds || []).map(conditionCode).filter(Boolean).join(', ');
      const effects = (o.effects || []).map(effectCode).filter(Boolean);
      let response = 0;
      if (o.then === 'attack') effects.push('co');
      else if (o.then === 'back') response = 1;
      else if (o.then === 'reply') { next++; response = next * 10; todo.push({ reply: o.reply, base: response, label: `${label} › the NPC answers` }); }
      addLine(num, text || '...', '', 5, conds, response, effects.join(', '));
    });
    if (n.bye !== false && slot <= last) addLine(last, 'E:', '', 1, '', 0, '');
    else if (!n.options.length) problems.push(`${where}: no option to pick - add one or keep the goodbye`);
    for (const t of todo) node(t.reply, t.base, t.label);
  }
  node(dialog.root, 1, 'Opening line');
  const field = v => `{${v}}`;
  const text = lines.map(l => `${field(l.num)}${field(l.text)}${field(l.female)}${field(l.iq || '')}${field(l.cond)}${field(l.response === '' ? '' : l.response)}${field(l.action || ' ')}`).join('\r\n') + '\r\n';
  return { text, lines, problems };
}

// ---- the script that opens the dialog ------------------------------------------------------------------------------
// game/script.c: 0x40 header bytes, then 0x84-byte lines; the one line here is "always: dialog line 1" (the same
// bytes as the game's own plain talkers, e.g. 01031BlackRootPeasant.scr). Unused operands hold 0xCC as in the originals.
export function buildDialogScript(description) {
  const out = new Uint8Array(0x40 + 0x84).fill(0xCC);
  const view = new DataView(out.buffer);
  out.fill(0, 0, 0x40);
  const desc = String(description || '').replace(/[^\x20-\x7e]/g, '').slice(0, 39);
  for (let i = 0; i < desc.length; i++) out[8 + i] = desc.charCodeAt(i);
  view.setInt32(0x34, 1, true);     // number of lines
  view.setInt32(0x38, 10, true);    // room for
  const action = (o, type, ops) => {   // ops: [[operandType, value]...]
    view.setInt32(o, type, true);
    ops.forEach(([t, v], i) => { out[o + 4 + i] = t; view.setInt32(o + 12 + i * 4, v, true); });
  };
  action(0x40, 0, []);                 // condition: true
  action(0x40 + 0x2C, 4, [[3, 1]]);    // action: dialog, line 1
  action(0x40 + 0x58, 0, []);          // else: nothing
  return out;
}

// ---- the logbook ---------------------------------------------------------------------------------------------------
const toLatin1 = s => Uint8Array.from(s, ch => { const c = ch.charCodeAt(0); return c < 256 ? c : 0x3F; });
const fromLatin1 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };

// The shipped .mes (bytes) with the quests set: a quest that exists is reworded in place, others go at the end.
// `pick(q)` is the text to use for that file. Returns the new file's bytes.
export function mergeQuestLog(origBytes, quests, pick) {
  const eol = '\r\n';
  const lines = fromLatin1(origBytes).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const wanted = new Map(quests.map(q => [Number(q.id), clean(pick(q)) || clean(q.text)]));
  const done = new Set();
  const merged = lines.map(line => {
    const m = /^\{(\d+)\}/.exec(line);
    const id = m ? Number(m[1]) : NaN;
    if (!wanted.has(id)) return line;
    done.add(id);
    return `{${m[1]}}{${wanted.get(id)}}`;
  });
  for (const [id, text] of wanted) if (!done.has(id)) merged.push(`{${String(id).padStart(4, '0')}}{${text}}`);
  return toLatin1(merged.join(eol) + eol);
}

// The files a session's dialogs and quests become, named by their place under the game's data folder.
// fetchBytes(path) reads a shipped file (the logbook is merged into the game's own).
export const storyFileCount = story => story.dialogs.length * 2 + (story.quests.length ? 2 : 0);
export async function storyFiles(story, fetchBytes) {
  const files = [];
  for (const d of story.dialogs) {
    const stem = dialogStem(d);
    files.push({ name: `dlg/${stem}.dlg`, bytes: stringBytes(compileDialog(d).text) }, { name: `scr/${stem}.scr`, bytes: buildDialogScript(safeName(d.name)) });
  }
  if (story.quests.length) {
    const logs = [['gamequestlog.mes', q => q.text], ['gamequestlogdumb.mes', q => q.dumb || q.text]];
    // both read at once; awaited in order, so a failure reports the same file as before
    const reads = logs.map(([file]) => Promise.resolve(fetchBytes(`mes/${file}`)));
    for (const r of reads) r.catch(() => {});
    for (let i = 0; i < logs.length; i++) {
      const [file, pick] = logs[i];
      files.push({ name: `mes/${file}`, bytes: mergeQuestLog(await reads[i], story.quests, pick) });
    }
  }
  return files;
}

export const lowestFree =(used, from) => { let n = from; while (used.has(n)) n++; return n; };
export const stringBytes = s => toLatin1(s);
