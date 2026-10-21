// Multi-field search for the categories that have no search of their own (.SEC, .MOB, .DLG, .MES,
// .SCR). The folder tree of the category registers itself as the provider; the search walks its
// manifests from the root and lists the matches in the centre pane.
//
// A file is looked for in its name, its folder and, when the provider knows how to read them, extra
// fields (the text of a .DLG / .MES, the description of a .SCR). See match.js for the rules.

import { DATA_ROOT, MOB_ROOT } from '../core/config.js';
import { decodeMobBuffer } from '../mob/mob-decoder.js';
import { loadDescriptionMes, protoDescriptionInfo } from '../proto/proto-mes.js';
import { joinPath, manifestFiles, manifestSubfolders } from '../core/manifest.js';
import { breadcrumbEl, gridEl, paginationEl, searchClearBtnEl, searchInputEl, viewerEl } from '../core/dom.js';
import { errText, fetchBuffer, fetchText, decodeText } from '../core/text-io.js';
import { encPath } from '../core/util.js';
import { decodeScrBuffer } from '../scr/scr-decoder.js';
import { loadExplainTables, simplifyRows } from '../scr/scr-explain.js';
import { SCR_ACTIONS, SCR_CONDITIONS } from '../scr/scr-schema.js';
import { dlgParseFields } from '../text/dlg-explorer.js';
import { loadDynamicTables, resolveDynamic } from '../text/dlg-dynamic.js';
import { matchFields, splitTerms } from './match.js';
import { visit } from './nav-history.js';

const RESULT_LIMIT = 400;
const CONCURRENCY = 8;

let provider = null;   // { rootName, loadManifest, ext, fileIcon, openFile, restore, fields?, cards?, scope? }
// Where a search starts: the data root, or what provider.scope(current folder) names (the MOB explorer lists the mods and modules too: reading the
// 119 000 objects of all of them for every search would take minutes, so it searches the game, mod or module the folder belongs to).
const searchStart = () => provider.scope ? provider.scope(provider.where?.().path || '') : '';
let searching = 0;
// The last query of each category (by extension), so coming back to the category shows its results again.
const lastQueries = new Map();

export function registerSearchProvider(next) { provider = next; }

// Shows the last search of the category registered now again. Returns false when there was none.
export function resumeFileSearch() {
  const query = provider && lastQueries.get(provider.ext);
  if (!query) return false;
  searchInputEl.value = query;
  runFileSearch(query);
  return true;
}

// Extra fields read from the files themselves. Each returns async (path, filename) => [{ label, text }].
const fieldCache = new Map();
function cachedFields(url, read) {
  if (!fieldCache.has(url)) fieldCache.set(url, fetchBuffer(url).then(read).catch(() => []));
  return fieldCache.get(url);
}
const fileUrl = (root, path, filename) => `${root}${path ? `${encPath(path)}/` : ''}${encPath(filename)}`;

// .DLG / .MES: the whole text of the file.
export const textFileFields = root => (path, filename) =>
  cachedFields(fileUrl(root, path, filename), buf => [{ label: 'text', text: decodeText(buf) }]);
// .SCR: the description written in the header, then every line told in plain English (the same text as
// the Simplify view: quest names, item names, the words of the dialogue lines it shows…).
export const scrFileFields = root => (path, filename) =>
  cachedFields(fileUrl(root, path, filename), async buf => {
    const decoded = decodeScrBuffer(buf, filename);
    const fields = [{ label: 'description', text: decoded.description }];
    try {
      const [dlg] = await Promise.all([scrDialogue(filename), loadExplainTables(), loadDynamicTables()]);
      const ctx = {
        maxQuote: 400,
        dlgText: n => { const e = dlg?.get(n); return e ? resolveDynamic(e.text, { npc: e.iq === 0 })?.text ?? e.text ?? '' : ''; },
      };
      const defs = { cond: t => SCR_CONDITIONS[t], act: t => SCR_ACTIONS[t] };
      const text = simplifyRows(decoded.entries, defs, ctx)
        .map(r => r.text.replace(/⟦L:(-?\d+)⟧/g, 'line $1').replace(/⟦S:(-?\d+)⟧/g, 'script $1')).join('\n');
      if (text) fields.push({ label: 'script', text });
    } catch (_) { /* the tables are missing: the description alone is searched */ }
    return fields;
  });
