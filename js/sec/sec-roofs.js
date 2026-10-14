// SEC roofs: roof-list art ids -> ART files -> isometric drawing.
//
// Everything below follows the Arcanum CE source (game/roof.c, a_name.c,
// sector_roof_list.c, location.c):
//  * A sector holds 256 roof art ids = a 16x16 grid of cells, each cell covering
//    4x4 tiles. Index = (x >> 2) + (y >> 2) * 16 (roof_id_from_tile_id()).
//    An empty cell is TIG_ART_ID_INVALID (0xFFFFFFFF, i.e. not art type 10).
//  * The ART file is art/roof/<name>.art, <name> = roofname.mes entry number
//    tig_art_num_get(aid) (a_name_roof_aid_to_fname) = bits 19-27 of the id.
//  * Besides the number the id holds a piece (0..12, the picture inside the
//    ART file; order = TIG_ART_ROOF_PIECE_* in roof.c) and a mirror flag. (Fill / fade are runtime state, never stored in the sector.)
//  * Placement (roof_xy / roof_get_rect): the roof anchor is tile
//    (x - x % 4 + 2, y - y % 4 + 2). The picture's top-left corner is
//    location_xy(anchor) - (120, 200) - hotspot, where location_xy() is the top
//    left of the tile's 80x40 cell, so from the tile centre: (-160, -220).
//  * Roofs are drawn after the objects (gamelib_draw_game()).
//
// The bit positions come from tig/art.c (not in the source zip), so they were
// read off a real sector; see the id fields below.

import { ART_TYPE, artType } from '../core/art-id.js';
import { parseArtBuffer } from '../art/art-decoder.js';
import { frameCanvasForPalette } from '../art/art-export.js';
import { DATA_ROOT } from '../core/config.js';
import { parseMesNameList } from '../core/mes-parser.js';
import { fetchText, memoAsync } from '../core/text-io.js';
import { encPath } from '../core/util.js';
import { SEC_ISO_HALF_H, SEC_ISO_HALF_W } from './sec-iso.js';

const ROOF_CELLS = 16;
const ROOF_CELL_TILES = 4;
const ROOF_PIECE_COUNT = 13;
const ROOF_NAME_MES_URL = `${DATA_ROOT}art/roof/roofname.mes`;
const ROOF_ART_DIR = `${DATA_ROOT}art/roof/`;
// roof_xy(): location_xy() - (120, 200); location_xy() is the cell's top-left,
// the viewer projects tile centres (half a cell, 40 x 20, further).
const ROOF_OFFSET_X = -120 - SEC_ISO_HALF_W;
const ROOF_OFFSET_Y = -200 - SEC_ISO_HALF_H;

// ---- art id fields ---------------------------------------------------------
// Verified on a real sector (65431142904.sec, 58 roof cells):
//   bits 19-27  roof number (tig_art_num_get) -> roofname.mes
//   bits 14-17  piece 0..12 (the cells form clean 3x3 blocks of pieces)
//   bits 0 and 4 are set together on exactly the second copy of each piece in
//   a block (a 3x3 roof holds pieces 7 2 0 / 2 8 1 / 0 1 4: the opposite corner
//   0 and the edges 2 and 1 appear twice). That is the mirror flag: the cell is
//   the same picture flipped horizontally. (Bit 0 is used; bit 4 always matches.)
export const secRoofNum = raw => (raw >>> 19) & 0x1FF;
export const secRoofPiece = raw => (raw >>> 14) & 0x1F;
export const secRoofMirrored = raw => (raw & 1) !== 0;
export const secRoofLayoutName = () => 'num@19 piece@14 mirror@0';

const roofFileCache = new Map();

export const loadSecRoofNames = memoAsync(async () => parseMesNameList(await fetchText(ROOF_NAME_MES_URL)));

function loadRoofFile(name) {
  const key = name.toLowerCase();
  let p = roofFileCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const resp = await fetch(`${ROOF_ART_DIR}${encPath(name)}.art`);
        if (!resp.ok) return null;
        const frames = await parseArtBuffer(await resp.arrayBuffer());
        return frames.length ? { frames, name } : null;
      } catch (_) { return null; }
    })();
    roofFileCache.set(key, p);
  }
  return p;
}

