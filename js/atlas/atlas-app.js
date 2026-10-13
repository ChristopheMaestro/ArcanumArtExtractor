// The Arcanum Asset Browser page (index.html): welcome screen, Atlas, Items, Library, Quests, Demographics, and the
// Asset Browser (asset-browser.html) in the Files and Workshop frames. Data: js/atlas/data/ (toolbox/atlas/), pictures:
// atlas/, music and sounds: data/sound/.
let current = 'home';

const ICON = { quest: '📜', shop: '🪙', followers: '🛡️', waypoint: '🚪', key: '🔑', npc: '🧑' };

/* ------------------------------------------------------------------ atlas: the real world map */
// Places and labels come from world-labels.js (toolbox/atlas/locate_world_labels.py); the map is world-atlas.html in a frame.
// Items, containers and who carries what come from items.js (toolbox/atlas/build_items.py).
const WL = window.ArcanumWorldLabels;
const IT = window.ArcanumItems;
Object.assign(ICON, { chest: '📦', information: 'ℹ️', altar: '🕯️', bounty: '💰', master: '🎓' });
const worldFrame = document.getElementById('worldFrame');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- items: lookups built once -----------------------------------------------------------------------
const BYNAME = new Map();
const nameKey = s => s.toLowerCase().replace(/[’‘]/g, "'");
IT.items.forEach((it, i) => { const k = nameKey(it.name); if (!BYNAME.has(k) || IT.items[BYNAME.get(k)].hidden) BYNAME.set(k, i); });
// c: in a container, b: in a merchant's stock box (sold), n: carried, g: on the ground, s: can turn up in a random list,
// x: a script makes it (sold or handed over in a conversation, dropped on death...; only scripts something in the game carries)
const WHERE = IT.items.map(() => ({ c: [], b: [], n: [], g: [], s: [], x: [] }));
(IT.scripted || []).forEach((g, gi) => g.name && WHERE[g.item].x.push(gi));
IT.containers.forEach((c, ci) => c.items.forEach(([i, q]) => WHERE[i][c.storeOf != null ? 'b' : 'c'].push([ci, q])));
IT.npcs.forEach((n, ni) => n.items.forEach(([i, q]) => WHERE[i].n.push([ni, q])));
IT.ground.forEach((g, gi) => WHERE[g.item].g.push(gi));
const SOURCE_USERS = {};          // list -> the containers, merchants (by their box) and people who roll it
const users = id => SOURCE_USERS[id] = SOURCE_USERS[id] || { c: [], m: [], n: [] };
IT.containers.forEach((c, ci) => c.source && (c.storeOf != null ? users(c.source).m.push(c.storeOf) : users(c.source).c.push(ci)));
IT.npcs.forEach((n, ni) => n.source && users(n.source).n.push(ni));
for (const [id, s] of Object.entries(IT.sources)) if (SOURCE_USERS[id]) s.items.forEach(([i, r]) => WHERE[i].s.push([id, r]));
// "sold": in a merchant's box, or on the list their box restocks from
const SOLD = new Set();
WHERE.forEach((w, i) => w.b.length && SOLD.add(i));
for (const [id, s] of Object.entries(IT.sources)) if (SOURCE_USERS[id]?.m.length) s.items.forEach(([i]) => SOLD.add(i));
// schematics: what makes an item, what an item goes into, what a schematic paper teaches
const MADE = IT.items.map(() => []), USED = IT.items.map(() => []), TEACHES = IT.items.map(() => []);
IT.recipes.forEach((r, ri) => {
  r.makes.forEach(i => MADE[i].push(ri));
  new Set(r.parts.flat()).forEach(i => USED[i].push(ri));
  (r.found || []).forEach(i => TEACHES[i].push(ri));
});

// the item's inventory picture, fitted in a box of `box` px
function spr(i, box) {
  const it = IT.items[i];
  if (!it || !it.icon) return `<span class="ibox" style="--s:${box}px"><span class="ph"></span></span>`;
  const [x, y, w, h] = it.icon, s = Math.min(1, box / Math.max(w, h)), [W, H] = IT.iconSheet;
  return `<span class="ibox" style="--s:${box}px"><span class="spr" style="width:${w * s}px;height:${h * s}px;background-size:${W * s}px ${H * s}px;background-position:-${x * s}px -${y * s}px"></span></span>`;
}
const cls = it => it.hexed ? ' hexed' : it.magick ? ' magick' : it.tech ? ' tech' : '';
// a random list gives an item one chance per roll: [100, 100, 20] -> "100% ×2 · 20%"
const rateMax = r => Array.isArray(r) ? Math.max(...r) : r;
const rateTxt = r => {
  if (!Array.isArray(r)) return r + '%';
  const c = {}; r.forEach(x => { c[x] = (c[x] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[0] - a[0]).map(([x, n]) => n > 1 ? `${x}% ×${n}` : x + '%').join(' · ');
};
const byRate = list => list.slice().sort((a, b) => rateMax(b[1]) - rateMax(a[1]));
const cit = i => `<button class="cit${cls(IT.items[i])}" data-item="${i}">${spr(i, 20)}<span>${esc(IT.items[i].name)}</span></button>`;
// one schematic: how it is learned, its two parts and what it gives (`from` = the item the card is about)
function recipeBox(ri, from) {
  const r = IT.recipes[ri], tech = IT.techs[r.tech];
  const how = r.degree ? `🎓 ${esc(tech)} · learned with the ${esc(IT.degrees[r.degree])} degree`
    : `📜 ${esc(tech)} · found schematic${r.found.length ? ': ' + r.found.filter(k => k !== from).map(cit).join(' ') : ''}`;
  const parts = r.parts.filter(p => p.length).map(p => cit(p.includes(from) ? from : p[0]));
  const made = cit(r.makes.includes(from) ? from : r.makes[0]) + (r.qty > 1 ? ` <span class="q">×${r.qty}</span>` : '');
  const need = (r.needs || []).map(([t, d]) => `${IT.techs[t]} ${IT.degrees[d]}`);
  return `<div class="craft"><div class="craft-how">${how}${r.name && !r.makes.some(k => IT.items[k].name === r.name) ? ` <i>(${esc(r.name)})</i>` : ''}</div>
    <div class="craft-parts">${parts.join('<b>+</b>')}<b>→</b>${made}</div>
    ${need.length ? `<div class="craft-need">Combining the parts takes ${esc(need.join(' and '))}.</div>` : ''}</div>`;
}
function tile(i, qty) {
  const it = IT.items[i];
  return `<button class="item${cls(it)}" data-item="${i}">${spr(i, 40)}<span>${esc(it.name)}${qty > 1 ? ` <b>×${qty}</b>` : ''}</span></button>`;
}
const wireItems = root => {
  root.querySelectorAll('[data-item]').forEach(el => el.addEventListener('click', () => showItem(+el.dataset.item)));
  wireQuests(root);
};

// ---- one item: what it is and where it is found ----------------------------------------------------
// game: only where it is found in that game (Arcanum or a module; the Items screen's filter), else everywhere
function itemDetail(i, game) {
  const it = IT.items[i], all = WHERE[i];
  const inG = (g => !game || g === game), userIn = u => !game ? u : { c: u.c.filter(ci => CON_GAME[ci] === game), m: u.m.filter(ni => NPC_GAME[ni] === game), n: u.n.filter(ni => NPC_GAME[ni] === game) };
  const w = !game ? all : { c: all.c.filter(([ci]) => inG(CON_GAME[ci])), b: all.b.filter(([ci]) => inG(CON_GAME[ci])), n: all.n.filter(([ni]) => inG(NPC_GAME[ni])),
    g: all.g.filter(gi => inG(gameOf(IT.ground[gi]))), s: all.s.filter(([id]) => { const u = userIn(SOURCE_USERS[id]); return u.c.length + u.m.length + u.n.length; }),
    x: all.x.filter(gi => inG(scriptGame(IT.scripted[gi]))) };
  const sub = [it.kind === 'Written' ? it.written : it.kind, it.slot && it.slot !== 'Torso' ? it.slot : '', it.ammo,
    it.slot === 'Torso' && it.sizes ? (it.sizes.length === 3 ? 'any size' : 'size ' + it.sizes.join('/')) : '',
    it.gender ? `${it.gender}s only` : '', it.twoHanded ? 'two-handed' : '', it.throwable ? 'can be thrown' : ''].filter(Boolean);
  let h = `<div class="idet-head">${spr(i, 96)}<div><h3 class="${cls(it)}">${esc(it.name)}</h3><div class="meta">${esc(sub.join(' · '))}</div>
    ${it.hexed ? `<div class="meta hexed">☠ Hexed magick${it.complexity ? ` · power ${it.complexity}` : ''}</div>`
      : it.magick ? `<div class="meta magick">Magickal${it.complexity ? ` · power ${it.complexity}` : ''}</div>` : it.tech ? `<div class="meta tech">Technological${it.complexity ? ` · complexity ${it.complexity}` : ''}</div>` : ''}</div></div>`;
  if (it.hexed) h += `<div class="sec flavour" style="color:var(--hexed)">A hex lies on it: part of its magick works against whoever uses it.</div>`;
  if (it.effect) h += `<div class="sec flavour">${esc(it.effect)}</div>`;
  const kv = (it.stats || []).map(([k, v, adj]) => `<dt>${esc(k)}</dt><dd>${esc(v)}${adj ? ` <span class="adj${it.hexed ? ' neg' : ''}">(${adj > 0 ? '+' : ''}${adj})</span>` : ''}</dd>`);
  if (it.hp) kv.push(`<dt>Durability</dt><dd>${it.hp}</dd>`);
  if (it.kind !== 'Gold') kv.push(`<dt>Worth</dt><dd>${it.worth} gold</dd>`, `<dt>Weight</dt><dd>${it.weight} stone</dd>`);
  h += `<div class="sec"><dl class="kv">${kv.join('')}</dl>${(it.stats || []).some(s => s[2]) ? `<div class="note">(+n) = ${it.hexed ? 'the hex’s doing' : 'magickal bonus'}</div>` : ''}</div>`;
  if (it.text) h += `<div class="sec"><div class="sec-t">${esc(it.written || 'Text')}</div><div class="itext">${it.text.map(([k, p]) => k === 'h' ? `<h4>${esc(p)}</h4>` : `<p>${esc(p)}</p>`).join('')}</div></div>`;
  if (TEACHES[i].length) h += `<div class="sec"><div class="sec-t">Reading it teaches</div>${TEACHES[i].map(ri => recipeBox(ri, i)).join('')}</div>`;

  const rows = [];
  if (MADE[i].length && inG('Arcanum')) rows.push(`<div class="wgrp">🔧 Crafted</div>` + MADE[i].map(ri => recipeBox(ri, i)).join(''));
  const more = (list, n, f) => list.slice(0, n).map(f).join('') + (list.length > n ? `<div class="wrow more">and ${list.length - n} more</div>` : '');
  if (w.c.length) rows.push(`<div class="wgrp">📦 In containers</div>` + more(w.c, 25, ([ci, q]) => {
    const c = IT.containers[ci];
    return `<div class="wrow">${whoLink(c, `${esc(c.name)}${q > 1 ? ` <b>×${q}</b>` : ''}${c.locked != null ? ' 🔒' : ''}`, ` data-chest="${ci}"`)}${placeLink(c)}</div>`;
  }));
  if (w.b.length) rows.push(`<div class="wgrp">🪙 Sold by</div>` + more(w.b, 20, ([ci, q]) => {
    const n = IT.npcs[IT.containers[ci].storeOf];
    return `<div class="wrow">${whoLink(n, `${esc(n.name || 'A merchant')}${q > 1 ? ` <b>×${q}</b>` : ''}`, spotAttr(n, true))}${placeLink(n)}</div>`;
  }));
  if (w.x.length) rows.push(`<div class="wgrp">🎁 Given by a script</div>` + more(w.x, 20, gi => {
    const g = IT.scripted[gi];
    const how = g.price ? `sells it for ${g.price} gold` : g.when === 'talk' ? (g.toPc ? 'hands it over in a conversation' : 'comes to have it through a conversation')
      : g.when === 'death' ? 'drops it when killed' : g.when === 'use' ? 'gives it when used' : g.when === 'look' ? 'gives it when looked at' : 'a script makes it';
    const who = `${g.proto ? 'Any ' : ''}${esc(g.name || 'Someone')} <span class="q">· ${esc(how)}</span>`;
    return `<div class="wrow">${g.proto ? `<span>${who}</span><span class="wp" title="script ${esc(g.script)}">${esc(g.script)}</span>`
      : whoLink(g, who, spotAttr(g, g.npc)) + placeLink(g)}</div>`;
  }));
  if (w.n.length) {
    const seen = new Map();
    for (const [ni, q] of w.n) { const n = IT.npcs[ni], k = n.name + '|' + n.place; seen.set(k, [(seen.get(k)?.[0] || 0) + 1, n]); }
    rows.push(`<div class="wgrp">🧑 Carried by</div>` + more([...seen.values()], 20, ([cnt, n]) =>
      `<div class="wrow">${whoLink(n, `${esc(n.name || 'Someone')}${cnt > 1 ? ` <b>×${cnt}</b>` : ''}`, spotAttr(n, true))}${placeLink(n)}</div>`));
  }
  if (w.g.length) rows.push(`<div class="wgrp">✋ Lying on the ground</div>` + more(w.g, 15, gi => {
    const g = IT.ground[gi];
    return `<div class="wrow">${whoLink(g, `${esc(placeTitle(g.place))}${g.qty > 1 ? ' <b>×' + g.qty + '</b>' : ''}`)}<span class="wp"></span></div>`;
  }));
  if (w.s.length) rows.push(`<div class="wgrp">🎲 Can turn up in</div>` + more(byRate(w.s), 15, ([id, r]) => {
    const u = userIn(SOURCE_USERS[id]), who = [...new Set([...u.m, ...u.n].map(ni => IT.npcs[ni].name).filter(Boolean))];
    const what = u.m.length ? 'shop: ' : '';
    return `<div class="wrow"><span>${esc(what ? shopKind(IT.sources[id].name) : IT.sources[id].name)} <b>${rateTxt(r)}</b></span><span class="wp">${who.length ? esc(what + who.slice(0, 3).join(', ') + (who.length > 3 ? '…' : '')) : u.c.length + ' container' + (u.c.length > 1 ? 's' : '')}</span></div>`;
  }));
  h += `<div class="sec"><div class="sec-t">Where to find it${game && GAMES.length > 1 ? ' in ' + esc(game) : ''}</div>${rows.join('') || (game && !NOT_IN_GAME(i) ? `<div class="flavour">Not found in ${esc(game)}.</div>` : '') || '<div class="flavour">Not in the game: no chest, person, merchant, script or schematic provides it.</div>'}</div>`;
  if (USED[i].length) h += `<div class="sec"><div class="sec-t">Goes into</div>${USED[i].map(ri => recipeBox(ri, i)).join('')}</div>`;
  return h;
}
// Where something is (items.js, library.js): `world` = on the world map, else `place` is the key of the map it stands on.
// mapOf: null on the world map, the map's key, or undefined when the Atlas has no picture of that map (the merchants' store map...).
const mapOf = o => o.world ? null : MAP_BY_KEY.has(nkey(o.place)) ? MP.maps[MAP_BY_KEY.get(nkey(o.place))].key : undefined;
const onAtlas = o => !!o.tile && mapOf(o) !== undefined;
// the name of who or what holds it flies to that very spot (and opens their panel); the place beside it opens that map
const spotAttr = (o, npc) => ` data-spot="${esc(JSON.stringify([o.place, o.tile, mapOf(o), npc ? 1 : 0]))}"`;
const whoLink = (o, html, attr) => onAtlas(o) ? `<button class="wlink"${attr || spotAttr(o)} title="Show on the map">${html}</button>` : `<span>${html}</span>`;
const placeLink = o => mapOf(o) !== undefined
  ? `<button class="wp wlink" data-goto="${esc(JSON.stringify([o.place, o.tile, mapOf(o)]))}" title="Open this map">${esc(placeTitle(o.place))}</button>`
  : `<span class="wp">${esc(placeTitle(o.place))}</span>`;
function focusSpot(place, tile, map, npc) {
  focusTile(place, tile, npc ? 'x' : '', map);
  const n = npc && NPC_BY_TILE.get(qnorm(place) + '|' + tile.join(','));
  if (n) selectNpc(n);
}
// a place of the world opens as from the places list; another map at the spot the game puts the player
function openMapOf(place, tile, map) {
  document.getElementById('itemCard').classList.remove('on');
  go('atlas');
  if (map == null) { if (WL.places.some(q => q.name === place)) goPlace(place); else focusTile(place, tile); return; }
  const m = MP.maps[MAP_BY_KEY.get(nkey(map))];
  travelTo(m.key, m.name, m.start || tile);
}
function wireDetail(root, open) {
  root.querySelectorAll('[data-item]').forEach(b => b.addEventListener('click', () => open(+b.dataset.item)));
  root.querySelectorAll('[data-chest]').forEach(b => b.addEventListener('click', () => focusContainer(+b.dataset.chest)));
  root.querySelectorAll('[data-spot]').forEach(b => b.addEventListener('click', () => focusSpot(...JSON.parse(b.dataset.spot))));
  root.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => openMapOf(...JSON.parse(b.dataset.goto))));
}
function showItem(i) {
  if (current === 'atlas') {       // on the map the item shows in the right sidebar, like a person or a container
    const p = openPanel();
    p.innerHTML = itemDetail(i);
    p.scrollTop = 0;
    wireDetail(p, showItem);
    return;
  }
  const box = document.getElementById('itemCard');
  box.innerHTML = `<div class="ic"><button class="ic-x" title="Close">×</button>${itemDetail(i)}</div>`;
  wireDetail(box, showItem);
  box.classList.add('on');
  box.onclick = e => { if (e.target === box || e.target.classList.contains('ic-x')) box.classList.remove('on'); };
}