// The .dlg that shares the script's file name.
const scrDialogue = async filename => {
  try {
    const entries = dlgParseFields(await fetchText(`${DATA_ROOT}dlg/${encodeURIComponent(filename.replace(/\.scr$/i, ''))}.dlg`));
    return new Map(entries.map(e => [e.num, e]));
  } catch (_) { return null; }
};

// .MOB: the name in its F_DESCRIPTION (Gilbert Bates, Virgil), which the file itself only holds as a number.
export const mobFileFields = root => (path, filename) =>
  cachedFields(fileUrl(root, path, filename), async buf => {
    const name = decodeMobBuffer(buf, filename).fields.find(f => f.field === 23);
    if (!name) return [];
    await loadDescriptionMes();
    const text = protoDescriptionInfo(name.value).text;
    return text ? [{ label: 'description', text }] : [];
  });

export const DLG_FIELDS = textFileFields(DATA_ROOT);
export const MES_FIELDS = textFileFields(DATA_ROOT);
export const SCR_FIELDS = scrFileFields(DATA_ROOT);
export const MOB_FIELDS = mobFileFields(MOB_ROOT);

async function listFiles(path, name, out, visited) {
  if (visited.has(path)) return;
  visited.add(path);
  let manifest;
  try { manifest = await provider.loadManifest(path, name); } catch (_) { return; }
  for (const filename of manifestFiles(manifest, provider.ext)) out.push({ filename, path });
  // sub-folders are read all at once (online each manifest is a round trip), their files kept in folder order
  const subs = await Promise.all(manifestSubfolders(manifest).map(async sf => {
    const sub = [];
    await listFiles(joinPath(path, sf.relative_path || sf.folder_name), sf.folder_name, sub, visited);
    return sub;
  }));
  for (const sub of subs) out.push(...sub);
}

function statusPara(text, err = false) {
  const p = document.createElement('p');
  p.className = err ? 'explorer-status err' : 'explorer-status';
  p.textContent = text;
  return p;
}

function showCenterGrid() {
  viewerEl.hidden = true;
  viewerEl.classList.remove('revealed');
  viewerEl.innerHTML = '';
  gridEl.hidden = false;
  paginationEl.hidden = true;
}

// ---- line-by-line results (.DLG, .MES) ------------------------------------------------------------
//
// A provider with `lines(path, filename)` -> [{ num, tag, text, alt? }] is searched line by line: a
// line matches when every word is in its text (or in the file's name / folder), with at least one
// word in the text itself. Clicking a line opens the file at it through `openLine()`. An optional
// `lineLinks(path, filename)` -> Map<num, [{ prefix, text, title, open }]> adds links under lines.

const LINE_LIMIT = 1500;
const lineCache = new Map();
export const cachedLines = (url, read) => {
  if (!lineCache.has(url)) lineCache.set(url, fetchBuffer(url).then(buf => read(decodeText(buf))).catch(() => []));
  return lineCache.get(url);
};

// The text with every search word wrapped in <mark>.
function highlighted(text, terms) {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const marks = [];
  for (const t of terms) for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + t.length)) marks.push([at, at + t.length]);
  marks.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [from, to] of marks) {
    if (from < pos) continue;
    frag.append(text.slice(pos, from));
    const m = document.createElement('mark');
    m.textContent = text.slice(from, to);
    frag.appendChild(m);
    pos = to;
  }
  frag.append(text.slice(pos));
  return frag;
}

