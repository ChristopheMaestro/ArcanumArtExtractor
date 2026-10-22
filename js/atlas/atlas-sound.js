// Music and sounds of the place in view (sound.js, toolbox/atlas/build_sound.py; the game's gsound.c)

(window.AtlasParts = window.AtlasParts || {}).sound = function (env) {
  const { MP, esc } = env;

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
  const ownSound = new Set(window.AtlasSoundOwn || []);       // (the sounds the mod on show has of its own: from its folder, the others from the base game's)
  const url = f => (ownSound.has(f) && window.AtlasModDir ? window.AtlasModDir : 'data/') + 'sound/' + f.split('/').map(encodeURIComponent).join('/');
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
  btn.onclick = () => { on = !on; paint(); if (on && !pair) locate(env.lastView || { map: null, tile: [90226, 84176], z: 0.1 }); refresh(); };
  tbtn.onclick = () => { night = !night; try { localStorage.setItem('atlas-snd-night', night ? '1' : '0'); } catch (_) {} paint(); refresh(); };
  const activity = () => { active = !document.hidden && document.body.classList.contains('screen-atlas'); refresh(); };
  document.addEventListener('visibilitychange', activity);
  window.atlasSound = activity;
  paint(); activity();
  const stop = () => { for (const t of tracks.values()) { t.a.pause(); t.a.removeAttribute('src'); t.a.load(); } tracks.clear(); on = false; };      // (the app starts again: another version)
  return { stop, view: v => { if (on) locate(v); else where = null; }, screen: activity, state: () => ({ on, night, pair, place, tracks: [...tracks].map(([f, t]) => [f, +t.v.toFixed(2), t.to]) }) };
})();

  return { SND };
};
