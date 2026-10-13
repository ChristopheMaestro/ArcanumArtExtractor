// The map of world-atlas.html (embedded by index.html with ?embed=1): sector pictures from atlas/maps/ (listed in
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
  for (const [key, area, x, y, title, text, obj] of (window.ArcanumNotices ? window.ArcanumNotices.notices : [])) {
    const map = key == null ? -1 : mapIndex.get(key);
    if (map == null) continue;
    labels.push({ text: title, category: 'information', tile: [x, y], place: map >= 0 ? MP.maps[map].name : area, map, mapKey: map >= 0 ? key : area,
      description: text === title ? '' : esc(text).replace(/\n/g, '<br>'), placed: 'script', obj });      // a sign that only gives its name has nothing more to show
  }
  for (const [key, area, x, y, what, to, obj] of (window.ArcanumWaypoints ? window.ArcanumWaypoints.waypoints : [])) {
    const map = key == null ? -1 : mapIndex.get(key);
    if (map == null) continue;
    const names = [...new Set(to.map(t => t[1]))];
    labels.push({ text: names.join(' / '), category: 'waypoint', tile: [x, y], place: map >= 0 ? MP.maps[map].name : area, map, mapKey: map >= 0 ? key : area,
      what, to: to.map(([m, place, tx, ty]) => ({ map: m, place, tile: [tx, ty] })), placed: 'script', obj });
  }
  const mapKey = (map, place) => map >= 0 ? MP.maps[map].key : place;     // how items.js names the map a thing is on

  // People and containers come from the game files alone, one per object on its own tile (npcs.js, submaps.js, items.js);
  // the labels left are waypoints, notes, altars and quest objects, and never stand for a person or a container.
  // containers of the world map and of the other maps (items.js), every one just a "Container" on the map (the real kind -
  // barrel, bin, wood chest... - is not shown)
  const IT = window.ArcanumItems;
  const chests0 = IT ? IT.containers.map((c, i) => ({ ...c, i, map: c.world ? -1 : (mapIndex.has(c.place) ? mapIndex.get(c.place) : -2) })).filter(c => c.map > -2 && c.tile) : [];
  // A trap door is a container (its lock) and a waypoint (the script that takes you down) on one tile: one display, the
  // waypoint, which says it is locked and how hard the lock is. (An empty trap door with no waypoint stays a container.)
  const doorWays = labels.filter(l => l.category === 'waypoint');
  const chests = chests0.filter(c => {
    if (c.name !== 'Trap Door' || c.items.length || c.source) return true;
    const w = doorWays.find(l => l.map === c.map && !l.lock && Math.abs(l.tile[0] - c.tile[0]) <= 2 && Math.abs(l.tile[1] - c.tile[1]) <= 2);
    if (!w) return true;
    w.lock = { locked: c.locked, keys: c.keys, held: c.held, jammed: c.jammed };
    w.text += ' 🔒';
    return false;
  });
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
  let creaturesLoading = false, activeNpc = null;
  // The filter buttons under the map. Nothing is labelled on the map: a filter that is switched on makes everything of its
  // kind in the current map glow (over the object art when zoomed in); hover names it, a click opens it.
  const FILTERS = { chest: false, people: false, creature: false, way: false, item: false, sign: false };
  const markCache = new Map();               // kind + map -> the glowing spots of that kind on that map
  function loadCreatures() {
    if (creatures.length || creaturesLoading) return;
    creaturesLoading = true;
    addNpcs(window.ArcanumModuleCreatures, creatures, true);       // (the modules' maps)
    let left = 2;
    const done = () => { if (!--left) { creaturesLoading = false; markCache.clear(); schedule(); } };
    for (const [file, global, sub] of [['js/atlas/data/creatures.js', 'ArcanumCreatures', false], ['js/atlas/data/subcreatures.js', 'ArcanumSubCreatures', true]]) {
      const s = document.createElement('script'); s.src = file;
      s.onload = () => { addNpcs(window[global], creatures, sub); done(); };
      s.onerror = () => { creaturesLoading = false; };
      document.head.appendChild(s);
    }
  }
  // the filter buttons show the game's interface pictures (portraits.png) in place of their emoji, fitted to the button
  const FICONS = (window.ArcanumPortraits || {}).filterIcons || {};
  for (const b of document.querySelectorAll('#filters button[data-icon]')) {
    const box = FICONS[b.dataset.icon];
    if (!box) continue;
    const [x, y, w, h] = box, s = 30 / Math.max(w, h), size = window.ArcanumPortraits.size;
    const i = document.createElement('span'); i.className = 'ficon';
    i.style.cssText = `width:${w * s}px;height:${h * s}px;background-size:${size[0] * s}px ${size[1] * s}px;background-position:-${x * s}px -${y * s}px`;
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
  const loadEnc = () => { if (showEnc && !window.ArcanumEncounters) { const s = document.createElement('script'); s.src = 'js/atlas/data/encounters.js'; s.onload = schedule; document.head.appendChild(s); } };
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
  const AR = window.ArcanumAreas || { areas: [], secret: [] };
  const sectionNames = new Set(MP.sections.map(s => s.name));
  const QUEST_PLACES = new Set(['The Black Mountain Mines']);       // quest places the world labels do not group as such
  for (const a of AR.areas) if (!a.place && !sectionNames.has(a.name)) { L.places.push({ name: a.name, modGroup: a.settlement ? 'Cities' : QUEST_PLACES.has(a.name) ? 'Quest locations' : 'Other locations', view: a.tile, labels: [], area: true }); a.place = a.name; }
  for (const s of AR.secret) L.places.push({ name: s.name, modGroup: 'Secret areas', view: s.tile, labels: [], area: true });
  // what the names on the map are: settlements (always there), other areas, secret areas
  const PINS = [];
  for (const a of AR.areas) PINS.push({ name: a.name, tile: a.tile, big: a.settlement, hidden: a.hidden, place: a.place, info: { ...a, kind: a.settlement ? 'settlement' : 'area' } });
  for (const s of AR.secret) PINS.push({ name: s.name, tile: s.tile, big: false, secret: true, place: s.name, info: { ...s, kind: 'secret' } });
  const pinned = new Set(PINS.map(p => p.place || p.name));
  for (const p of L.places) if (p.view && !pinned.has(p.name)) PINS.push({ name: p.name, tile: p.view, big: p.modGroup === 'Cities', place: p.name });
  PINS.sort((a, b) => b.big - a.big);

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
    return { x0: Math.min(...xs) - 300, x1: Math.max(...xs) + 300, y0: Math.min(...ys) - 300, y1: Math.max(...ys) + 300 };
  }
  const fitZoom = () => { const b = box(); return Math.min(cw / (b.x1 - b.x0), ch / (b.y1 - b.y0)); };
  function fit() { const b = box(); view.z = fitZoom(); view.ox = cw / 2 - view.z * (b.x0 + b.x1) / 2; view.oy = ch / 2 - view.z * (b.y0 + b.y1) / 2; schedule(); }
  function zoomAt(mx, my, f) { const z = Math.max(fitZoom() * (cur < 0 ? 0.8 : 0.5), Math.min(cur < 0 ? 1.5 : 3, view.z * f)), k = z / view.z; view.ox = mx - (mx - view.ox) * k; view.oy = my - (my - view.oy) * k; view.z = z; schedule(); }
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
  // One picture per sector (atlas/maps/, toolbox/atlas/build_map_pictures.py: tiles, walls, scenery and the game's light).
  // Drawn like this:
  //  * far and middle distance: tiles of 256 px put together from one small patch per picture, shrunk once per level
  //    with smoothing, each patch opaque over the sector's average colour inside its diamond, so neighbouring sectors
  //    meet without a seam and nothing is stretched up from a thumbnail;
  //  * close: each sector's own picture (1/16, 1/4 or full size as the zoom needs) over a diamond of its average colour.
  // The patches and tiles are made with canvas drawing only (no reading pixels back), so this works from file:// too.
  function makePictures(src) {
    const C = src.common, M = src.map;
    const IMGW = C.img.w, IMGH = C.img.h, SW = C.sector.w, HW = SW / 2, HH = C.sector.h / 2, PD = C.pad, A = C.atlas;
    const GW = M.gridW, GH = M.gridH, images = M.images, ORX = M.bounds.minX, ORY = M.bounds.minY;
    const X0 = HW * (ORY - ORX), Y0 = HH * (ORX + ORY);       // world px of the grid's first sector (absolute sector numbers)
    const LEVEL_W = { 0: IMGW, 1: IMGW / +C.levels[1], 2: IMGW / +C.levels[2] };
    let cells = null, disposed = false;
    const ready = (async () => {
      const bin = Uint8Array.from(atob(M.grid), c => c.charCodeAt(0));
      cells = new Uint16Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
      schedule();
    })();
    // the map's extent in world px
    const box = { x0: X0 + HW * -(GH - 1) - HW - PD.l, x1: X0 + HW * (GW - 1) + HW + PD.r, y0: Y0 - 20 - PD.t, y1: Y0 + HH * (GW + GH - 2) + C.sector.h - 20 + PD.b };
    const css = im => (im.css ??= `rgb(${im.color[0]},${im.color[1]},${im.color[2]})`);
    const urlOf = (lvl, i) => `${src.base}L${lvl}/${images[i].stem}.${src.ext}`;

    // pictures: the atlas always; L2 / L1 / L0 on demand under a memory budget
    const BUDGET = 600 * 1024 * 1024, cache = new Map(), failed = new Set(), wanted = [];
    let active = 0, frameNo = 0, atlasImg = null, cacheBytes = 0;
    const atlas = new Image(); atlas.onload = () => { atlasImg = atlas; schedule(); }; atlas.src = src.atlasUrl;
    function request(lvl, i) {
      const key = lvl + '/' + i; if (cache.has(key) || failed.has(key) || disposed) return;
      const e = { img: new Image(), ready: false, bytes: LEVEL_W[lvl] * (LEVEL_W[lvl] * IMGH / IMGW) * 4, used: frameNo };
      cache.set(key, e); active++;
      const finish = ok => {
        active--; e.ready = ok;
        if (e.ready) cacheBytes += e.bytes; else { cache.delete(key); failed.add(key); }
        evict(); pump(); schedule();
      };
      e.img.src = urlOf(lvl, i);
      e.img.decode().then(() => finish(true), () => finish(false));      // decoded off the main thread, so drawing it later does not stall the page
    }
    function pump() { while (active < 6 && wanted.length) { const w = wanted.shift(); request(w[0], w[1]); } }
    function evict() {
      if (cacheBytes <= BUDGET) return;
      for (const [key, e] of [...cache.entries()].filter(([, e]) => e.ready && e.used < frameNo).sort((a, b) => a[1].used - b[1].used)) {
        if (cacheBytes <= BUDGET * 0.8) break; cache.delete(key); cacheBytes -= e.bytes; e.img.src = '';
      }
    }
    const bestReady = i => { for (const lvl of [0, 1, 2]) { const e = cache.get(lvl + '/' + i); if (e && e.ready) { e.used = frameNo; return e.img; } } return null; };

    // very far: one dot per sector (each a little wider than the spacing, so no gaps), built once
    const OV_W = 4096, ovStep = OV_W / (GW + GH), ovDotW = Math.ceil(2 * ovStep) + 1, ovDotH = Math.ceil(ovStep) + 1;
    let overview = null;
    function drawOverview(z) {
      if (!overview) {
        const h = Math.ceil((GW + GH) * ovStep / 2) + 4, c = document.createElement('canvas'); c.width = OV_W; c.height = h;
        const g = c.getContext('2d'), img = g.createImageData(OV_W, h), px = img.data;
        for (let v = 0; v <= GW + GH - 2; v++) for (let u = -(GH - 1); u <= GW - 1; u++) {
          if ((u + v) & 1) continue;
          const rx = (v - u) / 2, ry = (v + u) / 2; if (rx < 0 || ry < 0 || rx >= GW || ry >= GH) continue;
          const n = cells[ry * GW + rx]; if (!n) continue;
          const col = images[n - 1].color, X = Math.round((u + GH - 1 + 0.5) * ovStep) - 1, Y = Math.round((v + 0.5) * ovStep / 2) - 1;
          for (let dy = 0; dy < ovDotH; dy++) for (let dx = 0; dx < ovDotW; dx++) {
            const xx = X + dx - (ovDotW >> 1) + 1, yy = Y + dy - (ovDotH >> 1) + 1; if (xx < 0 || xx >= OV_W || yy < 0 || yy >= h) continue;
            const o = (yy * OV_W + xx) * 4; px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0); overview = c;
      }
      const k = ovStep / HW;
      ctx.drawImage(overview, view.ox + z * (X0 + HW * (-(GH - 1) - 0.5)), view.oy + z * (Y0 + 620), overview.width / k * z, overview.height / k * z);
    }

    // far and middle distance: tiles. Level s = a sector is s px wide; levels up to 64 are made from the atlas (1/64),
    // 128 and 256 from the 1/16 pictures, loaded when a tile needs them.
    const TILE = 256, TILE_LEVELS = [4, 8, 16, 32, 64, 128, 256], ATLAS_LEVELS_TO = 64, TILE_BUDGET_MS = 10;
    const TILES_BELOW_PX = 256 / 0.9, OVERVIEW_BELOW_PX = 3;
    const levels = new Map(), tiles = new Map();
    function levelOf(s) {
      let L = levels.get(s);
      if (L) return L;
      const zk = s / SW, exX = (HW + PD.l) * zk, exY = (20 + PD.t) * zk, oX = Math.ceil(exX), oY = Math.ceil(exY);
      L = { s, zk, exX, exY, oX, oY, pw: Math.ceil(IMGW * zk) + 2, ph: Math.ceil(IMGH * zk) + 2, fromL2: s > ATLAS_LEVELS_TO,
        patches: new Array(images.length).fill(null), CX: oX, CY: oY + (HH - 20) * zk, hw: HW * zk + 0.75, hh: HH * zk + 0.4 };
      levels.set(s, L);
      return L;
    }
    // a picture's patch for a level: its average colour in its diamond (a hair larger, so diamonds overlap), the picture
    // shrunk over it; null while the 1/16 picture it needs is loading (it is asked for)
    function patchOf(L, i) {
      if (L.patches[i]) return L.patches[i];
      const im = images[i];
      let source = null, sx = 0, sy = 0, sw = 0, sh = 0;
      if (!L.fromL2) { source = atlasImg; sx = im.atlas[0] * A.w; sy = im.atlas[1] * A.h; sw = A.w; sh = A.h; }
      else if (!failed.has('2/' + i)) {
        const e = cache.get('2/' + i);
        if (!e) { wanted.push([2, i]); return null; }
        if (!e.ready) return null;
        e.used = frameNo; source = e.img; sw = e.img.naturalWidth; sh = e.img.naturalHeight;
      }
      const c = document.createElement('canvas'); c.width = L.pw; c.height = L.ph;
      const g = c.getContext('2d');
      g.fillStyle = css(im);
      g.beginPath(); g.moveTo(L.CX, L.CY - L.hh); g.lineTo(L.CX + L.hw, L.CY); g.lineTo(L.CX, L.CY + L.hh); g.lineTo(L.CX - L.hw, L.CY); g.closePath(); g.fill();
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
    function buildTile(L, tx, ty, slot) {
      const TX = tx * TILE - APRON, TY = ty * TILE - APRON;
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
      const lox = view.ox + z * X0, loy = view.oy + z * Y0;   // screen position of the grid's origin
      const tx0 = Math.floor(-lox / k / TILE), tx1 = Math.floor((cw - lox) / k / TILE), ty0 = Math.floor(-loy / k / TILE), ty1 = Math.floor((ch - loy) / k / TILE);
      const wx0 = Math.floor((box.x0 - X0) * L.zk / TILE), wx1 = Math.floor((box.x1 - X0) * L.zk / TILE);
      const wy0 = Math.floor((box.y0 - Y0) * L.zk / TILE), wy1 = Math.floor((box.y1 - Y0) * L.zk / TILE);
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
      pump();
      return missing;
    }

    // close: each sector's picture over a diamond of its average colour (neighbouring pictures meet along soft
    // diagonal edges, which would let the background show through as a fine grid)
    // Close up the pictures are in pieces (C.pieces: full size in 8 x 4, half size in 4 x 2, only those not empty): only the
    // pieces on screen are fetched and decoded, and the 1/4 picture stands in meanwhile. A whole full-size picture is 66 MB
    // once decoded: a few of those froze the page for seconds.
    function drawSectors(z) {
      const disp = IMGW * z, lvl = disp <= A.w * 1.25 ? 3 : disp <= LEVEL_W[2] * 1.25 ? 2 : disp <= LEVEL_W[1] * 1.25 ? 1 : PC && disp <= IMGW / PC.H[2] * 1.25 ? 'H' : 0;
      const wx0 = -view.ox / z - X0, wx1 = (cw - view.ox) / z - X0, wy0 = -view.oy / z - Y0, wy1 = (ch - view.oy) / z - Y0, mX = HW + PD.l + 8;
      const u0 = Math.ceil((wx0 - mX) / HW), u1 = Math.floor((wx1 + mX) / HW);
      // picture v spans world y from HH v - 20 - pad.t to HH v - 20 + sector height + pad.b
      const v0 = Math.ceil((wy0 + 20 - C.sector.h - PD.b - 8) / HH), v1 = Math.floor((wy1 + 20 + PD.t + 8) / HH);
      const vis = [];
      for (let v = Math.max(0, v0); v <= Math.min(GW + GH - 2, v1); v++) for (let u = u0 + (((u0 + v) & 1) ? 1 : 0); u <= u1; u += 2) {
        const rx = (v - u) / 2, ry = (v + u) / 2; if (rx < 0 || ry < 0 || rx >= GW || ry >= GH) continue;
        const n = cells[ry * GW + rx]; if (n) vis.push([rx, ry, n - 1]);
      }
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'medium';
      for (const [rx, ry, i] of vis) {
        const cx = view.ox + z * (X0 + HW * (ry - rx)), cy = view.oy + z * (Y0 + HH * (rx + ry) + HH - 20), hw = z * HW + 1.5, hh = z * HH + 1;
        if (cx + hw < 0 || cx - hw > cw || cy + hh < 0 || cy - hh > ch) continue;
        ctx.fillStyle = css(images[i]);
        ctx.beginPath(); ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy); ctx.closePath(); ctx.fill();
      }
      const need = [];
      for (const [rx, ry, i] of vis) {
        const dx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), dy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t), dw = IMGW * z, dh = IMGH * z;
        if (dx > cw || dy > ch || dx + dw < 0 || dy + dh < 0) continue;
        const d = Math.hypot(dx + dw / 2 - cw / 2, dy + dh / 2 - ch / 2);
        if ((lvl === 0 || lvl === 'H') && PC && images[i].p) { drawPieces(lvl === 0 ? 'L0' : 'H', i, dx, dy, z, d, need); continue; }
        let shown = null;
        if (lvl !== 3) {
          const l = lvl === 'H' ? 0 : lvl, e = cache.get(l + '/' + i);      // a picture not in pieces: whole
          if (e && e.ready) { e.used = frameNo; shown = e.img; }
          else { shown = bestReady(i); if (!e) need.push([l, i, d]); }
        }
        if (shown) ctx.drawImage(shown, dx, dy, dw, dh);
        else if (atlasImg) ctx.drawImage(atlasImg, images[i].atlas[0] * A.w, images[i].atlas[1] * A.h, A.w, A.h, dx, dy, dw, dh);
      }
      need.sort((a, b) => a[2] - b[2]); for (const n of need.slice(0, 60)) wanted.push([n[0], n[1]]);
      pump();
      if (z >= OBJECTS_FROM_Z && (objMask.size || offMask.size)) drawObjects(z, vis);
      piecePump();
    }
    function drawPieces(name, i, dx, dy, z, d, need) {
      const [cols, rows, f] = PC[name], mask = images[i].p[name === 'L0' ? 0 : 1] >>> 0, pw = IMGW / cols, ph = IMGH / rows, stem = images[i].stem;
      if (!cache.has('1/' + i) && !failed.has('1/' + i)) need.push([1, i, d]);
      const stand = bestReady(i), k = stand ? stand.naturalWidth / IMGW : 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (!(mask >>> (r * cols + c) & 1)) continue;
        const x0 = Math.round(dx + c * pw * z), x1 = Math.round(dx + (c + 1) * pw * z), y0 = Math.round(dy + r * ph * z), y1 = Math.round(dy + (r + 1) * ph * z);
        if (x0 > cw || y0 > ch || x1 < 0 || y1 < 0) continue;
        const t = pieceNeed(`${name}/${i}/${c}/${r}`, `${src.base}${name}/${stem}_${c}_${r}.${src.ext}`, pw / f * ph / f * 4,Math.hypot((x0 + x1) / 2 - cw / 2, (y0 + y1) / 2 - ch / 2));
        if (t) ctx.drawImage(t.img, x0, y0, x1 - x0, y1 - y0);
        else if (stand) ctx.drawImage(stand, c * pw * k, r * ph * k, pw * k, ph * k, x0, y0, x1 - x0, y1 - y0);
        else if (atlasImg) ctx.drawImage(atlasImg, images[i].atlas[0] * A.w + c * A.w / cols, images[i].atlas[1] * A.h + r * A.h / rows, A.w / cols, A.h / rows, x0, y0, x1 - x0, y1 - y0);
      }
    }

    // pieces (ground and objects) and the 1/4 objects pictures: only those on screen are fetched, a few at a time, the ground
    // before the objects and nearest the centre first, each decoded off the main thread before it is first drawn; the
    // oldest dropped under a budget
    const PC = C.pieces, P_BUDGET = 400 * 1024 * 1024, pcache = new Map(), OBJECTS_LATER = 1e5;
    let pBytes = 0, pActive = 0;
    function pieceNeed(key, url, bytes, d) {
      let e = pcache.get(key);
      if (!e) { if (disposed) return null; e = { key, url, img: null, state: 'queued', bytes, used: frameNo, d }; pcache.set(key, e); }
      e.used = frameNo; e.d = d;
      return e.state === 'ready' ? e : null;
    }
    function piecePump() {
      while (pActive < 6) {
        let best = null;
        for (const e of pcache.values()) if (e.state === 'queued' && e.used >= frameNo - 1 && (!best || e.d < best.d)) best = e;
        if (!best) break;
        const e = best; e.state = 'loading'; e.img = new Image(); e.img.src = e.url; pActive++;
        const done = ok => {
          pActive--;
          if (ok && !disposed) { e.state = 'ready'; pBytes += e.bytes; evictPieces(); } else { e.state = 'failed'; e.img = null; }
          piecePump(); schedule();
        };
        e.img.decode().then(() => done(true), () => done(false));
      }
      for (const [k, e] of pcache) if (e.state === 'queued' && e.used < frameNo - 1) pcache.delete(k);   // asked for, then scrolled away
    }
    function evictPieces() {
      if (pBytes <= P_BUDGET) return;
      for (const e of [...pcache.values()].filter(e => e.state === 'ready' && e.used < frameNo).sort((a, b) => a.used - b.used)) {
        if (pBytes <= P_BUDGET * 0.8) break; pcache.delete(e.key); pBytes -= e.bytes; e.img = null;
      }
    }

    // people, creatures, items, containers and doors: a clear picture per sector, over the ground, only from 20% and only
    // for the sectors in view: the 1/4 picture at middle distance, close up the full-size layer's 8 x 4 pieces (the 1/4
    // picture standing in meanwhile)
    const OBJECTS_FROM_Z = 0.2, OBJ_COLS = 8, OBJ_ROWS = 4, TW = IMGW / OBJ_COLS, TH = IMGH / OBJ_ROWS;
    // The people and creatures the game keeps switched off until the story brings them in are a layer of their own (F0 / F1),
    // drawn over each sector's objects only while the 💤 button is on.
    const objMask = new Map((M.objects || []).map((i, k) => [i, (M.objectMasks || [])[k] >>> 0]));
    const offMask = new Map((M.offObjects || []).map((i, k) => [i, (M.offObjectMasks || [])[k] >>> 0]));
    function drawObjects(z, vis) {
      const lvl = IMGW * z <= LEVEL_W[1] * 1.25 ? 1 : 0, w1 = LEVEL_W[1], h1 = w1 * IMGH / IMGW;
      const dw = IMGW * z, dh = IMGH * z;
      const layers = showOff ? [[objMask, 'O'], [offMask, 'F']] : [[objMask, 'O']];
      for (const [rx, ry, i] of vis) for (const [masks, L] of layers) {
        if (!masks.has(i)) continue;
        const dx = view.ox + z * (X0 + HW * (ry - rx) - HW - PD.l), dy = view.oy + z * (Y0 + HH * (rx + ry) - 20 - PD.t);
        if (dx > cw || dy > ch || dx + dw < 0 || dy + dh < 0) continue;
        const d = Math.hypot(dx + dw / 2 - cw / 2, dy + dh / 2 - ch / 2), stem = images[i].stem;
        const small = pieceNeed(L + '1/' + i, `${src.base}${L}1/${stem}.${src.ext}`, w1 * h1 * 4, d + OBJECTS_LATER);
        if (lvl) { if (small) ctx.drawImage(small.img, dx, dy, dw, dh); continue; }
        const mask = masks.get(i);
        for (let r = 0; r < OBJ_ROWS; r++) for (let c = 0; c < OBJ_COLS; c++) {
          if (!(mask >>> (r * OBJ_COLS + c) & 1)) continue;
          const x0 = Math.round(dx + c * TW * z), x1 = Math.round(dx + (c + 1) * TW * z), y0 = Math.round(dy + r * TH * z), y1 = Math.round(dy + (r + 1) * TH * z);
          if (x0 > cw || y0 > ch || x1 < 0 || y1 < 0) continue;
          const t = pieceNeed(`${L}0/${i}/${c}/${r}`, `${src.base}${L}0/${stem}_${c}_${r}.${src.ext}`, TW * TH * 4, OBJECTS_LATER + Math.hypot((x0 + x1) / 2 - cw / 2, (y0 + y1) / 2 - ch / 2));
          if (t) ctx.drawImage(t.img, x0, y0, x1 - x0, y1 - y0);
          else if (small) ctx.drawImage(small.img, c * TW / 4, r * TH / 4, TW / 4, TH / 4, x0, y0, x1 - x0, y1 - y0);   // the quarter-size picture meanwhile
        }
      }
    }

    return {
      box, ready,
      draw(z) {
        if (!cells) return;
        frameNo++; wanted.length = 0;
        const sectorPx = SW * z;
        if (sectorPx < OVERVIEW_BELOW_PX) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; drawOverview(z); }
        else if (sectorPx * dpr < TILES_BELOW_PX) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; if (drawTiles(z, sectorPx * dpr)) schedule(); }
        else drawSectors(z);
      },
      dispose() { disposed = true; for (const e of cache.values()) e.img.src = ''; cache.clear(); pcache.clear(); for (const s of sheets) s.c.width = 0; tiles.clear(); levels.clear(); atlas.src = ''; },
    };
  }
  // the pictures of a map (null: none yet)
  const PIC = window.ArcanumPictures;
  function pictureSource(key) {
    const M = PIC && PIC.maps[key];
    return M ? { common: PIC, map: M, base: M.dir + '/', ext: 'webp', atlasUrl: M.dir + '/atlas.webp' } : null;
  }
  const layers = new Map();
  function layerFor(map) {                // map: -1 = the world, else an index into MP.maps
    const key = map < 0 ? 'World' : MP.maps[map].key;
    if (!layers.has(key)) {
      const src = pictureSource(key);
      layers.set(key, src ? makePictures(src) : null);
    }
    return layers.get(key);
  }
  const worldPictures = layerFor(-1);

  // ---- drawing --------------------------------------------------------------------------------------
  let queued = false, frameNo = 0;
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(draw); } }
  function draw() {
    queued = false; frameNo++;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = cur >= 0 ? '#000' : '#0e0d0c'; ctx.fillRect(0, 0, cw, ch);
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
    document.getElementById('hud').textContent = `tile ${tx}, ${ty} · ${z >= 0.1 ? Math.round(z * 100) : (z * 100).toPrecision(2)}%`;
    if (embed) {      // tell the page where the view is (for "Share this view"), once it has settled
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => parent.postMessage({ type: 'atlas-view', view: { map: cur >= 0 ? MP.maps[cur].key : null, tile: [tx, ty], z: +view.z.toPrecision(4) } }, '*'), 300);
    }
  }
  let viewTimer = 0;

  // who gives a quest: the quests name the very object (its place and tile, from the same .mob / .sec files)
  const nk = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  function markGivers(givers) {
    const at = new Set(givers.map(g => nk(g.place) + '|' + g.tile.join(',')));
    for (const l of labels) l.quest = at.has(nk(mapKey(l.map, l.place)) + '|' + l.tile.join(','));
    for (const n of npcs) n.quest = at.has(nk(n.place) + '|' + n.tile.join(','));
    markCache.clear(); schedule();
  }

  // ---- glows -----------------------------------------------------------------------------------------
  // Everything of a switched-on kind on the current map glows where it stands (nothing is written on the map). Whatever is
  // selected (clicked, or sent by "show on the map") is ringed even when its filter is off.
  const GLOW = { chest: '#ff4d3d', people: '#6fe07a', creature: '#c586ff', way: '#4fd1ff', item: '#ffa94d', sign: '#ffe27a' };
  const KINDS = Object.keys(FILTERS);
  function marksOf(kind) {
    const key = kind + '|' + cur;
    let list = markCache.get(key);
    if (list) return list;
    list = [];
    if (kind === 'chest') {
      for (const c of chests) if (c.map === cur) list.push({ tile: c.tile, name: CONTAINER, c, open: () => selectChest(c) });
    }
    if (kind === 'people' || kind === 'creature') {
      for (const n of kind === 'people' ? npcs : creatures) if (n.map === cur) list.push({ tile: n.tile, name: n.name, n, open: () => selectNpc(n) });
    }
    if (kind === 'way' || kind === 'sign') {           // the labels: waypoints, and the signs that read something out
      for (const l of labels) if (l.map === cur && (catsOf(l).includes('waypoint') ? 'way' : 'sign') === kind) list.push({ tile: l.tile, name: l.text, l, open: () => select(l) });
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
  const GD = window.ArcanumGlows, glowSheets = [], tinted = new Map(), SHAPES_FROM_Z = 0.2;   // the objects' art shows from 20 %
  function shapeOf(m, kind) {
    const all = GD && GD.at[cur >= 0 ? MP.maps[cur].key : 'World'], t = all && all[m.tile[0] + ',' + m.tile[1]];
    if (!t) return null;
    // only the thing itself glows: people, containers, items on the floor, signs, waypoints
    return t[m.n ? 'n' : m.c ? 'c' : m.g ? 'i' : kind === 'people' || kind === 'creature' ? 'n' : kind === 'chest' ? 'c' : kind === 'item' ? 'i' : kind === 'way' ? 'w' : 's'] || null;
  }
  function tintedShape(id, color) {
    const key = id + color;
    let c = tinted.get(key);
    if (c) return c;
    const [s, x, y, w, h] = GD.shapes[id];
    let sheet = glowSheets[s];
    if (!sheet) { sheet = glowSheets[s] = new Image(); sheet.onload = () => { sheet.ready = true; schedule(); }; sheet.src = `atlas/glows/glows-${s}.webp`; }
    if (!sheet.ready) return null;
    if (tinted.size > 2000) tinted.clear();
    c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(sheet, x, y, w, h, 0, 0, w, h); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, w, h);
    tinted.set(key, c);
    return c;
  }
  // What is selected stands in front of its glow: its art is lifted out of the map as drawn (through its outline, masks-*.webp
  // of glow-shapes.js) before the glows go on, and put back over them.
  const maskSheets = [], lifted = document.createElement('canvas');
  function liftFigure(h, z) {
    const [s, x, y, w, hh] = GD.masks[h.mask];
    let sheet = maskSheets[s];
    if (!sheet) { sheet = maskSheets[s] = new Image(); sheet.onload = () => { sheet.ready = true; schedule(); }; sheet.src = `atlas/glows/masks-${s}.webp`; }
    if (!sheet.ready) return null;
    const X = h.tx + (h.dx + GD.margin) * z, Y = h.ty + (h.dy + GD.margin) * z, W = Math.max(1, Math.round(w * z * dpr)), H = Math.max(1, Math.round(hh * z * dpr));
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
        const tx = view.ox + z * tileWX(...m.tile), ty = view.oy + z * tileWY(...m.tile), color = GLOW[kind];
        if (!glows) {
          if (tx < -10 || ty < -10 || tx > cw + 10 || ty > ch + 10) continue;
          hits.push({ x: tx, y: ty, rx: 6, ry: 6, tx, ty, tw, th, m, active, faint, color, a: active ? 1 : fa, dot: true });
          continue;
        }
        const s = shapeOf(m, kind);
        if (s) {                                                                 // the halo of its art: [shape, dx, dy, mask] from the tile's centre
          const [, , , w, h] = GD.shapes[s[0]], sw = w * GD.scale * z, sh = h * GD.scale * z, x0 = tx + s[1] * z, y0 = ty + s[2] * z;
          if (x0 > cw || y0 > ch || x0 + sw < 0 || y0 + sh < 0) continue;
          hits.push({ x: x0 + sw / 2, y: y0 + sh / 2, rx: sw * 0.4, ry: sh * 0.4, x0, y0, sw, sh, shape: s[0], dx: s[1], dy: s[2], mask: s[3], tx, ty, tw, th, m, active, faint, color, a: active ? 1 : fa });
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
        const t = h.shape != null && tintedShape(h.shape, h.color);
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
  const pinEls = new Map();
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
    if (!close) {
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
    panel.innerHTML = `<h2>📦 ${CONTAINER}</h2><div class="meta">${c.place}${c.locked != null ? ` · locked (${c.locked})` : ''}</div>
      ${c.items.length ? `<h3>Contains</h3><div class="items">${itemList(c.items)}</div>` : ''}
      ${src ? `<h3>Random: ${src.name}</h3><div class="items">${src.items.map(([i, r]) => `<div><span>${IT.items[i].name}</span><span>${r}%</span></div>`).join('')}</div>` : ''}
      ${!c.items.length && !src ? '<p class="empty">Empty.</p>' : ''}
      <div class="chk">tile: ${c.tile.join(', ')}</div>`;
  }
  function selectNpc(n) {
    activeNpc = n; activeLabel = null; activeChest = null; schedule();
    if (embed) { parent.postMessage({ type: 'atlas-npc', npc: n }, '*'); return; }
    panel.innerHTML = `<h2>${n.name}</h2>
      <div class="meta">${[n.race, n.gender === 0 ? '♀' : n.gender === 1 ? '♂' : '', n.kind ? n.kindName : '', n.level ? 'level ' + n.level : ''].filter(Boolean).join(' · ')}</div>
      <div class="meta">${n.place}${n.shop ? ' · sells goods' : ''}</div>`;
  }
  function selectGround(g) {
    activeLabel = g; activeChest = null; activeNpc = null; schedule();
    if (embed) { parent.postMessage({ type: 'atlas-item', item: g.item }, '*'); return; }
    panel.innerHTML = `<h2>${esc(IT.items[g.item].name)}</h2><div class="meta">${esc(g.place)}${g.qty > 1 ? ' · ×' + g.qty : ''}</div>`;
  }
  function select(l) {
    activeLabel = l; activeChest = null; activeNpc = null; schedule();
    if (embed) { parent.postMessage({ type: 'atlas-label', label: l }, '*'); return; }
    panel.innerHTML = `<h2>${l.text}</h2>
      <div class="meta">${catsOf(l).map(c => (ICON[c] || '') + ' ' + c).join(' · ')} — ${l.place}</div>
      ${l.description ? `<h3>About</h3><div class="desc">${l.description}</div>` : ''}
      ${l.to ? `<h3>Waypoint</h3><div>🚪 to ${l.to.map(t => t.place).join(', ')}</div>` : ''}
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
    if (e.data && e.data.type === 'atlas-go') goPlace(e.data.place, e.data.tile);
    if (e.data && e.data.type === 'atlas-travel') {           // through a waypoint: arrive on that tile of that map
      const i = e.data.map == null ? -1 : mapIndex.get(e.data.map);
      if (i == null) return;
      switchMap(i);
      centreOn(e.data.tile[0], e.data.tile[1], i < 0 ? 0.3 : 0.7);
    }
    if (e.data && e.data.type === 'atlas-setview') {          // a shared link: this map, this spot, this zoom
      const i = e.data.map == null ? -1 : mapIndex.get(e.data.map);
      switchMap(i == null ? -1 : i);
      centreOn(e.data.tile[0], e.data.tile[1], Math.max(0.0005, Math.min(3, +e.data.z || 0.3)));
      if (cw && embed) parent.postMessage({ type: 'atlas-ack' }, '*');      // arrived: the page stops asking (or it would undo the next zoom)
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
    if (!drag) { hover(e); return; }
    if (!e.buttons) { end(); return; }
    drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    view.ox += e.clientX - drag.x; view.oy += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; schedule(); });
  const end = () => { drag = null; canvas.classList.remove('drag'); };
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
  canvas.parentElement.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.12 : 0.0042))); }, { passive: false });
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
