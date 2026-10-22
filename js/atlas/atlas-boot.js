// Starts the Atlas (the page's app, atlas-app.js), and starts it again when the version changes. The last script of the Atlas view of index.html.
//
// The welcome screen is drawn at once: the Atlas's data files (js/atlas/data/, the version's own where it has them) load in the background
// (script tags that keep their order), and the app starts when they are all in. Until then a click on a button of the page is remembered and
// made again when the app is up.
//
// A change of version does not reload the page: the new version's files are fetched while the old version stays in use (nothing to wait for),
// then, in one go, the app is stopped (its listeners and timers undone, the sounds stopped), the data globals are cleared, the new files are run,
// the view's markup is made again from its <template> and the app starts on it. The view comes back from the link in the address bar, as it does
// after a reload (the app keeps that link up to date); the map frame and the file frames are new, so they read the new version.
(function () {
  const D = window.AtlasData;
  const writer = document.getElementById('atlasWriter'), tpl = document.getElementById('view-atlas'), me = document.currentScript;
  const setTimeout0 = window.setTimeout.bind(window), clearTimeout0 = window.clearTimeout.bind(window);
  const baseBodyClass = document.body.className;
  let viewNodes = [];                                       // what index.html wrote for the view: from the script that wrote it to this one
  for (let n = writer.nextSibling; n && n !== me; n = n.nextSibling) viewNodes.push(n);

  // ---- the files of a version, in the order the page ran them: what each one reads is in the ones before it
  function dataFiles(ver) {
    const u = name => D.url(name, ver), data = f => 'js/atlas/data/' + f + '.js';
    return [data('module-index'), data('world-labels'), u('items'), u('demographics'), u('library'), data('npcs'), u('routines'), data('submaps'),
      ...D.modUrls('maps', ver), u('modules'), 'js/atlas/modules-merge.js', u('waypoints'), u('notices'), 'js/atlas/modules-merge-labels.js', data('areas'),
      ...(ver === 'ru' ? D.modUrls('areas', ver) : []), u('quests'), u('portraits'), u('sound'), ...(D.has('sound-own', ver) ? [u('sound-own')] : []),
      'js/atlas/atlas-sound.js', 'js/atlas/atlas-library.js', 'js/atlas/atlas-frames.js',      // parts of the app (window.AtlasParts), run before it
      'js/atlas/atlas-app.js'];
  }
  const SCROLL = 'js/atlas/game-scroll.js';                  // (not a data file: it dresses the view, so it runs when the app is up)

  // ---- the page while the data loads
  let toastEl = null;
  function toast(text) {
    if (!text) { if (toastEl) toastEl.remove(); toastEl = null; return; }
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;padding:8px 16px;border:1px solid var(--border,#5c4b31);border-radius:6px;'
        + 'background:var(--surface,#211c14);color:var(--ink,#f1e4c3);font:600 13px var(--font-display,Georgia,serif);box-shadow:0 4px 18px rgba(0,0,0,.5);pointer-events:none';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    placeToast();
  }
  // over the map's filter bar when it is on screen (it is in the map's frame): same box, the text instead of the buttons
  function placeToast() {
    const base = 'position:fixed;z-index:9999;border:1px solid var(--border,#5c4b31);background:var(--surface,#211c14);color:var(--ink,#f1e4c3);'
      + 'font:600 13px var(--font-display,Georgia,serif);pointer-events:none;';
    let box = null;
    try {
      const fr = document.getElementById('worldFrame'), bar = fr && fr.contentDocument && fr.contentDocument.getElementById('filters');
      if (bar && fr.offsetParent) {
        const f = fr.getBoundingClientRect(), r = bar.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) box = { left: f.left + r.left, top: f.top + r.top, width: r.width, height: r.height };
      }
    } catch (_) {}
    toastEl.style.cssText = box
      ? base + `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;box-sizing:border-box;border-radius:9px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 8px;overflow:hidden`
      : base + 'left:50%;bottom:22px;transform:translateX(-50%);padding:8px 16px;border-radius:6px;box-shadow:0 4px 18px rgba(0,0,0,.5)';
  }
  // the welcome picture: a random one from atlas/welcome, another every 5 s; each is fetched only when its turn comes, and cross-fades in
  let slideTimer = 0, slideKeys = null;
  function startSlideshow() {
    const list = window.ArcanumHero || [], el = document.getElementById('heroMap');
    clearInterval(slideTimer); slideTimer = 0;                      // (a change of version makes the welcome markup again: the show begins on the new one)
    if (slideKeys) { document.removeEventListener('keydown', slideKeys); slideKeys = null; }
    if (!list.length || !el) return;
    const layers = [0, 1].map(() => { const d = document.createElement('div'); d.className = 'hero-slide'; el.appendChild(d); return d; });
    const cap = document.createElement('div'); cap.className = 'hero-caption'; el.appendChild(cap);
    let bag = [], seen = [], pos = -1, front = 0, first = true, token = 0;
    const pick = () => {
      if (!bag.length) {                                            // a fresh shuffle, never starting on the picture just shown
        const last = seen[seen.length - 1];                         // (a picture with weight w is in the bag w times: w times the chance per round)
        bag = list.flatMap(h => Array((h.w | 0) || 1).fill(h)).sort(() => Math.random() - .5);
        if (last && bag[bag.length - 1] === last) { const i = bag.findIndex(h => h !== last); if (i >= 0) bag.push(bag.splice(i, 1)[0]); }
      }
      let h = bag.pop();
      if (h === seen[seen.length - 1]) { const i = bag.findIndex(x => x !== h); if (i >= 0) { const o = bag.splice(i, 1)[0]; bag.push(h); h = o; } }   // (never the same picture twice in a row)
      return h;
    };
    const show = h => {
      const mine = ++token, img = new Image();
      img.onload = () => {
        if (mine !== token) return;                                 // a newer picture was asked for meanwhile
        const back = layers[1 - front];
        back.style.backgroundImage = `url("${h.src}")`;
        back.classList.add('on'); layers[front].classList.remove('on'); front = 1 - front;
        cap.classList.remove('on');
        setTimeout(() => { if (mine === token) { cap.textContent = h.alt; cap.classList.add('on'); } }, first ? 0 : 450);
        first = false;
      };
      img.src = h.src;
    };
    const step = dir => {
      if (dir < 0) { if (pos <= 0) return; pos--; }
      else if (pos < seen.length - 1) pos++;
      else { seen.push(pick()); pos = seen.length - 1; }
      show(seen[pos]);
    };
    const restart = () => { clearInterval(slideTimer); slideTimer = setInterval(() => { if (!document.hidden) step(1); }, 5000); };
    step(1); restart();
    document.addEventListener('keydown', slideKeys = e => {         // left / right browse the pictures, on the welcome screen only
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!document.body.classList.contains('screen-home') || e.target.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1); restart();
    });
  }
  // the welcome screen, which needs nothing from the data: its picture, the name of the version, and its place on screen
  function dressHome() {
    const hash = location.hash.slice(1).split('&')[0];
    if (!hash || hash === 'home') {
      document.body.classList.add('screen-home');
      document.documentElement.classList.remove('boot-home');      // screen-home hides the bar from here on
      const w = document.querySelector('.workspace[data-screen="home"]'); if (w) w.classList.add('on');
    }
    startSlideshow();
    const kicker = document.querySelector('.brand-kicker'), name = D.names[window.AtlasVer];
    if (kicker && name) kicker.textContent = name;
  }
  let wanted = null;
  function onWaitClick(e) {
    if (!e.target.closest || !e.target.closest('[data-go], .hero')) return;
    e.preventDefault(); e.stopPropagation();
    wanted = e.target;
    toast('Loading the Atlas…');
  }
  const waitForApp = on => document[on ? 'addEventListener' : 'removeEventListener']('click', onWaitClick, true);

  // ---- running scripts
  const fetchText = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.text(); });
  function run(text, url) {
    const s = document.createElement('script');
    s.text = text + '\n//# sourceURL=' + new URL(url, location.href).href;
    document.head.appendChild(s); s.remove();
  }
  // script tags that run in the order of the list, whenever each has arrived (a missing file is only reported: the app then misses its data)
  function loadScripts(urls) {
    return Promise.all(urls.map(url => new Promise(ok => {
      const s = document.createElement('script');
      s.async = false; s.src = url;
      s.onload = s.onerror = e => { if (e.type === 'error') console.warn('Atlas: could not load ' + url); s.remove(); ok(); };
      document.head.appendChild(s);
    })));
  }
  // the globals the data files make (every one is window.Arcanum... or the two Atlas... ones); hero.js and the page's own view name stay
  function clearData() {
    const keep = new Set(['ArcanumView', 'ArcanumHero']);
    for (const k of Object.getOwnPropertyNames(window)) if (/^(Arcanum|AtlasModuleIndex$|AtlasSoundOwn$)/.test(k) && !keep.has(k)) { try { delete window[k]; } catch (_) {} }
  }

  // ---- the app's life: what it adds to the page outside its own markup is recorded, to be undone
  let app = null, track = null;
  function beginTracking() {
    const t = { regs: [], timers: new Set(), head: new Set(document.head.children), undo: [] };
    for (const target of [window, document]) {
      const had = Object.prototype.hasOwnProperty.call(target, 'addEventListener'), orig = target.addEventListener;
      target.addEventListener = function (type, fn, opts) { t.regs.push([target, type, fn, opts]); return orig.call(this, type, fn, opts); };
      t.undo.push(() => { if (had) target.addEventListener = orig; else delete target.addEventListener; });
    }
    const st = window.setTimeout, si = window.setInterval;
    window.setTimeout = function (...a) { const id = st.apply(window, a); t.timers.add(id); return id; };
    window.setInterval = function (...a) { const id = si.apply(window, a); t.timers.add(id); return id; };
    t.undo.push(() => { window.setTimeout = st; window.setInterval = si; });
    return t;
  }
  function endTracking(t) {
    t.undo.forEach(f => f());
    for (const [target, type, fn, opts] of t.regs) target.removeEventListener(type, fn, opts);
    for (const id of t.timers) { clearTimeout(id); clearInterval(id); }
    [...document.head.children].filter(n => !t.head.has(n)).forEach(n => n.remove());
  }
  function startApp(scrollText) {
    waitForApp(false);
    track = beginTracking();
    try { app = window.AtlasApp(); if (scrollText) run(scrollText, SCROLL); else loadScripts([SCROLL]); }
    catch (err) { toast('The Atlas could not start: ' + err.message); throw err; }
    toast(null);
    if (wanted && wanted.isConnected) { const w = wanted; wanted = null; w.click(); }
  }
  function stopApp() {
    if (app && app.stop) { try { app.stop(); } catch (_) {} }
    if (track) endTracking(track);
    app = track = null;
  }
  // the view's markup again, as index.html wrote it (without its scripts)
  function rebuildView() {
    for (const n of viewNodes) n.remove();
    const frag = tpl.content.cloneNode(true);
    frag.querySelectorAll('script').forEach(s => s.remove());
    viewNodes = [...frag.childNodes];
    writer.after(frag);
    document.body.className = baseBodyClass;
  }

  // ---- the map across a change of version
  // The map in the old frame, as a picture (its canvas); null when no map is on screen.
  function snapshotMap() {
    try {
      const f = document.getElementById('worldFrame'), src = f && f.getAttribute('src') && f.contentDocument.getElementById('stage');
      if (!src || !src.width || !f.offsetWidth) return null;
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      return c;
    } catch (_) { return null; }
  }
  // The new map's frame is transparent (index.html / world-atlas.js: &over=1) and lies over the picture of the old map, so the sectors
  // come in over what was there instead of over black. Some seconds after the new map is up the picture fades out and the map turns opaque.
  function showOldMap(snap) {
    const frame = document.getElementById('worldFrame');
    if (!snap || !frame) return;
    snap.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    frame.before(snap);
    frame.style.background = 'transparent';
    frame.dataset.src += '&over=1';
    let timer = 0, done = false;
    const finish = () => {
      if (done) return; done = true;
      window.removeEventListener('message', onMessage);
      clearTimeout0(timer);
      if (!snap.isConnected) return;                         // (another change of version came first: the view was made again)
      try { frame.contentWindow.postMessage({ type: 'atlas-opaque' }, '*'); } catch (_) {}
      snap.style.transition = 'opacity .9s ease'; snap.style.opacity = '0';
      setTimeout0(() => { snap.remove(); frame.style.background = ''; }, 1000);
    };
    // (the map is shown when it has arrived on the wanted view, atlas-app.js revealMap: the picture goes some seconds after that, not before)
    const deadline = Date.now() + 15000;
    const tryFinish = () => { if (frame.style.visibility === 'hidden' && Date.now() < deadline) timer = setTimeout0(tryFinish, 300); else finish(); };
    const onMessage = e => { if (e.source === frame.contentWindow && e.data && (e.data.type === 'atlas-ready' || e.data.type === 'atlas-ack')) { clearTimeout0(timer); timer = setTimeout0(tryFinish, 3000); } };
    window.addEventListener('message', onMessage);
    timer = setTimeout0(finish, 15000);                      // (a map that never says it is ready)
  }

  // ---- the first start
  dressHome();
  waitForApp(true);
  // (from a file:// page nothing can be fetched: script tags only, and a change of version reloads the page)
  const FILE_PAGE = location.protocol === 'file:';
  const scrollText = FILE_PAGE ? null : fetchText(SCROLL).catch(() => null);
  loadScripts(dataFiles(window.AtlasVer)).then(() => scrollText).then(startApp).catch(err => { console.error(err); toast('The Atlas could not start: ' + err.message); });

  // ---- another version
  let switching = 0;
  async function switchVersion(next, previous) {
    if (FILE_PAGE) { location.reload(); return false; }
    const mine = ++switching;
    toast('Loading ' + (D.names[next] || next) + '…');
    let texts, scroll, util;
    const urls = dataFiles(next);
    try { [texts, scroll, util] = await Promise.all([Promise.all(urls.map(fetchText)), fetchText(SCROLL), import('../core/util.js')]); }
    catch (err) {
      if (mine !== switching) return false;
      try { localStorage.setItem('atlas-ver', previous); } catch (_) {}
      toast('Could not load that version (' + err.message + ')'); setTimeout0(() => { if (mine === switching) toast(null); }, 5000);
      return false;
    }
    if (mine !== switching) return false;                    // another version was picked meanwhile: that one goes on
    const snap = snapshotMap();
    stopApp();
    clearData();
    util.versionChanged();                                   // what the page's modules had read of the old version's files
    D.configure(next);
    urls.forEach((u, i) => run(texts[i], u));
    // (a ?ver= in the address would pick the old version again on the next reload)
    try { const u = new URL(location.href); if (u.searchParams.has('ver')) { u.searchParams.delete('ver'); history.replaceState(null, '', u); } } catch (_) {}
    rebuildView();
    dressHome();
    showOldMap(snap);
    startApp(scroll);
    return true;
  }
  window.AtlasBoot = { switchVersion };
})();
