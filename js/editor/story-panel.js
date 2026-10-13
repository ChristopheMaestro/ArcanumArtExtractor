// The side panels of the editor's Dialog and Quest tools. Both work on `story` ({ dialogs, quests }, kept by the editor
// for the whole session); what they hold becomes files at export (story-data.js).
import { DATA_ROOT } from '../core/config.js';
import { mesTable } from '../core/text-io.js';
import * as SD from './story-data.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, title, fn) => { const b = el('button', 'sec-me-btn', text); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };
const questMes = mesTable(`${DATA_ROOT}mes/gamequestlog.mes`);
let shippedQuests = new Map();
questMes().then(m => { shippedQuests = m; }).catch(() => {});

const short = (s, n = 70) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// the logbook text of a quest: one written in this session, else the game's
export const questTextOf = (story, id) => story.quests.find(q => q.id === id)?.text || shippedQuests.get(id) || '';
export const nextQuestId = story => {
  const used = new Set([...shippedQuests.keys(), ...story.quests.map(q => q.id)].map(Number));
  return SD.lowestFree(used, Math.max(1000, ...used) + 1);
};

// ===== Dialog ==========================================================================================================
// ctx: { story, changed(), scriptNumbers() -> Set of the numbers the game has, giveToNpc(num) }
export function createDialogPanel(host, ctx) {
  const story = ctx.story;
  let cur = null;
  const root = el('div', 'sec-me sec-st'); host.appendChild(root);
  let previewEl = null;

  const touch = () => { ctx.changed(); paintPreview(); };
  const nextScript = () => {
    const used = new Set([...ctx.scriptNumbers(), ...story.dialogs.map(d => d.num)]);
    return SD.lowestFree(used, Math.max(30000, ...used) + 1);
  };

  const field = (label, input, hint) => { const r = el('label', 'sec-me-row sec-st-row'); r.append(el('span', null, label), input); if (hint) r.title = hint; return r; };
  const textInput = (value, placeholder, on) => {
    const i = el('input'); i.type = 'text'; i.value = value; i.placeholder = placeholder || ''; i.maxLength = 600;
    i.addEventListener('input', () => on(i.value)); return i;
  };
  const textArea = (value, placeholder, on) => {
    const t = el('textarea'); t.rows = 2; t.value = value; t.placeholder = placeholder || ''; t.maxLength = 1200;
    t.addEventListener('input', () => on(t.value)); return t;
  };
  const numberInput = (value, { min = 1, max = 99999 } = {}, on) => {
    const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.value = value;
    i.addEventListener('input', () => { const v = Math.round(Number(i.value)); if (Number.isFinite(v)) on(v); });
    return i;
  };
  const select = (pairs, value, on) => {
    const s = el('select'); for (const [v, t] of pairs) s.append(new Option(t, v)); s.value = value;
    s.addEventListener('change', () => on(s.value)); return s;
  };

  // one test or effect: its kind, then what it needs (a number, or a quest and a state)
  function ruleEl(rule, defs, list, i) {
    const def = defs[rule.t], row = el('div', 'sec-st-rule');
    row.append(el('span', 'sec-st-rule-label', def.label));
    for (const a of def.args || []) row.append(numberInput(rule[a.n] ?? a.def, a, v => { rule[a.n] = v; touch(); }));
    if (def.quest) {
      const label = el('span', 'sec-st-quest-label');
      const show = () => { label.textContent = rule.quest > 0 ? (short(questTextOf(story, rule.quest)) || 'no such quest in the logbook') : ''; };
      row.append(numberInput(rule.quest, { min: 1 }, v => { rule.quest = v; show(); touch(); }));
      row.append(select(SD.QUEST_STATES.map((n, k) => [k, n]), String(rule.state), v => { rule.state = Number(v); touch(); }));
      show(); row.append(label);
    }
    row.append(button('×', 'Remove', () => { list.splice(i, 1); touch(); render(); }));
    return row;
  }
  function ruleAdder(defs, list, caption, make) {
    const s = el('select', 'sec-st-add'); s.append(new Option(caption, ''));
    for (const [id, d] of Object.entries(defs)) s.append(new Option(d.label, id));
    s.addEventListener('change', () => { if (!s.value) return; list.push(make(s.value, defs[s.value])); touch(); render(); });
    return s;
  }
  const newRule = (t, def) => {
    const r = { t };
    for (const a of def.args || []) r[a.n] = a.def;
    if (def.quest) { r.quest = story.quests.length ? story.quests[story.quests.length - 1].id : 1000; r.state = 2; }   // the newest quest, as a rule the one being written
    return r;
  };

  function optionEl(node, i, depth) {
    const o = node.options[i], card = el('div', 'sec-st-opt');
    const top = el('div', 'sec-st-opt-top');
    top.append(el('span', 'sec-st-tag', 'You say'), textInput(o.text, 'What the player can answer', v => { o.text = v; touch(); }),
      button('Remove', 'Delete this option', () => { node.options.splice(i, 1); touch(); render(); }));
    card.append(top);
    const conds = el('div', 'sec-st-rules');
    o.conds.forEach((c, k) => conds.append(ruleEl(c, SD.CONDITIONS, o.conds, k)));
    conds.append(ruleAdder(SD.CONDITIONS, o.conds, '+ Only offered when…', newRule));
    const effects = el('div', 'sec-st-rules');
    o.effects.forEach((e, k) => effects.append(ruleEl(e, SD.EFFECTS, o.effects, k)));
    effects.append(ruleAdder(SD.EFFECTS, o.effects, '+ When picked, also…', newRule));
    card.append(conds, effects);
    const then = el('div', 'sec-st-then');
    then.append(el('span', 'sec-st-tag', 'Then'), select([['reply', 'the NPC answers'], ['end', 'the conversation ends'], ['back', 'back to the opening line'], ['attack', 'the NPC attacks']], o.then, v => { o.then = v; if (v === 'reply' && !o.reply) o.reply = SD.newNode(''); touch(); render(); }));
    card.append(then);
    if (o.then === 'reply') {
      const sub = el('div', 'sec-st-reply');
      sub.append(nodeEl(o.reply, depth + 1, 'What the NPC answers'));
      card.append(sub);
    }
    return card;
  }

  function nodeEl(node, depth, placeholder) {
    const box = el('div', 'sec-st-node');
    box.append(el('span', 'sec-st-tag', 'NPC says'), textArea(node.say, placeholder, v => { node.say = v; touch(); }));
    for (let i = 0; i < node.options.length; i++) box.append(optionEl(node, i, depth));
    const bar = el('div', 'sec-st-bar');
    const add = button('+ Add an option', `The player can pick up to ${SD.MAX_OPTIONS} options here`, () => { node.options.push(SD.newOption('')); touch(); render(); });
    add.disabled = node.options.length >= SD.MAX_OPTIONS;
    const bye = el('label', 'sec-st-bye'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = node.bye !== false;
    cb.addEventListener('change', () => { node.bye = cb.checked; touch(); });
    bye.append(cb, ' also offer a goodbye'); bye.title = 'Adds the game\'s own "goodbye" choice, which ends the conversation';
    bar.append(add, bye);
    box.append(bar);
    return box;
  }

  function paintPreview() {
    if (!previewEl || !cur) return;
    const c = SD.compileDialog(cur);
    previewEl.replaceChildren();
    if (c.problems.length) { const p = el('p', 'sec-me-warn', c.problems.slice(0, 4).join(' · ')); previewEl.append(p); }
    previewEl.append(el('pre', 'sec-st-pre', c.text.replace(/\r\n/g, '\n')));
  }

  function render() {
    const keep = host.scrollTop;
    const frag = document.createDocumentFragment();
    const bar = el('div', 'sec-st-bar');
    if (story.dialogs.length) bar.append(select(story.dialogs.map((d, i) => [i, `${SD.dialogStem(d)}`]), String(Math.max(0, story.dialogs.indexOf(cur))), v => { cur = story.dialogs[Number(v)]; render(); }));
    bar.append(button('New dialog', 'Start another dialog', () => { cur = SD.newDialog(nextScript(), 'Talker'); cur.root.options.push(SD.newOption('')); story.dialogs.push(cur); touch(); render(); }));
    if (cur) bar.append(button('Delete', 'Remove this dialog from the export', () => { story.dialogs.splice(story.dialogs.indexOf(cur), 1); cur = story.dialogs[0] || null; touch(); render(); }));
    frag.append(bar);
    if (!cur) {
      frag.append(el('p', 'sec-eye-head', 'A dialog is what an NPC says when the player talks to it, and the choices the player has. Press "New dialog", write the NPC\'s opening line, then add the options: for each, say what it needs, what it does and what happens next. Export writes the .dlg and its script; give the script to an NPC with the Edit NPC tool.'));
      root.replaceChildren(frag); host.scrollTop = keep; return;
    }
    const head = el('div', 'sec-me-grid');
    const nameIn = textInput(cur.name, 'Name', v => { cur.name = v; touch(); });
    nameIn.maxLength = 30;
    const numIn = numberInput(cur.num, { min: 1, max: 99999 }, v => { cur.num = v; warn(); touch(); });
    const warnEl = el('p', 'sec-me-warn'); warnEl.hidden = true;
    const warn = () => {
      const clash = ctx.scriptNumbers().has(cur.num), twin = story.dialogs.some(d => d !== cur && d.num === cur.num);
      warnEl.hidden = !(clash || twin);
      warnEl.textContent = twin ? 'Another dialog of yours has this script number.' : `The game already has a script ${cur.num}: this one would replace it (and its dialog).`;
    };
    head.append(field('Name', nameIn, 'Used in the file names, e.g. 30303Innkeeper.dlg'), field('Script number', numIn, 'The .dlg and the .scr carry this number; the game finds the dialog of a script by it'));
    head.lastChild.classList.add('sec-me-wide'); head.firstChild.classList.add('sec-me-wide');
    frag.append(head, warnEl);
    warn();
    frag.append(nodeEl(cur.root, 0, 'What the NPC says when the player starts talking'));
    const give = el('div', 'sec-st-bar');
    give.append(button('Give it to an NPC…', 'Switches to the Edit NPC tool: click the NPC that will use this dialog', () => ctx.giveToNpc(cur.num)));
    const files = el('span', 'sec-me-scriptname', `Exports dlg/${SD.dialogStem(cur)}.dlg and scr/${SD.dialogStem(cur)}.scr`);
    give.append(files);
    frag.append(give);
    const det = el('details', 'sec-me-flags'); det.append(el('summary', null, 'The .dlg file'));
    previewEl = el('div'); det.append(previewEl);
    frag.append(det);
    root.replaceChildren(frag); host.scrollTop = keep;
    paintPreview();
  }

  return {
    refresh() { if (!story.dialogs.includes(cur)) cur = story.dialogs[0] || null; render(); },
    // for the "Give it to an NPC" flow and the tests
    current: () => cur
  };
}

// ===== Quest ===========================================================================================================
export function createQuestPanel(host, ctx) {
  const story = ctx.story;
  let editing = null;                    // the quest being edited, or null for a new one
  const root = el('div', 'sec-me sec-st'); host.appendChild(root);
  let search = '';

  function render() {
    const keep = host.scrollTop;
    const frag = document.createDocumentFragment();
    frag.append(el('p', 'sec-eye-head', 'A quest is the text the logbook shows for it. Give it a number and write the text; then use that number in a dialog to start, advance or finish it. A number the game already has is reworded.'));
    const form = el('div', 'sec-st-form');
    const draft = editing ? { ...editing } : { id: nextQuestId(story), text: '', dumb: '' };
    const idIn = el('input'); idIn.type = 'number'; idIn.min = 1; idIn.max = 99999; idIn.value = draft.id;
    const text = el('textarea'); text.rows = 4; text.maxLength = 1500; text.value = draft.text; text.placeholder = 'The logbook text, e.g. "Mrs. Randolph wants you to bring back her cat from the cellar."';
    const dumb = el('textarea'); dumb.rows = 2; dumb.maxLength = 1500; dumb.value = draft.dumb; dumb.placeholder = 'Optional: the clumsy wording a character with very low intelligence reads. Empty: the same text.';
    const msg = el('p', 'sec-me-msg');
    const existing = el('p', 'sec-me-warn'); existing.hidden = true;
    const checkId = () => {
      const id = Math.round(Number(idIn.value));
      const had = shippedQuests.get(id);
      existing.hidden = !had;
      existing.textContent = had ? `The game's quest ${id} says: "${short(had, 110)}" — yours replaces it.` : '';
    };
    idIn.addEventListener('input', checkId); checkId();
    const row = el('label', 'sec-me-row sec-st-row'); row.append(el('span', null, 'Quest number'), idIn);
    const save = button(editing ? 'Update the quest' : 'Add the quest', 'Keep it for the export', () => {
      const id = Math.round(Number(idIn.value)), t = text.value.trim();
      if (!(id > 0 && id < 100000)) { msg.textContent = 'Give the quest a number.'; return; }
      if (!t) { msg.textContent = 'Write the logbook text first.'; return; }
      if (story.quests.some(q => q.id === id && q !== editing)) { msg.textContent = `You already wrote a quest ${id}.`; return; }
      if (editing) Object.assign(editing, { id, text: t, dumb: dumb.value.trim() });
      else story.quests.push({ id, text: t, dumb: dumb.value.trim() });
      story.quests.sort((a, b) => a.id - b.id);
      editing = null; ctx.changed(); render();
    });
    const bar = el('div', 'sec-st-bar'); bar.append(save);
    if (editing) bar.append(button('Cancel', 'Stop editing this one', () => { editing = null; render(); }));
    form.append(row, existing, text, dumb, bar, msg);
    frag.append(form);

    frag.append(el('h4', 'sec-me-h', `Your quests (${story.quests.length})`));
    const mine = el('div', 'sec-st-list');
    if (!story.quests.length) mine.append(el('p', 'sec-me-none', 'None yet.'));
    for (const q of story.quests) {
      const r = el('div', 'sec-st-quest');
      r.append(el('strong', null, String(q.id)), el('span', null, short(q.text, 110)),
        button('Edit', 'Change it', () => { editing = q; render(); }),
        button('Remove', 'Take it out of the export', () => { story.quests.splice(story.quests.indexOf(q), 1); if (editing === q) editing = null; ctx.changed(); render(); }));
      mine.append(r);
    }
    frag.append(mine);

    frag.append(el('h4', 'sec-me-h', "The game's quests"));
    const find = el('input'); find.type = 'search'; find.placeholder = 'Search the logbook texts…'; find.value = search; find.setAttribute('aria-label', 'Search the quests of the game');
    const results = el('div', 'sec-me-results');
    const fill = () => {
      results.replaceChildren();
      const q = search.trim().toLowerCase();
      let n = 0;
      for (const [id, t] of shippedQuests) {
        if (q && !(`${id} ${t}`.toLowerCase().includes(q))) continue;
        if (++n > 40) break;
        const b = el('button', 'sec-me-result'); b.type = 'button'; b.title = 'Reword this quest';
        b.append(el('span', null, short(t, 80)), el('em', null, String(id)));
        b.addEventListener('click', () => { editing = null; search = find.value; render(); const i = host.querySelector('.sec-st-form input[type="number"]'); const ta = host.querySelector('.sec-st-form textarea'); if (i && ta) { i.value = id; i.dispatchEvent(new Event('input')); ta.value = t; ta.focus(); } });
        results.append(b);
      }
      if (!n) results.append(el('p', 'sec-me-none', shippedQuests.size ? 'No quest matches.' : 'Loading…'));
    };
    find.addEventListener('input', () => { search = find.value; fill(); });
    fill();
    frag.append(find, results);
    root.replaceChildren(frag); host.scrollTop = keep;
  }
  return { refresh() { questMes().then(m => { shippedQuests = m; }).catch(() => {}).then(render); } };
}