async function runLineSearch(terms, shown, label, token) {
  const files = [];
  await listFiles(searchStart(), provider.rootName, files, new Set());
  const groups = [];   // { filename, path, lines: [...] } in file order
  let total = 0, next = 0, checked = 0;
  const worker = async () => {
    while (next < files.length && total < LINE_LIMIT && token === searching) {
      const idx = next++;
      const file = files[idx];
      const where = `${file.filename}\n${file.path}`.toLowerCase();
      const lines = await provider.lines(file.path, file.filename);
      const hits = [];
      for (const ln of lines) {
        // lower-cased once: the lines are cached, so a later search reuses it
        const body = ln.lower ??= `${ln.text}\n${ln.alt || ''}`.toLowerCase();
        let inText = false, ok = true;
        for (const t of terms) {
          if (body.includes(t)) inText = true;
          else if (!where.includes(t)) { ok = false; break; }
        }
        if (ok && inText) hits.push(ln);
      }
      const nameOnly = !hits.length && terms.every(t => where.includes(t));
      if (hits.length || nameOnly) {
        // Extra links per line (the scripts that show a dialogue line), only for files with hits.
        const links = hits.length && provider.lineLinks ? await provider.lineLinks(file.path, file.filename).catch(() => null) : null;
        groups[idx] = { ...file, lines: hits, links };
        total += hits.length || 1;
      }
      if (++checked % 40 === 0 && token === searching) breadcrumbEl.textContent = `Searching ${label} files for "${shown}"… ${checked} / ${files.length}`;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (token !== searching) return;

  const found = groups.filter(Boolean).sort((a, b) => `${a.path}/${a.filename}`.localeCompare(`${b.path}/${b.filename}`));
  const lineCount = found.reduce((n, g) => n + g.lines.length, 0);
  breadcrumbEl.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'} in ${found.length} ${label} file${found.length === 1 ? '' : 's'} for "${shown}"${total >= LINE_LIMIT ? ` (stopped at ${LINE_LIMIT})` : ''}`;
  if (!found.length) { gridEl.replaceChildren(statusPara(`No ${label} line matches "${shown}".`)); return; }

  const list = document.createElement('div');
  list.className = 'line-results';
  for (const g of found) {
    const section = document.createElement('section');
    section.className = 'line-results-file';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'line-results-head';
    head.append(`${provider.fileIcon} `, highlighted(g.filename, terms));
    if (g.path) { const p = document.createElement('span'); p.className = 'line-results-path'; p.textContent = `/${g.path}`; head.appendChild(p); }
    const count = document.createElement('span');
    count.className = 'line-results-count';
    count.textContent = g.lines.length ? `${g.lines.length} line${g.lines.length === 1 ? '' : 's'}` : 'file name matches';
    head.appendChild(count);
    head.addEventListener('click', () => provider.openFile(g.filename, null, g.path));
    section.appendChild(head);
    for (const ln of g.lines) {
      // A div rather than a <button>: it can hold links of its own.
      const row = document.createElement('div');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.className = 'line-results-row';
      row.title = `Open ${g.filename} at line ${ln.num}`;
      const num = document.createElement('span'); num.className = 'line-results-num'; num.textContent = String(ln.num);
      const tag = document.createElement('span'); tag.className = `line-results-tag tag-${String(ln.tag || '').toLowerCase()}`; tag.textContent = ln.tag || '';
      const text = document.createElement('span'); text.className = 'line-results-text';
      const main = document.createElement('span');
      main.appendChild(highlighted(ln.text || '', terms));
      text.appendChild(main);
      if (ln.alt && ln.alt.trim() && ln.alt.trim() !== ln.text.trim()) {
        const alt = document.createElement('span'); alt.className = 'line-results-alt';
        alt.append('♀ ', highlighted(ln.alt, terms));
        text.appendChild(alt);
      }
      for (const link of g.links?.get(ln.num) || []) {
        const via = document.createElement('span');
        via.className = 'line-results-via';
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = link.text;
        a.title = link.title || '';
        a.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); link.open(); });
        via.append(link.prefix || '', a);
        text.appendChild(via);
      }
      row.append(num, tag, text);
      const open = () => (provider.openLine ? provider.openLine(g.filename, g.path, ln.num) : provider.openFile(g.filename, null, g.path));
      row.addEventListener('click', open);
      row.addEventListener('keydown', ev => { if (ev.target === row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); open(); } });
      section.appendChild(row);
    }
    list.appendChild(section);
  }
  gridEl.replaceChildren(list);
}

