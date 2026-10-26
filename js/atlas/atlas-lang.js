// The language of the page's text (the flags in the top bar). A language pack (data/language/<name>) changes only text, so nothing is rebuilt or restarted:
// the text that is on screen (this page and the frames in it: the map) is swapped for the pack's string of the same English string, and put back
// when the flag of English is pressed. The dictionary (js/atlas/data/lang/<key>.js, toolbox/atlas/build_language_overlay.py) is fetched when French is
// first chosen. A text node, or a title / placeholder / aria-label, whose whole text is one of the game's English strings is swapped; what the page adds
// later is swapped as it comes (MutationObserver). The choice is kept in localStorage 'atlas-lang'.
//   AtlasLang.set('fr' | 'en')   AtlasLang.tr(text)   (text drawn on a canvas asks for its own translation)   AtlasLang.lang
(function () {
  if (/[?&]embed=/.test(location.search)) return;      // (the map frame is this page, embedded: the page it is in swaps its text)
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE']);
  const orig = new WeakMap();                 // node -> its English text (text node), or {attr: English} (element)
  const watching = new Set();                 // documents the observer is on
  let dict = null, lang = 'en', observer = null;

  // only the Atlas is translated: its screens (maps, items, quests, library, demographics) and the map frame; not the welcome screen, the top bar, the
  // game-file browser or the workshop
  const ATLAS = new Set(['atlas', 'items', 'quests', 'library', 'people']);
  const inScope = n => {
    const e = n.nodeType === 1 ? n : n.parentElement;
    if (!e || !e.closest) return true;
    if (e.ownerDocument !== document) return true;           // (a frame: only the map's is ever watched)
    if (e.closest('#atlasNav')) return true;                 // (the Atlas's own tabs in the top bar)
    if (e.closest('header, .brand')) return false;
    const w = e.closest('.workspace');
    return w ? ATLAS.has(w.dataset.screen) : false;
  };
  // The Atlas writes ’ where the game's files have ', and some names in another case (Half-ogre / Half-Ogre): when the exact string is not in the
  // dictionary it is looked up without the difference. A shortened text ("The first words of a book…") is found by its beginning and cut again at
  // about the same length.
  const norm = x => x.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  let loose = null, sorted = null, rules = null;
  function index() {
    loose = new Map();
    const first = new Map();
    for (const k in dict) {
      const n = norm(k);
      if (loose.has(n)) continue;
      loose.set(n, dict[k]);
      if (/\n/.test(k)) first.set(n, [norm(k.split('\n')[0]), dict[k].split('\n')[0].trim()]);
    }
    sorted = [...loose.keys()].sort();
    sorted.first = first;
    rules = ((window.AtlasLangPatterns || {})[lang] || []).map(([rx, to, tr]) => [new RegExp(rx), to, tr]);
  }
  function cut(text, n, ellipsis) {
    text = text.replace(/\s+/g, ' ');
    if (text.length <= n) return text;
    return text.slice(0, n).replace(/\s+\S*$/, '') + (ellipsis ? '…' : '');
  }
  // the text that begins with `text`: its translation cut to about the same length (or its first line, when `text` is the English first line)
  function beginning(text, ellipsis, free) {
    const p = norm(text);
    if (p.length < 14) return null;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < p) lo = mid + 1; else hi = mid; }
    if (lo >= sorted.length || !sorted[lo].startsWith(p)) return null;
    const key = sorted[lo], line = sorted.first.get(key);
    if (line && line[0] === p) return line[1];
    if (!ellipsis && !free) return null;                       // (a name that begins a longer text is a name: only a cut text, or the Library's, is the beginning of one)
    return key.length > p.length ? cut(loose.get(key), text.length, ellipsis) : loose.get(key);
  }
  function lookup(k, depth = 0, free = false) {
    if (dict[k]) return dict[k];
    if (!loose) index();
    const n = norm(k);
    if (loose.has(n)) return loose.get(n);
    if (depth < 3) {
      for (const [rx, to, tr] of rules) {                       // (text with a number or a name in it: "Use Telegram", "15 quests")
        const m = rx.exec(k);
        if (m) return to.replace(/\$(\d)/g, (_, i) => tr.includes(+i) ? (lookup(m[i], depth + 1, free) || m[i]) : m[i]);
      }
      const icon = /^([^A-Za-z0-9“"«]+)([A-Za-z].*)$/.exec(k);        // (an icon before the words)
      if (icon) { const t = lookup(icon[2], depth + 1, free); if (t) return icon[1] + t; }
      const quoted = /^([“"«]\s*)([^…]+?)(\s*[”"»])$/.exec(k);            // (a title or a name between quotes)
      if (quoted) { const t = lookup(quoted[2], depth + 1, free); if (t) return quoted[1] + t + quoted[3]; }
    }
    const m = /^([^…]*?)(…)?([”"»]?)$/.exec(k);
    if (m) {                                                  // (a start of a text: the text that begins so, a label and the quote left out)
      const labelled = /^(.*?[“"«]\s*)(.+)$/.exec(m[1]);
      for (const [head, text] of labelled ? [[labelled[1], labelled[2]], ['', m[1]]] : [['', m[1]]]) {
        const t = beginning(text, !!m[2], free);
        if (t) return head + t + m[3];
      }
    }
    return null;
  }
  const swap = (s, free) => {
    const k = s.trim();
    const t = k && lookup(k, 0, free);
    return t ? s.replace(k, () => t) : null;
  };
  const inLibrary = n => { const e = n.nodeType === 1 ? n : n.parentElement, w = e && e.closest && e.closest('.workspace'); return !!w && w.dataset.screen === 'library'; };
  function text(n) {
    if (n.parentNode && SKIP.has(n.parentNode.nodeName)) return;
    if (!inScope(n)) return;
    const had = orig.get(n);
    const english = had !== undefined && n.nodeValue === had.shown ? had.english : n.nodeValue;
    const out = swap(english, inLibrary(n));
    if (out !== null && out !== n.nodeValue) { orig.set(n, { english, shown: out }); n.nodeValue = out; }
    else if (out === null && english !== n.nodeValue) n.nodeValue = english;      // (not in this language's dictionary: back to English, not the other language's text)
  }
  function element(e) {
    if (!inScope(e)) return;
    for (const a of ATTRS) {
      const v = e.getAttribute && e.getAttribute(a);
      if (!v) continue;
      const mine = orig.get(e) || {};
      const had = mine[a];
      const english = had && v === had.shown ? had.english : v;
      const out = swap(english);
      if (out !== null && out !== v) { mine[a] = { english, shown: out }; orig.set(e, mine); e.setAttribute(a, out); }
      else if (out === null && english !== v) e.setAttribute(a, english);
    }
  }
  function walk(root) {
    if (root.nodeType === 3) return text(root);
    if (root.nodeType !== 1 || SKIP.has(root.nodeName)) return;
    element(root);
    for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
    if (root.nodeName === 'IFRAME') watchFrame(root);
  }
  // everything back to English
  function restore(root) {
    if (root.nodeType === 3) { const had = orig.get(root); if (had && root.nodeValue === had.shown) root.nodeValue = had.english; return; }
    if (root.nodeType !== 1) return;
    const mine = orig.get(root);
    if (mine) for (const a in mine) if (root.getAttribute(a) === mine[a].shown) root.setAttribute(a, mine[a].english);
    for (let c = root.firstChild; c; c = c.nextSibling) restore(c);
    if (root.nodeName === 'IFRAME') { try { if (root.contentDocument) restore(root.contentDocument.documentElement); } catch (_) {} }
  }
  // The places in the Maps sidebar (#locList) are in alphabetical order in each group (towns, quest locations ...): in French they are put in the
  // alphabetical order of the French names, and back in the English order (the order they were in) when English is chosen again.
  let sortTimer = 0;
  function sortPlaces() {
    sortTimer = 0;
    const list = document.getElementById('locList');
    if (!list) return;
    const collator = new Intl.Collator(lang === 'en' ? 'en' : lang, { sensitivity: 'base', ignorePunctuation: true });
    const label = row => row.textContent.replace(/^[\s▸▾]+/, '').replace(/\d+\s*$/, '').trim();
    const segments = [];
    for (const c of list.children) {
      if (c.classList.contains('locgroup')) segments.push({ head: c, units: [] });
      else if (c.classList.contains('locrow') && segments.length) segments[segments.length - 1].units.push([c]);
      else if (segments.length && segments[segments.length - 1].units.length) segments[segments.length - 1].units.at(-1).push(c);      // (its sub-places)
    }
    for (const s of segments) {
      s.units.forEach((u, i) => { if (u[0].__en === undefined) u[0].__en = i; });
      const sorted = s.units.slice().sort(lang === 'en' ? (a, b) => a[0].__en - b[0].__en : (a, b) => collator.compare(label(a[0]), label(b[0])) || a[0].__en - b[0].__en);
      if (sorted.every((u, i) => u === s.units[i])) continue;
      let at = s.head;
      for (const u of sorted) for (const n of u) { if (at.nextSibling !== n) at.after(n); at = n; }
    }
  }
  // The items of the Items screen (#itemGrid) are in alphabetical order too. Every tile remembers its place in the English order (the order it came in).
  function sortItems() {
    const grid = document.getElementById('itemGrid');
    if (!grid) return;
    if (grid.__n === undefined) grid.__n = 0;
    for (const c of grid.children) if (c.__en === undefined) c.__en = grid.__n++;
    const kids = [...grid.children], collator = new Intl.Collator(lang === 'en' ? 'en' : lang, { sensitivity: 'base' });
    const label = c => c.textContent.replace(/\s+/g, ' ').trim();
    const want = kids.slice().sort(lang === 'en' ? (a, b) => a.__en - b.__en : (a, b) => collator.compare(label(a), label(b)) || a.__en - b.__en);
    if (want.every((c, i) => c === kids[i])) return;
    const frag = document.createDocumentFragment();
    want.forEach(c => frag.appendChild(c));
    grid.appendChild(frag);
  }
  const sortSoon = () => { if (!sortTimer) sortTimer = setTimeout(() => { sortPlaces(); sortItems(); }, 60); };
  const LISTS = '#locList, #itemGrid';
  function onMutations(list) {
    if (!dict) return;
    let places = false;
    for (const m of list) {
      if (m.type === 'characterData') text(m.target);
      else if (m.type === 'attributes') element(m.target);
      else m.addedNodes.forEach(walk);
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!places && t && t.closest && t.closest(LISTS)) places = true;
    }
    if (places) sortSoon();
    if (lang !== 'en') library();
  }
  function watch(doc) {
    if (watching.has(doc) || !doc.documentElement) return;
    watching.add(doc);
    observer = observer || new MutationObserver(onMutations);
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    walk(doc.documentElement);
  }
  // a frame of the page (the map): its document is a new one at each load
  function watchFrame(f) {
    if (f.id !== 'worldFrame') return;                       // (the file browser and the workshop are not the Atlas)
    const on = () => { try { if (lang !== 'en' && f.contentDocument) watch(f.contentDocument); } catch (_) {} };
    if (!f.__langHook) { f.__langHook = true; f.addEventListener('load', on); }
    on();
  }
  function script(file, global, key) {
    if (window[global] && window[global][key]) return Promise.resolve(window[global][key]);
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'js/atlas/data/lang/' + file + '.js';
      s.onload = () => ok(window[global][key]);
      s.onerror = () => fail(new Error('could not load ' + s.src));
      document.head.appendChild(s);
    });
  }
  const load = key => Promise.all([script(key, 'AtlasLangDict', key), script(key + '-library', 'AtlasLangLibrary', key)]).then(([d]) => d);
  // The Library's books, notes ... (drawn on a canvas from LB.mes): the language's lines are put over the game's, and the open document is drawn again.
  // The page's data is made again at each change of version: it is checked after every change of the page.
  function library() {
    const LB = window.ArcanumLibrary, fr = lang !== 'en' && window.AtlasLangLibrary && window.AtlasLangLibrary[lang];
    if (!LB || !LB.mes || (LB.mes.__lang || 'en') === (fr ? lang : 'en')) return;
    if (!LB.mes.__back) Object.defineProperty(LB.mes, '__back', { value: {}, writable: true });
    Object.defineProperty(LB.mes, '__lang', { value: fr ? lang : 'en', writable: true, configurable: true });
    const back = LB.mes.__back;
    for (const kind in back) for (const n in back[kind]) LB.mes[kind][n] = back[kind][n];
    if (fr) {
      for (const kind in fr) for (const n in fr[kind]) {
        if (!LB.mes[kind]) continue;
        (back[kind] ||= {})[n] ??= LB.mes[kind][n];
        LB.mes[kind][n] = fr[kind][n];
      }
    }
    // the fonts the books are drawn with (the language's art/interface fonts, one sheet): all or none, since the Library cuts them from one sheet
    const FF = window.AtlasLangLibraryFonts && window.AtlasLangLibraryFonts[lang];
    if (LB.fonts) {
      if (!LB.fonts.__back) Object.defineProperty(LB.fonts, '__back', { value: {}, writable: true });
      const fb = LB.fonts.__back;
      for (const n in fb) LB.fonts[n] = fb[n];
      if (fr && FF && Object.keys(LB.fonts).every(n => FF[n])) {
        for (const n of Object.keys(LB.fonts)) { fb[n] ??= LB.fonts[n]; LB.fonts[n] = FF[n]; }
      }
      if (LB.fontsChanged) LB.fontsChanged();
    }
    const open = document.querySelector('.libdocs .ldoc.on');       // (the document on show)
    if (open) open.click();
  }
  function flags() {
    for (const [id, l] of [['langEn', 'en'], ['langFr', 'fr'], ['langDe', 'de']]) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.setAttribute('aria-pressed', lang === l);
      b.hidden = lang === l;                                  // (the menu lists the other languages: the button above shows this one)
      if (lang !== l) continue;
      const cur = document.getElementById('langBtn');
      if (!cur) continue;
      cur.querySelector('.langcur-flag').replaceChildren(b.querySelector('svg').cloneNode(true));
      cur.querySelector('.langcur-name').textContent = b.dataset.name;
    }
  }
  function menu(open) {
    const list = document.getElementById('langList'), btn = document.getElementById('langBtn');
    if (!list || !btn) return;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', open);
  }
  async function set(next) {
    if (next === lang || !['en', 'fr', 'de'].includes(next)) return;
    try { localStorage.setItem('atlas-lang', next); } catch (_) {}
    if (next === 'en') {
      lang = 'en';
      watching.forEach(d => { try { restore(d.documentElement); } catch (_) {} });
      if (observer) observer.disconnect();
      watching.clear(); observer = null;
    } else {
      dict = await load(next);
      lang = next;
      loose = null;                                          // (the lookup index belongs to the language's dictionary)
      watching.forEach(d => { try { walk(d.documentElement); } catch (_) {} });       // (text already swapped to the other language: swapped again from its English)
      watch(document);
      document.querySelectorAll('iframe').forEach(watchFrame);
    }
    sortPlaces(); sortItems();
    library();
    flags();
  }
  window.AtlasLang = { set, tr: s => (lang !== 'en' && dict && swap(String(s))) || s };
  Object.defineProperty(window.AtlasLang, 'lang', { get: () => lang });
  // (the page's own flags, and the choice remembered)
  function init() {
    for (const [id, l] of [['langEn', 'en'], ['langFr', 'fr'], ['langDe', 'de']]) {
      const b = document.getElementById(id);
      if (b) b.onclick = () => { menu(false); set(l); };
    }
    const cur = document.getElementById('langBtn'), list = document.getElementById('langList');
    if (cur && list) {
      cur.onclick = e => { e.stopPropagation(); menu(list.hidden); };
      document.addEventListener('click', e => { if (!list.hidden && !list.contains(e.target)) menu(false); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') menu(false); });
    }
    let want = 'en';
    try { want = new URLSearchParams(location.search).get('lang') || localStorage.getItem('atlas-lang') || 'en'; } catch (_) {}
    if (want !== 'en') set(want).catch(() => {});
    flags();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
