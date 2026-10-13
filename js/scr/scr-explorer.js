// .SCR script explorer: lists a script's condition/action table the way
// script_execute() walks it (game/script.c).
//
// Every entry is one line: "IF <condition> THEN <action> ELSE <action>". The
// engine starts at the line given by the attachment, runs that line, and moves
// to the next one unless the action jumps (goto) or returns. Only the operand
// slots a given type actually reads are meaningful: the other op_type bytes in
// the file are uninitialised memory (see scr-schema.js, generated from script.c).

import { SCR_FIELDS } from '../explorer/file-search.js';
import { mountFolderTree } from '../explorer/folder-tree.js';
import { createManifestLoader, manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { DATA_ROOT } from '../core/config.js';
import { fetchBuffer, fetchText, errText } from '../core/text-io.js';
import { breadcrumbEl, gridEl, paginationEl, viewerEl } from '../core/dom.js';
import { backButton } from '../explorer/nav-history.js';
import { encPath, escapeHtml } from '../core/util.js';
import { beginDataExplorer, renderDataFolderGrid, showExplorerError } from '../explorer/data-explorer.js';
import { saveDataExplorerState } from '../explorer/state-store.js';
import { dlgParseFields, openDlgFile } from '../text/dlg-explorer.js';
import { loadDynamicTables, resolveDynamic } from '../text/dlg-dynamic.js';
import { TERMS, TERM_PLAIN, focusTermOf, loadExplainTables, operandNote, simplifyRows, termsUsed } from './scr-explain.js';
import { analyzeLocalFlags, attachedText, flagFacts, loadLocalFlagIndex } from './scr-local-flags.js';
import { decodeScrBuffer, scrNumberFromFilename } from './scr-decoder.js';
import { flagMeaning, flagMeaningParts, flagUsers, isWriter, loadGlobalFlagIndex, shortName } from './scr-global-flags.js';
import { SCR_ACTIONS, SCR_CONDITIONS, SCR_FOCUS_OBJECTS, SCR_VALUE_TYPES } from './scr-schema.js';

const SCR_ROOT = `${DATA_ROOT}scr/`;
const DLG_ROOT = `${DATA_ROOT}dlg/`;

let scrCurrentPath = '';
let scrCurrentFolderName = 'scr';
let scrCurrentManifest = null;
let scrFiles = [];
let scrTree = null;
// "Simplify": show the scripts in plain English (kept while moving from script to script).
let scrSimplify = false;

const loadScrManifest = createManifestLoader({ root: SCR_ROOT, rootName: 'scr', label: '.scr' });

// script number -> file name, as script_name.c builds it from the file names.
let scrNumberIndex = null;
export async function getScrNumberIndex() {
  if (!scrNumberIndex) {
    const manifest = await loadScrManifest('', 'scr');
    const index = new Map();
    for (const f of manifestFiles(manifest, 'scr')) {
      const n = scrNumberFromFilename(f);
      if (n !== null && !index.has(n)) index.set(n, f);
    }
    scrNumberIndex = index;
  }
  return scrNumberIndex;
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const span = (cls, text) => el('span', cls, text);

// ---- operand formatting ------------------------------------------------------

// ScriptFocusObject operand: an object (or group of objects) reference.
function objNode(type, index) {
  const name = SCR_FOCUS_OBJECTS[type];
  if (name === undefined) return span('scr-raw', `obj?${type}:${index}`);
  const s = span('scr-obj', name === 'local object' ? `local object ${index}` : name);
  const term = focusTermOf(name);
  if (term) { s.title = TERMS[term]; s.classList.add('scr-term'); }
  return s;
}
// A variable reference, with what that kind of variable is as its tooltip.
function varNode(text, term) {
  const s = span('scr-var scr-term', text);
  s.title = TERMS[term];
  return s;
}

// A global flag reference; explained once the flag index is loaded (annotateFlags()).
function flagNode(n) {
  const s = span('scr-var scr-gflag', `global flag ${n}`);
  s.dataset.gflag = String(n);
  return s;
}

// ScriptValueType operand: a number or a variable reference.
function valueNode(type, index) {
  const name = SCR_VALUE_TYPES[type];
  switch (name) {
    case 'number': return span('scr-num', String(index));
    case 'counter': return varNode(`counter ${index}`, 'counter');
    case 'gl var': return varNode(`global var ${index}`, 'global var');
    case 'lc var': return varNode(`local var ${index}`, 'local var');
    case 'gl flag': return flagNode(index);
    case 'pc var':
    case 'pc flag': {
      // The high 16 bits name the object whose variable it is, the low 16 the index.
      const wrap = span('scr-var');
      wrap.append(varNode(`${name} ${index & 0xFFFF}`, name), ' of ', objNode(index >> 16, 0));
      return wrap;
    }
    default: return span('scr-raw', `value?${type}:${index}`);
  }
}

function operandNode(kind, type, value) {
  switch (kind) {
    case 'val': return valueNode(type, value);
    case 'dst': { const s = span('scr-dst'); s.append('→ ', valueNode(type, value)); return s; }
    case 'obj': return objNode(type, value);
    case 'objdst': { const s = span('scr-dst'); s.append('→ ', objNode(type, value)); return s; }
    default: return span('scr-num', String(value));
  }
}

const SCRIPT_ARG_ACTIONS = new Set(['call script', 'change this script to script', 'call script ex']);
const DIALOG_LINE_ACTIONS = new Set(['dialog', 'float line', 'print line']);
// Statements whose first operand is the number of a global flag.
const FLAG_NUMBER_STMTS = new Set(['global flag', 'set global flag', 'clear global flag']);
// ... and of one of this script's local flags.
const LOCAL_FLAG_STMTS = new Set(['local flag', 'set local flag', 'clear local flag']);
// A local flag number; explained under the line (what sets it) once the script has been analysed.
function lflagNode(n) {
  const s = span('scr-num scr-term scr-lflag', String(n));
  s.dataset.lflag = String(n);
  s.title = TERMS['local flag'];
  return s;
}

// One condition or action: "name(operand, ...)", with the CE comment as a tooltip.
// Conditions that carry a template ("(obj) has at least (num) gold") are written out as it.
function statementNode(def, st, kind, ctx) {
  const root = span(`scr-stmt scr-${kind}`);
  const ops = def.ops.map((k, i) => ({ node: operandNode(k, st.opType[i], st.opValue[i]), type: st.opType[i], value: st.opValue[i] }));
  if (FLAG_NUMBER_STMTS.has(def.name) && ops[0] && SCR_VALUE_TYPES[ops[0].type] === 'number') ops[0].node = flagNode(ops[0].value);
  if (LOCAL_FLAG_STMTS.has(def.name) && ops[0] && SCR_VALUE_TYPES[ops[0].type] === 'number') ops[0].node = lflagNode(ops[0].value);
  // What a number stands for in this slot (a quest, its state, an item…), right after it.
  ops.forEach((op, i) => {
    const note = operandNote(def.name, i, op.type, op.value, ctx);
    if (!note) return;
    const wrap = span('scr-noted');
    wrap.append(op.node, span('scr-gloss', ` ${note}`));
    op.node = wrap;
  });
  if (def.doc) root.title = def.doc;
  const holes = def.doc ? def.doc.match(/\([^)]*\)/g) : null;
  if (holes && holes.length === ops.length && ops.length) {
    let rest = def.doc;
    for (const op of ops) {
      const at = rest.search(/\([^)]*\)/);
      root.append(rest.slice(0, at), op.node);
      rest = rest.slice(at).replace(/^\([^)]*\)/, '');
    }
    root.append(rest);
    return root;
  }
  root.appendChild(span('scr-name', def.name));
  const jump = kind === 'act' && def.name === 'goto' && SCR_VALUE_TYPES[st.opType[0]] === 'number';
  if (ops.length && !jump) {
    root.append('(');
    ops.forEach((op, i) => { if (i) root.append(', '); root.appendChild(op.node); });
    root.append(')');
  }
  // Operands that point somewhere else get a link.
  const first = ops[0];
  if (kind === 'act' && first && SCR_VALUE_TYPES[first.type] === 'number') {
    if (def.name === 'goto') {
      const a = el('a', 'scr-link', `→ line ${first.value}`);
      a.href = '#';
      a.addEventListener('click', ev => { ev.preventDefault(); ctx.gotoLine(first.value); });
      root.append(' ', a);
    } else if (SCRIPT_ARG_ACTIONS.has(def.name)) {
      root.append(' ', ctx.scriptLink(first.value));
    }
  }
  return root;
}

