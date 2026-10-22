// The Files and Workshop screens: the Asset Browser in a frame of the Atlas, dressed with the Atlas's bar (see atlas-app.js)

(window.AtlasParts = window.AtlasParts || {}).frames = function (env) {
  const { IT, MAP_BY_KEY, PEOPLE, filterDemoToPlace, filterQuestsToPlace, focusContainer, focusTile, itemView, nkey, placeTitle, qv, renderDemo, renderItems, renderLibrary, renderQuests, selectNpc, showQuest, startWorldFrame, syncLink } = env;

/* ------------------------------------------------------------------ files and workshop */
// Both are the Asset Browser itself (the browser view of index.html, unchanged), each in a frame of its own, loaded the first time it opens.
// Files shows every kind of file. The Workshop keeps to the maps: a map picked there opens straight in the map editor, and
// "Exit edit" goes back to the maps. Files has no editing tools at all (no Edit, world editor or .ART packer). Each frame keeps its own GET link
// (?mode=sec&path=..&editor=on), which the address bar repeats as #files&<link> / #workshop&<link>. The two share the Asset
// Browser's last place (localStorage), so the Workshop always starts from a link of its own.
const BROWSERS = {
  files: { frame: document.getElementById('filesFrame'), note: document.getElementById('filesNote'), start: '', list: 'file list', query: '', seen: null },
  workshop: { frame: document.getElementById('workFrame'), note: document.getElementById('workNote'), start: 'mode=sec', list: 'map list', query: '', seen: null },
};
const filesFrame = BROWSERS.files.frame;
// a #files / #workshop link has started its frame already (index.html): that is its link
for (const b of Object.values(BROWSERS)) { const src = b.frame.getAttribute('src'); if (src) b.query = src.split('?')[1] || ''; }
function loadBrowser(screen, query) {
  const b = BROWSERS[screen];
  if (query && screen === 'files') { const p = new URLSearchParams(query); p.delete('editor'); query = String(p); }   // editing is the Workshop's
  if (b.frame.getAttribute('src') && (!query || query === b.query)) return;
  b.query = query || b.start; b.seen = null;
  b.frame.style.visibility = 'hidden';                 // shown once dressed (the load handler)
  b.frame.src = 'index.html' + (b.query ? '?' + b.query : '');
}
function openFiles(query) { loadBrowser('files', query); go('files'); }
// One top bar: the Asset Browser's (file types, its tools, the map editor's menu), in the Atlas bar's dress. Its brand becomes
// the Atlas's (a click goes to the welcome screen). Files adds the "in the Atlas"
// button; the Workshop puts its own short menu where the file types were.
const BAR_CSS = `
:root { --topbar-h: 50px; }
.topbar { background: linear-gradient(#2a2318, #211c14); border-bottom-color: #5c4b31; }
.topbar .topbar-tabs, .topbar .tab-group { gap: 2px; }
.topbar .tab-sep { height: 16px; margin: 0 6px; background: #5c4b31; }
.topbar .topbar-tabs .file-mode-btn, #workNav button { border: 0; background: none; padding: 7px 13px; border-radius: 4px; box-shadow: none;
  font: 600 12.5px/1.2 'Cinzel', Georgia, serif; letter-spacing: .03em; color: #b3a685; cursor: pointer; }
.topbar .topbar-tabs .file-mode-btn:hover, .topbar .topbar-tabs .file-mode-btn:focus-visible, #workNav button:hover, #workNav button:focus-visible { background: none; border: 0; color: #f1e4c3; }
.topbar .topbar-tabs .file-mode-btn.active, .topbar .topbar-tabs .file-mode-btn[aria-pressed="true"], #workNav button[aria-pressed="true"] { background: none; border: 0; color: #f1e4c3; box-shadow: inset 0 -2px 0 #e8c66a; }
.topbar .tool-btn { font: 600 11px/1.2 'Cinzel', Georgia, serif; letter-spacing: .02em; }
#filesAtlas { border-color: #e8c66a; color: #e8c66a; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
#filesAtlas:hover { color: #ffe066; }
#filesAtlas[hidden] { display: none; }
/* the map editor's menu: its switches read as the bar's tabs (a gold line = on), Export / Exit edit as its buttons */
.topbar-editor { gap: 10px; }
.topbar-editor .sec-overlay-controls { gap: 0; border-left-color: #5c4b31; }
.topbar-editor .sec-overlay-toggle, .topbar-editor .sec-view-btn { border: 0; border-radius: 4px; background: none; padding: 7px 8px; box-shadow: none;
  font: 600 12px/1.2 'Cinzel', Georgia, serif; letter-spacing: .02em; color: #b3a685; }
.topbar-editor .sec-overlay-toggle:hover, .topbar-editor .sec-overlay-toggle:focus-visible,
.topbar-editor .sec-view-btn:hover, .topbar-editor .sec-view-btn:focus-visible { background: none; border: 0; color: #f1e4c3; }
.topbar-editor .sec-overlay-toggle[aria-pressed="true"], .topbar-editor .sec-view-btn[aria-pressed="true"] { background: none; color: #f1e4c3; box-shadow: inset 0 -2px 0 #e8c66a; }
.topbar-editor .sec-view-switch { border: 0; border-left: 1px solid #5c4b31; border-radius: 0; padding-left: 10px; overflow: visible; }
.topbar-editor .sec-view-btn + .sec-view-btn { border-left: 0; }
.topbar-editor .btn-back { margin: 0; padding: 6px 11px; border: 1px solid #5c4b31; border-radius: 4px; background: #2a2218; box-shadow: none; transform: none;
  font: 600 11px/1.2 'Cinzel', Georgia, serif; letter-spacing: .02em; color: #d4c5a1; white-space: nowrap; }
.topbar-editor .btn-back:hover:not(:disabled) { background: #362e22; color: #f1e4c3; transform: none; }
.topbar-editor .sec-edit-export:not(:disabled), .topbar-editor .sec-edit-btn { border-color: #e8c66a; color: #e8c66a; }
/* the file list folds away whole, as the Atlas's places list does, with the same slim tab on its edge (it moves with it) */
body.sidebar-collapsed:not(.sec-edit-full) { --side-left-w: 0px; }
.side-head .sidebar-toggle { display: none; }
.workspace { position: relative; }
#atlasEdge { position: absolute; left: var(--side-left-w); top: 50%; transform: translateY(-50%); z-index: 6; width: 14px; height: 64px; margin: 0; padding: 0;
  border: 1px solid #4a3e2e; border-left: 0; border-radius: 0 4px 4px 0; background: #211c14; color: #d4c5a1; font: 18px/1 Arial, sans-serif;
  display: flex; align-items: center; justify-content: center; cursor: pointer; transition: left .45s var(--ease, cubic-bezier(.4,0,.2,1)), background-color .18s, color .18s; }
#atlasEdge:hover { background: #362e22; color: #e8c66a; }
#atlasEdge::before { content: "‹"; }
body.sidebar-collapsed #atlasEdge::before { content: "›"; }
body.sec-edit-full #atlasEdge { display: none; }`;
// Files only shows: the map editor (Edit), the world editor and the .ART packer are the Workshop's
const FILES_CSS = `
#topbarTools .sec-edit-btn, #packerLaunchBtn, #worldEditorLaunchBtn { display: none !important; }`;
// the Workshop: maps only, so no file types; its menu (the maps, a new world, the .ART packer) stands in their place
const WORK_CSS = `
.topbar .topbar-tabs, #packerLaunchBtn, #worldEditorLaunchBtn { display: none !important; }
#workNav { grid-column: 2; justify-self: center; display: flex; align-items: center; gap: 2px; }
body.sec-edit-full #workNav { display: none; }
body.sec-edit-full .viewer-backbar { display: none; }      /* "Exit edit" is the way back to the maps */
.tb-ic { font-family: 'Segoe UI Symbol', 'Noto Sans Symbols 2', 'Apple Symbols', sans-serif; font-variant-emoji: text; font-weight: normal; }
.tb-map { display: inline-block; width: 1.05em; height: 1.12em; vertical-align: -.2em; background: currentColor; -webkit-mask: url(atlas/graphics/map-icon.png) center / contain no-repeat; mask: url(atlas/graphics/map-icon.png) center / contain no-repeat; }
.tool-back { display: none; }                                /* the Workshop's menu is the way back */`;
function dressBar(doc, screen) {
  if (doc.getElementById('atlasEmbed')) return;
  const b = BROWSERS[screen];
  // The page links its css/files.css / css/shell.css (and css/workshop.css, once a map opens) at the end of its body, and the sheet that comes last wins at equal weight: this one goes
  // after them (at the end of the body, kept there if the page adds more), or the bar shows the browser's own boxed buttons
  doc.body.insertAdjacentHTML('beforeend', `<style id="atlasEmbed">${BAR_CSS}${screen === 'workshop' ? WORK_CSS : FILES_CSS}</style>`);
  const dress = doc.getElementById('atlasEmbed');
  new doc.defaultView.MutationObserver(() => { if (doc.body.lastElementChild !== dress) doc.body.appendChild(dress); }).observe(doc.body, { childList: true });
  const brand = doc.getElementById('appTitle');
  brand.querySelector('.brand-title').textContent = 'Arcanum Asset Browser';
  brand.title = 'Welcome screen';
  doc.addEventListener('click', e => {               // before the Asset Browser's own handlers
    if (e.target.closest('#appTitle')) { e.stopPropagation(); e.preventDefault(); go('home'); }   // the Atlas's welcome screen
  }, true);
  if (screen === 'files') doc.getElementById('topbarTools').insertAdjacentHTML('afterbegin', '<button type="button" class="tool-btn" id="filesAtlas" hidden></button>');
  else dressWorkshop(doc);
  // the edge tab works the Asset Browser's own fold button (which keeps the choice)
  const fold = doc.getElementById('sidebarToggleBtn'), side = doc.getElementById('sideLeft');
  if (fold && side) {
    side.insertAdjacentHTML('afterend', '<button type="button" id="atlasEdge"></button>');
    const edge = doc.getElementById('atlasEdge');
    const label = () => { edge.title = edge.ariaLabel = (fold.getAttribute('aria-expanded') === 'false' ? 'Show the ' : 'Hide the ') + b.list; };
    edge.onclick = () => { fold.click(); label(); };
    label();
  }
  if (window.gameScroll) window.gameScroll(doc);       // the game's scrollbars, as in the Atlas (js/atlas/game-scroll.js)
}
// The Workshop's menu, and its rule: a map that opens goes into the editor, and leaving the editor goes back to the maps.
function dressWorkshop(doc) {
  const win = doc.defaultView, click = id => doc.getElementById(id)?.click();
  doc.getElementById('topbarTabs').insertAdjacentHTML('afterend', `<nav id="workNav" aria-label="Workshop">
    <button type="button" data-k="maps" aria-pressed="true" title="Pick a map to edit"><span class="tb-ic tb-map" aria-hidden="true"></span> Map editor</button>
    <button type="button" data-k="world" title="Make a new world map and edit it, or load one made here"><span class="tb-ic" aria-hidden="true">🌍&#xFE0E;</span> New world</button>
    <button type="button" data-k="packer" title="Build a .ART file from BMP / PNG frames"><span class="tb-ic" aria-hidden="true">🛠&#xFE0E;</span> .ART Packer</button>
    <button type="button" data-k="translator" title="Review and edit the English of a translated dialog file"><span class="tb-ic" aria-hidden="true">💬&#xFE0E;</span> Translator</button></nav>`);
  doc.getElementById('workNav').addEventListener('click', e => {
    const k = e.target.closest('button')?.dataset.k;
    if (!k) return;
    if (k === 'maps') { doc.dispatchEvent(new win.CustomEvent('toolpage', { detail: 'close' })); click('secExploreBtn'); return; }
    if (k === 'translator') { doc.dispatchEvent(new win.CustomEvent('toolpage', { detail: 'translator' })); return; }
    click(k === 'world' ? 'worldEditorLaunchBtn' : 'packerLaunchBtn');
  });
  const tools = doc.getElementById('topbarTools');
  let editing = false;
  const check = () => {
    if (doc.body.classList.contains('sec-edit-full')) { editing = true; return; }
    if (editing) { editing = false; click('secExploreBtn'); return; }          // "Exit edit": back to the maps
    const btn = tools.querySelector('.sec-edit-btn');
    if (btn && !btn.disabled && !btn.dataset.auto) { btn.dataset.auto = '1'; btn.click(); }
  };
  new win.MutationObserver(check).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  new win.MutationObserver(check).observe(tools, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  check();
}
// The page cannot reach into a file:// frame, and the browser keeps the viewers from reading the data folders there: then
// Files and the Workshop explain how to start the local server.
function onBrowserLoad(screen, b) {
  let doc = null; try { doc = b.frame.contentDocument; } catch (_) {}
  const ok = !!(doc && doc.getElementById('app'));
  if (ok) {
    try { dressBar(doc, screen); } catch (err) { console.error(`${screen}: could not dress the Asset Browser`, err); }
    b.seen = null;                                       // a new page: the poll below takes up its link (and "in the Atlas")
  }
  // shown once its list area is up (main.js opens the first tab or the last place at once; 3 s at most)
  const t0 = Date.now(), reveal = () => {
    let up = !ok; try { up = up || !doc.querySelector('.explorer').hidden; } catch (_) { up = true; }
    if (up || Date.now() - t0 > 3000) b.frame.style.visibility = ''; else requestAnimationFrame(reveal);
  };
  reveal();
  // main.js marks the page once its modules run; a page that loaded without them cannot read the files
  // (a slow start - a busy machine, the data still loading - is not a missing server: look again every half second, 20 s at most,
  // and show the note only when the page never booted)
  const started = Date.now();
  const look = () => {
    try { if (ok && b.frame.contentDocument !== doc) return; } catch (_) {}      // the frame went on to another page meanwhile
    let booted = false; try { booted = ok && !doc.querySelector('.explorer').hidden; } catch (_) {}
    if (booted || !ok || Date.now() - started > 20000) b.note.hidden = booted;
    else setTimeout(look, 500);
  };
  setTimeout(look, 1500);
}
for (const [screen, b] of Object.entries(BROWSERS)) {
  b.frame.addEventListener('load', () => onBrowserLoad(screen, b));
  // started early by index.html, it may have loaded before this script ran (a frame the page cannot read, from file://,
  // is taken as loaded: the handler then shows the note, and running it again on the real load does no harm)
  if (!b.frame.getAttribute('src')) continue;
  let early = true; try { const d = b.frame.contentDocument; early = !d || (d.readyState === 'complete' && b.frame.contentWindow.location.href !== 'about:blank'); } catch (_) {}
  if (early) onBrowserLoad(screen, b);
}
// the .mob a person or a container of the Atlas comes from (npcs.js / submaps.js / items.js: paths under data/maps)
const FILE_OWNER = new Map();
for (const n of PEOPLE) if (n.file) FILE_OWNER.set(n.file.toLowerCase(), { npc: n });
IT.containers.forEach((c, ci) => { if (c.file && !FILE_OWNER.has(c.file.toLowerCase())) FILE_OWNER.set(c.file.toLowerCase(), { ci }); });
function showNpcOnMap(n) {
  if (n.sub && MAP_BY_KEY.has(nkey(n.place))) focusTile(placeTitle(n.place), n.tile, n.name, n.place);   // inside a castle, cave, cellar...
  else focusTile(n.place, n.tile, n.name);
  selectNpc(n);
}
// Files -> Atlas: while a .mob of someone or something on the map is open, the top bar offers to show them there
function showFilesOwner(q) {
  const p = new URLSearchParams(q), file = p.get('file');
  const o = p.get('mode') === 'mob' && file ? FILE_OWNER.get(((p.get('path') ? p.get('path') + '/' : '') + file).toLowerCase()) : null;
  let filesAtlas = null; try { filesAtlas = filesFrame.contentDocument.getElementById('filesAtlas'); } catch (_) {}
  if (!filesAtlas) return;
  filesAtlas.hidden = !o;
  if (!o) return;
  const name = o.npc ? o.npc.name || 'Someone' : IT.containers[o.ci].name;
  filesAtlas.textContent = `📍 ${name} in the Atlas`;
  filesAtlas.title = `Show ${o.npc ? 'this person' : 'this container'} on the Atlas map`;
  filesAtlas.onclick = () => o.npc ? showNpcOnMap(o.npc) : focusContainer(o.ci);
}
// the Asset Browser writes every place it opens to its own address bar: follow it
setInterval(() => {
  const b = BROWSERS[env.current];
  if (!b || !b.frame.getAttribute('src')) return;
  let q, doc; try { if (b.frame.contentWindow.location.href === 'about:blank') return; q = b.frame.contentWindow.location.search.slice(1); doc = b.frame.contentDocument; } catch (_) { return; }
  if (env.current === 'workshop') {
    const tool = ['world', 'packer', 'translator'].find(k => doc.body.classList.contains('ws-tool-' + k));
    doc.querySelector('#workNav [data-k="maps"]')?.setAttribute('aria-pressed', String(!tool && new URLSearchParams(q).get('mode') === 'sec'));
    for (const k of ['world', 'packer', 'translator']) doc.querySelector(`#workNav [data-k="${k}"]`)?.setAttribute('aria-pressed', String(tool === k));
  }
  if (q === b.seen) return;
  b.seen = b.query = q; syncLink();
  if (env.current === 'files') showFilesOwner(q);
}, 400);

/* ------------------------------------------------------------------ screens */
const SCREENS = ['home', 'atlas', 'items', 'library', 'quests', 'people', 'files', 'workshop'];
// (the welcome page's picture is chosen by atlas-boot.js: it is on screen before this app starts)

function go(screen) {
  env.current = screen;
  if (screen !== 'home' && !BROWSERS[screen]) startWorldFrame();
  document.body.classList.remove(...SCREENS.map(s => 'screen-' + s));
  document.body.classList.add('screen-' + screen);
  if (['items', 'people', 'library', 'quests'].includes(screen)) document.body.classList.add('screen-atlas');   // these pages are part of the Atlas
  if (window.atlasSound) window.atlasSound();          // the Atlas's music stops in Files and Workshop
  syncLink();
  document.querySelectorAll('.workspace').forEach(w => w.classList.toggle('on', w.dataset.screen === screen));
  document.querySelectorAll('#atlasNav button').forEach(b => b.classList.toggle('on', (screen === 'atlas' || screen === 'people' || screen === 'library' || screen === 'quests') && b.dataset.go === screen));
  if (screen === 'people') renderDemo();
  if (screen === 'quests') { renderQuests(); if (qv.sel != null) showQuest(qv.sel); }
  if (screen === 'library') renderLibrary();
  if (screen === 'items') renderItems();
  if (BROWSERS[screen]) loadBrowser(screen);
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.go === 'items') itemView.filter = b.dataset.filter || (b.closest('#atlasNav') ? 'all' : itemView.filter);
  // from the map, Demographics and Quests open on the place that is on show
  if (env.current === 'atlas' && b.closest('#atlasNav')) {
    if (b.dataset.go === 'people') filterDemoToPlace();
    if (b.dataset.go === 'quests') filterQuestsToPlace();
  }
  go(b.dataset.go);
}));

  return { BROWSERS, loadBrowser, openFiles, SCREENS, go };
};