export async function runFileSearch(rawQuery) {
  const terms = splitTerms(rawQuery);
  if (!provider) return;
  if (terms.length) lastQueries.set(provider.ext, rawQuery);
  else lastQueries.delete(provider.ext);
  if (!terms.length) return;
  const token = ++searching;
  const label = `.${provider.ext.toUpperCase()}`;
  const shown = rawQuery.trim();
  const { path = '', name } = provider.where?.() || {};
  visit({ mode: provider.ext, path, folderName: name, query: shown });   // Back from a result lands on these results
  searchClearBtnEl.hidden = false;
  showCenterGrid();
  breadcrumbEl.textContent = `Searching ${label} files for "${shown}"…`;
  gridEl.replaceChildren(statusPara('Searching…'));

  if (provider.lines) {
    try { await runLineSearch(terms, shown, label, token); } catch (err) { gridEl.replaceChildren(statusPara(errText(err), true)); }
    return;
  }

  const files = [];
  const hits = [];
  try {
    await listFiles(searchStart(), provider.rootName, files, new Set());
    let next = 0, checked = 0;
    const worker = async () => {
      while (next < files.length && hits.length < RESULT_LIMIT && token === searching) {
        const file = files[next++];
        const fields = [{ label: 'name', text: file.filename }, { label: 'folder', text: file.path }];
        if (provider.fields) fields.push(...await provider.fields(file.path, file.filename));
        const hit = matchFields(fields, terms);
        if (hit) hits.push({ ...file, note: hit.note });
        if (++checked % 40 === 0 && token === searching) breadcrumbEl.textContent = `Searching ${label} files for "${shown}"… ${checked} / ${files.length}`;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (err) { gridEl.replaceChildren(statusPara(errText(err), true)); return; }
  if (token !== searching) return;   // a newer search or a clear came in

  hits.sort((a, b) => a.filename.localeCompare(b.filename));
  const capped = hits.length >= RESULT_LIMIT ? ` (showing first ${RESULT_LIMIT})` : '';
  breadcrumbEl.textContent = `${hits.length} ${label} match${hits.length === 1 ? '' : 'es'} for "${shown}"${capped}`;
  gridEl.innerHTML = '';
  if (!hits.length) { gridEl.replaceChildren(statusPara(`No ${label} files match "${shown}".`)); return; }
  // The cards look like the folder grid's (same thumbnail), so a category can fill in their icons the same way.
  const cards = provider.cards;
  cards?.begin?.();
  for (const { filename, path, note } of hits) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'explorer-item';
    card.innerHTML = '<span class="explorer-thumb"><span class="folder-glyph"></span></span><span class="explorer-filename"></span><span class="explorer-item-path"></span>';
    card.querySelector('.folder-glyph').textContent = provider.fileIcon;
    card._iconThumb = card.querySelector('.explorer-thumb');
    card.querySelector('.explorer-filename').textContent = filename.split('/').pop();
    card.querySelector('.explorer-item-path').textContent = `/${path}`.replace(/\/+/g, '/');
    if (note) {
      const noteEl = document.createElement('span');
      noteEl.className = 'explorer-item-note';
      noteEl.textContent = note;
      noteEl.title = note;
      card.appendChild(noteEl);
    }
    card.title = `${path ? `${path}/` : ''}${filename}`;
    card.addEventListener('click', () => provider.openFile(filename, null, path));
    gridEl.appendChild(card);
    cards?.decorate?.(card, filename, path);
  }
}

export function clearFileSearch(searchInput) {
  searching++;
  if (provider) lastQueries.delete(provider.ext);
  if (searchInput) searchInput.value = '';
  searchClearBtnEl.hidden = true;
  if (provider) provider.restore();
}