// The right-bar card "Words used in this script": what triggerer, counter, local var… mean.
function termsCard(entries) {
  const used = termsUsed(entries, { cond: t => SCR_CONDITIONS[t], act: t => SCR_ACTIONS[t] });
  if (!used.length) return null;
  const card = el('section', 'side-card scr-terms');
  card.appendChild(el('h3', null, 'Words used in this script'));
  for (const term of Object.keys(TERMS).filter(t => used.includes(t))) {
    const row = el('div', 'scr-term-row');
    row.append(el('strong', null, TERM_PLAIN[term] ? `${term} · “${TERM_PLAIN[term]}” in Simplify` : term), el('span', null, TERMS[term]));
    card.appendChild(row);
  }
  return card;
}

// ---- local flags: what sets them -----------------------------------------------------------------------

const trimText = (s, max = 70) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

// Items { text, link? } as text and links (`ctx.followFact` knows where a link goes); at most `max` of them.
function factNodes(items, ctx, max = 99) {
  const frag = document.createDocumentFragment();
  items.slice(0, max).forEach((it, i) => {
    if (i) frag.append(', ');
    if (!it.link) { frag.append(it.text); return; }
    const a = el('a', 'scr-link', it.text);
    a.href = '#';
    a.addEventListener('click', ev => { ev.preventDefault(); ctx.followFact(it.link); });
    frag.appendChild(a);
  });
  if (items.length > max) frag.append(` (+${items.length - max} more)`);
  return frag;
}

