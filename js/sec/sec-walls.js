// Wall placement and draw order.

import { SEC_ISO_HALF_H, SEC_ISO_HALF_W, secIsoProject } from './sec-iso.js';

// Rotation that decides which tile edge a wall or portal stands on.
export function secEdgeRotation(p) {
  if (Number.isInteger(p?.wallDecode?.rotation)) return p.wallDecode.rotation & 7;
  if (Number.isInteger(p?.portalRotation)) return p.portalRotation & 7;
  return null;
}

// Where a wall's ART hotspot lands, relative to the tile centre (unzoomed iso px).
//
// Every object is blitted at  anchor - hotspot  (game/object.c object_get_rect),
// and the tig art module that would define a wall's anchor is not in the source
// zip. What the zip does fix is the geometry of each edge (game/light.c
// sub_4DC210: start point + 2:1 slope, 40 px long, ground line = the edge).
// The anchors below follow from measured sprites, with the rest by symmetry.
// Relative to the left end of the edge's ground line:
//   * unmirrored art (rot 0,1,4,5): hotspot x = last column (the edge's right
//     end), hotspot y = 40 px below the ground line
//   * mirrored art  (rot 2,3,6,7): hotspot x = column 1 (the edge's left end),
//     hotspot y = 20 px above the ground line
// (Observed on the map: mirrored art sat ~21 px lower than unmirrored art when
// both used 20 px, so the unmirrored hotspot is 21 px further from the ground.)
// Left ends of the edges: NE top vertex (0,-20), SE bottom vertex (0,+20),
// SW and NW left vertex (-40,0). So:
//   NE (rot 0,1)  (+40, -21)     SE (rot 2,3)  (  0,   0)
//   SW (rot 4,5)  (  0,  -1)     NW (rot 6,7)  (-40, -20)
// UNVERIFIED for SW/NW (no clean sample of those); the tooltip shows the numbers used.
export function secWallAnchor(rotation) {
  // One rule per art orientation, instead of per-sprite fixes.
  const UNMIRRORED_DY = -20; // unmirrored anchors sit 21 px higher (20 left a 2 px gap at corners)
  switch (((rotation >> 1) & 3)) {
    case 0: return { dx: SEC_ISO_HALF_W, dy: UNMIRRORED_DY };                 // NE (unmirrored)
    case 1: return { dx: 0 + 2, dy: 0 };                                          // SE (mirrored)
    case 2: return { dx: 0, dy: SEC_ISO_HALF_H + UNMIRRORED_DY };             // SW (unmirrored)
    default: return { dx: -SEC_ISO_HALF_W + 2, dy: -SEC_ISO_HALF_H };             // NW (mirrored)
  }
}

// Left end of the tile edge a wall rotation sits on, relative to the tile
// centre, in unzoomed iso pixels. Rotation/2: 0 = NE edge, 1 = SE, 2 = SW,
// 3 = NW. NE/SW edges slope down-right (art as stored), SE/NW slope
// up-right (art mirrored).
function secWallEdgeLeftEnd(rotation) {
  switch (((rotation >> 1) & 3)) {
    case 0: return { dx: 0, dy: -SEC_ISO_HALF_H };                 // NE: top vertex
    case 1: return { dx: 0, dy: SEC_ISO_HALF_H };                  // SE: bottom vertex
    case 2: return { dx: -SEC_ISO_HALF_W, dy: 0 };                 // SW: left vertex
    default: return { dx: -SEC_ISO_HALF_W, dy: 0 };                // NW: left vertex
  }
}

