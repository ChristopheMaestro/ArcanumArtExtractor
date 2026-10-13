// Isometric projection constants and helpers.

// game/location.c location_xy(): tile origins are 40 px apart per step in x and
// 20 in y, i.e. an 80x40 cell (the floor art itself is 78 wide, drawn 1 px in,
// see tile.c). The viewer used 78, which stretched every sprite-to-tile
// relationship (a wall slab is exactly 40 px along its edge).
export const SEC_ISO_TILE_W = 80;
export const SEC_ISO_TILE_H = 40;
export const SEC_ISO_HALF_W = SEC_ISO_TILE_W / 2;
export const SEC_ISO_HALF_H = SEC_ISO_TILE_H / 2;

export function secIsoMetrics(bounds) {
  const cols = bounds.maxX - bounds.minX + 1;
  const rows = bounds.maxY - bounds.minY + 1;
  const worldW = cols * 64;
  const worldH = rows * 64;
  // World X increases leftward and world Y increases downward.  The center
  // of tile (0,0) is therefore at the top-right of the isometric diamond.
  const span = (worldW - 1) + (worldH - 1);
  return {
    worldW,
    worldH,
    width: span * (SEC_ISO_TILE_W / 2) + SEC_ISO_TILE_W,
    height: span * (SEC_ISO_TILE_H / 2) + SEC_ISO_TILE_H,
    originX: (worldW - 1) * SEC_ISO_HALF_W + SEC_ISO_HALF_W,
    originY: SEC_ISO_HALF_H
  };
}

export function secIsoProject(localX, localY, metrics) {
  return {
    x: metrics.originX + (localY - localX) * SEC_ISO_HALF_W,
    y: metrics.originY + (localX + localY) * SEC_ISO_HALF_H
  };
}

export function secIsoUnproject(screenX, screenY, metrics) {
  const dx = (screenX - metrics.originX) / SEC_ISO_HALF_W;
  const dy = (screenY - metrics.originY) / SEC_ISO_HALF_H;
  return {
    x: (dy - dx) / 2,
    y: (dy + dx) / 2
  };
}