// ---- containers ----------------------------------------------------------------------------------------
function containerBody(ci) {
  const c = IT.containers[ci];
  let h = '';
  if (c.altar) {        // the altar's script: the god, the offering it accepts, the blessing it gives (items.js, build_items.Altars)
    const a = c.altar, side = { 'altar-good': 'Good', 'altar-neutral': 'Neutral', 'altar-evil': 'Evil' }[c.kind];
    h += `<div class="sec"><div class="sec-t">Altar of ${esc(a.god)}</div><div class="flavour" style="margin-bottom:6px">${esc(a.god)}, ${esc(a.title)}${side ? ` · ${side}` : ''}</div>
      <dl class="kv"><dt>Offering</dt><dd>${a.offering ? a.offering.map(cit).join(' ') : '<span class="flavour">not named by the altar</span>'}</dd>
      ${a.blessing ? `<dt>Blessing</dt><dd>${esc(a.blessing)}${a.effect ? `<div class="note">${esc(a.effect)}</div>` : ''}</dd>` : ''}</dl>
      <div class="note">Place the offering inside the altar.</div></div>`;
  }
  if (c.says) h += `<div class="sec"><div class="sec-t">Says</div><div class="flavour">${esc(c.says).replace(/\n/g, '<br>')}</div></div>`;
  if (c.storeOf != null) {
    const n = IT.npcs[c.storeOf];
    h += `<div class="sec"><div class="sec-t">Shop stock</div><div>What ${esc(n.name || 'the merchant')} sells comes from here.</div></div>`;
  }
  if (c.locked != null || c.held || c.jammed) {
    const keys = (c.keys || []).map(k => `<button class="keylink" data-item="${k}">🔑 ${esc(IT.items[k].name)}</button>`).join(' ');
    h += `<div class="sec"><div class="sec-t">Lock</div>${c.locked != null ? `<div>🔒 Locked${c.locked ? ` · difficulty ${c.locked}` : ''}</div>` : ''}
      ${c.held ? '<div>✨ Magically held</div>' : ''}${c.jammed ? '<div>⚙ Jammed</div>' : ''}${keys ? `<div style="margin-top:4px">Opens with ${keys}</div>` : ''}</div>`;
  }
  if (c.items.length) h += `<div class="sec"><div class="sec-t">Contains</div><div class="inv">${c.items.map(([i, q]) => tile(i, q)).join('')}</div></div>`;
  const s = c.source && IT.sources[c.source];
  if (s) {
    h += `<div class="sec"><div class="sec-t">${c.storeOf != null ? 'Restocks' : c.items.length ? 'Also rolls' : 'Rolls'} at random</div>
      <div class="flavour" style="margin-bottom:6px">${esc(c.storeOf != null ? shopKind(s.name) : s.name)}${s.gold[1] ? ` · ${s.gold[0]}–${s.gold[1]} gold` : ''}</div>
      ${rarelist(byRate(s.items))}</div>`;
  }
  if (!c.items.length && !s && !c.altar) h += '<div class="sec flavour">Empty.</div>';
  return h;
}
const labelAside = document.getElementById('labelAside');
function openPanel() { labelAside.classList.add('open'); return document.getElementById('labelPanel'); }
// closing the panel also lets go of what it showed on the map (as in the Map Explorer)
function closePanel() {
  if (!labelAside.classList.contains('open')) return;
  labelAside.classList.remove('open');
  worldFrame.contentWindow.postMessage({ type: 'atlas-unselect' }, '*');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
const setPlacesHidden = (hidden, save) => {
  const b = document.getElementById('placesToggle');
  document.querySelector('.workspace[data-screen="atlas"]').classList.toggle('noleft', hidden);
  b.textContent = hidden ? '›' : '‹'; b.title = b.ariaLabel = hidden ? 'Show the places list' : 'Hide the places list'; b.ariaExpanded = String(!hidden);
  if (save) try { localStorage.setItem('atlas-places-hidden', hidden ? '1' : '0'); } catch (_) {}
};
document.getElementById('placesToggle').onclick = () => setPlacesHidden(!document.querySelector('.workspace[data-screen="atlas"]').classList.contains('noleft'), true);
try { if (localStorage.getItem('atlas-places-hidden') === '1') setPlacesHidden(true); } catch (_) {}
function selectContainer(ci) {
  const c = IT.containers[ci], p = openPanel();
  p.innerHTML = `<div class="panel-head">${boxFace(c)}<div><h3>${esc(c.name)}</h3><div class="meta">${esc(placeTitle(c.place))}</div></div></div>${containerBody(ci)}${advancedSection(c.file)}`;
  wireItems(p);
}
// ---- Advanced view: every game file behind what the panel shows, each opened in Files ----------------------------------
// assets.js (toolbox/atlas/build_assets.py, fetched once the view is turned on) knows each .mob's prototype, art id, scripts,
// sector, portrait and random inventory; a waypoint or a sign carries its own object (waypoints.js / notices.js, asset_refs.py).
// The .ART file is worked out from the art id here, by the Asset Browser's own code.
const advOn = () => document.body.classList.contains('advanced');
const SAP = ['examine', 'use', 'destroy', 'unlock', 'get', 'drop', 'throw', 'hit', 'miss', 'dialog', 'first heartbeat', 'catching thief pc', 'dying',
  'enter combat', 'exit combat', 'start combat', 'end combat', 'buy object', 'resurrect', 'heartbeat', 'leader killing', 'insert item', 'will kos',
  'taking damage', 'wield on', 'wield off', 'critter hits', 'new sector', 'remove item', 'leader sleeping', 'bust', 'dialog override', 'transfer',
  'caught thief', 'critical hit', 'critical miss'];
let assetsP = null;
function loadAssets() {
  return assetsP || (assetsP = new Promise(ok => {
    const s = document.createElement('script');
    s.src = 'js/atlas/data/assets.js';
    s.onload = () => ok(window.ArcanumAssets || null);
    s.onerror = () => { assetsP = null; ok(null); };
    document.head.appendChild(s);
  }));
}
// ref: a .mob path (people, containers) or [file, type, prototype, art id, scripts] (waypoints, signs)
function advancedSection(ref) {
  if (!ref) return '';
  return `<div class="sec adv" data-adv="${esc(JSON.stringify(ref))}"><div class="sec-t">🛠&#xFE0E; Advanced view</div><div class="adv-list"></div></div>`;
}
const splitPath = f => { const i = f.lastIndexOf('/'); return [i < 0 ? '' : f.slice(0, i), f.slice(i + 1)]; };
// the Asset Browser's own links: ?mode=<kind>&path=<folder>&folderName=<its name>&file=<name>; .ART files: ?folder=...&file=...
function filesQuery(mode, file) {
  const [dir, name] = splitPath(file);
  return String(new URLSearchParams(mode === 'art' ? { folder: dir, folderName: dir.split('/').pop() || 'art', file: name }
    : { mode, path: dir, folderName: dir.split('/').pop() || (mode === 'pro' ? 'proto' : mode === 'mes' ? 'data' : mode), file: name }));
}
const ADV_KIND = { mob: 'MOB', sec: 'SEC', pro: 'PRO', art: 'ART', bmp: 'BMP', scr: 'SCR', dlg: 'DLG', mes: 'MES' };
function advRow(kind, name, role, q, title) {
  const href = q.startsWith('data/') ? q : 'asset-browser.html?' + q;
  return `<a class="adv-row" href="${esc(href)}"${q.startsWith('data/') ? ' target="_blank" rel="noopener"' : ` data-files="${esc(q)}"`} title="${esc(title || name)}">
    <span class="adv-ext k-${kind}">${ADV_KIND[kind]}</span><span class="adv-name">${esc(name)}</span><span class="adv-role">${esc(role)}</span></a>`;
}
const modUrl = p => import(new URL(p, location.href).href);
// the .ART an art id draws with, as a data/art/... url (null: none, or no file found), as the .mob viewer finds it (mob-extras.js,
// proto-card-art.js resolveProtoFileCardArts: that module is not imported, it brings the whole .PRO explorer with it)
async function artUrlOf(type, aid) {
  if (!aid || aid === 0xFFFFFFFF) return null;
  const [ca, cr, pm] = await Promise.all(['js/proto/critter-aid.js', 'js/objects/critter-art.js', 'js/proto/proto-mes.js'].map(modUrl));
  const critter = ca.protoCritterAidInfo(aid, type);
  if (critter && critter.filename) return (await cr.resolveCritterArt(critter))?.url || null;
  const artId = ca.protoCurrentAidArtId(aid, type), artType = ca.protoArtObjectType(aid, type);
  if (artId == null || artType === 18) return null;
  const names = [];
  try { names.push((await pm.ensureProtoArtMesLoaded(artType, 1)).get(artId)); } catch (_) {}
  if (![1, 2, 3].includes(type)) try { names.push((await pm.ensureProtoArtMesLoaded(type, 0)).get(artId)); } catch (_) {}
  for (const n of names.filter(Boolean)) {
    const url = pm.protoArtRoot(artType) + encodeURIComponent(n.replace(/^.*[\\/]/, '').replace(/^(.*?\.art)(?:\s+\d+)?$/i, '$1'));
    if ((await fetch(url, { method: 'HEAD' }).catch(() => null))?.ok) return url;
  }
  return null;
}
async function fillAdvanced(root = document.getElementById('labelPanel')) {
  if (!advOn()) return;
  for (const box of root.querySelectorAll('.adv[data-adv]:not([data-done])')) {
    box.dataset.done = '1';
    const list = box.querySelector('.adv-list');
    list.innerHTML = '<div class="flavour">Reading the game files…</div>';
    const A = await loadAssets();
    if (!A) { list.innerHTML = '<div class="flavour">js/atlas/data/assets.js is missing: run toolbox/atlas/build_assets.py.</div>'; continue; }
    let ref = JSON.parse(box.dataset.adv);
    if (typeof ref === 'string') ref = [ref];
    const [file] = ref, m = A.mobs[file];
    const [type, proto, aid, scripts, sector, portrait, source] = m || [ref[1], ref[2], ref[3], ref[4] || [], file.endsWith('.sec') ? file : 0, 0, 0];
    let h = '';
    if (file.endsWith('.mob')) h += advRow('mob', splitPath(file)[1], `Placed object · ${splitPath(file)[0]}`, filesQuery('mob', file), file);
    if (sector) h += advRow('sec', splitPath(sector)[1], `${file.endsWith('.sec') ? (type ? 'Placed in the sector' : 'Tile script of the sector') : 'Sector it stands in'} · ${splitPath(sector)[0]}`, filesQuery('sec', sector), sector);
    if (proto && A.protos[proto]) h += advRow('pro', A.protos[proto], `Prototype ${proto}`, filesQuery('pro', A.protos[proto]));
    h += '<div class="adv-art"></div>';
    if (portrait && A.portraits[portrait]) h += advRow('bmp', A.portraits[portrait], `Portrait ${portrait}`, 'data/portrait/' + encodeURIComponent(A.portraits[portrait]));
    for (const [pt, n] of scripts || []) {
      const when = pt < 0 ? 'walking onto the tile' : SAP[pt] || `point ${pt}`;
      h += A.scr[n] ? advRow('scr', A.scr[n], `Script ${n} · on ${when}`, filesQuery('scr', A.scr[n])) : `<div class="adv-row off"><span class="adv-ext k-scr">SCR</span><span class="adv-name">script ${n}</span><span class="adv-role">on ${esc(when)} · no .scr file</span></div>`;
      if (A.dlg[n]) h += advRow('dlg', A.dlg[n], `Lines of script ${n}${pt === 9 || pt === 31 ? ' · the conversation' : ''}`, filesQuery('dlg', A.dlg[n]));
    }
    if (source) h += advRow('mes', 'InvenSource.mes', `Random inventory · list ${source}${IT.sources[source] ? ` (${IT.sources[source].name})` : ''}`, filesQuery('mes', 'Rules/InvenSource.mes'));
    list.innerHTML = h || '<div class="flavour">No game file.</div>';
    const art = list.querySelector('.adv-art');
    artUrlOf(type, aid).then(url => {
      const hex = '0x' + (aid >>> 0).toString(16).toUpperCase().padStart(8, '0');
      if (!url) { if (aid && aid !== 0xFFFFFFFF) art.outerHTML = `<div class="adv-row off"><span class="adv-ext k-art">ART</span><span class="adv-name">art id ${hex}</span><span class="adv-role">no .ART file found</span></div>`; else art.remove(); return; }
      const rel = decodeURIComponent(url).replace(/^data\/art\//, '');
      art.outerHTML = advRow('art', splitPath(rel)[1], `Art · id ${hex} · ${splitPath(rel)[0]}`, filesQuery('art', rel), 'data/art/' + rel);
    }).catch(() => art.remove());
  }
}
// a panel filled while the view is on lists its files at once
new MutationObserver(() => fillAdvanced()).observe(document.getElementById('labelPanel'), { childList: true });
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-files]');
  if (!a || e.button || e.ctrlKey || e.metaKey || e.shiftKey) return;      // a middle or ctrl click still opens a tab of its own
  e.preventDefault(); openFiles(a.dataset.files);
});
const advBtn = document.getElementById('advBtn');
advBtn.onclick = () => {
  const on = document.body.classList.toggle('advanced');
  advBtn.classList.toggle('on', on); advBtn.setAttribute('aria-pressed', String(on));
  fillAdvanced();
};
// the other maps of the game (castles, caves, cellars...), drawn from their pictures (map-pictures.js); every picture of the Map Explorer is a "section" of one
const MP = window.ArcanumMaps || { maps: [], sections: [] };
const SECT = new Map(MP.sections.map(s => [s.name, s]));
const nkey = s => String(s || '').toLowerCase().replace(/â€™|[’'`]/g, '').replace(/[^a-z0-9]/g, '');
const MAP_BY_KEY = new Map(MP.maps.map((m, i) => [nkey(m.key), i]));      // how items.js and the quests name a map
const placeTitle = name => { const m = MP.maps.find(x => x.key === name); return m ? m.name : name; };
function placeCrumb(name) {
  const p = WL.places.find(q => q.name === name); if (p) return `Arcanum › ${p.modGroup === 'Cities' ? 'Settlements' : p.modGroup}`;
  const s = SECT.get(name); if (s) return MP.maps[s.map].module ? `Modules › ${s.group}` : `Arcanum › Inside › ${s.group || 'Elsewhere'}`;
  const m = MP.maps.find(x => x.name === name); return m ? `Arcanum › Inside › ${m.area || 'Elsewhere'}` : 'Arcanum';
}
// the maps inside a place are unrolled while that place or one of them is on show, rolled up otherwise
function syncPlaceFolds() {
  document.querySelectorAll('#locList .lockids').forEach(k => {
    const open = !!k.querySelector('.loc.on') || !!k.previousElementSibling.querySelector('.loc.on');
    k.hidden = !open; k.previousElementSibling.firstChild.textContent = open ? '▾' : '▸';
  });
  document.querySelectorAll('#locList .locdet').forEach(d => { d.open = !!d.querySelector('.loc.on'); });
}
function showPlace(place) {
  place = placeTitle(place);
  document.querySelectorAll('#locList .loc').forEach(b => b.classList.toggle('on', b.dataset.place === place));
  syncPlaceFolds();
  document.getElementById('atlasTitle').textContent = place;
  document.getElementById('atlasCrumb').textContent = placeCrumb(place);
  syncLink();
}
function focusTile(place, tile, name, map) {
  document.getElementById('itemCard').classList.remove('on');
  go('atlas');
  showPlace(place);
  worldFrame.contentWindow.postMessage({ type: 'atlas-focus', tile, name, map }, '*');
}
function focusContainer(ci) {
  const c = IT.containers[ci];
  document.getElementById('itemCard').classList.remove('on');
  go('atlas');
  showPlace(c.place);
  worldFrame.contentWindow.postMessage({ type: 'atlas-focus', tile: c.tile, container: ci, map: mapOf(c) }, '*');
  selectContainer(ci);
}
// A waypoint is a door, ladder or tile whose script teleports you (waypoints.js): `to` says where, as a map (null = the world),
// the name of the place and the tile you arrive on.
function travelTo(map, place, tile) {
  closePanel();
  document.getElementById('itemCard').classList.remove('on');
  go('atlas');
  const sec = map != null && MP.sections.find(s => MP.maps[s.map].key === map);
  showPlace(sec ? sec.name : place);
  worldFrame.contentWindow.postMessage({ type: 'atlas-travel', map, tile }, '*');
}

// a label (waypoint, note, altar, quest object) -> the shape selectLabel() draws (Map Explorer fields, nothing about files)
function fromWorld(l) {
  return { text: l.text, cat: (Array.isArray(l.category) ? l.category : [l.category]).filter(Boolean),
    desc: l.description, to: l.to, what: l.what, lock: l.lock,
    god: l.godType, offering: l.offering, blessing: l.blessing,
    place: l.place, mapKey: l.mapKey || l.place, map: l.map, tile: l.tile, obj: l.obj };
}
function goPlace(name) {
  if (!WL.places.some(q => q.name === name) && !SECT.has(name)) return;
  closePanel();
  showPlace(name);
  worldFrame.contentWindow.postMessage({ type: 'atlas-go', place: name }, '*');
}
// Areas (areas.js): the named spots of the world map. Those that are not a place yet become one (and the secret areas a group of
// their own), as in the map's own page.
const AR = window.ArcanumAreas || { areas: [], secret: [] };
const QUEST_PLACES = new Set(['The Black Mountain Mines']);       // quest places the world labels do not group as such
for (const a of AR.areas) if (!a.place && !SECT.has(a.name)) { WL.places.push({ name: a.name, modGroup: a.settlement ? 'Cities' : QUEST_PLACES.has(a.name) ? 'Quest locations' : 'Other locations', view: a.tile, labels: [], area: true }); a.place = a.name; }
for (const s of AR.secret) WL.places.push({ name: s.name, modGroup: 'Secret areas', view: s.tile, labels: [], area: true });
const AREA_OF = new Map([...AR.areas.map(a => [a.place || a.name, { ...a, kind: a.settlement ? 'settlement' : 'area' }]), ...AR.secret.map(s => [s.name, { ...s, kind: 'secret' }])]);
// the card of an area: what the game says of it, and how it comes to be on the player's world map
function selectArea(a) {
  const p = openPanel(), r = a.radius == null ? 5 : a.radius;
  const how = a.kind === 'secret' ? 'A secret place of the open world: nothing on the world map points to it, and walking past never marks it.'
    : r < 0 ? 'Walking past never puts it on the world map: only the story reveals it (a person, a map or a book).'
    : `It appears on the world map once the player has passed within ${r} map square${r === 1 ? '' : 's'} of it.`;
  p.innerHTML = `<div class="panel-head"><span class="portrait chestpic">${a.kind === 'secret' ? '🗝️' : a.kind === 'settlement' ? '🏘️' : '📍'}</span>
    <div><h3>${esc(a.name)}</h3><div class="cats"><span>${a.kind === 'secret' ? 'Secret area' : a.hidden ? 'Hidden area' : a.kind === 'settlement' ? 'Settlement' : 'Area'}</span></div></div></div>
    ${a.description ? `<div class="sec">${esc(a.description)}</div>` : ''}<div class="sec"><div class="sec-t">On the world map</div><div>${esc(how)}</div></div>`;
}
// Arcanum or Modules: the places list shows the game's own maps, or the maps of the modules (one group each)
const isModuleSection = s => !!MP.maps[s.map].module;
let atlasMode = 'arcanum';
try { if (localStorage.getItem('atlas-mode') === 'modules' && MP.sections.some(isModuleSection)) atlasMode = 'modules'; } catch (_) {}
function buildPlaceList() {
  const list = document.getElementById('locList');
  list.innerHTML = '';
  const btn = (name, n, go) => {
    const b = document.createElement('button');
    b.className = 'loc' + (name === 'Shrouded Hills' ? ' on' : ''); b.dataset.place = name;
    b.textContent = name;
    b.onclick = () => goPlace(go || name);
    return b;
  };
  // how much is marked in a place: its people (those the game has switched on) and containers (.mob) and its labels (a map
  // cut into sections counts whole)
  const things = new Map(), add = k => things.set(k, (things.get(k) || 0) + 1);
  for (const d of [window.ArcanumNpcs, window.ArcanumSubNpcs]) if (d) for (const r of d.npcs) if (!r[13]) add(d.places[r[0]]);
  for (const c of IT.containers) if (c.tile) add(c.place);
  for (const w of (window.ArcanumWaypoints ? window.ArcanumWaypoints.waypoints : [])) add(w[0] == null ? w[1] : w[0]);
  for (const n of (window.ArcanumNotices ? window.ArcanumNotices.notices : [])) add(n[0] == null ? n[1] : n[0]);
  const count = (p, key) => things.get(key) || 0;
  if (atlasMode === 'modules') {
    const mods = new Map();
    for (const s of MP.sections) if (isModuleSection(s)) { if (!mods.has(s.group)) mods.set(s.group, []); mods.get(s.group).push(s); }
    for (const [g, ss] of mods) {
      list.insertAdjacentHTML('beforeend', `<div class="locgroup">${esc(g)}</div>`);
      for (const s of ss) list.appendChild(btn(s.name, count(s, MP.maps[s.map].key)));
    }
    return;
  }
  // the other maps, by the area of the world they belong to; those of a place hang under it
  const areas = new Map();
  for (const s of MP.sections) { if (isModuleSection(s)) continue; const a = s.group || 'Elsewhere'; if (!areas.has(a)) areas.set(a, []); areas.get(a).push(s); }
  const areaOf = new Map([...areas].map(([a, ss]) => [nkey(a), a])), taken = new Set();
  const GROUP_NAME = { Cities: 'Settlements' };
  const PLACE_GROUP = { 'Qintarra': 'Cities', 'The Black Mountain Mines': 'Quest locations', 'The Void': 'Quest locations' };
  for (const g of ['Cities', 'Quest locations', 'Other locations', 'Secret areas']) {
    const ps = WL.places.filter(p => p.modGroup === g && (count(p, p.name) || p.area || AREA_OF.has(p.name))).sort((a, b) => a.name.localeCompare(b.name));
    // places the world labels list under no group, or that are made of maps only (the Void): put where they belong
    for (const [name, grp] of Object.entries(PLACE_GROUP)) {
      if (grp !== g || ps.some(p => p.name === name) || !areaOf.has(nkey(name))) continue;
      const ss = areas.get(areaOf.get(nkey(name))).map(s => s.name).sort();
      ps.push({ name, go: ss.includes(name) ? name : ss[0] });
    }
    ps.sort((a, b) => a.name.localeCompare(b.name));
    list.insertAdjacentHTML('beforeend', `<div class="locgroup">${GROUP_NAME[g] || g}</div>`);
    for (const p of ps) {
      const a = areaOf.get(nkey(p.name));
      if (!a || taken.has(a)) {
        const row = document.createElement('div'); row.className = 'locrow';
        row.innerHTML = '<span class="loctog"></span>'; row.appendChild(btn(p.name, count(p, p.name), p.go));
        list.appendChild(row); continue;
      }
      taken.add(a);
      const row = document.createElement('div'); row.className = 'locrow';
      const tog = document.createElement('button'); tog.className = 'loctog'; tog.type = 'button'; tog.textContent = '▸'; tog.title = 'Show the maps inside';
      const kids = document.createElement('div'); kids.className = 'lockids'; kids.hidden = true;
      for (const s of areas.get(a).sort((x, y) => x.name.localeCompare(y.name))) kids.appendChild(btn(s.name, count(s, MP.maps[s.map].key)));
      tog.onclick = () => { kids.hidden = !kids.hidden; tog.textContent = kids.hidden ? '▸' : '▾'; };
      row.append(tog, btn(p.name, count(p, p.name), p.go));
      list.append(row, kids);
    }
  }
  const rest = [...areas].filter(([a]) => !taken.has(a)).sort((x, y) => x[0].localeCompare(y[0]));
  if (rest.length) list.insertAdjacentHTML('beforeend', '<div class="locgroup">Inside: castles, caves, cellars</div>');
  for (const [a, ss] of rest) {
    const d = document.createElement('details'); d.className = 'locdet';
    d.innerHTML = `<summary>${esc(a)}</summary>`;
    for (const s of ss.sort((x, y) => x.name.localeCompare(y.name))) d.appendChild(btn(s.name, count(s, MP.maps[s.map].key)));
    list.appendChild(d);
  }
}
buildPlaceList();
// the switch over the list: Arcanum / Modules. Going to Modules opens the first module's map, back to Arcanum the world.
function setAtlasMode(mode, go) {
  atlasMode = mode;
  try { localStorage.setItem('atlas-mode', mode); } catch (_) {}
  document.querySelectorAll('#modeTabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  buildPlaceList();
  if (!go) return;
  const first = mode === 'modules' ? MP.sections.find(isModuleSection) : null;
  goPlace(first ? first.name : 'Shrouded Hills');
}
document.querySelectorAll('#modeTabs button').forEach(b => { b.onclick = () => setAtlasMode(b.dataset.mode, true); });
document.querySelectorAll('#modeTabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === atlasMode));
if (atlasMode === 'modules') worldFrame.addEventListener('load', () => { const s = MP.sections.find(isModuleSection); if (s) goPlace(s.name); }, { once: true });
window.addEventListener('message', e => {
  if (e.source !== worldFrame.contentWindow || !e.data) return;
  if (e.data.type === 'atlas-blank') closePanel();              // a click on the map, on nothing in particular
  if (e.data.type === 'atlas-map' && e.data.map == null) {      // back on the world map by the button over the map
    closePanel();
    document.querySelectorAll('#locList .loc').forEach(b => b.classList.remove('on'));
    syncPlaceFolds();
    document.getElementById('atlasTitle').textContent = 'World map'; document.getElementById('atlasCrumb').textContent = 'Arcanum';
  }
  if (e.data.type === 'atlas-map' && e.data.place) { closePanel(); showPlace(e.data.place); }      // Back onto another map
  if (e.data.type === 'atlas-label') selectLabel(fromWorld(e.data.label));
  if (e.data.type === 'atlas-area') { showPlace(e.data.area.place || e.data.area.name); selectArea(e.data.area); }
  if (e.data.type === 'atlas-container') selectContainer(e.data.index);
  if (e.data.type === 'atlas-item') showItem(e.data.item);
  if (e.data.type === 'atlas-npc') selectNpc(e.data.npc);
  if (e.data.type === 'atlas-ready') sendGivers();
  if (e.data.type === 'atlas-ack') wantedView = null;
  if (e.data.type === 'atlas-view') { lastView = e.data.view; viewReached(lastView); if (SND) SND.view(lastView); syncLink(); }
  if (e.data.type === 'atlas-encounter') showEncounter(e.data.tile);
});
worldFrame.addEventListener('load', () => sendGivers());

// someone who stands on the map but has no label of their own: what the game file says about them
const NPC_AT = new Map(IT.npcs.filter(n => n.tile).map(n => [n.place + '|' + n.tile.join(','), n]));
// the picture the game has for someone or something (portraits.js, toolbox/atlas/build_portraits.py): a person's own portrait, else
// what the game shows when you examine them (undead / monster / animal / mechanical, else the icon of their race)
const PT = window.ArcanumPortraits || { at: {}, raceIcons: [], kindIcons: {}, containerIcons: {} };
const face = key => { const a = PT.at[key]; return a ? `<span class="face" style="background-position:-${a[0]}px -${a[1]}px"></span>` : ''; };
const npcFace = n => face(n.portrait > 0 && PT.at[n.portrait] ? n.portrait : n.kind ? PT.kindIcons[(n.kindName || '').toLowerCase()] : PT.raceIcons[Math.max(0, n.raceIdx)]);
const boxFace = c => face(PT.containerIcons[c.kind] || PT.chestIcon);
const rarelist = (list, n = 40) => `<div class="rlist">${list.slice(0, n).map(([i, r]) => `<button class="rrow${cls(IT.items[i])}" data-item="${i}">${spr(i, 22)}<span>${esc(IT.items[i].name)}</span><b>${rateTxt(r)}</b></button>`).join('')}
  ${list.length > n ? `<div class="wrow more">and ${list.length - n} more</div>` : ''}</div>`;
// Everything about a person comes from their own .mob, joined by place and tile (the same files give both): their row in
// npcs.js / submaps.js, what they carry and their shop's box (items.js), the quest steps they take part in (quests.js).
function selectNpc(n) {
  const p = openPanel();
  n = PEOPLE.find(q => q.place === n.place && q.tile[0] === n.tile[0] && q.tile[1] === n.tile[1]) || n;
  const sex = n.gender === 0 ? '♀' : n.gender === 1 ? '♂' : '';
  const carried = NPC_AT.get(n.place + '|' + n.tile.join(','));
  let h = `<div class="panel-head">${npcFace(n)}
    <div><h3>${esc(n.name)}</h3><div class="meta">${esc([n.race, sex, n.kind ? n.kindName : '', n.level ? 'level ' + n.level : ''].filter(Boolean).join(' · '))}</div>
    <div class="meta">${esc(placeTitle(n.place))}</div></div></div>`;
  // switched off: a spawner or a script holder (n.offInfo: what it is, and what else matters), someone a script brings in under
  // conditions (n.why, alternatives split by " — or — "), or nobody knows
  const cap = t => esc(t.charAt(0).toUpperCase() + t.slice(1)), items = list => `<ul>${list.map(t => `<li>${cap(t)}</li>`).join('')}</ul>`;
  if (n.off) h += `<div class="sec flavour">${n.offInfo
    ? `${esc(n.offInfo.t)}${n.offInfo.w && n.offInfo.w.length ? `<div class="note">${n.offInfo.k === 'helper' ? 'It acts' : 'Also'}:</div>${items(n.offInfo.w)}` : ''}`
    : n.why
      ? `This NPC is turned off and will display under the following conditions:${items(n.why.split(' — or — '))}`
      : `This NPC is turned off, and nothing in the game's scripts appears to ever turn ${n.kind ? 'it' : 'them'} on.`}</div>`;
  h += questsSection(questsAt(n.place, n.tile));
  if (n.shop) h += shopHtml(carried, n.markup);
  h += roleHtml(n.role);
  h += routineHtml(n.file);
  if (carried && carried.items.length) h += `<div class="sec"><div class="sec-t">Carries</div><div class="inv">${carried.items.map(([i, q]) => tile(i, q)).join('')}</div></div>`;
  const s = carried && carried.source && IT.sources[carried.source];
  if (s && s.items.length) h += `<div class="sec"><div class="sec-t">Carries at random</div>${rarelist(byRate(s.items))}</div>`;
  p.innerHTML = h + advancedSection(n.file);
  wireItems(p);
}

// ---- everyone who lives in the place on show ------------------------------------------------------------------------
const PEOPLE = [];
for (const [d, sub] of [[window.ArcanumNpcs, false], [window.ArcanumSubNpcs, true]]) if (d)
  for (const [pl, x, y, kind, race, gender, level, align, name, shop, markup, role, portrait, off, file] of d.npcs)
    PEOPLE.push({ place: d.places[pl], tile: [x, y], kind, race: race >= 0 ? d.races[race] : '', raceIdx: race, gender, level, align, name, shop, markup, role, portrait, kindName: d.kinds[kind], sub, off: !!off, why: typeof off === 'string' ? off : '', offInfo: off && typeof off === 'object' ? off : null, file });
// A merchant sells from a box of their own (items.js npcs[].store): what is in it, the list it restocks from (whose name is
// the kind of shop, Rules/InvenSource.mes) and the gold it holds.
const shopKind = s => s.replace(/\s*\(([^)]*)\)/, (m, a) => ` (${a.toLowerCase()})`).replace(/\bMagic\b/, 'Magick');
function shopHtml(carried, markup, typeHint) {
  const box = carried && carried.store != null ? IT.containers[carried.store] : null;
  const s = box && box.source ? IT.sources[box.source] : null;
  const type = s ? shopKind(s.name) : typeHint;
  const cash = box ? box.items.filter(([i]) => IT.items[i].kind === 'Gold').reduce((t, [, q]) => t + q, 0) : 0;
  const cashTxt = cash ? `${cash} gold${s && s.gold[1] ? ` <span class="note">(restocks ${s.gold[0]}–${s.gold[1]})</span>` : ''}` : s && s.gold[1] ? `${s.gold[0]}–${s.gold[1]} gold` : '';
  let h = `<div class="sec"><div class="sec-t">Shop</div><dl class="kv">${type ? `<dt>Kind</dt><dd>${esc(type)}</dd>` : ''}${markup ? `<dt>Prices</dt><dd>${markup} % of an item's worth</dd>` : ''}${cashTxt ? `<dt>Cash</dt><dd>${cashTxt}</dd>` : ''}</dl>
    ${markup >= 200 ? '<div class="warn">⚠ Excessive markup</div>' : markup >= 150 ? '<div class="warn">⚠ High markup</div>' : markup && markup < 100 ? '<div class="flavour">Sells below the usual price.</div>' : ''}</div>`;
  const stock = box ? box.items.filter(([i]) => IT.items[i].kind !== 'Gold') : [];      // the gold in the box is the merchant's cash
  if (stock.length) h += `<div class="sec"><div class="sec-t">In stock</div><div class="inv">${stock.map(([i, q]) => tile(i, q)).join('')}</div></div>`;
  if (s && s.items.length) h += `<div class="sec"><div class="sec-t">Restocks at random</div>${rarelist(byRate(s.items))}</div>`;
  return h;
}
const roleHtml = r => !r ? '' : (r.j ? '<div class="sec"><div class="sec-t">Follower</div><div>Can join your party.</div></div>' : '')
  + (r.t ? `<div class="sec"><div class="sec-t">Trainer</div><div>${r.t.map(esc).join(' · ')}</div></div>` : '');
// Where someone goes in a day (routines.js, toolbox/atlas/build_routines.py); the map draws it as footprints while they are selected.
// The game counts day from 6 am to 9 pm.
function routineHtml(file) {
  const r = window.ArcanumRoutines && file && window.ArcanumRoutines.routines[file];
  if (!r) return '';
  const rows = [], far = r.d && r.n ? Math.round(Math.hypot(r.d[0] - r.n[0], r.d[1] - r.n[1])) : 0;
  const loop = `walks a round of ${r.w ? r.w.length : 0} stops, over and over`;
  const bothWays = r.w && r.pd && r.pn;
  if (r.w) rows.push(['Round', bothWays ? `Day and night, ${loop}.` : r.pd ? `By day (6 am – 9 pm), ${loop}.` : `At night (9 pm – 6 am), ${loop}.`]);
  if (far && !bothWays) {
    if (!(r.w && r.pd)) rows.push(['By day', `Stays around tile ${r.d.join(', ')}.`]);
    if (!(r.w && r.pn)) rows.push(['At night', `Goes to tile ${r.n.join(', ')}, ${far} tiles away, and sleeps there if a bed stands near.`]);
  }
  if (!rows.length) return '';
  return `<div class="sec"><div class="sec-t">Routine</div><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}
// the place the atlas shows now: { key: how people are filed (world place name / map key), label, sub: inside one of the other maps }
function currentPlace() {
  const t = document.getElementById('atlasTitle').textContent, s = SECT.get(t), m = s ? MP.maps[s.map] : MP.maps.find(x => x.name === t);
  return m ? { key: m.key, label: m.name, sub: true, title: t } : { key: t, label: t, sub: false, title: t };
}
// mock-ups name a person: show the game's picture of them

// ---- random encounters on a spot of the world map (encounters.js, toolbox/atlas/build_encounters.py; the game's ui/wmap_rnd.c) ------
// The chance and the power come from the smallest zone around the spot (5 % and Average outside them all); the table from
// the sector's terrain, the power and the time of day, unless the spot has a table of its own.
function showEncounter(tile) {
  const E = window.ArcanumEncounters;
  if (!E) { const s = document.createElement('script'); s.src = 'js/atlas/data/encounters.js'; s.onload = () => showEncounter(tile); document.head.appendChild(s); return; }
  const [X, Y] = tile;
  const inZone = list => list.filter(([x, y, r]) => Math.max(Math.abs(X - x), Math.abs(Y - y)) <= r).sort((a, b) => a[2] - b[2])[0];
  const z = inZone(E.zones), pz = inZone(E.powerZones), fx = inZone(E.fixed);
  const chance = z ? z[3] : 5, power = pz ? pz[3] : 2;
  const sx = Math.floor(X / E.grid.sector), sy = Math.floor(Y / E.grid.sector);
  let terrain = 0;
  if (sy >= 0 && sy < E.grid.h && sx >= 0) {                 // run-length row of the sector's line: find the sector's run
    let at = 0;
    for (const tok of E.grid.rows[sy].split(',')) { const n = +tok.slice(1); if (sx < at + n) { terrain = +tok[0]; break; } at += n; }
  }
  const p = openPanel();
  let h = `<div class="panel-head">${PT.combatIcon ? face(PT.combatIcon) : '<span class="portrait chestpic">🎲</span>'}<div><h3>Random encounters</h3><div class="meta">Open country · tile ${X}, ${Y}</div></div></div>`;
  const none = !terrain ? 'Water, mountains or a town: nothing attacks travellers here.' : !power ? 'This region is safe from random encounters.' : '';
  if (none) { p.innerHTML = h + `<div class="sec flavour">${none}</div>`; return; }
  h += `<div class="sec"><dl class="kv"><dt>Chance</dt><dd>${chance} % at each check while you travel <span class="note">(×5 while you rest)</span></dd>
    <dt>Danger</dt><dd>${esc(E.powers[power])}</dd><dt>Land</dt><dd>${esc(E.terrains[terrain])}</dd></dl></div>`;
  const tableHtml = (rows, title) => {
    if (!rows || !rows.length) return '';
    // shares among what can always turn up; an entry that waits for a level or a story event gets the share it has once open
    const gated = x => x && (x.min || x.story);
    const base = rows.reduce((t, r) => t + (gated(r[2]) ? 0 : r[0]), 0);
    const share = (f, x) => Math.round(100 * f / (gated(x) ? base + f : base || f));
    return `<div class="sec"><div class="sec-t">${title}</div><div class="plist">${rows.slice().sort((a, b) => !!gated(a[2]) - !!gated(b[2]) || b[0] - a[0]).map(([f, group, x = {}]) =>
      `<div class="prow" style="cursor:default;align-items:center"><b>${group.map(([n, lo, hi]) => `${lo === hi ? lo : lo + '–' + hi} ${esc(n)}`).join('<br>')}</b>
        <span style="text-align:right;white-space:nowrap">${[x.min ? `(Level ≥${x.min})` : '', `${share(f, x)}&nbsp;%`].filter(Boolean).join(' · ')}${[x.story ? 'After a story event' : '', x.times ? (x.times === 1 ? 'Once' : x.times + ' times') : ''].filter(Boolean).map(t => `<br>${t}`).join('')}</span></div>`).join('')}</div></div>`;
  };
  if (fx) h += tableHtml(E.tables[fx[3]], 'On this spot');
  else {
    const base = (terrain - 1) * 6 + (power - 1) * 2;
    h += tableHtml(E.tables[base], '☀ By day') + tableHtml(E.tables[base + 1], '☾ By night (6 pm – 6 am)');
  }
  h += '<div class="sec note">When the chance comes up, the game picks one of these by its share. A share marked with a level or a story event is what it gets once that is reached.</div>';
  p.innerHTML = h;
}

// ---- music and sounds of the place in view (sound.js, toolbox/atlas/build_sound.py; the game's gsound.c) ----------------------
// Each map starts two sound schemes (its mapinfo), and a sector that names schemes switches to them when you walk in; a sector
// that names none keeps what plays. A scheme has looping songs that play between two hours, and sounds fired at random. The
// game cuts from one to the other in 25 ms; here a track that goes on in the next place keeps playing and the others cross-fade.
const SND = (() => {
  const S = window.ArcanumSound; if (!S) { document.querySelector('.sndbar').hidden = document.getElementById('sndHead').hidden = true; return null; }
  const FADE_MUSIC = 3000, FADE_AMBIENT = 2000, TRAVEL_Z = 0.012, WALK = 12, NEAR = 4, HOURS = { day: 12, night: 22 };
  const key = (x, y) => x + ',' + y;
  const WORLD = new Map(S.world.sectors.map(r => [key(r[0], r[1]), r]));
  const MAPS = {}; for (const [k, m] of Object.entries(S.maps)) MAPS[k] = new Map((m.sectors || []).map(r => [key(r[0], r[1]), r]));
  let on = false, night = false, master = 0.7, pair = null, pairArea = null, where = null, place = '', active = true;
  try { master = +(localStorage.getItem('atlas-snd-vol') ?? 70) / 100; night = localStorage.getItem('atlas-snd-night') === '1'; } catch (_) {}
  const tracks = new Map();      // file -> { a: Audio, v: volume now, to: volume wanted, ms: fade length }
  const hourIn = (t, h) => !t || (t[0] <= t[1] ? h >= t[0] && h <= t[1] : h >= t[0] || h <= t[1]);   // "19-0": till midnight, as meant
  const url = f => 'data/sound/' + f.split('/').map(encodeURIComponent).join('/');
  const schemesOf = p => p === 'travel' ? [] : [...new Set(p)].filter(s => S.schemes[s]).map(s => S.schemes[s]);
  function wanted() {            // the songs that should play now, with their volume
    const out = new Map(), h = night ? HOURS.night : HOURS.day;
    if (!active || !on || !pair) return out;
    if (pair === 'travel') { out.set(S.travel, 0.6); return out; }
    for (const s of schemesOf(pair)) for (const e of s.list) if (e.song === 'loop' && hourIn(e.time, h)) out.set(e.f, Math.max(out.get(e.f) || 0, (e.vol || 100) / 100));
    return out;
  }
  function refresh() {
    const want = wanted();
    for (const [f, t] of tracks) if (!want.has(f)) t.to = 0;
    for (const [f, v] of want) {
      let t = tracks.get(f);
      if (!t) {
        const a = new Audio(url(f)); a.loop = true; a.volume = 0; a.play().catch(() => {});
        t = { a, v: 0, ms: f.startsWith('music/') ? FADE_MUSIC : FADE_AMBIENT }; tracks.set(f, t);
      }
      t.to = v;
    }
    showNow();
  }
  let last = performance.now();
  setInterval(() => {            // fades
    const now = performance.now(), dt = now - last; last = now;
    for (const [f, t] of tracks) {
      const step = dt / t.ms;
      t.v = t.v < t.to ? Math.min(t.to, t.v + step) : Math.max(t.to, t.v - step);
      t.a.volume = Math.max(0, Math.min(1, t.v * master));
      if (t.v === 0 && t.to === 0) { t.a.pause(); t.a.removeAttribute('src'); t.a.load(); tracks.delete(f); }
    }
  }, 50);
  let shots = 0;
  setInterval(() => {            // the sounds fired at random: n in 1000 every 250 ms, like gsound_update
    if (!active || !on || !pair || pair === 'travel' || shots >= 6) return;
    const h = night ? HOURS.night : HOURS.day;
    for (const s of schemesOf(pair)) for (const e of s.list) {
      if (e.song || !hourIn(e.time, h) || Math.random() * 1000 >= e.freq) continue;
      const v = e.vol ? e.vol[0] + Math.random() * (e.vol[1] - e.vol[0]) : 100;
      const a = new Audio(url(e.f)); a.volume = Math.min(1, v / 100 * master); shots++;
      a.onended = a.onerror = () => shots--; a.play().catch(() => shots--);
    }
  }, 250);
  // the area a spot belongs to, as the game names it: a town when the sector has the town's townmap (area_from_loc),
  // else a place the world map files the sector under, else the open country
  function areaAt(sx, sy) {
    const r = WORLD.get(key(sx, sy)), X = sx * 64 + 32, Y = sy * 64 + 32;
    if (r && r[4]) {
      const a = S.areas.reduce((b, a) => { const d = Math.max(Math.abs(a[1] - X), Math.abs(a[2] - Y)); return !b || d < b.d ? { a, d } : b; }, null);
      if (a && a.a[4] === r[4]) return a.a[0].split(',')[0];
    }
    const folder = r ? S.world.folders[r[5]] : '';
    return folder && S.areas.some(a => a[0] === folder) ? folder : 'Open country';
  }
  // where the view is -> the schemes the game would be playing there
  function locate(v) {
    if (!v || !v.tile) return;
    const sx = Math.floor(v.tile[0] / 64), sy = Math.floor(v.tile[1] / 64), map = v.map || null;
    if (!map && v.z < TRAVEL_Z) { where = null; return set('travel', 'The world map'); }
    const secs = map ? MAPS[map] : WORLD, sets = r => r && (r[2] || r[3]) ? [r[2], r[3]] : null;
    const def = map ? S.maps[map] && S.maps[map].def : S.world.def;
    const area = map ? map : areaAt(sx, sy);
    let p = null;
    if (where && where.map === map && Array.isArray(pair) && Math.max(Math.abs(sx - where.sx), Math.abs(sy - where.sy)) <= WALK) {
      // a short move is a walk: every sector on the way that names schemes switches to them, the last one stays...
      const n = Math.max(Math.abs(sx - where.sx), Math.abs(sy - where.sy));
      for (let i = 1; i <= n; i++) {
        const x = Math.round(where.sx + (sx - where.sx) * i / n), y = Math.round(where.sy + (sy - where.sy) * i / n);
        const q = secs && sets(secs.get(key(x, y)));
        if (q) { p = q; pairArea = map ? map : areaAt(x, y); }
      }
      // ...but only within the area it was set in: the game would keep a town's music out in the open country when no
      // sector on the way names other schemes; here leaving the area falls back to what is around
      if (!p && pairArea === area) p = pair;
    }
    if (!p) {
      // arriving: the sector itself, else (world map) the nearest sector around that names schemes, else the map's own
      p = secs && sets(secs.get(key(sx, sy)));
      for (let d = 1; !p && !map && d <= NEAR; d++)
        for (let dy = -d; dy <= d && !p; dy++) for (let dx = -d; dx <= d && !p; dx++)
          if (Math.max(Math.abs(dx), Math.abs(dy)) === d) p = sets(secs.get(key(sx + dx, sy + dy)));
      p = p || def || (Array.isArray(pair) ? pair : S.world.def);    // a map with no scheme of its own keeps what played
      pairArea = area;
    }
    where = { map, sx, sy };
    set(p, map ? (MP.maps.find(m => m.key === map) || {}).name || map : area);
  }
  function set(p, name) {
    if (Array.isArray(p) && p[0] === p[1]) p = [p[0], 0];                  // gsound_play_scheme: one scheme, once
    pair = p; place = name; refresh();
  }
  function showNow() {
    const el = document.getElementById('sndNow');
    el.hidden = !on || !pair;
    if (el.hidden) return;
    const h = night ? HOURS.night : HOURS.day;
    let what;
    if (pair === 'travel') what = '♪ Arcanum (the travel map)';
    else {
      const parts = schemesOf(pair).map(s => {
        const songs = s.list.filter(e => e.song === 'loop'), now = songs.filter(e => hourIn(e.time, h));
        const music = now.find(e => e.f.startsWith('music/'));
        if (music) return '♪ ' + music.f.slice(6, -4).replace(/_/g, ' ');
        if (songs.some(e => e.f.startsWith('music/'))) return '♪ no music at night';
        return s.list.length ? '≈ ' + s.name : '';
      }).filter(Boolean);
      what = parts.length ? parts.join(' · ') : 'silence';
    }
    el.innerHTML = `<b>${esc(place)}</b> · ${esc(what)}`;
  }
  const btn = document.getElementById('sndHead'), tbtn = document.getElementById('sndTime'), vol = document.getElementById('sndVol');
  const paint = () => {
    btn.innerHTML = `<span class="tb-ic">${on ? '🔊' : '🔈'}︎</span>`; btn.classList.toggle('on', on); btn.title = on ? 'Stop the music and sounds' : 'Play the music and the sounds of the place in view, as the game does';
    tbtn.hidden = vol.hidden = !on; tbtn.textContent = night ? '☾ Night' : '☀ Day'; gauge();
  };
  // the volume as the game's option gauge: 0-10, an arrow moves one step and does not wrap round
  const gbar = vol.querySelector('.gbar'), steps = () => Math.round(master * 10);
  const gauge = () => {
    gbar.firstChild.style.width = steps() * 10 + '%'; gbar.setAttribute('aria-valuenow', steps());
    vol.querySelector('[data-d="-1"]').disabled = steps() <= 0; vol.querySelector('[data-d="1"]').disabled = steps() >= 10;
  };
  const setSteps = n => { master = Math.max(0, Math.min(10, n)) / 10; try { localStorage.setItem('atlas-snd-vol', Math.round(master * 100)); } catch (_) {} gauge(); };
  vol.querySelectorAll('button').forEach(b => b.onclick = () => setSteps(steps() + +b.dataset.d));
  gbar.onclick = e => { const r = gbar.getBoundingClientRect(); setSteps(Math.round((e.clientX - r.left) / r.width * 10)); };
  btn.onclick = () => { on = !on; paint(); if (on && !pair) locate(lastView || { map: null, tile: [90226, 84176], z: 0.1 }); refresh(); };
  tbtn.onclick = () => { night = !night; try { localStorage.setItem('atlas-snd-night', night ? '1' : '0'); } catch (_) {} paint(); refresh(); };
  const activity = () => { active = !document.hidden && document.body.classList.contains('screen-atlas'); refresh(); };
  document.addEventListener('visibilitychange', activity);
  window.atlasSound = activity;
  paint(); activity();
  return { view: v => { if (on) locate(v); else where = null; }, screen: activity, state: () => ({ on, night, pair, place, tracks: [...tracks].map(([f, t]) => [f, +t.v.toFixed(2), t.to]) }) };
})();

// ---- links to a view of the map ---------------------------------------------------------------------------------------
let lastView = null;       // what the map reports: { map (key of one of the other maps, or null), tile, z }
// The address bar always holds a link to where you are: the view of the map, or the page you are on. It waits until the
// page has read the link it was opened with (linkLive).
let linkLive = false, linkTimer = 0;
function syncLink() {
  if (!linkLive) return;
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    const u = new URL(location.href);
    u.hash = current === 'atlas' && lastView ? 'v=' + encodeURIComponent(JSON.stringify({ ...lastView, t: document.getElementById('atlasTitle').textContent }))
      : BROWSERS[current] && BROWSERS[current].query ? current + '&' + BROWSERS[current].query : current;
    try { history.replaceState(null, '', u); } catch (_) {}
  }, 250);
}
// A link opens the atlas on that view. The map page needs a moment to start (it unpacks the world first), so the request is
// repeated until the map reports being there.
let wantedView = null;
function restoreView() {
  const m = /[#&]v=([^&]+)/.exec(location.hash); if (!m) return false;
  try {
    const v = JSON.parse(decodeURIComponent(m[1]));
    if (!Array.isArray(v.tile)) return false;
    wantedView = v; go('atlas'); showPlace(v.t || 'World map');
    let tries = 0;
    const send = () => {
      if (!wantedView || ++tries > 40) { clearInterval(timer); return; }
      worldFrame.contentWindow.postMessage({ type: 'atlas-setview', map: v.map, tile: v.tile, z: v.z }, '*');
    };
    const timer = setInterval(send, 400); send();
    return true;
  } catch (_) { return false; }
}
const viewReached = lv => {                       // the map reports where it is: done once it is on the wanted spot
  if (wantedView && lv && lv.map === wantedView.map && Math.abs(lv.tile[0] - wantedView.tile[0]) + Math.abs(lv.tile[1] - wantedView.tile[1]) <= 6) wantedView = null;
};

// A label is a waypoint, a note, an altar or a quest object: people and containers have panels of their own (selectNpc,
// selectContainer), straight from their .mob.
function selectLabel(l) {
  // a plain waypoint (one way, nothing to read, no lock, no quest) just takes you there; in the Advanced view it shows its files
  const files = advOn() && l.obj;
  if (!files && l.to && l.to.length === 1 && !l.lock && !l.desc && !l.god && !(l.tile && questsAt(l.mapKey || l.place, l.tile).length)) {
    const t = l.to[0]; travelTo(t.map, t.place, t.tile); return;
  }
  // an altar label that is not on the altar itself: the game's altar a few steps away
  const altarNear = () => (l.god || l.cat.includes('altar')) && l.tile ? IT.containers.findIndex(c => c.altar && c.tile && c.place === (l.map >= 0 ? l.mapKey : l.place)
    && !!c.world === !(l.map >= 0) && Math.abs(c.tile[0] - l.tile[0]) + Math.abs(c.tile[1] - l.tile[1]) <= 25) : -1;
  const boxIdx = altarNear(), box = boxIdx >= 0 ? IT.containers[boxIdx] : null;
  // nothing to say but its name: a click does nothing
  if (!files && !l.desc && !l.god && !l.to && !l.lock && !box && !(l.tile && questsAt(l.mapKey || l.place, l.tile).length)) return;
  const p = openPanel();
  const pic = box ? boxFace(box) : `<span class="portrait chestpic">${ICON[l.cat[0]] || '❖'}</span>`;
  let h = `<div class="panel-head">${pic}
    <div><h3>${esc(l.text)}</h3>
    <div class="cats">${l.cat.map(c => `<span>${ICON[c] || ''} ${c}</span>`).join('')}</div></div></div>`;
  if (l.desc) h += `<div class="sec">${l.desc}</div>`;
  if (l.god && !(box && box.altar)) {        // an altar the game runs from a script on the floor: its blessing by the god's name
    const god = l.text.replace(/['’]s altar$/i, ''), b = (IT.blessings || []).find(([t]) => nkey(t).includes(nkey(god)));
    h += `<div class="sec"><div class="sec-t">Altar of ${esc(god)}</div><dl class="kv">${l.offering ? `<dt>Offering</dt><dd>${esc(l.offering)}</dd>` : ''}
      <dt>Blessing</dt><dd>${b ? `${esc(b[0])}<div class="note">${esc(b[1])}</div>` : esc(l.blessing || '')}</dd></dl></div>`;
  }
  if (l.to) h += `<div class="sec"><div class="sec-t">Waypoint${l.what ? ` · ${esc(l.what)}` : ''}</div>${l.to.map((t, i) => `<button class="tbtn" data-travel="${i}">🚪 Travel to ${esc(t.place)}</button>`).join('')}</div>`;
  if (l.lock) {          // a locked trap door: the lock of the container that stood on the same tile
    const keys = (l.lock.keys || []).map(k => `<button class="keylink" data-item="${k}">🔑 ${esc(IT.items[k].name)}</button>`).join(' ');
    h += `<div class="sec"><div class="sec-t">Lock</div><div>🔒 Locked${l.lock.locked ? ` · difficulty ${l.lock.locked}` : ''}</div>
      ${l.lock.held ? '<div>✨ Magically held</div>' : ''}${l.lock.jammed ? '<div>⚙ Jammed</div>' : ''}${keys ? `<div style="margin-top:4px">Opens with ${keys}</div>` : ''}</div>`;
  }
  if (l.tile) h += questsSection(questsAt(l.mapKey || l.place, l.tile));
  if (box) h += containerBody(boxIdx);
  p.innerHTML = h + advancedSection(l.obj || (box && box.file));
  wireItems(p);
  p.querySelectorAll('[data-travel]').forEach(b => { b.onclick = () => { const t = l.to[+b.dataset.travel]; travelTo(t.map, t.place, t.tile); }; });
}

/* ------------------------------------------------------------------ atlas: every item */
// nothing in the game hands it out: never lying about, carried, in a chest, sold or crafted (a part nobody can get doesn't count)
const OBTAINABLE = i => { const w = WHERE[i]; return w.c.length || w.b.length || w.n.length || w.g.length || w.s.length || w.x.length || MADE[i].length || TEACHES[i].length; };
const NOT_IN_GAME = i => !OBTAINABLE(i);
const SUPPLY_KINDS = ['Ammunition', 'Gold', 'Key ring'];
const KIND_ORDER = ['Weapon', 'Armor', 'Supplies', 'Food & potion', 'Scroll', 'Written', 'Key', 'Generic'];
const KIND_ICON = { Weapon: '⚔', Armor: '🛡', Supplies: '🎒', 'Food & potion': '🧪', Scroll: '📜', Written: '📖', Key: '🔑', Generic: '⚙', 'Not in game': '🚫' };
const SHOWN = IT.items.map((it, i) => i).filter(i => !IT.items[i].hidden);
const kindOf = it => SUPPLY_KINDS.includes(it.kind) ? 'Supplies' : it.kind;
const FILTERS = [
  ['all', 'All items', () => true],
  ...KIND_ORDER.map(k => [k, k, i => kindOf(IT.items[i]) === k]),
  ['sep'],
  ['magick', '✨ Magickal', i => IT.items[i].magick && !IT.items[i].hexed],
  ['hexed', '☠ Hexed', i => IT.items[i].hexed],
  ['tech', '⚙ Technological', i => IT.items[i].tech],
  ['crafted', '🔧 Can be crafted', i => MADE[i].length > 0],
];
// which game an item turns up in: Arcanum itself or a module (modules.js). A chest, person or spot belongs to the module of its
// map, a merchant's stock box to its merchant, a random list to whoever rolls it; crafting counts for Arcanum.
const GAMES = ['Arcanum', ...((window.ArcanumModules || {}).modules || [])];
const gameOf = o => (!o.world && MAP_BY_KEY.has(nkey(o.place)) && MP.maps[MAP_BY_KEY.get(nkey(o.place))].module) || 'Arcanum';
const scriptGame = g => g.proto ? 'Arcanum' : gameOf(g);      // "any <creature>": a prototype, counted for Arcanum
const NPC_GAME = IT.npcs.map(gameOf), CON_GAME = IT.containers.map(c => c.storeOf != null ? NPC_GAME[c.storeOf] : gameOf(c));
const IN_GAME = new Map(GAMES.map(g => [g, new Set()]));
{
  const add = (g, i) => IN_GAME.get(g)?.add(i);
  IT.containers.forEach((c, ci) => c.items.forEach(([i]) => add(CON_GAME[ci], i)));
  IT.npcs.forEach((n, ni) => n.items.forEach(([i]) => add(NPC_GAME[ni], i)));
  IT.ground.forEach(g => add(gameOf(g), g.item));
  (IT.scripted || []).forEach(g => g.name && add(scriptGame(g), g.item));
  for (const [id, s] of Object.entries(IT.sources)) {
    const u = SOURCE_USERS[id];
    if (u) new Set([...u.c.map(ci => CON_GAME[ci]), ...u.m.map(ni => NPC_GAME[ni]), ...u.n.map(ni => NPC_GAME[ni])]).forEach(g => s.items.forEach(([i]) => add(g, i)));
  }
  IT.items.forEach((it, i) => (MADE[i].length || TEACHES[i].length) && add('Arcanum', i));
}
// the filter: a game, or the items nothing anywhere hands out ("Not in game")
const NOT_IN_ANY = 'Not in game';
IN_GAME.set(NOT_IN_ANY, new Set(SHOWN.filter(NOT_IN_GAME)));
const itemView = { filter: 'all', q: '', game: 'Arcanum', sel: null };
const itemPool = () => SHOWN.filter(i => IN_GAME.get(itemView.game).has(i));
function buildKinds() {
  const el = document.getElementById('itemKinds'), pool = itemPool();
  el.innerHTML = FILTERS.map(([k, label, f]) => k === 'sep' ? '<div class="locgroup">Show</div>' :
    `<button class="loc" data-filter="${k}">${KIND_ICON[k] ? KIND_ICON[k] + ' ' : ''}${label}<span class="n">${pool.filter(f).length}</span></button>`).join('');
  el.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { itemView.filter = b.dataset.filter; renderItems(); });
  document.getElementById('itemCount').textContent = pool.length;
}
document.getElementById('itemSearch').oninput = e => { itemView.q = e.target.value.trim().toLowerCase(); renderItems(); };
{
  const sel = document.getElementById('itemGame');
  sel.innerHTML = [...GAMES, NOT_IN_ANY].map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  sel.onchange = e => {
    itemView.game = e.target.value; buildKinds(); renderItems();
    if (itemView.sel != null) pickItem(itemView.sel);           // the open card follows the chosen game
  };
}
buildKinds();
function renderItems() {
  const [, label, f] = FILTERS.find(x => x[0] === itemView.filter);
  document.querySelectorAll('#itemKinds [data-filter]').forEach(b => b.classList.toggle('on', b.dataset.filter === itemView.filter));
  document.querySelectorAll('#atlasNav [data-go="items"]').forEach(b => b.classList.toggle('on', current === 'items'));
  let list = itemPool().filter(f).filter(i => !itemView.q || IT.items[i].name.toLowerCase().includes(itemView.q));
  list.sort((a, b) => IT.items[a].name.localeCompare(IT.items[b].name));
  document.getElementById('itemsTitle').textContent = label;
  document.getElementById('itemsCrumb').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  const grid = document.getElementById('itemGrid');
  grid.innerHTML = list.map(i => `<button class="itile${cls(IT.items[i])}${i === itemView.sel ? ' on' : ''}" data-pick="${i}">${spr(i, 56)}<span>${esc(IT.items[i].name)}</span></button>`).join('')
    || '<div class="flavour" style="padding:20px">Nothing by that name.</div>';
  grid.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => pickItem(+b.dataset.pick));
}
function pickItem(i) {
  itemView.sel = i;
  document.querySelectorAll('#itemGrid .itile').forEach(b => b.classList.toggle('on', +b.dataset.pick === i));
  const p = document.getElementById('itemPanel');
  p.innerHTML = itemDetail(i, GAMES.includes(itemView.game) ? itemView.game : null);
  p.scrollTop = 0;
  wireDetail(p, pickItem);
}
renderItems();

/* ------------------------------------------------------------------ atlas: library (library.js)
   Draws a book, note, newspaper, telegram or plaque the way the game's reading screen does: its own background
   picture and bitmap fonts, text laid out in the same rectangles (coordinates are those of the 800 x 400 reading
   window; the 132 px side bar is not drawn, so everything moves 132 px to the left). */
const LB = window.ArcanumLibrary;
const LIB_KINDS = [[0, "Books", "📖"], [1, "Notes", "📝"], [2, "Newspapers", "📰"], [3, "Telegrams", "✉️"], [6, "Plaques", "🪧"]];
const LIB_ONE = { 0: "Book", 1: "Note", 2: "Newspaper", 3: "Telegram", 6: "Plaque" };
const LIB_BG = { 0: 477, 1: 489, 2: 487, 3: 491, 6: 633 }, LIB_BG_VENDIGROTH = 817;
const LIB_SIDEBAR = 132, LIB_W = 668, LIB_H = 400, LIB_TEN = 10;
const R = (x, y, w, h) => ({ x, y, w, h });
const LIB_NOTE = R(349, 49, 215, 300), LIB_TELE_TEXT = R(327, 126, 250, 240), LIB_TELE_FINE = R(335, 90, 234, 20), LIB_PLAQUE = R(269, 40, 428, 327);
const LIB_BOOK = [R(227, 57, 200, 290), R(476, 57, 200, 290)];
const LIB_NEWS = [R(186, 97, 255, 90), R(188, 196, 120, 175), R(328, 196, 120, 175), R(460, 103, 120, 270), R(592, 103, 120, 270)];
// [font, line in the .mes, x, y, alignment: 0 left / 1 centre / 2 right]
const LIB_TELE_PARTS = [[481, 1000, 342, 35, 1], [481, 1001, 342, 41, 1], [481, 1002, 321, 50, 0], [481, 1003, 321, 59, 0], [481, 1004, 321, 68, 0],
  [479, 1005, 450, 36, 1], [479, 1006, 450, 61, 1], [481, 1007, 558, 35, 1], [481, 1008, 539, 50, 0], [481, 1009, 539, 60, 0], [481, 1010, 539, 69, 0]];
const LIB_PAPER_PARTS = [[485, 0, 216, 44, 1], [484, 1, 453, 41, 1], [485, 0, 689, 44, 1], [482, 2, 194, 76, 0], [482, 3, 449, 76, 1], [482, 2, 712, 76, 2]];
const LIB_VENDIGROTH_PARTS = [[485, 0, 216, 44, 1], [815, 4, 453, 41, 1], [485, 0, 689, 44, 1], [482, 2, 194, 76, 0], [482, 5, 449, 76, 1], [482, 2, 712, 76, 2]];

// the pictures: decoded once, on first use
let libReady = null;
function libLoad() {
  if (!libReady) {
    const img = src => new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = src; });
    const jobs = [];
    LB.pics = { bg: {}, font: {} };
    for (const [n, b] of Object.entries(LB.backgrounds)) jobs.push(img(b.src).then(im => { LB.pics.bg[n] = im; }));
    for (const [n, f] of Object.entries(LB.fonts)) {
      LB.pics.font[n] = {};
      for (const c of ["black", "white"]) jobs.push(img(f[c]).then(im => { LB.pics.font[n][c] = im; }));
    }
    libReady = Promise.all(jobs);
  }
  return libReady;
}