export function secIsRoofArtId(raw) {
  return artType(raw) === ART_TYPE.ROOF;
}

async function resolveRoof(names, raw) {
  const name = names[secRoofNum(raw)];
  if (!name) return null;
  const file = await loadRoofFile(name);
  if (!file) return null;
  const piece = secRoofPiece(raw);
  if (piece >= ROOF_PIECE_COUNT) return null;
  const frame = file.frames.find(f => f.index === piece && f.direction === 0)
    || file.frames.find(f => f.index === piece) || null;
  const palette = frame && ((frame.palettes && frame.palettes[0]) || frame.palette);
  if (!palette) return null;
  return {
    canvas: frameCanvasForPalette(frame, palette, 0),
    hotspotX: frame.hotspotX || 0, hotspotY: frame.hotspotY || 0,
    filename: file.name + '.art', piece, mirrored: secRoofMirrored(raw)
  };
}

// Loads the art of every distinct roof id of the given sectors into `store`
// (Map raw -> art | {fill:true} | null when unresolved). Returns counts.
export async function loadSecRoofsForSectors(sectors, store) {
  const all = new Set();
  for (const sec of sectors) {
    const ids = sec?.decoded?.roofArtIds;
    if (!ids) continue;
    for (const v of ids) { const raw = v >>> 0; if (secIsRoofArtId(raw)) all.add(raw); }
  }
  if (!all.size) return { requested: 0, missing: 0, layout: null };
  const names = await loadSecRoofNames();
  const need = [...all].filter(raw => !store.has(raw));
  await Promise.all(need.map(async raw => { store.set(raw, await resolveRoof(names, raw)); }));
  let missing = 0;
  for (const raw of all) if (!store.get(raw)) missing++;
  return { requested: all.size, missing, layout: secRoofLayoutName() };
}

// Isometric only. Drawn after every other layer, like roof_draw().
export function drawSecRoofs(ctx, sectors, bounds, iso, view, cssW, cssH) {
  const store = view.roofArt;
  if (!store || !store.size) return;
  const zoom = view.zoom, ox = view.offsetX, oy = view.offsetY;
  for (const sector of sectors) {
    const ids = sector?.decoded?.roofArtIds;
    if (!ids || !sector.position) continue;
    const baseX = (sector.position.x - bounds.minX) * 64;
    const baseY = (sector.position.y - bounds.minY) * 64;
    for (let cy = 0; cy < ROOF_CELLS; cy++) for (let cx = 0; cx < ROOF_CELLS; cx++) {
      const raw = ids[cy * ROOF_CELLS + cx] >>> 0;
      const art = store.get(raw);
      if (!art?.canvas) continue;
      // roof_normalize_loc(): the cell's anchor tile is (4cx + 2, 4cy + 2).
      const tx = baseX + cx * ROOF_CELL_TILES + 2;
      const ty = baseY + cy * ROOF_CELL_TILES + 2;
      const centreX = iso.originX + (ty - tx) * SEC_ISO_HALF_W;
      const centreY = iso.originY + (tx + ty) * SEC_ISO_HALF_H;
      // A mirrored piece is the same picture flipped about the vertical centre line of
      // its 4x4-tile cell, which is the anchor tile's centre (centreX). The pieces are
      // not centred in the cell (hotspot x runs from -1 to about -110), so flipping the
      // picture inside its own rectangle leaves it on the wrong side of the cell, a
      // gap of 2 * |cell centre - picture centre|. Mirror the placement as well.
      let leftX = centreX + ROOF_OFFSET_X - art.hotspotX;
      if (art.mirrored) leftX = 2 * centreX - (leftX + art.canvas.width);
      const left = leftX * zoom + ox;
      const top = (centreY + ROOF_OFFSET_Y - art.hotspotY) * zoom + oy;
      const dw = art.canvas.width * zoom, dh = art.canvas.height * zoom;
      if (left > cssW || top > cssH || left + dw < 0 || top + dh < 0) continue;
      if (art.mirrored) {
        // Flip the picture inside its own rectangle.
        ctx.save();
        ctx.translate(left + dw, top); ctx.scale(-1, 1);
        ctx.drawImage(art.canvas, 0, 0, dw, dh);
        ctx.restore();
      } else {
        ctx.drawImage(art.canvas, left, top, dw, dh);
      }
    }
  }
}
