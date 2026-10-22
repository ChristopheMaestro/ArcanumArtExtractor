// Path to houses (the route-finding and the look of the strip are in sec-village-paths.js)
import { secEdgeRotation } from '../sec/sec-walls.js';
import { artType } from '../core/art-id.js';
import { secEdgeKey } from './sec-writer.js';
import { secTileNameMesMap } from '../sec/sec-tile-art.js';
import { PATH_CELL, PATH_TIME_LIMIT_MS, planVillagePaths } from './sec-village-paths.js';
import { errText } from '../core/text-io.js';

const PATH_MAX_CELLS = 1500 * 1500;   // the area searched for paths (doors' bounding box + margin)

export function createPathTools(env) {
  const { blendAround, brushRawAt, cornersRaw, edgeKeyOf, edit, endStroke, ensureArt, forFootprint, getEdgeIndex, mapH, mapW, objectsAt, overlayVisibility, plainTileRaw, removeNewMob, removeObject, sectorAtWorld, setTile, stage, status, tileCorners, ui, worldFloat, wxOf, wyOf } = env;

  // ---- Path to houses (the route-finding and the look of the strip are in sec-village-paths.js) ---------------------
  // The doors are picked on the map; each path starts on the tile in front of its door. Nothing is laid on a house (its
  // floor, a facade, a tile that carries a wall or a door), on water or on a tree, and the edge tiles that blend a path
  // into its surroundings are never put on a house either.
  const DIR_STEP = [[-1, 0], [0, 1], [1, 0], [0, -1]];   // the tile across each edge of a tile (dir 0..3 = NE, SE, SW, NW)
  const isDoorPoint = p => p.type === 1 && p.currentAidRaw != null && ((Number(p.currentAidRaw) >>> 10) & 1) === 1 && (secEdgeRotation(p) ?? p.__rot) != null;
  let doorList = null;
  const allDoors = () => {
    if (!doorList || doorList.n !== env.mobPoints.length) doorList = { n: env.mobPoints.length, list: env.mobPoints.filter(isDoorPoint) };
    return doorList.list;
  };
  const doorSides = p => {
    const hx = wxOf(p), hy = wyOf(p), dir = (((secEdgeRotation(p) ?? p.__rot) >> 1) & 3);
    return { hx, hy, dir, ox: hx + DIR_STEP[dir][0], oy: hy + DIR_STEP[dir][1] };
  };
  const tileRawAt = (x, y) => { const at = sectorAtWorld(x, y); return at ? at.sec.decoded.tiles[at.idx] >>> 0 : null; };
  const isHouseRaw = raw => raw != null && !!(artType(raw) || !((raw >>> 8) & 1));   // a facade or an indoor tile
  // The tiles reachable from (sx, sy) without crossing a wall or a door, up to `cap`: a house is a small closed region.
  const flood = (sx, sy, cap = 600) => {
    const seen = new Set([sy * mapW + sx]), queue = [sx, sy], edges = getEdgeIndex();
    for (let q = 0; q < queue.length && seen.size <= cap; q += 2) {
      const x = queue[q], y = queue[q + 1];
      for (let d = 0; d < 4; d++) {
        const nx = x + DIR_STEP[d][0], ny = y + DIR_STEP[d][1];
        if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH || seen.has(ny * mapW + nx) || edges.has(secEdgeKey(x, y, d))) continue;
        seen.add(ny * mapW + nx); queue.push(nx, ny);
      }
    }
    return { open: seen.size > cap, size: seen.size, cells: queue };
  };
  // Which side of a door is the outside: the side that is not a floor, else the side that is not a closed room, else
  // the side farther from the walls around the door.
  const doorRecord = p => {
    const s = doorSides(p), A = { x: s.hx, y: s.hy }, B = { x: s.ox, y: s.oy };
    const ia = isHouseRaw(tileRawAt(A.x, A.y)), ib = isHouseRaw(tileRawAt(B.x, B.y));
    let out;
    if (ia !== ib) out = ia ? B : A;
    else {
      const fa = flood(A.x, A.y), fb = flood(B.x, B.y);
      if (fa.open !== fb.open) out = fa.open ? A : B;
      else if (!fa.open) out = fa.size >= fb.size ? A : B;
      else {
        let cx = 0, cy = 0, n = 0;
        for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) for (const q of objectsAt(s.hx + dx, s.hy + dy)) if (q.type === 0) { cx += s.hx + dx; cy += s.hy + dy; n++; }
        out = !n || Math.hypot(A.x - cx / n, A.y - cy / n) > Math.hypot(B.x - cx / n, B.y - cy / n) ? A : B;
      }
    }
    const inn = out === A ? B : A;
    return { key: `${s.hx},${s.hy},${s.dir}`, hx: s.hx, hy: s.hy, dir: s.dir, ox: out.x, oy: out.y, ix: inn.x, iy: inn.y };
  };
  const renderPathInfo = () => {
    const n = edit.pathDoors.length;
    ui.pathInfo.textContent = !edit.objectsReady ? 'Loading the map objects…'
      : n ? `${n} door${n === 1 ? '' : 's'} chosen · click a chosen door again to drop it`
      : 'Click the doors to join on the map (the doors light up), then press Draw paths.';
    ui.pathDraw.disabled = n < 2; ui.pathClear.disabled = !n;
    const ground = secTileNameMesMap?.get(pathTerrain())?.name;
    ui.pathGround.textContent = `Ground: ${ground || 'Trodden Dirt'} · the tile picked in the Tile tool, when it is one plain outdoor tile`;
  };
  const pickDoor = event => {
    if (!edit.objectsReady) { status.textContent = 'Objects are still loading…'; return; }
    const f = worldFloat(event); if (!f) return;
    let best = null, bd = 1.5;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const p of objectsAt(f.wx + dx, f.wy + dy)) {
      if (!isDoorPoint(p)) continue;
      const s = doorSides(p), d = ((s.hx + s.ox) / 2 - f.fx) ** 2 + ((s.hy + s.oy) / 2 - f.fy) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) { status.textContent = 'No door there: click on a door.'; return; }
    const rec = doorRecord(best), at = edit.pathDoors.findIndex(d => d.key === rec.key);
    if (at >= 0) edit.pathDoors.splice(at, 1); else edit.pathDoors.push(rec);
    renderPathInfo(); env.scheduleCursor();
  };
  // Doors in the view (teal), the chosen ones (yellow) with the tile in front of them.
  const drawDoorMarks = c => {
    if (!edit.objectsReady) return;
    const chosen = new Set(edit.pathDoors.map(d => d.key)), W = stage.clientWidth, H = stage.clientHeight;
    c.save(); c.lineCap = 'round';
    for (const p of allDoors()) {
      const s = doorSides(p), q = env.tileCentre(s.hx, s.hy);
      if (q.x < -80 || q.y < -80 || q.x > W + 80 || q.y > H + 80) continue;
      const on = chosen.has(`${s.hx},${s.hy},${s.dir}`);
      c.beginPath(); env.edgePath(c, s.hx, s.hy, s.dir);
      c.strokeStyle = on ? '#ffe066' : 'rgba(32,178,170,.9)'; c.lineWidth = on ? 5 : 3; c.stroke();
    }
    for (const d of edit.pathDoors) { c.beginPath(); env.tilePath(c, d.ox, d.oy); c.fillStyle = 'rgba(255,224,102,.28)'; c.fill(); }
    c.restore();
  };
  // The ground the paths are made of: the selected tile when it is one plain outdoor terrain, else Trodden Dirt.
  const pathTerrain = () => {
    const b = edit.brush;
    if (b?.custom) { const c = tileCorners(b.raw); if (c && c.every(t => t === c[0])) return c[0]; }
    else if (b && b.artId < 200) return b.artId;
    return 27;
  };
  const pathRaw = (terrain, x, y) => {
    const b = edit.brush;
    if (b && !b.custom && b.artId === terrain) return brushRawAt(x, y);
    if (b?.custom && tileCorners(b.raw)?.every(t => t === terrain)) return b.raw;
    return env.tileManifest?.size ? cornersRaw([terrain, terrain, terrain, terrain], x, y, terrain) : plainTileRaw(terrain, 0);
  };
  const terrainClass = new Map();   // tilename.mes id -> 0 open ground, 1 paved or a floor (walked over, never painted), 2 blocks
  const classOf = t => {
    let v = terrainClass.get(t);
    if (v === undefined) {
      const f = String(secTileNameMesMap?.get(t)?.flags || '').split(/\s/)[0];
      v = !secTileNameMesMap ? 0 : /[bfs]/.test(f) ? 2 : /n/.test(f) ? 0 : 1;
      terrainClass.set(t, v);
    }
    return v;
  };
  const drawPaths = () => {
    const doors = edit.pathDoors;
    if (doors.length < 2) return;
    const t0 = performance.now();
    const M = 24;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of doors) { x0 = Math.min(x0, d.ox, d.ix); y0 = Math.min(y0, d.oy, d.iy); x1 = Math.max(x1, d.ox, d.ix); y1 = Math.max(y1, d.oy, d.iy); }
    x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); x1 = Math.min(mapW - 1, x1 + M); y1 = Math.min(mapH - 1, y1 + M);
    const w = x1 - x0 + 1, h = y1 - y0 + 1, terrain = pathTerrain();
    if (w * h > PATH_MAX_CELLS) return `The chosen doors are too far apart (${w} × ${h} tiles): pick doors that are closer together.`;
    const kind = new Uint8Array(w * h), prefer = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, at = sectorAtWorld(x0 + x, y0 + y);
      if (!at) { kind[i] = PATH_CELL.OBSTACLE; continue; }
      const raw = at.sec.decoded.tiles[at.idx] >>> 0, bm = at.sec.decoded.blockMask;
      if (isHouseRaw(raw)) { kind[i] = PATH_CELL.HOUSE; continue; }
      const corners = tileCorners(raw), cls = Math.max(...[...new Set(corners)].map(classOf));
      kind[i] = (bm && ((bm[at.idx >> 5] >>> (at.idx & 31)) & 1)) || cls === 2 ? PATH_CELL.OBSTACLE : cls === 1 ? PATH_CELL.STREET : PATH_CELL.GROUND;
      if (corners.every(t => t === terrain)) prefer[i] = 1;
    }
    // walls and doors make a house of the tile they stand on; a tree or a rock blocks it
    for (const p of env.mobPoints) {
      const x = wxOf(p) - x0, y = wyOf(p) - y0;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (p.type === 0 || p.type === 1) kind[i] = PATH_CELL.HOUSE;
      else if ((p.type === 2 || p.type === 3) && !((p.objFlags | 0) & 0x401) && kind[i] !== PATH_CELL.HOUSE) kind[i] = PATH_CELL.OBSTACLE;
    }
    // the room behind each chosen door is a house too (a floor of outdoor tiles has no other sign), but the tile in front of the door is not
    const specs = [];
    for (const d of doors) {
      const room = flood(d.ix, d.iy);
      if (!room.open) for (let q = 0; q < room.cells.length; q += 2) {
        const x = room.cells[q] - x0, y = room.cells[q + 1] - y0;
        if (x >= 0 && y >= 0 && x < w && y < h) kind[y * w + x] = PATH_CELL.HOUSE;
      }
    }
    for (const d of doors) {
      const x = d.ox - x0, y = d.oy - y0, i = y * w + x, raw = tileRawAt(d.ox, d.oy);
      if (raw != null && !isHouseRaw(raw) && kind[i] === PATH_CELL.HOUSE) kind[i] = Math.max(...tileCorners(raw).map(classOf)) === 1 ? PATH_CELL.STREET : PATH_CELL.GROUND;
      specs.push({ x, y, dx: d.ox - d.ix, dy: d.oy - d.iy });
    }
    const seed = edit.pathSeed++;
    const plan = planVillagePaths({ w, h, kind, prefer }, specs, { width: Math.max(1, Math.min(8, Math.round(Number(ui.pathWidth.value)) || 3)), wind: Number(ui.pathWind.value) / 100, seed, timeLimit: Math.max(500, PATH_TIME_LIMIT_MS - (performance.now() - t0)) });
    const skip = (x, y) => {   // never blend onto a house or a street
      const lx = x - x0, ly = y - y0;
      if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
      const k = kind[ly * w + lx];
      return k === PATH_CELL.HOUSE || k === PATH_CELL.STREET;
    };
    const blend = ui.blend.checked && env.tileManifest?.size;
    const laid = [];
    let noArt = false;
    for (let i = 0; i < plan.paint.length; i++) {
      if (!plan.paint[i]) continue;
      const x = x0 + (i % w), y = y0 + ((i / w) | 0), raw = pathRaw(terrain, x, y);
      if (raw == null) { noArt = true; continue; }
      if (setTile(x, y, raw)) ensureArt(raw);
      laid.push(x, y);
    }
    let blendCut = false;
    if (blend) for (let i = 0; i < laid.length; i += 2) {
      if ((i & 63) === 62 && performance.now() - t0 > PATH_TIME_LIMIT_MS) { blendCut = true; break; }   // never hang on a huge path
      blendAround(laid[i], laid[i + 1], terrain, skip);
    }
    const name = secTileNameMesMap?.get(terrain)?.name;
    const cut = plan.timedOut ? ` · stopped after ${PATH_TIME_LIMIT_MS / 1000} s: some doors have no path` : blendCut ? ' · stopped smoothing the edges after 5 s' : '';
    return !laid.length ? `Could not lay a path: the doors are shut in by houses, water or trees${cut}.`
      : `${laid.length / 2} path tiles${name ? ` of ${name}` : ''} between ${plan.joined.length} doors${plan.failed.length && !plan.timedOut ? ` · ${plan.failed.length} door${plan.failed.length === 1 ? '' : 's'} could not be reached` : ''}${cut}${noArt ? ' · some tiles have no art' : ''}. Undo (Ctrl+Z) and press Draw paths again for another layout.`;
  };
  ui.pathClear.addEventListener('click', () => { edit.pathDoors = []; renderPathInfo(); env.scheduleCursor(); });
  ui.pathDraw.addEventListener('click', () => {
    if (edit.painting || edit.pathDoors.length < 2) return;
    edit.painting = true; edit.stroke = new Map(); edit.objOps = []; edit.strokeSeen = new Set(); edit.skippedMob = 0; edit.problem = null;
    let note = '';
    try { note = drawPaths(); } catch (err) { note = edit.problem = `Could not draw the paths: ${errText(err)}`; }
    edit.houseNote = note;
    endStroke();
    ui.pathInfo.textContent = note;
  });

  const eraseTile = (wx, wy) => {
    const k = `e${wx},${wy}`;
    if (edit.strokeSeen.has(k)) return false;   // one layer per tile and stroke
    edit.strokeSeen.add(k);
    // what was added here as a new .mob file goes first, the last one placed first
    if (overlayVisibility.otherMobs || overlayVisibility.containers) {
      const fresh = edit.newMobs.filter(m => wxOf(m.pt) === wx && wyOf(m.pt) === wy);
      if (fresh.length && removeNewMob(fresh[fresh.length - 1])) return true;
    }
    const list = objectsAt(wx, wy);
    const layers = [
      { on: overlayVisibility.scenery, items: list.filter(p => p.type === 3) },
      { on: overlayVisibility.otherMobs, items: list.filter(p => p.type === 1) },
      { on: overlayVisibility.walls, items: list.filter(p => p.type === 0) }
    ];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li]; if (!L.on || !L.items.length) continue;
      let targets = L.items.slice();
      if (li === 2) {
        const idx = getEdgeIndex();
        for (const w of L.items) { const ek = edgeKeyOf(w); if (ek != null) for (const e of idx.get(ek) || []) if (e.type === 1 && !targets.includes(e)) targets.push(e); }
      }
      let changed = false;
      for (const p of targets) if (removeObject(p)) changed = true;
      if (changed) return true;
    }
    return false;
  };
  const eraseFootprint = (wx, wy) => forFootprint(wx, wy, eraseTile);

  return { tileRawAt, renderPathInfo, pickDoor, drawDoorMarks, eraseFootprint };
}