// text in a bitmap font: the pen advances by each glyph's advance, the last glyph counts its own width
const libAdv = (f, ch, last) => { const g = f.glyphs[ch.charCodeAt(0)]; return g ? (last ? g[1] : g[2]) : 4; };
const libWidth = (f, s) => { let w = 0; for (let i = 0; i < s.length; i++) w += libAdv(f, s[i], i === s.length - 1); return w; };
function libWrap(f, text, maxW) {
  const lines = [];
  for (const hard of text.split("\n")) {
    let line = "";
    for (const word of hard.split(" ")) {
      const next = line ? line + " " + word : word;
      if (!line || libWidth(f, next) <= maxW) line = next; else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}
function libDrawLines(ctx, num, color, lines, r, centered) {
  const f = LB.fonts[num], strip = LB.pics.font[num][color];
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x - LIB_SIDEBAR, r.y, r.w, r.h); ctx.clip();
  lines.forEach((line, row) => {
    let x = r.x - LIB_SIDEBAR + (centered ? Math.floor((r.w - libWidth(f, line)) / 2) : 0);
    const y = r.y + row * f.h;
    for (let i = 0; i < line.length; i++) {
      const g = f.glyphs[line.charCodeAt(i)];
      if (g && g[1]) ctx.drawImage(strip, g[0], 0, g[1], f.h, x, y, g[1], f.h);
      x += libAdv(f, line[i], i === line.length - 1);
    }
  });
  ctx.restore();
}
const libWrite = (ctx, text, num, color, r, centered) => libDrawLines(ctx, num, color, libWrap(LB.fonts[num], text, r.w), r, centered);
function libElement(ctx, text, num, x, y, align) {              // one line placed by its left edge, centre or right edge
  const f = LB.fonts[num], w = libWidth(f, text);
  libDrawLines(ctx, num, "black", [text], R(align === 0 ? x : align === 1 ? x - Math.floor(w / 2) : x - w, y, w + 2, f.h), false);
}
// "492c text": font number, c = centred (anything else = left), then the text
function libParse(s) {
  let i = 0;
  while (i < s.length && s[i] >= "0" && s[i] <= "9") i++;
  const font = parseInt(s, 10) || 0, centered = s[i] === "c" || s[i] === "C";
  if (i < s.length) i++;
  if (/\s/.test(s[i] || "")) i++;
  return [font, centered, s.slice(i)];
}
// a paragraph in a rectangle: { fit: true, used: height } or, when it does not fit, the part that does is drawn
// and { fit: false, off: characters used } says where the next column or page goes on
function libParagraph(ctx, str, num, centered, r, color) {
  const f = LB.fonts[num];
  if (!f) return { fit: true, used: 0 };
  const height = s => libWrap(f, s, r.w).length * f.h;
  if (height(str) > r.h) {
    let cut = 0;
    for (let pos = 0; pos < str.length; pos++) {
      if (str[pos] === " " || str[pos] === "\n") { if (height(str.slice(0, pos)) > r.h) break; cut = pos; }
    }
    if (cut > 0) libDrawLines(ctx, num, color, libWrap(f, str.slice(0, cut), r.w), r, centered);
    return { fit: false, off: cut };
  }
  libDrawLines(ctx, num, color, libWrap(f, str, r.w), r, centered);
  return { fit: true, used: height(str) };
}
// a book page or a plaque: paragraphs one after another until one does not fit; returns where the next page starts
function libPageLike(ctx, kind, base, r, at, color) {
  const T = LB.mes[kind];
  let n = at.num;
  if (n >= base + LIB_TEN || !(n in T)) return null;
  let [fn, c, str] = libParse(T[n]);
  let box = { ...r }, res = libParagraph(ctx, str.slice(at.off), fn, c, box, color);
  if (!res.fit) return { num: n, off: at.off + res.off };
  for (;;) {
    box.y += res.used; box.h -= res.used;
    n++;
    if (n >= base + LIB_TEN || !(n in T)) return null;
    [fn, c, str] = libParse(T[n]);
    res = libParagraph(ctx, str, fn, c, box, color);
    if (!res.fit) return { num: n, off: res.off };
  }
}
function libBookPages(base) {                                   // where each page starts; two are shown at a time
  const scratch = document.createElement("canvas").getContext("2d"), pages = [{ num: base, off: 0 }];
  for (let i = 0; i < pages.length && pages.length < 100; i += 2) {
    let at = pages[i];
    for (let side = 0; side < 2 && at; side++) {
      const next = libPageLike(scratch, 0, base, LIB_BOOK[side], at, "black");
      at = next && (next.num !== at.num || next.off !== at.off) ? next : null;
      if (at && pages.length === i + side + 1) pages.push(at);
    }
  }
  return pages;
}
function libPaper(ctx, num, vendigroth) {                       // headline, then the story over the columns, then filler articles
  const T = LB.mes[2], rects = LIB_NEWS.map(r => ({ ...r }));
  for (const [font, line, x, y, align] of vendigroth ? LIB_VENDIGROTH_PARTS : LIB_PAPER_PARTS) libElement(ctx, T[line] || "", font, x, y, align);
  if (num in T) { const [fn, c, str] = libParse(T[num]); libParagraph(ctx, str, fn, c, rects[0], "black"); }
  let n = num + 1;
  if (!(n in T)) return;
  let [fn, c, str] = libParse(T[n]), col = 1, box = { ...rects[1] }, res;
  const flow = () => {                                          // false when the columns are full
    while (!(res = libParagraph(ctx, str, fn, c, box, "black")).fit) {
      if (++col >= rects.length) return false;
      box = { ...rects[col] }; str = str.slice(res.off);
    }
    return true;
  };
  for (;;) {
    if (!flow()) return;
    box.y += res.used; box.h -= res.used;
    if (++n >= num + LIB_TEN || !(n in T)) break;
    [fn, c, str] = libParse(T[n]);
  }
  const fillers = Object.keys(T).filter(k => k >= 10 && k <= 999).length;
  let f = Math.floor(num / LIB_TEN) + 10;
  if (f >= fillers + 10) f = 10;
  if (!(f in T)) return;
  [fn, c, str] = libParse(T[f]);
  for (let guard = 0; guard < 200; guard++) {
    if (!flow()) return;
    if (++f >= fillers + 10) f = 10;
    if (!(f in T)) return;
    [fn, c, str] = libParse(T[f]);
    box.y += res.used; box.h -= res.used;
  }
}
// draws a document into the 668 x 400 canvas; `page` is the left page of a book. Returns the number of book pages.
function libDraw(canvas, d, page) {
  const ctx = canvas.getContext("2d"), T = LB.mes[d.k], s = d.s;
  canvas.width = LIB_W; canvas.height = LIB_H;
  ctx.drawImage(LB.pics.bg[d.v ? LIB_BG_VENDIGROTH : LIB_BG[d.k]], 0, 0);
  if (d.k === 0) {
    const pages = libBookPages(s);
    for (let side = 0; side < 2; side++) if (pages[page + side]) libPageLike(ctx, 0, s, LIB_BOOK[side], pages[page + side], "black");
    return pages.length;
  }
  if (d.k === 1 || d.k === 3) {
    let text = "";
    for (let i = 0; i < LIB_TEN && (s + i) in T; i++) text += T[s + i] + (d.k === 1 ? "\n" : T[1012]);
    if (d.k === 1) libWrite(ctx, text, 497, "black", LIB_NOTE, false);
    else {
      for (const [font, line, x, y, align] of LIB_TELE_PARTS) libElement(ctx, T[line] || "", font, x, y, align);
      libWrite(ctx, T[1011], 481, "black", LIB_TELE_FINE, false);
      libWrite(ctx, text, 480, "black", LIB_TELE_TEXT, false);
    }
  } else if (d.k === 2) libPaper(ctx, s, d.v);
  else if (d.k === 6) libPageLike(ctx, 6, s, LIB_PLAQUE, { num: s, off: 0 }, "white");
  return 1;
}

// ---- the list ---------------------------------------------------------------------------------------------
const LIB_ONE_LINE = s => s.replace(/\s+/g, " ").trim();
const LIB_NAME_USES = {};
LB.docs.forEach(d => d.n.forEach(n => { LIB_NAME_USES[n] = (LIB_NAME_USES[n] || 0) + 1; }));
LB.docs.forEach((d, i) => {
  const T = LB.mes[d.k], lines = [];
  for (let k = 0; k < LIB_TEN && (d.s + k) in T; k++) {
    const line = LIB_ONE_LINE(d.k === 1 || d.k === 3 ? T[d.s + k] : libParse(T[d.s + k])[2]);   // notes and telegrams: no font prefix
    if (line && !/^\d+$/.test(line)) lines.push(line);                     // a bare number is a picture in the book, not words
  }
  d.lines = lines;
  d.text = lines.join(" ").toLowerCase();
  const own = d.n.find(n => LIB_NAME_USES[n] === 1);                      // an item with a name of its own, else the first line
  const short = s => s.length > 70 ? s.slice(0, 67).replace(/\s+\S*$/, "") + "…" : s;
  d.title = own || short(lines[0] || LIB_ONE[d.k]);
  d.sub = own ? short(lines[0] || "") : short(lines[1] || "");
  d.id = i;
});
LB.docs = LB.docs.filter(d => !/^test message/i.test(d.lines[0] || "")).map((d, i) => Object.assign(d, { id: i }));   // a left-over developer line
// the documents sit under their category in the left column; pressing the open category folds it again
const libView = { kind: 0, q: "", sel: null, page: 0 };
const libMatch = d => !libView.q || d.title.toLowerCase().includes(libView.q) || d.text.includes(libView.q);
const libListOf = k => LB.docs.filter(d => d.k === k && libMatch(d)).sort((a, b) => a.title.localeCompare(b.title));
document.getElementById("libSearch").oninput = e => { libView.q = e.target.value.trim().toLowerCase(); renderLibrary(); };
document.getElementById("libCount").textContent = LB.docs.length;
function renderLibrary() {
  document.querySelectorAll('#atlasNav [data-go="library"]').forEach(b => b.classList.toggle("on", current === "library"));
  const el = document.getElementById("libKinds");
  let shown = 0;
  el.innerHTML = LIB_KINDS.map(([k, label, icon]) => {
    const list = libListOf(k), open = libView.kind === k;
    shown += list.length;
    return `<button class="loc${open ? " on" : ""}" data-kind="${k}">${icon} ${label}<span class="n">${list.length}</span></button>` +
      (open ? `<div class="libdocs">${list.map(d => `<button class="ldoc${d.id === libView.sel ? " on" : ""}" data-doc="${d.id}"><b>${esc(d.title)}</b><span>${esc(d.sub || LIB_ONE[d.k])}</span></button>`).join("")
        || `<div class="flavour" style="padding:6px 4px">Nothing by that name.</div>`}</div>` : "");
  }).join("");
  el.querySelectorAll("[data-kind]").forEach(b => b.onclick = () => { libView.kind = libView.kind === +b.dataset.kind ? null : +b.dataset.kind; renderLibrary(); });
  el.querySelectorAll("[data-doc]").forEach(b => b.onclick = () => readDoc(+b.dataset.doc, 0));
  const kind = LIB_KINDS.find(k => k[0] === libView.kind);
  document.getElementById("libTitle").textContent = kind ? kind[1] : "Library";
  document.getElementById("libCrumb").textContent = `${shown} to read`;
  const on = el.querySelector(".ldoc.on"); if (on) on.scrollIntoView({ block: "nearest" });
}
// Up / Down walk through the open category
document.addEventListener("keydown", e => {
  if (current !== "library" || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey) return;
  const list = libView.kind == null ? [] : libListOf(libView.kind);
  if (!list.length) return;
  e.preventDefault();
  const at = list.findIndex(d => d.id === libView.sel), next = at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
  if (next === at) return;
  readDoc(list[next].id, 0).then(renderLibrary);
});
async function readDoc(id, page) {
  const d = LB.docs[id];
  if (libView.sel !== id) document.getElementById("libReader").scrollTop = 0;
  libView.sel = id; libView.page = page;
  document.querySelectorAll("#libKinds .ldoc").forEach(b => b.classList.toggle("on", +b.dataset.doc === id));
  await libLoad();
  const reader = document.getElementById("libReader");
  reader.innerHTML = `<canvas></canvas><div class="lib-pager" id="libPager"></div>`;
  const pages = libDraw(reader.querySelector("canvas"), d, page);
  if (d.k === 0 && pages > 2) {
    const pager = document.getElementById("libPager");
    pager.innerHTML = `<button id="libPrev"${page > 0 ? "" : " disabled"}>◀ Previous</button><span>Pages ${page + 1}–${Math.min(page + 2, pages)} of ${pages}</span><button id="libNext"${page + 2 < pages ? "" : " disabled"}>Next ▶</button>`;
    document.getElementById("libPrev").onclick = () => readDoc(id, page - 2);
    document.getElementById("libNext").onclick = () => readDoc(id, page + 2);
  }
  const found = d.f.map(([place, world, tile, by, count]) =>
    `<div class="wrow">${whoLink({ world: !!world, tile, place }, `${esc(by || "Lying on the ground")}${count > 1 ? ` <b>×${count}</b>` : ""}`, by ? spotAttr({ world: !!world, tile, place }, true) : "")}${placeLink({ world: !!world, tile, place })}</div>`).join("");
  const p = document.getElementById("libPanel");
  p.innerHTML = `<div class="idet-head"><div><h3>${esc(d.title)}</h3><div class="meta">${LIB_ONE[d.k]}${d.v ? " · Vendigroth Times" : ""}${pages > 2 ? ` · ${pages} pages` : ""}</div></div></div>
    <div class="sec"><div class="sec-t">Where to find it</div>${found || `<div class="flavour">No copy is placed anywhere in the world; the game can still show it in a conversation, on a sign or during an event.</div>`}</div>`;
  wireDetail(p, () => {});
}

/* ------------------------------------------------------------------ atlas: demographics (demographics.js) */
const DM = window.ArcanumPeople;
const demo = { kind: 0, place: null, race: null, gender: null };   // kind: index into DM.kinds, -1 = every kind of creature
const KIND_PLURAL = { Person: 'People', Animal: 'Animals', Monster: 'Monsters', Undead: 'Undead', Mechanical: 'Machines' };
const LEVEL_STEPS = [[1, 5], [6, 10], [11, 15], [16, 20], [21, 25], [26, 30], [31, 40], [41, 99]];
const demoRows = skip => DM.people.filter(r => (demo.kind < 0 || r[1] === demo.kind) && (skip === 'place' || demo.place == null || r[0] === demo.place)
  && (skip === 'race' || demo.race == null || r[2] === demo.race) && (skip === 'gender' || demo.gender == null || r[3] === demo.gender));
const pct = (n, of) => of ? Math.round(n * 1000 / of) / 10 : 0;
function demoBars(rows, key, labels, attr) {
  const counts = labels.map(() => ({ 0: 0, 1: 0 }));
  rows.forEach(r => counts[key(r)][r[3] === 0 ? 0 : 1]++);   // (a creature without a gender counts on the male side; only kinds that have none use this)
  const max = Math.max(1, ...counts.map(c => c[0] + c[1]));
  return labels.map((l, i) => ({ l, i, n: counts[i][0] + counts[i][1], f: counts[i][0], m: counts[i][1] })).filter(x => x.n)
    .sort((a, b) => b.n - a.n).map(x => `<button class="dbar${demo[attr] === x.i ? ' on' : ''}" data-${attr}="${x.i}"><span>${esc(x.l)}</span>
      <span class="tr"><span class="f1" style="width:${x.m * 100 / max}%"></span><span class="f0" style="width:${x.f * 100 / max}%"></span></span><b>${x.n}</b></button>`).join('');
}
function renderDemo() {
  const kinds = DM.kinds, all = DM.people;
  document.getElementById('demoCount').textContent = all.length;
  document.getElementById('demoKinds').innerHTML = [['-1', 'Every creature', all.length], ...kinds.map((k, i) => [String(i), KIND_PLURAL[k] || k, all.filter(r => r[1] === i).length])]
    .map(([v, label, n]) => `<button class="loc${+v === demo.kind ? ' on' : ''}" data-kind="${v}">${label}<span class="n">${n}</span></button>`).join('');
  const inKind = all.filter(r => demo.kind < 0 || r[1] === demo.kind);
  const pc = {}; inKind.forEach(r => pc[r[0]] = (pc[r[0]] || 0) + 1);
  const placeList = Object.entries(pc).sort((a, b) => b[1] - a[1] || DM.places[a[0]].localeCompare(DM.places[b[0]]));
  document.getElementById('demoPlaces').innerHTML = '<div class="locgroup">Where</div>' +
    `<button class="loc${demo.place == null ? ' on' : ''}" data-place="">All of Arcanum<span class="n">${inKind.length}</span></button>` +
    placeList.map(([p, n]) => `<button class="loc${demo.place === +p ? ' on' : ''}" data-place="${p}">${esc(DM.places[p])}<span class="n">${n}</span></button>`).join('');
  const rows = demoRows(), total = rows.length, females = rows.filter(r => !r[3]).length, lv = rows.filter(r => r[4] > 0);
  const kindName = demo.kind < 0 ? 'creature' : DM.kinds[demo.kind] === 'Person' ? 'person' : DM.kinds[demo.kind].toLowerCase();
  const plural = n => kindName === 'person' ? (n === 1 ? 'person' : 'people') : kindName + (n === 1 ? '' : 's');
  const avg = lv.length ? Math.round(lv.reduce((s, r) => s + r[4], 0) / lv.length * 10) / 10 : 0;
  document.getElementById('demoTitle').textContent = demo.place == null ? 'Everyone in Arcanum' : DM.places[demo.place];
  document.getElementById('demoCrumb').textContent = [demo.race != null ? DM.races[demo.race] : '', demo.gender != null ? (demo.gender ? 'male' : 'female') : '']
    .filter(Boolean).join(' · ') || `${total} ${plural(total)}`;
  const hist = LEVEL_STEPS.map(([a, b]) => lv.filter(r => r[4] >= a && r[4] <= b).length);
  const hmax = Math.max(1, ...hist);
  // the game gives a race and a gender to people only: undead, monsters, animals and machines are told apart by kind
  const isPerson = demo.kind === 0, nPlaces = new Set(rows.map(r => r[0])).size;
  const kindCounts = DM.kinds.map((k, i) => demoRows().filter(r => r[1] === i).length), kmax = Math.max(1, ...kindCounts);
  document.getElementById('demoBody').innerHTML = !total ? '<div class="flavour">Nobody matches.</div>' : `
    <div class="dcard wide"><div class="dbig"><div><b>${total}</b>${plural(total)}</div>
      ${isPerson ? `<div><b>${pct(females, total)}%</b>female</div><div><b>${pct(total - females, total)}%</b>male</div>` : ''}
      <div><b>${avg || '–'}</b>average level</div><div><b>${nPlaces}</b>place${nPlaces === 1 ? '' : 's'}</div></div></div>
    ${demo.kind < 0 ? `<div class="dcard"><h4>Kinds</h4>${DM.kinds.map((k, i) => [k, i, kindCounts[i]]).filter(x => x[2]).sort((a, b) => b[2] - a[2]).map(([k, i, n]) =>
      `<button class="dbar" data-kindbar="${i}"><span>${KIND_PLURAL[k] || k}</span><span class="tr"><span class="f1" style="width:${n * 100 / kmax}%"></span></span><b>${n}</b></button>`).join('')}</div>` : ''}
    ${isPerson ? `<div class="dcard"><h4>Races</h4>${demoBars(demoRows('race'), r => r[2], DM.races, 'race')}
      <div class="dkey"><span><i class="f1" style="background:var(--atlas)"></i>male</span><span><i style="background:#b86f8f"></i>female</span></div></div>
    <div class="dcard"><h4>Gender</h4>${[['0', 'Female'], ['1', 'Male']].map(([g, l]) => {
      const n = demoRows('gender').filter(r => r[3] === +g).length; return `<button class="dbar${demo.gender === +g ? ' on' : ''}" data-gender="${g}"><span>${l}</span>
      <span class="tr"><span style="width:${pct(n, demoRows('gender').length)}%;background:${g === '0' ? '#b86f8f' : 'var(--atlas)'}"></span></span><b>${n}</b></button>`; }).join('')}</div>` : ''}
    <div class="dcard"><h4>Levels</h4><div class="dhist">${hist.map((n, i) => `<div class="col" title="${n}">${n || ''}<span style="height:${n * 100 / hmax}%"></span>${LEVEL_STEPS[i][0]}${LEVEL_STEPS[i][1] > 40 ? '+' : '–' + LEVEL_STEPS[i][1]}</div>`).join('')}</div></div>
    <div class="dcard wide"><h4>Everyone listed</h4><div class="dlist" id="demoList"></div></div>`;
  if (total) renderDemoList(rows);
  document.querySelectorAll('#demoBody [data-race]').forEach(b => b.onclick = () => { demo.race = demo.race === +b.dataset.race ? null : +b.dataset.race; renderDemo(); });
  document.querySelectorAll('#demoBody [data-gender]').forEach(b => b.onclick = () => { demo.gender = demo.gender === +b.dataset.gender ? null : +b.dataset.gender; renderDemo(); });
  document.querySelectorAll('#demoKinds [data-kind]').forEach(b => b.onclick = () => { demo.kind = +b.dataset.kind; demo.race = demo.gender = null; renderDemo(); });
  document.querySelectorAll('#demoBody [data-kindbar]').forEach(b => b.onclick = () => { demo.kind = +b.dataset.kindbar; demo.race = demo.gender = null; renderDemo(); });
  document.querySelectorAll('#demoPlaces [data-place]').forEach(b => b.onclick = () => { demo.place = b.dataset.place === '' ? null : +b.dataset.place; renderDemo(); });
  document.getElementById('demoClear').onclick = () => { Object.assign(demo, { kind: 0, place: null, race: null, gender: null }); renderDemo(); };
}
// the list of everyone the filters leave, sortable by each column (a second click on a column turns the order round)
const DEMO_COLS = [
  ['name', 'Name', r => r[6] || ''],
  ['race', 'Race', r => r[2] >= 0 ? DM.races[r[2]] : DM.kinds[r[1]]],   // (creatures that are not people have no race: their kind instead)
  ['gender', 'Gender', r => r[3] === 0 ? 'Female' : r[3] === 1 ? 'Male' : ''],
  ['level', 'Level', r => r[4]],
  ['place', 'Place', r => DM.places[r[0]]],
];
const demoSort = { col: 'name', dir: 1 };
function renderDemoList(rows) {
  const el = document.getElementById('demoList');
  const col = DEMO_COLS.find(c => c[0] === demoSort.col), key = col[2], name = DEMO_COLS[0][2];
  const cmp = (a, b) => typeof a === 'number' ? a - b : a === b ? 0 : !a ? 1 : !b ? -1 : a.localeCompare(b);   // (empty last)
  const list = rows.slice().sort((a, b) => cmp(key(a), key(b)) * demoSort.dir || cmp(name(a), name(b)) || b[4] - a[4]);
  el.innerHTML = `<table><thead><tr>${DEMO_COLS.map(([k, l]) => `<th data-sort="${k}"${k === 'level' ? ' class="num"' : ''} aria-sort="${k === demoSort.col ? (demoSort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}<span class="arr">${k === demoSort.col ? (demoSort.dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('')}</tr></thead>
    <tbody>${list.map(r => `<tr><td>${esc(name(r)) || '<i>no name</i>'}</td><td>${esc(DEMO_COLS[1][2](r))}</td><td>${DEMO_COLS[2][2](r) || '–'}</td><td class="num">${r[4] || '–'}</td><td>${esc(DM.places[r[0]])}</td></tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    if (demoSort.col === k) demoSort.dir = -demoSort.dir; else { demoSort.col = k; demoSort.dir = k === 'level' ? -1 : 1; }
    renderDemoList(rows);
  });
}

/* ------------------------------------------------------------------ atlas: quests (quests.js, toolbox/atlas/build_quests.py)
   Every quest as the game's own conversations and scripts tell it: who starts it, each part, the last part and its reward.
   A part is a person or thing on the map; "show on the map" flies there, and the panel of a person lists the quests they
   take part in with a way to jump to the part before and the part after. */
const QD = window.ArcanumQuests, QS = QD.quests, QBY = new Map(QS.map(q => [q.id, q]));
const QKIND = { main: ['✨', 'Main story'], master: ['🎓', 'Master training'], side: ['📜', 'Side quests'] };
const qnorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// where a part can be shown: on the world map, or at the entrance of the separate map (castle, cave, cellar) it takes place in
// (now that the other maps are on the atlas, a part inside one flies into it)
const subMap = w => !w.world && w.mtile && MAP_BY_KEY.has(qnorm(w.place)) ? MAP_BY_KEY.get(qnorm(w.place)) : null;
const spotOf = w => w.world && w.tile ? { place: w.place, tile: w.tile }
  : subMap(w) != null ? { place: MP.maps[subMap(w)].name, tile: w.mtile, map: MP.maps[subMap(w)].key }
  : w.near ? { place: w.near.place, tile: w.near.tile, via: w.near.name } : null;
const placeOf = w => w.world && w.tile ? w.place : w.near ? w.near.place : w.place;   // the world place a part belongs to (the "Where" filter)
const partCount = q => q.steps.filter(s => s.role !== 'fail').length;   // (the steps that go wrong come last)
QS.forEach(q => {
  const set = new Set();
  q.steps.forEach(s => s.who.forEach(w => set.add(placeOf(w))));
  set.delete('');
  q.places = [...set];
  q.giverPlace = q.giver ? placeOf(q.giver) : '';
  q._t = (q.title + ' ' + q.log + ' ' + q.steps.flatMap(s => s.who.map(w => w.name)).join(' ') + ' ' + q.reward.items.join(' ')).toLowerCase();
});
const QACT = [], GIVERS = [];
QS.forEach(q => q.steps.forEach((s, si) => s.who.forEach((w, wi) => {
  if (!(w.world && w.tile) && subMap(w) == null) return;
  const tile = w.world ? w.tile : w.mtile;
  QACT.push({ qid: q.id, si, wi, nm: qnorm(w.name), place: qnorm(w.place), tile });
  if (s.role === 'start') GIVERS.push({ name: w.name, place: w.place, tile });
})));
// the quest steps of whoever stands on that tile (quests.js names the very object that carries the dialog or script)
const questsAt = (place, tile) => {
  const pl = qnorm(place);
  return QACT.filter(a => a.place === pl && a.tile[0] === tile[0] && a.tile[1] === tile[1]);
};
function sendGivers() { try { worldFrame.contentWindow.postMessage({ type: 'atlas-quests', givers: GIVERS }, '*'); } catch (_) {} }

const qItem = name => { const i = BYNAME.get(nameKey(name)); return i != null ? cit(i) : `<span>${esc(name)}</span>`; };
const goldText = g => g.length ? (g[0] === g[1] ? g[0] : g[0] + '–' + g[1]) + ' gold' : '';
const alignText = a => a ? `${a > 0 ? '+' : '−'}${Math.abs(a)} (${a > 0 ? 'towards good' : 'towards evil'})` : '';
function partRole(q, i) {
  const s = q.steps[i], n = partCount(q);
  if (s.role === 'fail') return 'The quest can be lost here';
  const of = `Part ${i + 1} of ${n}`;
  return s.role === 'start' ? `${of} · gives the quest` : s.role === 'talk' ? `${of} · talk to them` : s.role === 'goal' ? `${of} · objective`
    : i === n - 1 ? `${of} · final part, the reward` : of;
}
function stepHtml(q, s, si) {
  const n = partCount(q), last = si === n - 1 && s.role === 'done';
  const label = s.role === 'start' ? 'Starting point' : s.role === 'talk' ? 'Along the way' : s.role === 'goal' ? 'Objective' : last ? 'Final part · reward' : 'Finish';
  const num = s.role === 'start' ? '!' : last ? '★' : si + 1;
  const who = s.who.map((w, wi) => {
    const sp = spotOf(w), where = w.place ? (w.world ? w.place : 'inside ' + w.place) : '';
    const inner = `<span class="qverb">${esc(w.verb)}</span> ${esc(w.name)}${where ? ` <small>${esc(where)}</small>` : ''}`;
    return sp ? `<button class="qgo" data-qgo="${q.id}:${si}:${wi}" title="Show on the map">📍 ${inner}</button>` : `<span class="qplain">${inner}</span>`;
  }).join('') + (s.more ? `<span class="qplain"><small>and ${s.more} more</small></span>` : '');
  const fx = [];
  if (s.take.length) fx.push(`<span><span class="lose">You hand over</span> ${s.take.map(qItem).join(' ')}</span>`);
  if (s.give.length) fx.push(`<span><span class="gain">You receive</span> ${s.give.map(qItem).join(' ')}</span>`);
  if (s.gold.length) fx.push(`<span class="gain">🪙 ${goldText(s.gold)}</span>`);
  s.extra.forEach(x => fx.push(`<span>${esc(x)}</span>`));
  return `<div class="qstep ${s.role}${last ? ' done' : ''}"><div class="qnum">${num}</div><div>
    <div class="qk">${label}</div><div class="qwho">${who}</div>
    ${s.ask && (s.role === 'start' || s.role === 'talk') ? `<div class="qask">You say: “${esc(s.ask)}”</div>` : ''}
    ${s.say ? `<div class="qsay">“${esc(s.say)}”</div>` : ''}${fx.length ? `<div class="qfx">${fx.join('')}</div>` : ''}</div></div>`;
}
// a main quest is one that moves the story on: "story state 7", or "story states 8 → 9" when it does so twice
const storyLabel = q => `Story state${q.story.length > 1 ? 's' : ''} ${q.story.length > 1 ? q.story[0] + ' → ' + q.story[q.story.length - 1] : q.story[0]}`;
const storyTag = q => q.story.length ? `<em class="qstory">${storyLabel(q)}</em>` : '';
function storySection(q) {
  if (!q.story.length) return '';
  return `<div class="sec"><div class="sec-t">Moves the story on</div><div class="qstories">${q.story.map(s =>
    `<div><b>State ${s}</b><span>${esc(QD.storyStates[s] || '')}</span></div>`).join('')}</div></div>`;
}
function showQuest(id) {
  qv.sel = id;
  document.querySelectorAll('#questList .qrow').forEach(b => b.classList.toggle('on', +b.dataset.quest === id));
  const q = QBY.get(id), n = partCount(q), p = document.getElementById('questPanel'), r = q.reward;
  const [icon, kindName] = QKIND[q.kind];
  let h = `<div class="idet-head"><span style="font-size:34px">${icon}</span><div><h3>${esc(q.title)}</h3><div class="meta">${kindName}${n ? ` · ${n} part${n > 1 ? 's' : ''}` : ''}</div></div></div>
    <div class="sec"><div class="qlog">${esc(q.log)}</div></div>${storySection(q)}`;
  if (q.unused) {
    const twin = q.sameAs && QBY.get(q.sameAs);
    h += `<div class="sec flavour">Nothing in the game starts this quest: no conversation or script ever writes it in your logbook.${twin
      ? ` It tells the same errand as <button class="qlink" data-quest-open="${twin.id}">${esc(twin.title)}</button>, which is the one you meet in play.` : ''}</div>`;
  } else {
    h += `<div class="sec"><div class="sec-t">How it goes</div><div class="qsteps">${q.steps.slice(0, n).map((s, i) => stepHtml(q, s, i)).join('')}</div></div>`;
    const rows = [[`Experience`, `${r.xp} XP`]];
    if (r.gold.length) rows.push(['Gold', `<span class="gain">🪙 ${goldText(r.gold)}</span>`]);
    if (r.items.length) rows.push(['Items', r.items.map(qItem).join(' ')]);
    if (r.align) rows.push(['Alignment', alignText(r.align)]);
    if (r.extra.length) rows.push(['Also', r.extra.map(esc).join(' · ')]);
    h += `<div class="sec"><div class="sec-t">Reward</div><dl class="qreward">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
    const fails = q.steps.slice(n);
    if (fails.length) {
      const lines = new Map();
      fails.forEach(s => s.who.forEach(w => { const k = `${w.verb} ${w.name}${w.place ? ' · ' + w.place : ''}`; lines.set(k, (lines.get(k) || 0) + 1); }));
      h += `<div class="sec"><div class="sec-t">It can be lost</div>${[...lines].map(([k, c]) => `<div class="qfail"><b>✗</b> ${esc(k)}${c > 1 ? ` ×${c}` : ''}</div>`).join('')}</div>`;
    }
  }
  p.innerHTML = h;
  p.scrollTop = 0;
  wireItems(p);
  p.querySelectorAll('[data-quest-open]').forEach(b => { b.onclick = () => openQuest(+b.dataset.questOpen); });
}
function openQuest(id) {
  Object.assign(qv, { kind: QBY.get(id).unused ? 'unused' : 'all', place: null, q: '' });
  document.getElementById('questSearch').value = '';
  go('quests');
  showQuest(id);
  const row = document.querySelector(`#questList .qrow[data-quest="${id}"]`);
  if (row) row.scrollIntoView({ block: 'center' });
}
// the "Quests" part of a person's panel: each quest they take part in, with the part before and the part after
function questsSection(hits) {
  if (!hits.length) return '';
  const by = new Map();
  hits.forEach(h => { if (!by.has(h.qid)) by.set(h.qid, new Set()); by.get(h.qid).add(h.si); });
  const btn = (q, i, cls) => {
    const s = q.steps[i];
    return `<button class="${cls}" data-qgo="${q.id}:${i}:0" title="${esc(s.who.map(w => w.name).join(', '))}">${cls === 'pv' ? '◀ ' : ''}Part ${i + 1}: ${esc(s.who[0].name)}${cls === 'nx' ? ' ▶' : ''}</button>`;
  };
  return `<div class="sec"><div class="sec-t">Quests</div>${[...by].map(([qid, set]) => {
    const q = QBY.get(qid), n = partCount(q), idx = [...set].sort((a, b) => a - b);
    const prev = idx[0] > 0 && idx[0] < n ? idx[0] - 1 : -1, next = idx[idx.length - 1] + 1 < n ? idx[idx.length - 1] + 1 : -1;
    return `<div class="qcard"><button class="qopen" data-qopen="${qid}"><b>${esc(q.title)}</b><span>${[...new Set(idx.map(i => partRole(q, i)))].join(' · ')}</span></button>
      ${prev >= 0 || next >= 0 ? `<div class="qnav">${prev >= 0 ? btn(q, prev, 'pv') : '<span class="none"></span>'}${next >= 0 ? btn(q, next, 'nx') : ''}</div>` : ''}</div>`;
  }).join('')}</div>`;
}
function wireQuests(root) {
  root.querySelectorAll('[data-qopen]').forEach(b => { b.onclick = () => openQuest(+b.dataset.qopen); });
  root.querySelectorAll('[data-qgo]').forEach(b => { b.onclick = () => { const [q, s, w] = b.dataset.qgo.split(':').map(Number); questGo(q, s, w); }; });
}
// a part on the map: fly there and open the panel of whoever stands there
const ALL_LABELS = (window.ArcanumNotices ? window.ArcanumNotices.notices : []).map(([key, area, x, y, title, text]) => ({
  text: title, category: 'information', description: esc(text).replace(/\n/g, '<br>'), place: area, mapKey: key || area, tile: [x, y], map: key == null ? -1 : MAP_BY_KEY.get(nkey(key)) }));
const NPC_BY_TILE = new Map();
for (const n of PEOPLE) NPC_BY_TILE.set(qnorm(n.place) + '|' + n.tile.join(','), n);
function questGo(qid, si, wi) {
  const w = QBY.get(qid).steps[si].who[wi], sp = spotOf(w), here = (w.world && w.tile) || subMap(w) != null;
  if (!sp) { openQuest(qid); return; }
  focusTile(sp.place, sp.tile, here ? w.name : '', sp.map);
  const wt = w.world ? w.tile : w.mtile;
  const npc = here && NPC_BY_TILE.get(qnorm(w.place) + '|' + wt.join(','));        // the person on that very tile
  const lab = !npc && here && ALL_LABELS.find(l => qnorm(l.mapKey) === qnorm(w.place) && l.tile[0] === wt[0] && l.tile[1] === wt[1]);
  if (npc) selectNpc(npc);
  else if (lab) selectLabel(fromWorld(lab));
  else {
    const p = openPanel();
    p.innerHTML = `<div class="panel-head"><span class="portrait chestpic">${w.npc ? '🧑' : '❖'}</span><div><h3>${esc(w.name)}</h3>
      <div class="meta">${esc(w.world ? w.place : `Inside ${w.place}${sp.via ? ` · entrance: ${sp.via}` : ''}`)}</div></div></div>`;
  }
  const p = document.getElementById('labelPanel');
  if (!p.querySelector(`[data-qopen="${qid}"]`)) { p.insertAdjacentHTML('beforeend', questsSection([{ qid, si, wi }])); wireItems(p); }
}

const qv = { kind: 'all', place: null, q: '', sel: null };
const Q_KINDS = [['all', 'All quests'], ['main', '✨ Main story'], ['master', '🎓 Master training'], ['side', '📜 Side quests'], ['unused', '🚫 Not in game']];
const qList = skip => QS.filter(q => (skip === 'kind' || (qv.kind === 'unused' ? q.unused : !q.unused && (qv.kind === 'all' || q.kind === qv.kind)))
  && (skip === 'place' || !qv.place || q.places.includes(qv.place)) && (!qv.q || q._t.includes(qv.q)));
function renderQuests() {
  const list = qList(), byKind = qList('kind');
  document.getElementById('questCount').textContent = QS.filter(q => !q.unused).length;
  document.getElementById('questKinds').innerHTML = Q_KINDS.map(([k, label]) =>
    `<button class="loc${qv.kind === k ? ' on' : ''}" data-kind="${k}">${label}<span class="n">${byKind.filter(q => k === 'unused' ? q.unused : !q.unused && (k === 'all' || q.kind === k)).length}</span></button>`).join('');
  const pc = {};
  qList('place').forEach(q => q.places.forEach(p => pc[p] = (pc[p] || 0) + 1));
  document.getElementById('questPlaces').innerHTML = '<div class="locgroup">Where</div>' +
    `<button class="loc${qv.place == null ? ' on' : ''}" data-place="">Everywhere<span class="n">${qList('place').length}</span></button>` +
    Object.entries(pc).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p, n]) => `<button class="loc${qv.place === p ? ' on' : ''}" data-place="${esc(p)}">${esc(p)}<span class="n">${n}</span></button>`).join('');
  document.getElementById('questTitle').textContent = qv.place || (qv.kind === 'all' ? 'All quests' : Q_KINDS.find(k => k[0] === qv.kind)[1].replace(/^\S+ /, ''));
  document.getElementById('questCrumb').textContent = `${list.length} quest${list.length === 1 ? '' : 's'}`;
  const row = q => `<button class="qrow${q.id === qv.sel ? ' on' : ''}" data-quest="${q.id}"><span class="qi">${QKIND[q.kind][0]}</span>
    <span><b>${esc(q.title)}</b>${storyTag(q)}<span class="s">${esc(q.log)}</span></span>
    <span class="qx">${q.giver ? esc((q.giver.verb === 'Talk to' ? '' : q.giver.verb + ' ') + q.giver.name) : ''}<i>${esc(q.giverPlace)}</i></span></button>`;
  const order = qs => qs.slice().sort((a, b) => a.kind === 'main' && b.kind === 'main' ? (a.story[0] - b.story[0]) || a.id - b.id : a.title.localeCompare(b.title));
  let h = '';
  if (qv.kind === 'all') for (const k of ['main', 'master', 'side']) {
    const qs = list.filter(q => q.kind === k);
    if (qs.length) h += `<div class="locgroup">${QKIND[k][0]} ${QKIND[k][1]}</div>` + order(qs).map(row).join('');
  } else h = order(list).map(row).join('');
  const el = document.getElementById('questList');
  el.innerHTML = h || '<div class="flavour" style="padding:20px">No quest matches.</div>';
  el.querySelectorAll('[data-quest]').forEach(b => b.onclick = () => showQuest(+b.dataset.quest));
  document.querySelectorAll('#questKinds [data-kind]').forEach(b => b.onclick = () => { qv.kind = b.dataset.kind; renderQuests(); });
  document.querySelectorAll('#questPlaces [data-place]').forEach(b => b.onclick = () => { qv.place = b.dataset.place || null; renderQuests(); });
}
document.getElementById('questSearch').oninput = e => { qv.q = e.target.value.trim().toLowerCase(); renderQuests(); };
document.getElementById('questClear').onclick = () => { Object.assign(qv, { kind: 'all', place: null, q: '' }); document.getElementById('questSearch').value = ''; renderQuests(); };
// Quests and Demographics, opened from the map, come filtered to the place on show
function filterQuestsToPlace() {
  const title = document.getElementById('atlasTitle').textContent, sec = SECT.get(title) || MP.maps.find(m => m.name === title);
  const place = sec ? (sec.group || sec.area) : title;       // inside a castle or cave: the quests of the place it belongs to
  Object.assign(qv, { kind: 'all', q: '', place: QS.some(q => !q.unused && q.places.includes(place)) ? place : null });
  document.getElementById('questSearch').value = '';
}
function filterDemoToPlace() {
  const cp = currentPlace(), want = new Set([cp.title, cp.label, cp.key].map(nkey));
  const i = DM.places.findIndex(p => want.has(nkey(p)));
  demo.place = i >= 0 ? i : null; demo.race = demo.gender = null;
}

