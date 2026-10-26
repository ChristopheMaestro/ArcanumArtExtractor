// Which version of the game the page shows (the Atlas version menu: base game, CE Restored, Carcanum, Forgotten Places) decides which generated data files
// it loads: data/versions.js lists the files each version has of its own (toolbox/atlas/run_version.py: the base game's builders run on the version's
// merged data, so a mod is never shown with the base game's data alone); every other file is the base game's.
//   AtlasData('items')      writes the script tag of js/atlas/data/[<version>/]items.js (at load time, in place)
//   AtlasData.url('assets') the same path, for a file loaded later (url(name, ver): another version's, for atlas-boot.js)
//   AtlasData.mod('maps')   the version's mod files of that kind (MOD_FILES; nothing for the base game): a page loads only its version's
//   AtlasData.configure(v)  makes v the version on show (AtlasVer, AtlasModDir, the mod's .ART hook): atlas-boot.js, when the Atlas switches version
// The version is ?ver=, else the one chosen last in the Atlas menu (localStorage atlas-ver; atlas-ce '0' from before the menu = the base game), else CE
// Restored, the Atlas' default. The Atlas switches version in the page (atlas-boot.js: the new version's files are fetched while the old one stays in use,
// then the page's app starts again on them); the map and file frames, which read the same choice, are loaded again.
// The game's own .ART files an object draws with (the Advanced view reads data/art/... itself) are the mod's when it has the file, else the base game's;
// an art index (.mes) is the mod's patched one (atlas/<mod>/art-mes/, made by run_version.py).
(function () {
  const q = new URLSearchParams(location.search);
  let ver = q.get('ver');
  if (!ver) { try { ver = localStorage.getItem('atlas-ver') || (localStorage.getItem('atlas-ce') === '0' ? 'base' : null); } catch (_) {} }
  const own = window.AtlasVersionData || {};
  // (a module the mod has no copy of is the base game's build, which the mod's files carry too: toolbox/atlas/splice_modules.py)
  const resolve = v => v === 'base' ? 'base' : own[v] ? v : 'ce';
  let dv = resolve(ver);
  const url = (name, v = dv) => 'js/atlas/data/' + (own[v] && own[v].includes(name) ? v + '/' : '') + name + '.js';
  const tag = src => document.write('<script src="' + src + '"><\/script>');
  window.AtlasData = name => tag(url(name));
  window.AtlasData.url = url;
  Object.defineProperty(window.AtlasData, 'standalone', { get: () => STANDALONE.includes(dv) });      // the version on show is its own folder and nothing else (its terrain templates, like everything, are its own)
  window.AtlasData.has = (name, v = dv) => !!(own[v] && own[v].includes(name));
  window.AtlasData.optional = name => { if (own[dv] && own[dv].includes(name)) window.AtlasData(name); };     // (a file only some versions have)
  // A mod's own picture index, maps, areas and people (js/atlas/data/<file>.js); world-atlas.js reads them under CE's names (useMod).
  const MOD_FILES = {
    ce: { pictures: ['ce-restored'], maps: ['ce-maps'], areas: ['ce-areas'], mobs: ['ce-mobs'] },
    car: { pictures: ['carcanum'], maps: ['carcanum-maps'], areas: ['carcanum-areas'], mobs: ['carcanum-mobs'] },
    fp: { pictures: ['fp'], maps: ['fp-maps'], areas: ['fp-areas'], mobs: ['fp-mobs'] },
    ru: { pictures: ['ru'], maps: ['ru-maps'], areas: ['ru-areas'], mobs: ['ru-mobs'] },
    tin: { pictures: ['tin'], maps: ['tin-maps'], areas: ['tin-areas'], mobs: ['tin-mobs'] },
    rb: { pictures: ['rb'], maps: ['rb-maps'], areas: ['rb-areas'], mobs: ['rb-mobs'] },
    tr: { pictures: ['tr'], maps: ['tr-maps'], areas: ['tr-areas'], mobs: ['tr-mobs'] },
    dem: { pictures: ['dem'], maps: ['dem-maps'], areas: ['dem-areas'], mobs: ['dem-mobs'] },
    bpd: { pictures: ['bpd'], maps: ['bpd-maps'], areas: ['bpd-areas'], mobs: ['bpd-mobs'] },
    v064: { pictures: ['v064'], maps: ['v064-maps'], areas: ['v064-areas'], mobs: ['v064-mobs'] },
  };
  window.AtlasData.modUrls = (kind, v = dv) => ((MOD_FILES[v] || {})[kind] || []).map(f => 'js/atlas/data/' + f + '.js');      // (for a file loaded later)
  window.AtlasData.mod = (...kinds) => { for (const k of kinds) for (const u of window.AtlasData.modUrls(k)) tag(u); };
  const MODS = { ce: ['Arcanum CE Restored', 'ce-restored'], car: ['Carcanum', 'carcanum'], fp: ['Forgotten Places 6.0', 'forgotten-places'], ru: ['Russian Mod 2012 RC9', 'russian-mod'], tin: ['Terra Incognita', 'terra-incognita'], rb: ['Arcanum ReBulid', 'arcanum-rebulid'], tr: ['Total Rebalance', 'total-rebalance'], dem: ['Arcanum Demo', 'arcanum-demo'], bpd: ['Arcanum Beta Press Demo', 'arcanum-beta-press-demo'], v064: ['Arcanum 1.0.6.4', 'arcanum-1-0-6-4'] };
  const STANDALONE = ['dem', 'bpd', 'v064'];      // versions that are their own folder and nothing else (game_files.STANDALONE): no file of the base game stands in for one they lack
  let mod = null;
  const orig = window.fetch && window.fetch.bind(window);
  let hooked = false;
  // a mod's .ART stored once (toolbox/atlas/dedupe_art.py): js/index/aliases/art-aliases.tsv names the file kept for one moved away (read the first
  // time the mod has no file of a name; without case: the names asked for do not always have the file's case)
  let aliases = null;
  const aliasOf = (base, rel) => (aliases ||= orig(base + 'js/index/aliases/art-aliases.tsv').then(r => r.ok ? r.text() : '').catch(() => '')
    .then(t => new Map(t.split('\n').filter(Boolean).map(l => { const [d, k] = l.trimEnd().split('\t'); return [d.toLowerCase(), k]; }))))
    .then(a => a.get(rel.toLowerCase()));
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  // installed the first time a mod is on, and then follows whichever version is configured (none: every fetch passes through)
  function hook() {
    hooked = true;
    window.fetch = (input, init) => {
      const m = mod && typeof input === 'string' && /^(.*?)data\/art\/(.+)$/.exec(input.split('?')[0]);
      if (!m) return orig(input, init);
      const here = mod, mes = /\.mes$/i.test(m[2]);
      const mine = mes ? `${m[1]}atlas/${here[1]}/art-mes/${m[2]}` : `${m[1]}data/mods/${encodeURIComponent(here[0])}/art/${m[2]}`;
      const base = () => orig(input, init);
      if (STANDALONE.includes(dv)) return orig(mine, init).then(r => r.ok ? r : aliasOf(m[1], `mods/${here[0]}/art/${decodeURIComponent(m[2])}`).then(k => k ? orig(m[1] + 'data/' + enc(k), init) : r));      // (its own folder and nothing else: no fallback to the base game's file)
      const kept = () => mes ? base() : aliasOf(m[1], `mods/${here[0]}/art/${decodeURIComponent(m[2])}`).then(k => k ? orig(m[1] + 'data/' + enc(k), init) : base());
      return orig(mine, init).then(r => r.ok ? r : kept(), base);
    };
  }
  function configure(v) {
    dv = resolve(v);
    window.AtlasVer = dv;
    mod = MODS[dv] || null;
    window.AtlasModDir = mod ? 'data/mods/' + encodeURIComponent(mod[0]) + '/' : null;       // (the mod's folder, for what the page fetches by file name: sounds)
    if (mod && orig && !hooked) hook();
    return dv;
  }
  window.AtlasData.configure = configure;
  // how the header and the version menu name each version
  window.AtlasData.names = { ce: 'CE Restored 1.61', base: 'Arcanum 1.0.7.4', ru: 'Russian Mod Pack 2012 RC9', car: 'Polished CAR Arcanum', fp: 'Forgotten Places 6.0', tin: 'Terra Incognita', rb: 'Arcanum ReBulid', tr: 'Arcanum Total Rebalance', dem: 'Arcanum Demo', bpd: 'Arcanum Beta Press Demo', v064: 'Arcanum 1.0.6.4' };
  // helpers the Atlas page (atlas-app.js) and the world-map frame (world-atlas.js) both use
  const D = window.AtlasData;
  D.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  D.fileOf = f => String(f || '').slice(String(f || '').lastIndexOf('/') + 1).toLowerCase();
  D.INSIDE_OF = ['Qintarra', 'The Black Mountain Mines'];
  // Appends the maps and sections CE (or a mod over it) adds to MP, so the others keep their index. Forgotten Places: its caves and houses are
  // listed under the place they belong to (Brandybuck and Spider Cave get their own name, as a place of that name exists)
  D.appendCEMaps = (MP, CE, fp) => {
    const base = MP.maps.length, FPG = { Brandybuck: 'Brandybuck', CaveOfBanishment: 'The Cavern of Madness', LeahboUnderground: 'Leahbo', Plainwicke: 'Plainwicke Plantation', 'Spider Cave': 'Spider Cave', TombOfHorrors: "Acererak's Tomb" };
    const FPN = { Brandybuck: 'Brandybuck Houses', 'Spider Cave': 'Spider Cave - Inside' };
    const inside = n => D.INSIDE_OF.includes(n) ? n + ' - Inside' : n;      // (a mod's own copy of those two maps is the one inside too)
    MP.maps.push(...CE.maps.map(m => fp && FPN[m.name] ? { ...m, name: FPN[m.name] } : D.INSIDE_OF.includes(m.name) ? { ...m, name: inside(m.name) } : m));
    MP.sections.push(...CE.sections.map(s => ({ ...s, map: s.map + base, ...(fp && FPG[s.name] ? { group: FPG[s.name], ...(FPN[s.name] && { name: FPN[s.name] }) } : {}), ...(D.INSIDE_OF.includes(s.name) && { name: inside(s.name) }) })));
  };
  configure(ver);
})();