// One line under a statement that uses local flag N: what sets it, what clears it, how it starts.
function localFlagNote(n, facts, ctx) {
  const note = el('div', 'scr-flagnote scr-lflagnote');
  note.append(span('scr-flagnote-n', `⚑ local flag ${n}`), ' — ');
  if (facts.sets.length) note.append('set by ', factNodes(facts.sets, ctx, 3));
  else if (!facts.starts.length) note.append(facts.dlgCaveat ? 'not set by anything that reaches this script' : 'never set by anything in the game files (so it is always off in a new game)');
  if (facts.clears.length) note.append('; cleared by ', factNodes(facts.clears, ctx, 3));
  else if (facts.sets.length || facts.starts.length) note.append('; never cleared');
  if (facts.starts.length) note.append(`; starts ${facts.starts.map(s => s.text).join(' and ')}`);
  else if (facts.sets.length) note.append('; starts off');
  if (facts.dlgCaveat) note.append(` (the dialogue also changes it, but only on the dialog copy: ${facts.elsewhere.map(s => s.text).slice(0, 2).join(', ')})`);
  return note;
}

// The right-bar card: every local flag the script uses, who sets, clears and needs it.
function localFlagCard(lf, factsOf, ctx) {
  const card = el('section', 'side-card scr-flags scr-lflags');
  card.appendChild(el('h3', null, 'Local flags'));
  card.appendChild(el('p', 'scr-flag-meaning', 'Yes / no values kept on the object this script is attached to. Hover "local flag" for the rules.'));
  for (const [n, f] of [...lf.flags].sort((a, b) => a[0] - b[0])) {
    const facts = factsOf(n);
    const item = el('div', 'scr-flag');
    const head = el('div', 'scr-flag-head');
    const used = [...new Set([...f.tests, ...f.sets, ...f.clears].filter(s => s.src === 'scr').map(s => s.line))].sort((a, b) => a - b);
    head.append(span('scr-var scr-term', `local flag ${n}`), ' ');
    const at = span('scr-flag-lines', used.length ? 'line ' : '');
    used.forEach((ln, i) => {
      if (i) at.append(', ');
      const a = el('a', 'scr-link', String(ln)); a.href = '#';
      a.addEventListener('click', ev => { ev.preventDefault(); ctx.gotoLine(ln); });
      at.appendChild(a);
    });
    head.appendChild(at);
    item.appendChild(head);
    const row = (label, content) => { item.append(el('div', 'scr-flag-sub', label)); const d = el('div', 'scr-flag-meaning'); d.append(content); item.appendChild(d); };
    row('Set by', facts.sets.length ? factNodes(facts.sets, ctx) : document.createTextNode(facts.starts.length ? 'nothing in the game files (only its starting value)' : 'nothing in the game files: it is always off in a new game'));
    if (facts.clears.length) row('Cleared by', factNodes(facts.clears, ctx));
    row('Starts', document.createTextNode(facts.starts.length ? facts.starts.map(s => s.text).join('; ') : 'off'));
    if (facts.tests.length) row('Needed by', factNodes(facts.tests, ctx, 8));
    if (facts.dlgCaveat) row('Not reaching this script', document.createTextNode(`dialogue effects: ${facts.elsewhere.map(s => s.text).join(', ')}. They change the copy attached at the dialog event; this script is attached at ${attachedText(lf.attached)}.`));
    card.appendChild(item);
  }
  if (lf.dynamic) card.appendChild(el('p', 'scr-flag-meaning', 'Some lines pick the flag number while running, so those cannot be listed here.'));
  return card;
}