// Draw order of placed objects, ported from the game.
//  * game/object.c object_draw(): tiles are scanned row by row (world Y, then
//    world X) and every object gets a running "order" number. Flat objects
//    (OF_FLAT) use the 200000000 band, everything else (critters, scenery,
//    items, walls, portals...) the 600000000 band, and the blits are sorted
//    by that number. So walls, portals and other objects share ONE ordering
//    instead of walls being painted over everything else.
//  * game/sector_object_list.c sub_4F20A0(): objects sharing a tile are kept
//    in a sorted list (flats first, a wall before a portal, then by their
//    pixel offset; walls/portals use a fixed +19 / -20 key by rotation).
const SEC_OF_FLAT = 0x00000004, SEC_OSCF_UNDER_ALL = 0x0200;
function secTileOrderKey(o) {
  let offX, offY;
  if (o.type === 0 || o.type === 1) {
    const rot = secEdgeRotation(o) ?? 0;
    offX = 0; offY = (rot > 1 && rot < 6) ? 19 : -20;
  } else {
    offX = Number(o.offsetX) || 0; offY = Number(o.offsetY) || 0;
  }
  // sub_4B93F0 (C integer division truncates toward zero)
  const v1 = Math.trunc((offX - 40) / 2), v2 = 2 * Math.trunc(offY / 2);
  return { a: v2 - v1, b: v1 + v2 };
}
// Roaming NPCs change tile, so they cannot stay where the cached order put them: `movers` ({ o,
// x, y } with the tile each stands on now) are left out of `ordered` by the caller and merged
// back in here, each in front of the first object of its tile that the game would draw after it
// (the rule of secInsertInTile). Walking behind a wall or a house then hides the NPC.
export function secMergeMovers(ordered, movers) {
  let u = 0;
  while (u < ordered.length && (ordered[u].objFlags & SEC_OF_FLAT)) u++;     // flat objects come first
  const ms = movers.map(m => ({ o: m.o, key: m.y * 1048576 + m.x, order: secTileOrderKey(m.o) })).sort((p, q) => p.key - q.key);
  const out = ordered.slice(0, u);
  let mi = 0;
  for (let i = u; i < ordered.length; i++) {
    const s = ordered[i], sk = s.worldY * 1048576 + s.worldX;
    while (mi < ms.length) {
      const m = ms[mi];
      let before = m.key < sk;
      if (m.key === sk) { const so = secTileOrderKey(s); before = m.order.b < so.b || (m.order.b === so.b && m.order.a < so.a); }
      if (!before) break;
      out.push(m.o); mi++;
    }
    out.push(s);
  }
  while (mi < ms.length) out.push(ms[mi++].o);
  return out;
}
function secInsertInTile(list, o) {
  const isFlat = (o.objFlags & SEC_OF_FLAT) !== 0;
  const nk = secTileOrderKey(o);
  for (let i = 0; i < list.length; i++) {
    const cur = list[i], curFlat = (cur.objFlags & SEC_OF_FLAT) !== 0;
    if (isFlat) {
      if (!curFlat) { list.splice(i, 0, o); return; }
      if (o.type === 3 && ((o.sceneryFlags & SEC_OSCF_UNDER_ALL) !== 0)) { list.splice(i, 0, o); return; }
    } else {
      if (o.type === 0 && cur.type === 1) { list.splice(i, 0, o); return; }
      if (o.type === 1 && cur.type === 0) { list.splice(i + 1, 0, o); return; }
    }
    if (!curFlat) {
      const ck = secTileOrderKey(cur);
      if (nk.b < ck.b || (nk.b === ck.b && nk.a < ck.a)) { list.splice(i, 0, o); return; }
    }
  }
  list.push(o);
}
export function secSortObjectsLikeGame(objects) {
  const tiles = new Map();
  // Objects are inserted in file order, as objlist_load() does.
  const inFileOrder = objects.slice().sort((p, q) =>
    (p.seq ?? 0) - (q.seq ?? 0) || String(p.file).localeCompare(String(q.file)));
  for (const o of inFileOrder) {
    const key = o.worldY * 1048576 + o.worldX;
    let list = tiles.get(key);
    if (!list) { list = []; tiles.set(key, list); }
    secInsertInTile(list, o);
  }
  const keys = [...tiles.keys()].sort((a, b) => a - b); // world Y, then world X
  const flat = [], upright = [];
  for (const k of keys) for (const o of tiles.get(k)) ((o.objFlags & SEC_OF_FLAT) !== 0 ? flat : upright).push(o);
  return flat.concat(upright);
}

