// The map view of index.html (embedded in the Atlas with ?embed=1): sector pictures from atlas/world/, atlas/maps/, atlas/modules/ (listed in
// js/atlas/data/map-pictures.js), the world included.
'use strict';
(async () => {
  const L = window.ArcanumWorldLabels;
  const MP = window.ArcanumMaps || { maps: [], sections: [] };      // the other maps of the game (toolbox/atlas/build_submaps.py)
  let cur = -1;                                                       // the map on show: -1 = the world map, else an index into MP.maps
  const mapIndex = new Map(MP.maps.map((m, i) => [m.key, i]));
  const embed = new URLSearchParams(location.search).has('embed');
  document.body.classList.toggle('embed', embed);
  const msg = document.getElementById('msg');
  const PW = window.ArcanumPictures && window.ArcanumPictures.maps.World;
  if (!PW || !L) { msg.style.display = 'grid'; msg.textContent = 'The world map pictures (js/atlas/data/map-pictures.js) or js/atlas/data/world-labels.js are missing.'; return; }

  // ---- world geometry: a world tile is 80 x 40 px, (0, 0) at the top --------------------------------
  const tileWX = (X, Y) => 40 * (Y - X), tileWY = (X, Y) => 20 * (X + Y);   // centre of world tile (X, Y)

  // ---- labels -------------------------------------------------------------------------------------
  const ICON = { quest: '📜', shop: '🪙', followers: '🛡️', waypoint: '🚪', key: '🔑', npc: '🧑', chest: '📦', information: 'ℹ️', altar: '🕯️', bounty: '💰', master: '🎓' };
  const CHECK = {
    'object': ['#5ad878', 'On its game object'], 'one of several': ['#78c8ff', 'On one of several same-name objects'],
    'object far from screenshot spot': ['#ff78dc', 'On its object (far from the screenshot spot)'],
    'door near screenshot spot': ['#ffd250', 'Waypoint on a door near the spot'],
    'same kind of object near screenshot spot': ['#b4a0ff', 'Object of the same kind near the spot'],
    'approximate': ['#ff8c3c', 'Approximate (from the other labels)'], 'area centre': ['#ff3c3c', 'Approximate (centre of the area)'],
    'script': ['#4fd1ff', 'Waypoint: a teleport in a script'],
  };
  const labels = [];
  const catsOf = l => (Array.isArray(l.category) ? l.category : [l.category]).filter(Boolean);
  // Nothing here is a hand-made label any more. Waypoints come from the game's scripts (waypoints.js, toolbox/atlas/build_waypoints.py),
  // one per door, ladder or tile that teleports; signs from the scripts that read something out when an object is examined or
  // used (notices.js, toolbox/atlas/build_notices.py).
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // obj: the object (or tile) the script hangs on, for the Advanced view
  // image: the picture a diagram or mural opens (atlas/graphics/pictures/)
  // The labels of a map only a mod has (Vorakia Sewers in CE Restored and Forgotten Places) wait in modLabels: that map joins MP.maps
  // only when the mod is switched in (syncCEMaps), which then gives them their map and puts them with the others.
  const modLabels = [];
  for (const [key, area, x, y, title, text, obj, image] of (window.ArcanumNotices ? window.ArcanumNotices.notices : [])) {
    const map = key == null ? -1 : mapIndex.get(key), into = map == null ? modLabels : labels;
    into.push({ text: title, category: 'information', tile: [x, y], place: map >= 0 ? MP.maps[map].name : map == null ? key : area, map, mapKey: key != null ? key : area,
      description: text === title ? '' : esc(text).replace(/\n/g, '<br>'), image, placed: 'script', obj });      // a sign that only gives its name has nothing more to show
  }
  for (const [key, area, x, y, what, to, obj] of (window.ArcanumWaypoints ? window.ArcanumWaypoints.waypoints : [])) {
    const map = key == null ? -1 : mapIndex.get(key), into = map == null ? modLabels : labels;
    const names = [...new Set(to.map(t => t[4] || t[1]))];         // (t[4]: what the player picks in the dialog of a person who takes them there)
    // a sign on the very object that teleports (the Big Stone over Mannox's Hole): one label, the waypoint, with the sign's text in it
    const si = into.findIndex(l => l.category === 'information' && l.map === map && l.mapKey === (key != null ? key : area) && Math.abs(l.tile[0] - x) <= 1 && Math.abs(l.tile[1] - y) <= 1);
    const sign = si >= 0 ? into.splice(si, 1)[0] : null;
    into.push({ text: names.join(' / '), category: sign ? ['waypoint', 'information'] : 'waypoint', tile: [x, y], place: map >= 0 ? MP.maps[map].name : map == null ? key : area, map, mapKey: key != null ? key : area,
      description: sign ? sign.description || esc(sign.text) : undefined, image: sign ? sign.image : undefined,
      what, to: to.map(([m, place, tx, ty, label]) => ({ map: m, place, tile: [tx, ty], label })), placed: 'script', obj });
  }
  const mapKey = (map, place) => map >= 0 ? MP.maps[map].key : place;     // how items.js names the map a thing is on

  // People and containers come from the game files alone, one per object on its own tile (npcs.js, submaps.js, items.js);
  // the labels left are waypoints, notes, altars and quest objects, and never stand for a person or a container.
  // containers of the world map and of the other maps (items.js), each named by what it is (barrel, bin, wood chest...)
  const IT = window.ArcanumItems;
  // A trap door is a container (its lock) and a waypoint (the script that takes you down) on one tile: one display, the
  // waypoint, which says it is locked and how hard the lock is. (An empty trap door with no waypoint stays a container.)
  const doorWays = [...labels, ...modLabels].filter(l => catsOf(l).includes('waypoint'));
  const chests = [];                          // the containers of the version on show (items.js of the version): rebuilt when a mod switches its maps in (refreshChests)
  function refreshChests() {
    chests.length = 0;
    if (!IT) return;
    IT.containers.forEach((c, i) => {
      if (!c.tile) return;
      const map = c.world ? -1 : (mapIndex.has(c.place) ? mapIndex.get(c.place) : -2);
      if (map < -1) return;
      const row = { ...c, i, map };
      if (c.name === 'Trap Door' && !c.items.length && !c.source) {
        const w = doorWays.find(l => l.map === map && (!l.lock || l.lock.fromChest === i) && Math.abs(l.tile[0] - c.tile[0]) <= 2 && Math.abs(l.tile[1] - c.tile[1]) <= 2);
        if (w) {
          if (!w.lock) { w.lock = { locked: c.locked, keys: c.keys, held: c.held, jammed: c.jammed, fromChest: i }; w.text += ' 🔒'; }
          return;
        }
      }
      chests.push(row);
    });
  }
  let activeChest = null;
  const CONTAINER = 'Container';

  // everyone who stands on the map (npcs.js: people; creatures.js: animals, monsters, undead, mechanical - only fetched
  // when the player turns them on)
  const npcs = [], creatures = [];
  function addNpcs(data, into, sub) {
    if (!data) return;
    for (const r of data.npcs) {
      const [pl, x, y, kind, race, gender, level, align, name, shop, markup, role, portrait, off, file] = r;
      const n = { file, place: data.places[pl], tile: [x, y], kind, race: race >= 0 ? data.races[race] : '', raceIdx: race, gender, level, align, name, shop, markup, role, portrait, off: !!off, why: typeof off === 'string' ? off : '', offInfo: off && typeof off === 'object' ? off : null,
        kindName: data.kinds[kind], sub: !!sub, map: sub ? mapIndex.get(data.places[pl]) : -1 };
      if (n.map == null) continue;
      into.push(n);
    }
  }
  addNpcs(window.ArcanumNpcs, npcs);
  addNpcs(window.ArcanumSubNpcs, npcs, true);
  let creaturesLoading = false, activeNpc = null, creaturesLoaded = () => {};
  // The filter buttons under the map. Nothing is labelled on the map: a filter that is switched on makes everything of its
  // kind in the current map glow (over the object art when zoomed in); hover names it, a click opens it.
  const FILTERS = { chest: false, people: false, creature: false, way: false, item: false, sign: false };
  const markCache = new Map();               // kind + map -> the glowing spots of that kind on that map
  function loadCreatures() {
    if (creatures.length || creaturesLoading) return;
    creaturesLoading = true;
    addNpcs(window.ArcanumModuleCreatures, creatures, true);       // (the modules' maps)
    let left = 2;
    const done = () => { if (!--left) { creaturesLoading = false; creaturesLoaded(); markCache.clear(); schedule(); } };
    for (const [file, global, sub] of [['js/atlas/data/creatures.js', 'ArcanumCreatures', false], ['js/atlas/data/subcreatures.js', 'ArcanumSubCreatures', true]]) {
      const s = document.createElement('script'); s.src = file;
      s.onload = () => { addNpcs(window[global], creatures, sub); done(); };
      s.onerror = () => { creaturesLoading = false; };
      document.head.appendChild(s);
    }
  }
  // the filter buttons show the game's interface pictures (portraits.png) in place of their emoji, fitted to the button
  const FICONS = (window.ArcanumPortraits || {}).filterIcons || {};
  document.head.insertAdjacentHTML('beforeend', `<style>html .filters .ficon{background-image:url("${(window.ArcanumPortraits || {}).sheet || (window.ArcanumPortraits || {}).baseSheet || 'atlas/graphics/portraits/portraits-base.png'}")}</style>`);      // (this version's sheet)
  for (const b of document.querySelectorAll('#filters button[data-icon]')) {
    const box = FICONS[b.dataset.icon];
    if (!box) continue;
    const [x, y, w, h, inBase] = box, s = 30 / Math.max(w, h), PTS = window.ArcanumPortraits, size = inBase ? PTS.baseSize : PTS.size;      // (inBase: the picture lies in the base game's sheet)
    const i = document.createElement('span'); i.className = 'ficon';
    i.style.cssText = `${inBase ? `background-image:url("${PTS.baseSheet}");` : ''}width:${w * s}px;height:${h * s}px;background-size:${size[0] * s}px ${size[1] * s}px;background-position:-${x * s}px -${y * s}px`;
    b.replaceChildren(i);
  }
  // what is switched on is remembered between visits
  const OPT_KEY = 'atlas-map-options';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(OPT_KEY)) || {}; } catch (_) {}
  const saveOpts = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify({ filters: FILTERS, off: showOff, enc: showEnc, check: document.body.classList.contains('check') })); } catch (_) {} };
  for (const b of document.querySelectorAll('#filters button[data-f]')) {
    if (b.dataset.f in FILTERS && saved.filters && saved.filters[b.dataset.f]) { FILTERS[b.dataset.f] = true; b.classList.add('on'); if (b.dataset.f === 'creature') loadCreatures(); }
    b.onclick = () => {
      const f = b.dataset.f; FILTERS[f] = !FILTERS[f]; b.classList.toggle('on', FILTERS[f]);
      if (f === 'creature' && FILTERS[f]) loadCreatures();
      saveOpts(); schedule();
    };
  }
  // People and creatures the game keeps switched off (OF_OFF) until a script brings them in are left out unless this is on
  let showOff = !!saved.off;
  document.getElementById('offBtn').classList.toggle('on', showOff);
  document.getElementById('offBtn').onclick = e => { showOff = !showOff; e.currentTarget.classList.toggle('on', showOff); saveOpts(); schedule(); };

  // random encounters of the world map (encounters.js, toolbox/atlas/build_encounters.py; fetched when turned on): the zones where
  // the chance of an encounter is set, and a click in open country asks the page what can turn up there
  let showEnc = !!saved.enc, encMark = null;
  const loadEnc = () => { if (showEnc && !window.ArcanumEncounters) { const s = document.createElement('script'); s.src = AtlasData.url('encounters'); s.onload = schedule; document.head.appendChild(s); } };
  document.getElementById('encBtn').classList.toggle('on', showEnc); loadEnc();
  document.getElementById('encBtn').onclick = e => {
    showEnc = !showEnc; e.currentTarget.classList.toggle('on', showEnc);
    loadEnc();
    if (!showEnc) encMark = null;
    saveOpts(); schedule();
  };
  function drawEncounters(z) {
    const E = window.ArcanumEncounters;
    if (!showEnc || !E || cur >= 0) return;
    const at = (X, Y) => [view.ox + z * tileWX(X, Y), view.oy + z * tileWY(X, Y)];
    // a zone is every tile within its radius on both axes (location_dist): a diamond on the screen; small zones on top
    for (const [x, y, r, pct] of E.zones.slice().sort((a, b) => b[2] - a[2])) {
      if (!pct) continue;
      const pts = [at(x - r, y - r), at(x + r, y - r), at(x + r, y + r), at(x - r, y + r)];
      ctx.beginPath(); pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath();
      ctx.fillStyle = `rgba(214, 74, 52, ${Math.min(0.4, 0.04 + pct / 60)})`; ctx.fill();
      ctx.strokeStyle = 'rgba(255, 150, 120, .75)'; ctx.lineWidth = 1; ctx.stroke();
      const [cx, cy] = at(x, y), w = Math.abs(pts[3][0] - pts[1][0]);
      if (w > 50) {
        ctx.font = '600 13px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(pct + '%', cx + 1, cy + 1); ctx.fillStyle = '#ffe2d6'; ctx.fillText(pct + '%', cx, cy);
      }
    }
    if (encMark) {
      const [px, py] = at(encMark[0], encMark[1]);
      ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fillStyle = '#d64a34'; ctx.fill();
    }
  }

  // Areas: the named spots of the world map (areas.js, toolbox/atlas/build_areas.py). Most are places already; those that are not (and are
  // not a map of their own) become places, and the secret areas - spots no area points to - a group of their own.
  let ceOn = new URLSearchParams(location.search).has('ce');          // CE Restored or Carcanum (the version menu in the Atlas): see setCE
  // Each mod has its own data under the names the code below reads (ArcanumCE, ArcanumCEMaps...): useMod puts the chosen one there
  const MOD_KEYS = ['ArcanumCE', 'ArcanumCEMaps', 'ArcanumCEAreas', 'ArcanumCEMobs'];
  const MODS = { ce: Object.fromEntries(MOD_KEYS.map(k => [k, window[k]])), car: { ArcanumCE: window.ArcanumCarcanum, ArcanumCEMaps: window.ArcanumCarcanumMaps, ArcanumCEAreas: window.ArcanumCarcanumAreas, ArcanumCEMobs: window.ArcanumCarcanumMobs },
    fp: { ArcanumCE: window.ArcanumFP, ArcanumCEMaps: window.ArcanumFPMaps, ArcanumCEAreas: window.ArcanumFPAreas, ArcanumCEMobs: window.ArcanumFPMobs },
    ru: { ArcanumCE: window.ArcanumRU, ArcanumCEMaps: window.ArcanumRUMaps, ArcanumCEAreas: window.ArcanumRUAreas, ArcanumCEMobs: window.ArcanumRUMobs },
    tin: { ArcanumCE: window.ArcanumTIN, ArcanumCEMaps: window.ArcanumTINMaps, ArcanumCEAreas: window.ArcanumTINAreas, ArcanumCEMobs: window.ArcanumTINMobs },
    rb: { ArcanumCE: window.ArcanumRB, ArcanumCEMaps: window.ArcanumRBMaps, ArcanumCEAreas: window.ArcanumRBAreas, ArcanumCEMobs: window.ArcanumRBMobs } };
  let modVer = 'ce';
  let cmp = null;      // the Layers panel's opacities ({terrain, ce, car...}, drawing order), or null when it is off
  const FINE_CMP = 128e6 / 4 / 3;      // pixels of 1/4 or finer pictures each compared layer keeps
  function useMod(ver) { modVer = MODS[ver] ? ver : 'ce'; for (const k of MOD_KEYS) window[k] = MODS[modVer][k]; }
  // The maps only CE Restored has join the list while it is on (appended, so the other maps keep their index) and leave it when it is off
  // and so do the locations it adds to the world (ce-maps.js: named as on the map, a place each, opened on the spot where it lies)
  function syncCEMaps() {
    const CE = window.ArcanumCE, have = MP.maps.some(m => m.ce);
    const hasLocs = L.places.some(p => p.ceLoc);
    if (window.ArcanumCEMaps && hasLocs !== ceOn) {
      if (ceOn) {
        L.places.push(...window.ArcanumCEMaps.locations.filter(r => !L.places.some(p => p.name === r.name) && !(modVer === 'fp' && r.name === "Wolfe's Cave")).map(r => ({ name: r.name, modGroup: r.settlement ? 'Cities' : 'Other locations', view: r.tile, labels: [], area: true, ceLoc: true })));
        L.places.push(...(window.ArcanumCEMaps.secret || []).filter(s => !L.places.some(p => p.name === s.name)).map(s => ({ name: s.name, modGroup: 'Secret areas', view: s.tile, labels: [], area: true, ceLoc: true })));
      }
      else L.places = L.places.filter(p => !p.ceLoc);
    }
    if (!CE || have === ceOn) return;
    if (ceOn) {
      const base = MP.maps.length;
      // Forgotten Places: its caves and houses sit under the place they belong to (see atlas-app.js)
      const fp = modVer === 'fp', FPG = { Brandybuck: 'Brandybuck', CaveOfBanishment: 'The Cavern of Madness', LeahboUnderground: 'Leahbo', Plainwicke: 'Plainwicke Plantation', 'Spider Cave': 'Spider Cave', TombOfHorrors: "Acererak's Tomb" };
      const FPN = { Brandybuck: 'Brandybuck Houses', 'Spider Cave': 'Spider Cave - Inside' };
      MP.maps.push(...CE.maps.map(m => fp && FPN[m.name] ? { ...m, name: FPN[m.name] } : m));
      MP.sections.push(...CE.sections.map(s => ({ ...s, map: s.map + base, ...(fp && FPG[s.name] ? { group: FPG[s.name], ...(FPN[s.name] && { name: FPN[s.name] }) } : {}) })));
    } else {
      MP.maps.splice(MP.maps.findIndex(m => m.ce));
      for (let i = MP.sections.length - 1; i >= 0; i--) if (MP.sections[i].map >= MP.maps.length) MP.sections.splice(i, 1);
    }
    mapIndex.clear(); MP.maps.forEach((m, i) => mapIndex.set(m.key, i));
    for (const l of modLabels) {      // the labels of the mod's own maps come and go with them
      const map = mapIndex.get(l.mapKey), at = labels.indexOf(l);
      l.map = map == null ? null : map;
      if (map != null && at < 0) { l.place = MP.maps[map].name; labels.push(l); }
      else if (map == null && at >= 0) labels.splice(at, 1);
    }
  }
  syncCEMaps();
  const BASE_AR = window.ArcanumAreas || { areas: [], secret: [] };
  let AR = BASE_AR;
  const sectionNames = new Set(MP.sections.map(s => s.name));
  const QUEST_PLACES = new Set(['The Black Mountain Mines']);       // quest places the world labels do not group as such
  for (const a of BASE_AR.areas) if (!a.place && !sectionNames.has(a.name)) { L.places.push({ name: a.name, modGroup: a.settlement ? 'Cities' : QUEST_PLACES.has(a.name) ? 'Quest locations' : 'Other locations', view: a.tile, labels: [], area: true }); a.place = a.name; }
  for (const s of BASE_AR.secret) L.places.push({ name: s.name, modGroup: 'Secret areas', view: s.tile, labels: [], area: true });
  // what the names on the map are: settlements (always there), other areas, secret areas. With CE Restored on, its own list (ce-areas.js:
  // the base game's with CE's changes and additions) stands in place of the base game's
  const pinEls = new Map();
  let PINS = [];
  function buildPins() {
    const ce = ceOn && window.ArcanumCEAreas;
    AR = ce || BASE_AR;
    // (a CE location is found by where it lies: Port Ruins is four areas of one name)
    if (ce) for (const a of AR.areas) if (!a.place) { const q = L.places.find(q => q.area && (q.ceLoc ? q.view[0] === a.tile[0] && q.view[1] === a.tile[1] : q.name === a.name)); if (q) a.place = q.name; }
    PINS = [];
    const fpOut = !ceOn ? null : modVer === 'fp' ? new Set(["Wolfe's Cave", 'Center of Arcanum', 'Fan Graveyard']) : modVer === 'ce' ? new Set(['Center of Arcanum']) : null;      // (not shown in CE Restored / Forgotten Places, see atlas-app.js)
    for (const a of AR.areas) if (!fpOut?.has(a.name)) PINS.push({ name: a.name, tile: a.tile, big: a.settlement, hidden: a.hidden, place: a.place, info: { ...a, kind: a.settlement ? 'settlement' : 'area' } });
    for (const s of AR.secret) if (!fpOut?.has(s.name)) PINS.push({ name: s.name, tile: s.tile, big: false, secret: true, place: s.name, info: { ...s, kind: 'secret' } });
    const pinned = new Set(PINS.map(p => p.place || p.name));
    for (const p of L.places) if (p.view && !pinned.has(p.name) && !(ce && p.area)) PINS.push({ name: p.name, tile: p.view, big: p.modGroup === 'Cities', place: p.name });
    PINS.sort((a, b) => b.big - a.big);
    for (const el of pinEls.values()) el.remove();
    pinEls.clear();
  }
  buildPins();

  // place list
  const byGroup = {};
  for (const p of L.places) (byGroup[p.modGroup] = byGroup[p.modGroup] || []).push(p);
  const placesEl = document.getElementById('places');
  for (const g of ['Cities', 'Quest locations', 'Other locations', 'Secret areas']) {
    if (!byGroup[g]) continue;
    placesEl.insertAdjacentHTML('beforeend', `<div class="grp">${g === 'Cities' ? 'Settlements' : g}</div>`);
    for (const p of byGroup[g].sort((a, b) => a.name.localeCompare(b.name))) {
      const b = document.createElement('button');
      b.className = 'place'; b.textContent = p.name;
      b.onclick = () => goPlace(p.name);
      p.btn = b; placesEl.appendChild(b);
    }
  }
  const legend = document.getElementById('legend');
  const counts = {};
  labels.forEach(l => counts[l.placed] = (counts[l.placed] || 0) + 1);
  legend.innerHTML = Object.entries(CHECK).map(([k, [c, t]]) => `<div style="--c:${c}"><i></i>${t}<b>${counts[k] || 0}</b></div>`).join('');
  if (saved.check) { document.body.classList.add('check'); document.getElementById('checkBtn').classList.add('on'); }
  document.getElementById('checkBtn').onclick = e => { e.currentTarget.classList.toggle('on', document.body.classList.toggle('check')); saveOpts(); schedule(); };
  // The filters as one number for the page's link: a bit per filter button (FLAG_KEYS), 64 = people switched off, 128 = encounters
  const FLAG_KEYS = ['chest', 'people', 'creature', 'way', 'item', 'sign'];
  const flagBits = () => FLAG_KEYS.reduce((n, k, i) => n | (FILTERS[k] ? 1 << i : 0), 0) | (showOff ? 64 : 0) | (showEnc ? 128 : 0);
  function applyFlags(n) {
    FLAG_KEYS.forEach((k, i) => {
      FILTERS[k] = !!(n & (1 << i));
      const b = document.querySelector(`#filters button[data-f="${k}"]`); if (b) b.classList.toggle('on', FILTERS[k]);
      if (k === 'creature' && FILTERS[k]) loadCreatures();
    });
    showOff = !!(n & 64); document.getElementById('offBtn').classList.toggle('on', showOff);
    showEnc = !!(n & 128); document.getElementById('encBtn').classList.toggle('on', showEnc); loadEnc();
    if (!showEnc) encMark = null;
    markCache.clear(); saveOpts(); schedule();
  }

  // ---- view ----------------------------------------------------------------------------------------
  const canvas = document.getElementById('stage'), ctx = canvas.getContext('2d'), pinsEl = document.getElementById('pins');
  const view = { z: 0.0002, ox: 0, oy: 0 };
  let dpr = 1, cw = 0, ch = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect(); cw = r.width; ch = r.height;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    if (cw && pending) { const f = pending; pending = null; f(); }
    schedule();
  }
  // the area of the map on show, in world pixels: the whole world, or the tile box of one of the other maps
  function box() {
    if (cur < 0) return worldPictures.box;
    const [x0, y0, x1, y1] = MP.maps[cur].bbox, xs = [tileWX(x0, y0), tileWX(x1, y0), tileWX(x0, y1), tileWX(x1, y1)], ys = [tileWY(x0, y0), tileWY(x1, y0), tileWY(x0, y1), tileWY(x1, y1)];
    const b = { x0: Math.min(...xs) - 300, x1: Math.max(...xs) + 300, y0: Math.min(...ys) - 300, y1: Math.max(...ys) + 300 };
    const pb = ceOn && window.ArcanumCE?.pictures[MP.maps[cur].key] && layers.get(MP.maps[cur].key)?.box;      // CE Restored may add sectors to a module's map beyond its edge
    return pb ? { x0: Math.min(b.x0, pb.x0), x1: Math.max(b.x1, pb.x1), y0: Math.min(b.y0, pb.y0), y1: Math.max(b.y1, pb.y1) } : b;
  }
  const fitZoom = () => { const b = box(); return Math.min(cw / (b.x1 - b.x0), ch / (b.y1 - b.y0)); };
  function fit() { const b = box(); view.z = fitZoom(); view.ox = cw / 2 - view.z * (b.x0 + b.x1) / 2; view.oy = ch / 2 - view.z * (b.y0 + b.y1) / 2; schedule(); }
  // these module maps, and any map whose sector grid is over 50 x 50, may be zoomed out to 0.1 %
  const FAR_OUT = new Set(['WhiteSands - WhiteSands', 'Escape Tarant - Death']);
  const farOut = m => { const g = pictureSource(m.key)?.map; return FAR_OUT.has(m.key) || !!g && (g.gridW > 50 || g.gridH > 50); };
  const minZoom = () => cur < 0 ? fitZoom() * 0.8 : farOut(MP.maps[cur]) ? Math.min(fitZoom() * 0.5, 0.001) : fitZoom() * 0.5;
  function zoomAt(mx, my, f) { const z = Math.max(minZoom(), Math.min(cur < 0 ? 1.5 : 3, view.z * f)), k = z / view.z; view.ox = mx - (mx - view.ox) * k; view.oy = my - (my - view.oy) * k; view.z = z; schedule(); }
  // which map is on show (-1 = the world); the parent page is told so its title and list follow
  // the maps and views left behind by jumping (a door, a place of the list, a link): "Back" goes to the last one
  const backStack = [];
  function switchMap(idx, back) {
    if (idx === cur) return;
    if (!back && cw) { backStack.push({ map: cur, z: view.z, ox: view.ox, oy: view.oy }); if (backStack.length > 30) backStack.shift(); }
    cur = idx; activeLabel = activeChest = activeNpc = null;
    if (!embed) panel.innerHTML = '<p class="empty">Click a label on the map.</p>';     // (embedded, the page closes its own panel)
    document.getElementById('worldBtn').style.display = idx >= 0 && !MP.maps[idx].module ? '' : 'none';     // (a module's map has no world to go back to)
    document.getElementById('encBtn').style.display = idx >= 0 ? 'none' : '';      // encounters are a world-map thing
  }
  function centreOn(X, Y, z) {
    if (!cw) { pending = () => centreOn(X, Y, z); return; } view.z = z; view.ox = cw / 2 - z * tileWX(X, Y); view.oy = ch / 2 - z * tileWY(X, Y); schedule(); }
  let pending = null;   // a view asked for while the page was hidden (0 px wide): done once it has a size
  // The game's start tile of a map is not always on the map (it was placed loosely): then a waypoint that stands on it is where
  // the view opens.
  async function onMap(idx, start) {
    const pics = layerFor(idx);
    if (!pics || !pics.has) return start;
    await pics.ready;
    if (pics.has(start[0], start[1])) return start;
    const w = labels.find(l => l.map === idx && catsOf(l).includes('waypoint') && pics.has(l.tile[0], l.tile[1]));
    return w ? w.tile : start;
  }
  // a place of the world, or a section of one of the other maps; `tile` = arrive on that tile instead of framing the place
  function goPlace(name, tile) {
    const p = L.places.find(q => q.name === name), s = !p && MP.sections.find(q => q.name === name);
    if (!p && !s) return;
    if (!cw) { pending = () => goPlace(name, tile); return; }
    switchMap(p ? -1 : s.map);
    L.places.forEach(q => q.btn && q.btn.classList.toggle('on', q === p));
    if (tile) { centreOn(tile[0], tile[1], p ? 0.3 : 0.7); return; }
    // arrive where the game puts the player: the world map's spot of the place (its area), or the start of the map
    const area = p && AR.areas.find(a => a.place === p.name), st = area ? area.tile : s && MP.maps[s.map].start;
    if (st && s) { onMap(s.map, st).then(t => centreOn(t[0], t[1], 0.7)); return; }
    if (st) { centreOn(st[0], st[1], p ? 0.3 : 0.7); return; }
    const pts = (p || s).labels.filter(l => l.tile);
    if (pts.length > 1) {   // frame the place's labels
      const xs = pts.map(l => tileWX(...l.tile)), ys = pts.map(l => tileWY(...l.tile));
      const pad = p ? [4000, 3000] : [900, 700];
      const w = Math.max(...xs) - Math.min(...xs) + pad[0], h = Math.max(...ys) - Math.min(...ys) + pad[1];
      const z = Math.min(p ? 0.5 : 1.2, Math.min(cw / w, ch / h));
      view.z = z; view.ox = cw / 2 - z * (Math.min(...xs) + Math.max(...xs)) / 2; view.oy = ch / 2 - z * (Math.min(...ys) + Math.max(...ys)) / 2; schedule();
    } else if (s && MP.maps[s.map].module) fit();             // a module's map: all of it
    else if ((p || s).view) centreOn(...(p || s).view, p ? 0.35 : 0.7);
    else fit();
  }

  // ---- pictures ---------------------------------------------------------------------------------------
  // One picture per sector (atlas/world/, atlas/maps/, atlas/modules/; the terrain templates, atlas/terrain/, toolbox/atlas/build_map_pictures.py: tiles, walls, scenery and the game's light).
  // Drawn like this:
  //  * far and middle distance: tiles of 256 px put together from one small patch per picture, shrunk once per level
  //    with smoothing, each patch opaque over the sector's average colour inside its diamond, so neighbouring sectors
  //    meet without a seam and nothing is stretched up from a thumbnail;
  //  * close: each sector's own picture (1/16, 1/4 or full size as the zoom needs) over a diamond of its average colour.
  // The patches and tiles are made with canvas drawing only (no reading pixels back), so this works from file:// too.
  // prev: the layer of the same map from the other source (CE Restored on or off). Its decoded pictures are taken over by file name,
  // so only the sectors whose picture differs are fetched again, and it stays on screen until this one can draw.
  function makePictures(src, prev) {
    let stale = prev || null;
    const C = src.common, M = src.map;
    const IMGW = C.img.w, IMGH = C.img.h, SW = C.sector.w, HW = SW / 2, HH = C.sector.h / 2, PD = C.pad, A = C.atlas;
    const GW = M.gridW, GH = M.gridH, images = M.images, ORX = M.bounds.minX, ORY = M.bounds.minY;
    const X0 = HW * (ORY - ORX), Y0 = HH * (ORX + ORY);       // world px of the grid's first sector (absolute sector numbers)
    const LEVEL_W = { 0: IMGW, 1: IMGW / +C.levels[1], 2: IMGW / +C.levels[2] };
    const PC = C.pieces;
    let cells = null, disposed = false, LV = null, LVm = null;
    // The ground (levels 2, 1, 0.5, 0 and the tiles' 1/16 pictures) is drawn from the map's live files (LV, live-layer.js): the base game's sectors
    // from them, the sectors a version (CE Restored...) adds or changes from that version's (LVm, registry key <version>:<map>); a sector with
    // no file (and every sector far away) shows the atlas picture
    function liveLayers() {
      const L = window.ArcanumLive, mk = `${modVer}:${src.key}`;
      const wantB = L && L.has(src.key) && (!ceOn || src.old || !src.ceMap), wantM = L && ceOn && L.has(mk);      // (a map only the version has: no base layer; a map the version does not touch is the base game's: its own live files)
      if (!wantB && LV) { LV.dispose(); LV = null; }
      if (!wantM && LVm) { LVm.dispose(); LVm = null; }
      if (wantB && !LV) LV = L.create(src.key, { view, schedule });
      if (wantM && !LVm) LVm = L.create(mk, { view, schedule });
      return [LV, LVm].filter(Boolean);
    }
    // The Layers panel (atlas-layers): `cmp` = {terrain: 0..1, ce: 0..1...} in drawing order. Each layer above 0 is its own set of live files (the base game's
    // for "terrain", else registry key <version>:<map>) drawn over the one below at that opacity; at 0 it is neither loaded nor drawn.
    // "terrain" = the templates of terrain.tdf alone, in every sector of the grid (what the game generates where no .sec is: atlas/terrain/grid.json,
    // world only, drawn from the world's live files); "base" = the base game's own sectors; then the versions' own sectors. Layers of the same
    // files share one instance.
    const LVc = new Map();
    let tgrid = null, tgridP = null;
    function terrainGrid() {
      return tgridP || (tgridP = fetch(new URL('atlas/terrain/grid.json', document.baseURI)).then(r => r.json()).then(async j => {
        const raw = new Uint8Array(atob(j.g).split('').map(c => c.charCodeAt(0)));
        const buf = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
        tgrid = { w: j.w, h: j.h, t: j.t, ids: new Uint16Array(buf) }; schedule();
      }).catch(() => { tgrid = { w: 0, h: 0, t: [], ids: new Uint16Array(0) }; }));
    }
    function compareLayers() {
      const L = window.ArcanumLive, out = [], want = new Set();
      for (const [v, a] of Object.entries(cmp)) {
        const key = v === 'terrain' || v === 'base' ? src.key : `${v}:${src.key}`;
        if (!L || !(a > 0) || !L.has(key) || (v === 'terrain' && src.key !== 'World')) continue;
        if (v === 'terrain') { terrainGrid(); if (!tgrid) continue; }
        want.add(key);
        if (!LVc.has(key)) LVc.set(key, L.create(key, { view, schedule, workers: 2, fine: FINE_CMP }));
        out.push({ lv: LVc.get(key), a, terrain: v === 'terrain', mod: v !== 'terrain' && v !== 'base' });
      }
      if (out.some(e => e.mod) && L && L.has(src.key)) {      // a version's layer shows only what differs from the terrain + base game, which are loaded for that even at 0 %
        if (src.key === 'World') terrainGrid();
        want.add(src.key);
        if (!LVc.has(src.key)) LVc.set(src.key, L.create(src.key, { view, schedule, workers: 2, fine: FINE_CMP }));
        out.ref = LVc.get(src.key);
      }
      for (const [k, o] of [...LVc]) if (!want.has(k)) { o.dispose(); LVc.delete(k); }
      return out;
    }
    let cmpNow = null, cmpCv = null, cmpRef = null;
    const liveOf = i => images[i].kind !== 'sec' && images[i].kind !== 'tpl' ? null : ceOn && src.ceMap && images[i].kind === 'sec' && (!src.old || images[i].ce) ? LVm : LV;
    const ready = (async () => {      // (a mod's map of the base game's size has only the cells it changes: gridPatch over the base game's grid)
      // (the world's grid is written as its low bytes, then its high bytes: gridPlanes, build_map_pictures.write_index_files)
      const from = M.grid != null ? M : C.maps[src.key]?.grid != null ? C.maps[src.key] : null;
      const grid = from ? from.grid : (await mapGrids())[src.key];
      const s = atob(grid), bin = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
      const buf = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
      if (from?.gridPlanes) {
        const b = new Uint8Array(buf), n = b.length >> 1;
        cells = new Uint16Array(n);
        for (let i = 0; i < n; i++) cells[i] = b[i] | b[n + i] << 8;
      } else cells = new Uint16Array(buf);
      const P = M.gridPatch || [];
      for (let i = 0; i < P.length; i += 2) cells[P[i]] = P[i + 1];
      // only the world map shows terrain where a sector has no .sec; the base game's and CE Restored's other maps leave those cells empty (modules keep theirs)
      // (CE Restored's Hell Day keeps its terrain too)
      if (src.key !== 'World' && !/^atlas\/modules|\/hell-day$/.test(String(M.dir)))
        for (let i = 0; i < cells.length; i++) if (cells[i] && images[cells[i] - 1].kind === 'tpl') cells[i] = 0;
      schedule();
    })();
    // the map's extent in world px (sector rx, ry is at x = HW (ry - rx): from -(GW - 1) to GH - 1 half sectors)
    const box = { x0: X0 - HW * (GW - 1) - HW - PD.l, x1: X0 + HW * (GH - 1) + HW + PD.r, y0: Y0 - 20 - PD.t, y1: Y0 + HH * (GW + GH - 2) + C.sector.h - 20 + PD.b };
    const css = im => (im.css ??= `rgb(${im.color[0]},${im.color[1]},${im.color[2]})`);
    // a sector's average-colour diamond is drawn a hair larger (f, a fraction of its size) so neighbours overlap without a
    // seam, but only on the sides that have a neighbour; on the others a hair smaller, under the picture's own ground, as
    // its soft edge would show as a faint outline on the black.
    // Sides: top-right (rx - 1), bottom-right (ry + 1), bottom-left (rx + 1), top-left (ry - 1).
    const filled = (rx, ry) => rx >= 0 && ry >= 0 && rx < GW && ry < GH && cells[ry * GW + rx] > 0;
    const sidesAt = (rx, ry) => [filled(rx - 1, ry), filled(rx, ry + 1), filled(rx + 1, ry), filled(rx, ry - 1)];
    const ALL_SIDES = [true, true, true, true];
    let cellOf = null;                // a sector picture's cell in the grid (terrain pictures of the world are in many: all sides)
    const sidesOf = i => {
      if (images[i].sides) return images[i].sides;
      if (!cellOf) { cellOf = new Map(); for (let k = 0; k < cells.length; k++) if (cells[k] && images[cells[k] - 1].kind === 'sec') cellOf.set(cells[k] - 1, k); }
      const k = cellOf.get(i);
      return (images[i].sides = k === undefined ? ALL_SIDES : sidesAt(k % GW, Math.floor(k / GW)));
    };
    function fillDiamond(g, cx, cy, hw, hh, f, sides) {
      const [a, b, c, d] = sides.map(s => s ? f : -f);
      g.beginPath();
      g.moveTo(cx + hw * (a - d) / 2, cy - hh * (1 + (d + a) / 2));
      g.lineTo(cx + hw * (1 + (a + b) / 2), cy + hh * (b - a) / 2);
      g.lineTo(cx + hw * (b - c) / 2, cy + hh * (1 + (b + c) / 2));
      g.lineTo(cx - hw * (1 + (c + d) / 2), cy + hh * (c - d) / 2);
      g.closePath(); g.fill();
    }
    // a terrain template's pictures are shared by the maps that use it (atlas/terrain/), not in the map's own folder
    // (CE Restored: a picture flagged ce is in the CE folder, the others of the combined map in the base game's)
    // (Forgotten Places: a combined map lies over three folders, so each of its pictures names its own, d)
    const baseOf = i => images[i].kind === 'tpl' ? C.terrain + '/' : images[i].d ? images[i].d + '/' : src.old && !images[i].ce ? src.old : src.base;
    // the atlas picture (1/64 of every sector): far away, and where a sector has no live file
    let frameNo = 0, atlasImg = null;
    const atlas = new Image(); atlas.onload = () => { atlasImg = atlas; schedule(); }; atlas.src = src.atlasUrl;

    // very far: one dot per sector (each a little wider than the spacing, so no gaps), built once
    const OV_W = 4096, ovStep = OV_W / (GW + GH), ovDotW = Math.ceil(2 * ovStep) + 1, ovDotH = Math.ceil(ovStep) + 1;
    let overview = null;
    function drawOverview(z) {
      if (!overview) {
        const h = Math.ceil((GW + GH) * ovStep / 2) + 4, c = document.createElement('canvas'); c.width = OV_W; c.height = h;
        const g = c.getContext('2d'), img = g.createImageData(OV_W, h), px32 = new Uint32Array(img.data.buffer);
        // (the world has 4 million sectors: each dot is written as whole pixels, 32 bits at a time, from tables made once - RGBA
        // in memory order - and only the u that land on the grid are visited, in the same order, as dots overlap)
        const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
        const words = new Uint32Array(images.length);
        images.forEach((im, i) => { const col = im.color; if (col) words[i] = (LE ? (255 << 24 | col[2] << 16 | col[1] << 8 | col[0]) : (col[0] << 24 | col[1] << 16 | col[2] << 8 | 255)) >>> 0; });
        const offX = (ovDotW >> 1) - 1, offY = (ovDotH >> 1) - 1, XA = new Int32Array(GW + GH), XB = new Int32Array(GW + GH);   // a dot's columns, by u + GW - 1
        for (let k = 0; k < GW + GH; k++) { const X = Math.round((k + 0.5) * ovStep) - 1; XA[k] = Math.max(0, X - offX); XB[k] = Math.min(OV_W, X - offX + ovDotW); }
        for (let v = 0; v <= GW + GH - 2; v++) {
          const ua = Math.max(-(GW - 1), -v, v - 2 * (GW - 1)), ub = Math.min(GH - 1, v, 2 * (GH - 1) - v);
          const Y = Math.round((v + 0.5) * ovStep / 2) - 1, y0 = Math.max(0, Y - offY), y1 = Math.min(h, Y - offY + ovDotH);
          for (let u = ua + ((ua + v) & 1); u <= ub; u += 2) {
            const n = cells[((v + u) >> 1) * GW + ((v - u) >> 1)]; if (!n) continue;
            const word = words[n - 1], x0 = XA[u + GW - 1], x1 = XB[u + GW - 1];
            for (let yy = y0; yy < y1; yy++) for (let o = yy * OV_W + x0, e = yy * OV_W + x1; o < e; o++) px32[o] = word;
          }
        }
        g.putImageData(img, 0, 0); overview = c;
      }
      const k = ovStep / HW;
      ctx.drawImage(overview, view.ox + z * (X0 + HW * (-(GW - 1) - 0.5)), view.oy + z * (Y0 + 620), overview.width / k * z, overview.height / k * z);
    }

    // far and middle distance: tiles. Level s = a sector is s px wide; levels up to 64 are made from the atlas (1/64),
    // 128 and 256 from the 1/16 pictures (1/4 where a small map has none), loaded when a tile needs them; a map with
    // pieces only (L0, L0.5) has tiles up to 64 only, its sectors drawn one by one from there.
    const TILE = 256, TILE_LEVELS = [4, 8, 16, 32, 64, 128, 256], ATLAS_LEVELS_TO = 64, TILE_BUDGET_MS = 10;
    const TILES_BELOW_PX = 256 / 0.9, OVERVIEW_BELOW_PX = 3;
    const levels = new Map(), tiles = new Map();
    function levelOf(s) {
      let L = levels.get(s);
      if (L) return L;
      const zk = s / SW, exX = (HW + PD.l) * zk, exY = (20 + PD.t) * zk, oX = Math.ceil(exX), oY = Math.ceil(exY);
      L = { s, zk, exX, exY, oX, oY, pw: Math.ceil(IMGW * zk) + 2, ph: Math.ceil(IMGH * zk) + 2, fromL2: s > ATLAS_LEVELS_TO,
        patches: new Array(images.length).fill(null), CX: oX, CY: oY + (HH - 20) * zk, hw: HW * zk, hh: HH * zk, f: Math.max(0.75 / (HW * zk), 0.4 / (HH * zk)) };
      levels.set(s, L);
      return L;
    }
    // a picture's patch for a level: its average colour in its diamond (a hair larger, so diamonds overlap), the picture
    // shrunk over it; null while the 1/16 picture it needs is loading (it is asked for)
    // a sector's live 1/16 picture: undefined when the sector has no live file, null while it is being made
    function liveThumb(i) {
      if (!window.ArcanumLive) return undefined;
      liveLayers();
      const lv = liveOf(i);
      return lv && lv.ok(images[i].stem) ? lv.thumb(images[i].stem) : undefined;
    }
    function patchOf(L, i) {
      if (L.patches[i]) return L.patches[i];
      const im = images[i];
      let source = null, sx = 0, sy = 0, sw = 0, sh = 0;
      if (!L.fromL2) { source = atlasImg; sx = im.atlas[0] * A.w; sy = im.atlas[1] * A.h; sw = A.w; sh = A.h; }
      else {          // the sector's 1/16 picture comes from its live file; a sector with none keeps the atlas picture
        const t = liveThumb(i);
        if (t === null) return null;
        if (t) { source = t; sw = t.width; sh = t.height; }
        else { source = atlasImg; sx = im.atlas[0] * A.w; sy = im.atlas[1] * A.h; sw = A.w; sh = A.h; }
      }
      const c = document.createElement('canvas'); c.width = L.pw; c.height = L.ph;
      const g = c.getContext('2d');
      g.fillStyle = css(im);
      fillDiamond(g, L.CX, L.CY, L.hw, L.hh, L.f, sidesOf(i));
      if (source) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(source, sx, sy, sw, sh, L.oX - L.exX, L.oY - L.exY, IMGW * L.zk, IMGH * L.zk); }
      return (L.patches[i] = c);
    }
    // fn(picture, x, y) for each sector whose patch overlaps the square of N level px at (TX, TY), back to front; level px
    // are world px x zk counted from the grid's first sector; sector (u = ry - rx, v = rx + ry) has its patch's corner at
    // (u s/2 - oX, v s/4 - oY); x, y are relative to (TX, TY)
    function eachInSquare(L, TX, TY, N, fn) {
      const hs = L.s / 2, qs = L.s / 4;
      const v0 = Math.max(0, Math.ceil((TY + L.oY - L.ph + 1) / qs)), v1 = Math.min(GW + GH - 2, Math.floor((TY + N - 1 + L.oY) / qs));
      const u0 = Math.ceil((TX + L.oX - L.pw + 1) / hs), u1 = Math.floor((TX + N - 1 + L.oX) / hs);
      for (let v = v0; v <= v1; v++) {
        const ua = Math.max(u0, -v, v - 2 * (GW - 1)), ub = Math.min(u1, v, 2 * (GH - 1) - v);
        for (let u = ua + ((ua + v) & 1); u <= ub; u += 2) {
          const n = cells[((v + u) >> 1) * GW + ((v - u) >> 1)]; if (!n) continue;
          fn(n - 1, u * hs - L.oX - TX, v * qs - L.oY - TY);
        }
      }
    }
    // tiles live in slots of two big sheets (two textures to draw from, not hundreds); a 1 px apron around each tile
    // keeps smoothing from blending in the neighbouring slot
    const APRON = 1, SLOT = TILE + 2 * APRON, SHEET_SIDE = 16, PER_SHEET = SHEET_SIDE * SHEET_SIDE, SHEETS = 2, sheets = [], freeSlots = [];
    let nextSlot = 0;
    function slotAt(slot) {
      const n = Math.floor(slot / PER_SHEET), k = slot % PER_SHEET;
      if (!sheets[n]) { const c = document.createElement('canvas'); c.width = c.height = SLOT * SHEET_SIDE; sheets[n] = { c, g: c.getContext('2d') }; }
      return { sheet: sheets[n], x: (k % SHEET_SIDE) * SLOT, y: Math.floor(k / SHEET_SIDE) * SLOT };
    }
    function allocSlot() {
      if (freeSlots.length) return freeSlots.pop();
      if (nextSlot < PER_SHEET * SHEETS) return nextSlot++;
      let oldKey = null, old = null;
      for (const [key, t] of tiles) if (t.used < frameNo && (!old || t.used < old.used)) { oldKey = key; old = t; }
      if (!old) return -1;
      tiles.delete(oldKey);
      return old.slot;
    }
    // tiles are counted from the world's origin, not the grid's first sector: where they fall (and so how the pictures are
    // smoothed into them) does not depend on the map's extent
    function buildTile(L, tx, ty, slot) {
      const TX = tx * TILE - APRON - X0 * L.zk, TY = ty * TILE - APRON - Y0 * L.zk;
      let ok = true;
      eachInSquare(L, TX, TY, SLOT, i => { if (!patchOf(L, i)) ok = false; });
      if (!ok) return false;
      const at = slotAt(slot), g = at.sheet.g;
      g.save();
      g.beginPath(); g.rect(at.x, at.y, SLOT, SLOT); g.clip();
      g.fillStyle = '#000'; g.fillRect(at.x, at.y, SLOT, SLOT);
      eachInSquare(L, TX, TY, SLOT, (i, px, py) => g.drawImage(L.patches[i], at.x + px, at.y + py));
      g.restore();
      return true;
    }
    // the map from tiles; true while some are still to make
    function drawTiles(z, devPx) {
      if (!atlasImg) { drawOverview(z); return true; }
      const s = TILE_LEVELS.find(l => l >= devPx * 0.9) ?? TILE_LEVELS[TILE_LEVELS.length - 1];
      const L = levelOf(s), k = z / L.zk;                    // CSS px per level px
      const lox = view.ox, loy = view.oy;                     // screen position of the world's origin
      const tx0 = Math.floor(-lox / k / TILE), tx1 = Math.floor((cw - lox) / k / TILE), ty0 = Math.floor(-loy / k / TILE), ty1 = Math.floor((ch - loy) / k / TILE);
      const wx0 = Math.floor(box.x0 * L.zk / TILE), wx1 = Math.floor(box.x1 * L.zk / TILE);
      const wy0 = Math.floor(box.y0 * L.zk / TILE), wy1 = Math.floor(box.y1 * L.zk / TILE);
      const list = [];
      for (let ty = Math.max(ty0, wy0); ty <= Math.min(ty1, wy1); ty++) for (let tx = Math.max(tx0, wx0); tx <= Math.min(tx1, wx1); tx++) list.push([tx, ty]);
      const mx = (cw / 2 - lox) / k / TILE - 0.5, my = (ch / 2 - loy) / k / TILE - 0.5;
      list.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
      for (const [tx, ty] of list) { const t = tiles.get(`${s}:${tx}:${ty}`); if (t) t.used = frameNo; }
      const t0 = performance.now(), shown = [];
      let missing = false;
      for (const [tx, ty] of list) {
        const key = `${s}:${tx}:${ty}`;
        let t = tiles.get(key);
        if (!t && (shown.length === 0 || performance.now() - t0 < TILE_BUDGET_MS)) {
          const slot = allocSlot();
          if (slot >= 0) { if (buildTile(L, tx, ty, slot)) { t = { slot, used: frameNo }; tiles.set(key, t); } else freeSlots.push(slot); }
        }
        if (!t) missing = true;
        shown.push([tx, ty, t]);
      }
      if (missing) drawOverview(z);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const edge = n => Math.round(n * dpr);
      for (const [tx, ty, t] of shown) {
        const x0 = edge(lox + tx * TILE * k), x1 = edge(lox + (tx + 1) * TILE * k), y0 = edge(loy + ty * TILE * k), y1 = edge(loy + (ty + 1) * TILE * k);
        if (t) { const at = slotAt(t.slot); ctx.drawImage(at.sheet.c, at.x + APRON, at.y + APRON, TILE, TILE, x0, y0, x1 - x0, y1 - y0); continue; }
        for (let f = 2; L.s / f >= TILE_LEVELS[0]; f *= 2) {   // stand-in: the part of a coarser tile already made
          const pt = tiles.get(`${L.s / f}:${Math.floor(tx / f)}:${Math.floor(ty / f)}`);
          if (!pt) continue;
          const part = TILE / f, at = slotAt(pt.slot);
          pt.used = frameNo;
          ctx.drawImage(at.sheet.c, at.x + APRON + (tx - Math.floor(tx / f) * f) * part, at.y + APRON + (ty - Math.floor(ty / f) * f) * part, part, part, x0, y0, x1 - x0, y1 - y0);
          break;
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return missing;
    }

    // close: each sector drawn from its live file (live-layer.js: level 2, 1, 0.5 or 0 as the zoom needs) over a diamond of its
    // average colour (neighbouring pictures meet along soft diagonal edges, which would let the background show through as a fine grid)
    function drawSectors(z) {
      const disp = IMGW * z;
      const lvlWant = disp <= A.w * 1.25 ? 3 : disp <= LEVEL_W[2] * 1.25 ? 2 : disp <= LEVEL_W[1] * 1.25 ? 1 : PC && disp <= IMGW / PC['L0.5'][2] * 1.25 ? 0.5 : 0;
      const wx0 = -view.ox / z - X0, wx1 = (cw - view.ox) / z - X0, wy0 = -view.oy / z - Y0, wy1 = (ch - view.oy) / z - Y0, mX = HW + PD.l + 8;
      const u0 = Math.ceil((wx0 - mX) / HW), u1 = Math.floor((wx1 + mX) / HW);
      // picture v spans world y from HH v - 20 - pad.t to HH v - 20 + sector height + pad.b
      const v0 = Math.ceil((wy0 + 20 - C.sector.h - PD.b - 8) / HH), v1 = Math.floor((wy1 + 20 + PD.t + 8) / HH);
      const vis = [];
      for (let v = Math.max(0, v0); v <= Math.min(GW + GH - 2, v1); v++) for (let u = u0 + (((u0 + v) & 1) ? 1 : 0); u <= u1; u += 2) {
        const rx = (v - u) / 2, ry = (v + u) / 2; if (rx < 0 || ry < 0 || rx >= GW || ry >= GH) continue;
        const n = cells[ry * GW + rx]; if (n) vis.push([rx, ry, n - 1]);
      }
      cmpNow = lvlWant !== 3 && cmp ? compareLayers() : null;
      if (!cmp && LVc.size) { for (const o of LVc.values()) o.dispose(); LVc.clear(); }
      if (cmpNow === null && cmp) { for (const o of LVc.values()) o.dispose(); LVc.clear(); }      // (zoomed out to the overview: the layers' pictures are let go)
      const lives = cmpNow ? [...new Set([...cmpNow.map(x => x.lv), ...(cmpNow.ref ? [cmpNow.ref] : [])])] :lvlWant !== 3 ? liveLayers() : [];           // Live: the ground of the sectors that have live files comes from them (levels 2, 1, 0.5, 0)
      let rough = false;
      for (const l of lives) rough = l.begin(lvlWant) || rough;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = rough ? 'low' : 'medium';
      if (cmpNow) {          // the Layers panel: each layer over the last, at its opacity (no average-colour stand-ins: they would show through a layer set to 0)
        let tvis = null;      // every sector of the terrain grid in view, with its template's stem
        if (cmpNow.some(e => e.terrain)) {
          tvis = [];
          for (let v = Math.max(0, v0); v <= Math.min(GW + GH - 2, v1); v++) for (let u = u0 + (((u0 + v) & 1) ? 1 : 0); u <= u1; u += 2) {
            const rx = (v - u) / 2, ry = (v + u) / 2; if (rx < 0 || ry < 0 || rx >= GW || ry >= GH) continue;
            const sx = rx + ORX, sy = ry + ORY; if (sx < 0 || sy < 0 || sx >= tgrid.w || sy >= tgrid.h) continue;
            const t = tgrid.ids[sy * tgrid.w + sx]; if (t) tvis.push([rx, ry, tgrid.t[t - 1]]);
          }
        }
        // Each layer is mixed in at its slider (below + slider * (layer - below)): ground that is the same in two layers stays as it is instead of
        // doubling ('lighter' did), and darker or brighter differences both show ('lighten' hid the darker ones). Each is first drawn alone with normal blending, so the neighbours'
        // overlapping bands inside one layer do not add up along the sector seams.
        const lc = (cmpCv ||= document.createElement('canvas')), ow = ctx.canvas.width, oh = ctx.canvas.height;
        if (lc.width !== ow || lc.height !== oh) { lc.width = ow; lc.height = oh; }
        const lg = lc.getContext('2d'), tf = ctx.getTransform();
        const refStem = (rx, ry, i) => {      // the picture the terrain + base game has for this sector: its own sector file, else the terrain template
          const rl = cmpNow.ref;
          if (images[i].kind === 'sec' && rl.ok(images[i].stem)) return images[i].stem;
          if (!tgrid) return null;
          const sx = rx + ORX, sy = ry + ORY, t = sx >= 0 && sy >= 0 && sx < tgrid.w && sy < tgrid.h ? tgrid.ids[sy * tgrid.w + sx] : 0;
          return t && rl.ok(tgrid.t[t - 1]) ? tgrid.t[t - 1] : null;
        };
        let refPx = null;      // the terrain + base game's pixels of this view (made once per frame, only when a version layer is on)
        const refPixels = () => {
          if (refPx) return refPx;
          const rc = (cmpRef ||= document.createElement('canvas'));
          if (rc.width !== ow || rc.height !== oh) { rc.width = ow; rc.height = oh; }
          const rg = rc.getContext('2d', { willReadFrequently: true });
          rg.setTransform(1, 0, 0, 1, 0, 0); rg.clearRect(0, 0, ow, oh); rg.setTransform(tf);
          rg.imageSmoothingEnabled = true; rg.imageSmoothingQuality = rough ? 'low' : 'medium';
          const rl = cmpNow.ref;
          for (const [rx, ry, i] of vis) {
            const dx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), dy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t), dw = IMGW * z, dh = IMGH * z;
            if (dx > cw || dy > ch || dx + dw < 0 || dy + dh < 0) continue;
            const stem = refStem(rx, ry, i);
            if (stem) rl.draw(rg, stem, dx, dy, dw, dh, Math.hypot(dx + dw / 2 - cw / 2, dy + dh / 2 - ch / 2));
          }
          return refPx = rg.getImageData(0, 0, ow, oh).data;
        };
        for (const { lv, a, terrain, mod } of cmpNow) {
          lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, ow, oh); lg.setTransform(tf);
          lg.imageSmoothingEnabled = true; lg.imageSmoothingQuality = rough ? 'low' : 'medium';
          for (const [rx, ry, i] of terrain ? tvis : vis) {
            let stem = terrain ? i : images[i].stem, from = lv;
            if (!terrain && (images[i].kind !== 'sec' || !lv.ok(stem))) {      // a sector this version leaves alone is drawn from the terrain + base game, so the overlapping soft edges of the neighbours' pictures blend as in the reference
              if (!mod || !cmpNow.ref) continue;
              stem = refStem(rx, ry, i); from = cmpNow.ref;
            }
            const dx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), dy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t), dw = IMGW * z, dh = IMGH * z;
            if (dx > cw || dy > ch || dx + dw < 0 || dy + dh < 0 || !stem || !from.ok(stem)) continue;
            from.draw(lg, stem, dx, dy, dw, dh, Math.hypot(dx + dw / 2 - cw / 2, dy + dh / 2 - ch / 2));
          }
          if (mod && cmpNow.ref) {      // only what this version adds: the pixels equal to the terrain + base game (a version that reverts another's change) are cleared
            const rp = refPixels(); lg.setTransform(1, 0, 0, 1, 0, 0);
            const im = lg.getImageData(0, 0, ow, oh), d = im.data;
            for (let k = 0; k < d.length; k += 4) {
              if (d[k + 3] < 64) d[k + 3] = 0;      // the faint soft edge of a picture that reaches past its sector (nothing under it in the reference)
              else if (rp[k + 3] > 200 && Math.abs(d[k] - rp[k]) < 14 && Math.abs(d[k + 1] - rp[k + 1]) < 14 && Math.abs(d[k + 2] - rp[k + 2]) < 14) d[k + 3] = 0;
            }
            lg.putImageData(im, 0, 0);
          }
          ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = a; ctx.drawImage(lc, 0, 0); ctx.restore();
        }
      }
      else for (const [rx, ry, i] of vis) {
        const cx = view.ox + z * (X0 + HW * (ry - rx)), cy = view.oy + z * (Y0 + HH * (rx + ry) + HH - 20), hw = z * HW, hh = z * HH;
        if (cx + hw + 2 < 0 || cx - hw - 2 > cw || cy + hh + 2 < 0 || cy - hh - 2 > ch) continue;
        const lv = lives.length ? liveOf(i) : null;
        if (lv && lv.ok(images[i].stem) && lv.ready(images[i].stem)) continue;   // Live picture ready: its own black base is the ground, the average colour would only show as a line where its band is clear
        ctx.fillStyle = css(images[i]);
        fillDiamond(ctx, cx, cy, hw, hh, Math.max(1.5 / hw, 1 / hh), sidesAt(rx, ry));
      }
      if (!cmpNow) for (const [rx, ry, i] of vis) {
        const dx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), dy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t), dw = IMGW * z, dh = IMGH * z;
        if (dx > cw || dy > ch || dx + dw < 0 || dy + dh < 0) continue;
        const d = Math.hypot(dx + dw / 2 - cw / 2, dy + dh / 2 - ch / 2);
        const lv = lives.length ? liveOf(i) : null;
        if ((!lv || !lv.ok(images[i].stem) || !lv.draw(ctx, images[i].stem, dx, dy, dw, dh, d)) && atlasImg) ctx.drawImage(atlasImg, images[i].atlas[0] * A.w, images[i].atlas[1] * A.h, A.w, A.h, dx, dy, dw, dh);
      }
      for (const l of lives) l.end();
      if (z >= OBJECTS_FROM_Z && lives.some(l => l.hasObjects())) drawObjects(z, vis);
    }
    // people, creatures, items, containers and doors: a clear picture per sector, over the ground, only from 20% and only
    // for the sectors in view: the 1/4 picture at middle distance, close up the full-size layer's 8 x 4 pieces (the 1/4
    // picture standing in meanwhile)
    const OBJECTS_FROM_Z = 0.2;
    // The people and creatures the game keeps switched off until the story brings them in are a layer of their own (F0 / F1),
    // drawn over each sector's objects only while the 💤 button is on.
    function drawObjects(z, vis) {
      const dw = IMGW * z, dh = IMGH * z;
      const layers = showOff ? ['O', 'F'] : ['O'];
      for (const [rx, ry, i] of vis) for (const L of layers) {
        // a map whose sector files hold the objects layers (the .atlasmob files, live-layer.js) draws them from there
        if (cmpNow) {          // the Layers panel: each layer's people, containers and doors at its opacity
          const ldx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), ldy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t);
          if (ldx > cw || ldy > ch || ldx + dw < 0 || ldy + dh < 0) continue;
          for (const { lv: clv, a, terrain } of cmpNow) if (!terrain && clv.hasObjects() && clv.ok(images[i].stem) && clv.hasLayer(images[i].stem, L)) { ctx.globalAlpha = a; clv.drawLayer(ctx, images[i].stem, ldx, ldy, dw, dh, L); }
          ctx.globalAlpha = 1;
          continue;
        }
        const lv = liveOf(i);
        if (lv && lv.hasObjects()) {
          if (!lv.ok(images[i].stem) || !lv.hasLayer(images[i].stem, L)) continue;
          const ldx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), ldy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t);
          if (ldx > cw || ldy > ch || ldx + dw < 0 || ldy + dh < 0) continue;
          lv.drawLayer(ctx, images[i].stem, ldx, ldy, dw, dh, L);
          continue;
        }
      }
      // Sectors that have people or things but no .sec under them have no ground picture and are not in the grid: live_objects.py lists them in art.json ("m") and the
      // map's objects layers are drawn there by the sector's number (no ground behind them: they stand on the map's black).
      const mineX = LVm && LVm.hasObjects() ? new Set(LVm.extras().map(e => e[2])) : null;      // a version's own list of such sectors replaces the base game's for the same sector
      if (!cmpNow) for (const lv of [LV, LVm]) {
        if (!lv || !lv.hasObjects()) continue;
        for (const [sx, sy, stem] of lv.extras()) {
          if (lv === LV && mineX && mineX.has(stem)) continue;
          const rx = sx - ORX, ry = sy - ORY;
          const ldx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), ldy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t);
          if (ldx > cw || ldy > ch || ldx + dw < 0 || ldy + dh < 0) continue;
          for (const L of layers) if (lv.hasLayer(stem, L)) lv.drawLayer(ctx, stem, ldx, ldy, dw, dh, L);
        }
      }
    }

    return {
      box, ready,
      has: (tx, ty) => !!cells && filled((tx >> 6) - ORX, (ty >> 6) - ORY),      // is this tile on a sector the map has (after `ready`)
      draw(z) {
        if (stale && (!cells || !atlasImg)) { stale.draw(z); return; }       // the map it replaces, until this one has its grid and atlas
        if (stale) { stale.dispose(); stale = null; }
        if (!cells) return;
        frameNo++;
        // the map's ground is black: sectors that are only black have no picture (the world's own background, outside it, is not black)
        const gx = view.ox + z * X0, gy = view.oy + z * (Y0 - 20);
        ctx.fillStyle = '#000'; ctx.beginPath();
        ctx.moveTo(gx, gy); ctx.lineTo(gx + z * HW * GH, gy + z * HH * GH);
        ctx.lineTo(gx + z * HW * (GH - GW), gy + z * HH * (GW + GH)); ctx.lineTo(gx - z * HW * GW, gy + z * HH * GW);
        ctx.closePath(); ctx.fill();
        const sectorPx = SW * z;
        if (sectorPx < OVERVIEW_BELOW_PX) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; drawOverview(z); }
        else if (sectorPx * dpr < TILES_BELOW_PX) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; if (drawTiles(z, sectorPx * dpr)) schedule(); }
        else drawSectors(z);
      },
      dispose() { disposed = true; for (const o of LVc.values()) o.dispose(); LVc.clear(); if (LV) { LV.dispose(); LV = null; } if (LVm) { LVm.dispose(); LVm = null; } if (stale) { stale.dispose(); stale = null; } for (const s of sheets) s.c.width = 0; tiles.clear(); levels.clear(); atlas.src = ''; },
    };
  }
  // the pictures of a map (null: none yet)
  const PIC = window.ArcanumPictures;
  if (window.ArcanumLive) window.ArcanumLive.ready.then(() => schedule());      // the registry of maps that have sector files has arrived: draw them
  // the grids of the maps other than the world (map-grids.js, build_map_pictures.write_index_files): fetched the first time one opens
  let gridsP = null;
  const mapGrids = () => gridsP || (gridsP = new Promise(ok => {
    const s = document.createElement('script'); s.src = 'js/atlas/data/map-grids.js';
    s.onload = () => ok(window.ArcanumMapGrids || {}); s.onerror = () => { gridsP = null; ok({}); };
    document.head.appendChild(s);
  }));
  // CE Restored (the button in the Atlas): the maps as the improved game has them, from js/atlas/data/ce-restored.js
  function pictureSource(key) {
    const CE = ceOn && window.ArcanumCE && window.ArcanumCE.pictures[key];
    const M = CE || (PIC && PIC.maps[key]);
    if (!M) return null;
    return { key, common: PIC, map: M, ceMap: !!CE, base: M.dir + '/', old: CE && M.baseDir ? M.baseDir + '/' : null, ext: 'webp', atlasUrl: CE && M.atlasFile || M.dir + '/atlas.webp' };
  }
  // CE Restored's people and creatures (ce-mobs.js): in the sectors it has, they stand in place of the base game's
  const swapped = { npcs: [], creatures: [] };       // the base game's, taken out while CE is on
  function swapMobs(list, kind) {
    const CM = window.ArcanumCEMobs;
    if (!CM) return;
    const gone = swapped[kind], isCE = n => n.ce;
    if (!ceOn) {                                      // back to the base game's
      for (let i = list.length - 1; i >= 0; i--) if (isCE(list[i])) list.splice(i, 1);
      list.push(...gone.splice(0));
      return;
    }
    if (list.some(isCE)) return;
    const add = [];
    addNpcs({ ...CM, npcs: CM[kind] }, add);
    for (const n of add) n.ce = true;
    const inside = [];                                  // everyone in the maps only CE has (they are not in the base game's lists at all)
    addNpcs({ ...CM, npcs: CM[kind === 'npcs' ? 'subNpcs' : 'subCreatures'] || [] }, inside, true);
    for (const n of inside) n.ce = true;
    const rel = f => f.slice(f.lastIndexOf('/') + 1).toLowerCase();     // by file name: a mod may keep a file in another subfolder than the base game (Carcanum: Crash Site's people sit in the world folder's root)
    const theirs = new Set(add.map(n => rel(n.file)));       // CE only ships the .mob files it adds or changes: one with the same name replaces the base game's
    for (let i = list.length - 1; i >= 0; i--) if (list[i].map === -1 && !list[i].sub && theirs.has(rel(list[i].file))) gone.push(...list.splice(i, 1));
    list.push(...add, ...inside);
  }
  function swapAllMobs() { swapMobs(npcs, 'npcs'); if (creatures.length) swapMobs(creatures, 'creatures'); refreshChests(); markCache.clear(); }
  refreshChests();
  creaturesLoaded = () => { if (ceOn) swapMobs(creatures, 'creatures'); };

  const layers = new Map();
  let replaced = new Map();               // the layers the last CE switch took out, by map: the new one takes over from them
  function layerFor(map) {                // map: -1 = the world, else an index into MP.maps
    const key = map < 0 ? 'World' : MP.maps[map].key;
    if (!layers.has(key)) {
      const src = pictureSource(key), prev = replaced.get(key);
      replaced.delete(key);
      layers.set(key, src ? makePictures(src, prev) : null);
      if (prev && !src) prev.dispose();
    }
    return layers.get(key);
  }
  let worldPictures = layerFor(-1);
  function setCE(on, ver = modVer) {      // only what differs is fetched again: the layers swap sources and keep the pictures they share
    if (on && ceOn && ver !== modVer) setCE(false);        // from one mod to the other: leave the first (with its own data), then enter the second
    if (on === ceOn) return;
    if (on) useMod(ver);
    ceOn = on;
    if (!on && cur >= MP.maps.findIndex(m => m.ce) && MP.maps.some(m => m.ce)) { switchMap(-1); fit(); }      // the map on show was one only CE has
    syncCEMaps();
    for (const l of replaced.values()) if (l) l.dispose();
    replaced = new Map([...layers].filter(([, l]) => l));
    layers.clear(); worldPictures = layerFor(-1); if (cur >= 0) layerFor(cur);
    for (const l of replaced.values()) l.dispose();            // the maps not on show: made when next opened
    replaced = new Map();
    swapAllMobs(); buildPins(); schedule();
  }
  if (ceOn) swapAllMobs();

  // ---- drawing --------------------------------------------------------------------------------------
  let queued = false, frameNo = 0;
  // &over=1 (the Atlas changed version and shows the map it had until this one has filled in, atlas-boot.js): the page and its background are
  // transparent and the map is not painted black first, so what is not drawn yet shows the old map; 'atlas-opaque' ends it
  let over = new URLSearchParams(location.search).has('over');
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(draw); } }
  function draw() {
    queued = false; frameNo++;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (over) ctx.clearRect(0, 0, cw, ch); else { ctx.fillStyle = cur >= 0 ? '#000' : '#0e0d0c'; ctx.fillRect(0, 0, cw, ch); }
    const z = view.z;
    const pics = layerFor(cur);
    if (pics) pics.draw(z);
    drawEncounters(z);
    drawGlows(z);
    drawRoutine(z);
    document.getElementById('tip').style.display = 'none';
    drawPins(z);
    const cx = (cw / 2 - view.ox) / z, cy = (ch / 2 - view.oy) / z;
    const tx = Math.round((cy / 20 - cx / 40) / 2), ty = Math.round((cy / 20 + cx / 40) / 2);
    hud();
    if (embed) {      // tell the page where the view is (for "Share this view"), once it has settled
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => parent.postMessage({ type: 'atlas-view', view: { map: cur >= 0 ? MP.maps[cur].key : null, tile: [tx, ty], z: +view.z.toPrecision(4), f: flagBits() } }, '*'), 300);
    }
  }
  let viewTimer = 0, pointer = null;       // pointer: where the mouse is on the canvas, for the readout
  // the readout follows the pointer (the middle of the view when it is off the map); a sector is 64 x 64 tiles
  function hud() {
    const z = view.z, hx = ((pointer ? pointer[0] : cw / 2) - view.ox) / z, hy = ((pointer ? pointer[1] : ch / 2) - view.oy) / z;
    const px = Math.round((hy / 20 - hx / 40) / 2), py = Math.round((hy / 20 + hx / 40) / 2);
    document.getElementById('hud').textContent = `Sector ${Math.floor(px / 64)}, ${Math.floor(py / 64)} (${px}, ${py}) · ${z >= 0.1 ? Math.round(z * 100) : (z * 100).toPrecision(2)}%`;
  }

  // who gives a quest: the quests name the very object (its place and tile, from the same .mob / .sec files)
  const nk = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  function markGivers(givers) {
    const at = new Set(givers.map(g => nk(g.place) + '|' + g.tile.join(',')));
    for (const l of new Set([...labels, ...modLabels])) l.quest = at.has(nk(l.map == null ? l.mapKey : mapKey(l.map, l.place)) + '|' + l.tile.join(','));
    for (const n of npcs) n.quest = at.has(nk(n.place) + '|' + n.tile.join(','));
    markCache.clear(); schedule();
  }

  // ---- glows -----------------------------------------------------------------------------------------
  // Everything of a switched-on kind on the current map glows where it stands (nothing is written on the map). Whatever is
  // selected (clicked, or sent by "show on the map") is ringed even when its filter is off.
  // A person who takes you somewhere (the Tarant coachmen, Captain Teach, the ferry wheels) is one thing, the person: they glow under the
  // waypoint filter too, and their panel carries the waypoint's buttons (atlas-app.js selectNpc). Found by the .mob the waypoint hangs on.
  const fileOf = f => String(f || '').slice(String(f || '').lastIndexOf('/') + 1).toLowerCase();
  function personOf(l) {
    if (!l.to || !l.obj || !/\.mob$/i.test(l.obj[0])) return null;
    const f = fileOf(l.obj[0]);
    return npcs.find(n => n.map === l.map && fileOf(n.file) === f) || creatures.find(n => n.map === l.map && fileOf(n.file) === f) || null;
  }
  const GLOW = { chest: '#ff4d3d', people: '#6fe07a', creature: '#c586ff', way: '#4fd1ff', item: '#ffa94d', sign: '#ffe27a' };
  const KINDS = Object.keys(FILTERS);
  function marksOf(kind) {
    const key = kind + '|' + cur;
    let list = markCache.get(key);
    if (list) return list;
    list = [];
    if (kind === 'chest') {
      for (const c of chests) if (c.map === cur) list.push({ tile: c.tile, name: c.name || CONTAINER, c, open: () => selectChest(c) });
    }
    if (kind === 'people' || kind === 'creature') {
      for (const n of kind === 'people' ? npcs : creatures) if (n.map === cur) list.push({ tile: n.tile, name: n.name, n, open: () => selectNpc(n) });
    }
    if (kind === 'way' || kind === 'sign') {           // the labels: waypoints, and the signs that read something out
      // one thing that is both (a sign on the door that teleports, a person who takes you somewhere) is listed and glows under both filters, as one
      for (const l of labels) {
        const cats = catsOf(l);
        if (l.map !== cur || !(kind === 'way' ? cats.includes('waypoint') : cats.includes('information') || !cats.includes('waypoint'))) continue;
        const p = kind === 'way' ? personOf(l) : null;       // a person who teleports: the person is the thing (their panel has the buttons)
        list.push(p ? { tile: p.tile, name: p.name, n: p, open: () => selectNpc(p) } : { tile: l.tile, name: l.text, l, open: () => select(l) });
      }
    }
    if (kind === 'item' && IT) {                        // what lies on the floor (items.js)
      for (const g of IT.ground) {
        if (!g.tile || (g.world ? -1 : mapIndex.has(g.place) ? mapIndex.get(g.place) : -2) !== cur) continue;
        const it = IT.items[g.item];
        list.push({ tile: g.tile, name: it.name + (g.qty > 1 ? ' ×' + g.qty : ''), g, open: () => selectGround(g) });
      }
    }
    markCache.set(key, list);
    return list;
  }
  // Whatever holds a teleport glows the teleport's blue, under whichever filter it is drawn (a coachman under "people", a sign on a door that teleports under "signs")
  function teleSet() {
    const key = 'tele|' + cur;
    let s = markCache.get(key);
    if (!s) {
      s = new Set();
      for (const l of labels) if (l.map === cur && l.to) s.add(personOf(l) || l);           // (the person a waypoint hangs on, else the label)
      markCache.set(key, s);
    }
    return s;
  }
  const isTele = m => m.l ? catsOf(m.l).includes('waypoint') : m.n ? teleSet().has(m.n) : false;
  const isActive = m => (m.c && m.c === activeChest) || (m.l && m.l === activeLabel) || (m.g && m.g === activeLabel) || (m.n && m.n === activeNpc);
  // The glow is a halo: faint in the middle so the figure stays readable, brightest just around its outline, then fading out.
  // One sprite per colour, stretched into an upright oval around the figure.
  const glowSprites = new Map(), GS = 128;
  function glowSprite(color) {
    let c = glowSprites.get(color);
    if (c) return c;
    c = document.createElement('canvas'); c.width = c.height = GS;
    const r = GS / 2, g = c.getContext('2d'), grad = g.createRadialGradient(r, r, 0, r, r, r), [R, G, B] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    grad.addColorStop(0, `rgba(${R},${G},${B},.1)`); grad.addColorStop(0.45, `rgba(${R},${G},${B},.22)`); grad.addColorStop(0.68, `rgba(${R},${G},${B},.6)`);
    grad.addColorStop(0.82, `rgba(${R},${G},${B},.28)`); grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
    g.fillStyle = grad; g.fillRect(0, 0, GS, GS);
    glowSprites.set(color, c);
    return c;
  }
  // Zoomed in, the halo takes the shape of the thing's own art (glow-shapes.js: its outline, widened and blurred, white on
  // clear sheets); the oval above is for what has no art of its own, and while a sheet is loading.
  // (CE Restored's own, ce-glows.js, go first while it is on: its people stand where the base game's did not)
  const tinted = new Map(), SHAPES_FROM_Z = 0.2;   // the objects' art shows from 20 %
  // Only glow-shards.js (the map of the shards, 11 kB) is fetched the first time a glow is drawn zoomed in, not with the page: the oval
  // stands in until the shards of the place are there
  let glowsAsked = false;
  function loadGlows() {
    if (glowsAsked) return;
    glowsAsked = true;
    const s = document.createElement('script');
    s.src = 'js/atlas/data/glow-shards.js';
    s.onload = s.onerror = () => { const S = window.ArcanumGlowShards; if (S) { GLOWS.scale = S.scale; GLOWS.margin = S.margin; } glowGen++; schedule(); };
    document.head.appendChild(s);
  }
  // A glow is one picture: the halo at the left, the art's outline at its right. Each object has its own:
  // at[map]["X,Y"][kind] = [[hash, dx, dy, object], ...], the object being what the rows know it by
  // (a .mob's lower-case file name, or p<prototype> for an object of a .sec); a mod's set lists only what it changes.
  // Both the index and the pictures come in shards (glow-shards.js, toolbox/atlas/build_glow_shards.py): one file holds what a part of one
  // map needs (the base game's part, or the mod's own), so a place is fetched when a glow on it is first drawn, and the common shard
  // (the figures seen everywhere) once.
  const GLOWS = { shapes: {}, scale: 0, margin: 0 };           // picture -> [w, h, mask w, mask h]; how the halos are drawn
  const AT = {};                                            // part (b, ce, ...) -> map -> "X,Y" -> kind -> [[picture, dx, dy, object], ...]
  const poolImgs = new Map(), shardsAsked = new Set(), shardsDone = new Set();
  let glowGen = 0;                                          // (counts the shards that have arrived: what was not found may be there now)
  function poolImage(D, hash) {
    const im = poolImgs.get(hash);
    return im && im.ready ? im : null;
  }
  async function loadShard(name, part, S) {
    try {
      const buf = await (await fetch(`${S.dir}/${name}.bin`)).arrayBuffer(), n = new DataView(buf).getUint32(4, true);
      const head = JSON.parse(await new Response(new Blob([new Uint8Array(buf, 8, n)]).stream().pipeThrough(new DecompressionStream('deflate'))).text()), at = 8 + n;
      for (const [map, t] of Object.entries(head.at)) Object.assign((AT[part] = AT[part] || {})[map] = AT[part][map] || {}, t);
      await Promise.all(Object.entries(head.p).map(async ([h, [o, l, w, ht, mw, mh]]) => {
        GLOWS.shapes[h] = [w, ht, mw, mh];
        if (poolImgs.has(h)) return;
        const bm = await createImageBitmap(new Blob([new Uint8Array(buf, at + o, l)], { type: 'image/webp' }));
        bm.ready = true; poolImgs.set(h, bm);
      }));
    } catch (e) { console.warn('glow shard', name, e); }
    shardsDone.add(name); glowGen++; schedule();
  }
  // the shards of the place a tile is on (the cut tree of its map): asked for if not yet, true once the index of them is there
  function glowPlace(key, tile, part) {
    const S = window.ArcanumGlowShards, tree = S && S.maps[key];
    if (tree == null) return true;                          // (a map with no glows)
    let n = tree;
    while (typeof n !== 'number') n = (n[0] ? tile[0] + tile[1] : tile[0] - tile[1]) < n[1] ? n[2] : n[3];
    const cell = S.cells[n];
    let ready = true;
    for (const [name, p] of [[S.common, null], [cell.b, 'b'], [part && cell[part], part]]) {
      if (!name) continue;
      if (!shardsAsked.has(name)) { shardsAsked.add(name); loadShard(name, p, S); }
      if (p && !shardsDone.has(name)) ready = false;
    }
    return ready;
  }
  const fileName = f => (f || '').slice((f || '').lastIndexOf('/') + 1).toLowerCase();
  function oidOf(m) {
    if (m.l && m.l.obj) return /\.mob$/i.test(m.l.obj[0]) ? fileName(m.l.obj[0]) : 'p' + m.l.obj[2];
    const f = m.n ? m.n.file : m.c ? m.c.file : m.g ? m.g.file : null;
    return f ? fileName(f) : null;
  }
  function shapeOf(m, kind) {
    if (!window.ArcanumGlowShards) { loadGlows(); return null; }
    const key = cur >= 0 ? MP.maps[cur].key : 'World', part = ceOn ? modVer : null;
    // (asked for every mark at every frame: the answer is kept on the mark until the map, the version or the shards change)
    const was = m.shapeFor;
    if (was && was[0] === key && was[1] === glowGen && was[2] === part && was[3] === kind) return was[4];
    if (!glowPlace(key, m.tile, part)) return null;         // (the oval stands in until the place's index is there)
    const found = findShape(m, kind, key, part);
    m.shapeFor = [key, glowGen, part, kind, found];
    return found;
  }
  function findShape(m, kind, key, part) {
    const xy = m.tile[0] + ',' + m.tile[1], oid = oidOf(m);
    // only the thing itself glows: people, containers, items on the floor, signs, waypoints
    const g = m.n ? 'n' : m.c ? 'c' : m.g ? 'i' : kind === 'people' || kind === 'creature' ? 'n' : kind === 'chest' ? 'c' : kind === 'item' ? 'i' : kind === 'way' ? 'w' : 's';
    const D = GLOWS, sets = (part ? [part, 'b'] : ['b']).map(p => AT[p]);          // (the mod on now first)
    const lists = sets.map(at => [D, at && at[key] && at[key][xy] && at[key][xy][g]]).filter(([, l]) => l && l.length);
    const title = g === 's' && m.l ? m.l.text : null;                          // (a sign's glow knows what the notice is called: two boards of one prototype on a tile)
    for (const [D, l] of lists) {                                                // the entry of this very object, the mod's first
      const s = (title && (l.find(e => e[4] === title && e[3] === oid) || l.find(e => e[4] === title))) || (oid && l.find(e => e[3] === oid));
      if (s) return { s, D };
    }
    return lists.length ? { s: lists[0][1][0], D: lists[0][0] } : null;         // (an object the rows cannot name: whatever stands on the tile)
  }
  function tintedShape(hash, color, D) {
    const key = hash + color;
    let c = tinted.get(key);
    if (c) return c;
    const im = poolImage(D, hash);
    if (!im) return null;
    const [w, h] = D.shapes[hash];
    if (tinted.size > 2000) tinted.clear();
    c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0, w, h, 0, 0, w, h); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, w, h);
    tinted.set(key, c);
    return c;
  }  // What is selected stands in front of its glow: its art is lifted out of the map as drawn (through its outline, masks-*.webp
  // of glow-shapes.js) before the glows go on, and put back over them.
  const lifted = document.createElement('canvas');
  function liftFigure(h, z) {
    const D = h.D, [hw, , w, hh] = D.shapes[h.mask], x = hw, y = 0, sheet = poolImage(D, h.mask);      // (the outline sits right of the halo in the same picture)
    if (!sheet) return null;
    const X = h.tx + (h.dx + D.margin) * z, Y = h.ty + (h.dy + D.margin) * z, W = Math.max(1, Math.round(w * z * dpr)), H = Math.max(1, Math.round(hh * z * dpr));
    lifted.width = W; lifted.height = H;
    const g = lifted.getContext('2d');
    g.drawImage(sheet, x, y, w, hh, 0, 0, W, H);
    g.globalCompositeOperation = 'source-in'; g.drawImage(canvas, X * dpr, Y * dpr, W, H, 0, 0, W, H);
    return { x: X, y: Y, w: W / dpr, h: H / dpr };
  }
  let hits = [];
  // A filter fades in and out over about a second: FADE[kind] runs between 0 (off) and 1 (on); frames go on until it has arrived.
  const FADE = Object.fromEntries(KINDS.map(k => [k, FILTERS[k] ? 1 : 0])), FADE_MS = 900;
  let fadeAt = 0;
  function drawGlows(z) {
    hits = [];
    const nowMs = performance.now(), dtMs = fadeAt ? Math.min(100, nowMs - fadeAt) : 0;
    let fading = false;
    for (const k of KINDS) {
      const t = FILTERS[k] ? 1 : 0;
      if (FADE[k] !== t) { FADE[k] = t > FADE[k] ? Math.min(1, FADE[k] + dtMs / FADE_MS) : Math.max(0, FADE[k] - dtMs / FADE_MS); fading = true; }
    }
    fadeAt = fading ? nowMs : 0;
    if (fading) schedule();
    if (!(z >= 0.025 || cur >= 0)) return;
    const anyActive = activeLabel || activeChest || activeNpc, check = document.body.classList.contains('check');
    // Zoomed out (no object art on the map) a mark is a dot on its tile; zoomed in, a glow around the thing. A figure stands
    // about 110 px tall on its 80 x 40 tile at full size: the oval (for what has no glow shape) is centred on its middle.
    const glows = z >= SHAPES_FROM_Z, rx = 52 * z, ry = 78 * z, lift = 48 * z, tw = 40 * z, th = 20 * z;
    for (const kind of KINDS) {
      const fa = FADE[kind] * FADE[kind] * (3 - 2 * FADE[kind]);                   // eased
      if (fa <= 0 && !anyActive) continue;
      for (const m of marksOf(kind)) {
        const active = isActive(m);
        if (fa <= 0 && !active) continue;
        const faint = !!(m.n && m.n.off);                                        // not there yet: only with the 💤 button (or selected)
        if (faint && !showOff && !active) continue;
        const tx = view.ox + z * tileWX(...m.tile), ty = view.oy + z * tileWY(...m.tile), color = isTele(m) ? GLOW.way : GLOW[kind];
        if (!glows) {
          if (tx < -10 || ty < -10 || tx > cw + 10 || ty > ch + 10) continue;
          hits.push({ x: tx, y: ty, rx: 6, ry: 6, tx, ty, tw, th, m, active, faint, color, a: active ? 1 : fa, dot: true });
          continue;
        }
        const far = 600 * z;                                                     // (a glow reaches this far from its tile; the shard of a place is fetched only when it is in view)
        if (!active && (tx < -far || ty < -far || tx > cw + far || ty > ch + far)) continue;
        const found = shapeOf(m, kind);
        if (found) {                                                           // the halo of its art: [shape, dx, dy, mask] from the tile's centre
          const s = found.s, D = found.D, [w, h] = D.shapes[s[0]], sw = w * D.scale * z, sh = h * D.scale * z, x0 = tx + s[1] * z, y0 = ty + s[2] * z;
          if (x0 > cw || y0 > ch || x0 + sw < 0 || y0 + sh < 0) continue;
          hits.push({ x: x0 + sw / 2, y: y0 + sh / 2, rx: sw * 0.4, ry: sh * 0.4, x0, y0, sw, sh, D, shape: s[0], dx: s[1], dy: s[2], mask: s[0], tx, ty, tw, th, m, active, faint, color, a: active ? 1 : fa });
          continue;
        }
        const x = tx, y = ty - lift;
        if (x < -rx || y < -ry || x > cw + rx || y > ch + ry) continue;
        hits.push({ x, y, rx, ry, tx, ty, tw, th, m, active, faint, color, a: active ? 1 : fa });
      }
    }
    if (glows) {
      // (someone switched off is not drawn on the map unless 💤 is on: nothing to lift then)
      const sel = hits.find(h => h.active && h.mask != null && (!h.faint || showOff)), fig = sel && liftFigure(sel, z);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';                                  // the glow adds light to the art under it
      for (const h of hits) {
        const t = h.shape != null && tintedShape(h.shape, h.color, h.D);
        ctx.globalAlpha = (h.faint && !h.active ? 0.45 : 1) * h.a;
        for (let k = h.active ? 2 : 1; k--;) {                                   // what is selected glows twice as bright
          if (t) ctx.drawImage(t, h.x0, h.y0, h.sw, h.sh);
          else ctx.drawImage(glowSprite(h.color), h.x - h.rx, h.y - h.ry, 2 * h.rx, 2 * h.ry);
        }
      }
      ctx.restore();
      if (fig) ctx.drawImage(lifted, fig.x, fig.y, fig.w, fig.h);
    }
    // the dots (zoomed out; what is selected a bigger one), and the rings of the check view
    for (const h of hits) {
      if (h.dot) {
        ctx.beginPath(); ctx.arc(h.tx, h.ty, h.active ? 5.5 : 3, 0, Math.PI * 2); ctx.globalAlpha = (h.faint && !h.active ? 0.5 : 1) * h.a;
        ctx.fillStyle = h.color; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
      }
      if ((h.m.n && h.m.n.quest) || (h.m.l && h.m.l.quest)) {             // who starts a quest: a "!" over their head, whatever their glow
        const px = h.dot ? h.tx + 8 : h.shape != null ? h.x0 + h.sw * 0.5 : h.x, py = h.dot ? h.ty - 7 : h.shape != null ? h.y0 : h.y - h.ry * 0.8;
        ctx.save(); ctx.globalAlpha = (h.faint && !h.active ? 0.5 : 1) * h.a;
        ctx.font = `bold ${h.dot ? 13 : Math.max(14, Math.min(26, 30 * z + 8))}px Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(20,14,6,.9)'; ctx.strokeText('!', px, py);
        ctx.fillStyle = '#ffd23d'; ctx.fillText('!', px, py); ctx.restore();
      }
      if (check && h.m.l) {
        ctx.beginPath();
        if (h.dot) ctx.arc(h.tx, h.ty, 7, 0, Math.PI * 2); else ctx.ellipse(h.x, h.y, h.rx * 1.15, h.ry * 1.15, 0, 0, Math.PI * 2);
        ctx.globalAlpha = h.a; ctx.strokeStyle = (CHECK[h.m.l.placed] || ['#6b5a3f'])[0]; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }
  // ---- the routine of the selected person (routines.js, toolbox/atlas/build_routines.py) ----------------------------------------
  // Footprints walk the way they go, a step at a time: a patrol is a loop of gold prints (round and back to the start); a
  // person who sleeps elsewhere has blue prints to where they spend the night and violet ones back to where they spend the day.
  // The game finds its own way between the tiles; the prints run straight from one to the next.
  const RT = window.ArcanumRoutines && window.ArcanumRoutines.routines, STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ROUTE = { patrol: '#ffd479', toNight: '#79b8ff', toDay: '#c79bff' };
  const sxy = (t, z) => [view.ox + z * tileWX(t[0], t[1]), view.oy + z * tileWY(t[0], t[1])];
  function footprints(pts, closed, color, z, lane) {
    const P = pts.map(t => sxy(t, z)), seg = [];
    if (closed) P.push(P[0]);
    const stride = Math.max(24, 56 * z), size = stride * 0.34, side = stride * 0.2;
    const head = STILL ? -1 : performance.now() / 150;
    let acc = 0;                                            // the length of the segments before this one
    for (let i = 0; i + 1 < P.length; i++) seg.push(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]));
    const total = seg.reduce((a, b) => a + b, 0), count = Math.max(1, Math.floor(total / stride));
    for (let i = 0; i + 1 < P.length; i++) {
      const [x0, y0] = P[i], [x1, y1] = P[i + 1], len = seg[i], before = acc;
      acc += len;
      if (len < 1) continue;
      const ux = (x1 - x0) / len, uy = (y1 - y0) / len, ang = Math.atan2(uy, ux);
      for (let k = Math.ceil(before / stride); k * stride < acc; k++) {           // the k-th print of the whole way
        const d = k * stride - before;
        const foot = k % 2 ? 1 : -1, off = side * foot + (lane || 0) * stride * 0.5;
        const px = x0 + ux * d - uy * off, py = y0 + uy * d + ux * off;
        if (px < -20 || py < -20 || px > cw + 20 || py > ch + 20) continue;
        const age = head < 0 ? 0 : (((head - k) % (count + 10)) + count + 10) % (count + 10);       // a bright step travels along the prints
        ctx.globalAlpha = age < 10 ? 1 - age * 0.06 : 0.4;
        ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
        ctx.fillStyle = color; ctx.strokeStyle = 'rgba(20,14,6,.85)'; ctx.lineWidth = Math.max(1, size * 0.18);
        ctx.beginPath(); ctx.ellipse(size * 0.4, 0, size * 0.8, size * 0.34, 0, 0, Math.PI * 2); ctx.stroke(); ctx.fill();      // the sole
        ctx.beginPath(); ctx.ellipse(-size * 0.7, 0, size * 0.27, size * 0.22, 0, 0, Math.PI * 2); ctx.stroke(); ctx.fill();      // the heel
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }
  function routeMark(t, z, glyph) {
    const [x, y] = sxy(t, z), r = glyph ? 11 : 4;
    if (x < -20 || y < -20 || x > cw + 20 || y > ch + 20) return;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(20,14,6,.9)'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffd479'; ctx.stroke();
    if (glyph) { ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(glyph, x, y + 1); }
  }
  function drawRoutine(z) {
    const n = activeNpc, r = n && RT && n.file && RT[n.file];
    if (!r || n.map !== cur) return;
    ctx.save();
    if (r.w) footprints(r.w, true, ROUTE.patrol, z);
    if (r.d && r.n && !(r.w && r.pd && r.pn)) {
      // a patrol takes the place of one of the two spots: the prints then join the other spot to the loop
      let a = r.d, b = r.n;
      const near = p => r.w.reduce((best, t) => Math.hypot(t[0] - p[0], t[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1]) ? t : best);
      if (r.w && r.pd) a = near(r.n);
      else if (r.w && r.pn) b = near(r.d);
      footprints([a, b], false, ROUTE.toNight, z, 1);
      footprints([b, a], false, ROUTE.toDay, z, 1);
      if (!(r.w && r.pd)) routeMark(r.d, z, '☀');
      if (!(r.w && r.pn)) routeMark(r.n, z, '☾');
    }
    ctx.restore();
    if (!STILL) schedule();
  }
  function hitAt(e) {          // on the figure's halo or on its tile
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bd = 1e9;
    for (const h of hits) {
      const ex = (px - h.x) / Math.max(10, h.rx * 0.8), ey = (py - h.y) / Math.max(10, h.ry * 0.8), d = Math.hypot(ex, ey);
      const onTile = Math.abs(px - h.tx) / Math.max(h.tw, 1) + Math.abs(py - h.ty) / Math.max(h.th, 1) <= 1;
      if ((d <= 1 || onTile) && d < bd) { best = h; bd = d; }
    }
    return best;
  }
  const tip = document.getElementById('tip');
  function hover(e) {
    const h = !drag && hitAt(e);
    canvas.style.cursor = h ? 'pointer' : '';
    if (h) { tip.textContent = h.m.name; tip.style.left = h.x + 'px'; tip.style.top = (h.y - h.ry * 0.8 - 4) + 'px'; tip.style.display = 'block'; }
    else tip.style.display = 'none';
  }

  // place names when far
  let activeLabel = null;
  // Settlements are always named; every other area from 0.05 %, a name giving way when it would sit on one already placed
  const PIN_FROM_Z = 0.0005;
  function pinGo(p) {
    if (p.place && L.places.some(q => q.name === p.place)) goPlace(p.place);
    else { switchMap(-1); L.places.forEach(q => q.btn && q.btn.classList.remove('on')); centreOn(p.tile[0], p.tile[1], 0.35); }
    if (p.info && embed) parent.postMessage({ type: 'atlas-area', area: p.info }, '*');
  }
  function drawPins(z) {
    const close = z >= 0.025 || cur >= 0;
    const seen = new Set(), taken = [];
    if (!close && FILTERS.sign) {      // the names of the locations belong to the information filter
      for (const p of PINS) {
        if (!p.big && z < PIN_FROM_Z) continue;
        const x = view.ox + z * tileWX(...p.tile), y = view.oy + z * tileWY(...p.tile);
        if (x < -100 || y < -30 || x > cw + 100 || y > ch + 30) continue;
        const w = p.name.length * (p.big ? 8 : 6.4) + 8, h = p.big ? 18 : 14;
        if (!p.big && taken.some(t => Math.abs(t[0] - x) < (t[2] + w) / 2 && Math.abs(t[1] - y) < (t[3] + h) / 2)) continue;
        taken.push([x, y, w, h]);
        let el = pinEls.get(p.name);
        if (!el) {
          el = document.createElement('div'); el.className = 'placename' + (p.big ? '' : ' small') + (p.secret ? ' secret' : p.hidden ? ' hidden' : ''); el.textContent = p.name;
          el.onclick = () => pinGo(p); el.onpointerdown = e => e.stopPropagation();
          pinEls.set(p.name, el); pinsEl.appendChild(el);
        }
        el.style.left = x + 'px'; el.style.top = y + 'px'; seen.add(el);
      }
    }
    for (const el of pinEls.values()) el.style.display = seen.has(el) ? '' : 'none';
  }

  // ---- details --------------------------------------------------------------------------------------
  const panel = document.getElementById('panel');
  const itemList = list => list.map(([i, q]) => `<div><span>${IT.items[i].name}</span><span>${q > 1 ? '×' + q : ''}</span></div>`).join('');
  function selectChest(c) {
    activeChest = c; activeLabel = null; activeNpc = null; schedule();
    if (embed) { parent.postMessage({ type: 'atlas-container', index: c.i }, '*'); return; }
    const src = c.source && IT.sources[c.source];
    panel.innerHTML = `<h2>📦 ${esc(c.name || CONTAINER)}</h2><div class="meta">${esc(c.place)}${c.locked != null ? ` · locked (${c.locked})` : ''}</div>
      ${c.items.length ? `<h3>Contains</h3><div class="items">${itemList(c.items)}</div>` : ''}
      ${src ? `<h3>Random: ${esc(src.name)}</h3><div class="items">${src.items.map(([i, r]) => `<div><span>${esc(IT.items[i].name)}</span><span>${r}%</span></div>`).join('')}</div>` : ''}
      ${!c.items.length && !src ? '<p class="empty">Empty.</p>' : ''}
      <div class="chk">tile: ${c.tile.join(', ')}</div>`;
  }
  function selectNpc(n) {
    activeNpc = n; activeLabel = null; activeChest = null; schedule();
    if (embed) { parent.postMessage({ type: 'atlas-npc', npc: n }, '*'); return; }
    panel.innerHTML = `<h2>${esc(n.name)}</h2>
      <div class="meta">${esc([n.race, n.gender === 0 ? '♀' : n.gender === 1 ? '♂' : '', n.kind ? n.kindName : '', n.level ? 'level ' + n.level : ''].filter(Boolean).join(' · '))}</div>
      <div class="meta">${esc(n.place)}${n.shop ? ' · sells goods' : ''}</div>`;
  }
  function selectGround(g) {
    activeLabel = g; activeChest = null; activeNpc = null; schedule();
    if (embed) { parent.postMessage({ type: 'atlas-item', item: g.item }, '*'); return; }
    panel.innerHTML = `<h2>${esc(IT.items[g.item].name)}</h2><div class="meta">${esc(g.place)}${g.qty > 1 ? ' · ×' + g.qty : ''}</div>`;
  }
  function select(l) {
    activeLabel = l; activeChest = null; activeNpc = null; schedule();
    if (embed) { parent.postMessage({ type: 'atlas-label', label: l }, '*'); return; }
    panel.innerHTML = `<h2>${esc(l.text)}</h2>
      <div class="meta">${esc(catsOf(l).map(c => (ICON[c] || '') + ' ' + c).join(' · '))} — ${esc(l.place)}</div>
      ${l.description ? `<h3>About</h3><div class="desc">${l.description}</div>` : ''}
      ${l.to ? `<h3>Waypoint</h3><div>🚪 to ${esc(l.to.map(t => t.label || t.place).join(', '))}</div>` : ''}
      ${l.lock ? `<div>🔒 Locked${l.lock.locked ? ` · difficulty ${l.lock.locked}` : ''}</div>` : ''}
      <div class="chk">placed: ${l.placed}<br>tile: ${l.tile.join(', ')}<br>${l.object ? 'object: ' + l.object + '<br>' : ''}${l.screenshot ? 'screenshot px: ' + l.screenshot.join(', ') : ''}</div>`;
  }
  function unselect() {
    if (activeLabel || activeChest || activeNpc) { activeLabel = activeChest = activeNpc = null; schedule(); }
    if (embed) parent.postMessage({ type: 'atlas-blank' }, '*');
    else panel.innerHTML = '<p class="empty">Click a label on the map.</p>';
  }
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'atlas-unselect') { activeLabel = activeChest = activeNpc = null; schedule(); }   // its panel was closed
    if (e.data && e.data.type === 'atlas-opaque') { over = false; document.documentElement.classList.remove('over'); document.body.classList.remove('over'); schedule(); }
    if (e.data && e.data.type === 'atlas-layers') { cmp = e.data.on ? e.data.a : null; schedule(); }
    if (e.data && e.data.type === 'atlas-ce') setCE(!!e.data.on, e.data.ver);
    if (e.data && e.data.type === 'atlas-go') {
      goPlace(e.data.place, e.data.tile);
      if (embed) requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage({ type: 'atlas-ack' }, '*')));      // (drawn: the page may show the map)
    }
    if (e.data && e.data.type === 'atlas-travel') {           // through a waypoint: arrive on that tile of that map
      const i = e.data.map == null ? -1 : mapIndex.get(e.data.map);
      if (i == null) return;
      switchMap(i);
      if (e.data.start && i >= 0) onMap(i, e.data.tile).then(t => centreOn(t[0], t[1], 0.7));      // a map opened at its start tile
      else centreOn(e.data.tile[0], e.data.tile[1], i < 0 ? 0.3 : 0.7);
    }
    if (e.data && e.data.type === 'atlas-pick') {             // a shared link: the label that was open on that tile of this map
      const l = labels.find(q => q.map === cur && q.tile[0] === e.data.tile[0] && q.tile[1] === e.data.tile[1]);
      if (l) select(l);
    }
    if (e.data && e.data.type === 'atlas-setview') {          // a shared link: this map, this spot, this zoom, these filters
      if (e.data.f != null) applyFlags(e.data.f);
      const i = e.data.map == null ? -1 : mapIndex.get(e.data.map);
      switchMap(i == null ? -1 : i);
      centreOn(e.data.tile[0], e.data.tile[1], Math.max(0.0005, Math.min(3, +e.data.z || 0.3)));
      // arrived: the page stops asking (or it would undo the next zoom), and shows the map: said once this view has been drawn
      if (cw && embed) requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage({ type: 'atlas-ack' }, '*')));
    }
    if (e.data && e.data.type === 'atlas-quests') markGivers(e.data.givers || []);   // who starts a quest gets a "!"
    if (e.data && e.data.type === 'atlas-check') { document.body.classList.toggle('check', !!e.data.on); schedule(); }
    if (e.data && e.data.type === 'atlas-focus' && e.data.tile) {      // "show on the map" from the item pages
      const ch0 = chests.find(c => c.i === e.data.container);
      let m = -1;                       // the map the thing is on: a container knows it, else the page names it (items.js / quests naming)
      if (ch0) m = ch0.map; else if (e.data.map != null) { const i = mapIndex.get(e.data.map); m = i == null ? -1 : i; }
      switchMap(m);
      activeChest = ch0 || null; activeLabel = null; activeNpc = null;
      if (e.data.name) {      // someone or something from a quest: light up whoever stands on that very tile
        const t = e.data.tile.join(',');
        activeNpc = npcs.concat(creatures).find(n => n.map === cur && n.tile.join(',') === t) || null;
        if (!activeNpc) activeLabel = labels.find(l => l.map === cur && l.tile.join(',') === t) || null;
      }
      centreOn(e.data.tile[0], e.data.tile[1], 0.3);
    }
  });

  // ---- input ----------------------------------------------------------------------------------------
  let drag = null;
  // the drag moves the view by the pointer's step (not from where it started), so a zoom in the middle of a drag, or a
  // lost button release, can never throw the map back to a stale offset
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag'); });
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect(); pointer = [e.clientX - r.left, e.clientY - r.top];
    if (!drag) { hover(e); hud(); return; }
    if (!e.buttons) { end(); return; }
    drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    view.ox += e.clientX - drag.x; view.oy += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; schedule(); });
  const end = () => { drag = null; canvas.classList.remove('drag'); };
  canvas.addEventListener('pointerleave', () => { pointer = null; hud(); });
  canvas.addEventListener('pointerup', e => {
    const click = drag && drag.moved < 5, h = click ? hitAt(e) : null;        // a click on something that glows opens it
    if (h) { end(); h.m.open(); return; }
    if (click) unselect();                                      // a click on nothing in particular closes what was open
    // a click (not a drag) in open country while the encounters are shown: what can turn up on that spot
    if (drag && drag.moved < 5 && showEnc && cur < 0 && window.ArcanumEncounters) {
      const r = canvas.getBoundingClientRect(), wx = (e.clientX - r.left - view.ox) / view.z, wy = (e.clientY - r.top - view.oy) / view.z;
      encMark = [Math.round((wy / 20 - wx / 40) / 2), Math.round((wy / 20 + wx / 40) / 2)];
      if (embed) parent.postMessage({ type: 'atlas-encounter', tile: encMark }, '*');
      schedule();
    }
    end();
  });
  canvas.addEventListener('pointercancel', end);
  canvas.parentElement.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.15 : 0.00525))); }, { passive: false });
  document.getElementById('worldBtn').onclick = () => {
    const b = backStack.pop() || { map: -1 };       // exactly where I was before the jump (no history: the whole world)
    switchMap(b.map, true);
    if (b.z) { view.z = b.z; view.ox = b.ox; view.oy = b.oy; schedule(); } else fit();
    if (!embed) return;
    if (b.map < 0) parent.postMessage({ type: 'atlas-map', map: null }, '*');
    else { const s = MP.sections.find(q => q.map === b.map); if (s) parent.postMessage({ type: 'atlas-map', map: MP.maps[b.map].key, place: s.name }, '*'); }
  };
  window.addEventListener('resize', resize);
  resize();
  const start = new URLSearchParams(location.search).get('place') || 'Shrouded Hills';
  goPlace(start);
  if (embed) parent.postMessage({ type: 'atlas-ready' }, '*');
})();