// ---- tile scripts: the tiles that start a script ----------------------------------------------------------

const TILE_NEAR = 10;
// local_flags.json "tiles" ([map, sector x, sector y, tile x, tile y]) -> Map(map -> [{ x, y, count }]):
// map tile coordinates, a tile joining the first group that has its anchor within TILE_NEAR tiles.
function tileClusters(tiles) {
  const byMap = new Map();
  for (const [map, sx, sy, tx, ty] of tiles || []) {
    const x = sx * 64 + tx, y = sy * 64 + ty;
    if (!byMap.has(map)) byMap.set(map, []);
    const groups = byMap.get(map);
    const g = groups.find(c => Math.abs(c.x - x) <= TILE_NEAR && Math.abs(c.y - y) <= TILE_NEAR);
    if (g) g.count++; else groups.push({ x, y, count: 1 });
  }
  for (const groups of byMap.values()) groups.sort((a, b) => a.y - b.y || a.x - b.x);
  return new Map([...byMap].sort((a, b) => a[0].localeCompare(b[0])));
}

// ---- viewer ------------------------------------------------------------------

// The text of dialog / float line / print line comes from the .dlg that shares the
// script's file name (script_name_build_dlg_name()).
async function loadDlgFor(filename) {
  const base = filename.replace(/\.scr$/i, '');
  try {
    const entries = dlgParseFields(await fetchText(`${DLG_ROOT}${encodeURIComponent(base)}.dlg`));
    return new Map(entries.map(e => [e.num, e]));
  } catch (_) {
    return null;
  }
}

// The right-bar card: every global flag the script touches, what it stands for, and buttons to
// the other scripts (directly or through their dialogue) that change it.
function flagSideCard(flagIndex, flagLines, filename, ctx) {
  const card = el('section', 'side-card scr-flags');
  card.appendChild(el('h3', null, 'Global flags'));
  if (!flagIndex) {
    card.appendChild(el('p', 'scr-flag-meaning', 'No flag index (data/scr/global_flags.json). Build it with toolbox/gen_global_flags.py.'));
    return card;
  }
  for (const [n, lines] of [...flagLines].sort((a, b) => a[0] - b[0])) {
    const item = el('div', 'scr-flag');
    const head = el('div', 'scr-flag-head');
    head.append(flagNode(n), ' ');
    const at = span('scr-flag-lines', 'line ');
    lines.forEach((ln, i) => {
      if (i) at.append(', ');
      const a = el('a', 'scr-link', String(ln));
      a.href = '#';
      a.addEventListener('click', ev => { ev.preventDefault(); ctx.gotoLine(ln); });
      at.appendChild(a);
    });
    head.appendChild(at);
    item.append(head, ctx.meaningNode('scr-flag-meaning', n));

    const users = flagUsers(flagIndex, n).filter(u => u.script !== filename);
    const writers = users.filter(isWriter), readers = users.filter(u => !isWriter(u));
    if (writers.length) {
      item.appendChild(el('div', 'scr-flag-sub', 'Changed by'));
      const btns = el('div', 'scr-flag-btns');
      for (const u of writers) btns.appendChild(ctx.flagUserButton(u));
      item.appendChild(btns);
    } else {
      item.appendChild(el('div', 'scr-flag-sub', 'No other script changes it'));
    }
    if (readers.length) {
      const more = el('details', 'scr-flag-readers');
      more.appendChild(el('summary', null, `Tested by ${readers.length} other${readers.length === 1 ? '' : 's'}`));
      const btns = el('div', 'scr-flag-btns');
      for (const u of readers) btns.appendChild(ctx.flagUserButton(u));
      more.appendChild(btns);
      item.appendChild(more);
    }
    card.appendChild(item);
  }
  return card;
}