// Color mode marks wall placement with its tile edge; actual-tile mode uses
// the wall ART selected from F_CURRENT_AID.
export function drawSecWallOverlay(ctx, wallPoints, bounds, mode, zoom, ox, oy, iso, lighting = null) {
  if (!wallPoints?.length) return;
  const mapWidthTiles = (bounds.maxX - bounds.minX + 1) * 64;
  const mapHeightTiles = (bounds.maxY - bounds.minY + 1) * 64;
  // Isometric painter's order: things further back (smaller x+y) first, so a
  // nearer wall overlaps the one behind it, as in the game.
  const depth = w => ((w.sectorX - bounds.minX) * 64 + w.tileX) + ((w.sectorY - bounds.minY) * 64 + w.tileY);
  // Objects sharing a tile are ordered like sub_4F20A0(): walls with rotation
  // 2..5 sit at +19 and the others at -20, smaller first, so the 2..5 wall is
  // drawn on top. Equal keys keep SEC file order (Array.sort is stable).
  const inTile = w => {
    const r = secEdgeRotation(w) ?? 0;
    return (r > 1 && r < 6) ? 1 : 0;
  };
  if (wallPoints.length > 1) wallPoints = wallPoints.slice().sort((a, b) => depth(a) - depth(b) || a.tileX - b.tileX || inTile(a) - inTile(b));
  for (const wall of wallPoints) {
    if (mode === 'art' && !wall.artCanvas) continue;
    const worldLocalX = (wall.sectorX - bounds.minX) * 64 + wall.tileX;
    const worldLocalY = (wall.sectorY - bounds.minY) * 64 + wall.tileY;
    const localX = mode === 'art' ? worldLocalX : (mapWidthTiles - 1 - worldLocalX);
    const localY = worldLocalY;
    if (localX < 0 || localY < 0 || localX >= mapWidthTiles || localY >= mapHeightTiles) continue;
    let px, py;
    if (mode === 'art') {
      // Tile centre (location_xy + 40,20). Walls move this to their edge anchor
      // (secWallAnchor) below; everything else is blitted at centre - hotspot.
      const p = secIsoProject(localX, localY, iso);
      px = p.x * zoom + ox; py = p.y * zoom + oy;
    } else {
      px = localX * zoom + ox + zoom / 2;
      py = localY * zoom + oy + zoom / 2;
    }

    if (mode === 'color') {
      const tileLeft = localX * zoom + ox;
      const tileTop = localY * zoom + oy;
      const tileRight = tileLeft + zoom;
      const tileBottom = tileTop + zoom;
      const rotation = secEdgeRotation(wall) ?? 1;
      const edge = (Math.floor(rotation / 2) & 3);
      const inset = Math.min(zoom * 0.15, 2);
      const edges = [
        [tileRight - inset, tileTop + inset, tileRight - inset, tileBottom - inset],
        [tileLeft + inset, tileBottom - inset, tileRight - inset, tileBottom - inset],
        [tileLeft + inset, tileTop + inset, tileLeft + inset, tileBottom - inset],
        [tileLeft + inset, tileTop + inset, tileRight - inset, tileTop + inset]
      ];
      const [x1, y1, x2, y2] = edges[edge];
      ctx.save();
      ctx.lineCap = 'square';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = 'rgba(12, 10, 8, 0.95)';
      ctx.lineWidth = Math.max(3, Math.min(6, zoom * 0.42));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = '#f2d36b';
      ctx.lineWidth = Math.max(1.5, Math.min(3, zoom * 0.22));
      ctx.stroke();
      ctx.restore();
      continue;
    }

    const c = wall.artCanvas;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // The game blits walls/portals opaque. Only the runtime wall-fade around the
    // player (OWAF_TRANS_LEFT/RIGHT, object.c sub_442520) makes them translucent,
    // and a static map viewer has no player, so no alpha is applied here.
    const scale = zoom;
    let drawX = px - (Number(wall.hotspotX)||0) * scale;
    let drawY = py - (Number(wall.hotspotY)||0) * scale;
    let lightRuns = null, lightColour = null, lightResolved = false;
    // Placement: anchor - hotspot (see secWallAnchor), plus the object offset below.
    const edgeRot = secEdgeRotation(wall);
    if (edgeRot !== null && mode === 'art') {
      const rot = edgeRot;
      const mirrored = (rot & 2) !== 0;
      const centre = secIsoProject(localX, localY, iso);
      const anchor = secWallAnchor(rot);
      const end = secWallEdgeLeftEnd(rot);
      const hotX = Number(wall.hotspotX) || 0, hotY = Number(wall.hotspotY) || 0;
      const offX = Number(wall.offsetX) || 0, offY = Number(wall.offsetY) || 0;
      const ux = centre.x + anchor.dx - hotX;
      drawX = px + (anchor.dx - hotX) * scale;
      drawY = py + (anchor.dy - hotY) * scale;
      if (lighting) {
        lightResolved = true;
        if (wall.type === 0) {
          lightRuns = lighting.wallRuns(wall, rot, ux + offX, c.width, centre.x + end.dx + offX, centre.y + end.dy + offY, mirrored ? -0.5 : 0.5);
        } else {
          lightColour = lighting.portalColor(wall, rot, centre.x + offX, centre.y + offY);
        }
      }
    }
    drawX += (Number(wall.offsetX) || 0) * scale;
    drawY += (Number(wall.offsetY) || 0) * scale;
    if (lightRuns) {
      // One tint per run of columns, like the game's per-column colour array.
      for (const run of lightRuns) {
        const src = lighting.sprite(c, run.rgb);
        ctx.drawImage(src, run.x0, 0, run.x1 - run.x0, c.height,
          drawX + run.x0 * scale, drawY, (run.x1 - run.x0) * scale, c.height * scale);
      }
    } else if (lighting && lightColour) {
      ctx.drawImage(lighting.sprite(c, lightColour), drawX, drawY, c.width * scale, c.height * scale);
    } else if (lighting && mode === 'art' && !lightResolved) {
      // No edge geometry (unknown rotation): use the plain outdoor colour.
      ctx.drawImage(lighting.sprite(c, lighting.ambient.outdoor), drawX, drawY, c.width * scale, c.height * scale);
    } else {
      ctx.drawImage(c, drawX, drawY, c.width * scale, c.height * scale);
    }
    ctx.restore();
  }
}

// Inspector text for how a wall is placed (built on demand, not on every frame).
export function secWallPlacementNote(wall) {
  const rot = secEdgeRotation(wall), c = wall.artCanvas;
  if (rot === null || !c) return '';
  const anchor = secWallAnchor(rot);
  return `edge anchor (${anchor.dx},${anchor.dy}) - hotspot ${Number(wall.hotspotX) || 0},${Number(wall.hotspotY) || 0}; offset ${wall.offsetX || 0},${wall.offsetY || 0}; canvas ${c.width}x${c.height}`;
}
