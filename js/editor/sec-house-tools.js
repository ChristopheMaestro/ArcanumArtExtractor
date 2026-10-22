// Placeholder houses: the site, walls, roof, floor, furniture, portals and facades of the House brush and the Generate tool
import { secEdgeRotation } from '../sec/sec-walls.js';
import { secAidWithRotation, secEdgeKey, secEnsureRoofs, secGameProtoForKey, secIsRoofId, secMakeFacadeRaw, secProtoCatalog, secWallAid } from './sec-writer.js';
import { mobOidTypeAndNumber } from '../proto/proto-resolution.js';
import { ART_TYPE } from '../core/art-id.js';
import { secRoofNum } from '../sec/sec-roofs.js';
import { secSectorKey } from '../sec/sec-placeholders.js';
import { protoCurrentAidArtId } from '../proto/critter-aid.js';
import { HOUSE_KIND_LIST, HOUSE_STYLES, houseFloorTile, planHouse, roofForWallStyle, roofTakesShapes, styleForKind } from './sec-house-plan.js';

export function createHouseTools(env) {
  const { PROTO_TYPE, addLight, addObject, edit, ensureArt, ensureRoofArt, gen, getEdgeIndex, invalidateObjIdx, liftLights, mapH, mapW, minX, minY, objectsAt, overlayVisibility, pk, plainTileRaw, redraw, refreshEditUi, removeLight, removeObject, resolveVariants, scatterRaw, scheduleEditRedraw, sectorAtWorld, setTile, status, touchSector, valid, variantCache, wxOf, wyOf } = env;

  // ---- the site of a new house -----------------------------------------------------------------------------------
  // What stands where a house goes is taken away first, as the game's houses have nothing under them: the objects
  // (a tree, grass, a lamp...) on its floor and under its roof, and walls, doors and windows across its inside.
  // `tiles`: its floor ([[x, y]]); `roofCells`: the roof cells over it ([{ cx, cy }], 4 x 4 tiles each).
  const clearHouseSite = (tiles, roofCells) => {
    const tk = (x, y) => `${x},${y}`, inside = new Set(tiles.map(([x, y]) => tk(x, y))), area = new Set(inside);
    for (const { cx, cy } of roofCells || []) for (let y = cy * 4; y < cy * 4 + 4; y++) for (let x = cx * 4; x < cx * 4 + 4; x++) area.add(tk(x, y));
    const NB = [[-1, 0], [0, 1], [1, 0], [0, -1]];      // the tile across edge NE, SE, SW, NW
    let removed = 0;
    // (items lying there and traps too; not containers - their contents are objects of their own - nor critters)
    for (const p of env.mobPoints.slice()) {
      if (!p.staticSecObject || !p.__obj || p.type === 2 || p.type === 15 || p.type === 16) continue;
      const x = wxOf(p), y = wyOf(p), k = tk(x, y);
      if (!area.has(k)) continue;
      if (p.type === 0 || p.type === 1) {
        const rot = secEdgeRotation(p) ?? p.__rot; if (rot == null) continue;
        const nb = NB[(rot >> 1) & 3];
        if (!(inside.has(k) && inside.has(tk(x + nb[0], y + nb[1])))) continue;   // only walls inside the house
      }
      if (removeObject(p)) removed++;
    }
    // and the lights of the old rooms (the sector lights standing on its floor)
    for (const sec of valid) for (const light of (sec.decoded.lights || []).slice()) if (inside.has(tk(light.x - minX * 64, light.y - minY * 64)) && removeLight(sec, light)) removed++;
    return removed;
  };
  const houseRoofCells = (house, plan, roofed) => {
    if (!roofed) return [];
    if (plan?.roof?.length) return plan.roof;
    const { x0, x1, y0, y1 } = houseRoofBlock(house), cells = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) cells.push({ cx, cy });
    return cells;
  };
  const houseTiles = ({ a, b, c, e }, plan) => {
    if (plan?.tiles) return plan.tiles;
    const out = [];
    for (let y = c; y < e; y++) for (let x = a; x < b; x++) out.push([x, y]);
    return out;
  };

  const placeScenery = (wx, wy) => {
    const item = edit.sel.scenery; if (!item) return false;
    const k = `s${wx},${wy}`;
    if (edit.strokeSeen.has(k)) return false;
    edit.strokeSeen.add(k);
    const rv = pk.scenery.rot.value;
    const aid = rv === 'proto' ? item.aid : secAidWithRotation(item.aid, Number(rv));
    if (objectsAt(wx, wy).some(p => p.type === 3 && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num && (Number(p.currentAidRaw) >>> 0) === aid)) return false;
    return !!addObject(wx, wy, 3, item, aid, null);
  };

  const wallPiece = () => pk.wall.piece.value === 'auto' ? (edit.commonPiece ?? 0) : Number(pk.wall.piece.value);
  // The game stores a wall's rotation as 1, 3, 5, 7 for its NE, SE, SW, NW edge (all 421,797 walls of
  // the shipped sectors: no wall has an even rotation), so that is what is written.
  const wallRotation = dir => dir * 2 + 1;
  const placeWall = ({ wx, wy, dir, piece }) => {
    const item = edit.sel.wall; if (!item || item.num == null) return false;
    const key = secEdgeKey(wx, wy, dir);
    if (edit.strokeSeen.has(`w${key}`)) return false;
    edit.strokeSeen.add(`w${key}`);
    const rot = wallRotation(dir);
    const aid = secWallAid(item.aid, piece ?? wallPiece(), rot, Number(pk.wall.variation.value));
    const existing = (getEdgeIndex().get(key) || []).filter(p => p.type === 0);
    if (existing.some(p => (Number(p.currentAidRaw) >>> 0) === aid && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num)) return false;
    let changed = false;
    for (const p of existing) if (removeObject(p)) changed = true;   // replacing the wall that stood there
    if (addObject(wx, wy, 0, item, aid, rot)) changed = true;
    return changed;
  };

  // The nearest roofable span to tiles [lo, hi) on an axis of `size` tiles: lo = 2 mod 4, hi = 3 mod 4, at
  // least 5 tiles, and its roof cells inside the map (houseRoofBlock).
  const snapHouseSpan = (lo, hi, size) => {
    let a = 4 * Math.round((lo - 2) / 4) + 2, b = 4 * Math.round((hi - 3) / 4) + 3;
    if (a < 2) a = 2;
    if (b - a < 5) b = a + 5;
    while (b > size - 1) b -= 4;
    if (b - a < 5) a = b - 5;
    return [a, b];
  };
  // Line / rectangle brushes work on tile CORNERS. Corner (i, j) sits at world (i - 0.5, j - 0.5), so tile x lies
  // between corners x and x + 1. Edge directions: 0 = NE (towards x-1), 1 = SE (y+1), 2 = SW (x+1), 3 = NW (y-1).
  // the House brush of the Wall tool, and the Generate tool: a house drawn corner to corner
  const houseBrush = () => edit.tool === 'generate' || edit.wallBrush === 'house';
  const vertexFromFloat = f => ({ i: Math.max(0, Math.min(mapW, Math.round(f.fx + 0.5))), j: Math.max(0, Math.min(mapH, Math.round(f.fy + 0.5))) });
  const wallSegments = d => {
    const out = [], inMap = (x, y) => x >= 0 && y >= 0 && x < mapW && y < mapH;
    if (houseBrush()) {
      let a = Math.min(d.i0, d.i1), b = Math.max(d.i0, d.i1), c = Math.min(d.j0, d.j1), e = Math.max(d.j0, d.j1);
      if (b > a && e > c) {
        // With a roof, the walls are snapped to the roof grid (see houseRoofBlock): the roof pieces are
        // whole 4 x 4-tile pictures, so any other rectangle is left partly uncovered or overhung. (A generated building
        // always has its roof.)
        if (edit.tool === 'generate' || pk.wall.roof.value !== 'none' || wantShapes()) { [a, b] = snapHouseSpan(a, b, mapW); [c, e] = snapHouseSpan(c, e, mapH); }
        // Every wall belongs to a tile inside the house. The game ends each side with a corner piece, and
        // the pieces are the ones it uses in its own houses (read off every house of the shipped sectors):
        //   top corner (a, c)       NE 6 · NW 5        right corner (a, e-1)   NE 2 · SE 1
        //   bottom corner (b-1, e-1) SE 4 · SW 3       left corner (b-1, c)    SW 1 · NW 2
        // and 0 (a plain wall) between them.
        const piece = (isFirst, isLast, first, last) => isFirst ? first : isLast ? last : 0;
        for (let x = a; x < b; x++) {
          out.push({ wx: x, wy: c, dir: 3, piece: piece(x === a, x === b - 1, 5, 2) });        // NW side: top corner → left corner
          out.push({ wx: x, wy: e - 1, dir: 1, piece: piece(x === a, x === b - 1, 1, 4) });    // SE side: right corner → bottom corner
        }
        for (let y = c; y < e; y++) {
          out.push({ wx: a, wy: y, dir: 0, piece: piece(y === c, y === e - 1, 6, 2) });        // NE side: top corner → right corner
          out.push({ wx: b - 1, wy: y, dir: 2, piece: piece(y === c, y === e - 1, 1, 3) });    // SW side: left corner → bottom corner
        }
        out.house = { a, b, c, e };
        return out;
      }                               // a flat "house" is just a line
    }
    const dx = d.i1 - d.i0, dy = d.j1 - d.j0;
    if (!dx && !dy) return out;
    if (Math.abs(dx) >= Math.abs(dy)) {            // runs along x: the walls sit on the edge between rows j-1 and j
      const j = d.j0, lo = Math.min(d.i0, d.i1), hi = Math.max(d.i0, d.i1), upper = d.sy < j - 0.5;
      for (let x = lo; x < hi; x++) {
        let wy = upper ? j - 1 : j, dir = upper ? 1 : 3;
        if (!inMap(x, wy)) { wy = upper ? j : j - 1; dir = upper ? 3 : 1; }
        if (inMap(x, wy)) out.push({ wx: x, wy, dir });
      }
    } else {                                       // runs along y: the walls sit on the edge between columns i-1 and i
      const i = d.i0, lo = Math.min(d.j0, d.j1), hi = Math.max(d.j0, d.j1), left = d.sx < i - 0.5;
      for (let y = lo; y < hi; y++) {
        let wx = left ? i - 1 : i, dir = left ? 2 : 0;
        if (!inMap(wx, y)) { wx = left ? i : i - 1; dir = left ? 0 : 2; }
        if (inMap(wx, y)) out.push({ wx, wy: y, dir });
      }
    }
    return out;
  };
  // ---- house roof ----------------------------------------------------------------------------------
  // The roof grid has one art id per 4 x 4 tiles: type 10 (28-31), roof number (19-27), piece (14-18) and
  // bits 0 + 4 for a mirrored picture. A roof is a block of cells; which piece goes where was read off the
  // roofs of the shipped sectors (the same piece and mirror in every one of their thousands of blocks):
  //   corners   top (smallest x and y) 7 · left (largest x, smallest y) 0 · right 0 mirrored · bottom 4
  //   edges     smallest y 2 · largest x 1 · largest y 1 mirrored · smallest x 2 mirrored      centre 8
  const roofId = (num, piece, mirrored) => (((ART_TYPE.ROOF << 28) | (num << 19) | (piece << 14) | (mirrored ? 0x11 : 0)) >>> 0);
  const roofPieceAt = (i, j, w, h) => {
    const x0 = i === 0, x1 = i === w - 1, y0 = j === 0, y1 = j === h - 1;
    if (x0 && y0) return [7, false];
    if (x1 && y0) return [0, false];
    if (x0 && y1) return [0, true];
    if (x1 && y1) return [4, false];
    if (y0) return [2, false];
    if (x1) return [1, false];
    if (y1) return [1, true];
    if (x0) return [2, true];
    return [8, false];
  };
  // The map's most used roof style (the fallback of "Auto").
  const usualRoofNum = () => {
    const counts = new Map();
    for (const s of valid) for (const v of s.decoded.roofArtIds || []) if (secIsRoofId(v)) { const n = secRoofNum(v >>> 0); counts.set(n, (counts.get(n) || 0) + 1); }
    let best = 2, bc = 0;
    for (const [n, c] of counts) if (c > bc) { best = n; bc = c; }
    return best;
  };
  // The roof chosen in the House brush: "Auto" is the one the game's houses of the selected wall style have (read off
  // the map: HOUSE_STYLE_ROOFS), else the map's usual one.
  // The roof always follows the walls, as in the game; a roof whose inner corners the game never closes keeps the house a
  // rectangle (houseShapes) rather than taking another roof.
  const wantShapes = () => !pk.wall.shapes.disabled && pk.wall.shapes.checked;
  const chosenRoofNum = () => {
    const choice = pk.wall.roof.value;
    if (choice !== 'auto') return Number(choice);
    return roofForWallStyle(edit.sel.wall?.artKey) ?? usualRoofNum();
  };
  // The cells of the roof of a house with tiles [a, b) x [c, e). In the game's own houses (322 of them, read
  // off the shipped sectors) the roof block is the one that spans tiles [a - 2, b + 1) on each axis: a 5 x 5
  // house standing on a tile 2 mod 4 has the 2 x 2 cells around it, a 9 x 9 one 3 x 3... so a roofed house
  // has a = 2 mod 4, b = 3 mod 4 and at least 5 tiles a side (a roof of a single cell has no piece in the
  // game's art). wallSegments() snaps the House brush to that (snapHouseSpan), so the block is exact.
  const houseRoofBlock = ({ a, b, c, e }) => ({ x0: (a - 2) >> 2, x1: ((b + 1) >> 2) - 1, y0: (c - 2) >> 2, y1: ((e + 1) >> 2) - 1 });
  const setRoofCell = (cx, cy, raw) => {
    const at = sectorAtWorld(cx * 4, cy * 4); if (!at) return false;
    const d = at.sec.decoded;
    if (d.roofListOffset == null || !d.sourceBuffer) { edit.problem = `${at.sec.filename}: its roof list could not be located, so a roof cannot be added there`; return false; }
    const ids = secEnsureRoofs(d);
    const i = (((cy * 4) & 63) >> 2) * 16 + (((cx * 4) & 63) >> 2);
    if ((ids[i] >>> 0) === raw) return false;
    // a cell changed twice in one step (painted, then fitted to its neighbours) is one entry: undo restores the first state
    const again = edit.objOps.find(o => o.kind === 'roof' && o.sec === at.sec && o.idx === i);
    if (again) again.after = raw; else edit.objOps.push({ kind: 'roof', sec: at.sec, idx: i, before: ids[i] >>> 0, after: raw });
    ids[i] = raw;
    edit.roofSecs.set(secSectorKey(at.sec), at.sec);
    return true;
  };
  // `cells`: the roof of a shaped house ([{ cx, cy, piece, mirrored }], from its plan) instead of the whole block.
  // `roofNum`: that roof whatever the Wall tool's choice (a generated building's)
  const placeHouseRoof = (house, cells = null, roofNum = null) => {
    if (roofNum == null && pk.wall.roof.value === 'none') return;
    const num = roofNum ?? chosenRoofNum();
    const { x0, x1, y0, y1 } = houseRoofBlock(house);
    let changed = false;
    if (cells) {
      for (const r of cells) if (setRoofCell(r.cx, r.cy, roofId(num, r.piece, r.mirrored))) changed = true;
    } else for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const [piece, mirrored] = roofPieceAt(cx - x0, cy - y0, x1 - x0 + 1, y1 - y0 + 1);
      if (setRoofCell(cx, cy, roofId(num, piece, mirrored))) changed = true;
    }
    if (!changed) return;
    // Roofs are only drawn with the Roofs layer on; it is left as the user has it.
    if (overlayVisibility.roofs) ensureRoofArt();
  };
  // ---- placeholder houses (see sec-house-plan.js) ----------------------------------------------------
  // The prototype a door, window or piece of furniture is placed with: the one that already has its art, else
  // the one this map uses most (of the doors for a door, of the windows for a window), with the art id
  // overridden - what the Portal and Scenery palettes do for a texture without a prototype of its own.
  const makeProtoPicker = () => {
    const used = {};
    const mostUsed = (kind, pool) => {
      if (!used[kind]) {
        used[kind] = new Map();
        for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === PROTO_TYPE[kind]) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) used[kind].set(n, (used[kind].get(n) || 0) + 1); }
      }
      let best = pool[0], bn = -1;
      for (const it of pool) { const n = used[kind].get(it.num) || 0; if (n > bn) { bn = n; best = it; } }
      return best;
    };
    const isDoorAid = aid => ((aid >>> 10) & 1) === 1;
    const cache = new Map();
    // portal: key = door number, or window number + 1001 (portal.mes); scenery: key = scenery.mes number
    return (kind, key) => {
      const ck = `${kind}${key}`;
      if (cache.has(ck)) return cache.get(ck);
      const items = secProtoCatalog.byType[PROTO_TYPE[kind]] || [];
      const keyOf = it => kind === 'portal' ? env.TEX.portal.keyOfAid(it.aid) : protoCurrentAidArtId(it.aid, 3);
      const game = secGameProtoForKey(PROTO_TYPE[kind], key);
      let proto = (game && items.find(it => it.num === game.num)) || items.find(it => keyOf(it) === key) || null;
      if (!proto && items.length) {
        const like = kind === 'portal' ? items.filter(it => isDoorAid(it.aid) === (key < 1001)) : items;
        proto = mostUsed(kind, like.length ? like : items);
      }
      const item = proto && { num: proto.num, label: proto.label, objType: PROTO_TYPE[kind], aid: kind === 'portal' ? env.TEX.portal.aidOf(key, proto.aid) : env.sceneryAidOf(key) };
      cache.set(ck, item);
      return item;
    };
  };
  // A portal on the tile edge of a wall that has just been drawn (placePortal does the same from a mouse click).
  const placePortalOnEdge = ({ wx, wy, dir }, item) => {
    const rot = wallRotation(dir), aid = secAidWithRotation(item.aid, rot);
    let changed = false;
    for (const p of (getEdgeIndex().get(secEdgeKey(wx, wy, dir)) || []).filter(q => q.type === 1)) if (removeObject(p)) changed = true;
    return !!addObject(wx, wy, 1, item, aid, rot) || changed;
  };
  // Other shapes than the rectangle need a roof whose art closes an inner corner (the brick parapets do not: the game only
  // has rectangles of those, side by side)
  const houseShapes = () => wantShapes() && (pk.wall.roof.value === 'none' || roofTakesShapes(chosenRoofNum()));
  const planPlaceholders = house => {
    const num = edit.sel.wall.artKey;
    // other shapes than the rectangle only on the roof grid (the walls are snapped to it when there is a roof)
    const plan = num == null ? null : planHouse(num, house, null, { shapes: houseShapes() });
    if (!plan) { edit.houseNote = 'no placeholders: the game has no houses with this wall style'; return null; }
    if (!secProtoCatalog.done) { edit.houseNote = 'no placeholders yet: the prototypes are still being scanned'; return null; }
    return plan;
  };
  // (the bits of a rug cell beside its facade, cell and walkable flag: what all 3548 rug cells of the game's maps have)
  const HOUSE_RUG_KEEP = 0x4000800;
  // `portals` false: only the furniture and rugs (the door and windows stay)
  const placePlaceholders = (plan, { portals = true } = {}) => {
    const pick = makeProtoPicker();
    let missing = 0;
    if (portals) for (const p of plan.portals) {
      const item = pick('portal', p.door ? p.num : p.num + 1001);
      if (item) placePortalOnEdge(p, item); else missing++;
    }
    for (const s of plan.scenery) {
      const item = pick('scenery', s.key);
      if (!item) { missing++; continue; }
      const aid = secAidWithRotation(item.aid, s.rot ?? 0);
      if (objectsAt(s.wx, s.wy).some(p => p.type === 3 && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num && (Number(p.currentAidRaw) >>> 0) === aid)) continue;
      addObject(s.wx, s.wy, 3, item, aid, null, s.off);
    }
    // the rugs: facade cells over the floor's tiles, walkable, with the other bits the game's rugs have. What each tile was
    // is kept, so "Generate again" can lay the floor back before laying new ones.
    const rugs = [];
    for (const f of plan.facades || []) {
      const at = sectorAtWorld(f.wx, f.wy); if (!at) continue;
      const before = at.sec.decoded.tiles[at.idx] >>> 0, raw = secMakeFacadeRaw(f.num, f.frame, 1, HOUSE_RUG_KEEP);
      if (setTile(f.wx, f.wy, raw)) { rugs.push({ wx: f.wx, wy: f.wy, before, raw }); ensureArt(raw); }
    }
    // the light of its rooms (daylight by the windows, a lamp's glow): sector lights, which the game lights its houses with
    const lights = (plan.lights || []).map(l => addLight(l)).filter(Boolean);
    edit.houseNote = missing ? `${missing} placeholder${missing === 1 ? '' : 's'} skipped (no prototype to place ${missing === 1 ? 'it' : 'them'} with)` : `${plan.style.name} house with its door, windows and furniture`;
    return { rugs, lights };
  };
  // the rugs a placeholder house was given, taken up again (where the tile is still the rug's)
  const liftRugs = rugs => {
    for (const r of rugs || []) {
      const at = sectorAtWorld(r.wx, r.wy);
      if (at && (at.sec.decoded.tiles[at.idx] >>> 0) === r.raw) setTile(r.wx, r.wy, r.before);
    }
  };
  // ---- house floor: the tile the game lays under a house of this wall style (HOUSE_FLOORS) ---------------
  const houseFloorId = () => houseFloorTile(edit.sel.wall?.artKey);
  // Its art files take a moment to load: start that when the House drag begins, so they are there at release.
  const preloadHouseFloor = () => {
    const id = houseFloorId();
    if (id != null && pk.wall.floor.checked) resolveVariants(id).then(vs => { for (const v of vs) env.artTiles.set(v.raw, v.art); });
  };
  const placeHouseFloor = ({ a, b, c, e }, tiles = null) => {
    const id = houseFloorId(); if (id == null) return false;
    const vs = variantCache.get(id);
    if (!vs) {
      // not loaded yet (Generate never preloads for its own style): lay variant a now, then scatter the variants over
      // the tiles still showing it once they are there, or the whole floor would look the same
      const plain = plainTileRaw(id, 0), spots = tiles ? [...tiles] : [];
      if (!tiles) for (let y = c; y < e; y++) for (let x = a; x < b; x++) spots.push([x, y]);
      resolveVariants(id).then(loaded => {
        if (!loaded.length) return;
        for (const v of loaded) env.artTiles.set(v.raw, v.art);
        // written straight into the tiles: the stroke that laid variant a already holds their old values, so undo still restores them
        for (const [x, y] of spots) {
          const at = sectorAtWorld(x, y);
          if (at && (at.sec.decoded.tiles[at.idx] >>> 0) === plain) { at.sec.decoded.tiles[at.idx] = scatterRaw(loaded, x, y); touchSector(at.sec); }
        }
        redraw();
      });
    }
    const list = vs?.length ? vs : [{ raw: plainTileRaw(id, 0) }];
    let changed = false;
    if (tiles) { for (const [x, y] of tiles) if (setTile(x, y, scatterRaw(list, x, y))) changed = true; return changed; }   // a shaped house
    for (let y = c; y < e; y++) for (let x = a; x < b; x++) if (setTile(x, y, scatterRaw(list, x, y))) changed = true;
    return changed;
  };
  // A wall of structure `num` to build with, as the Wall palette would pick it: the prototype that has that art, else the
  // one this map uses most with the art set on it.
  const wallItemFor = num => {
    const items = secProtoCatalog.byType[PROTO_TYPE.wall] || [];
    if (!items.length) return null;
    const game = secGameProtoForKey(PROTO_TYPE.wall, num);
    let proto = (game && items.find(it => it.num === game.num)) || items.find(it => env.TEX.wall.keyOfAid(it.aid) === num);
    if (!proto) {
      const use = new Map();
      for (const sec of valid) for (const o of sec.decoded.staticObjects || []) if (o.objType === PROTO_TYPE.wall) { const n = mobOidTypeAndNumber(o.protoOid)?.number; if (n != null) use.set(n, (use.get(n) || 0) + 1); }
      proto = items.reduce((b, it) => (use.get(it.num) || 0) > (use.get(b.num) || 0) ? it : b, items[0]);
    }
    return { num: proto.num, label: HOUSE_STYLES[num]?.name || String(num), aid: env.TEX.wall.aidOf(num, proto.aid), objType: PROTO_TYPE.wall, artKey: num };
  };
  // Generate: the building of the kind picked, on the drag's rectangle (snapped to the roof grid), with its walls drawn when
  // Auto; the roof the game gives those walls (one that closes inner corners, for a shape)
  const commitGenerate = d => {
    const kind = HOUSE_KIND_LIST.find(k => k.id === edit.genKind); if (!kind) return;
    const num = gen.style.value === 'auto' ? styleForKind(kind.id) : Number(gen.style.value);
    const item = wallItemFor(num);
    if (!item) { edit.houseNote = 'the wall prototypes are still being scanned - try again in a moment'; return; }
    const sel = edit.sel.wall;
    edit.sel.wall = item;
    try {
      const segs = wallSegments(d); if (!segs.house) return;
      const roofNum = roofForWallStyle(num) ?? usualRoofNum();
      const shapes = gen.shapes.checked && roofTakesShapes(roofNum);
      const plan = planHouse(num, segs.house, null, { shapes, kind: kind.id });
      if (!plan) { edit.houseNote = 'the game has no houses with these walls'; return; }
      const cleared = clearHouseSite(houseTiles(segs.house, plan), houseRoofCells(segs.house, plan, true));
      placeHouseFloor(segs.house, plan.tiles);
      edit.housePts = [];
      for (const s of plan.walls) placeWall(s);
      placeHouseRoof(segs.house, plan.roof?.length ? plan.roof : null, roofNum);
      const { rugs, lights } = placePlaceholders(plan);
      setLastHouse({ house: segs.house, num, wallItem: item, shapes, seed: plan.seed, doorSide: plan.doorSide,
        styleName: `${kind.name} (${plan.style.name})`, pts: edit.housePts, rugs, lights, kind: kind.id });
      edit.housePts = null;
      if (!(edit.houseNote || '').includes('skipped')) edit.houseNote = `${kind.name}, ${plan.style.name} walls`;
      if (cleared) edit.houseNote += ` · ${cleared} object${cleared === 1 ? '' : 's'} that stood there removed`;
    } finally { edit.sel.wall = sel; }
  };
  const commitWallDrag = () => {
    const d = edit.wallDrag; edit.wallDrag = null;
    if (!d) return;
    if (edit.tool === 'generate') { commitGenerate(d); return; }
    const segs = wallSegments(d);
    // With placeholders, the plan decides the house's shape: its walls (outline, openings, dividers), floor and roof.
    const plan = segs.house && pk.wall.placeholders.checked ? planPlaceholders(segs.house) : null;
    const cleared = segs.house ? clearHouseSite(houseTiles(segs.house, plan), houseRoofCells(segs.house, plan, pk.wall.roof.value !== 'none')) : 0;
    if (segs.house && pk.wall.floor.checked) placeHouseFloor(segs.house, plan?.tiles);
    if (plan) edit.housePts = [];
    for (const s of plan ? plan.walls : segs) placeWall(s);
    if (segs.house) placeHouseRoof(segs.house, plan?.roof?.length ? plan.roof : null);
    if (plan) {
      const { rugs, lights } = placePlaceholders(plan);
      // what "Generate again" and "Turn" work on: this house, the objects it was built with, how to plan it again
      setLastHouse({ house: segs.house, num: edit.sel.wall.artKey, wallItem: edit.sel.wall, shapes: houseShapes(),
        seed: plan.seed, doorSide: plan.doorSide, styleName: plan.style.name, pts: edit.housePts, rugs, lights });
      edit.housePts = null;
    }
    if (cleared) edit.houseNote = `${edit.houseNote ? `${edit.houseNote} · ` : ''}${cleared} object${cleared === 1 ? '' : 's'} that stood there removed`;
  };
  // ---- "Generate again" / "Turn": the last placeholder house rebuilt from its plan's seed ---------------------------
  // Generate again: new furniture. Turn: the front door on the next side (NE → SE → SW → NW → NE), its walls and windows
  // redone to match, and new furniture. The shape, rooms, floor and roof stay (the same seed gives the same layout).
  const setLastHouse = h => {
    const before = edit.lastHouse;
    edit.lastHouse = h;
    edit.houseSnap = { before, after: h };
    syncHouseBtns();
  };
  const syncHouseBtns = () => { pk.wall.regen.disabled = pk.wall.turn.disabled = gen.regen.disabled = gen.turn.disabled = !edit.lastHouse; };
  const SIDE_NAMES = ['NE', 'SE', 'SW', 'NW'];
  const houseAction = turn => {
    const h = edit.lastHouse; if (!h || edit.painting) return;
    edit.objOps = []; edit.stroke = new Map(); edit.strokeSeen = new Set(); edit.problem = null; edit.skippedMob = 0; edit.houseNote = null;
    // take away what the house was given: its furniture and rugs; to turn it, its walls, door and windows too
    const keep = [];
    for (const p of h.pts) if (p.type === 3 || turn) removeObject(p); else keep.push(p);
    liftRugs(h.rugs);
    liftLights(h.lights);
    const plan = planHouse(h.num, h.house, null, { shapes: h.shapes, seed: h.seed, doorSide: turn ? (h.doorSide + 1) % 4 : h.doorSide, kind: h.kind || null });
    const sel = edit.sel.wall;
    edit.sel.wall = h.wallItem;
    edit.housePts = keep;
    let rugs = [], lights = [];
    try {
      if (turn) for (const s of plan.walls) placeWall(s);
      ({ rugs, lights } = placePlaceholders(plan, { portals: turn }));
    } finally { edit.sel.wall = sel; }
    setLastHouse({ ...h, doorSide: plan.doorSide, pts: edit.housePts, rugs, lights });
    edit.housePts = null;
    const entries = [];
    for (const e of edit.stroke.values()) entries.push({ kind: 'tile', sec: e.sec, idx: e.idx, before: e.before, after: e.sec.decoded.tiles[e.idx] >>> 0 });
    entries.push(...edit.objOps);
    edit.objOps = []; edit.stroke = null;
    if (entries.length) {
      entries.house = edit.houseSnap;
      edit.undo.push(entries); if (edit.undo.length > 300) edit.undo.shift();
      edit.redo.length = 0; edit.unsaved = true;
    }
    edit.houseSnap = null;
    const what = h.kind ? h.styleName : `${h.styleName} house`;
    status.textContent = turn ? `${what}: front door on the ${SIDE_NAMES[plan.doorSide]} side` : `${what}: new furniture`;
    if (edit.houseNote && edit.houseNote.includes('skipped')) status.textContent += ` · ${edit.houseNote}`;
    edit.houseNote = null;
    invalidateObjIdx(); refreshEditUi(); scheduleEditRedraw();
  };
  pk.wall.regen.addEventListener('click', () => houseAction(false));
  pk.wall.turn.addEventListener('click', () => houseAction(true));
  gen.regen.addEventListener('click', () => houseAction(false));
  gen.turn.addEventListener('click', () => houseAction(true));
  const cancelWallDrag = () => {
    if (!edit.wallDrag) return;
    edit.wallDrag = null; edit.painting = false; edit.stroke = null; edit.objOps = [];
    status.textContent = 'Cancelled'; env.scheduleCursor();
  };

  const portalTarget = f => {
    const idx = getEdgeIndex();
    let best = null, bd = 0.75 * 0.75;
    for (let tx = f.wx - 1; tx <= f.wx + 1; tx++) for (let ty = f.wy - 1; ty <= f.wy + 1; ty++) for (const dir of [0, 1]) {
      const key = `${tx},${ty},${dir}`;
      const wall = (idx.get(key) || []).find(p => p.type === 0);
      if (!wall) continue;
      const mid = dir === 0 ? [tx - 0.5, ty] : [tx, ty + 0.5];
      const d = (mid[0] - f.fx) ** 2 + (mid[1] - f.fy) ** 2;
      if (d < bd) { bd = d; best = { tx, ty, dir, key, wall }; }
    }
    return best;
  };
  const placePortal = f => {
    const item = edit.sel.portal; if (!item || item.num == null) return false;
    const hit = portalTarget(f);
    if (!hit) { edit.problem = 'Portals can only be placed on a wall: click right on a wall.'; return false; }
    const rot = secEdgeRotation(hit.wall) ?? hit.wall.__rot ?? 0;
    const aid = secAidWithRotation(item.aid, rot);
    const existing = (getEdgeIndex().get(hit.key) || []).filter(p => p.type === 1);
    if (existing.some(p => (Number(p.currentAidRaw) >>> 0) === aid && p.__obj && mobOidTypeAndNumber(p.__obj.protoOid)?.number === item.num)) return false;
    let changed = false;
    for (const p of existing) if (removeObject(p)) changed = true;
    if (addObject(wxOf(hit.wall), wyOf(hit.wall), 1, item, aid, rot)) changed = true;
    return changed;
  };

  // The cells to stamp with the picked facade's first cell on (wx, wy): { num, frame, wx, wy, art }. With "Whole
  // structure" the other parts of its group (sel.parts, see selectFacade) come along, each at its place.
  const facadeCells = (sel, wx, wy) => {
    const cells = sel.offsets ? sel.idxs.map(fr => {
      const o = sel.offsets.get(fr) || [0, 0];
      return { frame: fr, wx: wx + o[0], wy: wy + o[1] };
    }) : sel.idxs.map(fr => {
      const rel = fr - sel.idxs[0], col = rel % sel.cols, row = Math.floor(rel / sel.cols);
      return { frame: fr, wx: wx + col * sel.colVec[0] + row * sel.rowVec[0], wy: wy + col * sel.colVec[1] + row * sel.rowVec[1] };
    });
    for (const c of cells) { c.num = sel.num; c.art = sel.artByFrame.get(c.frame); }
    if (sel.whole && sel.parts) {
      for (const part of sel.parts) {
        for (const [fr, o] of part.offsets) cells.push({ num: part.num, frame: fr, wx: wx + part.dx + o[0], wy: wy + part.dy + o[1], art: part.artByFrame.get(fr) });
      }
    }
    return cells;
  };
  const placeFacade = (wx, wy) => {
    const sel = edit.sel.facade; if (!sel) return false;
    let changed = false;
    for (const c of facadeCells(sel, wx, wy)) {
      const raw = secMakeFacadeRaw(c.num, c.frame, sel.walkable, sel.keep);
      if (!env.artTiles.has(raw) && c.art) env.artTiles.set(raw, c.art);
      if (setTile(c.wx, c.wy, raw)) changed = true;
    }
    return changed;
  };

  return { placeScenery, wallPiece, wallRotation, placeWall, vertexFromFloat, wallSegments, usualRoofNum, setRoofCell, preloadHouseFloor, commitWallDrag, syncHouseBtns, houseAction, cancelWallDrag, portalTarget, placePortal, facadeCells, placeFacade };
}