async function scrOpenViewer(filename, relativePath, { line = null } = {}) {
  let decoded;
  try {
    decoded = decodeScrBuffer(await fetchBuffer(`${SCR_ROOT}${relativePath ? encPath(relativePath) + '/' : ''}${encPath(filename)}`), filename);
  } catch (err) {
    gridEl.hidden = true;
    viewerEl.hidden = false;
    viewerEl.innerHTML = `<div class="dlg-error">Couldn't read ${escapeHtml(filename)}: ${escapeHtml(errText(err))}</div>`;
    return;
  }
  saveDataExplorerState('scr', relativePath, scrCurrentFolderName, filename);

  const [numberIndex, dlg, flagIndex, , , localIndex] = await Promise.all([
    getScrNumberIndex().catch(() => new Map()), loadDlgFor(filename), loadGlobalFlagIndex().catch(() => null), loadDynamicTables(),
    loadExplainTables().catch(() => null), loadLocalFlagIndex().catch(() => null),
  ]);
  const ownNumber = scrNumberFromFilename(filename);
  const scrNames = new Set(numberIndex.values());
  const dlgFile = filename.replace(/\.scr$/i, '.dlg');
  // What can set / clear / read each local flag of this script (own lines, its dialogue, stored values, scripts that turn into it).
  const lf = analyzeLocalFlags({ decoded, dlg, ownNumber, index: localIndex });
  const lfFacts = new Map();
  const factsOf = n => {
    if (!lfFacts.has(n)) lfFacts.set(n, flagFacts(lf.flags.get(n), {
      dlgText: num => trimText(ctx.dlgText(num)),
      scriptName: file => file.replace(/^\d+_?|\.scr$/gi, '') || file,
    }));
    return lfFacts.get(n);
  };

  const rows = new Map(), simpleRows = new Map();
  const ctx = {
    gotoLine(n) {
      const row = (scrSimplify ? simpleRows : rows).get(n);
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
    },
    scriptLink(num) {
      const target = numberIndex.get(num);
      if (!target) return span('scr-raw', `→ script ${num} (no such file)`);
      const a = el('a', 'scr-link', num === ownNumber ? '→ this script' : `→ script ${num} · ${target}`);
      a.href = '#';
      a.addEventListener('click', ev => { ev.preventDefault(); scrOpenViewer(target, ''); });
      return a;
    },
    // A button to a script that uses a flag, opened at its first line that does (dialogue: the script that runs it).
    flagUserButton(u) {
      const roles = [...u.roles].filter(r => r !== 'read');
      const sign = u.roles.has('set') && u.roles.has('clear') ? '±' : u.roles.has('set') || u.roles.has('write') ? '+' : u.roles.has('clear') ? '−' : '?';
      const lines = u.lines.length > 3 ? `${u.lines.slice(0, 3).join(', ')}…` : u.lines.join(', ');
      const where = `${u.kind === 'dlg' ? 'dlg ' : ''}line ${lines}`;
      const b = el('button', `scr-flag-btn${u.kind === 'dlg' ? ' is-dlg' : ''}`);
      b.type = 'button';
      b.append(span('scr-flag-sign', sign), span('scr-flag-who', `${u.kind === 'dlg' ? '💬 ' : ''}${shortName(u.file)}`), span('scr-flag-where', where));
      const desc = flagIndex?.scripts?.[u.script];
      b.title = `${u.file}${desc ? ` — ${desc}` : ''}\n${roles.join(', ') || 'reads it'} · ${where}${u.text ? `\n“${u.text}”` : ''}`;
      if (!scrNames.has(u.script)) b.title += '\n(no matching .scr file: opens the dialogue)';
      b.addEventListener('click', () => ctx.openUser(u));
      return b;
    },
    // Open a file that uses a flag: the script, at its first line that does; a dialogue opens
    // the script that runs it, or the .dlg itself when there is no such script.
    openUser(u) {
      if (!scrNames.has(u.script)) { if (u.kind === 'dlg') ctx.jumpToDlg(u.file, u.lines[0]); return; }
      if (u.script === filename) { if (u.kind === 'scr') ctx.gotoLine(u.lines[0]); return; }
      scrOpenViewer(u.script, '', { line: u.kind === 'scr' ? u.lines[0] : null });
    },
    // Open a dialogue at a line.
    jumpToDlg(file, num) {
      return openDlgFile(file, num);
    },
    // Open the map centred on a tile that triggers this script.
    async openTile(map, c) {
      const { openSecAtTile } = await import('../sec/sec-explorer.js');
      return openSecAtTile(map, map, { sectorX: c.x >> 6, sectorY: c.y >> 6, tileX: c.x & 63, tileY: c.y & 63 }, `Tile script ${ownNumber}`);
    },
    // Where a link of a "set by …" note goes: a line here, a dialogue line, or another script.
    followFact(link) {
      if (link.line !== undefined && !link.script) ctx.gotoLine(link.line);
      else if (link.dlg !== undefined) ctx.jumpToDlg(dlgFile, link.dlg);
      else if (link.script) scrOpenViewer(link.script, '', { line: link.line });
    },
    // The words of a dialogue line of this script's .dlg (dynamic lines as the game shows them).
    dlgText(n) {
      const entry = dlg && dlg.get(n);
      if (!entry) return '';
      return resolveDynamic(entry.text, { npc: entry.iq === 0 })?.text ?? entry.text ?? '';
    },
    // A flag's explanation, with the files it names as links.
    meaningNode(cls, n) {
      const node = el('div', cls);
      for (const part of flagMeaningParts(flagIndex, n, filename)) {
        if (typeof part === 'string') { node.append(part); continue; }
        const a = el('a', 'scr-link', part.label);
        a.href = '#';
        a.title = part.user.file;
        a.addEventListener('click', ev => { ev.preventDefault(); ctx.openUser(part.user); });
        node.appendChild(a);
      }
      return node;
    },
  };

  gridEl.hidden = true; paginationEl.hidden = true; viewerEl.hidden = false; viewerEl.classList.add('revealed'); viewerEl.innerHTML = '';
  const wrap = el('article', 'dlg-viewer scr-viewer');

  const bar = el('div', 'dlg-viewer-head');
  bar.appendChild(backButton());
  const title = el('div', 'dlg-file-title');
  title.append(el('strong', null, filename), el('span', null, `/${relativePath || 'scr'}`));
  bar.appendChild(title);
  const controls = el('div', 'dlg-controls');
  const simplifyBtn = el('button', 'dlg-control', 'Simplify');
  simplifyBtn.type = 'button';
  simplifyBtn.title = 'Read the script in plain English, one sentence per line';
  const rawBtn = el('button', 'dlg-control', 'Raw operands');
  rawBtn.type = 'button';
  controls.append(simplifyBtn, rawBtn);
  bar.appendChild(controls);
  wrap.appendChild(bar);

  // Summary: description, flags, initial counters, referenced scripts.
  const summary = el('div', 'dlg-summary scr-summary');
  summary.append(
    el('div', 'scr-desc', decoded.description || '(no description)'),
    el('div', null, `${decoded.numEntries} line${decoded.numEntries === 1 ? '' : 's'} · script #${ownNumber ?? '?'}` +
      ` · flags: ${decoded.flagNames.length ? decoded.flagNames.join(', ') : 'none'}` +
      ` · initial counters ${decoded.counters.join(' / ')}`),
  );
  if (decoded.warnings.length) summary.appendChild(el('div', 'scr-warn', `⚠ ${[...new Set(decoded.warnings)].slice(0, 6).join(' · ')}`));
  const called = new Set();
  for (const e of decoded.entries) {
    for (const st of [e.action, e.els]) {
      const def = SCR_ACTIONS[st.type];
      if (def && SCRIPT_ARG_ACTIONS.has(def.name) && SCR_VALUE_TYPES[st.opType[0]] === 'number' && st.opValue[0] !== ownNumber) called.add(st.opValue[0]);
    }
  }
  if (called.size) {
    const line = el('div', 'scr-called', 'Calls: ');
    [...called].sort((a, b) => a - b).forEach(n => { line.appendChild(ctx.scriptLink(n)); line.append(' '); });
    summary.appendChild(line);
  }
  if (dlg) summary.appendChild(el('div', null, `Dialogue text comes from ${filename.replace(/\.scr$/i, '.dlg')} (${dlg.size} lines).`));
  // Which events start it (and so who the "triggerer" is): the objects and prototypes that carry it.
  if (localIndex && ownNumber !== null) {
    const att = attachedText(lf.attached);
    summary.appendChild(el('div', null, att ? `Attached to: ${att}.` : 'Not attached to any object or prototype of the game data (other scripts may still call it or turn into it).'));
  }
  // The map tiles that run it (tile scripts), per map; tiles within 10 of each other are shown once.
  const tileGroups = tileClusters(localIndex?.scripts?.[ownNumber]?.tiles);
  if (tileGroups.size) {
    const box = el('div', 'scr-tiles');
    box.appendChild(span('scr-tiles-label', 'Triggered by tiles: '));
    for (const [map, list] of tileGroups) {
      const group = el('span', 'scr-tile-group');
      group.append(`${map} `);
      list.forEach((c, i) => {
        if (i) group.append(', ');
        const a = el('a', 'scr-link', `${c.x}, ${c.y}`);
        a.href = '#';
        a.title = `Open ${map} at tile ${c.x}, ${c.y}` + (c.count > 1 ? ` (${c.count} tiles within ${TILE_NEAR} of it)` : '');
        a.addEventListener('click', ev => { ev.preventDefault(); ctx.openTile(map, c); });
        group.appendChild(a);
        if (c.count > 1) group.append(span('scr-gloss', ` +${c.count - 1}`));
      });
      box.append(group, ' ');
    }
    summary.appendChild(box);
  }
  wrap.appendChild(summary);

  // The listing.
  const list = el('div', 'scr-list');
  const flagLines = new Map(); // global flag -> lines of this script that use it
  for (const e of decoded.entries) {
    const condDef = SCR_CONDITIONS[e.type] || { name: `condition ${e.type}`, ops: [], doc: '' };
    const row = el('div', 'scr-entry');
    row.id = `scr-line-${e.line}`;
    rows.set(e.line, row);
    row.appendChild(el('div', 'scr-line-no', String(e.line)));
    const body = el('div', 'scr-body');

    const addAction = (label, st) => {
      const def = SCR_ACTIONS[st.type] || { name: `action ${st.type}`, ops: [], doc: '' };
      const line = el('div', 'scr-clause');
      if (label) line.appendChild(span('scr-kw', label));
      line.appendChild(statementNode(def, st, 'act', ctx));
      body.appendChild(line);
      // Show the dialogue line an action refers to.
      if (DIALOG_LINE_ACTIONS.has(def.name) && SCR_VALUE_TYPES[st.opType[0]] === 'number') {
        const entry = dlg && dlg.get(st.opValue[0]);
        const dyn = entry && resolveDynamic(entry.text, { npc: entry.iq === 0 });
        const quote = el('div', 'scr-quote', dyn ? dyn.text : entry ? (entry.text || '(empty line)') : (dlg ? `(no line ${st.opValue[0]} in the .dlg)` : '(no matching .dlg file)'));
        if (dyn) quote.appendChild(el('div', 'dlg-dynamic-note', dyn.caption));
        if (entry) quote.title = `${filename.replace(/\.scr$/i, '.dlg')} line ${entry.num}`;
        body.appendChild(quote);
      }
    };

    if (e.type === 0) {
      addAction('', e.action);
    } else {
      const c = el('div', 'scr-clause');
      c.append(span('scr-kw', 'IF'), statementNode(condDef, e, 'cond', ctx));
      body.appendChild(c);
      addAction('THEN', e.action);
      if (e.els.type !== 0) addAction('ELSE', e.els);
    }

    // What the global flags of this line stand for.
    const flags = [...new Set([...body.querySelectorAll('[data-gflag]')].map(s => Number(s.dataset.gflag)))];
    for (const n of flags) {
      if (!flagLines.has(n)) flagLines.set(n, []);
      flagLines.get(n).push(e.line);
      if (!flagIndex) continue;
      const meaning = flagMeaning(flagIndex, n, filename);
      for (const s of body.querySelectorAll(`[data-gflag="${n}"]`)) s.title = meaning;
      const note = ctx.meaningNode('scr-flagnote', n);
      note.prepend(span('scr-flagnote-n', `⚑ flag ${n}`), ' ');
      body.appendChild(note);
    }
    // ... and what sets the local flags it uses.
    for (const n of lf.usedByLine.get(e.line) || []) body.appendChild(localFlagNote(n, factsOf(n), ctx));

    const raw = el('div', 'scr-rawdump');
    const hex = st => `type ${st.type} · op_type [${st.opType.join(' ')}] · op_value [${st.opValue.join(' ')}]`;
    raw.textContent = `cond   ${hex(e)}\naction ${hex(e.action)}\nelse   ${hex(e.els)}`;
    body.appendChild(raw);
    row.appendChild(body);
    row.dataset.search = row.textContent.toLowerCase();
    list.appendChild(row);
  }
  if (!decoded.entries.length) list.appendChild(el('p', 'explorer-status', 'This script has no lines.'));
  if (lf.flags.size || lf.dynamic) wrap.appendChild(localFlagCard(lf, factsOf, ctx));
  if (flagLines.size) wrap.appendChild(flagSideCard(flagIndex, flagLines, filename, ctx));
  const terms = termsCard(decoded.entries);
  if (terms) wrap.appendChild(terms);
  wrap.appendChild(list);

  // The same lines in plain English ("Simplify").
  const simple = el('div', 'scr-simple');
  simple.appendChild(el('p', 'scr-simple-intro',
    'When something sets this script off, the game reads it from the line that event starts at (usually line 0) and goes down one line at a time, '
    + 'unless a line sends it to another line or tells it to stop. Hover the underlined words in the normal view for what they mean.'));
  const linkLine = (n, text) => { const a = el('a', 'scr-link', text); a.href = '#'; a.addEventListener('click', ev => { ev.preventDefault(); ctx.gotoLine(n); }); return a; };
  const linkScript = n => {
    const target = numberIndex.get(n);
    if (!target) return document.createTextNode(`script ${n}`);
    if (n === ownNumber) return document.createTextNode('this script');
    const a = el('a', 'scr-link', `script ${n} (${target.replace(/^\d+_?|\.scr$/gi, '')})`); a.href = '#';
    a.addEventListener('click', ev => { ev.preventDefault(); scrOpenViewer(target, ''); });
    return a;
  };
  // Lines that only fall through into the next one are told together (see simplifyRows()).
  const simpleCtx = { ...ctx, maxQuote: 200 };
  for (const r of simplifyRows(decoded.entries, { cond: t => SCR_CONDITIONS[t], act: t => SCR_ACTIONS[t] }, simpleCtx)) {
    const row = el('div', 'scr-simple-row');
    for (let ln = r.from; ln <= r.to; ln++) simpleRows.set(ln, row);   // a link to any of the merged lines finds this row
    row.appendChild(el('div', 'scr-line-no', r.from === r.to ? String(r.from) : `${r.from}–${r.to}`));
    const text = el('div', 'scr-simple-text');
    for (const part of r.text.split(/(⟦[LS]:-?\d+⟧)/)) {
      const m = /^⟦([LS]):(-?\d+)⟧$/.exec(part);
      if (!m) text.append(part);
      else if (m[1] === 'L') text.appendChild(linkLine(Number(m[2]), `line ${m[2]}`));
      else text.appendChild(linkScript(Number(m[2])));
    }
    // What sets the local flags these lines use.
    const used = new Set();
    for (let ln = r.from; ln <= r.to; ln++) for (const n of lf.usedByLine.get(ln) || []) used.add(n);
    for (const n of used) text.appendChild(localFlagNote(n, factsOf(n), ctx));
    row.appendChild(text);
    simple.appendChild(row);
  }
  wrap.appendChild(simple);
  const applySimplify = () => {
    list.hidden = scrSimplify; simple.hidden = !scrSimplify;
    simplifyBtn.classList.toggle('active', scrSimplify);
    rawBtn.disabled = scrSimplify;
  };
  applySimplify();
  simplifyBtn.addEventListener('click', () => { scrSimplify = !scrSimplify; applySimplify(); });
  rawBtn.addEventListener('click', () => { const on = list.classList.toggle('show-raw'); rawBtn.classList.toggle('active', on); });

  viewerEl.appendChild(wrap);
  if (line !== null && rows.has(line)) ctx.gotoLine(line);
  else viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openScrFolder(relativePath, folderName) {
  if (scrTree) scrTree.select(relativePath);
  scrCurrentPath = relativePath; scrCurrentFolderName = folderName;
  scrCurrentManifest = await loadScrManifest(relativePath, folderName);
  scrFiles = manifestFiles(scrCurrentManifest, 'scr');
  saveDataExplorerState('scr', relativePath, folderName, null);
  breadcrumbEl.textContent = `/scr/${relativePath ? relativePath + '/' : ''}`;
  gridEl.hidden = false; viewerEl.hidden = true; viewerEl.innerHTML = '';
  renderDataFolderGrid({
    subfolders: manifestSubfolders(scrCurrentManifest), files: scrFiles, relativePath,
    openFolderFn: openScrFolder, openFileFn: (fn) => scrOpenViewer(fn, relativePath), fileIcon: '📜',
  });
}

// The .scr file of a script number (the number an object's script attachment holds), or null.
export async function scrFileForNumber(num) {
  return (await getScrNumberIndex().catch(() => new Map())).get(num) || null;
}

// Open the script with this number in the script explorer.
export async function openScrByNumber(num) {
  const file = await scrFileForNumber(num);
  if (!file) return false;
  saveDataExplorerState('scr', '', 'scr', file);
  await enterScrExplorer(true);
  return true;
}

// Open a top-level .scr in the script explorer, scrolled to one of its lines.
export async function openScrFile(file, line = null) {
  saveDataExplorerState('scr', '', 'scr', file);
  await enterScrExplorer(true, line);
}

export async function enterScrExplorer(restoreState = false, line = null) {
  const { path, name, file } = beginDataExplorer('scr', { rootName: 'scr', restoreState });
  scrTree = mountFolderTree({
    rootName: 'scr', loadManifest: loadScrManifest, openFolder: openScrFolder, ext: 'scr', fileIcon: '📜', searchFields: SCR_FIELDS,
    openFile: (filename, _row, parent) => scrOpenViewer(filename, parent),
  });
  try {
    await openScrFolder(path, name);
    if (file && scrFiles.includes(file)) await scrOpenViewer(file, path, { line });
  } catch (err) { showExplorerError(err); }
}
