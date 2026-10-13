// The modules' maps (modules.js) join the game's other maps: one more entry in ArcanumMaps (flagged .module) with a section, and their
// people join ArcanumSubNpcs, so both pages treat them like any castle or cave. Loaded after submaps.js and before the page's script.
(function () {
  const M = window.ArcanumModules;
  if (!M) return;
  const maps = window.ArcanumMaps = window.ArcanumMaps || { maps: [], sections: [] };
  const base = maps.maps.length;
  maps.maps.push(...M.maps);
  maps.sections.push(...M.sections.map(s => ({ ...s, map: s.map + base })));
  const rows = (rs, into) => {                       // rows file their place by index into places
    const d = window[into] = window[into] || { races: M.races, kinds: M.kinds, places: [], npcs: [] };
    const off = d.places.length;
    d.places.push(...M.places);
    d.npcs.push(...rs.map(r => [r[0] + off, ...r.slice(1)]));
  };
  rows(M.npcs, 'ArcanumSubNpcs');
  window.ArcanumModuleCreatures = { races: M.races, kinds: M.kinds, places: M.places, npcs: M.creatures };   // only read when creatures are turned on
})();
