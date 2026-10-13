// Low-detail drawing of the isometric map for when it is zoomed far out.
//
// Zoomed out, a tile is only a few pixels wide, yet the normal renderer still issues one drawImage
// per tile (4096 per sector) and one per object. Here every loaded sector is painted ONCE into a
// miniature (tiles, objects and roofs, exactly as the normal renderer shows them) which is cached
// and then drawn with a single drawImage through the same tile -> isometric transform.

import { SEC_ISO_HALF_H, SEC_ISO_HALF_W, secIsoMetrics } from './sec-iso.js';

// Below this zoom the map is drawn from the miniatures.
export const SEC_LOD_ZOOM = 0.15;
// Scale of a miniature (a 64 x 64 sector is 5160 x 2580 px at 100%), and the margin around it for
// objects and roofs that overhang the sector's diamond (in miniature pixels).
const MINI_SCALE = 0.1;
const PAD_X = 14, PAD_TOP = 44, PAD_BOTTOM = 14;
// A miniature costs about as much as a normal frame of one sector; cap them per frame so a burst
// of newly loaded art cannot stall a frame (the rest follows on the next ones).
const REBUILDS_PER_FRAME = 6;

const SECTOR_ISO = secIsoMetrics({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
const MINI_W = Math.ceil(SECTOR_ISO.width * MINI_SCALE) + 2 * PAD_X;
const MINI_H = Math.ceil(SECTOR_ISO.height * MINI_SCALE) + PAD_TOP + PAD_BOTTOM;

// `paint(ctx, sector, bounds, iso, miniView, w, h)` draws one sector (alone, in a bounds of its
// own) into a miniature; `signature(sector)` changes whenever that picture would. The caller
// supplies both so this file stays free of the object and roof renderers.
// Sets view.lodPending when some miniatures are older than what is now available.
export function drawSecLodSectors(ctx, sectors, bounds, iso, view, zoom, ox, oy, cssW, cssH, paint, signature) {
  const cache = view.lodSectorCache || (view.lodSectorCache = new Map());
  let budget = REBUILDS_PER_FRAME;
  view.lodPending = false;
  const k = zoom / MINI_SCALE;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  for (const sector of sectors) {
    if (!sector?.decoded || !sector.position) continue;
    const baseX = (sector.position.x - bounds.minX) * 64;
    const baseY = (sector.position.y - bounds.minY) * 64;
    // where the miniature's own isometric space sits inside the map's
    const dx = iso.originX + (baseY - baseX) * SEC_ISO_HALF_W - SECTOR_ISO.originX;
    const dy = iso.originY + (baseX + baseY) * SEC_ISO_HALF_H - SECTOR_ISO.originY;
    const left = (dx - PAD_X / MINI_SCALE) * zoom + ox, top = (dy - PAD_TOP / MINI_SCALE) * zoom + oy;
    const w = MINI_W * k, h = MINI_H * k;
    if (left > cssW || top > cssH || left + w < 0 || top + h < 0) continue;
    const sig = signature(sector);
    // A miniature has its own isometric space, so it does not depend on where the sector is:
    // terrain sectors made from the same template share one.
    const cacheKey = sector.terrain ? `terrain:${sector.terrain.template.path}` : sector.filename;
    let entry = cache.get(cacheKey);
    if (!entry || (entry.sig !== sig && budget > 0)) {
      entry = { canvas: buildMiniature(sector, paint), sig };
      cache.set(cacheKey, entry);
      budget--;
    } else if (entry.sig !== sig) {
      view.lodPending = true;
    }
    ctx.drawImage(entry.canvas, left, top, w, h);
  }
  ctx.restore();
}

function buildMiniature(sector, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = MINI_W; canvas.height = MINI_H;
  const mctx = canvas.getContext('2d');
  const { x, y } = sector.position;
  const bounds = { minX: x, maxX: x, minY: y, maxY: y };
  const miniView = { zoom: MINI_SCALE, offsetX: PAD_X, offsetY: PAD_TOP };
  paint(mctx, sector, bounds, secIsoMetrics(bounds), miniView, MINI_W, MINI_H);
  return canvas;
}