/* ------------------------------------------------------------------ files and workshop */
// Both are the Asset Browser itself (asset-browser.html, unchanged), each in a frame of its own, loaded the first time it opens.
// Files shows every kind of file. The Workshop keeps to the maps: a map picked there opens straight in the map editor, and
// "Exit edit" goes back to the maps. Files has no editing tools at all (no Edit, world editor or .ART packer). Each frame keeps its own GET link
// (?mode=sec&path=..&editor=on), which the address bar repeats as #files&<link> / #workshop&<link>. The two share the Asset
// Browser's last place (localStorage), so the Workshop always starts from a link of its own.
const BROWSERS = {
  files: { frame: document.getElementById('filesFrame'), note: document.getElementById('filesNote'), start: '', list: 'file list', query: '', seen: null },
  workshop: { frame: document.getElementById('workFrame'), note: document.getElementById('workNote'), start: 'mode=sec', list: 'map list', query: '', seen: null },
};
const filesFrame = BROWSERS.files.frame;
function loadBrowser(screen, query) {
  const b = BROWSERS[screen];
  if (query && screen === 'files') { const p = new URLSearchParams(query); p.delete('editor'); query = String(p); }   // editing is the Workshop's
  if (b.frame.getAttribute('src') && (!query || query === b.query)) return;
  b.query = query || b.start; b.seen = null;
  b.frame.style.visibility = 'hidden';                 // shown once dressed (the load handler): no flash of its own welcome screen
  b.frame.src = 'asset-browser.html' + (b.query ? '?' + b.query : '');
}
function openFiles(query) { loadBrowser('files', query); go('files'); }
// One top bar: the Asset Browser's (file types, its tools, the map editor's menu), in the Atlas bar's dress. Its brand becomes
// the Atlas's (a click goes to the welcome screen) and it stays up on its own welcome screen. Files adds the "in the Atlas"
// button; the Workshop puts its own short menu where the file types were.
const BAR_CSS = `
:root { --topbar-h: 50px; }
.explorer-home { display: none !important; }        /* its welcome screen (pick a kind of file): the bar's tabs do that */
.topbar { background: linear-gradient(#2a2318, #211c14); border-bottom-color: #5c4b31; }
body.home-active .topbar { display: grid; }
body.home-active .topbar-tabs { max-width: 900px; opacity: 1; pointer-events: auto; }
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
body.home-active #atlasEdge, body.sec-edit-full #atlasEdge { display: none; }`;
// Files only shows: the map editor (Edit), the world editor and the .ART packer are the Workshop's
const FILES_CSS = `
#topbarTools .sec-edit-btn, #packerLaunchBtn, #worldEditorLaunchBtn { display: none !important; }`;
// the Workshop: maps only, so no file types; its menu (the maps, a new world, the .ART packer) stands in their place
const WORK_CSS = `
.topbar .topbar-tabs, #packerLaunchBtn, #worldEditorLaunchBtn { display: none !important; }
#workNav { grid-column: 2; justify-self: center; display: flex; align-items: center; gap: 2px; }
body.sec-edit-full #workNav { display: none; }
body.sec-edit-full .viewer-backbar { display: none; }      /* "Exit edit" is the way back to the maps */`;
function dressBar(doc, screen) {
  if (doc.getElementById('atlasEmbed')) return;
  const b = BROWSERS[screen];
  doc.head.insertAdjacentHTML('beforeend', `<style id="atlasEmbed">${BAR_CSS}${screen === 'workshop' ? WORK_CSS : FILES_CSS}</style>`);
  const brand = doc.getElementById('appTitle');
  brand.querySelector('.brand-title').textContent = 'Arcanum Asset Browser';
  brand.title = 'Welcome screen';
  doc.addEventListener('click', e => {               // before the Asset Browser's own handlers
    if (e.target.closest('#appTitle')) { e.stopPropagation(); e.preventDefault(); go('home'); }   // not its welcome screen
  }, true);
  if (screen === 'files') doc.getElementById('topbarTools').insertAdjacentHTML('afterbegin', '<button type="button" class="tool-btn" id="filesAtlas" hidden></button>');
  else dressWorkshop(doc);
  // Its welcome screen never shows: with no last place to reopen (main.js has started reopening it by now), and whenever it
  // would go back there, the first tab opens instead (ART in Files, the maps in the Workshop)
  const leaveHome = () => { if (doc.body.classList.contains('home-active')) doc.getElementById(screen === 'files' ? 'artExploreBtn' : 'secExploreBtn')?.click(); };
  new doc.defaultView.MutationObserver(leaveHome).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  leaveHome();
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
    <button type="button" data-k="maps" aria-pressed="true" title="Pick a map to edit">🗺 Maps</button>
    <button type="button" data-k="world" title="Make a new world map and edit it">🌍 New world</button>
    <button type="button" data-k="packer" title="Build a .ART file from BMP / PNG frames">🛠 .ART Packer</button></nav>`);
  doc.getElementById('workNav').addEventListener('click', e => {
    const k = e.target.closest('button')?.dataset.k;
    if (k === 'maps') click('secExploreBtn');
    if (k === 'world') click('worldEditorLaunchBtn');
    if (k === 'packer') click('packerLaunchBtn');
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
for (const [screen, b] of Object.entries(BROWSERS)) b.frame.addEventListener('load', () => {
  let doc = null; try { doc = b.frame.contentDocument; } catch (_) {}
  const ok = !!(doc && doc.getElementById('app'));
  if (ok) {
    try { dressBar(doc, screen); } catch (err) { console.error(`${screen}: could not dress the Asset Browser`, err); }
    b.seen = null;                                       // a new page: the poll below takes up its link (and "in the Atlas")
  }
  b.frame.style.visibility = '';
  // main.js marks the page once its modules run; a page that loaded without them cannot read the files
  setTimeout(() => {
    try { if (ok && b.frame.contentDocument !== doc) return; } catch (_) {}      // the frame went on to another page meanwhile
    let booted = false; try { booted = ok && (doc.body.classList.contains('home-active') || !doc.querySelector('.explorer').hidden); } catch (_) {}
    b.note.hidden = booted;
  }, 1500);
});
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
  const b = BROWSERS[current];
  if (!b || !b.frame.getAttribute('src')) return;
  let q, doc; try { if (b.frame.contentWindow.location.href === 'about:blank') return; q = b.frame.contentWindow.location.search.slice(1); doc = b.frame.contentDocument; } catch (_) { return; }
  if (current === 'workshop') doc.querySelector('#workNav [data-k="maps"]')?.setAttribute('aria-pressed', String(new URLSearchParams(q).get('mode') === 'sec'));
  if (q === b.seen) return;
  b.seen = b.query = q; syncLink();
  if (current === 'files') showFilesOwner(q);
}, 400);

/* ------------------------------------------------------------------ screens */
const SCREENS = ['home', 'atlas', 'items', 'library', 'quests', 'people', 'files', 'workshop'];
// the welcome page shows another place of the game each time it is opened
(function () {
  const list = window.ArcanumHero || [];
  if (!list.length) return;
  const h = list[Math.floor(Math.random() * list.length)], el = document.getElementById('heroMap');
  el.style.backgroundImage = `url("${h.src}")`;
  el.title = h.alt;
})();

function go(screen) {
  current = screen;
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
  if (current === 'atlas' && b.closest('#atlasNav')) {
    if (b.dataset.go === 'people') filterDemoToPlace();
    if (b.dataset.go === 'quests') filterQuestsToPlace();
  }
  go(b.dataset.go);
}));
// the whole Atlas box on the welcome screen opens the map (its own buttons go to their pages)
document.querySelector('.hero').addEventListener('click', e => { if (!e.target.closest('button')) go('atlas'); });
{ // #files&mode=mob&path=... opens Files on that file, #workshop&mode=sec&path=...&editor=on the Workshop on that map
  const [screen, ...q] = location.hash.slice(1).split('&');
  if (BROWSERS[screen] && q.length) { loadBrowser(screen, q.join('&')); go(screen); }
  else go(SCREENS.includes(screen) ? screen : 'home');
}
restoreView();          // a shared link (#v=...) opens the atlas on that view
linkLive = true; syncLink();
