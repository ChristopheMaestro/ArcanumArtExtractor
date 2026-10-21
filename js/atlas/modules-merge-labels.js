// The doors and signs of the modules (modules.js, read from each module's own scripts) join the game's waypoints and signs.
// Loaded after waypoints.js and notices.js, which define those globals.
(function () {
  const M = window.ArcanumModules;
  if (!M) return;
  if (M.waypoints && M.waypoints.length) {
    const w = window.ArcanumWaypoints = window.ArcanumWaypoints || { waypoints: [] };
    w.waypoints.push(...M.waypoints);
  }
  if (M.notices && M.notices.length) {
    const n = window.ArcanumNotices = window.ArcanumNotices || { notices: [] };
    n.notices.push(...M.notices);
  }
})();
