/* ============================================================
   Arcanum CE Restored — Translation Review
   Single-file app: parser + viewer + linked editing + export.
   ============================================================ */

(function () {
  'use strict';

  /* =========================================================
     Parser
     ========================================================= */

  const STAMP_RE = /^\s*\[(\d+):(\d\d):(\d\d)\](?:[ \t]*\[(\d+)\])?/;

  function parseTranslationFile(text) {
    const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

    const headerRegex = /^(\d{3,4})\s*-\s*(.+)$/gm;
    const headerMatches = [];
    let m;
    while ((m = headerRegex.exec(clean)) !== null) {
      headerMatches.push({
        id: m[1],
        speaker: m[2].trim(),
        start: m.index,
        headerEnd: m.index + m[0].length
      });
    }

    const preamble = headerMatches.length > 0
      ? clean.slice(0, headerMatches[0].start).replace(/\s+$/, '')
      : clean.replace(/\s+$/, '');

    const entries = [];

    for (let i = 0; i < headerMatches.length; i++) {
      const cur = headerMatches[i];
      const next = headerMatches[i + 1];
      const bodyEnd = next ? next.start : clean.length;
      const body = clean.slice(cur.headerEnd, bodyEnd).trim();

      const parsed = parseEntryBody(body);

      entries.push({
        id: cur.id,
        speaker: cur.speaker,
        lowIntel: /\(low intelligence\)/i.test(cur.speaker),
        french: parsed.french,
        english: parsed.english,
        context: parsed.context,
        note: parsed.note,
        sourceLang: parsed.sourceLang || 'fr',
        frenchKey: frenchKeyFor(parsed.french),
        englishKey: englishKeyFor(parsed.english)
      });
    }

    return { preamble, entries };
  }

  function parseEntryBody(body) {
    const result = { french: null, english: null, context: null, note: null, sourceLang: null };

    // Treat each labelled block as a section, regardless of its order. The old
    // parser only stopped English at Context/Note when those labels came after
    // English. In exported low-intelligence entries Context often comes first,
    // so a later repeated French/English pair could be swallowed into English
    // and then written out again on the next export.
    const sectionRegex = /^(French|Original Russian|English|English to review|Context|Note):\s*$/gm;
    const sections = [];
    let match;
    while ((match = sectionRegex.exec(body)) !== null) {
      sections.push({ label: match[1], start: match.index, headerEnd: match.index + match[0].length });
    }

    const canonical = label => {
      if (label === 'French') return 'source-fr';
      if (label === 'Original Russian') return 'source-ru';
      if (label === 'English' || label === 'English to review') return 'english';
      return label.toLowerCase();
    };
    const seen = new Set();
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const key = canonical(section.label);
      // Keep the first instance of each block type. This also makes re-importing
      // an already duplicated export self-healing instead of duplicating it again.
      if (seen.has(key)) continue;
      seen.add(key);

      let end = body.length;
      for (let j = i + 1; j < sections.length; j++) {
        if (sections[j].start > section.start) {
          end = sections[j].start;
          break;
        }
      }
      const newline = body.indexOf('\n', section.headerEnd);
      const contentStart = newline === -1 || newline >= end ? section.headerEnd : newline + 1;
      const raw = body.slice(contentStart, end).trim();
      if (key === 'source-fr') {
        result.sourceLang = 'fr';
        result.french = parseDialogueBlock(raw);
      } else if (key === 'source-ru') {
        result.sourceLang = 'ru';
        result.french = parseDialogueBlock(raw);
      } else if (key === 'english') {
        result.english = parseDialogueBlock(raw);
      } else if (key === 'context') {
        result.context = raw;
      } else if (key === 'note') {
        result.note = raw;
      }
    }
    return result;
  }

  function parseDialogueBlock(raw) {
    if (!raw) return null;

    const maleLabelIdx = raw.search(/^Male:\s*$/m);
    const femaleLabelIdx = raw.search(/^Female:\s*$/m);

    if (maleLabelIdx !== -1 || femaleLabelIdx !== -1) {
      let maleText = '';
      let femaleText = '';

      if (maleLabelIdx !== -1 && femaleLabelIdx !== -1) {
        const maleStart = raw.indexOf('\n', maleLabelIdx);
        maleText = raw.slice(maleStart + 1, femaleLabelIdx).trim();
        const femaleStart = raw.indexOf('\n', femaleLabelIdx);
        femaleText = raw.slice(femaleStart + 1).trim();
      } else if (maleLabelIdx !== -1) {
        const maleStart = raw.indexOf('\n', maleLabelIdx);
        maleText = raw.slice(maleStart + 1).trim();
      } else {
        const femaleStart = raw.indexOf('\n', femaleLabelIdx);
        femaleText = raw.slice(femaleStart + 1).trim();
      }

      if (maleText && femaleText) {
        return { type: 'gendered', male: maleText, female: femaleText };
      }
      if (maleText) return { type: 'single', text: maleText, label: 'Male' };
      if (femaleText) return { type: 'single', text: femaleText, label: 'Female' };
    }

    return { type: 'single', text: raw };
  }

  function frenchKeyFor(french) {
    if (!french) return null;
    if (french.type === 'gendered') return 'F|M:' + french.male + '|F:' + french.female;
    return 'F:' + french.text;
  }

  function englishKeyFor(english) {
    if (!english) return null;
    if (english.type === 'gendered') return 'E|M:' + english.male + '|F:' + english.female;
    return 'E:' + english.text;
  }

  /* =========================================================
     State
     ========================================================= */
  let currentDoc = null;
  let currentIndex = 0;
  let isTransitioning = false;

  const loadedFiles = new Map();

  let syncGroups = null;
  let syncGroupMap = null;

  /* =========================================================
     DOM
     ========================================================= */
  const researchInputEl = document.getElementById('research-input');
  const researchClearBtn = document.getElementById('research-clear-btn');
  const collisionScanBtn = document.getElementById('collision-scan-btn');
  const researchPanelEl = document.getElementById('research-panel');
  const docTitleEl = document.getElementById('doc-title');
  const exportBtn = document.getElementById('exportBtn');
  const stageEl = document.getElementById('trStage');
  const card = document.getElementById('card');
  const stagePlaceholder = document.getElementById('stagePlaceholder');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.querySelector('.progress-bar');
  const progressFill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const hudValPos = document.getElementById('hud-val-pos');

  // Called by translator-ui.js when a file is picked in the left bar.
  function openText(name, text, startAt) {
    const id = name;
    const title = name.replace(/\.txt$/i, '');
    const doc = buildDocFromText({ id, title }, text);
    if (!doc) {
      alert('Parser found 0 entries. Check that the .txt begins with lines like "001 - Name".');
      console.warn('First 300 chars of loaded file:', text.slice(0, 300));
      return;
    }
    loadedFiles.set(id, { id, title, text, doc });
    applyDocument({ id, title }, text, startAt);
  }
  window.translatorOpen = openText;

  /* =========================================================
     Document loading & grouping
     ========================================================= */
  function buildDocFromText(item, rawText) {
    const parsed = parseTranslationFile(rawText);
    const entries = parsed.entries;
    if (!entries.length) return null;

    const groupsByKey = new Map();
    const groups = [];
    entries.forEach(entry => {
      const key = entry.frenchKey;
      if (!key) {
        groups.push({ key: null, primary: entry, all: [entry] });
        return;
      }
      let g = groupsByKey.get(key);
      if (!g) {
        g = { key, primary: entry, all: [] };
        groupsByKey.set(key, g);
        groups.push(g);
      }
      g.all.push(entry);
    });

    // the first line of the file holds the review time, [hh:mm:ss]
    // and, after it, the line the review had reached: [hh:mm:ss] [n]
    const stamp = STAMP_RE.exec(parsed.preamble || '');
    const progress = stamp && stamp[4] ? Math.max(1, +stamp[4]) : 1;
    return {
      id: item.id,
      title: item.title,
      seconds: stamp ? (+stamp[1]) * 3600 + (+stamp[2]) * 60 + (+stamp[3]) : 0,
      progress,
      reached: progress,      // the furthest line shown so far: the lines before it count as done
      preamble: parsed.preamble,
      groups,
      flatEntries: entries
    };
  }

  function applyDocument(item, rawText, startAt) {
    const doc = buildDocFromText(item, rawText);
    if (!doc) {
      alert('Parser found 0 entries. Check that the .txt begins with lines like "001 - Name".');
      console.warn('First 300 chars of loaded file:', rawText.slice(0, 300));
      return;
    }

    currentDoc = doc;
    const storedFile = loadedFiles.get(item.id);
    if (storedFile) storedFile.doc = doc;
    // opens on the line the file (or the link) says; the lines before it were done
    const start = Math.min(doc.groups.length, Math.max(1, Math.floor(+startAt) || doc.progress));
    currentIndex = start - 1;
    doc.reached = Math.max(doc.reached, start);
    docTitleEl.textContent = item.title;

    stagePlaceholder.hidden = true;
    card.hidden = false;
    progressWrap.hidden = false;

    buildSyncGroups();
    renderCurrentCard('none');
    updateProgress();
    updateNavButtons();
    exportBtn.disabled = false;

    if (lastResearchQuery) {
      runResearch(lastResearchQuery);
    } else {
      renderResearchEmptyState();
    }
  }

  /* =========================================================
     Sync groups for linked editing
     ========================================================= */
  function buildSyncGroups() {
    syncGroups = new Map();
    syncGroupMap = new Map();
    let nextId = 0;

    const keyToMembers = new Map();
    currentDoc.flatEntries.forEach(entry => {
      if (!entry.english) return;
      // Only synchronize entries that share both their source-language text
      // and English text. Different French dialogs can legitimately have the
      // same English wording and must remain independently editable.
      const sourceKey = entry.frenchKey || ('ID:' + entry.id);
      if (entry.english.type === 'gendered') {
        addMember(keyToMembers, sourceKey + '|E|' + entry.english.male, entry.id, 'male');
        addMember(keyToMembers, sourceKey + '|E|' + entry.english.female, entry.id, 'female');
      } else {
        addMember(keyToMembers, sourceKey + '|E|' + entry.english.text, entry.id, 'text');
      }
    });

    keyToMembers.forEach(members => {
      if (members.length < 2) return;
      const id = nextId++;
      syncGroups.set(id, members);
      members.forEach(m => syncGroupMap.set(m.entryId + '|' + m.slot, id));
    });
  }

  function addMember(map, key, entryId, slot) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ entryId, slot });
  }

  /* =========================================================
     Auto-grow for textareas
     ========================================================= */
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    const border = ta.offsetHeight - ta.clientHeight;
    ta.style.height = (ta.scrollHeight + border) + 'px';
  }

  function autoGrowAll(root) {
    (root || card).querySelectorAll('textarea').forEach(autoGrow);
  }

  /* =========================================================
     Rendering the current card
     ========================================================= */
  function renderCurrentCard(direction) {
    const group = currentDoc.groups[currentIndex];
    if (!group) return;

    const html = buildCardHTML(group);

    if (direction === 'none' || !card.innerHTML) {
      card.innerHTML = html;
      card.className = 'card';
      applyCardClasses();
      wireCardInputs();
      autoGrowAll();
      autoTranslateCurrentEntry();
      return;
    }

    if (isTransitioning) return;
    isTransitioning = true;

    const outClass = direction === 'forward' ? 'leave-left' : 'leave-right';
    const inClass  = direction === 'forward' ? 'enter-right' : 'enter-left';

    card.classList.add(outClass);

    const onOutEnd = () => {
      card.removeEventListener('animationend', onOutEnd);
      card.className = 'card';
      card.innerHTML = html;
      applyCardClasses();
      card.classList.add(inClass);
      wireCardInputs();
      autoGrowAll();
      autoTranslateCurrentEntry();

      const onInEnd = () => {
        card.removeEventListener('animationend', onInEnd);
        card.className = 'card';
        applyCardClasses();
        isTransitioning = false;
      };
      card.addEventListener('animationend', onInEnd);
    };
    card.addEventListener('animationend', onOutEnd);
  }

  function autoTranslateCurrentEntry() {
    if (!currentDoc) return;
    const group = currentDoc.groups[currentIndex];
    if (!group || !group.primary || !group.primary.french) return;
    if (!group.primary.googleTranslate) runGoogleTranslate(group.primary.id);
  }

  function applyCardClasses() {
    const group = currentDoc.groups[currentIndex];
    if (!group) return;
    if (group.primary.lowIntel) card.classList.add('low-intel');
  }

  function buildCardHTML(group) {
    const entry = group.primary;
    const parts = [];

    parts.push(contextBlockHTML(entry));

    const altIds = group.all
      .filter(e => e.id !== entry.id)
      .map(e => e.id)
      .join(', ');

    // a line before the furthest one shown is done; the one reached (and any after it) is still to correct
    const pos = currentDoc.groups.indexOf(group) + 1;
    const done = pos < currentDoc.reached;
    if (pos > currentDoc.reached) currentDoc.reached = pos;
    let header = `<div class="card-header">`;
    header += `<span class="entry-id">${escapeHtml(entry.id)}</span>`;
    header += `<span>${escapeHtml(entry.speaker)}</span>`;
    header += done ? `<span class="status-badge done">✓ done</span>` : `<span class="status-badge todo">to correct</span>`;
    if (group.all.length > 1) {
      header += `<span class="duplicate-badge">shared ×${group.all.length}</span>`;
      if (altIds) header += `<span class="alt-ids">also: ${escapeHtml(altIds)}</span>`;
    }
    if (entry.lowIntel) {
      header += `<span class="low-intel-badge">low intelligence</span>`;
    }
    header += `</div>`;
    parts.push(header);

    if (entry.french) {
      parts.push(`<div class="french-block"><div class="french-text">${dialogueStaticHTML(entry.french)}</div>` +
        `<button type="button" class="french-copy" title="Copy the French text">⧉ Copy</button></div>`);
    }

    if (entry.english) {
      parts.push(`<div class="english-area">`);
      parts.push(`<div class="english-label">English</div>`);
      parts.push(englishInputsHTML(entry));
      parts.push(`</div>`);
    }

    if (entry.french) {
      parts.push(googleTranslateBlockHTML(entry));
      parts.push(reversoBlockHTML(entry));
    }

    if (entry.note) {
      parts.push(`<div class="note">${escapeHtml(entry.note)}</div>`);
    }

    return parts.join('');
  }

  function contextBlockHTML(entry) {
    const value = entry.context || '';
    if (value.trim() === '') {
      return (
        `<div class="context-add-row" data-entry-id="${escapeHtml(entry.id)}">` +
          `<button type="button" class="context-add-btn" data-entry-id="${escapeHtml(entry.id)}">+ Add context</button>` +
        `</div>`
      );
    }
    return (
      `<div class="context-block" data-entry-id="${escapeHtml(entry.id)}">` +
        `<div class="context-label">Context</div>` +
        `<textarea data-entry-id="${escapeHtml(entry.id)}" data-role="context">${escapeHtml(value)}</textarea>` +
      `</div>`
    );
  }

  function dialogueStaticHTML(dialogue) {
    if (dialogue.type === 'gendered') {
      return (
        `<div><span class="label">Male:</span>\n${escapeHtml(dialogue.male)}</div>` +
        `<br>` +
        `<div><span class="label">Female:</span>\n${escapeHtml(dialogue.female)}</div>`
      );
    }
    if (dialogue.label) {
      return `<div><span class="label">${escapeHtml(dialogue.label)}:</span>\n${escapeHtml(dialogue.text)}</div>`;
    }
    return `<div>${escapeHtml(dialogue.text)}</div>`;
  }

  function englishInputsHTML(entry) {
    const en = entry.english;
    if (en.type === 'gendered') {
      return (
        `<div class="male-female-group">` +
          `<div class="english-input-group">` +
            `<div class="english-label">Male</div>` +
            `<textarea data-entry-id="${escapeHtml(entry.id)}" data-slot="male">${escapeHtml(en.male)}</textarea>` +
          `</div>` +
          `<div class="english-input-group">` +
            `<div class="english-label">Female</div>` +
            `<textarea data-entry-id="${escapeHtml(entry.id)}" data-slot="female">${escapeHtml(en.female)}</textarea>` +
          `</div>` +
        `</div>`
      );
    }
    const labelHTML = en.label ? `<div class="english-label">${escapeHtml(en.label)}</div>` : '';
    return (
      `<div class="english-input-group">` +
        labelHTML +
        `<textarea data-entry-id="${escapeHtml(entry.id)}" data-slot="text">${escapeHtml(en.text)}</textarea>` +
      `</div>`
    );
  }

  /* =========================================================
     Google Translate (reference only)
     ========================================================= */
  function googleTranslateBlockHTML(entry) {
    const lang = entry.sourceLang === 'ru' ? 'ru' : 'fr';
    const langName = lang === 'ru' ? 'Russian' : 'French';

    const inner = entry.googleTranslate
      ? gtranslateResultHTML(entry.googleTranslate, entry.id)
      : `<div class="gtranslate-result gtranslate-loading">Translating ${langName}…</div>`;

    return (
      `<div class="gtranslate-area" data-entry-id="${escapeHtml(entry.id)}">` +
        `<div class="gtranslate-label">Google Translate <span class="gtranslate-sub">— machine reference, not authoritative</span></div>` +
        inner +
        `<div class="gtranslate-status" data-entry-id="${escapeHtml(entry.id)}"></div>` +
      `</div>`
    );
  }

  function gtranslateResultHTML(result, entryId) {
    const useButton = entryId
      ? `<button type="button" class="gtranslate-use-btn" data-entry-id="${escapeHtml(entryId)}">Use this translation</button>`
      : '';

    if (result.type === 'gendered') {
      return (
        `<div class="gtranslate-result">` +
          `<div class="gtranslate-result-text">` +
            `<div><span class="label">Male:</span> ${escapeHtml(result.male)}</div>` +
            `<div><span class="label">Female:</span> ${escapeHtml(result.female)}</div>` +
          `</div>` +
          useButton +
        `</div>`
      );
    }
    return `<div class="gtranslate-result"><div class="gtranslate-result-text">${escapeHtml(result.text)}</div>${useButton}</div>`;
  }

  function frenchPlainText(french) {
    if (!french) return '';
    if (french.type === 'gendered') return french.male + ' / ' + french.female;
    return french.text;
  }

  async function googleTranslateText(text, sourceLang) {
    if (!text) return '';
    const sl = sourceLang === 'ru' ? 'ru' : 'fr';
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + sl + '&tl=en&dt=t&q=' + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data[0] || []).map(seg => seg[0]).join('');
  }

  async function runGoogleTranslate(entryId) {
    const entry = currentDoc.flatEntries.find(e => e.id === entryId);
    if (!entry || !entry.french) return;

    const lang = entry.sourceLang === 'ru' ? 'ru' : 'fr';
    const langName = lang === 'ru' ? 'Russian' : 'French';

    const area = card.querySelector(`.gtranslate-area[data-entry-id="${cssEscape(entryId)}"]`);
    if (!area) return;
    const btn = area.querySelector('.gtranslate-btn');
    const resultEl = area.querySelector('.gtranslate-result');
    const statusEl = area.querySelector('.gtranslate-status');

    if (btn) { btn.disabled = true; btn.textContent = 'Translating…'; }
    if (resultEl) resultEl.textContent = 'Translating…';
    if (statusEl) statusEl.textContent = '';

    try {
      let result;
      if (entry.french.type === 'gendered') {
        const [male, female] = await Promise.all([
          googleTranslateText(entry.french.male, lang),
          googleTranslateText(entry.french.female, lang)
        ]);
        result = { type: 'gendered', male, female };
      } else {
        const text = await googleTranslateText(entry.french.text, lang);
        result = { type: 'single', text };
      }

      entry.googleTranslate = result;
      if (!card.contains(area)) return;
      const currentResult = area.querySelector('.gtranslate-result');
      if (currentResult) {
        currentResult.outerHTML = gtranslateResultHTML(result, entry.id);
      } else if (btn) {
        btn.replaceWith(htmlToNode(gtranslateResultHTML(result, entry.id)));
      }

      // The Google result is inserted after wireCardInputs() has already
      // run, so its new "Use this translation" button needs its click
      // handler attached here as well.
      const useBtn = area.querySelector('.gtranslate-use-btn');
      if (useBtn) {
        useBtn.addEventListener('click', () => useGoogleTranslation(entry.id));
      }
    } catch (err) {
      console.warn('Google Translate failed:', err);
      const currentResult = area && area.querySelector('.gtranslate-result');
      if (currentResult) currentResult.textContent = 'Google Translate unavailable.';
      if (btn) { btn.disabled = false; btn.textContent = `🌐 Translate ${langName} with Google`; }
      if (statusEl && card.contains(area)) {
        const fallbackUrl = 'https://translate.google.com/?sl=' + lang + '&tl=en&text=' + encodeURIComponent(frenchPlainText(entry.french));
        statusEl.innerHTML =
          `Couldn't reach Google Translate — <a href="${fallbackUrl}" target="_blank" rel="noopener">open it manually</a> instead.`;
      }
    }
  }

  /* =========================================================
     Reverso (reference only)
     Opens a Reverso Context tab for the entry's source text.
     Reverso's free site does not expose a clean CORS-enabled
     JSON endpoint for arbitrary text, so this is a link-out
     rather than an in-page fetch. Direction is chosen from
     the parsed source language: fr->en or ru->en.
     ========================================================= */
  function reversoBlockHTML(entry) {
    const lang = entry.sourceLang === 'ru' ? 'ru' : 'fr';
    const langName = lang === 'ru' ? 'Russian' : 'French';
    const pair = lang === 'ru' ? 'russian-english' : 'french-english';

    // Reverso Context accepts the query in the path after the pair.
    // We URL-encode the source text so spaces/special chars survive.
    const query = encodeURIComponent(frenchPlainText(entry.french) || '');
    const url = 'https://context.reverso.net/translation/' + pair + '/' + query;

    return (
      `<div class="reverso-area" data-entry-id="${escapeHtml(entry.id)}">` +
        `<div class="reverso-label">Reverso Context <span class="reverso-sub">— opens in a new tab, ${langName} → English</span></div>` +
        `<button type="button" class="reverso-btn" data-entry-id="${escapeHtml(entry.id)}" data-url="${escapeHtml(url)}">🔗 Open in Reverso Context</button>` +
      `</div>`
    );
  }

  function runReverso(entryId) {
    const entry = currentDoc.flatEntries.find(e => e.id === entryId);
    if (!entry || !entry.french) return;

    const area = card.querySelector(`.reverso-area[data-entry-id="${cssEscape(entryId)}"]`);
    if (!area) return;
    const btn = area.querySelector('.reverso-btn');
    if (!btn) return;

    const url = btn.dataset.url;
    if (url) window.open(url, '_blank', 'noopener');
  }

  function htmlToNode(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstChild;
  }

  /* =========================================================
     Wiring inputs & linked editing
     ========================================================= */
  function refreshResearchAfterEdit() {
    if (!lastResearchQuery) return;
    renderResearchResults(lastResearchQuery, searchAllDocuments(lastResearchQuery));
  }

  function wireCardInputs() {
    card.querySelectorAll('textarea').forEach(ta => {
      ta.addEventListener('input', () => {
        autoGrow(ta);

        const entryId = ta.dataset.entryId;

        if (ta.dataset.role === 'context') {
          const entry = currentDoc.flatEntries.find(e => e.id === entryId);
          if (entry) entry.context = ta.value;
          return;
        }

        const slot = ta.dataset.slot;
        const entry = currentDoc.flatEntries.find(e => e.id === entryId);
        if (!entry || !entry.english) return;

        if (entry.english.type === 'gendered') {
          entry.english[slot] = ta.value;
        } else {
          entry.english.text = ta.value;
        }

        syncAllLinkedTextareas(entryId, slot, ta.value, ta);
        refreshResearchAfterEdit();
      });
    });

    card.querySelectorAll('.french-copy').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fr = currentDoc.groups[currentIndex].primary.french;
        const text = fr.type === 'gendered' ? `${fr.male}\n\n${fr.female}` : fr.text;
        try { await navigator.clipboard.writeText(text); }
        catch {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = '⧉ Copy'; }, 1200);
      });
    });

    card.querySelectorAll('.context-add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const entryId = btn.dataset.entryId;
        const entry = currentDoc.flatEntries.find(e => e.id === entryId);
        if (!entry) return;

        if (entry.context == null) entry.context = '';

        const row = btn.closest('.context-add-row');
        if (!row) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'context-block';
        wrapper.dataset.entryId = entryId;
        wrapper.innerHTML =
          `<div class="context-label">Context</div>` +
          `<textarea data-entry-id="${escapeHtml(entryId)}" data-role="context" placeholder="Type the context here..."></textarea>`;
        row.replaceWith(wrapper);

        const ta = wrapper.querySelector('textarea');
        ta.addEventListener('input', () => {
          autoGrow(ta);
          const e = currentDoc.flatEntries.find(x => x.id === entryId);
          if (e) e.context = ta.value;
        });
        autoGrow(ta);
        ta.focus();
      });
    });

    card.querySelectorAll('.gtranslate-btn').forEach(btn => {
      btn.addEventListener('click', () => runGoogleTranslate(btn.dataset.entryId));
    });

    card.querySelectorAll('.gtranslate-use-btn').forEach(btn => {
      btn.addEventListener('click', () => useGoogleTranslation(btn.dataset.entryId));
    });

    card.querySelectorAll('.reverso-btn').forEach(btn => {
      btn.addEventListener('click', () => runReverso(btn.dataset.entryId));
    });
  }

  function useGoogleTranslation(entryId) {
    const entry = currentDoc && currentDoc.flatEntries.find(e => e.id === entryId);
    if (!entry || !entry.googleTranslate || !entry.english) return;

    const result = entry.googleTranslate;

    if (entry.english.type === 'gendered' && result.type === 'gendered') {
      entry.english.male = result.male;
      entry.english.female = result.female;

      const maleTa = card.querySelector(`textarea[data-entry-id="${cssEscape(entryId)}"][data-slot="male"]`);
      const femaleTa = card.querySelector(`textarea[data-entry-id="${cssEscape(entryId)}"][data-slot="female"]`);
      if (maleTa) { maleTa.value = result.male; autoGrow(maleTa); }
      if (femaleTa) { femaleTa.value = result.female; autoGrow(femaleTa); }

      syncAllLinkedTextareas(entryId, 'male', result.male, maleTa);
      syncAllLinkedTextareas(entryId, 'female', result.female, femaleTa);
    } else if (entry.english.type !== 'gendered' && result.type === 'single') {
      entry.english.text = result.text;

      const ta = card.querySelector(`textarea[data-entry-id="${cssEscape(entryId)}"][data-slot="text"]`);
      if (ta) { ta.value = result.text; autoGrow(ta); }

      syncAllLinkedTextareas(entryId, 'text', result.text, ta);
    } else {
      // Keep the source structure intact if the source/translation structures differ.
      if (result.type === 'single') {
        if (entry.english.type === 'gendered') {
          entry.english.male = result.text;
          entry.english.female = result.text;
          const maleTa = card.querySelector(`textarea[data-entry-id="${cssEscape(entryId)}"][data-slot="male"]`);
          const femaleTa = card.querySelector(`textarea[data-entry-id="${cssEscape(entryId)}"][data-slot="female"]`);
          if (maleTa) { maleTa.value = result.text; autoGrow(maleTa); }
          if (femaleTa) { femaleTa.value = result.text; autoGrow(femaleTa); }
        } else {
          entry.english.text = result.text;
          const ta = card.querySelector(`textarea[data-entry-id="${cssEscape(entryId)}"][data-slot="text"]`);
          if (ta) { ta.value = result.text; autoGrow(ta); }
        }
      }
    }

    refreshResearchAfterEdit();
  }

  function syncAllLinkedTextareas(sourceEntryId, slot, newValue, sourceTa) {
    const groupId = syncGroupMap.get(sourceEntryId + '|' + slot);
    if (groupId == null) return;
    const members = syncGroups.get(groupId) || [];
    members.forEach(({ entryId, slot: s }) => {
      if (entryId === sourceEntryId && s === slot) return;

      const e = currentDoc.flatEntries.find(x => x.id === entryId);
      if (e && e.english) {
        if (e.english.type === 'gendered') e.english[s] = newValue;
        else e.english.text = newValue;
      }

      const other = card.querySelector(
        `textarea[data-entry-id="${cssEscape(entryId)}"][data-slot="${cssEscape(s)}"]`
      );
      if (other && other !== sourceTa) {
        other.value = newValue;
        autoGrow(other);
      }
    });
  }

  /* =========================================================
     Research panel
     ========================================================= */
  const MIN_QUERY_LEN = 2;
  let lastResearchQuery = '';

  function getStageSelectionText(target) {
    if (target && target.tagName === 'TEXTAREA') {
      const ta = target;
      return ta.value.substring(ta.selectionStart, ta.selectionEnd);
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    if (!stageEl.contains(sel.anchorNode)) return '';
    return sel.toString();
  }

  function onStageSelectionEvent(e) {
    setTimeout(() => {
      const raw = getStageSelectionText(e.target);
      const query = raw.replace(/\s+/g, ' ').trim();
      if (query.length < MIN_QUERY_LEN) return;
      if (query === lastResearchQuery) return;
      runResearch(query);
    }, 0);
  }

  stageEl.addEventListener('mouseup', onStageSelectionEvent);
  stageEl.addEventListener('keyup', onStageSelectionEvent);

  researchInputEl.addEventListener('input', () => {
    const query = researchInputEl.value.replace(/\s+/g, ' ').trim();
    toggleResearchClearBtn();
    if (query.length < MIN_QUERY_LEN) {
      lastResearchQuery = '';
      renderResearchEmptyState();
      return;
    }
    lastResearchQuery = query;
    renderResearchResults(query, searchAllDocuments(query));
  });

  researchClearBtn.addEventListener('click', () => {
    researchInputEl.value = '';
    lastResearchQuery = '';
    toggleResearchClearBtn();
    renderResearchEmptyState();
    researchInputEl.focus();
  });

  function toggleResearchClearBtn() {
    researchClearBtn.hidden = researchInputEl.value.length === 0;
  }

  function runResearch(query) {
    lastResearchQuery = query;
    if (researchInputEl.value !== query) researchInputEl.value = query;
    toggleResearchClearBtn();
    renderResearchResults(query, searchAllDocuments(query));
  }

  function renderResearchEmptyState() {
    researchPanelEl.innerHTML =
      '<div class="research-empty">Select a word or phrase in an entry, or search above, to see how it was translated elsewhere.</div>';
  }

  // Find possible translation-placement mistakes: entries whose live English
  // text is identical but whose French source dialog differs.
  function normalizedDialogueKey(dialogue) {
    if (!dialogue) return '';
    const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    if (dialogue.type === 'gendered') return 'M:' + norm(dialogue.male) + '|F:' + norm(dialogue.female);
    return (dialogue.label ? dialogue.label + ':' : '') + norm(dialogue.text);
  }

  function dialogueDisplayHTML(dialogue) {
    if (!dialogue) return '';
    if (dialogue.type === 'gendered') {
      return '<div><span class="label">M:</span> ' + escapeHtml(dialogue.male || '') + '</div>' +
             '<div><span class="label">F:</span> ' + escapeHtml(dialogue.female || '') + '</div>';
    }
    const label = dialogue.label ? '<span class="label">' + escapeHtml(dialogue.label) + ':</span> ' : '';
    return '<div>' + label + escapeHtml(dialogue.text || '') + '</div>';
  }

  function showEnglishCollisionReport() {
    researchInputEl.value = '';
    lastResearchQuery = '';
    toggleResearchClearBtn();
    const byEnglish = new Map();

    loadedFiles.forEach(fileEntry => {
      fileEntry.doc.flatEntries.forEach(entry => {
        if (!entry.english || !entry.french) return;
        const englishKey = normalizedDialogueKey(entry.english);
        const frenchKey = normalizedDialogueKey(entry.french);
        if (!englishKey || !frenchKey) return;
        let group = byEnglish.get(englishKey);
        if (!group) {
          group = { english: entry.english, entries: [], frenchKeys: new Set(), sourceGroups: new Map() };
          byEnglish.set(englishKey, group);
        }
        let sourceGroup = group.sourceGroups.get(frenchKey);
        if (!sourceGroup) {
          sourceGroup = { french: entry.french, entries: [] };
          group.sourceGroups.set(frenchKey, sourceGroup);
        }
        sourceGroup.entries.push({
          docId: fileEntry.id,
          docTitle: fileEntry.title,
          entryId: entry.id,
          speaker: entry.speaker,
          french: entry.french,
          english: entry.english,
          frenchKey
        });
        group.entries.push({
          docId: fileEntry.id,
          docTitle: fileEntry.title,
          entryId: entry.id,
          speaker: entry.speaker,
          french: entry.french,
          english: entry.english,
          frenchKey
        });
        group.frenchKeys.add(frenchKey);
      });
    });

    const collisions = [...byEnglish.values()]
      .filter(group => group.frenchKeys.size > 1)
      .sort((a, b) => a.entries[0].entryId.localeCompare(b.entries[0].entryId, undefined, { numeric: true }));

    if (!collisions.length) {
      researchPanelEl.innerHTML = '<div class="research-empty">No cases found where different French dialogs share the same English translation. Load a translation file first, or edit the English text and scan again.</div>';
      return;
    }

    let html = '<div class="research-query">Possible misplaced translations — ' + collisions.length + ' shared-English group' + (collisions.length === 1 ? '' : 's') + '</div>';
    html += '<div class="research-empty collision-help">Each group below has the same English wording but more than one distinct French source. Click any entry to inspect it. These are candidates to review, not necessarily errors.</div>';
    collisions.forEach((group, index) => {
      const sourceGroups = [...group.sourceGroups.values()]
        .sort((a, b) => a.entries[0].entryId.localeCompare(b.entries[0].entryId, undefined, { numeric: true }));
      html += '<section class="collision-group"><div class="collision-group-title">Group ' + (index + 1) + ' · ' + sourceGroups.length + ' distinct French dialogs (' + group.entries.length + ' entries)</div>';
      html += '<div class="collision-shared-english">English: ' + dialogueDisplayHTML(group.english) + '</div>';
      sourceGroups.forEach(sourceGroup => {
        // Show only the first representative entry for each distinct French dialog.
        // Repeated occurrences are intentionally omitted to keep the report concise.
        const entry = sourceGroup.entries[0];
        html += '<div class="collision-entry">' +
          '<div class="research-french">' + dialogueDisplayHTML(sourceGroup.french) + '</div>' +
          '<div class="collision-matching-entries"><button type="button" class="collision-entry-link" data-doc-id="' + escapeHtml(entry.docId) + '" data-entry-id="' + escapeHtml(entry.entryId) + '" title="Open dialog ' + escapeHtml(entry.entryId) + '">' + escapeHtml(entry.entryId) + '</button>' +
          ' <span class="research-speaker">' + escapeHtml(entry.speaker) + '</span>';
        if (loadedFiles.size > 1) html += ' <span class="research-doc">' + escapeHtml(entry.docTitle) + '</span>';
        html += '</div></div>';
      });
      html += '</section>';
    });
    researchPanelEl.innerHTML = html;
    researchPanelEl.querySelectorAll('.collision-entry-link').forEach(item => {
      item.addEventListener('click', () => jumpToResearchResult(item.dataset.docId, item.dataset.entryId));
    });
  }

  if (collisionScanBtn) collisionScanBtn.addEventListener('click', showEnglishCollisionReport);

  function searchAllDocuments(query) {
    const qLower = query.toLowerCase();
    const groupsByKey = new Map();
    const groups = [];

    loadedFiles.forEach(fileEntry => {
      const doc = fileEntry.doc;
      doc.flatEntries.forEach(entry => {
        const frenchHit = entry.french ? dialogueContains(entry.french, qLower) : false;
        const englishHit = entry.english ? dialogueContains(entry.english, qLower) : false;
        if (!frenchHit && !englishHit) return;

        // Use the live edited values, not the keys created when the file was loaded.
        const liveFrenchKey = frenchKeyFor(entry.french);
        const liveEnglishKey = englishKeyFor(entry.english);
        const dedupeKey = (liveFrenchKey || '') + '::' + (liveEnglishKey || '');

        let g = groupsByKey.get(dedupeKey);
        if (!g) {
          g = { french: entry.french, english: entry.english, members: [] };
          groupsByKey.set(dedupeKey, g);
          groups.push(g);
        }
        g.members.push({
          docId: doc.id,
          docTitle: doc.title,
          entryId: entry.id,
          speaker: entry.speaker
        });
      });
    });

    return groups;
  }

  function pickJumpTarget(members) {
    if (currentDoc) {
      const inCurrent = members.find(m => m.docId === currentDoc.id);
      if (inCurrent) return inCurrent;
    }
    return members[0];
  }

  function dialogueContains(dialogue, qLower) {
    if (dialogue.type === 'gendered') {
      return (dialogue.male && dialogue.male.toLowerCase().includes(qLower)) ||
             (dialogue.female && dialogue.female.toLowerCase().includes(qLower));
    }
    return !!(dialogue.text && dialogue.text.toLowerCase().includes(qLower));
  }

  function renderResearchResults(query, groups) {
    if (!groups.length) {
      researchPanelEl.innerHTML =
        `<div class="research-empty">No other occurrences of “${escapeHtml(query)}” found.</div>`;
      return;
    }

    const currentEntryId = currentDoc && currentDoc.groups[currentIndex]
      ? currentDoc.groups[currentIndex].primary.id
      : null;
    const currentDocId = currentDoc ? currentDoc.id : null;
    const showDocLabel = loadedFiles.size > 1;

    const totalEntries = groups.reduce((sum, g) => sum + g.members.length, 0);
    const countLabel = groups.length === totalEntries
      ? `${groups.length} match${groups.length === 1 ? '' : 'es'}`
      : `${groups.length} translation${groups.length === 1 ? '' : 's'} · ${totalEntries} entries`;

    let html = `<div class="research-query">“${escapeHtml(query)}” — ${countLabel}</div>`;
    html += groups.map(g => researchResultHTML(g, query, currentEntryId, currentDocId, showDocLabel)).join('');

    researchPanelEl.innerHTML = html;

    researchPanelEl.querySelectorAll('.research-item').forEach(item => {
      item.addEventListener('click', () => {
        jumpToResearchResult(item.dataset.docId, item.dataset.entryId);
      });
    });
  }

  function researchResultHTML(group, query, currentEntryId, currentDocId, showDocLabel) {
    const members = group.members;
    const idsText = members.map(m => m.entryId).join(', ');
    const speakerText = [...new Set(members.map(m => m.speaker))].join(' / ');
    const docTitles = [...new Set(members.map(m => m.docTitle))].join(', ');
    const isCurrent = members.some(m => m.entryId === currentEntryId && m.docId === currentDocId);
    const target = pickJumpTarget(members);

    const frenchHTML = group.french ? highlightDialogueHTML(group.french, query) : '';
    const englishHTML = group.english ? highlightDialogueHTML(group.english, query) : '';

    return (
      `<div class="research-item${isCurrent ? ' is-current' : ''}" data-doc-id="${escapeHtml(target.docId)}" data-entry-id="${escapeHtml(target.entryId)}">` +
        `<div class="research-item-head">` +
          `<span class="research-entry-id">${escapeHtml(idsText)}</span>` +
          (members.length > 1 ? `<span class="research-shared-badge">×${members.length}</span>` : '') +
          `<span class="research-speaker">${escapeHtml(speakerText)}</span>` +
          (isCurrent ? `<span class="research-current-tag">current</span>` : '') +
          (showDocLabel ? `<span class="research-doc">${escapeHtml(docTitles)}</span>` : '') +
        `</div>` +
        (frenchHTML ? `<div class="research-french">${frenchHTML}</div>` : '') +
        (englishHTML ? `<div class="research-english">${englishHTML}</div>` : '') +
      `</div>`
    );
  }

  function highlightDialogueHTML(dialogue, query) {
    if (dialogue.type === 'gendered') {
      return (
        `<div><span class="label">M:</span> ${highlightText(dialogue.male, query)}</div>` +
        `<div><span class="label">F:</span> ${highlightText(dialogue.female, query)}</div>`
      );
    }
    return `<div>${highlightText(dialogue.text, query)}</div>`;
  }

  function highlightText(text, query) {
    if (!text) return '';
    if (!query) return escapeHtml(text);

    const lower = text.toLowerCase();
    const qLower = query.toLowerCase();
    let out = '';
    let i = 0;

    while (i < text.length) {
      const idx = lower.indexOf(qLower, i);
      if (idx === -1) {
        out += escapeHtml(text.slice(i));
        break;
      }
      out += escapeHtml(text.slice(i, idx));
      out += '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>';
      i = idx + query.length;
    }

    return out;
  }

  function findGroupIndexForEntry(doc, entryId) {
    return doc.groups.findIndex(g => g.all.some(e => e.id === entryId));
  }

  function jumpToResearchResult(docId, entryId) {
    if (!currentDoc || currentDoc.id !== docId) {
      const fileEntry = loadedFiles.get(docId);
      if (!fileEntry) return;

      // Keep the edited in-memory document; do not reparse the original file text.
      currentDoc = fileEntry.doc;
      currentIndex = 0;
      docTitleEl.textContent = fileEntry.title;
      stagePlaceholder.hidden = true;
      card.hidden = false;
      progressWrap.hidden = false;
      buildSyncGroups();
      renderCurrentCard('none');
      updateProgress();
      updateNavButtons();
      exportBtn.disabled = false;
    }

    const idx = findGroupIndexForEntry(currentDoc, entryId);
    if (idx !== -1) goToIndex(idx);
  }

  /* =========================================================
     Navigation
     ========================================================= */
  function navigate(delta) {
    if (!currentDoc) return;
    const next = currentIndex + delta;
    if (next < 0 || next >= currentDoc.groups.length) return;
    if (isTransitioning) return;
    currentIndex = next;
    renderCurrentCard(delta > 0 ? 'forward' : 'backward');
    updateProgress();
    updateNavButtons();
  }

  function goToIndex(targetIndex) {
    if (!currentDoc) return;
    const total = currentDoc.groups.length;
    if (total === 0) return;

    let next = Math.max(0, Math.min(total - 1, targetIndex));
    if (next === currentIndex) return;

    const direction = next > currentIndex ? 'forward' : 'backward';
    currentIndex = next;

    if (isTransitioning) {
      isTransitioning = false;
      card.className = 'card';
      card.innerHTML = buildCardHTML(currentDoc.groups[currentIndex]);
      applyCardClasses();
      wireCardInputs();
      autoGrowAll();
    } else {
      renderCurrentCard(direction);
    }
    updateProgress();
    updateNavButtons();
  }

  function updateProgress() {
    const total = currentDoc.groups.length;
    const pos = currentIndex + 1;
    progressFill.style.width = (pos / total * 100) + '%';
    progressLabel.textContent = pos + ' / ' + total;
    if (hudValPos) hudValPos.textContent = String(pos);
    const hudTotal = document.querySelector('#map-coordinates-hud .coord-lbl');
    if (hudTotal) hudTotal.textContent = '/ ' + total;
    refreshState();
    document.dispatchEvent(new CustomEvent('translatorstate', { detail: { name: currentDoc.id, progress: pos } }));
  }

  function updateNavButtons() {
    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === currentDoc.groups.length - 1;
  }

  prevBtn.addEventListener('click', () => navigate(-1));
  nextBtn.addEventListener('click', () => navigate(1));

  // Escape leaves the field being typed in, so the arrow keys move between entries again
  window.addEventListener('keydown', e => {
    const t = e.target;
    if (e.key === 'Escape' && t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && document.body.classList.contains('ws-tool-translator')) t.blur();
  });

  window.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
    if (!currentDoc || !document.body.classList.contains('ws-tool-translator')) return;

    if (e.key === 'ArrowLeft') { e.preventDefault(); navigate(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
  });

  window.addEventListener('resize', () => autoGrowAll());

  /* =========================================================
     Clickable / draggable progress bar
     ========================================================= */
  function indexFromPointerEvent(e) {
    const rect = progressBar.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = rect.width > 0 ? x / rect.width : 0;
    const total = currentDoc ? currentDoc.groups.length : 0;
    if (total === 0) return 0;
    return Math.min(total - 1, Math.floor(ratio * total));
  }

  function onProgressPointerDown(e) {
    if (!currentDoc) return;
    e.preventDefault();
    progressBar.setPointerCapture(e.pointerId);
    progressBar.classList.add('scrubbing');
    goToIndex(indexFromPointerEvent(e));
  }

  function onProgressPointerMove(e) {
    if (!progressBar.classList.contains('scrubbing')) return;
    if (!currentDoc) return;
    const target = indexFromPointerEvent(e);
    if (target !== currentIndex) {
      goToIndex(target);
    }
  }

  function onProgressPointerUp(e) {
    if (progressBar.hasPointerCapture && progressBar.hasPointerCapture(e.pointerId)) {
      progressBar.releasePointerCapture(e.pointerId);
    }
    progressBar.classList.remove('scrubbing');
  }

  if (progressBar) {
    progressBar.addEventListener('pointerdown', onProgressPointerDown);
    progressBar.addEventListener('pointermove', onProgressPointerMove);
    progressBar.addEventListener('pointerup', onProgressPointerUp);
    progressBar.addEventListener('pointercancel', onProgressPointerUp);
  }

  /* =========================================================
     Export
     ========================================================= */
  async function exportEnglish() {
    if (!currentDoc) return;

    const lines = [];
    const srcLabel = (currentDoc.flatEntries[0] && currentDoc.flatEntries[0].sourceLang === 'ru')
      ? 'Original Russian'
      : 'French';

    const stamp = `[${fmtTime(currentDoc.seconds)}] [${currentIndex + 1}]`;
    const stampRe = STAMP_RE;
    if (currentDoc.preamble) {
      lines.push(stampRe.test(currentDoc.preamble)
        ? currentDoc.preamble.replace(stampRe, () => stamp)
        : stamp + '\n\n' + currentDoc.preamble);
      lines.push('');
      lines.push('');
    } else {
      lines.push(stamp);
      lines.push('');
      lines.push('');
    }

    currentDoc.flatEntries.forEach(entry => {
      lines.push(`${entry.id} - ${entry.speaker}`);
      lines.push('');

      if (entry.context && entry.context.trim() !== '') {
        lines.push('Context:');
        lines.push(entry.context.trim());
        lines.push('');
      }

      if (entry.french) {
        lines.push(srcLabel + ':');
        lines.push(dialogueToText(entry.french));
        lines.push('');
      }
      if (entry.english) {
        lines.push('English:');
        lines.push(dialogueToText(entry.english));
        lines.push('');
      }
      if (entry.note) {
        lines.push('Note:');
        lines.push(entry.note);
        lines.push('');
      }
      lines.push('');
    });

    // "<name> [<dialogs done> - <total> done].txt"
    const base = currentDoc.id.replace(/\.txt$/i, '').replace(/\s*\[\s*\d+\s*-\s*\d+\s*done\s*\]/i, '');
    const fileName = `${base} [${doneCount(currentDoc)} - ${currentDoc.flatEntries.length} done].txt`;
    const text = lines.join('\n');
    // written into translator/data (the folder the files are loaded from) when the browser lets us (translator-ui.js);
    // otherwise it is downloaded
    const saved = window.translatorSave ? await window.translatorSave(fileName, text) : false;
    if (!saved) {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    return { name: fileName, text, progress: currentIndex + 1, saved };
  }

  // dialogs done = those in the lines before the furthest one reached
  function doneCount(doc) {
    let n = 0;
    for (let i = 0; i < doc.reached - 1 && i < doc.groups.length; i++) n += doc.groups[i].all.length;
    return n;
  }

  // every 200 dialogs done since the file was opened: the bar and the button go red until exported;
  // after that they go blue ("reload") until the page is reloaded onto the exported file
  const BATCH = 200;
  let reviewState = 'normal';
  function refreshState() {
    if (!currentDoc) return;
    if (currentDoc.baseline == null) currentDoc.baseline = doneCount(currentDoc);
    const delta = doneCount(currentDoc) - currentDoc.baseline;
    if (reviewState !== 'reload') reviewState = delta >= BATCH ? 'alert' : 'normal';
    const bar = document.getElementById('control-bar');
    bar.classList.toggle('tr-alert', reviewState === 'alert');
    bar.classList.toggle('tr-reload', reviewState === 'reload');
    exportBtn.classList.toggle('tr-alert', reviewState === 'alert');
    exportBtn.classList.toggle('tr-reload', reviewState === 'reload');
    exportBtn.textContent = reviewState === 'reload' ? '↻ Reload' : '⬇ Export';
    docTitleEl.textContent = reviewState === 'alert' ? `${Math.floor(delta / BATCH) * BATCH} dialogs done - export now!`
      : reviewState === 'reload' ? 'Reload now' : currentDoc.title;
  }

  function dialogueToText(dialogue) {
    if (!dialogue) return '';
    if (dialogue.type === 'gendered') {
      return `Male:\n${dialogue.male}\n\nFemale:\n${dialogue.female}`;
    }
    if (dialogue.label) {
      return `${dialogue.label}:\n${dialogue.text}`;
    }
    return dialogue.text;
  }

  /* =========================================================
     Utilities
     ========================================================= */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cssEscape(s) {
    return String(s).replace(/"/g, '\\"');
  }

  /* =========================================================
     Init
     ========================================================= */
  exportBtn.addEventListener('click', exportReady);

  // Review timer: counts only while the page is open, the window visible and focused.
  const timerEl = document.getElementById('reviewTimer');
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  }
  function showTimer() {
    timerEl.hidden = !currentDoc;
    if (currentDoc) timerEl.textContent = fmtTime(currentDoc.seconds);
  }
  setInterval(() => {
    if (!currentDoc || document.hidden || !document.hasFocus() || !document.body.classList.contains('ws-tool-translator')) return;
    currentDoc.seconds++;
    showTimer();
  }, 1000);
  new MutationObserver(showTimer).observe(progressWrap, { attributes: true, attributeFilter: ['hidden'] });

  async function exportReady() {
    if (reviewState === 'reload') { document.dispatchEvent(new CustomEvent('translatorreload')); return; }
    const wasAlert = reviewState === 'alert';
    const out = await exportEnglish();
    if (wasAlert && out) {
      reviewState = 'reload';
      document.dispatchEvent(new CustomEvent('translatorexport', { detail: out }));
      refreshState();
    }
  }
})();
